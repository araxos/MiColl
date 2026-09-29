import { useEffect, useState } from "react";
import { queuePrefsSync } from "@/lib/prefs";

/**
 * Dashboard "cinema mode": hides the header, only the grid is left.
 * Still called minimal inside so the saved key stays the same.
 */
export const MINIMAL_EVENT = "micoll:minimal";
const KEY = "micoll.minimal";

export function getMinimal(): boolean {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

export function setMinimal(v: boolean) {
  try {
    localStorage.setItem(KEY, v ? "1" : "0");
  } catch {
    /* ignore */
  }
  queuePrefsSync();
  window.dispatchEvent(new CustomEvent(MINIMAL_EVENT));
}

export const toggleMinimal = () => setMinimal(!getMinimal());

export function useMinimal(): boolean {
  const [m, setM] = useState(getMinimal);
  useEffect(() => {
    const update = () => setM(getMinimal());
    window.addEventListener(MINIMAL_EVENT, update);
    window.addEventListener("storage", update);
    return () => {
      window.removeEventListener(MINIMAL_EVENT, update);
      window.removeEventListener("storage", update);
    };
  }, []);
  return m;
}
