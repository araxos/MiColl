/**
 * "Premium look" for the classic (basic) accents: the setup screens' sand-and-crystal
 * backdrop behind the whole app, plus glassier panels, cards and header.
 * All of it is CSS under html[data-classic-luxe="1"], so turning it off gives back
 * exactly the old look ("OG - Look", right-click a classic theme in Settings).
 * On by default (= OG look off), saved in localStorage.
 */

import { useEffect, useState } from "react";
import { queuePrefsSync } from "@/lib/prefs";

const STORAGE_KEY = "micoll.classicLuxe";

export function getClassicLuxe(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) !== "false";
  } catch {
    return true;
  }
}

const listeners = new Set<() => void>();

export function setClassicLuxe(on: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, on ? "true" : "false");
  } catch {
    /* ignore */
  }
  queuePrefsSync();
  listeners.forEach((l) => l());
}

/** Subscribe to the setting. */
export function useClassicLuxe(): boolean {
  const [on, setOn] = useState(getClassicLuxe());
  useEffect(() => {
    const l = () => setOn(getClassicLuxe());
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);
  return on;
}
