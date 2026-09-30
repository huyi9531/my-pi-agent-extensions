// 豆包搜索 Custom 版接口的纯逻辑层：请求体构造 / 响应解析 / 错误映射。
//
// 为什么是 Custom 版而不是 Global 版（2026-09-30 实测）：
//   用户给的 Key 是「订阅套餐」Key，打 Global 版端点（/search_api/global_search）一律返回
//   业务码 10409（The package mode does not support this SearchType）；官方错误码表写的是
//   「当前使用订阅套餐的 API Key 调用了非 Custom版web搜索」。Custom 版端点
//   /search_api/web_search 用同一个 Key 实测正常返回。
//
// 字段名与上限全部来自官方文档《豆包搜索 Custom版》（火山文档站是 JS 渲染，直接抓 HTML 只能拿到空壳；
// 可用其内部接口 `GET https://www.volcengine.com/api/doc/getDocDetail?LibraryCode=Networkedsearch&DocumentCode=Networkedsearch-2`
// 取 `Result.MDContent` 拿到 Markdown 正文）：
//   Query 1~100 字符、SearchType web|image、Count web≤50/image≤5、
//   Filter{NeedContent,NeedUrl,Sites≤20,BlockHosts≤5,AuthInfoLevel,Image*},
//   TimeRange、QueryControl.QueryRewrite、ContentFormats、Industry。
// 字段名必须 PascalCase：小写写法的实测回包是 10400 query or search type is empty。

export const WEB_SEARCH_URL = "https://open.feedcoopapi.com/search_api/web_search";

export type SearchType = "web" | "image";
export const SEARCH_TYPES = ["web", "image"] as const;

/** 官方上限：web 最多 50 条（默认 10），image 最多 5 条 */
export const COUNT_RANGE: Record<SearchType, { min: number; max: number; default: number }> = {
	web: { min: 1, max: 50, default: 10 },
	image: { min: 1, max: 5, default: 5 },
};

export const MAX_SITES = 20; // 文档：Sites 最多支持 20 个
export const MAX_BLOCK_HOSTS = 5; // 文档：BlockHosts 最多支持 5 个
export const QUERY_MAX_CHARS = 100; // 文档：Query 1~100 个字符（过长会截断）

export const TIME_RANGE_VALUES = ["OneDay", "OneWeek", "OneMonth", "OneYear"] as const;
export const INDUSTRY_VALUES = ["finance", "game", "health", "gov"] as const;
export const IMAGE_SHAPE_VALUES = ["横长方形", "竖长方形", "方形"] as const;
export const CONTENT_FORMAT_VALUES = ["text", "markdown"] as const;
export const AUTH_INFO_LEVELS = [0, 1] as const;

export type ContentFormat = (typeof CONTENT_FORMAT_VALUES)[number];
export type Industry = (typeof INDUSTRY_VALUES)[number];
export type ImageShape = (typeof IMAGE_SHAPE_VALUES)[number];

export interface SearchRequest {
	query: string;
	searchType?: SearchType;
	count?: number;
	timeRange?: string;
	sites?: string[];
	blockHosts?: string[];
	authInfoLevel?: 0 | 1;
	industry?: Industry;
	queryRewrite?: boolean;
	needUrl?: boolean;
	needContent?: boolean;
	contentFormat?: ContentFormat;
	imageShapes?: string[];
	imageWidthMin?: number;
	imageWidthMax?: number;
	imageHeightMin?: number;
	imageHeightMax?: number;
}

export interface BuildDefaults {
	/** 未显式给 count 时用它（仍按 searchType 夹紧）；未给则用官方默认条数 */
	count?: number;
	contentFormat?: ContentFormat;
}

export interface BuiltRequest {
	body: Record<string, unknown>;
	searchType: SearchType;
	/** 实际发给上游的条数 */
	count: number;
	warnings: string[];
}

const DATE_RANGE_RE = /^(\d{4})-(\d{2})-(\d{2})\.\.(\d{4})-(\d{2})-(\d{2})$/;

function toDateKey(y: string, m: string, d: string): number | undefined {
	const year = Number(y);
	const month = Number(m);
	const day = Number(d);
	if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
	const date = new Date(Date.UTC(year, month - 1, day));
	if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return undefined;
	return date.getTime();
}

