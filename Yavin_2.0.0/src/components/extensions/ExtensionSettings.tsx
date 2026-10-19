import { useEffect, useReducer, useState, useSyncExternalStore } from "react";
import type { RegisteredExtension, ExtensionRegistry } from "../../services/extensions/registry";
import type { ProfileStore } from "../../services/extensions/profiles";
import type { SettingsRegistry } from "../../services/settings/settings";
import type { WorkspaceId } from "../../services/terminalProtocol";
import {
  inheritedAt,
  overriddenAt,
  profileChanges,
  readDraft,
  rowsOf,
  shown,
  shownAt,
  type SettingDraft,
  type SettingLayer,
  type SettingRow,
} from "../../services/extensions/extensionSettings";
import { CardButton } from "./ExtensionCard";

const SOURCE: Record<SettingRow["source"], string> = {
  workspace: "this workspace",
  profile: "this profile",
  user: "your user settings",
  default: "its default",
};

/**
 * An extension's settings (EXT-18), on its page: what each is now and where that comes from --
 * this workspace, the active extension profile, the user's settings, or its default -- edited
 * for the active profile or for the user (every profile), with Save, Cancel and Reset. Nothing
 * is kept here but the edits not yet saved: the profile's values are the native inventory's
 * (checked there again, all or none, against the values they replace), the user's are the
 * settings registry's. A refused save keeps every edit, and says why.
 */
