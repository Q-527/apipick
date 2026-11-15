// targets.mjs — 把「渠道」翻译成各家 AI CLI 认识的样子。
//
// 一个渠道（provider）通常同时有 anthropic / openai 两套端点；
// 一个 CLI（target）只认其中一种协议 + 自己的一套环境变量或配置文件。
// 这里做的是这两边的翻译层，删掉任何一个 CLI 都不影响其它。
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { homeDir } from "./core.mjs";
import { c, err, info, pad, warn, closePrompts } from "./ui.mjs";

// ---------------------------------------------------------------- endpoints

/** 从 Anthropic 风格 base 猜一个 OpenAI 兼容 base（只在渠道没显式声明时兜底） */
export function openaiFrom(base) {
  const u = String(base || "").trim().replace(/\/+$/, "");
  if (!u) return "";
  if (/\/anthropic$/.test(u)) return u.replace(/\/anthropic$/, "/v1");
  if (/\/compatible-mode\/v1$/.test(u)) return u;
  if (/\/api\/paas\/v4$/.test(u)) return u;
  if (/\/v1$/.test(u)) return u;
  return u + "/v1";
}

/** 某渠道在某协议下的端点；没有则返回 ""（表示这家不支持该协议） */
export function endpointFor(provider, proto, { local = false } = {}) {
  const ep = provider.endpoints || {};
  const isOllama = provider.id === "ol";

  if (proto === "anthropic") {
    if (isOllama && local) return provider.localBaseUrl || "http://localhost:11434";
    return provider.baseUrl || "";
  }
  if (proto === "openai" || proto === "responses") {
    if (isOllama) {
      return local
        ? (ep.openai || "http://localhost:11434/v1")
        : (ep.cloudOpenai || "https://ollama.com/v1");
    }
    return ep[proto] || ep.openai || openaiFrom(provider.baseUrl);
  }
  if (proto === "gemini") return ep.gemini || "";
  return provider.baseUrl || "";
}

export function protoSupport(provider, proto) {
  const ep = endpointFor(provider, proto);
  if (!ep) {
    return {
      ok: false,
      why: `${provider.name} 没有 ${proto} 端点（api add 时可用 --${proto} <url> 声明）`,
    };
  }
  if (proto === "responses") {
    return {
      ok: true,
      soft: true,
      why: "走 /v1/responses；不支持该接口的渠道会在发请求时 404，换个渠道即可",
    };
  }
  return { ok: true };
}

// ---------------------------------------------------------------- fs helpers

function ensureDir(d) {
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
  return d;
}

function tomlStr(s) {
  return JSON.stringify(String(s ?? ""));
}

/** 读用户原有的 codex config.toml，剥掉与内置 provider 冲突的键和 provider 段。
 *  TOML 要求顶层标量在任何 [table] 之前，所以这里拆成两半分别回填。 */
