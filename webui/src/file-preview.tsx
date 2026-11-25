// The right panel while a file is open: the file head with a way back to the
// file tree, the body (code viewer, image, or a note) and a footer with size and
// truncation. Text arrives capped at 1 MB from /api/file-preview; the viewer
// virtualizes rows, so the line count is not limited.
import { useEffect, useMemo, useState } from "preact/hooks";
import type { JSX } from "preact";
import { CodeViewer } from "./code-viewer";
import { CopyButton } from "./copy-button";
import { FileIcon } from "./file-icon";
import { langForPath } from "./highlight";
import { renderMarkdownFile } from "./markdown";
import { MarkdownPreview } from "./markdown-preview";
import { PathLabel, joinPath, relativeToCwd, splitPath } from "./path-label";
import { getPiCwd, onPiCwdChange } from "./pi-cwd";
import { openPreview, type PreviewRequest } from "./preview-target";
import type { Theme } from "./theme";

type Truncation = "bytes" | null;

type Preview =
  | { kind: "text"; text: string; size: number; truncated: Truncation }
  | { kind: "image"; mimeType: string; data: string; size: number }
  | { kind: "binary"; size: number }
  | { kind: "error"; error: string };

/** Wire input from /api/file-preview, so the shape is checked before use. */
function asPreview(value: unknown): Preview {
  const data = value as Record<string, unknown> | null;
  const size = data?.size;
  switch (data?.kind) {
    case "text":
      return typeof data.text === "string" && typeof size === "number"
        ? { kind: "text", text: data.text, size, truncated: data.truncated === "bytes" ? "bytes" : null }
        : { kind: "error", error: "无法读取文件内容" };
    case "image":
      return typeof data.mimeType === "string" && typeof data.data === "string" && typeof size === "number"
        ? { kind: "image", mimeType: data.mimeType, data: data.data, size }
        : { kind: "error", error: "无法读取图片" };
    case "binary":
      return typeof size === "number" ? { kind: "binary", size } : { kind: "error", error: "无法读取文件" };
    case "error":
      return typeof data.error === "string" ? { kind: "error", error: data.error } : { kind: "error", error: "无法读取文件" };
    default:
      return { kind: "error", error: "无法识别的预览响应" };
  }
}

async function readPreview(path: string): Promise<Preview> {
  try {
    const res = await fetch("/api/file-preview", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path }),
    });
    if (!res.ok) return { kind: "error", error: `无法读取文件（${res.status}）` };
    return asPreview(await res.json());
  } catch (error) {
    return { kind: "error", error: error instanceof Error ? error.message : String(error) };
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  return kb < 100 ? `${kb.toFixed(1)} KB` : `${Math.round(kb)} KB`;
}

/** Rows of a file; one trailing newline closes the last row instead of
 * starting an empty one. */
function splitLines(text: string): string[] {
  const body = text.endsWith("\n") ? text.slice(0, -1) : text;
  return body.split(/\r?\n/);
}

