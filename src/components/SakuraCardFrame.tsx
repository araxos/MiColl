import { useEffect, useId, useMemo, useState, type CSSProperties } from "react";
import { useFx } from "@/lib/fx";

/**
 * Sakura card frame for dashboard cards (when the sakura frame option is on).
 * Kumiko corners: a fine rose line around the card and, on each corner, a Japanese
 * corner fitting (two parallel L-lines) with a cherry blossom sitting on its tip, big
 * ones top left / bottom right, small ones on the other two corners.
 * The fittings and blossoms keep their pixel size whatever the card size (each corner
 * is its own small SVG), only the fine line stretches with the card.
 * bloom (deep rose) = template creators, petal (pale pink) = the rest.
 */

/** The card stays a plain rectangle (only a hair of rounding), so nothing is cut off. */
export const SAKURA_CARD_CLIP = "inset(0 round 3px)";

type Tone = "bloom" | "petal";

const INK: Record<
  Tone,
  { from: string; mid: string; to: string; inner: string; line: string; glow: string; petal: [string, string, string]; heart: string }
> = {
  bloom: {
    from: "#ffe1ee",
    mid: "#f472b6",
    to: "#d6418f",
    inner: "rgba(255,209,227,0.6)",
    line: "rgba(244,114,182,0.5)",
    glow: "rgba(244,114,182,0.5)",
    petal: ["#fff3f8", "#ffc8e1", "#f58cbe"],
    heart: "#d6418f",
  },
  petal: {
    from: "#fff0f7",
    mid: "#f9a8d4",
    to: "#e9b9d0",
    inner: "rgba(255,224,238,0.5)",
    line: "rgba(249,168,212,0.4)",
    glow: "rgba(249,168,212,0.38)",
    petal: ["#fff7fb", "#ffd9ea", "#f9a8d4"],
    heart: "#ec6aa8",
  },
};

/** One petal with the notch at its tip (0-100 box, centre 50/50). */
const PETAL = "M50 57 C 38 50, 33 31, 39 12 L 50 21 L 61 12 C 67 31, 62 50, 50 57 Z";

/** Corner fitting size and blossom sizes, in px. */
const ARM = 34;
const BIG = 20;
const SMALL = 14;
/** How far the fine line and the fittings sit inside the card edge (as in the sketch). */
const INSET = 10;

type Corner = "tl" | "tr" | "bl" | "br";

