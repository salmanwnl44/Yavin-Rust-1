/**
 * Which language server serves which language, and how it is configured.
 *
 * ```text
 * file name --language.ts--> language id --here--> server id --lsp.rs--> program + arguments
 * ```
 *
 * The program each id runs is fixed natively (`src-tauri/src/lsp.rs`) and cannot be named from
 * here: this side decides only which server a language uses and what to tell it (settings,
 * initialization options, timeouts). A language may list several servers; the first one that is
 * installed is used. Adding a server is an entry here and one in `lsp.rs` (a test there checks
 * every native server has one here).
 */

export interface LanguageServerDefinition {
  /** The id `lsp.rs` knows the server by. */
  id: string;
  /** Shown in the status bar and messages. */
  label: string;
  /** Yavin language ids (`language.ts`) this server handles. */
  languages: readonly string[];
  /** Sent in `initialize`. */
  initializationOptions?: unknown;
  /**
   * The settings the server reads through `workspace/configuration`, by section: a request
   * for `python.analysis` finds `settings.python.analysis`.
   */
  settings?: Record<string, unknown>;
  /** Milliseconds for start-up (spawn to `initialize` answered). */
  startupTimeout: number;
  /** Milliseconds for an ordinary request. */
  requestTimeout: number;
  /**
   * Whether the server works on documents with no file (`untitled:`). Most expect a file on
   * disk in the project, so this is off unless a server is known to handle it.
   */
  untitled: boolean;
}

const defaults = { startupTimeout: 30_000, requestTimeout: 10_000, untitled: false };

export const LANGUAGE_SERVERS: readonly LanguageServerDefinition[] = [
  {
    id: "typescript",
    label: "TypeScript",
    languages: ["typescript", "typescriptreact", "javascript", "javascriptreact"],
    initializationOptions: { preferences: { includeInlayParameterNameHints: "literals" } },
    ...defaults,
    untitled: true,
  },
  {
    id: "pyright",
    label: "Pyright",
    languages: ["python"],
    settings: { python: { analysis: { typeCheckingMode: "basic" } } },
    ...defaults,
  },
  { id: "pylsp", label: "Python LSP", languages: ["python"], ...defaults },
  // rust-analyzer indexes the whole crate graph before it answers anything.
  {
    id: "rust-analyzer",
    label: "rust-analyzer",
    languages: ["rust"],
    ...defaults,
    startupTimeout: 120_000,
  },
  { id: "gopls", label: "gopls", languages: ["go"], ...defaults },
  { id: "clangd", label: "clangd", languages: ["c", "cpp"], ...defaults },
  { id: "json", label: "JSON", languages: ["json", "jsonc"], ...defaults },
  { id: "css", label: "CSS", languages: ["css", "scss", "less"], ...defaults },
  { id: "html", label: "HTML", languages: ["html"], ...defaults },
  { id: "yaml", label: "YAML", languages: ["yaml"], ...defaults },
  { id: "bash", label: "Bash", languages: ["shellscript"], ...defaults },
];

/** The servers that could serve `languageId`, in order of preference. */
export function serversFor(languageId: string): LanguageServerDefinition[] {
  return LANGUAGE_SERVERS.filter((server) => server.languages.includes(languageId));
}

/** Every language some server serves. */
export function servedLanguages(): string[] {
  return [...new Set(LANGUAGE_SERVERS.flatMap((server) => server.languages))];
}

/** A server's setting at `section` (dotted), for `workspace/configuration`; null when unset. */
export function settingAt(server: LanguageServerDefinition, section: string | undefined): unknown {
  if (!section) return server.settings ?? null;
  let value: unknown = server.settings;
  for (const key of section.split(".")) {
    if (!value || typeof value !== "object") return null;
    value = (value as Record<string, unknown>)[key];
  }
  return value ?? null;
}
