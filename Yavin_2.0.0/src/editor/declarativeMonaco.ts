/**
 * Extensions' colour themes and snippets in the editor (EXT-04), from the declarative store
 * (`services/extensions/declarative.ts`) -- data only; nothing here runs extension code.
 *
 * - **Themes** are defined in Monaco (under `monacoThemeName`'s escaped names) by the editor,
 *   before it is created; the theme setting offers them through `followContributedThemes`
 *   (`themes.ts`), which needs no Monaco -- so the window never loads it early. Monaco cannot
 *   forget a defined theme; one whose extension is gone leaves the list, and the editor falls
 *   back to Yavin Dark.
 * - **Snippets** are one completion provider per Monaco language that has any, offering each
 *   snippet only in documents of its own (Yavin) language: TypeScript snippets never appear in
 *   a TSX file that shares Monaco's TypeScript tokenizer. Providers come and go with the store.
 */
import { monaco } from "./monaco";
import { editorModelOf, monacoLanguage } from "./monacoHost";
import { monacoThemeName } from "./themes";
import type { EditorModelBridge } from "../services/editorModelBridge";
import type {
  DeclarativeContributions,
  SnippetDefinition,
} from "../services/extensions/declarative";

/**
 * Keeps Monaco's extension themes in step with the store: run by the editor, where Monaco is
 * loaded anyway (the window offers them through `followContributedThemes`, without Monaco).
 */
export function defineDeclarativeThemes(store: DeclarativeContributions): () => void {
  const apply = () => {
    for (const theme of store.getSnapshot().themes) {
      try {
        monaco.editor.defineTheme(monacoThemeName(theme.id), {
          base: theme.base,
          inherit: true,
          rules: theme.rules,
          colors: theme.colors,
        });
      } catch (error) {
        console.warn(
          `${theme.extensionId}: theme "${theme.label}" was not applied: ${String(error)}`,
        );
      }
    }
  };
  apply();
  return store.subscribe(apply);
}

/** Offers extensions' snippets in the editor, for their own languages. */
export function attachDeclarativeSnippets(
  bridge: EditorModelBridge,
  store: DeclarativeContributions,
): () => void {
  const registered = new Map<string, monaco.IDisposable>();
  let byLanguage = new Map<string, SnippetDefinition[]>();
  const languageOf = (model: monaco.editor.ITextModel) => {
    const bridged = editorModelOf(model);
    return bridged ? bridge.documentOf(bridged)?.languageId : undefined;
  };
  const provider: monaco.languages.CompletionItemProvider = {
    provideCompletionItems(model, position) {
      const language = languageOf(model);
      const snippets = language ? (byLanguage.get(language) ?? []) : [];
      const word = model.getWordUntilPosition(position);
      const range = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endColumn: word.endColumn,
      };
      return {
        suggestions: snippets.map((snippet) => ({
          label: snippet.prefix,
          kind: monaco.languages.CompletionItemKind.Snippet,
          detail: `${snippet.name} (${snippet.extensionId})`,
          documentation: snippet.description ?? undefined,
          insertText: snippet.body,
          insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
          range,
        })),
      };
    },
  };
  const apply = () => {
    byLanguage = new Map();
    for (const snippet of store.getSnapshot().snippets)
      byLanguage.set(snippet.language, [...(byLanguage.get(snippet.language) ?? []), snippet]);
    const wanted = new Set([...byLanguage.keys()].map(monacoLanguage));
    for (const [language, registration] of registered)
      if (!wanted.has(language)) {
        registration.dispose();
        registered.delete(language);
      }
    for (const language of wanted)
      if (!registered.has(language))
        registered.set(
          language,
          monaco.languages.registerCompletionItemProvider(language, provider),
        );
  };
  apply();
  const unsubscribe = store.subscribe(apply);
  return () => {
    unsubscribe();
    for (const registration of registered.values()) registration.dispose();
    registered.clear();
  };
}
