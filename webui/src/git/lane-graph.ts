// Geometry of the history graph cell: what one row's cell draws for a lane row,
// so the component only assembles SVG elements and the shapes stay testable.
import type { LaneRow } from "./lanes";

/** One lane is LANE_WIDTH wide and a row is ROW_HEIGHT tall (matches style.css). */
export const LANE_WIDTH = 10;
export const ROW_HEIGHT = 40;
/** Columns the cell reserves; lanes past it collapse into the last one. */
const MAX_LANES = 8;

/** One drawn line: the lane whose color it takes, and its path. */
export type LanePath = { lane: number; d: string };

/** What one row's cell draws, plus the node's center. */
export type LaneCell = {
  width: number;
  paths: LanePath[];
  node: { x: number; y: number };
};

/** Center of `lane`, with every lane past the reserved columns on the last one. */
function laneX(lane: number): number {
  return Math.min(lane, MAX_LANES - 1) * LANE_WIDTH + LANE_WIDTH / 2;
}

/**
 * Lines the cell of one row draws: the node's own lane, the lanes continuing past
 * it and the parent curves. A null row is a search result, whose commits have no
 * lanes; the cell then keeps the node in a single column so rows still align.
 */
export function laneCell(row: LaneRow | null): LaneCell {
  const mid = ROW_HEIGHT / 2;
  if (row === null) {
    return { width: LANE_WIDTH, paths: [], node: { x: LANE_WIDTH / 2, y: mid } };
  }
  // Every row reserves the same columns, so a page with more lanes does not widen
  // the rows already rendered and shift their subjects.
  const width = MAX_LANES * LANE_WIDTH;
  const from = laneX(row.lane);
  const paths: LanePath[] = [];
  // The row above stops at its own bottom edge, so a node a lane led into needs
  // its top half here or it floats in the middle of the row.
  if (row.incoming) paths.push({ lane: row.lane, d: `M${from} 0V${mid}` });
  for (const channel of row.channels) {
    paths.push({ lane: channel, d: `M${laneX(channel)} 0V${ROW_HEIGHT}` });
  }
  for (const edge of row.edges) {
    const to = laneX(edge);
    paths.push({
      lane: edge,
      d:
        from === to
          ? `M${from} ${mid}V${ROW_HEIGHT}`
          : `M${from} ${mid}C${from} ${mid + 8} ${to} ${ROW_HEIGHT - 8} ${to} ${ROW_HEIGHT}`,
    });
  }
  return { width, paths, node: { x: from, y: mid } };
}