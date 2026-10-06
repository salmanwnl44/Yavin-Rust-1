import { useEffect, useReducer, useState, useSyncExternalStore } from "react";
import {
  SettingsError,
  type SettingDefinition,
  type SettingScope,
  type SettingsRegistry,
} from "../../services/settings/settings";
import type { WorkspaceId } from "../../services/terminalProtocol";
import type { TerminalSettingsStore } from "../../services/terminalSettings";
import type { WorkspaceProfiles } from "../../services/terminalProfiles";

/**
 * The Settings view (IDE-03): what the settings registry holds, by section, for the user or
 * for this workspace, each with its description, its value, where that value comes from, and a
 * reset. A presentation of the registry -- it keeps no settings of its own -- plus the
 * terminal's settings, shown and changed through the terminal's own store (`terminalSettings`),
 * which stays their owner.
 */
export function SettingsView({
  registry,
  workspace,
  workspaceName,
  terminal,
  initialQuery,
  onClose,
}: {
  registry: SettingsRegistry;
  /** The open workspace; `null` with no folder open (user settings only). */
  workspace: WorkspaceId | null;
  workspaceName?: string;
  terminal?: { settings: TerminalSettingsStore; profiles: WorkspaceProfiles };
  /** What the search starts as (e.g. "Tasks" for Run › Configure Tasks). */
  initialQuery?: string;
  onClose: () => void;
}) {
  const [scope, setScope] = useState<SettingScope>("user");
  const [query, setQuery] = useState(initialQuery ?? "");
  // Asked again while open (Configure Tasks from the Run view): the search follows.
  useEffect(() => {
    if (initialQuery) setQuery(initialQuery);
  }, [initialQuery]);
  const [, refresh] = useReducer((n: number) => n + 1, 0);
  // Any change in what the user level or this workspace resolves to redraws the view.
  useEffect(() => {
    const stopUser = registry.subscribe(null, refresh);
    // Settings added or removed later (an extension's, IDE-07) appear and go at once.
    const stopDefinitions = registry.onDefinitions(refresh);
    const stopWorkspace = workspace === null ? () => {} : registry.subscribe(workspace, refresh);
    return () => {
      stopUser();
      stopWorkspace();
      stopDefinitions();
    };
  }, [registry, workspace]);
  const editingScope: SettingScope = workspace === null ? "user" : scope;
  const target = editingScope === "workspace" ? workspace : null;

  const needle = query.trim().toLowerCase();
  const matches = (text: string) => !needle || text.toLowerCase().includes(needle);
  const shown = registry.definitions.filter((definition) =>
    matches(`${definition.section} ${definition.title} ${definition.description} ${definition.id}`),
  );
  const sections = [...new Set(shown.map((definition) => definition.section))];
  const terminalShown = !!terminal && matches("terminal shell integration default profile");

  return (
    <section
      aria-label="Settings"
      className="flex min-h-0 flex-1 flex-col overflow-hidden bg-[#050505] text-[12px] text-zinc-300"
    >
      <header className="flex shrink-0 items-center gap-3 border-b border-[#161616] px-5 py-2.5">
        <h1 className="text-[13px] font-semibold text-zinc-100">Settings</h1>
        <div role="tablist" aria-label="Settings scope" className="flex gap-1">
          {(["user", "workspace"] as const).map((one) => (
            <button
              key={one}
              role="tab"
              aria-selected={editingScope === one}
              disabled={one === "workspace" && workspace === null}
              title={
                one === "workspace"
                  ? workspace === null
                    ? "Open a folder to have workspace settings"
                    : `Only in ${workspaceName ?? "this workspace"}; overrides your settings`
                  : "Yours, in every workspace"
              }
              onClick={() => setScope(one)}
              className={`rounded px-2.5 py-1 text-[11px] disabled:opacity-40 ${
                editingScope === one
                  ? "bg-indigo-950/70 text-indigo-200"
                  : "text-zinc-500 hover:text-zinc-200"
              }`}
            >
              {one === "user" ? "User" : "Workspace"}
            </button>
          ))}
        </div>
        <input
          aria-label="Search settings"
          placeholder="Search settings"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          className="ml-auto w-64 rounded border border-[#222222] bg-[#0a0a0a] px-2 py-1 text-[11px] text-zinc-200 placeholder:text-zinc-600"
        />
        <button
          aria-label="Close settings"
          onClick={onClose}
          className="text-zinc-500 hover:text-zinc-200"
        >
          ✕
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-3">
        {!sections.length && !terminalShown && (
          <p className="text-zinc-500">No settings match “{query}”.</p>
        )}
        {sections.map((section) => (
          <section key={section} aria-label={section} className="mb-5">
            <h2 className="mb-2 text-[11px] font-semibold tracking-wider text-zinc-400 uppercase">
              {section}
            </h2>
            {shown
              .filter((definition) => definition.section === section)
              .map((definition) => (
                <SettingRow
                  key={definition.id}
                  registry={registry}
                  definition={definition}
                  scope={editingScope}
                  workspace={target}
                  viewing={workspace}
                />
              ))}
          </section>
        ))}
        {terminalShown && terminal && (
          <TerminalSection terminal={terminal} scope={editingScope} workspace={workspace} />
        )}
      </div>
    </section>
  );
}