export function isValidTimeRange(value: string): boolean {
	if ((TIME_RANGE_VALUES as readonly string[]).includes(value)) return true;
	const match = DATE_RANGE_RE.exec(value.trim());
	if (!match) return false;
	const from = toDateKey(match[1], match[2], match[3]);
	const to = toDateKey(match[4], match[5], match[6]);
	return from !== undefined && to !== undefined && from <= to;
}

/** 完整域名：不允许带协议/路径/端口/空格，至少两段（支持中文域名） */
export function isDomainLike(value: string): boolean {
	const host = value.trim();
	if (!host || /\s/.test(host)) return false;
	if (/[:/\\@]/.test(host)) return false;
	const labels = host.split(".");
	if (labels.length < 2) return false;
	return labels.every((label) => /^[\p{L}\p{N}]([\p{L}\p{N}-]*[\p{L}\p{N}])?$/u.test(label));
}

export function normalizeQuery(input: unknown): { query: string; warning?: string } {
	if (typeof input !== "string") throw new Error("Query 不能为空：请给出 1~100 字的搜索词。");
	const flat = input.replace(/\s+/g, " ").trim();
	if (!flat) throw new Error("Query 不能为空：请给出 1~100 字的搜索词。");
	if (flat.length <= QUERY_MAX_CHARS) return { query: flat };
	return {
		query: flat.slice(0, QUERY_MAX_CHARS),
		warning: `Query 超过 ${QUERY_MAX_CHARS} 字，已按官方行为截断到前 ${QUERY_MAX_CHARS} 字。`,
	};
}

function normalizeCount(value: unknown, searchType: SearchType, fallback: number, warnings: string[]): number {
	const range = COUNT_RANGE[searchType];
	if (value === undefined || value === null) {
		if (fallback >= range.min && fallback <= range.max) return Math.round(fallback);
		if (fallback !== undefined) {
			warnings.push(`配置里的 count=${fallback} 超出 ${searchType} 的 [${range.min}, ${range.max}]，已改用官方默认 ${range.default}。`);
		}
		return range.default;
	}
	if (typeof value !== "number" || !Number.isFinite(value)) {
		warnings.push(`Count=${String(value)} 不是数字，已改用官方默认 ${range.default}。`);
		return range.default;
	}
	const rounded = Math.round(value);
	if (rounded < range.min) {
		// ≤0 之类的无意义取值按官方惯例落回默认条数（官方对「传入值≤0」的处理就是使用默认值）
		warnings.push(`Count=${rounded} 小于 ${searchType} 的下限 ${range.min}，已改用官方默认 ${range.default}。`);
		return range.default;
	}
	if (rounded > range.max) {
		warnings.push(`Count=${rounded} 超过 ${searchType} 的上限 ${range.max}，已夹紧到 ${range.max}。`);
		return range.max;
	}
	return rounded;
}

const IMAGE_PIXEL_LABELS: Record<string, string> = {
	imageWidthMin: "图片宽度下限（ImageWidthMin）",
	imageWidthMax: "图片宽度上限（ImageWidthMax）",
	imageHeightMin: "图片高度下限（ImageHeightMin）",
	imageHeightMax: "图片高度上限（ImageHeightMax）",
};

function optionalPositiveInt(value: unknown, key: keyof typeof IMAGE_PIXEL_LABELS): number | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
		throw new Error(`${IMAGE_PIXEL_LABELS[key]} 必须是大于 0 的数字，收到 ${String(value)}。`);
	}
	return Math.round(value);
}

