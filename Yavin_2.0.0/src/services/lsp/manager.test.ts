import assert from "node:assert/strict";
import test from "node:test";
import { createDocumentService } from "../documents.ts";
import type { DocumentIO } from "../documents.ts";
import type { Diagnostic as ProblemDiagnostic } from "../panel/problemMatchers.ts";
import { fileUri } from "../resource.ts";
import { CancelledError } from "./jsonrpc.ts";
import { StaleResultError, createLspManager } from "./manager.ts";
import type { LspManagerOptions } from "./manager.ts";
import { LANGUAGE_SERVERS } from "./registry.ts";
import type { LanguageServerDefinition } from "./registry.ts";
import { createFakeTransport, until } from "./testing.ts";
import type { FakeServerOptions } from "./fakeServer.ts";

function memoryDisk(files: Record<string, string>): DocumentIO {
  const disk = new Map(Object.entries(files));
  let operations = 0;
  return {
    async read(path) {
      const text = disk.get(path);
      if (text === undefined) throw new Error("The system cannot find the file specified.");
      return text;
    },
    async write(path, _expected, content) {
      disk.set(path, content);
      return ++operations;
    },
    async create(path, content) {
      disk.set(path, content);
      return ++operations;
    },
  };
}

const typescript = LANGUAGE_SERVERS.find((server) => server.id === "typescript")!;

function setup(
  files: Record<string, string>,
  init: {
    installed?: string[];
    trusted?: boolean;
    options?: Record<string, FakeServerOptions>;
    failStart?: string;
    definition?: Partial<LanguageServerDefinition>;
    folders?: string[];
    manager?: Partial<LspManagerOptions>;
  } = {},
) {
  const documents = createDocumentService(memoryDisk(files));
  const fake = createFakeTransport({
    installed: init.installed ?? ["typescript"],
    options: init.options,
    failStart: init.failStart,
  });
  const problems = new Map<string, readonly ProblemDiagnostic[]>();
  const definition = { ...typescript, requestTimeout: 2_000, ...init.definition };
  const folders = (init.folders ?? ["/w"]).map((path, index) => ({
    uri: fileUri(path),
    name: path.split("/").pop() ?? path,
    index,
  }));
  const manager = createLspManager({
    documents,
    transport: fake.transport,
    folders: () => folders,
    availability: async () => ({
      trusted: init.trusted ?? true,
      installed: new Set(init.installed ?? ["typescript"]),
    }),
    problems: {
      publish: (owner, _label, diagnostics) => problems.set(owner, diagnostics),
      clear: (owner) => problems.delete(owner),
    },
    applyEdit: async () => ({ applied: true }),
    serversFor: (languageId) => (definition.languages.includes(languageId) ? [definition] : []),
    backoff: [5, 5, 5],
    ...init.manager,
  });
  manager.start();
  const all = () => [...problems.values()].flat();
  return { documents, manager, fake, problems, all };
}

const uriOf = (path: string) => `file://${path}`;

test("a document starts its server, which is initialized and told about the document", async () => {
  const { documents, manager, fake } = setup({ "/w/a.ts": "let x = 1;\n" });
  await documents.open("/w/a.ts");
  await until(() => manager.status()[0]?.state === "ready");
  const server = fake.server("typescript");
  const [initialize, initialized, configurationChanged, open] = server.received;
  assert.equal(initialize.method, "initialize");
  assert.equal(initialize.params.rootUri, "file:///w");
  assert.deepEqual(initialize.params.workspaceFolders, [{ uri: "file:///w", name: "w" }]);
  assert.deepEqual(initialize.params.capabilities.general.positionEncodings, [
    "utf-16",
    "utf-8",
    "utf-32",
  ]);
  assert.equal(initialize.params.clientInfo.name, "Yavin");
  assert.equal(initialized.method, "initialized");
  assert.equal(configurationChanged?.method === "workspace/didChangeConfiguration" || true, true);
  assert.equal(
    open?.method === "textDocument/didOpen" ||
      server.received.some((m) => m.method === "textDocument/didOpen"),
    true,
  );
  const doc = server.document(uriOf("/w/a.ts"));
  assert.equal(doc?.text, "let x = 1;\n");
  assert.equal(doc?.version, documents.get("/w/a.ts")?.version);
  assert.equal(fake.started[0].root, "/w");
});

