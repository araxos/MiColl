/**
 * In-app updates: check for a new version, download it and install it.
 *
 * Releases are on GitHub (araxos/MiColl) as an installer plus a
 * latest.json with the version and signature. Endpoint and public key are in
 * tauri.conf.json. The plugin only accepts files signed with our private key.
 *
 * Checks shortly after start and then every 6 hours (because of close-to-tray,
 * some people never restart the app). Can be turned off in Settings -> Version.
 * A found update never pops up on its own: it lights the update button in the top
 * bar, and the popup opens when that (or "Update now" in Settings) is clicked.
 */

import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import type { Update } from "@tauri-apps/plugin-updater";
import { queuePrefsSync } from "@/lib/prefs";
import { isTauri } from "@/lib/tauri";

export type UpdateState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "current" }
  | { kind: "available"; version: string; notes?: string; date?: string }
  | { kind: "downloading"; version: string; done: number; total: number | null }
  | { kind: "installing"; version: string }
  | { kind: "error"; detail: string; during: "check" | "install" }
  /** browser version, nothing to update */
  | { kind: "unsupported" };

interface Store {
  state: UpdateState;
  /** is the popup open? "Later" closes it but the update is still available */
  prompt: boolean;
}

let store: Store = { state: { kind: "idle" }, prompt: false };
let pending: Update | null = null;
const subs = new Set<() => void>();

function set(next: Partial<Store>): void {
  store = { ...store, ...next };
  subs.forEach((l) => l());
}

export function useUpdater(): Store {
  const [s, setS] = useState(store);
  useEffect(() => {
    const l = () => setS(store);
    subs.add(l);
    l();
    return () => {
      subs.delete(l);
    };
  }, []);
  return s;
}

const busy = () => store.state.kind === "downloading" || store.state.kind === "installing";

/**
 * Check if there's a newer version.
 * manual = user clicked the button, so show errors too.
 * Auto checks just stay quiet when they fail (offline etc).
 */
export async function checkForUpdates({ manual }: { manual: boolean }): Promise<void> {
  if (!isTauri()) {
    set({ state: { kind: "unsupported" } });
    return;
  }
  if (busy() || store.state.kind === "checking") return;
  const before = store.state;
  set({ state: { kind: "checking" } });
  try {
    const { check } = await import("@tauri-apps/plugin-updater");
    const found = await check();
    // free the old update object
    if (pending && pending !== found) void pending.close().catch(() => {});
    pending = found;
    if (!found) {
      set({ state: { kind: "current" } });
      return;
    }
    // the popup stays as it is: it only opens from a click
    set({
      state: {
        kind: "available",
        version: found.version,
        notes: found.body?.trim() || undefined,
        date: found.date,
      },
    });
  } catch (e) {
    if (manual) set({ state: { kind: "error", detail: `${e}`, during: "check" } });
    else {
      console.warn("micoll: update check failed", e);
      set({ state: before });
    }
  }
}

/**
 * The version an update is installing, kept in the database (saved with the checkpoint
 * before the app closes). After the restart takeFinishedUpdate compares it with the
 * running version.
 */
const INSTALLING_KEY = "update_installing";

/**
 * Once per start: the version that was just installed by an in-app update, or null.
 * Clears the mark either way (a failed update just doesn't say anything).
 */
export async function takeFinishedUpdate(): Promise<string | null> {
  if (!isTauri()) return null;
  const want = await invoke<string | null>("get_setting", { key: INSTALLING_KEY }).catch(() => null);
  if (!want) return null;
  await invoke("set_setting", { key: INSTALLING_KEY, value: "" }).catch(() => {});
  const now = await getVersion().catch(() => null);
  return now === want ? want : null;
}

/** Download + install the update, then restart. */
export async function installUpdate(): Promise<void> {
  const u = pending;
  if (!u || busy()) return;
  const version = u.version;
  let total: number | null = null;
  let done = 0;
  set({ state: { kind: "downloading", version, done, total }, prompt: true });
  try {
    // after the restart this says "updated to …" (see takeFinishedUpdate)
    await invoke("set_setting", { key: INSTALLING_KEY, value: version }).catch(() => {});
    // a portable copy must not run the installer (that would install a second, normal
    // MiColl and start it with the AppData library). It swaps its own exe instead.
    if (await invoke<boolean>("is_portable").catch(() => false)) {
      await invoke("prepare_for_update").catch(() => {});
      await invoke("portable_update", { version });
      return;
    }
    await u.download((ev) => {
      if (ev.event === "Started") total = ev.data.contentLength ?? null;
      else if (ev.event === "Progress") done += ev.data.chunkLength;
      set({ state: { kind: "downloading", version, done, total } });
    });
    set({ state: { kind: "installing", version } });
    // the installer closes the app on Windows, so save the database first (same as tray
    // Quit)
    await invoke("prepare_for_update").catch(() => {});
    await u.install();
    // only runs if the installer didn't restart the app itself
    const { relaunch } = await import("@tauri-apps/plugin-process");
    await relaunch();
  } catch (e) {
    await invoke("set_setting", { key: INSTALLING_KEY, value: "" }).catch(() => {});
    set({ state: { kind: "error", detail: `${e}`, during: "install" }, prompt: true });
  }
}

/** Open the popup for the update we already found. */
export function showUpdatePrompt(): void {
  if (pending) set({ prompt: true });
}

/** "Later" button: close the popup, the top bar button stays. */
export function dismissUpdatePrompt(): void {
  if (busy()) return;
  set({
    prompt: false,
    // after a failed install go back to "update available"
    state:
      store.state.kind === "error" && store.state.during === "install" && pending
        ? { kind: "available", version: pending.version, notes: pending.body?.trim() || undefined }
        : store.state,
  });
}

/* ---- the automatic check ------------------------------------------------ */

const AUTO_KEY = "micoll.autoUpdateCheck";
const autoSubs = new Set<() => void>();

export function getAutoUpdateCheck(): boolean {
  try {
    // on by default
    return localStorage.getItem(AUTO_KEY) !== "false";
  } catch {
    return true;
  }
}

export function setAutoUpdateCheck(on: boolean): void {
  try {
    localStorage.setItem(AUTO_KEY, on ? "true" : "false");
  } catch {
    /* ignore */
  }
  queuePrefsSync();
  autoSubs.forEach((l) => l());
}

export function useAutoUpdateCheck(): boolean {
  const [on, setOn] = useState(getAutoUpdateCheck);
  useEffect(() => {
    const l = () => setOn(getAutoUpdateCheck());
    autoSubs.add(l);
    return () => {
      autoSubs.delete(l);
    };
  }, []);
  return on;
}

/** first check after start (wait a bit so the library loads first) */
const FIRST_CHECK_MS = 20_000;
const EVERY_MS = 6 * 60 * 60 * 1000;

/** Starts the automatic checks. Returns a function to stop them. */
export function startAutoUpdateChecks(): () => void {
  if (!isTauri()) return () => {};
  const tick = () => {
    if (getAutoUpdateCheck()) void checkForUpdates({ manual: false });
  };
  const first = window.setTimeout(tick, FIRST_CHECK_MS);
  const every = window.setInterval(tick, EVERY_MS);
  return () => {
    window.clearTimeout(first);
    window.clearInterval(every);
  };
}
