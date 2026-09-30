// 百炼 Qwen-Omni 客户端：请求体构造、SSE 增量解析、用量与成本
//
// 事实依据（2026-09-28 实测 + 官方文档）：
//   - qwen3.8-omni-flash 仅输出文本，请求必须带 modalities:["text"]
//   - 视频内容块形状：{type:"video_url", video_url:{url}, fps, max_pixels}（fps/max_pixels 与 video_url 同级）
//   - oss:// 输入必须带请求头 X-DashScope-OssResourceResolve: enable
//   - 价目表：输入 ¥0.8/M、缓存命中 ¥0.1/M、输出 ¥2.7/M（缓存命中是输入的子集，不重复计）
//   - 思考内容走 delta.reasoning_content，与正文 delta.content 分轨

/** 每百万 token 的人民币单价（百炼控制台价目表） */
export const PRICES = {
	inputPerM: 0.8,
	cachedInputPerM: 0.1,
	outputPerM: 2.7,
};

export const FPS_MIN = 0.1;
export const FPS_MAX = 10;
export const DEFAULT_FPS = 1;

export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export const REASONING_EFFORTS: readonly ReasoningEffort[] = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

export interface RawUsage {
	prompt_tokens?: number;
	completion_tokens?: number;
	total_tokens?: number;
	prompt_tokens_details?: {
		text_tokens?: number;
		video_tokens?: number;
		audio_tokens?: number;
		cached_tokens?: number;
	};
	completion_tokens_details?: {
		text_tokens?: number;
		reasoning_tokens?: number;
		audio_tokens?: number;
	};
}

export interface UsageNumbers {
	promptTokens: number;
	completionTokens: number;
	totalTokens: number;
	videoTokens: number;
	audioTokens: number;
	cachedTokens: number;
	reasoningTokens: number;
}

export interface Cost {
	input: number;
	output: number;
	total: number;
	currency: "CNY";
}

export interface StreamState {
	/** 正文（模型最终回答） */
	content: string;
	/** 思考过程（reasoning_effort ≠ none 时才有） */
	reasoning: string;
	finishReason?: string;
	rawUsage?: RawUsage;
	/** 收到的有效事件数（用于进度显示） */
	deltaCount: number;
}

export interface StreamAccumulator {
	push(chunk: Uint8Array): void;
	/** 冲刷 TextDecoder 里可能残留的半截多字节字符 */
	finish(): void;
	readonly state: StreamState;
}

export function clampFps(fps: number | undefined): number {
	if (fps === undefined || !Number.isFinite(fps) || fps <= 0) return DEFAULT_FPS;
	return Math.min(FPS_MAX, Math.max(FPS_MIN, fps));
}

/**
 * 解析 SSE 字节流。按行切分，容忍任意字节边界（含多字节 UTF-8 被切开的情况），
 * 与 data 行被拆到多个 chunk 的情况。
 */
export function createStreamAccumulator(onEvent?: (state: StreamState) => void): StreamAccumulator {
	const decoder = new TextDecoder();
	let buffer = "";
	const state: StreamState = { content: "", reasoning: "", deltaCount: 0 };

	function handleData(payload: string): void {
		const trimmed = payload.trim();
		if (!trimmed || trimmed === "[DONE]") return;
		let event: any;
		try {
			event = JSON.parse(trimmed);
		} catch {
			return; // 非 JSON 的保活/注释行直接忽略
		}
		if (event?.usage) state.rawUsage = event.usage;
		const choice = Array.isArray(event?.choices) ? event.choices[0] : undefined;
		if (!choice) return;
		const delta = choice.delta ?? {};
		if (typeof delta.reasoning_content === "string") state.reasoning += delta.reasoning_content;
		if (typeof delta.content === "string") state.content += delta.content;
		if (choice.finish_reason) state.finishReason = choice.finish_reason;
		state.deltaCount += 1;
		onEvent?.(state);
	}

	function consumeLines(flushAll: boolean): void {
		let index = buffer.indexOf("\n");
		while (index >= 0) {
			const line = buffer.slice(0, index).replace(/\r$/, "");
			buffer = buffer.slice(index + 1);
			if (line.startsWith("data:")) handleData(line.slice(5));
			index = buffer.indexOf("\n");
		}
		if (flushAll && buffer) {
			const line = buffer.replace(/\r$/, "");
			buffer = "";
			if (line.startsWith("data:")) handleData(line.slice(5));
		}
	}

	return {
		push(chunk: Uint8Array): void {
			buffer += decoder.decode(chunk, { stream: true });
			consumeLines(false);
		},
		finish(): void {
			buffer += decoder.decode();
			consumeLines(true);
		},
		state,
	};
}

export interface RequestBodyOptions {
	model: string;
	/** 已解析好的输入（data URI / oss://… / https://…），顺序即请求顺序 */
	inputs: string[];
	prompt: string;
	fps: number;
	maxPixels?: number;
	reasoningEffort?: ReasoningEffort;
	maxTokens: number;
}

/** 构造 chat/completions 请求体（纯函数，便于测试） */
export function buildRequestBody(options: RequestBodyOptions): Record<string, unknown> {
	const content: Record<string, unknown>[] = options.inputs.map((url) => {
		const block: Record<string, unknown> = {
			type: "video_url",
			video_url: { url },
			fps: clampFps(options.fps),
		};
		if (options.maxPixels !== undefined) block.max_pixels = options.maxPixels;
		return block;
	});
	content.push({ type: "text", text: options.prompt });

	const body: Record<string, unknown> = {
		model: options.model,
		modalities: ["text"], // 视频/音频只进不出：不写 audio 参数
		stream: true,
		stream_options: { include_usage: true },
		max_tokens: options.maxTokens,
		messages: [{ role: "user", content }],
	};
	if (options.reasoningEffort) body.reasoning_effort = options.reasoningEffort;
	return body;
}

