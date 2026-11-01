/**
 * LSP glob patterns (`**\/*.{ts,js}`, `**\/tsconfig.json`, `src/[a-z]*.py`), as a server asks to
 * be told about files: `*` is any run of characters within one path segment, `?` one character,
 * `**` any number of segments (none included), `{a,b}` either, `[abc]` / `[a-z]` / `[!a]` a
 * character class. Paths are matched with `/` separators, case-insensitively where the file
 * system is (Windows).
 */

const cache = new Map<string, RegExp>();

export function globToRegExp(pattern: string, caseInsensitive = false): RegExp {
  const key = `${caseInsensitive ? "i" : ""}${pattern}`;
  const known = cache.get(key);
  if (known) return known;
  let source = "";
  let depth = 0;
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === "*") {
      if (pattern[i + 1] === "*") {
        // `**/` is any number of whole segments; `**` at the end is anything at all.
        const slash = pattern[i + 2] === "/";
        source += slash ? "(?:[^/]*/)*" : ".*";
        i += slash ? 2 : 1;
      } else source += "[^/]*";
    } else if (char === "?") source += "[^/]";
    else if (char === "{") {
      depth++;
      source += "(?:";
    } else if (char === "}" && depth) {
      depth--;
      source += ")";
    } else if (char === "," && depth) source += "|";
    else if (char === "[") {
      const close = pattern.indexOf("]", i + 1);
      if (close < 0) source += "\\[";
      else {
        let body = pattern.slice(i + 1, close);
        if (body.startsWith("!")) body = `^${body.slice(1)}`;
        source += `[${body.replace(/\\/g, "\\\\")}]`;
        i = close;
      }
    } else source += char.replace(/[.+^${}()|\\]/g, "\\$&");
  }
  const regexp = new RegExp(`^${source}$`, caseInsensitive ? "i" : "");
  cache.set(key, regexp);
  return regexp;
}

/**
 * Whether `path` (absolute, `/`-separated) matches `pattern`. A pattern that is not anchored
 * (`*.ts`, `src/**`) may match anywhere below the root, as editors treat them.
 */
export function matchesGlob(pattern: string, path: string, caseInsensitive = false): boolean {
  const anchored =
    pattern.startsWith("/") || /^[A-Za-z]:/.test(pattern) || pattern.startsWith("**");
  return globToRegExp(anchored ? pattern : `**/${pattern}`, caseInsensitive).test(path);
}
