// Folding of consecutive thinking blocks and bash calls into one unit: which
// rows disappear, what the counts are, and where a folded message's footer goes.
import { describe, expect, it } from "vitest";
import { groupActivities } from "../src/activity-groups.ts";
import type { AssistantContent, AssistantMessage } from "../src/protocol.ts";
import type { StreamRow } from "../src/session-store.ts";

function assistant(content: AssistantContent[], over: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "test",
    provider: "test",
    model: "test",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 1,
    ...over,
  };
}

let rowSeq = 0;
function row(message: StreamRow["message"]): StreamRow {
  rowSeq += 1;
  return { kind: "message", message, id: `row-${rowSeq}` } as StreamRow;
}

const thinking = (text = "hmm"): AssistantContent => ({ type: "thinking", thinking: text });
const bash = (id = "c1"): AssistantContent => ({ type: "toolCall", id, name: "bash", arguments: { command: "ls" } });
const text = (value = "answer"): AssistantContent => ({ type: "text", text: value });
const tool = (name: string, id = `t-${name}`): AssistantContent => ({ type: "toolCall", id, name, arguments: {} });

describe("groupActivities", () => {
  it("folds thinking + bash across messages into one group", () => {
    const rows = [row(assistant([thinking(), bash("a")])), row(assistant([thinking(), bash("b")]))];
    const units = groupActivities(rows, false);
    expect(units).toHaveLength(1);
    const group = units[0]!;
    if (group.kind !== "group") throw new Error("expected a group");
    expect(group.thinking).toBe(2);
    expect(group.commands).toBe(2);
    expect(group.segments.map((s) => s.index)).toEqual([0, 1, 0, 1]);
    expect(group.live).toBe(false);
  });

  it("ends the run at the answer text and hides only the folded prefix", () => {
    const rows = [row(assistant([thinking(), bash("a")])), row(assistant([thinking(), text()]))];
    const units = groupActivities(rows, false);
    expect(units.map((u) => u.kind)).toEqual(["group", "row"]);
    const last = units[1]!;
    if (last.kind !== "row") throw new Error("expected a row");
    expect(last.hidden).toEqual([0]);
  });

  it("ends the run at a non-bash tool card", () => {
    const rows = [row(assistant([thinking(), bash("a")])), row(assistant([thinking(), tool("edit")]))];
    const units = groupActivities(rows, false);
    expect(units.map((u) => u.kind)).toEqual(["group", "row"]);
    const last = units[1]!;
    if (last.kind !== "row") throw new Error("expected a row");
    expect(last.hidden).toEqual([0]);
  });

  it("keeps a foldable block that comes after a drawn one in place", () => {
    // [text, bash]: the text draws, so nothing folds and the card stays inline.
    const units = groupActivities([row(assistant([text(), bash("a")]))], false);
    expect(units.map((u) => u.kind)).toEqual(["row"]);
    const only = units[0]!;
    if (only.kind !== "row") throw new Error("expected a row");
    expect(only.hidden).toEqual([]);
  });

  it("ignores read calls and empty blocks inside the run", () => {
    const rows = [row(assistant([thinking(), tool("read"), text(""), bash("a")]))];
    const units = groupActivities(rows, false);
    expect(units.map((u) => u.kind)).toEqual(["group"]);
    const group = units[0]!;
    if (group.kind !== "group") throw new Error("expected a group");
    expect(group.segments.map((s) => s.index)).toEqual([0, 3]);
  });

  it("folds a single element too", () => {
    const units = groupActivities([row(assistant([thinking()]))], false);
    expect(units.map((u) => u.kind)).toEqual(["group"]);
    const group = units[0]!;
    if (group.kind !== "group") throw new Error("expected a group");
    expect(group.thinking).toBe(1);
    expect(group.commands).toBe(0);
  });

  it("closes the group at a user row", () => {
    const rows = [
      row(assistant([thinking()])),
      row({ role: "user", content: "hi", timestamp: 2 }),
      row(assistant([thinking(), bash("a")])),
    ];
    const units = groupActivities(rows, false);
    expect(units.map((u) => u.kind)).toEqual(["group", "row", "group"]);
  });

  it("gives the footer to the group that folded a message away", () => {
    const rows = [row(assistant([thinking(), bash("a")]))];
    const units = groupActivities(rows, false);
    const group = units[0]!;
    if (group.kind !== "group") throw new Error("expected a group");
    expect(group.tail?.content).toHaveLength(2);
  });

  it("leaves the footer on the row that still draws, not on the group", () => {
    const rows = [row(assistant([thinking(), text()]))];
    const units = groupActivities(rows, false);
    const last = units[units.length - 1]!;
    if (last.kind !== "row") throw new Error("expected a row");
    expect(units[0]!.kind === "group" && units[0]!.tail).toBe(null);
  });

  it("marks only the newest group of a running turn live", () => {
    const rows = [
      row(assistant([thinking()])),
      row({ role: "user", content: "hi", timestamp: 2 }),
      row(assistant([thinking(), bash("a")])),
    ];
    const idle = groupActivities(rows, false);
    expect(idle.filter((u) => u.kind === "group" && u.live)).toHaveLength(0);
    const live = groupActivities(rows, true);
    expect(live.filter((u) => u.kind === "group" && u.live).map((u) => u.id)).toEqual([
      live[live.length - 1]!.id,
    ]);
  });

  it("does not open a finished group just because the turn runs on", () => {
    const rows = [row(assistant([thinking(), bash("a")])), row(assistant([text()]))];
    const units = groupActivities(rows, true);
    const group = units[0]!;
    if (group.kind !== "group") throw new Error("expected a group");
    expect(group.live).toBe(false);
  });

  it("keeps an empty streamed message as its own row so the running line shows", () => {
    const units = groupActivities([row(assistant([], { stopReason: "pending" }))], true);
    expect(units.map((u) => u.kind)).toEqual(["row"]);
  });
});