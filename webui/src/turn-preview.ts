// One-line label for a user message: the first non-empty line, whitespace
// collapsed and truncated. Shared by the live binder and hydration so both
// name a turn the same way.
import type { ImageContent, TextContent } from "./protocol";

const MAX = 120;

export function turnPreview(content: string | (TextContent | ImageContent)[]): string {
  const text =
    typeof content === "string"
      ? content
      : content
          .filter((c): c is TextContent => c.type === "text")
          .map((c) => c.text)
          .join("\n");
  const line = text
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l !== "");
  return line === undefined ? "" : line.replace(/\s+/g, " ").slice(0, MAX);
}