function SettingRow({
  registry,
  definition,
  scope,
  workspace,
  viewing,
}: {
  registry: SettingsRegistry;
  definition: SettingDefinition<unknown>;
  scope: SettingScope;
  workspace: WorkspaceId | null;
  viewing: WorkspaceId | null;
}) {
  const [error, setError] = useState("");
  const allowed = definition.scopes.includes(scope);
  // The user tab shows what the user level resolves to; the workspace tab, what this
  // workspace does -- and where it comes from.
  const state = registry.inspect(definition, scope === "workspace" ? viewing : null);
  const held = scope === "workspace" ? state.workspace !== undefined : state.user !== undefined;
  const label = `${definition.title}`;

  const commit = (value: unknown) => {
    try {
      registry.set(definition, scope, value, workspace);
      setError("");
    } catch (reason) {
      setError(reason instanceof SettingsError ? reason.message : String(reason));
    }
  };

  const control = definition.control;
  return (
    <div
      role="group"
      aria-label={label}
      className="mb-3 grid grid-cols-[1fr_auto] gap-x-4 rounded px-2 py-1.5 hover:bg-[#0a0a0a]"
    >
      <div>
        <div className="font-medium text-zinc-200">
          {definition.title}
          <span className="ml-2 text-[10px] font-normal text-zinc-600">{definition.id}</span>
        </div>
        <p className="text-[11px] text-zinc-500">{definition.description}</p>
        <p className="text-[10px] text-zinc-600" data-testid="setting-source">
          {!allowed
            ? "A user setting: the same in every workspace."
            : state.source === "workspace"
              ? "Set for this workspace."
              : state.source === "user"
                ? scope === "workspace"
                  ? "From your user settings."
                  : "Set in your user settings."
                : "Default."}
        </p>
        {error && (
          <p role="alert" className="text-[11px] text-red-400">
            {error}
          </p>
        )}
        {control.kind === "json" && (
          <JsonDraft
            label={label}
            disabled={!allowed}
            value={state.value}
            example={control.example}
            onCommit={(value) => commit(value)}
            onInvalid={setError}
          />
        )}
      </div>
      <div className="flex items-center gap-2 self-center">
        {control.kind === "boolean" && (
          <input
            type="checkbox"
            aria-label={label}
            disabled={!allowed}
            checked={state.value === true}
            onChange={(event) => commit(event.target.checked)}
          />
        )}
        {control.kind === "enum" && (
          <select
            aria-label={label}
            disabled={!allowed}
            value={String(state.value)}
            onChange={(event) =>
              commit(
                control.options.find((option) => String(option.value) === event.target.value)
                  ?.value,
              )
            }
            className="rounded border border-[#2a2a2a] bg-[#111111] px-1.5 py-0.5"
          >
            {control.options.map((option) => (
              <option key={String(option.value)} value={String(option.value)}>
                {option.label}
              </option>
            ))}
          </select>
        )}
        {control.kind === "number" && (
          <DraftInput
            label={label}
            type="number"
            disabled={!allowed}
            value={String(state.value)}
            step={control.step}
            min={control.min}
            max={control.max}
            onCommit={(text) => commit(text.trim() === "" ? undefined : Number(text))}
          />
        )}
        {control.kind === "string" && (
          <DraftInput
            label={label}
            type="text"
            disabled={!allowed}
            value={String(state.value)}
            onCommit={(text) => commit(text)}
          />
        )}
        <button
          aria-label={`Reset ${label}`}
          title={
            scope === "workspace"
              ? "Remove this workspace's value: your setting, or the default, applies"
              : "Remove your value: the default applies"
          }
          disabled={!allowed || !held}
          onClick={() => {
            registry.reset(definition, scope, workspace);
            setError("");
          }}
          className="rounded px-1.5 text-[11px] text-zinc-500 hover:bg-[#1c1c1c] hover:text-zinc-200 disabled:opacity-30"
        >
          Reset
        </button>
      </div>
    </div>
  );
}

