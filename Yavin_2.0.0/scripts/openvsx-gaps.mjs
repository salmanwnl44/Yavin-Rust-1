#!/usr/bin/env node
/**
 * The Open VSX gap analysis (EXT-26): for every benchmark extension, what its main advertised
 * feature needs and why it fails or is limited -- by root cause, not by symptom -- and what each
 * roadmap phase could unlock.
 *
 *   node scripts/openvsx-gaps.mjs [--results benchmark/openvsx/ext26/results.json] [--write benchmark/openvsx/ext26]
 *
 * Evidence, per extension:
 * - **measured** (the benchmark's records): install, load, activation, the first failure, the
 *   unsupported APIs it reached, its commands;
 * - **static** (a text scan of its entry point): the VS Code APIs and Node.js modules it names;
 * - **judged** (the table below): what its main feature needs, with the reason, from its
 *   manifest and what it is documented to do. Each judgement names its evidence.
 *
 * "Unlocks" are estimates: an extension counts for a phase when every blocker it has -- the
 * measured one and the statically named ones -- is in that phase or an earlier one. A blocker
 * behind the first failure can be missed by a text scan of a minified bundle; the counts are an
 * upper bound for activation and say nothing of quality.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = Object.fromEntries(
  process.argv
    .slice(2)
    .reduce(
      (pairs, arg, i, all) =>
        arg.startsWith("--") ? [...pairs, [arg.slice(2), all[i + 1]]] : pairs,
      [],
    ),
);
const results = JSON.parse(
  readFileSync(join(root, args.results ?? "benchmark/openvsx/ext26/results.json"), "utf8"),
).results;
const inventory = JSON.parse(
  readFileSync(join(root, "src/services/extensions/vscodeApi.json"), "utf8"),
);
const unsupported = new Set(
  inventory.api.filter((a) => a.status === "UNSUPPORTED").map((a) => a.api),
);

/** Root-cause classes. */
const CAUSES = {
  process:
    "Starts a process: a language server, formatter, linter, git, a debug adapter or a test runner (child_process, or a bundled or downloaded binary)",
  worker:
    "Runs part of itself in a worker or a separate JavaScript runtime (a language server in Node.js IPC or a Web Worker)",
  webview: "Needs webviews or custom editors (an HTML surface of its own)",
  syncfs:
    "Reads or writes the system through Node.js fs/os directly (often synchronously, often at load)",
  globals:
    "Needs a JavaScript global QuickJS lacks: Node's process.versions (Intl, URL and crypto are provided since EXT-28)",
  coreapi:
    "Needs a VS Code API that can run in the sandbox but is not implemented (pickers, providers, watchers, diagnostics, storage, decorations with colours)",
  policy:
    "Refused by a package limit: more than 1000 entries, over 20 MiB, a file over 16 MiB, or package.json over 1 MiB",
  icontheme: "Contributes an icon theme (not supported)",
  esm: "Is an ES module (not supported)",
  platform:
    "Needs a VS Code subsystem Yavin lacks for extensions: debug, testing, source control, terminals or tasks",
};

/** The roadmap's phases, in order; a cause or an API belongs to the first phase that removes it. */
const PHASES = [
  { id: "P0", title: "Evidence and correctness of what exists" },
  {
    id: "P1",
    title: "Runtime globals: URL, Intl (subset), crypto.getRandomValues (done at EXT-28)",
  },
  {
    id: "P2",
    title: "Core in-sandbox APIs: pickers, providers, diagnostics, watchers, storage, decorations",
  },
  { id: "P3", title: "Package policy for VS Code packages; icon themes" },
  { id: "P4", title: "Webviews and custom editors (an isolated, CSP-locked surface)" },
  {
    id: "P5",
    title: "Workers: a second sandboxed QuickJS runtime for in-package language servers",
  },
  { id: "P6", title: "A brokered process capability: language servers, formatters, linters, git" },
  { id: "P7", title: "Debug, testing and source-control APIs" },
];
const PHASE_OF_CAUSE = {
  globals: "P1",
  coreapi: "P2",
  syncfs: "P2",
  policy: "P3",
  icontheme: "P3",
  webview: "P4",
  worker: "P5",
  process: "P6",
  platform: "P7",
  esm: "P2",
};
/** An unsupported API's phase, from its namespace and name. */
function phaseOfApi(api) {
  if (
    /^window\.(createWebviewPanel|registerWebviewPanelSerializer|registerWebviewViewProvider|registerCustomEditorProvider)/.test(
      api,
    )
  )
    return "P4";
  if (
    /^(debug|tests|scm|tasks|notebooks|comments)\./.test(api) ||
    /^window\.(createTerminal|terminals|registerTerminal)/.test(api) ||
    /^workspace\.registerTaskProvider/.test(api)
  )
    return "P7";
  if (/^(authentication|chat|lm)\./.test(api)) return "P7";
  return "P2";
}

