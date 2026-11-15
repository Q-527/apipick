// stream.mjs — 上游响应 → IR 事件流。
//
// IR 事件：
//   { type:"start" }
//   { type:"text",      text }
//   { type:"thinking",  text }
//   { type:"tool_start", slot, id, name }
//   { type:"tool_args", slot, partial }
//   { type:"usage",     input, output }
//   { type:"finish",    reason }        reason: end_turn | max_tokens | tool_use | stop
//   { type:"error",     message }
//
// slot 只是「上游用来区分第几个工具调用」的槽位号，下游会重新编号。

function parseSSEBlock(raw) {
  let event = "";
  const data = [];
  for (const line of raw.split("\n")) {
    if (!line || line.startsWith(":")) continue;
    const i = line.indexOf(":");
    const key = i < 0 ? line : line.slice(0, i);
    let val = i < 0 ? "" : line.slice(i + 1);
    if (val.startsWith(" ")) val = val.slice(1);
    if (key === "event") event = val;
    else if (key === "data") data.push(val);
  }
  if (!data.length) return null;
  return { event, data: data.join("\n") };
}

export async function* sseEvents(res) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf = (buf + dec.decode(value, { stream: true })).replace(/\r\n/g, "\n");
      let idx;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const ev = parseSSEBlock(raw);
        if (ev) yield ev;
      }
    }
    buf = buf.replace(/\r\n/g, "\n");
    if (buf.trim()) {
      const ev = parseSSEBlock(buf);
      if (ev) yield ev;
    }
  } finally {
    try { reader.releaseLock(); } catch { /* ignore */ }
  }
}

function j(v) {
  try { return JSON.parse(v); } catch { return null; }
}

// ---------------- 上游流解码 ----------------
export async function* decodeStream(proto, res) {
  const ct = String(res.headers.get("content-type") || "");
  // 不少中转站忽略 stream=true 直接回完整 JSON
  if (!ct.includes("event-stream")) {
    let json = null;
    try { json = await res.json(); } catch { /* fallthrough */ }
    if (json) {
      yield* decodeJSON(proto, json);
      return;
    }
    yield { type: "error", message: "上游返回了无法解析的响应体" };
    return;
  }

  if (proto === "anthropic") yield* decodeAnthropicStream(res);
  else if (proto === "openai") yield* decodeOpenAIStream(res);
  else if (proto === "responses") yield* decodeResponsesStream(res);
  else if (proto === "gemini") yield* decodeGeminiStream(res);
  else yield { type: "error", message: `不支持的出站协议：${proto}` };
}

async function* decodeAnthropicStream(res) {
  yield { type: "start" };
  for await (const ev of sseEvents(res)) {
    const d = j(ev.data);
    if (!d) continue;
    const t = d.type || ev.event;
    if (t === "message_start") {
      const u = d.message && d.message.usage;
      if (u) yield { type: "usage", input: u.input_tokens || 0, output: u.output_tokens || 0 };
    } else if (t === "content_block_start") {
      const cb = d.content_block || {};
      if (cb.type === "tool_use") {
        yield { type: "tool_start", slot: d.index ?? 0, id: cb.id, name: cb.name };
        if (cb.input && Object.keys(cb.input).length) {
          yield { type: "tool_args", slot: d.index ?? 0, partial: JSON.stringify(cb.input) };
        }
      }
    } else if (t === "content_block_delta") {
      const dl = d.delta || {};
      if (dl.type === "text_delta" && dl.text) yield { type: "text", text: dl.text };
      else if (dl.type === "thinking_delta" && dl.thinking) yield { type: "thinking", text: dl.thinking };
      else if (dl.type === "input_json_delta") yield { type: "tool_args", slot: d.index ?? 0, partial: dl.partial_json || "" };
    } else if (t === "message_delta") {
      if (d.usage) yield { type: "usage", input: d.usage.input_tokens || 0, output: d.usage.output_tokens || 0 };
      if (d.delta && d.delta.stop_reason) yield { type: "finish", reason: mapAnthropicStop(d.delta.stop_reason) };
    } else if (t === "error") {
      yield { type: "error", message: (d.error && d.error.message) || "上游 Anthropic 流返回 error" };
    }
  }
}