export function buildRequestBody(request: SearchRequest, defaults: BuildDefaults = {}): BuiltRequest {
	const warnings: string[] = [];
	const { query, warning } = normalizeQuery(request.query);
	if (warning) warnings.push(warning);

	const searchType = (request.searchType ?? "web") as SearchType;
	if (!(SEARCH_TYPES as readonly string[]).includes(searchType)) {
		throw new Error(`SearchType 只能是 web 或 image，收到 ${String(request.searchType)}。`);
	}

	const count = normalizeCount(request.count, searchType, defaults.count ?? COUNT_RANGE[searchType].default, warnings);

	const body: Record<string, unknown> = { Query: query, SearchType: searchType, Count: count };

	const isWeb = searchType === "web";
	if (isWeb) {
		const ignoredImage: string[] = [];
		for (const [label, value] of [
			["imageWidthMin", request.imageWidthMin],
			["imageWidthMax", request.imageWidthMax],
			["imageHeightMin", request.imageHeightMin],
			["imageHeightMax", request.imageHeightMax],
			["imageShapes", request.imageShapes],
		] as const) {
			if (value !== undefined) ignoredImage.push(label);
		}
		if (ignoredImage.length > 0) {
			warnings.push(`以下参数仅 image 生效，searchType=web 时已忽略：${ignoredImage.join(", ")}。`);
		}
	}
	if (!isWeb) {
		const ignored: string[] = [];
		for (const [label, value] of [
			["timeRange", request.timeRange],
			["sites", request.sites],
			["blockHosts", request.blockHosts],
			["authInfoLevel", request.authInfoLevel],
			["industry", request.industry],
			["needUrl", request.needUrl],
			["needContent", request.needContent],
		] as const) {
			if (value !== undefined) ignored.push(label);
		}
		if (ignored.length > 0) warnings.push(`以下参数仅 web 生效，searchType=image 时已忽略：${ignored.join(", ")}。`);
	}

	const filter: Record<string, unknown> = {};

	if (isWeb) {
		if (request.needUrl !== undefined) filter.NeedUrl = Boolean(request.needUrl);
		if (request.needContent !== undefined) filter.NeedContent = Boolean(request.needContent);

		if (request.sites !== undefined) {
			const sites = request.sites.map((s) => s.trim()).filter(Boolean);
			if (sites.length > MAX_SITES) throw new Error(`Sites 最多 ${MAX_SITES} 个，收到 ${sites.length} 个。`);
			const bad = sites.find((s) => !isDomainLike(s));
			if (bad) throw new Error(`Sites 必须是完整域名（不带协议/路径），收到「${bad}」。示例：gov.cn。`);
			if (sites.length > 0) filter.Sites = sites.join("|");
		}

		if (request.blockHosts !== undefined) {
			const hosts = request.blockHosts.map((s) => s.trim()).filter(Boolean);
			if (hosts.length > MAX_BLOCK_HOSTS) throw new Error(`BlockHosts 最多 ${MAX_BLOCK_HOSTS} 个，收到 ${hosts.length} 个。`);
			const bad = hosts.find((s) => !isDomainLike(s));
			if (bad) throw new Error(`BlockHosts 必须是完整域名（不带协议/路径），收到「${bad}」。示例：zhihu.com。`);
			if (hosts.length > 0) filter.BlockHosts = hosts.join("|");
		}

		if (request.authInfoLevel !== undefined) {
			if (!(AUTH_INFO_LEVELS as readonly number[]).includes(request.authInfoLevel)) {
				throw new Error(`AuthInfoLevel 只能是 0（不限制）或 1（仅非常权威），收到 ${String(request.authInfoLevel)}。`);
			}
			filter.AuthInfoLevel = request.authInfoLevel;
		}

		if (request.timeRange !== undefined) {
			const timeRange = request.timeRange.trim();
			if (!isValidTimeRange(timeRange)) {
				throw new Error(
					`TimeRange 只支持 OneDay / OneWeek / OneMonth / OneYear 或 2025-01-01..2025-12-31 形式的日期区间，收到「${request.timeRange}」。`,
				);
			}
			body.TimeRange = timeRange;
		}

		if (request.industry !== undefined) {
			if (!(INDUSTRY_VALUES as readonly string[]).includes(request.industry)) {
				throw new Error(`Industry 只能是 ${INDUSTRY_VALUES.join(" / ")}，收到「${String(request.industry)}」。`);
			}
			body.Industry = request.industry;
		}
	} else {
		const imageWidthMin = optionalPositiveInt(request.imageWidthMin, "imageWidthMin");
		const imageWidthMax = optionalPositiveInt(request.imageWidthMax, "imageWidthMax");
		const imageHeightMin = optionalPositiveInt(request.imageHeightMin, "imageHeightMin");
		const imageHeightMax = optionalPositiveInt(request.imageHeightMax, "imageHeightMax");
		if (imageWidthMin !== undefined && imageWidthMax !== undefined && imageWidthMin > imageWidthMax) {
			throw new Error(`图片宽度下限（ImageWidthMin=${imageWidthMin}）不能大于宽度上限（ImageWidthMax=${imageWidthMax}）。`);
		}
		if (imageHeightMin !== undefined && imageHeightMax !== undefined && imageHeightMin > imageHeightMax) {
			throw new Error(`图片高度下限（ImageHeightMin=${imageHeightMin}）不能大于高度上限（ImageHeightMax=${imageHeightMax}）。`);
		}
		if (imageWidthMin !== undefined) filter.ImageWidthMin = imageWidthMin;
		if (imageWidthMax !== undefined) filter.ImageWidthMax = imageWidthMax;
		if (imageHeightMin !== undefined) filter.ImageHeightMin = imageHeightMin;
		if (imageHeightMax !== undefined) filter.ImageHeightMax = imageHeightMax;

		if (request.imageShapes !== undefined) {
			const shapes = request.imageShapes.map((s) => s.trim()).filter(Boolean);
			const bad = shapes.find((s) => !(IMAGE_SHAPE_VALUES as readonly string[]).includes(s));
			if (bad) throw new Error(`ImageShapes 只支持 ${IMAGE_SHAPE_VALUES.join(" / ")}，收到「${bad}」。`);
			if (shapes.length > 0) filter.ImageShapes = shapes;
		}
	}

	if (Object.keys(filter).length > 0) body.Filter = filter;

	if (request.queryRewrite !== undefined) body.QueryControl = { QueryRewrite: Boolean(request.queryRewrite) };

	const contentFormat = request.contentFormat ?? defaults.contentFormat;
	if (contentFormat !== undefined) {
		if (!(CONTENT_FORMAT_VALUES as readonly string[]).includes(contentFormat)) {
			throw new Error(`ContentFormats 只能是 text 或 markdown，收到「${String(contentFormat)}」。`);
		}
		body.ContentFormats = contentFormat;
	}

	return { body, searchType, count, warnings };
}

