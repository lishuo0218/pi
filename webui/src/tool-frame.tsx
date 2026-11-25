// Collapsed-bar frame shared by the read-only tool cards (read / grep / find /
// ls): caret, status, label (icon or mono tool name), one-line title, right
// side facts and duration, then the expandable body. The open choice is
// remembered per card for the session; failures open on their own until the
// user decides otherwise.
import { useState } from "preact/hooks";
import type { JSX } from "preact";

/** Cards the user opened or closed stay that way across remounts (session only). */
const openChoice = new Map<string, boolean>();

export type ToolFrameProps = {
  /** Stable card id (toolCallId): keys the remembered open choice. */
  id: string;
  running: boolean;
  failed: boolean;
  durationMs?: number;
  /** Left identifier: an icon for read, the mono tool name for list tools. */
  label: JSX.Element;
  /** Title after the label (path plus range, pattern, ...). */
  title: JSX.Element;
  titleAttr?: string;
  /** Facts between title and duration (line range, result count). */
  meta?: JSX.Element | null;
  /** Open from the start even when the run succeeded (e.g. image results). */
  openByDefault?: boolean;
  children?: JSX.Element | null;
};

export function ToolFrame({
  id,
  running,
  failed,
  durationMs,
  label,
  title,
  titleAttr,
  meta,
  openByDefault,
  children,
}: ToolFrameProps): JSX.Element {
  const [remembered, setRemembered] = useState<boolean | undefined>(() => openChoice.get(id));
  // A frame without a body (a single-line record) is not clickable at all.
  const expandable = children !== undefined;
  const open = expandable && (remembered ?? (failed || (openByDefault ?? false)));
  const toggle = (): void => {
    openChoice.set(id, !open);
    setRemembered(!open);
  };
  return (
    <div class={`tool-frame${failed ? " error" : ""}${open ? " open" : ""}${expandable ? "" : " static"}`}>
      <div class="frame-bar" onClick={expandable ? toggle : undefined}>
        {running ? <span class="spinner" /> : null}
        {label}
        <span class="frame-title" title={titleAttr}>
          {title}
        </span>
        {meta}
        {durationMs != null && !running ? (
          <span class="tool-duration">{(durationMs / 1000).toFixed(1)}s</span>
        ) : null}
      </div>
      {open ? <div class="frame-body">{children}</div> : null}
    </div>
  );
}