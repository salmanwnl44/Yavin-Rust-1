import { useMemo, useSyncExternalStore } from "react";
import type { MinimapPreferences } from "../services/minimapPreferences";
import type { SettingsRegistry } from "../services/settings/settings";
import type { WorkspaceId } from "../services/terminalProtocol";
import {
  EDITOR_SETTING_LIST,
  resolveEditorSettings,
  type ResolvedEditorSettings,
} from "./editorSettings";
import { editorThemes } from "./themes";

/**
 * What the editor shows in `workspace`, as the settings resolve there (IDE-03): re-rendering
 * only when one of the editor's own settings changes for that workspace -- never for another
 * workspace's, never for another subsystem's. The object is stable between changes, so the
 * editor updates its options only when something it shows changed.
 */
export function useEditorSettings(
  registry: SettingsRegistry,
  workspace: WorkspaceId | null,
  minimap: MinimapPreferences,
): ResolvedEditorSettings {
  const source = useMemo(() => {
    const ids = new Set(EDITOR_SETTING_LIST.map((definition) => definition.id));
    let snapshot = resolveEditorSettings(registry, workspace, minimap);
    return {
      subscribe: (listener: () => void) => {
        const refresh = () => {
          snapshot = resolveEditorSettings(registry, workspace, minimap);
          listener();
        };
        const offSettings = registry.subscribe(workspace, (change) => {
          if (ids.has(change.id)) refresh();
        });
        // Extensions' themes come and go (EXT-04): only a change to the theme shown matters.
        const offThemes = editorThemes.subscribe(() => {
          const next = resolveEditorSettings(registry, workspace, minimap);
          if (next.settings.theme !== snapshot.settings.theme) {
            snapshot = next;
            listener();
          }
        });
        return () => {
          offSettings();
          offThemes();
        };
      },
      getSnapshot: () => snapshot,
    };
  }, [registry, workspace, minimap]);
  return useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot);
}
