import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { native } from "../../services/native";
import type { GitEntry } from "../../services/git/parsers/status";
import type { GitOperation } from "../../services/git/backend";
import { cloneRepository as cloneRepositoryFlow } from "../../services/git/clone";
import { containsPath, relativePath as relativeTo } from "../../services/resource";
import { useWorkspace } from "../../services/workspaces";
import { workspaceIdOf } from "../../services/workspaceManager";
import {
  useActiveRepo,
  useGitRegistry,
  useGitRegistryInstance,
  useRepoSnapshot,
} from "../../services/git/hooks";
import { useGitRevision } from "../../services/git/revision";
import { guardedAffecting } from "../../services/git/sync";
import type { RefreshField } from "../../services/git/store";
import { RepositoriesSection } from "../git/RepositoriesSection";
import { CommitComposer } from "../git/CommitComposer";
import type { CommitBoxHandle } from "../git/CommitComposer";
import { BranchBar } from "../git/BranchBar";
import { GroupIcon, IconAction, ListIcon, SectionHeader, TreeIcon } from "../git/SectionHeader";
import { ContextMenu } from "../ui/ContextMenu";
import {
  groupChanges,
  hasStagedPart,
  hasUnstagedPart,
  isDiscardable,
  opensStagedDiff,
} from "../../services/git/changeGroups";
import type { ChangeGroup } from "../../services/git/changeGroups";
import { buildChangeMenu, gitignoreLine, withIgnored } from "../../services/git/changeMenu";
import { InlineGraphSection } from "../git/InlineGraphSection";
import { StashesSection } from "../git/StashesSection";
import { GitMenu } from "../git/GitMenu";
import {
  readChangesSort,
  readChangesViewAsTree,
  saveChangesSort,
  saveChangesViewAsTree,
  statusLetter,
} from "../../services/git/changesSort";
import type { ChangesSort } from "../../services/git/changesSort";
import { buildGitCommandMenu } from "../git/gitCommandMenu";
import type { DiffDocument } from "./DiffEditor";
import type { Replacement } from "./SearchPanel";
import type { DialogRequest } from "../ui/AppDialog";
import { buildFileTree, collectFiles, flattenVisible } from "../../services/git/fileTree";
import type { TreeFolder } from "../../services/git/fileTree";
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

/** The change list shows a filter box once it has more files than this. */
const FILTER_FROM = 20;
const GROUPED_STORAGE_KEY = "yavin.scm.grouped";

/** A path relative to a repository root, for display, grouping and filtering; the root itself
 * is "" (compared by the rules in `resource.ts`, so a differently-cased drive still matches). */
