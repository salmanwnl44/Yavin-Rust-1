import assert from "node:assert/strict";
import test from "node:test";
import { headingSlug, resolveMarkdownLink } from "./markdownLinks.ts";

const doc = "D:/Projects/app/docs/README.md";

test("links to files resolve against the document's folder", () => {
  assert.deepEqual(resolveMarkdownLink("GUIDE.md", doc), {
    kind: "file",
    path: "D:/Projects/app/docs/GUIDE.md",
    heading: null,
  });
  assert.deepEqual(resolveMarkdownLink("../src/main.ts#setup", doc), {
    kind: "file",
    path: "D:/Projects/app/src/main.ts",
    heading: "setup",
  });
  assert.deepEqual(resolveMarkdownLink("./a%20b/c.md", "D:\\Projects\\app\\README.md"), {
    kind: "file",
    path: "D:/Projects/app/a b/c.md",
    heading: null,
  });
  // Never above the root.
  assert.equal(
    (resolveMarkdownLink("../../../../../x.md", doc) as { path: string }).path,
    "D:/x.md",
  );
  assert.deepEqual(resolveMarkdownLink("/work/notes.md", "/work/docs/a.md"), {
    kind: "file",
    path: "/work/notes.md",
    heading: null,
  });
});

test("headings stay in the preview, web pages go to the browser, the rest nowhere", () => {
  assert.deepEqual(resolveMarkdownLink("#getting-started", doc), {
    kind: "heading",
    id: "getting-started",
  });
  assert.deepEqual(resolveMarkdownLink("https://example.com/a?b=1", doc), {
    kind: "web",
    url: "https://example.com/a?b=1",
  });
  for (const href of [
    "javascript:alert(1)",
    "mailto:a@b.c",
    "file:///C:/x",
    "data:text/html,x",
    "",
  ])
    assert.deepEqual(resolveMarkdownLink(href, doc), { kind: "none" }, href);
  // An untitled document has no folder: only absolute paths lead anywhere.
  assert.deepEqual(resolveMarkdownLink("GUIDE.md", null), { kind: "none" });
});

test("heading ids are GitHub's", () => {
  assert.equal(headingSlug("Getting Started!"), "getting-started");
  assert.equal(headingSlug("  API: v2 (beta) "), "api-v2-beta");
  assert.equal(headingSlug("Überblick & Ziele"), "überblick--ziele");
});