export function FilePreviewSection({ request, theme, onBack, onClose }: {
  request: PreviewRequest;
  /** Picks the light or dark variant of the file icon. */
  theme: Theme;
  /** Returns the panel to the ToDo and file tree view. */
  onBack: () => void;
  /** Hides the whole right panel. */
  onClose: () => void;
}): JSX.Element {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [wrap, setWrap] = useState(false);
  // Markdown opens rendered; the header switches to the source text.
  const [mdView, setMdView] = useState<"render" | "source">("render");
  const [findOnOpen, setFindOnOpen] = useState(false);
  const [cwd, setCwdState] = useState<string | null>(getPiCwd);
  useEffect(() => onPiCwdChange(() => setCwdState(getPiCwd())), []);

  useEffect(() => {
    setMdView("render");
    setFindOnOpen(false);
  }, [request.path, request.seq]);

  useEffect(() => {
    let live = true;
    setPreview(null);
    void readPreview(request.path).then((result) => {
      if (live) setPreview(result);
    });
    return () => {
      live = false;
    };
  }, [request.path, request.seq]);

  const display = relativeToCwd(request.path, cwd) ?? request.path;
  const parts = useMemo(() => splitPath(display), [display]);
  // The tree hands over cwd-relative paths; links and images inside a markdown
  // file resolve against its directory, so they need the absolute one.
  const absPath = cwd === null ? request.path : joinPath(cwd, request.path);
  const lang = useMemo(() => langForPath(request.path), [request.path]);
  const isMarkdown = lang === "markdown";
  const markdown = preview?.kind === "text" && isMarkdown;
  const showSource = !isMarkdown || mdView === "source";
  const text = preview?.kind === "text" ? preview.text : null;
  const lines = useMemo(() => (text === null ? [] : splitLines(text)), [text]);
  const html = useMemo(() => (markdown && mdView === "render" && text !== null ? renderMarkdownFile(text) : ""), [markdown, mdView, text]);

  // The find bar only sees source lines, so searching a rendered markdown file
  // switches to the source first.
  useEffect(() => {
    if (!markdown || mdView !== "render") return;
    const onKey = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
        event.preventDefault();
        setMdView("source");
        setFindOnOpen(true);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [markdown, mdView]);

  const body =
    preview === null ? (
      <div class="preview-note">读取中…</div>
    ) : preview.kind === "error" ? (
      <div class="preview-note err">{preview.error}</div>
    ) : preview.kind === "binary" ? (
      <div class="preview-note">二进制文件，无法预览（{formatSize(preview.size)}）</div>
    ) : preview.kind === "image" ? (
      <div class="preview-image-wrap">
        <img class="preview-image" src={`data:${preview.mimeType};base64,${preview.data}`} alt={display} />
      </div>
    ) : lines.length === 1 && lines[0] === "" ? (
      <div class="preview-note">（空文件）</div>
    ) : showSource ? (
      <CodeViewer lines={lines} lang={lang} wrap={wrap} onWrapChange={setWrap} initialFind={findOnOpen} />
    ) : (
      <div class="preview-md">
        <MarkdownPreview html={html} path={absPath} onOpenFile={openPreview} />
      </div>
    );

  const note =
    preview?.kind === "text" && preview.truncated === "bytes" ? "已截断：只显示前 1 MB" : null;
  const foot =
    preview !== null && preview.kind !== "error" ? (
      <div class="preview-foot">
        {preview.kind === "text" ? (
          <>
            <span class="preview-meta">
              {lines.length} 行 · {formatSize(preview.size)}
            </span>
            <CopyButton text={preview.text} label="复制内容" />
          </>
        ) : (
          <span class="preview-meta">{formatSize(preview.size)}</span>
        )}
        {note !== null ? <span class="preview-truncated">{note}</span> : null}
      </div>
    ) : null;

  return (
    <section class="side-section preview-section" aria-label="文件预览">
      <div class="preview-head">
        <button class="side-icon-btn" title="返回文件树" onClick={onBack}>
          ←
        </button>
        <FileIcon path={request.path} theme={theme} />
        <PathLabel dir={parts.dir} name={parts.name} title={request.path} />
        {markdown ? (
          <div class="preview-view-toggle">
            <button
              class={mdView === "render" ? "active" : ""}
              title="渲染后的预览"
              onClick={() => setMdView("render")}
            >
              渲染
            </button>
            <button
              class={mdView === "source" ? "active" : ""}
              title="Markdown 源码"
              onClick={() => {
                setMdView("source");
                setFindOnOpen(false);
              }}
            >
              源码
            </button>
          </div>
        ) : null}
        <button class="side-panel-close" title="收起侧栏" onClick={onClose}>
          ✕
        </button>
      </div>
      <div class="preview-body">{body}</div>
      {foot}
    </section>
  );
}