export function ExtensionSettings({
  entry,
  registry,
  settings,
  workspace,
  profiles,
  onSwitched,
  onManageProfiles,
}: {
  entry: RegisteredExtension;
  registry: ExtensionRegistry;
  settings: SettingsRegistry;
  workspace: WorkspaceId | null;
  profiles: ProfileStore;
  /** After a profile switch: extensions are reloaded with its enabled set. */
  onSwitched: () => Promise<unknown>;
  /** Shows where profiles are created, renamed and deleted. */
  onManageProfiles?: () => void;
}) {
  const view = useSyncExternalStore(profiles.subscribe, profiles.getSnapshot);
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    const stops = [settings.subscribe(null, redraw), settings.onDefinitions(redraw)];
    if (workspace !== null) stops.push(settings.subscribe(workspace, redraw));
    return () => stops.forEach((stop) => stop());
  }, [settings, workspace]);
  const [layer, setLayer] = useState<SettingLayer>("profile");
  const [drafts, setDrafts] = useState<Record<string, SettingDraft>>({});
  const [problems, setProblems] = useState<Record<string, string>>({});
  const [state, setState] = useState<
    | { kind: "idle" }
    | { kind: "saving" }
    | { kind: "saved"; text: string }
    | { kind: "failed"; text: string }
  >({ kind: "idle" });

  const declared = entry.manifest.contributes.settings;
  const name = entry.manifest.displayName;
  if (!view)
    return (
      <p role="status" className="text-[12.5px] text-zinc-500">
        Loading settings…
      </p>
    );
  if (declared.length === 0)
    return (
      <p data-testid="settings-empty" className="text-[12.5px] text-zinc-500">
        {name} has no settings.
      </p>
    );

  const active = view.profiles.find((one) => one.id === view.active);
  const rows = rowsOf(
    declared,
    settings,
    (id) => registry.settingDefinition(id),
    workspace,
    view.settings[entry.id] ?? {},
  );
  const dirty = Object.keys(drafts).length > 0;
  const busy = state.kind === "saving";
  const edit = (id: string, draft: SettingDraft | null) => {
    setDrafts((all) => {
      const next = { ...all };
      if (draft) next[id] = draft;
      else delete next[id];
      return next;
    });
    setProblems((all) => {
      const next = { ...all };
      delete next[id];
      return next;
    });
    if (state.kind !== "saving") setState({ kind: "idle" });
  };
  const cancel = () => {
    setDrafts({});
    setProblems({});
    setState({ kind: "idle" });
  };

  const save = async () => {
    if (layer === "user") {
      // The user level is this window's settings registry: checked by it, applied at once.
      const found: Record<string, string> = {};
      const apply: (() => void)[] = [];
      for (const row of rows) {
        const draft = drafts[row.setting.id];
        const definition = registry.settingDefinition(row.setting.id);
        if (!draft || !definition) continue;
        if (draft.kind === "reset") apply.push(() => settings.reset(definition, "user"));
        else {
          const read = readDraft(row.setting, draft.raw);
          if (!read.ok) found[row.setting.id] = read.error;
          else apply.push(() => settings.set(definition, "user", read.value));
        }
      }
      if (Object.keys(found).length) {
        setProblems(found);
        setState({ kind: "failed", text: "Nothing was saved: correct the values marked below." });
        return;
      }
      try {
        apply.forEach((one) => one());
        setDrafts({});
        setState({ kind: "saved", text: "Saved in your user settings (every profile)." });
      } catch (error) {
        setState({ kind: "failed", text: `Not saved: ${(error as Error).message}` });
      }
      return;
    }
    const { changes, problems: found } = profileChanges(rows, drafts);
    if (Object.keys(found).length) {
      setProblems(found);
      setState({ kind: "failed", text: "Nothing was saved: correct the values marked below." });
      return;
    }
    setState({ kind: "saving" });
    try {
      await profiles.saveSettings(entry.id, view.active, changes);
      setDrafts({});
      setState({ kind: "saved", text: `Saved in the profile "${active?.name ?? view.active}".` });
    } catch (error) {
      const message = String((error as Error)?.message ?? error);
      // Another window changed the profile or a value meanwhile: show what is there now; the
      // edits stay, to be saved again against it.
      if (/^(ProfileChanged|SettingChanged)/.test(message))
        await profiles.refresh().catch(() => undefined);
      setState({ kind: "failed", text: `Not saved: ${message.replace(/^[A-Za-z]+: /, "")}` });
    }
  };

  return (
    <div data-testid="extension-settings" className="text-[12.5px]">
      <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-2 rounded border border-[#1f1f1f] bg-[#080808] px-3 py-2">
        <label className="flex items-center gap-2 text-zinc-400">
          Extension profile
          <select
            aria-label="Extension profile"
            value={view.active}
            disabled={dirty || busy}
            title={dirty ? "Save or cancel your changes first" : undefined}
            onChange={(event) => {
              const id = event.target.value;
              setState({ kind: "saving" });
              profiles
                .select(id)
                .then(() => onSwitched())
                .then(() => setState({ kind: "idle" }))
                .catch((error: unknown) =>
                  setState({
                    kind: "failed",
                    text: `Not switched: ${String((error as Error)?.message ?? error).replace(/^[A-Za-z]+: /, "")}`,
                  }),
                );
            }}
            className="rounded border border-[#2a2a2a] bg-[#111111] px-1.5 py-0.5 text-zinc-200"
          >
            {view.profiles.map((one) => (
              <option key={one.id} value={one.id}>
                {one.name}
              </option>
            ))}
          </select>
        </label>
        {onManageProfiles && (
          <button
            type="button"
            onClick={onManageProfiles}
            className="text-[11.5px] text-indigo-300 hover:underline"
          >
            Manage profiles
          </button>
        )}
        <div role="radiogroup" aria-label="Change settings for" className="ml-auto flex gap-1">
          {(
            [
              ["profile", `This profile (${active?.name ?? view.active})`],
              ["user", "All profiles (user settings)"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={layer === value}
              disabled={dirty || busy}
              title={dirty ? "Save or cancel your changes first" : undefined}
              onClick={() => setLayer(value)}
              className={`rounded px-2 py-0.5 text-[11.5px] ${layer === value ? "bg-indigo-500/20 text-indigo-200" : "text-zinc-400 hover:bg-[#151515]"} disabled:opacity-50`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <p className="mb-3 text-[11.5px] text-zinc-500">
        A value set for this workspace wins; then the active profile's; then your user settings;
        then the extension's default.{" "}
        {layer === "profile"
          ? `Changes apply to the profile "${active?.name ?? view.active}" only.`
          : "Changes apply in every profile that does not set its own value."}
      </p>

      {rows.map((row) => (
        <SettingField
          key={row.setting.id}
          row={row}
          layer={layer}
          draft={drafts[row.setting.id]}
          problem={problems[row.setting.id]}
          disabled={busy || (layer === "user" && !row.user.known)}
          onDraft={(draft) => edit(row.setting.id, draft)}
        />
      ))}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <CardButton
          primary
          label={`Save settings of ${name}`}
          disabled={!dirty || busy}
          onClick={() => void save()}
        >
          {busy ? "Saving…" : "Save"}
        </CardButton>
        <CardButton
          label={`Cancel changes to ${name}'s settings`}
          disabled={!dirty || busy}
          onClick={cancel}
        >
          Cancel
        </CardButton>
        {dirty && !busy && (
          <span className="text-[11.5px] text-amber-300/90">
            {Object.keys(drafts).length} unsaved change{Object.keys(drafts).length === 1 ? "" : "s"}
          </span>
        )}
        {state.kind === "saved" && (
          <span
            role="status"
            data-testid="settings-saved"
            className="text-[11.5px] text-emerald-400/90"
          >
            {state.text}
          </span>
        )}
        {state.kind === "failed" && (
          <span role="alert" data-testid="settings-failed" className="text-[11.5px] text-red-300">
            {state.text}
          </span>
        )}
      </div>
    </div>
  );
}

function SettingField({
  row,
  layer,
  draft,
  problem,
  disabled,
  onDraft,
}: {
  row: SettingRow;
  layer: SettingLayer;
  draft: SettingDraft | undefined;
  problem: string | undefined;
  disabled: boolean;
  onDraft: (draft: SettingDraft | null) => void;
}) {
  const { setting } = row;
  const inherited = inheritedAt(row, layer);
  const own = overriddenAt(row, layer);
  const base = shownAt(row, layer);
  const value =
    draft?.kind === "set" ? draft.raw : draft?.kind === "reset" ? inherited.value : base;
  const set = (raw: unknown) => {
    // Back to what it is (a number field's text compared as text): no change.
    if (String(raw) === String(base)) onDraft(null);
    else onDraft({ kind: "set", raw });
  };
  const label = setting.title;
  const invalid = draft?.kind === "set" ? readDraft(setting, draft.raw) : null;
  const shownProblem = problem ?? (invalid && !invalid.ok ? invalid.error : undefined);
  return (
    <div
      role="group"
      aria-label={label}
      data-testid="extension-setting"
      data-setting={setting.id}
      className={`mb-2 grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 rounded px-2 py-1.5 ${draft ? "bg-amber-500/5 ring-1 ring-amber-500/20" : "hover:bg-[#0a0a0a]"}`}
    >
      <div className="min-w-0">
        <div className="font-medium text-zinc-200">
          {setting.title}
          <span className="ml-2 text-[10px] font-normal break-all text-zinc-600">{setting.id}</span>
        </div>
        <p className="text-[11.5px] text-zinc-500">{setting.description}</p>
        <p data-testid="setting-source" className="text-[11px] text-zinc-500">
          Now {shown(row.value)}, from {SOURCE[row.source]}.
          {row.source === "workspace" &&
            " This workspace's value wins over the profile and user settings (change it in Settings, Workspace)."}
          {row.profile.set && !row.profile.valid && (
            <span data-testid="setting-stale" className="block text-amber-300/90">
              This profile keeps {shown(row.profile.value)}, which is not a valid value now, so it
              is not used. Reset it.
            </span>
          )}
        </p>
        <p data-testid="setting-layers" className="text-[11px] text-zinc-600">
          Default {shown(row.default)}
          {row.user.known ? ` · user ${row.user.set ? shown(row.user.value) : "not set"}` : ""}
          {` · profile ${row.profile.set ? shown(row.profile.value) : "not set"}`}
          {!row.user.known &&
            layer === "user" &&
            " · enable the extension to change its user setting"}
        </p>
        {draft && (
          <p data-testid="setting-draft" className="text-[11px] text-amber-300/90">
            {draft.kind === "reset"
              ? `Will be reset: ${inherited.from === "user" ? "your user setting" : "its default"} (${shown(inherited.value)}) applies.`
              : "Changed, not saved."}
          </p>
        )}
        {shownProblem && (
          <p role="alert" data-testid="setting-problem" className="text-[11px] text-red-400">
            {shownProblem}
          </p>
        )}
      </div>
      <div className="flex items-center gap-2 self-center">
        {setting.type === "boolean" && (
          <input
            type="checkbox"
            aria-label={label}
            disabled={disabled}
            checked={value === true}
            onChange={(event) => set(event.target.checked)}
          />
        )}
        {setting.type === "enum" && (
          <select
            aria-label={label}
            disabled={disabled}
            value={String(value)}
            onChange={(event) => set(event.target.value)}
            className="rounded border border-[#2a2a2a] bg-[#111111] px-1.5 py-0.5"
          >
            {setting.values.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        )}
        {(setting.type === "number" || setting.type === "string") && (
          <input
            aria-label={label}
            aria-invalid={!!shownProblem}
            type={setting.type === "number" ? "number" : "text"}
            disabled={disabled}
            value={String(value ?? "")}
            min={setting.minimum ?? undefined}
            max={setting.maximum ?? undefined}
            onChange={(event) => set(event.target.value)}
            className={`rounded border bg-[#111111] px-1.5 py-0.5 ${shownProblem ? "border-red-500/70" : "border-[#2a2a2a]"} ${setting.type === "number" ? "w-24" : "w-64"}`}
          />
        )}
        <button
          type="button"
          aria-label={`Reset ${label}`}
          title={
            layer === "profile"
              ? "Remove this profile's value: your user setting, or the default, applies"
              : "Remove your user value: the default applies"
          }
          disabled={disabled || (!own && draft?.kind !== "set")}
          onClick={() => onDraft(own ? { kind: "reset" } : null)}
          className="rounded px-1.5 text-[11px] text-zinc-500 hover:bg-[#1c1c1c] hover:text-zinc-200 disabled:opacity-30"
        >
          Reset
        </button>
      </div>
    </div>
  );
}
