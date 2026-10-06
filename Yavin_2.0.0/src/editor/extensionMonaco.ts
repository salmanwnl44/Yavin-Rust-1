/**
 * Extensions in the editor (IDE-08): their language providers and decorations, through Monaco
 * -- which extensions never see. Providers are separate from language servers: Monaco asks
 * both and merges what they answer.
 *
 * - **Providers.** One Monaco registration per (kind, language) for which an extension provider
 *   exists, made and removed as providers come and go. Each request goes to every matching
 *   provider through its extension host, with Monaco's cancellation and the host's timeout; a
 *   provider that fails or times out is left out of the answer, never blocking the others or
 *   the language server.
 * - **Decorations.** An extension's decorations, painted on the documents they name (by
 *   resource), in one of a fixed set of styles (`yavin-ext-<style>`), with plain-text hovers.
 */
import { monaco } from "./monaco";
import { editorModelOf, monacoLanguage } from "./monacoHost";
import type { EditorModelBridge } from "../services/editorModelBridge";
import type { TextDocument } from "../services/documents";
import { resourceId, type ResourceId } from "../services/resource";
import type {
  DecorationStore,
  DocumentInfo,
  LanguageProvider,
  ProviderKind,
  ProviderRegistry,
} from "../services/extensions/window";

type Info = (doc: TextDocument) => DocumentInfo;

const toRange = (raw: unknown): monaco.IRange | null => {
  const r = raw as {
    startLine?: number;
    startColumn?: number;
    endLine?: number;
    endColumn?: number;
  } | null;
  if (
    !r ||
    ![r.startLine, r.startColumn, r.endLine, r.endColumn].every(
      (n) => Number.isInteger(n) && (n as number) >= 1,
    )
  )
    return null;
  return {
    startLineNumber: r.startLine!,
    startColumn: r.startColumn!,
    endLineNumber: r.endLine!,
    endColumn: r.endColumn!,
  };
};
const plain = (text: unknown) => ({
  value: String(text ?? "").slice(0, 2000),
  isTrusted: false,
  supportHtml: false,
});

/** Every matching provider's answer, the failures (timeouts, errors) left out. */
async function ask(
  providers: readonly LanguageProvider[],
  document: DocumentInfo,
  position: { line: number; column: number } | null,
  token: monaco.CancellationToken,
): Promise<unknown[]> {
  const controller = new AbortController();
  const cancel = token.onCancellationRequested(() => controller.abort());
  try {
    const answers = await Promise.allSettled(
      providers.map((provider) => provider.invoke({ document, position }, controller.signal)),
    );
    return answers.flatMap((answer) =>
      answer.status === "fulfilled" && answer.value != null ? [answer.value] : [],
    );
  } finally {
    cancel.dispose();
  }
}

