/**
 * Shape of reward tiles in a grid (set in Settings -> Appearance).
 * One for the creator page and one for the month page.
 * The dashboard always uses 4:6 (DASHBOARD_SHAPE).
 * Only the aspect ratio changes, the width comes from Ctrl+wheel (useCardSize).
 */

import { useEffect, useState } from "react";
import { queuePrefsSync } from "@/lib/prefs";

export type TileShape = "banner" | "square" | "portrait" | "card" | "poster";

/** Which grid: creator page or month page. */
export type TileScope = "year" | "month";

export interface TileShapeDef {
  key: TileShape;
  label: string;
  /** Label like "4 : 6". */
  ratio: string;
  /** Tailwind aspect class, written out fully so Tailwind finds it. */
  aspect: string;
  /** Same ratio as height / width (for the virtual grid row height). */
  ratioHW: number;
  hint: string;
}

/** Widest to tallest. */
export const TILE_SHAPES: TileShapeDef[] = [
  {
    key: "banner",
    label: "Banner",
    ratio: "10 : 5",
    aspect: "aspect-[10/5]",
    ratioHW: 5 / 10,
    hint: "Wide and short, like a film still. Best for landscape art and long rows.",
  },
  {
    key: "square",
    label: "Square",
    ratio: "1 : 1",
    aspect: "aspect-square",
    ratioHW: 1,
    hint: "Even rows, most tiles on screen. Covers are cropped to the middle.",
  },
  {
    key: "portrait",
    label: "Portrait",
    ratio: "4 : 5",
    aspect: "aspect-[4/5]",
    ratioHW: 5 / 4,
    hint: "A gentle portrait — a little less crop than Square, a little less height than Card.",
  },
  {
    key: "card",
    label: "Card",
    ratio: "4 : 6",
    aspect: "aspect-[4/6]",
    ratioHW: 6 / 4,
    hint: "Portrait, like a photo print — keeps more of a standing figure.",
  },
  {
    key: "poster",
    label: "Poster",
    ratio: "5 : 10",
    aspect: "aspect-[5/10]",
    ratioHW: 10 / 5,
    hint: "Tall and narrow, like a cinema poster. Full-length art barely crops.",
  },
];

export const TILE_SCOPES: { key: TileScope; label: string; hint: string }[] = [
  {
    key: "year",
    label: "On a creator page",
    hint: "Rewards that sit in a year folder, unsorted drops, and creators kept without dates.",
  },
  {
    key: "month",
    label: "On a month page",
    hint: "The grid you get after opening a month — nothing but that month's rewards.",
  },
];

const KEYS: Record<TileScope, string> = {
  year: "micoll.tileShape.year",
  month: "micoll.tileShape.month",
};
/** The old single setting, still used as the start value for both. */
const LEGACY_KEY = "micoll.tileShape";
/** Default shapes (also what Reset gives). */
const DEFAULTS: Record<TileScope, TileShape> = {
  year: "square",
  month: "poster",
};

const known = (v: string | null): v is TileShape => TILE_SHAPES.some((s) => s.key === v);

export function getTileShape(scope: TileScope): TileShape {
  try {
    const v = localStorage.getItem(KEYS[scope]);
    if (known(v)) return v;
    // both came from the old shared setting
    const legacy = localStorage.getItem(LEGACY_KEY);
    return known(legacy) ? legacy : DEFAULTS[scope];
  } catch {
    return DEFAULTS[scope];
  }
}

/** The fixed shape for dashboard cards (not a setting). The cover cropper uses it too. */
export const DASHBOARD_SHAPE: TileShapeDef = TILE_SHAPES.find((s) => s.key === "card")!;

/** The definition of the chosen shape. */
export function tileShapeDef(scope: TileScope): TileShapeDef {
  const key = getTileShape(scope);
  return TILE_SHAPES.find((s) => s.key === key) ?? TILE_SHAPES[1];
}

const listeners = new Set<() => void>();

export function setTileShape(scope: TileScope, key: TileShape): void {
  try {
    localStorage.setItem(KEYS[scope], key);
  } catch {
    /* ignore */
  }
  queuePrefsSync();
  listeners.forEach((l) => l());
}

/* ---- Per-page overrides ----
   A single creator can have its own shape (artist:12 for the creator page,
   artist-months:12 for its month pages). No entry = use the setting. */
const OVERRIDE_PREFIX = "micoll.tileShape.for.";

export function getTileOverride(key: string): TileShape | null {
  try {
    const v = localStorage.getItem(OVERRIDE_PREFIX + key);
    return known(v) ? v : null;
  } catch {
    return null;
  }
}

/** null removes the override. */
export function setTileOverride(key: string, shape: TileShape | null): void {
  try {
    if (shape) localStorage.setItem(OVERRIDE_PREFIX + key, shape);
    else localStorage.removeItem(OVERRIDE_PREFIX + key);
  } catch {
    /* ignore */
  }
  queuePrefsSync();
  listeners.forEach((l) => l());
}

/** Remove all saved shapes (incl. the old key) so everything uses the defaults. */
export function resetTileShapes(): void {
  try {
    for (const k of Object.values(KEYS)) localStorage.removeItem(k);
    localStorage.removeItem(LEGACY_KEY);
  } catch {
    /* ignore */
  }
  queuePrefsSync();
  listeners.forEach((l) => l());
}

/** Subscribe to a scope's tile shape. */
export function useTileShape(scope: TileScope): TileShapeDef {
  const [shape, setShape] = useState(() => tileShapeDef(scope));
  useEffect(() => {
    const l = () => setShape(tileShapeDef(scope));
    l();
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, [scope]);
  return shape;
}

/** The shape a page should use: its override or the setting. */
export function useTileShapeFor(scope: TileScope, overrideKey?: string): TileShapeDef {
  const resolve = () => {
    const own = overrideKey ? getTileOverride(overrideKey) : null;
    return own ? (TILE_SHAPES.find((s) => s.key === own) ?? tileShapeDef(scope)) : tileShapeDef(scope);
  };
  const [shape, setShape] = useState(resolve);
  useEffect(() => {
    const l = () => setShape(resolve());
    l();
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, overrideKey]);
  return shape;
}

/** The page's own shape, or null if it uses the setting. */
export function useTileOverride(key: string): TileShape | null {
  const [own, setOwn] = useState(() => getTileOverride(key));
  useEffect(() => {
    const l = () => setOwn(getTileOverride(key));
    l();
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, [key]);
  return own;
}
