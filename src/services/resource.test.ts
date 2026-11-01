import assert from "node:assert/strict";
import test from "node:test";
import {
  ResourceError,
  basename,
  containsPath,
  dirname,
  fileUri,
  folderFor,
  formatUri,
  fsPath,
  isAncestor,
  isCaseInsensitive,
  isEqual,
  isEqualOrAncestor,
  joinPath,
  parseUri,
  relative,
  relativePath,
  relativeToFolders,
  resolveWithin,
  resourceId,
  samePathString,
} from "./resource.ts";
import type { ResourceErrorCode, ResourceUri, WorkspaceFolder } from "./resource.ts";

const uri = (path: string) => fileUri(path);
const code = (run: () => unknown): ResourceErrorCode | "none" => {
  try {
    run();
    return "none";
  } catch (error) {
    assert.ok(error instanceof ResourceError, `expected a ResourceError, got ${error}`);
    return error.code;
  }
};

test("every spelling of a Windows path is one resource", () => {
  const spellings = [
    "C:\\Yavin\\src\\main.ts",
    "c:\\Yavin\\src\\main.ts",
    "C:/Yavin/src/main.ts",
    "c:/yavin/SRC/main.ts",
    "\\\\?\\C:\\Yavin\\src\\main.ts",
  ];
  const ids = new Set(spellings.map((path) => resourceId(uri(path))));
  assert.equal(ids.size, 1);
  // The drive letter is canonicalised; every other segment keeps the case it was given.
  assert.equal(fsPath(uri("c:\\Yavin\\src\\main.ts")), "C:/Yavin/src/main.ts");
});

test("extended-length prefixes name the same resource as the plain path", () => {
  assert.equal(fsPath(uri("\\\\?\\C:\\Yavin\\a.ts")), "C:/Yavin/a.ts");
  assert.equal(fsPath(uri("//?/C:/Yavin/a.ts")), "C:/Yavin/a.ts");
  assert.equal(fsPath(uri("\\??\\C:\\Yavin\\a.ts")), "C:/Yavin/a.ts");
  assert.equal(fsPath(uri("\\\\?\\UNC\\server\\share\\a.ts")), "//server/share/a.ts");
  assert.ok(isEqual(uri("\\\\?\\c:\\yavin"), uri("C:/Yavin")));
  // Device paths are not files.
  assert.equal(
    code(() => uri("\\\\.\\PhysicalDrive0")),
    "invalid-path",
  );
});

test("UNC paths keep the server as the authority and the share as the root", () => {
  const file = uri("\\\\server\\share\\project\\src\\main.ts");
  assert.deepEqual(file, {
    scheme: "file",
    authority: "server",
    path: "/share/project/src/main.ts",
  });
  assert.equal(fsPath(file), "//server/share/project/src/main.ts");
  assert.ok(isCaseInsensitive(file));
  assert.ok(isEqual(file, uri("//SERVER/Share/Project/src/MAIN.ts")));
  // The share is the root: nothing above it, and a `..` cannot climb past it.
  const root = uri("\\\\server\\share\\");
  assert.equal(fsPath(root), "//server/share");
  assert.ok(isEqual(dirname(root), root));
  assert.equal(
    code(() => uri("//server/share/..")),
    "invalid-path",
  );
  assert.equal(
    code(() => uri("//server")),
    "invalid-path",
  );
  assert.ok(isAncestor(root, file));
});

test("roots stay roots", () => {
  assert.equal(fsPath(uri("C:\\")), "C:/");
  assert.equal(fsPath(uri("c:")), "C:/");
  assert.equal(fsPath(uri("/")), "/");
  // A UNC path with no server names nothing.
  assert.equal(
    code(() => uri("//")),
    "invalid-path",
  );
  assert.equal(basename(uri("C:/")), "");
  assert.equal(basename(uri("/")), "");
  assert.ok(isEqual(dirname(uri("C:/")), uri("C:/")));
  assert.ok(isEqual(dirname(uri("/")), uri("/")));
  assert.ok(isAncestor(uri("C:/"), uri("C:/a")));
  assert.ok(isAncestor(uri("/"), uri("/a")));
});

test("separators, repeated separators, dots and trailing separators are settled", () => {
  assert.equal(fsPath(uri("C:/a//b/./c/")), "C:/a/b/c");
  assert.equal(fsPath(uri("/work/./src/../lib")), "/work/lib");
  assert.equal(fsPath(uri("C:\\a/b\\c")), "C:/a/b/c");
  assert.equal(
    code(() => uri("/..")),
    "invalid-path",
  );
  assert.equal(
    code(() => uri("C:/a/../..")),
    "invalid-path",
  );
});

