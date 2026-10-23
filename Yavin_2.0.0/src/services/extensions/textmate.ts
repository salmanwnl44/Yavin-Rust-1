/**
 * TextMate grammars (EXT-25): extensions' `.tmLanguage(.json)` files tokenizing documents, so a
 * language with no tokenizer of Yavin's own is coloured as VS Code colours it.
 *
 * The engine is `@shikijs/vscode-textmate` (VS Code's tokenizer, as Shiki maintains it) with
 * Shiki's JavaScript regular-expression engine (`oniguruma-to-es`: Oniguruma patterns as native
 * RegExps). No WebAssembly -- the window's CSP allows none -- and patterns JavaScript cannot
 * express are skipped (`forgiving`), not guessed. It runs in a worker of its own
 * (`editor/textmate.worker.ts`), which the window ends when it takes too long: a grammar's
 * patterns are third-party regular expressions, and one can backtrack for ever.
 *
 * Bounds: a line takes at most `LINE_MS` (the rest of it stays plain, as VS Code does), a
 * document at most `DOCUMENT_MS` and `MAX_LINES` lines, a line longer than `MAX_LINE` is not
 * tokenized. Each token is the editor's token for its innermost mapped scope (`scopeToken`,
 * the same table a theme's scopes map by), so themes colour grammar tokens as they colour the
 * editor's own.
 */
import { INITIAL, Registry, type IRawGrammar, type StateStack } from "@shikijs/vscode-textmate";
import { createJavaScriptRegexEngine } from "@shikijs/engine-javascript";
import { parseJsonc, scopeToken, SCOPE_TOKENS } from "./declarative.ts";

export const LINE_MS = 50;
export const DOCUMENT_MS = 1500;
export const MAX_LINES = 20_000;
export const MAX_LINE = 5_000;

/** A grammar file, as an extension contributes it. */
export interface GrammarSource {
  scopeName: string;
  /** Its file's name (what kind it is) and text. */
  path: string;
  text: string;
}

/** One line's tokens: `[start, length, token]` triples, `token` an index into `SCOPE_TOKENS`. */
export type LineTokens = number[];

export interface Tokenized {
  lines: LineTokens[];
  /** Some lines (or the end of the document) were left plain: too long, or out of time. */
  partial: boolean;
}

// --- Property lists (.tmLanguage, .plist) ------------------------------------------------------

const ENTITIES: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };
const unescape = (text: string) =>
  text.replace(/&(#x[0-9a-f]+|#\d+|lt|gt|amp|quot|apos);/gi, (_, e: string) =>
    e[0] === "#"
      ? String.fromCodePoint(
          e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10),
        )
      : ENTITIES[e.toLowerCase()],
  );

/** An XML property list (what `.tmLanguage` files are) as JSON: dict, array, string, numbers, booleans. */
export function parsePlist(text: string): unknown {
  const tokens = text
    .replace(/<\?[\s\S]*?\?>|<!--[\s\S]*?-->|<!DOCTYPE[^>]*>/g, "")
    .match(/<\/?[A-Za-z]+[^>]*>|[^<]+/g)
    // A tag as its name alone: `<plist version="1.0">` is `<plist>`, `<true />` is `<true/>`.
    ?.map((token) => token.replace(/^<(\/?)([A-Za-z]+)[^>]*?(\/?)>$/, "<$1$2$3>"));
  if (!tokens) throw new Error("not a property list");
  let i = 0;
  const skipSpace = () => {
    while (i < tokens.length && !tokens[i].startsWith("<") && !tokens[i].trim()) i++;
  };
  const textUntil = (tag: string) => {
    let out = "";
    while (i < tokens.length && tokens[i].replace(/\s/g, "") !== `</${tag}>`) out += tokens[i++];
    i++;
    return unescape(out);
  };
  const value = (depth: number): unknown => {
    if (depth > 64) throw new Error("the property list nests too deeply");
    skipSpace();
    const tag = (tokens[i++] ?? "").replace(/\s/g, "");
    switch (tag) {
      case "<plist>": {
        const inner = value(depth + 1);
        skipSpace();
        i++;
        return inner;
      }
      case "<dict>": {
        const out: Record<string, unknown> = {};
        for (;;) {
          skipSpace();
          if ((tokens[i] ?? "").replace(/\s/g, "") === "</dict>") {
            i++;
            return out;
          }
          if ((tokens[i++] ?? "").replace(/\s/g, "") !== "<key>")
            throw new Error("a dict entry has no key");
          const key = textUntil("key");
          out[key] = value(depth + 1);
        }
      }
      case "<dict/>":
        return {};
      case "<array>": {
        const out: unknown[] = [];
        for (;;) {
          skipSpace();
          if ((tokens[i] ?? "").replace(/\s/g, "") === "</array>") {
            i++;
            return out;
          }
          out.push(value(depth + 1));
        }
      }
      case "<array/>":
        return [];
      case "<string>":
        return textUntil("string");
      case "<string/>":
        return "";
      case "<integer>":
        return parseInt(textUntil("integer"), 10);
      case "<real>":
        return parseFloat(textUntil("real"));
      case "<true/>":
        return true;
      case "<false/>":
        return false;
      default:
        throw new Error(`unexpected ${tag || "end"} in the property list`);
    }
  };
  return value(0);
}

