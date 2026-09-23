import { folderName, parentPath } from "../../services/paths";
import { FileIcon } from "../ui/FileIcons";
import type { RecentFile } from "../../types";

/** One keyboard hint, taken from the real command so the page cannot drift from the app. */
export interface WelcomeHint {
  label: string;
  shortcut?: string;
}

/**
 * The page a window with no folder open is for.
 *
 * Three things can usefully be done from here -- open a folder, clone one, start a file --
 * and the folders opened before are the fastest route back to work, so they are given as
 * much room as the actions. The keyboard hints are the same bindings the commands carry, so
 * the page teaches the shortcuts that actually exist rather than a list maintained by hand.
 */
export function WelcomePage({
  workspace,
  recentFolders,
  recentFiles,
  hints,
  onOpenFolder,
  onOpenRecentFolder,
  onForgetRecentFolder,
  onCloneRepository,
  onNewFile,
  onOpenCommandPalette,
  onOpenFile,
}: {
  /** The open folder, or null in a window that has none. */
  workspace: string | null;
  recentFolders: string[];
  recentFiles: RecentFile[];
  hints: WelcomeHint[];
  onOpenFolder: () => void;
  onOpenRecentFolder: (folder: string) => void;
  onForgetRecentFolder: (folder: string) => void;
  onCloneRepository: () => void;
  onNewFile: () => void;
  onOpenCommandPalette: () => void;
  onOpenFile: (path: string, name: string) => void;
}) {
  const shortcutOf = (label: string) => hints.find((hint) => hint.label === label)?.shortcut;

  const action = (label: string, description: string, icon: React.ReactNode, run: () => void) => (
    <button
      key={label}
      onClick={run}
      className="group flex items-center justify-between rounded-lg p-2 text-left transition-colors hover:bg-[#121212]"
    >
      <span className="flex items-center gap-2.5">
        {icon}
        <span>
          <span className="block text-[12.5px] font-medium text-zinc-200 group-hover:text-white">
            {label}
          </span>
          <span className="block text-[11px] text-zinc-500">{description}</span>
        </span>
      </span>
      {shortcutOf(label) && (
        <kbd className="font-mono text-[10px] text-zinc-500">{shortcutOf(label)}</kbd>
      )}
    </button>
  );

  return (
    <div className="flex flex-1 flex-col items-center justify-center overflow-y-auto bg-black p-8">
      <section aria-label="Welcome" className="flex w-full max-w-[760px] flex-col gap-7">
        <header className="flex flex-col items-center gap-2 text-center">
          <span className="flex size-14 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-500 via-purple-600 to-pink-500 p-0.5 shadow-[0_0_30px_rgba(99,102,241,0.35)]">
            <span className="flex size-full items-center justify-center rounded-[14px] bg-black font-mono text-2xl font-black text-white">
              Y
            </span>
          </span>
          <h1 className="mt-1 text-2xl font-bold tracking-tight text-white">Yavin IDE</h1>
          <p className="max-w-[440px] text-[13px] text-zinc-400">
            {workspace
              ? `Working in ${folderName(workspace)}. Pick up where you left off, or start something new.`
              : "Open a folder to browse, edit and save its files. Yavin reopens the last one you were in."}
          </p>
        </header>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <section
            aria-label="Start"
            className="flex flex-col gap-1 rounded-xl border border-[#181818] bg-[#070707] p-4"
          >
            <h2 className="mb-1 flex items-center gap-2 text-[12px] font-semibold tracking-wider text-zinc-300 uppercase">
              <span className="text-indigo-400">✦</span> Start
            </h2>
            {action(
              "Open Folder",
              "Browse for a project on this machine",
              <FileIcon name="folder" isDir className="size-4" />,
              onOpenFolder,
            )}
            {action(
              "Clone Repository",
              "Copy a Git repository and open it",
              <span className="text-indigo-400">⑂</span>,
              onCloneRepository,
            )}
            {action(
              "New File",
              workspace ? "Create a file in this folder" : "Start writing without a folder",
              <FileIcon name="newfile.ts" className="size-4" />,
              onNewFile,
            )}
            {action(
              "Command Palette",
              "Every command, searchable",
              <span className="text-indigo-400">⚡</span>,
              onOpenCommandPalette,
            )}
          </section>

          <section
            aria-label="Recent"
            className="flex flex-col gap-1 rounded-xl border border-[#181818] bg-[#070707] p-4"
          >
            <h2 className="mb-1 flex items-center gap-2 text-[12px] font-semibold tracking-wider text-zinc-300 uppercase">
              <span className="text-emerald-400">◷</span> Recent
            </h2>
            {recentFolders.length === 0 ? (
              <p className="p-2 text-[11.5px] text-zinc-500">
                Folders you open are listed here, so getting back to a project is one click.
              </p>
            ) : (
              recentFolders.map((folder) => (
                <div key={folder} className="group flex items-center rounded-lg hover:bg-[#121212]">
                  <button
                    onClick={() => onOpenRecentFolder(folder)}
                    title={folder}
                    className="flex min-w-0 flex-1 items-center gap-2.5 p-2 text-left"
                  >
                    <FileIcon name="folder" isDir className="size-4 shrink-0" />
                    <span className="min-w-0">
                      <span className="block truncate text-[12.5px] font-medium text-zinc-200 group-hover:text-white">
                        {folderName(folder)}
                      </span>
                      <span className="block truncate font-mono text-[10px] text-zinc-600">
                        {parentPath(folder) || folder}
                      </span>
                    </span>
                  </button>
                  <button
                    aria-label={`Remove ${folderName(folder)} from the recent list`}
                    onClick={() => onForgetRecentFolder(folder)}
                    className="mr-1 rounded px-2 py-1 text-zinc-600 opacity-0 transition-opacity group-hover:opacity-100 hover:text-red-400 focus-visible:opacity-100"
                  >
                    ✕
                  </button>
                </div>
              ))
            )}

            {recentFiles.length > 0 && (
              <>
                <h3 className="mt-3 mb-1 px-2 text-[10px] font-semibold tracking-wider text-zinc-500 uppercase">
                  In this folder
                </h3>
                {recentFiles.slice(0, 4).map((file) => (
                  <button
                    key={file.path}
                    onClick={() => onOpenFile(file.path, file.name)}
                    title={file.path}
                    className="group flex items-center gap-2.5 rounded-lg p-2 text-left hover:bg-[#121212]"
                  >
                    <FileIcon name={file.name} className="size-3.5 shrink-0" />
                    <span className="truncate text-[12px] text-zinc-300 group-hover:text-white">
                      {file.name}
                    </span>
                  </button>
                ))}
              </>
            )}
          </section>
        </div>

        {hints.length > 0 && (
          <dl className="flex flex-wrap items-center justify-center gap-x-6 gap-y-2 rounded-xl border border-[#161616] bg-[#040404] px-4 py-3 text-[11.5px]">
            {hints
              .filter((hint) => hint.shortcut)
              .map((hint) => (
                <span key={hint.label} className="flex items-center gap-2">
                  <dt className="text-zinc-400">{hint.label}</dt>
                  <dd className="font-mono text-[10.5px] text-zinc-500">{hint.shortcut}</dd>
                </span>
              ))}
          </dl>
        )}
      </section>
    </div>
  );
}
