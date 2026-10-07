// Word Count: counts the words, lines and characters of the active file, through Yavin's
// extension API (documents and editor) -- it never reads files itself.
module.exports.activate = function (context, yavin) {
  context.subscriptions.push(
    yavin.commands.registerCommand("yavin.word-count.count", async () => {
      const active = await yavin.editor.activeEditor();
      if (!active) {
        yavin.window.showWarningMessage("Open a file to count its words.");
        return null;
      }
      let text = (await yavin.documents.getText(active.document.uri)) || "";
      const lines = text.length ? text.split("\n").length : 0;
      const characters = text.length;
      if (yavin.workspace.getConfiguration("yavin.word-count").get("ignore-markup"))
        text = text.replace(/[#*`>_~-]+/g, " ");
      const words = text.split(/\s+/).filter(Boolean).length;
      const name = active.document.uri.split("/").pop();
      const summary = `${name}: ${words} words, ${lines} lines, ${characters} characters`;
      yavin.window.showInformationMessage(summary);
      return { words, lines, characters };
    }),
  );
};
