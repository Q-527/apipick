// index.mjs — `apipick serve`：本地网关，把入站协议翻译成渠道真正说的协议。
import http from "node:http";
import { resolveProvider, providerList, getKey, getLast, getCurrent, modelPool, isChatModel } from "../core.mjs";
import { endpointFor } from "../targets.mjs";
import { parseRequest } from "./parse.mjs";
import { buildRequest, outboundUrl, streamUrl } from "./build.mjs";
import { decodeStream, decodeJSON } from "./stream.mjs";
import { createEmitter } from "./emit.mjs";
import { roughTokens } from "./ir.mjs";
import { c, pad } from "../ui.mjs";

const DEFAULT_PORT = 8787;
const DEFAULT_MAX_BODY = 8 * 1024 * 1024;
const DEFAULT_MAX_CONCURRENT = 32;
const DEFAULT_TIMEOUT = 300_000;

// 只有这些地址算「本机内部」，其余（0.0.0.0 / :: / 局域网 IP / 空）都会对外开放
const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost", "::ffff:127.0.0.1"]);

export function isExposed(host) {
  return !LOOPBACK.has(String(host || "").trim().toLowerCase());
}

export class PayloadTooLarge extends Error {}

// ---------------- 渠道 / 协议选择 ----------------
function looksAnthropic(base) {
  return /anthropic|\/apps\/?$/i.test(String(base || ""));
}

export function pickWire(inbound, provider, forced) {
  if (forced) return forced;
  const declared = provider.protocols;
  if (Array.isArray(declared) && declared.length) {
    return declared.includes(inbound) ? inbound : declared[0];
  }
  if (inbound === "anthropic" && looksAnthropic(provider.baseUrl)) return "anthropic";
  if (provider.endpoints?.openai) return "openai";
  if (provider.endpoints?.gemini) return "gemini";
  if (provider.baseUrl) return "anthropic";
  return inbound;
}

function splitModel(name) {
  const i = String(name || "").indexOf("/");
  if (i > 0) {
    const p = resolveProvider(name.slice(0, i));
    if (p) return { provider: p, model: name.slice(i + 1) };
  }
  return { provider: null, model: String(name || "") };
}

function defaultProvider() {
  const last = getLast();
  if (last) {
    const p = resolveProvider(last);
    if (p) return p;
  }
  const withKey = providerList().filter((p) => getKey(p.id));
  if (withKey.length) return withKey[0];
  return providerList()[0] || null;
}

function upstreamHeaders(wire, key) {
  if (wire === "anthropic") {
    return { "content-type": "application/json", "anthropic-version": "2023-06-01", "x-api-key": key };
  }
  if (wire === "gemini") {
    return { "content-type": "application/json", "x-goog-api-key": key };
  }
  return { "content-type": "application/json", authorization: `Bearer ${key}` };
}

function errorBody(inbound, status, message) {
  if (inbound === "anthropic") {
    return { type: "error", error: { type: status === 429 ? "rate_limit_error" : "api_error", message } };
  }
  if (inbound === "gemini") return { error: { code: status, message, status: "ERROR" } };
  return { error: { message, type: "upstream_error", code: status } };
}

// 流式响应已经把 200 发出去了，错误只能以事件形式送，格式得跟着入站协议走
function streamErrorChunk(inbound, status, message) {
  if (inbound === "anthropic") {
    const type = status === 429 ? "rate_limit_error" : "api_error";
    return `event: error\ndata: ${JSON.stringify({ type: "error", error: { type, message } })}\n\n`;
  }
  if (inbound === "gemini") {
    return `data: ${JSON.stringify({ error: { code: status, message, status: "INTERNAL" } })}\n\n`;
  }
  return `data: ${JSON.stringify({ error: { message, type: "upstream_error", code: status } })}\n\n`;
}

async function readBody(req, limit = DEFAULT_MAX_BODY) {
  const chunks = [];
  let size = 0;
  for await (const ch of req) {
    size += ch.length;
    if (size > limit) throw new PayloadTooLarge(`请求体超过 ${Math.round(limit / 1024 / 1024)} MiB`);
    chunks.push(ch);
  }
  return Buffer.concat(chunks).toString("utf8");
}

const sseHeaders = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-cache, no-transform",
  connection: "keep-alive",
  "x-accel-buffering": "no",
};

