// UI glyph icons as inline SVG: stroke follows currentColor so they inherit
// the theme's foreground variable and render identically on every platform
// (they replace the former emoji/unicode characters). Line style, 24 viewBox.
import type { JSX } from "preact";

type IconProps = {
  size?: number;
};

function Svg({ size = 16, children }: IconProps & { children: JSX.Element | JSX.Element[] }): JSX.Element {
  return (
    <svg
      class="ui-icon"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

/** Sidebar / panel toggle: three horizontal bars. */
export function IconMenu(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <path d="M3 6h18M3 12h18M3 18h18" />
    </Svg>
  );
}

/** Light theme: sun with rays. */
export function IconSun(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </Svg>
  );
}

/** Dark theme: crescent moon. */
export function IconMoon(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" />
    </Svg>
  );
}

/** Attach image: framed picture with mountain + sun. */
export function IconImage(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <circle cx="8.5" cy="8.5" r="1.5" />
      <path d="M21 15l-5-5L5 21" />
    </Svg>
  );
}

/** Settings: gear. */
export function IconGear(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" />
    </Svg>
  );
}

/** Split diff toggle: two side-by-side panes. */
export function IconColumns(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <rect x="3" y="4" width="7" height="16" rx="1" />
      <rect x="14" y="4" width="7" height="16" rx="1" />
    </Svg>
  );
}

/** Pinned session: solid star (filled, not stroked). */
export function IconStar({ size = 12 }: IconProps): JSX.Element {
  return (
    <svg class="ui-icon" viewBox="0 0 24 24" width={size} height={size} fill="currentColor" aria-hidden="true" focusable="false">
      <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
    </svg>
  );
}

/** Bash card: terminal window with a prompt (filled, 1024 viewBox; user-provided asset). */
export function IconTerminal({ size = 14 }: IconProps): JSX.Element {
  return (
    <svg class="ui-icon" viewBox="0 0 1024 1024" width={size} height={size} fill="currentColor" aria-hidden="true" focusable="false">
      <path d="M499.712 481.792l-128-128c-16.896-16.384-44.032-15.872-60.416 1.024-15.872 16.384-15.872 42.496 0 59.392L409.088 512l-97.792 97.792c-16.896 16.384-17.408 43.52-1.024 60.416s43.52 17.408 60.416 1.024l1.024-1.024 128-128c16.384-16.896 16.384-43.52 0-60.416zM682.496 597.504h-128c-23.552 0-42.496 18.944-42.496 42.496 0 23.552 18.944 42.496 42.496 42.496h128c23.552 0 42.496-18.944 42.496-42.496s-18.944-42.496-42.496-42.496z" />
      <path d="M810.496 128H213.504c-70.656 0-128 57.344-128 128v512c0 70.656 57.344 128 128 128h597.504c70.656 0 128-57.344 128-128V256c-0.512-70.656-57.856-128-128.512-128z m0 682.496H213.504c-23.552 0-42.496-18.944-42.496-42.496V256c0-23.552 18.944-42.496 42.496-42.496h597.504c23.552 0 42.496 18.944 42.496 42.496v512c0 23.552-19.456 42.496-43.008 42.496z" />
    </svg>
  );
}

/** Edit card: document with an edit arrow (filled, 1024 viewBox; user-provided asset). */
export function IconEdit({ size = 14 }: IconProps): JSX.Element {
  return (
    <svg class="ui-icon" viewBox="0 0 1024 1024" width={size} height={size} fill="currentColor" aria-hidden="true" focusable="false">
      <path d="M800 960 224 960c-52.928 0-96-43.072-96-96L128 224c0-52.928 43.072-96 96-96l448 0c17.696 0 32 14.336 32 32s-14.304 32-32 32L224 192C206.368 192 192 206.368 192 224l0 640c0 17.664 14.368 32 32 32l576 0c17.664 0 32-14.336 32-32L832 352c0-17.664 14.304-32 32-32s32 14.336 32 32l0 512C896 916.928 852.928 960 800 960zM612 448c-8.192 0-16.384-3.136-22.624-9.376-12.512-12.512-12.512-32.736 0-45.248l318.016-318.016c12.512-12.512 32.736-12.512 45.248 0s12.512 32.736 0 45.248l-318.016 318.016C628.384 444.896 620.192 448 612 448zM480 448 288 448c-17.664 0-32-14.336-32-32s14.336-32 32-32l192 0c17.664 0 32 14.336 32 32S497.664 448 480 448zM672 640 288 640c-17.664 0-32-14.304-32-32s14.336-32 32-32l384 0c17.696 0 32 14.304 32 32S689.696 640 672 640z" />
    </svg>
  );
}

