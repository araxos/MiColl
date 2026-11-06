import { SdTip } from "@/components/SdBadge";
import { useAccent } from "@/lib/theme";
import { t, tf, tp } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/** none = nothing on the disk, some = part of it, all = everything. */
export type BackupState = "none" | "some" | "all";

/** What backup mode shows for these rewards (a creator's own owned ones). */
export function backupStatus(rewards: { sdBackup?: string | null; sdVolume?: string | null }[]) {
  // a moved reward can't be backed up on top, it's on the disk already
  const done = rewards.filter((r) => r.sdBackup || r.sdVolume).length;
  const total = rewards.length;
  const state: BackupState = done === 0 ? "none" : done < total ? "some" : "all";
  return { state, done, total };
}

/** Fixed colors, they mean the same in every theme. Sakura's are on light paper. */
const COLOR: Record<BackupState, string> = {
  none: "#ef4444",
  some: "#fb923c",
  all: "#34d399",
};
const COLOR_ON_PAPER: Record<BackupState, string> = {
  none: "#dc2626",
  some: "#ea580c",
  all: "#059669",
};

/** A blossom with 5 round petals, 24 units wide. */
const BLOSSOM = (() => {
  const at = (r: number, deg: number) => {
    const a = ((deg - 90) * Math.PI) / 180;
    return `${(12 + r * Math.cos(a)).toFixed(2)} ${(12 + r * Math.sin(a)).toFixed(2)}`;
  };
  let d = `M${at(9, -36)}`;
  for (let i = 0; i < 5; i++) d += `Q${at(16.5, i * 72)} ${at(9, i * 72 + 36)}`;
  return `${d}Z`;
})();

const OUTLINE: Record<string, string> = {
  cyberpunk: "M6 1H23V18L18 23H1V6Z",
  sakura: BLOSSOM,
  iridescent: "M12 1L22 6.5V17.5L12 23L2 17.5V6.5Z",
  corruptruby: "M12 .8L23.2 12L12 23.2L.8 12Z",
};
const CIRCLE = "M12 1A11 11 0 1 1 12 23A11 11 0 1 1 12 1Z";

/** The symbol for one state, in the color of the current text. */
function Glyph({ state }: { state: BackupState }) {
  if (state === "all") {
    return <path d="M7.2 12.4L10.6 15.8L16.8 8.6" fill="none" stroke="currentColor" strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round" />;
  }
  if (state === "none") {
    return <path d="M8 8L16 16M16 8L8 16" fill="none" stroke="currentColor" strokeWidth={2.6} strokeLinecap="round" />;
  }
  // half full
  return (
    <>
      <circle cx={12} cy={12} r={4.6} fill="none" stroke="currentColor" strokeWidth={1.8} />
      <path d="M12 7.4A4.6 4.6 0 0 1 12 16.6Z" fill="currentColor" />
    </>
  );
}

/** The mark without a tooltip, also the legend in Settings. */
export function BackupGlyph({ state, className }: { state: BackupState; className?: string }) {
  const accent = useAccent();
  const paper = accent === "sakura";
  const color = (paper ? COLOR_ON_PAPER : COLOR)[state];
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden
      className={cn("block overflow-visible", className)}
      style={{
        color,
        filter: `drop-shadow(0 1px 2px rgba(0,0,0,.75)) drop-shadow(0 0 ${accent === "cyberpunk" || accent === "corruptruby" ? 4 : 2}px ${color}66)`,
      }}
    >
      <path
        d={OUTLINE[accent] ?? CIRCLE}
        fill={paper ? "#fff3f8" : accent === "iridescent" ? "#1a1630" : "#0b0b10"}
        fillOpacity={paper ? 1 : 0.92}
        // Pyre: a chrome rim, a red one would vanish on its crimson frame
        stroke={accent === "corruptruby" ? "#e8e2ec" : "currentColor"}
        strokeWidth={1.5}
        strokeLinejoin="round"
      />
      {/* the crystal's facets, between the rim and the symbol */}
      {accent === "iridescent" && (
        <path
          d="M12 1V5M22 6.5L18.5 8.5M22 17.5L18.5 15.5M12 23V19M2 17.5L5.5 15.5M2 6.5L5.5 8.5"
          stroke="white"
          strokeOpacity={0.4}
          strokeWidth={0.7}
        />
      )}
      <Glyph state={state} />
    </svg>
  );
}

/**
 * Backup mode's mark on a creator card. Sits on the card's top right corner, over the
 * frames, the pin and the "?" fold (which stay readable and clickable next to it).
 */
export function BackupMark({
  rewards,
}: {
  rewards: { sdBackup?: string | null; sdVolume?: string | null }[];
}) {
  const { state, done, total } = backupStatus(rewards);
  const n = tp("{n} rewards", total);
  const title =
    total === 0
      ? t("Nothing imported yet")
      : state === "all"
        ? tf("Everything on your MiSD disk · {rewards}", { rewards: n })
        : state === "some"
          ? tf("{done} of {rewards} on your MiSD disk", { done, rewards: n })
          : tf("Nothing on your MiSD disk yet · {rewards}", { rewards: n });
  return (
    // own layer as query container, like the class icon: follows the card size
    <div className="pointer-events-none absolute inset-0 z-40 [container-type:size]">
      <SdTip title={title} className="absolute right-0 top-0 translate-x-[30%] -translate-y-[30%]">
        <BackupGlyph state={state} className="h-[clamp(16px,11.5cqw,28px)] w-[clamp(16px,11.5cqw,28px)]" />
      </SdTip>
    </div>
  );
}
