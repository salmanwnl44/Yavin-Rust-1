/**
 * How Local History presents what Local Git says (LG-08). Pure: no state, no decisions --
 * every fact here comes from the native side as it is, and this only labels it for the UI.
 * Nothing here computes history, diffs, attribution or safety; an unknown value is shown as
 * it is rather than guessed at.
 */
import type {
  LocalGitAiRefusal,
  LocalGitAiRun,
  LocalGitCommit,
  LocalGitCommitInfo,
  LocalGitDiffEntry,
  LocalGitRestoreConflict,
} from "./types.ts";
import { LocalGitClosedError, LocalGitError } from "./service.ts";

/** What a history entry is, from its source and parents as recorded. */
export type EntryKind = "commit" | "merge" | "ai" | "checkpoint" | "recovery" | "automatic";

export function entryKind(commit: Pick<LocalGitCommitInfo, "source" | "parents">): EntryKind {
  if (commit.source === "ai" || commit.source === "agent") return "ai";
  if (commit.source === "checkpoint") return "checkpoint";
  if (commit.source === "recovery") return "recovery";
  if (commit.source === "automatic") return "automatic";
  return commit.parents.length > 1 ? "merge" : "commit";
}

export const ENTRY_LABEL: Record<EntryKind, string> = {
  commit: "Commit",
  merge: "Merge",
  ai: "AI",
  checkpoint: "Checkpoint",
  recovery: "Recovery",
  automatic: "Automatic",
};

/** Provenance a commit's metadata records (only keys that are there). */
export interface Provenance {
  cherryPickedFrom: string | null;
  mergedFrom: string | null;
  agentRunId: string | null;
  taskId: string | null;
  changeSetId: string | null;
  changeSetRevision: string | null;
  checkpoint: string | null;
  validation: string | null;
  validationRef: string | null;
  model: string | null;
}

export function provenance(commit: Pick<LocalGitCommit, "meta">): Provenance {
  const meta = commit.meta ?? {};
  const get = (key: string) => (key in meta ? meta[key] : null);
  return {
    cherryPickedFrom: get("cherry-pick"),
    mergedFrom: get("merge"),
    agentRunId: get("ai.run"),
    taskId: get("ai.task"),
    changeSetId: get("ai.changeset"),
    changeSetRevision: get("ai.changeset-revision"),
    checkpoint: get("ai.checkpoint"),
    validation: get("ai.validation"),
    validationRef: get("ai.validation-ref"),
    model: get("ai.model"),
  };
}

export const CHANGE_LETTER: Record<LocalGitDiffEntry["kind"], string> = {
  added: "A",
  modified: "M",
  deleted: "D",
  typeChanged: "T",
  renamed: "R",
};

export const CHANGE_LABEL: Record<LocalGitDiffEntry["kind"], string> = {
  added: "Added",
  modified: "Modified",
  deleted: "Deleted",
  typeChanged: "Type changed",
  renamed: "Renamed",
};

/** Why a file's content cannot be shown, in words -- or null when it can. */
export function unavailableReason(entry: LocalGitDiffEntry): string | null {
  if (entry.binary) return "Binary file: no line diff is shown.";
  switch (entry.unavailable) {
    case "notStored":
      return "Historical content unavailable: the file was over Local Git's storage limit, so only its hash and size were recorded.";
    case "missing":
      return "Historical content unavailable: the Local Git store does not have this object (it may be damaged; verify the store).";
    case "changedOnDisk":
      return "The file changed on disk after the snapshot was taken; show the diff again.";
    case "notAFile":
      return "Not a file (a folder or a link): there is no text to compare.";
    default:
      break;
  }
  switch (entry.lineDiffSkipped) {
    case "tooLarge":
      return "Too large for a line diff.";
    case "budget":
      return "Not compared: the diff's size budget was reached before this file.";
    case "binary":
      return "Binary file: no line diff is shown.";
    case "unavailable":
      return "Historical content unavailable.";
    case "notAFile":
      return "Not a file: there is no text to compare.";
    default:
      return null;
  }
}

/**
 * One file's line diff from Local Git, as the unified text the existing diff view reads. Only
 * formatting: the hunks are Local Git's own.
 */
