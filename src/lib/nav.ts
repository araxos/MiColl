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
