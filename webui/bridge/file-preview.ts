// File content for the preview panel. Text is capped at 1 MB (the page renders
// it through a virtual list, so the line count does not matter), images are
// inlined as data URLs, and anything that looks binary is reported instead of
// decoded. Paths are scoped to the pi working directory through the same guard
// as the file tree, so the page cannot read outside it.
import { open, readFile, stat } from "node:fs/promises";
import { extname } from "node:path";
import { scopePath } from "./cwd-path.ts";

/** Bytes of a text file the preview shows before cutting. */
const TEXT_BYTES = 1024 * 1024;
/** Larger images are refused: base64 in a JSON response would balloon. */
const IMAGE_BYTES = 8 * 1024 * 1024;
/** Head of a text file inspected for a NUL byte, the binary tell. */
const SNIFF_BYTES = 8000;

const IMAGE_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  ico: "image/x-icon",
  avif: "image/avif",
};

/** Why a text preview stopped short: the byte cap, or null when it is whole. */
export type PreviewTruncation = "bytes" | null;

export type FilePreview =
  | { kind: "text"; text: string; size: number; truncated: PreviewTruncation }
  | { kind: "image"; mimeType: string; data: string; size: number }
  | { kind: "binary"; size: number }
  | { kind: "error"; error: string };

/** Read at most `limit` bytes from the start of `path`. */
async function readHead(path: string, limit: number): Promise<Buffer> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(limit);
    const { bytesRead } = await handle.read(buffer, 0, limit, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/** Wire input from the page: `{ path }` relative to the cwd. */
export async function handleFilePreview(body: unknown, cwd: string): Promise<FilePreview> {
  const req = body as { path?: unknown } | null;
  const path = req?.path;
  if (typeof path !== "string" || path === "") {
    return { kind: "error", error: "invalid request: path must be a non-empty string" };
  }

  const scoped = await scopePath(cwd, path);
  if (scoped.kind === "error") return { kind: "error", error: scoped.error };

  try {
    const info = await stat(scoped.path);
    if (info.isDirectory()) return { kind: "error", error: "这是一个目录" };

    const mime = IMAGE_MIME[extname(scoped.path).slice(1).toLowerCase()];
    if (mime !== undefined) {
      if (info.size > IMAGE_BYTES) return { kind: "error", error: `图片太大（${formatSize(info.size)}）` };
      const data = await readFile(scoped.path);
      return { kind: "image", mimeType: mime, data: data.toString("base64"), size: info.size };
    }

    // One byte past the cap says whether the file continued.
    const head = await readHead(scoped.path, TEXT_BYTES + 1);
    if (head.subarray(0, SNIFF_BYTES).includes(0)) return { kind: "binary", size: info.size };

    const truncated = head.length > TEXT_BYTES;
    let text = new TextDecoder().decode(truncated ? head.subarray(0, TEXT_BYTES) : head);
    // A byte cut can split a multi-byte character; keep it out of the output.
    if (truncated && text.endsWith("\uFFFD")) text = text.slice(0, -1);
    return { kind: "text", text, size: info.size, truncated: truncated ? "bytes" : null };
  } catch (error) {
    return { kind: "error", error: error instanceof Error ? error.message : String(error) };
  }
}

/** Human byte count for the size limits the preview reports. */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  return kb < 1024 ? `${Math.round(kb)} KB` : `${(kb / 1024).toFixed(1)} MB`;
}