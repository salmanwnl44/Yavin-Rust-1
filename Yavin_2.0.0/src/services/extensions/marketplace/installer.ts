/**
 * ExtensionInstaller (IDE-09): marketplace package → Yavin's extensions folder → the
 * ExtensionRegistry. It never runs extension code: an installed extension activates in the
 * workspace's extension host, lazily, like any other.
 *
 * Install / update:
 *   1. the version: the newest this Yavin can run (or the one asked for), checked for
 *      compatibility -- an incompatible version is never downloaded;
 *   2. the provider names the package; the native side downloads it over HTTPS, checks its size
 *      and SHA-256 against the index, validates the archive (paths, links, sizes) and unpacks it
 *      into a staging folder (`extensions_stage`);
 *   3. its manifest is validated here (`readManifest`: schema, identity, the extension API) and
 *      must be the extension and version asked for;
 *   4. only then is the installed version, if any, taken out of the registry (its host stops it)
 *      and the new folder put in place, the old one kept aside (`extensions_commit`);
 *   5. the new one is registered; if that fails, the old folder is moved back and the registry
 *      re-read (rollback); if it succeeds, the old folder is deleted (`extensions_finish`).
 *
 * Uninstall: out of the registry (its host stops it), then its folder deleted -- its stored
 * state only if the user chooses.
 */
import { native } from "../../native.ts";
import { readManifest } from "../manifest.ts";
import type { ExtensionRegistry, RegisteredExtension } from "../registry.ts";
import type { ExtensionStorage } from "../storage.ts";
import type { ExtensionMarketplaceService } from "./service.ts";
import { MarketplaceError, marketplaceErrorOf, type PackageSource } from "./types.ts";

export type OperationPhase = "downloading" | "verifying" | "installing" | "removing";

export interface Operation {
  kind: "install" | "update" | "uninstall";
  phase: OperationPhase;
  version: string | null;
}

export interface InstallerSnapshot {
  operations: Readonly<Record<string, Operation>>;
  /** The last failure per extension, until it is tried again. */
  failures: Readonly<Record<string, MarketplaceError>>;
}

/** The native installation commands (a test supplies its own). */
export interface InstallerNative {
  stage(
    source: PackageSource,
    expectedId: string,
    expectedVersion: string,
  ): Promise<{ token: string; manifest: string }>;
  commit(token: string, id: string): Promise<{ folder: string; replaced: boolean }>;
  finish(token: string, id: string, keep: boolean): Promise<void>;
  discard(token: string): Promise<void>;
  uninstall(id: string): Promise<string>;
}

export const nativeInstaller: InstallerNative = {
  stage: (source, expectedId, expectedVersion) =>
    native("extensions_stage", { source, expectedId, expectedVersion }),
  commit: (token, id) => native("extensions_commit", { token, id }),
  finish: (token, id, keep) => native("extensions_finish", { token, id, keep }),
  discard: (token) => native("extensions_discard", { token }),
  uninstall: (id) => native("extensions_uninstall", { id }),
};

const normal = (path: string) => path.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();

