// uploads.ts 的测试：上传 URL 缓存（key/新鲜度/清理）与 OSS 对象名清洗
// 期望值来源：官方「上传本地文件获取临时 URL」文档（48h 有效期、upload_dir 前缀、key 规则）
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
	UPLOAD_URL_TTL_MS,
	emptyCache,
	lookupUpload,
	ossKeyFor,
	pruneCache,
	readCacheSync,
	sanitizeFileName,
	uploadCacheKey,
	writeCacheSync,
} from "../uploads.ts";

const base = { path: "D:/videos/a.mp4", bytes: 16_000_000, mtimeMs: 1_700_000_000_000, model: "qwen3.8-omni-flash" };

test("缓存的 URL 寿命按官方 48h 打折到 47h", () => {
	assert.equal(UPLOAD_URL_TTL_MS, 47 * 3600 * 1000);
});

test("uploadCacheKey：任一分量变化都会换 key", () => {
	const key = uploadCacheKey(base);
	assert.equal(key, uploadCacheKey({ ...base }));
	assert.equal(key.length, 64); // sha256 hex
	for (const patch of [
		{ path: "D:/videos/b.mp4" },
		{ bytes: 16_000_001 },
		{ mtimeMs: base.mtimeMs + 1 },
		{ model: "qwen3.8-omni-flash-x" },
	]) {
		assert.notEqual(key, uploadCacheKey({ ...base, ...patch }), JSON.stringify(patch));
	}
});

test("lookupUpload：只有新鲜条目才复用 URL", () => {
	const key = uploadCacheKey(base);
	const now = 1_800_000_000_000;
	const created = now - 1000;
	const cache = { version: 1 as const, entries: { [key]: { ...base, url: "oss://x/y.mp4", createdAt: created } } };
	assert.equal(lookupUpload(cache, key, now), "oss://x/y.mp4");
	// 距到期还差 1 秒 → 仍可用
	assert.equal(lookupUpload(cache, key, created + UPLOAD_URL_TTL_MS - 1000), "oss://x/y.mp4");

	// 正好到点 → 失效（边界）
	assert.equal(lookupUpload(cache, key, created + UPLOAD_URL_TTL_MS), undefined);
	assert.equal(lookupUpload(cache, "不存在的 key", now), undefined);
	assert.equal(lookupUpload(emptyCache(), key, now), undefined);
});

test("lookupUpload：系统时间回拨（createdAt 在未来）时仍认为新鲜", () => {
	const key = uploadCacheKey(base);
	const now = 1_800_000_000_000;
	const cache = { version: 1 as const, entries: { [key]: { ...base, url: "oss://x/y.mp4", createdAt: now + 60_000 } } };
	assert.equal(lookupUpload(cache, key, now), "oss://x/y.mp4");
});

test("pruneCache 丢掉过期条目，保留新鲜的", () => {
	const now = 1_800_000_000_000;
	const fresh = { ...base, url: "oss://fresh", createdAt: now - 1000 };
	const stale = { ...base, path: "D:/videos/old.mp4", url: "oss://stale", createdAt: now - UPLOAD_URL_TTL_MS - 1 };
	const cache = {
		version: 1 as const,
		entries: {
			[uploadCacheKey(base)]: fresh,
			[uploadCacheKey({ ...base, path: "D:/videos/old.mp4" })]: stale,
		},
	};
	const pruned = pruneCache(cache, now);
	assert.equal(Object.keys(pruned.entries).length, 1);
	assert.equal(Object.values(pruned.entries)[0].url, "oss://fresh");
	assert.equal(Object.keys(cache.entries).length, 2); // 不改原对象
});

test("sanitizeFileName 保留中文，清掉会破坏 URL/OSS key 的字符", () => {
	assert.equal(sanitizeFileName("a.mp4"), "a.mp4");
	assert.equal(sanitizeFileName("美食团购_wan3 v1.mp4"), "美食团购_wan3_v1.mp4");
	assert.equal(sanitizeFileName("a#b?c%20d.mp4"), "a_b_c_20d.mp4");
	assert.equal(sanitizeFileName("dir\\sub/file.mp4"), "file.mp4"); // 只取文件名部分
	assert.equal(sanitizeFileName("..."), "upload.mp4"); // 洗没了就兜个默认
	assert.ok(sanitizeFileName(`${"x".repeat(300)}.mp4`).length <= 124);
});

test("ossKeyFor 用上传凭证的 upload_dir 做前缀（文档要求 starts-with）", () => {
	const policy = { upload_dir: "dashscope-instant/abc/2026-09-28/uuid" } as any;
	const key = ossKeyFor(policy, "D:/videos/美食 团购.mp4");
	assert.equal(key, "dashscope-instant/abc/2026-09-28/uuid/美食_团购.mp4");
	assert.ok(key.startsWith(policy.upload_dir));
});

test("缓存的读写：文件缺失或损坏都退化成空缓存，不抛错", () => {
	const dir = mkdtempSync(join(tmpdir(), "vr-cache-"));
	const file = join(dir, "nested", "uploads.json");
	assert.deepEqual(readCacheSync(file), emptyCache());

	const key = uploadCacheKey(base);
	const now = Date.now();
	const cache = {
		version: 1 as const,
		entries: { [key]: { ...base, url: "oss://x/y.mp4", createdAt: now } },
	};
	writeCacheSync(file, cache, now);
	assert.equal(lookupUpload(readCacheSync(file), key, now), "oss://x/y.mp4");
	assert.ok(readFileSync(file, "utf8").includes("oss://x/y.mp4"));

	writeFileSync(file, "{ 这不是 JSON", "utf8");
	assert.deepEqual(readCacheSync(file), emptyCache());
});

test("写入时顺手清掉过期条目", () => {
	const dir = mkdtempSync(join(tmpdir(), "vr-cache-"));
	const file = join(dir, "uploads.json");
	const now = 1_800_000_000_000;
	const staleKey = uploadCacheKey({ ...base, path: "D:/old.mp4" });
	const cache = {
		version: 1 as const,
		entries: {
			[staleKey]: { ...base, path: "D:/old.mp4", url: "oss://stale", createdAt: now - UPLOAD_URL_TTL_MS - 1 },
		},
	};
	writeCacheSync(file, cache, now);
	assert.deepEqual(readCacheSync(file).entries, {});
});
