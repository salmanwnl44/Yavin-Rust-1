/**
 * What the native Local Git commands answer (`src-tauri/src/localgit.rs`). Ids are 64-hex
 * SHA-256 object ids; the renderer never sees where a store is on disk.
 */

export interface LocalGitHead {
  /** HEAD on a ref (possibly unborn): `refs/heads/main`. */
  symbolic: string | null;
  /** HEAD straight on a commit. */
  detached: string | null;
}

/** Something found in the store that needs to be known, and never resolved by guessing. */
export type LocalGitFinding =
  | {
      kind: "interruptedRefUpdate";
      revision: number;
      updates: { name: string; old: string | null; new: string | null }[];
    }
  | { kind: "tornReflog"; quarantined: string | null }
  | { kind: "reflogBehind"; refs: number; reflog: number }
  | { kind: "unreadableSegment"; segment: string; reason: string; quarantined: string | null }
  | { kind: "danglingRef"; name: string; id: string }
  | { kind: "corruptObject"; id: string; detail: string }
  | { kind: "missingObject"; id: string; from: string }
  | { kind: "staleTempsRemoved"; count: number };

export interface LocalGitInfo {
  /** Valid until the workspace is left or the service closes. */
  handle: string;
  /** `ws-…`: how commits name the workspace. */
  workspace: string;
  /** `readOnly` while another Yavin window writes this workspace's history. */
  mode: "writer" | "readOnly";
  readOnlyReason: "heldByOtherProcess" | "requested" | null;
  format: number;
  revision: number;
  head: LocalGitHead;
  headCommit: string | null;
  refCount: number;
  objectCount: number;
  segmentCount: number;
  storageBytes: number;
  folders: { folderId: string; path: string }[];
  findings: LocalGitFinding[];
}

export interface LocalGitRefs {
  revision: number;
  head: LocalGitHead;
  refs: Record<string, string>;
}

export type LocalGitReflogRecord =
  | {
      kind: "update";
      revision: number;
      name: string;
      old: string | null;
      new: string | null;
      ms: number;
      op: string;
      reason: string;
    }
  | { kind: "aborted"; revision: number; ms: number };

export type LocalGitSource = "human" | "ai" | "agent" | "automatic" | "recovery" | "checkpoint";

export interface LocalGitCommit {
  id: string;
  root: string;
  diskRoot: string | null;
  parents: string[];
  workspace: string;
  authorName: string;
  authorId: string;
  timeMs: number;
  tzOffsetMin: number;
  source: LocalGitSource;
  meta: Record<string, string>;
  metaObjects: Record<string, string>;
  message: string;
}

export interface LocalGitTreeEntry {
  name: string;
  kind: "file" | "directory" | "symlink";
  executable: boolean;
  link: "file" | "directory" | "junction" | null;
  id: string;
  /** False for a file hashed but not stored (over the size limit): its content is unavailable. */
  stored: boolean;
  size: number | null;
}

export interface LocalGitBlobInfo {
  size: number;
  binary: boolean;
}

// --- Snapshots and status (LG-02) ----------------------------------------------------------

/** How a snapshot scans: `auto` (incremental when safe), `full`, or `verify` (hash everything). */
export type LocalGitSnapshotMode = "auto" | "full" | "verify";

/** Something a snapshot could not record as it is. Always reported, never silent. */
export type LocalGitProblem =
  | { kind: "unstable"; folderId: string; path: string; carriedForward: boolean }
  | { kind: "unreadable"; folderId: string; path: string; detail: string; carriedForward: boolean }
  | { kind: "unrepresentable"; folderId: string; path: string; detail: string }
  | { kind: "unsupported"; folderId: string; path: string; what: string }
  | { kind: "invalidIgnorePattern"; folderId: string; path: string; line: number; detail: string }
  | { kind: "overlayRefused"; path: string; reason: string };

export interface LocalGitOverlayRecord {
  folderId: string;
  path: string;
  blob: string;
  size: number;
  encoding: string;
  lineEnding: string;
  version: number;
}

export interface LocalGitUntitledRecord {
  id: string;
  blob: string;
  size: number;
  encoding: string;
  lineEnding: string;
  version: number;
}

export interface LocalGitSnapshot {
  sequence: number;
  mode: "full" | "incremental" | "verify";
  fullReason:
    | "firstScan"
    | "watcherUnavailable"
    | "watcherChanged"
    | "periodic"
    | "ignoreRulesChanged"
    | "persisted"
    | "requested"
    | null;
  takenMs: number;
  durationMs: number;
  workspace: string;
  watcherGeneration: number | null;
  /** What is on disk. */
  diskRoot: string;
  /** What is on disk with the unsaved documents applied. */
  effectiveRoot: string;
  folders: { folderId: string; diskTree: string; effectiveTree: string }[];
  overlays: LocalGitOverlayRecord[];
  untitled: LocalGitUntitledRecord[];
  overlaySet: string | null;
  problems: LocalGitProblem[];
  stats: {
    files: number;
    directories: number;
    reusedDirectories: number;
    filesHashed: number;
    bytesHashed: number;
    cacheHits: number;
  };
  persisted: boolean;
}

