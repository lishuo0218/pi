// Lane layout is pure: the tests feed parent shas directly, so they can check
// the shapes the repository fixtures would need many commits to produce.
import { describe, expect, it } from "vitest";
import type { GitCommit } from "../../bridge/git/types.ts";
import { laneSpan, layoutLanes } from "../../src/git/lanes.ts";

function commit(sha: string, parents: string[]): GitCommit {
  return { sha, short: sha.slice(0, 7), author: "Test", date: "2026-01-01 00:00", subject: sha, parents, refs: [] };
}

describe("layoutLanes", () => {
  it("lays a linear history on one lane and joins every node to the one above", () => {
    const rows = layoutLanes([commit("c", ["b"]), commit("b", ["a"]), commit("a", [])]);
    expect(rows.map((row) => row.lane)).toEqual([0, 0, 0]);
    expect(rows.map((row) => row.channels)).toEqual([[], [], []]);
    // The window's first row has nothing above it, so it must not draw a top half.
    expect(rows.map((row) => row.incoming)).toEqual([false, true, true]);
  });

  it("gives a merge parent its own lane and keeps it until the parent shows", () => {
    // m is the merge, s is the side commit, p is the merge base.
    const rows = layoutLanes([commit("m", ["p", "s"]), commit("s", ["p"]), commit("p", [])]);
    expect(rows[0]).toMatchObject({ lane: 0, channels: [], edges: [0, 1] });
    expect(rows[1]).toMatchObject({ lane: 1, incoming: true, channels: [0], edges: [0] });
    // Both parents converge on lane 0; the second lane is gone above this row.
    expect(rows[2]).toMatchObject({ lane: 0, channels: [], edges: [] });
    expect(laneSpan(rows)).toBe(2);
  });

  it("branches an octopus merge into one lane per parent", () => {
    const rows = layoutLanes([
      commit("m", ["a", "b", "d"]),
      commit("d", ["a"]),
      commit("b", ["a"]),
      commit("a", []),
    ]);
    expect(rows[0]).toMatchObject({ lane: 0, edges: [0, 1, 2] });
    expect(rows[1]).toMatchObject({ lane: 2, channels: [0, 1], edges: [0] });
    expect(rows[3]).toMatchObject({ lane: 0, channels: [], edges: [] });
  });

  it("reuses a free lane for a commit that no loaded row expected", () => {
    // A paged window can begin in the middle of a branch.
    const rows = layoutLanes([commit("x", ["y"]), commit("y", [])]);
    expect(rows.map((row) => row.lane)).toEqual([0, 0]);
    expect(rows[0]).toMatchObject({ incoming: false });
  });

  it("keeps two lanes when a branch continues past the loaded window", () => {
    const rows = layoutLanes([commit("m", ["p", "s"]), commit("s", ["p"])]);
    expect(rows[1]).toMatchObject({ lane: 1, channels: [0] });
    expect(laneSpan(rows)).toBe(2);
  });

  it("puts a parent two branches share on the lane it already waits on", () => {
    // x and y both wait for p; z merges p with q.
    const rows = layoutLanes([
      commit("x", ["p"]),
      commit("y", ["p"]),
      commit("z", ["p", "q"]),
      commit("q", []),
      commit("p", []),
    ]);
    // z has no lane of its own to give p, so p stays on lane 0 and q takes the row.
    expect(rows[2]).toMatchObject({ lane: 1, channels: [0], edges: [0, 1] });
    expect(rows[4]).toMatchObject({ lane: 0, channels: [], edges: [] });
    expect(laneSpan(rows)).toBe(2);
    expect(rows.every((row) => new Set(row.edges).size === row.edges.length)).toBe(true);
  });

  it("keeps the first parent on the row's lane even when a freed lane is free", () => {
    // After b closes, lane 1 is free; c's parent must not jump left into it.
    const rows = layoutLanes([
      commit("m", ["a", "b", "c"]),
      commit("b", []),
      commit("c", ["d"]),
      commit("d", []),
      commit("a", []),
    ]);
    expect(rows[2]).toMatchObject({ lane: 2, edges: [2] });
  });

  it("spreads a filtered window over one column per commit", () => {
    // Every parent is outside the list, as in a search result: each expectation
    // stays open, which is why the component draws no lanes while searching.
    const rows = layoutLanes([commit("f1", ["g1"]), commit("f2", ["g2"]), commit("f3", ["g3"])]);
    expect(rows.map((row) => row.lane)).toEqual([0, 1, 2]);
    expect(rows[2]?.channels).toEqual([0, 1]);
    expect(laneSpan(rows)).toBe(3);
  });

  it("marks a child whose parent already rendered above as a new lane", () => {
    // Only a window that breaks topological order looks like this; it is what
    // `--date-order` in the log walk prevents.
    const rows = layoutLanes([commit("p", ["o"]), commit("ch", ["p"]), commit("o", [])]);
    expect(rows[1]).toMatchObject({ lane: 1, incoming: false, edges: [1] });
  });

  it("leaves the rows already rendered unchanged when a page is appended", () => {
    const commits = [commit("m", ["p", "s"]), commit("s", ["p"]), commit("p", [])];
    const head = layoutLanes(commits.slice(0, 2));
    expect(layoutLanes(commits).slice(0, 2)).toEqual(head);
    // The component sizes the column from the window, so appending may only widen.
    expect(laneSpan(layoutLanes(commits))).toBeGreaterThanOrEqual(laneSpan(head));
  });
});