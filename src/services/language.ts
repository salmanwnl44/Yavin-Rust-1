/**
 * Which language a document is written in, from its name alone.
 *
 * The id is what the editor, syntax highlighting, language servers and the index will key
 * on later; the label is what the status bar shows. Ids follow VS Code's, so that a language
 * server or grammar built for it needs no translation table.
 */

const BY_EXTENSION: Record<string, string> = {
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "typescriptreact",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "javascriptreact",
  rs: "rust",
  json: "json",
  jsonc: "jsonc",
  md: "markdown",
  markdown: "markdown",
  mdx: "mdx",
  css: "css",
  scss: "scss",
  less: "less",
  html: "html",
  htm: "html",
  xml: "xml",
  svg: "xml",
  py: "python",
  toml: "toml",
  yaml: "yaml",
  yml: "yaml",
  sh: "shellscript",
  bash: "shellscript",
  zsh: "shellscript",
  ps1: "powershell",
  bat: "bat",
  cmd: "bat",
  go: "go",
  java: "java",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  "c++": "cpp",
  hpp: "cpp",
  hh: "cpp",
  hxx: "cpp",
  "h++": "cpp",
  cs: "csharp",
  sql: "sql",
  ini: "ini",
  cfg: "ini",
  conf: "ini",
  dockerfile: "dockerfile",
  txt: "plaintext",
};

/** Names that say what they are without an extension, compared case-insensitively. */
const BY_NAME: Record<string, string> = {
  dockerfile: "dockerfile",
  makefile: "makefile",
  "cargo.lock": "toml",
  ".gitignore": "ignore",
  ".gitattributes": "properties",
  ".editorconfig": "properties",
  ".env": "dotenv",
  ".bashrc": "shellscript",
  ".bash_profile": "shellscript",
  ".zshrc": "shellscript",
  ".profile": "shellscript",
};

const LABELS: Record<string, string> = {
  typescript: "TypeScript",
  typescriptreact: "TypeScript React",
  javascript: "JavaScript",
  javascriptreact: "JavaScript React",
  rust: "Rust",
  json: "JSON",
  jsonc: "JSON with Comments",
  markdown: "Markdown",
  mdx: "MDX",
  css: "CSS",
  scss: "SCSS",
  less: "Less",
  html: "HTML",
  xml: "XML",
  python: "Python",
  toml: "TOML",
  yaml: "YAML",
  shellscript: "Shell Script",
  powershell: "PowerShell",
  bat: "Batch",
  go: "Go",
  java: "Java",
  c: "C",
  cpp: "C++",
  csharp: "C#",
  sql: "SQL",
  dockerfile: "Dockerfile",
  makefile: "Makefile",
  ignore: "Ignore",
  properties: "Properties",
  ini: "Ini",
  dotenv: "Environment Variables",
  plaintext: "Plain Text",
};

/**
 * Languages extensions contribute (EXT-25): their file extensions and names, for files Yavin
 * does not know itself -- an extension adds languages; it never changes one of Yavin's own.
 */
let contributedNames = new Map<string, string>();
let contributedExtensions: [string, string][] = [];
let contributedLabels = new Map<string, string>();

export interface ContributedLanguage {
  id: string;
  extensions: readonly string[];
  filenames: readonly string[];
  aliases: readonly string[];
}

/** Sets the contributed languages (in the order the first claim of a name or extension wins). */
export function setContributedLanguages(languages: readonly ContributedLanguage[]): void {
  const names = new Map<string, string>();
  const extensions = new Map<string, string>();
  const labels = new Map<string, string>();
  for (const language of languages) {
    for (const name of language.filenames)
      if (!names.has(name.toLowerCase())) names.set(name.toLowerCase(), language.id);
    for (const extension of language.extensions)
      if (!extensions.has(extension.toLowerCase()))
        extensions.set(extension.toLowerCase(), language.id);
    if (language.aliases[0] && !labels.has(language.id))
      labels.set(language.id, language.aliases[0]);
  }
  contributedNames = names;
  // Longest first: `.blade.php` before `.php`.
  contributedExtensions = [...extensions].sort((a, b) => b[0].length - a[0].length);
  contributedLabels = labels;
}

/** The language of a file called `name` (a path works too); `plaintext` when unknown. */
export function languageFor(name: string): string {
  const own = builtinLanguageFor(name);
  if (own !== "plaintext") return own;
  const base = name
    .slice(Math.max(name.lastIndexOf("/"), name.lastIndexOf("\\")) + 1)
    .toLowerCase();
  if (base.endsWith(".txt")) return own;
  const named = contributedNames.get(base);
  if (named) return named;
  for (const [extension, id] of contributedExtensions)
    if (base.endsWith(extension) && base.length > extension.length) return id;
  return own;
}

function builtinLanguageFor(name: string): string {
  const base = name.slice(Math.max(name.lastIndexOf("/"), name.lastIndexOf("\\")) + 1);
  const lower = base.toLowerCase();
  const named = BY_NAME[lower];
  if (named) return named;
  // `.env.local`, `.env.production`: variants of `.env`; `Dockerfile.dev`: of a Dockerfile.
  if (lower.startsWith(".env.")) return "dotenv";
  if (lower.startsWith("dockerfile.")) return "dockerfile";
  const dot = lower.lastIndexOf(".");
  // A leading dot is a hidden file's name, not an extension.
  if (dot <= 0) return "plaintext";
  return BY_EXTENSION[lower.slice(dot + 1)] ?? "plaintext";
}

/** What the status bar calls a language id. */
export const languageLabel = (id: string): string => LABELS[id] ?? contributedLabels.get(id) ?? id;
