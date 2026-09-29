import { useEffect, useState } from "react";
import { hasPassword } from "@/api/library";
import { isTauri } from "@/lib/tauri";

/** Event Settings fires after changing lock options, so App reloads them. */
export const LOCK_SETTINGS_EVENT = "micoll:locksettings";

/**
 * Is a lock password set? The Lock button only shows if there is one
 * (locking without a password would be fake security).
 * Updates on LOCK_SETTINGS_EVENT.
 */
export function usePasswordSet(): boolean {
  const [set, setSet] = useState(false);
  useEffect(() => {
    let alive = true;
    const read = () => {
      if (!isTauri()) return;
      hasPassword()
        .then((v) => alive && setSet(v))
        .catch(() => {});
    };
    read();
    window.addEventListener(LOCK_SETTINGS_EVENT, read);
    return () => {
      alive = false;
      window.removeEventListener(LOCK_SETTINGS_EVENT, read);
    };
  }, []);
  return set;
}

/** Auto-lock options in minutes (0 = never). */
export const AUTO_LOCK_OPTIONS: { label: string; value: number }[] = [
  { label: "Never", value: 0 },
  { label: "5 minutes", value: 5 },
  { label: "30 minutes", value: 30 },
  { label: "1 hour", value: 60 },
  { label: "4 hours", value: 240 },
];
