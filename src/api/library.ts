/**
 * Typed wrappers for the Rust commands, plus an adapter that turns the backend's
 * Artist -> Period -> Reward -> Image into the UI's Artist -> Platform -> Month -> Reward
 * (periods grouped by platform).
 */
import { invoke, fileUrl } from "@/lib/tauri";
import type {
  Artist,
  ArtistLink,
  CollabRef,
  Month,
  Platform,
  ReleaseStyle,
  Reward,
  RewardImage,
  Collection,
} from "@/types";

/* ---- backend types (serde already camelCases the fields) ---- */

interface BImage {
  id: number;
  filePath: string;
  displayPath: string;
  versionCount: number;
  onOriginal: boolean;
  relName: string;
  favWallpaper: boolean;
  favorite: boolean;
  collections: number[];
}
interface BReward {
  id: number;
  title: string;
  category: string | null;
  folderPath: string;
  coverImage: string | null;
  coverCustom: boolean;
  status: string;
  isRoot: boolean;
  isExtra: boolean;
  imageCount: number;
  sdMarked: boolean;
  sdVolume: string | null;
  sdBackupMarked: boolean;
  sdBackup: string | null;
  sdBackupAt: string | null;
  fresh: boolean;
  /** 0 = no, 1 = wished and ours to delete, 2 = wished but the row is a template's. */
  wished: number;
  collabFrom: BCollab | null;
  collabWith: BCollab[];
  images: BImage[];
}
interface BCollab {
  artistId: number;
  artistName: string;
}
interface BRewardImages {
  rewardId: number;
  images: BImage[];
}
interface BPeriod {
  id: number;
  platform: string | null;
  year: number | null;
  month: number | null;
  number: number | null;
  span: number;
  label: string;
  folderPath: string;
  needsReview: boolean;
  skipped: boolean;
  verified: boolean;
  previewImage: string | null;
  officialTotal: number | null;
  openAsCards: boolean;
  collabOnly: boolean;
  rewards: BReward[];
}
interface BArtist {
  id: number;
  name: string;
  previewImage: string | null;
  noDates: boolean;
  /** Platform names that are effectively date-less (per-platform override or default). */
  noDatesPlatforms: string[];
  /** Artist-level release style: "monthly" | "numbered" | "none". */
  releaseStyle: string;
  /** Effective release style per platform (override, else the artist default). */
  platformStyles: { platform: string; style: string }[];
  tag: string | null;
  tags: string | null;
  aliases: string | null;
  links: string | null;
  notes: string | null;
  kind: string | null;
  templateSource: string | null;
  templateVerified: boolean;
  updatedAt: string | null;
  wallpaperFav: boolean;
  hidden: boolean;
  graveyard: boolean;
  periods: BPeriod[];
}

export interface RootDto {
  id: number;
  path: string;
  label: string | null;
  defaultPlatform: string | null;
}

export interface ScanSummary {
  artists: number;
  periods: number;
  rewards: number;
  images: number;
  needsReview: number;
}

export interface OrganizeSummary {
  moved: number;
  skipped: number;
  failed: number;
  errors: string[];
}

export interface DetectedReward {
  key: string;
  artist: string;
  platform: string | null;
  year: number | null;
  month: number | null;
  /** Drop number when this reward sits in a numbered-drops level ("#51"/51..55 run). */
  number: number | null;
  category: string | null;
  title: string;
  folder: string;
  cover: string | null;
  imageCount: number;
  /**
   * The analyzer says this folder IS its period (loose files), so the files go
   * straight into the month folder without a reward subfolder.
   */
  root: boolean;
}

/** Analyzer's per-creator release-style proposal (pre-selects the review UI). */
export interface ArtistProposal {
  name: string;
  proposedStyle: ReleaseStyle;
}

export interface ImportPlan {
  multiArtist: boolean;
  rewards: DetectedReward[];
  artists: ArtistProposal[];
}

export interface ResolvedReward {
  artist: string;
  platform: string | null;
  year: number | null;
  month: number | null;
  /** Drop number for numbered-release creators (period "#51"); null otherwise. */
  number?: number | null;
  category: string | null;
  title: string;
  folder: string;
  /** Drop the named reward folder — files go straight into the month folder. */
  root?: boolean;
}

/** A release style choice from the import review (whole artist, or one platform if set). */
export interface StyleChoice {
  artist: string;
  style: ReleaseStyle;
  platform?: string | null;
}

/* ---- adapters -------------------------------------------------------- */

const UNSORTED = "Unsorted";

const VIDEO_RE = /\.(mp4|webm|mov|m4v|mkv|avi|wmv|flv)$/i;
// same list as IMAGE_EXTS in indexer.rs
const IMAGE_RE = /\.(jpe?g|jfif|png|gif|webp|bmp|avif|tiff?)$/i;
/**
 * File kind by extension. GIFs are "image". Everything we can't show
 * (archives, PSD, PDF...) is "archive" (file tile, opens in Explorer).
 */
function mediaKind(path: string): "image" | "video" | "archive" {
  if (VIDEO_RE.test(path)) return "video";
  return IMAGE_RE.test(path) ? "image" : "archive";
}

/** Backend image row -> UI RewardImage. */
function mapImage(im: BImage): RewardImage {
  const display = im.displayPath || im.filePath;
  return {
    id: String(im.id),
    // the shown image is the active version (or the original)
    src: fileUrl(display),
    // path stays the ORIGINAL (key for favourite/cover/rename/versions)
    path: im.filePath,
    displayPath: display,
    versionCount: im.versionCount ?? 0,
    onOriginal: im.onOriginal ?? true,
    name: im.relName,
    // kind comes from the original's extension
    kind: mediaKind(im.filePath),
    favWallpaper: im.favWallpaper,
    favorite: im.favorite,
    collections: (im.collections ?? []).map(String),
  };
}

const mapCollab = (c: BCollab): CollabRef => ({
  artistId: String(c.artistId),
  artistName: c.artistName,
});

function mapReward(r: BReward): Reward {
  return {
    id: String(r.id),
    title: r.title,
    category: r.category,
    folderPath: r.folderPath,
    // raw path, <Cover> loads the thumbnail
    cover: r.coverImage ?? "",
    coverCustom: !!r.coverCustom,
    status: (r.status as Reward["status"]) ?? "owned",
    isRoot: !!r.isRoot,
    isExtra: !!r.isExtra,
    sdMarked: !!r.sdMarked,
    sdVolume: r.sdVolume ?? null,
    sdBackupMarked: !!r.sdBackupMarked,
    sdBackup: r.sdBackup ?? null,
    sdBackupAt: r.sdBackupAt ?? null,
    fresh: !!r.fresh,
    wished: (r.wished ?? 0) > 0,
    wishOnly: r.wished === 1,
    collabFrom: r.collabFrom ? mapCollab(r.collabFrom) : null,
    collabWith: (r.collabWith ?? []).map(mapCollab),
    // count is always there, the image list is loaded per artist later
    imageCount: r.imageCount ?? r.images.length,
    // full size URLs for the viewer + raw paths for the filmstrip
    images: r.images.map(mapImage),
  };
}

/**
 * Label for a multi-month span, e.g. "2025-03-04" or "2025-12 -> 2026-01".
 * Single months keep "YYYY-MM" / "Misc".
 */
function spanLabel(year: number | null, month: number | null, span: number, base: string): string {
  if (span <= 1 || year == null || month == null) return base;
  let ey = year;
  let em = month + span - 1;
  while (em > 12) {
    em -= 12;
    ey += 1;
  }
  const pad = (n: number) => String(n).padStart(2, "0");
  return ey === year ? `${base}–${pad(em)}` : `${base} → ${ey}-${pad(em)}`;
}

function mapPeriodToMonth(p: BPeriod): Month {
  const rewards = p.rewards.map(mapReward);
  const span = p.span > 1 ? p.span : 1;
  return {
    id: String(p.id),
    year: p.year,
    month: p.month,
    number: p.number ?? null,
    label: spanLabel(p.year, p.month, span, p.label),
    span,
    skipped: !!p.skipped,
    verified: !!p.verified,
    // the user's month preview, else the first reward cover
    previewPath: p.previewImage || rewards.find((r) => r.cover)?.cover || "",
    // only an explicit period cover, null = mosaic
    coverImage: p.previewImage || null,
    // official count only from a template, null = untracked (no ratio shown)
    officialTotal: p.officialTotal ?? null,
    openAsCards: !!p.openAsCards,
    collabOnly: !!p.collabOnly,
    rewards,
    platform: p.platform,
    needsReview: p.needsReview,
  };
}

