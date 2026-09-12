export interface FileNode {
  name: string;
  path: string;
  is_dir: boolean;
  size?: number;
  modified?: number | null;
  readonly?: boolean;
  /** For a directory, `null`/`undefined` means not loaded yet; `[]` means empty. */
  children?: FileNode[] | null;
}

export interface RecentFile {
  name: string;
  path: string;
}

export interface EditorTab extends RecentFile {
  id: string;
  dirty: boolean;
}
