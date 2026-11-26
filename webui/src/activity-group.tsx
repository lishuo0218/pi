// Folded activity row: "已思考 3 次 · 执行 2 条命令" standing in for a run of
// thinking blocks and bash cards, which expand in place (same components, same
// look) when clicked.
import { useState } from "preact/hooks";
import type { JSX } from "preact";
import { AssistantContentBlock, AssistantTail } from "./messages";
import { IconChevron } from "./icons";
import { Collapse } from "./collapse";
import type { DisplayUnit } from "./activity-groups";
import type { ToolStore } from "./tool-store";

/** `已思考 3 次 · 执行 2 条命令`, dropping whichever part is zero. */
function groupLabel(unit: Extract<DisplayUnit, { kind: "group" }>): string {
  const parts: string[] = [];
  if (unit.thinking > 0) parts.push(`已思考 ${unit.thinking} 次`);
  if (unit.commands > 0) parts.push(`执行 ${unit.commands} 条命令`);
  return parts.join(" · ");
}

export function ActivityGroup({
  unit,
  toolStore,
  atTurnEnd,
}: {
  unit: Extract<DisplayUnit, { kind: "group" }>;
  toolStore: ToolStore;
  /** The group holds the last assistant message of its turn. */
  atTurnEnd: boolean;
}): JSX.Element {
  // The live group opens on its own; a click overrides that for its whole life,
  // so an expanded history group does not snap shut on the next render.
  const [manual, setManual] = useState<boolean | null>(null);
  const open = manual ?? unit.live;
  return (
    <div class={`activity narrow${open ? " open" : ""}${unit.live ? " live" : ""}`}>
      <div class="activity-head" onClick={() => setManual(!open)}>
        <span class="caret">
          <IconChevron />
        </span>
        <span class="activity-label">{groupLabel(unit)}</span>
      </div>
      <Collapse open={open}>
        <div class="activity-body">
          {unit.segments.map((segment) => (
            <AssistantContentBlock
              key={`${segment.rowId}-${segment.index}`}
              message={segment.message}
              index={segment.index}
              toolStore={toolStore}
            />
          ))}
        </div>
      </Collapse>
      {unit.tail === null ? null : <AssistantTail message={unit.tail} atTurnEnd={atTurnEnd} />}
    </div>
  );
}