// ---------------------------------------------------------------- 响应

export interface InlineImage {
	url?: string;
	alt?: string;
	width?: number;
	height?: number;
}

export interface WebDoc {
	kind: "web";
	id?: string;
	sortId?: number;
	title?: string;
	siteName?: string;
	url?: string;
	snippet?: string;
	summary?: string;
	content?: string;
	publishTime?: string;
	logoUrl?: string;
	rankScore?: number;
	authInfoDes?: string;
	authInfoLevel?: number;
	contentFormats?: string;
	inlineImages: InlineImage[];
	author?: string;
	/** 火山如意卡片类型（weather / stock / …），仅 SiteName=火山如意 时有值 */
	ruyiType?: string;
}

export interface ImageDoc {
	kind: "image";
	id?: string;
	sortId?: number;
	title?: string;
	siteName?: string;
	url?: string;
	publishTime?: string;
	rankScore?: number;
	imageUrl?: string;
	width?: number;
	height?: number;
	shape?: string;
	blurDes?: string;
	watermark?: string;
	category?: string;
	description?: string;
}

export type SearchDoc = WebDoc | ImageDoc;

export interface SearchResponse {
	searchType: SearchType;
	originQuery?: string;
	resultCount: number;
	docs: SearchDoc[];
	timeCostMs?: number;
	logId?: string;
	requestId?: string;
}

export class DoubaoSearchError extends Error {
	readonly code?: string;
	readonly hint?: string;
	readonly requestId?: string;

	constructor(message: string, options: { code?: string; hint?: string; requestId?: string } = {}) {
		super(message);
		this.name = "DoubaoSearchError";
		this.code = options.code;
		this.hint = options.hint;
		this.requestId = options.requestId;
	}
}

