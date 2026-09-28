/**
 * Yavin's Monaco: the editing engine, and only the parts of it Yavin uses.
 *
 * Monaco's own entry (`editor.main`) also brings the TypeScript, CSS and HTML language
 * services and an LSP client -- language intelligence, which is Module 10's, through Yavin's
 * own language servers. So this is Yavin's entry instead: the editor API, the editor features
 * (find and replace, folding, multi-cursor, bracket matching...), syntax colouring for the
 * languages `monacoHost.ts` maps to (JSON included, see below).
 *
 * Workers are separate files Vite emits beside the app (`?worker`), loaded from the app's own
 * origin -- what the desktop build's `script-src 'self'` allows, in development and packaged
 * alike. No blob or data URLs, no paths that only exist on the dev server.
 */
import * as monaco from "monaco-editor/editor/editor.api";
import { TEST_HOOKS } from "./testHooks";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";

// The editor features, as `editor.main` loads them.
// By file: the package's `exports` map only resolves `.js` files, and these are stylesheets.
import "../../node_modules/monaco-editor/esm/vs/base/browser/ui/codicons/codicon/codicon.css";
import "../../node_modules/monaco-editor/esm/vs/base/browser/ui/codicons/codicon/codicon-modifiers.css";
import "monaco-editor/editor/browser/coreCommands";
import "monaco-editor/editor/browser/widget/codeEditor/codeEditorWidget";
import "monaco-editor/editor/browser/widget/diffEditor/diffEditor.contribution";
import "monaco-editor/editor/contrib/anchorSelect/browser/anchorSelect";
import "monaco-editor/editor/contrib/bracketMatching/browser/bracketMatching";
import "monaco-editor/editor/contrib/caretOperations/browser/caretOperations";
import "monaco-editor/editor/contrib/caretOperations/browser/transpose";
import "monaco-editor/editor/contrib/clipboard/browser/clipboard";
import "monaco-editor/editor/contrib/comment/browser/comment";
import "monaco-editor/editor/contrib/contextmenu/browser/contextmenu";
import "monaco-editor/editor/contrib/cursorUndo/browser/cursorUndo";
import "monaco-editor/editor/contrib/dnd/browser/dnd";
import "monaco-editor/editor/contrib/dropOrPasteInto/browser/copyPasteContribution";
import "monaco-editor/editor/contrib/dropOrPasteInto/browser/dropIntoEditorContribution";
import "monaco-editor/features/find/register";
import "monaco-editor/editor/contrib/find/browser/findController";
import "monaco-editor/editor/contrib/folding/browser/folding";
import "monaco-editor/editor/contrib/fontZoom/browser/fontZoom";
import "monaco-editor/editor/contrib/format/browser/formatActions";
import "monaco-editor/editor/contrib/indentation/browser/indentation";
import "monaco-editor/editor/contrib/inPlaceReplace/browser/inPlaceReplace";
import "monaco-editor/editor/contrib/insertFinalNewLine/browser/insertFinalNewLine";
import "monaco-editor/editor/contrib/lineSelection/browser/lineSelection";
import "monaco-editor/editor/contrib/linesOperations/browser/linesOperations";
import "monaco-editor/editor/contrib/linkedEditing/browser/linkedEditing";
import "monaco-editor/editor/contrib/longLinesHelper/browser/longLinesHelper";
import "monaco-editor/editor/contrib/middleScroll/browser/middleScroll.contribution";
import "monaco-editor/editor/contrib/multicursor/browser/multicursor";
import "monaco-editor/editor/contrib/placeholderText/browser/placeholderText.contribution";
import "monaco-editor/editor/contrib/readOnlyMessage/browser/contribution";
import "monaco-editor/editor/contrib/smartSelect/browser/smartSelect";
import "monaco-editor/editor/contrib/snippet/browser/snippetController2";
import "monaco-editor/editor/contrib/stickyScroll/browser/stickyScrollContribution";
import "monaco-editor/editor/contrib/tokenization/browser/tokenization";
import "monaco-editor/editor/contrib/toggleTabFocusMode/browser/toggleTabFocusMode";
import "monaco-editor/editor/contrib/unicodeHighlighter/browser/unicodeHighlighter";
import "monaco-editor/editor/contrib/unusualLineTerminators/browser/unusualLineTerminators";
import "monaco-editor/editor/contrib/wordHighlighter/browser/wordHighlighter";
import "monaco-editor/editor/contrib/wordOperations/browser/wordOperations";
import "monaco-editor/editor/contrib/wordPartOperations/browser/wordPartOperations";
import "monaco-editor/editor/common/standaloneStrings";

