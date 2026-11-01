import assert from "node:assert/strict";
import test from "node:test";
import { Marked } from "marked";
import { footnotes } from "./markdownFootnotes.ts";

const render = (source: string) => {
  const notes = footnotes(source);
  const marked = new Marked({ gfm: true }, notes.extension);
  const body = marked.parse(source, { async: false }) as string;
  return body + notes.section((text) => marked.parseInline(text, { async: false }) as string);
};

test("footnotes are numbered where first referred to, and listed at the end", () => {
  const html = render(
    ["Second[^b] then first[^a], again[^b].", "", "[^a]: The *first* note.", "[^b]: Another."].join(
      "\n",
    ),
  );
  // In order of first reference: b is 1, a is 2; a repeated reference keeps its number.
  assert.match(html, /Second<sup class="footnote-ref"><a href="#fn-b" id="fn-b-ref">1<\/a><\/sup>/);
  assert.match(html, /first<sup class="footnote-ref"><a href="#fn-a" id="fn-a-ref">2<\/a>/);
  assert.equal(html.match(/href="#fn-b"/g)?.length, 2);
  // The notes, inline Markdown rendered, each with a way back; the definitions are not text.
  assert.match(html, /<li id="fn-b">Another\. <a href="#fn-b-ref"/);
  assert.match(html, /<li id="fn-a">The <em>first<\/em> note\./);
  assert.doesNotMatch(html, /\[\^a\]:/);
  assert.ok(html.indexOf('id="fn-b"') < html.indexOf('id="fn-a"'));
});

test("a reference without a note stays text, and no notes means no section", () => {
  const html = render("Missing[^x] here.");
  assert.match(html, /Missing\[\^x\] here\./);
  assert.doesNotMatch(html, /footnotes/);
});
