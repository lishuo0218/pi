// Which content of the transcript folds into one summarised unit: a leading run
// of thinking blocks and bash calls (per message) joins the run started by the
// previous rows, so "思考 → 命令 → 思考 → 命令" reads as one line. Everything
// that draws something of its own — the answer text, an edit/grep/ask card, a
// user message, a panel-run bash row — ends the run.
import type { AssistantContent, AssistantMessage } from "./protocol";
import type { StreamRow } from "./session-store";

/** One folded content block, located by the row and content index it came from. */
export type ActivitySegment = {
  rowId: string;
  message: AssistantMessage;
  /** Index in `message.content`. */
  index: number;
};

/**
 * What the stream renders, in order. A group stands in for one or more rows
 * whose content folded completely; a row is a transcript row drawn as before,
 * minus the blocks the group took.
 */
export type DisplayUnit =
  | {
      kind: "group";
      id: string;
      segments: ActivitySegment[];
      /** Thinking blocks folded here. */
      thinking: number;
      /** bash calls folded here. */
      commands: number;
      /** Belongs to the running turn: expanded by default. */
      live: boolean;
      /** Message whose footer / running line renders under this group. */
      tail: AssistantMessage | null;
    }
  | {
      kind: "row";
      id: string;
      row: StreamRow;
      /** Content indices the group above took over; empty for whole rows. */
      hidden: number[];
    };

/** A thinking block with text, or a bash call: the two things that fold. */
function activityKind(block: AssistantContent): "thinking" | "bash" | null {
  if (block.type === "thinking") return block.thinking ? "thinking" : null;
  if (block.type === "toolCall" && block.name === "bash") return "bash";
  return null;
}

/** Blocks that draw something of their own, so they cannot be folded away. */
function drawsOutside(block: AssistantContent): boolean {
  if (block.type === "text") return block.text !== "";
  // `read` draws nothing at all (see messages.tsx), so it neither folds nor ends
  // a run: a think → read → bash message is one continuous stretch of activity.
  if (block.type === "toolCall") return block.name !== "bash" && block.name !== "read";
  return false;
}

/**
 * Foldable content of one message: the leading run of thinking/bash blocks.
 * A block that draws ends the run, so nothing after it is taken; such a block
 * after the run renders as it always has (a folding thinking block, a card).
 */
function leadingActivity(message: AssistantMessage): { index: number; kind: "thinking" | "bash" }[] {
  const activity: { index: number; kind: "thinking" | "bash" }[] = [];
  for (let index = 0; index < message.content.length; index++) {
    const block = message.content[index]!;
    if (drawsOutside(block)) break;
    const kind = activityKind(block);
    if (kind) activity.push({ index, kind });
  }
  return activity;
}

export function groupActivities(rows: StreamRow[], running: boolean): DisplayUnit[] {
  const units: DisplayUnit[] = [];
  let segments: ActivitySegment[] = [];
  let thinking = 0;
  let commands = 0;
  let tail: AssistantMessage | null = null;

  const flush = (): void => {
    if (segments.length === 0) return;
    units.push({
      kind: "group",
      // Row ids are stable across renders, so clicks and scroll survive.
      id: `group-${segments[0]!.rowId}`,
      segments,
      thinking,
      commands,
      live: false,
      tail,
    });
    segments = [];
    thinking = 0;
    commands = 0;
    tail = null;
  };

  for (const row of rows) {
    const message = row.message.role === "assistant" ? (row.message as AssistantMessage) : null;
    if (message === null) {
      flush();
      units.push({ kind: "row", id: row.id, row, hidden: [] });
      continue;
    }
    const activity = leadingActivity(message);
    const draws = message.content.some(drawsOutside);
    for (const { index, kind } of activity) {
      segments.push({ rowId: row.id, message, index });
      if (kind === "thinking") thinking += 1;
      else commands += 1;
    }
    if (!draws) {
      if (activity.length === 0) {
        // No content at all (a streamed message before its first delta): keep
        // the row so its running line still shows.
        flush();
        units.push({ kind: "row", id: row.id, row, hidden: [] });
      } else {
        // Nothing left to draw below the folded blocks: the message has no row
        // of its own, so its footer / running line belongs under the group.
        tail = message;
      }
      continue;
    }
    flush();
    units.push({ kind: "row", id: row.id, row, hidden: activity.map((a) => a.index) });
  }
  flush();

  // The newest group of a running turn opens by itself; last unit only, so a
  // finished answer below it does not re-open old activity.
  const last = units[units.length - 1];
  if (running && last?.kind === "group") last.live = true;
  return units;
}