function Fitting({ corner, tone }: { corner: Corner; tone: Tone }) {
  const ink = INK[tone];
  const id = useId();
  const big = corner === "tl" || corner === "br";
  const size = big ? BIG : SMALL;
  // the blossom's heart sits right on the fitting's corner
  const tip = 1;
  // the fitting is drawn for the top-left corner and mirrored into the others
  const sx = corner === "tr" || corner === "br" ? -1 : 1;
  const sy = corner === "bl" || corner === "br" ? -1 : 1;
  const turn = { tl: 0, tr: 20, bl: -20, br: 40 }[corner];
  const pos: CSSProperties = {
    width: ARM + 6,
    height: ARM + 6,
    // viewBox x/y = 1 (the outer L) lands on INSET
    [corner[0] === "t" ? "top" : "bottom"]: INSET - 4,
    [corner[1] === "l" ? "left" : "right"]: INSET - 4,
  };
  return (
    <svg aria-hidden className="absolute overflow-visible" style={pos} viewBox={`-3 -3 ${ARM + 6} ${ARM + 6}`}>
      <defs>
        <linearGradient id={`${id}l`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor={ink.from} />
          <stop offset="0.5" stopColor={ink.mid} />
          <stop offset="1" stopColor={ink.to} />
        </linearGradient>
        <linearGradient id={`${id}p`} x1="0" y1="1" x2="0" y2="0">
          <stop offset="0" stopColor={ink.petal[0]} />
          <stop offset="0.55" stopColor={ink.petal[1]} />
          <stop offset="1" stopColor={ink.petal[2]} />
        </linearGradient>
      </defs>
      <g transform={`translate(${sx < 0 ? ARM : 0} ${sy < 0 ? ARM : 0}) scale(${sx} ${sy})`}>
        <path d={`M1 ${ARM} V1 H${ARM}`} fill="none" stroke={`url(#${id}l)`} strokeWidth={2.4} />
        <path d={`M7 ${ARM} V7 H${ARM}`} fill="none" stroke={ink.inner} strokeWidth={1} />
        {/* the blossom on the fitting's corner */}
        <g transform={`translate(${tip - size / 2} ${tip - size / 2}) scale(${size / 100}) rotate(${turn} 50 50)`}>
          {[0, 72, 144, 216, 288].map((r) => (
            <path
              key={r}
              d={PETAL}
              transform={`rotate(${r} 50 50)`}
              fill={`url(#${id}p)`}
              stroke="#ec6aa8"
              strokeWidth={2.2}
              strokeLinejoin="round"
            />
          ))}
          <circle cx={50} cy={50} r={7} fill={ink.heart} />
          <circle cx={50} cy={50} r={3} fill="#fbbf24" />
        </g>
      </g>
    </svg>
  );
}

export function SakuraCardFrame({ tone }: { tone: Tone }) {
  const ink = INK[tone];
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0 z-20"
      style={{ filter: `drop-shadow(0 0 5px ${ink.glow})` }}
    >
      {/* the fine line all round, on the same track as the fittings' outer L */}
      <div className="absolute rounded-[2px]" style={{ inset: INSET - 0.5, border: `1px solid ${ink.line}` }} />
      {(["tl", "tr", "bl", "br"] as Corner[]).map((c) => (
        <Fitting key={c} corner={c} tone={tone} />
      ))}
    </div>
  );
}

/** Duration of one sheen pass (slow). Also used for the safety timer. */
const SWEEP_MS = 7000;

/**
 * Random petals for one card: 1-4 of them, each with its own spot, size, sideways
 * drift and turn, and a long cycle in which it falls only once (the first ~45%) and
 * then rests. Each starts after its own pause, so cards never look or move alike and
 * petals come rarely, not in a steady stream.
 */
function randomPetals() {
  const rnd = (a: number, b: number) => a + Math.random() * (b - a);
  const count = 1 + Math.floor(Math.random() * 4);
  return Array.from({ length: count }, () => ({
    left: `${rnd(6, 88).toFixed(1)}%`,
    top: `${rnd(0, 26).toFixed(1)}%`,
    size: rnd(5, 9),
    duration: `${rnd(20, 42).toFixed(2)}s`,
    delay: `${rnd(1, 34).toFixed(2)}s`,
    drift: `${rnd(-40, 25).toFixed(0)}%`,
    turn: `${((Math.random() < 0.5 ? -1 : 1) * rnd(140, 300)).toFixed(0)}deg`,
  }));
}

/**
 * Effects inside a framed card: falling petals and sometimes a pearl band
 * crossing the art. Clipped by the petal outline.
 */
export function SakuraCardScreen({ tone }: { tone: Tone }) {
  const anim = useFx("holo");
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
  // this card's own petals, drawn once per mount
  const petals = useMemo(randomPetals, []);
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
      {petals.map((p, i) => (
        <span
          key={i}
          className="sak-card-petal"
          style={
            {
              left: p.left,
              top: p.top,
              width: `${p.size.toFixed(1)}%`,
              paddingBottom: `${p.size.toFixed(1)}%`,
              animationDelay: anim ? p.delay : undefined,
              animationDuration: anim ? p.duration : undefined,
              animationName: anim ? undefined : "none",
              "--drift": p.drift,
              "--turn": p.turn,
            } as CSSProperties
          }
        />
      ))}
    </div>
  );
}
