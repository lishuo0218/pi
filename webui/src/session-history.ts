// Pre-compaction history. get_messages returns the compaction-aware projection
// (session-manager buildContextEntries): once a compaction summarized the older
// entries, they are gone from it. get_entries returns the same session as an
// append-only entry list, which still holds them, so "load earlier" can reach
// past the boundary (rpc-commands.md "get_entries").
import type { AgentMessage, SessionEntryRecord } from "./protocol";

function isSystem(message: AgentMessage): boolean {
  return message.role === "system";
}
/**
 * Messages of the active branch that the newest compaction dropped.
 *
 * get_entries is append order over the whole file, so abandoned branches are
 * interleaved: the branch is rebuilt by walking parentId back from the leaf.
 * Everything before `firstKeptEntryId` on that branch is exactly what
 * buildContextEntries omits.
 */
export function droppedMessages(
  entries: SessionEntryRecord[],
  leafId: string | null,
): AgentMessage[] {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const path: SessionEntryRecord[] = [];
  const seen = new Set<string>();
  let cursor = leafId === null ? null : byId.get(leafId) ?? null;
  while (cursor !== null && !seen.has(cursor.id)) {
    seen.add(cursor.id);
    path.push(cursor);
    cursor = cursor.parentId === null ? null : byId.get(cursor.parentId) ?? null;
  }
  path.reverse();
  let compactionIndex = -1;
  for (let i = path.length - 1; i >= 0; i--) {
    if (path[i]!.type === "compaction") {
      compactionIndex = i;
      break;
    }
  }
  if (compactionIndex < 0) return [];
  const compaction = path[compactionIndex]!;
  const keptId = compaction.firstKeptEntryId;
  if (keptId === undefined) return [];
  const keptAt = path.findIndex((entry) => entry.id === keptId);
  // An unknown kept id (truncated or hand-edited file) means the boundary
  // cannot be located: report nothing rather than risk showing messages that
  // get_messages already has.
  if (keptAt < 0) return [];
  const dropped = path.slice(0, keptAt);
  return dropped.flatMap((entry) =>
    entry.type === "message" && entry.message !== undefined && !isSystem(entry.message)
      ? [entry.message]
      : [],
  );
}