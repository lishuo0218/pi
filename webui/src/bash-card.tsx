// Bash card: the single display for every bash run in the UI (tool calls,
// bashExecution transcript rows, bash-panel history). Collapsed it is one bar
// (status, terminal icon, one-line command, failure badge, duration, copy
// buttons on hover) over the last few lines of output; expanded it is a
// terminal (prompt line, output tail, pi's truncation note). Colour stays grey
// except the prompt and the failure badge, which carry the shell's semantics.
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { JSX } from "preact";
import { IconTerminal } from "./icons";
import { CopyButton } from "./copy-button";
import { Collapse } from "./collapse";
import { fadeSwap } from "./fade-swap";
import type { BashExecutionMessage } from "./protocol";
import type { ToolExecution } from "./tool-store";

/** Lines kept in the expanded terminal before older output folds away. */
const TAIL_LINES = 500;

/** Lines kept under a collapsed card; pi's TUI keeps five. */
const PREVIEW_LINES = 5;

/** pi's truncation counts for the model-facing output (details.truncation). */
export type BashTruncation = { outputLines: number; totalLines: number };

/** One bash run, normalized across the three sources that render it. */
export type BashRun = {
  command: string;
  output: string;
  running: boolean;
  durationMs?: number;
  /** 0 on success, the shell's code on failure, undefined while unknown. */
  exitCode?: number;
  /** Failure without an exit code: 已取消 / 已超时 / 无退出码 / 执行失败. */
  status?: string;
  /** Output was cut by pi; transcript rows only carry the boolean. */
  truncated?: boolean;
  truncation?: BashTruncation;
  fullOutputPath?: string;
};

/**
 * How the card decides to open: `stream` opens while running and folds a
 * successful run when it ends; `pinned` opens new runs and otherwise follows
 * the user's own toggle (bash panel history).
 */
export type BashCardBehavior = { kind: "stream" } | { kind: "pinned" };

/** pi appends a status paragraph to a failing bash result; split it off. */
const STATUS_TAIL =
  /(?:^|\n\n)(Command (?:exited with code (\d+)|aborted|timed out[\s\S]*|terminated without an exit code))$/;

function splitStatus(text: string): { output: string; exitCode?: number; status?: string } {
  const match = STATUS_TAIL.exec(text);
  if (!match) return { output: text };
  const output = text.slice(0, match.index);
  if (match[2] !== undefined) return { output, exitCode: Number(match[2]) };
  const phrase = match[1]!;
  if (phrase === "Command aborted") return { output, status: "已取消" };
  if (phrase.startsWith("Command timed out")) return { output, status: "已超时" };
  return { output, status: "无退出码" };
}

/** Tool-call execution → run model; the failing status paragraph becomes a badge. */
export function bashRunFromExec(exec: ToolExecution): BashRun {
  const command = typeof exec.args.command === "string" ? exec.args.command : "";
  const running = exec.state === "running";
  const text = running ? exec.partial : exec.resultText;
  const split = !running && exec.isError ? splitStatus(text) : { output: text };
  return {
    command,
    output: split.output,
    running,
    durationMs: exec.durationMs,
    exitCode: running ? undefined : (split.exitCode ?? (exec.isError ? undefined : 0)),
    // A status line only when pi gave none: an exit code is a better badge than a word.
    status: split.status ?? (exec.isError && !running && split.exitCode === undefined ? "执行失败" : undefined),
    truncation: exec.truncation,
    fullOutputPath: exec.fullOutputPath,
  };
}

/** Transcript row (reloaded session or panel-run command) → run model. */
export function bashRunFromMessage(message: BashExecutionMessage): BashRun {
  return {
    command: message.command,
    output: message.output,
    running: false,
    exitCode: message.exitCode,
    status: message.cancelled ? "已取消" : undefined,
    truncated: message.truncated,
  };
}

/** Collapse whitespace so a multi-line command fits the one-line bar. */
function oneLine(command: string): string {
  return command.replace(/\s+/g, " ").trim();
}

