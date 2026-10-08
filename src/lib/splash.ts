/**
 * Startup splash (the markup is in index.html so it shows in the very first frame).
 * It hides when the library is loaded AND the app has its settings (prefs, licence,
 * lock check), not when React mounts. Otherwise the black placeholder App shows while
 * it waits for those was on screen for a second between the splash and the dashboard.
 */

let done = false;

/** What still has to finish before the splash goes. */
const waiting = new Set<"library" | "app">(["library", "app"]);

/** One part is ready; the splash fades once both are and the next frame was painted. */
export function splashReady(part: "library" | "app"): void {
  waiting.delete(part);
  if (waiting.size === 0) afterPaint(dismissSplash);
}

/** Runs after the next painted frame (timeout for a hidden window without rAF). */
function afterPaint(fn: () => void): void {
  let ran = false;
  const run = () => {
    if (ran) return;
    ran = true;
    fn();
  };
  const timer = window.setTimeout(run, 120);
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      window.clearTimeout(timer);
      run();
    }),
  );
}

/** Fade out and remove the splash. Safe to call more than once. */
export function dismissSplash(): void {
  if (done) return;
  done = true;
  const el = document.getElementById("micoll-splash");
  if (!el) return;
  // set the attribute and inline opacity (inline style always wins over the css order)
  el.setAttribute("data-done", "");
  el.style.opacity = "0";
  el.style.pointerEvents = "none";
  // remove it after the fade so it can't block clicks
  window.setTimeout(() => el.remove(), 400);
}
