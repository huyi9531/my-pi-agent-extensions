// config.ts 的测试：默认值、非法值降级（带告警）、档位预设
import assert from "node:assert/strict";
import { test } from "node:test";

import { DETAIL_PRESETS, DEFAULT_CONFIG, MAX_PIXELS_RANGE, agentDir, normalizeConfig, presetFor } from "../config.ts";

const ctx = { agentDir: "C:/agent", env: { DASHSCOPE_API_KEY: "sk-test" } } as any;

test("默认配置：模型与上限对齐文档", () => {
	assert.equal(DEFAULT_CONFIG.model, "qwen3.8-omni-flash");
	assert.equal(DEFAULT_CONFIG.reasoningEffort, "low"); // 文档默认 xhigh，太贵太慢，这里主动降档
	assert.equal(DEFAULT_CONFIG.detail, "standard");
	assert.equal(DEFAULT_CONFIG.maxVideosPerCall, 64); // 文档：单请求最多 64 个视频
	assert.equal(DEFAULT_CONFIG.maxTokens, 8000);
	assert.ok(DEFAULT_CONFIG.baseUrl.startsWith("https://dashscope.aliyuncs.com"));
	assert.ok(DEFAULT_CONFIG.cacheFile.replace(/\\/g, "/").endsWith("cache/video-read/uploads.json"));
});

test("缓存文件落在 agentDir 下", () => {
	const { config } = normalizeConfig({}, ctx);
	assert.equal(config.cacheFile.replace(/\\/g, "/"), "C:/agent/cache/video-read/uploads.json");
});

test("agentDir 支持 PI_CODING_AGENT_DIR 覆盖", () => {
	assert.equal(agentDir({ PI_CODING_AGENT_DIR: "D:/pi-agent" } as any), "D:/pi-agent");
	assert.ok(agentDir({} as any).replace(/\\/g, "/").endsWith("/.pi/agent"));
});

test("档位预设：quick/standard/fine 对应文档推荐的像素与抽帧", () => {
	assert.deepEqual(Object.keys(DETAIL_PRESETS), ["quick", "standard", "fine"]);
	assert.equal(presetFor("quick").maxPixels, 230400); // 文档「快速审核」推荐值
	assert.equal(presetFor("standard").maxPixels, 921600);
	assert.equal(presetFor("fine").maxPixels, 2048000);
	assert.equal(presetFor("quick").fps, 0.5);
	assert.equal(presetFor("standard").fps, 1);
	assert.equal(presetFor("fine").fps, 2);
	for (const p of Object.values(DETAIL_PRESETS)) assert.ok(p.prompt.length > 20, "每档都要有可用提示词");
});

test("每个档位预设都必须在接口硬限制内（曾把 fine 写成 2073600 被接口 400 抦下）", () => {
	for (const [name, preset] of Object.entries(DETAIL_PRESETS)) {
		assert.ok(
			preset.maxPixels >= MAX_PIXELS_RANGE.min && preset.maxPixels <= MAX_PIXELS_RANGE.max,
			`${name} 的 maxPixels=${preset.maxPixels} 超出接口区间 [${MAX_PIXELS_RANGE.min}, ${MAX_PIXELS_RANGE.max}]`,
		);
		assert.ok(preset.fps >= 0.1 && preset.fps <= 10, `${name} 的 fps=${preset.fps} 超出 [0.1, 10]`);
	}
});

test("normalizeConfig：合法值原样生效", () => {
	const { config, warnings } = normalizeConfig(
		{
			model: "qwen3.8-omni-flash",
			reasoningEffort: "medium",
			detail: "fine",
			fps: 3,
			maxPixels: 1048576,
			maxTokens: 12000,
			timeoutSec: 1200,
			maxVideos: 4,
		},
		ctx,
	);
	assert.deepEqual(warnings, []);
	assert.equal(config.reasoningEffort, "medium");
	assert.equal(config.detail, "fine");
	assert.equal(config.fps, 3);
	assert.equal(config.maxPixels, 1048576);
	assert.equal(config.maxTokens, 12000);
	assert.equal(config.timeoutSec, 1200);
	assert.equal(config.maxVideosPerCall, 4);
});

test("normalizeConfig：非法值降级并留下告警，不静默吞掉", () => {
	const { config, warnings } = normalizeConfig(
		{
			model: "",
			reasoningEffort: "turbo",
			detail: "ultra",
			fps: 99,
			maxPixels: -5,
			maxTokens: 10 ** 9,
			timeoutSec: 1,
			maxVideos: 999,
			baseUrl: "not-a-url",
		},
		ctx,
	);
	assert.equal(config.model, DEFAULT_CONFIG.model);
	assert.equal(config.reasoningEffort, DEFAULT_CONFIG.reasoningEffort);
	assert.equal(config.detail, DEFAULT_CONFIG.detail);
	assert.equal(config.fps, undefined, "非法 fps 应退回档位预设而不是瞎夹取");
	assert.equal(config.maxPixels, undefined);
	assert.equal(config.maxTokens, DEFAULT_CONFIG.maxTokens);
	assert.equal(config.timeoutSec, DEFAULT_CONFIG.timeoutSec);
	assert.equal(config.maxVideosPerCall, DEFAULT_CONFIG.maxVideosPerCall);
	assert.ok(config.baseUrl.startsWith("https://dashscope."));
	for (const key of ["model", "reasoningEffort", "detail", "fps", "maxPixels", "maxTokens", "timeoutSec", "maxVideos", "baseUrl"]) {
		assert.ok(
			warnings.some((w) => w.includes(key)),
			`缺少关于 ${key} 的告警：${JSON.stringify(warnings)}`,
		);
	}
});

test("normalizeConfig：DASHSCOPE_BASE_URL 环境变量作为 baseUrl 兜底", () => {
	const { config } = normalizeConfig({}, { agentDir: "C:/agent", env: { DASHSCOPE_BASE_URL: "https://x.example/v1/" } as any });
	assert.equal(config.baseUrl, "https://x.example/v1");
});
