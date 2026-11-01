import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { createDocumentService } from "../documents.ts";
import type { Diagnostic as ProblemDiagnostic } from "../panel/problemMatchers.ts";
import { fileUri } from "../resource.ts";
import type { ServerTransport } from "./client.ts";
import { createLspManager } from "./manager.ts";
import { LineIndex } from "./positions.ts";
import type { Hover, Location, WorkspaceEdit } from "./protocol.ts";
import { LANGUAGE_SERVERS } from "./registry.ts";
import { until } from "./testing.ts";
import { lspPath } from "./uris.ts";

/**
 * The client and manager against a real language server: `typescript-language-server` (a
 * pinned dev dependency, with the project's own TypeScript), run as a process with the same
 * Content-Length framing the native side does. What the fake server cannot show: that a real
 * server accepts Yavin's initialize, URIs and document sync, and answers in shapes Yavin
 * understands. Skipped where the server is not installed.
 */

const entry = resolve("node_modules/typescript-language-server/lib/cli.mjs");
const installed = existsSync(entry);

/** Starts the real server over stdio, framing messages as `src-tauri`'s `lsp_framing` does. */
const nodeTransport: ServerTransport = {
  async start(_serverId, root) {
    const child = spawn(process.execPath, [entry, "--stdio"], {
      cwd: root,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const listeners = new Set<(message: string) => void>();
    const closers = new Set<(reason: string) => void>();
    let buffer = Buffer.alloc(0);
    child.stdout.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        const end = buffer.indexOf("\r\n\r\n");
        if (end < 0) return;
        const length = Number(
          /Content-Length: *(\d+)/i.exec(buffer.subarray(0, end).toString())?.[1],
        );
        if (buffer.length < end + 4 + length) return;
        const message = buffer.subarray(end + 4, end + 4 + length).toString("utf8");
        buffer = buffer.subarray(end + 4 + length);
        for (const listener of listeners) listener(message);
      }
    });
    child.stderr.resume();
    child.on("exit", (code) => {
      for (const closer of closers) closer(`The language server exited with code ${code}.`);
    });
    return {
      program: entry,
      send(message) {
        const body = Buffer.from(message, "utf8");
        child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
        child.stdin.write(body);
      },
      onMessage(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      onClose(listener) {
        closers.add(listener);
        return () => closers.delete(listener);
      },
      stop() {
        if (child.exitCode === null) child.kill();
      },
    };
  },
};

test(
  "a real server: initialize, sync, diagnostics, completion, hover, definition, rename",
  { skip: !installed && "typescript-language-server is not installed", timeout: 120_000 },
  async () => {
    const dir = (await mkdtemp(join(tmpdir(), "yavin-lsp-"))).replace(/\\/g, "/");
    try {
      await writeFile(
        `${dir}/tsconfig.json`,
        JSON.stringify({ compilerOptions: { strict: true, target: "es2022", module: "esnext" } }),
      );
      await writeFile(
        `${dir}/shapes.ts`,
        "export interface Shape {\n  area(): number;\n}\nexport function describe(shape: Shape): string {\n  return `area ${shape.area()}`;\n}\n",
      );
      const main = `${dir}/main.ts`;
      await writeFile(
        main,
        'import { describe } from "./shapes";\nconst text: number = describe({ area: () => 2 });\n',
      );

      let operation = 0;
      const documents = createDocumentService({
        read: (path) => readFile(path, "utf8"),
        async write(path, _expected, content) {
          await writeFile(path, content);
          return ++operation;
        },
        async create(path, content) {
          await writeFile(path, content);
          return ++operation;
        },
      });
      const problems = new Map<string, readonly ProblemDiagnostic[]>();
      const typescript = LANGUAGE_SERVERS.find((server) => server.id === "typescript")!;
      const manager = createLspManager({
        documents,
        transport: nodeTransport,
        folders: () => [{ uri: fileUri(dir), name: "work", index: 0 }],
        availability: async () => ({ trusted: true, installed: new Set(["typescript"]) }),
        problems: {
          publish: (owner, _label, diagnostics) => problems.set(owner, diagnostics),
          clear: (owner) => problems.delete(owner),
        },
        applyEdit: async () => ({ applied: true }),
        serversFor: (languageId) =>
          typescript.languages.includes(languageId)
            ? [{ ...typescript, requestTimeout: 60_000 }]
            : [],
      });
      manager.start();
      try {
        await documents.open(main);
        const key = documents.get(main)!.key;
        await until(() => manager.status()[0]?.state === "ready", 60_000);
        const context = manager.context(key)!;
        assert.equal(context.encoding, "utf-16");
        assert.ok(manager.capabilities(key)?.completionProvider, "it offers completion");

        // Diagnostics for the document as Yavin sent it: a string is not a number.
        await until(() => [...problems.values()].flat().length > 0, 60_000);
        const [error] = [...problems.values()].flat();
        assert.match(error.message, /string.*number/i);
        assert.equal(error.line, 2);

        // Positions are the document's, in UTF-16.
        const text = () => documents.get(main)!.text;
        const at = (needle: string, delta = 0) =>
          new LineIndex(text()).positionAt(text().indexOf(needle) + delta);
        const textDocument = { uri: context.uri };

        const hover = await manager.request<Hover>(key, "textDocument/hover", {
          textDocument,
          position: at("describe({"),
        });
        assert.match(JSON.stringify(hover?.contents), /describe\(shape: Shape\): string/);

        const definition = await manager.request<Location | Location[]>(
          key,
          "textDocument/definition",
          { textDocument, position: at("describe({") },
        );
        const target = [definition].flat()[0] as Location & { targetUri?: string };
        assert.equal(
          lspPath(target.targetUri ?? target.uri)?.toLowerCase(),
          `${dir}/shapes.ts`.toLowerCase(),
        );

        // An edit reaches the server incrementally: completion sees the new text.
        documents.edit(main, `${text()}const n = Math.\n`);
        const completion = await manager.request<
          { items: { label: string }[] } | { label: string }[]
        >(key, "textDocument/completion", {
          textDocument,
          position: at("Math.", 5),
          context: { triggerKind: 2, triggerCharacter: "." },
        });
        const labels = (Array.isArray(completion) ? completion : (completion?.items ?? [])).map(
          (item) => item.label,
        );
        assert.ok(labels.includes("floor"), `Math. offers floor (got ${labels.length} items)`);

        // Rename across files, from the declaration (at an import, TypeScript renames only
        // the local name): an edit Yavin's engine can apply.
        const shapes = `${dir}/shapes.ts`;
        await documents.open(shapes);
        const shapesKey = documents.get(shapes)!.key;
        await until(() => manager.context(shapesKey) !== null, 30_000);
        const shapesText = documents.get(shapes)!.text;
        const rename = await manager.request<WorkspaceEdit>(shapesKey, "textDocument/rename", {
          textDocument: { uri: manager.context(shapesKey)!.uri },
          position: new LineIndex(shapesText).positionAt(shapesText.indexOf("describe(")),
          newName: "summarize",
        });
        const files = [
          ...Object.keys(rename?.changes ?? {}),
          ...(rename?.documentChanges ?? []).map((change) =>
            "textDocument" in change ? change.textDocument.uri : "",
          ),
        ].map((uri) => lspPath(uri)?.toLowerCase());
        assert.deepEqual(
          [...new Set(files)].sort(),
          [`${dir}/main.ts`, `${dir}/shapes.ts`].map((path) => path.toLowerCase()).sort(),
        );
      } finally {
        await manager.dispose();
      }
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  },
);
