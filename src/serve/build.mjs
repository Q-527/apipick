// build.mjs — IR → 出站请求（四种协议）+ URL 拼接。
import { toDataUrl, splitDataUrl } from "./ir.mjs";

const hasVersion = (base) => /\/v\d+[a-z0-9]*$/i.test(String(base || "").replace(/\/+$/, ""));

export function joinUrl(base, path) {
  const b = String(base || "").replace(/\/+$/, "");
  const p = String(path || "").replace(/^\/+/, "");
  return p ? `${b}/${p}` : b;
}

/** 出站地址：base 自带 /v1 就不再补，否则补默认版本号 */
export function outboundUrl(proto, base, model) {
  const b = String(base || "").replace(/\/+$/, "");
  if (proto === "anthropic") return joinUrl(b, hasVersion(b) ? "messages" : "v1/messages");
  if (proto === "openai") return joinUrl(b, hasVersion(b) ? "chat/completions" : "v1/chat/completions");
  if (proto === "responses") return joinUrl(b, hasVersion(b) ? "responses" : "v1/responses");
  if (proto === "gemini") {
    const root = hasVersion(b) ? b : `${b}/v1beta`;
    return `${root}/models/${encodeURIComponent(model)}:generateContent`;
  }
  return b;
}

export function streamUrl(proto, base, model) {
  const u = outboundUrl(proto, base, model);
  if (proto === "gemini") {
    return u.replace(":generateContent", ":streamGenerateContent") + (u.includes("?") ? "&" : "?") + "alt=sse";
  }
  return u;
}

// ---------------- Anthropic ----------------
export function buildAnthropic(ir) {
  const body = {
    model: ir.model,
    max_tokens: ir.maxTokens || 8192,
    messages: ir.messages.map((m) => ({
      role: m.role,
      content: m.blocks.map(anthropicBlock).filter(Boolean),
    })).filter((m) => m.content.length),
    stream: !!ir.stream,
  };
  if (ir.system) body.system = ir.system;
  if (ir.temperature != null) body.temperature = ir.temperature;
  if (ir.topP != null) body.top_p = ir.topP;
  if (ir.stop && ir.stop.length) body.stop_sequences = ir.stop;
  if (ir.tools && ir.tools.length) {
    body.tools = ir.tools.map((t) => ({
      name: t.name,
      description: t.description || undefined,
      input_schema: t.schema || { type: "object", properties: {} },
    }));
    const tc = ir.toolChoice;
    if (tc === "required") body.tool_choice = { type: "any" };
    else if (tc === "none") body.tool_choice = { type: "none" };
    else if (tc && tc.name) body.tool_choice = { type: "tool", name: tc.name };
    else body.tool_choice = { type: "auto" };
  }
  return body;
}

function anthropicBlock(b) {
  switch (b.type) {
    case "text":
      return b.text ? { type: "text", text: b.text } : null;
    case "image":
      return b.url
        ? { type: "image", source: { type: "url", url: b.url } }
        : { type: "image", source: { type: "base64", media_type: b.mediaType || "image/png", data: b.data || "" } };
    case "tool_use":
      return { type: "tool_use", id: b.id, name: b.name, input: b.input || {} };
    case "tool_result":
      return { type: "tool_result", tool_use_id: b.toolUseId, content: b.text || "", is_error: b.isError || undefined };
    default:
      return null;
  }
}

// ---------------- OpenAI Chat ----------------
export function buildOpenAI(ir) {
  const messages = [];
  if (ir.system) messages.push({ role: "system", content: ir.system });

  for (const m of ir.messages) {
    const texts = m.blocks.filter((b) => b.type === "text");
    const images = m.blocks.filter((b) => b.type === "image");
    const uses = m.blocks.filter((b) => b.type === "tool_use");
    const results = m.blocks.filter((b) => b.type === "tool_result");

    if (m.role === "assistant") {
      const msg = { role: "assistant" };
      if (uses.length) {
        const txt = texts.map((b) => b.text).join("");
        msg.content = txt || null;
        msg.tool_calls = uses.map((u) => ({
          id: u.id,
          type: "function",
          function: { name: u.name, arguments: JSON.stringify(u.input || {}) },
        }));
      } else {
        const parts = contentParts(texts, images);
        msg.content = partsSingle(parts);
      }
      messages.push(msg);
      continue;
    }

    // OpenAI 要求 tool 消息紧跟 assistant 的 tool_calls，先把它们排出去
    for (const r of results) {
      messages.push({ role: "tool", tool_call_id: r.toolUseId || "unknown", content: r.text || "" });
    }
    const parts = contentParts(texts, images);
    if (parts.length) messages.push({ role: "user", content: partsSingle(parts) });
  }

  const body = { model: ir.model, messages, stream: !!ir.stream };
  if (ir.tools && ir.tools.length) {
    body.tools = ir.tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description || undefined, parameters: t.schema || { type: "object", properties: {} } },
    }));
    const tc = ir.toolChoice;
    if (tc && tc.name) body.tool_choice = { type: "function", function: { name: tc.name } };
    else if (typeof tc === "string") body.tool_choice = tc;
    else body.tool_choice = "auto";
  }
  if (ir.maxTokens) {
    // o 系与 gpt-5 系只认 max_completion_tokens
    if (/^(o\d|gpt-5)/i.test(ir.model)) body.max_completion_tokens = ir.maxTokens;
    else body.max_tokens = ir.maxTokens;
  }
  if (ir.temperature != null) body.temperature = ir.temperature;
  if (ir.topP != null) body.top_p = ir.topP;
  if (ir.stop && ir.stop.length) body.stop = ir.stop;
  if (ir.stream) body.stream_options = { include_usage: true };
  return body;
}

