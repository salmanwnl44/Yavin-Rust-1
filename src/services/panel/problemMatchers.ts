/**
 * Turning a compiler or linter's output into diagnostics.
 *
 * Besides the language servers, this is the other way editors get diagnostics, and the way
 * VS Code itself does it for tasks: run the tool, match its output with a pattern, and publish
 * what comes out under an `owner`. The owner is the important part -- it lets one tool's
 * results be replaced wholesale on its next run without disturbing another's.
 */

export type Severity = "error" | "warning" | "info";

export interface Diagnostic {
  /**
   * The file. A matcher yields it as the tool printed it (absolute, or relative to the folder
   * the tool ran in); everything in the Problems store holds the canonical path instead
   * (`problemLocations.ts`), and is compared by resource identity.
   */
  file: string;
  /** 1-based, as every compiler reports and every editor displays. */
  line: number;
  column: number;
  severity: Severity;
  message: string;
  /** The rule or error code, e.g. `TS2345`, `E0425`, `no-unused-vars`. */
  code?: string;
  /** Where the problem ends (1-based), when the tool says: language servers always do. */
  endLine?: number;
  endColumn?: number;
  /** The tool's own name for itself, e.g. `ts` or `pyright`, when it gives one. */
  origin?: string;
  /** A hint rather than information (LSP severity 4): shown fainter, counted as info. */
  hint?: boolean;
  /** Unused code is drawn faded, deprecated code struck through. */
  tags?: ("unnecessary" | "deprecated")[];
  /** Other places the problem involves. */
  related?: { file: string; line: number; column: number; message: string }[];
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
  /**
   * Other formats the same tool prints, each a run of consecutive lines -- what it prints by
   * default in a terminal, when `pattern` is the format a checker asks for. Each line gives
   * some of a diagnostic's parts; a diagnostic is complete at the format's last line.
   */
  formats?: readonly (readonly LinePattern[])[];
}

/** One line of a multi-line format, and which of a diagnostic's parts it gives. */
export interface LinePattern {
  regexp: RegExp;
  groups: Partial<Record<Part, number>>;
  /**
   * The format's last line may repeat: each match is one more diagnostic, with the parts the
   * lines before it gave (eslint's file line, then one line per finding).
   */
  loop?: boolean;
}

type Part = "file" | "line" | "column" | "severity" | "code" | "message";

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
  pattern: /^\s*(\S.*?)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s+(.*)$/,
  groups: { file: 1, line: 2, column: 3, severity: 4, code: 5, message: 6 },
  formats: [
    // Its default in a terminal (`--pretty`, and every `--watch` cycle):
    // `src/app.ts:12:7 - error TS2345: Argument of type 'x' is not assignable.`
    [
      {
        regexp: /^\s*(\S.*?):(\d+):(\d+)\s+-\s+(error|warning|message)\s+(TS\d+):\s+(.*)$/,
        groups: { file: 1, line: 2, column: 3, severity: 4, code: 5, message: 6 },
      },
    ],
  ],
};

/**
 * `cargo check --message-format short`:
 * `src/main.rs:3:5: error[E0425]: cannot find value `x` in this scope`
 */
export const CARGO: ProblemMatcher = {
  owner: "cargo",
  label: "Rust",
  pattern: /^\s*(\S.*?):(\d+):(\d+):\s+(error|warning)(?:\[([^\]]+)\])?:\s+(.*)$/,
  groups: { file: 1, line: 2, column: 3, severity: 4, code: 5, message: 6 },
  formats: [
    // Its default (`cargo check`, `cargo build`): the message, then where on the next line.
    // `error[E0425]: cannot find value `x` in this scope`
    // ` --> src\main.rs:3:5`
    [
      {
        regexp: /^(error|warning)(?:\[([^\]]+)\])?:\s+(.*)$/,
        groups: { severity: 1, code: 2, message: 3 },
      },
      { regexp: /^\s*-->\s+(.+?):(\d+):(\d+)\s*$/, groups: { file: 1, line: 2, column: 3 } },
    ],
  ],
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
  formats: [
    // Its default ("stylish"): the file on a line of its own, then one indented line per
    // finding, the rule after two or more spaces.
    // `C:\work\src\app.ts`
    // `  4:1  error  'x' is assigned a value but never used  no-unused-vars`
    [
      { regexp: /^(\S.*)$/, groups: { file: 1 } },
      {
        regexp: /^\s+(\d+):(\d+)\s+(error|warning)\s+(.*?)(?:\s{2,}(\S+))?$/,
        groups: { line: 1, column: 2, severity: 3, message: 4, code: 5 },
        loop: true,
      },
    ],
  ],
};

