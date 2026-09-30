// 官方「上传本地文件获取临时 URL」链路 + 上传结果缓存
//
// 事实依据（阿里云百炼文档 + 2026-09-28 实测）：
//   - GET  https://dashscope.aliyuncs.com/api/v1/uploads?action=getPolicy&model=<model>
//     → data{upload_dir, upload_host, oss_access_key_id, signature, policy,
//            x_oss_object_acl, x_oss_forbid_overwrite, max_file_size_mb, expire_in_seconds}
//   - multipart POST 到 upload_host（字段见下），返回 oss://<upload_dir>/<name>
//   - 文件绑定模型与主账号、有效期 48h、单文件 ≤1GB、凭证接口 100QPS
//   - 调用侧必须带请求头 X-DashScope-OssResourceResolve: enable
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, openAsBlob, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";

import { mimeForPath } from "./media.ts";

export const UPLOAD_API_URL = "https://dashscope.aliyuncs.com/api/v1/uploads";
/** 官方 48 小时；留 1 小时余量，避免边界上刚好过期 */
export const UPLOAD_URL_TTL_MS = 47 * 3600 * 1000;

export interface UploadPolicy {
	upload_dir: string;
	upload_host: string;
	oss_access_key_id: string;
	signature: string;
	policy: string;
	x_oss_object_acl: string;
	x_oss_forbid_overwrite: string;
	max_file_size_mb?: string;
	expire_in_seconds?: string;
}

export interface UploadCacheEntry {
	path: string;
	bytes: number;
	mtimeMs: number;
	model: string;
	url: string;
	createdAt: number;
}

export interface UploadCache {
	version: 1;
	entries: Record<string, UploadCacheEntry>;
}

export function emptyCache(): UploadCache {
	return { version: 1, entries: {} };
}

export interface CacheKeyParts {
	path: string;
	bytes: number;
	mtimeMs: number;
	model: string;
}

/** 用「路径 + 体积 + mtime + 模型」做键：不读文件内容，大文件也能秒判 */
export function uploadCacheKey(parts: CacheKeyParts): string {
	const material = [parts.path, parts.bytes, parts.mtimeMs, parts.model].join("\u0000");
	return createHash("sha256").update(material, "utf8").digest("hex");
}

export function lookupUpload(cache: UploadCache, key: string, now: number): string | undefined {
	const entry = cache.entries[key];
	if (!entry) return undefined;
	// 时间回拨（age < 0）时依然认为新鲜：URL 至多和上传那一刻一样老
	return now - entry.createdAt < UPLOAD_URL_TTL_MS ? entry.url : undefined;
}

export function pruneCache(cache: UploadCache, now: number): UploadCache {
	const entries: Record<string, UploadCacheEntry> = {};
	for (const [key, entry] of Object.entries(cache.entries)) {
		if (now - entry.createdAt < UPLOAD_URL_TTL_MS) entries[key] = entry;
	}
	return { version: 1, entries };
}

export function readCacheSync(file: string): UploadCache {
	try {
		const parsed = JSON.parse(readFileSync(file, "utf8"));
		if (parsed?.version === 1 && parsed.entries && typeof parsed.entries === "object") {
			return { version: 1, entries: parsed.entries };
		}
	} catch {
		/* 首次运行或文件损坏都退化成空缓存 */
	}
	return emptyCache();
}

