import { useEffect, useState } from "react";
import type { ExtensionMarketplaceService } from "../../services/extensions/marketplace/service";

const TONES = ["#4f46e5", "#0891b2", "#059669", "#d97706", "#db2777", "#7c3aed", "#2563eb"];

/**
 * An extension's icon: the marketplace's (a `data:` URL fetched natively), or a lettered tile
 * when there is none -- never an image from the network.
 */
export function ExtensionIcon({
  id,
  name,
  marketplace,
  size = 36,
}: {
  id: string;
  name: string;
  marketplace: ExtensionMarketplaceService;
  size?: number;
}) {
  const [source, setSource] = useState<string | null>(null);
  const provider = marketplace.provider;
  useEffect(() => {
    let live = true;
    setSource(null);
    void marketplace.getIcon(id).then((found) => {
      if (live && found?.startsWith("data:image/png;base64,")) setSource(found);
    });
    return () => {
      live = false;
    };
  }, [id, marketplace, provider]);
  if (source)
    return (
      <img
        src={source}
        alt=""
        width={size}
        height={size}
        className="shrink-0 rounded-md"
        draggable={false}
      />
    );
  const tone = TONES[[...id].reduce((sum, c) => sum + c.charCodeAt(0), 0) % TONES.length];
  return (
    <div
      aria-hidden
      style={{ width: size, height: size, background: tone }}
      className="flex shrink-0 items-center justify-center rounded-md text-[14px] font-semibold text-white/90"
    >
      {(name.trim()[0] ?? "?").toUpperCase()}
    </div>
  );
}
