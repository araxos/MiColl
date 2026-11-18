import { useId, useState } from "react";

/** The loop of .kda-stop (index.css). */
const LOOP_S = 6;

/**
 * The holo outline MiColl logo (iridescent alternate logo, same as MiColl Mobile's
 * "Alt. icon"): the M as one outlined line, two cuts in the legs and the sparkle top
 * right. In the iridescent colours, which keep running through it in a loop (index.css
 * .kda-stop). Ids per copy so two logos don't clash.
 * Each mount starts the loop where one shared clock is, so a new page goes on with the
 * colours where the last one was instead of starting over.
 */
export function KdaMark({ className }: { className?: string }) {
  const id = useId();
  // how far the shared loop is right now (the animation starts with this mount)
  const [at] = useState(() => (performance.now() / 1000) % LOOP_S);
  const delay = (base: number) => ({ animationDelay: `${(base - at).toFixed(3)}s` });
  const g = `${id}g`;
  const m = `${id}m`;
  return (
    <svg viewBox="0 0 512 512" className={className} aria-label="MiColl">
      <defs>
        <linearGradient id={g} x1="90" y1="90" x2="430" y2="430" gradientUnits="userSpaceOnUse">
          {/* each stop walks through the colours, a quarter apart, so they run across */}
          <stop className="kda-stop" offset="0" stopColor="#c4b5fd" style={delay(0)} />
          <stop className="kda-stop" offset="0.33" stopColor="#f5c2ff" style={delay(-1.5)} />
          <stop className="kda-stop" offset="0.67" stopColor="#a7f3d0" style={delay(-3)} />
          <stop className="kda-stop" offset="1" stopColor="#bae6fd" style={delay(-4.5)} />
        </linearGradient>
        <mask id={m}>
          <rect width="512" height="512" fill="white" />
          <line x1="91.2" y1="335.3" x2="128.8" y2="264.7" stroke="black" strokeWidth="20" />
          <line x1="383.2" y1="355.3" x2="420.8" y2="284.7" stroke="black" strokeWidth="20" />
        </mask>
      </defs>
      <g
        stroke={`url(#${g})`}
        strokeWidth="24"
        fill="none"
        strokeLinecap="butt"
        strokeLinejoin="miter"
        strokeMiterlimit="10"
        mask={`url(#${m})`}
      >
        <polygon points="110,400 110,190 150,150 202,150 256,204 310,150 362,150 402,190 402,400 288,400 288,352 326,314 326,274 302,250 280,250 256,274 232,250 210,250 186,274 186,314 224,352 224,400" />
      </g>
      <polygon points="430,82 440,112 470,122 440,132 430,162 420,132 390,122 420,112" fill={`url(#${g})`} />
    </svg>
  );
}
