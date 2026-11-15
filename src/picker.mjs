// picker.mjs — interactive numbered provider/model picker (supports custom providers).
import {
  providerList, resolveProvider, modelPool, getKey, getCurrent, setCurrent, noteFor, costFor,
  setCachedModels, cacheInfo, probeModels,
} from "./core.mjs";
import { addProvider } from "./add.mjs";
import { c, pad, banner, ask, info, warn, err } from "./ui.mjs";

const FRESH_MS = 12 * 3600 * 1000;

async function chooseProvider() {
  const all = providerList();
  const builtin = all.filter((p) => !p.custom);
  const custom = all.filter((p) => p.custom);

  banner("Claude Code  API / 模型管理器", "先选渠道（决定用谁家 API）");
  const index = [...builtin, ...custom];
  index.forEach((p, i) => {
    const cur = getCurrent(p.id) || "(未设置)";
    const hasKey = getKey(p.id) ? c.green("已配置 key") : c.gray("无 key");
    const tag = p.custom ? c.cyan(" [自定义]") : "";
    console.log(`   ${c.white(String(i + 1) + ")")} ${p.label}${tag}   ${hasKey}`);
    console.log(c.gray(`        当前：${cur}`));
  });
  const addNo = index.length + 1;
  console.log(c.gray(`   ${String(addNo).padStart(2)}  ＋ 添加新渠道（自定义 Base URL，自动探测模型）`));
  console.log("");
  const sel = (await ask("   输入序号（回车取消）: ")).trim();
  if (!sel) return null;
  const n = Number(sel);
  if (!Number.isInteger(n) || n < 1 || n > addNo) { err("  [!] 序号无效"); return null; }
  if (n === addNo) {
    const rec = await addProvider({});
    if (!rec) return null;
    return { provider: resolveProvider(rec.id), model: rec.default || "" };
  }
  return { provider: index[n - 1], model: "" };
}

function orderPool(provider, remote) {
  const cur = getCurrent(provider.id);
  const known = provider.known || [];
  const pool = modelPool(provider, remote);
  const rank = new Map();
  known.forEach((m, i) => rank.set(m, i));
  return pool.sort((a, b) => {
    if (a === cur) return -1;
    if (b === cur) return 1;
    const ra = rank.has(a) ? rank.get(a) : 999;
    const rb = rank.has(b) ? rank.get(b) : 999;
    if (ra !== rb) return ra - rb;
    return a.localeCompare(b);
  });
}

async function loadRemote(provider) {
  const key = getKey(provider.id);
  const cached = cacheInfo(provider.id);
  const fresh = cached && Date.now() - Date.parse(cached.at || 0) < FRESH_MS;

  // a cached list is good enough for picking
  if (fresh && cached.models && cached.models.length) return cached.models;

  // no key -> most APIs refuse /models, don't waste 15s
  if (!key) {
    if (cached && cached.models) return cached.models;
    return [];
  }
  info(`   正在读取 ${provider.name} 的模型列表...`);
  const r = await probeModels({
    baseUrl: provider.baseUrl, modelsEndpoint: provider.modelsEndpoint, key, budgetMs: 12000,
  });
  if (r.models.length) { setCachedModels(provider.id, r.models, r.endpoint); return r.models; }
  if (cached && cached.models && cached.models.length) {
    warn(`   联网失败（${r.error}），用上次缓存的 ${cached.models.length} 个模型`);
    return cached.models;
  }
  return [];
}

async function chooseModel(provider) {
  console.log("");
  const remote = await loadRemote(provider);
  if (!remote.length && !(provider.known || []).length) {
    info("   没有内置清单，也没有探测到远程列表");
  }

  const ordered = orderPool(provider, remote);
  const cur = getCurrent(provider.id);
  console.log("");
  console.log(c.white("   " + pad("#", 4) + " " + pad("模型", 46) + " " + pad("用途", 16) + " 费用"));
  console.log(c.gray("   " + "-".repeat(92)));
  ordered.forEach((m, i) => {
    const mark = m === cur ? c.green(" <== 当前") : "";
    const note = noteFor(provider, m);
    const cost = costFor(provider.id, m);
    const costStr = cost === "免费" ? c.cyan(pad(cost, 6)) : pad(cost, 6);
    console.log(`   ${c.white(pad(String(i + 1) + ")", 4))} ${pad(m, 46)} ${pad(note, 16)} ${costStr}${mark}`);
  });
  if (!ordered.length) warn("   没有可用模型，可直接粘贴完整模型 ID。");
  console.log("");
  console.log(c.gray("   输入序号，或直接粘贴完整模型 ID（回车取消）"));
  const ans = (await ask("   > ")).trim();
  if (!ans) return null;
  if (/^\d+$/.test(ans)) {
    const k = Number(ans);
    if (k < 1 || k > ordered.length) { err("  [!] 序号超出范围"); return null; }
    return ordered[k - 1];
  }
  return ans;
}

// pick({providerId}) -> {provider, model} | null
export async function pick({ providerId } = {}) {
  let provider;
  if (providerId) {
    provider = resolveProvider(providerId);
    if (!provider) { err(`  [!] 未知渠道：${providerId}`); return null; }
    banner(provider.label, provider.keyHint ? `key: ${provider.keyHint}` : "");
  } else {
    const sel = await chooseProvider();
    if (!sel) { warn("  已取消。"); return null; }
    provider = sel.provider;
    if (!provider) { err("  [!] 新渠道保存失败"); return null; }
    if (sel.model) {
      setCurrent(provider.id, sel.model);
      console.log("");
      console.log(c.green(`   已保存：${provider.id} -> ${sel.model}`));
      console.log(c.gray(`   说明：${noteFor(provider, sel.model)}`));
      return { provider, model: sel.model };
    }
  }
  if (!getKey(provider.id) && provider.custom !== true) {
    info(`   提示：${provider.id} 还没配 key，选完模型后可运行 api key ${provider.id}`);
  }
  const model = await chooseModel(provider);
  if (!model) { warn("  已取消。"); return null; }
  setCurrent(provider.id, model);
  console.log("");
  console.log(c.green(`   已保存：${provider.id} -> ${model}`));
  console.log(c.gray(`   说明：${noteFor(provider, model)}`));
  return { provider, model };
}
