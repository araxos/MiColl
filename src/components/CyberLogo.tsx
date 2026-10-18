import { useCallback, useEffect, useRef, useState } from "react";
import { BrandMark } from "@/components/BrandMark";
import { useCardFx, useCardFxPref } from "@/lib/fx";
import cyberpunkIconUrl from "@/assets/icons/micoll-icon-cyberpunk.svg";

/**
 * The cyberpunk logo next to "Dashboard".
 *
 * Animations off (Settings): simply the cyberpunk app icon.
 * Animations on: the MiColl mark (BrandMark, the app icon shape) in one of three colours (acid yellow, cyan,
 * magenta), no plate behind it, always a little torn (colour ghosts, a twitch now
 * and then). Every 20-60 s it glitches hard and comes out in the next colour; hovering
 * skips the wait and fires the glitch right away. While the app idles nothing is
 * scheduled.
 */

const COLORS = ["yellow", "cyan", "pink"] as const;
const BURST_MS = 650;
// the colour changes in the middle of the burst, hidden by it
const SWAP_AT_MS = 280;

const wait = () => 20_000 + Math.random() * 40_000;

export function CyberLogo() {
  const pref = useCardFxPref();
  const live = useCardFx();
  const [color, setColor] = useState(0);
  const [burst, setBurst] = useState(false);
  const timers = useRef<number[]>([]);
  const next = useRef<number | undefined>(undefined);

  const clearAll = () => {
    timers.current.forEach((t) => window.clearTimeout(t));
    timers.current = [];
    if (next.current) window.clearTimeout(next.current);
    next.current = undefined;
  };

  const fire = useCallback(() => {
    if (next.current) window.clearTimeout(next.current);
    next.current = undefined;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced) {
      setColor((c) => (c + 1) % COLORS.length);
      return;
    }
    setBurst(true);
    timers.current.push(
      window.setTimeout(() => setColor((c) => (c + 1) % COLORS.length), SWAP_AT_MS),
      window.setTimeout(() => setBurst(false), BURST_MS),
    );
  }, []);

  // the 20-60 s clock, restarted after every glitch (also a hovered one)
  useEffect(() => {
    if (!pref || !live || burst) return;
    next.current = window.setTimeout(fire, wait());
    return () => {
      if (next.current) window.clearTimeout(next.current);
      next.current = undefined;
    };
  }, [pref, live, burst, fire, color]);

  useEffect(() => clearAll, []);

  if (!pref) {
    return <img src={cyberpunkIconUrl} alt="" draggable={false} className="h-8 w-8" />;
  }

  return (
    <span
      onMouseEnter={() => {
        if (!burst) fire();
      }}
      data-glitch={burst || undefined}
      className={`cp-logo cp-logo--${COLORS[color]} inline-flex h-8 w-8 items-center justify-center`}
    >
      <BrandMark solid="currentColor" className="h-8 w-8" />
    </span>
  );
}
