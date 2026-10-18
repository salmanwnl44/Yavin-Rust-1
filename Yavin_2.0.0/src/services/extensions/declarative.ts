/**
 * Declarative contributions (EXT-04): enabled extensions' colour themes and snippets, read from
 * their files and turned into what the editor applies -- never code. The files come from the
 * native side (`extensions_read_resource`: only the inventory's copy of the extension, contained,
 * at most 1 MiB), and nothing in them is trusted:
 *
 * - **Themes** are VS Code colour theme files (JSONC, `include` up to 3 deep). Editor colours
 *   (`editor.*`, `editorCursor.*`, `minimap.*`, …) are kept when they are colours; workbench
 *   colours (activity bar, side bar, tabs, terminal, …) are not Yavin's to change and are listed
 *   as unmapped. `tokenColors` scopes map to the editor's tokens by the table below, the most
 *   specific match winning (a later rule on a tie); scopes with no match are listed as unmapped.
 *   A TextMate `.tmTheme` file is not read.
 * - **Snippets** are VS Code snippet files: `{ name: { prefix, body, description } }`, offered
 *   for their language only (Yavin's own language id, not the editor's tokenizer).
 *
 * Disabling or uninstalling an extension takes it out of the registry's snapshot, and so out
 * of this one: its themes leave the theme list (an editor showing one falls back to Yavin Dark)
 * and its snippets are no longer offered. Order is deterministic: by extension id, then as each
 * extension lists them.
 */
import type { ExtensionRegistry, RegistrySnapshot } from "./registry.ts";

export interface ThemeRule {
  token: string;
  foreground?: string;
  background?: string;
  fontStyle?: string;
}

export interface ThemeDefinition {
  /** `ext:<extension id>:<index>`: the editor's theme name. */
  id: string;
  label: string;
  extensionId: string;
  base: "vs" | "vs-dark" | "hc-black" | "hc-light";
  rules: ThemeRule[];
  colors: Record<string, string>;
  /** Keys and scopes of the theme that Yavin does not apply. */
  unmapped: string[];
}

export interface SnippetDefinition {
  extensionId: string;
  language: string;
  name: string;
  prefix: string;
  body: string;
  description: string | null;
}

export interface DeclarativeSnapshot {
  themes: readonly ThemeDefinition[];
  snippets: readonly SnippetDefinition[];
  /** Per extension: what could not be applied, and why. */
  problems: Readonly<Record<string, readonly string[]>>;
  /** Still reading files. */
  loading: boolean;
}

/** An extension's file, as text (the native side; a test supplies its own). */
export type ResourceReader = (extensionId: string, path: string) => Promise<string>;

// --- JSONC -------------------------------------------------------------------------------------

/** JSON with comments and trailing commas (VS Code's theme and snippet files). */
export function parseJsonc(text: string): unknown {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"') {
      const start = i;
      i++;
      while (i < text.length && text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
      out += text.slice(start, ++i);
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 2;
    } else if (c === ",") {
      // A trailing comma (before `}` or `]`, outside strings) is dropped.
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j++;
      if (text[j] !== "}" && text[j] !== "]") out += c;
      i++;
    } else {
      out += c;
      i++;
    }
  }
  return JSON.parse(out);
}

// --- Themes ------------------------------------------------------------------------------------

/**
 * TextMate scope (prefix, by segments) → the editor's token. VS Code themes colour TextMate
 * scopes; Yavin's editor colours Monarch and semantic tokens (`editor/monaco.ts`).
 */
const SCOPES: Record<string, string> = {
  comment: "comment",
  string: "string",
  "string.regexp": "regexp",
  "constant.numeric": "number",
  constant: "constant",
  "constant.language": "constant",
  "constant.character": "constant",
  keyword: "keyword",
  "keyword.operator": "operator",
  storage: "keyword",
  "storage.type": "keyword",
  "storage.modifier": "keyword",
  "entity.name.type": "type",
  "entity.name.class": "class",
  "entity.other.inherited-class": "class",
  "support.type": "type",
  "support.class": "class",
  "entity.name.function": "function",
  "support.function": "function",
  "entity.name.namespace": "namespace",
  variable: "variable",
  "variable.parameter": "parameter",
  "variable.other.property": "property",
  "variable.other.object.property": "property",
  "variable.language": "predefined",
  "entity.name.tag": "tag",
  "entity.other.attribute-name": "attribute.name",
  punctuation: "delimiter",
  "meta.decorator": "decorator",
  invalid: "invalid",
};
/** Semantic token types the editor colours (a language server's). */
const SEMANTIC = new Set([
  "function",
  "method",
  "variable",
  "parameter",
  "property",
  "class",
  "interface",
  "enum",
  "struct",
  "type",
  "typeParameter",
  "namespace",
  "enumMember",
  "macro",
  "decorator",
]);
/** Editor colours Yavin applies; the rest of a theme's colours are the workbench's. */
const EDITOR_COLORS =
  /^(editor[A-Za-z]*|minimap[A-Za-z]*|scrollbar|scrollbarSlider|diffEditor|peekView[A-Za-z]*|input|inputOption|list|focusBorder|widget|textLink|textCodeBlock)\./;
