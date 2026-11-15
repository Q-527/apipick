// parse.mjs — 入站请求：四种协议 → IR。
import { emptyRequest, toBlocks, textOf, toolResultText, splitDataUrl, newId } from "./ir.mjs";

function safeJson(v) {
  if (v == null || v === "") return {};
  if (typeof v === "object") return v;
  try {
    const o = JSON.parse(String(v));
    return o && typeof o === "object" ? o : { value: o };
  } catch {
    return { raw: String(v) };
  }
}

function pushToolResult(req, block) {
  const last = req.messages[req.messages.length - 1];
  if (last && last.role === "user" && last.blocks.some((b) => b.type === "tool_result")) {
    last.blocks.push(block);
    return;
  }
  req.messages.push({ role: "user", blocks: [block] });
}

// ---------------- Anthropic Messages ----------------
export function parseAnthropic(body) {
  const r = emptyRequest();
  r.model = String(body.model || "");
  r.system = textOf(body.system);
  r.maxTokens = body.max_tokens ?? null;
  r.temperature = body.temperature ?? null;
  r.topP = body.top_p ?? null;
  r.stop = Array.isArray(body.stop_sequences) ? body.stop_sequences.filter(Boolean) : [];
  r.stream = !!body.stream;
  r.tools = (body.tools || []).filter((t) => t && t.name).map((t) => ({
    name: t.name,
    description: t.description || "",
    schema: t.input_schema || { type: "object", properties: {} },
  }));
  const tc = body.tool_choice;
  if (tc) {
    if (tc.type === "auto") r.toolChoice = "auto";
    else if (tc.type === "any") r.toolChoice = "required";
    else if (tc.type === "none") r.toolChoice = "none";
    else if (tc.type === "tool" && tc.name) r.toolChoice = { name: tc.name };
  }
  for (const m of body.messages || []) {
    r.messages.push({
      role: m.role === "assistant" ? "assistant" : "user",
      blocks: anthropicBlocks(m.content),
    });
  }
  return r;
}

function anthropicBlocks(content) {
  const out = [];
  for (const b of toBlocks(content)) {
    switch (b.type) {
      case "text":
        if (b.text) out.push({ type: "text", text: String(b.text) });
        break;
      case "image": {
        const src = b.source || {};
        if (src.type === "base64" && src.data) {
          out.push({ type: "image", mediaType: src.media_type || "image/png", data: src.data });
        } else if (src.type === "url" && src.url) {
          out.push({ type: "image", mediaType: "image/*", url: src.url });
        } else if (src.data) {
          out.push({ type: "image", mediaType: src.media_type || "image/png", data: src.data });
        }
        break;
      }
      case "tool_use":
        out.push({ type: "tool_use", id: b.id || newId("toolu"), name: b.name || "tool", input: safeJson(b.input) });
        break;
      case "tool_result":
        out.push({
          type: "tool_result",
          toolUseId: b.tool_use_id || b.toolUseId || "",
          text: toolResultText(b.content),
          isError: !!b.is_error,
        });
        break;
      case "thinking":
      case "redacted_thinking":
        break;
      default:
        if (typeof b.text === "string") out.push({ type: "text", text: b.text });
    }
  }
  return out;
}

