// Geometry of the graph cell is pure too: these tests pin the shapes that make
// the graph readable, above all the line into a node's top half.
import { describe, expect, it } from "vitest";
import { laneCell, LANE_WIDTH, reserveColumns, ROW_HEIGHT } from "../../src/git/lane-graph.ts";
import type { LaneRow } from "../../src/git/lanes.ts";

function row(partial: Partial<LaneRow>): LaneRow {
  return { lane: 0, incoming: false, channels: [], edges: [], ...partial };
}

describe("reserveColumns", () => {
  it("keeps a linear history narrow and stops at the cap", () => {
    expect(reserveColumns(0)).toBe(3);
    expect(reserveColumns(2)).toBe(3);
    expect(reserveColumns(5)).toBe(5);
    expect(reserveColumns(9)).toBe(8);
  });
});

describe("laneCell", () => {
  it("draws a node its own lane's top half when a lane led into it", () => {
    const cell = laneCell(row({ lane: 0, incoming: true, edges: [0] }), 3);
    expect(cell.width).toBe(3 * LANE_WIDTH);
    expect(cell.paths).toEqual([
      // The row above ends at its own bottom edge, so the top half is drawn here.
      { lane: 0, d: `M5 0V${ROW_HEIGHT / 2}` },
      { lane: 0, d: `M5 ${ROW_HEIGHT / 2}V${ROW_HEIGHT}` },
    ]);
    expect(cell.node).toEqual({ x: 5, y: ROW_HEIGHT / 2 });
  });

  it("leaves the top half open for the window's first row", () => {
    const cell = laneCell(row({ lane: 0, incoming: false, edges: [0] }), 3);
    expect(cell.paths).toEqual([{ lane: 0, d: `M5 ${ROW_HEIGHT / 2}V${ROW_HEIGHT}` }]);
  });

  it("curves a merge edge to the lane it lands in and colors it with that lane", () => {
    const cell = laneCell(row({ lane: 0, incoming: true, edges: [0, 1] }), 3);
    expect(cell.paths.at(-1)).toEqual({
      lane: 1,
      d: `M5 ${ROW_HEIGHT / 2}C5 ${ROW_HEIGHT / 2 + 8} 15 ${ROW_HEIGHT - 8} 15 ${ROW_HEIGHT}`,
    });
  });

  it("runs a channel through the whole row", () => {
    const cell = laneCell(row({ lane: 0, channels: [1, 2] }), 3);
    expect(cell.paths).toEqual([
      { lane: 1, d: `M15 0V${ROW_HEIGHT}` },
      { lane: 2, d: `M25 0V${ROW_HEIGHT}` },
    ]);
  });

  it("collapses every lane past the reserved columns onto the last one", () => {
    // The cap lives here, so a window needing more columns than the cell reserves
    // must not draw outside it.
    const cell = laneCell(row({ lane: 9, edges: [12] }), 8);
    expect(cell.width).toBe(8 * LANE_WIDTH);
    expect(cell.node.x).toBe(75);
    expect(cell.paths).toEqual([{ lane: 12, d: `M75 ${ROW_HEIGHT / 2}V${ROW_HEIGHT}` }]);
    const narrow = laneCell(row({ lane: 0, edges: [5] }), 3);
    expect(narrow.paths).toEqual([{ lane: 5, d: `M5 ${ROW_HEIGHT / 2}C5 ${ROW_HEIGHT / 2 + 8} 25 32 25 ${ROW_HEIGHT}` }]);
  });

  it("draws no lanes for a search result", () => {
    const cell = laneCell(null, 1);
    expect(cell).toEqual({ width: LANE_WIDTH, paths: [], node: { x: LANE_WIDTH / 2, y: ROW_HEIGHT / 2 } });
  });
});