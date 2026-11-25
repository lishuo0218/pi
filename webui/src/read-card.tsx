// read tool card: collapsed bar with the file path and read range; expanded,
// the file content with line numbers and syntax highlight. pi's trailing
// status notices ("[Showing lines ...]") are moved out of the code into a
// footer note, and the byte count is what this read returned. Image reads
// open on their own, because the image is the result.
import { useEffect, useMemo, useState } from "preact/hooks";
import type { JSX } from "preact";
import type { ToolExecution } from "./tool-store";
import { ToolFrame } from "./tool-frame";
import { CopyButton } from "./copy-button";
import { PathLabel, relativeToCwd, splitPath } from "./path-label";
import { getPiCwd, onPiCwdChange } from "./pi-cwd";
import { langForPath, lineHtml } from "./highlight";
import { IconRead } from "./icons";

/** pi's "[Showing lines 1-2000 of 5000 ...]" tail of a truncated read. */
const SHOWING = /\n\n\[Showing lines (\d+)-(\d+) of (\d+)(?: \([^)]*\))?\. Use offset=\d+ to continue\.\]$/;
/** pi's "[N more lines in file ...]" tail when the caller's limit stopped early. */
const MORE_LINES = /\n\n\[(\d+) more lines in file\. Use offset=(\d+) to continue\.\]$/;
/** pi's whole-result notice when one line is larger than the read byte cap. */
const FIRST_LINE_EXCEEDS = /^\[Line \d+ is [^\]]*exceeds [^\]]* limit\. Use bash: [^\]]*\]$/;

/** Argument value with the type the wire cannot guarantee. */
function stringArg(args: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "string" && value !== "") return value;
  }
  return "";
}

function numberArg(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** `:12-40` / `:12`, pi's own label for a partial read. */
function rangeLabel(offset: number | undefined, limit: number | undefined): string {
  if (offset === undefined) return "";
  if (limit === undefined) return `:${offset}`;
  return `:${offset}-${offset + limit - 1}`;
}

type ReadView = {
  /** Code without pi's status tails. */
  code: string;
  /** Line number of the first `code` line within the file. */
  startLine: number;
  /** Truncation / continuation state, shown under the code. */
  note?: string;
};

/** Split a read result into code and the status note pi appended to it. */
function readView(text: string, offset: number | undefined): ReadView {
  const body = text.replace(/\n+$/, "");
  const startLine = offset ?? 1;
  if (FIRST_LINE_EXCEEDS.test(body)) {
    return { code: "", startLine, note: "首行超过读取上限，pi 只返回了提示；可用 bash 取该行" };
  }
  const showing = SHOWING.exec(body);
  if (showing) {
    return {
      code: body.slice(0, showing.index),
      startLine,
      note: `显示第 ${showing[1]}–${showing[2]} 行 / 共 ${showing[3]} 行 · 输出已截断`,
    };
  }
  const more = MORE_LINES.exec(body);
  if (more) {
    return {
      code: body.slice(0, more.index),
      startLine,
      note: `后续还有 ${more[1]} 行未读取（offset=${more[2]} 继续）`,
    };
  }
  return { code: body, startLine };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  return kb < 100 ? `${kb.toFixed(1)} KB` : `${Math.round(kb)} KB`;
}

export function ReadCard({ exec }: { exec: ToolExecution }): JSX.Element {
  const running = exec.state === "running";
  const isError = exec.isError;
  const path = stringArg(exec.args, "path", "file_path", "filePath");
  const offset = numberArg(exec.args, "offset");
  const limit = numberArg(exec.args, "limit");
  const [cwd, setCwdState] = useState<string | null>(getPiCwd);
  useEffect(() => onPiCwdChange(() => setCwdState(getPiCwd())), []);
  const display = relativeToCwd(path, cwd) ?? path;
  const parts = useMemo(() => splitPath(display), [display]);
  const range = rangeLabel(offset, limit);

  const view = useMemo(() => readView(running ? "" : exec.resultText, offset), [running, exec.resultText, offset]);
  const lines = useMemo(() => (view.code === "" ? [] : view.code.split("\n")), [view.code]);
  const lang = useMemo(() => langForPath(path), [path]);
  const bytes = useMemo(() => new TextEncoder().encode(view.code).byteLength, [view.code]);
  // The text tail is a wire format; the validated details are the fallback.
  const note =
    view.note ??
    (exec.truncation
      ? `输出已截断：最近 ${exec.truncation.outputLines} 行 / 共 ${exec.truncation.totalLines} 行`
      : undefined);
  // Image reads answer with a text note plus the image: the note is not code.
  const imageNote = exec.resultImages.length > 0 && !running ? exec.resultText.replace(/\n+$/, "") : "";

  const body = isError ? (
    <div class="read-error">{exec.resultText}</div>
  ) : running ? (
    <div class="read-empty">读取中…</div>
  ) : (
    <>
      {exec.resultImages.map((img, i) => (
        <img key={i} class="read-image" src={`data:${img.mimeType};base64,${img.data}`} alt={display} />
      ))}
      {imageNote ? <div class="read-note">{imageNote}</div> : null}
      {lines.length > 0 ? (
        <div class="read-code">
          {lines.map((line, i) => (
            <div key={i} class="read-line">
              <span class="read-num">{view.startLine + i}</span>
              <span class="read-text" dangerouslySetInnerHTML={{ __html: lineHtml(line, lang, null, null) }} />
            </div>
          ))}
        </div>
      ) : imageNote ? null : (
        <div class="read-empty">（空文件）</div>
      )}
      {note ? <div class="read-note">{note}</div> : null}
      {path !== "" || view.code !== "" ? (
        <div class="read-foot">
          {path !== "" ? <CopyButton text={path} label="复制路径" /> : null}
          {view.code !== "" ? <CopyButton text={view.code} label="复制内容" /> : null}
          {lines.length > 0 ? (
            <span class="read-meta">
              {lines.length} 行 · {formatBytes(bytes)}
            </span>
          ) : null}
        </div>
      ) : null}
    </>
  );

  return (
    <ToolFrame
      id={exec.toolCallId}
      running={running}
      failed={isError}
      durationMs={exec.durationMs}
      label={<IconRead size={13} />}
      title={
        path !== "" ? (
          <PathLabel dir={parts.dir} name={parts.name} title={path} />
        ) : (
          <span class="file-path">
            <span class="file-name">{exec.toolName || "read"}</span>
          </span>
        )
      }
      meta={range !== "" ? <span class="frame-meta">{range}</span> : null}
      openByDefault={exec.resultImages.length > 0}
    >
      {body}
    </ToolFrame>
  );
}