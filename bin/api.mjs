#!/usr/bin/env node
// api — Claude Code API / model manager (single entry, cross-platform).
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

import {
  providerList, resolveProvider, getCurrent, setCurrent, getLast, setLast,
  getKey, setKey, modelPool, noteFor, costFor, homeDir,
  probeModels, setCachedModels, cacheInfo, ctxLimit, getTarget, setTarget,
} from "../src/core.mjs";
import { pick } from "../src/picker.mjs";
import { launch } from "../src/launch.mjs";
import { addProvider, removeProvider } from "../src/add.mjs";
import {
  TARGETS, findTarget, which, envSet, formatEnv, endpointFor, protoSupport,
} from "../src/targets.mjs";
import { collectUsage, filteredByDays, topN, totalTokens, hasUsageCache } from "../src/usage.mjs";
import { renderStats, renderShow, renderPing, renderDash } from "../src/render.mjs";
import { buildHtmlReport } from "../src/report.mjs";
import { startServer, isExposed } from "../src/serve/index.mjs";
import { ensurePricingTemplate, estimateTotal, loadPrices, fmtMoney } from "../src/pricing.mjs";
import { fmtNum } from "../src/viz.mjs";
import { banner, c, pad, width, ask, askHidden, info, ok, warn, err } from "../src/ui.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
let VERSION = "1.0.0";
try { VERSION = JSON.parse(readFileSync(join(HERE, "..", "package.json"), "utf8")).version; } catch { /* ignore */ }

function help() {
  const line = (k, v) => console.log(`   ${c.white(pad(k, 40))}${c.gray(v)}`);
  const head = (t) => { console.log(""); console.log(c.white("  " + t)); };
  console.log("");
  console.log(c.cyan("  apipick") + c.gray("  —  一个 api 命令，管所有 AI CLI 的渠道与模型"));

  head("渠道与模型");
  line("api", "交互式：选渠道 → 选模型 → 启动");
  line("api list", "列出所有渠道（内置 + 自定义）、当前模型、key 状态");
  line("api show <渠道>", "单个渠道详情：端点 / key / 模型 / 历史用量");
  line("api add [id]", "添加自定义渠道：填 Base URL，自动探测该家有哪些模型");
  line("api rm <渠道>", "删除自定义渠道（连同 key 与模型缓存）");
  line("api use <渠道> [模型]", "切换/设置某渠道的当前模型");
  line("api key <渠道> [值]", "设置/更新 API key（不填则隐藏输入）");
  line("api models <渠道>", "列出该渠道的模型（内置清单 + 已探测缓存）");
  line("api scan [渠道|--all]", "联网拉取模型列表并缓存（不填=全部有 key 的渠道）");
  line("api run [渠道] [-- 参数]", "用指定渠道启动目标 CLI（默认 claude，省略=上次渠道）");
  line("api pick [渠道]", "只选模型，不启动");

  head("多 CLI：同一个渠道喂给不同工具");
  line("api targets", "支持哪些 CLI、本机装没装、各自吃哪种协议");
  line("api target <cli>", "设默认目标：claude / qwen / codex / gemini / aider / opencode");
  line("api run <渠道> --target qwen", "临时换个 CLI 启动，不改默认");
  line("api config <渠道> -t codex", "预览要写的配置（--write 才落盘）");
  line("api env <渠道> [--shell pwsh]", "导出通用环境变量，任何 CLI 都能接（--json 出 JSON）");

  head("看板 / 可视化");
  line("api stats [--days N|all]", "用量统计：每日柱状图 · 模型榜 · 渠道分布 · 费用（--json 出原始数据）");
  line("api dash [--watch 5]", "一屏仪表盘：今日 / 渠道用量 / 趋势 / Top 模型");
  line("api ping [渠道]", "各渠道连通性与延迟条形图（不消耗 token）");
  line("api report [--days N]", "生成 HTML 可视化报告，浏览器打开看");

  head("serve：本地协议转换（默认不开，需要时再起）");
  line("api serve", "起本地网关，让只会说 Anthropic 的 CLI 用上任意协议的渠道");
  line("api serve --provider ds", "固定一个渠道，模型名照旧写");
  line("api serve --provider ds --wire openai", "指定出站协议：anthropic / openai / responses / gemini");
  line("api serve --port 8788 --log", "换端口，并打印每次请求的渠道/模型/耗时/tokens");
  line("api serve --host 0.0.0.0 --token <口令>", "给同网段其他机器用；不设 token 会拒绝启动");
  line("api serve --max-body 2 --max-conn 8", "请求体上限（MiB，默认 8）、并发上限（默认 32）");
  line("api serve --timeout 60", "上游多少秒没动静就断开（默认 300）");
  line("api serve --no-prefix", "关掉模型名前缀路由（默认开：/model ds/deepseek-chat 直接换渠道）");
  line("", "入站支持 /v1/messages、/v1/chat/completions、/v1/responses、/v1beta/models/*");

  head("常用参数");
  line("--days 7|30|all", "统计窗口（默认 30 天）");
  line("--cost", "在模型榜里额外显示费用估算");
  line("--refresh", "忽略缓存，重扫全部会话记录");
  line("--out <文件>", "report 的输出路径");
  line("--target <cli> / -t", "目标 CLI（临时覆盖默认值）");
  line("--wire responses|chat", "codex 用哪种接口（默认 responses）");
  line("--no-ask --base --key --model", "api add 的非交互写法");

  head("渠道 id");
  const all = providerList();
  const fmt = (p) => (p.custom ? `${p.id}*` : p.id) + `(${p.name.length > 14 ? p.name.slice(0, 14) + "…" : p.name})`;
  for (let i = 0; i < all.length; i += 4) {
    console.log(c.gray("   " + all.slice(i, i + 4).map(fmt).join("  ")));
  }
  console.log("");
  console.log(c.gray(`  配置目录：${homeDir()}   ·   版本 ${VERSION}`));
  console.log("");
}

