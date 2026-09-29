/**
 * Safe mode = what the decoy password opens (Settings -> Security & lock).
 * SFW is forced on and Settings can't be opened. To get the full library back,
 * lock and unlock with the real password.
 * Only in memory, never saved, so nothing on disk shows a decoy was used.
 */

import { useEffect, useState } from "react";

let active = false;
const listeners = new Set<() => void>();

/**
 * Event so useSfwMode re-reads. Written out here instead of importing it
 * to avoid an import cycle with contentMode.
 */
const CONTENT_MODE_EVENT = "micoll:contentmode";

function notify() {
  listeners.forEach((l) => l());
  try {
    window.dispatchEvent(new CustomEvent(CONTENT_MODE_EVENT));
  } catch {
    /* non-DOM env */
  }
}

export function isSafeMode(): boolean {
  return active;
}

export function enterSafeMode(): void {
  if (active) return;
  active = true;
  notify();
}

export function leaveSafeMode(): void {
  if (!active) return;
  active = false;
  notify();
}

/** Subscribe to safe mode. */
export function useSafeMode(): boolean {
  const [on, setOn] = useState(active);
  useEffect(() => {
    const l = () => setOn(active);
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);
  return on;
}