/**
 * What each extension's main advertised feature is, and what it needs (judged). `works`: Yes,
 * Partly, No -- for the main feature only. `causes`: what stands between it and working.
 */
const JUDGED = {
  "dracula-theme.theme-dracula": [
    "Colour theme",
    "Yes",
    [],
    "Its theme files apply (declarative check).",
  ],
  "zhuangtongfa.material-theme": [
    "Colour theme (One Dark Pro)",
    "Yes",
    [],
    "Themes apply; its commands ran 7/7; its settings writer needs WorkspaceConfiguration.update.",
  ],
  "github.github-vscode-theme": ["Colour theme", "Yes", [], "Themes apply."],
  "jdinhlife.gruvbox": ["Colour theme", "Yes", [], "Themes apply."],
  "pkief.material-icon-theme": [
    "File icon theme",
    "Yes",
    [],
    "Installs since EXT-30 (1278 entries); its theme applies: 1251 SVG icons, all drawn, 8188 names, the light variant (its high-contrast variant is not). Its 11 commands (customisation) do not run.",
  ],
  "vscode-icons-team.vscode-icons": [
    "File icon theme",
    "Yes",
    [],
    "Installs since EXT-30 (1695 entries); its theme applies: 1504 SVG icons, all drawn, 3009 names. Its 13 commands (customisation) do not run.",
  ],
  "catppuccin.catppuccin-vsc": ["Colour theme", "Yes", [], "Themes apply; its code activates."],
  "scala-lang.scala": [
    "Scala grammar",
    "Yes",
    [],
    "Grammar loads and tokenizes (engine-level; the window's grammar path has no UI test).",
  ],
  "mathiasfrohlich.kotlin": [
    "Kotlin grammar and snippets",
    "Yes",
    [],
    "Grammar tokenizes Kotlin correctly; its Markdown injection is not applied.",
  ],
  "slevesque.shader": [
    "Shader grammars and snippets",
    "Yes",
    [],
    "Installs since EXT-30 (2599 entries): its three languages and two grammars apply; its code is more than Yavin loads (2000 files or 24 MiB), so its commands do not run.",
  ],
  "bungcip.better-toml": [
    "TOML grammar",
    "Yes",
    [],
    "Grammar applies; its code activates since EXT-29 (file watchers); its validation is a language server it starts over net.createServer.",
  ],
  "jeff-hykin.better-cpp-syntax": ["C++ grammar", "Yes", [], "Grammar tokenizes."],
  "13xforever.language-x86-64-assembly": ["Assembly grammar", "Yes", [], "Grammar tokenizes."],
  "mrmlnc.vscode-apache": ["Apache config grammar and configuration", "Yes", [], "Applies."],
  "coolbear.systemd-unit-file": ["systemd grammar and configuration", "Yes", [], "Applies."],
  "nwolverson.language-purescript": [
    "PureScript grammar and configuration",
    "Yes",
    [],
    "Grammar applies; one snippets file is unreadable; its injection grammar is not applied.",
  ],
  "tamasfe.even-better-toml": [
    "TOML language server (taplo, WebAssembly)",
    "No",
    ["worker"],
    "Installs since EXT-30 (21.0 MiB); its server is WebAssembly in a worker (activation: Worker is not defined).",
  ],
  "esbenp.prettier-vscode": [
    "Formatting with Prettier",
    "No",
    ["coreapi"],
    "Its web entry runs Prettier in JavaScript; needs createLanguageStatusItem, then formatting providers and reading configuration files.",
  ],
  "foxundermoon.shell-format": [
    "Formatting shell scripts (shfmt)",
    "No",
    ["process", "syncfs"],
    "Runs the shfmt binary; reads files with fs at load.",
  ],
  "ms-python.black-formatter": [
    "Formatting Python (Black)",
    "No",
    ["process"],
    "A Python language server process.",
  ],
  "xaver.clang-format": [
    "Formatting C/C++ (clang-format)",
    "No",
    ["process", "coreapi"],
    "Runs the clang-format binary through formatting providers.",
  ],
  "dbaeumer.vscode-eslint": [
    "Linting with ESLint",
    "No",
    ["worker", "process"],
    "Activates and 5/6 commands run, but linting is its language server, a Node.js process.",
  ],
  "streetsidesoftware.code-spell-checker": [
    "Spell checking",
    "No",
    ["coreapi", "worker"],
    "Loads since EXT-28 (URL); activation needs ExtensionContext.globalStorageUri; its checker runs as a language server in a separate runtime.",
  ],
  "timonwong.shellcheck": [
    "Linting shell scripts (shellcheck)",
    "No",
    ["process", "coreapi"],
    "Runs the shellcheck binary; activation passes code actions since EXT-29 and stops at registerDocumentLinkProvider.",
  ],
  "davidanson.vscode-markdownlint": [
    "Linting Markdown",
    "No",
    ["coreapi"],
    "Loads since EXT-28 (Intl.Segmenter); since EXT-29 activation passes selection events and stops at vscode.CustomExecution (tasks). The library runs in-process.",
  ],
  "charliermarsh.ruff": [
    "Linting Python (ruff)",
    "No",
    ["process"],
    "Installs since EXT-30 as its win32-x64 package (Open VSX answered with alpine-arm64); its linter is ruff.exe, a process; activation reads files with Node.js fs.",
  ],
  "redhat.vscode-yaml": [
    "YAML language support",
    "No",
    ["worker"],
    "Loads and activates since EXT-28 (crypto, navigator, Intl.DateTimeFormat); its grammar-less features are a language server (a worker in its web build).",
  ],
  "rust-lang.rust-analyzer": [
    "Rust language server",
    "No",
    ["process", "coreapi"],
    "The rust-analyzer binary; snippets and configuration apply.",
  ],
  "golang.go": [
    "Go language support (gopls)",
    "No",
    ["process", "coreapi"],
    "Loads since EXT-28 (Intl.Collator); activation needs environmentVariableCollection; gopls and the go tools are processes.",
  ],
  "llvm-vs-code-extensions.vscode-clangd": [
    "C/C++ language server",
    "No",
    ["process"],
    "The clangd binary.",
  ],
  "sumneko.lua": [
    "Lua language server",
    "No",
    ["process"],
    "Installs since EXT-30 as its win32-x64 package (2732 entries; Open VSX answered with darwin-arm64); its server is a bundled binary; loading its code runs out of the host's memory.",
  ],
  "christian-kohler.path-intellisense": [
    "File path completion",
    "No",
    ["coreapi"],
    "A language-less selector, then reading directories (workspace.fs.readDirectory).",
  ],
  "christian-kohler.npm-intellisense": [
    "npm module completion",
    "Partly",
    ["coreapi"],
    "Activates; its command runs since EXT-29 (Yavin's picker), but its items come from reading package.json (Node.js fs).",
  ],
  "zignd.html-css-class-completion": [
    "CSS class completion in HTML",
    "No",
    ["coreapi"],
    "Installs since EXT-30 (1790 entries); its code fails to load (a class constructor called without new); then needs findFiles.",
  ],
  "formulahendry.auto-rename-tag": [
    "Renaming paired HTML tags",
    "No",
    ["syncfs"],
    "A bundled library calls fs.lstat at load.",
  ],
  "tyriar.sort-lines": [
    "Sorting lines",
    "Yes",
    [],
    "14/14 commands edit the document (the natural sort since EXT-28, through Intl.Collator).",
  ],
  "wmaurer.change-case": [
    "Changing case",
    "Yes",
    [],
    "17/17 commands run since EXT-29: 16 edit; the one that picks asks Yavin's picker (the benchmark's stand-in window cancels it; the picker is tested in the window).",
  ],
  "alefragnani.bookmarks": [
    "Bookmarks with gutter icons",
    "No",
    ["webview", "coreapi"],
    "Opens a webview at activation; gutter icons and selection events.",
  ],
  "vscodevim.vim": [
    "Vim emulation",
    "No",
    ["coreapi"],
    "Activates, 0/3 commands; since EXT-29 it passes selection events and stops at onDidChangeTextEditorVisibleRanges; needs the type command and cursor styles.",
  ],
  "stkb.rewrap": [
    "Rewrapping comments",
    "No",
    ["coreapi"],
    "Activates; since EXT-29 rewrapCommentAt runs (showInputBox, cancelled by the stand-in window); Rewrap Comment fails on an undefined thenable and the auto-wrap toggle on configuration inspect.",
  ],
  "gruntfuggly.todo-tree": [
    "TODO tree",
    "No",
    ["coreapi", "process"],
    "A text document content provider; it searches with ripgrep (a process).",
  ],
  "alefragnani.project-manager": [
    "Project list",
    "No",
    ["syncfs", "coreapi"],
    "os.homedir and its own storage folder.",
  ],
  "sleistner.vscode-fileutils": [
    "File operations",
    "No",
    ["globals", "syncfs"],
    "Reads process.versions.node; writes files with fs.",
  ],
  "eamodio.gitlens": [
    "Git insights",
    "No",
    ["policy", "process", "webview"],
    "package.json over 1 MiB; git; webviews.",
  ],
  "mhutchie.git-graph": [
    "Git graph",
    "No",
    ["coreapi", "process", "webview"],
    "Its storage folder; git; a webview.",
  ],
  "donjayamanne.githistory": [
    "Git history",
    "No",
    ["globals", "process", "webview"],
    "process.versions.node; git; a webview.",
  ],
  "waderyan.gitblame": ["Git blame", "No", ["esm", "process"], "An ES module; git."],
  "hbenl.vscode-test-explorer": [
    "Test explorer",
    "No",
    ["coreapi", "process"],
    "Code lens; test adapters start processes.",
  ],
  "vitest.explorer": ["Vitest", "No", ["platform", "process"], "The testing API; runs vitest."],
  "orta.vscode-jest": ["Jest", "No", ["syncfs", "process", "platform"], "process.cwd; runs jest."],
  "vadimcn.vscode-lldb": [
    "Debugging with LLDB",
    "No",
    ["platform", "process"],
    "Debug API; a debug adapter.",
  ],
  "ms-python.debugpy": ["Debugging Python", "No", ["platform", "process"], "Debug API; Python."],
  "firefox-devtools.vscode-firefox-debug": [
    "Debugging in Firefox",
    "No",
    ["platform", "process"],
    "Debug API; launches Firefox.",
  ],
  "hediet.vscode-drawio": [
    "Draw.io editor",
    "No",
    ["policy", "webview"],
    "Over 20 MiB; a custom editor.",
  ],
  "tomoki1207.pdf": ["PDF viewer", "No", ["webview"], "A custom editor."],
  "jock.svg": [
    "SVG preview and editing",
    "Partly",
    ["coreapi", "webview"],
    "Its grammar and snippets apply; activates since EXT-29 (file watchers): minify and copy-data-URI run (3/6 commands); preview is a webview.",
  ],
  "shd101wyy.markdown-preview-enhanced": [
    "Markdown preview",
    "No",
    ["policy", "webview"],
    "Over 20 MiB; a webview.",
  ],
  "editorconfig.editorconfig": [
    "Applying .editorconfig",
    "No",
    ["syncfs"],
    "fs.readFileSync at load.",
  ],
  "usernamehw.errorlens": [
    "Inline diagnostics",
    "No",
    ["coreapi"],
    "getDiagnostics; decorations with text after the line.",
  ],
  "oderwat.indent-rainbow": [
    "Coloured indentation",
    "No",
    ["coreapi"],
    "Installs since EXT-30 (1233 entries) and activates with no unsupported API reached; its coloured decorations are not verified in the window.",
  ],
  "yzhang.markdown-all-in-one": [
    "Markdown editing helpers",
    "No",
    ["syncfs"],
    "fs.readdirSync at load.",
  ],
  "naumovs.color-highlight": [
    "Highlighting colour values",
    "Partly",
    ["coreapi"],
    "Activates; decorations are shown, but in Yavin's fixed style, not the colour.",
  ],
  "aaron-bond.better-comments": [
    "Coloured comment annotations",
    "Partly",
    ["coreapi"],
    "Activates; decorations in the fixed style, not its colours.",
  ],
  "mechatroner.rainbow-csv": [
    "Coloured CSV columns",
    "Partly",
    ["coreapi"],
    "Its grammar applies; its semantic-token provider is unsupported.",
  ],
};