function printProviders() {
  const all = providerList();
  banner("渠道列表", `配置目录：${homeDir()}`);
  const idW = Math.max(6, ...all.map((p) => p.id.length + (p.custom ? 1 : 0) + 2));
  const nameW = Math.max(24, ...all.map((p) => width(p.name) + 2));
  const modelW = Math.max(30, ...all.map((p) => width(getCurrent(p.id) || "(未设置)") + 2));
  console.log(c.white(`   ${pad("id", idW)}${pad("渠道", nameW)}${pad("当前模型", modelW)}key`));
  console.log(c.gray("   " + "-".repeat(idW + nameW + modelW + 6)));
  for (const p of all) {
    const cur = getCurrent(p.id) || c.gray("(未设置)");
    const key = getKey(p.id) ? c.green("已配置") : c.gray("无");
    const id = p.custom ? c.white(pad(p.id + "*", idW)) : c.white(pad(p.id, idW));
    console.log(`   ${id}${pad(p.name, nameW)}${pad(cur, modelW)}${key}`);
  }
  console.log("");
  console.log(c.gray("   * = 自定义渠道（自己加的）"));
  console.log(c.gray("   添加：api add     切换：api use <id>     启动：api run <id>   详情：api show <id>"));
  if (hasUsageCache()) {
    try {
      const agg = collectUsage({}).agg;
      const today = new Date().toISOString().slice(0, 10);
      const t = agg.byDay[today] ? totalTokens(agg.byDay[today]) : 0;
      console.log(c.gray(`   用量：今日 ${fmtNum(t)} · 累计 ${fmtNum(totalTokens(agg))} tokens   ·   api stats 看图表`));
    } catch { /* ignore */ }
  } else {
    console.log(c.gray("   提示：api stats 看用量图表（首次会扫一遍会话日志，之后走缓存）"));
  }
  console.log("");
}

