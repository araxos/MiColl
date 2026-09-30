/**
 * Built-in wallpapers of the premium themes (iridescent, cyberpunk, sakura).
 * Separate from wallpaper.ts because this file imports the images (Vite bundles them).
 * "shader" has no image, it's the captured shader frame (see iridSnapshot),
 * picking it just clears the wallpaper.
 */

import type { AccentKey } from "@/lib/theme";
import prismFold from "@/assets/wallpapers/iri-prism-fold.jpg";
import pearlDrift from "@/assets/wallpapers/iri-pearl-drift.svg";
import steelVeil from "@/assets/wallpapers/iri-steel-veil.svg";
import neonSkyline from "@/assets/wallpapers/cyber-neon-skyline.svg";
import circuitTrace from "@/assets/wallpapers/cyber-circuit-trace.svg";
import hazardLine from "@/assets/wallpapers/cyber-hazard-line.svg";
import toriiMist from "@/assets/wallpapers/sakura-torii-mist.svg";
import petalWind from "@/assets/wallpapers/sakura-petal-wind.svg";
import moonPond from "@/assets/wallpapers/sakura-moon-pond.svg";

export interface WallpaperPreset {
  /** Saved as preset:<id>. */
  id: string;
  label: string;
  /** Tooltip text. */
  hint: string;
  /** The image, or "" for the shader frame. */
  url: string;
  /** Which theme it belongs to (switching away removes it, see theme.ts). */
  accent: AccentKey;
}

/** What iridescent shows when nothing is chosen and the animated background is off. */
export const IRI_DEFAULT_WALLPAPER = "steel-veil";

/** Iridescent presets in menu order. */
export const IRI_WALLPAPERS: WallpaperPreset[] = [
  {
    id: "steel-veil",
    label: "Steel veil",
    hint: "Bands of light leaning across dark slate. The theme’s default still.",
    url: steelVeil,
    accent: "iridescent",
  },
  {
    id: "shader",
    label: "Shader still",
    hint: "A frame captured from the animated background — the theme's own look, held still.",
    url: "",
    accent: "iridescent",
  },
  {
    id: "pearl-drift",
    // SVG, only 4 KB and sharp at any size
    label: "Pearl drift",
    hint: "The theme’s own foil, held still — a pale pearl sheet with its four pastels drifting across it.",
    url: pearlDrift,
    accent: "iridescent",
  },
  {
    id: "prism-fold",
    label: "Prism fold",
    // JPEG made from the original 4.7 MB PNG (now 331 KB, looks the same)
    hint: "A pale fold of light across dark slate. Ships with MiColl — no file to keep on disk.",
    url: prismFold,
    accent: "iridescent",
  },
];

/** Cyberpunk's default: "grid-horizon" has no image, it's CyberpunkStill. */
export const CYBER_DEFAULT_WALLPAPER = "grid-horizon";

/** Cyberpunk presets in menu order (generated SVGs, dark and calm on the left). */
export const CYBER_WALLPAPERS: WallpaperPreset[] = [
  {
    id: "grid-horizon",
    label: "Grid horizon",
    hint: "The theme’s own still — a lit floor grid running to a slit sun.",
    url: "",
    accent: "cyberpunk",
  },
  {
    id: "neon-skyline",
    label: "Neon skyline",
    hint: "A city at night in the rain, its windows and two neon signs lit.",
    url: neonSkyline,
    accent: "cyberpunk",
  },
  {
    id: "circuit-trace",
    label: "Circuit trace",
    hint: "A board in the dark, three of its traces live.",
    url: circuitTrace,
    accent: "cyberpunk",
  },
  {
    id: "hazard-line",
    label: "Hazard line",
    hint: "Warning tape across one corner, a faint HUD panel across the other.",
    url: hazardLine,
    accent: "cyberpunk",
  },
];

/** Sakura's default: "blossom-branch" has no image, it's SakuraStill. */
export const SAKURA_DEFAULT_WALLPAPER = "blossom-branch";

/** Sakura presets in menu order (generated SVGs, dark and calm on the left). */
export const SAKURA_WALLPAPERS: WallpaperPreset[] = [
  {
    id: "blossom-branch",
    label: "Blossom branch",
    hint: "The theme’s own still — a branch in bloom with a few petals falling.",
    url: "",
    accent: "sakura",
  },
  {
    id: "torii-mist",
    label: "Torii mist",
    hint: "A vermilion torii before a pale sun, its posts fading into the mist.",
    url: toriiMist,
    accent: "sakura",
  },
  {
    id: "petal-wind",
    label: "Petal wind",
    hint: "A gust carrying petals and a few whole blossoms down from the top corner.",
    url: petalWind,
    accent: "sakura",
  },
  {
    id: "moon-pond",
    label: "Moon pond",
    hint: "Still water at night, the moon mirrored in it and blossoms drifting in rings.",
    url: moonPond,
    accent: "sakura",
  },
];

/** All built-ins of all themes (theme.ts checks against this). */
export const ALL_WALLPAPER_PRESETS: WallpaperPreset[] = [
  ...IRI_WALLPAPERS,
  ...CYBER_WALLPAPERS,
  ...SAKURA_WALLPAPERS,
];

export function findWallpaperPreset(id: string): WallpaperPreset | undefined {
  return ALL_WALLPAPER_PRESETS.find((p) => p.id === id);
}

/** A theme's presets and its default id (empty for themes without any). */
export function themeWallpapers(accent: AccentKey): { list: WallpaperPreset[]; fallback: string } {
  if (accent === "iridescent") return { list: IRI_WALLPAPERS, fallback: IRI_DEFAULT_WALLPAPER };
  if (accent === "cyberpunk") return { list: CYBER_WALLPAPERS, fallback: CYBER_DEFAULT_WALLPAPER };
  if (accent === "sakura") return { list: SAKURA_WALLPAPERS, fallback: SAKURA_DEFAULT_WALLPAPER };
  return { list: [], fallback: "" };
}
