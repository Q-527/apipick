#!/usr/bin/env node
// Feature-aware CLI entrypoint. Existing commands are delegated to api.mjs.
import { spawnSync } from "node:child_process";
import { existsSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  providerList, resolveProvider, getCurrent, getLast, getKey, modelPool, probeModels,
} from "../src/core.mjs";
import { launch } from "../src/launch.mjs";
import { TARGETS, findTarget, which, protoSupport } from "../src/targets.mjs";
import { ctxLimit } from "../src/core.mjs";
import {
  findProjectConfig, projectConfigPath, readProjectConfig, writeProjectConfig,
  filterModels, modelCapabilities,
} from "../src/project.mjs";
import { banner, c, info, ok, warn, err } from "../src/ui.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const command = argv[0];
const flagValue = (args, name) => {
  const i = args.indexOf(name);
  return i < 0 ? undefined : args[i + 1];
};
const selectedProject = () => findProjectConfig(process.cwd());
const delegate = (args) => {
  const result = spawnSync(process.execPath, [join(HERE, "api.mjs"), ...args], { stdio: "inherit" });
  if (result.error) { err(`[!] 无法启动现有 CLI：${result.error.message}`); return 1; }
  return result.status ?? 1;
};

function projectCommand(args) {
  const action = args[1];
  const localPath = projectConfigPath(process.cwd());
  if (action === "init") {
    if (existsSync(localPath)) { err(`配置已存在：${localPath}`); return 1; }
    try { ok(`已创建 ${writeProjectConfig({})}`); }
    catch (e) { err(e.message); return 1; }
    info("项目配置不保存 API key；凭据仍由 APIPICK_HOME 管理。");
    return 0;
  }
  if (action === "clear") {
    if (!existsSync(localPath)) { info("当前目录没有 .apipick.json"); return 0; }
    unlinkSync(localPath); ok(`已删除 ${localPath}`); return 0;
  }
  if (action === "set") {
    const field = args[2], value = args[3];
    if (!["provider", "model", "target"].includes(field) || !value) {
      err("用法：api project set <provider|model|target> <value>"); return 1;
    }
    const provider = field === "provider" ? resolveProvider(value) : null;
    if (field === "provider" && !provider) { err(`未知渠道：${value}`); return 1; }
    if (field === "target" && !findTarget(value)) { err(`未知 CLI：${value}`); return 1; }
    let config;
    try { config = readProjectConfig(process.cwd()) || {}; }
    catch (e) { err(e.message); return 1; }
    config[field] = field === "provider" ? provider.id : value;
    try { ok(`已写入 ${field}=${config[field]} → ${writeProjectConfig(config)}`); }
    catch (e) { err(e.message); return 1; }
    return 0;
  }
  if (action === "capability") {
    const [, , model, capability, raw] = args;
    if (!model || !["tools", "vision", "stream", "reasoning", "context"].includes(capability) || raw === undefined) {
      err("用法：api project capability <model> <tools|vision|stream|reasoning|context> <true|false|数值>"); return 1;
    }
    const value = capability === "context" ? Number(raw) : raw === "true" ? true : raw === "false" ? false : null;
    if (value === null || (capability === "context" && (!Number.isFinite(value) || value <= 0))) {
      err("能力值无效：布尔能力用 true/false，context 用正数"); return 1;
    }
    let config;
    try { config = readProjectConfig(process.cwd()) || {}; }
    catch (e) { err(e.message); return 1; }
    config.modelCapabilities ||= {};
    config.modelCapabilities[model] ||= {};
    config.modelCapabilities[model][capability] = value;
    try { ok(`已写入 ${model}.${capability}=${value} → ${writeProjectConfig(config)}`); }
    catch (e) { err(e.message); return 1; }
    return 0;
  }
  let found;
  try { found = selectedProject(); }
  catch (e) { err(e.message); return 1; }
  if (!found) {
    info("当前目录及父目录没有 .apipick.json");
    info("初始化：api project init");
    return 0;
  }
  banner("项目配置", found.path);
  const config = { ...found.config }; delete config.updatedAt;
  console.log(JSON.stringify(config, null, 2));
  info("项目配置不保存 API key；密钥仍由 APIPICK_HOME 管理。");
  return 0;
}

function firstPositional(args, start = 1, valueFlags = []) {
  for (let i = start; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("-")) {
      if (valueFlags.includes(arg)) i++;
      continue;
    }
    return arg;
  }
  return "";
}

