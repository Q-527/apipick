// serve.mjs — HTTP 层回归测试：认证、请求体上限、并发闸门、上游超时、流式失败统计、
// 配置文件损坏保护。全部走本地回环 + 假上游，不联网。
// 跑法：node test/serve.mjs
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

// 必须在导入业务模块之前定好隔离目录，否则会读到真实渠道与密钥
const HOME = mkdtempSync(join(tmpdir(), "apipick-serve-"));
process.env.APIPICK_HOME = HOME;
process.env.OPENCODE_CONFIG = join(HOME, "opencode.json");
mkdirSync(HOME, { recursive: true });

let pass = 0;
let fail = 0;
const t = async (name, fn) => {
  try {
    await fn();
    pass += 1;
    console.log(`  ok   ${name}`);
  } catch (e) {
    fail += 1;
    console.log(`  FAIL ${name}`);
    console.log(`       ${e.message}`);
  }
};

// ---------------- 假上游 ----------------
const seen = [];
const upstream = http.createServer(async (req, res) => {
  let body = "";
  for await (const ch of req) body += ch;
  let parsed = {};
  try { parsed = JSON.parse(body); } catch { /* ignore */ }
  const model = String(parsed.model || "");
  seen.push(model);

  if (model.includes("slow")) await new Promise((r) => setTimeout(r, 1500));
  if (model.includes("boom")) {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "上游炸了" } }));
    return;
  }
  if (parsed.stream) {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n');
    if (model.includes("stream-error")) {
      res.write('data: {"error":{"message":"流中断"}}\n\n');
    } else {
      res.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n');
    }
    try { res.end("data: [DONE]\n\n"); } catch { /* client gone */ }
    return;
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({
    choices: [{ message: { role: "assistant", content: "pong" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 2, completion_tokens: 1 },
  }));
});
await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
const upPort = upstream.address().port;

const { createServer, isExposed } = await import("../src/serve/index.mjs");
const { TARGETS } = await import("../src/targets.mjs");

writeFileSync(join(HOME, "providers.json"), JSON.stringify({
  localtest: {
    id: "localtest",
    name: "本地假上游",
    baseUrl: `http://127.0.0.1:${upPort}`,
    endpoints: { openai: `http://127.0.0.1:${upPort}/v1` },
    known: ["pong", "boom-model", "slow-model", "stream-error"],
    protocols: ["openai"],
  },
}, null, 2));

// ---------------- 工具 ----------------
async function boot(opts = {}) {
  const { server, state } = createServer({ provider: "localtest", ...opts });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    state,
    port: server.address().port,
    close: () => new Promise((r) => {
      server.closeAllConnections?.();
      server.close(r);
    }),
  };
}

function post(port, path, body, headers = {}) {
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  return new Promise((resolve) => {
    const req = http.request({
      hostname: "127.0.0.1",
      port,
      path,
      method: "POST",
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload), ...headers },
    }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (c) => { data += c; });
      res.on("end", () => resolve({ status: res.statusCode, text: data }));
    });
    req.on("error", (e) => resolve({ status: 0, error: e.message }));
    req.end(payload);
  });
}

const msg = (model, extra = {}) => ({ model, max_tokens: 32, messages: [{ role: "user", content: "hi" }], ...extra });

// ---------------- 用例 ----------------

await t("isExposed：只有回环地址算内部", () => {
  for (const h of ["127.0.0.1", "::1", "localhost", "::ffff:127.0.0.1"]) assert.equal(isExposed(h), false, `${h} 不该算对外`);
  for (const h of ["0.0.0.0", "::", "192.168.1.5", "", "0:0:0:0:0:0:0:0"]) assert.equal(isExposed(h), true, `${h} 该算对外`);
});

await t("对外地址没有 token 时拒绝启动", () => {
  for (const host of ["0.0.0.0", "::", "192.168.1.5"]) {
    assert.throws(() => createServer({ provider: "localtest", host }), /拒绝在 .* 上无认证启动/, `${host} 应当被拒`);
  }
});

await t("对外地址给了 token 或显式放行才能启动", () => {
  for (const opts of [{ token: "s3cret" }, { allowUnauthenticated: true }]) {
    const { server } = createServer({ provider: "localtest", host: "0.0.0.0", ...opts });
    server.close();
  }
});

await t("设了 token 就必须带对凭证", async () => {
  const s = await boot({ token: "s3cret" });
  try {
    const noAuth = await post(s.port, "/v1/messages", msg("pong"));
    assert.equal(noAuth.status, 401, "无凭证应 401");
    const wrong = await post(s.port, "/v1/messages", msg("pong"), { authorization: "Bearer nope" });
    assert.equal(wrong.status, 401, "错凭证应 401");
    const bearer = await post(s.port, "/v1/messages", msg("pong"), { authorization: "Bearer s3cret" });
    assert.equal(bearer.status, 200, "正确 Bearer 应放行");
    const xkey = await post(s.port, "/v1/messages", msg("pong"), { "x-api-key": "s3cret" });
    assert.equal(xkey.status, 200, "x-api-key 也应放行");
  } finally { await s.close(); }
});

await t("请求体超过上限返回 413，不落成 400", async () => {
  const s = await boot({ maxBody: 2048 });
  try {
    const small = await post(s.port, "/v1/messages", msg("pong"));
    assert.equal(small.status, 200, "小请求应正常");
    const big = await post(s.port, "/v1/messages", msg("pong", { pad: "x".repeat(8192) }));
    assert.equal(big.status, 413, `超限应为 413，实际 ${big.status}`);
  } finally { await s.close(); }
});

