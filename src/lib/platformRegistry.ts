/**
 * The platforms the app offers in menus (+ Platform, import review, Create Card):
 * built-ins + user added + the ones creators use, minus the ones the user removed.
 * Removing only hides it from the menus, creators that use it keep it.
 * Saved in localStorage.
 */

import { useEffect, useMemo, useState } from "react";
import { PLATFORMS } from "@/lib/platforms";
import { queuePrefsSync } from "@/lib/prefs";

const CUSTOM_KEY = "micoll.platforms.custom"; // user-added, JSON string[]
const HIDDEN_KEY = "micoll.platforms.hidden"; // removed from the list, JSON string[]
/**
 * Set after the first-run "which platforms do you use" question.
 * Without it the built-ins still get added (for older libraries).
 */
const INIT_KEY = "micoll.platforms.init";

const norm = (s: string) => s.trim().toLowerCase();

function read(key: string): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? "[]");
    return Array.isArray(v) ? v.filter((x) => typeof x === "string" && x.trim()) : [];
  } catch {
    return [];
  }
}

const listeners = new Set<() => void>();
function write(key: string, v: string[]): void {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* ignore storage failures */
  }
  queuePrefsSync();
  listeners.forEach((l) => l());
}

export const getCustomPlatforms = (): string[] => read(CUSTOM_KEY);
export const getHiddenPlatforms = (): string[] => read(HIDDEN_KEY);

/** Did the user answer the platform question? */
export function platformsInitialized(): boolean {
  try {
    return localStorage.getItem(INIT_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * Save that the question was answered. After that the list is only what the user
 * picked + what creators use.
 */
export function setPlatformsInitialized(): void {
  try {
    localStorage.setItem(INIT_KEY, "1");
  } catch {
    /* ignore storage failures */
  }
  queuePrefsSync();
  listeners.forEach((l) => l());
}

/**
 * Add a platform to the list (and un-hide it).
 * Built-ins get saved too, otherwise picking Patreon on first run would save nothing.
 */
export function addPlatform(name: string): void {
  const nm = name.trim();
  if (!nm || norm(nm) === "unsorted" || norm(nm) === "misc") return;
  const hidden = getHiddenPlatforms().filter((h) => norm(h) !== norm(nm));
  write(HIDDEN_KEY, hidden);
  const custom = getCustomPlatforms();
  if (!custom.some((c) => norm(c) === norm(nm))) {
    write(CUSTOM_KEY, [...custom, nm]);
  } else {
    listeners.forEach((l) => l()); // un-hide-only still needs a re-render
  }
}

/** Remove a platform from the list. Creators keep it, it's saved as hidden. */
export function removePlatform(name: string): void {
  const nm = name.trim();
  if (!nm) return;
  write(CUSTOM_KEY, getCustomPlatforms().filter((c) => norm(c) !== norm(nm)));
  const hidden = getHiddenPlatforms();
  if (!hidden.some((h) => norm(h) === norm(nm))) write(HIDDEN_KEY, [...hidden, nm]);
}

/**
 * Merge built-ins + custom + used by creators, no duplicates, without hidden ones.
 * seedBuiltins is off for new libraries (they start empty).
 */
export function mergePlatforms(
  artists: { platforms: { name: string }[] }[],
  custom: string[],
  hidden: string[],
  seedBuiltins = true,
): string[] {
  const hide = new Set(hidden.map(norm));
  const seen = new Set<string>();
  const out: string[] = [];
  const consider = (name: string) => {
    const key = norm(name);
    if (!key || key === "unsorted" || key === "misc") return;
    if (hide.has(key) || seen.has(key)) return;
    seen.add(key);
    out.push(name.trim());
  };
  if (seedBuiltins) for (const p of PLATFORMS) consider(p);
  for (const c of custom) consider(c);
  for (const a of artists) for (const p of a.platforms) consider(p.name);
  return out;
}

/** Custom/hidden lists, updates on change. */
export function usePlatformPrefs(): { custom: string[]; hidden: string[] } {
  const [, bump] = useState(0);
  useEffect(() => {
    const l = () => bump((n) => n + 1);
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);
  return { custom: getCustomPlatforms(), hidden: getHiddenPlatforms() };
}

/** The platform list for these creators, updates on change. */
export function usePlatformOptions(artists: { platforms: { name: string }[] }[]): string[] {
  const { custom, hidden } = usePlatformPrefs();
  // also in the deps, answering the question may not change custom
  const seeded = !platformsInitialized();
  return useMemo(
    () => mergePlatforms(artists, custom, hidden, seeded),
    [artists, custom.join(""), hidden.join(""), seeded],
  );
}
