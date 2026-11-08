import { useEffect, useMemo, useState } from "react";
import { native } from "../native";
import { createTestingPlatform } from "./platform";
import type { TestingPlatform, TestDebugDependency } from "./platform";
import { createTestRunner } from "./runService";
import type { DebugService } from "../debug/service";

/**
 * Builds the workspace's {@link TestingPlatform} for the Test Explorer (WS5).
 *
 * Detection reuses the existing `list_workspace_files` command (the Explorer's own) to read the
 * folder's top-level entries and pick the framework adapter from them — no new native surface for
 * discovery. Execution is wired to the authorized, allow-listed `run_test` / `cancel_test` seam
 * (the checker-style runner), so the UI never spawns a process itself and never builds a shell
 * string. Until a run happens the native side is not touched, so detection is cheap and safe.
 *
 * Returns `null` while no folder is open or markers are still being read, which the view renders
 * as its "open a folder" state.
 */
export function useWorkspaceTestingPlatform(
  folder: string | null,
  debugService?: DebugService | null,
): TestingPlatform | null {
  const [markers, setMarkers] = useState<readonly string[] | null>(null);

  useEffect(() => {
    let live = true;
    setMarkers(null);
    if (!folder) return;
    void native("list_workspace_files", { path: folder, maxDepth: 1 })
      .then((root) => {
        if (live) setMarkers((root.children ?? []).map((child) => child.name));
      })
      .catch(() => {
        // A folder we cannot list has no detectable framework, which the view states plainly.
        if (live) setMarkers([]);
      });
    return () => {
      live = false;
    };
  }, [folder]);

  // The runner is stable for the window: it only forwards argv to the authorized native runner.
  const run = useMemo(
    () =>
      createTestRunner({
        // The adapter id is the command's program name (vitest/jest); the native side resolves
        // the real binary and re-authorizes the argv, so nothing here can choose a program.
        run: (command) => native("run_test", { adapter: command.program, args: [...command.args] }),
        cancel: () => native("cancel_test"),
      }),
    [],
  );

  // Which DAP adapters are actually installed (WS6): the native probe gates Debug Test so a
  // framework is enabled only when its debugger resolves, never merely because it is registered.
  const [availableAdapters, setAvailableAdapters] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    let live = true;
    if (!folder) return;
    void native("dap_available_adapters", { root: folder })
      .then((ids) => {
        if (live) setAvailableAdapters(new Set(ids));
      })
      .catch(() => {
        if (live) setAvailableAdapters(new Set());
      });
    return () => {
      live = false;
    };
  }, [folder]);

  // The DAP seam (WS5.3): launch a test's debug session through the existing DebugService. Absent
  // when no debugger is available, which the platform reports as "debugging not available here".
  const debug = useMemo<TestDebugDependency | undefined>(
    () =>
      folder && debugService
        ? { workspace: folder, availableAdapters, start: (config) => debugService.start(config) }
        : undefined,
    [folder, debugService, availableAdapters],
  );

  return useMemo(() => {
    if (!folder || markers === null) return null;
    return createTestingPlatform({ markerNames: markers, run, debug });
  }, [folder, markers, run, debug]);
}
