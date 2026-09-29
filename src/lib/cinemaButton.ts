/**
 * Setting: show the cinema mode button in the top bar.
 * Right-click the button to hide it, bring it back from the settings gear's
 * right-click menu (same as the wishlist button). Not in Settings on purpose.
 */

import { useEffect, useState } from "react";
import { queuePrefsSync } from "@/lib/prefs";

const STORAGE_KEY = "micoll.cinemaButton";

export function getCinemaButton(): boolean {
  try {
    // on unless it's "false"
    return localStorage.getItem(STORAGE_KEY) !== "false";
  } catch {
    return true;
  }
}

const listeners = new Set<() => void>();

export function setCinemaButton(on: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, on ? "true" : "false");
  } catch {
    /* ignore */
  }
  queuePrefsSync();
  listeners.forEach((l) => l());
}

/** Subscribe to the setting. */
export function useCinemaButton(): boolean {
  const [on, setOn] = useState(getCinemaButton);
  useEffect(() => {
    const l = () => setOn(getCinemaButton());
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);
  return on;
}
