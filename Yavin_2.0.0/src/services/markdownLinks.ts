/**
 * What a link in a Markdown preview leads to. The preview never navigates itself: a link is
 * resolved here and handed to the window -- a file in the workspace opens in an editor, a web
 * page in the system browser, a heading scrolls the preview -- and anything else is ignored.
 */
export type MarkdownLink =
  | { kind: "heading"; id: string }
  | { kind: "file"; path: string; heading: string | null }
  | { kind: "web"; url: string }
  | { kind: "none" };

/** A heading's id, as GitHub makes it: lower case, punctuation dropped, spaces as dashes. */
export function headingSlug(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");
}

const decode = (text: string) => {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
};

/** Joins `relative` to `folder` (both `/`-separated), resolving `.` and `..`. */
function resolvePath(folder: string, relative: string): string {
  const absolute = /^([a-zA-Z]:)?\//.test(relative);
  const parts = (absolute ? relative : `${folder}/${relative}`).split("/");
  const out: string[] = [];
  for (const part of parts) {
    if (part === "." || (part === "" && out.length)) continue;
    if (part === "..") {
      // Never above the root ("C:" or the leading empty segment of "/").
      if (out.length > 1) out.pop();
      continue;
    }
    out.push(part);
  }
  return out.join("/");
}

/**
 * Where `href`, in the Markdown document at `documentPath` (null for an untitled one), leads.
 * Relative links resolve against the document's folder; `#heading` stays in the preview.
 */
export function resolveMarkdownLink(href: string, documentPath: string | null): MarkdownLink {
  const link = href.trim();
  if (!link) return { kind: "none" };
  if (link.startsWith("#")) return { kind: "heading", id: decode(link.slice(1)) };
  if (/^https?:\/\//i.test(link)) return { kind: "web", url: link };
  // Any other scheme -- mailto:, file:, javascript:, data: -- is not followed from a preview.
  // (A drive letter looks like a scheme; it is a path.)
  if (/^[a-z][a-z0-9+.-]*:/i.test(link) && !/^[a-zA-Z]:[\\/]/.test(link)) return { kind: "none" };
  const [pathPart, ...fragment] = link.split("#");
  const target = decode(pathPart.split("?")[0]).replace(/\\/g, "/");
  const heading = fragment.length ? decode(fragment.join("#")) : null;
  const absolute = /^([a-zA-Z]:)?\//.test(target);
  if (!documentPath && !absolute) return { kind: "none" };
  const folder = (documentPath ?? "").replace(/\\/g, "/").replace(/\/[^/]*$/, "");
  return { kind: "file", path: resolvePath(folder, target), heading };
}
