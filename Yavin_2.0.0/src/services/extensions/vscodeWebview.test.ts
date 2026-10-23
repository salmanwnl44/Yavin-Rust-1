/**
 * EXT-31: VS Code webview panels -- behaviourally, on the window side: the probe extension runs
 * in Yavin's real host (`host.ts`) through the real layer (`vscode.js`), against the real webview
 * store (`webviews.ts`) over a native side that records what it is asked, and frames played as the
 * window holds them (`testing/vscodeHarness.ts`). The native side itself (the page, its policy,
 * files, ownership, navigation) is tested in Rust, and the frame's isolation in the packaged app.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { ID, vscodeWorld } from "./testing/vscodeHarness.ts";
import { MAX_MESSAGE, MAX_PANELS_PER_EXTENSION } from "./webviews.ts";

const OTHER = "acme.other";

async function ready() {
  const w = vscodeWorld();
  w.install();
  return w;
}

async function waitFor(condition: () => boolean, what: string, ms = 3000) {
  const until = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > until) assert.fail(`timed out waiting: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

/** Opens a panel in the probe (kept as `T.p`) and waits for the window to have it. */
async function panel(
  w: Awaited<ReturnType<typeof ready>>,
  options = "{ enableScripts: true }",
  from = ID,
) {
  const before = w.webviews.getSnapshot().length;
  await w.step(
    `T.p = vscode.window.createWebviewPanel("probe.view", "Probe view", vscode.ViewColumn.One, ${options});
     T.got = []; T.states = []; T.disposed = 0;
     T.p.webview.onDidReceiveMessage((m) => T.got.push(m));
     T.p.onDidChangeViewState((e) => T.states.push([e.webviewPanel.visible, e.webviewPanel.active]));
     T.p.onDidDispose(() => T.disposed++);`,
    from,
  );
  await waitFor(() => w.webviews.getSnapshot().length > before, "the panel");
  return w.webviews.getSnapshot().find((one) => one.extensionId === from)!;
}

test("a panel is a tab of its own, its page registered natively under a fresh token", async (t) => {
  const w = await ready();
  t.after(() => w.manager.dispose());
  const shown = await panel(w);
  assert.match(shown.id, new RegExp(`^${ID.replace(".", "\\.")}#webview#\\d+$`));
  assert.equal(shown.title, "Probe view");
  assert.equal(shown.viewType, "probe.view");
  assert.equal(shown.extensionName, "Probe probe");
  assert.equal(shown.scripts, true);
  const [opened] = w.webviewNative.opened;
  assert.match(opened.token, /^[0-9a-f]{32}$/);
  assert.equal(opened.extensionId, ID);
  assert.equal(opened.scripts, true);
  assert.deepEqual(opened.roots, [], "no roots given: the extension's whole copy");
  assert.equal(shown.url, `https://yavin-webview.invalid/${opened.token}/index.html`);
  // Its HTML and title go to the window; its HTML loads the page again.
  await w.step(`T.p.webview.html = "<h1>hello</h1>"; T.p.title = "Renamed";`);
  await waitFor(() => w.webviewNative.updates.some((u) => u.html === "<h1>hello</h1>"), "the HTML");
  await waitFor(() => w.webviews.getSnapshot()[0].title === "Renamed", "the title");
  assert.equal(w.webviews.getSnapshot()[0].revision, 1);
  assert.equal(await w.step("return T.p.webview.html;"), "<h1>hello</h1>");
  // Two panels never share a token.
  await w.step(`T.q = vscode.window.createWebviewPanel("probe.second", "Second", 1, {});`);
  await waitFor(() => w.webviewNative.opened.length === 2, "the second panel");
  assert.notEqual(w.webviewNative.opened[0].token, w.webviewNative.opened[1].token);
  assert.equal(w.webviewNative.opened[1].scripts, false, "scripts only when enabled");
});

