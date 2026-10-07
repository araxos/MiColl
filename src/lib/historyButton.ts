/**
 * Setting: show the history button in the top bar.
 * Right-click it to hide it. The log is still in Settings → History, and the settings
 * gear's right-click menu turns the button back on. Not in Settings.
 */

import { useEffect, useState } from "react";
import { queuePrefsSync } from "@/lib/prefs";

const STORAGE_KEY = "micoll.historyButton";

export function getHistoryButton(): boolean {
  try {
    // on unless it's "false"
    return localStorage.getItem(STORAGE_KEY) !== "false";
  } catch {
    return true;
  }
}

const listeners = new Set<() => void>();

export function setHistoryButton(on: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, on ? "true" : "false");
  } catch {
    /* ignore */
  }
  queuePrefsSync();
  listeners.forEach((l) => l());
}

/** Subscribe to the setting. */
export function useHistoryButton(): boolean {
  const [on, setOn] = useState(getHistoryButton);
  useEffect(() => {
    const l = () => setOn(getHistoryButton());
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);
  return on;
}
