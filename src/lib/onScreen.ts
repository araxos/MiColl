/**
 * Is this tile near the viewport? One shared IntersectionObserver for the app.
 * The creator page and reward grid mount all tiles, so tiles far off screen get
 * data-offscreen="1" and index.css pauses their animations.
 */

import { useEffect, useRef, useState } from "react";

/** How far outside the viewport still counts as visible (about one screen). */
const ROOT_MARGIN = "600px 0px";

type Report = (onScreen: boolean) => void;

let observer: IntersectionObserver | null = null;
const reports = new Map<Element, Report>();

function shared(): IntersectionObserver | null {
  if (observer) return observer;
  if (typeof IntersectionObserver === "undefined") return null;
  observer = new IntersectionObserver(
    (entries) => {
      for (const e of entries) reports.get(e.target)?.(e.isIntersecting);
    },
    { rootMargin: ROOT_MARGIN },
  );
  return observer;
}

/** Watch an element. Returns an unobserve function. */
export function observeOnScreen(el: Element, report: Report): () => void {
  const obs = shared();
  // no IntersectionObserver -> treat everything as visible
  if (!obs) {
    report(true);
    return () => {};
  }
  reports.set(el, report);
  obs.observe(el);
  return () => {
    reports.delete(el);
    obs.unobserve(el);
  };
}

/** Ref + flag for a tile. Starts true so the first paint isn't frozen. */
export function useOnScreen<T extends Element>(): {
  ref: React.RefObject<T | null>;
  onScreen: boolean;
} {
  const ref = useRef<T | null>(null);
  const [onScreen, setOnScreen] = useState(true);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    return observeOnScreen(el, setOnScreen);
  }, []);
  return { ref, onScreen };
}
