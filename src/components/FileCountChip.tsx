import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Images } from "lucide-react";
import { mediaStats } from "@/api/library";
import { fmtBytes } from "@/components/RewardDetails";
import { isTauri } from "@/lib/tauri";
import { useTp } from "@/lib/i18n";
import type { Reward } from "@/types";

/** Folder sizes measured on hover, per reward (until its file list changes). */
const sizes = new Map<string, { key: string; bytes: number }>();

/**
 * The file count on a reward tile. Hovering it shows the folder's size: measured on
 * the first hover (one stat per file, in the backend) and remembered after that.
 * Own tooltip (portaled, the chip row is pointer-events-none and the tile clips),
 * no title on top of it.
 */
export function FileCountChip({ reward }: { reward: Reward }) {
  const tp = useTp();
  const ref = useRef<HTMLSpanElement>(null);
  const [tip, setTip] = useState<{ left: number; top: number } | null>(null);
  const paths = reward.images.map((im) => im.path).filter((p): p is string => !!p);
  // a new file list (added / removed files) measures again
  const key = `${paths.length}:${paths[0] ?? ""}:${paths[paths.length - 1] ?? ""}`;
  // read from the cache every render, so a changed file list never shows the old size
  const known = sizes.get(reward.id);
  const bytes = known?.key === key ? known.bytes : null;
  const [, measured] = useState(0);

  const show = () => {
    const r = ref.current?.getBoundingClientRect();
    if (r) setTip({ left: r.left + r.width / 2, top: r.top });
    if (bytes != null || !isTauri() || paths.length === 0) return;
    mediaStats(paths)
      .then((s) => {
        const total = s.reduce((n, f) => n + f.size, 0);
        sizes.set(reward.id, { key, bytes: total });
        measured((n) => n + 1);
      })
      .catch(() => {});
  };

  const files = tp("{n} files", reward.imageCount);
  return (
    <>
      <span
        ref={ref}
        aria-label={bytes != null ? `${files} · ${fmtBytes(bytes)}` : files}
        // re-enable pointer events here, no stopPropagation so the tile still opens
        className="pointer-events-auto inline-flex items-center gap-1 rounded-md bg-black/65 px-1.5 py-0.5 text-[10px] font-medium text-white backdrop-blur"
        onMouseEnter={show}
        onMouseLeave={() => setTip(null)}
      >
        <Images className="h-3 w-3" />
        {reward.imageCount}
      </span>
      {tip &&
        createPortal(
          <div
            style={{ left: tip.left, top: tip.top - 8 }}
            className="pointer-events-none fixed z-[120] -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-md bg-black/90 px-2 py-1 text-[11px] font-medium tabular-nums text-white shadow-lg ring-1 ring-white/15"
          >
            {files} · {bytes != null ? fmtBytes(bytes) : "…"}
          </div>,
          document.body,
        )}
    </>
  );
}
