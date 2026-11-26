// models.json handling for the add-model form: reading the added entries,
// writing one back without losing hand-written fields, deleting one, and the
// wire-input checks the bridge performs before touching the file.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  deleteModel,
  modelsConfigPath,
  parseDraft,
  readModelsConfig,
  saveModel,
  type ModelDraft,
} from "../bridge/models.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pi-webui-models-"));
  process.env.PI_CODING_AGENT_DIR = dir;
});

afterEach(() => {
  delete process.env.PI_CODING_AGENT_DIR;
  rmSync(dir, { recursive: true, force: true });
});

function draft(overrides: Partial<ModelDraft> = {}): ModelDraft {
  return {
    original: null,
    provider: "ollama",
    id: "qwen2.5-coder:7b",
    name: "",
    providerName: "",
    baseUrl: "http://localhost:11434/v1",
    api: "openai-completions",
    apiKeyMode: "env",
    apiKey: "OLLAMA_KEY",
    reasoning: false,
    inputImage: false,
    contextWindow: null,
    maxTokens: null,
    thinkingLevels: [],
    ...overrides,
  };
}

function readFileJson(): Record<string, unknown> {
  return JSON.parse(readFileSync(modelsConfigPath(), "utf8")) as Record<string, unknown>;
}

/** The provider block of the saved file; the tests always expect one. */
function providerConfig(id: string): Record<string, unknown> {
  const providers = readFileJson().providers as Record<string, Record<string, unknown>>;
  const provider = providers[id];
  if (provider === undefined) throw new Error(`provider ${id} is missing from models.json`);
  return provider;
}

describe("readModelsConfig", () => {
  it("reports a missing file without creating it", async () => {
    const snapshot = await readModelsConfig();
    expect(snapshot.exists).toBe(false);
    expect(snapshot.entries).toEqual([]);
    expect(snapshot.path).toBe(join(dir, "models.json"));
  });

  it("lists added models with their provider connection", async () => {
    writeFileSync(
      modelsConfigPath(),
      JSON.stringify({
        providers: {
          deepseek: {
            baseUrl: "https://api.deepseek.com/v1",
            api: "openai-completions",
            apiKey: "$DEEPSEEK_API_KEY",
            models: [{ id: "deepseek-chat", name: "DeepSeek Chat", reasoning: true, contextWindow: 64000 }],
          },
        },
      }),
      "utf8",
    );
    const snapshot = await readModelsConfig();
    expect(snapshot.exists).toBe(true);
    expect(snapshot.providers).toEqual([
      {
        id: "deepseek",
        name: null,
        baseUrl: "https://api.deepseek.com/v1",
        api: "openai-completions",
        apiKey: "$DEEPSEEK_API_KEY",
      },
    ]);
    expect(snapshot.entries).toEqual([
      {
        provider: "deepseek",
        id: "deepseek-chat",
        name: "DeepSeek Chat",
        reasoning: true,
        input: [],
        contextWindow: 64000,
        maxTokens: null,
        thinkingLevels: [],
      },
    ]);
  });

  it("accepts comments and trailing commas the way pi does", async () => {
    writeFileSync(
      modelsConfigPath(),
      '{\n  // 注释\n  "providers": {\n    "x": { "models": [{ "id": "m" },], },\n  },\n}\n',
      "utf8",
    );
    const snapshot = await readModelsConfig();
    expect(snapshot.entries.map((e) => e.id)).toEqual(["m"]);
  });

  it("fails loudly on broken JSON", async () => {
    writeFileSync(modelsConfigPath(), "{", "utf8");
    await expect(readModelsConfig()).rejects.toThrow("models.json 解析失败");
  });
});

