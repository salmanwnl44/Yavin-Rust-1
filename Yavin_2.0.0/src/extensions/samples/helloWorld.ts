/**
 * A sample extension (IDE-07), bundled only in development and test-hook builds: it exercises
 * the extension API end to end -- a command, a setting, a view, workspace storage -- and is how
 * the UI tests check the extension path. The release build ships no extensions.
 */
import type { ExtensionModule, ViewItem } from "../../services/extensions/api";

export const HELLO_WORLD_MANIFEST = {
  publisher: "yavin-samples",
  name: "hello-world",
  displayName: "Hello World (sample)",
  version: "1.0.0",
  description: "A sample extension that greets, counts its greetings and lists them.",
  engines: { yavin: "^1.0.0" },
  main: "bundled",
  activationEvents: ["onCommand:yavin-samples.hello-world.greet"],
  contributes: {
    commands: [
      { command: "yavin-samples.hello-world.greet", title: "Say Hello", category: "Hello World" },
      {
        command: "yavin-samples.hello-world.reset",
        title: "Reset Greetings",
        category: "Hello World",
      },
    ],
    keybindings: [{ command: "yavin-samples.hello-world.greet", key: "Mod+Alt+h" }],
    configuration: {
      properties: {
        "yavin-samples.hello-world.name": {
          type: "string",
          default: "world",
          description: "Who the sample greets.",
        },
      },
    },
    views: [{ id: "yavin-samples.hello-world.greetings", name: "Greetings", location: "sidebar" }],
    menus: {
      "view/title": [
        {
          command: "yavin-samples.hello-world.reset",
          view: "yavin-samples.hello-world.greetings",
        },
      ],
    },
  },
};

export const helloWorld: ExtensionModule = {
  activate(context, yavin) {
    const state = context.workspaceState ?? context.globalState;
    const greetings = () => state.get<string[]>("greetings") ?? [];
    const listeners = new Set<() => void>();
    const changed = () => listeners.forEach((listener) => listener());
    context.subscriptions.push(
      yavin.commands.registerCommand("yavin-samples.hello-world.greet", async () => {
        const name = yavin.workspace
          .getConfiguration("yavin-samples.hello-world")
          .get<string>("name");
        const greeting = `Hello, ${name ?? "world"}!`;
        await state.update("greetings", [...greetings(), greeting].slice(-20));
        yavin.window.showInformationMessage(greeting);
        changed();
        return greeting;
      }),
      yavin.commands.registerCommand("yavin-samples.hello-world.reset", async () => {
        await state.update("greetings", undefined);
        changed();
      }),
      yavin.views.registerView("yavin-samples.hello-world.greetings", {
        getItems: (): ViewItem[] =>
          greetings().length
            ? greetings().map((label, index) => ({ label, description: `#${index + 1}` }))
            : [{ label: "No greetings yet", command: "yavin-samples.hello-world.greet" }],
        onDidChange(listener) {
          listeners.add(listener);
          return { dispose: () => listeners.delete(listener) };
        },
      }),
    );
    context.log.info(`Activated in ${context.workspaceFolder ?? "no folder"}.`);
  },
};
