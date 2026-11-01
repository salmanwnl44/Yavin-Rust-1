/**
 * The parts of the Language Server Protocol (3.17) Yavin speaks, as types. Written out rather
 * than generated: this is the contract the rest of `services/lsp` is checked against, and a
 * field that is not here is one nothing reads.
 */

export interface Position {
  line: number;
  /** In the position encoding the server and client agreed on (UTF-16 unless told otherwise). */
  character: number;
}

export interface Range {
  start: Position;
  end: Position;
}

export interface Location {
  uri: string;
  range: Range;
}

export interface LocationLink {
  originSelectionRange?: Range;
  targetUri: string;
  targetRange: Range;
  targetSelectionRange: Range;
}

export const DiagnosticSeverity = { Error: 1, Warning: 2, Information: 3, Hint: 4 } as const;
export const DiagnosticTag = { Unnecessary: 1, Deprecated: 2 } as const;

export interface Diagnostic {
  range: Range;
  severity?: number;
  code?: number | string;
  codeDescription?: { href: string };
  source?: string;
  message: string;
  tags?: number[];
  relatedInformation?: { location: Location; message: string }[];
  data?: unknown;
}

export interface PublishDiagnosticsParams {
  uri: string;
  version?: number;
  diagnostics: Diagnostic[];
}

export interface TextEdit {
  range: Range;
  newText: string;
}

export interface InsertReplaceEdit {
  newText: string;
  insert: Range;
  replace: Range;
}

export interface TextDocumentEdit {
  textDocument: { uri: string; version: number | null };
  edits: TextEdit[];
}

export interface CreateFile {
  kind: "create";
  uri: string;
  options?: { overwrite?: boolean; ignoreIfExists?: boolean };
}

export interface RenameFile {
  kind: "rename";
  oldUri: string;
  newUri: string;
  options?: { overwrite?: boolean; ignoreIfExists?: boolean };
}

export interface DeleteFile {
  kind: "delete";
  uri: string;
  options?: { recursive?: boolean; ignoreIfNotExists?: boolean };
}

export interface WorkspaceEdit {
  changes?: Record<string, TextEdit[]>;
  documentChanges?: (TextDocumentEdit | CreateFile | RenameFile | DeleteFile)[];
}

export interface Command {
  title: string;
  command: string;
  arguments?: unknown[];
}

export interface MarkupContent {
  kind: "plaintext" | "markdown";
  value: string;
}

export type MarkedString = string | { language: string; value: string };

export interface Hover {
  contents: MarkupContent | MarkedString | MarkedString[];
  range?: Range;
}

export const CompletionItemKind = {
  Text: 1,
  Method: 2,
  Function: 3,
  Constructor: 4,
  Field: 5,
  Variable: 6,
  Class: 7,
  Interface: 8,
  Module: 9,
  Property: 10,
  Unit: 11,
  Value: 12,
  Enum: 13,
  Keyword: 14,
  Snippet: 15,
  Color: 16,
  File: 17,
  Reference: 18,
  Folder: 19,
  EnumMember: 20,
  Constant: 21,
  Struct: 22,
  Event: 23,
  Operator: 24,
  TypeParameter: 25,
} as const;

export const InsertTextFormat = { PlainText: 1, Snippet: 2 } as const;

export interface CompletionItem {
  label: string;
  labelDetails?: { detail?: string; description?: string };
  kind?: number;
  tags?: number[];
  detail?: string;
  documentation?: string | MarkupContent;
  deprecated?: boolean;
  preselect?: boolean;
  sortText?: string;
  filterText?: string;
  insertText?: string;
  insertTextFormat?: number;
  textEdit?: TextEdit | InsertReplaceEdit;
  additionalTextEdits?: TextEdit[];
  commitCharacters?: string[];
  command?: Command;
  data?: unknown;
}

export interface CompletionList {
  isIncomplete: boolean;
  items: CompletionItem[];
}

export interface ParameterInformation {
  label: string | [number, number];
  documentation?: string | MarkupContent;
}

export interface SignatureInformation {
  label: string;
  documentation?: string | MarkupContent;
  parameters?: ParameterInformation[];
  activeParameter?: number;
}

