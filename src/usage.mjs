// usage.mjs — read Claude Code session logs and aggregate token usage (incremental + cached).
import { readFileSync, writeFileSync, existsSync, statSync, readdirSync, openSync, readSync, closeSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { homeDir } from "./core.mjs";

const CACHE_VERSION = 3;

export function sessionsRoot() {
  return process.env.CLAUDE_PROJECTS_DIR || join(homedir(), ".claude", "projects");
}
function cachePath() { return join(homeDir(), "usage.cache.json"); }

export function hasUsageCache() {
  try { return existsSync(cachePath()); } catch { return false; }
}

function emptyAgg() {
  return {
    messages: 0, in: 0, out: 0, cacheRead: 0, cacheWrite: 0,
    byDay: {}, byModel: {}, bySession: {}, byProject: {},
    firstTs: "", lastTs: "",
  };
}

function addTo(bucket, key, inT, outT, cacheRead, cacheWrite) {
  if (!bucket[key]) bucket[key] = { messages: 0, in: 0, out: 0, cacheRead: 0, cacheWrite: 0 };
  const b = bucket[key];
  b.messages++; b.in += inT; b.out += outT; b.cacheRead += cacheRead; b.cacheWrite += cacheWrite;
  return b;
}

/** parse one jsonl line into agg; cheap bail-out for lines without usage */
function ingest(line, agg) {
  if (line.length < 20 || line.indexOf('"usage"') < 0) return;
  let o;
  try { o = JSON.parse(line); } catch { return; }
  const u = o && o.message && o.message.usage;
  if (!u) return;
  const inT = u.input_tokens || 0;
  const outT = u.output_tokens || 0;
  const cr = u.cache_read_input_tokens || 0;
  const cw = u.cache_creation_input_tokens || 0;
  if (!inT && !outT && !cr && !cw) return;

  const ts = o.timestamp || "";
  const day = ts ? ts.slice(0, 10) : "unknown";
  const model = (o.message && o.message.model) || o.requestedModel || "unknown";

  agg.messages++; agg.in += inT; agg.out += outT; agg.cacheRead += cr; agg.cacheWrite += cw;
  const dayB = addTo(agg.byDay, day, inT, outT, cr, cw);
  if (!dayB.models) dayB.models = {};
  addTo(dayB.models, model, inT, outT, cr, cw);   // model split per day, so --days stays exact
  addTo(agg.byModel, model, inT, outT, cr, cw);
  if (o.sessionId) addTo(agg.bySession, o.sessionId, inT, outT, cr, cw);
  if (o.cwd) {
    const short = String(o.cwd).split(/[\\/]/).filter(Boolean).pop() || o.cwd;
    addTo(agg.byProject, short, inT, outT, cr, cw);
  }
  if (ts) {
    if (!agg.firstTs || ts < agg.firstTs) agg.firstTs = ts;
    if (!agg.lastTs || ts > agg.lastTs) agg.lastTs = ts;
  }
}

/** read a file from byte offset, parsing only complete lines; returns new offset */
function scanFileInto(fp, startOffset, agg) {
  const size = statSync(fp).size;
  if (startOffset >= size) return startOffset;
  const fd = openSync(fp, "r");
  let pos = startOffset;
  let rem = Buffer.alloc(0);
  const CHUNK = 4 * 1024 * 1024;
  try {
    while (pos < size) {
      const want = Math.min(CHUNK, size - pos);
      const buf = Buffer.allocUnsafe(want);
      const got = readSync(fd, buf, 0, want, pos);
      if (got <= 0) break;
      pos += got;
      const chunk = rem.length ? Buffer.concat([rem, buf.subarray(0, got)]) : buf.subarray(0, got);
      let from = 0;
      let idx;
      while ((idx = chunk.indexOf(0x0a, from)) >= 0) {
        ingest(chunk.toString("utf8", from, idx), agg);
        from = idx + 1;
      }
      rem = Buffer.from(chunk.subarray(from));
    }
  } finally {
    closeSync(fd);
  }
  return size - rem.length;
}

function listJsonl(root) {
  const out = [];
  let dirs = [];
  try { dirs = readdirSync(root); } catch { return out; }
  for (const d of dirs) {
    const p = join(root, d);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (!st.isDirectory()) continue;
    let files = [];
    try { files = readdirSync(p); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith(".jsonl")) continue;
      const fp = join(p, f);
      try { out.push({ fp, size: statSync(fp).size }); } catch { /* skip */ }
    }
  }
  return out;
}