// ---------------- server ----------------
export function createServer(opts = {}) {
  const state = {
    port: opts.port ?? DEFAULT_PORT,
    host: opts.host || "127.0.0.1",
    provider: opts.provider ? resolveProvider(opts.provider) : null,
    wire: opts.wire || "",
    log: !!opts.log,
    prefix: opts.prefix !== false,
    token: opts.token || "",
    maxBody: opts.maxBody || DEFAULT_MAX_BODY,
    maxConcurrent: opts.maxConcurrent || DEFAULT_MAX_CONCURRENT,
    timeout: opts.timeout || DEFAULT_TIMEOUT,
    inflight: 0,
    counters: { req: 0, ok: 0, fail: 0, inTok: 0, outTok: 0 },
  };
  if (opts.provider && !state.provider) throw new Error(`未知渠道：${opts.provider}`);

  // 监听对外地址却没有 token，等于把渠道额度交给整个网络
  if (isExposed(state.host) && !state.token && !opts.allowUnauthenticated) {
    throw new Error(
      `拒绝在 ${state.host} 上无认证启动：该地址可被其他机器访问，任何人都能消耗渠道额度。\n`
      + `  加认证        --token <口令>\n`
      + `  确实不需要    --allow-unauthenticated`,
    );
  }

  const server = http.createServer((req, res) => {
    handle(req, res, state).catch((e) => {
      try {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: e.message || String(e) } }));
      } catch { /* client gone */ }
    });
  });

  return { server, state };
}

async function handle(req, res, state) {
  const url = new URL(req.url, "http://localhost");
  const path = url.pathname.replace(/\/+$/, "") || "/";

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "*",
      "access-control-allow-methods": "GET,POST,OPTIONS",
    });
    res.end();
    return;
  }

  if (path === "/" || path === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      ok: true,
      service: "apipick serve",
      provider: state.provider ? state.provider.id : "auto (model prefix or last used)",
      wire: state.wire || "auto",
      requests: state.counters.req,
    }));
    return;
  }

  // 只有显式 --token 时才校验；默认只监听 127.0.0.1，不给本机之外开门
  if (state.token) {
    const auth = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    const got = auth || String(req.headers["x-api-key"] || "");
    if (got !== state.token) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "token 不对", type: "auth_error" } }));
      return;
    }
  }

  if (state.inflight >= state.maxConcurrent) {
    res.writeHead(429, { "content-type": "application/json" });
    res.end(JSON.stringify(errorBody(inboundOf(path, req.url), 429, `并发已满（上限 ${state.maxConcurrent}）`)));
    return;
  }
  state.inflight += 1;
  try {
    await dispatch(req, res, state, path);
  } finally {
    state.inflight -= 1;
  }
}

function inboundOf(path, rawUrl) {
  const p = String(path || "");
  if (/^\/(?:v1beta|v1)\/models\/.+:(generateContent|streamGenerateContent)$/.test(p)) return "gemini";
  if (p === "/v1/messages" || p === "/messages") return "anthropic";
  if (p === "/v1/chat/completions" || p === "/chat/completions") return "openai";
  if (p === "/v1/responses" || p === "/responses") return "responses";
  return "openai";
}