const relativePathOf = (root: string) => (path: string) => {
  const rel = relativeTo(root, path);
  return rel === undefined ? path : rel === "." ? "" : rel;
};

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
  hasUnsavedEdits,
  dirty,
  onDiff,
  onChanged,
  onEntries,
  apply,
  activeDiffPath,
  onOpenGraph,
  onShowOutput,
  onDialog,
  onOpenFile,
  onReveal,
}: {
  workspace: string;
  visible: boolean;
  /**
   * Whether a file's open document has unsaved edits. Only those block hunk actions: a file
   * that is merely open shows its saved text, which is what the diff describes.
   */
  hasUnsavedEdits: (path: string) => boolean;
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
  /** Opens a changed file in the editor ("Open File"). */
  onOpenFile?: (path: string) => void;
  /** Shows a changed file in the Explorer ("Reveal in Explorer"). */
  onReveal?: (path: string) => void;
}) {
  // Subscribed here rather than taken as a prop: a counter held by the root component
  // re-rendered the whole window every time anything asked Git to look again.
  const revision = useGitRevision();
  // The workspace's own registry: opening another folder gives the panel another one.
  const gitRegistry = useGitRegistryInstance();
  // The workspace switches before this panel's `workspace` prop does: until they agree, the
  // folder is the old workspace's and must not be opened into the new one's registry.
  const workspaceId = useWorkspace().id;
  const ownFolder = !!workspace && workspaceIdOf([workspace]) === workspaceId;
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
  // Staged / Unstaged / Conflicts groups (the default), or one list with a checkbox per file.
  // A view preference, remembered like the sort order.
  const [grouped, setGrouped] = useState<boolean>(() => {
    try {
      return localStorage.getItem(GROUPED_STORAGE_KEY) !== "false";
    } catch {
      return true;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(GROUPED_STORAGE_KEY, String(grouped));
    } catch {
      /* Remembered where storage works. */
    }
  }, [grouped]);
  const [collapsedGroups, setCollapsedGroups] = useState<ReadonlySet<string>>(new Set());
  const [filter, setFilter] = useState("");
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
    setFilter("");
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

  useEffect(() => {
    let cancelled = false;
    setWorkspaceError("");
    if (!workspace || !ownFolder) return;
    // Registers the workspace's repository without stealing focus from whichever
    // repository the user has already selected in the switcher -- `open()` still
    // activates it when nothing is active yet (e.g. on first load), matching
    // `GitRegistry.openNew`'s own default-activation rule. See the Repository &
    // Worktree Architecture plan's Gap 1: Explorer navigation must never silently
    // reassign the active repository once the user has made an explicit choice.
    // The workspace restores its repositories and opens its folder's itself
    // (`services/workspaces.ts`); this is the same open, joined, for its error.
    gitRegistry.open(workspace).catch((error) => {
      if (!cancelled) setWorkspaceError(String(error));
    });
    return () => {
      cancelled = true;
    };
  }, [gitRegistry, workspace, ownFolder]);

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
      const unsaved = hasUnsavedEdits(entry.path);
      // Hunk-level staging makes no sense for an untracked file, an unresolved conflict, or a
      // file whose editor holds text this diff does not describe.
      const hunkStagingSafe = !entry.untracked && !entry.conflict && !unsaved;
      onDiff({
        path: entry.path,
        title: entry.untracked ? "Untracked file" : staged ? "HEAD → Index" : "Index → Saved file",
        text: text || "No textual differences. The change may be metadata-only.",
        ...(unsaved
          ? {
              notice:
                "The open editor has unsaved edits. This diff shows the saved file; save to stage its hunks.",
            }
          : {}),
        ...(hunkStagingSafe
          ? { repoId: activeRepo.repoId, kind: staged ? "staged" : "unstaged" }
          : {}),
        ...(entry.originalPath ? { originalPath: entry.originalPath } : {}),
      });
    } catch (error) {
      if (alive.current) activeRepo.store.setNotice(String(error));
    }
  };

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

  // The changed files as drawn -- grouped (Conflicts, Staged, Unstaged) or as one list, sorted
  // by the chosen mode and filtered by the filter box -- and the counts the commit button and
  // bulk actions use, which always cover every file, filtered or not. Memoized on `entries`,
  // the sort and the filter alone, so typing a commit message never re-derives them.
  const groups = useMemo(
    () => groupChanges(entries, changesSort, filter, relativePathOf(activeRepo?.root ?? "")),
    [entries, changesSort, filter, activeRepo?.root],
  );
  const { stagedCount, modifiedCount, conflictCount, allStaged, discardable } = useMemo(() => {
    const others = entries.filter((e) => !e.conflict);
    return {
      stagedCount: entries.filter(hasStagedPart).length,
      // What a commit with nothing staged would pick up itself (`-a`): tracked files with
      // working-tree changes. Untracked files are excluded, exactly as `-a` excludes them.
      modifiedCount: others.filter((e) => !e.untracked && e.worktree !== " ").length,
      conflictCount: entries.length - others.length,
      allStaged: others.length > 0 && others.every((e) => hasStagedPart(e) && !hasUnstagedPart(e)),
      // What "Discard All" acts on: modified tracked files only (see `isDiscardable`).
      discardable: entries.filter(isDiscardable).length,
    };
  }, [entries]);

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

  /** A file's letter in the group it is drawn in: a Staged row its staged change, an Unstaged
   * row what is left in the working tree, the single list the merged letter. */
  const groupLetter = (entry: GitEntry, group: ChangeGroup) => {
    if (group === "staged") return entry.index;
    if (group === "unstaged") return entry.untracked ? "U" : entry.worktree;
    return statusLetter(entry);
  };

  const stageOne = (entry: GitEntry) => {
    if (!activeRepo) return;
    if (
      entry.conflict &&
      !window.confirm("Stage this file as resolved? Review and remove conflict markers first.")
    )
      return;
    void guarded("stage", () => activeRepo.store.repository.stage(entry.path));
  };
  const unstageOne = (entry: GitEntry) => {
    if (!activeRepo) return;
    void guarded("unstage", () => activeRepo.store.repository.unstage(entry.path));
  };

  /** Adds an untracked file to the repository's `.gitignore` (created if missing), through the
   * same write path as Discard, so it is undoable and never overwrites a changed file. */
  const ignoreFile = async (entry: GitEntry) => {
    if (!activeRepo) return;
    const file = `${activeRepo.root.replace(/\/+$/, "")}/.gitignore`;
    const line = gitignoreLine(relativePath(entry.path));
    try {
      let before: string | null = null;
      try {
        before = await native("read_file_content", { path: file });
      } catch {
        before = null;
      }
      if (before === null) {
        await native("create_file_with_content", { path: file, content: withIgnored("", line) });
      } else {
        const outcome = await apply([{ path: file, before, after: withIgnored(before, line) }]);
        if (outcome.errors.length) throw new Error(outcome.errors.join(" "));
      }
      await callbacks.current.onChanged();
      await activeRepo.store.refresh(["entries"], { silent: true });
      activeRepo.store.setNotice(`Added ${line} to .gitignore.`);
    } catch (error) {
      activeRepo.store.setNotice(String(error));
    }
  };

  const copy = (text: string) =>
    void navigator.clipboard
      .writeText(text)
      .catch(() => activeRepo?.store.setNotice("The clipboard is not available."));

  const [rowMenu, setRowMenu] = useState<{
    x: number;
    y: number;
    entry: GitEntry;
    group: ChangeGroup;
  } | null>(null);

  /** Arrow keys move between the rows of the changes list, as in the Explorer. */
  const moveFocus = (from: HTMLElement, delta: 1 | -1) => {
    const list = from.closest("[data-changes-list]");
    if (!list) return;
    const rows = [...list.querySelectorAll<HTMLElement>("[data-change-row]")];
    const next = rows[rows.indexOf(from) + delta];
    next?.focus();
  };

  /** One changed file, in the group it is drawn in -- shared by the grouped lists, the single
   * list and the tree view (`depth` only indents it). */
  const renderFileRow = (entry: GitEntry, depth: number, group: ChangeGroup) => {
    const relative = relativePath(entry.path);
    const parts = relative.split(/[/\\]/);
    const fileName = parts.pop() || relative;
    const dirPath = changesViewAsTree ? "" : parts.join("/"); // the tree already shows the folder
    const letter = groupLetter(entry, group);
    const color = letterColor[letter] ?? "text-ink-2";
    const staged = hasStagedPart(entry);
    const partial = staged && hasUnstagedPart(entry);
    // In a group the checkbox is the group's own direction; in the single list it says how much
    // of the file is staged.
    const checked = group === "staged" || (group === "all" && staged && !partial);
    const mixed = group === "all" && partial;
    const stagedDiff = opensStagedDiff(entry, group);
    const isActiveDiff = activeDiffPath === entry.path;
    const toggle = () =>
      group === "staged"
        ? unstageOne(entry)
        : group === "all"
          ? toggleStage(entry)
          : stageOne(entry);
    const canDiscard = group !== "staged" && isDiscardable(entry);

    return (
      <div
        key={`${group}:${entry.path}`}
        role="button"
        tabIndex={0}
        data-change-row
        aria-label={
          group === "staged" ? `Open staged diff for ${entry.path}` : `Open diff for ${entry.path}`
        }
        style={{ paddingLeft: `${10 + depth * 14}px` }}
        className={`group/row flex h-[22px] cursor-pointer items-center gap-1.5 pr-2 outline-none transition-colors hover:bg-surface-hover focus-visible:bg-surface-hover focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent/60 ${
          isActiveDiff ? "bg-accent/15" : ""
        }`}
        onClick={() => void showDiff(entry, stagedDiff)}
        onContextMenu={(event) => {
          event.preventDefault();
          setRowMenu({ x: event.clientX, y: event.clientY, entry, group });
        }}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return;
          if (event.key === "Enter") {
            event.preventDefault();
            void showDiff(entry, stagedDiff);
          } else if (event.key === " ") {
            event.preventDefault();
            if (!busy && !loading) toggle();
          } else if (event.key === "Delete" && canDiscard) {
            event.preventDefault();
            void discard(entry);
          } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            moveFocus(event.currentTarget, event.key === "ArrowDown" ? 1 : -1);
          } else if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
            event.preventDefault();
            const box = event.currentTarget.getBoundingClientRect();
            setRowMenu({ x: box.left + 24, y: box.bottom, entry, group });
          }
        }}
      >
        <button
          role="checkbox"
          aria-checked={checked ? true : mixed ? "mixed" : false}
          aria-label={group === "staged" ? `Unstage ${entry.path}` : `Stage ${entry.path}`}
          title={checked ? `Unstage ${fileName}` : `Stage ${fileName}`}
          tabIndex={-1}
          disabled={busy || loading}
          onClick={(event) => {
            event.stopPropagation();
            toggle();
          }}
          className={`flex size-3.5 shrink-0 items-center justify-center rounded-[3px] border transition-colors disabled:opacity-40 ${
            checked || mixed
              ? "border-accent bg-accent text-white"
              : "border-border-strong text-transparent hover:border-ink-3"
          }`}
        >
          {checked ? <CheckIcon size={10} /> : mixed ? <MinusIcon size={10} /> : null}
        </button>

        <FileIcon name={fileName} isDir={false} className="size-3.5 shrink-0" />

        <div className="flex min-w-0 flex-1 items-baseline truncate">
          <span
            className={`truncate text-xs ${
              letter === "D"
                ? "text-ink-3 line-through"
                : entry.conflict
                  ? "text-yellow"
                  : "text-ink"
            }`}
            title={entry.originalPath ? `${entry.originalPath} → ${entry.path}` : entry.path}
          >
            {fileName}
          </span>
          {dirPath && <span className="ml-1.5 truncate text-[10.5px] text-ink-3">{dirPath}</span>}
        </div>

        <div
          className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover/row:opacity-100"
          onClick={(event) => event.stopPropagation()}
        >
          <button
            disabled={busy}
            title="Open Diff"
            aria-label="Open Diff"
            tabIndex={-1}
            onClick={() => void showDiff(entry, stagedDiff)}
            className="rounded p-0.5 text-ink-3 transition-colors hover:bg-border-strong hover:text-ink"
          >
            <DiffIcon size={12} />
          </button>
          {onOpenFile && letter !== "D" && (
            <button
              title="Open File"
              aria-label={`Open file ${entry.path}`}
              tabIndex={-1}
              onClick={() => onOpenFile(entry.path)}
              className="rounded p-0.5 text-ink-3 transition-colors hover:bg-border-strong hover:text-ink"
            >
              <FileIcon name={fileName} isDir={false} className="size-3 grayscale" />
            </button>
          )}
          {group === "all" && partial && (
            <button
              disabled={busy}
              title="Open staged changes"
              aria-label={`Open staged diff for ${entry.path}`}
              tabIndex={-1}
              onClick={() => void showDiff(entry, true)}
              className="rounded p-0.5 text-ink-3 transition-colors hover:bg-border-strong hover:text-ink"
            >
              <CheckIcon size={12} />
            </button>
          )}
          {canDiscard && entry.worktree === "M" && (
            <button
              disabled={busy || loading}
              aria-label={`Discard ${entry.path}`}
              title={`Discard changes in ${fileName}`}
              tabIndex={-1}
              onClick={() => void discard(entry)}
              className="rounded p-0.5 text-ink-3 transition-colors hover:bg-red/15 hover:text-red"
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
                tabIndex={-1}
                onClick={() => void acceptConflictSide(entry, "ours")}
                className="rounded px-1 text-[10px] text-ink-3 hover:bg-border-strong hover:text-ink"
              >
                Ours
              </button>
              <button
                disabled={busy || loading}
                aria-label={`Accept incoming change for ${entry.path}`}
                title={`Resolve ${fileName} by taking the incoming version`}
                tabIndex={-1}
                onClick={() => void acceptConflictSide(entry, "theirs")}
                className="rounded px-1 text-[10px] text-ink-3 hover:bg-border-strong hover:text-ink"
              >
                Theirs
              </button>
            </>
          )}
        </div>

        <span
          title={`Status: ${letter}`}
          className={`w-3 shrink-0 text-center font-mono text-[11px] font-semibold ${color}`}
        >
          {letter}
        </span>
      </div>
    );
  };

  /** The rows of one list, as a tree or flat, capped at `ROWS_PER_PAGE` with "Show more". */
  const renderRows = (list: readonly GitEntry[], group: ChangeGroup) => {
    const limit = rowLimits[group] ?? ROWS_PER_PAGE;
    // Folders fold per group: the same folder can be open under Unstaged and closed under Staged.
    const prefix = `${group}:`;
    const collapsedHere = new Set(
      [...collapsedFolders]
        .filter((key) => key.startsWith(prefix))
        .map((key) => key.slice(prefix.length)),
    );
    const rows = changesViewAsTree
      ? flattenVisible(
          buildFileTree(list, (entry) => relativePath(entry.path), { preserveFileOrder: true }),
          collapsedHere,
        )
      : null;
    const total = rows ? rows.length : list.length;
    const drawn = rows
      ? rows
          .slice(0, limit)
          .map((row) =>
            row.node.kind === "folder"
              ? renderFolderRow(row.node, row.depth, row.expanded, group)
              : renderFileRow(row.node.item, row.depth, group),
          )
      : list.slice(0, limit).map((entry) => renderFileRow(entry, 0, group));
    return (
      <>
        {drawn}
        {total > limit && (
          <button
            onClick={() =>
              setRowLimits((prev) => ({
                ...prev,
                [group]: (prev[group] ?? ROWS_PER_PAGE) + ROWS_PER_PAGE,
              }))
            }
            className="w-full py-1.5 text-[11px] text-ink-2 hover:bg-surface-hover hover:text-ink"
          >
            Show {Math.min(ROWS_PER_PAGE, total - limit)} more of {total - limit} remaining
          </button>
        )}
      </>
    );
  };

  /** A folder of the tree view, with actions on every file below it in this group. */
  const renderFolderRow = (
    node: TreeFolder<GitEntry>,
    depth: number,
    expanded: boolean,
    group: ChangeGroup,
  ) => {
    const files = collectFiles([node]);
    const discardableHere = group === "staged" ? [] : files.filter(isDiscardable);
    const key = `${group}:${node.path}`;
    return (
      <div
        key={`folder:${key}`}
        role="button"
        tabIndex={0}
        data-change-row
        aria-expanded={expanded}
        aria-label={`${expanded ? "Collapse" : "Expand"} ${node.name}`}
        style={{ paddingLeft: `${10 + depth * 14}px` }}
        className="group/row flex h-[22px] cursor-pointer items-center gap-1.5 pr-2 text-ink-2 outline-none transition-colors hover:bg-surface-hover focus-visible:bg-surface-hover focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent/60"
        onClick={() => toggleFolder(key)}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return;
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            toggleFolder(key);
          } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            moveFocus(event.currentTarget, event.key === "ArrowDown" ? 1 : -1);
          }
        }}
      >
        <ChevronIcon isExpanded={expanded} className="size-3 shrink-0" />
        <FileIcon name={node.name} isDir className="size-3.5 shrink-0" />
        <span className="truncate text-xs">{node.name}</span>
        {/* Folder-level actions act on every file below the folder, collapsed ones included --
            the same bulk handlers the group header uses, so the behaviour cannot drift. */}
        <div className="ml-auto flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover/row:opacity-100">
          {group !== "staged" && (
            <IconAction
              label={`Stage folder ${node.name}`}
              title={`Stage ${files.length} file${files.length === 1 ? "" : "s"} in ${node.name}`}
              disabled={busy}
              onClick={() => void stageAll(files)}
            >
              <PlusIcon size={11} />
            </IconAction>
          )}
          {group !== "unstaged" && (
            <IconAction
              label={`Unstage folder ${node.name}`}
              title={`Unstage ${files.length} file${files.length === 1 ? "" : "s"} in ${node.name}`}
              disabled={busy}
              onClick={() => void unstageAll(files)}
            >
              <MinusIcon size={11} />
            </IconAction>
          )}
          {group !== "staged" && (
            <IconAction
              label={`Discard folder ${node.name}`}
              title={
                discardableHere.length
                  ? `Discard changes in ${discardableHere.length} file${discardableHere.length === 1 ? "" : "s"} in ${node.name}`
                  : `Nothing in ${node.name} can be discarded`
              }
              danger
              disabled={busy || discardableHere.length === 0}
              onClick={() => void discardAll(discardableHere)}
            >
              <UndoIcon size={11} />
            </IconAction>
          )}
        </div>
      </div>
    );
  };

  /** One group of the grouped view: its header (fold, count, bulk actions) and its rows. */
  const renderGroup = (
    group: Exclude<ChangeGroup, "all">,
    title: string,
    list: readonly GitEntry[],
    actions: ReactNode,
  ) => {
    if (list.length === 0) return null;
    const collapsed = collapsedGroups.has(group);
    return (
      <div key={group} role="group" aria-label={`${title} group`}>
        <div className="group/grp flex h-6 items-center gap-1 bg-panel pl-1.5 pr-1">
          <button
            aria-expanded={!collapsed}
            onClick={() =>
              setCollapsedGroups((prev) => {
                const next = new Set(prev);
                if (next.has(group)) next.delete(group);
                else next.add(group);
                return next;
              })
            }
            className="flex min-w-0 flex-1 items-center gap-1 self-stretch text-left"
          >
            <ChevronIcon isExpanded={!collapsed} className="size-3 shrink-0 text-ink-3" />
            <span
              className={`truncate text-[11.5px] font-medium ${group === "conflicts" ? "text-yellow" : "text-ink"}`}
            >
              {title}
            </span>
            <span className="shrink-0 rounded-full bg-border-strong px-1.5 font-mono text-[10px] leading-4 text-ink-2">
              {list.length}
            </span>
          </button>
          <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover/grp:opacity-100">
            {actions}
          </div>
        </div>
        {!collapsed && renderRows(list, group)}
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
        {activeRepo && !unusable && snapshot && (
          <BranchBar
            entry={activeRepo}
            branch={branch}
            branches={branches}
            remotes={remotes}
            dirty={dirty}
            busy={busy || loading}
            open={branchesOpen}
            onToggle={setBranchesOpen}
            guarded={guarded}
            onDeleteBranch={(name) => void deleteBranch(name)}
          />
        )}

        {sectionVisible.changes && (
          <section aria-label="Changes panel" className="flex min-h-0 flex-1 flex-col text-xs">
            <SectionHeader
              title="Changes"
              count={entries.length}
              countLabel={`${entries.length} changed files`}
              collapsed={sectionCollapsed.changes}
              onToggle={() => toggleCollapsed("changes")}
              badges={
                <>
                  {branch.detached && (
                    <span
                      title="HEAD is not on a branch. Commits made now belong to no branch until you switch to or create one."
                      className="shrink-0 rounded bg-yellow/15 px-1.5 text-[10px] normal-case leading-4 tracking-normal text-yellow"
                    >
                      Detached HEAD
                    </span>
                  )}
                  {stale && (
                    <span
                      title="The last refresh failed, so this shows the last state Git reported. It updates after the next successful refresh."
                      className="shrink-0 rounded bg-yellow/15 px-1.5 text-[10px] normal-case leading-4 tracking-normal text-yellow"
                    >
                      Out of date
                    </span>
                  )}
                </>
              }
              actions={
                activeRepo && !unusable ? (
                  <>
                    <IconAction
                      label={grouped ? "Show as One List" : "Group by Staged"}
                      title={
                        grouped
                          ? "Show every file once, with a checkbox for its staging"
                          : "Group into Staged, Unstaged and Conflicts"
                      }
                      active={grouped}
                      onClick={() => setGrouped((value) => !value)}
                    >
                      <GroupIcon />
                    </IconAction>
                    <IconAction
                      label={changesViewAsTree ? "View as List" : "View as Tree"}
                      onClick={() => setChangesViewAsTree((value) => !value)}
                    >
                      {changesViewAsTree ? <ListIcon /> : <TreeIcon />}
                    </IconAction>
                    <IconAction
                      label="Refresh Status"
                      disabled={busy || loading}
                      onClick={() => void activeRepo.store.refresh()}
                    >
                      <RefreshIcon size={13} className={loading || busy ? "animate-spin" : ""} />
                    </IconAction>
                    <GitMenu
                      icon={<MoreIcon size={14} />}
                      label="Changes actions"
                      buttonClassName="rounded p-1 text-ink-3 hover:bg-border-strong hover:text-ink"
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
                  </>
                ) : undefined
              }
            />

            {!sectionCollapsed.changes && (
              <div className="max-h-[60%] shrink-0 space-y-2.5 overflow-y-auto px-2.5 pb-2.5 pt-1">
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
                      <p className="text-[11px] text-ink-3">Choose a repository:</p>
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
                    <p className="text-[11px] text-ink-3">
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
                        className="space-y-1.5 rounded border border-yellow/30 bg-yellow/10 p-2"
                      >
                        <p className="flex items-center gap-1.5 text-[11px] font-medium text-yellow">
                          <AlertCircleIcon size={13} />
                          {OPERATION_LABEL[operationInProgress]} in progress
                        </p>
                        <p className="text-[11px] text-ink-2">
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
                            className="flex-1 rounded bg-surface-hover py-1 text-[11px] text-ink transition-colors hover:bg-border-strong disabled:opacity-40"
                          >
                            Abort
                          </button>
                          {/* Merge has no commit sequence to advance past -- Git itself has no
                              `merge --skip`, so this is only offered for the three operations
                              that genuinely process one. */}
                          {operationInProgress !== "merge" && (
                            <button
                              disabled={busy || loading || dirty}
                              onClick={() =>
                                void guarded("skip", () => activeRepo.store.repository.skip())
                              }
                              className="flex-1 rounded bg-surface-hover py-1 text-[11px] text-ink transition-colors hover:bg-border-strong disabled:opacity-40"
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
                            className="flex-1 rounded bg-accent py-1 text-[11px] text-white transition-colors hover:bg-accent-hover disabled:opacity-40"
                          >
                            Continue
                          </button>
                        </div>
                      </div>
                    )}

                    <fieldset disabled={busy || loading} className="disabled:opacity-60">
                      <CommitComposer
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
                        onCommit={(message, options) =>
                          guarded("commit", () =>
                            // Nothing staged means "commit every tracked change", exactly as
                            // the dropdown's own Commit item does; an amend takes only what is
                            // staged (possibly nothing: a new message).
                            activeRepo.store.repository.commit(message, {
                              all: stagedCount === 0 && !options.amend,
                              amend: options.amend,
                              signoff: options.signoff,
                            }),
                          )
                        }
                      />
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
                    className={`flex-1 break-words text-[11px] leading-tight ${
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
                    className="flex w-full items-center justify-center gap-1.5 rounded bg-border-strong py-1 text-[11px] text-ink transition-colors hover:bg-surface-hover"
                  >
                    <UndoIcon size={12} />
                    <span>Undo last discard</span>
                  </button>
                )}
              </div>
            )}

            {!sectionCollapsed.changes && activeRepo && !unusable && (
              <>
                {(entries.length > FILTER_FROM || filter) && (
                  <div className="shrink-0 px-2.5 pb-1.5">
                    <input
                      aria-label="Filter changes"
                      placeholder={`Filter ${entries.length} changed files`}
                      value={filter}
                      onChange={(event) => setFilter(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Escape") setFilter("");
                      }}
                      className="w-full rounded border border-border-strong bg-surface px-2 py-1 text-xs text-ink placeholder:text-ink-3 focus:border-accent focus:outline-none"
                    />
                  </div>
                )}
                <div
                  role="list"
                  aria-label="Changed files"
                  data-changes-list
                  className="min-h-[44px] flex-1 overflow-y-auto pb-1"
                >
                  {entries.length === 0 && !loading && (
                    // One row tall, like a single file: a big centred empty state made everything
                    // below it (the Graph) jump ~100 px the moment the last file was committed.
                    <p className="flex h-[22px] items-center gap-1.5 px-3 text-[11px] text-ink-3">
                      <CheckIcon size={12} className="shrink-0" />
                      Working tree clean
                    </p>
                  )}
                  {entries.length > 0 && groups.all.length === 0 && (
                    <p className="flex h-[22px] items-center px-3 text-[11px] text-ink-3">
                      No changed file matches “{filter}”.
                    </p>
                  )}
                  {grouped ? (
                    <>
                      {renderGroup("conflicts", "Conflicts", groups.conflicts, null)}
                      {renderGroup(
                        "staged",
                        "Staged",
                        groups.staged,
                        <IconAction
                          label="Unstage All Changes"
                          disabled={busy || loading}
                          onClick={() => void unstageAll(groups.staged)}
                        >
                          <MinusIcon size={12} />
                        </IconAction>,
                      )}
                      {renderGroup(
                        "unstaged",
                        "Unstaged",
                        groups.unstaged,
                        <>
                          <IconAction
                            label="Discard All Changes"
                            title={
                              discardable === 0
                                ? "Nothing to discard: Discard All restores modified tracked files only"
                                : `Discard changes in ${discardable} modified file${discardable === 1 ? "" : "s"}. Untracked, deleted, staged-only and conflicted files are not affected.`
                            }
                            danger
                            disabled={busy || loading || discardable === 0}
                            onClick={() => void discardAll(entries)}
                          >
                            <UndoIcon size={12} />
                          </IconAction>
                          <IconAction
                            label="Stage All Changes"
                            disabled={busy || loading}
                            onClick={() => void stageAll(groups.unstaged)}
                          >
                            <PlusIcon size={12} />
                          </IconAction>
                        </>,
                      )}
                    </>
                  ) : (
                    <>
                      {entries.length > 0 && (
                        <div className="flex h-6 items-center justify-end gap-0.5 px-1">
                          <IconAction
                            label="Discard All Changes"
                            title={
                              discardable === 0
                                ? "Nothing to discard: Discard All restores modified tracked files only"
                                : `Discard changes in ${discardable} modified file${discardable === 1 ? "" : "s"}. Untracked, deleted, staged-only and conflicted files are not affected.`
                            }
                            danger
                            disabled={busy || loading || discardable === 0}
                            onClick={() => void discardAll(entries)}
                          >
                            <UndoIcon size={12} />
                          </IconAction>
                          {allStaged ? (
                            <IconAction
                              label="Unstage All Changes"
                              disabled={busy || loading}
                              onClick={() => void unstageAll(entries.filter(hasStagedPart))}
                            >
                              <MinusIcon size={12} />
                            </IconAction>
                          ) : (
                            <IconAction
                              label="Stage All Changes"
                              disabled={busy || loading}
                              onClick={() =>
                                void stageAll(
                                  entries.filter((e) => !e.conflict && hasUnstagedPart(e)),
                                )
                              }
                            >
                              <PlusIcon size={12} />
                            </IconAction>
                          )}
                        </div>
                      )}
                      {renderRows(groups.all, "all")}
                    </>
                  )}
                </div>
                {rowMenu && (
                  <ContextMenu
                    x={rowMenu.x}
                    y={rowMenu.y}
                    label="File actions"
                    onClose={() => setRowMenu(null)}
                    onError={(error) => activeRepo.store.setNotice(String(error))}
                    items={buildChangeMenu(
                      rowMenu.entry,
                      rowMenu.group,
                      {
                        openChanges: (staged) => void showDiff(rowMenu.entry, staged),
                        openFile: onOpenFile ? () => onOpenFile(rowMenu.entry.path) : undefined,
                        stage: () => stageOne(rowMenu.entry),
                        unstage: () => unstageOne(rowMenu.entry),
                        discard: () => void discard(rowMenu.entry),
                        acceptSide: (side) => void acceptConflictSide(rowMenu.entry, side),
                        ignore: () => void ignoreFile(rowMenu.entry),
                        reveal: onReveal ? () => onReveal(rowMenu.entry.path) : undefined,
                        copyPath: () => copy(rowMenu.entry.path),
                        copyRelativePath: () => copy(relativePath(rowMenu.entry.path)),
                      },
                      busy || loading,
                    )}
                  />
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
            onDialog={onDialog}
          />
        )}

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
      </div>
    </aside>
  );
}
