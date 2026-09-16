import { useMemo, useState } from "react";
import type { RepoEntry } from "../../services/git/registry";
import { useRepoSnapshot } from "../../services/git/hooks";
import { GitMenu } from "./GitMenu";
import { buildGitCommandMenu } from "./gitCommandMenu";
import { syncAction } from "./syncAction";
import { ChevronIcon } from "../ui/FileIcons";
import { CloseIcon, FolderPlusIcon, GitBranchIcon, MoreIcon, SyncIcon } from "../ui/Icons";

type SortOrder = "discovery" | "name" | "path";

function repoName(root: string): string {
  return root.split("/").filter(Boolean).pop() || root;
}

function RepoRow({
  entry,
  active,
  dirty,
  message,
  onSelect,
  onRemove,
  onCommitted,
  onOpenBranches,
}: {
  entry: RepoEntry;
  active: boolean;
  dirty: boolean;
  message: string;
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
        active ? "bg-[#0e0e0e]" : "hover:bg-[#101010]"
      }`}
    >
      <GitBranchIcon size={13} className="shrink-0 text-zinc-500" />
      <span className="flex-1 truncate text-zinc-200">{repoName(entry.root)}</span>
      {snapshot?.branch.name && (
        <span className="shrink-0 text-zinc-500 text-[11px] font-mono">
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
        className="p-1 rounded text-zinc-500 hover:text-zinc-200 hover:bg-[#1e1e1e] shrink-0 disabled:opacity-40"
      >
        <SyncIcon size={12} className={busy ? "animate-spin" : ""} />
      </button>
      <div onClick={(e) => e.stopPropagation()} className="shrink-0">
        <GitMenu
          icon={<MoreIcon size={14} />}
          label={`${repoName(entry.root)} actions`}
          buttonClassName="p-1 rounded text-zinc-500 hover:text-zinc-200 hover:bg-[#1e1e1e]"
          items={buildGitCommandMenu({ entry, dirty, message, onCommitted, onOpenBranches })}
        />
      </div>
      <button
        aria-label={`Remove ${repoName(entry.root)} from Source Control`}
        title="Remove from Source Control"
        onClick={(e) => {
          e.stopPropagation();
          onRemove();
        }}
        className="p-1 rounded text-zinc-500 hover:text-zinc-200 hover:bg-[#1e1e1e] opacity-0 group-hover/repo:opacity-100 shrink-0"
      >
        <CloseIcon size={11} />
      </button>
    </div>
  );
}

export function RepositoriesSection({
  repos,
  activeRepoId,
  dirty,
  message,
  collapsed,
  onToggleCollapse,
  onSelect,
  onRemove,
  onAdd,
  onCommitted,
  onOpenBranches,
}: {
  repos: RepoEntry[];
  activeRepoId: string | null;
  dirty: boolean;
  message: string;
  collapsed: boolean;
  onToggleCollapse: () => void;
  onSelect: (repoId: string) => void;
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
    <section aria-label="Repositories" className="text-xs shrink-0 border-b border-[#141414]">
      <div
        onClick={onToggleCollapse}
        className="flex items-center gap-1.5 px-2.5 py-1.5 cursor-pointer hover:bg-[#0c0c0c] transition-colors group/header"
      >
        <ChevronIcon isExpanded={!collapsed} className="size-3" />
        <span className="font-semibold text-[11px] uppercase tracking-wider text-zinc-400 flex-1">
          Repositories
        </span>
        <div
          className="flex items-center gap-0.5 opacity-0 group-hover/header:opacity-100 transition-opacity"
          onClick={(e) => e.stopPropagation()}
        >
          <button
            onClick={onAdd}
            title="Add Repository Folder"
            className="p-1 rounded text-zinc-500 hover:text-zinc-200 hover:bg-[#1e1e1e]"
          >
            <FolderPlusIcon size={13} />
          </button>
          <GitMenu
            icon={<MoreIcon size={14} />}
            label="Repositories actions"
            buttonClassName="p-1 rounded text-zinc-500 hover:text-zinc-200 hover:bg-[#1e1e1e]"
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
        <div className="divide-y divide-[#0c0c0c]">
          {sorted.map((entry) => (
            <RepoRow
              key={entry.repoId}
              entry={entry}
              active={entry.repoId === activeRepoId}
              dirty={dirty}
              message={message}
              onSelect={() => onSelect(entry.repoId)}
              onRemove={() => onRemove(entry.repoId)}
              onCommitted={onCommitted}
              onOpenBranches={() => {
                onSelect(entry.repoId);
                onOpenBranches();
              }}
            />
          ))}
        </div>
      )}
    </section>
  );
}
