import { useMemo } from "react";
import type { CSSProperties } from "react";
import moonPond from "@/assets/wallpapers/sakura-moon-pond.svg";

/**
 * Sakura's second animated background: the "Moon pond" picture brought to life.
 * The still SVG stays the base, an overlay in the same 2000x1125 space (sliced like
 * bg-cover) adds the motion: the moon's glow breathes, its broken reflection glints,
 * rings keep spreading from the floating blossoms and now and then a petal drops onto
 * the water and leaves its own ring. The animations live in index.css (.sak-pond-*),
 * so the idle and animation switches stop them like every other loop.
 */

const W = 2000;
const H = 1125;

/** Where the blossoms and petals float in the picture (x, y, size). */
const FLOATERS: [number, number, number][] = [
  [1560, 794, 1.5],
  [1830, 540, 1.2],
  [1110, 610, 0.9],
  [940, 930, 0.9],
  [1790, 1030, 0.9],
  [600, 800, 0.7],
  [1300, 1070, 0.7],
];

/** One petal (notch at the tip), centred like the picture's own. */
const PETAL = "M50 57 C 38 50, 33 31, 39 12 L 50 21 L 61 12 C 67 31, 62 50, 50 57 Z";

const rnd = (a: number, b: number) => a + Math.random() * (b - a);

export function SakuraMoonPond() {
  // glints on the moon's reflection, each with its own pace
  const glints = useMemo(
    () =>
      Array.from({ length: 26 }, () => ({
        cx: rnd(1370, 1490),
        cy: rnd(450, 720),
        rx: rnd(5, 22),
        ry: rnd(0.9, 1.7),
        dur: rnd(2.6, 5.5),
        delay: -rnd(0, 6),
      })),
    [],
  );
  // petals that drop onto the water, rarely and each on its own cycle
  const drops = useMemo(
    () =>
      Array.from({ length: 4 }, () => ({
        x: rnd(380, 1900),
        y: rnd(620, 1060),
        drift: rnd(-120, 120),
        turn: rnd(-260, 260),
        size: rnd(0.35, 0.6),
        dur: rnd(16, 26),
        delay: -rnd(0, 26),
      })),
    [],
  );
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
      <div className="absolute inset-0 bg-cover bg-center" style={{ backgroundImage: `url("${moonPond}")` }} />
      <svg
        className="absolute inset-0 h-full w-full"
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="xMidYMid slice"
      >
        <defs>
          <radialGradient id="sak-pond-moon">
            <stop offset="0.45" stopColor="#ffe9f3" stopOpacity="0.55" />
            <stop offset="1" stopColor="#f9a8d4" stopOpacity="0" />
          </radialGradient>
          <linearGradient id="sak-pond-petal" x1="0" y1="1" x2="0" y2="0">
            <stop offset="0" stopColor="#ffe0ee" stopOpacity="0.95" />
            <stop offset="0.55" stopColor="#f9a8d4" stopOpacity="0.6" />
            <stop offset="1" stopColor="#f9a8d4" stopOpacity="0.25" />
          </linearGradient>
        </defs>

        {/* the moon's glow breathing */}
        <circle className="sak-pond-moon" cx={1420} cy={320} r={190} fill="url(#sak-pond-moon)" />

        {/* its reflection glinting */}
        {glints.map((g, i) => (
          <ellipse
            key={`g${i}`}
            className="sak-pond-glint"
            cx={g.cx}
            cy={g.cy}
            rx={g.rx}
            ry={g.ry}
            fill="#ffe4f0"
            style={{ animationDuration: `${g.dur.toFixed(2)}s`, animationDelay: `${g.delay.toFixed(2)}s` }}
          />
        ))}

        {/* rings spreading from the floaters, two per floater half a cycle apart */}
        {FLOATERS.map(([x, y, s], i) =>
          [0, 0.5].map((phase) => {
            const dur = 8 + (i % 3) * 1.4;
            return (
              <ellipse
                key={`r${i}-${phase}`}
                className="sak-pond-ring"
                cx={x}
                cy={y}
                rx={34 * s}
                ry={10.2 * s}
                style={{ animationDuration: `${dur}s`, animationDelay: `${(-dur * phase - i * 1.1).toFixed(2)}s` }}
              />
            );
          }),
        )}

        {/* a petal dropping onto the water, then its ring (same cycle, see index.css) */}
        {drops.map((d, i) => {
          const timing = { animationDuration: `${d.dur.toFixed(2)}s`, animationDelay: `${d.delay.toFixed(2)}s` };
          return (
            <g key={`d${i}`}>
              <g transform={`translate(${d.x.toFixed(0)} ${d.y.toFixed(0)})`}>
                <g
                  className="sak-pond-drop"
                  style={{ ...timing, "--fall": `${(-(d.y + 80)).toFixed(0)}px`, "--drift": `${d.drift.toFixed(0)}px`, "--turn": `${d.turn.toFixed(0)}deg` } as CSSProperties}
                >
                  <path
                    d={PETAL}
                    transform={`scale(${d.size.toFixed(2)}) translate(-50 -35)`}
                    fill="url(#sak-pond-petal)"
                    stroke="#f9a8d4"
                    strokeOpacity={0.5}
                    strokeWidth={2}
                  />
                </g>
              </g>
              <ellipse
                className="sak-pond-splash"
                cx={d.x + d.drift}
                cy={d.y}
                rx={26}
                ry={7.8}
                style={timing}
              />
            </g>
          );
        })}
      </svg>
    </div>
  );
}
