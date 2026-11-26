// Model + thinking control for the composer toolbar: one button that opens a
// panel with the model list on top and the levels of the current model below,
// so switching a model and changing how hard it thinks happen in one place.
import { useEffect, useRef, useState } from "preact/hooks";
import type { JSX } from "preact";
import { IconCheck } from "./icons";
import type { Model } from "./protocol";

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

export function ModelPicker({
  model,
  models,
  thinkingLevel,
  thinkingLevels,
  onSetModel,
  onSetThinking,
}: {
  model: { id: string; name: string; provider: string } | null;
  models: Model[];
  thinkingLevel: string | null;
  /** Levels the current model offers; null when only "off" applies. */
  thinkingLevels: string[] | null;
  onSetModel: (provider: string, modelId: string) => void;
  onSetThinking: (level: string) => void;
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

  const current =
    model === null ? "未选择模型" : (model.name ?? model.id);
  const tag = levels === null || thinkingLevel === null ? null : thinkingLabel(thinkingLevel);

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
            {models.map((m) => {
              const isCurrent =
                model !== null && m.provider === model.provider && m.id === model.id;
              return (
                <button
                  key={`${m.provider}/${m.id}`}
                  class={`mp-item${isCurrent ? " active" : ""}`}
                  role="option"
                  aria-selected={isCurrent}
                  title={`${m.provider}/${m.id}`}
                  onClick={() => onSetModel(m.provider, m.id)}
                >
                  <span class="mp-item-name">{m.name ?? m.id}</span>
                  {isCurrent ? <IconCheck size={12} /> : null}
                </button>
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
        </div>
      ) : null}
    </div>
  );
}