// launch.mjs — 解析「哪个渠道 + 哪个模型 + 启动哪个 CLI」，然后交给 targets 层。
import { readFileSync, existsSync, readdirSync, statSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { resolveProvider, getCurrent, getKey, ctxLimit, getTarget } from "./core.mjs";
import { findTarget, endpointFor, runTarget } from "./targets.mjs";
import { c, info, warn, err } from "./ui.mjs";

function isCloudOllama(provider, model) {
  if (provider.id !== "ol") return false;
  return (provider.cloudModels || []).includes(model);
}

// read only the tail of a session file (constant time; PS Get-Content -Tail walked the whole file)
function tailLines(file, bytes = 524288) {
  try {
    const fs = readFileSync(file, { encoding: null });
    const start = Math.max(0, fs.length - bytes);
    let text = fs.subarray(start).toString("utf8");
    if (start > 0) {
      const nl = text.indexOf("\n");
      if (nl >= 0) text = text.slice(nl + 1);
    }
    return text.split(/\r?\n/);
  } catch { return []; }
}

export function contextReport(model) {
  try {
    const real = (() => { try { return realpathSync(process.cwd()); } catch { return process.cwd(); } })();
    const key = real.replace(/[^A-Za-z0-9]/g, "-");
    const dir = join(homedir(), ".claude", "projects", key);
    if (!existsSync(dir)) return;
    const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"))
      .map((f) => ({ f: join(dir, f), t: statSync(join(dir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t).slice(0, 3);
    let used = 0;
    for (const { f } of files) {
      const lines = tailLines(f).slice(-400);
      for (let i = lines.length - 1; i >= 0; i--) {
        if (!lines[i].includes('"usage"')) continue;
        let o; try { o = JSON.parse(lines[i]); } catch { continue; }
        const u = o && o.message && o.message.usage;
        if (!u) continue;
        const n = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
        if (n > 0) { used = n; break; }
      }
      if (used > 0) break;
    }
    if (!used) return;
    const limit = ctxLimit(model);
    const pct = Math.min(999, Math.round((used * 100) / limit));
    const label = `  Context : ${used.toLocaleString()} / ${limit.toLocaleString()}  (${pct}%)`;
    if (pct >= 80) {
      console.log(c.red(label));
      console.log(c.yellow("            [!] 上一个会话快满了，建议先 /compact 再开大任务"));
    } else {
      console.log(c.gray(label + "  (上一会话; 新会话从 0 开始)"));
    }
  } catch { /* best effort */ }
}

/**
 * @param providerId 渠道 id
 * @param opts.target  目标 CLI（claude / qwen / codex / gemini / aider / opencode）
 * @param opts.wire    codex 的 wire_api（responses / chat）
 */
export function launch(providerId, { model, args = [], dry = false, local = false, bin, target, wire } = {}) {
  const provider = resolveProvider(providerId);
  if (!provider) { err(`[!] 未知渠道：${providerId}`); return 1; }

  let m = model || getCurrent(provider.id) || provider.default;
  if (local) m = m.replace(/^local\//, "");
  else if (m.startsWith("local/")) { local = true; m = m.slice(6); }

  const cloudOllama = isCloudOllama(provider, m);
  // explicit `local` (from --local or local/<model>) always wins over the cloud name list
  const useLocal = local ? true : (provider.id === "ol" ? !cloudOllama : false);

  const targetId = target || getTarget() || "claude";
  const t = findTarget(targetId);
  if (!t) {
    err(`[!] 未知目标 CLI：${targetId}`);
    info("    可用：claude / qwen / codex / gemini / aider / opencode（用 api targets 查看）");
    return 1;
  }

  const key = getKey(provider.id);
  if (!useLocal && !key) {
    if (!dry) {
      err(`[!] 渠道 ${provider.id} 还没有 key。先运行：api key ${provider.id}`);
      if (provider.keyHint) info(`    获取地址：${provider.keyHint}`);
      return 1;
    }
    warn(`  [!] ${provider.id} 还没配 key（dry-run 不校验）`);
  }

  const x = {
    provider,
    model: m,
    key,
    local: useLocal,
    win: ctxLimit(m, provider),
    wire,
    endpoint: endpointFor(provider, t.proto, { local: useLocal }),
  };

  return runTarget(t.id, x, {
    args,
    dry,
    bin,
    hook: () => { if (t.id === "claude") contextReport(m); },
  });
}
