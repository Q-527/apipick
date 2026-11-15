// run.mjs — 离线回归测试（不联网）：协议解析 / 构造 / 4×4 往返 / 事件编码。
// 跑法：node test/run.mjs   或   npm test
import assert from "node:assert/strict";
import { parseRequest } from "../src/serve/parse.mjs";
import { buildRequest } from "../src/serve/build.mjs";
import { createEmitter } from "../src/serve/emit.mjs";
import { decodeJSON } from "../src/serve/stream.mjs";
import { outboundUrl, streamUrl } from "../src/serve/build.mjs";

let pass = 0;
let fail = 0;
const t = (name, fn) => {
  try {
    fn();
    pass += 1;
    console.log(`  ok   ${name}`);
  } catch (e) {
    fail += 1;
    console.log(`  FAIL ${name}`);
    console.log(`       ${e.message}`);
  }
};

// ---------------- 入站解析 ----------------
t("anthropic: 解析 system / 文本 / 工具结果", () => {
  const ir = parseRequest("anthropic", {
    model: "m1",
    system: "你是助手",
    max_tokens: 100,
    temperature: 0.3,
    tools: [{ name: "f", description: "d", input_schema: { type: "object", properties: { a: { type: "string" } } } }],
    messages: [
      { role: "user", content: "查天气" },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "f", input: { a: "x" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "晴" }] },
    ],
  });
  assert.equal(ir.system, "你是助手");
  assert.equal(ir.maxTokens, 100);
  assert.equal(ir.tools.length, 1);
  assert.equal(ir.tools[0].name, "f");
  assert.equal(ir.messages.length, 3);
  assert.equal(ir.messages[1].blocks[0].type, "tool_use");
  assert.equal(ir.messages[1].blocks[0].input.a, "x");
  assert.equal(ir.messages[2].blocks[0].type, "tool_result");
  assert.equal(ir.messages[2].blocks[0].text, "晴");
});

t("openai: system 提到顶层，tool 消息合成 tool_result", () => {
  const ir = parseRequest("openai", {
    model: "m2",
    max_tokens: 50,
    messages: [
      { role: "system", content: "系统提示" },
      { role: "user", content: "查天气" },
      { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: '{"a":"x"}' } }] },
      { role: "tool", tool_call_id: "c1", content: "晴" },
    ],
  });
  assert.equal(ir.system, "系统提示");
  assert.equal(ir.messages.length, 3);
  assert.equal(ir.messages[1].blocks[0].type, "tool_use");
  assert.deepEqual(ir.messages[1].blocks[0].input, { a: "x" });
  assert.equal(ir.messages[2].blocks[0].toolUseId, "c1");
});

t("responses: input 数组里的 function_call / output", () => {
  const ir = parseRequest("responses", {
    model: "m3",
    instructions: "系统",
    input: [
      { role: "user", content: "查天气" },
      { type: "function_call", call_id: "k1", name: "f", arguments: '{"a":"x"}' },
      { type: "function_call_output", call_id: "k1", output: "晴" },
    ],
  });
  assert.equal(ir.system, "系统");
  assert.equal(ir.messages[0].blocks[0].text, "查天气");
  assert.equal(ir.messages[1].blocks[0].type, "tool_use");
  assert.equal(ir.messages[2].blocks[0].type, "tool_result");
  assert.equal(ir.messages[2].blocks[0].toolUseId, "k1");
});

t("gemini: contents / systemInstruction / functionCall", () => {
  const ir = parseRequest("gemini", {
    systemInstruction: { parts: [{ text: "系统" }] },
    contents: [
      { role: "user", parts: [{ text: "查天气" }] },
      { role: "model", parts: [{ functionCall: { name: "f", args: { a: "x" } } }] },
      { role: "user", parts: [{ functionResponse: { name: "f", response: { result: "晴" } } }] },
    ],
  }, { model: "gm" });
  assert.equal(ir.system, "系统");
  assert.equal(ir.model, "gm");
  assert.equal(ir.messages[1].blocks[0].type, "tool_use");
  assert.equal(ir.messages[2].blocks[0].text, "晴");
});

// ---------------- 出站构造 ----------------
t("openai: 一条 user 里的 text+tool_result 拆成 tool 消息在前", () => {
  const ir = {
    model: "m", system: "S", messages: [
      { role: "assistant", blocks: [{ type: "tool_use", id: "c1", name: "f", input: { a: 1 } }] },
      { role: "user", blocks: [{ type: "text", text: "继续" }, { type: "tool_result", toolUseId: "c1", text: "结果" }] },
    ],
    tools: [], toolChoice: null, maxTokens: 10, temperature: null, topP: null, stop: [], stream: true,
  };
  const b = buildRequest("openai", ir);
  assert.equal(b.messages[0].role, "system");
  assert.equal(b.messages[2].role, "tool");
  assert.equal(b.messages[2].tool_call_id, "c1");
  assert.equal(b.messages[3].role, "user");
  assert.equal(b.messages[3].content, "继续");
  assert.equal(b.stream_options.include_usage, true);
});

