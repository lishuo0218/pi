// The folding body shared by every disclosure in the UI: animates height shut,
// and keeps the content mounted long enough for that animation to be seen.
import { useEffect, useRef, useState } from "preact/hooks";
import type { ComponentChildren, JSX } from "preact";

/** Opening time; the CSS lives on `.collapse.open` in style.css and must match. */
const EXPAND_MS = 200;
/** Closing time; the CSS lives on `.collapse` in style.css and must match. */
const COLLAPSE_MS = 150;

type Phase = {
  mounted: boolean;
  expanded: boolean;
};

const same = (a: Phase, b: Phase): boolean => a.mounted === b.mounted && a.expanded === b.expanded;

/**
 * Body of a disclosure that animates open and shut.
 *
 * Height comes from a `0fr`/`1fr` grid row (style.css), so any content height
 * animates without measuring it. Nothing is rendered while shut; a closing body
 * stays mounted for `COLLAPSE_MS` so the shut animation has something to shrink.
 * Only changes after mount animate: a body that mounts open is already open.
 */
export function Collapse({ open, children }: { open: boolean; children: ComponentChildren }): JSX.Element | null {
  const [phase, setPhase] = useState<Phase>({ mounted: open, expanded: open });
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      // Mounting already open is not an expand: a session load must not grow
      // every card it draws, only a later change animates.
      first.current = false;
      return;
    }
    if (open) {
      // Shut, then open on the next frame pair: the starting row height has to be
      // painted before the open class lands, or the browser snaps to the end.
      setPhase((prev) => (same(prev, { mounted: true, expanded: false }) ? prev : { mounted: true, expanded: false }));
      let inner = 0;
      const outer = requestAnimationFrame(() => {
        inner = requestAnimationFrame(() => {
          setPhase((prev) => (prev.expanded ? prev : { ...prev, expanded: true }));
        });
      });
      return () => {
        cancelAnimationFrame(outer);
        cancelAnimationFrame(inner);
      };
    }
    setPhase((prev) => (prev.expanded ? { ...prev, expanded: false } : prev));
    const timer = setTimeout(() => {
      setPhase((prev) => (prev.mounted ? { mounted: false, expanded: false } : prev));
    }, COLLAPSE_MS);
    return () => clearTimeout(timer);
  }, [open]);
  if (!phase.mounted) return null;
  return (
    <div class={`collapse${phase.expanded ? " open" : ""}`}>
      <div class="collapse-inner">{children}</div>
    </div>
  );
}