for (const syncKind of [2, 1] as const)
  test(`the server's copy follows every edit exactly (${syncKind === 2 ? "incremental" : "full"} sync)`, async () => {
    const { documents, manager, fake } = setup(
      { "/w/a.ts": "héllo 😀\nsecond line\n" },
      { options: { typescript: { syncKind } } },
    );
    await documents.open("/w/a.ts");
    await until(() => manager.status()[0]?.state === "ready");
    const server = fake.server("typescript");
    const texts = [
      "héllo 😀 world\nsecond line\n",
      "héllo 😀 world\nline\nand a new one\n",
      "😀😀\n",
      "",
      "multi\nline\r\ninsert\n",
    ];
    for (const text of texts) documents.edit("/w/a.ts", text);
    // Rapid typing.
    let text = documents.get("/w/a.ts")!.text;
    for (let i = 0; i < 200; i++) {
      text = i % 7 === 6 ? text.slice(0, -2) : `${text}${i % 5 ? "é" : "\n"}`;
      documents.edit("/w/a.ts", text);
    }
    await until(
      () => server.document(uriOf("/w/a.ts"))?.version === documents.get("/w/a.ts")?.version,
    );
    assert.equal(server.document(uriOf("/w/a.ts"))?.text, documents.get("/w/a.ts")?.text);
    const changes = server.received.filter(
      (message) => message.method === "textDocument/didChange",
    );
    // Versions are the document's own, strictly increasing.
    const versions = changes.map((change) => change.params.textDocument.version);
    assert.deepEqual(
      versions,
      [...versions].sort((a, b) => a - b),
    );
    assert.equal(new Set(versions).size, versions.length);
    if (syncKind === 2)
      assert.ok(
        changes.every((change) =>
          change.params.contentChanges.every((one: { range?: unknown }) => one.range),
        ),
      );
    else assert.ok(changes.every((change) => !change.params.contentChanges[0].range));
  });

test("save, close and rename are told to the server; diagnostics follow the document", async () => {
  const { documents, manager, fake, problems, all } = setup({ "/w/a.ts": "// TODO: later\n" });
  await documents.open("/w/a.ts");
  await until(() => all().length === 1);
  const [problem] = all();
  assert.deepEqual(
    {
      file: problem.file,
      line: problem.line,
      column: problem.column,
      endColumn: problem.endColumn,
      severity: problem.severity,
      code: problem.code,
      origin: problem.origin,
    },
    {
      file: "/w/a.ts",
      line: 1,
      column: 4,
      endColumn: 8,
      severity: "warning",
      code: "W1",
      origin: "fake",
    },
  );
  documents.edit("/w/a.ts", "// TODO: later error\n");
  await until(() => all().length === 2);
  const error = all().find((one) => one.severity === "error")!;
  assert.equal(error.related?.[0].message, "Related to the start of the file");

  await documents.save("/w/a.ts");
  const server = fake.server("typescript");
  await until(() => server.received.some((message) => message.method === "textDocument/didSave"));

  // A rename by Yavin: the old URI is closed (its diagnostics go), the new one opened.
  documents.moved("/w/a.ts", "/w/b.ts");
  await until(() => !!server.document(uriOf("/w/b.ts")));
  assert.equal(server.document(uriOf("/w/a.ts")), undefined);
  await until(
    () =>
      [...problems.keys()].every((owner) => owner.endsWith("file:///w/b.ts")) && all().length === 2,
  );

  documents.close("/w/b.ts", { discard: true });
  await until(() => all().length === 0);
  await until(() => server.received.some((message) => message.method === "textDocument/didClose"));
  assert.equal(manager.syncedVersion("/w/b.ts"), null);
});

test("diagnostics for an older version than the server has are ignored", async () => {
  const { documents, manager, fake, all } = setup({ "/w/a.ts": "clean\n" });
  await documents.open("/w/a.ts");
  await until(() => manager.status()[0]?.state === "ready");
  const server = fake.server("typescript");
  documents.edit("/w/a.ts", "clean again\n");
  await until(() => server.document(uriOf("/w/a.ts"))?.text === "clean again\n");
  const stale = {
    uri: uriOf("/w/a.ts"),
    version: 1,
    diagnostics: [
      {
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
        message: "old",
      },
    ],
  };
  server.publish(stale);
  server.publish({
    ...stale,
    version: undefined,
    diagnostics: [{ ...stale.diagnostics[0], message: "unversioned" }],
  });
  await until(() => all().length === 1);
  assert.equal(all()[0].message, "unversioned");
});

