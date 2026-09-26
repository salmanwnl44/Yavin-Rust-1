import type { DocumentStatus } from "./services/documents.ts";

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

/** A tab as the editor strip stores it: which document, in which place. */
export interface OpenTab extends RecentFile {
  id: string;
}

/** A tab as it is drawn, with what its document says about itself (never stored twice). */
export interface EditorTab extends OpenTab {
  dirty: boolean;
  status?: DocumentStatus;
}
