/**
 * Settings of the bar on the left (SideBar: Dashboard, Wallpaper Hub), not in Settings:
 *   sidebar     - shown or not, a click on the logo switches it
 *   sidebarText - the pages' names next to their icons under the mouse (also in the list
 *                 under the logo), switched with the gear at the bar's bottom
 */

import { useEffect, useState } from "react";
import { queuePrefsSync } from "@/lib/prefs";

const SHOWN_KEY = "micoll.sidebar";
const TEXT_KEY = "micoll.sidebarText";

function read(key: string): boolean {
  try {
    // on unless it's "false"
    return localStorage.getItem(key) !== "false";
  } catch {
    return true;
  }
}

const listeners = new Set<() => void>();

function write(key: string, on: boolean): void {
  try {
    localStorage.setItem(key, on ? "true" : "false");
  } catch {
    /* ignore */
  }
  queuePrefsSync();
  listeners.forEach((l) => l());
}

function useFlag(key: string): boolean {
  const [on, setOn] = useState(() => read(key));
  useEffect(() => {
    const l = () => setOn(read(key));
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, [key]);
  return on;
}

export const setSidebar = (on: boolean) => write(SHOWN_KEY, on);
export const useSidebar = () => useFlag(SHOWN_KEY);

export const setSidebarText = (on: boolean) => write(TEXT_KEY, on);
export const useSidebarText = () => useFlag(TEXT_KEY);
