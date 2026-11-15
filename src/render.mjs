// render.mjs — all the visual output: stats / show / ping / dash.
import { c, pad, width, clip } from "./ui.mjs";
import { panel, hbar, sparkline, gauge, rankRow, fmtNum, fmtInt, pct, rule, table, heat } from "./viz.mjs";
import { daySeries, topN, totalTokens } from "./usage.mjs";
import { estimateTotal, costOf, fmtMoney, loadPrices, priceFor } from "./pricing.mjs";
import { providerList, getCurrent, getKey, ctxLimit, cacheInfo } from "./core.mjs";

/** model id -> provider (exact match against known/cached/current lists) */
export function modelProviderMap() {
  const map = new Map();
  for (const p of providerList()) {
    const ids = new Set([
      ...(p.known || []),
      ...((cacheInfo(p.id) || {}).models || []),
      getCurrent(p.id),
    ].filter(Boolean));
    for (const m of ids) if (!map.has(m)) map.set(m, p);
  }
  return map;
}

/** continuous day series ending today, gaps filled with zeros */
export function continuousDays(agg, days = 14) {
  const have = new Map(Object.entries(agg.byDay).map(([d, v]) => [d, v]));
  const out = [];
  const today = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today.getTime() - i * 86400000).toISOString().slice(0, 10);
    const v = have.get(d);
    out.push({
      day: d, messages: v ? v.messages : 0,
      total: v ? totalTokens(v) : 0,
      in: v ? v.in : 0, out: v ? v.out : 0, cacheRead: v ? v.cacheRead : 0,
    });
  }
  return out;
}

function mmdd(day) { return day.slice(5); }

function cacheHitRate(agg) {
  const denom = (agg.in || 0) + (agg.cacheRead || 0);
  return denom ? (agg.cacheRead || 0) / denom : 0;
}

export function renderStats(agg, { days = 30, withCost = false, scannedNote = "" } = {}) {
  const out = [];
  const prices = loadPrices();
  const hit = cacheHitRate(agg);
  const winLabel = days > 0 ? `最近 ${days} 天` : "全部历史";

  out.push("");
  out.push(c.cyan("  Claude Code 用量") + c.gray("   " + winLabel));
  out.push(rule(70));
  out.push("");

  const kv = (k, v) => c.gray(pad(k, 10)) + c.white(v);
  out.push("  " + kv("消息", pad(fmtInt(agg.messages), 12)) + kv("会话", pad(fmtInt(Object.keys(agg.bySession).length), 10)) + kv("项目", fmtInt(Object.keys(agg.byProject).length)));
  out.push("  " + kv("输入", pad(fmtNum(agg.in), 12)) + kv("输出", pad(fmtNum(agg.out), 10)) + kv("缓存写入", fmtNum(agg.cacheWrite)));
  const hitTag = hit >= 0.7 ? c.green : hit >= 0.4 ? c.yellow : c.red;
  out.push("  " + kv("缓存命中", pad(fmtNum(agg.cacheRead), 12)) + hitTag(`命中率 ${Math.round(hit * 100)}%`) +
    c.gray(`   （命中缓存比正常输入便宜，省下的钱没算）`));
  out.push("");

  // ---- daily ----
  const series = continuousDays(agg, days > 0 ? Math.min(days, 30) : 14);
  const spark = sparkline(series.map((d) => d.total), { color: c.cyan });
  out.push(c.white("  每日用量") + c.gray(`   ${series.length} 天，每格 1 天`));
  out.push("   " + spark + c.gray(`   峰值 ${fmtNum(Math.max(...series.map((d) => d.total), 0))}/天`));
  const busy = [...series].filter((d) => d.total > 0).sort((a, b) => b.total - a.total).slice(0, 7);
  if (busy.length) {
    out.push("");
    const max = busy[0].total;
    for (const d of busy) {
      const label = `${mmdd(d.day)}`;
      out.push(rankRow(label, d.total, max, {
        w: 14, labelW: 7,
        valueStr: fmtNum(d.total),
        share: pct(d.total, agg.in + agg.out + agg.cacheRead + agg.cacheWrite),
      }) + c.gray(`  ${fmtInt(d.messages)}条`));
    }
  }
  out.push("");

  // ---- models ----
  const models = topN(agg.byModel, 8);
  if (models.length) {
    const maxT = models[0].total || 1;
    const totalAll = models.reduce((s, m) => s + m.total, 0) || 1;
    out.push(c.white("  模型 Top 8") + c.gray("   按 token 总量"));
    out.push("");
    for (const m of models) {
      const price = priceFor(m.name, prices);
      const costTag = withCost ? c.gray("  " + (price ? fmtMoney(costOf(m, m.name, prices).total) : "—")) : "";
      out.push(rankRow(m.name, m.total, maxT, {
        w: 16, labelW: 26, valueStr: fmtNum(m.total), share: pct(m.total, totalAll),
      }) + c.gray(`  ${fmtInt(m.messages)}条`) + costTag);
    }
    out.push("");
  }

  // ---- providers ----
  const pmap = modelProviderMap();
  const byProv = {};
  let unmapped = 0;
  for (const [model, v] of Object.entries(agg.byModel)) {
    const p = pmap.get(model);
    const t = totalTokens(v);
    if (!p) { unmapped += t; continue; }
    byProv[p.name] = (byProv[p.name] || 0) + t;
  }
  if (unmapped > 0) byProv["未归类模型"] = unmapped;
  const provs = Object.entries(byProv).sort((a, b) => b[1] - a[1]);
  if (provs.length) {
    const maxP = provs[0][1] || 1;
    const sumP = provs.reduce((s, x) => s + x[1], 0) || 1;
    out.push(c.white("  渠道分布") + c.gray("   按模型归属推断"));
    out.push("");
    for (const [name, t] of provs.slice(0, 8)) {
      out.push(rankRow(name, t, maxP, { w: 16, labelW: 26, valueStr: fmtNum(t), share: pct(t, sumP) }));
    }
    out.push("");
  }

  // ---- projects ----
  const projs = topN(agg.byProject, 5);
  if (projs.length) {
    const maxJ = projs[0].total || 1;
    const sumJ = Object.values(agg.byProject).reduce((s, v) => s + totalTokens(v), 0) || 1;
    out.push(c.white("  项目 Top 5"));
    out.push("");
    for (const j of projs) {
      out.push(rankRow(j.name, j.total, maxJ, { w: 16, labelW: 26, valueStr: fmtNum(j.total), share: pct(j.total, sumJ) }));
    }
    out.push("");
  }

  // ---- cost ----
  const est = estimateTotal(agg.byModel, prices);
  const modelCount = Object.keys(agg.byModel).length;
  out.push(c.white("  费用估算") + c.gray("   参考价，可在 ~/.apipick/pricing.json 修改"));
  out.push("");
  if (est.priced === 0) {
    out.push(c.gray("   还没有可用的价格数据：编辑 pricing.json 里 _待填模型 那几个即可。"));
  } else {
    out.push(`   ${c.gray(pad("已定价", 8))}${c.white(est.priced + " / " + modelCount + " 个模型")}   ` +
      c.gray(pad("合计", 6)) + c.yellow(fmtMoney(est.total)) + c.gray("  ≈"));
    if (est.unpricedTokens > 0) out.push(c.gray(`   另有 ${fmtNum(est.unpricedTokens)} tokens 的模型没有价格，未计入`));
  }
  out.push("");
  if (scannedNote) out.push(c.gray("   " + scannedNote));
  out.push("");
  return out.join("\n");
}

