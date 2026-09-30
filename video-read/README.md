# video_read（pi 扩展）

用 `qwen3.8-omni-flash` 读视频：**既看画面，也听声音**（口播转写、语气），返回文本。
面向 pi 的 `video_read` 工具，本地文件 / 公网 URL / `oss://` 都能读。

```
用户：这个视频讲了什么？
pi ：→ video_read(source="D:/v/片子.mp4")   ← 本地 1.1MB，base64 内联
     ✔ 读完 11.0s · 3253 tokens · 思考 251 · ¥0.0029
```

## 装在哪 / 怎么用

扩展已装在本目录（`~/.pi/agent/extensions/video-read/`），pi 启动时自动加载。
开发期也可以单独加载：`pi --extension <本目录> `。

模型自己会调；手动触发就直接说「读一下这个视频 D:/v/a.mp4」。

## 安装

```bash
pi install npm:pi-video-read      # 装进 settings.json，长期使用
pi -e npm:pi-video-read           # 只试一次，不动配置
```

前置：环境变量 `DASHSCOPE_API_KEY`（阿里云百炼 API Key）。密钥只从环境变量读，不落配置文件。

## 本地开发（改了代码要跑）

扩展本体是 TS，pi 用 jiti 现场转译，**不需要构建**。

```bash
node --test "tests/*.test.ts"    # 52 个离线用例（纯 node，不用装依赖）
npm install && npm run typecheck  # 类型检查（会拉 pi 的类型，约 450MB）
npm pack                          # 打包前会自动跑一遍测试（prepack）
```

两个 tsconfig 的分工：

| 文件 | 用途 |
|---|---|
| `tsconfig.portable.json` | 可移植版（标准 node 解析，需先 `npm install`）。贡献者用这个 |
| `tsconfig.json` | **本机专用**：把 `paths` 指向本机 pi 安装路径，零安装即可类型检查（本机 LSP 也靠它） |

## 参数

| 参数 | 说明 |
|---|---|
| `source` | 必填。本地路径（相对 `ctx.cwd`）/ `http(s)` 公网 URL / `oss://` 临时 URL；可传**数组**一次读多个（单请求 ≤64 个） |
| `prompt` | 问什么。不填则按 `detail` 档位自带的结构化报告提问 |
| `detail` | `quick` / `standard`（默认）/ `fine`，见下表 |
| `fps` | 抽帧率，模型允许 0.1–10，不填按档位 |
| `maxPixels` | 单帧像素上限，合法区间 4096–2,048,000，不填按档位 |
| `maxTokens` | 输出上限，默认 8000；长视频的逐句转写要调大 |
| `reasoningEffort` | 思考档位 `none/minimal/low/medium/high/xhigh/max`。默认 **low** |

### 档位预设

| detail | fps | max_pixels | 默认提示词 | 适用 |
|---|---|---|---|---|
| `quick` | 0.5 | 230,400 | 3-6 句概括 | 长视频粗看、批量筛选 |
| `standard` | 1 | 921,600 | 时间线 + 画面文字 + 说话人转写 | 常规 |
| `fine` | 2 | 2,048,000 | 上述 + 0.1 秒时间戳/镜头切换/语气口音 | 短片细看 |

> `max_pixels` 的硬上限是 **2,048,000**。百炼推荐提示词表里写的 2,073,600 超限（实测 400：
> `Parameter max_pixels must be smaller than or equal to 2048000`），所以 `fine` 取上限值。

## 实测记录（2026-09-28，本机）

| 场景 | 结果 |
|---|---|
| 本地 1.1MB / 8.2s 视频 → base64 内联 | 11.0s，输入 2502（视频 2378 / 音频 58）+ 输出 343，约 ¥0.0029 |
| 本地 16.0MB / 118.7s → 官方临时上传 | 上传 + 调用共 10.2s，输入 7516（视频 6602 / 音频 828），约 ¥0.0073 |
| 同一文件第二次读（命中上传缓存） | 5.0s（省掉上传），约 ¥0.0064 |
| 公网 URL（阿里云文档样例 mp4） | 3.5s，输入 824 + 输出 164，约 ¥0.0011（连歌词都转了出来） |
| `detail=fine` 读 12.6MB / 60s 视频 | 18.1s，输入 55052 + 输出 485，约 ¥0.045 |
| 上传吞吐 | 4.1MB→7.0MB/s、16MB→9.2MB/s、68.5MB→6.7MB/s |
| 中断（请求进行中 abort） | 首包 2425ms、收到 110 个流事件后中断 → 抛「调用已被取消。」 |