/**
 * `ruff check --output-format concise`:
 * `app/main.py:14:24: F401 [*] `os` imported but unused`
 */
export const RUFF: ProblemMatcher = {
  owner: "ruff",
  label: "Ruff",
  pattern: /^\s*(\S.*?):(\d+):(\d+):\s+([A-Z]+\d+)\s+(?:\[[*x ]\]\s+)?(.*)$/,
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
  const session = new MatcherSession(matcher);
  const found: Diagnostic[] = [];
  for (const raw of output.split("\n")) found.push(...session.line(raw.replace(/\r$/, "")));
  return found;
}

/**
 * One matcher reading one output, line by line, as it arrives: each of its formats follows the
 * lines it has matched so far, so a multi-line format is matched across lines given one at a
 * time. A format's lines must be consecutive (blank lines aside); a line that breaks a format
 * starts it over, and is tried as its first line.
 */
export class MatcherSession {
  private readonly matcher: ProblemMatcher;
  private readonly formats: { lines: readonly LinePattern[]; at: number; parts: Captured }[];

  constructor(matcher: ProblemMatcher) {
    this.matcher = matcher;
    this.formats = [
      [{ regexp: matcher.pattern, groups: matcher.groups }],
      ...(matcher.formats ?? []),
    ].map((lines) => ({ lines, at: 0, parts: {} }));
  }

  /** The diagnostics `line` completes. */
  line(line: string): Diagnostic[] {
    if (!line.trim()) return [];
    const found: Diagnostic[] = [];
    for (const format of this.formats) {
      if (format.at > 0) {
        const pattern = format.lines[format.at];
        const match = pattern.regexp.exec(line);
        if (match) {
          const parts = { ...format.parts, ...capture(pattern, match) };
          if (format.at === format.lines.length - 1) {
            this.emit(parts, found);
            // A repeating last line keeps what the lines before it gave.
            if (!pattern.loop) format.at = 0;
          } else {
            format.parts = parts;
            format.at += 1;
          }
          continue;
        }
        format.at = 0;
        format.parts = {};
      }
      const first = format.lines[0];
      const match = first.regexp.exec(line);
      if (!match) continue;
      if (format.lines.length === 1) {
        this.emit(capture(first, match), found);
      } else {
        format.parts = capture(first, match);
        format.at = 1;
      }
    }
    return found;
  }

  private emit(parts: Captured, found: Diagnostic[]): void {
    const at = Number(parts.line);
    // A location that is not a positive number is not a location.
    if (!parts.file || parts.message === undefined || !Number.isFinite(at) || at < 1) return;
    const column = parts.column === undefined ? 1 : Number(parts.column);
    found.push({
      file: parts.file,
      line: at,
      column: Number.isFinite(column) && column >= 1 ? column : 1,
      severity: severityOf(parts.severity, this.matcher.defaultSeverity ?? "error"),
      message: parts.message.trim(),
      ...(parts.code ? { code: parts.code } : {}),
    });
  }
}

type Captured = Partial<Record<Part, string>>;

const capture = (pattern: LinePattern, match: RegExpExecArray): Captured => {
  const parts: Captured = {};
  for (const [part, group] of Object.entries(pattern.groups) as [Part, number][]) {
    const value = match[group];
    if (value !== undefined) parts[part] = value;
  }
  return parts;
};
