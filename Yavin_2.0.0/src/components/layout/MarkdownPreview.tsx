import {
  useDeferredValue,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { Ref } from "react";
import { Marked } from "marked";
import DOMPurify from "dompurify";
import { monaco } from "../../editor/monaco";
import type { DocumentService } from "../../services/documents";
import { headingSlug, resolveMarkdownLink } from "../../services/markdownLinks";
import type { MarkdownLink } from "../../services/markdownLinks";
import { footnotes } from "../../services/markdownFootnotes";

/**
 * A Markdown document, rendered: the preview beside or instead of its editor.
 *
 * ```text
 * DocumentService -> Document -> marked (+ footnotes) -> DOMPurify -> this view
 * ```
 *
 * It reads the Document Model, as the editor does, and subscribes to its one document, so it
 * follows every edit, reload and Save As -- typing in the editor beside it redraws the preview
 * and nothing else. It never reads or writes a file: images come through `loadImage`, and
 * every link, "Open in Editor" included, is handed to the window, which uses the same services
 * the rest of Yavin does.
 *
 * The document's text is data, never code. The HTML `marked` makes is sanitized (DOMPurify: no
 * scripts, event handlers, frames, forms, styles or `javascript:` links), and the window's CSP
 * refuses inline and remote scripts besides. Images from the workspace are shown from their
 * bytes (as `data:` URLs, which is all the CSP allows); images from the web are not loaded.
 */

/** Large documents are rendered after a pause in typing rather than on every keystroke. */
const LARGE = 200_000;

export interface MarkdownPreviewHandle {
  /** Opens the preview's find bar (Ctrl+F while the preview is in front). */
  find(): void;
}

interface OutlineEntry {
  id: string;
  text: string;
  level: number;
}

function sanitizedHtml(text: string): DocumentFragment {
  const notes = footnotes(text);
  const marked = new Marked({ gfm: true, breaks: false }, notes.extension);
  const html =
    (marked.parse(text, { async: false }) as string) +
    notes.section((inline) => marked.parseInline(inline, { async: false }) as string);
  return DOMPurify.sanitize(html, {
    RETURN_DOM_FRAGMENT: true,
    FORBID_TAGS: ["style", "form", "iframe", "object", "embed", "link", "meta", "base"],
    FORBID_ATTR: ["style"],
  });
}

const element = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

/** The language Monaco knows a code fence by (`ts`, `python`, `rs`...), if any. */
function fenceLanguage(fence: string): string | undefined {
  const lower = fence.toLowerCase();
  return monaco.languages
    .getLanguages()
    .find(
      (one) =>
        one.id === lower ||
        one.aliases?.some((alias) => alias.toLowerCase() === lower) ||
        one.extensions?.includes(`.${lower}`),
    )?.id;
}

/** Each line of `html` (lines separated by `<br/>`, as Monaco's colorizer makes them) numbered. */
const numbered = (lines: string[]) =>
  lines.map((line) => `<span class="code-line">${line || " "}</span>`).join("");

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export default function MarkdownPreview({
  documents,
  documentKey,
  onOpenLink,
  loadImage,
  onOpenCode,
  previewRef,
}: {
  documents: DocumentService;
  documentKey: string;
  /** Where a link leads, resolved; the window follows it (a heading is handled here). */
  onOpenLink: (link: MarkdownLink) => void;
  /** An image in the workspace as a `data:` URL; rejects when it cannot be shown. */
  loadImage: (path: string) => Promise<string>;
  /** "Open in Editor" on a code block: a new document holding the code. */
  onOpenCode: (code: string, languageId: string | undefined) => void;
  previewRef?: Ref<MarkdownPreviewHandle>;
}) {
  const content = useRef<HTMLDivElement>(null);
  useSyncExternalStore(
    documents.subscribe,
    () => documents.documentRevision(documentKey),
    () => documents.documentRevision(documentKey),
  );
  const doc = documents.get(documentKey);
  const text = useDeferredValue(doc?.text ?? "");
  const path = doc?.path ?? null;
  const latest = useRef({ onOpenLink, loadImage, onOpenCode, path });
  latest.current = { onOpenLink, loadImage, onOpenCode, path };

  const [outline, setOutline] = useState<OutlineEntry[]>([]);
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [current, setCurrent] = useState<string | null>(null);
  const [lightbox, setLightbox] = useState<{ src: string; alt: string; zoomed: boolean } | null>(
    null,
  );
  const [rendered, setRendered] = useState(0);

  // --- Rendering ---------------------------------------------------------------------------
  useEffect(() => {
    const root = content.current;
    if (!root) return;
    let cancelled = false;
    const draw = () => {
      const fragment = sanitizedHtml(text);
      decorateHeadings(fragment);
      decorateImages(fragment, () => cancelled);
      decorateCode(fragment);
      root.replaceChildren(fragment);
      setOutline(
        [...root.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6")].map((heading) => ({
          id: heading.id,
          text: heading.dataset.title ?? "",
          level: Number(heading.tagName[1]),
        })),
      );
      setRendered((n) => n + 1);
    };
    if (text.length < LARGE) draw();
    const timer = text.length < LARGE ? undefined : setTimeout(draw, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [text]);

  /** GitHub's ids, and an anchor to each heading. */
  function decorateHeadings(fragment: DocumentFragment) {
    const seen = new Map<string, number>();
    for (const heading of fragment.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6")) {
      const title = heading.textContent ?? "";
      const slug = headingSlug(title);
      const count = seen.get(slug) ?? 0;
      seen.set(slug, count + 1);
      heading.id = count ? `${slug}-${count}` : slug;
      heading.dataset.title = title;
      // Drawn by CSS and hidden from assistive technology: the heading's name stays its
      // text, and the outline is the keyboard's way to the same place.
      const anchor = element("a", "heading-anchor");
      anchor.href = `#${heading.id}`;
      anchor.setAttribute("aria-hidden", "true");
      anchor.tabIndex = -1;
      heading.prepend(anchor);
    }
  }

  /** Workspace images from their bytes; web images named, not loaded; broken ones said so. */
  function decorateImages(fragment: DocumentFragment, cancelled: () => boolean) {
    for (const image of fragment.querySelectorAll("img")) {
      const source = image.getAttribute("src") ?? "";
      const alt = image.getAttribute("alt") ?? "";
      const holder = element("span", "markdown-image");
      holder.title = alt || source;
      image.replaceWith(holder);
      const show = (url: string) => {
        const shown = element("img", "");
        shown.src = url;
        shown.alt = alt;
        shown.title = alt;
        shown.dataset.zoomable = "";
        holder.replaceChildren(shown);
        holder.dataset.state = "shown";
      };
      const note = (state: string, words: string) => {
        holder.dataset.state = state;
        holder.textContent = words;
      };
      if (/^data:image\//i.test(source)) {
        show(source);
        continue;
      }
      const link = resolveMarkdownLink(source, latest.current.path);
      if (link.kind === "web") {
        note("remote", `${alt ? `${alt}: ` : ""}image from the web, not loaded`);
        const open = element("button", "markdown-image-open", "Open");
        open.type = "button";
        open.dataset.url = link.url;
        holder.append(" ", open);
      } else if (link.kind === "file") {
        note("loading", `Loading ${alt || "image"}…`);
        latest.current
          .loadImage(link.path)
          .then((url) => {
            if (!cancelled()) show(url);
          })
          .catch((reason: unknown) => {
            if (!cancelled())
              note(
                "broken",
                `Image not shown: ${source} (${String(reason).replace(/^Error: /, "")})`,
              );
          });
      } else {
        note("broken", `Image not shown: ${source || "no source"}`);
      }
    }
  }

  /** A header on each code block (language, Copy, Open in Editor), numbered lines, colour. */
  function decorateCode(fragment: DocumentFragment) {
    for (const code of fragment.querySelectorAll<HTMLElement>("pre > code")) {
      const pre = code.parentElement as HTMLElement;
      const fence = /language-(\S+)/.exec(code.className)?.[1] ?? "";
      const source = (code.textContent ?? "").replace(/\n$/, "");
      const languageId = fence ? fenceLanguage(fence) : undefined;
      const block = element("div", "code-block");
      const header = element("div", "code-block-header");
      header.append(element("span", "code-block-language", fence || "text"));
      const actions = element("span", "code-block-actions");
      for (const [action, label] of [
        ["copy", "Copy"],
        ["open", "Open in Editor"],
      ] as const) {
        const button = element("button", "code-block-action", label);
        button.type = "button";
        button.dataset.codeAction = action;
        actions.append(button);
      }
      header.append(actions);
      pre.replaceWith(block);
      block.append(header, pre);
      block.dataset.source = source;
      if (languageId) block.dataset.language = languageId;
      code.innerHTML = numbered(source.split("\n").map(escapeHtml));
      if (!languageId) continue;
      // Monaco's colorizer escapes the text it is given; the result is spans of that text.
      void monaco.editor.colorize(source, languageId, { tabSize: 2 }).then((html) => {
        if (!code.isConnected) return;
        const inner = /^<div[^>]*>([\s\S]*)<\/div>$/.exec(html.trim())?.[1] ?? html;
        // As many lines as the code has: the colorizer ends its last line with a break too.
        code.innerHTML = numbered(inner.split(/<br\/?>/).slice(0, source.split("\n").length));
      });
    }
  }

  // --- Outline: the heading in view --------------------------------------------------------
  useEffect(() => {
    const root = content.current;
    if (!root) return;
    const update = () => {
      const headings = [...root.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6")];
      const top = root.getBoundingClientRect().top + 8;
      let at: string | null = headings[0]?.id ?? null;
      for (const heading of headings) {
        if (heading.getBoundingClientRect().top <= top) at = heading.id;
        else break;
      }
      // At the end the last sections cannot reach the top: the first heading on screen is
      // the one being read, not the one above it that scrolled away.
      if (root.scrollTop + root.clientHeight >= root.scrollHeight - 2) {
        const bottom = root.getBoundingClientRect().bottom;
        const onScreen = headings.find((heading) => {
          const box = heading.getBoundingClientRect();
          return box.top >= top && box.top < bottom;
        });
        if (onScreen && onScreen.getBoundingClientRect().top > top) at = onScreen.id;
      }
      setCurrent(at);
    };
    update();
    root.addEventListener("scroll", update, { passive: true });
    return () => root.removeEventListener("scroll", update);
  }, [rendered]);

  const scrollTo = (id: string) =>
    content.current?.querySelector(`#${CSS.escape(id)}`)?.scrollIntoView({ block: "start" });

  // An entry is hidden when a heading above it, of a higher level, is collapsed.
  const visibleOutline = (() => {
    const shown: (OutlineEntry & { parent: boolean })[] = [];
    let hiddenBelow: number | null = null;
    outline.forEach((entry, index) => {
      if (hiddenBelow !== null && entry.level > hiddenBelow) return;
      hiddenBelow = collapsed.has(entry.id) ? entry.level : null;
      const next = outline[index + 1];
      shown.push({ ...entry, parent: !!next && next.level > entry.level });
    });
    return shown;
  })();

  // --- Find --------------------------------------------------------------------------------
  const [findOpen, setFindOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [matchCase, setMatchCase] = useState(false);
  const [matches, setMatches] = useState<Range[]>([]);
  const [matchIndex, setMatchIndex] = useState(0);
  const findInput = useRef<HTMLInputElement>(null);
  const openFind = () => {
    setFindOpen(true);
    const selected = window.getSelection()?.toString();
    if (selected && !selected.includes("\n")) setQuery(selected);
    requestAnimationFrame(() => {
      findInput.current?.focus();
      findInput.current?.select();
    });
  };
  useImperativeHandle(previewRef, () => ({ find: openFind }));

  useEffect(() => {
    const root = content.current;
    if (!root || !findOpen || !query) {
      setMatches([]);
      return;
    }
    const needle = matchCase ? query : query.toLowerCase();
    const found: Range[] = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.parentElement?.closest(".heading-anchor, .code-block-header")) continue;
      const haystack = matchCase ? (node.nodeValue ?? "") : (node.nodeValue ?? "").toLowerCase();
      for (
        let at = haystack.indexOf(needle);
        at >= 0;
        at = haystack.indexOf(needle, at + needle.length)
      ) {
        const range = document.createRange();
        range.setStart(node, at);
        range.setEnd(node, at + needle.length);
        found.push(range);
        if (found.length >= 5000) break;
      }
    }
    setMatches(found);
    setMatchIndex(0);
  }, [query, matchCase, findOpen, rendered]);

  useEffect(() => {
    const highlights = (CSS as unknown as { highlights?: Map<string, unknown> }).highlights;
    const Highlight = (window as unknown as { Highlight?: new (...ranges: Range[]) => unknown })
      .Highlight;
    if (!highlights || !Highlight) return;
    const currentRange = matches[matchIndex];
    highlights.set("markdown-find", new Highlight(...matches));
    if (currentRange) {
      highlights.set("markdown-find-current", new Highlight(currentRange));
      const root = content.current;
      const box = currentRange.getBoundingClientRect();
      const view = root?.getBoundingClientRect();
      if (root && view && (box.top < view.top || box.bottom > view.bottom))
        root.scrollTop += box.top - view.top - view.height / 3;
    } else highlights.delete("markdown-find-current");
    return () => {
      highlights.delete("markdown-find");
      highlights.delete("markdown-find-current");
    };
  }, [matches, matchIndex]);

  const step = (by: number) =>
    matches.length && setMatchIndex((index) => (index + by + matches.length) % matches.length);

  // --- Clicks ------------------------------------------------------------------------------
  const onClick = (event: React.MouseEvent) => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    const action = target.closest<HTMLElement>("[data-code-action]");
    if (action) {
      const block = action.closest<HTMLElement>(".code-block");
      const source = block?.dataset.source ?? "";
      if (action.dataset.codeAction === "copy") {
        void navigator.clipboard.writeText(source).then(() => {
          action.textContent = "Copied";
          setTimeout(() => (action.textContent = "Copy"), 1500);
        });
      } else latest.current.onOpenCode(source, block?.dataset.language);
      return;
    }
    const remote = target.closest<HTMLElement>(".markdown-image-open");
    if (remote?.dataset.url) {
      latest.current.onOpenLink({ kind: "web", url: remote.dataset.url });
      return;
    }
    const image = target.closest<HTMLImageElement>("img[data-zoomable]");
    if (image) {
      setLightbox({ src: image.src, alt: image.alt, zoomed: false });
      return;
    }
    const anchor = target.closest<HTMLAnchorElement>("a[href]");
    if (!anchor) return;
    event.preventDefault();
    const link = resolveMarkdownLink(anchor.getAttribute("href") ?? "", latest.current.path);
    if (link.kind === "heading") scrollTo(link.id);
    else latest.current.onOpenLink(link);
  };

  const button =
    "rounded px-1.5 py-0.5 text-[11px] text-zinc-400 hover:bg-[#161616] hover:text-zinc-100";
  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col bg-black">
      <div className="flex h-7 shrink-0 items-center gap-1 border-b border-[#141414] px-2">
        <button
          onClick={() => setOutlineOpen((open) => !open)}
          aria-pressed={outlineOpen}
          className={`${button} ${outlineOpen ? "text-indigo-300" : ""}`}
        >
          Outline
        </button>
        <button onClick={openFind} className={button} title="Find in Preview (Ctrl+F)">
          Find
        </button>
      </div>
      {findOpen && (
        <div
          role="search"
          aria-label="Find in preview"
          className="flex shrink-0 items-center gap-1.5 border-b border-[#141414] bg-[#070707] px-2 py-1 text-[11px]"
        >
          <input
            ref={findInput}
            aria-label="Find in preview"
            placeholder="Find"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                step(event.shiftKey ? -1 : 1);
              } else if (event.key === "Escape") {
                event.preventDefault();
                setFindOpen(false);
                content.current?.focus();
              }
            }}
            className="w-48 rounded border border-zinc-700 bg-black px-1.5 py-0.5 text-zinc-100 outline-none focus:border-indigo-500"
          />
          <button
            onClick={() => setMatchCase((value) => !value)}
            aria-pressed={matchCase}
            title="Match Case"
            aria-label="Match Case"
            className={`${button} font-mono ${matchCase ? "bg-indigo-900/50 text-indigo-200" : ""}`}
          >
            Aa
          </button>
          <span aria-live="polite" className="min-w-16 text-zinc-500">
            {query
              ? matches.length
                ? `${matchIndex + 1} of ${matches.length}`
                : "No results"
              : ""}
          </span>
          <button onClick={() => step(-1)} aria-label="Previous Match" className={button}>
            ↑
          </button>
          <button onClick={() => step(1)} aria-label="Next Match" className={button}>
            ↓
          </button>
          <button
            onClick={() => setFindOpen(false)}
            aria-label="Close Find"
            className={`${button} ml-auto`}
          >
            ✕
          </button>
        </div>
      )}
      <div className="flex min-h-0 flex-1">
        {outlineOpen && (
          <nav
            aria-label="Outline"
            className="w-56 shrink-0 overflow-auto border-r border-[#141414] py-2 text-[12px]"
          >
            {visibleOutline.length === 0 && (
              <p className="px-3 text-zinc-600">No headings in this document.</p>
            )}
            {visibleOutline.map((entry) => (
              <div
                key={entry.id}
                className="flex items-center"
                style={{ paddingLeft: 8 + (entry.level - 1) * 12 }}
              >
                {entry.parent ? (
                  <button
                    aria-label={
                      collapsed.has(entry.id) ? `Expand ${entry.text}` : `Collapse ${entry.text}`
                    }
                    aria-expanded={!collapsed.has(entry.id)}
                    onClick={() =>
                      setCollapsed((previous) => {
                        const next = new Set(previous);
                        if (next.has(entry.id)) next.delete(entry.id);
                        else next.add(entry.id);
                        return next;
                      })
                    }
                    className="w-4 shrink-0 text-zinc-500 hover:text-zinc-200"
                  >
                    {collapsed.has(entry.id) ? "›" : "⌄"}
                  </button>
                ) : (
                  <span className="w-4 shrink-0" />
                )}
                <button
                  onClick={() => scrollTo(entry.id)}
                  aria-current={current === entry.id ? "location" : undefined}
                  className={`min-w-0 flex-1 truncate rounded px-1 py-0.5 text-left ${
                    current === entry.id
                      ? "bg-[#16162a] text-white"
                      : "text-zinc-400 hover:bg-[#0c0c0c] hover:text-zinc-100"
                  }`}
                >
                  {entry.text}
                </button>
              </div>
            ))}
          </nav>
        )}
        <div
          ref={content}
          role="document"
          aria-label={`Preview ${doc?.name ?? ""}`}
          tabIndex={0}
          className="markdown-body min-h-0 min-w-0 flex-1 overflow-auto px-8 py-6 select-text outline-none"
          onClick={onClick}
          onKeyDown={(event) => {
            if (
              (event.ctrlKey || event.metaKey) &&
              !event.altKey &&
              event.key.toLowerCase() === "f"
            ) {
              event.preventDefault();
              openFind();
            }
          }}
        />
      </div>
      {lightbox && (
        <div
          role="dialog"
          aria-label={lightbox.alt || "Image"}
          tabIndex={-1}
          ref={(node) => node?.focus()}
          onKeyDown={(event) => event.key === "Escape" && setLightbox(null)}
          onClick={(event) => event.target === event.currentTarget && setLightbox(null)}
          className="fixed inset-0 z-50 flex items-center justify-center overflow-auto bg-black/85 p-6"
        >
          <img
            src={lightbox.src}
            alt={lightbox.alt}
            onClick={() => setLightbox({ ...lightbox, zoomed: !lightbox.zoomed })}
            className={
              lightbox.zoomed
                ? "max-w-none cursor-zoom-out"
                : "max-h-full max-w-full cursor-zoom-in"
            }
          />
        </div>
      )}
    </div>
  );
}
