import { useMemo, useState } from "react";
import type { RepoEntry } from "../../services/git/registry";
import type { Branch } from "../../services/git/parsers/branch";
import { divergence } from "../../services/git/parsers/branch";
import { syncAction } from "./syncAction";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  CheckIcon,
  GitBranchIcon,
  PlusIcon,
  RefreshIcon,
  TrashIcon,
} from "../ui/Icons";
import { ChevronIcon } from "../ui/FileIcons";

/**
 * The branch the active repository is on, always in view at the top of Source Control: its
 * name, how far it is from its upstream, and one Sync button. Opening it shows everything
 * about branches in one place -- a filterable list to switch to (and delete from), creating
 * one, Fetch / Pull / Push, reconciling a diverged branch, and publishing one with no
 * upstream. Every action goes through `guarded`, the panel's `guardedAffecting`.
 */
export function BranchBar({
  entry,
  branch,
  branches,
  remotes,
  dirty,
  busy,
  open,
  onToggle,
  guarded,
  onDeleteBranch,
}: {
  entry: RepoEntry;
  branch: Branch;
  branches: string[];
  remotes: string[];
  /** Unsaved editors: actions that rewrite the working tree are refused until they are saved. */
  dirty: boolean;
  busy: boolean;
  open: boolean;
  onToggle: (open: boolean) => void;
  guarded: (kind: string, operation: () => Promise<string>) => Promise<boolean>;
  onDeleteBranch: (name: string) => void;
}) {
  const repo = entry.store.repository;
  const sync = syncAction(entry, dirty);
  const state = divergence(branch);
  const [filter, setFilter] = useState("");
  const [newBranch, setNewBranch] = useState("");
  const [chosenRemote, setChosenRemote] = useState(remotes[0] ?? "");
  const remote = remotes.includes(chosenRemote) ? chosenRemote : (remotes[0] ?? "");

  const shown = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return needle ? branches.filter((name) => name.toLowerCase().includes(needle)) : branches;
  }, [branches, filter]);
  const label = branch.detached ? "detached HEAD" : branch.name || "no branch";

  return (
    <div className="shrink-0 border-b border-border">
      <div className="flex h-8 items-center gap-1 px-2">
        <button
          title="Branches and remotes"
          aria-label="Branches and remotes"
          aria-expanded={open}
          onClick={() => onToggle(!open)}
          className={`flex min-w-0 flex-1 items-center gap-1.5 rounded px-1.5 py-1 text-left transition-colors ${
            open ? "bg-accent/15 text-ink" : "text-ink-2 hover:bg-surface-hover hover:text-ink"
          }`}
        >
          <GitBranchIcon size={13} className="shrink-0 text-accent-hover" />
          <span
            className={`truncate text-[12px] font-medium ${branch.detached ? "text-yellow" : ""}`}
          >
            {label}
          </span>
          {branch.upstream && (branch.behind > 0 || branch.ahead > 0) && (
            <span
              className="flex shrink-0 items-center gap-1 font-mono text-[10.5px] text-ink-3"
              title={`${branch.behind} incoming, ${branch.ahead} outgoing (${branch.upstream})`}
            >
              {branch.behind > 0 && (
                <span className="flex items-center">
                  <ArrowDownIcon size={10} />
                  {branch.behind}
                </span>
              )}
              {branch.ahead > 0 && (
                <span className="flex items-center">
                  <ArrowUpIcon size={10} />
                  {branch.ahead}
                </span>
              )}
            </span>
          )}
          <ChevronIcon isExpanded={open} className="ml-auto size-3 shrink-0 text-ink-3" />
        </button>
        {branch.upstream ? (
          <button
            disabled={busy}
            onClick={() => sync.run(() => onToggle(true))}
            title={sync.title}
            aria-label="Sync Changes"
            className={`flex shrink-0 items-center gap-1 rounded px-2 py-1 text-[11px] transition-colors disabled:opacity-40 ${
              state === "diverged"
                ? "bg-yellow/15 text-yellow hover:bg-yellow/25"
                : "text-ink-2 hover:bg-surface-hover hover:text-ink"
            }`}
          >
            <RefreshIcon size={12} className={busy ? "animate-spin" : ""} />
            Sync
          </button>
        ) : (
          !branch.detached &&
          remotes.length > 0 && (
            <button
              disabled={busy || !remote}
              onClick={() => void guarded("publish", () => repo.publish(remote))}
              title={`Publish ${branch.name} to ${remote}`}
              className="flex shrink-0 items-center gap-1 rounded bg-accent/20 px-2 py-1 text-[11px] text-accent-hover transition-colors hover:bg-accent/30 disabled:opacity-40"
            >
              <ArrowUpIcon size={11} />
              Publish
            </button>
          )
        )}
      </div>

      {open && (
        <div className="space-y-2 px-2.5 pb-2.5">
          <input
            aria-label="Filter branches"
            placeholder="Filter branches"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            className="w-full rounded border border-border-strong bg-surface px-2 py-1 text-xs text-ink placeholder:text-ink-3 focus:border-accent focus:outline-none"
          />
          <div
            role="listbox"
            aria-label="Switch branch"
            aria-disabled={dirty || busy || undefined}
            className={`max-h-40 overflow-y-auto rounded border border-border py-0.5 ${
              dirty ? "opacity-60" : ""
            }`}
          >
            {branch.detached && (
              <p className="px-2 py-1 text-[11px] text-yellow">Detached HEAD: choose a branch</p>
            )}
            {shown.map((name) => {
              const current = !branch.detached && name === branch.name;
              return (
                <div
                  key={name}
                  role="option"
                  aria-selected={current}
                  aria-disabled={dirty || busy || undefined}
                  tabIndex={-1}
                  onClick={() => {
                    if (current || dirty || busy) return;
                    void guarded("switch", () => repo.switchBranch(name));
                  }}
                  className={`group/branch flex h-6 items-center gap-1.5 px-2 text-[11.5px] ${
                    current
                      ? "text-ink"
                      : dirty || busy
                        ? "cursor-not-allowed text-ink-3"
                        : "cursor-pointer text-ink-2 hover:bg-surface-hover hover:text-ink"
                  }`}
                >
                  <span className="flex w-3 shrink-0 justify-center text-accent-hover">
                    {current && <CheckIcon size={11} />}
                  </span>
                  <span className="min-w-0 flex-1 truncate font-mono">{name}</span>
                  {/* The checked-out branch cannot be deleted: Git always refuses. */}
                  {!current && (
                    <button
                      aria-label={`Delete ${name}`}
                      title={`Delete ${name}`}
                      onClick={(event) => {
                        event.stopPropagation();
                        onDeleteBranch(name);
                      }}
                      className="rounded p-0.5 text-ink-3 opacity-0 transition-opacity hover:bg-red/15 hover:text-red group-hover/branch:opacity-100 focus:opacity-100"
                    >
                      <TrashIcon size={11} />
                    </button>
                  )}
                </div>
              );
            })}
            {shown.length === 0 && (
              <p className="px-2 py-1 text-[11px] text-ink-3">
                {branches.length ? "No branch matches." : "No branches yet."}
              </p>
            )}
          </div>

          <div className="flex gap-1">
            <input
              aria-label="New branch name"
              placeholder="New branch name"
              value={newBranch}
              onChange={(event) => setNewBranch(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && newBranch.trim() && !dirty)
                  void guarded("branch", () => repo.createBranch(newBranch)).then(
                    (ok) => ok && setNewBranch(""),
                  );
              }}
              className="min-w-0 flex-1 rounded border border-border-strong bg-surface px-2 py-1 text-xs text-ink placeholder:text-ink-3 focus:border-accent focus:outline-none"
            />
            <button
              disabled={dirty || !newBranch.trim()}
              onClick={() =>
                void guarded("branch", () => repo.createBranch(newBranch)).then(
                  (ok) => ok && setNewBranch(""),
                )
              }
              title="Create a branch here and switch to it"
              className="flex shrink-0 items-center gap-1 rounded bg-surface-hover px-2 py-1 text-[11px] text-ink transition-colors hover:bg-border-strong disabled:opacity-40"
            >
              <PlusIcon size={11} />
              Create
            </button>
          </div>

          {state === "diverged" && (
            <div className="space-y-1.5 rounded border border-yellow/30 bg-yellow/10 p-2">
              <p className="text-[11px] text-ink-2">
                Diverged: {branch.ahead} local and {branch.behind} remote commits.
              </p>
              <p className="text-[10.5px] text-ink-3">
                Neither choice stashes your work — save or commit anything you want to keep first.
              </p>
              <div className="flex gap-1.5">
                <button
                  disabled={dirty}
                  onClick={() => void guarded("pullRebase", () => repo.pullRebase())}
                  className="flex-1 rounded bg-surface-hover py-1 text-[11px] text-ink-2 transition-colors hover:bg-border-strong disabled:opacity-40"
                >
                  Rebase
                </button>
                <button
                  disabled={dirty}
                  onClick={() => void guarded("pullMerge", () => repo.pullMerge())}
                  className="flex-1 rounded bg-surface-hover py-1 text-[11px] text-ink-2 transition-colors hover:bg-border-strong disabled:opacity-40"
                >
                  Merge
                </button>
              </div>
            </div>
          )}

          <div className="flex gap-1.5">
            <button
              onClick={() => void guarded("fetch", () => repo.fetch())}
              className="flex-1 rounded bg-surface-hover py-1 text-[11px] text-ink-2 transition-colors hover:bg-border-strong disabled:opacity-40"
            >
              Fetch
            </button>
            {branch.upstream && (
              <button
                disabled={dirty || state === "diverged"}
                title={
                  state === "diverged"
                    ? "Fast-forward pull is unavailable; choose Rebase or Merge instead."
                    : undefined
                }
                onClick={() => void guarded("pull", () => repo.pull())}
                className="flex-1 rounded bg-surface-hover py-1 text-[11px] text-ink-2 transition-colors hover:bg-border-strong disabled:opacity-40"
              >
                Pull
              </button>
            )}
            {branch.upstream && (
              <button
                onClick={() => void guarded("push", () => repo.push())}
                className="flex-1 rounded bg-surface-hover py-1 text-[11px] text-ink-2 transition-colors hover:bg-border-strong disabled:opacity-40"
              >
                Push
              </button>
            )}
          </div>

          {branch.detached && (
            <p className="text-[11px] text-ink-3">
              HEAD is detached, so there is no branch to publish. Switch to a branch, or create one
              here first.
            </p>
          )}
          {!branch.upstream &&
            !branch.detached &&
            (remotes.length === 0 ? (
              <p className="text-[11px] text-ink-3">
                No remote is configured. Add one with `git remote add` to publish this branch.
              </p>
            ) : (
              <div className="flex gap-1">
                <select
                  aria-label="Remote"
                  value={remote}
                  onChange={(event) => setChosenRemote(event.target.value)}
                  className="min-w-0 flex-1 rounded border border-border-strong bg-surface px-2 py-1 text-xs text-ink-2 focus:border-accent focus:outline-none"
                >
                  {remotes.map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </select>
                <button
                  disabled={!remote}
                  onClick={() => void guarded("publish", () => repo.publish(remote))}
                  className="shrink-0 rounded bg-surface-hover px-2 py-1 text-[11px] text-ink transition-colors hover:bg-border-strong disabled:opacity-40"
                >
                  Publish branch
                </button>
              </div>
            ))}
        </div>
      )}
    </div>
  );
}
