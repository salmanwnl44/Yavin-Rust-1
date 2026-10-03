import { useEffect, useRef } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import { isTauri } from "@tauri-apps/api/core";
import { native } from "../../services/native";
import {
  describeExit,
  terminalKeyAction,
  usableSize,
  type TerminalKeyAction,
} from "../../services/terminal";
import { asTerminalError } from "../../services/terminalProtocol";
import type { TerminalService, TerminalSessionView } from "../../services/terminalService";
import type { TerminalUi, TerminalViewHandle } from "../../services/terminalUi";

/** How much output a terminal keeps. Beyond this the oldest lines are dropped. */
const SCROLLBACK = 5000;

/** Matches are tinted rather than inverted, so colored output stays readable. */
const DECORATIONS = {
  matchBackground: "#3f3f19",
  matchBorder: "#6b6b2c",
  matchOverviewRuler: "#eab308",
  activeMatchBackground: "#a16207",
  activeMatchBorder: "#facc15",
  activeMatchColorOverviewRuler: "#facc15",
};

/**
 * One view of a terminal session (TERMINAL-04): an xterm.js instance attached to a session the
 * workspace's TerminalService owns.
 *
 * Mounting renders an existing session -- it never starts a shell -- and unmounting only
 * detaches: the session goes on. The view owns xterm (its DOM, addons, key handling, search,
 * links and measurement); everything about the session -- its state, its stream, its
 * generation -- is the service's. Output never enters React state: the session's replay and
 * live output go straight to `term.write`, and each chunk is acknowledged once xterm has parsed
 * it. What the view reports (a notice, a bell, its search results) is about its own terminal,
 * through the workspace's TerminalUi.
 */
