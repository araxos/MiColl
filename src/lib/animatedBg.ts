/**
 * "Animated background" setting. When off, the live backgrounds of the premium
 * themes (iridescent WebGL, cyberpunk + sakura canvas) aren't mounted and a static
 * gradient is shown instead. The iridescent shader is the heaviest thing in the app.
 * On by default, saved in localStorage.
 */

import { useEffect, useState } from "react";
import { queuePrefsSync } from "@/lib/prefs";

const STORAGE_KEY = "micoll.animatedBg";

export function getAnimatedBg(): boolean {
  try {
    // on by default
    return localStorage.getItem(STORAGE_KEY) !== "false";
  } catch {
    return true;
  }
}

const listeners = new Set<() => void>();

export function setAnimatedBg(on: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, on ? "true" : "false");
  } catch {
    /* ignore */
  }
  queuePrefsSync();
  listeners.forEach((l) => l());
}

/** Subscribe to the setting. */
export function useAnimatedBg(): boolean {
  const [on, setOn] = useState(getAnimatedBg());
  useEffect(() => {
    const l = () => setOn(getAnimatedBg());
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);
  return on;
}
