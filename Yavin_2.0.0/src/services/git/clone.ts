import { native } from "../native";
import { gitRegistry } from "./registry";
import type { DialogRequest } from "../../components/ui/AppDialog";

/**
 * The folder `git clone` itself would create for a URL: the last segment, without `.git`.
 * Offered as the default so the common case is a paste and two clicks.
 */
export function suggestedCloneFolder(url: string): string {
  return (
    url
      .trim()
      .replace(/\/+$/, "")
      .replace(/\.git$/, "")
      .split(/[/:]/)
      .pop() || "repository"
  );
}

/**
 * "Clone…": ask for the URL, pick the folder to clone into, then open the result like any
 * other repository.
 *
 * It lives here rather than in Source Control because the welcome page offers it too -- it
 * is one of the three things there is to do in a window with no folder open, and it would be
 * odd to have to find the Source Control view first.
 */
export function cloneRepository(
  onDialog: (request: DialogRequest) => void,
  /** Told where the clone landed, for callers that want to open it as the workspace. */
  onCloned?: (root: string) => void,
): void {
  onDialog({
    title: "Clone repository",
    message: "The repository URL to clone from.",
    input: "",
    confirmLabel: "Choose Folder…",
    submit: async (url) => {
      const trimmed = url.trim();
      if (!trimmed) throw new Error("Enter a repository URL.");
      const parent = await native("pick_folder_dialog").catch(() => null);
      if (!parent) return;
      onDialog({
        title: "Folder name",
        message: `Cloning into a new folder inside ${parent}.`,
        input: suggestedCloneFolder(trimmed),
        confirmLabel: "Clone",
        submit: async (folder) => {
          const name = folder.trim();
          if (!name) throw new Error("Enter a folder name.");
          // Reported by the dialog itself (it renders a thrown error), so a failed clone
          // explains itself instead of closing as though it had worked.
          const info = await native("git_clone_repo", { parent, url: trimmed, folder: name });
          await gitRegistry.open(info.root, { makeActive: true });
          onCloned?.(info.root);
        },
      });
    },
  });
}
