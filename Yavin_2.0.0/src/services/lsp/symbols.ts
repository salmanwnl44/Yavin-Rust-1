import type { DocumentSymbol, Range, SymbolInformation } from "./protocol.ts";
import { lspPath } from "./uris.ts";

/**
 * Symbols as lists to pick from (Go to Symbol, `@` and `#` in the palette), from either shape
 * a server may answer in: a tree of `DocumentSymbol`s or a flat list of `SymbolInformation`.
 */

const KIND_NAMES = [
  "file",
  "module",
  "namespace",
  "package",
  "class",
  "method",
  "property",
  "field",
  "constructor",
  "enum",
  "interface",
  "function",
  "variable",
  "constant",
  "string",
  "number",
  "boolean",
  "array",
  "object",
  "key",
  "null",
  "enum member",
  "struct",
  "event",
  "operator",
  "type parameter",
];

/** A symbol kind's name, as shown ("function", "class"...). */
export const symbolKindName = (kind: number): string => KIND_NAMES[kind - 1] ?? "symbol";

export interface ListedSymbol {
  name: string;
  kind: number;
  /** "function · Outer" -- its kind, and what contains it. */
  detail: string;
  /** The file it is in; null for a symbol of the document asked about. */
  path: string | null;
  /** Where to put the cursor: the name, when the server says where it is. */
  range: Range | null;
}

/** Every symbol of a document, depth first, each with the chain of symbols that contain it. */
export function flattenSymbols(
  symbols: readonly (DocumentSymbol | SymbolInformation)[],
): ListedSymbol[] {
  const out: ListedSymbol[] = [];
  const walk = (symbol: DocumentSymbol | SymbolInformation, container: string[]) => {
    const inside =
      "containerName" in symbol && symbol.containerName ? [symbol.containerName] : container;
    const range =
      "selectionRange" in symbol
        ? symbol.selectionRange
        : "location" in symbol && "range" in symbol.location
          ? symbol.location.range
          : null;
    const path = "location" in symbol ? lspPath(symbol.location.uri) : null;
    out.push({
      name: symbol.name,
      kind: symbol.kind,
      detail: [symbolKindName(symbol.kind), inside.join(".")].filter(Boolean).join(" · "),
      path,
      range,
    });
    if ("children" in symbol)
      for (const child of symbol.children ?? []) walk(child, [...container, symbol.name]);
  };
  for (const symbol of symbols) walk(symbol, []);
  return out;
}
