/**
 * A record of every Git command the app has run, for "Show Git Output" -- the same thing
 * VS Code's Git output channel gives you: what was actually executed, what it exited with,
 * and how long it took. Everything funnels through `backend.ts`'s `gitExec`, so recording
 * there catches every caller (panel, AI tools, graph, hunk staging) with no per-call-site
 * work and no way for a new caller to forget to log itself.
 */

/** The largest number of entries kept. Old entries are dropped, oldest first. */
const CAPACITY = 500;
/** Git's stderr on a failure is the useful part; a runaway one is not worth keeping whole. */
const STDERR_LIMIT = 4000;

export interface GitLogEntry {
  id: number;
  /** Wall-clock start, for display. */
  startedAt: number;
  /** Which repository the command ran in -- its root path, as `git_exec` addresses it. */
  repoId: string;
  /** Argv after the `git` program name, already redacted. */
  args: string[];
  /** Bytes piped to stdin (patch content for `apply`). The content itself is never kept:
   * it is large, and it is the user's source code. */
  inputBytes: number;
  /** Absent while the command is still running. */
  durationMs?: number;
  /** Git's exit status. Absent while running; -1 when the call failed before Git ran
   * (validation refusal, spawn failure), with `error` explaining. */
  code?: number;
  stderr?: string;
  /** Set when the IPC call itself rejected rather than Git exiting nonzero. */
  error?: string;
}

/**
 * Removes credentials from anything URL-shaped before it is stored or displayed. A remote
 * URL can legitimately carry a token (`https://x-access-token:ghp_…@github.com/o/r.git`),
 * and this log is meant to be read and pasted into bug reports, so the token must never
 * reach it. Matches the userinfo component only, leaving the rest of the URL intact so the
 * entry is still useful.
 */
export function redactUrlCredentials(argument: string): string {
  return argument.replace(
    /\b([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)([^/@\s]+)@/g,
    (_match, scheme: string) => `${scheme}***@`,
  );
}

let nextId = 1;
let entries: GitLogEntry[] = [];
const listeners = new Set<() => void>();

function emit(): void {
  // A fresh array identity per change is what `useSyncExternalStore` compares; mutating in
  // place would leave React seeing the same snapshot and skipping the render.
  for (const listener of listeners) listener();
}

export function subscribeGitLog(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Stable between changes, as `useSyncExternalStore` requires. */
export function gitLogSnapshot(): readonly GitLogEntry[] {
  return entries;
}

export function clearGitLog(): void {
  entries = [];
  emit();
}

/**
 * Records a command that has just started. Returns the id to close it out with, so a
 * still-running command is visible in the log rather than appearing only once it finishes
 * (a hung `git push` is exactly when someone opens this view).
 */
export function recordGitStart(repoId: string, args: string[], input?: string): number {
  const entry: GitLogEntry = {
    id: nextId++,
    startedAt: Date.now(),
    repoId,
    args: args.map(redactUrlCredentials),
    inputBytes: input ? input.length : 0,
  };
  entries = [...entries, entry];
  if (entries.length > CAPACITY) entries = entries.slice(entries.length - CAPACITY);
  emit();
  return entry.id;
}

export function recordGitEnd(
  id: number,
  outcome: { code: number; stderr?: string } | { error: string },
): void {
  const index = entries.findIndex((entry) => entry.id === id);
  // Dropped by the capacity trim while it ran: nothing to close out.
  if (index === -1) return;
  const previous = entries[index];
  const finished: GitLogEntry = {
    ...previous,
    durationMs: Date.now() - previous.startedAt,
    ...("error" in outcome
      ? { code: -1, error: redactUrlCredentials(outcome.error) }
      : {
          code: outcome.code,
          stderr: outcome.stderr
            ? redactUrlCredentials(outcome.stderr).slice(0, STDERR_LIMIT)
            : undefined,
        }),
  };
  entries = [...entries.slice(0, index), finished, ...entries.slice(index + 1)];
  emit();
}

/** The command line as it would be typed, for display and for copying out of the view. */
export function formatGitLogEntry(entry: GitLogEntry): string {
  const time = new Date(entry.startedAt).toLocaleTimeString();
  const command = `git ${entry.args.join(" ")}`;
  if (entry.code === undefined) return `${time} ${command} — running…`;
  const took = entry.durationMs === undefined ? "" : ` (${entry.durationMs}ms)`;
  if (entry.error) return `${time} ${command} — failed: ${entry.error}${took}`;
  return `${time} ${command} — exit ${entry.code}${took}`;
}
