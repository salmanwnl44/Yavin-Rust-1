/**
 * An extension's webview panel (EXT-31): its page in a sandboxed frame -- `allow-scripts` only
 * when the panel enables scripts, never `allow-same-origin`, forms, popups or top navigation --
 * from the webview origin the native side serves (`extension_webviews.rs`). The frame is not
 * Yavin's markup and reaches nothing of Yavin's: what it posts is taken only from this frame's
 * own window, and the store decides what reaches the extension (`webviews.ts`).
 */
import { useEffect, useRef } from "react";
import type { WebviewPanel, WebviewStore } from "../../services/extensions/webviews";

export function ExtensionWebview({
  panel,
  store,
  hidden,
  light,
}: {
  panel: WebviewPanel;
  store: WebviewStore;
  /** Kept alive while another tab is in front (`retainContextWhenHidden`). */
  hidden: boolean;
  /** The editor shows a light theme: the page's default colours follow it. */
  light: boolean;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const src = `${panel.url}?v=${panel.revision}&theme=${light ? "light" : "dark"}`;
  useEffect(() => {
    // The frame's window object outlives its page loads: known from the first, so the page's
    // "ready" -- sent before the frame's load event -- is taken.
    const own = frame.current?.contentWindow ?? null;
    store.attachFrame(panel.id, own);
    const onMessage = (event: MessageEvent) => {
      if (!own || event.source !== own) return;
      store.frameMessage(panel.id, event.data);
    };
    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("message", onMessage);
      store.attachFrame(panel.id, null);
    };
    // A new address loads the page again: it is not ready until it says so.
  }, [panel.id, store, src]);
  return (
    <iframe
      ref={frame}
      title={`${panel.title} (${panel.extensionName})`}
      src={src}
      sandbox={panel.scripts ? "allow-scripts" : ""}
      referrerPolicy="no-referrer"
      allow=""
      hidden={hidden}
      // Loaded without our page saying it is ready: something else is in the frame.
      onLoad={() => store.frameLoaded(panel.id)}
      data-webview={panel.id}
      className="h-full w-full flex-1 border-0"
    />
  );
}
