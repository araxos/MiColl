/**
 * Setting: show the wishlist button in the top bar.
 * Right-click it to hide it. The page is still at /wishlist and in the settings
 * gear's right-click menu (where the button can be turned back on). Not in Settings.
 */

import { useEffect, useState } from "react";
import { queuePrefsSync } from "@/lib/prefs";

const STORAGE_KEY = "micoll.wishlistButton";

export function getWishlistButton(): boolean {
  try {
    // on unless it's "false"
    return localStorage.getItem(STORAGE_KEY) !== "false";
  } catch {
    return true;
  }
}

const listeners = new Set<() => void>();

export function setWishlistButton(on: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, on ? "true" : "false");
  } catch {
    /* ignore */
  }
  queuePrefsSync();
  listeners.forEach((l) => l());
}

/** Subscribe to the setting. */
export function useWishlistButton(): boolean {
  const [on, setOn] = useState(getWishlistButton);
  useEffect(() => {
    const l = () => setOn(getWishlistButton());
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);
  return on;
}
