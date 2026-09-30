/**
 * Size of the creator name on the dashboard cards, 7 steps.
 * 4 is the size every font was tuned to, 1 very small, 7 very large.
 * It scales each font's own base size, so KDA / cyberpunk / iridescent keep their
 * proportions. Saved with the library.
 */

import { useEffect, useState } from "react";
import { queuePrefsSync } from "@/lib/prefs";

const STORAGE_KEY = "micoll.cardNameSize";

export const CARD_NAME_MIN = 1;
export const CARD_NAME_MAX = 7;
export const CARD_NAME_DEFAULT = 4;

/** Factor per step (index 0 = step 1). */
const SCALES = [0.7, 0.8, 0.9, 1, 1.12, 1.25, 1.4];

export function cardNameScale(step: number): number {
  return SCALES[step - 1] ?? 1;
}

export function getCardNameSize(): number {
  try {
    const v = parseInt(localStorage.getItem(STORAGE_KEY) ?? "", 10);
    return v >= CARD_NAME_MIN && v <= CARD_NAME_MAX ? v : CARD_NAME_DEFAULT;
  } catch {
    return CARD_NAME_DEFAULT;
  }
}

const listeners = new Set<() => void>();

export function setCardNameSize(step: number): void {
  const v = Math.min(CARD_NAME_MAX, Math.max(CARD_NAME_MIN, Math.round(step)));
  try {
    localStorage.setItem(STORAGE_KEY, String(v));
  } catch {
    /* ignore */
  }
  queuePrefsSync();
  listeners.forEach((l) => l());
}

/** Subscribe to the setting. */
export function useCardNameSize(): number {
  const [v, setV] = useState(getCardNameSize());
  useEffect(() => {
    const l = () => setV(getCardNameSize());
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);
  return v;
}