function mapArtist(a: BArtist): Artist {
  // group periods by platform
  const byPlatform = new Map<string, Month[]>();
  for (const p of a.periods) {
    const key = p.platform ?? UNSORTED;
    const arr = byPlatform.get(key) ?? [];
    arr.push(mapPeriodToMonth(p));
    byPlatform.set(key, arr);
  }
  const styleMap = new Map((a.platformStyles ?? []).map((s) => [s.platform, s.style]));
  const artistStyle = (a.releaseStyle ?? (a.noDates ? "none" : "monthly")) as ReleaseStyle;
  const platforms: Platform[] = [...byPlatform.entries()].map(([name, months], i) => {
    const releaseStyle = (styleMap.get(name) ?? artistStyle) as ReleaseStyle;
    return {
      id: `${a.id}-${i}`,
      name,
      months,
      verified: months.some((m) => m.verified),
      noDates: releaseStyle === "none",
      releaseStyle,
    };
  });

  // preview: the chosen one, else the reward covers in order (no borrowed collabs).
  // A LIST so the card can skip a cover that doesn't load (deleted, MiSD unplugged).
  // Capped because it's sent for every artist.
  const covers = platforms
    .flatMap((p) => p.months)
    .flatMap((m) => m.rewards)
    .filter((r) => !r.collabFrom && r.cover)
    .map((r) => r.cover);
  const previewCandidates = [...new Set([a.previewImage || "", ...covers].filter(Boolean))].slice(
    0,
    8,
  );
  const firstCover = previewCandidates[0] ?? "";

  let links: ArtistLink[] = [];
  if (a.links) {
    try {
      const parsed = JSON.parse(a.links);
      if (Array.isArray(parsed)) {
        links = parsed.filter((l) => l && typeof l.url === "string");
      }
    } catch {
      links = [];
    }
  }

  let tags: string[] = [];
  if (a.tags) {
    try {
      const parsed = JSON.parse(a.tags);
      if (Array.isArray(parsed)) tags = parsed.filter((t): t is string => typeof t === "string");
    } catch {
      tags = [];
    }
  }

  let aliases: string[] = [];
  if (a.aliases) {
    try {
      const parsed = JSON.parse(a.aliases);
      if (Array.isArray(parsed)) aliases = parsed.filter((t): t is string => typeof t === "string");
    } catch {
      aliases = [];
    }
  }

  return {
    id: String(a.id),
    name: a.name,
    previewPath: firstCover,
    previewAlts: previewCandidates.slice(1),
    noDates: a.noDates,
    releaseStyle: artistStyle,
    tag: a.tag,
    tags,
    aliases,
    links,
    notes: a.notes ?? undefined,
    kind: a.kind,
    // verified per period, the artist shows the badge if any period is verified.
    // A template without verified periods is a personal log.
    verified: platforms.some((p) => p.verified),
    personalLog: !!a.templateSource && !platforms.some((p) => p.verified),
    updatedAt: a.updatedAt ?? undefined,
    wallpaperFav: a.wallpaperFav,
    hidden: !!a.hidden,
    graveyard: !!a.graveyard,
    platforms,
  };
}

/* ---- commands ---- */

export async function getLibrary(): Promise<Artist[]> {
  const data = await invoke<BArtist[]>("get_library");
  return data.map(mapArtist);
}

/** Load one artist's images, grouped by reward id. The library loads without images. */
export async function artistImages(artistId: string): Promise<Map<string, RewardImage[]>> {
  const rows = await invoke<BRewardImages[]>("artist_images", { artistId: Number(artistId) });
  const map = new Map<string, RewardImage[]>();
  for (const row of rows) {
    map.set(String(row.rewardId), row.images.map(mapImage));
  }
  return map;
}

export async function listRoots(): Promise<RootDto[]> {
  return invoke<RootDto[]>("list_roots");
}

export async function addRoot(
  path: string,
  platform: string | null,
  label?: string,
): Promise<ScanSummary> {
  return invoke<ScanSummary>("add_root", { path, platform, label: label ?? null });
}

export async function removeRoot(id: number): Promise<void> {
  await invoke("remove_root", { id });
}

export async function clearLibrary(): Promise<void> {
  await invoke("clear_library");
}

export async function clearRoots(): Promise<void> {
  await invoke("clear_roots");
}

export async function rescan(): Promise<ScanSummary> {
  return invoke<ScanSummary>("rescan");
}

/** Managed mode: re-index every artist folder under the collection's MiColl folder. */
export async function rescanCollection(): Promise<ScanSummary> {
  return invoke<ScanSummary>("rescan_collection");
}

/** Re-index ONE creator — what F5 does from inside a creator page. */
export async function rescanArtist(artistId: string): Promise<ScanSummary> {
  return invoke<ScanSummary>("rescan_artist", { artistId: Number(artistId) });
}

export async function setRewardStatus(rewardId: string, status: string): Promise<void> {
  await invoke("set_reward_status", { rewardId: Number(rewardId), status });
}

/**
 * Credit a reward to collab creators (replaces the whole list, empty clears it).
 * Nothing moves on disk, the partners just show a read-only copy.
 */
export async function setRewardCollabs(rewardId: string, artistIds: string[]): Promise<void> {
  await invoke("set_reward_collabs", {
    rewardId: Number(rewardId),
    artistIds: artistIds.map(Number),
  });
}

/** Remove collab links whose folder is gone (never rewards or files). */
export async function clearBrokenCollabs(): Promise<number> {
  return (await invoke("clear_broken_collabs")) as number;
}

/** The waiting taskbar action ("add-rewards" from the jump list), once. */
export async function takeLaunchAction(): Promise<string | null> {
  return (await invoke<string | null>("take_launch_action")) ?? null;
}

export async function setPeriodPlatform(periodId: string, platform: string): Promise<void> {
  await invoke("set_period_platform", { periodId: Number(periodId), platform });
}

export async function setArtistNoDates(artistId: string, noDates: boolean): Promise<void> {
  await invoke("set_artist_no_dates", { artistId: Number(artistId), noDates });
}

/** Toggle "posts without dates" for a single platform (overrides the artist default). */
export async function setPlatformNoDates(
  artistId: string,
  platform: string,
  noDates: boolean,
): Promise<void> {
  await invoke("set_platform_no_dates", { artistId: Number(artistId), platform, noDates });
}

/** Set how a creator releases: monthly / numbered drops / no schedule. */
export async function setArtistReleaseStyle(artistId: string, style: ReleaseStyle): Promise<void> {
  await invoke("set_artist_release_style", { artistId: Number(artistId), style });
}

/** Per-platform release-style override (overrides the artist default). */
export async function setPlatformReleaseStyle(
  artistId: string,
  platform: string,
  style: ReleaseStyle,
): Promise<void> {
  await invoke("set_platform_release_style", { artistId: Number(artistId), platform, style });
}

/** Set how many consecutive months a period covers (multi-month reward). */
export async function setPeriodSpan(periodId: string, span: number): Promise<void> {
  await invoke("set_period_span", { periodId: Number(periodId), span });
}

/** Mark/unmark a month as an artist break (writes/removes the on-disk marker). */
export async function setPeriodSkipped(periodId: string, skipped: boolean): Promise<void> {
  await invoke("set_period_skipped", { periodId: Number(periodId), skipped });
}

/** Open a period's (month's) folder in the file manager — works for empty breaks. */
export async function revealPeriod(periodId: string): Promise<void> {
  await invoke("reveal_period", { periodId: Number(periodId) });
}

/** Delete a whole period (a skipped break or empty month), optionally with files. */
export async function deletePeriod(periodId: string, alsoFiles: boolean): Promise<void> {
  await invoke("delete_period", { periodId: Number(periodId), alsoFiles });
}

