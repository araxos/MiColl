import { useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { useActions } from "@/actions";
import { isTauri } from "@/lib/tauri";
import * as api from "@/api/library";

/**
 * Runs what the taskbar's jump list or the tray menu asked for ("Add rewards" = the folder
 * picker and the import review, like the Import folder button; "creator:<id>" = that
 * creator's page). Rust keeps the request until we take
 * it, so a start from the taskbar or a request while locked runs once MiColl is ready.
 * Only this window's events: with two windows open the one Rust brought up handles it.
 */
export function LaunchActions({ active }: { active: boolean }) {
  const { addRewards } = useActions();
  // a ref, so a new addRewards identity doesn't re-subscribe and re-ask Rust each render
  const addRef = useRef(addRewards);
  addRef.current = addRewards;
  const navigate = useNavigate();
  const navRef = useRef(navigate);
  navRef.current = navigate;

  useEffect(() => {
    if (!active || !isTauri()) return;
    let alive = true;
    const run = async () => {
      const action = await api.takeLaunchAction().catch(() => null);
      if (!alive || !action) return;
      if (action === "add-rewards") void addRef.current();
      else if (action.startsWith("creator:")) navRef.current(`/artist/${action.slice("creator:".length)}`);
    };
    void run();
    let unlisten: (() => void) | undefined;
    void getCurrentWebviewWindow()
      .listen("micoll://launch-action", () => void run())
      .then((off) => {
        if (alive) unlisten = off;
        else off();
      });
    return () => {
      alive = false;
      unlisten?.();
    };
  }, [active]);

  return null;
}
