/**
 * Data types for MiColl. They match the SQLite schema so mock data and real data
 * look the same.
 */

/** How a reward's ownership is tracked in a month. */
export type RewardStatus = "owned" | "missing" | "skipped";

export interface RewardImage {
  id: string;
  /** Full size src (asset URL in Tauri, "" in the browser). */
  src: string;
  /**
   * Path of the ORIGINAL file. Used as key for all file actions
   * (favourite, cover, rename, delete, versions). Doesn't change with edit versions.
   */
  path: string;
  /** The path that's shown: the active edit version, otherwise same as path. */
  displayPath?: string;
  /** Number of edit versions (0 = only the original). */
  versionCount?: number;
  /** True when the original is shown (no version selected). */
  onOriginal?: boolean;
  /** Name inside the reward folder, e.g. "01a.jpg" or "00Step_by_Step/01.jpg". */
  name: string;
  /**
   * "video" = playable clip, "image" = picture (also GIF),
   * "archive" = everything else (zip, psd, pdf...), opens in Explorer.
   */
  kind: "image" | "video" | "archive";
  /** Marked as a favourite wallpaper. */
  favWallpaper?: boolean;
  /** In the artist's "Favourites" collection. */
  favorite?: boolean;
  /** Ids of the user collections this file is in. */
  collections?: string[];
}

/**
 * A user collection (the "+" tabs next to Favourites). Global, so one collection
 * can have files from several creators, each page shows its own part.
 */
export interface Collection {
  id: string;
  name: string;
}

/** Another creator credited on a reward (collab). */
export interface CollabRef {
  artistId: string;
  artistName: string;
}

export interface Reward {
  id: string;
  /** Title = the reward folder name. */
  title: string;
  /** Optional category inside a month (e.g. "Extra"). */
  category?: string | null;
  /** Folder path on disk (empty in the prototype). */
  folderPath?: string;
  /** Cover src (first image), or "" for a gradient. */
  cover: string;
  /**
   * True only if the user picked the cover (the indexer sets cover automatically).
   * Needed for "Reset cover".
   */
  coverCustom?: boolean;
  /**
   * Number of media files. Always there (from the DB), images are loaded later per artist.
   */
  imageCount: number;
  /** All images of the reward. Empty until the artist's images are loaded. */
  images: RewardImage[];
  /** owned = have it, missing = released but not bought, skipped = passed on purpose. */
  status: RewardStatus;
  /**
   * True if the files are directly in the month folder (no subfolder).
   * A month with only one root reward opens straight into the viewer.
   */
  isRoot?: boolean;
  /**
   * An extra (sketches, PSDs, wallpaper pack...) next to the real rewards.
   * Stays in the month but isn't used for the card mosaic.
   */
  isExtra?: boolean;
  /** Added but never opened -> shows the "new" badge. Cleared when the viewer opens it. */
  fresh?: boolean;
  /** The user put this on the wishlist (template "missing" rewards don't count). */
  wished?: boolean;
  /**
   * This row only exists because of the wish, removing it from the wishlist deletes it.
   * False if a template has the same reward.
   */
  wishOnly?: boolean;
  /** MiSD: queued for the next move to the external disk. */
  sdMarked?: boolean;
  /**
   * MiSD: disk label if the files are on the external disk.
   * Still shows as a card, opening it needs the disk.
   */
  sdVolume?: string | null;
  /** MiSD: queued for the next backup (copy, local files stay). */
  sdBackupMarked?: boolean;
  /**
   * MiSD: disk label if there's a backup copy on the disk. Local files are still here,
   * so this doesn't block anything (all guards check sdVolume only).
   */
  sdBackup?: string | null;
  /** MiSD: date of the backup (YYYY-MM-DD) for the tooltip. */
  sdBackupAt?: string | null;
  /**
   * Only on a BORROWED copy in a collaborator's card: the creator who really owns it.
   * Borrowed rewards are only shown, never counted, edited or deleted.
   */
  collabFrom?: CollabRef | null;
  /**
   * Other creators this reward is credited to. On the owner's tile and the borrowed copy.
   */
  collabWith?: CollabRef[];
}

/**
 * How a creator releases: monthly (year/month), numbered (#51, no dates),
 * or none (no schedule, one bucket per platform).
 */
export type ReleaseStyle = "monthly" | "numbered" | "none";