/** Create a new skipped month (folder + marker + DB period) for an artist/platform. */
export async function addSkippedPeriod(
  artistId: string,
  platform: string | null,
  year: number | null,
  month: number | null,
): Promise<void> {
  await invoke("add_skipped_period", { artistId: Number(artistId), platform, year, month });
}

/** Set (or clear, with "") an artist's card preview image (raw absolute path). */
export async function setArtistPreview(artistId: string, image: string): Promise<void> {
  await invoke("set_artist_preview", { artistId: Number(artistId), image });
}

/** Covers whose file is gone go back to the automatic image, returns how many. */
export async function resetMissingCovers(): Promise<number> {
  return invoke<number>("reset_missing_covers");
}

/** Set (or clear, with "") a reward's cover image (raw absolute path). */
export async function setRewardCover(rewardId: string, image: string): Promise<void> {
  await invoke("set_reward_cover", { rewardId: Number(rewardId), image });
}

/** Set (or clear, with "") a month/period preview image (raw absolute path). */
export async function setPeriodPreview(periodId: string, image: string): Promise<void> {
  await invoke("set_period_preview", { periodId: Number(periodId), image });
}

/** Total on-disk size of all indexed images, in bytes. */
export async function librarySize(): Promise<number> {
  return invoke<number>("library_size");
}

export interface DuplicateImage {
  id: string;
  path: string;
  name: string;
  reward: string;
  artist: string;
  bytes: number;
  width: number;
  height: number;
}

/** Find groups of byte-identical images, optionally scoped to an artist/platform/period. */
/**
 * similar: true matches by appearance instead of bytes (finds resized copies).
 * Slower and can be wrong, so only on purpose.
 */
export async function findDuplicates(
  scope?: {
    artistId?: number;
    platform?: string;
    periodId?: number;
    rewardId?: number;
  },
  similar?: boolean,
): Promise<DuplicateImage[][]> {
  return invoke<DuplicateImage[][]>("find_duplicates", {
    artistId: scope?.artistId ?? null,
    platform: scope?.platform ?? null,
    periodId: scope?.periodId ?? null,
    rewardId: scope?.rewardId ?? null,
    similar: similar ?? false,
  });
}

export interface ArtistStorage {
  id: string;
  name: string;
  bytes: number;
  files: number;
}

/** On-disk size per artist (bytes + file count), largest first. */
export async function storageBreakdown(): Promise<ArtistStorage[]> {
  return invoke<ArtistStorage[]>("storage_breakdown");
}

export interface RenameItem {
  id: string;
  /** New base name (folder name for rewards; file stem for images — ext kept). */
  name: string;
}

/** Rename reward folders on disk (and update the DB). Collision-safe in bulk. */
export async function renameRewards(items: RenameItem[]): Promise<void> {
  await invoke("rename_rewards", { items: items.map((i) => ({ id: Number(i.id), name: i.name })) });
}

/** Rename image files on disk, preserving each file's extension. */
export async function renameImages(items: RenameItem[]): Promise<void> {
  await invoke("rename_images", { items: items.map((i) => ({ id: Number(i.id), name: i.name })) });
}

export async function setArtistTag(artistId: string, tag: string | null): Promise<void> {
  await invoke("set_artist_tag", { artistId: Number(artistId), tag });
}

/** Set an artist's freeform tags (nsfw/sfw, characters, …). */
export async function setArtistTags(artistId: string, tags: string[]): Promise<void> {
  await invoke("set_artist_tags", { artistId: Number(artistId), tags: JSON.stringify(tags) });
}

/** Clear a reward's "new" badge — sent the first time its viewer opens. */
export async function markRewardSeen(rewardId: string): Promise<void> {
  await invoke("mark_reward_seen", { rewardId: Number(rewardId) });
}

/** Clear every "new" badge at once. Returns how many were cleared. */
export async function markAllRewardsSeen(): Promise<number> {
  return invoke<number>("mark_all_rewards_seen");
}

export async function setArtistAliases(artistId: string, aliases: string[]): Promise<void> {
  await invoke("set_artist_aliases", { artistId: Number(artistId), aliases: JSON.stringify(aliases) });
}

export async function setArtistLinks(artistId: string, links: ArtistLink[]): Promise<void> {
  await invoke("set_artist_links", { artistId: Number(artistId), links: JSON.stringify(links) });
}

/** Set (or clear, with empty/null) an artist's freeform notes. */
export async function setArtistNotes(artistId: string, notes: string | null): Promise<void> {
  await invoke("set_artist_notes", { artistId: Number(artistId), notes });
}

/** Set (or clear, with null) an artist's creator type/role. */
export async function setArtistKind(artistId: string, kind: string | null): Promise<void> {
  await invoke("set_artist_kind", { artistId: Number(artistId), kind });
}

export async function setWallpaper(path: string): Promise<void> {
  await invoke("set_wallpaper", { path });
}

/** How a desktop slideshow picture is laid on the screen (Windows' own names). */
export type SlideshowFit = "fill" | "fit" | "stretch";

/**
 * The desktop slideshow settings (right-click a collection's wallpaper button).
 * Used by every "set as slideshow".
 */
export interface SlideshowSettings {
  /** Minutes between pictures. */
  minutes: number;
  fit: SlideshowFit;
  shuffle: boolean;
}

/** The old behavior before there were settings. */
export const DEFAULT_SLIDESHOW: SlideshowSettings = { minutes: 10, fit: "fill", shuffle: true };

const SLIDESHOW_KEY = "wallpaper_slideshow";

/**
 * The saved settings, each field checked on its own (a bad one falls back to its default).
 */
export async function getSlideshowSettings(): Promise<SlideshowSettings> {
  let raw: Partial<SlideshowSettings> = {};
  try {
    raw = JSON.parse((await getSetting(SLIDESHOW_KEY)) ?? "{}") ?? {};
  } catch {
    /* unreadable -> defaults */
  }
  const minutes = Number(raw.minutes);
  return {
    minutes:
      Number.isInteger(minutes) && minutes >= 1 && minutes <= 1440 ? minutes : DEFAULT_SLIDESHOW.minutes,
    fit: raw.fit === "fit" || raw.fit === "stretch" || raw.fit === "fill" ? raw.fit : DEFAULT_SLIDESHOW.fit,
    shuffle: typeof raw.shuffle === "boolean" ? raw.shuffle : DEFAULT_SLIDESHOW.shuffle,
  };
}

export async function saveSlideshowSettings(s: SlideshowSettings): Promise<void> {
  await setSetting(SLIDESHOW_KEY, JSON.stringify(s));
}

/** Set a desktop slideshow from image files, with the user's settings. */
export async function setWallpaperSlideshow(paths: string[]): Promise<void> {
  const s = await getSlideshowSettings().catch(() => DEFAULT_SLIDESHOW);
  await invoke("set_wallpaper_slideshow", {
    paths,
    intervalMinutes: s.minutes,
    position: s.fit,
    shuffle: s.shuffle,
  });
}

/** Enable/disable "Wallpaper favourites" for an artist. */
export async function setArtistWallpaperFav(artistId: string, on: boolean): Promise<void> {
  await invoke("set_artist_wallpaper_fav", { artistId: Number(artistId), on });
}

/**
 * One creator's size on disk (measured in the backend). missing = files that
 * couldn't be read (deleted or on an unplugged disk).
 */
export interface ArtistSize {
  bytes: number;
  files: number;
  missing: number;
  /** Epoch millis of the newest file, 0 when nothing could be read. */
  modified: number;
}

export async function artistSize(artistId: string): Promise<ArtistSize> {
  return invoke<ArtistSize>("artist_size", { artistId: Number(artistId) });
}

/** What one creator weighs, in the library-wide sweep. */
export interface ArtistBytes {
  artistId: number;
  bytes: number;
  files: number;
}

/**
 * Every creator's size in one pass, for the "Size" sort (same measure as artistSize).
 * One stat per file, so only while that sort is on.
 */
export async function librarySizes(): Promise<ArtistBytes[]> {
  return invoke<ArtistBytes[]>("library_sizes");
}

