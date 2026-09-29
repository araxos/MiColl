/**
 * Graveyard: creators you're done with but want to keep.
 * Being in it is saved in the DB (artists.graveyard). Viewing it is a mode that only
 * lives in memory, so a fresh app start always shows the normal dashboard.
 * The top bar button can be hidden with right-click (back via the settings gear menu).
 */

import { useEffect, useState } from "react";
import { queuePrefsSync } from "@/lib/prefs";

/* ---- the mode --------------------------------------------------------- */

let mode = false;
const modeListeners = new Set<() => void>();

export function getGraveyardMode(): boolean {
  return mode;
}

export function setGraveyardMode(on: boolean): void {
  if (mode === on) return;
  mode = on;
  modeListeners.forEach((l) => l());
}

export function useGraveyardMode(): boolean {
  const [on, setOn] = useState(getGraveyardMode);
  useEffect(() => {
    const l = () => setOn(getGraveyardMode());
    modeListeners.add(l);
    l(); // catch a change between render and subscribe
    return () => {
      modeListeners.delete(l);
    };
  }, []);
  return on;
}

/* ---- the button ------------------------------------------------------- */

const STORAGE_KEY = "micoll.graveyardButton";

export function getGraveyardButton(): boolean {
  try {
    // on unless it's "false"
    return localStorage.getItem(STORAGE_KEY) !== "false";
  } catch {
    return true;
  }
}

const buttonListeners = new Set<() => void>();

export function setGraveyardButton(on: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, on ? "true" : "false");
  } catch {
    /* ignore */
  }
  // hiding the button also leaves the graveyard, otherwise you'd be stuck in it
  if (!on) setGraveyardMode(false);
  queuePrefsSync();
  buttonListeners.forEach((l) => l());
}

export function useGraveyardButton(): boolean {
  const [on, setOn] = useState(getGraveyardButton);
  useEffect(() => {
    const l = () => setOn(getGraveyardButton());
    buttonListeners.add(l);
    return () => {
      buttonListeners.delete(l);
    };
  }, []);
  return on;
}
