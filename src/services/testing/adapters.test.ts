import assert from "node:assert/strict";
import test from "node:test";
import {
  jestAdapter,
  vitestAdapter,
  cargoAdapter,
  playwrightAdapter,
  pytestAdapter,
  selectAdapter,
  BUILTIN_ADAPTERS,
} from "./adapters.ts";

test("adapters detect their workspaces by marker file names", () => {
  assert.ok(vitestAdapter.detect(["vitest.config.ts"]));
  assert.ok(vitestAdapter.detect(["vite.config.js"]));
  assert.ok(!vitestAdapter.detect(["package.json", "tsconfig.json"]));
  assert.ok(jestAdapter.detect(["jest.config.js"]));
  assert.ok(jestAdapter.detect(["jest.config.json"]));
  assert.ok(!jestAdapter.detect(["vitest.config.ts"]));
  assert.ok(cargoAdapter.detect(["Cargo.toml", "src"]));
  assert.ok(!cargoAdapter.detect(["package.json"]));
  assert.ok(playwrightAdapter.detect(["playwright.config.ts"]));
  assert.ok(playwrightAdapter.detect(["playwright.config.js"]));
  assert.ok(!playwrightAdapter.detect(["vitest.config.ts"]));
  assert.ok(pytestAdapter.detect(["pytest.ini"]));
  assert.ok(pytestAdapter.detect(["conftest.py"]));
  assert.ok(pytestAdapter.detect(["pyproject.toml"]));
  assert.ok(!pytestAdapter.detect(["package.json"]));
});

test("pytest reconstructs the full node id for a case and sends a file for a file run", () => {
  assert.deepEqual(pytestAdapter.command({ kind: "all" }), { program: "pytest", args: [] });
  assert.deepEqual(pytestAdapter.command({ kind: "file", file: "tests/test_a.py" }), {
    program: "pytest",
    args: ["--file", "tests/test_a.py"],
  });
  // The tree stores the node-id tail as the full name; the adapter rebuilds the whole node id.
  assert.deepEqual(
    pytestAdapter.command({
      kind: "case",
      file: "tests/test_a.py",
      fullName: "TestClass::test_method[1-2]",
    }),
    { program: "pytest", args: ["--node", "tests/test_a.py::TestClass::test_method[1-2]"] },
  );
});

test("playwright builds a minimal selector encoding, splitting the project out of a case", () => {
  assert.deepEqual(playwrightAdapter.command({ kind: "all" }), { program: "playwright", args: [] });
  assert.deepEqual(playwrightAdapter.command({ kind: "file", file: "e2e/a.spec.ts" }), {
    program: "playwright",
    args: ["--file", "e2e/a.spec.ts"],
  });
  // A case whose full name carries a [project] suffix -> grep the title, filter the project.
  assert.deepEqual(
    playwrightAdapter.command({
      kind: "case",
      file: "e2e/a.spec.ts",
      fullName: "forms submits [chromium]",
    }),
    {
      program: "playwright",
      args: ["--file", "e2e/a.spec.ts", "-g", "forms submits", "--project", "chromium"],
    },
  );
  // A case with no project suffix greps the whole name.
  assert.deepEqual(
    playwrightAdapter.command({ kind: "case", file: "e2e/a.spec.ts", fullName: "just a title" }),
    { program: "playwright", args: ["--file", "e2e/a.spec.ts", "-g", "just a title"] },
  );
});

test("cargo builds a minimal selector encoding (the native side rebuilds the real cargo argv)", () => {
  assert.deepEqual(cargoAdapter.command({ kind: "all" }), { program: "cargo", args: [] });
  assert.deepEqual(cargoAdapter.command({ kind: "file", file: "math" }), {
    program: "cargo",
    args: ["--filter", "math"],
  });
  assert.deepEqual(
    cargoAdapter.command({ kind: "case", file: "math", fullName: "math::tests::adds" }),
    { program: "cargo", args: ["--exact", "math::tests::adds"] },
  );
});

test("selectAdapter returns the first matching adapter, or null", () => {
  assert.equal(selectAdapter(["jest.config.js"])?.id, "jest");
  assert.equal(selectAdapter(["vitest.config.ts"])?.id, "vitest");
  // Jest is listed first, so it wins when both are present.
  assert.equal(selectAdapter(["jest.config.js", "vitest.config.ts"])?.id, "jest");
  assert.equal(selectAdapter(["package.json"]), null);
});

test("vitest command builds safe argv for all / file / case", () => {
  assert.deepEqual(vitestAdapter.command({ kind: "all" }), {
    program: "vitest",
    args: ["run", "--reporter=json"],
  });
  assert.deepEqual(vitestAdapter.command({ kind: "file", file: "/w/a.test.ts" }).args, [
    "run",
    "--reporter=json",
    "/w/a.test.ts",
  ]);
  assert.deepEqual(
    vitestAdapter.command({ kind: "case", file: "/w/a.test.ts", fullName: "math adds" }).args,
    ["run", "--reporter=json", "-t", "math adds", "/w/a.test.ts"],
  );
});

test("jest command builds safe argv", () => {
  assert.deepEqual(jestAdapter.command({ kind: "all" }).args, ["--json", "--silent"]);
  assert.deepEqual(
    jestAdapter.command({ kind: "case", file: "/w/a.test.ts", fullName: "x" }).args,
    ["--json", "--silent", "-t", "x", "/w/a.test.ts"],
  );
});

test("SECURITY: a test name with shell metacharacters stays a single argument", () => {
  const evil = 'evil"; rm -rf / #`$(whoami)';
  for (const adapter of BUILTIN_ADAPTERS) {
    const { program, args } = adapter.command({
      kind: "case",
      file: "/w/a.test.ts",
      fullName: evil,
    });
    // The dangerous name is carried inside exactly ONE argv element (never split, never built
    // into a command line). Some adapters compose it into a node id ("file::name"), so it is
    // *contained* in one element rather than equal to it — still a single argument either way.
    const holders = args.filter((a) => a.includes(evil));
    assert.equal(holders.length, 1, `${adapter.id}: the name is in exactly one argument`);
    // No *other* argument is a joined shell string.
    assert.ok(
      !args.some(
        (a) => !a.includes(evil) && (a.includes(";") || a.includes("&&") || a.includes("|")),
      ),
      `${adapter.id}: no other argument is a shell string`,
    );
    assert.ok(!program.includes(" "), `${adapter.id}: program is a bare executable name`);
  }
});

test("adapters parse the shared jest/vitest JSON", () => {
  const report = vitestAdapter.parse(
    JSON.stringify({
      testResults: [
        {
          name: "/w/a.test.ts",
          assertionResults: [{ title: "ok", fullName: "ok", status: "passed", ancestorTitles: [] }],
        },
      ],
    }),
  );
  assert.equal(report.summary.passed, 1);
});
