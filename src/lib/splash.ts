/**
 * Startup splash (the markup is in index.html so it shows in the very first frame).
 * It hides when the library is loaded, not when React mounts,
 * otherwise you'd see the empty dashboard for a second.
 */

let done = false;

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