test("messages pass both ways, JSON only and bounded; before the page is ready they wait", async (t) => {
  const w = await ready();
  t.after(() => w.manager.dispose());
  const shown = await panel(w);
  w.webviews.setShown(shown.id);
  // Not ready yet: the message waits for the page, and is delivered when it says it is ready.
  const frame = w.frame(shown.id, false);
  assert.equal(await w.step(`return await T.p.webview.postMessage({ hello: [1, 2] });`), true);
  assert.deepEqual(frame.received, []);
  // Nor is the frame heard before our page says it is ready (whatever it holds is not yet ours).
  frame.post("message", "too early");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(await w.step("return T.got;"), [], "not heard before ready");
  frame.post("ready", null);
  assert.deepEqual(frame.received, [{ hello: [1, 2] }]);
  assert.equal(await w.step(`return await T.p.webview.postMessage("again");`), true);
  assert.deepEqual(frame.received.at(-1), "again");
  // The page's messages reach the extension's listener.
  frame.post("message", { from: "page", n: 7 });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(await w.step("return T.got;"), [{ from: "page", n: 7 }]);
  // Too large either way: refused from the extension, dropped (and said) from the page.
  const big = "x".repeat(MAX_MESSAGE);
  assert.match(
    String(
      await w.step(
        `try { await T.p.webview.postMessage("${big.slice(0, 10)}".repeat(${MAX_MESSAGE / 10 + 1})); return "sent"; } catch (e) { return e.message; }`,
      ),
    ),
    /at most 1024 KiB/,
  );
  frame.post("message", big);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal((await w.step("return T.got.length;")) as number, 1, "dropped");
  assert.match(w.webviewWarnings.join("\n"), /not JSON or was over 1024 KiB/);
  // Something not of the bootstrap's shape is ignored.
  w.webviews.frameMessage(shown.id, { kind: "message", payload: "no marker" });
  w.webviews.frameMessage(shown.id, "plain string");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal((await w.step("return T.got.length;")) as number, 1);
});

test("a page that floods the window is cut off at 500 messages a second, and said once", async (t) => {
  const w = await ready();
  t.after(() => w.manager.dispose());
  const shown = await panel(w);
  w.webviews.setShown(shown.id);
  const frame = w.frame(shown.id);
  for (let i = 0; i < 700; i++) frame.post("message", i);
  await waitFor(() => w.webviewWarnings.length > 0, "the warning");
  await new Promise((resolve) => setTimeout(resolve, 100));
  const got = (await w.step("return T.got.length;")) as number;
  assert.ok(got <= 500 && got >= 400, `${got} delivered`);
  assert.equal(w.webviewWarnings.filter((x) => /500 messages a second/.test(x)).length, 1);
});

test("setState is kept for the page's next load, bounded and JSON", async (t) => {
  const w = await ready();
  t.after(() => w.manager.dispose());
  const shown = await panel(w);
  w.webviews.setShown(shown.id);
  const frame = w.frame(shown.id);
  frame.post("state", { scroll: 42 });
  assert.equal(w.webviews.stateOf(shown.id), '{"scroll":42}');
  await waitFor(
    () => w.webviewNative.updates.some((u) => u.setState && u.state === '{"scroll":42}'),
    "kept natively",
  );
  frame.post("state", { big: "x".repeat(300 * 1024) });
  assert.equal(w.webviews.stateOf(shown.id), '{"scroll":42}', "too large: not kept");
  assert.match(w.webviewWarnings.join("\n"), /state that was not JSON or was over 256 KiB/);
});

test("view state follows the tab in front; closing the tab disposes the panel and the extension hears it", async (t) => {
  const w = await ready();
  t.after(() => w.manager.dispose());
  const shown = await panel(w);
  w.webviews.setShown(shown.id);
  await new Promise((resolve) => setTimeout(resolve, 20));
  w.webviews.setShown(null);
  await new Promise((resolve) => setTimeout(resolve, 20));
  // Created visible and active (as in VS Code): only hiding it is a change.
  assert.deepEqual(await w.step("return [T.states, T.p.visible, T.p.active];"), [
    [[false, false]],
    false,
    false,
  ]);
  w.webviews.setShown(shown.id);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(await w.step("return T.states.at(-1);"), [true, true]);
  w.webviews.setShown(null);
  // Hidden and not kept alive: a message is not delivered (as VS Code).
  assert.equal(await w.step(`return await T.p.webview.postMessage("lost");`), false);
  w.webviews.closeFromWindow(shown.id);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(await w.step("return T.disposed;"), 1);
  assert.equal(w.webviews.getSnapshot().length, 0);
  assert.deepEqual(w.webviewNative.closed, [w.webviewNative.opened[0].token]);
  assert.equal(
    await w.step(`return await T.p.webview.postMessage("after");`),
    false,
    "a disposed panel takes nothing",
  );
});

test("the extension disposing its panel closes it natively; reveal brings it to the front", async (t) => {
  const w = await ready();
  t.after(() => w.manager.dispose());
  const shown = await panel(w);
  const revealed = shown.revealed;
  await w.step("T.p.reveal(vscode.ViewColumn.One, true);");
  await waitFor(() => w.webviews.getSnapshot()[0].revealed === revealed + 1, "the reveal");
  assert.equal(w.webviews.getSnapshot()[0].focus, false, "preserveFocus said");
  await w.step("T.p.dispose(); T.p.dispose();");
  await waitFor(() => w.webviews.getSnapshot().length === 0, "gone");
  assert.equal(await w.step("return T.disposed;"), 1, "onDidDispose once");
  assert.equal(w.webviewNative.closed.length, 1);
});

