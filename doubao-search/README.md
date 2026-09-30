# doubao_web_search（pi 扩展）

用**豆包搜索（火山引擎联网搜索 · Custom 版）**检索中文网页与图片的 pi 工具。

> 版本：0.1.1 ｜ 2026-09-30 建 ｜ 本机路径：`~/.pi/agent/extensions/doubao-search/` ｜ npm：[`pi-doubao-search`](https://www.npmjs.com/package/pi-doubao-search)

## 它解决什么

- pi 自带的 `web_search` 走境外搜索源，中文站点（政府/税务/媒体/百科）覆盖与时效一般；
  本工具直连火山官方端点，中文站点召回更好，并且能**按权威度过滤**（政策、医疗、金融场景很关键）。
- 支持时间范围、限定/屏蔽站点、行业搜索、Query 改写；图片搜索直接给图片直链。

## 密钥（只走环境变量）

扩展**只**从环境变量 `DOUBAO_SEARCH_API_KEY` 读密钥，配置文件里不放密钥。

```powershell
# Windows，配置后重开终端（以及 pi / pi-web）
setx DOUBAO_SEARCH_API_KEY "<火山控制台 → 联网搜索 → API Key 管理（订阅套餐页签）里的 Key>"
```

⚠️ 火山有两套 Key，**不能混用**：

| Key 类型 | 能打的端点 | 说明 |
|---|---|---|
| 订阅套餐（预付费） | `/search_api/web_search`（**本扩展用的 Custom 版**） | 打 Global 版会返回 `10409` |
| 按量后付费 | `/search_api/global_search`（Global 版）、Custom 版 | —— |

## 装法

```bash
pi install npm:pi-doubao-search
```

也可以用本地目录：把本目录放到 `~/.pi/agent/extensions/doubao-search/`（pi 自动发现含 `index.ts` 的子目录，无需安装命令），改完代码在 pi 里 `/reload` 生效。临时加载一份：`pi -e <path>/index.ts`。

⚠️ **别同时用两种方式**：本地目录和 npm 包同时存在会注册两个同名 `doubao_web_search` 工具。
维护者继续用本地目录；想验证「别人装完是什么样」，用 `pi -e npm:pi-doubao-search` 或独立的 `PI_CODING_AGENT_DIR`。

## 用法

工具名 `doubao_web_search`，参数（除 `query` 外都可选）：

| 参数 | 适用 | 说明 |
|---|---|---|
| `query` | 全部 | 搜索词，1~100 字（超长按官方行为截断）。不支持多词搜索，写一句完整意图。 |
| `searchType` | 全部 | `web`（默认，最多 50 条/默认 10 条）或 `image`（最多 5 条，返回图片直链）。 |
| `count` | 全部 | 返回条数：web 1~50（默认 10），image 1~5（默认 5）。 |
| `timeRange` | web | `OneDay` / `OneWeek` / `OneMonth` / `OneYear`，或 `2025-01-01..2025-12-31`。 |
| `sites` / `blockHosts` | web | 限定 / 屏蔽站点（完整域名，≤20 / ≤5 个），例 `["gov.cn"]`、`["zhihu.com"]`。 |
| `authInfoLevel` | web | `1` = 只在「非常权威」内容里搜；`0` = 不限制（默认）。 |
| `industry` | web | `finance` / `game` / `health` / `gov`（结果变窄，过滤火山如意卡片）。 |
| `queryRewrite` | 全部 | 口语化问题开启改写，更准但更慢。 |
| `needUrl` / `needContent` | web | 只返回带原文链接 / 带正文的结果（`needUrl` 会滤掉如意卡片）。 |
| `contentFormat` | web | 正文格式 `text`（默认） / `markdown`。 |
| `includeContent` | web | 把**整篇正文**也交给模型。默认 false 只给 500~1000 字摘要。 |
| `imageWidthMin/Max`、`imageHeightMin/Max`、`imageShapes` | image | 图片尺寸与形状（`横长方形` / `竖长方形` / `方形`）筛选。 |

典型调用：

```
doubao_web_search(query="2026年新能源汽车购置税减半政策", authInfoLevel=1, sites=["gov.cn"], timeRange="OneYear")
doubao_web_search(query="长城秋景", searchType="image", imageShapes=["横长方形"])
```

输出形如（默认只给 Summary，正文按 `includeContent` 开关）：

```
[豆包搜索·web] · 「2026年新能源汽车购置税减半政策」 · 2 条结果 · TimeCost 130ms
1. 2026年购置新能源车辆在车辆购置税上有什么优惠政策?_国家税务总局广西壮族自治区税务局 | 国家税务总局广西壮族自治区税务局 | 非常权威 | 2026-08-27
   https://guangxi.chinatax.gov.cn/nsfw/nszx/rdwd/202608/t20260827_439156.html
   2026年购置新能源车辆在车辆购置税上有什么优惠政策？ …
```

## 可选配置 `<agentDir>/doubao-search.json`

只放非敏感项（默认即下面这份）：

```json
{
  "apiUrl": "https://open.feedcoopapi.com/search_api/web_search",
  "timeoutSec": 60,
  "includeContent": false,
  "contentFormat": "text",
  "count": 10
}
```

非法值一律**降级到默认并在工具调用时告警**，不静默吞掉。`apiUrl` 可用于切换到 Global 版端点
（Global 版的请求/响应结构不同，本扩展未实现，见下）。

## 已知边界

- **只实现 Custom 版协议**（`Query/SearchType/Count/Filter/...`，响应 `Result.WebResults/ImageResults`）。
  Global 版（`DocCount/MaxSnippetLength/MaxImageCountPerDoc`，响应 `Result.Documents[].Snippet[]`）是另一套结构，
  本扩展不支持；用户当前 Key 是订阅套餐 Key，只能打 Custom 版。
- `Snippet`（≈200 字）官方明确「强烈不建议用于大模型场景」，所以默认给 `Summary`；两者都没有时才退回 `Snippet`。
- 每月 500 次免费额度与 Global 版共用；默认 10 QPS。
- 结果超长时保留开头，完整结果落盘到临时文件并在文末给出路径。

## 开发与验证

```bash
npm test          # node --test tests/*.test.ts（41 例，含真实回包 fixture）
npm run typecheck # tsc -p tsconfig.json
```

- 真实回包 fixture 在 `tests/fixtures/`（2026-09-30 真机抓取：web / image / 筛选组合 / 10400 / 10409）。
