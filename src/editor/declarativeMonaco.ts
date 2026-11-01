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
import {
  editorModelOf,
  extensionMayColour,
  isStandIn,
  monacoLanguage,
  useContributedLanguage,
} from "./monacoHost";
import TextMateWorker from "./textmate.worker?worker";
import { SCOPE_TOKENS } from "../services/extensions/declarative";
import { monacoThemeName } from "./themes";
import type { EditorModelBridge } from "../services/editorModelBridge";
import type {
  DeclarativeContributions,
  GrammarDefinition,
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

// --- Languages and grammars (EXT-25) ------------------------------------------------------------

/** How long a document's tokens may take before the grammar worker is ended. */
const TOKENIZE_TIMEOUT_MS = 4000;

/**
 * The grammar worker: one for the window, given every enabled grammar; ended (and started
 * afresh) when a document takes longer than `TOKENIZE_TIMEOUT_MS` -- the grammar that did it is
 * then not used again until its extension changes.
 */
function grammarWorker(onProblems: (problems: readonly string[]) => void) {
  let worker: Worker | null = null;
  let grammars: readonly GrammarDefinition[] = [];
  let next = 1;
  const waiting = new Map<
    number,
    { resolve(value: { lines: number[][] } | null): void; timer: ReturnType<typeof setTimeout> }
  >();
  const start = () => {
    worker = new TextMateWorker();
    worker.onmessage = (event: MessageEvent) => {
      const message = event.data as {
        type: string;
        id?: number;
        lines?: number[][];
        error?: string;
        problems?: string[];
      };
      if (message.type === "problems") return onProblems(message.problems ?? []);
      const one = waiting.get(message.id ?? -1);
      if (!one) return;
      waiting.delete(message.id!);
      clearTimeout(one.timer);
      one.resolve(message.error || !message.lines ? null : { lines: message.lines });
    };
    worker.postMessage({
      type: "grammars",
      grammars: grammars.map(({ scopeName, path, text }) => ({ scopeName, path, text })),
    });
  };
  const stop = () => {
    worker?.terminate();
    worker = null;
    for (const one of waiting.values()) {
      clearTimeout(one.timer);
      one.resolve(null);
    }
    waiting.clear();
  };
  return {
    setGrammars(list: readonly GrammarDefinition[]) {
      grammars = list;
      stop();
      if (list.length) start();
    },
    tokenize(
      scopeName: string,
      text: string,
      onTimeout: () => void,
    ): Promise<{ lines: number[][] } | null> {
      if (!worker) return Promise.resolve(null);
      const id = next++;
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          waiting.delete(id);
          resolve(null);
          // A runaway pattern: the worker is ended, never left running.
          stop();
          onTimeout();
          start();
        }, TOKENIZE_TIMEOUT_MS);
        waiting.set(id, { resolve, timer });
        worker!.postMessage({ type: "tokenize", id, scopeName, text });
      });
    },
    dispose: stop,
  };
}

/**
 * Extensions' languages in the editor (EXT-25): each contributed language Yavin has no
 * tokenizer of its own for becomes a Monaco language with its configuration, and -- when it has
 * a grammar -- semantic tokens from the grammar worker. Open documents of such a language are
 * switched to it. Data only; the grammars run in their worker.
 */
export function attachDeclarativeLanguages(
  bridge: EditorModelBridge,
  store: DeclarativeContributions,
  report: (extensionId: string, problem: string) => void = (id, problem) =>
    console.warn(`${id}: ${problem}`),
): () => void {
  const registrations: monaco.IDisposable[] = [];
  const disabled = new Set<string>();
  const worker = grammarWorker((problems) => {
    for (const problem of problems) console.warn(`Grammar: ${problem}`);
  });
  let applied = "";
  const legend = { tokenTypes: [...SCOPE_TOKENS], tokenModifiers: [] as string[] };
  const apply = () => {
    const { languages, grammars } = store.getSnapshot();
    const key = JSON.stringify([
      languages.map((l) => [l.id, l.extensionId]),
      grammars.map((g) => [g.scopeName, g.extensionId, g.path]),
    ]);
    if (key === applied) return;
    applied = key;
    for (const one of registrations.splice(0)) one.dispose();
    const known = new Set(monaco.languages.getLanguages().map((one) => one.id));
    const grammarOf = new Map<string, GrammarDefinition>();
    for (const grammar of grammars)
      if (grammar.language && !grammarOf.has(grammar.language))
        grammarOf.set(grammar.language, grammar);
    const used = new Set<string>();
    for (const language of languages) {
      if (!extensionMayColour(language.id)) continue;
      const grammar = grammarOf.get(language.id);
      // A stand-in (TOML's INI colours) gives way only to a grammar of the language's own.
      if (isStandIn(language.id) && !grammar) continue;
      if (!known.has(language.id))
        monaco.languages.register({ id: language.id, aliases: [...language.aliases] });
      used.add(language.id);
      if (language.config)
        try {
          registrations.push(
            monaco.languages.setLanguageConfiguration(
              language.id,
              language.config as monaco.languages.LanguageConfiguration,
            ),
          );
        } catch (error) {
          report(
            language.extensionId,
            `The language configuration of ${language.id} was not applied: ${String(error)}`,
          );
        }
      if (grammar)
        registrations.push(
          monaco.languages.registerDocumentSemanticTokensProvider(language.id, {
            getLegend: () => legend,
            async provideDocumentSemanticTokens(model) {
              if (disabled.has(grammar.scopeName)) return null;
              const result = await worker.tokenize(grammar.scopeName, model.getValue(), () => {
                disabled.add(grammar.scopeName);
                report(
                  grammar.extensionId,
                  `The grammar ${grammar.scopeName} took longer than ${TOKENIZE_TIMEOUT_MS / 1000} s and is not used.`,
                );
              });
              if (!result) return null;
              const data: number[] = [];
              let previousLine = 0;
              let previousStart = 0;
              result.lines.forEach((tokens, line) => {
                for (let i = 0; i < tokens.length; i += 3) {
                  const deltaLine = line - previousLine;
                  data.push(
                    deltaLine,
                    deltaLine ? tokens[i] : tokens[i] - previousStart,
                    tokens[i + 1],
                    tokens[i + 2],
                    0,
                  );
                  previousLine = line;
                  previousStart = tokens[i];
                }
              });
              return { data: new Uint32Array(data) };
            },
            releaseDocumentSemanticTokens() {},
          }),
        );
    }
    for (const language of languages) useContributedLanguage(language.id, used.has(language.id));
    worker.setGrammars(grammars.filter((g) => !disabled.has(g.scopeName)));
    // Documents already open in a language now contributed show it.
    for (const model of monaco.editor.getModels()) {
      const bridged = editorModelOf(model);
      const languageId = bridged ? bridge.documentOf(bridged)?.languageId : undefined;
      if (languageId && used.has(languageId) && model.getLanguageId() !== languageId)
        monaco.editor.setModelLanguage(model, languageId);
    }
  };
  apply();
  const unsubscribe = store.subscribe(apply);
  return () => {
    unsubscribe();
    for (const one of registrations.splice(0)) one.dispose();
    worker.dispose();
  };
}
