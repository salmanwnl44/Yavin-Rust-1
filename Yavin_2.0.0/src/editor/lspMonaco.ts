import { monaco } from "./monaco";
import { editorModelOf, monacoLanguage } from "./monacoHost";
import type { EditorModelBridge } from "../services/editorModelBridge";
import type { TextDocument } from "../services/documents";
import { allProblems, subscribeProblems } from "../services/panel/problems";
import type { LspManager } from "../services/lsp/manager";
import { StaleResultError } from "../services/lsp/manager";
import { CancelledError } from "../services/lsp/jsonrpc";
import { LineIndex } from "../services/lsp/positions";
import type { PositionEncoding } from "../services/lsp/positions";
import type * as P from "../services/lsp/protocol";
import type { LanguageServerDefinition } from "../services/lsp/registry";
import { lspPath, lspResourceId } from "../services/lsp/uris";
import { resourceId } from "../services/resource";

/**
 * The language servers' features in Monaco: LSP in, Monaco out, and nothing else.
 *
 * ```text
 * Monaco provider call -> this (convert) -> LspManager.request -> server
 *                      <- this (convert) <- answer (dropped if the document changed meanwhile)
 * Problems store -> this -> Monaco markers        edits -> host.applyWorkspaceEdit (engine)
 * ```
 *
 * Providers are registered per server, when it first becomes ready, for the Monaco languages of
 * the languages it serves, and only for what its capabilities advertise: a feature a server
 * lacks has no provider, so Monaco offers no command for it. Each provider answers only for
 * documents that server serves. Positions are converted through `positions.ts` in the server's
 * encoding; URIs through `uris.ts`. Nothing here reads or writes a file: navigation, reference
 * lists and edits are the host's (the window's), which uses the same services as everything
 * else.
 */

export interface LanguageFeaturesHost {
  /** Opens a file (or shows an open document) with `range` selected (1-based, UTF-16). */
  openLocation(path: string, range?: monaco.IRange): void;
  /** A list of places (references, several definitions) to pick from. */
  showLocations(
    title: string,
    locations: { path: string; range: monaco.IRange; preview?: string }[],
  ): void;
  applyWorkspaceEdit(
    edit: P.WorkspaceEdit,
    encoding: PositionEncoding,
    label: string,
  ): Promise<{ applied: boolean; failureReason?: string }>;
  /** Something the user asked for could not be done. */
  report(message: string): void;
  /** Opens a web address in the system browser. */
  openExternal(url: string): void;
}

const COMMAND = "yavin.lsp.command";
const CODE_ACTION = "yavin.lsp.codeAction";
const REFERENCES = "yavin.lsp.findReferences";

let installed: {
  manager: LspManager;
  bridge: EditorModelBridge;
  host: LanguageFeaturesHost;
} | null = null;
const registeredServers = new Set<string>();

/** The document a Monaco model shows, when it is one of the bridge's. */
function documentOf(model: monaco.editor.ITextModel): TextDocument | undefined {
  if (!installed) return undefined;
  const bridged = editorModelOf(model);
  return bridged ? installed.bridge.documentOf(bridged) : undefined;
}

/** A Monaco cancellation token as an abort signal. */
function signalOf(token: monaco.CancellationToken): AbortSignal {
  const controller = new AbortController();
  if (token.isCancellationRequested) controller.abort();
  else token.onCancellationRequested(() => controller.abort());
  return controller.signal;
}

/**
 * A request for the document `model` shows, if `serverId` serves it; undefined when not, when
 * no server is ready, or when the answer came for an older text or was cancelled.
 */
async function ask<T>(
  serverId: string,
  model: monaco.editor.ITextModel,
  method: string,
  params: (context: NonNullable<ReturnType<LspManager["context"]>>) => unknown,
  token: monaco.CancellationToken,
): Promise<
  | { result: T; context: NonNullable<ReturnType<LspManager["context"]>>; doc: TextDocument }
  | undefined
> {
  if (!installed) return undefined;
  const doc = documentOf(model);
  if (!doc || installed.manager.serverIdFor(doc.key) !== serverId) return undefined;
  const context = installed.manager.context(doc.key);
  if (!context) return undefined;
  try {
    const result = await installed.manager.request<T>(
      doc.key,
      method,
      params(context),
      signalOf(token),
    );
    if (result === null || result === undefined) return undefined;
    return { result, context, doc };
  } catch (error) {
    if (error instanceof StaleResultError || error instanceof CancelledError) return undefined;
    if (token.isCancellationRequested) return undefined;
    // An ordinary failure of one request (the server declined): no answer, not an alarm.
    console.warn(`${method} failed:`, error);
    return undefined;
  }
}

// --- Conversion ------------------------------------------------------------------------------

const toPosition = (
  context: { index: LineIndex; encoding: PositionEncoding },
  model: monaco.editor.ITextModel,
  position: monaco.IPosition,
): P.Position => context.index.positionAt(model.getOffsetAt(position), context.encoding);

