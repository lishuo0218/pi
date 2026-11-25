// Geometry of the graph cell is pure too: these tests pin the shapes that make
// the graph readable, above all the line into a node's top half.
import { describe, expect, it } from "vitest";
import { laneCell, LANE_WIDTH, ROW_HEIGHT } from "../../src/git/lane-graph.ts";
import type { LaneRow } from "../../src/git/lanes.ts";

function row(partial: Partial<LaneRow>): LaneRow {
  return { lane: 0, incoming: false, channels: [], edges: [], ...partial };
}

describe("laneCell", () => {
  it("draws a node its own lane's top half when a lane led into it", () => {
    const cell = laneCell(row({ lane: 0, incoming: true, edges: [0] }));
    expect(cell.paths).toEqual([
      // The row above ends at its own bottom edge, so the top half is drawn here.
      { lane: 0, d: `M5 0V${ROW_HEIGHT / 2}` },
      { lane: 0, d: `M5 ${ROW_HEIGHT / 2}V${ROW_HEIGHT}` },
    ]);
    expect(cell.node).toEqual({ x: 5, y: ROW_HEIGHT / 2 });
  });

  it("leaves the top half open for the window's first row", () => {
    const cell = laneCell(row({ lane: 0, incoming: false, edges: [0] }));
    expect(cell.paths).toEqual([{ lane: 0, d: `M5 ${ROW_HEIGHT / 2}V${ROW_HEIGHT}` }]);
  });

  it("curves a merge edge to the lane it lands in and colors it with that lane", () => {
    const cell = laneCell(row({ lane: 0, incoming: true, edges: [0, 1] }));
    expect(cell.paths.at(-1)).toEqual({
      lane: 1,
      d: `M5 ${ROW_HEIGHT / 2}C5 ${ROW_HEIGHT / 2 + 8} 15 ${ROW_HEIGHT - 8} 15 ${ROW_HEIGHT}`,
    });
  });

  it("runs a channel through the whole row", () => {
    const cell = laneCell(row({ lane: 0, channels: [1, 2] }));
    expect(cell.paths).toEqual([
      { lane: 1, d: `M15 0V${ROW_HEIGHT}` },
      { lane: 2, d: `M25 0V${ROW_HEIGHT}` },
    ]);
  });

  it("reserves the same columns for every row and collapses the rest", () => {
    expect(laneCell(row({ lane: 0 })).width).toBe(8 * LANE_WIDTH);
    const crowded = laneCell(row({ lane: 9, edges: [12] }));
    expect(crowded.width).toBe(8 * LANE_WIDTH);
    // Both the node and its edge sit on the last reserved column.
    expect(crowded.node.x).toBe(75);
    expect(crowded.paths).toEqual([{ lane: 12, d: `M75 ${ROW_HEIGHT / 2}V${ROW_HEIGHT}` }]);
  });

  it("draws no lanes for a search result", () => {
    const cell = laneCell(null);
    expect(cell).toEqual({ width: LANE_WIDTH, paths: [], node: { x: LANE_WIDTH / 2, y: ROW_HEIGHT / 2 } });
  });
});