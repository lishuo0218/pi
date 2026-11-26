// models.json management for the model picker's add/edit form: list the
// models the user added, write one back, and delete one. Pi's file is JSONC
// (comments and trailing commas); saving rewrites it as plain JSON, so
// comments in it do not survive a save from the UI.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Levels a `thinkingLevelMap` can map; each maps to its own value. */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** One user-added model: a `providers.<provider>.models` entry. */
export type ModelEntry = {
  provider: string;
  id: string;
  name: string | null;
  reasoning: boolean;
  /** Input modalities, e.g. ["text", "image"]. */
  input: string[];
  contextWindow: number | null;
  maxTokens: number | null;
  /** Levels the entry maps in thinkingLevelMap; [] when it sets no map. */
  thinkingLevels: string[];
};

/** Provider-level connection shared by every model of that provider. */
export type ModelProvider = {
  id: string;
  name: string | null;
  baseUrl: string | null;
  api: string | null;
  apiKey: string | null;
};

export type ModelsConfigSnapshot = {
  path: string;
  /** False when the file does not exist yet; saving creates it. */
  exists: boolean;
  providers: ModelProvider[];
  entries: ModelEntry[];
};

/** What the form sends, one model. */
export type ModelDraft = {
  /** Where the entry lives now when editing; null when adding. */
  original: { provider: string; id: string } | null;
  provider: string;
  id: string;
  name: string;
  providerName: string;
  baseUrl: string;
  api: string;
  /** "none" leaves the provider's saved key untouched. */
  apiKeyMode: "none" | "env" | "literal";
  /** Environment variable name for "env", the key itself for "literal". */
  apiKey: string;
  reasoning: boolean;
  inputImage: boolean;
  contextWindow: number | null;
  maxTokens: number | null;
  thinkingLevels: string[];
};

type JsonObject = Record<string, unknown>;

/** Path pi reads its model configuration from. */
export function modelsConfigPath(): string {
  const env = process.env.PI_CODING_AGENT_DIR?.trim();
  const dir = env ? (env.startsWith("~") ? join(homedir(), env.slice(1)) : env) : join(homedir(), ".pi", "agent");
  return join(dir, "models.json");
}

/** Every model the user added, plus the provider connections they live on. */
export async function readModelsConfig(): Promise<ModelsConfigSnapshot> {
  const { path, exists, config } = await loadConfig();
  const providers = asObject(config.providers) ?? {};
  const providerList: ModelProvider[] = [];
  const entries: ModelEntry[] = [];
  for (const [id, rawProvider] of Object.entries(providers)) {
    const provider = asObject(rawProvider);
    if (provider === null) continue;
    providerList.push({
      id,
      name: asString(provider.name),
      baseUrl: asString(provider.baseUrl),
      api: asString(provider.api),
      apiKey: asString(provider.apiKey),
    });
    for (const rawModel of asArray(provider.models)) {
      const model = asObject(rawModel);
      const modelId = asString(model?.id);
      if (model === null || modelId === null) continue;
      entries.push({
        provider: id,
        id: modelId,
        name: asString(model.name),
        reasoning: model.reasoning === true,
        input: asArray(model.input).filter((m): m is string => typeof m === "string"),
        contextWindow: asNumber(model.contextWindow),
        maxTokens: asNumber(model.maxTokens),
        thinkingLevels: Object.keys(asObject(model.thinkingLevelMap) ?? {}),
      });
    }
  }
  return { path, exists, providers: providerList, entries };
}

/** Add one model or replace the entry with the same provider and id. */
export async function saveModel(draft: ModelDraft): Promise<{ path: string }> {
  const providerId = draft.provider.trim();
  const modelId = draft.id.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(providerId)) {
    throw new Error("provider 只能包含字母、数字、点、下划线和连字符");
  }
  if (!modelId) throw new Error("模型 ID 不能为空");
  const baseUrl = draft.baseUrl.trim();
  if (baseUrl && !/^https?:\/\/\S+$/.test(baseUrl)) {
    throw new Error("baseUrl 需以 http:// 或 https:// 开头");
  }
  const api = draft.api.trim();
  const apiKey = apiKeyValue(draft);
  const contextWindow = positiveInt(draft.contextWindow, "上下文窗口");
  const maxTokens = positiveInt(draft.maxTokens, "最大输出 tokens");
  const thinkingLevels = draft.thinkingLevels.filter((level): level is (typeof THINKING_LEVELS)[number] =>
    (THINKING_LEVELS as readonly string[]).includes(level),
  );

  const { path, exists, config } = await loadConfig();
  let providerMap = asObject(config.providers);
  if (providerMap === null) {
    providerMap = {};
    config.providers = providerMap;
  }
  const original = draft.original;
  if (original !== null && (original.provider !== providerId || original.id !== modelId)) {
    removeEntry(providerMap, original.provider, original.id);
  }
  const existingProvider = asObject(providerMap[providerId]);
  if (existingProvider === null && (!baseUrl || !api)) {
    throw new Error("新 provider 需要 baseUrl 和 api");
  }
  const provider = existingProvider ?? {};
  providerMap[providerId] = provider;
  setOrDelete(provider, "name", draft.providerName.trim() || null);
  setOrDelete(provider, "baseUrl", baseUrl || null);
  setOrDelete(provider, "api", api || null);
  // "none" keeps a key the provider already had: clearing credentials is not
  // this form's job, and dropping it would break its other models.
  if (apiKey !== null) provider.apiKey = apiKey;

  const models = provider.models === undefined ? [] : asArray(provider.models);
  const index = models.findIndex((m) => asObject(m)?.id === modelId);
  const entry: JsonObject = { ...(asObject(models[index]) ?? {}), id: modelId };
  setOrDelete(entry, "name", draft.name.trim() || null);
  setOrDelete(entry, "reasoning", draft.reasoning ? true : null);
  setOrDelete(entry, "input", draft.inputImage ? ["text", "image"] : null);
  setOrDelete(entry, "contextWindow", contextWindow);
  setOrDelete(entry, "maxTokens", maxTokens);
  setOrDelete(
    entry,
    "thinkingLevelMap",
    thinkingLevels.length > 0 ? Object.fromEntries(thinkingLevels.map((level) => [level, level])) : null,
  );
  if (index >= 0) models[index] = entry;
  else models.push(entry);
  provider.models = models;

  await writeConfig(path, config, exists);
  return { path };
}

