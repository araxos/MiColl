/**
 * Startup splash (the markup is in index.html so it shows in the very first frame).
 * It hides when the library is loaded AND the app has its settings (prefs, licence,
 * lock check), not when React mounts. Otherwise the black placeholder App shows while
 * it waits for those was on screen for a second between the splash and the dashboard.
 *
 * Then it still waits until the first screen is really drawn: an opaque splash hides
 * the app from the renderer, which skips painting what it fully covers. So the
 * dashboard was only drawn once the fade began, and right after a PC restart (cold
 * GPU, covers still on disk) that showed as a black screen for a second.
 */

let done = false;
let revealing = false;

/** What still has to finish before the splash goes. */
const waiting = new Set<"library" | "app">(["library", "app"]);

/** One part is ready; the splash fades once both are and the first screen is drawn. */
export function splashReady(part: "library" | "app"): void {
  waiting.delete(part);
  if (waiting.size === 0) void reveal();
}

/** Longest the splash waits for the first screen (it never hangs on a slow cover). */
const DRAW_CAP_MS = 4000;
/** Shortest time the app gets to draw behind the splash. */
const DRAW_MIN_MS = 300;

async function reveal(): Promise<void> {
  if (revealing || done) return;
  revealing = true;
  const el = document.getElementById("micoll-splash");
  // a hair see-through: looks the same, but no longer covers the app for the renderer,
  // so the dashboard gets painted now, behind it, instead of after the fade
  if (el) {
    el.style.transition = "none";
    el.style.opacity = "0.995";
  }
  const start = performance.now();
  await withCap(
    (async () => {
      await afterFrames(2); // React's first render of the dashboard is on screen
      await Promise.all([fontsReady(), visibleImagesReady()]);
      await smoothFrames(start);
    })(),
    DRAW_CAP_MS,
  );
  if (el) {
    // the fade transition back on, applied (reflow) before the opacity changes
    el.style.transition = "";
    void el.offsetWidth;
  }
  dismissSplash();
}

function withCap(p: Promise<unknown>, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = window.setTimeout(resolve, ms);
    void p.finally(() => {
      window.clearTimeout(timer);
      resolve();
    });
  });
}

/** Resolves after n painted frames (or a short timeout in a hidden window). */
function afterFrames(n: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = window.setTimeout(resolve, 150);
    const step = (left: number) =>
      requestAnimationFrame(() => {
        if (left <= 1) {
          window.clearTimeout(timer);
          resolve();
        } else step(left - 1);
      });
    step(n);
  });
}

function fontsReady(): Promise<unknown> {
  return document.fonts?.ready ?? Promise.resolve();
}

/** Covers (and the wallpaper) on the first screen: loaded and decoded, so they show up
 *  together with the dashboard instead of one by one. */
function visibleImagesReady(): Promise<unknown> {
  const root = document.getElementById("root");
  if (!root) return Promise.resolve();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const imgs = Array.from(root.querySelectorAll("img")).filter((img) => {
    if (!img.getAttribute("src")) return false;
    const r = img.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw;
  });
  return Promise.all(imgs.map((img) => img.decode().catch(() => {})));
}

/** Waits for DRAW_MIN_MS and then for a few quick frames in a row, i.e. the renderer
 *  caught up with painting (it stutters while it's still busy). */
function smoothFrames(start: number): Promise<void> {
  return new Promise((resolve) => {
    let last = performance.now();
    let smooth = 0;
    const timer = window.setTimeout(resolve, 1500);
    const tick = () => {
      const now = performance.now();
      smooth = now - last < 34 ? smooth + 1 : 0;
      last = now;
      if (smooth >= 4 && now - start >= DRAW_MIN_MS) {
        window.clearTimeout(timer);
        resolve();
      } else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
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
