/**
 * Entry point. Only shows the splash and then loads the real app (boot.tsx).
 *
 * The webview only paints after DOMContentLoaded, which waits for all static imports.
 * So the app is loaded with a dynamic import, otherwise the splash shows up last.
 */
import { dismissSplash } from "@/lib/splash";

// backup: hide the splash after a few seconds even if loading never finishes
// (normally store.tsx hides it)
window.setTimeout(dismissSplash, 8000);

/**
 * Waits until the splash was painted once. The timeout is for a hidden window
 * where requestAnimationFrame doesn't run.
 */
function splashPainted(): Promise<void> {
  return new Promise((resolve) => {
    const timer = window.setTimeout(resolve, 150);
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        window.clearTimeout(timer);
        resolve();
      }),
    );
  });
}

void splashPainted()
  .then(() => import("./boot"))
  .catch((e) => {
    // app failed to load, don't leave the logo on a blank page
    console.error("MiColl failed to start:", e);
    dismissSplash();
  });