// ---------------- OpenAI Chat Completions ----------------
export function parseOpenAI(body) {
  const r = emptyRequest();
  r.model = String(body.model || "");
  r.maxTokens = body.max_completion_tokens ?? body.max_tokens ?? null;
  r.temperature = body.temperature ?? null;
  r.topP = body.top_p ?? null;
  r.stream = !!body.stream;
  const stop = body.stop;
  r.stop = Array.isArray(stop) ? stop.filter(Boolean) : stop ? [String(stop)] : [];
  r.tools = (body.tools || [])
    .map((t) => (t && t.function ? t.function : t))
    .filter((f) => f && f.name)
    .map((f) => ({ name: f.name, description: f.description || "", schema: f.parameters || { type: "object", properties: {} } }));
  const tc = body.tool_choice;
  if (typeof tc === "string") r.toolChoice = tc;
  else if (tc && tc.function && tc.function.name) r.toolChoice = { name: tc.function.name };
  else if (tc && tc.name) r.toolChoice = { name: tc.name };

  for (const m of body.messages || []) {
    const role = String(m.role || "user");
    if (role === "system" || role === "developer") {
      const t = textOf(m.content);
      if (t) r.system = r.system ? `${r.system}\n${t}` : t;
      continue;
    }
    if (role === "tool" || role === "function") {
      pushToolResult(r, { type: "tool_result", toolUseId: m.tool_call_id || m.name || "", text: toolResultText(m.content), isError: false });
      continue;
    }
    if (role === "assistant") {
      const blocks = openAIBlocks(m.content);
      for (const tc2 of m.tool_calls || []) {
        const fn = tc2.function || {};
        blocks.push({ type: "tool_use", id: tc2.id || newId("call"), name: fn.name || "tool", input: safeJson(fn.arguments) });
      }
      r.messages.push({ role: "assistant", blocks });
      continue;
    }
    r.messages.push({ role: "user", blocks: openAIBlocks(m.content) });
  }
  return r;
}

function openAIBlocks(content) {
  const out = [];
  for (const p of toBlocks(content)) {
    if (p.type === "text" || p.type === "input_text" || p.type === "output_text") {
      if (p.text) out.push({ type: "text", text: String(p.text) });
    } else if (p.type === "image_url" || p.type === "input_image") {
      const url = typeof p.image_url === "string" ? p.image_url : (p.image_url && p.image_url.url) || p.url;
      if (url) {
        const d = splitDataUrl(url);
        if (d && d.data) out.push({ type: "image", mediaType: d.mediaType, data: d.data });
        else out.push({ type: "image", mediaType: "image/*", url });
      }
    } else if (typeof p.text === "string") {
      out.push({ type: "text", text: p.text });
    }
  }
  return out;
}

// ---------------- OpenAI Responses ----------------
export function parseResponses(body) {
  const r = emptyRequest();
  r.model = String(body.model || "");
  r.system = typeof body.instructions === "string" ? body.instructions : textOf(body.instructions);
  r.maxTokens = body.max_output_tokens ?? null;
  r.temperature = body.temperature ?? null;
  r.topP = body.top_p ?? null;
  r.stream = !!body.stream;
  r.tools = (body.tools || [])
    .filter((t) => t && (t.type === "function" || t.name))
    .map((t) => {
      const f = t.function || t;
      return { name: f.name, description: f.description || "", schema: f.parameters || { type: "object", properties: {} } };
    })
    .filter((t) => t.name);
  const tc = body.tool_choice;
  if (typeof tc === "string") r.toolChoice = tc;
  else if (tc && (tc.name || (tc.function && tc.function.name))) r.toolChoice = { name: tc.name || tc.function.name };

  const input = body.input;
  if (typeof input === "string") {
    if (input) r.messages.push({ role: "user", blocks: [{ type: "text", text: input }] });
  } else if (Array.isArray(input)) {
    for (const item of input) {
      if (!item) continue;
      const t = item.type;
      if (t === "function_call") {
        r.messages.push({
          role: "assistant",
          blocks: [{ type: "tool_use", id: item.call_id || item.id || newId("call"), name: item.name || "tool", input: safeJson(item.arguments) }],
        });
      } else if (t === "function_call_output") {
        pushToolResult(r, { type: "tool_result", toolUseId: item.call_id || item.id || "", text: toolResultText(item.output), isError: false });
      } else if (t === "message" || item.role) {
        const role = item.role === "assistant" ? "assistant" : item.role === "system" || item.role === "developer" ? "system" : "user";
        const blocks = openAIBlocks(item.content);
        if (role === "system") {
          const tx = textOf(blocks);
          if (tx) r.system = r.system ? `${r.system}\n${tx}` : tx;
        } else {
          r.messages.push({ role, blocks });
        }
      } else if (t === "input_image") {
        pushToolResult(r, { type: "text", text: "" });
      }
    }
  }
  return r;
}

