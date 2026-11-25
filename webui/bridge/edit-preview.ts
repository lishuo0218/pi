// Edit preview: compute a pi-format display diff for a pending edit tool call
// from its arguments, so the web UI can show the diff while the tool runs.
// The authoritative diff still arrives with tool_execution_end; this only
// mirrors what pi's TUI renders as a call preview. Reads files relative to
// the current pi working directory.
import { readFile } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { isAbsolute, join } from "node:path";
import { formatLineDiff } from "../src/diff-engine.ts";

export type EditPreviewResponse = { diff?: string; error?: string };

type ParsedRequest = { path: string; edits: { oldText: string; newText: string }[] };

/** Validate wire input from the browser page; returns null when malformed. */
function parseRequest(body: unknown): ParsedRequest | null {
  const req = body as { path?: unknown; edits?: unknown; oldText?: unknown; newText?: unknown };
  if (!req || typeof req.path !== "string" || !req.path) return null;
  const edits: { oldText: string; newText: string }[] = [];
  if (Array.isArray(req.edits)) {
    for (const entry of req.edits) {
      const edit = entry as { oldText?: unknown; newText?: unknown };
      if (typeof edit?.oldText === "string" && typeof edit?.newText === "string") {
        edits.push({ oldText: edit.oldText, newText: edit.newText });
      }
    }
  } else if (typeof req.oldText === "string" && typeof req.newText === "string") {
    edits.push({ oldText: req.oldText, newText: req.newText });
  }
  if (edits.length === 0) return null;
  return { path: req.path, edits };
}

function normalizeToLF(text: string): string {
  return text.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** pi's trailing-whitespace fuzzy fallback, the most common fuzzy case. */
function stripTrailingWhitespace(text: string): string {
  return text
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n");
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/** Line start that contains offset (0 when offset is 0). */
function lineStartBefore(text: string, offset: number): number {
  return offset === 0 ? 0 : text.lastIndexOf("\n", offset - 1) + 1;
}

/**
 * Widen a match to whole lines, as pi does for fuzzy replacements: unchanged
 * lines keep their original text, so a whitespace-normalized match is applied
 * against line boundaries instead of mid-line.
 */
function widenToLines(text: string, index: number, length: number): { start: number; end: number } {
  const start = lineStartBefore(text, index);
  let end = index + length;
  while (end < text.length && text[end] !== "\n") end++;
  if (end < text.length) end++; // include the line's LF
  return { start, end };
}

export async function handleEditPreview(body: unknown, cwd: string): Promise<EditPreviewResponse> {
  const req = parseRequest(body);
  if (!req) return { error: "invalid request: need path and edits (or oldText/newText)" };

  const abs = isAbsolute(req.path) ? req.path : join(cwd, req.path);
  let raw: string;
  try {
    raw = await readFile(abs, "utf-8");
  } catch {
    return { error: `cannot read ${req.path}` };
  }
  const content = normalizeToLF(stripBom(raw));

  // Match every edit against the same original content (pi semantics): exact
  // first for all, then the whole call retried on the whitespace-stripped base.
  const match = (base: string): { start: number; end: number; newText: string }[] => {
    const matches: { start: number; end: number; newText: string }[] = [];
    for (const edit of req.edits) {
      // In the fuzzy round the needle is normalized the same way as the base.
      const needle = base === content ? edit.oldText : stripTrailingWhitespace(edit.oldText);
      if (countOccurrences(base, needle) !== 1) return [];
      const index = base.indexOf(needle);
      const widened =
        base === content ? { start: index, end: index + needle.length } : widenToLines(base, index, needle.length);
      matches.push({ ...widened, newText: edit.newText });
    }
    return matches;
  };
  let ranges = match(content);
  let base = content;
  if (ranges.length !== req.edits.length) {
    base = stripTrailingWhitespace(content);
    ranges = match(base);
    if (ranges.length !== req.edits.length) return { error: "oldText not found or not unique" };
  }

  ranges.sort((a, b) => a.start - b.start);
  for (let i = 1; i < ranges.length; i++) {
    if (ranges[i - 1]!.end > ranges[i]!.start) return { error: "edits overlap" };
  }
  let newContent = base;
  for (let i = ranges.length - 1; i >= 0; i--) {
    const range = ranges[i]!;
    newContent = newContent.slice(0, range.start) + range.newText + newContent.slice(range.end);
  }
  return { diff: formatLineDiff(base, newContent, 4) };
}

/** Read a JSON request body with a size cap; rejects on overrun or bad JSON. */
export function readJsonBody(req: IncomingMessage, limitBytes: number): Promise<unknown> {
  return new Promise((resolvePromise, rejectPromise) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limitBytes) {
        rejectPromise(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolvePromise(JSON.parse(Buffer.concat(chunks).toString("utf-8")));
      } catch (error) {
        rejectPromise(error instanceof Error ? error : new Error("invalid JSON"));
      }
    });
    req.on("error", rejectPromise);
  });
}