const toRange = (
  context: { index: LineIndex; encoding: PositionEncoding },
  model: monaco.editor.ITextModel,
  range: monaco.IRange,
): P.Range => ({
  start: toPosition(context, model, {
    lineNumber: range.startLineNumber,
    column: range.startColumn,
  }),
  end: toPosition(context, model, { lineNumber: range.endLineNumber, column: range.endColumn }),
});

/** An LSP range in the model's own text, as a Monaco range. */
const fromRange = (
  context: { index: LineIndex; encoding: PositionEncoding },
  model: monaco.editor.ITextModel,
  range: P.Range,
): monaco.Range => {
  const start = model.getPositionAt(context.index.offsetAt(range.start, context.encoding));
  const end = model.getPositionAt(context.index.offsetAt(range.end, context.encoding));
  return new monaco.Range(start.lineNumber, start.column, end.lineNumber, end.column);
};

/**
 * An LSP range in another file. When that file is open its text converts the position; when it
 * is not, a UTF-16 server's positions are already the editor's (other encodings are taken as
 * they come, which is exact for ASCII lines).
 */
function rangeInFile(uri: string, range: P.Range, encoding: PositionEncoding): monaco.IRange {
  const id = lspResourceId(uri);
  const doc = id && installed?.manager ? findDocument(id) : undefined;
  if (doc) {
    const index = new LineIndex(doc.text);
    const start = index.positionAt(index.offsetAt(range.start, encoding));
    const end = index.positionAt(index.offsetAt(range.end, encoding));
    return {
      startLineNumber: start.line + 1,
      startColumn: start.character + 1,
      endLineNumber: end.line + 1,
      endColumn: end.character + 1,
    };
  }
  return {
    startLineNumber: range.start.line + 1,
    startColumn: range.start.character + 1,
    endLineNumber: range.end.line + 1,
    endColumn: range.end.character + 1,
  };
}

let documentsOf: () => TextDocument[] = () => [];
const findDocument = (id: string) =>
  documentsOf().find((doc) => doc.uri && resourceId(doc.uri) === id);

/** The Monaco URI to give a location: the open document's model's, or the file's own. */
function uriFor(lspUri: string): monaco.Uri {
  const id = lspResourceId(lspUri);
  const doc = id ? findDocument(id) : undefined;
  const bridged = doc && installed?.bridge.get(doc.key);
  const model = monaco.editor.getModels().find((one) => bridged && editorModelOf(one) === bridged);
  return model?.uri ?? monaco.Uri.parse(lspUri);
}

const markdown = (value: string): monaco.IMarkdownString => ({
  value,
  isTrusted: false,
  supportHtml: false,
});
const documentation = (value: string | P.MarkupContent | undefined) =>
  value === undefined
    ? undefined
    : typeof value === "string"
      ? value
      : value.kind === "markdown"
        ? markdown(value.value)
        : value.value;
const markedToMarkdown = (content: P.MarkedString | P.MarkupContent): monaco.IMarkdownString =>
  typeof content === "string"
    ? markdown(content)
    : "kind" in content
      ? markdown(content.kind === "markdown" ? content.value : "```\n" + content.value + "\n```")
      : markdown("```" + content.language + "\n" + content.value + "\n```");

/** LSP kind numbers to Monaco's, by name: the two enumerations differ. */
const COMPLETION_KINDS: Record<number, monaco.languages.CompletionItemKind> = (() => {
  const K = monaco.languages.CompletionItemKind;
  return {
    1: K.Text,
    2: K.Method,
    3: K.Function,
    4: K.Constructor,
    5: K.Field,
    6: K.Variable,
    7: K.Class,
    8: K.Interface,
    9: K.Module,
    10: K.Property,
    11: K.Unit,
    12: K.Value,
    13: K.Enum,
    14: K.Keyword,
    15: K.Snippet,
    16: K.Color,
    17: K.File,
    18: K.Reference,
    19: K.Folder,
    20: K.EnumMember,
    21: K.Constant,
    22: K.Struct,
    23: K.Event,
    24: K.Operator,
    25: K.TypeParameter,
  };
})();

function locationsOf(
  result: P.Location | P.Location[] | P.LocationLink[],
  encoding: PositionEncoding,
): monaco.languages.Location[] {
  const list = Array.isArray(result) ? result : [result];
  return list.flatMap((one) => {
    const uri = "targetUri" in one ? one.targetUri : one.uri;
    const range = "targetUri" in one ? one.targetSelectionRange : one.range;
    if (!lspPath(uri)) return [];
    return [{ uri: uriFor(uri), range: rangeInFile(uri, range, encoding) }];
  });
}

// --- Markers ---------------------------------------------------------------------------------

