// doubao_web_search：豆包搜索 Custom 版（火山引擎联网搜索）的 pi 工具扩展。
//
// 端点：POST https://open.feedcoopapi.com/search_api/web_search（可用 doubao-search.json 的 apiUrl 覆盖）
// 密钥：只读环境变量 DOUBAO_SEARCH_API_KEY（不落配置文件；配置文件只放非敏感项）
// 关键取舍见 search.ts 顶部注释：用户手上的「订阅套餐」Key 只能打 Custom 版，打 Global 版是 10409。
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

import { API_KEY_ENV, apiKeyFrom, loadConfig } from "./config.ts";
import { type SearchDetails, formatSearchOutput, renderCallText, renderResultText } from "./format.ts";
import {
	DoubaoSearchError,
	MAX_BLOCK_HOSTS,
	MAX_SITES,
	type SearchRequest,
	buildRequestBody,
	callSearchApi,
	parseResponse,
} from "./search.ts";
import { capModelText, withNotice } from "./text.ts";

const PROGRESS_PREFIX = "🔎";

const Parameters = Type.Object({
	query: Type.String({
		description:
			"搜索词，1~100 字符（超长会被截断）。不支持多词搜索：把意图写成一句话或几个关键词组合，例如「北京周边游玩景点推荐」。",
	}),
	searchType: Type.Optional(
		Type.Union([Type.Literal("web"), Type.Literal("image")], {
			description: "web=搜网页（默认）；image=搜图片（最多 5 条，返回图片直链）。",
		}),
	),
	count: Type.Optional(Type.Number({ description: "返回条数：web 1~50（默认 10），image 1~5（默认 5）。" })),
	timeRange: Type.Optional(
		Type.String({
			description: "仅 web：发文时间范围，OneDay / OneWeek / OneMonth / OneYear，或日期区间 2025-01-01..2025-12-31。",
		}),
	),
	sites: Type.Optional(
		Type.Array(Type.String(), {
			description: `仅 web：只在指定站点内搜索（完整域名，最多 ${MAX_SITES} 个），例 ["gov.cn","chinatax.gov.cn"]。`,
		}),
	),
	blockHosts: Type.Optional(
		Type.Array(Type.String(), { description: `仅 web：屏蔽指定站点（完整域名，最多 ${MAX_BLOCK_HOSTS} 个），例 ["zhihu.com"]。` }),
	),
	authInfoLevel: Type.Optional(
		Type.Union([Type.Literal(0), Type.Literal(1)], {
			description: "仅 web：1=只在「非常权威」内容里搜（政策、医疗、金融建议开），0=不限制（默认）。",
		}),
	),
	industry: Type.Optional(
		Type.Union([Type.Literal("finance"), Type.Literal("game"), Type.Literal("health"), Type.Literal("gov")], {
			description: "仅 web：行业搜索（结果会变窄并过滤火山如意卡片）。",
		}),
	),
	queryRewrite: Type.Optional(Type.Boolean({ description: "开启 Query 改写：口语化问题更准，但耗时增加。" })),
	needUrl: Type.Optional(Type.Boolean({ description: "仅 web：只返回带原文链接的结果（会滤掉火山如意卡片）。" })),
	needContent: Type.Optional(Type.Boolean({ description: "仅 web：只返回有正文的结果。" })),
	contentFormat: Type.Optional(
		Type.Union([Type.Literal("text"), Type.Literal("markdown")], { description: "正文格式，默认 text。" }),
	),
	includeContent: Type.Optional(
		Type.Boolean({
			description:
				"是否把整篇正文（Content）也交给模型。默认 false：只给 500~1000 字摘要（Summary，官方推荐给大模型用），省 token。",
		}),
	),
	imageWidthMin: Type.Optional(Type.Number({ description: "仅 image：图片最小宽度（像素）。" })),
	imageWidthMax: Type.Optional(Type.Number({ description: "仅 image：图片最大宽度（像素）。" })),
	imageHeightMin: Type.Optional(Type.Number({ description: "仅 image：图片最小高度（像素）。" })),
	imageHeightMax: Type.Optional(Type.Number({ description: "仅 image：图片最大高度（像素）。" })),
	imageShapes: Type.Optional(
		Type.Array(Type.String(), { description: "仅 image：允许的图片形状，取值 横长方形 / 竖长方形 / 方形。" }),
	),
});

interface Params extends SearchRequest {
	/** 扩展层参数：是否把正文（Content）也交给模型，不发给上游 */
	includeContent?: boolean;
}

