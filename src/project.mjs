// project.mjs — project-local defaults and conservative model-capability hints.
// Project config is deliberately separate from global credentials: never store API keys here.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { ctxLimit } from "./core.mjs";

export const PROJECT_CONFIG_NAME = ".apipick.json";
const ALLOWED_KEYS = new Set(["provider", "model", "target", "modelCapabilities"]);
const CAP_KEYS = new Set(["tools", "vision", "stream", "reasoning", "context"]);

export function projectConfigPath(cwd = process.cwd()) {
  return join(resolve(cwd), PROJECT_CONFIG_NAME);
}

function validateProjectConfig(value, filePath) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid project config in ${filePath}: expected a JSON object`);
  }
  const extra = Object.keys(value).filter((key) => !ALLOWED_KEYS.has(key) && key !== "updatedAt");
  if (extra.length) throw new Error(`Unsupported project config field(s): ${extra.join(", ")}`);
  for (const key of ["provider", "model", "target"]) {
    if (value[key] !== undefined && typeof value[key] !== "string") {
      throw new Error(`Project config field '${key}' must be a string`);
    }
  }
  if (value.modelCapabilities !== undefined) {
    if (!value.modelCapabilities || typeof value.modelCapabilities !== "object" || Array.isArray(value.modelCapabilities)) {
      throw new Error("Project config field 'modelCapabilities' must be an object");
    }
    for (const [model, caps] of Object.entries(value.modelCapabilities)) {
      if (!caps || typeof caps !== "object" || Array.isArray(caps)) throw new Error(`Capabilities for '${model}' must be an object`);
      for (const [key, val] of Object.entries(caps)) {
        if (!CAP_KEYS.has(key)) throw new Error(`Unknown capability '${key}' for model '${model}'`);
        if (key === "context" ? (!Number.isFinite(Number(val)) || Number(val) <= 0) : typeof val !== "boolean") {
          throw new Error(`Invalid value for capability '${key}' on model '${model}'`);
        }
      }
    }
  }
  return value;
}

export function readProjectConfig(cwd = process.cwd()) {
  const filePath = projectConfigPath(cwd);
  if (!existsSync(filePath)) return null;
  let parsed;
  try { parsed = JSON.parse(readFileSync(filePath, "utf8")); }
  catch (error) { throw new Error(`Cannot parse ${filePath}: ${error.message}`); }
  return validateProjectConfig(parsed, filePath);
}

export function writeProjectConfig(config, cwd = process.cwd()) {
  const filePath = projectConfigPath(cwd);
  const validated = validateProjectConfig(config, filePath);
  writeFileSync(filePath, JSON.stringify({ ...validated, updatedAt: new Date().toISOString() }, null, 2) + "\n", { mode: 0o600 });
  return filePath;
}

/** Resolve nearest config, stopping at filesystem root. */
export function findProjectConfig(cwd = process.cwd()) {
  let dir = resolve(cwd);
  while (true) {
    const config = readProjectConfig(dir);
    if (config) return { config, path: projectConfigPath(dir) };
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

const DEFAULT_CAPABILITIES = Object.freeze({ tools: false, vision: false, stream: true, reasoning: false });

/**
 * Conservative heuristic; unknown support stays false. Exact per-model entries in
 * project config override the heuristic, so users can correct provider-specific behavior.
 */
export function modelCapabilities(model, overrides = {}) {
  const name = String(model || "");
  const lower = name.toLowerCase();
  const heuristic = {
    tools: /gpt|claude|qwen|deepseek|glm|kimi|gemini|command-r|mistral|llama/i.test(name),
    vision: /vision|\bvl\b|gemini|gpt-4o|gpt-4\.1|claude-3|pixtral/i.test(name),
    stream: true,
    reasoning: /reason|think|deepseek-r1|\br1\b|\bo[1-9]\b|gemini-2\.5/i.test(name),
    context: ctxLimit(name),
  };
  return { ...DEFAULT_CAPABILITIES, ...heuristic, ...(overrides[name] || {}) };
}

export function filterModels(models, { tools, vision, stream, reasoning, minContext } = {}, overrides = {}) {
  return models.filter((model) => {
    const caps = modelCapabilities(model, overrides);
    if (tools === true && !caps.tools) return false;
    if (vision === true && !caps.vision) return false;
    if (stream === true && !caps.stream) return false;
    if (reasoning === true && !caps.reasoning) return false;
    if (minContext !== undefined && Number(caps.context) < Number(minContext)) return false;
    return true;
  });
}