await t("并发到顶返回 429，而不是无限接单", async () => {
  const s = await boot({ maxConcurrent: 1 });
  try {
    const [a, b] = await Promise.all([
      post(s.port, "/v1/messages", msg("slow-model")),
      new Promise((r) => setTimeout(r, 60)).then(() => post(s.port, "/v1/messages", msg("pong"))),
    ]);
    assert.equal(a.status, 200, `占用槽位的请求应完成，实际 ${a.status}`);
    assert.equal(b.status, 429, `第二个应为 429，实际 ${b.status}`);
  } finally { await s.close(); }
});

await t("上游长时间没动静会断开并记失败", async () => {
  const s = await boot({ timeout: 300 });
  try {
    const started = Date.now();
    const r = await post(s.port, "/v1/messages", msg("slow-model"));
    const spent = Date.now() - started;
    assert.equal(r.status, 502, `超时应 502，实际 ${r.status}`);
    assert.ok(spent < 1400, `应在超时附近返回，实际 ${spent}ms`);
    assert.equal(s.state.counters.fail, 1, "失败计数应为 1");
    assert.equal(s.state.counters.ok, 0, "成功计数不该被加");
  } finally { await s.close(); }
});

await t("流式成功：计数为成功，且能收到文本", async () => {
  const s = await boot();
  try {
    const r = await post(s.port, "/v1/messages", msg("pong", { stream: true }));
    assert.equal(r.status, 200);
    assert.ok(r.text.includes("hi"), "应收到上游文本");
    assert.equal(s.state.counters.ok, 1, "成功计数应为 1");
    assert.equal(s.state.counters.fail, 0, "失败计数应为 0");
  } finally { await s.close(); }
});

await t("流式中途出错：不计成功，错误事件按 Anthropic 格式发", async () => {
  const s = await boot();
  try {
    const r = await post(s.port, "/v1/messages", msg("stream-error", { stream: true }));
    assert.equal(r.status, 200, "流已开始，状态码仍是 200");
    assert.ok(r.text.includes("event: error"), `应发 Anthropic error 事件，实际：${r.text.slice(-200)}`);
    assert.ok(!r.text.includes("data: {\"error\":{\"message\""), "不该发裸 OpenAI 格式");
    assert.equal(s.state.counters.ok, 0, "失败不该计入成功");
    assert.equal(s.state.counters.fail, 1, "失败计数应为 1");
  } finally { await s.close(); }
});

await t("流式出错时 OpenAI 入站拿 OpenAI 格式", async () => {
  const s = await boot();
  try {
    const r = await post(s.port, "/v1/chat/completions", msg("stream-error", { stream: true }));
    assert.ok(!r.text.includes("event: error"), "OpenAI 下游不该出现 Anthropic 事件名");
    assert.ok(r.text.includes("\"error\""), "应带 error 字段");
    assert.equal(s.state.counters.ok, 0);
  } finally { await s.close(); }
});

await t("上游 5xx 原样透传状态并计失败", async () => {
  const s = await boot();
  try {
    const r = await post(s.port, "/v1/messages", msg("boom-model"));
    assert.equal(r.status, 500, `应透传 500，实际 ${r.status}`);
    assert.equal(s.state.counters.fail, 1);
    assert.equal(s.state.counters.ok, 0);
  } finally { await s.close(); }
});

await t("OpenCode 配置损坏时中止写入，原文件不变", () => {
  const opencode = TARGETS.find((t2) => t2.id === "opencode");
  const cfgPath = process.env.OPENCODE_CONFIG;
  mkdirSync(dirname(cfgPath), { recursive: true });
  const broken = '{ "provider": { 这里坏了 ';
  writeFileSync(cfgPath, broken);

  const x = {
    provider: { id: "localtest", name: "本地假上游" },
    model: "pong",
    endpoint: `http://127.0.0.1:${upPort}/v1`,
    win: 128000,
  };
  assert.throws(() => opencode.render(x), /不是合法 JSON/);
  assert.throws(() => opencode.files(x), /不是合法 JSON/);
  assert.equal(readFileSync(cfgPath, "utf8"), broken, "原文件必须一个字节都没变");
});

await t("OpenCode 配置合法时保留已有内容再合并", () => {
  const opencode = TARGETS.find((t2) => t2.id === "opencode");
  const cfgPath = process.env.OPENCODE_CONFIG;
  writeFileSync(cfgPath, JSON.stringify({ theme: "keep-me", provider: { other: { name: "别动" } } }));
  const x = {
    provider: { id: "localtest", name: "本地假上游" },
    model: "pong",
    endpoint: `http://127.0.0.1:${upPort}/v1`,
    win: 128000,
  };
  const { content } = opencode.render(x);
  const cfg = JSON.parse(content);
  assert.equal(cfg.theme, "keep-me", "无关字段应保留");
  assert.equal(cfg.provider.other.name, "别动", "别人的 provider 应保留");
  assert.ok(cfg.provider["apipick-localtest"], "应写入本工具的 provider");
  assert.equal(cfg.model, "apipick-localtest/pong");
});

await new Promise((r) => upstream.close(r));

console.log("");
console.log(`  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
