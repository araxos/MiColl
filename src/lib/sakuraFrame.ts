/**
 * Sakura "card frame" setting (like cyberFrame.ts). Off by default.
 * When on (right-click the Sakura swatch), cards get the petal shaped frame
 * instead of the holo sheen.
 */

import { useEffect, useState } from "react";
import { queuePrefsSync } from "@/lib/prefs";

const STORAGE_KEY = "micoll.sakuraFrame";

export function getSakuraFrame(): boolean {
  try {
    // off by default
    return localStorage.getItem(STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

const listeners = new Set<() => void>();

export function setSakuraFrame(on: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, on ? "true" : "false");
  } catch {
    /* ignore */
  }
  queuePrefsSync();
  listeners.forEach((l) => l());
}

/** Subscribe to the setting. */
export function useSakuraFrame(): boolean {
  const [on, setOn] = useState(getSakuraFrame());
  useEffect(() => {
    const l = () => setOn(getSakuraFrame());
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);
  return on;
}