function refreshMarkers() {
  if (!installed) return;
  const byFile = new Map<string, monaco.editor.IMarkerData[]>();
  for (const owned of allProblems())
    for (const problem of owned.diagnostics) {
      const id = lspResourceId(`file://${problem.file.startsWith("/") ? "" : "/"}${problem.file}`);
      if (!id) continue;
      const list = byFile.get(id) ?? [];
      list.push({
        severity:
          problem.severity === "error"
            ? monaco.MarkerSeverity.Error
            : problem.severity === "warning"
              ? monaco.MarkerSeverity.Warning
              : problem.hint
                ? monaco.MarkerSeverity.Hint
                : monaco.MarkerSeverity.Info,
        message: problem.message,
        source: problem.origin ?? owned.label,
        code: problem.code,
        startLineNumber: problem.line,
        startColumn: problem.column,
        endLineNumber: problem.endLine ?? problem.line,
        endColumn: problem.endColumn ?? problem.column + 1,
        tags: problem.tags?.map((tag) =>
          tag === "unnecessary" ? monaco.MarkerTag.Unnecessary : monaco.MarkerTag.Deprecated,
        ),
        relatedInformation: problem.related?.map((related) => ({
          resource: monaco.Uri.file(related.file),
          message: related.message,
          startLineNumber: related.line,
          startColumn: related.column,
          endLineNumber: related.line,
          endColumn: related.column,
        })),
      });
      byFile.set(id, list);
    }
  for (const model of monaco.editor.getModels()) {
    const doc = documentOf(model);
    const id = doc?.uri ? resourceId(doc.uri) : null;
    monaco.editor.setModelMarkers(model, "yavin", (id && byFile.get(id)) || []);
  }
}

// --- Providers, per server -------------------------------------------------------------------

