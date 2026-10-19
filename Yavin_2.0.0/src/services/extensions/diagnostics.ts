/**
 * Extension diagnostics (EXT-14), as the window shows them. The native side keeps them
 * (`extension_diagnostics.rs`): it classifies every code, redacts every detail, bounds and rotates
 * the log, and shows a window only its own records and the application's. This only asks --
 * for the records, the report the user copies, a clear -- and tells the native side what the
 * window alone observed (an activation that timed out), which it classifies itself.
 */
import { native } from "../native.ts";

export type DiagnosticCategory =
  | "install"
  | "trust"
  | "permission"
  | "dependency"
  | "api"
  | "sandbox"
  | "timeout"
  | "crash"
  | "resource"
  | "storage"
  | "profile"
  | "recovery"
  | "host";

export interface ExtensionDiagnostic {
  at: number;
  code: string;
  category: DiagnosticCategory;
  severity: "info" | "warning" | "error";
  /** Yavin refused on purpose (a check held), as opposed to something that broke. */
  refusal: boolean;
  extension: string | null;
  version: string | null;
  window: string | null;
  session: number | null;
  phase: string;
  summary: string;
  remedy: string | null;
  detail: string | null;
  correlation: string | null;
  count: number;
  source: "native" | "window";
}

export interface DiagnosticsIo {
  list(id?: string): Promise<ExtensionDiagnostic[]>;
  report(id?: string): Promise<string>;
  clear(id?: string): Promise<number>;
  note(code: string, id: string | null, detail?: string): Promise<unknown>;
  safeMode(enabled?: boolean): Promise<boolean>;
}

export const nativeDiagnostics: DiagnosticsIo = {
  list: (id) => native("extensions_diagnostics", { id: id ?? null }),
  report: (id) => native("extensions_diagnostics_report", { id: id ?? null }),
  clear: (id) => native("extensions_diagnostics_clear", { id: id ?? null }),
  note: (code, id, detail) =>
    native("extensions_diagnostics_note", { code, id, detail: detail ?? null }),
  safeMode: (enabled) => native("extensions_safe_mode", { enabled: enabled ?? null }),
};

/** What a category is called. */
export const CATEGORY_LABEL: Record<DiagnosticCategory, string> = {
  install: "Installation",
  trust: "Package trust",
  permission: "Permission",
  dependency: "Dependencies",
  api: "API compatibility",
  sandbox: "Sandbox",
  timeout: "Timeout",
  crash: "Crash",
  resource: "Resource limit",
  storage: "Secret storage",
  profile: "Profile",
  recovery: "Recovery",
  host: "Extension host",
};
