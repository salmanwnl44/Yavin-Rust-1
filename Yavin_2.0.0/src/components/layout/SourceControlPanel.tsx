import { useEffect, useRef, useState } from "react";
import { native } from "../../services/native";
import { divergence } from "../../services/git/parsers/branch";
import type { GitEntry } from "../../services/git/parsers/status";
import type { GitOperation } from "../../services/git/backend";
import { gitRegistry } from "../../services/git/registry";
import { useActiveRepo, useGitRegistry, useRepoSnapshot } from "../../services/git/hooks";
import { RepositoriesSection } from "../git/RepositoriesSection";
import { InlineGraphSection } from "../git/InlineGraphSection";
import { StashesSection } from "../git/StashesSection";
import { GitMenu } from "../git/GitMenu";
import { buildGitCommandMenu } from "../git/gitCommandMenu";
import type { DiffDocument } from "./DiffEditor";
import type { Replacement } from "./SearchPanel";
import { ChevronIcon, FileIcon } from "../ui/FileIcons";
import {
  AlertCircleIcon,
  CheckIcon,
  DiffIcon,
  GitBranchIcon,
  MinusIcon,
  MoreIcon,
  PlusIcon,
  RefreshIcon,
  UndoIcon,
} from "../ui/Icons";

const badgeStyles: Record<string, { badge: string; text: string }> = {
  M: { badge: "bg-amber-500/15 text-amber-400 border-amber-500/30", text: "text-amber-300" },
  U: {
    badge: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
    text: "text-emerald-400",
  },
  A: { badge: "bg-cyan-500/15 text-cyan-400 border-cyan-500/30", text: "text-cyan-300" },
  D: {
    badge: "bg-rose-500/15 text-rose-400 border-rose-500/30",
    text: "text-rose-400 line-through",
  },
  R: { badge: "bg-sky-500/15 text-sky-400 border-sky-500/30", text: "text-sky-300" },
  C: { badge: "bg-sky-500/15 text-sky-400 border-sky-500/30", text: "text-sky-300" },
  T: { badge: "bg-amber-500/15 text-amber-400 border-amber-500/30", text: "text-amber-300" },
  "!": { badge: "bg-red-500/15 text-red-400 border-red-500/30", text: "text-red-400" },
};

function getStatusInfo(entry: GitEntry, staged: boolean) {
  if (entry.conflict) return { letter: "!", style: badgeStyles["!"] };
  if (entry.untracked) return { letter: "U", style: badgeStyles["U"] };
  const letter = staged ? entry.index : entry.worktree;
  return {
    letter,
    style: badgeStyles[letter] || {
      badge: "bg-zinc-800 text-zinc-400 border-zinc-700",
      text: "text-zinc-300",
    },
  };
}

const OPERATION_LABEL: Record<Exclude<GitOperation, "">, string> = {
  merge: "Merge",
  rebase: "Rebase",
  "cherry-pick": "Cherry-pick",
  revert: "Revert",
};

/** Whether `path` is `root` itself or lies inside it (case-insensitive). */
function rootContains(root: string, path: string): boolean {
  const lowerRoot = root.toLowerCase();
  const lowerPath = path.toLowerCase();
  return lowerPath === lowerRoot || lowerPath.startsWith(`${lowerRoot}/`);
}

interface SectionVisibility {
  repositories: boolean;
  changes: boolean;
  graph: boolean;
  stashes: boolean;
}

