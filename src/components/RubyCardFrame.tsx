import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useFx, useFxIdle } from "@/lib/fx";
import { cn } from "@/lib/utils";

/**
 * Pyre card frame (when the theme's frame option is on), plus the effects of
 * the cards without it.
 * neon = template creators (silver with a pink shimmer), chrome = the rest. Drawn for a 340x480 card and scaled by
 * the card's width, the bottom parts stay anchored to its height, so every card shape
 * keeps even corners. It sits on the card root, outside the clipped body, because the
 * diamond and the shards reach over the edge. It also hands the body its corner size
 * (--ruby-cut, see RUBY_CARD_CLIP).
 */

export const RUBY_CARD_CLIP =
  "polygon(var(--ruby-cut) 0, calc(100% - var(--ruby-cut)) 0, 100% var(--ruby-cut), 100% calc(100% - var(--ruby-cut)), calc(100% - var(--ruby-cut)) 100%, var(--ruby-cut) 100%, 0 calc(100% - var(--ruby-cut)), 0 var(--ruby-cut))";

type Tone = "neon" | "chrome";

/** The reference card. */
const REF_W = 340;
const PINK = "#FF2D7A";
const CRIMSON = "#C0103F";

/** Eight-sided outline, i = inset from the edge, c = the cut of a corner. */
function octagon(w: number, h: number, i: number, c: number): string {
  const r = w - i;
  const b = h - i;
  return `M${i + c},${i} L${r - c},${i} L${r},${i + c} L${r},${b - c} L${r - c},${b} L${i + c},${b} L${i},${b - c} L${i},${i + c} Z`;
}

/** One side of that outline, from the middle of the top edge to the middle of the bottom. */
function halfOctagon(w: number, h: number, i: number, c: number, side: 1 | -1): string {
  const x = (d: number) => (side === 1 ? d : w - d);
  const r = w - i;
  const b = h - i;
  return `M${w / 2},${i} L${x(r - c)},${i} L${x(r)},${i + c} L${x(r)},${b - c} L${x(r - c)},${b} L${w / 2},${b}`;
}

/** The corner shard (drawn for the top left) and the one on the long sides. */
const SHARD_CORNER = "M-1,30 C-3,12 -8,-4 -20,-20 C-4,-8 12,-3 30,-1 C10,0 1,6 -1,30 Z";
const SHARD_SIDE = "M3,-22 C0,-8 -8,-2 -20,0 C-8,2 0,8 3,22 C1,8 1,-8 3,-22 Z";

/** The theme's sigil, a wrought iron cross (100x100 box). Its left half, mirrored below. */
const SIGIL_HALF = [
  "M46 4 H50 V96 H46 Z",
  "M4 46 H50 V54 H4 Z",
  "M46 4 C36 12 34 22 40 30 C42 24 44 22 50 20 Z",
  "M4 46 C12 36 22 34 30 40 C24 42 22 44 20 50 Z",
  "M46 96 C36 88 34 78 40 70 C42 76 44 78 50 80 Z",
];
/** The stone in its middle. */
const SIGIL_CENTRE = "M50 38 L62 50 L50 62 L38 50 Z";
/** Its size and inset in the 340x480 design. */
const SIGIL_SIZE = 27;
const SIGIL_INSET = 17;

/**
 * What the sigils turn into on hover: one tribal strip, mirrored around the middle of
 * the card, 380 tall and centred on y = 0. Its V points at the side shard.
 */
