import type { RepoEntry } from "../../services/git/registry";
import { useCommitGraph } from "../../services/git/hooks";
import { guardedAffecting } from "../../services/git/sync";
import { GRAPH_COLOR_COUNT } from "../../services/git/graph/model";
import { ChevronIcon } from "../ui/FileIcons";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  GitBranchIcon,
  MoreIcon,
  RefreshIcon,
  SyncIcon,
} from "../ui/Icons";
import { GitMenu } from "./GitMenu";

const ROW_HEIGHT = 22;
const LANE_WIDTH = 12;
const NODE_RADIUS = 3.5;
const VISIBLE_COUNT = 30;

const PALETTE = [
  "#818cf8",
  "#34d399",
  "#f472b6",
  "#fbbf24",
  "#60a5fa",
  "#f87171",
  "#a78bfa",
  "#2dd4bf",
];
const colorFor = (i: number) => PALETTE[i % GRAPH_COLOR_COUNT] ?? PALETTE[0];
const laneX = (lane: number) => lane * LANE_WIDTH + LANE_WIDTH / 2;

export function InlineGraphSection({
  entry,
  dirty,
  collapsed,
  onToggleCollapse,
  onExpand,
}: {
  entry: RepoEntry | null;
  dirty: boolean;
  collapsed: boolean;
  onToggleCollapse: () => void;
  onExpand?: () => void;
}) {
  const { snapshot, loadMore, reset } = useCommitGraph(entry?.store.repository);

  if (!entry) return null;

  const visible = snapshot.layout.nodes.slice(0, VISIBLE_COUNT);
  const edges = snapshot.layout.edges.filter((e) => e.fromRow < VISIBLE_COUNT);
  const gutterWidth = Math.max(1, Math.min(snapshot.layout.laneCount, 4)) * LANE_WIDTH + 6;
  const totalHeight = visible.length * ROW_HEIGHT;

  // guardedAffecting resets the repository's shared GraphLoader itself, correctly
  // scoped to fetch/pull/pullRebase/pullMerge -- not push, which never adds a
  // commit (see sync.ts's GRAPH_RESETS) but was reset unconditionally here before.
  // Since the loader is shared, that reset is visible through this same `reset`/
  // `snapshot` pair without an extra manual call.
  const run = (kind: string, op: () => Promise<string>) =>
    void guardedAffecting(entry, kind, dirty, op);

  return (
    <section aria-label="Graph" className="text-xs flex flex-col min-h-0">
      <div
        onClick={onToggleCollapse}
        className="flex items-center gap-1.5 px-2.5 py-1.5 cursor-pointer hover:bg-[#0c0c0c] transition-colors group/header shrink-0"
      >
        <ChevronIcon isExpanded={!collapsed} className="size-3" />
        <span className="font-semibold text-[11px] uppercase tracking-wider text-zinc-400">
          Graph
        </span>
        <span className="text-zinc-600 text-[10px]">Auto</span>
        <div className="flex-1" />
        <div
          className="flex items-center gap-0.5 opacity-0 group-hover/header:opacity-100 transition-opacity"
          onClick={(e) => e.stopPropagation()}
        >
          <button
            title="Fetch"
            aria-label="Check for new commits"
            onClick={() => run("fetch", () => entry.store.repository.fetch())}
            className="p-1 rounded text-zinc-500 hover:text-zinc-200 hover:bg-[#1e1e1e]"
          >
            <SyncIcon size={12} />
          </button>
          <button
            title="Pull"
            aria-label="Download new commits"
            onClick={() => run("pull", () => entry.store.repository.pull())}
            className="p-1 rounded text-zinc-500 hover:text-zinc-200 hover:bg-[#1e1e1e]"
          >
            <ArrowDownIcon size={12} />
          </button>
          <button
            title="Push"
            aria-label="Upload local commits"
            onClick={() => run("push", () => entry.store.repository.push())}
            className="p-1 rounded text-zinc-500 hover:text-zinc-200 hover:bg-[#1e1e1e]"
          >
            <ArrowUpIcon size={12} />
          </button>
          <button
            title="Refresh Graph"
            onClick={() => reset()}
            className="p-1 rounded text-zinc-500 hover:text-zinc-200 hover:bg-[#1e1e1e]"
          >
            <RefreshIcon size={12} className={snapshot.loading ? "animate-spin" : ""} />
          </button>
          <GitMenu
            icon={<MoreIcon size={14} />}
            label="Graph view options"
            buttonClassName="p-1 rounded text-zinc-500 hover:text-zinc-200 hover:bg-[#1e1e1e]"
            items={[
              { label: "View as List", checked: true },
              { label: "View as Tree", disabled: true },
            ]}
          />
        </div>
      </div>

      {!collapsed && (
        <div className="overflow-y-auto max-h-[260px]">
          {snapshot.notice && (
            <p role="status" className="px-3 py-1 text-[11px] text-red-400 break-words">
              {snapshot.notice}
            </p>
          )}
          <div style={{ position: "relative", height: totalHeight }}>
            <svg
              width={gutterWidth}
              height={totalHeight}
              style={{ position: "absolute", top: 0, left: 0, pointerEvents: "none" }}
            >
              {edges.map((edge, i) => {
                const x1 = laneX(edge.fromLane);
                const y1 = edge.fromRow * ROW_HEIGHT + ROW_HEIGHT / 2;
                const x2 = laneX(edge.toLane);
                const y2 =
                  (edge.toRow !== null && edge.toRow < VISIBLE_COUNT ? edge.toRow : VISIBLE_COUNT) *
                    ROW_HEIGHT +
                  ROW_HEIGHT / 2;
                const color = colorFor(edge.color);
                if (x1 === x2)
                  return (
                    <line
                      key={i}
                      x1={x1}
                      y1={y1}
                      x2={x2}
                      y2={y2}
                      stroke={color}
                      strokeWidth={1.25}
                    />
                  );
                const midY = (y1 + y2) / 2;
                return (
                  <path
                    key={i}
                    d={`M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}`}
                    stroke={color}
                    strokeWidth={1.25}
                    fill="none"
                  />
                );
              })}
              {visible.map((node) => {
                const isHead = node.commit.refs.some((r) => r.kind === "head");
                return (
                  <circle
                    key={node.commit.fullHash}
                    cx={laneX(node.lane)}
                    cy={node.row * ROW_HEIGHT + ROW_HEIGHT / 2}
                    r={NODE_RADIUS}
                    fill={isHead ? "#000" : colorFor(node.color)}
                    stroke={colorFor(node.color)}
                    strokeWidth={isHead ? 1.5 : 0}
                  />
                );
              })}
            </svg>
            {visible.map((node) => (
              <div
                key={node.commit.fullHash}
                style={{
                  position: "absolute",
                  top: node.row * ROW_HEIGHT,
                  left: gutterWidth,
                  right: 0,
                  height: ROW_HEIGHT,
                }}
                title={node.commit.subject}
                className="flex items-center gap-1.5 px-1.5 text-[11px] hover:bg-[#121212] truncate"
              >
                {node.commit.refs
                  .filter((r) => r.kind === "branch" || r.kind === "head")
                  .slice(0, 1)
                  .map((r) => (
                    <span
                      key={r.name}
                      className="shrink-0 flex items-center gap-0.5 rounded-full bg-indigo-500/20 text-indigo-300 border border-indigo-500/40 px-1.5 text-[9.5px]"
                    >
                      <GitBranchIcon size={9} />
                      {r.name}
                    </span>
                  ))}
                <span className="truncate flex-1 text-zinc-200">{node.commit.subject}</span>
                <span className="shrink-0 text-zinc-600">{node.commit.authorName}</span>
              </div>
            ))}
          </div>
          <div className="flex items-center justify-center gap-3 py-1.5">
            {snapshot.hasMore && (
              <button
                disabled={snapshot.loading}
                onClick={loadMore}
                className="text-[11px] text-zinc-400 hover:text-zinc-200 disabled:opacity-40"
              >
                {snapshot.loading ? "Loading…" : "Show more commits"}
              </button>
            )}
            {onExpand && (
              <button
                onClick={onExpand}
                className="text-[11px] text-zinc-500 hover:text-zinc-200"
                title="Open full commit graph"
              >
                Open in full view
              </button>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
