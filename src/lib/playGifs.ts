/**
 * "Play GIFs" setting. When on, GIF covers play, when off they show the still thumbnail.
 * On by default.
 */

import { useEffect, useState } from "react";
import { queuePrefsSync } from "@/lib/prefs";

const STORAGE_KEY = "micoll.playGifs";

export function getPlayGifs(): boolean {
  try {
    // on by default
    return localStorage.getItem(STORAGE_KEY) !== "false";
  } catch {
    return true;
  }
}

const listeners = new Set<() => void>();

export function setPlayGifs(on: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, on ? "true" : "false");
  } catch {
    /* ignore */
  }
  queuePrefsSync();
  listeners.forEach((l) => l());
}

/** Subscribe to the setting. */
export function usePlayGifs(): boolean {
  const [on, setOn] = useState(getPlayGifs());
  useEffect(() => {
    const l = () => setOn(getPlayGifs());
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);
  return on;
}

/** Is this a GIF (by extension)? */
export function isGifPath(path?: string | null): boolean {
  return !!path && /\.gif$/i.test(path);
}
