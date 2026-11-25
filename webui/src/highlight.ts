// Syntax highlighting for code lines (hljs common languages). Language comes
// from the file extension; every line is highlighted on its own, because the
// cards render line by line for numbering and word-level change highlight.
import hljs from "highlight.js/lib/common";
import type { WordSeg } from "./diff-engine";

const EXT_LANG: Record<string, string> = {
  ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  py: "python", rb: "ruby", rs: "rust", go: "go", java: "java", kt: "kotlin",
  swift: "swift", php: "php", c: "c", h: "c", cpp: "cpp", cc: "cpp", hpp: "cpp",
  cs: "csharp", css: "css", scss: "scss", less: "less", html: "xml", htm: "xml",
  vue: "xml", svg: "xml", xml: "xml", json: "json", jsonc: "json", md: "markdown",
  markdown: "markdown", mdown: "markdown", mkd: "markdown", mdx: "markdown",
  yml: "yaml", yaml: "yaml", toml: "ini", ini: "ini", cfg: "ini", sh: "bash",
  bash: "bash", zsh: "bash", bat: "dos", ps1: "powershell", sql: "sql",
  lua: "lua", pl: "perl", dart: "dart", ex: "elixir", exs: "elixir",
};

export function langForPath(path: string): string | undefined {
  const index = path.lastIndexOf(".");
  if (index === -1) return undefined;
  const lang = EXT_LANG[path.slice(index + 1).toLowerCase()];
  return lang !== undefined && hljs.getLanguage(lang) !== undefined ? lang : undefined;
}

const hlCache = new Map<string, string>();

/** hljs HTML for one line; empty when there is no language (caller escapes). */
function highlightLine(text: string, lang: string | undefined): string {
  if (!lang) return "";
  const key = `${lang}\u0000${text}`;
  const cached = hlCache.get(key);
  if (cached !== undefined) return cached;
  let html = "";
  try {
    html = hljs.highlight(text, { language: lang, ignoreIllegals: true }).value;
  } catch {
    html = "";
  }
  if (hlCache.size >= 1000) {
    const first = hlCache.keys().next().value;
    if (first !== undefined) hlCache.delete(first);
  }
  hlCache.set(key, html);
  return html;
}

function escapeHtml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** One highlighted run with its ancestor hljs class chain. */
type HlToken = { text: string; chain: string[] };

/** A run of a line with a class applied to it: a word change or a search hit. */
export type LineRun = { text: string; cls: string | null };

/** Flatten hljs HTML into text runs tagged with their class chains. */
function tokenizeHl(html: string): HlToken[] {
  // Wrapped in a container: HTML parsing drops whitespace-only text nodes at
  // the start/end of <body>, which would desync the token stream from the
  // plain-text line the word segments are aligned against.
  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, "text/html");
  const root = doc.body.firstChild as Element; // the wrapping div
  const tokens: HlToken[] = [];
  const walk = (parent: Element, chain: string[]): void => {
    for (const child of [...parent.childNodes]) {
      if (child.nodeType === 3) {
        const text = child as Text; // nodeType 3 narrows nothing in TS; safe here
        if (text.data) tokens.push({ text: text.data, chain });
      } else if (child.nodeType === 1) {
        const el = child as Element;
        walk(el, [...chain, el.getAttribute("class") ?? ""]);
      }
    }
  };
  walk(root, []);
  return tokens;
}

/**
 * Render a line: syntax classes from hljs tokens, with the given runs (word
 * changes, search hits) overlaid as spans that reopen the syntax classes
 * inside. Runs cover the whole line, so tokens and runs advance in lockstep;
 * an empty list means no overlay.
 */
export function markedLineHtml(text: string, lang: string | undefined, runs: LineRun[]): string {
  const hl = highlightLine(text, lang);
  const tokens: HlToken[] = hl !== "" ? tokenizeHl(hl) : [{ text, chain: [] }];
  const emit = (chunk: string, chain: string[], cls: string | null): string => {
    let inner = escapeHtml(chunk);
    for (let i = chain.length - 1; i >= 0; i--) inner = `<span class="${chain[i]!}">${inner}</span>`;
    return cls === null ? inner : `<span class="${cls}">${inner}</span>`;
  };
  if (runs.length === 0) return tokens.map((token) => emit(token.text, token.chain, null)).join("");
  let out = "";
  let tokenIndex = 0;
  let tokenOffset = 0;
  let runIndex = 0;
  let runOffset = 0;
  while (tokenIndex < tokens.length) {
    const token = tokens[tokenIndex]!;
    const run = runs[runIndex]!;
    const available = Math.min(token.text.length - tokenOffset, run.text.length - runOffset);
    out += emit(token.text.slice(tokenOffset, tokenOffset + available), token.chain, run.cls);
    tokenOffset += available;
    runOffset += available;
    if (tokenOffset >= token.text.length) {
      tokenIndex++;
      tokenOffset = 0;
    }
    if (runOffset >= run.text.length) {
      runIndex++;
      runOffset = 0;
    }
  }
  return out;
}

/** Render a diff line: word-level change runs inside the syntax colours. */
export function lineHtml(text: string, lang: string | undefined, segs: WordSeg[] | null, segKind: "add" | "del" | null): string {
  const runs = segs === null ? [] : segs.map((seg) => ({ text: seg.text, cls: seg.changed ? `diff-word ${segKind}` : null }));
  return markedLineHtml(text, lang, runs);
}