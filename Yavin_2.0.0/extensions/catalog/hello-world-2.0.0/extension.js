// The Hello World sample extension (IDE-08). It runs in Yavin's extension host -- QuickJS in a
// process of its own -- and reaches Yavin only through `yavin`, the extension API.
module.exports.activate = function (context, yavin) {
  const state = context.workspaceState || context.globalState;
  const greetings = () => state.get("greetings") || [];
  const listeners = new Set();
  const changed = () => listeners.forEach((listener) => listener());

  context.subscriptions.push(
    yavin.commands.registerCommand("yavin-samples.hello-world.greet", async () => {
      const name = yavin.workspace.getConfiguration("yavin-samples.hello-world").get("name");
      const greeting = `Hello, ${name || "world"}!`;
      await state.update("greetings", greetings().concat([greeting]).slice(-20));
      yavin.window.showInformationMessage(greeting);
      changed();
      return greeting;
    }),
    yavin.commands.registerCommand("yavin-samples.hello-world.reset", async () => {
      await state.update("greetings", undefined);
      changed();
    }),
    yavin.commands.registerCommand("yavin-samples.hello-world.describe", async () => {
      const active = await yavin.editor.activeEditor();
      if (!active) {
        yavin.window.showWarningMessage("No file is open.");
        return null;
      }
      const text = (await yavin.documents.getText(active.document.uri)) || "";
      const summary = `${active.document.languageId}, ${text.split("\n").length} lines`;
      yavin.window.showInformationMessage(summary);
      return summary;
    }),
    yavin.views.registerView("yavin-samples.hello-world.greetings", {
      getItems: () =>
        greetings().length
          ? greetings().map((label, index) => ({ label, description: `#${index + 1}` }))
          : [{ label: "No greetings yet", command: "yavin-samples.hello-world.greet" }],
      onDidChange(listener) {
        listeners.add(listener);
        return { dispose: () => listeners.delete(listener) };
      },
    }),
    yavin.views.registerView("yavin-samples.hello-world.about", {
      getItems: () => [
        {
          label: "A sample extension",
          children: [
            { label: `API ${yavin.version}` },
            { label: `Host generation ${context.environment.hostGeneration}` },
          ],
        },
      ],
    }),
    yavin.languages.registerHoverProvider("markdown", {
      provideHover(document, position) {
        return {
          contents: `Hello from the sample (line ${position.line} of ${document.uri.split("/").pop()})`,
        };
      },
    }),
  );
  context.log.info(`Activated in ${context.workspaceFolder || "no folder"}.`);
};

module.exports.deactivate = function () {};
