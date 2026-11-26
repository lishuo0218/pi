// Edit tool card: collapsed-bar style (类 Claude.ai). Expanded by default, one
// bar with status, file path, +N −M stats and the layout toggle above the diff
// (per-line syntax highlight, word-level change highlight); a user's collapse is
// remembered per card for its lifetime. While the tool runs (or while its
// arguments still stream), the bridge computes a preview diff from the call args
// and the card shows it as-is; when that preview is unavailable the card falls
// back to a diff of the call's own texts, marked as an estimate. The
// authoritative result diff replaces it seamlessly.
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { JSX } from "preact";
import type { ToolExecution } from "./tool-store";
import { getDiffLayout, onDiffLayoutChange, setDiffLayout, type DiffLayout } from "./diff-layout";
import { getPiCwd, onPiCwdChange } from "./pi-cwd";
import { diffWords, formatLineDiff, type WordSeg } from "./diff-engine";
import { langForPath, lineHtml } from "./highlight";
import { PathLabel, relativeToCwd, splitPath, toolPathArg } from "./path-label";
import { IconColumns, IconEdit, IconEye } from "./icons";
import { Collapse } from "./collapse";
import { openPreview } from "./preview-target";

type Row =
  | { kind: "skip" }
  | { kind: "ctx"; num: string; text: string }
  | { kind: "del"; num: string; text: string }
  | { kind: "add"; num: string; text: string };

type CtxRow = Extract<Row, { kind: "ctx" }>;
type DelRow = Extract<Row, { kind: "del" }>;
type AddRow = Extract<Row, { kind: "add" }>;

type Group =
  | { kind: "skip" }
  | { kind: "ctx"; row: CtxRow }
  | { kind: "pair"; del: DelRow; add: AddRow }
  | { kind: "del"; row: DelRow }
  | { kind: "add"; row: AddRow };

/** Parse pi's display diff (sign + padded line number + content) into rows. */
export function parseRows(diff: string): Row[] {
  const rows: Row[] = [];
  for (const line of diff.split("\n")) {
    if (line === "") continue; // trailing-newline artifact
    if (/^ *\.\.\. *$/.test(line)) {
      rows.push({ kind: "skip" });
      continue;
    }
    const sign = line[0] ?? " ";
    const rest = line.slice(1);
    const match = /^ *(\d+) (.*)$/.exec(rest);
    const num = match ? match[1]! : "";
    const text = match ? match[2]! : rest;
    const kind = sign === "+" ? "add" : sign === "-" ? "del" : "ctx";
    rows.push({ kind, num, text });
  }
  return rows;
}

/**
 * Pair consecutive del/add runs index by index so word highlight has a
 * counterpart; surplus rows stay single. Skip rows surface as-is.
 */
export function pairRows(rows: Row[]): Group[] {
  const groups: Group[] = [];
  let dels: DelRow[] = [];
  let adds: AddRow[] = [];
  const flush = (): void => {
    const pairs = Math.min(dels.length, adds.length);
    for (let i = 0; i < pairs; i++) groups.push({ kind: "pair", del: dels[i]!, add: adds[i]! });
    for (let i = pairs; i < dels.length; i++) groups.push({ kind: "del", row: dels[i]! });
    for (let i = pairs; i < adds.length; i++) groups.push({ kind: "add", row: adds[i]! });
    dels = [];
    adds = [];
  };
  for (const row of rows) {
    if (row.kind === "del") {
      if (adds.length > 0) flush();
      dels.push(row);
    } else if (row.kind === "add") {
      adds.push(row);
    } else if (row.kind === "skip") {
      flush();
      groups.push({ kind: "skip" });
    } else {
      flush();
      groups.push({ kind: "ctx", row });
    }
  }
  flush();
  return groups;
}

/** Cards the user explicitly collapsed stay collapsed across state updates. */
const collapsedIds = new Set<string>();

/** One in-flight preview per running edit; survives card remounts. */
const previewCache = new Map<string, Promise<string | undefined>>();

type PreviewRequest = { path: string; edits: { oldText: string; newText: string }[] };

