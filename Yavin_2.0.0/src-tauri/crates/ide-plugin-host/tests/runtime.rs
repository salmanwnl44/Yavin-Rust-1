//! EXT-28: the runtime a VS Code extension's code finds in Yavin's extension host -- `URL`,
//! `URLSearchParams`, the Intl subset, `crypto`'s random values, events and abort signals,
//! `structuredClone`, Node.js's `url` and random `crypto`, the CommonJS loader, timers and
//! promise rejections -- tested in the real host process, under its production limits.
//!
//! Where a reference exists, the answers are Node.js's own (`tests/fixtures/runtime-vectors.json`,
//! from `scripts/runtime-vectors.mjs`): the extension compares, and returns what differed.
mod common;

use common::Host;
use serde_json::{json, Value};

const RUN: &str = "acme.runtime.run-0001";
const MAIN: &str = "extension/out/main.js";
const VECTORS: &str = include_str!("fixtures/runtime-vectors.json");

/// The extension: a command that runs a step (with `require` from its entry point, and `T` for
/// state kept between steps) and returns its value as JSON.
const CODE: &str = r#"
const vscode = require("vscode");
globalThis.T = {};
exports.activate = function (context) {
  context.subscriptions.push(vscode.commands.registerCommand("probe.run", async (step) => {
    const value = await new Function("vscode", "require", "T", "module", "return (async () => {" + step + "})()")(vscode, require, T, module);
    return value === undefined ? null : JSON.parse(JSON.stringify(value));
  }));
};
"#;

/// The production limits (`protocol.rs`): what an extension really has.
fn production() -> Value {
    json!({"memoryBytes": 64 * 1024 * 1024, "loadMs": 5000, "callMs": 2000})
}

struct Ext {
    host: Host,
    id: String,
    next: u32,
    logs: Vec<(String, String)>,
}