const TRIBAL_STRIP =
  "M0.0 -0.0L1.9 -3.1L6.7 -11.8L8.8 -15.5L11.0 -18.6L12.8 -20.7L14.0 -21.7L14.8 -22.2L15.5 -21.2L16.1 -20.1L16.5 -18.9L16.8 -17.6L16.8 -15.2L16.4 -13.0L15.5 -10.7L14.4 -8.9L15.8 -10.0L16.6 -10.9L17.4 -11.8L18.0 -12.9L18.9 -15.2L19.2 -16.6L19.4 -18.5L19.4 -22.4L18.7 -29.7L18.6 -33.7L18.7 -36.0L19.0 -38.2L19.4 -40.2L19.8 -41.8L18.9 -39.9L18.1 -37.8L16.0 -29.8L15.4 -28.5L14.8 -27.8L14.6 -27.8L14.5 -28.4L14.2 -31.0L14.0 -33.8L14.0 -36.9L14.2 -41.3L14.6 -45.9L15.4 -50.6L16.1 -54.1L17.2 -58.7L18.6 -63.0L20.1 -67.0L21.3 -69.7L20.2 -68.4L19.4 -67.8L18.8 -67.5L17.9 -67.3L17.3 -67.5L16.8 -67.9L16.0 -69.2L15.4 -71.0L15.1 -73.4L15.0 -76.2L15.1 -79.3L15.5 -83.4L16.0 -87.2L16.8 -90.3L17.8 -93.0L19.0 -95.4L20.5 -97.8L22.2 -100.0L20.9 -98.8L20.3 -98.5L19.8 -98.4L19.4 -98.4L19.0 -98.6L18.4 -99.4L18.2 -101.1L18.3 -103.6L18.9 -106.3L19.9 -108.7L19.2 -108.4L18.6 -108.3L18.1 -108.5L17.4 -109.2L17.1 -109.9L16.6 -111.3L16.4 -113.0L16.2 -115.0L16.2 -117.1L16.4 -119.4L17.4 -129.0L18.0 -133.7L19.4 -141.1L21.1 -147.5L20.4 -146.4L19.5 -145.5L18.7 -145.3L18.0 -145.7L17.4 -146.6L16.8 -147.9L16.3 -149.7L16.0 -151.8L15.5 -156.1L15.3 -161.6L14.9 -190.0L12.9 -170.4L12.4 -167.2L12.4 -166.9L12.1 -166.7L11.8 -166.8L11.4 -167.4L10.4 -170.0L9.6 -173.6L8.9 -177.6L9.4 -169.2L10.1 -161.3L11.1 -152.2L12.2 -144.2L12.1 -150.2L12.2 -154.5L12.4 -156.8L12.6 -157.5L12.7 -157.7L12.9 -157.6L13.0 -157.4L13.2 -156.6L13.7 -153.2L14.1 -147.5L14.2 -141.9L14.0 -136.5L13.7 -133.8L13.6 -132.7L13.5 -132.6L12.9 -132.9L12.3 -133.9L11.6 -135.5L11.0 -137.6L9.9 -143.1L8.9 -150.0L9.9 -132.7L10.7 -108.7L11.8 -122.3L12.2 -124.8L12.5 -125.7L12.8 -126.0L13.1 -125.6L13.3 -124.6L13.6 -121.0L13.5 -115.0L12.8 -109.0L11.9 -103.9L10.6 -99.3L12.4 -101.6L13.9 -103.3L15.1 -104.2L15.9 -104.4L16.2 -104.3L16.4 -104.1L16.7 -103.2L16.8 -101.4L16.7 -98.1L16.1 -91.5L15.1 -85.4L14.4 -82.2L13.6 -79.4L12.9 -77.3L12.4 -76.6L12.0 -77.1L11.7 -78.2L11.5 -81.4L11.6 -86.2L12.1 -94.8L10.4 -87.0L9.2 -79.3L8.4 -71.5L8.0 -63.3L8.8 -65.3L9.4 -66.2L10.0 -66.8L10.6 -67.1L11.2 -67.1L11.6 -67.0L12.1 -66.6L12.6 -65.9L13.0 -65.0L13.6 -62.8L13.9 -59.9L13.9 -57.3L13.5 -54.5L13.0 -52.0L12.3 -49.8L11.6 -48.0L10.7 -46.6L9.6 -45.4L8.7 -45.0L8.4 -44.9L7.9 -45.1L7.0 -45.8L6.0 -47.1L5.4 -48.5L4.8 -50.6L4.4 -53.1L4.1 -55.8L4.0 -58.7L4.1 -61.7L3.2 -54.5L2.9 -46.6L3.0 -38.7L3.7 -31.2L4.7 -24.6L4.6 -26.7L4.6 -28.9L4.7 -31.1L5.1 -33.5L5.5 -35.2L6.0 -36.4L6.6 -37.0L7.1 -37.0L7.5 -36.4L7.9 -35.3L8.3 -32.8L8.5 -29.6L8.4 -25.4L8.1 -22.0L7.6 -19.2L6.1 -14.2L4.9 -10.7L3.3 -6.9L1.7 -3.3ZM0.0 0.0L1.7 3.3L3.3 6.9L4.9 10.7L6.1 14.2L7.6 19.2L8.1 22.0L8.4 25.4L8.5 29.6L8.3 32.8L7.9 35.3L7.5 36.4L7.1 37.0L6.6 37.0L6.0 36.4L5.5 35.2L5.1 33.5L4.7 31.1L4.6 28.9L4.6 26.7L4.7 24.6L3.7 31.2L3.0 38.7L2.9 46.6L3.2 54.5L4.1 61.7L4.0 58.7L4.1 55.8L4.4 53.1L4.8 50.6L5.4 48.5L6.0 47.1L7.0 45.8L7.9 45.1L8.4 44.9L8.7 45.0L9.6 45.4L10.7 46.6L11.6 48.0L12.3 49.8L13.0 52.0L13.5 54.5L13.9 57.3L13.9 59.9L13.6 62.8L13.0 65.0L12.6 65.9L12.1 66.6L11.6 67.0L11.2 67.1L10.6 67.1L10.0 66.8L9.4 66.2L8.8 65.3L8.0 63.3L8.4 71.5L9.2 79.3L10.4 87.0L12.1 94.8L11.6 86.2L11.5 81.4L11.7 78.2L12.0 77.1L12.4 76.6L12.9 77.3L13.6 79.4L14.4 82.2L15.1 85.4L16.1 91.5L16.7 98.1L16.8 101.4L16.7 103.2L16.4 104.1L16.2 104.3L15.9 104.4L15.1 104.2L13.9 103.3L12.4 101.6L10.6 99.3L11.9 103.9L12.8 109.0L13.5 115.0L13.6 121.0L13.3 124.6L13.1 125.6L12.8 126.0L12.5 125.7L12.2 124.8L11.8 122.3L10.7 108.7L9.9 132.7L8.9 150.0L9.9 143.1L11.0 137.6L11.6 135.5L12.3 133.9L12.9 132.9L13.5 132.6L13.6 132.7L13.7 133.8L14.0 136.5L14.2 141.9L14.1 147.5L13.7 153.2L13.2 156.6L13.0 157.4L12.9 157.6L12.7 157.7L12.6 157.5L12.4 156.8L12.2 154.5L12.1 150.2L12.2 144.2L11.1 152.2L10.1 161.3L9.4 169.2L8.9 177.6L9.6 173.6L10.4 170.0L11.4 167.4L11.8 166.8L12.1 166.7L12.4 166.9L12.4 167.2L12.9 170.4L14.9 190.0L15.3 161.6L15.5 156.1L16.0 151.8L16.3 149.7L16.8 147.9L17.4 146.6L18.0 145.7L18.7 145.3L19.5 145.5L20.4 146.4L21.1 147.5L19.4 141.1L18.0 133.7L17.4 129.0L16.4 119.4L16.2 117.1L16.2 115.0L16.4 113.0L16.6 111.3L17.1 109.9L17.4 109.2L18.1 108.5L18.6 108.3L19.2 108.4L19.9 108.7L18.9 106.3L18.3 103.6L18.2 101.1L18.4 99.4L19.0 98.6L19.4 98.4L19.8 98.4L20.3 98.5L20.9 98.8L22.2 100.0L20.5 97.8L19.0 95.4L17.8 93.0L16.8 90.3L16.0 87.2L15.5 83.4L15.1 79.3L15.0 76.2L15.1 73.4L15.4 71.0L16.0 69.2L16.8 67.9L17.3 67.5L17.9 67.3L18.8 67.5L19.4 67.8L20.2 68.4L21.3 69.7L20.1 67.0L18.6 63.0L17.2 58.7L16.1 54.1L15.4 50.6L14.6 45.9L14.2 41.3L14.0 36.9L14.0 33.8L14.2 31.0L14.5 28.4L14.6 27.8L14.8 27.8L15.4 28.5L16.0 29.8L18.1 37.8L18.9 39.9L19.8 41.8L19.4 40.2L19.0 38.2L18.7 36.0L18.6 33.7L18.7 29.7L19.4 22.4L19.4 18.5L19.2 16.6L18.9 15.2L18.0 12.9L17.4 11.8L16.6 10.9L15.8 10.0L14.4 8.9L15.5 10.7L16.4 13.0L16.8 15.2L16.8 17.6L16.5 18.9L16.1 20.1L15.5 21.2L14.8 22.2L14.0 21.7L12.8 20.7L11.0 18.6L8.8 15.5L6.7 11.8L1.9 3.1Z";