/** Extract the preview request from edit args (wire input; validated). */
function previewRequest(args: Record<string, unknown>): PreviewRequest | null {
  const path = args.path ?? args.file_path ?? args.filePath;
  if (typeof path !== "string" || !path) return null;
  const edits: { oldText: string; newText: string }[] = [];
  if (Array.isArray(args.edits)) {
    for (const entry of args.edits) {
      const edit = entry as { oldText?: unknown; newText?: unknown };
      if (typeof edit?.oldText === "string" && typeof edit?.newText === "string") {
        edits.push({ oldText: edit.oldText, newText: edit.newText });
      }
    }
  } else if (typeof args.oldText === "string" && typeof args.newText === "string") {
    edits.push({ oldText: args.oldText, newText: args.newText });
  }
  if (edits.length === 0) return null;
  return { path, edits };
}

function fetchPreview(request: PreviewRequest): Promise<string | undefined> {
  return fetch("/api/edit-preview", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
  })
    .then((res) => (res.ok ? (res.json() as Promise<{ diff?: string }>) : Promise.resolve(null)))
    .then((data) => (data !== null && typeof data.diff === "string" ? data.diff : undefined))
    .catch(() => undefined);
}

function getPreview(toolCallId: string, request: PreviewRequest): Promise<string | undefined> {
  let promise = previewCache.get(toolCallId);
  if (!promise) {
    promise = fetchPreview(request);
    previewCache.set(toolCallId, promise);
    while (previewCache.size > 50) {
      const first = previewCache.keys().next().value;
      if (first === undefined) break;
      previewCache.delete(first);
    }
  }
  return promise;
}

/**
 * Diff of the call's own texts, for when the file preview cannot be read (the
 * bridge may be older than the endpoint). Line numbers are relative to the
 * fragments, so the card marks these stats as an estimate.
 */
function argsDiff(request: PreviewRequest): string {
  const oldText = request.edits.map((edit) => edit.oldText).join("\n");
  const newText = request.edits.map((edit) => edit.newText).join("\n");
  return formatLineDiff(oldText, newText, 2);
}

