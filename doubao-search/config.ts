// 配置：默认值 + 可选配置文件 <agentDir>/doubao-search.json。
// 密钥只从环境变量 DOUBAO_SEARCH_API_KEY 读，配置文件里不放密钥（与 video-read 同一约定）。
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { CONTENT_FORMAT_VALUES, COUNT_RANGE, WEB_SEARCH_URL, type ContentFormat } from "./search.ts";

export const API_KEY_ENV = "DOUBAO_SEARCH_API_KEY";

export interface DoubaoSearchConfig {
	apiUrl: string;
	timeoutSec: number;
	/** 是否默认把正文（Content）交给模型 */
	includeContent: boolean;
	contentFormat: ContentFormat;
	/** 未显式给 count 时的默认条数（会按 searchType 夹紧）；未配置则用官方默认 10/5 */
	count?: number;
}

export interface NormalizeContext {
	agentDir: string;
	env: NodeJS.ProcessEnv;
}

const MIN_TIMEOUT_SEC = 10;
const MAX_TIMEOUT_SEC = 600;

export const DEFAULT_CONFIG: DoubaoSearchConfig = {
	apiUrl: WEB_SEARCH_URL,
	timeoutSec: 60,
	includeContent: false,
	contentFormat: "text",
	count: undefined,
};

export function agentDir(env: NodeJS.ProcessEnv = process.env): string {
	const override = env.PI_CODING_AGENT_DIR?.trim();
	return override && override.length > 0 ? override : join(homedir(), ".pi", "agent");
}

export function configFilePath(ctx: { agentDir: string }): string {
	return join(ctx.agentDir, "doubao-search.json");
}

/** 密钥只认环境变量；空白视为未配置 */
export function apiKeyFrom(env: NodeJS.ProcessEnv = process.env): string | undefined {
	const value = env[API_KEY_ENV]?.trim();
	return value ? value : undefined;
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asBool(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

export function normalizeConfig(raw: unknown, _ctx: NormalizeContext): { config: DoubaoSearchConfig; warnings: string[] } {
	const warnings: string[] = [];
	const source = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
	const config: DoubaoSearchConfig = { ...DEFAULT_CONFIG };

	const apiUrl = asString(source.apiUrl);
	if (apiUrl) {
		if (/^https?:\/\//i.test(apiUrl)) config.apiUrl = apiUrl;
		else warnings.push(`apiUrl 必须是 http(s) 地址，已用默认值 ${config.apiUrl}`);
	} else if (source.apiUrl !== undefined) {
		warnings.push(`apiUrl 不是非空字符串，已用默认值 ${config.apiUrl}`);
	}

	const timeoutSec = source.timeoutSec;
	if (timeoutSec !== undefined) {
		if (typeof timeoutSec === "number" && Number.isFinite(timeoutSec) && timeoutSec >= MIN_TIMEOUT_SEC && timeoutSec <= MAX_TIMEOUT_SEC) {
			config.timeoutSec = Math.round(timeoutSec);
		} else {
			warnings.push(`timeoutSec=${String(timeoutSec)} 超出 [${MIN_TIMEOUT_SEC}, ${MAX_TIMEOUT_SEC}]，已用默认值 ${config.timeoutSec}`);
		}
	}

	const includeContent = asBool(source.includeContent);
	if (includeContent !== undefined) config.includeContent = includeContent;
	else if (source.includeContent !== undefined) warnings.push(`includeContent 不是布尔值，已用默认值 ${config.includeContent}`);

	const contentFormat = asString(source.contentFormat) as ContentFormat | undefined;
	if (contentFormat && (CONTENT_FORMAT_VALUES as readonly string[]).includes(contentFormat)) config.contentFormat = contentFormat;
	else if (source.contentFormat !== undefined) {
		warnings.push(`contentFormat=${String(source.contentFormat)} 不是 ${CONTENT_FORMAT_VALUES.join("/")}，已用默认值 ${config.contentFormat}`);
	}

	const count = source.count;
	if (count !== undefined) {
		const max = Math.max(COUNT_RANGE.web.max, COUNT_RANGE.image.max);
		if (typeof count === "number" && Number.isFinite(count) && Math.round(count) >= COUNT_RANGE.web.min && Math.round(count) <= max) {
			config.count = Math.round(count);
		} else {
			warnings.push(`count=${String(count)} 超出 [${COUNT_RANGE.web.min}, ${max}]，已改用官方默认条数（web 10 / image 5）`);
		}
	}

	return { config, warnings };
}

export function loadConfig(ctx?: Partial<NormalizeContext>): { config: DoubaoSearchConfig; warnings: string[] } {
	const env = ctx?.env ?? process.env;
	const resolved: NormalizeContext = { agentDir: ctx?.agentDir ?? agentDir(env), env };
	const file = configFilePath(resolved);
	if (!existsSync(file)) return normalizeConfig({}, resolved);
	try {
		return normalizeConfig(JSON.parse(readFileSync(file, "utf8")), resolved);
	} catch (error: any) {
		return {
			...normalizeConfig({}, resolved),
			warnings: [`配置文件 ${file} 解析失败，已忽略：${error?.message ?? String(error)}`],
		};
	}
}