function registerServer(definition: LanguageServerDefinition, capabilities: P.ServerCapabilities) {
  const languages = [...new Set(definition.languages.map(monacoLanguage))];
  const id = definition.id;
  const register = <T>(fn: (language: string, provider: T) => monaco.IDisposable, provider: T) => {
    for (const language of languages) fn(language, provider);
  };
  const L = monaco.languages;

  if (capabilities.completionProvider) {
    const original = new WeakMap<
      monaco.languages.CompletionItem,
      { item: P.CompletionItem; key: string }
    >();
    register(L.registerCompletionItemProvider, {
      triggerCharacters: capabilities.completionProvider.triggerCharacters,
      async provideCompletionItems(model, position, context, token) {
        const answer = await ask<P.CompletionItem[] | P.CompletionList>(
          id,
          model,
          "textDocument/completion",
          (ctx) => ({
            textDocument: { uri: ctx.uri },
            position: toPosition(ctx, model, position),
            context: {
              triggerKind: context.triggerKind + 1,
              ...(context.triggerCharacter ? { triggerCharacter: context.triggerCharacter } : {}),
            },
          }),
          token,
        );
        if (!answer) return undefined;
        const { result, context: ctx, doc } = answer;
        const items = Array.isArray(result) ? result : result.items;
        const word = model.getWordUntilPosition(position);
        const fallback = new monaco.Range(
          position.lineNumber,
          word.startColumn,
          position.lineNumber,
          position.column,
        );
        const suggestions = items.map((item) => {
          const edit = item.textEdit;
          const range = !edit
            ? fallback
            : "range" in edit
              ? fromRange(ctx, model, edit.range)
              : {
                  insert: fromRange(ctx, model, edit.insert),
                  replace: fromRange(ctx, model, edit.replace),
                };
          const suggestion: monaco.languages.CompletionItem = {
            label: item.labelDetails
              ? {
                  label: item.label,
                  detail: item.labelDetails.detail,
                  description: item.labelDetails.description,
                }
              : item.label,
            kind: COMPLETION_KINDS[item.kind ?? 1] ?? monaco.languages.CompletionItemKind.Text,
            detail: item.detail,
            documentation: documentation(item.documentation),
            sortText: item.sortText,
            filterText: item.filterText,
            preselect: item.preselect,
            insertText: edit ? edit.newText : (item.insertText ?? item.label),
            insertTextRules:
              item.insertTextFormat === 2
                ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet
                : undefined,
            range,
            commitCharacters: item.commitCharacters,
            tags:
              item.deprecated || item.tags?.includes(1)
                ? [monaco.languages.CompletionItemTag.Deprecated]
                : undefined,
            additionalTextEdits: item.additionalTextEdits?.map((extra) => ({
              range: fromRange(ctx, model, extra.range),
              text: extra.newText,
            })),
            command: item.command
              ? { id: COMMAND, title: item.command.title, arguments: [doc.key, item.command] }
              : undefined,
          };
          original.set(suggestion, { item, key: doc.key });
          return suggestion;
        });
        return { suggestions, incomplete: !Array.isArray(result) && result.isIncomplete };
      },
      async resolveCompletionItem(suggestion, token) {
        const known = original.get(suggestion);
        if (!known || !capabilities.completionProvider?.resolveProvider || !installed)
          return suggestion;
        try {
          const resolved = await installed.manager.request<P.CompletionItem>(
            known.key,
            "completionItem/resolve",
            known.item,
            signalOf(token),
          );
          if (!resolved) return suggestion;
          return {
            ...suggestion,
            detail: resolved.detail ?? suggestion.detail,
            documentation: documentation(resolved.documentation) ?? suggestion.documentation,
          };
        } catch {
          return suggestion;
        }
      },
    } satisfies monaco.languages.CompletionItemProvider);
  }

  if (capabilities.hoverProvider) {
    register(L.registerHoverProvider, {
      async provideHover(model, position, token) {
        const answer = await ask<P.Hover>(
          id,
          model,
          "textDocument/hover",
          (ctx) => ({
            textDocument: { uri: ctx.uri },
            position: toPosition(ctx, model, position),
          }),
          token,
        );
        if (!answer) return undefined;
        const { result, context: ctx } = answer;
        const contents = Array.isArray(result.contents) ? result.contents : [result.contents];
        return {
          contents: contents.map(markedToMarkdown),
          range: result.range ? fromRange(ctx, model, result.range) : undefined,
        };
      },
    } satisfies monaco.languages.HoverProvider);
  }

  const locationProvider = (method: string) => ({
    async provide(
      model: monaco.editor.ITextModel,
      position: monaco.Position,
      token: monaco.CancellationToken,
    ) {
      const answer = await ask<P.Location | P.Location[] | P.LocationLink[]>(
        id,
        model,
        method,
        (ctx) => ({
          textDocument: { uri: ctx.uri },
          position: toPosition(ctx, model, position),
        }),
        token,
      );
      return answer ? locationsOf(answer.result, answer.context.encoding) : undefined;
    },
  });
  if (capabilities.definitionProvider) {
    const provider = locationProvider("textDocument/definition");
    register(L.registerDefinitionProvider, { provideDefinition: provider.provide });
  }
  if (capabilities.declarationProvider) {
    const provider = locationProvider("textDocument/declaration");
    register(L.registerDeclarationProvider, { provideDeclaration: provider.provide });
  }
  if (capabilities.typeDefinitionProvider) {
    const provider = locationProvider("textDocument/typeDefinition");
    register(L.registerTypeDefinitionProvider, { provideTypeDefinition: provider.provide });
  }
  if (capabilities.implementationProvider) {
    const provider = locationProvider("textDocument/implementation");
    register(L.registerImplementationProvider, { provideImplementation: provider.provide });
  }
  if (capabilities.referencesProvider) {
    register(L.registerReferenceProvider, {
      async provideReferences(model, position, context, token) {
        const answer = await ask<P.Location[]>(
          id,
          model,
          "textDocument/references",
          (ctx) => ({
            textDocument: { uri: ctx.uri },
            position: toPosition(ctx, model, position),
            context: { includeDeclaration: context.includeDeclaration },
          }),
          token,
        );
        return answer ? locationsOf(answer.result, answer.context.encoding) : undefined;
      },
    } satisfies monaco.languages.ReferenceProvider);
  }

  if (capabilities.renameProvider) {
    const prepare =
      typeof capabilities.renameProvider === "object" &&
      capabilities.renameProvider.prepareProvider;
    register(L.registerRenameProvider, {
      async resolveRenameLocation(model, position, token) {
        if (!prepare) {
          const word = model.getWordAtPosition(position);
          if (!word)
            return {
              range: new monaco.Range(1, 1, 1, 1),
              text: "",
              rejectReason: "Nothing to rename here.",
            };
          return {
            range: new monaco.Range(
              position.lineNumber,
              word.startColumn,
              position.lineNumber,
              word.endColumn,
            ),
            text: word.word,
          };
        }
        const doc = documentOf(model);
        if (!doc || !installed) return undefined;
        const context = installed.manager.context(doc.key);
        if (!context) return undefined;
        try {
          const result = await installed.manager.request<
            P.Range | { range: P.Range; placeholder: string } | { defaultBehavior: boolean }
          >(
            doc.key,
            "textDocument/prepareRename",
            { textDocument: { uri: context.uri }, position: toPosition(context, model, position) },
            signalOf(token),
          );
          if (!result || "defaultBehavior" in result) {
            const word = model.getWordAtPosition(position);
            if (!word)
              return {
                range: new monaco.Range(1, 1, 1, 1),
                text: "",
                rejectReason: "Nothing to rename here.",
              };
            return {
              range: new monaco.Range(
                position.lineNumber,
                word.startColumn,
                position.lineNumber,
                word.endColumn,
              ),
              text: word.word,
            };
          }
          const range = "range" in result ? result.range : result;
          const monacoRange = fromRange(context, model, range);
          return {
            range: monacoRange,
            text: "placeholder" in result ? result.placeholder : model.getValueInRange(monacoRange),
          };
        } catch (error) {
          return {
            range: new monaco.Range(1, 1, 1, 1),
            text: "",
            rejectReason: error instanceof Error ? error.message : "This cannot be renamed.",
          };
        }
      },
      async provideRenameEdits(model, position, newName, token) {
        const answer = await ask<P.WorkspaceEdit>(
          id,
          model,
          "textDocument/rename",
          (ctx) => ({
            textDocument: { uri: ctx.uri },
            position: toPosition(ctx, model, position),
            newName,
          }),
          token,
        );
        // Monaco's own report of a refused rename goes to a notification service that, in the
        // standalone editor, only logs: the window says why instead.
        const refuse = (rejectReason: string) => {
          installed?.host.report(`Rename to ${newName}: ${rejectReason}`);
          return { edits: [], rejectReason };
        };
        if (!answer || !installed)
          return refuse(
            "the rename could not be computed (the file changed, or the server declined).",
          );
        // Applied by Yavin's engine -- through the Document Model, never by Monaco directly --
        // so Monaco is handed nothing further to apply.
        const outcome = await installed.host.applyWorkspaceEdit(
          answer.result,
          answer.context.encoding,
          `Rename to ${newName}`,
        );
        return outcome.applied ? { edits: [] } : refuse(outcome.failureReason ?? "not applied.");
      },
    } satisfies monaco.languages.RenameProvider);
  }

  const textEditsOf = (
    ctx: NonNullable<ReturnType<LspManager["context"]>>,
    model: monaco.editor.ITextModel,
    edits: P.TextEdit[] | null | undefined,
  ) => (edits ?? []).map((one) => ({ range: fromRange(ctx, model, one.range), text: one.newText }));
  const formatting = (options: monaco.languages.FormattingOptions) => ({
    tabSize: options.tabSize,
    insertSpaces: options.insertSpaces,
  });
  if (capabilities.documentFormattingProvider) {
    register(L.registerDocumentFormattingEditProvider, {
      displayName: definition.label,
      async provideDocumentFormattingEdits(model, options, token) {
        const answer = await ask<P.TextEdit[]>(
          id,
          model,
          "textDocument/formatting",
          (ctx) => ({
            textDocument: { uri: ctx.uri },
            options: formatting(options),
          }),
          token,
        );
        return answer ? textEditsOf(answer.context, model, answer.result) : undefined;
      },
    } satisfies monaco.languages.DocumentFormattingEditProvider);
  }
  if (capabilities.documentRangeFormattingProvider) {
    register(L.registerDocumentRangeFormattingEditProvider, {
      displayName: definition.label,
      async provideDocumentRangeFormattingEdits(model, range, options, token) {
        const answer = await ask<P.TextEdit[]>(
          id,
          model,
          "textDocument/rangeFormatting",
          (ctx) => ({
            textDocument: { uri: ctx.uri },
            range: toRange(ctx, model, range),
            options: formatting(options),
          }),
          token,
        );
        return answer ? textEditsOf(answer.context, model, answer.result) : undefined;
      },
    } satisfies monaco.languages.DocumentRangeFormattingEditProvider);
  }
  const onType = capabilities.documentOnTypeFormattingProvider;
  if (onType) {
    register(L.registerOnTypeFormattingEditProvider, {
      autoFormatTriggerCharacters: [
        onType.firstTriggerCharacter,
        ...(onType.moreTriggerCharacter ?? []),
      ],
      async provideOnTypeFormattingEdits(model, position, ch, options, token) {
        const answer = await ask<P.TextEdit[]>(
          id,
          model,
          "textDocument/onTypeFormatting",
          (ctx) => ({
            textDocument: { uri: ctx.uri },
            position: toPosition(ctx, model, position),
            ch,
            options: formatting(options),
          }),
          token,
        );
        return answer ? textEditsOf(answer.context, model, answer.result) : undefined;
      },
    } satisfies monaco.languages.OnTypeFormattingEditProvider);
  }

  if (capabilities.codeActionProvider) {
    const kinds =
      typeof capabilities.codeActionProvider === "object"
        ? capabilities.codeActionProvider.codeActionKinds
        : undefined;
    register(
      (language: string, provider: monaco.languages.CodeActionProvider) =>
        L.registerCodeActionProvider(
          language,
          provider,
          kinds ? { providedCodeActionKinds: kinds } : undefined,
        ),
      {
        async provideCodeActions(model, range, context, token) {
          const answer = await ask<(P.CodeAction | P.Command)[]>(
            id,
            model,
            "textDocument/codeAction",
            (ctx) => ({
              textDocument: { uri: ctx.uri },
              range: toRange(ctx, model, range),
              context: {
                diagnostics: context.markers.map((marker) => ({
                  range: toRange(ctx, model, marker),
                  message: marker.message,
                  severity:
                    marker.severity === monaco.MarkerSeverity.Error
                      ? 1
                      : marker.severity === monaco.MarkerSeverity.Warning
                        ? 2
                        : marker.severity === monaco.MarkerSeverity.Info
                          ? 3
                          : 4,
                  code:
                    typeof marker.code === "string" && /^\d+$/.test(marker.code)
                      ? Number(marker.code)
                      : marker.code,
                  source: marker.source,
                })),
                ...(context.only ? { only: [context.only] } : {}),
                triggerKind:
                  context.trigger === monaco.languages.CodeActionTriggerType.Invoke ? 1 : 2,
              },
            }),
            token,
          );
          if (!answer) return { actions: [], dispose() {} };
          const actions = answer.result.map((one): monaco.languages.CodeAction => {
            const action: P.CodeAction =
              "command" in one && typeof one.command === "string"
                ? { title: one.title, command: one as P.Command }
                : (one as P.CodeAction);
            return {
              title: action.title,
              kind: action.kind,
              isPreferred: action.isPreferred,
              disabled: action.disabled?.reason,
              diagnostics: context.markers.filter((marker) =>
                action.diagnostics?.some((diagnostic) => diagnostic.message === marker.message),
              ),
              command: {
                id: CODE_ACTION,
                title: action.title,
                arguments: [answer.doc.key, action, answer.context.encoding],
              },
            };
          });
          return { actions, dispose() {} };
        },
      },
    );
  }

  if (capabilities.documentSymbolProvider) {
    register(L.registerDocumentSymbolProvider, {
      displayName: definition.label,
      async provideDocumentSymbols(model, token) {
        const answer = await ask<(P.DocumentSymbol | P.SymbolInformation)[]>(
          id,
          model,
          "textDocument/documentSymbol",
          (ctx) => ({
            textDocument: { uri: ctx.uri },
          }),
          token,
        );
        if (!answer) return undefined;
        const { context: ctx } = answer;
        const convert = (
          symbol: P.DocumentSymbol | P.SymbolInformation,
        ): monaco.languages.DocumentSymbol => {
          const range =
            "range" in symbol
              ? symbol.range
              : "range" in symbol.location
                ? symbol.location.range
                : { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } };
          const selection = "selectionRange" in symbol ? symbol.selectionRange : range;
          return {
            name: symbol.name,
            detail:
              "detail" in symbol
                ? (symbol.detail ?? "")
                : "containerName" in symbol
                  ? (symbol.containerName ?? "")
                  : "",
            kind: (symbol.kind - 1) as monaco.languages.SymbolKind,
            tags: symbol.tags?.includes(1) ? [monaco.languages.SymbolTag.Deprecated] : [],
            range: fromRange(ctx, model, range),
            selectionRange: fromRange(ctx, model, selection),
            children: "children" in symbol ? symbol.children?.map(convert) : undefined,
          };
        };
        return answer.result.map(convert);
      },
    } satisfies monaco.languages.DocumentSymbolProvider);
  }

  const signature = capabilities.signatureHelpProvider;
  if (signature) {
    register(L.registerSignatureHelpProvider, {
      signatureHelpTriggerCharacters: signature.triggerCharacters,
      signatureHelpRetriggerCharacters: signature.retriggerCharacters,
      async provideSignatureHelp(model, position, token, context) {
        const answer = await ask<P.SignatureHelp>(
          id,
          model,
          "textDocument/signatureHelp",
          (ctx) => ({
            textDocument: { uri: ctx.uri },
            position: toPosition(ctx, model, position),
            context: {
              triggerKind: context.triggerKind,
              triggerCharacter: context.triggerCharacter,
              isRetrigger: context.isRetrigger,
            },
          }),
          token,
        );
        if (!answer || !answer.result.signatures.length) return undefined;
        const { result } = answer;
        return {
          value: {
            signatures: result.signatures.map((one) => ({
              label: one.label,
              documentation: documentation(one.documentation),
              parameters: (one.parameters ?? []).map((parameter) => ({
                label: parameter.label,
                documentation: documentation(parameter.documentation),
              })),
              activeParameter: one.activeParameter,
            })),
            activeSignature: result.activeSignature ?? 0,
            activeParameter: result.activeParameter ?? 0,
          },
          dispose() {},
        };
      },
    } satisfies monaco.languages.SignatureHelpProvider);
  }

  if (capabilities.documentLinkProvider) {
    register(L.registerLinkProvider, {
      async provideLinks(model, token) {
        const answer = await ask<P.DocumentLink[]>(
          id,
          model,
          "textDocument/documentLink",
          (ctx) => ({
            textDocument: { uri: ctx.uri },
          }),
          token,
        );
        if (!answer) return undefined;
        return {
          links: answer.result.map((link) => ({
            range: fromRange(answer.context, model, link.range),
            url: link.target,
            tooltip: link.tooltip,
          })),
        };
      },
    } satisfies monaco.languages.LinkProvider);
  }

  const semantic = capabilities.semanticTokensProvider;
  if (semantic?.full) {
    const delta = typeof semantic.full === "object" && semantic.full.delta;
    register(L.registerDocumentSemanticTokensProvider, {
      getLegend: () => semantic.legend,
      async provideDocumentSemanticTokens(model, lastResultId, token) {
        const useDelta = Boolean(delta && lastResultId);
        const answer = await ask<P.SemanticTokens | P.SemanticTokensDelta>(
          id,
          model,
          useDelta ? "textDocument/semanticTokens/full/delta" : "textDocument/semanticTokens/full",
          (ctx) => ({
            textDocument: { uri: ctx.uri },
            ...(useDelta ? { previousResultId: lastResultId } : {}),
          }),
          token,
        );
        if (!answer) return null;
        const { result, context: ctx } = answer;
        if ("edits" in result)
          return {
            resultId: result.resultId,
            edits: result.edits.map((edit) => ({
              start: edit.start,
              deleteCount: edit.deleteCount,
              data: edit.data ? new Uint32Array(edit.data) : undefined,
            })),
          };
        return {
          resultId: result.resultId,
          data: new Uint32Array(reencodeTokens(result.data, ctx)),
        };
      },
      releaseDocumentSemanticTokens() {},
    } satisfies monaco.languages.DocumentSemanticTokensProvider);
  }

  if (capabilities.inlayHintProvider) {
    register(L.registerInlayHintsProvider, {
      async provideInlayHints(model, range, token) {
        const answer = await ask<P.InlayHint[]>(
          id,
          model,
          "textDocument/inlayHint",
          (ctx) => ({
            textDocument: { uri: ctx.uri },
            range: toRange(ctx, model, range),
          }),
          token,
        );
        if (!answer) return { hints: [], dispose() {} };
        const { context: ctx } = answer;
        return {
          hints: answer.result.map((hint) => {
            const at = model.getPositionAt(ctx.index.offsetAt(hint.position, ctx.encoding));
            return {
              position: at,
              label:
                typeof hint.label === "string"
                  ? hint.label
                  : hint.label.map((part) => ({ label: part.value })),
              kind: hint.kind as monaco.languages.InlayHintKind | undefined,
              paddingLeft: hint.paddingLeft,
              paddingRight: hint.paddingRight,
              tooltip: documentation(hint.tooltip),
            };
          }),
          dispose() {},
        };
      },
    } satisfies monaco.languages.InlayHintsProvider);
  }

  const lens = capabilities.codeLensProvider;
  if (lens) {
    const lensData = new WeakMap<monaco.languages.CodeLens, { key: string; lens: P.CodeLens }>();
    register(L.registerCodeLensProvider, {
      async provideCodeLenses(model, token) {
        const answer = await ask<P.CodeLens[]>(
          id,
          model,
          "textDocument/codeLens",
          (ctx) => ({
            textDocument: { uri: ctx.uri },
          }),
          token,
        );
        if (!answer) return { lenses: [], dispose() {} };
        const lenses = answer.result.map((one) => {
          const converted: monaco.languages.CodeLens = {
            range: fromRange(answer.context, model, one.range),
            command: one.command
              ? { id: COMMAND, title: one.command.title, arguments: [answer.doc.key, one.command] }
              : undefined,
          };
          lensData.set(converted, { key: answer.doc.key, lens: one });
          return converted;
        });
        return { lenses, dispose() {} };
      },
      async resolveCodeLens(_model, codeLens, token) {
        const known = lensData.get(codeLens);
        if (!known || codeLens.command || !lens.resolveProvider || !installed) return codeLens;
        try {
          const resolved = await installed.manager.request<P.CodeLens>(
            known.key,
            "codeLens/resolve",
            known.lens,
            signalOf(token),
          );
          if (resolved?.command)
            return {
              ...codeLens,
              command: {
                id: COMMAND,
                title: resolved.command.title,
                arguments: [known.key, resolved.command],
              },
            };
        } catch {
          // Unresolved: shown without a title.
        }
        return codeLens;
      },
    } satisfies monaco.languages.CodeLensProvider);
  }
}

