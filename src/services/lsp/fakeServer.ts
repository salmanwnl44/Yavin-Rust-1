/**
 * A deterministic language server for tests: the whole protocol surface Yavin uses, with
 * behaviour simple enough to predict exactly, and knobs to make it slow, silent, broken or dead.
 *
 * It keeps its own copy of every document by applying the changes it is sent -- incremental or
 * full -- so a synchronization bug shows up as wrong answers, not as a test that trusts the
 * client. It has no imports: the unit tests run it in Node, and the UI tests bundle this file
 * into the page, where it stands in for a native server process.
 *
 * Its "language", for any file:
 * - words are `[A-Za-z_]\w*`; `function|def|class|let|const NAME` declares NAME;
 * - `TODO` is a warning and the word `error` an error (published after every change);
 * - `fakeFunction(a, b)` has a signature; `let x = 1` gets an inlay hint `: number`.
 */

export interface FakeServerOptions {
  /** 2 (incremental, the default) or 1 (full). */
  syncKind?: 1 | 2;
  /** Capabilities left out of `initialize`'s answer, by name (e.g. "renameProvider"). */
  without?: string[];
  /** Milliseconds to wait before answering, by method. */
  delays?: Record<string, number>;
  /** Methods never answered at all. */
  silent?: string[];
  /** A method that makes the server exit with code 1 when it arrives. */
  crashOn?: string;
  /** Milliseconds before publishing diagnostics after a change. */
  diagnosticsDelay?: number;
}

export interface FakeServerIO {
  send(message: string): void;
  exit(code: number): void;
}

interface Doc {
  uri: string;
  text: string;
  version: number;
  languageId: string;
}

type Params = Record<string, any>;

const WORD = /[A-Za-z_][A-Za-z0-9_]*/g;
const KEYWORDS = new Set(["function", "def", "class", "const", "let", "return", "import", "from"]);
const TOKEN_TYPES = ["keyword", "function", "variable", "type"];

