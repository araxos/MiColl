import { useMemo } from "react";
import type { CSSProperties } from "react";

/**
 * Cyberpunk animated background: a big neon glyph that glitches, hazard stripes,
 * glitch slivers in yellow/cyan/pink, scanline sweep and HUD corners.
 * Hard edges, no blur.
 */

const SLIVER_COLORS = ["#fcee0a", "#00e5ff", "#ff2bd6"];

interface Sliver {
  left: string;
  top: string;
  width: number;
  height: number;
  color: string;
  dur: number;
  delay: number;
  opacity: number;
}

const STRIPES =
  "repeating-linear-gradient(45deg, rgba(252,238,10,0.7) 0 14px, transparent 14px 28px)";

export function CyberpunkFx() {
  const slivers = useMemo<Sliver[]>(() => {
    const rnd = (min: number, max: number) => min + Math.random() * (max - min);
    return Array.from({ length: 9 }, (_, i) => ({
      left: `${rnd(2, 80).toFixed(1)}%`,
      top: `${rnd(8, 92).toFixed(1)}%`,
      width: Math.round(rnd(40, 190)),
      height: Math.round(rnd(2, 5)),
      color: SLIVER_COLORS[i % SLIVER_COLORS.length],
      dur: rnd(3, 7),
      delay: rnd(-7, 0),
      opacity: rnd(0.18, 0.4),
    }));
  }, []);

  return (
    <div aria-hidden className="cyber-fx pointer-events-none absolute inset-0 overflow-hidden">
      {/* the glyph: a zigzag + a tall needle through the middle,
          yellow with a green offset copy as glitch shadow */}
      <svg
        viewBox="468 38 274 564"
        className="absolute left-[36%] top-[10%] h-[74vh] opacity-[0.12]"
        style={{ animation: "micoll-glitch-shift 6s linear infinite" }}
      >
        <g transform="translate(10 14)">
          <path
            d="M492 188 L610 242 L500 295 L700 422 L643 462 L706 542"
            fill="none"
            stroke="#58e000"
            strokeWidth="22"
            strokeMiterlimit="8"
          />
          <path
            d="M612 58 C 602 240, 602 400, 612 568 C 622 400, 622 240, 612 58 Z"
            fill="#58e000"
          />
        </g>
        <path
          d="M492 188 L610 242 L500 295 L700 422 L643 462 L706 542"
          fill="none"
          stroke="#fcee0a"
          strokeWidth="22"
          strokeMiterlimit="8"
        />
        <path
          d="M612 58 C 602 240, 602 400, 612 568 C 622 400, 622 240, 612 58 Z"
          fill="#fcee0a"
        />
      </svg>

      {/* hazard stripe bars */}
      <div
        className="absolute right-0 top-[9%] h-4 w-[34%] opacity-25"
        style={{ backgroundImage: STRIPES, clipPath: "polygon(16px 0, 100% 0, 100% 100%, 0 100%)" }}
      />
      <div
        className="absolute bottom-[7%] left-0 h-4 w-[42%] opacity-25"
        style={{
          backgroundImage: STRIPES,
          clipPath: "polygon(0 0, 100% 0, calc(100% - 16px) 100%, 0 100%)",
        }}
      />

      {/* glitch slivers */}
      {slivers.map((s, i) => {
        const style: CSSProperties = {
          left: s.left,
          top: s.top,
          width: s.width,
          height: s.height,
          backgroundColor: s.color,
          animation: `micoll-flicker ${s.dur.toFixed(1)}s steps(2) ${s.delay.toFixed(1)}s infinite`,
        };
        (style as Record<string, string | number>)["--fx-o"] = s.opacity;
        return <div key={i} className="absolute" style={style} />;
      })}

      {/* scanline sweep */}
      <div
        className="absolute inset-x-0 top-0 h-px bg-cyan-300/25"
        style={{ animation: "micoll-scan 8s linear infinite" }}
      />

      {/* HUD corners */}
      <div className="absolute left-3 top-12 h-10 w-10 border-l-2 border-t-2 border-yellow-300/25" />
      <div className="absolute bottom-3 right-3 h-10 w-10 border-b-2 border-r-2 border-yellow-300/25" />
    </div>
  );
}
