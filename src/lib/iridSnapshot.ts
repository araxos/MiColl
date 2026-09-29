/**
 * Still picture of the iridescent background (JPEG data URL).
 * IridescentFx saves one frame here, and when the animated background is off
 * AppWallpaper shows this picture instead. Saved in localStorage.
 */

import { useEffect, useState } from "react";

const STORAGE_KEY = "micoll.iridSnapshot";

let current: string = (() => {
  try {
    return localStorage.getItem(STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
})();

const listeners = new Set<() => void>();

export function getIridSnapshot(): string {
  return current;
}

export function setIridSnapshot(dataUrl: string): void {
  if (!dataUrl || dataUrl === current) return;
  current = dataUrl;
  try {
    localStorage.setItem(STORAGE_KEY, dataUrl);
  } catch {
    /* storage full, keep it in memory only */
  }
  listeners.forEach((l) => l());
}

/** Subscribe to the snapshot. */
export function useIridSnapshot(): string {
  const [v, setV] = useState(current);
  useEffect(() => {
    const l = () => setV(current);
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);
  return v;
}
