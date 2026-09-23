/**
 * A record of every Git command the app has run, for "Show Git Output" -- the same thing
 * VS Code's Git output channel gives you: what was actually executed, what it exited with,
 * and how long it took. Everything funnels through `backend.ts`'s `gitExec`, so recording
 * there catches every caller (panel, AI tools, graph, hunk staging) with no per-call-site
 * work and no way for a new caller to forget to log itself.
 */

import { createOutputChannel } from "../panel/output.ts";
import type { OutputChannel } from "../panel/output.ts";

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
const entries: GitLogEntry[] = [];
/**
 * The id of `entries[0]`, which makes an entry's position `id - firstId` -- an O(1) lookup
 * instead of a scan. Ids are handed out in order and entries are only ever appended or
 * dropped from the front, so the relationship always holds.
 */
let firstId = 1;
const listeners = new Set<() => void>();

/**
 * The array handed to `useSyncExternalStore`, rebuilt lazily. Every Git command in the app
 * writes here, including bulk operations that issue one call per file, so the writes are kept
 * O(1): copying the buffer on each write instead cost two full-length array copies per Git
 * call, which was measurable on a 1,200-file Stage All. The copy now happens only when
 * something actually reads the log, i.e. when the Git Output view is open.
 */
let cache: readonly GitLogEntry[] = [];
let cacheStale = false;

function changed(): void {
  cacheStale = true;
  for (const listener of listeners) listener();
}

export function subscribeGitLog(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** A new identity after each change and a stable one between changes, as
 * `useSyncExternalStore` requires on both counts. */
export function gitLogSnapshot(): readonly GitLogEntry[] {
  if (cacheStale) {
    cache = entries.slice();
    cacheStale = false;
  }
  return cache;
}

export function clearGitLog(): void {
  entries.length = 0;
  firstId = nextId;
  changed();
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
  entries.push(entry);
  if (entries.length === 1) firstId = entry.id;
  while (entries.length > CAPACITY) {
    entries.shift();
    firstId++;
  }
  changed();
  return entry.id;
}

export function recordGitEnd(
  id: number,
  outcome: { code: number; stderr?: string } | { error: string },
): void {
  const index = id - firstId;
  // Out of range means the capacity trim dropped it while it ran: nothing to close out.
  if (index < 0 || index >= entries.length) return;
  const previous = entries[index];
  entries[index] = {
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
  changed();

  // Mirrored into the panel's Output view, where VS Code shows the same thing. The
  // structured buffer above stays the source of truth -- it holds the redaction and the
  // running/finished distinction -- and this is its readable form.
  const finished = entries[index];
  const failed = finished.code !== 0;
  gitChannel().appendLine(formatGitLogEntry(finished), failed ? "error" : "info");
  if (finished.stderr) gitChannel().appendLine(`  ${finished.stderr}`, "error");
}

/** Resolved lazily so importing this module does not force the channel registry to load. */
let channel: OutputChannel | null = null;
function gitChannel(): OutputChannel {
  channel ??= createOutputChannel("Git");
  return channel;
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
