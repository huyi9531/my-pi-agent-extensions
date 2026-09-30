// search.ts 的测试：请求体构造（官方 Custom 版字段名与上限）、响应解析、错误映射。
// 期望值来源：火山引擎《豆包搜索 Custom版》官方文档（docs/volcengine-custom-version.md）
// + 本机 2026-09-30 真实回包（tests/fixtures/*.json）。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import {
	COUNT_RANGE,
	DoubaoSearchError,
	MAX_BLOCK_HOSTS,
	MAX_SITES,
	QUERY_MAX_CHARS,
	WEB_SEARCH_URL,
	buildRequestBody,
	mapErrorHint,
	normalizeQuery,
	parseResponse,
} from "../search.ts";

const fixture = (name: string) => JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", name), "utf8"));

test("端点常量指向 Custom 版 web_search（不是 Global 版 global_search）", () => {
	assert.equal(WEB_SEARCH_URL, "https://open.feedcoopapi.com/search_api/web_search");
	assert.ok(!WEB_SEARCH_URL.includes("global_search"));
});

test("官方上限常量与文档一致", () => {
	assert.deepEqual(COUNT_RANGE.web, { min: 1, max: 50, default: 10 }); // 文档：最多50条，默认10条
	assert.deepEqual(COUNT_RANGE.image, { min: 1, max: 5, default: 5 }); // 文档：最多5条
	assert.equal(MAX_SITES, 20); // 文档：Sites 最多支持20个
	assert.equal(MAX_BLOCK_HOSTS, 5); // 文档：BlockHosts 最多支持5个
	assert.equal(QUERY_MAX_CHARS, 100); // 文档：Query 1~100 字符
});

test("normalizeQuery：去空白；空 query 报错", () => {
	assert.equal(normalizeQuery("  天安门 介绍  ").query, "天安门 介绍");
	assert.throws(() => normalizeQuery("   "), /Query 不能为空/);
	assert.throws(() => normalizeQuery(undefined as any), /Query/);
});

test("normalizeQuery：超过 100 字符截断并告警（文档：过长会截断）", () => {
	const long = "北".repeat(QUERY_MAX_CHARS + 20);
	const { query, warning } = normalizeQuery(long);
	assert.equal(query.length, QUERY_MAX_CHARS);
	assert.match(warning!, /100/);
});

test("buildRequestBody：web 最简请求只带 Query/SearchType/Count", () => {
	const { body, searchType, count, warnings } = buildRequestBody({ query: "天安门 介绍" });
	assert.deepEqual(body, { Query: "天安门 介绍", SearchType: "web", Count: 10 });
	assert.equal(searchType, "web");
	assert.equal(count, 10);
	assert.deepEqual(warnings, []);
});

test("buildRequestBody：不传的可选字段不出现（不给上游塞 null/空串）", () => {
	const { body } = buildRequestBody({ query: "x", count: 3 });
	assert.equal("Filter" in body, false);
	assert.equal("TimeRange" in body, false);
	assert.equal("QueryControl" in body, false);
	assert.equal("ContentFormats" in body, false);
	assert.equal("Industry" in body, false);
});

test("buildRequestBody：Count 越界按档位夹紧并告警（web 1~50 / image 1~5）", () => {
	const web = buildRequestBody({ query: "x", count: 999 });
	assert.equal(web.count, 50);
	assert.match(web.warnings.join(), /Count/);

	const img = buildRequestBody({ query: "x", searchType: "image", count: 9 });
	assert.equal(img.count, 5);
	assert.match(img.warnings.join(), /Count/);

	const zero = buildRequestBody({ query: "x", count: 0 });
	assert.equal(zero.count, 10);
	assert.match(zero.warnings.join(), /Count/);

	const frac = buildRequestBody({ query: "x", count: 3.6 });
	assert.equal(frac.count, 4);
});

test("buildRequestBody：web 全量筛选项 → 与文档字段名逐一对齐", () => {
	const { body } = buildRequestBody({
		query: "新能源车购置税 2026",
		count: 3,
		timeRange: "OneYear",
		sites: ["gov.cn", "chinatax.gov.cn"],
		blockHosts: ["zhihu.com"],
		authInfoLevel: 1,
		needUrl: true,
		needContent: true,
		queryRewrite: true,
		contentFormat: "markdown",
		industry: "gov",
	});
	assert.deepEqual(body, {
		Query: "新能源车购置税 2026",
		SearchType: "web",
		Count: 3,
		Filter: {
			NeedUrl: true,
			NeedContent: true,
			Sites: "gov.cn|chinatax.gov.cn",
			BlockHosts: "zhihu.com",
			AuthInfoLevel: 1,
		},
		TimeRange: "OneYear",
		QueryControl: { QueryRewrite: true },
		ContentFormats: "markdown",
		Industry: "gov",
	});
});