export function renderShow(p, agg = null) {
  const cur = getCurrent(p.id);
  const key = getKey(p.id);
  const ci = cacheInfo(p.id);
  const masked = key ? (key.length > 12 ? key.slice(0, 6) + "…" + key.slice(-4) : "*".repeat(key.length)) : "(未配置)";

  let usageLine = c.gray("(运行 api stats 后显示)");
  if (agg) {
    const pmap = modelProviderMap();
    let tok = 0, msgs = 0, models = 0;
    for (const [model, v] of Object.entries(agg.byModel)) {
      const owner = pmap.get(model);
      if (!owner || owner.id !== p.id) continue;
      tok += totalTokens(v); msgs += v.messages; models++;
    }
    usageLine = tok ? `${fmtNum(tok)} tokens  ·  ${fmtInt(msgs)} 条消息  ·  ${models} 个模型` : c.gray("无记录");
  }

  const rows = [
    ["id", p.id + (p.custom ? "  (自定义)" : "")],
    ["名称", p.name],
    ["Base URL", p.baseUrl],
    ["模型端点", p.modelsEndpoint || c.gray("(靠自动探测)")],
    ["默认模型", p.default || c.gray("(未设置)")],
    ["当前模型", cur || c.gray("(未设置)")],
    ["上下文窗口", fmtInt(ctxLimit(cur || p.default || "", p)) + " tokens"],
    ["API key", masked],
    ["key 获取", p.keyHint || c.gray("—")],
    ["模型清单", ci ? `${ci.models.length} 个（缓存于 ${String(ci.at).slice(0, 16).replace("T", " ")}）` : c.gray("无缓存，可 api scan " + p.id)],
    ["历史用量", usageLine],
  ];
  const labelW = 12;
  const body = rows.map(([k, v]) => c.gray(pad(k, labelW)) + v);
  return "\n" + panel(`渠道 ${p.name}`, body, { w: 74 }) + "\n";
}