/**
 * A structured setting edited as JSON (IDE-04's task list): applied with Apply, refused -- with
 * the setting's own explanation -- when it is not JSON or not a valid value; the stored value
 * is untouched until then.
 */
function JsonDraft({
  label,
  value,
  disabled,
  example,
  onCommit,
  onInvalid,
}: {
  label: string;
  value: unknown;
  disabled: boolean;
  example: string;
  onCommit: (value: unknown) => void;
  onInvalid: (message: string) => void;
}) {
  const shown = JSON.stringify(value, null, 2);
  const [draft, setDraft] = useState<string | null>(null);
  const apply = () => {
    if (draft === null) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(draft);
    } catch (reason) {
      onInvalid(`Not valid JSON: ${reason instanceof Error ? reason.message : String(reason)}`);
      return;
    }
    onCommit(parsed);
    setDraft(null);
  };
  return (
    <div className="mt-1.5">
      <textarea
        aria-label={label}
        disabled={disabled}
        spellCheck={false}
        rows={Math.min(18, Math.max(4, (draft ?? shown).split("\n").length + 1))}
        value={draft ?? shown}
        onChange={(event) => setDraft(event.target.value)}
        className="w-full rounded border border-[#2a2a2a] bg-[#0b0b0b] px-2 py-1 font-mono text-[11px] text-zinc-200"
      />
      <div className="mt-1 flex items-center gap-2">
        <button
          disabled={disabled || draft === null}
          onClick={apply}
          className="rounded bg-indigo-950/70 px-2 py-0.5 text-[11px] text-indigo-200 disabled:opacity-40"
        >
          Apply
        </button>
        <button
          disabled={draft === null}
          onClick={() => {
            setDraft(null);
            onInvalid("");
          }}
          className="rounded px-2 py-0.5 text-[11px] text-zinc-500 hover:text-zinc-200 disabled:opacity-40"
        >
          Discard
        </button>
        <details className="text-[10px] text-zinc-600">
          <summary className="cursor-pointer">Example</summary>
          <pre className="mt-1 whitespace-pre-wrap">{example}</pre>
        </details>
      </div>
    </div>
  );
}

/** A text field edited freely and applied on Enter or leaving it; invalid text is refused. */
function DraftInput({
  label,
  type,
  value,
  disabled,
  step,
  min,
  max,
  onCommit,
}: {
  label: string;
  type: "number" | "text";
  value: string;
  disabled: boolean;
  step?: number;
  min?: number;
  max?: number;
  onCommit: (text: string) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft !== null && draft !== value) onCommit(draft);
    setDraft(null);
  };
  return (
    <input
      aria-label={label}
      type={type}
      disabled={disabled}
      value={draft ?? value}
      step={step}
      min={min}
      max={max}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") commit();
        if (event.key === "Escape") setDraft(null);
      }}
      className={`rounded border border-[#2a2a2a] bg-[#111111] px-1.5 py-0.5 ${type === "number" ? "w-20" : "w-72"}`}
    />
  );
}