const rows = results.map((r) => {
  const judged = JUDGED[r.id];
  if (!judged) throw new Error(`no judgement for ${r.id}`);
  const [feature, works, causes, why] = judged;
  const act = r.activation;
  const first = !act
    ? null
    : !act.load?.ok
      ? act.load?.error?.message
      : !act.activate?.ok
        ? act.activate?.error?.message
        : null;
  const reached = (act?.unsupported ?? []).map((u) =>
    u.replace(/^UnsupportedApi: /, "").replace(/ is not supported by Yavin.*$/, ""),
  );
  const named = (r.scan?.apis ?? []).filter((a) => unsupported.has(a));
  const apiPhases = [
    ...new Set([...named, ...reached.filter((a) => /^[a-z]+\.[A-Za-z]+$/.test(a))].map(phaseOfApi)),
  ];
  const causePhases = causes.map((c) => PHASE_OF_CAUSE[c]);
  const needed = [...new Set([...apiPhases, ...causePhases])].sort();
  return {
    id: r.id,
    category: r.category,
    install: r.install.after.ok ? "yes" : `no (${r.install.after.stage})`,
    activation: !r.vsix?.runtime
      ? r.requirements?.main || r.requirements?.browser
        ? "code does not run"
        : "no code"
      : !act
        ? "not run"
        : act.load?.ok && act.activate?.ok
          ? "activates"
          : act.load?.ok
            ? "fails at activation"
            : "fails at load",
    feature,
    works,
    causes,
    why,
    firstFailure: first,
    reachedUnsupported: reached,
    namedUnsupported: named,
    nodeModules: r.scan?.nodeModules ?? [],
    ext25Verdict: r.compatibility,
    leftOut: [...(r.vsix?.ignored ?? []), ...(r.vsix?.rejected ?? [])].filter(
      (line) => !/^Activation events/.test(line),
    ),
    phasesNeeded: works === "Yes" ? [] : needed,
  };
});

