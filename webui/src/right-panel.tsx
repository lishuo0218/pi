// Right side panel: the agent's ToDo checklist on top, a browser for the
// running pi's working directory below. Both are read-only views; the ToDo list
// is rebuilt from stores on every session switch or page reload, the file
// browser reads directories from the bridge on demand. Opening a file takes the
// whole panel over, and the panel's left edge then resizes it.
import { useEffect, useState } from "preact/hooks";
import { useSyncExternalStore } from "preact/compat";
import type { JSX } from "preact";
import type { TodoStore } from "./todo-store";
import { getPiCwd, onPiCwdChange } from "./pi-cwd";
import { FileTree } from "./file-tree";
import { FilePreviewSection } from "./file-preview";
import { savePreviewWidth, setPreviewWidth } from "./panel-width";
import type { PreviewRequest } from "./preview-target";
import type { Theme } from "./theme";

/** Read-only checkbox glyph: empty box, or a filled box with a tick. */
function Checkbox({ done }: { done: boolean }): JSX.Element {
  return <span class={`todo-check${done ? " done" : ""}`}>{done ? "✓" : ""}</span>;
}

export function RightPanel({
  todo,
  preview,
  theme,
  onBack,
  onClose,
}: {
  todo: TodoStore;
  /** File open in the panel, or null for the ToDo and file tree view. */
  preview: PreviewRequest | null;
  /** Picks the light or dark variant of each file icon. */
  theme: Theme;
  /** Leaves the preview and shows the file tree again. */
  onBack: () => void;
  /** Hides the whole right panel. */
  onClose: () => void;
}): JSX.Element {
  const todoVersion = useSyncExternalStore(
    (cb) => todo.subscribe(cb),
    () => todo.version,
  );
  // The version is the store's reactivity key; read contents after it.
  void todoVersion;
  const tasks = todo.tasks;
  const doneCount = tasks.filter((t) => t.done).length;
  const allDone = tasks.length > 0 && doneCount === tasks.length;

  const [cwd, setCwd] = useState<string | null>(getPiCwd);
  useEffect(() => onPiCwdChange(() => setCwd(getPiCwd())), []);

  return (
    <aside class="side-panel" aria-label={preview === null ? "ToDo 与文件侧栏" : "文件预览"}>
      {preview === null ? null : (
        <>
          <div class="side-resizer" title="拖动调整宽度" onPointerDown={startResize} />
          <FilePreviewSection
            key={preview.seq}
            request={preview}
            theme={theme}
            onBack={onBack}
            onClose={onClose}
          />
        </>
      )}
      <div class={`side-view${preview === null ? "" : " gone"}`}>
        <section class="side-section todo-section">
          <div class="side-section-head">
            <span class="side-section-title">ToDo</span>
            {tasks.length > 0 ? (
              <span class={`todo-progress${allDone ? " done" : ""}`}>
                {doneCount}/{tasks.length}
              </span>
            ) : null}
            <button class="side-panel-close" title="收起侧栏" onClick={onClose}>
              ✕
            </button>
          </div>
          {tasks.length === 0 ? (
            <div class="side-empty">暂无 ToDo 清单。Agent 开始多步骤任务时会在这里列出计划。</div>
          ) : (
            <ul class="todo-list">
              {tasks.map((task, i) => (
                <li key={i} class={`todo-item${task.done ? " done" : ""}`}>
                  <Checkbox done={task.done} />
                  <span class="todo-text">{task.text}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
        <FileTree cwd={cwd} theme={theme} />
      </div>
    </aside>
  );
}

/**
 * Drag the panel's left edge. Widths go to panel-width.ts on every move so the
 * message stream follows the pointer; the stored value is written once on
 * release.
 */
function startResize(event: JSX.TargetedPointerEvent<HTMLDivElement>): void {
  event.preventDefault();
  const move = (moveEvent: PointerEvent): void => setPreviewWidth(window.innerWidth - moveEvent.clientX);
  const up = (): void => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    savePreviewWidth();
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}