async function dispatch(req, res, state, path) {
  if (path === "/v1/models" || path === "/models") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ object: "list", data: listModels(state) }));
    return;
  }

  // 兼容 Claude Code 的 token 计数端点（它只用来估上下文，不要求精确）
  if (path === "/v1/messages/count_tokens") {
    const raw = await readBody(req, state.maxBody);
    let body = {};
    try { body = JSON.parse(raw); } catch { /* ignore */ }
    const ir = parseRequest("anthropic", body);
    let chars = ir.system.length;
    for (const m of ir.messages) for (const b of m.blocks) chars += (b.text || "").length + 8;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ input_tokens: roughTokens("x".repeat(chars)) || 1 }));
    return;
  }

  // 模型名允许带 %2F（ms/Qwen/xxx 这种带斜杠的写法）
  const gm = /^\/(?:v1beta|v1)\/models\/(.+):(generateContent|streamGenerateContent)$/.exec(path);
  let inbound = "";
  let modelFromPath = "";
  if (gm) { inbound = "gemini"; modelFromPath = decodeURIComponent(gm[1]); }
  else if (path === "/v1/messages" || path === "/messages") inbound = "anthropic";
  else if (path === "/v1/chat/completions" || path === "/chat/completions") inbound = "openai";
  else if (path === "/v1/responses" || path === "/responses") inbound = "responses";

  if (!inbound) {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: `没有这个路径：${path}` } }));
    return;
  }
  if (req.method !== "POST") {
    res.writeHead(405, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "只接受 POST" } }));
    return;
  }

  const started = Date.now();
  state.counters.req += 1;

  let ir;
  try {
    const raw = await readBody(req, state.maxBody);
    const body = JSON.parse(raw || "{}");
    ir = parseRequest(inbound, body, { model: modelFromPath });
  } catch (e) {
    state.counters.fail += 1;
    const status = e instanceof PayloadTooLarge ? 413 : 400;
    const why = status === 413 ? e.message : `请求体解析失败：${e.message}`;
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(errorBody(inbound, status, why)));
    return;
  }

  // Gemini 的流式由路径决定
  if (inbound === "gemini") ir.stream = gm[2] === "streamGenerateContent" || !!ir.stream;

  // ---- 选渠道 ----
  let provider = state.provider;
  let model = ir.model;
  if (!provider && state.prefix) {
    const s = splitModel(ir.model);
    if (s.provider) { provider = s.provider; model = s.model; }
  }
  if (!provider) provider = defaultProvider();
  if (!provider) {
    res.writeHead(503, { "content-type": "application/json" });
    res.end(JSON.stringify(errorBody(inbound, 503, "没有可用渠道，先跑 apipick add 加一个")));
    return;
  }
  if (!model) model = getCurrent(provider.id) || (provider.known && provider.known[0]) || "";

  const wire = pickWire(inbound, provider, state.wire);
  const key = getKey(provider.id) || (provider.id === "ol" ? "ollama" : "");
  const base = endpointFor(provider, wire, { local: provider.id === "ol" });
  if (!base) {
    res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify(errorBody(inbound, 502, `渠道 ${provider.id} 没有 ${wire} 协议的端点，用 --wire 指定`)));
    return;
  }

  ir.model = model;
  const outBody = buildRequest(wire, ir);
  const target = ir.stream ? streamUrl(wire, base, model) : outboundUrl(wire, base, model);

  // 客户端断开、上游卡住，都要有人踩刹车，否则连接和内存会一直挂着
  const ac = new AbortController();
  let abortWhy = "";
  const halt = (why) => {
    if (ac.signal.aborted) return;
    abortWhy = why;
    ac.abort();
  };
  const budget = `上游 ${Math.round(state.timeout / 1000)} 秒无响应`;
  let idleTimer = setTimeout(() => halt(budget), state.timeout);
  idleTimer.unref?.();
  const touch = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => halt(budget), state.timeout);
    idleTimer.unref?.();
  };
  const stopClock = () => clearTimeout(idleTimer);
  const onClientGone = () => { if (!res.writableEnded) halt("客户端已断开"); };
  res.once("close", onClientGone);
  const statusOf = () => (abortWhy === "客户端已断开" ? 499 : 502);

  let upstream;
  try {
    upstream = await fetch(target, {
      method: "POST",
      headers: upstreamHeaders(wire, key),
      body: JSON.stringify(outBody),
      signal: ac.signal,
    });
  } catch (e) {
    stopClock();
    state.counters.fail += 1;
    try {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify(errorBody(inbound, 502, `连不上上游：${abortWhy || e.message}`)));
    } catch { /* client gone */ }
    logLine(state, { inbound, provider, wire, model, status: statusOf(), ms: Date.now() - started });
    return;
  }

  if (!upstream.ok) {
    stopClock();
    const text = await upstream.text().catch(() => "");
    let msg = text;
    try { const j = JSON.parse(text); msg = j.error?.message || j.error?.msg || j.message || text; } catch { /* keep raw */ }
    state.counters.fail += 1;
    try {
      res.writeHead(upstream.status, { "content-type": "application/json" });
      res.end(JSON.stringify(errorBody(inbound, upstream.status, String(msg).slice(0, 800))));
    } catch { /* client gone */ }
    logLine(state, { inbound, provider, wire, model, status: upstream.status, ms: Date.now() - started });
    return;
  }

  const em = createEmitter(inbound, { model });

  if (!ir.stream) {
    let json = null;
    try {
      if (String(upstream.headers.get("content-type") || "").includes("event-stream")) {
        // 上游硬要流式：先聚合
        for await (const ev of decodeStream(wire, upstream)) {
          touch();
          if (ev.type === "error") throw new Error(ev.message || "上游返回错误事件");
          em.push(ev);
        }
        json = em.toJSON();
      } else {
        json = await upstream.json();
        for (const ev of decodeJSON(wire, json)) em.push(ev);
        json = em.toJSON();
      }
    } catch (e) {
      stopClock();
      state.counters.fail += 1;
      try {
        res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify(errorBody(inbound, 502, `上游响应解析失败：${abortWhy || e.message}`)));
      } catch { /* client gone */ }
      logLine(state, { inbound, provider, wire, model, status: statusOf(), ms: Date.now() - started });
      return;
    }
    stopClock();
    state.counters.ok += 1;
    state.counters.inTok += json?.usage?.input_tokens || json?.usage?.prompt_tokens || json?.usageMetadata?.promptTokenCount || 0;
    state.counters.outTok += json?.usage?.output_tokens || json?.usage?.completion_tokens || json?.usageMetadata?.candidatesTokenCount || 0;
    try {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(json));
    } catch { /* client gone */ }
    logLine(state, { inbound, provider, wire, model, status: 200, ms: Date.now() - started, usage: json?.usage || json?.usageMetadata });
    return;
  }

  // ---- 流式 ----
  res.writeHead(200, sseHeaders);
  let usage = null;
  let finished = false;
  try {
    for await (const ev of decodeStream(wire, upstream)) {
      touch();
      if (ev.type === "usage") usage = { input: ev.input, output: ev.output };
      if (ev.type === "error") throw new Error(ev.message || "上游返回错误事件");
      const chunk = em.push(ev);
      if (chunk) res.write(chunk);
    }
    const tail = em.end();
    if (tail) res.write(tail);
    finished = true;
  } catch (e) {
    const why = abortWhy || e.message || String(e);
    try { res.write(streamErrorChunk(inbound, statusOf(), why)); } catch { /* client gone */ }
  } finally {
    stopClock();
    try { res.end(); } catch { /* gone */ }
    if (finished) {
      state.counters.ok += 1;
      if (usage) { state.counters.inTok += usage.input || 0; state.counters.outTok += usage.output || 0; }
      logLine(state, { inbound, provider, wire, model, status: 200, ms: Date.now() - started, usage });
    } else {
      state.counters.fail += 1;
      logLine(state, { inbound, provider, wire, model, status: statusOf(), ms: Date.now() - started, usage });
    }
  }
}