const TRIBAL_HEIGHT = 380;
/** Its share of the card's height, and where it stands. */
const TRIBAL_SHARE = 0.8;
const TRIBAL_X = 17;

export function RubyCardFrame({ tone }: { tone: Tone }) {
  const ref = useRef<HTMLDivElement>(null);
  const uid = useId();
  const chromeId = `${uid}c`;
  const silverId = `${uid}s`;
  const sheenId = `${uid}g`;
  // each card shimmers on its own clock
  const sheenDelay = useMemo(
    () => [`${(-rnd(0, 12)).toFixed(2)}s`, `${(-rnd(0, 17)).toFixed(2)}s`],
    [],
  );
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const card = ref.current?.parentElement;
    if (!card) return;
    const place = () => {
      const w = card.clientWidth;
      setSize({ w, h: card.clientHeight });
      card.style.setProperty("--ruby-cut", `${((20 * w) / REF_W).toFixed(2)}px`);
    };
    place();
    const ro = new ResizeObserver(place);
    ro.observe(card);
    return () => ro.disconnect();
  }, []);

  const { w, h } = size;
  const s = w / REF_W;
  // lines thin out slower than the card, a small card keeps a readable frame
  const line = (x: number) => x * Math.max(s, 0.62);
  const neon = tone === "neon";
  const outer = octagon(w, h, 1 * s, 19 * s);
  const inner = octagon(w, h, 9 * s, 17 * s);
  const main = neon ? `url(#${silverId})` : `url(#${chromeId})`;
  const trim = neon ? `url(#${chromeId})` : PINK;
  // a template card: a white line in a pink aura, so it stands out from the plain chrome
  const glow = neon ? "#FFFFFF" : CRIMSON;
  // a template card's sigils and tribal strip: white with a neon pink rim
  const neonWhite = `drop-shadow(0 0 ${line(2)}px #FFFFFF) drop-shadow(0 0 ${line(6)}px ${PINK})`;
  const halo = neon
    ? `drop-shadow(0 0 ${line(5)}px rgba(255,255,255,0.6)) drop-shadow(0 0 ${line(16)}px rgba(255,45,122,0.85))`
    : `drop-shadow(0 0 ${line(7)}px ${glow}) drop-shadow(0 0 ${line(20)}px ${glow})`;
  // the sigil sits in both bottom corners, in the frame's own colour
  const sigilY = h / s - SIGIL_INSET - SIGIL_SIZE - 4;
  const sigilX = [SIGIL_INSET, w / s - SIGIL_INSET - SIGIL_SIZE];
  // a template card's shards reach further
  const shard = neon ? s * 1.3 : s;
  const sideY = h / 2;
  // the shards, each with the point it turns around on hover, just inside the card
  const pivot = 7 * shard;
  const sidePivot = 3 * shard;
  // the last two numbers point away from the card: the way it comes out, and back in
  const shards: [string, number, number, string, number, number][] = [
    [SHARD_CORNER, pivot, pivot, `scale(${shard})`, -0.7, -0.7],
    [SHARD_CORNER, w - pivot, pivot, `translate(${w} 0) scale(${-shard} ${shard})`, 0.7, -0.7],
    [SHARD_CORNER, pivot, h - pivot, `translate(0 ${h}) scale(${shard} ${-shard})`, -0.7, 0.7],
    [SHARD_CORNER, w - pivot, h - pivot, `translate(${w} ${h}) scale(${-shard} ${-shard})`, 0.7, 0.7],
    [SHARD_SIDE, sidePivot, sideY, `translate(0 ${sideY}) scale(${shard})`, -1, 0],
    [SHARD_SIDE, w - sidePivot, sideY, `translate(${w} ${sideY}) scale(${-shard} ${shard})`, 1, 0],
  ];
  // the tribal strip sits on the side shards, at the height of the middle of the card
  const tribalSize = Math.min(1.15, ((h / s) * TRIBAL_SHARE) / TRIBAL_HEIGHT);
  const sigils = sigilX.map((x) => (
    <g key={x} transform={`scale(${s}) translate(${x} ${sigilY}) scale(${SIGIL_SIZE / 100})`}>
      <g className="ruby-sigil-morph">
        {SIGIL_HALF.map((d) => (
          <g key={d}>
            <path d={d} />
            <path d={d} transform="translate(100 0) scale(-1 1)" />
          </g>
        ))}
        <path d={SIGIL_CENTRE} />
      </g>
    </g>
  ));
  return (
    <div ref={ref} aria-hidden className="pointer-events-none absolute inset-0 z-20">
      {w > 0 && (
        <>
          {/* the glow on its own layer: only its opacity moves, nothing is redrawn */}
          <svg className="ruby-frame-glow absolute inset-0 overflow-visible" width={w} height={h}>
            <path
              d={outer}
              fill="none"
              stroke={glow}
              strokeWidth={line(neon ? 2 : 3)}
              style={{ filter: halo }}
            />
          </svg>
          {/* now and then a pink light slides over the silver: fades only, nothing is redrawn */}
          {neon &&
            sheenDelay.map((delay, i) => (
              <svg
                key={delay}
                className={cn("ruby-frame-sheen absolute inset-0 overflow-visible", i === 1 && "ruby-frame-sheen--b")}
                style={{ animationDelay: delay }}
                width={w}
                height={h}
              >
                <defs>
                  <linearGradient id={`${sheenId}${i}`} x1="0" y1="0" x2="1" y2="1">
                    <stop offset={i ? 0.56 : 0.08} stopColor={PINK} stopOpacity={0} />
                    <stop offset={i ? 0.68 : 0.2} stopColor={PINK} />
                    <stop offset={i ? 0.73 : 0.25} stopColor="#FFD6E4" />
                    <stop offset={i ? 0.78 : 0.3} stopColor={PINK} />
                    <stop offset={i ? 0.92 : 0.44} stopColor={PINK} stopOpacity={0} />
                  </linearGradient>
                </defs>
                <path
                  d={outer}
                  fill="none"
                  stroke={`url(#${sheenId}${i})`}
                  strokeWidth={line(3.4)}
                  style={{ filter: `drop-shadow(0 0 ${line(7)}px ${PINK})` }}
                />
              </svg>
            ))}
          <svg className="absolute inset-0 overflow-visible" width={w} height={h}>
            <defs>
              <linearGradient id={chromeId} x1="0" y1="0" x2="1" y2="1">
                <stop offset="0" stopColor="#F4F6FA" />
                <stop offset="0.35" stopColor="#8E95A3" />
                <stop offset="0.55" stopColor="#FFFFFF" />
                <stop offset="0.8" stopColor="#B9A2B0" />
                <stop offset="1" stopColor="#E9EDF2" />
              </linearGradient>
              {/* the same chrome with two pink reflections in it */}
              <linearGradient id={silverId} x1="0" y1="0" x2="1" y2="1">
                <stop offset="0" stopColor="#FFFFFF" />
                <stop offset="0.16" stopColor="#C4C9D4" />
                <stop offset="0.25" stopColor="#FF5C97" />
                <stop offset="0.31" stopColor="#FF2D7A" />
                <stop offset="0.4" stopColor="#FFFFFF" />
                <stop offset="0.6" stopColor="#AEB4C1" />
                <stop offset="0.7" stopColor="#FF5C97" />
                <stop offset="0.75" stopColor="#FF2D7A" />
                <stop offset="0.84" stopColor="#FFFFFF" />
                <stop offset="1" stopColor="#E9ECF2" />
              </linearGradient>
            </defs>
            <path d={outer} fill="none" stroke={main} strokeWidth={line(neon ? 3.4 : 2.4)} />
            <path d={inner} fill="none" stroke={trim} strokeWidth={line(neon ? 1.5 : 1)} opacity={neon ? 1 : 0.85} />

            {/* the mark on the bottom edge */}
            <g transform={`translate(${w / 2} ${h}) scale(${s})`}>
              <path
                d="M-52,-28 L-8,-28 L0,-36 L8,-28 L52,-28"
                fill="none"
                stroke={main}
                strokeWidth={line(1.2) / s}
              />
              <path d="M0,-40 L4,-34 L0,-28 L-4,-34 Z" fill={PINK} />
            </g>

            {/* the jewel on the top edge */}
            <g transform={`translate(${w / 2} 0) scale(${s})`}>
              <path d="M-30,1 L-14,1 M14,1 L30,1" stroke={`url(#${chromeId})`} strokeWidth={3} fill="none" />
              <path
                d="M0,-9 L9,1 L0,11 L-9,1 Z"
                fill={PINK}
                stroke={`url(#${chromeId})`}
                strokeWidth={1}
                style={{ filter: `drop-shadow(0 0 5px ${PINK})` }}
              />
            </g>

            {/* the sigils in the bottom corners */}
            <g
              className={neon ? "ruby-sigil-base" : undefined}
              fill={neon ? "#FFFFFF" : `url(#${chromeId})`}
              style={{ filter: neon ? neonWhite : `drop-shadow(0 0 ${line(2)}px rgba(255,45,122,0.6))` }}
            >
              {sigils}
            </g>

            {/* template cards on hover: a line of embers runs from the jewel down both
                sides and meets at the mark, then the whole inner line flares once */}
            {neon && (
              <g
                className="ruby-ignite"
                fill="none"
                stroke="#FFE3EC"
                strokeWidth={line(2.2)}
                style={{ filter: `drop-shadow(0 0 ${line(3)}px ${PINK}) drop-shadow(0 0 ${line(9)}px ${PINK})` }}
              >
                <path d={inner} className="ruby-ignite-flash" />
                <path d={halfOctagon(w, h, 9 * s, 17 * s, 1)} className="ruby-ignite-run" pathLength={1} />
                <path d={halfOctagon(w, h, 9 * s, 17 * s, -1)} className="ruby-ignite-run" pathLength={1} />
              </g>
            )}

            {/* chrome shards reaching over the edge */}
            <g
              opacity={neon ? 1 : 0.85}
              fill={`url(#${chromeId})`}
              stroke="#4A0C22"
              strokeWidth={0.6}
              style={{ filter: "drop-shadow(0 0 1px rgba(255,255,255,0.4)) drop-shadow(0 0 5px rgba(255,45,122,0.45))" }}
            >
              {shards.map(([d, ox, oy, at, dx, dy]) => (
                <g
                  key={at}
                  className={neon ? "ruby-shard-out" : undefined}
                  style={
                    {
                      "--ox": `${(dx * line(11)).toFixed(1)}px`,
                      "--oy": `${(dy * line(11)).toFixed(1)}px`,
                      "--sx": `${(-dx * line(17)).toFixed(1)}px`,
                      "--sy": `${(-dy * line(17)).toFixed(1)}px`,
                    } as CSSProperties
                  }
                >
                  <g className={neon ? "ruby-shard-stab" : undefined}>
                    <g
                      className={neon ? "ruby-shard-flip" : undefined}
                      style={
                        {
                          "--spin": ox < w / 2 ? "180deg" : "-180deg",
                          transformOrigin: `${ox}px ${oy}px`,
                        } as CSSProperties
                      }
                    >
                      <path d={d} transform={at} />
                    </g>
                  </g>
                </g>
              ))}
            </g>

            {/* template cards on hover: each sigil flares white, shoots up and turns into a
                tribal strip in the middle of the card */}
            {neon && (
              <g
                className="ruby-tribals"
                fill="#FFFFFF"
                style={{ filter: neonWhite }}
              >
                <g className="ruby-sigil-white">{sigils}</g>
                {[1, -1].map((side) => (
                  <g
                    key={side}
                    transform={side === 1 ? `scale(${s})` : `translate(${w} 0) scale(${-s} ${s})`}
                  >
                    <path
                      className="ruby-tribal"
                      d={TRIBAL_STRIP}
                      transform={`translate(${TRIBAL_X} ${sideY / s}) scale(${tribalSize})`}
                    />
                  </g>
                ))}
              </g>
            )}
          </svg>
        </>
      )}
    </div>
  );
}

