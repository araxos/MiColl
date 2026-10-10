import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { ChevronLeft, Plus, PanelRight, BadgeCheck, ClipboardList, Trash2, Coffee, CopyCheck, RefreshCw, Star, Heart, Images, Calendar, CalendarOff, Check, FolderPlus, Hash, HardDrive, DatabaseBackup, BellOff } from "lucide-react";
import { SakuraBlossomIcon } from "@/lib/classIcons";
import { Layout, scrollPageToTop } from "@/components/Layout";
import { MonthCard } from "@/components/MonthCard";
import { RewardGrid } from "@/components/RewardGrid";
import { CardShapeButton } from "@/components/CardShapeButton";
import { ThemeCheck } from "@/components/ThemeCheck";
import { NewFolderDialog } from "@/components/MovePicker";
import { ArtistSidebar } from "@/components/ArtistSidebar";
import { ArtistLinks } from "@/components/ArtistLinks";
import { ImageViewer, type CoverTargets, type ViewerItem } from "@/components/ImageViewer";
import {
  CollectionTabs,
  NewCollectionButton,
  type CollectionTab,
} from "@/components/CollectionTabs";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { cn } from "@/lib/utils";
import { useMonthsShort, useT, useTf, useTp } from "@/lib/i18n";
import { isTauri } from "@/lib/tauri";
import { useAccent, type AccentKey } from "@/lib/theme";
import { useActions } from "@/actions";
import { useUpNavigate } from "@/lib/nav";
import { useArtistImages, useData } from "@/store";
import { platformStats, monthOwnedCount, ownRewards, type Month, type Reward, type Platform, type RewardImage, type Collection } from "@/types";
import { creatorTypeDef, creatorTypeDefs, parseKinds } from "@/lib/creatorTypes";
import { tagDef, isNsfwTag, nsfwChipColors } from "@/lib/artistTags";
import { useCardSize } from "@/lib/useCardSize";
import { buildFolderOrder } from "@/lib/rewardOrder";
import { openDuplicates } from "@/lib/duplicates";
import { PLATFORMS } from "@/lib/platforms";
import {
  usePlatformOptions,
  usePlatformPrefs,
  addPlatform as registerPlatform,
} from "@/lib/platformRegistry";
import * as api from "@/api/library";
import { type MenuItem } from "@/components/ContextMenu";
import { onPageDetails } from "@/lib/pageDetails";
import { TileGate } from "@/components/TileGate";

