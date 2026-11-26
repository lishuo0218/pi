// Tool execution card (F-12): three states running/done/error. Read-only
// tools get their own cards (grep/find/ls: raw list), as do edit (diff) and
// bash (terminal); read renders nothing, the message list drops it. The generic
// card keeps tool name plus a short arg summary, the result text and any result
// images.
import { useEffect, useRef, useState } from "preact/hooks";
import type { JSX } from "preact";
import type { ToolExecution } from "./tool-store";
import { getDiffLayout, onDiffLayoutChange, setDiffLayout, type DiffLayout } from "./diff-layout";
import { IconColumns } from "./icons";
import { EditCard } from "./edit-card";
import { BashCard, bashRunFromExec } from "./bash-card";
import { AskCard } from "./ask-card";
import { TodoCard } from "./todo-card";
import { ListCard } from "./list-card";
import { toolPathArg } from "./path-label";

/** One-line human summary of the tool call from its args. */
export function toolSummary(exec: ToolExecution): string {
  const args = exec.args as Record<string, unknown>;
  const command = args.command;
  if (typeof command === "string") return command.replace(/\s+/g, " ").slice(0, 120);
  const path = toolPathArg(args);
  if (path !== null) return path.slice(0, 120);
  const keys = Object.keys(args);
  if (keys.length === 0) return "";
  return JSON.stringify(args).slice(0, 100);
}

function DiffView({ diff }: { diff: string }): JSX.Element {
  const lines = diff.split("\n");
  return (
    <pre class="tool-diff">
      {lines.map((line, i) => {
        const cls = line.startsWith("+")
          ? "add"
          : line.startsWith("-")
            ? "del"
            : /^@@|^\d+\s*[|]/.test(line)
              ? "hunk"
              : "";
        return (
          <div key={i} class={`diff-line ${cls}`}>
            {line}
          </div>
        );
      })}
    </pre>
  );
}

/** One side of a split row: numbered line content, or null when absent. */
type DiffSide = { num: string; text: string } | null;

/** A skip-marker row spans both columns; other rows hold old left / new right. */
type SplitRow = { kind: "skip" } | { kind: "pair"; left: DiffSide; right: DiffSide };

/** `+12 foo` / `-12 foo` / `  8 foo`: sign char, padded number, one space, content. */
function parseSide(line: string): { sign: string; side: DiffSide } {
  const sign = line[0] ?? " ";
  const rest = line.slice(1);
  const match = /^ *(\d+) (.*)$/.exec(rest);
  return { sign, side: match ? { num: match[1]!, text: match[2] ?? "" } : { num: "", text: rest } };
}

/**
 * Parse pi's display diff (sign + line number + content per line) into
 * strictly aligned split rows: consecutive -/+ runs pair index by index,
 * the surplus side keeps an empty placeholder so line numbers stay level.
 */
function parseSplitRows(diff: string): SplitRow[] {
  const rows: SplitRow[] = [];
  let dels: DiffSide[] = [];
  let adds: DiffSide[] = [];
  const flush = (): void => {
    if (dels.length === 0 && adds.length === 0) return;
    const pairs = Math.min(dels.length, adds.length);
    for (let i = 0; i < pairs; i++) rows.push({ kind: "pair", left: dels[i]!, right: adds[i]! });
    for (let i = pairs; i < dels.length; i++) rows.push({ kind: "pair", left: dels[i]!, right: null });
    for (let i = pairs; i < adds.length; i++) rows.push({ kind: "pair", left: null, right: adds[i]! });
    dels = [];
    adds = [];
  };
  const lines = diff.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (i === lines.length - 1 && line === "") continue; // trailing-newline artifact
    if (/^ *\.{3} ?$/.test(line)) {
      flush();
      rows.push({ kind: "skip" });
      continue;
    }
    const { sign, side } = parseSide(line);
    if (sign === "-") {
      if (adds.length > 0) flush();
      dels.push(side);
    } else if (sign === "+") {
      adds.push(side);
    } else {
      flush();
      rows.push({ kind: "pair", left: side, right: side });
    }
  }
  flush();
  return rows;
}

