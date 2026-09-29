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
  /** `head` until staging exists (LG-04). */
  index: "head";
  diskRoot: string;
  effectiveRoot: string;
  entries: LocalGitStatusEntry[];
  total: number;
  truncated: boolean;
  disk: LocalGitCounts;
  effective: LocalGitCounts;
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
