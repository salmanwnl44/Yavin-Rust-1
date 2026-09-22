import { EmptyView } from "./EmptyView";

/**
 * Append-only logs from the app's own subsystems, one channel at a time -- the counterpart of
 * VS Code's Output view. The Git command log already exists (`services/git/outputLog.ts`) and
 * becomes the first channel once the channel registry lands.
 */
export function OutputView() {
  return (
    <EmptyView
      label="Output"
      message="No output channels are registered yet. This view will show the app's own logs — Git commands, file watching and task output — one channel at a time."
    />
  );
}
