import { useEffect, useState } from "react";
import { queuePrefsSync } from "@/lib/prefs";

/**
 * How many window buttons the header shows.
 * both (default) = minimize + close like every other window.
 * one = a single button with the chosen action (closeAction) and the other one on
 * double click. Single clicks wait 230ms for a possible double click.
 */
export type WindowButtons = "both" | "one";

export const WINDOW_BUTTONS_EVENT = "micoll:windowButtons";
const KEY = "micoll.windowButtons";

export function getWindowButtons(): WindowButtons {
  try {
    return localStorage.getItem(KEY) === "one" ? "one" : "both";
  } catch {
    return "both";
  }
}

export function setWindowButtons(v: WindowButtons) {
  try {
    localStorage.setItem(KEY, v);
  } catch {
    /* ignore */
  }
  queuePrefsSync();
  window.dispatchEvent(new CustomEvent(WINDOW_BUTTONS_EVENT));
}

export const toggleWindowButtons = () =>
  setWindowButtons(getWindowButtons() === "both" ? "one" : "both");

export function useWindowButtons(): WindowButtons {
  const [v, setV] = useState(getWindowButtons);
  useEffect(() => {
    const update = () => setV(getWindowButtons());
    window.addEventListener(WINDOW_BUTTONS_EVENT, update);
    window.addEventListener("storage", update);
    return () => {
      window.removeEventListener(WINDOW_BUTTONS_EVENT, update);
      window.removeEventListener("storage", update);
    };
  }, []);
  return v;
}
