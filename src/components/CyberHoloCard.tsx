import { useEffect, useRef } from "react";
import { onFxIdle } from "@/lib/fx";

/**
 * Cyberpunk holo for cards with a template. A canvas draws glowing circuit lines
 * that come in from the right, stay and fade. On top: neon tint, light sweep, glare.
 * On hover the layers follow the mouse and the card tilts in 3D.
 * Pointer is read from the parent, the tilt goes on the same element (like
 * IriTemplateHolo).
 */

// colors: yellow, cyan, pink
const PALETTE = ["#fcee0a", "#00f0ff", "#ff2ee6"];
const BUILD_SPEED = 230; // px/s the circuit traces draw themselves (calmer than 420)
const INTENSITY = 0.9; // peak opacity of the holo layers
// circuit lines are weaker, they'd be too strong over the cover
const LINE_OPACITY = 0.5;
const MAX_TRACES = 7; // fewer lines on screen at once (was 11)
const SPAWN_MIN = 0.28; // seconds between spawns — a bit sparser (was 0.1)
const SPAWN_JITTER = 0.4; // extra random spawn gap (was 0.25)
// lines come in bursts with breaks in between
const ACTIVE_MIN = 8; // seconds of drawing before a break
const ACTIVE_MAX = 14;
const BREAK_MIN = 10; // seconds with NO new cyberlines
const BREAK_MAX = 25;
const randRange = (lo: number, hi: number) => lo + Math.random() * (hi - lo);

