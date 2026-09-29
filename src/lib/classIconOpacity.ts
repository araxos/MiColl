/**
 * Setting: how visible the class icon (heart, star...) on creator cards is.
 * 0 = hidden, 100 = fully visible. Saved in localStorage.
 */

import { useEffect, useState } from "react";
import { queuePrefsSync } from "@/lib/prefs";

const STORAGE_KEY = "micoll.classIconOpacity";

const DEFAULT = 100;

/** percent, 0-100 */
export function getClassIconOpacity(): number {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw !== null) {
      const v = Math.round(Number(raw));
      if (Number.isFinite(v)) return Math.min(100, Math.max(0, v));
    }
  } catch {
    /* ignore */
  }
  return DEFAULT;
}

const listeners = new Set<() => void>();

export function setClassIconOpacity(pct: number): void {
  const v = Math.min(100, Math.max(0, Math.round(pct)));
  try {
    localStorage.setItem(STORAGE_KEY, String(v));
  } catch {
    /* ignore */
  }
  queuePrefsSync();
  listeners.forEach((l) => l());
}

/** Subscribe to the setting. */
export function useClassIconOpacity(): number {
  const [pct, setPct] = useState(getClassIconOpacity());
  useEffect(() => {
    const l = () => setPct(getClassIconOpacity());
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);
  return pct;
}