/** File browser: closed folder. */
export function IconFolder(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <path d="M3 8a2 2 0 0 1 2-2h3.6l2 2H19a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </Svg>
  );
}

/** File browser: open folder. */
export function IconFolderOpen(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <path d="M3 19V7a2 2 0 0 1 2-2h3.6l2 2H19a2 2 0 0 1 2 2v2" />
      <path d="M3 19l2.6-6.7A2 2 0 0 1 7.5 11H22l-2.6 6.7A2 2 0 0 1 17.5 19z" />
    </Svg>
  );
}

/** Reload: circular arrow, used by the file browser. */
export function IconRefresh({ size = 14 }: IconProps): JSX.Element {
  return (
    <Svg size={size}>
      <path d="M21 12a9 9 0 1 1-3.2-6.9" />
      <path d="M21 3v6h-6" />
    </Svg>
  );
}

/** File preview: an eye. */
export function IconEye({ size = 13 }: IconProps): JSX.Element {
  return (
    <Svg size={size}>
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" />
      <circle cx="12" cy="12" r="3" />
    </Svg>
  );
}

/** Copy to clipboard: two overlapping rounded sheets. */
export function IconCopy(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <rect x="9" y="9" width="12" height="12" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </Svg>
  );
}

/** Git: a branch graph, one commit splitting into a second line. */
export function IconGit({ size = 14 }: IconProps): JSX.Element {
  return (
    <Svg size={size}>
      <circle cx="6" cy="5" r="2.5" />
      <circle cx="6" cy="19" r="2.5" />
      <circle cx="18" cy="9" r="2.5" />
      <path d="M6 7.5v9" />
      <path d="M18 11.5c0 3.5-3.5 5-6.5 5.5" />
    </Svg>
  );
}

/** Changed-file row: stage this side into the index. */
export function IconStage({ size = 13 }: IconProps): JSX.Element {
  return (
    <Svg size={size}>
      <path d="M12 5v14M5 12h14" />
    </Svg>
  );
}

/** Changed-file row: take this side back out of the index. */
export function IconUnstage({ size = 13 }: IconProps): JSX.Element {
  return (
    <Svg size={size}>
      <path d="M5 12h14" />
    </Svg>
  );
}

/** Changed-file row: throw this side's change away. */
export function IconDiscard({ size = 13 }: IconProps): JSX.Element {
  return (
    <Svg size={size}>
      <path d="M9 14 4 9l5-5" />
      <path d="M4 9h10a6 6 0 0 1 0 12h-3" />
    </Svg>
  );
}

/** Changed-file row: delete an untracked file. */
export function IconTrash({ size = 13 }: IconProps): JSX.Element {
  return (
    <Svg size={size}>
      <path d="M4 7h16" />
      <path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
      <path d="M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13" />
      <path d="M10 11v6M14 11v6" />
    </Svg>
  );
}

/** Conflict row: mark the file resolved. */
export function IconCheck({ size = 13 }: IconProps): JSX.Element {
  return (
    <Svg size={size}>
      <path d="m4 12 5 5L20 6" />
    </Svg>
  );
}

/** Session search field: a magnifier. */
export function IconSearch({ size = 13 }: IconProps): JSX.Element {
  return (
    <Svg size={size}>
      <circle cx="11" cy="11" r="7" />
      <path d="M20 20l-3.6-3.6" />
    </Svg>
  );
}

