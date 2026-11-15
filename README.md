# apipick

一个 `api` 命令，管理各家 API 渠道、模型和用量，并把渠道注入到 AI CLI 启动。

```bash
api                    # 选渠道 → 选模型 → 启动 Claude Code
api run ms -t codex    # 同一渠道，换一个 CLI 启动
api serve              # 可选：在四种协议之间互转
```

零依赖、单进程、不常驻。切换只影响被拉起的子进程，退出后不留痕迹。

## 定位

| | [CC Switch](https://github.com/farion1231/cc-switch) | [Claude Code Router](https://github.com/musistudio/claude-code-router) | apipick |
|---|---|---|---|
| 形态 | Tauri 桌面应用（Win/mac/Linux） | 本地网关 + 桌面/npm/Docker | 单文件 Node CLI |
| 支持的 CLI | 13 个 | 10 个 | 6 个 |
| 供应商预设 | 90+ | 常见几家 + 自定义 | 7 个内置 + 自定义 |
| 协议转换 | 有（本地路由） | 有（核心功能） | 有（`api serve`，默认不开） |
| 后台常驻 | 是 | 是（网关必须开着） | 否 |
| 用量看板 | 图形界面 | 图形界面 | 终端内绘制 |

前两者的功能覆盖面更大：托盘、MCP 管理、跨设备同步、故障转移都具备。apipick 覆盖的是另一组约束：

- **不写全局配置。** `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_MODEL` 只注入子进程环境变量，父进程退出即失效，`~/.claude/settings.json` 不做任何改动。
- **不常驻。** `api serve` 手动启动，Ctrl+C 结束，不注册开机自启，不长期占用端口。
- **渠道与 CLI 解耦。** 渠道是 key + 模型 + 端点的组合，同一份配置可分别喂给 claude、codex、qwen、gemini、aider、opencode，各自按自己的协议取用。
- **模型列表靠探测。** 加渠道时无需手抄模型名：依次尝试 `/v1/models`、`/models`、`/api/tags`，兼容 OpenAI、Anthropic、Ollama 三种返回结构，缓存 12 小时。

## 安装

Node.js 18 以上，无其他依赖。

```bash
npm i -g apipick
```

两个命令名指向同一程序：`api`（短名）与 `apipick`（与包名一致）。

Windows 下 `npm i -g` 后 `api` 未生效时，可直接运行仓库内的 `apipick.cmd`。

## 快速开始

```bash
api add              # 加渠道：id → Base URL → key → 探测模型 → 选默认
api                  # 选渠道 → 选模型 → 启动 claude
```

`api add` 只询问必填项，其余按可推断值补全：

```
  渠道 id（英文短名，如 myds）：myds
  显示名：DeepSeek 官方
  Base URL：https://api.deepseek.com
  API key（输入不回显）：sk-xxxx
  正在探测可用模型……  找到 4 个
  1) deepseek-chat   2) deepseek-reasoner   3) deepseek-v4-pro
  选默认模型 [1]：
```

非交互写法，便于写入脚本：

```bash
api add myds --base https://api.deepseek.com --key sk-xxx --model deepseek-chat --no-ask
```

## 命令

### 渠道与模型

| 命令 | 作用 |
|---|---|
| `api` | 交互式：选渠道 → 选模型 → 启动 |
| `api list` | 全部渠道、当前模型、key 状态 |
| `api show <渠道>` | 单渠道详情：端点、key、模型数、累计用量 |
| `api add [id]` | 新增自定义渠道，自动探测模型 |
| `api rm <渠道>` | 删除自定义渠道（含 key 与缓存） |
| `api use <渠道> [模型]` | 设定当前模型 |
| `api key <渠道> [值]` | 设置 key，缺省值则隐藏输入 |
| `api models <渠道>` | 列出该渠道的模型 |
| `api scan [渠道\|--all]` | 联网重扫模型列表并写入缓存 |
| `api ping [渠道]` | 各渠道连通性与延迟，不消耗 token |

### 多 CLI

| 命令 | 作用 |
|---|---|
| `api targets` | 支持的 CLI、是否安装、使用哪种协议 |
| `api target <cli>` | 设定默认目标：`claude` `qwen` `codex` `gemini` `aider` `opencode` |
| `api run <渠道> -t codex` | 临时更换 CLI，不修改默认值 |
| `api config <渠道> -t codex` | 预览生成的配置，加 `--write` 才落盘 |
| `api env <渠道> --json` | 导出通用环境变量 |

### 用量

| 命令 | 作用 |
|---|---|
| `api stats [--days N]` | 每日柱状图、模型榜、渠道分布、费用估算 |
| `api dash` | 单屏仪表盘，`--watch 5` 定时刷新 |
| `api report` | 生成 HTML 报告 |

数据源为 `~/.claude/projects/**/*.jsonl` 中的 `usage` 字段，增量扫描：399MB 首次 900ms，命中缓存后 4ms。

## `api serve`：可选的协议转换

渠道与 CLI 的协议不一致时需要它。Claude Code 只发送 `POST /v1/messages`（Anthropic 协议），对接 DeepSeek 官方接口这类 OpenAI 协议的服务时，请求无法被识别，中间需要一层转换。

```
Claude Code ──Anthropic──► api serve ──OpenAI──► DeepSeek / Kimi / ModelScope
     ▲                         │
     └──────Anthropic──────────┘
```

### 启动

```bash
api serve                          # 127.0.0.1:8787，渠道按模型名前缀自动选择
api serve -p ds                    # 固定 ds 渠道，模型名照常书写
api serve -p ds --wire openai      # 强制出站协议
api serve --port 8788 --log        # 更换端口并打印每次请求
api serve --host 0.0.0.0 --token <口令>   # 供局域网使用，带 token 校验
```

启动后输出：

```
  apipick serve   本地协议转换网关（Ctrl+C 停止）

   地址   http://127.0.0.1:8787
   渠道   自动（模型名前缀优先，否则上次使用的渠道）
   出站   按渠道自动选择
```

### 接入 Claude Code

```bash
ANTHROPIC_BASE_URL=http://127.0.0.1:8787 ANTHROPIC_AUTH_TOKEN=local claude
```

在 Claude Code 内可用模型名前缀切换渠道，无需重启网关：

```
/model ds/deepseek-chat
/model glm/glm-4.7-flash
/model ms/Qwen/Qwen3.5-122B-A10B
```

前缀无法识别时按普通模型名处理，交给默认渠道，因此自带斜杠的模型名（如 `Pro/Qwen3-8B`）不受影响。加 `--no-prefix` 可关闭该行为。

### 四种协议互转

| 入站端点 | 使用方 | 出站支持 |
|---|---|---|
| `POST /v1/messages` | Claude Code | anthropic / openai / responses / gemini |
| `POST /v1/chat/completions` | OpenAI 兼容客户端 | 同上 |
| `POST /v1/responses` | Codex | 同上 |
| `POST /v1beta/models/<m>:generateContent` | Gemini CLI | 同上 |

转换统一经过一层内部表示，因此是 4 个解析器 + 4 个编码器，而非 16 个两两转换器；新增第五种协议只需补一问一答两个模块。

已用真实 key 验证的组合：

- Anthropic 入站 → OpenAI 出站：DeepSeek、ModelScope、硅基流动、智谱
- OpenAI 入站 → Anthropic 出站：DeepSeek（`deepseek.com/anthropic`）
- Responses 入站 → OpenAI 出站：ModelScope
- Gemini 入站 → OpenAI 出站：ModelScope，含流式
- 工具调用往返（`tool_use` → `tool_calls` → `tool` → `tool_use`）：ModelScope，含流式分片

### 已知限制

以下为设计取舍，非未完成项：

1. **工具参数不逐字节流式下发。** 上游分片推送 `arguments` 且下游为 Anthropic 时，缓冲至该工具结束再一次性发送 `input_json_delta`。原因是 Anthropic 的 content block 串行，而 OpenAI 允许交错推送多个 `tool_calls`（index 0 未完成即开始 1），直接透传会拼出非法 JSON。功能不受影响，仅缺少逐字输出观感。
2. **thinking 内容在 Anthropic 下游丢弃。** Anthropic 的 `thinking` block 需要签名，构造伪造签名会被服务端拒绝。下游为 OpenAI 时走 `reasoning_content`，Gemini 时走 `thought: true`。
3. **图片仅支持 base64 内联与 URL 外链**，视频、音频、PDF 不做转换。
4. **不支持自定义上游请求头。** 少数中转站要求 `HTTP-Referer` 等 header，目前需修改 `upstreamHeaders()`。
5. **无多渠道负载均衡与自动故障转移**，该能力由 CCR 覆盖。

## 配置

```
~/.apipick/
├── keys.json            # API key，权限 600
├── state.json           # 当前渠道、当前模型、默认目标 CLI
├── providers.json       # 自定义渠道
├── models.cache.json    # 探测到的模型列表，12h 过期
└── pricing.json         # 单价表，report 计费使用
```

目录位置可用 `APIPICK_HOME` 覆盖。

内置渠道 7 个：`ms`（ModelScope）、`ds`（DeepSeek）、`glm`（智谱）、`kimi`（月之暗面）、`sf`（硅基流动）、`bl`（阿里云百炼）、`ol`（Ollama 本地或云端）。

## 常见问题

**为什么不用改写 `~/.claude/settings.json` 的方式切换？**
该文件包含其他设置，写入会被覆盖，且切回官方时容易遗漏。环境变量是一次性的、作用域明确的覆盖。

**`api serve` 是否明显增加延迟？**
多一跳本地转发，耗时在毫秒级；实际响应速度由上游决定。

**能否不安装 Node？**
可以打包为单文件可执行（`node --experimental-sea-config`），但需按平台分别构建，目前仅保证源码运行。

**`api` 作为命令名是否会冲突？**
会，部分项目自带 `api` 脚本。冲突时改用 `apipick` 或建 alias。

## 开发

```bash
node test/run.mjs     # 18 个离线用例：解析 / 构造 / 4×4 往返 / 事件编码
node bin/api.mjs --help
```

```
bin/api.mjs            命令分发
src/core.mjs           渠道、key、状态、模型探测与缓存
src/targets.mjs        六种 CLI 的协议适配与配置生成
src/launch.mjs         拼装环境变量并 spawn
src/picker.mjs         数字选择器
src/serve/             api serve
  ├── ir.mjs           统一内部表示
  ├── parse.mjs        入站：4 种协议 → IR
  ├── build.mjs        IR → 4 种出站请求
  ├── stream.mjs       上游响应/SSE → 事件流
  ├── emit.mjs         事件流 → 下游 SSE 或 JSON
  └── index.mjs        HTTP 服务、路由、日志
src/viz.mjs            终端绘图原语（含 CJK 宽度计算）
```

MIT License.