/** Hide a creator's card from the dashboard, or bring it back. Nothing is deleted. */
export async function setArtistHidden(artistId: string, hidden: boolean): Promise<void> {
  await invoke("set_artist_hidden", { artistId: Number(artistId), hidden });
}

/** Move a creator into the graveyard, or bring them back. Nothing is deleted. */
export async function setArtistGraveyard(artistId: string, on: boolean): Promise<void> {
  await invoke("set_artist_graveyard", { artistId: Number(artistId), on });
}

/** Mark/unmark a single image (by path) as a favourite wallpaper. */
export async function setImageWallpaperFav(path: string, fav: boolean): Promise<void> {
  await invoke("set_image_wallpaper_fav", { path, fav });
}

/** Add/remove a single item (by path) to the general Favourites collection. */
export async function setImageFavorite(path: string, fav: boolean): Promise<void> {
  await invoke("set_image_favorite", { path, fav });
}

/* ---- User-made collections (the "+" tabs on a creator's page) ------------- */

export async function listCollections(): Promise<Collection[]> {
  const rows = await invoke<{ id: number; name: string }[]>("list_collections");
  return rows.map((c) => ({ id: String(c.id), name: c.name }));
}

/** Create a collection; resolves to its new id. */
export async function createCollection(name: string): Promise<string> {
  return String(await invoke<number>("create_collection", { name }));
}

export async function renameCollection(id: string, name: string): Promise<void> {
  await invoke("rename_collection", { id: Number(id), name });
}

/** Delete a collection — only the grouping; no file is touched. */
export async function deleteCollection(id: string): Promise<void> {
  await invoke("delete_collection", { id: Number(id) });
}

/** Add/remove one file (by path) to/from a collection. */
export async function setImageCollection(
  collectionId: string,
  path: string,
  on: boolean,
): Promise<void> {
  await invoke("set_image_collection", { collectionId: Number(collectionId), path, on });
}

export async function openUrl(url: string): Promise<void> {
  await invoke("open_url", { url });
}

export async function getSetting(key: string): Promise<string | null> {
  return invoke<string | null>("get_setting", { key });
}

export async function setSetting(key: string, value: string): Promise<void> {
  await invoke("set_setting", { key, value });
}

/** The settings key behind "keep running in the tray" — read it with `getSetting`. */
export const CLOSE_TO_TRAY_KEY = "close_to_tray";

/**
 * Turn "keep running in the tray" on/off. Not setSetting, the backend also
 * has to add/remove the tray icon.
 */
export async function setCloseToTray(on: boolean): Promise<void> {
  await invoke("set_close_to_tray", { on });
}

/** Where this copy of MiColl keeps its own files. */
export interface DataLocations {
  /** True when a `micoll-portable.txt` marker put the data beside the executable. */
  portable: boolean;
  /** Library database, templates, image versions. */
  data: string;
  /** Thumbnail cache and other regenerable files. */
  cache: string;
}

export async function dataLocations(): Promise<DataLocations> {
  return invoke<DataLocations>("data_locations");
}

/* ---- portable first run ---------------------------------------------- */

/** The installed library a portable copy found next door on its first start. */
export interface PortableOffer {
  path: string;
  artists: number;
  rewards: number;
}

/** Only set when this start should ask: take over the installed library or start empty. */
export async function portableFirstRun(): Promise<PortableOffer | null> {
  return invoke<PortableOffer | null>("portable_first_run");
}

/** Copy the installed library into this portable copy (the original stays put). */
export async function portableAdopt(): Promise<void> {
  await invoke("portable_adopt");
}

/** Keep this copy's own empty library, under the given name. */
export async function portableStartFresh(name: string): Promise<void> {
  await invoke("portable_start_fresh", { name });
}

/** True when the first-run questions haven't been asked yet. */
export async function firstRunPending(): Promise<boolean> {
  return invoke<boolean>("first_run_pending");
}

/* ---- lock-screen password ------------------------------------------- */

/** Set a lock password; pass "" to remove it. */
export async function setPassword(password: string): Promise<void> {
  await invoke("set_password", { password });
}

/** Whether a lock password is currently set. */
export async function hasPassword(): Promise<boolean> {
  return invoke<boolean>("has_password");
}

/** Verify a password (always true when none is set). */
export async function verifyPassword(password: string): Promise<boolean> {
  return invoke<boolean>("verify_password", { password });
}

/** Set the decoy password (opens MiColl in safe mode); pass "" to remove it. */
export async function setDecoyPassword(password: string): Promise<void> {
  await invoke("set_decoy_password", { password });
}

/** Whether a decoy password is currently set. */
export async function hasDecoyPassword(): Promise<boolean> {
  return invoke<boolean>("has_decoy_password");
}

/* ---- at-rest encryption --------------------------------------------- */

export interface EncryptionState {
  enabled: boolean;
  unlocked: boolean;
}

/** Whether file encryption is enabled, and whether the session is unlocked. */
export async function encryptionState(): Promise<EncryptionState> {
  return invoke<EncryptionState>("encryption_state");
}

/** Turn on encryption + sweep-encrypt the collection. Returns a recovery code. */
export async function enableEncryption(password: string): Promise<string> {
  return invoke<string>("enable_encryption", { password });
}

/** Turn off encryption (decrypts everything back). */
export async function disableEncryption(password: string): Promise<void> {
  await invoke("disable_encryption", { password });
}

/** Encrypt any not-yet-encrypted files (idempotent; used after imports). */
export async function encryptCollection(): Promise<void> {
  await invoke("encrypt_collection");
}

/** Result of an unlock. decoy = decoy password was used -> safe mode. */
export interface UnlockResult {
  ok: boolean;
  decoy: boolean;
}

/** Unlock the session (loads the data key when encryption is on). */
export async function unlock(password: string): Promise<UnlockResult> {
  return invoke<UnlockResult>("unlock", { password });
}

/** Unlock using the recovery code instead of the password. */
export async function unlockRecovery(code: string): Promise<boolean> {
  return invoke<boolean>("unlock_recovery", { code });
}

/** Wipe the in-memory data key (called when locking). */
export async function lockSession(): Promise<void> {
  await invoke("lock");
}

export async function organizeCollection(): Promise<OrganizeSummary> {
  return invoke<OrganizeSummary>("organize_collection");
}

export interface MoveCollectionSummary {
  /** Whether an existing MiColl folder was physically relocated. */
  moved: boolean;
  /** How many indexed image paths were re-pointed to the new location. */
  images: number;
  /** The new collection root now saved. */
  newRoot: string;
}

/**
 * Move the whole managed collection to newRoot (<old>/MiColl -> <newRoot>/MiColl)
 * and update all paths. Without a collection it just saves the new root.
 */
export async function moveCollection(newRoot: string): Promise<MoveCollectionSummary> {
  return invoke<MoveCollectionSummary>("move_collection", { newRoot });
}

/** Full-resolution original image as a base64 data URL (for the viewer). */
export async function readImage(path: string): Promise<string> {
  return invoke<string>("read_image", { src: path });
}

/** Object remover (classic): fill the masked area. PNG data URLs in and out. */
export async function editInpaint(imageB64: string, maskB64: string): Promise<string> {
  return invoke<string>("edit_inpaint", { imageB64, maskB64 });
}

/**
 * Object remover (AI): fill the masked area with local LaMa (needs the model).
 * Same as editInpaint.
 */
export async function editInpaintAi(imageB64: string, maskB64: string): Promise<string> {
  return invoke<string>("edit_inpaint_ai", { imageB64, maskB64 });
}

/** Resize to exactly width×height with a high-quality classic filter (Lanczos). */
export async function editResize(
  imageB64: string,
  width: number,
  height: number,
): Promise<string> {
  return invoke<string>("edit_resize", { imageB64, width, height });
}

/** AI upscale to width x height (Real-ESRGAN x4, tiled). Needs the "esrgan" model. */
export async function editUpscale(
  imageB64: string,
  width: number,
  height: number,
): Promise<string> {
  return invoke<string>("edit_upscale", { imageB64, width, height });
}

/**
 * Cut out the subject (background transparent). feather softens the edge in px.
 * Needs the "isnet" model. Returns a PNG data URL.
 */
export async function editCutout(imageB64: string, feather = 0): Promise<string> {
  return invoke<string>("edit_cutout", { imageB64, feather });
}

