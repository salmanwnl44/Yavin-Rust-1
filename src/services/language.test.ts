import assert from "node:assert/strict";
import test from "node:test";
import {
  languageFor,
  languageLabel,
  setContributedLanguages,
  type ContributedLanguage,
} from "./language.ts";

test("extensions map to their VS Code language id", () => {
  const cases: [string, string][] = [
    ["a.ts", "typescript"],
    ["a.mts", "typescript"],
    ["a.cts", "typescript"],
    ["a.tsx", "typescriptreact"],
    ["a.js", "javascript"],
    ["a.jsx", "javascriptreact"],
    ["a.rs", "rust"],
    ["a.py", "python"],
    ["a.go", "go"],
    ["a.json", "json"],
    ["a.jsonc", "jsonc"],
    ["a.md", "markdown"],
    ["a.css", "css"],
    ["a.scss", "scss"],
    ["a.html", "html"],
    ["a.htm", "html"],
    ["a.svg", "xml"],
    ["a.yaml", "yaml"],
    ["a.yml", "yaml"],
    ["a.toml", "toml"],
    ["a.sh", "shellscript"],
    ["a.ps1", "powershell"],
    ["a.cpp", "cpp"],
    ["a.c++", "cpp"],
    ["a.cs", "csharp"],
    ["a.txt", "plaintext"],
  ];
  for (const [name, id] of cases) assert.equal(languageFor(name), id, name);
});

test("a path is reduced to its file name, with either separator", () => {
  assert.equal(languageFor("/home/user/project/main.rs"), "rust");
  assert.equal(languageFor("C:\\Users\\me\\app\\index.ts"), "typescript");
  assert.equal(languageFor("deep/nested/dir/config.yaml"), "yaml");
});

test("detection is case-insensitive", () => {
  assert.equal(languageFor("README.MD"), "markdown");
  assert.equal(languageFor("Main.RS"), "rust");
  assert.equal(languageFor("DOCKERFILE"), "dockerfile");
});

test("special whole-name files are recognized without an extension", () => {
  assert.equal(languageFor("Dockerfile"), "dockerfile");
  assert.equal(languageFor("Makefile"), "makefile");
  assert.equal(languageFor("Cargo.lock"), "toml");
  assert.equal(languageFor(".gitignore"), "ignore");
  assert.equal(languageFor(".gitattributes"), "properties");
  assert.equal(languageFor(".editorconfig"), "properties");
  assert.equal(languageFor(".env"), "dotenv");
  assert.equal(languageFor(".bashrc"), "shellscript");
});

test("dotenv and Dockerfile variants are detected", () => {
  assert.equal(languageFor(".env.local"), "dotenv");
  assert.equal(languageFor(".env.production"), "dotenv");
  assert.equal(languageFor("Dockerfile.dev"), "dockerfile");
});

test("unknown names and hidden extensionless files fall back to plaintext", () => {
  assert.equal(languageFor("mystery.qwerty"), "plaintext");
  assert.equal(languageFor("noextension"), "plaintext");
  assert.equal(languageFor(".hiddenfile"), "plaintext"); // leading dot is a name, not an extension
});

test("labels follow VS Code's names; an unknown id is its own label", () => {
  assert.equal(languageLabel("typescript"), "TypeScript");
  assert.equal(languageLabel("cpp"), "C++");
  assert.equal(languageLabel("csharp"), "C#");
  assert.equal(languageLabel("totally-made-up"), "totally-made-up");
});

test("contributed languages add extensions and filenames but never override Yavin's own", () => {
  const contributed: ContributedLanguage[] = [
    { id: "lua", extensions: [".lua"], filenames: [".luacheckrc"], aliases: ["Lua"] },
    // Tries to claim .ts and Dockerfile — must NOT win over the builtin mappings.
    { id: "evil", extensions: [".ts"], filenames: ["Dockerfile"], aliases: ["Evil"] },
    // Longest extension must win: .blade.php before .php.
    { id: "php", extensions: [".php"], filenames: [], aliases: ["PHP"] },
    { id: "blade", extensions: [".blade.php"], filenames: [], aliases: ["Blade"] },
  ];
  setContributedLanguages(contributed);
  try {
    assert.equal(languageFor("init.lua"), "lua", "contributed extension");
    assert.equal(languageFor(".luacheckrc"), "lua", "contributed filename");
    assert.equal(languageLabel("lua"), "Lua", "contributed label");
    assert.equal(languageFor("app.ts"), "typescript", "builtin wins over contributed .ts");
    assert.equal(languageFor("Dockerfile"), "dockerfile", "builtin wins over contributed filename");
    assert.equal(languageFor("view.blade.php"), "blade", "longest contributed extension wins");
    assert.equal(languageFor("plain.php"), "php");
  } finally {
    setContributedLanguages([]); // reset module state so other tests are unaffected
  }
  assert.equal(languageFor("init.lua"), "plaintext", "contributed languages cleared");
});
