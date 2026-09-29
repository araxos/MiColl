import { Gem, Sparkles } from "lucide-react";
import type { SVGProps } from "react";
import { getAccent } from "@/lib/theme";
import {
  type ClassIcon,
  SharpHeartIcon,
  SharpStarIcon,
  SharpEyeIcon,
  SakuraBlossomIcon,
  SakuraBudIcon,
  PetalGemIcon,
  GemDiamondIcon,
  MinimalEyeIcon,
  CyberHeartIcon,
  CyberStarIcon,
  CyberDiamondIcon,
  CyberEyeIcon,
  CyberSparkIcon,
  IriHeartIcon,
  IriStarIcon,
  IriDiamondIcon,
  IriEyeIcon,
  IriSparkIcon,
} from "@/lib/classIcons";

export interface ArtistTagDef {
  key: string;
  label: string;
  /** Explanation of the class (shown in the tooltip). */
  desc: string;
  /** Lower rank = higher priority (heart = 1 ... new = 5). */
  rank: number;
  /** Tailwind text color for the icon. */
  color: string;
  Icon: React.ComponentType<SVGProps<SVGSVGElement>>;
}

/**
 * Artist "class" (a rank/marker), sorted from highest to lowest.
 * The keys are saved in the DB, so never change them, only labels/icons.
 */
const BASE_TAGS: ArtistTagDef[] = [
  { key: "heart", label: "Heart", desc: "Favourites", rank: 1, color: "text-rose-400", Icon: SharpHeartIcon },
  { key: "star", label: "Star", desc: "One of the best", rank: 2, color: "text-amber-300", Icon: SharpStarIcon },
  { key: "diamond", label: "Diamond", desc: "Never miss — good rewards", rank: 3, color: "text-sky-300", Icon: Gem },
  { key: "eye", label: "Eye", desc: "On watch — might delete", rank: 4, color: "text-violet-300", Icon: SharpEyeIcon },
  { key: "new", label: "New", desc: "New / upcoming artist", rank: 5, color: "text-emerald-300", Icon: Sparkles },
];

/**
 * Sakura icons are outline drawings, so ignore fill="currentColor" here
 * (otherwise they turn into solid blobs).
 */
const outlined = (Icon: ClassIcon): ClassIcon => {
  const Outlined: ClassIcon = (props) => <Icon {...props} fill="none" />;
  return Outlined;
};

/** Sakura skin: same classes and labels, only other icons/colors. */
const SAKURA_TAGS: ArtistTagDef[] = [
  { key: "heart", label: "Heart", desc: "Favourites", rank: 1, color: "text-pink-400", Icon: outlined(PetalGemIcon) },
  { key: "star", label: "Star", desc: "One of the best", rank: 2, color: "text-rose-300", Icon: outlined(SakuraBlossomIcon) },
  { key: "diamond", label: "Diamond", desc: "Never miss — good rewards", rank: 3, color: "text-pink-200", Icon: outlined(GemDiamondIcon) },
  { key: "eye", label: "Eye", desc: "On watch — might delete", rank: 4, color: "text-pink-200", Icon: outlined(MinimalEyeIcon) },
  { key: "new", label: "New", desc: "New / upcoming artist", rank: 5, color: "text-pink-200", Icon: outlined(SakuraBudIcon) },
];

/** Cyberpunk skin: pixel icons with their own colors (they ignore currentColor). */
const CYBER_TAGS: ArtistTagDef[] = [
  { key: "heart", label: "Heart", desc: "Favourites", rank: 1, color: "text-[#FCEE0A]", Icon: CyberHeartIcon },
  { key: "star", label: "Star", desc: "One of the best", rank: 2, color: "text-[#FCEE0A]", Icon: CyberStarIcon },
  { key: "diamond", label: "Diamond", desc: "Never miss — good rewards", rank: 3, color: "text-[#FCEE0A]", Icon: CyberDiamondIcon },
  { key: "eye", label: "Eye", desc: "On watch — might delete", rank: 4, color: "text-[#FCEE0A]", Icon: CyberEyeIcon },
  { key: "new", label: "New", desc: "New / upcoming artist", rank: 5, color: "text-[#FCEE0A]", Icon: CyberSparkIcon },
];

/** Iridescent skin: pastel jewel shapes. */
const IRID_TAGS: ArtistTagDef[] = [
  { key: "heart", label: "Heart", desc: "Favourites", rank: 1, color: "text-pink-300", Icon: IriHeartIcon },
  { key: "star", label: "Star", desc: "One of the best", rank: 2, color: "text-violet-300", Icon: IriStarIcon },
  { key: "diamond", label: "Diamond", desc: "Never miss — good rewards", rank: 3, color: "text-sky-300", Icon: IriDiamondIcon },
  { key: "eye", label: "Eye", desc: "On watch — might delete", rank: 4, color: "text-teal-200", Icon: IriEyeIcon },
  { key: "new", label: "New", desc: "New / upcoming artist", rank: 5, color: "text-emerald-200", Icon: IriSparkIcon },
];

/** The tag set for the current theme. */
export const artistTags = (): ArtistTagDef[] => {
  const accent = getAccent();
  if (accent === "sakura") return SAKURA_TAGS;
  if (accent === "cyberpunk") return CYBER_TAGS;
  if (accent === "iridescent") return IRID_TAGS;
  return BASE_TAGS;
};

export const tagDef = (key?: string | null): ArtistTagDef | undefined =>
  artistTags().find((t) => t.key === key);

/** Sort key: tagged artists first (by rank), then the rest. */
export const tagRank = (key?: string | null): number => tagDef(key)?.rank ?? 99;

/** A free tag that marks adult content. */
export const isNsfwTag = (t: string): boolean => t.trim().toLowerCase() === "nsfw";

/** Classes for the red NSFW chip (neon red on cyberpunk). */
export const nsfwChipColors = (accent: string): string =>
  accent === "cyberpunk"
    ? "border-[#ff1a4d] bg-[#ff0033]/20 text-[#ff5c7a] [text-shadow:0_0_8px_rgba(255,26,77,0.85)]"
    : "border-red-500/50 bg-red-500/15 text-red-300";
