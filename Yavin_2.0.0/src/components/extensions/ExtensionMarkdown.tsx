import { useMemo } from "react";
import { Marked } from "marked";
import DOMPurify from "dompurify";
import { openExternalUrl } from "../../services/git/remoteUrl";

/**
 * An extension's readme or changelog: the publisher's Markdown, as data. Rendered with the same
 * sanitizer settings as the Markdown preview, and images left out (the window loads none from
 * the network); a link opens in the browser, and only an https one.
 */
export function ExtensionMarkdown({ text, label }: { text: string; label: string }) {
  const html = useMemo(() => {
    const marked = new Marked({ gfm: true, breaks: false });
    return DOMPurify.sanitize(marked.parse(text, { async: false }) as string, {
      FORBID_TAGS: [
        "style",
        "form",
        "iframe",
        "object",
        "embed",
        "link",
        "meta",
        "base",
        "img",
        "picture",
        "video",
        "audio",
        "svg",
      ],
      FORBID_ATTR: ["style"],
    });
  }, [text]);
  return (
    <div
      role="document"
      aria-label={label}
      className="extension-markdown text-[13px] leading-relaxed text-zinc-300"
      onClick={(event) => {
        const link = (event.target as HTMLElement).closest("a");
        if (!link) return;
        event.preventDefault();
        const href = link.getAttribute("href") ?? "";
        if (/^https:\/\//i.test(href)) void openExternalUrl(href).catch(() => undefined);
      }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
