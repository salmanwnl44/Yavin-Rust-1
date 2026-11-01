import { useState, useSyncExternalStore } from "react";
import { asTerminalError } from "../../services/terminalProtocol";
import type { TerminalSettingsStore } from "../../services/terminalSettings";
import {
  supportsLogin,
  type ProfileEntry,
  type ProfileInput,
  type WorkspaceProfiles,
} from "../../services/terminalProfiles";

/** A profile as the form edits it: arguments one per line, environment as `NAME=value` lines. */
interface Draft {
  id: string | null;
  scope: "user" | "workspace";
  name: string;
  executable: string;
  args: string;
  cwd: string;
  env: string;
  login: boolean;
}

const SCOPE_LABEL = { builtin: "Built-in", user: "Yours", workspace: "This workspace" } as const;

const toDraft = (entry: ProfileEntry): Draft => ({
  id: entry.profile.id,
  scope: entry.scope === "workspace" ? "workspace" : "user",
  name: entry.profile.name,
  executable: entry.profile.executable,
  args: entry.profile.args.join("\n"),
  cwd: entry.profile.cwd ?? "",
  env: entry.profile.env.map(([name, value]) => `${name}=${value}`).join("\n"),
  login: !!entry.profile.login,
});

/** The form's lines as a profile; a line without `=` is kept whole, for validation to refuse. */
const toInput = (draft: Draft): ProfileInput => ({
  name: draft.name,
  executable: draft.executable,
  args: draft.args.split("\n").filter((line) => line !== ""),
  cwd: draft.cwd.trim() || null,
  env: draft.env
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => {
      const at = line.indexOf("=");
      return (at === -1 ? [line, ""] : [line.slice(0, at), line.slice(at + 1)]) as [string, string];
    }),
  login: draft.login,
});

/**
 * Terminal profiles (TERMINAL-05): list, make, change and remove profiles, and choose the
 * defaults, and whether shells' integration is read (TERMINAL-07). Every change goes through
 * the registry or the terminal settings, which validate and keep it; the dialog keeps only the
 * form it is editing.
 */
