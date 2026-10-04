/**
 * The debugger in the editor (IDE-05): breakpoints in the glyph margin and the paused frame's
 * line, as Monaco decorations on the documents' models -- matched by resource identity (the
 * model's document's `ResourceId`), never by a path string. A view of the workspace's
 * breakpoints and DebugService: it repaints only the files whose breakpoints changed, or the
 * paused line when it moved, and never recreates an editor.
 *
 *   yavin-breakpoint             set (verified, or no session to ask)
 *   yavin-breakpoint-unverified  the adapter could not set it (hover says why)
 *   yavin-breakpoint-disabled    disabled
 *   yavin-debug-current-line     the selected frame's line while paused
 */
import { monaco } from "./monaco";
import { editorModelOf } from "./monacoHost";
import type { EditorModelBridge } from "../services/editorModelBridge";
import { resourceId, type ResourceId } from "../services/resource";
import type { BreakpointEntry, Breakpoints } from "../services/debug/breakpoints";
import type { DebugService } from "../services/debug/service";

const breakpointClass = (entry: BreakpointEntry) =>
  !entry.enabled
    ? "yavin-breakpoint-disabled"
    : entry.verified === false
      ? "yavin-breakpoint-unverified"
      : "yavin-breakpoint";

const breakpointHover = (entry: BreakpointEntry) =>
  !entry.enabled
    ? "Breakpoint (disabled)"
    : entry.verified === false
      ? `Breakpoint not set: ${entry.message ?? "the debugger could not place it."}`
      : entry.verified
        ? "Breakpoint"
        : "Breakpoint (set when debugging starts)";

export function attachDebugDecorations(
  bridge: EditorModelBridge,
  breakpoints: Breakpoints | null,
  debug: DebugService,
): () => void {
  const collections = new WeakMap<monaco.editor.ITextModel, string[]>();

  const resourceOf = (model: monaco.editor.ITextModel): ResourceId | null => {
    const bridged = editorModelOf(model);
    const doc = bridged ? bridge.documentOf(bridged) : undefined;
    return doc?.uri ? resourceId(doc.uri) : null;
  };

  /** The paused frame's file and line, when it is in a file. */
  const current = () => {
    const snapshot = debug.getSnapshot();
    if (snapshot.session?.state !== "stopped") return null;
    const frame = snapshot.frames.find((one) => one.id === snapshot.selectedFrameId);
    return frame?.resource ? { resource: frame.resource, line: frame.line } : null;
  };
  let shownCurrent = current();

  const paint = (model: monaco.editor.ITextModel) => {
    if (model.isDisposed()) return;
    const resource = resourceOf(model);
    const decorations: monaco.editor.IModelDeltaDecoration[] = [];
    if (resource) {
      const lines = model.getLineCount();
      for (const entry of breakpoints?.forResource(resource) ?? []) {
        if (entry.line > lines) continue;
        decorations.push({
          range: new monaco.Range(entry.line, 1, entry.line, 1),
          options: {
            glyphMarginClassName: breakpointClass(entry),
            glyphMarginHoverMessage: { value: breakpointHover(entry), isTrusted: false },
            stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
          },
        });
      }
      const paused = shownCurrent;
      if (paused && paused.resource === resource && paused.line >= 1 && paused.line <= lines)
        decorations.push({
          range: new monaco.Range(paused.line, 1, paused.line, 1),
          options: {
            isWholeLine: true,
            className: "yavin-debug-current-line",
            glyphMarginClassName: "yavin-debug-current-frame",
            glyphMarginHoverMessage: { value: "Paused here", isTrusted: false },
          },
        });
    }
    collections.set(model, model.deltaDecorations(collections.get(model) ?? [], decorations));
  };

  const paintWhere = (resources: Set<ResourceId | null>) => {
    for (const model of monaco.editor.getModels())
      if (resources.has(resourceOf(model))) paint(model);
  };

  for (const model of monaco.editor.getModels()) paint(model);
  const subscriptions: (() => void)[] = [];
  // A document opened later: decorated once the bridge has it.
  const created = monaco.editor.onDidCreateModel((model) => queueMicrotask(() => paint(model)));
  subscriptions.push(() => created.dispose());
  if (breakpoints)
    subscriptions.push(
      breakpoints.subscribe((change) => paintWhere(new Set<ResourceId | null>(change.resources))),
    );
  subscriptions.push(
    debug.subscribe(() => {
      const next = current();
      if (next?.resource === shownCurrent?.resource && next?.line === shownCurrent?.line) return;
      const touched = new Set<ResourceId | null>([
        shownCurrent?.resource ?? null,
        next?.resource ?? null,
      ]);
      shownCurrent = next;
      touched.delete(null);
      paintWhere(touched);
    }),
  );

  return () => {
    for (const stop of subscriptions) stop();
    for (const model of monaco.editor.getModels()) {
      const ids = collections.get(model);
      if (ids && !model.isDisposed()) model.deltaDecorations(ids, []);
    }
  };
}
