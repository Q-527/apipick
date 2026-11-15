// ui.mjs — tiny ANSI + CJK-aware padding, no deps.
import { createInterface } from "node:readline";

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const wrap = (code) => (s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : String(s));
export const c = {
  cyan: wrap("36"), green: wrap("32"), yellow: wrap("33"), red: wrap("31"),
  gray: wrap("90"), white: wrap("97"), bold: wrap("1"), dim: wrap("2"),
};

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m/g;

export function width(s) {
  s = String(s).replace(ANSI, ""); // ignore color codes when measuring
  let w = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if ((cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf) ||
        (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) ||
        (cp >= 0xfe30 && cp <= 0xfe6f) || (cp >= 0xff00 && cp <= 0xff60) ||
        (cp >= 0xffe0 && cp <= 0xffe6)) w += 2;
    else w += 1;
  }
  return w;
}
export function pad(s, n) {
  s = String(s);
  return s + " ".repeat(Math.max(0, n - width(s)));
}

/** trim to a display width, adding '…' when cut */
export function clip(s, n) {
  s = String(s);
  if (width(s) <= n) return s;
  let out = "";
  for (const ch of s) {
    if (width(out + ch) > n - 1) break;
    out += ch;
  }
  return out + "…";
}

export function banner(title, subtitle = "") {
  const line = "  " + "=".repeat(46);
  console.log("");
  console.log(c.cyan(line));
  console.log(c.cyan(`   ${title}`));
  if (subtitle) console.log(c.gray(`   ${subtitle}`));
  console.log(c.cyan(line));
  console.log("");
}

// One shared readline interface, plus a line queue for non-TTY input.
// Recreating readline per question drops buffered piped lines, so `printf ... | api`
// and scripted flows would otherwise lose answers; with the queue they work.
let _rl = null;
let _pending = null;   // resolver waiting on rl.question (TTY)
let _waiter = null;    // resolver waiting on the queue (piped)
const _queue = [];
let _eof = false;

function rl() {
  if (_rl) return _rl;
  _rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: !!process.stdin.isTTY,
  });
  _rl.on("line", (line) => {
    if (process.stdin.isTTY) return; // TTY path resolves via rl.question
    if (_waiter) { const w = _waiter; _waiter = null; w(line); }
    else _queue.push(line);
  });
  _rl.on("close", () => {
    _eof = true;
    _rl = null;
    if (_waiter) { const w = _waiter; _waiter = null; w(""); }
    if (_pending) { const p = _pending; _pending = null; p(""); }
  });
  return _rl;
}

/** call before handing the terminal to a child process (claude) */
export function closePrompts() {
  if (_rl) { try { _rl.close(); } catch { /* ignore */ } _rl = null; }
}

export function ask(question) {
  if (!process.stdin.isTTY) {
    rl(); // make the input stream flow before waiting
    process.stdout.write(question);
    if (_queue.length) { const v = _queue.shift(); process.stdout.write(v + "\n"); return Promise.resolve(v); }
    if (_eof) { process.stdout.write("\n"); return Promise.resolve(""); }
    return new Promise((resolve) => { _waiter = (v) => { process.stdout.write((v || "") + "\n"); resolve(v || ""); }; });
  }
  return new Promise((resolve) => {
    const r = rl();
    if (!r) return resolve("");
    _pending = resolve;
    r.question(question, (ans) => { _pending = null; resolve(ans); });
  });
}

// hidden prompt for pasting API keys (asterisks on a TTY, silent echo when piped)
export function askHidden(question) {
  if (!process.stdin.isTTY) return ask(question);
  return new Promise((resolve) => {
    const r = rl();
    if (!r) return resolve("");
    _pending = resolve;
    const orig = r._writeToOutput;
    r._writeToOutput = () => {
      process.stdout.write("\r\x1b[K" + question + "*".repeat(r.line ? r.line.length : 0));
    };
    r.question("", (ans) => {
      r._writeToOutput = orig;
      process.stdout.write("\r\x1b[K" + question + "*".repeat(ans.length) + "\n");
      _pending = null;
      resolve(ans);
    });
  });
}

export function info(msg) { console.log(c.gray(msg)); }
export function ok(msg) { console.log(c.green(msg)); }
export function warn(msg) { console.log(c.yellow(msg)); }
export function err(msg) { console.error(c.red(msg)); }