/** The local AI models the editor can use. */
export type AiModel = "lama" | "esrgan" | "isnet";

export interface AiModelStatus {
  ready: boolean;
  sizeMb: number | null;
  /** The exact URL the download fetches. */
  url: string;
  /** The folder the model is kept in. */
  folder: string;
}

/** Is a local AI model downloaded? */
export async function aiModelStatus(model: AiModel): Promise<AiModelStatus> {
  return invoke<AiModelStatus>("ai_model_status", { model });
}

/**
 * Download an AI model once. Progress comes through the ai-model-progress event
 * ({ model, done, total } in bytes).
 */
export async function aiModelDownload(model: AiModel): Promise<void> {
  await invoke("ai_model_download", { model });
}

/**
 * Shrink a rough brushed area to just the object inside. strength (0..1) = more
 * sensitive (for faint watermarks). Returns the selection as a rose PNG data URL.
 */
export async function editDetect(
  imageB64: string,
  maskB64: string,
  strength = 0.5,
): Promise<string> {
  return invoke<string>("edit_detect", { imageB64, maskB64, strength });
}

/**
 * Save an edited image: "copy" = <name>_edited.png next to it, "overwrite" = replace it.
 */
export async function editSave(
  imageB64: string,
  srcPath: string,
  mode: "copy" | "overwrite",
): Promise<string> {
  return invoke<string>("edit_save", { imageB64, srcPath, mode });
}

/**
 * Save a cropped cover as _cover_<ts>.png and return its path
 * (then call setRewardCover / setPeriodPreview / setArtistPreview).
 */
export interface CoverMigration {
  moved: number;
  binned: number;
  deferred: number;
  errors: string[];
}

/** One-time: move old cover crops out of the reward folders into the covers folder. */
export async function migrateCoverCrops(): Promise<CoverMigration> {
  return invoke<CoverMigration>("migrate_cover_crops");
}

export async function saveCoverCrop(imageB64: string): Promise<string> {
  return invoke<string>("save_cover_crop", { imageB64 });
}

/** Attach a saved copy to the same reward as the original. False if not indexed. */
export async function indexAddedImage(referencePath: string, newPath: string): Promise<boolean> {
  return invoke<boolean>("index_added_image", { referencePath, newPath });
}

/* ---- Image versions (non-destructive edit history) -------------------- */

export interface ImageVersion {
  id: number;
  origPath: string;
  filePath: string;
  label: string | null;
  createdAt: string | null;
}

/**
 * Save the edit as a new VERSION of the original (never overwrites it).
 * The version becomes the active view.
 */
export async function saveImageVersion(
  origPath: string,
  imageB64: string,
  label?: string,
): Promise<ImageVersion> {
  return invoke<ImageVersion>("save_image_version", { origPath, imageB64, label: label ?? null });
}

/** List an image's versions plus which one is active (null = original). */
export async function listImageVersions(
  origPath: string,
): Promise<{ versions: ImageVersion[]; activeId: number | null }> {
  return invoke("list_image_versions", { origPath });
}

/**
 * Versions of many images at once, by original path (images without versions are left out).
 */
export async function imageVersionsFor(
  origPaths: string[],
): Promise<Record<string, { versions: ImageVersion[]; activeId: number | null }>> {
  return invoke("image_versions_for", { origPaths });
}

/** Setting for which file MEGA uploads: "original" (default) or "newest". */
export const MEGA_VERSION_KEY = "mega_upload_version";

/** Switch the displayed version; `null` reverts to the original. */
export async function setActiveVersion(origPath: string, versionId: number | null): Promise<void> {
  await invoke("set_active_version", { origPath, versionId });
}

/** Delete a single version (and trash its app-data file). */
export async function deleteImageVersion(versionId: number): Promise<void> {
  await invoke("delete_image_version", { versionId });
}

/** Open a file with its default app (for files MiColl can't show: PSD, PDF...). */
export async function openWithDefault(path: string): Promise<void> {
  return invoke<void>("open_with_default", { path });
}

export async function showInExplorer(path: string): Promise<void> {
  await invoke("show_in_explorer", { path });
}

/** Extract a dropped .zip/.rar/.7z to a temp folder; returns a folder to import from. */
export async function extractArchive(path: string, permanent = false): Promise<string> {
  return invoke<string>("extract_archive", { path, permanent });
}

/** Send a file/folder to the OS recycle bin. */
export async function trashPath(path: string): Promise<void> {
  await invoke("trash_path", { path });
}

/** Write a consistent snapshot of the library database to `dest`. */
export async function backupDatabase(dest: string): Promise<void> {
  await invoke("backup_database", { dest });
}

/** Replace the live library database with `src` and reopen it (locks the session). */
export async function restoreDatabase(src: string): Promise<void> {
  await invoke("restore_database", { src });
}

/** A LAN share link for a file: a scannable QR (SVG) + the URL it encodes. */
export interface ShareInfo {
  url: string;
  qrSvg: string;
  expiresSecs: number;
}
/** Publish a file on the local network and get a QR + URL to open on the phone. */
export async function shareToPhone(path: string): Promise<ShareInfo> {
  return invoke<ShareInfo>("share_to_phone", { path });
}
/** Zip a reward's files and publish that on the LAN (QR + URL). */
export async function shareFolderToPhone(srcs: string[], name: string): Promise<ShareInfo> {
  return invoke<ShareInfo>("share_folder_to_phone", { srcs, name });
}
/** Invalidate all active share links (call when the share dialog closes). */
export async function stopSharing(): Promise<void> {
  await invoke("stop_sharing");
}
/**
 * Put files on the clipboard like Explorer does (Ctrl+V into Discord, Telegram...).
 * Returns the count.
 */
export async function copyFilesToClipboard(srcs: string[]): Promise<number> {
  return invoke<number>("copy_files_to_clipboard", { srcs });
}
/** Put a single still on the clipboard as a picture (for pasting into a chat/editor). */
export async function copyImageToClipboard(src: string): Promise<void> {
  await invoke("copy_image_to_clipboard", { src });
}
/** Open the Windows share sheet (Nearby sharing, Mail, Phone Link, …) for these files. */
export async function windowsShare(srcs: string[], name: string): Promise<void> {
  await invoke("windows_share", { srcs, name });
}
/**
 * Name our audio sessions "MiColl" in the volume mixer (otherwise "WebView2").
 * Call it when playback starts.
 */
export async function claimAudioName(): Promise<number> {
  return invoke<number>("claim_audio_name");
}
/** Save a decrypted copy of a media file to `dest` (the "Save a copy…" action). */
export async function exportFile(src: string, dest: string): Promise<void> {
  await invoke("export_file", { src, dest });
}
/** Save decrypted copies of a reward's files into `destDir/<name>/`. Returns count. */
export async function exportFiles(srcs: string[], destDir: string, name: string): Promise<number> {
  return invoke<number>("export_files", { srcs, destDir, name });
}

/** Whether MEGAcmd is installed + logged in (drives the MEGA upload UI). */
export interface MegaStatus {
  installed: boolean;
  loggedIn: boolean;
  account: string | null;
  /** Raw mega-whoami details, for the diagnostics box. */
  raw?: string | null;
}
export async function megaStatus(): Promise<MegaStatus> {
  return invoke<MegaStatus>("mega_status");
}
/** Upload a decrypted copy of `src` to the user's MEGA account under `folder`. */
export async function megaUpload(src: string, folder: string): Promise<void> {
  await invoke("mega_upload", { src, folder });
}
/** Upload a reward's decrypted files to MEGA under `folder/<name>/`. */
export async function megaUploadFiles(srcs: string[], folder: string, name: string): Promise<void> {
  await invoke("mega_upload_files", { srcs, folder, name });
}
/** Open the interactive MEGAcmd app (so the user can run `login`). */
export async function openMegacmd(): Promise<void> {
  await invoke("open_megacmd");
}

/**
 * How to shrink before upload: one of pct / width / height. Keeps the ratio, never bigger.
 */
