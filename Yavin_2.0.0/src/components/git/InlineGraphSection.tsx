import type { RepoEntry } from "../../services/git/registry";
import { useCommitGraph, useRepoSnapshot } from "../../services/git/hooks";
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

/** A remote-branch marker. Drawn inline: the shared icon set has no cloud. */
const CloudGlyph = () => (
  <svg
    width="10"
    height="10"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.2"
    aria-hidden="true"
  >
    <path d="M17.5 19a4.5 4.5 0 1 0-1.2-8.8A6 6 0 0 0 4.5 12 3.5 3.5 0 0 0 6 19h11.5z" />
  </svg>
);

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
  // A second operation on the same worktree is refused while one runs, and the refusal's notice
  // is replaced by the first operation's own result a moment later -- so a click here during a
  // commit vanished without a trace. Disable the network buttons instead of inviting that.
  const repo = useRepoSnapshot(entry?.store);
  const busy = repo?.busy ?? false;

  if (!entry) return null;

  const visible = snapshot.layout.nodes.slice(0, VISIBLE_COUNT);
  const edges = snapshot.layout.edges.filter((e) => e.fromRow < VISIBLE_COUNT);
  const gutterWidth = Math.max(1, Math.min(snapshot.layout.laneCount, 4)) * LANE_WIDTH + 6;
  const totalHeight = visible.length * ROW_HEIGHT;

  // guardedAffecting resets the repository's shared GraphLoader itself for every operation
  // that changes what the graph shows (see sync.ts's GRAPH_RESETS). Since the loader is
  // shared, that reset is visible through this same `reset`/`snapshot` pair without an
  // extra manual call.
  const run = (kind: string, op: () => Promise<string>) =>
    void guardedAffecting(entry, kind, dirty, op);

  return (
    <section aria-label="Graph" className="text-xs flex flex-col min-h-0">
      <div
        onClick={onToggleCollapse}
        className="flex items-center gap-1.5 px-2 h-7 cursor-pointer hover:bg-surface-hover transition-colors shrink-0 border-t border-border"
      >
        <ChevronIcon isExpanded={!collapsed} className="size-3" />
        <span className="font-semibold text-[12px] text-ink">Graph</span>
        <span className="text-ink-3 text-[10px]">Auto</span>
        <div className="flex-1" />
        <div className="flex items-center gap-0.5" onClick={(e) => e.stopPropagation()}>
          <button
            title="Fetch"
            aria-label="Check for new commits"
            disabled={busy}
            onClick={() => run("fetch", () => entry.store.repository.fetch())}
            className="p-1 rounded text-ink-3 hover:text-ink hover:bg-surface-hover disabled:opacity-40"
          >
            <SyncIcon size={12} />
          </button>
          <button
            title="Pull"
            aria-label="Download new commits"
            disabled={busy}
            onClick={() => run("pull", () => entry.store.repository.pull())}
            className="p-1 rounded text-ink-3 hover:text-ink hover:bg-surface-hover disabled:opacity-40"
          >
            <ArrowDownIcon size={12} />
          </button>
          <button
            title="Push"
            aria-label="Upload local commits"
            disabled={busy}
            onClick={() => run("push", () => entry.store.repository.push())}
            className="p-1 rounded text-ink-3 hover:text-ink hover:bg-surface-hover disabled:opacity-40"
          >
            <ArrowUpIcon size={12} />
          </button>
          <button
            title="Refresh Graph"
            onClick={() => reset()}
            className="p-1 rounded text-ink-3 hover:text-ink hover:bg-surface-hover"
          >
            <RefreshIcon size={12} className={snapshot.loading ? "animate-spin" : ""} />
          </button>
          <GitMenu
            icon={<MoreIcon size={14} />}
            label="Graph view options"
            buttonClassName="p-1 rounded text-ink-3 hover:text-ink hover:bg-surface-hover"
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
                className="flex items-center gap-1.5 px-1.5 text-[11px] hover:bg-surface-hover truncate"
              >
                <span className="truncate text-ink">{node.commit.subject}</span>
                <span className="shrink-0 truncate text-ink-3">{node.commit.authorName}</span>
                <span className="flex-1" />
                {/* Ref pills sit at the right edge: remote branches orange with a cloud, the
                    current/local branch in the accent colour -- like the Antigravity graph. */}
                {node.commit.refs
                  .filter((r) => r.kind === "branch" || r.kind === "head" || r.kind === "remote")
                  .slice(0, 3)
                  .map((r) => (
                    <span
                      key={`${r.kind}:${r.name}`}
                      className={`flex shrink-0 items-center gap-0.5 rounded-full border px-1.5 text-[9.5px] ${
                        r.kind === "remote"
                          ? "border-orange-500/40 bg-orange-500/20 text-orange-300"
                          : "border-accent/40 bg-accent/20 text-accent-hover"
                      }`}
                    >
                      {r.kind === "remote" ? <CloudGlyph /> : <GitBranchIcon size={9} />}
                      {r.name}
                    </span>
                  ))}
              </div>
            ))}
          </div>
          {!snapshot.hasMore && snapshot.shallow && (
            <p className="px-2 pt-1.5 text-center text-amber-400/80 text-[10.5px]">
              History may be incomplete (this is a shallow clone).
            </p>
          )}
          <div className="flex items-center justify-center gap-3 py-1.5">
            {snapshot.hasMore && (
              <button
                disabled={snapshot.loading}
                onClick={loadMore}
                className="text-[11px] text-ink-2 hover:text-ink disabled:opacity-40"
              >
                {snapshot.loading ? "Loading…" : "Show more commits"}
              </button>
            )}
            {onExpand && (
              <button
                onClick={onExpand}
                className="text-[11px] text-ink-3 hover:text-ink"
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
