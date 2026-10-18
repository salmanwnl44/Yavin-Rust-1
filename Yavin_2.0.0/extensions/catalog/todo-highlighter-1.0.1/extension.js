// TODO Highlighter: marks TODO/FIXME words in open documents with a Yavin decoration style and
// counts them on request. Everything goes through Yavin's extension API.
module.exports.activate = function (context, yavin) {
  const keywords = () =>
    String(yavin.workspace.getConfiguration("yavin.todo-highlighter").get("keywords") || "")
      .split(",")
      .map((word) => word.trim())
      .filter((word) => /^[A-Za-z][A-Za-z0-9_-]*$/.test(word));

  /** Every keyword occurrence in `text`, as 1-based ranges. */
  const find = (text) => {
    const words = keywords();
    if (!words.length) return [];
    const pattern = new RegExp(`\\b(${words.join("|")})\\b`, "g");
    const found = [];
    text.split("\n").forEach((line, index) => {
      for (const match of line.matchAll(pattern))
        found.push({
          range: {
            startLine: index + 1,
            startColumn: match.index + 1,
            endLine: index + 1,
            endColumn: match.index + 1 + match[0].length,
          },
          style: "highlight",
          hover: `${match[0]} (TODO Highlighter)`,
        });
    });
    return found.slice(0, 500);
  };

  const paint = async (uri) => {
    const text = await yavin.documents.getText(uri);
    if (text == null) return;
    await yavin.editor.setDecorations(uri, "todos", find(text));
  };

  context.subscriptions.push(
    yavin.documents.onDidOpen((document) => void paint(document.uri)),
    yavin.documents.onDidChange((document) => void paint(document.uri)),
    yavin.commands.registerCommand("yavin.todo-highlighter.count", async () => {
      const active = await yavin.editor.activeEditor();
      if (!active) {
        yavin.window.showWarningMessage("Open a file to count its TODOs.");
        return 0;
      }
      const count = find((await yavin.documents.getText(active.document.uri)) || "").length;
      yavin.window.showInformationMessage(`${count} TODO${count === 1 ? "" : "s"} in this file.`);
      return count;
    }),
  );
  return yavin.documents.all().then((documents) => Promise.all(documents.map((d) => paint(d.uri))));
};
