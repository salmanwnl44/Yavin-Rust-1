  // --- Web platform globals (EXT-28) --------------------------------------------------------------
  //
  // What VS Code extensions' code finds in Node.js and in a browser but QuickJS does not have:
  // `URL` and `URLSearchParams` (the WHATWG URL Standard's parser and serializers), `crypto`'s
  // random values (from the operating system, through the host: never `Math.random`),
  // `EventTarget`, `Event`, `AbortController` and `AbortSignal`, and `structuredClone`. All of
  // it is computation; none of it reaches anything. Each global is installed only where the
  // engine has none (in a browser or Node.js, as in Yavin's own tests, theirs stay).
  //
  // Known differences, said in `vscodeApi.json`: a host name with non-ASCII letters is mapped by
  // lower-casing, NFC and Punycode, not by UTS #46's full mapping table (so a few exotic inputs a
  // browser maps or refuses are kept); `crypto.subtle` is not provided.
  function webRuntime(options) {
    const { random, unsupported, report } = options;
    const install = (name, value) => {
      if (typeof globalThis[name] === "undefined")
        Object.defineProperty(globalThis, name, { value, writable: true, configurable: true, enumerable: false });
    };

    // --- Text: UTF-8 as the URL Standard uses it ------------------------------------------------
    /** A string's scalar values: a lone surrogate becomes U+FFFD (Web IDL's USVString). */
    const usv = (value) => String(value).replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "�");
    const utf8 = (text) => {
      const bytes = [];
      for (const char of text) {
        const c = char.codePointAt(0);
        if (c < 0x80) bytes.push(c);
        else if (c < 0x800) bytes.push(0xc0 | (c >> 6), 0x80 | (c & 63));
        else if (c < 0x10000) bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
        else bytes.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      }
      return bytes;
    };
    /** The Encoding Standard's UTF-8 decode (without BOM), each bad sequence one U+FFFD. */
    const fromUtf8 = (bytes) => {
      let out = "";
      let i = 0;
      while (i < bytes.length) {
        const b = bytes[i];
        if (b < 0x80) {
          out += String.fromCharCode(b);
          i++;
          continue;
        }
        let need = 0;
        let cp = 0;
        let lower = 0x80;
        let upper = 0xbf;
        if (b >= 0xc2 && b <= 0xdf) (need = 1), (cp = b & 0x1f);
        else if (b >= 0xe0 && b <= 0xef) {
          need = 2;
          cp = b & 0xf;
          if (b === 0xe0) lower = 0xa0;
          if (b === 0xed) upper = 0x9f;
        } else if (b >= 0xf0 && b <= 0xf4) {
          need = 3;
          cp = b & 0x7;
          if (b === 0xf0) lower = 0x90;
          if (b === 0xf4) upper = 0x8f;
        } else {
          out += "�";
          i++;
          continue;
        }
        let j = 1;
        for (; j <= need; j++) {
          const next = bytes[i + j];
          if (next === undefined || next < lower || next > upper) break;
          cp = (cp << 6) | (next & 0x3f);
          lower = 0x80;
          upper = 0xbf;
        }
        if (j <= need) {
          out += "�";
          i += j;
          continue;
        }
        out += String.fromCodePoint(cp);
        i += need + 1;
      }
      return out;
    };
    const HEX = "0123456789ABCDEF";
    const isHex = (c) => (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x46) || (c >= 0x61 && c <= 0x66);
    const hexValue = (c) => (c <= 0x39 ? c - 0x30 : (c | 0x20) - 0x57);
    /** Percent-decodes a string's UTF-8 bytes (the URL Standard's "percent-decode"). */
    const percentDecodeBytes = (bytes) => {
      const out = [];
      for (let i = 0; i < bytes.length; i++) {
        const b = bytes[i];
        if (b === 0x25 && i + 2 < bytes.length && isHex(bytes[i + 1]) && isHex(bytes[i + 2])) {
          out.push(hexValue(bytes[i + 1]) * 16 + hexValue(bytes[i + 2]));
          i += 2;
        } else out.push(b);
      }
      return out;
    };

    // --- Percent-encode sets ---------------------------------------------------------------------
    const inList = (list) => {
      const set = new Set(list);
      return (c) => set.has(c);
    };
    const C0 = (c) => c < 0x20 || c > 0x7e;
    const FRAGMENT = ((extra) => (c) => C0(c) || extra(c))(inList([0x20, 0x22, 0x3c, 0x3e, 0x60]));
    const QUERY = ((extra) => (c) => C0(c) || extra(c))(inList([0x20, 0x22, 0x23, 0x3c, 0x3e]));
    const SPECIAL_QUERY = (c) => QUERY(c) || c === 0x27;
    const PATH = ((extra) => (c) => QUERY(c) || extra(c))(inList([0x3f, 0x5e, 0x60, 0x7b, 0x7d]));
    const USERINFO = ((extra) => (c) => PATH(c) || extra(c))(inList([0x2f, 0x3a, 0x3b, 0x3d, 0x40, 0x5b, 0x5c, 0x5d, 0x5e, 0x7c]));
    const COMPONENT = ((extra) => (c) => USERINFO(c) || extra(c))(inList([0x24, 0x25, 0x26, 0x2b, 0x2c]));
    const FORM = ((extra) => (c) => COMPONENT(c) || extra(c))(inList([0x21, 0x27, 0x28, 0x29, 0x7e]));
    const encodeByte = (b) => `%${HEX[b >> 4]}${HEX[b & 15]}`;
    const encodeChar = (char, set) => {
      const c = char.codePointAt(0);
      if (!set(c)) return char;
      return utf8(char).map(encodeByte).join("");
    };
    const encodeString = (text, set, spaceAsPlus = false) => {
      let out = "";
      for (const char of text) out += spaceAsPlus && char === " " ? "+" : encodeChar(char, set);
      return out;
    };

    // --- Hosts -----------------------------------------------------------------------------------
    const FORBIDDEN_HOST = inList([0x00, 0x09, 0x0a, 0x0d, 0x20, 0x23, 0x2f, 0x3a, 0x3c, 0x3e, 0x3f, 0x40, 0x5b, 0x5c, 0x5d, 0x5e, 0x7c]);
    const FORBIDDEN_DOMAIN = (c) => FORBIDDEN_HOST(c) || (c >= 0 && c <= 0x1f) || c === 0x25 || c === 0x7f;
    const FAILURE = Symbol("failure");

    /** RFC 3492's Punycode encoding of one label. */
    const punycode = (label) => {
      const input = Array.from(label, (ch) => ch.codePointAt(0));
      let n = 128;
      let delta = 0;
      let bias = 72;
      let output = input.filter((c) => c < 0x80).map((c) => String.fromCharCode(c)).join("");
      const basic = output.length;
      let handled = basic;
      if (basic > 0) output += "-";
      const digit = (d) => String.fromCharCode(d + 22 + 75 * (d < 26));
      const adapt = (d, points, first) => {
        d = first ? Math.floor(d / 700) : d >> 1;
        d += Math.floor(d / points);
        let k = 0;
        while (d > 455) {
          d = Math.floor(d / 35);
          k += 36;
        }
        return k + Math.floor((36 * d) / (d + 38));
      };
      while (handled < input.length) {
        const m = Math.min(...input.filter((c) => c >= n));
        delta += (m - n) * (handled + 1);
        n = m;
        for (const c of input) {
          if (c < n) delta++;
          if (c === n) {
            let q = delta;
            for (let k = 36; ; k += 36) {
              const t = k <= bias ? 1 : k >= bias + 26 ? 26 : k - bias;
              if (q < t) break;
              output += digit(t + ((q - t) % (36 - t)));
              q = Math.floor((q - t) / (36 - t));
            }
            output += digit(q);
            bias = adapt(delta, handled + 1, handled === basic);
            delta = 0;
            handled++;
          }
        }
        delta++;
        n++;
      }
      return output;
    };
    /** Whether an `xn--` label's Punycode decodes (an undecodable one is refused, as browsers do). */
    const punycodeDecodes = (encoded) => {
      if (!/^[a-z0-9-]*$/.test(encoded)) return false;
      const dash = encoded.lastIndexOf("-");
      const output = dash > 0 ? Array.from(encoded.slice(0, dash)) : [];
      let i = 0;
      let n = 128;
      let bias = 72;
      for (let pos = dash > 0 ? dash + 1 : 0; pos < encoded.length; ) {
        const old = i;
        for (let w = 1, k = 36; ; k += 36) {
          if (pos >= encoded.length) return false;
          const c = encoded.charCodeAt(pos++);
          const d = c - 48 < 10 ? c - 22 : c - 97 < 26 ? c - 97 : 36;
          if (d >= 36) return false;
          i += d * w;
          const t = k <= bias ? 1 : k >= bias + 26 ? 26 : k - bias;
          if (d < t) break;
          w *= 36 - t;
          if (w > 0x7fffffff) return false;
        }
        const points = output.length + 1;
        let delta = old === 0 ? Math.floor((i - old) / 700) : (i - old) >> 1;
        delta += Math.floor(delta / points);
        let k = 0;
        while (delta > 455) {
          delta = Math.floor(delta / 35);
          k += 36;
        }
        bias = k + Math.floor((36 * delta) / (delta + 38));
        n += Math.floor(i / points);
        i %= points;
        if (n > 0x10ffff) return false;
        output.splice(i++, 0, String.fromCodePoint(n));
      }
      return output.length > 0;
    };
    /** UTS #46 ToASCII as the URL Standard asks (see the known differences above). */
    const domainToASCII = (domain) => {
      const mapped = domain.replace(/[。．｡]/g, ".").normalize("NFC").toLowerCase();
      const labels = mapped.split(".").map((label) => {
        // eslint-disable-next-line no-control-regex
        if (/^[\x00-\x7f]*$/.test(label)) {
          if (label.startsWith("xn--") && !punycodeDecodes(label.slice(4))) return FAILURE;
          return label;
        }
        return `xn--${punycode(label)}`;
      });
      if (labels.includes(FAILURE)) return FAILURE;
      const ascii = labels.join(".");
      return ascii === "" ? FAILURE : ascii;
    };
    const ipv4Number = (text) => {
      if (text === "") return FAILURE;
      let radix = 10;
      if (/^0[xX]/.test(text)) (text = text.slice(2)), (radix = 16);
      else if (text.length > 1 && text[0] === "0") (text = text.slice(1)), (radix = 8);
      if (text === "") return 0;
      const valid = radix === 10 ? /^[0-9]+$/ : radix === 16 ? /^[0-9A-Fa-f]+$/ : /^[0-7]+$/;
      if (!valid.test(text)) return FAILURE;
      return parseInt(text, radix);
    };
    const endsInANumber = (text) => {
      const parts = text.split(".");
      if (parts[parts.length - 1] === "") {
        if (parts.length === 1) return false;
        parts.pop();
      }
      const last = parts[parts.length - 1];
      if (last !== "" && /^[0-9]+$/.test(last)) return true;
      return ipv4Number(last) !== FAILURE;
    };
    const parseIPv4 = (text) => {
      const parts = text.split(".");
      if (parts[parts.length - 1] === "" && parts.length > 1) parts.pop();
      if (parts.length > 4) return FAILURE;
      const numbers = [];
      for (const part of parts) {
        const n = ipv4Number(part);
        if (n === FAILURE) return FAILURE;
        numbers.push(n);
      }
      for (let i = 0; i < numbers.length - 1; i++) if (numbers[i] > 255) return FAILURE;
      if (numbers[numbers.length - 1] >= 256 ** (5 - numbers.length)) return FAILURE;
      let ipv4 = numbers[numbers.length - 1];
      for (let i = 0; i < numbers.length - 1; i++) ipv4 += numbers[i] * 256 ** (3 - i);
      return { ipv4 };
    };
    const parseIPv6 = (text) => {
      const input = Array.from(text, (ch) => ch.codePointAt(0));
      const address = [0, 0, 0, 0, 0, 0, 0, 0];
      let piece = 0;
      let compress = null;
      let p = 0;
      const at = (i) => input[i];
      if (at(p) === 0x3a) {
        if (at(p + 1) !== 0x3a) return FAILURE;
        p += 2;
        piece++;
        compress = piece;
      }
      while (at(p) !== undefined) {
        if (piece === 8) return FAILURE;
        if (at(p) === 0x3a) {
          if (compress !== null) return FAILURE;
          p++;
          piece++;
          compress = piece;
          continue;
        }
        let value = 0;
        let length = 0;
        while (length < 4 && at(p) !== undefined && isHex(at(p))) {
          value = value * 16 + hexValue(at(p));
          p++;
          length++;
        }
        if (at(p) === 0x2e) {
          if (length === 0) return FAILURE;
          p -= length;
          if (piece > 6) return FAILURE;
          let seen = 0;
          while (at(p) !== undefined) {
            let v4 = null;
            if (seen > 0) {
              if (at(p) === 0x2e && seen < 4) p++;
              else return FAILURE;
            }
            if (at(p) === undefined || at(p) < 0x30 || at(p) > 0x39) return FAILURE;
            while (at(p) !== undefined && at(p) >= 0x30 && at(p) <= 0x39) {
              const digit = at(p) - 0x30;
              if (v4 === null) v4 = digit;
              else if (v4 === 0) return FAILURE;
              else v4 = v4 * 10 + digit;
              if (v4 > 255) return FAILURE;
              p++;
            }
            address[piece] = address[piece] * 0x100 + v4;
            seen++;
            if (seen === 2 || seen === 4) piece++;
          }
          if (seen !== 4) return FAILURE;
          break;
        } else if (at(p) === 0x3a) {
          p++;
          if (at(p) === undefined) return FAILURE;
        } else if (at(p) !== undefined) return FAILURE;
        address[piece] = value;
        piece++;
      }
      if (compress !== null) {
        let swaps = piece - compress;
        piece = 7;
        while (piece !== 0 && swaps > 0) {
          const t = address[piece];
          address[piece] = address[compress + swaps - 1];
          address[compress + swaps - 1] = t;
          piece--;
          swaps--;
        }
      } else if (piece !== 8) return FAILURE;
      return { ipv6: address };
    };
    const parseHost = (input, opaque) => {
      if (input.startsWith("[")) {
        if (!input.endsWith("]")) return FAILURE;
        return parseIPv6(input.slice(1, -1));
      }
      if (opaque) {
        for (const ch of input) if (FORBIDDEN_HOST(ch.codePointAt(0))) return FAILURE;
        return encodeString(input, C0);
      }
      const domain = fromUtf8(percentDecodeBytes(utf8(input)));
      const ascii = domainToASCII(domain);
      if (ascii === FAILURE) return FAILURE;
      for (const ch of ascii) if (FORBIDDEN_DOMAIN(ch.codePointAt(0))) return FAILURE;
      if (endsInANumber(ascii)) return parseIPv4(ascii);
      return ascii;
    };
    const serializeHost = (host) => {
      if (host === null) return "";
      if (typeof host === "string") return host;
      if ("ipv4" in host) {
        const parts = [];
        let n = host.ipv4;
        for (let i = 0; i < 4; i++) {
          parts.unshift(String(n % 256));
          n = Math.floor(n / 256);
        }
        return parts.join(".");
      }
      const pieces = host.ipv6;
      let best = -1;
      let bestLength = 1;
      for (let i = 0; i < 8; ) {
        if (pieces[i] !== 0) {
          i++;
          continue;
        }
        let j = i;
        while (j < 8 && pieces[j] === 0) j++;
        if (j - i > bestLength) (best = i), (bestLength = j - i);
        i = j;
      }
      let out = "";
      let ignore0 = false;
      for (let i = 0; i < 8; i++) {
        if (ignore0 && pieces[i] === 0) continue;
        ignore0 = false;
        if (best === i) {
          out += i === 0 ? "::" : ":";
          ignore0 = true;
          continue;
        }
        out += pieces[i].toString(16);
        if (i !== 7) out += ":";
      }
      return `[${out}]`;
    };

    // --- The basic URL parser --------------------------------------------------------------------
    const SPECIAL = { ftp: 21, file: null, http: 80, https: 443, ws: 80, wss: 443 };
    const isSpecial = (scheme) => Object.hasOwn(SPECIAL, scheme);
    const isAlpha = (c) => (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);
    const isDigit = (c) => c >= 0x30 && c <= 0x39;
    const isDriveLetter = (s, normalizedOnly = false) => {
      const cps = Array.from(s);
      return cps.length === 2 && isAlpha(cps[0].codePointAt(0)) && (cps[1] === ":" || (!normalizedOnly && cps[1] === "|"));
    };
    const startsWithDriveLetter = (cps, from) =>
      cps.length - from >= 2 &&
      isAlpha(cps[from]) &&
      (cps[from + 1] === 0x3a || cps[from + 1] === 0x7c) &&
      (cps.length - from === 2 || [0x2f, 0x5c, 0x3f, 0x23].includes(cps[from + 2]));
    const singleDot = (s) => s === "." || s.toLowerCase() === "%2e";
    const doubleDot = (s) => ["..", ".%2e", "%2e.", "%2e%2e"].includes(s.toLowerCase());
    const hasCredentials = (url) => url.username !== "" || url.password !== "";
    const cannotHaveCredentials = (url) => url.host === null || url.host === "" || url.scheme === "file";
    const opaque = (url) => typeof url.path === "string";
    const shorten = (url) => {
      if (url.scheme === "file" && url.path.length === 1 && isDriveLetter(url.path[0], true)) return;
      url.path.pop();
    };
    const blank = () => ({ scheme: "", username: "", password: "", host: null, port: null, path: [], query: null, fragment: null });

    /** The URL Standard's basic URL parser: a URL record, or FAILURE. */
    const parse = (rawInput, base, given, override) => {
      let input = rawInput;
      const url = given || blank();
      // eslint-disable-next-line no-control-regex
      if (!given) input = input.replace(/^[\u0000- ]+|[\u0000- ]+$/g, "");
      input = input.replace(/[\t\n\r]/g, "");
      const cps = Array.from(input, (ch) => ch.codePointAt(0));
      let state = override || "scheme start";
      let buffer = "";
      let atSign = false;
      let brackets = false;
      let passwordSeen = false;
      const remaining = (i) => cps[i];
      for (let p = 0; ; p++) {
        const c = cps[p];
        const ch = c === undefined ? "" : String.fromCodePoint(c);
        const eof = c === undefined;
        const special = isSpecial(url.scheme);
        switch (state) {
          case "scheme start":
            if (!eof && isAlpha(c)) {
              buffer += ch.toLowerCase();
              state = "scheme";
            } else if (!override) {
              state = "no scheme";
              p--;
            } else return FAILURE;
            break;
          case "scheme":
            if (!eof && (isAlpha(c) || isDigit(c) || c === 0x2b || c === 0x2d || c === 0x2e)) buffer += ch.toLowerCase();
            else if (c === 0x3a) {
              if (override) {
                if (isSpecial(url.scheme) !== isSpecial(buffer)) return url;
                if ((hasCredentials(url) || url.port !== null) && buffer === "file") return url;
                if (url.scheme === "file" && url.host === "") return url;
              }
              url.scheme = buffer;
              if (override) {
                if (url.port === SPECIAL[url.scheme]) url.port = null;
                return url;
              }
              buffer = "";
              if (url.scheme === "file") state = "file";
              else if (isSpecial(url.scheme) && base && base.scheme === url.scheme) state = "special relative or authority";
              else if (isSpecial(url.scheme)) state = "special authority slashes";
              else if (remaining(p + 1) === 0x2f) {
                state = "path or authority";
                p++;
              } else {
                url.path = "";
                state = "opaque path";
              }
            } else if (!override) {
              buffer = "";
              state = "no scheme";
              p = -1;
            } else return FAILURE;
            break;
          case "no scheme":
            if (!base || (opaque(base) && c !== 0x23)) return FAILURE;
            if (opaque(base) && c === 0x23) {
              url.scheme = base.scheme;
              url.path = base.path;
              url.query = base.query;
              url.fragment = "";
              state = "fragment";
            } else if (base.scheme !== "file") {
              state = "relative";
              p--;
            } else {
              state = "file";
              p--;
            }
            break;
          case "special relative or authority":
            if (c === 0x2f && remaining(p + 1) === 0x2f) {
              state = "special authority ignore slashes";
              p++;
            } else {
              state = "relative";
              p--;
            }
            break;
          case "path or authority":
            if (c === 0x2f) state = "authority";
            else {
              state = "path";
              p--;
            }
            break;
          case "relative":
            url.scheme = base.scheme;
            if (c === 0x2f) state = "relative slash";
            else if (isSpecial(url.scheme) && c === 0x5c) state = "relative slash";
            else {
              url.username = base.username;
              url.password = base.password;
              url.host = base.host;
              url.port = base.port;
              url.path = base.path.slice();
              url.query = base.query;
              if (c === 0x3f) {
                url.query = "";
                state = "query";
              } else if (c === 0x23) {
                url.fragment = "";
                state = "fragment";
              } else if (!eof) {
                url.query = null;
                shorten(url);
                state = "path";
                p--;
              }
            }
            break;
          case "relative slash":
            if (isSpecial(url.scheme) && (c === 0x2f || c === 0x5c)) state = "special authority ignore slashes";
            else if (c === 0x2f) state = "authority";
            else {
              url.username = base.username;
              url.password = base.password;
              url.host = base.host;
              url.port = base.port;
              state = "path";
              p--;
            }
            break;
          case "special authority slashes":
            if (c === 0x2f && remaining(p + 1) === 0x2f) {
              state = "special authority ignore slashes";
              p++;
            } else {
              state = "special authority ignore slashes";
              p--;
            }
            break;
          case "special authority ignore slashes":
            if (c !== 0x2f && c !== 0x5c) {
              state = "authority";
              p--;
            }
            break;
          case "authority":
            if (c === 0x40) {
              if (atSign) buffer = `%40${buffer}`;
              atSign = true;
              for (const b of buffer) {
                if (b === ":" && !passwordSeen) {
                  passwordSeen = true;
                  continue;
                }
                const encoded = encodeChar(b, USERINFO);
                if (passwordSeen) url.password += encoded;
                else url.username += encoded;
              }
              buffer = "";
            } else if (eof || c === 0x2f || c === 0x3f || c === 0x23 || (special && c === 0x5c)) {
              if (atSign && buffer === "") return FAILURE;
              p -= Array.from(buffer).length + 1;
              buffer = "";
              state = "host";
            } else buffer += ch;
            break;
          case "host":
          case "hostname":
            if (override && url.scheme === "file") {
              p--;
              state = "file host";
            } else if (c === 0x3a && !brackets) {
              if (buffer === "") return FAILURE;
              if (override === "hostname") return url;
              const host = parseHost(buffer, !special);
              if (host === FAILURE) return FAILURE;
              url.host = host;
              buffer = "";
              state = "port";
            } else if (eof || c === 0x2f || c === 0x3f || c === 0x23 || (special && c === 0x5c)) {
              p--;
              if (special && buffer === "") return FAILURE;
              if (override && buffer === "" && (hasCredentials(url) || url.port !== null)) return url;
              const host = parseHost(buffer, !special);
              if (host === FAILURE) return FAILURE;
              url.host = host;
              buffer = "";
              state = "path start";
              if (override) return url;
            } else {
              if (c === 0x5b) brackets = true;
              if (c === 0x5d) brackets = false;
              buffer += ch;
            }
            break;
          case "port":
            if (!eof && isDigit(c)) buffer += ch;
            else if (eof || c === 0x2f || c === 0x3f || c === 0x23 || (special && c === 0x5c) || override) {
              if (buffer !== "") {
                const port = parseInt(buffer, 10);
                if (port > 65535) return FAILURE;
                url.port = port === SPECIAL[url.scheme] ? null : port;
                buffer = "";
                if (override) return url;
              }
              if (override) return url;
              state = "path start";
              p--;
            } else return FAILURE;
            break;
          case "file":
            url.scheme = "file";
            url.host = "";
            if (c === 0x2f || c === 0x5c) state = "file slash";
            else if (base && base.scheme === "file") {
              url.host = base.host;
              url.path = base.path.slice();
              url.query = base.query;
              if (c === 0x3f) {
                url.query = "";
                state = "query";
              } else if (c === 0x23) {
                url.fragment = "";
                state = "fragment";
              } else if (!eof) {
                url.query = null;
                if (!startsWithDriveLetter(cps, p)) shorten(url);
                else url.path = [];
                state = "path";
                p--;
              }
            } else {
              state = "path";
              p--;
            }
            break;
          case "file slash":
            if (c === 0x2f || c === 0x5c) state = "file host";
            else {
              if (base && base.scheme === "file") {
                url.host = base.host;
                if (!startsWithDriveLetter(cps, p) && base.path.length > 0 && isDriveLetter(base.path[0], true)) url.path.push(base.path[0]);
              }
              state = "path";
              p--;
            }
            break;
          case "file host":
            if (eof || c === 0x2f || c === 0x5c || c === 0x3f || c === 0x23) {
              p--;
              if (!override && isDriveLetter(buffer)) state = "path";
              else if (buffer === "") {
                url.host = "";
                if (override) return url;
                state = "path start";
              } else {
                let host = parseHost(buffer, !special);
                if (host === FAILURE) return FAILURE;
                if (host === "localhost") host = "";
                url.host = host;
                if (override) return url;
                buffer = "";
                state = "path start";
              }
            } else buffer += ch;
            break;
          case "path start":
            if (special) {
              state = "path";
              if (c !== 0x2f && c !== 0x5c) p--;
            } else if (!override && c === 0x3f) {
              url.query = "";
              state = "query";
            } else if (!override && c === 0x23) {
              url.fragment = "";
              state = "fragment";
            } else if (!eof) {
              state = "path";
              if (c !== 0x2f) p--;
            } else if (override && url.host === null) url.path.push("");
            break;
          case "path":
            if (eof || c === 0x2f || (special && c === 0x5c) || (!override && (c === 0x3f || c === 0x23))) {
              const slash = c === 0x2f || (special && c === 0x5c);
              if (doubleDot(buffer)) {
                shorten(url);
                if (!slash) url.path.push("");
              } else if (singleDot(buffer) && !slash) url.path.push("");
              else if (!singleDot(buffer)) {
                if (url.scheme === "file" && url.path.length === 0 && isDriveLetter(buffer)) buffer = `${Array.from(buffer)[0]}:`;
                url.path.push(buffer);
              }
              buffer = "";
              if (c === 0x3f) {
                url.query = "";
                state = "query";
              }
              if (c === 0x23) {
                url.fragment = "";
                state = "fragment";
              }
            } else buffer += encodeChar(ch, PATH);
            break;
          case "opaque path":
            if (c === 0x3f) {
              url.query = "";
              state = "query";
            } else if (c === 0x23) {
              url.fragment = "";
              state = "fragment";
            } else if (c === 0x20) {
              const next = remaining(p + 1);
              url.path += next === 0x3f || next === 0x23 ? "%20" : " ";
            } else if (!eof) url.path += encodeChar(ch, C0);
            break;
          case "query":
            if ((!override && c === 0x23) || eof) {
              url.query += encodeString(buffer, isSpecial(url.scheme) ? SPECIAL_QUERY : QUERY);
              buffer = "";
              if (c === 0x23) {
                url.fragment = "";
                state = "fragment";
              }
            } else buffer += ch;
            break;
          case "fragment":
            if (!eof) url.fragment += encodeChar(ch, FRAGMENT);
            break;
        }
        if (p >= cps.length) break;
      }
      return url;
    };
    const serializePath = (url) => (opaque(url) ? url.path : url.path.map((s) => `/${s}`).join(""));
    const serialize = (url, excludeFragment = false) => {
      let out = `${url.scheme}:`;
      if (url.host !== null) {
        out += "//";
        if (hasCredentials(url)) {
          out += url.username;
          if (url.password !== "") out += `:${url.password}`;
          out += "@";
        }
        out += serializeHost(url.host);
        if (url.port !== null) out += `:${url.port}`;
      } else if (!opaque(url) && url.path.length > 1 && url.path[0] === "") out += "/.";
      out += serializePath(url);
      if (url.query !== null) out += `?${url.query}`;
      if (!excludeFragment && url.fragment !== null) out += `#${url.fragment}`;
      return out;
    };
    const originOf = (url) => {
      if (url.scheme === "blob") {
        const inner = parse(serializePath(url), null);
        if (inner !== FAILURE && (inner.scheme === "http" || inner.scheme === "https")) return originOf(inner);
        return "null";
      }
      if (["ftp", "http", "https", "ws", "wss"].includes(url.scheme))
        return `${url.scheme}://${serializeHost(url.host)}${url.port !== null ? `:${url.port}` : ""}`;
      return "null";
    };
    /** After a setter, an opaque path's trailing spaces go when nothing follows them. */
    const stripTrailingSpaces = (url) => {
      if (!opaque(url) || url.fragment !== null || url.query !== null) return;
      url.path = url.path.replace(/ +$/, "");
    };

    // --- application/x-www-form-urlencoded --------------------------------------------------------
    const parseForm = (text) => {
      const pairs = [];
      const bytes = utf8(text);
      let start = 0;
      for (let i = 0; i <= bytes.length; i++) {
        if (i < bytes.length && bytes[i] !== 0x26) continue;
        const part = bytes.slice(start, i);
        start = i + 1;
        if (part.length === 0) continue;
        const eq = part.indexOf(0x3d);
        const name = eq === -1 ? part : part.slice(0, eq);
        const value = eq === -1 ? [] : part.slice(eq + 1);
        const plus = (b) => b.map((x) => (x === 0x2b ? 0x20 : x));
        pairs.push([fromUtf8(percentDecodeBytes(plus(name))), fromUtf8(percentDecodeBytes(plus(value)))]);
      }
      return pairs;
    };
    const serializeForm = (pairs) => pairs.map(([n, v]) => `${encodeString(n, FORM, true)}=${encodeString(v, FORM, true)}`).join("&");

    // --- URL and URLSearchParams -----------------------------------------------------------------
    const records = new WeakMap();
    const lists = new WeakMap();
    const recordOf = (self) => {
      const record = records.get(self);
      if (!record) throw new TypeError("Illegal invocation");
      return record;
    };
    const listOf = (self) => {
      const list = lists.get(self);
      if (!list) throw new TypeError("Illegal invocation");
      return list;
    };
    const invalid = (input) => Object.assign(new TypeError("Invalid URL"), { code: "ERR_INVALID_URL", input });
    const parseWithBase = (input, base) => {
      let baseRecord = null;
      if (base !== undefined) {
        baseRecord = parse(usv(base), null);
        if (baseRecord === FAILURE) return FAILURE;
      }
      return parse(usv(input), baseRecord);
    };

    class URLSearchParams {
      constructor(init = "") {
        const list = [];
        lists.set(this, { pairs: list, url: null });
        if (init !== null && typeof init === "object" && typeof init[Symbol.iterator] === "function") {
          for (const pair of init) {
            const items = Array.from(pair);
            if (items.length !== 2) throw new TypeError("Each query pair must be an iterable [name, value] tuple");
            list.push([usv(items[0]), usv(items[1])]);
          }
        } else if (init !== null && (typeof init === "object" || typeof init === "function")) {
          for (const key of Reflect.ownKeys(init)) {
            if (typeof key !== "string") continue;
            const descriptor = Reflect.getOwnPropertyDescriptor(init, key);
            if (descriptor && descriptor.enumerable) list.push([usv(key), usv(init[key])]);
          }
        } else {
          let text = usv(init);
          if (text.startsWith("?")) text = text.slice(1);
          list.push(...parseForm(text));
        }
      }
      #update() {
        const state = listOf(this);
        if (!state.url) return;
        const serialized = serializeForm(state.pairs);
        state.url.query = serialized === "" ? null : serialized;
        if (serialized === "") stripTrailingSpaces(state.url);
      }
      get size() {
        return listOf(this).pairs.length;
      }
      append(name, value) {
        if (arguments.length < 2) throw new TypeError("URLSearchParams.append needs a name and a value");
        listOf(this).pairs.push([usv(name), usv(value)]);
        this.#update();
      }
      delete(name, value) {
        const state = listOf(this);
        const n = usv(name);
        const v = value === undefined ? undefined : usv(value);
        state.pairs = state.pairs.filter(([k, x]) => !(k === n && (v === undefined || x === v)));
        this.#update();
      }
      get(name) {
        const n = usv(name);
        const found = listOf(this).pairs.find(([k]) => k === n);
        return found ? found[1] : null;
      }
      getAll(name) {
        const n = usv(name);
        return listOf(this).pairs.filter(([k]) => k === n).map(([, v]) => v);
      }
      has(name, value) {
        const n = usv(name);
        const v = value === undefined ? undefined : usv(value);
        return listOf(this).pairs.some(([k, x]) => k === n && (v === undefined || x === v));
      }
      set(name, value) {
        const state = listOf(this);
        const n = usv(name);
        const v = usv(value);
        const first = state.pairs.findIndex(([k]) => k === n);
        if (first === -1) state.pairs.push([n, v]);
        else {
          state.pairs[first][1] = v;
          state.pairs = state.pairs.filter(([k], i) => k !== n || i === first);
        }
        this.#update();
      }
      sort() {
        const state = listOf(this);
        // Stable, by code units (as the standard says).
        state.pairs = state.pairs
          .map((pair, i) => [pair, i])
          .sort(([a, i], [b, j]) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : i - j))
          .map(([pair]) => pair);
        this.#update();
      }
      forEach(callback, thisArg) {
        if (typeof callback !== "function") throw new TypeError("The callback must be a function");
        const state = listOf(this);
        for (let i = 0; i < state.pairs.length; i++) callback.call(thisArg, state.pairs[i][1], state.pairs[i][0], this);
      }
      *keys() {
        for (const [k] of listOf(this).pairs.slice()) yield k;
      }
      *values() {
        for (const [, v] of listOf(this).pairs.slice()) yield v;
      }
      *entries() {
        for (const [k, v] of listOf(this).pairs.slice()) yield [k, v];
      }
      [Symbol.iterator]() {
        return this.entries();
      }
      toString() {
        return serializeForm(listOf(this).pairs);
      }
      get [Symbol.toStringTag]() {
        return "URLSearchParams";
      }
    }
    const linkParams = (url, record) => {
      const params = new URLSearchParams(record.query === null ? "" : record.query);
      lists.get(params).url = record;
      return params;
    };
    const relist = (params, record) => {
      lists.get(params).pairs = record.query === null ? [] : parseForm(record.query);
    };

    class URL {
      #params;
      constructor(input, base) {
        if (arguments.length === 0) throw new TypeError("The URL constructor needs a URL");
        const record = parseWithBase(input, base);
        if (record === FAILURE) throw invalid(String(input));
        records.set(this, record);
        this.#params = linkParams(this, record);
      }
      static canParse(input, base) {
        return parseWithBase(input, base) !== FAILURE;
      }
      static parse(input, base) {
        return URL.canParse(input, base) ? new URL(input, base) : null;
      }
      static createObjectURL() {
        throw unsupported("URL.createObjectURL", "there are no blobs in Yavin's extension host");
      }
      static revokeObjectURL() {
        throw unsupported("URL.revokeObjectURL", "there are no blobs in Yavin's extension host");
      }
      get href() {
        return serialize(recordOf(this));
      }
      set href(value) {
        const record = parse(usv(value), null);
        if (record === FAILURE) throw invalid(String(value));
        records.set(this, record);
        lists.get(this.#params).url = record;
        relist(this.#params, record);
      }
      get origin() {
        return originOf(recordOf(this));
      }
      get protocol() {
        return `${recordOf(this).scheme}:`;
      }
      set protocol(value) {
        parse(`${usv(value)}:`, null, recordOf(this), "scheme start");
      }
      get username() {
        return recordOf(this).username;
      }
      set username(value) {
        const url = recordOf(this);
        if (cannotHaveCredentials(url)) return;
        url.username = encodeString(usv(value), USERINFO);
      }
      get password() {
        return recordOf(this).password;
      }
      set password(value) {
        const url = recordOf(this);
        if (cannotHaveCredentials(url)) return;
        url.password = encodeString(usv(value), USERINFO);
      }
      get host() {
        const url = recordOf(this);
        if (url.host === null) return "";
        return url.port === null ? serializeHost(url.host) : `${serializeHost(url.host)}:${url.port}`;
      }
      set host(value) {
        const url = recordOf(this);
        if (opaque(url)) return;
        // As the standard says: a failure part-way (a bad port) keeps what was set before it.
        parse(usv(value), null, url, "host");
      }
      get hostname() {
        return serializeHost(recordOf(this).host);
      }
      set hostname(value) {
        const url = recordOf(this);
        if (opaque(url)) return;
        parse(usv(value), null, url, "hostname");
      }
      get port() {
        const port = recordOf(this).port;
        return port === null ? "" : String(port);
      }
      set port(value) {
        const url = recordOf(this);
        if (cannotHaveCredentials(url)) return;
        const text = usv(value);
        if (text === "") url.port = null;
        else {
          parse(text, null, url, "port");
        }
      }
      get pathname() {
        return serializePath(recordOf(this));
      }
      set pathname(value) {
        const url = recordOf(this);
        if (opaque(url)) return;
        url.path = [];
        parse(usv(value), null, url, "path start");
      }
      get search() {
        const query = recordOf(this).query;
        return query === null || query === "" ? "" : `?${query}`;
      }
      set search(value) {
        const url = recordOf(this);
        const text = usv(value);
        if (text === "") {
          url.query = null;
          lists.get(this.#params).pairs = [];
          stripTrailingSpaces(url);
          return;
        }
        const input = text.startsWith("?") ? text.slice(1) : text;
        url.query = "";
        parse(input, null, url, "query");
        lists.get(this.#params).pairs = parseForm(input);
      }
      get searchParams() {
        recordOf(this);
        return this.#params;
      }
      get hash() {
        const fragment = recordOf(this).fragment;
        return fragment === null || fragment === "" ? "" : `#${fragment}`;
      }
      set hash(value) {
        const url = recordOf(this);
        const text = usv(value);
        if (text === "") {
          url.fragment = null;
          stripTrailingSpaces(url);
          return;
        }
        url.fragment = "";
        parse(text.startsWith("#") ? text.slice(1) : text, null, url, "fragment");
      }
      toString() {
        return this.href;
      }
      toJSON() {
        return this.href;
      }
      get [Symbol.toStringTag]() {
        return "URL";
      }
    }
    for (const name of ["href", "origin", "protocol", "username", "password", "host", "hostname", "port", "pathname", "search", "searchParams", "hash"])
      Object.defineProperty(URL.prototype, name, Object.assign(Object.getOwnPropertyDescriptor(URL.prototype, name), { enumerable: true }));
    install("URL", URL);
    install("URLSearchParams", URLSearchParams);

    // --- Events and abort signals ----------------------------------------------------------------
    const DOMExceptionOf = (message, name) =>
      typeof DOMException === "function" ? new DOMException(message, name) : Object.assign(new Error(message), { name });
    const eventState = new WeakMap();
    class Event {
      constructor(type, init = {}) {
        if (arguments.length === 0) throw new TypeError("The Event constructor needs a type");
        eventState.set(this, {
          type: String(type),
          bubbles: !!(init && init.bubbles),
          cancelable: !!(init && init.cancelable),
          composed: !!(init && init.composed),
          defaultPrevented: false,
          stop: false,
          target: null,
          currentTarget: null,
          phase: 0,
          timeStamp: typeof performance === "object" && performance.now ? performance.now() : Date.now(),
        });
      }
      get type() {
        return eventState.get(this).type;
      }
      get bubbles() {
        return eventState.get(this).bubbles;
      }
      get cancelable() {
        return eventState.get(this).cancelable;
      }
      get composed() {
        return eventState.get(this).composed;
      }
      get defaultPrevented() {
        return eventState.get(this).defaultPrevented;
      }
      get target() {
        return eventState.get(this).target;
      }
      get currentTarget() {
        return eventState.get(this).currentTarget;
      }
      get srcElement() {
        return eventState.get(this).target;
      }
      get eventPhase() {
        return eventState.get(this).phase;
      }
      get timeStamp() {
        return eventState.get(this).timeStamp;
      }
      get isTrusted() {
        return false;
      }
      get returnValue() {
        return !eventState.get(this).defaultPrevented;
      }
      composedPath() {
        const target = eventState.get(this).currentTarget;
        return target ? [target] : [];
      }
      preventDefault() {
        const state = eventState.get(this);
        if (state.cancelable) state.defaultPrevented = true;
      }
      stopPropagation() {}
      stopImmediatePropagation() {
        eventState.get(this).stop = true;
      }
    }
    Object.assign(Event, { NONE: 0, CAPTURING_PHASE: 1, AT_TARGET: 2, BUBBLING_PHASE: 3 });
    const listenersOf = new WeakMap();
    class EventTarget {
      constructor() {
        listenersOf.set(this, new Map());
      }
      addEventListener(type, listener, options) {
        if (listener === null || listener === undefined) return;
        const capture = typeof options === "boolean" ? options : !!(options && options.capture);
        const once = !!(options && typeof options === "object" && options.once);
        const signal = options && typeof options === "object" ? options.signal : undefined;
        if (signal && signal.aborted) return;
        const map = listenersOf.get(this);
        const list = map.get(String(type)) || [];
        if (list.some((l) => l.listener === listener && l.capture === capture)) return;
        const entry = { listener, capture, once, removed: false };
        list.push(entry);
        map.set(String(type), list);
        if (signal) signal.addEventListener("abort", () => this.removeEventListener(type, listener, { capture }));
      }
      removeEventListener(type, listener, options) {
        const capture = typeof options === "boolean" ? options : !!(options && options.capture);
        const map = listenersOf.get(this);
        const list = map.get(String(type));
        if (!list) return;
        const index = list.findIndex((l) => l.listener === listener && l.capture === capture);
        if (index === -1) return;
        list[index].removed = true;
        list.splice(index, 1);
      }
      dispatchEvent(event) {
        if (!(event instanceof Event)) throw new TypeError("dispatchEvent needs an Event");
        const state = eventState.get(event);
        if (state.phase !== 0) throw DOMExceptionOf("The event is already being dispatched", "InvalidStateError");
        state.target = this;
        state.currentTarget = this;
        state.phase = 2;
        const list = (listenersOf.get(this).get(state.type) || []).slice();
        // Of the targets here, only an AbortSignal has an event handler attribute (`onabort`).
        const handler = state.type === "abort" && signalState.has(this) ? this.onabort : undefined;
        if (typeof handler === "function" && !list.some((l) => l.listener === handler)) list.push({ listener: handler, once: false, removed: false });
        for (const entry of list) {
          if (entry.removed) continue;
          if (entry.once) this.removeEventListener(state.type, entry.listener, { capture: entry.capture });
          try {
            if (typeof entry.listener === "function") entry.listener.call(this, event);
            else if (entry.listener && typeof entry.listener.handleEvent === "function") entry.listener.handleEvent(event);
          } catch (error) {
            // As a browser reports it: the dispatch goes on.
            report(`An event listener of "${state.type}" threw: ${error && error.message ? error.message : error}`);
          }
          if (state.stop) break;
        }
        state.phase = 0;
        state.currentTarget = null;
        return !state.defaultPrevented;
      }
    }
    const signalState = new WeakMap();
    let creatingSignal = false;
    class AbortSignal extends EventTarget {
      constructor() {
        if (!creatingSignal) throw new TypeError("Illegal constructor");
        super();
        signalState.set(this, { aborted: false, reason: undefined });
        this.onabort = null;
      }
      get aborted() {
        return signalState.get(this).aborted;
      }
      get reason() {
        return signalState.get(this).reason;
      }
      throwIfAborted() {
        const state = signalState.get(this);
        if (state.aborted) throw state.reason;
      }
      static abort(reason) {
        const signal = newSignal();
        abortSignal(signal, reason);
        return signal;
      }
      static timeout(ms) {
        const signal = newSignal();
        setTimeout(() => abortSignal(signal, DOMExceptionOf("The operation timed out.", "TimeoutError")), Math.max(0, Number(ms) || 0));
        return signal;
      }
      static any(signals) {
        const signal = newSignal();
        const list = Array.from(signals);
        const done = list.find((s) => s.aborted);
        if (done) abortSignal(signal, done.reason);
        else for (const s of list) s.addEventListener("abort", () => abortSignal(signal, s.reason), { once: true });
        return signal;
      }
      get [Symbol.toStringTag]() {
        return "AbortSignal";
      }
    }
    const newSignal = () => {
      creatingSignal = true;
      try {
        return new AbortSignal();
      } finally {
        creatingSignal = false;
      }
    };
    const abortSignal = (signal, reason) => {
      const state = signalState.get(signal);
      if (state.aborted) return;
      state.aborted = true;
      state.reason = reason === undefined ? DOMExceptionOf("This operation was aborted", "AbortError") : reason;
      signal.dispatchEvent(new Event("abort"));
    };
    class AbortController {
      #signal = newSignal();
      get signal() {
        return this.#signal;
      }
      abort(reason) {
        abortSignal(this.#signal, reason);
      }
      get [Symbol.toStringTag]() {
        return "AbortController";
      }
    }
    install("Event", Event);
    install("EventTarget", EventTarget);
    install("AbortSignal", AbortSignal);
    install("AbortController", AbortController);

    // --- structuredClone -------------------------------------------------------------------------
    const ERRORS = { Error, EvalError, RangeError, ReferenceError, SyntaxError, TypeError, URIError };
    const cloneFailure = (what) => DOMExceptionOf(`${what} could not be cloned.`, "DataCloneError");
    const structuredCloneOf = (value, options) => {
      if (options && options.transfer && Array.from(options.transfer).length)
        throw unsupported("structuredClone with transfer", "there is nothing to transfer to in Yavin's extension host");
      const seen = new Map();
      const clone = (v) => {
        if (v === null || (typeof v !== "object" && typeof v !== "function")) {
          if (typeof v === "symbol") throw cloneFailure(String(v));
          return v;
        }
        if (typeof v === "function") throw cloneFailure(v.name ? `function ${v.name}` : "A function");
        if (seen.has(v)) return seen.get(v);
        const tag = Object.prototype.toString.call(v);
        let out;
        const keep = (copy) => {
          seen.set(v, copy);
          return copy;
        };
        switch (tag) {
          case "[object Boolean]":
            return keep(Object(Boolean.prototype.valueOf.call(v)));
          case "[object Number]":
            return keep(Object(Number.prototype.valueOf.call(v)));
          case "[object String]":
            return keep(Object(String.prototype.valueOf.call(v)));
          case "[object BigInt]":
            return keep(Object(BigInt.prototype.valueOf.call(v)));
          case "[object Date]":
            return keep(new Date(v.getTime()));
          case "[object RegExp]":
            return keep(new RegExp(v.source, v.flags));
          case "[object ArrayBuffer]":
            return keep(v.slice(0));
          case "[object DataView]":
            return keep(new DataView(clone(v.buffer), v.byteOffset, v.byteLength));
          case "[object Map]":
            out = keep(new Map());
            for (const [k, x] of v) out.set(clone(k), clone(x));
            return out;
          case "[object Set]":
            out = keep(new Set());
            for (const x of v) out.add(clone(x));
            return out;
          case "[object Error]": {
            const Kind = ERRORS[v.name] || Error;
            out = keep(Object.create(Kind.prototype));
            for (const key of ["message", "stack", "cause"])
              if (Object.hasOwn(v, key)) Object.defineProperty(out, key, { value: clone(v[key]), writable: true, configurable: true });
            if (!Object.hasOwn(out, "message")) Object.defineProperty(out, "message", { value: "", writable: true, configurable: true });
            return out;
          }
          case "[object Array]":
            out = keep(new Array(v.length));
            for (const key of Object.keys(v)) out[key] = clone(v[key]);
            return out;
          case "[object Object]":
            out = keep({});
            for (const key of Object.keys(v)) out[key] = clone(v[key]);
            return out;
          default:
            if (ArrayBuffer.isView(v)) return keep(new v.constructor(clone(v.buffer), v.byteOffset, v.length));
            throw cloneFailure(tag.slice(8, -1));
        }
      };
      return clone(value);
    };
    install("structuredClone", function structuredClone(value, options) {
      if (arguments.length === 0) throw new TypeError("structuredClone needs a value");
      return structuredCloneOf(value, options);
    });

    // --- crypto: random values from the operating system -------------------------------------
    const QUOTA = 65536;
    const INTEGER_ARRAYS = ["Int8Array", "Uint8Array", "Uint8ClampedArray", "Int16Array", "Uint16Array", "Int32Array", "Uint32Array", "BigInt64Array", "BigUint64Array"];
    /** `n` bytes from the operating system's random source (through the host), or an error. */
    const randomBytes = (n) => {
      if (typeof random !== "function") throw unsupported("crypto's random values", "this host has no random source");
      const hex = random(n);
      if (typeof hex !== "string" || hex.length !== n * 2) throw new Error("The system's random source failed.");
      const bytes = new Uint8Array(n);
      for (let i = 0; i < n; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
      return bytes;
    };
    const getRandomValues = (array) => {
      const kind = array && Object.prototype.toString.call(array).slice(8, -1);
      if (!ArrayBuffer.isView(array) || !INTEGER_ARRAYS.includes(kind))
        throw DOMExceptionOf("The data argument must be an integer-type TypedArray", "TypeMismatchError");
      if (array.byteLength > QUOTA)
        throw DOMExceptionOf(`The ArrayBufferView's byte length (${array.byteLength}) exceeds the number of bytes of entropy available via this API (${QUOTA})`, "QuotaExceededError");
      new Uint8Array(array.buffer, array.byteOffset, array.byteLength).set(randomBytes(array.byteLength));
      return array;
    };
    const randomUUID = () => {
      const b = randomBytes(16);
      b[6] = (b[6] & 0x0f) | 0x40;
      b[8] = (b[8] & 0x3f) | 0x80;
      const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
      return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
    };
    class CryptoKey {
      constructor() {
        throw new TypeError("Illegal constructor");
      }
    }
    const webcrypto = {};
    Object.defineProperties(webcrypto, {
      getRandomValues: { value: getRandomValues, enumerable: true },
      randomUUID: { value: randomUUID, enumerable: true },
      subtle: {
        enumerable: true,
        get() {
          throw unsupported("crypto.subtle", "Yavin's extension host has no Web Crypto keys or algorithms");
        },
      },
      [Symbol.toStringTag]: { value: "Crypto" },
    });
    install("crypto", webcrypto);
    install("CryptoKey", CryptoKey);

    // --- navigator: what code reads to learn where it runs (as Node.js 21+ has one) -------------
    // Said as it is: Yavin's extension host, on Windows; no browser or Node.js is claimed.
    const navigatorObject = {};
    Object.defineProperties(navigatorObject, {
      userAgent: { value: "Yavin-Extension-Host (Windows NT 10.0; Win64; x64)", enumerable: true },
      language: { value: "en-US", enumerable: true },
      languages: { value: Object.freeze(["en-US"]), enumerable: true },
      platform: { value: "win32", enumerable: true },
      hardwareConcurrency: { value: 1, enumerable: true },
      [Symbol.toStringTag]: { value: "Navigator" },
    });
    install("navigator", navigatorObject);

    return { URL, URLSearchParams, randomBytes, getRandomValues, randomUUID, webcrypto, domainToASCII: (d) => {
      const ascii = domainToASCII(usv(d));
      return ascii === FAILURE ? "" : ascii;
    } };
  }