test("buildRequestBody：日期区间写法原样透传，非法写法报错", () => {
	const { body } = buildRequestBody({ query: "x", timeRange: "2025-01-01..2025-12-31" });
	assert.equal(body.TimeRange, "2025-01-01..2025-12-31");

	assert.throws(() => buildRequestBody({ query: "x", timeRange: "昨天" }), /TimeRange/);
	assert.throws(() => buildRequestBody({ query: "x", timeRange: "2025-13-01..2025-12-31" }), /TimeRange/);
	assert.throws(() => buildRequestBody({ query: "x", timeRange: "2025-12-31..2025-01-01" }), /TimeRange/);
});

test("buildRequestBody：枚举字段非法值一律报错，不静默降级", () => {
	assert.throws(() => buildRequestBody({ query: "x", searchType: "video" as any }), /SearchType/);
	assert.throws(() => buildRequestBody({ query: "x", industry: "medical" as any }), /Industry/);
	assert.throws(() => buildRequestBody({ query: "x", authInfoLevel: 2 as any }), /AuthInfoLevel/);
	assert.throws(() => buildRequestBody({ query: "x", contentFormat: "html" as any }), /ContentFormats/);
	assert.throws(() => buildRequestBody({ query: "x", searchType: "image", imageShapes: ["圆形"] }), /ImageShapes/);
});

test("buildRequestBody：站点数量超上限直接报错（静默丢弃会改变搜索语义）", () => {
	const sites = Array.from({ length: MAX_SITES + 1 }, (_, i) => `s${i}.com`);
	assert.throws(() => buildRequestBody({ query: "x", sites }), /20/);
	const hosts = Array.from({ length: MAX_BLOCK_HOSTS + 1 }, (_, i) => `s${i}.com`);
	assert.throws(() => buildRequestBody({ query: "x", blockHosts: hosts }), /5/);
});

test("buildRequestBody：站点必须是完整域名（带协议或路径的写法要拦下来）", () => {
	assert.throws(() => buildRequestBody({ query: "x", sites: ["https://gov.cn"] }), /域名/);
	assert.throws(() => buildRequestBody({ query: "x", sites: ["gov.cn/policy"] }), /域名/);
	assert.throws(() => buildRequestBody({ query: "x", sites: ["localhost"] }), /域名/);
});

test("buildRequestBody：文搜图尺寸筛选走 Filter，min>max 报错", () => {
	const { body } = buildRequestBody({
		query: "长城",
		searchType: "image",
		count: 2,
		imageWidthMin: 1200,
		imageWidthMax: 4000,
		imageHeightMin: 600,
		imageHeightMax: 3000,
		imageShapes: ["横长方形", "方形"],
	});
	assert.deepEqual(body, {
		Query: "长城",
		SearchType: "image",
		Count: 2,
		Filter: {
			ImageWidthMin: 1200,
			ImageWidthMax: 4000,
			ImageHeightMin: 600,
			ImageHeightMax: 3000,
			ImageShapes: ["横长方形", "方形"],
		},
	});
	assert.throws(() => buildRequestBody({ query: "x", searchType: "image", imageWidthMin: 4000, imageWidthMax: 1200 }), /宽度/);
	assert.throws(() => buildRequestBody({ query: "x", searchType: "image", imageHeightMin: -1 }), /高度/);
});

test("buildRequestBody：跨类型参数给告警并忽略（不给上游发无效字段）", () => {
	const webWithImageFilters = buildRequestBody({ query: "x", imageShapes: ["方形"], imageWidthMin: 100 });
	assert.equal("Filter" in webWithImageFilters.body, false);
	assert.match(webWithImageFilters.warnings.join(), /image/i);

	const imageWithWebFilters = buildRequestBody({
		query: "x",
		searchType: "image",
		timeRange: "OneWeek",
		industry: "gov",
		sites: ["gov.cn"],
	});
	assert.equal("TimeRange" in imageWithWebFilters.body, false);
	assert.equal("Industry" in imageWithWebFilters.body, false);
	assert.equal("Filter" in imageWithWebFilters.body, false);
	assert.match(imageWithWebFilters.warnings.join(), /web/);
});

