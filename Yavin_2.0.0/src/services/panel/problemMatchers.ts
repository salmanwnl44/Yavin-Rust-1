/**
 * Turning a compiler or linter's output into diagnostics.
 *
 * Yavin has no language server, so this is the other way editors get diagnostics, and the way
 * VS Code itself does it for tasks: run the tool, match its output with a pattern, and publish
 * what comes out under an `owner`. The owner is the important part -- it lets one tool's
 * results be replaced wholesale on its next run without disturbing another's.
 */

export type Severity = "error" | "warning" | "info";

export interface Diagnostic {
  /** As the tool reported it: absolute, or relative to the folder the tool ran in. */
  file: string;
  /** 1-based, as every compiler reports and every editor displays. */
  line: number;
  column: number;
  severity: Severity;
  message: string;
  /** The rule or error code, e.g. `TS2345`, `E0425`, `no-unused-vars`. */
  code?: string;
}

export interface ProblemMatcher {
  /** Replaces this producer's previous results when it runs again. */
  owner: string;
  /** Shown in the Problems view beside each entry. */
  label: string;
  pattern: RegExp;
  /** Used when the tool's output carries no severity word of its own. */
  defaultSeverity?: Severity;
  /** Which capture group holds what; 1-based, matching `RegExpExecArray` indexing. */
  groups: {
    file: number;
    line: number;
    column?: number;
    severity?: number;
    code?: number;
    message: number;
  };
}

const severityOf = (text: string | undefined, fallback: Severity): Severity => {
  if (text === undefined) return fallback;
  const value = text.toLowerCase();
  if (value.startsWith("warn")) return "warning";
  if (value.startsWith("err") || value.startsWith("fatal")) return "error";
  return "info";
};

/**
 * `tsc --noEmit --pretty false`:
 * `src/app.ts(12,7): error TS2345: Argument of type 'x' is not assignable.`
 */
export const TSC: ProblemMatcher = {
  owner: "tsc",
  label: "TypeScript",
  pattern: /^(\S.*?)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s+(.*)$/,
  groups: { file: 1, line: 2, column: 3, severity: 4, code: 5, message: 6 },
};

/**
 * `cargo check --message-format short`:
 * `src/main.rs:3:5: error[E0425]: cannot find value `x` in this scope`
 */
export const CARGO: ProblemMatcher = {
  owner: "cargo",
  label: "Rust",
  pattern: /^(\S.*?):(\d+):(\d+):\s+(error|warning)(?:\[([^\]]+)\])?:\s+(.*)$/,
  groups: { file: 1, line: 2, column: 3, severity: 4, code: 5, message: 6 },
};

/**
 * `eslint -f compact`:
 * `/p/src/a.ts: line 4, col 1, Error - 'x' is assigned but never used. (no-unused-vars)`
 */
export const ESLINT: ProblemMatcher = {
  owner: "eslint",
  label: "ESLint",
  pattern:
    /^(\S.*?):\s+line\s+(\d+),\s+col\s+(\d+),\s+(Error|Warning)\s+-\s+(.*?)(?:\s+\(([^()]+)\))?$/,
  groups: { file: 1, line: 2, column: 3, severity: 4, code: 6, message: 5 },
};

/**
 * `ruff check --output-format concise`:
 * `app/main.py:14:24: F401 [*] `os` imported but unused`
 */
export const RUFF: ProblemMatcher = {
  owner: "ruff",
  label: "Ruff",
  pattern: /^(\S.*?):(\d+):(\d+):\s+([A-Z]+\d+)\s+(?:\[[*x ]\]\s+)?(.*)$/,
  groups: { file: 1, line: 2, column: 3, code: 4, message: 5 },
  // Ruff prints no severity word. A lint finding is something to look at, not a build
  // failure, so it is a warning rather than inheriting the compiler default of error.
  defaultSeverity: "warning",
};

export const MATCHERS: Readonly<Record<string, ProblemMatcher>> = {
  tsc: TSC,
  cargo: CARGO,
  eslint: ESLINT,
  ruff: RUFF,
};

/**
 * Every diagnostic a tool's output contains. Lines that do not match are ignored rather than
 * guessed at: a compiler prints progress, summaries and blank lines around the parts that
 * name a location, and inventing a diagnostic from one of those would be worse than missing
 * one.
 */
export function parseProblems(matcher: ProblemMatcher, output: string): Diagnostic[] {
  const found: Diagnostic[] = [];
  for (const raw of output.split("\n")) {
    const line = raw.replace(/\r$/, "");
    const match = matcher.pattern.exec(line);
    if (!match) continue;

    const at = Number(match[matcher.groups.line]);
    const column = matcher.groups.column ? Number(match[matcher.groups.column]) : 1;
    // A location that is not a positive number is not a location.
    if (!Number.isFinite(at) || at < 1) continue;

    const code = matcher.groups.code ? match[matcher.groups.code] : undefined;
    found.push({
      file: match[matcher.groups.file],
      line: at,
      column: Number.isFinite(column) && column >= 1 ? column : 1,
      severity: severityOf(
        matcher.groups.severity ? match[matcher.groups.severity] : undefined,
        matcher.defaultSeverity ?? "error",
      ),
      message: match[matcher.groups.message].trim(),
      ...(code ? { code } : {}),
    });
  }
  return found;
}
