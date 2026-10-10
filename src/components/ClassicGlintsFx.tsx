import { useMemo, type CSSProperties } from "react";

/**
 * Animated background of the classic accents ("Premium look" + "Animated background"):
 * the crystal glints of the static backdrop rise a little and fade out, then start over.
 * Plain CSS animations on transform/opacity only (no canvas, no frame loop), paused
 * with the rest of the wallpaper when the app is idle (data-fx-idle).
 */

const COUNT = 42;

// small seeded random, so the field looks the same on every mount
function rng(seed: number) {
  let s = seed >>> 0;
  return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
}

export function ClassicGlintsFx() {
  const glints = useMemo(() => {
    const r = rng(1123);
    return Array.from({ length: COUNT }, () => {
      const star = r() < 0.3;
      const dur = 9 + r() * 10;
      return {
        star,
        left: r() * 100,
        top: 18 + r() * 90,
        size: star ? 6 + r() * 5 : 1.6 + r() * 2.2,
        dur,
        delay: -r() * dur,
        rise: 14 + r() * 22,
        drift: (r() - 0.5) * 40,
        peak: star ? 0.55 + r() * 0.35 : 0.35 + r() * 0.45,
      };
    });
  }, []);

  return (
    <div aria-hidden className="classic-glints-fx pointer-events-none absolute inset-0 overflow-hidden">
      {glints.map((g, i) => (
        <span
          key={i}
          className={g.star ? "classic-glint classic-glint--star" : "classic-glint"}
          style={
            {
              left: `${g.left}%`,
              top: `${g.top}%`,
              width: g.size,
              height: g.size,
              animationDuration: `${g.dur}s`,
              animationDelay: `${g.delay}s`,
              "--rise": `-${g.rise}vh`,
              "--drift": `${g.drift}px`,
              "--peak": g.peak,
            } as CSSProperties
          }
        />
      ))}
    </div>
  );
}
