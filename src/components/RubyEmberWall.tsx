import { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import ember from "@/assets/wallpapers/ruby-ember.webp";

/**
 * Pyre's default background, the "Ember" picture brought to life. The picture is
 * laid out at its own 2560x1440 and scaled to cover, so the moving parts stay on what
 * they belong to at any window size: the arc and the haze behind it breathe, the lens
 * flares flicker and embers keep rising. Only transform and opacity move.
 */

const W = 2560;
const H = 1440;

/** The arc in the picture (circle centre and radius, the angles it runs between). */
const ARC = { cx: 307.2, cy: 892.8, r: 1843.2, from: -1.1, to: 0.5 };

const point = (a: number) => `${ARC.cx + ARC.r * Math.cos(a)} ${ARC.cy + ARC.r * Math.sin(a)}`;
const ARC_PATH = `M${point(ARC.from)} A${ARC.r} ${ARC.r} 0 0 1 ${point(ARC.to)}`;

/** The picture's lens flares: x, y, length, angle (deg) and pace (s). */
const FLARES: [number, number, number, number, number][] = [
  [1818, 259, 440, 66, 5.3],
  [2317, 720, 310, 109, 7.1],
  [435, 389, 285, 112, 6.2],
];

/** The direction the embers fly, up and a little to the left. */
const EMBER_ANGLE = -1.95;

const rnd = (a: number, b: number) => a + Math.random() * (b - a);

export function RubyEmberWall() {
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
  const embers = useMemo(
    () =>
      Array.from({ length: 36 }, () => {
        const reach = rnd(420, 1150);
        return {
          left: rnd(0, W),
          top: rnd(H * 0.3, H * 1.05),
          height: rnd(9, 44),
          duration: rnd(8, 18),
          delay: -rnd(0, 18),
          dx: Math.cos(EMBER_ANGLE) * reach,
          dy: Math.sin(EMBER_ANGLE) * reach,
        };
      }),
    [],
  );
  return (
    <div ref={ref} aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
      <div
        className="absolute left-1/2 top-1/2 overflow-hidden"
        style={{
          width: W,
          height: H,
          transform: `translate(-50%, -50%) scale(${scale})`,
          backgroundImage: `url("${ember}")`,
          backgroundSize: "100% 100%",
        }}
      >
        <div className="ruby-wall-haze" />
        <svg className="ruby-wall-arc absolute inset-0" width={W} height={H}>
          <path d={ARC_PATH} fill="none" stroke="#ff2d7a" strokeWidth={7} />
        </svg>
        {FLARES.map(([x, y, length, angle, pace], i) => (
          <span
            key={i}
            className="ruby-wall-flare"
            style={{
              left: x - length / 2,
              top: y - 3,
              width: length,
              rotate: `${angle}deg`,
              animationDuration: `${pace}s`,
            }}
          />
        ))}
        {embers.map((e, i) => (
          <span
            key={i}
            className="ruby-wall-ember"
            style={
              {
                left: e.left,
                top: e.top,
                height: e.height,
                animationDuration: `${e.duration.toFixed(1)}s`,
                animationDelay: `${e.delay.toFixed(1)}s`,
                "--dx": `${e.dx.toFixed(0)}px`,
                "--dy": `${e.dy.toFixed(0)}px`,
              } as CSSProperties
            }
          />
        ))}
      </div>
    </div>
  );
}
