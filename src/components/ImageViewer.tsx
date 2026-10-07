import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import {
  X,
  ChevronLeft,
  ChevronRight,
  ZoomIn,
  ZoomOut,
  Play,
  Pause,
  Shuffle,
  FolderOpen,
  Trash2,
  Monitor,
  ImageIcon,
  Pencil,
  CheckSquare,
  Maximize2,
  Repeat,
  PlayCircle,
  Wand2,
  Lock,
  ArrowDownUp,
  HelpCircle,
  ArrowLeftRight,
  Share2,
  Info,
  Check,
  Loader2,
  Star,
  ChevronDown,
  FileArchive,
  File as FileGeneric,
  FolderInput,
  Eraser,
  AlertTriangle,
  Heart,
  ExternalLink,
  Layers,
  RotateCcw,
  Timer,
  Crop,
  Wallpaper,
  Images,
  LayoutGrid,
} from "lucide-react";
import type { Collection } from "@/types";
import { Cover } from "@/components/Cover";
import { seedGradient, cn } from "@/lib/utils";
import { useT, useTf, useTp } from "@/lib/i18n";
import { isTauri, mediaUrl, previewUrl } from "@/lib/tauri";
import { useOptimizeLargeImages } from "@/lib/optimizeLarge";
import { enterImmersive } from "@/lib/immersive";
// renamed: setWallpaper from the API is the DESKTOP wallpaper
import { setWallpaper as setAppWallpaper } from "@/lib/wallpaper";
import { useDialogTheme } from "@/lib/dialogTheme";
import { queuePrefsSync } from "@/lib/prefs";
import {
  setWallpaper,
  setWallpaperSlideshow,
  setImageWallpaperFav,
  setImageFavorite,
  listCollections,
  setImageCollection,
  setRewardCover,
  setPeriodPreview,
  setArtistPreview,
  saveCoverCrop,
  setSetting,
  encryptionState,
  mediaStats,
  mediaDimensions,
  exportFile,
  exportFiles,
  renameImages,
  moveImages,
  listImageVersions,
  setActiveVersion,
  deleteImageVersion,
  type ImageVersion,
  readFileProps,
  writeFileProps,
  clearFileProps,
  summarizeFileProps,
  type FileProps,
  type PropFields,
  type MetaSummary,
  claimAudioName,
} from "@/api/library";
import { save, open } from "@tauri-apps/plugin-dialog";
import { SharePhoneModal } from "@/components/SharePhoneModal";
import { ShareSheet, type ShareRequest } from "@/components/ShareSheet";
import { MegaUploadModal } from "@/components/MegaUploadModal";
import { MovePicker } from "@/components/MovePicker";
import { CoverCropModal } from "@/components/CoverCropModal";
import {
  sortViewerItemsGrouped,
  loadImgSort,
  saveImgSort,
  dirLabel,
  IMG_SORT_FIELDS,
  IMG_SORT_LABELS,
  type ImgSortField,
  type SortDir,
} from "@/lib/imageSort";
import { useActions } from "@/actions";
import { useData } from "@/store";
import type { MenuItem } from "@/components/ContextMenu";
import { RenameDialog, type RenameTarget } from "@/components/RenameDialog";
import { ImageEditor } from "@/components/ImageEditor";
import { openInNewWindow } from "@/lib/popout";
import { DASHBOARD_SHAPE, useTileShapeFor, type TileScope } from "@/lib/tileShape";
import { useCardSize } from "@/lib/useCardSize";
import { getViewerStartsInGrid } from "@/lib/viewerStart";

/** What the current image can be set as cover of. */
export interface CoverTargets {
  rewardId?: string;
  periodId?: string;
  artistId?: string;
  /**
   * Tile shape of the page it was opened from, so "Crop & set" matches the card.
   * Strings because it goes through JSON to the pop-out window.
   */
  shapeScope?: TileScope;
  shapeKey?: string;
}

export interface ViewerItem {
  id: string;
  title: string;
  /** Full size src, "" = gradient (browser). */
  src: string;
  /** Path of the ORIGINAL file (key for versions and file actions). */
  path?: string;
  /** Path of the active version (falls back to path), this is what's shown. */
  displayPath?: string;
  /** Number of edit versions (0 = only the original). */
  versionCount?: number;
  /** True when the original is shown. */
  onOriginal?: boolean;
  /** File name with extension (for renaming). */
  name?: string;
  /**
   * "video" = <video>, "archive" = placeholder for any file we can't show
   * (zip, psd, pdf... opens in Explorer), else an image (also GIF).
   */
  kind?: "image" | "video" | "archive";
  /** Marked as favourite wallpaper. */
  favWallpaper?: boolean;
  /** In the "Favourites" collection. */
  favorite?: boolean;
  /** Ids of the user collections this file is in (for the menu ticks). */
  collections?: string[];
  /**
   * Subfolder inside the reward folder ("" = the folder itself), for the filmstrip markers.
   */
  group?: string;
}

/** Real archives get the zip icon, other files the generic file icon. */
const ARCHIVE_NAME_RE = /\.(zip|rar|7z|cbz|cbr|tar|gz)$/i;
const isRealArchive = (it: { name?: string; path?: string }) =>
  ARCHIVE_NAME_RE.test(it.name ?? it.path ?? "");

interface View {
  scale: number;
  tx: number;
  ty: number;
}
const RESET: View = { scale: 1, tx: 0, ty: 0 };
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
/** Max zoom (3200%, like the Windows photo viewer). */
const MAX_ZOOM = 32;

/**
 * Pick the most colorful bright pixel of the image and brighten it,
 * used as the glow color so dark images still tint the background.
 * Null if the canvas can't be read.
 */
function vibrantColor(img: HTMLImageElement): string | null {
  try {
    const s = 36;
    const c = document.createElement("canvas");
    c.width = s;
    c.height = s;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, s, s);
    const { data } = ctx.getImageData(0, 0, s, s);
    let best = -1;
    let br = 90,
      bg = 100,
      bb = 120; // fallback dusk blue-grey if nothing colourful is found
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const sat = max === 0 ? 0 : (max - min) / max;
      const val = max / 255;
      const score = sat * val * val; // colourful and bright wins
      if (val > 0.22 && score > best) {
        best = score;
        br = r;
        bg = g;
        bb = b;
      }
    }
    // brighten it so dark images still give a clear glow
    const peak = Math.max(br, bg, bb, 1);
    const boost = Math.min(2.6, 220 / peak);
    const f = (v: number) => Math.min(255, Math.round(v * boost));
    return `rgb(${f(br)}, ${f(bg)}, ${f(bb)})`;
  } catch {
    return null;
  }
}

// slide animation variants. custom = direction (1 forward, -1 back)
const slideVariants = {
  enter: (d: number) => ({ x: d >= 0 ? "100%" : "-100%", opacity: 0 }),
  center: { x: "0%", opacity: 1 },
  exit: (d: number) => ({ x: d >= 0 ? "-100%" : "100%", opacity: 0 }),
};

// slideshow speeds (right-click the play button)
type SlideSpeed = "fast" | "medium" | "long";
const SPEED_MS: Record<SlideSpeed, number> = { fast: 5000, medium: 10000, long: 15000 };
const SPEED_LABEL: Record<SlideSpeed, string> = { fast: "Fast", medium: "Medium", long: "Long" };
const NEXT_SPEED: Record<SlideSpeed, SlideSpeed> = { fast: "medium", medium: "long", long: "fast" };

// transition styles: "cut" = instant (old builds saved it as "fade"),
// "fade" = cross-dissolve, "slide" = carousel
type Anim = "cut" | "fade" | "slide";
const ANIM_LABEL: Record<Anim, string> = { cut: "Cut", fade: "Fade", slide: "Slide" };
const NEXT_ANIM: Record<Anim, Anim> = { cut: "fade", fade: "slide", slide: "cut" };

/**
 * Fullscreen viewer: keyboard navigation, zoom to the cursor with drag to pan,
 * and a slideshow with shuffle. The image is shown whole (object-contain).
 */
