/**
 * Setting: show platforms + reward count on creator cards (the row that slides up
 * on hover). On by default. When off, the card shows one line and a lighter shadow.
 * Saved in localStorage.
 */

import { useEffect, useState } from "react";
import { queuePrefsSync } from "@/lib/prefs";

const STORAGE_KEY = "micoll.cardMeta";

export function getCardMeta(): boolean {
  try {
    // on unless it's "false"
    return localStorage.getItem(STORAGE_KEY) !== "false";
  } catch {
    return true;
  }
}

const listeners = new Set<() => void>();

export function setCardMeta(on: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, on ? "true" : "false");
  } catch {
    /* ignore */
  }
  queuePrefsSync();
  listeners.forEach((l) => l());
}

/** Subscribe to the setting. */
export function useCardMeta(): boolean {
  const [on, setOn] = useState(getCardMeta);
  useEffect(() => {
    const l = () => setOn(getCardMeta());
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);
  return on;
}
