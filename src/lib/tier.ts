/**
 * Reward tiers: which of the creator's tiers a reward came with ("2", "Gold", "$10" …).
 * Free text, optional, only on rewards. A plain number reads "Tier 2", anything else
 * shows as typed.
 */

import type { Artist } from "@/types";

/** What the tile shows. `tf` is the app's useTf. */
export function tierLabel(
  tier: string,
  tf: (text: string, vars: Record<string, string | number>) => string,
): string {
  const t = tier.trim();
  return /^\d+$/.test(t) ? tf("Tier {n}", { n: t }) : t;
}

/** The tiers a creator already uses, numbers first (1, 2, 10), then the rest A–Z. */
export function creatorTiers(artist: Artist | undefined): string[] {
  if (!artist) return [];
  const seen = new Map<string, string>();
  for (const p of artist.platforms)
    for (const m of p.months)
      for (const r of m.rewards) {
        const t = r.tier?.trim();
        if (t && !seen.has(t.toLowerCase())) seen.set(t.toLowerCase(), t);
      }
  return [...seen.values()].sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }));
}

/** The number in a tier ("2", "Tier 3", "$10 Supporter" → 10), null when there's none. */
export function tierNumber(tier: string | null | undefined): number | null {
  const m = tier?.match(/\d+/);
  return m ? Number(m[0]) : null;
}

/**
 * Rewards by tier when some have a numbered one: Tier 1 first, then up. Text tiers
 * ("Gold") come after them and rewards without a tier last, both in the order they had.
 * Without any numbered tier the order stays as it is.
 */
export function sortByTier<T>(items: T[], tierOf: (item: T) => string | null | undefined): T[] {
  if (!items.some((it) => tierNumber(tierOf(it)) !== null)) return items;
  const rank = (it: T) => {
    const tier = tierOf(it)?.trim();
    if (!tier) return [2, 0] as const;
    const n = tierNumber(tier);
    return n === null ? ([1, 0] as const) : ([0, n] as const);
  };
  return items
    .map((it, i) => ({ it, i, r: rank(it) }))
    .sort((a, b) => a.r[0] - b.r[0] || a.r[1] - b.r[1] || a.i - b.i)
    .map((x) => x.it);
}
