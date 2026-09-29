/**
 * "Pause animations when nobody is looking" setting.
 * The animations are what keep WebView2 busy, so this turns the Animations switch
 * off automatically while MiColl isn't visible (same switch, not just paused).
 * Levels: minimized, unfocused, or inactive (= both, old name kept for saved values).
 */

import { useEffect, useState } from "react";
import { queuePrefsSync } from "@/lib/prefs";
import type { IdlePause } from "@/lib/idlePause";

export type { IdlePause };

const STORAGE_KEY = "micoll.idlePause";
const DEFAULT: IdlePause = "inactive";

export function getIdlePause(): IdlePause {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === "off" || v === "minimized" || v === "unfocused" || v === "inactive") return v;
  } catch {
    /* ignore */
  }
  return DEFAULT;
}

const listeners = new Set<() => void>();

export function setIdlePause(v: IdlePause): void {
  try {
    localStorage.setItem(STORAGE_KEY, v);
  } catch {
    /* ignore */
  }
  queuePrefsSync();
  listeners.forEach((l) => l());
}

/** Subscribe to the setting (fx.ts uses this). */
export function onIdlePause(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function useIdlePause(): IdlePause {
  const [v, setV] = useState(getIdlePause);
  useEffect(() => onIdlePause(() => setV(getIdlePause())), []);
  return v;
}
