// 配置：默认值 + 可选配置文件 ~/.pi/agent/video-read.json（或 PI_CODING_AGENT_DIR 指定的目录）
//
// 设计取舍：
//   - 密钥只从环境变量 DASHSCOPE_API_KEY 读，配置文件里不放密钥
//   - 非法值一律降级到默认并给出告警，不静默吞掉（免得用户以为改了其实没生效）
//   - 默认档位：reasoning_effort=low（模型默认 xhigh，实测一句话回答就烧 1006 思考 token / 17 秒）
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { type ReasoningEffort, REASONING_EFFORTS } from "./qwen-omni.ts";
import { defaultCacheFile } from "./uploads.ts";

export type Detail = "quick" | "standard" | "fine";

export const SHORT_PROMPT =
	"用 3-6 句话概括这条视频：画面里发生了什么、有谁在讲话以及讲了什么要点、画面上的文字或字幕说明了什么。" +
	"不要逐帧罗列，也不要罗列时间戳，只要结论。";

export const STRUCTURED_PROMPT = [
	"请完整解读这条视频，按下面三节输出 Markdown，不要省略任何一节：",
	"",
	"## Storyline",
	"按时间顺序逐段描述画面与声音里所有值得注意的细节（人物、场景、动作、镜头、字幕包装、语音内容、音效或背景音乐），每段标注起止时间。",
	"",
	"## Visible Text",
	"列出画面中出现的所有文字（标题、字幕、贴纸、水印），每条给出起止时间与文字内容；没有就明确说明。",
	"",
	"## Speakers and Transcript",
	"说话人档案 + 逐句转写：说话人、语气或情绪、起止时间、逐字内容；没有语音就明确说明。",
].join("\n");

const FINE_EXTRA = [
	"",
	"另外要求：时间戳精确到 0.1 秒；标注每一次镜头切换；描述说话人的语速、情绪与口音；画面文字要说明出现位置。",
].join("\n");

/** 档位预设的像素/抽帧取值来自百炼文档的推荐表（快速审核 / 标准分析 / 精细分析）。
 * 注：文档推荐表里「精细分析」写 2,073,600，但视频帧 max_pixels 的**硬上限是 2,048,000**
 * （实测超限直接 400：Parameter max_pixels must be smaller than or equal to 2048000），
 * 所以 fine 取上限值。 */
export const DETAIL_PRESETS: Record<Detail, { fps: number; maxPixels: number; prompt: string }> = {
	quick: { fps: 0.5, maxPixels: 230400, prompt: SHORT_PROMPT },
	standard: { fps: 1, maxPixels: 921600, prompt: STRUCTURED_PROMPT },
	fine: { fps: 2, maxPixels: 2048000, prompt: STRUCTURED_PROMPT + FINE_EXTRA },
};

/** 视频帧 max_pixels 的合法区间（文档 + 实测报错信息） */
export const MAX_PIXELS_RANGE = { min: 4096, max: 2048000 } as const;

export function presetFor(detail: Detail) {
	return DETAIL_PRESETS[detail];
}

export interface VideoReadConfig {
	model: string;
	baseUrl: string;
	reasoningEffort: ReasoningEffort;
	detail: Detail;
	/** 覆盖档位预设的抽帧率；undefined 表示用档位预设 */
	fps?: number;
	/** 覆盖档位预设的单帧像素上限 */
	maxPixels?: number;
	maxTokens: number;
	timeoutSec: number;
	maxVideosPerCall: number;
	cacheFile: string;
}

export interface NormalizeContext {
	agentDir: string;
	env: NodeJS.ProcessEnv;
}

export function agentDir(env: NodeJS.ProcessEnv = process.env): string {
	const override = env.PI_CODING_AGENT_DIR?.trim();
	return override && override.length > 0 ? override : join(homedir(), ".pi", "agent");
}

export const DEFAULT_CONFIG: VideoReadConfig = {
	model: "qwen3.8-omni-flash",
	baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
	reasoningEffort: "low",
	detail: "standard",
	maxTokens: 8000,
	timeoutSec: 900,
	maxVideosPerCall: 64, // 文档：单请求最多 64 个视频
	cacheFile: defaultCacheFile(agentDir()),
};

const MAX_MODEL_OUTPUT_TOKENS = 131072; // 文档：qwen3.8-omni-flash 输出上限
const MIN_TIMEOUT_SEC = 30;
const MAX_TIMEOUT_SEC = 7200;

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asIntInRange(value: unknown, min: number, max: number): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
	const int = Math.round(value);
	return int >= min && int <= max ? int : undefined;
}