export function SourceControlPanel({
  workspace,
  visible,
  buffers,
  dirty,
  revision,
  onDiff,
  onChanged,
  onEntries,
  apply,
  activeDiffPath,
  onOpenGraph,
}: {
  workspace: string;
  visible: boolean;
  buffers: Record<string, string>;
  dirty: boolean;
  revision: number;
  onDiff: (diff: DiffDocument | null) => void;
  onChanged: () => Promise<void>;
  onEntries: (entries: GitEntry[]) => void;
  apply: (changes: Replacement[]) => Promise<{ applied: Replacement[]; errors: string[] }>;
  activeDiffPath?: string;
  onOpenGraph?: () => void;
}) {
  const registrySnapshot = useGitRegistry();
  const activeRepo = useActiveRepo();
  const snapshot = useRepoSnapshot(activeRepo?.store);

  // The file explorer's badges always follow the repo that actually contains the
  // open workspace folder, independent of whichever repo the switcher has selected.
  const workspaceRepo =
    registrySnapshot.repos.find(
      (r) => rootContains(r.root, workspace) || rootContains(workspace, r.root),
    ) ?? null;
  const workspaceSnapshot = useRepoSnapshot(workspaceRepo?.store);

  const [openError, setOpenError] = useState("");
  const [message, setMessage] = useState("");
  const [newBranch, setNewBranch] = useState("");
  const [chosenRemote, setChosenRemote] = useState("");
  const [branchesOpen, setBranchesOpen] = useState(false);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [recovery, setRecovery] = useState<Replacement[] | null>(null);
  const [sectionVisible, setSectionVisible] = useState<SectionVisibility>({
    repositories: true,
    changes: true,
    graph: true,
    stashes: true,
  });
  const [sectionCollapsed, setSectionCollapsed] = useState({
    repositories: false,
    changes: false,
    graph: false,
    stashes: false,
  });

  const alive = useRef(true);
  const diffGeneration = useRef(0);
  const callbacks = useRef({ onEntries, onChanged });
  callbacks.current = { onEntries, onChanged };

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // Restoring persisted repos and tracking the open workspace folder are both
  // idempotent against the shared registry, so this runs safely on every mount.
  useEffect(() => {
    void gitRegistry.restore();
  }, []);

  useEffect(() => {
    let cancelled = false;
    setOpenError("");
    if (!workspace) return;
    // Registers the workspace's repository without stealing focus from whichever
    // repository the user has already selected in the switcher -- `open()` still
    // activates it when nothing is active yet (e.g. on first load), matching
    // `GitRegistry.openNew`'s own default-activation rule. See the Repository &
    // Worktree Architecture plan's Gap 1: Explorer navigation must never silently
    // reassign the active repository once the user has made an explicit choice.
    gitRegistry.open(workspace).catch((error) => {
      if (!cancelled) setOpenError(String(error));
    });
    return () => {
      cancelled = true;
    };
  }, [workspace]);

  useEffect(() => {
    callbacks.current.onEntries(workspaceSnapshot?.entries ?? []);
  }, [workspaceSnapshot?.entries]);

  useEffect(() => {
    if (activeRepo) void activeRepo.store.refresh();
  }, [activeRepo, revision]);

  // Refreshes every open repo (not just the active one) so the Repositories section
  // and the aggregated activity-bar count stay live while this panel is visible.
  useEffect(() => {
    if (!visible) return;
    const update = () => {
      for (const entry of registrySnapshot.repos) void entry.store.refresh();
    };
    window.addEventListener("focus", update);
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") update();
    }, 5000);
    return () => {
      window.removeEventListener("focus", update);
      clearInterval(timer);
    };
  }, [visible, registrySnapshot.repos]);

  useEffect(() => {
    if (!activeRepo) return;
    setMessage(localStorage.getItem(`yavin.commit:${activeRepo.root}`) ?? "");
  }, [activeRepo]);

  useEffect(() => {
    if (!activeRepo) return;
    try {
      localStorage.setItem(`yavin.commit:${activeRepo.root}`, message);
    } catch {
      /* Draft remains in memory when storage is unavailable. */
    }
  }, [activeRepo, message]);

  useEffect(() => {
    if (!snapshot) return;
    setChosenRemote((prev) =>
      snapshot.remotes.includes(prev) ? prev : (snapshot.remotes[0] ?? ""),
    );
  }, [snapshot?.remotes]);

  const addRepository = async () => {
    const path = await native("pick_folder_dialog").catch(() => null);
    if (!path) return;
    setOpenError("");
    try {
      await gitRegistry.open(path, { makeActive: true });
    } catch (error) {
      setOpenError(String(error));
    }
  };

  const removeRepository = (repoId: string) => void gitRegistry.close(repoId);
  const selectRepository = (repoId: string) => gitRegistry.setActive(repoId);

  const guarded = (kind: string, operation: () => Promise<string>) => {
    if (!activeRepo) return Promise.resolve(false);
    return activeRepo.store.guarded(kind, dirty, operation);
  };

  const showDiff = async (entry: GitEntry, staged: boolean) => {
    if (!activeRepo) return;
    const current = ++diffGeneration.current;
    try {
      const text = entry.untracked
        ? await native("read_file_content", { path: entry.path })
        : await activeRepo.store.repository.diff(entry.path, staged);
      if (!alive.current || current !== diffGeneration.current) return;
      const hasUnsavedEdits = buffers[entry.path] !== undefined;
      // Hunk-level staging needs the raw diff text untouched by the warning banner
      // below, and makes no sense for an untracked file or an unresolved conflict.
      const hunkStagingSafe = !entry.untracked && !entry.conflict && !hasUnsavedEdits;
      onDiff({
        path: entry.path,
        title: entry.untracked ? "Untracked file" : staged ? "HEAD → Index" : "Index → Saved file",
        text:
          (hasUnsavedEdits
            ? "Open editor may have unsaved edits. This view shows saved Git content.\n\n"
            : "") + (text || "No textual differences. The change may be metadata-only."),
        ...(hunkStagingSafe
          ? { repoId: activeRepo.repoId, kind: staged ? "staged" : "unstaged" }
          : {}),
      });
    } catch (error) {
      if (alive.current) activeRepo.store.setNotice(String(error));
    }
  };

  const discard = async (entry: GitEntry) => {
    if (!activeRepo) return;
    if (
      !window.confirm(
        `Discard saved changes in ${entry.path}? A recovery copy will be kept until the next discard or workspace close.`,
      )
    )
      return;
    if (dirty) {
      activeRepo.store.setNotice("Save or close unsaved editors before discarding saved changes.");
      return;
    }
    await guarded("discard", async () => {
      const before = await native("read_file_content", { path: entry.path });
      const after = await activeRepo.store.repository.indexContent(entry.path);
      const change = { path: entry.path, before, after };
      const outcome = await apply([change]);
      if (outcome.errors.length) throw new Error(outcome.errors.join(" "));
      setRecovery([change]);
      await callbacks.current.onChanged();
      return "Discarded changes.";
    });
  };

  const discardAll = async (targetEntries: GitEntry[]) => {
    if (!activeRepo) return;
    const modified = targetEntries.filter((e) => e.worktree === "M" && !e.conflict);
    if (!modified.length) return;
    if (!window.confirm(`Discard saved changes in all ${modified.length} files?`)) return;
    if (dirty) {
      activeRepo.store.setNotice("Save or close unsaved editors before discarding saved changes.");
      return;
    }
    await guarded("discard", async () => {
      const changes: Replacement[] = [];
      for (const entry of modified) {
        const before = await native("read_file_content", { path: entry.path });
        const after = await activeRepo.store.repository.indexContent(entry.path);
        changes.push({ path: entry.path, before, after });
      }
      const outcome = await apply(changes);
      if (outcome.errors.length) throw new Error(outcome.errors.join(" "));
      setRecovery(changes);
      await callbacks.current.onChanged();
      return `Discarded changes in ${changes.length} files.`;
    });
  };

  const stageAll = (targetEntries: GitEntry[]) =>
    guarded("stage", async () => {
      if (!activeRepo) return "";
      for (const entry of targetEntries) await activeRepo.store.repository.stage(entry.path);
      await callbacks.current.onChanged();
      return `Staged ${targetEntries.length} files.`;
    });

  const unstageAll = (targetEntries: GitEntry[]) =>
    guarded("unstage", async () => {
      if (!activeRepo) return "";
      for (const entry of targetEntries) await activeRepo.store.repository.unstage(entry.path);
      await callbacks.current.onChanged();
      return `Unstaged ${targetEntries.length} files.`;
    });

  const toggleGroupCollapse = (groupName: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(groupName)) next.delete(groupName);
      else next.add(groupName);
      return next;
    });
  };

  const entries = snapshot?.entries ?? [];
  const branch = snapshot?.branch ?? { name: "", upstream: "", ahead: 0, behind: 0 };
  const branches = snapshot?.branches ?? [];
  const remotes = snapshot?.remotes ?? [];
  const operationInProgress = snapshot?.operationInProgress ?? "";
  const busy = snapshot?.busy ?? false;
  const loading = snapshot?.loading ?? false;
  const notice = snapshot?.notice ?? "";

  const groups = [
    { name: "Conflicts", entries: entries.filter((e) => e.conflict), staged: false },
    {
      name: "Staged Changes",
      entries: entries.filter((e) => !e.conflict && !e.untracked && e.index !== " "),
      staged: true,
    },
    {
      name: "Changes",
      entries: entries.filter((e) => !e.conflict && (e.untracked || e.worktree !== " ")),
      staged: false,
    },
  ];

  const stagedCount = groups[1].entries.length;
  const conflictCount = groups[0].entries.length;
  const canCommit = message.trim().length > 0 && stagedCount > 0 && conflictCount === 0;
  const sync = divergence(branch);

  const handleCommitKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      if (canCommit && !busy && !loading && activeRepo) {
        void guarded("commit", () => activeRepo.store.repository.commit(message)).then(
          (ok) => ok && setMessage(""),
        );
      }
    }
  };

  const toggleSection = (name: keyof SectionVisibility) =>
    setSectionVisible((prev) => ({ ...prev, [name]: !prev[name] }));
  const toggleCollapsed = (name: keyof SectionVisibility) =>
    setSectionCollapsed((prev) => ({ ...prev, [name]: !prev[name] }));

  return (
    <aside
      hidden={!visible}
      aria-label="Source control"
      className="flex flex-col h-full w-[300px] shrink-0 border-r border-[#141414] bg-black select-none text-[12px] font-sans"
    >
      {/* Panel Header */}
      <div className="flex h-9 items-center justify-between px-3 border-b border-[#141414] text-zinc-300 shrink-0">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400">
          Source Control
        </span>
        <div className="flex items-center gap-0.5">
          <button
            disabled={busy || loading}
            onClick={() => void activeRepo?.store.refresh()}
            title="Refresh Status"
            className="p-1 rounded text-zinc-500 hover:text-zinc-200 hover:bg-[#121212] transition-colors disabled:opacity-30"
          >
            <RefreshIcon size={13} className={loading || busy ? "animate-spin" : ""} />
          </button>
          <GitMenu
            icon={<MoreIcon size={14} />}
            label="Source Control view options"
            items={[
              {
                label: "Repositories",
                checked: sectionVisible.repositories,
                onSelect: () => toggleSection("repositories"),
              },
              {
                label: "Changes",
                checked: sectionVisible.changes,
                onSelect: () => toggleSection("changes"),
              },
              {
                label: "Graph",
                checked: sectionVisible.graph,
                onSelect: () => toggleSection("graph"),
              },
              {
                label: "Stashes",
                checked: sectionVisible.stashes,
                onSelect: () => toggleSection("stashes"),
              },
            ]}
          />
        </div>
      </div>

      {openError && (
        <p role="status" className="px-3 pt-2 text-[11px] text-red-400 break-words">
          {openError}
        </p>
      )}

      <div className="flex-1 overflow-y-auto min-h-0 flex flex-col">
        {sectionVisible.repositories && (
          <RepositoriesSection
            repos={registrySnapshot.repos}
            activeRepoId={registrySnapshot.activeRepoId}
            dirty={dirty}
            message={message}
            collapsed={sectionCollapsed.repositories}
            onToggleCollapse={() => toggleCollapsed("repositories")}
            onSelect={selectRepository}
            onRemove={removeRepository}
            onAdd={() => void addRepository()}
            onCommitted={() => setMessage("")}
            onOpenBranches={() => setBranchesOpen(true)}
          />
        )}

        {sectionVisible.changes && (
          <section
            aria-label="Changes panel"
            className="text-xs border-b border-[#141414] shrink-0"
          >
            <div
              onClick={() => toggleCollapsed("changes")}
              className="flex items-center gap-1.5 px-2.5 py-1.5 cursor-pointer hover:bg-[#0c0c0c] transition-colors group/header"
            >
              <ChevronIcon isExpanded={!sectionCollapsed.changes} className="size-3" />
              <span className="font-semibold text-[11px] uppercase tracking-wider text-zinc-400">
                Changes
              </span>
              <div className="flex-1" />
              {activeRepo && (
                <div
                  className="flex items-center gap-0.5 opacity-0 group-hover/header:opacity-100 transition-opacity"
                  onClick={(e) => e.stopPropagation()}
                >
                  <button
                    onClick={() => setBranchesOpen(!branchesOpen)}
                    title="Branches and remotes"
                    className={`p-1 rounded transition-colors ${
                      branchesOpen
                        ? "text-indigo-400 bg-indigo-950/60"
                        : "text-zinc-500 hover:text-zinc-200 hover:bg-[#1e1e1e]"
                    }`}
                  >
                    <GitBranchIcon size={12} />
                  </button>
                  <GitMenu
                    icon={<MoreIcon size={14} />}
                    label="Changes actions"
                    buttonClassName="p-1 rounded text-zinc-500 hover:text-zinc-200 hover:bg-[#1e1e1e]"
                    items={buildGitCommandMenu({
                      entry: activeRepo,
                      dirty,
                      message,
                      onCommitted: () => setMessage(""),
                      includeViewOptions: true,
                      onOpenBranches: () => setBranchesOpen(true),
                    })}
                  />
                </div>
              )}
            </div>

            {!sectionCollapsed.changes && (
              <div className="p-3 pt-1 space-y-2.5">
                {!activeRepo ? (
                  <p className="text-zinc-500 text-[11px]">
                    {registrySnapshot.repos.length > 0
                      ? "Choose a repository above."
                      : !workspace
                        ? "Open a workspace, or add a repository folder, to use Source Control."
                        : openError
                          ? openError
                          : "Discovering repository…"}
                  </p>
                ) : (
                  <>
                    {operationInProgress && (
                      <div
                        role="alert"
                        className="rounded border border-amber-500/30 bg-amber-500/10 p-2 space-y-1.5"
                      >
                        <p className="text-amber-300 font-medium text-[11px] flex items-center gap-1.5">
                          <AlertCircleIcon size={13} />
                          {OPERATION_LABEL[operationInProgress]} in progress
                        </p>
                        <p className="text-amber-200/80 text-[11px]">
                          {conflictCount > 0
                            ? `Resolve ${conflictCount} conflicted file${conflictCount === 1 ? "" : "s"}, stage each one, then continue.`
                            : "No conflicts remain. Continue when ready."}
                        </p>
                        <div className="flex gap-1.5">
                          <button
                            disabled={busy || loading || dirty}
                            onClick={() =>
                              void guarded("abort", () => activeRepo.store.repository.abort())
                            }
                            className="flex-1 py-1 rounded bg-[#121212] hover:bg-[#1a1a1a] text-[11px] text-zinc-200 disabled:opacity-40 transition-colors"
                          >
                            Abort
                          </button>
                          <button
                            disabled={busy || loading || dirty || conflictCount > 0}
                            onClick={() =>
                              void guarded("continue", () =>
                                activeRepo.store.repository.continueOperation(),
                              )
                            }
                            className="flex-1 py-1 rounded bg-indigo-600 hover:bg-indigo-500 text-[11px] text-white disabled:opacity-40 transition-colors"
                          >
                            Continue
                          </button>
                        </div>
                      </div>
                    )}

                    <fieldset disabled={busy || loading} className="space-y-2 disabled:opacity-60">
                      <textarea
                        aria-label="Commit message"
                        placeholder="Message (Ctrl+Enter to commit)"
                        rows={3}
                        value={message}
                        onChange={(e) => setMessage(e.target.value)}
                        onKeyDown={handleCommitKeyDown}
                        className="w-full rounded border border-[#222222] bg-[#0a0a0a] p-2 text-xs text-zinc-100 placeholder:text-zinc-600 focus:border-indigo-500 focus:outline-none resize-none transition-colors"
                      />

                      <button
                        disabled={!canCommit}
                        onClick={() =>
                          void guarded("commit", () =>
                            activeRepo.store.repository.commit(message),
                          ).then((ok) => ok && setMessage(""))
                        }
                        className="w-full rounded bg-indigo-600 hover:bg-indigo-500 py-1.5 px-3 text-xs font-medium text-white flex items-center justify-center gap-1.5 transition-colors shadow-sm disabled:opacity-40 disabled:hover:bg-indigo-600"
                      >
                        <CheckIcon size={13} />
                        <span>Commit Staged ({stagedCount})</span>
                      </button>

                      {branchesOpen && (
                        <div className="space-y-2 pt-1 border-t border-[#181818]">
                          <select
                            aria-label="Switch branch"
                            className="w-full rounded border border-[#222222] bg-[#0a0a0a] px-2 py-1 text-xs text-zinc-300 focus:border-indigo-500 focus:outline-none"
                            value={branches.includes(branch.name) ? branch.name : ""}
                            disabled={dirty}
                            onChange={(e) =>
                              void guarded("switch", () =>
                                activeRepo.store.repository.switchBranch(e.target.value),
                              )
                            }
                          >
                            <option value="" disabled>
                              Choose branch
                            </option>
                            {branches.map((name) => (
                              <option key={name} value={name}>
                                {name}
                              </option>
                            ))}
                          </select>

                          <div className="flex gap-1">
                            <input
                              aria-label="New branch name"
                              placeholder="New branch name"
                              className="flex-1 min-w-0 rounded border border-[#222222] bg-[#0a0a0a] px-2 py-1 text-xs text-zinc-100 placeholder:text-zinc-600 focus:border-indigo-500 focus:outline-none"
                              value={newBranch}
                              onChange={(e) => setNewBranch(e.target.value)}
                            />
                            <button
                              disabled={dirty || !newBranch.trim()}
                              onClick={() =>
                                void guarded("branch", () =>
                                  activeRepo.store.repository.createBranch(newBranch),
                                ).then((ok) => ok && setNewBranch(""))
                              }
                              className="px-2 py-1 rounded bg-[#181818] hover:bg-[#222222] text-[11px] text-zinc-200 disabled:opacity-40 transition-colors shrink-0"
                            >
                              Create
                            </button>
                          </div>

                          {sync === "diverged" && (
                            <div className="rounded border border-zinc-800 bg-zinc-900/60 p-2 space-y-1.5">
                              <p className="text-zinc-300 text-[11px]">
                                Diverged: {branch.ahead} local and {branch.behind} remote commits.
                              </p>
                              <p className="text-zinc-500 text-[10.5px]">
                                Neither choice stashes your work — save or commit anything you want
                                to keep first.
                              </p>
                              <div className="flex gap-1.5">
                                <button
                                  disabled={dirty}
                                  onClick={() =>
                                    void guarded("pullRebase", () =>
                                      activeRepo.store.repository.pullRebase(),
                                    )
                                  }
                                  className="flex-1 py-1 rounded bg-[#121212] hover:bg-[#1a1a1a] text-[11px] text-zinc-300 disabled:opacity-40 transition-colors"
                                >
                                  Rebase
                                </button>
                                <button
                                  disabled={dirty}
                                  onClick={() =>
                                    void guarded("pullMerge", () =>
                                      activeRepo.store.repository.pullMerge(),
                                    )
                                  }
                                  className="flex-1 py-1 rounded bg-[#121212] hover:bg-[#1a1a1a] text-[11px] text-zinc-300 disabled:opacity-40 transition-colors"
                                >
                                  Merge
                                </button>
                              </div>
                            </div>
                          )}

                          <div className="flex gap-1.5 pt-0.5">
                            <button
                              onClick={() =>
                                void guarded("fetch", () => activeRepo.store.repository.fetch())
                              }
                              className="flex-1 py-1 rounded bg-[#121212] hover:bg-[#1a1a1a] text-[11px] text-zinc-300 disabled:opacity-40 transition-colors"
                            >
                              Fetch
                            </button>
                            {branch.upstream && (
                              <button
                                disabled={dirty || sync === "diverged"}
                                title={
                                  sync === "diverged"
                                    ? "Fast-forward pull is unavailable; choose Rebase or Merge instead."
                                    : undefined
                                }
                                onClick={() =>
                                  void guarded("pull", () => activeRepo.store.repository.pull())
                                }
                                className="flex-1 py-1 rounded bg-[#121212] hover:bg-[#1a1a1a] text-[11px] text-zinc-300 disabled:opacity-40 transition-colors"
                              >
                                Pull
                              </button>
                            )}
                            {branch.upstream && (
                              <button
                                onClick={() =>
                                  void guarded("push", () => activeRepo.store.repository.push())
                                }
                                className="flex-1 py-1 rounded bg-[#121212] hover:bg-[#1a1a1a] text-[11px] text-zinc-300 disabled:opacity-40 transition-colors"
                              >
                                Push
                              </button>
                            )}
                          </div>

                          {!branch.upstream &&
                            (remotes.length === 0 ? (
                              <p className="text-zinc-500 text-[11px]">
                                No remote is configured. Add one with `git remote add` to publish
                                this branch.
                              </p>
                            ) : (
                              <div className="flex gap-1">
                                <select
                                  aria-label="Remote"
                                  className="flex-1 min-w-0 rounded border border-[#222222] bg-[#0a0a0a] px-2 py-1 text-xs text-zinc-300 focus:border-indigo-500 focus:outline-none"
                                  value={chosenRemote}
                                  onChange={(e) => setChosenRemote(e.target.value)}
                                >
                                  {remotes.map((name) => (
                                    <option key={name} value={name}>
                                      {name}
                                    </option>
                                  ))}
                                </select>
                                <button
                                  disabled={!chosenRemote}
                                  onClick={() =>
                                    void guarded("publish", () =>
                                      activeRepo.store.repository.publish(chosenRemote),
                                    )
                                  }
                                  className="px-2 py-1 rounded bg-[#181818] hover:bg-[#222222] text-[11px] text-zinc-200 disabled:opacity-40 transition-colors shrink-0"
                                >
                                  Publish branch
                                </button>
                              </div>
                            ))}
                        </div>
                      )}
                    </fieldset>
                  </>
                )}

                {(notice || busy || loading) && (
                  <p
                    role="status"
                    aria-live="polite"
                    className="text-[11px] text-zinc-400 break-words leading-tight"
                  >
                    {busy ? "Running Git operation…" : loading ? "Refreshing…" : notice}
                  </p>
                )}

                {recovery && (
                  <button
                    disabled={busy}
                    onClick={() => {
                      const changes = recovery;
                      void apply(
                        changes.map((change) => ({
                          path: change.path,
                          before: change.after,
                          after: change.before,
                        })),
                      )
                        .then(async (outcome) => {
                          if (outcome.errors.length)
                            activeRepo?.store.setNotice(outcome.errors.join(" "));
                          else {
                            setRecovery(null);
                            await callbacks.current.onChanged();
                            await activeRepo?.store.refresh();
                          }
                        })
                        .catch((e) => activeRepo?.store.setNotice(String(e)));
                    }}
                    className="w-full rounded bg-zinc-800 hover:bg-zinc-700 py-1 text-[11px] text-zinc-200 transition-colors flex items-center justify-center gap-1.5"
                  >
                    <UndoIcon size={12} />
                    <span>Undo last discard</span>
                  </button>
                )}
              </div>
            )}

            {!sectionCollapsed.changes && activeRepo && (
              <div className="divide-y divide-[#101010]">
                {entries.length === 0 && !loading && (
                  <div className="flex flex-col items-center justify-center p-8 text-center text-zinc-500 gap-2">
                    <CheckIcon size={24} className="text-zinc-600" />
                    <p className="text-xs">Working tree clean</p>
                    <p className="text-[11px] text-zinc-600">No changes detected in repository</p>
                  </div>
                )}

                {groups.map((group) => {
                  if (group.entries.length === 0) return null;
                  const isCollapsed = collapsedGroups.has(group.name);

                  return (
                    <section key={group.name} aria-label={group.name} className="text-xs">
                      <div
                        onClick={() => toggleGroupCollapse(group.name)}
                        className="flex items-center justify-between px-2.5 py-1.5 bg-[#080808] hover:bg-[#121212] cursor-pointer transition-colors group/header"
                      >
                        <div className="flex items-center gap-1.5 min-w-0">
                          <ChevronIcon isExpanded={!isCollapsed} className="size-3" />
                          <span className="font-semibold text-[11px] uppercase tracking-wider text-zinc-400">
                            {group.name}
                          </span>
                          <span className="ml-1 px-1.5 py-0.2 rounded-full text-[10px] bg-zinc-800 text-zinc-400 font-mono">
                            {group.entries.length}
                          </span>
                        </div>

                        <div
                          className="flex items-center gap-0.5 opacity-0 group-hover/header:opacity-100 transition-opacity"
                          onClick={(e) => e.stopPropagation()}
                        >
                          {group.name === "Changes" && (
                            <>
                              <button
                                disabled={busy || loading}
                                title="Discard All Changes"
                                onClick={() => void discardAll(group.entries)}
                                className="p-1 rounded text-zinc-400 hover:text-zinc-200 hover:bg-[#1e1e1e] transition-colors"
                              >
                                <UndoIcon size={12} />
                              </button>
                              <button
                                disabled={busy || loading}
                                title="Stage All Changes"
                                onClick={() => void stageAll(group.entries)}
                                className="p-1 rounded text-zinc-400 hover:text-zinc-200 hover:bg-[#1e1e1e] transition-colors"
                              >
                                <PlusIcon size={12} />
                              </button>
                            </>
                          )}
                          {group.name === "Staged Changes" && (
                            <button
                              disabled={busy || loading}
                              title="Unstage All Changes"
                              onClick={() => void unstageAll(group.entries)}
                              className="p-1 rounded text-zinc-400 hover:text-zinc-200 hover:bg-[#1e1e1e] transition-colors"
                            >
                              <MinusIcon size={12} />
                            </button>
                          )}
                        </div>
                      </div>

                      {!isCollapsed && (
                        <div className="divide-y divide-[#0c0c0c]">
                          {group.entries.map((entry) => {
                            const root = activeRepo.root;
                            const relativePath = entry.path.startsWith(root)
                              ? entry.path.slice(root.length + 1)
                              : entry.path;
                            const parts = relativePath.split(/[/\\]/);
                            const fileName = parts.pop() || relativePath;
                            const dirPath = parts.join("/");
                            const status = getStatusInfo(entry, group.staged);
                            const isActiveDiff = activeDiffPath === entry.path;

                            return (
                              <div
                                key={entry.path}
                                className={`flex items-center gap-1.5 px-2.5 py-1.5 hover:bg-[#121212] group/row transition-colors cursor-pointer ${
                                  isActiveDiff ? "bg-[#161a24]" : ""
                                }`}
                                onClick={() => void showDiff(entry, group.staged)}
                              >
                                <FileIcon
                                  name={fileName}
                                  isDir={false}
                                  className="size-3.5 shrink-0"
                                />

                                <div className="flex items-baseline min-w-0 flex-1 truncate">
                                  <span
                                    className={`text-xs font-medium truncate ${status.style.text}`}
                                    title={
                                      entry.originalPath
                                        ? `${entry.originalPath} → ${entry.path}`
                                        : entry.path
                                    }
                                  >
                                    {fileName}
                                  </span>
                                  {dirPath && (
                                    <span className="text-zinc-500 text-[10.5px] ml-1.5 truncate">
                                      {dirPath}
                                    </span>
                                  )}
                                </div>

                                <span
                                  title={`Status: ${status.letter}`}
                                  className={`px-1 py-0.2 rounded text-[10px] font-mono font-bold border shrink-0 ${status.style.badge}`}
                                >
                                  {status.letter}
                                </span>

                                <div
                                  className="flex items-center gap-0.5 opacity-0 group-hover/row:opacity-100 transition-opacity shrink-0"
                                  onClick={(e) => e.stopPropagation()}
                                >
                                  <button
                                    disabled={busy}
                                    title="Open Diff"
                                    onClick={() => void showDiff(entry, group.staged)}
                                    className="p-1 rounded text-zinc-400 hover:text-zinc-200 hover:bg-[#1e1e1e] transition-colors"
                                  >
                                    <DiffIcon size={12} />
                                  </button>

                                  {!group.staged && entry.worktree === "M" && !entry.conflict && (
                                    <button
                                      disabled={busy || loading}
                                      aria-label={`Discard ${entry.path}`}
                                      title={`Discard changes in ${fileName}`}
                                      onClick={() => void discard(entry)}
                                      className="p-1 rounded text-zinc-400 hover:text-zinc-200 hover:bg-[#1e1e1e] transition-colors"
                                    >
                                      <UndoIcon size={12} />
                                    </button>
                                  )}

                                  <button
                                    disabled={busy || loading}
                                    aria-label={`${group.staged ? "Unstage" : "Stage"} ${entry.path}`}
                                    title={
                                      group.staged ? `Unstage ${fileName}` : `Stage ${fileName}`
                                    }
                                    onClick={() => {
                                      if (
                                        entry.conflict &&
                                        !window.confirm(
                                          "Stage this file as resolved? Review and remove conflict markers first.",
                                        )
                                      )
                                        return;
                                      void guarded(group.staged ? "unstage" : "stage", () =>
                                        group.staged
                                          ? activeRepo.store.repository.unstage(entry.path)
                                          : activeRepo.store.repository.stage(entry.path),
                                      );
                                    }}
                                    className="p-1 rounded text-zinc-400 hover:text-zinc-200 hover:bg-[#1e1e1e] transition-colors"
                                  >
                                    {group.staged ? (
                                      <MinusIcon size={12} />
                                    ) : (
                                      <PlusIcon size={12} />
                                    )}
                                  </button>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </section>
                  );
                })}
              </div>
            )}
          </section>
        )}

        {sectionVisible.graph && (
          <InlineGraphSection
            entry={activeRepo}
            dirty={dirty}
            collapsed={sectionCollapsed.graph}
            onToggleCollapse={() => toggleCollapsed("graph")}
            onExpand={onOpenGraph}
          />
        )}

        {sectionVisible.stashes && (
          <StashesSection
            entry={activeRepo}
            stashes={snapshot?.stashes ?? []}
            dirty={dirty}
            collapsed={sectionCollapsed.stashes}
            onToggleCollapse={() => toggleCollapsed("stashes")}
          />
        )}
      </div>
    </aside>
  );
}
