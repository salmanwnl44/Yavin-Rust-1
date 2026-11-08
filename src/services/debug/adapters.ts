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
    // JavaScript / TypeScript via vscode-js-debug's standalone DAP server (WS6). Source maps let
    // breakpoints bind in the original TypeScript; `<node_internals>` is skipped so stepping stays
    // in the user's code. The adapter is resolved natively (a workspace-local `@vscode/js-debug`);
    // it is reported unavailable, with how to install it, when absent — never downloaded silently.
    id: "node",
    label: "JavaScript (js-debug)",
    adapterID: "pwa-node",
    install: "npm install -D @vscode/js-debug",
    launchArguments: (config, resolved) => ({
      name: config.name,
      type: "pwa-node",
      request: "launch",
      program: resolved.program,
      args: config.args,
      cwd: resolved.cwd,
      env: config.env,
      stopOnEntry: config.stopOnEntry,
      console: "internalConsole",
      sourceMaps: true,
      // Keep stepping in the user's own code, not Node's internals or dependencies.
      skipFiles: ["<node_internals>/**"],
    }),
    attachArguments: (config, resolved) => ({
      name: config.name,
      type: "pwa-node",
      request: "attach",
      port: config.port,
      cwd: resolved.cwd,
      sourceMaps: true,
      skipFiles: ["<node_internals>/**"],
    }),
  },
  {
    // Rust/C/C++ via LLVM's lldb-dap, which speaks DAP over stdio (WS6 Part 3) — no bridge. The
    // `program` is a compiled executable: for a Cargo test it is the test binary the native side
    // resolves from `cargo test --no-run` metadata, never a renderer path.
    id: "lldb",
    label: "Rust/C++ (lldb-dap)",
    adapterID: "lldb-dap",
    install: "install LLVM (lldb-dap) or the CodeLLDB extension",
    launchArguments: (config, resolved) => ({
      name: config.name,
      type: "lldb-dap",
      request: "launch",
      program: resolved.program,
      args: config.args,
      cwd: resolved.cwd,
      env: config.env,
      stopOnEntry: config.stopOnEntry,
    }),
    attachArguments: (config, resolved) => ({
      name: config.name,
      type: "lldb-dap",
      request: "attach",
      cwd: resolved.cwd,
    }),
  },
  {
    id: "debugpy",
    label: "Python (debugpy)",
    adapterID: "debugpy",
    install: "pip install debugpy",
    launchArguments: (config, resolved) => ({
      name: config.name,
      type: "debugpy",
      request: "launch",
      // A module launch (`python -m <module>`, e.g. pytest) when `module` is set, else a program.
      ...(config.module ? { module: config.module } : { program: resolved.program }),
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
