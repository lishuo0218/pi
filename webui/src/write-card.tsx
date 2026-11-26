// Write tool card. pi's write result is a fixed one-liner ("Successfully wrote
// to <path>"), so the card shows what was written instead: the content, syntax
// highlighted from the path, behind one bar carrying the path, the line count
// and the size. Same bar and numbered code body as the edit card, so the two
// file cards read the same; the result text only appears when the write failed.
// While the model is still emitting the arguments, the content and the line
// count grow as it arrives: the store re-reads the streamed arguments once per
// frame, so the rows below are the file being written, not an empty card.
import { memo } from "preact/compat";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { JSX } from "preact";
import type { ToolExecution } from "./tool-store";
import { langForPath, markedLineHtml } from "./highlight";
import { PathLabel, relativeToCwd, splitPath, toolPathArg } from "./path-label";
import { getPiCwd, onPiCwdChange } from "./pi-cwd";
import { IconEdit } from "./icons";
import { Collapse } from "./collapse";

/** Trailing blank lines are not written content; pi trims them in its own view. */
function writtenLines(content: string): string[] {
  const lines = content.split("\n");
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function WriteCard({ exec }: { exec: ToolExecution }): JSX.Element {
  const running = exec.state === "running";
  const [open, setOpen] = useState(true);
  const [cwd, setCwdState] = useState<string | null>(getPiCwd);
  useEffect(() => onPiCwdChange(() => setCwdState(getPiCwd())), []);
  const path = useMemo(() => {
    const raw = toolPathArg(exec.args) ?? "";
    const display = relativeToCwd(raw, cwd) ?? raw;
    return { raw, ...splitPath(display) };
  }, [exec.args, cwd]);
  const content = typeof exec.args.content === "string" ? exec.args.content : "";
  const lang = path.raw ? langForPath(path.raw) : undefined;
  const lines = useMemo(() => writtenLines(content), [content]);
  const size = useMemo(() => new TextEncoder().encode(content).length, [content]);
  return (
    <div class={`edit-card write-card ${running ? "running" : exec.isError ? "error" : "done"}${open ? " open" : ""}`}>
      <div class="edit-bar" onClick={() => setOpen(!open)}>
        {running ? <span class="spinner" /> : null}
        <IconEdit size={13} />
        {path.raw ? (
          <PathLabel dir={path.dir} name={path.name} title={path.raw} />
        ) : (
          // The model may emit the content before the path, so the bar needs a
          // name for the call that has none of its arguments yet.
          <span class="tool-summary">{running ? "写入中…" : exec.toolName || "write"}</span>
        )}
        {lines.length > 0 ? <span class="edit-stats"><span class="stat-add">+{lines.length} 行</span></span> : null}
        {size > 0 ? <span class="tool-duration">{formatBytes(size)}</span> : null}
      </div>
      {exec.isError && exec.resultText ? <div class="edit-error">{exec.resultText}</div> : null}
      {lines.length > 0 ? (
        <Collapse open={open}>
          <WrittenBody lines={lines} lang={lang} live={running} />
        </Collapse>
      ) : null}
    </div>
  );
}

/**
 * The numbered rows of the written file. Memoized on `lines`: while the
 * arguments stream, the card re-renders on every delta, but the rows are only
 * diffed when the content the store published actually changed.
 */
const WrittenBody = memo(function WrittenBody({
  lines,
  lang,
  live,
}: {
  lines: string[];
  lang: string | undefined;
  live: boolean;
}): JSX.Element {
  const body = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    // While the model writes, follow the tail the way the thinking block does.
    if (live && body.current !== null) body.current.scrollTop = body.current.scrollHeight;
  }, [lines, live]);
  return (
    <div class="edit-diff" ref={body}>
      {lines.map((line, i) => (
        <div key={i} class="diff-line ctx">
          <span class="diff-num">{i + 1}</span>
          <span class="diff-code" dangerouslySetInnerHTML={{ __html: markedLineHtml(line, lang, []) }} />
        </div>
      ))}
    </div>
  );
});