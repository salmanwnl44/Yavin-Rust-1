import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Repository } from "../repository.ts";

/**
 * Test-only harness: a real `Repository` whose `git_exec` runs the real `git` binary in
 * a real temporary repository. Only the Tauri transport is replaced -- every argv is
 * built by production code and executed by Git itself, so what these tests assert is
 * what a user's repository would produce. (The Rust allow-list is covered separately by
 * the tests in `src-tauri/src/git.rs`.)
 */

interface Invoker {
  invoke: (command: string, args: Record<string, unknown>) => Promise<unknown>;
}

const roots = new Map<string, string>();
let installed = false;

/**
 * Per-command replacements for tests that need a native command to misbehave (for
 * example `git_watch_repo` rejecting). Cleared with `resetNativeOverrides()`.
 */
const overrides = new Map<string, (args: Record<string, unknown>) => unknown>();
export function overrideNative(
  command: string,
  handler: (args: Record<string, unknown>) => unknown,
) {
  overrides.set(command, handler);
}
export function resetNativeOverrides() {
  overrides.clear();
}
/** Every native command the code under test issued, in order. */
export const nativeCalls: { command: string; args: Record<string, unknown> }[] = [];

function install() {
  if (installed) return;
  installed = true;
  const g = globalThis as unknown as Record<string, unknown>;
  g.isTauri = true;
  g.window = globalThis;
  const internals: Invoker = {
    invoke: async (command, args) => {
      nativeCalls.push({ command, args });
      const override = overrides.get(command);
      if (override) return override(args ?? {});
      const repoId = String(args?.repoId ?? "");
      const cwd = roots.get(repoId);
      switch (command) {
        case "git_open_repo": {
          // Like the Rust command: normalise to the work tree's top level.
          const path = String(args.path);
          const top = spawnSync("git", ["rev-parse", "--show-toplevel"], {
            cwd: path,
            encoding: "utf8",
          });
          if (top.status !== 0) throw new Error(`Not a Git repository: ${path}`);
          const root = top.stdout.trim();
          roots.set(root, root);
          return { repoId: root, root };
        }
        case "git_repo_state":
          return "";
        case "git_watch_repo":
        case "git_unwatch_repo":
          return undefined;
        case "git_exec": {
          if (!cwd) throw new Error(`Unknown repository ${repoId}`);
          // The real command fails to spawn when the folder is gone, it does not report a
          // Git exit code.
          if (!existsSync(cwd)) throw new Error(`Cannot run Git: ${cwd} does not exist`);
          const result = spawnSync("git", args.args as string[], {
            cwd,
            input: (args.input as string | undefined) ?? undefined,
            encoding: "utf8",
            env: { ...process.env, LC_ALL: "C", GIT_TERMINAL_PROMPT: "0" },
          });
          return {
            stdout: result.stdout ?? "",
            stderr: result.stderr ?? "",
            code: result.status ?? -1,
            truncated: false,
          };
        }
        case "git_cancel_repo":
        case "git_close_repo":
          return undefined;
        default:
          throw new Error(`realGit harness does not implement ${command}`);
      }
    },
  };
  g.__TAURI_INTERNALS__ = internals;
}

/** Runs `git` directly (for building fixtures and for ground truth). */
export function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout;
}

export interface RealRepo {
  root: string;
  repository: Repository;
  /** Runs git in the fixture and returns stdout. */
  git: (...args: string[]) => string;
  dispose: () => void;
}

/** A fresh repository on `main` with one identity configured and CRLF conversion off. */
export function realRepo(): RealRepo {
  install();
  const root = mkdtempSync(join(tmpdir(), "yavin-real-"));
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "t@example.com");
  git(root, "config", "user.name", "Tester");
  git(root, "config", "core.autocrlf", "false");
  const repoId = root;
  roots.set(repoId, root);
  return {
    root,
    repository: new Repository(repoId, root),
    git: (...args) => git(root, ...args),
    dispose: () => {
      roots.delete(repoId);
      rmSync(root, { recursive: true, force: true });
    },
  };
}
