# my-pi-agent-extensions

我的 [pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) 扩展集合。每个子目录都是一个**独立的 pi 扩展**，同时也是**独立的 npm 包**。

| 扩展 | 注册的工具 | npm 包 | 干什么 |
| --- | --- | --- | --- |
| [`doubao-search/`](doubao-search/) | `doubao_web_search` | [`pi-doubao-search`](https://www.npmjs.com/package/pi-doubao-search) | 豆包搜索（火山引擎联网搜索 **Custom 版**）搜中文网页与图片：时间范围、限定/屏蔽站点、权威度过滤、行业搜索、图片尺寸/形状筛选 |
| [`video-read/`](video-read/) | `video_read` | [`pi-video-read`](https://www.npmjs.com/package/pi-video-read) | 用 `qwen3.8-omni-flash` 读视频（**画面 + 声音/口播转写**）：本地文件、http(s)、`oss://` 都支持 |

## 安装

```bash
pi install npm:pi-doubao-search
pi install npm:pi-video-read
```

也可以直接用目录：把某个扩展目录放到 `~/.pi/agent/extensions/<name>/`（pi 会自动发现含 `index.ts` 的子目录，无需安装命令）。
**别同时用两种方式**，否则会注册两个同名工具。

## 配置（密钥只走环境变量）

| 扩展 | 环境变量 | 说明 |
| --- | --- | --- |
| `doubao-search` | `DOUBAO_SEARCH_API_KEY` | 火山控制台 → 联网搜索 → API Key 管理 **订阅套餐** 页签。⚠️ 套餐 Key 只能打 Custom 版端点 `/search_api/web_search`，打 Global 版 `/search_api/global_search` 会返回 `10409` |
| `video-read` | `DASHSCOPE_API_KEY` | 阿里云百炼（DashScope）API Key |

可选的非敏感配置放在 `~/.pi/agent/<extension>.json`，细节见各扩展 README。

## 开发

每个子目录自带测试与类型检查（Node ≥ 22.19，直接跑 TS，无构建步骤）：

```bash
cd doubao-search && npm install && npm test && npm run typecheck
cd video-read   && npm install && npm test && npm run typecheck
```

测试夹具都是**真机回包**，期望值来自官方文档与真实响应，不做镜像断言。
贡献者用 `tsconfig.portable.json`；本机版 `tsconfig.json` 含个人机器绝对路径，**不入库**（已在 `.gitignore` 里）。

## 本仓库与维护副本的关系

本仓库是**发布镜像**：日常维护的副本在 `~/.pi/agent/extensions/<name>/`（pi 直接从那里加载，且那里还放着各人的密钥类文件，不适合做工作副本）。
改完源码后用根目录的同步脚本刷过来：

```bash
node sync.mjs          # 同步：复制新增/变更，删除仓库侧多余文件
node sync.mjs --check  # 只报差异，有漂移退出码 1
```

同步会排除 `tsconfig.json`、`node_modules/`、`*.tgz`、`.npmrc`。

## 发布新版（npm）

源码目录就是包目录，改完直接：

```bash
cd doubao-search            # 或 video-read
# 改 package.json 的 version
npm publish --registry https://registry.npmjs.org
```

`prepack` 会先跑测试，测试不过发不出去。注意本机默认 registry 是淘宝镜像（只读），必须显式指定 npmjs。

## License

MIT，见各子目录下的 `LICENSE`。
