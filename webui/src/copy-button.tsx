// Copy-to-clipboard button shared by the tool cards: copies the given text and
// flips its label to 已复制 for a moment on success.
import { useEffect, useRef, useState } from "preact/hooks";
import type { JSX } from "preact";
import { IconCopy } from "./icons";

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function CopyButton({ text, label }: { text: string; label: string }): JSX.Element {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return (
    <button
      class="copy-btn"
      onClick={() => {
        void copyText(text).then((ok) => {
          if (!ok) return;
          setCopied(true);
          window.clearTimeout(timer.current);
          timer.current = window.setTimeout(() => setCopied(false), 1200);
        });
      }}
    >
      <IconCopy size={11} />
      {copied ? "已复制" : label}
    </button>
  );
}