export function createExtensionInstaller(options: {
  service: ExtensionMarketplaceService;
  registry: ExtensionRegistry;
  storage: ExtensionStorage;
  /** Yavin's own extensions folder (what discovery reported), or null before discovery. */
  root: () => string | null;
  /** Re-reads the installed extensions from disk (a rollback's last resort). */
  rediscover: () => Promise<unknown>;
  native?: InstallerNative;
}) {
  const io = options.native ?? nativeInstaller;
  const listeners = new Set<() => void>();
  let snapshot: InstallerSnapshot = { operations: {}, failures: {} };
  const publish = (next: Partial<InstallerSnapshot>) => {
    snapshot = { ...snapshot, ...next };
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        /* One listener's failure is not the others'. */
      }
    }
  };
  const begin = (id: string, operation: Operation) => {
    if (snapshot.operations[id])
      throw new MarketplaceError(
        "Busy",
        `${id} is already being ${snapshot.operations[id].kind === "uninstall" ? "uninstalled" : "installed"}.`,
      );
    const { [id]: _cleared, ...failures } = snapshot.failures;
    void _cleared;
    publish({ operations: { ...snapshot.operations, [id]: operation }, failures });
  };
  const phase = (id: string, next: OperationPhase) =>
    publish({
      operations: { ...snapshot.operations, [id]: { ...snapshot.operations[id], phase: next } },
    });
  const end = (id: string, failure: MarketplaceError | null) => {
    const { [id]: _done, ...operations } = snapshot.operations;
    void _done;
    publish({
      operations,
      failures: failure ? { ...snapshot.failures, [id]: failure } : snapshot.failures,
    });
  };

  /** Whether `entry` is in Yavin's own extensions folder (and so may be uninstalled). */
  const removable = (entry: RegisteredExtension) => {
    const root = options.root();
    return !!root && normal(entry.source.path).startsWith(`${normal(root)}/`);
  };

  async function install(id: string, wanted?: string) {
    const existing = options.registry.get(id);
    const kind = existing ? "update" : "install";
    begin(id, { kind, phase: "downloading", version: wanted ?? null });
    let name = id;
    try {
      const extension = await options.service.getExtension(id);
      name = extension.displayName;
      const version = wanted ?? options.service.latestCompatible(extension)?.version;
      if (!version) {
        const why = options.service.compatibility(extension);
        throw new MarketplaceError(
          "Incompatible",
          why.reasons[0] ?? `${name} cannot run in this Yavin.`,
          why.reasons.join(" "),
        );
      }
      const compatibility = options.service.compatibility(extension, version);
      if (!compatibility.compatible)
        throw new MarketplaceError(
          "Incompatible",
          compatibility.reasons[0],
          compatibility.reasons.join(" "),
        );
      publish({
        operations: { ...snapshot.operations, [id]: { kind, phase: "downloading", version } },
      });
      const pkg = await options.service.download(id, version);
      phase(id, "verifying");
      const staged = await io.stage(pkg.source, id, version).catch((error) => {
        throw marketplaceErrorOf(error, "InstallFailed", name);
      });
      let raw: unknown;
      try {
        raw = JSON.parse(staged.manifest);
      } catch {
        await io.discard(staged.token).catch(() => undefined);
        throw new MarketplaceError(
          "InvalidPackage",
          `${name} is not a valid extension package.`,
          "Its manifest is not JSON.",
        );
      }
      const read = readManifest(raw);
      const problems = read.ok
        ? [
            ...(read.manifest.id !== id ? [`It is ${read.manifest.id}, not ${id}.`] : []),
            ...(read.manifest.version !== version
              ? [`It is version ${read.manifest.version}, not ${version}.`]
              : []),
          ]
        : read.problems
            .filter((p) => p.severity === "error")
            .map((p) => (p.field ? `${p.field}: ${p.message}` : p.message));
      if (problems.length) {
        await io.discard(staged.token).catch(() => undefined);
        throw new MarketplaceError(
          read.ok ? "ManifestMismatch" : "InvalidPackage",
          `Could not install ${name}: its package is not valid.`,
          problems.join(" "),
        );
      }
      // Its dependencies must be installed: an extension that cannot run is never installed.
      // (One that is installed but disabled can be enabled: the extension then says so.)
      const missing = read.ok
        ? read.manifest.dependencies.filter((dependency) => !options.registry.get(dependency))
        : [];
      if (missing.length) {
        await io.discard(staged.token).catch(() => undefined);
        throw new MarketplaceError(
          "Incompatible",
          `${name} needs ${missing.join(", ")}, which ${missing.length > 1 ? "are" : "is"} not installed. Install ${missing.length > 1 ? "them" : "it"} first.`,
          `Missing dependencies: ${missing.join(", ")}.`,
        );
      }

      phase(id, "installing");
      // The new folder goes in place (the working one kept aside); the registry changes only
      // after that, in one step -- an installed extension never disappears in between.
      let committed: { folder: string; replaced: boolean };
      try {
        committed = await io.commit(staged.token, id);
      } catch (error) {
        await io.discard(staged.token).catch(() => undefined);
        throw marketplaceErrorOf(error, "InstallFailed", name);
      }
      const source = { kind: "folder" as const, path: committed.folder };
      const added = options.registry.get(id)
        ? options.registry.replace(id, raw, source, committed.folder)
        : options.registry.add(raw, source, committed.folder);
      if (!("manifest" in added)) {
        await io.finish(staged.token, id, false).catch(() => undefined);
        await options.rediscover().catch(() => undefined);
        throw new MarketplaceError(
          "InstallFailed",
          `Could not install ${name}; the previous state was restored.`,
          added.problems.join(" "),
        );
      }
      await io.finish(staged.token, id, true).catch(() => undefined);
      options.service.settled(id);
      end(id, null);
      return added;
    } catch (error) {
      const failure = marketplaceErrorOf(error, "InstallFailed", name);
      end(id, failure);
      throw failure;
    }
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    removable,
    /** Installs the newest compatible version (or `version`). */
    install,
    /** Installs the newest compatible version over the installed one. */
    update: (id: string) => install(id),
    async uninstall(id: string, removeData: boolean) {
      const entry = options.registry.get(id);
      if (!entry) throw new MarketplaceError("UninstallFailed", `${id} is not installed.`);
      const name = entry.manifest.displayName;
      if (!removable(entry))
        throw new MarketplaceError(
          "UninstallFailed",
          `${name} is not installed in Yavin's extensions folder, so it cannot be uninstalled here.`,
        );
      begin(id, { kind: "uninstall", phase: "removing", version: entry.manifest.version });
      try {
        options.registry.remove(id);
        try {
          await io.uninstall(id);
        } catch (error) {
          await options.rediscover().catch(() => undefined);
          throw marketplaceErrorOf(error, "UninstallFailed", name);
        }
        const removed = removeData ? options.storage.removeAll(id) : 0;
        options.service.settled(id);
        end(id, null);
        return { removedRecords: removed };
      } catch (error) {
        const failure = marketplaceErrorOf(error, "UninstallFailed", name);
        end(id, failure);
        throw failure;
      }
    },
    /** Forgets a shown failure. */
    dismiss(id: string) {
      const { [id]: _gone, ...failures } = snapshot.failures;
      void _gone;
      publish({ failures });
    },
  };
}

export type ExtensionInstaller = ReturnType<typeof createExtensionInstaller>;