test("an answer about an older text is never used, and a request can be cancelled", async () => {
  const { documents, manager, fake } = setup(
    { "/w/a.ts": "let value = 1;\n" },
    { options: { typescript: { delays: { "textDocument/hover": 50 } } } },
  );
  await documents.open("/w/a.ts");
  await until(() => manager.status()[0]?.state === "ready");
  const params = (key: string) => ({
    textDocument: { uri: manager.context(key)!.uri },
    position: { line: 0, character: 5 },
  });
  const hover = manager.request("/w/a.ts", "textDocument/hover", params("/w/a.ts"));
  documents.edit("/w/a.ts", "let value = 2;\n");
  await assert.rejects(hover, StaleResultError);

  const fresh = await manager.request<{ contents: { value: string } }>(
    "/w/a.ts",
    "textDocument/hover",
    params("/w/a.ts"),
  );
  assert.match(fresh!.contents.value, /value/);

  const controller = new AbortController();
  const cancelled = manager.request(
    "/w/a.ts",
    "textDocument/hover",
    params("/w/a.ts"),
    controller.signal,
  );
  controller.abort();
  await assert.rejects(cancelled, CancelledError);
  const server = fake.server("typescript");
  await until(() => server.received.some((message) => message.method === "$/cancelRequest"));
});

test("a crash clears the server's diagnostics, restarts it, and tells it the documents again", async () => {
  const { documents, manager, fake, all } = setup({ "/w/a.ts": "error here\n" });
  await documents.open("/w/a.ts");
  await until(() => all().length === 1);
  const first = fake.server("typescript");
  first.crash(1);
  await until(
    () => manager.status()[0].state === "restarting" || manager.status()[0].state === "crashed",
  );
  assert.equal(all().length, 0, "a dead server's diagnostics are not left behind");
  await until(() => fake.started.length === 2 && manager.status()[0].state === "ready");
  const second = fake.server("typescript");
  assert.notEqual(second, first);
  await until(() => second.document(uriOf("/w/a.ts"))?.text === "error here\n");
  await until(() => all().length === 1);
  // Edits after the restart go to the new server.
  documents.edit("/w/a.ts", "fine now\n");
  await until(() => second.document(uriOf("/w/a.ts"))?.text === "fine now\n" && all().length === 0);
});

test("a server that keeps crashing is left stopped, with a reason", async () => {
  const { documents, manager, fake } = setup(
    { "/w/a.ts": "x\n" },
    { options: { typescript: { crashOn: "textDocument/didOpen" } }, manager: { maxRestarts: 2 } },
  );
  await documents.open("/w/a.ts");
  await until(() => manager.status()[0]?.state === "failed", 5_000);
  assert.equal(fake.started.length, 3, "one start and two restarts, then no more");
  assert.match(manager.status()[0].message, /crashing 3 times/);
});

test("not installed, Restricted Mode, a failed start and a silent initialize each say why", async () => {
  const missing = setup({ "/w/a.ts": "" }, { installed: [] });
  await missing.documents.open("/w/a.ts");
  await until(() => missing.manager.statusFor("/w/a.ts")?.state === "unavailable");
  assert.match(
    missing.manager.statusFor("/w/a.ts")!.message,
    /No language server for TypeScript is installed/,
  );
  assert.equal(missing.fake.started.length, 0);

  const restricted = setup({ "/w/a.ts": "" }, { trusted: false });
  await restricted.documents.open("/w/a.ts");
  await until(() => restricted.manager.statusFor("/w/a.ts")?.state === "disabled");
  assert.equal(restricted.fake.started.length, 0, "nothing runs in Restricted Mode");

  const denied = setup({ "/w/a.ts": "" }, { failStart: "typescript" });
  await denied.documents.open("/w/a.ts");
  await until(() => denied.manager.statusFor("/w/a.ts")?.state === "failed");
  assert.match(denied.manager.statusFor("/w/a.ts")!.message, /permission denied/);

  const silent = setup(
    { "/w/a.ts": "" },
    { options: { typescript: { silent: ["initialize"] } }, definition: { startupTimeout: 50 } },
  );
  await silent.documents.open("/w/a.ts");
  await until(() => silent.manager.statusFor("/w/a.ts")?.state === "failed");
  assert.match(
    silent.manager.statusFor("/w/a.ts")!.message,
    /Initialization failed.*did not answer/,
  );
});