/** 官方错误码表（Custom 版文档「错误处理」章）→ 人话 + 下一步动作 */
export function mapErrorHint(code: string | number | undefined, message = ""): string {
	// 实测真机回包：坏 Key 返回的是字符串码 `invalid_api_key`（不是文档里的数字码）
	if (/invalid.?api.?key/i.test(String(code ?? ""))) {
		return "API Key 无效：检查 Authorization 头是否为 Bearer APIKey（本扩展读环境变量 DOUBAO_SEARCH_API_KEY）。";
	}
	switch (String(code ?? "")) {
		case "10400":
			return "通用参数错误：检查 Query 是否为空、字段类型/字段名是否正确（必须是 PascalCase）。";
		case "10401":
			return "TOP 网关 Token 无效：本次用的是 API Key 接入，正常不应出现，检查 Authorization 头。";
		case "10402":
			return "非法的搜索类型：检查 SearchType 是否为 web/image，以及账号是否开通了该搜索类型。";
		case "10403":
			return "权限错误：检查该 API Key 对应账号是否已开通搜索服务（火山控制台 → 联网搜索）。";
		case "10406":
			return "免费搜索额度用尽：每月 500 次免费额度已用完，需在控制台开通付费调用。";
		case "10408":
			return "服务未付费开通：在控制台确认是否已开通付费调用。";
		case "10409":
			return "订阅套餐不支持当前搜索类型：套餐 Key 只能打 Custom 版 web 搜索（/search_api/web_search），不能打 Global 版端点；也检查该 Key 是否支持 SearchType=image。";
		case "10410":
			return "无可用订阅套餐：套餐未开通或已到期，在控制台查看套餐状态。";
		case "10412":
			return "订阅套餐剩余额度不足：在控制台为套餐升配，或改用按量后付费的 API Key。";
		case "10500":
			return "服务端内部错误：可原样重试；持续失败请携带 RequestId 提工单。";
		case "10501":
			return "免费额度链路依赖失败：可重试；持续失败请携带 RequestId 提工单。";
		case "700429":
			return "并发超过 QPS 限流（默认 10 QPS）：降低并发或稍后重试，需要扩容量请提工单。";
		case "700901":
			return "API Key 无效：检查 Authorization 头是否为 Bearer APIKey。";
		default:
			return message ? `上游未归类错误：${message}` : "上游未归类错误，请携带 RequestId 排查。";
	}
}

export function parseResponse(raw: unknown): SearchResponse {
	if (!raw || typeof raw !== "object") {
		throw new DoubaoSearchError("豆包搜索没有返回可解析的内容（响应不是 JSON 对象）。");
	}
	const envelope = raw as Record<string, any>;
	const metadata = (envelope.ResponseMetadata ?? {}) as Record<string, any>;
	const requestId: string | undefined = typeof metadata.RequestId === "string" ? metadata.RequestId : undefined;

	const apiError = metadata.Error;
	if (apiError && typeof apiError === "object") {
		const code = apiError.Code !== undefined && apiError.Code !== "" ? String(apiError.Code) : String(apiError.CodeN ?? "");
		const message = String(apiError.Message ?? "").trim();
		throw new DoubaoSearchError(`豆包搜索返回错误 ${code || "(无错误码)"}：${message || "(无错误信息)"}`, {
			code: code || undefined,
			hint: mapErrorHint(code, message),
			requestId,
		});
	}

	const result = envelope.Result;
	if (!result || typeof result !== "object") {
		throw new DoubaoSearchError("豆包搜索没有返回 Result（既没有错误码也没有结果），请重试或携带 RequestId 排查。", {
			requestId,
		});
	}

	const webResults: any[] = Array.isArray(result.WebResults) ? result.WebResults : [];
	const imageResults: any[] = Array.isArray(result.ImageResults) ? result.ImageResults : [];
	const contextType = result.SearchContext?.SearchType;
	const searchType: SearchType =
		contextType === "image" || (!contextType && webResults.length === 0 && imageResults.length > 0) ? "image" : "web";

	const docs: SearchDoc[] = searchType === "image" ? imageResults.map(toImageDoc) : webResults.map(toWebDoc);

	return {
		searchType,
		originQuery: typeof result.SearchContext?.OriginQuery === "string" ? result.SearchContext.OriginQuery : undefined,
		resultCount: typeof result.ResultCount === "number" ? result.ResultCount : docs.length,
		docs,
		timeCostMs: typeof result.TimeCost === "number" ? result.TimeCost : undefined,
		logId: typeof result.LogId === "string" ? result.LogId : undefined,
		requestId,
	};
}

