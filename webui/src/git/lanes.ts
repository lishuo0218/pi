// Lane layout for the history graph: the commit's own lane is where the walk
// reached it, its first parent keeps that lane downward, and every merge parent
// branches into a free lane. Layout runs over the loaded window from the top, so
// appending a page just extends it and no state has to survive a refresh.
import type { GitCommit } from "../../bridge/git/types";

/** One rendered row: where the node sits and which lines enter and leave it. */
export type LaneRow = {
  /** Lane of the commit's node. */
  lane: number;
  /** True when the lane already led down into this node, so it draws its top half. */
  incoming: boolean;
  /** Lanes that continue straight through the row, top to bottom. */
  channels: number[];
  /** Lanes the parent edges reach at the bottom of the row. */
  edges: number[];
};

/** First empty lane, or a new one appended at the end. */
function freeLane(lanes: (string | null)[]): number {
  const free = lanes.indexOf(null);
  return free === -1 ? lanes.length : free;
}

/** Columns the rows use, from the node's lane down to the farthest parent edge. */
export function laneSpan(rows: LaneRow[]): number {
  let span = 0;
  for (const row of rows) {
    for (const lane of [row.lane, ...row.channels, ...row.edges]) span = Math.max(span, lane + 1);
  }
  return span;
}

/** Lay out `commits` (newest first) into graph rows. */
export function layoutLanes(commits: GitCommit[]): LaneRow[] {
  let awaiting: (string | null)[] = [];
  const rows: LaneRow[] = [];
  for (const commit of commits) {
    let lane = awaiting.indexOf(commit.sha);
    const incoming = lane !== -1;
    if (!incoming) {
      lane = freeLane(awaiting);
      awaiting[lane] = commit.sha;
    }
    const next = awaiting.slice();
    next[lane] = null;
    const edges: number[] = [];
    for (const [index, parent] of commit.parents.entries()) {
      let target = next.indexOf(parent);
      if (target === -1) {
        // A parent another lane already expects is reused above, which is what
        // keeps two branches that share an ancestor on one lane. Otherwise the
        // first parent takes the row's own lane (never an earlier freed one, so
        // the trunk cannot jump left) and the merge parents take a free lane.
        target = index === 0 ? lane : freeLane(next);
        next[target] = parent;
      }
      edges.push(target);
    }
    while (next.length > 0 && next[next.length - 1] === null) next.pop();
    const channels: number[] = [];
    for (let index = 0; index < awaiting.length; index++) {
      const sha = awaiting[index];
      if (sha === null || index === lane) continue;
      if (next[index] === sha) channels.push(index);
    }
    rows.push({ lane, incoming, channels, edges });
    awaiting = next;
  }
  return rows;
}