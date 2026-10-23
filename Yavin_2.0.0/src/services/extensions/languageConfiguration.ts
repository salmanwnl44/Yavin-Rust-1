/**
 * Language configuration (EXT-25): a VS Code extension's `language-configuration.json` as the
 * editor's own (Monaco's `LanguageConfiguration` shape, without importing Monaco) -- comments,
 * brackets, auto-closing and surrounding pairs, folding markers, the word pattern, indentation
 * and on-Enter rules. Data only, and nothing in it is trusted:
 *
 * - every string is bounded, every list is bounded;
 * - its regular expressions run in the window, on every keystroke, so each must compile, be at
 *   most 1000 characters, and have no unbounded quantifier over a group that itself repeats
 *   without bound (`(a+)+`, `(\w*\s?)*`: the shapes that backtrack exponentially). One that does
 *   not qualify is left out and said; the rest of the file still applies.
 */

export type IndentAction = 0 | 1 | 2 | 3;

export interface LanguageConfig {
  comments?: { lineComment?: string; blockComment?: [string, string] };
  brackets?: [string, string][];
  autoClosingPairs?: { open: string; close: string; notIn?: string[] }[];
  surroundingPairs?: { open: string; close: string }[];
  folding?: { markers?: { start: RegExp; end: RegExp }; offSide?: boolean };
  wordPattern?: RegExp;
  indentationRules?: {
    increaseIndentPattern: RegExp;
    decreaseIndentPattern: RegExp;
    indentNextLinePattern?: RegExp;
    unIndentedLinePattern?: RegExp;
  };
  onEnterRules?: {
    beforeText: RegExp;
    afterText?: RegExp;
    previousLineText?: RegExp;
    action: { indentAction: IndentAction; appendText?: string; removeText?: number };
  }[];
}

const MAX_PATTERN = 1000;
const MAX_LIST = 100;
const short = (value: unknown, max = 20): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= max;

/**
 * Whether `source` repeats a group without bound when that group can itself repeat without
 * bound -- the nested-quantifier shape that backtracks exponentially. Conservative: it may
 * refuse a harmless pattern, never accept such a one.
 */
export function nestedQuantifier(source: string): boolean {
  // For each open group: whether it contains an unbounded quantifier.
  const stack: boolean[] = [];
  let inClass = false;
  const unboundedAt = (i: number) => {
    const c = source[i];
    if (c === "*" || c === "+") return true;
    if (c === "{") {
      const m = /^\{(\d*)(,?)(\d*)\}/.exec(source.slice(i));
      return !!m && m[2] === "," && m[3] === "";
    }
    return false;
  };
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (c === "\\") {
      i++;
      continue;
    }
    if (inClass) {
      if (c === "]") inClass = false;
      continue;
    }
    if (c === "[") inClass = true;
    else if (c === "(") stack.push(false);
    else if (c === ")") {
      const inner = stack.pop() ?? false;
      if (inner && unboundedAt(i + 1)) return true;
      if (stack.length && (inner || unboundedAt(i + 1))) stack[stack.length - 1] = true;
    } else if (unboundedAt(i) && stack.length) stack[stack.length - 1] = true;
  }
  return false;
}

/** A VS Code pattern (a string, or `{pattern, flags}`) as a RegExp, or why it is not used. */
export function patternOf(value: unknown): RegExp | string {
  const raw = value as { pattern?: unknown; flags?: unknown } | string | null;
  const source =
    typeof raw === "string" ? raw : raw && typeof raw.pattern === "string" ? raw.pattern : null;
  if (source === null) return "not a pattern";
  if (source.length > MAX_PATTERN) return `longer than ${MAX_PATTERN} characters`;
  if (nestedQuantifier(source)) return "a repetition of a repetition (it could hang the editor)";
  const flags =
    typeof raw === "object" && raw && typeof raw.flags === "string"
      ? [...new Set(raw.flags.split(""))].filter((f) => "imsu".includes(f)).join("")
      : "";
  try {
    return new RegExp(source, flags);
  } catch (error) {
    return `it does not compile (${(error as Error).message})`;
  }
}

const pair = (value: unknown): [string, string] | null =>
  Array.isArray(value) && value.length === 2 && short(value[0]) && short(value[1])
    ? [value[0], value[1]]
    : null;

const INDENT: Record<string, IndentAction> = { none: 0, indent: 1, indentOutdent: 2, outdent: 3 };

