/**
 * Main "Animations" switch. When on, all the decorative effects run (card holo,
 * sparkles, glitch, particles...). Spinners and normal UI transitions always work.
 * The animated background has its own switch (animatedBg.ts).
 *
 * It works in two ways: a data-animations attribute on <html> for the CSS, and
 * useCardFx() so React can unmount canvas/WebGL effects completely.
 * The idle pause (lib/perf) uses this same switch.
 */

import { useEffect, useState } from "react";
import { queuePrefsSync } from "@/lib/prefs";
import { isTauri } from "@/lib/tauri";
import { getIdlePause, onIdlePause } from "@/lib/perf";
import { pauseWanted } from "@/lib/idlePause";

const STORAGE_KEY = "micoll.cardFx";

// declared at the top because applyAttr() uses it during module init
const listeners = new Set<() => void>();

/** The saved setting from Settings. */
export function getCardFx(): boolean {
  try {
    // on by default
    return localStorage.getItem(STORAGE_KEY) !== "false";
  } catch {
    return true;
  }
}

/**
 * Are animations on right now? (user switch AND idle pause)
 * The idle pause never changes the saved setting.
 */
function cardFxNow(): boolean {
  return getCardFx() && !idleSuppressed();
}

/** last value we told the subscribers, so we only re-render on a change */
let lastEffective: boolean | null = null;

/**
 * Sends the current animation state to CSS and to React.
 * CSS alone can't stop SMIL or canvas effects, so React has to be told too.
 */
function applyAttr(): void {
  const on = cardFxNow();
  try {
    document.documentElement.dataset.animations = on ? "on" : "off";
  } catch {
    /* ignore (non-DOM env) */
  }
  if (on === lastEffective) return;
  lastEffective = on;
  listeners.forEach((l) => l());
}

/* ---- Focus idling ------------------------------------------------------ */
// Pause the decorative animations while nobody is looking at the window.
// CSS reads <html data-fx-idle>, the canvas/WebGL loops subscribe with onFxIdle
// (rAF keeps running when the window is only unfocused).

// true when the animations should pause (nobody looking + the setting says so)
let idleNow = false;
const idleSubs = new Set<(idle: boolean) => void>();

// raw state: the window is not in front
let unfocusedNow = false;

// two sources, see the Tauri part below for why
let domIdle = false;
let winIdle = false;
// true once the window API answered. After that we trust it for focus,
// because WebView2 sometimes says hasFocus() = false even when the window is in front.
let winKnown = false;
// minimized is tracked separately from "not in front"
let winMinimized = false;

/** Does the idle-pause setting want animations off right now? (rule is in lib/idlePause) */
function idleSuppressed(): boolean {
  return pauseWanted(getIdlePause(), unfocusedNow, winMinimized);
}

let applied = false;

function recomputeIdle(): void {
  // if the document says hidden we believe it, but not its focus once the window answered
  unfocusedNow = winKnown ? winIdle || document.hidden : domIdle || winIdle;
  const idle = idleSuppressed();
  const changed = !applied || idle !== idleNow;
  idleNow = idle;
  // always recompute, winMinimized can change while already idle
  applyAttr();
  if (!changed) return;
  applied = true;
  try {
    document.documentElement.dataset.fxIdle = idle ? "1" : "0";
  } catch {
    /* ignore (non-DOM env) */
  }
  idleSubs.forEach((fn) => fn(idle));
}

/** True while animations are paused because nobody is looking. */
export function isFxIdle(): boolean {
  return idleNow;
}

/** Subscribe to the idle signal. Calls fn right away with the current state. */
export function onFxIdle(fn: (idle: boolean) => void): () => void {
  idleSubs.add(fn);
  fn(idleNow);
  return () => {
    idleSubs.delete(fn);
  };
}

// changing the setting applies right away
onIdlePause(recomputeIdle);

if (typeof window !== "undefined") {
  const update = () => {
    domIdle = document.hidden || !document.hasFocus();
    recomputeIdle();
  };
  window.addEventListener("blur", update);
  window.addEventListener("focus", update);
  document.addEventListener("visibilitychange", update);
  update();
}

// The DOM focus/visibility isn't reliable in WebView2 (a minimized window can still
// look visible and focused), so ask the Tauri window directly.
if (typeof window !== "undefined" && isTauri()) {
  void (async () => {
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const win = getCurrentWindow();
      let pending = 0;
      const sync = () => {
        // debounce, resize fires every frame while dragging
        window.clearTimeout(pending);
        pending = window.setTimeout(() => {
          void Promise.all([win.isFocused(), win.isMinimized()])
            .then(([focused, minimized]) => {
              winIdle = !focused || minimized;
              winMinimized = minimized;
              winKnown = true;
              recomputeIdle();
            })
            .catch(() => {
              /* window is gone, keep the last state */
            });
        }, 120);
      };
      // minimize/restore come in as resize events
      await win.onFocusChanged(sync);
      await win.onResized(sync);
      sync();
    } catch {
      /* no window API, just use the DOM signals */
    }
  })();
}

export function setCardFx(on: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, on ? "true" : "false");
  } catch {
    /* ignore */
  }
  queuePrefsSync();
  // applyAttr notifies the subscribers only if the effective state changed
  applyAttr();
}

/** React hook for the idle signal (for things CSS can't pause, like GIFs or canvas). */
export function useFxIdle(): boolean {
  const [idle, setIdle] = useState(isFxIdle);
  useEffect(() => onFxIdle(setIdle), []);
  return idle;
}

/**
 * Only the user's saved switch, without the idle pause.
 * Used for hover effects: if the mouse is on a card, someone is looking at it,
 * even if the window isn't focused.
 */
export function useCardFxPref(): boolean {
  const [on, setOn] = useState(getCardFx);
  useEffect(() => {
    const l = () => setOn(getCardFx());
    listeners.add(l);
    l();
    return () => {
      listeners.delete(l);
    };
  }, []);
  return on;
}

/** Are animations on right now? (user switch + idle pause) */
export function useCardFx(): boolean {
  const [on, setOn] = useState(cardFxNow);
  useEffect(() => {
    const l = () => setOn(cardFxNow());
    listeners.add(l);
    // the window may have gone idle since the render
    l();
    return () => {
      listeners.delete(l);
    };
  }, []);
  return on;
}
