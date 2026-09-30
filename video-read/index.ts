// video_read：用 qwen3.8-omni-flash 读视频（画面 + 声音），返回文本结果
//
// 链路（2026-09-28 实测通过）：
//   本地 ≤7.5MB  → base64 data URI 内联（省一次上传；实测 1.1MB/8.2s 视频 11 秒读完）
//   本地 >7.5MB  → 官方临时上传拿 oss:// URL（实测 7–9 MB/s，48h 有效，走缓存避免重传）
//   http(s) / oss:// → 直接透传给模型自己去取
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

import { type Detail, loadConfig, resolveRequestOptions } from "./config.ts";
import {
	UPLOAD_MAX_BYTES,
	buildDataUri,
	chooseTransport,
	formatBytes,
	isRemoteSource,
	normalizeSources,
	probeMedia,
	resolveLocalPath,
	statLocalFile,
	validateDuration,
} from "./media.ts";
import { type ReasoningEffort, REASONING_EFFORTS, clampFps, formatCost, streamChat, toPiUsage } from "./qwen-omni.ts";
import { type RenderDetails, type RenderSource, describeSource, renderCallText, renderResultText } from "./render.ts";
import { capModelText, withNotice } from "./text.ts";
import { uploadWithCache } from "./uploads.ts";

const SCHEME_RE = /^(https?|oss|data):/i;
const PROGRESS_THROTTLE_MS = 400;

const Parameters = Type.Object({
	source: Type.Union([Type.String(), Type.Array(Type.String())], {
		description:
			"视频来源：本地文件路径（相对当前工作目录）、http(s) 公网 URL、或 oss:// 临时 URL。可传数组一次读多个视频（单请求最多 64 个）。",
	}),
	prompt: Type.Optional(
		Type.String({
			description: "具体想看什么/问什么。不填则按 detail 档位自带的结构化报告提问（时间线 + 画面文字 + 说话人转写）。",
		}),
	),
	detail: Type.Optional(
		Type.Union([Type.Literal("quick"), Type.Literal("standard"), Type.Literal("fine")], {
			description:
				"分析档位，决定抽帧率与单帧像素上限：quick=长视频粗看（0.5fps/230K 像素），standard=常规（1fps/921K），fine=细看短片（2fps/2M）。默认 standard。",
		}),
	),
	fps: Type.Optional(Type.Number({ description: "抽帧率，模型允许 0.1–10。不填按档位预设。" })),
	maxPixels: Type.Optional(Type.Number({ description: "单帧像素上限（4096–2048000）。不填按档位预设。" })),
	maxTokens: Type.Optional(Type.Number({ description: "输出 token 上限，默认 8000。长视频的逐句转写可能要调大。" })),
	reasoningEffort: Type.Optional(
		Type.Union(REASONING_EFFORTS.map((effort) => Type.Literal(effort)), {
			description:
				"思考档位。默认 low（模型自身默认 xhigh，实测一句话回答会花 1006 思考 token / 17 秒）。none 最快但会丢细节。",
		}),
	),
});

interface Params {
	source: string | string[];
	prompt?: string;
	detail?: Detail;
	fps?: number;
	maxPixels?: number;
	maxTokens?: number;
	reasoningEffort?: ReasoningEffort;
}

interface VideoReadDetails extends RenderDetails {
	status: "preparing" | "uploading" | "analyzing" | "done";
	sources: RenderSource[];
	usage?: ReturnType<typeof toPiUsage>;
}

