import { useEffect, useState } from "react";
import { useCardFx } from "@/lib/fx";

/**
 * Sakura card frame for dashboard cards (when the sakura frame option is on).
 * A petal shape: two sharp corners, two round ones and a V-notch in the top edge.
 * bloom (deep rose) = template creators, petal (pale pink) = the rest.
 * The outline is built once in a 0-100 box and used for both the clip-path
 * and the SVG border, so they always match.
 */

/** How deep the round corners are (share of the card). */
const SWEEP = 26;
/** The notch in the top edge: half width and depth. */
const NOTCH_W = 7;
const NOTCH_D = 8;

const round2 = (n: number) => Math.round(n * 100) / 100;

/** A quarter ellipse in steps, in percent (stretches with the tile). */
function quarter(
  cx: number,
  cy: number,
  r: number,
  fromDeg: number,
  toDeg: number,
  steps = 8,
): [number, number][] {
  const pts: [number, number][] = [];
  for (let i = 0; i <= steps; i++) {
    const a = ((fromDeg + ((toDeg - fromDeg) * i) / steps) * Math.PI) / 180;
    pts.push([round2(cx + r * Math.cos(a)), round2(cy + r * Math.sin(a))]);
  }
  return pts;
}

const PTS: [number, number][] = [
  [0, 0], //                                    sharp corner, top-left
  [50 - NOTCH_W, 0],
  [50, NOTCH_D], //                             the petal's V-notch
  [50 + NOTCH_W, 0],
  ...quarter(100 - SWEEP, SWEEP, SWEEP, -90, 0), // swept corner, top-right
  [100, 100], //                                sharp corner, bottom-right
  ...quarter(SWEEP, 100 - SWEEP, SWEEP, 90, 180), // swept corner, bottom-left
];

/** The petal outline as % polygon for clip-path. */
export const SAKURA_CARD_CLIP = `polygon(${PTS.map(([x, y]) => `${x}% ${y}%`).join(", ")})`;

const OUTLINE_D = `M${PTS.map(([x, y]) => `${x},${y}`).join(" L")} Z`;

type Tone = "bloom" | "petal";

const INK: Record<Tone, { line: string; inner: string; glow: string }> = {
  bloom: { line: "#f472b6", inner: "rgba(255,209,227,0.6)", glow: "rgba(244,114,182,0.55)" },
  petal: { line: "#f9a8d4", inner: "rgba(255,224,238,0.45)", glow: "rgba(249,168,212,0.4)" },
};

export function SakuraCardFrame({ tone }: { tone: Tone }) {
  const ink = INK[tone];
  return (
    <svg
      aria-hidden
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      className="pointer-events-none absolute inset-0 z-20 h-full w-full"
      style={{ filter: `drop-shadow(0 0 6px ${ink.glow})` }}
    >
      {/* non-scaling-stroke keeps the lines even when stretched */}
      <path
        d={OUTLINE_D}
        fill="none"
        stroke={ink.line}
        strokeWidth={2.5}
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
      {/* a second line slightly inside (double edge) */}
      <path
        d={OUTLINE_D}
        fill="none"
        stroke={ink.inner}
        strokeWidth={1}
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
        transform="translate(50 50) scale(0.945) translate(-50 -50)"
      />
    </svg>
  );
}

/** Duration of one sheen pass (slow). Also used for the safety timer. */
const SWEEP_MS = 7000;

/** Fixed start positions and sizes of the petals (%), so they don't reshuffle. */
const PETALS = [
  { left: "18%", top: "12%", size: 9, delay: "0s", duration: "13s" },
  { left: "62%", top: "4%", size: 7, delay: "-5s", duration: "16s" },
  { left: "84%", top: "22%", size: 6, delay: "-9s", duration: "11s" },
];

/**
 * Effects inside a framed card: falling petals and sometimes a pearl band
 * crossing the art. Clipped by the petal outline.
 */
export function SakuraCardScreen({ tone }: { tone: Tone }) {
  const anim = useCardFx();
  // one pass, then a random wait, so cards never do it together
  const [sweeping, setSweeping] = useState(false);
  useEffect(() => {
    if (!anim) return;
    // running: safety timer (2x the animation) in case onAnimationEnd never fires.
    // idle: wait 15-75s.
    const delay = sweeping ? SWEEP_MS * 2 : 15_000 + Math.random() * 60_000;
    const t = setTimeout(() => setSweeping(!sweeping), delay);
    return () => clearTimeout(t);
  }, [sweeping, anim]);
  // warmer on template cards, cooler on plain ones, kept faint
  const band =
    tone === "bloom"
      ? "transparent 26%, rgba(255,209,229,0.28) 40%, rgba(244,114,182,0.22) 48%, rgba(255,255,255,0.3) 56%, transparent 70%"
      : "transparent 28%, rgba(255,235,245,0.24) 41%, rgba(201,140,255,0.18) 49%, rgba(255,255,255,0.26) 57%, transparent 72%";
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 z-[15] overflow-hidden">
      {/* mounted for one pass only, moves exactly one tile */}
      {sweeping && (
        <div
          className="absolute inset-0 mix-blend-soft-light"
          style={{
            backgroundImage: `linear-gradient(115deg, ${band})`,
            backgroundSize: "260% 100%",
            // forwards is needed, otherwise the band flashes before unmount
            animation: `micoll-sak-silk ${SWEEP_MS}ms linear 1 forwards`,
          }}
          onAnimationEnd={() => setSweeping(false)}
        />
      )}
      {PETALS.map((p) => (
        <span
          key={p.left}
          className="sak-card-petal"
          style={{
            left: p.left,
            top: p.top,
            width: `${p.size}%`,
            paddingBottom: `${p.size}%`,
            animationDelay: anim ? p.delay : undefined,
            animationDuration: anim ? p.duration : undefined,
            animationName: anim ? undefined : "none",
          }}
        />
      ))}
    </div>
  );
}