function mergeAgg(into, from) {
  into.messages += from.messages; into.in += from.in; into.out += from.out;
  into.cacheRead += from.cacheRead; into.cacheWrite += from.cacheWrite;
  for (const k of ["byDay", "byModel", "bySession", "byProject"]) {
    for (const [key, v] of Object.entries(from[k] || {})) {
      if (!into[k][key]) into[k][key] = { ...v, models: v.models ? { ...v.models } : undefined };
      else {
        const t = into[k][key];
        t.messages += v.messages; t.in += v.in; t.out += v.out;
        t.cacheRead += v.cacheRead; t.cacheWrite += v.cacheWrite;
        if (v.models) {
          if (!t.models) t.models = {};
          for (const [m, mv] of Object.entries(v.models)) {
            if (!t.models[m]) t.models[m] = { ...mv };
            else {
              const x = t.models[m];
              x.messages += mv.messages; x.in += mv.in; x.out += mv.out;
              x.cacheRead += mv.cacheRead; x.cacheWrite += mv.cacheWrite;
            }
          }
        }
      }
    }
  }
  if (from.firstTs && (!into.firstTs || from.firstTs < into.firstTs)) into.firstTs = from.firstTs;
  if (from.lastTs && (!into.lastTs || from.lastTs > into.lastTs)) into.lastTs = from.lastTs;
}

/**
 * Walk ~/.claude/projects and aggregate usage.
 * Only new bytes are parsed on later runs (offset + mtime cache), so this stays fast
 * even when the logs are hundreds of MB.
 */
export function collectUsage({ force = false, onProgress } = {}) {
  const root = sessionsRoot();
  let cache = { version: CACHE_VERSION, files: {} };
  if (!force && existsSync(cachePath())) {
    try {
      const j = JSON.parse(readFileSync(cachePath(), "utf8"));
      if (j && j.version === CACHE_VERSION && j.files) cache = j;
    } catch { /* rebuild */ }
  }

  const files = listJsonl(root);
  const global = emptyAgg();
  let scanned = 0, reused = 0, bytesRead = 0;

  for (const { fp, size } of files) {
    const prev = cache.files[fp];
    let st;
    try { st = statSync(fp); } catch { continue; }

    let entry;
    if (prev && prev.offset != null && size >= prev.offset && prev.size === size && prev.mtimeMs === st.mtimeMs) {
      entry = prev;                       // untouched
      reused++;
    } else if (prev && prev.offset != null && size >= prev.offset && prev.agg) {
      // grown (or touched): parse only the tail
      entry = { offset: prev.offset, size, mtimeMs: st.mtimeMs, agg: prev.agg };
      const before = entry.offset;
      entry.offset = scanFileInto(fp, entry.offset, entry.agg);
      bytesRead += entry.offset - before;
      scanned++;
    } else {
      entry = { offset: 0, size, mtimeMs: st.mtimeMs, agg: emptyAgg() };
      entry.offset = scanFileInto(fp, 0, entry.agg);
      bytesRead += entry.offset;
      scanned++;
    }
    cache.files[fp] = entry;
    mergeAgg(global, entry.agg);
    if (onProgress) onProgress({ fp, scanned, reused });
  }

  // drop entries for deleted files
  const alive = new Set(files.map((f) => f.fp));
  for (const k of Object.keys(cache.files)) if (!alive.has(k)) delete cache.files[k];

  cache.version = CACHE_VERSION;
  cache.savedAt = new Date().toISOString();
  try {
    mkdirSync(homeDir(), { recursive: true });
    writeFileSync(cachePath(), JSON.stringify(cache));
  } catch { /* cache is best-effort */ }

  return { agg: global, files: files.length, scanned, reused, bytesRead, savedAt: cache.savedAt };
}

// ---------- views over the aggregate ----------
/** slice to the last `days` days; model split is exact (rebuilt from per-day data) */
export function filteredByDays(agg, days) {
  if (!days || days <= 0) return agg;
  const cutoff = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const out = emptyAgg();
  for (const [day, v] of Object.entries(agg.byDay)) {
    if (day < cutoff) continue;
    out.messages += v.messages; out.in += v.in; out.out += v.out;
    out.cacheRead += v.cacheRead; out.cacheWrite += v.cacheWrite;
    out.byDay[day] = { ...v };
    for (const [m, mv] of Object.entries(v.models || {})) {
      if (!out.byModel[m]) out.byModel[m] = { messages: 0, in: 0, out: 0, cacheRead: 0, cacheWrite: 0 };
      const t = out.byModel[m];
      t.messages += mv.messages; t.in += mv.in; t.out += mv.out;
      t.cacheRead += mv.cacheRead; t.cacheWrite += mv.cacheWrite;
    }
  }
  // sessions/projects are only tracked all-time
  for (const k of ["bySession", "byProject"]) out[k] = agg[k];
  out.firstTs = agg.firstTs; out.lastTs = agg.lastTs;
  return out;
}

export function daySeries(agg, days = 14) {
  const keys = Object.keys(agg.byDay).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  const want = keys.slice(-days);
  return want.map((d) => {
    const v = agg.byDay[d];
    return { day: d, messages: v.messages, total: v.in + v.out + v.cacheRead + v.cacheWrite, in: v.in, out: v.out, cacheRead: v.cacheRead };
  });
}

export function topN(obj, n = 8, key = "total") {
  return Object.entries(obj)
    .map(([name, v]) => ({ name, ...v, total: v.in + v.out + v.cacheRead + v.cacheWrite }))
    .sort((a, b) => (key === "messages" ? b.messages - a.messages : b.total - a.total))
    .slice(0, n);
}

export function totalTokens(v) {
  return (v.in || 0) + (v.out || 0) + (v.cacheRead || 0) + (v.cacheWrite || 0);
}
