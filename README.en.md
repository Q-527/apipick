# apipick

One `api` command to manage API channels, models and usage across AI coding CLIs.

```bash
api                    # pick channel → pick model → launch Claude Code
api run ms -t codex    # same channel, different CLI
api serve              # optional: translate between four protocols
```

Zero dependencies, single process, nothing left running.

## Scope

| | [CC Switch](https://github.com/farion1231/cc-switch) | [Claude Code Router](https://github.com/musistudio/claude-code-router) | apipick |
|---|---|---|---|
| Form | Tauri desktop app | Local gateway + desktop/npm/Docker | Single-file Node CLI |
| CLIs covered | 13 | 10 | 6 |
| Provider presets | 90+ | several + custom | 7 built in + custom |
| Protocol translation | yes | yes (core feature) | yes (`api serve`, opt-in) |
| Background daemon | yes | yes | no |
| Usage dashboard | GUI | GUI | drawn in the terminal |

The first two cover more surface: tray, MCP management, cross-device sync, failover. apipick covers a different set of constraints:

- **No writes to global config.** `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_MODEL` are injected into the child process only and disappear on exit. `~/.claude/settings.json` is never modified.
- **No daemon.** `api serve` runs on demand and ends with Ctrl+C. No autostart, no port held open.
- **Channels decoupled from CLIs.** A channel is key + models + endpoints. One configuration feeds claude, codex, qwen, gemini, aider and opencode, each consuming its own protocol.
- **Model lists are probed, not typed.** Channel setup tries `/v1/models`, `/models` and `/api/tags`, understands OpenAI, Anthropic and Ollama response shapes, and caches results for 12 hours.

## Install

Node.js 18+, no other dependencies.

```bash
npm i -g apipick
```

Two command names, one program: `api` and `apipick`.

## Quick start

```bash
api add    # id → display name → base URL → key → probe models → pick default
api        # pick channel, pick model, launch Claude Code
```

Non-interactive:

```bash
api add myds --base https://api.deepseek.com --key sk-xxx --model deepseek-chat --no-ask
```

## Commands

| Command | Does |
|---|---|
| `api` | interactive picker |
| `api list` / `show` / `models` / `scan` / `ping` | inspect channels |
| `api add` / `rm` / `use` / `key` | manage channels |
| `api targets` / `target <cli>` | installed CLIs and their protocols |
| `api run <ch> -t codex` | launch another CLI with this channel |
| `api config <ch> -t codex [--write]` | preview (or write) generated config |
| `api env <ch> --json` | export generic env vars |
| `api stats` / `dash` / `report` | token usage charts from `~/.claude/projects/**/*.jsonl` |

Supported CLIs: `claude`, `qwen`, `codex`, `gemini`, `aider`, `opencode`.

## `api serve` (optional)

Claude Code only speaks Anthropic Messages (`POST /v1/messages`). A channel that only exposes OpenAI endpoints cannot be reached without translation.

```bash
api serve                        # 127.0.0.1:8787
api serve -p ds --wire openai    # pin channel and outbound protocol
api serve --port 8788 --log      # verbose request log
api serve --host 0.0.0.0 --token <secret>
```

When `--host` points at a non-loopback address (`0.0.0.0`, `::`, a LAN IP), a `--token` is required or the process exits. Such a listener is reachable from every device on the network, and each request spends the channel's quota. `--allow-unauthenticated` exists for the case where the network boundary is handled elsewhere; the startup banner then prints a warning.

| Flag | Default | Effect |
|---|---|---|
| `--max-body` | 8 MiB | Request body cap, returns 413 |
| `--max-conn` | 32 | Concurrent requests, returns 429 |
| `--timeout` | 300 s | Abort when the upstream sends nothing for this long; reset on every streaming chunk |

Disconnecting the client cancels the upstream request, so an abandoned stream stops spending quota.

```bash
ANTHROPIC_BASE_URL=http://127.0.0.1:8787 ANTHROPIC_AUTH_TOKEN=local claude
```

Channels can be switched from inside Claude Code with a model-name prefix, no restart:

```
/model ds/deepseek-chat
/model glm/glm-4.7-flash
```

Inbound: Anthropic Messages, OpenAI Chat, OpenAI Responses, Gemini `generateContent` / `streamGenerateContent`. Outbound: all four. Conversion goes through a single internal representation, so it is 4 parsers + 4 encoders rather than 16 pairwise converters.

Tool calls, streaming SSE and `tool_result` round-trips are supported in every direction and verified against live endpoints.

### Known limitations

1. Tool arguments are buffered until the tool ends when the downstream is Anthropic. Anthropic content blocks are sequential while OpenAI interleaves `tool_calls`, so pass-through would produce invalid JSON. Functionality is unaffected; only the token-by-token visual is lost.
2. `thinking` is dropped for Anthropic downstream, since thinking blocks require signatures. Forwarded as `reasoning_content` for OpenAI and `thought: true` for Gemini.
3. Images only, base64 or URL. No video, audio or PDF.
4. No custom upstream headers, no load balancing, no automatic failover.

## Config

```
~/.apipick/{keys.json, state.json, providers.json, models.cache.json, pricing.json}
```

The directory can be overridden with `APIPICK_HOME`.

Built-in channels: `ms` ModelScope, `ds` DeepSeek, `glm` Zhipu, `kimi` Moonshot, `sf` SiliconFlow, `bl` Alibaba Bailian, `ol` Ollama.

## Dev

```bash
npm test             # 32 cases in two suites
node test/run.mjs    # 18 offline cases: parse / build / 4×4 round-trip / event encoding
node test/serve.mjs  # 14 server cases: auth / body limit / concurrency / timeout / disconnect / stream errors / config guard
```

MIT License.
