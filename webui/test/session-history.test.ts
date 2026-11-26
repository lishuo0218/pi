// Pre-compaction history: everything before the newest compaction's kept entry
// on the active branch, excluding abandoned branches and system messages.
import { describe, expect, it } from "vitest";
import { droppedMessages } from "../src/session-history.ts";
import type { AgentMessage, SessionEntryRecord } from "../src/protocol.ts";

function message(id: string, parentId: string | null, text: string): SessionEntryRecord {
  return {
    type: "message",
    id,
    parentId,
    message: { role: "user", content: text, timestamp: 1 } as AgentMessage,
  };
}

function compaction(id: string, parentId: string | null, firstKeptEntryId: string): SessionEntryRecord {
  return { type: "compaction", id, parentId, firstKeptEntryId };
}

function texts(messages: AgentMessage[]): string[] {
  return messages.map((m) => (m as { content: string }).content);
}

describe("droppedMessages", () => {
  it("returns nothing for a session that was never compacted", () => {
    const entries = [message("a", null, "one"), message("b", "a", "two")];
    expect(droppedMessages(entries, "b")).toEqual([]);
  });

  it("returns the messages the newest compaction summarized away", () => {
    const entries = [
      message("a", null, "one"),
      message("b", "a", "two"),
      compaction("c", "b", "d"),
      message("d", "c", "three"),
    ];
    expect(texts(droppedMessages(entries, "d"))).toEqual(["one", "two"]);
  });

  it("reaches back past the newest of several compactions", () => {
    const entries = [
      message("a", null, "one"),
      compaction("b", "a", "c"),
      message("c", "b", "two"),
      compaction("d", "c", "e"),
      message("e", "d", "three"),
    ];
    // Everything before the newest compaction's kept entry is not in
    // get_messages anymore; the older compaction entry itself draws nothing
    // and is skipped, its summarized messages are still real transcript.
    expect(texts(droppedMessages(entries, "e"))).toEqual(["one", "two"]);
  });

  it("ignores abandoned branches even when they sort before the kept entry", () => {
    const entries = [
      message("a", null, "kept"),
      message("x", "a", "abandoned"),
      message("y", "x", "abandoned too"),
      compaction("c", "a", "d"),
      message("d", "c", "after"),
    ];
    expect(texts(droppedMessages(entries, "d"))).toEqual(["kept"]);
  });

  it("skips system messages and non-message entries", () => {
    const entries = [
      message("a", null, "one"),
      {
        type: "message",
        id: "b",
        parentId: "a",
        message: { role: "system", content: "tool set changed", timestamp: 1 } as AgentMessage,
      },
      { type: "model_change", id: "c", parentId: "b" },
      compaction("d", "c", "e"),
      message("e", "d", "two"),
    ];
    expect(texts(droppedMessages(entries, "e"))).toEqual(["one"]);
  });

  it("returns nothing when the kept entry is unknown", () => {
    // A truncated file: the summary names an entry that is not there, so the
    // whole prefix is unknown. Prefer nothing over a wrong transcript.
    const entries = [message("a", null, "one"), compaction("b", "a", "missing"), message("c", "b", "two")];
    expect(droppedMessages(entries, "c")).toEqual([]);
  });

  it("survives a leaf that is not in the entry list", () => {
    expect(droppedMessages([message("a", null, "one")], "gone")).toEqual([]);
  });
});