function listModels(state) {
  const data = [];
  const push = (p, list) => {
    for (const m of list) {
      data.push({
        id: state.prefix ? `${p.id}/${m}` : m,
        object: "model",
        created: 0,
        owned_by: p.id,
      });
    }
  };
  const providers = state.provider ? [state.provider] : providerList();
  for (const p of providers) {
    const pool = modelPool(p).filter(isChatModel);
    if (pool.length) push(p, pool);
  }
  return data;
}

function logLine(state, info) {
  if (!state.log) return;
  const t = new Date().toTimeString().slice(0, 8);
  const ms = `${info.ms}ms`;
  const st = info.status >= 400 ? c.red(String(info.status)) : c.green(String(info.status));
  const usage = info.usage
    ? ` ${c.gray("↑" + (info.usage.input ?? info.usage.input_tokens ?? info.usage.promptTokenCount ?? 0) + " ↓" + (info.usage.output ?? info.usage.output_tokens ?? info.usage.candidatesTokenCount ?? 0))}`
    : "";
  console.log(
    `${c.gray(t)}  ${c.cyan(pad(info.inbound, 9))} ${c.gray("→")} ${c.yellow(pad(info.provider.id, 6))}`
    + ` ${c.gray(pad(`[${info.wire}]`, 11))} ${c.white(pad(info.model, 26))} ${st} ${c.gray(ms)}${usage}`,
  );
}

export function startServer(opts = {}) {
  const { server, state } = createServer(opts);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(state.port, state.host, () => {
      resolve({ server, state });
    });
  });
}
