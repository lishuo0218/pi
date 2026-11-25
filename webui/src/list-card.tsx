// Read-only list tool card (grep / find / ls): the same collapsed bar as read
// cards, with the mono tool name as its label and the search pattern / path as
// its title. The body is the raw result text: no line numbers, no highlight,
// because these results are matches and file lists rather than file content.
import type { JSX } from "preact";
import type { ToolExecution } from "./tool-store";
import { ToolFrame } from "./tool-frame";

/** Title line: the pattern, then where it searched; ls has only the path. */
function listTitle(exec: ToolExecution): string {
  const pattern = exec.args.pattern;
  const path = exec.args.path ?? exec.args.file_path;
  const glob = exec.args.glob;
  const parts: string[] = [];
  if (typeof pattern === "string" && pattern !== "") parts.push(pattern);
  if (typeof path === "string" && path !== "" && path !== ".") parts.push(`in ${path}`);
  if (typeof glob === "string" && glob !== "") parts.push(`glob ${glob}`);
  return parts.join(" · ");
}

export function ListCard({ exec }: { exec: ToolExecution }): JSX.Element {
  const running = exec.state === "running";
  const text = (running ? exec.partial : exec.resultText).replace(/\n+$/, "");
  const title = listTitle(exec);
  const lineCount = text === "" ? 0 : text.split("\n").length;
  return (
    <ToolFrame
      id={exec.toolCallId}
      running={running}
      failed={exec.isError}
      durationMs={exec.durationMs}
      label={<span class="frame-name">{exec.toolName}</span>}
      title={<span class="frame-raw">{title}</span>}
      titleAttr={title}
      meta={!exec.isError && lineCount > 0 ? <span class="frame-meta">{lineCount} 行</span> : null}
    >
      {exec.isError ? (
        <div class="list-error">{text}</div>
      ) : running ? (
        <div class="list-empty">运行中…</div>
      ) : text !== "" ? (
        <pre class="list-output">{text}</pre>
      ) : (
        <div class="list-empty">（无结果）</div>
      )}
    </ToolFrame>
  );
}