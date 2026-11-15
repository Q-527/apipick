// viz.mjs — tiny terminal chart primitives (no deps): bars, sparklines, gauges, panels, tables.
import { c, width, pad, clip } from "./ui.mjs";

export function fmtNum(n) {
  if (n == null || Number.isNaN(n)) return "0";
  const a = Math.abs(n);
  if (a >= 1e9) return (n / 1e9).toFixed(a >= 1e10 ? 0 : 1) + "B";
  if (a >= 1e6) return (n / 1e6).toFixed(a >= 1e7 ? 0 : 1) + "M";
  if (a >= 1e4) return (n / 1e3).toFixed(a >= 1e5 ? 0 : 1) + "k";
  return String(Math.round(n));
}

export function fmtInt(n) {
  return Number(n || 0).toLocaleString("en-US");
}

export function pct(part, whole) {
  if (!whole) return 0;
  return Math.round((part * 100) / whole);
}

/** solid block bar: ███████░░░░░  */
export function hbar(value, max, w = 16, colorFn) {
  const m = max > 0 ? max : 1;
  const filled = Math.max(value > 0 ? 1 : 0, Math.round((value / m) * w));
  const n = Math.min(w, filled);
  const s = "█".repeat(n) + "░".repeat(Math.max(0, w - n));
  return colorFn ? colorFn(s) : s;
}

/** vertical-ish sparkline: ▁▂▃▄▅▆▇█ */
const SPARK = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
export function sparkline(values, { color } = {}) {
  if (!values || !values.length) return "";
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const span = max - min || 1;
  const s = values.map((v) => {
    const i = Math.min(7, Math.max(0, Math.round(((v - min) / span) * 7)));
    return SPARK[i];
  }).join("");
  return color ? color(s) : s;
}

/** [██████░░░░] 62% */
export function gauge(ratio, w = 12, label) {
  const r = Math.max(0, Math.min(1, ratio || 0));
  const n = Math.round(r * w);
  const bar = "█".repeat(n) + "░".repeat(Math.max(0, w - n));
  const col = r >= 0.85 ? c.red : r >= 0.6 ? c.yellow : c.green;
  const tail = label != null ? label : `${Math.round(r * 100)}%`;
  return col(bar) + " " + (r >= 0.6 ? col(tail) : c.gray(tail));
}

/** color by share: small = green, large = yellow/red */
export function heat(ratio) {
  if (ratio >= 0.6) return c.red;
  if (ratio >= 0.3) return c.yellow;
  return c.green;
}

export function rule(n = 66, ch = "─") {
  return c.gray(ch.repeat(n));
}

/** rounded panel with title in the top border */
export function panel(title, lines, { w = 66 } = {}) {
  const inner = w - 4;
  const head = title ? ` ${title} ` : "";
  const left = Math.max(0, Math.floor((w - 2 - inner_visual(head)) / 2));
  const top = "┌" + "─".repeat(left) + head + "─".repeat(Math.max(0, w - 2 - left - inner_visual(head))) + "┐";
  const out = [c.cyan(top)];
  for (const ln of lines) {
    const l = typeof ln === "string" ? ln : ln.text;
    out.push(c.cyan("│") + " " + pad(l, inner - 0) + " " + c.cyan("│"));
  }
  out.push(c.cyan("└" + "─".repeat(w - 2) + "┘"));
  return out.join("\n");
}

function inner_visual(s) {
  return width(s);
}

/** simple aligned table (CJK-aware) */
export function table(headers, rows, { aligns = [], indent = "   " } = {}) {
  const cols = headers.length;
  const w = new Array(cols).fill(0);
  for (let i = 0; i < cols; i++) {
    w[i] = Math.max(width(String(headers[i])), ...rows.map((r) => width(String(r[i] ?? ""))));
  }
  const line = (cells, colorFn) => indent + cells.map((cell, i) => {
    const s = pad(String(cell ?? ""), w[i]);
    return colorFn ? colorFn(s, i) : s;
  }).join("  ");
  const out = [];
  out.push(c.white(line(headers)));
  out.push(c.gray(indent + w.map((n) => "─".repeat(n)).join("  ")));
  for (const r of rows) {
    out.push(line(r, (s, i) => (aligns[i] === "r" ? c.white(s) : s)));
  }
  return out.join("\n");
}

/** horizontal ranked bar row: label | bar | value | share */
export function rankRow(label, value, max, { w = 16, labelW = 22, valueStr, share, colorFn } = {}) {
  const bar = hbar(value, max, w, colorFn || ((s) => heat(value / (max || 1))(s)));
  const val = pad(valueStr != null ? valueStr : fmtNum(value), 8);
  const sh = share != null ? c.gray(pad(`${share}%`, 5)) : "";
  return `   ${pad(clip(label, labelW - 1), labelW)} ${bar} ${val} ${sh}`;
}