export interface SignatureHelp {
  signatures: SignatureInformation[];
  activeSignature?: number;
  activeParameter?: number;
}

export const SymbolKind = {
  File: 1,
  Module: 2,
  Namespace: 3,
  Package: 4,
  Class: 5,
  Method: 6,
  Property: 7,
  Field: 8,
  Constructor: 9,
  Enum: 10,
  Interface: 11,
  Function: 12,
  Variable: 13,
  Constant: 14,
  String: 15,
  Number: 16,
  Boolean: 17,
  Array: 18,
  Object: 19,
  Key: 20,
  Null: 21,
  EnumMember: 22,
  Struct: 23,
  Event: 24,
  Operator: 25,
  TypeParameter: 26,
} as const;

export interface DocumentSymbol {
  name: string;
  detail?: string;
  kind: number;
  tags?: number[];
  deprecated?: boolean;
  range: Range;
  selectionRange: Range;
  children?: DocumentSymbol[];
}

export interface SymbolInformation {
  name: string;
  kind: number;
  tags?: number[];
  deprecated?: boolean;
  location: Location | { uri: string };
  containerName?: string;
}

export interface CodeAction {
  title: string;
  kind?: string;
  diagnostics?: Diagnostic[];
  isPreferred?: boolean;
  disabled?: { reason: string };
  edit?: WorkspaceEdit;
  command?: Command;
  data?: unknown;
}

export interface CodeLens {
  range: Range;
  command?: Command;
  data?: unknown;
}

export interface InlayHint {
  position: Position;
  label: string | { value: string; tooltip?: string | MarkupContent }[];
  kind?: number;
  tooltip?: string | MarkupContent;
  paddingLeft?: boolean;
  paddingRight?: boolean;
}

export interface DocumentLink {
  range: Range;
  target?: string;
  tooltip?: string;
}

export interface SemanticTokens {
  resultId?: string;
  data: number[];
}

export interface SemanticTokensDelta {
  resultId?: string;
  edits: { start: number; deleteCount: number; data?: number[] }[];
}

export interface SemanticTokensLegend {
  tokenTypes: string[];
  tokenModifiers: string[];
}

export const TextDocumentSyncKind = { None: 0, Full: 1, Incremental: 2 } as const;

/** What a server said it can do. Read defensively: every field is optional and loosely typed. */
export interface ServerCapabilities {
  positionEncoding?: string;
  textDocumentSync?:
    | number
    | {
        openClose?: boolean;
        change?: number;
        save?: boolean | { includeText?: boolean };
      };
  completionProvider?: {
    triggerCharacters?: string[];
    allCommitCharacters?: string[];
    resolveProvider?: boolean;
  };
  hoverProvider?: boolean | object;
  signatureHelpProvider?: { triggerCharacters?: string[]; retriggerCharacters?: string[] };
  declarationProvider?: boolean | object;
  definitionProvider?: boolean | object;
  typeDefinitionProvider?: boolean | object;
  implementationProvider?: boolean | object;
  referencesProvider?: boolean | object;
  documentSymbolProvider?: boolean | object;
  workspaceSymbolProvider?: boolean | object;
  codeActionProvider?: boolean | { codeActionKinds?: string[]; resolveProvider?: boolean };
  codeLensProvider?: { resolveProvider?: boolean };
  documentLinkProvider?: { resolveProvider?: boolean };
  documentFormattingProvider?: boolean | object;
  documentRangeFormattingProvider?: boolean | object;
  documentOnTypeFormattingProvider?: {
    firstTriggerCharacter: string;
    moreTriggerCharacter?: string[];
  };
  renameProvider?: boolean | { prepareProvider?: boolean };
  executeCommandProvider?: { commands: string[] };
  semanticTokensProvider?: {
    legend: SemanticTokensLegend;
    range?: boolean | object;
    full?: boolean | { delta?: boolean };
  };
  inlayHintProvider?: boolean | { resolveProvider?: boolean };
  [other: string]: unknown;
}

export interface InitializeResult {
  capabilities: ServerCapabilities;
  serverInfo?: { name: string; version?: string };
}
