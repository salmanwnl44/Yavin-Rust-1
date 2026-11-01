#!/usr/bin/env node
/**
 * The Open VSX compatibility benchmark's analysis (EXT-25): joins what the native stages
 * recorded -- the install path (`src-tauri/src/openvsx_benchmark_tests.rs`) and activation in the
 * sandboxed host (`extension_host_real_tests::open_vsx_benchmark_activation`) -- with what this
 * script checks of each package's files, and writes the machine-readable results and a report.
 *
 *   node --experimental-strip-types scripts/openvsx-benchmark.mjs --out <benchmark folder> \
 *     [--baseline benchmark/openvsx/baseline-native.json] [--write benchmark/openvsx]
 *
 * Nothing of an extension runs here. Its files are read as data: its generated manifest is
 * validated by the window's own reader (`manifest.ts`); its themes, snippets, language
 * configurations and grammars by the window's own code (`declarative.ts`,
 * `languageConfiguration.ts`, `textmate.ts`); its entry point is scanned (text only) for the
 * VS Code APIs and Node.js modules it names. Numbers are counted, never estimated: a check that
 * did not run says "not verified".
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const load = (path) => import(pathToFileURL(join(root, path)).href);
const { readManifest } = await load("src/services/extensions/manifest.ts");
const { themeFrom, snippetsFrom, parseJsonc } = await load(
  "src/services/extensions/declarative.ts",
);
const { languageConfigurationFrom } = await load(
  "src/services/extensions/languageConfiguration.ts",
);
const { createTokenizer } = await load("src/services/extensions/textmate.ts");
const { parseIconTheme, svgImage, iconIdFor } = await load("src/services/extensions/iconThemes.ts");

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .reduce(
      (pairs, arg, i, all) =>
        arg.startsWith("--") ? [...pairs, [arg.slice(2), all[i + 1]]] : pairs,
      [],
    ),
);
if (!args.out) {
  console.error(
    "usage: openvsx-benchmark.mjs --out <benchmark folder> [--baseline <native.json>] [--write <folder>]",
  );
  process.exit(2);
}
const json = (path) => JSON.parse(readFileSync(path, "utf8"));
const catalogue = json(join(root, "benchmark/openvsx/catalogue.json"));
const native = json(join(args.out, "native.json")).results;
const activation = existsSync(join(args.out, "activation.json"))
  ? json(join(args.out, "activation.json")).results
  : [];
const baseline = json(
  join(root, args.baseline ?? "benchmark/openvsx/baseline-native.json"),
).results;
const inventory = json(join(root, "src/services/extensions/vscodeApi.json"));
const unsupportedApis = new Set(
  inventory.api.filter((a) => a.status === "UNSUPPORTED").map((a) => a.api),
);

const NAMESPACES = [
  "window",
  "workspace",
  "languages",
  "commands",
  "debug",
  "scm",
  "tasks",
  "env",
  "extensions",
  "authentication",
  "tests",
  "notebooks",
  "comments",
  "l10n",
  "chat",
  "lm",
];
const NODE_MODULES = new Set([
  "assert",
  "async_hooks",
  "buffer",
  "child_process",
  "cluster",
  "console",
  "constants",
  "crypto",
  "dgram",
  "dns",
  "events",
  "fs",
  "http",
  "http2",
  "https",
  "inspector",
  "module",
  "net",
  "os",
  "path",
  "perf_hooks",
  "process",
  "punycode",
  "querystring",
  "readline",
  "repl",
  "stream",
  "string_decoder",
  "timers",
  "tls",
  "tty",
  "url",
  "util",
  "v8",
  "vm",
  "worker_threads",
  "zlib",
]);

/** What an entry point names (a text scan; a bundle's own names may hide some, or add some). */
function scan(text) {
  const requires = new Set();
  for (const m of text.matchAll(/\brequire\(\s*["']([^"']+)["']\s*\)/g))
    requires.add(m[1].replace(/^node:/, ""));
  const vars = new Set(["vscode"]);
  for (const m of text.matchAll(
    /([A-Za-z_$][\w$]*)\s*=\s*(?:[\w$.]+\()?\s*require\(\s*["']vscode["']\s*\)/g,
  ))
    vars.add(m[1]);
  const apis = new Set();
  const names = NAMESPACES.join("|");
  const pattern = new RegExp(
    `(?:^|[^\\w$.])([A-Za-z_$][\\w$]{0,20})\\.(${names})\\.([A-Za-z_][\\w]*)`,
    "g",
  );
  for (const m of text.matchAll(pattern)) {
    // A namespace reached through the vscode module, or through a short (minified) name.
    if (vars.has(m[1]) || m[1].length <= 3 || /^import_vscode|^vscode/.test(m[1]))
      apis.add(`${m[2]}.${m[3]}`);
  }
  return {
    usesVscode: /require\(\s*["']vscode["']\s*\)/.test(text),
    nodeModules: [...requires].filter((r) => NODE_MODULES.has(r.split("/")[0])).sort(),
    packages: [...requires]
      .filter((r) => !r.startsWith(".") && !NODE_MODULES.has(r.split("/")[0]) && r !== "vscode")
      .sort(),
    apis: [...apis].sort(),
  };
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else out.push(path);
  }
  return out;
}

/** The window's own checks of a package's declarative contributions, on its real files. */
function declarative(files, manifest) {
  const read = (path) => readFileSync(join(files, path), "utf8");
  const c = manifest.contributes ?? {};
  const out = {};
  const attempt = (fn) => {
    try {
      return fn();
    } catch (error) {
      return { ok: false, error: String(error.message ?? error).slice(0, 200) };
    }
  };
  if (c.themes)
    out.themes = c.themes.map((t) =>
      attempt(() => {
        const mapped = themeFrom(parseJsonc(read(t.path)));
        return {
          ok: mapped.rules.length > 0 || Object.keys(mapped.colors).length > 0,
          label: t.label,
          rules: mapped.rules.length,
          colors: Object.keys(mapped.colors).length,
          unmapped: mapped.unmapped.length,
        };
      }),
    );
  if (c.snippets)
    out.snippets = c.snippets.map((s) =>
      attempt(() => {
        const found = snippetsFrom(parseJsonc(read(s.path)), manifest.id, s.language);
        return {
          ok: found.snippets.length > 0,
          language: s.language,
          snippets: found.snippets.length,
          problems: found.problems.length,
        };
      }),
    );
  if (c.languages)
    out.languages = c.languages.map((l) =>
      attempt(() => {
        if (!l.configuration) return { ok: true, id: l.id, configuration: false };
        const { config, problems } = languageConfigurationFrom(parseJsonc(read(l.configuration)));
        return { ok: true, id: l.id, configuration: true, applied: Object.keys(config), problems };
      }),
    );
  // File icon themes (EXT-30): the theme file read as the window reads it, and every icon it
  // would show checked as an SVG it draws.
  if (c.iconThemes)
    out.iconThemes = c.iconThemes.map((t) =>
      attempt(() => {
        const theme = parseIconTheme(read(t.path), t.path);
        let drawable = 0;
        let notDrawable = 0;
        for (const path of new Set(theme.icons.values())) {
          let text = null;
          try {
            text = read(path);
          } catch {
            // Not in the package: not drawn.
          }
          if (text !== null && svgImage(text)) drawable++;
          else notDrawable++;
        }
        const sample = ["package.json", "main.rs", "index.ts", "README.md"].map((name) =>
          iconIdFor(theme, { name, isDir: false }),
        );
        return {
          ok: drawable > 0 && sample.every(Boolean),
          id: t.id,
          icons: theme.icons.size,
          drawable,
          notDrawable,
          names: theme.fileNames.size + theme.fileExtensions.size + theme.folderNames.size,
          problems: theme.problems,
        };
      }),
    );
  if (c.grammars) {
    const sources = c.grammars.map((g) => ({
      scopeName: g.scopeName,
      path: g.path,
      text: read(g.path),
    }));
    out.grammars = c.grammars.map((g) =>
      attempt(() => {
        const tokenizer = createTokenizer(sources);
        const sample = 'x = 1 // a comment\n"text" if else return function';
        const started = performance.now();
        const result = tokenizer.tokenize(g.scopeName, sample);
        const tokens = result.lines.reduce((n, line) => n + line.length / 3, 0);
        return {
          ok: tokenizer.problems.length === 0,
          scopeName: g.scopeName,
          language: g.language,
          problems: tokenizer.problems,
          sampleTokens: tokens,
          ms: Math.round(performance.now() - started),
        };
      }),
    );
  }
  return out;
}

const results = [];
for (const entry of catalogue.extensions) {
  const id = `${entry.namespace}.${entry.name}`.toLowerCase();
  const after = native.find((r) => r.id === id) ?? {};
  const before = baseline.find((r) => r.id === id) ?? {};
  const ran = activation.find((r) => r.id === id) ?? null;
  const stageOf = (r) =>
    r.adapt?.ok
      ? { ok: true }
      : (["download", "unpack", "adapt"]
          .map((s) => r[s] && !r[s].ok && { ok: false, stage: s, error: r[s].error })
          .find(Boolean) ?? { ok: false, stage: "not run" });
  const record = {
    id,
    category: entry.category,
    version: entry.version,
    page: entry.page,
    sha256: after.download?.sha256 ?? null,
    size: after.download?.size ?? null,
    signature: after.download?.signature ?? null,
    install: { baseline: stageOf(before), after: stageOf(after) },
  };
  const files = join(args.out, id, "files");
  const pkgPath = join(files, "extension", "package.json");
  if (existsSync(pkgPath)) {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    record.requirements = {
      vscode: pkg.engines?.vscode ?? null,
      main: pkg.main ?? null,
      browser: pkg.browser ?? null,
      type: pkg.type ?? "commonjs",
      activationEvents: (pkg.activationEvents ?? []).slice(0, 30),
      contributes: Object.keys(pkg.contributes ?? {}).sort(),
      extensionDependencies: pkg.extensionDependencies ?? [],
      nativeModules: walk(join(files, "extension")).filter((p) => p.endsWith(".node")).length,
      executables: walk(join(files, "extension")).filter((p) => /\.(exe|dll|so|dylib)$/i.test(p))
        .length,
    };
  }
  const manifest = after.adapt?.manifest;
  if (manifest) {
    const read = readManifest(manifest);
    record.manifest = {
      valid: read.ok,
      problems: read.ok ? [] : read.problems.map((p) => `${p.field}: ${p.message}`),
    };
    record.vsix = {
      supported: manifest.vsix.supported,
      ignored: manifest.vsix.ignored,
      rejected: manifest.vsix.rejected,
      runtime: manifest.vsix.runtime ? manifest.vsix.runtime.entry : null,
    };
    record.declarative = declarative(files, { ...manifest, id });
    if (manifest.main && existsSync(join(files, manifest.main)))
      record.scan = scan(readFileSync(join(files, manifest.main), "utf8"));
  }
  if (ran) {
    record.activation = {
      sandboxed: ran.sandboxed ?? null,
      load: ran.load ?? null,
      activate: ran.activate ?? null,
      unsupported: ran.unsupported ?? [],
      commands: ran.commands ?? [],
      exited: ran.exited ?? false,
    };
  }
  results.push(classify(record));
}

/** Compatible / Compatible with limitations / Incompatible / Not verified, with why. */
function classify(r) {
  const why = [];
  let verdict;
  const declarativeChecks = Object.values(r.declarative ?? {}).flat();
  const declarativeOk = declarativeChecks.length > 0 && declarativeChecks.some((c) => c.ok);
  // What is useful without its code: a theme, snippets or a grammar that applies (a language's
  // file association alone is not a feature).
  const standsAlone = ["themes", "snippets", "grammars"].some((k) =>
    (r.declarative?.[k] ?? []).some((c) => c.ok),
  );
  const code = r.vsix?.runtime;
  const act = r.activation;
  if (!r.install.after.ok) {
    verdict = "Incompatible";
    why.push(
      `not installed (${r.install.after.stage}): ${String(r.install.after.error ?? "").slice(0, 160)}`,
    );
  } else if (r.manifest && !r.manifest.valid) {
    verdict = "Incompatible";
    why.push(
      `its generated manifest is refused by the window: ${r.manifest.problems.slice(0, 2).join("; ")}`,
    );
  } else if (code && act && !(act.load?.ok && act.activate?.ok)) {
    const failure = act.load?.ok ? act.activate?.error : act.load?.error;
    why.push(
      `its code does not activate: ${String(failure?.message ?? failure?.code ?? "no answer").slice(0, 160)}`,
    );
    verdict = standsAlone ? "Compatible with limitations" : "Incompatible";
    if (standsAlone) why.push("its themes, snippets or grammars still apply");
  } else if (code && !act) {
    verdict = "Not verified";
    why.push("its code was not run by the benchmark");
  } else if (code) {
    const failed = act.commands.filter((c) => c.ok !== true);
    const limitations = [
      ...act.unsupported.map((u) =>
        u.replace(/^UnsupportedApi: /, "").replace(/ is not supported by Yavin.*$/, ""),
      ),
      ...(r.vsix?.ignored ?? []).filter((i) => !/^\d+ (keybindings|menu items)/.test(i)),
    ];
    if (act.commands.length === 0 && act.unsupported.length === 0) {
      verdict = r.vsix.ignored.length ? "Compatible with limitations" : "Not verified";
      why.push("activates; no command to check its features with");
    } else if (
      failed.length === 0 &&
      act.unsupported.length === 0 &&
      (r.vsix?.ignored ?? []).length === 0
    ) {
      verdict = "Compatible";
      why.push(`activates; ${act.commands.length} commands ran`);
    } else {
      verdict = "Compatible with limitations";
      why.push(
        `activates; ${act.commands.length - failed.length}/${act.commands.length} commands ran`,
      );
      if (limitations.length)
        why.push(`not available: ${[...new Set(limitations)].slice(0, 4).join("; ")}`);
    }
  } else {
    const failedChecks = declarativeChecks.filter((c) => !c.ok);
    const ignored = (r.vsix?.ignored ?? []).filter((i) => !/^Activation events/.test(i));
    if (!declarativeChecks.length) {
      verdict = "Not verified";
      why.push("nothing the benchmark can check");
    } else if (
      failedChecks.length === 0 &&
      ignored.length === 0 &&
      (r.vsix?.rejected ?? []).length === 0
    ) {
      verdict = "Compatible";
      why.push("every contribution applies");
    } else if (declarativeOk) {
      verdict = "Compatible with limitations";
      if (ignored.length) why.push(`not applied: ${ignored.slice(0, 3).join("; ")}`);
      if (failedChecks.length)
        why.push(`${failedChecks.length} contribution files could not be used`);
    } else {
      verdict = "Incompatible";
      why.push("none of its contributions could be used");
    }
  }
  return { ...r, compatibility: verdict, why };
}

// --- Metrics ----------------------------------------------------------------------------------------
const count = (pred) => results.filter(pred).length;
const n = results.length;
const pct = (k, of) => (of ? `${((100 * k) / of).toFixed(1)}%` : "n/a");
const code = results.filter((r) => r.vsix?.runtime);
const activated = code.filter((r) => r.activation?.load?.ok && r.activation?.activate?.ok);
const commandRuns = activated.flatMap((r) => r.activation.commands);
const declChecks = results.flatMap((r) => Object.values(r.declarative ?? {}).flat());
const missing = new Map();
for (const r of results)
  for (const u of r.activation?.unsupported ?? []) {
    const name = u.replace(/^UnsupportedApi: /, "").replace(/ is not supported by Yavin.*$/, "");
    missing.set(name, (missing.get(name) ?? 0) + 1);
  }
const loadFailures = new Map();
for (const r of code) {
  const e = !r.activation
    ? null
    : !r.activation.load?.ok
      ? r.activation.load?.error?.message
      : !r.activation.activate?.ok
        ? r.activation.activate?.error?.message
        : null;
  if (!e) continue;
  const key = String(e)
    .replace(/^UnsupportedApi: /, "")
    .replace(/ is not supported by Yavin.*$/, "")
    .slice(0, 90);
  loadFailures.set(key, (loadFailures.get(key) ?? 0) + 1);
}
const staticMissing = new Map();
for (const r of results)
  for (const api of r.scan?.apis ?? [])
    if (unsupportedApis.has(api)) staticMissing.set(api, (staticMissing.get(api) ?? 0) + 1);
const nodeUse = new Map();
for (const r of results)
  for (const m of r.scan?.nodeModules ?? []) nodeUse.set(m, (nodeUse.get(m) ?? 0) + 1);
const top = (map, k = 15) =>
  [...map].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, k);
const verdicts = ["Compatible", "Compatible with limitations", "Incompatible", "Not verified"];
const metrics = {
  extensions: n,
  install: {
    baseline: count((r) => r.install.baseline.ok),
    after: count((r) => r.install.after.ok),
  },
  manifestsValid: count((r) => r.manifest?.valid),
  manifestsGenerated: count((r) => r.manifest),
  withCode: code.length,
  activation: {
    attempted: code.filter((r) => r.activation).length,
    loaded: code.filter((r) => r.activation?.load?.ok).length,
    activated: activated.length,
  },
  commands: {
    run: commandRuns.length,
    ok: commandRuns.filter((c) => c.ok === true).length,
    edited: commandRuns.filter((c) => c.edited).length,
  },
  declarativeChecks: { run: declChecks.length, ok: declChecks.filter((c) => c.ok).length },
  verdicts: Object.fromEntries(verdicts.map((v) => [v, count((r) => r.compatibility === v)])),
  crashes: count((r) => r.activation?.exited),
  sandboxed: {
    checked: count(
      (r) => r.activation?.sandboxed !== undefined && r.activation?.sandboxed !== null,
    ),
    inSandbox: count((r) => r.activation?.sandboxed === true),
  },
  signatures: Object.fromEntries(
    [...new Set(results.map((r) => r.signature).filter(Boolean))].map((s) => [
      s,
      count((r) => r.signature === s),
    ]),
  ),
  timings: {
    installMs: median(native.map((r) => r.installMs).filter(Number.isFinite)),
    loadMs: median(code.map((r) => r.activation?.load?.ms).filter(Number.isFinite)),
    activateMs: median(activated.map((r) => r.activation.activate.ms).filter(Number.isFinite)),
  },
  missingAtRuntime: top(missing),
  firstFailure: top(loadFailures),
  unsupportedNamedInCode: top(staticMissing),
  nodeModulesNamed: top(nodeUse),
};
function median(list) {
  if (!list.length) return null;
  const sorted = [...list].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

// --- Report -----------------------------------------------------------------------------------------
const lines = [];
const row = (...cells) =>
  lines.push(
    `| ${cells
      .map((c) =>
        String(c ?? "")
          .replace(/\|/g, "\\|")
          .replace(/\n/g, " "),
      )
      .join(" | ")} |`,
  );
lines.push(
  "# Open VSX benchmark results (EXT-25)",
  "",
  "Generated by `scripts/openvsx-benchmark.mjs` from the native stages' records; every number is counted from them.",
  "",
);
lines.push("## Summary", "");
row("Measure", "Before EXT-25", "After");
row("---", "---", "---");
row(
  "Installed through Yavin's install path",
  `${metrics.install.baseline}/${n} (${pct(metrics.install.baseline, n)})`,
  `${metrics.install.after}/${n} (${pct(metrics.install.after, n)})`,
);
row(
  "Generated manifest valid in the window",
  "—",
  `${metrics.manifestsValid}/${metrics.manifestsGenerated}`,
);
row("With code that the layer runs", "0 (no code ran)", `${code.length}`);
row(
  "Code loaded / activated",
  "0 / 0",
  `${metrics.activation.loaded} / ${metrics.activation.activated} of ${metrics.activation.attempted} (${pct(metrics.activation.activated, metrics.activation.attempted)} activated)`,
);
row(
  "Contributed commands run without error",
  "—",
  `${metrics.commands.ok}/${metrics.commands.run} (${metrics.commands.edited} edited the document)`,
);
row(
  "Declarative checks passed (themes, snippets, languages, grammars)",
  "—",
  `${metrics.declarativeChecks.ok}/${metrics.declarativeChecks.run}`,
);
for (const v of verdicts) row(v, "—", `${metrics.verdicts[v]} (${pct(metrics.verdicts[v], n)})`);
row("Host crashes during the run", "—", metrics.crashes);
row(
  "Hosts confirmed in the AppContainer sandbox",
  "—",
  `${metrics.sandboxed.inSandbox}/${metrics.sandboxed.checked}`,
);
row(
  "Median install / load / activate (ms)",
  "—",
  `${metrics.timings.installMs} / ${metrics.timings.loadMs} / ${metrics.timings.activateMs}`,
);
lines.push("", "## What stops code most often (first failure, at load or activation)", "");
row("Missing", "Extensions");
row("---", "---");
for (const [k, v] of metrics.firstFailure) row(k, v);
lines.push("", "## Unsupported APIs named in entry points (static scan)", "");
row("API", "Extensions");
row("---", "---");
for (const [k, v] of metrics.unsupportedNamedInCode) row(k, v);
lines.push("", "## Node.js modules named in entry points", "");
row("Module", "Extensions");
row("---", "---");
for (const [k, v] of metrics.nodeModulesNamed) row(k, v);
lines.push("", "## Per extension", "");
row(
  "Category",
  "Extension",
  "Version",
  "Installed (before → after)",
  "Code",
  "Activation",
  "Verdict",
  "Why",
);
row("---", "---", "---", "---", "---", "---", "---", "---");
for (const r of results) {
  const act = r.activation;
  row(
    r.category,
    `[${r.id}](${r.page})`,
    r.version,
    `${r.install.baseline.ok ? "yes" : "no"} → ${r.install.after.ok ? "yes" : `no (${r.install.after.stage})`}`,
    r.vsix?.runtime ?? (r.requirements?.main || r.requirements?.browser ? "does not run" : "none"),
    !act
      ? "—"
      : !act.load?.ok
        ? "load failed"
        : act.activate?.ok
          ? `ok (${act.commands.filter((c) => c.ok === true).length}/${act.commands.length} commands)`
          : "failed",
    r.compatibility,
    r.why.join("; "),
  );
}
lines.push("");

const outDir = args.write ? join(root, args.write) : null;
const machine = {
  generated: new Date().toISOString().slice(0, 10),
  registry: "https://open-vsx.org/",
  metrics,
  results,
};
if (outDir) {
  writeFileSync(join(outDir, "results.json"), JSON.stringify(machine, null, 2) + "\n");
  writeFileSync(join(outDir, "results.md"), lines.join("\n"));
  console.log(`wrote ${join(outDir, "results.json")} and results.md`);
}
console.log(
  JSON.stringify(
    {
      ...metrics,
      missingAtRuntime: metrics.missingAtRuntime.slice(0, 8),
      firstFailure: metrics.firstFailure.slice(0, 8),
    },
    null,
    1,
  ),
);