export interface ResizeSpec {
  pct?: number;
  width?: number;
  height?: number;
}
export interface MegaUploadSummary {
  uploaded: number;
  resized: number;
}
/** Pixel dimensions per path ((0,0) for videos/unreadable) — decrypt-aware. */
export async function mediaDimensions(paths: string[]): Promise<[number, number][]> {
  return invoke<[number, number][]>("media_dimensions", { paths });
}
/**
 * Upload to MEGA with optional downscale and mega-progress events
 * ({ phase: "resize" | "upload", done, total }). name = subfolder.
 */
export async function megaUploadMedia(
  srcs: string[],
  folder: string,
  name?: string,
  resize?: ResizeSpec,
  /**
   * Optional new file names (with extension), same order as srcs.
   * Only the uploaded copies are renamed.
   */
  names?: (string | null)[],
): Promise<MegaUploadSummary> {
  return invoke<MegaUploadSummary>("mega_upload_media", {
    srcs,
    folder,
    name: name ?? null,
    resize: resize ?? null,
    names: names ?? null,
  });
}

/** Open an artist's own folder (its contents) in the file manager. */
export async function revealArtist(artistId: string): Promise<void> {
  await invoke("reveal_artist", { artistId: Number(artistId) });
}

/** Delete one platform of an artist (optionally trashing its folder). */
export async function deletePlatform(
  artistId: string,
  platform: string,
  alsoFiles: boolean,
): Promise<void> {
  await invoke("delete_platform", { artistId: Number(artistId), platform, alsoFiles });
}

export async function deleteRewards(rewardIds: string[], alsoFiles: boolean): Promise<void> {
  await invoke("delete_rewards", { rewardIds: rewardIds.map(Number), alsoFiles });
}

/**
 * Add a wish (a "missing" reward). Creates the creator and period if needed.
 * Nothing on disk, when the files arrive the indexer turns it into an owned reward.
 */
export async function addWish(
  creator: string,
  title: string,
  platform: string | null,
  year: number | null,
  month: number | null,
): Promise<number> {
  return invoke<number>("add_wish", { creator, title, platform, year, month });
}

/** Put a reward on the wishlist, or take it off, without deleting the row. */
/**
 * Mark rewards as extras or not. Returns how many changed.
 * Extras stay in the month but aren't used for the month mosaic.
 */
export async function setRewardsExtra(rewardIds: string[], extra: boolean): Promise<number> {
  return invoke<number>("set_rewards_extra", { rewardIds: rewardIds.map(Number), extra });
}

export async function setWished(rewardId: string, wished: 0 | 1 | 2): Promise<void> {
  await invoke("set_wished", { rewardId: Number(rewardId), wished });
}

/**
 * Copy an image into MiColl's data folder as a wish cover (not into the collection,
 * there it would count as owned).
 */
export async function importWishCover(src: string): Promise<string> {
  return invoke<string>("import_wish_cover", { src });
}

/** Delete a whole artist (works for empty/manually-created ones). */
export async function deleteArtist(artistId: string, alsoFiles: boolean): Promise<void> {
  await invoke("delete_artist", { artistId: Number(artistId), alsoFiles });
}

/**
 * Rename a creator (also renames the folder and updates the paths).
 * Fails if another creator has that name.
 */
export async function renameArtist(artistId: string, newName: string): Promise<void> {
  await invoke("rename_artist", { artistId: Number(artistId), newName });
}

/** Add a platform (folder + tab) to an existing artist. */
export async function addArtistPlatform(artistId: string, platform: string): Promise<void> {
  await invoke("add_artist_platform", { artistId: Number(artistId), platform });
}

export async function deleteImage(imageId: string, alsoFiles: boolean): Promise<void> {
  await invoke("delete_image", { imageId: Number(imageId), alsoFiles });
}

/** Delete several images/videos at once (a viewer multi-selection). */
export async function deleteImages(imageIds: string[], alsoFiles: boolean): Promise<void> {
  await invoke("delete_images", { imageIds: imageIds.map(Number), alsoFiles });
}

/** How many files a fill copied in, skipped (name clash → "skip") and failed. */
export interface FillReport {
  added: number;
  skipped: number;
  failed: number;
  /** Only for moveSources: source folders the recycle bin refused (the copy worked). */
  keptSources: string[];
}

/** What the user chose for an incoming file that clashes with an existing one. */
export type ConflictChoice = "replace" | "rename" | "skip";

/** An incoming file that would overwrite an existing one. rel = key for the answer. */
export interface FillConflict {
  rel: string;
  name: string;
}

export interface FillPlan {
  conflicts: FillConflict[];
}

/** Dry run: list the files that clash with existing ones, so the UI can ask. */
export async function fillRewardPlan(rewardId: string, paths: string[]): Promise<FillPlan> {
  return invoke<FillPlan>("fill_reward_plan", { rewardId: Number(rewardId), paths });
}

/**
 * Fill a missing reward: copy the files into its month folder and index them (-> owned).
 * resolutions = the choice per clashing file. Returns add/skip/fail counts.
 */
export async function fillReward(
  rewardId: string,
  paths: string[],
  resolutions?: Record<string, ConflictChoice>,
  /**
   * Move the sources to the recycle bin after copying (used by the import's merge answer).
   */
  moveSources?: boolean,
): Promise<FillReport> {
  return invoke<FillReport>("fill_reward", {
    rewardId: Number(rewardId),
    paths,
    resolutions,
    moveSources,
  });
}

/** Create a new (empty) reward folder under a period — the "New folder" action. */
export async function createReward(periodId: string, name: string): Promise<number> {
  return invoke<number>("create_reward", { periodId: Number(periodId), name });
}

/** Add a "missing" placeholder card (no folder yet). Only without a template. */
export async function createMissingReward(periodId: string, name: string): Promise<number> {
  return invoke<number>("create_missing_reward", { periodId: Number(periodId), name });
}

/** Find or create the period for platform/year/month, returns its id. */
export async function ensurePeriod(
  artistId: string,
  platform: string | null,
  year: number | null,
  month: number | null,
  number: number | null = null,
): Promise<number> {
  return invoke<number>("ensure_period", {
    artistId: Number(artistId),
    platform: platform ?? null,
    year: year ?? null,
    month: month ?? null,
    number: number ?? null,
  });
}

/** Move whole reward folders into a different period (month/platform). */
export async function moveRewards(rewardIds: string[], destPeriodId: string): Promise<number> {
  return invoke<number>("move_rewards", {
    rewardIds: rewardIds.map(Number),
    destPeriodId: Number(destPeriodId),
  });
}

/**
 * Merge reward folders into another reward. keepFolder = as subfolder, else only the files.
 */
export async function mergeRewards(
  rewardIds: string[],
  destRewardId: string,
  keepFolder = false,
): Promise<number> {
  return invoke<number>("merge_rewards", {
    rewardIds: rewardIds.map(Number),
    destRewardId: Number(destRewardId),
    keepFolder,
  });
}

/** Move individual media files into a different reward's folder. */
export async function moveImages(imageIds: string[], destRewardId: string): Promise<number> {
  return invoke<number>("move_images", {
    imageIds: imageIds.map(Number),
    destRewardId: Number(destRewardId),
  });
}

/** Per-file size (bytes) + last-modified (ms) — for the viewer's sort by size/date. */
export interface MediaStat {
  path: string;
  size: number;
  modified: number;
}
export async function mediaStats(paths: string[]): Promise<MediaStat[]> {
  if (paths.length === 0) return [];
  return invoke<MediaStat[]>("media_stats", { paths });
}

/** Windows file properties (Title/Subject/Rating/Tags/Comments) — Explorer's "Details". */
export interface FileProps {
  title: string;
  subject: string;
  /** 0 = unrated, else 1–5 stars. */
  rating: number;
  tags: string[];
  comments: string;
}
export async function readFileProps(path: string): Promise<FileProps> {
  return invoke<FileProps>("read_file_props", { path });
}
export async function writeFileProps(path: string, data: FileProps): Promise<void> {
  await invoke("write_file_props", { path, data });
}

/**
 * Which metadata fields to delete. The lower group is "notable" (camera, location, author).
 */
