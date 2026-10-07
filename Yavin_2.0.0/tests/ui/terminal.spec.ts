import { readFileSync } from "node:fs";
import { test, expect } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { appAlert, editorSelections, withEditor } from "./editor-harness";
import {
  FIXTURE_DOCUMENTS,
  FIXTURE_ICON,
  FIXTURE_PACKAGES,
  fixtureIndex,
} from "../../src/services/extensions/marketplace/fixtures";

/**
 * The extension host's real API (`bootstrap.js`) and the sample extension, read here and run by
 * the mock's in-page host (IDE-08) -- the same code the native QuickJS host runs.
 */
const EXTENSION_HOST = {
  bootstrap: readFileSync(
    new URL("../../src-tauri/crates/ide-plugin-host/src/bootstrap.js", import.meta.url),
    "utf8",
  ),
  sampleManifest: readFileSync(
    new URL("../../extensions/samples/hello-world/yavin-extension.json", import.meta.url),
    "utf8",
  ),
  sampleCode: readFileSync(
    new URL("../../extensions/samples/hello-world/extension.js", import.meta.url),
    "utf8",
  ),
};
const SAMPLE_FOLDER = "/repo/extensions/samples/hello-world";

/**
 * The marketplace the mock serves (IDE-09): the deterministic test catalog, in the real registry
 * format -- read by the real YavinRegistryProvider -- with its packages' manifests and code.
 * Hello World is the real sample's manifest and code.
 */
const MARKET = (() => {
  const index = fixtureIndex({ manifest: JSON.parse(EXTENSION_HOST.sampleManifest) });
  FIXTURE_PACKAGES["packages/yavin-samples.hello-world-2.0.0.yvx"].code = EXTENSION_HOST.sampleCode;
  return {
    index: JSON.stringify(index),
    packages: FIXTURE_PACKAGES,
    documents: FIXTURE_DOCUMENTS,
    icon: FIXTURE_ICON,
  };
})();

interface Call {
  command: string;
  args: Record<string, unknown>;
}

const CMD = "C:\\Windows\\System32\\cmd.exe";
const BASH = "C:\\Program Files\\Git\\bin\\bash.exe";

/** Opens the bottom panel through the Terminal menu. */
async function openPanel(page: Page) {
  await page.getByRole("menubar").getByRole("menuitem", { name: "Terminal", exact: true }).click();
  await page
    .getByRole("menu", { name: "Terminal", exact: true })
    .getByRole("menuitemcheckbox", { name: "Show / Hide Panel", exact: true })
    .click();
}

async function terminalMenu(page: Page, item: string) {
  await page.getByRole("menubar").getByRole("menuitem", { name: "Terminal", exact: true }).click();
  await page
    .getByRole("menu", { name: "Terminal", exact: true })
    .getByRole("menuitem", { name: item, exact: true })
    .click();
}

/**
 * Installs a Tauri mock that can deliver events, so shells can be driven from the test.
 * `failOpen` makes a spawn fail the way a missing workspace would.
 */
async function desktop(
  page: Page,
  options: {
    failOpen?: string;
    failGit?: string;
    ports?: unknown[];
    checkers?: { id: string; label: string }[];
    checkerOutput?: string;
    /** What the checker exits with. Nonzero and no diagnostics means it did not run. */
    checkerCode?: number;
    trust?: { trusted: boolean; decided: boolean; root: string | null; parent: string | null };
    /** Discovery finds one Unix bash, the default: its folders are this POSIX workspace's. */
    unixShell?: boolean;
    /** Installed extensions' folders and manifest texts (IDE-07 discovery). */
    extensions?: { folder: string; manifest: string | null; error: string | null }[];
    /** Installed extensions' code, by extension id, as the native side reads it (IDE-08). */
    extensionCode?: Record<string, string>;
    /** The marketplace (IDE-09): unreachable, slow to answer its index. */
    marketplace?: { down?: boolean; indexDelayMs?: number };
  } = {},
) {
  await page.addInitScript(
    (setup) => {
      const calls: Call[] = [];
      // Trust is stateful, like the native side: a decision made in the dialog must change
      // what later calls see, or the test can never observe the effect of trusting.
      let trust = setup.trust ?? {
        trusted: true,
        decided: true,
        root: "/work",
        parent: "/",
      };
      const callbacks: Record<number, (event: unknown) => void> = {};
      const listeners: Record<string, number[]> = {};
      const sequences: Record<string, number> = {};
      type Channel = { onmessage: (message: unknown) => void };
      /**
       * Each launch, by `sessionId:generation`, as the native side keeps it: the service's
       * lifecycle channel, each attached view's channel, and what a view attaching later is
       * replayed (its `Running`, its output, its end).
       */
      const launches: Record<
        string,
        { lifecycle: Channel; views: Record<string, Channel>; replay: unknown[] }
      > = {};
      let nextId = 1;

      // --- The extension host (IDE-08), as the native side and the QuickJS host behave -----------
      type Identity = {
        workspaceId: string;
        hostGeneration: number;
        workspaceFolder: string | null;
        apiVersion: string;
      };
      const hosts: Record<
        number,
        {
          identity: Identity | null;
          extensions: Map<string, (text: string) => void>;
          ended: boolean;
        }
      > = {};
      let nextHostSession = 1;
      const emit = (event: string, payload: unknown) =>
        (window as unknown as { __emit: (event: string, payload: unknown) => void }).__emit(
          event,
          payload,
        );
      const hostOut = (session: number, message: Record<string, unknown>) =>
        setTimeout(() => {
          if (!hosts[session]?.ended)
            emit("ext-host-message", { session, message: JSON.stringify(message) });
        }, 0);
      const endHost = (session: number, code: number) => {
        const one = hosts[session];
        if (!one || one.ended) return;
        one.ended = true;
        setTimeout(() => emit("ext-host-exit", { session, code, error: null }), 0);
      };
      const sampleId = (() => {
        const manifest = JSON.parse(setup.host.sampleManifest) as {
          publisher: string;
          name: string;
        };
        return `${manifest.publisher}.${manifest.name}`;
      })();
      // --- The marketplace and installer (IDE-09), as the native side behaves -----------------
      const market = { down: setup.marketplace?.down ?? false, failCommit: false };
      /** Installed through the marketplace: id → manifest text and code. */
      const installedExtensions: Record<string, { manifest: string; code: string | null }> = {};
      const staged: Record<string, { id: string; manifest: string; code: string | null }> = {};
      const aside: Record<string, { manifest: string; code: string | null } | undefined> = {};
      let nextToken = 1;
      Object.assign(window, {
        /** The marketplace goes down or comes back. */
        __market: market,
      });
      const codeOf = (id: string) =>
        installedExtensions[id]
          ? installedExtensions[id].code
          : id === sampleId
            ? setup.host.sampleCode
            : (setup.extensionCode?.[id] ?? null);
      const hostHandle = (session: number, text: string) => {
        const one = hosts[session];
        if (!one || one.ended) return;
        const message = JSON.parse(text);
        if (message.type === "init") {
          one.identity = message;
          hostOut(session, { type: "ready" });
          return;
        }
        if (message.type === "shutdown") return endHost(session, 0);
        const identity = one.identity;
        if (
          !identity ||
          message.workspaceId !== identity.workspaceId ||
          message.hostGeneration !== identity.hostGeneration
        )
          return hostOut(session, {
            type: "error",
            error: { code: "StaleGeneration", message: "stale" },
          });
        const id = message.extensionId as string;
        const ids = {
          extensionId: id,
          workspaceId: identity.workspaceId,
          hostGeneration: identity.hostGeneration,
        };
        if (message.type === "load") {
          const code = codeOf(id);
          if (code === null)
            return hostOut(session, {
              type: "error",
              ...ids,
              error: { code: "LoadFailed", message: `${id} has no code.` },
            });
          const realm: Record<string, unknown> = {
            // Everything the extension sends carries its real identity, as the native host stamps it.
            __yavin_send: (out: string) => hostOut(session, { ...JSON.parse(out), ...ids }),
          };
          const init = JSON.stringify({
            ...ids,
            workspaceFolder: identity.workspaceFolder,
            extensionPath: `/extensions/${id}`,
            apiVersion: identity.apiVersion,
          });
          try {
            new Function("globalThis", setup.host.bootstrap.replaceAll("__YAVIN_INIT__", init))(
              realm,
            );
            const receive = realm.__yavin_receive as (text: string) => void;
            (realm.__yavin_load as (source: string) => void)(code);
            one.extensions.set(id, receive);
            hostOut(session, { type: "loaded", ...ids });
          } catch (error) {
            hostOut(session, {
              type: "error",
              ...ids,
              error: { code: "LoadFailed", message: String((error as Error).message) },
            });
          }
          return;
        }
        if (message.type === "unload") {
          one.extensions.delete(id);
          return hostOut(session, { type: "unloaded", ...ids });
        }
        const receive = one.extensions.get(id);
        if (!receive)
          return hostOut(session, {
            type: "response",
            requestId: message.requestId,
            ok: false,
            error: { code: "NotLoaded", message: "not loaded" },
            ...ids,
          });
        try {
          receive(text);
        } catch (error) {
          if (message.type === "request")
            hostOut(session, {
              type: "response",
              requestId: message.requestId,
              ok: false,
              error: { code: "ExtensionFailed", message: String((error as Error).message) },
              ...ids,
            });
        }
      };
      // The live host process dies (exit code 3), as a crash would end it.
      Object.assign(window, {
        __crashExtensionHost: () => {
          for (const key of Object.keys(hosts))
            if (!hosts[Number(key)].ended) endHost(Number(key), 3);
        },
      });

      Object.assign(window, {
        __calls: calls,
        // Delivers a native event to every listener registered for it.
        __emit: (event: string, payload: unknown) => {
          for (const id of listeners[event] ?? []) callbacks[id]?.({ event, id, payload });
        },
        // A terminal's output and exit as the native side sends them -- output to each view
        // attached to that launch, its end (Exiting, then the exit) to the service and the views,
        // never broadcast: for its latest launch unless one is named, bytes in base64, numbered
        // from 0 within the launch.
        // A shell-integration signal (TERMINAL-05A) goes to the service and the views, live,
        // and is never replayed.
        __terminal: (
          kind: "output" | "exit" | "shell",
          sessionId: string,
          value: string | number | Record<string, unknown>,
          launch?: number,
        ) => {
          const generation =
            launch ??
            (calls.filter((c) => c.command === "terminal_open" && c.args.id === sessionId).at(-1)
              ?.args.generation as number);
          const key = `${sessionId}:${generation}`;
          const next = sequences[key] ?? 0;
          const launch_ = launches[key];
          if (!launch_) return;
          const toViews = (message: unknown) => {
            launch_.replay.push(message);
            for (const view of Object.values(launch_.views)) view.onmessage(message);
          };
          const toAll = (message: unknown) => {
            toViews(message);
            launch_.lifecycle.onmessage(message);
          };
          if (kind === "shell") {
            const message = { kind, sessionId, generation, ...(value as object) };
            for (const view of Object.values(launch_.views)) view.onmessage(message);
            launch_.lifecycle.onmessage(message);
          } else if (kind === "output") {
            sequences[key] = next + 1;
            const bytes = btoa(String.fromCharCode(...new TextEncoder().encode(value as string)));
            toViews({ kind: "output", sessionId, generation, seq: next, bytes });
          } else {
            const lastSeq = next === 0 ? null : next - 1;
            toAll({ kind: "state", sessionId, generation, state: "Exiting" });
            toAll({ kind: "exit", sessionId, generation, exitCode: value, lastSeq });
            launch_.views = {};
          }
        },
        isTauri: true,
        __TAURI_INTERNALS__: {
          metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
          transformCallback: (callback: (event: unknown) => void) => {
            const id = nextId++;
            callbacks[id] = callback;
            return id;
          },
          unregisterCallback: (id: number) => delete callbacks[id],
          invoke: async (command: string, raw: Record<string, unknown> = {}) => {
            // Terminal commands take one contract request; it is recorded flat, with the
            // session id as `id`, the shell as `shell` and the size as `cols`/`rows`.
            const request = raw.request as
              | {
                  sessionId: string;
                  profile?: { executable: string; cwd: string | null } | null;
                  cwd?: string | null;
                  dimensions?: { cols: number; rows: number };
                }
              | undefined;
            const args: Record<string, unknown> = request
              ? {
                  ...request,
                  id: request.sessionId,
                  shell: request.profile?.executable ?? "",
                  cwd: request.cwd ?? request.profile?.cwd ?? undefined,
                  cols: request.dimensions?.cols,
                  rows: request.dimensions?.rows,
                  ...(raw.subscriptionId ? { subscriptionId: raw.subscriptionId } : {}),
                }
              : raw;
            calls.push({ command, args });
            if (command === "plugin:event|listen") {
              const event = args.event as string;
              (listeners[event] ??= []).push(args.handler as number);
              return nextId++;
            }
            if (command === "get_default_workspace") return "/work";
            // One folder, for a reveal to show, and one file.
            if (command === "list_workspace_files" && args.path === "/work/src")
              return { path: "/work/src", name: "src", is_dir: true, children: [] };
            if (command === "list_workspace_files")
              return {
                path: "/work",
                name: "work",
                is_dir: true,
                children: [
                  { path: "/work/src", name: "src", is_dir: true, children: null },
                  { path: "/work/file.ts", name: "file.ts", is_dir: false, children: null },
                ],
              };
            // Any file reads as 30 numbered lines, so a jump to a line can be checked.
            if (command === "read_file_content")
              return Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n");
            if (command === "list_listening_ports") return setup.ports ?? [];
            if (command === "workspace_trust") return trust;
            if (command === "set_workspace_trust") {
              trust = { ...trust, trusted: (args as { trusted: boolean }).trusted, decided: true };
              return trust;
            }
            if (command === "trusted_folders") return trust.trusted ? [trust.root] : [];
            if (command === "forget_trusted_folder") {
              trust = { ...trust, trusted: false, decided: false };
              return trust;
            }
            // A restricted folder is offered no checkers, matching the native side.
            if (command === "available_checkers")
              return trust.trusted ? (setup.checkers ?? []) : [];
            // Open Folder… answers with whatever the test put in `__openFolder`.
            if (command === "open_folder_dialog")
              return (window as unknown as { __openFolder?: string }).__openFolder ?? null;
            if (command === "run_checker") {
              const scenario = window as unknown as {
                __scenarioCheckerOutput?: string;
                __scenarioCheckerCode?: number;
                __checkerDelay?: number;
                __checkerOutcome?: "completed" | "cancelled" | "timedOut";
              };
              // A slow checker (a cold `cargo check`), for what happens while it runs.
              if (scenario.__checkerDelay)
                await new Promise((resolve) => setTimeout(resolve, scenario.__checkerDelay));
              const output = scenario.__scenarioCheckerOutput ?? setup.checkerOutput ?? "";
              // As the native side answers (IDE-01): how it ended, its output, its exit code --
              // a checker exits nonzero when it finds problems, so the tests say which -- and the
              // folder it ran in, which its relative paths are relative to.
              return {
                outcome: scenario.__checkerOutcome ?? "completed",
                output,
                code: scenario.__scenarioCheckerCode ?? setup.checkerCode ?? 0,
                root: "/work",
              };
            }
            if (command === "stop_listening_process") return null;
            // Discovery (TERMINAL-05): every shell looked for, one of them not installed.
            if (command === "terminal_shells" && setup.unixShell)
              return [
                {
                  name: "Bash",
                  path: "/bin/bash",
                  kind: "bash",
                  platform: "unix",
                  available: true,
                  reason: null,
                  isDefault: true,
                },
              ];
            if (command === "terminal_shells")
              return [
                {
                  name: "Command Prompt",
                  path: "C:\\Windows\\System32\\cmd.exe",
                  kind: "cmd",
                  platform: "windows",
                  available: true,
                  reason: null,
                  isDefault: true,
                },
                {
                  name: "PowerShell",
                  path: "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
                  kind: "pwsh",
                  platform: "windows",
                  available: false,
                  reason: "PowerShell 7 (pwsh.exe) is not installed.",
                  isDefault: false,
                },
                {
                  name: "Git Bash",
                  path: "C:\\Program Files\\Git\\bin\\bash.exe",
                  kind: "bash",
                  platform: "windows",
                  available: true,
                  reason: null,
                  isDefault: false,
                },
              ];
            if (command === "terminal_open") {
              if (setup.failOpen) throw setup.failOpen;
              const running = {
                kind: "state",
                sessionId: request!.sessionId,
                generation: args.generation,
                state: "Running",
                pid: 4242,
              };
              launches[`${request!.sessionId}:${args.generation}`] = {
                lifecycle: raw.events as Channel,
                views: {},
                replay: [running],
              };
              // A slow start, for tests of what happens meanwhile; its end is recorded too.
              const delay = (window as unknown as { __openDelay?: number }).__openDelay;
              if (delay) {
                await new Promise((resolve) => setTimeout(resolve, delay));
                calls.push({ command: "terminal_open:done", args });
              }
              // The session as the native side answers it: already running.
              return {
                ...request,
                generation: args.generation,
                state: "Running",
                pid: 4242,
                startedAt: 0,
                exitCode: null,
              };
            }
            // A view attaches: replayed what its launch has said so far, then sent it live.
            if (command === "terminal_subscribe") {
              const subscribed = raw.request as {
                subscriptionId: string;
                sessionId: string;
                generation: number;
              };
              const launch_ = launches[`${subscribed.sessionId}:${subscribed.generation}`];
              if (!launch_) throw "InvalidSession: That terminal is no longer running.";
              const view = raw.events as Channel;
              for (const message of launch_.replay) view.onmessage(message);
              launch_.views[subscribed.subscriptionId] = view;
              return null;
            }
            if (command === "terminal_unsubscribe") {
              const { subscriptionId } = raw.request as { subscriptionId: string };
              for (const launch_ of Object.values(launches)) delete launch_.views[subscriptionId];
              return null;
            }
            // A debug adapter (IDE-05), as `dap.rs` hands one to the window: DAP messages out as
            // `dap-message` events, its end as `dap-exit`. It debugs a pretend program -- the
            // launched file's lines in order, stopping at breakpoints -- like debugpy (`initialized`
            // after `launch`, `launch` answered after `configurationDone`).
            if (command.startsWith("dap_")) {
              const scenario = window as unknown as {
                __emit: (event: string, payload: unknown) => void;
                __dap?: {
                  session: number;
                  seq: number;
                  line: number;
                  epoch: number;
                  program: string;
                  breakpoints: number[];
                  launch: number | null;
                  ended: boolean;
                };
                __dapRunsForever?: boolean;
                __dapCapabilities?: Record<string, unknown>;
              };
              const say = (body: Record<string, unknown>) => {
                const state = scenario.__dap!;
                const session = state.session;
                const message = JSON.stringify({ seq: state.seq++, ...body });
                setTimeout(() => scenario.__emit("dap-message", { session, message }), 0);
              };
              const end = () => {
                const state = scenario.__dap;
                if (!state || state.ended) return;
                state.ended = true;
                const session = state.session;
                setTimeout(() => scenario.__emit("dap-exit", { session, code: 0, error: null }), 0);
              };
              if (command === "dap_stop_all") return null;
              if (command === "dap_stop") {
                end();
                return null;
              }
              if (command === "dap_start") {
                const session = (scenario.__dap?.session ?? 0) + 1;
                scenario.__dap = {
                  session,
                  seq: 1,
                  line: 0,
                  epoch: 0,
                  program: "",
                  breakpoints: [],
                  launch: null,
                  ended: false,
                };
                return { session, program: "/usr/bin/python3" };
              }
              // dap_send: one request.
              const state = scenario.__dap!;
              const request = JSON.parse((raw as { message: string }).message) as {
                seq: number;
                command: string;
                arguments?: Record<string, unknown>;
              };
              const ok = (body?: unknown, seq = request.seq, name = request.command) =>
                say({ type: "response", request_seq: seq, command: name, success: true, body });
              const event = (name: string, body?: unknown) =>
                say({ type: "event", event: name, body });
              const stopAt = (line: number, reason: string) => {
                state.line = line;
                state.epoch++;
                event("stopped", { reason, threadId: 1, allThreadsStopped: true });
              };
              const run = () => {
                const next = state.breakpoints
                  .filter((line) => line > state.line)
                  .sort((a, b) => a - b)[0];
                if (next !== undefined) stopAt(next, "breakpoint");
                else if (!scenario.__dapRunsForever) {
                  event("output", { category: "stdout", output: "done\n" });
                  event("exited", { exitCode: 0 });
                  event("terminated");
                }
              };
              const args = request.arguments ?? {};
              switch (request.command) {
                case "initialize":
                  ok({
                    supportsConfigurationDoneRequest: true,
                    supportsTerminateRequest: true,
                    ...scenario.__dapCapabilities,
                  });
                  break;
                case "launch":
                  state.program = String(args.program);
                  state.launch = request.seq;
                  event("initialized");
                  break;
                case "setBreakpoints": {
                  const lines = (args.breakpoints as { line: number }[]).map((bp) => bp.line);
                  state.breakpoints = lines;
                  ok({
                    breakpoints: lines.map((line, i) => ({ id: 10 + i, verified: true, line })),
                  });
                  break;
                }
                case "configurationDone":
                  ok();
                  ok(undefined, state.launch!, "launch");
                  run();
                  break;
                case "threads":
                  ok({ threads: [{ id: 1, name: "MainThread" }] });
                  break;
                case "stackTrace": {
                  const source = { path: state.program, name: state.program.split("/").pop() };
                  ok({
                    stackFrames: [
                      {
                        id: state.epoch * 10 + 1,
                        name: "work",
                        source,
                        line: state.line,
                        column: 1,
                      },
                      { id: state.epoch * 10 + 2, name: "<module>", source, line: 1, column: 1 },
                    ],
                  });
                  break;
                }
                case "scopes":
                  ok({
                    scopes: [
                      { name: "Locals", variablesReference: 1000 + state.epoch, expensive: false },
                    ],
                  });
                  break;
                case "variables":
                  ok({
                    variables:
                      (args.variablesReference as number) >= 2000
                        ? [
                            { name: "0", value: "1", variablesReference: 0 },
                            { name: "1", value: "2", variablesReference: 0 },
                          ]
                        : [
                            {
                              name: "line",
                              value: String(state.line),
                              type: "int",
                              variablesReference: 0,
                            },
                            {
                              name: "items",
                              value: "[1, 2]",
                              type: "list",
                              variablesReference: 2000 + state.epoch,
                            },
                          ],
                  });
                  break;
                case "continue":
                  ok({ allThreadsContinued: true });
                  run();
                  break;
                case "next":
                case "stepIn":
                  ok();
                  stopAt(state.line + 1, "step");
                  break;
                case "stepOut":
                  ok();
                  stopAt(state.line + 2, "step");
                  break;
                case "pause":
                  ok();
                  stopAt(state.line || 1, "pause");
                  break;
                case "evaluate":
                  ok({
                    result: `${String(args.expression)} = ${state.line}`,
                    variablesReference: 0,
                  });
                  break;
                case "terminate":
                  ok();
                  event("terminated");
                  break;
                case "disconnect":
                  ok();
                  end();
                  break;
                default:
                  ok();
              }
              return null;
            }
            // The installed extensions (the user's folder first) and the sample (as a development
            // build finds it).
            if (command === "extensions_list")
              return {
                root: "/data/extensions",
                extensions: [
                  ...Object.entries(installedExtensions).map(([id, one]) => ({
                    folder: `/data/extensions/${id}`,
                    manifest: one.manifest,
                    error: null,
                  })),
                  ...(setup.extensions ?? []),
                  {
                    folder: setup.host.sampleFolder,
                    manifest: setup.host.sampleManifest,
                    error: null,
                  },
                ],
                skipped: 0,
              };
            if (command === "marketplace_default_registry") return "https://registry.test/yavin/";
            if (command === "marketplace_get_text" || command === "marketplace_get_icon") {
              if (market.down)
                throw "MarketplaceUnavailable: the marketplace could not be reached (offline).";
              const path = args.path as string;
              if (command === "marketplace_get_icon") return setup.market.icon;
              if (path === "index.json") {
                const delay = setup.marketplace?.indexDelayMs ?? 0;
                if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
                return setup.market.index;
              }
              return setup.market.documents[path] ?? `# ${path}\n\nFixture document.`;
            }
            if (command === "extensions_stage") {
              const source = args.source as { kind: string; path: string };
              const id = args.expectedId as string;
              const version = args.expectedVersion as string;
              const pkg = setup.market.packages[source.path];
              if (!pkg || pkg.broken === "missing")
                throw `NotFound: ${source.path} is not in the marketplace.`;
              if (pkg.broken === "unsafe")
                throw 'UnsafePackage: "../escape.txt" leaves the extension ("..")';
              const manifest = pkg.manifest as { publisher: string; name: string; version: string };
              if (`${manifest.publisher}.${manifest.name}` !== id || manifest.version !== version)
                throw `ManifestMismatch: the package is ${manifest.publisher}.${manifest.name} ${manifest.version}.`;
              const token = `${(nextToken++).toString(16).padStart(8, "0")}`;
              staged[token] = {
                id,
                manifest: JSON.stringify(pkg.manifest),
                code: pkg.code ?? null,
              };
              return {
                token,
                manifest: staged[token].manifest,
                files: 2,
                bytes: 100,
                sha256: "0".repeat(64),
                packageSize: 100,
              };
            }
            if (command === "extensions_commit") {
              if (market.failCommit)
                throw "InstallFailed: the installed version could not be moved aside (it is in use).";
              const one = staged[args.token as string];
              delete staged[args.token as string];
              aside[args.token as string] = installedExtensions[one.id];
              installedExtensions[one.id] = { manifest: one.manifest, code: one.code };
              return {
                folder: `/data/extensions/${one.id}`,
                replaced: !!aside[args.token as string],
              };
            }
            if (command === "extensions_finish") {
              const previous = aside[args.token as string];
              delete aside[args.token as string];
              if (!args.keep) {
                if (previous) installedExtensions[args.id as string] = previous;
                else delete installedExtensions[args.id as string];
              }
              return null;
            }
            if (command === "extensions_discard") {
              delete staged[args.token as string];
              return null;
            }
            if (command === "extensions_uninstall") {
              const id = args.id as string;
              if (!installedExtensions[id])
                throw `UnknownExtension: ${id} is not installed in Yavin's extensions folder.`;
              delete installedExtensions[id];
              return `/data/extensions/${id}`;
            }
            // The extension host (IDE-08), in the page: the real `bootstrap.js` and extension code,
            // the native contract around them -- start refused unless trusted, a `load` filled
            // with the extension's code, messages and the end as events by session.
            if (command === "ext_host_start") {
              if (!trust.trusted) throw "TrustRequired: This folder is not trusted.";
              const session = nextHostSession++;
              hosts[session] = { identity: null, extensions: new Map(), ended: false };
              return session;
            }
            if (command === "ext_host_send") {
              const session = args.session as number;
              const one = hosts[session];
              if (!one || one.ended) throw "HostStopped: The extension host has stopped.";
              const text = args.message as string;
              setTimeout(() => hostHandle(session, text), 0);
              return null;
            }
            if (command === "ext_host_stop") {
              endHost(args.session as number, 0);
              return null;
            }
            if (command === "ext_host_stop_all") {
              const live = Object.keys(hosts).filter((key) => !hosts[Number(key)].ended);
              for (const key of live) endHost(Number(key), 0);
              return live.length;
            }
            if (command === "git_open_repo") return { repoId: "/work", root: "/work" };
            if (command === "git_repo_state") return "";
            if (command === "git_exec")
              return setup.failGit
                ? { stdout: "", stderr: setup.failGit, code: 128, truncated: false }
                : { stdout: "", stderr: "", code: 0, truncated: false };
            return null;
          },
        },
        __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
      });
    },
    { ...options, host: { ...EXTENSION_HOST, sampleFolder: SAMPLE_FOLDER }, market: MARKET },
  );
  await page.goto("/");
}

