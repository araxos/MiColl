/**
 * Accent colors. Each accent changes the brand-* / accent2-* CSS variables (index.css),
 * so everything recolors when data-accent on <html> changes. Saved in localStorage.
 */

import { useEffect, useState } from "react";
import { queuePrefsSync } from "@/lib/prefs";

export type AccentKey =
  | "original"
  | "purple"
  | "rose"
  | "blue"
  | "green"
  | "yellow"
  | "iridescent"
  | "sakura"
  | "cyberpunk";

export interface AccentDef {
  key: AccentKey;
  label: string;
  /** "basic" = normal colors, "premium" = special themes. */
  tier: "basic" | "premium";
  /** Swatch gradient colors for the picker. */
  from: string;
  to: string;
  /** Full CSS gradient for the swatch (overrides from/to, e.g. iridescent). */
  swatch?: string;
}

export const ACCENTS: AccentDef[] = [
  // default: MiColl's own colors from the app icon (#FF9F45 -> #FF4E7E)
  { key: "original", label: "Original", tier: "basic", from: "#ff9f45", to: "#ff4e7e" },
  { key: "purple", label: "Purple", tier: "basic", from: "#8b5cf6", to: "#c026d3" },
  { key: "rose", label: "Rose", tier: "basic", from: "#f472b6", to: "#d946ef" },
  { key: "blue", label: "Blue", tier: "basic", from: "#0ea5e9", to: "#06b6d4" },
  { key: "green", label: "Green", tier: "basic", from: "#22c55e", to: "#14b8a6" },
  { key: "yellow", label: "Yellow", tier: "basic", from: "#eab308", to: "#fbbf24" },
  {
    key: "iridescent",
    label: "Iridescent",
    tier: "premium",
    from: "#c4b5fd",
    to: "#5eead4",
    swatch: "linear-gradient(135deg,#c4b5fd 0%,#f5c2ff 30%,#a7f3d0 60%,#bae6fd 100%)",
  },
  {
    key: "sakura",
    label: "Sakura",
    tier: "premium",
    from: "#f472b6",
    to: "#ffe1ee",
    swatch: "linear-gradient(135deg,#ffe1ee 0%,#ffc1da 45%,#f472b6 100%)",
  },
  {
    key: "cyberpunk",
    label: "Cyberpunk",
    tier: "premium",
    from: "#fcee0a",
    to: "#00e5ff",
    // hard stops, a soft yellow->cyan blend would turn green in the middle
    swatch:
      "linear-gradient(135deg,#fcee0a 0%,#fcee0a 44%,#0a0a0a 44%,#0a0a0a 56%,#00e5ff 56%,#00b8d4 100%)",
  },
];

/**
 * Default accent, also the fallback when premium isn't unlocked.
 * Its colors are the @theme block in index.css.
 */
export const DEFAULT_ACCENT: AccentKey = "original";

const STORAGE_KEY = "micoll.accent";
/**
 * Copy of the theme license from the DB so we can check it right at boot.
 * The DB is the real source, App checks it again on startup.
 */
const UNLOCK_KEY = "micoll.premiumUnlocked";

/**
 * A premium theme pack (name, license and its accents).
 * id is the product in the license token. The first pack keeps "themes" so old keys still
 * work.
 */
export interface ThemePack {
  id: string;
  name: string;
  accents: AccentKey[];
}

export const THEME_PACKS: ThemePack[] = [
  { id: "themes", name: "Aurora Pack", accents: ["sakura", "cyberpunk", "iridescent"] },
];

/** Which pack an accent belongs to. */
export function packOf(key: AccentKey): ThemePack | undefined {
  return THEME_PACKS.find((p) => p.accents.includes(key));
}

export function isPremium(key: AccentKey): boolean {
  return ACCENTS.find((a) => a.key === key)?.tier === "premium";
}

export function premiumUnlocked(): boolean {
  try {
    return localStorage.getItem(UNLOCK_KEY) === "1";
  } catch {
    return false;
  }
}

/** Save the premium unlock and re-apply the accent (falls back if premium was lost). */
export function setPremiumUnlocked(v: boolean): void {
  try {
    if (v) localStorage.setItem(UNLOCK_KEY, "1");
    else {
      localStorage.removeItem(UNLOCK_KEY);
      localStorage.removeItem(LICENSEE_KEY); // no licence, no name
      localStorage.removeItem(TRIAL_KEY); // …and no end date either
    }
  } catch {
    /* ignore */
  }
  applyAccent(getAccent());
}

