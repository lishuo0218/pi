// Content fade for toggles that swap what a box shows instead of resizing it:
// "show all" style buttons and the diff fold toggles, where the box is a fixed
// height scroller and only its content changes.
const FADE_MS = 150;
const FADE_EASING = "ease-out";
/** Opacity the swapped content starts at; 0 is a full fade-in. */
const FADE_FROM = 0;

/**
 * Runs `update`, then fades `el` in from `FADE_FROM`, so a content swap is
 * visible even when the box keeps its height.
 */
export function fadeSwap(el: HTMLElement | null, update: () => void): void {
  update();
  if (el === null || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  el.animate([{ opacity: FADE_FROM }, { opacity: 1 }], { duration: FADE_MS, easing: FADE_EASING });
}