/**
 * Holo frequency: how often iridescent cards play their holo burst.
 * 5 levels, 3 = normal. 1-2 = rarer (less CPU/GPU, lower frame rate), 4-5 = more often.
 * Saved in localStorage.
 */

import { useEffect, useState } from "react";
import { setHoloFrameRate } from "@/lib/holoEngine";
import { queuePrefsSync } from "@/lib/prefs";

const STORAGE_KEY = "micoll.holoFreq";

export type HoloFreq = 1 | 2 | 3 | 4 | 5;

export const HOLO_FREQ_LABELS: Record<HoloFreq, string> = {
  1: "Very rare",
  2: "Rare",
  3: "Normal",
  4: "Frequent",
  5: "Very frequent",
};

/** multiplier for the burst cycle (bigger = rarer) */
export const HOLO_PERIOD_SCALE: Record<HoloFreq, number> = {
  1: 3.2,
  2: 1.9,
  3: 1,
  4: 0.55,
  5: 0.32,
};

/** engine fps per level */
const HOLO_FPS: Record<HoloFreq, number> = {
  1: 20,
  2: 24,
  3: 30,
  4: 30,
  5: 30,
};

export function getHoloFreq(): HoloFreq {
  try {
    const v = Number(localStorage.getItem(STORAGE_KEY));
    if (v >= 1 && v <= 5) return v as HoloFreq;
  } catch {
    /* ignore */
  }
  return 3;
}

/**
 * Set <html data-holo-freq> so CSS can stop the always-on iridescent animations
 * on the low levels (they cost more than the WebGL bursts).
 */
function applyAttr(level: HoloFreq): void {
  try {
    document.documentElement.dataset.holoFreq = String(level);
  } catch {
    /* ignore (non-DOM env) */
  }
}

// apply the saved level on load
setHoloFrameRate(HOLO_FPS[getHoloFreq()]);
applyAttr(getHoloFreq());

const listeners = new Set<() => void>();

export function setHoloFreq(level: HoloFreq): void {
  try {
    localStorage.setItem(STORAGE_KEY, String(level));
  } catch {
    /* ignore */
  }
  queuePrefsSync();
  setHoloFrameRate(HOLO_FPS[level]);
  applyAttr(level);
  listeners.forEach((l) => l());
}

/** Subscribe to the setting. */
export function useHoloFreq(): HoloFreq {
  const [level, setLevel] = useState<HoloFreq>(getHoloFreq());
  useEffect(() => {
    const l = () => setLevel(getHoloFreq());
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);
  return level;
}
