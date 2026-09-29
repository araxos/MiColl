/**
 * "Show hidden creators" mode, to get back a card you hid.
 * Hidden is saved in the DB (artists.hidden), this is just a view mode.
 * While on, hidden creators show up again (marked as hidden) and can be un-hidden.
 * Can be switched from the settings gear menu, Settings -> Appearance and the card menu.
 */

import { useEffect, useState } from "react";
import { queuePrefsSync } from "@/lib/prefs";

const STORAGE_KEY = "micoll.showHidden";

export function getShowHidden(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

const listeners = new Set<() => void>();

export function setShowHidden(on: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, on ? "true" : "false");
  } catch {
    /* ignore */
  }
  queuePrefsSync();
  listeners.forEach((l) => l());
}

export function toggleShowHidden(): void {
  setShowHidden(!getShowHidden());
}

/** Subscribe to the setting. */
export function useShowHidden(): boolean {
  const [on, setOn] = useState(getShowHidden);
  useEffect(() => {
    const l = () => setOn(getShowHidden());
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);
  return on;
}
