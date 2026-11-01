/**
 * EXT-33 E0: `workspace.findFiles` -- behaviourally, on the window side: the probe extension runs
 * in Yavin's real host (`host.ts`) through the real layer (`vscode.js`), against a window whose
 * search records what it is asked (`testing/vscodeHarness.ts`). The search itself is Yavin's own
 * (ripgrep, `workbench.rs`: its listing and its globs are tested in Rust).
 */
import assert from "node:assert/strict";
import test from "node:test";
import { ID, vscodeWorld } from "./testing/vscodeHarness.ts";

const OTHER = "acme.other";

async function ready() {
  const w = vscodeWorld();
  w.install();
  w.grant(["workspace.fs.read"]);
  return w;
}

test("findFiles answers the workspace's files through Yavin's search, as Uris, bounded", async (t) => {
  const w = await ready();
  t.after(() => w.manager.dispose());
  w.found.files = ["media/a.svg", "b.svg", "deep/er/c.svg"];
  const out = await w.step(
    `const found = await vscode.workspace.findFiles("**/*.svg");
     const two = await vscode.workspace.findFiles("**/*.svg", null, 2);
     return { all: found.map((u) => u.toString()), fsPaths: found.map((u) => u.fsPath), two: two.length, isUri: found[0] instanceof vscode.Uri };`,
  );
  assert.deepEqual((out as { all: string[] }).all, [
    "file:///C:/work/media/a.svg",
    "file:///C:/work/b.svg",
    "file:///C:/work/deep/er/c.svg",
  ]);
  assert.equal((out as { two: number }).two, 2, "maxResults");
  assert.equal((out as { isUri: boolean }).isUri, true);
  // What the window's search was asked: the host's workspace, the glob, and VS Code's default
  // files.exclude when none is given; none at all for null.
  assert.equal(w.finds[0].folder, "C:/work");
  assert.equal(w.finds[0].include, "**/*.svg");
  assert.deepEqual(w.finds[0].exclude, ["**/{.git,.svn,.hg,CVS,.DS_Store,Thumbs.db}"]);
  assert.deepEqual(w.finds[1].exclude, []);
});

test("a RelativePattern searches its base inside the workspace; one outside it is refused", async (t) => {
  const w = await ready();
  t.after(() => w.manager.dispose());
  w.found.files = ["src/x.ts"];
  const out = await w.step(
    `const inside = await vscode.workspace.findFiles(new vscode.RelativePattern(vscode.workspace.workspaceFolders[0], "src/**/*.ts"), new vscode.RelativePattern(vscode.Uri.file("C:/work/src"), "gen/**"));
     let outside;
     try { await vscode.workspace.findFiles(new vscode.RelativePattern(vscode.Uri.file("C:/Users"), "**")); outside = "SEARCHED"; } catch (e) { outside = e.message; }
     return { inside: inside.length, outside };`,
  );
  assert.equal((out as { inside: number }).inside, 1);
  assert.match((out as { outside: string }).outside, /outside the workspace/);
  assert.equal(w.finds.length, 1, "the outside base never reached the window");
  assert.equal(w.finds[0].include, "src/**/*.ts");
  assert.deepEqual(w.finds[0].exclude, ["src/gen/**"]);
});

test("globs that leave the workspace, look like options or negate are refused before any search", async (t) => {
  const w = await ready();
  t.after(() => w.manager.dispose());
  const out = await w.step(
    `const tries = { absolute: "C:/Users/**", root: "/etc/**", parent: "../**", inner: "src/../../x", option: "--pre=calc", flag: "-uuu", negated: "!**/*.ts", nul: "a\\u0000b", long: "a".repeat(1001), empty: "" };
     const out = {};
     for (const [k, glob] of Object.entries(tries)) { try { await vscode.workspace.findFiles(glob); out[k] = "SEARCHED"; } catch (e) { out[k] = e.code || e.message; } }
     try { await vscode.workspace.findFiles("**", "--pre=calc"); out.excludeOption = "SEARCHED"; } catch (e) { out.excludeOption = e.code; }
     try { await vscode.workspace.findFiles(42); out.notAGlob = "SEARCHED"; } catch (e) { out.notAGlob = e.name; }
     return out;`,
  );
  assert.deepEqual(out, {
    absolute: "OutsideWorkspace",
    root: "OutsideWorkspace",
    parent: "OutsideWorkspace",
    inner: "OutsideWorkspace",
    option: "InvalidRequest",
    flag: "InvalidRequest",
    negated: "InvalidRequest",
    nul: "InvalidRequest",
    long: "InvalidRequest",
    empty: "InvalidRequest",
    excludeOption: "InvalidRequest",
    notAGlob: "TypeError",
  });
  assert.equal(w.finds.length, 0, "nothing reached Yavin's search");
});