function splitCodexBase() {
  const src = process.env.CODEX_HOME
    ? join(process.env.CODEX_HOME, "config.toml")
    : join(homedir(), ".codex", "config.toml");
  if (!existsSync(src)) return { scalars: "", tables: "" };

  const scalars = [];
  const tables = [];
  let inTables = false;
  let skip = false;
  for (const line of readFileSync(src, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (t.startsWith("[")) {
      inTables = true;
      // 只剥 model_providers / profiles，其它段（tui、sandbox、mcp_servers…）照抄
      skip = /^\[(model_providers|profiles)[.\]]/.test(t);
      if (skip) continue;
    }
    if (skip) continue;
    if (!inTables && /^(model|model_provider)\s*=/.test(t)) continue;
    (inTables ? tables : scalars).push(line);
  }
  return { scalars: scalars.join("\n").trim(), tables: tables.join("\n").trim() };
}

export function codexConfigPath(providerId) {
  return join(homeDir(), "targets", "codex", providerId, "config.toml");
}

export function opencodeConfigPath() {
  // opencode 自身认 OPENCODE_CONFIG，跟随它，别写到另一个地方
  return process.env.OPENCODE_CONFIG || join(homedir(), ".config", "opencode", "opencode.json");
}

function buildCodexConfig(x) {
  const wire = x.wire || "responses";
  const { scalars, tables } = splitCodexBase();
  const out = [
    `# 由 apipick 生成 —— 渠道 ${x.provider.name} / 模型 ${x.model}`,
    `# 启动时 CODEX_HOME 指向本目录，原有 ~/.codex/config.toml 不受影响`,
    `model = ${tomlStr(x.model)}`,
    `model_provider = "apipick"`,
  ];
  if (scalars) out.push(scalars);
  out.push("");
  if (tables) out.push(tables, "");
  out.push(
    "[model_providers.apipick]",
    `name = ${tomlStr(x.provider.name + " (apipick)")}`,
    `base_url = ${tomlStr(x.endpoint)}`,
    `env_key = "OPENAI_API_KEY"`,
    `wire_api = ${tomlStr(wire)}`,
  );
  return { path: codexConfigPath(x.provider.id), content: out.join("\n") + "\n" };
}

function writeCodexConfig(x) {
  const { path, content } = buildCodexConfig(x);
  ensureDir(dirname(path));
  writeFileSync(path, content, "utf8");
  return { CODEX_HOME: dirname(path) };
}

function buildOpencodeConfig(x) {
  const file = opencodeConfigPath();
  let cfg = {};
  if (existsSync(file)) {
    const raw = readFileSync(file, "utf8");
    if (raw.trim()) {
      // 读不懂就停手：宁可这次不启动，也不能把别人原有的配置冲掉
      try {
        cfg = JSON.parse(raw);
      } catch (e) {
        throw new Error(`${file} 不是合法 JSON（${e.message}），已取消写入，原文件未改动`);
      }
      if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) {
        throw new Error(`${file} 顶层不是 JSON 对象，已取消写入，原文件未改动`);
      }
    }
  }
  if (!cfg.$schema) cfg.$schema = "https://opencode.ai/config.json";
  if (!cfg.provider || typeof cfg.provider !== "object") cfg.provider = {};
  const pid = `apipick-${x.provider.id}`;
  const win = x.win || 200000;
  const models = (cfg.provider[pid] && cfg.provider[pid].models) || {};
  models[x.model] = {
    name: x.model,
    limit: { context: win, output: Math.min(64000, win) },
  };
  cfg.provider[pid] = {
    npm: "@ai-sdk/openai-compatible",
    name: `${x.provider.name} (apipick)`,
    options: { baseURL: x.endpoint, apiKey: "{env:OPENAI_API_KEY}" },
    models,
  };
  cfg.model = `${pid}/${x.model}`;
  return { path: file, content: JSON.stringify(cfg, null, 2) + "\n" };
}

function writeOpencodeConfig(x) {
  const { path, content } = buildOpencodeConfig(x);
  ensureDir(dirname(path));
  writeFileSync(path, content, "utf8");
  return {};
}

// ---------------------------------------------------------------- targets

/**
 * 每个 target：
 *   proto   —— 它吃哪种协议（决定用哪个端点）
 *   env(x)  —— 需要的环境变量；值为 null/undefined 表示「从继承的环境里删掉」
 *   args(x) —— 命令行参数
 *   files(x)—— 写配置文件，返回额外环境变量
 */