export interface PropFields {
  title: boolean;
  subject: boolean;
  rating: boolean;
  tags: boolean;
  comments: boolean;
  authors: boolean;
  copyright: boolean;
  camera: boolean;
  dateTaken: boolean;
  gps: boolean;
}
/** Per-field aggregate across the selected files (count + a sample value). */
export interface MetaFieldSummary {
  key: string;
  present: number;
  sample: string;
}
/** A file's metadata footprint — `present` is the list of field keys it carries. */
export interface MetaFile {
  path: string;
  name: string;
  unusual: boolean;
  present: string[];
}
export interface MetaSummary {
  total: number;
  encrypted: number;
  fields: MetaFieldSummary[];
  files: MetaFile[];
}
/** Read + aggregate the current metadata across files (for the delete preview). */
export async function summarizeFileProps(paths: string[]): Promise<MetaSummary> {
  if (paths.length === 0) return { total: 0, encrypted: 0, fields: [], files: [] };
  return invoke<MetaSummary>("summarize_file_props", { paths });
}
/**
 * Delete the chosen metadata fields from many files. Returns the count (encrypted files
 * skipped).
 */
export async function clearFileProps(paths: string[], fields: PropFields): Promise<number> {
  if (paths.length === 0) return 0;
  return invoke<number>("clear_file_props", { paths, fields });
}

/* ---- Library health / re-linking ------------------------------------- */

export interface HealthArtist {
  id: string;
  name: string;
  missing: number;
}
/** A missing folder (the broken root) and how many files sit under it. */
export interface BrokenRoot {
  path: string;
  count: number;
}
export interface HealthReport {
  checked: number;
  missing: number;
  /** Files on the (currently unplugged) MiSD disk — safe, not lost. */
  sdOffline: number;
  artists: HealthArtist[];
  brokenRoots: BrokenRoot[];
  /** Collab links whose folder is gone (renamed outside MiColl). Only the link is stale. */
  brokenCollabs: BrokenCollab[];
  /**
   * MiSD backup folders nothing points to anymore. Only listed, never deleted.
   * Empty while the disk is unplugged.
   */
  orphanBackups: string[];
}
export interface BrokenCollab {
  rewardId: number;
  title: string;
  ownerName: string;
  partnerName: string;
  folderPath: string;
}
/** Scan all indexed images for files missing on disk. */
export async function libraryHealth(): Promise<HealthReport> {
  return invoke<HealthReport>("library_health");
}
/** Re-point every stored path under `oldPrefix` to `newPrefix`. Returns images re-linked. */
export async function relinkLibrary(oldPrefix: string, newPrefix: string): Promise<number> {
  return invoke<number>("relink_library", { oldPrefix, newPrefix });
}
/** Delete DB rows for images whose files are truly gone. Returns the count pruned. */
export async function pruneMissing(): Promise<number> {
  return invoke<number>("prune_missing");
}

/**
 * Put loose dropped files into a temp reward folder for the import.
 * Returns the folder, or null if nothing needed that (folder/archive dropped).
 */
export async function stageFilesForImport(paths: string[]): Promise<string | null> {
  return invoke<string | null>("stage_files_for_import", { paths });
}

/**
 * Delete the temp staging folder of an import. Safe with any path, the backend only
 * deletes its own temp folders and only when nothing indexed is inside.
 * Returns true if something was removed.
 */
export async function discardStaging(path: string): Promise<boolean> {
  return invoke<boolean>("discard_staging", { path });
}

export async function analyzeImport(path: string): Promise<ImportPlan> {
  return invoke<ImportPlan>("analyze_import", { path });
}

/**
 * An incoming reward whose name already exists in that period.
 * The review asks before importing (otherwise the folders merge).
 */
export interface ImportClash {
  /** Source folder of the incoming row — the review tree's row identity. */
  folder: string;
  /** The name both sides carry. */
  title: string;
  /** The reward already sitting there (the merge target). */
  rewardId: number;
  /** Where that reward's files live now. */
  existingFolder: string;
  /** Human-readable shelf, e.g. "Nora · Patreon · 2026-03". */
  location: string;
}

/** Check a reviewed import against the library before anything is written. */
export async function importClashes(rewards: ResolvedReward[]): Promise<ImportClash[]> {
  return invoke<ImportClash[]>("import_clashes", { rewards });
}

export async function commitImport(
  rewards: ResolvedReward[],
  source: string,
  styles: StyleChoice[] = [],
  openAsCards = false,
): Promise<ScanSummary> {
  return invoke<ScanSummary>("commit_import", { rewards, source, styles, openAsCards });
}

export interface CreateArtistArgs {
  name: string;
  /** Absolute path to an image to use as the artist card preview (optional). */
  preview: string | null;
  /** Base folder to scaffold the hierarchy under (null → managed collection root). */
  baseDir: string | null;
  /** Platforms to create empty folders for (e.g. ["Patreon"]). */
  platforms: string[];
  /** Years to create under each platform (only used by the "monthly" style). */
  years: number[];
  /** Whether to create 12 month subfolders under each year. */
  months: boolean;
  /** How the creator releases. Only "monthly" gets year/month folders. */
  releaseStyle: ReleaseStyle;
  /** Creator type(s), comma-separated (e.g. "Artist,Animator"). Null → none. */
  kind?: string | null;
}

export async function createArtist(args: CreateArtistArgs): Promise<void> {
  await invoke("create_artist", {
    name: args.name,
    preview: args.preview,
    baseDir: args.baseDir,
    platforms: args.platforms,
    years: args.years,
    months: args.months,
    releaseStyle: args.releaseStyle,
    kind: args.kind ?? null,
  });
}

/* ---- artist templates ------------------------------------------------ */

export interface TemplatePreview {
  fileName: string;
  artist: string;
  /** Optional descriptive label (e.g. "Patreon 2025"), shown in the list. */
  label: string | null;
  kind: string | null;
  verified: boolean;
  platforms: number;
  periods: number;
  rewards: number;
  links: number;
  version: string | null;
  /** "Last updated" date from the template's meta (free text). */
  updated: string | null;
  /** Whether this specific template (by label) is currently applied to its artist. */
  applied?: boolean;
  /** Size of the file on disk — almost entirely its inline covers. */
  bytes?: number;
  /** A `.orig` backup sits next to it: its covers were shrunk and can be put back. */
  hasOriginal?: boolean;
}

/** Width of inline template covers. Full size covers made a template 78 MB. */
export const TEMPLATE_COVER_PX = 512;

/**
 * Check a template's JSON, save it, return a summary. When editing, pass the old
 * file name so a rename replaces it.
 */
export async function importTemplate(json: string, replaceFile?: string): Promise<TemplatePreview> {
  return invoke<TemplatePreview>("import_template", { json, replaceFile: replaceFile ?? null });
}

/** Import a template from a file on disk (file-picker / drag-and-drop path). */
export async function importTemplateFile(path: string): Promise<TemplatePreview> {
  return invoke<TemplatePreview>("import_template_file", { path });
}

/** Write a template's JSON to a chosen path (the "Download" button). */
export async function exportTemplate(path: string, raw: string): Promise<void> {
  await invoke("export_template", { path, raw });
}

/* ---- signing & licensing ---------------------------------------------- */

/** True only on the owner's PC (signing key installed). Enables verified mode. */
export async function canSign(): Promise<boolean> {
  return invoke<boolean>("can_sign");
}

/** Sign a template (the only way to get the verified check). Owner only. */
export async function signTemplate(json: string): Promise<string> {
  return invoke<string>("sign_template", { json });
}

/** Issue a permanent premium-theme unlock key for a buyer (owner-only). */
export async function issueThemeKey(
  buyer: string,
  /** Test key: an end date (YYYY-MM-DD) or a number of days. Neither = permanent. */
  trial?: { expires?: string; days?: number },
): Promise<string> {
  return invoke<string>("issue_theme_key", {
    buyer,
    expires: trial?.expires ?? null,
    days: trial?.days ?? null,
  });
}

/** What a pasted key turns out to be. `until` is the last day a test key works. */
export interface ThemeLicenseInfo {
  buyer: string;
  trial: boolean;
  until: string | null;
}

/** Check a pasted theme key, returns the buyer name or an error message. */
export async function verifyThemeLicense(token: string): Promise<ThemeLicenseInfo> {
  return invoke<ThemeLicenseInfo>("verify_theme_license", { token });
}

