#!/usr/bin/env node
/**
 * EXT-28: the expected answers for the extension host's runtime tests, taken from Node.js (whose
 * URL parser follows the WHATWG URL Standard and whose Intl is ICU's). The host's own
 * implementations (`ide-plugin-host/src/web.js`, `intl.js`, the `url` module in `vscode.js`) are
 * run on the same inputs by `ide-plugin-host/tests/runtime.rs` and must answer the same.
 *
 *   node scripts/runtime-vectors.mjs [--check]
 *
 * Writes `src-tauri/crates/ide-plugin-host/tests/fixtures/runtime-vectors.json`; with `--check`,
 * says whether that file is what this Node.js would write. Run on Windows (the `url` module's
 * file paths are Windows'), with Node.js 22 or later.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as nodeUrl from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "src-tauri/crates/ide-plugin-host/tests/fixtures/runtime-vectors.json");

// --- URL parsing: [input, base?] ----------------------------------------------------------------
const PARSE = [
  ["http://example.com/"],
  ["HTTP://EXAMPLE.COM/A/B?Q=1#F"],
  ["https://user:pass@example.com:8080/p/a/t/h?query=string#hash"],
  ["https://example.com:443/"],
  ["http://example.com:80/"],
  ["ws://example.com:80/"],
  ["ftp://example.com:21/x"],
  ["http://example.com:65535/"],
  ["http://example.com:65536/"],
  ["http://example.com:8x/"],
  ["http://[::1]:8080/"],
  ["http://[2001:db8:0:0:0:0:2:1]/"],
  ["http://[2001:DB8::1]/"],
  ["http://[::ffff:192.168.0.1]/"],
  ["http://[1:2:3:4:5:6:7:8]/"],
  ["http://[1::2::3]/"],
  ["http://[::1/"],
  ["http://192.168.0.1/"],
  ["http://0x7f.1/"],
  ["http://0177.0.0.1/"],
  ["http://4294967295/"],
  ["http://4294967296/"],
  ["http://1.2.3.4.5/"],
  ["http://1.2.3.256/"],
  ["http://999999999999/"],
  ["http://foo.0x/"],
  ["http://foo.09/"],
  ["http://exa mple.com/"],
  ["http://exa%20mple.com/"],
  ["http://ex%41mple.com/"],
  ["http://example.com./"],
  ["http://EXAMPLE.com%2e/"],
  ["http://bücher.de/"],
  ["http://BÜCHER.de/"],
  ["http://faß.de/"],
  ["http://xn--bcher-kva.de/"],
  ["http://xn--a.com/"],
  ["http://例え.テスト/"],
  ["http://ex\u3002ample.com/"],
  ["http://a/b/c/./../../g"],
  ["http://a/b/c/%2e%2E/d"],
  ["http://a/b/c/.%2e/d"],
  ["http://a/./b/../../c"],
  ['http://example.com/a b/c"d<e>f`g{h}i^j|k'],
  ['http://example.com/?a b"c<d>e#f g"h`i'],
  ["http://example.com/?'quote'"],
  ["foo://example.com/?'quote'"],
  ["http://example.com/\u00e9?\u00e9#\u00e9"],
  ["http://example.com/\ud83d\ude00"],
  ["http://example.com/%zz%2"],
  ["http:\\\\example.com\\a\\b"],
  ["http:example.com/a"],
  ["http:/example.com/a"],
  ["http:///example.com/a"],
  ["  http://example.com/  "],
  ["http://exa\tmp\nle.com/a\rb"],
  ["http://user@/"],
  ["http://@example.com/"],
  ["http://a:b@c:d@example.com/"],
  ["http://us er:pa:ss@example.com/"],
  ["http://user%40x@example.com/"],
  ["http://"],
  ["http://#frag"],
  ["https://example.com#"],
  ["https://example.com?"],
  ["https://example.com/?#"],
  ["file:///C:/path/to/file.txt"],
  ["file:///c|/path/file.txt"],
  ["file:C:/x"],
  ["file:/C:/x"],
  ["file://localhost/C:/x"],
  ["file://LOCALHOST/x"],
  ["file://server/share/file"],
  ["file:///C:/a/../../b"],
  ["file:///C:/a/b/../../../c"],
  ["file:///etc/passwd"],
  ["file://"],
  ["file:"],
  ["file:..\\x"],
  ["vscode:extension/acme.probe"],
  ["vscode://acme.probe/path?x=1"],
  ["untitled:Untitled-1"],
  ["mailto:someone@example.com?subject=Hi there"],
  ["data:text/plain,hello world"],
  ["javascript:alert(1)"],
  ["sc:///a"],
  ["sc://host/a?b#c"],
  ["sc://ho st/"],
  ["sc://[::1]/"],
  ["sc://%41/"],
  ["sc:a b ?q"],
  ["sc:a b #f"],
  ["sc:a b"],
  ["a:b:c"],
  ["blob:https://example.com/uuid"],
  ["blob:foo"],
  ["git+ssh://git@github.com/owner/repo.git"],
  ["c:/x"],
  ["1http://example.com/"],
  [""],
  ["no scheme here"],
  ["//example.com/x", "https://base.org/a/b"],
  ["/x/y?z", "https://base.org/a/b?q#f"],
  ["x/y", "https://base.org/a/b"],
  ["../x", "https://base.org/a/b/c"],
  ["../../../../x", "https://base.org/a/b"],
  ["?q2", "https://base.org/a/b?q#f"],
  ["#f2", "https://base.org/a/b?q#f"],
  ["", "https://base.org/a/b?q#f"],
  ["\\x\\y", "https://base.org/a/b"],
  ["x", "file:///C:/a/b"],
  ["/x", "file:///C:/a/b"],
  ["C:/x", "file:///D:/a/b"],
  ["..", "file:///C:/"],
  ["#x", "sc:opaque"],
  ["x", "sc:opaque"],
  ["x", "sc://host/a/b"],
  ["http:x", "http://base.org/a/b"],
  ["https:x", "http://base.org/a/b"],
  ["x", "not a url"],
  ["x", "about:blank"],
];

const fields = [
  "href",
  "origin",
  "protocol",
  "username",
  "password",
  "host",
  "hostname",
  "port",
  "pathname",
  "search",
  "hash",
];
const parseExpected = PARSE.map(([input, base]) => {
  let url;
  try {
    url = base === undefined ? new URL(input) : new URL(input, base);
  } catch {
    return { input, base: base ?? null, failure: true };
  }
  const record = { input, base: base ?? null, failure: false };
  for (const f of fields) record[f] = url[f];
  record.canParse = URL.canParse(input, base);
  return record;
});

// --- URL setters: [href, field, value] ----------------------------------------------------------
const SET = [
  ["http://example.com/a", "protocol", "https"],
  ["http://example.com/a", "protocol", "foo"],
  ["foo://example.com/a", "protocol", "http"],
  ["http://user@example.com/a", "protocol", "file"],
  ["http://example.com:8080/a", "protocol", "https:"],
  ["https://example.com:443/", "protocol", "http"],
  ["http://example.com/a", "username", "us er@:/"],
  ["http://example.com/a", "password", "p@ss:w/rd"],
  ["file:///C:/a", "username", "x"],
  ["http://example.com/a", "host", "other.org:99"],
  ["http://example.com/a", "host", "other.org:99999"],
  ["http://example.com/a", "host", ""],
  ["sc://example.com/a", "host", ""],
  ["http://example.com:8080/a", "hostname", "other.org"],
  ["http://example.com/a", "hostname", "other.org:99"],
  ["http://example.com/a", "hostname", "[::1]"],
  ["sc:opaque", "hostname", "x"],
  ["http://example.com/a", "port", "8080"],
  ["http://example.com/a", "port", "80"],
  ["http://example.com:8080/a", "port", ""],
  ["http://example.com/a", "port", "12ab"],
  ["http://example.com/a", "port", "ab"],
  ["http://example.com/a", "port", "70000"],
  ["file:///C:/a", "port", "8080"],
  ["http://example.com/a", "pathname", "/x y/../z"],
  ["http://example.com/a", "pathname", "x?y#z"],
  ["sc:opaque", "pathname", "/x"],
  ["file:///C:/a/b", "pathname", "/D:/x"],
  ["http://example.com/a?q", "search", "?x=1 2&y"],
  ["http://example.com/a?q", "search", ""],
  ["http://example.com/a?q", "search", "#notfrag"],
  ["http://example.com/a#f", "hash", "#x y"],
  ["http://example.com/a#f", "hash", ""],
  ["sc:a b #f", "hash", ""],
  ["sc:a b ?q", "search", ""],
  ["http://example.com/a", "href", "https://other.org/b?c"],
];
const setExpected = SET.map(([href, field, value]) => {
  const url = new URL(href);
  url[field] = value;
  return { href, field, value, result: url.href };
});
let hrefFailure;
try {
  new URL("http://x/").href = "not a url";
} catch (e) {
  hrefFailure = { name: e.name, code: e.code };
}

// --- URLSearchParams ---------------------------------------------------------------------------
const PARAMS = [
  "a=1&b=2&a=3",
  "?x=%20y+z&&=e&f",
  "q=%E2%9C%93&bad=%zz&%C3%28=1",
  "a=1;b=2",
  "emoji=\ud83d\ude00&lone=\ud800",
  "",
];
const paramsExpected = PARAMS.map((input) => {
  const p = new URLSearchParams(input);
  return { input, entries: [...p], toString: p.toString(), size: p.size };
});
const ops = (() => {
  const p = new URLSearchParams("b=2&a=1&b=3&c=x y");
  const trace = [];
  p.append("d", "é&=+");
  trace.push(p.toString());
  p.delete("b", "3");
  trace.push(p.toString());
  p.set("b", "9");
  trace.push(p.toString());
  p.sort();
  trace.push(p.toString());
  trace.push([p.get("b"), p.get("zz"), p.getAll("a"), p.has("c"), p.has("c", "nope")]);
  p.delete("c");
  trace.push(p.toString());
  const u = new URL("https://example.com/p?x=1");
  u.searchParams.append("y", "2 3");
  trace.push(u.href);
  u.searchParams.delete("x");
  u.searchParams.delete("y");
  trace.push(u.href);
  u.search = "?z=1";
  trace.push([...u.searchParams]);
  return trace;
})();
const fromRecord = new URLSearchParams({ a: "1", b: "x y" }).toString();
const fromPairs = new URLSearchParams([
  ["a", "1"],
  ["b", "x y"],
]).toString();

// --- Node.js's url module on Windows -----------------------------------------------------------
const TO_URL = [
  "C:\\work\\a b.ts",
  "C:\\work\\dir\\",
  "c:\\x\\%41#?.ts",
  "C:\\a\\..\\b\\.\\c",
  "\\\\server\\share\\f.txt",
  "C:\\é\\ü.txt",
];
const FROM_URL = [
  "file:///C:/work/a%20b.ts",
  "file:///c%3A/work/x",
  "file://server/share/f.txt",
  "file:///C:/a%2Fb",
  "file:///x/y",
  "http://x/y",
];
const toUrlExpected = TO_URL.map((path) => ({ path, href: pathToFileURL(path).href }));
const fromUrlExpected = FROM_URL.map((href) => {
  try {
    return { href, path: fileURLToPath(href) };
  } catch (e) {
    return { href, error: e.code };
  }
});
const domains = ["Bücher.de", "EXAMPLE.com", "xn--bcher-kva.de", "例え.テスト"].map((d) => ({
  domain: d,
  ascii: nodeUrl.domainToASCII(d),
}));

// --- Intl.Collator ----------------------------------------------------------------------------
const WORDS = [
  "a",
  "A",
  "á",
  "Á",
  "à",
  "â",
  "ä",
  "ã",
  "b",
  "B",
  "ab",
  "aB",
  "Ab",
  "AB",
  "a b",
  "a-b",
  "a_b",
  "a.b",
  "ab1",
  "ab2",
  "ab10",
  "ab01",
  "x2",
  "x10",
  "X10",
  "x-1",
  "x 9",
  "résumé",
  "resume",
  "Resume",
  "RÉSUMÉ",
  "coop",
  "co-op",
  "co op",
  "ß",
  "ss",
  "SS",
  "Ss",
  "æ",
  "ae",
  "AE",
  "Æ",
  "ø",
  "o",
  "O",
  "Ø",
  "ñ",
  "n",
  "N",
  "Ñ",
  "é",
  "e",
  "E",
  "É",
  "ê",
  "ë",
  "z",
  "Z",
  "1",
  "10",
  "2",
  "09",
  "!",
  "@",
  "#",
  "_",
  "-",
  " ",
  "",
  "file10.txt",
  "file9.txt",
  "File9.txt",
  "file_9.txt",
  "file-9.txt",
  "zebra",
  "Zebra",
  "apple",
  "Apple",
  "Ápple",
];
const COLLATIONS = [
  {},
  { numeric: true },
  { sensitivity: "base" },
  { sensitivity: "accent" },
  { sensitivity: "case" },
  { numeric: true, sensitivity: "base" },
  { usage: "sort", sensitivity: "variant", numeric: true },
  { caseFirst: "upper" },
  { ignorePunctuation: true },
];
const collatorExpected = COLLATIONS.map((options) => {
  const compare = new Intl.Collator("en", options).compare;
  const signs = WORDS.map((a) => WORDS.map((b) => "<=>"[Math.sign(compare(a, b)) + 1]).join(""));
  return { options, resolved: new Intl.Collator("en", options).resolvedOptions(), signs };
});

// --- Intl.ListFormat --------------------------------------------------------------------------
const lists = [];
for (const type of ["conjunction", "disjunction", "unit"])
  for (const style of ["long", "short", "narrow"]) {
    const f = new Intl.ListFormat("en-US", { type, style });
    lists.push({
      type,
      style,
      results: [[], ["x"], ["x", "y"], ["x", "y", "z"], ["w", "x", "y", "z"]].map((l) =>
        f.format(l),
      ),
      parts: f.formatToParts(["x", "y", "z"]),
    });
  }

// --- Intl.Segmenter (graphemes) ----------------------------------------------------------------
const TEXTS = [
  "abc",
  "e\u0301\u0302x",
  "\r\n\n\r",
  "👍🏽👨‍👩‍👧‍👦🏳️‍🌈",
  "🇺🇸🇫🇷🇩",
  "한국어 ᄀᄀ각",
  "\u1100\u1161\u11a8",
  "क्षत्रिय",
  "न्‍ह",
  "நி",
  "a\u200db",
  "x\u0600y",
  "\u0e01\u0e33",
  "a\u0308\ud83d\ude00\u0308",
  "tab\there",
  "\ud800lone",
];
const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });
const segmentsExpected = TEXTS.map((text) => ({
  text,
  segments: [...segmenter.segment(text)].map((s) => [s.segment, s.index]),
}));

// --- Intl.DateTimeFormat (UTC) -----------------------------------------------------------------
const DATES = [
  Date.UTC(2024, 0, 5, 13, 7, 9, 45),
  Date.UTC(1999, 11, 31, 0, 0, 0),
  Date.UTC(2023, 6, 4, 12, 30, 5),
];
const FORMATS = [
  {},
  { dateStyle: "full" },
  { dateStyle: "long" },
  { dateStyle: "medium" },
  { dateStyle: "short" },
  { timeStyle: "short" },
  { timeStyle: "medium" },
  { timeStyle: "long" },
  { timeStyle: "full" },
  { dateStyle: "medium", timeStyle: "short" },
  { dateStyle: "long", timeStyle: "short" },
  { year: "numeric", month: "long", day: "numeric" },
  { year: "numeric", month: "short" },
  { month: "long", day: "numeric" },
  { month: "2-digit", day: "2-digit", year: "numeric" },
  { weekday: "long" },
  { weekday: "short", month: "short", day: "numeric" },
  { hour: "numeric", minute: "2-digit" },
  { hour: "2-digit", minute: "2-digit", second: "2-digit" },
  { hour: "numeric", minute: "2-digit", hour12: false },
  { hour: "numeric", hourCycle: "h23" },
  { year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric" },
  { hour: "numeric", minute: "2-digit", second: "2-digit", fractionalSecondDigits: 3 },
];
const datesExpected = FORMATS.map((options) => {
  const f = new Intl.DateTimeFormat("en-US", { ...options, timeZone: "UTC" });
  const { locale, calendar, numberingSystem, timeZone, ...rest } = f.resolvedOptions();
  return {
    options,
    resolved: { locale, calendar, numberingSystem, timeZone, ...rest },
    results: DATES.map((d) => f.format(d)),
    parts: f.formatToParts(DATES[0]),
  };
});

const vectors = {
  about:
    "Generated by scripts/runtime-vectors.mjs from Node.js; replayed against Yavin's extension host by tests/runtime.rs.",
  node: process.version,
  url: {
    parse: parseExpected,
    set: setExpected,
    hrefFailure,
    params: paramsExpected,
    ops,
    fromRecord,
    fromPairs,
    toUrl: toUrlExpected,
    fromUrl: fromUrlExpected,
    domains,
  },
  intl: {
    words: WORDS,
    collators: collatorExpected,
    lists,
    segments: segmentsExpected,
    dates: { at: DATES, formats: datesExpected },
  },
};
const text = JSON.stringify(vectors, null, 1) + "\n";
if (process.argv.includes("--check")) {
  const current = readFileSync(out, "utf8");
  const same =
    JSON.stringify({ ...JSON.parse(current), node: null }) ===
    JSON.stringify({ ...vectors, node: null });
  console.log(
    same
      ? "runtime-vectors.json matches this Node.js"
      : "runtime-vectors.json differs from this Node.js",
  );
  process.exit(same ? 0 : 1);
}
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, text);
console.log(
  `wrote ${out}: ${PARSE.length} URLs, ${SET.length} setters, ${COLLATIONS.length} collations of ${WORDS.length} words, ${TEXTS.length} texts, ${FORMATS.length} date formats (Node.js ${process.version})`,
);