// EXT-26 verdicts, by the main feature.
const verdict = (row) =>
  row.install !== "yes"
    ? "Incompatible"
    : row.works === "Yes"
      ? row.causes.length ||
        row.namedUnsupported.length ||
        row.reachedUnsupported.length ||
        row.leftOut.length
        ? "Compatible with limitations"
        : "Compatible"
      : row.works === "Partly"
        ? "Compatible with limitations"
        : "Incompatible";
for (const row of rows) row.verdict = verdict(row);

const byCause = Object.fromEntries(
  Object.keys(CAUSES).map((c) => [c, rows.filter((r) => r.causes.includes(c)).map((r) => r.id)]),
);
const order = PHASES.map((p) => p.id);
const unlocked = PHASES.map((phase, i) => {
  const reach = new Set(order.slice(0, i + 1));
  const ids = rows
    .filter(
      (r) =>
        r.works !== "Yes" && r.phasesNeeded.length && r.phasesNeeded.every((p) => reach.has(p)),
    )
    .map((r) => r.id);
  return { ...phase, cumulative: ids.length, ids };
});
const missing = new Map();
for (const row of rows)
  for (const api of new Set([...row.namedUnsupported, ...row.reachedUnsupported]))
    missing.set(api, (missing.get(api) ?? 0) + 1);
