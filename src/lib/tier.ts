/**
 * Reward tiers: which of the creator's tiers a reward came with ("2", "Gold", "$10" …).
 * Free text, optional, only on rewards. A plain number reads "Tier 2", anything else
 * shows as typed.
 * The creator's list (Details → Tiers) ties each tier to a platform and keeps the
 * creator's order, which the reward grids follow.
 */

import type { Artist, TierEntry } from "@/types";

/** What the tile shows. `tf` is the app's useTf. */
export function tierLabel(
  tier: string,
  tf: (text: string, vars: Record<string, string | number>) => string,
): string {
  const t = tier.trim();
  return /^\d+$/.test(t) ? tf("Tier {n}", { n: t }) : t;
}

/** Platform names compare trimmed and without case, none and "" are the same. */
export const platformKey = (p: string | null | undefined) => (p ?? "").trim().toLowerCase();

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** One tier of the list with how many of the creator's own rewards have it. */
export interface TierUse extends TierEntry {
  count: number;
}

/**
 * A creator's tiers in their order, each with how many of their own rewards have it. A
 * reward counts for the tier on its platform, else the "any platform" one of that
 * name. Tiers a reward has that aren't in the list (set before the list existed) come
 * after, on the reward's platform.
 */
export function tierUsage(artist: Artist | undefined): TierUse[] {
  if (!artist) return [];
  const out: TierUse[] = (artist.tierList ?? []).map((e) => ({ ...e, count: 0 }));
  for (const p of artist.platforms)
    for (const m of p.months)
      for (const r of m.rewards) {
        const t = r.tier?.trim();
        // a collab's borrowed copy counts for its owner
        if (!t || r.collabFrom) continue;
        const here = platformKey(p.name);
        const hit =
          out.find((e) => sameName(e.name, t) && e.platform != null && platformKey(e.platform) === here) ??
          out.find((e) => sameName(e.name, t) && e.platform == null);
        if (hit) hit.count += 1;
        else out.push({ name: t, platform: p.name || null, count: 1 });
      }
  return out;
}

/**
 * The tiers to offer on a platform, in the creator's order: the platform's own and the
 * "any platform" ones. Without a platform (or when none fit) every tier of the creator.
 */
export function creatorTiers(artist: Artist | undefined, platform?: string | null): string[] {
  const all = tierUsage(artist);
  const here = platformKey(platform);
  const fits = platform ? all.filter((e) => e.platform == null || platformKey(e.platform) === here) : all;
  const names: string[] = [];
  for (const e of fits.length ? fits : all) if (!names.some((n) => sameName(n, e.name))) names.push(e.name);
  return names;
}

/** The number in a tier ("2", "Tier 3", "$10 Supporter" → 10), null when there's none. */
export function tierNumber(tier: string | null | undefined): number | null {
  const m = tier?.match(/\d+/);
  return m ? Number(m[0]) : null;
}

/**
 * Rewards by tier: in the creator's order (orderOf gives the tier names in order for an
 * item, see creatorTiers), tiers not in it by their number (Tier 1 first), text tiers
 * ("Gold") after them and rewards without a tier last, all in the order they had.
 * When no reward has a listed or numbered tier the order stays as it is.
 */
export function sortByTier<T>(
  items: T[],
  tierOf: (item: T) => string | null | undefined,
  orderOf: (item: T) => string[] = () => [],
): T[] {
  const rank = (it: T): readonly [number, number] => {
    const tier = tierOf(it)?.trim();
    if (!tier) return [3, 0];
    const at = orderOf(it).findIndex((n) => sameName(n, tier));
    if (at >= 0) return [0, at];
    const n = tierNumber(tier);
    return n === null ? [2, 0] : [1, n];
  };
  const ranked = items.map((it, i) => ({ it, i, r: rank(it) }));
  if (!ranked.some((x) => x.r[0] < 2)) return items;
  return ranked.sort((a, b) => a.r[0] - b.r[0] || a.r[1] - b.r[1] || a.i - b.i).map((x) => x.it);
}
