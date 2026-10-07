import { useEffect, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import { CrystalProgress } from "@/components/ui/CrystalProgress";
import type { AccentKey } from "@/lib/theme";

/**
 * What the picture does while the editor works on it (AI remove, Expand, upscale …), in
 * the premium themes. Sits on top of the picture being changed:
 *   · iridescent: a faint pearl sheen, a turning pastel hairline, small stars, rising
 *     motes of light and now and then a thin glint
 *   · cyberpunk: scanlines, a scan bar, red data streams and a rare thin glitch
 *   · sakura: cherry branches growing out of the left edge one above the other, their
 *     blossoms opening and only then letting petals go on the wind (see SakuraFx)
 * Basic themes get nothing (the busy note is enough there). Off with the Animations
 * switch (index.css). Pure CSS, the numbers below only place the pieces.
 */
export function AiWorkFx({
  accent,
  progress = null,
}: {
  accent: AccentKey;
  /** 0..1 when the job reports it (sakura grows its branches with it). */
  progress?: number | null;
}) {
  // fixed "random" spots, the same on every render
  const spots = useMemo(
    () =>
      Array.from({ length: 36 }, (_, i) => {
        const r = (k: number) => {
          const v = Math.sin((i + 1) * 12.9898 + k * 78.233) * 43758.5453;
          return v - Math.floor(v);
        };
        return { x: r(1) * 100, y: r(2) * 100, d: r(3), s: r(4) };
      }),
    [],
  );
  const streams = useMemo(
    () =>
      spots.slice(0, 14).map((_, i) =>
        Array.from({ length: 40 }, (_, k) => {
          const v = Math.sin((i + 3) * 91.7 + k * 17.3) * 9341.17;
          return Math.floor((v - Math.floor(v)) * 256)
            .toString(16)
            .padStart(2, "0")
            .toUpperCase();
        }).join("\n"),
      ),
    [spots],
  );

  if (accent === "iridescent") {
    return (
      <div className="aifx aifx-iri" aria-hidden>
        <div className="aifx-iri-sheen" />
        <div className="aifx-iri-glint" />
        {spots.slice(0, 22).map((p, i) => (
          <span
            key={i}
            className="aifx-iri-star"
            style={{
              left: `${p.x}%`,
              top: `${p.y}%`,
              animationDelay: `-${(p.d * 3.6).toFixed(2)}s`,
              ["--sz" as string]: `${8 + p.s * 8}px`,
            }}
          />
        ))}
        {spots.slice(22).map((p, i) => (
          <span
            key={i}
            className="aifx-iri-mote"
            style={{
              left: `${p.x}%`,
              animationDuration: `${(6 + p.s * 5).toFixed(2)}s`,
              animationDelay: `-${(p.d * 9).toFixed(2)}s`,
              ["--drift" as string]: `${(p.d - 0.5) * 60}px`,
            }}
          />
        ))}
        <div className="aifx-iri-rim" />
      </div>
    );
  }
  if (accent === "cyberpunk") {
    return (
      <div className="aifx aifx-cy" aria-hidden>
        <div className="aifx-cy-lines" />
        {spots.slice(0, 3).map((p, i) => (
          <div
            key={i}
            className={`aifx-cy-band aifx-cy-band--${i % 3}`}
            style={{
              top: `${p.y * 0.95}%`,
              height: `${0.6 + p.s * 1.6}%`,
              animationDelay: `-${(p.d * 5.5).toFixed(2)}s`,
            }}
          />
        ))}
        {streams.map((txt, i) => (
          <div
            key={i}
            className={`aifx-cy-stream${i % 3 === 0 ? " aifx-cy-stream--y" : ""}`}
            style={{
              left: `${3 + i * 7}%`,
              animationDuration: `${(2.2 + spots[i].s * 2.6).toFixed(2)}s`,
              animationDelay: `-${(spots[i].d * 3).toFixed(2)}s`,
            }}
          >
            {txt}
          </div>
        ))}
        <div className="aifx-cy-bar" />
      </div>
    );
  }
  if (accent === "sakura") return <SakuraFx progress={progress} />;
  return null;
}

/** One cherry petal (notched tip), pointing up from 0,0. */
const PETAL = "M0 0 C-6 -4 -7 -12 -3 -16 L0 -13.5 L3 -16 C7 -12 6 -4 0 0 Z";

/** Where the blossoms sit on the branch: x, y, size, when they open (s). */
const BRANCH_FLOWERS: [number, number, number, number][] = [
  [58, 108, 1, 0.5],
  [92, 72, 0.9, 0.9],
  [122, 82, 1.1, 1.2],
  [158, 40, 0.85, 1.6],
  [178, 59, 1, 1.9],
  [197, 51, 0.8, 2.2],
];

/** A five-petal cherry blossom around 0,0 with a golden heart. */
function Blossom({ scale, fill }: { scale: number; fill: string }) {
  return (
    <g transform={`scale(${scale})`}>
      {[0, 1, 2, 3, 4].map((i) => (
        <path key={i} d={PETAL} transform={`rotate(${i * 72})`} fill={fill} />
      ))}
      <circle r="2.4" fill="#fde68a" />
    </g>
  );
}

/**
 * Sakura: four branches grow out of the left edge, bottom first, then at 25%, 50% and
 * 75% of the height. They start early (by 45% of the job, or every 3 s, whichever
 * comes first; a quarter each made the last one bloom just as the job ended), each
 * then grows at its own calm pace. Petals only leave a branch once it has blossomed, so the petals start at the
 * bottom and climb with the branches.
 */
function SakuraFx({ progress }: { progress: number | null }) {
  const [grown, setGrown] = useState(1);
  // by the job's progress (never back down, HQ starts its second half at 50%)
  useEffect(() => {
    if (progress == null) return;
    const byProgress = 1 + GROW_AT.filter((at) => progress >= at).length;
    setGrown((g) => Math.max(g, byProgress));
  }, [progress]);
  // and by time, one more every 3 s
  useEffect(() => {
    const id = window.setInterval(() => setGrown((g) => Math.min(4, g + 1)), 3000);
    return () => window.clearInterval(id);
  }, []);

  return (
    <div className="aifx aifx-sak" aria-hidden>
      <div className="aifx-sak-blush" />
      <svg width="0" height="0" className="absolute">
        <defs>
          <linearGradient id="aifx-sak-g" x1="0" y1="-16" x2="0" y2="0" gradientUnits="userSpaceOnUse">
            <stop offset="0" stopColor="#fff0f6" />
            <stop offset="1" stopColor="#f472b6" />
          </linearGradient>
        </defs>
      </svg>
      {SAKURA_LEVELS.slice(0, grown).map((lv, i) => (
        <SakuraLevel key={i} level={lv} index={i} />
      ))}
    </div>
  );
}

/** Progress at which the 2nd, 3rd and 4th branch grow. */
const GROW_AT = [0.15, 0.3, 0.45];

/** One branch: where it sits (y from the top, %), how it looks and how far its petals sink. */
interface SakuraBranch {
  y: number;
  kind: "corner" | "rise" | "droop";
  fall: number;
}
const SAKURA_LEVELS: SakuraBranch[] = [
  { y: 88, kind: "corner", fall: 6 },
  { y: 70, kind: "rise", fall: 12 },
  { y: 47, kind: "droop", fall: 14 },
  { y: 24, kind: "rise", fall: 16 },
];

/** The side branches in a 200x70 box: stems (path, width, delay) and blossoms (x, y, size, delay). */
const SIDE_BRANCHES: Record<
  "rise" | "droop",
  { stems: [string, number, number][]; flowers: [number, number, number, number][] }
> = {
  rise: {
    stems: [
      ["M-4 50 C30 46 62 38 100 30 S160 18 192 20", 3.2, 0],
      ["M88 33 C92 22 102 14 114 12", 1.8, 0.7],
    ],
    flowers: [
      [46, 43, 0.9, 0.7],
      [100, 30, 1, 1.0],
      [114, 12, 0.85, 1.3],
      [150, 22, 1.05, 1.5],
      [190, 20, 0.8, 1.8],
    ],
  },
  droop: {
    stems: [
      ["M-4 20 C34 22 66 30 102 40 S160 56 190 52", 3.2, 0],
      ["M110 43 C116 54 124 60 136 62", 1.8, 0.7],
    ],
    flowers: [
      [50, 26, 0.9, 0.7],
      [96, 38, 1, 1.0],
      [136, 62, 0.85, 1.3],
      [156, 51, 1.05, 1.5],
      [189, 52, 0.8, 1.8],
    ],
  },
};

function Flowers({ list }: { list: [number, number, number, number][] }) {
  return (
    <>
      {list.map(([x, y, k, d], i) => (
        <g key={i} transform={`translate(${x} ${y})`}>
          <g className="flower" style={{ ["--d" as string]: `${d}s` }}>
            <Blossom scale={0.55 * k} fill="url(#aifx-sak-g)" />
          </g>
        </g>
      ))}
    </>
  );
}

function SakuraLevel({ level, index }: { level: SakuraBranch; index: number }) {
  const petals = useMemo(
    () =>
      Array.from({ length: 5 }, (_, k) => {
        const v = (n: number) => {
          const x = Math.sin((index * 5 + k + 1) * 45.17 + n * 12.9) * 9137.3;
          return x - Math.floor(x);
        };
        return { y: level.y + (v(1) - 0.5) * 10, s: v(2), d: v(3), far: k % 3 === 2 };
      }),
    [index, level.y],
  );
  return (
    <>
      {level.kind === "corner" ? (
        <svg className="aifx-sak-branch" viewBox="0 0 200 140">
          <path className="stem" strokeWidth="4" d="M-4 138 C30 120 60 108 96 92 S160 64 196 52" />
          <path className="stem" strokeWidth="2.2" d="M70 103 C72 88 80 78 92 72" style={{ animationDelay: "0.6s" }} />
          <path className="stem" strokeWidth="2" d="M140 70 C138 56 146 46 158 40" style={{ animationDelay: "1.1s" }} />
          <Flowers list={BRANCH_FLOWERS} />
        </svg>
      ) : (
        <svg className="aifx-sak-twig" viewBox="0 0 200 70" style={{ top: `${level.y}%` }}>
          {SIDE_BRANCHES[level.kind].stems.map(([d, w, delay], i) => (
            <path key={i} className="stem" strokeWidth={w} d={d} style={{ animationDelay: `${delay}s` }} />
          ))}
          <Flowers list={SIDE_BRANCHES[level.kind].flowers} />
        </svg>
      )}
      {/* its petals, once the blossoms are open (from ~1.5 s after the branch) */}
      {petals.map((p, k) => (
        <span
          key={k}
          className={`aifx-sak-glide${p.far ? " aifx-sak-glide--far" : ""}`}
          style={{
            animationDuration: `${(7 + p.s * 5).toFixed(2)}s`,
            animationDelay: `${(1.5 + p.d * 4).toFixed(2)}s`,
            ["--y" as string]: `${p.y.toFixed(1)}%`,
            ["--fall" as string]: `${level.fall}%`,
            ["--sz" as string]: `${p.far ? 11 + p.s * 6 : 14 + p.s * 10}px`,
          }}
        />
      ))}
    </>
  );
}

/** true once busy has lasted a moment: quick steps (flip, crop) don't flash the effect. */
export function useLongBusy(busy: boolean, after = 450): boolean {
  const [long, setLong] = useState(false);
  useEffect(() => {
    if (!busy) {
      setLong(false);
      return;
    }
    const id = window.setTimeout(() => setLong(true), after);
    return () => window.clearTimeout(id);
  }, [busy, after]);
  return long;
}

/**
 * The note in the middle while the editor works. On iridescent a glass card with the
 * theme's crystal, filling with the real progress (0..1) or gently rising and falling
 * when there's none. On cyberpunk a HUD readout with a segmented bar, on sakura a
 * cherry blossom whose petals fill one by one. Elsewhere the plain spinner note.
 */
export function BusyNote({
  accent,
  msg,
  progress,
}: {
  accent: AccentKey;
  msg: string;
  progress: number | null;
}) {
  // no progress known: the crystal breathes between a quarter and three quarters
  const [wave, setWave] = useState(0.5);
  useEffect(() => {
    if (accent !== "iridescent" || progress != null) return;
    const t0 = performance.now();
    let raf = 0;
    const tick = (t: number) => {
      setWave(0.5 + 0.25 * Math.sin((t - t0) / 650));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [accent, progress]);

  if (accent === "cyberpunk") {
    const on = progress == null ? 0 : Math.round(progress * 20);
    return (
      <div className="aifx-note-cy">
        <div className="aifx-note-cy-head">
          <span>{msg}</span>
          {progress != null && (
            <span className="aifx-note-cy-pct">{String(Math.round(progress * 100)).padStart(3, "0")}%</span>
          )}
        </div>
        <div className={`aifx-note-cy-bar${progress == null ? " aifx-note-cy-bar--loop" : ""}`}>
          {Array.from({ length: 20 }, (_, i) => (
            <i
              key={i}
              data-on={i < on || undefined}
              style={progress == null ? { animationDelay: `${(i * 0.07).toFixed(2)}s` } : undefined}
            />
          ))}
        </div>
      </div>
    );
  }
  if (accent === "sakura") {
    // one petal per 20%, the one being worked on already counts
    const on = progress == null ? 0 : Math.ceil(progress * 5 - 0.001);
    return (
      <div className={`aifx-note-sak${progress == null ? " aifx-note-sak--loop" : ""}`}>
        <svg viewBox="-18 -18 36 36" width={30} height={30}>
          <defs>
            <linearGradient id="aifx-sak-petal-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#fff0f6" />
              <stop offset="1" stopColor="#ec4899" />
            </linearGradient>
          </defs>
          {[0, 1, 2, 3, 4].map((i) => (
            <path
              key={i}
              className="petal"
              d={PETAL}
              transform={`rotate(${i * 72})`}
              data-on={i < on || undefined}
              style={progress == null ? { animationDelay: `${(i * 0.4).toFixed(1)}s` } : undefined}
            />
          ))}
          <circle r="2.6" fill="#fde68a" />
        </svg>
        <div className="flex flex-col">
          <span>{msg}</span>
          {progress != null && (
            <span className="aifx-note-sak-pct">{Math.round(progress * 100)}%</span>
          )}
        </div>
      </div>
    );
  }
  if (accent === "iridescent") {
    return (
      <div className="aifx-note-iri">
        <div className="aifx-iri-rim absolute inset-0 rounded-[inherit]" />
        <CrystalProgress value={progress ?? wave} size={30} />
        <div className="flex flex-col">
          <span>{msg}</span>
          {progress != null && (
            <span className="aifx-note-iri-pct">{Math.round(progress * 100)}%</span>
          )}
        </div>
      </div>
    );
  }
  // the other themes: the pill with a bar in the theme color (fills when the job says how
  // far it is, else a piece slides through like on the toasts)
  return (
    <div className="flex min-w-[16rem] flex-col gap-2 rounded-xl bg-zinc-900/90 px-4 py-2.5 text-sm text-zinc-100 shadow-2xl">
      <div className="flex items-center gap-2">
        <Loader2 className="h-4 w-4 shrink-0 animate-spin text-brand-300" />
        <span className="flex-1">{msg}</span>
        {progress != null && (
          <span className="text-xs tabular-nums text-zinc-400">{Math.round(progress * 100)}%</span>
        )}
      </div>
      <div className="relative h-1 overflow-hidden rounded-full bg-white/10">
        {progress == null ? (
          <div className="toast-indeterminate absolute inset-y-0 w-1/3 rounded-full bg-brand-400" />
        ) : (
          <div
            className="h-full rounded-full bg-brand-400 transition-[width] duration-300 ease-out"
            style={{ width: `${Math.max(2, Math.min(1, progress) * 100)}%` }}
          />
        )}
      </div>
    </div>
  );
}