/** A configuration file's JSON as the editor's configuration, with what was left out. */
export function languageConfigurationFrom(json: unknown): {
  config: LanguageConfig;
  problems: string[];
} {
  const problems: string[] = [];
  const config: LanguageConfig = {};
  if (!json || typeof json !== "object" || Array.isArray(json))
    return { config, problems: ["The language configuration is not a JSON object."] };
  const raw = json as Record<string, unknown>;
  const regex = (value: unknown, what: string): RegExp | undefined => {
    const result = patternOf(value);
    if (typeof result === "string") {
      problems.push(`${what}: ${result}`);
      return undefined;
    }
    return result;
  };

  const comments = raw.comments as Record<string, unknown> | undefined;
  if (comments && typeof comments === "object") {
    config.comments = {};
    if (short(comments.lineComment)) config.comments.lineComment = comments.lineComment;
    const block = pair(comments.blockComment);
    if (block) config.comments.blockComment = block;
  }
  if (Array.isArray(raw.brackets))
    config.brackets = raw.brackets
      .slice(0, MAX_LIST)
      .map(pair)
      .filter((p): p is [string, string] => !!p);
  const pairs = (value: unknown) =>
    (Array.isArray(value) ? value.slice(0, MAX_LIST) : [])
      .map((one) => {
        if (Array.isArray(one)) {
          const p = pair(one);
          return p ? { open: p[0], close: p[1] } : null;
        }
        const o = one as { open?: unknown; close?: unknown; notIn?: unknown } | null;
        if (!o || !short(o.open) || !short(o.close)) return null;
        const notIn = Array.isArray(o.notIn)
          ? o.notIn.filter((n): n is string => short(n, 30))
          : undefined;
        return notIn?.length
          ? { open: o.open, close: o.close, notIn }
          : { open: o.open, close: o.close };
      })
      .filter((one): one is { open: string; close: string; notIn?: string[] } => !!one);
  if (raw.autoClosingPairs !== undefined) config.autoClosingPairs = pairs(raw.autoClosingPairs);
  if (raw.surroundingPairs !== undefined)
    config.surroundingPairs = pairs(raw.surroundingPairs).map(({ open, close }) => ({
      open,
      close,
    }));

  const folding = raw.folding as
    { markers?: { start?: unknown; end?: unknown }; offSide?: unknown } | undefined;
  if (folding && typeof folding === "object") {
    config.folding = {};
    if (typeof folding.offSide === "boolean") config.folding.offSide = folding.offSide;
    if (folding.markers) {
      const start = regex(folding.markers.start, "folding.markers.start");
      const end = regex(folding.markers.end, "folding.markers.end");
      if (start && end) config.folding.markers = { start, end };
    }
  }
  if (raw.wordPattern !== undefined) {
    const word = regex(raw.wordPattern, "wordPattern");
    // Monaco needs it global to find every word.
    if (word)
      config.wordPattern = new RegExp(
        word.source,
        word.flags.includes("g") ? word.flags : word.flags + "g",
      );
  }
  const indentation = raw.indentationRules as Record<string, unknown> | undefined;
  if (indentation && typeof indentation === "object") {
    const increase = regex(
      indentation.increaseIndentPattern,
      "indentationRules.increaseIndentPattern",
    );
    const decrease = regex(
      indentation.decreaseIndentPattern,
      "indentationRules.decreaseIndentPattern",
    );
    if (increase && decrease) {
      config.indentationRules = {
        increaseIndentPattern: increase,
        decreaseIndentPattern: decrease,
      };
      if (indentation.indentNextLinePattern !== undefined) {
        const next = regex(
          indentation.indentNextLinePattern,
          "indentationRules.indentNextLinePattern",
        );
        if (next) config.indentationRules.indentNextLinePattern = next;
      }
      if (indentation.unIndentedLinePattern !== undefined) {
        const un = regex(
          indentation.unIndentedLinePattern,
          "indentationRules.unIndentedLinePattern",
        );
        if (un) config.indentationRules.unIndentedLinePattern = un;
      }
    }
  }
  if (Array.isArray(raw.onEnterRules)) {
    config.onEnterRules = [];
    raw.onEnterRules.slice(0, MAX_LIST).forEach((one, index) => {
      const rule = one as Record<string, unknown> | null;
      const what = `onEnterRules[${index}]`;
      const action = rule?.action as Record<string, unknown> | undefined;
      const indentAction = typeof action?.indent === "string" ? INDENT[action.indent] : undefined;
      if (!rule || indentAction === undefined) {
        problems.push(`${what}: no action Yavin knows`);
        return;
      }
      const beforeText = regex(rule.beforeText, `${what}.beforeText`);
      if (!beforeText) return;
      const entry: NonNullable<LanguageConfig["onEnterRules"]>[number] = {
        beforeText,
        action: { indentAction },
      };
      if (rule.afterText !== undefined) {
        const after = regex(rule.afterText, `${what}.afterText`);
        if (!after) return;
        entry.afterText = after;
      }
      if (rule.previousLineText !== undefined) {
        const previous = regex(rule.previousLineText, `${what}.previousLineText`);
        if (!previous) return;
        entry.previousLineText = previous;
      }
      if (typeof action?.appendText === "string")
        entry.action.appendText = action.appendText.slice(0, 50);
      if (typeof action?.removeText === "number")
        entry.action.removeText = Math.max(0, Math.min(50, action.removeText));
      config.onEnterRules!.push(entry);
    });
  }
  for (const key of ["colorizedBracketPairs", "autoCloseBefore"])
    if (raw[key] !== undefined) problems.push(`${key}: not applied`);
  return { config, problems };
}
