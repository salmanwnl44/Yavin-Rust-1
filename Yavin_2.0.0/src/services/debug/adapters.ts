/**
 * The debug adapters Yavin can start (IDE-05), and how an adapter-neutral configuration
 * becomes that adapter's `launch` / `attach` arguments. Which program runs an adapter, with
 * which command line, is the native allow-list's (`src-tauri/src/dap.rs`: same ids); this is
 * the protocol side of each. Adapter-specific knowledge lives here and nowhere else -- not in
 * the session, not in React.
 */
import type { DebugConfiguration } from "./config.ts";

export interface DebugAdapterDefinition {
  id: string;
  label: string;
  /** The `adapterID` sent with `initialize`. */
  adapterID: string;
  /** What the user installs when it is missing. */
  install: string;
  /** `launch` arguments: `program`, `cwd` (absolute paths), and the rest of the configuration. */
  launchArguments(
    config: DebugConfiguration,
    resolved: { program: string; cwd: string },
  ): Record<string, unknown>;
  /** `attach` arguments: to a debuggee already listening on this machine. */
  attachArguments(config: DebugConfiguration, resolved: { cwd: string }): Record<string, unknown>;
}

export const DEBUG_ADAPTERS: readonly DebugAdapterDefinition[] = [
  {
    id: "debugpy",
    label: "Python (debugpy)",
    adapterID: "debugpy",
    install: "pip install debugpy",
    launchArguments: (config, resolved) => ({
      name: config.name,
      type: "debugpy",
      request: "launch",
      program: resolved.program,
      args: config.args,
      cwd: resolved.cwd,
      env: config.env,
      stopOnEntry: config.stopOnEntry,
      // Output arrives as DAP `output` events, shown in the Debug Console; nothing is run in a
      // terminal (Yavin does not offer `runInTerminal`).
      console: "internalConsole",
      redirectOutput: true,
      justMyCode: true,
    }),
    attachArguments: (config, resolved) => ({
      name: config.name,
      type: "debugpy",
      request: "attach",
      connect: { host: "127.0.0.1", port: config.port },
      pathMappings: [{ localRoot: resolved.cwd, remoteRoot: resolved.cwd }],
      justMyCode: true,
    }),
  },
];

export const adapterById = (id: string) => DEBUG_ADAPTERS.find((adapter) => adapter.id === id);
