import { useMemo, useState } from "react";
import type { RepoEntry, RepositoryEntry } from "../../services/git/registry";
import type { WorktreeInfo } from "../../services/git/parsers/worktree";
import { useRepoSnapshot } from "../../services/git/hooks";
import { GitMenu } from "./GitMenu";
import { buildGitCommandMenu } from "./gitCommandMenu";
import { syncAction } from "./syncAction";
import { ChevronIcon } from "../ui/FileIcons";
import {
  CloseIcon,
  FolderPlusIcon,
  GitBranchIcon,
  LockIcon,
  MoreIcon,
  SyncIcon,
} from "../ui/Icons";

type SortOrder = "discovery" | "name" | "path";

function repoName(root: string): string {
  return root.split("/").filter(Boolean).pop() || root;
}

/** `WorktreeInfo.path` comes straight from Git's own output; compare loosely with an
 * already-tracked worktree's canonicalized `root` the same way `registry.ts` does. */
function sameWorktree(root: string, path: string): boolean {
  return root.toLowerCase() === path.replace(/\\/g, "/").toLowerCase();
}

/** The worktrees `git worktree list` reports for a repository that aren't tracked
 * (opened) yet -- shown as inert, switchable rows, never given a live `RepoStore`
 * merely by being listed here. */
function UntrackedWorktrees({
  knownWorktrees,
  tracked,
  onSelect,
}: {
  knownWorktrees: WorktreeInfo[];
  tracked: RepoEntry[];
  onSelect: (path: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const untracked = knownWorktrees.filter(
    (info) => !tracked.some((w) => sameWorktree(w.root, info.path)),
  );
  if (!untracked.length) return null;

  return (
    <div className="pl-6 pb-1">
      <button
        onClick={() => setExpanded((was) => !was)}
        className="flex items-center gap-1 py-0.5 text-[10.5px] text-ink-3 hover:text-ink"
      >
        <ChevronIcon isExpanded={expanded} className="size-2.5" />
        {untracked.length} more worktree{untracked.length === 1 ? "" : "s"}
      </button>
      {expanded && (
        <div className="space-y-0.5">
          {untracked.map((info) => (
            <div
              key={info.path}
              className="flex items-center gap-1.5 py-0.5 text-[11px] text-ink-2"
            >
              <GitBranchIcon size={11} className="shrink-0 text-ink-3" />
              <span className="truncate flex-1">
                {info.detached ? `detached @ ${info.headHash.slice(0, 7)}` : info.branch}
              </span>
              {info.locked && (
                <span title={info.lockedReason || "Locked"} className="shrink-0 text-amber-500/80">
                  <LockIcon size={10} />
                </span>
              )}
              {info.prunable && (
                <span
                  title={info.prunableReason || "Prunable: the working directory is missing"}
                  className="shrink-0 rounded border border-rose-500/30 bg-rose-500/10 px-1 text-[9.5px] text-rose-400"
                >
                  prunable
                </span>
              )}
              <button
                onClick={() => onSelect(info.path)}
                title={`Open worktree ${info.path}`}
                aria-label={`Open worktree ${info.path}`}
                className="shrink-0 rounded px-1.5 py-0.5 text-[10px] text-ink-2 hover:bg-surface-hover hover:text-ink"
              >
                Open
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function RepoRow({
  entry,
  active,
  dirty,
  hasMessage,
  getMessage,
  onSelect,
  onRemove,
  onCommitted,
  onOpenBranches,
}: {
  entry: RepoEntry;
  active: boolean;
  dirty: boolean;
  hasMessage: boolean;
  getMessage: () => string;
  onSelect: () => void;
  onRemove: () => void;
  onCommitted: () => void;
  onOpenBranches: () => void;
}) {
  const snapshot = useRepoSnapshot(entry.store);
  const hasChanges = (snapshot?.entries.length ?? 0) > 0;
  const busy = snapshot?.busy || snapshot?.loading;
  const sync = syncAction(entry, dirty);

  return (
    <div
      role="group"
      aria-label={repoName(entry.root)}
      onClick={onSelect}
      className={`group/repo flex items-center gap-1.5 px-2.5 py-1.5 text-[12px] cursor-pointer transition-colors ${
        active ? "bg-surface" : "hover:bg-surface-hover"
      }`}
    >
      <GitBranchIcon size={13} className="shrink-0 text-ink-3" />
      <span className="flex-1 truncate text-ink">{repoName(entry.root)}</span>
      {snapshot?.branch.name && (
        <span className="shrink-0 text-ink-3 text-[11px] font-mono">
          {snapshot.branch.name}
          {hasChanges ? "*" : ""}
        </span>
      )}
      <button
        title={sync.title}
        aria-label={`Sync ${repoName(entry.root)}`}
        disabled={busy}
        onClick={(e) => {
          e.stopPropagation();
          sync.run(onOpenBranches);
        }}
        className="p-1 rounded text-ink-3 hover:text-ink hover:bg-surface-hover shrink-0 disabled:opacity-40"
      >
        <SyncIcon size={12} className={busy ? "animate-spin" : ""} />
      </button>
      <div onClick={(e) => e.stopPropagation()} className="shrink-0">
        <GitMenu
          icon={<MoreIcon size={14} />}
          label={`${repoName(entry.root)} actions`}
          buttonClassName="p-1 rounded text-ink-3 hover:text-ink hover:bg-surface-hover"
          items={buildGitCommandMenu({
            entry,
            dirty,
            hasMessage,
            getMessage,
            onCommitted,
            onOpenBranches,
          })}
        />
      </div>
      <button
        aria-label={`Remove ${repoName(entry.root)} from Source Control`}
        title="Remove from Source Control"
        onClick={(e) => {
          e.stopPropagation();
          onRemove();
        }}
        className="p-1 rounded text-ink-3 hover:text-ink hover:bg-surface-hover opacity-0 group-hover/repo:opacity-100 shrink-0"
      >
        <CloseIcon size={11} />
      </button>
    </div>
  );
}

/** The `RepositoryEntry` that owns a tracked worktree, so its row can offer the rest
 * of that repository's known-but-unopened worktrees. */
function ownerOf(repositories: RepositoryEntry[], entry: RepoEntry): RepositoryEntry | undefined {
  return repositories.find((r) => r.worktrees.includes(entry));
}

export function RepositoriesSection({
  repos,
  repositories,
  activeRepoId,
  dirty,
  hasMessage,
  getMessage,
  collapsed,
  onToggleCollapse,
  onSelect,
  onSelectWorktree,
  onRemove,
  onAdd,
  onCommitted,
  onOpenBranches,
}: {
  repos: RepoEntry[];
  /** Grouped view of the same worktrees, for the "N more worktrees" affordance. */
  repositories: RepositoryEntry[];
  activeRepoId: string | null;
  dirty: boolean;
  hasMessage: boolean;
  getMessage: () => string;
  collapsed: boolean;
  onToggleCollapse: () => void;
  onSelect: (repoId: string) => void;
  /** Opens (and switches to) a worktree Git reports but Yavin hasn't tracked yet. */
  onSelectWorktree: (path: string) => void;
  onRemove: (repoId: string) => void;
  onAdd: () => void;
  onCommitted: () => void;
  onOpenBranches: () => void;
}) {
  const [sort, setSort] = useState<SortOrder>("discovery");

  const sorted = useMemo(() => {
    if (sort === "discovery") return repos;
    const list = [...repos];
    if (sort === "name") list.sort((a, b) => repoName(a.root).localeCompare(repoName(b.root)));
    else list.sort((a, b) => a.root.localeCompare(b.root));
    return list;
  }, [repos, sort]);

  return (
    <section aria-label="Repositories" className="text-xs shrink-0 border-b border-border">
      <div
        onClick={onToggleCollapse}
        className="flex items-center gap-1.5 px-2.5 py-1.5 cursor-pointer hover:bg-surface-hover transition-colors group/header"
      >
        <ChevronIcon isExpanded={!collapsed} className="size-3" />
        <span className="font-semibold text-[11px] uppercase tracking-wider text-ink-2 flex-1">
          Repositories
        </span>
        <div
          className="flex items-center gap-0.5 opacity-0 group-hover/header:opacity-100 transition-opacity"
          onClick={(e) => e.stopPropagation()}
        >
          <button
            onClick={onAdd}
            title="Add Repository Folder"
            aria-label="Add Repository Folder"
            className="p-1 rounded text-ink-3 hover:text-ink hover:bg-surface-hover"
          >
            <FolderPlusIcon size={13} />
          </button>
          <GitMenu
            icon={<MoreIcon size={14} />}
            label="Repositories actions"
            buttonClassName="p-1 rounded text-ink-3 hover:text-ink hover:bg-surface-hover"
            items={[
              {
                label: "Sort by Discovery Time",
                checked: sort === "discovery",
                onSelect: () => setSort("discovery"),
              },
              { label: "Sort by Name", checked: sort === "name", onSelect: () => setSort("name") },
              { label: "Sort by Path", checked: sort === "path", onSelect: () => setSort("path") },
            ]}
          />
        </div>
      </div>
      {!collapsed && (
        <div className="divide-y divide-border">
          {sorted.map((entry) => {
            const owner = ownerOf(repositories, entry);
            return (
              <div key={entry.repoId}>
                <RepoRow
                  entry={entry}
                  active={entry.repoId === activeRepoId}
                  dirty={dirty}
                  hasMessage={hasMessage}
                  getMessage={getMessage}
                  onSelect={() => onSelect(entry.repoId)}
                  onRemove={() => onRemove(entry.repoId)}
                  onCommitted={onCommitted}
                  onOpenBranches={() => {
                    onSelect(entry.repoId);
                    onOpenBranches();
                  }}
                />
                {owner && (
                  <UntrackedWorktrees
                    knownWorktrees={owner.knownWorktrees}
                    tracked={owner.worktrees}
                    onSelect={onSelectWorktree}
                  />
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
