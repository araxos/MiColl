import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { DatabaseBackup, HardDrive } from "lucide-react";
import { cn } from "@/lib/utils";
import { t, tf } from "@/lib/i18n";

/** The 4 MiSD states. Icon = move or backup, color = done or queued. */
export type SdState = "marked" | "onSd" | "backupMarked" | "backedUp";

/**
 * Icon + color per state. Fixed colors (not brand-*) so they mean the same in every theme.
 */
const LOOK: Record<SdState, { Icon: typeof HardDrive; color: string }> = {
  marked: { Icon: HardDrive, color: "text-amber-300" },
  onSd: { Icon: HardDrive, color: "text-sky-300" },
  backupMarked: { Icon: DatabaseBackup, color: "text-amber-300" },
  backedUp: { Icon: DatabaseBackup, color: "text-emerald-300" },
};

/**
 * MiSD marker on month/reward cards: just a colored icon.
 * Uses a portaled tooltip because the chip row is pointer-events-none and the tile clips.
 */
export function SdBadge({
  state,
  title,
  className,
}: {
  state: SdState;
  title?: string;
  className?: string;
}) {
  const { Icon, color } = LOOK[state];
  const ref = useRef<HTMLSpanElement>(null);
  const [tip, setTip] = useState<{ left: number; top: number } | null>(null);

  const show = () => {
    const r = ref.current?.getBoundingClientRect();
    if (r) setTip({ left: r.left + r.width / 2, top: r.top });
  };

  return (
    <>
      <span
        ref={ref}
        aria-label={title}
        // re-enable pointer events here, no stopPropagation so the tile still opens
        className={cn("pointer-events-auto inline-flex shrink-0", className)}
        onMouseEnter={show}
        onMouseLeave={() => setTip(null)}
      >
        <Icon
          className={cn("h-4 w-4 drop-shadow-[0_1px_2px_rgba(0,0,0,0.9)]", color)}
          strokeWidth={2.5}
        />
      </span>
      {tip &&
        title &&
        createPortal(
          <div
            style={{ left: tip.left, top: tip.top - 8 }}
            className="pointer-events-none fixed z-[120] max-w-[18rem] -translate-x-1/2 -translate-y-full rounded-md bg-black/90 px-2 py-1 text-[11px] font-medium text-white shadow-lg ring-1 ring-white/15"
          >
            {title}
          </div>,
          document.body,
        )}
    </>
  );
}

/**
 * The MiSD marker for a reward, or null. Used by the reward tile and the month card.
 * Queued beats backed up, being on the disk beats everything.
 */
export function rewardSdState(r: {
  sdVolume?: string | null;
  sdBackup?: string | null;
  sdMarked?: boolean;
  sdBackupMarked?: boolean;
}): SdState | null {
  if (r.sdVolume) return "onSd";
  if (r.sdMarked) return "marked";
  if (r.sdBackupMarked) return "backupMarked";
  if (r.sdBackup) return "backedUp";
  return null;
}

/** Tooltip: moved = only on the disk, backed up = in both places. */
export function rewardSdTitle(
  state: SdState,
  r: { sdVolume?: string | null; sdBackup?: string | null; sdBackupAt?: string | null },
): string {
  switch (state) {
    case "onSd":
      return tf("Stored only on your MiSD disk “{volume}” — connect it to open this", {
        volume: r.sdVolume ?? "",
      });
    case "marked":
      return r.sdBackup
        ? t(
            "Marked for the next MiSD transport — the files will move to the disk and its backup will take over",
          )
        : t("Marked for the next MiSD transport — the files will move to the disk");
    case "backupMarked":
      return t("Marked for the next MiSD backup — a copy goes to the disk, the files stay here");
    case "backedUp":
      return tf("Backed up on your MiSD disk “{volume}”{when} — the files also stay here", {
        volume: r.sdBackup ?? "",
        when: r.sdBackupAt ? ` · ${r.sdBackupAt}` : "",
      });
  }
}
