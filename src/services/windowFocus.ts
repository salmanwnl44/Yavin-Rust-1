/**
 * Whether Yavin's window has the user's focus (EXT-27).
 *
 * - **The application** (`tauriWindowFocus`): the OS's answer -- the window is the foreground
 *   one and not minimized (`window_focus.rs`: the `window_focused` command at start, then its
 *   `yavin://window-focus` events). Measured in the packaged application, neither the DOM nor
 *   Tauri's focus API follows the OS: `document.hasFocus()` stays true and no `blur` arrives
 *   when another application takes the foreground or the window is minimized; Tauri's focus
 *   events follow WebView2's keyboard focus, and its `isFocused` answered false in front.
 * - **A browser window** (`browserWindowFocus`): the DOM's `focus` and `blur` events on the
 *   window, and `document.hasFocus()` for the state at any moment.
 *
 * Listeners hear a *change* only: a `focus` while already focused (focus moving between Yavin's
 * own elements re-dispatches nothing at the window, but a stray event must not either) is not
 * one. The state is read again from `hasFocus()` on each event, so a missed event cannot leave
 * it stale for longer than the next one.
 */

export interface FocusSource {
  hasFocus(): boolean;
  addEventListener(type: "focus" | "blur", listener: () => void): void;
  removeEventListener(type: "focus" | "blur", listener: () => void): void;
}

export interface WindowFocus {
  focused(): boolean;
  /** Hears each change (never the same state twice in a row). */
  onChange(listener: (focused: boolean) => void): () => void;
  dispose(): void;
}

/** The state both sources keep: a change is told once, to every listener. */
function focusState(initial: boolean, stop: () => void) {
  let focused = initial;
  const listeners = new Set<(focused: boolean) => void>();
  const focus: WindowFocus = {
    focused: () => focused,
    onChange(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose() {
      stop();
      listeners.clear();
    },
  };
  const set = (now: boolean) => {
    if (now === focused) return;
    focused = now;
    for (const listener of [...listeners]) {
      try {
        listener(focused);
      } catch {
        /* One listener's failure is not the others'. */
      }
    }
  };
  return { focus, set };
}

export function createWindowFocus(source: FocusSource): WindowFocus {
  // The event says which way; hasFocus() confirms (a blur to a child frame keeps focus).
  const onFocus = () => state.set(true);
  const onBlur = () => state.set(source.hasFocus());
  const state = focusState(source.hasFocus(), () => {
    source.removeEventListener("focus", onFocus);
    source.removeEventListener("blur", onBlur);
  });
  source.addEventListener("focus", onFocus);
  source.addEventListener("blur", onBlur);
  return state.focus;
}

/** The native window's focus, as the application's native side gives it. */
export interface NativeFocusSource {
  isFocused(): Promise<boolean>;
  /** Resolves to its unsubscribe. */
  onFocusChanged(listener: (focused: boolean) => void): Promise<() => void>;
}

/**
 * Follows the native window. Until `isFocused` answers, the state is `initial`; its answer is
 * taken only if no event came first (an event is newer). Disposed before the subscription
 * resolves, it unsubscribes when it does.
 */
export function createNativeWindowFocus(source: NativeFocusSource, initial: boolean): WindowFocus {
  let heard = false;
  let disposed = false;
  let unsubscribe: (() => void) | null = null;
  const state = focusState(initial, () => {
    disposed = true;
    unsubscribe?.();
  });
  source
    .onFocusChanged((focused) => {
      heard = true;
      if (!disposed) state.set(focused);
    })
    .then((stop) => {
      if (disposed) stop();
      else unsubscribe = stop;
    })
    .catch(() => undefined);
  source
    .isFocused()
    .then((focused) => {
      if (!heard && !disposed) state.set(focused);
    })
    .catch(() => undefined);
  return state.focus;
}

/** The application's window: the foreground window, as the native side says it. */
export function tauriWindowFocus(): WindowFocus {
  return createNativeWindowFocus(
    {
      isFocused: async () =>
        (await import("@tauri-apps/api/core")).invoke<boolean>("window_focused"),
      onFocusChanged: async (listener) =>
        (await import("@tauri-apps/api/event")).listen<boolean>("yavin://window-focus", (event) =>
          listener(event.payload === true),
        ),
    },
    typeof document === "undefined" || document.hasFocus(),
  );
}

/** The browser window's (null outside one: tests, workers). */
export function browserWindowFocus(): WindowFocus | null {
  if (typeof window === "undefined" || typeof document === "undefined") return null;
  return createWindowFocus({
    hasFocus: () => document.hasFocus(),
    addEventListener: (type, listener) => window.addEventListener(type, listener),
    removeEventListener: (type, listener) => window.removeEventListener(type, listener),
  });
}