export function normalizeConfig(raw: unknown, ctx: NormalizeContext): { config: VideoReadConfig; warnings: string[] } {
	const warnings: string[] = [];
	const source = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
	const config: VideoReadConfig = { ...DEFAULT_CONFIG, cacheFile: defaultCacheFile(ctx.agentDir) };

	const model = asString(source.model);
	if (model) config.model = model;
	else if (source.model !== undefined) warnings.push(`model 不是非空字符串，已用默认值 ${config.model}`);

	const envBaseUrl = asString(ctx.env.DASHSCOPE_BASE_URL)?.replace(/\/+$/, "");
	const baseUrl = asString(source.baseUrl) ?? envBaseUrl;
	if (baseUrl && /^https?:\/\//i.test(baseUrl)) config.baseUrl = baseUrl.replace(/\/+$/, "");
	else if (source.baseUrl !== undefined) warnings.push(`baseUrl 不是 http(s) 地址，已用默认值 ${config.baseUrl}`);

	const effort = asString(source.reasoningEffort) as ReasoningEffort | undefined;
	if (effort && REASONING_EFFORTS.includes(effort)) config.reasoningEffort = effort;
	else if (source.reasoningEffort !== undefined) {
		warnings.push(`reasoningEffort=${source.reasoningEffort} 不在 ${REASONING_EFFORTS.join("/")} 内，已用默认值 ${config.reasoningEffort}`);
	}

	const detail = asString(source.detail) as Detail | undefined;
	if (detail && detail in DETAIL_PRESETS) config.detail = detail;
	else if (source.detail !== undefined) {
		warnings.push(`detail=${source.detail} 不是 ${Object.keys(DETAIL_PRESETS).join("/")} 之一，已用默认值 ${config.detail}`);
	}

	const fps = source.fps;
	if (fps !== undefined) {
		if (typeof fps === "number" && Number.isFinite(fps) && fps >= 0.1 && fps <= 10) config.fps = fps;
		else warnings.push(`fps=${String(fps)} 超出模型允许的 [0.1, 10]，已改用档位预设 ${presetFor(config.detail).fps}`);
	}

	const maxPixels = source.maxPixels;
	if (maxPixels !== undefined) {
		const value = asIntInRange(maxPixels, MAX_PIXELS_RANGE.min, MAX_PIXELS_RANGE.max);
		if (value !== undefined) config.maxPixels = value;
		else
			warnings.push(
				`maxPixels=${String(maxPixels)} 超出 [${MAX_PIXELS_RANGE.min}, ${MAX_PIXELS_RANGE.max}]，已改用档位预设 ${presetFor(config.detail).maxPixels}`,
			);
	}

	const maxTokens = source.maxTokens;
	if (maxTokens !== undefined) {
		const value = asIntInRange(maxTokens, 1, MAX_MODEL_OUTPUT_TOKENS);
		if (value !== undefined) config.maxTokens = value;
		else warnings.push(`maxTokens=${String(maxTokens)} 超出 [1, ${MAX_MODEL_OUTPUT_TOKENS}]，已用默认值 ${config.maxTokens}`);
	}

	const timeoutSec = source.timeoutSec;
	if (timeoutSec !== undefined) {
		const value = asIntInRange(timeoutSec, MIN_TIMEOUT_SEC, MAX_TIMEOUT_SEC);
		if (value !== undefined) config.timeoutSec = value;
		else warnings.push(`timeoutSec=${String(timeoutSec)} 超出 [${MIN_TIMEOUT_SEC}, ${MAX_TIMEOUT_SEC}]，已用默认值 ${config.timeoutSec}`);
	}

	const maxVideos = source.maxVideos ?? source.maxVideosPerCall;
	if (maxVideos !== undefined) {
		const value = asIntInRange(maxVideos, 1, 64);
		if (value !== undefined) config.maxVideosPerCall = value;
		else warnings.push(`maxVideos=${String(maxVideos)} 超出 [1, 64]，已用默认值 ${config.maxVideosPerCall}`);
	}

	const cacheFile = asString(source.cacheFile);
	if (cacheFile) config.cacheFile = cacheFile;
	else if (source.cacheFile !== undefined) warnings.push("cacheFile 不是非空路径，已用默认位置");

	return { config, warnings };
}

export function configFilePath(ctx: NormalizeContext): string {
	return join(ctx.agentDir, "video-read.json");
}

export function loadConfig(ctx?: Partial<NormalizeContext>): { config: VideoReadConfig; warnings: string[] } {
	const env = ctx?.env ?? process.env;
	const resolvedCtx: NormalizeContext = { agentDir: ctx?.agentDir ?? agentDir(env), env };
	const file = configFilePath(resolvedCtx);
	if (!existsSync(file)) return normalizeConfig({}, resolvedCtx);
	try {
		const raw = JSON.parse(readFileSync(file, "utf8"));
		return normalizeConfig(raw, resolvedCtx);
	} catch (error: any) {
		return {
			...normalizeConfig({}, resolvedCtx),
			warnings: [`配置文件 ${file} 解析失败，已忽略：${error?.message ?? String(error)}`],
		};
	}
}

/** 合并「档位预设 + 参数覆盖」，得到本次请求实际要用的 fps / maxPixels / prompt */
export function resolveRequestOptions(
	config: VideoReadConfig,
	params: { detail?: Detail; fps?: number; maxPixels?: number; prompt?: string },
): { fps: number; maxPixels: number; prompt: string; detail: Detail } {
	const detail = params.detail && params.detail in DETAIL_PRESETS ? params.detail : config.detail;
	const preset = presetFor(detail);
	return {
		detail,
		fps: params.fps ?? config.fps ?? preset.fps,
		maxPixels: params.maxPixels ?? config.maxPixels ?? preset.maxPixels,
		prompt: params.prompt?.trim() ? params.prompt.trim() : preset.prompt,
	};
}
