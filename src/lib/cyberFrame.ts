/**
 * Cyberpunk "card frame" setting. Off by default.
 * When on (right-click the Cyberpunk swatch in Settings), creator cards get a chip
 * shaped frame instead of the holo sheen + neon foil. Saved in localStorage.
 */

import { useEffect, useState } from "react";
import { queuePrefsSync } from "@/lib/prefs";

const STORAGE_KEY = "micoll.cyberFrame";

export function getCyberFrame(): boolean {
  try {
    // off by default
    return localStorage.getItem(STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

const listeners = new Set<() => void>();

export function setCyberFrame(on: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, on ? "true" : "false");
  } catch {
    /* ignore */
  }
  queuePrefsSync();
  listeners.forEach((l) => l());
}

/** Subscribe to the setting. */
export function useCyberFrame(): boolean {
  const [on, setOn] = useState(getCyberFrame());
  useEffect(() => {
    const l = () => setOn(getCyberFrame());
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);
  return on;
}
