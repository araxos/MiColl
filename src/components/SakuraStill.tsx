import { SAKURA_STILL_PETAL } from "@/components/SakuraBloom";

/**
 * Sakura background when "Animated background" is off.
 * A still version of SakuraFx: a branch across the screen with blossoms and a few
 * falling petals. No animation, one inline SVG, scaled with "slice".
 */

/** Five petals around the center. */
const ANGLES = [0, 72, 144, 216, 288];

/** One petal (from SakuraBloom, imported so they stay the same). */
const PETAL = SAKURA_STILL_PETAL;

/** A blossom in its own 100x100 box. Gradient petals + stamens. */
function Blossom({ x, y, size, rotate = 0 }: { x: number; y: number; size: number; rotate?: number }) {
  const s = size / 100;
  return (
    <g transform={`translate(${x} ${y}) scale(${s}) rotate(${rotate}) translate(-50 -50)`}>
      {ANGLES.map((r) => (
        <path
          key={r}
          d={PETAL}
          transform={`rotate(${r} 50 50)`}
          fill="url(#sak-still-petal)"
          stroke="#f9a8d4"
          strokeWidth={1.4}
          strokeOpacity={0.75}
        />
      ))}
      {/* stamens: 6 lines with a dot */}
      {[0, 60, 120, 180, 240, 300].map((r) => {
        const a = (r * Math.PI) / 180;
        return (
          <g key={r}>
            <line
              x1={50 + 4 * Math.sin(a)}
              y1={50 - 4 * Math.cos(a)}
              x2={50 + 13 * Math.sin(a)}
              y2={50 - 13 * Math.cos(a)}
              stroke="#ffe0ee"
              strokeOpacity={0.5}
              strokeWidth={1}
            />
            <circle
              cx={50 + 13.5 * Math.sin(a)}
              cy={50 - 13.5 * Math.cos(a)}
              r={1.7}
              fill="#ffd9e8"
              fillOpacity={0.85}
            />
          </g>
        );
      })}
      <circle cx={50} cy={50} r={4.2} fill="#f472b6" />
    </g>
  );
}

/** A bud on a short stem, for the branch tips. */
function Bud({ x, y, size, rotate = 0 }: { x: number; y: number; size: number; rotate?: number }) {
  const s = size / 100;
  return (
    <g transform={`translate(${x} ${y}) scale(${s}) rotate(${rotate})`}>
      <path
        d="M0 0 C -13 -14, -13 -34, 0 -46 C 13 -34, 13 -14, 0 0 Z"
        fill="url(#sak-still-petal)"
        stroke="#f9a8d4"
        strokeWidth={1.6}
        strokeOpacity={0.7}
      />
      <path d="M0 0 L 0 12" stroke="#6b4453" strokeWidth={2.4} strokeLinecap="round" />
    </g>
  );
}

/** Branch and twigs, thickest first. Round caps so the segments join smoothly. */
const BRANCH: { d: string; w: number }[] = [
  // main branch from left to right through the middle (the top is covered by the grid)
  { d: "M-40 636 C 120 610, 240 570, 360 540", w: 13 },
  { d: "M360 540 C 480 512, 590 500, 700 506", w: 10 },
  { d: "M700 506 C 810 512, 900 534, 990 566", w: 7.5 },
  { d: "M990 566 C 1070 594, 1150 606, 1240 604", w: 5.5 },
  { d: "M1240 604 C 1330 602, 1420 586, 1500 560", w: 4 },
  // twigs alternate above and below
  { d: "M300 556 C 300 500, 320 452, 360 414", w: 3.6 },
  { d: "M520 504 C 540 448, 580 408, 640 386", w: 3 },
  { d: "M700 506 C 690 560, 700 610, 730 650", w: 3 },
  { d: "M900 540 C 930 500, 975 472, 1020 462", w: 2.4 },
  { d: "M1090 584 C 1120 540, 1170 508, 1230 494", w: 2.8 },
  { d: "M170 616 C 160 664, 170 706, 200 740", w: 2.6 },
];

/** Floating petals {x, y, size, rotation, opacity}, placed by hand. */
const FALLING: [number, number, number, number, number][] = [
  [250, 300, 26, 24, 0.42],
  [470, 250, 18, -40, 0.32],
  [610, 640, 22, 130, 0.4],
  [840, 700, 20, -15, 0.34],
  [430, 780, 26, 65, 0.36],
  [1330, 760, 18, -70, 0.3],
  [1450, 360, 22, 20, 0.3],
  [90, 830, 16, 100, 0.26],
  [880, 300, 20, 45, 0.26],
];

export function SakuraStill() {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
      <svg
        viewBox="0 0 1600 900"
        preserveAspectRatio="xMidYMid slice"
        className="absolute inset-0 h-full w-full"
      >
        <defs>
          {/* bright at the base, fading toward the notch */}
          <linearGradient id="sak-still-petal" x1="0" y1="1" x2="0" y2="0">
            <stop offset="0%" stopColor="#ffe0ee" stopOpacity="0.55" />
            <stop offset="55%" stopColor="#f9a8d4" stopOpacity="0.26" />
            <stop offset="100%" stopColor="#f9a8d4" stopOpacity="0.08" />
          </linearGradient>
          {/* glow from the lower left */}
          <radialGradient id="sak-still-glow" cx="0.2" cy="0.95" r="0.9">
            <stop offset="0%" stopColor="#f472b6" stopOpacity="0.14" />
            <stop offset="100%" stopColor="#f472b6" stopOpacity="0" />
          </radialGradient>
        </defs>

        <rect width="1600" height="900" fill="url(#sak-still-glow)" />

        <g>
          {/* the wood, a bit lighter than the background */}
          {BRANCH.map((b) => (
            <path
              key={b.d}
              d={b.d}
              fill="none"
              stroke="#4a3039"
              strokeWidth={b.w}
              strokeLinecap="round"
            />
          ))}
          {/* pink line on top of each branch (moonlight), keeps it visible */}
          {BRANCH.map((b) => (
            <path
              key={`lit${b.d}`}
              d={b.d}
              fill="none"
              stroke="#f9a8d4"
              strokeOpacity={0.38}
              strokeWidth={Math.max(1, b.w * 0.24)}
              strokeLinecap="round"
              transform={`translate(0 ${-b.w * 0.3})`}
            />
          ))}
        </g>

        <g opacity="0.95">
          <Blossom x={360} y={404} size={92} rotate={-12} />
          <Blossom x={648} y={378} size={78} rotate={16} />
          <Blossom x={1238} y={486} size={86} rotate={20} />
          <Blossom x={736} y={662} size={72} rotate={-24} />
          <Blossom x={204} y={750} size={66} rotate={10} />
          <Blossom x={1026} y={454} size={58} rotate={-30} />
          <Blossom x={470} y={508} size={46} rotate={30} />
          <Blossom x={1150} y={600} size={44} rotate={-14} />
          <Bud x={560} y={432} size={48} rotate={-20} />
          <Bud x={940} y={522} size={40} rotate={24} />
          <Bud x={252} y={688} size={42} rotate={-8} />
        </g>

        {/* floating petals, one shared path */}
        {FALLING.map(([x, y, size, rot, op]) => (
          <path
            key={`${x},${y}`}
            d={PETAL}
            transform={`translate(${x} ${y}) scale(${size / 100}) rotate(${rot}) translate(-50 -50)`}
            fill="url(#sak-still-petal)"
            stroke="#f9a8d4"
            strokeOpacity={0.4}
            strokeWidth={1.6}
            opacity={op}
          />
        ))}
      </svg>
    </div>
  );
}
