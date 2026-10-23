  // --- The VS Code compatibility layer (EXT-25) -------------------------------------------------
  //
  // Part of the bootstrap (runtime.rs puts it here), used only for an extension Yavin installed
  // from a VS Code package: its code is loaded as CommonJS modules, and `require("vscode")` is
  // the object below -- the VS Code API mapped onto the same protocol requests every extension
  // makes. Nothing here is a boundary: Yavin checks every request natively and in the window, as
  // for any extension (ownership, permissions the user granted, the workspace). What Yavin does
  // not provide fails with an `UnsupportedApi` error that names it, and is logged once; nothing
  // pretends to work. What it provides and how far is listed in
  // `src/services/extensions/vscodeApi.json`, which the host's tests check against this file.
  function vscodeRuntime(meta, modules, mainPath, mainSource) {
    const LEVEL = meta.level || "1.90.0";
    // Node's globals, as far as they are computation: `process` knows no environment and cannot
    // reach the system; `Buffer` does not exist.
    globalThis.global = globalThis;
    globalThis.self = globalThis;
    // Web bundles (webpack's `target: "webworker"`) find their own URL from `location` and load
    // further chunks with `importScripts`: the URL is the entry point's; loading chunks is not
    // supported (each extension is loaded as its package's files).
    globalThis.location = Object.freeze({
      href: `file:///${String(init.extensionPath || "").replace(/\\/g, "/")}/${mainPath}`,
      protocol: "file:",
      toString() {
        return this.href;
      },
    });
    globalThis.importScripts = function () {
      throw unsupported("importScripts", "an extension's code is its package's files, loaded as modules");
    };
    const processEvents = new Map();
    globalThis.process = {
      platform: "win32",
      arch: "x64",
      env: {},
      argv: [],
      execArgv: [],
      version: "",
      versions: {},
      release: { name: "yavin" },
      nextTick: (fn, ...args) => queueMicrotask(() => fn(...args)),
      hrtime: Object.assign(
        (previous) => {
          const now = Date.now();
          const seconds = Math.floor(now / 1000);
          const nanos = (now % 1000) * 1e6;
          return previous ? [seconds - previous[0], nanos - previous[1]] : [seconds, nanos];
        },
        { bigint: () => BigInt(Date.now()) * 1000000n },
      ),
      uptime: () => 0,
      emitWarning: (warning) => post({ type: "log", level: "warn", text: String(warning && warning.message ? warning.message : warning) }),
      on(name, fn) {
        processEvents.set(name, fn);
        return globalThis.process;
      },
      once(name, fn) {
        return globalThis.process.on(name, fn);
      },
      off() {
        return globalThis.process;
      },
      removeListener() {
        return globalThis.process;
      },
      removeAllListeners() {
        return globalThis.process;
      },
      emit: () => false,
      listenerCount: () => 0,
      stdout: { write: (text) => (post({ type: "log", level: "info", text: String(text) }), true) },
      stderr: { write: (text) => (post({ type: "log", level: "warn", text: String(text) }), true) },
    };
    for (const name of ["cwd", "exit", "kill", "chdir", "memoryUsage", "cpuUsage", "umask", "binding", "dlopen"])
      globalThis.process[name] = function () {
        throw unsupported(`Node.js process.${name}`, "Yavin's extension host has no Node.js");
      };
    for (const name of ["pid", "ppid", "execPath", "title"])
      Object.defineProperty(globalThis.process, name, {
        get() {
          throw unsupported(`Node.js process.${name}`, "Yavin's extension host has no Node.js");
        },
      });
    const reported = new Set();
    /** The error for an API Yavin does not provide (logged once per API). */
    const unsupported = (what, why) => {
      const message = `UnsupportedApi: ${what} is not supported by Yavin${why ? ` (${why})` : ""}.`;
      if (!reported.has(what)) {
        reported.add(what);
        post({ type: "log", level: "warn", text: message });
      }
      const error = new Error(message);
      error.name = "UnsupportedApi";
      error.code = "UnsupportedApi";
      return error;
    };
    // EXT-28: the Web platform's globals and Intl's used part, where the engine has none.
    const web = typeof webRuntime === "function" ? webRuntime({ random, unsupported, report: (text) => post({ type: "log", level: "error", text }) }) : null;
    if (typeof intlRuntime === "function") intlRuntime({ unsupported });
    // Marked, so the inventory's test can tell an unsupported member from a provided one.
    const UNSUPPORTED = Symbol.for("yavin.unsupported");
    const mark = (fn, what) => Object.defineProperty(fn, UNSUPPORTED, { value: what });
    const unsupportedFn = (what, why) =>
      mark(function () {
        throw unsupported(what, why);
      }, what);
    const unsupportedAsync = (what, why) => mark(() => Promise.reject(unsupported(what, why)), what);
    const throwingGetter = (object, name, what, why) =>
      Object.defineProperty(object, name, {
        enumerable: true,
        configurable: true,
        get() {
          throw unsupported(what, why);
        },
      });
    // Members a module-interop helper probes: never "unsupported", only absent.
    const PROBED = new Set(["__esModule", "default", "then", "toJSON", "constructor", "prototype", "inspect", "valueOf", "toString", "$$typeof", "length", "name", "nodeType"]);
    /** `object`, where every member it does not have fails with `UnsupportedApi` when used. */
    const guarded = (object, prefix) =>
      new Proxy(object, {
        get(target, key) {
          if (typeof key === "symbol" || key in target) return target[key];
          if (PROBED.has(key)) return undefined;
          return unsupportedFn(`${prefix}.${key}`);
        },
      });

    // --- Pure types --------------------------------------------------------------------------------
    class Position {
      constructor(line, character) {
        if (!(line >= 0) || !(character >= 0)) throw new Error("Illegal argument: line and character must be non-negative");
        this.line = line;
        this.character = character;
      }
      isBefore(o) { return this.line < o.line || (this.line === o.line && this.character < o.character); }
      isBeforeOrEqual(o) { return this.isBefore(o) || this.isEqual(o); }
      isAfter(o) { return !this.isBeforeOrEqual(o); }
      isAfterOrEqual(o) { return !this.isBefore(o); }
      isEqual(o) { return this.line === o.line && this.character === o.character; }
      compareTo(o) { return this.isBefore(o) ? -1 : this.isEqual(o) ? 0 : 1; }
      translate(a, b) {
        if (a && typeof a === "object") return this.translate(a.lineDelta || 0, a.characterDelta || 0);
        return new Position(this.line + (a || 0), this.character + (b || 0));
      }
      with(a, b) {
        if (a && typeof a === "object") return new Position(a.line ?? this.line, a.character ?? this.character);
        return new Position(a ?? this.line, b ?? this.character);
      }
      toJSON() { return { line: this.line, character: this.character }; }
    }
    const isPosition = (p) => p && typeof p.line === "number" && typeof p.character === "number";
    class Range {
      constructor(a, b, c, d) {
        let start = a, end = b;
        if (typeof a === "number") {
          start = new Position(a, b);
          end = new Position(c, d);
        }
        if (!isPosition(start) || !isPosition(end)) throw new Error("Illegal argument: a range needs two positions");
        if (end.line < start.line || (end.line === start.line && end.character < start.character)) [start, end] = [end, start];
        this.start = start instanceof Position ? start : new Position(start.line, start.character);
        this.end = end instanceof Position ? end : new Position(end.line, end.character);
      }
      get isEmpty() { return this.start.isEqual(this.end); }
      get isSingleLine() { return this.start.line === this.end.line; }
      contains(x) {
        if (x instanceof Range || (x && x.start && x.end)) return this.contains(x.start) && this.contains(x.end);
        return !new Position(x.line, x.character).isBefore(this.start) && !this.end.isBefore(x);
      }
      isEqual(o) { return this.start.isEqual(o.start) && this.end.isEqual(o.end); }
      intersection(o) {
        const start = this.start.isAfter(o.start) ? this.start : o.start;
        const end = this.end.isBefore(o.end) ? this.end : o.end;
        return start.isAfter(end) ? undefined : new Range(start, end);
      }
      union(o) {
        return new Range(this.start.isBefore(o.start) ? this.start : o.start, this.end.isAfter(o.end) ? this.end : o.end);
      }
      with(a, b) {
        if (a && !isPosition(a) && typeof a === "object") return new Range(a.start ?? this.start, a.end ?? this.end);
        return new Range(a ?? this.start, b ?? this.end);
      }
      toJSON() { return { start: this.start.toJSON(), end: this.end.toJSON() }; }
    }
    class Selection extends Range {
      constructor(a, b, c, d) {
        let anchor = a, active = b;
        if (typeof a === "number") {
          anchor = new Position(a, b);
          active = new Position(c, d);
        }
        super(anchor, active);
        this.anchor = anchor instanceof Position ? anchor : new Position(anchor.line, anchor.character);
        this.active = active instanceof Position ? active : new Position(active.line, active.character);
      }
      get isReversed() { return this.anchor.isAfter(this.active); }
    }
    class Location {
      constructor(uri, rangeOrPosition) {
        this.uri = uri;
        this.range = isPosition(rangeOrPosition) ? new Range(rangeOrPosition, rangeOrPosition) : rangeOrPosition;
      }
    }

    // URIs: as VS Code's, except that a file URI's drive keeps its colon (`file:///C:/a`), as
    // Yavin spells them -- a string from `toString()` names the same document to Yavin.
    const encodeSegment = (text) => encodeURIComponent(text).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
    class Uri {
      constructor(scheme, authority, path, query, fragment) {
        this.scheme = scheme || "file";
        this.authority = authority || "";
        this.path = path || "";
        this.query = query || "";
        this.fragment = fragment || "";
        if (this.path && !this.path.startsWith("/") && (this.authority || this.scheme === "file")) this.path = "/" + this.path;
      }
      static parse(value) {
        const match = /^(([^:/?#]+?):)?(\/\/([^/?#]*))?([^?#]*)(\?([^#]*))?(#(.*))?/.exec(String(value));
        if (!match || !match[2]) throw new Error(`[UriError]: Scheme is missing: {scheme: "", path: "${value}"}`);
        const decode = (text) => {
          try {
            return decodeURIComponent(text);
          } catch {
            return text;
          }
        };
        return new Uri(match[2], decode(match[4] || ""), decode(match[5] || ""), decode(match[7] || ""), decode(match[9] || ""));
      }
      static file(fsPath) {
        let path = String(fsPath).replace(/\\/g, "/");
        let authority = "";
        if (path.startsWith("//")) {
          const cut = path.indexOf("/", 2);
          authority = cut < 0 ? path.slice(2) : path.slice(2, cut);
          path = cut < 0 ? "/" : path.slice(cut);
        }
        if (!path.startsWith("/")) path = "/" + path;
        return new Uri("file", authority, path, "", "");
      }
      static joinPath(base, ...segments) {
        if (!base.path) throw new Error("[UriError]: cannot call joinPath on URI without path");
        return base.with({ path: posix.join(base.path, ...segments) });
      }
      static from(parts) {
        return new Uri(parts.scheme, parts.authority, parts.path, parts.query, parts.fragment);
      }
      static isUri(thing) {
        return thing instanceof Uri;
      }
      get fsPath() {
        let path = this.path;
        if (this.authority && path.length > 1 && this.scheme === "file") path = `//${this.authority}${path}`;
        else if (/^\/[A-Za-z]:/.test(path)) path = path[1].toLowerCase() + path.slice(2);
        return path.replace(/\//g, "\\");
      }
      with(change) {
        return new Uri(
          change.scheme ?? this.scheme,
          change.authority ?? this.authority,
          change.path ?? this.path,
          change.query ?? this.query,
          change.fragment ?? this.fragment,
        );
      }
      toString(skipEncoding) {
        const encode = skipEncoding ? (s) => s : encodeSegment;
        const drive = /^\/[A-Za-z]:(\/|$)/.test(this.path);
        const path = this.path
          .split("/")
          .map((segment, index) => (drive && index === 1 ? segment : encode(segment)))
          .join("/");
        let out = `${this.scheme}:`;
        if (this.authority || this.scheme === "file") out += `//${encode(this.authority)}`;
        out += path;
        if (this.query) out += `?${encode(this.query)}`;
        if (this.fragment) out += `#${encode(this.fragment)}`;
        return out;
      }
      toJSON() {
        return { $mid: 1, scheme: this.scheme, authority: this.authority, path: this.path, query: this.query, fragment: this.fragment, fsPath: this.fsPath, external: this.toString() };
      }
    }
    /** A URI as Yavin names it (Yavin's canonical spelling, from a Uri or a string). */
    const uriText = (uri) => (uri instanceof Uri ? uri.toString() : Uri.parse(String(uri)).toString());
    const uriOf = (text) => Uri.parse(text);

    class Disposable {
      constructor(callOnDispose) {
        this._dispose = callOnDispose;
      }
      static from(...items) {
        return new Disposable(() => {
          for (const item of items) if (item && typeof item.dispose === "function") item.dispose();
        });
      }
      dispose() {
        if (typeof this._dispose === "function") {
          const run = this._dispose;
          this._dispose = undefined;
          run();
        }
      }
    }
    class EventEmitter {
      constructor() {
        this._listeners = [];
        this.event = (listener, thisArg, disposables) => {
          const entry = { listener, thisArg };
          this._listeners.push(entry);
          const result = new Disposable(() => {
            const at = this._listeners.indexOf(entry);
            if (at >= 0) this._listeners.splice(at, 1);
          });
          if (Array.isArray(disposables)) disposables.push(result);
          return result;
        };
      }
      fire(data) {
        for (const { listener, thisArg } of [...this._listeners]) {
          try {
            listener.call(thisArg, data);
          } catch (error) {
            log("error")(`An event listener threw: ${error && error.message}`);
          }
        }
      }
      dispose() {
        this._listeners = [];
      }
    }
    /** An event that never fires: what it is about cannot happen in Yavin (said where used). */
    const never = (listener, thisArg, disposables) => {
      const result = new Disposable(() => {});
      if (Array.isArray(disposables)) disposables.push(result);
      return result;
    };
    class CancellationError extends Error {
      constructor() {
        super("Canceled");
        this.name = "Canceled";
      }
    }
    const neverCancelled = Object.freeze({ isCancellationRequested: false, onCancellationRequested: never });
    class CancellationTokenSource {
      constructor() {
        const emitter = new EventEmitter();
        this._emitter = emitter;
        const token = { isCancellationRequested: false };
        // As VS Code's: a listener added once cancelled is still called (soon, not synchronously).
        token.onCancellationRequested = (listener, thisArg, disposables) => {
          if (!token.isCancellationRequested) return emitter.event(listener, thisArg, disposables);
          const timer = setTimeout(() => listener.call(thisArg, undefined), 0);
          const result = new Disposable(() => clearTimeout(timer));
          if (Array.isArray(disposables)) disposables.push(result);
          return result;
        };
        this.token = token;
      }
      cancel() {
        if (!this.token.isCancellationRequested) {
          this.token.isCancellationRequested = true;
          this._emitter.fire(undefined);
        }
      }
      dispose() {
        this._emitter.dispose();
      }
    }
    class MarkdownString {
      constructor(value, supportThemeIcons) {
        this.value = value || "";
        this.supportThemeIcons = !!supportThemeIcons;
        this.isTrusted = undefined;
        this.supportHtml = false;
      }
      appendText(text) {
        this.value += String(text).replace(/[\\`*_{}[\]()#+\-.!<>]/g, "\\$&");
        return this;
      }
      appendMarkdown(text) {
        this.value += text;
        return this;
      }
      appendCodeblock(code, language) {
        this.value += "\n```" + (language || "") + "\n" + code + "\n```\n";
        return this;
      }
    }
    class SnippetString {
      constructor(value) {
        this.value = value || "";
        this._tab = 1;
      }
      appendText(text) {
        this.value += String(text).replace(/[$}\\]/g, "\\$&");
        return this;
      }
      appendTabstop(n) {
        this.value += "$" + (n ?? this._tab++);
        return this;
      }
      appendPlaceholder(value, n) {
        const inner = typeof value === "function" ? (value(new SnippetString()), "") : String(value).replace(/[$}\\]/g, "\\$&");
        this.value += "${" + (n ?? this._tab++) + ":" + inner + "}";
        return this;
      }
      appendChoice(values, n) {
        this.value += "${" + (n ?? this._tab++) + "|" + values.join(",") + "|}";
        return this;
      }
      appendVariable(name, fallback) {
        this.value += "${" + name + (fallback === undefined ? "" : ":" + fallback) + "}";
        return this;
      }
    }
    /** Snippet text as the plain text Yavin inserts: tabstops gone, placeholders as their text. */
    const snippetText = (snippet) => {
      let text = String(snippet);
      for (let i = 0; i < 5; i++) text = text.replace(/\$\{\d+:([^${}]*)\}/g, "$1").replace(/\$\{\d+\|([^,|]*)[^|]*\|\}/g, "$1");
      return text.replace(/\$\{\d+\}|\$\d+/g, "").replace(/\\([$}\\])/g, "$1");
    };
    const enumOf = (names, start = 0) => {
      const out = {};
      names.forEach((name, i) => {
        if (name) {
          out[name] = i + start;
          out[i + start] = name;
        }
      });
      return Object.freeze(out);
    };
    const CompletionItemKind = enumOf(["Text", "Method", "Function", "Constructor", "Field", "Variable", "Class", "Interface", "Module", "Property", "Unit", "Value", "Enum", "Keyword", "Snippet", "Color", "File", "Reference", "Folder", "EnumMember", "Constant", "Struct", "Event", "Operator", "TypeParameter", "User", "Issue"]);
    class CompletionItem {
      constructor(label, kind) {
        this.label = label;
        this.kind = kind;
      }
    }
    class CompletionList {
      constructor(items, isIncomplete) {
        this.items = items || [];
        this.isIncomplete = !!isIncomplete;
      }
    }
    class Hover {
      constructor(contents, range) {
        this.contents = Array.isArray(contents) ? contents : [contents];
        this.range = range;
      }
    }
    const EndOfLine = Object.freeze({ LF: 1, CRLF: 2, 1: "LF", 2: "CRLF" });
    class TextEdit {
      constructor(range, newText) {
        this.range = range;
        this.newText = newText;
      }
      static replace(range, newText) { return new TextEdit(range, newText); }
      static insert(position, newText) { return new TextEdit(new Range(position, position), newText); }
      static delete(range) { return new TextEdit(range, ""); }
      static setEndOfLine() { throw unsupported("TextEdit.setEndOfLine"); }
    }
    class WorkspaceEdit {
      constructor() {
        this._edits = new Map();
        this._files = [];
      }
      _list(uri) {
        const key = uriText(uri);
        if (!this._edits.has(key)) this._edits.set(key, { uri, edits: [] });
        return this._edits.get(key).edits;
      }
      replace(uri, range, newText) { this._list(uri).push(new TextEdit(range, newText)); }
      insert(uri, position, newText) { this._list(uri).push(TextEdit.insert(position, newText)); }
      delete(uri, range) { this._list(uri).push(TextEdit.delete(range)); }
      set(uri, edits) {
        const list = this._list(uri);
        list.length = 0;
        for (const one of edits || []) list.push(Array.isArray(one) ? one[0] : one);
      }
      has(uri) { return this._edits.has(uriText(uri)); }
      get(uri) { return this._edits.has(uriText(uri)) ? [...this._edits.get(uriText(uri)).edits] : []; }
      entries() { return [...this._edits.values()].map((one) => [one.uri, [...one.edits]]); }
      get size() { return this._edits.size + this._files.length; }
      createFile(uri) { this._files.push(["createFile", uri]); }
      deleteFile(uri) { this._files.push(["deleteFile", uri]); }
      renameFile(from, to) { this._files.push(["renameFile", from, to]); }
    }
    const DiagnosticSeverity = enumOf(["Error", "Warning", "Information", "Hint"]);
    class Diagnostic {
      constructor(range, message, severity) {
        this.range = range;
        this.message = message;
        this.severity = severity ?? DiagnosticSeverity.Error;
      }
    }
    class DiagnosticRelatedInformation {
      constructor(location, message) {
        this.location = location;
        this.message = message;
      }
    }
    const SymbolKind = enumOf(["File", "Module", "Namespace", "Package", "Class", "Method", "Property", "Field", "Constructor", "Enum", "Interface", "Function", "Variable", "Constant", "String", "Number", "Boolean", "Array", "Object", "Key", "Null", "EnumMember", "Struct", "Event", "Operator", "TypeParameter"]);
    class DocumentSymbol {
      constructor(name, detail, kind, range, selectionRange) {
        this.name = name;
        this.detail = detail;
        this.kind = kind;
        this.range = range;
        this.selectionRange = selectionRange;
        this.children = [];
      }
    }
    class SymbolInformation {
      constructor(name, kind, a, b, c) {
        this.name = name;
        this.kind = kind;
        if (a instanceof Location) {
          this.location = a;
          this.containerName = b;
        } else {
          this.containerName = a;
          this.location = new Location(c, b);
        }
      }
    }
    class ThemeColor {
      constructor(id) {
        this.id = id;
      }
    }
    class ThemeIcon {
      constructor(id, color) {
        this.id = id;
        this.color = color;
      }
    }
    ThemeIcon.File = new ThemeIcon("file");
    ThemeIcon.Folder = new ThemeIcon("folder");
    const TreeItemCollapsibleState = enumOf(["None", "Collapsed", "Expanded"]);
    class TreeItem {
      constructor(labelOrUri, collapsibleState) {
        if (labelOrUri instanceof Uri) this.resourceUri = labelOrUri;
        else this.label = labelOrUri;
        this.collapsibleState = collapsibleState ?? TreeItemCollapsibleState.None;
      }
    }
    class RelativePattern {
      constructor(base, pattern) {
        this.baseUri = base instanceof Uri ? base : base && base.uri ? base.uri : Uri.file(String(base));
        this.base = this.baseUri.fsPath;
        this.pattern = pattern;
      }
    }
    class FileSystemError extends Error {
      constructor(message, code) {
        super(message instanceof Uri ? message.toString() : String(message || ""));
        this.code = code || "Unknown";
      }
    }
    for (const name of ["FileNotFound", "FileExists", "FileNotADirectory", "FileIsADirectory", "NoPermissions", "Unavailable"])
      FileSystemError[name] = (message) => new FileSystemError(message, name);
    const CodeActionKind = (() => {
      class Kind {
        constructor(value) {
          this.value = value;
        }
        append(part) { return new Kind(this.value ? `${this.value}.${part}` : part); }
        contains(other) { return this.value === other.value || other.value.startsWith(this.value + "."); }
        intersects(other) { return this.contains(other) || other.contains(this); }
      }
      for (const [name, value] of [["Empty", ""], ["QuickFix", "quickfix"], ["Refactor", "refactor"], ["RefactorExtract", "refactor.extract"], ["RefactorInline", "refactor.inline"], ["RefactorMove", "refactor.move"], ["RefactorRewrite", "refactor.rewrite"], ["Source", "source"], ["SourceOrganizeImports", "source.organizeImports"], ["SourceFixAll", "source.fixAll"], ["Notebook", "notebook"]])
        Kind[name] = new Kind(value);
      return Kind;
    })();
    class CodeAction {
      constructor(title, kind) {
        this.title = title;
        this.kind = kind;
      }
    }
    class CodeLens {
      constructor(range, command) {
        this.range = range;
        this.command = command;
      }
      get isResolved() { return !!this.command; }
    }
    class DocumentLink {
      constructor(range, target) {
        this.range = range;
        this.target = target;
      }
    }
    class Color {
      constructor(red, green, blue, alpha) {
        Object.assign(this, { red, green, blue, alpha });
      }
    }
    class ColorInformation {
      constructor(range, color) {
        Object.assign(this, { range, color });
      }
    }
    class ColorPresentation {
      constructor(label) {
        this.label = label;
      }
    }
    class FoldingRange {
      constructor(start, end, kind) {
        Object.assign(this, { start, end, kind });
      }
    }
    class SelectionRange {
      constructor(range, parent) {
        Object.assign(this, { range, parent });
      }
    }
    class SignatureHelp {
      constructor() {
        this.signatures = [];
        this.activeSignature = 0;
        this.activeParameter = 0;
      }
    }
    class SignatureInformation {
      constructor(label, documentation) {
        Object.assign(this, { label, documentation, parameters: [] });
      }
    }
    class ParameterInformation {
      constructor(label, documentation) {
        Object.assign(this, { label, documentation });
      }
    }
    class InlayHint {
      constructor(position, label, kind) {
        Object.assign(this, { position, label, kind });
      }
    }
    class DocumentHighlight {
      constructor(range, kind) {
        Object.assign(this, { range, kind: kind ?? 0 });
      }
    }
    // Data classes whose providers Yavin does not run: present, so code that builds or subclasses
    // them (vscode-languageclient does) loads; registering their providers is what fails.
    class CallHierarchyItem {
      constructor(kind, name, detail, uri, range, selectionRange) {
        Object.assign(this, { kind, name, detail, uri, range, selectionRange });
      }
    }
    class CallHierarchyIncomingCall {
      constructor(from, fromRanges) {
        Object.assign(this, { from, fromRanges });
      }
    }
    class CallHierarchyOutgoingCall {
      constructor(to, fromRanges) {
        Object.assign(this, { to, fromRanges });
      }
    }
    class TypeHierarchyItem {
      constructor(kind, name, detail, uri, range, selectionRange) {
        Object.assign(this, { kind, name, detail, uri, range, selectionRange });
      }
    }
    class InlayHintLabelPart {
      constructor(value) {
        this.value = value;
      }
    }
    class InlineValueText {
      constructor(range, text) {
        Object.assign(this, { range, text });
      }
    }
    class InlineValueVariableLookup {
      constructor(range, variableName, caseSensitiveLookup = true) {
        Object.assign(this, { range, variableName, caseSensitiveLookup });
      }
    }
    class InlineValueEvaluatableExpression {
      constructor(range, expression) {
        Object.assign(this, { range, expression });
      }
    }
    class EvaluatableExpression {
      constructor(range, expression) {
        Object.assign(this, { range, expression });
      }
    }
    class InlineCompletionItem {
      constructor(insertText, range, command) {
        Object.assign(this, { insertText, range, command });
      }
    }
    class InlineCompletionList {
      constructor(items) {
        this.items = items;
      }
    }
    class LinkedEditingRanges {
      constructor(ranges, wordPattern) {
        Object.assign(this, { ranges, wordPattern });
      }
    }
    class SemanticTokens {
      constructor(data, resultId) {
        Object.assign(this, { data, resultId });
      }
    }
    class SemanticTokensEdit {
      constructor(start, deleteCount, data) {
        Object.assign(this, { start, deleteCount, data });
      }
    }
    class SemanticTokensEdits {
      constructor(edits, resultId) {
        Object.assign(this, { edits, resultId });
      }
    }
    class SemanticTokensBuilder {
      constructor(legend) {
        this._legend = legend;
        this._data = [];
        this._line = 0;
        this._char = 0;
      }
      push(line, char, length, type, modifiers = 0) {
        if (line && typeof line === "object") throw unsupported("SemanticTokensBuilder.push(range, …)");
        this._data.push(line - this._line, line === this._line ? char - this._char : char, length, type, modifiers);
        this._line = line;
        this._char = char;
      }
      build(resultId) {
        return new SemanticTokens(new Uint32Array(this._data), resultId);
      }
    }
    class DocumentDropEdit {
      constructor(insertText) {
        this.insertText = insertText;
      }
    }
    class SnippetTextEdit {
      constructor(range, snippet) {
        Object.assign(this, { range, snippet });
      }
    }
    class SemanticTokensLegend {
      constructor(tokenTypes, tokenModifiers) {
        this.tokenTypes = tokenTypes;
        this.tokenModifiers = tokenModifiers || [];
      }
    }
    const enums = {
      CompletionItemKind,
      CompletionItemTag: enumOf([undefined, "Deprecated"]),
      CompletionTriggerKind: enumOf(["Invoke", "TriggerCharacter", "TriggerForIncompleteCompletions"]),
      DiagnosticSeverity,
      DiagnosticTag: enumOf([undefined, "Unnecessary", "Deprecated"]),
      SymbolKind,
      SymbolTag: enumOf([undefined, "Deprecated"]),
      StatusBarAlignment: enumOf([undefined, "Left", "Right"]),
      TextEditorRevealType: enumOf(["Default", "InCenter", "InCenterIfOutsideViewport", "AtTop"]),
      ViewColumn: Object.freeze({ Active: -1, Beside: -2, One: 1, Two: 2, Three: 3, Four: 4, Five: 5, Six: 6, Seven: 7, Eight: 8, Nine: 9 }),
      OverviewRulerLane: Object.freeze({ Left: 1, Center: 2, Right: 4, Full: 7 }),
      DecorationRangeBehavior: enumOf(["OpenOpen", "ClosedClosed", "OpenClosed", "ClosedOpen"]),
      EndOfLine,
      ConfigurationTarget: enumOf([undefined, "Global", "Workspace", "WorkspaceFolder"]),
      TreeItemCollapsibleState,
      ProgressLocation: Object.freeze({ SourceControl: 1, Window: 10, Notification: 15 }),
      ExtensionMode: enumOf([undefined, "Production", "Development", "Test"]),
      ExtensionKind: enumOf([undefined, "UI", "Workspace"]),
      UIKind: enumOf([undefined, "Desktop", "Web"]),
      FileType: Object.freeze({ Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 }),
      IndentAction: enumOf(["None", "Indent", "IndentOutdent", "Outdent"]),
      TextEditorCursorStyle: enumOf([undefined, "Line", "Block", "Underline", "LineThin", "BlockOutline", "UnderlineThin"]),
      TextEditorLineNumbersStyle: enumOf(["Off", "On", "Relative", "Interval"]),
      TextEditorSelectionChangeKind: enumOf([undefined, "Keyboard", "Mouse", "Command"]),
      TextDocumentChangeReason: enumOf([undefined, "Undo", "Redo"]),
      TextDocumentSaveReason: enumOf([undefined, "Manual", "AfterDelay", "FocusOut"]),
      ColorThemeKind: enumOf([undefined, "Light", "Dark", "HighContrast", "HighContrastLight"]),
      LogLevel: enumOf(["Off", "Trace", "Debug", "Info", "Warning", "Error"]),
      FoldingRangeKind: enumOf([undefined, "Comment", "Imports", "Region"]),
      CodeActionTriggerKind: enumOf([undefined, "Invoke", "Automatic"]),
      InlayHintKind: enumOf([undefined, "Type", "Parameter"]),
      QuickPickItemKind: Object.freeze({ Separator: -1, Default: 0 }),
      InputBoxValidationSeverity: enumOf([undefined, "Info", "Warning", "Error"]),
      SignatureHelpTriggerKind: enumOf([undefined, "Invoke", "TriggerCharacter", "ContentChange"]),
      DocumentHighlightKind: enumOf(["Text", "Read", "Write"]),
      LanguageStatusSeverity: enumOf(["Information", "Warning", "Error"]),
    };

    // --- Node.js built-ins -------------------------------------------------------------------------
    // Pure computation is provided (path, events, util, assert, url's file URLs); everything that
    // reaches the system (fs, child_process, net, http, os, crypto, ...) is not: its members fail
    // with UnsupportedApi when used -- loading a module that imports them still works.
    const posix = (() => {
      const normalizeParts = (parts, absolute) => {
        const out = [];
        for (const part of parts) {
          if (!part || part === ".") continue;
          if (part === "..") {
            if (out.length && out[out.length - 1] !== "..") out.pop();
            else if (!absolute) out.push("..");
          } else out.push(part);
        }
        return out;
      };
      const normalize = (path) => {
        path = String(path);
        if (!path) return ".";
        const absolute = path.startsWith("/");
        const trailing = path.endsWith("/");
        let out = normalizeParts(path.split("/"), absolute).join("/");
        if (!out && !absolute) out = ".";
        if (out && trailing) out += "/";
        return (absolute ? "/" : "") + out;
      };
      const join = (...parts) => {
        const joined = parts.filter((p) => p !== "").join("/");
        return joined ? normalize(joined) : ".";
      };
      const resolve = (...parts) => {
        let path = "";
        for (let i = parts.length - 1; i >= 0 && !path.startsWith("/"); i--) if (parts[i]) path = parts[i] + (path ? "/" + path : "");
        if (!path.startsWith("/")) path = "/" + path;
        const out = "/" + normalizeParts(path.split("/"), true).join("/");
        return out;
      };
      const dirname = (path) => {
        path = String(path);
        if (!path) return ".";
        const trimmed = path.length > 1 ? path.replace(/\/+$/, "") : path;
        const cut = trimmed.lastIndexOf("/");
        if (cut < 0) return ".";
        if (cut === 0) return "/";
        return trimmed.slice(0, cut);
      };
      const basename = (path, ext) => {
        const trimmed = String(path).replace(/\/+$/, "");
        let base = trimmed.slice(trimmed.lastIndexOf("/") + 1);
        if (ext && base.endsWith(ext) && base !== ext) base = base.slice(0, -ext.length);
        return base;
      };
      const extname = (path) => {
        const base = basename(path);
        const dot = base.lastIndexOf(".");
        return dot <= 0 ? "" : base.slice(dot);
      };
      const relative = (from, to) => {
        const a = resolve(from).split("/").filter(Boolean);
        const b = resolve(to).split("/").filter(Boolean);
        let i = 0;
        while (i < a.length && i < b.length && a[i] === b[i]) i++;
        return [...a.slice(i).map(() => ".."), ...b.slice(i)].join("/");
      };
      const parse = (path) => {
        const root = String(path).startsWith("/") ? "/" : "";
        const base = basename(path);
        const ext = extname(path);
        return { root, dir: dirname(path), base, ext, name: ext ? base.slice(0, -ext.length) : base };
      };
      const format = (p) => {
        const dir = p.dir || p.root || "";
        const base = p.base || (p.name || "") + (p.ext || "");
        return dir ? (dir.endsWith("/") ? dir + base : dir + "/" + base) : base;
      };
      return { sep: "/", delimiter: ":", normalize, join, resolve, dirname, basename, extname, relative, parse, format, isAbsolute: (p) => String(p).startsWith("/"), toNamespacedPath: (p) => p };
    })();
    posix.posix = posix;
    // Windows paths (Yavin's platform): drive and backslashes on top of the POSIX rules.
    const win32 = (() => {
      const split = (path) => {
        const text = String(path).replace(/\\/g, "/");
        const drive = /^[A-Za-z]:/.exec(text);
        return drive ? [drive[0], text.slice(2)] : ["", text];
      };
      const out = (drive, path) => (drive + path).replace(/\//g, "\\");
      const lastDrive = (parts) => {
        for (let i = parts.length - 1; i >= 0; i--) {
          const [drive, rest] = split(parts[i]);
          if (drive && rest.startsWith("/")) return drive;
        }
        return "";
      };
      return {
        sep: "\\",
        delimiter: ";",
        normalize: (p) => {
          const [drive, rest] = split(p);
          return out(drive, posix.normalize(rest || (drive ? "." : "")));
        },
        join: (...parts) => {
          const [drive, first] = split(parts[0] ?? "");
          return out(drive, posix.join(first, ...parts.slice(1).map((p) => split(p)[1])));
        },
        resolve: (...parts) => {
          let index = -1;
          for (let i = parts.length - 1; i >= 0; i--) if (split(parts[i])[1].startsWith("/") || /^[A-Za-z]:/.test(parts[i])) { index = i; break; }
          const drive = lastDrive(parts) || (index >= 0 ? split(parts[index])[0] : "");
          return out(drive, posix.resolve(...parts.slice(Math.max(index, 0)).map((p) => split(p)[1])));
        },
        dirname: (p) => {
          const [drive, rest] = split(p);
          return out(drive, posix.dirname(rest));
        },
        basename: (p, ext) => posix.basename(split(p)[1], ext),
        extname: (p) => posix.extname(split(p)[1]),
        relative: (from, to) => posix.relative(split(from)[1], split(to)[1]).replace(/\//g, "\\"),
        isAbsolute: (p) => /^([A-Za-z]:)?[\\/]/.test(String(p)),
        parse: (p) => {
          const [drive, rest] = split(p);
          const parsed = posix.parse(rest);
          return { ...parsed, root: drive + (parsed.root ? "\\" : ""), dir: out(drive, parsed.dir) };
        },
        format: (p) => posix.format(p).replace(/\//g, "\\"),
        toNamespacedPath: (p) => p,
      };
    })();
    win32.posix = posix;
    win32.win32 = win32;
    posix.win32 = win32;

    class EmitterMethods {
      on(name, fn) {
        if (!this._events.has(name)) this._events.set(name, []);
        this._events.get(name).push(fn);
        return this;
      }
      prependListener(name, fn) {
        if (!this._events.has(name)) this._events.set(name, []);
        this._events.get(name).unshift(fn);
        return this;
      }
      once(name, fn) {
        const wrapped = (...args) => {
          this.off(name, wrapped);
          fn.apply(this, args);
        };
        wrapped.listener = fn;
        return this.on(name, wrapped);
      }
      off(name, fn) {
        const list = this._events.get(name);
        if (list) {
          const at = list.findIndex((one) => one === fn || one.listener === fn);
          if (at >= 0) list.splice(at, 1);
        }
        return this;
      }
      emit(name, ...args) {
        const list = this._events.get(name);
        if (!list || !list.length) {
          if (name === "error") throw args[0] instanceof Error ? args[0] : new Error(String(args[0]));
          return false;
        }
        for (const fn of [...list]) fn.apply(this, args);
        return true;
      }
      removeAllListeners(name) {
        if (name === undefined) this._events.clear();
        else this._events.delete(name);
        return this;
      }
      listeners(name) { return [...(this._events.get(name) || [])].map((fn) => fn.listener || fn); }
      listenerCount(name) { return (this._events.get(name) || []).length; }
      eventNames() { return [...this._events.keys()]; }
      setMaxListeners() { return this; }
      getMaxListeners() { return 10; }
    }
    // A function, not a class: Node code still subclasses it the old way (`util.inherits`, then
    // `EventEmitter.call(this)`).
    function NodeEventEmitter() {
      if (!(this instanceof NodeEventEmitter)) return new NodeEventEmitter();
      this._events = new Map();
    }
    for (const name of Object.getOwnPropertyNames(EmitterMethods.prototype))
      if (name !== "constructor") NodeEventEmitter.prototype[name] = EmitterMethods.prototype[name];
    // One that never called the constructor gets its listeners on first use.
    Object.defineProperty(NodeEventEmitter.prototype, "_events", {
      configurable: true,
      get() {
        const events = new Map();
        Object.defineProperty(this, "_events", { value: events, writable: true, configurable: true });
        return events;
      },
      set(value) {
        Object.defineProperty(this, "_events", { value, writable: true, configurable: true });
      },
    });
    NodeEventEmitter.prototype.addListener = NodeEventEmitter.prototype.on;
    NodeEventEmitter.prototype.removeListener = NodeEventEmitter.prototype.off;
    NodeEventEmitter.EventEmitter = NodeEventEmitter;
    NodeEventEmitter.defaultMaxListeners = 10;
    NodeEventEmitter.once = (emitter, name) => new Promise((resolve) => emitter.once(name, (...args) => resolve(args)));

    const inspect = (value, depth = 2) => {
      if (typeof value === "string") return depth === 2 ? value : JSON.stringify(value);
      if (typeof value === "function") return `[Function: ${value.name || "anonymous"}]`;
      if (value instanceof Error) return value.stack || `${value.name}: ${value.message}`;
      if (value === null || typeof value !== "object") return String(value);
      if (depth <= 0) return Array.isArray(value) ? "[Array]" : "[Object]";
      if (Array.isArray(value)) return `[ ${value.map((v) => inspect(v, depth - 1)).join(", ")} ]`;
      return `{ ${Object.keys(value).map((k) => `${k}: ${inspect(value[k], depth - 1)}`).join(", ")} }`;
    };
    const format = (first, ...args) => {
      if (typeof first !== "string") return [first, ...args].map((v) => inspect(v)).join(" ");
      let i = 0;
      const out = first.replace(/%[sdifjoO%]/g, (token) => {
        if (token === "%%") return "%";
        if (i >= args.length) return token;
        const value = args[i++];
        switch (token) {
          case "%s": return typeof value === "string" ? value : inspect(value, 1);
          case "%d": case "%i": return String(token === "%i" ? parseInt(value, 10) : Number(value));
          case "%f": return String(parseFloat(value));
          case "%j": try { return JSON.stringify(value); } catch { return "[Circular]"; }
          default: return inspect(value, 1);
        }
      });
      return [out, ...args.slice(i).map((v) => inspect(v))].join(" ");
    };
    const util = {
      format,
      inspect: Object.assign(inspect, { custom: Symbol.for("nodejs.util.inspect.custom") }),
      promisify(fn) {
        if (typeof fn !== "function") throw new TypeError("promisify needs a function");
        return (...args) => new Promise((resolve, reject) => fn(...args, (error, value) => (error ? reject(error) : resolve(value))));
      },
      callbackify: (fn) => (...args) => {
        const done = args.pop();
        fn(...args).then((value) => done(null, value), (error) => done(error));
      },
      inherits(ctor, superCtor) {
        Object.setPrototypeOf(ctor.prototype, superCtor.prototype);
        Object.setPrototypeOf(ctor, superCtor);
      },
      deprecate: (fn) => fn,
      // Logs only for sections NODE_DEBUG names -- and no environment reaches an extension.
      debuglog: () => Object.assign(() => {}, { enabled: false }),
      debug: () => Object.assign(() => {}, { enabled: false }),
      isDeepStrictEqual: (a, b) => JSON.stringify(a) === JSON.stringify(b),
      types: { isPromise: (v) => v instanceof Promise, isRegExp: (v) => v instanceof RegExp, isDate: (v) => v instanceof Date },
      isArray: Array.isArray,
      TextEncoder: globalThis.TextEncoder,
      TextDecoder: globalThis.TextDecoder,
    };
    const assertModule = (() => {
      class AssertionError extends Error {
        constructor(message) {
          super(message);
          this.name = "AssertionError";
          this.code = "ERR_ASSERTION";
        }
      }
      const check = (ok, message, fallback) => {
        if (!ok) throw message instanceof Error ? message : new AssertionError(message || fallback);
      };
      const assert = (value, message) => check(value, message, "The expression evaluated to a falsy value");
      Object.assign(assert, {
        ok: assert,
        AssertionError,
        equal: (a, b, m) => check(a == b, m, `${a} == ${b}`),
        notEqual: (a, b, m) => check(a != b, m, `${a} != ${b}`),
        strictEqual: (a, b, m) => check(Object.is(a, b), m, `Expected values to be strictly equal`),
        notStrictEqual: (a, b, m) => check(!Object.is(a, b), m, `Expected values to differ`),
        deepEqual: (a, b, m) => check(JSON.stringify(a) === JSON.stringify(b), m, "Expected values to be deeply equal"),
        deepStrictEqual: (a, b, m) => check(JSON.stringify(a) === JSON.stringify(b), m, "Expected values to be deeply equal"),
        fail: (m) => check(false, m, "Failed"),
      });
      assert.strict = assert;
      return assert;
    })();
    // Node.js's `crypto`, its random part (EXT-28): the same operating-system source as Web
    // `crypto`; hashes, ciphers and keys stay unsupported.
    const nodeCrypto = () => {
      if (!web) return {};
      const MAX_BYTES = 2 ** 31 - 1;
      const bytes = (size) => {
        if (typeof size !== "number" || !Number.isInteger(size) || size < 0 || size > MAX_BYTES)
          throw Object.assign(new RangeError(`The value of "size" is out of range. It must be >= 0 && <= ${MAX_BYTES}. Received ${size}`), { code: "ERR_OUT_OF_RANGE" });
        const out = Buffer.alloc(size);
        for (let at = 0; at < size; at += 65536) out.set(web.randomBytes(Math.min(65536, size - at)), at);
        return out;
      };
      const later = (callback, run) => {
        if (typeof callback !== "function") return run();
        setTimeout(() => {
          let value;
          try {
            value = run();
          } catch (error) {
            callback(error);
            return;
          }
          callback(null, value);
        }, 0);
        return undefined;
      };
      const randomInt = (min, max, callback) => {
        if (max === undefined || typeof max === "function") {
          callback = max;
          max = min;
          min = 0;
        }
        if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max))
          throw Object.assign(new TypeError('The "min" and "max" arguments must be safe integers'), { code: "ERR_INVALID_ARG_TYPE" });
        const range = max - min;
        if (!(range > 0) || range > 2 ** 48)
          throw Object.assign(new RangeError(`The value of "max" is out of range. It must be greater than the value of "min" (${min}) and at most 2^48 above it. Received ${max}`), { code: "ERR_OUT_OF_RANGE" });
        return later(callback, () => {
          // Unbiased: values in the last, partial range of 2^48 are drawn again.
          const limit = 2 ** 48 - (2 ** 48 % range);
          for (;;) {
            const b = web.randomBytes(6);
            const x = b.reduce((n, byte) => n * 256 + byte, 0);
            if (x < limit) return min + (x % range);
          }
        });
      };
      return {
        getRandomValues: web.getRandomValues,
        randomUUID: () => web.randomUUID(),
        randomBytes: (size, callback) => later(callback, () => bytes(size)),
        randomFillSync(buffer, offset = 0, size) {
          const view = new Uint8Array(buffer.buffer || buffer, buffer.byteOffset || 0, buffer.byteLength);
          const end = size === undefined ? view.length : offset + size;
          if (offset < 0 || end > view.length || offset > end) throw Object.assign(new RangeError("The offset or size is out of range"), { code: "ERR_OUT_OF_RANGE" });
          view.set(bytes(end - offset), offset);
          return buffer;
        },
        randomInt,
        webcrypto: web.webcrypto,
      };
    };
    // Node.js's `url` (EXT-28: on the WHATWG URL, as Node.js's own is; Windows rules).
    const fileUrlError = (code, message) => Object.assign(new TypeError(message), { code });
    const url = {
      URL: globalThis.URL,
      URLSearchParams: globalThis.URLSearchParams,
      domainToASCII: (domain) => (web ? web.domainToASCII(domain) : String(domain)),
      fileURLToPath(value) {
        const parsed = typeof value === "string" ? new URL(value) : value;
        if (!parsed || typeof parsed.href !== "string" || typeof parsed.pathname !== "string")
          throw fileUrlError("ERR_INVALID_ARG_TYPE", 'The "path" argument must be of type string or an instance of URL');
        if (parsed.protocol !== "file:") throw fileUrlError("ERR_INVALID_URL_SCHEME", "The URL must be of scheme file");
        let pathname = parsed.pathname;
        if (/%(2f|5c)/i.test(pathname)) throw fileUrlError("ERR_INVALID_FILE_URL_PATH", "File URL path must not include encoded \\ or / characters");
        pathname = decodeURIComponent(pathname.replace(/\//g, "\\"));
        if (parsed.hostname !== "") return `\\\\${parsed.hostname}${pathname}`;
        const letter = pathname.codePointAt(1) | 0x20;
        if (letter < 97 || letter > 122 || pathname[2] !== ":") throw fileUrlError("ERR_INVALID_FILE_URL_PATH", "File URL path must be absolute");
        return pathname.slice(1);
      },
      pathToFileURL(path) {
        const text = String(path);
        // As Node.js encodes them before the pathname setter sees the path.
        const escape = (p) => p.replace(/%/g, "%25").replace(/\n/g, "%0A").replace(/\r/g, "%0D").replace(/\t/g, "%09");
        if (/^[\\/]{2}[^\\/]/.test(text)) {
          // A UNC path: \\server\share\file is file://server/share/file.
          const [, host, rest] = /^[\\/]{2}([^\\/]+)(.*)$/.exec(text);
          const out = new URL("file://");
          out.hostname = host;
          out.pathname = escape(rest || "/");
          return out;
        }
        // A rooted path without a drive (`\x`) is on the drive of the extension's folder: Node.js
        // takes its working directory's, and the host has none. A relative path has no answer.
        const drive = /^[A-Za-z]:/.exec(String(init.extensionPath || ""));
        const rooted = /^[\\/]/.test(text) && drive ? `${drive[0]}${text}` : text;
        if (!/^[A-Za-z]:[\\/]/.test(rooted))
          throw unsupported("url.pathToFileURL of a relative path", "Yavin's extension host has no working directory");
        const resolved = win32.resolve(rooted);
        const out = new URL("file://");
        out.pathname = escape(/[\\/]$/.test(text) && !/[\\/]$/.test(resolved) ? `${resolved}\\` : resolved);
        return out;
      },
    };
    // What Node modules that reach the system expose (so module-interop helpers copy them), and
    // which members are values, not functions.
    const NODE_SURFACE = {
      fs: ["readFile", "readFileSync", "writeFile", "writeFileSync", "existsSync", "exists", "stat", "statSync", "lstat", "lstatSync", "readdir", "readdirSync", "mkdir", "mkdirSync", "rm", "rmSync", "unlink", "unlinkSync", "rename", "renameSync", "watch", "watchFile", "createReadStream", "createWriteStream", "access", "accessSync", "realpath", "realpathSync", "copyFile", "copyFileSync", "appendFile", "appendFileSync", "open", "openSync", "close", "closeSync", "promises", "constants"],
      child_process: ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"],
      os: ["platform", "type", "arch", "endianness", "homedir", "tmpdir", "hostname", "type", "release", "arch", "cpus", "totalmem", "freemem", "userInfo", "networkInterfaces", "EOL", "constants"],
      crypto: ["createHash", "createHmac", "randomBytes", "randomUUID", "createCipheriv", "createDecipheriv", "webcrypto", "getRandomValues", "constants"],
      net: ["createServer", "createConnection", "connect", "Socket", "Server"],
      http: ["request", "get", "createServer", "Agent", "STATUS_CODES"],
      https: ["request", "get", "createServer", "Agent"],
      zlib: ["gzip", "gunzip", "deflate", "inflate", "gzipSync", "gunzipSync", "createGzip", "createGunzip"],
      stream: ["Readable", "Writable", "Transform", "PassThrough", "Duplex", "pipeline", "finished"],
      worker_threads: ["Worker", "isMainThread", "parentPort", "workerData"],
      readline: ["createInterface"],
      tty: ["isatty"],
      dns: ["lookup", "resolve"],
      tls: ["connect", "createServer"],
      vm: ["runInNewContext", "runInThisContext", "Script", "createContext"],
      buffer: ["Buffer"],
      string_decoder: ["StringDecoder"],
      timers: ["setTimeout", "setInterval", "clearTimeout", "clearInterval", "setImmediate"],
      perf_hooks: ["performance"],
      module: ["createRequire", "builtinModules"],
      v8: ["serialize", "deserialize"],
      cluster: ["fork", "isMaster", "isPrimary"],
      dgram: ["createSocket"],
      inspector: ["open", "url"],
      async_hooks: ["AsyncLocalStorage", "createHook"],
      process: [],
      querystring: ["parse", "stringify", "escape", "unescape"],
    };
    const VALUES = new Set(["EOL", "constants", "STATUS_CODES", "isMainThread", "workerData", "isMaster", "isPrimary", "builtinModules"]);
    const NESTED = new Set(["promises", "webcrypto", "parentPort", "performance"]);
    const unsupportedModule = (name, members) =>
      new Proxy(
        {},
        {
          get(_, key) {
            if (typeof key === "symbol" || PROBED.has(key)) return undefined;
            if (key in Object.prototype) return Object.prototype[key];
            if (NESTED.has(key)) return unsupportedModule(`${name}.${key}`, []);
            // `constants` holds values only: reading one fails at once.
            if (VALUES.has(key) || name === "constants") throw unsupported(`Node.js ${name}.${key}`, "Yavin's extension host has no Node.js");
            return unsupportedFn(`Node.js ${name}.${key}`, "Yavin's extension host has no Node.js");
          },
          has: (target, key) => members.includes(key) || key in target,
          // What code defined on it (graceful-fs marks fs) stays listed, as a proxy must list it.
          ownKeys: (target) => [...new Set([...members, ...Reflect.ownKeys(target)])],
          // Every listed member has a descriptor (graceful-fs copies them all): a function that
          // fails when called, a nested module, or a value that fails when read.
          getOwnPropertyDescriptor: (target, key) => {
            const own = Reflect.getOwnPropertyDescriptor(target, key);
            if (own || !members.includes(key)) return own;
            const what = `Node.js ${name}.${key}`;
            if (NESTED.has(key)) return { get: () => unsupportedModule(`${name}.${key}`, []), enumerable: true, configurable: true };
            if (VALUES.has(key) || name === "constants")
              return {
                get() {
                  throw unsupported(what, "Yavin's extension host has no Node.js");
                },
                enumerable: true,
                configurable: true,
              };
            return { value: unsupportedFn(what, "Yavin's extension host has no Node.js"), enumerable: true, configurable: true, writable: false };
          },
        },
      );
    // A module Yavin provides in part: its own members, and -- for the module-interop helpers that
    // copy a module's own names -- Node's other members, each failing with UnsupportedApi.
    const partial = (name, implementation) => {
      const missing = (key) => typeof key === "string" && (NODE_SURFACE[name] || []).includes(key) && !(key in implementation);
      return new Proxy(implementation, {
        get(target, key) {
          if (typeof key === "symbol" || key in target) return target[key];
          if (PROBED.has(key)) return undefined;
          if (VALUES.has(key)) throw unsupported(`Node.js ${name}.${key}`, "Yavin's extension host has no Node.js");
          return unsupportedFn(`Node.js ${name}.${key}`, "Yavin's extension host has no Node.js");
        },
        has: (target, key) => key in target || missing(key),
        ownKeys: (target) => [...new Set([...Reflect.ownKeys(target), ...(NODE_SURFACE[name] || []).filter((k) => !VALUES.has(k) && !NESTED.has(k))])],
        getOwnPropertyDescriptor: (target, key) =>
          Reflect.getOwnPropertyDescriptor(target, key) ??
          (missing(key) && !VALUES.has(key) && !NESTED.has(key)
            ? { value: unsupportedFn(`Node.js ${name}.${key}`, "Yavin's extension host has no Node.js"), enumerable: true, configurable: true, writable: false }
            : undefined),
      });
    };
    // Buffer: bytes, as Node's (a Uint8Array) -- computation only.
    class Buffer extends Uint8Array {
      static from(value, encoding, length) {
        if (typeof value === "string") return Buffer._bytes(bytesOf(value, encoding));
        if (value instanceof ArrayBuffer) return new Buffer(value, encoding || 0, length ?? value.byteLength - (encoding || 0));
        if (ArrayBuffer.isView(value)) return Buffer._bytes(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
        if (value && typeof value === "object" && value.type === "Buffer" && Array.isArray(value.data)) return Buffer._bytes(value.data);
        if (Array.isArray(value) || (value && typeof value.length === "number")) return Buffer._bytes(Array.from(value, (n) => n & 255));
        throw new TypeError("The first argument must be a string, Buffer, ArrayBuffer, Array or array-like object.");
      }
      static _bytes(bytes) {
        const out = new Buffer(bytes.length);
        out.set(bytes);
        return out;
      }
      static alloc(size, fill) {
        const out = new Buffer(size);
        if (fill !== undefined) out.fill(typeof fill === "string" ? fill.charCodeAt(0) & 255 : fill);
        return out;
      }
      static allocUnsafe(size) {
        return new Buffer(size);
      }
      static isBuffer(value) {
        return value instanceof Buffer;
      }
      static isEncoding(encoding) {
        return ["utf8", "utf-8", "hex", "base64", "base64url", "latin1", "binary", "ascii", "utf16le", "ucs2"].includes(String(encoding).toLowerCase());
      }
      static byteLength(value, encoding) {
        return typeof value === "string" ? bytesOf(value, encoding).length : value.byteLength;
      }
      static concat(list, total) {
        const length = total ?? list.reduce((n, one) => n + one.length, 0);
        const out = Buffer.alloc(length);
        let at = 0;
        for (const one of list) {
          if (at >= length) break;
          out.set(one.subarray(0, length - at), at);
          at += one.length;
        }
        return out;
      }
      toString(encoding, start, end) {
        const bytes = this.subarray(start || 0, end ?? this.length);
        switch (String(encoding || "utf8").toLowerCase()) {
          case "hex":
            return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
          case "base64":
            return btoa(String.fromCharCode(...bytes));
          case "base64url":
            return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
          case "latin1":
          case "binary":
          case "ascii":
            return String.fromCharCode(...bytes);
          case "utf16le":
          case "ucs2": {
            let out = "";
            for (let i = 0; i + 1 < bytes.length; i += 2) out += String.fromCharCode(bytes[i] | (bytes[i + 1] << 8));
            return out;
          }
          default:
            return new TextDecoder().decode(bytes);
        }
      }
      toJSON() {
        return { type: "Buffer", data: Array.from(this) };
      }
      equals(other) {
        return this.length === other.length && this.every((b, i) => b === other[i]);
      }
      compare(other) {
        for (let i = 0; i < Math.min(this.length, other.length); i++) if (this[i] !== other[i]) return this[i] < other[i] ? -1 : 1;
        return this.length === other.length ? 0 : this.length < other.length ? -1 : 1;
      }
      slice(start, end) {
        return this.subarray(start, end);
      }
      subarray(start, end) {
        const view = Uint8Array.prototype.subarray.call(this, start, end);
        return new Buffer(view.buffer, view.byteOffset, view.length);
      }
      write(text, offset = 0) {
        const bytes = bytesOf(text, "utf8");
        this.set(bytes.subarray(0, this.length - offset), offset);
        return Math.min(bytes.length, this.length - offset);
      }
      readUInt8(at = 0) { return this[at]; }
      readUInt16LE(at = 0) { return this[at] | (this[at + 1] << 8); }
      readUInt32LE(at = 0) { return (this[at] | (this[at + 1] << 8) | (this[at + 2] << 16)) + this[at + 3] * 0x1000000; }
      readUInt32BE(at = 0) { return this[at] * 0x1000000 + ((this[at + 1] << 16) | (this[at + 2] << 8) | this[at + 3]); }
    }
    function bytesOf(text, encoding) {
      const value = String(text);
      switch (String(encoding || "utf8").toLowerCase()) {
        case "hex": {
          const out = new Uint8Array(Math.floor(value.length / 2));
          for (let i = 0; i < out.length; i++) out[i] = parseInt(value.substr(i * 2, 2), 16);
          return out;
        }
        case "base64":
        case "base64url": {
          const raw = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
          return Uint8Array.from(raw, (c) => c.charCodeAt(0));
        }
        case "latin1":
        case "binary":
        case "ascii":
          return Uint8Array.from(value, (c) => c.charCodeAt(0) & 255);
        case "utf16le":
        case "ucs2": {
          const out = new Uint8Array(value.length * 2);
          for (let i = 0; i < value.length; i++) {
            out[i * 2] = value.charCodeAt(i) & 255;
            out[i * 2 + 1] = value.charCodeAt(i) >> 8;
          }
          return out;
        }
        default:
          return new TextEncoder().encode(value);
      }
    }
    globalThis.Buffer = Buffer;
    // What Yavin is, as `os` says it: the platform alone. The machine's own facts (its user,
    // folders, name, network) are not given.
    const os = {
      platform: () => "win32",
      type: () => "Windows_NT",
      arch: () => "x64",
      endianness: () => "LE",
      EOL: "\r\n",
      devNull: "\\\\.\\nul",
    };
    const STATUS_CODES = Object.freeze({ 100: "Continue", 101: "Switching Protocols", 200: "OK", 201: "Created", 202: "Accepted", 204: "No Content", 206: "Partial Content", 301: "Moved Permanently", 302: "Found", 303: "See Other", 304: "Not Modified", 307: "Temporary Redirect", 308: "Permanent Redirect", 400: "Bad Request", 401: "Unauthorized", 403: "Forbidden", 404: "Not Found", 405: "Method Not Allowed", 408: "Request Timeout", 409: "Conflict", 410: "Gone", 413: "Payload Too Large", 415: "Unsupported Media Type", 422: "Unprocessable Entity", 429: "Too Many Requests", 500: "Internal Server Error", 501: "Not Implemented", 502: "Bad Gateway", 503: "Service Unavailable", 504: "Gateway Timeout" });
    const METHODS = Object.freeze(["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]);
    // Every Node.js built-in module (so that importing one is never what fails).
    const NODE_MODULES = ["assert", "async_hooks", "buffer", "child_process", "cluster", "console", "constants", "crypto", "dgram", "diagnostics_channel", "dns", "domain", "events", "fs", "http", "http2", "https", "inspector", "module", "net", "os", "path", "perf_hooks", "process", "punycode", "querystring", "readline", "repl", "stream", "string_decoder", "sys", "timers", "tls", "trace_events", "tty", "url", "util", "v8", "vm", "wasi", "worker_threads", "zlib"];
    const builtins = {
      console: () => globalThis.console,
      buffer: () => partial("buffer", { Buffer, kMaxLength: 2 ** 31 - 1, constants: { MAX_LENGTH: 2 ** 31 - 1 } }),
      os: () => partial("os", os),
      // No terminal is attached to an extension.
      tty: () => partial("tty", { isatty: () => false }),
      http: () => partial("http", { STATUS_CODES, METHODS }),
      https: () => partial("https", {}),
      sys: () => partial("util", util),
      path: () => win32,
      events: () => NodeEventEmitter,
      util: () => partial("util", util),
      assert: () => assertModule,
      url: () => partial("url", url),
      crypto: () => partial("crypto", nodeCrypto()),
      perf_hooks: () => partial("perf_hooks", { performance: globalThis.performance }),
      "path/posix": () => posix,
      "path/win32": () => win32,
      "assert/strict": () => assertModule,
      timers: () => ({ setTimeout, clearTimeout, setInterval, clearInterval, setImmediate: (fn, ...a) => setTimeout(fn, 0, ...a) }),
    };

    // --- Modules -----------------------------------------------------------------------------------
    // CommonJS, as Node.js loads it (EXT-25), from the package's files only. EXT-28: one
    // `require.cache` for the extension, keyed by file name (deleting an entry loads the file
    // again); a module whose code throws is not kept; `module.parent`, `children`, `require` and
    // `require.main` are Node.js's; an absolute path is found only inside the package.
    const files = Object.assign(Object.create(null), modules);
    files[mainPath] = mainSource;
    const requireCache = Object.create(null);
    let mainModule;
    const pathOf = (file) => (init.extensionPath ? win32.join(init.extensionPath, file) : file);
    const ROOT = init.extensionPath ? String(init.extensionPath).replace(/\\/g, "/").replace(/\/+$/, "") : null;
    const isAbsolutePath = (spec) => /^[A-Za-z]:[\\/]/.test(spec) || /^[\\/]/.test(spec);
    /** The package path of an absolute one inside the package (`C:\ext\out\x` → `out/x`), else null. */
    const insidePackage = (spec) => {
      if (!ROOT || !/^[A-Za-z]:[\\/]/.test(spec)) return null;
      const full = posix.normalize(String(spec).replace(/\\/g, "/"));
      const root = posix.normalize(ROOT);
      if (full.toLowerCase() === root.toLowerCase()) return ".";
      if (!full.toLowerCase().startsWith(`${root.toLowerCase()}/`)) return null;
      return full.slice(root.length + 1);
    };
    const notFound = (spec, why) => {
      const error = new Error(`Cannot find module '${spec}'${why ? ` (${why})` : ""}`);
      error.code = "MODULE_NOT_FOUND";
      return error;
    };
    const findFile = (path) => {
      for (const candidate of [path, `${path}.js`, `${path}.json`, `${path}.cjs`]) if (candidate in files) return candidate;
      return null;
    };
    const findDirectory = (path) => {
      const pkg = files[`${path}/package.json`];
      if (pkg) {
        let main;
        try {
          main = JSON.parse(pkg).main;
        } catch {
          main = undefined;
        }
        if (typeof main === "string") {
          const found = findFile(posix.join(path, main)) || findFile(posix.join(path, main, "index"));
          if (found) return found;
        }
      }
      return findFile(`${path}/index`);
    };
    const findPath = (path) => (path.startsWith("../") || path === ".." ? null : findFile(path) || findDirectory(path));
    const lookupPaths = (dir) => {
      const paths = [];
      for (let d = dir; ; d = posix.dirname(d)) {
        if (!d.endsWith("/node_modules") && posix.basename(d) !== "node_modules") paths.push(pathOf(d === "." ? "node_modules" : `${d}/node_modules`));
        if (d === "." || d === "/" || !d.includes("/")) break;
      }
      return paths;
    };
    const resolveModule = (spec, from) => {
      if (spec.startsWith("./") || spec.startsWith("../") || spec === "." || spec === "..")
        return findPath(posix.normalize(posix.join(from, spec)).replace(/\/$/, ""));
      if (isAbsolutePath(spec)) {
        const inside = insidePackage(spec);
        return inside === null ? null : findPath(inside === "." ? "" : inside);
      }
      for (let dir = from; ; dir = posix.dirname(dir)) {
        const base = dir === "." ? `node_modules/${spec}` : `${dir}/node_modules/${spec}`;
        const found = findFile(base) || findDirectory(base);
        if (found) return found;
        if (dir === "." || dir === "/" || !dir.includes("/")) break;
      }
      return null;
    };
    const loadModule = (file, parent) => {
      const filename = pathOf(file);
      const cached = requireCache[filename];
      if (cached) {
        if (parent && !parent.children.includes(cached)) parent.children.push(cached);
        return cached.exports;
      }
      const source = files[file];
      const dir = posix.dirname(file);
      const module = {
        id: parent ? filename : ".",
        filename,
        path: pathOf(dir),
        loaded: false,
        exports: {},
        children: [],
        paths: lookupPaths(dir),
        parent: parent || null,
      };
      module.require = (spec) => requireFrom(dir, module)(spec);
      if (!parent && !mainModule) mainModule = module;
      requireCache[filename] = module;
      if (parent) parent.children.push(module);
      try {
        if (file.endsWith(".json")) {
          try {
            module.exports = JSON.parse(source);
          } catch (error) {
            error.message = `${filename}: ${error.message}`;
            throw error;
          }
        } else {
          const factory = new Function("exports", "require", "module", "__filename", "__dirname", source);
          factory.call(module.exports, module.exports, requireFrom(dir, module), module, filename, pathOf(dir));
        }
      } catch (error) {
        // As Node.js: a module that failed is not kept, so requiring it again runs it again.
        delete requireCache[filename];
        if (parent) parent.children = parent.children.filter((child) => child !== module);
        throw error;
      }
      module.loaded = true;
      return module.exports;
    };
    const isBuiltin = (spec) => {
      const bare = spec.startsWith("node:") ? spec.slice(5) : spec;
      const top = bare.split("/")[0];
      return Object.hasOwn(builtins, bare) || ((Object.hasOwn(NODE_SURFACE, top) || NODE_MODULES.includes(top)) && !spec.startsWith("."));
    };
    function requireFrom(dir, parent) {
      const require = (spec) => {
        if (typeof spec !== "string") throw new TypeError("The module name must be a string");
        if (spec === "") throw Object.assign(new TypeError("The argument 'id' must be a non-empty string"), { code: "ERR_INVALID_ARG_VALUE" });
        if (spec === "vscode") return api;
        const bare = spec.startsWith("node:") ? spec.slice(5) : spec;
        if (Object.hasOwn(builtins, bare)) return builtins[bare]();
        const top = bare.split("/")[0];
        if ((Object.hasOwn(NODE_SURFACE, top) || NODE_MODULES.includes(top)) && !spec.startsWith("."))
          return unsupportedModule(bare, NODE_SURFACE[top] || []);
        if (spec.endsWith(".node")) throw unsupported(`the native module ${spec}`, "native code cannot run in Yavin's extension host");
        const file = resolveModule(spec, dir);
        if (!file) {
          if (isAbsolutePath(spec) && insidePackage(spec) === null) throw notFound(spec, "it is outside the extension's package");
          if (spec.startsWith(".") || isAbsolutePath(spec)) throw notFound(spec);
          // A Node built-in Yavin does not list, or a package not in the extension.
          throw unsupported(`the module "${spec}"`, "it is not part of the extension, and Yavin's extension host has no Node.js");
        }
        if (file.endsWith(".node")) throw unsupported(`the native module ${spec}`, "native code cannot run in Yavin's extension host");
        return loadModule(file, parent);
      };
      require.resolve = (spec) => {
        if (typeof spec !== "string") throw new TypeError("The module name must be a string");
        if (spec === "vscode" || isBuiltin(spec)) return spec;
        const file = resolveModule(spec, dir);
        if (!file) throw notFound(spec, isAbsolutePath(spec) && insidePackage(spec) === null ? "it is outside the extension's package" : "");
        return pathOf(file);
      };
      require.resolve.paths = (spec) => (isBuiltin(spec) || spec === "vscode" ? null : spec.startsWith(".") ? [pathOf(dir)] : lookupPaths(dir));
      require.cache = requireCache;
      Object.defineProperty(require, "main", { get: () => mainModule, enumerable: true, configurable: true });
      return require;
    }

    // --- Documents and editors ---------------------------------------------------------------------
    const docs = new Map(); // uri -> { info, text, document }
    let active = null; // { uri, selection } | null
    let deniedUntil = 0;
    const denied = (error) => {
      if (error && error.code === "PermissionDenied") deniedUntil = Date.now() + 30000;
      return null;
    };
    const ask = (method, params) => (Date.now() < deniedUntil ? Promise.resolve(null) : call(method, params).catch(denied));
    const linesOf = (text) => text.split(/\r\n|\r|\n/);
    const toVsRange = (r) => new Range(r.startLine - 1, r.startColumn - 1, r.endLine - 1, r.endColumn - 1);
    const toYavinRange = (r) => ({ startLine: r.start.line + 1, startColumn: r.start.character + 1, endLine: r.end.line + 1, endColumn: r.end.character + 1 });
    const WORD = /(-?\d*\.\d\w*)|([^`~!@#$%^&*()\-=+[{\]}\\|;:'",.<>/?\s]+)/g;
    const textDocument = (entry) => {
      const offsetAt = (position) => {
        const lines = linesOf(entry.text);
        const line = Math.min(Math.max(position.line, 0), lines.length - 1);
        let offset = 0;
        const breaks = entry.text.match(/\r\n|\r|\n/g) || [];
        for (let i = 0; i < line; i++) offset += lines[i].length + (breaks[i] || "\n").length;
        return offset + Math.min(Math.max(position.character, 0), lines[line].length);
      };
      const positionAt = (offset) => {
        const text = entry.text.slice(0, Math.max(0, Math.min(offset, entry.text.length)));
        const lines = linesOf(text);
        return new Position(lines.length - 1, lines[lines.length - 1].length);
      };
      const validatePosition = (p) => {
        const lines = linesOf(entry.text);
        const line = Math.min(Math.max(p.line, 0), lines.length - 1);
        return new Position(line, Math.min(Math.max(p.character, 0), lines[line].length));
      };
      const lineAt = (x) => {
        const n = typeof x === "number" ? x : x.line;
        const lines = linesOf(entry.text);
        if (n < 0 || n >= lines.length) throw new Error("Illegal value for `line`");
        const text = lines[n];
        const first = text.search(/\S/);
        return {
          lineNumber: n,
          text,
          range: new Range(n, 0, n, text.length),
          rangeIncludingLineBreak: n < lines.length - 1 ? new Range(n, 0, n + 1, 0) : new Range(n, 0, n, text.length),
          firstNonWhitespaceCharacterIndex: first < 0 ? text.length : first,
          isEmptyOrWhitespace: first < 0,
        };
      };
      const uri = uriOf(entry.info.uri);
      return Object.freeze({
        uri,
        get fileName() { return uri.scheme === "file" ? uri.fsPath : uri.toString(); },
        get isUntitled() { return entry.info.source === "untitled"; },
        get languageId() { return entry.info.languageId; },
        get version() { return entry.info.version; },
        get isDirty() { return !!entry.info.dirty; },
        get isClosed() { return !!entry.closed; },
        get eol() { return entry.text.includes("\r\n") ? EndOfLine.CRLF : EndOfLine.LF; },
        get lineCount() { return linesOf(entry.text).length; },
        get encoding() { return "utf8"; },
        save: unsupportedAsync("TextDocument.save", "documents are saved by the user"),
        getText(range) {
          if (!range) return entry.text;
          const r = validateRange(range);
          return entry.text.slice(offsetAt(r.start), offsetAt(r.end));
        },
        lineAt,
        offsetAt,
        positionAt,
        validatePosition,
        validateRange,
        getWordRangeAtPosition(position, regex) {
          const line = lineAt(position.line).text;
          const pattern = new RegExp((regex || WORD).source, "g");
          for (let match; (match = pattern.exec(line)); ) {
            if (match.index <= position.character && match.index + match[0].length >= position.character)
              return new Range(position.line, match.index, position.line, match.index + match[0].length);
            if (!match[0].length) pattern.lastIndex++;
          }
          return undefined;
        },
      });
      function validateRange(r) {
        return new Range(validatePosition(r.start), validatePosition(r.end));
      }
    };
    /** The cached document for `info`, its text fetched when its version changed. */
    const documentFor = async (info) => {
      let entry = docs.get(info.uri);
      if (entry && entry.info.version === info.version && entry.text !== null) {
        entry.info = info;
        return entry;
      }
      const text = await ask("documents.getText", { uri: info.uri });
      if (text === null || text === undefined) return null;
      if (!entry) {
        entry = { info, text, closed: false };
        entry.document = textDocument(entry);
        docs.set(info.uri, entry);
      } else {
        entry.info = info;
        entry.text = text;
      }
      return entry;
    };
    const refreshActive = async () => {
      const now = await ask("editor.active", null);
      if (!now) {
        active = null;
        return null;
      }
      const entry = await documentFor(now.document);
      active = entry ? { uri: now.document.uri, selection: now.selection } : null;
      return active;
    };
    const decorationKeys = new Map(); // decoration type key -> Set of uris it was set on
    let nextKey = 1;
    const editorFor = (entry, selection) => {
      let current = selection ? selectionOf(selection) : new Selection(0, 0, 0, 0);
      return {
        get document() { return entry.document; },
        get selection() { return current; },
        set selection(value) {
          current = value;
          ask("editor.setSelection", { range: toYavinRange(value) });
        },
        get selections() { return [current]; },
        set selections(list) {
          if (list && list[0]) this.selection = list[0];
        },
        get visibleRanges() { return [new Range(0, 0, entry.document.lineCount, 0)]; },
        options: { tabSize: 4, insertSpaces: true, cursorStyle: 1, lineNumbers: 1 },
        viewColumn: 1,
        edit(callback) {
          const builder = editBuilder();
          callback(builder);
          return applyTextEdits(entry, builder.edits);
        },
        insertSnippet: unsupportedAsync("TextEditor.insertSnippet"),
        setDecorations(type, rangesOrOptions) {
          const list = (rangesOrOptions || []).slice(0, 1000).map((one) => {
            const range = one instanceof Range || (one && one.start && one.end && !one.range) ? one : one.range;
            const hover = one && one.hoverMessage ? hoverText(one.hoverMessage) : null;
            return { range: toYavinRange(range), style: type._style, hover };
          });
          let uris = decorationKeys.get(type.key);
          if (!uris) decorationKeys.set(type.key, (uris = new Set()));
          uris.add(entry.info.uri);
          call("editor.setDecorations", { uri: entry.info.uri, key: type.key, decorations: list }).catch(() => {});
        },
        revealRange(range) {
          ask("editor.revealRange", { range: toYavinRange(range) });
        },
        show: unsupportedFn("TextEditor.show"),
        hide: unsupportedFn("TextEditor.hide"),
      };
    };
    const activeEditor = () => {
      if (!active) return undefined;
      const entry = docs.get(active.uri);
      return entry ? editorFor(entry, active.selection) : undefined;
    };
    const editBuilder = () => {
      const edits = [];
      return {
        edits,
        replace(where, text) {
          const range = where instanceof Range || (where && where.start) ? where : new Range(where, where);
          edits.push({ range, text: String(text) });
        },
        insert(position, text) {
          edits.push({ range: new Range(position, position), text: String(text) });
        },
        delete(range) {
          edits.push({ range, text: "" });
        },
        setEndOfLine() {
          throw unsupported("TextEditorEdit.setEndOfLine");
        },
      };
    };
    /** Edits to one open document, through Yavin's document service (documents.edit). */
    const applyTextEdits = async (entry, edits) => {
      if (!edits.length) return true;
      const ok = await call("documents.edit", {
        uri: entry.info.uri,
        version: entry.info.version,
        edits: edits.map((e) => ({ range: toYavinRange(e.range), text: e.text })),
      });
      if (ok) {
        const info = await ask("documents.get", { uri: entry.info.uri });
        if (info) await documentFor(info);
      }
      return !!ok;
    };
    const hoverText = (contents) =>
      (Array.isArray(contents) ? contents : [contents])
        .map((one) => (typeof one === "string" ? one : one && typeof one.value === "string" ? (one.language ? "```" + one.language + "\n" + one.value + "\n```" : one.value) : ""))
        .filter(Boolean)
        .join("\n\n")
        .slice(0, 4000);

    // --- Commands ----------------------------------------------------------------------------------
    const mapped = meta.commands || {}; // yavin -> vscode
    const toYavin = new Map(Object.entries(mapped).map(([yavin, vscode]) => [vscode, yavin]));
    const local = new Map(); // vscode id -> handler
    const runLocal = async (id, args) => {
      await refreshActive();
      return local.get(id)(...args);
    };
    const BUILTIN = {
      setContext: () => undefined,
      "vscode.open": (target) => showDocument(target),
    };
    const commandsApi = {
      registerCommand(id, handler, thisArg) {
        if (typeof handler !== "function") throw new TypeError("A command handler is a function.");
        if (local.has(id)) throw new Error(`command '${id}' already exists`);
        local.set(id, (...args) => handler.apply(thisArg, args));
        const mappedId = toYavin.get(id);
        let registration = null;
        if (mappedId) registration = yavin.commands.registerCommand(mappedId, (...args) => runLocal(id, args));
        return new Disposable(() => {
          local.delete(id);
          if (registration) registration.dispose();
        });
      },
      registerTextEditorCommand(id, handler, thisArg) {
        return commandsApi.registerCommand(id, async (...args) => {
          const editor = activeEditor();
          if (!editor) return undefined;
          const builder = editBuilder();
          const entry = docs.get(active.uri);
          const result = await handler.call(thisArg, editor, builder, ...args);
          await applyTextEdits(entry, builder.edits);
          return result;
        });
      },
      executeCommand(id, ...args) {
        if (local.has(id)) return runLocal(id, args);
        if (Object.hasOwn(BUILTIN, id)) return Promise.resolve(BUILTIN[id](...args));
        return Promise.reject(unsupported(`the command "${id}"`, "only this extension's own commands run"));
      },
      getCommands: () => Promise.resolve([...local.keys()]),
      registerDiffInformationCommand: unsupportedFn("commands.registerDiffInformationCommand"),
    };

    // --- Window --------------------------------------------------------------------------------------
    const message = (level) => (text, ...items) => {
      const shown = typeof text === "string" ? text : String(text);
      const choices = items.filter((item) => typeof item === "string" || (item && typeof item.title === "string"));
      const suffix = choices.length ? ` [${choices.map((c) => (typeof c === "string" ? c : c.title)).join(", ")}: buttons are not supported]` : "";
      return call("window.showMessage", { level, message: shown + suffix }).then(() => undefined);
    };
    const channels = new Map();
    const outputChannel = (name, options) => {
      const prefix = `[${String(name)}] `;
      let line = "";
      const write = (level, text) => post({ type: "log", level, text: prefix + text });
      const channel = {
        name: String(name),
        append(text) {
          line += String(text);
          const parts = line.split("\n");
          line = parts.pop();
          for (const one of parts) write("info", one);
        },
        appendLine(text) {
          write("info", line + String(text));
          line = "";
        },
        replace(text) {
          line = "";
          channel.append(text);
        },
        clear() {},
        show() {},
        hide() {},
        dispose() {
          channels.delete(name);
        },
      };
      if (options && (options.log === true || options === true)) {
        Object.assign(channel, {
          logLevel: enums.LogLevel.Info,
          onDidChangeLogLevel: never,
          trace: (m, ...a) => write("info", format(m, ...a)),
          debug: (m, ...a) => write("info", format(m, ...a)),
          info: (m, ...a) => write("info", format(m, ...a)),
          warn: (m, ...a) => write("warn", format(m, ...a)),
          error: (m, ...a) => write("error", m instanceof Error ? m.message : format(m, ...a)),
        });
      }
      channels.set(name, channel);
      return channel;
    };
    let nextStatus = 1;
    const statusItems = new Map();
    // The window's focus (EXT-27): read at activation, then followed; null until the window says.
    let windowFocused = null;
    const windowStateChanged = new EventEmitter();
    const followWindowState = async () => {
      const state = await call("window.state", null).catch(() => null);
      windowFocused = state && typeof state.focused === "boolean" ? state.focused : null;
      on("window.state")((payload) => {
        const focused = payload && typeof payload.focused === "boolean" ? payload.focused : null;
        if (focused === null || focused === windowFocused) return;
        windowFocused = focused;
        windowStateChanged.fire(Object.freeze({ focused, active: focused }));
      });
    };
    const statusText = (text) => String(text || "").replace(/\$\([a-z0-9-~]+\)/gi, "").replace(/\s+/g, " ").trim();
    const statusItem = (a, b, c) => {
      const id = `${init.extensionId}#status#${nextStatus++}`;
      const alignment = typeof a === "string" ? b : a;
      const priority = typeof a === "string" ? c : b;
      let shown = false;
      let pending = false;
      const item = {
        id: typeof a === "string" ? a : id,
        alignment: alignment ?? enums.StatusBarAlignment.Left,
        priority,
        name: undefined,
        text: "",
        tooltip: undefined,
        color: undefined,
        backgroundColor: undefined,
        command: undefined,
        accessibilityInformation: undefined,
        show() {
          shown = true;
          send();
        },
        hide() {
          shown = false;
          call("statusBar.remove", { id }).catch(() => {});
        },
        dispose() {
          item.hide();
          statusItems.delete(id);
        },
      };
      const send = () => {
        if (pending) return;
        pending = true;
        Promise.resolve().then(() => {
          pending = false;
          if (!shown) return;
          const tooltip = item.tooltip && typeof item.tooltip === "object" ? item.tooltip.value : item.tooltip;
          call("statusBar.set", {
            id,
            text: (statusText(item.text) || item.name || "").slice(0, 100),
            tooltip: tooltip ? String(tooltip).slice(0, 500) : null,
            alignment: item.alignment === enums.StatusBarAlignment.Right ? "right" : "left",
            priority: typeof item.priority === "number" ? item.priority : 0,
            clickable: !!item.command,
          }).catch(() => {});
        });
      };
      const live = new Proxy(item, {
        set(target, key, value) {
          target[key] = value;
          if (shown && ["text", "tooltip", "command", "name"].includes(key)) send();
          return true;
        },
      });
      statusItems.set(id, live);
      return live;
    };
    const showDocument = async (target, options) => {
      const uri = target && target.uri ? target.uri : target;
      const selection = options && options.selection ? toYavinRange(options.selection) : null;
      await call("editor.openLocation", { uri: uriText(uri), range: selection });
      await refreshActive();
      return activeEditor();
    };
    const treeViews = new Map();
    const registerTree = (viewId, provider) => {
      const mappedId = Object.entries(meta.views || {}).find(([, original]) => original === viewId)?.[0];
      if (!mappedId) throw unsupported(`the view "${viewId}"`, "it is not one the extension contributes");
      const items = async () => {
        await refreshActive();
        let budget = 1000;
        const rows = async (element, depth) => {
          const children = (await provider.getChildren(element)) || [];
          const out = [];
          for (const child of children) {
            if (budget-- <= 0) break;
            const item = await provider.getTreeItem(child);
            const label = typeof item.label === "string" ? item.label : item.label && item.label.label ? item.label.label : item.resourceUri ? posix.basename(item.resourceUri.path) : "";
            const row = { label: label || "(unnamed)" };
            if (typeof item.description === "string") row.description = item.description;
            const tooltip = item.tooltip && typeof item.tooltip === "object" ? item.tooltip.value : item.tooltip;
            if (typeof tooltip === "string") row.tooltip = tooltip;
            const command = item.command && toYavin.get(item.command.command);
            if (command && !(item.command.arguments && item.command.arguments.length)) row.command = command;
            if (depth < 2 && item.collapsibleState && item.collapsibleState !== TreeItemCollapsibleState.None) row.children = await rows(child, depth + 1);
            out.push(row);
          }
          return out;
        };
        return rows(undefined, 0);
      };
      const changes = provider.onDidChangeTreeData;
      const registration = yavin.views.registerView(mappedId, {
        getItems: items,
        onDidChange: typeof changes === "function" ? (listener) => changes(() => listener()) : undefined,
      });
      treeViews.set(viewId, registration);
      return registration;
    };
    // --- EXT-29: pickers, file watchers, save and selection events, diagnostics, formatting -------
    //
    // Each is a protocol request or event checked natively and in the window, as everything else:
    // a picker's id is the extension's own (`<id>#prompt#n`), a diagnostic collection's too
    // (`<id>#diagnostics#n`); file events need `workspace.fs.read`, save and selection events
    // `documents.read`. What VS Code documents and Yavin does not do is said in vscodeApi.json.
    const tokenSubscription = (token, onCancel) =>
      token && typeof token.onCancellationRequested === "function" ? token.onCancellationRequested(onCancel) : null;
    let nextPrompt = 1;
    /**
     * The window's answer to the prompt `id` -- or null as soon as `token` is cancelled (as VS
     * Code: the promise settles then); the window is told to close the prompt, its late answer
     * is dropped.
     */
    const promptAnswer = (id, token, ask) =>
      new Promise((resolve, reject) => {
        const cancelled = tokenSubscription(token, () => {
          call("window.cancelPrompt", { id }).catch(() => {});
          resolve(null);
        });
        ask().then(resolve, reject).finally(() => cancelled && cancelled.dispose());
      });
    /** Input boxes waiting with a validateInput (asked by the window, as the user types). */
    const validators = new Map();
    const text500 = (value) => (value === undefined || value === null ? undefined : String(value).slice(0, 500));
    async function showQuickPick(items, options, token) {
      const o = options || {};
      const list = await Promise.resolve(items);
      if (!Array.isArray(list)) throw new TypeError("showQuickPick's items are a list, or a promise of one.");
      if (token && token.isCancellationRequested) return undefined;
      const entries = list.slice(0, 5000);
      const wire = entries.map((item) => {
        if (typeof item === "string") return { label: item.slice(0, 500) };
        const one = item || {};
        const out = { label: String(one.label ?? "").slice(0, 500) };
        if (one.description !== undefined) out.description = text500(one.description);
        if (one.detail !== undefined) out.detail = text500(one.detail);
        if (one.picked) out.picked = true;
        if (one.kind === enums.QuickPickItemKind.Separator) out.separator = true;
        return out;
      });
      const id = `${init.extensionId}#prompt#${nextPrompt++}`;
      const answer = await promptAnswer(id, token, () =>
        call("window.quickPick", {
          id,
          title: text500(o.title),
          placeHolder: text500(o.placeHolder),
          canPickMany: !!o.canPickMany,
          matchOnDescription: !!o.matchOnDescription,
          matchOnDetail: !!o.matchOnDetail,
          ignoreFocusOut: !!o.ignoreFocusOut,
          items: wire,
        }),
      );
      if (answer === null || answer === undefined) return undefined;
      const valid = (i) => Number.isInteger(i) && i >= 0 && i < entries.length && !wire[i].separator;
      if (o.canPickMany) return (Array.isArray(answer) ? answer : []).filter(valid).map((i) => entries[i]);
      return valid(answer) ? entries[answer] : undefined;
    }
    async function showInputBox(options, token) {
      const o = options || {};
      if (token && token.isCancellationRequested) return undefined;
      const id = `${init.extensionId}#prompt#${nextPrompt++}`;
      if (typeof o.validateInput === "function") validators.set(id, o.validateInput);
      const selection = Array.isArray(o.valueSelection) && o.valueSelection.length === 2 && o.valueSelection.every(Number.isInteger) ? o.valueSelection : undefined;
      try {
        const answer = await promptAnswer(id, token, () =>
          call("window.inputBox", {
          id,
          title: text500(o.title),
          prompt: text500(o.prompt),
          placeHolder: text500(o.placeHolder),
          value: o.value === undefined ? "" : String(o.value).slice(0, 10000),
          valueSelection: selection,
          password: !!o.password,
          ignoreFocusOut: !!o.ignoreFocusOut,
          validates: validators.has(id),
          }),
        );
        return typeof answer === "string" ? answer : undefined;
      } finally {
        validators.delete(id);
      }
    }
    const SEVERITIES = { 1: "info", 2: "warning", 3: "error" };
    /** validateInput's answer, as the window shows it: null (valid), or a message and severity. */
    async function validatePrompt(id, value) {
      const validate = validators.get(id);
      if (!validate) return null;
      const result = await validate(String(value));
      if (result === undefined || result === null || result === "") return null;
      if (typeof result === "string") return { message: result.slice(0, 500), severity: "error" };
      if (typeof result === "object" && typeof result.message === "string")
        return result.message ? { message: result.message.slice(0, 500), severity: SEVERITIES[result.severity] || "error" } : null;
      return null;
    }

    // Globs, as VS Code matches them: `*` and `?` within a segment, `**` across segments, `{a,b}`
    // alternatives, `[...]` classes; paths with `/`, compared case-insensitively (Windows).
    const globCache = new Map();
    const globRegex = (glob) => {
      if (globCache.has(glob)) return globCache.get(glob);
      let out = "";
      let inGroup = 0;
      for (let i = 0; i < glob.length; i++) {
        const c = glob[i];
        if (c === "*") {
          if (glob[i + 1] === "*") {
            const slashAfter = glob[i + 2] === "/";
            const atStart = i === 0 || glob[i - 1] === "/";
            if (atStart && slashAfter) {
              out += "(?:[^/]*(?:/|$))*";
              i += 2;
            } else if (atStart && i + 2 === glob.length) {
              out += ".*";
              i += 1;
            } else {
              out += "[^/]*";
              i += 1;
            }
          } else out += "[^/]*";
        } else if (c === "?") out += "[^/]";
        else if (c === "{") {
          out += "(?:";
          inGroup++;
        } else if (c === "}" && inGroup) {
          out += ")";
          inGroup--;
        } else if (c === "," && inGroup) out += "|";
        else if (c === "[") {
          const end = glob.indexOf("]", i + 1);
          if (end === -1) out += "\\[";
          else {
            let body = glob.slice(i + 1, end).replace(/\\/g, "\\\\");
            if (body[0] === "!") body = "^" + body.slice(1);
            out += `[${body}]`;
            i = end;
          }
        } else out += /[.+^$()|\\]/.test(c) ? `\\${c}` : c;
      }
      const regex = new RegExp("^" + out + "$", "i");
      if (globCache.size > 200) globCache.clear();
      globCache.set(glob, regex);
      return regex;
    };
    const slashPath = (uri) => uri.fsPath.replace(/\\/g, "/");
    /** A watcher's pattern as a test of a file's URI. */
    const patternTest = (pattern) => {
      if (typeof pattern === "string") {
        const regex = globRegex(pattern.replace(/\\/g, "/"));
        return (uri) => regex.test(slashPath(uri));
      }
      if (pattern && typeof pattern.pattern === "string" && (pattern.baseUri || pattern.base)) {
        const base = (pattern.baseUri instanceof Uri ? pattern.baseUri : Uri.file(String(pattern.base))).fsPath.replace(/\\/g, "/").replace(/\/$/, "");
        const regex = globRegex(pattern.pattern.replace(/\\/g, "/"));
        return (uri) => {
          const path = slashPath(uri);
          if (path.length <= base.length || path.slice(0, base.length).toLowerCase() !== base.toLowerCase() || path[base.length] !== "/") return false;
          return regex.test(path.slice(base.length + 1));
        };
      }
      throw new TypeError("A file system watcher's pattern is a glob string or a RelativePattern.");
    };
    const MAX_WATCHERS = 500;
    const watchers = new Set();
    let followingFiles = false;
    const fileChanged = (payload) => {
      const changes = payload && Array.isArray(payload.changes) ? payload.changes : [];
      for (const change of changes) {
        let uri;
        let from;
        try {
          uri = Uri.parse(String(change.uri));
          from = change.from ? Uri.parse(String(change.from)) : null;
        } catch {
          continue;
        }
        // A rename is, to a watcher, the old name deleted and the new one created (as VS Code).
        const events =
          change.kind === "created" ? [["create", uri]] : change.kind === "modified" ? [["change", uri]] : change.kind === "deleted" ? [["delete", uri]] : change.kind === "renamed" ? [...(from ? [["delete", from]] : []), ["create", uri]] : [];
        // Event by event (a rename's delete before its create), then watcher by watcher.
        for (const [kind, target] of events)
          for (const watcher of [...watchers]) {
            if (watcher.ignore[kind] || !watcher.test(target)) continue;
            try {
              watcher.emitters[kind].fire(target);
            } catch (error) {
              log("error")(`A file system watcher's listener threw: ${error && error.message}`);
            }
          }
      }
    };
    function createFileSystemWatcher(pattern, ignoreCreateEvents, ignoreChangeEvents, ignoreDeleteEvents) {
      const test = patternTest(pattern);
      if (watchers.size >= MAX_WATCHERS) throw new RangeError(`An extension may have at most ${MAX_WATCHERS} file system watchers.`);
      const emitters = { create: new EventEmitter(), change: new EventEmitter(), delete: new EventEmitter() };
      const watcher = {
        test,
        emitters,
        ignore: { create: !!ignoreCreateEvents, change: !!ignoreChangeEvents, delete: !!ignoreDeleteEvents },
      };
      watchers.add(watcher);
      if (!followingFiles) {
        followingFiles = true;
        on("files.change")(fileChanged);
      }
      return Object.freeze({
        ignoreCreateEvents: watcher.ignore.create,
        ignoreChangeEvents: watcher.ignore.change,
        ignoreDeleteEvents: watcher.ignore.delete,
        onDidCreate: emitters.create.event,
        onDidChange: emitters.change.event,
        onDidDelete: emitters.delete.event,
        dispose() {
          watchers.delete(watcher);
          for (const emitter of Object.values(emitters)) emitter.dispose();
        },
      });
    }

    // Save events: did-save follows the window; will-save is asked by Yavin before it saves.
    const willSaveListeners = new Set();
    function onWillSaveTextDocument(listener, thisArg, disposables) {
      const entry = { listener, thisArg };
      willSaveListeners.add(entry);
      // Followed so that Yavin asks this extension before saving (checked as documents.read).
      on("documents.willSave")(() => {});
      const registration = new Disposable(() => willSaveListeners.delete(entry));
      if (Array.isArray(disposables)) disposables.push(registration);
      return registration;
    }
    const REASONS = { manual: enums.TextDocumentSaveReason.Manual, afterDelay: enums.TextDocumentSaveReason.AfterDelay, focusOut: enums.TextDocumentSaveReason.FocusOut };
    /** Yavin is about to save `info`: the listeners' waitUntil edits, for that document only. */
    async function willSave(params) {
      const info = params && params.document;
      if (!info || !willSaveListeners.size) return { edits: [] };
      const entry = await documentFor(info);
      if (!entry) return { edits: [] };
      const waits = [];
      for (const { listener, thisArg } of [...willSaveListeners]) {
        let open = true;
        const event = Object.freeze({
          document: entry.document,
          reason: REASONS[params.reason] || enums.TextDocumentSaveReason.Manual,
          waitUntil(thenable) {
            // As VS Code: only while the listener runs, not later.
            if (!open) throw new Error("waitUntil can only be called synchronously");
            waits.push(Promise.resolve(thenable));
          },
        });
        try {
          listener.call(thisArg, event);
        } catch (error) {
          log("error")(`An onWillSaveTextDocument listener threw: ${error && error.message}`);
        }
        open = false;
      }
      const edits = [];
      for (const result of await Promise.allSettled(waits)) {
        if (result.status !== "fulfilled" || !Array.isArray(result.value)) continue;
        for (const one of result.value)
          if (one && one.range && typeof one.newText === "string" && edits.length < 1000) edits.push({ range: toYavinRange(one.range), text: one.newText });
      }
      return { edits };
    }
    const KINDS_OF_SELECTION = { keyboard: enums.TextEditorSelectionChangeKind.Keyboard, mouse: enums.TextEditorSelectionChangeKind.Mouse, command: enums.TextEditorSelectionChangeKind.Command };
    const selectionOf = (range) => {
      const r = toVsRange(range);
      return range.reversed ? new Selection(r.end, r.start) : new Selection(r.start, r.end);
    };

    // Diagnostics: Yavin's Problems view (and the editor's markers), owned by the collection.
    let nextCollection = 1;
    const SEVERITY_NAMES = ["error", "warning", "info", "hint"];
    const diagnosticCode = (code) => {
      if (code === undefined || code === null) return undefined;
      if (typeof code === "string" || typeof code === "number") return { value: String(code).slice(0, 200) };
      if (typeof code === "object" && (typeof code.value === "string" || typeof code.value === "number"))
        return { value: String(code.value).slice(0, 200), target: code.target ? uriText(code.target) : undefined };
      return undefined;
    };
    const diagnosticOut = (d) => {
      const out = {
        range: toYavinRange(d.range),
        message: String(d.message ?? "").slice(0, 2000),
        severity: SEVERITY_NAMES[d.severity === undefined ? 0 : d.severity] || "error",
      };
      if (d.source !== undefined && d.source !== null) out.source = String(d.source).slice(0, 100);
      const code = diagnosticCode(d.code);
      if (code) out.code = code;
      if (Array.isArray(d.tags)) out.tags = d.tags.filter((t) => t === 1 || t === 2).map((t) => (t === 1 ? "unnecessary" : "deprecated"));
      if (Array.isArray(d.relatedInformation))
        out.related = d.relatedInformation
          .filter((r) => r && r.location && r.location.uri && r.location.range)
          .slice(0, 20)
          .map((r) => ({ uri: uriText(r.location.uri), range: toYavinRange(r.location.range), message: String(r.message ?? "").slice(0, 500) }));
      return out;
    };
    const diagnosticCollections = new Set();
    function createDiagnosticCollection(name) {
      const id = `${init.extensionId}#diagnostics#${nextCollection++}`;
      const byUri = new Map();
      let disposed = false;
      let queued = null;
      // Changes in one turn go as one request (in parts of 200 URIs): a set of many files is not
      // a flood of requests.
      const flush = () => {
        // A clear() or dispose() in the same turn dropped what was queued: nothing to send.
        if (!queued) return;
        const entries = [...queued.values()];
        queued = null;
        for (let i = 0; i < entries.length; i += 200)
          call("diagnostics.set", { collection: id, name: String(name || "").slice(0, 100) || undefined, entries: entries.slice(i, i + 200) }).catch((error) =>
            log("error")(`Diagnostics were not shown: ${error && error.message}`),
          );
      };
      const push = (text, list) => {
        if (disposed) return;
        if (!queued) {
          queued = new Map();
          queueMicrotask(flush);
        }
        queued.set(text, { uri: text, diagnostics: list.slice(0, 1000).map(diagnosticOut) });
      };
      const collection = {
        get name() { return name || id; },
        set(a, b) {
          if (disposed) return;
          if (Array.isArray(a)) {
            // [[uri, diagnostics]]: entries for one URI add up; undefined clears it (as VS Code).
            const merged = new Map();
            for (const [uri, list] of a) {
              const text = uriText(uri);
              if (!list) merged.set(text, { uri, diagnostics: [] });
              else {
                const prior = merged.get(text);
                merged.set(text, { uri, diagnostics: [...(prior ? prior.diagnostics : []), ...list] });
              }
            }
            for (const [text, value] of merged) {
              byUri.set(text, value);
              push(text, value.diagnostics);
            }
            return;
          }
          const text = uriText(a);
          const diagnostics = b ? [...b] : [];
          if (diagnostics.length) byUri.set(text, { uri: a, diagnostics });
          else byUri.delete(text);
          push(text, diagnostics);
        },
        delete(uri) {
          const text = uriText(uri);
          byUri.delete(text);
          push(text, []);
        },
        clear() {
          if (disposed) return;
          byUri.clear();
          queued = null;
          call("diagnostics.clear", { collection: id }).catch(() => {});
        },
        get: (uri) => {
          const found = byUri.get(uriText(uri));
          return found ? Object.freeze([...found.diagnostics]) : undefined;
        },
        has: (uri) => byUri.has(uriText(uri)),
        forEach(callback, thisArg) {
          for (const { uri, diagnostics } of [...byUri.values()]) callback.call(thisArg, uri, diagnostics, collection);
        },
        dispose() {
          if (disposed) return;
          collection.clear();
          disposed = true;
          diagnosticCollections.delete(collection);
        },
        [Symbol.iterator]: function* () {
          for (const { uri, diagnostics } of [...byUri.values()]) yield [uri, diagnostics];
        },
      };
      diagnosticCollections.add(collection);
      return collection;
    }
    /** The extension's own Diagnostic objects for a range Yavin sends (a code action's context). */
    const contextDiagnostics = (uri, wire) => {
      const own = [];
      for (const collection of diagnosticCollections) {
        const list = collection.get(uri);
        if (list) own.push(...list);
      }
      return (Array.isArray(wire) ? wire : []).slice(0, 200).map((d) => {
        const range = toVsRange(d.range);
        const match = own.find((o) => o.range && o.range.isEqual(range) && o.message === d.message);
        if (match) return match;
        const out = new Diagnostic(range, String(d.message ?? ""), { error: 0, warning: 1, info: 2, hint: 3 }[d.severity] ?? 0);
        if (d.source) out.source = d.source;
        if (d.code !== undefined) out.code = d.code;
        return out;
      });
    };

    // Providers' cancellation: Yavin says when it stops waiting; the token is cancelled then.
    const providerTokens = new Map();
    const tokenFor = (extra) => {
      const key = extra && extra.token;
      if (typeof key !== "string") return neverCancelled;
      const source = new CancellationTokenSource();
      providerTokens.set(key, source);
      if (providerTokens.size > 500) providerTokens.delete(providerTokens.keys().next().value);
      return source.token;
    };
    const releaseToken = (extra) => {
      if (extra && typeof extra.token === "string") providerTokens.delete(extra.token);
    };
    const formattingOptions = (extra) => {
      const o = (extra && extra.options) || {};
      return { tabSize: Number.isInteger(o.tabSize) && o.tabSize > 0 && o.tabSize <= 32 ? o.tabSize : 4, insertSpaces: o.insertSpaces !== false };
    };
    /** A provider's TextEdits, as Yavin takes them; anything else in the list is dropped. */
    const editsOut = (value) => {
      const out = [];
      let size = 0;
      for (const one of Array.isArray(value) ? value : []) {
        if (!one || !one.range || typeof one.newText !== "string" || !one.range.start || !one.range.end) continue;
        size += one.newText.length;
        if (out.length >= 5000 || size > 4 * 1024 * 1024) break;
        out.push({ range: toYavinRange(one.range), text: one.newText });
      }
      return out;
    };
    // The code actions offered last (by handle), for running the one chosen: its command.
    const offeredActions = new Map();
    let nextAction = 1;
    const commandOf = (value) => (value && typeof value.command === "string" ? { command: value.command, arguments: Array.isArray(value.arguments) ? value.arguments : [] } : null);
    const actionsOut = (uri, list) => {
      const out = [];
      for (const one of Array.isArray(list) ? list.slice(0, 200) : []) {
        if (!one || typeof one.title !== "string") continue;
        // A Command (title, command), or a CodeAction (title, kind, edit, command, ...).
        const isCommand = typeof one.command === "string";
        const command = isCommand ? commandOf(one) : commandOf(one.command);
        const action = { title: one.title.slice(0, 300) };
        if (!isCommand) {
          if (one.kind && typeof one.kind.value === "string") action.kind = one.kind.value;
          if (one.isPreferred) action.isPreferred = true;
          if (one.disabled && typeof one.disabled.reason === "string") action.disabled = one.disabled.reason.slice(0, 300);
          if (one.edit instanceof WorkspaceEdit) {
            // Text edits of the document asked about only (see vscodeApi.json); file operations
            // and other documents make the action one Yavin does not apply.
            const entries = one.edit.entries();
            const others = entries.some(([target]) => uriText(target) !== uri) || one.edit._files.length > 0;
            if (others) action.unsupported = "it edits other files";
            const mine = entries.find(([target]) => uriText(target) === uri);
            action.edits = mine ? editsOut(mine[1]) : [];
          }
          if (Array.isArray(one.diagnostics)) action.diagnostics = one.diagnostics.slice(0, 50).map(diagnosticOut);
        }
        if (command) {
          const handle = nextAction++;
          offeredActions.set(handle, command);
          if (offeredActions.size > 500) offeredActions.delete(offeredActions.keys().next().value);
          action.command = handle;
        }
        out.push(action);
      }
      return out;
    };

    const windowApi = {
      showInformationMessage: message("info"),
      showWarningMessage: message("warning"),
      showErrorMessage: message("error"),
      createOutputChannel: outputChannel,
      createStatusBarItem: statusItem,
      setStatusBarMessage(text, hide) {
        const item = statusItem(enums.StatusBarAlignment.Left, -1000);
        item.text = text;
        item.show();
        const done = new Disposable(() => item.dispose());
        if (typeof hide === "number") setTimeout(() => done.dispose(), hide);
        else if (hide && typeof hide.then === "function") hide.then(() => done.dispose(), () => done.dispose());
        return done;
      },
      get activeTextEditor() {
        return activeEditor();
      },
      get visibleTextEditors() {
        const editor = activeEditor();
        return editor ? [editor] : [];
      },
      onDidChangeActiveTextEditor: (listener, thisArg, disposables) =>
        subscribe("editor.active", async (payload) => {
          if (payload) await documentFor(payload.document);
          active = payload ? { uri: payload.document.uri, selection: payload.selection } : null;
          listener.call(thisArg, activeEditor());
        }, disposables),
      onDidChangeVisibleTextEditors: (listener, thisArg, disposables) =>
        subscribe("editor.active", async (payload) => {
          if (payload) await documentFor(payload.document);
          active = payload ? { uri: payload.document.uri, selection: payload.selection } : null;
          listener.call(thisArg, windowApi.visibleTextEditors);
        }, disposables),
      showTextDocument: showDocument,
      createTextEditorDecorationType(options) {
        const o = options || {};
        const key = `vscode-${nextKey++}`;
        const decoration = String(o.textDecoration || "");
        const style = /underline|wavy/.test(decoration) ? "underline-info" : typeof o.opacity === "string" && parseFloat(o.opacity) < 1 ? "dimmed" : "highlight";
        return {
          key,
          _style: style,
          dispose() {
            for (const uri of decorationKeys.get(key) || []) call("editor.setDecorations", { uri, key, decorations: [] }).catch(() => {});
            decorationKeys.delete(key);
          },
        };
      },
      registerTreeDataProvider: registerTree,
      createTreeView(viewId, options) {
        const registration = registerTree(viewId, options.treeDataProvider);
        return {
          visible: true,
          selection: [],
          onDidChangeVisibility: never,
          onDidChangeSelection: never,
          onDidExpandElement: never,
          onDidCollapseElement: never,
          onDidChangeCheckboxState: never,
          reveal: unsupportedAsync("TreeView.reveal"),
          message: undefined,
          title: undefined,
          description: undefined,
          badge: undefined,
          dispose: () => registration.dispose(),
        };
      },
      // EXT-27: the window's real focus (the window reports it; a change fires the event once).
      get state() {
        if (windowFocused === null) throw unsupported("window.state", "this window does not report whether it is focused");
        return Object.freeze({ focused: windowFocused, active: windowFocused });
      },
      onDidChangeWindowState: windowStateChanged.event,
      // EXT-29: Yavin's picker and input box, in its own style (one at a time per window).
      showQuickPick,
      showInputBox,
      onDidChangeTextEditorSelection: (listener, thisArg, disposables) =>
        subscribe("editor.selection", async (payload) => {
          if (!payload || typeof payload.uri !== "string" || !Array.isArray(payload.selections) || !payload.selections.length) return;
          if (!active || active.uri !== payload.uri) await refreshActive();
          if (!active || active.uri !== payload.uri) return;
          active = { uri: payload.uri, selection: payload.selections[0] };
          const editor = activeEditor();
          if (!editor) return;
          listener.call(thisArg, { textEditor: editor, selections: payload.selections.slice(0, 100).map(selectionOf), kind: KINDS_OF_SELECTION[payload.kind] });
        }, disposables),
      withProgress(options, task) {
        const source = new CancellationTokenSource();
        return Promise.resolve(task({ report() {} }, source.token));
      },
    };
    for (const name of ["showOpenDialog", "showSaveDialog", "showWorkspaceFolderPick", "createQuickPick", "createInputBox", "createWebviewPanel", "registerWebviewPanelSerializer", "registerWebviewViewProvider", "registerCustomEditorProvider", "createTerminal", "registerTerminalLinkProvider", "registerTerminalProfileProvider", "registerUriHandler", "registerFileDecorationProvider", "onDidChangeTextEditorVisibleRanges", "onDidChangeTextEditorOptions", "onDidChangeTextEditorViewColumn", "onDidChangeActiveColorTheme", "onDidChangeActiveTerminal", "onDidOpenTerminal", "onDidCloseTerminal", "showNotebookDocument", "createWebviewTextEditorInset"])
      windowApi[name] = unsupportedFn(`window.${name}`);
    for (const name of ["activeColorTheme", "tabGroups", "terminals", "activeTerminal", "activeNotebookEditor", "visibleNotebookEditors"])
      throwingGetter(windowApi, name, `window.${name}`);

    // --- Workspace ---------------------------------------------------------------------------------
    const folder = init.workspaceFolder ? Uri.file(init.workspaceFolder) : null;
    const folders = folder ? Object.freeze([Object.freeze({ uri: folder, name: posix.basename(folder.path), index: 0 })]) : undefined;
    const relativeOf = (target) => {
      if (!folder) return null;
      const path = target instanceof Uri ? target.path : Uri.file(String(target)).path;
      const root = folder.path.replace(/\/$/, "");
      if (path.toLowerCase() === root.toLowerCase()) return "";
      return path.toLowerCase().startsWith(root.toLowerCase() + "/") ? path.slice(root.length + 1) : null;
    };
    const settings = meta.settings || {}; // yavin -> vscode
    const fromVscode = new Map(Object.entries(settings).map(([yavin, vscode]) => [vscode, yavin]));
    const defaults = meta.defaults || {};
    const missing = new Set();
    const valueOf = (key) => {
      const setting = fromVscode.get(key);
      if (setting && Object.hasOwn(state.configuration, setting)) return { found: true, value: state.configuration[setting] };
      if (Object.hasOwn(defaults, key)) return { found: true, value: JSON.parse(JSON.stringify(defaults[key])) };
      const prefix = key + ".";
      const keys = [...fromVscode.keys(), ...Object.keys(defaults)].filter((k) => k.startsWith(prefix));
      if (!keys.length) return { found: false };
      const object = {};
      for (const k of keys) {
        const parts = k.slice(prefix.length).split(".");
        let at = object;
        for (const part of parts.slice(0, -1)) at = at[part] && typeof at[part] === "object" ? at[part] : (at[part] = {});
        at[parts[parts.length - 1]] = valueOf(k).value;
      }
      return { found: true, value: object };
    };
    const configuration = (section) => {
      const prefix = section ? `${section}.` : "";
      const config = {
        get(key, fallback) {
          const found = valueOf(prefix + key);
          if (found.found) return found.value;
          if (!missing.has(prefix + key)) {
            missing.add(prefix + key);
            post({ type: "log", level: "warn", text: `The setting "${prefix + key}" is not available in Yavin; ${fallback === undefined ? "undefined is" : "the extension's own default is"} used.` });
          }
          return fallback;
        },
        has: (key) => valueOf(prefix + key).found,
        inspect(key) {
          const full = prefix + key;
          const found = valueOf(full);
          if (!found.found) return undefined;
          return { key: full, defaultValue: Object.hasOwn(defaults, full) ? defaults[full] : undefined, globalValue: found.value };
        },
        update: unsupportedAsync("WorkspaceConfiguration.update", "settings are changed in Yavin's Settings"),
      };
      // Top-level keys of the section are readable as properties, as in VS Code.
      for (const key of [...fromVscode.keys(), ...Object.keys(defaults)]) {
        if (!key.startsWith(prefix)) continue;
        const first = key.slice(prefix.length).split(".")[0];
        if (!(first in config))
          Object.defineProperty(config, first, { enumerable: true, get: () => valueOf(prefix + first).value });
      }
      return Object.freeze(config);
    };
    const subscribers = new Map(); // event -> Set of listeners (already following)
    function subscribe(event, listener, disposables) {
      const registration = on(event)((payload) => {
        Promise.resolve(listener(payload)).catch((error) => log("error")(`A listener of ${event} threw: ${error && error.message}`));
      });
      if (Array.isArray(disposables)) disposables.push(registration);
      return registration;
    }
    const decoder = (bytes) => new TextDecoder().decode(bytes);
    const workspaceApi = {
      get workspaceFolders() { return folders; },
      get rootPath() { return folder ? folder.fsPath : undefined; },
      get name() { return folder ? posix.basename(folder.path) : undefined; },
      workspaceFile: undefined,
      get isTrusted() { return true; },
      onDidGrantWorkspaceTrust: never,
      onDidChangeWorkspaceFolders: never,
      getWorkspaceFolder: (uri) => (relativeOf(uri) === null ? undefined : folders[0]),
      asRelativePath(target, includeFolder) {
        const relative = relativeOf(target);
        if (relative === null) return target instanceof Uri ? target.fsPath : String(target);
        return includeFolder && folders ? `${folders[0].name}/${relative}` : relative;
      },
      getConfiguration: (section) => configuration(section),
      onDidChangeConfiguration: (listener, thisArg, disposables) =>
        subscribe("configuration.changed", (payload) => {
          const setting = `${init.extensionId}.${payload && payload.key}`;
          const key = settings[setting] || "";
          listener.call(thisArg, { affectsConfiguration: (section) => key === section || key.startsWith(section + ".") });
        }, disposables),
      get textDocuments() {
        return [...docs.values()].filter((entry) => !entry.closed).map((entry) => entry.document);
      },
      onDidOpenTextDocument: (listener, thisArg, disposables) =>
        subscribe("documents.open", async (info) => {
          const entry = await documentFor(info);
          if (entry) listener.call(thisArg, entry.document);
        }, disposables),
      onDidChangeTextDocument: (listener, thisArg, disposables) =>
        subscribe("documents.change", async (info) => {
          const before = docs.get(info.uri);
          const old = before ? before.text : "";
          const entry = await documentFor(info);
          if (!entry || entry.text === old) return;
          const lines = linesOf(old);
          const range = new Range(0, 0, lines.length - 1, lines[lines.length - 1].length);
          listener.call(thisArg, { document: entry.document, contentChanges: [{ range, rangeOffset: 0, rangeLength: old.length, text: entry.text }], reason: undefined });
        }, disposables),
      onDidCloseTextDocument: (listener, thisArg, disposables) =>
        subscribe("documents.close", (info) => {
          const entry = docs.get(info.uri);
          if (!entry) return;
          entry.closed = true;
          docs.delete(info.uri);
          listener.call(thisArg, entry.document);
        }, disposables),
      async openTextDocument(target) {
        if (target && typeof target === "object" && !(target instanceof Uri) && !target.scheme)
          throw unsupported("workspace.openTextDocument({content, language})", "untitled documents are made by the user");
        const uri = target instanceof Uri ? target : Uri.file(String(target));
        const key = uri.toString();
        const info = (await ask("documents.get", { uri: key })) || null;
        if (info) {
          const entry = await documentFor(info);
          if (entry) return entry.document;
        }
        const relative = relativeOf(uri);
        if (relative === null) throw new Error(`cannot open ${key}: it is not in the workspace`);
        // Not open in Yavin: its file, read only (a snapshot, not an editable document).
        const text = await call("fs.readFile", { path: relative });
        const entry = { info: { uri: key, languageId: "plaintext", version: 0, source: "disk", dirty: false }, text, closed: false };
        entry.document = textDocument(entry);
        return entry.document;
      },
      createFileSystemWatcher,
      onDidSaveTextDocument: (listener, thisArg, disposables) =>
        subscribe("documents.save", async (info) => {
          const entry = await documentFor(info);
          if (entry) listener.call(thisArg, entry.document);
        }, disposables),
      onWillSaveTextDocument,
      async applyEdit(edit) {
        if (edit._files && edit._files.length) throw unsupported("WorkspaceEdit file operations (create, delete, rename)");
        for (const [uri, edits] of edit.entries()) {
          const info = await ask("documents.get", { uri: uriText(uri) });
          const entry = info && (await documentFor(info));
          if (!entry) return false;
          const ok = await applyTextEdits(entry, edits.map((e) => ({ range: e.range, text: e.newText })));
          if (!ok) return false;
        }
        return true;
      },
      fs: guarded(
        {
          async readFile(uri) {
            const relative = relativeOf(uri);
            if (relative === null) throw FileSystemError.NoPermissions(uri);
            const text = await call("fs.readFile", { path: relative });
            return new TextEncoder().encode(text);
          },
          isWritableFileSystem: (scheme) => (scheme === "file" ? false : undefined),
        },
        "workspace.fs",
      ),
    };
    for (const name of ["findFiles", "saveAll", "registerTextDocumentContentProvider", "registerFileSystemProvider", "registerTaskProvider", "registerNotebookSerializer", "onDidCreateFiles", "onDidDeleteFiles", "onDidRenameFiles", "onWillCreateFiles", "onWillDeleteFiles", "onWillRenameFiles", "openNotebookDocument", "updateWorkspaceFolders", "onDidOpenNotebookDocument", "onDidCloseNotebookDocument", "onDidChangeNotebookDocument", "decode", "encode", "findTextInFiles", "save", "saveAs"])
      workspaceApi[name] = unsupportedFn(`workspace.${name}`);
    throwingGetter(workspaceApi, "notebookDocuments", "workspace.notebookDocuments");
    void decoder;

    // --- Languages ---------------------------------------------------------------------------------
    const languagesOf = (selector) => {
      const list = Array.isArray(selector) ? selector : [selector];
      const out = [];
      for (const one of list) {
        const language = typeof one === "string" ? one : one && one.language;
        if (typeof language === "string" && language !== "*") out.push(language);
        else throw unsupported("a document selector without a language", "Yavin registers providers per language");
      }
      return [...new Set(out)];
    };
    const providerFor = (kind, selector, adapt) => {
      const registrations = languagesOf(selector).map((language) => provider(kind)(language, adapt));
      return new Disposable(() => registrations.forEach((r) => r.dispose()));
    };
    const withDocument = async (document, position, run) => {
      await refreshActive();
      const entry = await documentFor(document);
      if (!entry) return null;
      const pos = position ? new Position(position.line - 1, position.column - 1) : null;
      return run(entry.document, pos);
    };
    const locationsOf = (value) =>
      (Array.isArray(value) ? value : value ? [value] : [])
        .map((one) => {
          const uri = one.targetUri || one.uri;
          const range = one.targetSelectionRange || one.targetRange || one.range;
          return uri && range ? { uri: uriText(uri), range: toYavinRange(range) } : null;
        })
        .filter(Boolean);
    const languagesApi = {
      registerCompletionItemProvider: (selector, provider) =>
        providerFor("completion", selector, {
          provideCompletionItems: (document, position) =>
            withDocument(document, position, async (doc, pos) => {
              const result = await provider.provideCompletionItems(doc, pos, neverCancelled, { triggerKind: 0, triggerCharacter: undefined });
              const items = Array.isArray(result) ? result : result && Array.isArray(result.items) ? result.items : [];
              return items.slice(0, 500).map((item) => {
                const label = typeof item.label === "string" ? item.label : item.label && item.label.label;
                const insert = item.insertText === undefined ? undefined : typeof item.insertText === "string" ? item.insertText : snippetText(item.insertText.value);
                const out = { label: String(label || "") };
                if (insert !== undefined) out.insertText = insert;
                if (typeof item.detail === "string") out.detail = item.detail;
                return out;
              });
            }),
        }),
      registerHoverProvider: (selector, provider) =>
        providerFor("hover", selector, {
          provideHover: (document, position) =>
            withDocument(document, position, async (doc, pos) => {
              const hover = await provider.provideHover(doc, pos, neverCancelled);
              const contents = hover ? hoverText(hover.contents) : "";
              return contents ? { contents } : null;
            }),
        }),
      registerDefinitionProvider: (selector, provider) =>
        providerFor("definition", selector, {
          provideDefinition: (document, position) =>
            withDocument(document, position, async (doc, pos) => locationsOf(await provider.provideDefinition(doc, pos, neverCancelled))),
        }),
      registerReferenceProvider: (selector, provider) =>
        providerFor("references", selector, {
          provideReferences: (document, position) =>
            withDocument(document, position, async (doc, pos) => locationsOf(await provider.provideReferences(doc, pos, { includeDeclaration: true }, neverCancelled))),
        }),
      registerDocumentSymbolProvider: (selector, provider) =>
        providerFor("symbols", selector, {
          provideDocumentSymbols: (document) =>
            withDocument(document, null, async (doc) => {
              const out = [];
              const visit = (list) => {
                for (const one of list || []) {
                  if (out.length >= 2000) return;
                  const range = one.range || (one.location && one.location.range);
                  if (range) out.push({ name: String(one.name), detail: one.detail || one.containerName || undefined, range: toYavinRange(range) });
                  visit(one.children);
                }
              };
              visit(await provider.provideDocumentSymbols(doc, neverCancelled));
              return out;
            }),
        }),
      createDiagnosticCollection,
      registerDocumentFormattingEditProvider: (selector, provider) =>
        providerFor("formatting", selector, {
          provideDocumentFormattingEdits: (document, _position, extra) => {
            // The token exists from the request on: a cancel while the document is fetched counts.
            const token = tokenFor(extra);
            return withDocument(document, null, async (doc) =>
              editsOut(await provider.provideDocumentFormattingEdits(doc, formattingOptions(extra), token)),
            ).finally(() => releaseToken(extra));
          },
        }),
      registerDocumentRangeFormattingEditProvider: (selector, provider) =>
        providerFor("rangeFormatting", selector, {
          provideDocumentRangeFormattingEdits: (document, _position, extra) => {
            if (!extra || !extra.range) return [];
            const token = tokenFor(extra);
            return withDocument(document, null, async (doc) =>
              editsOut(await provider.provideDocumentRangeFormattingEdits(doc, toVsRange(extra.range), formattingOptions(extra), token)),
            ).finally(() => releaseToken(extra));
          },
        }),
      registerCodeActionsProvider: (selector, provider) =>
        providerFor("codeActions", selector, {
          provideCodeActions: (document, _position, extra) => {
            if (!extra || !extra.range) return [];
            const token = tokenFor(extra);
            return withDocument(document, null, async (doc) => {
              const uri = uriText(doc.uri);
              const context = Object.freeze({
                diagnostics: contextDiagnostics(uri, extra.diagnostics),
                only: typeof extra.only === "string" && extra.only ? CodeActionKind.Empty.append(extra.only) : undefined,
                triggerKind: extra.trigger === "automatic" ? enums.CodeActionTriggerKind.Automatic : enums.CodeActionTriggerKind.Invoke,
              });
              const range = toVsRange(extra.range);
              return actionsOut(uri, await provider.provideCodeActions(doc, new Selection(range.start, range.end), context, token));
            }).finally(() => releaseToken(extra));
          },
        }),
      match(selector, document) {
        let best = 0;
        for (const one of Array.isArray(selector) ? selector : [selector]) {
          const language = typeof one === "string" ? one : one && one.language;
          if (language === document.languageId) best = Math.max(best, 10);
          else if (language === "*") best = Math.max(best, 5);
        }
        return best;
      },
    };
    for (const name of ["registerCodeLensProvider", "registerOnTypeFormattingEditProvider", "registerSignatureHelpProvider", "registerRenameProvider", "registerDocumentHighlightProvider", "registerDocumentLinkProvider", "registerColorProvider", "registerFoldingRangeProvider", "registerSelectionRangeProvider", "registerCallHierarchyProvider", "registerTypeHierarchyProvider", "registerDocumentSemanticTokensProvider", "registerDocumentRangeSemanticTokensProvider", "registerInlayHintsProvider", "registerImplementationProvider", "registerTypeDefinitionProvider", "registerDeclarationProvider", "registerWorkspaceSymbolProvider", "registerEvaluatableExpressionProvider", "registerInlineValuesProvider", "registerLinkedEditingRangeProvider", "registerInlineCompletionItemProvider", "registerDocumentDropEditProvider", "setLanguageConfiguration", "getLanguages", "setTextDocumentLanguage", "getDiagnostics", "onDidChangeDiagnostics", "createLanguageStatusItem"])
      languagesApi[name] = unsupportedFn(`languages.${name}`);

    // --- Environment, extensions, l10n ---------------------------------------------------------------
    const envApi = {
      appName: "Yavin IDE",
      appHost: "desktop",
      language: "en",
      uriScheme: "yavin",
      uiKind: enums.UIKind.Desktop,
      remoteName: undefined,
      isNewAppInstall: false,
      isTelemetryEnabled: false,
      onDidChangeTelemetryEnabled: never,
      logLevel: enums.LogLevel.Info,
      onDidChangeLogLevel: never,
      clipboard: Object.freeze({ readText: unsupportedAsync("env.clipboard.readText"), writeText: unsupportedAsync("env.clipboard.writeText") }),
      openExternal: unsupportedAsync("env.openExternal"),
      asExternalUri: unsupportedAsync("env.asExternalUri"),
      createTelemetryLogger: unsupportedFn("env.createTelemetryLogger"),
    };
    for (const name of ["appRoot", "machineId", "sessionId", "shell"]) throwingGetter(envApi, name, `env.${name}`);
    const extensionRoot = init.extensionPath ? win32.join(init.extensionPath, "extension") : "";
    const extensionUri = extensionRoot ? Uri.file(extensionRoot) : undefined;
    const packageJSON = (() => {
      const text = files["extension/package.json"];
      try {
        return text ? JSON.parse(text) : {};
      } catch {
        return {};
      }
    })();
    const ownId = `${packageJSON.publisher || ""}.${packageJSON.name || ""}`;
    const extensionObject = {
      id: ownId,
      extensionUri,
      extensionPath: extensionRoot,
      get isActive() { return true; },
      packageJSON,
      extensionKind: enums.ExtensionKind.Workspace,
      exports: undefined,
      activate: () => Promise.resolve(extensionObject.exports),
    };
    const extensionsApi = {
      getExtension: (id) => (String(id).toLowerCase() === ownId.toLowerCase() ? extensionObject : undefined),
      get all() { return [extensionObject]; },
      onDidChange: never,
    };
    const l10n = {
      t(message, ...args) {
        let text = typeof message === "string" ? message : message && message.message;
        const values = typeof message === "object" && message && message.args ? message.args : args.length === 1 && args[0] && typeof args[0] === "object" ? args[0] : args;
        return String(text).replace(/\{([^}]+)\}/g, (all, key) => (values[key] !== undefined ? String(values[key]) : all));
      },
      bundle: undefined,
      uri: undefined,
    };

    const namespace = (name) =>
      new Proxy({}, {
        get(_, key) {
          if (typeof key === "symbol" || PROBED.has(key)) return undefined;
            if (key in Object.prototype) return Object.prototype[key];
          return unsupportedFn(`${name}.${key}`);
        },
      });
    const api = guarded(
      Object.freeze({
        version: LEVEL,
        commands: guarded(commandsApi, "commands"),
        window: guarded(windowApi, "window"),
        workspace: guarded(workspaceApi, "workspace"),
        languages: guarded(languagesApi, "languages"),
        env: guarded(envApi, "env"),
        extensions: guarded(extensionsApi, "extensions"),
        l10n: guarded(l10n, "l10n"),
        debug: namespace("debug"),
        scm: namespace("scm"),
        tasks: namespace("tasks"),
        tests: namespace("tests"),
        notebooks: namespace("notebooks"),
        comments: namespace("comments"),
        authentication: namespace("authentication"),
        chat: namespace("chat"),
        lm: namespace("lm"),
        Position, Range, Selection, Location, Uri, Disposable, EventEmitter, CancellationTokenSource, CancellationError,
        MarkdownString, SnippetString, CompletionItem, CompletionList, Hover, TextEdit, WorkspaceEdit, Diagnostic,
        DiagnosticRelatedInformation, DocumentSymbol, SymbolInformation, ThemeColor, ThemeIcon, TreeItem, RelativePattern,
        FileSystemError, CodeActionKind, CodeAction, CodeLens, DocumentLink, Color, ColorInformation, ColorPresentation,
        FoldingRange, SelectionRange, SignatureHelp, SignatureInformation, ParameterInformation, InlayHint, DocumentHighlight,
        SemanticTokensLegend, CallHierarchyItem, CallHierarchyIncomingCall, CallHierarchyOutgoingCall, TypeHierarchyItem,
        InlayHintLabelPart, InlineValueText, InlineValueVariableLookup, InlineValueEvaluatableExpression, EvaluatableExpression,
        InlineCompletionItem, InlineCompletionList, LinkedEditingRanges, SemanticTokens, SemanticTokensEdit, SemanticTokensEdits,
        SemanticTokensBuilder, DocumentDropEdit, SnippetTextEdit,
        ...enums,
      }),
      "vscode",
    );

    // --- Entry points Yavin calls --------------------------------------------------------------------
    let exported = null;
    const vscodeContext = () => {
      const storage = (scope) => {
        const base = memento(scope);
        return Object.freeze({
          get: (key, fallback) => {
            const value = base.get(key);
            return value === undefined ? fallback : value;
          },
          keys: base.keys,
          update: base.update,
          setKeysForSync() {},
        });
      };
      const context = {
        subscriptions: [],
        workspaceState: storage("workspace"),
        globalState: storage("global"),
        secrets: Object.freeze({
          get: (key) => call("secrets.get", { key, scope: "installation" }).then((v) => (v === null ? undefined : v)),
          store: (key, value) => call("secrets.store", { key, value, scope: "installation" }).then(() => undefined),
          delete: (key) => call("secrets.delete", { key, scope: "installation" }).then(() => undefined),
          onDidChange: never,
        }),
        extensionUri,
        extensionPath: extensionRoot,
        asAbsolutePath: (relative) => win32.join(extensionRoot, relative),
        extensionMode: enums.ExtensionMode.Production,
        extension: extensionObject,
        languageModelAccessInformation: undefined,
      };
      if (!state.workspace) context.workspaceState = storage("global");
      for (const name of ["storageUri", "storagePath", "globalStorageUri", "globalStoragePath", "logUri", "logPath", "environmentVariableCollection"])
        throwingGetter(context, name, `ExtensionContext.${name}`, "extensions have no folder of their own to write to in Yavin");
      return context;
    };
    return {
      load() {
        exported = loadModule(mainPath, null);
        return exported;
      },
      async activate() {
        // What it reads synchronously -- the open documents, the active editor -- is fetched first.
        const all = (await ask("documents.all", null)) || [];
        for (const info of all.slice(0, 50)) await documentFor(info);
        await refreshActive();
        await followWindowState();
        const context = vscodeContext();
        contextOf.value = context;
        if (!exported || typeof exported.activate !== "function") return undefined;
        const result = await exported.activate(context);
        extensionObject.exports = result;
        return undefined;
      },
      async deactivate() {
        if (exported && typeof exported.deactivate === "function") await exported.deactivate();
        const subscriptions = contextOf.value ? contextOf.value.subscriptions : [];
        const errors = [];
        while (subscriptions.length) {
          try {
            const one = subscriptions.pop();
            if (one && typeof one.dispose === "function") one.dispose();
          } catch (error) {
            errors.push(String(error && error.message ? error.message : error));
          }
        }
        return { disposeErrors: errors };
      },
      // EXT-29: an input box's validateInput, as the user types.
      validate: (params) => validatePrompt(params && params.id, params && params.value),
      willSave,
      runCodeAction(params) {
        const command = offeredActions.get(params && params.handle);
        if (!command) throw Object.assign(new Error("That code action is no longer offered."), { code: "UnknownAction" });
        return commandsApi.executeCommand(command.command, ...command.arguments);
      },
      cancelProvider(params) {
        const source = providerTokens.get(params && params.token);
        if (source) {
          providerTokens.delete(params.token);
          source.cancel();
        }
        return null;
      },
      statusClicked(id) {
        const item = statusItems.get(id);
        if (!item || !item.command) return null;
        const command = typeof item.command === "string" ? { command: item.command, arguments: [] } : item.command;
        return commandsApi.executeCommand(command.command, ...(command.arguments || []));
      },
    };
  }
  const contextOf = { value: null };
