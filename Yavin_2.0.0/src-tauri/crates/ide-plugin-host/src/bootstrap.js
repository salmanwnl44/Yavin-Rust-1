// The extension API inside the host (IDE-08): what one extension's QuickJS context is given.
// Everything it can do is a message to Yavin through `send`; everything Yavin tells it arrives
// through `globalThis.__yavin_receive`. There is nothing else: no require, no fs, no network,
// no process. Timers (EXT-25) are the host's (`__yavin_timer`): each fires as an entry of its
// own. `__YAVIN_INIT__` is replaced by the host with the extension's identity before this runs.
// A VS Code extension's code runs through the compatibility layer (`vscode.js`, EXT-25), which
// the host puts where this file says `__YAVIN_VSCODE__`, after the Web globals (`web.js`) and
// the Intl subset (`intl.js`) it installs (EXT-28).
(function () {
  "use strict";
  const init = __YAVIN_INIT__;
  const send = globalThis.__yavin_send;
  delete globalThis.__yavin_send;
  const setTimer = globalThis.__yavin_timer;
  const clearTimer = globalThis.__yavin_untimer;
  delete globalThis.__yavin_timer;
  delete globalThis.__yavin_untimer;
  // The operating system's random bytes (EXT-28), for the layer's `crypto`: hex, or nothing.
  const random = globalThis.__yavin_random;
  delete globalThis.__yavin_random;
  const ids = {
    extensionId: init.extensionId,
    workspaceId: init.workspaceId,
    hostGeneration: init.hostGeneration,
  };
  const post = (message) => send(JSON.stringify(Object.assign({}, message, ids)));
  let nextRequest = 1;
  const pending = new Map();
  /** Yavin is asked something; the answer resolves the promise (or rejects with its error). */
  const call = (method, params) =>
    new Promise((resolve, reject) => {
      const requestId = `h${nextRequest++}`;
      pending.set(requestId, { resolve, reject });
      post({ type: "request", requestId, method, params: params === undefined ? null : params });
    });
  const failure = (error) => ({
    code: (error && error.code) || "ExtensionError",
    message: String((error && error.message) || error),
  });
  const disposable = (dispose) => {
    let done = false;
    return {
      dispose() {
        if (done) return;
        done = true;
        dispose();
      },
    };
  };

  const commands = new Map();
  const views = new Map();
  const providers = new Map();
  const listeners = new Map();
  let nextProvider = 1;
  let state = { global: {}, workspace: null, configuration: {} };
  let module = { exports: {} };
  let context = null;

  const secretScope = (options) => (options && options.scope === "workspace" ? "workspace" : "installation");
  const memento = (scope) => ({
    get: (key) => (state[scope] ? state[scope][key] : undefined),
    keys: () => (state[scope] ? Object.keys(state[scope]) : []),
    update(key, value) {
      return call("storage.update", { scope, key, value }).then(() => {
        if (!state[scope]) return;
        if (value === undefined) delete state[scope][key];
        else state[scope][key] = JSON.parse(JSON.stringify(value));
      });
    },
  });
  const on = (event) => (listener) => {
    let set = listeners.get(event);
    if (!set) {
      set = new Set();
      listeners.set(event, set);
      // A refusal is logged by Yavin; nothing here waits on it.
      call("events.subscribe", { event }).catch(() => {});
    }
    set.add(listener);
    return disposable(() => set.delete(listener));
  };
  const provider = (kind) => (selector, implementation) => {
    const providerId = `${init.extensionId}#${kind}#${nextProvider++}`;
    providers.set(providerId, implementation);
    const registered = call("languages.register", { kind, providerId, language: String(selector) });
    registered.catch(() => providers.delete(providerId));
    return disposable(() => {
      providers.delete(providerId);
      registered.then(
        () => call("languages.unregister", { providerId }).catch(() => {}),
        () => {},
      );
    });
  };

  // --- Timers and text (EXT-25) ------------------------------------------------------------------
  const timers = new Map();
  let nextTimer = 1;
  /** A timer's handle: a number to the code that adds it, a Node.js `Timeout` to the code that asks. */
  const handle = (id) => ({
    _id: id,
    ref() {
      return this;
    },
    unref() {
      return this;
    },
    hasRef: () => true,
    refresh() {
      return this;
    },
    [Symbol.toPrimitive]: () => id,
  });
  const schedule = (repeat) => (callback, ms, ...args) => {
    if (typeof callback !== "function") throw new TypeError("A timer's callback is a function.");
    const id = nextTimer++;
    if (!setTimer(id, Number(ms) || 0, repeat))
      throw Object.assign(new Error("Too many timers are waiting (the limit is 1000)."), { code: "TooManyTimers" });
    timers.set(id, { callback, args, repeat });
    return handle(id);
  };
  const cancel = (timer) => {
    const id = timer && typeof timer === "object" ? timer._id : Number(timer);
    if (timers.delete(id)) clearTimer(id);
  };
  globalThis.setTimeout = schedule(false);
  globalThis.setInterval = schedule(true);
  globalThis.clearTimeout = cancel;
  globalThis.clearInterval = cancel;
  globalThis.setImmediate = (callback, ...args) => globalThis.setTimeout(callback, 0, ...args);
  globalThis.clearImmediate = cancel;
  if (typeof globalThis.queueMicrotask !== "function")
    globalThis.queueMicrotask = (callback) => {
      Promise.resolve().then(callback);
    };
  class TextEncoder {
    get encoding() {
      return "utf-8";
    }
    encode(text) {
      const bytes = [];
      for (const char of String(text === undefined ? "" : text)) {
        let code = char.codePointAt(0);
        if (code >= 0xd800 && code <= 0xdfff) code = 0xfffd;
        if (code < 0x80) bytes.push(code);
        else if (code < 0x800) bytes.push(0xc0 | (code >> 6), 0x80 | (code & 63));
        else if (code < 0x10000) bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63));
        else bytes.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 63), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63));
      }
      return new Uint8Array(bytes);
    }
  }
  class TextDecoder {
    constructor(label) {
      const name = String(label || "utf-8").toLowerCase();
      if (name !== "utf-8" && name !== "utf8") throw new RangeError(`The encoding "${label}" is not supported.`);
    }
    get encoding() {
      return "utf-8";
    }
    decode(input) {
      if (input === undefined) return "";
      const bytes = input instanceof Uint8Array ? input : new Uint8Array(input.buffer ? input.buffer : input);
      let out = "";
      for (let i = 0; i < bytes.length; ) {
        const b = bytes[i];
        const need = b < 0x80 ? 0 : b >= 0xf0 && b < 0xf8 ? 3 : b >= 0xe0 ? 2 : b >= 0xc0 ? 1 : -1;
        if (need < 0 || i + need >= bytes.length + (need ? 0 : 1)) {
          out += need === 0 ? String.fromCharCode(b) : "\ufffd";
          i++;
          continue;
        }
        let code = need === 0 ? b : b & (0x3f >> need);
        let ok = true;
        for (let k = 1; k <= need; k++) {
          const next = bytes[i + k];
          if ((next & 0xc0) !== 0x80) ok = false;
          code = (code << 6) | (next & 63);
        }
        if (!ok) {
          out += "\ufffd";
          i++;
          continue;
        }
        out += String.fromCodePoint(code);
        i += need + 1;
      }
      return out;
    }
  }
  if (typeof globalThis.TextEncoder !== "function") globalThis.TextEncoder = TextEncoder;
  if (typeof globalThis.TextDecoder !== "function") globalThis.TextDecoder = TextDecoder;
  const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  if (typeof globalThis.btoa !== "function")
    globalThis.btoa = (text) => {
      const s = String(text);
      let out = "";
      for (let i = 0; i < s.length; i += 3) {
        const [a, b, c] = [s.charCodeAt(i), s.charCodeAt(i + 1), s.charCodeAt(i + 2)];
        if (a > 255 || b > 255 || c > 255) throw new Error("btoa: characters outside Latin-1");
        out += BASE64[a >> 2] + BASE64[((a & 3) << 4) | ((b || 0) >> 4)];
        out += i + 1 < s.length ? BASE64[((b & 15) << 2) | ((c || 0) >> 6)] : "=";
        out += i + 2 < s.length ? BASE64[c & 63] : "=";
      }
      return out;
    };
  if (typeof globalThis.atob !== "function")
    globalThis.atob = (text) => {
      const s = String(text).replace(/[\s=]+/g, "");
      let out = "";
      let bits = 0;
      let value = 0;
      for (const char of s) {
        const n = BASE64.indexOf(char);
        if (n < 0) throw new Error("atob: not base64");
        value = (value << 6) | n;
        bits += 6;
        if (bits >= 8) {
          bits -= 8;
          out += String.fromCharCode((value >> bits) & 255);
        }
      }
      return out;
    };

  const yavin = Object.freeze({
    version: init.apiVersion,
    commands: Object.freeze({
      registerCommand(id, handler) {
        if (typeof handler !== "function") throw new TypeError("A command handler is a function.");
        commands.set(id, handler);
        const registered = call("commands.register", { id });
        registered.catch(() => commands.delete(id));
        return disposable(() => {
          commands.delete(id);
          call("commands.unregister", { id }).catch(() => {});
        });
      },
      executeCommand: (id, ...args) => call("commands.execute", { id, args }),
    }),
    window: Object.freeze({
      showInformationMessage: (message) => call("window.showMessage", { level: "info", message: String(message) }),
      showWarningMessage: (message) => call("window.showMessage", { level: "warning", message: String(message) }),
      showErrorMessage: (message) => call("window.showMessage", { level: "error", message: String(message) }),
      createOutputChannel: () => output,
    }),
    workspace: Object.freeze({
      getWorkspaceFolder: () => init.workspaceFolder,
      getConfiguration(section) {
        if (section !== init.extensionId)
          throw new Error(`An extension reads its own settings ("${init.extensionId}").`);
        return Object.freeze({ get: (key) => state.configuration[`${section}.${key}`] });
      },
      onDidChangeConfiguration: on("configuration.changed"),
      fs: Object.freeze({
        readFile: (path) => call("fs.readFile", { path }),
        exists: (path) => call("fs.exists", { path }),
      }),
    }),
    storage: Object.freeze({
      get global() {
        return memento("global");
      },
      get workspace() {
        return state.workspace ? memento("workspace") : null;
      },
    }),
    views: Object.freeze({
      registerView(id, implementation) {
        views.set(id, implementation);
        const registered = call("views.register", { id });
        const changes =
          implementation && typeof implementation.onDidChange === "function"
            ? implementation.onDidChange(() => call("views.refresh", { id }).catch(() => {}))
            : null;
        registered.catch(() => views.delete(id));
        return disposable(() => {
          views.delete(id);
          if (changes && changes.dispose) changes.dispose();
          call("views.unregister", { id }).catch(() => {});
        });
      },
    }),
    documents: Object.freeze({
      get: (uri) => call("documents.get", { uri }),
      getText: (uri) => call("documents.getText", { uri }),
      all: () => call("documents.all", null),
      onDidOpen: on("documents.open"),
      onDidChange: on("documents.change"),
      onDidClose: on("documents.close"),
    }),
    editor: Object.freeze({
      activeEditor: () => call("editor.active", null),
      openLocation: (uri, range) => call("editor.openLocation", { uri, range: range || null }),
      setSelection: (range) => call("editor.setSelection", { range }),
      revealRange: (range) => call("editor.revealRange", { range }),
      setDecorations: (uri, key, decorations) => call("editor.setDecorations", { uri, key, decorations }),
      onDidChangeActiveEditor: on("editor.active"),
    }),
    languages: Object.freeze({
      registerCompletionProvider: provider("completion"),
      registerHoverProvider: provider("hover"),
      registerDefinitionProvider: provider("definition"),
      registerReferenceProvider: provider("references"),
      registerDocumentSymbolProvider: provider("symbols"),
    }),
  });
  const output = Object.freeze({
    appendLine: (text) => post({ type: "log", level: "info", text: String(text) }),
  });
  const log = (level) => (...parts) => post({ type: "log", level, text: parts.map(String).join(" ") });
  globalThis.console = Object.freeze({ log: log("info"), info: log("info"), warn: log("warn"), error: log("error") });

  const reply = (requestId, run) => {
    let result;
    try {
      result = run();
    } catch (error) {
      post({ type: "response", requestId, ok: false, error: failure(error) });
      return;
    }
    Promise.resolve(result).then(
      (value) => post({ type: "response", requestId, ok: true, result: value === undefined ? null : value }),
      (error) => post({ type: "response", requestId, ok: false, error: failure(error) }),
    );
  };

  const methods = {
    activate(params) {
      state = {
        global: params.globalState || {},
        workspace: params.workspaceState || null,
        configuration: params.configuration || {},
      };
      const subscriptions = [];
      context = Object.freeze({
        extensionId: init.extensionId,
        extensionPath: init.extensionPath,
        workspaceFolder: init.workspaceFolder,
        apiVersion: init.apiVersion,
        environment: Object.freeze({ apiVersion: init.apiVersion, hostGeneration: init.hostGeneration }),
        globalState: memento("global"),
        workspaceState: state.workspace ? memento("workspace") : null,
        // Its own secrets (EXT-13): kept by Yavin in the OS credential store, natively -- with
        // the "secrets" permission granted. "installation" (default) or "workspace".
        secrets: Object.freeze({
          get: (key, options) => call("secrets.get", { key, scope: secretScope(options) }),
          store: (key, value, options) =>
            call("secrets.store", { key, value, scope: secretScope(options) }).then(() => undefined),
          delete: (key, options) => call("secrets.delete", { key, scope: secretScope(options) }),
        }),
        subscriptions,
        log: Object.freeze({ info: log("info"), warn: log("warn"), error: log("error") }),
      });
      if (vscodeShim) return vscodeShim.activate();
      if (typeof module.exports.activate !== "function") throw new Error("The extension exports no activate function.");
      return module.exports.activate(context, yavin);
    },
    deactivate() {
      if (vscodeShim) return vscodeShim.deactivate();
      const done = typeof module.exports.deactivate === "function" ? module.exports.deactivate() : undefined;
      return Promise.resolve(done).then(() => {
        const subscriptions = context ? context.subscriptions : [];
        const errors = [];
        while (subscriptions.length) {
          try {
            subscriptions.pop().dispose();
          } catch (error) {
            errors.push(String(error && error.message ? error.message : error));
          }
        }
        return { disposeErrors: errors };
      });
    },
    "command.run"(params) {
      const handler = commands.get(params.id);
      if (!handler) throw Object.assign(new Error(`"${params.id}" has no handler.`), { code: "UnknownCommand" });
      return handler(...(params.args || []));
    },
    // A status bar item of a VS Code extension was clicked (EXT-25): its command, with its arguments.
    "statusBar.activate"(params) {
      return vscodeShim ? vscodeShim.statusClicked(params.id) : null;
    },
    "view.items"(params) {
      const view = views.get(params.id);
      if (!view) throw new Error(`"${params.id}" has no provider.`);
      return view.getItems();
    },
    "provider.invoke"(params) {
      const implementation = providers.get(params.providerId);
      if (!implementation) throw Object.assign(new Error("No such provider."), { code: "UnknownProvider" });
      const method = {
        completion: "provideCompletionItems",
        hover: "provideHover",
        definition: "provideDefinition",
        references: "provideReferences",
        symbols: "provideDocumentSymbols",
        // EXT-29 (VS Code extensions' providers, through the layer).
        formatting: "provideDocumentFormattingEdits",
        rangeFormatting: "provideDocumentRangeFormattingEdits",
        codeActions: "provideCodeActions",
      }[params.kind];
      if (typeof implementation[method] !== "function") return null;
      return implementation[method](params.document, params.position || null, params.extra || null);
    },
    // EXT-29: Yavin stopped waiting for a provider: its cancellation token is cancelled.
    "provider.cancel"(params) {
      return vscodeShim ? vscodeShim.cancelProvider(params) : null;
    },
    // EXT-29: an input box's validation, a save's waitUntil edits, a chosen code action's command.
    "prompt.validate"(params) {
      return vscodeShim ? vscodeShim.validate(params) : null;
    },
    "documents.willSave"(params) {
      return vscodeShim ? vscodeShim.willSave(params) : { edits: [] };
    },
    "codeAction.run"(params) {
      return vscodeShim ? vscodeShim.runCodeAction(params) : null;
    },
  };

