import { invoke, isTauri } from "@tauri-apps/api/core";
import type { FileNode } from "../types";

interface Commands {
  get_default_workspace: { args: undefined; result: string };
  list_workspace_files: { args: { path: string; maxDepth: number }; result: FileNode };
  read_file_content: { args: { path: string }; result: string };
  create_file: { args: { path: string }; result: void };
  create_directory: { args: { path: string }; result: void };
  rename_path: { args: { oldPath: string; newPath: string }; result: void };
  delete_path: { args: { path: string; recursive: boolean }; result: void };
  duplicate_path: { args: { path: string }; result: string };
  copy_path: { args: { src: string; dest: string }; result: void };
  reveal_in_explorer: { args: { path: string }; result: void };
  open_folder_dialog: { args: undefined; result: string | null };
  open_file_dialog: { args: undefined; result: string | null };
  get_git_status: { args: { path: string }; result: { root: string; output: string } };
  write_file_guarded: { args: { path: string; expected: string; content: string }; result: void };
  search_project: { args: { workspace: string; id: string; options: SearchOptions }; result: ToolOutput };
  cancel_search: { args: { id: string }; result: void };
  git_workbench: { args: { workspace: string; action: string; path?: string; value?: string }; result: string };
}

export interface ToolOutput { stdout: string; stderr: string; code: number; truncated: boolean }
export interface SearchOptions {
  query: string; caseSensitive: boolean; wholeWord: boolean; regex: boolean;
  hidden: boolean; ignored: boolean; include: string[]; exclude: string[];
  folder: string; buffer: string | null; filesOnly: boolean;
}

export function native<K extends keyof Commands>(
  command: K,
  ...parameters: Commands[K]["args"] extends undefined ? [] : [Commands[K]["args"]]
): Promise<Commands[K]["result"]> {
  if (!isTauri())
    return Promise.reject(new Error("Open the desktop application to access local files."));
  return invoke<Commands[K]["result"]>(command, parameters[0]);
}
