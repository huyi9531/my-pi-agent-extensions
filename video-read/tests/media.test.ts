// media.ts 的测试：输入分流、上限判定、ffprobe 解析
// 期望值来源：阿里云百炼文档（限额）+ 真实 ffprobe 回包夹具（tests/fixtures/ffprobe-sample.json）
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { test } from "node:test";

import {
	BASE64_MAX_BYTES,
	UPLOAD_MAX_BYTES,
	chooseTransport,
	formatBytes,
	isRemoteSource,
	parseFfprobeJson,
	parseFrameRate,
	validateDuration,
	validateExtension,
} from "../media.ts";

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

test("isRemoteSource 认得 http/https/oss/data，本地路径不算", () => {
	for (const remote of [
		"https://example.com/a.mp4",
		"http://example.com/a.mp4",
		"oss://dashscope-instant/x/y/a.mp4",
		"data:;base64,AAAA",
	]) {
		assert.equal(isRemoteSource(remote), true, remote);
	}
	for (const local of ["./a.mp4", "/tmp/a.mp4", "D:\\videos\\a.mp4", "a.mp4", "C:/videos/a.mp4"]) {
		assert.equal(isRemoteSource(local), false, local);
	}
});

test("chooseTransport：base64 字符串 <10MB 是硬上限，raw 必须 < 7.5MB", () => {
	// 文档：base64 编码后的字符串必须小于 10MB → raw × 4/3 < 10MB → raw < 7.86MB，留余量取 7.5MB
	assert.equal(chooseTransport(1 * 1024 * 1024), "base64");
	assert.equal(chooseTransport(7 * 1024 * 1024), "base64");
	assert.equal(chooseTransport(BASE64_MAX_BYTES), "base64"); // 边界：恰好 7.5MB 仍走 base64
	assert.equal(chooseTransport(BASE64_MAX_BYTES + 1), "upload");
	assert.equal(chooseTransport(200 * 1024 * 1024), "upload");
	assert.equal(chooseTransport(UPLOAD_MAX_BYTES), "upload"); // 1GB 边界内仍可上传
});

test("上限常量与百炼文档一致", () => {
	assert.equal(BASE64_MAX_BYTES, 7.5 * 1024 * 1024);
	assert.equal(UPLOAD_MAX_BYTES, 1024 * 1024 * 1024); // 上传接口 ≤1GB
});

test("validateExtension 只放行文档列出的视频容器，大小写不敏感", () => {
	for (const ok of ["a.mp4", "a.MOV", "/x/y/a.mkv", "a.webm", "a.flv", "a.wmv", "a.avi", "a.m4v"]) {
		assert.equal(validateExtension(ok), undefined, ok);
	}
	const err = validateExtension("a.txt");
	assert.ok(err && err.includes("mp4"), `错误信息要给出可用格式: ${err}`);
	assert.ok(validateExtension("noext")?.includes("扩展名"));
});

test("validateDuration 卡 2 秒 ~ 2 小时（文档区间）", () => {
	assert.equal(validateDuration(60), undefined);
	assert.equal(validateDuration(2), undefined);
	assert.equal(validateDuration(7200), undefined);
	assert.ok(validateDuration(1.5)?.includes("2 秒"));
	assert.ok(validateDuration(7201)?.includes("2 小时"));
	assert.equal(validateDuration(undefined), undefined); // 拿不到时长就不拦
});

test("formatBytes 人类可读", () => {
	assert.equal(formatBytes(512), "512 B");
	assert.equal(formatBytes(1024), "1.0 KB");
	assert.equal(formatBytes(1536), "1.5 KB");
	assert.equal(formatBytes(1146698), "1.1 MB");
	assert.equal(formatBytes(1024 * 1024 * 1024), "1.0 GB");
});

test("parseFrameRate 处理分数字符串", () => {
	assert.equal(parseFrameRate("30/1"), 30);
	assert.equal(parseFrameRate("30000/1001"), 29.97);
	assert.equal(parseFrameRate("0/0"), undefined);
	assert.equal(parseFrameRate(undefined), undefined);
	assert.equal(parseFrameRate("abc"), undefined);
});

test("parseFfprobeJson 解析真实回包（tests/fixtures/ffprobe-sample.json）", () => {
	const raw = readFileSync(join(fixtureDir, "ffprobe-sample.json"), "utf8");
	const info = parseFfprobeJson(raw);
	assert.ok(info);
	assert.equal(info.width, 1280);
	assert.equal(info.height, 720);
	assert.equal(info.durationSec, 8.166341); // 夹具真值
	assert.equal(info.fps, 30); // r_frame_rate=30/1
	assert.equal(info.hasAudio, true);
	assert.equal(info.sizeBytes, 1146698);
});

test("parseFfprobeJson 对坏输入返回 undefined 而不是抛错", () => {
	assert.equal(parseFfprobeJson("not json"), undefined);
	assert.equal(parseFfprobeJson("{}"), undefined); // 没有 video 流
});
