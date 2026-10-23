// EXT-31: what runs first in an extension's webview frame (served by `extension_webviews.rs`,
// inside the page, before the extension's own scripts and policies). The frame is sandboxed --
// an opaque origin -- and its policy allows no network: it speaks to Yavin's window only by
// `postMessage`, and the window decides what reaches the extension (`webviews.ts`).
(() => {
  "use strict";
  const parent = window.parent;
  /** The state `setState` kept, as the window last gave it for this panel. */
  let state = __YAVIN_WEBVIEW_STATE__;
  const send = (kind, payload) => {
    try {
      parent.postMessage({ yavinWebview: 1, kind, payload }, "*");
    } catch (error) {
      // A message that cannot be cloned (a function, a DOM node) is the caller's error.
      throw new Error(`The webview could not send that message: ${error && error.message}`);
    }
  };
  let acquired = false;
  const api = Object.freeze({
    postMessage(message) {
      send("message", message);
    },
    setState(value) {
      state = value === undefined ? null : JSON.parse(JSON.stringify(value));
      send("state", state);
      return value;
    },
    getState() {
      return state === null ? undefined : JSON.parse(JSON.stringify(state));
    },
  });
  // As VS Code: the API is acquired once per page.
  Object.defineProperty(window, "acquireVsCodeApi", {
    value: () => {
      if (acquired) throw new Error("An instance of the VS Code API has already been acquired");
      acquired = true;
      return api;
    },
    configurable: false,
    writable: false,
  });
  // A link does not navigate the webview (Yavin cancels it anyway): an in-page anchor scrolls,
  // anything else is told to the window, which opens nothing.
  document.addEventListener(
    "click",
    (event) => {
      const link = event.target && event.target.closest ? event.target.closest("a[href]") : null;
      if (!link) return;
      const href = link.getAttribute("href") || "";
      if (href.startsWith("#")) return;
      event.preventDefault();
      send("link", String(link.href).slice(0, 2048));
    },
    true,
  );
  // VS Code's theme variables and body classes, which webviews style themselves with -- Yavin's
  // dark or light colours, as the window says in the page's address (`?theme=`).
  const light = new URLSearchParams(location.search).get("theme") === "light";
  const colours = light
    ? { bg: "#ffffff", fg: "#1f2328", muted: "#57606a", accent: "#0969da", button: "#0969da", buttonFg: "#ffffff", input: "#f6f8fa", border: "#d0d7de" }
    : { bg: "#1e1e1e", fg: "#d4d4d4", muted: "#9d9d9d", accent: "#4fc1ff", button: "#0e639c", buttonFg: "#ffffff", input: "#3c3c3c", border: "#3c3c3c" };
  const style = document.createElement("style");
  style.id = "_defaultStyles";
  style.textContent = `:root {
    --vscode-font-family: "Segoe UI", system-ui, sans-serif; --vscode-font-size: 13px; --vscode-font-weight: normal;
    --vscode-editor-font-family: Consolas, "Courier New", monospace; --vscode-editor-font-size: 13px;
    --vscode-editor-background: ${colours.bg}; --vscode-editor-foreground: ${colours.fg};
    --vscode-foreground: ${colours.fg}; --vscode-descriptionForeground: ${colours.muted};
    --vscode-textLink-foreground: ${colours.accent}; --vscode-focusBorder: ${colours.accent};
    --vscode-button-background: ${colours.button}; --vscode-button-foreground: ${colours.buttonFg};
    --vscode-input-background: ${colours.input}; --vscode-input-foreground: ${colours.fg};
    --vscode-panel-border: ${colours.border}; --vscode-widget-border: ${colours.border};
    color-scheme: ${light ? "light" : "dark"};
  }
  body { background-color: var(--vscode-editor-background); color: var(--vscode-editor-foreground);
    font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); margin: 0; padding: 0 20px; }
  a { color: var(--vscode-textLink-foreground); }`;
  (document.head || document.documentElement).appendChild(style);
  const theme = () => {
    if (!document.body) return;
    document.body.classList.add(light ? "vscode-light" : "vscode-dark");
    document.body.dataset.vscodeThemeKind = light ? "vscode-light" : "vscode-dark";
  };
  // As soon as there is a body -- before the page's own scripts in it run.
  if (document.body) theme();
  else {
    const watch = new MutationObserver(() => {
      if (!document.body) return;
      watch.disconnect();
      theme();
    });
    watch.observe(document.documentElement, { childList: true });
  }
  // The page is going (Yavin reloading it, or a navigation Yavin cancels and WebView2 replaces
  // with its own page): nothing more is sent to it.
  window.addEventListener("pagehide", () => send("leaving", null));
  // The window asks, after each load, whether this frame shows our page: answered here, and no
  // script of the page sees the question (this listener is the first, and stops it).
  window.addEventListener(
    "message",
    (event) => {
      if (event.source !== parent || !event.data || typeof event.data.yavinPing !== "number") return;
      event.stopImmediatePropagation();
      send("pong", event.data.yavinPing);
    },
    true,
  );
  send("ready", null);
})();
