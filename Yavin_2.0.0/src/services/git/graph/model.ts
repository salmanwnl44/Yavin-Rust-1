import type { RawCommit } from "../parsers/log.ts";

export interface GraphNode {
  commit: RawCommit;
  row: number;
  lane: number;
  color: number;
}

export interface GraphEdge {
  fromRow: number;
  fromLane: number;
  /** The row the parent commit occupies, or `null` if it lies beyond the loaded window. */
  toRow: number | null;
  toLane: number;
  color: number;
  /** `parent`: the first-parent line (a straight branch continuation). `merge`: any additional parent. */
  kind: "parent" | "merge";
}

export interface GraphLayout {
  nodes: GraphNode[];
  edges: GraphEdge[];
  laneCount: number;
}

/** Number of distinct colors to cycle through; the UI maps these to an actual palette. */
export const GRAPH_COLOR_COUNT = 8;

/**
 * Assigns each commit a lane (a vertical column) and each parent link a lane-to-lane
 * edge, the same way `git log --graph`/gitk/most graph viewers do: process commits in
 * the order given (newest first, parents after children), track which lane is
 * "waiting" for which hash to appear next, and reuse the lowest free lane when one
 * frees up so the graph stays as narrow as possible.
 *
 * This is a pure function of the full, ordered commit list. Re-running it after more
 * history loads (see `graph/incremental.ts`) reproduces byte-identical results for
 * every already-seen row -- the algorithm only ever looks forward from row 0, never
 * back from the end -- so lanes never jitter as more commits arrive; only edges that
 * were previously "dangling" (their parent not yet loaded) resolve to a real row.
 */
export function buildCommitGraph(commits: RawCommit[]): GraphLayout {
  const rowOf = new Map<string, number>();
  commits.forEach((commit, row) => rowOf.set(commit.fullHash, row));

  // active[lane] = the hash that lane is waiting to reach next, or null if free.
  const active: (string | null)[] = [];
  const laneColor: number[] = [];
  let nextColor = 0;

  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];

  const allocateLane = (): number => {
    const free = active.indexOf(null);
    if (free !== -1) return free;
    active.push(null);
    laneColor.push(0);
    return active.length - 1;
  };

  for (let row = 0; row < commits.length; row++) {
    const commit = commits[row];
    let lane = active.indexOf(commit.fullHash);
    if (lane === -1) {
      // Nothing pointed here yet: a second branch tip (e.g. logging multiple refs)
      // or the very first row.
      lane = allocateLane();
      laneColor[lane] = nextColor++ % GRAPH_COLOR_COUNT;
    }
    const color = laneColor[lane];
    nodes.push({ commit, row, lane, color });
    active[lane] = null;

    commit.parents.forEach((parentHash, parentIndex) => {
      let parentLane = active.indexOf(parentHash);
      if (parentLane === -1) {
        // The first parent continues straight down in the same lane; any other
        // parent (a merge) branches off into a new or reused lane.
        parentLane = parentIndex === 0 ? lane : allocateLane();
        active[parentLane] = parentHash;
        laneColor[parentLane] = parentIndex === 0 ? color : nextColor++ % GRAPH_COLOR_COUNT;
      }
      edges.push({
        fromRow: row,
        fromLane: lane,
        toRow: rowOf.get(parentHash) ?? null,
        toLane: parentLane,
        color: laneColor[parentLane],
        kind: parentIndex === 0 ? "parent" : "merge",
      });
    });
  }

  return { nodes, edges, laneCount: active.length };
}