// Syntax colouring: Monarch tokenizers only, each loaded when a document first needs it.
import "monaco-editor/languages/definitions/bat/register";
import "monaco-editor/languages/definitions/cpp/register";
import "monaco-editor/languages/definitions/csharp/register";
import "monaco-editor/languages/definitions/css/register";
import "monaco-editor/languages/definitions/dockerfile/register";
import "monaco-editor/languages/definitions/go/register";
import "monaco-editor/languages/definitions/html/register";
import "monaco-editor/languages/definitions/ini/register";
import "monaco-editor/languages/definitions/java/register";
import "monaco-editor/languages/definitions/javascript/register";
import "monaco-editor/languages/definitions/less/register";
import "monaco-editor/languages/definitions/markdown/register";
import "monaco-editor/languages/definitions/mdx/register";
import "monaco-editor/languages/definitions/powershell/register";
import "monaco-editor/languages/definitions/python/register";
import "monaco-editor/languages/definitions/rust/register";
import "monaco-editor/languages/definitions/scss/register";
import "monaco-editor/languages/definitions/shell/register";
import "monaco-editor/languages/definitions/sql/register";
import "monaco-editor/languages/definitions/typescript/register";
import "monaco-editor/languages/definitions/xml/register";
import "monaco-editor/languages/definitions/yaml/register";

/**
 * JSON: its own language id (what a JSON language server attaches to in Module 10), coloured
 * by the JavaScript tokenizer -- JSON is its subset. Not Monaco's JSON language service: that
 * brings its own worker and, through it, the whole language-intelligence machinery (code
 * lens, inlay hints, suggest, hover) -- Module 10's -- in a 700 KB module, half of it wired to
 * services that are not there.
 */
monaco.languages.register({
  id: "json",
  extensions: [".json", ".jsonc"],
  aliases: ["JSON", "json"],
  mimetypes: ["application/json"],
});
monaco.languages.onLanguage("json", () => {
  void import("monaco-editor/languages/definitions/javascript/javascript").then(
    ({ conf, language }) => {
      monaco.languages.setLanguageConfiguration("json", conf);
      monaco.languages.setMonarchTokensProvider("json", { ...language, tokenPostfix: ".json" });
    },
  );
});

self.MonacoEnvironment = {
  // One worker: the editor's own (diffs, and the other work Monaco does off the main thread).
  getWorker: () => new EditorWorker(),
};

/**
 * Yavin's themes, from the colours the rest of the window uses (a near-black editor surface,
 * zinc text, the indigo accent). Dark is the window's; light is ready for when it has one.
 */
monaco.editor.defineTheme("yavin-dark", {
  base: "vs-dark",
  inherit: true,
  // A pure-black take on Visual Studio's dark palette. Monarch tokenizers do not tell function
  // names from other identifiers, so functions share the identifier colour until a language
  // service supplies semantic tokens.
  rules: [
    { token: "", foreground: "D4D4D4" },
    { token: "keyword", foreground: "569CD6" },
    { token: "string", foreground: "CE9178" },
    { token: "comment", foreground: "6A9955" },
    { token: "number", foreground: "B5CEA8" },
    { token: "type", foreground: "4EC9B0" },
    { token: "identifier", foreground: "9CDCFE" },
    { token: "constant", foreground: "4FC1FF" },
    { token: "predefined", foreground: "4FC1FF" },
    { token: "annotation", foreground: "C586C0" },
    { token: "tag.python", foreground: "C586C0" },
    { token: "delimiter", foreground: "D4D4D4" },
    { token: "operator", foreground: "D4D4D4" },
  ],
  colors: {
    "editor.background": "#000000",
    "editor.foreground": "#D4D4D4",
    "editorGutter.background": "#000000",
    "editorLineNumber.foreground": "#4A4A4A",
    "editorLineNumber.activeForeground": "#D4D4D4",
    "editor.lineHighlightBackground": "#0c0c10",
    "editor.selectionBackground": "#264F78",
    "editorCursor.foreground": "#a5b4fc",
    "editorWidget.background": "#0a0a0a",
    "editorWidget.border": "#27272a",
    "minimap.background": "#030303",
    "scrollbarSlider.background": "#27272a80",
  },
});
monaco.editor.defineTheme("yavin-light", {
  base: "vs",
  inherit: true,
  rules: [],
  colors: {
    "editor.selectionBackground": "#c7d2fe",
    "editorCursor.foreground": "#4f46e5",
  },
});

// Development builds only: the UI tests count live models across editor lifetimes.
if (TEST_HOOKS)
  (window as unknown as { __yavinMonaco?: unknown }).__yavinMonaco = {
    modelCount: () => monaco.editor.getModels().length,
  };

export { monaco };
export type Monaco = typeof monaco;
