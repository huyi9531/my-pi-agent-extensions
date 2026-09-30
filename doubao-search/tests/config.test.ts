// config.ts 的测试：默认值、配置文件读入与降级告警、密钥只从环境变量读。
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { API_KEY_ENV, DEFAULT_CONFIG, agentDir, apiKeyFrom, configFilePath, loadConfig, normalizeConfig } from "../config.ts";
import { WEB_SEARCH_URL } from "../search.ts";

const ctx = { agentDir: "C:/agent", env: {} as NodeJS.ProcessEnv };

test("默认配置：端点固定为 Custom 版、60 秒超时、默认不把正文塞进上下文", () => {
	assert.equal(DEFAULT_CONFIG.apiUrl, WEB_SEARCH_URL);
	assert.equal(DEFAULT_CONFIG.timeoutSec, 60);
	assert.equal(DEFAULT_CONFIG.includeContent, false);
	assert.equal(DEFAULT_CONFIG.contentFormat, "text");
	assert.equal(DEFAULT_CONFIG.count, undefined); // 不覆盖则由 searchType 档位决定（web 10 / image 5）
});

test("密钥只从环境变量读：DOUBAO_SEARCH_API_KEY", () => {
	assert.equal(API_KEY_ENV, "DOUBAO_SEARCH_API_KEY");
	assert.equal(apiKeyFrom({ [API_KEY_ENV]: "  sk-abc  " } as any), "sk-abc");
	assert.equal(apiKeyFrom({ [API_KEY_ENV]: "   " } as any), undefined);
	assert.equal(apiKeyFrom({} as any), undefined);
});

test("配置文件路径落在 agentDir 下，支持 PI_CODING_AGENT_DIR 覆盖", () => {
	assert.equal(configFilePath({ agentDir: "C:/agent" }).replace(/\\/g, "/"), "C:/agent/doubao-search.json");
	assert.equal(agentDir({ PI_CODING_AGENT_DIR: "D:/pi-agent" } as any), "D:/pi-agent");
	assert.ok(agentDir({} as any).replace(/\\/g, "/").endsWith("/.pi/agent"));
});

test("normalizeConfig：合法配置原样生效", () => {
	const { config, warnings } = normalizeConfig(
		{ apiUrl: "https://example.com/search", timeoutSec: 120, includeContent: true, contentFormat: "markdown", count: 20 },
		ctx,
	);
	assert.equal(config.apiUrl, "https://example.com/search");
	assert.equal(config.timeoutSec, 120);
	assert.equal(config.includeContent, true);
	assert.equal(config.contentFormat, "markdown");
	assert.equal(config.count, 20);
	assert.deepEqual(warnings, []);
});

test("normalizeConfig：非法值降级到默认并逐条告警，不静默吞掉", () => {
	const { config, warnings } = normalizeConfig(
		{
			apiUrl: "ftp://x",
			timeoutSec: 5,
			includeContent: "yes",
			contentFormat: "html",
			count: 999,
		},
		ctx,
	);
	assert.equal(config.apiUrl, DEFAULT_CONFIG.apiUrl);
	assert.equal(config.timeoutSec, DEFAULT_CONFIG.timeoutSec);
	assert.equal(config.includeContent, DEFAULT_CONFIG.includeContent);
	assert.equal(config.contentFormat, DEFAULT_CONFIG.contentFormat);
	assert.equal(config.count, undefined);
	assert.equal(warnings.length, 5, `告警条数不对：${warnings.join(" | ")}`);
	for (const key of ["apiUrl", "timeoutSec", "includeContent", "contentFormat", "count"]) {
		assert.ok(warnings.some((w) => w.includes(key)), `缺少 ${key} 的告警`);
	}
});

test("loadConfig：配置文件不存在时用默认值且无告警", () => {
	const dir = mkdtempSync(join(tmpdir(), "doubao-search-cfg-"));
	const { config, warnings } = loadConfig({ agentDir: dir, env: {} as any });
	assert.equal(config.apiUrl, WEB_SEARCH_URL);
	assert.deepEqual(warnings, []);
});

test("loadConfig：配置文件损坏 → 默认值 + 告警（而不是崩掉整个扩展）", () => {
	const dir = mkdtempSync(join(tmpdir(), "doubao-search-cfg-"));
	writeFileSync(join(dir, "doubao-search.json"), "{ 这不是 JSON", "utf8");
	const { config, warnings } = loadConfig({ agentDir: dir, env: {} as any });
	assert.equal(config.apiUrl, WEB_SEARCH_URL);
	assert.equal(warnings.length, 1);
	assert.match(warnings[0], /解析失败/);
});

test("loadConfig：正常读入配置文件的覆盖项", () => {
	const dir = mkdtempSync(join(tmpdir(), "doubao-search-cfg-"));
	writeFileSync(join(dir, "doubao-search.json"), JSON.stringify({ timeoutSec: 90, includeContent: true }), "utf8");
	const { config, warnings } = loadConfig({ agentDir: dir, env: {} as any });
	assert.equal(config.timeoutSec, 90);
	assert.equal(config.includeContent, true);
	assert.deepEqual(warnings, []);
});