function classifyProbeError(message = "") {
  if (/401|403/.test(message)) return "认证失败：检查 key 和账户权限。";
  if (/404/.test(message)) return "端点不存在：检查 Base URL 或 models endpoint。";
  if (/timeout/i.test(message)) return "连接超时：检查网络或上游服务状态。";
  if (/not-json/.test(message)) return "上游未返回 JSON：确认模型列表端点。";
  return "探测失败：检查 Base URL、网络和上游 /models 接口。";
}

async function doctorCommand(args) {
  let project;
  try { project = selectedProject(); }
  catch (e) { err(e.message); return 1; }
  const targetArg = flagValue(args, "--target") || project?.config.target;
  const target = targetArg ? findTarget(targetArg) : null;
  if (targetArg && !target) { err(`未知 CLI：${targetArg}`); return 1; }
  const providerName = firstPositional(args, 1, ["--target"]);
  const provider = providerName ? resolveProvider(providerName) : resolveProvider(project?.config.provider || "");
  if (providerName && !provider) { err(`未知渠道：${providerName}`); return 1; }
  const providers = provider ? [provider] : providerList().filter((p) => getKey(p.id) || p.custom || p.id === "ol");
  let failed = false, warned = false;
  banner("apipick doctor", "渠道、认证、端点和目标 CLI 诊断");
  if (project) info(`项目配置：${project.path}`);
  if (target) {
    const installed = !!which(target.bin);
    if (!installed) { warned = true; warn(`${target.name} 未安装或不在 PATH (${target.bin})。`); }
  }
  for (const p of providers) {
    const key = getKey(p.id);
    const isLocal = p.id === "ol" && !(p.cloudModels || []).includes(getCurrent(p.id));
    const base = p.baseUrl || p.localBaseUrl || "";
    let validUrl = false;
    try { const u = new URL(base); validUrl = ["http:", "https:"].includes(u.protocol); } catch { /* malformed */ }
    if (!validUrl) {
      failed = true;
      console.log(`  ${c.red("FAIL")} ${p.id}: Base URL 无效：${base || "(未配置)"}`);
      continue;
    }
    if (!key && !isLocal) {
      failed = true;
      console.log(`  ${c.red("FAIL")} ${p.id}: 未配置 API key。`);
      console.log(c.gray(`    修复：api key ${p.id}`));
      continue;
    }
    const started = Date.now();
    const result = await probeModels({ baseUrl: base, modelsEndpoint: p.modelsEndpoint, key: key || undefined, timeoutMs: 4000, budgetMs: 8000 });
    const elapsed = Date.now() - started;
    if (!result.models.length) {
      failed = true;
      console.log(`  ${c.red("FAIL")} ${p.id}: ${classifyProbeError(result.error)} ${result.error || ""}`);
      continue;
    }
    console.log(`  ${c.green("OK")} ${p.id}: 可连接，${result.models.length} 个模型，${elapsed}ms (${result.endpoint})`);
    if (target) {
      const support = protoSupport(p, target.proto);
      if (!support.ok) { failed = true; console.log(c.red(`    FAIL 协议不兼容：${support.why}`)); }
    }
  }
  if (!providers.length) { warned = true; info("没有可诊断的渠道。先运行 api add 或 api key <id>。"); }
  if (!failed && !warned) ok("诊断通过。");
  else if (!failed) warn("诊断完成：有警告，但没有阻断项。");
  return failed ? 1 : 0;
}

function modelFilters(args) {
  const raw = flagValue(args, "--min-context");
  const minContext = raw === undefined ? undefined : Number(raw);
  if (minContext !== undefined && (!Number.isFinite(minContext) || minContext <= 0)) throw new Error("--min-context 必须是正数");
  return {
    tools: args.includes("--tools") ? true : undefined,
    vision: args.includes("--vision") ? true : undefined,
    stream: args.includes("--stream") ? true : undefined,
    reasoning: args.includes("--reasoning") ? true : undefined,
    minContext,
  };
}

function modelsCommand(args) {
  const name = firstPositional(args);
  const provider = resolveProvider(name);
  if (!provider) { err("用法：api models <渠道> [--tools] [--vision] [--stream] [--reasoning] [--min-context N]"); return 1; }
  try {
    const filters = modelFilters(args);
    const project = selectedProject()?.config;
    const all = modelPool(provider);
    const models = filterModels(all, filters, project?.modelCapabilities || {});
    banner(`${provider.name} 的模型`, `${models.length}/${all.length} 个符合能力筛选`);
    const current = getCurrent(provider.id);
    for (const [i, model] of models.entries()) {
      const caps = modelCapabilities(model, project?.modelCapabilities || {});
      console.log(`  ${i + 1}) ${model}${model === current ? "  ← 当前" : ""}  [tools:${caps.tools ? "✓" : "—"} vision:${caps.vision ? "✓" : "—"} stream:${caps.stream ? "✓" : "—"} reasoning:${caps.reasoning ? "✓" : "—"} context:${caps.context}]`);
    }
    if (!models.length) info("无匹配模型。能力判断为启发式，可用 api project capability 覆盖。");
    return 0;
  } catch (e) { err(e.message); return 1; }
}