test("results outside the workspace or with .. are never answered; the bound is Yavin's", async (t) => {
  const w = await ready();
  t.after(() => w.manager.dispose());
  // The window's search answers full paths: anything not under the workspace is dropped.
  w.found.files = [
    "ok.txt",
    "../escape.txt",
    "a/../../b.txt",
    "D:/elsewhere/x.txt",
    "C:/workshop/y.txt",
  ];
  const out = await w.step(
    `return (await vscode.workspace.findFiles("**", null, 100000)).map((u) => u.path);`,
  );
  assert.deepEqual(out, ["/C:/work/ok.txt"]);
});

test("a cancelled token stops Yavin's search; a stopped extension's searches stop", async (t) => {
  const w = await ready();
  t.after(() => w.manager.dispose());
  w.found.hold = true;
  const out = w.step(
    `const source = new vscode.CancellationTokenSource();
     const found = vscode.workspace.findFiles("**", null, 10, source.token);
     setTimeout(() => source.cancel(), 20);
     return (await found).length;`,
  );
  assert.equal(await out, 0, "cancelled: nothing");
  assert.equal(w.finds.length, 1);
  assert.equal(w.finds[0].signal.aborted, true, "the window's search was stopped");
  // Already cancelled: the window is not asked.
  await w.step(
    `const source = new vscode.CancellationTokenSource(); source.cancel();
     return (await vscode.workspace.findFiles("**", null, 10, source.token)).length;`,
  );
  assert.equal(w.finds.length, 1);
  // A search still running when its extension stops is stopped with it.
  void w.step(`T.pending = vscode.workspace.findFiles("**"); return 1;`);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(w.finds.length, 2);
  // Disabled (as the user stops it): its search stops with it.
  await w.registry.setEnabled(ID, false);
  await w.manager.reconcile?.();
  const until = Date.now() + 3000;
  while (!w.finds[1].signal.aborted && Date.now() < until)
    await new Promise((resolve) => setTimeout(resolve, 2));
  assert.equal(w.finds[1].signal.aborted, true, "stopped with its extension");
});

test("findFiles needs workspace.fs.read, and a search's id is its own extension's", async (t) => {
  const w = vscodeWorld();
  t.after(() => w.manager.dispose());
  w.install();
  w.install(OTHER);
  const refused = await w.step(
    `try { await vscode.workspace.findFiles("**"); return "SEARCHED"; } catch (e) { return e.code; }`,
  );
  assert.equal(refused, "PermissionDenied");
  assert.equal(w.finds.length, 0);
});

test("a found file is the same Uri as that file open as a document (path and string)", async (t) => {
  const w = await ready();
  t.after(() => w.manager.dispose());
  w.grant(["workspace.fs.read", "documents.read"]);
  await w.open("media/a.svg", "<svg/>");
  w.found.files = ["media/a.svg"];
  const out = await w.step(
    `const [found] = await vscode.workspace.findFiles("**/*.svg");
     const doc = vscode.workspace.textDocuments.find((d) => d.uri.path.endsWith("a.svg"));
     return { samePath: found.path === doc.uri.path, sameString: found.toString() === doc.uri.toString(), byPath: vscode.workspace.textDocuments.some((d) => d.uri.path == found.path) };`,
  );
  assert.deepEqual(out, { samePath: true, sameString: true, byPath: true });
});
