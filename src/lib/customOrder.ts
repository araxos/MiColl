/**
 * Dashboard "Custom" sort: the card order the user dragged together.
 * Saved as a list of artist ids. Ids not in the list (new creators) go after it.
 * Empty = not arranged yet, then the first switch to Custom copies the current sort.
 */
import { queuePrefsSync } from "@/lib/prefs";

const KEY = "micoll.customOrder";

export function getCustomOrder(): string[] {
  try {
    const arr = JSON.parse(localStorage.getItem(KEY) ?? "[]") as unknown;
    return Array.isArray(arr) ? arr.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

export function setCustomOrder(ids: string[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(ids));
  } catch {
    /* ignore */
  }
  queuePrefsSync();
}

/** Move id next to target (before or after, see side). Other ids stay in place. */
export function moveWithin(order: string[], id: string, target: string, side: "before" | "after") {
  if (id === target) return order;
  const next = order.filter((x) => x !== id);
  const at = next.indexOf(target);
  if (at < 0) return order;
  next.splice(side === "before" ? at : at + 1, 0, id);
  return next;
}

/**
 * Put id at the border between pinned and unpinned cards (right after the last pinned one).
 * Pinned cards always stay on top, so this is where a drag across that border ends up.
 */
export function moveToPinBorder(order: string[], id: string, pinned: (x: string) => boolean) {
  const next = order.filter((x) => x !== id);
  let at = 0;
  next.forEach((x, i) => {
    if (pinned(x)) at = i + 1;
  });
  next.splice(at, 0, id);
  return next;
}
