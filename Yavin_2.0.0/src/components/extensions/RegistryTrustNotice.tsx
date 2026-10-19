import { useSyncExternalStore } from "react";
import {
  describeRegistryTrust,
  registryTrust,
} from "../../services/extensions/marketplace/registryTrust";

const TONE = {
  good: "text-emerald-400/90",
  warning: "border-amber-900/60 bg-amber-950/30 text-amber-200/90",
  error: "border-red-900/60 bg-red-950/30 text-red-300",
} as const;

/**
 * Whether the registry's index was authenticated (EXT-20), at the top of the Extensions view:
 * one quiet line when it was, a note saying why and what to do when it was not. The native
 * side refuses installs on its own; this only says so.
 */
export function RegistryTrustNotice({ store = registryTrust }: { store?: typeof registryTrust }) {
  useSyncExternalStore(store.subscribe, store.getSnapshot);
  const said = describeRegistryTrust(store.latest());
  if (!said) return null;
  const quiet = said.tone === "good";
  return (
    <div
      role={quiet ? "status" : "alert"}
      aria-label="Registry verification"
      data-testid="registry-trust"
      data-tone={said.tone}
      title={said.detail}
      className={`mx-3 mb-2 text-[10.5px] ${quiet ? TONE.good : `rounded border px-2 py-1 ${TONE[said.tone]}`}`}
    >
      <span className="font-medium">{said.title}</span>
      {quiet ? "" : <span className="block">{said.detail}</span>}
    </div>
  );
}
