// emit.mjs — IR 事件 → 下游协议（SSE 流 或 完整 JSON）。
//
// 每个 emitter 都有三个方法：
//   push(event) -> string    要立刻写出的文本（可能是空串）
//   end()       -> string    收尾文本
//   toJSON()    -> object    非流式模式下的完整响应体
import { newId } from "./ir.mjs";

const sse = (event, data) => (event ? `event: ${event}\n` : "") + `data: ${JSON.stringify(data)}\n\n`;
const now = () => Math.floor(Date.now() / 1000);

function stopForAnthropic(r, hasTool) {
  if (hasTool) return "tool_use";
  if (r === "max_tokens") return "max_tokens";
  return "end_turn";
}
function stopForOpenAI(r, hasTool) {
  if (hasTool) return "tool_calls";
  if (r === "max_tokens") return "length";
  return "stop";
}

// ==================== Anthropic Messages ====================
class AnthropicEmitter {
  constructor(model) {
    this.model = model || "unknown";
    this.id = newId("msg");
    this.started = false;
    this.blockIndex = -1;
    this.open = null;
    this.text = "";
    this.tools = new Map();
    this.usage = { input: 0, output: 0 };
    this.stop = "end_turn";
    this.emitted = false;
    this.empty = true;
  }

  startChunk() {
    if (this.started) return "";
    this.started = true;
    return sse("message_start", {
      type: "message_start",
      message: {
        id: this.id, type: "message", role: "assistant", model: this.model,
        content: [], stop_reason: null, stop_sequence: null,
        usage: { input_tokens: this.usage.input, output_tokens: 0 },
      },
    });
  }

  closeBlock() {
    if (!this.open) return "";
    const s = sse("content_block_stop", { type: "content_block_stop", index: this.blockIndex });
    this.open = null;
    return s;
  }

  openText() {
    if (this.open && this.open.type === "text") return "";
    let s = this.closeBlock();
    this.blockIndex += 1;
    this.open = { type: "text" };
    s += sse("content_block_start", {
      type: "content_block_start", index: this.blockIndex,
      content_block: { type: "text", text: "" },
    });
    return s;
  }

  push(ev) {
    let out = "";
    switch (ev.type) {
      case "start":
        break;
      case "usage":
        if (ev.input) this.usage.input = ev.input;
        if (ev.output) this.usage.output = ev.output;
        break;
      case "text": {
        if (!ev.text) break;
        out += this.startChunk();
        out += this.openText();
        this.text += ev.text;
        this.empty = false;
        out += sse("content_block_delta", {
          type: "content_block_delta", index: this.blockIndex,
          delta: { type: "text_delta", text: ev.text },
        });
        break;
      }
      case "thinking":
        // Anthropic 的 thinking block 必须带签名，凭空造会被拒；丢掉最稳
        break;
      case "tool_start":
        if (!this.tools.has(ev.slot)) {
          this.tools.set(ev.slot, { id: ev.id || newId("toolu"), name: ev.name || "tool", args: "" });
        }
        break;
      case "tool_args": {
        let t = this.tools.get(ev.slot);
        if (!t) { t = { id: newId("toolu"), name: "tool", args: "" }; this.tools.set(ev.slot, t); }
        t.args += ev.partial || "";
        break;
      }
      case "finish":
        this.stop = ev.reason || "end_turn";
        break;
      case "error":
        this.emitted = true;
        out += sse("error", { type: "error", error: { type: "api_error", message: ev.message } });
        break;
      default:
        break;
    }
    return out;
  }

  end() {
    if (this.emitted) return "";
    this.emitted = true;
    let out = this.startChunk();
    out += this.closeBlock();

    const slots = [...this.tools.keys()].sort((a, b) => a - b);
    for (const slot of slots) {
      const t = this.tools.get(slot);
      this.blockIndex += 1;
      out += sse("content_block_start", {
        type: "content_block_start", index: this.blockIndex,
        content_block: { type: "tool_use", id: t.id, name: t.name, input: {} },
      });
      out += sse("content_block_delta", {
        type: "content_block_delta", index: this.blockIndex,
        delta: { type: "input_json_delta", partial_json: t.args || "{}" },
      });
      out += sse("content_block_stop", { type: "content_block_stop", index: this.blockIndex });
    }

    out += sse("message_delta", {
      type: "message_delta",
      delta: { stop_reason: stopForAnthropic(this.stop, slots.length > 0), stop_sequence: null },
      usage: { output_tokens: this.usage.output },
    });
    out += sse("message_stop", { type: "message_stop" });
    return out;
  }

