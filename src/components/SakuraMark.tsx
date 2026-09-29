import { useSyncExternalStore } from "react";
import { SakuraBloom } from "@/components/SakuraBloom";
import { cn } from "@/lib/utils";
import sakuraIconUrl from "@/assets/micoll-icon-sakura.svg";

/**
 * Header logo on sakura: the sakura MiColl icon that sometimes turns into a
 * blossom and back. Random timing on purpose so it doesn't feel like a loop.
 */

/** Min/max time in each state. */
const MIN_HOLD_MS = 15_000;
const MAX_HOLD_MS = 50_000;

/* The timer lives in the module (not the component), because every page mounts a
   new header. A remount just joins the running clock. */
let bloom = false;
let timer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();

function arm() {
  const hold = MIN_HOLD_MS + Math.random() * (MAX_HOLD_MS - MIN_HOLD_MS);
  timer = setTimeout(() => {
    bloom = !bloom;
    arm(); // each turn draws its own delay
    listeners.forEach((fn) => fn());
  }, hold);
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  if (timer === undefined) arm();
  // never stopped, stopping it would reset the timing on the next page
  return () => {
    listeners.delete(fn);
  };
}

export function SakuraMark({ className }: { className?: string }) {
  const showBloom = useSyncExternalStore(
    subscribe,
    () => bloom,
    () => false,
  );

  // cross-fade with a transition, staggered in CSS so both drawings are never half visible
  return (
    <span className={cn("relative inline-flex", className)}>
      <img
        src={sakuraIconUrl}
        alt=""
        aria-hidden
        draggable={false}
        className={cn("sak-mark absolute inset-0 h-full w-full", showBloom && "sak-mark--off")}
      />
      {/* the blossom from the wallpaper (SakuraBloom) */}
      <SakuraBloom
        className={cn(
          "sak-mark sak-mark-bloom absolute inset-0 h-full w-full",
          !showBloom && "sak-mark--off sak-mark--off-bloom",
        )}
      />
    </span>
  );
}
