// render.ts 的测试：工具调用/结果的显示文本（纯字符串，无需 pi 运行时）
// 期望值来源：本扩展自己的显示约定（ANSI 由主题替身显式标出，便于断言）
import assert from "node:assert/strict";
import { test } from "node:test";

import { type RenderDetails, describeSource, renderCallText, renderResultText } from "../render.ts";

/** 主题替身：把颜色/加粗显式写进字符串，断言时能一眼看出样式是否被用上 */
const theme = {
	fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
	bold: (text: string) => `**${text}**`,
};

const doneDetails: RenderDetails = {
	status: "done",
	model: "qwen3.8-omni-flash",
	detail: "standard",
	fps: 1,
	maxPixels: 921600,
	reasoningEffort: "low",
	sources: [{ input: "mg.mp4", kind: "local", bytes: 1146698, durationSec: 8.166341, resolution: "1280×720", transport: "base64" }],
	elapsedMs: 11042,
	usage: { totalTokens: 3253, reasoning: 251, input: 2502, output: 751 },
	costText: "¥0.0029",
	warnings: [],
};

test("renderCallText：单文件显示路径与档位", () => {
	const text = renderCallText({ source: "D:/v/a.mp4", detail: "quick" }, theme);
	assert.ok(text.includes("D:/v/a.mp4"), text);
	assert.ok(text.includes("quick"), text);
	assert.ok(text.includes("<toolTitle>"), text);
});

test("renderCallText：多文件显示数量，长问题截断", () => {
	const text = renderCallText({ source: ["a.mp4", "b.mp4", "c.mp4"], prompt: "看".repeat(60) }, theme);
	assert.ok(text.includes("等 3 个视频"), text);
	assert.ok(text.includes("…"), text);
	assert.ok(!text.includes("看".repeat(60)), "超长问题必须截断");
});

test("renderCallText：缺 source 不崩", () => {
	assert.ok(renderCallText({}, theme).includes("缺少 source"));
});

test("renderResultText：进行中显示进度而不是结果", () => {
	const text = renderResultText({ content: [] }, { isPartial: true }, { ...doneDetails, status: "analyzing", progress: "🧠 分析中 · ⏱ 3.2s" }, theme);
	assert.ok(text.includes("分析中"), text);
	assert.ok(!text.includes("读完"), text);
});

test("renderResultText：完成态给出耗时/token/思考/成本，且不展开正文", () => {
	const text = renderResultText({ content: [{ type: "text", text: "正文不该出现" }] }, {}, doneDetails, theme);
	assert.ok(text.includes("11.0s"), text);
	assert.ok(text.includes("3253 tokens"), text);
	assert.ok(text.includes("思考 251"), text);
	assert.ok(text.includes("¥0.0029"), text);
	assert.ok(!text.includes("正文不该出现"), "未展开时不应显示正文");
});

test("renderResultText：展开时展示正文前 30 行并提示截断", () => {
	const body = Array.from({ length: 40 }, (_, i) => `第${i + 1}行`).join("\n");
	const text = renderResultText({ content: [{ type: "text", text: body }] }, { expanded: true }, doneDetails, theme);
	assert.ok(text.includes("第1行"));
	assert.ok(text.includes("第30行"));
	assert.ok(!text.includes("第31行"));
	assert.ok(text.includes("展开已截断"), text);
});

test("renderResultText：截断与 max_tokens 告警都要露出来", () => {
	const text = renderResultText(
		{ content: [] },
		{},
		{ ...doneDetails, truncated: true, finishReason: "length", fullOutputPath: "C:/tmp/x.txt" },
		theme,
	);
	assert.ok(text.includes("输出被截断"), text);
	assert.ok(text.includes("触及 max_tokens"), text);
});

test("renderResultText：details 缺失时退化成占位而不是抛错", () => {
	assert.equal(renderResultText({ content: [] }, {}, undefined, theme), "<warning>准备中…</warning>");
});

test("describeSource：本地文件把体积/时长/内联方式都写清楚", () => {
	assert.equal(describeSource(doneDetails.sources[0]), "mg.mp4 (local, 1.1 MB, 8.2s, 1280×720, base64)");
	assert.equal(
		describeSource({ input: "https://x/a.mp4", kind: "remote", transport: "url" }),
		"https://x/a.mp4 (remote, url)",
	);
	assert.equal(
		describeSource({ input: "big.mp4", kind: "local", bytes: 16 * 1024 * 1024, transport: "upload", cached: true }),
		"big.mp4 (local, 16.0 MB, upload(cached))",
	);
});