t("anthropic: max_tokens 缺省补 8192，tool_choice 映射", () => {
  const ir = {
    model: "m", system: "", messages: [{ role: "user", blocks: [{ type: "text", text: "hi" }] }],
    tools: [{ name: "f", description: "", schema: {} }], toolChoice: { name: "f" },
    maxTokens: null, temperature: null, topP: null, stop: [], stream: false,
  };
  const b = buildRequest("anthropic", ir);
  assert.equal(b.max_tokens, 8192);
  assert.deepEqual(b.tool_choice, { type: "tool", name: "f" });
});

t("gemini: tool_result 用 name 回填 functionResponse", () => {
  const ir = {
    model: "m", system: "", messages: [
      { role: "assistant", blocks: [{ type: "tool_use", id: "x1", name: "get_weather", input: {} }] },
      { role: "user", blocks: [{ type: "tool_result", toolUseId: "x1", text: "晴" }] },
    ],
    tools: [], toolChoice: null, maxTokens: null, temperature: null, topP: null, stop: [], stream: false,
  };
  const b = buildRequest("gemini", ir);
  const fr = b.contents.find((c) => c.parts.some((p) => p.functionResponse));
  assert.equal(fr.parts[0].functionResponse.name, "get_weather");
  assert.equal(fr.parts[0].functionResponse.response.result, "晴");
});

t("gemini: 剔除 schema 里不认的字段", () => {
  const ir = {
    model: "m", system: "", messages: [{ role: "user", blocks: [{ type: "text", text: "x" }] }],
    tools: [{ name: "f", description: "", schema: { type: "object", $schema: "x", properties: { a: { type: "string" } } } }],
    toolChoice: null, maxTokens: null, temperature: null, topP: null, stop: [], stream: false,
  };
  const b = buildRequest("gemini", ir);
  const decl = b.tools[0].functionDeclarations[0];
  assert.equal(decl.parameters.$schema, undefined);
  assert.equal(decl.parameters.properties.a.type, "string");
});

