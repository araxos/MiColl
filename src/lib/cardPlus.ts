/**
 * Setting: show the "+" button on creator cards (opens a folder picker).
 * You can also drop a folder on the card, so the button can be hidden. On by default.
 * Saved as "show it" (Settings asks the opposite, "hide", and flips it there).
 */

import { useEffect, useState } from "react";
import { queuePrefsSync } from "@/lib/prefs";

const STORAGE_KEY = "micoll.cardPlus";

export function getCardPlus(): boolean {
  try {
    // on unless it's "false"
    return localStorage.getItem(STORAGE_KEY) !== "false";
  } catch {
    return true;
  }
}

const listeners = new Set<() => void>();

export function setCardPlus(on: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, on ? "true" : "false");
  } catch {
    /* ignore */
  }
  queuePrefsSync();
  listeners.forEach((l) => l());
}

/** Subscribe to the setting. */
export function useCardPlus(): boolean {
  const [on, setOn] = useState(getCardPlus);
  useEffect(() => {
    const l = () => setOn(getCardPlus());
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);
  return on;
}