/**
 * The terminal's settings, owned by the terminal (`terminalSettings`, `terminalProfiles`): shown
 * and changed here through their own API, never copied.
 */
function TerminalSection({
  terminal,
  scope,
  workspace,
}: {
  terminal: { settings: TerminalSettingsStore; profiles: WorkspaceProfiles };
  scope: SettingScope;
  workspace: WorkspaceId | null;
}) {
  const { settings, profiles } = terminal;
  // Any change to the terminal's settings -- the user's or a workspace's -- redraws this.
  const [, refresh] = useReducer((n: number) => n + 1, 0);
  useEffect(() => settings.subscribe(refresh), [settings]);
  const snapshot = useSyncExternalStore(
    profiles.subscribe,
    profiles.getSnapshot,
    profiles.getSnapshot,
  );
  const workspaceIntegration =
    workspace === null ? null : settings.workspace(workspace).shellIntegration;
  const userIntegration = settings.user().shellIntegration;
  const offered = snapshot.profiles.filter((entry) => entry.scope !== "workspace");
  return (
    <section aria-label="Terminal" className="mb-5">
      <h2 className="mb-2 text-[11px] font-semibold tracking-wider text-zinc-400 uppercase">
        Terminal
      </h2>
      <div
        role="group"
        aria-label="Shell integration"
        className="mb-3 grid grid-cols-[1fr_auto] gap-x-4 rounded px-2 py-1.5"
      >
        <div>
          <div className="font-medium text-zinc-200">Shell integration</div>
          <p className="text-[11px] text-zinc-500">
            Read the folder and command boundaries a shell reports (OSC 7 and 133), for terminals
            started from now on.
          </p>
        </div>
        <div className="self-center">
          {scope === "workspace" && workspace !== null ? (
            <select
              aria-label="Shell integration"
              value={
                workspaceIntegration === null ? "inherit" : workspaceIntegration ? "on" : "off"
              }
              onChange={(event) =>
                settings.updateWorkspace(workspace, {
                  shellIntegration:
                    event.target.value === "inherit" ? null : event.target.value === "on",
                })
              }
              className="rounded border border-[#2a2a2a] bg-[#111111] px-1.5 py-0.5"
            >
              <option value="inherit">As your setting ({userIntegration ? "on" : "off"})</option>
              <option value="on">On</option>
              <option value="off">Off</option>
            </select>
          ) : (
            <input
              type="checkbox"
              aria-label="Shell integration"
              checked={userIntegration}
              onChange={(event) => settings.updateUser({ shellIntegration: event.target.checked })}
            />
          )}
        </div>
      </div>
      {scope === "user" && (
        <div
          role="group"
          aria-label="Default terminal profile"
          className="mb-3 grid grid-cols-[1fr_auto] gap-x-4 rounded px-2 py-1.5"
        >
          <div>
            <div className="font-medium text-zinc-200">Default profile</div>
            <p className="text-[11px] text-zinc-500">
              The shell a new terminal starts with. Profiles themselves are managed from the
              terminal panel (Manage Profiles…).
            </p>
          </div>
          <select
            aria-label="Default terminal profile"
            value={snapshot.userDefault ?? ""}
            onChange={(event) => profiles.registry.setUserDefault(event.target.value || null)}
            className="self-center rounded border border-[#2a2a2a] bg-[#111111] px-1.5 py-0.5"
          >
            <option value="">The platform's default</option>
            {offered.map((entry) => (
              <option key={entry.profile.id} value={entry.profile.id} disabled={!entry.available}>
                {entry.profile.name}
              </option>
            ))}
          </select>
        </div>
      )}
    </section>
  );
}