// ---------------- 4×4 往返 ----------------
const canonical = {
  model: "test-model",
  system: "你是测试助手",
  max_tokens: 256,
  temperature: 0.2,
  stream: false,
  tools: [{ name: "get_weather", description: "查天气", input_schema: { type: "object", properties: { city: { type: "string" } } } }],
  messages: [
    { role: "user", content: "北京天气" },
    { role: "assistant", content: [{ type: "tool_use", id: "call_1", name: "get_weather", input: { city: "北京" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "晴 18 度" }] },
    { role: "assistant", content: "北京晴，18 度。" },
  ],
};

for (const target of ["anthropic", "openai", "responses", "gemini"]) {
  t(`往返 anthropic → ${target} → IR`, () => {
    const ir1 = parseRequest("anthropic", canonical);
    const body = buildRequest(target, ir1);
    const ir2 = parseRequest(target, body);
    // 系统提示
    assert.equal(ir2.system, "你是测试助手");
    // 工具定义
    assert.equal(ir2.tools.length, 1);
    assert.equal(ir2.tools[0].name, "get_weather");
    // 工具调用与结果
    const use = ir2.messages.flatMap((m) => m.blocks).find((b) => b.type === "tool_use");
    const res = ir2.messages.flatMap((m) => m.blocks).find((b) => b.type === "tool_result");
    assert.ok(use, "tool_use 丢了");
    assert.equal(use.name, "get_weather");
    assert.equal(use.input.city, "北京");
    assert.ok(res, "tool_result 丢了");
    assert.equal(res.text, "晴 18 度");
    // 最后一条 assistant 文本
    const texts = ir2.messages.filter((m) => m.role === "assistant").flatMap((m) => m.blocks).filter((b) => b.type === "text");
    assert.ok(texts.some((b) => b.text.includes("18")));
  });
}

// ---------------- 事件编码 ----------------
const events = [
  { type: "start" },
  { type: "usage", input: 12, output: 0 },
  { type: "text", text: "你好" },
  { type: "tool_start", slot: 0, id: "c1", name: "get_weather" },
  { type: "tool_args", slot: 0, partial: '{"city":' },
  { type: "tool_args", slot: 0, partial: '"北京"}' },
  { type: "usage", input: 12, output: 30 },
  { type: "finish", reason: "tool_use" },
];

t("emit anthropic: 事件流结构完整", () => {
  const em = createEmitter("anthropic", { model: "m" });
  let s = "";
  for (const e of events) s += em.push(e);
  s += em.end();
  assert.ok(s.includes("event: message_start"));
  assert.ok(s.includes('"type":"text_delta","text":"你好"'));
  assert.ok(s.includes('"type":"tool_use"'));
  assert.ok(s.includes('"stop_reason":"tool_use"'));
  assert.ok(s.includes("event: message_stop"));
  const j = em.toJSON();
  assert.equal(j.content[0].text, "你好");
  assert.deepEqual(j.content[1].input, { city: "北京" });
  assert.equal(j.stop_reason, "tool_use");
});

t("emit openai: 分片参数原样转发，最后带 usage 与 DONE", () => {
  const em = createEmitter("openai", { model: "m" });
  let s = "";
  for (const e of events) s += em.push(e);
  s += em.end();
  assert.ok(s.includes('"tool_calls"'));
  assert.ok(s.includes('{\\"city\\":'));
  assert.ok(s.includes("data: [DONE]"));
  const j = em.toJSON();
  assert.equal(j.choices[0].message.content, "你好");
  assert.equal(j.choices[0].message.tool_calls[0].function.name, "get_weather");
  assert.deepEqual(JSON.parse(j.choices[0].message.tool_calls[0].function.arguments), { city: "北京" });
  assert.equal(j.choices[0].finish_reason, "tool_calls");
});

t("emit responses: 事件名齐全，output 结构可用", () => {
  const em = createEmitter("responses", { model: "m" });
  let s = "";
  for (const e of events) s += em.push(e);
  s += em.end();
  assert.ok(s.includes("event: response.output_text.delta"));
  assert.ok(s.includes("event: response.function_call_arguments.delta"));
  assert.ok(s.includes("event: response.completed"));
  const j = em.toJSON();
  const fc = j.output.find((o) => o.type === "function_call");
  assert.equal(fc.name, "get_weather");
  assert.deepEqual(JSON.parse(fc.arguments), { city: "北京" });
  assert.equal(j.usage.input_tokens, 12);
});

t("emit gemini: functionCall 完整参数 + finishReason", () => {
  const em = createEmitter("gemini", { model: "m" });
  let s = "";
  for (const e of events) s += em.push(e);
  s += em.end();
  assert.ok(s.includes('"finishReason":"STOP"'));
  const j = em.toJSON();
  const fc = j.candidates[0].content.parts.find((p) => p.functionCall);
  assert.deepEqual(fc.functionCall.args, { city: "北京" });
  assert.equal(j.usageMetadata.promptTokenCount, 12);
});

// ---------------- 上游 JSON 解码 ----------------
t("decodeJSON: 四种上游格式都能还原成事件", () => {
  const cases = {
    anthropic: { content: [{ type: "text", text: "hi" }], stop_reason: "end_turn", usage: { input_tokens: 5, output_tokens: 2 } },
    openai: { choices: [{ message: { content: "hi" }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 2 } },
    responses: { output: [{ type: "message", content: [{ type: "output_text", text: "hi" }] }], usage: { input_tokens: 5, output_tokens: 2 } },
    gemini: { candidates: [{ content: { parts: [{ text: "hi" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2 } },
  };
  for (const [proto, json] of Object.entries(cases)) {
    const evs = [...decodeJSON(proto, json)];
    assert.ok(evs.some((e) => e.type === "text" && e.text === "hi"), `${proto} 没解析出文本`);
    assert.ok(evs.some((e) => e.type === "finish"), `${proto} 没解析出结束`);
    const u = evs.find((e) => e.type === "usage");
    assert.ok(u && u.input === 5, `${proto} usage 不对`);
  }
});

// ---------------- URL 拼接 ----------------
t("URL: 带版本号不重复补，Gemini 走 v1beta + alt=sse", () => {
  assert.equal(outboundUrl("anthropic", "https://x.com", "m"), "https://x.com/v1/messages");
  assert.equal(outboundUrl("anthropic", "https://x.com/v1", "m"), "https://x.com/v1/messages");
  assert.equal(outboundUrl("openai", "https://x.com/v1", "m"), "https://x.com/v1/chat/completions");
  assert.equal(outboundUrl("openai", "https://x.com", "m"), "https://x.com/v1/chat/completions");
  assert.equal(outboundUrl("gemini", "https://x.com", "gemini-2.0"), "https://x.com/v1beta/models/gemini-2.0:generateContent");
  assert.equal(streamUrl("gemini", "https://x.com", "g"), "https://x.com/v1beta/models/g:streamGenerateContent?alt=sse");
});

console.log("");
console.log(`  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