const topMissing = [...missing].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 30);
const count = (pred) => rows.filter(pred).length;
const summary = {
  extensions: rows.length,
  installs: count((r) => r.install === "yes"),
  activates: count((r) => r.activation === "activates"),
  mainFeature: {
    Yes: count((r) => r.works === "Yes"),
    Partly: count((r) => r.works === "Partly"),
    No: count((r) => r.works === "No"),
  },
  verdicts: Object.fromEntries(
    ["Compatible", "Compatible with limitations", "Incompatible", "Not verified"].map((v) => [
      v,
      count((r) => r.verdict === v),
    ]),
  ),
  ext25Verdicts: Object.fromEntries(
    ["Compatible", "Compatible with limitations", "Incompatible", "Not verified"].map((v) => [
      v,
      count((r) => r.ext25Verdict === v),
    ]),
  ),
  verdictChanged: rows
    .filter((r) => r.verdict !== r.ext25Verdict)
    .map((r) => `${r.id}: ${r.ext25Verdict} → ${r.verdict}`),
  causes: Object.fromEntries(Object.entries(byCause).map(([c, ids]) => [c, ids.length])),
  unlocked: unlocked.map(({ id, title, cumulative }) => ({ id, title, cumulative })),
  topMissing,
};

const lines = [
  "# Open VSX gap analysis (EXT-26)",
  "",
  "Generated by `scripts/openvsx-gaps.mjs`. Measured: the benchmark's records; static: entry-point scans; judged: the main-feature table in the script, each with its reason.",
  "",
];
const row = (...c) =>
  lines.push(`| ${c.map((x) => String(x ?? "").replace(/\|/g, "\\|")).join(" | ")} |`);
