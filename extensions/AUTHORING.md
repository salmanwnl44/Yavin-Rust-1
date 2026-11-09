# Writing a Yavin extension

A Yavin extension is a folder with a manifest (`yavin-extension.json`) and, optionally, an entry
script (`extension.js`). The script runs in Yavin's extension host — a QuickJS interpreter in its
own OS-sandboxed process — and reaches the IDE only through the `yavin` API object it is handed.
It never sees Node.js, the filesystem outside the workspace, the shell, or the network.

The shipped samples under `catalog/` and `samples/hello-world/` are complete, working extensions;
read them alongside this guide.

## Layout

```
my-extension/
  yavin-extension.json   # the manifest (required)
  extension.js           # the entry point (required only if the extension runs code)
  README.md              # shown on the extension's page
```

## Manifest

```jsonc
{
  "publisher": "acme", // [a-z0-9-], 1..50
  "name": "demo", // [a-z0-9-], 1..50  -> id is "acme.demo"
  "displayName": "Acme Demo",
  "version": "1.0.0", // strict semver
  "description": "What it does.",
  "engines": { "yavin": "^2.0.0" }, // the extension API range it needs (see below)
  "main": "extension.js", // omit for a declarative (no-code) extension
  "permissions": { "version": 1, "request": ["documents.read"] },
  "activationEvents": ["onCommand:acme.demo.hello", "onLanguage:markdown"],
  "contributes": {
    "commands": [{ "command": "acme.demo.hello", "title": "Say Hello", "category": "Acme" }],
  },
}
```

The manifest is validated the same way at discovery and install. Invalid ids, malformed versions,
a missing/escaping `main`, an unknown or unsatisfiable `engines.yavin`, unknown or duplicate
permissions, and contributions that are not owned by your id are all rejected before the extension
is allowed to run. Everything you contribute (commands, views, settings, …) must be prefixed with
your `publisher.name`.

### API version — `engines.yavin`

`engines.yavin` is a semver range checked against the host's extension-API version (currently
**2.1.0**; see the header of `yavin.d.ts`). Any extension that contains code must declare it. Use
`"^2.0.0"` to accept the 2.x API.

### Activation events

The host loads your extension lazily, the first time one of these fires:

| Event               | Fires when                            |
| ------------------- | ------------------------------------- |
| `onStartupFinished` | the workspace has finished opening    |
| `onWorkspace`       | a workspace is open                   |
| `onCommand:<id>`    | one of your commands is invoked       |
| `onView:<id>`       | one of your views is first shown      |
| `onLanguage:<lang>` | a document of that language is opened |

### Permissions (least privilege)

Declare only what you use under `permissions.request`. A capability you did not declare is denied,
and an unknown capability makes the whole manifest invalid (fail closed). The user reviews and
grants permissions; a grant can be revoked at any time, which stops further use immediately.

| Permission              | Grants                                                  |
| ----------------------- | ------------------------------------------------------- |
| `documents.read`        | read open documents and document events                 |
| `documents.edit`        | make unsaved, undoable edits to open documents          |
| `editor.control`        | move the selection, reveal ranges, set your decorations |
| `workspace.fs.read`     | read workspace-relative files (read only)               |
| `secrets`               | keep your own secrets in the OS credential store        |
| `commands.execute:<id>` | run another extension's command (that extension's id)   |

There is deliberately **no** raw filesystem write, shell, terminal, network, or Node API. Each
`yavin` method enforces its own permission in the host and again natively.

## Entry point

```js
// extension.js — CommonJS; `activate` is called with your context and the API.
module.exports.activate = function (context, yavin) {
  context.subscriptions.push(
    yavin.commands.registerCommand("acme.demo.hello", async () => {
      const name = yavin.workspace.getConfiguration("acme.demo").get("name") || "world";
      await yavin.window.showInformationMessage(`Hello, ${name}!`);
    }),
  );
};

module.exports.deactivate = function () {
  // optional; everything pushed to context.subscriptions is disposed automatically.
};
```

`activate` runs **exactly once** per active instance. Anything you register, subscribe, or time
should be pushed to `context.subscriptions` so it is released on deactivation. An exception thrown
by your code is isolated to your extension — it is reported on your extension's page and never
crashes the IDE or another extension.

### Storage

`context.globalState` and `context.workspaceState` (and `yavin.storage`) are JSON key/value stores
scoped to your extension id — at most 64 KiB per scope. One extension cannot read another's state.
Secrets go through `context.secrets` (the `secrets` permission) and are kept in the OS credential
store, never in settings or state.

## Typed development

`yavin.d.ts` (in this folder) is the full, generated type definition for the API. Point your
editor at it to get autocomplete and type-checking:

```js
/** @type {import("yavin").ExtensionModule} */
module.exports = {
  activate(context, yavin) {
    /* context: ExtensionContext, yavin: YavinApi — both fully typed */
  },
};
```

or, in TypeScript, `import type { ExtensionContext, YavinApi } from "yavin";`. The typings are
derived mechanically from the API contract and are checked in CI to match it, so they never drift.

## Installing locally

Put the extension folder in Yavin's extensions folder (shown in the Extensions view) and reload
extensions, or use the Extensions view to install a package. Discovery validates the manifest,
picks one copy per id, and reports incompatible or unreadable copies without running them.
Extraction of a package is path-contained: an archive can never write outside its own folder or
over another extension's files.