/** Composer send: an upward arrow. */
export function IconArrowUp({ size = 16 }: IconProps): JSX.Element {
  return (
    <Svg size={size}>
      <path d="M12 19V5M6 11l6-6 6 6" />
    </Svg>
  );
}

/** Composer stop: a filled square inside the circular stop button. */
export function IconStop({ size = 12 }: IconProps): JSX.Element {
  return (
    <svg class="ui-icon" viewBox="0 0 24 24" width={size} height={size} fill="currentColor" aria-hidden="true" focusable="false">
      <rect x="6" y="6" width="12" height="12" rx="2" />
    </svg>
  );
}

/**
 * Disclosure chevron, drawn pointing right. Callers rotate it 90° to point down
 * while the section is open (`.caret` in style.css), so the glyph never changes.
 */
export function IconChevron({ size = 12 }: IconProps): JSX.Element {
  return (
    <Svg size={size}>
      <path d="M9 5l7 7-7 7" />
    </Svg>
  );
}

/** Thinking block summary: two-lobed brain glyph (filled, 1024 viewBox from the source asset). */
export function IconThinking({ size = 14 }: IconProps): JSX.Element {
  return (
    <svg class="ui-icon" viewBox="0 0 1024 1024" width={size} height={size} fill="currentColor" aria-hidden="true" focusable="false">
      <path d="M594.4832 149.3504c53.4528 0 98.3552 36.352 111.5136 85.6576a131.9424 131.9424 0 0 1 98.816 160.6656 131.6864 131.6864 0 0 1 0 232.6528 131.8912 131.8912 0 0 1-98.816 160.7168 115.4048 115.4048 0 0 1-193.9456 50.944 115.456 115.456 0 0 1-193.9456-50.9952 131.8912 131.8912 0 0 1-98.816-160.6656 131.6864 131.6864 0 0 1 0-232.6528 131.8912 131.8912 0 0 1 98.816-160.6656 115.456 115.456 0 0 1 193.9456-50.9952c20.992-21.3504 50.176-34.6624 82.432-34.6624z m-164.864 65.9456a49.4592 49.4592 0 0 0-29.6448 89.0368 32.9728 32.9728 0 0 1-39.5776 52.736 115.712 115.712 0 0 1-39.5264-53.8624 65.9456 65.9456 0 0 0-30.1056 94.5664 32.9728 32.9728 0 0 1-22.016 49.5104 65.9456 65.9456 0 0 0-17.8688 123.1872c14.336-15.3088 32.1536-27.3408 52.3776-34.4576a32.9728 32.9728 0 0 1 22.016 62.1568 66.2528 66.2528 0 0 0-44.032 62.208c0 36.4032 29.5424 65.9456 65.9968 65.9456 18.176 0 32.9728 14.7456 32.9728 32.9728a49.4592 49.4592 0 0 0 98.8672 0V264.704a49.4592 49.4592 0 0 0-49.4592-49.408z m164.864 0a49.4592 49.4592 0 0 0-49.4592 49.4592v494.5408a49.4592 49.4592 0 1 0 79.104-39.5776 32.9728 32.9728 0 0 1 39.6288-52.736c17.92 13.4656 31.8464 32.1536 39.4752 53.76a65.8944 65.8944 0 0 0 30.1056-94.464 32.9728 32.9728 0 0 1 22.016-49.5104 65.9456 65.9456 0 0 0 17.8688-123.2384c-14.336 15.3088-32.1536 27.3408-52.3776 34.5088a32.9728 32.9728 0 0 1-21.9648-62.1568 66.304 66.304 0 0 0 43.9808-62.208c0-36.4544-29.5424-65.9456-65.9456-65.9456a32.9728 32.9728 0 0 1-32.9728-32.9728 49.4592 49.4592 0 0 0-49.4592-49.4592z" />
    </svg>
  );
}
