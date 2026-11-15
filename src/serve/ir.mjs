// ir.mjs — 统一内部表示（IR）。
//
// 四种协议（Anthropic Messages / OpenAI Chat / OpenAI Responses / Gemini）
// 都先翻译成这里的同一套结构，再翻译出去。多对多只在两头写一次。
//
// Request = {
//   model, system, messages[], tools[], toolChoice, maxTokens,
//   temperature, topP, stop[], stream
// }
// Message = { role: "user" | "assistant", blocks: Block[] }
// Block =
//   { type: "text",        text }
//   { type: "image",       mediaType, data }        内联 base64
//   { type: "image",       mediaType, url  }        外链
//   { type: "tool_use",    id, name, input }        input 是对象
//   { type: "tool_result", toolUseId, text, isError }
// Tool = { name, description, schema }              schema 是 JSON Schema

export const PROTOCOLS = ["anthropic", "openai", "responses", "gemini"];

export const PROTO_LABEL = {
  anthropic: "Anthropic Messages",
  openai: "OpenAI Chat Completions",
  responses: "OpenAI Responses",
  gemini: "Gemini generateContent",
};

let counter = 0;
export function newId(prefix = "id") {
  counter = (counter + 1) % 1e6;
  return `${prefix}_${Date.now().toString(36)}${counter.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function emptyRequest() {
  return {
    model: "",
    system: "",
    messages: [],
    tools: [],
    toolChoice: null, // "auto" | "none" | "required" | { name }
    maxTokens: null,
    temperature: null,
    topP: null,
    stop: [],
    stream: false,
  };
}

/** 宽松地转成 Block 数组：字符串 / 单个对象 / 数组都能接 */
export function toBlocks(content) {
  if (content == null) return [];
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
  if (Array.isArray(content)) return content.flatMap(toBlocks);
  if (typeof content === "object") {
    if (typeof content.text === "string" && !content.type) return [{ type: "text", text: content.text }];
    return [content];
  }
  return [{ type: "text", text: String(content) }];
}

export function textOf(blocks) {
  return toBlocks(blocks).filter((b) => b.type === "text").map((b) => b.text).join("");
}

/** tool_result 的 content 可能是字符串，也可能是 block 数组 */
export function toolResultText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return textOf(content);
  if (content && typeof content === "object") {
    if (typeof content.text === "string") return content.text;
    return JSON.stringify(content);
  }
  return content == null ? "" : String(content);
}

/** 把 data:image/png;base64,xxxx 拆成 { mediaType, data } */
export function splitDataUrl(url) {
  const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(String(url || ""));
  if (!m) return null;
  const mediaType = m[1] || "image/png";
  if (m[2]) return { mediaType, data: m[3] };
  return { mediaType, text: decodeURIComponent(m[3]) };
}

export function toDataUrl(block) {
  if (block.url) return block.url;
  return `data:${block.mediaType || "image/png"};base64,${block.data || ""}`;
}

/** 估算 token：CJK 按 1 字 ≈ 1 token，其余按 4 字符 ≈ 1 token */
export function roughTokens(text) {
  const s = String(text || "");
  let cjk = 0;
  for (const ch of s) if (ch.codePointAt(0) > 0x2e7f) cjk += 1;
  return Math.ceil(cjk + (s.length - cjk) / 4);
}

export function isProtocol(p) {
  return PROTOCOLS.includes(p);
}
