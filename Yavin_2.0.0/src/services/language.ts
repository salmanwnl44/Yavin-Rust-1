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
  ps1: "powershell",
  go: "go",
  java: "java",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  hpp: "cpp",
  cs: "csharp",
  sql: "sql",
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
  plaintext: "Plain Text",
};

/** The language of a file called `name` (a path works too); `plaintext` when unknown. */
export function languageFor(name: string): string {
  const base = name.slice(Math.max(name.lastIndexOf("/"), name.lastIndexOf("\\")) + 1);
  const lower = base.toLowerCase();
  const named = BY_NAME[lower];
  if (named) return named;
  const dot = lower.lastIndexOf(".");
  // A leading dot is a hidden file's name, not an extension.
  if (dot <= 0) return "plaintext";
  return BY_EXTENSION[lower.slice(dot + 1)] ?? "plaintext";
}

/** What the status bar calls a language id. */
export const languageLabel = (id: string): string => LABELS[id] ?? id;
