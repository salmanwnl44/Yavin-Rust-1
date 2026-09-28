import { monaco } from "./monaco";
import { changedSpan } from "../services/editorModelBridge";
import type {
  EditorDecoration,
  EditorModel,
  EditorModelHost,
  EditorModelNaming,
} from "../services/editorModelBridge";
import type { TextDocument } from "../services/documents";

/**
 * Yavin language ids (`services/language.ts`, from the document) to the Monaco language that
 * colours them. The one mapping; there is no editor-side language detection. A language with no
 * Monaco tokenizer here is plain text -- nothing is guessed.
 */
const MONACO_LANGUAGE: Record<string, string> = {
  typescript: "typescript",
  typescriptreact: "typescript",
  javascript: "javascript",
  javascriptreact: "javascript",
  json: "json",
  jsonc: "json",
  rust: "rust",
  python: "python",
  markdown: "markdown",
  mdx: "mdx",
  css: "css",
  scss: "scss",
  less: "less",
  html: "html",
  xml: "xml",
  yaml: "yaml",
  // TOML, ignore, properties and .env files share INI's `key = value` and `[section]` shapes.
  toml: "ini",
  ignore: "ini",
  properties: "ini",
  ini: "ini",
  dotenv: "ini",
  shellscript: "shell",
  powershell: "powershell",
  bat: "bat",
  go: "go",
  java: "java",
  c: "cpp",
  cpp: "cpp",
  csharp: "csharp",
  sql: "sql",
  dockerfile: "dockerfile",
};

export const monacoLanguage = (languageId: string): string =>
  MONACO_LANGUAGE[languageId] ?? "plaintext";

/**
 * A document's Monaco URI, from Yavin's `ResourceUri` -- scheme, authority and path as Module 01
 * spelled them, so no second path normalization exists. A document without a resource
 * (untitled) is named in its own scheme by its id; a proposal is a `proposed` resource beside
 * its file, never the file's own URI.
 */
export function monacoUri(doc: TextDocument): monaco.Uri {
  if (doc.source.kind === "disk" && doc.uri)
    return monaco.Uri.from({
      scheme: doc.uri.scheme,
      authority: doc.uri.authority,
      path: doc.uri.path,
    });
  const [scheme, rest] = doc.id.split(":");
  return monaco.Uri.from({
    scheme: scheme || "untitled",
    path: doc.uri ? `${doc.uri.path}` : `/${rest ?? doc.id}`,
    query: doc.uri ? rest : undefined,
  });
}

export const monacoNaming: EditorModelNaming = {
  languageOf: (doc) => monacoLanguage(doc.languageId),
  uriOf: (doc) => monacoUri(doc).toString(),
};

/** A Monaco text model behind the bridge's `EditorModel`. */
class MonacoModel implements EditorModel {
  readonly model: monaco.editor.ITextModel;
  private readonly collections = new Map<string, string[]>();

  constructor(model: monaco.editor.ITextModel) {
    this.model = model;
  }

  getValue(): string {
    return this.model.getValue();
  }

  /**
   * The document changed by something other than typing here (a reload, Revert, a replace):
   * just the span that differs is replaced, as one undo step of its own, so cursors outside it
   * stay where they were and Undo takes the change back as a whole.
   */
  applyExternal(text: string): void {
    const before = this.model.getValue();
    if (before === text) return;
    const span = changedSpan(before, text);
    const start = this.model.getPositionAt(span.start);
    const end = this.model.getPositionAt(span.end);
    this.model.pushStackElement();
    this.model.pushEditOperations(
      [],
      [
        {
          range: new monaco.Range(start.lineNumber, start.column, end.lineNumber, end.column),
          text: span.text,
        },
      ],
      () => null,
    );
    this.model.pushStackElement();
  }

  onDidChangeContent(listener: () => void) {
    return this.model.onDidChangeContent(listener);
  }

  pushUndoStop(): void {
    this.model.pushStackElement();
  }

  setLanguage(languageId: string): void {
    monaco.editor.setModelLanguage(this.model, languageId);
  }

  setDecorations(owner: string, decorations: readonly EditorDecoration[]): void {
    const previous = this.collections.get(owner) ?? [];
    const next = this.model.deltaDecorations(
      previous,
      decorations.map((decoration) => {
        const start = this.model.getPositionAt(decoration.start);
        const end = this.model.getPositionAt(decoration.end);
        return {
          range: new monaco.Range(start.lineNumber, start.column, end.lineNumber, end.column),
          options: {
            className: decoration.wholeLine ? undefined : decoration.className,
            isWholeLine: decoration.wholeLine,
            linesDecorationsClassName: decoration.wholeLine ? decoration.className : undefined,
            // Plain text, never rendered as HTML.
            hoverMessage: decoration.hoverMessage
              ? { value: decoration.hoverMessage, isTrusted: false, supportHtml: false }
              : undefined,
          },
        };
      }),
    );
    if (next.length) this.collections.set(owner, next);
    else this.collections.delete(owner);
  }

  dispose(): void {
    this.collections.clear();
    this.model.dispose();
  }
}

export const monacoHost: EditorModelHost = {
  create(text, languageId, uri) {
    // Monaco allows one model per URI. A document keeps its model -- and so the URI it was
    // opened under -- through a rename, so another document can later want that URI (a new
    // file where the renamed one was): it gets a distinct one rather than taking the other's.
    const base = monaco.Uri.parse(uri);
    let parsed = base;
    for (let n = 2; monaco.editor.getModel(parsed); n++)
      parsed = base.with({ query: `instance=${n}` });
    const model = monaco.editor.createModel(text, languageId, parsed);
    // Document text is always `\n` (the Document Model keeps the file's own line endings and
    // writes them back); the model must never turn a paste into `\r\n`.
    model.setEOL(monaco.editor.EndOfLineSequence.LF);
    return new MonacoModel(model);
  },
};

/** The Monaco text model behind a bridge model, for binding it to an editor. */
export const textModelOf = (model: EditorModel): monaco.editor.ITextModel =>
  (model as MonacoModel).model;