/**
 * Last `limit` lines of a text block, with the count of lines left out and the
 * block's total. The trailing newline's empty segment is not a line.
 */
function lastLines(text: string, limit: number): { text: string; hidden: number; lines: number } {
  const lines = text.split("\n");
  const visible = lines.length - (text.endsWith("\n") ? 1 : 0);
  const hidden = Math.max(0, visible - limit);
  if (hidden === 0) return { text, hidden: 0, lines: visible };
  return { text: lines.slice(hidden).join("\n"), hidden, lines: visible };
}

export function BashCard({
  run,
  behavior,
}: {
  run: BashRun;
  behavior: BashCardBehavior;
}): JSX.Element {
  const failed = run.status !== undefined || (run.exitCode !== undefined && run.exitCode !== 0);
  const auto = behavior.kind === "pinned" ? true : run.running || failed;
  // null = follow the run state; a click pins the choice for this card.
  const [manual, setManual] = useState<boolean | null>(null);
  const open = manual ?? auto;
  const [showAll, setShowAll] = useState(false);
  const terminalRef = useRef<HTMLDivElement | null>(null);
  const commandLine = oneLine(run.command);

  // Follow the tail while the command streams.
  useEffect(() => {
    const el = terminalRef.current;
    if (el && run.running && open) el.scrollTop = el.scrollHeight;
  }, [run.output, run.running, open]);

  const output = useMemo(() => lastLines(run.output, showAll ? Infinity : TAIL_LINES), [run.output, showAll]);
  const preview = useMemo(() => lastLines(run.output, PREVIEW_LINES), [run.output]);

  return (
    <div class={`bash-card${open ? " open" : ""}${run.running ? " running" : ""}${failed ? " error" : ""}`}>
      <div class="bash-bar" onClick={() => setManual(!open)}>
        {run.running ? <span class="spinner" /> : null}
        <IconTerminal size={13} />
        <span class="bash-line" title={commandLine}>
          {commandLine || "bash"}
        </span>
        <span class="bash-end">
          {failed ? <span class="bash-exit">{run.status ?? `exit ${run.exitCode}`}</span> : null}
          {run.durationMs != null && !run.running ? (
            <span class="tool-duration">{(run.durationMs / 1000).toFixed(1)}s</span>
          ) : null}
        </span>
        {/* Hover only: the bar keeps its width for the command. */}
        <span class="bash-actions" onClick={(e) => e.stopPropagation()}>
          {run.command ? <CopyButton text={run.command} label="命令" /> : null}
          {run.output ? <CopyButton text={run.output} label="输出" /> : null}
        </span>
      </div>
      <Collapse open={open}>
        <div class="bash-terminal" ref={terminalRef}>
          {run.command ? (
            <div class="bash-cmd">
              <span class="bash-prompt">❯</span>
              <pre class="bash-command">{run.command}</pre>
            </div>
          ) : null}
          {output.hidden > 0 ? (
            <button class="bash-more" onClick={() => fadeSwap(terminalRef.current, () => setShowAll(true))}>
              ⋯ 前 {output.hidden} 行
            </button>
          ) : null}
          {output.text ? (
            <pre class="bash-output">{output.text}</pre>
          ) : (
            <div class="bash-empty">{run.running ? "等待输出…" : "（无输出）"}</div>
          )}
          {run.truncation || run.truncated ? (
            <div class="bash-note">
              {run.truncation
                ? `输出已截断：最近 ${run.truncation.outputLines} 行 / 共 ${run.truncation.totalLines} 行`
                : "输出已截断"}
              {run.fullOutputPath ? ` · 完整输出：${run.fullOutputPath}` : ""}
            </div>
          ) : null}
        </div>
      </Collapse>
      <Collapse open={!open && preview.lines > 0}>
        <div class="bash-preview" onClick={() => setManual(true)}>
          <pre class="bash-output">{preview.text}</pre>
          {preview.hidden > 0 ? <div class="bash-more-line">⋯ 前 {preview.hidden} 行</div> : null}
        </div>
      </Collapse>
    </div>
  );
}