/** Split layout: old content left, new content right, rows kept level. */
function SplitDiffView({ diff }: { diff: string }): JSX.Element {
  const rows = parseSplitRows(diff);
  // Last cell we scrolled programmatically. Its following scroll event is a
  // consequence of our own set, not user input, so it is ignored to prevent
  // feedback clamping the source column back down to the partner's max.
  const programmatic = useRef<HTMLDivElement | null>(null);
  const onScroll = (e: JSX.TargetedEvent<HTMLDivElement>): void => {
    const cell = e.currentTarget as HTMLDivElement;
    if (programmatic.current === cell) {
      programmatic.current = null;
      return;
    }
    const row = cell.parentElement;
    if (!row) return;
    const partner =
      [...row.querySelectorAll<HTMLDivElement>(".diff-cell")].find((c) => c !== cell) ?? null;
    if (!partner) return;
    programmatic.current = partner;
    partner.scrollLeft = Math.min(cell.scrollLeft, partner.scrollWidth - partner.clientWidth);
  };
  return (
    <div class="tool-diff split">
      {rows.map((row, i) =>
        row.kind === "skip" ? (
          <div key={i} class="diff-skip">
            ⋯
          </div>
        ) : (
          <div key={i} class="diff-row">
            <div class={`diff-cell ${row.left ? (row.right ? "chg" : "del") : "empty"}`} onScroll={onScroll}>
              {row.left ? (
                <>
                  <span class="diff-num">{row.left.num}</span>
                  {row.left.text}
                </>
              ) : null}
            </div>
            <div class={`diff-cell ${row.right ? (row.left ? "chg" : "add") : "empty"}`} onScroll={onScroll}>
              {row.right ? (
                <>
                  <span class="diff-num">{row.right.num}</span>
                  {row.right.text}
                </>
              ) : null}
            </div>
          </div>
        ),
      )}
    </div>
  );
}

function OutputBlock({
  text,
  isError,
}: {
  text: string;
  isError: boolean;
}): JSX.Element | null {
  const [expanded, setExpanded] = useState(false);
  if (!text) return null;
  const lines = text.split("\n");
  const long = lines.length > 20;
  const shown = expanded || !long ? text : lines.slice(0, 20).join("\n");
  return (
    <div>
      <pre class={`tool-output${isError ? " err" : ""}`}>{shown}</pre>
      {long ? (
        <button class="tool-more" onClick={() => setExpanded(!expanded)}>
          {expanded ? "收起" : `展开全部 ${lines.length} 行`}
        </button>
      ) : null}
    </div>
  );
}

export function ToolCard({ exec }: { exec: ToolExecution }): JSX.Element {
  // Specialized cards first; everything else the generic card.
  if (exec.toolName === "edit") return <EditCard exec={exec} />;
  if (exec.toolName === "bash") {
    return <BashCard run={bashRunFromExec(exec)} behavior={{ kind: "stream" }} />;
  }
  if (exec.toolName === "ask_user") return <AskCard exec={exec} />;
  if (exec.toolName === "todo") return <TodoCard exec={exec} />;
  if (exec.toolName === "grep" || exec.toolName === "find" || exec.toolName === "ls") {
    return <ListCard exec={exec} />;
  }
  const running = exec.state === "running";
  const summary = toolSummary(exec);
  // Global layout preference; the toggle flips it for every open card.
  const [layout, setLayoutState] = useState<DiffLayout>(getDiffLayout);
  useEffect(() => onDiffLayoutChange(() => setLayoutState(getDiffLayout())), []);
  return (
    <div class={`tool-card ${running ? "running" : exec.isError ? "error" : "done"}`}>
      <div class="tool-head">
        {running ? <span class="spinner" /> : null}
        <span class="tool-name">{exec.toolName || "tool"}</span>
        {summary ? <span class="tool-summary">{summary}</span> : null}
        {exec.durationMs != null && !running ? (
          <span class="tool-duration">{(exec.durationMs / 1000).toFixed(1)}s</span>
        ) : null}
        {exec.diff ? (
          <button
            class="diff-toggle"
            title={layout === "split" ? "切换为单栏对比" : "切换为双栏对比"}
            onClick={() => setDiffLayout(layout === "split" ? "unified" : "split")}
          >
            <IconColumns size={12} />
            {layout === "split" ? "双栏" : "单栏"}
          </button>
        ) : null}
      </div>
      {exec.diff ? layout === "split" ? <SplitDiffView diff={exec.diff} /> : <DiffView diff={exec.diff} /> : null}
      {!running ? (
        <OutputBlock text={exec.resultText} isError={exec.isError} />
      ) : null}
      {exec.resultImages.map((img, i) => (
        <img
          key={i}
          class="tool-image"
          src={`data:${img.mimeType};base64,${img.data}`}
          alt="tool result"
        />
      ))}
    </div>
  );
}
