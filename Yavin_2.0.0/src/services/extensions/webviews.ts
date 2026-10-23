/**
 * Extension webviews in the window (EXT-31): the panels extensions open, as tabs of the editor
 * area, and what passes between a panel's frame and the extension that owns it.
 *
 * A panel's page is served natively from its own origin (`src-tauri/src/extension_webviews.rs`)
 * to a sandboxed frame (`components/extensions/ExtensionWebview.tsx`): an opaque origin, no
 * network, no navigation away. Nothing from the frame is trusted:
 *
 * - **Owned.** A panel belongs to the extension that created it (its id `<id>#webview#n`, its
 *   native token bound once); every change, message, reveal and disposal is checked against
 *   that owner, and messages reach only it (`host.ts`).
 * - **Bounded.** At most 16 panels per extension and 32 in the window; messages at most 1 MiB of
 *   JSON each way, 500 a second from a frame (the rest dropped, said once), 64 waiting for a
 *   frame that is not ready; saved state at most 256 KiB of JSON; at most 8 hidden panels kept
 *   alive (`retainContextWhenHidden`), the rest reloaded when shown again.
 * - **JSON only.** A frame's message is kept only as JSON (what structured cloning carries
 *   beyond it -- functions cannot, but Maps, dates and buffers can -- becomes JSON or is refused).
 * - **Its own page, or nothing.** A frame may not navigate away (cancelled natively); WebView2
 *   then shows its own error page in the frame (measured: the page that left says nothing as
 *   it goes). After every load of the frame the window asks it whether it is our page -- a ping
 *   only our bootstrap answers, which no extension script sees; no answer within a second: the
 *   panel's page is served again, with its saved state -- at most 3 times a minute, then it is
 *   left as it is, and said.
 * - **Gone with its owner.** Closing the tab disposes the panel (the extension hears
 *   `onDidDispose`); the extension stopping, crashing or being disabled, the window's page
 *   reloading and the window closing take its panels away, natively too.
 */

export const MAX_PANELS_PER_EXTENSION = 16;
export const MAX_PANELS = 32;
export const MAX_MESSAGE = 1024 * 1024;
export const MAX_STATE = 256 * 1024;
export const MAX_QUEUED = 64;
export const MAX_RETAINED = 8;
export const FRAME_MESSAGES_PER_SECOND = 500;
export const MAX_RESTORES_PER_MINUTE = 3;
/** How long after its load event a frame has to say it is our page. */
export const READY_GRACE_MS = 1000;

/** What the native side does for a panel (`extensions_webview_*`). */
export interface WebviewNative {
  open(request: {
    token: string;
    extensionId: string;
    html: string;
    state: string | null;
    scripts: boolean;
    roots: string[];
  }): Promise<string>;
  update(request: {
    token: string;
    html?: string;
    state?: string | null;
    setState?: boolean;
    scripts?: boolean;
    roots?: string[];
  }): Promise<void>;
  close(token: string): Promise<void>;
}

/** What the extension hears about its panel. */
export interface WebviewHandlers {
  message(message: unknown): void;
  viewState(visible: boolean, active: boolean): void;
  disposed(): void;
}

export interface WebviewPanel {
  id: string;
  extensionId: string;
  extensionName: string;
  viewType: string;
  title: string;
  /** The page's URL (its origin and token), once registered natively. */
  url: string;
  scripts: boolean;
  retain: boolean;
  visible: boolean;
  active: boolean;
  /** Bumped when the page should be loaded again (new HTML, scripts or roots). */
  revision: number;
  /** Bumped when the extension asks for it to be shown (`reveal`); with `focus`. */
  revealed: number;
  focus: boolean;
}

export interface CreateRequest {
  id: string;
  extensionId: string;
  extensionName: string;
  token: string;
  viewType: string;
  title: string;
  scripts: boolean;
  retain: boolean;
  roots: string[];
  preserveFocus: boolean;
}

interface Live {
  panel: WebviewPanel;
  token: string;
  handlers: WebviewHandlers;
  /** The frame's window while it shows our page and said it is ready. */
  frame: Window | null;
  ready: boolean;
  queue: unknown[];
  state: string | null;
  stateTimer: ReturnType<typeof setTimeout> | null;
  budget: { second: number; count: number; warned: boolean };
  /** When its page was served again after leaving (`frameLoaded`), in the last minute. */
  restores: number[];
  /** Its frame's loads, counted: only the latest is judged. */
  loads: number;
  /** The load whose ping our page has answered. */
  answered: number;
  /** Waiting for the page the frame was last given to say it is ready (`attachFrame`). */
  watch: ReturnType<typeof setTimeout> | null;
}

/** `value` as JSON text within `max`, or null (not JSON, or too large). */
export function jsonWithin(value: unknown, max: number): string | null {
  try {
    const text = JSON.stringify(value === undefined ? null : value);
    return typeof text === "string" && text.length <= max ? text : null;
  } catch {
    return null;
  }
}