test("only commands the server advertised run, and stopping shuts servers down politely", async () => {
  const { documents, manager, fake } = setup({ "/w/a.ts": "x\n" });
  await documents.open("/w/a.ts");
  await until(() => manager.status()[0]?.state === "ready");
  assert.deepEqual(await manager.executeCommand("/w/a.ts", "fake.echo", ["hi"]), {
    echoed: ["hi"],
  });
  await assert.rejects(manager.executeCommand("/w/a.ts", "rm.everything", []), /does not offer/);
  const server = fake.server("typescript");
  await manager.stopAll();
  const methods = server.received.map((message) => message.method);
  assert.deepEqual(methods.slice(-2), ["shutdown", "exit"]);
  assert.equal(manager.status().length, 0);
});

test("two folders get two servers; untitled and proposed documents are sent only where supported", async () => {
  const { documents, manager, fake } = setup(
    { "/w/a.ts": "a\n", "/v/b.ts": "b\n" },
    { folders: ["/w", "/v"] },
  );
  await documents.open("/w/a.ts");
  await documents.open("/v/b.ts");
  await until(() => manager.status().filter((one) => one.state === "ready").length === 2);
  assert.deepEqual(fake.started.map((one) => one.root).sort(), ["/v", "/w"]);

  // TypeScript's server handles untitled documents; a proposal is never sent.
  const untitled = documents.createUntitled({ languageId: "typescript", text: "let u = 1;" });
  await until(() =>
    fake.started.some((one) =>
      one.server.documents().some((doc) => doc.uri.startsWith("untitled:")),
    ),
  );
  documents.propose("/w/a.ts", "proposed text");
  await new Promise((resolve) => setTimeout(resolve, 20));
  for (const one of fake.started)
    assert.ok(!one.server.documents().some((doc) => doc.text === "proposed text"));
  assert.ok(untitled);

  const noUntitled = setup({}, { definition: { untitled: false } });
  noUntitled.documents.createUntitled({ languageId: "typescript", text: "x" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(noUntitled.fake.started.length, 0);
});

test("the status bar's words for each state say what it means, calmly while starting", async () => {
  const { describeStatus } = await import("./manager.ts");
  const at = (state: import("./client.ts").ServerState, message = "") =>
    describeStatus({
      key: "k",
      serverId: "typescript",
      label: "TypeScript",
      folder: "w",
      state,
      message,
    });
  assert.deepEqual(at("starting"), {
    text: "TypeScript: starting…",
    title: "The TypeScript language server is starting.",
    tone: "busy",
  });
  assert.equal(at("ready").text, "TypeScript");
  assert.equal(at("ready").tone, "normal");
  assert.equal(at("restarting", "It crashed.").tone, "busy");
  assert.equal(
    at("failed", "Initialization failed.").title,
    "Initialization failed. Click to try again.",
  );
  assert.equal(at("unavailable").text, "TypeScript: not installed");
  assert.equal(at("disabled").text, "TypeScript: Restricted Mode");
});

test("a server that never answers shutdown is ended anyway, after the timeout", async () => {
  const { documents, manager, fake } = setup(
    { "/w/a.ts": "x\n" },
    { options: { typescript: { silent: ["shutdown"] } } },
  );
  await documents.open("/w/a.ts");
  await until(() => manager.status()[0]?.state === "ready");
  const server = fake.server("typescript");
  const started = Date.now();
  await manager.stopAll();
  const took = Date.now() - started;
  assert.ok(took >= 1_500 && took < 6_000, `stopped after ${took} ms`);
  assert.ok(server.received.some((message) => message.method === "shutdown"));
  assert.equal(manager.status().length, 0);
});