/** The verified mark of the theme: a chrome check with thorns and a ruby in its joint. */
const CHECK_BODY =
  "M5.0 82.0L14.6 79.2L17.2 78.0L19.8 75.9L20.3 75.8L20.6 75.9L23.6 81.3L30.6 90.7L33.7 95.3L36.4 100.4L37.4 103.1L38.0 106.0L38.8 103.0L39.8 100.2L42.7 94.6L46.2 89.4L55.7 77.2L59.0 72.4L60.3 69.9L63.8 62.1L71.4 42.9L72.0 42.7L74.6 43.4L77.8 44.5L81.8 46.1L84.7 46.9L87.9 47.3L94.5 47.7L97.0 48.0L94.6 47.3L92.5 46.2L85.5 41.2L75.1 35.6L74.7 35.0L77.3 29.4L80.1 24.0L84.9 16.1L90.5 8.7L94.7 4.2L97.0 2.0L68.2 26.3L61.3 32.9L54.7 39.9L54.1 39.8L53.7 39.3L49.2 27.9L48.2 24.1L48.0 22.1L48.0 20.0L47.6 23.1L46.0 30.9L45.7 35.6L46.3 39.3L49.1 47.2L45.5 52.9L42.5 58.5L41.2 61.4L40.2 64.4L39.0 69.9L38.7 70.4L38.3 70.4L37.8 70.2L36.4 67.3L35.3 65.5L32.8 62.2L30.1 59.4L25.8 56.0L23.0 54.2L18.8 51.9L5.0 46.0L7.8 47.7L9.6 49.1L12.0 51.8L13.4 53.9L14.7 56.2L16.2 60.0L18.1 67.0L17.3 68.7L16.1 70.6L9.9 78.4L7.7 80.4Z";
