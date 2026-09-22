import { useEffect, useMemo, useRef, useState } from "react";
import type { UIEvent } from "react";
import type { Repository } from "../../services/git/repository";
import { useCommitGraph } from "../../services/git/hooks";
import type { GraphNode } from "../../services/git/graph/model";
import { GRAPH_COLOR_COUNT } from "../../services/git/graph/model";
import { parseCommitDetails } from "../../services/git/parsers/log";
import type { CommitDetailedInfo, CommitFileChange } from "../../services/git/parsers/log";
import { defaultRemoteWebLink, openExternalUrl } from "../../services/git/remoteUrl";
import type { RemoteWebLink } from "../../services/git/remoteUrl";
import { buildFileTree, flattenVisible } from "../../services/git/fileTree";
import type { DiffDocument } from "../layout/DiffEditor";
import { ChevronIcon, FileIcon } from "../ui/FileIcons";
import { CloseIcon, CopyIcon, ExternalLinkIcon, GitCommitIcon } from "../ui/Icons";

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

/** The subject line is `RawCommit.subject`; a body beyond that (bullet lists included) needs
 * its own fetch (`graphLog`'s `%s` is subject-only). */
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
  const [body, setBody] = useState("");
  const [remoteLink, setRemoteLink] = useState<RemoteWebLink | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [diffError, setDiffError] = useState("");
  const [copied, setCopied] = useState(false);
  const [viewAsTree, setViewAsTree] = useState(false);
  const [collapsedFolders, setCollapsedFolders] = useState<ReadonlySet<string>>(new Set());

  const openFileDiff = ({ path, oldPath }: CommitFileChange) => {
    setDiffError("");
    repository
      .commitFileDiff(node.commit.fullHash, path, oldPath)
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
    setBody("");
    setRemoteLink(null);
    Promise.all([
      repository.commitDetails(node.commit.fullHash),
      repository.commitBody(node.commit.fullHash).catch(() => ""),
      defaultRemoteWebLink(repository).catch(() => null),
    ])
      .then(([output, fullBody, link]) => {
        if (cancelled) return;
        setDetail(parseCommitDetails(output));
        // Only the part beyond the subject -- the subject itself is already shown above,
        // bold, from the graph row's own data. Split on the first blank line rather than
        // slicing by the subject's length: the row's subject comes from `%s`, which
        // collapses whitespace and folds a wrapped subject onto one line, so its length
        // does not line up with the raw `%B` text and the slice cut mid-subject, showing a
        // fragment of the subject line as though it were the body.
        const blankLine = fullBody.search(/\n\s*\n/);
        setBody(blankLine === -1 ? "" : fullBody.slice(blankLine).trim());
        setRemoteLink(link);
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
  }, [repository, node.commit.fullHash, node.commit.subject]);

  const tree = useMemo(() => (detail ? buildFileTree(detail.files, (f) => f.path) : []), [detail]);
  const treeRows = useMemo(
    () => (viewAsTree ? flattenVisible(tree, collapsedFolders) : null),
    [viewAsTree, tree, collapsedFolders],
  );
  const toggleFolder = (path: string) =>
    setCollapsedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  // In tree mode the enclosing folder rows already show the path; a leaf shows only its
  // own file name, the same convention the Changes list's tree view uses.
  const fileRow = (file: CommitFileChange, depth = 0, nested = false) => (
    <li key={file.path}>
      <button
        onClick={() => openFileDiff(file)}
        title={`Show the diff for ${file.oldPath ? `${file.oldPath} → ` : ""}${file.path} in this commit`}
        style={{ paddingLeft: `${2 + depth * 14}px` }}
        className="flex w-full items-center gap-1.5 py-1 pr-0.5 text-[11px] text-zinc-300 hover:bg-[#121212] rounded"
      >
        <span className="font-mono text-[10px] text-zinc-500 w-3 shrink-0">{file.status}</span>
        <span className="truncate flex-1 text-left">
          {nested ? file.path.slice(file.path.lastIndexOf("/") + 1) : file.path}
        </span>
        {!file.binary && (
          <span className="shrink-0 font-mono text-[10px]">
            <span className="text-emerald-400">+{file.insertions}</span>{" "}
            <span className="text-rose-400">-{file.deletions}</span>
          </span>
        )}
      </button>
    </li>
  );

  return (
    <aside className="w-[320px] shrink-0 border-l border-[#141414] bg-black flex flex-col h-full">
      <div className="flex h-9 items-center justify-between px-3 border-b border-[#141414] shrink-0">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400">
          Commit
        </span>
        <button
          onClick={onClose}
          title="Close commit details"
          aria-label="Close commit details"
          className="p-1 rounded text-zinc-500 hover:text-zinc-200 hover:bg-[#121212]"
        >
          <CloseIcon size={12} />
        </button>
      </div>
      <div className="p-3 space-y-2 overflow-y-auto flex-1 text-xs">
        <p className="text-zinc-200 font-medium break-words">{node.commit.subject}</p>
        {body && <p className="text-zinc-400 text-[11px] whitespace-pre-wrap">{body}</p>}
        <p className="text-zinc-500 text-[11px]">
          {node.commit.authorName} · {node.commit.relativeTime} ({node.commit.date})
        </p>
        {node.commit.refs.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {node.commit.refs.map((ref) => (
              <span
                key={`${ref.kind}:${ref.name}`}
                className={`rounded border px-1 text-[9.5px] ${refBadgeStyle[ref.kind]}`}
              >
                {ref.name}
              </span>
            ))}
          </div>
        )}
        <div className="flex items-center gap-2 text-[10.5px] text-zinc-600">
          <span className="font-mono break-all">{node.commit.fullHash}</span>
          <button
            title="Copy the full commit hash"
            aria-label="Copy commit hash"
            onClick={() => {
              // The rejection path matters: clipboard access is refused outside a secure
              // context, and without it the button silently did nothing at all.
              navigator.clipboard.writeText(node.commit.fullHash).then(
                () => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                },
                () => setError("Could not copy the hash to the clipboard."),
              );
            }}
            className="shrink-0 p-0.5 rounded hover:bg-[#121212] hover:text-zinc-300"
          >
            <CopyIcon size={11} />
          </button>
          {copied && <span className="text-emerald-400">Copied</span>}
          {remoteLink && (
            <button
              title={`Open this commit on ${remoteLink.label}`}
              onClick={() =>
                void openExternalUrl(`${remoteLink.url}/commit/${node.commit.fullHash}`)
              }
              className="ml-auto flex shrink-0 items-center gap-1 text-indigo-400 hover:text-indigo-300"
            >
              <ExternalLinkIcon size={10} />
              Open on {remoteLink.label}
            </button>
          )}
        </div>

        {loading && <p className="text-zinc-500 text-[11px] animate-pulse">Loading changes…</p>}
        {error && <p className="text-red-400 text-[11px]">{error}</p>}
        {diffError && <p className="text-red-400 text-[11px]">{diffError}</p>}
        {detail && (
          <>
            <div className="flex items-center justify-between pt-1">
              <p className="text-zinc-400 text-[11px]">
                {detail.filesChanged} file{detail.filesChanged === 1 ? "" : "s"} changed,{" "}
                <span className="text-emerald-400">+{detail.insertions}</span>{" "}
                <span className="text-rose-400">-{detail.deletions}</span>
              </p>
              {detail.files.length > 0 && (
                <button
                  title={viewAsTree ? "View as List" : "View as Tree"}
                  aria-label={viewAsTree ? "View as List" : "View as Tree"}
                  onClick={() => setViewAsTree((v) => !v)}
                  className="rounded px-1 py-0.5 text-[10px] text-zinc-500 hover:text-zinc-300 hover:bg-[#121212]"
                >
                  {viewAsTree ? "List" : "Tree"}
                </button>
              )}
            </div>
            <ul className="divide-y divide-[#101010] border-t border-[#141414]">
              {viewAsTree
                ? treeRows!.map((row) =>
                    row.node.kind === "folder" ? (
                      <li key={`folder:${row.node.path}`}>
                        <button
                          role="button"
                          aria-label={`${row.expanded ? "Collapse" : "Expand"} ${row.node.name}`}
                          style={{ paddingLeft: `${2 + row.depth * 14}px` }}
                          onClick={() => toggleFolder(row.node.path)}
                          className="flex w-full items-center gap-1.5 py-1 text-[11px] text-zinc-300 hover:bg-[#121212] rounded"
                        >
                          <ChevronIcon isExpanded={row.expanded} className="size-3 shrink-0" />
                          <FileIcon name={row.node.name} isDir className="size-3.5 shrink-0" />
                          <span className="truncate">{row.node.name}</span>
                        </button>
                      </li>
                    ) : (
                      fileRow(row.node.item, row.depth, true)
                    ),
                  )
                : detail.files.map((file) => fileRow(file))}
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

  // Scroll events fire far faster than frames, and each `setScrollTop` re-slices the node
  // list and re-filters every edge. Coalescing to one update per animation frame does the
  // same work at the rate the screen can actually show it.
  const scrollFrame = useRef(0);
  useEffect(() => () => cancelAnimationFrame(scrollFrame.current), []);
  const onScroll = (event: UIEvent<HTMLDivElement>) => {
    const { scrollTop: top } = event.currentTarget;
    cancelAnimationFrame(scrollFrame.current);
    scrollFrame.current = requestAnimationFrame(() => setScrollTop(top));
  };

  // A commit selected before a same-repository history rewrite (an amend, a
  // rebase, or an external rewrite the .git watcher picked up) can vanish from
  // the freshly-reloaded snapshot -- reconcile the selection against it so
  // CommitDetail never keeps querying a hash Git no longer has. A genuine
  // repository/worktree switch already clears `selected` for free, since this
  // component itself is remounted (keyed by repoId) in that case.
  useEffect(() => {
    setSelected((current) =>
      current && !snapshot.commits.some((c) => c.fullHash === current.commit.fullHash)
        ? null
        : current,
    );
  }, [snapshot.commits]);

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
            aria-label="Close graph"
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
          onScroll={onScroll}
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
                  if (e.key === "Enter" || e.key === " ") {
                    // Without this, Space selected the commit AND scrolled the graph a page
                    // down, losing the row the user had just picked.
                    e.preventDefault();
                    setSelected(node);
                  }
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
          {!snapshot.hasMore && snapshot.shallow && (
            <p className="p-2 text-center text-amber-400/80 text-[10.5px]">
              History may be incomplete (this is a shallow clone).
            </p>
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
