import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { native } from "../../services/native";
import { divergence } from "../../services/git/parsers/branch";
import type { GitEntry } from "../../services/git/parsers/status";
import type { GitOperation } from "../../services/git/backend";
import { cloneRepository as cloneRepositoryFlow } from "../../services/git/clone";
import { gitRegistry } from "../../services/git/registry";
import { containsPath, relativePath as relativeTo } from "../../services/resource";
import { useActiveRepo, useGitRegistry, useRepoSnapshot } from "../../services/git/hooks";
import { useGitRevision } from "../../services/git/revision";
import { guardedAffecting } from "../../services/git/sync";
import type { RefreshField } from "../../services/git/store";
import { RepositoriesSection } from "../git/RepositoriesSection";
import { CommitBox } from "../git/CommitBox";
import type { CommitBoxHandle } from "../git/CommitBox";
import { InlineGraphSection } from "../git/InlineGraphSection";
import { StashesSection } from "../git/StashesSection";
import { GitMenu } from "../git/GitMenu";
import {
  readChangesSort,
  readChangesViewAsTree,
  saveChangesSort,
  saveChangesViewAsTree,
  sortChanges,
  statusLetter,
} from "../../services/git/changesSort";
import type { ChangesSort } from "../../services/git/changesSort";
import { buildGitCommandMenu } from "../git/gitCommandMenu";
import type { DiffDocument } from "./DiffEditor";
import type { Replacement } from "./SearchPanel";
import type { DialogRequest } from "../ui/AppDialog";
import { buildFileTree, collectFiles, flattenVisible } from "../../services/git/fileTree";
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
  TrashIcon,
  UndoIcon,
} from "../ui/Icons";

/** Status letter colours come from the global theme tokens (see styles/index.css). */
const letterColor: Record<string, string> = {
  M: "text-yellow",
  T: "text-yellow",
  U: "text-green",
  A: "text-green",
  D: "text-red",
  R: "text-blue",
  C: "text-blue",
  "!": "text-red",
};

/** Whether the index holds a staged change for this entry (conflicts are never "staged"). */
const hasStagedPart = (e: GitEntry) => !e.conflict && !e.untracked && e.index !== " ";
/** What "Discard All" restores: tracked files modified in the working tree. Untracked,
 * deleted, added, renamed-only, staged-only and conflicted files are never touched by it. */
const isDiscardable = (e: GitEntry) => e.worktree === "M" && !e.conflict;
/** Whether the working tree still has changes the index does not (untracked counts). */
const hasUnstagedPart = (e: GitEntry) => e.untracked || e.worktree !== " ";

/** One merged list, one letter per file: conflict, untracked, else the working-tree state
 * if any remains, else the staged state -- the same letter VS Code-style panels show. */
function getStatusInfo(entry: GitEntry) {
  const letter = statusLetter(entry);
  return { letter, color: letterColor[letter] ?? "text-ink-2" };
}

const OPERATION_LABEL: Record<Exclude<GitOperation, "">, string> = {
  merge: "Merge",
  rebase: "Rebase",
  "cherry-pick": "Cherry-pick",
  revert: "Revert",
};

/** Whether `path` is `root` itself or lies inside it, by the rules in `resource.ts`. */
const rootContains = (root: string, path: string): boolean => containsPath(root, path);

/**
 * Rows drawn per group before "Show more". Every row is ~22 DOM nodes and measured
 * ~0.5 ms to mount: 1,000 rows took ~1 s, 5,000 took 3.3 s and 10,000 took 6.2 s in a
 * production build. Counts, Stage All and the other bulk actions always cover the
 * whole group -- only how many rows are drawn is capped, never what is acted on.
 */
const ROWS_PER_PAGE = 500;

interface SectionVisibility {
  repositories: boolean;
  changes: boolean;
  graph: boolean;
  stashes: boolean;
}

const SECTIONS_STORAGE_KEY = "yavin.scm.sections";
// Only Changes and Graph by default; Repositories and Stashes stay one click away in the
// view-options menu.
const DEFAULT_SECTIONS: SectionVisibility = {
  repositories: false,
  changes: true,
  graph: true,
  stashes: false,
};

/** Which sections the user has shown or hidden. Remembered across restarts and across the
 * panel remounting when the workspace folder changes. */
function readSectionVisibility(): SectionVisibility {
  try {
    const saved = JSON.parse(localStorage.getItem(SECTIONS_STORAGE_KEY) ?? "null");
    if (saved && typeof saved === "object") {
      const next = { ...DEFAULT_SECTIONS };
      for (const key of Object.keys(DEFAULT_SECTIONS) as (keyof SectionVisibility)[]) {
        if (typeof saved[key] === "boolean") next[key] = saved[key];
      }
      return next;
    }
  } catch {
    /* Fall through to the defaults. */
  }
  return DEFAULT_SECTIONS;
}

