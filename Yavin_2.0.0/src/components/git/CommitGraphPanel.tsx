import { useEffect, useMemo, useRef, useState } from "react";
import type { Repository } from "../../services/git/repository";
import { useCommitGraph } from "../../services/git/hooks";
import type { GraphNode } from "../../services/git/graph/model";
import { GRAPH_COLOR_COUNT } from "../../services/git/graph/model";
import { parseCommitDetails } from "../../services/git/parsers/log";
import type { CommitDetailedInfo } from "../../services/git/parsers/log";
import type { DiffDocument } from "../layout/DiffEditor";
import { CloseIcon, GitCommitIcon } from "../ui/Icons";

const ROW_HEIGHT = 28;
const LANE_WIDTH = 16;
const NODE_RADIUS = 4;
const OVERSCAN = 8;

// A fixed categorical palette, one entry per `GRAPH_COLOR_COUNT` lane color index.
const PALETTE = [
  "#818cf8", // indigo
  "#34d399", // emerald
  "#f472b6", // pink
  "#fbbf24", // amber
  "#60a5fa", // blue
  "#f87171", // red
  "#a78bfa", // violet
  "#2dd4bf", // teal
];

function colorFor(index: number): string {
  return PALETTE[index % GRAPH_COLOR_COUNT] ?? PALETTE[0];
}

function laneX(lane: number): number {
  return lane * LANE_WIDTH + LANE_WIDTH / 2;
}

const refBadgeStyle: Record<string, string> = {
  head: "bg-indigo-500/20 text-indigo-300 border-indigo-500/40",
  branch: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
  remote: "bg-zinc-700/40 text-zinc-300 border-zinc-600/50",
  tag: "bg-amber-500/15 text-amber-300 border-amber-500/30",
};