test("a relative path needs an explicit base", () => {
  const base = uri("C:/Yavin");
  assert.equal(fsPath(fileUri("src/main.ts", base)), "C:/Yavin/src/main.ts");
  assert.equal(fsPath(fileUri("./src/main.ts", base)), "C:/Yavin/src/main.ts");
  assert.equal(fsPath(fileUri("../src/main.ts", base)), "C:/src/main.ts");
  assert.equal(fsPath(fileUri("src\\main.ts", uri("/work"))), "/work/src/main.ts");
  // An absolute path ignores the base.
  assert.equal(fsPath(fileUri("D:/other", base)), "D:/other");
  assert.equal(
    code(() => fileUri("src/main.ts")),
    "missing-base",
  );
  assert.equal(
    code(() => fileUri("./a")),
    "missing-base",
  );
  // `C:foo` is relative to the current directory of drive C, which has no fixed meaning.
  assert.equal(
    code(() => fileUri("C:foo", base)),
    "invalid-path",
  );
  assert.equal(
    code(() => fileUri("")),
    "invalid-path",
  );
  assert.equal(
    code(() => fileUri("/a\0b")),
    "invalid-path",
  );
});

test("Windows paths compare case-insensitively and POSIX paths exactly", () => {
  assert.ok(isEqual(uri("C:/Work/A.ts"), uri("c:/work/a.ts")));
  assert.ok(!isEqual(uri("/work/README"), uri("/work/Readme")));
  assert.ok(isCaseInsensitive(uri("D:/x")));
  assert.ok(!isCaseInsensitive(uri("/home/x")));
  assert.notEqual(resourceId(uri("/work/README")), resourceId(uri("/work/Readme")));
});

test("ancestry is decided per segment, never by string prefix", () => {
  const src = uri("C:/Yavin/src");
  assert.ok(isAncestor(src, uri("C:/Yavin/src/main.ts")));
  assert.ok(isAncestor(src, uri("C:/Yavin/src/components")));
  assert.ok(isAncestor(src, uri("C:/Yavin/src/components/App.tsx")));
  assert.ok(!isAncestor(src, uri("C:/Yavin/src2")));
  assert.ok(!isAncestor(src, uri("C:/Yavin/src2/main.ts")));
  assert.ok(!isAncestor(src, src), "a resource is not its own strict ancestor");
  assert.ok(isEqualOrAncestor(src, src));
  assert.ok(isAncestor(uri("c:/yavin"), src));
  assert.ok(!isAncestor(uri("/Yavin"), uri("/yavin/src")));
});

test("relative paths come out in the child's spelling", () => {
  assert.equal(
    relative(uri("C:/Projects/Yavin"), uri("c:/projects/yavin/src/main.ts")),
    "src/main.ts",
  );
  assert.equal(relative(uri("C:/Projects/Yavin"), uri("C:/Projects/Yavin")), ".");
  assert.equal(relative(uri("C:/Projects/Yavin"), uri("C:/Projects/Yavin2/a")), undefined);
  assert.equal(relative(uri("/work"), uri("/work-two/a")), undefined);
});

test("joining, dirname and basename", () => {
  const src = uri("C:/Yavin/src");
  assert.equal(fsPath(joinPath(src, "components", "App.tsx")), "C:/Yavin/src/components/App.tsx");
  assert.equal(fsPath(joinPath(src, "a/b")), "C:/Yavin/src/a/b");
  assert.equal(fsPath(joinPath(src, "..", "lib")), "C:/Yavin/lib");
  // A root already ends in its separator: `/` + `a` is `/a`, never the UNC-looking `//a`.
  assert.equal(fsPath(joinPath(uri("/"), "a")), "/a");
  assert.equal(fsPath(joinPath(uri("C:/"), "a")), "C:/a");
  assert.equal(fsPath(fileUri("a", uri("/"))), "/a");
  assert.equal(
    code(() => joinPath(src, "/etc")),
    "invalid-path",
  );
  assert.equal(
    code(() => joinPath(src, "D:/x")),
    "invalid-path",
  );
  assert.equal(fsPath(dirname(uri("C:/Yavin/src/main.ts"))), "C:/Yavin/src");
  assert.equal(fsPath(dirname(uri("C:/Yavin"))), "C:/");
  assert.equal(fsPath(dirname(uri("/work"))), "/");
  assert.equal(fsPath(dirname(uri("//server/share/a"))), "//server/share");
  assert.equal(basename(uri("C:/Yavin/src/main.ts")), "main.ts");
  assert.equal(basename(uri("//server/share")), "");
});