export function TerminalProfilesDialog({
  profiles,
  settings,
  onLaunch,
  onClose,
}: {
  profiles: WorkspaceProfiles;
  /** Where the integration setting is kept; without it the setting is not offered. */
  settings?: TerminalSettingsStore;
  onLaunch: (profileId: string) => void;
  onClose: () => void;
}) {
  const snapshot = useSyncExternalStore(profiles.subscribe, profiles.getSnapshot);
  const noSettings = () => null;
  const userIntegration = useSyncExternalStore(
    settings?.subscribe ?? (() => () => {}),
    settings ? () => settings.user().shellIntegration : noSettings,
  );
  const workspaceIntegration = useSyncExternalStore(
    settings?.subscribe ?? (() => () => {}),
    settings ? () => settings.workspace(profiles.workspaceId).shellIntegration : noSettings,
  );
  const shells = (profiles.registry.getSnapshot().shells ?? []).filter((shell) => shell.available);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState("");

  const run = (action: () => void) => {
    try {
      action();
      setError("");
    } catch (reason) {
      setError(asTerminalError(reason).message);
    }
  };

  const save = (current: Draft) =>
    run(() => {
      const input = toInput(current);
      if (current.id === null) {
        if (current.scope === "workspace") profiles.addWorkspace(input);
        else profiles.registry.addUser(input);
      } else if (current.scope === "workspace") profiles.updateWorkspace(current.id, input);
      else profiles.registry.updateUser(current.id, input);
      setDraft(null);
    });

  const kindOf = (executable: string) =>
    shells.find((shell) => shell.path === executable)?.kind ?? "other";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onMouseDown={onClose}
    >
      <div
        role="dialog"
        aria-label="Terminal profiles"
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === "Escape") onClose();
        }}
        className="max-h-[80vh] w-[560px] overflow-y-auto rounded-lg border border-[#222222] bg-[#0a0a0a] p-4 text-[12px] text-zinc-300 shadow-2xl"
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-[13px] font-semibold text-zinc-100">Terminal profiles</h2>
          <button
            aria-label="Close profiles"
            onClick={onClose}
            className="text-zinc-500 hover:text-zinc-200"
          >
            ✕
          </button>
        </div>

        <ul aria-label="Profiles" className="space-y-1">
          {snapshot.profiles.map((entry) => {
            const id = entry.profile.id;
            const isDefault = snapshot.effectiveDefault === id;
            return (
              <li
                key={id}
                aria-label={entry.profile.name}
                className="flex items-center gap-2 rounded px-2 py-1 hover:bg-[#121212]"
              >
                <span className="min-w-0 flex-1 truncate" title={entry.profile.executable}>
                  {entry.profile.name}
                  <span className="ml-2 text-[10px] text-zinc-500">{SCOPE_LABEL[entry.scope]}</span>
                  {isDefault && <span className="ml-2 text-[10px] text-indigo-300">Default</span>}
                  {!entry.available && (
                    <span className="ml-2 text-[10px] text-rose-300" title={entry.reason ?? ""}>
                      Unavailable
                    </span>
                  )}
                </span>
                <button
                  disabled={!entry.available}
                  title={entry.reason ?? undefined}
                  onClick={() => {
                    onLaunch(id);
                    onClose();
                  }}
                  className="rounded px-1.5 text-[11px] hover:bg-[#1c1c1c] disabled:opacity-40"
                >
                  Open
                </button>
                <button
                  disabled={!entry.available}
                  onClick={() =>
                    run(() =>
                      entry.scope === "workspace"
                        ? profiles.setWorkspaceDefault(id)
                        : profiles.registry.setUserDefault(id),
                    )
                  }
                  className="rounded px-1.5 text-[11px] hover:bg-[#1c1c1c] disabled:opacity-40"
                >
                  Make default
                </button>
                {entry.scope !== "builtin" && (
                  <>
                    <button
                      onClick={() => setDraft(toDraft(entry))}
                      className="rounded px-1.5 text-[11px] hover:bg-[#1c1c1c]"
                    >
                      Edit
                    </button>
                    <button
                      onClick={() =>
                        run(() =>
                          entry.scope === "workspace"
                            ? profiles.removeWorkspace(id)
                            : profiles.registry.removeUser(id),
                        )
                      }
                      className="rounded px-1.5 text-[11px] text-rose-300 hover:bg-[#1c1c1c]"
                    >
                      Delete
                    </button>
                  </>
                )}
              </li>
            );
          })}
        </ul>
        {(snapshot.workspaceDefault !== null || snapshot.userDefault !== null) && (
          <button
            onClick={() =>
              run(() => {
                profiles.setWorkspaceDefault(null);
                profiles.registry.setUserDefault(null);
              })
            }
            className="mt-2 text-[11px] text-zinc-500 hover:text-zinc-200"
          >
            Use the platform default
          </button>
        )}

        {settings && (
          <fieldset aria-label="Shell integration" className="mt-3 border-t border-[#1c1c1c] pt-3">
            <legend className="mb-1 text-[11px] font-semibold text-zinc-400">
              Shell integration
            </legend>
            <p className="mb-2 text-[11px] text-zinc-500">
              Reads the folder and command boundaries a shell reports (OSC 7 and 133), if it is set
              up to. Applies to terminals started from now on.
            </p>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={userIntegration ?? true}
                onChange={(event) =>
                  settings.updateUser({ shellIntegration: event.target.checked })
                }
              />
              Read shell integration
            </label>
            <label className="mt-2 flex items-center gap-2">
              In this workspace
              <select
                aria-label="Shell integration in this workspace"
                value={
                  workspaceIntegration === null ? "inherit" : workspaceIntegration ? "on" : "off"
                }
                onChange={(event) =>
                  settings.updateWorkspace(profiles.workspaceId, {
                    shellIntegration:
                      event.target.value === "inherit" ? null : event.target.value === "on",
                  })
                }
                className="rounded border border-[#2a2a2a] bg-[#111111] px-1 py-0.5"
              >
                <option value="inherit">As above</option>
                <option value="on">On</option>
                <option value="off">Off</option>
              </select>
            </label>
          </fieldset>
        )}

        {draft === null ? (
          <button
            disabled={!shells.length}
            onClick={() =>
              setDraft({
                id: null,
                scope: "user",
                name: "",
                executable: shells[0]?.path ?? "",
                args: "",
                cwd: "",
                env: "",
                login: false,
              })
            }
            className="mt-3 rounded bg-indigo-600 px-3 py-1 text-[11px] font-medium text-white hover:bg-indigo-500 disabled:opacity-40"
          >
            New Profile
          </button>
        ) : (
          <form
            aria-label="Profile"
            onSubmit={(event) => {
              event.preventDefault();
              save(draft);
            }}
            className="mt-3 grid grid-cols-[110px_1fr] items-center gap-x-2 gap-y-1.5 border-t border-[#1c1c1c] pt-3"
          >
            <label htmlFor="profile-name">Name</label>
            <input
              id="profile-name"
              value={draft.name}
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
              className="rounded border border-[#222222] bg-black px-2 py-0.5"
            />
            <label htmlFor="profile-shell">Shell</label>
            <select
              id="profile-shell"
              value={draft.executable}
              onChange={(event) => {
                const executable = event.target.value;
                setDraft({
                  ...draft,
                  executable,
                  login: draft.login && supportsLogin(kindOf(executable)),
                });
              }}
              className="rounded border border-[#222222] bg-black px-2 py-0.5"
            >
              {shells.map((shell) => (
                <option key={shell.path} value={shell.path}>
                  {shell.name}
                </option>
              ))}
            </select>
            <label htmlFor="profile-args">Arguments</label>
            <textarea
              id="profile-args"
              rows={2}
              placeholder="One argument per line"
              value={draft.args}
              onChange={(event) => setDraft({ ...draft, args: event.target.value })}
              className="rounded border border-[#222222] bg-black px-2 py-0.5 font-mono"
            />
            <label htmlFor="profile-cwd">Folder</label>
            <input
              id="profile-cwd"
              placeholder="The workspace root"
              value={draft.cwd}
              onChange={(event) => setDraft({ ...draft, cwd: event.target.value })}
              className="rounded border border-[#222222] bg-black px-2 py-0.5"
            />
            <label htmlFor="profile-env">Environment</label>
            <textarea
              id="profile-env"
              rows={2}
              placeholder="NAME=value, one per line"
              value={draft.env}
              onChange={(event) => setDraft({ ...draft, env: event.target.value })}
              className="rounded border border-[#222222] bg-black px-2 py-0.5 font-mono"
            />
            <span />
            <label className="flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={draft.login}
                disabled={!supportsLogin(kindOf(draft.executable))}
                onChange={(event) => setDraft({ ...draft, login: event.target.checked })}
              />
              Login shell
            </label>
            {draft.id === null && (
              <>
                <span>Keep for</span>
                <select
                  aria-label="Keep for"
                  value={draft.scope}
                  onChange={(event) =>
                    setDraft({ ...draft, scope: event.target.value as Draft["scope"] })
                  }
                  className="rounded border border-[#222222] bg-black px-2 py-0.5"
                >
                  <option value="user">Every workspace</option>
                  <option value="workspace">This workspace</option>
                </select>
              </>
            )}
            <span />
            <div className="flex gap-2">
              <button
                type="submit"
                className="rounded bg-indigo-600 px-3 py-1 text-[11px] font-medium text-white hover:bg-indigo-500"
              >
                Save Profile
              </button>
              <button
                type="button"
                onClick={() => setDraft(null)}
                className="text-[11px] text-zinc-500"
              >
                Cancel
              </button>
            </div>
          </form>
        )}
        {error && (
          <p role="alert" className="mt-2 text-[11px] text-rose-300">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