export function SourceControlPanel({
  workspace,
  visible,
  buffers,
  dirty,
  onDiff,
  onChanged,
  onEntries,
  apply,
  activeDiffPath,
  onOpenGraph,
  onShowOutput,
  onDialog,
}: {
  workspace: string;
  visible: boolean;
  buffers: Record<string, string>;
  dirty: boolean;
  onDiff: (diff: DiffDocument | null) => void;
  onChanged: () => Promise<void>;
  onEntries: (entries: GitEntry[]) => void;
  apply: (changes: Replacement[]) => Promise<{ applied: Replacement[]; errors: string[] }>;
  activeDiffPath?: string;
  onOpenGraph?: () => void;
  /** Opens the Git Output view -- the log of every Git command the app has run. */
  onShowOutput?: () => void;
  /** Opens the shared app dialog (prompt/picker/confirm) -- see `ui/AppDialog.tsx`. Every
   * name-, remote- or target-requiring Git menu action goes through this, the same modal the
   * rest of the app already uses for New File/Delete/Go to Line. */
  onDialog: (request: DialogRequest) => void;
}) {
  // Subscribed here rather than taken as a prop: a counter held by the root component
  // re-rendered the whole window every time anything asked Git to look again.
  const revision = useGitRevision();
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

  // Errors from an explicit user action (adding a repository folder) always show. A failure
  // to discover a repository in the open *workspace folder* only matters when nothing else is
  // tracked -- otherwise "not a Git repository" is noise next to a working repository.
  const [openError, setOpenError] = useState("");
  const [workspaceError, setWorkspaceError] = useState("");
  const [initError, setInitError] = useState("");
  const [initBusy, setInitBusy] = useState(false);
  // The nested "Changes" group inside the Changes section can be folded on its own.
  const [changesGroupCollapsed, setChangesGroupCollapsed] = useState(false);
  // The commit draft itself lives in <CommitBox>; the panel keeps only whether one
  // exists (re-rendering only when that flips) and a ref for click-time reads.
  const [hasMessage, setHasMessage] = useState(false);
  const messageRef = useRef("");
  const commitBoxRef = useRef<CommitBoxHandle>(null);
  const onMessageChange = useCallback((next: string) => {
    messageRef.current = next;
    setHasMessage(next.trim().length > 0);
  }, []);
  const getMessage = useCallback(() => messageRef.current, []);
  const [newBranch, setNewBranch] = useState("");
  const [chosenRemote, setChosenRemote] = useState("");
  const [branchesOpen, setBranchesOpen] = useState(false);
  const [rowLimits, setRowLimits] = useState<Record<string, number>>({});
  const [recovery, setRecovery] = useState<Replacement[] | null>(null);
  // How the changed files are ordered. A view preference like the section toggles: it applies
  // to whichever repository is shown, is remembered across restarts, and is not repository
  // state -- switching repositories keeps it, and a refresh never resets it.
  const [changesSort, setChangesSort] = useState<ChangesSort>(readChangesSort);
  useEffect(() => saveChangesSort(changesSort), [changesSort]);
  // "View as List"/"View as Tree": same kind of remembered view preference as the sort order.
  const [changesViewAsTree, setChangesViewAsTree] = useState<boolean>(readChangesViewAsTree);
  useEffect(() => saveChangesViewAsTree(changesViewAsTree), [changesViewAsTree]);
  // Folder collapse state for the tree view. Not persisted -- everything starts expanded each
  // session, the same way a fresh Explorer tree would.
  const [collapsedFolders, setCollapsedFolders] = useState<ReadonlySet<string>>(new Set());
  const toggleFolder = (path: string) =>
    setCollapsedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  // State that describes the repository being shown, cleared when that changes: another
  // repository's collapsed folder paths, its half-typed new-branch name and its "Show more"
  // page position all mean nothing here and were being carried across the switch.
  //
  // Deliberately not reset: the sort order and List/Tree mode (panel preferences, meant to
  // persist), whether the branch drawer is open (a view toggle, same reasoning), and the
  // discard-undo offer, which `App.tsx` already clears on a switch.
  useEffect(() => {
    setCollapsedFolders(new Set());
    setNewBranch("");
    setRowLimits({});
  }, [activeRepo?.repoId]);
  const [sectionVisible, setSectionVisible] = useState<SectionVisibility>(readSectionVisibility);
  useEffect(() => {
    try {
      localStorage.setItem(SECTIONS_STORAGE_KEY, JSON.stringify(sectionVisible));
    } catch {
      /* The choice simply is not remembered when storage is unavailable. */
    }
  }, [sectionVisible]);
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
    setWorkspaceError("");
    if (!workspace) return;
    // Registers the workspace's repository without stealing focus from whichever
    // repository the user has already selected in the switcher -- `open()` still
    // activates it when nothing is active yet (e.g. on first load), matching
    // `GitRegistry.openNew`'s own default-activation rule. See the Repository &
    // Worktree Architecture plan's Gap 1: Explorer navigation must never silently
    // reassign the active repository once the user has made an explicit choice.
    gitRegistry.open(workspace).catch((error) => {
      if (!cancelled) setWorkspaceError(String(error));
    });
    return () => {
      cancelled = true;
    };
  }, [workspace]);

  useEffect(() => {
    callbacks.current.onEntries(workspaceSnapshot?.entries ?? []);
  }, [workspaceSnapshot?.entries]);

  // `revision` bumps always force a refresh (it means something in the
  // workspace genuinely changed) -- but a plain filesystem file
  // change/create/delete/rename can only ever affect this worktree's own
  // status entries (see the Filesystem Watcher & Invalidation Architecture
  // plan's Section D), never branch/branches/remotes/stashes/operation state,
  // so that case is scoped to just `entries` instead of the six-field refresh
  // every trigger used to request. Switching *which worktree* is active is a
  // different kind of event -- any field could be stale after a switch, not
  // just entries -- so that case still requests a full refresh, unless the
  // target's own RepoStore has already been polled every 5s in the background
  // (see the loop below) recently enough that it's already at most that fresh.
  const lastActiveRepoRef = useRef<typeof activeRepo>(null);
  const lastRevisionRef = useRef(revision);
  useEffect(() => {
    if (!activeRepo) return;
    const switchedWorktree = lastActiveRepoRef.current !== activeRepo;
    const revisionChanged = lastRevisionRef.current !== revision;
    lastActiveRepoRef.current = activeRepo;
    lastRevisionRef.current = revision;
    if (switchedWorktree) {
      // A pending "Undo last discard" offer resolves `activeRepo` fresh at click
      // time -- if left set across a repository switch, clicking Undo after
      // switching would apply the previous repository's recovered content against
      // whichever repository is now active (see the Git UI Architecture plan's
      // Gap 1). Clearing it here, on the same signal that already detects a
      // genuine worktree switch, closes that window.
      setRecovery(null);
      setRowLimits({});
      if (Date.now() - activeRepo.store.lastRefreshedAt < 5000) return;
      // Silent, like every other refresh nobody asked for: this repository already has
      // data on screen, and announcing the top-up would disable the panel over it.
      void activeRepo.store.refresh(undefined, { silent: true });
    } else if (revisionChanged) {
      void activeRepo.store.refresh(["entries"], { silent: true });
    }
  }, [activeRepo, revision]);

  // Re-fetches the active repository's knownWorktrees (which worktree/lock/prune
  // metadata `git worktree list --porcelain` reports) on focus regain -- the one
  // existing signal for "the user may have done something outside Yavin," and the
  // only thing that otherwise keeps that list from ever refreshing after a
  // repository is first opened (see the Git State & Synchronization plan's
  // Section U). Piggybacks on `window`'s own focus event rather than adding a new
  // watch target; full live worktree add/remove detection stays out of scope.
  useEffect(() => {
    if (!activeRepo) return;
    const repositoryId = gitRegistry.repositoryFor(activeRepo.repoId)?.repositoryId;
    if (!repositoryId) return;
    const update = () => void gitRegistry.refreshKnownWorktrees(repositoryId);
    window.addEventListener("focus", update);
    return () => window.removeEventListener("focus", update);
  }, [activeRepo]);

  // Keeps every open repo's status live (the Repositories section and the activity-bar
  // count) while this panel is visible. Focus refreshes every repo fully. The timer
  // refreshes the active repo fully but every other repo's `entries` only: nothing
  // watches a background worktree's working tree, so status is the one thing the poll
  // must cover, while the per-repository `.git` watcher already reports its
  // branch/refs/stash/operation-state changes (unless the watcher failed to start). Measured: 10 open worktrees cost 60
  // Git processes (1.85 s of wall time) per 5 s tick when every field was polled.
  useEffect(() => {
    if (!visible) return;
    const update = (fields?: RefreshField[]) => {
      for (const entry of registrySnapshot.repos) {
        // A repository whose watcher is down gets the full poll: nothing else would report
        // its branch, ref, stash or operation-state changes.
        const background =
          fields &&
          entry.repoId !== registrySnapshot.activeRepoId &&
          !gitRegistry.isWatcherDown(entry.repoId);
        // The poll and the focus refresh are both silent: they happen whether or not
        // anyone is looking, and a view that flickers every five seconds reads as broken.
        void entry.store.refresh(background ? fields : undefined, { silent: true });
      }
    };
    const onFocus = () => update();
    window.addEventListener("focus", onFocus);
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") update(["entries"]);
    }, 5000);
    return () => {
      window.removeEventListener("focus", onFocus);
      clearInterval(timer);
    };
  }, [visible, registrySnapshot.repos, registrySnapshot.activeRepoId]);

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

  const selectWorktree = async (path: string) => {
    setOpenError("");
    try {
      await gitRegistry.open(path, { makeActive: true });
    } catch (error) {
      setOpenError(String(error));
    }
  };

  const cloneRepository = () => cloneRepositoryFlow(onDialog);

  /** `git init` in the open workspace folder, then track it like any other repository. */
  const initializeWorkspace = async () => {
    if (!workspace) return;
    setInitError("");
    setInitBusy(true);
    try {
      await native("git_init_repo", { path: workspace });
      await gitRegistry.open(workspace, { makeActive: true });
      setWorkspaceError("");
    } catch (error) {
      setInitError(String(error));
    } finally {
      setInitBusy(false);
    }
  };

  const removeRepository = (repoId: string) => void gitRegistry.close(repoId);
  const selectRepository = (repoId: string) => gitRegistry.setActive(repoId);

  const guarded = (kind: string, operation: () => Promise<string>) => {
    if (!activeRepo) return Promise.resolve(false);
    return guardedAffecting(activeRepo, kind, dirty, operation);
  };

  const showDiff = async (entry: GitEntry, staged: boolean) => {
    if (!activeRepo) return;
    const current = ++diffGeneration.current;
    try {
      const text = entry.untracked
        ? await native("read_file_content", { path: entry.path })
        : await activeRepo.store.repository.diff(entry.path, staged, entry.originalPath);
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
        ...(entry.originalPath ? { originalPath: entry.originalPath } : {}),
      });
    } catch (error) {
      if (alive.current) activeRepo.store.setNotice(String(error));
    }
  };

  /** Clicking a row shows what is still uncommitted-and-unstaged; a fully staged file shows
   * its staged change instead. (A partly staged file offers both.) */
  const openEntry = (entry: GitEntry) =>
    showDiff(entry, hasStagedPart(entry) && !hasUnstagedPart(entry));

  /** The row checkbox: checked means fully staged, so clicking it unstages; anything less
   * (empty or partly staged) stages what is left. */
  const toggleStage = (entry: GitEntry) => {
    if (!activeRepo) return;
    const fullyStaged = hasStagedPart(entry) && !hasUnstagedPart(entry);
    if (
      !fullyStaged &&
      entry.conflict &&
      !window.confirm("Stage this file as resolved? Review and remove conflict markers first.")
    )
      return;
    void guarded(fullyStaged ? "unstage" : "stage", () =>
      fullyStaged
        ? activeRepo.store.repository.unstage(entry.path)
        : activeRepo.store.repository.stage(entry.path),
    );
  };

  const deleteBranch = async (name: string) => {
    if (!activeRepo) return;
    const ok = await guarded("deleteBranch", () =>
      activeRepo.store.repository.deleteBranch(name, false),
    );
    if (ok) return;
    // A safe (-d) delete's own refusal for "unmerged commits" is the one case with a
    // clear, informed escalation (Section D.2/Q of the plan) -- every other refusal
    // (checked out in another worktree, checked out here) has no override that would
    // actually succeed, so no confirm is offered for those; the classified notice
    // already explains why.
    const notice = activeRepo.store.getSnapshot().notice;
    if (
      notice.includes("commits not on any other branch") &&
      window.confirm(`"${name}" has commits not on any other branch. Delete it anyway?`)
    ) {
      await guarded("deleteBranch", () => activeRepo.store.repository.deleteBranch(name, true));
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

  /**
   * Resolves a conflicted file by taking one side whole, then staging it as resolved --
   * what "Accept Current/Incoming Change" does in a VS Code-family merge editor.
   *
   * Written through the same `apply` path as Discard (so it is undoable and goes through the
   * editor's own write path) rather than `git restore --ours/--theirs`, which is not
   * allow-listed: on a path Git does not consider conflicted, that flag silently overwrites
   * the file from the index instead of refusing.
   */
  const acceptConflictSide = async (entry: GitEntry, side: "ours" | "theirs") => {
    if (!activeRepo) return;
    await guarded("stage", async () => {
      const repo = activeRepo.store.repository;
      const before = await native("read_file_content", { path: entry.path });
      const after = await repo.conflictSide(entry.path, side);
      const change = { path: entry.path, before, after };
      const outcome = await apply([change]);
      if (outcome.errors.length) throw new Error(outcome.errors.join(" "));
      setRecovery([change]);
      await repo.stage(entry.path);
      await callbacks.current.onChanged();
      return side === "ours"
        ? "Kept this branch's version and staged it as resolved."
        : "Took the incoming version and staged it as resolved.";
    });
  };

  const discardAll = async (targetEntries: GitEntry[]) => {
    if (!activeRepo) return;
    const modified = targetEntries.filter(isDiscardable);
    const untouched = targetEntries.length - modified.length;
    const others = `${untouched} other file${untouched === 1 ? "" : "s"}`;
    if (!modified.length) {
      // Never a silent no-op: say what Discard All covers and why nothing happened.
      activeRepo.store.setNotice(
        "Nothing to discard. Discard All restores modified tracked files only; untracked, deleted, staged-only and conflicted files are left as they are.",
      );
      return;
    }
    const scope = untouched
      ? `${others} (untracked, deleted, staged-only or in conflict) will not be touched. `
      : "";
    if (
      !window.confirm(
        `Discard saved changes in ${modified.length} modified file${modified.length === 1 ? "" : "s"}? ${scope}Staged changes are kept. A recovery copy is kept until the next discard or workspace close ("Undo last discard").`,
      )
    )
      return;
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
      // Whatever was actually restored can be undone, even when other files failed: a
      // partial failure must not also lose the recovery copy of the files that did change.
      if (outcome.applied.length) {
        setRecovery(outcome.applied);
        await callbacks.current.onChanged();
      }
      if (outcome.errors.length) {
        throw new Error(
          `Discarded ${outcome.applied.length} of ${changes.length} files. ${outcome.errors.join(" ")}`,
        );
      }
      return `Discarded changes in ${changes.length} file${changes.length === 1 ? "" : "s"}.${
        untouched ? ` ${others} were not touched.` : ""
      }`;
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

  // Source Control follows the folder that is open. When that folder is not a repository (and
  // nothing else is tracked or active), offer to make it one instead of an empty panel.
  const showInit =
    !!workspace &&
    !activeRepo &&
    registrySnapshot.repos.length === 0 &&
    /not a Git repository/i.test(workspaceError);
  const shownError = showInit
    ? ""
    : openError || (registrySnapshot.repos.length === 0 ? workspaceError : "");
  const entries = snapshot?.entries ?? [];
  const branch = snapshot?.branch ?? {
    name: "",
    detached: false,
    upstream: "",
    ahead: 0,
    behind: 0,
  };
  const branches = snapshot?.branches ?? [];
  const remotes = snapshot?.remotes ?? [];
  const operationInProgress = snapshot?.operationInProgress ?? "";
  const busy = snapshot?.busy ?? false;
  const loading = snapshot?.loading ?? false;
  const notice = snapshot?.notice ?? "";
  const cancelled = snapshot?.cancelled ?? false;
  const stale = snapshot?.stale ?? false;
  // A worktree whose folder was deleted, moved or emptied of its Git link is not shown as if
  // it were current: no status, no actions, just what happened and how to move on.
  const unusable = !!activeRepo && activeRepo.status !== "ready";

  // One list for everything: conflicts first, then every other changed file, ordered by the
  // chosen "Sort Changes" mode. Whether a file is staged is shown by its checkbox, not by
  // which section it sits in. Memoized on `entries` and the sort mode alone so typing a
  // commit message never re-derives it.
  const { listed, stagedCount, modifiedCount, conflictCount, allStaged, discardable } =
    useMemo(() => {
      const conflicts = entries.filter((e) => e.conflict);
      const others = entries.filter((e) => !e.conflict);
      const stageable = others; // conflicts are resolved one at a time, never in bulk
      return {
        listed: sortChanges(entries, changesSort),
        stagedCount: entries.filter(hasStagedPart).length,
        // What a commit with nothing staged would pick up itself (`-a`): tracked files with
        // working-tree changes. Untracked files are excluded, exactly as `-a` excludes them.
        modifiedCount: others.filter((e) => !e.untracked && e.worktree !== " ").length,
        conflictCount: conflicts.length,
        allStaged:
          stageable.length > 0 && stageable.every((e) => hasStagedPart(e) && !hasUnstagedPart(e)),
        // What "Discard All" acts on: modified tracked files only (see `isDiscardable`).
        discardable: entries.filter(isDiscardable).length,
      };
    }, [entries, changesSort]);
  const sync = divergence(branch);

  const toggleSection = (name: keyof SectionVisibility) =>
    setSectionVisible((prev) => ({ ...prev, [name]: !prev[name] }));
  const toggleCollapsed = (name: keyof SectionVisibility) =>
    setSectionCollapsed((prev) => ({ ...prev, [name]: !prev[name] }));

  /**
   * A repo-relative path for display and for tree grouping, compared by the same rules as
   * `rootContains`: a plain `startsWith` meant that when Git reported a differently-cased
   * drive letter or root (routine on Windows) every row fell back to its full absolute path
   * and the tree grouped them under a bogus root.
   */
  const relativePath = (path: string): string => {
    const rel = relativeTo(activeRepo?.root ?? "", path);
    // The root itself has no repo-relative name; it was "" before this used `relativeTo`.
    return rel === undefined ? path : rel === "." ? "" : rel;
  };

  // "View as Tree": the same flat `listed` entries, grouped into folders (single-child chains
  // compacted, matching the Explorer's own convention -- see `fileTree.ts`). Bulk actions
  // (Stage All, Discard All, ...) are unaffected: they always act on `entries` directly,
  // regardless of how the list happens to be drawn right now.
  const treeRows = useMemo(
    () =>
      changesViewAsTree
        ? flattenVisible(
            // `listed` is already in the user's chosen order with conflicts first; the tree
            // groups it without reordering the files inside each folder.
            buildFileTree(listed, (e) => relativePath(e.path), { preserveFileOrder: true }),
            collapsedFolders,
          )
        : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `relativePath` closes only over `activeRepo?.root`
    [changesViewAsTree, listed, collapsedFolders, activeRepo?.root],
  );

  // The row cap applies to whichever view is drawn. Tree mode used to ignore it entirely and
  // render every row, so switching a large change set to View as Tree froze the panel for
  // seconds -- the exact cost `ROWS_PER_PAGE` exists to bound. Folder rows count toward the
  // cap too: they are the same ~22 DOM nodes as a file row.
  const totalRowCount = changesViewAsTree ? (treeRows?.length ?? 0) : listed.length;
  const shownRowCount = rowLimits.Changes ?? ROWS_PER_PAGE;

  /** One changed-file row -- shared between the flat list and the tree view, `depth` only
   * changing its indentation. */
  const renderFileRow = (entry: GitEntry, depth = 0) => {
    const relative = relativePath(entry.path);
    const parts = relative.split(/[/\\]/);
    const fileName = parts.pop() || relative;
    const dirPath = changesViewAsTree ? "" : parts.join("/"); // the tree already shows the folder
    const status = getStatusInfo(entry);
    const staged = hasStagedPart(entry);
    const partial = staged && hasUnstagedPart(entry);
    const checked = staged && !partial;
    const isActiveDiff = activeDiffPath === entry.path;

    return (
      <div
        key={entry.path}
        role="button"
        tabIndex={0}
        aria-label={`Open diff for ${entry.path}`}
        style={{ paddingLeft: `${8 + depth * 14}px` }}
        className={`flex items-center gap-1.5 pr-2.5 h-[22px] hover:bg-surface-hover group/row transition-colors cursor-pointer ${
          isActiveDiff ? "bg-accent/15" : ""
        }`}
        onClick={() => void openEntry(entry)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            void openEntry(entry);
          }
        }}
      >
        <button
          role="checkbox"
          aria-checked={checked ? true : partial ? "mixed" : false}
          aria-label={`Stage ${entry.path}`}
          title={checked ? `Unstage ${fileName}` : `Stage ${fileName}`}
          disabled={busy || loading}
          onClick={(e) => {
            e.stopPropagation();
            toggleStage(entry);
          }}
          className={`flex size-3.5 shrink-0 items-center justify-center rounded-[3px] border transition-colors disabled:opacity-40 ${
            staged
              ? "bg-accent border-accent text-white"
              : "border-border-strong text-transparent hover:border-ink-3"
          }`}
        >
          {checked ? <CheckIcon size={10} /> : partial ? <MinusIcon size={10} /> : null}
        </button>

        <FileIcon name={fileName} isDir={false} className="size-3.5 shrink-0" />

        <div className="flex items-baseline min-w-0 flex-1 truncate">
          <span
            className={`text-xs truncate ${
              status.letter === "D" ? "line-through text-ink-3" : "text-ink"
            }`}
            title={entry.originalPath ? `${entry.originalPath} → ${entry.path}` : entry.path}
          >
            {fileName}
          </span>
          {dirPath && <span className="text-ink-3 text-[10.5px] ml-1.5 truncate">{dirPath}</span>}
        </div>

        <div
          className="flex items-center gap-0.5 opacity-0 group-hover/row:opacity-100 focus-within:opacity-100 transition-opacity shrink-0"
          onClick={(e) => e.stopPropagation()}
        >
          <button
            disabled={busy}
            title="Open Diff"
            aria-label="Open Diff"
            onClick={() => void openEntry(entry)}
            className="p-0.5 rounded text-ink-3 hover:text-ink hover:bg-border-strong transition-colors"
          >
            <DiffIcon size={12} />
          </button>
          {partial && (
            <button
              disabled={busy}
              title="Open staged changes"
              aria-label={`Open staged diff for ${entry.path}`}
              onClick={() => void showDiff(entry, true)}
              className="p-0.5 rounded text-ink-3 hover:text-ink hover:bg-border-strong transition-colors"
            >
              <CheckIcon size={12} />
            </button>
          )}
          {entry.worktree === "M" && !entry.conflict && (
            <button
              disabled={busy || loading}
              aria-label={`Discard ${entry.path}`}
              title={`Discard changes in ${fileName}`}
              onClick={() => void discard(entry)}
              className="p-0.5 rounded text-ink-3 hover:text-ink hover:bg-border-strong transition-colors"
            >
              <UndoIcon size={12} />
            </button>
          )}
          {/* Resolving a conflict by taking one side whole -- the common case that otherwise
              means hand-editing conflict markers. Both are undoable, like Discard. */}
          {entry.conflict && (
            <>
              <button
                disabled={busy || loading}
                aria-label={`Accept current change for ${entry.path}`}
                title={`Resolve ${fileName} by keeping this branch's version`}
                onClick={() => void acceptConflictSide(entry, "ours")}
                className="rounded px-1 text-[10px] text-ink-3 hover:bg-border-strong hover:text-ink"
              >
                Ours
              </button>
              <button
                disabled={busy || loading}
                aria-label={`Accept incoming change for ${entry.path}`}
                title={`Resolve ${fileName} by taking the incoming version`}
                onClick={() => void acceptConflictSide(entry, "theirs")}
                className="rounded px-1 text-[10px] text-ink-3 hover:bg-border-strong hover:text-ink"
              >
                Theirs
              </button>
            </>
          )}
        </div>

        <span
          title={`Status: ${status.letter}`}
          className={`w-3 text-center text-[11px] font-semibold shrink-0 ${status.color}`}
        >
          {status.letter}
        </span>
      </div>
    );
  };

  return (
    <aside
      hidden={!visible}
      aria-label="Source control"
      className="flex flex-col h-full w-[300px] shrink-0 border-r border-border bg-canvas select-none text-[12px] font-sans text-ink"
    >
      {/* Panel Header -- same shape as the Explorer and Search headers */}
      <div className="flex h-9 items-center justify-between px-3 border-b border-border text-ink-2 shrink-0">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-2">
          Source Control
        </span>
        <div className="flex items-center gap-0.5">
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

      {shownError && (
        <p role="status" className="px-3 pt-2 text-[11px] text-red-400 break-words">
          {shownError}
        </p>
      )}

      {showInit && (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-5 text-center">
          <GitBranchIcon size={28} className="text-ink-3" />
          <p className="text-xs text-ink">The folder currently open is not a Git repository.</p>
          <p className="text-[11px] text-ink-3">
            Initialize a repository to turn on source control for{" "}
            <span className="text-ink-2">
              {workspace.split(/[/\\]/).filter(Boolean).pop() ?? workspace}
            </span>
            .
          </p>
          <button
            aria-label="Initialize Repository"
            disabled={initBusy}
            onClick={() => void initializeWorkspace()}
            className="w-full rounded bg-accent py-1.5 text-xs font-medium text-white transition-colors hover:bg-accent-hover disabled:opacity-40"
          >
            {initBusy ? "Initializing…" : "Initialize Repository"}
          </button>
          <button
            onClick={() => void addRepository()}
            className="text-[11px] text-ink-3 underline-offset-2 hover:text-ink hover:underline"
          >
            Or add an existing repository folder
          </button>
          {initError && (
            <p role="status" className="text-[11px] break-words text-red-400">
              {initError}
            </p>
          )}
        </div>
      )}

      <div className={`flex-1 min-h-0 flex-col ${showInit ? "hidden" : "flex"}`}>
        {sectionVisible.repositories && (
          <RepositoriesSection
            repos={registrySnapshot.repos}
            repositories={registrySnapshot.repositories}
            activeRepoId={registrySnapshot.activeRepoId}
            dirty={dirty}
            hasMessage={hasMessage}
            getMessage={getMessage}
            collapsed={sectionCollapsed.repositories}
            onToggleCollapse={() => toggleCollapsed("repositories")}
            onSelect={selectRepository}
            onSelectWorktree={(path) => void selectWorktree(path)}
            onRemove={removeRepository}
            onAdd={() => void addRepository()}
            onCommitted={() => commitBoxRef.current?.clear()}
            onOpenBranches={() => setBranchesOpen(true)}
            onDialog={onDialog}
          />
        )}

        {sectionVisible.changes && (
          <section aria-label="Changes panel" className="flex min-h-0 flex-1 flex-col text-xs">
            <div
              onClick={() => toggleCollapsed("changes")}
              className="flex items-center gap-1.5 px-2 h-7 cursor-pointer hover:bg-surface-hover transition-colors"
            >
              <ChevronIcon isExpanded={!sectionCollapsed.changes} className="size-3" />
              <span className="font-semibold text-[12px] text-ink">Changes</span>
              {branch.detached && (
                <span
                  title="HEAD is not on a branch. Commits made now belong to no branch until you switch to or create one."
                  className="rounded bg-yellow/15 px-1.5 text-[10px] leading-4 text-yellow"
                >
                  Detached HEAD
                </span>
              )}
              {stale && (
                <span
                  title="The last refresh failed, so this shows the last state Git reported. It updates after the next successful refresh."
                  className="rounded bg-yellow/15 px-1.5 text-[10px] leading-4 text-yellow"
                >
                  Out of date
                </span>
              )}
              <div className="flex-1" />
              {activeRepo && !unusable && (
                <div className="flex items-center gap-0.5" onClick={(e) => e.stopPropagation()}>
                  {stagedCount > 0 && (
                    <button
                      disabled={busy || loading || !hasMessage || conflictCount > 0}
                      title={hasMessage ? "Commit staged changes" : "Enter a commit message first"}
                      aria-label="Commit staged changes"
                      onClick={() => commitBoxRef.current?.commit()}
                      className="p-1 rounded text-ink-3 hover:text-ink hover:bg-border-strong transition-colors disabled:opacity-40"
                    >
                      <CheckIcon size={13} />
                    </button>
                  )}
                  <button
                    disabled={busy || loading}
                    onClick={() => void activeRepo?.store.refresh()}
                    title="Refresh Status"
                    aria-label="Refresh Status"
                    className="p-1 rounded text-ink-3 hover:text-ink hover:bg-border-strong transition-colors disabled:opacity-30"
                  >
                    <RefreshIcon size={13} className={loading || busy ? "animate-spin" : ""} />
                  </button>
                  <button
                    onClick={() => setBranchesOpen(!branchesOpen)}
                    title="Branches and remotes"
                    aria-label="Branches and remotes"
                    className={`p-1 rounded transition-colors ${
                      branchesOpen
                        ? "text-accent-hover bg-accent/15"
                        : "text-ink-3 hover:text-ink hover:bg-border-strong"
                    }`}
                  >
                    <GitBranchIcon size={12} />
                  </button>
                  <GitMenu
                    icon={<MoreIcon size={14} />}
                    label="Changes actions"
                    buttonClassName="p-1 rounded text-ink-3 hover:text-ink hover:bg-border-strong"
                    items={buildGitCommandMenu({
                      entry: activeRepo,
                      dirty,
                      hasMessage,
                      getMessage,
                      onCommitted: () => commitBoxRef.current?.clear(),
                      onDialog,
                      onDiff,
                      onDiscardAll: () => void discardAll(entries),
                      includeViewOptions: true,
                      changesSort,
                      onSortChanges: setChangesSort,
                      changesViewAsTree,
                      onToggleViewAsTree: () => setChangesViewAsTree((v) => !v),
                      onClone: cloneRepository,
                      onShowOutput,
                    })}
                  />
                </div>
              )}
            </div>

            {!sectionCollapsed.changes && (
              <div className="shrink-0 max-h-[60%] overflow-y-auto p-3 pt-1 space-y-2.5">
                {activeRepo && unusable ? (
                  <div
                    role="alert"
                    className="space-y-2 rounded border border-yellow/30 bg-yellow/10 p-2"
                  >
                    <p className="text-[11px] font-medium text-ink">
                      {activeRepo.status === "missing"
                        ? "This worktree's folder is missing"
                        : "This folder is no longer this Git worktree"}
                    </p>
                    <p className="break-all font-mono text-[10.5px] text-ink-3">
                      {activeRepo.root}
                    </p>
                    <p className="text-[11px] leading-snug text-ink-2">
                      {activeRepo.status === "missing"
                        ? "It was deleted or moved, or its drive is not connected. Nothing below is current, so it is hidden. If it comes back, this updates by itself."
                        : "The folder is still there, but Git no longer finds this worktree in it (its .git link was removed or points elsewhere). Nothing below is current, so it is hidden."}
                    </p>
                    <button
                      onClick={() => removeRepository(activeRepo.repoId)}
                      className="rounded bg-surface-hover px-2 py-1 text-[11px] text-ink hover:bg-border-strong"
                    >
                      Close this worktree
                    </button>
                  </div>
                ) : !activeRepo ? (
                  registrySnapshot.repos.length > 0 ? (
                    <div className="space-y-1">
                      <p className="text-ink-3 text-[11px]">Choose a repository:</p>
                      {registrySnapshot.repos.map((entry) => (
                        <button
                          key={entry.repoId}
                          onClick={() => selectRepository(entry.repoId)}
                          aria-label={`Select repository ${entry.root.split("/").filter(Boolean).pop() ?? entry.root}`}
                          className="flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-xs text-ink hover:bg-surface-hover"
                        >
                          <GitBranchIcon size={12} className="shrink-0 text-ink-3" />
                          <span className="truncate">
                            {entry.root.split("/").filter(Boolean).pop() ?? entry.root}
                          </span>
                        </button>
                      ))}
                    </div>
                  ) : (
                    <p className="text-ink-3 text-[11px]">
                      {!workspace
                        ? "Open a workspace, or add a repository folder, to use Source Control."
                        : shownError
                          ? shownError
                          : "Discovering repository…"}
                    </p>
                  )
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
                            className="flex-1 py-1 rounded bg-surface-hover hover:bg-surface-hover text-[11px] text-ink disabled:opacity-40 transition-colors"
                          >
                            Abort
                          </button>
                          {/* Merge has no commit sequence to advance past -- Git itself has no
                              `merge --skip`, so this is only ever offered for the three
                              operations that genuinely process one. */}
                          {operationInProgress !== "merge" && (
                            <button
                              disabled={busy || loading || dirty}
                              onClick={() =>
                                void guarded("skip", () => activeRepo.store.repository.skip())
                              }
                              className="flex-1 py-1 rounded bg-surface-hover hover:bg-surface-hover text-[11px] text-ink disabled:opacity-40 transition-colors"
                            >
                              Skip
                            </button>
                          )}
                          <button
                            disabled={busy || loading || dirty || conflictCount > 0}
                            onClick={() =>
                              void guarded("continue", () =>
                                activeRepo.store.repository.continueOperation(),
                              )
                            }
                            className="flex-1 py-1 rounded bg-accent hover:bg-accent-hover text-[11px] text-white disabled:opacity-40 transition-colors"
                          >
                            Continue
                          </button>
                        </div>
                      </div>
                    )}

                    <fieldset disabled={busy || loading} className="space-y-2 disabled:opacity-60">
                      <CommitBox
                        ref={commitBoxRef}
                        draftKey={activeRepo.root}
                        branchName={branch.detached ? "detached HEAD" : branch.name}
                        menu={
                          <GitMenu
                            icon={<ChevronIcon isExpanded className="size-3.5" />}
                            label="Commit actions"
                            buttonClassName="flex items-center justify-center text-white"
                            items={buildGitCommandMenu({
                              entry: activeRepo,
                              dirty,
                              hasMessage,
                              getMessage,
                              onCommitted: () => commitBoxRef.current?.clear(),
                              onDialog,
                              onDiff,
                              onDiscardAll: () => void discardAll(entries),
                              onClone: cloneRepository,
                              onShowOutput,
                            })}
                          />
                        }
                        stagedCount={stagedCount}
                        modifiedCount={modifiedCount}
                        conflictCount={conflictCount}
                        busy={busy}
                        loading={loading}
                        onChange={onMessageChange}
                        onCommit={(message) =>
                          guarded("commit", () =>
                            // Nothing staged means "commit every tracked change", exactly as
                            // the dropdown's own Commit item does.
                            activeRepo.store.repository.commit(message, {
                              all: stagedCount === 0,
                            }),
                          )
                        }
                      />

                      {branchesOpen && (
                        <div className="space-y-2 pt-1 border-t border-border">
                          <select
                            aria-label="Switch branch"
                            className="w-full rounded border border-border-strong bg-surface px-2 py-1 text-xs text-ink-2 focus:border-accent focus:outline-none"
                            value={branches.includes(branch.name) ? branch.name : ""}
                            disabled={dirty}
                            onChange={(e) =>
                              void guarded("switch", () =>
                                activeRepo.store.repository.switchBranch(e.target.value),
                              )
                            }
                          >
                            <option value="" disabled>
                              {branch.detached ? "Detached HEAD: choose a branch" : "Choose branch"}
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
                              className="flex-1 min-w-0 rounded border border-border-strong bg-surface px-2 py-1 text-xs text-ink placeholder:text-ink-3 focus:border-accent focus:outline-none"
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
                              className="px-2 py-1 rounded bg-surface-hover hover:bg-border-strong text-[11px] text-ink disabled:opacity-40 transition-colors shrink-0"
                            >
                              Create
                            </button>
                          </div>

                          {/* The checked-out branch is excluded: Git always refuses to delete
                              it, so offering the button was a guaranteed dead end. The
                              command menu's Delete Branch… already filtered it out. */}
                          {branches.some((name) => name !== branch.name) && (
                            <ul aria-label="Delete a branch" className="space-y-0.5">
                              {branches
                                .filter((name) => name !== branch.name)
                                .map((name) => (
                                  <li
                                    key={name}
                                    className="flex items-center gap-1.5 rounded px-1 py-0.5 hover:bg-surface-hover"
                                  >
                                    <span className="flex-1 min-w-0 truncate text-[11px] text-ink-2 font-mono">
                                      {name}
                                    </span>
                                    <button
                                      aria-label={`Delete ${name}`}
                                      title={`Delete ${name}`}
                                      onClick={() => void deleteBranch(name)}
                                      className="p-0.5 rounded text-ink-3 hover:text-red-400 hover:bg-red-950/40 transition-colors shrink-0"
                                    >
                                      <TrashIcon size={11} />
                                    </button>
                                  </li>
                                ))}
                            </ul>
                          )}

                          {sync === "diverged" && (
                            <div className="rounded border border-border bg-surface p-2 space-y-1.5">
                              <p className="text-ink-2 text-[11px]">
                                Diverged: {branch.ahead} local and {branch.behind} remote commits.
                              </p>
                              <p className="text-ink-3 text-[10.5px]">
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
                                  className="flex-1 py-1 rounded bg-surface-hover hover:bg-surface-hover text-[11px] text-ink-2 disabled:opacity-40 transition-colors"
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
                                  className="flex-1 py-1 rounded bg-surface-hover hover:bg-surface-hover text-[11px] text-ink-2 disabled:opacity-40 transition-colors"
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
                              className="flex-1 py-1 rounded bg-surface-hover hover:bg-surface-hover text-[11px] text-ink-2 disabled:opacity-40 transition-colors"
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
                                className="flex-1 py-1 rounded bg-surface-hover hover:bg-surface-hover text-[11px] text-ink-2 disabled:opacity-40 transition-colors"
                              >
                                Pull
                              </button>
                            )}
                            {branch.upstream && (
                              <button
                                onClick={() =>
                                  void guarded("push", () => activeRepo.store.repository.push())
                                }
                                className="flex-1 py-1 rounded bg-surface-hover hover:bg-surface-hover text-[11px] text-ink-2 disabled:opacity-40 transition-colors"
                              >
                                Push
                              </button>
                            )}
                          </div>

                          {branch.detached && (
                            <p className="text-ink-3 text-[11px]">
                              HEAD is detached, so there is no branch to publish. Switch to a
                              branch, or create one here first.
                            </p>
                          )}
                          {!branch.upstream &&
                            !branch.detached &&
                            (remotes.length === 0 ? (
                              <p className="text-ink-3 text-[11px]">
                                No remote is configured. Add one with `git remote add` to publish
                                this branch.
                              </p>
                            ) : (
                              <div className="flex gap-1">
                                <select
                                  aria-label="Remote"
                                  className="flex-1 min-w-0 rounded border border-border-strong bg-surface px-2 py-1 text-xs text-ink-2 focus:border-accent focus:outline-none"
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
                                  className="px-2 py-1 rounded bg-surface-hover hover:bg-border-strong text-[11px] text-ink disabled:opacity-40 transition-colors shrink-0"
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

                {/* The live region is always mounted, only its text changes. Mounting it
                    together with the first notice meant screen readers had nothing to watch
                    at the moment the text appeared, so the first result of every operation
                    went unannounced -- a live region has to pre-exist its own updates. */}
                <div
                  className={`flex items-center gap-2 ${notice || busy || loading ? "" : "hidden"}`}
                >
                  <p
                    role="status"
                    aria-live="polite"
                    className={`flex-1 text-[11px] break-words leading-tight ${
                      cancelled ? "text-ink-3" : "text-ink-2"
                    }`}
                  >
                    {busy ? "Running Git operation…" : loading ? "Refreshing…" : notice}
                  </p>
                  {busy && (
                    <button
                      onClick={() => activeRepo?.store.cancel()}
                      title="Cancel this Git operation"
                      className="shrink-0 rounded px-1.5 py-0.5 text-[10px] text-ink-2 hover:bg-surface-hover hover:text-ink"
                    >
                      Cancel
                    </button>
                  )}
                </div>

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
                    className="w-full rounded bg-border-strong hover:bg-surface-hover py-1 text-[11px] text-ink transition-colors flex items-center justify-center gap-1.5"
                  >
                    <UndoIcon size={12} />
                    <span>Undo last discard</span>
                  </button>
                )}
              </div>
            )}

            {!sectionCollapsed.changes && activeRepo && !unusable && (
              <>
                <div
                  role="button"
                  tabIndex={0}
                  aria-expanded={!changesGroupCollapsed}
                  aria-label="Changes group"
                  onClick={() => setChangesGroupCollapsed((c) => !c)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setChangesGroupCollapsed((c) => !c);
                    }
                  }}
                  className="flex h-6 shrink-0 cursor-pointer items-center gap-1.5 bg-surface px-2 hover:bg-surface-hover"
                >
                  <ChevronIcon isExpanded={!changesGroupCollapsed} className="size-3" />
                  <span className="text-[12px] text-ink">Changes</span>
                  <div className="flex-1" />
                  <div className="flex items-center gap-0.5" onClick={(e) => e.stopPropagation()}>
                    {entries.length > 0 && (
                      <>
                        <button
                          disabled={busy || loading || discardable === 0}
                          title={
                            discardable === 0
                              ? "Nothing to discard: Discard All restores modified tracked files only"
                              : `Discard changes in ${discardable} modified file${discardable === 1 ? "" : "s"}. Untracked, deleted, staged-only and conflicted files are not affected.`
                          }
                          aria-label="Discard All Changes"
                          onClick={() => void discardAll(entries)}
                          className="p-1 rounded text-ink-3 hover:text-ink hover:bg-border-strong transition-colors disabled:opacity-40"
                        >
                          <UndoIcon size={12} />
                        </button>
                        {allStaged ? (
                          <button
                            disabled={busy || loading}
                            title="Unstage All Changes"
                            aria-label="Unstage All Changes"
                            onClick={() => void unstageAll(entries.filter(hasStagedPart))}
                            className="p-1 rounded text-ink-3 hover:text-ink hover:bg-border-strong transition-colors disabled:opacity-40"
                          >
                            <MinusIcon size={12} />
                          </button>
                        ) : (
                          <button
                            disabled={busy || loading}
                            title="Stage All Changes"
                            aria-label="Stage All Changes"
                            onClick={() =>
                              void stageAll(
                                entries.filter((e) => !e.conflict && hasUnstagedPart(e)),
                              )
                            }
                            className="p-1 rounded text-ink-3 hover:text-ink hover:bg-border-strong transition-colors disabled:opacity-40"
                          >
                            <PlusIcon size={12} />
                          </button>
                        )}
                      </>
                    )}
                  </div>
                  {entries.length > 0 && (
                    <span
                      aria-label={`${entries.length} changed files`}
                      className="rounded-full bg-border-strong px-1.5 font-mono text-[10px] leading-4 text-ink-2"
                    >
                      {entries.length}
                    </span>
                  )}
                </div>
                {!changesGroupCollapsed && (
                  <div
                    role="list"
                    aria-label="Changed files"
                    className="min-h-[44px] flex-1 overflow-y-auto pb-1"
                  >
                    {entries.length === 0 && !loading && (
                      // One row tall, like a single file: a big centred empty state made everything
                      // below it (the Graph) jump ~100 px the moment the last file was committed,
                      // and a click aimed at the Graph toolbar then landed elsewhere.
                      <p className="flex h-[22px] items-center gap-1.5 px-3 text-[11px] text-ink-3">
                        <CheckIcon size={12} className="shrink-0" />
                        Working tree clean
                      </p>
                    )}

                    {changesViewAsTree
                      ? treeRows!.slice(0, shownRowCount).map((row) =>
                          row.node.kind === "folder" ? (
                            <div
                              key={`folder:${row.node.path}`}
                              role="button"
                              tabIndex={0}
                              aria-expanded={row.expanded}
                              aria-label={`${row.expanded ? "Collapse" : "Expand"} ${row.node.name}`}
                              style={{ paddingLeft: `${8 + row.depth * 14}px` }}
                              className="flex items-center gap-1.5 pr-2.5 h-[22px] hover:bg-surface-hover group/row transition-colors cursor-pointer text-ink-2"
                              onClick={() => toggleFolder(row.node.path)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter" || e.key === " ") {
                                  e.preventDefault();
                                  toggleFolder(row.node.path);
                                }
                              }}
                            >
                              <ChevronIcon isExpanded={row.expanded} className="size-3 shrink-0" />
                              <FileIcon name={row.node.name} isDir className="size-3.5 shrink-0" />
                              <span className="text-xs truncate">{row.node.name}</span>
                              {/* Folder-level actions, acting on every file below the folder
                                  including collapsed ones -- the same bulk handlers the
                                  section header uses, so the behaviour cannot drift. */}
                              <div className="ml-auto flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover/row:opacity-100 focus-within:opacity-100">
                                {(() => {
                                  const files = collectFiles([row.node]);
                                  const discardable = files.filter(isDiscardable);
                                  return (
                                    <>
                                      <button
                                        title={`Stage ${files.length} file${files.length === 1 ? "" : "s"} in ${row.node.name}`}
                                        aria-label={`Stage folder ${row.node.name}`}
                                        disabled={busy}
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          void stageAll(files);
                                        }}
                                        className="rounded p-0.5 text-ink-3 hover:bg-surface-hover hover:text-ink disabled:opacity-40"
                                      >
                                        <PlusIcon size={11} />
                                      </button>
                                      <button
                                        title={`Unstage ${files.length} file${files.length === 1 ? "" : "s"} in ${row.node.name}`}
                                        aria-label={`Unstage folder ${row.node.name}`}
                                        disabled={busy}
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          void unstageAll(files);
                                        }}
                                        className="rounded p-0.5 text-ink-3 hover:bg-surface-hover hover:text-ink disabled:opacity-40"
                                      >
                                        <MinusIcon size={11} />
                                      </button>
                                      <button
                                        title={
                                          discardable.length
                                            ? `Discard changes in ${discardable.length} file${discardable.length === 1 ? "" : "s"} in ${row.node.name}`
                                            : `Nothing in ${row.node.name} can be discarded`
                                        }
                                        aria-label={`Discard folder ${row.node.name}`}
                                        disabled={busy || discardable.length === 0}
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          void discardAll(discardable);
                                        }}
                                        className="rounded p-0.5 text-ink-3 hover:bg-surface-hover hover:text-red-400 disabled:opacity-40"
                                      >
                                        <UndoIcon size={11} />
                                      </button>
                                    </>
                                  );
                                })()}
                              </div>
                            </div>
                          ) : (
                            renderFileRow(row.node.item, row.depth)
                          ),
                        )
                      : listed.slice(0, shownRowCount).map((entry) => renderFileRow(entry))}
                    {totalRowCount > shownRowCount && (
                      <button
                        onClick={() =>
                          setRowLimits((prev) => ({
                            ...prev,
                            Changes: (prev.Changes ?? ROWS_PER_PAGE) + ROWS_PER_PAGE,
                          }))
                        }
                        className="w-full py-1.5 text-[11px] text-ink-2 hover:bg-surface-hover hover:text-ink"
                      >
                        Show {Math.min(ROWS_PER_PAGE, totalRowCount - shownRowCount)} more of{" "}
                        {totalRowCount - shownRowCount} remaining
                      </button>
                    )}
                  </div>
                )}
              </>
            )}
          </section>
        )}

        {sectionVisible.graph && (
          <InlineGraphSection
            entry={unusable ? null : activeRepo}
            dirty={dirty}
            collapsed={sectionCollapsed.graph}
            onToggleCollapse={() => toggleCollapsed("graph")}
            onExpand={onOpenGraph}
            onDiff={onDiff}
            onDialog={onDialog}
          />
        )}

        {sectionVisible.stashes && (
          <StashesSection
            entry={unusable ? null : activeRepo}
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
