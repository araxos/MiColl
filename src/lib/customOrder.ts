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

/**
 * The custom release style's order: where it was dragged to, the rest after that in the
 * order they were made (their numbers count up).
 */
export function byPlace(
  aPos: number | null | undefined,
  aNumber: number,
  bPos: number | null | undefined,
  bNumber: number,
) {
  if (aPos != null && bPos != null) return aPos - bPos || aNumber - bNumber;
  if (aPos != null) return -1;
  if (bPos != null) return 1;
  return aNumber - bNumber;
}

/** A custom platform's periods in that order, year by year with Misc last. */
export function sortCustomMonths<
  T extends { year: number | null; month: number | null; yearPos?: number | null; monthPos?: number | null },
>(months: T[]): T[] {
  return [...months].sort((a, b) => {
    if (a.year == null || b.year == null) return Number(a.year == null) - Number(b.year == null);
    return byPlace(a.yearPos, a.year, b.yearPos, b.year) || byPlace(a.monthPos, a.month ?? 0, b.monthPos, b.month ?? 0);
  });
}

type CustomMonth = Parameters<typeof sortCustomMonths>[0][number] & {
  yearName?: string | null;
  label: string;
  plainLabel?: string;
};

/** Each name once, the first spelling wins ("Ä" and "ä" are one folder). */
export function uniqueNames(names: string[]) {
  const seen = new Set<string>();
  return names.filter((n) => {
    const key = n.trim().toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** A custom platform's year names, in their order. */
export function customYearNames(months: CustomMonth[]) {
  const dated = sortCustomMonths(months).filter((m) => m.year != null);
  return uniqueNames(dated.map((m) => m.yearName ?? String(m.year)));
}

/** A custom platform's card names: this year's first, then the other years'. */
export function customMonthNames(months: CustomMonth[], year: string) {
  const want = year.trim().toLowerCase();
  const cards = sortCustomMonths(months).filter((m) => m.year != null && m.month != null);
  const nameOf = (m: CustomMonth) =>
    (m.month as number) > 12 ? m.plainLabel ?? m.label : String(m.month).padStart(2, "0");
  const inYear = (m: CustomMonth) => (m.yearName ?? String(m.year)).toLowerCase() === want;
  return uniqueNames([...cards.filter(inYear).map(nameOf), ...cards.filter((m) => !inYear(m)).map(nameOf)]);
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