function parseRequirements(args) {
  const required = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--require") {
      if (!args[i + 1]) throw new Error("--require 需要能力列表，例如 --require tools,vision");
      required.push(...args[i + 1].split(",").map((x) => x.trim()).filter(Boolean)); i++;
    }
  }
  const allowed = new Set(["tools", "vision", "stream", "reasoning"]);
  const unknown = required.filter((name) => !allowed.has(name));
  if (unknown.length) throw new Error(`未知模型能力：${unknown.join(", ")}`);
  return [...new Set(required)];
}

function runCommand(args) {
  let project;
  try { project = selectedProject(); }
  catch (e) { err(e.message); return 1; }
  const providerName = firstPositional(args, 1, ["--target", "-t", "--model", "--wire", "--bin", "--require", "--min-context"]);
  const explicitProvider = providerName ? resolveProvider(providerName) : null;
  if (providerName && !explicitProvider) { err(`未知渠道：${providerName}`); return 1; }
  const providerId = explicitProvider?.id || project?.config.provider || getLast();
  // Preserve the established interactive picker behavior when no channel/default exists.
  if (!providerId) return delegate(args);
  const provider = resolveProvider(providerId);
  if (!provider) { err(`项目配置中的渠道无效：${providerId}`); return 1; }
  const targetName = flagValue(args, "--target") || flagValue(args, "-t") || project?.config.target || "claude";
  const target = findTarget(targetName);
  if (!target) { err(`未知 CLI：${targetName}`); return 1; }
  const model = flagValue(args, "--model") || (provider.id === project?.config.provider ? project?.config.model : "") || getCurrent(provider.id) || provider.default || "";
  if (!model) { err(`渠道 ${provider.id} 没有默认模型；运行 api use ${provider.id} <模型> 或设置项目 model。`); return 1; }
  const dry = args.includes("--dry");
  const explicitLocal = args.includes("--local") || model.startsWith("local/");
  const effectiveModel = model.replace(/^local\//, "");
  const isLocal = explicitLocal || (provider.id === "ol" && !(provider.cloudModels || []).includes(effectiveModel));
  if (!isLocal && !getKey(provider.id) && !dry) { err(`渠道 ${provider.id} 未配置 API key；运行 api key ${provider.id}。`); return 1; }
  if (!provider.baseUrl && !(isLocal && provider.localBaseUrl)) { err(`渠道 ${provider.id} 未配置 Base URL。`); return 1; }
  if (!dry && !which(flagValue(args, "--bin") || target.bin)) { err(`${target.name} 未安装或不在 PATH (${target.bin})。`); return 1; }
  const support = protoSupport(provider, target.proto);
  if (!support.ok) { err(`目标协议不兼容：${support.why}`); return 1; }
  try {
    const required = parseRequirements(args);
    const caps = modelCapabilities(effectiveModel, project?.config.modelCapabilities || {});
    const missing = required.filter((name) => !caps[name]);
    const minRaw = flagValue(args, "--min-context");
    if (minRaw !== undefined) {
      const min = Number(minRaw);
      if (!Number.isFinite(min) || min <= 0) throw new Error("--min-context 必须是正数");
      if (Number(caps.context || ctxLimit(effectiveModel, provider)) < min) missing.push(`context>=${min}`);
    }
    if (missing.length) throw new Error(`模型 ${effectiveModel} 未满足能力要求：${missing.join(", ")}`);
  } catch (e) { err(e.message); return 1; }
  const separator = args.indexOf("--");
  const passthrough = separator < 0 ? [] : args.slice(separator + 1);
  return launch(provider.id, {
    model, args: passthrough, dry, local: explicitLocal, target: target.id,
    wire: flagValue(args, "--wire"), bin: flagValue(args, "--bin"),
  });
}

if (command === "project" || command === "init") process.exit(projectCommand(command === "init" ? ["project", "init"] : argv));
if (command === "doctor") process.exit(await doctorCommand(argv));
if (command === "models" && argv.some((arg) => ["--tools", "--vision", "--stream", "--reasoning", "--min-context"].includes(arg))) process.exit(modelsCommand(argv));
if (command === "run") process.exit(runCommand(argv));
process.exit(delegate(argv));
