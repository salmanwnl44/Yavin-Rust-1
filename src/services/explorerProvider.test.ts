import assert from "node:assert/strict";
import test from "node:test";
import { createFileSystemExplorerProvider } from "./explorerProvider.ts";
import type { ExplorerProviderEvent, ProjectedNode } from "./explorerProvider.ts";
import { createExplorerStore } from "./explorerStore.ts";
import type { FileNode } from "../types.ts";

/**
 * A filesystem for the provider to list: folders and files by path, one level per listing as
 * `list_workspace_files` answers, with failures and gates that hold a listing open so answers
 * can be made to arrive in any order. No timers.
 */
function fakeFs(paths: string[] = []) {
  const dirs = new Set<string>();
  const files = new Map<string, number>();
  /** Entries by parent folder, so listing a folder costs what the folder holds. */
  const under = new Map<string, Set<string>>();
  const parentOf = (path: string) => path.slice(0, path.lastIndexOf("/"));
  const link = (path: string) => {
    const parent = parentOf(path);
    if (!parent) return;
    let set = under.get(parent);
    if (!set) under.set(parent, (set = new Set()));
    set.add(path);
  };
  const unlink = (path: string) => under.get(parentOf(path))?.delete(path);
  const add = (path: string) => {
    const parts = path.split("/");
    for (let index = 2; index < parts.length; index++) {
      const dir = parts.slice(0, index).join("/");
      if (!dirs.has(dir)) {
        dirs.add(dir);
        link(dir);
      }
    }
    if (path.endsWith("/")) {
      const dir = path.slice(0, -1);
      if (!dirs.has(dir)) {
        dirs.add(dir);
        link(dir);
      }
    } else {
      files.set(path, 0);
      link(path);
    }
  };
  paths.forEach(add);
  const failures = new Map<string, string>();
  const gates = new Map<string, Promise<void>>();
  const listed: string[] = [];
  const childrenOf = (dir: string) => [...(under.get(dir) ?? [])].sort();
  // The disk is read when the listing starts; a gate delays only the answer -- a slow
  // listing that saw the disk as it was. A gate holds the next listing of its path only.
  const list = async (path: string): Promise<FileNode> => {
    listed.push(path);
    const gate = gates.get(path);
    gates.delete(path);
    const failure = failures.get(path);
    const found = dirs.has(path);
    const answer: FileNode = {
      name: path.split("/").pop()!,
      path,
      is_dir: true,
      children: childrenOf(path).map((child) => ({
        name: child.split("/").pop()!,
        path: child,
        is_dir: dirs.has(child),
        size: files.get(child),
      })),
    };
    if (gate) await gate;
    if (failure) throw failure;
    if (!found) throw `Cannot read ${path}: not found`;
    return answer;
  };
  return {
    io: { list },
    listed,
    failures,
    add,
    remove(path: string) {
      for (const dir of [...dirs])
        if (dir === path || dir.startsWith(path + "/")) {
          dirs.delete(dir);
          unlink(dir);
          under.delete(dir);
        }
      for (const file of [...files.keys()])
        if (file === path || file.startsWith(path + "/")) {
          files.delete(file);
          unlink(file);
        }
    },
    rename(from: string, to: string) {
      const moves: [string, boolean, number][] = [];
      for (const dir of [...dirs])
        if (dir === from || dir.startsWith(from + "/")) moves.push([dir, true, 0]);
      for (const [file, size] of [...files])
        if (file === from || file.startsWith(from + "/")) moves.push([file, false, size]);
      for (const [path] of moves) {
        dirs.delete(path);
        files.delete(path);
        unlink(path);
        under.delete(path);
      }
      for (const [path, isDir, size] of moves) {
        const moved = to + path.slice(from.length);
        if (isDir) dirs.add(moved);
        else files.set(moved, size);
        link(moved);
      }
    },
    touch(path: string) {
      files.set(path, (files.get(path) ?? 0) + 1);
    },
    hold(path: string) {
      let release!: () => void;
      gates.set(path, new Promise<void>((resolve) => (release = resolve)));
      return () => release();
    },
  };
}

