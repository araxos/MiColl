import { useEffect, useState } from "react";
import { queuePrefsSync } from "@/lib/prefs";

/**
 * What the window button in the header does on single click (the other action is
 * on double click). Saved.
 */
export type CloseAction = "close" | "minimize";

export const CLOSE_ACTION_EVENT = "micoll:closeAction";
const KEY = "micoll.closeAction";

export function getCloseAction(): CloseAction {
  try {
    return localStorage.getItem(KEY) === "minimize" ? "minimize" : "close";
  } catch {
    return "close";
  }
}

export function setCloseAction(v: CloseAction) {
  try {
    localStorage.setItem(KEY, v);
  } catch {
    /* ignore */
  }
  queuePrefsSync();
  window.dispatchEvent(new CustomEvent(CLOSE_ACTION_EVENT));
}

export const toggleCloseAction = () =>
  setCloseAction(getCloseAction() === "close" ? "minimize" : "close");

export function useCloseAction(): CloseAction {
  const [a, setA] = useState(getCloseAction);
  useEffect(() => {
    const update = () => setA(getCloseAction());
    window.addEventListener(CLOSE_ACTION_EVENT, update);
    window.addEventListener("storage", update);
    return () => {
      window.removeEventListener(CLOSE_ACTION_EVENT, update);
      window.removeEventListener("storage", update);
    };
  }, []);
  return a;
}
