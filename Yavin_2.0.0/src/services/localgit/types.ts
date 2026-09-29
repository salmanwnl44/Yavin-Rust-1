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