  toJSON() {
    const content = [];
    if (this.text) content.push({ type: "text", text: this.text });
    for (const slot of [...this.tools.keys()].sort((a, b) => a - b)) {
      const t = this.tools.get(slot);
      content.push({ type: "tool_use", id: t.id, name: t.name, input: safeParse(t.args) });
    }
    if (!content.length) content.push({ type: "text", text: "" });
    return {
      id: this.id, type: "message", role: "assistant", model: this.model,
      content,
      stop_reason: stopForAnthropic(this.stop, this.tools.size > 0),
      stop_sequence: null,
      usage: { input_tokens: this.usage.input, output_tokens: this.usage.output },
    };
  }
}

// ==================== OpenAI Chat Completions ====================
class OpenAIEmitter {
  constructor(model) {
    this.model = model || "unknown";
    this.id = newId("chatcmpl");
    this.created = now();
    this.rolled = false;
    this.text = "";
    this.tools = new Map();
    this.usage = { input: 0, output: 0 };
    this.stop = "end_turn";
    this.finished = false;
    this.emitted = false;
  }

  chunk(delta, finish = null) {
    return sse("", {
      id: this.id, object: "chat.completion.chunk", created: this.created, model: this.model,
      choices: [{ index: 0, delta, finish_reason: finish }],
    });
  }

  push(ev) {
    let out = "";
    switch (ev.type) {
      case "start":
        break;
      case "usage":
        if (ev.input) this.usage.input = ev.input;
        if (ev.output) this.usage.output = ev.output;
        break;
      case "text": {
        if (!ev.text) break;
        if (!this.rolled) { this.rolled = true; out += this.chunk({ role: "assistant", content: "" }); }
        this.text += ev.text;
        out += this.chunk({ content: ev.text });
        break;
      }
      case "thinking":
        if (ev.text) {
          if (!this.rolled) { this.rolled = true; out += this.chunk({ role: "assistant", content: "" }); }
          out += this.chunk({ reasoning_content: ev.text });
        }
        break;
      case "tool_start": {
        if (!this.rolled) { this.rolled = true; out += this.chunk({ role: "assistant", content: "" }); }
        const t = this.tools.get(ev.slot) || { id: newId("call"), name: "tool", args: "", announced: false };
        if (ev.id) t.id = ev.id;
        if (ev.name) t.name = ev.name;
        this.tools.set(ev.slot, t);
        if (!t.announced) {
          t.announced = true;
          out += this.chunk({
            tool_calls: [{ index: ev.slot, id: t.id, type: "function", function: { name: t.name, arguments: "" } }],
          });
        }
        break;
      }
      case "tool_args": {
        let t = this.tools.get(ev.slot);
        if (!t) {
          t = { id: newId("call"), name: "tool", args: "", announced: false };
          this.tools.set(ev.slot, t);
        }
        if (!t.announced) {
          t.announced = true;
          out += this.chunk({
            tool_calls: [{ index: ev.slot, id: t.id, type: "function", function: { name: t.name, arguments: "" } }],
          });
        }
        t.args += ev.partial || "";
        out += this.chunk({ tool_calls: [{ index: ev.slot, function: { arguments: ev.partial || "" } }] });
        break;
      }
      case "finish":
        this.stop = ev.reason || "end_turn";
        break;
      case "error":
        this.emitted = true;
        out += sse("", { error: { message: ev.message, type: "upstream_error" } });
        break;
      default:
        break;
    }
    return out;
  }

  end() {
    if (this.emitted) return "";
    this.emitted = true;
    let out = "";
    if (!this.rolled) { this.rolled = true; out += this.chunk({ role: "assistant", content: "" }); }
    out += this.chunk({}, stopForOpenAI(this.stop, this.tools.size > 0));
    out += sse("", {
      id: this.id, object: "chat.completion.chunk", created: this.created, model: this.model,
      choices: [],
      usage: {
        prompt_tokens: this.usage.input, completion_tokens: this.usage.output,
        total_tokens: this.usage.input + this.usage.output,
      },
    });
    out += "data: [DONE]\n\n";
    return out;
  }

  toJSON() {
    const msg = { role: "assistant", content: this.text || null };
    if (this.tools.size) {
      msg.tool_calls = [...this.tools.keys()].sort((a, b) => a - b).map((slot) => {
        const t = this.tools.get(slot);
        return { id: t.id, type: "function", function: { name: t.name, arguments: t.args || "{}" } };
      });
    }
    return {
      id: this.id, object: "chat.completion", created: this.created, model: this.model,
      choices: [{ index: 0, message: msg, finish_reason: stopForOpenAI(this.stop, this.tools.size > 0) }],
      usage: {
        prompt_tokens: this.usage.input, completion_tokens: this.usage.output,
        total_tokens: this.usage.input + this.usage.output,
      },
    };
  }
}

