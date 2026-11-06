/**
 * Pyre "card frame" setting (like sakuraFrame.ts). Off by default.
 * When on (right-click the Pyre swatch), cards get the neon/chrome frame instead
 * of the running light.
 */

import { useEffect, useState } from "react";
import { queuePrefsSync } from "@/lib/prefs";

const STORAGE_KEY = "micoll.rubyFrame";

export function getRubyFrame(): boolean {
  try {
    // off by default
    return localStorage.getItem(STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

const listeners = new Set<() => void>();

export function setRubyFrame(on: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, on ? "true" : "false");
  } catch {
    /* ignore */
  }
  queuePrefsSync();
  listeners.forEach((l) => l());
}

/** Subscribe to the setting. */
export function useRubyFrame(): boolean {
  const [on, setOn] = useState(getRubyFrame());
  useEffect(() => {
    const l = () => setOn(getRubyFrame());
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);
  return on;
}