export function ImageViewer({
  items: rawItems,
  startIndex,
  onClose,
  coverTargets,
  onGoToFolder,
}: {
  items: ViewerItem[];
  startIndex: number;
  onClose: () => void;
  /** If set, the right-click menu offers "Set as ... cover". */
  coverTargets?: CoverTargets;
  /**
   * Only set when showing a COLLECTION (Favourites etc). Lets the menu open the
   * file in its real gallery.
   */
  onGoToFolder?: (item: ViewerItem) => void;
}) {
  const t = useT();
  const tf = useTf();
  const tp = useTp();
  // sort (saved per reward), default by name (natural order)
  const rewardKey = coverTargets?.rewardId ?? null;
  const [sortField, setSortField] = useState<ImgSortField>(() => loadImgSort(rewardKey).field);
  const [sortDir, setSortDir] = useState<SortDir>(() => loadImgSort(rewardKey).dir);
  // file stats (size/date/dimensions), loaded when a sort needs them
  const [stats, setStats] = useState<
    Record<string, { size: number; modified: number; w?: number; h?: number }>
  >({});
  const statsLoaded = useRef(false);
  const dimsLoaded = useRef(false);

  // copies saved from the editor are added here so they show up right away
  // (only for this session, de-duped by path)
  const [addedItems, setAddedItems] = useState<ViewerItem[]>([]);
  // ids deleted in the viewer this session, filtered out so we can stay open
  const [removedIds, setRemovedIds] = useState<Set<string>>(new Set());
  const allRawItems = useMemo(() => {
    const merged =
      addedItems.length === 0
        ? rawItems
        : [
            ...rawItems,
            ...addedItems.filter(
              (it) => !new Set(rawItems.map((r) => r.path).filter(Boolean)).has(it.path),
            ),
          ];
    return removedIds.size ? merged.filter((it) => !removedIds.has(it.id)) : merged;
  }, [rawItems, addedItems, removedIds]);

  const items = useMemo(
    // sort inside each subfolder group (reward files first)
    () => sortViewerItemsGrouped(allRawItems, sortField, sortDir, stats),
    [allRawItems, sortField, sortDir, stats],
  );

  // startIndex is a position in the sorted list (0 = first image of the sort)
  const [index, setIndex] = useState(() =>
    Math.min(Math.max(0, startIndex), Math.max(0, rawItems.length - 1)),
  );

  // until the user navigates, stay on the first image of the sort.
  // after that, stay on the viewed image when re-sorting.
  // A caller that asked for a specific image counts as already placed.
  const placedRef = useRef(startIndex > 0);
  const currentIdRef = useRef<string | undefined>(
    startIndex > 0 ? rawItems[startIndex]?.id : undefined,
  );
  // jump to this id the next time items change (after "Save a copy")
  const focusIdRef = useRef<string | null>(null);
  // hide the title bar while the viewer is open (it has its own top bar)
  useEffect(() => enterImmersive(), []);

  useEffect(() => {
    // jump to a freshly saved copy
    if (focusIdRef.current) {
      const fi = items.findIndex((it) => it.id === focusIdRef.current);
      if (fi >= 0) {
        focusIdRef.current = null;
        placedRef.current = true;
        currentIdRef.current = items[fi].id;
        setIndex(fi);
        return;
      }
    }
    if (!placedRef.current) {
      setIndex((prev) => (prev === 0 ? prev : 0));
      return;
    }
    const id = currentIdRef.current;
    if (!id) return;
    const i = items.findIndex((it) => it.id === id);
    if (i >= 0) setIndex((prev) => (prev === i ? prev : i));
  }, [items]);

  const pickSort = (f: ImgSortField) => {
    if (f === sortField) {
      const nd: SortDir = sortDir === "asc" ? "desc" : "asc";
      setSortDir(nd);
      saveImgSort(rewardKey, f, nd);
    } else {
      setSortField(f);
      setSortDir("asc");
      saveImgSort(rewardKey, f, "asc");
    }
  };

  // stat the files the first time we sort by size/date
  useEffect(() => {
    if (!isTauri() || statsLoaded.current) return;
    if (sortField !== "size" && sortField !== "edited") return;
    statsLoaded.current = true;
    const paths = rawItems.map((it) => it.path).filter((p): p is string => !!p);
    mediaStats(paths)
      .then((rows) => {
        // merge so dimensions and stats don't overwrite each other
        setStats((prev) => {
          const m = { ...prev };
          for (const r of rows) m[r.path] = { ...m[r.path], size: r.size, modified: r.modified };
          return m;
        });
      })
      .catch(() => {
        statsLoaded.current = false;
      });
  }, [sortField, rawItems]);

  // measure dimensions the first time we sort by orientation
  useEffect(() => {
    if (!isTauri() || dimsLoaded.current || sortField !== "orientation") return;
    dimsLoaded.current = true;
    const paths = rawItems.map((it) => it.path).filter((p): p is string => !!p);
    mediaDimensions(paths)
      .then((rows) => {
        setStats((prev) => {
          const m = { ...prev };
          paths.forEach((p, i) => {
            const [w, h] = rows[i] ?? [0, 0];
            m[p] = { size: m[p]?.size ?? 0, modified: m[p]?.modified ?? 0, w, h };
          });
          return m;
        });
      })
      .catch(() => {
        dimsLoaded.current = false;
      });
  }, [sortField, rawItems]);
  const [view, setView] = useState<View>(RESET);
  const [dragging, setDragging] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [shuffle, setShuffle] = useState(false);
  // slideshow speed (saved)
  const [speed, setSpeed] = useState<SlideSpeed>(() => {
    try {
      const v = localStorage.getItem("micoll.slideshowSpeed");
      return v === "medium" || v === "long" ? v : "fast";
    } catch {
      return "fast";
    }
  });
  const setSpeedPersist = (v: SlideSpeed) => {
    setSpeed(v);
    try {
      localStorage.setItem("micoll.slideshowSpeed", v);
    } catch {
      /* ignore */
    }
    queuePrefsSync();
  };
  // right-click menu of the slideshow button (speed + transition)
  const [ssMenu, setSsMenu] = useState<{ x: number; y: number } | null>(null);
  // image src per item id in srcCacheRef, so the outgoing slide keeps its old image.
  // loadTick just triggers a re-render when a new one is ready
  const [, setLoadTick] = useState(0);
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);
  // "Optimize large images": very large images get a smaller preview (files unchanged)
  const optimizeLarge = useOptimizeLargeImages();
  // direction of the last navigation (for the slide animation)
  const [dir, setDir] = useState(1);
  // transition style, saved, default slide. Old "fade" means "cut".
  const [anim, setAnim] = useState<Anim>(() => {
    try {
      const v = localStorage.getItem("micoll.viewerAnim");
      if (v === "fade" || v === "cut") return "cut"; // legacy "fade" rendered as a cut
      if (v === "crossfade") return "fade";
      return "slide";
    } catch {
      return "slide";
    }
  });
  const setAnimPersist = (v: Anim) => {
    setAnim(v);
    try {
      // real fade is saved as "crossfade" (old builds used "fade" for instant)
      localStorage.setItem("micoll.viewerAnim", v === "fade" ? "crossfade" : v);
    } catch {
      /* ignore */
    }
    queuePrefsSync();
  };
  // glow color from the current image (null for video/zip)
  const [glowColor, setGlowColor] = useState<string | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const stripRef = useRef<HTMLDivElement>(null);
  // filmstrip folder tooltip, portaled so the strip doesn't clip it
  const [folderTip, setFolderTip] = useState<{ label: string; left: number; top: number } | null>(null);
  const panRef = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null);
  // full size cache (id -> URL) so visited/preloaded images show instantly
  const srcCacheRef = useRef<Map<string, string>>(new Map());
  // neighbour preloads by id, so stale ones can be cancelled
  const warmRef = useRef<Map<string, HTMLImageElement>>(new Map());
  // the image that actually arrived on screen, neighbours are preloaded after that
  const [shownId, setShownId] = useState<string | null>(null);
  // images shown in full size although "Optimize large images" is on
  const [originals, setOriginals] = useState<Set<string>>(() => new Set());
  // id on stage in the latest render, so a load event knows if it's still current
  const stageIdRef = useRef<string | null>(null);
  const { openMenu, reveal, openExternally, requestDelete, showToast } = useActions();
  const { refresh, findArtist } = useData();

  // "Wallpaper favourites" on for this artist (local so the menu label flips right away)
  const wallpaperFavOn = !!(coverTargets?.artistId && findArtist(coverTargets.artistId)?.wallpaperFav);
  const [favPaths, setFavPaths] = useState<Set<string>>(
    () => new Set(rawItems.filter((it) => it.favWallpaper && it.path).map((it) => it.path!)),
  );
  const toggleFavWallpaper = async (path: string) => {
    const next = !favPaths.has(path);
    setFavPaths((prev) => {
      const n = new Set(prev);
      next ? n.add(path) : n.delete(path);
      return n;
    });
    try {
      await setImageWallpaperFav(path, next);
      await refresh();
    } catch (e) {
      showToast({ tone: "error", title: t("Couldn’t update favourite"), detail: `${e}` });
    }
  };

  // "Favourites" collection
  const [favoritePaths, setFavoritePaths] = useState<Set<string>>(
    () => new Set(rawItems.filter((it) => it.favorite && it.path).map((it) => it.path!)),
  );
  // ref-backed because the menu stays open and its items are a snapshot
  const favRef = useRef(favoritePaths);
  const toggleFavorite = async (path: string) => {
    const next = !favRef.current.has(path);
    const n = new Set(favRef.current);
    next ? n.add(path) : n.delete(path);
    favRef.current = n;
    setFavoritePaths(n);
    try {
      await setImageFavorite(path, next);
      await refresh();
    } catch (e) {
      showToast({ tone: "error", title: t("Couldn’t update favourite"), detail: `${e}` });
    }
  };

  // user collections + membership per file, ref-backed like favourites
  const [collections, setCollections] = useState<Collection[]>([]);
  useEffect(() => {
    if (!isTauri()) return;
    let alive = true;
    listCollections()
      .then((c) => alive && setCollections(c))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  const collRef = useRef<Map<string, Set<string>>>(
    new Map(
      rawItems
        .filter((it) => it.path)
        .map((it) => [it.path!, new Set(it.collections ?? [])] as const),
    ),
  );
  const [, bumpColl] = useState(0);
  const toggleCollection = async (path: string, id: string, name: string) => {
    const have = collRef.current.get(path) ?? new Set<string>();
    const next = !have.has(id);
    next ? have.add(id) : have.delete(id);
    collRef.current.set(path, have);
    bumpColl((n) => n + 1);
    try {
      await setImageCollection(id, path, next);
      await refresh();
      showToast({
        tone: "success",
        title: next ? `Added to “${name}”` : `Removed from “${name}”`,
      });
    } catch (e) {
      showToast({ tone: "error", title: t("Couldn’t update collection"), detail: `${e}` });
    }
  };

  // photo selection (for bulk actions from the filmstrip)
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [rename, setRename] = useState<RenameTarget[] | null>(null);
  const [editing, setEditing] = useState(false);
  const [details, setDetails] = useState(false);
  // edit versions per original path, activeId null = original
  const [verMap, setVerMap] = useState<
    Record<string, { versions: ImageVersion[]; activeId: number | null }>
  >({});
  const [versOpen, setVersOpen] = useState(false);
  // versions popover uses the dialog theme tokens (was hard-coded zinc)
  const verTheme = useDialogTheme();
  // shortcut help overlay ("?"), ref so the key handler can read it
  const [showHelp, setShowHelp] = useState(false);
  const showHelpRef = useRef(false);
  showHelpRef.current = showHelp;
  // the editor on top takes the keys (Esc would close both, the arrows switch the picture)
  const editingRef = useRef(false);
  editingRef.current = editing;
  const ssMenuRef = useRef(false);
  ssMenuRef.current = ssMenu !== null;
  // "Crop & set" cover: which image + setter + the card ratio
  const [coverCrop, setCoverCrop] = useState<{
    path: string;
    label: string;
    aspect: number;
    shapeLabel: string;
    set: (coverPath: string) => Promise<void>;
  } | null>(null);
  // share sheet for one photo or a selection (bulk decides which)
  const [sharePick, setSharePick] = useState<(ShareRequest & { bulk: boolean }) | null>(null);
  // "Send to phone" QR and "Upload to MEGA" dialogs
  const [sharing, setSharing] = useState(false);
  const [megaOpen, setMegaOpen] = useState(false);
  // sharing a selection (QR zip / MEGA folder)
  const [shareSel, setShareSel] = useState<{ srcs: string[]; name: string } | null>(null);
  const [megaSel, setMegaSel] = useState<{ srcs: string[]; name: string } | null>(null);
  // moving files into another reward
  const [moveImgs, setMoveImgs] = useState<string[] | null>(null);
  const selAnchor = useRef<number | null>(null);

  /** Move the images into a reward, then refresh and close. */
  const doMoveImages = async (rewardId: string) => {
    const ids = moveImgs ?? [];
    setMoveImgs(null);
    if (!ids.length) return;
    try {
      const n = await moveImages(ids, rewardId);
      await refresh();
      showToast({ tone: "success", title: `Moved ${n} file${n === 1 ? "" : "s"}` });
      onClose();
    } catch (e) {
      showToast({ tone: "error", title: t("Couldn’t move"), detail: `${e}` });
    }
  };

  const toggleSelect = (i: number, e: React.MouseEvent) => {
    const it = items[i];
    if (!it.name) return; // not a real file
    if (e.shiftKey && selAnchor.current != null) {
      const [a, b] = [selAnchor.current, i].sort((x, y) => x - y);
      setSelected(new Set(items.slice(a, b + 1).filter((x) => x.name).map((x) => x.id)));
    } else {
      setSelected((prev) => {
        const n = new Set(prev);
        n.has(it.id) ? n.delete(it.id) : n.add(it.id);
        return n;
      });
      selAnchor.current = i;
    }
  };

  const renameSelected = () => {
    const targets: RenameTarget[] = items
      .filter((it) => selected.has(it.id) && it.name)
      .map((it) => ({ id: it.id, name: it.name! }));
    if (targets.length) setRename(targets);
  };

  /** Creator + reward name of the current set (for MEGA folder and rename base). */
  const rewardInfo = (): { creator?: string; reward?: string } => {
    const artist = coverTargets?.artistId ? findArtist(coverTargets.artistId) : undefined;
    let reward: string | undefined;
    if (artist && coverTargets?.rewardId) {
      for (const p of artist.platforms) {
        for (const m of p.months) {
          const r = m.rewards.find((rr) => rr.id === coverTargets.rewardId);
          if (r) {
            reward = r.title;
            break;
          }
        }
        if (reward) break;
      }
    }
    return { creator: artist?.name, reward };
  };
  /** Bundle name: "creator - reward (count)", else "N photos". */
  const bundleName = (count: number) => {
    const { creator, reward } = rewardInfo();
    const stem = [creator, reward].filter(Boolean).join(" - ");
    return stem ? `${stem} (${count})` : `${count} photo${count === 1 ? "" : "s"}`;
  };
  /** MEGA rename base: creator_reward if known. */
  const renameBase = () => {
    const { creator, reward } = rewardInfo();
    return [creator, reward].filter(Boolean).join("_") || undefined;
  };

  /** Paths of the selected photos. */
  const selectedSrcs = () =>
    items.filter((it) => selected.has(it.id) && it.path).map((it) => it.path!);

  /** Paths of the selected images (not videos), the shown version. */
  const selectedStillSrcs = () =>
    items
      .filter((it) => selected.has(it.id) && it.path && it.kind !== "video" && it.kind !== "archive")
      .map((it) => it.displayPath || it.path!);

  /** "Save a copy..." of the selected photos. */
  const saveSelectedCopy = async (srcs: string[], name: string) => {
    const dir = await open({ directory: true, multiple: false, title: `Save “${name}” to…` });
    if (typeof dir !== "string") return;
    try {
      const n = await exportFiles(srcs, dir, name);
      showToast({ tone: "success", title: `Saved ${n} file${n === 1 ? "" : "s"}`, detail: `${dir}\\${name}` });
    } catch (e) {
      showToast({ tone: "error", title: t("Couldn’t save a copy"), detail: `${e}` });
    }
  };

  /** Open the share sheet for the selection. */
  const shareSelected = () => {
    const srcs = selectedSrcs();
    if (!srcs.length) return;
    setSharePick({ srcs, name: bundleName(srcs.length), bulk: true });
  };

  // bulk "delete metadata" dialog, paths captured when opened
  const [clearSrcs, setClearSrcs] = useState<string[] | null>(null);
  const doClearMeta = async (fields: PropFields) => {
    const srcs = clearSrcs ?? [];
    setClearSrcs(null);
    if (!srcs.length) return;
    try {
      const n = await clearFileProps(srcs, fields);
      showToast({
        tone: "success",
        title: `Cleared metadata from ${n} file${n === 1 ? "" : "s"}`,
      });
      setSelected(new Set());
      setSelectMode(false);
    } catch (e) {
      showToast({ tone: "error", title: t("Couldn’t clear metadata"), detail: `${e}` });
    }
  };

  // overview mode: all files as tiles like Explorer, click one to open it big.
  // The start mode is a setting, toggling here doesn't save it.
  const [grid, setGrid] = useState(getViewerStartsInGrid);
  // a single file doesn't need an overview
  const gridOn = grid && items.length > 1;
  const gridModeRef = useRef(gridOn);
  gridModeRef.current = gridOn;
  const toggleGrid = useCallback(() => setGrid(!gridModeRef.current), []);
  // tile size (Ctrl+wheel)
  const gridTiles = useCardSize("micoll.viewerGridSize", 150, 90, 320);
  // overview sections: reward files first, then one heading per subfolder.
  // from = offset so each tile knows its index in the flat list
  const gridGroups = useMemo(() => {
    const out: { group: string; from: number; items: ViewerItem[] }[] = [];
    items.forEach((it, i) => {
      const g = it.group ?? "";
      const last = out[out.length - 1];
      if (last && last.group === g) last.items.push(it);
      else out.push({ group: g, from: i, items: [it] });
    });
    return out;
  }, [items]);

  // comfy mode: fullscreen image, bars auto-hide. Saved.
  const [comfyPref, setComfy] = useState(() => {
    try {
      return localStorage.getItem("micoll.comfy") === "1";
    } catch {
      return false;
    }
  });
  const setComfyPersist = (v: boolean) => {
    setComfy(v);
    try {
      localStorage.setItem("micoll.comfy", v ? "1" : "0");
      queuePrefsSync();
    } catch {
      /* ignore */
    }
  };
  // comfy doesn't apply in the overview
  const comfy = comfyPref && !gridOn;
  const [chromeVisible, setChromeVisible] = useState(true);

  // entering the overview stops the slideshow and resets the zoom
  useEffect(() => {
    if (!gridOn) return;
    setPlaying(false);
    setView(RESET);
  }, [gridOn]);

  // with encryption, videos stream through the decrypting protocol
  const [encEnabled, setEncEnabled] = useState(false);
  useEffect(() => {
    if (!isTauri()) return;
    let alive = true;
    encryptionState()
      .then((s) => alive && setEncEnabled(s.enabled))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  // video loop (saved, on by default)
  const [loop, setLoop] = useState(() => {
    try {
      return localStorage.getItem("micoll.loop") !== "0";
    } catch {
      return true;
    }
  });
  const setLoopPersist = (v: boolean) => {
    setLoop(v);
    try {
      localStorage.setItem("micoll.loop", v ? "1" : "0");
    } catch {
      /* ignore */
    }
    queuePrefsSync();
  };

  // in comfy mode a click on the image toggles the bars
  const bump = useCallback(() => {
    if (!comfy) setChromeVisible(true);
  }, [comfy]);

  useEffect(() => {
    setChromeVisible(true); // entering or leaving comfy starts with the bars shown
  }, [comfy]);

  // single click toggles the bars in comfy mode (not while zoomed or on double click)
  const onImageClick = useCallback(
    (e: React.MouseEvent) => {
      if (!comfy || e.detail > 1 || view.scale > 1) return;
      setChromeVisible((v) => !v);
    },
    [comfy, view.scale],
  );

  const go = useCallback(
    (d: number) => {
      placedRef.current = true; // the user moved — pin to the viewed image across re-sorts
      setDir(d >= 0 ? 1 : -1);
      setView(RESET);
      setIndex((i) => (i + d + items.length) % items.length);
    },
    [items.length],
  );

  const goRandom = useCallback(() => {
    placedRef.current = true;
    setDir(1);
    setView(RESET);
    setIndex((i) => {
      if (items.length <= 1) return i;
      let n = i;
      while (n === i) n = Math.floor(Math.random() * items.length);
      return n;
    });
  }, [items.length]);

  /** Zoom by factor, keeping the point (cx, cy) in place. */
  const zoomAt = useCallback((factor: number, cx: number, cy: number) => {
    setView((v) => {
      const ns = clamp(+(v.scale * factor).toFixed(3), 1, MAX_ZOOM);
      if (ns === 1) return RESET;
      const ratio = ns / v.scale;
      return { scale: ns, tx: cx - (cx - v.tx) * ratio, ty: cy - (cy - v.ty) * ratio };
    });
  }, []);

  const zoomCenter = useCallback((factor: number) => zoomAt(factor, 0, 0), [zoomAt]);

  // double click: zoom to 200% at the cursor, or reset
  const toggleZoom = useCallback(
    (e: React.MouseEvent) => {
      const el = stageRef.current;
      if (!el) return;
      if (view.scale > 1) {
        setView(RESET);
        return;
      }
      const rect = el.getBoundingClientRect();
      const cx = e.clientX - (rect.left + rect.width / 2);
      const cy = e.clientY - (rect.top + rect.height / 2);
      zoomAt(2, cx, cy);
    },
    [view.scale, zoomAt],
  );

  // mouse Back closes the viewer: push a history entry on open, Back pops it -> close.
  // UI close pops the same entry. Cleanup doesn't touch history (StrictMode).
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const hasMarker = () =>
    !!(window.history.state && (window.history.state as { micollViewer?: boolean }).micollViewer);
  useEffect(() => {
    if (!hasMarker()) window.history.pushState({ micollViewer: true }, "");
    // only close when OUR marker is gone (a nested overlay popping its own isn't us)
    const onPop = () => {
      if (!hasMarker()) onCloseRef.current();
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  /** Close from the UI: pop our history marker. */
  const requestClose = useCallback(() => {
    if (hasMarker()) window.history.back();
    else onCloseRef.current();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (editingRef.current) return;
      bump(); // any key reveals the chrome and restarts the auto-hide timer
      if (e.key === "?") {
        e.preventDefault();
        setShowHelp((s) => !s);
      } else if (e.key === "Escape") {
        // Escape closes the slideshow menu / help first, then the viewer
        if (ssMenuRef.current) setSsMenu(null);
        else if (showHelpRef.current) setShowHelp(false);
        else requestClose();
      } else if (e.key === "ArrowRight") go(1);
      else if (e.key === "ArrowLeft") go(-1);
      else if (e.key === "+" || e.key === "=") zoomCenter(1.25);
      else if (e.key === "-") zoomCenter(1 / 1.25);
      else if (e.key === " ") {
        e.preventDefault();
        setPlaying((p) => !p);
      } else if (e.key === "g" || e.key === "G") {
        // not while typing
        const el = e.target as HTMLElement | null;
        if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        e.preventDefault();
        toggleGrid();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go, requestClose, zoomCenter, bump, toggleGrid]);

  // Ctrl+A selects all, only in selection mode
  useEffect(() => {
    if (!selectMode) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== "a" || !(e.ctrlKey || e.metaKey) || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      e.preventDefault();
      // only real files
      setSelected(new Set(items.filter((it) => it.name).map((it) => it.id)));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectMode, items]);

  // drag to pan (only when zoomed)
  useEffect(() => {
    const move = (e: MouseEvent) => {
      const p = panRef.current;
      if (!p) return;
      setView((v) => ({ ...v, tx: p.tx + (e.clientX - p.x), ty: p.ty + (e.clientY - p.y) }));
    };
    const up = () => {
      panRef.current = null;
      setDragging(false);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
  }, []);

  useEffect(() => {
    if (!playing) return;
    const t = setInterval(() => (shuffle ? goRandom() : go(1)), SPEED_MS[speed]);
    return () => clearInterval(t);
  }, [playing, shuffle, speed, go, goRandom]);

  const current = items[index] ?? items[0];

  /**
   * Delete media from the viewer. The viewer stays open and moves to a neighbour,
   * only closes when nothing is left. Works for one item or a selection.
   */
  const deleteMedia = (targets: ViewerItem[]) => {
    const real = targets.filter((t) => t.name); // only real files are deletable
    if (real.length === 0) return;
    const ids = new Set(real.map((t) => t.id));
    // remember the list before deleting
    const snapshot = items;
    const cur = current;
    const doneFocus = () => {
      const survivors = snapshot.filter((it) => !ids.has(it.id));
      if (survivors.length === 0) {
        onClose();
        return;
      }
      // stay on the current image if it wasn't deleted, else go to the next survivor
      let focusId: string | undefined;
      if (!ids.has(cur.id)) {
        focusId = cur.id;
      } else {
        const positions = [...ids]
          .map((id) => snapshot.findIndex((it) => it.id === id))
          .filter((p) => p >= 0);
        const maxPos = positions.length ? Math.max(...positions) : index;
        focusId =
          snapshot.slice(maxPos + 1).find((it) => !ids.has(it.id))?.id ??
          [...snapshot.slice(0, maxPos)].reverse().find((it) => !ids.has(it.id))?.id;
      }
      if (focusId) {
        currentIdRef.current = focusId;
        placedRef.current = true;
      }
      ids.forEach((id) => srcCacheRef.current.delete(id));
      setRemovedIds((prev) => {
        const n = new Set(prev);
        ids.forEach((id) => n.add(id));
        return n;
      });
      setSelected(new Set());
    };
    const bulk = real.length > 1;
    const allVideo = real.every((t) => t.kind === "video");
    const title = bulk
      ? `${real.length} ${allVideo ? "videos" : "items"}`
      : real[0].title;
    requestDelete({
      title,
      imageId: bulk ? undefined : real[0].id,
      imageIds: bulk ? real.map((t) => t.id) : undefined,
      onDone: doneFocus,
    });
  };

  // ---- image versions ----
  // the active version is shown/edited, path stays the original for file actions
  const curVer = current.path ? verMap[current.path] : undefined;
  const activeVersion =
    curVer && curVer.activeId != null
      ? curVer.versions.find((v) => v.id === curVer.activeId)
      : undefined;
  // once the versions are loaded, activeId null = original, so use path
  // (displayPath from the old snapshot could still point to a version)
  const curDisplayPath = curVer
    ? activeVersion?.filePath ?? current.path ?? current.displayPath
    : current.displayPath ?? current.path;
  const versionCount = curVer?.versions.length ?? current.versionCount ?? 0;
  /** The picture a tile shows: its active version (as loaded, else the snapshot's). */
  const tilePath = (it: ViewerItem) => {
    const v = it.path ? verMap[it.path] : undefined;
    if (!v) return it.displayPath ?? it.path;
    if (v.activeId == null) return it.path;
    return v.versions.find((x) => x.id === v.activeId)?.filePath ?? it.path;
  };
  const onOriginal = curVer ? curVer.activeId == null : current.onOriginal ?? true;

  // load the version list for the current original
  useEffect(() => {
    const p = current.path;
    if (!isTauri() || !p || (current.kind && current.kind !== "image")) return;
    let alive = true;
    listImageVersions(p)
      .then((r) => alive && setVerMap((m) => ({ ...m, [p]: r })))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [current.path, current.kind]);

  // reload versions + refresh the grid after a change
  const reloadVersions = useCallback(async () => {
    const p = current.path;
    if (!p) return;
    try {
      const r = await listImageVersions(p);
      setVerMap((m) => ({ ...m, [p]: r }));
    } catch {
      /* ignore */
    }
    void refresh();
  }, [current.path, refresh]);

  const switchVersion = async (versionId: number | null) => {
    if (!current.path) return;
    await setActiveVersion(current.path, versionId);
    setVersOpen(false);
    await reloadVersions();
  };
  const removeVersion = async (versionId: number) => {
    await deleteImageVersion(versionId);
    await reloadVersions();
  };

  // clear the cached URL when the shown version changes, and reset the resolution only then
  useEffect(() => {
    srcCacheRef.current.delete(current.id);
    setLoadTick((t) => t + 1);
    setDims(null);
  }, [curDisplayPath, current.id]);

  // toggling "optimize large images" changes the URLs, clear the cache
  useEffect(() => {
    srcCacheRef.current.clear();
    for (const img of warmRef.current.values()) if (!img.complete) img.removeAttribute("src");
    warmRef.current.clear();
    setLoadTick((t) => t + 1);
  }, [optimizeLarge]);

  // file size for the top bar
  const [fileBytes, setFileBytes] = useState<number | null>(null);
  useEffect(() => {
    const p = curDisplayPath;
    if (!p || !isTauri() || current.kind === "archive") {
      setFileBytes(null);
      return;
    }
    let alive = true;
    mediaStats([p])
      .then((rows) => alive && setFileBytes(rows[0]?.size ?? null))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [curDisplayPath, current.kind]);

  // with "optimize large images" get the TRUE size so the top bar can show it + "reduced"
  const [origDims, setOrigDims] = useState<{ w: number; h: number } | null>(null);
  useEffect(() => {
    setOrigDims(null);
    const p = curDisplayPath;
    if (!optimizeLarge || !isTauri() || !p || (current.kind && current.kind !== "image")) return;
    let alive = true;
    mediaDimensions([p])
      .then((rows) => {
        const [w, h] = rows[0] ?? [0, 0];
        if (alive && w && h) setOrigDims({ w, h });
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [optimizeLarge, curDisplayPath, current.kind]);
  // same threshold as serve_media in the backend
  const OPTIMIZE_THRESHOLD = 3000;
  // the original is big enough to get a reduced preview
  const bigOriginal =
    !!optimizeLarge && !!origDims && origDims.w > OPTIMIZE_THRESHOLD && origDims.h > OPTIMIZE_THRESHOLD;
  // ...and the preview is what's on screen
  const resized = bigOriginal && !originals.has(current.id);
  // real resolution when reduced, otherwise the loaded size
  const shownDims = resized ? origDims : dims;

  // add a copy from the editor to the list (same subfolder) and jump to it
  const addSavedCopy = (savedPath: string) => {
    const fileName = savedPath.split(/[\\/]/).pop() || savedPath;
    const id = `added:${savedPath}`;
    const prefix = current.title.includes(" — ") ? current.title.split(" — ")[0] : null;
    setAddedItems((prev) =>
      prev.some((it) => it.path === savedPath)
        ? prev
        : [
            ...prev,
            {
              id,
              title: prefix ? `${prefix} — ${fileName}` : fileName,
              src: "",
              path: savedPath,
              name: fileName,
              kind: "image",
              group: current.group,
            },
          ],
    );
    focusIdRef.current = id;
  };

  const isVideo = current.kind === "video";
  // archives show a zip placeholder + "show in Explorer"
  const isArchive = current.kind === "archive";

  // remember the viewed id so a re-sort keeps it
  useEffect(() => {
    currentIdRef.current = current?.id;
  });

  // URL per item id, built during render so the first frame already uses the right file
  // (not the full original). Also lets the outgoing slide keep its old picture.
  const urlFor = (item: ViewerItem | undefined): string | null => {
    if (!item || item.kind === "video" || item.kind === "archive") return null;
    const cache = srcCacheRef.current;
    const hit = cache.get(item.id);
    if (hit) return hit;
    // the shown image uses its active version, neighbours their own
    const p = item.id === current.id ? curDisplayPath : item.displayPath ?? item.path;
    const url =
      p && isTauri()
        ? optimizeLarge && !originals.has(item.id)
          ? previewUrl(p)
          : mediaUrl(p)
        : item.src ?? "";
    if (url) cache.set(item.id, url);
    return url || null;
  };

  // preload neighbours, but only after the current image arrived and not while
  // still scrolling. Old preloads are cancelled so they don't block the current one.
  useEffect(() => {
    if (isVideo || isArchive) setGlowColor(null); // no image to sample — plain black
    const warm = warmRef.current;
    const n = items.length;
    const want = n > 1 ? [items[(index + 1) % n], items[(index - 1 + n) % n]] : [];
    const wantIds = new Set(want.map((it) => it.id));
    for (const [id, img] of warm) {
      if (wantIds.has(id)) continue;
      if (!img.complete) img.removeAttribute("src"); // cancels the download
      warm.delete(id);
    }
    if (!(isVideo || isArchive || shownId === current.id)) return;
    for (const it of want) {
      if (warm.has(it.id)) continue;
      const url = urlFor(it);
      if (!url || url.startsWith("data:")) continue;
      // crossOrigin must match the visible <img> (same cache entry)
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.src = url;
      warm.set(it.id, img);
    }
    // urlFor uses the same inputs
  }, [current.id, curDisplayPath, isVideo, isArchive, index, items, optimizeLarge, originals, shownId]);

  // a scrolled-past image that hasn't loaded gives up its download (on the DOM,
  // AnimatePresence froze it). Coming back puts it back from data-src.
  useEffect(() => {
    document.querySelectorAll<HTMLImageElement>("img[data-viewer-frame]").forEach((img) => {
      if (img.dataset.viewerFrame === current.id) {
        if (!img.getAttribute("src") && img.dataset.src) img.src = img.dataset.src;
      } else if (!img.complete) {
        img.removeAttribute("src");
      }
    });
  }, [current.id]);

  /** Show the original instead of the preview, or go back. */
  const setShowOriginal = (id: string, on: boolean) => {
    setOriginals((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
    srcCacheRef.current.delete(id);
    setDims(null);
  };

  // zoomed past what the preview has -> switch to the original
  useEffect(() => {
    if (!resized || view.scale <= 1 || !dims) return;
    const img = document.querySelector<HTMLImageElement>(
      `img[data-viewer-frame="${CSS.escape(current.id)}"]`,
    );
    if (!img) return;
    const onScreen = img.clientWidth * view.scale * window.devicePixelRatio;
    if (onScreen > dims.w * 1.05) setShowOriginal(current.id, true);
  }, [view.scale, resized, dims, current.id]);

  // wheel: Ctrl = zoom to the cursor, otherwise next/previous image (throttled)
  const wheelNavRef = useRef(0);
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey) {
        e.preventDefault(); // also suppresses the webview's page zoom
        const rect = el.getBoundingClientRect();
        const cx = e.clientX - (rect.left + rect.width / 2);
        const cy = e.clientY - (rect.top + rect.height / 2);
        zoomAt(e.deltaY < 0 ? 1.15 : 1 / 1.15, cx, cy);
      } else {
        const now = Date.now();
        if (now - wheelNavRef.current < 140) return;
        wheelNavRef.current = now;
        go(e.deltaY > 0 ? 1 : -1);
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
    // gridOn is here because the stage unmounts with it
  }, [zoomAt, go, gridOn]);

  // keep the current thumbnail visible in the filmstrip
  useEffect(() => {
    const strip = stripRef.current;
    const el = strip?.children[index] as HTMLElement | undefined;
    el?.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
  }, [index]);

  const startPan = (e: React.MouseEvent) => {
    if (e.button !== 0 || view.scale <= 1) return;
    e.preventDefault();
    panRef.current = { x: e.clientX, y: e.clientY, tx: view.tx, ty: view.ty };
    setDragging(true);
  };

  const imgCursor = view.scale > 1 ? (dragging ? "grabbing" : "grab") : "default";

  // full size src for the current image from the cache (falls back in the browser)
  stageIdRef.current = current.id;
  const displaySrc = isVideo || isArchive ? "" : urlFor(current) ?? "";
  const slide = anim === "slide";
  const fade = anim === "fade";

  /** The three transitions as a menu, current one checked. */
  const ANIM_MENU: MenuItem[] = (["slide", "fade", "cut"] as Anim[]).map((a) => ({
    label: ANIM_LABEL[a],
    icon:
      a === anim ? (
        <Check className="h-4 w-4 text-brand-300" />
      ) : (
        <span className="h-4 w-4" aria-hidden />
      ),
    onClick: () => setAnimPersist(a),
  }));

  // fade the bars when comfy hides them (clicks pass through)
  const chromeFade = comfy
    ? `transition-opacity duration-500 ${chromeVisible ? "opacity-100" : "pointer-events-none opacity-0"}`
    : "";
  // arrows fade too but stay clickable (reveals the bars and navigates)
  const arrowFade = comfy
    ? `transition-opacity duration-500 ${chromeVisible ? "opacity-100" : "opacity-0"}`
    : "";

  // crop ratios (width / height). ratioHW is height / width, hence 1/x.
  // reward = page shape, creator = 4:6, month = square
  const rewardShape = useTileShapeFor(coverTargets?.shapeScope ?? "year", coverTargets?.shapeKey);
  const creatorShape = DASHBOARD_SHAPE;
  const rewardCoverAspect = 1 / rewardShape.ratioHW;
  const creatorCoverAspect = 1 / creatorShape.ratioHW;

  // one "Set as" entry with a submenu (covers, desktop wallpaper, lock screen)
  const coverItems = (path: string): MenuItem[] => {
    if (!isTauri()) return [];
    const apply = (fn: () => Promise<void>) => () => void fn().then(() => refresh());
    // one cover target: click sets it right away, hover shows "Crop & set"
    const coverRow = (
      label: string,
      aspect: number,
      shapeLabel: string,
      set: (coverPath: string) => Promise<void>,
    ): MenuItem => ({
      label,
      icon: <ImageIcon className="h-4 w-4" />,
      onClick: apply(() => set(path)),
      children: [
        {
          label: t("Crop & set"),
          icon: <Crop className="h-4 w-4" />,
          onClick: () =>
            // label is already translated, don't lowercase it
            setCoverCrop({ path, label, aspect, shapeLabel, set }),
        },
      ],
    });
    const children: MenuItem[] = [];
    // aspect = the card's ratio so the crop matches the tile
    if (coverTargets?.artistId) {
      children.push(
        coverRow(
          t("Creator cover"),
          creatorCoverAspect,
          `${creatorShape.label} ${creatorShape.ratio}`,
          (p) => setArtistPreview(coverTargets.artistId!, p),
        ),
      );
    }
    if (coverTargets?.periodId) {
      children.push(
        coverRow(t("Month cover"), 1, "Square 1:1", (p) =>
          setPeriodPreview(coverTargets.periodId!, p),
        ),
      );
    }
    if (coverTargets?.rewardId) {
      children.push(
        coverRow(t("Reward cover"), rewardCoverAspect, `${t(rewardShape.label)} ${rewardShape.ratio}`, (p) =>
          setRewardCover(coverTargets.rewardId!, p),
        ),
      );
    }
    // MiColl's own background (same as Settings -> Appearance -> Wallpaper)
    children.push({
      label: t("MiColl background"),
      icon: <Wallpaper className="h-4 w-4" />,
      onClick: () => {
        setAppWallpaper(path);
        showToast({
          tone: "success",
          title: t("MiColl background set"),
          detail: t("Settings → Appearance to dim or reset it."),
        });
      },
    });
    // MiColl's lock screen background
    children.push({
      label: t("Lock screen"),
      icon: <Lock className="h-4 w-4" />,
      onClick: () => void setSetting("lock_bg", path),
    });
    // the OS desktop background, with a selection it becomes a slideshow
    const selStills = selectedStillSrcs();
    const wpBulk = selectMode && selStills.length > 1 && selStills.includes(path);
    children.push({
      label: wpBulk
        ? tf("Desktop wallpaper ({n})", { n: selStills.length })
        : t("Desktop wallpaper"),
      icon: <Monitor className="h-4 w-4" />,
      onClick: () =>
        void (wpBulk ? setWallpaperSlideshow(selStills) : setWallpaper(path))
          .then(() =>
            showToast({
              tone: "success",
              title: wpBulk ? t("Wallpaper slideshow set") : t("Wallpaper set"),
            }),
          )
          .catch((e) => showToast({ tone: "error", title: t("Couldn’t set wallpaper"), detail: `${e}` })),
    });
    return [{ label: t("Set as"), icon: <ImageIcon className="h-4 w-4" />, children }];
  };

  // "Save a copy...": export a decrypted copy
  const saveCopy = async () => {
    if (!current.path) return;
    const dest = await save({
      defaultPath: current.name || current.title || "image",
      title: t("Save a copy"),
    });
    if (!dest) return;
    try {
      await exportFile(current.path, dest);
      showToast({ tone: "success", title: t("Saved a copy"), detail: dest });
    } catch (e) {
      showToast({ tone: "error", title: t("Couldn’t save a copy"), detail: `${e}` });
    }
  };

  // Right-click menu for media (big view and filmstrip). A filmstrip item passes
  // itself and gets shown first, so the actions work on the right photo.
  // Cover/wallpaper/edit only for images.
  const mediaMenu = (
    e: React.MouseEvent,
    target: ViewerItem = current,
    targetIndex: number = index,
  ) => {
    if (target.id !== current.id) {
      placedRef.current = true;
      setDir(targetIndex >= index ? 1 : -1);
      setView(RESET);
      setIndex(targetIndex);
    }
    const tVideo = target.kind === "video";
    const tArchive = target.kind === "archive";
    const tStill = !tVideo && !tArchive;
    const menu: MenuItem[] = [
      // a preview is shown: offer the original (and back)
      ...(tStill && target.id === current.id && bigOriginal && isTauri()
        ? [
            originals.has(target.id)
              ? {
                  label: t("Show optimized"),
                  icon: <ImageIcon className="h-4 w-4" />,
                  onClick: () => setShowOriginal(target.id, false),
                }
              : {
                  label: t("Show original"),
                  icon: <Maximize2 className="h-4 w-4" />,
                  onClick: () => setShowOriginal(target.id, true),
                },
          ]
        : []),
      // only for files MiColl can't show itself
      ...(tArchive && !isRealArchive(target)
        ? [
            {
              label: t("Open"),
              icon: <ExternalLink className="h-4 w-4" />,
              onClick: () => openExternally(target.path),
            },
          ]
        : []),
      {
        label: t("Show in Explorer"),
        icon: <FolderOpen className="h-4 w-4" />,
        onClick: () => reveal(target.path),
      },
    ];
    if (target.path && isTauri()) {
      menu.push({
        label: t("Details"),
        icon: <Info className="h-4 w-4" />,
        quick: 0,
        onClick: () => setDetails(true),
      });
    }
    // only in a collection: open the file in its real gallery
    if (onGoToFolder && target.path) {
      menu.push({
        label: t("Go to folder"),
        icon: <Images className="h-4 w-4" />,
        onClick: () => onGoToFolder(target),
      });
    }
    if ((tStill || tVideo) && target.path && isTauri()) {
      menu.push({
        label: t("Open in new window"),
        icon: <ExternalLink className="h-4 w-4" />,
        onClick: () =>
          void openInNewWindow({
            items,
            index: targetIndex,
            coverTargets,
            title: target.title,
          }),
      });
    }
    if (tStill && target.path && isTauri()) {
      menu.push({
        label: t("Edit"),
        icon: <Wand2 className="h-4 w-4" />,
        quick: 1,
        onClick: () => setEditing(true),
      });
    }
    // "Set as" uses the shown version, identity actions use the original path
    const targetDisplay =
      target.id === current.id ? curDisplayPath : target.displayPath ?? target.path;
    if (tStill && targetDisplay) menu.push(...coverItems(targetDisplay));
    if (target.path && isTauri()) {
      const isFav = favoritePaths.has(target.path);
      menu.push({
        label: isFav ? t("Remove favourite") : t("Favourite"),
        icon: <Heart className={cn("h-4 w-4", isFav && "fill-current text-rose-400")} />,
        quick: 3,
        // the one action that keeps the menu open
        keepOpen: true,
        toggled: {
          label: isFav ? t("Favourite") : t("Remove favourite"),
          icon: <Heart className={cn("h-4 w-4", !isFav && "fill-current text-rose-400")} />,
        },
        onClick: () => {
          if (target.path) void toggleFavorite(target.path);
        },
      });
    }
    // user collections, in a submenu
    if (target.path && isTauri() && collections.length > 0) {
      const path = target.path;
      const have = collRef.current.get(path) ?? new Set<string>();
      menu.push({
        label: t("Collections"),
        icon: <Images className="h-4 w-4" />,
        children: collections.map((c) => ({
          label: have.has(c.id) ? `${c.name}  ✓` : c.name,
          icon: <Images className={cn("h-4 w-4", have.has(c.id) && "text-brand-300")} />,
          onClick: () => void toggleCollection(path, c.id, c.name),
        })),
      });
    }
    if (tStill && target.path && isTauri() && wallpaperFavOn) {
      const isFav = favPaths.has(target.path);
      menu.push({
        label: isFav ? t("Remove fav. wallpaper") : t("Fav. wallpaper"),
        icon: <Star className={cn("h-4 w-4", isFav && "fill-current text-amber-400")} />,
        onClick: () => {
          if (target.path) void toggleFavWallpaper(target.path);
        },
      });
    }
    if (target.name) {
      menu.push({
        label: t("Rename"),
        icon: <Pencil className="h-4 w-4" />,
        quick: 2,
        onClick: () => setRename([{ id: target.id, name: target.name! }]),
      });
    }
    if (target.path && isTauri()) {
      menu.push({
        label: t("Move to"),
        icon: <FolderInput className="h-4 w-4" />,
        onClick: () => setMoveImgs([target.id]),
      });
    }
    if (target.path && isTauri()) {
      // with a selection, share the whole selection
      const bulkShare = selectMode && selected.size > 1 && selected.has(target.id);
      const shareSrcs = bulkShare ? selectedSrcs() : target.path ? [target.path] : [];
      const shareName = bulkShare ? bundleName(shareSrcs.length) : undefined;
      menu.push({
        label: bulkShare ? tf("Share {n} selected", { n: shareSrcs.length }) : t("Share"),
        icon: <Share2 className="h-4 w-4" />,
        onClick: () =>
          setSharePick({
            srcs: shareSrcs,
            name: shareName ?? target.name ?? target.title,
            // only an image can be copied as a picture
            image: !bulkShare && tStill ? target.path : null,
            bulk: bulkShare,
          }),
      });
    }
    // right-click on a selected item deletes the whole selection, else just this one
    const bulkDelete = selectMode && selected.size > 1 && selected.has(target.id);
    const delTargets = bulkDelete ? items.filter((it) => selected.has(it.id)) : [target];
    menu.push({
      label: bulkDelete
        ? tf("Delete {n} selected", { n: delTargets.length })
        : tVideo
          ? t("Delete video")
          : tArchive
            ? t("Delete archive")
            : t("Delete image"),
      icon: <Trash2 className="h-4 w-4" />,
      danger: true,
      onClick: () => deleteMedia(delTargets),
    });
    openMenu(e, menu);
  };

  // portal to <body> so a backdrop-filter parent can't trap the fixed viewer
  return createPortal(
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      onMouseMove={bump}
      onMouseDown={bump}
      className={cn(
        // micoll-viewer scopes the iridescent overrides (index.css)
        "micoll-viewer fixed inset-0 z-50 flex flex-col bg-black/95 backdrop-blur-sm",
      )}
    >
      {/* gradient for the iridescent button icons (used by id in index.css).
          Rendered for every accent, it draws nothing. */}
      <svg aria-hidden width="0" height="0" className="absolute">
        <defs>
          <linearGradient id="micoll-iri-ink" x1="0" y1="0" x2="1" y2="1">
            <stop className="iri-ink iri-ink-1" offset="0%" />
            <stop className="iri-ink iri-ink-2" offset="55%" />
            <stop className="iri-ink iri-ink-3" offset="100%" />
          </linearGradient>
        </defs>
      </svg>

      {/* glow behind everything: (1) a bright color from the image as a soft glow,
          (2) a blurred copy of the image for the natural color bleed, crossfaded. */}
      <div aria-hidden className="pointer-events-none absolute inset-0 -z-10 overflow-hidden isolate">
        {/* bright base glow reaching the side bars */}
        <div
          className="absolute inset-0"
          style={{
            background: glowColor
              ? `radial-gradient(circle at 50% 47%, ${glowColor} 0%, ${glowColor} 12%, transparent 55%)`
              : undefined,
            opacity: glowColor ? 0.32 : 0,
            transition: "background 500ms ease, opacity 500ms ease",
          }}
        />
        {/* blurred image copy, lighten blend over the base */}
        <AnimatePresence>
          {displaySrc && (
            <motion.div
              key={current.id}
              initial={{ opacity: 0 }}
              animate={{ opacity: 0.42 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.5, ease: "easeInOut" }}
              className="absolute inset-0 flex items-center justify-center"
              style={{ mixBlendMode: "lighten" }}
            >
              <img
                src={displaySrc}
                data-viewer-frame={current.id}
                data-src={displaySrc}
                draggable={false}
                className="max-h-full max-w-full select-none object-contain"
                style={{ filter: "blur(28px) saturate(1.6)", transform: "scale(1.03)" }}
              />
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* top controls, empty space drags the window */}
      <div
        data-tauri-drag-region
        className={cn(
          "flex items-center justify-between px-5 py-3 text-zinc-300",
          comfy && "absolute inset-x-0 top-0 z-20 bg-gradient-to-b from-black/80 via-black/40 to-transparent",
          chromeFade,
        )}
      >
        <div data-tauri-drag-region className="min-w-0">
          <div className="truncate text-sm font-medium text-zinc-100">{current.title}</div>
          <div className="text-xs text-zinc-500">
            {gridOn ? tp("{n} files", items.length) : `${index + 1} of ${items.length}`}
            {!comfy && shownDims ? ` · ${shownDims.w} × ${shownDims.h} px` : ""}
            {!comfy && resized && (
              <span
                title={t("Shown at reduced size for smooth scrolling — the original file is unchanged")}
                className="ml-1.5 inline-flex items-center rounded-full bg-white/10 px-1.5 py-px text-[10px] font-medium text-zinc-300 ring-1 ring-inset ring-white/15"
              >
                optimized
              </span>
            )}
            {!comfy && fileBytes != null ? ` · ${fmtSize(fileBytes)}` : ""}
          </div>
        </div>
        <div className="flex items-center gap-1">
          {items.length > 1 && (
            <SortControl field={sortField} dir={sortDir} onPick={pickSort} />
          )}
          {isVideo ? (
            <ViewerBtn
              onClick={() => setLoopPersist(!loop)}
              title={loop ? "Repeat: on" : "Repeat: off"}
              active={loop}
            >
              <Repeat className="h-5 w-5" />
            </ViewerBtn>
          ) : gridOn || comfy || isArchive ? null : (
            <>
              <ViewerBtn onClick={() => zoomCenter(1 / 1.25)} title={t("Zoom out (−)")}>
                <ZoomOut className="h-5 w-5" />
              </ViewerBtn>
              <span className="w-12 text-center text-xs tabular-nums text-zinc-400">
                {Math.round(view.scale * 100)}%
              </span>
              <ViewerBtn onClick={() => zoomCenter(1.25)} title={t("Zoom in (+)")}>
                <ZoomIn className="h-5 w-5" />
              </ViewerBtn>
            </>
          )}
          {!gridOn && !isVideo && !isArchive && current.path && isTauri() && (
            <ViewerBtn onClick={() => setEditing(true)} title={t("Edit (object remover)")}>
              <Wand2 className="h-5 w-5" />
            </ViewerBtn>
          )}
          {!gridOn && !isVideo && !isArchive && current.path && isTauri() && versionCount > 0 && (
            <div className="relative">
              <ViewerBtn
                onClick={() => setVersOpen((o) => !o)}
                title={`Versions (${versionCount})`}
                active={versOpen || !onOriginal}
              >
                <Layers className="h-5 w-5" />
              </ViewerBtn>
              {!onOriginal && (
                <span className="pointer-events-none absolute right-1 top-1 h-2 w-2 rounded-full bg-brand-400 ring-2 ring-black/70" />
              )}
              {versOpen && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setVersOpen(false)} />
                  {/* theme surface first, our classes last (see ThemedSelect) */}
                  <div
                    className={cn(
                      verTheme.menu,
                      "absolute right-0 top-full z-50 mt-1.5 w-64 p-1",
                    )}
                  >
                    <VersionRow
                      active={onOriginal}
                      label={t("Original")}
                      onClick={() => void switchVersion(null)}
                      rowIdle={verTheme.menuRow}
                      rowActive={verTheme.menuRowOpen}
                      tick={verTheme.accentText}
                    />
                    <div className={cn("my-1 border-t", verTheme.divider)} />
                    {(curVer?.versions ?? []).map((v, i) => (
                      <VersionRow
                        key={v.id}
                        active={curVer?.activeId === v.id}
                        label={v.label || `Edit ${i + 1}`}
                        sub={v.createdAt ?? undefined}
                        onClick={() => void switchVersion(v.id)}
                        onDelete={() => void removeVersion(v.id)}
                        rowIdle={verTheme.menuRow}
                        rowActive={verTheme.menuRowOpen}
                        tick={verTheme.accentText}
                      />
                    ))}
                  </div>
                </>
              )}
            </div>
          )}
          {items.length > 1 && (
            <ViewerBtn
              onClick={toggleGrid}
              title={t("Overview — every file as a tile (G)")}
              active={gridOn}
            >
              <LayoutGrid className="h-5 w-5" />
            </ViewerBtn>
          )}
          <ViewerBtn
            onClick={() => {
              setSelectMode((s) => !s);
              setSelected(new Set());
            }}
            title={t("Select photos (for bulk rename)")}
            active={selectMode}
          >
            <CheckSquare className="h-5 w-5" />
          </ViewerBtn>
          {!gridOn && (
            <>
          <ViewerBtn
            onClick={() => setPlaying((p) => !p)}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setSsMenu({ x: e.clientX, y: e.clientY });
            }}
            title={t("Slideshow (space) — right-click for options")}
            active={playing}
          >
            {playing ? <Pause className="h-5 w-5" /> : <Play className="h-5 w-5" />}
          </ViewerBtn>
          <ViewerBtn
            onClick={() => setAnimPersist(NEXT_ANIM[anim])}
            // right-click picks one directly (cycling through 3 is annoying)
            onContextMenu={(e) => openMenu(e, ANIM_MENU)}
            title={`Transition: ${ANIM_LABEL[anim].toLowerCase()} — click to cycle, right-click to pick`}
            active={slide || fade}
          >
            <ArrowLeftRight className="h-5 w-5" />
          </ViewerBtn>
          <ViewerBtn
            onClick={() => setComfyPersist(!comfyPref)}
            title={t("Comfy mode — full image, bars auto-hide")}
            active={comfyPref}
          >
            <Maximize2 className="h-5 w-5" />
          </ViewerBtn>
            </>
          )}
          <ViewerBtn
            onClick={() => setShowHelp((s) => !s)}
            title={t("Keyboard shortcuts (?)")}
            active={showHelp}
          >
            <HelpCircle className="h-5 w-5" />
          </ViewerBtn>
          <ViewerBtn onClick={requestClose} title={t("Close (Esc)")}>
            <X className="h-5 w-5" />
          </ViewerBtn>
        </div>
      </div>

      {/* selection buttons in their own row under the close button (absolute so the
          image keeps its size). Fades with the bars in comfy mode. */}
      {selectMode && selected.size > 0 && (
        <div
          className={cn(
            "absolute right-5 top-[4.5rem] z-30 flex items-center gap-1",
            chromeFade,
          )}
        >
          <span className="px-1 text-xs text-zinc-400">{selected.size} selected</span>
          {isTauri() && (
            <ViewerBtn onClick={shareSelected} title={t("Share selected photos")}>
              <Share2 className="h-5 w-5" />
            </ViewerBtn>
          )}
          {isTauri() && (
            <ViewerBtn
              onClick={() => setMoveImgs([...selected])}
              title={t("Move selected files to another reward")}
            >
              <FolderInput className="h-5 w-5" />
            </ViewerBtn>
          )}
          <ViewerBtn onClick={renameSelected} title={t("Rename selected photos")}>
            <Pencil className="h-5 w-5" />
          </ViewerBtn>
          {isTauri() && (
            <ViewerBtn
              onClick={() => setClearSrcs(selectedSrcs())}
              title={t("Delete metadata from selected files")}
            >
              <Eraser className="h-5 w-5" />
            </ViewerBtn>
          )}
          <ViewerBtn
            onClick={() => deleteMedia(items.filter((it) => selected.has(it.id)))}
            title={t("Delete selected files")}
          >
            <Trash2 className="h-5 w-5" />
          </ViewerBtn>
        </div>
      )}

      {gridOn ? (
        /* Overview: all files as tiles by folder. Wheel scrolls, Ctrl+wheel resizes. */
        <div
          ref={gridTiles.ref}
          className={cn(
            "flex-1 overflow-y-auto px-5 pb-8",
            // here the selection row would cover the first tiles
            selectMode && selected.size > 0 ? "pt-16" : "pt-2",
          )}
        >
          {gridGroups.map((g) => (
            <div key={g.group || "__own__"} className="mb-6 last:mb-0">
              {g.group && (
                <div className="mb-2 flex items-center gap-2 text-[11px] font-medium uppercase tracking-wide text-zinc-400">
                  {/* label stays neutral, the marker uses the accent */}
                  <FolderOpen className={cn("h-3.5 w-3.5 shrink-0", verTheme.accentText)} />
                  <span className="truncate">{g.group}</span>
                  <span className="h-px flex-1 bg-white/10" />
                  <span className="shrink-0 tabular-nums text-zinc-500">{g.items.length}</span>
                </div>
              )}
              <div
                className="grid gap-3"
                style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${gridTiles.size}px, 1fr))` }}
              >
                {g.items.map((it, j) => {
                  const i = g.from + j;
                  const isSel = selected.has(it.id);
                  // the loaded list is fresher than the snapshot (a version saved just now)
                  const vers = it.path ? verMap[it.path]?.versions.length ?? it.versionCount ?? 0 : 0;
                  return (
                    <button
                      key={it.id}
                      onClick={(e) => {
                        // in selection mode a tile is a checkbox
                        if (selectMode) {
                          toggleSelect(i, e);
                          return;
                        }
                        placedRef.current = true;
                        setDir(i >= index ? 1 : -1);
                        setView(RESET);
                        setIndex(i);
                        // the button (or G) brings the tiles back
                        setGrid(false);
                      }}
                      onContextMenu={(e) => mediaMenu(e, it, i)}
                      title={it.name ?? it.title}
                      // same hooks as the filmstrip so the premium themes style the marked
                      // tile
                      data-sel={selectMode && isSel ? "" : undefined}
                      data-current={i === index && !selectMode ? "" : undefined}
                      className={cn(
                        "viewer-thumb relative aspect-square overflow-hidden rounded-lg ring-2 transition-all",
                        selectMode && isSel
                          ? "ring-brand-500"
                          : i === index && !selectMode
                            ? "ring-brand-500"
                            : "ring-transparent hover:ring-white/40",
                      )}
                    >
                      <Cover path={tilePath(it)} seed={it.title} size={256} rounded="rounded-none" />
                      {it.kind === "video" && (
                        <span className="pointer-events-none absolute inset-0 grid place-items-center">
                          <PlayCircle className="h-7 w-7 text-white drop-shadow-[0_1px_3px_rgba(0,0,0,0.9)]" />
                        </span>
                      )}
                      {it.kind === "archive" && (
                        <span className="pointer-events-none absolute inset-0 grid place-items-center bg-black/30">
                          {isRealArchive(it) ? (
                            <FileArchive className="h-7 w-7 text-amber-300 drop-shadow-[0_1px_3px_rgba(0,0,0,0.9)]" />
                          ) : (
                            <FileGeneric className="h-7 w-7 text-sky-300 drop-shadow-[0_1px_3px_rgba(0,0,0,0.9)]" />
                          )}
                        </span>
                      )}
                      {/* file name under the tile */}
                      <span className="pointer-events-none absolute inset-x-0 bottom-0 block truncate bg-gradient-to-t from-black/90 via-black/60 to-transparent px-1.5 pb-1 pt-5 text-left text-[11px] text-zinc-100">
                        {it.name ?? it.title}
                      </span>
                      {/* has edit versions: same icon as the versions button, left of the checkbox */}
                      {vers > 0 && (
                        <span
                          title={`Versions (${vers})`}
                          className={cn(
                            "viewer-thumb-versions absolute top-1.5 flex h-5 w-5 items-center justify-center rounded-md bg-black/60 ring-1 ring-white/15 backdrop-blur-sm",
                            selectMode ? "right-7" : "right-1.5",
                            verTheme.accentText,
                          )}
                        >
                          <Layers className="h-3 w-3 drop-shadow-[0_1px_2px_rgba(0,0,0,0.8)]" />
                        </span>
                      )}
                      {selectMode && (
                        <span
                          data-sel={isSel ? "" : undefined}
                          className={cn(
                            "viewer-thumb-check absolute right-1.5 top-1.5 flex h-4 w-4 items-center justify-center rounded border",
                            isSel
                              ? "border-brand-400 bg-brand-500 text-white"
                              : "border-zinc-300 bg-black/50 text-transparent",
                          )}
                        >
                          <CheckSquare className="h-3 w-3" strokeWidth={3} />
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <>
      {/* stage */}
      <div
        ref={stageRef}
        className={cn(
          "items-center justify-center overflow-hidden px-16",
          comfy ? "absolute inset-0 flex" : "relative flex flex-1",
          // in comfy the filmstrip covers the bottom, so videos move up to keep their
          // controls
          comfy && isVideo && "pb-24",
        )}
      >
        <ViewerBtn
          onClick={() => go(-1)}
          className={cn("absolute left-4 top-1/2 z-10 -translate-y-1/2", arrowFade)}
          title={t("Previous (←)")}
        >
          <ChevronLeft className="h-7 w-7" />
        </ViewerBtn>

        <AnimatePresence custom={dir} mode={slide ? "sync" : "wait"} initial={false}>
          <motion.div
            key={current.id}
            custom={dir}
            variants={slide ? slideVariants : undefined}
            // cut = instant, fade = out then in (mode="wait")
            initial={slide ? "enter" : fade ? { opacity: 0 } : false}
            animate={slide ? "center" : { opacity: 1 }}
            exit={slide ? "exit" : fade ? { opacity: 0 } : { opacity: 1 }}
            transition={
              slide
                ? { x: { type: "spring", stiffness: 320, damping: 34 }, opacity: { duration: 0.18 } }
                : { duration: fade ? 0.22 : 0 }
            }
            className={cn(
              "flex h-full w-full items-center justify-center",
              // slide needs both frames stacked (absolute)
              slide && "absolute inset-0",
            )}
          >
            {isVideo ? (
              current.src || (encEnabled && current.path) ? (
                <video
                  key={current.id}
                  // start quieter
                  ref={(el) => {
                    if (el) el.volume = 0.3;
                  }}
                  src={encEnabled && current.path ? mediaUrl(current.path) : current.src}
                  controls
                  autoPlay
                  loop={loop}
                  onLoadedMetadata={(e) =>
                    setDims({ w: e.currentTarget.videoWidth, h: e.currentTarget.videoHeight })
                  }
                  // rename the audio session for the volume mixer (it only exists once
                  // something plays)
                  onPlay={() => void claimAudioName().catch(() => {})}
                  onContextMenu={mediaMenu}
                  className="max-h-full max-w-full rounded-lg bg-black shadow-2xl"
                />
              ) : (
                <div
                  className="grid h-[60vh] w-[42vh] max-w-full place-items-center rounded-lg"
                  style={{ background: seedGradient(current.title) }}
                >
                  <PlayCircle className="h-16 w-16 text-white/70" />
                </div>
              )
            ) : isArchive ? (
              <div
                className="flex h-[60vh] w-[42vh] max-w-full flex-col items-center justify-center gap-4 rounded-lg p-6 text-center"
                style={{ background: seedGradient(current.title) }}
                onContextMenu={mediaMenu}
              >
                {isRealArchive(current) ? (
                  <FileArchive className="h-20 w-20 text-amber-300/90 drop-shadow-[0_2px_6px_rgba(0,0,0,0.8)]" />
                ) : (
                  <FileGeneric className="h-20 w-20 text-sky-300/90 drop-shadow-[0_2px_6px_rgba(0,0,0,0.8)]" />
                )}
                <span className="line-clamp-2 text-sm font-medium text-white">
                  {current.name ?? current.title}
                </span>
                <span className="text-xs text-white/70">
                  {isRealArchive(current)
                    ? t("MiColl can’t display this file type — it opens in Explorer instead.")
                    : t("MiColl can’t display this file type — it opens in its own app.")}
                </span>
                {current.path && isTauri() && (
                  // archives still go to Explorer, everything else opens
                  <button
                    onClick={() =>
                      isRealArchive(current) ? reveal(current.path) : openExternally(current.path)
                    }
                    title={
                      isRealArchive(current)
                        ? "Reveal this archive in Explorer to extract it"
                        : "Open this file with the app Windows uses for its type"
                    }
                    className="inline-flex items-center gap-1.5 rounded-lg bg-zinc-800/70 px-3 py-2 text-sm text-zinc-100 backdrop-blur transition-colors micoll-hover"
                  >
                    {isRealArchive(current) ? (
                      <FolderOpen className="h-4 w-4" />
                    ) : (
                      <ExternalLink className="h-4 w-4" />
                    )}
                    {isRealArchive(current) ? t("Show in Explorer") : t("Open")}
                  </button>
                )}
              </div>
            ) : displaySrc ? (
              <img
                src={displaySrc}
                data-viewer-frame={current.id}
                data-src={displaySrc}
                alt={current.title}
                // CORS so the glow sampler can read the image
                crossOrigin="anonymous"
                draggable={false}
                onMouseDown={startPan}
                onClick={onImageClick}
                onDoubleClick={toggleZoom}
                onLoad={(e) => {
                  // an outgoing frame that finishes loading must not update the
                  // size/glow/preload
                  if (stageIdRef.current !== current.id) return;
                  setDims({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight });
                  setGlowColor(vibrantColor(e.currentTarget));
                  setShownId(current.id);
                }}
                style={{
                  transform: `translate(${view.tx}px, ${view.ty}px) scale(${view.scale})`,
                  cursor: imgCursor,
                  // smooth zoom, 1:1 while panning
                  transition: dragging ? "none" : "transform 180ms ease-out",
                }}
                onContextMenu={mediaMenu}
                className="max-h-full max-w-full select-none rounded-lg object-contain shadow-2xl"
              />
            ) : (
              <div
                className="h-[60vh] w-[42vh] max-w-full rounded-lg"
                style={{ background: seedGradient(current.title) }}
              />
            )}
          </motion.div>
        </AnimatePresence>

        <ViewerBtn
          onClick={() => go(1)}
          className={cn("absolute right-4 top-1/2 z-10 -translate-y-1/2", arrowFade)}
          title={t("Next (→)")}
        >
          <ChevronRight className="h-7 w-7" />
        </ViewerBtn>
      </div>

      {/* filmstrip, wheel scrolls it sideways */}
      <div
        ref={stripRef}
        className={cn(
          "flex items-center gap-2 overflow-x-auto px-5 py-3",
          comfy && "absolute inset-x-0 bottom-0 z-20 bg-gradient-to-t from-black/80 via-black/40 to-transparent",
          chromeFade,
        )}
        onWheel={(e) => {
          if (e.deltaY !== 0) e.currentTarget.scrollLeft += e.deltaY;
        }}
      >
        {items.map((it, i) => {
          const isSel = selected.has(it.id);
          // mark where a subfolder starts (name on hover)
          const folderStart = !!it.group && it.group !== items[i - 1]?.group;
          return (
            <Fragment key={it.id}>
              {folderStart && (
                <div
                  className="group/sep flex h-14 shrink-0 cursor-default items-center px-1"
                  aria-label={it.group}
                  onMouseEnter={(e) => {
                    const r = e.currentTarget.getBoundingClientRect();
                    setFolderTip({ label: it.group as string, left: r.left + r.width / 2, top: r.top });
                  }}
                  onMouseLeave={() => setFolderTip(null)}
                >
                  <span className="h-9 w-px rounded-full bg-white/30 transition-colors group-hover/sep:bg-white/70" />
                </div>
              )}
            <button
              onClick={(e) => {
                // always show the clicked photo big
                if (selectMode) toggleSelect(i, e);
                placedRef.current = true;
                setDir(i >= index ? 1 : -1);
                setView(RESET);
                setIndex(i);
              }}
              onContextMenu={(e) => mediaMenu(e, it, i)}
              // viewer-thumb + data-sel / data-current are hooks for the premium themes
              // (index.css)
              data-sel={selectMode && isSel ? "" : undefined}
              data-current={i === index && !selectMode ? "" : undefined}
              className={cn(
                "viewer-thumb relative h-14 w-14 shrink-0 overflow-hidden rounded-lg ring-2 transition-all",
                selectMode && isSel
                  ? "ring-brand-500"
                  : i === index && !selectMode
                    ? "ring-brand-500"
                    : "ring-transparent opacity-50 hover:opacity-90",
              )}
            >
              <Cover path={tilePath(it)} seed={it.title} size={128} rounded="rounded-none" />
              {it.kind === "video" && (
                <span className="pointer-events-none absolute inset-0 grid place-items-center">
                  <PlayCircle className="h-5 w-5 text-white drop-shadow-[0_1px_3px_rgba(0,0,0,0.9)]" />
                </span>
              )}
              {it.kind === "archive" && (
                <span className="pointer-events-none absolute inset-0 grid place-items-center bg-black/30">
                  {isRealArchive(it) ? (
                    <FileArchive className="h-5 w-5 text-amber-300 drop-shadow-[0_1px_3px_rgba(0,0,0,0.9)]" />
                  ) : (
                    <FileGeneric className="h-5 w-5 text-sky-300 drop-shadow-[0_1px_3px_rgba(0,0,0,0.9)]" />
                  )}
                </span>
              )}
              {selectMode && (
                <span
                  data-sel={isSel ? "" : undefined}
                  className={cn(
                    "viewer-thumb-check absolute right-1 top-1 flex h-4 w-4 items-center justify-center rounded border",
                    isSel ? "border-brand-400 bg-brand-500 text-white" : "border-zinc-300 bg-black/50 text-transparent",
                  )}
                >
                  <CheckSquare className="h-3 w-3" strokeWidth={3} />
                </span>
              )}
            </button>
            </Fragment>
          );
        })}
      </div>
        </>
      )}

      {/* folder tooltip, portaled so the strip doesn't clip it */}
      {folderTip &&
        createPortal(
          <div
            style={{ left: folderTip.left, top: folderTip.top - 8 }}
            className="pointer-events-none fixed z-[120] -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-md bg-black/90 px-2 py-1 text-[11px] font-medium text-white shadow-lg ring-1 ring-white/15"
          >
            {folderTip.label}
          </div>,
          document.body,
        )}

      {rename && (
        <RenameDialog
          kind="image"
          targets={rename}
          onClose={() => setRename(null)}
          onDone={() => {
            void refresh();
            setSelected(new Set());
            setSelectMode(false);
          }}
        />
      )}

      <AnimatePresence>
        {editing && current.path && (
          <ImageEditor
            // edit what's shown, but attach versions to the ORIGINAL
            path={curDisplayPath ?? current.path}
            origPath={current.path}
            name={current.name ?? current.title}
            onClose={() => setEditing(false)}
            onSavedCopy={(savedPath) => {
              addSavedCopy(savedPath);
              void refresh();
            }}
            onSavedVersion={() => {
              void reloadVersions();
            }}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {showHelp && <ShortcutHelp isVideo={isVideo} onClose={() => setShowHelp(false)} />}
      </AnimatePresence>

      {/* slideshow options menu. Own menu because rows change in place (ContextMenu
          closes). */}
      {ssMenu && (
        <div
          className="fixed inset-0 z-[100]"
          onClick={() => setSsMenu(null)}
          onContextMenu={(e) => {
            e.preventDefault();
            setSsMenu(null);
          }}
        >
          <div
            className="absolute min-w-[12rem] rounded-xl border border-zinc-700 bg-zinc-900/95 py-1 shadow-2xl backdrop-blur"
            style={{
              left: Math.min(ssMenu.x, window.innerWidth - 220),
              top: Math.min(ssMenu.y, window.innerHeight - 132),
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              onClick={() => setSpeedPersist(NEXT_SPEED[speed])}
              className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm text-zinc-200 transition-colors micoll-hover"
            >
              <Timer className="h-4 w-4 text-zinc-400" />
              <span className="flex-1">{t("Speed")}</span>
              <span className="font-medium text-brand-300">{SPEED_LABEL[speed]}</span>
            </button>
            <button
              onClick={() => setAnimPersist(NEXT_ANIM[anim])}
              className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm text-zinc-200 transition-colors micoll-hover"
            >
              <ArrowLeftRight className="h-4 w-4 text-zinc-400" />
              <span className="flex-1">{t("Transition")}</span>
              <span className="font-medium text-brand-300">{ANIM_LABEL[anim]}</span>
            </button>
            <button
              onClick={() => setShuffle((s) => !s)}
              className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm text-zinc-200 transition-colors micoll-hover"
            >
              <Shuffle className="h-4 w-4 text-zinc-400" />
              <span className="flex-1">{t("Shuffle")}</span>
              <span className={cn("font-medium", shuffle ? "text-brand-300" : "text-zinc-500")}>
                {shuffle ? "On" : "Off"}
              </span>
            </button>
          </div>
        </div>
      )}

      <AnimatePresence>
        {coverCrop && (
          <CoverCropModal
            path={coverCrop.path}
            targetLabel={coverCrop.label}
            aspect={coverCrop.aspect}
            shapeLabel={coverCrop.shapeLabel}
            onCancel={() => setCoverCrop(null)}
            onConfirm={async (b64) => {
              const coverPath = await saveCoverCrop(b64);
              await coverCrop.set(coverPath);
              await refresh();
              setCoverCrop(null);
              showToast({ tone: "success", title: t("Cover set") });
            }}
          />
        )}
      </AnimatePresence>

      {sharePick && (
        <ShareSheet
          req={sharePick}
          onPhone={() =>
            sharePick.bulk
              ? setShareSel({ srcs: sharePick.srcs, name: sharePick.name })
              : setSharing(true)
          }
          onMega={() =>
            sharePick.bulk
              ? setMegaSel({ srcs: sharePick.srcs, name: sharePick.name })
              : setMegaOpen(true)
          }
          onSaveCopy={() =>
            sharePick.bulk
              ? void saveSelectedCopy(sharePick.srcs, sharePick.name)
              : void saveCopy()
          }
          onClose={() => setSharePick(null)}
        />
      )}

      <AnimatePresence>
        {sharing && current.path && (
          <SharePhoneModal path={current.path} onClose={() => setSharing(false)} />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {megaOpen && current.path && (
          <MegaUploadModal
            path={current.path}
            name={current.name ?? current.title}
            renameBase={renameBase()}
            onClose={() => setMegaOpen(false)}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {shareSel && (
          <SharePhoneModal
            srcs={shareSel.srcs}
            name={shareSel.name}
            onClose={() => setShareSel(null)}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {megaSel && (
          <MegaUploadModal
            srcs={megaSel.srcs}
            name={megaSel.name}
            renameBase={renameBase()}
            onClose={() => setMegaSel(null)}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {details && (
          <DetailsPanel item={current} dims={dims} isVideo={isVideo} onClose={() => setDetails(false)} />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {moveImgs && (
          <MovePicker
            mode="images"
            count={moveImgs.length}
            fromArtistId={coverTargets?.artistId}
            excludeMonthId={coverTargets?.periodId}
            excludeRewardId={coverTargets?.rewardId}
            onPick={(dest) => dest.rewardId && void doMoveImages(dest.rewardId)}
            onClose={() => setMoveImgs(null)}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {clearSrcs && (
          <ClearMetaDialog
            srcs={clearSrcs}
            onApply={(f) => void doClearMeta(f)}
            onClose={() => setClearSrcs(null)}
          />
        )}
      </AnimatePresence>
    </motion.div>,
    document.body,
  );
}

const fmtSize = (b: number) =>
  b <= 0
    ? "—"
    : b < 1024
      ? `${b} B`
      : b < 1024 * 1024
        ? `${(b / 1024).toFixed(1)} KB`
        : b < 1024 * 1024 * 1024
          ? `${(b / (1024 * 1024)).toFixed(1)} MB`
          : `${(b / (1024 * 1024 * 1024)).toFixed(2)} GB`;

/**
 * Details panel: name, type, size, date and location. The name can be edited
 * (renames on disk, keeps the extension).
 */
function DetailsPanel({
  item,
  dims,
  isVideo,
  onClose,
}: {
  item: ViewerItem;
  dims: { w: number; h: number } | null;
  isVideo: boolean;
  onClose: () => void;
}) {
  const t = useT();
  const tp = useTp();
  const { showToast, reveal } = useActions();
  const { refresh } = useData();
  const { panel, field, divider, primary, accentText } = useDialogTheme();
  const [stat, setStat] = useState<{ size: number; modified: number } | null>(null);

  const full = item.name ?? item.title;
  const dot = full.lastIndexOf(".");
  const ext = dot > 0 ? full.slice(dot) : "";
  const baseName = dot > 0 ? full.slice(0, dot) : full;
  const [stem, setStem] = useState(baseName);
  const [saving, setSaving] = useState(false);

  const canRename = !!item.name && isTauri();
  const dirty = canRename && !!stem.trim() && stem.trim() !== baseName;
  const folder = item.path ? item.path.replace(/[\\/][^\\/]*$/, "") : "";

  // Advanced: Windows file properties (Title/Subject/Rating/Tags/Comments)
  const [adv, setAdv] = useState(false);
  const [fp, setFp] = useState<FileProps | null>(null);
  const [tagsText, setTagsText] = useState("");
  const [fpErr, setFpErr] = useState<string | null>(null);
  const [fpLoading, setFpLoading] = useState(false);
  const [fpSaving, setFpSaving] = useState(false);

  const toggleAdvanced = () => {
    const next = !adv;
    setAdv(next);
    if (next && !fp && !fpErr && item.path) {
      setFpLoading(true);
      setFpErr(null);
      readFileProps(item.path)
        .then((p) => {
          setFp(p);
          setTagsText(p.tags.join(", "));
        })
        .catch((e) => setFpErr(`${e}`))
        .finally(() => setFpLoading(false));
    }
  };

  const saveProps = async () => {
    if (!fp || !item.path) return;
    setFpSaving(true);
    const payload: FileProps = {
      ...fp,
      tags: tagsText.split(",").map((t) => t.trim()).filter(Boolean),
    };
    try {
      await writeFileProps(item.path, payload);
      setFp(payload);
      setTagsText(payload.tags.join(", "));
      showToast({ tone: "success", title: t("Properties saved"), detail: t("Written into the file") });
    } catch (e) {
      showToast({ tone: "error", title: t("Couldn’t save properties"), detail: `${e}` });
    } finally {
      setFpSaving(false);
    }
  };

  useEffect(() => {
    if (!item.path || !isTauri()) return;
    let alive = true;
    mediaStats([item.path])
      .then((rows) => {
        if (alive && rows[0]) setStat({ size: rows[0].size, modified: rows[0].modified });
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [item.path]);

  const saveName = async () => {
    if (!dirty) return;
    setSaving(true);
    try {
      await renameImages([{ id: item.id, name: stem.trim() }]);
      await refresh();
      showToast({ tone: "success", title: t("Renamed"), detail: `${stem.trim()}${ext}` });
      onClose();
    } catch (e) {
      showToast({ tone: "error", title: t("Couldn’t rename"), detail: `${e}` });
    } finally {
      setSaving(false);
    }
  };

  const rows: [string, React.ReactNode][] = [
    ["Type", isVideo ? "Video" : "Image"],
    ["Dimensions", dims ? `${dims.w} × ${dims.h} px` : "—"],
    ["Size", stat ? fmtSize(stat.size) : "—"],
    ["Modified", stat?.modified ? new Date(stat.modified).toLocaleString() : "—"],
  ];

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      onClick={onClose}
      className="absolute inset-0 z-[60] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
    >
      <motion.div
        initial={{ scale: 0.96, opacity: 0, y: 8 }}
        animate={{ scale: 1, opacity: 1, y: 0 }}
        exit={{ scale: 0.96, opacity: 0, y: 8 }}
        onClick={(e) => e.stopPropagation()}
        // max height + scroll so Advanced doesn't push it off screen
        className={cn("flex max-h-[88vh] w-[28rem] max-w-[92vw] flex-col overflow-hidden", panel)}
      >
        <div className={cn("flex shrink-0 items-center justify-between border-b px-5 py-3", divider)}>
          <h2 className="flex items-center gap-2 text-sm font-semibold text-zinc-100">
            <Info className={cn("h-4 w-4", accentText)} />
            {t("Details")}
          </h2>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-300" title={t("Close (Esc)")}>
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {/* name (editable) */}
          <label className="block text-xs font-medium uppercase tracking-wide text-zinc-500">
            {t("Name")}
          </label>
          <div className="mt-1.5 flex items-center gap-2">
            <div className={cn("flex min-w-0 flex-1 items-center px-2.5 py-2", field)}>
              <input
                value={stem}
                onChange={(e) => setStem(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void saveName();
                }}
                disabled={!canRename}
                spellCheck={false}
                className="min-w-0 flex-1 bg-transparent text-sm text-zinc-100 outline-none disabled:opacity-60"
              />
              {ext && <span className="shrink-0 text-sm text-zinc-500">{ext}</span>}
            </div>
            <button
              onClick={() => void saveName()}
              disabled={!dirty || saving}
              title={t("Rename file")}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium text-white transition-colors disabled:opacity-40",
                primary ?? "bg-brand-600 hover:bg-brand-500",
              )}
            >
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
              Save
            </button>
          </div>

          {/* file facts */}
          <div className={cn("mt-4", field)}>
            {rows.map(([k, v]) => (
              <div
                key={k}
                className={cn(
                  "flex items-center justify-between gap-4 border-t px-3 py-2 first:border-t-0",
                  divider,
                )}
              >
                <span className="text-xs uppercase tracking-wide text-zinc-500">{k}</span>
                <span className="truncate text-sm text-zinc-200">{v}</span>
              </div>
            ))}
          </div>

          {/* location */}
          {folder && (
            <>
              <label className="mt-4 block text-xs font-medium uppercase tracking-wide text-zinc-500">
                {t("Location")}
              </label>
              <div className="mt-1.5 flex items-center gap-2">
                <p className={cn("min-w-0 flex-1 truncate px-2.5 py-2 text-xs text-zinc-400", field)} title={folder}>
                  {folder}
                </p>
                <button
                  onClick={() => reveal(item.path)}
                  title={t("Show in Explorer")}
                  className={cn(
                    "inline-flex items-center gap-1.5 px-3 py-2 text-xs text-zinc-200 transition-colors hover:bg-white/10",
                    field,
                  )}
                >
                  <FolderOpen className="h-3.5 w-3.5" />
                  {t("Open")}
                </button>
              </div>
            </>
          )}

          {/* advanced (Explorer's Details tab) */}
          <div className={cn("mt-4 border-t pt-3", divider)}>
            <button
              onClick={toggleAdvanced}
              className="flex w-full items-center gap-1.5 text-sm font-medium text-zinc-300 hover:text-zinc-100"
            >
              <ChevronDown className={cn("h-4 w-4 transition-transform", !adv && "-rotate-90")} />
              {t("Advanced — file properties")}
            </button>

            {adv && (
              <div className="mt-3">
                {fpLoading ? (
                  <div className="flex h-20 items-center justify-center">
                    <Loader2 className={cn("h-5 w-5 animate-spin", accentText)} />
                  </div>
                ) : fpErr ? (
                  <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
                    {fpErr}
                  </p>
                ) : fp ? (
                  <div className="space-y-3">
                    <PropField label={t("Title")}>
                      <input
                        value={fp.title}
                        onChange={(e) => setFp({ ...fp, title: e.target.value })}
                        className={cn("w-full px-2.5 py-1.5 text-sm text-zinc-100 outline-none", field)}
                      />
                    </PropField>
                    <PropField label={t("Subject")}>
                      <input
                        value={fp.subject}
                        onChange={(e) => setFp({ ...fp, subject: e.target.value })}
                        className={cn("w-full px-2.5 py-1.5 text-sm text-zinc-100 outline-none", field)}
                      />
                    </PropField>
                    <PropField label={t("Rating")}>
                      <div className="flex items-center gap-1">
                        {[1, 2, 3, 4, 5].map((n) => (
                          <button
                            key={n}
                            onClick={() => setFp({ ...fp, rating: fp.rating === n ? 0 : n })}
                            title={tp("{n} stars", n)}
                            className="p-0.5"
                          >
                            <Star
                              className={cn(
                                "h-5 w-5 transition-colors",
                                n <= fp.rating
                                  ? "fill-amber-400 text-amber-400"
                                  : "text-zinc-600 hover:text-zinc-400",
                              )}
                            />
                          </button>
                        ))}
                        {fp.rating > 0 && (
                          <button
                            onClick={() => setFp({ ...fp, rating: 0 })}
                            className="ml-2 text-xs text-zinc-500 hover:text-zinc-300"
                          >
                            {t("Clear")}
                          </button>
                        )}
                      </div>
                    </PropField>
                    <PropField label={t("Tags")}>
                      <input
                        value={tagsText}
                        onChange={(e) => setTagsText(e.target.value)}
                        placeholder={t("Comma-separated")}
                        className={cn(
                          "w-full px-2.5 py-1.5 text-sm text-zinc-100 outline-none placeholder:text-zinc-500",
                          field,
                        )}
                      />
                    </PropField>
                    <PropField label={t("Comments")}>
                      <textarea
                        value={fp.comments}
                        onChange={(e) => setFp({ ...fp, comments: e.target.value })}
                        rows={3}
                        className={cn("w-full resize-y px-2.5 py-1.5 text-sm text-zinc-100 outline-none", field)}
                      />
                    </PropField>
                    <button
                      onClick={() => void saveProps()}
                      disabled={fpSaving}
                      className={cn(
                        "flex w-full items-center justify-center gap-2 rounded-lg py-2 text-sm font-semibold text-white transition-colors disabled:opacity-50",
                        primary ?? "bg-brand-600 hover:bg-brand-500",
                      )}
                    >
                      {fpSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                      Save properties
                    </button>
                    <p className="text-[11px] leading-relaxed text-zinc-500">
                      Saved into the file itself — these also appear in Windows Explorer → Properties →
                      Details. Some file types only support a subset.
                    </p>
                  </div>
                ) : null}
              </div>
            )}
          </div>
        </div>
      </motion.div>
    </motion.div>
  );
}

/** A label + control row in the Advanced form. */
function PropField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-xs font-medium uppercase tracking-wide text-zinc-500">{label}</label>
      <div className="mt-1">{children}</div>
    </div>
  );
}

/** Shortcut overlay ("?"). */
function ShortcutHelp({ isVideo, onClose }: { isVideo: boolean; onClose: () => void }) {
  const t = useT();
  const rows: [string, string][] = [
    ["← / →", t("Previous / next")],
    [
      t("Space"),
      isVideo ? t("Slideshow (videos play inline)") : t("Start / pause slideshow"),
    ],
    [t("Mouse wheel"), t("Previous / next")],
    [t("Ctrl + wheel"), t("Zoom to cursor")],
    ["+ / −", t("Zoom in / out")],
    [t("Drag"), t("Pan (while zoomed in)")],
    [t("Ctrl + A"), t("Select all (while Select photos is on)")],
    ["G", t("Overview — all files as tiles")],
    ["?", t("Toggle this help")],
    ["Esc", t("Close help, then the viewer")],
  ];
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      onClick={onClose}
      className="absolute inset-0 z-[60] flex items-center justify-center bg-black/70 backdrop-blur-sm"
    >
      <motion.div
        initial={{ scale: 0.96, opacity: 0, y: 8 }}
        animate={{ scale: 1, opacity: 1, y: 0 }}
        exit={{ scale: 0.96, opacity: 0, y: 8 }}
        onClick={(e) => e.stopPropagation()}
        className="w-[26rem] max-w-[90vw] overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-900 shadow-2xl"
      >
        <div className="flex items-center justify-between border-b border-zinc-800 px-5 py-3">
          <h2 className="text-sm font-semibold text-zinc-100">{t("Keyboard shortcuts")}</h2>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-300" title={t("Close (Esc)")}>
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="divide-y divide-zinc-800/70 px-5 py-2">
          {rows.map(([keys, desc]) => (
            <div key={keys} className="flex items-center justify-between gap-4 py-2">
              <span className="text-sm text-zinc-300">{desc}</span>
              <kbd className="rounded-md border border-zinc-700 bg-zinc-950 px-2 py-0.5 text-xs font-medium text-zinc-200 shadow-sm">
                {keys}
              </kbd>
            </div>
          ))}
        </div>
      </motion.div>
    </motion.div>
  );
}

/** Labels + short badge text per metadata field. */
const META_LABELS: Record<string, { label: string; short: string }> = {
  title: { label: "Title", short: "Title" },
  subject: { label: "Subject", short: "Subj" },
  rating: { label: "Rating", short: "★" },
  tags: { label: "Tags", short: "Tags" },
  comments: { label: "Comments", short: "Note" },
  authors: { label: "Authors", short: "Author" },
  copyright: { label: "Copyright", short: "©" },
  camera: { label: "Camera info", short: "Camera" },
  dateTaken: { label: "Date taken", short: "Date" },
  gps: { label: "Location (GPS)", short: "GPS" },
};
/** Fields that count as "notable" (identifying) metadata. */
const NOTABLE_KEYS = new Set(["authors", "copyright", "camera", "dateTaken", "gps"]);
const emptyFields = (): PropFields => ({
  title: false, subject: false, rating: false, tags: false, comments: false,
  authors: false, copyright: false, camera: false, dateTaken: false, gps: false,
});

/**
 * Bulk "delete metadata": shows what each field holds across the files, pick which
 * to clear. Files with notable metadata (camera/location/author) are listed first.
 * Encrypted files are skipped.
 */
function ClearMetaDialog({
  srcs,
  onApply,
  onClose,
}: {
  srcs: string[];
  onApply: (fields: PropFields) => void;
  onClose: () => void;
}) {
  const t = useT();
  const [f, setF] = useState<PropFields>(emptyFields);
  const [summary, setSummary] = useState<MetaSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const toggle = (k: keyof PropFields) => setF((p) => ({ ...p, [k]: !p[k] }));

  useEffect(() => {
    let alive = true;
    setLoading(true);
    summarizeFileProps(srcs)
      .then((s) => alive && setSummary(s))
      .catch(() => alive && setSummary(null))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [srcs]);

  const fieldRows = summary?.fields ?? [];
  const presentRows = fieldRows.filter((r) => r.present > 0);
  const any = (Object.keys(f) as (keyof PropFields)[]).some((k) => f[k]);
  const selectAllPresent = () =>
    setF(() => {
      const next = emptyFields();
      for (const r of presentRows) next[r.key as keyof PropFields] = true;
      return next;
    });
  const notableFiles = (summary?.files ?? []).filter((file) => file.present.length > 0);

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      onClick={onClose}
      className="absolute inset-0 z-[60] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
    >
      <motion.div
        initial={{ scale: 0.96, opacity: 0, y: 8 }}
        animate={{ scale: 1, opacity: 1, y: 0 }}
        exit={{ scale: 0.96, opacity: 0, y: 8 }}
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[85vh] w-[30rem] max-w-[94vw] flex-col overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-900 shadow-2xl"
      >
        <div className="flex items-center justify-between border-b border-zinc-800 px-5 py-3">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-zinc-100">
            <Eraser className="h-4 w-4 text-brand-300" />
            {t("Delete metadata")}
          </h2>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-300" title={t("Close (Esc)")}>
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          <div className="mb-3 flex items-center justify-between gap-2">
            <p className="text-xs text-zinc-400">
              {srcs.length} file{srcs.length === 1 ? "" : "s"} selected
              {summary && summary.encrypted > 0 ? ` · ${summary.encrypted} encrypted (skipped)` : ""}
              . Tick which fields to clear from each file.
            </p>
            {presentRows.length > 0 && (
              <button
                onClick={selectAllPresent}
                className="shrink-0 text-xs font-medium text-brand-300 hover:text-brand-200"
              >
                {t("Select all")}
              </button>
            )}
          </div>

          {loading ? (
            <div className="flex h-24 items-center justify-center">
              <Loader2 className="h-5 w-5 animate-spin text-brand-400" />
            </div>
          ) : (
            <>
              <div className="space-y-1">
                {fieldRows.map((r) => {
                  const meta = META_LABELS[r.key] ?? { label: r.key, short: r.key };
                  const has = r.present > 0;
                  const notable = NOTABLE_KEYS.has(r.key);
                  return (
                    <label
                      key={r.key}
                      className={cn(
                        "flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm",
                        has ? "cursor-pointer text-zinc-200 micoll-hover" : "cursor-default text-zinc-600",
                      )}
                    >
                      <input
                        type="checkbox"
                        checked={f[r.key as keyof PropFields]}
                        disabled={!has}
                        onChange={() => toggle(r.key as keyof PropFields)}
                        className="h-4 w-4 accent-brand-500"
                      />
                      <span className="flex items-center gap-1.5">
                        {t(meta.label)}
                        {notable && has && (
                          <AlertTriangle className="h-3.5 w-3.5 text-amber-400" />
                        )}
                      </span>
                      <span className="ml-auto flex min-w-0 items-center gap-2 text-right">
                        {has ? (
                          <>
                            <span className="max-w-[11rem] truncate text-xs text-zinc-400" title={r.sample}>
                              {r.sample || "—"}
                            </span>
                            <span className="shrink-0 rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] tabular-nums text-zinc-400">
                              {r.present}/{srcs.length}
                            </span>
                          </>
                        ) : (
                          <span className="text-xs text-zinc-600">{t("none")}</span>
                        )}
                      </span>
                    </label>
                  );
                })}
              </div>

              {/* files with notable metadata first */}
              {notableFiles.length > 0 && (
                <div className="mt-4 border-t border-zinc-800 pt-3">
                  <div className="mb-2 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-zinc-500">
                    <AlertTriangle className="h-3.5 w-3.5 text-amber-400" />
                    {t("Files with metadata (notable first)")}
                  </div>
                  <div className="max-h-44 space-y-1 overflow-y-auto">
                    {notableFiles.map((file) => (
                      <div
                        key={file.path}
                        className={cn(
                          "flex items-center gap-2 rounded-lg px-2 py-1.5 text-xs",
                          file.unusual ? "bg-amber-500/10" : "bg-zinc-950/40",
                        )}
                      >
                        <span className="min-w-0 flex-1 truncate text-zinc-200" title={file.name}>
                          {file.name}
                        </span>
                        <span className="flex shrink-0 flex-wrap justify-end gap-1">
                          {file.present.map((k) => (
                            <span
                              key={k}
                              className={cn(
                                "rounded px-1.5 py-0.5 text-[10px]",
                                NOTABLE_KEYS.has(k)
                                  ? "bg-amber-500/20 text-amber-200"
                                  : "bg-zinc-800 text-zinc-400",
                              )}
                            >
                              {t(META_LABELS[k]?.short ?? k)}
                            </span>
                          ))}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-zinc-800 px-5 py-3">
          <button
            onClick={onClose}
            className="rounded-lg px-3 py-2 text-sm text-zinc-300 micoll-hover"
          >
            {t("Cancel")}
          </button>
          <button
            onClick={() => onApply(f)}
            disabled={!any}
            className="inline-flex items-center gap-1.5 rounded-lg bg-rose-600 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-rose-500 disabled:opacity-40"
          >
            <Eraser className="h-4 w-4" />
            {t("Clear selected")}
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}

/** Sort button with a 4-item menu. Clicking the active field flips the direction. */
function SortControl({
  field,
  dir,
  onPick,
}: {
  field: ImgSortField;
  dir: SortDir;
  onPick: (f: ImgSortField) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <ViewerBtn
        onClick={() => setOpen((o) => !o)}
        title={`Sort: ${IMG_SORT_LABELS[field]} · ${dirLabel(field, dir)}`}
        active={open}
      >
        <ArrowDownUp className="h-5 w-5" />
      </ViewerBtn>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full z-40 mt-1 w-44 rounded-xl border border-zinc-800 bg-zinc-900 p-1 shadow-2xl">
            {IMG_SORT_FIELDS.map((f) => {
              const active = f === field;
              return (
                <button
                  key={f}
                  onClick={() => onPick(f)}
                  className={cn(
                    "flex w-full items-center justify-between gap-3 rounded-lg px-2.5 py-1.5 text-left text-sm transition-colors",
                    active ? "bg-brand-500/15 text-brand-200" : "text-zinc-200 micoll-hover",
                  )}
                  title={active ? "Click to reverse direction" : undefined}
                >
                  <span>{IMG_SORT_LABELS[f]}</span>
                  {active && (
                    <span className="text-xs font-medium text-brand-300">{dirLabel(f, dir)}</span>
                  )}
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

/** One row in the versions popover: click to switch, trash to delete. */
function VersionRow({
  active,
  label,
  sub,
  onClick,
  onDelete,
  rowIdle,
  rowActive,
  tick,
}: {
  active: boolean;
  label: string;
  sub?: string;
  onClick: () => void;
  onDelete?: () => void;
  /** Menu row styles from lib/dialogTheme. */
  rowIdle: string;
  rowActive: string;
  /** Accent color for the check mark. */
  tick: string;
}) {
  const t = useT();
  return (
    <div
      className={cn(
        "group flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm transition-colors",
        active ? cn("font-medium text-zinc-100", rowActive) : cn("text-zinc-200", rowIdle),
      )}
    >
      <button onClick={onClick} className="flex min-w-0 flex-1 items-center gap-2 text-left">
        {onDelete ? <Layers className="h-4 w-4 shrink-0 opacity-70" /> : <RotateCcw className="h-4 w-4 shrink-0 opacity-70" />}
        <span className="min-w-0 flex-1 truncate">
          {label}
          {sub && <span className="ml-1 text-xs text-zinc-500">{sub}</span>}
        </span>
        {active && <Check className={cn("h-3.5 w-3.5 shrink-0", tick)} />}
      </button>
      {onDelete && (
        <button
          onClick={onDelete}
          title={t("Delete this version")}
          className="shrink-0 rounded p-1 text-zinc-500 opacity-0 transition-opacity hover:bg-rose-500/15 hover:text-rose-300 group-hover:opacity-100"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}

function ViewerBtn({
  children,
  onClick,
  onContextMenu,
  title,
  className = "",
  active = false,
}: {
  children: React.ReactNode;
  onClick: (e: React.MouseEvent) => void;
  onContextMenu?: (e: React.MouseEvent) => void;
  title?: string;
  className?: string;
  active?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      onContextMenu={onContextMenu}
      title={title}
      data-active={active || undefined}
      // own hook so the cyberpunk square corners don't reach the editor buttons
      className={`viewer-btn viewer-icon-btn flex h-10 w-10 items-center justify-center rounded-full backdrop-blur transition-colors ${
        active
          ? "bg-brand-600 text-white hover:bg-brand-500"
          : "bg-zinc-800/70 text-zinc-200 micoll-hover"
      } ${className}`}
    >
      {children}
    </button>
  );
}
