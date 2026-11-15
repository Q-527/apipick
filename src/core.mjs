// core.mjs — providers (builtin + custom), config store, model probe/cache.
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

// ---------- config home ----------
// 默认 ~/.apipick，可用 APIPICK_HOME 指定。
export function homeDir() {
  return process.env.APIPICK_HOME || join(homedir(), ".apipick");
}
function ensureHome() {
  const d = homeDir();
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
  return d;
}
const keysPath = () => join(homeDir(), "keys.json");
const statePath = () => join(homeDir(), "state.json");
const customPath = () => join(homeDir(), "providers.json");
const cachePath = () => join(homeDir(), "models.cache.json");
const serveStatsPath = () => join(homeDir(), "serve-stats.json");

// ---------- providers ----------
function readJson(file, fallback) {
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return fallback; }
}

/** custom providers live in ~/.apipick/providers.json, builtin ones in src/providers.json */
export function loadCustomProviders() {
  return readJson(customPath(), {});
}

export function saveCustomProviders(obj) {
  ensureHome();
  writeFileSync(customPath(), JSON.stringify(obj, null, 2));
}

/** builtin merged with custom (custom wins on id collision) */
export function loadProviders() {
  const builtin = readJson(join(HERE, "providers.json"), {});
  const custom = loadCustomProviders();
  const out = {};
  for (const [id, p] of Object.entries(builtin)) out[id] = { ...p, custom: false };
  for (const [id, p] of Object.entries(custom)) out[id] = { ...p, custom: true };
  return out;
}

export function providerList() {
  return Object.values(loadProviders());
}

export function resolveProvider(idOrAlias) {
  if (!idOrAlias) return null;
  const all = providerList();
  const k = String(idOrAlias).toLowerCase();
  const exact = all.find((p) => p.id === k);
  if (exact) return exact;
  const byName = all.find((p) => (p.name || "").toLowerCase() === k);
  if (byName) return byName;
  // unique prefix match (e.g. "deep" -> ds), only when unambiguous
  const prefixed = all.filter((p) => k.length >= 2 && p.id.startsWith(k));
  if (prefixed.length === 1) return prefixed[0];
  return null;
}

/** add or update a custom provider, returns the stored record */
export function saveCustomProvider(p) {
  const all = loadCustomProviders();
  const id = p.id;
  all[id] = { ...(all[id] || {}), ...p, id, custom: true };
  saveCustomProviders(all);
  return all[id];
}

export function deleteCustomProvider(id) {
  const all = loadCustomProviders();
  if (!all[id]) return false;
  delete all[id];
  saveCustomProviders(all);
  // drop cached models + key
  const cache = loadModelCache();
  if (cache[id]) { delete cache[id]; saveModelCache(cache); }
  const keys = loadKeys();
  if (keys[id]) { delete keys[id]; saveKeys(keys); }
  return true;
}

// ---------- keys ----------
export function loadKeys() { return readJson(keysPath(), {}); }
export function saveKeys(obj) {
  ensureHome();
  writeFileSync(keysPath(), JSON.stringify(obj, null, 2), { mode: 0o600 });
  try { chmodSync(keysPath(), 0o600); } catch { /* windows no-op */ }
}
export function getKey(id) { return loadKeys()[id] || ""; }
export function setKey(id, value) {
  const k = loadKeys();
  k[id] = value;
  saveKeys(k);
}
export function hasKey(id) { return !!getKey(id); }

// ---------- state ----------
export function loadState() {
  return readJson(statePath(), { current: {} }) || { current: {} };
}
export function saveState(obj) {
  ensureHome();
  writeFileSync(statePath(), JSON.stringify(obj, null, 2));
}
export function getCurrent(id) {
  const s = loadState();
  return (s.current && s.current[id]) || "";
}
export function setCurrent(id, model) {
  const s = loadState();
  if (!s.current) s.current = {};
  s.current[id] = model;
  s.lastProvider = id;
  saveState(s);
}
export function getLast() { return loadState().lastProvider || ""; }
export function setLast(id) {
  const s = loadState();
  s.lastProvider = id;
  saveState(s);
}

/** 默认目标 CLI（claude / qwen / codex / gemini / aider / opencode） */
export function getTarget() { return loadState().target || "claude"; }
export function setTarget(id) {
  const s = loadState();
  s.target = id;
  saveState(s);
}

