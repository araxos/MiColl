import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useFx } from "@/lib/fx";
import { cn } from "@/lib/utils";

/**
 * Pyre card frame (when the theme's frame option is on), plus the effects of
 * the cards without it.
 * neon = template creators, chrome = the rest. Drawn for a 340x480 card and scaled by
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
const REF_H = 480;
const PINK = "#FF2D7A";
const CRIMSON = "#C0103F";

/** Eight-sided outline, i = inset from the edge, c = the cut of a corner. */
function octagon(w: number, h: number, i: number, c: number): string {
  const r = w - i;
  const b = h - i;
  return `M${i + c},${i} L${r - c},${i} L${r},${i + c} L${r},${b - c} L${r - c},${b} L${i + c},${b} L${i},${b - c} L${i},${i + c} Z`;
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

export function RubyCardFrame({ tone }: { tone: Tone }) {
  const ref = useRef<HTMLDivElement>(null);
  const uid = useId();
  const chromeId = `${uid}c`;
  const pinkId = `${uid}p`;
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
  const main = neon ? PINK : `url(#${chromeId})`;
  const trim = neon ? `url(#${chromeId})` : PINK;
  const glow = neon ? PINK : CRIMSON;
  // the sigil sits in both bottom corners, in the frame's own colour
  const sigilY = h / s - SIGIL_INSET - SIGIL_SIZE - 4;
  const sigilX = [SIGIL_INSET, w / s - SIGIL_INSET - SIGIL_SIZE];
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
              strokeWidth={line(3)}
              style={{ filter: `drop-shadow(0 0 ${line(7)}px ${glow}) drop-shadow(0 0 ${line(20)}px ${glow})` }}
            />
          </svg>
          <svg className="absolute inset-0 overflow-visible" width={w} height={h}>
            <defs>
              <linearGradient id={chromeId} x1="0" y1="0" x2="1" y2="1">
                <stop offset="0" stopColor="#F4F6FA" />
                <stop offset="0.35" stopColor="#8E95A3" />
                <stop offset="0.55" stopColor="#FFFFFF" />
                <stop offset="0.8" stopColor="#B9A2B0" />
                <stop offset="1" stopColor="#E9EDF2" />
              </linearGradient>
              <linearGradient id={pinkId} x1="0" y1="0" x2="1" y2="1">
                <stop offset="0" stopColor="#FF8FB5" />
                <stop offset="0.5" stopColor={PINK} />
                <stop offset="1" stopColor={CRIMSON} />
              </linearGradient>
            </defs>
            <path d={outer} fill="none" stroke={main} strokeWidth={line(neon ? 2 : 2.4)} />
            <path d={inner} fill="none" stroke={trim} strokeWidth={line(neon ? 0.9 : 1)} opacity={0.85} />

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
              fill={`url(#${neon ? pinkId : chromeId})`}
              style={{ filter: `drop-shadow(0 0 ${line(neon ? 3 : 2)}px ${neon ? PINK : "rgba(255,45,122,0.6)"})` }}
            >
              {sigilX.map((x) => (
                <g key={x} transform={`scale(${s}) translate(${x} ${sigilY}) scale(${SIGIL_SIZE / 100})`}>
                  {SIGIL_HALF.map((d) => (
                    <g key={d}>
                      <path d={d} />
                      <path d={d} transform="translate(100 0) scale(-1 1)" />
                    </g>
                  ))}
                  <path d={SIGIL_CENTRE} />
                </g>
              ))}
            </g>

            {/* chrome shards reaching over the edge */}
            <g
              opacity={0.85}
              fill={`url(#${chromeId})`}
              stroke="#4A0C22"
              strokeWidth={0.6}
              style={{ filter: "drop-shadow(0 0 1px rgba(255,255,255,0.4)) drop-shadow(0 0 5px rgba(255,45,122,0.45))" }}
            >
              <path d={SHARD_CORNER} transform={`scale(${s})`} />
              <path d={SHARD_CORNER} transform={`translate(${w} 0) scale(${-s} ${s})`} />
              <path d={SHARD_CORNER} transform={`translate(0 ${h}) scale(${s} ${-s})`} />
              <path d={SHARD_CORNER} transform={`translate(${w} ${h}) scale(${-s} ${-s})`} />
              <path d={SHARD_SIDE} transform={`translate(0 ${h * (250 / REF_H)}) scale(${s})`} />
              <path d={SHARD_SIDE} transform={`translate(${w} ${h * (250 / REF_H)}) scale(${-s} ${s})`} />
            </g>
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
  useEffect(() => {
    const wait = burst ? BURST_MS : rnd(12_000, 60_000);
    const t = setTimeout(() => setBurst(!burst), wait);
    return () => clearTimeout(t);
  }, [burst]);
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
 * Inside a framed card: two drifting hazes, film grain, the dark fade behind the name
 * and now and then a burst of embers.
 */
export function RubyCardScreen({ tone }: { tone: Tone }) {
  const anim = useFx("holo");
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 z-[15] overflow-hidden [container-type:size]">
      <div className={cn("ruby-haze ruby-haze--a", tone === "chrome" && "ruby-haze--chrome")} />
      {tone === "neon" && <div className="ruby-haze ruby-haze--b" />}
      <div className="ruby-grain" />
      <div className={cn("ruby-frame-fade", tone === "chrome" && "ruby-frame-fade--chrome")} />
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
