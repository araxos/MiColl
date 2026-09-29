/**
 * Custom app wallpaper.
 * Only the path is saved, the picture is loaded from disk on start
 * (a big image would not fit into localStorage).
 * dim = black overlay over the wallpaper, max 60%.
 */

import { useEffect, useState } from "react";
import { queuePrefsSync } from "@/lib/prefs";

const PATH_KEY = "micoll.wallpaper";
const DIM_KEY = "micoll.wallpaperDim";

/**
 * Built-in wallpapers are saved as "preset:<id>", everything else is a file path.
 * Only iridescent has presets for now.
 */
export const WALLPAPER_PRESET_PREFIX = "preset:";

/** Is it a built-in instead of a file path? */
export function isWallpaperPreset(v: string): boolean {
  return v.startsWith(WALLPAPER_PRESET_PREFIX);
}

/** The id in a preset: value ("" if it isn't one). */
export function wallpaperPresetId(v: string): string {
  return isWallpaperPreset(v) ? v.slice(WALLPAPER_PRESET_PREFIX.length) : "";
}

/** Max dim (100% would just be black). */
export const MAX_DIM = 60;

export function getWallpaper(): string {
  try {
    return localStorage.getItem(PATH_KEY) ?? "";
  } catch {
    return "";
  }
}

export function getWallpaperDim(): number {
  try {
    const v = Number(localStorage.getItem(DIM_KEY));
    if (Number.isFinite(v)) return Math.min(MAX_DIM, Math.max(0, Math.round(v)));
  } catch {
    /* ignore */
  }
  return 0;
}

const listeners = new Set<() => void>();
const notify = () => {
  queuePrefsSync();
  listeners.forEach((l) => l());
};

/** Set the wallpaper, or "" to go back to the theme background. */
export function setWallpaper(path: string): void {
  try {
    if (path) localStorage.setItem(PATH_KEY, path);
    else localStorage.removeItem(PATH_KEY);
  } catch {
    /* ignore */
  }
  notify();
}

export function setWallpaperDim(pct: number): void {
  const v = Math.min(MAX_DIM, Math.max(0, Math.round(pct)));
  try {
    localStorage.setItem(DIM_KEY, String(v));
  } catch {
    /* ignore */
  }
  notify();
}

function useSetting<T>(read: () => T): T {
  const [v, setV] = useState<T>(read);
  useEffect(() => {
    const l = () => setV(read());
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return v;
}

/** Subscribe to the wallpaper path ("" if none). */
export function useWallpaper(): string {
  return useSetting(getWallpaper);
}

/** Subscribe to the dim percent (0 ... MAX_DIM). */
export function useWallpaperDim(): number {
  return useSetting(getWallpaperDim);
}
