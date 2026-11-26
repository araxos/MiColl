import { useCallback } from "react";
import { useNavigate } from "react-router-dom";

/**
 * Back / up navigation that keeps the scroll position.
 * navigate(path) pushes a new entry that starts at the top, navigate(-1) goes back
 * to the old entry and Layout restores its scroll. So we go back only if the
 * previous entry really is the parent page, otherwise we push.
 */

// react-router saves an idx in history.state, we remember idx -> path
// so the back button can check the previous entry
const pathByIdx = new Map<number, string>();

function currentIdx(): number | undefined {
  const idx = (window.history.state as { idx?: number } | null)?.idx;
  return typeof idx === "number" ? idx : undefined;
}

/** Remember the current page. Called on every location change (from Layout). */
export function recordHistoryEntry(pathname: string) {
  const idx = currentIdx();
  if (idx != null) pathByIdx.set(idx, pathname);
}

/**
 * Returns a navigate-up function. to = parent path, matches = optional check
 * if the previous entry counts as that parent (default: exact path).
 */
export function useUpNavigate() {
  const navigate = useNavigate();
  return useCallback(
    (to: string, matches?: (prevPath: string) => boolean) => {
      const idx = currentIdx();
      if (idx != null && idx > 0) {
        const prev = pathByIdx.get(idx - 1);
        if (prev != null && (matches ? matches(prev) : prev === to)) {
          navigate(-1);
          return;
        }
      }
      navigate(to);
    },
    [navigate],
  );
}

/**
 * From the Wallpaper Hub back to where the dashboard side was left (grid, creator, month,
 * wishlist...). Goes back to that entry, so its scroll and its own back button still work.
 * Settings doesn't count, the page before it does.
 */
export function useReturnToDashboard() {
  const navigate = useNavigate();
  return useCallback(() => {
    const idx = currentIdx() ?? 0;
    for (let i = idx - 1; i >= 0; i--) {
      const path = pathByIdx.get(i);
      // not known (the window was reloaded)
      if (path == null) break;
      if (path.startsWith("/wallpapers") || path.startsWith("/notes") || path.startsWith("/settings")) continue;
      navigate(i - idx);
      return;
    }
    navigate("/");
  }, [navigate]);
}
