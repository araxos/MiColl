import { useEffect, useState } from "react";
import { queuePrefsSync } from "@/lib/prefs";

/** Pinned artists (shown at the top of the dashboard). */
export const PINS_EVENT = "micoll:pins";
const KEY = "micoll.pins";

export function getPins(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function save(pins: string[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(pins));
  } catch {
    /* ignore */
  }
  queuePrefsSync();
  window.dispatchEvent(new CustomEvent(PINS_EVENT));
}

export function togglePin(id: string) {
  const p = getPins();
  save(p.includes(id) ? p.filter((x) => x !== id) : [...p, id]);
}

/** Set of pinned artist ids (updates on change). */
export function usePins(): Set<string> {
  const [pins, setPins] = useState<Set<string>>(() => new Set(getPins()));
  useEffect(() => {
    const update = () => setPins(new Set(getPins()));
    window.addEventListener(PINS_EVENT, update);
    window.addEventListener("storage", update);
    return () => {
      window.removeEventListener(PINS_EVENT, update);
      window.removeEventListener("storage", update);
    };
  }, []);
  return pins;
}
