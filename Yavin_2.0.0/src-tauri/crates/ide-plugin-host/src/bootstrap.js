// The extension API inside the host (IDE-08): what one extension's QuickJS context is given.
// Everything it can do is a message to Yavin through `send`; everything Yavin tells it arrives
// through `globalThis.__yavin_receive`. There is nothing else: no require, no fs, no network,
// no process, no timers that outlive a call. `__YAVIN_INIT__` is replaced by the host with the
// extension's identity before this runs.
(function () {
  "use strict";
  const init = __YAVIN_INIT__;
  const send = globalThis.__yavin_send;
  delete globalThis.__yavin_send;
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
        subscriptions,
        log: Object.freeze({ info: log("info"), warn: log("warn"), error: log("error") }),
      });
      if (typeof module.exports.activate !== "function") throw new Error("The extension exports no activate function.");
      return module.exports.activate(context, yavin);
    },
    deactivate() {
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
      }[params.kind];
      if (typeof implementation[method] !== "function") return null;
      return implementation[method](params.document, params.position || null);
    },
  };

  globalThis.__yavin_load = function (source) {
    module = { exports: {} };
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
