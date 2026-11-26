// Model + thinking control for the composer toolbar: one button that opens a
// panel with the model list on top and the levels of the current model below,
// so switching a model and changing how hard it thinks happen in one place.
// Models added through models.json carry edit/delete actions; the row that
// opens the add form sits at the bottom of the panel.
import { useEffect, useRef, useState } from "preact/hooks";
import type { JSX } from "preact";
import { IconCheck, IconEdit, IconPlus, IconTrash } from "./icons";
import type { Model, ModelEntry } from "./protocol";

/** Chinese labels for pi's thinking levels; a level without one shows as is. */
const LEVEL_LABELS: Record<string, string> = {
  off: "关",
  minimal: "最少",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "很高",
  max: "最高",
};

export function thinkingLabel(level: string): string {
  return LEVEL_LABELS[level] ?? level;
}

/** One rendered row: an available model, or a config entry pi did not load. */
type Row = {
  provider: string;
  id: string;
  label: string;
  active: boolean;
  available: boolean;
  /** The models.json entry this row manages; null for built-in models. */
  entry: ModelEntry | null;
};

export function ModelPicker({
  model,
  models,
  customEntries,
  thinkingLevel,
  thinkingLevels,
  onSetModel,
  onSetThinking,
  onAddModel,
  onEditModel,
  onDeleteModel,
}: {
  model: { id: string; name: string; provider: string } | null;
  models: Model[];
  /** Models the user added in models.json (bridge snapshot). */
  customEntries: ModelEntry[];
  thinkingLevel: string | null;
  /** Levels the current model offers; null when only "off" applies. */
  thinkingLevels: string[] | null;
  onSetModel: (provider: string, modelId: string) => void;
  onSetThinking: (level: string) => void;
  onAddModel: () => void;
  onEditModel: (entry: ModelEntry) => void;
  onDeleteModel: (entry: ModelEntry) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const levels = thinkingLevels !== null && thinkingLevels.length > 1 ? thinkingLevels : null;

  // Close on an outside click or Escape, the way the session menu in the
  // sidebar does. Escape is consumed so the page keeps its own handling.
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent): void => {
      const root = rootRef.current;
      if (root !== null && event.target instanceof Node && root.contains(event.target)) return;
      setOpen(false);
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      // The git view closes itself on Escape unless the default was prevented.
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
    };
    // Capture, so a click on a control inside does not close before it runs.
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  const current = model === null ? "未选择模型" : (model.name ?? model.id);
  const tag = levels === null || thinkingLevel === null ? null : thinkingLabel(thinkingLevel);

  // Available models first, then added ones pi did not load (bad key or
  // endpoint): those must stay reachable so they can be fixed or deleted.
  const customByKey = new Map(customEntries.map((entry) => [`${entry.provider}/${entry.id}`, entry]));
  const rows: Row[] = models.map((m) => ({
    provider: m.provider,
    id: m.id,
    label: m.name ?? m.id,
    active: model !== null && m.provider === model.provider && m.id === model.id,
    available: true,
    entry: customByKey.get(`${m.provider}/${m.id}`) ?? null,
  }));
  const loaded = new Set(models.map((m) => `${m.provider}/${m.id}`));
  for (const entry of customEntries) {
    if (loaded.has(`${entry.provider}/${entry.id}`)) continue;
    rows.push({
      provider: entry.provider,
      id: entry.id,
      label: entry.name ?? entry.id,
      active: false,
      available: false,
      entry,
    });
  }

  // Opening the form (or the delete dialog) closes the panel; the dialog owns
  // the screen from then on.
  const handOff = (action: () => void): void => {
    setOpen(false);
    action();
  };

  return (
    <div class="mp" ref={rootRef}>
      <button
        class={`mp-btn${open ? " open" : ""}`}
        title={model === null ? "未选择模型" : `${model.provider}/${model.id}`}
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span class="mp-name">{current}</span>
        {tag === null ? null : <span class="mp-tag">{tag}</span>}
      </button>
      {open ? (
        <div class="mp-panel">
          <div class="mp-label">模型</div>
          <div class="mp-models" role="listbox">
            {rows.map((row) => {
              const entry = row.entry;
              return (
                <div
                  key={`${row.provider}/${row.id}`}
                  class={`mp-item${row.active ? " active" : ""}${row.available ? "" : " unavailable"}`}
                >
                  <button
                    class="mp-item-main"
                    role="option"
                    aria-selected={row.active}
                    disabled={!row.available}
                    title={
                      row.available
                        ? `${row.provider}/${row.id}`
                        : `${row.provider}/${row.id}（配置存在，但 pi 未加载：检查密钥和端点）`
                    }
                    onClick={() => onSetModel(row.provider, row.id)}
                  >
                    <span class="mp-item-name">{row.label}</span>
                    {row.active ? <IconCheck size={12} /> : null}
                  </button>
                  {entry === null ? null : (
                    <span class="mp-item-actions">
                      <button class="mp-act" title="编辑模型" onClick={() => handOff(() => onEditModel(entry))}>
                        <IconEdit size={12} />
                      </button>
                      <button
                        class="mp-act danger"
                        title="删除模型"
                        onClick={() => handOff(() => onDeleteModel(entry))}
                      >
                        <IconTrash size={11} />
                      </button>
                    </span>
                  )}
                </div>
              );
            })}
          </div>
          {levels === null ? null : (
            <>
              <div class="mp-label">思考强度</div>
              <div class="mp-levels">
                {levels.map((level) => (
                  <button
                    key={level}
                    class={`mp-level${level === thinkingLevel ? " active" : ""}`}
                    title={level}
                    onClick={() => onSetThinking(level)}
                  >
                    {thinkingLabel(level)}
                  </button>
                ))}
              </div>
            </>
          )}
          <button class="mp-add" onClick={() => handOff(onAddModel)}>
            <IconPlus size={12} />
            添加模型
          </button>
        </div>
      ) : null}
    </div>
  );
}