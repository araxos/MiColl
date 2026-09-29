/**
 * How verified month cards show their mark on sakura:
 *   classic = blossom badge in the top left corner
 *   minimal = no badge, the card border glows pink instead
 * Changed by right-clicking the mark (not in Settings). Applies to all cards.
 */

import { useEffect, useState } from "react";
import { queuePrefsSync } from "@/lib/prefs";

export type VerifiedMarkStyle = "classic" | "minimal";

const STORAGE_KEY = "micoll.verifiedMark";
const DEFAULT: VerifiedMarkStyle = "classic";

export function getVerifiedMark(): VerifiedMarkStyle {
  try {
    return localStorage.getItem(STORAGE_KEY) === "minimal" ? "minimal" : DEFAULT;
  } catch {
    return DEFAULT;
  }
}

const listeners = new Set<() => void>();

export function setVerifiedMark(style: VerifiedMarkStyle): void {
  try {
    localStorage.setItem(STORAGE_KEY, style);
  } catch {
    /* ignore */
  }
  queuePrefsSync();
  listeners.forEach((l) => l());
}

/** Subscribe to the style (all cards re-render on change). */
export function useVerifiedMark(): VerifiedMarkStyle {
  const [style, setStyle] = useState(getVerifiedMark);
  useEffect(() => {
    const l = () => setStyle(getVerifiedMark());
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);
  return style;
}
