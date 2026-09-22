import type { ReactNode } from "react";

/**
 * The shape every panel view uses when it has nothing to show.
 *
 * Deliberately says what would fill the view and what the user can do about it. The panel
 * previously shipped four views whose entire content was a sentence like "No output service
 * is connected." -- true, but it told nobody whether that was a missing feature, a missing
 * setting or a bug.
 */
export function EmptyView({
  label,
  message,
  action,
}: {
  /** Names the region for screen readers and for tests. */
  label: string;
  message: ReactNode;
  action?: ReactNode;
}) {
  return (
    <section
      aria-label={label}
      className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center"
    >
      <p className="max-w-[46ch] text-[11.5px] leading-relaxed text-zinc-500">{message}</p>
      {action}
    </section>
  );
}