/** Remove one added model; returns `removed: false` when it was not there. */
export async function deleteModel(providerId: string, modelId: string): Promise<{ path: string; removed: boolean }> {
  const { path, exists, config } = await loadConfig();
  const providerMap = asObject(config.providers);
  if (providerMap === null || !exists) return { path, removed: false };
  const removed = removeEntry(providerMap, providerId, modelId);
  if (removed) await writeConfig(path, config, exists);
  return { path, removed };
}

/** Wire input → draft. Validation of the values themselves happens in `saveModel`. */
export function parseDraft(value: unknown): ModelDraft {
  const raw = asObject(value);
  if (raw === null) throw new Error("缺少模型参数");
  const mode = raw.apiKeyMode;
  if (mode !== "none" && mode !== "env" && mode !== "literal") throw new Error("API Key 来源不合法");
  const original = asObject(raw.original);
  return {
    original:
      original === null
        ? null
        : { provider: requiredString(original.provider, "原始 provider"), id: requiredString(original.id, "原始模型 ID") },
    provider: requiredString(raw.provider, "provider"),
    id: requiredString(raw.id, "模型 ID"),
    name: optionalString(raw.name),
    providerName: optionalString(raw.providerName),
    baseUrl: optionalString(raw.baseUrl),
    api: optionalString(raw.api),
    apiKeyMode: mode,
    apiKey: optionalString(raw.apiKey),
    reasoning: raw.reasoning === true,
    inputImage: raw.inputImage === true,
    contextWindow: optionalNumber(raw.contextWindow, "上下文窗口"),
    maxTokens: optionalNumber(raw.maxTokens, "最大输出 tokens"),
    thinkingLevels: asArray(raw.thinkingLevels).filter((level): level is string => typeof level === "string"),
  };
}

async function loadConfig(): Promise<{ path: string; exists: boolean; config: JsonObject }> {
  const path = modelsConfigPath();
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { path, exists: false, config: {} };
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonComments(raw.replace(/^\uFEFF/, "")));
  } catch (error: unknown) {
    throw new Error(`models.json 解析失败：${error instanceof Error ? error.message : String(error)}`);
  }
  const config = asObject(parsed);
  if (config === null) throw new Error("models.json 顶层必须是对象");
  return { path, exists: true, config };
}

/** Write through a temp file so a crash never leaves half a config behind. */
async function writeConfig(path: string, config: JsonObject, exists: boolean): Promise<void> {
  if (!exists) {
    const withSchema: JsonObject = { $schema: "https://pi.dev/schemas/models.schema.json", ...config };
    config = withSchema;
  }
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  await rename(temp, path);
}

/** Remove one entry from a parsed config; true when it was found. */
function removeEntry(providers: JsonObject, providerId: string, modelId: string): boolean {
  const provider = asObject(providers[providerId]);
  if (provider === null) return false;
  const models = asArray(provider.models);
  const kept = models.filter((m) => asObject(m)?.id !== modelId);
  if (kept.length === models.length) return false;
  if (kept.length === 0) delete provider.models;
  else provider.models = kept;
  // Drop a provider entry the UI created only to hold this model.
  if (Object.keys(provider).length === 0) delete providers[providerId];
  return true;
}

/** "none" keeps an existing key; env names become `$NAME` interpolations. */
function apiKeyValue(draft: ModelDraft): string | null {
  if (draft.apiKeyMode === "none") return null;
  const value = draft.apiKey.trim();
  if (!value) return null;
  if (draft.apiKeyMode === "literal") return value;
  const name = value.replace(/^\$\{?/, "").replace(/\}$/, "");
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error("环境变量名只能包含字母、数字和下划线，且不能以数字开头");
  }
  return `$${name}`;
}

function positiveInt(value: number | null, label: string): number | null {
  if (value === null) return null;
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${label}必须是正整数`);
  return value;
}

function setOrDelete(target: JsonObject, key: string, value: unknown): void {
  if (value === null || value === undefined) delete target[key];
  else target[key] = value;
}

/** Mirrors pi's parser: drop `//` comments and trailing commas outside strings. */
function stripJsonComments(input: string): string {
  return input
    .replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*/g, (m) => (m[0] === '"' ? m : ""))
    .replace(/"(?:\\.|[^"\\])*"|,(\s*[}\]])/g, (m, tail?: string) => tail ?? (m[0] === '"' ? m : ""));
}

/** JSON is a trust boundary: every shape below is checked, not asserted. */
function asObject(value: unknown): JsonObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as JsonObject) : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} 必须是字符串`);
  return value;
}

function optionalString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function optionalNumber(value: unknown, label: string): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} 必须是数字`);
  return value;
}