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
import cpDataTear from "@/assets/wallpapers/cyber-01-data-tear.webp";
import cpRestricted from "@/assets/wallpapers/cyber-02-restricted.webp";
import cpHorizon from "@/assets/wallpapers/cyber-03-horizon.webp";
import cpCodeRain from "@/assets/wallpapers/cyber-04-code-rain.webp";
import type { CyberAnimatedId } from "@/components/CyberpunkAnimated";

/** Sakura pictures with a moving version (SakuraMoonPond). */
export type SakuraAnimatedId = "moon-pond";
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
  /** The moving version shown instead while "Animated background" is on
   *  (CyberpunkAnimated, SakuraMoonPond). Without one the picture stays still either way. */
  animated?: CyberAnimatedId | SakuraAnimatedId;
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

/** Cyberpunk's default, with the animation on as well as off (01 animates). */
export const CYBER_DEFAULT_WALLPAPER = "cp-data-tear";

/** Cyberpunk presets in menu order (the designs 01-04, WebP from the 2560x1440 PNGs). */
export const CYBER_WALLPAPERS: WallpaperPreset[] = [
  {
    id: "cp-data-tear",
    label: "Data tear",
    hint: "A yellow seam torn across the dark, red and cyan in the corners. Animated when the animated background is on.",
    url: cpDataTear,
    accent: "cyberpunk",
    animated: "data-tear",
  },
  {
    id: "cp-restricted",
    label: "Restricted",
    hint: "A yellow warning panel on the left, a red cut on the right.",
    url: cpRestricted,
    accent: "cyberpunk",
  },
  {
    id: "cp-horizon",
    label: "Horizon",
    hint: "A lit horizon over a yellow floor grid. Animated when the animated background is on.",
    url: cpHorizon,
    accent: "cyberpunk",
    animated: "horizon",
  },
  {
    id: "cp-code-rain",
    label: "Code rain",
    hint: "Columns of hex falling in cyan, yellow and red.",
    url: cpCodeRain,
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
    hint: "Still water at night, the moon mirrored in it and blossoms drifting in rings. Animated when the animated background is on.",
    url: moonPond,
    accent: "sakura",
    animated: "moon-pond",
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
