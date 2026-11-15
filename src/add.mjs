// add.mjs — interactive wizard: add a custom provider + auto-discover its models.
import {
  providerList, resolveProvider, loadCustomProviders, saveCustomProvider, deleteCustomProvider,
  getKey, setKey, probeModels, setCachedModels, getCurrent, setCurrent, ctxLimit, isChatModel,
} from "./core.mjs";
import { banner, c, pad, ask, askHidden, info, ok, warn, err } from "./ui.mjs";

function normBase(u) {
  let s = String(u || "").trim();
  if (!s) return "";
  if (!/^https?:\/\//i.test(s)) s = "https://" + s;
  return s.replace(/\/+$/, "");
}

function validId(s) {
  return /^[a-z][a-z0-9_-]{0,15}$/i.test(s);
}

/**
 * addProvider({id,name,baseUrl,key,model,ctx,interactive})
 * Flags pre-fill answers; anything missing is asked (unless interactive === false).
 * Returns the saved provider record, or null if cancelled.
 */
export async function addProvider(opts = {}) {
  const askable = opts.interactive !== false;
  banner("添加自定义渠道", "任何 Anthropic / OpenAI 兼容的 API 都能加，模型列表自动探测");

  // ---- id ----
  let id = (opts.id || "").trim().toLowerCase();
  const builtinIds = providerList().filter((p) => !p.custom).map((p) => p.id);
  while (true) {
    if (!id) {
      if (!askable) { err("  [!] 缺少渠道 id"); return null; }
      console.log(c.gray("   短名，用于命令（如 relay / work / home）。只能用字母数字 _ -"));
      id = (await ask("   渠道 id: ")).trim().toLowerCase();
      if (!id) { warn("  已取消。"); return null; }
    }
    if (!validId(id)) {
      err("  [!] id 只能用字母开头，字母/数字/_/-，最长 16 位");
      id = ""; if (!askable) return null; continue;
    }
    if (builtinIds.includes(id)) {
      err(`  [!] "${id}" 是内置渠道的 id，请换一个（例如 ${id}2、my-${id}）`);
      id = ""; if (!askable) return null; continue;
    }
    break;
  }

  const existing = loadCustomProviders()[id];

  // ---- name ----
  let name = (opts.name || "").trim();
  if (!name && askable) {
    name = (await ask(`   显示名（回车用 "${id}"）: `)).trim() || id;
  }
  name = name || id;

  // ---- base url ----
  let baseUrl = normBase(opts.baseUrl);
  while (true) {
    if (!baseUrl) {
      if (!askable) { err("  [!] 缺少 Base URL"); return null; }
      console.log(c.gray("   Claude Code 走 ANTHROPIC_BASE_URL，填能接 anthropic messages 的那个地址"));
      console.log(c.gray("   例：https://api.deepseek.com/anthropic   /   https://your-relay.com"));
      baseUrl = normBase(await ask("   Base URL: "));
      if (!baseUrl) { warn("  已取消。"); return null; }
    }
    try { new URL(baseUrl); break; } catch {
      err("  [!] 不是合法 URL：" + baseUrl);
      baseUrl = ""; if (!askable) return null;
    }
  }

  // ---- key ----
  let key = typeof opts.key === "string" ? opts.key.trim() : "";
  const oldKey = getKey(id);
  if (!key && oldKey) key = oldKey;
  if (!key && askable) {
    console.log(c.gray("   没有 key 可跳过（之后用 api key " + id + " 补）"));
    key = (await askHidden("   API key（回车跳过）: ")).trim();
  }

  // ---- probe models ----
  const envKey = key || oldKey;
  console.log("");
  info(`   正在探测模型列表${envKey ? "" : "（无 key，可能失败）"}...`);
  const probed = await probeModels({
    baseUrl, modelsEndpoint: opts.modelsEndpoint, key: envKey,
  });

  let models = probed.models;
  let model = (opts.model || "").trim();

  if (models.length) {
    ok(`   ✓ ${probed.endpoint} 找到 ${models.length} 个可用模型`);
    setCachedModels(id, models, probed.endpoint);
    console.log("");
    const show = models.slice(0, 40);
    show.forEach((m, i) => {
      console.log(`   ${c.white(pad(String(i + 1) + ")", 4))} ${m}`);
    });
    if (models.length > show.length) console.log(c.gray(`   ...另有 ${models.length - show.length} 个，用 api models ${id} 查看全部`));
    console.log("");
    if (!model && askable) {
      const ans = (await ask("   选默认模型（序号 / 直接粘贴模型 id / 回车跳过）: ")).trim();
      if (/^\d+$/.test(ans)) {
        const k = Number(ans);
        if (k >= 1 && k <= show.length) model = show[k - 1];
      } else if (ans) {
        model = ans;
      }
    }
    if (!model) model = models[0];
  } else {
    warn(`   ✗ 没探测到模型列表（${probed.error || "原因未知"}）`);
    if (askable) {
      console.log(c.gray("   可以手填默认模型 id，也可以留空——之后用 api scan " + id + " 再试"));
      model = (await ask("   默认模型 id（回车跳过）: ")).trim();
    }
  }

  // ---- context window ----
  let ctx = Number(opts.ctx) || 0;
  if (!ctx && askable) {
    const guess = ctxLimit(model || "", {});
    const ans = (await ask(`   上下文窗口 tokens（回车=${guess}）: `)).trim();
    if (ans) {
      const n = Number(ans.replace(/[,_\s]/g, ""));
      if (Number.isFinite(n) && n >= 4096) ctx = n;
      else warn(`  [!] 忽略无效值，用 ${guess}`);
    }
    if (!ctx) ctx = guess;
  }

  // ---- 额外协议端点（同一个渠道可能同时提供 openai / gemini / responses）----
  const endpoints = { ...((existing && existing.endpoints) || {}) };
  for (const k of ["openai", "gemini", "responses"]) {
    const v = opts.endpoints && opts.endpoints[k];
    if (v) endpoints[k] = String(v).trim();
  }

  // ---- save ----
  const known = [...new Set([
    ...(model ? [model] : []),
    ...(models.length ? models.slice(0, 200) : (existing && existing.known) || []),
  ])];
  const rec = {
    id, name,
    label: `${name}  (自定义)`,
    baseUrl,
    modelsEndpoint: probed.endpoint || "",
    default: model || "",
    known,
    ctx: ctx || 0,
    keyHint: opts.keyHint || "",
    custom: true,
    ...(Object.keys(endpoints).length ? { endpoints } : {}),
  };
  saveCustomProvider(rec);
  if (key) setKey(id, key);
  if (model) setCurrent(id, model);

  console.log("");
  ok(`   ✓ 已保存渠道 ${c.white(id)}（${name}）`);
  console.log(c.gray(`     BaseURL : ${baseUrl}`));
  console.log(c.gray(`     Models  : ${rec.modelsEndpoint || "(未探测到)"}`));
  console.log(c.gray(`     默认模型 : ${model || "(未设置)"}`));
  console.log(c.gray(`     上下文   : ${rec.ctx || ctxLimit(model || "", {})} tokens`));
  console.log(c.gray(`     配置文件 : ${c.gray("~/.apipick/providers.json")}`));
  console.log("");
  if (model) {
    console.log(c.gray(`   现在可以：`) + c.white(`api run ${id}`) + c.gray(`   或   `) + c.white(`api use ${id}`));
    console.log("");
  }
  return rec;
}

export async function removeProvider(idOrAlias) {
  const p = resolveProvider(idOrAlias);
  if (!p) { err(`[!] 未知渠道：${idOrAlias}`); return 1; }
  if (!p.custom) { err(`[!] ${p.id} 是内置渠道，不能删除（可用 api key 清空它的 key）`); return 1; }
  if (!deleteCustomProvider(p.id)) { err(`[!] 删除失败：${p.id} 不在自定义列表里`); return 1; }
  ok(`  已删除自定义渠道 ${p.id}（连同它的 key 和模型缓存）`);
  return 0;
}