test("one extension's panel is not another's: messages reach only the owner, and nothing of it can be touched", async (t) => {
  const w = await ready();
  t.after(() => w.manager.dispose());
  w.install(OTHER);
  // Both activated first: the in-process host shares one realm, and a probe's activation resets
  // the shared `T`.
  await w.step("return 1;", OTHER);
  await w.step("return 1;");
  const theirs = await panel(w, "{ enableScripts: true }", OTHER);
  await w.step(`T.theirGot = T.got; T.theirP = T.p;`, OTHER);
  const mine = await panel(w);
  w.webviews.setShown(mine.id);
  const frame = w.frame(mine.id);
  frame.post("message", "to the probe");
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(await w.step("return [T.got, T.theirGot];"), [["to the probe"], []]);
  // Not sent to the other at all (its layer would drop a message for a panel it does not own,
  // but the message must not reach it): every webview event the window sent went to its owner.
  const mineSent = w.sentEvents.filter((sent) => sent.id === mine.id);
  assert.ok(mineSent.some((sent) => sent.event === "webview.message"));
  assert.deepEqual(
    mineSent.filter((sent) => sent.extensionId !== ID),
    [],
    "nothing of my panel was sent to the other extension",
  );
  // The store refuses another owner outright (the permission checks refuse the id before it).
  for (const act of [
    () => w.webviews.postMessage(theirs.id, ID, "x"),
    () => w.webviews.reveal(theirs.id, ID, false),
  ])
    assert.throws(act, /No such webview panel of this extension/);
  await assert.rejects(
    w.webviews.update(theirs.id, ID, { html: "<p>mine now</p>" }),
    /No such webview panel of this extension/,
  );
  assert.ok(!w.webviewNative.updates.some((u) => u.html === "<p>mine now</p>"));
  w.webviews.dispose(theirs.id, ID);
  assert.ok(
    w.webviews.getSnapshot().some((one) => one.id === theirs.id),
    "not disposed by another",
  );
  // A frame of one panel cannot speak for another: its messages are its own panel's.
  w.webviews.frameMessage(theirs.id, { yavinWebview: 1, kind: "message", payload: "forged" });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(
    await w.step("return T.theirGot;"),
    [],
    "no frame attached to theirs: nothing taken",
  );
});

test("an extension that stops (or crashes) takes its panels away, natively too, silently", async (t) => {
  const w = await ready();
  t.after(() => w.manager.dispose());
  await panel(w);
  await w.step(`vscode.window.createWebviewPanel("probe.b", "B", 1, {});`);
  await waitFor(() => w.webviews.getSnapshot().length === 2, "two panels");
  await w.manager.restart();
  assert.equal(w.webviews.getSnapshot().length, 0);
  assert.equal(w.webviewNative.closed.length, 2);
});

test("asWebviewUri serves the extension's own files only; roots outside it serve nothing", async (t) => {
  const w = await ready();
  t.after(() => w.manager.dispose());
  await panel(
    w,
    `{ enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(T.context.extensionUri, "media"), vscode.Uri.file("C:/Windows")] }`,
  );
  const token = w.webviewNative.opened[0].token;
  assert.deepEqual(w.webviewNative.opened[0].roots, ["extension/media"], "the root inside it kept");
  const [inside, outside, csp] = (await w.step(
    `return [T.p.webview.asWebviewUri(vscode.Uri.joinPath(T.context.extensionUri, "media", "app main.js")).toString(),
             T.p.webview.asWebviewUri(vscode.Uri.file("C:/Users/me/secret.txt")).toString(),
             T.p.webview.cspSource];`,
  )) as string[];
  assert.equal(inside, `https://yavin-webview.invalid/${token}/res/extension/media/app%20main.js`);
  assert.equal(outside, `https://yavin-webview.invalid/${token}/outside`);
  assert.equal(csp, "https://yavin-webview.invalid");
  // Only roots outside: nothing served (never the whole copy).
  await w.step(
    `T.only = vscode.window.createWebviewPanel("probe.o", "O", 1, { localResourceRoots: [vscode.Uri.file("D:/elsewhere")] });`,
  );
  await waitFor(() => w.webviewNative.opened.length === 2, "the second panel");
  assert.deepEqual(w.webviewNative.opened[1].roots, [".yavin-none"]);
  assert.match(
    (w.logs.get(ID) ?? []).join("\n"),
    /resource root outside the extension serves nothing/,
  );
});

