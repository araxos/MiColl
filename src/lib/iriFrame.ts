/**
 * Iridescent "card frame" setting (like cyberFrame.ts / sakuraFrame.ts). Off by default.
 * When on (right-click the Iridescent swatch), cards get the liquid rim frame
 * instead of the shared holo.
 */

import { useEffect, useState } from "react";
import { queuePrefsSync } from "@/lib/prefs";

const STORAGE_KEY = "micoll.iriFrame";

export function getIriFrame(): boolean {
  try {
    // off by default
    return localStorage.getItem(STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

const listeners = new Set<() => void>();

export function setIriFrame(on: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, on ? "true" : "false");
  } catch {
    /* ignore */
  }
  queuePrefsSync();
  listeners.forEach((l) => l());
}

/** Subscribe to the setting. */
export function useIriFrame(): boolean {
  const [on, setOn] = useState(getIriFrame());
  useEffect(() => {
    const l = () => setOn(getIriFrame());
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);
  return on;
}