function printModels(p) {
  const pool = modelPool(p, []);
  const ci = cacheInfo(p.id);
  const sub = [
    `key：${getKey(p.id) ? "已配置" : "未配置"}`,
    ci ? `缓存：${ci.models.length} 个（${String(ci.at).slice(0, 16).replace("T", " ")}）` : "缓存：无",
  ].join("   ·   ");
  banner(`${p.name} 的模型`, sub);
  const cur = getCurrent(p.id);
  console.log(c.white("   " + pad("#", 4) + " " + pad("模型", 46) + " " + pad("用途", 16) + " 费用"));
  console.log(c.gray("   " + "-".repeat(92)));
  pool.forEach((m, i) => {
    const mark = m === cur ? c.green("  <== 当前") : "";
    const cost = costFor(p.id, m);
    const costStr = cost === "免费" ? c.cyan(pad(cost, 6)) : pad(cost, 6);
    console.log(`   ${c.white(pad(String(i + 1) + ")", 4))} ${pad(m, 46)} ${pad(noteFor(p, m), 16)} ${costStr}${mark}`);
  });
  if (!pool.length) console.log(c.gray("   (空) 用 api scan " + p.id + " 联网拉一次"));
  console.log("");
  console.log(c.gray(`   提示：api use ${p.id} <模型> 切换；api scan ${p.id} 刷新列表`));
  console.log("");
}

async function cmdKey(p, value) {
  let v = value;
  if (v === undefined) {
    console.log("");
    if (p.keyHint) info(`   获取地址：${p.keyHint}`);
    v = (await askHidden(`   粘贴 ${p.name} 的 API key（回车取消）: `)).trim();
  }
  if (!v) { warn("  已取消。"); return; }
  setKey(p.id, v.trim());
  ok(`  已保存 ${p.id} 的 key（${join(homeDir(), "keys.json")}）`);
}

async function cmdScanOne(p, { quiet = false } = {}) {
  const key = getKey(p.id);
  if (!key && p.custom !== true) { warn(`  ${p.id}：还没配 key，跳过（api key ${p.id}）`); return null; }
  if (!quiet) info(`  正在拉取 ${p.name} 的模型列表...`);
  const r = await probeModels({
    baseUrl: p.baseUrl, modelsEndpoint: p.modelsEndpoint, key, budgetMs: 20000,
  });
  if (!r.models.length) {
    if (!quiet) warn(`  ✗ ${p.id}：没拉到（${r.error}）`);
    return null;
  }
  setCachedModels(p.id, r.models, r.endpoint);
  if (!quiet) {
    ok(`  ✓ ${p.id}：${r.models.length} 个模型  ← ${r.endpoint}`);
    r.models.slice(0, 60).forEach((m, i) => {
      console.log(`     ${c.white(pad(String(i + 1) + ")", 4))} ${m}`);
    });
    if (r.models.length > 60) console.log(c.gray(`     ...另有 ${r.models.length - 60} 个`));
    console.log(c.gray(`     用 api use ${p.id} <模型id> 切换`));
    console.log("");
  }
  return r;
}

async function cmdScan(arg) {
  if (arg === "--all" || !arg) {
    const list = providerList().filter((p) => getKey(p.id) || p.custom === true);
    if (!list.length) { warn("  没有任何渠道配了 key。先 api key <渠道>"); return 0; }
    banner("扫描全部渠道", `共 ${list.length} 个渠道`);
    const idW = Math.max(6, ...list.map((p) => p.id.length + 2));
    const nameW = Math.max(22, ...list.map((p) => width(p.name) + 2));
    let okN = 0;
    for (const p of list) {
      const r = await cmdScanOne(p, { quiet: true });
      if (r) { okN++; ok(`  ✓ ${pad(p.id, idW)}${pad(p.name, nameW)}${r.models.length} 个模型`); }
      else warn(`  ✗ ${pad(p.id, idW)}${pad(p.name, nameW)}拉取失败`);
    }
    console.log("");
    ok(`  完成：${okN}/${list.length} 个渠道已更新缓存`);
    console.log("");
    return 0;
  }
  const p = resolveProvider(arg);
  if (!p) { err(`[!] 未知渠道：${arg}`); return 1; }
  await cmdScanOne(p);
  return 0;
}

async function cmdUse(p, model) {
  if (model) {
    setCurrent(p.id, model);
    ok(`  已设置 ${p.id} -> ${model}`);
    console.log(c.gray(`  说明：${noteFor(p, model)}`));
    return;
  }
  const r = await pick({ providerId: p.id });
  if (r) setLast(p.id);
}