async function* decodeOpenAIStream(res) {
  yield { type: "start" };
  let finished = false;
  for await (const ev of sseEvents(res)) {
    const raw = ev.data.trim();
    if (raw === "[DONE]") break;
    const d = j(raw);
    if (!d) continue;
    if (d.error) {
      yield { type: "error", message: d.error.message || JSON.stringify(d.error) };
      continue;
    }
    if (d.usage) yield { type: "usage", input: d.usage.prompt_tokens || 0, output: d.usage.completion_tokens || 0 };
    for (const ch of d.choices || []) {
      const dl = ch.delta || ch.message || {};
      if (dl.reasoning_content) yield { type: "thinking", text: dl.reasoning_content };
      if (typeof dl.content === "string" && dl.content) yield { type: "text", text: dl.content };
      else if (Array.isArray(dl.content)) {
        for (const p of dl.content) if (p && p.text) yield { type: "text", text: p.text };
      }
      for (const tc of dl.tool_calls || []) {
        const slot = tc.index ?? 0;
        if (tc.id || tc.function?.name) {
          yield { type: "tool_start", slot, id: tc.id || undefined, name: tc.function?.name || undefined };
        }
        const args = tc.function?.arguments;
        if (typeof args === "string" && args) yield { type: "tool_args", slot, partial: args };
      }
      if (ch.finish_reason) {
        finished = true;
        yield { type: "finish", reason: mapOpenAIFinish(ch.finish_reason) };
      }
    }
  }
  if (!finished) yield { type: "finish", reason: "end_turn" };
}

async function* decodeResponsesStream(res) {
  yield { type: "start" };
  for await (const ev of sseEvents(res)) {
    const d = j(ev.data);
    if (!d) continue;
    const t = d.type || ev.event;
    if (t === "response.output_item.added" && d.item) {
      if (d.item.type === "function_call") {
        yield { type: "tool_start", slot: d.item.id || d.output_index || 0, id: d.item.call_id || d.item.id, name: d.item.name };
      }
    } else if (t === "response.output_text.delta") {
      if (d.delta) yield { type: "text", text: d.delta };
    } else if (t === "response.refusal.delta" && d.delta) {
      yield { type: "text", text: d.delta };
    } else if (t === "response.function_call_arguments.delta") {
      if (d.delta) yield { type: "tool_args", slot: d.item_id || d.output_index || 0, partial: d.delta };
    } else if (t === "response.completed" || t === "response.done") {
      const u = d.response && d.response.usage;
      if (u) yield { type: "usage", input: u.input_tokens || 0, output: u.output_tokens || 0 };
      yield { type: "finish", reason: "end_turn" };
    } else if (t === "response.incomplete") {
      const u = d.response && d.response.usage;
      if (u) yield { type: "usage", input: u.input_tokens || 0, output: u.output_tokens || 0 };
      yield { type: "finish", reason: "max_tokens" };
    } else if (t === "response.failed" || t === "error") {
      const err = d.response?.error || d.error || {};
      yield { type: "error", message: err.message || "上游 Responses 流失败" };
    }
  }
}

async function* decodeGeminiStream(res) {
  yield { type: "start" };
  let slot = 0;
  let sawFinish = false;
  for await (const ev of sseEvents(res)) {
    const d = j(ev.data);
    if (!d) continue;
    if (d.error) { yield { type: "error", message: d.error.message || "上游 Gemini 返回 error" }; continue; }
    const um = d.usageMetadata || d.usage_metadata;
    if (um) yield { type: "usage", input: um.promptTokenCount || 0, output: um.candidatesTokenCount || 0 };
    for (const c of d.candidates || []) {
      for (const p of c.content?.parts || []) {
        if (typeof p.text === "string" && p.text) {
          if (p.thought) yield { type: "thinking", text: p.text };
          else yield { type: "text", text: p.text };
        } else if (p.functionCall) {
          const s = slot++;
          yield { type: "tool_start", slot: s, id: p.functionCall.id, name: p.functionCall.name };
          yield { type: "tool_args", slot: s, partial: JSON.stringify(p.functionCall.args || {}) };
        }
      }
      if (c.finishReason) {
        sawFinish = true;
        yield { type: "finish", reason: mapGeminiFinish(c.finishReason) };
      }
    }
  }
  if (!sawFinish) yield { type: "finish", reason: "end_turn" };
}

// ---------------- 上游非流式 JSON 解码 ----------------
export function* decodeJSON(proto, json) {
  yield { type: "start" };
  if (proto === "anthropic") {
    yield* decodeAnthropicJSON(json);
  } else if (proto === "openai") {
    yield* decodeOpenAIJSON(json);
  } else if (proto === "responses") {
    yield* decodeResponsesJSON(json);
  } else if (proto === "gemini") {
    yield* decodeGeminiJSON(json);
  } else {
    yield { type: "error", message: `不支持的出站协议：${proto}` };
  }
}