const hexToRgb = (hex: string): [number, number, number] => {
  const h = hex.replace("#", "");
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
};
const rgba = (hex: string, a: number) => {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r},${g},${b},${a})`;
};
// holo tint from the palette, moved by --bx/--by
const TINT = (() => {
  const stops = [...PALETTE, PALETTE[0]];
  return `linear-gradient(115deg, ${stops
    .map((c, i) => `${rgba(c, 0.14)} ${Math.round((i / (stops.length - 1)) * 100)}%`)
    .join(", ")})`;
})();

type Trace = {
  pts: [number, number][];
  cum: number[];
  total: number;
  drawn: number;
  speed: number;
  color: string;
  w: number;
  state: "draw" | "hold" | "fade";
  alpha: number;
  hold: number;
  dot: boolean;
};

export function CyberHoloCard() {
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const root = rootRef.current;
    const cv = canvasRef.current;
    if (!root || !cv) return;
    const body = root.parentElement; // the card's clipped body (overflow-hidden)
    if (!body) return;
    const btn = body.parentElement; // the motion.button — hosts the perspective
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    if (btn) btn.style.perspective = "1000px";

    const ctx = cv.getContext("2d");
    if (!ctx) return;

    // ---- smoothed pointer/reveal state ----
    const cur = { rx: 0, ry: 0, bx: 50, by: 50, gx: 50, gy: 50, o: 0 };
    const tgt = { ...cur };
    let hovered = false;
    let W = 0;
    let H = 0;
    let traces: Trace[] = [];
    let spawnT = 0;
    // burst/break cycle: draw lines for a while, then 10-25s quiet
    let spawning = true;
    let phaseT = randRange(ACTIVE_MIN, ACTIVE_MAX);
    let last = 0;
    let raf = 0;

    const initCanvas = () => {
      W = body.clientWidth || 300;
      H = body.clientHeight || 375;
      const dpr = window.devicePixelRatio || 1;
      cv.width = Math.max(1, Math.round(W * dpr));
      cv.height = Math.max(1, Math.round(H * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      traces = [];
      spawnT = 0;
    };
    initCanvas();
    const ro = new ResizeObserver(initCanvas);
    ro.observe(body);

    const setPointer = (px: number, py: number) => {
      const x = Math.min(1, Math.max(0, px));
      const y = Math.min(1, Math.max(0, py));
      // smaller tilt for the small grid cards
      tgt.ry = (x - 0.5) * 14;
      tgt.rx = -(y - 0.5) * 11;
      tgt.bx = 100 - x * 100;
      tgt.by = 100 - y * 100;
      tgt.gx = x * 100;
      tgt.gy = y * 100;
      tgt.o = INTENSITY;
    };

    const makeTrace = (): Trace => {
      const pts: [number, number][] = [];
      let x = W + 20;
      let y = H * (0.12 + Math.random() * 0.85);
      pts.push([x, y]);
      const endX = -30 + Math.random() * W * 0.5;
      while (x > endX) {
        if (Math.random() < 0.42) {
          const len = 20 + Math.random() * 55;
          const dir = Math.random() < 0.65 ? -1 : 1;
          x -= len * 0.707;
          y = Math.max(12, Math.min(H - 12, y + dir * len * 0.707));
        } else {
          x -= 40 + Math.random() * 110;
        }
        pts.push([x, y]);
      }
      let total = 0;
      const cum = [0];
      for (let i = 1; i < pts.length; i++) {
        total += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
        cum.push(total);
      }
      return {
        pts,
        cum,
        total,
        drawn: 0,
        speed: BUILD_SPEED * (0.6 + Math.random() * 0.8),
        color:
          PALETTE.length > 1 && Math.random() > 0.4
            ? PALETTE[1 + Math.floor(Math.random() * (PALETTE.length - 1))]
            : PALETTE[0],
        w: 1.2 + Math.random() * 1.4,
        state: "draw",
        alpha: 1,
        hold: 1.4 + Math.random() * 2.2,
        dot: Math.random() < 0.65,
      };
    };

    const drawLines = (dt: number) => {
      ctx.clearRect(0, 0, W, H);
      // during a break no new lines are added
      phaseT -= dt;
      if (phaseT <= 0) {
        spawning = !spawning;
        phaseT = spawning ? randRange(ACTIVE_MIN, ACTIVE_MAX) : randRange(BREAK_MIN, BREAK_MAX);
      }
      spawnT -= dt;
      if (spawning && traces.length < MAX_TRACES && spawnT <= 0) {
        traces.push(makeTrace());
        spawnT = SPAWN_MIN + Math.random() * SPAWN_JITTER;
      }
      for (const tr of traces) {
        if (tr.state === "draw") {
          tr.drawn += tr.speed * dt;
          if (tr.drawn >= tr.total) {
            tr.drawn = tr.total;
            tr.state = "hold";
          }
        } else if (tr.state === "hold") {
          tr.hold -= dt;
          if (tr.hold <= 0) tr.state = "fade";
        } else {
          tr.alpha -= dt / 2.6;
        }
        if (tr.alpha <= 0) continue;
        ctx.globalAlpha = Math.max(0, tr.alpha);
        ctx.strokeStyle = tr.color;
        ctx.lineWidth = tr.w;
        ctx.lineJoin = "round";
        ctx.lineCap = "round";
        ctx.shadowColor = tr.color;
        ctx.shadowBlur = 10;
        ctx.beginPath();
        ctx.moveTo(tr.pts[0][0], tr.pts[0][1]);
        let head = tr.pts[tr.pts.length - 1];
        for (let i = 1; i < tr.pts.length; i++) {
          if (tr.cum[i] <= tr.drawn) {
            ctx.lineTo(tr.pts[i][0], tr.pts[i][1]);
          } else {
            const f = (tr.drawn - tr.cum[i - 1]) / (tr.cum[i] - tr.cum[i - 1]);
            head = [
              tr.pts[i - 1][0] + (tr.pts[i][0] - tr.pts[i - 1][0]) * f,
              tr.pts[i - 1][1] + (tr.pts[i][1] - tr.pts[i - 1][1]) * f,
            ];
            ctx.lineTo(head[0], head[1]);
            break;
          }
        }
        ctx.stroke();
        if (tr.state === "draw") {
          ctx.fillStyle = "#ffffff";
          ctx.shadowBlur = 16;
          ctx.beginPath();
          ctx.arc(head[0], head[1], 2.4, 0, Math.PI * 2);
          ctx.fill();
        } else if (tr.dot) {
          ctx.fillStyle = tr.color;
          ctx.shadowBlur = 12;
          ctx.beginPath();
          ctx.arc(tr.pts[tr.pts.length - 1][0], tr.pts[tr.pts.length - 1][1], 3, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.globalAlpha = 1;
      ctx.shadowBlur = 0;
      traces = traces.filter((t) => t.alpha > 0);
    };

    const tick = (now: number) => {
      const dt = Math.min(0.05, (now - (last || now)) / 1000);
      last = now;
      // idle shimmer when not hovered
      if (!hovered) {
        tgt.o = INTENSITY * 0.75;
        tgt.bx = 50 + Math.sin((now / 1000) * 0.35) * 45;
        tgt.by = 50 + Math.cos((now / 1000) * 0.28) * 45;
        tgt.gx = 50 + Math.sin((now / 1000) * 0.3) * 35;
        tgt.gy = 50 + Math.cos((now / 1000) * 0.22) * 35;
      }
      for (const k in cur) {
        const key = k as keyof typeof cur;
        const kf = key === "o" && tgt.o < cur.o ? 0.045 : 0.14;
        cur[key] += (tgt[key] - cur[key]) * kf;
      }
      const s = root.style;
      s.setProperty("--bx", cur.bx.toFixed(2) + "%");
      s.setProperty("--by", cur.by.toFixed(2) + "%");
      s.setProperty("--gx", cur.gx.toFixed(2) + "%");
      s.setProperty("--gy", cur.gy.toFixed(2) + "%");
      s.setProperty("--o", cur.o.toFixed(3));
      body.style.transform = `rotateX(${cur.rx.toFixed(2)}deg) rotateY(${cur.ry.toFixed(2)}deg)`;
      drawLines(dt);
      raf = requestAnimationFrame(tick);
    };

    const onMove = (e: PointerEvent) => {
      hovered = true;
      const r = body.getBoundingClientRect();
      setPointer((e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
    };
    const onLeave = () => {
      hovered = false;
      tgt.rx = 0;
      tgt.ry = 0;
    };

    body.addEventListener("pointermove", onMove);
    body.addEventListener("pointerleave", onLeave);

    // stop when the window is idle, reset last on resume so dt doesn't jump
    const stopIdle = onFxIdle((idle) => {
      if (idle) {
        cancelAnimationFrame(raf);
        raf = 0;
      } else if (!raf) {
        last = 0;
        raf = requestAnimationFrame(tick);
      }
    });

    return () => {
      cancelAnimationFrame(raf);
      stopIdle();
      ro.disconnect();
      body.removeEventListener("pointermove", onMove);
      body.removeEventListener("pointerleave", onLeave);
      body.style.transform = "";
      if (btn) btn.style.perspective = "";
    };
  }, []);

  return (
    <div ref={rootRef} aria-hidden className="pointer-events-none absolute inset-0 z-10">
      {/* 1 - circuit lines (screen) */}
      <canvas
        ref={canvasRef}
        className="absolute inset-0 h-full w-full"
        style={{ mixBlendMode: "screen", opacity: `calc(var(--o, 0) * ${LINE_OPACITY})` }}
      />
      {/* 2 - neon tint (screen) */}
      <div
        className="absolute inset-0"
        style={{
          backgroundImage: TINT,
          backgroundSize: "280% 280%",
          backgroundPosition: "var(--bx, 50%) var(--by, 50%)",
          mixBlendMode: "screen",
          opacity: "var(--o, 0)",
        }}
      />
      {/* 3 - light sweep (soft-light) */}
      <div
        className="absolute inset-0"
        style={{
          backgroundImage:
            "linear-gradient(115deg, transparent 32%, rgba(255,255,255,0.35) 47%, rgba(180,240,255,0.18) 52%, transparent 64%)",
          backgroundSize: "260% 260%",
          backgroundPosition: "var(--bx, 50%) var(--by, 50%)",
          mixBlendMode: "soft-light",
          opacity: "var(--o, 0)",
        }}
      />
      {/* 4 - glare following the mouse (overlay) */}
      <div
        className="absolute inset-0"
        style={{
          background:
            "radial-gradient(circle at var(--gx, 50%) var(--gy, 50%), rgba(255,255,255,0.5) 0%, rgba(255,255,255,0.1) 22%, transparent 55%)",
          mixBlendMode: "overlay",
          opacity: "var(--o, 0)",
        }}
      />
      {/* thin inner line, fades in with the reveal */}
      <div
        className="absolute rounded-[10px] border border-[#fcee0a]/30"
        style={{ inset: "8px", opacity: "calc(var(--o, 0) * 0.9)" }}
      />
    </div>
  );
}
