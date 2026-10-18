import { useState } from "react";
import { describeCapability } from "../../services/extensions/permissions";
import type { ExtensionRegistry, RegisteredExtension } from "../../services/extensions/registry";
import { CardButton } from "./ExtensionCard";

/**
 * An installed extension's permissions (EXT-07), on its page: what it requests, what of it is
 * allowed for this version, and Allow / Revoke. What shows as allowed is what the native
 * inventory confirmed -- a change is "Saving…" until it answers, and a refusal says so. The
 * native side enforces it; this is where the user decides.
 */
export function ExtensionPermissions({
  entry,
  registry,
}: {
  entry: RegisteredExtension;
  registry: ExtensionRegistry;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Without code nothing can ask for anything.
  if (!entry.manifest.main) return null;
  const { requested, legacy } = entry.manifest.permissions;
  const granted = entry.grants.granted;
  const previous = entry.grants.previous;
  const name = entry.manifest.displayName;
  const set = (next: readonly string[]) => {
    setSaving(true);
    setError(null);
    registry
      .grant(entry.id, next)
      .catch((reason: unknown) => setError((reason as Error)?.message ?? String(reason)))
      .finally(() => setSaving(false));
  };
  return (
    <section
      aria-label="Permissions"
      className="mx-8 mt-3 rounded border border-[#1f1f1f] bg-[#080808] px-3 py-2 text-[12px]"
    >
      <h3 className="mb-1 text-[11px] font-semibold tracking-wider text-zinc-500 uppercase">
        Permissions
      </h3>
      {legacy && (
        <p role="note" className="mb-1 text-amber-200/90">
          Made before Yavin's permissions: it may use what extensions could before. It is allowed
          none of it until you allow it.
        </p>
      )}
      {requested.length === 0 ? (
        <p className="text-zinc-500">
          It asks for nothing beyond its own commands, views, settings and storage.
        </p>
      ) : (
        <ul className="flex flex-col gap-1">
          {requested.map((capability) => {
            const said = describeCapability(capability);
            const allowed = granted.includes(capability);
            return (
              <li
                key={capability}
                data-testid="permission"
                data-capability={capability}
                className="flex items-center gap-3"
              >
                <span className="min-w-0 flex-1">
                  <span className="text-zinc-200">{said.title}</span>
                  <span className="block text-[11px] text-zinc-500">{said.detail}</span>
                </span>
                <span
                  data-testid="permission-state"
                  className={allowed ? "text-emerald-400/90" : "text-zinc-500"}
                >
                  {allowed ? "Allowed" : "Not allowed"}
                </span>
                <CardButton
                  label={`${allowed ? "Revoke" : "Allow"}: ${said.title}`}
                  disabled={saving}
                  onClick={() =>
                    set(
                      allowed
                        ? granted.filter((one) => one !== capability)
                        : [...granted, capability],
                    )
                  }
                >
                  {allowed ? "Revoke" : "Allow"}
                </CardButton>
              </li>
            );
          })}
        </ul>
      )}
      <div className="mt-1 flex flex-wrap items-center gap-2">
        {requested.length > 1 && requested.some((one) => !granted.includes(one)) && (
          <CardButton
            label={`Allow everything ${name} requests`}
            disabled={saving}
            onClick={() => set(requested)}
          >
            Allow all
          </CardButton>
        )}
        {granted.length > 1 && (
          <CardButton
            label={`Revoke every permission of ${name}`}
            disabled={saving}
            onClick={() => set([])}
          >
            Revoke all
          </CardButton>
        )}
        {saving && <span className="text-zinc-500">Saving…</span>}
      </div>
      {previous && previous.granted.length > 0 && (
        <p data-testid="permission-previous" className="mt-1 text-zinc-500">
          Version {previous.version} was allowed:{" "}
          {previous.granted.map((one) => describeCapability(one).title.toLowerCase()).join("; ")}.
          This version is allowed only what you allow it.
        </p>
      )}
      {error && (
        <p role="alert" className="mt-1 text-red-300">
          Not changed: {error}
        </p>
      )}
    </section>
  );
}
