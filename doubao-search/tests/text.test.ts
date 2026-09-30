// text.ts 的测试：模型侧输出裁剪（行/字节先到为准，UTF-8 安全）+ 截断提示。
import assert from "node:assert/strict";
import { test } from "node:test";

import { capModelText, withNotice } from "../text.ts";

const limits = { maxLines: 5, maxBytes: 10_000, formatSize: (b: number) => `${b}B` };
const byteLimits = { maxLines: 1000, maxBytes: 20, formatSize: (b: number) => `${b}B` };

test("未超限：原文返回且不标截断", () => {
	const capped = capModelText("a\nb\nc", limits);
	assert.equal(capped.text, "a\nb\nc");
	assert.equal(capped.truncated, false);
	assert.equal(capped.notice, undefined);
});

test("按行数截断：只保留前 N 行", () => {
	const capped = capModelText("1\n2\n3\n4\n5\n6\n7", limits);
	assert.equal(capped.text, "1\n2\n3\n4\n5");
	assert.equal(capped.truncated, true);
	assert.match(capped.notice!, /\{path\}/);
	assert.match(capped.notice!, /5\/7 行/);
});

test("按字节截断：不切出半个 UTF-8 字符", () => {
	const capped = capModelText("中文中文中文中文中文中文", byteLimits);
	assert.equal(capped.truncated, true);
	const bytes = Buffer.byteLength(capped.text, "utf8");
	assert.ok(bytes <= byteLimits.maxBytes, `${bytes} 超过上限`);
	assert.ok(!capped.text.endsWith("\uFFFD"));
	assert.equal(Buffer.from(capped.text, "utf8").toString("utf8"), capped.text);
});

test("withNotice：把占位符替换成落盘路径；未截断时原样返回", () => {
	const capped = capModelText("1\n2\n3\n4\n5\n6", limits);
	const text = withNotice(capped, "D:/tmp/full.txt");
	assert.match(text, /D:\/tmp\/full\.txt/);
	assert.equal(text.includes("{path}"), false);

	const clean = capModelText("short", limits);
	assert.equal(withNotice(clean, "D:/tmp/full.txt"), "short");
});