// ---------- project config ----------
export function projectConfigPath(cwd = process.cwd()) {
  return join(cwd, ".apipick.json");
}

export function loadProjectConfig(cwd = process.cwd()) {
  const fp = projectConfigPath(cwd);
  if (!existsSync(fp)) return null;
  try {
    const obj = JSON.parse(readFileSync(fp, "utf8"));
    return obj && typeof obj === "object" && !Array.isArray(obj) ? obj : null;
  } catch {
    return null;
  }
}

export function saveProjectConfig(config, cwd = process.cwd()) {
  const fp = projectConfigPath(cwd);
  writeFileSync(fp, JSON.stringify({ ...(config || {}), updatedAt: new Date().toISOString() }, null, 2) + "\n");
  return fp;
}

/** The nearest ancestor project config wins; global state remains the fallback. */
export function resolveProjectConfig(cwd = process.cwd()) {
  let cur = cwd;
  while (true) {
    const cfg = loadProjectConfig(cur);
    if (cfg) return cfg;
    const parent = dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

export function getProjectDefaults(cwd = process.cwd()) {
  const cfg = resolveProjectConfig(cwd) || {};
  return {
    provider: cfg.provider || "",
    model: cfg.model || "",
    target: cfg.target || getTarget(),
  };
}

// ---------- model capabilities ----------
const DEFAULT_CAPABILITY = { tools: false, vision: false, stream: true, reasoning: false, context: 128000 };

/**
 * Conservative name-based hints only. Providers can override these in
 * providers.json under modelCapabilities[modelId]. Unknown capabilities are
 * not advertised as supported.
 */
export function getModelCapability(model, provider = null) {
  const id = String(model || "");
  const overrides = provider?.modelCapabilities || {};
  const explicit = overrides[id];
  if (explicit && typeof explicit === "object") {
    return { ...DEFAULT_CAPABILITY, ...explicit, context: Number(explicit.context || DEFAULT_CAPABILITY.context) };
  }
  const name = id.toLowerCase();
  const vision = /vision|\bvl\b|gemini|gpt-4o|gpt-4\.1|claude-3|claude-sonnet|pixtral/i.test(name);
  const reasoning = /reason|think|\br[1-9]\b|^o[1-9]|gemini-2\.5/i.test(name);
  const tools = /gpt|claude|qwen|deepseek|glm|kimi|gemini|command-r/i.test(name);
  return {
    tools,
    vision,
    stream: true,
    reasoning,
    context: ctxLimit(id, provider),
  };
}

export function filterModelsByCapability(models = [], filters = {}, provider = null) {
  const keys = Object.entries(filters).filter(([, value]) => value !== undefined && value !== null && value !== "");
  if (!keys.length) return models;
  return models.filter((model) => {
    const cap = getModelCapability(model, provider);
    return keys.every(([key, value]) => {
      if (["tools", "vision", "stream", "reasoning"].includes(key)) return Boolean(cap[key]) === Boolean(value);
      if (key === "context") return Number(cap.context) >= Number(value);
      return true;
    });
  });
}

// ---------- serve stats ----------
export function loadServeStats() {
  return readJson(serveStatsPath(), {
    req: 0,
    ok: 0,
    fail: 0,
    inTok: 0,
    outTok: 0,
    byProvider: {},
    byModel: {},
    lastUpdated: "",
  });
}

export function saveServeStats(obj) {
  ensureHome();
  const next = {
    req: Number(obj.req) || 0,
    ok: Number(obj.ok) || 0,
    fail: Number(obj.fail) || 0,
    inTok: Number(obj.inTok) || 0,
    outTok: Number(obj.outTok) || 0,
    byProvider: obj.byProvider || {},
    byModel: obj.byModel || {},
    lastUpdated: new Date().toISOString(),
  };
  writeFileSync(serveStatsPath(), JSON.stringify(next, null, 2));
  return next;
}

export function recordServeStats({ provider, model, wire, ok = false, status = 0, inputTokens = 0, outputTokens = 0, latency = 0 } = {}) {
  const stats = loadServeStats();
  stats.req = (Number(stats.req) || 0) + 1;
  if (ok) stats.ok = (Number(stats.ok) || 0) + 1;
  else stats.fail = (Number(stats.fail) || 0) + 1;
  stats.inTok = (Number(stats.inTok) || 0) + Number(inputTokens || 0);
  stats.outTok = (Number(stats.outTok) || 0) + Number(outputTokens || 0);
  if (provider) {
    const entry = stats.byProvider?.[provider] || { req: 0, ok: 0, fail: 0, inTok: 0, outTok: 0, latency: 0 };
    entry.req += 1;
    if (ok) entry.ok += 1; else entry.fail += 1;
    entry.inTok += Number(inputTokens || 0);
    entry.outTok += Number(outputTokens || 0);
    entry.latency = (entry.latency || 0) + Number(latency || 0);
    stats.byProvider[provider] = entry;
  }
  if (model) {
    const entry = stats.byModel?.[model] || { req: 0, ok: 0, fail: 0, inTok: 0, outTok: 0, latency: 0 };
    entry.req += 1;
    if (ok) entry.ok += 1; else entry.fail += 1;
    entry.inTok += Number(inputTokens || 0);
    entry.outTok += Number(outputTokens || 0);
    entry.latency = (entry.latency || 0) + Number(latency || 0);
    stats.byModel[model] = entry;
  }
  if (wire) stats.wire = { ...(stats.wire || {}), [wire]: (stats.wire?.[wire] || 0) + 1 };
  stats.lastUpdated = new Date().toISOString();
  return saveServeStats(stats);
}

// ---------- model helpers ----------
const BAD = /embed|rerank|bge-|gte-|asr|ocr|tts|whisper|clip|omni|moderation|guard|cosine|similarity|stable-diffusion|flux|sdxl|text-to-image|image-/i;

export function isChatModel(m) {
  if (!m) return false;
  if (BAD.test(m)) return false;
  if (/^(text-|davinci|babbage|ada$)/.test(m)) return false;
  return true;
}

export function ctxLimit(model, provider) {
  if (provider && provider.ctx) return Number(provider.ctx) || 200000;
  if (/gpt-oss/i.test(model)) return 131072;
  if (/qwen/i.test(model)) return 262144;
  if (/glm-5\.3/i.test(model)) return 400000;
  if (/glm/i.test(model)) return 131072;
  if (/kimi/i.test(model)) return 262144;
  if (/deepseek/i.test(model)) return 131072;
  return 200000;
}

export function costFor(providerId, model) {
  if (providerId === "ol") return "免费";
  if (providerId === "ms") return "免费";
  if (providerId === "glm") {
    if (model === "glm-4.7-flash") return "免费";
    if (model === "glm-5.3-flash" || model === "glm-5.3-flashx") return "赠包";
    return "付费";
  }
  if (providerId === "sf") {
    if (/^Pro\//.test(model)) return "付费";
    const m = model.match(/(\d+(?:\.\d+)?)B/);
    if (m && parseFloat(m[1]) <= 9) return "免费";
    return "付费";
  }
  return "";
}

export function noteFor(provider, model) {
  if (provider.notes && provider.notes[model]) return provider.notes[model];
  const t = [];
  if (/Coder|Code/i.test(model)) t.push("代码");
  if (/R1|Reasoner|Thinking|Z1/i.test(model)) t.push("深度推理");
  if (/^Pro\//.test(model)) t.push("Pro高速");
  if (/Flash|Air|[Mm]ini/i.test(model)) t.push("快·省");
  if (/4\.5V|Vision|VL/i.test(model)) t.push("能看图");
  if (/Instruct/i.test(model)) t.push("通用");
  if (/128K|1M|256K/i.test(model)) t.push("长文本");
  if (/Ling/i.test(model)) t.push("长文本");
  return t.length ? t.join("·") : "通用对话";
}

/** remote (if any) first, then builtin known list, cache, and the currently selected model */
export function modelPool(provider, remote = []) {
  const cached = getCachedModels(provider.id);
  const cur = getCurrent(provider.id);
  const pool = [...remote, ...(provider.known || []), ...cached, cur].filter(isChatModel);
  return [...new Set(pool)];
}

// ---------- model cache ----------
export function loadModelCache() { return readJson(cachePath(), {}); }
function saveModelCache(obj) {
  ensureHome();
  writeFileSync(cachePath(), JSON.stringify(obj, null, 2));
}
export function getCachedModels(id) {
  const e = loadModelCache()[id];
  return (e && e.models) || [];
}
export function setCachedModels(id, models, endpoint) {
  const c = loadModelCache();
  c[id] = { endpoint: endpoint || "", at: new Date().toISOString(), models };
  saveModelCache(c);
}
export function cacheInfo(id) {
  return loadModelCache()[id] || null;
}

// ---------- endpoint guessing ----------
/** turn a base URL into a list of likely /models endpoints, best guess first */
export function guessModelEndpoints(baseUrl) {
  const out = [];
  const push = (u) => { if (u && !out.includes(u)) out.push(u); };
  try {
    const u = new URL(baseUrl);
    const origin = u.origin;
    let p = (u.pathname || "").replace(/\/+$/, "");
    // strip vendor-specific anthropic suffixes to reach the api root
    p = p.replace(/\/anthropic$/i, "").replace(/\/apps$/i, "");
    if (/\/v\d+[a-z]*$/i.test(p)) {
      push(`${origin}${p}/models`);           // already versioned: /v1 -> /v1/models
    } else {
      push(`${origin}${p}/v1/models`);
      push(`${origin}${p}/models`);
    }
    push(`${origin}/v1/models`);
    push(`${origin}/models`);
    push(`${origin}/api/tags`);               // ollama style
  } catch { /* bad url -> no guess */ }
  return out;
}

function pickModelIds(json) {
  if (!json) return [];
  if (Array.isArray(json)) return json.map((x) => (typeof x === "string" ? x : x && (x.id || x.name || x.model)));
  const arr = json.data || json.models || json.result || json.list || [];
  if (Array.isArray(arr)) return arr.map((x) => (typeof x === "string" ? x : x && (x.id || x.name || x.model)));
  if (arr && typeof arr === "object") return Object.keys(arr); // {models:{...}}
  return [];
}

async function tryFetch(url, headers, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers, signal: ctrl.signal });
    if (!res.ok) return { ok: false, status: res.status };
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { return { ok: false, status: "not-json" }; }
    return { ok: true, json };
  } catch (e) {
    return { ok: false, status: e && e.name === "AbortError" ? "timeout" : "network" };
  } finally {
    clearTimeout(t);
  }
}

/**
 * Probe a provider's model list. Tries the explicit endpoint first, then guesses.
 * Handles OpenAI (`data[].id`), Anthropic, and Ollama (`models[].name`) shapes.
 * Returns { models, endpoint, error }.
 */
export async function probeModels({ baseUrl, modelsEndpoint, key, timeoutMs = 8000, budgetMs = 15000 }) {
  const cands = [];
  if (modelsEndpoint) cands.push(modelsEndpoint);
  for (const g of guessModelEndpoints(baseUrl || "")) if (!cands.includes(g)) cands.push(g);
  if (!cands.length) return { models: [], endpoint: "", error: "没有可用的 Base URL" };

  let lastErr = "";
  const started = Date.now();
  for (const url of cands) {
    const left = budgetMs - (Date.now() - started);
    if (left < 1200) { lastErr = lastErr || "探测超时"; break; }
    const per = Math.min(timeoutMs, left);
    const headers = { "User-Agent": "claude-api", Accept: "application/json" };
    if (key) headers["Authorization"] = `Bearer ${key}`;
    let r = await tryFetch(url, headers, per);
    // some gateways only accept anthropic-style auth
    if (!r.ok && key && (r.status === 401 || r.status === 403 || r.status === 400)) {
      const left2 = budgetMs - (Date.now() - started);
      if (left2 > 1200) {
        r = await tryFetch(url, {
          "User-Agent": "claude-api", Accept: "application/json",
          "x-api-key": key, "anthropic-version": "2023-06-01",
          Authorization: `Bearer ${key}`,
        }, Math.min(timeoutMs, left2));
      }
    }
    if (!r.ok) { lastErr = `${url} -> ${r.status}`; continue; }
    const ids = [...new Set(pickModelIds(r.json).filter(Boolean))].filter(isChatModel);
    if (ids.length) return { models: ids, endpoint: url, error: "" };
    lastErr = `${url} -> 返回里没有模型字段`;
  }
  return { models: [], endpoint: "", error: lastErr || "全部候选端点都失败" };
}

/** convenience: probe + persist to cache */
export async function scanAndCache(provider, key, timeoutMs) {
  const r = await probeModels({
    baseUrl: provider.baseUrl, modelsEndpoint: provider.modelsEndpoint, key, timeoutMs,
  });
  if (r.models.length) setCachedModels(provider.id, r.models, r.endpoint);
  return r;
}
