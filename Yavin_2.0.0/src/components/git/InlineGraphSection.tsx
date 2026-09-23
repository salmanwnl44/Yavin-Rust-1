import { useEffect, useMemo, useRef, useState } from "react";
import type { RepoEntry } from "../../services/git/registry";
import { useCommitGraph, useRepoSnapshot } from "../../services/git/hooks";
import { guardedAffecting } from "../../services/git/sync";
import { GRAPH_COLOR_COUNT } from "../../services/git/graph/model";
import type { GraphScope } from "../../services/git/graph/incremental.ts";
import { parseCommitDetails } from "../../services/git/parsers/log";
import { CommitHoverCard } from "./CommitHoverCard";
import { useCommitHover } from "./useCommitHover";
import type {
  CommitDetailedInfo,
  CommitFileChange,
  RawCommit,
} from "../../services/git/parsers/log";
import { buildFileTree, flattenVisible } from "../../services/git/fileTree";
import { defaultRemoteWebLink, openExternalUrl } from "../../services/git/remoteUrl";
import type { RemoteWebLink } from "../../services/git/remoteUrl";
import type { DiffDocument } from "../layout/DiffEditor";
import type { DialogRequest } from "../ui/AppDialog";
import { ChevronIcon, FileIcon } from "../ui/FileIcons";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  CloseIcon,
  CopyIcon,
  ExternalLinkIcon,
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

/** The commit selected in the sidebar graph, with its detail shown below the row list (not
 * interleaved between rows -- the SVG connector lines are keyed to each row's fixed
 * `row * ROW_HEIGHT` position, which a variable-height row inserted between them would
 * disturb; showing the detail below the whole list keeps that untouched). */
