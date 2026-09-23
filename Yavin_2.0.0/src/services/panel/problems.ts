import type { Diagnostic, Severity } from "./problemMatchers.ts";

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

export interface FileProblems {
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
 * and within a file by position. `severities` and `filter` narrow what is included -- the
 * filter matching either the path or the message, as VS Code's does.
 */
export function groupByFile(
  owned: readonly OwnedDiagnostics[],
  options: { severities?: readonly Severity[]; filter?: string; file?: string } = {},
): FileProblems[] {
  const severities = options.severities ?? ["error", "warning", "info"];
  const byFile = new Map<string, (Diagnostic & { source: string })[]>();

  for (const group of owned)
    for (const problem of group.diagnostics) {
      if (!severities.includes(problem.severity)) continue;
      if (options.file && problem.file !== options.file) continue;
      if (options.filter && !includeProblem(problem.file, problem.message, options.filter))
        continue;
      const list = byFile.get(problem.file) ?? [];
      list.push({ ...problem, source: group.label });
      byFile.set(problem.file, list);
    }

  return [...byFile.entries()]
    .map(([file, problems]) => ({
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
