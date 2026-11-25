// Extension UI mapping (F-23): dialogs become a modal, notify becomes
// toasts, setStatus feeds status chips, setWidget renders widget blocks
// above the composer, setTitle writes document.title, set_editor_text
// injects composer text. Dialogs respond via extension_ui_response.
import { useEffect, useRef, useState } from "preact/hooks";
import type { JSX } from "preact";
import type { ExtensionUiDialog } from "./protocol";

export function ExtensionDialog({
  dialog,
  onRespond,
}: {
  dialog: ExtensionUiDialog;
  onRespond: (value: string | undefined, confirmed: boolean | undefined) => void;
}): JSX.Element {
  const [input, setInput] = useState(dialog.prefill ?? "");
  const title = dialog.title ?? "扩展请求";
  // The agent resolves expired dialogs silently (auto-response, no event),
  // so the client must run its own countdown; otherwise the modal hangs
  // forever while the agent has already moved on.
  const [secondsLeft, setSecondsLeft] = useState(
    dialog.timeout ? Math.ceil(dialog.timeout / 1000) : 0,
  );
  const respondedRef = useRef(false);

  const respond = (value: string | undefined, confirmed: boolean | undefined): void => {
    if (respondedRef.current) return;
    respondedRef.current = true;
    onRespond(value, confirmed);
  };

  const cancel = (): void => respond(undefined, undefined);

  useEffect(() => {
    if (secondsLeft <= 0) return;
    const timer = setTimeout(() => setSecondsLeft((s) => s - 1), 1000);
    return () => clearTimeout(timer);
  }, [secondsLeft]);

  useEffect(() => {
    if (secondsLeft <= 0 && dialog.timeout) cancel();
  }, [secondsLeft, dialog.timeout]);

  const keyDown = (e: KeyboardEvent): void => {
    if (e.key === "Escape") cancel();
    if (e.key === "Enter" && !e.shiftKey && dialog.method !== "editor") {
      e.preventDefault();
      respond(dialog.method === "confirm" ? undefined : input, true);
    }
  };

  return (
    <div class="modal-mask">
      <div class="modal" onKeyDown={keyDown}>
        <div class="modal-title">{title}</div>
        {dialog.message ? <div class="modal-message">{dialog.message}</div> : null}
        {dialog.method === "select" ? (
          <div class="modal-options">
            {(dialog.options ?? []).map((opt) => (
              <button key={opt} class="modal-option" onClick={() => respond(opt, undefined)}>
                {opt}
              </button>
            ))}
          </div>
        ) : null}
        {dialog.method === "confirm" ? (
          <div class="modal-actions">
            <button class="btn-stop" onClick={() => respond(undefined, false)}>
              取消
            </button>
            <button class="btn-send" onClick={() => respond(undefined, true)}>
              确认
            </button>
          </div>
        ) : null}
        {dialog.method === "input" ? (
          <div class="modal-body">
            <input
              class="modal-input"
              placeholder={dialog.placeholder}
              value={input}
              onInput={(e) => setInput((e.target as HTMLInputElement).value)}
              autoFocus
            />
            <div class="modal-actions">
              <button class="btn-stop" onClick={cancel}>
                取消
              </button>
              <button class="btn-send" onClick={() => respond(input, undefined)}>
                确定
              </button>
            </div>
          </div>
        ) : null}
        {dialog.method === "editor" ? (
          <div class="modal-body">
            <textarea
              class="modal-editor"
              rows={8}
              value={input}
              onInput={(e) => setInput((e.target as HTMLTextAreaElement).value)}
            />
            <div class="modal-actions">
              <button class="btn-stop" onClick={cancel}>
                取消
              </button>
              <button class="btn-send" onClick={() => respond(input, undefined)}>
                提交
              </button>
            </div>
          </div>
        ) : null}
        {dialog.timeout ? (
          <div class="modal-timeout">
            {secondsLeft > 0 ? `超时 ${secondsLeft}s 后自动取消` : "已超时，自动取消中…"}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function StatusChips({
  statuses,
}: {
  statuses: Map<string, string>;
}): JSX.Element | null {
  if (statuses.size === 0) return null;
  return (
    <div class="status-chips">
      {[...statuses.entries()].map(([key, text]) => (
        <span key={key} class="status-chip" title={key}>
          {text}
        </span>
      ))}
    </div>
  );
}

export function WidgetArea({
  widgets,
}: {
  widgets: Map<string, { lines: string[]; placement: string }>;
}): JSX.Element | null {
  const above = [...widgets.entries()].filter(([, w]) => w.placement !== "belowEditor");
  if (above.length === 0) return null;
  return (
    <div class="widget-area">
      {above.map(([key, w]) => (
        <pre key={key} class="widget-block">
          {w.lines.join("\n")}
        </pre>
      ))}
    </div>
  );
}