test("resolving inside a folder refuses anything that lands outside it", () => {
  const workspace = uri("C:/workspace");
  assert.equal(fsPath(resolveWithin(workspace, "src/a.ts")), "C:/workspace/src/a.ts");
  assert.equal(fsPath(resolveWithin(workspace, "c:/WORKSPACE/src/a.ts")), "C:/WORKSPACE/src/a.ts");
  assert.equal(fsPath(resolveWithin(workspace, "src/../b.ts")), "C:/workspace/b.ts");
  assert.equal(
    code(() => resolveWithin(workspace, "src/../../outside.ts")),
    "outside-folder",
  );
  assert.equal(
    code(() => resolveWithin(workspace, "C:/workspace2/src/a.ts")),
    "outside-folder",
  );
  assert.equal(
    code(() => resolveWithin(workspace, "D:/a.ts")),
    "outside-folder",
  );
  // Outside is only an error when a folder's child was asked for.
  assert.equal(fsPath(fileUri("src/../../outside.ts", workspace)), "C:/outside.ts");
});

test("several workspace folders stay distinguishable, and the innermost one wins", () => {
  const folders: WorkspaceFolder[] = [
    { uri: uri("C:/folderA"), name: "folderA", index: 0 },
    { uri: uri("C:/folderB"), name: "folderB", index: 1 },
    { uri: uri("C:/folderA/packages/inner"), name: "inner", index: 2 },
  ];
  assert.equal(folderFor(uri("C:/folderA/src/a.ts"), folders)?.name, "folderA");
  assert.equal(folderFor(uri("c:/folderb/src/b.ts"), folders)?.name, "folderB");
  assert.equal(folderFor(uri("C:/folderA/packages/inner/x.ts"), folders)?.name, "inner");
  assert.equal(folderFor(uri("C:/folderAB/x.ts"), folders), undefined);
  assert.deepEqual(relativeToFolders(uri("C:/folderB/src/b.ts"), folders), {
    folder: folders[1],
    path: "src/b.ts",
  });
  assert.equal(relativeToFolders(uri("C:/folderA"), folders)?.path, ".");
  assert.equal(relativeToFolders(uri("D:/x"), folders), undefined);
});

test("file URIs serialise deterministically and parse back to the same resource", () => {
  const cases: [string, string][] = [
    ["C:/Yavin/src/main.ts", "file:///C:/Yavin/src/main.ts"],
    ["C:/a b/#1/100%.ts", "file:///C:/a%20b/%231/100%25.ts"],
    ["//server/share/a b.ts", "file://server/share/a%20b.ts"],
    ["/home/me/a.ts", "file:///home/me/a.ts"],
    ["/a:", "file:///a%3A"],
    ["C:/", "file:///C:/"],
    ["/", "file:///"],
  ];
  for (const [path, text] of cases) {
    const resource = uri(path);
    assert.equal(formatUri(resource), text, path);
    assert.deepEqual(parseUri(text), resource, text);
    assert.equal(formatUri(parseUri(formatUri(resource))), text);
  }
  // Other spellings of the same URI parse to the same canonical resource.
  assert.deepEqual(parseUri("file:///c:/Yavin/src/main.ts"), uri("C:/Yavin/src/main.ts"));
  assert.deepEqual(parseUri("file://localhost/home/me/a.ts"), uri("/home/me/a.ts"));
  assert.deepEqual(parseUri("FILE:///home/./me/../me/a.ts"), uri("/home/me/a.ts"));
  // A POSIX name with a colon is not a drive.
  assert.equal(fsPath(parseUri("file:///a%3A/b")), "/a:/b");
});

test("malformed and foreign URIs are refused by name", () => {
  assert.equal(
    code(() => parseUri("ssh://host/workspace/a.ts")),
    "unsupported-scheme",
  );
  assert.equal(
    code(() => parseUri("untitled:1")),
    "unsupported-scheme",
  );
  // A drive letter is not a one-letter scheme: this is a path, and belongs in fileUri.
  assert.equal(
    code(() => parseUri("C:/not/a/uri")),
    "invalid-uri",
  );
  assert.equal(
    code(() => parseUri("no scheme")),
    "invalid-uri",
  );
  assert.equal(
    code(() => parseUri("file:/x")),
    "invalid-uri",
  );
  assert.equal(
    code(() => parseUri("file:///a%E0%A4%A")),
    "invalid-uri",
  );
});