export function createWebviewStore(
  native: WebviewNative,
  warn: (text: string) => void = () => {},
  options: { readyGraceMs?: number } = {},
) {
  const graceMs = options.readyGraceMs ?? READY_GRACE_MS;
  const live = new Map<string, Live>();
  let shown: string | null = null;
  let snapshot: readonly WebviewPanel[] = [];
  const listeners = new Set<() => void>();
  const publish = () => {
    snapshot = [...live.values()].map((one) => one.panel);
    for (const listener of [...listeners])
      try {
        listener();
      } catch {
        /* One listener's failure is not the others'. */
      }
  };
  const change = (one: Live, patch: Partial<WebviewPanel>) => {
    one.panel = { ...one.panel, ...patch };
    publish();
  };
  const owned = (id: string, extensionId: string): Live => {
    const one = live.get(id);
    if (!one || one.panel.extensionId !== extensionId)
      throw Object.assign(new Error("No such webview panel of this extension."), {
        code: "UnknownWebview",
      });
    return one;
  };
  /** Takes a panel away: natively, from the tabs; `notify`: the extension hears it. */
  const remove = (one: Live, notify: boolean) => {
    if (!live.delete(one.panel.id)) return;
    if (one.stateTimer) clearTimeout(one.stateTimer);
    if (one.watch) clearTimeout(one.watch);
    one.watch = null;
    one.queue = [];
    one.frame = null;
    void native.close(one.token).catch(() => undefined);
    if (shown === one.panel.id) shown = null;
    publish();
    if (notify)
      try {
        one.handlers.disposed();
      } catch {
        /* The host is gone: nothing to tell. */
      }
  };
  /** Which panels are visible and active, from the tab in front. */
  const viewStates = () => {
    let changed = false;
    for (const one of live.values()) {
      const visible = one.panel.id === shown;
      if (visible === one.panel.visible && visible === one.panel.active) continue;
      changed = true;
      one.panel = { ...one.panel, visible, active: visible };
      try {
        one.handlers.viewState(visible, visible);
      } catch {
        /* Not ours to fail. */
      }
      // A hidden panel that is not kept alive loses its frame: its messages wait no more.
      if (!visible && !retained(one)) {
        one.frame = null;
        one.ready = false;
        one.queue = [];
        // Its next load starts from the state it saved last: kept natively now, not later.
        if (one.stateTimer) {
          clearTimeout(one.stateTimer);
          one.stateTimer = null;
          void native
            .update({ token: one.token, state: one.state, setState: true })
            .catch(() => undefined);
        }
      }
    }
    // Only a change is news: the window asks again on every render of its tabs.
    if (changed) publish();
  };
  /** Kept alive while hidden: asked for, and among the first `MAX_RETAINED` that asked. */
  const retained = (one: Live) =>
    one.panel.retain &&
    [...live.values()].filter((x) => x.panel.retain).indexOf(one) < MAX_RETAINED;

  return {
    /** A panel an extension opens: registered natively, then a tab. */
    async create(request: CreateRequest, handlers: WebviewHandlers): Promise<void> {
      if (live.has(request.id))
        throw Object.assign(new Error("That webview panel already exists."), {
          code: "InvalidRequest",
        });
      const mine = [...live.values()].filter(
        (one) => one.panel.extensionId === request.extensionId,
      );
      if (mine.length >= MAX_PANELS_PER_EXTENSION)
        throw Object.assign(
          new Error(`At most ${MAX_PANELS_PER_EXTENSION} webview panels per extension.`),
          { code: "TooMany" },
        );
      if (live.size >= MAX_PANELS)
        throw Object.assign(new Error(`At most ${MAX_PANELS} webview panels in a window.`), {
          code: "TooMany",
        });
      const url = await native.open({
        token: request.token,
        extensionId: request.extensionId,
        html: "",
        state: null,
        scripts: request.scripts,
        roots: request.roots,
      });
      live.set(request.id, {
        panel: {
          id: request.id,
          extensionId: request.extensionId,
          extensionName: request.extensionName,
          viewType: request.viewType,
          title: request.title,
          url,
          scripts: request.scripts,
          retain: request.retain,
          visible: false,
          active: false,
          revision: 0,
          revealed: 1,
          focus: !request.preserveFocus,
        },
        token: request.token,
        handlers,
        frame: null,
        ready: false,
        queue: [],
        state: null,
        stateTimer: null,
        budget: { second: 0, count: 0, warned: false },
        restores: [],
        loads: 0,
        answered: 0,
        watch: null,
      });
      publish();
    },
    async update(
      id: string,
      extensionId: string,
      patch: { html?: string; title?: string; scripts?: boolean; roots?: string[] },
    ): Promise<void> {
      const one = owned(id, extensionId);
      const reload =
        patch.html !== undefined || patch.scripts !== undefined || patch.roots !== undefined;
      if (reload)
        await native.update({
          token: one.token,
          html: patch.html,
          scripts: patch.scripts,
          roots: patch.roots,
        });
      if (!live.has(id)) return;
      change(one, {
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.scripts !== undefined ? { scripts: patch.scripts } : {}),
        ...(reload ? { revision: one.panel.revision + 1 } : {}),
      });
      if (reload) {
        // The page loads again: its frame is not ready until it says so.
        one.ready = false;
        one.queue = [];
      }
    },
    /** A message from the extension to its panel: true when sent, or waiting for the page. */
    postMessage(id: string, extensionId: string, message: unknown): boolean {
      const one = owned(id, extensionId);
      const text = jsonWithin(message, MAX_MESSAGE);
      if (text === null)
        throw Object.assign(
          new Error(`A webview message is JSON, at most ${MAX_MESSAGE / 1024} KiB.`),
          { code: "TooLarge" },
        );
      const value = JSON.parse(text);
      if (one.ready && one.frame) {
        one.frame.postMessage(value, "*");
        return true;
      }
      // Not live: a hidden panel that is not kept alive receives nothing (as VS Code).
      if (!one.panel.visible && !retained(one)) return false;
      if (one.queue.length >= MAX_QUEUED) return false;
      one.queue.push(value);
      return true;
    },
    reveal(id: string, extensionId: string, preserveFocus: boolean) {
      const one = owned(id, extensionId);
      change(one, { revealed: one.panel.revealed + 1, focus: !preserveFocus });
    },
    /** The extension disposed its panel: it already knows. */
    dispose(id: string, extensionId: string) {
      const one = live.get(id);
      if (one && one.panel.extensionId === extensionId) remove(one, false);
    },
    /** An extension stopped (or crashed, or was disabled): its panels go, silently. */
    disposeExtension(extensionId: string) {
      for (const one of [...live.values()])
        if (one.panel.extensionId === extensionId) remove(one, false);
    },
    /** Everything goes (the window's extensions stop, or it closes). */
    disposeAll() {
      for (const one of [...live.values()]) remove(one, false);
    },

    // --- The window's side ----------------------------------------------------------------
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    /** The tab in front: a panel's id, or null for anything else. */
    setShown(id: string | null) {
      shown = id && live.has(id) ? id : null;
      viewStates();
    },
    /** Kept mounted while hidden (`retainContextWhenHidden`, within the bound). */
    keepsAlive(id: string): boolean {
      const one = live.get(id);
      return !!one && retained(one);
    },
    /** The user closed its tab: the panel is disposed, and the extension hears it. */
    closeFromWindow(id: string) {
      const one = live.get(id);
      if (one) remove(one, true);
    },
    /** The panel's frame (its window), or null when it goes. */
    attachFrame(id: string, frame: Window | null) {
      const one = live.get(id);
      if (!one) return;
      one.frame = frame;
      one.ready = false;
      if (one.watch) clearTimeout(one.watch);
      one.watch = null;
      // A frame given a page (a new address: created, updated, served again) must show it.
      // WebView2 can drop a frame's navigation that follows another closely -- measured: the
      // frame kept the panel's first, empty page while its address was the next. A page that
      // has not said it is ready by then is served again (bounded, with the restores). Without
      // scripts there is no bootstrap to say so, and nothing to watch.
      if (frame && one.panel.scripts) {
        const revision = one.panel.revision;
        one.watch = setTimeout(() => {
          one.watch = null;
          if (live.get(id) !== one || one.frame !== frame || one.ready) return;
          if (one.panel.revision !== revision) return;
          // What the extension sent meanwhile waits for it: no page of this revision ever had it.
          serveAgain(id, one, "did not show its page", true);
        }, graceMs * 3);
      }
    },
    /**
     * A message from a panel's frame -- already known to come from that frame (the component
     * checks `event.source`). Anything not of the bootstrap's shape is ignored.
     */
    frameMessage(id: string, data: unknown) {
      const one = live.get(id);
      if (!one || !one.frame || !data || typeof data !== "object") return;
      const { yavinWebview, kind, payload } = data as Record<string, unknown>;
      if (yavinWebview !== 1 || typeof kind !== "string") return;
      if (kind === "ready") {
        // Only the page the frame was last given: an earlier one still in the frame (its next
        // navigation dropped or not yet done) is not ours to speak to or hear.
        if (payload !== one.panel.revision) return;
        if (one.watch) clearTimeout(one.watch);
        one.watch = null;
        one.ready = true;
        const queued = one.queue;
        one.queue = [];
        for (const value of queued) one.frame.postMessage(value, "*");
        return;
      }
      if (kind === "pong") {
        // Our page answering the ping after a load.
        if (typeof payload === "number" && payload === one.loads) one.answered = payload;
        return;
      }
      if (kind === "leaving") {
        // Its page is going: nothing more is sent to it until our page says it is ready.
        one.ready = false;
        return;
      }
      if (!one.ready) return;
      if (kind === "message") {
        const second = Math.floor(Date.now() / 1000);
        if (one.budget.second !== second) one.budget = { ...one.budget, second, count: 0 };
        if (++one.budget.count > FRAME_MESSAGES_PER_SECOND) {
          if (!one.budget.warned) {
            one.budget.warned = true;
            warn(
              `The webview "${one.panel.title}" (${one.panel.extensionId}) sends more than ${FRAME_MESSAGES_PER_SECOND} messages a second: the rest are dropped.`,
            );
          }
          return;
        }
        const text = jsonWithin(payload, MAX_MESSAGE);
        if (text === null) {
          warn(
            `A message from the webview "${one.panel.title}" (${one.panel.extensionId}) was not JSON or was over ${MAX_MESSAGE / 1024} KiB: dropped.`,
          );
          return;
        }
        try {
          one.handlers.message(JSON.parse(text));
        } catch {
          /* The host is gone. */
        }
        return;
      }
      if (kind === "state") {
        const text = jsonWithin(payload, MAX_STATE);
        if (text === null) {
          warn(
            `The webview "${one.panel.title}" (${one.panel.extensionId}) saved a state that was not JSON or was over ${MAX_STATE / 1024} KiB: not kept.`,
          );
          return;
        }
        one.state = text;
        // Kept natively, for the page's next load (a hidden panel shown again): not every call.
        if (one.stateTimer) clearTimeout(one.stateTimer);
        one.stateTimer = setTimeout(() => {
          one.stateTimer = null;
          if (live.get(id) === one)
            void native
              .update({ token: one.token, state: one.state, setState: true })
              .catch(() => undefined);
        }, 200);
      }
      // "link": a webview's link opens nothing in Yavin.
    },
    /**
     * The frame finished loading. Our page says "ready" (around then: the two may arrive in
     * either order); if it has not within the grace period, the frame shows something else
     * (WebView2's page for a navigation Yavin cancelled), and the panel's page is served again --
     * bounded, so a page that keeps leaving is left, and said.
     */
    frameLoaded(id: string) {
      const one = live.get(id);
      if (!one || !one.frame || !one.panel.scripts) return;
      const load = ++one.loads;
      // Only our bootstrap answers this, and no extension script sees it.
      one.frame.postMessage({ yavinPing: load }, "*");
      setTimeout(() => judgeLoad(id, one, load), graceMs);
    },
    /** For tests: the state a panel saved, as JSON. */
    stateOf: (id: string) => live.get(id)?.state ?? null,
  };

  function judgeLoad(id: string, one: Live, load: number) {
    if (live.get(id) !== one || one.loads !== load || !one.frame || one.answered === load) return;
    serveAgain(id, one, "tried to leave its page (stopped)");
  }

  /**
   * Serves a panel's page to its frame again, with its saved state; at most 3 times a minute.
   * `keepQueue`: the messages waiting are still the page's (it never loaded, rather than left).
   */
  function serveAgain(id: string, one: Live, why: string, keepQueue = false) {
    // Not our page: nothing more is sent to it.
    one.ready = false;
    const now = Date.now();
    one.restores = one.restores.filter((at) => now - at < 60_000);
    if (one.restores.length >= MAX_RESTORES_PER_MINUTE) {
      if (one.restores.length === MAX_RESTORES_PER_MINUTE) {
        one.restores.push(now);
        warn(
          `The webview "${one.panel.title}" (${one.panel.extensionId}) keeps leaving its page: it is not shown again for now.`,
        );
      }
      return;
    }
    one.restores.push(now);
    warn(
      `The webview "${one.panel.title}" (${one.panel.extensionId}) ${why}; its page was shown again.`,
    );
    if (!keepQueue) one.queue = [];
    const reload = () => {
      if (live.get(id) === one) change(one, { revision: one.panel.revision + 1 });
    };
    // The page comes back with the state it saved last -- kept natively first, if it waits.
    if (!one.stateTimer) return reload();
    clearTimeout(one.stateTimer);
    one.stateTimer = null;
    void native
      .update({ token: one.token, state: one.state, setState: true })
      .catch(() => undefined)
      .then(reload);
  }
}

export type WebviewStore = ReturnType<typeof createWebviewStore>;

/** A tab id for a panel, and the panel id of such a tab. */
export const webviewTabId = (panelId: string) => `webview:${panelId}`;
export const panelOfTab = (tabId: string): string | null =>
  tabId.startsWith("webview:") ? tabId.slice("webview:".length) : null;
