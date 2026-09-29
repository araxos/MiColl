import { VenetianMask, Palette, Clapperboard, Camera, Crown, Drama, Shapes, type LucideIcon } from "lucide-react";

/** Creator type / role. Saved as a string on the artist (kind), these are the options. */
export interface CreatorTypeDef {
  key: string;
  label: string;
  /** Tailwind text color for the icon. */
  color: string;
  Icon: LucideIcon;
}

/**
 * Sorted A-Z by the English label, every type list in the app uses this order.
 * (Not the translated label, otherwise the order would change with the language.)
 */
export const CREATOR_TYPES: CreatorTypeDef[] = [
  { key: "Animator", label: "Animator", color: "text-violet-300", Icon: Clapperboard },
  { key: "Artist", label: "Artist", color: "text-sky-300", Icon: Palette },
  // crown instead of star, the star is already used by the classes
  { key: "Celeb", label: "Celeb", color: "text-fuchsia-300", Icon: Crown },
  { key: "Character", label: "Character", color: "text-emerald-300", Icon: Drama },
  { key: "Cosplayer", label: "Cosplayer", color: "text-pink-300", Icon: VenetianMask },
  { key: "Model", label: "Model", color: "text-amber-300", Icon: Camera },
  { key: "Other", label: "Other", color: "text-zinc-300", Icon: Shapes },
];

export const creatorTypeDef = (key?: string | null): CreatorTypeDef | undefined =>
  // old "Artist-Animator" value counts as "Artist"
  CREATOR_TYPES.find((t) => t.key === key) ??
  (key === "Artist-Animator" ? CREATOR_TYPES.find((t) => t.key === "Artist") : undefined);

/** kind can have several types (comma separated), parse them to keys. */
export const parseKinds = (kind?: string | null): string[] =>
  (kind ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

/** Turn an artist's kind string into its type list (no duplicates, A-Z order). */
export const creatorTypeDefs = (kind?: string | null): CreatorTypeDef[] => {
  const keys = new Set<string>();
  for (const k of parseKinds(kind)) {
    const def = creatorTypeDef(k);
    if (def) keys.add(def.key);
  }
  return CREATOR_TYPES.filter((d) => keys.has(d.key));
};
