import { useMemo } from "react";
import type { CSSProperties } from "react";

/**
 * Sakura animated background: sharp vector blossoms (two slowly spinning)
 * and falling petals. Plain inline SVG.
 */

/** One petal, notch at the top (24x30 box). */
const PETAL_PATH = "M12 30 C 4 22, 1 12, 5 2 L 12 8 L 19 2 C 23 12, 20 22, 12 30 Z";

/** Blossom with 5 notched petals and a center. */
function Blossom({
  size,
  className,
  style,
}: {
  size: number;
  className?: string;
  style?: CSSProperties;
}) {
  const angles = [0, 72, 144, 216, 288];
  return (
    <svg
      viewBox="0 0 100 100"
      width={size}
      height={size}
      className={className}
      style={style}
      aria-hidden
    >
      {angles.map((r) => (
        <g key={r} transform={`rotate(${r} 50 50)`}>
          <path
            d="M50 58 C 38 48, 34 30, 40 10 L 50 19 L 60 10 C 66 30, 62 48, 50 58 Z"
            fill="rgba(255, 205, 227, 0.30)"
            stroke="#f9a8d4"
            strokeWidth="1.5"
          />
        </g>
      ))}
      <circle cx="50" cy="50" r="5" fill="#f472b6" />
      {angles.map((r) => (
        <circle
          key={r}
          cx={50 + 11 * Math.sin((r * Math.PI) / 180)}
          cy={50 - 11 * Math.cos((r * Math.PI) / 180)}
          r="1.6"
          fill="#f9a8d4"
        />
      ))}
    </svg>
  );
}

interface Petal {
  left: string;
  size: number;
  fall: number;
  delay: number;
  sway: number;
  drift: string;
  rot: string;
  opacity: number;
}

export function SakuraFx() {
  const petals = useMemo<Petal[]>(() => {
    const rnd = (min: number, max: number) => min + Math.random() * (max - min);
    return Array.from({ length: 12 }, () => ({
      left: `${rnd(0, 98).toFixed(1)}%`,
      size: Math.round(rnd(10, 18)),
      fall: rnd(11, 20),
      delay: rnd(-20, 0), // negative = the sky is already mid-fall on mount
      sway: rnd(2.4, 4),
      drift: `${rnd(-8, 10).toFixed(1)}vw`,
      rot: `${Math.round(rnd(180, 420))}deg`,
      opacity: rnd(0.35, 0.6),
    }));
  }, []);

  return (
    <div aria-hidden className="sakura-fx pointer-events-none absolute inset-0 overflow-hidden">
      {/* blossoms, the two big ones spin slowly */}
      <Blossom
        size={440}
        className="absolute -right-24 -top-28 opacity-[0.17]"
        style={{ animation: "micoll-sakura-spin 150s linear infinite" }}
      />
      <Blossom
        size={300}
        className="absolute -bottom-20 -left-16 opacity-[0.14]"
        style={{ animation: "micoll-sakura-spin 190s linear infinite reverse" }}
      />
      <Blossom
        size={110}
        className="absolute left-[16%] top-[30%] opacity-[0.10]"
        style={{ animation: "micoll-sakura-spin 90s linear infinite" }}
      />

      {/* falling petals: outer node falls + rotates, inner svg sways */}
      {petals.map((p, i) => (
        <div
          key={i}
          className="absolute top-0"
          style={
            {
              left: p.left,
              opacity: 0,
              "--petal-drift": p.drift,
              "--petal-rot": p.rot,
              "--petal-opacity": p.opacity,
              animation: `micoll-petal-fall ${p.fall.toFixed(1)}s linear ${p.delay.toFixed(1)}s infinite`,
            } as CSSProperties
          }
        >
          <svg
            viewBox="0 0 24 30"
            width={p.size}
            height={Math.round(p.size * 1.25)}
            style={{
              animation: `micoll-petal-sway ${p.sway.toFixed(1)}s ease-in-out infinite alternate`,
            }}
          >
            <path d={PETAL_PATH} fill="#ffc1da" stroke="#f472b6" strokeWidth="1" />
          </svg>
        </div>
      ))}
    </div>
  );
}
