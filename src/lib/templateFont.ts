/**
 * "Template display font" setting.
 * Cards with a template show the name in a display font (KDA on iridescent,
 * MiColl Cut on cyberpunk). Those miss some letters, so this can turn them off.
 * On by default. Sakura has no display font.
 * Set as data-template-font="off" on <html> (only when off).
 * ArtistCard also reads it for the name size and the verified check.
 */

import { useEffect, useState } from "react";
import { queuePrefsSync } from "@/lib/prefs";

const STORAGE_KEY = "micoll.templateFont";

export function getTemplateFont(): boolean {
  try {
    // on by default
    return localStorage.getItem(STORAGE_KEY) !== "false";
  } catch {
    return true;
  }
}

const listeners = new Set<() => void>();

/** Set the flag on <html>. Can be called before React mounts. */
export function applyTemplateFont(): void {
  try {
    const root = document.documentElement;
    if (getTemplateFont()) delete root.dataset.templateFont;
    else root.dataset.templateFont = "off";
  } catch {
    /* ignore */
  }
}

export function setTemplateFont(on: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, on ? "true" : "false");
  } catch {
    /* ignore */
  }
  applyTemplateFont();
  queuePrefsSync();
  listeners.forEach((l) => l());
}

export function useTemplateFont(): boolean {
  const [on, setOn] = useState(getTemplateFont);
  useEffect(() => {
    const l = () => setOn(getTemplateFont());
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);
  return on;
}
