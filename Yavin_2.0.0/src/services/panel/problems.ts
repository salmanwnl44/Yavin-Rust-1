import type { Diagnostic, Severity } from "./problemMatchers.ts";
import { problemResourceId } from "./problemLocations.ts";

/**
 * Every diagnostic currently known, grouped by the tool that produced it.
 *
 * Keyed by owner because that is what makes republishing safe: TypeScript running again
 * replaces TypeScript's results and leaves ESLint's alone. Without that, one tool finishing
 * would either wipe the other's findings or leave stale ones behind forever.
 */

export interface OwnedDiagnostics {
  owner: string;
  /** Shown beside each entry, e.g. "TypeScript". */
  label: string;
  diagnostics: readonly Diagnostic[];
  /** When this owner last published, for "nothing has run yet" versus "ran, found nothing". */
  at: number;
}

/**
 * How a problem is listed and filtered: its severity, except that a hint (LSP severity 4,
 * kept as `info` with `hint: true` so counts stay as they were) is a kind of its own.
 */
export type ProblemKind = Severity | "hint";

export const PROBLEM_KINDS: readonly ProblemKind[] = ["error", "warning", "info", "hint"];

export function kindOf(problem: Pick<Diagnostic, "severity" | "hint">): ProblemKind {
  return problem.hint ? "hint" : problem.severity;
}

/**
 * Whether two diagnostic files are the same file: by resource identity (`resource.ts`), so
 * spelling -- separators, drive-letter case, `\\?\`, a `file:` URI -- does not matter. Text
 * that names no local file compares as text.
 */
export function sameProblemFile(one: string, other: string): boolean {
  const a = problemResourceId(one);
  const b = problemResourceId(other);
  return a !== null && b !== null ? a === b : one === other;
}

export interface FileProblems {
  /** The file as the first diagnostic for it spelled it (canonical for every producer). */
  file: string;
  problems: (Diagnostic & { source: string })[];
}

const owners = new Map<string, OwnedDiagnostics>();
const listeners = new Set<() => void>();
let version = 0;
let snapshot: readonly OwnedDiagnostics[] = [];
let stale = true;

function changed(): void {
  version += 1;
  stale = true;
  for (const listener of listeners) listener();
}

export function subscribeProblems(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function problemsVersion(): number {
  return version;
}

/** Replaces everything this owner previously reported. */
export function publishProblems(
  owner: string,
  label: string,
  diagnostics: readonly Diagnostic[],
): void {
  // Copied: holding the caller's array would let a later mutation change what is displayed
  // with no version bump, so nothing would re-render and the two would silently disagree.
  owners.set(owner, { owner, label, diagnostics: [...diagnostics], at: Date.now() });
  changed();
}

export function clearProblems(owner?: string): void {
  if (owner) owners.delete(owner);
  else owners.clear();
  changed();
}

export function allProblems(): readonly OwnedDiagnostics[] {
  if (stale) {
    snapshot = [...owners.values()];
    stale = false;
  }
  return snapshot;
}

/** How many of each severity are known, for the tab badge and the status bar. */
export function problemCounts(): Record<Severity, number> {
  const counts: Record<Severity, number> = { error: 0, warning: 0, info: 0 };
  for (const owned of owners.values())
    for (const problem of owned.diagnostics) counts[problem.severity] += 1;
  return counts;
}

/** Whether `text` matches, treating `*` as "any run of characters" the way a glob does. */
export function matchesFilter(text: string, filter: string): boolean {
  const needle = filter.trim();
  if (!needle) return true;
  const negated = needle.startsWith("!");
  const body = negated ? needle.slice(1) : needle;
  if (!body) return true;

  const matched = body.includes("*")
    ? new RegExp(
        `^${body
          .split("*")
          .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
          .join(".*")}$`,
        "i",
      ).test(text)
    : text.toLowerCase().includes(body.toLowerCase());
  return negated ? !matched : matched;
}

/**
 * Whether a problem survives the filter, which is matched against its path and its message.
 *
 * Negation flips the combining rule, not just the result: `login` means "either the path or
 * the message mentions login", but `!node_modules` means "*neither* does". Combining a
 * negated filter with OR let anything through whose message happened not to contain the
 * excluded word, which defeats the point of excluding.
 */
export function includeProblem(file: string, message: string, filter: string): boolean {
  if (!filter.trim()) return true;
  return filter.trim().startsWith("!")
    ? matchesFilter(file, filter) && matchesFilter(message, filter)
    : matchesFilter(file, filter) || matchesFilter(message, filter);
}

/**
 * Diagnostics grouped by file, the way the Problems view lists them: files in path order,
 * and within a file by position. `severities` (kinds: hints are their own) and `filter`
 * narrow what is included -- the filter matching either the path or the message, as VS
 * Code's does. Files are grouped, and `file` (the current file) matched, by resource
 * identity: a language server's and a checker's diagnostics for one file are one group.
 * Diagnostics from different owners are never merged -- the same error from `tsc` and from
 * the TypeScript server is listed twice, each with its source, as VS Code lists them.
 */
export function groupByFile(
  owned: readonly OwnedDiagnostics[],
  options: { severities?: readonly ProblemKind[]; filter?: string; file?: string } = {},
): FileProblems[] {
  const severities = options.severities ?? PROBLEM_KINDS;
  const current = options.file === undefined ? undefined : problemResourceId(options.file);
  const byFile = new Map<string, { file: string; problems: (Diagnostic & { source: string })[] }>();

  for (const group of owned)
    for (const problem of group.diagnostics) {
      if (!severities.includes(kindOf(problem))) continue;
      const id = problemResourceId(problem.file);
      if (options.file !== undefined) {
        const same = current && id ? current === id : problem.file === options.file;
        if (!same) continue;
      }
      if (options.filter && !includeProblem(problem.file, problem.message, options.filter))
        continue;
      const key = id ?? problem.file;
      const entry = byFile.get(key) ?? { file: problem.file, problems: [] };
      entry.problems.push({ ...problem, source: group.label });
      byFile.set(key, entry);
    }

  return [...byFile.values()]
    .map(({ file, problems }) => ({
      file,
      problems: problems.sort((a, b) => a.line - b.line || a.column - b.column),
    }))
    .sort((a, b) => a.file.localeCompare(b.file));
}

/** Test seam. */
export function resetProblems(): void {
  owners.clear();
  version = 0;
  stale = true;
}