export type LocalGitChangeKind = "added" | "modified" | "deleted" | "typeChanged" | "renamed";

export interface LocalGitSide {
  class: "file" | "directory" | "symlink";
  id: string;
  executable: boolean;
  /** False for a file over the storage limit: hashed, content not stored. */
  stored: boolean;
  size: number | null;
  link: "file" | "directory" | "junction" | null;
}

export interface LocalGitChange {
  kind: LocalGitChangeKind;
  /** For a rename: where the content was. */
  from?: string;
  old: LocalGitSide | null;
  new: LocalGitSide | null;
}

export interface LocalGitStatusEntry {
  folderId: string;
  path: string;
  /** Local HEAD against the disk. */
  disk: LocalGitChange | null;
  /** Local HEAD against what the user has (disk plus unsaved documents). */
  effective: LocalGitChange | null;
  /** Local HEAD against the index: staged (LG-04). */
  staged: LocalGitChange | null;
  /** The index against the workspace, unsaved documents included: not staged. */
  unstaged: LocalGitChange | null;
  /** Set when the path has an unsaved document. */
  memory: {
    state: "differsFromDisk" | "equalsDisk" | "openDeletedOnDisk";
    equalsHead: boolean;
    version: number;
  } | null;
}

export interface LocalGitCounts {
  added: number;
  modified: number;
  deleted: number;
  typeChanged: number;
  renamed: number;
}

export interface LocalGitStatus {
  headCommit: string | null;
  headRoot: string | null;
  /** `head` when nothing is staged (the index is HEAD's tree), `staged` otherwise. */
  index: "head" | "staged";
  indexRoot: string | null;
  diskRoot: string;
  effectiveRoot: string;
  entries: LocalGitStatusEntry[];
  total: number;
  truncated: boolean;
  disk: LocalGitCounts;
  effective: LocalGitCounts;
  staged: LocalGitCounts;
  unstaged: LocalGitCounts;
  unsaved: number;
}

export interface LocalGitProgress {
  handle: string;
  jobId: string;
  phase: "scanning" | "overlays" | "writing";
  files: number;
  directories: number;
  bytesHashed: number;
  totalEstimate: number | null;
}

/** An unsaved named document as sent to the native pool (`text` is what saving would write). */
export interface LocalGitOverlayArg {
  key: string;
  path: string;
  text: string;
  encoding: string;
  lineEnding: string;
  version: number;
}

export interface LocalGitUntitledArg {
  id: string;
  text: string;
  encoding: string;
  lineEnding: string;
  version: number;
}

export interface LocalGitOverlayRef {
  key: string;
  version: number;
}

// --- Checkpoints, commits, history, diff and restore (LG-03) --------------------------------

/** Who makes a commit, and when (what the native side records). */
export interface LocalGitSignature {
  name: string;
  id: string;
  timeMs: number;
  /** Minutes east of UTC. */
  tzOffsetMin: number;
}

export interface LocalGitCommitInfo {
  id: string;
  shortId: string;
  message: string;
  summary: string;
  timeMs: number;
  tzOffsetMin: number;
  authorName: string;
  authorId: string;
  parents: string[];
  /** `human`, `checkpoint` or `recovery`. */
  source: string;
  root: string;
  diskRoot: string | null;
  overlays: string | null;
}

export interface LocalGitCreated {
  commit: LocalGitCommitInfo;
  revision: number;
}

/** Where HEAD is: on a branch, detached at a commit, or on a branch with no commit yet. */
export type LocalGitHeadState =
  | { kind: "branch"; name: string; refName: string; commit: string }
  | { kind: "detached"; commit: string }
  | { kind: "unborn"; name: string; refName: string };

export interface LocalGitHeadInfo {
  state: LocalGitHeadState;
  symbolic: string | null;
  unborn: boolean;
  commit: LocalGitCommitInfo | null;
  revision: number;
}

export interface LocalGitHistoryPage {
  /** Newest first. */
  items: LocalGitCommitInfo[];
  /** Pass as the cursor for the next page; null at the first commit. */
  next: string | null;
  /** Set when a commit on the way could not be read: the page ends before it. */
  broken: { id: string; code: string; message: string } | null;
}

export interface LocalGitCheckpointEntry {
  id: string;
  revision: number;
  ms: number;
  reason: string;
}

export interface LocalGitTreeItem {
  name: string;
  kind: "file" | "directory" | "symlink";
  id: string;
  executable: boolean;
  link: "file" | "directory" | "junction" | null;
  stored: boolean;
  size: number | null;
  entries: number | null;
}

export interface LocalGitDiffLine {
  kind: "context" | "addition" | "deletion";
  text: string;
  oldLine: number | null;
  newLine: number | null;
  noNewline: boolean;
}

export interface LocalGitHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: LocalGitDiffLine[];
}

export interface LocalGitDiffEntry {
  folderId: string;
  path: string;
  oldPath: string | null;
  kind: LocalGitChangeKind;
  old: LocalGitSide | null;
  new: LocalGitSide | null;
  contentAvailable: boolean;
  unavailable: "notStored" | "missing" | "changedOnDisk" | "notAFile" | null;
  binary: boolean;
  lineDiff: { hunks: LocalGitHunk[]; additions: number; deletions: number } | null;
  lineDiffSkipped:
    "binary" | "unavailable" | "tooLarge" | "budget" | "notRequested" | "notAFile" | null;
}