const calls = (page: Page, command: string) =>
  page.evaluate(
    (name) =>
      (window as unknown as { __calls: Call[] }).__calls.filter((call) => call.command === name),
    command,
  );

const countCalls = async (page: Page, command: string) => (await calls(page, command)).length;

type TerminalEvent = (
  kind: "output" | "exit" | "shell",
  id: string,
  value: string | number | Record<string, unknown>,
  launch?: number,
) => void;

/** A shell-integration signal from a terminal's shell (TERMINAL-05A), as the native side found it. */
const signal = (page: Page, id: string, fields: Record<string, unknown>, launch?: number) =>
  page.evaluate(
    ([sessionId, value, generation]) =>
      (window as unknown as { __terminal: TerminalEvent }).__terminal(
        "shell",
        sessionId as string,
        value as Record<string, unknown>,
        generation as number | undefined,
      ),
    [id, fields, launch] as const,
  );

/** Output from a terminal's shell (its latest launch unless `launch` names another). */
const output = (page: Page, id: string, text: string, launch?: number) =>
  page.evaluate(
    ([sessionId, value, generation]) =>
      (window as unknown as { __terminal: TerminalEvent }).__terminal(
        "output",
        sessionId as string,
        value as string,
        generation as number | undefined,
      ),
    [id, text, launch] as const,
  );

/** A terminal's shell exiting with `code` (its latest launch unless `launch` names another). */
const exit = (page: Page, id: string, code: number, launch?: number) =>
  page.evaluate(
    ([sessionId, value, generation]) =>
      (window as unknown as { __terminal: TerminalEvent }).__terminal(
        "exit",
        sessionId as string,
        value as number,
        generation as number | undefined,
      ),
    [id, code, launch] as const,
  );

const uniqueIds = async (page: Page) => {
  const opened = await calls(page, "terminal_open");
  return [...new Set(opened.map((call) => call.args.id as string))];
};

/**
 * The distinct terminals opened so far, once at least `expected` exist. Ids are
 * de-duplicated because React's development StrictMode mounts effects twice, which
 * opens the same terminal again.
 */
async function terminalIds(page: Page, expected = 1): Promise<string[]> {
  await expect.poll(async () => (await uniqueIds(page)).length).toBeGreaterThanOrEqual(expected);
  return uniqueIds(page);
}

const view = (page: Page, id: string) => page.getByLabel(`Terminal ${id}`);

test("a shell starts with the panel and its output is displayed", async ({ page }) => {
  await desktop(page);
  await openPanel(page);
  const [id] = await terminalIds(page);

  await expect(page.getByRole("tab", { name: "Command Prompt", exact: true })).toBeVisible();
  const [open] = await calls(page, "terminal_open");
  // The size sent to the shell is a real measurement, not a placeholder.
  expect(open.args.cols).toBeGreaterThan(0);
  expect(open.args.rows).toBeGreaterThan(0);

  await output(page, id, "hello from the shell\r\n");
  await expect(view(page, id)).toContainText("hello from the shell");
});

test("typing reaches the shell as bytes", async ({ page }) => {
  await desktop(page);
  await openPanel(page);
  const [id] = await terminalIds(page);
  await view(page, id).click();

  await page.keyboard.type("ls");
  await page.keyboard.press("Enter");

  await expect
    .poll(async () => (await calls(page, "terminal_write")).map((c) => c.args.data).join(""))
    .toBe("ls\r");
});

test("output is delivered only to the terminal that produced it", async ({ page }) => {
  await desktop(page);
  await openPanel(page);
  await terminalIds(page);

  await page.getByLabel("New Terminal").click();
  const [first, second] = await terminalIds(page, 2);

  await output(page, first, "belongs to one");
  await output(page, second, "belongs to two");

  await expect(view(page, second)).toContainText("belongs to two");
  await expect(view(page, second)).not.toContainText("belongs to one");
  // Switching back shows the first terminal with only its own output.
  await page.getByRole("tab", { name: "Command Prompt", exact: true }).click();
  await expect(view(page, first)).toContainText("belongs to one");
  await expect(view(page, first)).not.toContainText("belongs to two");
});

