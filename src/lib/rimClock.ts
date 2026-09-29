/**
 * One clock for all iridescent card rims.
 * The rim gradient moves once around the card every 9s. With SMIL every card
 * repainted at 60fps on the CPU, now one clock drives all of them at 12fps.
 * Stops when nobody is looking (onFxIdle) or no card is mounted.
 */

import { onFxIdle } from "@/lib/fx";

/** One full pass along the rim (ms). */
const PERIOD_MS = 9000;

/** Ticks per second. 12 is enough, the steps are too small to see. */
const FPS = 12;

/**
 * Where we are in the pass (0 -> 1). Computed from the clock so late cards stay in sync.
 */
const phaseNow = () => (performance.now() % PERIOD_MS) / PERIOD_MS;

type Tick = (phase: number) => void;

const subs = new Set<Tick>();
let raf = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
let running = false;
let idle = false;

// wait with a timer, only draw in a frame (skipping rAF frames still runs all 60)
function tick() {
  raf = 0;
  const phase = phaseNow();
  for (const fn of subs) fn(phase);
  schedule();
}

function schedule() {
  if (!running) return;
  timer = setTimeout(() => {
    timer = undefined;
    raf = requestAnimationFrame(tick);
  }, 1000 / FPS);
}

function start() {
  if (running || idle || subs.size === 0) return;
  running = true;
  raf = requestAnimationFrame(tick);
}

function stop() {
  running = false;
  if (raf) cancelAnimationFrame(raf);
  raf = 0;
  if (timer) clearTimeout(timer);
  timer = undefined;
}

// stop when nobody is looking. Subscribed down here because onFxIdle fires right away.
if (typeof window !== "undefined") {
  onFxIdle((v) => {
    idle = v;
    if (idle) stop();
    else start();
  });
}

/** Subscribe a rim. Fires once right away so a new card starts at the right spot. */
export function subscribeRim(fn: Tick): () => void {
  subs.add(fn);
  fn(phaseNow());
  start();
  return () => {
    subs.delete(fn);
    if (subs.size === 0) stop();
  };
}
