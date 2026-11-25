// Pi logo mark: pixel-style glyph extracted from pi's official web UI
// (svg.pi-logo-mark, viewBox 0 0 800 800). Three fixed official colors,
// sized per usage (topbar title, empty state); favicon.svg mirrors it.
import type { JSX } from "preact";

export function Logo({ size }: { size: number }): JSX.Element {
  return (
    <svg class="pi-logo-mark" viewBox="0 0 800 800" width={size} height={size} aria-hidden="true" focusable="false">
      <path fill="#F09082" d="M165.29 165.29H517.36V400H400V282.65H165.29Z" />
      <path fill="#4D9ABF" d="M165.29 282.65H282.65V400H400V517.36H282.65V634.72H165.29Z" />
      <path fill="#F1BE58" d="M517.36 400H634.72V634.72H517.36Z" />
    </svg>
  );
}