const CHECK_RUBY = "M41.0 58.0L48.0 70.0L41.0 84.0L34.0 70.0Z";

export function RubyCheckMark({ className }: { className?: string }) {
  return (
    <svg viewBox="-2 -2 104 112" className={cn("ruby-check-mark", className)}>
      <defs>
        <linearGradient id="micoll-checkmark-chrome" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#ffffff" />
          <stop offset="0.3" stopColor="#c9c3d1" />
          <stop offset="0.5" stopColor="#ffe6f0" />
          <stop offset="0.68" stopColor="#7e7688" />
          <stop offset="1" stopColor="#f4f0f6" />
        </linearGradient>
        <linearGradient id="micoll-checkmark-ruby" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#ff5c93" />
          <stop offset="0.4" stopColor="#e0115f" />
          <stop offset="0.75" stopColor="#9e0636" />
          <stop offset="1" stopColor="#4a0219" />
        </linearGradient>
      </defs>
      <path
        d={CHECK_BODY}
        fill="url(#micoll-checkmark-chrome)"
        stroke="#4a0c22"
        strokeWidth={2.5}
        paintOrder="stroke"
      />
      <path d={CHECK_RUBY} fill="url(#micoll-checkmark-ruby)" />
    </svg>
  );
}

const rnd = (a: number, b: number) => a + Math.random() * (b - a);

