import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { transformSync } from "esbuild";
import type { Page } from "@playwright/test";
import type { FakeServer, FakeServerOptions } from "../../src/services/lsp/fakeServer";

/**
 * Language servers for the UI tests: the same deterministic fake the unit tests use
 * (`src/services/lsp/fakeServer.ts`), bundled into the page, standing in for the native
 * `lsp_*` commands and events. Everything above them -- the manager, the client, JSON-RPC,
 * the Monaco adapter -- is the real code.
 *
 * Installed before the page's own fixture: it wraps whatever `__TAURI_INTERNALS__` the fixture
 * sets, answering the `lsp_*` commands and passing everything else through.
 */

const fakeServerSource = transformSync(
  readFileSync(
    fileURLToPath(new URL("../../src/services/lsp/fakeServer.ts", import.meta.url)),
    "utf8",
  ),
  { loader: "ts", format: "iife", globalName: "YavinFakeLsp" },
).code;

export interface FakeLspSetup {
  /** Server ids that are installed (default: typescript). */
  installed?: string[];
  /** Whether the folder is trusted (default: yes). */
  trusted?: boolean;
  /** Options for each server started, by server id. */
  options?: Record<string, FakeServerOptions>;
  /** Files the native side reports read-only (`is_read_only`), by name. */
  readOnly?: string[];
}

export async function installFakeLsp(page: Page, setup: FakeLspSetup = {}) {
  // Assigned to the window explicitly: an init script may run in a scope of its own.
  await page.addInitScript(`${fakeServerSource}
;window.YavinFakeLsp = YavinFakeLsp;`);
  await page.addInitScript((config) => {
    type Invoke = (command: string, args?: Record<string, unknown>) => unknown;
    const create = (
      window as unknown as {
        YavinFakeLsp: { createFakeServer: (o: unknown, io: unknown) => FakeServer };
      }
    ).YavinFakeLsp.createFakeServer;
    const sessions = new Map<number, { serverId: string; server: FakeServer }>();
    let next = 0;
    const control = {
      config,
      sessions,
      /** The latest server started for `serverId`. */
      server(serverId: string) {
        return [...sessions.values()].reverse().find((one) => one.serverId === serverId)?.server;
      },
      started: () => [...sessions.values()].map((one) => one.serverId),
      /** Lifecycle commands in the order the page sent them. */
      lifecycle: [] as string[],
    };
    Object.assign(window, { __lsp: control });
    const emit = (event: string, payload: unknown) =>
      (window as unknown as { __emit: (e: string, p: unknown) => void }).__emit(event, payload);
    const answer = (
      command: string,
      args: Record<string, unknown>,
    ): Promise<unknown> | undefined => {
      if (command === "lsp_servers")
        return Promise.resolve({
          trusted: config.trusted ?? true,
          servers: ["typescript", "pyright", "rust-analyzer"].map((id) => ({
            id,
            label: id,
            program: (config.installed ?? ["typescript"]).includes(id) ? `/fake/${id}` : null,
          })),
        });
      if (command === "lsp_start") {
        control.lifecycle.push("lsp_start");
        const serverId = String(args.server);
        if (!(config.installed ?? ["typescript"]).includes(serverId))
          return Promise.reject(`not-installed: The ${serverId} language server is not installed.`);
        const session = ++next;
        let ended = false;
        const server = create(config.options?.[serverId] ?? {}, {
          send: (message: string) =>
            setTimeout(() => !ended && emit("lsp-message", { session, message }), 0),
          exit: (code: number) => {
            if (ended) return;
            ended = true;
            setTimeout(() => emit("lsp-exit", { session, code, error: null }), 0);
          },
        });
        sessions.set(session, { serverId, server });
        return Promise.resolve({ session, program: `/fake/${serverId}` });
      }
      if (command === "lsp_send") {
        const found = sessions.get(Number(args.session));
        if (!found) return Promise.reject("The language server has stopped.");
        setTimeout(() => found.server.receive(String(args.message)), 0);
        return Promise.resolve(null);
      }
      if (command === "lsp_stop") {
        const found = sessions.get(Number(args.session));
        found?.server.crash(0);
        return Promise.resolve(null);
      }
      if (command === "lsp_stop_all") {
        control.lifecycle.push("lsp_stop_all");
        for (const found of sessions.values()) found.server.crash(0);
        return Promise.resolve(null);
      }
      // The bottom panel (where Problems is) asks for these; the shared fixture does not know them.
      if (
        command === "terminal_shells" ||
        command === "available_checkers" ||
        command === "list_listening_ports"
      )
        return Promise.resolve([]);
      if (command === "is_read_only")
        return Promise.resolve(
          (config.readOnly ?? []).some((name) => String(args.path).endsWith(`/${name}`)),
        );
      return undefined;
    };
    let internals: { invoke: Invoke } | undefined;
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      get: () => internals,
      set(value: { invoke: Invoke }) {
        const invoke = value.invoke;
        internals = {
          ...value,
          invoke: (command: string, args: Record<string, unknown> = {}) =>
            answer(command, args) ?? invoke(command, args),
        };
      },
    });
  }, setup);
}

/** Runs `script` against the page's fake servers (`window.__lsp`). */
export const withLsp = <T>(page: Page, script: string, arg?: unknown): Promise<T> =>
  page.evaluate(
    ([body, value]) => {
      const lsp = (window as unknown as { __lsp: unknown }).__lsp;
      return new Function("lsp", "value", `return (${body})(lsp, value);`)(lsp, value);
    },
    [script, arg] as const,
  );