export interface Month {
  id: string;
  /** Month 1-12, or null for "Misc". */
  month: number | null;
  /** Year like 2025, or null for "Misc". */
  year: number | null;
  /** Drop number for numbered creators ("#51"), null otherwise. */
  number?: number | null;
  /** Folder label like "01.25" or "Misc" (a span shows as "2025-03-04"). */
  label: string;
  /** How many months this covers (1 = normal, 2 = e.g. Mar-Apr). */
  span: number;
  /** Artist took a break this month (shown as "Break", not counted). */
  skipped: boolean;
  /** Verified by an active template. */
  verified: boolean;
  /** Preview image path (empty in the prototype). */
  previewPath: string;
  /** Month cover picked by the user or a template. null = mosaic of the reward covers. */
  coverImage: string | null;
  /**
   * Official total released that month (from a template). null = unknown,
   * so no completion % is shown.
   */
  officialTotal: number | null;
  /** Always open the reward overview instead of jumping into the viewer (set at import). */
  openAsCards?: boolean;
  /**
   * Fake period that only holds borrowed collab rewards (negative id, not in the DB).
   * Never send it to the backend.
   */
  collabOnly?: boolean;
  rewards: Reward[];
  /** Platform of this period, null until confirmed. */
  platform?: string | null;
  /** Platform couldn't be detected, the user needs to confirm it. */
  needsReview?: boolean;
}

export interface Platform {
  id: string;
  /** Patreon, Ko-Fi, Gumroad, ... */
  name: string;
  months: Month[];
  /** Some period on this platform is template verified. */
  verified?: boolean;
  /** Platform posts without dates (= releaseStyle "none"). */
  noDates?: boolean;
  /** Release style of this platform (override or the artist default). */
  releaseStyle?: ReleaseStyle;
}

export interface ArtistLink {
  label: string;
  url: string;
}

export interface Artist {
  id: string;
  name: string;
  /** Preview image path, empty = gradient. */
  previewPath: string;
  /**
   * The next few reward covers, used if previewPath can't load (deleted, or on an
   * unplugged MiSD disk).
   */
  previewAlts?: string[];
  /** Artist posts without dates (= releaseStyle "none"). */
  noDates?: boolean;
  /** How this creator releases (platforms can override it). */
  releaseStyle?: ReleaseStyle;
  /** Class marker: "heart" | "star" | "diamond" | "eye" | "new" | null. */
  tag?: string | null;
  /** Free tags (nsfw/sfw, character names...). */
  tags?: string[];
  /** Other names of this creator (old handles etc). Search finds these too. */
  aliases?: string[];
  /** Creator type: "Cosplayer" | "Artist" | "Animator" | "Model" | null. */
  kind?: string | null;
  /** Social media links. */
  links?: ArtistLink[];
  /** User notes (shown in the details panel). */
  notes?: string;
  /** An official template is applied (blue "Verified" badge, completion % is exact). */
  verified?: boolean;
  /** Hidden from the dashboard. Nothing is deleted, search still finds it. */
  hidden?: boolean;
  /** In the graveyard: only shown when the graveyard is open. */
  graveyard?: boolean;
  /** A self-made (not verified) template is applied ("Personal log"). */
  personalLog?: boolean;
  /** When the content was last changed (ISO string). */
  updatedAt?: string;
  /** "Wallpaper favourites" is on (per-image mark + virtual "Fav. Wallpaper" folder). */
  wallpaperFav?: boolean;
  platforms: Platform[];
}

/* ---- Derived helpers ------------------------------------------------- */

/** A borrowed collab reward (another creator's, only shown here). */
export const isBorrowed = (r: Reward): boolean => !!r.collabFrom;

/**
 * The period's own rewards without borrowed collabs.
 * Use this for every count/total/bulk action, borrowed ones must not count twice.
 */
export const ownRewards = (m: Month): Reward[] => m.rewards.filter((r) => !isBorrowed(r));

/** A fake (collab-only) period id, not valid for the backend. */
export const isVirtualMonthId = (id: string): boolean => Number(id) < 0;

export function monthOwnedCount(m: Month): number {
  return m.rewards.filter((r) => !isBorrowed(r) && r.status === "owned").length;
}

export type Completeness = "complete" | "partial" | "empty" | "skipped";

export function monthCompleteness(m: Month): Completeness {
  if (m.skipped) return "skipped";
  const owned = monthOwnedCount(m);
  // "complete" only makes sense with a template's count
  if (m.officialTotal != null && m.officialTotal > 0 && owned >= m.officialTotal) return "complete";
  if (owned > 0) return "partial";
  return "empty";
}

export interface PlatformStats {
  ownedRewards: number;
  totalRewards: number;
  months: number;
  /** True if at least one period has an official total (then the ratio is shown). */
  tracked: boolean;
}

export function platformStats(p: Platform): PlatformStats {
  let owned = 0;
  let total = 0;
  let months = 0;
  let tracked = false;
  for (const m of p.months) {
    if (m.collabOnly) continue; // a collab-only month isn't this creator's month
    if (m.skipped) continue; // a break doesn't count toward completion
    owned += monthOwnedCount(m);
    if (m.officialTotal != null) {
      total += m.officialTotal;
      tracked = true;
    }
    months += 1;
  }
  return { ownedRewards: owned, totalRewards: total, months, tracked };
}