export function unifiedDiff(entry: LocalGitDiffEntry): string {
  const oldPath = entry.oldPath ?? entry.path;
  const lines = [
    `diff --local-git a/${oldPath} b/${entry.path}`,
    entry.old ? `--- a/${oldPath}` : "--- /dev/null",
    entry.new ? `+++ b/${entry.path}` : "+++ /dev/null",
  ];
  for (const hunk of entry.lineDiff?.hunks ?? []) {
    lines.push(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`);
    for (const line of hunk.lines) {
      const mark = line.kind === "addition" ? "+" : line.kind === "deletion" ? "-" : " ";
      lines.push(`${mark}${line.text}`);
      if (line.noNewline) lines.push("\\ No newline at end of file");
    }
  }
  return lines.join("\n");
}

const at = (c: { folderId?: string; path?: string }) => c.path ?? "";

/** A restore planner's or executor's refusal, in words. */
export function describeRestoreConflict(conflict: LocalGitRestoreConflict): string {
  const path = at(conflict as { path?: string });
  switch (conflict.kind) {
    case "dirtyDocumentWouldBeOverwritten":
      return `${path}: has unsaved changes that would be overwritten`;
    case "dirtyDocumentWouldBeDeleted":
      return `${path}: has unsaved changes and would be deleted`;
    case "historicalContentUnavailable":
      return `${path}: historical content unavailable (${conflict.reason === "notStored" ? "over the storage limit, never stored" : "missing from the store"})`;
    case "currentContentNotStored":
      return `${path}: a file over the storage limit would be replaced -- nothing could bring it back`;
    case "currentStateUnknown":
      return `${path}: could not be read (${conflict.reason})`;
    case "pathBlocked":
      return `${path}: blocked (a file or link is where a folder is needed)`;
    case "caseOnlyRename":
      return `${path}: differs only in letter case from ${conflict.onDisk}`;
    case "targetUnavailable":
      return `${path || "(folder)"}: not in the target`;
    case "wouldRemoveUntracked":
      return `${path}: holds ${conflict.entry}, which is never removed`;
    case "stagedChangeConflict":
      return `${path}: has staged changes`;
    case "unstagedChangeWouldBeOverwritten":
      return `${path}: has local changes that would be overwritten`;
    case "stashBaseChanged":
      return `${path}: changed since the stash was made`;
    case "untrackedFileCollision":
      return `${path}: an untracked file is in the way`;
    case "diskChangedSinceSnapshot":
      return `${path}: changed on disk since the plan was made`;
    case "linkNotRestorable":
      return `${path}: the link cannot be created (${conflict.reason})`;
    case "realGitChanged":
      return `${path}: real Git has ${conflict.staged ? "staged" : "unstaged"} changes here`;
    default:
      return `${path}: ${(conflict as { kind: string }).kind}`;
  }
}

/** Why an AI commit or undo was refused, in words. */
export function describeAiRefusal(refusal: LocalGitAiRefusal): string {
  switch (refusal.kind) {
    case "headMoved":
      return "HEAD moved since the AI checkpoint";
    case "staleChangeSet":
      return `The ChangeSet changed (recorded revision ${refusal.expected}, now ${refusal.found})`;
    case "operationInProgress":
      return "A merge or cherry-pick is in progress";
    case "nothingToCommit":
      return "The AI changed nothing to commit";
    case "nothingToUndo":
      return "The AI changed nothing to undo";
    case "humanChangedAiPath":
      return `${refusal.path}: changed by a person since the AI (it no longer holds the AI's content)`;
    case "preexistingHumanChange":
      return `${refusal.path}: already had a person's change before the AI ran`;
    case "stagedOnAiPath":
      return `${refusal.path}: has staged changes`;
    case "undoConflict":
      return `${refusal.path}: a person's later edit overlaps the AI's change`;
    case "dirtyDocument":
      return `${refusal.path}: has unsaved changes`;
    case "historyMovedOn":
      return "The AI commit is no longer HEAD: history moved on (revert it instead)";
    default:
      return (refusal as { kind: string }).kind;
  }
}

/** A failed call's code, in words; the native message is kept for the details. */
export function describeError(error: unknown): { title: string; detail: string } {
  if (error instanceof LocalGitClosedError)
    return { title: "This workspace's Local History is closed.", detail: "" };
  if (!(error instanceof LocalGitError))
    return { title: "Local History failed.", detail: String(error) };
  const titles: Record<string, string> = {
    Busy: "Another Local Git operation is running; try again when it ends.",
    ReadOnly: "Another Yavin window is writing this Local History; it is read-only here.",
    NotInWorkspace: "The workspace changed before this could run.",
    HandleClosed: "The workspace changed; this result was dropped.",
    OperationInProgress: "A merge or cherry-pick is in progress: continue or abort it first.",
    RecoveryRequired: "Local History needs recovery before this can run.",
    CorruptObject: "Local History is damaged: an object failed its check.",
    CorruptSegment: "Local History is damaged: a storage file failed its check.",
    MissingObject: "Local History is missing an object.",
    NotFound: "Not found.",
    InvalidObjectId: "Not a valid commit.",
    InvalidName: "Not a valid name.",
    ContentUnavailable: "Historical content unavailable.",
    StaleRevision: "Local History changed meanwhile; refresh and try again.",
    RefConflict: "Local History changed meanwhile; refresh and try again.",
    AiRunState: "The AI run is not in a state that allows this.",
    Unborn: "There is no commit yet.",
    NothingToCommit: "There is nothing to commit.",
    Cancelled: "Cancelled.",
  };
  return { title: titles[error.code] ?? `Local History: ${error.code}`, detail: error.message };
}

/** An AI run's status, as the record says it -- an interrupted run is never shown as done. */
export function aiStatusLabel(run: Pick<LocalGitAiRun, "status" | "interrupted">): string {
  if (run.interrupted) return "Interrupted";
  const labels: Record<LocalGitAiRun["status"], string> = {
    checkpointed: "Checkpointed",
    running: "Running",
    changesDetected: "Changes detected",
    validated: "Validated",
    committed: "Committed",
    cancelled: "Cancelled",
    failed: "Failed",
    undone: "Undone",
  };
  return labels[run.status] ?? run.status;
}

export function relativeTime(ms: number, now: number = Date.now()): string {
  const seconds = Math.round((now - ms) / 1000);
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} d ago`;
  return new Date(ms).toLocaleDateString();
}