/** How long a burst of sparks lasts (ms), the longest spark fits in. */
const BURST_MS = 9000;

/** On for a short burst every now and then, on this card's own random clock. */
function useBurst(): boolean {
  const [burst, setBurst] = useState(false);
  const idle = useFxIdle();
  useEffect(() => {
    if (idle) return;
    const wait = burst ? BURST_MS : rnd(12_000, 60_000);
    const t = setTimeout(() => setBurst(!burst), wait);
    return () => clearTimeout(t);
  }, [burst, idle]);
  return burst;
}

/**
 * The frame's embers, in a burst instead of a steady stream. Also on finished month
 * cards. Needs a [container-type:size] parent.
 */
export function RubyEmbers({ count }: { count: number }) {
  const burst = useBurst();
  const embers = useMemo(
    () =>
      Array.from({ length: count }, () => ({
        left: `${rnd(9, 96).toFixed(1)}%`,
        top: `${rnd(42, 96).toFixed(1)}%`,
        height: rnd(4, 10),
        duration: `${rnd(4, 8).toFixed(1)}s`,
        delay: `${rnd(0, 1).toFixed(1)}s`,
      })),
    [count],
  );
  if (!burst) return null;
  return (
    <>
      {embers.map((e, i) => (
        <span
          key={i}
          className="ruby-ember"
          style={{
            left: e.left,
            top: e.top,
            height: e.height,
            animationDuration: e.duration,
            animationDelay: e.delay,
          }}
        />
      ))}
    </>
  );
}

