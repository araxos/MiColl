import { useEffect, useState } from "react";

/**
 * "Immersive" mode: a fullscreen overlay (like the viewer) is open, so the title bar
 * is hidden. Counted, so several overlays at once still work.
 */
const EVENT = "micoll:immersive";
let count = 0;

/**
 * Enter immersive mode, returns a function to leave it.
 * Use it like useEffect(() => enterImmersive(), []).
 */
export function enterImmersive(): () => void {
  count += 1;
  window.dispatchEvent(new CustomEvent(EVENT));
  let released = false;
  return () => {
    if (released) return;
    released = true;
    count = Math.max(0, count - 1);
    window.dispatchEvent(new CustomEvent(EVENT));
  };
}

export function useImmersive(): boolean {
  const [on, setOn] = useState(() => count > 0);
  useEffect(() => {
    const update = () => setOn(count > 0);
    window.addEventListener(EVENT, update);
    update();
    return () => window.removeEventListener(EVENT, update);
  }, []);
  return on;
}