test("what Yavin does not do is said, not pretended; panels are bounded per extension", async (t) => {
  const w = await ready();
  t.after(() => w.manager.dispose());
  await panel(
    w,
    "{ enableScripts: true, enableCommandUris: true, portMapping: [{ webviewPort: 1, extensionHostPort: 2 }] }",
  );
  const logs = (w.logs.get(ID) ?? []).join("\n");
  assert.match(logs, /command links \(enableCommandUris\) do nothing/);
  assert.match(logs, /port mapping is not supported/);
  for (let i = 1; i < MAX_PANELS_PER_EXTENSION; i++)
    await w.step(`vscode.window.createWebviewPanel("probe.n${i}", "N", 1, {});`);
  await waitFor(() => w.webviews.getSnapshot().length === MAX_PANELS_PER_EXTENSION, "all panels");
  await w.step(
    `T.extra = vscode.window.createWebviewPanel("probe.extra", "Extra", 1, {}); T.extraGone = 0; T.extra.onDidDispose(() => T.extraGone++);`,
  );
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(w.webviews.getSnapshot().length, MAX_PANELS_PER_EXTENSION);
  assert.equal(await w.step("return T.extraGone;"), 1, "refused by the window: disposed, and said");
  assert.match(
    (w.logs.get(ID) ?? []).join("\n"),
    /could not be shown: At most 16 webview panels per extension/,
  );
});

test("telling the store which tab is in front, again and again, is news only when it changes", async (t) => {
  const w = await ready();
  t.after(() => w.manager.dispose());
  const shown = await panel(w);
  let heard = 0;
  w.webviews.subscribe(() => heard++);
  w.webviews.setShown(shown.id);
  const first = w.webviews.getSnapshot();
  w.webviews.setShown(shown.id);
  w.webviews.setShown(shown.id);
  assert.equal(heard, 1, "one change, one notice");
  assert.equal(w.webviews.getSnapshot(), first, "the same snapshot while nothing changes");
});

test("a frame that loads without our page is served the panel's page again, at most 3 times a minute", async (t) => {
  const w = await ready();
  t.after(() => w.manager.dispose());
  const shown = await panel(w);
  w.webviews.setShown(shown.id);
  const grace = () => new Promise((resolve) => setTimeout(resolve, 40));
  // Our page: it answers the window's ping after its load -- nothing to do.
  const ours = w.frame(shown.id);
  w.webviews.frameLoaded(shown.id);
  const ping = ours.received.at(-1) as { yavinPing: number };
  assert.equal(typeof ping.yavinPing, "number", "the window asks");
  ours.post("pong", ping.yavinPing);
  await grace();
  assert.equal(w.webviews.getSnapshot()[0].revision, 0);
  // A wrong answer is no answer.
  // Something else loaded (WebView2's page for a cancelled navigation): served again.
  for (let i = 1; i <= 3; i++) {
    w.frame(shown.id, false);
    w.webviews.frameLoaded(shown.id);
    await grace();
    assert.equal(w.webviews.getSnapshot()[0].revision, i, `restore ${i}`);
  }
  // A page that keeps leaving is left as it is, and said once.
  w.frame(shown.id, false);
  w.webviews.frameLoaded(shown.id);
  await grace();
  w.webviews.frameLoaded(shown.id);
  await grace();
  assert.equal(w.webviews.getSnapshot()[0].revision, 3);
  assert.equal(w.webviewWarnings.filter((x) => /keeps leaving its page/.test(x)).length, 1);
  assert.equal(w.webviewWarnings.filter((x) => /tried to leave its page/.test(x)).length, 3);
});

test("a frame that loads something else is served its page again; a load of our page, answering the ping, is not", async (t) => {
  const w = await ready();
  t.after(() => w.manager.dispose());
  const shown = await panel(w);
  w.webviews.setShown(shown.id);
  const grace = () => new Promise((resolve) => setTimeout(resolve, 40));
  const frame = w.frame(shown.id);
  // The page goes, and WebView2's own page loads in its place: it answers nothing.
  frame.post("leaving", null);
  w.webviews.frameLoaded(shown.id);
  await grace();
  assert.equal(w.webviews.getSnapshot()[0].revision, 1, "served again");
  assert.match(w.webviewWarnings.join("\n"), /tried to leave its page/);
  // Nothing is sent to a frame that is not our page.
  assert.equal(
    await w.step(`return await T.p.webview.postMessage("to nobody");`),
    true,
    "it waits",
  );
  assert.ok(!frame.received.includes("to nobody"));
  // Yavin's own reload: the new page answers the ping -- nothing more happens.
  const again = w.frame(shown.id);
  w.webviews.frameLoaded(shown.id);
  const ping = again.received.find((m) => (m as { yavinPing?: number })?.yavinPing) as {
    yavinPing: number;
  };
  again.post("pong", ping.yavinPing);
  await grace();
  assert.equal(w.webviews.getSnapshot()[0].revision, 1);
  // An answer to an older ping is no answer.
  const stale = w.frame(shown.id);
  w.webviews.frameLoaded(shown.id);
  stale.post("pong", ping.yavinPing);
  await grace();
  assert.equal(w.webviews.getSnapshot()[0].revision, 2);
});
