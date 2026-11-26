// File-type glyph for a path, taken from the Material Icon Theme set that
// scripts/generate-file-icons.mjs bakes into a local table: exact file name
// first, then the longest matching extension, then the generic file icon.
import type { JSX } from "preact";
import {
  DEFAULT_ICON,
  EXTENSION_ICONS,
  ICON_SVG,
  LIGHT_EXTENSION_ICONS,
  LIGHT_NAME_ICONS,
  NAME_ICONS,
} from "./file-icons.generated";
import { splitPath } from "./path-label";
import type { Theme } from "./theme";

/**
 * Icon name for a path. The light theme prefers the manifest's `_light`
 * variants, which exist because some icons are too bright on white.
 */
export function fileIconName(path: string, theme: Theme): string {
  const light = theme === "light";
  const name = splitPath(path).name.toLowerCase();
  const exact = (light ? LIGHT_NAME_ICONS[name] : undefined) ?? NAME_ICONS[name];
  if (exact !== undefined) return exact;
  // Longest suffix first: "app.controller.ts" matches "controller.ts" before "ts".
  const parts = name.split(".");
  for (let i = 1; i < parts.length; i++) {
    const key = parts.slice(i).join(".");
    const icon = (light ? LIGHT_EXTENSION_ICONS[key] : undefined) ?? EXTENSION_ICONS[key];
    if (icon !== undefined) return icon;
  }
  return DEFAULT_ICON;
}

/** SVG body of a path's icon, for callers that build DOM outside Preact. */
export function fileIconSvg(path: string, theme: Theme): string {
  return ICON_SVG[fileIconName(path, theme)] ?? ICON_SVG[DEFAULT_ICON] ?? "";
}

export function FileIcon({ path, theme }: { path: string; theme: Theme }): JSX.Element {
  // The bundled bodies are trusted package assets, not user input.
  return <span class="file-icon" aria-hidden="true" dangerouslySetInnerHTML={{ __html: fileIconSvg(path, theme) }} />;
}