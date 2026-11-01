import type { MarkedExtension, Tokens } from "marked";

/**
 * Footnotes, as GitHub writes them: `text[^note]` in the body, `[^note]: The note.` anywhere.
 *
 * `marked` has none of its own. Definitions are collected from the source first, so a
 * reference can come before its note; references become numbered superscripts in the order
 * they first appear, and the notes are listed at the end with a way back. A reference with no
 * definition stays as the text it was written as.
 */

const DEFINITION = /^\[\^([^\]\s]+)\]:[ \t]*(.*)$/gm;
const idOf = (label: string) => `fn-${label.toLowerCase().replace(/[^\p{L}\p{N}_-]/gu, "-")}`;

export function footnotes(source: string): {
  extension: MarkedExtension;
  /** The notes section, for after the document; empty when nothing referred to a note. */
  section: (renderInline: (text: string) => string) => string;
} {
  const notes = new Map<string, string>();
  for (const match of source.matchAll(DEFINITION))
    if (!notes.has(match[1])) notes.set(match[1], match[2]);
  const order: string[] = [];
  const extension: MarkedExtension = {
    extensions: [
      {
        name: "footnoteDefinition",
        level: "block",
        start: (src: string) => src.match(/^\[\^[^\]\s]+\]:/m)?.index,
        tokenizer(src: string) {
          const match = /^\[\^([^\]\s]+)\]:[^\n]*(?:\n|$)/.exec(src);
          // Consumed here, drawn at the end.
          if (match) return { type: "footnoteDefinition", raw: match[0] };
          return undefined;
        },
        renderer: () => "",
      },
      {
        name: "footnoteReference",
        level: "inline",
        start: (src: string) => src.indexOf("[^"),
        tokenizer(src: string) {
          const match = /^\[\^([^\]\s]+)\]/.exec(src);
          if (!match || !notes.has(match[1])) return undefined;
          return { type: "footnoteReference", raw: match[0], label: match[1] };
        },
        renderer(token: Tokens.Generic) {
          const label = token.label as string;
          if (!order.includes(label)) order.push(label);
          const number = order.indexOf(label) + 1;
          const id = idOf(label);
          return `<sup class="footnote-ref"><a href="#${id}" id="${id}-ref">${number}</a></sup>`;
        },
      },
    ],
  };
  const section = (renderInline: (text: string) => string) => {
    if (!order.length) return "";
    const items = order
      .map((label) => {
        const id = idOf(label);
        return `<li id="${id}">${renderInline(notes.get(label) ?? "")} <a href="#${id}-ref" class="footnote-back" aria-label="Back to the text">↩</a></li>`;
      })
      .join("");
    return `<section class="footnotes" aria-label="Footnotes"><hr><ol>${items}</ol></section>`;
  };
  return { extension, section };
}