export function attachExtensionEditor(
  bridge: EditorModelBridge,
  providers: ProviderRegistry,
  decorations: DecorationStore,
  infoOf: Info,
): () => void {
  const docOf = (model: monaco.editor.ITextModel) => {
    const bridged = editorModelOf(model);
    return bridged ? bridge.documentOf(bridged) : undefined;
  };
  const position = (p: monaco.Position) => ({ line: p.lineNumber, column: p.column });

  // --- Providers ---------------------------------------------------------------------------------
  const registered = new Map<string, monaco.IDisposable>();
  const make = (kind: ProviderKind, language: string): monaco.IDisposable => {
    const matching = () => providers.for(kind, language);
    const L = monaco.languages;
    const target = monacoLanguage(language);
    switch (kind) {
      case "completion":
        return L.registerCompletionItemProvider(target, {
          async provideCompletionItems(model, at, _context, token) {
            const doc = docOf(model);
            if (!doc) return { suggestions: [] };
            const word = model.getWordUntilPosition(at);
            const range = {
              startLineNumber: at.lineNumber,
              endLineNumber: at.lineNumber,
              startColumn: word.startColumn,
              endColumn: word.endColumn,
            };
            const answers = await ask(matching(), infoOf(doc), position(at), token);
            const suggestions = answers.flatMap((answer) =>
              (Array.isArray(answer) ? answer : []).slice(0, 500).flatMap((item) =>
                item && typeof item.label === "string"
                  ? [
                      {
                        label: item.label,
                        insertText:
                          typeof item.insertText === "string" ? item.insertText : item.label,
                        detail: typeof item.detail === "string" ? item.detail : undefined,
                        kind: monaco.languages.CompletionItemKind.Text,
                        range,
                      },
                    ]
                  : [],
              ),
            );
            return { suggestions };
          },
        });
      case "hover":
        return L.registerHoverProvider(target, {
          async provideHover(model, at, token) {
            const doc = docOf(model);
            if (!doc) return null;
            const answers = await ask(matching(), infoOf(doc), position(at), token);
            const contents = answers.flatMap((answer) =>
              answer && typeof (answer as { contents?: unknown }).contents === "string"
                ? [plain((answer as { contents: string }).contents)]
                : [],
            );
            return contents.length ? { contents } : null;
          },
        });
      case "definition":
      case "references": {
        const locations = async (
          model: monaco.editor.ITextModel,
          at: monaco.Position,
          token: monaco.CancellationToken,
        ) => {
          const doc = docOf(model);
          if (!doc) return [];
          const answers = await ask(matching(), infoOf(doc), position(at), token);
          return answers.flatMap((answer) =>
            (Array.isArray(answer) ? answer : []).slice(0, 500).flatMap((item) => {
              const range = toRange(item?.range);
              if (!range || typeof item?.uri !== "string" || !item.uri.startsWith("file:"))
                return [];
              return [{ uri: monaco.Uri.parse(item.uri), range }];
            }),
          );
        };
        return kind === "definition"
          ? L.registerDefinitionProvider(target, {
              provideDefinition: (model, at, token) => locations(model, at, token),
            })
          : L.registerReferenceProvider(target, {
              provideReferences: (model, at, _context, token) => locations(model, at, token),
            });
      }
      case "symbols":
        return L.registerDocumentSymbolProvider(target, {
          async provideDocumentSymbols(model, token) {
            const doc = docOf(model);
            if (!doc) return [];
            const answers = await ask(matching(), infoOf(doc), null, token);
            return answers.flatMap((answer) =>
              (Array.isArray(answer) ? answer : []).slice(0, 1000).flatMap((item) => {
                const range = toRange(item?.range);
                if (!range || typeof item?.name !== "string") return [];
                return [
                  {
                    name: item.name,
                    detail: typeof item.detail === "string" ? item.detail : "",
                    kind: monaco.languages.SymbolKind.Function,
                    tags: [],
                    range,
                    selectionRange: range,
                  },
                ];
              }),
            );
          },
        });
    }
  };
  const syncProviders = () => {
    const wanted = new Set(providers.getSnapshot().map((p) => `${p.kind}\u0000${p.language}`));
    for (const [key, disposable] of registered)
      if (!wanted.has(key)) {
        disposable.dispose();
        registered.delete(key);
      }
    for (const key of wanted)
      if (!registered.has(key)) {
        const [kind, language] = key.split("\u0000") as [ProviderKind, string];
        registered.set(key, make(kind, language));
      }
  };
  syncProviders();
  const stopProviders = providers.subscribe(syncProviders);

  // --- Decorations -------------------------------------------------------------------------------
  const collections = new WeakMap<monaco.editor.ITextModel, string[]>();
  const resourceOf = (model: monaco.editor.ITextModel): ResourceId | null => {
    const doc = docOf(model);
    return doc?.uri ? resourceId(doc.uri) : null;
  };
  const paint = (model: monaco.editor.ITextModel) => {
    if (model.isDisposed()) return;
    const resource = resourceOf(model);
    const lines = model.getLineCount();
    const next: monaco.editor.IModelDeltaDecoration[] = [];
    if (resource)
      for (const set of decorations.getSnapshot())
        if (set.resource === resource)
          for (const one of set.decorations) {
            if (one.range.startLine > lines) continue;
            next.push({
              range: {
                startLineNumber: one.range.startLine,
                startColumn: one.range.startColumn,
                endLineNumber: Math.min(one.range.endLine, lines),
                endColumn: one.range.endColumn,
              },
              options: {
                inlineClassName: `yavin-ext-${one.style}`,
                hoverMessage: one.hover ? plain(one.hover) : undefined,
                stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
              },
            });
          }
    collections.set(model, model.deltaDecorations(collections.get(model) ?? [], next));
  };
  const paintAll = () => monaco.editor.getModels().forEach(paint);
  paintAll();
  const stopDecorations = decorations.subscribe(paintAll);
  const created = monaco.editor.onDidCreateModel((model) => queueMicrotask(() => paint(model)));

  return () => {
    stopProviders();
    for (const disposable of registered.values()) disposable.dispose();
    registered.clear();
    stopDecorations();
    created.dispose();
    for (const model of monaco.editor.getModels()) {
      const ids = collections.get(model);
      if (ids && !model.isDisposed()) model.deltaDecorations(ids, []);
    }
  };
}