// ---------------- Gemini generateContent ----------------
export function parseGemini(body, model) {
  const r = emptyRequest();
  r.model = String(model || body.model || "");
  const sys = body.systemInstruction || body.system_instruction;
  r.system = textOf(sys && (sys.parts || sys));
  const gc = body.generationConfig || body.generation_config || {};
  r.maxTokens = gc.maxOutputTokens ?? gc.max_output_tokens ?? null;
  r.temperature = gc.temperature ?? null;
  r.topP = gc.topP ?? gc.top_p ?? null;
  r.stop = gc.stopSequences || gc.stop_sequences || [];
  r.stream = false;

  const decls = [];
  for (const t of body.tools || []) decls.push(...(t.functionDeclarations || t.function_declarations || []));
  r.tools = decls.filter((d) => d && d.name).map((d) => ({
    name: d.name,
    description: d.description || "",
    schema: d.parameters || d.parametersJsonSchema || { type: "object", properties: {} },
  }));

  const calls = []; // 按顺序记 tool_use，functionResponse 用 name/顺序回填 id
  for (const c of body.contents || []) {
    const role = c.role === "model" || c.role === "assistant" ? "assistant" : "user";
    const blocks = [];
    for (const p of c.parts || []) {
      if (p.inlineData || p.inline_data) {
        const d = p.inlineData || p.inline_data;
        blocks.push({ type: "image", mediaType: d.mimeType || d.mime_type || "image/png", data: d.data });
      } else if (p.fileData || p.file_data) {
        const d = p.fileData || p.file_data;
        blocks.push({ type: "image", mediaType: d.mimeType || d.mime_type || "image/*", url: d.fileUri || d.file_uri });
      } else if (p.functionCall || p.function_call) {
        const f = p.functionCall || p.function_call;
        const blk = { type: "tool_use", id: f.id || newId("call"), name: f.name || "tool", input: f.args || {} };
        calls.push(blk);
        blocks.push(blk);
      } else if (p.functionResponse || p.function_response) {
        const f = p.functionResponse || p.function_response;
        const resp = f.response;
        const text = typeof resp === "string" ? resp : resp && typeof resp === "object"
          ? (typeof resp.result === "string" ? resp.result : JSON.stringify(resp.result !== undefined ? resp.result : resp))
          : String(resp ?? "");
        const hit = calls.find((x) => x.name === f.name && !x.__used) || calls.find((x) => !x.__used);
        if (hit) hit.__used = true;
        blocks.push({ type: "tool_result", toolUseId: (hit && hit.id) || f.id || "", text, isError: false });
      } else if (typeof p.text === "string") {
        if (p.thought) continue; // 思维链不回灌
        blocks.push({ type: "text", text: p.text });
      }
    }
    if (!blocks.length) continue;
    if (role === "user" && blocks.every((b) => b.type === "tool_result")) {
      pushToolResult(r, blocks[0]);
      for (const b of blocks.slice(1)) pushToolResult(r, b);
    } else if (role === "user" && blocks.some((b) => b.type === "tool_result")) {
      for (const b of blocks.filter((b2) => b2.type === "tool_result")) pushToolResult(r, b);
      const rest = blocks.filter((b2) => b2.type !== "tool_result");
      if (rest.length) r.messages.push({ role: "user", blocks: rest });
    } else {
      r.messages.push({ role, blocks });
    }
  }
  for (const c of calls) delete c.__used;
  return r;
}

// ---------------- 统一入口 ----------------
export function parseRequest(proto, body, ctx = {}) {
  switch (proto) {
    case "anthropic": return parseAnthropic(body);
    case "openai": return parseOpenAI(body);
    case "responses": return parseResponses(body);
    case "gemini": return parseGemini(body, ctx.model);
    default: throw new Error(`未知入站协议：${proto}`);
  }
}