test("string comparison tolerates the spellings that arrive, without parsing", () => {
  assert.equal(relativePath("C:/Work", "c:\\work\\src\\a.ts"), "src/a.ts");
  assert.equal(relativePath("C:/Work/", "C:/Work/a"), "a");
  assert.equal(relativePath("\\\\?\\C:\\Work", "C:/Work/a"), "a");
  assert.equal(relativePath("/work", "/work"), ".");
  assert.equal(relativePath("/work", "/work-two/a"), undefined);
  assert.equal(relativePath("/Work", "/work/a"), undefined);
  assert.equal(relativePath("C:/", "C:/a/b"), "a/b");
  assert.equal(relativePath("/", "/a"), "a");
  assert.equal(relativePath("//server/share", "//SERVER/share/a"), "a");
  assert.equal(relativePath("", "/a"), undefined);
  assert.equal(relativePath("/a", ""), undefined);
  assert.ok(containsPath("C:/Work", "C:/Work"));
  assert.ok(!containsPath("C:/Work", "C:/Workshop"));
  assert.ok(samePathString("C:\\Work\\", "c:/work"));
  assert.ok(!samePathString("/work", "/Work"));
});

// ---------------------------------------------------------------------------------------
// Properties, over generated paths. A fixed seed keeps a failure reproducible.
// ---------------------------------------------------------------------------------------

function generator(seed: number) {
  let state = seed >>> 0;
  const next = () => {
    // mulberry32
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pick = <T>(items: readonly T[]) => items[Math.floor(next() * items.length)];
  return { next, pick };
}

const NAMES = ["src", "Src", "a", "A", "main.ts", "lib", "x y", "ü", "src2", "node_modules"];
const ROOTS = ["C:", "d:", "//server/share", "", "/home"];

/** A random absolute path, and a random respelling of it that must be the same resource. */
function samplePath(random: ReturnType<typeof generator>) {
  const root = random.pick(ROOTS);
  const parts = Array.from({ length: Math.floor(random.next() * 5) }, () => random.pick(NAMES));
  const plain = `${root}/${parts.join("/")}`;
  const windows = root !== "" && root !== "/home";
  let respelled = parts.map((part) => (windows && random.next() < 0.3 ? part.toUpperCase() : part));
  if (random.next() < 0.3) respelled = respelled.flatMap((part) => [part, ".", part, ".."]);
  let alt = `${windows && random.next() < 0.5 ? root.toUpperCase() : root}/${respelled.join("/")}`;
  if (windows && random.next() < 0.5) alt = alt.replace(/\//g, "\\");
  if (windows && root.length === 2 && random.next() < 0.3)
    alt = `\\\\?\\${alt.replace(/\//g, "\\")}`;
  // Not after a bare root: `/` + `/` is `//`, which is UNC rather than a respelling of `/`.
  if (parts.length && random.next() < 0.3) alt += "/";
  return { plain, alt };
}

test("properties: identity is reflexive, symmetric, stable and agrees with its id", () => {
  const random = generator(0x59a7);
  const seen: ResourceUri[] = [];
  for (let round = 0; round < 2000; round++) {
    const { plain, alt } = samplePath(random);
    const a = uri(plain);
    const b = uri(alt);
    assert.ok(isEqual(a, a), plain);
    assert.ok(isEqual(a, b), `${plain} vs ${alt}`);
    assert.equal(isEqual(a, b), isEqual(b, a));
    assert.equal(resourceId(a), resourceId(uri(plain)));
    assert.ok(!isAncestor(a, a), plain);
    // The id and isEqual never disagree, including for paths that are different resources.
    const other = seen[Math.floor(random.next() * seen.length)];
    if (other) assert.equal(resourceId(a) === resourceId(other), isEqual(a, other));
    // What goes out as a URI comes back as the same resource.
    assert.ok(isEqual(parseUri(formatUri(a)), a), plain);
    // Relative and join are inverses for anything inside.
    const parent = dirname(a);
    const rel = relative(parent, a);
    if (rel && rel !== ".") assert.ok(isEqual(joinPath(parent, rel), a), plain);
    seen.push(a);
  }
});