lines.push("## Root causes", "");
row("Cause", "Extensions", "Which");
row("---", "---", "---");
for (const [c, ids] of Object.entries(byCause)) row(CAUSES[c], ids.length, ids.join(", "));
lines.push(
  "",
  "## What each phase could unlock (cumulative, upper bound for the main feature)",
  "",
);
row("Phase", "Unlocks (cumulative)", "Extensions");
row("---", "---", "---");
for (const p of unlocked) row(`${p.id}: ${p.title}`, p.cumulative, p.ids.join(", "));
lines.push("", "## Per extension", "");
row(
  "Extension",
  "Category",
  "Install",
  "Activation",
  "Main feature",
  "Works",
  "Causes",
  "Phases needed",
  "EXT-25 → EXT-26 verdict",
  "Why",
);
row("---", "---", "---", "---", "---", "---", "---", "---", "---", "---");
for (const r of rows)
  row(
    r.id,
    r.category,
    r.install,
    r.activation,
    r.feature,
    r.works,
    r.causes.join(", "),
    r.phasesNeeded.join(" "),
    `${r.ext25Verdict} → ${r.verdict}`,
    r.why,
  );
lines.push("", "## Unsupported APIs, by how many benchmark extensions name or reach them", "");
row("API", "Extensions");
row("---", "---");
for (const [api, n] of topMissing) row(api, n);
lines.push("");

if (args.write) {
  writeFileSync(
    join(root, args.write, "gaps.json"),
    JSON.stringify({ summary, rows }, null, 2) + "\n",
  );
  writeFileSync(join(root, args.write, "gaps.md"), lines.join("\n"));
}
console.log(JSON.stringify(summary, null, 1));
