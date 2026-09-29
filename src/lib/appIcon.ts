/**
 * Window/taskbar icon and which artwork the dashboard logo uses.
 * The user picks it in Settings -> Appearance -> App icon. "auto" follows the theme.
 * This only changes the icon of the running window, not the .exe or the shortcut.
 */

import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Image } from "@tauri-apps/api/image";
import { isTauri } from "@/lib/tauri";
import { getAccent, premiumUnlocked, type AccentKey } from "@/lib/theme";

import blueUrl from "@/assets/icons/micoll-icon-blue.svg";
import cyberpunkUrl from "@/assets/icons/micoll-icon-cyberpunk.svg";
import greenUrl from "@/assets/icons/micoll-icon-green.svg";
import iridescentUrl from "@/assets/icons/micoll-icon-iridescent.svg";
import purpleUrl from "@/assets/icons/micoll-icon-purple.svg";
import roseUrl from "@/assets/icons/micoll-icon-rose.svg";
import sakuraUrl from "@/assets/icons/micoll-icon-sakura.svg";
import yellowUrl from "@/assets/icons/micoll-icon-yellow.svg";
// the original pink/orange logo
import originalUrl from "@/assets/icons/micoll-icon-original.svg";
import { queuePrefsSync } from "@/lib/prefs";

export type AppIconKey =
  | "purple"
  | "rose"
  | "blue"
  | "green"
  | "yellow"
  | "original"
  | "sakura"
  | "cyberpunk"
  | "iridescent";

export interface AppIconDef {
  key: AppIconKey;
  label: string;
  url: string;
  /** Premium icons, only available with the premium themes. */
  premium?: boolean;
  /** Animated SVG. The OS icon just uses the first frame. */
  animated?: boolean;
}

export const APP_ICONS: AppIconDef[] = [
  // original first, same order as the accent colors
  { key: "original", label: "Original", url: originalUrl },
  { key: "purple", label: "Purple", url: purpleUrl },
  { key: "rose", label: "Rose", url: roseUrl },
  { key: "blue", label: "Blue", url: blueUrl },
  { key: "green", label: "Green", url: greenUrl },
  { key: "yellow", label: "Yellow", url: yellowUrl },
  { key: "sakura", label: "Sakura", url: sakuraUrl, premium: true, animated: true },
  { key: "cyberpunk", label: "Cyberpunk", url: cyberpunkUrl, premium: true },
  { key: "iridescent", label: "Iridescent", url: iridescentUrl, premium: true },
];

/**
 * Icons that also replace the dashboard logo.
 * Sakura and cyberpunk draw their own logo in Layout.
 */
export const DASHBOARD_ICONS: Partial<Record<AccentKey, string>> = {
  original: originalUrl,
  iridescent: iridescentUrl,
  purple: purpleUrl,
  rose: roseUrl,
  blue: blueUrl,
  green: greenUrl,
  yellow: yellowUrl,
};

const STORAGE_KEY = "micoll.appIcon";
const AUTO = "auto";
/** The default MiColl icon. */
const DEFAULT_ICON: AppIconKey = "original";

const def = (key: AppIconKey) => APP_ICONS.find((i) => i.key === key)!;

/** Premium icon while premium is locked. */
const barred = (icon: AppIconDef) => !!icon.premium && !premiumUnlocked();

/** Icon for each accent when the setting is "auto". */
function iconForAccent(accent: AccentKey): AppIconKey {
  return APP_ICONS.some((i) => i.key === accent) ? (accent as AppIconKey) : DEFAULT_ICON;
}

/**
 * The saved choice: an icon name or "auto".
 * Nothing saved = the original icon.
 */
export function getAppIconChoice(): AppIconKey | "auto" {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === AUTO) return AUTO;
    return APP_ICONS.some((i) => i.key === v) ? (v as AppIconKey) : DEFAULT_ICON;
  } catch {
    return DEFAULT_ICON;
  }
}

/** What "Match theme" gives right now. */
export function autoAppIcon(): AppIconDef {
  const icon = def(iconForAccent(getAccent()));
  return barred(icon) ? def(DEFAULT_ICON) : icon;
}

/**
 * The icon to actually use. A premium icon falls back to the default
 * if premium gets locked (the choice is kept).
 */
export function resolveAppIcon(): AppIconDef {
  const choice = getAppIconChoice();
  if (choice === AUTO) return autoAppIcon();
  const icon = def(choice);
  return barred(icon) ? def(DEFAULT_ICON) : icon;
}

const listeners = new Set<() => void>();

export function setAppIconChoice(choice: AppIconKey | "auto"): void {
  if (choice !== AUTO && barred(def(choice))) return; // locked artwork, ignore
  try {
    localStorage.setItem(STORAGE_KEY, choice);
  } catch {
    /* ignore */
  }
  queuePrefsSync();
  listeners.forEach((l) => l());
  void applyAppIcon();
}

export function useAppIconChoice(): AppIconKey | "auto" {
  const [choice, setChoice] = useState(getAppIconChoice);
  useEffect(() => {
    const l = () => setChoice(getAppIconChoice());
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);
  return choice;
}

/** Draw the SVG into a 256px canvas and give the pixels to the window as its icon. */
const SIZE = 256;
let lastApplied = "";

export async function applyAppIcon(force = false): Promise<void> {
  if (!isTauri()) return;
  const icon = resolveAppIcon();
  if (!force && icon.url === lastApplied) return;
  try {
    const rgba = await rasterize(icon.url);
    const image = await Image.new(rgba, SIZE, SIZE);
    await getCurrentWindow().setIcon(image);
    lastApplied = icon.url;
  } catch (e) {
    // not a big deal if the icon can't be changed
    console.warn("app icon", e);
  }
}

function rasterize(url: string): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const img = new window.Image();
    img.onload = () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = SIZE;
        canvas.height = SIZE;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        if (!ctx) throw new Error("no 2d context");
        ctx.clearRect(0, 0, SIZE, SIZE);
        ctx.drawImage(img, 0, 0, SIZE, SIZE);
        resolve(new Uint8Array(ctx.getImageData(0, 0, SIZE, SIZE).data.buffer));
      } catch (e) {
        reject(e);
      }
    };
    img.onerror = () => reject(new Error(`icon failed to load: ${url}`));
    img.src = url;
  });
}