export function renderPing(rows) {
  const out = [""];
  out.push(c.cyan("  连通性 / 延迟") + c.gray("   GET /models 实测（不消耗 token）"));
  out.push(rule(70));
  out.push("");
  const okRows = rows.filter((r) => r.ok);
  const maxMs = Math.max(...okRows.map((r) => r.ms), 1);
  for (const r of rows) {
    const id = pad(r.id, 8);
    if (!r.ok) {
      out.push(`   ${c.white(id)} ${c.red("✗ 失败")}  ${c.gray(pad(String(r.error || "").slice(0, 34), 36))}`);
      continue;
    }
    const bar = hbar(maxMs - r.ms + maxMs * 0.08, maxMs * 1.08, 10,
      (s) => (r.ms < 500 ? c.green(s) : r.ms < 1500 ? c.yellow(s) : c.red(s)));
    out.push(`   ${c.white(id)} ${c.green("✓")} ${pad(r.ms + "ms", 8)} ${bar} ${c.gray(pad(r.models + " 个模型", 11))} ${c.gray(r.endpoint)}`);
  }
  out.push("");
  const okN = okRows.length;
  out.push(c.gray(`   ${okN}/${rows.length} 个渠道可达`) + (okN < rows.length ? c.yellow("   失败的多半是 key 无效或网络不通") : ""));
  out.push("");
  return out.join("\n");
}

export function renderDash(agg, { days = 7 } = {}) {
  const out = [""];
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const t = agg.byDay[today] || { in: 0, out: 0, cacheRead: 0, cacheWrite: 0, messages: 0 };
  const todayTotal = totalTokens(t);
  const allTotal = agg.in + agg.out + agg.cacheRead + agg.cacheWrite;
  const hit = cacheHitRate(agg);

  const boxW = 58;
  const boxLine = (txt) => {
    const t = " " + txt;
    return c.cyan("  │") + t + " ".repeat(Math.max(0, boxW - width(t))) + c.cyan("│");
  };
  out.push(c.cyan("  ╭" + "─".repeat(boxW) + "╮"));
  out.push(boxLine(c.cyan("Claude Code 仪表盘") + c.gray("   " + now.toLocaleDateString("zh-CN"))));
  out.push(boxLine(`${c.gray("今日")} ${c.white(fmtNum(todayTotal))} tok / ${fmtInt(t.messages)} 条   ${c.gray("累计")} ${c.white(fmtNum(allTotal))} tok`));
  out.push(c.cyan("  ╰" + "─".repeat(boxW) + "╯"));
  out.push("");

  // channels
  const pmap = modelProviderMap();
  const byProv = {};
  for (const [model, v] of Object.entries(agg.byModel)) {
    const p = pmap.get(model);
    const key = p ? p.id : "??";
    byProv[key] = byProv[key] || { tokens: 0, name: p ? p.name : "未归类", models: new Set() };
    byProv[key].tokens += totalTokens(v);
    byProv[key].models.add(model);
  }
  const order = Object.entries(byProv).sort((a, b) => b[1].tokens - a[1].tokens).slice(0, 6);
  const maxT = order.length ? order[0][1].tokens : 1;
  out.push(c.white("  渠道用量"));
  out.push("");
  for (const [id, v] of order) {
    const p = providerList().find((x) => x.id === id);
    const cur = p ? getCurrent(p.id) : "";
    const ctxL = p && cur ? ctxLimit(cur, p) : 0;
    out.push(`   ${c.white(pad(id, 6))}${pad(clip(v.name, 21), 22)}${hbar(v.tokens, maxT, 18)} ${pad(fmtNum(v.tokens), 8)} ${c.gray(v.models.size + " 个模型")}`);
    if (cur) out.push(c.gray(`         ${pad("当前模型", 10)}${clip(cur, 40)}${ctxL ? "   " + fmtInt(ctxL) + " tok 窗口" : ""}`));
  }
  out.push("");

  // today sparkline per hour? we only have per-day; show last N days
  const series = continuousDays(agg, days);
  out.push(c.white(`  近 ${days} 天`) + c.gray("   每格 1 天"));
  out.push("   " + sparkline(series.map((d) => d.total), { color: c.cyan }) +
    c.gray(`   ${mmdd(series[0]?.day || "")} → ${mmdd(series[series.length - 1]?.day || "")}`));
  out.push("");

  const models = topN(agg.byModel, 5);
  if (models.length) {
    const maxM = models[0].total || 1;
    out.push(c.white("  最常用模型"));
    out.push("");
    for (const m of models) {
      out.push(rankRow(m.name, m.total, maxM, { w: 14, labelW: 26, valueStr: fmtNum(m.total), share: pct(m.total, allTotal) }));
    }
    out.push("");
  }

  const est = estimateTotal(agg.byModel, loadPrices());
  out.push(c.gray(`  缓存命中率 ${Math.round(hit * 100)}%   ·   估算费用 ${est.priced ? fmtMoney(est.total) + " ≈" : "未配置价格"}`));
  out.push("");
  return out.join("\n");
}