export function createFakeServer(options: FakeServerOptions, io: FakeServerIO) {
  const docs = new Map<string, Doc>();
  const received: { method: string; params: Params }[] = [];
  const cancelled = new Set<number | string>();
  let nextServerRequest = 1;
  const waitingOnClient = new Map<number | string, (result: unknown) => void>();
  let semanticResult = 0;
  const previousTokens = new Map<string, number[]>();
  let exited = false;
  let rootUri: string | null = null;

  const send = (message: object) => {
    if (!exited) io.send(JSON.stringify({ jsonrpc: "2.0", ...message }));
  };
  const exit = (code: number) => {
    if (exited) return;
    exited = true;
    io.exit(code);
  };

  // --- Text ------------------------------------------------------------------------------
  // The line table of the last text asked about: one document is converted many times in a row.
  let tableFor: string | null = null;
  let table: number[] = [];
  const lineStarts = (text: string) => {
    if (text === tableFor) return table;
    const starts = [0];
    for (let i = 0; i < text.length; i++) if (text[i] === "\n") starts.push(i + 1);
    tableFor = text;
    table = starts;
    return starts;
  };
  const offsetAt = (text: string, position: { line: number; character: number }) => {
    const starts = lineStarts(text);
    if (position.line >= starts.length) return text.length;
    const end = position.line + 1 < starts.length ? starts[position.line + 1] - 1 : text.length;
    return Math.min(starts[position.line] + position.character, end);
  };
  const positionAt = (text: string, offset: number) => {
    const starts = lineStarts(text);
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (starts[middle] <= offset) low = middle;
      else high = middle - 1;
    }
    return { line: low, character: offset - starts[low] };
  };
  const rangeOf = (text: string, start: number, end: number) => ({
    start: positionAt(text, start),
    end: positionAt(text, end),
  });
  const wordAt = (doc: Doc, position: { line: number; character: number }) => {
    const offset = offsetAt(doc.text, position);
    for (const match of doc.text.matchAll(WORD)) {
      const start = match.index ?? 0;
      if (start <= offset && offset <= start + match[0].length)
        return { word: match[0], start, end: start + match[0].length };
    }
    return null;
  };
  const occurrences = (word: string) => {
    const found: { doc: Doc; start: number; end: number }[] = [];
    const pattern = new RegExp(`\\b${word}\\b`, "g");
    for (const doc of docs.values())
      for (const match of doc.text.matchAll(pattern))
        found.push({ doc, start: match.index ?? 0, end: (match.index ?? 0) + word.length });
    return found;
  };
  const declarations = (word: string) => {
    const found: { doc: Doc; start: number; end: number }[] = [];
    const pattern = new RegExp(`\\b(function|def|class|let|const)\\s+(${word})\\b`, "g");
    for (const doc of docs.values())
      for (const match of doc.text.matchAll(pattern)) {
        const start = (match.index ?? 0) + match[0].length - word.length;
        found.push({ doc, start, end: start + word.length });
      }
    return found;
  };
  const location = (found: { doc: Doc; start: number; end: number }) => ({
    uri: found.doc.uri,
    range: rangeOf(found.doc.text, found.start, found.end),
  });

  // --- Diagnostics -------------------------------------------------------------------------
  const publishDiagnostics = (doc: Doc) => {
    const diagnostics: object[] = [];
    for (const match of doc.text.matchAll(/\bTODO\b/g))
      diagnostics.push({
        range: rangeOf(doc.text, match.index ?? 0, (match.index ?? 0) + 4),
        severity: 2,
        source: "fake",
        code: "W1",
        message: "TODO left in code",
      });
    for (const match of doc.text.matchAll(/\berror\b/g))
      diagnostics.push({
        range: rangeOf(doc.text, match.index ?? 0, (match.index ?? 0) + 5),
        severity: 1,
        source: "fake",
        code: "E1",
        message: "Something is wrong",
        tags: [],
        relatedInformation: [
          {
            location: { uri: doc.uri, range: rangeOf(doc.text, 0, 0) },
            message: "Related to the start of the file",
          },
        ],
      });
    const publish = () =>
      send({
        method: "textDocument/publishDiagnostics",
        params: { uri: doc.uri, version: doc.version, diagnostics },
      });
    if (options.diagnosticsDelay) setTimeout(publish, options.diagnosticsDelay);
    else publish();
  };

  // --- Symbols -----------------------------------------------------------------------------
  const symbolsOf = (doc: Doc) => {
    interface Symbol {
      name: string;
      kind: number;
      range: object;
      selectionRange: object;
      children: Symbol[];
      indent: number;
      start: number;
      closed: boolean;
    }
    const roots: Symbol[] = [];
    // A symbol runs from its line to the last line before one indented no deeper (its own
    // closing bracket included), as a real server's range covers the body.
    const stack: Symbol[] = [];
    const finish = (end: number) => {
      const symbol = stack.pop()!;
      symbol.range = rangeOf(doc.text, symbol.start, end);
    };
    const lines = doc.text.split("\n");
    let offset = 0;
    let lastEnd = 0;
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed) {
        const indent = line.length - line.trimStart().length;
        const closer = /^[}\])]/.test(trimmed);
        for (;;) {
          const top = stack[stack.length - 1];
          if (!top || top.indent < indent) break;
          if (closer && top.indent === indent && !top.closed) {
            top.closed = true;
            break;
          }
          finish(lastEnd);
        }
      }
      const match = /^(\s*)(function|def|class)\s+([A-Za-z_]\w*)/.exec(line);
      if (match) {
        const indent = match[1].length;
        const nameStart = offset + match[0].length - match[3].length;
        const symbol: Symbol = {
          name: match[3],
          kind: match[2] === "class" ? 5 : 12,
          range: rangeOf(doc.text, offset, offset + line.length),
          selectionRange: rangeOf(doc.text, nameStart, nameStart + match[3].length),
          children: [],
          indent,
          start: offset,
          closed: false,
        };
        (stack.length ? stack[stack.length - 1].children : roots).push(symbol);
        stack.push(symbol);
      }
      if (trimmed) lastEnd = offset + line.length;
      offset += line.length + 1;
    }
    while (stack.length) finish(lastEnd);
    const strip = (symbols: Symbol[]): object[] =>
      symbols.map(({ name, kind, range, selectionRange, children }) => ({
        name,
        kind,
        range,
        selectionRange,
        children: strip(children),
      }));
    return strip(roots);
  };

  const semanticTokens = (doc: Doc) => {
    const data: number[] = [];
    let previousLine = 0;
    let previousChar = 0;
    for (const match of doc.text.matchAll(WORD)) {
      const start = match.index ?? 0;
      const word = match[0];
      const type = KEYWORDS.has(word)
        ? 0
        : doc.text[start + word.length] === "("
          ? 1
          : /^[A-Z]/.test(word)
            ? 3
            : 2;
      const position = positionAt(doc.text, start);
      const deltaLine = position.line - previousLine;
      const deltaChar = deltaLine ? position.character : position.character - previousChar;
      data.push(deltaLine, deltaChar, word.length, type, 0);
      previousLine = position.line;
      previousChar = position.character;
    }
    return data;
  };

  // --- Requests ----------------------------------------------------------------------------
  const capabilities = () => {
    const all: Record<string, unknown> = {
      positionEncoding: "utf-16",
      textDocumentSync: {
        openClose: true,
        change: options.syncKind ?? 2,
        save: { includeText: false },
      },
      completionProvider: { triggerCharacters: ["."], resolveProvider: true },
      hoverProvider: true,
      signatureHelpProvider: { triggerCharacters: ["("], retriggerCharacters: [","] },
      declarationProvider: true,
      definitionProvider: true,
      typeDefinitionProvider: true,
      implementationProvider: true,
      referencesProvider: true,
      documentSymbolProvider: true,
      workspaceSymbolProvider: true,
      codeActionProvider: { codeActionKinds: ["quickfix", "source"] },
      codeLensProvider: { resolveProvider: true },
      documentLinkProvider: { resolveProvider: false },
      documentFormattingProvider: true,
      documentRangeFormattingProvider: true,
      documentOnTypeFormattingProvider: { firstTriggerCharacter: ";" },
      renameProvider: { prepareProvider: true },
      executeCommandProvider: { commands: ["fake.echo", "fake.applyEdit"] },
      workspace: { workspaceFolders: { supported: true, changeNotifications: true } },
      semanticTokensProvider: {
        legend: { tokenTypes: TOKEN_TYPES, tokenModifiers: ["declaration"] },
        full: { delta: true },
      },
      inlayHintProvider: true,
    };
    for (const name of options.without ?? []) delete all[name];
    return all;
  };

  const formatEdits = (doc: Doc, fromLine = 0, toLine = Number.MAX_SAFE_INTEGER) => {
    const edits: object[] = [];
    const lines = doc.text.split("\n");
    lines.forEach((line, index) => {
      if (index < fromLine || index > toLine) return;
      const trimmed = line.replace(/\t/g, "  ").replace(/\s+$/, "");
      if (trimmed !== line)
        edits.push({
          range: {
            start: { line: index, character: 0 },
            end: { line: index, character: line.length },
          },
          newText: trimmed,
        });
    });
    return edits;
  };

  const handle = (method: string, params: Params): unknown => {
    const doc = params?.textDocument ? docs.get(params.textDocument.uri) : undefined;
    switch (method) {
      case "initialize":
        rootUri = params.rootUri ?? null;
        return { capabilities: capabilities(), serverInfo: { name: "fake-lsp", version: "1.0" } };
      case "shutdown":
        return null;
      case "textDocument/completion": {
        if (!doc) return null;
        const here = wordAt(doc, params.position);
        const range = here
          ? rangeOf(doc.text, here.start, here.end)
          : { start: params.position, end: params.position };
        const words = [...new Set([...doc.text.matchAll(WORD)].map((match) => match[0]))];
        return {
          isIncomplete: false,
          items: [
            {
              label: "fakeFunction",
              kind: 3,
              detail: "fakeFunction(a: number, b: string): void",
              insertTextFormat: 2,
              textEdit: { range, newText: "fakeFunction(${1:a}, ${2:b})" },
              sortText: "0",
              data: { label: "fakeFunction" },
            },
            {
              label: "fakeText",
              kind: 6,
              textEdit: { range, newText: "fakeText" },
              additionalTextEdits: [
                {
                  range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
                  newText: "// uses fakeText\n",
                },
              ],
              sortText: "1",
              commitCharacters: ["."],
            },
            { label: "oldThing", kind: 6, tags: [1], sortText: "2" },
            ...words
              .filter((word) => word !== here?.word)
              .map((word) => ({ label: word, kind: 6, sortText: `3${word}` })),
          ],
        };
      }
      case "completionItem/resolve":
        return params.label === "fakeFunction"
          ? {
              ...params,
              documentation: { kind: "markdown", value: "**fakeFunction** does fake things." },
            }
          : params;
      case "textDocument/hover": {
        const here = doc && wordAt(doc, params.position);
        if (!doc || !here) return null;
        return {
          contents: {
            kind: "markdown",
            value: "```\n" + here.word + "\n```\nA *fake* hover for `" + here.word + "`.",
          },
          range: rangeOf(doc.text, here.start, here.end),
        };
      }
      case "textDocument/definition":
      case "textDocument/declaration":
      case "textDocument/implementation":
      case "textDocument/typeDefinition": {
        const here = doc && wordAt(doc, params.position);
        if (!here) return null;
        const found = declarations(here.word);
        if (method === "textDocument/implementation") return [];
        if (method === "textDocument/typeDefinition")
          return found.map((one) => ({
            targetUri: one.doc.uri,
            targetRange: rangeOf(one.doc.text, one.start, one.end),
            targetSelectionRange: rangeOf(one.doc.text, one.start, one.end),
          }));
        return found.length === 1 ? location(found[0]) : found.map(location);
      }
      case "textDocument/references": {
        const here = doc && wordAt(doc, params.position);
        if (!here) return [];
        const declared = new Set(
          declarations(here.word).map((one) => `${one.doc.uri}@${one.start}`),
        );
        return occurrences(here.word)
          .filter(
            (one) =>
              params.context?.includeDeclaration || !declared.has(`${one.doc.uri}@${one.start}`),
          )
          .map(location);
      }
      case "textDocument/prepareRename": {
        const here = doc && wordAt(doc, params.position);
        if (!doc || !here || KEYWORDS.has(here.word))
          throw { code: -32602, message: "This cannot be renamed." };
        return { range: rangeOf(doc.text, here.start, here.end), placeholder: here.word };
      }
      case "textDocument/rename": {
        const here = doc && wordAt(doc, params.position);
        if (!here) return null;
        const byDoc = new Map<Doc, object[]>();
        for (const one of occurrences(here.word))
          byDoc.set(one.doc, [
            ...(byDoc.get(one.doc) ?? []),
            { range: rangeOf(one.doc.text, one.start, one.end), newText: params.newName },
          ]);
        return {
          documentChanges: [...byDoc].map(([target, edits]) => ({
            textDocument: { uri: target.uri, version: target.version },
            edits,
          })),
        };
      }
      case "textDocument/formatting":
        return doc ? formatEdits(doc) : [];
      case "textDocument/rangeFormatting":
        return doc ? formatEdits(doc, params.range.start.line, params.range.end.line) : [];
      case "textDocument/onTypeFormatting": {
        if (!doc) return [];
        const line = doc.text.split("\n")[params.position.line] ?? "";
        const fixed = line.replace(/\s+;/g, ";");
        return fixed === line
          ? []
          : [
              {
                range: {
                  start: { line: params.position.line, character: 0 },
                  end: { line: params.position.line, character: line.length },
                },
                newText: fixed,
              },
            ];
      }
      case "textDocument/codeAction": {
        if (!doc) return [];
        const actions: object[] = [];
        for (const diagnostic of params.context?.diagnostics ?? [])
          if (diagnostic.message === "TODO left in code")
            actions.push({
              title: "Replace TODO with DONE",
              kind: "quickfix",
              diagnostics: [diagnostic],
              isPreferred: true,
              edit: {
                documentChanges: [
                  {
                    textDocument: { uri: doc.uri, version: doc.version },
                    edits: [{ range: diagnostic.range, newText: "DONE" }],
                  },
                ],
              },
            });
        actions.push({
          title: "Echo from the server",
          kind: "source",
          command: { title: "Echo", command: "fake.echo", arguments: ["hello"] },
        });
        return actions;
      }
      case "workspace/executeCommand":
        if (params.command === "fake.echo") return { echoed: params.arguments ?? [] };
        if (params.command === "fake.applyEdit") {
          const target = docs.values().next().value as Doc | undefined;
          if (!target) return null;
          const id = `s${nextServerRequest++}`;
          send({
            id,
            method: "workspace/applyEdit",
            params: {
              label: "Fake edit",
              edit: {
                changes: {
                  [target.uri]: [
                    {
                      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
                      newText: "// applied\n",
                    },
                  ],
                },
              },
            },
          });
          return new Promise((resolve) => waitingOnClient.set(id, resolve));
        }
        throw { code: -32601, message: `Unknown command ${params.command}` };
      case "textDocument/documentSymbol":
        return doc ? symbolsOf(doc) : [];
      case "workspace/symbol": {
        const query = String(params.query ?? "").toLowerCase();
        const found: object[] = [];
        for (const target of docs.values())
          for (const match of target.text.matchAll(/\b(function|def|class)\s+([A-Za-z_]\w*)/g)) {
            if (!match[2].toLowerCase().includes(query)) continue;
            const start = (match.index ?? 0) + match[0].length - match[2].length;
            found.push({
              name: match[2],
              kind: match[1] === "class" ? 5 : 12,
              location: {
                uri: target.uri,
                range: rangeOf(target.text, start, start + match[2].length),
              },
            });
          }
        return found;
      }
      case "textDocument/signatureHelp": {
        if (!doc) return null;
        const offset = offsetAt(doc.text, params.position);
        const before = doc.text.slice(0, offset);
        const call = before.lastIndexOf("fakeFunction(");
        if (call < 0 || before.slice(call).includes(")")) return null;
        const activeParameter = (before.slice(call).match(/,/g) ?? []).length;
        return {
          signatures: [
            {
              label: "fakeFunction(a: number, b: string): void",
              documentation: "Does fake things.",
              parameters: [
                { label: [13, 22], documentation: "The number." },
                { label: [24, 33], documentation: "The string." },
              ],
            },
          ],
          activeSignature: 0,
          activeParameter,
        };
      }
      case "textDocument/documentLink": {
        if (!doc) return [];
        const folder = doc.uri.slice(0, doc.uri.lastIndexOf("/") + 1);
        return [...doc.text.matchAll(/["'](\.\/[^"']+)["']/g)].map((match) => ({
          range: rangeOf(
            doc.text,
            (match.index ?? 0) + 1,
            (match.index ?? 0) + 1 + match[1].length,
          ),
          target: folder + match[1].slice(2),
          tooltip: "Open the imported file",
        }));
      }
      case "textDocument/semanticTokens/full": {
        if (!doc) return null;
        const data = semanticTokens(doc);
        const resultId = String(++semanticResult);
        previousTokens.set(resultId, data);
        return { resultId, data };
      }
      case "textDocument/semanticTokens/full/delta": {
        if (!doc) return null;
        const data = semanticTokens(doc);
        const old = previousTokens.get(params.previousResultId);
        const resultId = String(++semanticResult);
        previousTokens.set(resultId, data);
        if (!old) return { resultId, data };
        return { resultId, edits: [{ start: 0, deleteCount: old.length, data }] };
      }
      case "textDocument/inlayHint": {
        if (!doc) return [];
        const hints: object[] = [];
        for (const match of doc.text.matchAll(
          /\b(let|const)\s+([A-Za-z_]\w*)\s*=\s*(\d+|"[^"]*")/g,
        )) {
          const end = (match.index ?? 0) + match[1].length + 1 + match[2].length;
          hints.push({
            position: positionAt(doc.text, end),
            label: match[3].startsWith('"') ? ": string" : ": number",
            kind: 1,
          });
        }
        for (const match of doc.text.matchAll(/fakeFunction\(([^,)]+),\s*([^)]+)\)/g)) {
          const first = (match.index ?? 0) + "fakeFunction(".length;
          hints.push({
            position: positionAt(doc.text, first),
            label: "a:",
            kind: 2,
            paddingRight: true,
          });
        }
        return hints;
      }
      case "textDocument/codeLens":
        return doc
          ? [...doc.text.matchAll(/\b(function|def)\s+([A-Za-z_]\w*)/g)].map((match) => ({
              range: rangeOf(doc.text, match.index ?? 0, (match.index ?? 0) + match[0].length),
              data: { name: match[2] },
            }))
          : [];
      case "codeLens/resolve": {
        const name = params.data?.name ?? "";
        const count = occurrences(name).length - 1;
        return {
          ...params,
          command: {
            title: `${count} reference${count === 1 ? "" : "s"}`,
            command: "fake.echo",
            arguments: [name],
          },
        };
      }
      default:
        throw { code: -32601, message: `Unhandled method ${method}` };
    }
  };

  const notify = (method: string, params: Params) => {
    switch (method) {
      case "initialized":
        send({ method: "window/logMessage", params: { type: 3, message: "fake server ready" } });
        // Ask for configuration, as real servers do.
        send({
          id: `s${nextServerRequest++}`,
          method: "workspace/configuration",
          params: { items: [{ section: "fake" }] },
        });
        // And to hear about files: TypeScript sources anywhere, JSON created in the root.
        send({
          id: `s${nextServerRequest++}`,
          method: "client/registerCapability",
          params: {
            registrations: [
              {
                id: "watch-sources",
                method: "workspace/didChangeWatchedFiles",
                registerOptions: {
                  watchers: [
                    { globPattern: "**/*.ts" },
                    ...(rootUri
                      ? [{ globPattern: { baseUri: rootUri, pattern: "*.json" }, kind: 1 }]
                      : []),
                  ],
                },
              },
            ],
          },
        });
        return;
      case "exit":
        exit(0);
        return;
      case "textDocument/didOpen": {
        const item = params.textDocument;
        const doc = {
          uri: item.uri,
          text: item.text,
          version: item.version,
          languageId: item.languageId,
        };
        docs.set(item.uri, doc);
        publishDiagnostics(doc);
        return;
      }
      case "textDocument/didChange": {
        const doc = docs.get(params.textDocument.uri);
        if (!doc) return;
        for (const change of params.contentChanges) {
          if (!change.range) doc.text = change.text;
          else {
            const start = offsetAt(doc.text, change.range.start);
            const end = offsetAt(doc.text, change.range.end);
            doc.text = doc.text.slice(0, start) + change.text + doc.text.slice(end);
          }
        }
        doc.version = params.textDocument.version;
        publishDiagnostics(doc);
        return;
      }
      case "textDocument/didClose":
        docs.delete(params.textDocument.uri);
        send({
          method: "textDocument/publishDiagnostics",
          params: { uri: params.textDocument.uri, diagnostics: [] },
        });
        return;
      default:
        return;
    }
  };

  return {
    /** A message from the client. */
    receive(text: string) {
      if (exited) return;
      const message = JSON.parse(text);
      if (message.method === "$/cancelRequest") {
        cancelled.add(message.params.id);
        received.push({ method: message.method, params: message.params });
        return;
      }
      if (message.method === undefined) {
        // A response to one of this server's own requests.
        waitingOnClient.get(message.id)?.(message.result ?? message.error);
        waitingOnClient.delete(message.id);
        return;
      }
      received.push({ method: message.method, params: message.params });
      if (options.crashOn === message.method) {
        exit(1);
        return;
      }
      if (message.id === undefined) {
        notify(message.method, message.params);
        return;
      }
      if (options.silent?.includes(message.method)) return;
      const answer = async () => {
        const delay = options.delays?.[message.method] ?? 0;
        if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
        if (cancelled.has(message.id)) {
          send({ id: message.id, error: { code: -32800, message: "Request cancelled" } });
          return;
        }
        try {
          send({ id: message.id, result: (await handle(message.method, message.params)) ?? null });
        } catch (error) {
          const failure = error as { code?: number; message?: string };
          send({
            id: message.id,
            error: { code: failure.code ?? -32603, message: failure.message ?? String(error) },
          });
        }
      };
      void answer();
    },
    /** What the server holds for a document: the test of synchronization. */
    document: (uri: string) => docs.get(uri),
    documents: () => [...docs.values()],
    /** Every message received, method and params, in order. */
    received,
    /** Knobs a test turns while the server runs. */
    options,
    crash: (code = 1) => exit(code),
    sendRaw: (text: string) => {
      if (!exited) io.send(text);
    },
    /** Publishes diagnostics now, for any document, as a server does after background work. */
    publish: (params: object) => send({ method: "textDocument/publishDiagnostics", params }),
  };
}

export type FakeServer = ReturnType<typeof createFakeServer>;
