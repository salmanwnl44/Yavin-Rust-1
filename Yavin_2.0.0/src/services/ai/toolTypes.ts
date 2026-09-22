import type { RepoEntry } from "../git/registry.ts";
import type { GitErrorCategory } from "../git/parsers/errors.ts";

/** Names a worktree explicitly -- never "whichever one is active". */
export interface WorktreeRef {
  repoId: string;
}

export type FailureCategory = GitErrorCategory | "not-found" | "precondition" | "invalid-argument";

export type ToolFailure = { ok: false; message: string; category: FailureCategory };
export type ToolResult<T> = { ok: true; data: T } | ToolFailure;

export type ToolTier = "read" | "reversible" | "confirm";

/** The minimal registry surface the tool layer needs, injectable for tests. */
export interface WorktreeRegistry {
  getSnapshot(): { repos: RepoEntry[] };
}

export function fail(category: FailureCategory, message: string): ToolFailure {
  return { ok: false, message, category };
}

export function isFailure(value: unknown): value is ToolFailure {
  return typeof value === "object" && value !== null && (value as { ok?: unknown }).ok === false;
}

export function resolveWorktree(
  registry: WorktreeRegistry,
  ref: WorktreeRef,
): RepoEntry | ToolFailure {
  const entry = registry.getSnapshot().repos.find((r) => r.repoId === ref.repoId);
  return entry ?? fail("not-found", `No open worktree with repoId "${ref.repoId}".`);
}

/**
 * Resolves a caller-supplied path (repo-relative, or already absolute under `root`)
 * to the absolute form `Repository` methods take, refusing anything that could
 * leave the worktree.
 */
export function resolveInRoot(root: string, path: string): string | null {
  const normalizedRoot = root.replace(/\\/g, "/").replace(/\/$/, "");
  const p = path.replace(/\\/g, "/");
  // Case-insensitively, matching `relativeToRoot` in `repository.ts`. A case-sensitive
  // comparison meant an absolute path whose drive letter merely differed in case
  // (`c:/work/a.ts` against a root of `C:/work`, routine on Windows) failed the
  // already-inside-the-root test and was treated as relative, producing the nonsense
  // `C:/work/c:/work/a.ts` and a misleading "has no changes to stage".
  const alreadyInside = p.toLowerCase().startsWith(`${normalizedRoot.toLowerCase()}/`);
  const absolute = alreadyInside ? p : `${normalizedRoot}/${p.replace(/^\/+/, "")}`;
  const relative = absolute.slice(normalizedRoot.length + 1);
  if (!relative || relative.split("/").some((seg) => seg === ".." || seg === "")) return null;
  return absolute;
}