/** A grammar file's text as a raw grammar: JSON(C), or a property list. */
export function rawGrammarOf(source: GrammarSource): IRawGrammar {
  const trimmed = source.text.replace(/^﻿/, "").trimStart();
  const raw = (
    trimmed.startsWith("<") ? parsePlist(trimmed) : parseJsonc(trimmed)
  ) as IRawGrammar | null;
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Error(`${source.path} is not a grammar.`);
  return raw;
}

// --- Tokenizing ---------------------------------------------------------------------------------

const TOKEN_INDEX = new Map(SCOPE_TOKENS.map((token, index) => [token, index]));

/** The token of a TextMate token's scopes: its innermost scope with a mapping. */
function tokenIndexOf(scopes: readonly string[]): number | null {
  let found: string | null = null;
  for (let i = scopes.length - 1; i > 0; i--) {
    const token = scopeToken(scopes[i]);
    if (token === null) continue;
    // A comment's or a string's own punctuation is coloured as the comment or string is (as
    // themes colour it: few give punctuation a colour of its own).
    if (found === "delimiter" && ["comment", "string", "regexp", "tag"].includes(token))
      found = token;
    if (found === null) found = token;
    if (found !== "delimiter") break;
  }
  return found === null ? null : (TOKEN_INDEX.get(found) ?? null);
}

/**
 * A tokenizer of `grammars` (every enabled extension's; the first of a scope name wins, as the
 * caller ordered them). `problems` collects what could not be read.
 */
export function createTokenizer(
  grammars: readonly GrammarSource[],
  now: () => number = () => Date.now(),
) {
  const problems: string[] = [];
  const raws = new Map<string, IRawGrammar>();
  for (const grammar of grammars) {
    if (raws.has(grammar.scopeName)) continue;
    try {
      raws.set(grammar.scopeName, rawGrammarOf(grammar));
    } catch (error) {
      problems.push(`${grammar.scopeName}: ${(error as Error).message}`);
    }
  }
  const engine = createJavaScriptRegexEngine({ forgiving: true });
  const registry = new Registry({
    onigLib: {
      createOnigScanner: (sources) => engine.createScanner(sources),
      createOnigString: (text) => engine.createString(text),
    },
    loadGrammar: (scopeName) => raws.get(scopeName) ?? null,
  });
  return {
    problems,
    /** `text` in `scopeName`'s grammar, within the bounds above. */
    tokenize(scopeName: string, text: string): Tokenized {
      const grammar = registry.loadGrammar(scopeName);
      if (!grammar) throw new Error(`There is no grammar ${scopeName}.`);
      const started = now();
      const lines = text.split(/\r\n|\r|\n/);
      const out: LineTokens[] = [];
      let partial = lines.length > MAX_LINES;
      let state: StateStack = INITIAL;
      for (const line of lines.slice(0, MAX_LINES)) {
        if (now() - started > DOCUMENT_MS) {
          partial = true;
          break;
        }
        if (line.length > MAX_LINE) {
          out.push([]);
          partial = true;
          continue;
        }
        const result = grammar.tokenizeLine(line, state, LINE_MS);
        if (result.stoppedEarly) partial = true;
        state = result.ruleStack;
        const tokens: LineTokens = [];
        for (const token of result.tokens) {
          const index = tokenIndexOf(token.scopes);
          const length = Math.min(token.endIndex, line.length) - token.startIndex;
          if (index === null || length <= 0) continue;
          // One token for a run of the same kind (a string's quotes and its text).
          const last = tokens.length - 3;
          if (
            last >= 0 &&
            tokens[last + 2] === index &&
            tokens[last] + tokens[last + 1] === token.startIndex
          )
            tokens[last + 1] += length;
          else tokens.push(token.startIndex, length, index);
        }
        out.push(tokens);
      }
      return { lines: out, partial };
    },
  };
}

export { SCOPE_TOKENS };
