/**
 * "Optimize large images" setting. When on, the viewer shows a smaller preview
 * of very big images so scrolling stays smooth. The file itself isn't changed.
 * On by default.
 */

import { useEffect, useState } from "react";

const STORAGE_KEY = "micoll.optimizeLargeImages";

export function getOptimizeLargeImages(): boolean {
  try {
    // on by default
    return localStorage.getItem(STORAGE_KEY) !== "false";
  } catch {
    return true;
  }
}

const listeners = new Set<() => void>();

export function setOptimizeLargeImages(on: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, on ? "true" : "false");
  } catch {
    /* ignore */
  }
  listeners.forEach((l) => l());
}

/** Subscribe to the setting. */
export function useOptimizeLargeImages(): boolean {
  const [on, setOn] = useState(getOptimizeLargeImages());
  useEffect(() => {
    const l = () => setOn(getOptimizeLargeImages());
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);
  return on;
}
