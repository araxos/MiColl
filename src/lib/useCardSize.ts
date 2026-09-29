import { useCallback, useEffect, useRef, useState } from "react";
import { queuePrefsSync } from "@/lib/prefs";

/**
 * Ctrl+mouse wheel to resize cards in a grid. Returns the min column width
 * (saved in localStorage under key) and a ref for the container.
 * Normal wheel still scrolls.
 */
export function useCardSize(key: string, def = 180, min = 120, max = 340) {
  const [size, setSize] = useState(() => {
    const v = parseInt(localStorage.getItem(key) ?? "", 10);
    return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : def;
  });

  useEffect(() => {
    try {
      localStorage.setItem(key, String(size));
    } catch {
      /* ignore */
    }
    queuePrefsSync();
  }, [key, size]);

  const cleanup = useRef<(() => void) | undefined>(undefined);
  const ref = useCallback(
    (node: HTMLElement | null) => {
      cleanup.current?.();
      cleanup.current = undefined;
      if (!node) return;
      const handler = (e: WheelEvent) => {
        if (!e.ctrlKey) return;
        e.preventDefault(); // also suppresses the webview's page zoom
        setSize((s) => Math.min(max, Math.max(min, s + (e.deltaY < 0 ? 20 : -20))));
      };
      node.addEventListener("wheel", handler, { passive: false });
      cleanup.current = () => node.removeEventListener("wheel", handler);
    },
    [min, max],
  );

  return { size, ref };
}