function DiffLine({ kind, num, html }: { kind: "ctx" | "del" | "add"; num: string; html: string }): JSX.Element {
  return (
    <div class={`diff-line ${kind}`}>
      <span class="diff-num">{num}</span>
      <span class="diff-code" dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
}

function UnifiedView({
  groups,
  lang,
  wordSegs,
  scrollRef,
}: {
  groups: Group[];
  lang: string | undefined;
  wordSegs: Map<Row, [WordSeg[], WordSeg[]] | null>;
  scrollRef: (el: HTMLDivElement | null) => void;
}): JSX.Element {
  return (
    <div class="edit-diff" ref={scrollRef}>
      {groups.map((group, i) => {
        if (group.kind === "skip") return <div key={i} class="diff-skip">⋯</div>;
        if (group.kind === "ctx") {
          return <DiffLine key={i} kind="ctx" num={group.row.num} html={lineHtml(group.row.text, lang, null, null)} />;
        }
        if (group.kind === "del") {
          return <DiffLine key={`${i}d`} kind="del" num={group.row.num} html={lineHtml(group.row.text, lang, null, null)} />;
        }
        if (group.kind === "add") {
          return <DiffLine key={`${i}a`} kind="add" num={group.row.num} html={lineHtml(group.row.text, lang, null, null)} />;
        }
        const segs = wordSegs.get(group.del) ?? null;
        return [
          <DiffLine key={`${i}d`} kind="del" num={group.del.num} html={lineHtml(group.del.text, lang, segs?.[0] ?? null, "del")} />,
          <DiffLine key={`${i}a`} kind="add" num={group.add.num} html={lineHtml(group.add.text, lang, segs?.[1] ?? null, "add")} />,
        ];
      })}
    </div>
  );
}

/** Horizontal scroll of one side follows the other (kept within its max). */
function syncScroll(e: JSX.TargetedEvent<HTMLDivElement>): void {
  const cell = e.currentTarget as HTMLDivElement;
  const row = cell.parentElement;
  if (!row) return;
  const partner = [...row.querySelectorAll<HTMLDivElement>(".edit-cell")].find((c) => c !== cell);
  if (partner) partner.scrollLeft = Math.min(cell.scrollLeft, partner.scrollWidth - partner.clientWidth);
}

function SplitView({
  groups,
  lang,
  wordSegs,
  scrollRef,
}: {
  groups: Group[];
  lang: string | undefined;
  wordSegs: Map<Row, [WordSeg[], WordSeg[]] | null>;
  scrollRef: (el: HTMLDivElement | null) => void;
}): JSX.Element {
  // The display diff numbers context rows on the old side only; the right
  // cell needs the new-side number = old number + net lines added so far.
  // A skip hides equal numbers of old and new lines, so it leaves shift alone.
  const rowsRendered: JSX.Element[] = [];
  let shift = 0;
  for (let i = 0; i < groups.length; i++) {
    const group = groups[i]!;
    if (group.kind === "skip") {
      rowsRendered.push(<div key={i} class="diff-skip">⋯</div>);
      continue;
    }
    if (group.kind === "ctx") {
      const html = lineHtml(group.row.text, lang, null, null);
      rowsRendered.push(
        <div key={i} class="edit-split-row">
          <div class="edit-cell" onScroll={syncScroll}>
            <DiffLine kind="ctx" num={group.row.num} html={html} />
          </div>
          <div class="edit-cell" onScroll={syncScroll}>
            <DiffLine kind="ctx" num={String(Number(group.row.num) + shift)} html={html} />
          </div>
        </div>,
      );
      continue;
    }
    if (group.kind === "del") {
      const html = lineHtml(group.row.text, lang, null, null);
      rowsRendered.push(
        <div key={i} class="edit-split-row">
          <div class="edit-cell" onScroll={syncScroll}>
            <DiffLine kind="del" num={group.row.num} html={html} />
          </div>
          <div class="edit-cell empty" />
        </div>,
      );
      shift--;
      continue;
    }
    if (group.kind === "add") {
      const html = lineHtml(group.row.text, lang, null, null);
      rowsRendered.push(
        <div key={i} class="edit-split-row">
          <div class="edit-cell empty" />
          <div class="edit-cell" onScroll={syncScroll}>
            <DiffLine kind="add" num={group.row.num} html={html} />
          </div>
        </div>,
      );
      shift++;
      continue;
    }
    const segs = wordSegs.get(group.del) ?? null;
    rowsRendered.push(
      <div key={i} class="edit-split-row">
        <div class="edit-cell" onScroll={syncScroll}>
          <DiffLine kind="del" num={group.del.num} html={lineHtml(group.del.text, lang, segs?.[0] ?? null, "del")} />
        </div>
        <div class="edit-cell" onScroll={syncScroll}>
          <DiffLine kind="add" num={group.add.num} html={lineHtml(group.add.text, lang, segs?.[1] ?? null, "add")} />
        </div>
      </div>,
    );
  }
  return (
    <div class="edit-diff split" ref={scrollRef}>
      {rowsRendered}
    </div>
  );
}

export function EditCard({ exec }: { exec: ToolExecution }): JSX.Element {
  const running = exec.state === "running";
  const isError = exec.isError;
  const [open, setOpen] = useState(() => !collapsedIds.has(exec.toolCallId));
  const [layout, setLayoutState] = useState<DiffLayout>(getDiffLayout);
  useEffect(() => onDiffLayoutChange(() => setLayoutState(getDiffLayout())), []);

  const [preview, setPreview] = useState<string | undefined>(undefined);
  const [estimated, setEstimated] = useState(false);
  // Complete args only: an edit preview needs the path and every old/new text.
  const request = useMemo(() => previewRequest(exec.args), [exec.args]);
  useEffect(() => {
    if (!running || exec.diff !== undefined || request === null) return;
    // Same toolCallId may remount (message re-render); the cache reuses the fetch.
    void getPreview(exec.toolCallId, request).then((diff) => {
      if (diff !== undefined) {
        setPreview(diff);
        setEstimated(false);
        return;
      }
      setPreview(argsDiff(request));
      setEstimated(true);
    });
  }, [running, exec.diff, request, exec.toolCallId]);

  const diff = exec.diff ?? (running ? preview : undefined);
  const rows = useMemo(() => (diff !== undefined ? parseRows(diff) : []), [diff]);
  const groups = useMemo(() => pairRows(rows), [rows]);
  const stats = useMemo(() => {
    let adds = 0;
    let dels = 0;
    for (const row of rows) {
      if (row.kind === "add") adds++;
      else if (row.kind === "del") dels++;
    }
    return { adds, dels };
  }, [rows]);
  const wordSegs = useMemo(() => {
    const map = new Map<Row, [WordSeg[], WordSeg[]] | null>();
    for (const group of groups) {
      if (group.kind === "pair") map.set(group.del, diffWords(group.del.text, group.add.text));
    }
    return map;
  }, [groups]);
  const [cwd, setCwdState] = useState<string | null>(getPiCwd);
  useEffect(() => onPiCwdChange(() => setCwdState(getPiCwd())), []);
  const meta = useMemo(() => {
    const raw = toolPathArg(exec.args) ?? "";
    const display = relativeToCwd(raw, cwd) ?? raw;
    return { lang: langForPath(raw), raw, ...splitPath(display) };
  }, [exec.args, cwd]);

  const diffRef = useRef<HTMLDivElement | null>(null);
  const scrolled = useRef(false); // first-change scroll already done for this opening
  const scrollToFirstChange = (): void => {
    const container = diffRef.current;
    if (!container) return;
    const target = container.querySelector(".diff-line.add, .diff-line.del");
    if (!target) return;
    const rect = target.getBoundingClientRect();
    const crect = container.getBoundingClientRect();
    container.scrollTop += rect.top - crect.top - 8;
  };
  const toggle = (): void => {
    const next = !open;
    setOpen(next);
    scrolled.current = !next;
    if (next) collapsedIds.delete(exec.toolCallId);
    else collapsedIds.add(exec.toolCallId);
  };
  // Default-open cards scroll once, when the diff area first exists.
  useEffect(() => {
    if (!open || scrolled.current || !diffRef.current) return;
    scrolled.current = true;
    requestAnimationFrame(scrollToFirstChange);
  });

  const toggleLayout = (e: JSX.TargetedEvent<HTMLButtonElement>): void => {
    e.stopPropagation();
    setDiffLayout(layout === "split" ? "unified" : "split");
  };

  return (
    <div class={`edit-card ${running ? "running" : isError ? "error" : "done"}${open ? " open" : ""}`}>
      <div class="edit-bar" onClick={toggle}>
        {running ? <span class="spinner" /> : null}
        <IconEdit size={13} />
        {meta.raw ? <PathLabel dir={meta.dir} name={meta.name} title={meta.raw} /> : (
          <span class="file-path">
            <span class="file-name">{exec.toolName || "edit"}</span>
          </span>
        )}
        {stats.adds + stats.dels > 0 ? (
          <span class="edit-stats">
            <span class="stat-add">+{stats.adds}</span>
            <span class="stat-del">−{stats.dels}</span>
          </span>
        ) : null}
        {running && estimated ? (
          <span class="edit-pending" title="文件预览不可用，按调用参数估算">
            预计
          </span>
        ) : null}
        {running && diff === undefined && request !== null ? <span class="edit-pending">预览计算中…</span> : null}
        {exec.durationMs != null && !running ? (
          <span class="tool-duration">{(exec.durationMs / 1000).toFixed(1)}s</span>
        ) : null}
        {meta.raw ? (
          <button
            class="edit-layout"
            title="预览该文件"
            onClick={(e) => {
              e.stopPropagation();
              openPreview(meta.raw);
            }}
          >
            <IconEye size={12} />
            预览
          </button>
        ) : null}
        {diff !== undefined ? (
          <button
            class="edit-layout"
            title={layout === "split" ? "切换为单栏对比" : "切换为双栏对比"}
            onClick={toggleLayout}
          >
            <IconColumns size={12} />
            {layout === "split" ? "双栏" : "单栏"}
          </button>
        ) : null}
      </div>
      {isError && exec.resultText ? <div class="edit-error">{exec.resultText}</div> : null}
      <Collapse open={open && diff !== undefined}>
        {diff === undefined ? null : layout === "split" ? (
          <SplitView groups={groups} lang={meta.lang} wordSegs={wordSegs} scrollRef={(el) => (diffRef.current = el)} />
        ) : (
          <UnifiedView groups={groups} lang={meta.lang} wordSegs={wordSegs} scrollRef={(el) => (diffRef.current = el)} />
        )}
      </Collapse>
    </div>
  );
}
