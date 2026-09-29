import { useMemo } from "react";
import type { CSSProperties, ComponentType, SVGProps } from "react";

interface Particle {
  left: string;
  edge: string;
  /** Icon size as a share of the card width (cqw). */
  size: number;
  duration: number;
  delay: number;
  /** Sideways drift in cqw. */
  sway: number;
}

/* Sizes are relative to the card (cqw/cqh) so the particles scale with Ctrl+wheel.
   Same for the keyframes in index.css (micoll-tag-float etc). */
const REF_CARD_W = 180;

/**
 * Hover effect for tagged cards: small tag icons rise along the card edges and fade.
 * Sakura = falling petals, cyberpunk = falling in steps, iridescent = shooting diagonally.
 * Only mounted while hovered, so every hover gets a new random pattern.
 */
export function TagParticles({
  Icon,
  colorClass,
  direction = "rise",
}: {
  Icon: ComponentType<SVGProps<SVGSVGElement>>;
  colorClass: string;
  direction?: "rise" | "fall" | "glitch" | "shoot";
}) {
  const particles = useMemo<Particle[]>(() => {
    const rnd = (min: number, max: number) => min + Math.random() * (max - min);
    // shooting sparks start a bit further inside so they don't leave the card right away
    const shoot = direction === "shoot";
    return Array.from({ length: 10 }, (_, i) => ({
      // alternate left/right edge
      left:
        i % 2 === 0
          ? `${rnd(shoot ? 9 : 2, shoot ? 19 : 9).toFixed(1)}%`
          : `${rnd(84, 92).toFixed(1)}%`,
      edge: `${rnd(4, 55).toFixed(1)}%`,
      size: (rnd(12, 18) / REF_CARD_W) * 100,
      duration: rnd(1.7, 2.6),
      delay: rnd(0, 1.8),
      sway: (rnd(-10, 10) / REF_CARD_W) * 100,
    }));
  }, [direction]);

  return (
    <div
      aria-hidden
      // container for cqw/cqh. size (not inline-size) because they move vertically
      className="pointer-events-none absolute inset-0 z-10 overflow-hidden rounded-2xl [container-type:size]"
    >
      {particles.map((p, i) => {
        const keyframes =
          direction === "rise"
            ? "micoll-tag-float"
            : direction === "fall"
              ? "micoll-tag-fall"
              : direction === "shoot"
                ? "micoll-tag-shoot"
                : "micoll-tag-glitch";
        const timing = direction === "glitch" ? "steps(8)" : "ease-out";
        const style: CSSProperties = {
          left: p.left,
          width: `${p.size.toFixed(2)}cqw`,
          height: `${p.size.toFixed(2)}cqw`,
          opacity: 0,
          animation: `${keyframes} ${p.duration.toFixed(2)}s ${timing} ${p.delay.toFixed(2)}s infinite`,
        };
        if (direction === "rise") style.bottom = p.edge;
        else style.top = p.edge;
        (style as Record<string, string | number>)["--fx-sway"] = `${p.sway.toFixed(2)}cqw`;
        return (
          <Icon
            key={i}
            className={`absolute ${colorClass} drop-shadow-[0_1px_2px_rgba(0,0,0,0.7)]`}
            fill="currentColor"
            style={style}
          />
        );
      })}
    </div>
  );
}
