import { useState, useSyncExternalStore } from "react";
import type { ProfileStore } from "../../services/extensions/profiles";

/**
 * The extension profiles (EXT-13), in the Extensions view: which one is active (for the whole
 * application), switching to another -- after which extensions are reloaded with its enabled
 * set -- and creating, renaming and deleting them. Every change is the native side's, shown
 * once it answered; what a switch leaves unable to load is said.
 */
export function ExtensionProfiles({
  store,
  onSwitched,
}: {
  store: ProfileStore;
  /** After a switch: extensions are reloaded. */
  onSwitched: () => Promise<unknown>;
}) {
  const view = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const [name, setName] = useState("");
  const [renaming, setRenaming] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const act = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await work();
    } catch (failure) {
      setError(String((failure as Error)?.message ?? failure).replace(/^[A-Za-z]+: /, ""));
    } finally {
      setBusy(false);
    }
  };
  if (!view) return null;
  return (
    <section
      aria-label="Extension profiles"
      className="mx-3 mt-3 rounded border border-zinc-800 px-2 py-1.5 text-[11px] text-zinc-400"
    >
      <div className="mb-1 text-[10.5px] font-semibold tracking-wider text-zinc-500 uppercase">
        Extension profiles
      </div>
      <ul className="mb-1.5">
        {view.profiles.map((profile) => (
          <li
            key={profile.id}
            className="flex items-center gap-2 py-0.5"
            data-active={profile.id === view.active}
          >
            {renaming === profile.id ? (
              <input
                aria-label={`New name for ${profile.name}`}
                defaultValue={profile.name}
                autoFocus
                className="min-w-0 flex-1 rounded border border-zinc-700 bg-transparent px-1 text-zinc-200"
                onKeyDown={(event) => {
                  if (event.key === "Escape") setRenaming(null);
                  if (event.key === "Enter") {
                    const value = event.currentTarget.value;
                    setRenaming(null);
                    void act(() => store.rename(profile.id, value));
                  }
                }}
              />
            ) : (
              <span
                className={`min-w-0 flex-1 truncate ${profile.id === view.active ? "text-zinc-100" : ""}`}
              >
                {profile.name}
                {profile.id === view.active ? " (active)" : ""}
              </span>
            )}
            {profile.id !== view.active && (
              <button
                disabled={busy}
                className="hover:text-zinc-200 disabled:opacity-50"
                aria-label={`Switch to ${profile.name}`}
                onClick={() =>
                  void act(async () => {
                    const switched = await store.select(profile.id);
                    await onSwitched();
                    if (switched.unavailable.length)
                      setNotice(
                        `Not available in this profile: ${switched.unavailable
                          .map((one) => `${one.id} (${one.reason.replace(/^[A-Za-z]+: /, "")})`)
                          .join("; ")}`,
                      );
                  })
                }
              >
                Switch
              </button>
            )}
            <button
              disabled={busy}
              className="hover:text-zinc-200 disabled:opacity-50"
              aria-label={`Rename ${profile.name}`}
              onClick={() => setRenaming(profile.id)}
            >
              Rename
            </button>
            {profile.id !== "default" && profile.id !== view.active && (
              <button
                disabled={busy}
                className="hover:text-red-300 disabled:opacity-50"
                aria-label={`Delete ${profile.name}`}
                onClick={() => void act(() => store.remove(profile.id))}
              >
                Delete
              </button>
            )}
          </li>
        ))}
      </ul>
      <form
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          const value = name;
          void act(async () => {
            await store.create(value);
            setName("");
          });
        }}
      >
        <input
          aria-label="New profile name"
          value={name}
          placeholder="New profile"
          onChange={(event) => setName(event.target.value)}
          className="min-w-0 flex-1 rounded border border-zinc-700 bg-transparent px-1 text-zinc-200"
        />
        <button
          type="submit"
          disabled={busy || !name.trim()}
          className="hover:text-zinc-200 disabled:opacity-50"
        >
          Create
        </button>
      </form>
      {error && (
        <p role="alert" className="mt-1 text-red-400/90">
          {error}
        </p>
      )}
      {notice && (
        <p data-testid="profile-notice" className="mt-1 text-amber-300/90">
          {notice}
        </p>
      )}
    </section>
  );
}

/**
 * The active extension profile, always in view at the top of the Extensions view (EXT-18), and
 * switching to another -- as in the profiles section, which Manage shows (create, rename, delete).
 */
export function ProfileSwitcher({
  store,
  onSwitched,
  managing,
  onManage,
}: {
  store: ProfileStore;
  onSwitched: () => Promise<unknown>;
  managing: boolean;
  onManage: () => void;
}) {
  const view = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!view) return null;
  return (
    <div className="shrink-0 px-3 pb-2 text-[11px] text-zinc-500">
      <div className="flex items-center gap-2">
        <label className="flex min-w-0 flex-1 items-center gap-1.5">
          <span className="shrink-0">Profile</span>
          <select
            aria-label="Active extension profile"
            value={view.active}
            disabled={busy}
            onChange={(event) => {
              const id = event.target.value;
              setBusy(true);
              setError(null);
              store
                .select(id)
                .then(() => onSwitched())
                .catch((failure: unknown) =>
                  setError(
                    String((failure as Error)?.message ?? failure).replace(/^[A-Za-z]+: /, ""),
                  ),
                )
                .finally(() => setBusy(false));
            }}
            className="min-w-0 flex-1 truncate rounded border border-zinc-800 bg-[#0b0b0b] px-1 py-0.5 text-zinc-200"
          >
            {view.profiles.map((profile) => (
              <option key={profile.id} value={profile.id}>
                {profile.name}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          aria-expanded={managing}
          aria-label="Manage extension profiles"
          onClick={onManage}
          className="shrink-0 rounded px-1.5 py-0.5 hover:bg-zinc-900 hover:text-zinc-200"
        >
          Manage
        </button>
      </div>
      {busy && (
        <p role="status" className="mt-0.5">
          Switching…
        </p>
      )}
      {error && (
        <p role="alert" className="mt-0.5 text-red-400">
          {error}
        </p>
      )}
    </div>
  );
}