/**
 * Short fingerprint of a key (shown next to the buyer, used for the revocation list).
 * Also works for keys that are no longer valid.
 */
export async function themeKeyFingerprint(token: string): Promise<string> {
  return invoke<string>("theme_key_fingerprint", { token });
}

/* ---- MiSD (external disk) ---- */

export interface SdStatus {
  configured: boolean;
  root: string | null;
  label: string | null;
  /** The disk is connected (its identity marker was found). */
  available: boolean;
  /** Rewards queued for the next transport (move). */
  marked: number;
  /** Rewards currently living on the disk. */
  transported: number;
  /** Rewards queued for the next backup (copy, keep the local files). */
  backupMarked: number;
  /** Rewards that have a verified copy on the disk and are still local. */
  backups: number;
  /** Transports keep an offline preview for the rewards they move away. */
  previews: boolean;
}

export interface SdSummary {
  moved: number;
  failed: number;
  errors: string[];
  /** The user stopped the job. `moved` is finished and safe; the rest is still queued. */
  cancelled: boolean;
}

/** Configure (or re-label) the MiSD folder on the external disk. */
export async function sdSetup(path: string, label: string): Promise<SdStatus> {
  return invoke<SdStatus>("sd_setup", { path, label });
}

/** Current MiSD state; also auto-heals a changed Windows drive letter. */
export async function sdStatus(): Promise<SdStatus> {
  return invoke<SdStatus>("sd_status");
}

/** A creator with rewards waiting in one of the MiSD queues. */
export interface SdQueuedCreator {
  name: string;
  moves: number;
  backups: number;
}

/** Who the next transport/backup would touch, by name — for the confirmation. */
export async function sdQueuedCreators(): Promise<SdQueuedCreator[]> {
  return invoke<SdQueuedCreator[]>("sd_queued_creators");
}

/** Cheap connectivity probe (used before opening an SD reward). */
export async function sdAvailable(): Promise<boolean> {
  return invoke<boolean>("sd_available");
}

/** Which MiSD queue a mark goes into: move the files, or copy and keep them. */
export type SdMode = "move" | "backup";

/** Queue/unqueue rewards (by ids, period or artist). The two queues are separate. */
export async function sdMark(opts: {
  rewardIds?: number[];
  periodId?: number;
  artistId?: number;
  marked: boolean;
  mode?: SdMode;
}): Promise<number> {
  return invoke<number>("sd_mark", {
    rewardIds: opts.rewardIds ?? null,
    periodId: opts.periodId ?? null,
    artistId: opts.artistId ?? null,
    marked: opts.marked,
    mode: opts.mode ?? "move",
  });
}

/** A standing MiSD order on one year of one platform. */
export interface SdYearRule {
  /** null = the periods whose platform is still unconfirmed. */
  platform: string | null;
  /** null = "Misc" — the periods filed under no year at all. */
  year: number | null;
  mode: SdMode;
}

/**
 * Queue a whole year of a platform, with rule set also save a rule so later
 * rewards there get queued too.
 */
export async function sdMarkYear(opts: {
  artistId: number;
  platform: string | null;
  year: number | null;
  marked: boolean;
  mode?: SdMode;
  /** Also set/remove the rule (default true, see sd_mark_year in lib.rs). */
  rule?: boolean;
}): Promise<number> {
  return invoke<number>("sd_mark_year", {
    artistId: opts.artistId,
    platform: opts.platform,
    year: opts.year,
    marked: opts.marked,
    mode: opts.mode ?? "move",
    rule: opts.rule ?? true,
  });
}

/** Turn a year rule on/off on its own (mode null removes it), queued stuff stays. */
export async function sdYearRule(opts: {
  artistId: number;
  platform: string | null;
  year: number | null;
  mode: SdMode | null;
}): Promise<void> {
  return invoke<void>("sd_year_rule", {
    artistId: opts.artistId,
    platform: opts.platform,
    year: opts.year,
    mode: opts.mode,
  });
}

/** Every standing year rule this creator has. */
export async function sdYearRules(artistId: number): Promise<SdYearRule[]> {
  return invoke<SdYearRule[]>("sd_year_rules", { artistId });
}

/** Move all marked rewards to the MiSD disk (SHA-256 checked, previews kept). */
export async function sdTransport(): Promise<SdSummary> {
  return invoke<SdSummary>("sd_transport");
}

/** Bring rewards back from the MiSD disk (undefined = everything). */
export async function sdReturn(rewardIds?: number[]): Promise<SdSummary> {
  return invoke<SdSummary>("sd_return", { rewardIds: rewardIds ?? null });
}

/** Copy all rewards queued for backup to the disk (same check), local files stay. */
export async function sdBackupNow(): Promise<SdSummary> {
  return invoke<SdSummary>("sd_backup_now");
}

/**
 * Stop the running MiSD job. The current reward is finished first, so nothing is half
 * moved.
 */
export async function sdCancel(): Promise<void> {
  return invoke<void>("sd_cancel");
}

/** Remove MiSD backup copies (undefined = all). Local files are never touched. */
export async function sdBackupDrop(rewardIds?: number[]): Promise<SdSummary> {
  return invoke<SdSummary>("sd_backup_drop", { rewardIds: rewardIds ?? null });
}

/** List all imported templates. */
export async function listTemplates(): Promise<TemplatePreview[]> {
  return invoke<TemplatePreview[]>("list_templates");
}

/**
 * A template's JSON, loaded when needed (templates can be huge, the list doesn't include
 * it).
 */
export async function readTemplate(fileName: string): Promise<string> {
  return invoke<string>("read_template", { fileName });
}

export interface ShrinkResult {
  covers: number;
  before: number;
  after: number;
}

/**
 * Shrink a template's inline covers to TEMPLATE_COVER_PX.
 * The original is kept as <name>.orig. Templates signed by someone else are refused.
 */
export async function shrinkTemplateCovers(
  fileName: string,
  maxPx = TEMPLATE_COVER_PX,
): Promise<ShrinkResult> {
  return invoke<ShrinkResult>("shrink_template_covers", { fileName, maxPx });
}

/** Put back the file kept before the covers were shrunk. */
export async function restoreTemplateCovers(fileName: string): Promise<void> {
  await invoke("restore_template_covers", { fileName });
}

/** A downscaled image as a base64 data URL (used for template covers). */
export async function getThumbnail(src: string, size = TEMPLATE_COVER_PX): Promise<string> {
  return invoke<string>("get_thumbnail", { src, size });
}

/* ---- daily backups ---- */

export interface BackupInfo {
  /** File name, `micoll-YYYYMMDD.db`. */
  name: string;
  /** The date from that name, ISO. */
  day: string;
  bytes: number;
  /** Has a WAL sidecar, which a restore has to take along. */
  hasWal: boolean;
}

/** The daily snapshots MiColl takes at startup, newest first. */
export async function listBackups(): Promise<BackupInfo[]> {
  return invoke<BackupInfo[]>("list_backups");
}

/** Make one of the daily snapshots the live library again (locks the session). */
export async function restoreBackup(name: string): Promise<void> {
  await invoke("restore_backup", { name });
}

/** Open the snapshots folder in the file manager. */
export async function revealBackups(): Promise<void> {
  await invoke("reveal_backups");
}

/** Reveal a template's .json file in the OS file manager (Shift+right-click). */
export async function revealTemplate(fileName: string): Promise<void> {
  await invoke("reveal_template", { fileName });
}

/** Delete a template file from the templates folder. */
export async function deleteTemplate(fileName: string): Promise<void> {
  await invoke("delete_template", { fileName });
}

/**
 * Deactivate a template: removes its totals/missing rewards and the verified badge
 * (if no templates are left). The file stays.
 */
export async function deactivateTemplate(json: string): Promise<void> {
  await invoke("deactivate_template", { json });
}

/** Apply a template to the library (optionally scaffolding empty folders). */
export async function applyTemplate(
  json: string,
  createFolders: boolean,
  baseDir: string | null = null,
): Promise<ScanSummary> {
  return invoke<ScanSummary>("apply_template", { json, createFolders, baseDir });
}