function str(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function num(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function toWebDoc(raw: any): WebDoc {
	const images: InlineImage[] = Array.isArray(raw?.InlineImages)
		? raw.InlineImages.map((image: any) => ({
				url: str(image?.ImageUrl),
				alt: str(image?.Alt),
				width: typeof image?.Width === "number" ? image.Width : undefined,
				height: typeof image?.Height === "number" ? image.Height : undefined,
			}))
		: [];
	return {
		kind: "web",
		id: str(raw?.Id),
		sortId: num(raw?.SortId),
		title: str(raw?.Title),
		siteName: str(raw?.SiteName),
		url: str(raw?.Url),
		snippet: str(raw?.Snippet),
		summary: str(raw?.Summary),
		content: str(raw?.Content),
		publishTime: str(raw?.PublishTime),
		logoUrl: str(raw?.LogoUrl),
		rankScore: num(raw?.RankScore),
		authInfoDes: str(raw?.AuthInfoDes),
		authInfoLevel: num(raw?.AuthInfoLevel),
		contentFormats: str(raw?.ContentFormats),
		inlineImages: images,
		author: str(raw?.AuthorInfo?.Name),
		ruyiType: str(raw?.RuyiInfo?.Type),
	};
}

function toImageDoc(raw: any): ImageDoc {
	return {
		kind: "image",
		id: str(raw?.Id),
		sortId: num(raw?.SortId),
		title: str(raw?.Title),
		siteName: str(raw?.SiteName),
		url: str(raw?.Url),
		publishTime: str(raw?.PublishTime),
		rankScore: num(raw?.RankScore),
		imageUrl: str(raw?.Image?.Url),
		width: num(raw?.Image?.Width),
		height: num(raw?.Image?.Height),
		shape: str(raw?.Image?.Shape),
		blurDes: str(raw?.Image?.BlurDes),
		watermark: raw?.Image?.Watermark === undefined ? undefined : String(raw.Image.Watermark),
		category: str(raw?.Image?.Category),
		description: str(raw?.Image?.Features?.Description),
	};
}

// ---------------------------------------------------------------- HTTP

export interface CallSearchOptions {
	apiKey: string;
	apiUrl?: string;
	body: Record<string, unknown>;
	timeoutMs?: number;
	signal?: AbortSignal;
	fetchImpl?: typeof fetch;
}

/** 调一次接口，返回原始 JSON；网络/超时/HTTP 层错误在这里翻译成人话 */
export async function callSearchApi(options: CallSearchOptions): Promise<unknown> {
	const url = options.apiUrl ?? WEB_SEARCH_URL;
	const timeoutMs = options.timeoutMs ?? 60_000;
	const fetchImpl = options.fetchImpl ?? fetch;

	const timeoutSignal = AbortSignal.timeout(timeoutMs);
	const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;

	let response: Response;
	try {
		response = await fetchImpl(url, {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${options.apiKey}` },
			body: JSON.stringify(options.body),
			signal,
		});
	} catch (error: any) {
		if (error?.name === "TimeoutError" || timeoutSignal.aborted) {
			throw new DoubaoSearchError(`豆包搜索请求超时（${Math.round(timeoutMs / 1000)} 秒）：${url}`, {
				hint: "可调大配置里的 timeoutSec 后重试，或缩小 Count/关闭 QueryRewrite。",
			});
		}
		if (error?.name === "AbortError") throw error;
		throw new DoubaoSearchError(`豆包搜索请求失败：${error?.message ?? String(error)}`, {
			hint: `检查网络能否访问 ${url}。`,
		});
	}

	const text = await response.text();
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new DoubaoSearchError(`豆包搜索返回了非 JSON 响应（HTTP ${response.status}）：${text.slice(0, 200)}`, {
			hint: "通常是网关/代理返回的页面，检查网络与代理设置。",
		});
	}
	if (!response.ok && (parsed as any)?.ResponseMetadata?.Error === undefined) {
		throw new DoubaoSearchError(`豆包搜索 HTTP ${response.status}：${text.slice(0, 200)}`);
	}
	return parsed;
}