export function TerminalView({
  session,
  service,
  ui,
  visible,
  hasSplit,
  fontSize,
  onShortcut,
  onContextMenu,
}: {
  /** The session as the service shows it. */
  session: TerminalSessionView;
  service: TerminalService;
  /** The workspace's terminal UI: this view registers with it, and reports to it. */
  ui: TerminalUi;
  visible: boolean;
  /** Whether a split is open, so Alt+Arrow is only claimed when it means something. */
  hasSplit?: boolean;
  fontSize: number;
  onShortcut: (action: TerminalKeyAction) => void;
  onContextMenu: (position: { x: number; y: number }) => void;
}) {
  const id = session.sessionId;
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<{ term: XTerm; fit: FitAddon; search: SearchAddon } | null>(null);

  // Kept in refs so the effects below never re-run (and re-attach) for a callback's sake.
  const report = useRef({ onShortcut, onContextMenu });
  report.current = { onShortcut, onContextMenu };
  /** A message about this terminal alone (`null` clears it). */
  const notice = (message: string | null) => ui.notice(id, message);
  // Read through refs because the key handler is attached once, inside the xterm effect.
  const split = useRef(hasSplit);
  split.current = hasSplit;
  const latest = useRef(session);
  latest.current = session;

  const copyFrom = (term: XTerm) => {
    const selection = term.getSelection();
    if (!selection) return;
    void navigator.clipboard
      .writeText(selection)
      .catch(() => notice("The clipboard is not available."));
  };

  /**
   * Input for the session, while it runs. Everything xterm produces -- keys, IME composition,
   * pastes (bracketed when the program asked for them) -- arrives here through `onData`; the
   * service splits it to the contract's limits and keeps it in order.
   */
  const send = (data: string) => {
    if (latest.current.state !== "Running") return;
    void service.write(id, data).then(
      () => notice(null),
      (error) => notice(asTerminalError(error).message),
    );
  };

  /** Pasted through xterm, never straight to the shell: xterm brackets it and fixes newlines. */
  const pasteInto = () => {
    void navigator.clipboard
      .readText()
      .then((text) => {
        if (text) view.current?.term.paste(text);
      })
      .catch(() => notice("The clipboard is not available."));
  };

  /** Tells the session the size the view now draws; the service sends only real changes. */
  const sendSize = () => {
    const current = view.current;
    if (!current) return;
    void service
      .resize(id, usableSize(current.term.cols, current.term.rows))
      .catch(() => undefined);
  };

  useEffect(() => {
    const container = host.current;
    if (!container) return;

    const term = new XTerm({
      fontFamily: 'ui-monospace, "Cascadia Mono", Menlo, Consolas, monospace',
      fontSize,
      lineHeight: 1.2,
      cursorBlink: true,
      scrollback: SCROLLBACK,
      scrollOnUserInput: true,
      allowProposedApi: true,
      theme: {
        background: "#000000",
        foreground: "#d4d4d8",
        cursor: "#a5b4fc",
        cursorAccent: "#000000",
        selectionBackground: "#312e81",
      },
    });
    const fit = new FitAddon();
    const search = new SearchAddon();
    term.loadAddon(fit);
    term.loadAddon(search);
    // URLs a program printed become clickable. The handler goes through the same validated
    // native launcher the Git view uses, so a link made of terminal output -- which is not
    // trusted input -- cannot open a local file or a UNC path.
    term.loadAddon(
      new WebLinksAddon((event, uri) => {
        event.preventDefault();
        void native("open_external_url", { url: uri }).catch((error) => notice(String(error)));
      }),
    );
    term.open(container);
    // The panel may still be laying out; measuring on the next frame avoids telling the
    // session a size that is about to change.
    const firstFit = requestAnimationFrame(() => {
      fit.fit();
      sendSize();
    });
    view.current = { term, fit, search };

    /**
     * Runs before xterm interprets a key, and returning false stops it both acting on the
     * key and sending it to the shell. That ordering is the point: handling these on the
     * React container instead meant the event reached us only after xterm had already
     * written the key to the shell, so Shift+PageUp scrolled *and* typed `\x1b[5;2~` at the
     * prompt. Anything this does not claim is passed straight through.
     */
    term.attachCustomKeyEventHandler((event) => {
      const action = terminalKeyAction(event, term.hasSelection(), !!split.current);
      if (!action) return true;
      if (event.type !== "keydown") return false;
      // Returning false stops xterm handling the key, but not the browser: Chromium treats
      // Ctrl+Shift+V as a paste, which xterm's own paste listener would then deliver a
      // second time. Claiming the key means claiming it from both.
      event.preventDefault();
      if (action === "copy") copyFrom(term);
      else if (action === "paste") pasteInto();
      // Scrolling is this terminal's own buffer; the panel has no access to it.
      else if (action === "scroll-page-up") term.scrollPages(-1);
      else if (action === "scroll-page-down") term.scrollPages(1);
      else if (action === "scroll-top") term.scrollToTop();
      else if (action === "scroll-bottom") term.scrollToBottom();
      else report.current.onShortcut(action);
      return false;
    });

    // Search results and the bell are this terminal's alone.
    const results = search.onDidChangeResults((found) =>
      ui.setMatches(id, { index: found.resultIndex, count: found.resultCount }),
    );
    const bell = term.onBell(() => ui.ring(id));
    // Keystrokes go to the shell as bytes; the shell decides what they mean.
    const typed = term.onData(send);

    if (!isTauri())
      term.writeln("\x1b[38;5;244mOpen the desktop application to run a shell.\x1b[0m");

    // Keep the shell's idea of the window the same as what is drawn. Dragging the panel fires
    // continuously, so only the size it settles on is sent -- and the service sends it only if
    // the cells changed.
    let pending: ReturnType<typeof setTimeout> | undefined;
    const observer = new ResizeObserver(() => {
      if (!view.current || !container.clientHeight) return;
      fit.fit();
      clearTimeout(pending);
      pending = setTimeout(sendSize, 100);
    });
    observer.observe(container);

    return () => {
      cancelAnimationFrame(firstFit);
      clearTimeout(pending);
      observer.disconnect();
      results.dispose();
      bell.dispose();
      typed.dispose();
      view.current = null;
      term.dispose();
    };
    // The xterm instance lives as long as the view of this session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // Attached to the session's current generation: its replay, then live output, in order --
  // each chunk acknowledged once xterm has parsed it -- and its end, after its output. A
  // restart is a new generation, so the view attaches again. Unmounting only detaches.
  const generation = session.generation;
  useEffect(() => {
    const current = view.current;
    if (!current || !isTauri()) return;
    const { term } = current;
    let attachment: { detach(): void };
    try {
      attachment = service.attach(id, {
        output: (chunk, accepted) => term.write(chunk.bytes, accepted),
        ended: (message, failed) =>
          term.writeln(`\r\n\x1b[38;5;${failed ? 203 : 244}m[${message}]\x1b[0m`),
      });
    } catch {
      // The session was closed between rendering and attaching: nothing to show.
      return;
    }
    return () => attachment.detach();
  }, [service, id, generation]);

  // What the panel and the menus can do to this view, registered under its terminal: they
  // always name the terminal they act on.
  useEffect(() => {
    const handle: TerminalViewHandle = {
      focus: () => view.current?.term.focus(),
      clear: () => view.current?.term.clear(),
      search: (query, direction, settings) => {
        if (!view.current) return;
        const options = { ...settings, decorations: DECORATIONS };
        if (!query) {
          view.current.search.clearDecorations();
          return;
        }
        // The addon caches highlighting by term and options together, but its cache
        // update runs before it compares the new options against the cached ones, so
        // a changed case/regex setting on the same term would otherwise be silently
        // ignored. Clearing first forces a full recount.
        view.current.search.clearDecorations();
        if (direction === "next") view.current.search.findNext(query, options);
        else view.current.search.findPrevious(query, options);
      },
      endSearch: () => view.current?.search.clearDecorations(),
      copySelection: () => {
        if (view.current) copyFrom(view.current.term);
      },
      paste: pasteInto,
      selectAll: () => view.current?.term.selectAll(),
      hasSelection: () => !!view.current?.term.hasSelection(),
    };
    return ui.registerView(id, handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ui, id]);

  // Only a laid-out terminal can be measured, so it is fitted when it becomes visible.
  useEffect(() => {
    if (!visible || !view.current) return;
    view.current.fit.fit();
    view.current.term.focus();
    sendSize();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, id]);

  useEffect(() => {
    const current = view.current;
    if (!current || current.term.options.fontSize === fontSize) return;
    current.term.options.fontSize = fontSize;
    current.fit.fit();
  }, [fontSize]);

  // How the session's current generation ended, from the service: the footer offers Restart.
  const { state, error } = session;
  const exited =
    state === "Exited"
      ? describeExit(session.exitCode)
      : state === "Failed"
        ? (error ?? "The terminal failed.")
        : "";

  return (
    <div className="relative flex h-full min-h-0 w-full flex-col bg-black">
      <div
        ref={host}
        aria-label={`Terminal ${id}`}
        className="min-h-0 flex-1 overflow-hidden pt-1 pl-2"
        // Key handling lives in xterm's own custom handler (see the effect above), which runs
        // before xterm interprets the key. Handling it here instead meant the event had
        // already bubbled past xterm, which had by then sent the key to the shell -- so
        // Shift+PageUp both scrolled and typed an escape sequence at the prompt.
        onContextMenu={(event) => {
          event.preventDefault();
          report.current.onContextMenu({ x: event.clientX, y: event.clientY });
        }}
      />
      {exited && (
        <div className="flex shrink-0 items-center gap-2 border-t border-[#181818] bg-[#080808] px-3 py-1">
          <span className="truncate text-[11px] text-zinc-400">{exited}</span>
          <button
            onClick={() => {
              notice(null);
              ui.restart(id);
            }}
            className="rounded bg-[#1a1a1a] px-2 py-0.5 text-[11px] text-zinc-200 transition-colors hover:bg-[#252525]"
          >
            Restart
          </button>
        </div>
      )}
    </div>
  );
}
