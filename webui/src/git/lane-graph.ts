// Geometry of the history graph cell: what one row's cell draws for a lane row,
// so the component only assembles SVG elements and the shapes stay testable.
import type { LaneRow } from "./lanes";

/** One lane is LANE_WIDTH wide and a row is ROW_HEIGHT tall (matches style.css). */
export const LANE_WIDTH = 10;
export const ROW_HEIGHT = 40;
/** Columns reserved for a window that needs none, so a linear history still lines up. */
const MIN_LANES = 3;
/** Columns reserved at most; lanes past them collapse into the last one. */
const MAX_LANES = 8;

/** One drawn line: the lane whose color it takes, and its path. */
export type LanePath = { lane: number; d: string };

/** What one row's cell draws, plus the node's center. */
export type LaneCell = {
  width: number;
  paths: LanePath[];
  node: { x: number; y: number };
};

/**
 * Columns to reserve for a window whose rows use `used` columns. Appending a page
 * can only add rows, so the window's need never shrinks and rows already rendered
 * keep their place; the floor is what a linear history gets.
 */
export function reserveColumns(used: number): number {
  return Math.min(Math.max(used, MIN_LANES), MAX_LANES);
}

/** Center of `lane` in a cell of `columns`, with everything past them on the last. */
function laneX(lane: number, columns: number): number {
  return Math.min(lane, columns - 1) * LANE_WIDTH + LANE_WIDTH / 2;
}

/**
 * Lines the cell of one row draws across `columns`: the node's own lane, the lanes
 * continuing past it and the parent curves. A null row is a search result, whose
 * commits have no lanes; the cell then keeps the node in a single column so rows
 * still align.
 */
export function laneCell(row: LaneRow | null, columns: number): LaneCell {
  const mid = ROW_HEIGHT / 2;
  if (row === null) {
    return { width: LANE_WIDTH, paths: [], node: { x: LANE_WIDTH / 2, y: mid } };
  }
  const from = laneX(row.lane, columns);
  const paths: LanePath[] = [];
  // The row above stops at its own bottom edge, so a node a lane led into needs
  // its top half here or it floats in the middle of the row.
  if (row.incoming) paths.push({ lane: row.lane, d: `M${from} 0V${mid}` });
  for (const channel of row.channels) {
    paths.push({ lane: channel, d: `M${laneX(channel, columns)} 0V${ROW_HEIGHT}` });
  }
  for (const edge of row.edges) {
    const to = laneX(edge, columns);
    paths.push({
      lane: edge,
      d:
        from === to
          ? `M${from} ${mid}V${ROW_HEIGHT}`
          : `M${from} ${mid}C${from} ${mid + 8} ${to} ${ROW_HEIGHT - 8} ${to} ${ROW_HEIGHT}`,
    });
  }
  return { width: columns * LANE_WIDTH, paths, node: { x: from, y: mid } };
}