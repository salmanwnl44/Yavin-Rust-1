  // --- Intl, the part VS Code extensions use (EXT-28) ----------------------------------------------
  //
  // QuickJS has no Intl. Measured on the benchmark's extensions, what their code uses is
  // `Intl.Collator` (natural and case-insensitive sorting: Go, Sort Lines, ShellCheck),
  // `Intl.Segmenter` for graphemes (string widths: markdownlint, ShellCheck), `Intl.ListFormat`
  // ("a, b, or c": Prettier, YAML) and `Intl.DateTimeFormat` (YAML reads its time zone). Those
  // are provided, in English ("en", "en-US": any other locale resolves to "en-US"), checked
  // against Node.js's ICU in the host's tests; `String.prototype.localeCompare` uses the same
  // collator, as it does with ICU. The rest of Intl -- NumberFormat, PluralRules,
  // RelativeTimeFormat, DisplayNames, Locale, DurationFormat, and Segmenter's word and sentence
  // granularities -- fails with UnsupportedApi, rather than answering wrongly.
  //
  // Known differences, said in `vscodeApi.json`: the collator is the root collation's ordering
  // of Latin letters, accents and case, of digits (and numeric runs), spaces, ASCII punctuation
  // and symbols; other scripts sort by code point after Latin, and the rarer Unicode punctuation
  // after ASCII's. The time zone is the host's offset ("UTC", or one such as "+05:30"): no IANA
  // names or other zones' rules.
  function intlRuntime(options) {
    const { unsupported } = options;
    if (typeof globalThis.Intl !== "undefined") return null;
    const DEFAULT = "en-US";

    // --- Locales ---------------------------------------------------------------------------------
    const TAG = /^([a-z]{2,3}|[a-z]{5,8})(-[a-z]{4})?(-(?:[a-z]{2}|[0-9]{3}))?((?:-(?:[a-z0-9]{5,8}|[0-9][a-z0-9]{3}))*)((?:-[0-9a-wy-z](?:-[a-z0-9]{2,8})+)*)(-x(?:-[a-z0-9]{1,8})+)?$/i;
    const canonical = (tag) => {
      if (typeof tag !== "string" && !(tag && typeof tag === "object")) throw new TypeError("A locale is a string");
      const text = String(tag);
      const m = TAG.exec(text);
      if (!m) throw new RangeError(`Incorrect locale information provided: ${text}`);
      let out = m[1].toLowerCase();
      if (m[2]) out += `-${m[2][1].toUpperCase()}${m[2].slice(2).toLowerCase()}`;
      if (m[3]) out += m[3].toUpperCase();
      return out + (m[4] || "").toLowerCase() + (m[5] || "").toLowerCase() + (m[6] || "").toLowerCase();
    };
    const canonicalList = (locales) => {
      if (locales === undefined) return [];
      const list = typeof locales === "string" ? [locales] : Array.from(locales);
      const out = [];
      for (const one of list) {
        const c = canonical(one);
        if (!out.includes(c)) out.push(c);
      }
      return out;
    };
    const SUPPORTED = ["en", "en-US"];
    const resolveLocale = (locales) => canonicalList(locales).find((l) => SUPPORTED.includes(l)) || DEFAULT;
    const supportedLocalesOf = (locales) => canonicalList(locales).filter((l) => SUPPORTED.includes(l));
    const pick = (opts, name, allowed, fallback) => {
      if (opts === undefined || opts[name] === undefined) return fallback;
      const value = typeof allowed[0] === "boolean" ? Boolean(opts[name]) : String(opts[name]);
      if (!allowed.includes(value)) throw new RangeError(`Value ${value} out of range for Intl options property ${name}`);
      return value;
    };
    const optionsObject = (opts) => {
      if (opts === undefined) return undefined;
      if (opts === null) throw new TypeError("Options must be an object");
      return Object(opts);
    };

    // --- Collator --------------------------------------------------------------------------------
    // Spaces and ASCII punctuation and symbols, in the root collation's order (from ICU).
    const VARIABLE = " _-,;:!?.'\"()[]{}@*/\\&#%`^+<=>|~$";
    // Accents, in the root collation's secondary order (from ICU).
    const ACCENTS = "34f 332 313 343 314 301 341 300 340 306 302 30c 30a 342 308 344 30b 303 307 338 327 328 304 30d 30e 312 315 31a 33d 33e 33f 346 34a 34b 34c 350 351 352 357 35b 35d 35e 316 317 318 319 31c 31d 31e 31f 320 329 32a 32b 32c 32f 333 33a 33b 33c 347 348 349 34d 34e 353 354 355 356 359 35a 35c 35f 362 336 337 335 305 309 30f 310 311 31b 321 322 323 324 325 326 32d 32e 330 331 334 339 345 358 360 361 363 368 369 364 36a 365 36b 366 36c 36d 367 36e 36f"
      .split(" ")
      .map((h) => parseInt(h, 16));
    const accentWeight = (cp) => {
      const i = ACCENTS.indexOf(cp);
      return i === -1 ? 200 + (cp % 1000) : i + 1;
    };
    // Letters the root collation expands, or treats as a letter with a secondary difference.
    const EXPAND = { ß: "ss", ẞ: "SS", æ: "ae", Æ: "AE", œ: "oe", Œ: "OE", ĳ: "ij", Ĳ: "IJ" };
    const STROKED = { ø: "o", Ø: "O", đ: "d", Đ: "D", ł: "l", Ł: "L", ħ: "h", Ħ: "H" };
    // Letters after z (as in the root collation), each its own letter.
    const AFTER_Z = ["ı", "þ"];
    const EXPANDED = 150;
    const LETTER = /\p{L}/u;
    const MARK = /\p{M}/u;
    const NUMBER = /\p{Nd}/u;
    const SPACE = /\s/u;
    const PUNCT = /[\p{P}\p{S}]/u;
    /** A string's collation elements: [primary class, primary value, secondary, tertiary]. */
    const ASCII = [];
    /** One ASCII character's element, from the general rules below (kept: ASCII is most text). */
    const asciiElement = (ch, ignorePunctuation) => {
      const slot = ch.charCodeAt(0) * 2 + (ignorePunctuation ? 1 : 0);
      if (ASCII[slot] === undefined) ASCII[slot] = elementsOf([ch], false, ignorePunctuation)[0] || null;
      return ASCII[slot];
    };
    const elements = (text, numeric, ignorePunctuation) => {
      // eslint-disable-next-line no-control-regex
      if (!/^[\x00-\x7f]*$/.test(text)) return elementsOf(Array.from(String(text).normalize("NFD")), numeric, ignorePunctuation);
      const out = [];
      for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (numeric && ch >= "0" && ch <= "9") {
          let j = i;
          while (j < text.length && text[j] >= "0" && text[j] <= "9") j++;
          const digits = text.slice(i, j).replace(/^0+(?=\d)/, "");
          out.push([3, digits.length, [], [0], digits]);
          i = j - 1;
          continue;
        }
        const e = asciiElement(ch, ignorePunctuation);
        if (e) out.push(e);
      }
      return out;
    };
    const elementsOf = (chars, numeric, ignorePunctuation) => {
      const out = [];
      for (let i = 0; i < chars.length; i++) {
        const ch = chars[i];
        const cp = ch.codePointAt(0);
        if (MARK.test(ch)) {
          const last = out[out.length - 1];
          if (last) last[2].push(accentWeight(cp));
          continue;
        }
        if (numeric && cp >= 0x30 && cp <= 0x39) {
          let j = i;
          while (j < chars.length && chars[j] >= "0" && chars[j] <= "9") j++;
          const digits = chars.slice(i, j).join("").replace(/^0+(?=\d)/, "");
          out.push([3, digits.length, [], [0], digits]);
          i = j - 1;
          continue;
        }
        const variant = EXPAND[ch];
        if (variant) {
          const upper = ch !== ch.toLowerCase();
          // An expansion differs from its letters at the secondary level (ae < AE < æ), as in ICU.
          variant.split("").forEach((v, k) => out.push([5, v.toLowerCase().charCodeAt(0), k === 0 ? [EXPANDED] : [], [upper ? 1 : 0]]));
          continue;
        }
        const stroked = STROKED[ch];
        if (stroked) {
          out.push([5, stroked.toLowerCase().charCodeAt(0), [accentWeight(0x338)], [ch === stroked.toLowerCase() || ch !== ch.toUpperCase() ? 0 : 1]]);
          continue;
        }
        const lower = ch.toLowerCase();
        const tertiary = [lower === ch ? 0 : 1];
        if (SPACE.test(ch) || PUNCT.test(ch)) {
          if (ignorePunctuation) continue;
          const v = VARIABLE.indexOf(ch);
          out.push([1, v === -1 ? 1000 + cp : v, [], tertiary]);
        } else if (NUMBER.test(ch)) out.push([3, cp >= 0x30 && cp <= 0x39 ? cp - 0x30 : 100 + cp, [], tertiary]);
        else if (/[a-z]/.test(lower) && lower.length === 1) out.push([5, lower.charCodeAt(0), [], tertiary]);
        else if (AFTER_Z.includes(lower)) out.push([6, AFTER_Z.indexOf(lower), [], tertiary]);
        else if (LETTER.test(ch)) out.push([7, lower.codePointAt(0), [], tertiary]);
        else out.push([8, cp, [], tertiary]);
      }
      return out;
    };
    // Sort keys, as ICU compares: each string's elements become three strings (primary,
    // secondary, tertiary), compared natively, and are kept for the collator's next comparisons.
    const C = String.fromCharCode;
    const keysOf = (list) => {
      let p = "";
      let s = "";
      let t = "";
      for (const e of list) {
        const v = e[1] + 1;
        p += C(e[0]) + C(Math.floor(v / 65536)) + C(v % 65536);
        // A numeric run: its length (above), then its digits.
        if (e[4] !== undefined) p += e[4];
        for (const w of e[2]) s += C(w);
        s += "\0";
        for (const w of e[3]) t += C(w + 1);
      }
      return { p, s, t };
    };
    const order = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
    const MAX_KEYS = 20000;
    class Collator {
      #options;
      #compare;
      constructor(locales, opts) {
        const o = optionsObject(opts);
        const usage = pick(o, "usage", ["sort", "search"], "sort");
        const locale = resolveLocale(locales);
        const numeric = pick(o, "numeric", [true, false], false);
        const caseFirst = pick(o, "caseFirst", ["upper", "lower", "false"], "false");
        const sensitivity = pick(o, "sensitivity", ["base", "accent", "case", "variant"], "variant");
        const ignorePunctuation = pick(o, "ignorePunctuation", [true, false], false);
        this.#options = { locale, usage, sensitivity, ignorePunctuation, collation: "default", numeric, caseFirst };
        const upperFirst = caseFirst === "upper";
        const accents = sensitivity === "accent" || sensitivity === "variant";
        const cases = sensitivity === "case" || sensitivity === "variant";
        const keys = new Map();
        const key = (text) => {
          let k = keys.get(text);
          if (k === undefined) {
            if (keys.size >= MAX_KEYS) keys.clear();
            k = keysOf(elements(text, numeric, ignorePunctuation));
            keys.set(text, k);
          }
          return k;
        };
        this.#compare = (x, y) => {
          if (x === y) return 0;
          const a = key(x);
          const b = key(y);
          const primary = order(a.p, b.p);
          if (primary) return primary;
          if (accents) {
            const secondary = order(a.s, b.s);
            if (secondary) return secondary;
          }
          if (cases) {
            const tertiary = order(a.t, b.t);
            if (tertiary) return upperFirst ? -tertiary : tertiary;
          }
          return 0;
        };
      }
      get compare() {
        const compare = this.#compare;
        return (x, y) => compare(String(x), String(y));
      }
      resolvedOptions() {
        return Object.assign({}, this.#options);
      }
      static supportedLocalesOf(locales) {
        return supportedLocalesOf(locales);
      }
      get [Symbol.toStringTag]() {
        return "Intl.Collator";
      }
    }

    // --- ListFormat ------------------------------------------------------------------------------
    const LISTS = {
      conjunction: { long: [" and ", ", ", ", and "], short: [" & ", ", ", ", & "], narrow: [", ", ", ", ", "] },
      disjunction: { long: [" or ", ", ", ", or "], short: [" or ", ", ", ", or "], narrow: [" or ", ", ", ", or "] },
      unit: { long: [", ", ", ", ", "], short: [", ", ", ", ", "], narrow: [" ", " ", " "] },
    };
    class ListFormat {
      #options;
      constructor(locales, opts) {
        const o = optionsObject(opts);
        const type = pick(o, "type", ["conjunction", "disjunction", "unit"], "conjunction");
        const style = pick(o, "style", ["long", "short", "narrow"], "long");
        this.#options = { locale: resolveLocale(locales), type, style };
      }
      formatToParts(list) {
        const items = [];
        for (const item of list === undefined ? [] : list) {
          if (typeof item !== "string") throw new TypeError("Iterable yielded a non-string value");
          items.push(item);
        }
        const [two, middle, last] = LISTS[this.#options.type][this.#options.style];
        const parts = [];
        items.forEach((value, i) => {
          if (i > 0) parts.push({ type: "literal", value: items.length === 2 ? two : i === items.length - 1 ? last : middle });
          parts.push({ type: "element", value });
        });
        return parts;
      }
      format(list) {
        return this.formatToParts(list)
          .map((p) => p.value)
          .join("");
      }
      resolvedOptions() {
        return Object.assign({}, this.#options);
      }
      static supportedLocalesOf(locales) {
        return supportedLocalesOf(locales);
      }
      get [Symbol.toStringTag]() {
        return "Intl.ListFormat";
      }
    }

    // --- Segmenter: extended grapheme clusters (UAX #29) -----------------------------------------
    const inRanges = (ranges) => (cp) => ranges.some(([a, b = a]) => cp >= a && cp <= b);
    const PREPEND = inRanges([[0x600, 0x605], [0x6dd], [0x70f], [0x890, 0x891], [0x8e2], [0xd4e], [0x110bd], [0x110cd], [0x111c2, 0x111c3], [0x1193f], [0x11941], [0x11a3a], [0x11a84, 0x11a89], [0x11d46], [0x11f02]]);
    const NOT_SPACING = inRanges([[0x102b, 0x102c], [0x1038], [0x1062, 0x1064], [0x1067, 0x106d], [0x1083], [0x1087, 0x108c], [0x108f], [0x109a, 0x109c], [0x1a61], [0x1a63, 0x1a64], [0xaa7b], [0xaa7d], [0x11720, 0x11721]]);
    const LINKER = inRanges([[0x94d], [0x9cd], [0xacd], [0xb4d], [0xc4d], [0xd4d]]);
    const CONSONANT = inRanges([[0x915, 0x939], [0x958, 0x95f], [0x978, 0x97f], [0x995, 0x9a8], [0x9aa, 0x9b0], [0x9b2], [0x9b6, 0x9b9], [0x9dc, 0x9dd], [0x9df], [0x9f0, 0x9f1], [0xa95, 0xaa8], [0xaaa, 0xab0], [0xab2, 0xab3], [0xab5, 0xab9], [0xaf9], [0xb15, 0xb28], [0xb2a, 0xb30], [0xb32, 0xb33], [0xb35, 0xb39], [0xb5c, 0xb5d], [0xb5f], [0xb71], [0xc15, 0xc28], [0xc2a, 0xc39], [0xc58, 0xc5a], [0xd15, 0xd3a]]);
    const RE = {
      extend: /[\p{Grapheme_Extend}\p{Emoji_Modifier}]/u,
      control: /[\p{Cc}\p{Zl}\p{Zp}\p{Cf}]/u,
      spacing: /\p{Mc}/u,
      pictographic: /\p{Extended_Pictographic}/u,
    };
    const graphemeClass = (cp) => {
      if (cp === 0x0d) return "CR";
      if (cp === 0x0a) return "LF";
      if (cp === 0x200d) return "ZWJ";
      const ch = String.fromCodePoint(cp);
      if (PREPEND(cp)) return "Prepend";
      if (RE.extend.test(ch)) return "Extend";
      if (RE.control.test(ch) && cp !== 0x200c) return "Control";
      if (cp >= 0x1f1e6 && cp <= 0x1f1ff) return "RI";
      if (cp === 0xe33 || cp === 0xeb3 || (RE.spacing.test(ch) && !NOT_SPACING(cp))) return "SpacingMark";
      if ((cp >= 0x1100 && cp <= 0x115f) || (cp >= 0xa960 && cp <= 0xa97c)) return "L";
      if ((cp >= 0x1160 && cp <= 0x11a7) || (cp >= 0xd7b0 && cp <= 0xd7c6)) return "V";
      if ((cp >= 0x11a8 && cp <= 0x11ff) || (cp >= 0xd7cb && cp <= 0xd7fb)) return "T";
      if (cp >= 0xac00 && cp <= 0xd7a3) return (cp - 0xac00) % 28 === 0 ? "LV" : "LVT";
      if (RE.pictographic.test(ch)) return "ExtPict";
      return "Other";
    };
    /** The grapheme clusters of `text`: [start, end] in code units. */
    const graphemes = (text) => {
      const cps = Array.from(text, (ch) => ch.codePointAt(0));
      const out = [];
      let start = 0;
      let offset = 0;
      let prev = null;
      let riCount = 0;
      let emoji = 0; // 0 none, 1 ExtPict Extend*, 2 ... ZWJ
      let conjunct = 0; // 0 none, 1 consonant [extend|linker]*, 2 ... with a linker
      for (let i = 0; i < cps.length; i++) {
        const cp = cps[i];
        const cls = graphemeClass(cp);
        let join = false;
        if (prev !== null) {
          if (prev === "CR" && cls === "LF") join = true;
          else if (prev === "Control" || prev === "CR" || prev === "LF") join = false;
          else if (cls === "Control" || cls === "CR" || cls === "LF") join = false;
          else if (prev === "L" && ["L", "V", "LV", "LVT"].includes(cls)) join = true;
          else if ((prev === "LV" || prev === "V") && (cls === "V" || cls === "T")) join = true;
          else if ((prev === "LVT" || prev === "T") && cls === "T") join = true;
          else if (cls === "Extend" || cls === "ZWJ" || cls === "SpacingMark") join = true;
          else if (prev === "Prepend") join = true;
          else if (conjunct === 2 && CONSONANT(cp)) join = true;
          else if (emoji === 2 && cls === "ExtPict") join = true;
          else if (prev === "RI" && cls === "RI" && riCount % 2 === 1) join = true;
        }
        if (!join && prev !== null) {
          out.push([start, offset]);
          start = offset;
        }
        // The states the rules above look back on.
        riCount = cls === "RI" ? (join ? riCount + 1 : 1) : 0;
        if (cls === "ExtPict") emoji = 1;
        else if (emoji === 1 && cls === "Extend") emoji = 1;
        else if (emoji === 1 && cls === "ZWJ") emoji = 2;
        else emoji = 0;
        if (CONSONANT(cp)) conjunct = 1;
        else if (conjunct > 0 && LINKER(cp)) conjunct = 2;
        else if (conjunct > 0 && (cls === "Extend" || cls === "ZWJ")) conjunct = conjunct;
        else conjunct = 0;
        prev = cls;
        offset += cp > 0xffff ? 2 : 1;
      }
      if (prev !== null) out.push([start, offset]);
      return out;
    };
    const segmentData = (input, [start, end]) => ({ segment: input.slice(start, end), index: start, input });
    class Segmenter {
      #options;
      constructor(locales, opts) {
        const o = optionsObject(opts);
        const granularity = pick(o, "granularity", ["grapheme", "word", "sentence"], "grapheme");
        if (granularity !== "grapheme")
          throw unsupported(`Intl.Segmenter with granularity "${granularity}"`, "only grapheme clusters are provided");
        this.#options = { locale: resolveLocale(locales), granularity };
      }
      segment(value) {
        const input = String(value);
        const spans = graphemes(input);
        const segments = {
          containing(index = 0) {
            const n = Math.trunc(Number(index)) || 0;
            const span = spans.find(([s, e]) => n >= s && n < e);
            return span ? segmentData(input, span) : undefined;
          },
          *[Symbol.iterator]() {
            for (const span of spans) yield segmentData(input, span);
          },
        };
        return segments;
      }
      resolvedOptions() {
        return Object.assign({}, this.#options);
      }
      static supportedLocalesOf(locales) {
        return supportedLocalesOf(locales);
      }
      get [Symbol.toStringTag]() {
        return "Intl.Segmenter";
      }
    }

    // --- DateTimeFormat --------------------------------------------------------------------------
    const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
    const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    // Before AM and PM: U+202F in the parts (ICU 72), a space in `format`'s string (as V8 writes it).
    const NNBSP = "\u202f";
    /** The host's own zone: "UTC", or its current offset ("+05:30"). */
    const localZone = () => {
      const minutes = -new Date().getTimezoneOffset();
      if (minutes === 0) return "UTC";
      const abs = Math.abs(minutes);
      return `${minutes < 0 ? "-" : "+"}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
    };
    const UTC_NAMES = ["utc", "etc/utc", "gmt", "etc/gmt", "etc/universal", "universal", "etc/zulu", "zulu", "etc/uct", "uct", "etc/greenwich", "greenwich"];
    const resolveZone = (zone) => {
      const local = localZone();
      if (zone === undefined) return local;
      const text = String(zone);
      if (UTC_NAMES.includes(text.toLowerCase())) return "UTC";
      if (text === local) return local;
      if (!/^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+)*$|^[+-]\d{2}(:?\d{2})?$/.test(text)) throw new RangeError(`Invalid time zone specified: ${text}`);
      throw unsupported(`Intl.DateTimeFormat in the time zone ${text}`, "only UTC and this host's own zone are known");
    };
    const FIELDS = ["weekday", "era", "year", "month", "day", "dayPeriod", "hour", "minute", "second", "fractionalSecondDigits", "timeZoneName"];
    class DateTimeFormat {
      #options;
      constructor(locales, opts) {
        const o = optionsObject(opts) || {};
        const locale = resolveLocale(locales);
        const timeZone = resolveZone(o.timeZone);
        const resolved = { locale, calendar: "gregory", numberingSystem: "latn", timeZone };
        for (const name of ["era", "dayPeriod", "timeZoneName"])
          if (o[name] !== undefined) throw unsupported(`Intl.DateTimeFormat's ${name} option`, "it is not provided");
        if (o.calendar !== undefined && String(o.calendar) !== "gregory") throw unsupported(`Intl.DateTimeFormat's calendar ${o.calendar}`, "only the Gregorian calendar is provided");
        if (o.numberingSystem !== undefined && String(o.numberingSystem) !== "latn") throw unsupported(`Intl.DateTimeFormat's numbering system ${o.numberingSystem}`, "only Latin digits are provided");
        const dateStyle = pick(o, "dateStyle", ["full", "long", "medium", "short"], undefined);
        const timeStyle = pick(o, "timeStyle", ["full", "long", "medium", "short"], undefined);
        const fields = {
          weekday: pick(o, "weekday", ["long", "short", "narrow"], undefined),
          year: pick(o, "year", ["numeric", "2-digit"], undefined),
          month: pick(o, "month", ["numeric", "2-digit", "long", "short", "narrow"], undefined),
          day: pick(o, "day", ["numeric", "2-digit"], undefined),
          hour: pick(o, "hour", ["numeric", "2-digit"], undefined),
          minute: pick(o, "minute", ["numeric", "2-digit"], undefined),
          second: pick(o, "second", ["numeric", "2-digit"], undefined),
        };
        const fractional = o.fractionalSecondDigits === undefined ? undefined : Number(o.fractionalSecondDigits);
        if (fractional !== undefined && ![1, 2, 3].includes(fractional)) throw new RangeError("fractionalSecondDigits value is out of range.");
        const anyField = Object.values(fields).some((v) => v !== undefined) || fractional !== undefined;
        if ((dateStyle || timeStyle) && anyField) throw new TypeError("Can't set option dateStyle or timeStyle when other date or time options are given");
        if ((timeStyle === "full" || timeStyle === "long") && timeZone !== "UTC")
          throw unsupported("Intl.DateTimeFormat's long and full time styles outside UTC", "time zone names are not known");
        const hour12 = o.hour12 === undefined ? undefined : Boolean(o.hour12);
        const hourCycle = pick(o, "hourCycle", ["h11", "h12", "h23", "h24"], undefined);
        if (!dateStyle && !timeStyle && !anyField) Object.assign(fields, { year: "numeric", month: "numeric", day: "numeric" });
        const hasTime = !!timeStyle || fields.hour !== undefined;
        const cycle = hour12 !== undefined ? (hour12 ? "h12" : "h23") : hourCycle || "h12";
        Object.assign(resolved, hasTime ? { hourCycle: cycle, hour12: cycle === "h11" || cycle === "h12" } : {});
        // As ICU resolves en-US patterns: minutes and seconds are two digits, and so is a 24-hour hour.
        if (fields.minute !== undefined) fields.minute = "2-digit";
        if (fields.second !== undefined) fields.second = "2-digit";
        if (fields.hour !== undefined && (cycle === "h23" || cycle === "h24")) fields.hour = "2-digit";
        for (const name of FIELDS) if (fields[name] !== undefined) resolved[name] = fields[name];
        if (fractional !== undefined) resolved.fractionalSecondDigits = fractional;
        if (dateStyle) resolved.dateStyle = dateStyle;
        if (timeStyle) resolved.timeStyle = timeStyle;
        this.#options = resolved;
      }
      formatToParts(date) {
        const value = date === undefined ? Date.now() : Number(date instanceof Date ? date.getTime() : date);
        if (!Number.isFinite(value)) throw new RangeError("Invalid time value");
        const d = new Date(value);
        const utc = this.#options.timeZone === "UTC";
        const get = (name) => (utc ? d[`getUTC${name}`]() : d[`get${name}`]());
        const o = this.#options;
        const parts = [];
        const lit = (value) => parts.push({ type: "literal", value });
        const part = (type, value) => parts.push({ type, value });
        const two = (n) => String(n).padStart(2, "0");
        const month = get("Month");
        const style = {
          full: { weekday: "long", month: "long", day: "numeric", year: "numeric" },
          long: { month: "long", day: "numeric", year: "numeric" },
          medium: { month: "short", day: "numeric", year: "numeric" },
          short: { month: "numeric", day: "numeric", year: "2-digit" },
        };
        const timeOf = { full: ["numeric", "2-digit", "2-digit", "long"], long: ["numeric", "2-digit", "2-digit", "short"], medium: ["numeric", "2-digit", "2-digit"], short: ["numeric", "2-digit"] };
        const f = o.dateStyle ? style[o.dateStyle] : o;
        const t = o.timeStyle ? timeOf[o.timeStyle] : o.hour !== undefined ? [o.hour, o.minute, o.second] : null;
        const dateParts = () => {
          const textMonth = f.month === "long" || f.month === "short" || f.month === "narrow";
          const monthName = f.month === "long" ? MONTHS[month] : f.month === "short" ? MONTHS[month].slice(0, 3) : MONTHS[month][0];
          const year = f.year === "2-digit" ? two(get("FullYear") % 100) : String(get("FullYear"));
          const day = f.day === "2-digit" ? two(get("Date")) : String(get("Date"));
          const weekday = f.weekday === "long" ? DAYS[get("Day")] : f.weekday === "short" ? DAYS[get("Day")].slice(0, 3) : f.weekday === "narrow" ? DAYS[get("Day")][0] : null;
          if (weekday !== null) {
            part("weekday", weekday);
            if (f.month || f.day || f.year) lit(", ");
          }
          if (textMonth) {
            if (f.month) part("month", monthName);
            if (f.day) {
              if (f.month) lit(" ");
              part("day", day);
            }
            if (f.year) {
              if (f.day) lit(", ");
              else if (f.month) lit(" ");
              part("year", year);
            }
          } else {
            const numeric = [];
            if (f.month) numeric.push(["month", f.month === "2-digit" ? two(month + 1) : String(month + 1)]);
            if (f.day) numeric.push(["day", day]);
            if (f.year) numeric.push(["year", year]);
            numeric.forEach(([type, v], i) => {
              if (i > 0) lit("/");
              part(type, v);
            });
          }
          return textMonth;
        };
        const timeParts = () => {
          const [hourStyle, minuteStyle, secondStyle, zoneStyle] = t;
          const cycle = o.hourCycle;
          let hour = get("Hours");
          const twelve = cycle === "h11" || cycle === "h12";
          if (cycle === "h12") hour = hour % 12 === 0 ? 12 : hour % 12;
          else if (cycle === "h11") hour %= 12;
          else if (cycle === "h24") hour = hour === 0 ? 24 : hour;
          const twoHour = hourStyle === "2-digit" || !twelve;
          part("hour", twoHour ? two(hour) : String(hour));
          if (minuteStyle !== undefined) {
            lit(":");
            part("minute", two(get("Minutes")));
          }
          if (secondStyle !== undefined) {
            lit(":");
            part("second", two(get("Seconds")));
          }
          if (o.fractionalSecondDigits) {
            lit(".");
            part("fractionalSecond", String(get("Milliseconds")).padStart(3, "0").slice(0, o.fractionalSecondDigits));
          }
          if (twelve) {
            lit(NNBSP);
            part("dayPeriod", get("Hours") < 12 ? "AM" : "PM");
          }
          if (zoneStyle) {
            lit(" ");
            part("timeZoneName", zoneStyle === "long" ? "Coordinated Universal Time" : "UTC");
          }
        };
        const hasDate = !!(o.dateStyle || f.weekday || f.year || f.month || f.day) && !(o.timeStyle && !o.dateStyle);
        let textual = false;
        if (hasDate) textual = dateParts();
        if (t) {
          if (hasDate) lit(o.dateStyle === "full" || o.dateStyle === "long" || (!o.dateStyle && textual && f.year) ? " at " : !o.dateStyle && f.weekday && !f.month && !f.day && !f.year ? " " : ", ");
          timeParts();
        }
        return parts;
      }
      format(date) {
        return this.formatToParts(date)
          .map((p) => p.value)
          .join("")
          .replace(/\u202f/g, " ");
      }
      resolvedOptions() {
        return Object.assign({}, this.#options);
      }
      static supportedLocalesOf(locales) {
        return supportedLocalesOf(locales);
      }
      get [Symbol.toStringTag]() {
        return "Intl.DateTimeFormat";
      }
    }

    // --- What is not provided --------------------------------------------------------------------
    const missing = (name) =>
      function () {
        throw unsupported(`Intl.${name}`, "Yavin's extension host provides Intl's Collator, DateTimeFormat, ListFormat and Segmenter (graphemes) only");
      };
    // Collator and DateTimeFormat may be called without `new` (ECMA-402's legacy constructors);
    // ListFormat and Segmenter may not.
    const callable = (Class, name) => {
      // A function (not a method): it is a constructor too.
      const constructor = function (locales, opts) {
        return new Class(locales, opts);
      };
      Object.defineProperty(constructor, "name", { value: name });
      constructor.prototype = Class.prototype;
      Object.defineProperty(Class.prototype, "constructor", { value: constructor, writable: true, configurable: true });
      constructor.supportedLocalesOf = Class.supportedLocalesOf;
      return constructor;
    };
    const Intl = {
      Collator: callable(Collator, "Collator"),
      DateTimeFormat: callable(DateTimeFormat, "DateTimeFormat"),
      ListFormat,
      Segmenter,
      getCanonicalLocales: (locales) => canonicalList(locales),
      supportedValuesOf: missing("supportedValuesOf"),
    };
    for (const name of ["NumberFormat", "PluralRules", "RelativeTimeFormat", "DisplayNames", "Locale", "DurationFormat"]) Intl[name] = missing(name);
    Object.defineProperty(Intl, Symbol.toStringTag, { value: "Intl" });
    Object.defineProperty(globalThis, "Intl", { value: Intl, writable: true, configurable: true, enumerable: false });
    // As with ICU: comparing strings by locale is the collator's comparison.
    const collators = new Map();
    Object.defineProperty(String.prototype, "localeCompare", {
      value: function localeCompare(that, locales, opts) {
        if (this === null || this === undefined) throw new TypeError("String.prototype.localeCompare called on null or undefined");
        const key = opts === undefined && locales === undefined ? "" : null;
        let collator = key === "" ? collators.get(key) : null;
        if (!collator) {
          collator = new Collator(locales, opts);
          if (key === "") collators.set(key, collator);
        }
        return collator.compare(String(this), String(that));
      },
      writable: true,
      configurable: true,
      enumerable: false,
    });
    return Intl;
  }
