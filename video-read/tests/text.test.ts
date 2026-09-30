// text.ts 的测试：超限裁剪的边界（行/字节先到为准、UTF-8 不切半、提示文案）
import assert from "node:assert/strict";
import { test } from "node:test";

import { capModelText, withNotice } from "../text.ts";

const limits = {
	maxLines: 5,
	maxBytes: 40,
	formatSize: (bytes: number) => `${bytes}B`,
};

test("未超限时原样返回", () => {
	const capped = capModelText("一\n二\n三", limits);
	assert.equal(capped.text, "一\n二\n三");
	assert.equal(capped.truncated, false);
	assert.equal(capped.notice, undefined);
});

test("正好等于上限也不算截断（边界）", () => {
	assert.equal(capModelText("a".repeat(40), limits).truncated, false); // 40 字节
	assert.equal(capModelText("1\n2\n3\n4\n5", limits).truncated, false); // 5 行
});

test("行数先到：按行裁到上限，并报出真实总量", () => {
	const capped = capModelText("1\n2\n3\n4\n5\n6\n7", limits);
	assert.equal(capped.text, "1\n2\n3\n4\n5");
	assert.equal(capped.truncated, true);
	assert.ok(capped.notice?.includes("5/7 行"), capped.notice ?? "（没有截断提示）");
});

test("字节先到：多字节字符不被切断（不出现替换字符）", () => {
	const capped = capModelText("中文中文中文中文中文中文中文中文中文中文", limits);
	assert.equal(capped.truncated, true);
	assert.ok(!capped.text.includes("\uFFFD"), JSON.stringify(capped.text));
	assert.equal(Buffer.byteLength(capped.text, "utf8") % 3, 0); // 全是 3 字节汉字
	assert.ok(Buffer.byteLength(capped.text, "utf8") <= 40);
});

test("提示文案带上完整结果的落盘路径", () => {
	const capped = capModelText("x".repeat(100), limits);
	const text = withNotice(capped, "C:/tmp/full.txt");
	assert.ok(text.startsWith("x".repeat(40)), text.slice(0, 60));
	assert.ok(text.includes("完整结果见 C:/tmp/full.txt"), text);
	assert.ok(!text.includes("{path}"), "占位符必须被替换掉");
});

test("未截断时 withNotice 不添加任何东西", () => {
	const capped = capModelText("短文本", limits);
	assert.equal(withNotice(capped, "C:/tmp/full.txt"), "短文本");
});
