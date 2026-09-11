export interface FileNode {
  name: string;
  path: string;
  is_dir: boolean;
  size?: number;
  modified?: number | null;
  readonly?: boolean;
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