function contentParts(texts, images) {
  const parts = [];
  for (const t of texts) if (t.text) parts.push({ type: "text", text: t.text });
  for (const i of images) parts.push({ type: "image_url", image_url: { url: toDataUrl(i) } });
  return parts;
}
function partsSingle(parts) {
  if (!parts.length) return "";
  if (parts.length === 1 && parts[0].type === "text") return parts[0].text;
  return parts;
}

// ---------------- OpenAI Responses ----------------
export function buildResponses(ir) {
  const input = [];
  for (const m of ir.messages) {
    const uses = m.blocks.filter((b) => b.type === "tool_use");
    const results = m.blocks.filter((b) => b.type === "tool_result");
    const texts = m.blocks.filter((b) => b.type === "text");
    const images = m.blocks.filter((b) => b.type === "image");

    if (m.role === "assistant") {
      const parts = [];
      for (const t of texts) if (t.text) parts.push({ type: "output_text", text: t.text });
      if (parts.length) input.push({ role: "assistant", content: parts });
      for (const u of uses) {
        input.push({ type: "function_call", call_id: u.id, name: u.name, arguments: JSON.stringify(u.input || {}) });
      }
      continue;
    }

    for (const r of results) {
      input.push({ type: "function_call_output", call_id: r.toolUseId || "unknown", output: r.text || "" });
    }
    const parts = [];
    for (const t of texts) if (t.text) parts.push({ type: "input_text", text: t.text });
    for (const i of images) parts.push({ type: "input_image", image_url: toDataUrl(i) });
    if (parts.length) {
      if (parts.length === 1 && parts[0].type === "input_text") input.push({ role: "user", content: parts[0].text });
      else input.push({ role: "user", content: parts });
    }
  }

  const body = { model: ir.model, input, stream: !!ir.stream, store: false };
  if (ir.system) body.instructions = ir.system;
  if (ir.tools && ir.tools.length) {
    body.tools = ir.tools.map((t) => ({
      type: "function",
      name: t.name,
      description: t.description || undefined,
      parameters: t.schema || { type: "object", properties: {} },
    }));
    const tc = ir.toolChoice;
    if (tc && tc.name) body.tool_choice = { type: "function", name: tc.name };
    else if (typeof tc === "string") body.tool_choice = tc;
  }
  if (ir.maxTokens) body.max_output_tokens = ir.maxTokens;
  if (ir.temperature != null) body.temperature = ir.temperature;
  if (ir.topP != null) body.top_p = ir.topP;
  return body;
}

// ---------------- Gemini ----------------
export function buildGemini(ir) {
  const contents = [];
  const nameById = new Map();

  for (const m of ir.messages) {
    for (const b of m.blocks) if (b.type === "tool_use") nameById.set(b.id, b.name);
  }

  for (const m of ir.messages) {
    const parts = [];
    for (const b of m.blocks) {
      if (b.type === "text") { if (b.text) parts.push({ text: b.text }); }
      else if (b.type === "image") {
        if (b.url && !b.data) parts.push({ fileData: { mimeType: b.mediaType || "image/*", fileUri: b.url } });
        else parts.push({ inlineData: { mimeType: b.mediaType || "image/png", data: b.data || "" } });
      } else if (b.type === "tool_use") {
        parts.push({ functionCall: { name: b.name, args: b.input || {} } });
      } else if (b.type === "tool_result") {
        const name = nameById.get(b.toolUseId) || "tool";
        parts.push({ functionResponse: { name, response: { result: b.text || "" } } });
      }
    }
    if (!parts.length) continue;
    const role = m.role === "assistant" ? "model" : "user";
    const prev = contents[contents.length - 1];
    if (prev && prev.role === role && m.role !== "assistant") prev.parts.push(...parts);
    else contents.push({ role, parts });
  }

  const body = { contents };
  if (ir.system) body.systemInstruction = { parts: [{ text: ir.system }] };
  const gc = {};
  if (ir.maxTokens) gc.maxOutputTokens = ir.maxTokens;
  if (ir.temperature != null) gc.temperature = ir.temperature;
  if (ir.topP != null) gc.topP = ir.topP;
  if (ir.stop && ir.stop.length) gc.stopSequences = ir.stop;
  if (Object.keys(gc).length) body.generationConfig = gc;
  if (ir.tools && ir.tools.length) {
    body.tools = [{ functionDeclarations: ir.tools.map((t) => ({
      name: t.name,
      description: t.description || undefined,
      parameters: geminiSchema(t.schema),
    })) }];
  }
  return body;
}

/** Gemini 的 JSON Schema 子集不认这些字段，剔掉免得 400 */
function geminiSchema(schema) {
  let out;
  try { out = JSON.parse(JSON.stringify(schema || {})); } catch { return { type: "object", properties: {} }; }
  const walk = (o) => {
    if (Array.isArray(o)) { o.forEach(walk); return; }
    if (!o || typeof o !== "object") return;
    delete o.$schema;
    delete o.$defs;
    delete o.definitions;
    delete o.additionalProperties;
    delete o.$ref;
    delete o.examples;
    for (const k of Object.keys(o)) walk(o[k]);
  };
  walk(out);
  if (!out.type && out.properties) out.type = "object";
  return out;
}

// ---------------- 统一入口 ----------------
export function buildRequest(proto, ir) {
  switch (proto) {
    case "anthropic": return buildAnthropic(ir);
    case "openai": return buildOpenAI(ir);
    case "responses": return buildResponses(ir);
    case "gemini": return buildGemini(ir);
    default: throw new Error(`未知出站协议：${proto}`);
  }
}