describe("saveModel", () => {
  it("creates the file with a schema and a $NAME key reference", async () => {
    await saveModel(draft());
    const config = readFileJson();
    expect(config.$schema).toBe("https://pi.dev/schemas/models.schema.json");
    expect(config.providers).toEqual({
      ollama: {
        baseUrl: "http://localhost:11434/v1",
        api: "openai-completions",
        apiKey: "$OLLAMA_KEY",
        models: [{ id: "qwen2.5-coder:7b" }],
      },
    });
  });

  it("keeps hand-written entry fields and provider settings on edit", async () => {
    writeFileSync(
      modelsConfigPath(),
      JSON.stringify({
        providers: {
          ollama: {
            baseUrl: "http://localhost:11434/v1",
            api: "openai-completions",
            models: [{ id: "m", cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8000 }],
          },
        },
      }),
      "utf8",
    );
    await saveModel(
      draft({
        original: { provider: "ollama", id: "m" },
        id: "m",
        name: "Mine",
        apiKeyMode: "none",
        contextWindow: 16000,
        reasoning: true,
        inputImage: true,
        thinkingLevels: ["low", "high"],
      }),
    );
    const provider = providerConfig("ollama");
    expect(provider.baseUrl).toBe("http://localhost:11434/v1");
    expect(provider.apiKey).toBeUndefined();
    expect(provider.models).toEqual([
      {
        id: "m",
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 16000,
        name: "Mine",
        reasoning: true,
        input: ["text", "image"],
        thinkingLevelMap: { low: "low", high: "high" },
      },
    ]);
  });

  it("moves an entry when its provider or id changes", async () => {
    await saveModel(draft());
    await saveModel(draft({ original: { provider: "ollama", id: "qwen2.5-coder:7b" }, id: "qwen3", name: "Qwen 3" }));
    const config = await readModelsConfig();
    expect(config.entries.map((e) => `${e.provider}/${e.id}`)).toEqual(["ollama/qwen3"]);
  });

  it("clears a field the form emptied", async () => {
    await saveModel(draft({ name: "Named" }));
    await saveModel(draft({ original: { provider: "ollama", id: "qwen2.5-coder:7b" }, name: "" }));
    const config = await readModelsConfig();
    expect(config.entries[0]?.name).toBeNull();
  });

  it("requires a connection for a new provider", async () => {
    await expect(saveModel(draft({ baseUrl: "" }))).rejects.toThrow("新 provider 需要 baseUrl 和 api");
    await expect(saveModel(draft({ api: "" }))).rejects.toThrow("新 provider 需要 baseUrl 和 api");
  });

  it("rejects bad values before writing", async () => {
    await expect(saveModel(draft({ provider: "bad provider" }))).rejects.toThrow("provider");
    await expect(saveModel(draft({ id: "  " }))).rejects.toThrow("模型 ID");
    await expect(saveModel(draft({ baseUrl: "localhost:11434" }))).rejects.toThrow("baseUrl");
    await expect(saveModel(draft({ contextWindow: -1 }))).rejects.toThrow("上下文窗口");
    await expect(saveModel(draft({ apiKey: "9BAD" }))).rejects.toThrow("环境变量名");
  });

  it("leaves an existing key alone when the form does not set one", async () => {
    await saveModel(draft());
    await saveModel(draft({ id: "second", apiKeyMode: "none" }));
    const provider = providerConfig("ollama");
    expect(provider.apiKey).toBe("$OLLAMA_KEY");
  });
});

describe("deleteModel", () => {
  it("removes the entry, keeping the provider connection for later", async () => {
    await saveModel(draft());
    const result = await deleteModel("ollama", "qwen2.5-coder:7b");
    expect(result.removed).toBe(true);
    // The connection survives: it may be a proxy or key other models rely on,
    // and the delete only asked for the model.
    expect(readFileJson().providers).toEqual({
      ollama: { baseUrl: "http://localhost:11434/v1", api: "openai-completions", apiKey: "$OLLAMA_KEY" },
    });
  });

  it("keeps the provider while another model uses it", async () => {
    await saveModel(draft());
    await saveModel(draft({ id: "other" }));
    await deleteModel("ollama", "other");
    const config = await readModelsConfig();
    expect(config.entries.map((e) => e.id)).toEqual(["qwen2.5-coder:7b"]);
  });

  it("drops a provider entry that held nothing but the model", async () => {
    writeFileSync(modelsConfigPath(), JSON.stringify({ providers: { x: { models: [{ id: "m" }] } } }), "utf8");
    await deleteModel("x", "m");
    expect(readFileJson().providers).toEqual({});
  });

  it("reports a model that is not there", async () => {
    await saveModel(draft());
    const result = await deleteModel("ollama", "missing");
    expect(result.removed).toBe(false);
  });
});

describe("parseDraft", () => {
  it("accepts a complete wire draft", () => {
    expect(parseDraft({ ...draft(), apiKeyMode: "literal" })).toMatchObject({
      provider: "ollama",
      id: "qwen2.5-coder:7b",
      apiKeyMode: "literal",
      original: null,
    });
  });

  it("rejects missing fields and unknown key modes", () => {
    expect(() => parseDraft(null)).toThrow("缺少模型参数");
    expect(() => parseDraft({ ...draft(), apiKeyMode: "vault" })).toThrow("API Key 来源");
    expect(() => parseDraft({ ...draft(), provider: 42 })).toThrow("provider 必须是字符串");
    expect(() => parseDraft({ ...draft(), contextWindow: "big" })).toThrow("上下文窗口 必须是数字");
  });
});