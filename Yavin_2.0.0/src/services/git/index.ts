export type { GitOperation, RepoInfo } from "./backend.ts";
export { openRepo, closeRepo, gitExec, repoState } from "./backend.ts";

export type { GitEntry, Decorations } from "./parsers/status.ts";
export { parseGitEntries, buildDecorations, sameDecorations } from "./parsers/status.ts";
export { bumpGitRevision, useGitRevision } from "./revision.ts";

export type { Branch } from "./parsers/branch.ts";
export { parseBranch, divergence } from "./parsers/branch.ts";

export { describeGitError } from "./parsers/errors.ts";

export type {
  CommitFileChange,
  CommitDetailedInfo,
  RawCommit,
  RefLabel,
  RefKind,
} from "./parsers/log.ts";
export { parseCommitDetails, parseGraphLog, parseRefLabels } from "./parsers/log.ts";

export { Repository } from "./repository.ts";

export type { DiffHunk, ParsedDiff } from "./diffHunks.ts";
export { parseUnifiedDiff, buildPatch } from "./diffHunks.ts";

export type { RepoSnapshot } from "./store.ts";
export { RepoStore, DIRTY_BLOCKED } from "./store.ts";

export type { RepoEntry } from "./registry.ts";
export { gitRegistry } from "./registry.ts";

export { guardedAffecting, SIBLING_INVALIDATES, GRAPH_RESETS } from "./sync.ts";

export {
  useGitRegistry,
  useActiveRepo,
  useRepoSnapshot,
  useTotalChanges,
  useCommitGraph,
} from "./hooks.ts";

export type { GraphNode, GraphEdge, GraphLayout } from "./graph/model.ts";
export { buildCommitGraph, GRAPH_COLOR_COUNT } from "./graph/model.ts";

export type { GraphSnapshot } from "./graph/incremental.ts";
export { GraphLoader, GRAPH_PAGE_SIZE } from "./graph/incremental.ts";