export function normalizeUsage(raw: RawUsage | undefined): UsageNumbers {
	const promptDetails = raw?.prompt_tokens_details ?? {};
	const completionDetails = raw?.completion_tokens_details ?? {};
	return {
		promptTokens: raw?.prompt_tokens ?? 0,
		completionTokens: raw?.completion_tokens ?? 0,
		totalTokens: raw?.total_tokens ?? 0,
		videoTokens: promptDetails.video_tokens ?? 0,
		audioTokens: promptDetails.audio_tokens ?? 0,
		cachedTokens: promptDetails.cached_tokens ?? 0,
		reasoningTokens: completionDetails.reasoning_tokens ?? 0,
	};
}

/** 按价目表算钱；缓存命中的输入按 ¥0.1/M，其余输入按 ¥0.8/M */
export function computeCost(usage: UsageNumbers): Cost {
	const cached = Math.min(usage.cachedTokens, usage.promptTokens);
	const fresh = Math.max(0, usage.promptTokens - cached);
	const input = (fresh * PRICES.inputPerM + cached * PRICES.cachedInputPerM) / 1_000_000;
	const output = (usage.completionTokens * PRICES.outputPerM) / 1_000_000;
	return { input, output, total: input + output, currency: "CNY" };
}

/** 转成 pi 的 Usage 形状，让会话统计能算上这次调用 */
export function toPiUsage(usage: UsageNumbers): {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	reasoning: number;
	totalTokens: number;
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
} {
	const cost = computeCost(usage);
	return {
		input: usage.promptTokens,
		output: usage.completionTokens,
		cacheRead: usage.cachedTokens,
		cacheWrite: 0,
		reasoning: usage.reasoningTokens,
		totalTokens: usage.totalTokens,
		cost: { input: cost.input, output: cost.output, cacheRead: 0, cacheWrite: 0, total: cost.total },
	};
}

export function formatCost(cost: Cost): string {
	if (cost.total <= 0) return "¥0";
	if (cost.total < 0.01) return `¥${cost.total.toFixed(4)}`;
	return `¥${cost.total.toFixed(3)}`;
}

function describeHttpError(status: number, bodyText: string): string {
	let detail = bodyText.slice(0, 500);
	try {
		const parsed = JSON.parse(bodyText);
		const err = parsed?.error ?? parsed;
		const code = err?.code ? `[${err.code}] ` : "";
		const message = err?.message ?? "";
		if (code || message) detail = `${code}${message}`;
	} catch {
		/* 非 JSON 就直接用原文 */
	}
	return `百炼接口返回 HTTP ${status}：${detail}`;
}

export interface StreamChatOptions extends RequestBodyOptions {
	apiKey: string;
	baseUrl: string;
	timeoutMs: number;
	signal?: AbortSignal;
	/** 每个 SSE 事件回调一次；调用方自行节流 */
	onEvent?: (state: StreamState, elapsedMs: number) => void;
}

export interface StreamChatResult {
	model: string;
	content: string;
	reasoning: string;
	finishReason?: string;
	usage: UsageNumbers;
	cost: Cost;
	elapsedMs: number;
	timedOut: boolean;
}

export async function streamChat(options: StreamChatOptions): Promise<StreamChatResult> {
	const started = Date.now();
	const timeoutSignal = AbortSignal.timeout(options.timeoutMs);
	const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
	const body = buildRequestBody(options);
	const needsOssResolve = options.inputs.some((url) => url.startsWith("oss://"));

	const headers: Record<string, string> = {
		Authorization: `Bearer ${options.apiKey}`,
		"Content-Type": "application/json",
	};
	if (needsOssResolve) headers["X-DashScope-OssResourceResolve"] = "enable";

	let response: Response;
	try {
		response = await fetch(`${options.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
			method: "POST",
			headers,
			body: JSON.stringify(body),
			signal,
		});
	} catch (error: any) {
		if (signal.aborted) throw abortError(options, timeoutSignal.aborted);
		throw new Error(`请求百炼接口失败：${error?.message ?? String(error)}`);
	}

	if (!response.ok) {
		const text = await response.text().catch(() => "");
		if (response.status === 401 || response.status === 403) {
			throw new Error(`鉴权失败（HTTP ${response.status}）：请检查 DASHSCOPE_API_KEY 是否有效、与文件上传是否同一主账号。${text.slice(0, 300)}`);
		}
		throw new Error(describeHttpError(response.status, text));
	}

	const accumulator = createStreamAccumulator((state) => options.onEvent?.(state, Date.now() - started));
	if (!response.body) throw new Error("百炼接口没有返回响应体（应为 SSE 流）");
	try {
		for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
			accumulator.push(chunk);
		}
	} catch (error: any) {
		if (signal.aborted) throw abortError(options, timeoutSignal.aborted);
		throw new Error(`读取响应流中断：${error?.message ?? String(error)}`);
	}
	accumulator.finish();

	const usage = normalizeUsage(accumulator.state.rawUsage);
	return {
		model: options.model,
		content: accumulator.state.content.trim(),
		reasoning: accumulator.state.reasoning,
		finishReason: accumulator.state.finishReason,
		usage,
		cost: computeCost(usage),
		elapsedMs: Date.now() - started,
		timedOut: false,
	};
}

function abortError(options: StreamChatOptions, timedOut: boolean): Error {
	if (timedOut) {
		return new Error(
			`调用超时（超过 ${Math.round(options.timeoutMs / 1000)} 秒）。长视频建议降 fps 或提高 config.timeoutSec。`,
		);
	}
	return new Error("调用已被取消。");
}
