// core.mjs — providers (builtin + custom), config store, model probe/cache.
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

// ---------- config home ----------
export function homeDir() { return process.env.APIPICK_HOME || join(homedir(), ".apipick"); }
function ensureHome() { const d = homeDir(); if (!existsSync(d)) mkdirSync(d, { recursive: true }); return d; }
const keysPath = () => join(homeDir(), "keys.json");
const statePath = () => join(homeDir(), "state.json");
const customPath = () => join(homeDir(), "providers.json");
const cachePath = () => join(homeDir(), "models.cache.json");

function readJson(file, fallback) { try { return JSON.parse(readFileSync(file, "utf8")); } catch { return fallback; } }
export function loadCustomProviders() { return readJson(customPath(), {}); }
export function saveCustomProviders(obj) { ensureHome(); writeFileSync(customPath(), JSON.stringify(obj, null, 2)); }
export function loadProviders() {
  const builtin = readJson(join(HERE, "providers.json"), {});
  const custom = loadCustomProviders();
  const out = {};
  for (const [id, p] of Object.entries(builtin)) out[id] = { ...p, custom: false };
  for (const [id, p] of Object.entries(custom)) out[id] = { ...p, custom: true };
  return out;
}
export function providerList() { return Object.values(loadProviders()); }
export function resolveProvider(idOrAlias) {
  if (!idOrAlias) return null;
  const all = providerList();
  const k = String(idOrAlias).toLowerCase();
  return all.find((p) => p.id === k)
    || all.find((p) => (p.name || "").toLowerCase() === k)
    || (() => { const matches = all.filter((p) => k.length >= 2 && p.id.startsWith(k)); return matches.length === 1 ? matches[0] : null; })();
}
export function saveCustomProvider(p) { const all = loadCustomProviders(); all[p.id] = { ...(all[p.id] || {}), ...p, id: p.id, custom: true }; saveCustomProviders(all); return all[p.id]; }
export function deleteCustomProvider(id) {
  const all = loadCustomProviders();
  if (!all[id]) return false;
  delete all[id]; saveCustomProviders(all);
  const cache = loadModelCache(); if (cache[id]) { delete cache[id]; saveModelCache(cache); }
  const keys = loadKeys(); if (keys[id]) { delete keys[id]; saveKeys(keys); }
  return true;
}

export function loadKeys() { return readJson(keysPath(), {}); }
export function saveKeys(obj) { ensureHome(); writeFileSync(keysPath(), JSON.stringify(obj, null, 2), { mode: 0o600 }); try { chmodSync(keysPath(), 0o600); } catch { /* windows no-op */ } }
export function getKey(id) { return loadKeys()[id] || ""; }
export function setKey(id, value) { const k = loadKeys(); k[id] = value; saveKeys(k); }
export function hasKey(id) { return !!getKey(id); }
export function loadState() { return readJson(statePath(), { current: {} }) || { current: {} }; }
export function saveState(obj) { ensureHome(); writeFileSync(statePath(), JSON.stringify(obj, null, 2)); }
export function getCurrent(id) { const s = loadState(); return (s.current && s.current[id]) || ""; }
export function setCurrent(id, model) { const s = loadState(); if (!s.current) s.current = {}; s.current[id] = model; s.lastProvider = id; saveState(s); }
export function getLast() { return loadState().lastProvider || ""; }
export function setLast(id) { const s = loadState(); s.lastProvider = id; saveState(s); }
export function getTarget() { return loadState().target || "claude"; }
export function setTarget(id) { const s = loadState(); s.target = id; saveState(s); }

