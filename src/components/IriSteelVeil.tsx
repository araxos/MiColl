import { useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import steelVeil from "@/assets/wallpapers/iri-steel-veil.svg";

/**
 * Iridescent's default background, the "Steel veil" picture brought to life. The
 * picture is laid out at its own 2000x1125 and scaled to cover, so the moving parts
 * stay on the bands at any window size: a wide veil of light and a faint pastel sheen
 * drift slowly across the bands (in opposite directions), the haze in the corner
 * breathes and a glint runs down each of the two thin lines now and then. Only
 * transform and opacity move (index.css, "Steel veil").
 */

const W = 2000;
const H = 1125;

/** The bands and lines lean this far from upright (dx/dy = -0.369 in the picture). */
const LEAN = 20.25;

/** The picture's two thin lines: centre, length, how long a glint takes and its delay. */
const LINES: [number, number, number, number, number][] = [
  [472.5, 562.5, 1199, 11, -2],
  [1833.5, 687.5, 933, 14, -9],
];

export function IriSteelVeil() {
  const ref = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const fit = () => setScale(Math.max(el.clientWidth / W, el.clientHeight / H));
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <div ref={ref} aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
      <div
        className="absolute left-1/2 top-1/2 overflow-hidden"
        style={{ width: W, height: H, transform: `translate(-50%, -50%) scale(${scale})` }}
      >
        {/* the picture itself, breathing in very slowly */}
        <div className="iri-veil-base" style={{ backgroundImage: `url("${steelVeil}")` }} />
        {/* the veil of light and the pastel sheen, both leaning with the bands */}
        <div className="iri-veil-lean" style={{ rotate: `${LEAN}deg` }}>
          <span className="iri-veil-light" />
          <span className="iri-veil-sheen" />
        </div>
        <span className="iri-veil-haze" />
        {LINES.map(([x, y, length, pace, delay], i) => (
          <span
            key={i}
            className="iri-veil-line"
            style={
              {
                left: x,
                top: y - length / 2,
                height: length,
                rotate: `${LEAN}deg`,
                "--len": `${length}px`,
              } as CSSProperties
            }
          >
            <i style={{ animationDuration: `${pace}s`, animationDelay: `${delay}s` }} />
          </span>
        ))}
      </div>
    </div>
  );
}
