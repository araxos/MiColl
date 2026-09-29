import { useEffect, useState } from "react";
import { isSafeMode } from "@/lib/safeMode";
import { queuePrefsSync } from "@/lib/prefs";

/**
 * SFW / NSFW mode (per device). In SFW mode artists tagged "nsfw" are hidden
 * (not deleted). Can be switched with a hotkey or a double click on Home.
 */
export const CONTENT_MODE_EVENT = "micoll:contentmode";

const SFW_KEY = "micoll.sfwMode";
const HOTKEY_KEY = "micoll.modeHotkey";
const HOMEDBL_KEY = "micoll.homeDblToggle";

function readBool(key: string): boolean {
  try {
    return localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}
function writeBool(key: string, v: boolean) {
  try {
    localStorage.setItem(key, v ? "1" : "0");
  } catch {
    /* ignore */
  }
  window.dispatchEvent(new CustomEvent(CONTENT_MODE_EVENT));
}

/** Safe mode (decoy password) always forces SFW, the saved setting stays. */
export const getSfwMode = () => isSafeMode() || readBool(SFW_KEY);
export const setSfwMode = (v: boolean) => {
  if (isSafeMode()) return;
  writeBool(SFW_KEY, v);
};
export const toggleSfwMode = () => setSfwMode(!getSfwMode());

export const getHomeDblToggle = () => readBool(HOMEDBL_KEY);
// not just writeBool, because this one is synced with the library (see prefs.ts)
export const setHomeDblToggle = (v: boolean) => {
  writeBool(HOMEDBL_KEY, v);
  queuePrefsSync();
};

export function getModeHotkey(): string {
  try {
    return localStorage.getItem(HOTKEY_KEY) ?? "";
  } catch {
    return "";
  }
}
export function setModeHotkey(combo: string) {
  try {
    localStorage.setItem(HOTKEY_KEY, combo);
  } catch {
    /* ignore */
  }
  queuePrefsSync();
  window.dispatchEvent(new CustomEvent(CONTENT_MODE_EVENT));
}

/** True if the artist has the "nsfw" tag. */
export function tagsAreNsfw(tags?: string[]): boolean {
  return (tags ?? []).some((t) => t.trim().toLowerCase() === "nsfw");
}

/** Build a "ctrl+shift+h" style combo from a key event. */
export function eventToCombo(e: KeyboardEvent): string {
  const mods: string[] = [];
  if (e.ctrlKey) mods.push("ctrl");
  if (e.altKey) mods.push("alt");
  if (e.shiftKey) mods.push("shift");
  if (e.metaKey) mods.push("meta");
  const key = e.key.toLowerCase();
  if (["control", "alt", "shift", "meta"].includes(key)) return ""; // modifier-only
  return [...mods, key === " " ? "space" : key].join("+");
}

/** Nice label for a combo, like "Ctrl + Shift + H". */
export function comboLabel(combo: string): string {
  if (!combo) return "None";
  return combo
    .split("+")
    .map((p) =>
      p === "ctrl" ? "Ctrl"
      : p === "alt" ? "Alt"
      : p === "shift" ? "Shift"
      : p === "meta" ? "Win"
      : p === "space" ? "Space"
      : p.length === 1 ? p.toUpperCase()
      : p[0].toUpperCase() + p.slice(1),
    )
    .join(" + ");
}

/** Subscribe to the SFW mode. */
export function useSfwMode(): boolean {
  const [sfw, setSfw] = useState(getSfwMode);
  useEffect(() => {
    const update = () => setSfw(getSfwMode());
    window.addEventListener(CONTENT_MODE_EVENT, update);
    window.addEventListener("storage", update);
    return () => {
      window.removeEventListener(CONTENT_MODE_EVENT, update);
      window.removeEventListener("storage", update);
    };
  }, []);
  return sfw;
}
