import { useEffect, useState } from "react";
import { queuePrefsSync } from "@/lib/prefs";

/**
 * Settings "no descriptions" mode: hides the explanation texts in Settings.
 * Texts that should hide have the settings-desc class, one CSS rule hides them.
 */
export const CONCISE_EVENT = "micoll:concise";
const KEY = "micoll.settingsConcise";

export function getConcise(): boolean {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

export function setConcise(v: boolean) {
  try {
    localStorage.setItem(KEY, v ? "1" : "0");
  } catch {
    /* ignore */
  }
  queuePrefsSync();
  window.dispatchEvent(new CustomEvent(CONCISE_EVENT));
}

export const toggleConcise = () => setConcise(!getConcise());

export function useConcise(): boolean {
  const [c, setC] = useState(getConcise);
  useEffect(() => {
    const update = () => setC(getConcise());
    window.addEventListener(CONCISE_EVENT, update);
    window.addEventListener("storage", update);
    return () => {
      window.removeEventListener(CONCISE_EVENT, update);
      window.removeEventListener("storage", update);
    };
  }, []);
  return c;
}