const COLOR = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const MAX_INCLUDE_DEPTH = 3;
const MAX_RULES = 2000;

/** `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa` as Monaco's `rrggbb[aa]`, or undefined. */
function color(value: unknown): string | undefined {
  if (typeof value !== "string" || !COLOR.test(value)) return undefined;
  const hex = value.slice(1);
  return hex.length <= 4 ? [...hex].map((c) => c + c).join("") : hex;
}

function fontStyle(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const words = value
    .split(/\s+/)
    .filter((w) => ["italic", "bold", "underline", "strikethrough"].includes(w));
  return words.length ? words.join(" ") : value.trim() === "" ? "" : undefined;
}

/** The token a scope colours, and how specific the match is (0: none). */
function tokenOf(scope: string): [string | null, number] {
  // A descendant selector ("source.js keyword") colours its last scope.
  const last = scope.trim().split(/\s+/).pop() ?? "";
  const parts = last.split(".");
  // Specificity is the theme's scope's own depth (TextMate's rule), whatever key it matched.
  for (let n = parts.length; n > 0; n--) {
    const key = parts.slice(0, n).join(".");
    if (key in SCOPES) return [SCOPES[key], parts.length];
  }
  return [null, 0];
}

/** A theme's JSON (its `include`s already merged) as the editor's rules and colours. */
export function themeFrom(theme: unknown): Pick<ThemeDefinition, "rules" | "colors" | "unmapped"> {
  const raw = (theme && typeof theme === "object" ? theme : {}) as Record<string, unknown>;
  const unmapped: string[] = [];
  const colors: Record<string, string> = {};
  const rawColors =
    raw.colors && typeof raw.colors === "object" ? (raw.colors as Record<string, unknown>) : {};
  for (const [key, value] of Object.entries(rawColors)) {
    const hex = color(value);
    if (EDITOR_COLORS.test(key) && hex) colors[key] = `#${hex}`;
    else unmapped.push(key);
  }
  // The most specific scope per token wins; on a tie, the later rule (TextMate's order).
  const chosen = new Map<string, { rule: ThemeRule; specificity: number }>();
  const tokenColors = Array.isArray(raw.tokenColors) ? raw.tokenColors.slice(0, MAX_RULES) : [];
  if (typeof raw.tokenColors === "string")
    unmapped.push(`tokenColors: ${raw.tokenColors} (a TextMate file)`);
  for (const entry of tokenColors) {
    if (!entry || typeof entry !== "object") continue;
    const { scope, settings } = entry as { scope?: unknown; settings?: Record<string, unknown> };
    if (!settings || typeof settings !== "object") continue;
    const style = {
      foreground: color(settings.foreground),
      background: color(settings.background),
      fontStyle: fontStyle(settings.fontStyle),
    };
    if (!style.foreground && !style.background && style.fontStyle === undefined) continue;
    const scopes =
      scope === undefined
        ? [""]
        : (Array.isArray(scope) ? scope : String(scope).split(","))
            .filter((one): one is string => typeof one === "string")
            .map((one) => one.trim())
            .filter(Boolean);
    for (const one of scopes) {
      const [token, specificity] = one === "" ? ["", 1] : tokenOf(one);
      if (token === null) {
        unmapped.push(one);
        continue;
      }
      const previous = chosen.get(token);
      if (!previous || specificity >= previous.specificity)
        chosen.set(token, {
          specificity,
          rule: Object.fromEntries(
            Object.entries({ token, ...style }).filter(([, value]) => value !== undefined),
          ) as unknown as ThemeRule,
        });
    }
  }
  const semantic =
    raw.semanticTokenColors && typeof raw.semanticTokenColors === "object"
      ? (raw.semanticTokenColors as Record<string, unknown>)
      : {};
  for (const [key, value] of Object.entries(semantic)) {
    const type = key.split(/[.:]/)[0];
    const settings = (typeof value === "string" ? { foreground: value } : value) as Record<
      string,
      unknown
    > | null;
    const foreground = color(settings?.foreground);
    if (!SEMANTIC.has(type) || key !== type || !foreground) {
      unmapped.push(`semanticTokenColors.${key}`);
      continue;
    }
    chosen.set(type, {
      specificity: 99,
      rule: { token: type, foreground, fontStyle: fontStyle(settings?.fontStyle) },
    });
  }
  return {
    rules: [...chosen.values()].map((one) => one.rule),
    colors,
    unmapped: [...new Set(unmapped)].sort(),
  };
}