function setup(paths: string[], roots = ["/w"]) {
  const fs = fakeFs(paths);
  const provider = createFileSystemExplorerProvider(fs.io);
  const events: ExplorerProviderEvent[] = [];
  provider.subscribe((event) => events.push(event));
  provider.setRoots(roots);
  const id = (path: string) => provider.idFor(path);
  const names = (path: string) =>
    provider.getChildren(id(path)).map((node) => ("name" in node ? node.name : `!${node.message}`));
  return { fs, provider, events, id, names };
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

// ---------------------------------------------------------------------------------------
// Identity and snapshots
// ---------------------------------------------------------------------------------------

test("node identity is the resource's, for every spelling of its path", async () => {
  const { provider, id } = setup(["C:/Work/src/a.ts"], ["C:/Work"]);
  await provider.loadChildren(id("C:/Work"));
  const src = provider.getChildren(id("C:/Work"))[0];
  assert.equal(src.id, provider.idFor("c:\\work\\SRC"));
  assert.equal(src.id, provider.idFor("\\\\?\\C:\\Work\\src"));
  assert.equal(provider.getNode(provider.idFor("c:/work/src"))?.name, "src");
});

test("snapshots are synchronous and say what is known, and roots are separate", async () => {
  const { provider, id, names } = setup(
    ["/a/src/a.ts", "/a/package.json", "/b/src/lib.rs", "/b/Cargo.toml"],
    ["/a", "/b"],
  );
  assert.deepEqual(
    provider.getRootNodes().map((node) => [node.kind, node.path]),
    [
      ["workspace", "/a"],
      ["workspace", "/b"],
    ],
  );
  assert.deepEqual(provider.childrenState(id("/a")), { status: "unloaded" });
  assert.deepEqual(provider.getChildren(id("/a")), []);
  const loading = provider.loadChildren(id("/a"));
  assert.deepEqual(provider.childrenState(id("/a")), { status: "loading" });
  await loading;
  assert.deepEqual(names("/a"), ["package.json", "src"]);
  assert.deepEqual(provider.childrenState(id("/b")), { status: "unloaded" }, "independent roots");
  await provider.loadChildren(id("/b"));
  assert.deepEqual(names("/b"), ["Cargo.toml", "src"]);
  const src = provider.getNode(id("/b/src"))!;
  assert.equal(src.kind, "directory");
  assert.equal(src.parentId, id("/b"));
});

test("identity and node objects survive refreshes and unrelated changes", async () => {
  const { fs, provider, id } = setup(["/w/src/a.ts", "/w/src/b.ts", "/w/lib/c.ts"]);
  await provider.loadChildren(id("/w"));
  await provider.loadChildren(id("/w/src"));
  await provider.loadChildren(id("/w/lib"));
  const a = provider.getNode(id("/w/src/a.ts"));
  const lib = provider.projection()!.children![0];
  fs.add("/w/src/new.ts");
  await provider.refresh();
  assert.equal(provider.getNode(id("/w/src/a.ts")), a, "the same node object");
  assert.equal(provider.projection()!.children![0], lib, "the untouched folder's projection too");
});

test("the projection hands back what did not change: rows stay memoized", async () => {
  // The tree view memoizes a row on the node object it renders, so an equal copy costs a
  // re-render -- and a refresh re-lists every loaded folder.
  const { fs, provider, id } = setup(["/w/src/inner.ts", "/w/a.ts", "/w/b.ts"]);
  for (const path of ["/w", "/w/src"]) await provider.loadChildren(id(path));
  const before = provider.projection()!;
  const [a, b, src] = before.children!;
  assert.deepEqual([a.name, b.name, src.name], ["a.ts", "b.ts", "src"]);
  fs.touch("/w/a.ts");
  await provider.refresh([id("/w")]);
  const after = provider.projection()!;
  assert.notEqual(after, before, "the root is new, so React sees the change");
  assert.notEqual(after.children![0], a, "the edited file is a new object");
  assert.equal(after.children![0].size, 1);
  assert.equal(after.children![1], b, "its neighbour is untouched");
  assert.equal(after.children![2], src, "a loaded folder keeps its object ...");
  assert.deepEqual(
    after.children![2].children!.map((child) => child.name),
    ["inner.ts"],
    "... and its children, after its parent was re-listed",
  );
});

test("capabilities come from the provider, per kind of node", async () => {
  const { provider, id } = setup(["/w/src/a.ts"]);
  await provider.loadChildren(id("/w"));
  await provider.loadChildren(id("/w/src"));
  assert.equal(provider.capabilities(id("/w")).canDelete, false, "a root is not deleted here");
  assert.equal(provider.capabilities(id("/w")).canCreateFile, true);
  assert.equal(provider.capabilities(id("/w/src")).canRename, true);
  assert.equal(provider.capabilities(id("/w/src/a.ts")).canCreateFile, false);
  assert.equal(provider.capabilities(id("/w/src/a.ts")).canOpen, true);
  assert.equal(provider.capabilities(id("/nowhere")).canRefresh, false);
});

// ---------------------------------------------------------------------------------------
// Watcher events and reconciliation
// ---------------------------------------------------------------------------------------

test("created, modified and deleted files reach only their loaded folder", async () => {
  const { fs, provider, events, id, names } = setup(["/w/src/a.ts", "/w/src/b.ts", "/w/lib/c.ts"]);
  await provider.loadChildren(id("/w"));
  await provider.loadChildren(id("/w/src"));
  await provider.loadChildren(id("/w/lib"));
  const lib = provider.projection()!.children![0];
  fs.listed.length = 0;
  events.length = 0;

  fs.add("/w/src/new.ts");
  fs.touch("/w/src/a.ts");
  fs.remove("/w/src/b.ts");
  const result = await provider.applyResourceChanges([
    { kind: "created", path: "/w/src/new.ts" },
    { kind: "modified", path: "/w/src/a.ts" },
    { kind: "deleted", path: "/w/src/b.ts" },
    { kind: "modified", path: "/w/src/a.ts" }, // a duplicate in the same burst
  ]);
  assert.equal(result.relisted, 1);
  assert.deepEqual(fs.listed, ["/w/src"], "one listing for the whole burst");
  assert.deepEqual(names("/w/src"), ["a.ts", "new.ts"]);
  // In listing order: a.ts (changed) comes before new.ts (created).
  assert.deepEqual(events.map((event) => event.type).sort(), [
    "changed",
    "childrenChanged",
    "created",
    "deleted",
  ]);
  assert.equal(provider.projection()!.children![0], lib, "an unrelated folder is not rebuilt");
});

test("changes inside folders that are not loaded cost nothing", async () => {
  const { fs, provider, id } = setup(["/w/node_modules/x/index.js", "/w/a.ts"]);
  await provider.loadChildren(id("/w"));
  fs.listed.length = 0;
  const result = await provider.applyResourceChanges([
    { kind: "created", path: "/w/node_modules/x/new.js" },
    { kind: "modified", path: "/w/node_modules/x/index.js" },
  ]);
  assert.equal(result.relisted, 0);
  assert.deepEqual(fs.listed, []);
});

test("a rename keeps the node's loaded subtree and hands its state to the new identity", async () => {
  const { fs, provider, events, id, names } = setup(["/w/src/deep/x.ts", "/w/src/a.ts"]);
  const store = createExplorerStore(provider);
  store.attach();
  await provider.loadChildren(id("/w"));
  await provider.loadChildren(id("/w/src"));
  await provider.loadChildren(id("/w/src/deep"));
  store.setExpanded(new Set(["/w", "/w/src", "/w/src/deep"].map((path) => provider.idFor(path))));
  store.setSelection(new Set(["/w/src/deep/x.ts"].map((path) => provider.idFor(path))));
  store.setFocused(provider.idFor("/w/src/deep/x.ts"));
  events.length = 0;
  fs.listed.length = 0;

  fs.rename("/w/src", "/w/lib");
  await provider.applyResourceChanges([{ kind: "renamed", from: "/w/src", path: "/w/lib" }]);
  assert.equal(events[0].type, "renamed");
  assert.deepEqual(names("/w"), ["lib"]);
  assert.deepEqual(names("/w/lib/deep"), ["x.ts"], "still loaded, under its new identity");
  assert.equal(provider.getNode(id("/w/src")), undefined);
  assert.deepEqual([...store.paths("expanded")].sort(), ["/w", "/w/lib", "/w/lib/deep"]);
  assert.deepEqual([...store.paths("selection")], ["/w/lib/deep/x.ts"]);
  assert.equal(store.focusedPath(), "/w/lib/deep/x.ts");
  assert.equal(store.focused(), provider.idFor("/w/lib/deep/x.ts"));
  assert.ok(store.has("selection", provider.idFor("/w/lib/deep/x.ts")));
  assert.deepEqual(fs.listed, ["/w"], "confirmed by one listing of the parent");
  assert.ok(
    !events.some((event) => event.type === "deleted"),
    "not a delete and an unrelated create",
  );
});

test("a move to another loaded folder, and a move to one that is not loaded", async () => {
  const { fs, provider, id, names } = setup(["/w/a/f.ts", "/w/b/g.ts", "/w/c/h.ts"]);
  const store = createExplorerStore(provider);
  store.attach();
  for (const path of ["/w", "/w/a", "/w/b"]) await provider.loadChildren(id(path));
  store.setSelection(new Set(["/w/a/f.ts"].map((path) => provider.idFor(path))));
  fs.rename("/w/a/f.ts", "/w/b/f.ts");
  await provider.applyResourceChanges([{ kind: "renamed", from: "/w/a/f.ts", path: "/w/b/f.ts" }]);
  assert.deepEqual(names("/w/a"), []);
  assert.deepEqual(names("/w/b"), ["f.ts", "g.ts"]);
  assert.deepEqual([...store.paths("selection")], ["/w/b/f.ts"]);
  // Into /w/c, never listed: nothing known there, but the selection still follows.
  fs.rename("/w/b/f.ts", "/w/c/f.ts");
  await provider.applyResourceChanges([{ kind: "renamed", from: "/w/b/f.ts", path: "/w/c/f.ts" }]);
  assert.deepEqual(names("/w/b"), ["g.ts"]);
  assert.deepEqual(provider.childrenState(id("/w/c")), { status: "unloaded" });
  assert.deepEqual([...store.paths("selection")], ["/w/c/f.ts"]);
});

test("a deleted folder takes its UI state with it", async () => {
  const { fs, provider, id } = setup(["/w/src/a.ts", "/w/b.ts"]);
  const store = createExplorerStore(provider);
  store.attach();
  await provider.loadChildren(id("/w"));
  await provider.loadChildren(id("/w/src"));
  store.setExpanded(new Set(["/w", "/w/src"].map((path) => provider.idFor(path))));
  store.setSelection(new Set(["/w/src/a.ts", "/w/b.ts"].map((path) => provider.idFor(path))));
  fs.remove("/w/src");
  await provider.applyResourceChanges([{ kind: "deleted", path: "/w/src" }]);
  assert.equal(provider.getNode(id("/w/src/a.ts")), undefined);
  assert.deepEqual([...store.paths("expanded")], ["/w"]);
  assert.deepEqual([...store.paths("selection")], ["/w/b.ts"]);
});

test("lost notifications re-list every loaded folder inside the rescanned one, and nothing else", async () => {
  const { fs, provider, id, names } = setup(["/w/src/a/x.ts", "/w/lib/y.ts"]);
  for (const path of ["/w", "/w/src", "/w/src/a", "/w/lib"]) await provider.loadChildren(id(path));
  fs.listed.length = 0;
  fs.add("/w/src/a/new.ts");
  await provider.applyResourceChanges([], ["/w/src"]);
  assert.deepEqual([...fs.listed].sort(), ["/w", "/w/src", "/w/src/a"]);
  assert.deepEqual(names("/w/src/a"), ["new.ts", "x.ts"]);
});

test("refresh reconciles: new entries appear, gone ones go, the rest keep their identity", async () => {
  const { fs, provider, id, names } = setup(["/w/src/a.ts", "/w/src/b.ts", "/w/lib/c.ts"]);
  for (const path of ["/w", "/w/src", "/w/lib"]) await provider.loadChildren(id(path));
  const a = provider.getNode(id("/w/src/a.ts"));
  fs.remove("/w/src/b.ts");
  fs.add("/w/src/d.ts");
  fs.listed.length = 0;
  await provider.refresh([id("/w/src")]);
  assert.deepEqual(fs.listed, ["/w/src"], "only the folder asked for");
  assert.deepEqual(names("/w/src"), ["a.ts", "d.ts"]);
  assert.equal(provider.getNode(id("/w/src/a.ts")), a);
  // A refresh that finds nothing new changes nothing, the projection included.
  const before = provider.projection();
  await provider.refresh();
  assert.equal(provider.projection(), before);
});

// ---------------------------------------------------------------------------------------
// Async loading: generations, cancellation, errors
// ---------------------------------------------------------------------------------------

test("an older listing answering after a newer one is dropped", async () => {
  const { fs, provider, id, names } = setup(["/w/src/a.ts"]);
  await provider.loadChildren(id("/w"));
  await provider.loadChildren(id("/w/src"));
  // Generation n sees the folder as it is now -- a.ts only -- and answers late.
  const releaseOld = fs.hold("/w/src");
  const old = provider.refresh([id("/w/src")]);
  await flush();
  // The folder changes; generation n + 1 sees b.ts too, and answers at once.
  fs.add("/w/src/b.ts");
  await provider.refresh([id("/w/src")]);
  assert.deepEqual(names("/w/src"), ["a.ts", "b.ts"]);
  // Now the old answer arrives: dropped, not applied over the newer one.
  releaseOld();
  await old;
  assert.deepEqual(names("/w/src"), ["a.ts", "b.ts"], "the newer answer stands");
  assert.deepEqual(provider.childrenState(id("/w/src")), { status: "loaded" });
});

test("a load abandoned before its answer changes nothing, and a later one still works", async () => {
  const { fs, provider, id, names } = setup(["/w/src/a.ts"]);
  await provider.loadChildren(id("/w"));
  const release = fs.hold("/w/src");
  const controller = new AbortController();
  const loading = provider.loadChildren(id("/w/src"), controller.signal);
  controller.abort(); // collapsed before the answer
  release();
  await loading;
  assert.deepEqual(provider.childrenState(id("/w/src")), { status: "unloaded" });
  await provider.loadChildren(id("/w/src"));
  assert.deepEqual(names("/w/src"), ["a.ts"]);
});

test("one caller giving up does not drop a listing another is waiting on", async () => {
  // As when a view is torn down and set up again (React's development double-mount): the
  // first load is abandoned, the second joins the same listing and must still get it.
  const { fs, provider, id, names } = setup(["/w/src/a.ts"]);
  await provider.loadChildren(id("/w"));
  const release = fs.hold("/w/src");
  const first = new AbortController();
  const abandoned = provider.loadChildren(id("/w/src"), first.signal);
  first.abort();
  const second = provider.loadChildren(id("/w/src"), new AbortController().signal);
  release();
  await Promise.all([abandoned, second]);
  assert.deepEqual(names("/w/src"), ["a.ts"]);
  assert.deepEqual(
    fs.listed.filter((path) => path === "/w/src"),
    ["/w/src"],
    "one listing",
  );
});

test("concurrent loads of one folder share a listing", async () => {
  const { fs, provider, id } = setup(["/w/src/a.ts"]);
  await provider.loadChildren(id("/w"));
  fs.listed.length = 0;
  await Promise.all([
    provider.loadChildren(id("/w/src")),
    provider.loadChildren(id("/w/src")),
    provider.loadChildren(provider.idFor("/w/src/")),
  ]);
  assert.deepEqual(fs.listed, ["/w/src"]);
});

test("a failed listing is an error, never an empty folder, and the provider carries on", async () => {
  const { fs, provider, events, id, names } = setup(["/w/locked/a.ts", "/w/ok/b.ts"]);
  await provider.loadChildren(id("/w"));
  fs.failures.set("/w/locked", "permission denied");
  await assert.rejects(provider.loadChildren(id("/w/locked")), /permission denied/);
  assert.deepEqual(provider.childrenState(id("/w/locked")), {
    status: "failed",
    message: "permission denied",
  });
  assert.deepEqual(names("/w/locked"), ["!permission denied"]);
  assert.equal(provider.projection()!.children![0].loadError, "permission denied");
  assert.ok(events.some((event) => event.type === "error"));
  await provider.loadChildren(id("/w/ok"));
  assert.deepEqual(names("/w/ok"), ["b.ts"], "other folders still load");
  // Retrying after the cause is gone.
  fs.failures.delete("/w/locked");
  await provider.loadChildren(id("/w/locked"));
  assert.deepEqual(names("/w/locked"), ["a.ts"]);
});

test("a refresh that fails keeps what was known and reports the error", async () => {
  const { fs, provider, id, names } = setup(["/w/src/a.ts"]);
  await provider.loadChildren(id("/w"));
  await provider.loadChildren(id("/w/src"));
  fs.failures.set("/w/src", "temporarily unavailable");
  const errors = await provider.refresh([id("/w/src")]);
  assert.deepEqual(errors, ["/w/src: temporarily unavailable"]);
  assert.deepEqual(names("/w/src"), ["a.ts"]);
});

test("a folder removed while its listing was in flight is not grafted back", async () => {
  const { fs, provider, id } = setup(["/w/src/a.ts"]);
  await provider.loadChildren(id("/w"));
  await provider.loadChildren(id("/w/src"));
  const release = fs.hold("/w/src");
  const refreshing = provider.refresh([id("/w/src")]);
  await flush();
  fs.remove("/w/src");
  await provider.applyResourceChanges([{ kind: "deleted", path: "/w/src" }]);
  release();
  await refreshing;
  assert.equal(provider.getNode(id("/w/src")), undefined);
  assert.equal(provider.getNode(id("/w/src/a.ts")), undefined);
});

// ---------------------------------------------------------------------------------------
// Roots
// ---------------------------------------------------------------------------------------

test("roots are added and removed independently", async () => {
  const { provider, events, id, names } = setup(["/a/x.ts", "/b/y.ts", "/c/z.ts"], ["/a", "/b"]);
  await provider.loadChildren(id("/a"));
  const x = provider.getNode(id("/a/x.ts"));
  events.length = 0;
  provider.setRoots(["/a", "/b", "/c"]);
  assert.equal(provider.getNode(id("/a/x.ts")), x, "an existing root keeps what it knew");
  provider.setRoots(["/a", "/c"]);
  assert.equal(provider.getNode(id("/b")), undefined);
  assert.deepEqual(
    provider.getRootNodes().map((node) => node.path),
    ["/a", "/c"],
  );
  assert.deepEqual(names("/a"), ["x.ts"]);
  assert.ok(events.every((event) => event.type === "reset"));
});

test("a listing for a workspace that was left is dropped", async () => {
  const { fs, provider, id } = setup(["/old/a.ts", "/new/b.ts"], ["/old"]);
  const release = fs.hold("/old");
  const loading = provider.loadChildren(id("/old")).catch(() => undefined);
  await flush();
  provider.setRoots(["/new"]);
  await provider.loadChildren(id("/new"));
  release();
  await loading;
  assert.equal(provider.getNode(id("/old/a.ts")), undefined);
  assert.equal(provider.projection()?.path, "/new");
});

// ---------------------------------------------------------------------------------------
// Scale
// ---------------------------------------------------------------------------------------

for (const total of [10_000, 100_000, 500_000]) {
  test(`${total.toLocaleString()} files: one change re-lists one folder and rebuilds one path`, async () => {
    const perFolder = 1000;
    const folders = total / perFolder;
    const fs = fakeFs();
    const paths: string[] = [];
    for (let f = 0; f < folders; f++)
      for (let n = 0; n < perFolder; n++) paths.push(`/w/d${f}/f${n}.ts`);
    for (const path of paths) fs.add(path);
    const provider = createFileSystemExplorerProvider(fs.io);
    provider.setRoots(["/w"]);
    let started = performance.now();
    await provider.loadChildren(provider.idFor("/w"));
    for (let f = 0; f < folders; f++) await provider.loadChildren(provider.idFor(`/w/d${f}`));
    const loaded = performance.now() - started;
    assert.equal(provider.size(), total + folders + 1);
    const before = provider.projection()!;

    fs.add(`/w/d7/new.ts`);
    fs.listed.length = 0;
    started = performance.now();
    await provider.applyResourceChanges([{ kind: "created", path: "/w/d7/new.ts" }]);
    const after = provider.projection()!;
    const change = performance.now() - started;

    assert.deepEqual(fs.listed, ["/w/d7"]);
    assert.notEqual(after, before, "the root is rebuilt: its descendant changed");
    const changed = after.children!.filter((child, index) => child !== before.children![index]);
    assert.deepEqual(
      changed.map((child) => child.path),
      ["/w/d7"],
      "every other folder is the same object",
    );
    console.log(
      `${total.toLocaleString()} files: loaded in ${loaded.toFixed(0)} ms; ` +
        `one change applied and projected in ${change.toFixed(1)} ms`,
    );
    // One folder of 1,000 entries re-listed, plus one path to the root: bounded by the
    // folder, not the tree.
    assert.ok(change < 250, `${change} ms`);
  });
}

// ---------------------------------------------------------------------------------------
// Module 08: view keys, several roots, reveal, retry
// ---------------------------------------------------------------------------------------

test("a node's view key survives renames, moves and refreshes; its id follows the resource", async () => {
  const { fs, provider, id } = setup(["/w/src/a.ts", "/w/lib/"]);
  for (const path of ["/w", "/w/src", "/w/lib"]) await provider.loadChildren(id(path));
  const key = (path: string) => {
    const top = provider.projections()[0].children as ProjectedNode[];
    const all = top.flatMap((child) => [child, ...((child.children ?? []) as ProjectedNode[])]);
    return all.find((node) => node.path === path)?.key;
  };
  const before = key("/w/src/a.ts");
  assert.ok(before);
  await provider.refresh();
  assert.equal(key("/w/src/a.ts"), before, "a refresh does not re-key");
  fs.rename("/w/src/a.ts", "/w/lib/b.ts");
  await provider.applyResourceChanges([
    { kind: "renamed", from: "/w/src/a.ts", path: "/w/lib/b.ts" },
  ]);
  assert.equal(key("/w/lib/b.ts"), before, "the same view element, moved and renamed");
  assert.equal(provider.getNode(id("/w/lib/b.ts"))?.id, id("/w/lib/b.ts"), "a new resource id");
});

test("every root is projected, loaded or not, and the array is kept while nothing changes", async () => {
  const { fs, provider, id } = setup(["/a/x.ts", "/b/y.ts"], ["/a", "/b"]);
  await provider.loadChildren(id("/a"));
  const first = provider.projections();
  assert.deepEqual(
    first.map((root) => [root.path, root.children === null]),
    [
      ["/a", false],
      ["/b", true],
    ],
  );
  assert.equal(provider.projections(), first, "the same array");
  fs.failures.set("/b", "offline");
  await assert.rejects(provider.loadChildren(id("/b")));
  assert.equal(provider.projections()[1].loadError, "offline", "a root can fail on its own");
  assert.equal(provider.projections()[0], first[0], "and the other root is untouched");
});

test("ancestors are worked out from the path, under the innermost root", () => {
  const { provider, id } = setup([], ["/w", "/w/nested", "/v"]);
  assert.deepEqual(provider.ancestorsOf("/w/src/deep/a.ts"), {
    root: id("/w"),
    folders: ["/w/src", "/w/src/deep"],
  });
  assert.deepEqual(provider.ancestorsOf("/w/nested/x/y.ts"), {
    root: id("/w/nested"),
    folders: ["/w/nested/x"],
  });
  assert.deepEqual(provider.ancestorsOf("/w/top.ts"), { root: id("/w"), folders: [] });
  assert.equal(provider.ancestorsOf("/elsewhere/a.ts"), null);
});

test("retry lists a never-listed folder, or re-lists one whose refresh failed", async () => {
  const { fs, provider, id, names } = setup(["/w/src/a.ts"]);
  await provider.loadChildren(id("/w"));
  fs.failures.set("/w/src", "denied");
  await assert.rejects(provider.loadChildren(id("/w/src")));
  assert.equal(await provider.retry(id("/w/src")), "denied", "still failing, and says why");
  fs.failures.delete("/w/src");
  assert.equal(await provider.retry(id("/w/src")), null);
  assert.deepEqual(names("/w/src"), ["a.ts"]);
  fs.failures.set("/w/src", "gone quiet");
  await provider.refresh([id("/w/src")]);
  assert.equal(
    provider.projections()[0].children![0].loadError,
    "gone quiet",
    "shown on a loaded folder",
  );
  fs.failures.delete("/w/src");
  assert.equal(await provider.retry(id("/w/src")), null);
  assert.equal(provider.projections()[0].children![0].loadError, undefined);
});

test("reveal expands and lists the folders above a file, then selects and focuses it", async () => {
  const { fs, provider, id } = setup(["/w/src/deep/x.ts", "/w/other.ts"]);
  const store = createExplorerStore(provider);
  store.attach();
  await provider.loadChildren(id("/w"));
  fs.listed.length = 0;
  assert.equal(await store.reveal("/w/src/deep/x.ts"), true);
  assert.deepEqual(fs.listed, ["/w/src", "/w/src/deep"], "the unloaded folders, outermost first");
  for (const path of ["/w", "/w/src", "/w/src/deep"])
    assert.ok(store.has("expanded", id(path)), path);
  assert.deepEqual([...store.ids("selection")], [id("/w/src/deep/x.ts")]);
  assert.equal(store.focused(), id("/w/src/deep/x.ts"));
  assert.equal(store.anchor(), id("/w/src/deep/x.ts"));
  assert.equal(await store.reveal("/elsewhere/a.ts"), false, "outside every root");
  assert.equal(await store.reveal("/w/src/missing.ts"), false, "not there");
});

test("reveal works across roots, and after a rename", async () => {
  const { fs, provider, id } = setup(["/a/x.ts", "/b/lib/y.ts"], ["/a", "/b"]);
  const store = createExplorerStore(provider);
  store.attach();
  assert.equal(await store.reveal("/b/lib/y.ts"), true);
  assert.equal(store.focused(), id("/b/lib/y.ts"));
  fs.rename("/b/lib/y.ts", "/b/lib/z.ts");
  await provider.applyResourceChanges([
    { kind: "renamed", from: "/b/lib/y.ts", path: "/b/lib/z.ts" },
  ]);
  assert.equal(store.focused(), id("/b/lib/z.ts"), "focus followed the rename");
  assert.equal(await store.reveal("/b/lib/z.ts"), true);
  assert.deepEqual([...store.ids("selection")], [id("/b/lib/z.ts")]);
});

test("a newer reveal supersedes one still listing", async () => {
  const { fs, provider, id } = setup(["/w/slow/a.ts", "/w/fast/b.ts"]);
  const store = createExplorerStore(provider);
  store.attach();
  await provider.loadChildren(id("/w"));
  const release = fs.hold("/w/slow");
  const older = store.reveal("/w/slow/a.ts");
  await flush();
  assert.equal(await store.reveal("/w/fast/b.ts"), true);
  release();
  assert.equal(await older, false);
  assert.deepEqual(
    [...store.ids("selection")],
    [id("/w/fast/b.ts")],
    "the older one changed nothing",
  );
});

test("the store is seeded from the session and keeps entries it cannot resolve yet", () => {
  const { provider, id } = setup(["/w/src/a.ts"]);
  const store = createExplorerStore(provider, {
    expanded: ["/w", "/w/src"],
    selection: ["/w/src/a.ts"],
    focused: "/w/src/a.ts",
  });
  assert.ok(store.has("expanded", id("/w/src")), "known before /w is even listed");
  assert.deepEqual([...store.paths("selection")], ["/w/src/a.ts"]);
  assert.equal(store.focused(), id("/w/src/a.ts"));
  store.setExpanded((previous) => new Set([...previous].filter((one) => one !== id("/w/src"))));
  assert.deepEqual([...store.paths("expanded")], ["/w"]);
});

test("moving the selection does not hand out a new expanded set -- the tree is not re-flattened", async () => {
  const { provider, id } = setup(["/w/a.ts", "/w/b.ts"]);
  const store = createExplorerStore(provider, { expanded: ["/w"] });
  store.attach();
  await provider.loadChildren(id("/w"));
  const expanded = store.ids("expanded");
  store.setSelection(new Set([id("/w/a.ts")]));
  store.setFocused(id("/w/a.ts"));
  store.setAnchor(id("/w/a.ts"));
  store.setSelection(new Set([id("/w/b.ts")]));
  assert.equal(store.ids("expanded"), expanded, "the same object");
  store.setExpanded((previous) => new Set([...previous, id("/w/a.ts")]));
  assert.notEqual(store.ids("expanded"), expanded, "until it really changes");
});