test("terminals are named for their shell and numbered when repeated", async ({ page }) => {
  await desktop(page);
  await openPanel(page);
  await terminalIds(page);
  await page.getByLabel("New Terminal").click();

  await expect(page.getByRole("tab", { name: "Command Prompt", exact: true })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Command Prompt (2)", exact: true })).toBeVisible();
});

test("a different shell can be chosen for a new terminal", async ({ page }) => {
  await desktop(page);
  await openPanel(page);
  await terminalIds(page);

  await page.getByLabel("Choose a shell").click();
  await page.getByRole("menuitem", { name: "Git Bash", exact: true }).click();
  await terminalIds(page, 2);

  const opened = await calls(page, "terminal_open");
  expect(opened.some((call) => call.args.shell === BASH)).toBe(true);
  expect(opened.some((call) => call.args.shell === CMD)).toBe(true);
  await expect(page.getByRole("tab", { name: "Git Bash", exact: true })).toBeVisible();
});

test("splitting shows two terminals at once and unsplitting keeps both", async ({ page }) => {
  await desktop(page);
  await openPanel(page);
  await terminalIds(page);

  await page.getByLabel("Split Terminal").click();
  const [first, second] = await terminalIds(page, 2);
  await expect(view(page, first)).toBeVisible();
  await expect(view(page, second)).toBeVisible();

  // Unsplitting hides the second pane but does not end its shell.
  const closed = await countCalls(page, "terminal_close");
  await page.getByLabel("Unsplit Terminal").click();
  await expect(view(page, second)).toBeHidden();
  expect(await countCalls(page, "terminal_close")).toBe(closed);
});

test("closing one terminal leaves the others running", async ({ page }) => {
  await desktop(page);
  await openPanel(page);
  await terminalIds(page);
  await page.getByLabel("New Terminal").click();
  const [first, second] = await terminalIds(page, 2);

  const closed = await countCalls(page, "terminal_close");
  await page.getByLabel("Close Command Prompt (2)").click();

  await expect.poll(async () => countCalls(page, "terminal_close")).toBe(closed + 1);
  const closes = await calls(page, "terminal_close");
  expect(closes[closes.length - 1].args.id).toBe(second);
  await expect(view(page, first)).toBeVisible();
});

test("closing the last terminal leaves the panel open with a way to start another", async ({
  page,
}) => {
  // The panel holds Problems, Output and Ports as well, so it must not be torn down because
  // a terminal exited -- and it must not silently respawn the shell that was just killed.
  await desktop(page);
  await openPanel(page);
  const [first] = await terminalIds(page);
  await expect(page.getByRole("tab", { name: "Command Prompt", exact: true })).toBeVisible();

  await terminalMenu(page, "Close Terminal");
  await expect(page.getByRole("tablist", { name: "Panel views" })).toBeVisible();
  const empty = page.getByRole("region", { name: "No terminals" });
  await expect(empty).toBeVisible();
  expect(await terminalIds(page)).toHaveLength(1); // no new shell was started

  await empty.getByRole("button", { name: "New Terminal" }).click();
  const ids = await terminalIds(page, 2);
  expect(ids[1]).not.toBe(first);
  await expect(view(page, ids[1])).toBeVisible();
});

test("reopening the panel after closing every terminal starts a fresh one", async ({ page }) => {
  await desktop(page);
  await openPanel(page);
  const [first] = await terminalIds(page);

  await terminalMenu(page, "Close Terminal");
  await page.getByLabel("Close Panel").click();

  await openPanel(page);
  const ids = await terminalIds(page, 2);
  expect(ids[1]).not.toBe(first);
  await expect(view(page, ids[1])).toBeVisible();
});

test("hiding the panel keeps shells running", async ({ page }) => {
  await desktop(page);
  await openPanel(page);
  const [id] = await terminalIds(page);
  await output(page, id, "long running build");

  const closed = await countCalls(page, "terminal_close");
  await page.getByLabel("Close Panel").click();
  await expect(view(page, id)).toBeHidden();
  // Nothing was killed: the shell is still there, with its scrollback.
  expect(await countCalls(page, "terminal_close")).toBe(closed);

  await openPanel(page);
  await expect(view(page, id)).toContainText("long running build");
  expect(await uniqueIds(page)).toHaveLength(1);
});

test("a shell that will not start says why instead of looking idle", async ({ page }) => {
  await desktop(page, { failOpen: "InvalidWorkspace: Open a workspace first" });
  await openPanel(page);
  const [id] = await terminalIds(page);

  await expect(page.getByRole("status")).toContainText("Open a workspace first");
  await expect(view(page, id)).toContainText("Open a workspace first");
  // Nothing is sent to a shell that never started.
  await view(page, id).click();
  await page.keyboard.type("x");
  await expect.poll(async () => countCalls(page, "terminal_write")).toBe(0);
});

test("an exited shell reports its code and can be restarted", async ({ page }) => {
  await desktop(page);
  await openPanel(page);
  const [id] = await terminalIds(page);

  await exit(page, id, 130);
  await expect(view(page, id)).toContainText("exited with code 130");

  // Typing into a dead shell is not sent anywhere.
  await view(page, id).click();
  await page.keyboard.type("x");
  expect(await countCalls(page, "terminal_write")).toBe(0);

  const opens = await countCalls(page, "terminal_open");
  await page.getByRole("button", { name: "Restart", exact: true }).click();
  await expect.poll(async () => countCalls(page, "terminal_open")).toBe(opens + 1);
  // The restarted shell keeps the same identity, so its tab does not change.
  expect(await uniqueIds(page)).toEqual([id]);
});

test("a shell with integration shows where it is and how its last command ended", async ({
  page,
}) => {
  await desktop(page);
  await openPanel(page);
  await terminalIds(page);
  await page.getByLabel("Choose a shell").click();
  await page.getByRole("menuitem", { name: "Git Bash", exact: true }).click();
  const [, bash] = await terminalIds(page, 2);
  const status = page.getByRole("status").filter({ hasText: "Running" });
  await expect(status).toHaveText("Running");

  // Git Bash reports its MSYS folder; the status line shows the Windows path it names.
  await signal(page, bash, { signal: "cwd", uri: "file://BOX/c/Users/me/my project", local: true });
  await expect(page.getByTestId("terminal-folder")).toHaveText("C:/Users/me/my project");
  await signal(page, bash, { signal: "prompt" });
  await signal(page, bash, { signal: "input" });
  await signal(page, bash, { signal: "executing" });
  await expect(status).toContainText("Running a command");
  await signal(page, bash, { signal: "finished", exitCode: 1 });
  await expect(status).toContainText("Last command exited with 1");
  // A command's failure is not the terminal's: it still runs and takes input.
  await view(page, bash).click();
  await page.keyboard.type("x");
  await expect.poll(async () => countCalls(page, "terminal_write")).toBeGreaterThan(0);

  // A folder on another machine is never shown as a local one.
  await signal(page, bash, { signal: "cwd", uri: "file://build-server/home/ci", local: false });
  await expect(page.getByTestId("terminal-folder")).toHaveText("build-server (remote)");
});

test("shell integration is per terminal and starts again on restart", async ({ page }) => {
  await desktop(page);
  await openPanel(page);
  const [cmd] = await terminalIds(page);
  await page.getByLabel("Choose a shell").click();
  await page.getByRole("menuitem", { name: "Git Bash", exact: true }).click();
  const [, bash] = await terminalIds(page, 2);

  // The Command Prompt has no integration: the focused Git Bash's line is not its business.
  await signal(page, bash, { signal: "cwd", uri: "file:///c/work", local: true });
  await expect(page.getByTestId("terminal-folder")).toHaveText("C:/work");
  await page.getByRole("tab", { name: "Command Prompt", exact: true }).click();
  await expect(page.getByTestId("terminal-folder")).toHaveCount(0);
  // Signals of a terminal that is not shown change only that terminal.
  await signal(page, cmd, { signal: "invalid" });
  await expect(page.getByRole("status").filter({ hasText: "Running" })).toContainText(
    "unreadable sequences",
  );

  await page.getByRole("tab", { name: "Git Bash", exact: true }).click();
  await expect(page.getByTestId("terminal-folder")).toHaveText("C:/work");
  const before = (await calls(page, "terminal_open")).filter((c) => c.args.id === bash).length;
  await exit(page, bash, 0);
  await page.getByRole("button", { name: "Restart", exact: true }).click();
  await expect
    .poll(async () => (await calls(page, "terminal_open")).filter((c) => c.args.id === bash).length)
    .toBe(before + 1);
  // A new shell: nothing the old one reported is true of it.
  await expect(page.getByRole("status").filter({ hasText: "Running" })).toHaveText("Running");
  await expect(page.getByTestId("terminal-folder")).toHaveCount(0);
});

// --- IDE integration (TERMINAL-06) ------------------------------------------------------------

/** Runs a command from the palette, as a user would. */
async function palette(page: Page, command: string) {
  const search = page.getByRole("combobox", { name: "Search files or commands" });
  await expect(async () => {
    await page.keyboard.press("Control+Shift+P");
    await expect(search).toBeVisible({ timeout: 1000 });
  }).toPass();
  await search.fill(`>${command}`);
  return page.getByRole("option").filter({ hasText: command }).first();
}

test("the Explorer's root opens a terminal in the workspace root", async ({ page }) => {
  await desktop(page);
  // The tree's background is the workspace root's.
  await page
    .getByRole("tree", { name: "Files" })
    .click({ button: "right", position: { x: 40, y: 120 } });
  await page.getByRole("menuitem", { name: "Open in Integrated Terminal" }).click();
  await expect
    .poll(async () => (await calls(page, "terminal_open")).map((call) => call.args.cwd))
    .toContain("/work");
});

test("Open Integrated Terminal Here starts in the folder of the file in the editor", async ({
  page,
}) => {
  await desktop(page);
  // Nothing in the editor: offered, but not available.
  await expect(await palette(page, "Open Integrated Terminal Here")).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  await page.keyboard.press("Escape");
  await page.getByText("file.ts", { exact: true }).dblclick();
  await expect(page.getByRole("tab", { name: /file\.ts/ })).toBeVisible();
  await (await palette(page, "Open Integrated Terminal Here")).click();
  await expect
    .poll(async () => (await calls(page, "terminal_open")).map((call) => call.args.cwd))
    .toContain("/work");
});

test("an untitled document opens its terminal in the workspace root", async ({ page }) => {
  await desktop(page);
  await (await palette(page, "New Text File")).click();
  await (await palette(page, "Open Integrated Terminal Here")).click();
  await expect
    .poll(async () => (await calls(page, "terminal_open")).map((call) => call.args.cwd))
    .toContain("/work");
});

test("Reveal Current Folder shows the folder the shell reported, and only a local one", async ({
  page,
}) => {
  await desktop(page, { unixShell: true });
  await openPanel(page);
  const [id] = await terminalIds(page);
  // It has not said where it is: nothing is guessed.
  await terminalMenu(page, "Reveal Current Folder in Explorer");
  await expect(page.getByRole("alert")).toContainText("does not report its folder");

  await signal(page, id, { signal: "cwd", uri: "file://far/home/ci", local: false });
  await terminalMenu(page, "Reveal Current Folder in Explorer");
  await expect(page.getByRole("alert")).toContainText("on another machine (far)");

  await signal(page, id, { signal: "cwd", uri: "file:///work/src", local: true });
  await expect(page.getByTestId("terminal-folder")).toHaveText("/work/src");
  await terminalMenu(page, "Reveal Current Folder in Explorer");
  await expect(page.getByRole("treeitem", { name: "src" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
});

test("terminal commands are in the palette, enabled only when they have a terminal", async ({
  page,
}) => {
  await desktop(page);
  // No terminal yet.
  for (const command of ["Kill Terminal", "Restart Terminal", "Rename Terminal…"]) {
    await expect(await palette(page, command)).toHaveAttribute("aria-disabled", "true");
    await page.keyboard.press("Escape");
  }
  await openPanel(page);
  const [id] = await terminalIds(page);
  await expect(await palette(page, "Restart Terminal")).not.toHaveAttribute(
    "aria-disabled",
    "true",
  );
  await page.keyboard.press("Escape");
  // Working in the Explorer, with the terminal still shown.
  await page.getByText("file.ts", { exact: true }).click();
  // Shown but not typed into: the commands that need the keyboard's terminal are not offered.
  await expect(await palette(page, "Paste into Terminal")).toHaveAttribute("aria-disabled", "true");
  await page.keyboard.press("Escape");

  // In the terminal, the palette's own key reaches the IDE, not the shell.
  await view(page, id).click();
  const writes = await countCalls(page, "terminal_write");
  const option = await palette(page, "Select All in Terminal");
  expect(await countCalls(page, "terminal_write")).toBe(writes);
  await expect(option).not.toHaveAttribute("aria-disabled", "true");
  await option.click();

  // Kill ends the shell and its children now; Close would end it gently.
  await (await palette(page, "Kill Terminal")).click();
  await expect.poll(async () => countCalls(page, "terminal_kill")).toBe(1);
  expect(await countCalls(page, "terminal_close")).toBe(0);
});

test("Ctrl+` in a terminal hides the panel instead of reaching the shell", async ({ page }) => {
  await desktop(page);
  await openPanel(page);
  const [id] = await terminalIds(page);
  await view(page, id).click();
  const writes = await countCalls(page, "terminal_write");
  await page.keyboard.press("Control+Backquote");
  await expect(view(page, id)).toBeHidden();
  expect(await countCalls(page, "terminal_write")).toBe(writes);
});

test("Focus Terminal gives the terminal the keyboard, from anywhere", async ({ page }) => {
  await desktop(page);
  await (await palette(page, "Focus Terminal")).click();
  const [id] = await terminalIds(page);
  await expect(view(page, id).locator("textarea")).toBeFocused();
  // Typing now reaches the shell.
  await page.keyboard.type("x");
  await expect.poll(async () => countCalls(page, "terminal_write")).toBeGreaterThan(0);
});

test("a file path printed in a terminal opens in the editor on a click, at its line", async ({
  page,
}) => {
  await desktop(page, { unixShell: true });
  await openPanel(page);
  const [id] = await terminalIds(page);
  await output(page, id, "/work/file.ts:12 and /etc/passwd.txt\r\n");
  const screen = view(page, id).locator(".xterm-screen");
  await expect(view(page, id)).toContainText("/work/file.ts:12");
  const box = (await screen.boundingBox())!;
  const rows = await view(page, id).locator(".xterm-rows > div").count();
  const cell = { width: 0, height: box.height / rows };
  // xterm measures a run of characters; one cell is that width over their number.
  cell.width = await view(page, id).evaluate((element) => {
    const measure = element.querySelector(".xterm-char-measure-element") as HTMLElement;
    return measure.getBoundingClientRect().width / (measure.textContent?.length || 1);
  });
  const at = (column: number) => ({
    x: box.x + cell.width * (column + 0.5),
    y: box.y + cell.height * 0.5,
  });
  // Hovering only offers it; nothing opens.
  await page.mouse.move(at(3).x, at(3).y);
  await expect(page.getByRole("tab", { name: /file\.ts/ })).toHaveCount(0);
  await page.mouse.click(at(3).x, at(3).y);
  await expect(page.getByRole("tab", { name: /file\.ts/ })).toBeVisible();
  await expect(page.getByText(/Ln 12, Col 1/)).toBeVisible();
  // Outside the workspace: not a link, so a click opens nothing.
  const tabs = await page.getByRole("tab").count();
  await page.mouse.click(at(24).x, at(24).y);
  await page.waitForTimeout(300);
  expect(await page.getByRole("tab").count()).toBe(tabs);
  expect((await calls(page, "read_file_content")).map((c) => c.args.path)).not.toContain(
    "/etc/passwd.txt",
  );
});

test("a command finishing in a terminal asks Git to refresh; its output does not", async ({
  page,
}) => {
  await desktop(page, { unixShell: true });
  await openPanel(page);
  const [id] = await terminalIds(page);
  await signal(page, id, { signal: "prompt" });
  // Let Git settle after opening, then count what it is asked.
  await page.waitForTimeout(1500);
  const before = await countCalls(page, "git_exec");
  for (let i = 0; i < 20; i++)
    await output(
      page,
      id,
      `building ${i}
`,
    );
  await page.waitForTimeout(1000);
  expect(await countCalls(page, "git_exec")).toBe(before);
  await signal(page, id, { signal: "executing" });
  await signal(page, id, { signal: "finished", exitCode: 1 });
  // Git's own refresh, through its own commands; the terminal changes nothing in Git.
  await expect.poll(async () => countCalls(page, "git_exec")).toBeGreaterThan(before);
});

test("after a switch, terminal commands act on the new workspace's terminals only", async ({
  page,
}) => {
  await desktop(page);
  await openPanel(page);
  const [a] = await terminalIds(page);
  await openFolder(page, "/other");
  await expect(view(page, a)).toHaveCount(0);
  // B's panel has its own terminal; Kill Terminal ends that one, never A's.
  const [, b] = await terminalIds(page, 2);
  await expect(view(page, b)).toBeVisible();
  await (await palette(page, "Kill Terminal")).click();
  await expect
    .poll(async () => (await calls(page, "terminal_kill")).map((call) => call.args.id))
    .toEqual([b]);
  await openFolder(page, "/work");
  await expect(view(page, a)).toBeVisible();
  expect(await countCalls(page, "terminal_close")).toBe(0);
});

test("the end of a shell that was replaced is never taken for the one replacing it", async ({
  page,
}) => {
  // What showed "[The shell exited with code 1.]" twice under a live prompt: React mounts the
  // view twice in development, and the first launch's close -- a killed cmd.exe exits 1 --
  // arrived under the same terminal id as the second launch.
  await desktop(page);
  await openPanel(page);
  const [id] = await terminalIds(page);
  const launches = async () =>
    (await calls(page, "terminal_open"))
      .filter((call) => call.args.id === id)
      .map((call) => call.args.generation as number);
  await expect.poll(async () => (await launches()).length).toBeGreaterThan(0);
  const first = (await launches()).at(-1)!;

  // Restarted: a new launch of the same terminal.
  await exit(page, id, 130, first);
  await expect(view(page, id)).toContainText("exited with code 130");
  await page.getByRole("button", { name: "Restart", exact: true }).click();
  await expect.poll(async () => (await launches()).at(-1)).toBeGreaterThan(first);
  const second = (await launches()).at(-1)!;

  // The old shell's late output and exit are ignored; the new one's are shown.
  await output(page, id, "from the old shell", first);
  await exit(page, id, 1, first);
  await output(page, id, "from the new shell", second);
  await expect(view(page, id)).toContainText("from the new shell");
  await expect(view(page, id)).not.toContainText("from the old shell");
  await expect(view(page, id)).not.toContainText("exited with code 1.");
  await expect(page.getByRole("button", { name: "Restart", exact: true })).toHaveCount(0);

  // Every close names the launch it is for, so a late one cannot end its successor.
  for (const close of await calls(page, "terminal_close"))
    expect(typeof close.args.generation).toBe("number");
});

test("a shell that ends cleanly is not reported as a failure", async ({ page }) => {
  await desktop(page);
  await openPanel(page);
  const [id] = await terminalIds(page);

  await exit(page, id, 0);
  await expect(view(page, id)).toContainText("The shell exited.");
  await expect(view(page, id)).not.toContainText("code");
});

test("find locates output and reports when there is no match", async ({ page }) => {
  await desktop(page);
  await openPanel(page);
  const [id] = await terminalIds(page);
  // Wait for the shell to be attached so the search runs against a settled terminal.
  await expect(page.getByRole("status")).toContainText("Running");
  await output(page, id, "compiling widget.rs\r\n");

  // xterm writes asynchronously; search only sees what has reached its buffer.
  await expect(view(page, id)).toContainText("widget.rs");

  await page.getByLabel("Find in Terminal", { exact: true }).click();
  const bar = page.getByRole("search", { name: "Terminal search" });
  const box = bar.getByLabel("Find in terminal", { exact: true });
  await box.fill("widget");
  await expect(bar.getByRole("status")).toContainText("1 of 1");

  await box.fill("nothing-here");
  await expect(bar.getByRole("status")).toContainText("No results");

  await box.press("Escape");
  await expect(box).toBeHidden();
});

test("find counts every match and can be made case sensitive", async ({ page }) => {
  await desktop(page);
  await openPanel(page);
  const [id] = await terminalIds(page);
  await output(page, id, "Widget widget WIDGET\r\n");
  await expect(view(page, id)).toContainText("WIDGET");

  await page.getByLabel("Find in Terminal", { exact: true }).click();
  const bar = page.getByRole("search", { name: "Terminal search" });
  await bar.getByLabel("Find in terminal", { exact: true }).fill("widget");
  await expect(bar.getByRole("status")).toContainText("of 3");

  // Matching case narrows it to the one spelled exactly that way.
  await bar.getByLabel("Match case").click();
  await expect(bar.getByRole("status")).toContainText("of 1");
});

test("right clicking offers the terminal actions, with copy disabled until there is a selection", async ({
  page,
}) => {
  await desktop(page);
  await openPanel(page);
  const [id] = await terminalIds(page);
  await output(page, id, "some output to clear\r\n");
  await expect(view(page, id)).toContainText("some output");

  await view(page, id).click({ button: "right" });
  const menu = page.getByRole("menu", { name: "Terminal actions" });
  await expect(menu).toBeVisible();
  // Nothing is selected, so there is nothing to copy.
  await expect(menu.getByRole("menuitem", { name: "Copy", exact: true })).toBeDisabled();
  await expect(menu.getByRole("menuitem", { name: "Paste", exact: true })).toBeEnabled();

  await menu.getByRole("menuitem", { name: "Clear", exact: true }).click();
  await expect(menu).toBeHidden();
  await expect(view(page, id)).not.toContainText("some output");
});

test("a terminal can be renamed and keeps the name", async ({ page }) => {
  await desktop(page);
  await openPanel(page);
  await terminalIds(page);

  await page.getByRole("tab", { name: "Command Prompt", exact: true }).dblclick();
  const box = page.getByLabel("Rename terminal");
  await box.fill("build watch");
  await box.press("Enter");

  await expect(page.getByRole("tab", { name: "build watch", exact: true })).toBeVisible();
  // A second terminal is numbered from its shell, not from the renamed one.
  await page.getByLabel("New Terminal").click();
  await expect(page.getByRole("tab", { name: "Command Prompt", exact: true })).toBeVisible();
});

test("the font size zooms with the keyboard and resets", async ({ page }) => {
  await desktop(page);
  await openPanel(page);
  const [id] = await terminalIds(page);
  const size = () =>
    page.evaluate(
      (label) =>
        parseFloat(
          getComputedStyle(document.querySelector(`[aria-label="${label}"] .xterm-rows`) as Element)
            .fontSize,
        ),
      `Terminal ${id}`,
    );

  const original = await size();
  await view(page, id).click();
  await page.keyboard.press("Control+=");
  await expect.poll(size).toBeGreaterThan(original);

  await page.keyboard.press("Control+0");
  await expect.poll(size).toBe(original);
});

test("a terminal that rings while hidden is marked", async ({ page }) => {
  await desktop(page);
  await openPanel(page);
  const [first] = await terminalIds(page);
  await page.getByLabel("New Terminal").click();
  await terminalIds(page, 2);

  // The first terminal is no longer on screen when it rings.
  await output(page, first, "\u0007");
  const tab = page.getByRole("tab", { name: "Command Prompt", exact: true }).locator("..");
  await expect(tab.getByTitle("This terminal rang")).toBeVisible();

  // Looking at it clears the mark.
  await page.getByRole("tab", { name: "Command Prompt", exact: true }).click();
  await expect(tab.getByTitle("This terminal rang")).toHaveCount(0);
});

test("the panel and the split can be resized", async ({ page }) => {
  await desktop(page);
  await openPanel(page);
  await terminalIds(page);

  const panel = page.getByRole("separator", { name: "Resize panel" });
  await expect(panel).toBeVisible();
  const before = (await page.getByLabel("Terminal actions").count()) === 0;
  expect(before).toBe(true);

  await page.getByLabel("Split Terminal").click();
  await terminalIds(page, 2);
  await expect(page.getByRole("separator", { name: "Resize split" })).toBeVisible();
});

test("the terminal menu drives the panel", async ({ page }) => {
  await desktop(page);
  await openPanel(page);
  await terminalIds(page);

  await terminalMenu(page, "New Terminal");
  await terminalIds(page, 2);

  await terminalMenu(page, "Find in Terminal");
  await expect(page.getByLabel("Find in terminal", { exact: true })).toBeVisible();
});

test("New Terminal from the menu opens the panel when it is hidden", async ({ page }) => {
  await desktop(page);
  await terminalMenu(page, "New Terminal");

  await expect(page.getByLabel("New Terminal")).toBeVisible();
  await terminalIds(page);
});

test("the panel is not built until a terminal is first opened", async ({ page }) => {
  await desktop(page);
  // Nothing terminal-related runs on startup.
  expect(await countCalls(page, "terminal_shells")).toBe(0);

  await openPanel(page);
  await expect.poll(async () => countCalls(page, "terminal_shells")).toBeGreaterThan(0);
});

test("copy and paste use the terminal conventions", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await desktop(page);
  await openPanel(page);
  const [id] = await terminalIds(page);

  await page.evaluate(() => navigator.clipboard.writeText("pasted text"));
  await view(page, id).click();
  await page.keyboard.press("Control+Shift+V");
  await expect
    .poll(async () => (await calls(page, "terminal_write")).map((c) => c.args.data).join(""))
    .toBe("pasted text");

  // Ctrl+C with no selection must reach the shell so a program can be interrupted.
  await page.keyboard.press("Control+c");
  await expect
    .poll(async () => (await calls(page, "terminal_write")).map((c) => c.args.data).join(""))
    .toBe("pasted text\x03");
});

test("the browser preview says a shell needs the desktop application", async ({ page }) => {
  // No Tauri at all, which is what a browser gets.
  await page.goto("/");
  await openPanel(page);

  await expect(page.getByText("Open the desktop application to run a shell.")).toBeVisible();
  // Controls that cannot work are disabled rather than failing when pressed.
  await expect(page.getByLabel("New Terminal")).toBeDisabled();
  await expect(page.getByLabel("Split Terminal")).toBeDisabled();
});

test("the panel offers the five views, with Terminal showing by default", async ({ page }) => {
  await desktop(page);
  await openPanel(page);

  const tabs = page.getByRole("tablist", { name: "Panel views" });
  await expect(tabs.getByRole("tab")).toHaveText([
    "PROBLEMS",
    "OUTPUT",
    "DEBUG CONSOLE",
    "TERMINAL",
    "PORTS",
  ]);
  await expect(tabs.getByRole("tab", { name: "TERMINAL" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
});

test("each view says what it will hold rather than claiming a broken connection", async ({
  page,
}) => {
  await desktop(page);
  await openPanel(page);
  const tabs = page.getByRole("tablist", { name: "Panel views" });

  for (const [tab, region] of [
    ["PROBLEMS", "Problems"],
    ["OUTPUT", "Output"],
    ["DEBUG CONSOLE", "Debug Console"],
    ["PORTS", "Ports"],
  ] as const) {
    await tabs.getByRole("tab", { name: tab }).click();
    await expect(page.getByRole("region", { name: region })).toBeVisible();
  }
});

test("switching away from the terminal and back keeps the same shell running", async ({ page }) => {
  // The terminal is hidden rather than unmounted when another view shows; unmounting would
  // kill the user's running processes.
  await desktop(page);
  await openPanel(page);
  const [id] = await terminalIds(page);
  await output(page, id, "before switching\r\n");
  await expect(view(page, id)).toContainText("before switching");

  const tabs = page.getByRole("tablist", { name: "Panel views" });
  await tabs.getByRole("tab", { name: "PORTS" }).click();
  await expect(page.getByRole("region", { name: "Ports" })).toBeVisible();
  await tabs.getByRole("tab", { name: "TERMINAL" }).click();

  // Same session, same scrollback: no new terminal_open, and the earlier output survives.
  expect(await terminalIds(page)).toEqual([id]);
  await expect(view(page, id)).toContainText("before switching");
});

test("the chosen view is remembered across a reload", async ({ page }) => {
  await desktop(page);
  await openPanel(page);
  await page
    .getByRole("tablist", { name: "Panel views" })
    .getByRole("tab", { name: "PORTS" })
    .click();

  await page.reload();
  await openPanel(page);
  await expect(
    page.getByRole("tablist", { name: "Panel views" }).getByRole("tab", { name: "PORTS" }),
  ).toHaveAttribute("aria-selected", "true");
});

test("arrow keys move between panel views", async ({ page }) => {
  await desktop(page);
  await openPanel(page);
  const tabs = page.getByRole("tablist", { name: "Panel views" });

  await tabs.getByRole("tab", { name: "TERMINAL" }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(tabs.getByRole("tab", { name: "PORTS" })).toHaveAttribute("aria-selected", "true");
  // Wraps rather than dead-ending at the last view.
  await tabs.getByRole("tab", { name: "PORTS" }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(tabs.getByRole("tab", { name: "PROBLEMS" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
});

test("Ctrl+PageDown and Ctrl+PageUp move between terminals", async ({ page }) => {
  await desktop(page);
  await openPanel(page);
  await terminalIds(page);
  await page.getByLabel("New Terminal").click();
  const [first, second] = await terminalIds(page, 2);
  await view(page, second).click();

  await page.keyboard.press("Control+PageUp");
  await expect(view(page, first)).toBeVisible();
  await expect(page.getByRole("tab", { name: "Command Prompt", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );

  await view(page, first).click();
  await page.keyboard.press("Control+PageDown");
  await expect(view(page, second)).toBeVisible();
});

test("Shift+PageUp scrolls the buffer instead of reaching the shell", async ({ page }) => {
  await desktop(page);
  await openPanel(page);
  const [id] = await terminalIds(page);
  await view(page, id).click();
  const before = await countCalls(page, "terminal_write");

  await page.keyboard.press("Shift+PageUp");
  await page.keyboard.press("Control+Home");
  await page.keyboard.press("Control+End");

  // Scrolling is local to the buffer: none of it is sent to the shell.
  expect(await countCalls(page, "terminal_write")).toBe(before);
});

test("a plain arrow key still reaches the shell", async ({ page }) => {
  // Alt+Arrow moves between split panes, so the unmodified arrows must stay untouched or
  // shell history and line editing would stop working.
  await desktop(page);
  await openPanel(page);
  const [id] = await terminalIds(page);
  await view(page, id).click();

  await page.keyboard.press("ArrowUp");
  await expect
    .poll(async () => (await calls(page, "terminal_write")).map((c) => c.args.data).join(""))
    .toBe("\x1b[A");
});

test("a shell that finishes starting after its terminal was closed is ended, not orphaned", async ({
  page,
}) => {
  await desktop(page);
  await openPanel(page);
  await terminalIds(page);
  await page.evaluate(() => {
    (window as unknown as { __openDelay?: number }).__openDelay = 400;
  });
  await page.getByLabel("New Terminal").click();
  const ids = await terminalIds(page, 2);
  // Closed while its shell is still starting.
  await view(page, ids[1]).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Kill All Terminals" }).click();

  // Every launch of it that finished starting was closed afterwards, by its generation.
  const order = () =>
    page.evaluate(
      (id) =>
        (
          window as unknown as {
            __calls: { command: string; args: { id?: string; generation?: number } }[];
          }
        ).__calls
          .filter((call) => call.args?.id === id)
          .map((call) => `${call.command}:${call.args.generation}`),
      ids[1],
    );
  await expect
    .poll(async () => {
      const seen = await order();
      const started = seen.filter((one) => one.startsWith("terminal_open:done:"));
      return (
        started.length > 0 &&
        started.every((done) => {
          const generation = done.split(":").pop();
          const after = seen.slice(seen.indexOf(done) + 1);
          return (
            after.includes(`terminal_close:${generation}`) ||
            after.includes(`terminal_kill:${generation}`)
          );
        })
      );
    })
    .toBe(true);
});

test("a page closes the shells an earlier page left running before it opens its first", async ({
  page,
}) => {
  await desktop(page);
  await openPanel(page);
  await terminalIds(page);
  const order = await page.evaluate(() =>
    (window as unknown as { __calls: { command: string }[] }).__calls
      .map((call) => call.command)
      .filter((command) => command === "terminal_close_all" || command === "terminal_open"),
  );
  // Closed first; the workspace's own disposal (when the folder opens) may close them too.
  expect(order[0]).toBe("terminal_close_all");
  expect(order).toContain("terminal_open");
});

test("Kill All Terminals closes every terminal at once", async ({ page }) => {
  await desktop(page);
  await openPanel(page);
  await terminalIds(page);
  await page.getByLabel("New Terminal").click();
  const ids = await terminalIds(page, 2);

  // The second terminal is the visible one after creating it.
  await view(page, ids[1]).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Kill All Terminals" }).click();

  await expect(page.getByRole("region", { name: "No terminals" })).toBeVisible();
  // Every shell is closed natively, not just removed from the UI. Containment rather than
  // equality: React's development StrictMode mounts and unmounts each view once before the
  // real mount, which legitimately closes the same id earlier too.
  await expect
    .poll(async () => {
      const closed = new Set((await calls(page, "terminal_close")).map((c) => c.args.id));
      return ids.every((id) => closed.has(id));
    })
    .toBe(true);
});

test("output reaches only the terminal it belongs to, on its own channel", async ({ page }) => {
  // Each launch is opened with a channel of its own; nothing listens to a broadcast.
  await desktop(page);
  await openPanel(page);
  await terminalIds(page);
  await page.getByLabel("New Terminal").click();
  const [first, second] = await terminalIds(page, 2);

  await output(page, second, "only for the second");
  await expect(view(page, second)).toContainText("only for the second");
  await expect(view(page, first)).not.toContainText("only for the second");

  const terminalListens = (await calls(page, "plugin:event|listen")).filter((call) =>
    String(call.args.event).startsWith("terminal-"),
  );
  expect(terminalListens).toEqual([]);
  // Every launch names the subscription its channel belongs to, and no two share one.
  const subscriptions = (await calls(page, "terminal_open")).map((c) => c.args.subscriptionId);
  expect(subscriptions.every((id) => typeof id === "string")).toBe(true);
  expect(new Set(subscriptions).size).toBe(subscriptions.length);
});

test("output is acknowledged once the terminal has taken it in", async ({ page }) => {
  // The acknowledgement is what lets the native side send more: it comes from the view, after
  // xterm has parsed the bytes, naming the launch and the chunk.
  await desktop(page);
  await openPanel(page);
  const [id] = await terminalIds(page);
  await output(page, id, "first\r\n");
  await output(page, id, "second\r\n");
  await expect(view(page, id)).toContainText("second");
  await expect
    .poll(async () => (await calls(page, "terminal_ack")).map((c) => c.args.seq))
    .toEqual([0, 1]);
  const [ack] = await calls(page, "terminal_ack");
  const [open] = (await calls(page, "terminal_open")).slice(-1);
  const views = await calls(page, "terminal_subscribe");
  expect(ack.args.sessionId).toBe(id);
  expect(ack.args.generation).toBe(open.args.generation);
  // The view's own subscription, not the service's lifecycle one.
  expect(views.map((v) => v.args.subscriptionId)).toContain(ack.args.subscriptionId);
  expect(ack.args.subscriptionId).not.toBe(open.args.subscriptionId);
});

test("Open in Integrated Terminal starts a shell in the chosen folder", async ({ page }) => {
  await desktop(page);
  // The explorer's own context menu; the panel need not be open beforehand.
  await page.getByText("file.ts", { exact: true }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Open in Integrated Terminal" }).click();

  await expect.poll(async () => (await calls(page, "terminal_open")).length).toBeGreaterThan(0);
  const opened = await calls(page, "terminal_open");
  // A file opens a terminal in the folder holding it, not in the file.
  expect(opened.some((call) => call.args.cwd === "/work")).toBe(true);
});

test("Show Git Output opens the Output view with the Git channel", async ({ page }) => {
  // VS Code shows this in the Output view rather than a second Git-only log view.
  await desktop(page);
  await page.getByTitle("Source Control (Ctrl+Shift+G)").click();
  await page
    .getByRole("complementary", { name: "Source control" })
    .getByLabel("Changes actions")
    .click();
  await page.getByRole("menuitem", { name: "Show Git Output" }).click();

  const output = page.getByRole("region", { name: "Output" });
  await expect(output).toBeVisible();
  await expect(output.getByLabel("Output channel")).toHaveValue("git");
  // Real content: the Git commands the panel already ran on startup.
  await expect(output.getByRole("listitem").first()).toContainText("git");
});

test("the Output view filters by level, so ordinary output can be hidden", async ({ page }) => {
  // Every mocked Git command succeeds here, so every line is info: raising the minimum level
  // to error must empty the view, and lowering it must bring the lines back.
  await desktop(page);
  await page.getByTitle("Source Control (Ctrl+Shift+G)").click();
  await page
    .getByRole("complementary", { name: "Source control" })
    .getByLabel("Changes actions")
    .click();
  await page.getByRole("menuitem", { name: "Show Git Output" }).click();

  const output = page.getByRole("region", { name: "Output" });
  await expect(output.getByRole("listitem").first()).toBeVisible();

  await output.getByLabel("Minimum log level").selectOption("error");
  await expect(output.getByText("Nothing at this level.")).toBeVisible();

  await output.getByLabel("Minimum log level").selectOption("info");
  await expect(output.getByRole("listitem").first()).toBeVisible();
});

test("a failed Git command is recorded at error level, so it survives the filter", async ({
  page,
}) => {
  await desktop(page, { failGit: "fatal: could not read from remote" });
  await page.getByTitle("Source Control (Ctrl+Shift+G)").click();
  await page
    .getByRole("complementary", { name: "Source control" })
    .getByLabel("Changes actions")
    .click();
  await page.getByRole("menuitem", { name: "Show Git Output" }).click();

  const output = page.getByRole("region", { name: "Output" });
  await output.getByLabel("Minimum log level").selectOption("error");
  await expect(output.getByRole("listitem").first()).toBeVisible();
  await expect(output.getByText(/could not read from remote/).first()).toBeVisible();
});

test("clearing one output channel does not touch another", async ({ page }) => {
  await desktop(page);
  await page.getByTitle("Source Control (Ctrl+Shift+G)").click();
  await page
    .getByRole("complementary", { name: "Source control" })
    .getByLabel("Changes actions")
    .click();
  await page.getByRole("menuitem", { name: "Show Git Output" }).click();

  const output = page.getByRole("region", { name: "Output" });
  await expect(output.getByRole("listitem").first()).toBeVisible();
  await output.getByRole("button", { name: "Clear" }).click();
  await expect(output.getByText("This channel has produced no output yet.")).toBeVisible();
});

/** Selects a panel view by its tab label. */
async function showView(page: Page, label: string) {
  await openPanel(page);
  await page
    .getByRole("tablist", { name: "Panel views" })
    .getByRole("tab", { name: label })
    .click();
}

test("Ports lists what is listening, with the process holding each one", async ({ page }) => {
  await desktop(page, {
    ports: [
      { port: 5173, address: "127.0.0.1", pid: 23188, process: "node.exe" },
      { port: 8080, address: "0.0.0.0", pid: 9012, process: "" },
    ],
  });
  await showView(page, "PORTS");

  const ports = page.getByRole("region", { name: "Ports" });
  await expect(ports.getByRole("row")).toHaveCount(3); // header plus two services
  await expect(ports.getByRole("cell", { name: "5173", exact: true })).toBeVisible();
  await expect(ports.getByText("http://localhost:5173")).toBeVisible();
  await expect(ports.getByText("node.exe")).toBeVisible();
  // A port whose owner could not be named still lists, rather than being hidden.
  await expect(ports.getByText("Unknown")).toBeVisible();
});

test("Ports says what it is for when nothing is listening", async ({ page }) => {
  await desktop(page, { ports: [] });
  await showView(page, "PORTS");
  await expect(page.getByRole("region", { name: "Ports" })).toContainText("Start a dev server");
});

test("a port opens over http on loopback, which is how a dev server is served", async ({
  page,
}) => {
  await desktop(page, { ports: [{ port: 5173, address: "127.0.0.1", pid: 1, process: "node" }] });
  await showView(page, "PORTS");

  await page.getByRole("button", { name: "Open port 5173 in your browser" }).click();
  await expect
    .poll(async () => (await calls(page, "open_external_url")).map((c) => c.args.url))
    .toContain("http://localhost:5173");
});

test("stopping a process asks first and names what it will end", async ({ page }) => {
  await desktop(page, { ports: [{ port: 5173, address: "127.0.0.1", pid: 1, process: "node" }] });
  await showView(page, "PORTS");

  let asked = "";
  page.on("dialog", (dialog) => {
    asked = dialog.message();
    void dialog.dismiss();
  });
  await page.getByRole("button", { name: "Stop the process on port 5173" }).click();
  expect(asked).toContain("node");
  expect(asked).toContain("5173");
  // Dismissed, so nothing was stopped.
  expect(await countCalls(page, "stop_listening_process")).toBe(0);
});

test("confirming the stop ends the process holding that port", async ({ page }) => {
  await desktop(page, { ports: [{ port: 5173, address: "127.0.0.1", pid: 1, process: "node" }] });
  await showView(page, "PORTS");

  page.on("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: "Stop the process on port 5173" }).click();
  await expect
    .poll(async () => (await calls(page, "stop_listening_process")).map((c) => c.args.port))
    .toContain(5173);
});

const TSC_OUTPUT = [
  "src/app.ts(12,7): error TS2345: Argument of type 'string' is not assignable.",
  "src/app.ts(20,1): warning TS6133: 'unused' is declared but never read.",
  "src/other.ts(3,2): error TS1005: ';' expected.",
  "Found 3 errors.",
].join("\n");

test("Problems explains how diagnostics are collected when no checker applies", async ({
  page,
}) => {
  await desktop(page, { checkers: [] });
  await showView(page, "PROBLEMS");
  await expect(page.getByRole("region", { name: "Problems" })).toContainText(
    "a whole-project check needs a checker, and none applies here",
  );
});

test("running a checker lists its diagnostics grouped by file", async ({ page }) => {
  await desktop(page, {
    checkers: [{ id: "tsc", label: "TypeScript" }],
    checkerOutput: TSC_OUTPUT,
  });
  await showView(page, "PROBLEMS");

  const problems = page.getByRole("region", { name: "Problems" });
  await problems.getByRole("button", { name: "TypeScript", exact: true }).click();

  await expect(problems.getByRole("button", { name: /src\/app\.ts/ })).toBeVisible();
  await expect(problems.getByRole("button", { name: /src\/other\.ts/ })).toBeVisible();
  await expect(problems.getByText(/not assignable/)).toBeVisible();
  await expect(problems.getByText(/Ln 12, Col 7/)).toBeVisible();
});

test("a checker that answers after another folder was opened reports nothing into it", async ({
  page,
}) => {
  await desktop(page, {
    checkers: [{ id: "tsc", label: "TypeScript" }],
    checkerOutput: TSC_OUTPUT,
  });
  await showView(page, "PROBLEMS");
  let problems = page.getByRole("region", { name: "Problems" });
  await page.evaluate(() => {
    const scenario = window as unknown as { __checkerDelay?: number; __openFolder?: string };
    scenario.__checkerDelay = 800;
    scenario.__openFolder = "/other";
  });
  await problems.getByRole("button", { name: "TypeScript", exact: true }).click();

  // Another folder, while the check of the first is still running.
  await page.getByRole("menubar").getByRole("menuitem", { name: "File", exact: true }).click();
  await page
    .getByRole("menu", { name: "File", exact: true })
    .getByRole("menuitem", { name: "Open Folder…", exact: true })
    .click();
  await expect.poll(async () => countCalls(page, "cancel_checker")).toBeGreaterThan(0);
  await page.waitForTimeout(1200);
  // The panel is still shown (it is the new workspace's now): straight to its Problems.
  await page
    .getByRole("tablist", { name: "Panel views" })
    .getByRole("tab", { name: "PROBLEMS" })
    .click();
  problems = page.getByRole("region", { name: "Problems" });
  await expect(problems.getByText(/not assignable/)).toHaveCount(0);

  // The store itself still works: a check of this folder shows what it finds.
  await page.evaluate(() => {
    (window as unknown as { __checkerDelay?: number }).__checkerDelay = 0;
  });
  await problems.getByRole("button", { name: "TypeScript", exact: true }).click();
  await expect(problems.getByText(/not assignable/).first()).toBeVisible();
});

test("a problem opens its file at its line, even while another file is shown", async ({ page }) => {
  await desktop(page, {
    checkers: [{ id: "tsc", label: "TypeScript" }],
    checkerOutput: TSC_OUTPUT,
  });
  await page.getByRole("treeitem", { name: "file.ts" }).click();
  await expect(page.getByRole("textbox", { name: "file.ts", exact: true })).toBeFocused();
  await showView(page, "PROBLEMS");
  const problems = page.getByRole("region", { name: "Problems" });
  await problems.getByRole("button", { name: "TypeScript", exact: true }).click();
  await problems.getByText(/not assignable/).click();

  // The jump lands in the problem's file, not in the one that was shown before it opened --
  // at its line and its column (12, 7), through the editor's own navigation.
  await expect.poll(() => withEditor<string>(page, "(editor) => editor.label()")).toBe("app.ts");
  const lineStart = Array.from({ length: 11 }, (_, i) => `line ${i + 1}\n`).join("").length;
  await expect.poll(async () => (await editorSelections(page))?.[0]?.start).toBe(lineStart + 6);
});

test("a checker that could not run says so instead of reporting a clean project", async ({
  page,
}) => {
  // `npx --no-install tsc` in a project with no local TypeScript exits 1 and explains itself
  // on stderr. Nothing in that text is a diagnostic, so the view had nothing to show and said
  // "No problems found" -- the most misleading thing it could say.
  await desktop(page, {
    checkers: [{ id: "tsc", label: "TypeScript" }],
    checkerOutput: "npm error could not determine executable to run",
    checkerCode: 1,
  });
  await showView(page, "PROBLEMS");
  await page
    .getByRole("region", { name: "Problems" })
    .getByRole("button", { name: "TypeScript", exact: true })
    .click();

  await expect(appAlert(page)).toContainText("could not determine executable");
  await expect(page.getByRole("region", { name: "Problems" })).not.toContainText(
    "No problems found",
  );
});

test("a checker that exits nonzero because it found problems still lists them", async ({
  page,
}) => {
  // The other half of the rule: a nonzero exit is a checker's normal way of reporting work.
  await desktop(page, {
    checkers: [{ id: "tsc", label: "TypeScript" }],
    checkerOutput: "src/a.ts(3,10): error TS2304: Cannot find name 'x'.",
    checkerCode: 2,
  });
  await showView(page, "PROBLEMS");
  await page
    .getByRole("region", { name: "Problems" })
    .getByRole("button", { name: "TypeScript", exact: true })
    .click();

  await expect(page.getByRole("region", { name: "Problems" })).toContainText("Cannot find name");
  await expect(appAlert(page)).toHaveCount(0);
});

test("the Problems tab is badged with the error and warning count", async ({ page }) => {
  await desktop(page, {
    checkers: [{ id: "tsc", label: "TypeScript" }],
    checkerOutput: TSC_OUTPUT,
  });
  await showView(page, "PROBLEMS");
  await page
    .getByRole("region", { name: "Problems" })
    .getByRole("button", { name: "TypeScript", exact: true })
    .click();

  // Two errors and one warning.
  await expect(page.getByRole("tab", { name: /PROBLEMS/ })).toContainText("3");
});

test("severity toggles narrow the list", async ({ page }) => {
  await desktop(page, {
    checkers: [{ id: "tsc", label: "TypeScript" }],
    checkerOutput: TSC_OUTPUT,
  });
  await showView(page, "PROBLEMS");
  const problems = page.getByRole("region", { name: "Problems" });
  await problems.getByRole("button", { name: "TypeScript", exact: true }).click();
  await expect(problems.getByText(/never read/)).toBeVisible();

  await problems.getByRole("button", { name: "warnings" }).click();
  await expect(problems.getByText(/never read/)).toHaveCount(0);
  await expect(problems.getByText(/not assignable/)).toBeVisible();
});

test("the filter accepts text and a negated glob", async ({ page }) => {
  await desktop(page, {
    checkers: [{ id: "tsc", label: "TypeScript" }],
    checkerOutput: TSC_OUTPUT,
  });
  await showView(page, "PROBLEMS");
  const problems = page.getByRole("region", { name: "Problems" });
  await problems.getByRole("button", { name: "TypeScript", exact: true }).click();

  await problems.getByLabel("Filter problems").fill("other");
  await expect(problems.getByRole("button", { name: /src\/other\.ts/ })).toBeVisible();
  await expect(problems.getByRole("button", { name: /src\/app\.ts/ })).toHaveCount(0);

  await problems.getByLabel("Filter problems").fill("!*other*");
  await expect(problems.getByRole("button", { name: /src\/app\.ts/ })).toBeVisible();
  await expect(problems.getByRole("button", { name: /src\/other\.ts/ })).toHaveCount(0);
});

test("a second run replaces that checker's earlier findings", async ({ page }) => {
  await desktop(page, {
    checkers: [{ id: "tsc", label: "TypeScript" }],
    checkerOutput: TSC_OUTPUT,
  });
  await showView(page, "PROBLEMS");
  const problems = page.getByRole("region", { name: "Problems" });
  await problems.getByRole("button", { name: "TypeScript", exact: true }).click();
  await expect(problems.getByText(/not assignable/)).toBeVisible();

  // The tool now reports nothing, which must clear what it said before rather than
  // leaving stale diagnostics behind.
  await page.evaluate(() => {
    (window as unknown as { __scenarioCheckerOutput: string }).__scenarioCheckerOutput = "";
  });
  await problems.getByRole("button", { name: "TypeScript", exact: true }).click();
  // "No problems found." rather than blaming filters that were never set.
  await expect(problems.getByText("No problems found.")).toBeVisible();
});

// --- IDE-01: one identity from checker to editor ---------------------------------------------

test("a checker's relative paths are the workspace's files: squiggles, Current file, exact column", async ({
  page,
}) => {
  await desktop(page, {
    checkers: [{ id: "tsc", label: "TypeScript" }],
    checkerOutput: TSC_OUTPUT,
    checkerCode: 2,
  });
  await showView(page, "PROBLEMS");
  const problems = page.getByRole("region", { name: "Problems" });
  await problems.getByRole("button", { name: "TypeScript", exact: true }).click();
  // Listed under the file's own path, resolved against the folder the checker ran in.
  await expect(problems.getByRole("button", { name: /\/work\/src\/app\.ts/ })).toBeVisible();

  await problems.getByText(/not assignable/).click();
  await expect.poll(() => withEditor<string>(page, "(editor) => editor.label()")).toBe("app.ts");
  // The editor draws them: the checker's file is the editor's file. (Only lines on screen are
  // drawn, so each is checked with its line brought into view by going to it.)
  await expect(page.locator("[data-editor=monaco] .squiggly-error")).toHaveCount(1);
  await problems.getByText(/never read/).click();
  await expect(page.locator("[data-editor=monaco] .squiggly-warning")).toHaveCount(1);

  // "Current file" keeps this file's problems and drops the other file's.
  await problems.getByRole("button", { name: "Current file" }).click();
  await expect(problems.getByText(/not assignable/)).toBeVisible();
  await expect(problems.getByText(/never read/)).toBeVisible();
  await expect(problems.getByText(/';' expected/)).toHaveCount(0);
  await problems.getByRole("button", { name: "Current file" }).click();
  await expect(problems.getByText(/';' expected/)).toBeVisible();
});

test("a problem past the end of its file lands on the last line, with no error", async ({
  page,
}) => {
  await desktop(page, {
    checkers: [{ id: "tsc", label: "TypeScript" }],
    // The harness's files have 30 lines: this location is stale.
    checkerOutput: "src/app.ts(999,500): error TS1005: ';' expected.",
    checkerCode: 2,
  });
  const failures: string[] = [];
  page.on("pageerror", (error) => failures.push(error.message));
  await showView(page, "PROBLEMS");
  const problems = page.getByRole("region", { name: "Problems" });
  await problems.getByRole("button", { name: "TypeScript", exact: true }).click();
  await problems.getByText(/';' expected/).click();
  await expect.poll(() => withEditor<string>(page, "(editor) => editor.label()")).toBe("app.ts");
  const lastLine = Array.from({ length: 29 }, (_, i) => `line ${i + 1}\n`).join("").length;
  await expect
    .poll(async () => (await editorSelections(page))?.[0]?.start)
    .toBe(lastLine + "line 30".length);
  expect(failures).toEqual([]);
  await expect(appAlert(page)).toHaveCount(0);
});

test("Stop and a timeout are said plainly, not as a failure to run", async ({ page }) => {
  await desktop(page, {
    checkers: [{ id: "tsc", label: "TypeScript" }],
    checkerOutput: TSC_OUTPUT,
  });
  await showView(page, "PROBLEMS");
  const problems = page.getByRole("region", { name: "Problems" });
  await page.evaluate(() => {
    const scenario = window as unknown as { __checkerDelay?: number; __checkerOutcome?: string };
    scenario.__checkerDelay = 600;
    scenario.__checkerOutcome = "cancelled";
  });
  await problems.getByRole("button", { name: "TypeScript", exact: true }).click();
  await problems.getByRole("button", { name: "Stop" }).click();
  await expect.poll(async () => countCalls(page, "cancel_checker")).toBe(1);
  await expect(problems.getByRole("status")).toHaveText("TypeScript was stopped.");
  await expect(problems.getByRole("alert")).toHaveCount(0);

  await page.evaluate(() => {
    const scenario = window as unknown as { __checkerDelay?: number; __checkerOutcome?: string };
    scenario.__checkerDelay = 0;
    scenario.__checkerOutcome = "timedOut";
  });
  await problems.getByRole("button", { name: "TypeScript", exact: true }).click();
  await expect(problems.getByRole("status")).toHaveText("TypeScript timed out and was stopped.");
  await expect(problems.getByRole("alert")).toHaveCount(0);
  await expect(problems).not.toContainText("Git");
});

test("right-clicking the second pane of a split does not collapse the layout", async ({ page }) => {
  // Right-click used to make the pane "active", which in a split set activeId === splitId:
  // both halves then rendered the same terminal, one at half width with dead space beside it.
  await desktop(page);
  await openPanel(page);
  await terminalIds(page);
  await page.getByLabel("Split Terminal").click();
  const ids = await terminalIds(page, 2);

  await view(page, ids[1]).click({ button: "right" });
  await page.keyboard.press("Escape");

  // Both panes still show their own terminal.
  await expect(view(page, ids[0])).toBeVisible();
  await expect(view(page, ids[1])).toBeVisible();
});

test("closing the first pane of a split leaves one working terminal", async ({ page }) => {
  await desktop(page);
  await openPanel(page);
  await terminalIds(page);
  await page.getByLabel("Split Terminal").click();
  const ids = await terminalIds(page, 2);

  // Close the left pane from its tab.
  await page.getByRole("tab", { name: "Command Prompt", exact: true }).hover();
  await page.getByLabel("Close Command Prompt", { exact: true }).click();

  await expect(view(page, ids[1])).toBeVisible();
  await output(page, ids[1], "still alive");
  await expect(view(page, ids[1])).toContainText("still alive");
});

test("Show Git Output works again after switching away from it", async ({ page }) => {
  // Requesting the same view twice set identical state, React bailed out, and the panel's
  // effect never re-ran -- so this worked exactly once per session.
  await desktop(page);
  await page.getByTitle("Source Control (Ctrl+Shift+G)").click();
  const showGitOutput = async () => {
    await page
      .getByRole("complementary", { name: "Source control" })
      .getByLabel("Changes actions")
      .click();
    await page.getByRole("menuitem", { name: "Show Git Output" }).click();
  };

  await showGitOutput();
  await expect(page.getByRole("region", { name: "Output" })).toBeVisible();

  await page
    .getByRole("tablist", { name: "Panel views" })
    .getByRole("tab", { name: "PORTS" })
    .click();
  await expect(page.getByRole("region", { name: "Ports" })).toBeVisible();

  await showGitOutput();
  await expect(page.getByRole("region", { name: "Output" })).toBeVisible();
});

test("the panel's tabs are one tab stop, with arrows moving between them", async ({ page }) => {
  await desktop(page);
  await openPanel(page);
  const tabs = page.getByRole("tablist", { name: "Panel views" });

  // Roving tabindex: only the selected tab is reachable by Tab.
  await expect(tabs.getByRole("tab", { name: "TERMINAL" })).toHaveAttribute("tabindex", "0");
  await expect(tabs.getByRole("tab", { name: "PORTS" })).toHaveAttribute("tabindex", "-1");

  await tabs.getByRole("tab", { name: "TERMINAL" }).focus();
  await page.keyboard.press("ArrowRight");
  // Focus follows selection, so the next arrow press moves from the right place.
  await expect(tabs.getByRole("tab", { name: "PORTS" })).toBeFocused();
});

const UNDECIDED = { trusted: false, decided: false, root: "/work", parent: "/projects" };
const RESTRICTED = { trusted: false, decided: true, root: "/work", parent: "/projects" };

test("an undecided folder asks about trust before anything runs its tools", async ({ page }) => {
  await desktop(page, { trust: UNDECIDED });
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Do you trust the authors");
  // Says what it does and does not block, so the choice is informed.
  await expect(dialog).toContainText("compiler or linter");
  await expect(dialog).toContainText("integrated terminal");
});

test("a decided folder is not asked again", async ({ page }) => {
  await desktop(page, { trust: RESTRICTED });
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Restricted Mode/ })).toBeVisible();
});

test("choosing Restricted Mode leaves the terminal and editing working", async ({ page }) => {
  await desktop(page, { trust: UNDECIDED });
  await page.getByRole("button", { name: "No, browse in Restricted Mode" }).click();

  await expect(page.getByRole("button", { name: /Restricted Mode/ })).toBeVisible();
  // The terminal is an explicit user action and stays available.
  await openPanel(page);
  const [id] = await terminalIds(page);
  await expect(view(page, id)).toBeVisible();
});

test("Restricted Mode explains why Problems is empty and offers a way out", async ({ page }) => {
  await desktop(page, { trust: RESTRICTED, checkers: [{ id: "tsc", label: "TypeScript" }] });
  await showView(page, "PROBLEMS");

  const problems = page.getByRole("region", { name: "Problems" });
  await expect(problems).toContainText("Restricted Mode");
  // No checker is offered to press, rather than one that fails when pressed.
  await expect(problems.getByRole("button", { name: "TypeScript", exact: true })).toHaveCount(0);
  await problems.getByRole("button", { name: "Manage Workspace Trust" }).click();
  await expect(page.getByRole("dialog")).toContainText("Workspace Trust");
});

test("trusting the folder enables the checkers", async ({ page }) => {
  await desktop(page, { trust: UNDECIDED, checkers: [{ id: "tsc", label: "TypeScript" }] });
  await page.getByRole("button", { name: "Yes, I trust the authors" }).click();
  await expect(page.getByRole("button", { name: /Restricted Mode/ })).toHaveCount(0);

  await showView(page, "PROBLEMS");
  await expect(
    page.getByRole("region", { name: "Problems" }).getByRole("button", {
      name: "TypeScript",
      exact: true,
    }),
  ).toBeVisible();
});

test("the parent-folder option is offered and passed through", async ({ page }) => {
  await desktop(page, { trust: UNDECIDED });
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("projects");
  await dialog.getByRole("checkbox").check();
  await dialog.getByRole("button", { name: "Yes, I trust the authors" }).click();

  await expect
    .poll(async () =>
      (await calls(page, "set_workspace_trust")).map((c) => [c.args.trusted, c.args.parent]),
    )
    .toContainEqual([true, true]);
});

test("the status bar opens the manage view, which is dismissible", async ({ page }) => {
  await desktop(page, { trust: RESTRICTED });
  await page.getByRole("button", { name: /Restricted Mode/ }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("Workspace Trust");
  // Dismissible, unlike the first decision.
  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("a trusted window can still reach trust, and take it back", async ({ page }) => {
  // A trusted window shows no Restricted Mode badge, so without the menu entry there would be
  // no way back to the decision and trust could never be revoked.
  await desktop(page, {
    trust: { trusted: true, decided: true, root: "/work", parent: "/projects" },
  });
  await page.getByRole("menubar").getByRole("menuitem", { name: "File", exact: true }).click();
  await page.getByRole("menuitem", { name: "Manage Workspace Trust", exact: true }).click();

  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("region", { name: "Trusted folders" })).toContainText("/work");
  await dialog.getByRole("button", { name: "Stop trusting /work" }).click();

  await expect(page.getByRole("button", { name: /Restricted Mode/ })).toBeVisible();
});

test("leaving a workspace detaches its terminals; coming back finds them running, replayed", async ({
  page,
}) => {
  // TERMINAL-03: switching folders is not closing their terminals.
  await desktop(page);
  await openPanel(page);
  const [id] = await terminalIds(page);
  await output(page, id, "before leaving\r\n");
  await expect(view(page, id)).toContainText("before leaving");
  const openFolder = async (folder: string) => {
    await page.evaluate((path) => {
      (window as unknown as { __openFolder?: string }).__openFolder = path;
    }, folder);
    await page.getByRole("menubar").getByRole("menuitem", { name: "File", exact: true }).click();
    await page
      .getByRole("menu", { name: "File", exact: true })
      .getByRole("menuitem", { name: "Open Folder…", exact: true })
      .click();
  };

  await openFolder("/other");
  await expect(view(page, id)).toHaveCount(0);
  // Output while away is kept for the return.
  await output(page, id, "while away\r\n");
  await openFolder("/work");
  await expect(view(page, id)).toContainText("before leaving");
  await expect(view(page, id)).toContainText("while away");

  // The same shell: never closed, never started again.
  const forThisOne = async (command: string) =>
    (await calls(page, command)).filter((call) => call.args.id === id).length;
  expect(await forThisOne("terminal_close")).toBe(0);
  expect(await forThisOne("terminal_kill")).toBe(0);
  expect(await forThisOne("terminal_open")).toBe(1);
  expect(await countCalls(page, "terminal_close_all")).toBe(1);
  // Its views were detached and attached again (a view's subscription is named after it).
  const detached = (await calls(page, "terminal_unsubscribe")).filter((call) =>
    String(call.args.subscriptionId).startsWith(`${id}-view-`),
  );
  expect(detached.length).toBeGreaterThan(0);
});

// --- TERMINAL-04: the renderer as a view of the workspace's terminals ----------------------------

/** Opens a folder through File › Open Folder… (the mock answers with `folder`). */
async function openFolder(page: Page, folder: string) {
  await page.evaluate((path) => {
    (window as unknown as { __openFolder?: string }).__openFolder = path;
  }, folder);
  await page.getByRole("menubar").getByRole("menuitem", { name: "File", exact: true }).click();
  await page
    .getByRole("menu", { name: "File", exact: true })
    .getByRole("menuitem", { name: "Open Folder…", exact: true })
    .click();
}

test("a split survives leaving the workspace: both terminals come back, attached, never restarted", async ({
  page,
}) => {
  await desktop(page);
  await openPanel(page);
  await terminalIds(page);
  await page.getByLabel("Split Terminal").click();
  const [left, right] = await terminalIds(page, 2);
  await expect(view(page, left)).toBeVisible();
  await expect(view(page, right)).toBeVisible();

  await openFolder(page, "/other");
  await expect(view(page, left)).toHaveCount(0);
  await output(page, right, "right while away\r\n");
  await openFolder(page, "/work");

  // The same two sessions, side by side again, the right one replayed.
  await expect(view(page, left)).toBeVisible();
  await expect(view(page, right)).toBeVisible();
  await expect(view(page, right)).toContainText("right while away");
  await expect(page.getByLabel("Unsplit Terminal")).toBeVisible();
  const opens = (await calls(page, "terminal_open")).filter(
    (call) => call.args.id === left || call.args.id === right,
  );
  expect(new Set(opens.map((call) => `${call.args.id}:${call.args.generation}`)).size).toBe(2);
  expect(await countCalls(page, "terminal_close")).toBe(0);
});

test("a rename is the session's: it survives leaving the workspace and coming back", async ({
  page,
}) => {
  await desktop(page);
  await openPanel(page);
  await terminalIds(page);
  const tabs = page.getByRole("tablist", { name: "Terminals" });
  await tabs.getByRole("tab").first().dblclick();
  await page.getByLabel("Rename terminal").fill("Builds");
  await page.getByLabel("Rename terminal").press("Enter");
  await expect(tabs.getByRole("tab", { name: "Builds" })).toBeVisible();

  await openFolder(page, "/other");
  await openFolder(page, "/work");
  await expect(
    page.getByRole("tablist", { name: "Terminals" }).getByRole("tab", { name: "Builds" }),
  ).toBeVisible();
});

test("the context menu acts on the pane it was opened on, not the one in front", async ({
  page,
}) => {
  await desktop(page);
  await openPanel(page);
  await terminalIds(page);
  await page.getByLabel("Split Terminal").click();
  const [left, right] = await terminalIds(page, 2);
  // Working in the left pane; the menu is opened on the right one.
  await view(page, left).click();
  await view(page, right).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Close Terminal" }).click();

  await expect
    .poll(async () => (await calls(page, "terminal_close")).map((c) => c.args.id))
    .toEqual([right]);
  await expect(view(page, left)).toBeVisible();
  await expect(page.getByLabel("Split Terminal")).toBeVisible();
});

test("a paste goes through the terminal, bracketed when the program asked for it", async ({
  page,
}) => {
  await desktop(page);
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await openPanel(page);
  const [id] = await terminalIds(page);
  // The program turns bracketed paste on.
  await output(page, id, "\x1b[?2004h");
  await page.evaluate(() => navigator.clipboard.writeText("echo one\necho two"));
  await view(page, id).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Paste" }).click();
  await expect
    .poll(async () => (await calls(page, "terminal_write")).map((c) => c.args.data).join(""))
    .toBe("\x1b[200~echo one\recho two\x1b[201~");
});

test("a large paste reaches the shell whole, in pieces the contract allows", async ({ page }) => {
  await desktop(page);
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await openPanel(page);
  const [id] = await terminalIds(page);
  const text = "x".repeat(150_000);
  await page.evaluate((value) => navigator.clipboard.writeText(value), text);
  await view(page, id).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Paste" }).click();
  await expect
    .poll(async () => (await calls(page, "terminal_write")).map((c) => c.args.data).join(""))
    .toBe(text);
  const sizes = (await calls(page, "terminal_write")).map((c) => (c.args.data as string).length);
  expect(sizes.length).toBeGreaterThan(1);
  expect(Math.max(...sizes)).toBeLessThanOrEqual(64 * 1024);
});

test("the status line is the focused terminal's own", async ({ page }) => {
  await desktop(page);
  await openPanel(page);
  await terminalIds(page);
  await page.getByLabel("Split Terminal").click();
  const [left, right] = await terminalIds(page, 2);
  // The right one exits; the left one, in front, still runs.
  await view(page, left).click();
  await exit(page, right, 2);
  await expect(view(page, right)).toContainText("exited with code 2");
  await expect(page.getByRole("status").filter({ hasText: "Running" })).toBeVisible();
  // Its own failure shows once the right pane is the one in front.
  await view(page, right).click();
  await expect(page.getByRole("status").filter({ hasText: "Running" })).toHaveCount(0);
});

test("Ctrl+Shift+` starts a terminal from anywhere in the window", async ({ page }) => {
  await desktop(page);
  await openPanel(page);
  await terminalIds(page);
  // Outside the terminal, where the app's own shortcut handling applies.
  await page.getByTitle("Explorer (Ctrl+Shift+E)").click();
  await page.keyboard.press("Control+Shift+Backquote");
  await terminalIds(page, 2);
});

test("leaving the workspace or unmounting a view never closes a terminal", async ({ page }) => {
  await desktop(page);
  await openPanel(page);
  await terminalIds(page);
  await page.getByLabel("New Terminal").click();
  await terminalIds(page, 2);
  // Hiding the panel, switching tabs and leaving the workspace unmount or hide views.
  await page
    .getByRole("tablist", { name: "Panel views" })
    .getByRole("tab", { name: "OUTPUT" })
    .click();
  await page
    .getByRole("tablist", { name: "Panel views" })
    .getByRole("tab", { name: "TERMINAL" })
    .click();
  await openFolder(page, "/other");
  await openFolder(page, "/work");
  expect(await countCalls(page, "terminal_close")).toBe(0);
  expect(await countCalls(page, "terminal_kill")).toBe(0);
  expect(await countCalls(page, "terminal_close_all")).toBe(1);
  // This workspace still has exactly its two; the other folder got its own first terminal.
  const opened = await calls(page, "terminal_open");
  const byWorkspace = (folder: string) =>
    new Set(
      opened
        .filter((call) => String(call.args.workspaceId).endsWith(folder))
        .map((call) => call.args.id),
    ).size;
  expect(byWorkspace("/work")).toBe(2);
  expect(byWorkspace("/other")).toBe(1);
});

// --- TERMINAL-05: profiles -----------------------------------------------------------------------

test("the shell menu lists every profile; one that cannot start says why and starts nothing", async ({
  page,
}) => {
  await desktop(page);
  await openPanel(page);
  await terminalIds(page);
  await page.getByLabel("Choose a shell").click();
  const menu = page.getByRole("menu", { name: "Shells" });
  const pwsh = menu.getByRole("menuitem", { name: "PowerShell", exact: true });
  await expect(pwsh).toBeDisabled();
  await expect(pwsh).toHaveAttribute("title", "PowerShell 7 (pwsh.exe) is not installed.");
  await expect(menu.getByRole("menuitem", { name: "Manage Profiles…" })).toBeVisible();
  const opens = await countCalls(page, "terminal_open");
  await pwsh.click({ force: true });
  expect(await countCalls(page, "terminal_open")).toBe(opens);
});

test("a profile made in the dialog launches with its arguments, environment, folder and login", async ({
  page,
}) => {
  await desktop(page);
  await openPanel(page);
  await terminalIds(page);
  await page.getByLabel("Choose a shell").click();
  await page.getByRole("menuitem", { name: "Manage Profiles…" }).click();
  const dialog = page.getByRole("dialog", { name: "Terminal profiles" });
  await dialog.getByRole("button", { name: "New Profile" }).click();
  await dialog.getByLabel("Name", { exact: true }).fill("Builds");
  await dialog.getByLabel("Shell", { exact: true }).selectOption({ label: "Git Bash" });
  await dialog.getByLabel("Arguments").fill('--rcfile\na file & "quotes"');
  await dialog.getByLabel("Folder").fill("tools");
  await dialog.getByLabel("Environment").fill("BASE=/opt\nTOOLS=$BASE/tools");
  await dialog.getByLabel("Login shell").check();
  await dialog.getByRole("button", { name: "Save Profile" }).click();
  await expect(dialog.getByRole("listitem", { name: "Builds" })).toBeVisible();
  await dialog
    .getByRole("listitem", { name: "Builds" })
    .getByRole("button", { name: "Open" })
    .click();

  const [id] = (await terminalIds(page, 2)).slice(-1);
  const open = (await calls(page, "terminal_open")).filter((c) => c.args.id === id)[0];
  const profile = open.args.profile as Record<string, unknown>;
  expect(profile).toMatchObject({
    name: "Builds",
    executable: BASH,
    args: ["--rcfile", 'a file & "quotes"'],
    cwd: "tools",
    env: [
      ["BASE", "/opt"],
      ["TOOLS", "$BASE/tools"],
    ],
    login: true,
  });
  await expect(page.getByRole("tab", { name: "Builds", exact: true })).toHaveAttribute(
    "title",
    "Profile: Builds",
  );
});

test("an invalid profile is refused with a reason, and a login shell is only offered where it exists", async ({
  page,
}) => {
  await desktop(page);
  await openPanel(page);
  await terminalIds(page);
  await page.getByLabel("Choose a shell").click();
  await page.getByRole("menuitem", { name: "Manage Profiles…" }).click();
  const dialog = page.getByRole("dialog", { name: "Terminal profiles" });
  await dialog.getByRole("button", { name: "New Profile" }).click();
  // The Command Prompt has no login mode.
  await dialog.getByLabel("Shell", { exact: true }).selectOption({ label: "Command Prompt" });
  await expect(dialog.getByLabel("Login shell")).toBeDisabled();
  await dialog.getByLabel("Environment").fill("A=B=C\n=nameless");
  await dialog.getByLabel("Name", { exact: true }).fill("Broken");
  await dialog.getByRole("button", { name: "Save Profile" }).click();
  await expect(dialog.getByRole("alert")).toContainText("not a valid environment variable name");
  await expect(dialog.getByRole("listitem", { name: "Broken" })).toHaveCount(0);
  // Built-in profiles can be used and made default, never edited or deleted.
  const builtin = dialog.getByRole("listitem", { name: "Git Bash" });
  await expect(builtin.getByRole("button", { name: "Edit" })).toHaveCount(0);
  await expect(builtin.getByRole("button", { name: "Delete" })).toHaveCount(0);
});

test("the default profile is what New Terminal starts", async ({ page }) => {
  await desktop(page);
  await openPanel(page);
  await terminalIds(page);
  await page.getByLabel("Choose a shell").click();
  await page.getByRole("menuitem", { name: "Manage Profiles…" }).click();
  const dialog = page.getByRole("dialog", { name: "Terminal profiles" });
  await dialog
    .getByRole("listitem", { name: "Git Bash" })
    .getByRole("button", { name: "Make default" })
    .click();
  await expect(dialog.getByRole("listitem", { name: "Git Bash" })).toContainText("Default");
  await dialog.getByLabel("Close profiles").click();
  await page.getByLabel("New Terminal").click();
  const [id] = (await terminalIds(page, 2)).slice(-1);
  const open = (await calls(page, "terminal_open")).filter((c) => c.args.id === id)[0];
  expect(open.args.shell).toBe(BASH);
});

// --- Persistence and settings (TERMINAL-07) ---------------------------------------------------

/** The terminal's font size, as xterm draws it. */
const fontSizeOf = (page: Page, id: string) =>
  page.evaluate(
    (label) =>
      parseFloat(
        getComputedStyle(document.querySelector(`[aria-label="${label}"] .xterm-rows`) as Element)
          .fontSize,
      ),
    `Terminal ${id}`,
  );

async function manageProfiles(page: Page) {
  await page.getByLabel("Choose a shell").click();
  await page.getByRole("menuitem", { name: "Manage Profiles…" }).click();
  return page.getByRole("dialog", { name: "Terminal profiles" });
}

test("profiles, the default and the layout are there after a restart; terminals are not", async ({
  page,
}) => {
  await desktop(page);
  await openPanel(page);
  const [first] = await terminalIds(page);
  const dialog = await manageProfiles(page);
  await dialog.getByRole("button", { name: "New Profile" }).click();
  await dialog.getByLabel("Name", { exact: true }).fill("Builds");
  await dialog.getByLabel("Shell", { exact: true }).selectOption({ label: "Git Bash" });
  await dialog.getByLabel("Arguments").fill("--norc");
  await dialog.getByRole("button", { name: "Save Profile" }).click();
  await dialog
    .getByRole("listitem", { name: "Builds" })
    .getByRole("button", { name: "Make default" })
    .click();
  await dialog.getByLabel("Close profiles").click();

  // A bigger font and a taller panel.
  await view(page, first).click();
  await page.keyboard.press("Control+=");
  await page.keyboard.press("Control+=");
  const zoomed = await fontSizeOf(page, first);
  const separator = page.getByRole("separator", { name: "Resize panel" });
  const box = (await separator.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 1);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y - 120, { steps: 5 });
  await page.mouse.up();
  const panel = separator.locator("..");
  const tall = (await panel.boundingBox())!.height;

  await page.reload();
  await openPanel(page);
  // A new shell -- sessions are not kept -- started with the kept default profile.
  const [after] = await terminalIds(page);
  expect(after).not.toBe(first);
  const opened = (await calls(page, "terminal_open")).find((call) => call.args.id === after)!;
  expect(opened.args.profile).toMatchObject({ name: "Builds", args: ["--norc"] });
  await expect.poll(() => fontSizeOf(page, after)).toBe(zoomed);
  await expect
    .poll(async () => Math.round((await panel.boundingBox())!.height))
    .toBe(Math.round(tall));
  // Nothing of the old terminal is shown again.
  await expect(view(page, first)).toHaveCount(0);
});

test("shell integration can be turned off, and stays off after a restart", async ({ page }) => {
  await desktop(page, { unixShell: true });
  await openPanel(page);
  await terminalIds(page);
  const dialog = await manageProfiles(page);
  await dialog.getByLabel("Read shell integration").uncheck();
  await dialog.getByLabel("Close profiles").click();

  await page.reload();
  await openPanel(page);
  const [id] = await terminalIds(page);
  await expect((await manageProfiles(page)).getByLabel("Read shell integration")).not.toBeChecked();
  await page.keyboard.press("Escape");
  // Its shell's report is not read: no folder, no command state.
  await signal(page, id, { signal: "cwd", uri: "file:///work/src", local: true });
  await signal(page, id, { signal: "executing" });
  await expect(page.getByRole("status").filter({ hasText: "Running" })).toHaveText("Running");
  await expect(page.getByTestId("terminal-folder")).toHaveCount(0);
});

test("unreadable terminal settings are said once, kept aside, and the terminal still works", async ({
  page,
}) => {
  await page.addInitScript(() => {
    // Only the first load finds them broken; what Yavin writes back is then read.
    if (!sessionStorage.getItem("seeded")) {
      localStorage.setItem("yavin.terminal.user", "{this is not json");
      sessionStorage.setItem("seeded", "1");
    }
  });
  await desktop(page);
  await expect(page.getByRole("alert")).toContainText("not valid JSON");
  await openPanel(page);
  await terminalIds(page);
  const kept = await page.evaluate(() => localStorage.getItem("yavin.terminal.user.corrupt"));
  expect(kept).toBe("{this is not json");
});

test("settings saved by a newer Yavin are left untouched", async ({ page }) => {
  const theirs = JSON.stringify({ version: 99, fromTheFuture: true });
  await page.addInitScript((value) => {
    localStorage.setItem("yavin.terminal.user", value);
  }, theirs);
  await desktop(page);
  await expect(page.getByRole("alert")).toContainText("newer version of Yavin");
  await openPanel(page);
  const [id] = await terminalIds(page);
  await view(page, id).click();
  await page.keyboard.press("Control+=");
  // Leaving the page writes whatever is waiting: no timing involved.
  await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
  expect(await page.evaluate(() => localStorage.getItem("yavin.terminal.user"))).toBe(theirs);
  // The same flush did write this version's own record (the workspace's layout), so the check
  // above is not passing merely because nothing was written yet.
  const fontSizes = await page.evaluate(() =>
    Object.keys(localStorage)
      .filter((key) => key.startsWith("yavin.terminal.workspace:") && !key.endsWith(".corrupt"))
      .map((key) => JSON.parse(localStorage.getItem(key)!).layout?.fontSize),
  );
  expect(fontSizes).toContain(13);
});

// --- Run / Tasks (IDE-04) -------------------------------------------------------------------
// Tasks run in the workspace's terminals: each test drives the task's shell through the same
// native mock as the terminals above.

const TASKS = [
  {
    id: "build",
    label: "Build",
    command: "npx tsc --noEmit",
    group: "build",
    isDefault: true,
    problemMatcher: ["tsc"],
  },
  { id: "serve", label: "Serve", command: "npm run serve" },
];

/** User settings holding `tasks`, as IDE-03 keeps them, before the window loads. */
async function withTasks(page: Page, tasks: unknown[] = TASKS) {
  await page.addInitScript((value) => {
    if (!localStorage.getItem("yavin.settings.user"))
      localStorage.setItem(
        "yavin.settings.user",
        JSON.stringify({ version: 1, values: { "tasks.definitions": value } }),
      );
  }, tasks);
}

async function runView(page: Page) {
  await page.getByTitle("Run", { exact: true }).click();
  return page.getByRole("complementary", { name: "Run" });
}

/** The terminal a task was launched in, once it is: its session id and the profile it got. */
async function taskLaunch(page: Page, taskId: string) {
  let found: Call | undefined;
  await expect
    .poll(async () => {
      found = (await calls(page, "terminal_open")).find(
        (call) => (call.args.profile as { id: string } | null)?.id === `task.${taskId}`,
      );
      return !!found;
    })
    .toBe(true);
  return {
    id: found!.args.id as string,
    profile: found!.args.profile as { executable: string; args: string[] },
    cwd: found!.args.cwd,
  };
}

const execution = (page: Page, label: string) =>
  page.getByRole("group", { name: `Execution of ${label}`, exact: true });

test("the Run view runs a task in a terminal of its own and follows it to its exit code", async ({
  page,
}) => {
  await withTasks(page);
  await desktop(page);
  const run = await runView(page);
  await expect(run.getByRole("group", { name: "Serve", exact: true })).toBeVisible();

  await run.getByRole("button", { name: "Run Serve", exact: true }).click();
  const launch = await taskLaunch(page, "serve");
  // The default shell (the Command Prompt), started to run the line and end, in the root.
  expect(launch.profile.executable).toBe(CMD);
  expect(launch.profile.args).toEqual(["/d", "/s", "/c", "npm run serve"]);
  expect(launch.cwd).toBe("/work");
  await expect(execution(page, "Serve").getByTestId("task-state")).toHaveText("Running");
  // Shown as it starts, in a terminal named for it.
  await expect(page.getByRole("tab", { name: "Task: Serve", exact: true })).toBeVisible();

  await output(page, launch.id, "listening on 5173\r\n");
  await expect(view(page, launch.id)).toContainText("listening on 5173");
  await exit(page, launch.id, 0);
  await expect(execution(page, "Serve").getByTestId("task-state")).toHaveText("Succeeded (0)");
});

test("Run Build Task runs the default build task and its errors reach Problems", async ({
  page,
}) => {
  await withTasks(page);
  await desktop(page);
  await page.getByRole("menubar").getByRole("menuitem", { name: "Run", exact: true }).click();
  await page
    .getByRole("menu", { name: "Run", exact: true })
    .getByRole("menuitem", { name: "Run Build Task", exact: true })
    .click();
  const launch = await taskLaunch(page, "build");
  await output(page, launch.id, TSC_OUTPUT.replace(/\n/g, "\r\n") + "\r\n");
  await exit(page, launch.id, 2);

  await runView(page);
  await expect(execution(page, "Build").getByTestId("task-state")).toHaveText("Failed (2)");
  // The panel is open already: the task showed its terminal there.
  await page
    .getByRole("tablist", { name: "Panel views" })
    .getByRole("tab", { name: "PROBLEMS" })
    .click();
  const problems = page.getByRole("region", { name: "Problems" });
  await expect(problems.getByRole("button", { name: /src\/app\.ts/ })).toBeVisible();
  await expect(problems.getByText(/not assignable/)).toBeVisible();
  await expect(problems.getByText(/Ln 12, Col 7/)).toBeVisible();
});

test("Stop interrupts a running task through its terminal and marks it stopped", async ({
  page,
}) => {
  await withTasks(page);
  await desktop(page);
  const run = await runView(page);
  await run.getByRole("button", { name: "Run Serve", exact: true }).click();
  const launch = await taskLaunch(page, "serve");
  await expect(execution(page, "Serve").getByTestId("task-state")).toHaveText("Running");

  await run.getByRole("button", { name: "Stop Serve", exact: true }).click();
  // Ctrl+C, written to the task's own terminal -- nothing is killed from the window.
  await expect
    .poll(async () =>
      (await calls(page, "terminal_write"))
        .filter((call) => call.args.id === launch.id)
        .map((call) => call.args.data),
    )
    .toContain("\u0003");
  await exit(page, launch.id, 130);
  await expect(execution(page, "Serve").getByTestId("task-state")).toHaveText("Stopped");
  await expect(run.getByRole("button", { name: "Stop Serve", exact: true })).toHaveCount(0);
});

test("a task in a restricted folder does not run and offers the trust decision", async ({
  page,
}) => {
  await withTasks(page);
  await desktop(page, {
    trust: { trusted: false, decided: true, root: "/work", parent: "/projects" },
  });
  const run = await runView(page);
  await run.getByRole("button", { name: "Run Serve", exact: true }).click();

  await expect(appAlert(page)).toContainText("Workspace Trust");
  await expect(page.getByRole("dialog")).toContainText("Workspace Trust");
  const launched = (await calls(page, "terminal_open")).filter((call) =>
    (call.args.profile as { id: string } | null)?.id?.startsWith("task."),
  );
  expect(launched).toEqual([]);
});

test("Configure Tasks edits the task list in Settings, refusing an invalid one", async ({
  page,
}) => {
  await desktop(page);
  const run = await runView(page);
  await expect(run).toContainText("No tasks yet");
  await run.getByRole("button", { name: "Configure Tasks", exact: true }).click();

  const settings = page.getByRole("region", { name: "Settings" });
  await expect(settings.getByRole("textbox", { name: "Search settings" })).toHaveValue("Tasks");
  const editor = settings.getByRole("textbox", { name: "Tasks", exact: true });
  await editor.fill('[{ "id": "lint", "label": "Lint" }]');
  await settings.getByRole("button", { name: "Apply", exact: true }).click();
  // Refused with why, and nothing kept.
  await expect(settings.getByRole("alert")).toContainText("command");
  await editor.fill('[{ "id": "lint", "label": "Lint", "command": "npm run lint" }]');
  await settings.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(settings.getByRole("alert")).toHaveCount(0);

  // The Run view, still open beside the editor, lists it at once.
  await page.getByRole("button", { name: "Close settings" }).click();
  await expect(run.getByRole("group", { name: "Lint", exact: true })).toBeVisible();
});

test("the Run menu holds the task commands; Stop Task waits for a running task", async ({
  page,
}) => {
  await desktop(page);
  await page.getByRole("menubar").getByRole("menuitem", { name: "Run", exact: true }).click();
  const menu = page.getByRole("menu", { name: "Run", exact: true });
  for (const item of [
    "Run Task…",
    "Run Build Task",
    "Run Test Task",
    "Show Running Tasks",
    "Configure Tasks",
  ])
    await expect(menu.getByRole("menuitem", { name: item, exact: true })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "Stop Task", exact: true })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  await menu.getByRole("menuitem", { name: "Run Build Task", exact: true }).click();
  await expect(appAlert(page)).toContainText("There is no build task");
});

// --- Debug / DAP (IDE-05) ---------------------------------------------------------------------
// The debugger over the mock's debug adapter (above): DAP requests out through `dap_send`,
// responses and events back as `dap-message`.

const DEBUG_CONFIGS = [{ id: "main", name: "Main", adapter: "debugpy", program: "file.ts" }];

/** User settings holding debug configurations, before the window loads. */
async function withDebugConfigs(page: Page, configs: unknown[] = DEBUG_CONFIGS) {
  await page.addInitScript((value) => {
    if (!localStorage.getItem("yavin.settings.user"))
      localStorage.setItem(
        "yavin.settings.user",
        JSON.stringify({ version: 1, values: { "debug.configurations": value } }),
      );
  }, configs);
}

async function debugView(page: Page) {
  await page.getByTitle("Run and Debug", { exact: true }).click();
  return page.getByRole("complementary", { name: "Debug" });
}

async function runMenu(page: Page, item: string) {
  await page.getByRole("menubar").getByRole("menuitem", { name: "Run", exact: true }).click();
  await page
    .getByRole("menu", { name: "Run", exact: true })
    .getByRole("menuitem", { name: item, exact: true })
    .click();
}

async function openFileTs(page: Page) {
  await page.getByText("file.ts", { exact: true }).dblclick();
  await expect(page.getByRole("tab", { name: /file\.ts/ })).toBeVisible();
  await expect(page.locator("[data-editor=monaco] .view-line").first()).toBeVisible();
}

/** A click in the editor's glyph margin, on `line`. */
async function clickGutter(page: Page, line: number) {
  const editor = page.locator("[data-editor=monaco]");
  const number = editor.locator(".line-numbers").filter({ hasText: new RegExp(`^${line}$`) });
  const row = (await number.first().boundingBox())!;
  const margin = (await editor.locator(".margin").first().boundingBox())!;
  await page.mouse.click(margin.x + 8, row.y + row.height / 2);
}

const dapRequests = async (page: Page, name: string) =>
  (await calls(page, "dap_send"))
    .map(
      (call) => JSON.parse(call.args.message as string) as { command: string; arguments?: unknown },
    )
    .filter((request) => request.command === name);

test("a breakpoint set in the gutter stops the program there: stack, variables, console, stepping", async ({
  page,
}) => {
  // One long scenario, start to end: more than the default 30 s on a busy machine.
  test.setTimeout(90_000);
  await withDebugConfigs(page);
  await desktop(page);
  await openFileTs(page);
  await clickGutter(page, 3);
  await expect(page.locator(".yavin-breakpoint")).toHaveCount(1);
  const view = await debugView(page);
  await expect(view.getByRole("group", { name: "Breakpoint file.ts:3" })).toBeVisible();

  await runMenu(page, "Start Debugging");
  await expect
    .poll(async () => (await calls(page, "dap_start")).map((call) => call.args.adapter))
    .toEqual(["debugpy"]);
  // The adapter was told about the breakpoint, by the file's path.
  await expect
    .poll(async () => (await dapRequests(page, "setBreakpoints")).at(-1)?.arguments)
    .toMatchObject({ source: { path: "/work/file.ts" }, breakpoints: [{ line: 3 }] });

  // Paused at it: status, call stack, the paused line in the editor, the locals.
  await expect(view.getByTestId("debug-status")).toHaveText("Paused on breakpoint");
  const top = view.getByRole("button", { name: "Frame work file.ts:3" });
  await expect(top).toHaveAttribute("aria-current", "true");
  await expect(page.locator(".yavin-debug-current-line")).toHaveCount(1);
  const variables = view.getByRole("region", { name: "Variables" });
  await expect(variables.getByRole("treeitem", { name: "line" })).toContainText("3");
  // Children are fetched only when a variable is expanded.
  const items = variables.getByRole("treeitem", { name: "items" });
  await expect(items).toHaveAttribute("aria-expanded", "false");
  expect((await dapRequests(page, "variables")).length).toBe(1);
  await items.getByRole("button").first().click();
  await expect(items.getByRole("treeitem", { name: "1" })).toContainText("2");
  expect((await dapRequests(page, "variables")).length).toBe(2);

  // The Debug Console evaluates in the paused frame.
  const debugConsole = page.getByRole("region", { name: "Debug Console" });
  await expect(debugConsole).toBeVisible();
  await debugConsole.getByRole("textbox", { name: "Evaluate expression" }).fill("total");
  await debugConsole.getByRole("textbox", { name: "Evaluate expression" }).press("Enter");
  await expect(debugConsole.getByRole("log")).toContainText("total = 3");

  // Step Over: the next line, a fresh stack. The other frame can be chosen.
  await view.getByRole("button", { name: "Step Over" }).click();
  await expect(view.getByRole("button", { name: "Frame work file.ts:4" })).toHaveAttribute(
    "aria-current",
    "true",
  );
  await view.getByRole("button", { name: "Frame <module> file.ts:1" }).click();
  await expect
    .poll(async () => (await dapRequests(page, "scopes")).at(-1)?.arguments)
    .toEqual({ frameId: 22 });

  // Continue: nothing more to stop at; the program ends, its output in the console.
  await view.getByRole("button", { name: "Continue" }).click();
  await expect(view.getByTestId("debug-status")).toHaveText(
    /^Ended: The program exited with code 0\./,
  );
  await expect(debugConsole.getByRole("log")).toContainText("done");
  await expect(page.locator(".yavin-debug-current-line")).toHaveCount(0);
  await expect(page.locator(".yavin-breakpoint")).toHaveCount(1);
  await expect(view.getByRole("button", { name: "Continue" })).toBeDisabled();
});

test("Stop ends a running session; only the adapter's own capabilities are offered", async ({
  page,
}) => {
  await withDebugConfigs(page);
  await page.addInitScript(() => {
    (window as unknown as { __dapRunsForever: boolean }).__dapRunsForever = true;
  });
  await desktop(page);
  const view = await debugView(page);
  await view.getByRole("button", { name: "Start Debugging: Main" }).click();
  await expect(view.getByTestId("debug-status")).toHaveText("Running");
  // No restart capability: no Restart.
  await expect(view.getByRole("button", { name: "Restart" })).toHaveCount(0);
  await expect(view.getByRole("button", { name: "Step Over" })).toBeDisabled();
  await view.getByRole("button", { name: "Stop" }).click();
  await expect(view.getByTestId("debug-status")).toHaveText("Ended: Stopped.");
  expect((await dapRequests(page, "terminate")).length).toBe(1);
  expect((await dapRequests(page, "disconnect")).length).toBe(1);
  await expect(view.getByRole("button", { name: "Start Debugging: Main" })).toBeEnabled();
});

test("debugging a restricted folder starts no adapter and offers the trust decision", async ({
  page,
}) => {
  await withDebugConfigs(page);
  await desktop(page, {
    trust: { trusted: false, decided: true, root: "/work", parent: "/projects" },
  });
  const view = await debugView(page);
  await view.getByRole("button", { name: "Start Debugging: Main" }).click();
  await expect(appAlert(page)).toContainText("not trusted");
  await expect(page.getByRole("dialog")).toContainText("Workspace Trust");
  expect(await calls(page, "dap_start")).toEqual([]);
});

test("breakpoints: F9 toggles at the cursor; the Breakpoints list disables and removes them", async ({
  page,
}) => {
  await desktop(page);
  await openFileTs(page);
  await page.locator("[data-editor=monaco] .view-line").first().click();
  await page.keyboard.press("F9");
  await expect(page.locator(".yavin-breakpoint")).toHaveCount(1);
  const view = await debugView(page);
  const mark = view.getByRole("group", { name: "Breakpoint file.ts:1" });
  await mark.getByRole("checkbox", { name: "Enable file.ts:1" }).uncheck();
  await expect(page.locator(".yavin-breakpoint-disabled")).toHaveCount(1);
  await mark.getByRole("button", { name: "Remove file.ts:1" }).click();
  await expect(page.locator(".yavin-breakpoint, .yavin-breakpoint-disabled")).toHaveCount(0);
  await expect(view).toContainText("Click left of a line number");
});

test("with no configuration the Debug view says so and Configure Debugging opens Settings", async ({
  page,
}) => {
  await desktop(page);
  const view = await debugView(page);
  await expect(view).toContainText("No debug configurations yet");
  await view.getByRole("button", { name: "Configure Debugging", exact: true }).click();
  const settingsView = page.getByRole("region", { name: "Settings" });
  await expect(settingsView.getByRole("textbox", { name: "Search settings" })).toHaveValue("Debug");
  await expect(
    settingsView.getByRole("textbox", { name: "Debug configurations", exact: true }),
  ).toBeVisible();
  // The Debug Console has nothing to evaluate in without a session.
  await showView(page, "DEBUG CONSOLE");
  const debugConsole = page.getByRole("region", { name: "Debug Console" });
  await expect(debugConsole).toContainText("No debug session");
  await expect(debugConsole.getByRole("textbox", { name: "Evaluate expression" })).toBeDisabled();
});

// --- Extensions (IDE-07/08/09) ------------------------------------------------------------------
// The sample extension (found in the repository by development builds) and installed manifests
// from the mock's discovery; their code runs in the mock's extension host, through the real
// extension API (`bootstrap.js`) and the native start/send/stop contract.

async function extensionsView(page: Page) {
  await page.getByTitle("Extensions & Plugins (Ctrl+Shift+X)", { exact: true }).click();
  return page.getByRole("complementary", { name: "Extensions" });
}

const sampleState = (view: Locator) =>
  view.getByRole("group", { name: "Hello World (sample)" }).getByTestId("extension-state");

/** The Extensions view's runtime diagnostics (the host, its generation, Restart, Reload). */
async function showDiagnostics(page: Page, view: Locator) {
  await view.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitemcheckbox", { name: "Show Runtime Diagnostics" }).click();
  await expect(view.getByTestId("extension-host")).toBeVisible();
}

test("an extension command is in the palette, and running it activates its extension", async ({
  page,
}) => {
  await desktop(page);
  const view = await extensionsView(page);
  // Lazy: nothing of it runs until it is needed. (Its view being shown is such a need, so the
  // check is made before the Extensions view first shows it -- in a fresh window.)
  await (await palette(page, "Hello World: Say Hello")).click();
  await expect(page.getByRole("status", { name: "Extension message" })).toContainText(
    "Hello World (sample): Hello, world!",
  );
  await expect(sampleState(view)).toHaveText(/^Active/);
  // Its view shows what it did.
  await expect(view.getByRole("region", { name: "Greetings" })).toContainText("Hello, world!");
});

test("disabling an extension takes its command out of the palette", async ({ page }) => {
  await desktop(page);
  const view = await extensionsView(page);
  await view.getByRole("button", { name: "Disable Hello World (sample)" }).click();
  await expect(sampleState(view)).toHaveText("Disabled");
  await palette(page, "Hello World: Say Hello");
  await expect(page.getByRole("option").filter({ hasText: "Hello World: Say Hello" })).toHaveCount(
    0,
  );
  await page.keyboard.press("Escape");
  await view.getByRole("button", { name: "Enable Hello World (sample)" }).click();
  await expect(await palette(page, "Hello World: Say Hello")).toBeVisible();
});

test("in a restricted folder extension code does not run, and the trust decision is offered", async ({
  page,
}) => {
  await desktop(page, {
    trust: { trusted: false, decided: true, root: "/work", parent: "/projects" },
  });
  await (await palette(page, "Hello World: Say Hello")).click();
  await expect(appAlert(page)).toContainText("not trusted");
  await expect(page.getByRole("dialog")).toContainText("Workspace Trust");
  await page.keyboard.press("Escape");
  const view = await extensionsView(page);
  await expect(sampleState(view)).toContainText("Untrusted — This folder is not trusted");
  await expect(page.getByRole("status", { name: "Extension message" })).toHaveCount(0);
});

test("a broken manifest is reported and breaks nothing; a declarative one contributes its setting", async ({
  page,
}) => {
  const declarative = {
    publisher: "acme",
    name: "tidy",
    displayName: "Tidy",
    version: "0.1.0",
    contributes: {
      configuration: {
        properties: {
          "acme.tidy.width": {
            type: "number",
            default: 80,
            minimum: 20,
            maximum: 400,
            description: "Line width.",
          },
        },
      },
    },
  };
  await desktop(page, {
    extensions: [
      { folder: "/data/extensions/acme.tidy", manifest: JSON.stringify(declarative), error: null },
      { folder: "/data/extensions/broken", manifest: "{not json", error: null },
      {
        folder: "/data/extensions/old",
        manifest: JSON.stringify({ ...declarative, name: "old", engines: { yavin: "^9.0.0" } }),
        error: null,
      },
    ],
  });
  const view = await extensionsView(page);
  const tidy = view.getByRole("group", { name: "Tidy", exact: true });
  await expect(tidy).toContainText("v0.1.0");
  await expect(tidy.getByTestId("extension-state")).toHaveText(
    "Installed — Declarative: nothing to run.",
  );
  await expect(
    view.getByRole("group", { name: "Not loaded: /data/extensions/broken" }),
  ).toContainText("not JSON");
  await expect(view.getByRole("group", { name: "Not loaded: acme.old" })).toContainText(
    "Needs extension API ^9.0.0",
  );
  // Found once: a second discovery would list them again as duplicates.
  await expect(view.getByRole("group", { name: /^Not loaded/ })).toHaveCount(2);
  // Everything else still works: the palette, and the sample's command.
  await (await palette(page, "Hello World: Say Hello")).click();
  await expect(page.getByRole("status", { name: "Extension message" })).toContainText(
    "Hello, world!",
  );
  // The declarative extension's setting is in Settings, in its section, owned by Settings.
  await page.keyboard.press("Control+Comma");
  const settingsView = page.getByRole("region", { name: "Settings" });
  await settingsView.getByRole("textbox", { name: "Search settings" }).fill("acme.tidy");
  await expect(settingsView.getByRole("region", { name: "Tidy" })).toContainText("Line width.");
});

test("an extension's view and state are its workspace's: switching folders leaks nothing", async ({
  page,
}) => {
  await desktop(page);
  const view = await extensionsView(page);
  const greetings = view.getByRole("region", { name: "Greetings" });
  await expect(greetings).toContainText("No greetings yet");
  await greetings.getByRole("button", { name: "No greetings yet" }).click();
  await expect(greetings).toContainText("Hello, world!");
  await expect(sampleState(view)).toHaveText(/^Active/);

  // Another folder: the extension of /work is ended; in /other it starts again, from nothing.
  await page.evaluate(() => {
    (window as unknown as { __openFolder?: string }).__openFolder = "/other";
  });
  await page.getByRole("menubar").getByRole("menuitem", { name: "File", exact: true }).click();
  await page
    .getByRole("menu", { name: "File", exact: true })
    .getByRole("menuitem", { name: "Open Folder…", exact: true })
    .click();
  const next = page.getByRole("complementary", { name: "Extensions" });
  await expect(next.getByRole("region", { name: "Greetings" })).toContainText("No greetings yet");
  await expect(next.getByRole("region", { name: "Greetings" })).not.toContainText("Hello, world!");
});

const BROKEN = {
  publisher: "acme",
  name: "broken",
  displayName: "Broken",
  version: "1.0.0",
  engines: { yavin: "^2.0.0" },
  main: "extension.js",
  activationEvents: ["onCommand:acme.broken.go"],
  contributes: { commands: [{ command: "acme.broken.go", title: "Go", category: "Broken" }] },
};

test("an extension that fails to activate is reported and breaks nothing else", async ({
  page,
}) => {
  await desktop(page, {
    extensions: [
      { folder: "/data/extensions/acme.broken", manifest: JSON.stringify(BROKEN), error: null },
    ],
    extensionCode: {
      "acme.broken": 'module.exports.activate = function () { throw new Error("kaboom"); };',
    },
  });
  await (await palette(page, "Broken: Go")).click();
  await expect(appAlert(page)).toContainText("kaboom");
  const view = await extensionsView(page);
  await expect(
    view.getByRole("group", { name: "Broken", exact: true }).getByTestId("extension-state"),
  ).toContainText("kaboom");
  // The sample, in the same host, still works.
  await (await palette(page, "Hello World: Say Hello")).click();
  await expect(page.getByRole("status", { name: "Extension message" })).toContainText(
    "Hello, world!",
  );
});

/** The extension host's generation as the Extensions view shows it. */
async function hostGeneration(view: Locator) {
  const text = (await view.getByTestId("extension-host").textContent()) ?? "";
  return Number(/generation (\d+)/.exec(text)?.[1]);
}

test("a crashed extension host is reported; Restart starts a new one and the extension works again", async ({
  page,
}) => {
  await desktop(page);
  const view = await extensionsView(page);
  await (await palette(page, "Hello World: Say Hello")).click();
  await expect(sampleState(view)).toHaveText(/^Active/);
  await showDiagnostics(page, view);
  await expect(view.getByTestId("extension-host")).toContainText("Host running");
  const first = await hostGeneration(view);
  await page.evaluate(() =>
    (window as unknown as { __crashExtensionHost: () => void }).__crashExtensionHost(),
  );
  await expect(view.getByTestId("extension-host")).toContainText("1 crash");
  await expect(sampleState(view)).not.toHaveText(/^Active/);
  await view.getByRole("button", { name: "Restart", exact: true }).click();
  // Its view is on screen: the new host starts at once to fill it, with what it remembered.
  await expect(view.getByRole("region", { name: "Greetings" })).toContainText("Hello, world!");
  await expect(sampleState(view)).toHaveText(/^Active/);
  expect(await hostGeneration(view)).toBeGreaterThan(first);
  await (await palette(page, "Hello World: Say Hello")).click();
  await expect(
    view
      .getByRole("region", { name: "Greetings" })
      .getByRole("treeitem", { name: "Hello, world!" }),
  ).toHaveCount(2);
});

test("Reload ends the host and finds the extensions again, without duplicating anything", async ({
  page,
}) => {
  await desktop(page);
  const view = await extensionsView(page);
  await (await palette(page, "Hello World: Say Hello")).click();
  await expect(sampleState(view)).toHaveText(/^Active/);
  await showDiagnostics(page, view);
  const first = await hostGeneration(view);
  await view.getByRole("button", { name: "Reload", exact: true }).click();
  await expect.poll(() => hostGeneration(view)).toBeGreaterThan(first);
  await expect(view.getByRole("group", { name: "Hello World (sample)" })).toHaveCount(1);
  await expect(view.getByRole("group", { name: /^Not loaded/ })).toHaveCount(0);
  // Its view, on screen, is filled again by the new host: one greeting, not two.
  const greetings = view.getByRole("region", { name: "Greetings" });
  await expect(greetings.getByRole("treeitem", { name: "Hello, world!" })).toHaveCount(1);
  await palette(page, "Hello World: Say Hello");
  await expect(page.getByRole("option").filter({ hasText: "Hello World: Say Hello" })).toHaveCount(
    1,
  );
  await page.keyboard.press("Escape");
});

test("an extension's Activity Bar container shows its views", async ({ page }) => {
  await desktop(page);
  await page.getByTitle("Hello World", { exact: true }).click();
  const container = page.getByRole("complementary", { name: "Hello World" });
  const about = container.getByRole("region", { name: "About" });
  await expect(about).toContainText("A sample extension");
  await expect(about).toContainText("API 2.0.0");
});

test("extension menus: a view's title action and the Explorer's context menu run its commands", async ({
  page,
}) => {
  await desktop(page);
  const view = await extensionsView(page);
  const greetings = view.getByRole("region", { name: "Greetings" });
  await expect(greetings).toContainText("No greetings yet");
  // Explorer: the extension's item follows Yavin's own.
  await page.getByTitle("Explorer (Ctrl+Shift+E)", { exact: true }).click();
  await page.getByText("file.ts", { exact: true }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Say Hello", exact: true }).click();
  await expect(page.getByRole("status", { name: "Extension message" })).toContainText(
    "Hello, world!",
  );
  // The view's title action.
  const again = await extensionsView(page);
  const list = again.getByRole("region", { name: "Greetings" });
  await expect(list).toContainText("Hello, world!");
  await list.getByRole("button", { name: "Reset Greetings", exact: true }).click();
  await expect(list).toContainText("No greetings yet");
});

// --- The extension marketplace (IDE-09) -----------------------------------------------------------
// The mock serves the deterministic test catalog in the real registry format, read by the real
// YavinRegistryProvider; installing goes through the real ExtensionInstaller and the native
// stage/commit/finish contract, and installed code runs in the mock's extension host.

const card = (view: Locator, name: string) =>
  view.getByRole("group", { name, exact: true }).first();
const searchBox = (view: Locator) => view.getByRole("searchbox", { name: "Search extensions" });

test("the Extensions view: installed extensions from the registry, recommendations from the marketplace", async ({
  page,
}) => {
  await desktop(page);
  const view = await extensionsView(page);
  const installed = view.getByRole("region", { name: "Installed extensions" });
  await expect(card(installed, "Hello World (sample)")).toContainText("yavin-samples");
  await expect(installed.getByLabel("1 installed")).toBeVisible();
  const recommended = view.getByRole("region", { name: "Recommended extensions" });
  await expect(card(recommended, "Docker Tools")).toContainText("Acme Test Co.");
  await expect(
    card(recommended, "Python Tools").getByRole("button", { name: "Install Python Tools" }),
  ).toBeEnabled();
  // Browsing ran nothing of theirs.
  expect((await calls(page, "extensions_stage")).length).toBe(0);
  // Runtime internals are not part of the normal view.
  await expect(view.getByTestId("extension-host")).toHaveCount(0);
  await expect(view).not.toContainText("generation");
});

test("search: results, an empty result, the newest query wins, clear", async ({ page }) => {
  await desktop(page);
  const view = await extensionsView(page);
  await searchBox(view).fill("python");
  await searchBox(view).fill("docker");
  const results = view.getByRole("region", { name: "Marketplace results" });
  await expect(card(results, "Docker Tools")).toBeVisible();
  await expect(results.getByRole("group")).toHaveCount(1);
  await searchBox(view).fill("zzz-nothing");
  await expect(results).toContainText("No extensions match “zzz-nothing”");
  await results.getByRole("button", { name: "Clear search" }).click();
  await expect(searchBox(view)).toHaveValue("");
  await expect(view.getByRole("region", { name: "Recommended extensions" })).toBeVisible();
});

test("filters: installed, a category from the marketplace, compatible only", async ({ page }) => {
  await desktop(page);
  const view = await extensionsView(page);
  // Categories come from the provider (loaded when the menu first opens).
  await view.getByRole("button", { name: "Filter extensions" }).click();
  await page.keyboard.press("Escape");
  await view.getByRole("button", { name: "Filter extensions" }).click();
  await page.getByRole("menuitemcheckbox", { name: "Themes" }).click();
  const results = view.getByRole("region", { name: "Marketplace results" });
  await expect(card(results, "Midnight Settings")).toBeVisible();
  await expect(results.getByRole("group")).toHaveCount(1);
  await view.getByRole("button", { name: "Remove category filter" }).click();
  await searchBox(view).fill("tools");
  await expect(card(results, "Future Tools")).toBeVisible();
  await view.getByRole("button", { name: "Filter extensions" }).click();
  await page.getByRole("menuitemcheckbox", { name: "Compatible only" }).click();
  await expect(card(results, "Docker Tools")).toBeVisible();
  await expect(results.getByRole("group", { name: "Future Tools" })).toHaveCount(0);
  await view.getByRole("button", { name: "Filter extensions" }).click();
  await page.getByRole("menuitemcheckbox", { name: "Installed" }).click();
  await expect(view.getByRole("region", { name: "Marketplace results" })).toHaveCount(0);
  await expect(view.getByRole("region", { name: "Installed extensions" })).toBeVisible();
});

test("an incompatible extension says why and cannot be installed", async ({ page }) => {
  await desktop(page);
  const view = await extensionsView(page);
  await searchBox(view).fill("future");
  const future = card(view.getByRole("region", { name: "Marketplace results" }), "Future Tools");
  await expect(future.getByTestId("extension-state")).toContainText(
    "Incompatible — This extension requires Yavin API 3.0.0",
  );
  await expect(future.getByRole("button", { name: "Install Future Tools" })).toBeDisabled();
});

test("details: an extension's page with its metadata, features and changelog; back to the list", async ({
  page,
}) => {
  await desktop(page);
  const view = await extensionsView(page);
  await card(view.getByRole("region", { name: "Recommended extensions" }), "Python Tools").click();
  const details = page.getByRole("region", { name: "Extension: Python Tools" });
  await expect(details).toContainText("Acme Test Co.");
  await expect(details).toContainText("v1.2.0");
  await details.getByRole("tab", { name: "Features" }).click();
  await expect(details.getByRole("region", { name: "Commands" })).toContainText(
    "Python Tools: Check Environment",
  );
  await details.getByRole("tab", { name: "Changelog" }).click();
  await expect(details.getByRole("document", { name: "Changelog" })).toContainText(
    "Fixture document",
  );
  await details.getByRole("tab", { name: "Information" }).click();
  await expect(details).toContainText("acme.python-tools");
  await expect(details).not.toContainText("Downloads");
  await details.getByRole("button", { name: "Back to Extensions" }).click();
  await expect(details).toHaveCount(0);
});

test("install: progress, then installed, in the registry, and its command runs", async ({
  page,
}) => {
  await desktop(page);
  const view = await extensionsView(page);
  await card(view.getByRole("region", { name: "Recommended extensions" }), "Python Tools")
    .getByRole("button", { name: "Install Python Tools" })
    .click();
  const installed = view.getByRole("region", { name: "Installed extensions" });
  await expect(card(installed, "Python Tools").getByTestId("extension-state")).toHaveText(
    "Enabled",
  );
  await expect(installed.getByLabel("2 installed")).toBeVisible();
  expect((await calls(page, "extensions_commit")).map((c) => c.args.id)).toEqual([
    "acme.python-tools",
  ]);
  await (await palette(page, "Python Tools: Check Environment")).click();
  await expect(page.getByRole("status", { name: "Extension message" })).toContainText(
    "Python Tools: environment OK",
  );
  await expect(card(installed, "Python Tools").getByTestId("extension-state")).toHaveText("Active");
});

test("an unsafe package is refused with a clear message; nothing is installed", async ({
  page,
}) => {
  await desktop(page);
  const view = await extensionsView(page);
  await searchBox(view).fill("broken");
  const broken = card(view.getByRole("region", { name: "Marketplace results" }), "Broken Package");
  await broken.getByRole("button", { name: "Install Broken Package" }).click();
  await expect(broken.getByRole("alert")).toContainText(
    "Broken Package contains unsafe files; it was not installed.",
  );
  await broken.getByText("Details").click();
  await expect(broken.getByRole("alert")).toContainText("../escape.txt");
  expect(await calls(page, "extensions_commit")).toEqual([]);
  await view.getByRole("button", { name: "Clear search" }).click();
  await expect(
    view.getByRole("region", { name: "Installed extensions" }).getByRole("group"),
  ).toHaveCount(1);
});

test("disable removes its command and stops it; enable brings it back, activating only when used", async ({
  page,
}) => {
  await desktop(page);
  const view = await extensionsView(page);
  await card(view.getByRole("region", { name: "Recommended extensions" }), "Docker Tools")
    .getByRole("button", { name: "Install Docker Tools" })
    .click();
  const docker = card(view.getByRole("region", { name: "Installed extensions" }), "Docker Tools");
  await expect(docker.getByTestId("extension-state")).toHaveText("Enabled");
  await (await palette(page, "Docker Tools: Show Status")).click();
  await expect(docker.getByTestId("extension-state")).toHaveText("Active");
  await docker.getByRole("button", { name: "Disable Docker Tools" }).click();
  await expect(docker.getByTestId("extension-state")).toHaveText("Disabled");
  await palette(page, "Docker Tools: Show Status");
  await expect(
    page.getByRole("option").filter({ hasText: "Docker Tools: Show Status" }),
  ).toHaveCount(0);
  await page.keyboard.press("Escape");
  await docker.getByRole("button", { name: "Enable Docker Tools" }).click();
  await expect(docker.getByTestId("extension-state")).toHaveText("Enabled");
  await (await palette(page, "Docker Tools: Show Status")).click();
  await expect(docker.getByTestId("extension-state")).toHaveText("Active");
});

test("update: an older version installed, the update found and badged, installed; the new code runs", async ({
  page,
}) => {
  await desktop(page);
  const view = await extensionsView(page);
  await searchBox(view).fill("updater");
  await card(view.getByRole("region", { name: "Marketplace results" }), "Updater Demo").click();
  const details = page.getByRole("region", { name: "Extension: Updater Demo" });
  await details.getByRole("tab", { name: "Information" }).click();
  await details.getByRole("button", { name: "Install version 1.0.0" }).click();
  await expect(details.getByRole("region", { name: "Versions" })).toContainText("Installed");
  await (await palette(page, "Updater: Which Version")).click();
  await expect(page.getByRole("status", { name: "Extension message" })).toContainText(
    "Updater 1.0.0",
  );
  await (await palette(page, "Extensions: Check for Updates")).click();
  await expect(
    page.getByTitle("Extensions & Plugins (Ctrl+Shift+X)", { exact: true }),
  ).toContainText("1");
  const updates = view.getByRole("region", { name: "Updates" });
  const updater = card(updates, "Updater Demo");
  await expect(updater.getByTestId("extension-state")).toHaveText(
    "Update Available — Version 1.1.0 is available.",
  );
  await updater.getByRole("button", { name: "Update Updater Demo" }).click();
  await expect(updates).toContainText("All installed extensions are up to date.");
  await expect(
    page.getByTitle("Extensions & Plugins (Ctrl+Shift+X)", { exact: true }),
  ).not.toContainText("1");
  await view.getByRole("button", { name: "Remove filter Updates" }).click();
  await expect(
    card(view.getByRole("region", { name: "Installed extensions" }), "Updater Demo"),
  ).toContainText("v1.1.0");
  await (await palette(page, "Updater: Which Version")).click();
  await expect(page.getByRole("status", { name: "Extension message" })).toContainText(
    "Updater 1.1.0",
  );
});

test("uninstall asks first and whether to remove its data; the extension is gone", async ({
  page,
}) => {
  await desktop(page);
  const view = await extensionsView(page);
  await card(view.getByRole("region", { name: "Recommended extensions" }), "Docker Tools")
    .getByRole("button", { name: "Install Docker Tools" })
    .click();
  const installed = view.getByRole("region", { name: "Installed extensions" });
  await card(installed, "Docker Tools")
    .getByRole("button", { name: "Manage Docker Tools" })
    .click();
  await page.getByRole("menuitem", { name: "Uninstall" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("Uninstall Docker Tools?");
  await dialog.getByRole("option", { name: /^Uninstall and remove its data/ }).click();
  await expect(installed.getByRole("group", { name: "Docker Tools" })).toHaveCount(0);
  expect((await calls(page, "extensions_uninstall")).map((c) => c.args.id)).toEqual([
    "acme.docker-tools",
  ]);
  // Back in the marketplace, installable again.
  await expect(
    card(view.getByRole("region", { name: "Recommended extensions" }), "Docker Tools").getByRole(
      "button",
      {
        name: "Install Docker Tools",
      },
    ),
  ).toBeEnabled();
  // A sample found in the repository is not Yavin's to uninstall.
  await card(installed, "Hello World (sample)")
    .getByRole("button", { name: "Manage Hello World (sample)" })
    .click();
  await expect(page.getByRole("menuitem", { name: "Uninstall" })).toHaveCount(0);
  await page.keyboard.press("Escape");
});

test("marketplace unavailable: installed extensions still work; the marketplace says so and retries", async ({
  page,
}) => {
  await desktop(page, { marketplace: { down: true } });
  const view = await extensionsView(page);
  await expect(
    card(view.getByRole("region", { name: "Installed extensions" }), "Hello World (sample)"),
  ).toBeVisible();
  const recommended = view.getByRole("region", { name: "Recommended extensions" });
  await expect(recommended.getByRole("alert")).toContainText(
    "The extension marketplace is unavailable.",
  );
  await searchBox(view).fill("docker");
  const results = view.getByRole("region", { name: "Marketplace results" });
  await expect(results.getByRole("alert")).toContainText(
    "The extension marketplace is unavailable.",
  );
  // The installed extension runs regardless.
  await (await palette(page, "Hello World: Say Hello")).click();
  await expect(page.getByRole("status", { name: "Extension message" })).toContainText(
    "Hello, world!",
  );
  await page.evaluate(() => {
    (window as unknown as { __market: { down: boolean } }).__market.down = false;
  });
  await results.getByRole("button", { name: "Retry" }).click();
  await expect(card(results, "Docker Tools")).toBeVisible();
});

test("reload after installing: no duplicate cards, commands or views", async ({ page }) => {
  await desktop(page);
  const view = await extensionsView(page);
  await card(view.getByRole("region", { name: "Recommended extensions" }), "Python Tools")
    .getByRole("button", { name: "Install Python Tools" })
    .click();
  const installed = view.getByRole("region", { name: "Installed extensions" });
  await expect(card(installed, "Python Tools")).toBeVisible();
  await (await palette(page, "Extensions: Reload")).click();
  await expect(installed.getByLabel("2 installed")).toBeVisible();
  await expect(installed.getByRole("group", { name: "Python Tools" })).toHaveCount(1);
  await expect(view.getByRole("region", { name: "Greetings" })).toHaveCount(1);
  await palette(page, "Python Tools: Check Environment");
  await expect(
    page.getByRole("option").filter({ hasText: "Python Tools: Check Environment" }),
  ).toHaveCount(1);
  await page.keyboard.press("Escape");
});

test("switching workspace: installed extensions are the window's; their runtime is not", async ({
  page,
}) => {
  await desktop(page);
  const view = await extensionsView(page);
  await card(view.getByRole("region", { name: "Recommended extensions" }), "Docker Tools")
    .getByRole("button", { name: "Install Docker Tools" })
    .click();
  await (await palette(page, "Docker Tools: Show Status")).click();
  await expect(
    card(view.getByRole("region", { name: "Installed extensions" }), "Docker Tools").getByTestId(
      "extension-state",
    ),
  ).toHaveText("Active");
  await page.evaluate(() => {
    (window as unknown as { __openFolder?: string }).__openFolder = "/other";
  });
  await page.getByRole("menubar").getByRole("menuitem", { name: "File", exact: true }).click();
  await page
    .getByRole("menu", { name: "File", exact: true })
    .getByRole("menuitem", { name: "Open Folder…", exact: true })
    .click();
  const next = page.getByRole("complementary", { name: "Extensions" });
  const docker = card(next.getByRole("region", { name: "Installed extensions" }), "Docker Tools");
  await expect(docker.getByTestId("extension-state")).toHaveText("Enabled");
});

test("the command palette drives the Extensions view", async ({ page }) => {
  await desktop(page);
  await (await palette(page, "Extensions: Search Extensions")).click();
  const view = page.getByRole("complementary", { name: "Extensions" });
  await expect(searchBox(view)).toBeFocused();
  await (await palette(page, "Extensions: Recommended Extensions")).click();
  await expect(view.getByRole("button", { name: "Remove filter Recommended" })).toBeVisible();
  await expect(view.getByRole("region", { name: "Installed extensions" })).toHaveCount(0);
  await (await palette(page, "Extensions: Disable")).click();
  await page
    .getByRole("dialog")
    .getByRole("option", { name: /^Hello World \(sample\)/ })
    .click();
  await (await palette(page, "Extensions: Installed Extensions")).click();
  await expect(sampleState(view)).toHaveText("Disabled");
});
