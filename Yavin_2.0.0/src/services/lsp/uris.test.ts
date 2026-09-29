import assert from "node:assert/strict";
import test from "node:test";
import { fileUri, resourceId } from "../resource.ts";
import { fromLspUri, lspPath, lspResourceId, toLspUri } from "./uris.ts";

test("a Windows path goes out as RFC 8089 and every server spelling comes back to it", () => {
  const resource = fileUri("C:\\My Project\\src\\Ünï code.ts");
  assert.equal(toLspUri(resource), "file:///C:/My%20Project/src/%C3%9Cn%C3%AF%20code.ts");
  const id = resourceId(resource);
  for (const spelling of [
    toLspUri(resource),
    // vscode-uri: lower-case, encoded drive colon.
    "file:///c%3A/My%20Project/src/%C3%9Cn%C3%AF%20code.ts",
    "file:///c%3a/my%20project/SRC/%C3%9Cn%C3%AF%20code.ts",
    // Unencoded space and Unicode, as some servers write them.
    "file:///C:/My Project/src/Ünï code.ts",
  ])
    assert.equal(lspResourceId(spelling), id, spelling);
  assert.equal(lspPath("file:///c%3A/My%20Project/a.ts"), "C:/My Project/a.ts");
});

test("POSIX and UNC paths, and what is not a file", () => {
  const posix = fileUri("/home/me/a b.rs");
  assert.equal(toLspUri(posix), "file:///home/me/a%20b.rs");
  assert.equal(lspResourceId("file:///home/me/a%20b.rs"), resourceId(posix));
  // POSIX is case-sensitive.
  assert.notEqual(lspResourceId("file:///home/me/A%20b.rs"), resourceId(posix));
  const unc = fileUri("\\\\server\\share\\x.py");
  assert.equal(toLspUri(unc), "file://server/share/x.py");
  assert.equal(lspResourceId("file://SERVER/share/x.py"), resourceId(unc));
  for (const other of ["untitled:Untitled-1", "https://example.com/a.ts", "not a uri", "jdt://x"])
    assert.equal(fromLspUri(other), null, other);
});