export const TARGETS = [
  {
    id: "claude",
    name: "Claude Code",
    bin: "claude",
    proto: "anthropic",
    note: "原生 Anthropic 协议",
    env: (x) => ({
      ANTHROPIC_BASE_URL: x.endpoint,
      ANTHROPIC_MODEL: x.model,
      ANTHROPIC_SMALL_FAST_MODEL: x.model,
      ANTHROPIC_AUTH_TOKEN: x.local ? "" : x.key,
      ANTHROPIC_API_KEY: x.local ? "ollama" : undefined,
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: "64000",
      CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "80",
      CLAUDE_CODE_MAX_CONTEXT_TOKENS: x.win === 200000 ? undefined : String(x.win),
    }),
  },
  {
    id: "qwen",
    name: "Qwen Code",
    bin: "qwen",
    proto: "openai",
    note: "OpenAI 兼容协议",
    env: (x) => ({
      OPENAI_API_KEY: secretOf(x),
      OPENAI_BASE_URL: x.endpoint,
      OPENAI_MODEL: x.model,
    }),
  },
  {
    id: "aider",
    name: "Aider",
    bin: "aider",
    proto: "openai",
    note: "OpenAI 兼容协议",
    env: (x) => ({ OPENAI_API_KEY: secretOf(x), OPENAI_API_BASE: x.endpoint }),
    args: (x) => ["--model", `openai/${x.model}`],
  },
  {
    id: "codex",
    name: "Codex CLI",
    bin: "codex",
    proto: "responses",
    note: "只吃 /v1/responses；配置写进独立 CODEX_HOME",
    env: (x) => ({ OPENAI_API_KEY: secretOf(x) }),
    files: writeCodexConfig,
    render: buildCodexConfig,
    confPath: (x) => codexConfigPath(x.provider.id),
    args: (x) => ["-m", x.model],
  },
  {
    id: "gemini",
    name: "Gemini CLI",
    bin: "gemini",
    proto: "gemini",
    note: "Gemini 原生协议（需要渠道支持）",
    env: (x) => ({
      GEMINI_API_KEY: secretOf(x),
      GOOGLE_GEMINI_BASE_URL: x.endpoint,
      GEMINI_MODEL: x.model,
    }),
  },
  {
    id: "opencode",
    name: "OpenCode",
    bin: "opencode",
    proto: "openai",
    note: "OpenAI 兼容协议；配置写进 ~/.config/opencode",
    env: (x) => ({ OPENAI_API_KEY: secretOf(x) }),
    files: writeOpencodeConfig,
    render: buildOpencodeConfig,
    confPath: () => opencodeConfigPath(),
    args: (x) => ["-m", `apipick-${x.provider.id}/${x.model}`],
  },
];

function secretOf(x) {
  return x.local ? "ollama" : (x.key || "none");
}

export function findTarget(idOrAlias) {
  if (!idOrAlias) return null;
  const k = String(idOrAlias).toLowerCase();
  return TARGETS.find((t) => t.id === k)
    || TARGETS.find((t) => t.name.toLowerCase().replace(/[^a-z]/g, "") === k.replace(/[^a-z]/g, ""))
    || TARGETS.find((t) => t.id.startsWith(k) && k.length >= 3)
    || null;
}

export function which(bin) {
  const cmd = process.platform === "win32" ? "where" : "which";
  try {
    const r = spawnSync(cmd, [bin], { encoding: "utf8", timeout: 6000 });
    if (r.status !== 0) return "";
    return (r.stdout || "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0] || "";
  } catch { return ""; }
}

// ---------------------------------------------------------------- generic env

/** 通用环境变量导出：任何 CLI 只要认环境变量就能接上 */
export function envSet(x) {
  const anth = endpointFor(x.provider, "anthropic", { local: x.local });
  const oai = endpointFor(x.provider, "openai", { local: x.local });
  // 本地 Ollama 不校验 key，填占位符即可，不要传云端 key
  const secret = x.local ? "ollama" : (x.key || "");
  const out = {
    ANTHROPIC_BASE_URL: anth,
    ANTHROPIC_AUTH_TOKEN: secret,
    ANTHROPIC_MODEL: x.model,
    ANTHROPIC_SMALL_FAST_MODEL: x.model,
    OPENAI_BASE_URL: oai,
    OPENAI_API_KEY: secret,
    OPENAI_MODEL: x.model,
  };
  const gem = endpointFor(x.provider, "gemini", { local: x.local });
  if (gem) { out.GOOGLE_GEMINI_BASE_URL = gem; out.GEMINI_API_KEY = secret; }
  return { values: out, anthropic: anth, openai: oai, gemini: gem || "" };
}

function quoteFor(shell, v) {
  if (shell === "pwsh" || shell === "powershell") return `$env:${v.key} = "${String(v.value).replace(/"/g, '`"')}"`;
  if (shell === "cmd") return `set ${v.key}=${v.value}`;
  return `export ${v.key}="${String(v.value).replace(/"/g, '\\"')}"`;
}

