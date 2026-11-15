// report.mjs — self-contained HTML dashboard (inline SVG, no external assets).
import { fmtNum, fmtInt, pct } from "./viz.mjs";
import { totalTokens } from "./usage.mjs";
import { estimateTotal, fmtMoney, loadPrices, costOf, priceFor } from "./pricing.mjs";
import { modelProviderMap, continuousDays } from "./render.mjs";

const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[m]));

function barsChart(items, { w = 640, h = 180, padB = 26 } = {}) {
  if (!items.length) return `<div class="muted">暂无数据</div>`;
  const max = Math.max(...items.map((i) => i.value), 1);
  const n = items.length;
  const gap = n > 40 ? 1 : 3;
  const bw = Math.max(2, (w - gap * (n - 1)) / n);
  const rects = items.map((it, i) => {
    const bh = Math.max(it.value > 0 ? 2 : 0, (it.value / max) * (h - padB));
    const x = i * (bw + gap);
    const y = h - padB - bh;
    return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${bh.toFixed(1)}" rx="2" fill="url(#g1)"><title>${esc(it.label)} · ${fmtNum(it.value)} tokens</title></rect>`;
  }).join("");
  const step = Math.ceil(n / 8);
  const labels = items.map((it, i) => (i % step === 0
    ? `<text x="${(i * (bw + gap) + bw / 2).toFixed(1)}" y="${h - 8}" text-anchor="middle" font-size="10" fill="#8b949e">${esc(it.label)}</text>`
    : "")).join("");
  const grid = [0.25, 0.5, 0.75, 1].map((f) => {
    const y = h - padB - f * (h - padB);
    return `<line x1="0" y1="${y.toFixed(1)}" x2="${w}" y2="${y.toFixed(1)}" stroke="#e8ecf1" stroke-width="1"/>`;
  }).join("");
  return `<svg viewBox="0 0 ${w} ${h}" width="100%" preserveAspectRatio="xMidYMid meet">
  <defs><linearGradient id="g1" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0%" stop-color="#5b9dff"/><stop offset="100%" stop-color="#2f6feb"/>
  </linearGradient></defs>
  ${grid}${rects}${labels}
</svg>`;
}

function hbarList(items, { max, unit = "", showPct = true } = {}) {
  const m = max || Math.max(...items.map((i) => i.value), 1);
  return items.map((it) => `
    <div class="row">
      <div class="rowhead"><span class="name" title="${esc(it.name)}">${esc(it.name)}</span>
        <span class="val">${esc(it.display || fmtNum(it.value))}${unit}${showPct && it.share != null ? ` · ${it.share}%` : ""}</span></div>
      <div class="track"><div class="fill" style="width:${Math.max(1, (it.value / m) * 100).toFixed(1)}%"></div></div>
    </div>`).join("");
}

export function buildHtmlReport(agg, { days = 30, title = "Claude Code 用量报告" } = {}) {
  const prices = loadPrices();
  const allTotal = agg.in + agg.out + agg.cacheRead + agg.cacheWrite;
  const hit = (agg.in + agg.cacheRead) ? agg.cacheRead / (agg.in + agg.cacheRead) : 0;
  const est = estimateTotal(agg.byModel, prices);
  const series = continuousDays(agg, days > 0 ? Math.min(days, 90) : 30).map((d) => ({ label: d.day.slice(5), value: d.total }));

  const models = Object.entries(agg.byModel)
    .map(([name, v]) => ({ name, value: totalTokens(v), messages: v.messages, cost: costOf(v, name, prices) }))
    .sort((a, b) => b.value - a.value).slice(0, 10);
  const modelTotal = models.reduce((s, m) => s + m.value, 0) || 1;
  models.forEach((m) => { m.share = pct(m.value, modelTotal); m.display = fmtNum(m.value); });

  const pmap = modelProviderMap();
  const byProv = {};
  for (const [model, v] of Object.entries(agg.byModel)) {
    const p = pmap.get(model);
    const k = p ? p.name : "未归类模型";
    byProv[k] = (byProv[k] || 0) + totalTokens(v);
  }
  const provs = Object.entries(byProv).map(([name, value]) => ({ name, value, display: fmtNum(value) })).sort((a, b) => b.value - a.value);
  const provTotal = provs.reduce((s, p) => s + p.value, 0) || 1;
  provs.forEach((p) => { p.share = pct(p.value, provTotal); });

  const projs = Object.entries(agg.byProject)
    .map(([name, v]) => ({ name, value: totalTokens(v), messages: v.messages }))
    .sort((a, b) => b.value - a.value).slice(0, 8);
  const projTotal = projs.reduce((s, p) => s + p.value, 0) || 1;

  const sessions = Object.keys(agg.bySession).length;
  const activeDays = Object.keys(agg.byDay).length;
  const kpi = [
    ["消息", fmtInt(agg.messages)],
    ["会话", fmtInt(sessions)],
    ["输入", fmtNum(agg.in)],
    ["输出", fmtNum(agg.out)],
    ["缓存命中", fmtNum(agg.cacheRead)],
    ["累计 tokens", fmtNum(allTotal)],
    ["命中率", Math.round(hit * 100) + "%"],
    ["估算费用", est.priced ? fmtMoney(est.total) + " ≈" : "—"],
  ];

  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>
  :root { --bg:#f6f7f9; --card:#fff; --text:#1f2328; --muted:#6b7280; --line:#e8ecf1; --accent:#2f6feb; }
  * { box-sizing:border-box; }
  body { margin:0; padding:32px 20px 56px; background:var(--bg); color:var(--text);
         font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif; }
  .wrap { max-width:960px; margin:0 auto; }
  h1 { font-size:22px; margin:0 0 6px; letter-spacing:.2px; }
  .sub { color:var(--muted); font-size:13px; margin-bottom:24px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:20px 22px; margin-bottom:18px; }
  .card h2 { font-size:14px; margin:0 0 16px; font-weight:600; color:#374151; letter-spacing:.3px; }
  .card h2 span { font-weight:400; color:var(--muted); font-size:12px; margin-left:8px; }
  .kpi { display:grid; grid-template-columns:repeat(4,1fr); gap:1px; background:var(--line);
         border:1px solid var(--line); border-radius:12px; overflow:hidden; margin-bottom:18px; }
  .kpi div { background:var(--card); padding:16px 18px; }
  .kpi .k { color:var(--muted); font-size:12px; margin-bottom:6px; }
  .kpi .v { font-size:20px; font-weight:600; font-variant-numeric:tabular-nums; }
  .row { margin-bottom:12px; }
  .rowhead { display:flex; justify-content:space-between; font-size:13px; margin-bottom:5px; gap:12px; }
  .rowhead .name { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .rowhead .val { color:var(--muted); font-variant-numeric:tabular-nums; white-space:nowrap; }
  .track { height:7px; background:#eef1f5; border-radius:4px; overflow:hidden; }
  .fill { height:100%; background:linear-gradient(90deg,#5b9dff,#2f6feb); border-radius:4px; }
  table { width:100%; border-collapse:collapse; font-size:13px; }
  th,td { text-align:left; padding:9px 8px; border-bottom:1px solid var(--line); }
  th { color:var(--muted); font-weight:500; font-size:12px; }
  td.num, th.num { text-align:right; font-variant-numeric:tabular-nums; }
  tr:last-child td { border-bottom:none; }
  .muted { color:var(--muted); font-size:12px; }
  footer { color:var(--muted); font-size:12px; text-align:center; margin-top:26px; }
  @media (max-width:640px){ .kpi{grid-template-columns:repeat(2,1fr);} }
</style></head><body><div class="wrap">
  <h1>${esc(title)}</h1>
  <div class="sub">最近 ${days} 天 · 活跃 ${activeDays} 天 · 生成于 ${new Date().toLocaleString("zh-CN", { hour12: false })}</div>

  <div class="kpi">${kpi.map(([k, v]) => `<div><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div></div>`).join("")}</div>

  <div class="card"><h2>每日用量<span>token / 天</span></h2>${barsChart(series)}</div>

  <div class="card"><h2>模型 Top 10<span>按 token 总量</span></h2>
    ${hbarList(models.map((m) => ({ ...m, display: fmtNum(m.value) })))}
  </div>

  <div class="card"><h2>渠道分布<span>按模型归属推断</span></h2>
    ${hbarList(provs)}
  </div>

  <div class="card"><h2>项目 Top 8<span>按会话工作目录</span></h2>
    <table><thead><tr><th>项目</th><th class="num">tokens</th><th class="num">消息</th><th class="num">占比</th></tr></thead><tbody>
    ${projs.map((p) => `<tr><td>${esc(p.name)}</td><td class="num">${fmtNum(p.value)}</td><td class="num">${fmtInt(p.messages)}</td><td class="num">${pct(p.value, projTotal)}%</td></tr>`).join("")}
    </tbody></table>
  </div>

  <footer>数据来自 Claude Code 本地会话记录（~/.claude/projects）；费用为参考价估算，可在 ~/.apipick/pricing.json 调整。</footer>
</div></body></html>`;
}
