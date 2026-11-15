#!/usr/bin/env node
// Feature-aware CLI wrapper. Existing commands remain delegated to api.mjs.
import { unlinkSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { providerList, resolveProvider, getCurrent, getLast, getKey, modelPool, probeModels, setCachedModels } from "../src/core.mjs";
import { launch } from "../src/launch.mjs";
import { pick } from "../src/picker.mjs";
import { TARGETS, findTarget, which, endpointFor, protoSupport } from "../src/targets.mjs";
import { ctxLimit } from "../src/core.mjs";
import { findProjectConfig, projectConfigPath, readProjectConfig, writeProjectConfig, filterModels } from "../src/project.mjs";
import { c, banner, pad, info, ok, warn, err } from "../src/ui.mjs";

const argv = process.argv.slice(2);
const command = argv[0];
const flags = new Set(["--tools", "--vision", "--stream", "--reasoning"]);
const flagValue = (args, name) => {
  const i = args.indexOf(name);
  return i < 0 ? undefined : args[i + 1];
};
const selectedProject = () => findProjectConfig(process.cwd());

function projectCommand(args) {
  const action = args[1];
  const localPath = projectConfigPath(process.cwd());
  if (action === "clear") {
    if (!existsSync(localPath)) { info("当前目录没有 .apipick.json"); return 0; }
    unlinkSync(localPath);
    ok(`已删除 ${localPath}`);
    return 0;
  }
  if (action === "set") {
    const field = args[2];
    const value = args[3];
    if (!["provider", "model", "target"].includes(field) || !value) {
      err("用法：api project set <provider|model|target> <value>");
      return 1;
    }
    if (field === "provider" && !resolveProvider(value)) { err(`未知渠道：${value}`); return 1; }
    if (field === "target" && !findTarget(value)) { err(`未知 CLI：${value}`); return 1; }
    let config;
    try { config = readProjectConfig(process.cwd()) || {}; }
    catch (e) { err(e.message); return 1; }
    config[field] = field === "provider" ? resolveProvider(value).id : value;
    const path = writeProjectConfig(config, process.cwd());
    ok(`已写入 ${field}=${config[field]} → ${path}`);
    return 0;
  }
  if (action === "capability") {
    const [, , , model, capability, rawValue] = args;
    if (!model || !["tools", "vision", "stream", "reasoning", "context"].includes(capability) || rawValue === undefined) {
      err("用法：api project capability <model> <tools|vision|stream|reasoning|context> <true|false|数值>");
      return 1;
    }
    const value = capability === "context" ? Number(rawValue) : rawValue === "true" ? true : rawValue === "false" ? false : null;
    if (value === null || (capability === "context" && (!Number.isFinite(value) || value <= 0))) {
      err("能力值无效：布尔能力用 true/false，context 用正整数");
      return 1;
    }
    let config;
    try { config = readProjectConfig(process.cwd()) || {}; }
    catch (e) { err(e.message); return 1; }
    config.modelCapabilities ||= {};
    config.modelCapabilities[model] ||= {};
    config.modelCapabilities[model][capability] = value;
    ok(`已写入 ${model}.${capability}=${value} → ${writeProjectConfig(config, process.cwd())}`);
    return 0;
  }
  let found;
  try { found = selectedProject(); }
  catch (e) { err(e.message); return 1; }
  if (!found) {
    info("当前目录及父目录没有 .apipick.json");
    info("初始化：api project set provider <id>，或 api init");
    return 0;
  }
  banner("项目配置", found.path);
  const cfg = { ...found.config };
  delete cfg.updatedAt;
  console.log(JSON.stringify(cfg, null, 2));
  console.log(c.gray("配置文件不保存 API key；凭据仍由全局 APIPICK_HOME 管理。"));
  return 0;
}

async function doctorCommand(args) {
  const targetArg = flagValue(args, "--target");
  const target = targetArg ? findTarget(targetArg) : null;
  if (targetArg && !target) { err(`未知 CLI：${targetArg}`); return 1; }
  const requested = args[1] && !args[1].startsWith("-") ? resolveProvider(args[1]) : null;
  if (args[1] && !args[1].startsWith("-") && !requested) { err(`未知渠道：${args[1]}`); return 1; }
  const providers = requested ? [requested] : providerList().filter((p) => getKey(p.id) || p.custom || p.id === "ol");
  let failures = 0;
  banner("apipick doctor", "渠道连接、key、端点和 CLI 安装检查");
  for (const p of providers) {
    const key = getKey(p.id);
    const isLocal = p.id === "ol" && !p.cloudModels?.length;
    const endpoint = p.baseUrl || p.localBaseUrl || "";
    let probe = null;
    if (endpoint && (key || isLocal || p.custom)) {
      probe = await probeModels({ baseUrl: endpoint, modelsEndpoint: p.modelsEndpoint, key: key || undefined, timeoutMs: 4000, budgetMs: 8000 });
    }
    const reachable = !!probe?.models?.length;
    const missingKey = !key && !isLocal;
    const status = missingKey ? "未配置 key" : reachable ? `可用 · ${probe.models.length} 个模型` : "探测失败";
    if (missingKey || !reachable) failures++;
    console.log(`  ${missingKey || !reachable ? c.yellow("WARN") : c.green("OK")} ${p.id} (${p.name}): ${status}`);
    if (!endpoint) console.log(c.gray("    建议：配置合法 Base URL。"));
    else if (missingKey) console.log(c.gray(`    建议：运行 api key ${p.id} 设置凭据。`));
    else if (!reachable) {
      const message = String(probe?.error || "");
      const hint = /401|403/.test(message) ? "认证失败，检查 key 和账户权限。"
        : /404/.test(message) ? "模型端点返回 404；检查 Base URL 和 models endpoint。"
          : /timeout/i.test(message) ? "连接超时；检查网络或上游服务状态。"
            : "检查 Base URL、网络和上游 /models 接口是否可用。";
      console.log(c.gray(`    ${hint}${message ? ` (${message})` : ""}`));
    }
    if (target) {
      const installed = !!which(target.bin);
      if (!installed) { failures++; console.log(c.yellow(`    ${target.name} 未安装或不在 PATH 中（${target.bin}）。`)); }
      const support = requireProto(p, target.proto);
      if (!support.ok) { failures++; console.log(c.yellow(`    协议不支持：${support.why}`)); }
    }
  }
  if (!providers.length) info("没有已配置的渠道；先运行 api add 或 api key <id>。");
  if (!target && targetArg === undefined) {
    const cur = findTarget((selectedProject()?.config?.target) || "") || findTarget("claude");
    if (cur && !which(cur.bin)) { failures++; warn(`${cur.name} 未安装或不在 PATH 中。`); }
  }
  return failures ? 1 : 0;
}

function requireProto(provider, proto) {
  return protoSupport(provider, proto);
}

function modelFilters(args) {
  const min = flagValue(args, "--min-context");
  const minContext = min === undefined ? undefined : Number(min);
  if (minContext !== undefined && (!Number.isFinite(minContext) || minContext <= 0)) throw new Error("--min-context 必须是正数");
  return { tools: args.includes("--tools") ? true : undefined, vision: args.includes("--vision") ? true : undefined,
    stream: args.includes("--stream") ? true : undefined, reasoning: args.includes("--reasoning") ? true : undefined, minContext };
}

function modelsCommand(args) {
  const providerName = args.slice(1).find((arg) => !arg.startsWith("-"));
  const provider = resolveProvider(providerName);
  if (!provider) { err("用法：api models <渠道> [--tools] [--vision] [--stream] [--reasoning] [--min-context N]"); return 1; }
  let filters;
  let project;
  try { filters = modelFilters(args); project = selectedProject()?.config; }
  catch (e) { err(e.message); return 1; }
  const models = filterModels(modelPool(provider), filters, project?.modelCapabilities || {});
  banner(`${provider.name} 的模型`, `${models.length}/${modelPool(provider).length} 个匹配能力筛选`);
  for (const [index, model] of models.entries()) {
    const c = modelCapabilities(model, project?.modelCapabilities || {});
    console.log(`  ${index + 1}) ${model}  tools:${c.tools ? "✓" : "—"} vision:${c.vision ? "✓" : "—"} stream:${c.stream ? "✓" : "—"} reasoning:${c.reasoning ? "✓" : "—"} context:${c.context}`);
  }
  if (!models.length) info("没有模型符合条件。能力判断为启发式，建议通过 api project capability 设置准确覆盖。");
  return 0;
}

function checkRequirements(model, provider, config, args) {
  const caps = modelCapabilities(model, config?.modelCapabilities || {});
  const required = args.flatMap((arg, index) => arg === "--require" && args[index + 1] ? args[index + 1].split(",") : []);
  const valid = new Set(["tools", "vision", "stream", "reasoning"]);
  const unknown = required.filter((name) => !valid.has(name));
  if (unknown.length) throw new Error(`未知能力要求：${unknown.join(", ")}`);
  const missing = required.filter((name) => !caps[name]);
  const minContextRaw = flagValue(args, "--min-context");
  if (minContextRaw !== undefined) {
    const min = Number(minContextRaw);
    if (!Number.isFinite(min) || min <= 0) throw new Error("--min-context 必须是正数");
    if (Number(caps.context || ctxLimit(model, provider)) < min) missing.push(`context>=${min}`);
  }
  if (missing.length) throw new Error(`模型 ${model} 未满足要求：${missing.join(", 