// Add/edit form for a user model in models.json, and the confirm dialog for
// deleting one. Saving writes the file bridge-side and then restarts pi, which
// is the only way a new model becomes available: pi reads models.json at
// startup, and the RPC protocol has no reload command.
import { useState } from "preact/hooks";
import type { JSX } from "preact";
import {
  MODEL_APIS,
  type ModelDraft,
  type ModelEntry,
  type ModelsConfigSnapshot,
  THINKING_LEVELS,
} from "./protocol";
import { thinkingLabel } from "./model-picker";

type KeyMode = "none" | "env" | "literal";

export function ModelEditor({
  snapshot,
  entry,
  defaultProvider,
  availableProviders,
  running,
  onCancel,
  onSave,
}: {
  /** models.json as last read; null until the bridge answered. */
  snapshot: ModelsConfigSnapshot | null;
  /** The entry being edited; null adds a new model. */
  entry: ModelEntry | null;
  /** Provider prefilled when adding; the current model's provider. */
  defaultProvider: string | null;
  /** Providers pi already knows (from the current model list), so adding a
   * model to them needs no baseUrl/api. */
  availableProviders: string[];
  running: boolean;
  onCancel: () => void;
  /** Resolves with an error message, or null once it is saved. */
  onSave: (draft: ModelDraft) => Promise<string | null>;
}): JSX.Element {
  const editing = entry !== null;
  const initial = snapshot?.providers.find((p) => p.id === (entry?.provider ?? defaultProvider ?? "")) ?? null;
  const [provider, setProvider] = useState(entry?.provider ?? defaultProvider ?? "");
  const [providerName, setProviderName] = useState(initial?.name ?? "");
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? "");
  const [api, setApi] = useState(initial?.api ?? "");
  // A new provider defaults to an environment reference: writing a key into
  // the file is the exception, not the rule.
  const [keyMode, setKeyMode] = useState<KeyMode>(initial === null ? "env" : keyModeOf(initial.apiKey));
  const [apiKey, setApiKey] = useState(initial?.apiKey ?? "");
  const [modelId, setModelId] = useState(entry?.id ?? "");
  const [name, setName] = useState(entry?.name ?? "");
  const [reasoning, setReasoning] = useState(entry?.reasoning ?? false);
  const [inputImage, setInputImage] = useState(entry?.input.includes("image") ?? false);
  const [contextWindow, setContextWindow] = useState(entry?.contextWindow?.toString() ?? "");
  const [maxTokens, setMaxTokens] = useState(entry?.maxTokens?.toString() ?? "");
  const [levels, setLevels] = useState<string[]>(entry?.thinkingLevels ?? []);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Adding under an existing provider reuses its connection; the field then
  // shows what will be written, so nothing is silently inherited.
  const applyProvider = (id: string): void => {
    setProvider(id);
    if (editing) return;
    const config = snapshot?.providers.find((p) => p.id === id.trim()) ?? null;
    setProviderName(config?.name ?? "");
    setBaseUrl(config?.baseUrl ?? "");
    setApi(config?.api ?? "");
    setKeyMode(config === null ? "env" : keyModeOf(config.apiKey));
    setApiKey(config?.apiKey ?? "");
  };

  const buildDraft = (): ModelDraft => {
    const providerId = provider.trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(providerId)) {
      throw new Error("provider 只能包含字母、数字、点、下划线和连字符");
    }
    const id = modelId.trim();
    if (!id) throw new Error("模型 ID 不能为空");
    const url = baseUrl.trim();
    if (url && !/^https?:\/\/\S+$/.test(url)) throw new Error("baseUrl 需以 http:// 或 https:// 开头");
    const knownProvider =
      availableProviders.includes(providerId) || (snapshot?.providers.some((p) => p.id === providerId) ?? false);
    if (!knownProvider && (!url || !api)) throw new Error("新 provider 需要 baseUrl 和 api");
    if (keyMode === "env" && apiKey.trim()) {
      const variable = apiKey.trim().replace(/^\$\{?/, "").replace(/\}$/, "");
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(variable)) {
        throw new Error("环境变量名只能包含字母、数字和下划线，且不能以数字开头");
      }
    }
    return {
      original: entry === null ? null : { provider: entry.provider, id: entry.id },
      provider: providerId,
      id,
      name,
      providerName,
      baseUrl: url,
      api,
      apiKeyMode: keyMode,
      apiKey,
      reasoning,
      inputImage,
      contextWindow: readCount(contextWindow, "上下文窗口"),
      maxTokens: readCount(maxTokens, "最大输出 tokens"),
      thinkingLevels: levels,
    };
  };

  const submit = async (): Promise<void> => {
    if (saving) return;
    let draft: ModelDraft;
    try {
      draft = buildDraft();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
      return;
    }
    setSaving(true);
    setError(null);
    const message = await onSave(draft);
    setSaving(false);
    if (message !== null) setError(message);
  };

  const keyDown = (event: KeyboardEvent): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      if (!saving) onCancel();
      return;
    }
    // Enter in a single-line field saves, the way the extension dialogs do.
    if (event.key === "Enter" && event.target instanceof HTMLInputElement) {
      event.preventDefault();
      void submit();
    }
  };

  return (
    <div class="modal-mask">
      <div class="modal model-modal" onKeyDown={keyDown}>
        <div class="modal-title">{editing ? "编辑模型" : "添加模型"}</div>
        <div class="modal-message model-path">{snapshot?.path ?? "~/.pi/agent/models.json"}</div>
        <div class="model-form">
          <label class="model-field">
            <span>provider</span>
            <input
              class="modal-input"
              list="model-provider-options"
              value={provider}
              placeholder="deepseek"
              onInput={(e) => applyProvider((e.target as HTMLInputElement).value)}
              autoFocus={!editing}
            />
          </label>
          <datalist id="model-provider-options">
            {(snapshot?.providers ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name ?? p.id}
              </option>
            ))}
          </datalist>
          <label class="model-field">
            <span>provider 名称</span>
            <input
              class="modal-input"
              value={providerName}
              placeholder="可选，显示在候选列表里"
              onInput={(e) => setProviderName((e.target as HTMLInputElement).value)}
            />
          </label>
          <label class="model-field">
            <span>baseUrl</span>
            <input
              class="modal-input"
              value={baseUrl}
              placeholder="https://api.example.com/v1"
              onInput={(e) => setBaseUrl((e.target as HTMLInputElement).value)}
            />
          </label>
          <label class="model-field">
            <span>API 类型</span>
            <select class="modal-input" value={api} onChange={(e) => setApi((e.target as HTMLSelectElement).value)}>
              <option value="">沿用 provider 的 api</option>
              {!api || (MODEL_APIS as readonly string[]).includes(api) ? null : <option value={api}>{api}</option>}
              {MODEL_APIS.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </label>
          <label class="model-field">
            <span>API Key</span>
            <div class="model-key-row">
              <select
                class="modal-input model-key-mode"
                value={keyMode}
                onChange={(e) => setKeyMode((e.target as HTMLSelectElement).value as KeyMode)}
              >
                <option value="none">不设置（沿用已有）</option>
                <option value="env">环境变量引用</option>
                <option value="literal">直接写入明文</option>
              </select>
              <input
                class="modal-input"
                value={apiKey}
                disabled={keyMode === "none"}
                placeholder={keyMode === "env" ? "DEEPSEEK_API_KEY 或 $DEEPSEEK_API_KEY" : "sk-..."}
                onInput={(e) => setApiKey((e.target as HTMLInputElement).value)}
              />
            </div>
          </label>
          <label class="model-field">
            <span>模型 ID</span>
            <input
              class="modal-input"
              value={modelId}
              placeholder="deepseek-chat"
              onInput={(e) => setModelId((e.target as HTMLInputElement).value)}
              autoFocus={editing}
            />
          </label>
          <label class="model-field">
            <span>显示名</span>
            <input
              class="modal-input"
              value={name}
              placeholder="可选，默认使用模型 ID"
              onInput={(e) => setName((e.target as HTMLInputElement).value)}
            />
          </label>
          <details class="model-advanced" open={reasoning || inputImage || levels.length > 0}>
            <summary>高级选项</summary>
            <div class="model-checks">
              <label>
                <input type="checkbox" checked={reasoning} onChange={(e) => setReasoning((e.target as HTMLInputElement).checked)} />
                支持思考
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={inputImage}
                  onChange={(e) => setInputImage((e.target as HTMLInputElement).checked)}
                />
                支持图片输入
              </label>
            </div>
            <div class="model-grid">
              <label class="model-field">
                <span>上下文窗口</span>
                <input
                  class="modal-input"
                  inputMode="numeric"
                  value={contextWindow}
                  placeholder="默认 128000"
                  onInput={(e) => setContextWindow((e.target as HTMLInputElement).value)}
                />
              </label>
              <label class="model-field">
                <span>最大输出 tokens</span>
                <input
                  class="modal-input"
                  inputMode="numeric"
                  value={maxTokens}
                  placeholder="默认 16384"
                  onInput={(e) => setMaxTokens((e.target as HTMLInputElement).value)}
                />
              </label>
            </div>
            <div class="model-field">
              <span>思考档位</span>
              <div class="mp-levels model-levels">
                {THINKING_LEVELS.map((level) => {
                  const on = levels.includes(level);
                  return (
                    <button
                      key={level}
                      type="button"
                      class={`mp-level${on ? " active" : ""}`}
                      onClick={() =>
                        setLevels((prev) => (on ? prev.filter((l) => l !== level) : [...prev, level]))
                      }
                    >
                      {thinkingLabel(level)}
                    </button>
                  );
                })}
              </div>
              <span class="model-hint">不勾选则沿用提供商的默认档位</span>
            </div>
          </details>
        </div>
        {error === null ? null : <div class="model-error">{error}</div>}
        <div class="modal-actions">
          <button class="btn-stop" onClick={onCancel} disabled={saving}>
            取消
          </button>
          <button class="btn-send" onClick={() => void submit()} disabled={saving}>
            {saving ? "保存中…" : "保存并重启"}
          </button>
        </div>
        <div class="modal-timeout">
          {running ? "保存会重启 pi，正在运行的回合会被中断" : "保存后重启 pi 以加载新模型"}
        </div>
      </div>
    </div>
  );
}

export function ModelDeleteDialog({
  entry,
  onCancel,
  onConfirm,
}: {
  entry: ModelEntry;
  onCancel: () => void;
  onConfirm: () => void;
}): JSX.Element {
  return (
    <div class="modal-mask">
      <div class="modal" onKeyDown={(e) => e.key === "Escape" && onCancel()}>
        <div class="modal-title">删除模型？</div>
        <div class="modal-message">
          将从 models.json 移除 {entry.provider}/{entry.id}，并重启 pi。
        </div>
        <div class="modal-actions">
          <button class="btn-stop" onClick={onCancel} autoFocus>
            取消
          </button>
          <button class="btn-send" onClick={onConfirm}>
            删除
          </button>
        </div>
      </div>
    </div>
  );
}

/** Provider apiKey → the form's key mode: env references start with "$". */
function keyModeOf(apiKey: string | null): KeyMode {
  if (!apiKey) return "none";
  return apiKey.startsWith("$") ? "env" : "literal";
}

function readCount(text: string, label: string): number | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const value = Number(trimmed);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${label}必须是正整数`);
  return value;
}