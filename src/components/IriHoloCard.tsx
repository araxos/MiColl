import { useEffect, useRef } from "react";
import { subscribeHolo, HOLO } from "@/lib/holoEngine";
import { HOLO_PERIOD_SCALE, useHoloFreq } from "@/lib/holoFreq";

/**
 * Iridescent holo per card. A small 2D canvas copies frames from the shared WebGL
 * plasma (see holoEngine). Each card uses a random part of the frame.
 * The holo comes in short bursts, and a card is only subscribed during its burst
 * and while it's visible. When nobody is subscribed the engine stops, so it costs
 * nothing at rest. Burst timing follows the holo frequency setting.
 * Blended over the cover with mix-blend-mode: screen.
 */
export function IriHoloCard({
  hovered,
  premium,
  tier = 0,
}: {
  hovered: boolean;
  premium?: boolean;
  /**
   * Size tier of the artist's data: 0 (<1 GB), 1 (>=1 GB), 2 (>=10 GB). Bigger = more
   * often.
   */
  tier?: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const hoveredRef = useRef(hovered);
  hoveredRef.current = hovered;
  const freq = useHoloFreq();

  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const ctx = cv.getContext("2d");
    if (!ctx) return;

    // own part of the shared frame so cards look different
    const sw = HOLO.GLW * 0.6;
    const sh = HOLO.GLH * 0.6;
    const ox = Math.random() * (HOLO.GLW - sw);
    const oy = Math.random() * (HOLO.GLH - sh);

    // max strength during a burst, a bit more on hover
    const base = premium ? 0.42 : 0.34;

    // timing by data size: [cycle sec, visible sec], the setting stretches the cycle
    const CADENCE: [number, number][] = [
      [46, 6], // <1 GB  — rare
      [24, 7], // ≥1 GB  — more frequent
      [13, 8], // ≥10 GB — frequent
    ];
    const [basePeriod, active] = CADENCE[Math.max(0, Math.min(2, tier))];
    const period = Math.max(active + 2, basePeriod * HOLO_PERIOD_SCALE[freq]);
    const FADE = 1.3; // seconds to fade the burst in and out (no popping)
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    // reduced motion: just a steady faint holo
    if (reduce) {
      const drawStatic = (frame: HTMLCanvasElement) => {
        const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
        const w = Math.floor(cv.clientWidth * dpr);
        const h = Math.floor(cv.clientHeight * dpr);
        if (w <= 0 || h <= 0) return;
        cv.width = w;
        cv.height = h;
        ctx.clearRect(0, 0, w, h);
        ctx.globalAlpha = base;
        ctx.drawImage(frame, ox, oy, sw, sh, 0, 0, w, h);
      };
      return subscribeHolo(drawStatic);
    }

    let unsub: (() => void) | null = null;
    let nextTimer: number | undefined;
    let endTimer: number | undefined;
    let burstStart = 0;
    let visible = false;
    let weight = 0;

    // burst strength 0..1 for the time since it started
    const envAt = (tsec: number) => {
      if (tsec < 0 || tsec >= active) return 0;
      if (tsec < FADE) return tsec / FADE;
      if (tsec > active - FADE) return (active - tsec) / FADE;
      return 1;
    };

    const draw = (frame: HTMLCanvasElement) => {
      const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      const w = Math.floor(cv.clientWidth * dpr);
      const h = Math.floor(cv.clientHeight * dpr);
      if (w <= 0 || h <= 0) return;
      if (cv.width !== w || cv.height !== h) {
        cv.width = w;
        cv.height = h;
      }
      const env = envAt((performance.now() - burstStart) / 1000);
      const target = (base + (hoveredRef.current ? 0.22 : 0)) * env;
      weight = weight + (target - weight) * 0.2;
      ctx.clearRect(0, 0, cv.width, cv.height);
      if (weight < 0.01) return; // fully faded — leave the canvas clear
      ctx.globalAlpha = weight;
      ctx.drawImage(frame, ox, oy, sw, sh, 0, 0, cv.width, cv.height);
    };

    const stopBurst = () => {
      unsub?.();
      unsub = null;
      weight = 0;
      ctx.clearRect(0, 0, cv.width, cv.height);
    };

    const startBurst = () => {
      if (!visible || unsub) return;
      burstStart = performance.now();
      unsub = subscribeHolo(draw);
      // a bit extra time so it fades out fully
      endTimer = window.setTimeout(() => {
        stopBurst();
        nextTimer = window.setTimeout(startBurst, (period - active) * 1000);
      }, (active + 0.5) * 1000);
    };

    const clearTimers = () => {
      if (nextTimer) window.clearTimeout(nextTimer);
      if (endTimer) window.clearTimeout(endTimer);
      nextTimer = endTimer = undefined;
    };

    // only visible cards take part, random phase on re-entry so they don't sync up
    const io = new IntersectionObserver(
      ([entry]) => {
        const nowVisible = entry.isIntersecting;
        if (nowVisible === visible) return;
        visible = nowVisible;
        clearTimers();
        if (visible) {
          nextTimer = window.setTimeout(startBurst, Math.random() * period * 1000);
        } else {
          stopBurst();
        }
      },
      { rootMargin: "80px" },
    );
    io.observe(cv);

    return () => {
      io.disconnect();
      clearTimers();
      stopBurst();
    };
  }, [premium, tier, freq]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      className="pointer-events-none absolute inset-0 z-10 block h-full w-full"
      style={{ mixBlendMode: "screen" }}
    />
  );
}