test("parseResponse：真实 web 回包 → 归一化字段（fixtures 来自 2026-09-30 真机）", () => {
	const res = parseResponse(fixture("web-search.json"));
	assert.equal(res.searchType, "web");
	assert.equal(res.resultCount, 2);
	assert.equal(res.originQuery, "天安门 介绍");
	assert.equal(res.timeCostMs, 98);
	assert.ok(res.requestId);
	assert.equal(res.docs.length, 2);

	const first = res.docs[0] as any;
	assert.equal(first.kind, "web");
	assert.equal(first.sortId, 1);
	assert.equal(first.siteName, "抖音百科");
	assert.equal(first.authInfoDes, "非常权威");
	assert.equal(first.authInfoLevel, 1);
	assert.ok(first.url.startsWith("https://m.baike.com/"));
	assert.ok(first.summary.length > 500, "Summary 应为 500~1000 字段落"); // 官方：Summary 才是给大模型用的
	assert.ok(first.content.length > 0, "Content 正文应被解析出来");
	assert.equal(first.contentFormats, "text");
	assert.deepEqual(first.inlineImages, []);
});

test("parseResponse：真实文搜图回包 → ImageItem 归一化", () => {
	const res = parseResponse(fixture("image-search.json"));
	assert.equal(res.searchType, "image");
	const img = res.docs[0] as any;
	assert.equal(img.kind, "image");
	assert.equal(img.shape, "横长方形");
	assert.equal(img.width, 1280);
	assert.equal(img.height, 852);
	assert.equal(img.blurDes, "清晰");
	assert.ok(img.imageUrl.startsWith("https://"));
});

test("parseResponse：筛选组合回包（markdown / 全非常权威）", () => {
	const res = parseResponse(fixture("web-filtered.json"));
	assert.equal(res.docs.length, 3);
	assert.ok(res.docs.every((d: any) => d.authInfoDes === "非常权威"));
	assert.ok(res.docs.every((d: any) => d.contentFormats === "markdown"));
});

test("parseResponse：业务错误 → 抛 DoubaoSearchError，带错误码与可执行提示", () => {
	const err = (() => {
		try {
			parseResponse(fixture("error-10409-global-endpoint.json"));
		} catch (error) {
			return error as DoubaoSearchError;
		}
		return undefined;
	})();
	assert.ok(err instanceof DoubaoSearchError);
	assert.equal(err.code, "10409");
	assert.match(err.message, /package mode does not support/); // 原始上游信息照旧保留
	assert.match(err.hint ?? "", /套餐/); // 人话解读放在 hint 里，由扩展拼给模型看
	assert.match(err.hint ?? "", /Custom/);
	assert.ok(err.requestId, "错误信息里要带 RequestId 便于排查");
});

test("parseResponse：参数错误 10400 也走同一路径", () => {
	assert.throws(() => parseResponse(fixture("error-10400.json")), (error: any) => {
		assert.ok(error instanceof DoubaoSearchError);
		assert.equal(error.code, "10400");
		return true;
	});
});

test("parseResponse：拿不到 Result 又没错误码 → 抛错而不是当成空结果", () => {
	assert.throws(() => parseResponse({ ResponseMetadata: { RequestId: "x" } }), /没有返回/);
	assert.throws(() => parseResponse(null), /没有返回/);
	assert.throws(() => parseResponse("oops"), /没有返回/);
});

test("mapErrorHint：关键错误码都有人话解释与下一步动作", () => {
	for (const code of ["10400", "10403", "10406", "10408", "10409", "10410", "10412", "700429", "10500"]) {
		const hint = mapErrorHint(code, "");
		assert.ok(hint.length > 8, `${code} 的提示太短：${hint}`);
	}
	assert.match(mapErrorHint(700429, ""), /QPS|频率|重试/);
	assert.match(mapErrorHint(10412, ""), /额度/);
	assert.match(mapErrorHint(10410, ""), /套餐/);
	assert.match(mapErrorHint("invalid_api_key", "invalid api key"), /API Key/); // 2026-09-30 真机回包的字符串错误码
});