export function formatEnv(values, shell = "bash") {
  const rows = Object.entries(values).filter(([, v]) => v !== undefined && v !== null && v !== "");
  if (shell === "json") return JSON.stringify(Object.fromEntries(rows), null, 2);
  return rows.map(([key, value]) => quoteFor(shell, { key, value })).join("\n");
}

// ---------------------------------------------------------------- runner

export function runTarget(targetId, x, { args = [], dry = false, bin, hook } = {}) {
  const t = findTarget(targetId);
  if (!t) {
    err(`[!] 未知目标 CLI：${targetId}`);
    info(`    可用：${TARGETS.map((v) => v.id).join(" / ")}`);
    return 1;
  }

  const support = protoSupport(x.provider, t.proto);
  if (!support.ok) {
    err(`[!] ${t.name} 需要 ${t.proto} 协议 —— ${support.why}`);
    return 1;
  }

  let fileEnv = {};
  if (t.files) {
    try { fileEnv = t.files(x) || {}; } catch (e) {
      err(`[!] 写配置失败：${e.message}`);
      return 1;
    }
  }

  const add = t.env ? t.env(x) : {};
  const env = { ...process.env };
  for (const [k, v] of Object.entries({ ...add, ...fileEnv })) {
    if (v === undefined || v === null) delete env[k];
    else env[k] = String(v);
  }

  const argv = [...(t.args ? t.args(x) : []), ...args];
  const binPath = bin || process.env[`MYAPI_BIN_${t.id.toUpperCase()}`] || t.bin;

  console.log("");
  console.log(c.gray(`  Workdir : ${process.cwd()}`));
  console.log(c.gray(`  Target  : ${t.name}`) + c.gray(`  (${t.proto})`));
  console.log(c.gray(`  Channel : ${x.provider.name}`) + (x.local ? c.cyan("  [local]") : ""));
  console.log(c.gray(`  Model   : ${x.model}`));
  console.log(c.gray(`  Endpoint: ${x.endpoint}`));
  if (t.files) console.log(c.gray(`  Config  : 已写入 ${t.id} 的配置文件`));
  if (support.soft) console.log(c.yellow(`  注意    : ${support.why}`));
  if (hook) { try { hook(); } catch { /* best effort */ } }

  if (dry) {
    console.log(c.yellow(`  [DRY] 只做路由，不启动 ${t.bin}`));
    console.log(c.gray(`  命令    : ${binPath} ${argv.join(" ")}`.trimEnd()));
    const shown = t.env ? t.env(x) : {};
    for (const [k, v] of Object.entries(shown)) {
      if (v === undefined || v === null) continue;
      // 只遮真密钥；占位符和 CLAUDE_CODE_MAX_OUTPUT_TOKENS 这类数字不用遮
      const hide = v !== "none" && v !== "ollama" && /(API_?KEY|AUTH_TOKEN)$/i.test(k);
      const text = hide && v ? String(v).slice(0, 4) + "…" : String(v);
      console.log(c.gray(`  ${pad(k, 32)}${text}`));
    }
    for (const [k, v] of Object.entries(fileEnv)) console.log(c.gray(`  ${pad(k, 32)}${v}`));
    return 0;
  }

  const found = which(binPath);
  if (!found) {
    err(`[!] 没找到可执行文件：${binPath}`);
    info(`    先装 ${t.name}，或用 MYAPI_BIN_${t.id.toUpperCase()} 指向它的路径`);
    return 1;
  }

  console.log("");
  closePrompts();
  const child = spawn(binPath, argv, {
    stdio: "inherit",
    env,
    shell: process.platform === "win32",
  });
  child.on("error", (e) => err(`[!] 启动失败：${e.message}`));
  child.on("exit", (code) => process.exit(code ?? 0));
  return null;
}
