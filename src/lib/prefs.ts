/**
 * Syncs UI settings from localStorage into the database.
 * localStorage belongs to the webview origin (dev and build are different), so a
 * portable copy or a restored backup would lose all settings. The keys below get
 * saved as one JSON in settings.ui_prefs and loaded back on start.
 * Only listed keys are synced, add new ones here on purpose.
 */

import { dataLocations, getSetting, setSetting } from "@/api/library";
import { isTauri } from "@/lib/tauri";

/** Keys that are synced with the library. */
const SYNCED = [
  // ── about the collection itself ──
  "micoll.pins",
  "micoll.customOrder",
  "micoll.platforms.custom",
  "micoll.platforms.hidden",
  "micoll.platforms.init",

  // ── look & feel ──
  "micoll.accent",
  "micoll.language",
  "micoll.appIcon",
  "micoll.verifiedMark",
  "micoll.tileShape.year",
  "micoll.tileShape.month",
  "micoll.cardSize",
  "micoll.rewardSize",
  "micoll.monthSize",
  "micoll.sortField",
  "micoll.sortDir",
  "micoll.wallpaper",
  "micoll.wallpaperDim",
  "micoll.hideNames",
  "micoll.cardNameSize",
  "micoll.cardPlus",
  "micoll.cardMeta",
  "micoll.stripCreator",
  "micoll.showHidden",
  "micoll.wishlistButton",
  "micoll.historyButton",
  "micoll.cinemaButton",
  "micoll.graveyardButton",
  "micoll.topbarHintSeen",
  "micoll.classIconOpacity",
  "micoll.playGifs",
  "micoll.comfy",
  "micoll.viewerAnim",
  "micoll.viewerStart",
  "micoll.viewerGridSize",
  "micoll.animatedBg",
  "micoll.classicLuxe",
  "micoll.cardFx",
  "micoll.idlePause",
  "micoll.holoFreq",
  "micoll.glassButtons",
  "micoll.sakuraFrame",
  "micoll.cyberFrame",
  "micoll.iriFrame",
  "micoll.templateFont",
  "micoll.minimal",
  "micoll.settingsConcise",
  "micoll.modeHotkey",
  "micoll.homeDblToggle",
  "micoll.autoUpdateCheck",
  "micoll.windowButtons",
  "micoll.closeAction",
  "micoll.optimizeLargeImages",
  "micoll.slideshowSpeed",
  "micoll.loop",
  "micoll.removeMode",
  "micoll.expandMode",
  "micoll.expandSize",
  "micoll.brushSize",
  "micoll.classFilter",
  "micoll.typeFilter",
] as const;

/** Key prefixes (one key per creator/page). */
const SYNCED_PREFIXES = ["micoll.tileShape.for."] as const;

/* Not synced on purpose:
     · sfwMode - per device on purpose
     · premiumUnlocked, licensee, trialUntil - come from the licence in the DB anyway
     · needsReviewDismissed, quickImportWarned, iridSnapshot - one-time stuff
   micoll.tileShape (old key, migrated once) and micoll.viewerGrid (removed) aren't
   settings. */

const SETTING_KEY = "ui_prefs";
/**
 * Saved in the library once a portable copy dropped the inherited prefs (so it only happens
 * once).
 */
const RESET_KEY = "ui_prefs_reset";
const DEBOUNCE_MS = 800;

const isSynced = (key: string): boolean =>
  (SYNCED as readonly string[]).includes(key) ||
  SYNCED_PREFIXES.some((p) => key.startsWith(p));

/** All synced keys from localStorage as an object. */
function collect(): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || !isSynced(key)) continue;
      const v = localStorage.getItem(key);
      if (v != null) out[key] = v;
    }
  } catch {
    /* no storage, nothing to sync */
  }
  return out;
}

/** Remove all library keys from localStorage and return how many there were. */
function clearSynced(): number {
  try {
    const doomed: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && isSynced(key)) doomed.push(key);
    }
    for (const key of doomed) localStorage.removeItem(key);
    return doomed.length;
  } catch {
    return 0; // storage unavailable — nothing to clear
  }
}

/**
 * A portable copy shares localStorage with the installed one (WebView2 uses the
 * app id, not the exe location), so it would start with the other copy's settings.
 * The first time a portable copy opens a library without saved prefs, we remove
 * the inherited ones and reload (some modules already read them at import time).
 * The marker in the library makes sure this happens only once.
 */
async function dropInheritedPrefs(): Promise<void> {
  try {
    if (!(await dataLocations()).portable) return;
    if (await getSetting(RESET_KEY)) return;
    const dropped = clearSynced();
    await setSetting(RESET_KEY, "1");
    // only reload if something was actually removed
    if (dropped === 0) return;
  } catch {
    return; // older backend, or the marker won't write — then change nothing
  }
  window.location.reload();
}

/**
 * Don't write anything before the saved prefs were loaded, otherwise an empty
 * localStorage would overwrite the library's settings.
 */
let ready = false;
let timer: ReturnType<typeof setTimeout> | undefined;

async function write(): Promise<void> {
  try {
    await setSetting(SETTING_KEY, JSON.stringify(collect()));
  } catch {
    // saving failed, not a big deal, the next change tries again
  }
}

/** Queue a save (debounced, sliders fire this a lot). */
export function queuePrefsSync(): void {
  if (!ready || !isTauri()) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = undefined;
    void write();
  }, DEBOUNCE_MS);
}

/** Save right away (used when the window closes). */
export function flushPrefsSync(): void {
  if (!ready || !isTauri() || !timer) return;
  clearTimeout(timer);
  timer = undefined;
  void write();
}

/**
 * Load the saved prefs into localStorage. Call once at boot before the first paint
 * (the accent is read from localStorage).
 * Saved keys win over local ones. Keys that aren't saved are left alone.
 */
export async function loadPrefs(): Promise<void> {
  if (!isTauri()) return;
  try {
    const raw = await getSetting(SETTING_KEY);
    if (raw && raw.trim()) {
      const blob = JSON.parse(raw) as Record<string, unknown>;
      for (const [key, value] of Object.entries(blob)) {
        if (!isSynced(key) || typeof value !== "string") continue;
        try {
          localStorage.setItem(key, value);
        } catch {
          /* ignore one key that can't be written */
        }
      }
    } else {
      // library has no prefs yet, a portable copy drops the inherited ones (see
      // dropInheritedPrefs)
      await dropInheritedPrefs();
    }
  } catch {
    // missing or broken JSON: keep what we have, the next change writes a new one
  } finally {
    ready = true;
    // first run on an existing library: save what we have right away
    queuePrefsSync();
  }
}

if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", flushPrefsSync);
}