/** Semantic tokens in the server's encoding, re-encoded to UTF-16 columns when they differ. */
function reencodeTokens(
  data: number[],
  ctx: { index: LineIndex; encoding: PositionEncoding },
): number[] {
  if (ctx.encoding === "utf-16") return data;
  const out: number[] = [];
  let line = 0;
  let character = 0;
  let previousLine = 0;
  let previousStart = 0;
  for (let i = 0; i + 4 < data.length + 1; i += 5) {
    line += data[i];
    character = data[i] ? data[i + 1] : character + data[i + 1];
    const start = ctx.index.offsetAt({ line, character }, ctx.encoding);
    const end = ctx.index.offsetAt({ line, character: character + data[i + 2] }, ctx.encoding);
    const at = ctx.index.positionAt(start);
    const deltaLine = at.line - previousLine;
    out.push(
      deltaLine,
      deltaLine ? at.character : at.character - previousStart,
      end - start,
      data[i + 3],
      data[i + 4],
    );
    previousLine = at.line;
    previousStart = at.character;
  }
  return out;
}

// --- Commands --------------------------------------------------------------------------------

async function runServerCommand(key: string, command: P.Command) {
  if (!installed) return;
  // VS Code's own client command that servers put on reference-count lenses.
  if (command.command === "editor.action.showReferences") {
    const [, , locations] = (command.arguments ?? []) as [unknown, unknown, P.Location[]];
    installed.host.showLocations(
      command.title,
      (locations ?? []).flatMap((location) => {
        const path = lspPath(location.uri);
        return path ? [{ path, range: rangeInFile(location.uri, location.range, "utf-16") }] : [];
      }),
    );
    return;
  }
  try {
    await installed.manager.executeCommand(key, command.command, command.arguments);
  } catch (error) {
    installed.host.report(error instanceof Error ? error.message : String(error));
  }
}