/**
 * The name the theme key was issued to, shown in Settings (makes sharing keys awkward).
 * Only a display copy, the license itself is what unlocks.
 */
const LICENSEE_KEY = "micoll.licensee";

export function getLicensee(): string | null {
  try {
    const v = localStorage.getItem(LICENSEE_KEY);
    return v && v.trim() ? v : null;
  } catch {
    return null;
  }
}

export function setLicensee(name: string | null): void {
  try {
    if (name && name.trim()) localStorage.setItem(LICENSEE_KEY, name.trim());
    else localStorage.removeItem(LICENSEE_KEY);
  } catch {
    /* ignore */
  }
  listeners.forEach((l) => l());
}

export function useLicensee(): string | null {
  const [name, setName] = useState<string | null>(getLicensee());
  useEffect(() => {
    const l = () => setName(getLicensee());
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);
  return name;
}

/**
 * For a test key the last day it works (YYYY-MM-DD), null for a bought one.
 * Only a display copy, the key's own date is what counts. Not synced.
 */
const TRIAL_KEY = "micoll.trialUntil";

export function getTrialUntil(): string | null {
  try {
    const v = localStorage.getItem(TRIAL_KEY);
    return v && v.trim() ? v : null;
  } catch {
    return null;
  }
}

export function setTrialUntil(date: string | null): void {
  try {
    if (date && date.trim()) localStorage.setItem(TRIAL_KEY, date.trim());
    else localStorage.removeItem(TRIAL_KEY);
  } catch {
    /* ignore */
  }
  listeners.forEach((l) => l());
}

export function useTrialUntil(): string | null {
  const [until, setUntil] = useState<string | null>(getTrialUntil());
  useEffect(() => {
    const l = () => setUntil(getTrialUntil());
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);
  return until;
}

export function getAccent(): AccentKey {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v && ACCENTS.some((a) => a.key === v)) {
      // saved premium accent without license -> fall back
      if (isPremium(v as AccentKey) && !premiumUnlocked()) return DEFAULT_ACCENT;
      return v as AccentKey;
    }
  } catch {
    /* ignore */
  }
  return DEFAULT_ACCENT;
}

const listeners = new Set<() => void>();

export function applyAccent(key: AccentKey): void {
  // check the license here too, not only in the Settings UI
  if (isPremium(key) && !premiumUnlocked()) key = DEFAULT_ACCENT;
  document.documentElement.dataset.accent = key;
  try {
    localStorage.setItem(STORAGE_KEY, key);
  } catch {
    /* ignore */
  }
  dropForeignWallpaperPreset(key);
  queuePrefsSync();
  listeners.forEach((l) => l());
}

/**
 * Built-in wallpapers belong to their theme, so switching theme removes a preset
 * wallpaper from another theme. The user's own wallpaper always stays.
 * Lazy import to avoid an import cycle with the preset list.
 */
function dropForeignWallpaperPreset(next: AccentKey): void {
  void (async () => {
    try {
      const [{ getWallpaper, setWallpaper, isWallpaperPreset, wallpaperPresetId }, { ALL_WALLPAPER_PRESETS }] =
        await Promise.all([import("@/lib/wallpaper"), import("@/lib/wallpaperPresets")]);
      const current = getWallpaper();
      if (!current || !isWallpaperPreset(current)) return; // unset, or the user's own file
      const preset = ALL_WALLPAPER_PRESETS.find((p) => p.id === wallpaperPresetId(current));
      // unknown id = old preset, remove it too
      if (!preset || preset.accent !== next) setWallpaper("");
    } catch {
      /* wallpaper is only cosmetic, never break the theme switch */
    }
  })();
}

/** Subscribe to the accent. */
export function useAccent(): AccentKey {
  const [accent, setAccent] = useState<AccentKey>(getAccent());
  useEffect(() => {
    const l = () => setAccent(getAccent());
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);
  return accent;
}

/** "On" color for toggles per accent. Premium themes get their own fill. */
export function toggleOnClass(accent: AccentKey): string {
  switch (accent) {
    case "iridescent":
      return "[background-image:linear-gradient(90deg,#c4b5fd,#f5c2ff,#a7f3d0,#bae6fd)]";
    case "sakura":
      return "bg-[#ec4899]";
    case "cyberpunk":
      return "bg-[#fcee0a]";
    default:
      return "bg-brand-600";
  }
}
