/**
 * Test framework adapters. Each knows how to detect its workspace, build the **safe argv** for a
 * run (a program + an argument array — never a shell string, so a test name or path carrying
 * shell metacharacters is one argument, never something the shell parses), and parse the run's
 * output. The platform runs the resulting command only through the existing authorized,
 * allow-listed process runner (like the checkers subsystem), so no arbitrary command executes.
 *
 * Vitest and Jest emit the same JSON schema, so both reuse {@link parseJestJson}. A future
 * adapter (Cargo, pytest, Playwright) adds its own `command`/`detect` and, if its output differs,
 * its own parser.
 */
import { parseJestJson } from "./jestJson.ts";
import { parseCargoJson } from "./cargoJson.ts";
import { parsePlaywrightJson } from "./playwrightJson.ts";
import { parsePytestJson } from "./pytestJson.ts";
import type { TestReport } from "./model.ts";

/** A program and its argument vector. The runner spawns it as argv; nothing is shell-expanded. */
export interface TestCommand {
  readonly program: string;
  readonly args: readonly string[];
}

/** What a run covers. */
export type TestSelector =
  | { readonly kind: "all" }
  | { readonly kind: "file"; readonly file: string }
  | { readonly kind: "case"; readonly file: string; readonly fullName: string };

export interface TestAdapter {
  readonly id: string;
  readonly label: string;
  /** Whether this adapter owns a workspace, judged from its root marker file names. */
  detect(markerNames: readonly string[]): boolean;
  /** The safe argv to run a selector. */
  command(selector: TestSelector): TestCommand;
  /** Parse a completed run's stdout into a report. */
  parse(output: string, durationMs?: number): TestReport;
}

const hasConfig = (names: readonly string[], base: string) =>
  names.some((n) => new RegExp(`^${base}\\.(c|m)?[jt]s$`).test(n));

/** Vitest: `vitest run --reporter=json [-t <name>] [<file>]`. */
export const vitestAdapter: TestAdapter = {
  id: "vitest",
  label: "Vitest",
  detect: (names) => hasConfig(names, "vitest.config") || hasConfig(names, "vite.config"),
  command: (selector) => {
    const args = ["run", "--reporter=json"];
    if (selector.kind === "file") args.push(selector.file);
    else if (selector.kind === "case") args.push("-t", selector.fullName, selector.file);
    return { program: "vitest", args };
  },
  parse: parseJestJson,
};

/** Jest: `jest --json --silent [-t <name>] [<file>]`. */
export const jestAdapter: TestAdapter = {
  id: "jest",
  label: "Jest",
  detect: (names) => hasConfig(names, "jest.config") || names.includes("jest.config.json"),
  command: (selector) => {
    const args = ["--json", "--silent"];
    if (selector.kind === "file") args.push(selector.file);
    else if (selector.kind === "case") args.push("-t", selector.fullName, selector.file);
    return { program: "jest", args };
  },
  parse: parseJestJson,
};

/**
 * Cargo: Rust's own test runner. The argv the renderer sends is a **minimal selector encoding**,
 * not a cargo command line — the native side re-authorizes it and builds the real cargo argv (the
 * nightly libtest-JSON invocation), resolving and running `cargo` itself. Here:
 *   all        -> `[]`
 *   file (mod) -> `["--filter", <module>]`     (a test-name substring, how Cargo narrows a run)
 *   case       -> `["--exact", <full path>]`   (one test by its exact `module::name`)
 * The module / test path is opaque and travels as a single element, never a shell string.
 * Cargo reports two interleaved JSON protocols, so it uses {@link parseCargoJson}, not the shared
 * Jest/Vitest parser.
 */
export const cargoAdapter: TestAdapter = {
  id: "cargo",
  label: "Cargo",
  detect: (names) => names.includes("Cargo.toml"),
  command: (selector) => {
    if (selector.kind === "file") return { program: "cargo", args: ["--filter", selector.file] };
    if (selector.kind === "case") return { program: "cargo", args: ["--exact", selector.fullName] };
    return { program: "cargo", args: [] };
  },
  parse: parseCargoJson,
};

/**
 * Playwright: an end-to-end runner with its own JSON reporter and its own parser. The renderer
 * sends a **minimal selector encoding** the native side rebuilds into the real argv
 * (`playwright test --reporter=json [<file>] [-g <title>] [--project <name>]`):
 *   all   -> `[]`
 *   file  -> `["--file", <file>]`
 *   case  -> `["--file", <file>, "-g", <title>] (+ ["--project", <name>] when the case names one)`
 * A case's full name carries its browser/project as a `[name]` suffix (how the parser labels it);
 * that is split back out here so the grep is the test title and the project is filtered properly.
 * The title and file are opaque/validated; nothing is a shell string.
 */
export const playwrightAdapter: TestAdapter = {
  id: "playwright",
  label: "Playwright",
  detect: (names) => hasConfig(names, "playwright.config"),
  command: (selector) => {
    if (selector.kind === "file") return { program: "playwright", args: ["--file", selector.file] };
    if (selector.kind === "case") {
      const match = selector.fullName.match(/^(.*) \[([^\]]+)\]$/);
      const grep = match ? match[1]! : selector.fullName;
      const project = match ? match[2]! : null;
      const args = ["--file", selector.file, "-g", grep];
      if (project) args.push("--project", project);
      return { program: "playwright", args };
    }
    return { program: "playwright", args: [] };
  },
  parse: parsePlaywrightJson,
};

/**
 * pytest: Python's dominant runner. Its stable identity is the **node id**
 * (`path::Class::test[param]`), which is exactly how pytest runs one test. The renderer sends a
 * minimal selector the native side rebuilds into `python -m pytest --json-report …`:
 *   all   -> `[]`
 *   file  -> `["--file", <file>]`
 *   case  -> `["--node", "<file>::<tail>"]`  (the full node id, reconstructed from the tree)
 * The file is containment-validated natively; the node id travels as one opaque argument. Results
 * come from the `pytest-json-report` plugin, parsed by {@link parsePytestJson}.
 */
export const pytestAdapter: TestAdapter = {
  id: "pytest",
  label: "pytest",
  detect: (names) =>
    names.includes("pytest.ini") ||
    names.includes("conftest.py") ||
    names.includes("tox.ini") ||
    names.includes("setup.cfg") ||
    names.includes("pyproject.toml"),
  command: (selector) => {
    if (selector.kind === "file") return { program: "pytest", args: ["--file", selector.file] };
    if (selector.kind === "case")
      return { program: "pytest", args: ["--node", `${selector.file}::${selector.fullName}`] };
    return { program: "pytest", args: [] };
  },
  parse: parsePytestJson,
};

/** The built-in adapters, in detection order (most specific first). */
export const BUILTIN_ADAPTERS: readonly TestAdapter[] = [
  jestAdapter,
  vitestAdapter,
  cargoAdapter,
  playwrightAdapter,
  pytestAdapter,
];

/** The first adapter whose markers match, or null. */
export function selectAdapter(
  markerNames: readonly string[],
  adapters: readonly TestAdapter[] = BUILTIN_ADAPTERS,
): TestAdapter | null {
  return adapters.find((a) => a.detect(markerNames)) ?? null;
}
