// 工具渲染的纯文本部分：不依赖 pi 运行时，可单独测试；
// index.ts 只负责把这里返回的字符串包进 pi-tui 的 Text 组件。
import { formatBytes, normalizeSources } from "./media.ts";

/** 只用到 pi 主题的这两个方法，便于测试替身 */
export interface ThemeLike {
	fg(color: string, text: string): string;
	bold(text: string): string;
}

export interface RenderSource {
	input: string;
	kind: "local" | "remote";
	bytes?: number;
	durationSec?: number;
	resolution?: string;
	transport?: "base64" | "upload" | "url";
	uploaded?: boolean;
	cached?: boolean;
}

export interface RenderDetails {
	status: "preparing" | "uploading" | "analyzing" | "done";
	progress?: string;
	model: string;
	detail: string;
	fps: number;
	maxPixels: number;
	reasoningEffort: string;
	sources: RenderSource[];
	elapsedMs?: number;
	usage?: { totalTokens: number; reasoning: number; input: number; output: number };
	usageText?: string;
	costText?: string;
	finishReason?: string;
	truncated?: boolean;
	fullOutputPath?: string;
	warnings: string[];
}

export interface RenderCallArgs {
	source?: string | string[];
	detail?: string;
	prompt?: string;
	fps?: number;
	maxPixels?: number;
}

function truncatePrompt(prompt: string, limit = 40): string {
	const oneLine = prompt.replace(/\s+/g, " ").trim();
	return oneLine.length > limit ? `${oneLine.slice(0, limit)}…` : oneLine;
}

export function renderCallText(args: RenderCallArgs, theme: ThemeLike): string {
	let list: string[] = [];
	try {
		list = normalizeSources(args?.source);
	} catch {
		list = [];
	}
	const head = list.length > 1 ? `${list[0]} 等 ${list.length} 个视频` : (list[0] ?? "(缺少 source)");
	let text = `${theme.fg("toolTitle", theme.bold("video_read "))}${theme.fg("accent", head)}`;
	if (args?.detail) text += theme.fg("muted", ` · ${args.detail}`);
	if (args?.prompt) text += theme.fg("dim", ` · 「${truncatePrompt(args.prompt)}」`);
	return text;
}

/** 完成态的概览行：耗时 / token / 思考量 / 成本 / 视频帧 token */
export function renderResultText(
	result: { content?: { type: string; text?: string }[] },
	options: { expanded?: boolean; isPartial?: boolean },
	details: RenderDetails | undefined,
	theme: ThemeLike,
): string {
	if (options.isPartial || !details || details.status !== "done") {
		return theme.fg("warning", details?.progress ?? "准备中…");
	}

	const parts: string[] = [];
	if (details.elapsedMs !== undefined) parts.push(`${(details.elapsedMs / 1000).toFixed(1)}s`);
	if (details.usage) {
		parts.push(`${details.usage.totalTokens} tokens`);
		parts.push(`思考 ${details.usage.reasoning}`);
	}
	if (details.costText) parts.push(details.costText);
	let text = `${theme.fg("success", "✔ 读完")} ${theme.fg("muted", parts.join(" · "))}`;
	if (details.truncated) text += theme.fg("warning", " · 输出被截断");
	if (details.finishReason === "length") text += theme.fg("warning", " · 触及 max_tokens");

	if (options.expanded) {
		const body = result.content?.find((c) => c.type === "text");
		if (body?.text) {
			const lines = body.text.split("\n");
			for (const line of lines.slice(0, 30)) text += `\n${theme.fg("dim", line)}`;
			if (lines.length > 30) text += `\n${theme.fg("muted", "…（展开已截断，完整内容在工具结果里）")}`;
		}
		if (details.fullOutputPath) text += `\n${theme.fg("muted", `完整结果：${details.fullOutputPath}`)}`;
	}
	return text;
}

/** source 概览行：`mg.mp4 (local, 1.1 MB, 8.2s, base64)` */
export function describeSource(source: RenderSource): string {
	const bits: string[] = [source.kind];
	if (source.bytes !== undefined) bits.push(formatBytes(source.bytes));
	if (source.durationSec !== undefined) bits.push(`${source.durationSec.toFixed(1)}s`);
	if (source.resolution) bits.push(source.resolution);
	if (source.transport) {
		bits.push(source.cached ? `${source.transport}(cached)` : source.transport);
	}
	return `${source.input} (${bits.join(", ")})`;
}