> 成本口径：输入 ¥0.8/M、缓存命中 ¥0.1/M、输出 ¥2.7/M。`fine` 比 `quick` 贵约 6 倍（帧数 ×4 + 像素 ×9），
> 长视频先 `quick` 粗筛、需要细节再 `fine` 是更省的用法。

## 输入体积分流

| 本地文件 | 走法 | 上限 |
|---|---|---|
| ≤ 7.5MB（raw） | base64 data URI 内联 | 文档硬限：base64 字符串 <10MB |
| 7.5MB – 1GB | 官方临时上传拿 `oss://`（**48h 有效、绑定模型与主账号**） | 上传接口 ≤1GB |
| > 1GB | 报错，请压缩/切分或改用自有 OSS 公网 URL | 模型侧 URL 输入 ≤2GB |

时长 2 秒–2 小时；格式 mp4/m4v/mov/mkv/webm/flv/wmv/avi。
上传结果按「路径 + 体积 + mtime + 模型」缓存在 `<agentDir>/cache/video-read/uploads.json`（47h，比官方 48h 少留 1 小时），
所以同一个大文件反复问不会重复上传。

## 配置（可选）

`~/.pi/agent/video-read.json`（`PI_CODING_AGENT_DIR` 会改这个目录）：

```json
{
  "model": "qwen3.8-omni-flash",
  "reasoningEffort": "low",
  "detail": "standard",
  "fps": 1,
  "maxPixels": 921600,
  "maxTokens": 8000,
  "timeoutSec": 900,
  "maxVideos": 64,
  "baseUrl": "https://dashscope.aliyuncs.com/compatible-mode/v1"
}
```

- **密钥不在配置里**：只读环境变量 `DASHSCOPE_API_KEY`（`DASHSCOPE_BASE_URL` 作为 `baseUrl` 兜底）。
- 非法值会降级到默认并在工具结果里带 `⚠ 配置降级` 告警，不会静默吞掉。
- 日志/结果里不打印密钥；上传到百炼临时存储的 URL 只在缓存文件里。

## 测试

```bash
cd ~/.pi/agent/extensions/video-read
node --test "tests/*.test.ts"     # 46 个用例，纯离线
tsc -p tsconfig.json               # 类型检查（tsconfig 把 pi/typebox 指向本机安装位置）
```

- `tests/fixtures/sse-none.txt`、`sse-low.txt` 是**真实回包**；对应 `.expected.json` 由
  `probe/derive-fixture-truth.mjs`（正则全量扫描，与增量解析器不同实现路径）导出，避免镜像断言。
- `tests/fixtures/ffprobe-sample.json` 是真实 ffprobe 输出。
- 需要联网的验证（真请求、真中断、端到端）没放进包内，因为要花 API 额度；改代码后建议至少跑一次 `video_read` 实操。

## 已知边界

- **不支持纯音频文件**（音频在协议里走 `input_audio` 内容块，形状不同，未验证过就没做）。
- **每次调用独立**：不带会话上下文，追问要看同一视频得再调一次（命中缓存更便宜）。
- 模型对视频帧还有一层未文档化的下采样，所以**不做调用前的 token 预估**，只回报调用后的真实用量。
- 上传走官方临时存储，48h 后 URL 失效；要长期复用的链接请自行上传 OSS 并把公网 URL 传进来。
- pi 的全局 HTTP 空闲超时默认 5 分钟（`httpIdleTimeoutMs`）；本扩展用流式，正常不会触发，但若视频长到服务端 5 分钟不吐字节，需要调大该设置。
- TUI 渲染只在纯函数层面有测试（`tests/render.test.ts`），真实终端里的目视效果未验证。