function InlineCommitDetail({
  commit,
  repository,
  onClose,
  onDiff,
  viewAsTree,
  onToggleViewAsTree,
}: {
  commit: RawCommit;
  repository: import("../../services/git/repository").Repository;
  onClose: () => void;
  onDiff: (document: DiffDocument) => void;
  /** Owned by the section so the graph's "..." menu can toggle it too, not just the
   * inline Tree/List button. */
  viewAsTree: boolean;
  onToggleViewAsTree: () => void;
}) {
  const [detail, setDetail] = useState<CommitDetailedInfo | null>(null);
  const [remoteLink, setRemoteLink] = useState<RemoteWebLink | null>(null);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [collapsedFolders, setCollapsedFolders] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    setDetail(null);
    setError("");
    // The message body is deliberately not fetched here: the hover card carries it, and this
    // view is about the files.
    Promise.all([
      repository.commitDetails(commit.fullHash),
      defaultRemoteWebLink(repository).catch(() => null),
    ])
      .then(([output, link]) => {
        if (cancelled) return;
        setDetail(parseCommitDetails(output));
        setRemoteLink(link);
      })
      .catch((reason) => !cancelled && setError(String(reason)));
    return () => {
      cancelled = true;
    };
  }, [repository, commit.fullHash]);

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

  const openFileDiff = ({ path, oldPath }: CommitFileChange) => {
    repository
      .commitFileDiff(commit.fullHash, path, oldPath)
      .then((text) =>
        onDiff({
          path,
          title: `${commit.hash} — ${path}`,
          text: text || "No textual differences. The change may be metadata or binary only.",
        }),
      )
      .catch((reason) => setError(String(reason)));
  };

  const fileRow = (file: CommitFileChange, depth = 0, nested = false) => (
    <li key={file.path}>
      <button
        onClick={() => openFileDiff(file)}
        title={`Show the diff for ${file.oldPath ? `${file.oldPath} → ` : ""}${file.path} in this commit`}
        style={{ paddingLeft: `${4 + depth * 14}px` }}
        className="flex w-full items-center gap-1.5 py-1 pr-1 text-[11px] text-ink-2 hover:bg-surface-hover rounded"
      >
        <span className="font-mono text-[10px] text-ink-3 w-3 shrink-0">{file.status}</span>
        <span className="truncate flex-1 text-left">
          {nested ? file.path.slice(file.path.lastIndexOf("/") + 1) : file.path}
        </span>
      </button>
    </li>
  );

  return (
    <div className="border-t border-border bg-surface/40 text-[11px]">
      <div className="flex items-center justify-between px-2 py-1.5">
        <p className="text-ink font-medium truncate flex-1">{commit.subject}</p>
        <button
          onClick={onClose}
          title="Close commit details"
          aria-label="Close commit details"
          className="p-0.5 rounded text-ink-3 hover:text-ink hover:bg-surface-hover shrink-0"
        >
          <CloseIcon size={11} />
        </button>
      </div>
      {/* The message and the author are not repeated here: they are in the hover card, and
          in this width a multi-paragraph commit message pushed the changed files -- the
          reason for expanding a commit at all -- off the bottom of the panel. */}
      <div className="px-2 pb-1.5 space-y-1">
        <div className="flex items-center gap-1.5 text-ink-3">
          <span className="font-mono">{commit.hash}</span>
          <button
            title="Copy the full commit hash"
            aria-label="Copy commit hash"
            onClick={() => {
              // Clipboard access is refused outside a secure context; report that rather
              // than leaving the button looking inert.
              navigator.clipboard.writeText(commit.fullHash).then(
                () => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                },
                () => setError("Could not copy the hash to the clipboard."),
              );
            }}
            className="p-0.5 rounded hover:bg-surface-hover hover:text-ink"
          >
            <CopyIcon size={10} />
          </button>
          {copied && <span className="text-green">Copied</span>}
          {remoteLink && (
            <button
              title={`Open this commit on ${remoteLink.label}`}
              onClick={() => void openExternalUrl(`${remoteLink.url}/commit/${commit.fullHash}`)}
              className="ml-auto flex items-center gap-1 text-accent hover:text-accent-hover"
            >
              <ExternalLinkIcon size={9} />
              Open on {remoteLink.label}
            </button>
          )}
        </div>
        {error && <p className="text-red">{error}</p>}
        {detail && (
          <>
            <div className="flex items-center justify-between">
              <p className="text-ink-3">
                {detail.filesChanged} file{detail.filesChanged === 1 ? "" : "s"} changed
                {detail.insertions > 0 && <span className="text-green"> +{detail.insertions}</span>}
                {detail.deletions > 0 && <span className="text-red"> −{detail.deletions}</span>}
              </p>
              {detail.files.length > 0 && (
                <button
                  title={viewAsTree ? "View as List" : "View as Tree"}
                  aria-label={viewAsTree ? "View as List" : "View as Tree"}
                  onClick={onToggleViewAsTree}
                  className="rounded px-1 text-[10px] text-ink-3 hover:text-ink hover:bg-surface-hover"
                >
                  {viewAsTree ? "List" : "Tree"}
                </button>
              )}
            </div>
            <ul className="max-h-[160px] overflow-y-auto">
              {viewAsTree
                ? treeRows!.map((row) =>
                    row.node.kind === "folder" ? (
                      <li key={`folder:${row.node.path}`}>
                        <button
                          aria-label={`${row.expanded ? "Collapse" : "Expand"} ${row.node.name}`}
                          style={{ paddingLeft: `${4 + row.depth * 14}px` }}
                          onClick={() => toggleFolder(row.node.path)}
                          className="flex w-full items-center gap-1.5 py-1 text-[11px] text-ink-2 hover:bg-surface-hover rounded"
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
    </div>
  );
}

export function InlineGraphSection({
  entry,
  dirty,
  collapsed,
  onToggleCollapse,
  onExpand,
  onDiff,
  onDialog,
}: {
  entry: RepoEntry | null;
  dirty: boolean;
  collapsed: boolean;
  onToggleCollapse: () => void;
  onExpand?: () => void;
  /** Opens the selected commit's file diff -- omitted call sites (a background repo row has
   * none) simply don't get inline commit selection. */
  onDiff?: (document: DiffDocument) => void;
  onDialog?: (request: DialogRequest) => void;
}) {
  const { snapshot, loadMore, reset, setScope } = useCommitGraph(entry?.store.repository);
  // A second operation on the same worktree is refused while one runs, and the refusal's notice
  // is replaced by the first operation's own result a moment later -- so a click here during a
  // commit vanished without a trace. Disable the network buttons instead of inviting that.
  const repo = useRepoSnapshot(entry?.store);
  const busy = repo?.busy ?? false;
  const [selected, setSelected] = useState<RawCommit | null>(null);
  // Owned here rather than inside the detail panel so the "..." menu's View as List/Tree
  // items drive the same state the panel's own Tree/List button does -- the menu entry was
  // previously a permanently-disabled label with nothing behind it.
  const [filesAsTree, setFilesAsTree] = useState(false);
  // Resting on a commit shows what it is without opening it; see `CommitHoverCard`. Declared
  // with the other hooks, above the early return for "no repository open".
  // Given the section's own box so the card can sit beside it rather than over the commits.
  const sectionRef = useRef<HTMLElement | null>(null);
  const { hovered, rowHandlers, cardHandlers } = useCommitHover(sectionRef);
  // Measured rather than guessed: the detail's height depends on the commit's message and
  // how many files it touched, both of which arrive after it first renders.
  const [detailHeight, setDetailHeight] = useState(0);
  const detailRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const element = detailRef.current;
    if (!element) {
      setDetailHeight(0);
      return;
    }
    const measure = () => setDetailHeight(element.getBoundingClientRect().height);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [selected]);

  useEffect(() => {
    setSelected((current) =>
      current && !snapshot.commits.some((c) => c.fullHash === current.fullHash) ? null : current,
    );
  }, [snapshot.commits]);

  if (!entry) return null;

  const visible = snapshot.layout.nodes.slice(0, VISIBLE_COUNT);
  const edges = snapshot.layout.edges.filter((e) => e.fromRow < VISIBLE_COUNT);
  const gutterWidth = Math.max(1, Math.min(snapshot.layout.laneCount, 4)) * LANE_WIDTH + 6;
  const totalHeight = visible.length * ROW_HEIGHT;
  /**
   * Where the selected commit sits, and how far everything below it has to move.
   *
   * The detail belongs under the commit it describes -- shown after the whole list, the
   * files for the commit you clicked appeared thirty rows further down. Rows are positioned
   * at `row * ROW_HEIGHT` and the connectors are keyed to the same coordinates, so opening
   * one means offsetting both by the detail's measured height, which is what `shift` is.
   * A selected commit that is not in the visible slice offsets nothing.
   */
  const selectedRow = selected
    ? visible.findIndex((node) => node.commit.fullHash === selected.fullHash)
    : -1;
  const expanded = selectedRow >= 0 ? detailHeight : 0;
  const shift = (row: number) => (selectedRow >= 0 && row > selectedRow ? expanded : 0);
  // The incoming-changes node sits in HEAD's own lane, so it reads as the commits that are
  // about to land on this branch rather than a stray mark in lane 0.
  const incomingLane =
    (visible.find((n) => n.commit.refs.some((r) => r.kind === "head")) ?? visible[0])?.lane ?? 0;

  // guardedAffecting resets the repository's shared GraphLoader itself for every operation
  // that changes what the graph shows (see sync.ts's GRAPH_RESETS). Since the loader is
  // shared, that reset is visible through this same `reset`/`snapshot` pair without an
  // extra manual call.
  const run = (kind: string, op: () => Promise<string>) =>
    void guardedAffecting(entry, kind, dirty, op);

  const scopeLabel =
    snapshot.scope === "auto" ? "Auto" : snapshot.scope === "all" ? "All" : snapshot.scope;
  const openScopePicker = () => {
    if (!onDialog) return;
    const branches = repo?.branches ?? [];
    const remoteBranches = repo?.remoteBranches ?? [];
    onDialog({
      title: "Show history for",
      options: [
        { value: "auto", label: "Auto", description: "The current branch's own history" },
        { value: "all", label: "All", description: "Every branch and remote-tracking ref" },
        ...branches.map((name) => ({ value: name, label: name })),
        // Remote-tracking branches are the other half of the question this picker asks:
        // "what does origin have that I do not" is answered by picking `origin/main`.
        ...remoteBranches.map((name) => ({
          value: name,
          label: name,
          description: "Remote branch",
        })),
      ],
      submit: (value) => void setScope(value as GraphScope),
    });
  };

  return (
    <section ref={sectionRef} aria-label="Graph" className="text-xs flex flex-col min-h-0">
      <div
        onClick={onToggleCollapse}
        className="flex items-center gap-1.5 px-2 h-7 cursor-pointer hover:bg-surface-hover transition-colors shrink-0 border-t border-border"
      >
        <ChevronIcon isExpanded={!collapsed} className="size-3" />
        <span className="font-semibold text-[12px] text-ink">Graph</span>
        {onDialog ? (
          <button
            title="Change which history is shown"
            aria-label="Change which history is shown"
            onClick={(e) => {
              e.stopPropagation();
              openScopePicker();
            }}
            className="text-ink-3 text-[10px] rounded px-1 hover:bg-surface-hover hover:text-ink"
          >
            {scopeLabel}
          </button>
        ) : (
          <span className="text-ink-3 text-[10px]">{scopeLabel}</span>
        )}
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
              {
                label: "View as List",
                checked: !filesAsTree,
                onSelect: () => setFilesAsTree(false),
              },
              {
                label: "View as Tree",
                checked: filesAsTree,
                onSelect: () => setFilesAsTree(true),
              },
            ]}
          />
        </div>
      </div>

      {!collapsed && (
        <div className="overflow-y-auto max-h-[320px]">
          {snapshot.notice && (
            <p role="status" className="px-3 py-1 text-[11px] text-red-400 break-words">
              {snapshot.notice}
            </p>
          )}
          {/* "Incoming Changes": a hollow, dashed node drawn in the graph's own lane geometry
              directly above HEAD and connected down to it, the way the reference shows it --
              not a detached text row. It gets its own SVG of exactly one row rather than
              being spliced into the list below, so the main graph's `row * ROW_HEIGHT`
              coordinates (and every connector keyed to them) stay exactly as they were. */}
          {repo && repo.branch.behind > 0 && (
            <div style={{ position: "relative", height: ROW_HEIGHT }}>
              <svg
                width={gutterWidth}
                height={ROW_HEIGHT}
                style={{ position: "absolute", top: 0, left: 0, pointerEvents: "none" }}
                aria-hidden="true"
              >
                <line
                  x1={laneX(incomingLane)}
                  y1={ROW_HEIGHT / 2}
                  x2={laneX(incomingLane)}
                  y2={ROW_HEIGHT}
                  stroke="#71717a"
                  strokeWidth={1.25}
                  strokeDasharray="2 2"
                />
                <circle
                  cx={laneX(incomingLane)}
                  cy={ROW_HEIGHT / 2}
                  r={NODE_RADIUS}
                  fill="none"
                  stroke="#71717a"
                  strokeWidth={1.25}
                  strokeDasharray="2 1.5"
                />
              </svg>
              <div
                title={`${repo.branch.behind} commit${repo.branch.behind === 1 ? "" : "s"} on ${repo.branch.upstream || "the remote"} not yet in this branch`}
                style={{
                  position: "absolute",
                  top: 0,
                  left: gutterWidth,
                  right: 0,
                  height: ROW_HEIGHT,
                }}
                className="flex items-center gap-1.5 px-1.5 text-[11px] text-ink-3"
              >
                <span className="italic">Incoming Changes</span>
                <span className="truncate">{repo.branch.upstream}</span>
                <span className="ml-auto shrink-0 rounded-full border border-dashed border-ink-3 px-1.5 text-[9.5px]">
                  {repo.branch.behind}
                </span>
              </div>
            </div>
          )}
          <div style={{ position: "relative", height: totalHeight + expanded }}>
            <svg
              width={gutterWidth}
              height={totalHeight + expanded}
              style={{ position: "absolute", top: 0, left: 0, pointerEvents: "none" }}
            >
              {edges.map((edge, i) => {
                const x1 = laneX(edge.fromLane);
                const y1 = edge.fromRow * ROW_HEIGHT + ROW_HEIGHT / 2 + shift(edge.fromRow);
                const x2 = laneX(edge.toLane);
                const toRow =
                  edge.toRow !== null && edge.toRow < VISIBLE_COUNT ? edge.toRow : VISIBLE_COUNT;
                const y2 = toRow * ROW_HEIGHT + ROW_HEIGHT / 2 + shift(toRow);
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
                    cy={node.row * ROW_HEIGHT + ROW_HEIGHT / 2 + shift(node.row)}
                    r={NODE_RADIUS}
                    fill={isHead ? "#000" : colorFor(node.color)}
                    stroke={colorFor(node.color)}
                    strokeWidth={isHead ? 1.5 : 0}
                  />
                );
              })}
            </svg>
            {visible.map((node) => {
              const isSelected = selected?.fullHash === node.commit.fullHash;
              return (
                <div
                  key={node.commit.fullHash}
                  role={onDiff ? "button" : undefined}
                  tabIndex={onDiff ? 0 : undefined}
                  aria-selected={onDiff ? isSelected : undefined}
                  onClick={onDiff ? () => setSelected(isSelected ? null : node.commit) : undefined}
                  onKeyDown={
                    onDiff
                      ? (e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            setSelected(isSelected ? null : node.commit);
                          }
                        }
                      : undefined
                  }
                  {...rowHandlers(node.commit)}
                  style={{
                    position: "absolute",
                    top: node.row * ROW_HEIGHT + shift(node.row),
                    left: gutterWidth,
                    right: 0,
                    height: ROW_HEIGHT,
                  }}
                  className={`flex items-center gap-1.5 px-1.5 text-[11px] truncate ${
                    onDiff ? "cursor-pointer" : ""
                  } ${isSelected ? "bg-accent/15" : "hover:bg-surface-hover"}`}
                >
                  <span className="truncate text-ink">{node.commit.subject}</span>
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
              );
            })}
            {/* Directly under the row it describes, inside the positioned list: the rows
                below it are offset by exactly this element's measured height. */}
            {selected && onDiff && selectedRow >= 0 && (
              <div
                ref={detailRef}
                style={{
                  position: "absolute",
                  top: (selectedRow + 1) * ROW_HEIGHT,
                  left: 0,
                  right: 0,
                }}
              >
                <InlineCommitDetail
                  commit={selected}
                  repository={entry.store.repository}
                  onClose={() => setSelected(null)}
                  onDiff={onDiff}
                  viewAsTree={filesAsTree}
                  onToggleViewAsTree={() => setFilesAsTree((v) => !v)}
                />
              </div>
            )}
          </div>
          {hovered && (
            <CommitHoverCard
              commit={hovered.commit}
              repository={entry.store.repository}
              anchor={hovered.anchor}
              {...cardHandlers}
            />
          )}
          {/* Below the list only when the selected commit is not one of the rows on screen
              -- otherwise it is rendered inside the list, directly under its own row. */}
          {selected && onDiff && selectedRow < 0 && (
            <InlineCommitDetail
              commit={selected}
              repository={entry.store.repository}
              onClose={() => setSelected(null)}
              onDiff={onDiff}
              viewAsTree={filesAsTree}
              onToggleViewAsTree={() => setFilesAsTree((v) => !v)}
            />
          )}
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
