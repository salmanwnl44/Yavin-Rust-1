/**
 * Inline merge-conflict resolution in the editor (WS10). Rather than a separate editor, this
 * reuses the one Monaco instance (per the "no competing editing architecture" constraint): it
 * highlights each conflict region's **current / base / incoming** sides, and offers
 * **Accept Current / Accept Incoming / Accept Both** (and Accept Base for diff3) plus
 * next/previous-conflict navigation as editor actions — keyboard- and context-menu-accessible,
 * shown only while the cursor is inside a conflict (a context key). Accepting a side rewrites just
 * that region's lines through the editor's own undoable edit, which the model↔document bridge
 * mirrors into DocumentService — so DocumentService stays the source of truth and the change is one
 * undo step. Nothing here reads Git or writes files; staging-as-resolved stays in the Git panel.
 */
import { monaco } from "./monaco";
import {
  parseConflicts,
  regionSideLines,
  resolveRegionLines,
  type Choice,
  type ConflictRegion,
} from "../services/git/conflict";

const IN_CONFLICT = "yavinInMergeConflict";

export function attachConflictResolution(editor: monaco.editor.IStandaloneCodeEditor): () => void {
  const decorations = new WeakMap<monaco.editor.ITextModel, string[]>();
  const inConflict = editor.createContextKey<boolean>(IN_CONFLICT, false);
  let regions: readonly ConflictRegion[] = [];

  const repaint = () => {
    const model = editor.getModel();
    if (!model) {
      regions = [];
      return;
    }
    regions = parseConflicts(model.getValue()).regions;
    const decs: monaco.editor.IModelDeltaDecoration[] = [];
    for (const region of regions) {
      const r = regionSideLines(region);
      const add = (from: number, to: number, cls: string) => {
        if (to >= from)
          decs.push({
            range: new monaco.Range(
              from,
              1,
              to,
              model.getLineMaxColumn(Math.min(to, model.getLineCount())),
            ),
            options: { isWholeLine: true, className: cls },
          });
      };
      add(region.startLine, region.startLine, "yavin-conflict-header");
      add(r.currentStart, r.currentEnd, "yavin-conflict-current");
      if (region.base) add(r.baseStart, r.baseEnd, "yavin-conflict-base");
      add(r.incomingStart, r.incomingEnd, "yavin-conflict-incoming");
      add(region.endLine, region.endLine, "yavin-conflict-header");
    }
    decorations.set(model, model.deltaDecorations(decorations.get(model) ?? [], decs));
    updateContext();
  };

  const regionAtCursor = (): ConflictRegion | undefined => {
    const line = editor.getPosition()?.lineNumber;
    if (line === undefined) return undefined;
    return regions.find((region) => line >= region.startLine && line <= region.endLine);
  };
  const updateContext = () => inConflict.set(regionAtCursor() !== undefined);

  const resolve = (choice: Choice) => {
    const model = editor.getModel();
    const region = regionAtCursor();
    if (!model || !region) return;
    const lines = resolveRegionLines(region, choice);
    const endColumn = model.getLineMaxColumn(Math.min(region.endLine, model.getLineCount()));
    editor.executeEdits("merge-conflict", [
      {
        range: new monaco.Range(region.startLine, 1, region.endLine, endColumn),
        text: lines.join("\n"),
      },
    ]);
    // The edit fires onDidChangeModelContent → repaint, which re-parses and re-decorates.
  };

  const navigate = (direction: 1 | -1) => {
    if (!regions.length) return;
    const line = editor.getPosition()?.lineNumber ?? 1;
    const ordered = direction === 1 ? regions : [...regions].reverse();
    const next =
      ordered.find((region) =>
        direction === 1 ? region.startLine > line : region.endLine < line,
      ) ?? ordered[0]!;
    editor.setPosition({ lineNumber: next.startLine, column: 1 });
    editor.revealLineInCenter(next.startLine);
  };

  const actions = [
    editor.addAction({
      id: "yavin.conflict.acceptCurrent",
      label: "Merge Conflict: Accept Current Change",
      precondition: IN_CONFLICT,
      contextMenuGroupId: "9_merge",
      contextMenuOrder: 1,
      run: () => resolve("current"),
    }),
    editor.addAction({
      id: "yavin.conflict.acceptIncoming",
      label: "Merge Conflict: Accept Incoming Change",
      precondition: IN_CONFLICT,
      contextMenuGroupId: "9_merge",
      contextMenuOrder: 2,
      run: () => resolve("incoming"),
    }),
    editor.addAction({
      id: "yavin.conflict.acceptBoth",
      label: "Merge Conflict: Accept Both Changes",
      precondition: IN_CONFLICT,
      contextMenuGroupId: "9_merge",
      contextMenuOrder: 3,
      run: () => resolve("both"),
    }),
    editor.addAction({
      id: "yavin.conflict.next",
      label: "Merge Conflict: Next Conflict",
      keybindings: [monaco.KeyMod.Alt | monaco.KeyCode.F8],
      run: () => navigate(1),
    }),
    editor.addAction({
      id: "yavin.conflict.previous",
      label: "Merge Conflict: Previous Conflict",
      keybindings: [monaco.KeyMod.Alt | monaco.KeyMod.Shift | monaco.KeyCode.F8],
      run: () => navigate(-1),
    }),
  ];

  const subscriptions = [
    editor.onDidChangeModelContent(repaint),
    editor.onDidChangeModel(repaint),
    editor.onDidChangeCursorPosition(updateContext),
  ];
  repaint();

  return () => {
    for (const action of actions) action.dispose();
    for (const subscription of subscriptions) subscription.dispose();
    const model = editor.getModel();
    const ids = model && decorations.get(model);
    if (model && ids && !model.isDisposed()) model.deltaDecorations(ids, []);
  };
}
