// Markdown -> sanitized HTML for assistant text (F-10). marked for parsing;
// highlight.js for code blocks; a small DOM-based sanitizer afterwards because
// model output is untrusted wire input: script-capable tags, on* handlers and
// javascript: URLs are stripped, everything else passes.
import { marked } from "marked";
import hljs from "highlight.js/lib/common";

marked.use({
  gfm: true,
  breaks: true,
  renderer: {
    code({ text, lang }: { text: string; lang?: string }): string {
      const language = lang && hljs.getLanguage(lang) ? lang : undefined;
      const body = language
        ? hljs.highlight(text, { language }).value
        : hljs.highlightAuto(text).value;
      const cls = language ? ` class="hljs language-${language}"` : ' class="hljs"';
      return `<pre><code${cls}>${body}</code></pre>`;
    },
  },
});

const STRIP_TAGS = new Set([
  "script",
  "iframe",
  "object",
  "embed",
  "style",
  "link",
  "meta",
  "base",
  "form",
]);

// URL policy: relative URLs and fragments are safe (they resolve against the
// page origin); only whitelisted schemes pass. Model output is untrusted wire
// input: prompt injection can produce malicious markdown.
const SCHEME = /^([a-z][a-z0-9+.-]*):/i;

function urlAllowed(value: string, isImageSrc: boolean): boolean {
  const match = SCHEME.exec(value.trim());
  const scheme = match?.[1]?.toLowerCase();
  if (!scheme) return true;
  if (scheme === "http" || scheme === "https" || scheme === "mailto" || scheme === "tel") return true;
  if (scheme === "data" && isImageSrc) return /^data:image\//i.test(value.trim());
  return false;
}

// Attributes that carry URLs outside href/src, or can submit/replace forms.
const STRIP_ATTRS = new Set(["srcset", "formaction", "action", "background", "dynsrc", "lowsrc"]);

function sanitize(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  for (const el of [...doc.body.querySelectorAll("*")]) {
    const tag = el.tagName.toLowerCase();
    if (STRIP_TAGS.has(tag)) {
      el.remove();
      continue;
    }
    for (const attr of [...el.attributes]) {
      const name = attr.name.toLowerCase();
      if (name.startsWith("on") || STRIP_ATTRS.has(name)) {
        el.removeAttribute(attr.name);
      } else if (name === "href" || name === "src" || name === "xlink:href") {
        if (!urlAllowed(attr.value, name === "src")) {
          el.removeAttribute(attr.name);
        }
      }
    }
    // Model-authored links open in a new tab so the SPA keeps its state.
    if (tag === "a" && el.hasAttribute("href")) {
      el.setAttribute("target", "_blank");
      el.setAttribute("rel", "noopener noreferrer");
    }
  }
  return doc.body.innerHTML;
}

const renderCache = new Map<string, string>();
const CACHE_LIMIT = 200;

/** Render markdown to sanitized HTML; results cached by source text. */
export function renderMarkdown(text: string): string {
  const cached = renderCache.get(text);
  if (cached !== undefined) return cached;
  let html: string;
  try {
    html = sanitize(marked.parse(text, { async: false }));
  } catch {
    // Parse failure falls back to escaped plain text.
    const escaped = text
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;");
    html = `<p>${escaped.replaceAll("\n", "<br>")}</p>`;
  }
  if (renderCache.size >= CACHE_LIMIT) {
    const first = renderCache.keys().next().value;
    if (first !== undefined) renderCache.delete(first);
  }
  renderCache.set(text, html);
  return html;
}