/** `include` (relative to `from`'s folder) as a path inside the extension, or null. */
function resolveInclude(from: string, include: string): string | null {
  const parts = from.split("/").slice(0, -1);
  for (const part of include.split("/")) {
    if (part === "." || part === "") continue;
    if (part === "..") {
      if (!parts.length) return null;
      parts.pop();
    } else parts.push(part);
  }
  return parts.length ? parts.join("/") : null;
}

/** A theme file and the files it includes, merged (the including file's keys win). */
async function readTheme(
  read: ResourceReader,
  id: string,
  path: string,
  depth = 0,
): Promise<Record<string, unknown>> {
  const theme = parseJsonc(await read(id, path));
  if (!theme || typeof theme !== "object" || Array.isArray(theme))
    throw new Error(`${path} is not a JSON object.`);
  const own = theme as Record<string, unknown>;
  if (typeof own.include !== "string") return own;
  if (depth >= MAX_INCLUDE_DEPTH)
    throw new Error(`${path} includes more than ${MAX_INCLUDE_DEPTH} files deep.`);
  const included = resolveInclude(path, own.include);
  if (!included) throw new Error(`${path} includes "${own.include}", outside the extension.`);
  const base = await readTheme(read, id, included, depth + 1);
  const merge = (key: string) =>
    Array.isArray(base[key]) && Array.isArray(own[key])
      ? [...(base[key] as unknown[]), ...(own[key] as unknown[])]
      : (own[key] ?? base[key]);
  return {
    ...base,
    ...own,
    colors: { ...(base.colors as object), ...(own.colors as object) },
    tokenColors: merge("tokenColors"),
    semanticTokenColors: {
      ...(base.semanticTokenColors as object),
      ...(own.semanticTokenColors as object),
    },
  };
}

// --- Snippets ----------------------------------------------------------------------------------

const MAX_SNIPPETS = 2000;
const MAX_BODY = 20_000;

/** A snippets file as definitions for `language`, with what was left out and why. */
export function snippetsFrom(
  json: unknown,
  extensionId: string,
  language: string,
): { snippets: SnippetDefinition[]; problems: string[] } {
  const problems: string[] = [];
  const snippets: SnippetDefinition[] = [];
  if (!json || typeof json !== "object" || Array.isArray(json))
    return { snippets, problems: ["The snippets file is not a JSON object."] };
  for (const [name, raw] of Object.entries(json as Record<string, unknown>).slice(
    0,
    MAX_SNIPPETS,
  )) {
    const snippet = raw as { prefix?: unknown; body?: unknown; description?: unknown } | null;
    const prefixes = (Array.isArray(snippet?.prefix) ? snippet.prefix : [snippet?.prefix]).filter(
      (one): one is string => typeof one === "string" && one.trim().length > 0 && one.length <= 100,
    );
    const lines = Array.isArray(snippet?.body) ? snippet.body : [snippet?.body];
    const body = lines.every((line) => typeof line === "string") ? lines.join("\n") : null;
    if (!prefixes.length || body === null || body.length === 0 || body.length > MAX_BODY) {
      problems.push(`Snippet "${name.slice(0, 80)}" has no prefix or no usable body.`);
      continue;
    }
    const description =
      typeof snippet?.description === "string" ? snippet.description.slice(0, 500) : null;
    for (const prefix of prefixes.slice(0, 10))
      snippets.push({ extensionId, language, name: name.slice(0, 100), prefix, body, description });
  }
  return { snippets, problems };
}

// --- The store ---------------------------------------------------------------------------------

