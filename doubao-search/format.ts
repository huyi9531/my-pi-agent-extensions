// 输出呈现层：给模型看的文本 + TUI 概览行（纯函数，可离线测试）。
//
// 取数取舍：官方明确 Snippet（≈200 字）「仅建议用于列表展示，强烈不建议用于大模型场景」，
// Summary（500~1000 字）才是给大模型用的，所以默认给 Summary；Content 全文按 includeContent 开关。
import type { SearchResponse, SearchType } from "./search.ts";

export const DEFAULT_MAX_SUMMARY_CHARS = 1200;

export interface FormatOptions {
	/** 把整篇正文（Content）也交给模型；默认 false 只给 Summary */
	includeContent?: boolean;
	/** 单条摘要/正文的最大字符数，超出截断加省略号 */
	maxSummaryChars?: number;
}

/** 只用到 pi 主题的这两个方法，便于测试替身 */
export interface ThemeLike {
	fg(color: string, text: string): string;
	bold(text: string): string;
}

export interface SearchDetails {
	status: "searching" | "done";
	progress?: string;
	query: string;
	searchType: SearchType;
	/** 本次请求的条数（夹紧后） */
	requestedCount: number;
	/** 上游实际返回的条数 */
	returnedCount?: number;
	resultCount?: number;
	timeCostMs?: number;
	elapsedMs?: number;
	truncated?: boolean;
	fullOutputPath?: string;
	warnings: string[];
	requestId?: string;
	logId?: string;
}

function oneLine(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function clamp(text: string, limit: number): string {
	const flat = oneLine(text);
	return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

function shortDate(publishTime: string | undefined): string | undefined {
	if (!publishTime) return undefined;
	const match = /^(\d{4}-\d{2}-\d{2})/.exec(publishTime.trim());
	return match ? match[1] : publishTime.trim();
}

function metaBits(bits: (string | undefined)[]): string {
	return bits.filter((bit): bit is string => Boolean(bit)).join(" | ");
}

export function formatSearchOutput(response: SearchResponse, options: FormatOptions = {}): string {
	const limit = options.maxSummaryChars ?? DEFAULT_MAX_SUMMARY_CHARS;
	const header = [
		`[豆包搜索·${response.searchType}]`,
		`「${response.originQuery ?? ""}」`,
		`${response.docs.length} 条结果`,
	];
	if (response.timeCostMs !== undefined) header.push(`TimeCost ${response.timeCostMs}ms`);
	if (response.resultCount !== response.docs.length) header.push(`上游标注 ${response.resultCount} 条`);

	const lines: string[] = [header.join(" · ")];
	if (response.docs.length === 0) {
		lines.push("（没有可展示的结果，可换个说法、放宽筛选条件或调大 Count 重试）");
		return lines.join("\n");
	}

	response.docs.forEach((doc, index) => {
		const label = `${index + 1}. `;
		if (doc.kind === "web") {
			const title = doc.title ? oneLine(doc.title) : "(无标题)";
			const tags = [doc.siteName, doc.authInfoDes, shortDate(doc.publishTime)];
			if (doc.ruyiType) tags.push(`如意卡片·${doc.ruyiType}`);
			lines.push(`${label}${title}${tags.filter(Boolean).length ? ` | ${metaBits(tags)}` : ""}`);
			if (doc.url) lines.push(`   ${doc.url}`);
			const body = options.includeContent ? doc.content : (doc.summary ?? doc.snippet);
			if (body) lines.push(`   ${clamp(body, limit)}`);
			else if (doc.snippet) lines.push(`   ${clamp(doc.snippet, limit)}`);
			if (options.includeContent && doc.inlineImages.length > 0) {
				const images = doc.inlineImages
					.slice(0, 5)
					.map((image) => image.url)
					.filter(Boolean);
				if (images.length > 0) lines.push(`   插图: ${images.join(" , ")}`);
			}
			if (options.includeContent && doc.author) lines.push(`   作者: ${doc.author}`);
		} else {
			const title = doc.title ? oneLine(doc.title) : "(无标题图片)";
			const size = doc.width && doc.height ? `${doc.width}×${doc.height}` : undefined;
			const shape = [doc.shape, size].filter(Boolean).join(" ");
			const quality = [doc.blurDes, doc.watermark === "1" ? "有水印" : undefined].filter(Boolean).join(" · ");
			lines.push(`${label}${title}${metaBits([doc.siteName, shape, quality]) ? ` | ${metaBits([doc.siteName, shape, quality])}` : ""}`);
			if (doc.imageUrl) lines.push(`   图片: ${doc.imageUrl}`);
			if (doc.url) lines.push(`   落地页: ${doc.url}`);
			if (doc.description) lines.push(`   内容: ${clamp(doc.description, limit)}`);
		}
		lines.push("");
	});

	return lines.join("\n").trimEnd();
}

export interface RenderCallArgs {
	query?: string;
	searchType?: SearchType;
	count?: number;
	timeRange?: string;
}

export function renderCallText(args: RenderCallArgs, theme: ThemeLike): string {
	const query = args?.query?.replace(/\s+/g, " ").trim();
	const shown = query && query.length > 40 ? `${query.slice(0, 40)}…` : query;
	let text = `${theme.fg("toolTitle", theme.bold("doubao_web_search "))}`;
	text += theme.fg("accent", shown ? `「${shown}」` : "(缺少 query)");
	if (args?.searchType) text += theme.fg("muted", ` · ${args.searchType}`);
	if (args?.count !== undefined) text += theme.fg("muted", ` · ${args.count} 条`);
	if (args?.timeRange) text += theme.fg("dim", ` · ${args.timeRange}`);
	return text;
}

export function renderResultText(
	result: { content?: { type: string; text?: string }[] },
	options: { expanded?: boolean; isPartial?: boolean },
	details: SearchDetails | undefined,
	theme: ThemeLike,
): string {
	if (options?.isPartial || !details || details.status !== "done") {
		return theme.fg("warning", details?.progress ?? "搜索中…");
	}

	const parts: string[] = [`${details.returnedCount ?? 0} 条结果`];
	if (details.resultCount !== undefined && details.resultCount !== details.returnedCount) {
		parts.push(`上游标注 ${details.resultCount}`);
	}
	if (details.timeCostMs !== undefined) parts.push(`TimeCost ${details.timeCostMs}ms`);
	if (details.elapsedMs !== undefined) parts.push(`${Math.round(details.elapsedMs)}ms`);
	let text = `${theme.fg("success", "✔ ")}${theme.fg("muted", parts.join(" · "))}`;
	text += theme.fg("muted", ` · ${details.searchType}`);
	if (details.truncated) text += theme.fg("warning", " · 输出被截断");
	if (details.warnings.length > 0) text += theme.fg("warning", ` · ${details.warnings.length} 条提示`);

	if (options?.expanded) {
		const body = result?.content?.find((item) => item.type === "text");
		if (body?.text) {
			const lines = body.text.split("\n");
			for (const line of lines.slice(0, 30)) text += `\n${theme.fg("dim", line)}`;
			if (lines.length > 30) text += `\n${theme.fg("muted", "…（完整内容在工具结果里）")}`;
		}
		if (details.fullOutputPath) text += `\n${theme.fg("muted", `完整结果：${details.fullOutputPath}`)}`;
	}
	return text;
}
