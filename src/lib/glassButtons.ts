/**
 * "Frosted buttons" setting (iridescent only). Off by default.
 *
 * The small pills sit inside a box that already has backdrop-blur. A blur inside a
 * blur draws a thin dark line on the button edge in WebView2 (depends on the
 * sub-pixel position). Since the box is already blurred, the extra blur barely
 * changes the look. It's a setting because the bug only shows in the real app.
 *
 * Set as data-glass-buttons on <html>, index.css adds the blur back from there.
 */

import { useEffect, useState } from "react";
import { queuePrefsSync } from "@/lib/prefs";

const STORAGE_KEY = "micoll.glassButtons";

export function getGlassButtons(): boolean {
  try {
    // off by default
    return localStorage.getItem(STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

const listeners = new Set<() => void>();

/** Set the flag on <html>. Can be called before React mounts. */
export function applyGlassButtons(): void {
  try {
    const root = document.documentElement;
    if (getGlassButtons()) root.dataset.glassButtons = "on";
    else delete root.dataset.glassButtons;
  } catch {
    /* ignore */
  }
}

export function setGlassButtons(on: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, on ? "true" : "false");
  } catch {
    /* ignore */
  }
  applyGlassButtons();
  queuePrefsSync();
  listeners.forEach((l) => l());
}

export function useGlassButtons(): boolean {
  const [on, setOn] = useState(getGlassButtons);
  useEffect(() => {
    const l = () => setOn(getGlassButtons());
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);
  return on;
}