// ==================== OpenAI Responses ====================
class ResponsesEmitter {
  constructor(model) {
    this.model = model || "unknown";
    this.id = newId("resp");
    this.created = now();
    this.text = "";
    this.tools = new Map();
    this.usage = { input: 0, output: 0 };
    this.stop = "end_turn";
    this.itemIndex = 0;
    this.textItemId = null;
    this.textOpened = false;
    this.announced = new Set();
    this.emitted = false;
    this.seq = 0;
  }

  ev(name, data) {
    this.seq += 1;
    return sse(name, { type: name, sequence_number: this.seq, ...data });
  }

  respObj(status = "in_progress") {
    return { id: this.id, object: "response", created_at: this.created, status, model: this.model, output: [] };
  }

  openTextItem() {
    if (this.textOpened) return "";
    this.textOpened = true;
    this.textItemId = newId("item");
    let out = this.ev("response.output_item.added", {
      output_index: this.itemIndex,
      item: { id: this.textItemId, type: "message", status: "in_progress", role: "assistant", content: [] },
    });
    out += this.ev("response.content_part.added", {
      item_id: this.textItemId, output_index: this.itemIndex, content_index: 0,
      part: { type: "output_text", text: "", annotations: [] },
    });
    return out;
  }

  push(ev) {
    let out = "";
    switch (ev.type) {
      case "start":
        out += this.ev("response.created", { response: this.respObj() });
        break;
      case "usage":
        if (ev.input) this.usage.input = ev.input;
        if (ev.output) this.usage.output = ev.output;
        break;
      case "text": {
        if (!ev.text) break;
        out += this.openTextItem();
        this.text += ev.text;
        out += this.ev("response.output_text.delta", {
          item_id: this.textItemId, output_index: this.itemIndex, content_index: 0, delta: ev.text,
        });
        break;
      }
      case "thinking":
        break;
      case "tool_start": {
        if (!this.tools.has(ev.slot)) {
          this.tools.set(ev.slot, { id: newId("fc"), callId: ev.id || newId("call"), name: ev.name || "tool", args: "" });
        }
        const t = this.tools.get(ev.slot);
        if (ev.id) t.callId = ev.id;
        if (ev.name) t.name = ev.name;
        break;
      }
      case "tool_args": {
        let t = this.tools.get(ev.slot);
        if (!t) { t = { id: newId("fc"), callId: newId("call"), name: "tool", args: "" }; this.tools.set(ev.slot, t); }
        t.args += ev.partial || "";
        break;
      }
      case "finish":
        this.stop = ev.reason || "end_turn";
        break;
      case "error":
        this.emitted = true;
        out += this.ev("error", { code: "upstream_error", message: ev.message, param: null });
        break;
      default:
        break;
    }
    return out;
  }

  end() {
    if (this.emitted) return "";
    this.emitted = true;
    let out = "";

    if (this.textOpened) {
      out += this.ev("response.output_text.done", {
        item_id: this.textItemId, output_index: this.itemIndex, content_index: 0, text: this.text,
      });
      out += this.ev("response.content_part.done", {
        item_id: this.textItemId, output_index: this.itemIndex, content_index: 0,
        part: { type: "output_text", text: this.text, annotations: [] },
      });
      out += this.ev("response.output_item.done", {
        output_index: this.itemIndex,
        item: {
          id: this.textItemId, type: "message", status: "completed", role: "assistant",
          content: [{ type: "output_text", text: this.text, annotations: [] }],
        },
      });
      this.itemIndex += 1;
    }

    for (const slot of [...this.tools.keys()].sort((a, b) => a - b)) {
      const t = this.tools.get(slot);
      const idx = this.itemIndex;
      out += this.ev("response.output_item.added", {
        output_index: idx,
        item: { id: t.id, type: "function_call", status: "in_progress", call_id: t.callId, name: t.name, arguments: "" },
      });
      out += this.ev("response.function_call_arguments.delta", {
        item_id: t.id, output_index: idx, delta: t.args || "{}",
      });
      out += this.ev("response.function_call_arguments.done", {
        item_id: t.id, output_index: idx, arguments: t.args || "{}",
      });
      out += this.ev("response.output_item.done", {
        output_index: idx,
        item: { id: t.id, type: "function_call", status: "completed", call_id: t.callId, name: t.name, arguments: t.args || "{}" },
      });
      this.itemIndex += 1;
    }

    out += this.ev("response.completed", {
      response: { ...this.respObj("completed"), output: this.outputItems(), usage: this.usageObj() },
    });
    return out;
  }