export interface LocalGitDiffEnd {
  kind: "commit" | "workspace" | "empty";
  commit: string | null;
  root: string | null;
}

export interface LocalGitDiff {
  from: LocalGitDiffEnd;
  to: LocalGitDiffEnd;
  identical: boolean;
  entries: LocalGitDiffEntry[];
  counts: LocalGitCounts;
}

export type LocalGitRestorePolicy = "refuseIfDirty" | "replaceDocument";

export interface LocalGitRestoreOp {
  kind:
    | "removeFile"
    | "removeLink"
    | "removeDirectory"
    | "createDirectory"
    | "writeFile"
    | "createLink";
  folderId: string;
  path: string;
  expected:
    | { kind: "absent" }
    | { kind: "file"; id: string; stored: boolean }
    | { kind: "directory" }
    | { kind: "link"; id: string };
  blob: string | null;
  size: number | null;
  executable: boolean;
  link: string | null;
}

export type LocalGitRestoreConflict =
  | { kind: "dirtyDocumentWouldBeOverwritten"; folderId: string; path: string }
  | { kind: "dirtyDocumentWouldBeDeleted"; folderId: string; path: string }
  | {
      kind: "historicalContentUnavailable";
      folderId: string;
      path: string;
      reason: "notStored" | "missing";
    }
  | { kind: "currentContentNotStored"; folderId: string; path: string }
  | { kind: "currentStateUnknown"; folderId: string; path: string; reason: string }
  | { kind: "pathBlocked"; folderId: string; path: string }
  | { kind: "caseOnlyRename"; folderId: string; path: string; onDisk: string }
  | { kind: "targetUnavailable"; folderId: string; path: string }
  | { kind: "wouldRemoveUntracked"; folderId: string; path: string; entry: string }
  | { kind: "stagedChangeConflict"; folderId: string; path: string }
  | { kind: "unstagedChangeWouldBeOverwritten"; folderId: string; path: string }
  | { kind: "diskChangedSinceSnapshot"; folderId: string; path: string }
  | { kind: "linkNotRestorable"; folderId: string; path: string; reason: string };

export interface LocalGitRestorePlan {
  commit: string;
  targetRoot: string;
  scope: string | null;
  scopeFolder: string | null;
  policy: LocalGitRestorePolicy;
  operations: LocalGitRestoreOp[];
  conflicts: LocalGitRestoreConflict[];
  /** Documents whose unsaved changes the window discards (policy `replaceDocument`). */
  documents: { folderId: string; path: string; action: "overwrite" | "delete"; version: number }[];
  unchanged: boolean;
  snapshotSequence: number;
  diskRoot: string;
}

export interface LocalGitRestoreResult {
  status: "planned" | "unchanged" | "refused" | "completed" | "failed" | "verificationFailed";
  plan: LocalGitRestorePlan;
  conflicts: LocalGitRestoreConflict[];
  /** The checkpoint of the workspace taken just before anything changed. */
  checkpoint: LocalGitCommitInfo | null;
  operation: number | null;
  applied: number;
  error: string | null;
  verification: {
    matches: boolean;
    mismatches: string[];
    diskRoot: string;
    snapshotSequence: number;
  } | null;
}

// --- The Local Index, branches, tags and switching (LG-04) ----------------------------------

export interface LocalGitIndexInfo {
  /** The commit the index ref names (HEAD's own when nothing is staged); null when empty. */
  commit: string | null;
  root: string | null;
  /** Nothing is staged. */
  equalsHead: boolean;
  revision: number;
}

export interface LocalGitStageResult {
  index: LocalGitIndexInfo;
  changed: string[];
  unchanged: string[];
  /** Files staged hashed but not stored (over the storage limit). */
  unstored: string[];
  snapshot: LocalGitSnapshot | null;
}

/** A path in one of the workspace's folders (`folderId` null: its only folder). */
export interface LocalGitPath {
  folderId?: string | null;
  path: string;
}

export interface LocalGitBranch {
  name: string;
  refName: string;
  commit: string;
  current: boolean;
  /** Whether HEAD's history contains it; null when that could not be decided cheaply. */
  merged: boolean | null;
  /** Always null: Local Git has no remotes. */
  upstream: null;
}

export interface LocalGitTag {
  name: string;
  refName: string;
  commit: string;
}

export interface LocalGitSwitchPlan {
  branch: string | null;
  commit: string;
  from: string | null;
  revision: number;
  sameCommit: boolean;
  restore: LocalGitRestorePlan;
}

export interface LocalGitSwitchResult {
  status: "planned" | "refused" | "completed" | "failed" | "verificationFailed";
  plan: LocalGitSwitchPlan;
  conflicts: LocalGitRestoreConflict[];
  operation: number | null;
  applied: number;
  error: string | null;
  verification: LocalGitRestoreResult["verification"];
  head: LocalGitHeadState;
}
