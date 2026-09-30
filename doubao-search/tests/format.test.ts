// format.ts 的测试：给模型看的文本格式（默认只给 Summary，正文按开关附加）。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { formatSearchOutput, renderCallText, renderResultText } from "../format.ts";
import { parseResponse } from "../search.ts";

const fixture = (name: string) => JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", name), "utf8"));
const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };

test("web 输出：头部给查询/条数/耗时，每条给标题+站点+权威度、URL、摘要", () => {
	const out = formatSearchOutput(parseResponse(fixture("web-search.json")));
	assert.match(out, /豆包搜索·web/);
	assert.match(out, /天安门 介绍/);
	assert.match(out, /2 条结果/);
	assert.match(out, /98ms/);
	assert.match(out, /1\. 天安门广场/);
	assert.match(out, /抖音百科/);
	assert.match(out, /非常权威/);
	assert.match(out, /https:\/\/m\.baike\.com\//);
	assert.match(out, /天安门广场的中文名是/); // Summary 开头
});

test("默认不带正文：Content 正文里独有、Summary 里没有的内容不出现", () => {
	const res = parseResponse(fixture("web-search.json"));
	const doc = res.docs[0] as any;
	// 在真实回包里找一个「正文里有、摘要里没有」的无空白片段当探针（摘要本来就是正文的摘录，会高度重叠）
	const probe = findContentOnlyProbe(doc.content, doc.summary);
	assert.ok(probe.length >= 20, "探针太短");

	const withoutContent = formatSearchOutput(res);
	assert.equal(withoutContent.includes(probe), false);

	const withContent = formatSearchOutput(res, { includeContent: true });
	assert.equal(withContent.includes(probe), true);
});

/** 从正文里找一个摘要中不存在的、不含空白字符的片段（30 字窗口） */
function findContentOnlyProbe(content: string, summary: string, size = 30): string {
	for (let i = 0; i + size <= content.length; i += 3) {
		const candidate = content.slice(i, i + size);
		if (/\s/.test(candidate)) continue;
		if (!summary.includes(candidate)) return candidate;
	}
	throw new Error("fixture 里找不到正文独有的片段，无法验证 includeContent 开关");
}

test("无 Summary 时退回 Snippet，而不是留空", () => {
	const res = parseResponse(fixture("web-search.json"));
	const doc = res.docs[0] as any;
	delete doc.summary;
	doc.snippet = "只有一句简短片段";
	const out = formatSearchOutput(res);
	assert.match(out, /只有一句简短片段/);
});

test("摘要长度上限：超长时截断并加省略号", () => {
	const res = parseResponse(fixture("web-search.json"));
	const out = formatSearchOutput(res, { maxSummaryChars: 60 });
	const line = out.split("\n").find((l) => l.includes("天安门广场的中文名是"))!;
	assert.ok(line.length <= 61 + 3, `摘要行过长：${line.length}`);
	assert.match(line, /…$/);
});

test("文搜图输出：图片直链 + 尺寸/形状/清晰度，另有落地页", () => {
	const out = formatSearchOutput(parseResponse(fixture("image-search.json")));
	assert.match(out, /豆包搜索·image/);
	assert.match(out, /1280×852/);
	assert.match(out, /横长方形/);
	assert.match(out, /清晰/);
	assert.match(out, /图片: https:\/\//);
	assert.match(out, /落地页: https:\/\//);
});

test("火山如意卡片结果被标出来（SiteName=火山如意 时带 RuyiInfo.Type）", () => {
	const res = parseResponse({
		ResponseMetadata: { RequestId: "r" },
		Result: {
			ResultCount: 1,
			SearchContext: { SearchType: "web", OriginQuery: "北京天气" },
			WebResults: [
				{ Id: "1", SortId: 1, Title: "北京今日天气", SiteName: "火山如意", Snippet: "晴 24℃", AuthInfoDes: "非常权威", RuyiInfo: { Type: "weather" } },
			],
		},
	});
	const out = formatSearchOutput(res);
	assert.match(out, /如意卡片/);
	assert.match(out, /weather/);
});

test("空结果给出明确说明，而不是空白", () => {
	const res = parseResponse({
		ResponseMetadata: { RequestId: "r" },
		Result: { ResultCount: 0, SearchContext: { SearchType: "web", OriginQuery: "冷门词" }, WebResults: [] },
	});
	const out = formatSearchOutput(res);
	assert.match(out, /0 条结果/);
	assert.match(out, /没有可展示的结果|没有结果/);
});

test("renderCall / renderResult：TUI 概览行含查询与条数，展开时带正文摘要", () => {
	const call = renderCallText({ query: "天安门 介绍", searchType: "web", count: 5 }, theme);
	assert.match(call, /doubao_web_search/);
	assert.match(call, /天安门 介绍/);
	assert.match(call, /web/);

	const details = {
		status: "done" as const,
		query: "天安门 介绍",
		searchType: "web" as const,
		count: 5,
		requestedCount: 5,
		returnedCount: 2,
		resultCount: 2,
		timeCostMs: 98,
		elapsedMs: 320,
		warnings: [],
	};
	const done = renderResultText({ content: [{ type: "text", text: "1. 天安门广场" }] }, { expanded: false }, details, theme);
	assert.match(done, /2\s*条/);
	assert.match(done, /320ms|0\.3s/);

	const expanded = renderResultText({ content: [{ type: "text", text: "1. 天安门广场" }] }, { expanded: true }, details, theme);
	assert.match(expanded, /天安门广场/);
});