// What is applied: every theme and snippet file of every enabled copy (`copy`: EXT-08) -- an
// update keeping the same paths is another key, so it is read again.
const keyOf = (snapshot: RegistrySnapshot) => JSON.stringify([snapshot.themes, snapshot.snippets]);

export function createDeclarativeContributions(options: {
  registry: ExtensionRegistry;
  read: ResourceReader;
}) {
  const listeners = new Set<() => void>();
  let snapshot: DeclarativeSnapshot = { themes: [], snippets: [], problems: {}, loading: false };
  let applied = "";
  let sequence = 0;
  /**
   * Files read, by copy and path (EXT-08): a change elsewhere reads only what changed; a copy
   * that is gone (updated, rolled back, uninstalled) is forgotten after the next load.
   */
  let files = new Map<string, Promise<string>>();
  const publish = (next: DeclarativeSnapshot) => {
    snapshot = next;
    for (const listener of [...listeners])
      try {
        listener();
      } catch {
        /* One listener's failure is not the others'. */
      }
  };

  async function load(registry: RegistrySnapshot, mine: number) {
    const used = new Map<string, Promise<string>>();
    const failed = new Set<string>();
    const readerOf =
      (copy: string): ResourceReader =>
      (id, path) => {
        const key = `${copy}\n${path}`;
        let text = used.get(key) ?? files.get(key);
        if (!text) {
          text = options.read(id, path);
          // A failed read is not kept: tried again next time.
          text.catch(() => failed.add(key));
        }
        used.set(key, text);
        return text;
      };
    const problems: Record<string, string[]> = {};
    const problem = (id: string, text: string) => (problems[id] ??= []).push(text);
    const labels = new Map<string, number>();
    for (const theme of registry.themes)
      labels.set(theme.label, (labels.get(theme.label) ?? 0) + 1);
    const index = new Map<string, number>();
    const themes = await Promise.all(
      registry.themes.map(async (theme): Promise<ThemeDefinition | null> => {
        const n = index.get(theme.extensionId) ?? 0;
        index.set(theme.extensionId, n + 1);
        try {
          const mapped = themeFrom(
            await readTheme(readerOf(theme.copy), theme.extensionId, theme.path),
          );
          if (mapped.unmapped.length)
            problem(
              theme.extensionId,
              `Theme "${theme.label}": ${mapped.unmapped.length} colours or scopes are not applied (${mapped.unmapped.slice(0, 8).join(", ")}${mapped.unmapped.length > 8 ? ", …" : ""}).`,
            );
          return {
            id: `ext:${theme.extensionId}:${n}`,
            // Two extensions' themes of one name are told apart by their extension.
            label:
              (labels.get(theme.label) ?? 0) > 1
                ? `${theme.label} (${theme.extensionId})`
                : theme.label,
            extensionId: theme.extensionId,
            base: theme.uiTheme,
            ...mapped,
          };
        } catch (error) {
          problem(
            theme.extensionId,
            `Theme "${theme.label}" could not be read: ${(error as Error).message}`,
          );
          return null;
        }
      }),
    );
    const snippets = await Promise.all(
      registry.snippets.map(async (entry) => {
        try {
          const found = snippetsFrom(
            parseJsonc(await readerOf(entry.copy)(entry.extensionId, entry.path)),
            entry.extensionId,
            entry.language,
          );
          for (const one of found.problems) problem(entry.extensionId, `${entry.path}: ${one}`);
          return found.snippets;
        } catch (error) {
          problem(
            entry.extensionId,
            `${entry.path} could not be read: ${(error as Error).message}`,
          );
          return [];
        }
      }),
    );
    if (mine !== sequence) return; // a newer registry state is loading
    files = new Map([...used].filter(([key]) => !failed.has(key)));
    publish({
      themes: themes.filter((one): one is ThemeDefinition => one !== null),
      snippets: snippets.flat(),
      problems,
      loading: false,
    });
  }

  const follow = () => {
    const registry = options.registry.getSnapshot();
    const key = keyOf(registry);
    if (key === applied) return;
    applied = key;
    const mine = ++sequence;
    publish({ ...snapshot, loading: true });
    void load(registry, mine);
  };
  const unsubscribe = options.registry.subscribe(follow);
  follow();

  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose: unsubscribe,
  };
}

export type DeclarativeContributions = ReturnType<typeof createDeclarativeContributions>;