export function writeCacheSync(file: string, cache: UploadCache, now: number): void {
	const pruned = pruneCache(cache, now);
	mkdirSync(dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(pruned, null, 2)}\n`, "utf8");
	renameSync(tmp, file);
}

/** 文件名清洗：保留中文与常见可读字符，替换会破坏 URL / OSS key 的字符 */
export function sanitizeFileName(name: string): string {
	const base = basename(name.replace(/\\/g, "/"));
	const rawExt = extname(base);
	const cleanExt = /^\.[A-Za-z0-9]{1,15}$/.test(rawExt) ? rawExt.toLowerCase() : "";
	const stem = cleanExt ? base.slice(0, base.length - rawExt.length) : base;
	const cleanStem = stem
		.replace(/[\/\\:*?"<>|#%&\s\u0000-\u001f]+/g, "_")
		.replace(/^\.+/, "")
		.slice(0, 100);
	if (!cleanStem) return `upload${cleanExt || ".mp4"}`;
	return `${cleanStem}${cleanExt}`;
}

export function ossKeyFor(policy: Pick<UploadPolicy, "upload_dir">, filePath: string): string {
	return `${policy.upload_dir}/${sanitizeFileName(filePath)}`;
}

function describeError(status: number, bodyText: string, what: string): string {
	let detail = bodyText.slice(0, 400);
	try {
		const parsed = JSON.parse(bodyText);
		const err = parsed?.error ?? parsed;
		if (err?.code || err?.message) detail = `${err.code ? `[${err.code}] ` : ""}${err.message ?? ""}`;
	} catch {
		/* 保留原文 */
	}
	return `${what}失败（HTTP ${status}）：${detail}`;
}

export async function getUploadPolicy(options: {
	apiKey: string;
	model: string;
	signal?: AbortSignal;
	apiUrl?: string;
}): Promise<UploadPolicy> {
	const apiUrl = options.apiUrl ?? UPLOAD_API_URL;
	const url = `${apiUrl}?action=getPolicy&model=${encodeURIComponent(options.model)}`;
	let response: Response;
	try {
		response = await fetch(url, {
			headers: { Authorization: `Bearer ${options.apiKey}`, "Content-Type": "application/json" },
			signal: options.signal,
		});
	} catch (error: any) {
		throw new Error(`获取上传凭证失败：${error?.message ?? String(error)}`);
	}
	const text = await response.text();
	if (!response.ok) {
		if (response.status === 401 || response.status === 403) {
			throw new Error(`获取上传凭证鉴权失败（HTTP ${response.status}）：请检查 DASHSCOPE_API_KEY。${text.slice(0, 300)}`);
		}
		throw new Error(describeError(response.status, text, "获取上传凭证"));
	}
	let data: any;
	try {
		data = JSON.parse(text).data;
	} catch {
		throw new Error(`获取上传凭证返回了非 JSON 内容：${text.slice(0, 200)}`);
	}
	if (!data?.upload_dir || !data?.upload_host) {
		throw new Error(`上传凭证缺少 upload_dir/upload_host 字段：${JSON.stringify(data).slice(0, 200)}`);
	}
	return data as UploadPolicy;
}

/** 流式上传（openAsBlob，不把整文件读进内存），返回 oss:// 临时 URL */
export async function uploadToOss(options: {
	policy: UploadPolicy;
	filePath: string;
	signal?: AbortSignal;
}): Promise<string> {
	const { policy, filePath } = options;
	if (!existsSync(filePath)) throw new Error(`上传前找不到文件：${filePath}`);

	const key = ossKeyFor(policy, filePath);
	const form = new FormData();
	form.append("OSSAccessKeyId", policy.oss_access_key_id);
	form.append("Signature", policy.signature);
	form.append("policy", policy.policy);
	form.append("x-oss-object-acl", policy.x_oss_object_acl);
	form.append("x-oss-forbid-overwrite", policy.x_oss_forbid_overwrite);
	form.append("key", key);
	form.append("success_action_status", "200");
	form.append("file", await openAsBlob(filePath, { type: mimeForPath(filePath) }), basename(key));

	let response: Response;
	try {
		response = await fetch(policy.upload_host, { method: "POST", body: form, signal: options.signal });
	} catch (error: any) {
		throw new Error(`上传到百炼临时存储失败：${error?.message ?? String(error)}`);
	}
	if (!response.ok) {
		const text = await response.text().catch(() => "");
		throw new Error(describeError(response.status, text, "上传到百炼临时存储"));
	}
	return `oss://${key}`;
}

/** 上传 + 缓存：命中缓存直接复用 48h 内的 oss:// URL，避免重复上传大文件 */
export async function uploadWithCache(options: {
	apiKey: string;
	model: string;
	path: string;
	bytes: number;
	mtimeMs: number;
	cacheFile: string;
	signal?: AbortSignal;
	now?: number;
}): Promise<{ url: string; cached: boolean }> {
	const now = options.now ?? Date.now();
	const key = uploadCacheKey(options);
	const cache = readCacheSync(options.cacheFile);
	const hit = lookupUpload(cache, key, now);
	if (hit) return { url: hit, cached: true };

	const policy = await getUploadPolicy({ apiKey: options.apiKey, model: options.model, signal: options.signal });
	const maxMb = Number(policy.max_file_size_mb);
	if (Number.isFinite(maxMb) && maxMb > 0 && options.bytes > maxMb * 1024 * 1024) {
		throw new Error(
			`文件 ${(options.bytes / 1024 / 1024).toFixed(0)}MB 超过模型 ${maxMb}MB 的上传上限，请先压缩或切分。`,
		);
	}
	const url = await uploadToOss({ policy, filePath: options.path, signal: options.signal });
	cache.entries[key] = {
		path: options.path,
		bytes: options.bytes,
		mtimeMs: options.mtimeMs,
		model: options.model,
		url,
		createdAt: now,
	};
	try {
		writeCacheSync(options.cacheFile, cache, now);
	} catch {
		/* 缓存写不进去不影响主流程 */
	}
	return { url, cached: false };
}

export function defaultCacheFile(agentDir: string): string {
	return join(agentDir, "cache", "video-read", "uploads.json");
}