function* decodeAnthropicJSON(json) {
  if (json.type === "error") { yield { type: "error", message: json.error?.message || "上游错误" }; return; }
  const u = json.usage || {};
  yield { type: "usage", input: u.input_tokens || 0, output: u.output_tokens || 0 };
  let slot = 0;
  for (const b of json.content || []) {
    if (b.type === "text") yield { type: "text", text: b.text || "" };
    else if (b.type === "tool_use") {
      const s = slot++;
      yield { type: "tool_start", slot: s, id: b.id, name: b.name };
      yield { type: "tool_args", slot: s, partial: JSON.stringify(b.input || {}) };
    }
  }
  yield { type: "finish", reason: mapAnthropicStop(json.stop_reason || "end_turn") };
}

function* decodeOpenAIJSON(json) {
  if (json.error) { yield { type: "error", message: json.error.message || JSON.stringify(json.error) }; return; }
  if (json.usage) yield { type: "usage", input: json.usage.prompt_tokens || 0, output: json.usage.completion_tokens || 0 };
  const ch = (json.choices || [])[0] || {};
  const msg = ch.message || {};
  if (msg.reasoning_content) yield { type: "thinking", text: msg.reasoning_content };
  if (typeof msg.content === "string" && msg.content) yield { type: "text", text: msg.content };
  let slot = 0;
  for (const tc of msg.tool_calls || []) {
    const s = slot++;
    yield { type: "tool_start", slot: s, id: tc.id, name: tc.function?.name };
    yield { type: "tool_args", slot: s, partial: tc.function?.arguments || "{}" };
  }
  yield { type: "finish", reason: mapOpenAIFinish(ch.finish_reason || (msg.tool_calls?.length ? "tool_calls" : "stop")) };
}

function* decodeResponsesJSON(json) {
  if (json.error) { yield { type: "error", message: json.error.message || "上游错误" }; return; }
  const u = json.usage || {};
  yield { type: "usage", input: u.input_tokens || 0, output: u.output_tokens || 0 };
  let slot = 0;
  for (const item of json.output || []) {
    if (item.type === "message") {
      for (const c of item.content || []) {
        if (c.type === "output_text" || c.type === "text") yield { type: "text", text: c.text || "" };
      }
    } else if (item.type === "function_call") {
      const s = slot++;
      yield { type: "tool_start", slot: s, id: item.call_id || item.id, name: item.name };
      yield { type: "tool_args", slot: s, partial: item.arguments || "{}" };
    }
  }
  yield { type: "finish", reason: json.status === "incomplete" ? "max_tokens" : "end_turn" };
}

function* decodeGeminiJSON(json) {
  if (json.error) { yield { type: "error", message: json.error.message || "上游错误" }; return; }
  const um = json.usageMetadata || {};
  yield { type: "usage", input: um.promptTokenCount || 0, output: um.candidatesTokenCount || 0 };
  const c = (json.candidates || [])[0] || {};
  let slot = 0;
  for (const p of c.content?.parts || []) {
    if (typeof p.text === "string") {
      if (p.thought) yield { type: "thinking", text: p.text };
      else yield { type: "text", text: p.text };
    } else if (p.functionCall) {
      const s = slot++;
      yield { type: "tool_start", slot: s, id: p.functionCall.id, name: p.functionCall.name };
      yield { type: "tool_args", slot: s, partial: JSON.stringify(p.functionCall.args || {}) };
    }
  }
  yield { type: "finish", reason: mapGeminiFinish(c.finishReason || "STOP") };
}

// ---------------- stop_reason 归一 ----------------
export function mapAnthropicStop(r) {
  if (r === "end_turn" || r === "stop_sequence") return "end_turn";
  if (r === "max_tokens") return "max_tokens";
  if (r === "tool_use") return "tool_use";
  return "end_turn";
}
export function mapOpenAIFinish(r) {
  if (r === "length") return "max_tokens";
  if (r === "tool_calls" || r === "function_call") return "tool_use";
  if (r === "content_filter") return "end_turn";
  return "end_turn";
}
export function mapGeminiFinish(r) {
  const s = String(r || "").toUpperCase();
  if (s === "MAX_TOKENS") return "max_tokens";
  if (s === "SAFETY" || s === "RECITATION" || s === "BLOCKLIST") return "end_turn";
  return "end_turn";
}
