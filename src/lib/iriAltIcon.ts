/**
 * Iridescent "alternate logo" setting (like rubyLogo.ts). Off by default.
 * When on (right-click the Iridescent swatch), the top bar shows the holo outline logo
 * (KdaMark) instead of the M, like MiColl Mobile's "Alt. icon".
 */

import { useEffect, useState } from "react";
import { queuePrefsSync } from "@/lib/prefs";

const STORAGE_KEY = "micoll.iriAltIcon";

export function getIriAltIcon(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

const listeners = new Set<() => void>();

export function setIriAltIcon(on: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, on ? "true" : "false");
  } catch {
    /* ignore */
  }
  queuePrefsSync();
  listeners.forEach((l) => l());
}

/** Subscribe to the setting. */
export function useIriAltIcon(): boolean {
  const [on, setOn] = useState(getIriAltIcon());
  useEffect(() => {
    const l = () => setOn(getIriAltIcon());
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);
  return on;
}
