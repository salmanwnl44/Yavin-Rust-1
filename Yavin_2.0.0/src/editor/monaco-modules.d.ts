// Monaco ships no declarations for its tokenizer definitions; this is the one Yavin loads.
declare module "monaco-editor/languages/definitions/javascript/javascript" {
  import type { languages } from "monaco-editor/editor/editor.api";
  export const conf: languages.LanguageConfiguration;
  export const language: languages.IMonarchLanguage;
}