async function runCodeAction(key: string, action: P.CodeAction, encoding: PositionEncoding) {
  if (!installed) return;
  if (action.disabled) {
    installed.host.report(action.disabled.reason);
    return;
  }
  if (action.edit) {
    const outcome = await installed.host.applyWorkspaceEdit(action.edit, encoding, action.title);
    if (!outcome.applied) {
      installed.host.report(`${action.title}: ${outcome.failureReason ?? "not applied"}`);
      return;
    }
  }
  if (action.command) await runServerCommand(key, action.command);
}

/** Every reference to what is under the cursor, as a list to pick from (Shift+F12). */
async function findReferences(editor: monaco.editor.ICodeEditor) {
  const model = editor.getModel();
  const position = editor.getPosition();
  if (!installed || !model || !position) return;
  const doc = documentOf(model);
  const context = doc && installed.manager.context(doc.key);
  if (!doc || !context || !installed.manager.capabilities(doc.key)?.referencesProvider) {
    installed.host.report("No language server offers references for this file.");
    return;
  }
  try {
    const result = await installed.manager.request<P.Location[]>(
      doc.key,
      "textDocument/references",
      {
        textDocument: { uri: context.uri },
        position: toPosition(context, model, position),
        context: { includeDeclaration: true },
      },
    );
    const word = model.getWordAtPosition(position)?.word ?? "symbol";
    installed.host.showLocations(
      `References to ${word}`,
      (result ?? []).flatMap((location) => {
        const path = lspPath(location.uri);
        if (!path) return [];
        const range = rangeInFile(location.uri, location.range, context.encoding);
        const id = lspResourceId(location.uri);
        const open = id ? findDocument(id) : undefined;
        const preview = open
          ? new LineIndex(open.text).lineText(range.startLineNumber - 1).trim()
          : undefined;
        return [{ path, range, preview }];
      }),
    );
  } catch (error) {
    if (!(error instanceof StaleResultError))
      installed.host.report(`Find All References: ${String(error)}`);
  }
}

