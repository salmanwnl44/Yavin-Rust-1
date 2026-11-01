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
  ExtensionRange,
  LanguageProvider,
  ProviderExtra,
  ProviderKind,
  ProviderRegistry,
} from "../services/extensions/window";

type Info = (doc: TextDocument) => DocumentInfo;

/**
 * EXT-29: a chosen extension code action's command, run in its extension (Monaco's command, made
 * once; the registry is the one the editor attached last).
 */
export const EXTENSION_CODE_ACTION = "yavin.extensions.codeAction";
let actionProviders: ProviderRegistry | null = null;
let actionCommand: monaco.IDisposable | null = null;
const registerActionCommand = (providers: ProviderRegistry) => {
  actionProviders = providers;
  actionCommand ??= monaco.editor.registerCommand(
    EXTENSION_CODE_ACTION,
    (_accessor, providerId: unknown, handle: unknown) => {
      const provider = actionProviders
        ?.getSnapshot()
        .find((one) => one.providerId === providerId && one.kind === "codeActions");
      if (!provider?.runAction || typeof handle !== "number") return;
      void provider.runAction(handle).catch(() => undefined);
    },
  );
};
const fromMonacoRange = (r: monaco.IRange): ExtensionRange => ({
  startLine: r.startLineNumber,
  startColumn: r.startColumn,
  endLine: r.endLineNumber,
  endColumn: r.endColumn,
});
const MARKER_SEVERITY: Record<number, "error" | "warning" | "info" | "hint"> = {
  8: "error",
  4: "warning",
  2: "info",
  1: "hint",
};
/**
 * A provider's text edits, as Monaco takes them: each in the document, none overlapping (a
 * result with overlapping or out-of-range edits is refused whole).
 */
const editsOf = (
  model: monaco.editor.ITextModel,
  raw: unknown,
): monaco.languages.TextEdit[] | null => {
  const list = Array.isArray(raw) ? raw : [];
  const edits: monaco.languages.TextEdit[] = [];
  for (const one of list.slice(0, 5000)) {
    const range = toRange(one?.range);
    if (!range || typeof one?.text !== "string") return null;
    const valid = model.validateRange(range);
    if (!monaco.Range.equalsRange(valid, range)) return null;
    edits.push({ range, text: one.text });
  }
  const sorted = [...edits].sort((a, b) =>
    monaco.Range.compareRangesUsingStarts(a.range as monaco.IRange, b.range as monaco.IRange),
  );
  for (let i = 1; i < sorted.length; i++)
    if (
      monaco.Range.areIntersecting(
        sorted[i - 1].range as monaco.IRange,
        sorted[i].range as monaco.IRange,
      ) &&
      !monaco.Range.isEmpty(sorted[i - 1].range as monaco.IRange)
    )
      return null;
  return edits;
};

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
  extra?: ProviderExtra,
): Promise<unknown[]> {
  const controller = new AbortController();
  const cancel = token.onCancellationRequested(() => controller.abort());
  try {
    const answers = await Promise.allSettled(
      providers.map((provider) =>
        provider.invoke({ document, position, ...(extra ? { extra } : {}) }, controller.signal),
      ),
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
      // EXT-29: formatting -- one formatter's answer (the first provider, in registration order,
      // with edits), for the version it was asked about; Monaco applies it as one undoable edit,
      // which reaches the document service through the editor's model bridge.
      case "formatting":
      case "rangeFormatting": {
        const format = async (
          model: monaco.editor.ITextModel,
          options: monaco.languages.FormattingOptions,
          token: monaco.CancellationToken,
          range: monaco.IRange | null,
        ) => {
          const doc = docOf(model);
          if (!doc) return [];
          const version = model.getVersionId();
          const extra: ProviderExtra = {
            options: { tabSize: options.tabSize, insertSpaces: options.insertSpaces },
            ...(range ? { range: fromMonacoRange(range) } : {}),
          };
          for (const provider of matching()) {
            const [answer] = await ask([provider], infoOf(doc), null, token, extra);
            if (token.isCancellationRequested || model.isDisposed()) return [];
            // Edits for an older version than the document's now are not applied.
            if (model.getVersionId() !== version) return [];
            const edits = answer === undefined ? null : editsOf(model, answer);
            if (edits && edits.length) return edits;
          }
          return [];
        };
        return kind === "formatting"
          ? L.registerDocumentFormattingEditProvider(target, {
              displayName: "Extension",
              provideDocumentFormattingEdits: (model, options, token) =>
                format(model, options, token, null),
            })
          : L.registerDocumentRangeFormattingEditProvider(target, {
              displayName: "Extension",
              provideDocumentRangeFormattingEdits: (model, range, options, token) =>
                format(model, options, token, range),
            });
      }
      // EXT-29: code actions -- their text edits to this document (Monaco applies them, at the
      // version they were made for), and their command, run in their extension when chosen.
      case "codeActions":
        return L.registerCodeActionProvider(target, {
          async provideCodeActions(model, range, context, token) {
            const doc = docOf(model);
            const none = { actions: [], dispose() {} };
            if (!doc) return none;
            const version = model.getVersionId();
            const extra: ProviderExtra = {
              range: fromMonacoRange(range),
              diagnostics: context.markers.slice(0, 200).map((marker) => ({
                range: fromMonacoRange(marker),
                message: marker.message,
                severity: MARKER_SEVERITY[marker.severity] ?? "info",
                ...(marker.source ? { source: marker.source } : {}),
                ...(marker.code
                  ? { code: typeof marker.code === "string" ? marker.code : marker.code.value }
                  : {}),
              })),
              ...(context.only ? { only: context.only } : {}),
              trigger:
                context.trigger === monaco.languages.CodeActionTriggerType.Auto
                  ? "automatic"
                  : "invoke",
            };
            const actions: monaco.languages.CodeAction[] = [];
            for (const provider of matching()) {
              const [answer] = await ask([provider], infoOf(doc), null, token, extra);
              if (
                token.isCancellationRequested ||
                model.isDisposed() ||
                model.getVersionId() !== version
              )
                return none;
              for (const item of (Array.isArray(answer) ? answer : []).slice(0, 200)) {
                if (!item || typeof item.title !== "string") continue;
                const edits = item.edits === undefined ? [] : editsOf(model, item.edits);
                const disabled =
                  typeof item.disabled === "string"
                    ? item.disabled
                    : typeof item.unsupported === "string"
                      ? `Yavin applies an extension's edits to this document only (${item.unsupported}).`
                      : edits === null
                        ? "Its edits do not fit the document."
                        : undefined;
                actions.push({
                  title: item.title,
                  ...(typeof item.kind === "string" ? { kind: item.kind } : {}),
                  ...(item.isPreferred === true ? { isPreferred: true } : {}),
                  ...(disabled ? { disabled } : {}),
                  ...(edits && edits.length && !disabled
                    ? {
                        edit: {
                          edits: edits.map((textEdit) => ({
                            resource: model.uri,
                            versionId: version,
                            textEdit,
                          })),
                        },
                      }
                    : {}),
                  ...(typeof item.command === "number" && !disabled
                    ? {
                        command: {
                          id: EXTENSION_CODE_ACTION,
                          title: item.title,
                          arguments: [provider.providerId, item.command],
                        },
                      }
                    : {}),
                });
              }
            }
            return { actions, dispose() {} };
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
  registerActionCommand(providers);
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