/*__YAVIN_VSCODE__*/

  let vscodeShim = null;
  globalThis.__yavin_load = function (source, modules, vscode, main) {
    module = { exports: {} };
    if (init.runtime === "vscode") {
      vscodeShim = vscodeRuntime(JSON.parse(vscode), JSON.parse(modules), main, source);
      vscodeShim.load();
      return;
    }
    const factory = new Function("module", "exports", "yavin", source);
    factory(module, module.exports, yavin);
  };

  globalThis.__yavin_receive = function (text) {
    const message = JSON.parse(text);
    if (message.type === "response") {
      const waiting = pending.get(message.requestId);
      if (!waiting) return;
      pending.delete(message.requestId);
      if (message.ok) waiting.resolve(message.result);
      else {
        const error = new Error((message.error && message.error.message) || "Request failed.");
        error.code = message.error && message.error.code;
        waiting.reject(error);
      }
      return;
    }
    if (message.type === "timer") {
      const timer = timers.get(message.id);
      if (!timer) return;
      if (!timer.repeat) timers.delete(message.id);
      try {
        timer.callback(...timer.args);
      } catch (error) {
        log("error")(`A timer threw: ${error && error.message}`);
      }
      return;
    }
    if (message.type === "event") {
      if (message.event === "configuration.changed" && message.payload && message.payload.values)
        state.configuration = message.payload.values;
      for (const listener of listeners.get(message.event) || []) {
        try {
          listener(message.payload);
        } catch (error) {
          log("error")(`A listener of ${message.event} threw: ${error && error.message}`);
        }
      }
      return;
    }
    if (message.type === "request") {
      const method = methods[message.method];
      if (!method) {
        post({ type: "response", requestId: message.requestId, ok: false, error: { code: "UnknownMethod", message: message.method } });
        return;
      }
      reply(message.requestId, () => method(message.params || {}));
      return;
    }
  };
})();
