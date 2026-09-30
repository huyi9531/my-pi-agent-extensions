// 输入解析与本地媒体探测：路径/URL 判定、体积分流、ffprobe 元信息
//
// 限额来源（阿里云百炼文档，2026-09-28 核实）：
//   - base64 编码后的字符串必须 < 10MB  → raw 字节必须 < 7.5MB（留余量）
//   - 上传接口单文件 ≤ 1GB；公网 URL 输入模型侧 ≤ 2GB
//   - 时长 2 秒 ~ 2 小时；格式 MP4/AVI/MKV/MOV/FLV/WMV 等
import { execFile } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { extname, isAbsolute, resolve } from "node:path";

/** 本地文件走 base64 的 raw 字节上限（对应编码后 10MB） */
export const BASE64_MAX_BYTES = 7.5 * 1024 * 1024;
/** 官方临时上传接口单文件上限 */
export const UPLOAD_MAX_BYTES = 1024 * 1024 * 1024;
export const MAX_DURATION_SEC = 7200;
export const MIN_DURATION_SEC = 2;

const MIME_BY_EXT: Record<string, string> = {
	".mp4": "video/mp4",
	".m4v": "video/x-m4v",
	".mov": "video/quicktime",
	".mkv": "video/x-matroska",
	".webm": "video/webm",
	".flv": "video/x-flv",
	".wmv": "video/x-ms-wmv",
	".avi": "video/x-msvideo",
};

export type Transport = "base64" | "upload";

export interface MediaInfo {
	width?: number;
	height?: number;
	durationSec?: number;
	fps?: number;
	sizeBytes?: number;
	hasAudio?: boolean;
	formatName?: string;
}

export interface LocalFileStat {
	path: string;
	bytes: number;
	mtimeMs: number;
	ext: string;
}

/** 远程输入（模型自己去取）与本地文件的判定 */
export function isRemoteSource(input: string): boolean {
	const s = input.trim();
	return (
		/^https?:\/\//i.test(s) ||
		/^oss:\/\//i.test(s) ||
		/^data:/i.test(s)
	);
}

/** 把 source 参数（字符串或数组）规整成非空列表；空输入抛错 */
export function normalizeSources(source: string | string[] | undefined): string[] {
	const list = (Array.isArray(source) ? source : [source ?? ""])
		.map((s) => String(s ?? "").trim())
		.filter(Boolean);
	if (list.length === 0) throw new Error("source 为空：请给出视频文件路径或 URL。");
	return list;
}

/** 体积分流：≤7.5MB 内联省一次上传，超过则走官方临时上传 */
export function chooseTransport(bytes: number): Transport {
	return bytes <= BASE64_MAX_BYTES ? "base64" : "upload";
}

export function validateExtension(path: string): string | undefined {
	const ext = extname(path).toLowerCase();
	if (!ext) {
		return `无法从文件名判断格式：${path}。请给出带扩展名的视频文件（支持 ${Object.keys(MIME_BY_EXT).join(" / ")}）。`;
	}
	if (!(ext in MIME_BY_EXT)) {
		return `不支持的视频格式 ${ext}：${path}。支持 ${Object.keys(MIME_BY_EXT).join(" / ")}（百炼文档列出的容器格式）。`;
	}
	return undefined;
}

export function validateDuration(durationSec: number | undefined): string | undefined {
	if (durationSec === undefined || !Number.isFinite(durationSec)) return undefined;
	if (durationSec < MIN_DURATION_SEC) {
		return `视频时长 ${durationSec.toFixed(1)} 秒，短于模型要求的 2 秒下限。`;
	}
	if (durationSec > MAX_DURATION_SEC) {
		return `视频时长 ${(durationSec / 60).toFixed(1)} 分钟，超过模型 2 小时上限。请先切分再读。`;
	}
	return undefined;
}

export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	const units = ["KB", "MB", "GB"];
	let value = bytes / 1024;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit += 1;
	}
	return `${value.toFixed(1)} ${units[unit]}`;
}

/** "30/1" → 30；"30000/1001" → 29.97；0/0 或垃圾输入 → undefined */
export function parseFrameRate(value: string | undefined): number | undefined {
	if (!value) return undefined;
	const m = /^(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)$/.exec(value.trim());
	if (!m) return undefined;
	const num = Number(m[1]);
	const den = Number(m[2]);
	if (!den || !Number.isFinite(num) || !Number.isFinite(den)) return undefined;
	const fps = num / den;
	if (!Number.isFinite(fps) || fps <= 0) return undefined;
	return Math.round(fps * 100) / 100;
}

/** 解析 ffprobe -print_format json 的输出；拿不到视频流时返回 undefined（不抛错） */
export function parseFfprobeJson(raw: string): MediaInfo | undefined {
	let parsed: any;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return undefined;
	}
	const streams: any[] = Array.isArray(parsed?.streams) ? parsed.streams : [];
	const video = streams.find((s) => s?.codec_type === "video");
	if (!video) return undefined;
	const info: MediaInfo = {
		hasAudio: streams.some((s) => s?.codec_type === "audio"),
	};
	if (typeof video.width === "number") info.width = video.width;
	if (typeof video.height === "number") info.height = video.height;
	const fps = parseFrameRate(video.r_frame_rate) ?? parseFrameRate(video.avg_frame_rate);
	if (fps !== undefined) info.fps = fps;
	const duration = Number(parsed?.format?.duration);
	if (Number.isFinite(duration) && duration > 0) info.durationSec = duration;
	const size = Number(parsed?.format?.size);
	if (Number.isFinite(size) && size > 0) info.sizeBytes = size;
	if (typeof parsed?.format?.format_name === "string") info.formatName = parsed.format.format_name;
	return info;
}

export function mimeForPath(path: string): string {
	return MIME_BY_EXT[extname(path).toLowerCase()] ?? "application/octet-stream";
}

export function resolveLocalPath(input: string, cwd: string): string {
	const trimmed = input.trim();
	return isAbsolute(trimmed) ? trimmed : resolve(cwd, trimmed);
}

/** stat + 扩展名检查；失败抛出可读中文错误 */
export function statLocalFile(path: string): LocalFileStat {
	let stat;
	try {
		stat = statSync(path);
	} catch {
		throw new Error(`找不到文件：${path}`);
	}
	if (!stat.isFile()) throw new Error(`不是文件：${path}`);
	const extError = validateExtension(path);
	if (extError) throw new Error(extError);
	return { path, bytes: stat.size, mtimeMs: stat.mtimeMs, ext: extname(path).toLowerCase() };
}

/** 读本地文件并编码为 data URI（仅用于 ≤7.5MB 的快路径） */
export function buildDataUri(path: string): string {
	const bytes = readFileSync(path);
	return `data:${mimeForPath(path)};base64,${bytes.toString("base64")}`;
}

/** ffprobe 探测；任何失败（未安装 / 坏文件 / 超时）都返回 undefined，不阻塞主流程 */
export function probeMedia(path: string, timeoutMs = 20_000): Promise<MediaInfo | undefined> {
	return new Promise((resolvePromise) => {
		execFile(
			"ffprobe",
			["-v", "error", "-print_format", "json", "-show_format", "-show_streams", path],
			{ timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
			(error, stdout) => {
				if (error) {
					resolvePromise(undefined);
					return;
				}
				resolvePromise(parseFfprobeJson(stdout));
			},
		);
	});
}