impl Ext {
    fn start(files: Value) -> Ext {
        Ext::start_in(Host::start_with(production()), "acme.runtime", files)
    }
    fn start_in(mut host: Host, id: &str, files: Value) -> Ext {
        let mut modules = json!({"extension/package.json": r#"{"publisher": "Acme", "name": "runtime", "version": "1.0.0"}"#, "extension/vectors.json": VECTORS});
        for (k, v) in files.as_object().unwrap() {
            modules[k] = v.clone();
        }
        let run = format!("{id}.run-0001");
        host.to(
            id,
            json!({"type": "load", "code": CODE, "extensionPath": format!("C:/ext/{id}"), "modules": modules, "main": MAIN,
                "vscode": {"api": "vscode", "level": "1.90.0", "entry": "main", "commands": {run: "probe.run"}, "settings": {}, "views": {}, "defaults": {}}}),
        );
        let loaded = host.until(|m| m["type"] == "loaded" || m["type"] == "error");
        assert_eq!(loaded["type"], "loaded", "{loaded}");
        let mut ext = Ext {
            host,
            id: id.into(),
            next: 1,
            logs: Vec::new(),
        };
        let activated = ext.request("activate", json!({}));
        assert_eq!(activated["ok"], true, "{activated}");
        ext
    }
    fn request(&mut self, method: &str, params: Value) -> Value {
        let id = format!("r{}", self.next);
        self.next += 1;
        let ext = self.id.clone();
        self.host.to(
            &ext,
            json!({"type": "request", "requestId": id, "method": method, "params": params}),
        );
        loop {
            let message = self.host.recv();
            match message["type"].as_str() {
                Some("request") => {
                    let result = match message["method"].as_str().unwrap_or("") {
                        "window.state" => json!({"focused": true}),
                        "documents.all" => json!([]),
                        _ => Value::Null,
                    };
                    self.host.to(&ext, json!({"type": "response", "requestId": message["requestId"], "ok": true, "result": result}));
                }
                Some("log") => self.logs.push((
                    message["level"].as_str().unwrap_or("").into(),
                    message["text"].as_str().unwrap_or("").into(),
                )),
                Some("response") if message["requestId"] == json!(id) => return message,
                // The entry itself failed (its deadline, its memory): said at once, not waited for.
                Some("error") => return json!({"ok": false, "error": message["error"]}),
                _ => {}
            }
        }
    }
    fn step(&mut self, code: &str) -> Result<Value, Value> {
        let run = format!("{}.run-0001", self.id);
        let response = self.request("command.run", json!({"id": run, "args": [code]}));
        if response["ok"] == true {
            Ok(response["result"].clone())
        } else {
            Err(response["error"].clone())
        }
    }
    fn ok(&mut self, code: &str) -> Value {
        self.step(code)
            .unwrap_or_else(|e| panic!("the step failed: {e}\n{code}"))
    }
    /// A step that compares and returns what differed: none.
    fn none_differ(&mut self, what: &str, code: &str) {
        let differed = self.ok(code);
        assert_eq!(differed, json!([]), "{what}: these differ from Node.js");
    }
}

#[test]
fn url_parsing_matches_node() {
    let mut e = Ext::start(json!({}));
    e.none_differ(
        "URL parsing",
        r#"const v = require("../vectors.json").url.parse; const out = [];
        for (const c of v) {
          let u = null; try { u = c.base === null ? new URL(c.input) : new URL(c.input, c.base); } catch (err) { if (!(err instanceof TypeError) || err.code !== "ERR_INVALID_URL") out.push([c.input, "wrong error", String(err)]); }
          if (c.failure) { if (u) out.push([c.input, c.base, "should fail", u.href]); if (URL.canParse(c.input, c.base ?? undefined)) out.push([c.input, "canParse"]); continue; }
          if (!u) { out.push([c.input, c.base, "failed"]); continue; }
          for (const f of ["href","origin","protocol","username","password","host","hostname","port","pathname","search","hash"]) if (u[f] !== c[f]) out.push([c.input, c.base, f, u[f], c[f]]);
          if (URL.canParse(c.input, c.base ?? undefined) !== true) out.push([c.input, "canParse"]);
          if (new URL(u.href).href !== u.href) out.push([c.input, "not idempotent"]);
        }
        return out;"#,
    );
}

#[test]
fn url_setters_and_search_params_match_node() {
    let mut e = Ext::start(json!({}));
    e.none_differ(
        "URL setters",
        r#"const v = require("../vectors.json").url; const out = [];
        for (const c of v.set) { const u = new URL(c.href); u[c.field] = c.value; if (u.href !== c.result) out.push([c.href, c.field, c.value, u.href, c.result]); }
        try { new URL("http://x/").href = "not a url"; out.push("href accepted"); } catch (err) { if (err.name !== v.hrefFailure.name || err.code !== v.hrefFailure.code) out.push(["href error", err.name, err.code]); }
        return out;"#,
    );
    e.none_differ(
        "URLSearchParams",
        r#"const v = require("../vectors.json").url; const out = [];
        for (const c of v.params) { const p = new URLSearchParams(c.input);
          if (JSON.stringify([...p]) !== JSON.stringify(c.entries)) out.push([c.input, "entries", [...p], c.entries]);
          if (p.toString() !== c.toString) out.push([c.input, "toString", p.toString(), c.toString]);
          if (p.size !== c.size) out.push([c.input, "size"]); }
        const p = new URLSearchParams("b=2&a=1&b=3&c=x y"); const trace = [];
        p.append("d", "é&=+"); trace.push(p.toString()); p.delete("b", "3"); trace.push(p.toString()); p.set("b", "9"); trace.push(p.toString()); p.sort(); trace.push(p.toString());
        trace.push([p.get("b"), p.get("zz"), p.getAll("a"), p.has("c"), p.has("c", "nope")]); p.delete("c"); trace.push(p.toString());
        const u = new URL("https://example.com/p?x=1"); u.searchParams.append("y", "2 3"); trace.push(u.href); u.searchParams.delete("x"); u.searchParams.delete("y"); trace.push(u.href); u.search = "?z=1"; trace.push([...u.searchParams]);
        if (JSON.stringify(trace) !== JSON.stringify(v.ops)) out.push(["ops", trace, v.ops]);
        if (new URLSearchParams({ a: "1", b: "x y" }).toString() !== v.fromRecord) out.push("record");
        if (new URLSearchParams([["a", "1"], ["b", "x y"]]).toString() !== v.fromPairs) out.push("pairs");
        try { new URLSearchParams([["a"]]); out.push("a one-item pair accepted"); } catch (err) { if (!(err instanceof TypeError)) out.push("pair error"); }
        return out;"#,
    );
}

#[test]
fn nodes_url_module_matches_node_on_windows() {
    let mut e = Ext::start(json!({}));
    e.none_differ(
        "url module",
        r#"const v = require("../vectors.json").url; const url = require("url"); const out = [];
        for (const c of v.toUrl) { const href = url.pathToFileURL(c.path).href; if (href !== c.href) out.push([c.path, href, c.href]); }
        for (const c of v.fromUrl) { let got; try { got = { path: url.fileURLToPath(c.href) }; } catch (err) { got = { error: err.code }; } if (JSON.stringify(Object.assign({ href: c.href }, got)) !== JSON.stringify(c)) out.push([c.href, got]); }
        for (const c of v.domains) if (url.domainToASCII(c.domain) !== c.ascii) out.push([c.domain, url.domainToASCII(c.domain), c.ascii]);
        if (!(url.pathToFileURL("C:\\x") instanceof URL) || url.URL !== URL || require("node:url").URLSearchParams !== URLSearchParams) out.push("the module's URL is the global's");
        if (url.fileURLToPath(new URL("file:///C:/y")) !== "C:\\y") out.push("a URL object");
        try { url.pathToFileURL("relative\\x"); out.push("relative accepted"); } catch (err) { if (err.code !== "UnsupportedApi") out.push(["relative", err.code]); }
        try { url.parse("http://x/"); out.push("url.parse provided"); } catch (err) { if (err.code !== "UnsupportedApi") out.push(["url.parse", err.code]); }
        return out;"#,
    );
}

#[test]
fn url_semantics_and_failures() {
    let mut e = Ext::start(json!({}));
    let v = e.ok(
        r#"const out = {};
        try { new URL(); } catch (err) { out.noArgs = err instanceof TypeError; }
        try { new URL("nope"); } catch (err) { out.invalid = [err.name, err.message, err.code, err.input]; }
        try { new URL("x", "also bad"); } catch (err) { out.badBase = err.code; }
        out.parse = [URL.parse("nope"), URL.parse("/a", "https://b.org/x").href];
        try { Object.getOwnPropertyDescriptor(URL.prototype, "href").get.call({}); } catch (err) { out.illegal = err instanceof TypeError; }
        const u = new URL("https://x.org/p?a=1");
        const params = u.searchParams; params.set("a", "2"); out.linked = [u.search, u.searchParams === params];
        u.search = "?b=3"; out.relisted = params.get("b");
        out.json = JSON.stringify({ u });
        out.string = [String(u), `${u}`, Object.prototype.toString.call(u), Object.prototype.toString.call(params)];
        out.keys = Object.keys(URL.prototype).includes("href");
        try { URL.createObjectURL({}); } catch (err) { out.blob = err.code; }
        // Malformed input never throws anything but a TypeError, and terminates.
        const odd = ["http://[", "http://[::", "http://a:b@", "http://%", "http://\u0000x/", "x://\uDC00/", "http://[0:0:0:0:0:0:0:0:0]", "a".repeat(10000) + ":b", "http://" + "a.".repeat(3000)];
        out.odd = odd.map((s) => { try { return new URL(s).href.length > 0; } catch (err) { return err instanceof TypeError ? "TypeError" : String(err); } });
        return out;"#,
    );
    assert_eq!(v["noArgs"], true);
    assert_eq!(
        v["invalid"],
        json!(["TypeError", "Invalid URL", "ERR_INVALID_URL", "nope"])
    );
    assert_eq!(v["badBase"], "ERR_INVALID_URL");
    assert_eq!(v["parse"], json!([null, "https://b.org/a"]));
    assert_eq!(v["illegal"], true);
    assert_eq!(v["linked"], json!(["?a=2", true]));
    assert_eq!(v["relisted"], "3");
    assert_eq!(v["json"], r#"{"u":"https://x.org/p?b=3"}"#);
    assert_eq!(
        v["string"],
        json!([
            "https://x.org/p?b=3",
            "https://x.org/p?b=3",
            "[object URL]",
            "[object URLSearchParams]"
        ])
    );
    assert_eq!(v["keys"], true, "attributes are enumerable, as Web IDL's");
    assert_eq!(v["blob"], "UnsupportedApi");
    let odd = v["odd"].as_array().unwrap();
    assert!(
        odd.iter()
            .all(|x| x == &json!("TypeError") || x == &json!(true)),
        "{odd:?}"
    );
}

#[test]
fn the_collator_matches_icus() {
    let mut e = Ext::start(json!({}));
    for index in 0..9 {
        e.none_differ(
            &format!("collation {index}"),
            &format!(
                r#"const v = require("../vectors.json").intl; const c = v.collators[{index}]; const out = [];
                const collator = new Intl.Collator("en", c.options); const compare = collator.compare;
                v.words.forEach((a, i) => {{ const row = v.words.map((b) => "<=>"[Math.sign(compare(a, b)) + 1]).join(""); if (row !== c.signs[i]) out.push([a, v.words.filter((b, j) => row[j] !== c.signs[i][j])]); }});
                const r = collator.resolvedOptions(); for (const k of Object.keys(c.resolved)) if (r[k] !== c.resolved[k] && k !== "locale") out.push(["resolved", k, r[k], c.resolved[k]]);
                return out;"#
            ),
        );
    }
}

#[test]
fn list_formats_graphemes_and_dates_match_icus() {
    let mut e = Ext::start(json!({}));
    e.none_differ(
        "ListFormat",
        r#"const out = []; for (const c of require("../vectors.json").intl.lists) {
          const f = new Intl.ListFormat("en-US", { type: c.type, style: c.style });
          const got = [[], ["x"], ["x", "y"], ["x", "y", "z"], ["w", "x", "y", "z"]].map((l) => f.format(l));
          if (JSON.stringify(got) !== JSON.stringify(c.results)) out.push([c.type, c.style, got, c.results]);
          if (JSON.stringify(f.formatToParts(["x", "y", "z"])) !== JSON.stringify(c.parts)) out.push([c.type, c.style, "parts"]); }
        try { new Intl.ListFormat("en", {}).format(["a", 1]); out.push("a number accepted"); } catch (err) { if (!(err instanceof TypeError)) out.push("error"); }
        try { new Intl.ListFormat("en", { type: "bogus" }); out.push("bogus accepted"); } catch (err) { if (!(err instanceof RangeError)) out.push("range"); }
        return out;"#,
    );
    e.none_differ(
        "Segmenter",
        r#"const out = []; const s = new Intl.Segmenter();
        for (const c of require("../vectors.json").intl.segments) { const got = [...s.segment(c.text)].map((x) => [x.segment, x.index]); if (JSON.stringify(got) !== JSON.stringify(c.segments)) out.push([c.text, got, c.segments]); }
        const segs = s.segment("a👍🏽b"); const hit = segs.containing(2); if (!hit || hit.segment !== "👍🏽" || hit.index !== 1 || segs.containing(99) !== undefined) out.push(["containing", hit]);
        if (s.resolvedOptions().granularity !== "grapheme") out.push("granularity");
        return out;"#,
    );
    e.none_differ(
        "DateTimeFormat (UTC)",
        r#"const out = []; const v = require("../vectors.json").intl.dates;
        for (const c of v.formats) { const f = new Intl.DateTimeFormat("en-US", Object.assign({}, c.options, { timeZone: "UTC" }));
          const got = v.at.map((d) => f.format(d)); if (JSON.stringify(got) !== JSON.stringify(c.results)) out.push([c.options, got, c.results]);
          if (JSON.stringify(f.formatToParts(v.at[0])) !== JSON.stringify(c.parts)) out.push([c.options, "parts", f.formatToParts(v.at[0]), c.parts]);
          const r = f.resolvedOptions(); for (const k of Object.keys(c.resolved)) if (r[k] !== c.resolved[k]) out.push([c.options, "resolved", k, r[k], c.resolved[k]]); }
        return out;"#,
    );
}

#[test]
fn locales_and_what_intl_does_not_provide() {
    let mut e = Ext::start(json!({}));
    let v = e.ok(
        r#"const out = {};
        out.canonical = Intl.getCanonicalLocales(["EN-us", "en-latn-us", "en-US"]);
        try { Intl.getCanonicalLocales("not a locale!"); } catch (err) { out.invalid = err instanceof RangeError; }
        out.supported = Intl.Collator.supportedLocalesOf(["fr", "en-US", "en", "en-GB"]);
        out.resolved = [new Intl.Collator("fr").resolvedOptions().locale, new Intl.ListFormat().resolvedOptions().locale];
        out.localeCompare = ["b", "a", "B", "á", "ä", "A"].sort((x, y) => x.localeCompare(y));
        out.localeOptions = ["x10", "x9", "X2"].sort((x, y) => x.localeCompare(y, undefined, { numeric: true, sensitivity: "base" }));
        out.missing = ["NumberFormat", "PluralRules", "RelativeTimeFormat", "DisplayNames", "Locale", "DurationFormat"].map((n) => { try { new Intl[n]("en"); return "constructed"; } catch (err) { return err.code; } });
        out.segmenterWord = (() => { try { new Intl.Segmenter("en", { granularity: "word" }); return "constructed"; } catch (err) { return err.code; } })();
        out.zone = new Intl.DateTimeFormat().resolvedOptions().timeZone;
        out.offset = -new Date().getTimezoneOffset();
        out.otherZone = (() => { try { new Intl.DateTimeFormat("en", { timeZone: "America/New_York" }); return "constructed"; } catch (err) { return err.code; } })();
        out.badZone = (() => { try { new Intl.DateTimeFormat("en", { timeZone: "Not a zone!" }); return "constructed"; } catch (err) { return err.name; } })();
        out.styleAndField = (() => { try { new Intl.DateTimeFormat("en", { dateStyle: "short", year: "numeric" }); return "constructed"; } catch (err) { return err.name; } })();
        out.invalidDate = (() => { try { new Intl.DateTimeFormat("en", { timeZone: "UTC" }).format(NaN); return "formatted"; } catch (err) { return err.name; } })();
        // ECMA-402: Collator and DateTimeFormat may be called as functions; ListFormat and Segmenter not.
        out.called = [Intl.DateTimeFormat().resolvedOptions().timeZone === out.zone, Intl.Collator(undefined, { numeric: true }).compare("x2", "x10"), Intl.Collator() instanceof Intl.Collator, new Intl.DateTimeFormat() instanceof Intl.DateTimeFormat, typeof Intl.Collator.supportedLocalesOf];
        out.notCalled = [() => Intl.ListFormat(), () => Intl.Segmenter()].map((f) => { try { f(); return "called"; } catch (err) { return err.name; } });
        return out;"#,
    );
    assert_eq!(v["canonical"], json!(["en-US", "en-Latn-US"]));
    assert_eq!(v["invalid"], true);
    assert_eq!(v["supported"], json!(["en-US", "en"]));
    assert_eq!(v["resolved"], json!(["en-US", "en-US"]));
    assert_eq!(
        v["localeCompare"],
        json!(["a", "A", "á", "ä", "b", "B"]),
        "ICU's order, not code units"
    );
    assert_eq!(v["localeOptions"], json!(["X2", "x9", "x10"]));
    assert_eq!(v["missing"], json!(vec!["UnsupportedApi"; 6]));
    assert_eq!(v["segmenterWord"], "UnsupportedApi");
    let offset = v["offset"].as_i64().unwrap();
    let expected = if offset == 0 {
        "UTC".to_string()
    } else {
        format!(
            "{}{:02}:{:02}",
            if offset < 0 { "-" } else { "+" },
            offset.abs() / 60,
            offset.abs() % 60
        )
    };
    assert_eq!(v["zone"], json!(expected), "the host's own zone, by offset");
    assert_eq!(v["otherZone"], "UnsupportedApi");
    assert_eq!(v["badZone"], "RangeError");
    assert_eq!(v["styleAndField"], "TypeError");
    assert_eq!(v["invalidDate"], "RangeError");
    assert_eq!(v["called"], json!([true, -1, true, true, "function"]));
    assert_eq!(v["notCalled"], json!(["TypeError", "TypeError"]));
    // Each unsupported API is said once, by name.
    let said: Vec<&String> = e
        .logs
        .iter()
        .filter(|(_, t)| t.starts_with("UnsupportedApi: Intl."))
        .map(|(_, t)| t)
        .collect();
    assert!(said.len() >= 7, "{said:?}");
}

#[test]
fn crypto_gives_the_systems_random_values_within_its_limits() {
    let mut e = Ext::start(json!({}));
    let v = e.ok(
        r#"const out = {};
        out.native = typeof globalThis.__yavin_random;
        // Math.random is not the source: replacing it changes nothing.
        Math.random = () => 0;
        const a = crypto.getRandomValues(new Uint8Array(65536));
        out.same = crypto.getRandomValues(a) === a;
        const counts = new Array(256).fill(0); for (const b of a) counts[b]++;
        out.counts = [Math.min(...counts), Math.max(...counts)];
        const x = crypto.getRandomValues(new Uint32Array(8)); const y = crypto.getRandomValues(new Uint32Array(8));
        out.differ = x.join() !== y.join();
        out.kinds = [Int8Array, Uint8ClampedArray, Int16Array, Uint16Array, Int32Array, BigInt64Array, BigUint64Array].map((K) => crypto.getRandomValues(new K(4)).length);
        out.view = (() => { const buf = new Uint8Array(16); crypto.getRandomValues(new Uint8Array(buf.buffer, 4, 8)); return [buf.slice(0, 4).every((b) => b === 0), buf.slice(12).every((b) => b === 0)]; })();
        const fail = (f) => { try { f(); return "no error"; } catch (err) { return [err.name, err.constructor === DOMException]; } };
        out.quota = fail(() => crypto.getRandomValues(new Uint8Array(65537)));
        out.float = fail(() => crypto.getRandomValues(new Float32Array(4)));
        out.notView = fail(() => crypto.getRandomValues([1, 2, 3]));
        const ids = new Set(); for (let i = 0; i < 1000; i++) ids.add(crypto.randomUUID());
        out.uuids = [ids.size, [...ids].every((u) => /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(u))];
        out.subtle = (() => { try { return typeof crypto.subtle; } catch (err) { return err.code; } })();
        out.key = fail(() => new CryptoKey());
        out.tag = Object.prototype.toString.call(crypto);
        return out;"#,
    );
    assert_eq!(
        v["native"], "undefined",
        "the host's random function is not reachable"
    );
    assert_eq!(v["same"], true);
    let (min, max) = (
        v["counts"][0].as_u64().unwrap(),
        v["counts"][1].as_u64().unwrap(),
    );
    assert!(
        min > 150 && max < 370,
        "64 KiB of the system's random bytes are near-uniform: {min}..{max}"
    );
    assert_eq!(v["differ"], true);
    assert_eq!(v["kinds"], json!([4, 4, 4, 4, 4, 4, 4]));
    assert_eq!(v["view"], json!([true, true]), "only the view is filled");
    assert_eq!(v["quota"], json!(["QuotaExceededError", true]));
    assert_eq!(v["float"], json!(["TypeMismatchError", true]));
    assert_eq!(v["notView"], json!(["TypeMismatchError", true]));
    assert_eq!(v["uuids"], json!([1000, true]));
    assert_eq!(v["subtle"], "UnsupportedApi");
    assert_eq!(v["key"], json!(["TypeError", false]));
    assert_eq!(v["tag"], "[object Crypto]");
}

#[test]
fn nodes_random_crypto_and_its_limits() {
    let mut e = Ext::start(json!({}));
    let v = e.ok(
        r#"const c = require("crypto"); const out = {};
        const big = c.randomBytes(200000); out.big = [Buffer.isBuffer(big), big.length, big.subarray(0, 65536).equals(big.subarray(65536, 131072))];
        out.async = await new Promise((resolve) => { const r = c.randomBytes(16, (err, buf) => resolve([err, buf.length, r])); });
        out.sizes = [-1, 1.5, "8", 2 ** 31].map((n) => { try { c.randomBytes(n); return "ok"; } catch (err) { return err.code; } });
        const ints = []; for (let i = 0; i < 2000; i++) ints.push(c.randomInt(3, 7)); out.ints = [Math.min(...ints), Math.max(...ints), new Set(ints).size];
        out.intOne = c.randomInt(5);
        out.intErrors = [[5, 5], [0, 2 ** 49], [1.5, 3]].map(([a, b]) => { try { c.randomInt(a, b); return "ok"; } catch (err) { return err.code; } });
        out.intAsync = await new Promise((resolve) => c.randomInt(10, (err, n) => resolve(err === null && n >= 0 && n < 10)));
        const fill = new Uint8Array(32); c.randomFillSync(fill, 8, 8); out.fill = [fill.slice(0, 8).every((b) => b === 0), fill.slice(16).every((b) => b === 0)];
        out.uuid = /^[0-9a-f-]{36}$/.test(c.randomUUID());
        out.web = c.webcrypto === crypto && c.getRandomValues === crypto.getRandomValues;
        out.hash = (() => { try { c.createHash("sha256"); return "ok"; } catch (err) { return err.code; } })();
        // More than the memory limit allows: refused, and the host goes on.
        out.huge = (() => { try { c.randomBytes(2 ** 31 - 1); return "ok"; } catch (err) { return err instanceof RangeError || /memory/i.test(String(err)) ? "refused" : String(err); } })();
        return out;"#,
    );
    assert_eq!(v["big"], json!([true, 200000, false]), "filled in parts");
    assert_eq!(v["async"], json!([null, 16, null]));
    assert_eq!(
        v["sizes"],
        json!([
            "ERR_OUT_OF_RANGE",
            "ERR_OUT_OF_RANGE",
            "ERR_OUT_OF_RANGE",
            "ERR_OUT_OF_RANGE"
        ])
    );
    assert_eq!(
        v["ints"],
        json!([3, 6, 4]),
        "every value in [3, 7), only those"
    );
    assert!(v["intOne"].as_i64().unwrap() < 5);
    assert_eq!(
        v["intErrors"],
        json!([
            "ERR_OUT_OF_RANGE",
            "ERR_OUT_OF_RANGE",
            "ERR_INVALID_ARG_TYPE"
        ])
    );
    assert_eq!(v["intAsync"], true);
    assert_eq!(v["fill"], json!([true, true]));
    assert_eq!(v["uuid"], true);
    assert_eq!(v["web"], true);
    assert_eq!(v["hash"], "UnsupportedApi");
    assert_eq!(v["huge"], "refused");
    assert!(e.ok("return 1 + 1;") == json!(2), "the host goes on");
}

#[test]
fn events_and_abort_signals() {
    let mut e = Ext::start(json!({}));
    let v = e.ok(
        r#"const out = {}; const seen = [];
        const t = new EventTarget(); const once = () => seen.push("once"); const both = { handleEvent: (ev) => seen.push("object:" + ev.type) };
        t.addEventListener("x", once, { once: true }); t.addEventListener("x", once, { once: true }); t.addEventListener("x", both);
        t.addEventListener("x", () => { throw new Error("listener broke"); }); t.addEventListener("x", (ev) => seen.push(ev.target === t));
        t.dispatchEvent(new Event("x")); t.dispatchEvent(new Event("x"));
        out.seen = seen;
        const cancel = new Event("c", { cancelable: true }); t.addEventListener("c", (ev) => ev.preventDefault()); out.prevented = [t.dispatchEvent(cancel), cancel.defaultPrevented, t.dispatchEvent(new Event("c"))];
        const ac = new AbortController(); const events = []; ac.signal.addEventListener("abort", () => events.push("listener")); ac.signal.onabort = () => events.push("onabort");
        const removable = new AbortController(); t.addEventListener("y", () => events.push("y"), { signal: removable.signal }); removable.abort(); t.dispatchEvent(new Event("y"));
        ac.abort(); ac.abort();
        out.aborted = [ac.signal.aborted, ac.signal.reason.name, ac.signal.reason instanceof DOMException, events];
        out.reason = (() => { const c = new AbortController(); c.abort("mine"); try { c.signal.throwIfAborted(); } catch (err) { return err; } })();
        out.static = [AbortSignal.abort().aborted, AbortSignal.abort(7).reason];
        out.any = (() => { const a = new AbortController(); const s = AbortSignal.any([a.signal, new AbortController().signal]); const was = s.aborted; a.abort("first"); return [was, s.aborted, s.reason]; })();
        out.timeout = await new Promise((resolve) => { const s = AbortSignal.timeout(20); s.addEventListener("abort", () => resolve([s.aborted, s.reason.name])); });
        out.illegal = (() => { try { new AbortSignal(); return "constructed"; } catch (err) { return err.name; } })();
        return out;"#,
    );
    assert_eq!(
        v["seen"],
        json!(["once", "object:x", true, "object:x", true]),
        "once runs once; a listener's failure is not the others'"
    );
    assert!(e
        .logs
        .iter()
        .any(|(level, t)| level == "error" && t.contains("listener broke")));
    // A non-cancelable event cannot be prevented: dispatching it says true.
    assert_eq!(v["prevented"], json!([false, true, true]));
    assert_eq!(
        v["aborted"],
        json!([true, "AbortError", true, ["listener", "onabort"]]),
        "aborted once"
    );
    assert_eq!(v["reason"], "mine");
    assert_eq!(v["static"], json!([true, 7]));
    assert_eq!(v["any"], json!([false, true, "first"]));
    assert_eq!(v["timeout"], json!([true, "TimeoutError"]));
    assert_eq!(v["illegal"], "TypeError");
}

#[test]
fn structured_clone_copies_what_can_be_copied_and_refuses_the_rest() {
    let mut e = Ext::start(json!({}));
    let v = e.ok(
        r#"const out = {};
        const shared = { s: 1 }; const original = { n: 1, d: new Date(5), r: /a+/gi, m: new Map([[shared, "v"]]), set: new Set([1, shared]), a: [1, , 3], bytes: new Uint16Array([1, 2]), big: 10n, nested: { shared, again: shared } };
        original.self = original;
        const copy = structuredClone(original);
        out.distinct = copy !== original && copy.nested !== original.nested;
        out.cycle = copy.self === copy;
        out.sharing = copy.nested.shared === copy.nested.again && [...copy.m.keys()][0] === copy.nested.shared;
        out.values = [copy.d.getTime(), copy.r.source, copy.r.flags, copy.m.size, copy.set.size, copy.a.length, 1 in copy.a, Array.from(copy.bytes), copy.big === 10n];
        const err = structuredClone(Object.assign(new RangeError("bad"), { cause: 2 })); out.error = [err instanceof RangeError, err.message, err.cause];
        const fail = (v) => { try { structuredClone(v); return "cloned"; } catch (e) { return [e.name, e instanceof DOMException]; } };
        out.refused = [fail(() => 1), fail(Symbol("s")), fail(new WeakMap()), fail(Promise.resolve())];
        out.transfer = (() => { try { structuredClone(new ArrayBuffer(4), { transfer: [new ArrayBuffer(1)] }); return "ok"; } catch (e) { return e.code; } })();
        return out;"#,
    );
    assert_eq!(v["distinct"], true);
    assert_eq!(v["cycle"], true);
    assert_eq!(v["sharing"], true);
    assert_eq!(
        v["values"],
        json!([5, "a+", "gi", 1, 2, 3, false, [1, 2], true])
    );
    assert_eq!(v["error"], json!([true, "bad", 2]));
    assert_eq!(
        v["refused"],
        json!(vec![json!(["DataCloneError", true]); 4])
    );
    assert_eq!(v["transfer"], "UnsupportedApi");
}

#[test]
fn commonjs_caches_fails_and_cycles_as_node_does_within_the_package() {
    let mut e = Ext::start(json!({
        "extension/out/a.js": "exports.early = 'a'; const b = require('./b'); exports.fromB = b.sawA; exports.late = 'a2';",
        "extension/out/b.js": "const a = require('./a'); exports.sawA = Object.assign({}, a); exports.parent = module.parent && module.parent.id;",
        "extension/out/flaky.js": "globalThis.flakyRuns = (globalThis.flakyRuns || 0) + 1; if (globalThis.flakyRuns === 1) throw new Error('first time'); exports.runs = globalThis.flakyRuns;",
        "extension/out/count.js": "globalThis.countRuns = (globalThis.countRuns || 0) + 1; module.exports = globalThis.countRuns;",
        "extension/out/broken.json": "{ not json",
        "extension/out/dir/index.js": "module.exports = 'index';",
        "extension/out/pkg/package.json": "{\"main\": \"./lib/entry\"}",
        "extension/out/pkg/lib/entry.js": "module.exports = { entry: true, req: typeof module.require };",
        "extension/node_modules/dep/index.js": "module.exports = 'dep';",
    }));
    let v = e.ok(
        r#"const out = {};
        const a = require("./a"); out.cycle = [a.early, a.fromB, a.late];
        out.flaky = (() => { try { require("./flaky"); return "loaded"; } catch (err) { return err.message; } })();
        out.flakyAgain = require("./flaky").runs;
        const key = require.resolve("./count"); out.key = key;
        out.count = [require("./count"), require("./count")];
        delete require.cache[key]; out.reloaded = require("./count");
        out.cacheShared = require("./a") === require.cache[require.resolve("./a")].exports && Object.keys(require.cache).length > 3;
        out.broken = (() => { try { require("./broken.json"); return "loaded"; } catch (err) { return [err.name, err.message.includes("broken.json"), require.resolve("./broken.json") in require.cache]; } })();
        out.dirs = [require("./dir"), require("./pkg").entry, require("./pkg").req, require("dep")];
        out.main = [require.main === module, module.id, module.parent, module.children.length > 0, typeof module.require, module.loaded];
        out.parentOfB = require("./b").parent;
        out.absoluteInside = require("C:\\ext\\acme.runtime\\extension\\out\\dir");
        out.absoluteCase = require("c:/EXT/acme.runtime/extension/out/dir");
        const notFound = (spec) => { try { require(spec); return "loaded"; } catch (err) { return [err.code, err.message]; } };
        out.outside = [notFound("C:\\ext\\other\\x.js"), notFound("C:\\ext\\acme.runtime\\..\\other\\x"), notFound("../../outside"), notFound("../../../outside"), notFound("./missing")];
        out.resolve = [require.resolve("fs"), require.resolve("node:path"), require.resolve("vscode"), require.resolve.paths("fs")];
        out.empty = (() => { try { require(""); } catch (err) { return err.code; } })();
        out.esm = (() => { try { require("./nope.mjs"); } catch (err) { return err.code; } })();
        return out;"#,
    );
    assert_eq!(
        v["cycle"],
        json!(["a", {"early": "a"}, "a2"]),
        "b sees a's exports as they were"
    );
    assert_eq!(v["flaky"], "first time");
    assert_eq!(
        v["flakyAgain"], 2,
        "a module that failed is not kept: it runs again"
    );
    assert_eq!(v["key"], r"C:\ext\acme.runtime\extension\out\count.js");
    assert_eq!(v["count"], json!([1, 1]), "cached");
    assert_eq!(v["reloaded"], 2, "deleted from require.cache: loaded again");
    assert_eq!(v["cacheShared"], true);
    assert_eq!(v["broken"], json!(["SyntaxError", true, false]));
    assert_eq!(v["dirs"], json!(["index", true, "function", "dep"]));
    assert_eq!(v["main"], json!([true, ".", null, true, "function", true]));
    assert_eq!(v["parentOfB"], r"C:\ext\acme.runtime\extension\out\a.js");
    assert_eq!(v["absoluteInside"], "index");
    assert_eq!(v["absoluteCase"], "index");
    let outside = v["outside"].as_array().unwrap();
    for (i, o) in outside.iter().enumerate() {
        assert_eq!(o[0], "MODULE_NOT_FOUND", "outside {i}: {o}");
    }
    assert!(outside[0][1]
        .as_str()
        .unwrap()
        .contains("outside the extension's package"));
    assert_eq!(
        v["resolve"],
        json!(["fs", "node:path", "vscode", null]),
        "built-ins resolve to their names"
    );
    assert_eq!(v["empty"], "ERR_INVALID_ARG_VALUE");
    assert_eq!(v["esm"], "MODULE_NOT_FOUND");
}

#[test]
fn unhandled_rejections_are_said_and_handled_ones_are_not() {
    let mut e = Ext::start(json!({}));
    e.ok(r#"Promise.reject(new TypeError("lost")); const late = Promise.reject(new Error("handled later")); await null; late.catch(() => {}); Promise.reject("plain text");"#);
    // Said after the entry's jobs (after its answer): the next entry reads them.
    e.ok("return null;");
    let said: Vec<&String> = e
        .logs
        .iter()
        .filter(|(level, t)| level == "error" && t.starts_with("An unhandled promise rejection"))
        .map(|(_, t)| t)
        .collect();
    assert_eq!(
        said,
        [
            "An unhandled promise rejection: TypeError: lost",
            "An unhandled promise rejection: plain text"
        ]
    );
    e.logs.clear();
    e.ok("for (let i = 0; i < 30; i++) Promise.reject(new Error('n' + i));");
    e.ok("return null;");
    let said: Vec<&String> = e
        .logs
        .iter()
        .filter(|(level, _)| level == "error")
        .map(|(_, t)| t)
        .collect();
    assert_eq!(said.len(), 11, "ten said, the rest counted: {said:?}");
    assert_eq!(said[10], "20 more unhandled promise rejections.");
}

#[test]
fn timers_promises_and_cleanup() {
    let mut e = Ext::start(json!({}));
    // An interval whose callback throws is logged and keeps running; clearing it stops it.
    let v = e.ok(
        r#"T.ticks = 0;
        await new Promise((resolve) => { const id = setInterval(() => { T.ticks++; if (T.ticks === 3) { clearInterval(id); resolve(); } if (T.ticks === 1) throw new Error("tick broke"); }, 10); });
        await new Promise((resolve) => setTimeout(resolve, 40));
        const order = []; setTimeout(() => order.push("timeout"), 0); queueMicrotask(() => order.push("microtask")); Promise.resolve().then(() => order.push("promise"));
        await new Promise((resolve) => setTimeout(resolve, 20));
        return [T.ticks, order];"#,
    );
    assert_eq!(v, json!([3, ["microtask", "promise", "timeout"]]));
    assert!(e
        .logs
        .iter()
        .any(|(l, t)| l == "error" && t.contains("tick broke")));
    // A timer left waiting at unload never fires: the extension's runtime is gone with it.
    e.ok("setInterval(() => { throw new Error('after unload'); }, 10); return 1;");
    let ext = e.id.clone();
    e.host
        .to(&ext, json!({"type": "unload", "extensionId": ext}));
    let unloaded = e
        .host
        .until(|m| m["type"] == "unloaded" || m["type"] == "error");
    assert_eq!(unloaded["type"], "unloaded");
    let quiet = Ext::start_in(e.host, "acme.second", json!({}));
    assert!(
        !quiet.logs.iter().any(|(_, t)| t.contains("after unload")),
        "no timer of the unloaded extension ran"
    );
}

#[test]
fn extensions_do_not_share_their_runtime() {
    let mut first = Ext::start(json!({}));
    first.ok(
        r#"URL.prototype.extra = 1; Intl.Collator.prototype.compare = null; globalThis.mine = 1;
        require.cache["C:\\fake.js"] = { exports: "planted" }; T.bytes = Array.from(crypto.getRandomValues(new Uint8Array(32)));"#,
    );
    let bytes = first.ok("return T.bytes;");
    let mut second = Ext::start_in(first.host, "acme.other", json!({}));
    let v = second.ok(
        r#"return [new URL("http://x/").extra, typeof new Intl.Collator().compare, typeof globalThis.mine, "C:\\fake.js" in require.cache, Array.from(crypto.getRandomValues(new Uint8Array(32)))];"#,
    );
    assert_eq!(v[0], Value::Null);
    assert_eq!(v[1], "function");
    assert_eq!(v[2], "undefined");
    assert_eq!(v[3], false);
    assert_ne!(v[4], bytes, "its own random values");
    let _ = RUN;
}

/// Sorting a file's lines by the collator (Sort Lines' natural sort) fits one call's deadline.
#[test]
fn collation_sorts_thousands_of_lines_within_the_call_deadline() {
    let mut e = Ext::start(json!({}));
    let v = e.ok(
        r#"let seed = 7; const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648);
        const ascii = []; for (let i = 0; i < 2000; i++) ascii.push("Line " + (next() % 1000) + " item-" + String.fromCharCode(97 + (next() % 26)) + (next() % 50));
        const accented = []; for (let i = 0; i < 500; i++) accented.push("Résumé " + (next() % 1000) + " ça-" + String.fromCharCode(224 + (next() % 26)));
        const c = new Intl.Collator(undefined, { numeric: true });
        const t0 = Date.now(); const a = ascii.slice().sort(c.compare); const t1 = Date.now(); const b = accented.slice().sort(c.compare); const t2 = Date.now();
        const sorted = (list) => list.every((x, i) => i === 0 || c.compare(list[i - 1], x) <= 0);
        return { ascii: t1 - t0, accented: t2 - t1, sorted: sorted(a) && sorted(b) };"#,
    );
    assert_eq!(v["sorted"], true);
    println!(
        "collation: 2000 ASCII lines in {} ms, 500 accented lines in {} ms",
        v["ascii"], v["accented"]
    );
}

/// What code reads to learn where it runs: Yavin's host on Windows, said as it is.
#[test]
fn navigator_and_rooted_paths_say_where_code_runs() {
    let mut e = Ext::start(json!({}));
    let v = e.ok(
        r#"const url = require("url");
        return { ua: navigator.userAgent, windows: navigator.userAgent.indexOf("Windows") >= 0, language: navigator.language, languages: navigator.languages, platform: navigator.platform, cores: navigator.hardwareConcurrency, tag: Object.prototype.toString.call(navigator),
          rooted: url.pathToFileURL("/").href, rootedFile: url.pathToFileURL("\\x\\y.txt").href,
          relative: (() => { try { url.pathToFileURL("x/y"); return "accepted"; } catch (err) { return err.code; } })() };"#,
    );
    assert_eq!(
        v["ua"],
        "Yavin-Extension-Host (Windows NT 10.0; Win64; x64)"
    );
    assert_eq!(v["windows"], true);
    assert_eq!(v["language"], "en-US");
    assert_eq!(v["languages"], json!(["en-US"]));
    assert_eq!(v["platform"], "win32");
    assert_eq!(v["cores"], 1);
    assert_eq!(v["tag"], "[object Navigator]");
    assert_eq!(
        v["rooted"], "file:///C:/",
        "on the extension folder's drive"
    );
    assert_eq!(v["rootedFile"], "file:///C:/x/y.txt");
    assert_eq!(v["relative"], "UnsupportedApi");
}