function CommitDetail({
  node,
  repository,
  onClose,
  onDiff,
}: {
  node: GraphNode;
  repository: Repository;
  onClose: () => void;
  onDiff: (document: DiffDocument) => void;
}) {
  const [detail, setDetail] = useState<CommitDetailedInfo | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [diffError, setDiffError] = useState("");

  const openFileDiff = (path: string) => {
    setDiffError("");
    repository
      .commitFileDiff(node.commit.fullHash, path)
      .then((text) => {
        onDiff({
          path,
          title: `${node.commit.hash} — ${path}`,
          text: text || "No textual differences. The change may be metadata or binary only.",
        });
      })
      .catch((reason) => setDiffError(String(reason)));
  };

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    setDetail(null);
    repository
      .commitDetails(node.commit.fullHash)
      .then((output) => {
        if (!cancelled) setDetail(parseCommitDetails(output));
      })
      .catch((reason) => {
        if (!cancelled) setError(String(reason));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [repository, node.commit.fullHash]);

  return (
    <aside className="w-[320px] shrink-0 border-l border-[#141414] bg-black flex flex-col h-full">
      <div className="flex h-9 items-center justify-between px-3 border-b border-[#141414] shrink-0">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400">
          Commit
        </span>
        <button
          onClick={onClose}
          title="Close commit details"
          className="p-1 rounded text-zinc-500 hover:text-zinc-200 hover:bg-[#121212]"
        >
          <CloseIcon size={12} />
        </button>
      </div>
      <div className="p-3 space-y-2 overflow-y-auto flex-1 text-xs">
        <p className="text-zinc-200 font-medium break-words">{node.commit.subject}</p>
        <p className="text-zinc-500 text-[11px]">
          {node.commit.authorName} · {node.commit.relativeTime}
        </p>
        <p className="text-zinc-600 font-mono text-[10.5px] break-all">{node.commit.fullHash}</p>

        {loading && <p className="text-zinc-500 text-[11px] animate-pulse">Loading changes…</p>}
        {error && <p className="text-red-400 text-[11px]">{error}</p>}
        {diffError && <p className="text-red-400 text-[11px]">{diffError}</p>}
        {detail && (
          <>
            <p className="text-zinc-400 text-[11px] pt-1">
              {detail.filesChanged} file{detail.filesChanged === 1 ? "" : "s"} changed,{" "}
              <span className="text-emerald-400">+{detail.insertions}</span>{" "}
              <span className="text-rose-400">-{detail.deletions}</span>
            </p>
            <ul className="divide-y divide-[#101010] border-t border-[#141414]">
              {detail.files.map((file) => (
                <li key={file.path}>
                  <button
                    onClick={() => openFileDiff(file.path)}
                    title={`Show the diff for ${file.path} in this commit`}
                    className="flex w-full items-center gap-1.5 py-1 text-[11px] text-zinc-300 hover:bg-[#121212] rounded px-0.5 -mx-0.5"
                  >
                    <span className="font-mono text-[10px] text-zinc-500 w-3 shrink-0">
                      {file.status}
                    </span>
                    <span className="truncate flex-1 text-left">{file.path}</span>
                    {!file.binary && (
                      <span className="shrink-0 font-mono text-[10px]">
                        <span className="text-emerald-400">+{file.insertions}</span>{" "}
                        <span className="text-rose-400">-{file.deletions}</span>
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </aside>
  );
}

export function CommitGraphPanel({
  repository,
  onClose,
  onDiff,
}: {
  repository: Repository;
  onClose: () => void;
  onDiff: (document: DiffDocument) => void;
}) {
  const { snapshot, loadMore } = useCommitGraph(repository);
  const [selected, setSelected] = useState<GraphNode | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [clientHeight, setClientHeight] = useState(400);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    setClientHeight(el.clientHeight);
    const observer = new ResizeObserver(() => setClientHeight(el.clientHeight));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const { nodes, edges } = snapshot.layout;
  const totalHeight = nodes.length * ROW_HEIGHT;
  const gutterWidth = Math.max(1, Math.min(snapshot.layout.laneCount, 12)) * LANE_WIDTH + 8;

  const firstVisible = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const lastVisible = Math.min(
    nodes.length - 1,
    Math.ceil((scrollTop + clientHeight) / ROW_HEIGHT) + OVERSCAN,
  );

  const visibleNodes = useMemo(
    () => nodes.slice(firstVisible, lastVisible + 1),
    [nodes, firstVisible, lastVisible],
  );
  const visibleEdges = useMemo(
    () =>
      edges.filter(
        (e) =>
          (e.fromRow >= firstVisible && e.fromRow <= lastVisible) ||
          (e.toRow !== null && e.toRow >= firstVisible && e.toRow <= lastVisible) ||
          (e.toRow === null && e.fromRow <= lastVisible),
      ),
    [edges, firstVisible, lastVisible],
  );

  return (
    <div className="flex h-full w-full min-w-0 bg-black">
      <div className="flex flex-col flex-1 min-w-0">
        <div className="flex h-9 items-center justify-between px-3 border-b border-[#141414] shrink-0">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400 flex items-center gap-1.5">
            <GitCommitIcon size={13} />
            Commit Graph
          </span>
          <button
            onClick={onClose}
            title="Close graph"
            className="p-1 rounded text-zinc-500 hover:text-zinc-200 hover:bg-[#121212]"
          >
            <CloseIcon size={13} />
          </button>
        </div>
        {snapshot.notice && (
          <p role="status" className="px-3 py-1 text-[11px] text-red-400 break-words">
            {snapshot.notice}
          </p>
        )}
        <div
          ref={containerRef}
          role="grid"
          aria-label="Commit history"
          className="flex-1 overflow-auto relative"
          onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
        >
          <div style={{ height: totalHeight, position: "relative" }}>
            <svg
              width={gutterWidth}
              height={totalHeight}
              style={{ position: "absolute", top: 0, left: 0, pointerEvents: "none" }}
            >
              {visibleEdges.map((edge, i) => {
                const x1 = laneX(edge.fromLane);
                const y1 = edge.fromRow * ROW_HEIGHT + ROW_HEIGHT / 2;
                const y2 =
                  (edge.toRow ?? Math.min(nodes.length, lastVisible + 2)) * ROW_HEIGHT +
                  ROW_HEIGHT / 2;
                const x2 = laneX(edge.toLane);
                const color = colorFor(edge.color);
                if (x1 === x2) {
                  return (
                    <line
                      key={i}
                      x1={x1}
                      y1={y1}
                      x2={x2}
                      y2={y2}
                      stroke={color}
                      strokeWidth={1.5}
                    />
                  );
                }
                const midY = (y1 + y2) / 2;
                return (
                  <path
                    key={i}
                    d={`M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}`}
                    stroke={color}
                    strokeWidth={1.5}
                    fill="none"
                  />
                );
              })}
              {visibleNodes.map((node) => (
                <circle
                  key={node.commit.fullHash}
                  cx={laneX(node.lane)}
                  cy={node.row * ROW_HEIGHT + ROW_HEIGHT / 2}
                  r={NODE_RADIUS}
                  fill={colorFor(node.color)}
                />
              ))}
            </svg>

            {visibleNodes.map((node) => (
              <div
                key={node.commit.fullHash}
                role="row"
                tabIndex={0}
                aria-selected={selected?.commit.fullHash === node.commit.fullHash}
                onClick={() => setSelected(node)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") setSelected(node);
                }}
                style={{
                  position: "absolute",
                  top: node.row * ROW_HEIGHT,
                  left: gutterWidth,
                  right: 0,
                  height: ROW_HEIGHT,
                }}
                className={`flex items-center gap-2 px-2 text-[11.5px] cursor-pointer truncate ${
                  selected?.commit.fullHash === node.commit.fullHash
                    ? "bg-indigo-950/50"
                    : "hover:bg-[#121212]"
                }`}
              >
                <span className="font-mono text-zinc-500 shrink-0">{node.commit.hash}</span>
                {node.commit.refs.map((ref) => (
                  <span
                    key={`${ref.kind}:${ref.name}`}
                    className={`shrink-0 rounded border px-1 text-[9.5px] ${refBadgeStyle[ref.kind]}`}
                  >
                    {ref.name}
                  </span>
                ))}
                <span className="truncate flex-1 text-zinc-200">{node.commit.subject}</span>
                <span className="shrink-0 text-zinc-500">{node.commit.authorName}</span>
                <span className="shrink-0 text-zinc-600 w-24 text-right">
                  {node.commit.relativeTime}
                </span>
              </div>
            ))}
          </div>

          {snapshot.hasMore && (
            <div className="p-2 text-center">
              <button
                disabled={snapshot.loading}
                onClick={loadMore}
                className="text-[11px] text-zinc-400 hover:text-zinc-200 disabled:opacity-40"
              >
                {snapshot.loading ? "Loading…" : "Load older commits"}
              </button>
            </div>
          )}
          {!snapshot.hasMore && nodes.length === 0 && !snapshot.loading && (
            <p className="p-4 text-center text-zinc-500 text-[11px]">No commits yet.</p>
          )}
        </div>
      </div>

      {selected && (
        <CommitDetail
          repository={repository}
          node={selected}
          onClose={() => setSelected(null)}
          onDiff={(document) => {
            // Switches to the same DiffEditor slot every other diff already renders
            // in (App.tsx's existing diff/showGraph mutual-exclusion branch) --
            // closing the graph view rather than trying to show both at once.
            onDiff(document);
            onClose();
          }}
        />
      )}
    </div>
  );
}
