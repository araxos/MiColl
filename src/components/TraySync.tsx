import { useEffect, useRef } from "react";
import { useLocation } from "react-router-dom";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import * as api from "@/api/library";
import { useSfwMode } from "@/lib/contentMode";
import { t, useLanguage } from "@/lib/i18n";
import { isTauri } from "@/lib/tauri";

/**
 * Keeps the tray menu (lib.rs tray_menu) in step with this window: the labels in its
 * language, Lock only while unlocked, and the recently opened creators, which are left
 * out while locked, in safe mode or SFW mode (the menu sits outside the lock screen).
 * Notes every creator page opened, and locks when the tray's "Lock" is clicked.
 */
export function TraySync({ locked, safe, onLock }: { locked: boolean; safe: boolean; onLock: () => void }) {
  const lang = useLanguage();
  const sfw = useSfwMode();
  const { pathname } = useLocation();
  const lockRef = useRef(onLock);
  lockRef.current = onLock;

  useEffect(() => {
    if (!isTauri()) return;
    const labels = {
      open: t("Open MiColl"),
      add: t("Add rewards…"),
      lock: t("Lock MiColl"),
      recent: t("Recently opened"),
      quit: t("Quit MiColl"),
    };
    void api.syncTray(labels, locked, !locked && !safe && !sfw).catch(() => {});
  }, [lang, locked, safe, sfw]);

  // a creator page (also its months and rewards) counts as opening that creator
  const creator = pathname.match(/^\/artist\/([^/]+)/)?.[1];
  useEffect(() => {
    if (!isTauri() || !creator || locked || safe) return;
    void api.noteRecentCreator(decodeURIComponent(creator)).catch(() => {});
  }, [creator, locked, safe]);

  useEffect(() => {
    if (!isTauri()) return;
    let alive = true;
    let unlisten: (() => void) | undefined;
    void getCurrentWebviewWindow()
      .listen("micoll://lock", () => {
        // the menu item is only there with a password, but check: without one the lock
        // screen would have nothing to ask
        void api.hasPassword().then((has) => has && lockRef.current()).catch(() => {});
      })
      .then((off) => {
        if (alive) unlisten = off;
        else off();
      });
    return () => {
      alive = false;
      unlisten?.();
    };
  }, []);

  return null;
}
