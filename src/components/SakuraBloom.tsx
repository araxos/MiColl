import { useId } from "react";

/**
 * The blossom from the sakura wallpaper on its own, used as a mark.
 * Same petal path as SakuraStill, but stronger colors so it works at 32px,
 * and the strokes don't scale.
 */

/** One petal with the notch at the tip. */
export const SAKURA_STILL_PETAL =
  "M50 57 C 38 50, 33 31, 39 12 L 50 21 L 61 12 C 67 31, 62 50, 50 57 Z";

const ANGLES = [0, 72, 144, 216, 288];
const STAMENS = [0, 60, 120, 180, 240, 300];

export function SakuraBloom({ className }: { className?: string }) {
  // own gradient id per instance (see IriGrad)
  const id = useId();
  const petal = `url(#${id})`;
  return (
    <svg
      aria-hidden
      viewBox="0 0 100 100"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
    >
      <defs>
        {/* brighter in the middle, fading toward the notch (gives depth) */}
        <linearGradient id={id} x1="0" y1="1" x2="0" y2="0">
          <stop offset="0%" stopColor="#ffe0ee" stopOpacity="0.92" />
          <stop offset="55%" stopColor="#f9a8d4" stopOpacity="0.55" />
          <stop offset="100%" stopColor="#f9a8d4" stopOpacity="0.24" />
        </linearGradient>
      </defs>

      {ANGLES.map((r) => (
        <path
          key={r}
          d={SAKURA_STILL_PETAL}
          transform={`rotate(${r} 50 50)`}
          fill={petal}
          stroke="#f9a8d4"
          strokeWidth={1.1}
          strokeOpacity={0.9}
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
      ))}

      {/* stamens: 6 lines with a dot at the tip */}
      {STAMENS.map((r) => {
        const a = (r * Math.PI) / 180;
        return (
          <g key={r}>
            <line
              x1={50 + 5 * Math.sin(a)}
              y1={50 - 5 * Math.cos(a)}
              x2={50 + 14 * Math.sin(a)}
              y2={50 - 14 * Math.cos(a)}
              stroke="#ffe0ee"
              strokeOpacity={0.75}
              strokeWidth={0.9}
              vectorEffect="non-scaling-stroke"
            />
            <circle
              cx={50 + 14.5 * Math.sin(a)}
              cy={50 - 14.5 * Math.cos(a)}
              r={2.6}
              fill="#ffd9e8"
              fillOpacity={0.9}
            />
          </g>
        );
      })}

      <circle cx={50} cy={50} r={5.4} fill="#f472b6" />
    </svg>
  );
}