// ---------- 目标 CLI（Claude Code / Qwen / Codex / Gemini / Aider / OpenCode） ----------
function pickModelOf(p, head) {
  const raw = flagValue(head, "--model") || getCurrent(p.id) || p.default || "";
  const local = head.includes("--local") || raw.startsWith("local/");
  return { model: raw.replace(/^local\//, ""), local };
}

function cmdTargets() {
  const cur = getTarget();
  banner("目标 CLI", `默认：${cur}   ·   api target <id> 改默认   ·   api run <渠道> --target <id> 临时指定`);
  const idW = 10, nameW = 14, protoW = 11;
  console.log(c.white(`   ${pad("id", idW)}${pad("CLI", nameW)}${pad("协议", protoW)}${pad("状态", 8)}说明`));
  console.log(c.gray("   " + "-".repeat(100)));
  for (const t of TARGETS) {
    const installed = !!which(t.bin);
    const mark = t.id === cur ? c.green("  ←默认") : "";
    const state = installed ? c.green(pad("已安装", 8)) : c.gray(pad("未装", 8));
    console.log(`   ${c.white(pad(t.id, idW))}${pad(t.name, nameW)}${pad(t.proto, protoW)}${state}${c.gray(t.note)}${mark}`);
  }
  console.log("");
  console.log(c.gray("   anthropic / openai / gemini / responses 为协议名：渠道缺少对应端点时会直接说明，不会静默重试"));
  console.log(c.gray("   其他 CLI 未在表内也可接入：api env <渠道> 导出通用环境变量"));
  console.log("");
  return 0;
}

function cmdTarget(id) {
  if (!id) return cmdTargets();
  const t = findTarget(id);
  if (!t) {
    err(`[!] 未知目标 CLI：${id}`);
    err("    可用：" + TARGETS.map((x) => x.id).join(" / "));
    return 1;
  }
  setTarget(t.id);
  ok(`  默认目标已设为 ${t.name}（${t.id}）`);
  const path = which(t.bin);
  if (path) console.log(c.gray(`      ${path}`));
  else warn(`  [!] 没找到 ${t.bin}。装好之前 api run 会提示；也可用 MYAPI_BIN_${t.id.toUpperCase()} 指定路径。`);
  console.log("");
  return 0;
}

function cmdEnv(head) {
  const p = resolveProvider(head[1]);
  if (!p) { err("[!] 用法：api env <渠道id> [--shell bash|pwsh|cmd|json] [--model <m>]"); return 1; }
  const shell = head.includes("--json")
    ? "json"
    : (flagValue(head, "--shell") || (process.platform === "win32" ? "pwsh" : "bash"));
  const { model, local } = pickModelOf(p, head);
  const { values, anthropic, openai, gemini } = envSet({
    provider: p, model, key: getKey(p.id), local, win: ctxLimit(model, p),
  });
  console.log(formatEnv(values, shell));
  // 提示走 stderr，stdout 保持干净，这样 eval "$(api env ds)" 才能直接用
  console.error(c.gray(`  # ${p.name} · ${model}${local ? " [local]" : ""}`));
  console.error(c.gray(`  # anthropic: ${anthropic || "—"}`));
  console.error(c.gray(`  # openai   : ${openai || "—"}`));
  if (gemini) console.error(c.gray(`  # gemini   : ${gemini}`));
  if (shell !== "json") {
    console.error(c.gray(process.platform === "win32"
      ? `  # 用法：api env ${p.id} | Invoke-Expression`
      : `  # 用法：eval "$(api env ${p.id})"`));
  }
  return 0;
}

function cmdConfig(head) {
  const p = resolveProvider(head[1]);
  if (!p) { err("[!] 用法：api config <渠道id> --target <codex|opencode>"); return 1; }
  const tid = flagValue(head, "--target") || flagValue(head, "-t") || "codex";
  const t = findTarget(tid);
  if (!t) { err(`[!] 未知目标 CLI：${tid}`); return 1; }
  const { model, local } = pickModelOf(p, head);

  if (!t.files) {
    info(`  ${t.name} 不需要配置文件，环境变量就够：`);
    console.log("");
    console.log(formatEnv(envSet({ provider: p, model, key: getKey(p.id), local, win: ctxLimit(model, p) }).values, "bash"));
    return 0;
  }

  const x = {
    provider: p, model, key: getKey(p.id), local,
    win: ctxLimit(model, p), wire: flagValue(head, "--wire"),
    endpoint: endpointFor(p, t.proto, { local }),
  };
  const sup = protoSupport(p, t.proto);
  const wantWrite = head.includes("--write");
  try {
    const built = t.render ? t.render(x) : null;
    if (!built) { err(`[!] ${t.name} 没有配置文件；用 api env 导出环境变量`); return 1; }
    if (wantWrite) {
      const extraEnv = t.files(x) || {};
      ok(`  已写入：${built.path}`);
      for (const [k, v] of Object.entries(extraEnv)) console.log(c.gray(`  ${k}=${v}`));
    } else {
      info(`  将要写入：${built.path}`);
      console.log(c.gray(`  加 --write 才落盘；直接 api run ${p.id} -t ${t.id} 也会自动写`));
    }
    console.log("");
    console.log(c.gray("  ──── 内容 ────"));
    console.log(built.content.trimEnd());
    if (!sup.ok) warn(`  [!] ${sup.why}`);
    else if (sup.soft) warn(`  [!] ${sup.why}`);
  } catch (e) {
    err("[!] " + e.message);
    return 1;
  }
  console.log("");
  return 0;
}

// ---------- 可视化 / 统计 ----------
function parseDays(head, dflt = 30) {
  const v = flagValue(head, "--days");
  if (v === "all" || v === "0") return 0;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : dflt;
}

async function cmdStats(head) {
  const days = parseDays(head);
  const force = head.includes("--refresh");
  const json = head.includes("--json");
  const withCost = head.includes("--cost");
  const t0 = Date.now();
  if (!json) info("  正在读取会话记录（首次要扫一遍日志，之后走缓存）...");
  const r = collectUsage({ force });
  const agg = filteredByDays(r.agg, days);
  ensurePricingTemplate(Object.keys(r.agg.byModel));
  if (json) {
    console.log(JSON.stringify({ window: days || "all", generatedAt: new Date().toISOString(), ...agg }, null, 2));
    return 0;
  }
  const note = `日志 ${r.files} 个 · 本次扫描 ${r.scanned} · 复用 ${r.reused} · 耗时 ${Date.now() - t0}ms`;
  console.log(renderStats(agg, { days, withCost, scannedNote: note }));
  return 0;
}

async function cmdShow(id, head) {
  const p = resolveProvider(id);
  if (!p) { err(`[!] 未知渠道：${id || "(空)"}`); err("    可用：" + providerList().map((x) => x.id).join(", ")); return 1; }
  let agg = null;
  if (hasUsageCache() && !head.includes("--no-usage")) agg = collectUsage({}).agg;
  console.log(renderShow(p, agg));
  return 0;
}

async function cmdPing(head) {
  const only = head[1] && !head[1].startsWith("--") ? head[1] : null;
  let list;
  if (only) {
    const p = resolveProvider(only);
    if (!p) { err(`[!] 未知渠道：${only}`); return 1; }
    list = [p];
  } else {
    list = providerList().filter((p) => getKey(p.id) || p.custom);
  }
  if (!list.length) { warn("  没有可探测的渠道（先 api key <渠道>）"); return 0; }
  info(`  正在探测 ${list.length} 个渠道...`);
  const rows = await Promise.all(list.map(async (p) => {
    const t0 = Date.now();
    const r = await probeModels({
      baseUrl: p.baseUrl, modelsEndpoint: p.modelsEndpoint, key: getKey(p.id), budgetMs: 20000,
    });
    const ms = Date.now() - t0;
    if (r.models.length) setCachedModels(p.id, r.models, r.endpoint);
    return {
      id: p.id, ok: r.models.length > 0, ms, models: r.models.length,
      endpoint: r.endpoint || p.modelsEndpoint || p.baseUrl, error: r.error,
    };
  }));
  if (head.includes("--json")) { console.log(JSON.stringify(rows, null, 2)); return 0; }
  console.log(renderPing(rows));
  return 0;
}

async function cmdDash(head) {
  const wi = head.indexOf("--watch");
  const every = wi >= 0 ? (Number(head[wi + 1]) || 5) : 0;
  const draw = () => {
    const agg = collectUsage({}).agg;
    if (every) process.stdout.write("\x1b[2J\x1b[3J\x1b[H");
    console.log(renderDash(agg, { days: 7 }));
  };
  if (!every) { draw(); return 0; }
  draw();
  console.log(c.gray(`   每 ${every}s 刷新 · Ctrl+C 退出`));
  setInterval(draw, every * 1000);
  await new Promise(() => { /* keep alive until Ctrl+C */ });
  return 0;
}

async function cmdReport(head) {
  const days = parseDays(head);
  const out = flagValue(head, "--out") || `api-report-${new Date().toISOString().slice(0, 10)}.html`;
  info("  正在汇总会话数据...");
  const r = collectUsage({});
  const agg = filteredByDays(r.agg, days);
  ensurePricingTemplate(Object.keys(r.agg.byModel));
  const html = buildHtmlReport(agg, {
    days,
    title: days ? `Claude Code 用量报告（最近 ${days} 天）` : "Claude Code 用量报告（全部历史）",
  });
  const full = resolvePath(out);
  writeFileSync(full, html, "utf8");
  ok(`  已生成：${full}`);
  console.log(c.gray("  单文件、无外部依赖，双击用浏览器打开即可"));
  console.log("");
  return 0;
}

function splitArgs(argv) {
  const i = argv.indexOf("--");
  if (i < 0) return { head: argv, rest: [] };
  return { head: argv.slice(0, i), rest: argv.slice(i + 1) };
}

function flagValue(list, name) {
  const i = list.indexOf(name);
  if (i < 0) return undefined;
  return list[i + 1];
}

/** 取位置参数，跳过 --flag 以及带值的 --flag <v>（否则 `--target codex` 的 codex 会被当成渠道） */
function positionals(list, valueFlags = []) {
  const out = [];
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (a.startsWith("-")) {
      if (valueFlags.includes(a)) i += 1;
      continue;
    }
    out.push(a);
  }
  return out;
}

async function cmdServe(head) {
  const portRaw = flagValue(head, "--port");
  const port = portRaw ? Number(portRaw) : 8787;
  if (!Number.isFinite(port) || port <= 0) { err("[!] --port 要给个有效端口"); return 1; }

  const provider = flagValue(head, "--provider") || flagValue(head, "-p") || "";
  const wire = flagValue(head, "--wire") || "";
  const protoOk = ["anthropic", "openai", "responses", "gemini"];
  if (wire && !protoOk.includes(wire)) {
    err(`[!] --wire 只能是 ${protoOk.join(" / ")}`);
    return 1;
  }
  const host = flagValue(head, "--host") || "127.0.0.1";
  const token = flagValue(head, "--token") || "";
  const log = head.includes("--log") || head.includes("-v");

  const num = (flag, dflt) => {
    const raw = flagValue(head, flag);
    if (!raw) return dflt;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : dflt;
  };
  const maxBody = num("--max-body", 8) * 1024 * 1024;
  const maxConcurrent = Math.floor(num("--max-conn", 32));
  const timeout = num("--timeout", 300) * 1000;
  const allowUnauthenticated = head.includes("--allow-unauthenticated");

  let info;
  try {
    info = await startServer({
      port, host, provider, wire, log,
      prefix: !head.includes("--no-prefix"),
      token, maxBody, maxConcurrent, timeout, allowUnauthenticated,
    });
  } catch (e) {
    if (e.code === "EADDRINUSE") err(`[!] 端口 ${port} 被占用，换一个：--port ${port + 1}`);
    else err("[!] 起不来：" + e.message);
    return 1;
  }

  const exposed = isExposed(host);
  const wildcard = host === "0.0.0.0" || host === "::" || host === "";
  // 0.0.0.0 是监听地址，不能当客户端地址用；本机访问一律走 127.0.0.1
  const shown = wildcard ? "127.0.0.1" : host;
  const base = `http://${shown}:${port}`;
  const authLine = info.state.token
    ? c.green("已启用（Authorization: Bearer / x-api-key）")
    : c.yellow("未设 token，仅本机可用");
  console.log("");
  console.log(c.cyan("  apipick serve") + c.gray("   本地协议转换网关（Ctrl+C 停止）"));
  console.log("");
  console.log(`   ${c.gray("地址")}   ${c.white(base)}${exposed ? c.red("   监听对外地址") : ""}`);
  if (exposed && wildcard) console.log(`   ${c.gray("外部访问")} ${c.gray(`http://<本机局域网 IP>:${port}`)}`);
  console.log(`   ${c.gray("认证")}   ${authLine}`);
  console.log(`   ${c.gray("限制")}   ${c.gray(`请求体 ${Math.round(maxBody / 1024 / 1024)} MiB · 并发 ${maxConcurrent} · 上游空闲 ${timeout / 1000}s`)}`);
  console.log(`   ${c.gray("渠道")}   ${info.state.provider ? c.yellow(info.state.provider.id) : c.gray("自动（模型名前缀优先，否则上次用的渠道）")}`);
  console.log(`   ${c.gray("出站")}   ${info.state.wire ? c.yellow(info.state.wire) : c.gray("按渠道自动挑")}`);
  console.log("");
  if (exposed && !info.state.token) {
    console.log(c.red("   警告：未设 token 且监听对外地址，同网段任何人都能调用，并消耗渠道额度。"));
    console.log("");
  }
  console.log(c.gray("   入站端点（说什么协议都能接）"));
  console.log(`     ${c.white(pad("POST /v1/messages", 44))}${c.gray("Anthropic Messages · Claude Code")}`);
  console.log(`     ${c.white(pad("POST /v1/chat/completions", 44))}${c.gray("OpenAI Chat")}`);
  console.log(`     ${c.white(pad("POST /v1/responses", 44))}${c.gray("OpenAI Responses · Codex")}`);
  console.log(`     ${c.white(pad("POST /v1beta/models/<m>:generateContent", 44))}${c.gray("Gemini")}`);
  console.log(`     ${c.white(pad("GET  /v1/models", 44))}${c.gray("聚合模型列表")}`);
  console.log("");
  const shownToken = info.state.token || "local";
  console.log(c.gray("   接到 Claude Code 上："));
  console.log(`     ${c.white(`ANTHROPIC_BASE_URL=${base} ANTHROPIC_AUTH_TOKEN=${shownToken} claude`)}`);
  console.log("");
  console.log(c.gray("   接上任何 OpenAI 协议客户端："));
  console.log(`     ${c.white(`OPENAI_BASE_URL=${base}/v1 OPENAI_API_KEY=${shownToken}`)}`);
  console.log("");

  const stop = () => {
    console.log("");
    console.log(c.gray("   已停止服务。"));
    info.server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 400).unref();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  info.server.on("close", () => process.exit(0));

  await new Promise(() => {});
  return 0;
}

async function main() {
  const argv = process.argv.slice(2);

  if (!argv.length) {
    const r = await pick({});
    if (!r) return 0;
    setLast(r.provider.id);
    const tgt = findTarget(getTarget());
    const go = (await ask(`\n   现在用 ${r.model} 启动 ${tgt ? tgt.name : "claude"} 吗？(Y/n) `)).trim().toLowerCase();
    if (go === "" || go === "y" || go === "yes") return launch(r.provider.id, { model: r.model });
    info("   已保存。以后启动：api run");
    return 0;
  }

  const { head, rest } = splitArgs(argv);
  const cmd = head[0];

  if (cmd === "-h" || cmd === "--help" || cmd === "help") { help(); return 0; }
  if (cmd === "-v" || cmd === "--version" || cmd === "version") { console.log(VERSION); return 0; }

  if (cmd === "list" || cmd === "ls") { printProviders(); return 0; }

  if (cmd === "targets" || cmd === "clis") return cmdTargets();
  if (cmd === "target") return cmdTarget(head[1] && !head[1].startsWith("--") ? head[1] : "");
  if (cmd === "env") return cmdEnv(head);
  if (cmd === "config" || cmd === "conf") return cmdConfig(head);

  if (cmd === "add") {
    const first = head[1] && !head[1].startsWith("--") ? head[1] : undefined;
    const rec = await addProvider({
      id: first,
      name: flagValue(head, "--name"),
      baseUrl: flagValue(head, "--base") || flagValue(head, "--base-url"),
      key: flagValue(head, "--key"),
      model: flagValue(head, "--model"),
      ctx: flagValue(head, "--ctx"),
      modelsEndpoint: flagValue(head, "--models"),
      endpoints: {
        openai: flagValue(head, "--openai"),
        gemini: flagValue(head, "--gemini"),
        responses: flagValue(head, "--responses"),
      },
      interactive: head.includes("--no-ask") ? false : true,
    });
    return rec ? 0 : 1;
  }

  if (cmd === "rm" || cmd === "remove" || cmd === "del") {
    if (!head[1]) { err("[!] 用法：api rm <渠道id>"); return 1; }
    return removeProvider(head[1]);
  }

  if (cmd === "pick") {
    const r = await pick({ providerId: head[1] });
    if (r) setLast(r.provider.id);
    return 0;
  }

  if (cmd === "use") {
    const p = resolveProvider(head[1]);
    if (!p) { err(`[!] 未知渠道：${head[1] || "(空)"}`); err("    可用：" + providerList().map((x) => x.id).join(", ")); return 1; }
    setLast(p.id);
    await cmdUse(p, head[2]);
    return 0;
  }

  if (cmd === "key") {
    const p = resolveProvider(head[1]);
    if (!p) { err(`[!] 未知渠道：${head[1] || "(空)"}`); err("    可用：" + providerList().map((x) => x.id).join(", ")); return 1; }
    await cmdKey(p, head[2]);
    return 0;
  }

  if (cmd === "models") {
    if (!head[1]) { err("[!] 用法：api models <渠道id>   （渠道列表见 api list）"); return 1; }
    const p = resolveProvider(head[1]);
    if (!p) { err(`[!] 未知渠道：${head[1]}`); return 1; }
    printModels(p);
    return 0;
  }

  if (cmd === "scan") {
    return cmdScan(head[1]);
  }

  if (cmd === "stats" || cmd === "usage") return cmdStats(head);
  if (cmd === "dash" || cmd === "dashboard") return cmdDash(head);
  if (cmd === "ping" || cmd === "test") return cmdPing(head);
  if (cmd === "report" || cmd === "export") return cmdReport(head);
  if (cmd === "show" || cmd === "info") {
    if (!head[1] || head[1].startsWith("--")) { err("[!] 用法：api show <渠道id>   （渠道列表见 api list）"); return 1; }
    return cmdShow(head[1], head);
  }

  if (cmd === "serve" || cmd === "gateway" || cmd === "proxy") return cmdServe(head);

  if (cmd === "run") {
    const dry = head.includes("--dry");
    const targetId = flagValue(head, "--target") || flagValue(head, "-t");
    const wire = flagValue(head, "--wire");
    const onlyModel = flagValue(head, "--model");
    const pos = positionals(head, ["--target", "-t", "--wire", "--bin", "--model"]);
    let pid = pos[1];
    if (!pid) pid = getLast();
    if (!pid) {
      const r = await pick({});
      if (!r) return 0;
      pid = r.provider.id;
      return launch(pid, { model: r.model, args: rest, dry, target: targetId, wire });
    }
    const p = resolveProvider(pid);
    if (!p) { err(`[!] 未知渠道：${pid}`); return 1; }
    setLast(p.id);
    return launch(p.id, {
      model: onlyModel, args: rest, dry, target: targetId, wire, bin: flagValue(head, "--bin"),
    });
  }

  // bare "api <provider>" -> act like run <provider>
  const p = resolveProvider(cmd);
  if (p) {
    setLast(p.id);
    return launch(p.id, {
      args: rest,
      target: flagValue(head, "--target") || flagValue(head, "-t"),
      wire: flagValue(head, "--wire"),
    });
  }

  err(`[!] 未知命令：${cmd}`);
  help();
  return 1;
}

main().then((code) => process.exit(code || 0)).catch((e) => {
  err("[!] " + (e && e.stack ? e.stack : e));
  process.exit(1);
});