// --- Installation ----------------------------------------------------------------------------

/**
 * Connects the language servers to Monaco, once per window: markers from the Problems store,
 * providers as servers become ready, navigation and commands through `host`.
 */
export function installLanguageFeatures(init: {
  manager: LspManager;
  bridge: EditorModelBridge;
  host: LanguageFeaturesHost;
  documents: () => TextDocument[];
}): monaco.IDisposable {
  installed = { manager: init.manager, bridge: init.bridge, host: init.host };
  documentsOf = init.documents;
  const disposables: monaco.IDisposable[] = [];

  const registerReady = () => {
    for (const { definition, capabilities } of init.manager.readyServers()) {
      if (registeredServers.has(definition.id)) continue;
      registeredServers.add(definition.id);
      registerServer(definition, capabilities);
    }
  };
  registerReady();
  const stopStatus = init.manager.subscribe(registerReady);
  const stopProblems = subscribeProblems(refreshMarkers);
  disposables.push(monaco.editor.onDidCreateModel(() => queueMicrotask(refreshMarkers)));
  refreshMarkers();

  disposables.push(
    monaco.editor.registerCommand(
      COMMAND,
      (_accessor, key: string, command: P.Command) => void runServerCommand(key, command),
    ),
    monaco.editor.registerCommand(
      CODE_ACTION,
      (_accessor, key: string, action: P.CodeAction, encoding: PositionEncoding) =>
        void runCodeAction(key, action, encoding),
    ),
    // Another file is opened through the window, like any other opening.
    monaco.editor.registerEditorOpener({
      openCodeEditor(_source, resource, selectionOrPosition) {
        const model = monaco.editor.getModel(resource);
        const doc = model ? documentOf(model) : undefined;
        const path = doc?.key ?? lspPath(resource.toString());
        if (!path || !installed) return false;
        const range = !selectionOrPosition
          ? undefined
          : "startLineNumber" in selectionOrPosition
            ? selectionOrPosition
            : {
                startLineNumber: selectionOrPosition.lineNumber,
                startColumn: selectionOrPosition.column,
                endLineNumber: selectionOrPosition.lineNumber,
                endColumn: selectionOrPosition.column,
              };
        installed.host.openLocation(path, range);
        return true;
      },
    }),
    monaco.editor.registerLinkOpener({
      open(resource) {
        if (!installed) return false;
        if (resource.scheme === "https" || resource.scheme === "http") {
          installed.host.openExternal(resource.toString());
          return true;
        }
        const path = resource.scheme === "file" ? lspPath(resource.toString()) : null;
        if (path) {
          installed.host.openLocation(path);
          return true;
        }
        return false;
      },
    }),
  );

  return {
    dispose() {
      stopStatus();
      stopProblems();
      for (const one of disposables) one.dispose();
      installed = null;
    },
  };
}

/** Adds Find All References (Shift+F12) to an editor: a list, rather than Monaco's peek view. */
export function addReferencesAction(
  editor: monaco.editor.IStandaloneCodeEditor,
): monaco.IDisposable {
  return editor.addAction({
    id: REFERENCES,
    label: "Find All References",
    keybindings: [monaco.KeyMod.Shift | monaco.KeyCode.F12],
    // Only where a server offers references: nothing is offered that cannot be done.
    precondition: "editorHasReferenceProvider",
    contextMenuGroupId: "navigation",
    contextMenuOrder: 2,
    run: (editor) => findReferences(editor),
  });
}
