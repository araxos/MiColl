/**
 * "Hide creator names" setting. When on, cards only show the name on hover
 * (nice for screen sharing). Saved in localStorage.
 */

import { useEffect, useState } from "react";
import { queuePrefsSync } from "@/lib/prefs";

const STORAGE_KEY = "micoll.hideNames";

export function getHideNames(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

const listeners = new Set<() => void>();

export function setHideNames(on: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, on ? "true" : "false");
  } catch {
    /* ignore */
  }
  queuePrefsSync();
  listeners.forEach((l) => l());
}

/** Subscribe to the setting. */
export function useHideNames(): boolean {
  const [on, setOn] = useState(getHideNames());
  useEffect(() => {
    const l = () => setOn(getHideNames());
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);
  return on;
}
