// pricing.mjs — optional cost estimation. Prices are 元 / 百万 tokens and are only a reference.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homeDir } from "./core.mjs";

// 参考价（人民币 / 百万 tokens），只收录少量常见模型；其余显示 "—"。
// 想精确就在 ~/.apipick/pricing.json 里按同样格式覆盖，例如：
//   { "deepseek-chat": { "in": 2, "cacheRead": 0.5, "out": 8 } }
const DEFAULT_PRICES = {
  "deepseek-chat": { in: 2, cacheRead: 0.5, out: 8 },
  "deepseek-reasoner": { in: 4, cacheRead: 1, out: 16 },
  "glm-4.7-flash": { in: 0, cacheRead: 0, out: 0 },
  "glm-5.3-flash": { in: 0.5, cacheRead: 0.1, out: 2 },
};

export function pricingPath() { return join(homeDir(), "pricing.json"); }

export function loadPrices() {
  const p = pricingPath();
  if (existsSync(p)) {
    try {
      const j = JSON.parse(readFileSync(p, "utf8"));
      if (j && typeof j === "object") return { ...DEFAULT_PRICES, ...j };
    } catch { /* fall through */ }
  }
  return { ...DEFAULT_PRICES };
}

export function ensurePricingTemplate(models = []) {
  const p = pricingPath();
  if (existsSync(p)) return p;
  try {
    mkdirSync(homeDir(), { recursive: true });
    const tpl = {
      _说明: "单位：元 / 百万 tokens；cacheRead 是缓存命中的输入价。只填确认过的模型，未填的显示 —",
    };
    for (const [k, v] of Object.entries(DEFAULT_PRICES)) tpl[k] = v;
    const missing = models.filter((m) => m && !DEFAULT_PRICES[m]);
    if (missing.length) {
      tpl._待填模型 = missing;
      console.log("");
      console.log(`  提示：${missing.length} 个模型还没有价格（显示为 —）。要估算费用就编辑 ${p}，把 _待填模型 里的名字挪出来填价。`);
    }
    writeFileSync(p, JSON.stringify(tpl, null, 2));
  } catch { /* best effort */ }
  return p;
}

/** price for one model, or null when unknown (exact match only — no guessing) */
export function priceFor(model, prices) {
  const table = prices || loadPrices();
  if (!model) return null;
  const hit = Object.keys(table).find((k) => !k.startsWith("_") && k === model);
  return hit ? table[hit] : null;
}

/**
 * cost of one usage bucket. Returns null when the model has no price.
 * usage = { in, out, cacheRead }  (tokens)
 */
export function costOf(usage, model, prices) {
  const pr = priceFor(model, prices);
  if (!pr) return null;
  const inTok = usage.in || 0;
  const cacheTok = usage.cacheRead || 0;
  const outTok = usage.out || 0;
  const cachePrice = pr.cacheRead != null ? pr.cacheRead : pr.in;
  const total = (inTok / 1e6) * (pr.in || 0) + (cacheTok / 1e6) * (cachePrice || 0) + (outTok / 1e6) * (pr.out || 0);
  return { total, in: inTok, out: outTok, cache: cacheTok };
}

export function fmtMoney(yuan) {
  if (yuan == null) return "—";
  if (yuan === 0) return "¥0";
  if (yuan < 0.01) return "¥" + yuan.toFixed(4);
  if (yuan < 1) return "¥" + yuan.toFixed(3);
  if (yuan < 100) return "¥" + yuan.toFixed(2);
  return "¥" + Math.round(yuan).toLocaleString("en-US");
}

/** total estimated cost across the byModel split */
export function estimateTotal(byModel, prices) {
  let sum = 0;
  let priced = 0;
  let unpricedTokens = 0;
  for (const [model, v] of Object.entries(byModel)) {
    const c = costOf(v, model, prices);
    if (!c) {
      unpricedTokens += (v.in || 0) + (v.out || 0) + (v.cacheRead || 0);
      continue;
    }
    sum += c.total;
    priced++;
  }
  return { total: sum, priced, unpricedTokens };
}
