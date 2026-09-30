// qwen-omni.ts 的测试：SSE 增量解析、请求体构造、用量与成本
//
// 期望值来源（非镜像断言）：
//   - SSE 文本真值：tests/fixtures/*.expected.json，由 probe/derive-fixture-truth.mjs
//     以「正则全量扫描」这一独立实现路径从同一份真实回包导出
//   - 请求体形状：阿里云百炼 qwen-api-via-openai-chat-completions 文档示例
//     （fps / max_pixels 与 video_url 同级，不在 video_url 内部）
//   - 成本：按价目表手算（输入 ¥0.8/M、缓存命中 ¥0.1/M、输出 ¥2.7/M）
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
	PRICES,
	buildRequestBody,
	clampFps,
	computeCost,
	createStreamAccumulator,
	normalizeUsage,
	toPiUsage,
} from "../qwen-omni.ts";

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

function fixture(name: string) {
	return readFileSync(join(fixtureDir, name));
}
function expected(name: string): any {
	return JSON.parse(readFileSync(join(fixtureDir, name), "utf8"));
}

test("SSE 累加器：按 1 字节粒度喂入，跨 UTF-8 与跨行切分都不丢字", () => {
	const want = expected("sse-none.expected.json");
	const raw = fixture("sse-none.txt");
	const acc = createStreamAccumulator();
	for (const byte of raw) acc.push(Uint8Array.of(byte));
	assert.equal(acc.state.content, want.content);
	assert.equal(acc.state.reasoning, "");
	assert.equal(acc.state.finishReason, "stop");
	// 事件数的独立来源：直接对夹具原文正则统计带 choices 的 data 行
	const expectedEvents = raw
		.toString("utf8")
		.split("\n")
		.filter((line) => /^data: .*"choices":\[\{/.test(line)).length;
	assert.equal(acc.state.deltaCount, expectedEvents);
	assert.ok(expectedEvents > 10, `夹具事件数异常：${expectedEvents}`);
});

test("SSE 累加器：整块喂入与逐字节喂入结果一致（含 reasoning_content 分轨）", () => {
	const want = expected("sse-low.expected.json");
	const raw = fixture("sse-low.txt");

	const whole = createStreamAccumulator();
	whole.push(new Uint8Array(raw));
	assert.equal(whole.state.content, want.content);
	assert.equal(whole.state.reasoning, want.reasoning);
	assert.notEqual(whole.state.reasoning, ""); // low thinking 档确实有思考内容

	// 再按 7 字节切片喂一次，结果必须一模一样
	const sliced = createStreamAccumulator();
	for (let i = 0; i < raw.length; i += 7) sliced.push(new Uint8Array(raw.subarray(i, i + 7)));
	assert.equal(sliced.state.content, want.content);
	assert.equal(sliced.state.reasoning, want.reasoning);
});

test("SSE 累加器：[DONE] 与空行不会污染正文", () => {
	const acc = createStreamAccumulator();
	acc.push(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"甲"}}]}\n\n'));
	acc.push(new TextEncoder().encode("\n"));
	acc.push(new TextEncoder().encode(": keep-alive\n\n"));
	acc.push(new TextEncoder().encode("data: [DONE]\n\n"));
	assert.equal(acc.state.content, "甲");
});

test("SSE 累加器会在每个事件后回调（供进度显示）", () => {
	let calls = 0;
	const acc = createStreamAccumulator(() => {
		calls += 1;
	});
	acc.push(fixture("sse-none.txt"));
	assert.equal(calls, acc.state.deltaCount);
	assert.ok(calls > 0);
});

test("clampFps 夹到文档允许的 [0.1, 10]", () => {
	assert.equal(clampFps(1), 1);
	assert.equal(clampFps(0.01), 0.1);
	assert.equal(clampFps(99), 10);
	assert.equal(clampFps(Number.NaN), 1); // 非法值回落默认
	assert.equal(clampFps(undefined), 1);
});