export default function videoReadExtension(pi: ExtensionAPI) {
	let lastWarningKey = "";

	pi.registerTool({
		name: "video_read",
		label: "Video Read",
		description: [
			"读取视频/短片的内容并返回文本：既有画面理解，也能听到声音（口播转写、语气），由 qwen3.8-omni-flash 完成。",
			"支持本地文件（自动选择 base64 内联或官方临时上传，本地文件 ≤1GB）、http(s) 公网视频 URL、oss:// 临时 URL。",
			"默认产出结构化报告（时间线 / 画面文字 / 说话人转写）；用 prompt 可以问具体问题（例如「第 30 秒出现了什么品牌」）。",
			"限制：视频时长 2 秒–2 小时；一次最多 64 个视频。",
		].join(" "),
		promptSnippet: "video_read: 看本地或网络视频的内容（含声音与口播），返回文本",
		promptGuidelines: [
			"要了解视频里发生了什么（尤其是口播内容）时用 video_read，不要用 read 工具读 mp4（读不出内容）。",
			"一次问多个视频时把路径放进 source 数组，比连续多次调用更省 token。",
		],
		parameters: Parameters,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const raw = params as Params;
			const sources = normalizeSources(raw.source);
			const { config, warnings } = loadConfig();
			const request = resolveRequestOptions(config, {
				detail: raw.detail,
				fps: raw.fps,
				maxPixels: raw.maxPixels,
				prompt: raw.prompt,
			});
			const reasoningEffort = raw.reasoningEffort ?? config.reasoningEffort;
			const maxTokens = raw.maxTokens ?? config.maxTokens;
			const fps = clampFps(request.fps);

			if (sources.length > config.maxVideosPerCall) {
				throw new Error(`一次最多读 ${config.maxVideosPerCall} 个视频（模型限制），当前给了 ${sources.length} 个。`);
			}

			const apiKey = process.env.DASHSCOPE_API_KEY?.trim();
			if (!apiKey) {
				throw new Error(
					"缺少环境变量 DASHSCOPE_API_KEY，video_read 无法调用百炼。请先配置百炼 API Key（须与上传文件同一主账号）。",
				);
			}

			const details: VideoReadDetails = {
				status: "preparing",
				model: config.model,
				detail: request.detail,
				fps,
				maxPixels: request.maxPixels,
				reasoningEffort,
				sources: [],
				warnings,
			};

			if (warnings.length > 0 && lastWarningKey !== warnings.join("|")) {
				lastWarningKey = warnings.join("|");
				ctx.ui?.notify(`video_read 配置有降级项：${warnings.join("；")}`, "warning");
			}

			const emit = (progress: string, status: VideoReadDetails["status"]) => {
				details.status = status;
				details.progress = progress;
				onUpdate?.({ content: [{ type: "text", text: progress }], details: { ...details } });
			};

			emit(`⏳ 准备中：${sources.length} 个视频`, "preparing");

			// 1) 逐个解析来源：本地文件校验大小/时长/格式，远程直接透传
			const inputs: string[] = [];
			for (const source of sources) {
				if (isRemoteSource(source)) {
					if (!SCHEME_RE.test(source)) throw new Error(`不支持的来源：${source}`);
					inputs.push(source);
					details.sources.push({ input: source, kind: "remote", transport: "url" });
					continue;
				}

				const path = resolveLocalPath(source, ctx.cwd);
				const stat = statLocalFile(path); // 抛错信息里带可用格式
				const info = await probeMedia(path);
				const durationError = validateDuration(info?.durationSec);
				if (durationError) throw new Error(`${source}：${durationError}`);

				const report: RenderSource = {
					input: source,
					kind: "local",
					bytes: stat.bytes,
					durationSec: info?.durationSec,
					resolution: info?.width && info?.height ? `${info.width}×${info.height}` : undefined,
				};

				if (chooseTransport(stat.bytes) === "base64") {
					inputs.push(buildDataUri(path));
					report.transport = "base64";
				} else {
					if (stat.bytes > UPLOAD_MAX_BYTES) {
						throw new Error(
							`${source} 为 ${formatBytes(stat.bytes)}，超过官方临时上传接口 1GB 上限。请先压缩/切分，或改用自有 OSS 公网 URL。`,
						);
					}
					emit(`⬆️ 上传中：${source}（${formatBytes(stat.bytes)}）`, "uploading");
					const uploaded = await uploadWithCache({
						apiKey,
						model: config.model,
						path,
						bytes: stat.bytes,
						mtimeMs: stat.mtimeMs,
						cacheFile: config.cacheFile,
						signal,
					});
					inputs.push(uploaded.url);
					report.transport = "upload";
					report.cached = uploaded.cached;
				}
				details.sources.push(report);
			}

			// 2) 流式调用：进度按 400ms 节流，避免刷屏
			emit(`🧠 分析中：${sources.length} 个视频 · ${request.detail} · fps ${fps} · effort ${reasoningEffort}`, "analyzing");
			let lastEmit = 0;
			const result = await streamChat({
				apiKey,
				baseUrl: config.baseUrl,
				model: config.model,
				inputs,
				prompt: request.prompt,
				fps,
				maxPixels: request.maxPixels,
				reasoningEffort,
				maxTokens,
				timeoutMs: config.timeoutSec * 1000,
				signal,
				onEvent: (state, elapsedMs) => {
					const now = Date.now();
					if (now - lastEmit < PROGRESS_THROTTLE_MS) return;
					lastEmit = now;
					const parts = [`⏱ ${(elapsedMs / 1000).toFixed(1)}s`];
					if (state.deltaCount === 0) parts.push("等待首包");
					if (state.reasoning) parts.push(`🧠 思考 ${state.reasoning.length} 字`);
					if (state.content) parts.push(`✍️ 输出 ${state.content.length} 字`);
					emit(`🧠 分析中 · ${parts.join(" · ")}`, "analyzing");
				},
			});

			// 3) 组装给模型看的内容：正文 + 一行实况元信息（用量/成本/截断告警）
			const usageText =
				`in ${result.usage.promptTokens} (video ${result.usage.videoTokens} / audio ${result.usage.audioTokens} / cached ${result.usage.cachedTokens})` +
				` | out ${result.usage.completionTokens} (reasoning ${result.usage.reasoningTokens})` +
				` | total ${result.usage.totalTokens}`;
			const sourceText = details.sources.map(describeSource).join(" + ");
			const costText = formatCost(result.cost);
			const footer = [
				"",
				"---",
				`[video_read] ${result.model} · detail=${request.detail} · fps=${fps} · max_pixels=${request.maxPixels} · reasoning=${reasoningEffort}`,
				`source: ${sourceText}`,
				`usage: ${usageText} | ${costText} | ${(result.elapsedMs / 1000).toFixed(1)}s`,
			];
			if (result.finishReason === "length") {
				footer.push(
					`⚠ 输出触及 max_tokens=${maxTokens} 被截断，转写可能不完整：调大 maxTokens 或缩小问题范围后重试。`,
				);
			}
			if (warnings.length > 0) footer.push(`⚠ 配置降级：${warnings.join("；")}`);

			let text = `${result.content || "（模型没有返回内容）"}\n${footer.join("\n")}`;
			const capped = capModelText(text, {
				maxLines: DEFAULT_MAX_LINES,
				maxBytes: DEFAULT_MAX_BYTES,
				formatSize,
			});
			if (capped.truncated) {
				const dir = await mkdtemp(join(tmpdir(), "pi-video-read-"));
				const fullPath = join(dir, "video_read.txt");
				await withFileMutationQueue(fullPath, async () => {
					await writeFile(fullPath, text, "utf8");
				});
				text = withNotice(capped, fullPath);
				details.truncated = true;
				details.fullOutputPath = fullPath;
			}

			const piUsage = toPiUsage(result.usage);
			details.status = "done";
			details.progress = undefined;
			details.elapsedMs = result.elapsedMs;
			details.usage = piUsage;
			details.usageText = usageText;
			details.costText = costText;
			details.finishReason = result.finishReason;

			return {
				content: [{ type: "text", text }],
				details: { ...details },
				usage: piUsage,
			};
		},

		renderCall(args, theme) {
			return new Text(renderCallText(args as Params, theme), 0, 0);
		},

		renderResult(result, options, theme) {
			return new Text(
				renderResultText(result as { content?: { type: string; text?: string }[] }, options, result.details as VideoReadDetails | undefined, theme),
				0,
				0,
			);
		},
	});
}
