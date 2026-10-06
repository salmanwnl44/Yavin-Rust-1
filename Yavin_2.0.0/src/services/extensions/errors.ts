/** What went wrong with an extension (IDE-07): typed, and always naming the extension. */
export type ExtensionErrorCode =
  | "InvalidManifest"
  | "DuplicateExtension"
  | "UnknownExtension"
  | "Disabled"
  | "DuplicateCommand"
  | "DuplicateSetting"
  | "DuplicateView"
  | "ShortcutTaken"
  | "UnknownCommand"
  | "NotOwned"
  | "TrustRequired"
  | "UnsupportedRuntime"
  | "ActivationFailed"
  | "CommandFailed"
  | "ViewFailed"
  | "DisposeFailed"
  | "StorageCorrupt"
  | "StorageLimit"
  | "StorageReadOnly"
  | "HostDisposed";

export class ExtensionError extends Error {
  readonly code: ExtensionErrorCode;
  /** The extension it concerns (`publisher.name`), or null when there is none yet. */
  readonly extensionId: string | null;
  constructor(code: ExtensionErrorCode, extensionId: string | null, message: string) {
    super(message);
    this.name = "ExtensionError";
    this.code = code;
    this.extensionId = extensionId;
  }
}