/**
 * The sparks of the cards without the frame, also in bursts. Needs a
 * [container-type:size] parent.
 */
function RubySparks() {
  const burst = useBurst();
  const sparks = useMemo(
    () =>
      Array.from({ length: 12 }, () => ({
        left: `${rnd(4, 96).toFixed(1)}%`,
        height: Math.round(rnd(4, 11)),
        duration: `${rnd(3.5, 7).toFixed(1)}s`,
        delay: `${rnd(0, 2).toFixed(1)}s`,
        drift: `${rnd(-14, 14).toFixed(0)}cqw`,
      })),
    [],
  );
  if (!burst) return null;
  return (
    <>
      {sparks.map((p, i) => (
        <span
          key={i}
          className="ruby-spark"
          style={
            {
              left: p.left,
              height: p.height,
              animationDuration: p.duration,
              animationDelay: p.delay,
              "--drift": p.drift,
            } as CSSProperties
          }
        />
      ))}
    </>
  );
}

/**
 * Inside a framed card: two drifting hazes, film grain and now and then a burst of
 * embers.
 */
export function RubyCardScreen({ tone }: { tone: Tone }) {
  const anim = useFx("holo");
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 z-[15] overflow-hidden [container-type:size]">
      <div className={cn("ruby-haze ruby-haze--a", tone === "chrome" && "ruby-haze--chrome")} />
      {tone === "neon" && <div className="ruby-haze ruby-haze--b" />}
      <div className="ruby-grain" />
      {anim && <RubyEmbers count={tone === "neon" ? 10 : 7} />}
    </div>
  );
}

/**
 * Cards without the frame: a light running round the rim and, every now and then, a
 * short burst of rising sparks. A template card's light never stops, the others do one
 * lap every so often, so a full dashboard stays calm.
 */
export function RubyCardFx({ template }: { template: boolean }) {
  // this card's own lap, drawn once per mount
  const lap = useMemo(() => {
    const duration = template ? 6 : rnd(16, 28);
    return {
      animationDuration: `${duration.toFixed(2)}s`,
      animationDelay: `${(-rnd(0, duration)).toFixed(2)}s`,
    } as CSSProperties;
  }, [template]);
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 z-10 overflow-hidden [container-type:size]">
      <div className="ruby-run">
        <i className={template ? "ruby-run-always" : "ruby-run-lap"} style={lap} />
      </div>
      <RubySparks />
    </div>
  );
}
