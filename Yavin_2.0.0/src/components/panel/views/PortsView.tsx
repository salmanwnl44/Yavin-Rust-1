import { useCallback, useEffect, useState } from "react";
import { native } from "../../../services/native";
import type { ListeningPort } from "../../../services/native";
import { EmptyView } from "./EmptyView";

/** A localhost URL for a port, which is what "open" means for a service on this machine. */
function addressFor(port: ListeningPort): string {
  return `http://localhost:${port.port}`;
}

/**
 * Local network services this machine is listening on.
 *
 * VS Code's Ports view publishes a local service through a dev tunnel, which needs a tunnel
 * host and a GitHub sign-in; Yavin does neither and does not pretend to. What is genuinely
 * useful locally is the detection half VS Code itself uses to decide what to forward: list the
 * ports something is listening on, name the process holding each, and offer to open, copy or
 * stop it.
 */
export function PortsView() {
  const [ports, setPorts] = useState<ListeningPort[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(0);

  const refresh = useCallback(async () => {
    setBusy(true);
    try {
      setPorts(await native("list_listening_ports"));
      setError("");
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    // Ports come and go as servers start and stop, so the list refreshes itself. Five seconds
    // matches the Source Control poll and is far cheaper than it.
    const timer = setInterval(() => void refresh(), 5000);
    return () => clearInterval(timer);
  }, [refresh]);

  const stop = async (port: ListeningPort) => {
    if (
      !window.confirm(
        `Stop ${port.process || "the process"} listening on port ${port.port}? Any unsaved work in it is lost.`,
      )
    )
      return;
    try {
      await native("stop_listening_process", { port: port.port });
      await refresh();
    } catch (reason) {
      setError(String(reason));
    }
  };

  if (ports === null && !error)
    return <EmptyView label="Ports" message="Looking for local services…" />;

  if (error && !ports?.length)
    return (
      <EmptyView
        label="Ports"
        message={`Local services could not be listed. ${error}`}
        action={
          <button
            onClick={() => void refresh()}
            className="rounded bg-indigo-600 px-3 py-1 text-[11px] font-medium text-white hover:bg-indigo-500"
          >
            Try Again
          </button>
        }
      />
    );

  if (!ports?.length)
    return (
      <EmptyView
        label="Ports"
        message="Nothing on this machine is listening on a TCP port. Start a dev server and it will appear here."
        action={
          <button
            onClick={() => void refresh()}
            className="rounded bg-indigo-600 px-3 py-1 text-[11px] font-medium text-white hover:bg-indigo-500"
          >
            Refresh
          </button>
        }
      />
    );

  return (
    <section aria-label="Ports" className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-[#141414] px-3 py-1">
        <span className="text-[11px] text-zinc-500">
          {ports.length} local service{ports.length === 1 ? "" : "s"}
        </span>
        {error && <span className="truncate text-[11px] text-red-400">{error}</span>}
        <button
          onClick={() => void refresh()}
          disabled={busy}
          className="ml-auto rounded px-2 py-0.5 text-[11px] text-zinc-500 hover:text-zinc-200 disabled:opacity-40"
        >
          Refresh
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-full text-left text-[11px]">
          <thead className="sticky top-0 bg-[#030303] text-zinc-500">
            <tr>
              <th scope="col" className="px-3 py-1 font-medium">
                Port
              </th>
              <th scope="col" className="px-3 py-1 font-medium">
                Address
              </th>
              <th scope="col" className="px-3 py-1 font-medium">
                Running Process
              </th>
              <th scope="col" className="px-3 py-1 font-medium">
                Origin
              </th>
              <th scope="col" className="px-3 py-1" />
            </tr>
          </thead>
          <tbody>
            {ports.map((port) => (
              <tr key={`${port.port}:${port.pid}`} className="group/row hover:bg-[#0c0c0c]">
                <td className="px-3 py-1 font-mono text-zinc-200">{port.port}</td>
                <td className="px-3 py-1 font-mono text-zinc-400">{addressFor(port)}</td>
                <td className="px-3 py-1 text-zinc-300">
                  {port.process || <span className="text-zinc-600">Unknown</span>}
                  <span className="ml-1.5 text-zinc-600">pid {port.pid}</span>
                </td>
                <td className="px-3 py-1 text-zinc-500">
                  {/* Everything here was found by looking, not forwarded by the user. */}
                  Detected
                </td>
                <td className="px-3 py-1">
                  <div className="flex items-center justify-end gap-1 opacity-0 transition-opacity group-hover/row:opacity-100 focus-within:opacity-100">
                    <button
                      title={`Open ${addressFor(port)} in your browser`}
                      aria-label={`Open port ${port.port} in your browser`}
                      onClick={() =>
                        void native("open_external_url", { url: addressFor(port) }).catch(
                          (reason) => setError(String(reason)),
                        )
                      }
                      className="rounded px-1.5 py-0.5 text-zinc-500 hover:bg-[#161616] hover:text-zinc-200"
                    >
                      Open
                    </button>
                    <button
                      title="Copy the address"
                      aria-label={`Copy the address for port ${port.port}`}
                      onClick={() =>
                        void navigator.clipboard.writeText(addressFor(port)).then(
                          () => {
                            setCopied(port.port);
                            setTimeout(() => setCopied(0), 1500);
                          },
                          () => setError("The clipboard is not available."),
                        )
                      }
                      className="rounded px-1.5 py-0.5 text-zinc-500 hover:bg-[#161616] hover:text-zinc-200"
                    >
                      {copied === port.port ? "Copied" : "Copy"}
                    </button>
                    <button
                      title={`Stop the process listening on port ${port.port}`}
                      aria-label={`Stop the process on port ${port.port}`}
                      onClick={() => void stop(port)}
                      className="rounded px-1.5 py-0.5 text-zinc-500 hover:bg-[#161616] hover:text-red-400"
                    >
                      Stop
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