export default function doubaoSearchExtension(pi: ExtensionAPI) {
	let lastWarningKey = "";

	pi.registerTool({
		name: "doubao_web_search",
		label: "Doubao Web Search",
		description: [
			"用豆包搜索（火山引擎联网搜索 Custom 版）检索中文网页或图片，返回标题、站点、权威度、发布时间与摘要。",
			"支持时间范围（timeRange）、限定/屏蔽站点（sites/blockHosts）、只看权威来源（authInfoLevel=1）、行业搜索（industry）、Query 改写（queryRewrite）。",
			"默认只给 500~1000 字摘要（Summary）；需要整篇正文时传 includeContent=true。",
			"要读某个已知 URL 的全文请用 fetch_content；要搜英文/全球信息可用 web_search。",
		].join(" "),
		promptSnippet: "doubao_web_search: 用豆包搜索查中文网页/图片（支持时间范围、限定站点、权威度过滤）",
		promptGuidelines: [
			"查中文实时信息、政策法规、国内新闻/攻略/评测时优先用 doubao_web_search；它比通用搜索更懂中文站点。",
			"政策、医疗、金融类查询建议带 authInfoLevel=1，配合 sites 限定官方站点（如 gov.cn）。",
			"只想要最近的内容时带 timeRange（OneDay/OneWeek/OneMonth/OneYear）；想拿整篇正文时带 includeContent=true。",
		],
		parameters: Parameters,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const raw = params as Params;
			const { config, warnings: configWarnings } = loadConfig();

			const apiKey = apiKeyFrom();
			if (!apiKey) {
				throw new Error(
					`缺少环境变量 ${API_KEY_ENV}，doubao_web_search 无法调用豆包搜索。\n` +
						`配置方式（Windows，配完重开终端/pi）：setx ${API_KEY_ENV} "<你的火山引擎豆包搜索 API Key>"\n` +
						`Key 取自火山控制台 → 联网搜索 → API Key 管理（订阅套餐页签）。`,
				);
			}

			const built = buildRequestBody(raw, {
				count: config.count,
				contentFormat: raw.contentFormat ?? config.contentFormat,
			});
			const warnings = [...configWarnings, ...built.warnings];

			if (warnings.length > 0 && lastWarningKey !== warnings.join("|")) {
				lastWarningKey = warnings.join("|");
				ctx.ui?.notify(`doubao_web_search 有降级/忽略项：${warnings.join("；")}`, "warning");
			}

			const details: SearchDetails = {
				status: "searching",
				query: String(built.body.Query),
				searchType: built.searchType,
				requestedCount: built.count,
				warnings,
			};

			const emit = (progress: string) => {
				details.progress = progress;
				onUpdate?.({ content: [{ type: "text", text: progress }], details: { ...details } });
			};

			const modeBits = [`${built.searchType}`, `${built.count} 条`];
			if (raw.timeRange) modeBits.push(String(raw.timeRange));
			if (raw.sites?.length) modeBits.push(`仅 ${raw.sites.join("/")}`);
			if (raw.authInfoLevel === 1) modeBits.push("仅非常权威");
			if (raw.industry) modeBits.push(String(raw.industry));
			emit(`${PROGRESS_PREFIX} 搜索中：${details.query}（${modeBits.join(" · ")}）`);

			const startedAt = Date.now();
			let parsed;
			try {
				const rawResponse = await callSearchApi({
					apiKey,
					apiUrl: config.apiUrl,
					body: built.body,
					timeoutMs: config.timeoutSec * 1000,
					signal,
				});
				parsed = parseResponse(rawResponse);
			} catch (error) {
				if (error instanceof DoubaoSearchError) {
					const lines = [error.message];
					if (error.hint) lines.push(`提示：${error.hint}`);
					if (error.requestId) lines.push(`RequestId：${error.requestId}`);
					throw new Error(lines.join("\n"));
				}
				throw error;
			}
			const elapsedMs = Date.now() - startedAt;

			const includeContent = raw.includeContent ?? config.includeContent;
			const footer = [
				"",
				"---",
				`[doubao_web_search] ${config.apiUrl} · SearchType=${built.searchType} · Count=${built.count} · 返回 ${parsed.docs.length} 条` +
					(parsed.timeCostMs !== undefined ? ` · TimeCost ${parsed.timeCostMs}ms` : "") +
					` · 端到端 ${elapsedMs}ms`,
			];
			if (parsed.requestId) footer.push(`RequestId ${parsed.requestId}${parsed.logId ? ` · LogId ${parsed.logId}` : ""}`);
			if (warnings.length > 0) footer.push(`⚠ 提示：${warnings.join("；")}`);
			if (!includeContent) footer.push("（本次只给摘要；需要整篇正文时传 includeContent=true 重搜，或按 URL 用 fetch_content 取全文）");

			let text = `${formatSearchOutput(parsed, { includeContent })}\n${footer.join("\n")}`;
			const capped = capModelText(text, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES, formatSize });
			if (capped.truncated) {
				const dir = await mkdtemp(join(tmpdir(), "pi-doubao-search-"));
				const fullPath = join(dir, "doubao_web_search.txt");
				await withFileMutationQueue(fullPath, async () => {
					await writeFile(fullPath, text, "utf8");
				});
				text = withNotice(capped, fullPath);
				details.truncated = true;
				details.fullOutputPath = fullPath;
			}

			details.status = "done";
			details.progress = undefined;
			details.returnedCount = parsed.docs.length;
			details.resultCount = parsed.resultCount;
			details.timeCostMs = parsed.timeCostMs;
			details.elapsedMs = elapsedMs;
			details.requestId = parsed.requestId;
			details.logId = parsed.logId;

			return {
				content: [{ type: "text", text }],
				details: { ...details },
			};
		},

		renderCall(args, theme) {
			return new Text(renderCallText(args as Params, theme), 0, 0);
		},

		renderResult(result, options, theme) {
			return new Text(
				renderResultText(
					result as { content?: { type: string; text?: string }[] },
					options as { expanded?: boolean; isPartial?: boolean },
					result.details as SearchDetails | undefined,
					theme,
				),
				0,
				0,
			);
		},
	});
}