const BAD = /embed|rerank|bge-|gte-|asr|ocr|tts|whisper|clip|omni|moderation|guard|cosine|similarity|stable-diffusion|flux|sdxl|text-to-image|image-/i;
export function isChatModel(m) { return !!m && !BAD.test(m) && !/^(text-|davinci|babbage|ada$)/.test(m); }
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
  if (providerId === "ol" || providerId === "ms") return "免费";
  if (providerId === "glm") { if (model === "glm-4.7-flash") return "免费"; if (model === "glm-5.3-flash" || model === "glm-5.3-flashx") return "赠包"; return "付费"; }
  if (providerId === "sf") { if (/^Pro\//.test(model)) return "付费"; const m = model.match(/(\d+(?:\.\d+)?)B/); if (m && parseFloat(m[1]) <= 9) return "免费"; return "付费"; }
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
  if (/128K|1M|256K|Ling/i.test(model)) t.push("长文本");
  return t.length ? t.join("·") : "通用对话";
}
export function modelPool(provider, remote = []) { const cached = getCachedModels(provider.id); const cur = getCurrent(provider.id); return [...new Set([...remote, ...(provider.known || []), ...cached, cur].filter(isChatModel))]; }
export function loadModelCache() { return readJson(cachePath(), {}); }
function saveModelCache(obj) { ensureHome(); writeFileSync(cachePath(), JSON.stringify(obj, null, 2)); }
export function getCachedModels(id) { const e = loadModelCache()[id]; return (e && e.models) || []; }
export function setCachedModels(id, models, endpoint) { const c = loadModelCache(); c[id] = { endpoint: endpoint || "", at: new Date().toISOString(), models }; saveModelCache(c); }
export function cacheInfo(id) { return loadModelCache()[id] || null; }

// ---------- endpoint guessing and model discovery ----------
export function guessModelEndpoints(baseUrl) {
  const out = []; const push = (u) => { if (u && !out.includes(u)) out.push(u); };
  try {
    const u = new URL(baseUrl); const origin = u.origin;
    let p = (u.pathname || "").replace(/\/+$/, "").replace(/\/anthropic$/i, "").replace(/\/apps$/i, "");
    if (/\/v\d+[a-z]*$/i.test(p)) push(`${origin}${p}/models`);
    else { push(`${origin}${p}/v1/models`); push(`${origin}${p}/models`); }
    push(`${origin}/v1/models`); push(`${origin}/models`); push(`${origin}/api/tags`);
  } catch { /* invalid URL */ }
  return out;
}
function pickModelIds(json) {
  if (!json) return [];
  if (Array.isArray(json)) return json.map((x) => typeof x === "string" ? x : x && (x.id || x.name || x.model));
  const arr = json.data || json.models || json.result || json.list || [];
  if (Array.isArray(arr)) return arr.map((x) => typeof x === "string" ? x : x && (x.id || x.name || x.model));
  return arr && typeof arr === "object" ? Object.keys(arr) : [];
}
async function tryFetch(url, headers, timeoutMs) {
  const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers, signal: ctrl.signal });
    if (!res.ok) return { ok: false, status: res.status };
    let json; try { json = JSON.parse(await res.text()); } catch { return { ok: false, status: "not-json" }; }
    return { ok: true, json };
  } catch (e) { return { ok: false, status: e?.name === "AbortError" ? "timeout" : "network" }; }
  finally { clearTimeout(timer); }
}
export async function probeModels({ baseUrl, modelsEndpoint, key, timeoutMs = 8000, budgetMs = 15000 }) {
  const candidates = [];
  if (modelsEndpoint) candidates.push(modelsEndpoint);
  for (const url of guessModelEndpoints(baseUrl || "")) if (!candidates.includes(url)) candidates.push(url);
  if (!candidates.length) return { models: [], endpoint: "", error: "没有可用的 Base URL" };
  let lastErr = ""; const started = Date.now();
  for (const url of candidates) {
    const left = budgetMs - (Date.now() - started);
    if (left < 1200) { lastErr ||= "探测超时"; break; }
    const headers = { "User-Agent": "apipick", Accept: "application/json" };
    if (key) headers.Authorization = `Bearer ${key}`;
    let result = await tryFetch(url, headers, Math.min(timeoutMs, left));
    if (!result.ok && key && [400, 401, 403].includes(result.status)) {
      const left2 = budgetMs - (Date.now() - started);
      if (left2 > 1200) result = await tryFetch(url, { ...headers, "x-api-key": key, "anthropic-version": "2023-06-01" }, Math.min(timeoutMs, left2));
    }
    if (!result.ok) { lastErr = `${url} -> ${result.status}`; continue; }
    const models = [...new Set(pickModelIds(result.json).filter(Boolean))].filter(isChatModel);
    if (models.length) return { models, endpoint: url, error: "" };
    lastErr = `${url} -> 返回里没有模型字段`;
  }
  return { models: [], endpoint: "", error: lastErr || "全部候选端点都失败" };
}
export async function scanAndCache(provider, key, timeoutMs) {
  const result = await probeModels({ baseUrl: provider.baseUrl, modelsEndpoint: provider.modelsEndpoint, key, timeoutMs });
  if (result.models.length) setCachedModels(provider.id, result.models, result.endpoint);
  return result;
}
