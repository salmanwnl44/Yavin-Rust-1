import { useCallback, useEffect, useRef, useState } from "react";
import { native } from "../../services/native";
import { parseBranch, parseGitEntries } from "../../services/git";
import type { GitEntry } from "../../services/git";
import type { DiffDocument } from "./DiffEditor";
import type { Replacement } from "./SearchPanel";
import { ChevronIcon, FileIcon } from "../ui/FileIcons";
import {
  CheckIcon,
  DiffIcon,
  GitBranchIcon,
  MinusIcon,
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
}) {
  const [root, setRoot] = useState<string | null>(null);
  const [entries, setEntries] = useState<GitEntry[]>([]);
  const [branch, setBranch] = useState<ReturnType<typeof parseBranch>>({
    name: "",
    upstream: "",
    ahead: 0,
    behind: 0,
  });
  const [branches, setBranches] = useState<string[]>([]);
  const [message, setMessage] = useState(
    () => localStorage.getItem(`yavin.commit:${workspace}`) ?? "",
  );
  const [newBranch, setNewBranch] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [recovery, setRecovery] = useState<Replacement | null>(null);
  const [branchesOpen, setBranchesOpen] = useState(false);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());

  const alive = useRef(true);
  const generation = useRef(0);
  const operation = useRef(false);
  const callbacks = useRef({ onEntries, onChanged });
  callbacks.current = { onEntries, onChanged };

  const git = useCallback(
    (action: string, path?: string, value?: string) =>
      native("git_workbench", { workspace, action, path, value }),
    [workspace],
  );

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      generation.current++;
    };
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(`yavin.commit:${workspace}`, message);
    } catch {
      /* Draft remains in memory when storage is unavailable. */
    }
  }, [workspace, message]);

  const refresh = useCallback(async () => {
    if (!workspace) return;
    const current = ++generation.current;
    setLoading(true);
    try {
      const found = await git("discover");
      if (!alive.current || generation.current !== current) return;
      setRoot(found);
      if (!found) {
        setEntries([]);
        callbacks.current.onEntries([]);
        setNotice("This folder is not a Git repository.");
        return;
      }
      const output = await git("status");
      const info = await git("branchInfo");
      const names = await git("branches");
      if (!alive.current || generation.current !== current) return;
      const next = parseGitEntries(output, found);
      setEntries(next);
      callbacks.current.onEntries(next);
      setBranch(parseBranch(info));
      setBranches(names.trim().split("\n").filter(Boolean));
    } catch (error) {
      if (alive.current && generation.current === current) setNotice(String(error));
    } finally {
      if (alive.current && generation.current === current) setLoading(false);
    }
  }, [git, workspace]);

  useEffect(() => {
    void refresh();
  }, [refresh, revision]);

  useEffect(() => {
    if (!visible) return;
    const update = () => {
      if (!operation.current) void refresh();
    };
    window.addEventListener("focus", update);
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") update();
    }, 5000);
    return () => {
      window.removeEventListener("focus", update);
      clearInterval(timer);
    };
  }, [visible, refresh]);

  const act = async (action: string, path?: string, value?: string) => {
    if (operation.current) return;
    operation.current = true;
    setBusy(true);
    setNotice("");
    generation.current++;
    try {
      if (["switch", "branch", "pull"].includes(action) && dirty)
        throw new Error("Save or close unsaved editors before changing the working tree.");
      const output = await git(action, path, value);
      if (!alive.current) return;
      if (action === "commit") setMessage("");
      if (action === "branch") setNewBranch("");
      onDiff(null);
      await callbacks.current.onChanged();
      setNotice(output.trim() || "Operation completed.");
    } catch (error) {
      if (alive.current) setNotice(String(error));
    } finally {
      operation.current = false;
      if (alive.current) {
        setBusy(false);
        await refresh();
      }
    }
  };

  const showDiff = async (entry: GitEntry, staged: boolean) => {
    const current = ++generation.current;
    try {
      const text = entry.untracked
        ? await native("read_file_content", { path: entry.path })
        : await git(staged ? "stagedDiff" : "diff", entry.path);
      if (!alive.current || current !== generation.current) return;
      onDiff({
        path: entry.path,
        title: entry.untracked ? "Untracked file" : staged ? "HEAD → Index" : "Index → Saved file",
        text:
          (buffers[entry.path] !== undefined
            ? "Open editor may have unsaved edits. This view shows saved Git content.\n\n"
            : "") + (text || "No textual differences. The change may be metadata-only."),
      });
    } catch (error) {
      if (alive.current) setNotice(String(error));
    }
  };

  const discard = async (entry: GitEntry) => {
    if (
      !window.confirm(
        `Discard saved changes in ${entry.path}? A recovery copy will be kept until the next discard or workspace close.`,
      )
    )
      return;
    if (dirty) {
      setNotice("Save or close unsaved editors before discarding saved changes.");
      return;
    }
    setBusy(true);
    try {
      const before = await native("read_file_content", { path: entry.path });
      const after = await git("indexContent", entry.path);
      const change = { path: entry.path, before, after };
      const outcome = await apply([change]);
      if (outcome.errors.length) throw new Error(outcome.errors.join(" "));
      setRecovery(change);
      await callbacks.current.onChanged();
      await refresh();
    } catch (error) {
      setNotice(String(error));
    } finally {
      setBusy(false);
    }
  };

  const discardAll = async (targetEntries: GitEntry[]) => {
    const modified = targetEntries.filter((e) => e.worktree === "M" && !e.conflict);
    if (!modified.length) return;
    if (!window.confirm(`Discard saved changes in all ${modified.length} files?`)) return;
    if (dirty) {
      setNotice("Save or close unsaved editors before discarding saved changes.");
      return;
    }
    setBusy(true);
    try {
      const changes: Replacement[] = [];
      for (const entry of modified) {
        const before = await native("read_file_content", { path: entry.path });
        const after = await git("indexContent", entry.path);
        changes.push({ path: entry.path, before, after });
      }
      const outcome = await apply(changes);
      if (outcome.errors.length) throw new Error(outcome.errors.join(" "));
      await callbacks.current.onChanged();
      await refresh();
      setNotice(`Discarded changes in ${changes.length} files.`);
    } catch (error) {
      setNotice(String(error));
    } finally {
      setBusy(false);
    }
  };

  const stageAll = async (targetEntries: GitEntry[]) => {
    if (operation.current) return;
    operation.current = true;
    setBusy(true);
    setNotice("");
    generation.current++;
    try {
      for (const entry of targetEntries) {
        await git("stage", entry.path);
      }
      await callbacks.current.onChanged();
      setNotice(`Staged ${targetEntries.length} files.`);
    } catch (error) {
      setNotice(String(error));
    } finally {
      operation.current = false;
      setBusy(false);
      await refresh();
    }
  };

  const unstageAll = async (targetEntries: GitEntry[]) => {
    if (operation.current) return;
    operation.current = true;
    setBusy(true);
    setNotice("");
    generation.current++;
    try {
      for (const entry of targetEntries) {
        await git("unstage", entry.path);
      }
      await callbacks.current.onChanged();
      setNotice(`Unstaged ${targetEntries.length} files.`);
    } catch (error) {
      setNotice(String(error));
    } finally {
      operation.current = false;
      setBusy(false);
      await refresh();
    }
  };

  const toggleGroupCollapse = (groupName: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(groupName)) next.delete(groupName);
      else next.add(groupName);
      return next;
    });
  };

  const groups = [
    { name: "Conflicts", entries: entries.filter((e) => e.conflict), staged: false },
    {
      name: "Staged Changes",
      entries: entries.filter((e) => !e.conflict && !e.untracked && e.index !== " "),
      staged: true,
    },
    {
      name: "Changes",
      entries: entries.filter((e) => !e.conflict && !e.untracked && e.worktree !== " "),
      staged: false,
    },
    { name: "Untracked", entries: entries.filter((e) => e.untracked), staged: false },
  ];

  const rootOpen = root === workspace;
  const stagedCount = groups[1].entries.length;
  const hasConflicts = !!groups[0].entries.length;
  const canCommit = rootOpen && message.trim().length > 0 && stagedCount > 0 && !hasConflicts;

  const handleCommitKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      if (canCommit && !busy && !loading) {
        void act("commit", undefined, message);
      }
    }
  };

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
          {root && (
            <button
              onClick={() => setBranchesOpen(!branchesOpen)}
              title="Branches and remotes"
              className={`p-1 rounded transition-colors ${
                branchesOpen
                  ? "text-indigo-400 bg-indigo-950/60"
                  : "text-zinc-500 hover:text-zinc-200 hover:bg-[#121212]"
              }`}
            >
              <GitBranchIcon size={13} />
            </button>
          )}
          <button
            disabled={busy || loading}
            onClick={() => void refresh()}
            title="Refresh"
            className="p-1 rounded text-zinc-500 hover:text-zinc-200 hover:bg-[#121212] transition-colors disabled:opacity-30"
          >
            <RefreshIcon size={13} className={loading || busy ? "animate-spin" : ""} />
          </button>
        </div>
      </div>

      {/* Top Pinned Controls */}
      <div className="p-3 space-y-2.5 border-b border-[#141414] shrink-0 bg-black">
        {!workspace ? (
          <p className="text-zinc-500 text-[11px]">Open a workspace in the desktop application.</p>
        ) : root === null ? (
          <p className="text-zinc-500 text-[11px] animate-pulse">Discovering repository…</p>
        ) : (
          root && (
            <>
              {/* Branch Pill & Remote Status Bar */}
              <div className="flex items-center justify-between text-xs py-0.5">
                <div
                  className="flex items-center gap-1.5 min-w-0 text-zinc-300 font-medium cursor-pointer hover:text-white transition-colors"
                  onClick={() => setBranchesOpen(!branchesOpen)}
                  title={
                    branch.upstream ? `Tracking ${branch.upstream}` : branch.name || "Detached HEAD"
                  }
                >
                  <GitBranchIcon size={13} className="text-indigo-400 shrink-0" />
                  <span className="truncate">{branch.name || "HEAD"}</span>
                  {branch.upstream && (
                    <span className="text-zinc-500 text-[10.5px] truncate max-w-[90px]">
                      → {branch.upstream}
                    </span>
                  )}
                </div>
                {(branch.ahead > 0 || branch.behind > 0) && (
                  <div
                    className="flex items-center gap-1 text-[10.5px] font-mono font-medium px-1.5 py-0.5 rounded bg-zinc-900 border border-zinc-800 text-zinc-300 shrink-0"
                    title={`${branch.ahead} to push, ${branch.behind} to pull`}
                  >
                    <span>↑{branch.ahead}</span>
                    <span>↓{branch.behind}</span>
                  </div>
                )}
              </div>

              {!rootOpen && (
                <p className="text-amber-400 text-[11px] bg-amber-500/10 border border-amber-500/20 rounded p-1.5">
                  Open repository root to commit, switch branches, or use remotes.
                </p>
              )}

              {/* Commit Message & Action */}
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
                  onClick={() => void act("commit", undefined, message)}
                  className="w-full rounded bg-indigo-600 hover:bg-indigo-500 py-1.5 px-3 text-xs font-medium text-white flex items-center justify-center gap-1.5 transition-colors shadow-sm disabled:opacity-40 disabled:hover:bg-indigo-600"
                >
                  <CheckIcon size={13} />
                  <span>Commit Staged ({stagedCount})</span>
                </button>

                {/* Collapsible Branches & Remotes Section */}
                {branchesOpen && (
                  <div className="space-y-2 pt-1 border-t border-[#181818]">
                    <select
                      aria-label="Switch branch"
                      className="w-full rounded border border-[#222222] bg-[#0a0a0a] px-2 py-1 text-xs text-zinc-300 focus:border-indigo-500 focus:outline-none"
                      value={branches.includes(branch.name) ? branch.name : ""}
                      disabled={!rootOpen || dirty}
                      onChange={(e) => void act("switch", undefined, e.target.value)}
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
                        disabled={!rootOpen || dirty || !newBranch.trim()}
                        onClick={() => void act("branch", undefined, newBranch)}
                        className="px-2 py-1 rounded bg-[#181818] hover:bg-[#222222] text-[11px] text-zinc-200 disabled:opacity-40 transition-colors shrink-0"
                      >
                        Create
                      </button>
                    </div>

                    <div className="flex gap-1.5 pt-0.5">
                      <button
                        disabled={!rootOpen}
                        onClick={() => void act("fetch")}
                        className="flex-1 py-1 rounded bg-[#121212] hover:bg-[#1a1a1a] text-[11px] text-zinc-300 disabled:opacity-40 transition-colors"
                      >
                        Fetch
                      </button>
                      <button
                        disabled={!rootOpen || dirty}
                        onClick={() => void act("pull")}
                        className="flex-1 py-1 rounded bg-[#121212] hover:bg-[#1a1a1a] text-[11px] text-zinc-300 disabled:opacity-40 transition-colors"
                      >
                        Pull
                      </button>
                      <button
                        disabled={!rootOpen}
                        onClick={() => void act("push")}
                        className="flex-1 py-1 rounded bg-[#121212] hover:bg-[#1a1a1a] text-[11px] text-zinc-300 disabled:opacity-40 transition-colors"
                      >
                        Push
                      </button>
                    </div>
                  </div>
                )}
              </fieldset>
            </>
          )
        )}

        {/* Live status notice / message */}
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
              const change = recovery;
              setBusy(true);
              void apply([{ path: change.path, before: change.after, after: change.before }])
                .then(async (outcome) => {
                  if (outcome.errors.length) setNotice(outcome.errors.join(" "));
                  else {
                    setRecovery(null);
                    await callbacks.current.onChanged();
                    await refresh();
                  }
                })
                .catch((e) => setNotice(String(e)))
                .finally(() => setBusy(false));
            }}
            className="w-full rounded bg-zinc-800 hover:bg-zinc-700 py-1 text-[11px] text-zinc-200 transition-colors flex items-center justify-center gap-1.5"
          >
            <UndoIcon size={12} />
            <span>Undo last discard</span>
          </button>
        )}
      </div>

      {/* Changes Accordion List (Scrollable) */}
      <div className="flex-1 overflow-y-auto min-h-0 py-1 divide-y divide-[#101010]">
        {root && entries.length === 0 && !loading && (
          <div className="flex flex-col items-center justify-center p-8 text-center text-zinc-500 gap-2">
            <CheckIcon size={24} className="text-zinc-600" />
            <p className="text-xs">Working tree clean</p>
            <p className="text-[11px] text-zinc-600">No changes detected in repository</p>
          </div>
        )}

        {root &&
          groups.map((group) => {
            if (group.entries.length === 0) return null;
            const isCollapsed = collapsedGroups.has(group.name);

            return (
              <section key={group.name} aria-label={group.name} className="text-xs">
                {/* Section Header */}
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

                  {/* Group Action Buttons on Hover */}
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
                    {group.name === "Untracked" && (
                      <button
                        disabled={busy || loading}
                        title="Stage All Untracked Files"
                        onClick={() => void stageAll(group.entries)}
                        className="p-1 rounded text-zinc-400 hover:text-zinc-200 hover:bg-[#1e1e1e] transition-colors"
                      >
                        <PlusIcon size={12} />
                      </button>
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

                {/* Entry Rows in Group */}
                {!isCollapsed && (
                  <div className="divide-y divide-[#0c0c0c]">
                    {group.entries.map((entry) => {
                      const relativePath = entry.path.startsWith(workspace)
                        ? entry.path.slice(workspace.length + 1)
                        : entry.path;
                      const parts = relativePath.split(/[/\\]/);
                      const fileName = parts.pop() || relativePath;
                      const dirPath = parts.join("/");
                      const status = getStatusInfo(entry, group.staged);

                      return (
                        <div
                          key={entry.path}
                          className="flex items-center gap-1.5 px-2.5 py-1.5 hover:bg-[#121212] group/row transition-colors cursor-pointer"
                          onClick={() => void showDiff(entry, group.staged)}
                        >
                          <FileIcon name={fileName} isDir={false} className="size-3.5 shrink-0" />

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

                          {/* Status Badge */}
                          <span
                            title={`Status: ${status.letter}`}
                            className={`px-1 py-0.2 rounded text-[10px] font-mono font-bold border shrink-0 ${status.style.badge}`}
                          >
                            {status.letter}
                          </span>

                          {/* Action Buttons on Row Hover */}
                          <div
                            className="flex items-center gap-0.5 opacity-0 group-hover/row:opacity-100 transition-opacity shrink-0"
                            onClick={(e) => e.stopPropagation()}
                          >
                            {/* Open Diff */}
                            <button
                              disabled={busy}
                              title="Open Diff"
                              onClick={() => void showDiff(entry, group.staged)}
                              className="p-1 rounded text-zinc-400 hover:text-zinc-200 hover:bg-[#1e1e1e] transition-colors"
                            >
                              <DiffIcon size={12} />
                            </button>

                            {/* Discard unstaged changes */}
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

                            {/* Stage / Unstage / Conflict */}
                            <button
                              disabled={busy || loading}
                              aria-label={`${group.staged ? "Unstage" : "Stage"} ${entry.path}`}
                              title={group.staged ? `Unstage ${fileName}` : `Stage ${fileName}`}
                              onClick={() => {
                                if (
                                  entry.conflict &&
                                  !window.confirm(
                                    "Stage this file as resolved? Review and remove conflict markers first.",
                                  )
                                )
                                  return;
                                void act(group.staged ? "unstage" : "stage", entry.path);
                              }}
                              className="p-1 rounded text-zinc-400 hover:text-zinc-200 hover:bg-[#1e1e1e] transition-colors"
                            >
                              {group.staged ? <MinusIcon size={12} /> : <PlusIcon size={12} />}
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
    </aside>
  );
}
