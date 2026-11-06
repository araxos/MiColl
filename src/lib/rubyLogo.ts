/**
 * Pyre "alternate logo" setting. Off by default.
 * When on (right-click the Pyre swatch), the app shows the silver flame M instead of
 * the normal Pyre logo.
 */

import { useEffect, useState } from "react";
import { queuePrefsSync } from "@/lib/prefs";

const STORAGE_KEY = "micoll.rubyAltLogo";

export function getRubyAltLogo(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

const listeners = new Set<() => void>();

export function setRubyAltLogo(on: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, on ? "true" : "false");
  } catch {
    /* ignore */
  }
  queuePrefsSync();
  listeners.forEach((l) => l());
}

/** Subscribe to the setting. */
export function useRubyAltLogo(): boolean {
  const [on, setOn] = useState(getRubyAltLogo());
  useEffect(() => {
    const l = () => setOn(getRubyAltLogo());
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);
  return on;
}