  usageObj() {
    return {
      input_tokens: this.usage.input, output_tokens: this.usage.output,
      total_tokens: this.usage.input + this.usage.output,
    };
  }

  outputItems() {
    const out = [];
    if (this.textOpened) {
      out.push({
        id: this.textItemId, type: "message", status: "completed", role: "assistant",
        content: [{ type: "output_text", text: this.text, annotations: [] }],
      });
    }
    for (const slot of [...this.tools.keys()].sort((a, b) => a - b)) {
      const t = this.tools.get(slot);
      out.push({ id: t.id, type: "function_call", status: "completed", call_id: t.callId, name: t.name, arguments: t.args || "{}" });
    }
    return out;
  }

  toJSON() {
    return {
      id: this.id, object: "response", created_at: this.created,
      status: this.stop === "max_tokens" ? "incomplete" : "completed",
      model: this.model,
      output: this.outputItems(),
      usage: this.usageObj(),
      incomplete_details: this.stop === "max_tokens" ? { reason: "max_output_tokens" } : null,
    };
  }
}

// ==================== Gemini ====================
class GeminiEmitter {
  constructor(model) {
    this.model = model || "unknown";
    this.text = "";
    this.tools = new Map();
    this.parts = [];
    this.usage = { input: 0, output: 0 };
    this.stop = "end_turn";
    this.emitted = false;
  }

  push(ev) {
    let out = "";
    switch (ev.type) {
      case "start":
        break;
      case "usage":
        if (ev.input) this.usage.input = ev.input;
        if (ev.output) this.usage.output = ev.output;
        break;
      case "text": {
        if (!ev.text) break;
        this.text += ev.text;
        out += sse("", { candidates: [{ content: { role: "model", parts: [{ text: ev.text }] }, index: 0 }] });
        break;
      }
      case "thinking":
        if (ev.text) out += sse("", { candidates: [{ content: { role: "model", parts: [{ text: ev.text, thought: true }] }, index: 0 }] });
        break;
      case "tool_start": {
        if (!this.tools.has(ev.slot)) this.tools.set(ev.slot, { name: ev.name || "tool", args: "" });
        break;
      }
      case "tool_args": {
        let t = this.tools.get(ev.slot);
        if (!t) { t = { name: "tool", args: "" }; this.tools.set(ev.slot, t); }
        t.args += ev.partial || "";
        break;
      }
      case "finish":
        this.stop = ev.reason || "end_turn";
        break;
      case "error":
        this.emitted = true;
        out += sse("", { error: { code: 500, message: ev.message, status: "INTERNAL" } });
        break;
      default:
        break;
    }
    return out;
  }

  finishReason() {
    return this.stop === "max_tokens" ? "MAX_TOKENS" : "STOP";
  }

  usageMeta() {
    return {
      promptTokenCount: this.usage.input,
      candidatesTokenCount: this.usage.output,
      totalTokenCount: this.usage.input + this.usage.output,
    };
  }

  end() {
    if (this.emitted) return "";
    this.emitted = true;
    const parts = this.parts.concat(this.toolParts());
    if (!parts.length) parts.push({ text: "" });
    return sse("", {
      candidates: [{ content: { role: "model", parts }, finishReason: this.finishReason(), index: 0 }],
      usageMetadata: this.usageMeta(),
    });
  }

  toolParts() {
    return [...this.tools.keys()].sort((a, b) => a - b).map((slot) => {
      const t = this.tools.get(slot);
      return { functionCall: { name: t.name, args: safeParse(t.args) } };
    });
  }

  toJSON() {
    const parts = [];
    if (this.text) parts.push({ text: this.text });
    parts.push(...this.toolParts());
    if (!parts.length) parts.push({ text: "" });
    return {
      candidates: [{
        content: { role: "model", parts },
        finishReason: this.finishReason(),
        index: 0,
      }],
      usageMetadata: this.usageMeta(),
      modelVersion: this.model,
    };
  }
}

function safeParse(s) {
  if (!s) return {};
  try {
    const o = JSON.parse(s);
    return o && typeof o === "object" ? o : { value: o };
  } catch {
    return { _raw: String(s) };
  }
}

export function createEmitter(proto, opts = {}) {
  if (proto === "anthropic") return new AnthropicEmitter(opts.model);
  if (proto === "openai") return new OpenAIEmitter(opts.model);
  if (proto === "responses") return new ResponsesEmitter(opts.model);
  if (proto === "gemini") return new GeminiEmitter(opts.model);
  throw new Error(`未知下游协议：${proto}`);
}
