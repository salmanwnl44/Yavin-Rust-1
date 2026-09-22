import { EmptyView } from "./EmptyView";

/**
 * Local network services this machine is listening on.
 *
 * VS Code's Ports view publishes a local service through a dev tunnel, which needs a tunnel
 * host and a GitHub sign-in; Yavin does neither and will not pretend to. What is genuinely
 * useful locally is the detection half that VS Code already uses to decide what to forward:
 * list the ports something is listening on, name the process holding each one, and offer to
 * open, copy or stop it. That is what this view will show.
 */
export function PortsView() {
  return (
    <EmptyView
      label="Ports"
      message="No listening ports detected yet. This view will list the local services running on this machine — the port, its address and the process holding it — so you can open or stop them."
    />
  );
}
