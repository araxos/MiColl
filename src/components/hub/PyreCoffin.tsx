import { useMemo } from "react";
import { Thumb } from "@/components/hub/shared";
import { cn } from "@/lib/utils";

/* The sarcophagi of the Pyre Wallpaper Hub: a lid in silver bars with thorns, a picture on
   it (none = closed velvet with a mark), and what stands around them: candles and roses.
   All drawn here, the gradients are shared (PyreCoffinDefs, once per page). */

type P = [number, number];
const n1 = (v: number) => +v.toFixed(1);
const at = (x: number, y: number) => `${n1(x)} ${n1(y)}`;

/** A thorn at (x, y) pointing along `deg`. */
function thorn(x: number, y: number, deg: number, len: number, w: number): string {
  const a = (deg * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const side = (along: number, out: number) => at(x + c * along - s * out, y + s * along + c * out);
  return `M${side(0, w / 2)}Q${side(len * 0.5, len * 0.1 + w * 0.16)} ${side(len, 0)}Q${side(len * 0.5, len * 0.1 - w * 0.16)} ${side(0, -w / 2)}Z`;
}

/** A stroke that is thick in its middle and sharp at both ends. */
function taper([x0, y0]: P, [ax, ay]: P, [bx, by]: P, [x1, y1]: P, w: number): string {
  const d = Math.hypot(x1 - x0, y1 - y0) || 1;
  const nx = (-(y1 - y0) / d) * w * 0.62;
  const ny = ((x1 - x0) / d) * w * 0.62;
  return `M${at(x0, y0)}C${at(ax + nx, ay + ny)} ${at(bx + nx, by + ny)} ${at(x1, y1)}C${at(bx - nx, by - ny)} ${at(ax - nx, ay - ny)} ${at(x0, y0)}Z`;
}

/** The marks on the lids (a 120 box around 0,0): flame, star, peak, blade. */
const MARKS = [
  taper([0, 50], [-46, 20], [-10, -14], [0, -56], 12) +
    taper([0, 50], [46, 20], [10, -14], [0, -56], 12) +
    taper([0, 40], [-14, 14], [8, 4], [0, -18], 9),
  taper([0, -56], [-20, -20], [-20, 20], [0, 56], 10) +
    taper([0, -56], [20, -20], [20, 20], [0, 56], 10) +
    taper([-50, 0], [-20, -14], [20, -14], [50, 0], 9) +
    taper([-50, 0], [-20, 14], [20, 14], [50, 0], 9),
  taper([-50, 40], [-34, -10], [-16, -36], [0, -58], 10) +
    taper([50, 40], [34, -10], [16, -36], [0, -58], 10) +
    taper([-26, 48], [-14, 10], [-8, -8], [0, -22], 8) +
    taper([26, 48], [14, 10], [8, -8], [0, -22], 8) +
    taper([0, 58], [-3, 30], [-3, 16], [0, 2], 7),
  taper([0, 58], [-8, 10], [-8, -20], [0, -58], 13) +
    taper([-44, -10], [-16, 10], [16, 10], [44, -10], 10) +
    taper([-30, -34], [-10, -18], [10, -18], [30, -34], 8),
];

/** How far the foot is drawn in on each side (share of the width). */
const FOOT = 0.13;

function shape(w: number, h: number) {
  const b = w * FOOT;
  const t = Math.max(1.1, w / 70);
  // x at share u of the width, q of the height
  const x = (u: number, q: number) => b * q + (w - 2 * b * q) * u;
  const side = w * 0.17;
  let ribs = "";
  let thorns = "";
  for (const u of [0.3, 0.7]) ribs += `M${at(x(u, 0), 0)}L${at(x(u, 1), h)}`;
  for (const q of [0.24, 0.86]) {
    ribs += `M${at(x(0, q), h * q)}L${at(x(1, q), h * q)}`;
    for (const u of [0.3, 0.7])
      for (const a of [45, 135, 225, 315]) thorns += thorn(x(u, q), h * q, a, w * 0.085, t * 2.2);
  }
  // the corners, the long sides, the top
  const corner = (cx: number, cy: number, degs: number[]) =>
    degs.forEach((a, i) => (thorns += thorn(cx, cy, a, w * [0.16, 0.21, 0.1, 0.11][i], t * 3.2)));
  corner(0, 0, [200, 235, 160, 285]);
  corner(w, 0, [-20, -55, 20, -105]);
  corner(w - b, h, [20, 55, 340, 100]);
  corner(b, h, [160, 125, 200, 80]);
  for (const u of [0.3, 0.5, 0.7]) thorns += thorn(x(u, 0), 0, -90, w * (u === 0.5 ? 0.13 : 0.09), t * 2.8);
  for (const q of [0.24, 0.5, 0.86])
    thorns += thorn(x(0, q), h * q, 180, w * 0.09, t * 2.6) + thorn(x(1, q), h * q, 0, w * 0.09, t * 2.6);
  return {
    w,
    h,
    t,
    face: `M0 0H${w}L${at(w - b, h)}H${n1(b)}Z`,
    side: `M0 0L${at(-side, h * 0.035)}L${at(b - side * 0.8, h * 0.985)}L${at(b, h)}Z`,
    ribs,
    thorns,
  };
}
type Shape = ReturnType<typeof shape>;
/** On the stage / on a card. */
export const STAGE_COFFIN = shape(98, 228);
export const CARD_COFFIN = shape(112, 196);

export function PyreCoffinDefs() {
  const stops = (list: [number, string][]) =>
    list.map(([o, c]) => <stop key={o} offset={o} stopColor={c} />);
  return (
    <svg aria-hidden width="0" height="0" className="absolute">
      <defs>
        <linearGradient id="micoll-coffin-silver" x1="0" y1="0" x2="1" y2="1">
          {stops([[0, "#fff"], [0.3, "#a7a1ad"], [0.52, "#f6ecf1"], [0.75, "#857d8a"], [1, "#e9e3ea"]])}
        </linearGradient>
        <linearGradient id="micoll-coffin-lid" x1="0" y1="0" x2="1" y2="1">
          {stops([[0, "#5a1426"], [0.5, "#3a0a18"], [1, "#22040d"]])}
        </linearGradient>
        <linearGradient id="micoll-coffin-side" x1="0" y1="0" x2="0" y2="1">
          {stops([[0, "#2a0912"], [1, "#0c0306"]])}
        </linearGradient>
        <linearGradient id="micoll-coffin-wax" x1="0" y1="0" x2="1" y2="0">
          {stops([[0, "#8d7a74"], [0.4, "#f3e6dc"], [1, "#6d5a56"]])}
        </linearGradient>
        <radialGradient id="micoll-coffin-glow">
          <stop offset="0" stopColor="#fff6df" stopOpacity="0.95" />
          <stop offset="0.25" stopColor="#ffc9a0" stopOpacity="0.5" />
          <stop offset="1" stopColor="#ff5c7a" stopOpacity="0" />
        </radialGradient>
        <pattern id="micoll-coffin-velvet" width="10" height="10" patternUnits="userSpaceOnUse">
          <path d="M0 5L5 0L10 5L5 10Z" fill="none" stroke="#000" strokeOpacity="0.22" />
        </pattern>
      </defs>
    </svg>
  );
}

export function Coffin({
  shape: s,
  path,
  size,
  mark,
  lean = 0,
  flip,
  dim,
  text,
}: {
  shape: Shape;
  /** The picture on the lid, none = closed. */
  path?: string;
  /** Thumbnail size. */
  size: number;
  /** Which mark is on it. */
  mark: number;
  /** Degrees it leans. */
  lean?: number;
  /** Its side face is on the right. */
  flip?: boolean;
  /** An empty slideshow's, its silver is dull. */
  dim?: boolean;
  /** Written on a closed lid instead of the mark. */
  text?: string;
}) {
  const { w, h, t } = s;
  const box = { width: w, height: h, viewBox: `0 0 ${w} ${h}` };
  const markSize = path ? w * 0.2 : w * 0.4;
  return (
    <span
      aria-hidden
      className={cn("ruby-coffin", dim && "ruby-coffin--dim")}
      style={{ width: w, height: h, rotate: lean ? `${lean}deg` : undefined }}
    >
      <svg {...box} className="absolute inset-0 overflow-visible">
        <path
          d={s.side}
          transform={flip ? `translate(${w} 0) scale(-1 1)` : undefined}
          fill="url(#micoll-coffin-side)"
          stroke="#6d5560"
          strokeWidth={0.8}
        />
        {!path && (
          <>
            <path d={s.face} fill="url(#micoll-coffin-lid)" />
            <path d={s.face} fill="url(#micoll-coffin-velvet)" />
          </>
        )}
      </svg>
      {path && (
        <span className="ruby-coffin-pic" style={{ clipPath: `path("${s.face}")` }}>
          <Thumb path={path} size={size} />
        </span>
      )}
      <svg {...box} className="absolute inset-0 overflow-visible">
        <g opacity={dim ? 0.55 : 1}>
          <path d={s.face} fill="none" stroke="#1a060c" strokeWidth={t * 3.4} />
          <path d={s.face} fill="none" stroke="url(#micoll-coffin-silver)" strokeWidth={t * 2} strokeLinejoin="round" />
          <path d={s.ribs} fill="none" stroke="#1a060c" strokeWidth={t * 2} opacity={0.7} />
          <path d={s.ribs} fill="none" stroke="url(#micoll-coffin-silver)" strokeWidth={t * 1.1} />
          <path d={s.thorns} fill="#e9dfe6" />
        </g>
        {text ? (
          <text x={w / 2} y={h * 0.56} textAnchor="middle" className="ruby-coffin-text" fontSize={w * 0.24}>
            {text}
          </text>
        ) : (
          <path
            d={MARKS[mark % MARKS.length]}
            transform={`translate(${w / 2} ${path ? h * 0.12 : h * 0.5}) scale(${markSize / 100})`}
            fill="url(#micoll-coffin-silver)"
            opacity={dim ? 0.8 : 1}
            className="ruby-coffin-mark"
          />
        )}
      </svg>
    </span>
  );
}

/** Candles as [x, y of the foot, height, width]. */
export type CandleSpec = [number, number, number, number];

export function Candles({
  list,
  width,
  height,
  out,
  className,
}: {
  list: CandleSpec[];
  width: number;
  height: number;
  /** Not burning. */
  out?: boolean;
  className?: string;
}) {
  return (
    <svg aria-hidden width={width} height={height} className={cn("overflow-visible", className)}>
      {list.map(([x, y, h, w], i) => {
        const top = y - h;
        return (
          <g key={i}>
            <path
              d={`M${x - w / 2} ${y}V${top + 2}Q${x - w / 4} ${top - 2} ${x} ${top + 1}Q${x + w / 4} ${top - 1} ${x + w / 2} ${top + 3}V${y}Z`}
              fill={out ? "#4a3d3b" : "url(#micoll-coffin-wax)"}
            />
            <path d={`M${x} ${top}v-3`} stroke="#2a1512" />
            {!out && (
              <g className="ruby-candle" style={{ animationDelay: `${-(i * 0.73) % 2.4}s` }}>
                <circle cx={x} cy={top - 7} r={w * 2.9} fill="url(#micoll-coffin-glow)" />
                <path
                  d={`M${x} ${top - 2}C${x - w * 0.34} ${top - 6} ${x - w * 0.1} ${top - 10} ${x} ${top - 15}C${x + w * 0.1} ${top - 10} ${x + w * 0.34} ${top - 6} ${x} ${top - 2}Z`}
                  fill="#fff3d0"
                />
              </g>
            )}
          </g>
        );
      })}
    </svg>
  );
}

const ROSES = ["#c9486f", "#e7b0c2", "#8f2346", "#f0dfe5"];

function Rose({ x, y, r, color }: { x: number; y: number; r: number; color: string }) {
  return (
    <g transform={`translate(${at(x, y)})`} stroke="#4a0f22" strokeWidth={0.8} fill={color}>
      <circle r={r} fill="#2a0a14" stroke="none" />
      {[0, 1, 2, 3, 4].map((k) => {
        const a = ((k * 72 - 90) * Math.PI) / 180;
        return <circle key={k} cx={n1(r * 0.48 * Math.cos(a))} cy={n1(r * 0.48 * Math.sin(a))} r={n1(r * 0.56)} />;
      })}
      <circle r={n1(r * 0.46)} />
      <path
        d={`M${n1(-r * 0.22)} 0a${n1(r * 0.22)} ${n1(r * 0.22)} 0 1 1 ${n1(r * 0.3)} ${n1(r * 0.16)}a${n1(r * 0.14)} ${n1(r * 0.14)} 0 0 1 ${n1(-r * 0.2)} ${n1(-r * 0.12)}`}
        fill="none"
        strokeWidth={1}
      />
    </g>
  );
}

/** A row of roses in leaves, `width` long and 40 high, the same one for the same seed. */
export function Bouquet({ width, seed, scale = 1, className }: { width: number; seed: number; scale?: number; className?: string }) {
  const { leaves, roses } = useMemo(() => {
    let state = seed * 7919 + 1;
    const rnd = (a: number, b: number) => {
      state = (state * 16807) % 2147483647;
      return a + (state / 2147483647) * (b - a);
    };
    const leaves = Array.from({ length: Math.floor(width / 9) }, () => ({
      x: rnd(6, width - 6),
      y: 24 + rnd(-9, 4) * scale,
      l: rnd(14, 24) * scale,
      a: rnd(-160, -20),
    }));
    const count = Math.max(3, Math.floor(width / 20));
    const roses = Array.from({ length: count }, (_, k) => ({
      x: (width * (k + 0.5)) / count + rnd(-4, 4),
      y: 24 + rnd(-8, 2) * scale,
      r: rnd(7, 11) * scale,
      color: ROSES[Math.floor(rnd(0, 3.999))],
    }));
    return { leaves, roses };
  }, [width, seed, scale]);
  return (
    <svg aria-hidden width={width} height={40} className={cn("overflow-visible", className)}>
      {leaves.map(({ x, y, l, a }, i) => (
        <path
          key={i}
          transform={`translate(${at(x, y)}) rotate(${n1(a)})`}
          d={`M0 0C${n1(l * 0.3)} ${n1(-l * 0.34)} ${n1(l * 0.75)} ${n1(-l * 0.3)} ${n1(l)} 0C${n1(l * 0.75)} ${n1(l * 0.3)} ${n1(l * 0.3)} ${n1(l * 0.34)} 0 0Z`}
          fill="#243a2c"
          stroke="#0e1a13"
          strokeWidth={0.7}
        />
      ))}
      {roses.map((r, i) => (
        <Rose key={i} {...r} />
      ))}
    </svg>
  );
}