export function ArtistPage({ onLock }: { onLock: () => void }) {
  const { artistId = "" } = useParams();
  const navigate = useNavigate();
  const t = useT();
  const months = useMonthsShort();
  const tf = useTf();
  const tp = useTp();
  const upNavigate = useUpNavigate();
  const { artists, findArtist, backed, refresh, imagesLoaded } = useData();
  const { openMenu, requestDelete, reload, showToast } = useActions();
  const artist = findArtist(artistId);
  // load this artist's images when the page opens
  useArtistImages(artistId);
  // sakura/cyberpunk keep their amber Fav. Wallpaper style, others use the brand color
  const accent = useAccent();
  const irid = accent === "iridescent";
  const sakura = accent === "sakura";
  // iridescent: frosted pills instead of a dark border
  const iriOutline = irid
    ? "border-white/20 bg-white/10 text-zinc-100 hover:bg-white/20"
    : undefined;
  // small square buttons in the box's bottom right (same trim as CardShapeButton)
  const iconButton = cn(
    "rounded-lg border outline-none transition-colors focus-visible:ring-2 focus-visible:ring-brand-500",
    irid ? iriOutline : "border-zinc-700 text-zinc-200 micoll-hover",
  );
  // "All Creators" button: bright frosted pill on iridescent, dark glass on
  // sakura/cyberpunk, ghost on standard themes
  const backBtnClass =
    accent === "iridescent"
      ? "border border-white/30 !bg-white/15 !text-white backdrop-blur-md hover:!bg-white/25"
      : accent === "sakura"
        ? "border border-[#f9a8d4]/30 !bg-zinc-900/50 !text-zinc-100 backdrop-blur-md hover:!bg-zinc-900/75"
        : accent === "cyberpunk"
          ? "!rounded-none border border-[#fcee0a]/50 !bg-zinc-950/60 !text-zinc-100 backdrop-blur-md hover:!bg-zinc-950/85"
          : undefined;
  // frosted dark glass boxes on iridescent (readable text, background shows through).
  // translateZ(0) stops the black flicker over WebGL.
  // Only the material, so the collection tabs can use it without radius/padding.
  const glassMaterial =
    "border border-white/10 bg-zinc-900/32 backdrop-blur-xl [transform:translateZ(0)]";
  const glassBox = cn("rounded-2xl p-4 shadow-lg shadow-black/20", glassMaterial);
  // dropdown style for "+ Platform" / "Break" per theme
  const menuSurface =
    accent === "cyberpunk"
      ? "rounded-none border border-[#fcee0a]/70 bg-zinc-950/95 ring-1 ring-inset ring-[#00e5ff]/15 shadow-[0_0_20px_rgba(252,238,10,0.2)] [clip-path:polygon(0_0,100%_0,100%_calc(100%-9px),calc(100%-9px)_100%,0_100%)]"
      : irid
        ? "iri-menu rounded-2xl border border-white/15 bg-zinc-900/70 backdrop-blur-2xl ring-1 ring-inset ring-white/10"
        : "rounded-xl border border-brand-500/40 bg-zinc-900 ring-1 ring-inset ring-brand-500/15";

  // ?platform=<name> picks the tab, else the last viewed one (by name), else the first
  const [searchParams, setSearchParams] = useSearchParams();
  const wantPlatform = searchParams.get("platform");
  const lastPlatformKey = `micoll.lastPlatform.${artistId}`;
  // the active tab comes from the URL so Back goes to the previous platform.
  // by name because the ids shift
  const platform =
    (wantPlatform && artist?.platforms.find((p) => p.name === wantPlatform)) ||
    artist?.platforms.find((p) => p.name === localStorage.getItem(lastPlatformKey)) ||
    artist?.platforms[0];
  // keep the platform in the URL (replace, so tabs don't spam history)
  useEffect(() => {
    if (!platform) return;
    if (searchParams.get("platform") === platform.name) return;
    const next = new URLSearchParams(searchParams);
    next.set("platform", platform.name);
    setSearchParams(next, { replace: true });
  }, [platform, searchParams, setSearchParams]);
  // switch tab + remember it. push = a real tab click (goes into history),
  // following a favourite into its gallery doesn't
  const selectPlatform = (p: Platform, push = false) => {
    try {
      localStorage.setItem(lastPlatformKey, p.name);
    } catch {
      /* ignore storage errors */
    }
    const next = new URLSearchParams(searchParams);
    next.set("platform", p.name);
    setSearchParams(next, push ? undefined : { replace: true });
  };
  // open Details right away with ?details=1 (?rename=1 also selects the name)
  const [sidebar, setSidebar] = useState(searchParams.get("details") === "1");
  const [focusName] = useState(searchParams.get("rename") === "1");
  // ...and from the background menu's "Details" (see lib/pageDetails)
  useEffect(() => onPageDetails(() => setSidebar(true)), []);
  // "New folder" next to Details, the dialog asks for the name and year
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  // place for the dateless grid's "Select" button next to Details
  const [toolbarHost, setToolbarHost] = useState<HTMLDivElement | null>(null);
  const [platformPickerOpen, setPlatformPickerOpen] = useState(false);
  const [addingPlatform, setAddingPlatform] = useState(false);
  // typing a new platform name in "+ Platform" (null = not typing)
  const [newPlatform, setNewPlatform] = useState<string | null>(null);
  const monthGrid = useCardSize("micoll.monthSize", 180);
  const [skipPickerOpen, setSkipPickerOpen] = useState(false);
  const [skipYear, setSkipYear] = useState(String(new Date().getFullYear()));
  const [skipMonth, setSkipMonth] = useState(String(new Date().getMonth() + 1));
  // the virtual "Fav. Wallpaper" folder opens in the viewer
  const [favViewer, setFavViewer] = useState<{ items: ViewerItem[]; index: number } | null>(null);
  // viewer for a month that holds its files directly (single reward)
  const [monthViewer, setMonthViewer] = useState<{
    items: ViewerItem[];
    index: number;
    coverTargets: CoverTargets;
  } | null>(null);

  // platforms this artist doesn't have yet (from the shared list) + "Unknown".
  // Unsorted/Misc are never suggested.
  const offeredPlatforms = usePlatformOptions(artists);
  const { hidden: hiddenPlatforms } = usePlatformPrefs();
  // a boolean for the deps, hidden is parsed fresh every render
  const unknownHidden = hiddenPlatforms.some((h) => h.trim().toLowerCase() === "unknown");
  const availablePlatforms = useMemo(() => {
    const have = new Set((artist?.platforms ?? []).map((p) => p.name.toLowerCase()));
    const out = offeredPlatforms.filter((p) => !have.has(p.toLowerCase()));
    // "Unknown" only once and only if it's not already in the list
    const offered = out.some((p) => p.toLowerCase() === "unknown");
    if (!have.has("unknown") && !offered && !unknownHidden) out.push("Unknown");
    return out;
  }, [artist, offeredPlatforms, unknownHidden]);

  // platform tabs sorted by reward count (fullest first), ties stay in order
  const orderedPlatforms = useMemo(() => {
    const count = (p: Platform) => p.months.reduce((n, m) => n + m.rewards.length, 0);
    return [...(artist?.platforms ?? [])].sort((a, b) => count(b) - count(a));
  }, [artist]);

  const addPlatform = async (p: string) => {
    if (!artist || !backed) return;
    setPlatformPickerOpen(false);
    setNewPlatform(null);
    setAddingPlatform(true);
    try {
      await api.addArtistPlatform(artist.id, p);
      await refresh();
    } finally {
      setAddingPlatform(false);
    }
  };
  // add the typed platform (unless empty or already there)
  const addCustomPlatform = () => {
    const name = (newPlatform ?? "").trim();
    if (!name) {
      setNewPlatform(null);
      return;
    }
    if ((artist?.platforms ?? []).some((p) => p.name.toLowerCase() === name.toLowerCase())) {
      setNewPlatform(null); // already exists — just close the input
      return;
    }
    registerPlatform(name); // remember it in the shared list (un-hides if removed)
    void addPlatform(name);
  };
  // close the "+ Platform" menu
  const closePlatformPicker = () => {
    setPlatformPickerOpen(false);
    setNewPlatform(null);
  };

  // add a break month to the active platform
  const addBreak = async () => {
    if (!artist || !backed || !platform) return;
    setSkipPickerOpen(false);
    const plat = platform.name === "Unsorted" ? null : platform.name;
    await api.addSkippedPeriod(artist.id, plat, Number(skipYear) || null, Number(skipMonth) || null);
    await refresh();
  };

  // right-click a platform tab -> delete it (asks if it still has rewards).
  // An empty one goes right away: the backend only throws away folders with no files left
  const removePlatform = (p: Platform) => {
    if (!artist || !backed) return;
    const hasContent = p.months.some((m) => ownRewards(m).length > 0);
    if (!hasContent) {
      void api
        .deletePlatform(artist.id, p.name, true)
        .then(() => refresh())
        .catch((e) => {
          void refresh();
          showToast({ tone: "error", title: t("Couldn’t delete everything"), problem: String(e) });
        });
    } else {
      requestDelete({
        title: `${p.name} — ${artist.name}`,
        platform: { artistId: artist.id, name: p.name },
      });
    }
  };

  const platformMenu = (e: React.MouseEvent, p: Platform) =>
    openMenu(e, [
      {
        label: t("Find duplicates"),
        icon: <CopyCheck className="h-4 w-4" />,
        onClick: () =>
          openDuplicates({
            label: `${artist?.name ?? ""} · ${p.name}`,
            artistId: Number(artist?.id),
            platform: p.name,
          }),
      },
      // release style of this platform, picking another re-labels the timeline
      ...(["monthly", "numbered", "none"] as const).map((s) => {
        const meta = {
          monthly: {
            label: t("Releases: monthly (year & month)"),
            icon: <Calendar className="h-4 w-4" />,
          },
          numbered: {
            label: t("Releases: numbered drops (#51)"),
            icon: <Hash className="h-4 w-4" />,
          },
          none: {
            label: t("Releases: no schedule (posts without dates)"),
            icon: <CalendarOff className="h-4 w-4" />,
          },
        }[s];
        const active = (p.releaseStyle ?? "monthly") === s;
        return {
          label: `${meta.label}${active ? "  ✓" : ""}`,
          icon: meta.icon,
          onClick: () => {
            if (backed && artist && !active)
              void api.setPlatformReleaseStyle(artist.id, p.name, s).then(() => refresh());
          },
        };
      }),
      {
        label: t("Reload"),
        icon: <RefreshCw className="h-4 w-4" />,
        onClick: () => void reload(),
      },
      // a tab that only exists because of a collab can't be deleted here, say where to
      // change it
      ...(p.months.length > 0 && p.months.every((m) => m.collabOnly)
        ? [
            {
              label: t("Shown because of a collab — remove the link on the reward"),
              info: true,
            },
          ]
        : [
            {
              label: t("Delete platform…"),
              icon: <Trash2 className="h-4 w-4" />,
              danger: true,
              onClick: () => removePlatform(p),
            },
          ]),
    ]);

  // reward search: title and category, ignores case and accents
  const [q, setQ] = useState("");
  const needle = q.trim().toLowerCase();
  const matchesQuery = useCallback(
    (r: Reward) =>
      !needle ||
      r.title.toLowerCase().includes(needle) ||
      (r.category ?? "").toLowerCase().includes(needle),
    [needle],
  );

  /**
   * Months shown during a search: the ones with at least one match, their
   * reward lists are NOT narrowed (the card counts describe the month, not the search).
   * Plain reward lists use matchesQuery directly.
   */
  const visibleMonths = useMemo(() => {
    const all = platform?.months ?? [];
    if (!needle) return all;
    return all.filter((m) => m.rewards.some(matchesQuery));
  }, [platform, needle, matchesQuery]);

  // the creator's MiSD year rules, loaded once for all year sections
  const [yearRules, setYearRules] = useState<api.SdYearRule[]>([]);
  const loadYearRules = useCallback(() => {
    if (!backed || !artistId) {
      setYearRules([]);
      return;
    }
    void api
      .sdYearRules(Number(artistId))
      .then(setYearRules)
      .catch(() => setYearRules([]));
  }, [backed, artistId]);
  useEffect(loadYearRules, [loadYearRules]);

  // group months by year (Misc last)
  const groups = useMemo(() => {
    const map = new Map<number | null, Month[]>();
    for (const m of visibleMonths) {
      const arr = map.get(m.year) ?? [];
      arr.push(m);
      map.set(m.year, arr);
    }
    return [...map.entries()].sort((a, b) => {
      if (a[0] === null) return 1;
      if (b[0] === null) return -1;
      return b[0] - a[0];
    });
  }, [visibleMonths]);

  // years (or drop numbers) for the "New folder" picker, newest first
  const platformYears = useMemo(() => {
    const vals =
      platform?.releaseStyle === "numbered"
        ? (platform?.months ?? []).map((m) => m.number)
        : (platform?.months ?? []).map((m) => m.year);
    return [...new Set(vals.filter((y): y is number => y != null))].sort((a, b) => b - a);
  }, [platform]);

  // create an empty folder under the year/drop (creates that level if needed).
  // empty = Misc/Unsorted
  const createFolder = async (name: string, year?: string) => {
    setNewFolderOpen(false);
    const trimmed = (year ?? "").trim();
    const val = trimmed ? Number(trimmed) : null;
    if (!artist || !platform || !backed) return;
    if (val != null && !Number.isInteger(val)) return; // a typed value must be valid
    const plat = platform.name === "Unsorted" ? null : platform.name;
    const isNumbered = platform.releaseStyle === "numbered";
    try {
      const periodId = isNumbered
        ? await api.ensurePeriod(artist.id, plat, null, null, val)
        : await api.ensurePeriod(artist.id, plat, val, null);
      await api.createReward(String(periodId), name);
      await refresh();
      showToast({
        tone: "success",
        title: `Created “${name}”`,
        detail: `${plat ?? "Unsorted"} · ${
          isNumbered ? (val != null ? `#${val}` : "Unsorted") : val ?? "Misc"
        }`,
      });
    } catch (e) {
      showToast({ tone: "error", title: t("Couldn’t create folder"), detail: `${e}` });
    }
  };

  // dateless artists: show the rewards directly
  const flatRewards = useMemo(() => {
    const out: { reward: Reward; monthId: string }[] = [];
    for (const m of platform?.months ?? []) {
      for (const r of m.rewards) if (matchesQuery(r)) out.push({ reward: r, monthId: m.id });
    }
    return out;
  }, [platform, matchesQuery]);

  // all images marked "Fav. wallpaper" (virtual folder, files aren't moved)
  const favImages = useMemo<RewardImage[]>(() => {
    const out: RewardImage[] = [];
    const seen = new Set<string>();
    // only own rewards, no borrowed collabs
    for (const p of artist?.platforms ?? [])
      for (const m of p.months)
        for (const r of ownRewards(m))
          for (const im of r.images)
            if (im.favWallpaper && im.kind === "image" && im.path && !seen.has(im.path)) {
              seen.add(im.path);
              out.push(im);
            }
    return out;
  }, [artist]);

  // the "Favourites" collection (images + videos)
  const liveFavoriteImages = useMemo<RewardImage[]>(() => {
    const out: RewardImage[] = [];
    const seen = new Set<string>();
    for (const p of artist?.platforms ?? [])
      for (const m of p.months)
        for (const r of ownRewards(m))
          for (const im of r.images)
            if (im.favorite && im.path && !seen.has(im.path)) {
              seen.add(im.path);
              out.push(im);
            }
    return out;
  }, [artist]);

  // one random picture per collection as tab background, new per visit (not per render)
  const previewRoll = useMemo(() => Math.random(), [artist?.id]);
  const pickPreview = (imgs: RewardImage[]) => {
    // images only (video thumbnails are async)
    const stills = imgs.filter((im) => im.path && im.kind !== "video");
    return stills.length ? stills[Math.floor(previewRoll * stills.length)]?.path : undefined;
  };

  /* ---- user collections ----
     membership is global, this page shows the part that belongs to THIS creator */
  const [collections, setCollections] = useState<Collection[]>([]);
  // separate flag, length 0 can't tell "none" from "not loaded yet"
  const [collectionsReady, setCollectionsReady] = useState(!backed);
  useEffect(() => {
    if (!backed) return;
    let alive = true;
    api
      .listCollections()
      .then((c) => {
        if (!alive) return;
        setCollections(c);
        setCollectionsReady(true);
      })
      .catch(() => alive && setCollectionsReady(true));
    return () => {
      alive = false;
    };
  }, [backed]);

  const liveCollectionImages = useMemo(() => {
    const byId = new Map<string, RewardImage[]>();
    const seenPer = new Map<string, Set<string>>();
    for (const p of artist?.platforms ?? [])
      for (const m of p.months)
        for (const r of ownRewards(m))
          for (const im of r.images) {
            if (!im.path) continue;
            for (const cid of im.collections ?? []) {
              const paths = seenPer.get(cid) ?? new Set<string>();
              if (paths.has(im.path)) continue;
              paths.add(im.path);
              seenPer.set(cid, paths);
              byId.set(cid, [...(byId.get(cid) ?? []), im]);
            }
          }
    return byId;
  }, [artist]);

  /* the lists above count image rows, which load a bit after the library.
     While they're missing keep the last answer, otherwise the tabs flicker
     and the "+" jumps around. */
  const ready = imagesLoaded(artistId);
  const held = useRef<{
    id: string;
    favs: RewardImage[];
    byCollection: Map<string, RewardImage[]>;
  } | null>(null);
  if (ready) held.current = { id: artistId, favs: liveFavoriteImages, byCollection: liveCollectionImages };
  const stale = !ready && held.current?.id === artistId ? held.current : null;
  const favoriteImages = stale ? stale.favs : liveFavoriteImages;
  const collectionImages = stale ? stale.byCollection : liveCollectionImages;

  // one stable function for the month cards (ref because openMonth is defined later)
  const openMonthRef = useRef<(monthId: string) => void>(() => {});
  const openMonthStable = useCallback((monthId: string) => openMonthRef.current(monthId), []);

  if (!artist) {
    return (
      <Layout onLock={onLock}>
        <div className="grid h-full place-items-center text-zinc-400">{t("Creator not found.")}</div>
      </Layout>
    );
  }

  // release style is per platform
  const style = platform?.releaseStyle ?? (platform?.noDates ? "none" : "monthly");
  const dateless = style === "none";
  const numbered = style === "numbered";

  // open a month: a single reward jumps into the viewer, else show the rewards
  /** One reward's gallery as viewer items (same folder order as the month page). */
  const galleryItems = (r: Reward): ViewerItem[] =>
    buildFolderOrder(r.images).map(({ image: im, group }) => ({
      id: im.id,
      title: im.name ? `${r.title} — ${im.name.split(/[\\/]/).pop() || im.name}` : r.title,
      src: im.src,
      path: im.path,
      displayPath: im.displayPath,
      versionCount: im.versionCount,
      onOriginal: im.onOriginal,
      name: im.name ? im.name.split(/[\\/]/).pop() || im.name : undefined,
      kind: im.kind,
      favWallpaper: im.favWallpaper,
      favorite: im.favorite,
      collections: im.collections,
      group,
    }));

  const openMonth = (monthId: string) => {
    const m = platform?.months.find((mm) => mm.id === monthId);
    // borrowed collabs always open as cards
    const only = m && ownRewards(m).length === 1 ? ownRewards(m)[0] : undefined;
    // only skip to the gallery for a "root" reward (loose files in the month),
    // not for a named folder or a month imported with "Open as folder cards"
    if (m && !m.openAsCards && only && only.isRoot && only.images.length > 0) {
      const items = galleryItems(only);
      setMonthViewer({
        items,
        index: 0,
        // opened from the creator page, so the cover crop uses this page's shape
        coverTargets: {
          rewardId: only.id,
          periodId: m.id,
          artistId: artist.id,
          shapeScope: "year",
          shapeKey: `artist:${artist.id}`,
        },
      });
      return;
    }
    navigate(`/artist/${artist.id}/month/${monthId}`);
  };
  openMonthRef.current = openMonth;

  // open "Fav. Wallpaper" in the viewer
  const openFav = () => {
    if (!favImages.length) return;
    const items: ViewerItem[] = favImages.map((im) => ({
      id: im.id,
      title: im.name ? im.name.split(/[\\/]/).pop() || im.name : "Fav. wallpaper",
      src: im.src,
      path: im.path,
      displayPath: im.displayPath,
      versionCount: im.versionCount,
      onOriginal: im.onOriginal,
      name: im.name ? im.name.split(/[\\/]/).pop() || im.name : undefined,
      kind: im.kind,
      favWallpaper: true,
    }));
    setFavViewer({ items, index: 0 });
  };

  // desktop slideshow from all favourite wallpapers (shows the active version)
  const setFavAsWallpaper = async () => {
    const paths = favImages
      .map((im) => im.displayPath || im.path)
      .filter((p): p is string => !!p);
    if (!paths.length) return;
    try {
      await api.setWallpaperSlideshow(paths);
      showToast({
        tone: "success",
        title: t("Wallpaper slideshow set"),
        detail: `${paths.length} favourite${paths.length === 1 ? "" : "s"} from ${artist.name}`,
      });
    } catch (e) {
      showToast({ tone: "error", title: t("Couldn’t set wallpaper"), detail: `${e}` });
    }
  };

  /**
   * From a collection back to the reward the file came from.
   * Opens the reward's gallery on the same file and switches the platform tab too.
   */
  const goToFolder = (it: ViewerItem) => {
    const path = it.path;
    if (!path) return;
    for (const p of artist.platforms)
      for (const m of p.months)
        // only own rewards
        for (const r of ownRewards(m)) {
          if (!r.images.some((im) => im.path === path)) continue;
          const items = galleryItems(r);
          setFavViewer(null);
          selectPlatform(p);
          setMonthViewer({
            items,
            index: Math.max(0, items.findIndex((v) => v.path === path)),
            coverTargets: {
              rewardId: r.id,
              periodId: m.id,
              artistId: artist.id,
              shapeScope: "year",
              shapeKey: `artist:${artist.id}`,
            },
          });
          return;
        }
    // the library changed under the viewer (rescan, delete), say so
    showToast({
      tone: "error",
      title: t("Couldn’t open the folder"),
      detail: t("This file is no longer in the library. Reload and try again."),
    });
  };

  // open Favourites in the viewer
  const openFavorites = () => {
    if (!favoriteImages.length) return;
    const items: ViewerItem[] = favoriteImages.map((im) => ({
      id: im.id,
      title: im.name ? im.name.split(/[\\/]/).pop() || im.name : "Favourite",
      src: im.src,
      path: im.path,
      displayPath: im.displayPath,
      versionCount: im.versionCount,
      onOriginal: im.onOriginal,
      name: im.name ? im.name.split(/[\\/]/).pop() || im.name : undefined,
      kind: im.kind,
      favorite: true,
    }));
    setFavViewer({ items, index: 0 });
  };

  // open one collection in the viewer
  const openCollection = (c: Collection) => {
    const imgs = collectionImages.get(c.id) ?? [];
    if (!imgs.length) return;
    const items: ViewerItem[] = imgs.map((im) => ({
      id: im.id,
      title: im.name ? im.name.split(/[\\/]/).pop() || im.name : c.name,
      src: im.src,
      path: im.path,
      displayPath: im.displayPath,
      versionCount: im.versionCount,
      onOriginal: im.onOriginal,
      name: im.name ? im.name.split(/[\\/]/).pop() || im.name : undefined,
      kind: im.kind,
      favorite: im.favorite,
      favWallpaper: im.favWallpaper,
      collections: im.collections,
    }));
    setFavViewer({ items, index: 0 });
  };

  // any collection can be a desktop slideshow (images only)
  const setCollectionAsWallpaper = async (c: Collection) => {
    const paths = (collectionImages.get(c.id) ?? [])
      .filter((im) => im.kind === "image")
      .map((im) => im.displayPath || im.path)
      .filter((p): p is string => !!p);
    if (!paths.length) {
      showToast({ tone: "error", title: t("No images to show"), detail: tf("“{name}” holds no stills.", { name: c.name }) });
      return;
    }
    try {
      await api.setWallpaperSlideshow(paths);
      showToast({
        tone: "success",
        title: t("Wallpaper slideshow set"),
        detail: `${paths.length} image${paths.length === 1 ? "" : "s"} from “${c.name}”`,
      });
    } catch (e) {
      showToast({ tone: "error", title: t("Couldn’t set wallpaper"), detail: `${e}` });
    }
  };

  const createCollection = async (name: string) => {
    try {
      await api.createCollection(name);
      setCollections(await api.listCollections());
      showToast({ tone: "success", title: t("Collection created"), detail: `“${name}”` });
    } catch (e) {
      showToast({ tone: "error", title: t("Couldn’t create collection"), detail: `${e}` });
    }
  };
  const renameCollection = async (id: string, name: string) => {
    try {
      await api.renameCollection(id, name);
      setCollections(await api.listCollections());
    } catch (e) {
      showToast({ tone: "error", title: t("Couldn’t rename collection"), detail: `${e}` });
    }
  };
  const deleteCollection = async (c: Collection) => {
    try {
      await api.deleteCollection(c.id);
      setCollections(await api.listCollections());
      await refresh(); // the images' membership lists changed
      showToast({ tone: "success", title: t("Collection deleted"), detail: tf("“{name}” · no files were touched", { name: c.name }) });
    } catch (e) {
      showToast({ tone: "error", title: t("Couldn’t delete collection"), detail: `${e}` });
    }
  };

  // the tab row: the two built-ins first, then the user's collections
  const tabs: CollectionTab[] = [
    ...(favoriteImages.length > 0
      ? [
          {
            key: "favs",
            name: "Favourites",
            count: favoriteImages.length,
            icon: (
              <Heart
                className={cn(
                  "h-3.5 w-3.5 fill-rose-400 text-rose-400",
                  // iridescent uses the foil gradient (index.css)
                  irid && "iri-foil",
                )}
              />
            ),
            onOpen: openFavorites,
            preview: pickPreview(favoriteImages),
          },
        ]
      : []),
    ...(artist.wallpaperFav
      ? [
          {
            key: "wall",
            name: "Fav. Wallpaper",
            count: favImages.length,
            icon: (
              <Star
                className={cn(
                  "h-3.5 w-3.5",
                  favImages.length && "fill-amber-400 text-amber-400",
                  // iridescent uses the foil gradient (index.css)
                  irid && "iri-foil",
                )}
              />
            ),
            onOpen: openFav,
            preview: pickPreview(favImages),
            onSetWallpaper: isTauri() ? () => void setFavAsWallpaper() : undefined,
          },
        ]
      : []),
    ...collections.map((c) => ({
      key: c.id,
      name: c.name,
      count: (collectionImages.get(c.id) ?? []).length,
      icon: <Images className="h-3.5 w-3.5 text-brand-300" />,
      preview: pickPreview(collectionImages.get(c.id) ?? []),
      onOpen: () => openCollection(c),
      onSetWallpaper: isTauri() ? () => void setCollectionAsWallpaper(c) : undefined,
      onRename: (name: string) => void renameCollection(c.id, name),
      onDelete: () => void deleteCollection(c),
    })),
  ];
  // the row only shows when it has a tab, otherwise the "+" sits next to
  // the card shape icon. Also decides the platform box's bottom margin.
  const showTabs = tabs.length > 0;

  // right-click remove for the class / type / tag chips
  const removeClass = () => {
    if (backed) void api.setArtistTag(artist.id, null).then(() => refresh());
  };
  const removeKind = (key: string) => {
    if (!backed) return;
    const next = parseKinds(artist.kind).filter((tok) => creatorTypeDef(tok)?.key !== key);
    void api.setArtistKind(artist.id, next.length ? next.join(",") : null).then(() => refresh());
  };
  const removeTag = (tag: string) => {
    if (!backed) return;
    const next = (artist.tags ?? []).filter((x) => x !== tag);
    void api.setArtistTags(artist.id, next).then(() => refresh());
  };
  const classMenu = (e: React.MouseEvent) =>
    openMenu(e, [
      {
        label: t("Remove class"),
        icon: <Trash2 className="h-4 w-4" />,
        danger: true,
        onClick: removeClass,
      },
    ]);
  const kindMenu = (e: React.MouseEvent, key: string) =>
    openMenu(e, [
      {
        label: t("Remove type"),
        icon: <Trash2 className="h-4 w-4" />,
        danger: true,
        onClick: () => removeKind(key),
      },
    ]);
  const tagMenu = (e: React.MouseEvent, tag: string) =>
    openMenu(e, [
      {
        label: t("Remove tag"),
        icon: <Trash2 className="h-4 w-4" />,
        danger: true,
        onClick: () => removeTag(tag),
      },
    ]);

  // click the creator name to copy it
  const copyName = async () => {
    try {
      await navigator.clipboard.writeText(artist.name);
      showToast({ tone: "success", title: t("Copied to clipboard"), detail: `“${artist.name}”` });
    } catch (e) {
      showToast({ tone: "error", title: t("Couldn’t copy name"), detail: `${e}` });
    }
  };

  return (
    <Layout
      onLock={onLock}
      search={{ value: q, onChange: setQ, placeholder: t("Search rewards…") }}
      titleSlot={
        <span className="flex min-w-0 items-center gap-1.5">
          <button
            type="button"
            onClick={copyName}
            title={t("Click to copy the creator name")}
            className="truncate font-medium text-zinc-100 transition-colors hover:text-brand-300"
          >
            {artist.name}
          </button>
          {artist.verified ? (
            <ThemeCheck
              className="h-4 w-4"
              label={t("Verified — an official template is applied")}
            />
          ) : artist.personalLog ? (
            <ClipboardList
              className="h-4 w-4 shrink-0 text-zinc-400"
              aria-label={t("Personal collection log applied")}
            />
          ) : null}
          {/* the open platform tab as the last crumb (from the URL) */}
          {platform && (
            <>
              <span className={irid ? "text-zinc-300" : "text-zinc-600"}>/</span>
              {/* click: back to the top of this platform */}
              <button
                onClick={scrollPageToTop}
                title={t("Back to the top")}
                className="truncate font-medium text-zinc-100 transition-colors hover:text-brand-300"
              >
                {platform.name}
              </button>
            </>
          )}
        </span>
      }
    >
      <div
        className={cn(
          // min-h-full so the drop target reaches the bottom of the window
          // (a drop below it would be read as "no creator" = a new one)
          "min-h-full w-full px-6 py-6 2xl:px-10",
          // reserve space on the right while Details is open (no transition, it flickered)
          sidebar && "pr-[21rem]",
        )}
        // drop target: this artist + the current platform
        data-drop-artist={artist.name}
        data-drop-nodate={dateless ? "1" : "0"}
        data-drop-style={style}
        data-drop-platform={
          platform && (PLATFORMS as readonly string[]).includes(platform.name)
            ? platform.name
            : undefined
        }
      >
        {/* top controls in a frosted box (iridescent). relative z-20 so the dropdowns
            are above the year sections */}
        <div
          className={cn(
            "relative z-20",
            // no bottom gap when the collection tabs follow
            showTabs ? "mb-0" : dateless ? "mb-3" : "mb-6",
            irid && glassBox,
          )}
        >
        <div className="mb-4 flex flex-wrap items-center gap-y-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => upNavigate("/")}
            className={cn(backBtnClass ? "" : "-ml-2", backBtnClass)}
          >
            <ChevronLeft className="h-4 w-4" />
            {t("All Creators")}
          </Button>
          {/* class (right-click to remove) */}
          {(() => {
            const cl = tagDef(artist.tag);
            return cl ? (
              <span
                onContextMenu={classMenu}
                className={cn(
                  "ml-2 inline-flex h-7 w-7 items-center justify-center rounded-full border",
                  irid ? "border-white/25 bg-white/10" : "classic-chip border-zinc-700 bg-zinc-900",
                )}
                title={tf("Class: {label} — {desc} · right-click to remove", {
                  label: t(cl.label),
                  desc: t(cl.desc),
                })}
              >
                <cl.Icon className={`h-4 w-4 ${cl.color}`} fill="currentColor" />
              </span>
            ) : null;
          })()}

          {/* creator types (right-click to remove) */}
          {creatorTypeDefs(artist.kind).map((ct) => (
            <span
              key={ct.key}
              onContextMenu={(e) => kindMenu(e, ct.key)}
              className={cn(
                "ml-2 inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs text-zinc-300",
                irid ? "border-white/25 bg-white/10" : "classic-chip border-zinc-700 bg-zinc-900",
              )}
              title={tf("Creator type: {label} · right-click to remove", { label: t(ct.label) })}
            >
              <ct.Icon className={`h-3.5 w-3.5 ${ct.color}`} />
              {t(ct.label)}
            </span>
          ))}

          {/* tags, max 3, the rest on hover */}
          {(artist.tags?.length ?? 0) > 0 &&
            (() => {
              const all = artist.tags ?? [];
              const shown = all.slice(0, 3);
              const rest = all.slice(3);
              return (
                <span className="ml-2 inline-flex flex-wrap items-center gap-1.5">
                  {shown.map((tag) => (
                    <span
                      key={tag}
                      onContextMenu={(e) => tagMenu(e, tag)}
                      title={t("Right-click to remove")}
                      className={cn(
                        "inline-flex items-center rounded-full border px-2.5 py-1 text-xs",
                        isNsfwTag(tag)
                          ? nsfwChipColors(accent)
                          : "border-brand-500/30 bg-brand-500/10 text-brand-200",
                      )}
                    >
                      {tag}
                    </span>
                  ))}
                  {rest.length > 0 && (
                    <span className="group relative inline-flex">
                      <span
                        className="classic-chip cursor-default rounded-full border border-zinc-700 bg-zinc-900 px-2.5 py-1 text-xs text-zinc-300"
                        // the list below is the hint, no title on top of it
                        aria-label={tp("{n} more", rest.length)}
                      >
                        …
                      </span>
                      <div className="pointer-events-none absolute left-0 top-7 z-50 w-max max-w-[18rem] rounded-xl border border-zinc-700 bg-zinc-900 p-2 opacity-0 shadow-2xl shadow-black/50 transition-opacity duration-150 group-hover:opacity-100">
                        <div className="flex flex-wrap gap-1">
                          {rest.map((tag) => (
                            <span
                              key={tag}
                              className={cn(
                                "rounded-full border px-2 py-0.5 text-[11px]",
                                isNsfwTag(tag)
                                  ? nsfwChipColors(accent)
                                  : "border-brand-500/30 bg-brand-500/10 text-brand-200",
                              )}
                            >
                              {tag}
                            </span>
                          ))}
                        </div>
                      </div>
                    </span>
                  )}
                </span>
              );
            })()}

          {/* social links as logo chips */}
          <ArtistLinks links={artist.links} accent={accent} />

          <div className="ml-auto flex items-center gap-2">
            {/* New folder (icon, label on hover = the hint, no title), picks the year in
                its dialog */}
            {backed && platform && (
              <button
                onClick={() => setNewFolderOpen(true)}
                aria-label={t("New folder")}
                aria-description={t("Create a new (empty) folder — pick a year or leave it under Misc")}
                className={cn(
                  "group inline-flex h-8 items-center rounded-lg border px-2 text-sm font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-brand-500",
                  "border-zinc-700 text-zinc-200 micoll-hover",
                  iriOutline,
                )}
              >
                <span className="grid h-4 w-4 shrink-0 place-items-center">
                  <FolderPlus className="h-4 w-4 text-white" />
                </span>
                <span className="max-w-0 overflow-hidden whitespace-nowrap opacity-0 transition-all duration-200 group-hover:ml-1.5 group-hover:max-w-[8rem] group-hover:opacity-100">
                  {t("New folder")}
                </span>
              </button>
            )}
            {/* the dateless grid's "Select" button goes here */}
            <div ref={setToolbarHost} className="flex items-center gap-2" />
            <Button
              variant={sidebar ? "primary" : "outline"}
              size="sm"
              onClick={() => setSidebar((s) => !s)}
              title={t("Creator details (tag & links)")}
              className={!sidebar ? iriOutline : undefined}
            >
              <PanelRight className="h-4 w-4" />
              {t("Details")}
            </Button>
          </div>
        </div>

        {/* platform tabs */}
        <div className="flex flex-wrap items-center gap-2">
          {orderedPlatforms.map((p) => {
            const s = platformStats(p);
            const active = p.id === platform?.id;
            return (
              <button
                key={p.id}
                onClick={() => selectPlatform(p, true)}
                onContextMenu={(e) => platformMenu(e, p)}
                title={t("Right-click for options (dates, delete…)")}
                className={cn(
                  "flex items-center gap-2 border px-3.5 py-2 text-sm font-medium transition-colors",
                  // sakura tabs use the petal diagonal shape
                  sakura ? "sak-petal-cut" : "rounded-xl",
                  // all iridescent tabs have the 2px border so selecting doesn't move the
                  // row
                  irid && "border-2",
                  active
                    ? irid
                      ? "pick-on text-white"
                      : "classic-chip-on border-brand-500/50 bg-brand-500/15 text-brand-200"
                    : irid
                      ? "border-white/20 bg-white/10 text-zinc-200 hover:bg-white/20"
                      : // The unpicked sakura tab: frosted rose glass with a lit top
                        // edge, instead of the grey zinc chip every other accent uses.
                        sakura
                        ? "sak-chip"
                        : "classic-chip border-zinc-800 bg-zinc-900 text-zinc-300 micoll-hover",
                )}
              >
                {p.name}
                {p.verified && <ThemeCheck className="h-4 w-4" label={t("Has verified periods")} />}
                {/* white count text on every theme */}
                <Badge
                  tone={active ? "brand" : "zinc"}
                  className={cn(
                    "!text-white",
                    irid && "!bg-white/15 !ring-white/30",
                    // no zinc chip on a rose tab
                    sakura && !active && "!bg-[#f9a8d4]/20 !ring-[#f9a8d4]/35",
                    // classic premium look: a brand count instead of the zinc one (index.css)
                    !active && "classic-chip-count",
                  )}
                >
                  {s.tracked ? `${s.ownedRewards}/${s.totalRewards}` : s.ownedRewards}
                </Badge>
              </button>
            );
          })}
          <div className="relative ml-1">
            <Button
              variant="outline"
              size="sm"
              disabled={!backed || addingPlatform}
              onClick={() => (platformPickerOpen ? closePlatformPicker() : setPlatformPickerOpen(true))}
              title={t("Add a platform to this creator")}
              className={iriOutline}
            >
              <Plus className="h-4 w-4" />
              {t("Platform")}
            </Button>
            {platformPickerOpen && (
              <>
                <div className="fixed inset-0 z-40" onClick={closePlatformPicker} />
                <div
                  className={cn(
                    "absolute left-0 top-full z-50 mt-1.5 max-h-72 w-48 overflow-y-auto p-1 shadow-2xl shadow-black/40",
                    menuSurface,
                  )}
                >
                  {availablePlatforms.map((p) => (
                    <button
                      key={p}
                      onClick={() => void addPlatform(p)}
                      className={cn(
                        "flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm transition-colors",
                        irid ? "text-zinc-100 hover:bg-white/10" : "text-zinc-200 hover:bg-white/10",
                      )}
                    >
                      <Plus className="h-3.5 w-3.5 text-brand-300" />
                      {p}
                    </button>
                  ))}

                  {/* add a new platform (divider only if there are suggestions above) */}
                  {availablePlatforms.length > 0 && (
                    <div className={cn("my-1 h-px", irid ? "bg-white/10" : "bg-brand-500/20")} />
                  )}
                  {newPlatform === null ? (
                    <button
                      onClick={() => setNewPlatform("")}
                      className={cn(
                        "flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm font-medium transition-colors",
                        irid ? "text-brand-100 hover:bg-white/10" : "text-brand-200 hover:bg-white/10",
                      )}
                    >
                      <Plus className="h-3.5 w-3.5" />
                      {t("Add platform…")}
                    </button>
                  ) : (
                    <div className="flex items-center gap-1 p-1">
                      <input
                        autoFocus
                        value={newPlatform}
                        onChange={(e) => setNewPlatform(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") addCustomPlatform();
                          else if (e.key === "Escape") setNewPlatform(null);
                        }}
                        placeholder={t("Platform name")}
                        className={cn(
                          "h-7 min-w-0 flex-1 rounded-md border px-2 text-xs outline-none",
                          irid
                            ? "border-white/15 bg-white/10 text-zinc-100 placeholder:text-zinc-400 focus:border-white/50"
                            : "border-zinc-700 bg-zinc-950 text-zinc-100 focus:border-brand-500/60",
                        )}
                      />
                      <button
                        onClick={addCustomPlatform}
                        title={t("Add")}
                        className="rounded-md border border-brand-500/40 bg-brand-500/15 px-2 py-1 text-xs font-medium text-brand-100 transition-colors hover:bg-brand-500/25"
                      >
                        {t("Add")}
                      </button>
                    </div>
                  )}
                </div>
              </>
            )}
          </div>

          {/* add a break month (monthly only) */}
          {style === "monthly" && platform && (
            <div className="relative">
              <Button
                variant="outline"
                size="sm"
                disabled={!backed}
                onClick={() => setSkipPickerOpen((o) => !o)}
                title={t("Mark a month the creator skipped (a break)")}
                className={iriOutline}
              >
                <Coffee className="h-4 w-4" />
                {t("Break")}
              </Button>
              {skipPickerOpen && (
                <>
                  <div className="fixed inset-0 z-30" onClick={() => setSkipPickerOpen(false)} />
                  <div className="absolute left-0 top-full z-40 mt-1 w-60 rounded-xl border border-zinc-800 bg-zinc-900 p-3 shadow-2xl">
                    <p className="mb-2 text-xs text-zinc-400">
                      {tf("Mark a skipped month on {platform}.", { platform: platform.name })}
                    </p>
                    <div className="flex items-center gap-2">
                      <input
                        value={skipYear}
                        onChange={(e) => setSkipYear(e.target.value.replace(/[^0-9]/g, ""))}
                        placeholder={t("Year")}
                        className="h-8 w-16 rounded-md border border-zinc-800 bg-zinc-950 px-2 text-xs text-zinc-100 outline-none focus:border-brand-500/60"
                      />
                      <select
                        value={skipMonth}
                        onChange={(e) => setSkipMonth(e.target.value)}
                        className="h-8 flex-1 rounded-md border border-zinc-800 bg-zinc-950 px-2 text-xs text-zinc-100 outline-none focus:border-brand-500/60"
                      >
                        {months.map((mn, idx) => (
                          <option key={mn} value={String(idx + 1)}>
                            {mn}
                          </option>
                        ))}
                      </select>
                    </div>
                    <Button
                      variant="primary"
                      size="sm"
                      className="mt-3 w-full"
                      onClick={() => void addBreak()}
                    >
                      <Coffee className="h-4 w-4" />
                      {t("Add break")}
                    </Button>
                  </div>
                </>
              )}
            </div>
          )}
          {/* card shape for this creator, and the "+" for the first collection */}
          <div className="ml-auto flex items-center gap-2 self-end">
            {/* only once we know if the creator has collections (not while loading) */}
            {backed && ready && collectionsReady && !showTabs && (
              <NewCollectionButton
                onCreate={createCollection}
                className={cn(iconButton, "grid h-8 w-8 place-items-center")}
                inputClassName={cn(iconButton, "h-8 w-40 px-2.5 text-[12px] placeholder:text-zinc-500")}
              />
            )}
            <CardShapeButton scope="year" overrideKey={`artist:${artist.id}`} what={t("this creator")} />
          </div>
        </div>
        </div>

        {/* collection tabs: Favourites, Fav. Wallpaper, the user's own, then "+" */}
        {showTabs && (
          <CollectionTabs
            tabs={tabs}
            onCreate={backed ? createCollection : undefined}
            glass={irid ? glassMaterial : undefined}
            inset={irid}
          />
        )}


        {artist.platforms.length === 0 ? (
          <div className="grid place-items-center rounded-2xl border border-dashed border-zinc-800 py-20 text-center text-sm text-zinc-500">
            {t("No rewards yet. Use the “+” on this creator’s card to add some.")}
          </div>
        ) : dateless ? (
          /* Dateless: rewards shown directly. */
          flatRewards.length === 0 ? (
            <div className="grid place-items-center rounded-2xl border border-dashed border-zinc-800 py-20 text-center text-sm text-zinc-500">
              {needle
                ? tf("No rewards match “{q}”.", { q: q.trim() })
                : tf("No rewards on {platform} yet.", { platform: platform?.name ?? "" })}
            </div>
          ) : (
            <RewardGrid
              items={flatRewards}
              artistId={artist.id}
              shapeKey={`artist:${artist.id}`}
              toolbarHost={toolbarHost}
              hideNewFolder
              fillHeight
            />
          )
        ) : numbered ? (
          /* Numbered drops: one card per drop (#51, #52...), newest first,
             plus "Unsorted" for rewards without a number. */
          <div ref={monthGrid.ref}>
            <NumberedSection
              months={visibleMonths}
              match={matchesQuery}
              monthSize={monthGrid.size}
              artistId={artist.id}
              onOpenMonth={openMonthStable}
              glass={irid ? glassBox : undefined}
            />
          </div>
        ) : (
          /* Dated: year -> month cards. */
          <div ref={monthGrid.ref} className={cn(irid ? "space-y-4" : "space-y-8")}>
            {needle && groups.length === 0 && (
              <div className="grid place-items-center rounded-2xl border border-dashed border-zinc-800 py-20 text-center text-sm text-zinc-500">
                {tf("No rewards match “{q}”.", { q: q.trim() })}
              </div>
            )}
            {groups.map(([year, months]) => {
              // the whole year is verified when every period is verified or a break (and at
              // least one is verified)
              const yearVerified =
                months.length > 0 &&
                months.some((m) => m.verified) &&
                months.every((m) => m.verified || m.skipped);
              // month periods are cards, year-level periods (no month) show their rewards
              // inline
              const monthPeriods = months.filter((m) => m.month != null);
              const yearRewards = months
                .filter((m) => m.month == null)
                .flatMap((m) =>
                  m.rewards.filter(matchesQuery).map((r) => ({ reward: r, monthId: m.id })),
                );
              return (
                <YearSection
                  key={year ?? "misc"}
                  year={year}
                  platform={platform?.name ?? null}
                  rule={
                    yearRules.find(
                      (r) => (r.platform ?? null) === (platform?.name ?? null) && r.year === year,
                    ) ?? null
                  }
                  onSdChanged={() => {
                    loadYearRules();
                    void refresh();
                  }}
                  verified={yearVerified}
                  monthPeriods={monthPeriods}
                  yearRewards={yearRewards}
                  // collab-only months have no DB row, never send their ids to
                  // delete_period
                  periodIds={months.filter((m) => !m.collabOnly).map((m) => m.id)}
                  hasContent={months.some((m) => ownRewards(m).length > 0)}
                  artistName={artist.name}
                  monthSize={monthGrid.size}
                  artistId={artist.id}
                  onOpenMonth={openMonthStable}
                  glass={irid ? glassBox : undefined}
                />
              );
            })}
          </div>
        )}
      </div>

      <AnimatePresence>
        {newFolderOpen && (
          <NewFolderDialog
            title={numbered ? t("New drop") : t("New folder")}
            initial={numbered ? t("New drop") : t("New folder")}
            years={platformYears}
            hint={
              numbered
                ? t(
                    "Pick a drop number, type a new one, or leave it blank to file under “Unsorted”. The “#” folder is created on disk too.",
                  )
                : t(
                    "Pick a year, type a new one, or leave it blank to file under “Misc”. The folder (and the year, if new) is created on disk too.",
                  )
            }
            onCreate={(name, year) => void createFolder(name, year)}
            onClose={() => setNewFolderOpen(false)}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {sidebar && (
          <ArtistSidebar artist={artist} focusName={focusName} onClose={() => setSidebar(false)} />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {favViewer && (
          <ImageViewer
            items={favViewer.items}
            startIndex={favViewer.index}
            coverTargets={{ artistId: artist.id }}
            onGoToFolder={goToFolder}
            onClose={() => setFavViewer(null)}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {monthViewer && (
          <ImageViewer
            items={monthViewer.items}
            startIndex={monthViewer.index}
            coverTargets={monthViewer.coverTargets}
            onClose={() => setMonthViewer(null)}
          />
        )}
      </AnimatePresence>
    </Layout>
  );
}

/**
 * Numbered drops view: a card per drop number (newest first), rewards without
 * a number in an "Unsorted" grid below.
 */
/**
 * Gap between month cards. 16px, but bigger on iridescent/cyberpunk because their
 * glow reaches outside the card and filled the gap. The half-track math subtracts
 * the same value, so cards stay monthSize wide.
 */
function cardGutter(accent: AccentKey): number {
  return accent === "iridescent" || accent === "cyberpunk" ? 22 : 16;
}

function NumberedSection({
  months,
  match,
  monthSize,
  artistId,
  onOpenMonth,
  glass,
}: {
  months: Month[];
  /** Search filter, the unsorted list only shows matching rewards. */
  match: (r: Reward) => boolean;
  monthSize: number;
  artistId: string;
  onOpenMonth: (monthId: string) => void;
  glass?: string;
}) {
  const t = useT();
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  const gutter = cardGutter(useAccent());
  const drops = months.filter((m) => m.number != null);
  const unsorted = months
    .filter((m) => m.number == null)
    .flatMap((m) => m.rewards.filter(match).map((r) => ({ reward: r, monthId: m.id })));
  return (
    <section className={cn(glass)}>
      {drops.length === 0 && unsorted.length === 0 ? (
        <div className="grid place-items-center rounded-2xl border border-dashed border-zinc-800 py-20 text-center text-sm text-zinc-500">
          {t("No drops yet — import a folder or drop one anywhere on this page.")}
        </div>
      ) : (
        <>
          {drops.length > 0 && (
            <div
              style={{
                gridTemplateColumns: `repeat(auto-fill, ${Math.max(112, monthSize - 16)}px)`,
                gap: gutter,
              }}
              className="grid"
            >
              {drops.map((m) => (
                <TileGate key={m.id} className="grid" data-drop-number={m.number ?? undefined} data-drop-label={m.label}>
                  <MonthCard month={m} onOpen={onOpenMonth} hideYear />
                </TileGate>
              ))}
            </div>
          )}
          {unsorted.length > 0 && (
            <div className={cn(drops.length > 0 && "mt-8")}>
              <div className="mb-3 flex items-center gap-3">
                <h2 className="text-lg font-semibold text-zinc-100">{t("Unsorted")}</h2>
                <span className="text-xs text-zinc-500">
                  {unsorted.length} reward{unsorted.length === 1 ? "" : "s"} without a drop number
                </span>
                <div className="h-px flex-1 bg-zinc-800" />
                <div ref={setHost} className="flex shrink-0 items-center gap-2" />
              </div>
              <RewardGrid
                items={unsorted}
                artistId={artistId}
                shapeKey={`artist:${artistId}`}
                toolbarHost={host}
                hideNewFolder
              />
            </div>
          )}
        </>
      )}
    </section>
  );
}

/**
 * One year section. Month periods are cards, rewards directly in the year show
 * inline (then the grid buttons go into the year header).
 */
function YearSection({
  year,
  platform,
  rule,
  onSdChanged,
  verified,
  monthPeriods,
  yearRewards,
  periodIds,
  hasContent,
  artistName,
  monthSize,
  artistId,
  onOpenMonth,
  glass,
}: {
  year: number | null;
  /** The platform tab of this year (for the MiSD year rule). */
  platform: string | null;
  /** The MiSD rule for this year, if any. */
  rule: api.SdYearRule | null;
  /** Reload the rules and library after a MiSD action. */
  onSdChanged: () => void;
  verified: boolean;
  monthPeriods: Month[];
  yearRewards: { reward: Reward; monthId: string }[];
  /** All period ids of this year (for "delete year"). */
  periodIds: string[];
  /** Does the year have files? (then deleting asks first) */
  hasContent: boolean;
  artistName: string;
  monthSize: number;
  artistId: string;
  onOpenMonth: (monthId: string) => void;
  /** Frosted glass on iridescent. */
  glass?: string;
}) {
  const t = useT();
  const tf = useTf();
  const tp = useTp();
  const { openMenu, requestDelete } = useActions();
  const { backed } = useData();
  // place for the inline grid's buttons
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  // clip while animating, overflow when open so the month glows aren't cut
  const [clipContent, setClipContent] = useState(false);
  // fold the year open/closed, saved per artist+year
  const collapseKey = `micoll.yearCollapsed.${artistId}.${year ?? "misc"}`;
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(collapseKey) === "1");
  const toggle = () => {
    setCollapsed((c) => {
      const next = !c;
      localStorage.setItem(collapseKey, next ? "1" : "0");
      return next;
    });
  };
  const hasInline = yearRewards.length > 0;
  const subtitle =
    monthPeriods.length > 0
      ? tp("{n} months", monthPeriods.length)
      : tp("{n} rewards", yearRewards.length);

  // premium themes: the divider becomes a year progress bar
  const irid = !!glass;
  const accent = useAccent();
  const sakura = accent === "sakura";
  const cyber = accent === "cyberpunk";
  const gutter = cardGutter(accent);
  const trackedMonths = monthPeriods.filter((m) => m.officialTotal != null);
  const yearTotal = trackedMonths.reduce((s, m) => s + (m.officialTotal || 0), 0);
  const yearOwned = trackedMonths.reduce(
    (s, m) => s + Math.min(monthOwnedCount(m), m.officialTotal || 0),
    0,
  );
  const yearPct = yearTotal > 0 ? yearOwned / yearTotal : null;

  // right-click the year header -> delete the whole year (asks if it has files)
  const label = year != null ? String(year) : "Misc";

  // MiSD for the whole year. It saves a rule for the year (see sd_mark_year) so
  // later rewards get queued too. Stopping the rule is its own entry,
  // separate from unmarking what's already queued.
  const sdOwned = [
    ...monthPeriods.flatMap((m) => ownRewards(m)),
    ...yearRewards.map((r) => r.reward),
  ].filter((r) => r.status === "owned");
  const sdLocal = sdOwned.filter((r) => !r.sdVolume);
  const sdQueued = sdLocal.filter((r) => r.sdMarked).length;
  const sdBackupQueued = sdLocal.filter((r) => r.sdBackupMarked).length;
  const sendYear = (marked: boolean, mode: api.SdMode) =>
    void api
      .sdMarkYear({ artistId: Number(artistId), platform, year, marked, mode })
      .then(onSdChanged);

  const sdItems: MenuItem[] = [];
  if (backed && sdLocal.length) {
    sdItems.push(
      sdQueued > 0
        ? {
            label: tf("Unmark move ({n})", { n: sdQueued }),
            icon: <HardDrive className="h-4 w-4" />,
            onClick: () => sendYear(false, "move"),
          }
        : {
            label: tf("Move {label} to disk", { label }),
            icon: <HardDrive className="h-4 w-4" />,
            onClick: () => sendYear(true, "move"),
          },
      sdBackupQueued > 0
        ? {
            label: tf("Unmark backup ({n})", { n: sdBackupQueued }),
            icon: <DatabaseBackup className="h-4 w-4" />,
            onClick: () => sendYear(false, "backup"),
          }
        : {
            label: tf("Back up {label} to disk", { label }),
            icon: <DatabaseBackup className="h-4 w-4" />,
            onClick: () => sendYear(true, "backup"),
          },
    );
  }
  if (rule) {
    sdItems.push(
      {
        label:
          rule.mode === "backup"
            ? t("New rewards here are queued for backup")
            : t("New rewards here are queued to move"),
        info: true,
      },
      {
        label: t("Stop queueing new rewards"),
        icon: <BellOff className="h-4 w-4" />,
        onClick: () =>
          void api
            .sdYearRule({ artistId: Number(artistId), platform, year, mode: null })
            .then(onSdChanged),
      },
    );
  }

  const yearMenu = (e: React.MouseEvent) =>
    openMenu(e, [
      ...(sdItems.length
        ? [{ label: "MiSD", icon: <HardDrive className="h-4 w-4" />, children: sdItems }]
        : []),
      {
        label: tf("Delete {label}…", { label }),
        icon: <Trash2 className="h-4 w-4" />,
        danger: true,
        onClick: () =>
          requestDelete({
            title: `${label} — ${artistName}`,
            periodIds,
            alwaysAsk: hasContent,
          }),
      },
    ]);

  return (
    <section
      className={cn(glass)}
      // dropping in the year area pre-fills the year
      data-drop-year={year ?? undefined}
    >
      <div className="mb-3 flex items-center gap-3" onContextMenu={yearMenu}>
        <button
          type="button"
          onClick={toggle}
          className="group flex items-center gap-3 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
          aria-expanded={!collapsed}
          title={collapsed ? t("Expand year") : t("Collapse year")}
        >
          <h2 className="text-lg font-semibold text-zinc-100 transition-colors group-hover:text-white">
            {year ?? t("Misc")}
          </h2>
          {verified &&
            // template mark in the theme's style
            (sakura ? (
              <span
                className="relative grid h-6 w-6 place-items-center"
                aria-label={t("Whole year verified by a template")}
              >
                <SakuraBlossomIcon
                  className="sak-bloom-badge absolute inset-0 h-6 w-6"
                  fill="currentColor"
                  stroke="none"
                />
                <span className="sak-bloom-core relative grid h-3 w-3 place-items-center rounded-full">
                  <Check className="h-2 w-2 text-white" strokeWidth={3.5} />
                </span>
              </span>
            ) : cyber ? (
              <span className="cp-check relative h-5 w-5" aria-label={t("Whole year verified by a template")}>
                <Check className="cp-check-base absolute inset-0 h-5 w-5" strokeWidth={3} />
                <Check className="cp-check-ghost absolute inset-0 h-5 w-5" strokeWidth={3} />
              </span>
            ) : irid ? (
              <Check
                className="iri-check h-5 w-5"
                strokeWidth={3}
                aria-label={t("Whole year verified by a template")}
              />
            ) : (
              <BadgeCheck className="h-5 w-5 text-brand-400" aria-label={t("Whole year verified by a template")} />
            ))}
          {/* "3 months" / "12 rewards", white on iridescent */}
          <span className={cn("text-xs", irid ? "text-white" : "text-zinc-500")}>{subtitle}</span>
        </button>
        {yearPct != null && (irid || sakura || cyber) ? (
          // year progress bar + % per premium theme (see .*-yearbar in index.css)
          <div className="flex flex-1 items-center gap-2">
            <div
              className={cn(
                "h-1.5 flex-1 overflow-hidden",
                irid ? "iri-bar rounded-full" : sakura ? "sak-yearbar rounded-full" : "cp-yearbar",
              )}
            >
              <div
                className={cn(
                  "h-full",
                  irid ? "iri-fill rounded-full" : sakura ? "sak-yearfill rounded-full" : "cp-yearfill",
                )}
                style={{ width: `${Math.max(3, Math.round(yearPct * 100))}%` }}
              />
            </div>
            <span
              className={cn(
                "shrink-0 text-xs font-bold tabular-nums",
                irid
                  ? "iri-pct"
                  : sakura
                    ? "sak-pct"
                    : "font-mono text-[#fcee0a] [text-shadow:0_0_10px_rgba(252,238,10,0.55)]",
              )}
            >
              {Math.round(yearPct * 100)}%
            </span>
          </div>
        ) : (
          // no template: a plain line (iridescent/cyberpunk have their own, see .iri-rule /
          // .cp-rule)
          <div
            className={cn(
              "h-px flex-1",
              irid ? "iri-rule" : cyber ? "cp-rule" : "bg-zinc-800",
            )}
          />
        )}
        {/* inline grid buttons go here */}
        {hasInline && !collapsed && <div ref={setHost} className="flex shrink-0 items-center gap-2" />}
      </div>
      <AnimatePresence initial={false}>
        {!collapsed && (
          <motion.div
            key="content"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.25, ease: [0.4, 0, 0.2, 1] }}
            onAnimationStart={() => setClipContent(true)}
            onAnimationComplete={() => setClipContent(false)}
            style={{ overflow: clipContent ? "hidden" : "visible" }}
          >
            {monthPeriods.length > 0 && (
              <div
                // half-width tracks: a month spans 2 (stays monthSize wide), a break 1.
                // dense fills the gaps
                style={{
                  gridTemplateColumns: `repeat(auto-fill, ${Math.max(56, Math.round((monthSize - gutter) / 2))}px)`,
                  gridAutoFlow: "dense",
                  gap: gutter,
                }}
                className="grid"
              >
                {monthPeriods.map((m) => (
                  <TileGate
                    key={m.id}
                    // single-cell grid stretches the card to fill the cell
                    className="grid"
                    style={{ gridColumn: m.skipped ? "span 1" : "span 2" }}
                  >
                    <MonthCard month={m} onOpen={onOpenMonth} hideYear />
                  </TileGate>
                ))}
              </div>
            )}
            {hasInline && (
              <div className={cn(monthPeriods.length > 0 && "mt-4")}>
                <RewardGrid
                  items={yearRewards}
                  artistId={artistId}
                  shapeKey={`artist:${artistId}`}
                  toolbarHost={host}
                  hideNewFolder
                />
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  );
}
