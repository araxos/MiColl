/**
 * The video player's settings (like the phone's): speed, how far a double click skips,
 * whether the controls hide while it plays, the volume, and where long videos were left.
 * Kept in localStorage, so the picture-in-picture window shares them.
 */
import { useEffect, useState } from "react";
import { queuePrefsSync } from "@/lib/prefs";

const EVENT = "micoll:video-prefs";

function changed() {
  window.dispatchEvent(new Event(EVENT));
  queuePrefsSync();
}

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, v: string) {
  try {
    localStorage.setItem(key, v);
  } catch {
    /* ignore */
  }
}

/** a value that follows its setting (also when another window changes it) */
function usePref<T>(get: () => T): T {
  const [v, setV] = useState(get);
  useEffect(() => {
    const u = () => setV(get());
    window.addEventListener(EVENT, u);
    window.addEventListener("storage", u);
    return () => {
      window.removeEventListener(EVENT, u);
      window.removeEventListener("storage", u);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return v;
}

// speed, kept for the next video too
const RATE_KEY = "micoll.videoRate";
export const VIDEO_RATES = [0.25, 0.5, 1, 1.25, 1.5, 2];
export function getVideoRate(): number {
  const n = Number(read(RATE_KEY));
  return VIDEO_RATES.includes(n) ? n : 1;
}
export function setVideoRate(rate: number) {
  write(RATE_KEY, String(rate));
  changed();
}
export const useVideoRate = () => usePref(getVideoRate);

// a double click on the right half skips forward, on the left back, by this many seconds
const SKIP_KEY = "micoll.videoSkip";
export const SKIP_STEPS = [3, 5, 10, 15, 30];
export function getVideoSkip(): number {
  const n = Number(read(SKIP_KEY));
  return SKIP_STEPS.includes(n) ? n : 10;
}
export function setVideoSkip(secs: number) {
  write(SKIP_KEY, String(secs));
  changed();
}
export const useVideoSkip = () => usePref(getVideoSkip);

// the controls go a few seconds after the mouse stops while it plays (on by default)
const AUTO_HIDE_KEY = "micoll.videoAutoHide";
export function getVideoAutoHide(): boolean {
  return read(AUTO_HIDE_KEY) !== "0";
}
export function setVideoAutoHide(on: boolean) {
  write(AUTO_HIDE_KEY, on ? "1" : "0");
  changed();
}
export const useVideoAutoHide = () => usePref(getVideoAutoHide);

// volume (videos used to start at 0.3, that stays the default)
const VOLUME_KEY = "micoll.videoVolume";
export function getVideoVolume(): number {
  const raw = read(VOLUME_KEY);
  const n = raw == null ? NaN : Number(raw);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0.3;
}
export function setVideoVolume(v: number) {
  write(VOLUME_KEY, String(Math.round(v * 100) / 100));
}

// loop (the viewer's old switch, same key)
const LOOP_KEY = "micoll.loop";
export function getVideoLoop(): boolean {
  return read(LOOP_KEY) !== "0";
}
export function setVideoLoop(on: boolean) {
  write(LOOP_KEY, on ? "1" : "0");
  changed();
}
export const useVideoLoop = () => usePref(getVideoLoop);

// full view: the viewer's strip goes for videos, the video reaches the bottom (off by default)
const FULL_KEY = "micoll.videoFull";
export function getVideoFull(): boolean {
  return read(FULL_KEY) === "1";
}
export function setVideoFull(on: boolean) {
  write(FULL_KEY, on ? "1" : "0");
  changed();
}
export const useVideoFull = () => usePref(getVideoFull);

// videos of a minute or longer: where each one was left (seconds, by its path), it goes on
// from there next time. the newest few hundred are kept
const RESUME_KEY = "micoll.videoResume";
const RESUME_KEEP = 200;
/** shorter videos simply start over */
export const RESUME_MIN_SECS = 60;

function resumeMap(): Record<string, [number, number]> {
  try {
    const m = JSON.parse(read(RESUME_KEY) ?? "{}");
    return m && typeof m === "object" ? m : {};
  } catch {
    return {};
  }
}

export function getVideoResume(path: string): number | null {
  const v = resumeMap()[path];
  return Array.isArray(v) && Number.isFinite(v[0]) ? v[0] : null;
}

/** null = watched to the end (or just started): next time it starts at the beginning */
export function setVideoResume(path: string, secs: number | null) {
  const m = resumeMap();
  if (secs === null) {
    if (!(path in m)) return;
    delete m[path];
  } else {
    m[path] = [Math.round(secs * 10) / 10, Date.now()];
    const keys = Object.keys(m);
    if (keys.length > RESUME_KEEP) {
      keys
        .sort((a, b) => m[a][1] - m[b][1])
        .slice(0, keys.length - RESUME_KEEP)
        .forEach((k) => delete m[k]);
    }
  }
  write(RESUME_KEY, JSON.stringify(m));
}