test("buildRequestBody：只出文本、带上 fps/max_pixels 与 thinking 档位", () => {
	const body: any = buildRequestBody({
		model: "qwen3.8-omni-flash",
		inputs: ["data:;base64,AAAA"],
		prompt: "看视频",
		fps: 30,
		maxPixels: 230400,
		reasoningEffort: "low",
		maxTokens: 8000,
	});
	assert.equal(body.model, "qwen3.8-omni-flash");
	assert.deepEqual(body.modalities, ["text"]); // 3.8-omni 仅文本输出
	assert.equal("audio" in body, false);
	assert.equal(body.reasoning_effort, "low");
	assert.equal(body.max_tokens, 8000);
	assert.equal(body.stream, true);
	assert.deepEqual(body.stream_options, { include_usage: true });

	const content = body.messages[0].content;
	assert.equal(content[0].type, "video_url");
	assert.equal(content[0].video_url.url, "data:;base64,AAAA");
	assert.equal(content[0].fps, 10); // 30 → 夹到 10
	assert.equal(content[0].max_pixels, 230400); // 与 video_url 同级（文档示例）
	assert.equal(content[0].video_url.max_pixels, undefined);
	assert.equal(content.at(-1).type, "text"); // 文本块放最后
	assert.equal(content.at(-1).text, "看视频");
});

test("buildRequestBody：多源保持顺序，且不写 max_pixels 时不出现该键", () => {
	const body: any = buildRequestBody({
		model: "m",
		inputs: ["oss://a.mp4", "https://b.mp4"],
		prompt: "对比",
		fps: 1,
		reasoningEffort: "none",
		maxTokens: 100,
	});
	const videos = body.messages[0].content.filter((c: any) => c.type === "video_url");
	assert.deepEqual(
		videos.map((c: any) => c.video_url.url),
		["oss://a.mp4", "https://b.mp4"],
	);
	for (const v of videos) assert.equal("max_pixels" in v, false);
});

test("normalizeUsage 从真实回包里抽出各模态用量", () => {
	const raw = expected("sse-none.expected.json").usage;
	const u = normalizeUsage(raw);
	assert.equal(u.promptTokens, 1909);
	assert.equal(u.completionTokens, 36);
	assert.equal(u.totalTokens, 1945);
	assert.equal(u.videoTokens, 1794);
	assert.equal(u.audioTokens, 93);
	assert.equal(u.cachedTokens, 0);
	assert.equal(u.reasoningTokens, 0);
});

test("normalizeUsage 对缺字段的用量补 0 而不是 NaN", () => {
	const u = normalizeUsage({ prompt_tokens: 10 });
	assert.deepEqual(u, {
		promptTokens: 10,
		completionTokens: 0,
		totalTokens: 0,
		videoTokens: 0,
		audioTokens: 0,
		cachedTokens: 0,
		reasoningTokens: 0,
	});
});

test("computeCost 按价目表；缓存命中按 ¥0.1/M，思考 token 不重复计费", () => {
	assert.equal(PRICES.inputPerM, 0.8);
	assert.equal(PRICES.cachedInputPerM, 0.1);
	assert.equal(PRICES.outputPerM, 2.7);

	// 夹具真值：1909 输入（无缓存）×0.8 + 36 输出×2.7 = 1527.2 + 97.2 = 1624.4（每百万分之一元）
	const none = computeCost(normalizeUsage(expected("sse-none.expected.json").usage));
	assert.ok(Math.abs(none.input - 0.0015272) < 1e-9, String(none.input));
	assert.ok(Math.abs(none.output - 0.0000972) < 1e-9, String(none.output));
	assert.ok(Math.abs(none.total - 0.0016244) < 1e-9, String(none.total));

	// 手算：600×0.8 + 400×0.1 = 520，输出 100×2.7 = 270 → 790 单位 = ¥0.00079
	const cached = computeCost({
		promptTokens: 1000,
		completionTokens: 100,
		totalTokens: 1100,
		videoTokens: 0,
		audioTokens: 0,
		cachedTokens: 400,
		reasoningTokens: 80,
	});
	assert.ok(Math.abs(cached.total - 0.00079) < 1e-9, String(cached.total));
});

test("toPiUsage 产出 pi 的 Usage 形状，输出含思考 token", () => {
	const u = normalizeUsage(expected("sse-low.expected.json").usage);
	const pi = toPiUsage(u);
	assert.equal(pi.input, 1937);
	assert.equal(pi.output, 209);
	assert.equal(pi.cacheRead, 0);
	assert.equal(pi.cacheWrite, 0);
	assert.equal(pi.reasoning, 127);
	assert.equal(pi.totalTokens, 2146);
	// 手算：1937×0.8 + 209×2.7 = 1549.6 + 564.3 = 2113.9
	assert.ok(Math.abs(pi.cost.total - (1937 * 0.8 + 209 * 2.7) / 1e6) < 1e-9, String(pi.cost.total));
});
