/**
 * "Open rewards in the overview" setting: does the viewer start with the first
 * picture (default) or the tile overview?
 * Only the start mode, the viewer's own overview button (G) doesn't change it.
 * The old micoll.viewerGrid key meant something else, so it's removed.
 */

import { useEffect, useState } from "react";
import { queuePrefsSync } from "@/lib/prefs";

const STORAGE_KEY = "micoll.viewerStart";

try {
  localStorage.removeItem("micoll.viewerGrid");
} catch {
  /* no storage, nothing to clean up */
}

export function getViewerStartsInGrid(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "overview";
  } catch {
    return false;
  }
}

const listeners = new Set<() => void>();

export function setViewerStartsInGrid(on: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, on ? "overview" : "viewer");
  } catch {
    /* ignore */
  }
  queuePrefsSync();
  listeners.forEach((l) => l());
}

/** Subscribe to the setting. */
export function useViewerStartsInGrid(): boolean {
  const [on, setOn] = useState(getViewerStartsInGrid());
  useEffect(() => {
    const l = () => setOn(getViewerStartsInGrid());
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);
  return on;
}
