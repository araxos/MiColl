/**
 * One-time hint bubble under the cinema / wishlist / graveyard buttons.
 * Once dismissed it never shows again (synced with the other prefs).
 */

import { useEffect, useState } from "react";
import { queuePrefsSync } from "@/lib/prefs";

const STORAGE_KEY = "micoll.topbarHintSeen";

export function getTopbarHintSeen(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    // no storage -> just don't show it
    return true;
  }
}

const listeners = new Set<() => void>();

export function dismissTopbarHint(): void {
  try {
    localStorage.setItem(STORAGE_KEY, "1");
  } catch {
    /* ignore */
  }
  queuePrefsSync();
  listeners.forEach((l) => l());
}

export function useTopbarHintSeen(): boolean {
  const [seen, setSeen] = useState(getTopbarHintSeen);
  useEffect(() => {
    const l = () => setSeen(getTopbarHintSeen());
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);
  return seen;
}
