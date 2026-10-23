// EXT-32: what runs first in an extension's worker (`worker.rs`) -- a QuickJS runtime of its own,
// started by that extension's `new Worker(...)`. It has a worker's global scope and nothing more:
// it speaks only to the extension that started it (`postMessage`, `onmessage`), through the host.
// It cannot ask Yavin anything -- no requests, no events, no files, no network, no workers of its
// own. The host puts in it, where it is marked below: the extension bootstrap's timers and text
// (`bootstrap.js`, between its marks), the Web globals and the Intl subset (`web.js`, `intl.js`),
// and the worker's script address, name and message bound.
(function () {
  "use strict";
  const init = __YAVIN_WORKER_INIT__;
  const send = globalThis.__yavin_worker_send;
  const setTimer = globalThis.__yavin_timer;
  const clearTimer = globalThis.__yavin_untimer;
  const random = globalThis.__yavin_random;
  for (const name of ["__yavin_worker_send", "__yavin_timer", "__yavin_untimer", "__yavin_random"]) delete globalThis[name];
  /** To the owner, through the host: false when the host refused it (too large, too many waiting). */
  const out = (message) => send(JSON.stringify(message));
  let closed = false;

/*__YAVIN_PLATFORM__*/

  const reported = new Set();
  /** The error for what a worker does not have (said once to the extension's log). */
  const unsupported = (what, why) => {
    const message = `UnsupportedApi: ${what} is not supported in Yavin's workers${why ? ` (${why})` : ""}.`;
    if (!reported.has(what)) {
      reported.add(what);
      out({ kind: "log", level: "warn", text: message });
    }
    const error = new Error(message);
    error.name = "UnsupportedApi";
    error.code = "UnsupportedApi";
    return error;
  };

/*__YAVIN_WEB__*/

  if (typeof webRuntime === "function") webRuntime({ random, unsupported, report: (text) => out({ kind: "log", level: "error", text }) });
  if (typeof intlRuntime === "function") intlRuntime({ unsupported });

  const log = (level) => (...parts) => {
    out({ kind: "log", level, text: parts.map(String).join(" ").slice(0, 4000) });
  };
  globalThis.console = Object.freeze({
    log: log("info"),
    info: log("info"),
    debug: log("info"),
    warn: log("warn"),
    error: log("error"),
    trace: (...parts) => log("info")("Trace:", ...parts, `\n${new Error().stack ?? ""}`),
  });

  // --- The worker's global scope -------------------------------------------------------------------
  globalThis.self = globalThis;
  globalThis.name = String(init.name || "");
  const address = (() => {
    try {
      return new URL(init.url);
    } catch {
      return null;
    }
  })();
  globalThis.location = Object.freeze({
    href: address ? address.href : String(init.url),
    protocol: address ? address.protocol : "",
    host: address ? address.host : "",
    hostname: address ? address.hostname : "",
    port: address ? address.port : "",
    pathname: address ? address.pathname : "",
    search: address ? address.search : "",
    hash: address ? address.hash : "",
    origin: "null",
    toString() {
      return this.href;
    },
  });
  globalThis.importScripts = function () {
    throw unsupported("importScripts", "a worker's code is one script of its extension's package");
  };
  // No network: a worker's fetch fails as a browser's does when it cannot connect.
  globalThis.fetch = () => Promise.reject(new TypeError("Failed to fetch: Yavin's workers have no network access."));

  const listeners = { message: new Set(), messageerror: new Set(), error: new Set() };
  const handlers = { message: null, messageerror: null, error: null };
  for (const type of Object.keys(handlers))
    Object.defineProperty(globalThis, `on${type}`, {
      get: () => handlers[type],
      set: (value) => {
        handlers[type] = typeof value === "function" ? value : null;
      },
      configurable: true,
    });
  globalThis.addEventListener = (type, listener) => {
    if (listeners[type] && (typeof listener === "function" || (listener && typeof listener.handleEvent === "function"))) listeners[type].add(listener);
  };
  globalThis.removeEventListener = (type, listener) => {
    if (listeners[type]) listeners[type].delete(listener);
  };
  /** An error the worker's code did not catch: said to the owner (its `onerror`), as a browser does. */
  const uncaught = (error) => {
    const text = String((error && error.message) || error).slice(0, 2000);
    out({ kind: "error", text });
  };
  const dispatch = (type, event) => {
    const all = [handlers[type], ...listeners[type]].filter(Boolean);
    for (const listener of all)
      try {
        if (typeof listener === "function") listener.call(globalThis, event);
        else listener.handleEvent(event);
      } catch (error) {
        uncaught(error);
      }
  };
  /** JSON values only (Yavin's workers carry what JSON carries: language servers' messages). */
  globalThis.postMessage = function (data) {
    if (closed) return;
    let text;
    try {
      text = JSON.stringify(data === undefined ? null : data);
    } catch (error) {
      throw Object.assign(new Error(`The worker's message cannot be sent: ${error && error.message}`), { name: "DataCloneError" });
    }
    if (text === undefined) throw Object.assign(new Error("The worker's message cannot be sent: it is not JSON."), { name: "DataCloneError" });
    if (text.length > init.maxMessage) throw new RangeError(`A worker's message is at most ${init.maxMessage / 1024 / 1024} MiB of JSON.`);
    if (!out({ kind: "message", data: text })) throw new Error("The worker's message was not sent: too many are waiting for its extension.");
  };
  globalThis.close = function () {
    if (closed) return;
    closed = true;
    out({ kind: "close" });
  };

  globalThis.__yavin_worker_receive = function (text) {
    const message = JSON.parse(text);
    if (message.type === "timer") {
      const timer = timers.get(message.id);
      if (!timer || closed) return;
      if (!timer.repeat) timers.delete(message.id);
      try {
        timer.callback(...timer.args);
      } catch (error) {
        uncaught(error);
      }
      return;
    }
    if (message.type === "message" && !closed) {
      let data;
      try {
        data = JSON.parse(message.data);
      } catch {
        dispatch("messageerror", { type: "messageerror", data: null, target: globalThis });
        return;
      }
      dispatch("message", { type: "message", data, origin: "", lastEventId: "", ports: [], source: null, target: globalThis, currentTarget: globalThis });
    }
  };
  globalThis.__yavin_worker_uncaught = uncaught;
})();
