import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { AnimatePresence } from "framer-motion";
import { CheckSquare, Pencil, Trash2, X, FolderOpen, RotateCcw, RefreshCw, CopyCheck, MousePointerSquareDashed, Share2, FolderInput, FolderPlus, MonitorPlay, FileQuestion, HardDrive, DatabaseBackup, Users, Unlink, ExternalLink, Info } from "lucide-react";
import { openDuplicates } from "@/lib/duplicates";
import { RewardSlot } from "@/components/RewardSlot";
import { ImageViewer, type CoverTargets, type ViewerItem } from "@/components/ImageViewer";
import { RenameDialog, type RenameTarget } from "@/components/RenameDialog";
import { RewardDetails } from "@/components/RewardDetails";
import { SharePhoneModal } from "@/components/SharePhoneModal";
import { ShareSheet, type ShareRequest } from "@/components/ShareSheet";
import { MegaUploadModal } from "@/components/MegaUploadModal";
import { MovePicker, NewFolderDialog } from "@/components/MovePicker";
import { MergeChoiceDialog } from "@/components/MergeChoiceDialog";
import { SdNoticeDialog } from "@/components/SdNoticeDialog";
import { open } from "@tauri-apps/plugin-dialog";
import { useData } from "@/store";
import { useActions } from "@/actions";
import { setRewardCover, exportFiles, createReward, createMissingReward, ensurePeriod, moveRewards, mergeRewards, setWallpaperSlideshow, getSetting, setSetting, sdAvailable, sdMark, sdBackupDrop, setRewardCollabs, setRewardsExtra, type SdMode } from "@/api/library";
import { isTauri } from "@/lib/tauri";
import { useCardSize } from "@/lib/useCardSize";
import { useTileShapeFor, type TileScope } from "@/lib/tileShape";
import { buildFolderOrder } from "@/lib/rewardOrder";
import { useDialogTheme } from "@/lib/dialogTheme";
import { useAccent } from "@/lib/theme";
import { cn } from "@/lib/utils";
import { useT, useTf } from "@/lib/i18n";
import { isVirtualMonthId, type Reward } from "@/types";
import { CollabPicker } from "@/components/CollabPicker";
import { TileGate } from "@/components/TileGate";

const MEDIA_EXTS = [
  "jpg", "jpeg", "jfif", "png", "gif", "webp", "bmp", "avif", "tif", "tiff",
  "mp4", "webm", "mov", "m4v", "mkv", "avi", "wmv", "flv",
  "zip", "rar", "7z", "cbz", "cbr", "tar", "gz",
];

interface Item {
  reward: Reward;
  monthId: string;
}

interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Reward grid with a selection mode like Windows Explorer: "Select" shows checkboxes,
 * you can drag a box, Ctrl-click and Shift-click, then rename or delete.
 * Outside selection mode: click opens, checkbox toggles ownership.
 */
/**
 * Extras go last, A-Z among themselves; the other rewards keep the order they came in.
 * (They're bonus material, the month's real releases come first.)
 */
function extrasLast(items: Item[]): Item[] {
  if (!items.some((it) => it.reward.isExtra)) return items;
  const extras = items
    .filter((it) => it.reward.isExtra)
    .sort((a, b) =>
      a.reward.title.localeCompare(b.reward.title, undefined, { numeric: true, sensitivity: "base" }),
    );
  return [...items.filter((it) => !it.reward.isExtra), ...extras];
}

export function RewardGrid({
  items: itemsIn,
  artistId,
  toolbarHost,
  defaultPeriodId,
  allowMissing = false,
  hideNewFolder = false,
  fillHeight = false,
  shapeScope = "year",
  shapeKey,
}: {
  items: Item[];
  artistId?: string;
  /** If set, the "Select" button is portaled here (e.g. next to Details). */
  toolbarHost?: HTMLElement | null;
  /**
   * The period of these rewards, so New folder / Add missing also work in an empty month.
   */
  defaultPeriodId?: string;
  /** Show "Add missing" (only when no template covers this platform). */
  allowMissing?: boolean;
  /** Hide the grid's own "New folder" button. */
  hideNewFolder?: boolean;
  /**
   * Let the grid fill the page height so you can right-click the empty space below.
   * Only on pages where the grid is the whole content (a month view).
   */
  fillHeight?: boolean;
  /** Which tile shape setting this grid uses. */
  shapeScope?: TileScope;
  /** This page's own shape override (artist:12, period:34), if any. */
  shapeKey?: string;
}) {
  const t = useT();
  const tf = useTf();
  // everything below (selection ranges, the viewer, menus) uses this order
  const items = useMemo(() => extrasLast(itemsIn), [itemsIn]);
  const { artists, refresh, backed, markRewardSeen } = useData();
  const { openMenu, reveal, requestDelete, reload, showToast, bringBackFromSd, fillRewardInteractive } =
    useActions();
  const navigate = useNavigate();
  // small buttons use the theme's control style (not grey zinc)
  const { control } = useDialogTheme();
  const irid = useAccent() === "iridescent";

  const [viewer, setViewer] = useState<{
    items: ViewerItem[];
    index: number;
    coverTargets?: CoverTargets;
  } | null>(null);

  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [rename, setRename] = useState<RenameTarget[] | null>(null);
  // reward whose Details panel is open
  const [details, setDetails] = useState<Reward | null>(null);
  const [addErr, setAddErr] = useState<string | null>(null);
  const [addingId, setAddingId] = useState<string | null>(null);
  const anchorRef = useRef<number | null>(null);
  // share sheet + the two destinations with their own dialog
  const [sharePick, setSharePick] = useState<ShareRequest | null>(null);
  const [shareReward, setShareReward] = useState<{ srcs: string[]; name: string } | null>(null);
  const [megaReward, setMegaReward] = useState<{
    srcs: string[];
    name: string;
    creator?: string;
  } | null>(null);
  // move folders / create a new folder
  const [movePick, setMovePick] = useState<{ rewardIds: string[]; fromMonthId?: string } | null>(null);
  // after picking a target reward: keep the folder or move only the files
  const [mergeChoice, setMergeChoice] = useState<{ ids: string[]; destRewardId: string } | null>(null);
  const [newFolder, setNewFolder] = useState<{ periodId: string } | null>(null);
  // reward whose collab creators are being picked
  const [collabPick, setCollabPick] = useState<Reward | null>(null);
  const [newMissing, setNewMissing] = useState<{ periodId: string } | null>(null);

  // if all rewards are in the same period, "New folder" knows where to create it
  const singlePeriodId = useMemo(() => {
    const ids = new Set(items.filter((it) => !it.reward.collabFrom).map((it) => it.monthId));
    const only = ids.size === 1 ? [...ids][0] : (defaultPeriodId ?? null);
    // collab-only periods have no DB row, so no New folder / Add missing there
    return only && !isVirtualMonthId(only) ? only : null;
  }, [items, defaultPeriodId]);

  /** Paths of a reward's media files. */
  const rewardSrcs = (r: Reward) => r.images.map((im) => im.path).filter((p): p is string => !!p);

  /** Remove a borrowed reward from THIS creator's card (only this link). */
  const removeCollab = async (r: Reward, dropArtistId: string) => {
    const next = (r.collabWith ?? []).map((c) => c.artistId).filter((id) => id !== dropArtistId);
    try {
      await setRewardCollabs(r.id, next);
      await refresh();
      showToast({ tone: "success", title: t("Collab link removed") });
    } catch (err) {
      showToast({ tone: "error", title: t("Couldn’t remove the collab link"), problem: `${err}` });
    }
  };

  /** "Save a copy...": pick a folder and copy the files into a <name> subfolder. */
  const saveCopy = async (srcs: string[], name: string) => {
    if (!srcs.length) return;
    const dir = await open({ directory: true, multiple: false, title: `Save “${name}” to…` });
    if (typeof dir !== "string") return;
    try {
      const n = await exportFiles(srcs, dir, name);
      showToast({ tone: "success", title: `Saved ${n} file${n === 1 ? "" : "s"}`, detail: `${dir}\\${name}` });
    } catch (e) {
      showToast({ tone: "error", title: t("Couldn’t save a copy"), detail: `${e}` });
    }
  };

  /** Move the rewards into the chosen period, then refresh. */
  const doMoveRewards = async (periodId: string) => {
    const ids = movePick?.rewardIds ?? [];
    setMovePick(null);
    if (!ids.length) return;
    try {
      const n = await moveRewards(ids, periodId);
      await refresh();
      exitSelect();
      showToast({ tone: "success", title: `Moved ${n} ${n === 1 ? "reward" : "rewards"}` });
    } catch (e) {
      showToast({ tone: "error", title: t("Couldn’t move"), detail: `${e}` });
    }
  };

  /** Create a new year/month, then move the rewards into it. */
  const doMoveToNewPeriod = async (
    np: { artistId: string; platform: string | null; year: number | null; month: number | null },
    ids: string[],
  ) => {
    if (!ids.length) return;
    try {
      const periodId = await ensurePeriod(np.artistId, np.platform, np.year, np.month);
      const n = await moveRewards(ids, String(periodId));
      await refresh();
      exitSelect();
      showToast({ tone: "success", title: `Moved ${n} ${n === 1 ? "reward" : "rewards"}` });
    } catch (e) {
      showToast({ tone: "error", title: t("Couldn’t move"), detail: `${e}` });
    }
  };

  /** A target reward was picked: use the saved keep-folder choice or ask. */
  const startMerge = async (ids: string[], destRewardId: string) => {
    const pref = await getSetting("merge_keep_folder").catch(() => null);
    if (pref === "true" || pref === "false") {
      await doMergeRewards(destRewardId, ids, pref === "true");
    } else {
      setMergeChoice({ ids, destRewardId });
    }
  };

  /** Merge rewards into another reward. keepFolder = as subfolder, else only the files. */
  const doMergeRewards = async (destRewardId: string, ids: string[], keepFolder: boolean) => {
    const sources = ids.filter((id) => id !== destRewardId);
    if (!sources.length) return;
    try {
      const n = await mergeRewards(sources, destRewardId, keepFolder);
      await refresh();
      exitSelect();
      showToast({ tone: "success", title: `Merged ${n} file${n === 1 ? "" : "s"}` });
    } catch (e) {
      showToast({ tone: "error", title: t("Couldn’t merge"), detail: `${e}` });
    }
  };

  /** Create an empty folder in the period, then refresh. */
  const doCreateFolder = async (name: string) => {
    const periodId = newFolder?.periodId;
    setNewFolder(null);
    if (!periodId) return;
    try {
      await createReward(periodId, name);
      await refresh();
      showToast({ tone: "success", title: `Created “${name}”` });
    } catch (e) {
      showToast({ tone: "error", title: t("Couldn’t create folder"), detail: `${e}` });
    }
  };

  /** Add a "missing" placeholder card, then refresh. */
  const doCreateMissing = async (name: string) => {
    const periodId = newMissing?.periodId;
    setNewMissing(null);
    if (!periodId) return;
    try {
      await createMissingReward(periodId, name);
      await refresh();
      showToast({ tone: "success", title: `Added missing “${name}”` });
    } catch (e) {
      showToast({ tone: "error", title: t("Couldn’t add missing reward"), detail: `${e}` });
    }
  };

  /** Right-click on empty grid space ("New folder here..."). */
  const emptySpaceMenu = (e: React.MouseEvent) => {
    if (!backed || selectMode) return;
    // tiles have their own menu, only empty space opens this one
    if ((e.target as HTMLElement).closest("[data-tile]")) return;
    if (!singlePeriodId) return;
    openMenu(e, [
      {
        label: t("New folder here…"),
        icon: <FolderPlus className="h-4 w-4" />,
        onClick: () => setNewFolder({ periodId: singlePeriodId }),
      },
    ]);
  };

  /* ---- share the current selection (one or more reward folders) ----- */
  const selectedRewards = () =>
    items.filter((it) => selected.has(it.reward.id)).map((it) => it.reward);
  const selectionSrcs = () => selectedRewards().flatMap(rewardSrcs);
  const selectionName = () => {
    const rs = selectedRewards();
    return rs.length === 1 ? rs[0].title : tf("{n} rewards selected", { n: rs.length });
  };
  /** A single image reward can also be copied as a picture. */
  const soleImage = (r: Reward) =>
    r.images.length === 1 && r.images[0].kind === "image" ? (r.images[0].path ?? null) : null;
  /** Who a reward belongs to (for share names). Borrowed ones name the owner. */
  const creatorOf = (r?: Reward) =>
    r?.collabFrom?.artistName ?? artists.find((a) => a.id === artistId)?.name;
  const shareSelection = () => {
    const srcs = selectionSrcs();
    if (!srcs.length) return;
    const rs = selectedRewards();
    setSharePick({
      srcs,
      name: selectionName(),
      creator: creatorOf(rs.length === 1 ? rs[0] : undefined),
    });
  };

  // fill a missing reward: pick files -> copy into the month folder -> owned
  const addToReward = async (r: Reward) => {
    if (!backed || addingId) return;
    const picked = await open({
      multiple: true,
      title: `Add files for “${r.title}”`,
      filters: [{ name: "Media", extensions: MEDIA_EXTS }],
    });
    const paths = Array.isArray(picked) ? picked : typeof picked === "string" ? [picked] : [];
    if (!paths.length) return;
    setAddErr(null);
    setAddingId(r.id);
    try {
      const report = await fillRewardInteractive(r.id, paths, { label: r.title });
      if (report === null) return; // user cancelled the whole import
      await refresh();
      const plural = (n: number) => (n === 1 ? "file" : "files");
      const problems: string[] = [];
      if (report.failed > 0) problems.push(`${report.failed} couldn’t be imported`);
      if (report.skipped > 0) problems.push(`${report.skipped} skipped`);
      showToast({
        tone: report.failed > 0 ? "warn" : "success",
        title: `${report.added} ${plural(report.added)} added`,
        detail: `to ${r.title}`,
        problem: problems.length ? problems.join(" · ") : undefined,
      });
    } catch (e) {
      setAddErr(`${e}`);
    } finally {
      setAddingId(null);
    }
  };

  const gridRef = useRef<HTMLDivElement>(null);
  const [marquee, setMarquee] = useState<Rect | null>(null);
  const dragRef = useRef<{ x: number; y: number } | null>(null);

  // Ctrl+wheel resizes the tiles, the shape is the page's setting
  const tiles = useCardSize("micoll.rewardSize", 170, 110, 320);
  const shape = useTileShapeFor(shapeScope, shapeKey);
  const setGridNode = useCallback(
    (node: HTMLDivElement | null) => {
      gridRef.current = node;
      tiles.ref(node);
    },
    [tiles],
  );

  const idAt = (i: number) => items[i].reward.id;
  const titleOf = (id: string) => items.find((it) => it.reward.id === id)?.reward.title ?? "";

  const exitSelect = useCallback(() => {
    setSelectMode(false);
    setSelected(new Set());
    anchorRef.current = null;
  }, []);

  // "this reward is on the unplugged MiSD disk" notice
  const [sdNotice, setSdNotice] = useState<{ title: string; volume: string } | null>(null);

  const openReward = (r: Reward, monthId: string) => {
    // MiSD rewards only open while the disk is connected
    if (r.sdVolume) {
      const vol = r.sdVolume;
      sdAvailable()
        .then((ok) => (ok ? reallyOpenReward(r, monthId) : setSdNotice({ title: r.title, volume: vol })))
        .catch(() => setSdNotice({ title: r.title, volume: vol }));
      return;
    }
    reallyOpenReward(r, monthId);
  };

  const reallyOpenReward = (r: Reward, monthId: string) => {
    // opening it clears "new" (through the store so it stays cleared)
    if (r.fresh) markRewardSeen(r.id);
    // reward folder files first, then subfolders (A-Z), with the subfolder on each image
    const ordered = buildFolderOrder(r.images);
    const vItems: ViewerItem[] = ordered.length
      ? ordered.map(({ image: im, group }) => ({
          id: im.id,
          title: im.name ? `${r.title} — ${im.name}` : r.title,
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
        }))
      : [{ id: r.id, title: r.title, src: "", path: r.cover }];
    // borrowed rewards / collab-only months can't get a cover here
    const virtual = !!r.collabFrom || isVirtualMonthId(monthId);
    setViewer({
      items: vItems,
      index: 0,
      coverTargets: virtual
        ? undefined
        : { rewardId: r.id, periodId: monthId, artistId, shapeScope, shapeKey },
    });
  };

  /* ---- selection by click (in select mode) -------------------------- */
  const clickSelect = (e: React.MouseEvent, index: number) => {
    e.preventDefault();
    e.stopPropagation();
    const id = idAt(index);
    if (e.shiftKey && anchorRef.current != null) {
      const [a, b] = [anchorRef.current, index].sort((x, y) => x - y);
      setSelected(
        new Set(
          items
            .slice(a, b + 1)
            .filter((it) => !it.reward.collabFrom)
            .map((it) => it.reward.id),
        ),
      );
    } else if (e.ctrlKey || e.metaKey) {
      setSelected((prev) => {
        const n = new Set(prev);
        n.has(id) ? n.delete(id) : n.add(id);
        return n;
      });
      anchorRef.current = index;
    } else {
      setSelected(new Set([id]));
      anchorRef.current = index;
    }
  };

  /* ---- marquee (drag a box over empty grid space) ------------------- */
  const onGridMouseDown = (e: React.MouseEvent) => {
    if (!selectMode || e.button !== 0) return;
    // only start a box on empty space
    if ((e.target as HTMLElement).closest("[data-tile]")) return;
    const host = gridRef.current;
    if (!host) return;
    dragRef.current = { x: e.clientX, y: e.clientY };
    if (!(e.ctrlKey || e.metaKey)) setSelected(new Set());
  };

  useEffect(() => {
    if (!selectMode) return;
    const move = (e: MouseEvent) => {
      const start = dragRef.current;
      const host = gridRef.current;
      if (!start || !host) return;
      const hostRect = host.getBoundingClientRect();
      const left = Math.min(start.x, e.clientX);
      const top = Math.min(start.y, e.clientY);
      const right = Math.max(start.x, e.clientX);
      const bottom = Math.max(start.y, e.clientY);
      setMarquee({
        left: left - hostRect.left,
        top: top - hostRect.top,
        width: right - left,
        height: bottom - top,
      });
      // select every tile the box touches
      const hits = new Set<string>();
      host.querySelectorAll<HTMLElement>("[data-tile]").forEach((el) => {
        const r = el.getBoundingClientRect();
        const intersects = !(r.right < left || r.left > right || r.bottom < top || r.top > bottom);
        if (intersects) hits.add(el.dataset.tile!);
      });
      setSelected((prev) => {
        // keep the old selection only with Ctrl
        const base = e.ctrlKey || e.metaKey ? prev : new Set<string>();
        return new Set([...base, ...hits]);
      });
    };
    const up = () => {
      dragRef.current = null;
      setMarquee(null);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
  }, [selectMode]);

  // Esc leaves selection mode
  useEffect(() => {
    if (!selectMode) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && exitSelect();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectMode, exitSelect]);

  /* ---- actions ------------------------------------------------------ */
  /**
   * Selected ids without the ones on the MiSD disk (a backup is still local and editable).
   */
  const editableSelection = () =>
    [...selected].filter(
      (id) => !items.find((it) => it.reward.id === id)?.reward.sdVolume,
    );

  const renameSelection = () =>
    setRename(editableSelection().map((id) => ({ id, name: titleOf(id) })));

  const deleteSelection = () => {
    const ids = editableSelection();
    if (ids.length === 0) return;
    requestDelete({
      title: `${ids.length} reward${ids.length > 1 ? "s" : ""}`,
      rewardIds: ids,
      onDone: exitSelect,
    });
  };

  /** Set a desktop slideshow from a folder's images. */
  const setFolderWallpaper = async (imgs: string[], name: string) => {
    if (!imgs.length) return;
    try {
      await setWallpaperSlideshow(imgs);
      showToast({
        tone: "success",
        title: t("Wallpaper slideshow set"),
        detail: `${imgs.length} image${imgs.length === 1 ? "" : "s"} from ${name}`,
      });
    } catch (e) {
      showToast({ tone: "error", title: t("Couldn’t set wallpaper"), detail: `${e}` });
    }
  };

  /* ---- MiSD actions -------------------------------------------------- */
  const sdMarkRewards = async (ids: string[], marked: boolean, mode: SdMode = "move") => {
    try {
      await sdMark({ rewardIds: ids.map(Number), marked, mode });
      await refresh();
    } catch (err) {
      showToast({ tone: "error", title: "MiSD", detail: `${err}` });
    }
  };

  /** Delete the backup copies on the disk (local files are never touched). */
  const sdDropBackup = async (ids: string[]) => {
    try {
      const s = await sdBackupDrop(ids.map(Number));
      showToast(
        s.failed
          ? {
              tone: "warn",
              title: `MiSD: removed ${s.moved} backups, ${s.failed} failed`,
              detail: s.errors.slice(0, 3).join(" · "),
            }
          : {
              tone: "success",
              title: t("MiSD backup removed"),
              detail: t("The local files were not touched."),
            },
      );
      await refresh();
    } catch (err) {
      showToast({ tone: "error", title: "MiSD", detail: `${err}` });
    }
  };

  const sdBringBack = (ids: string[]) => bringBackFromSd(ids.map(Number));

  /** Mark rewards as extras (or not) and reload. */
  const markExtra = async (ids: string[], extra: boolean) => {
    try {
      const n = await setRewardsExtra(ids, extra);
      await refresh();
      showToast({
        tone: "success",
        title: extra
          ? tf("{n} marked as extra", { n })
          : tf("{n} back to a normal reward", { n }),
        detail: extra ? t("They no longer stand in for their month.") : undefined,
      });
    } catch (e) {
      showToast({ tone: "error", title: t("Couldn\u2019t change that"), detail: `${e}` });
    }
  };

  /** "Patreon · 05.25" for the Details panel (looked up in the store). */
  const whereOf = (monthId: string): string | undefined => {
    for (const a of artists) {
      if (artistId && a.id !== artistId) continue;
      for (const p of a.platforms)
        for (const m of p.months) if (m.id === monthId) return `${p.name} · ${m.label}`;
    }
    return undefined;
  };

  const rewardMenu = (e: React.MouseEvent, r: Reward, monthId: string) => {
    const srcs = rewardSrcs(r);
    // displayPath = the picture you see in MiColl (active version)
    const imgSrcs = r.images.filter((im) => im.kind === "image").map((im) => im.displayPath || im.path).filter((p): p is string => !!p);

    // borrowed rewards only get read-only actions and the link itself
    // (everything else, especially Delete, belongs to the owner)
    if (r.collabFrom) {
      const from = r.collabFrom;
      openMenu(e, [
        {
          label: `Collab — lives in ${from.artistName}’s folder`,
          icon: <Users className="h-4 w-4" />,
          info: true,
        },
        {
          label: t("Details"),
          icon: <Info className="h-4 w-4" />,
          quick: 0,
          onClick: () => setDetails(r),
        },
        {
          label: t("Show in Explorer"),
          icon: <FolderOpen className="h-4 w-4" />,
          onClick: () => reveal(r.folderPath),
        },
        {
          label: `Go to ${from.artistName}`,
          icon: <ExternalLink className="h-4 w-4" />,
          onClick: () => navigate(`/artist/${from.artistId}`),
        },
        ...(imgSrcs.length && isTauri()
          ? [
              {
                label: t("Set as Wallpaper"),
                icon: <MonitorPlay className="h-4 w-4" />,
                onClick: () => void setFolderWallpaper(imgSrcs, r.title),
              },
            ]
          : []),
        ...(srcs.length
          ? [
              {
                label: t("Share…"),
                icon: <Share2 className="h-4 w-4" />,
                onClick: () => setSharePick({ srcs, name: r.title, creator: creatorOf(r), image: soleImage(r) }),
              },
            ]
          : []),
        {
          label: t("Reload"),
          icon: <RefreshCw className="h-4 w-4" />,
          quick: 2,
          keepOpen: true,
          onClick: () => void reload(),
        },
        ...(backed && artistId
          ? [
              {
                label: t("Remove collab link"),
                icon: <Unlink className="h-4 w-4" />,
                danger: true,
                onClick: () => void removeCollab(r, artistId),
              },
            ]
          : []),
      ]);
      return;
    }

    openMenu(e, [
      // Details / Rename / Reload in the icon row, Reload keeps the menu open
      {
          label: t("Details"),
          icon: <Info className="h-4 w-4" />,
          quick: 0,
          onClick: () => setDetails(r),
        },
      {
          label: t("Show in Explorer"),
          icon: <FolderOpen className="h-4 w-4" />,
          onClick: () => reveal(r.folderPath),
        },
      ...(imgSrcs.length && isTauri()
        ? [
            {
              label: t("Set as Wallpaper"),
              icon: <MonitorPlay className="h-4 w-4" />,
              onClick: () => void setFolderWallpaper(imgSrcs, r.title),
            },
          ]
        : []),
      // only when there's a custom cover
      ...(r.coverCustom
        ? [
            {
              label: t("Reset cover"),
              icon: <RotateCcw className="h-4 w-4" />,
              onClick: () => {
                if (backed) void setRewardCover(r.id, "").then(() => refresh());
              },
            },
          ]
        : []),
      // rename/move/delete need "Bring back" first for MiSD rewards
      ...(!r.sdVolume
        ? [
            {
              label: t("Rename"),
              icon: <Pencil className="h-4 w-4" />,
              quick: 1,
              onClick: () => setRename([{ id: r.id, name: r.title }]),
            },
          ]
        : []),
      ...(backed && !r.sdVolume
        ? [
            {
              label: t("Move"),
              icon: <FolderInput className="h-4 w-4" />,
              onClick: () => setMovePick({ rewardIds: [r.id], fromMonthId: monthId }),
            },
          ]
        : []),
      ...(backed
        ? [
            // "Collab with…" is in Details now, the menu only says where it's shown
            ...(r.collabWith?.length
              ? [
                  {
                    label: `Also shown in: ${r.collabWith.map((c) => c.artistName).join(", ")}`,
                    info: true,
                  },
                ]
              : []),
          ]
        : []),
      {
        label: t("Find duplicates"),
        icon: <CopyCheck className="h-4 w-4" />,
        onClick: () => openDuplicates({ label: r.title, rewardId: Number(r.id) }),
      },
      ...(srcs.length
        ? [
            {
              label: t("Share…"),
              icon: <Share2 className="h-4 w-4" />,
              onClick: () => setSharePick({ srcs, name: r.title, creator: creatorOf(r), image: soleImage(r) }),
            },
          ]
        : []),
      // MiSD submenu. On the disk: only bring back. Otherwise queue move or copy.
      ...(backed && r.status !== "missing"
        ? [
            {
              label: "MiSD",
              icon: <HardDrive className="h-4 w-4" />,
              children: r.sdVolume
                ? [
                    {
                      label: t("Bring back"),
                      icon: <HardDrive className="h-4 w-4" />,
                      onClick: () => void sdBringBack([r.id]),
                    },
                  ]
                : [
                    r.sdMarked
                      ? {
                          label: t("Unmark move"),
                          icon: <HardDrive className="h-4 w-4" />,
                          onClick: () => void sdMarkRewards([r.id], false, "move"),
                        }
                      : {
                          label: t("Move to disk"),
                          icon: <HardDrive className="h-4 w-4" />,
                          onClick: () => void sdMarkRewards([r.id], true, "move"),
                        },
                    r.sdBackupMarked
                      ? {
                          label: t("Unmark backup"),
                          icon: <DatabaseBackup className="h-4 w-4" />,
                          onClick: () => void sdMarkRewards([r.id], false, "backup"),
                        }
                      : {
                          label: r.sdBackup ? "Refresh backup" : "Back up to disk",
                          icon: <DatabaseBackup className="h-4 w-4" />,
                          onClick: () => void sdMarkRewards([r.id], true, "backup"),
                        },
                    ...(r.sdBackup
                      ? [
                          {
                            label: t("Remove backup"),
                            icon: <DatabaseBackup className="h-4 w-4" />,
                            danger: true,
                            onClick: () => void sdDropBackup([r.id]),
                          },
                        ]
                      : []),
                  ],
            },
          ]
        : []),
      {
        label: t("Reload"),
        icon: <RefreshCw className="h-4 w-4" />,
        quick: 2,
        keepOpen: true,
        onClick: () => void reload(),
      },
      ...(!r.sdVolume
        ? [
            {
              label: t("Delete"),
              icon: <Trash2 className="h-4 w-4" />,
              danger: true,
              onClick: () => requestDelete({ title: r.title, rewardIds: [r.id] }),
            },
          ]
        : []),
    ]);
  };

  // outline pill like "Details": icon only, label slides in on hover. No title: the
  // label is the hint, a webview tooltip on top showed the same text twice
  const ToolBtn = ({
    icon,
    label,
    title,
    onClick,
  }: {
    icon: React.ReactNode;
    label: string;
    title?: string;
    onClick: () => void;
  }) => (
    <button
      onClick={onClick}
      aria-label={label}
      aria-description={title}
      className={cn(
        "group inline-flex h-8 items-center px-2 text-sm font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-brand-500",
        control,
      )}
    >
      <span className="grid h-4 w-4 shrink-0 place-items-center">{icon}</span>
      <span className="max-w-0 overflow-hidden whitespace-nowrap opacity-0 transition-all duration-200 group-hover:ml-1.5 group-hover:max-w-[8rem] group-hover:opacity-100">
        {label}
      </span>
    </button>
  );

  // entry buttons, inline or portaled into the page header
  const entryButtons = (
    <>
      {backed && !hideNewFolder && singlePeriodId && (
        <ToolBtn
          icon={<FolderPlus className="h-4 w-4 text-white" />}
          label={t("New folder")}
          title={t("Create a new (empty) folder here")}
          onClick={() => setNewFolder({ periodId: singlePeriodId })}
        />
      )}
      {backed && allowMissing && singlePeriodId && (
        <ToolBtn
          icon={<FileQuestion className="h-4 w-4 text-amber-400" />}
          label={t("Add missing")}
          title={t("Add a placeholder card for a reward you don’t have yet (a reminder)")}
          onClick={() => setNewMissing({ periodId: singlePeriodId })}
        />
      )}
      <ToolBtn
        icon={<MousePointerSquareDashed className="h-4 w-4 text-white" />}
        label={t("Select")}
        title={t("Select multiple to share, move, rename or delete")}
        onClick={() => setSelectMode(true)}
      />
    </>
  );

  // toolbar in selection mode
  const selectionToolbar = (
    <>
      <span className="text-sm text-zinc-300">{tf("{n} selected", { n: selected.size })}</span>
      <button
        onClick={() =>
          setSelected(
            new Set(items.filter((it) => !it.reward.collabFrom).map((it) => it.reward.id)),
          )
        }
        className={cn("px-2.5 py-1 text-xs transition-colors", control)}
      >
        {t("Select all")}
      </button>
      <div className="ml-auto flex items-center gap-2">
        <button
          onClick={shareSelection}
          disabled={selected.size === 0}
          className={cn(
            "inline-flex items-center gap-1.5 px-3 py-1.5 text-sm transition-colors disabled:opacity-40",
            control,
          )}
          title={t("Share the selected reward folders")}
        >
          <Share2 className="h-4 w-4" />
          {t("Share")}
        </button>
        <button
          onClick={() => {
            const ids = editableSelection();
            if (ids.length) setMovePick({ rewardIds: ids });
          }}
          disabled={selected.size === 0}
          className={cn(
            "inline-flex items-center gap-1.5 px-3 py-1.5 text-sm transition-colors disabled:opacity-40",
            control,
          )}
          title={t("Move the selected rewards into another month")}
        >
          <FolderInput className="h-4 w-4" />
          {t("Move")}
        </button>
        <button
          onClick={() => {
            if (selected.size)
              void sdMarkRewards([...selected], true, "move").then(() => exitSelect());
          }}
          disabled={selected.size === 0}
          className={cn(
            "inline-flex items-center gap-1.5 px-3 py-1.5 text-sm transition-colors disabled:opacity-40",
            control,
          )}
          title={t(
            "Move the selected rewards to the MiSD disk on the next run — frees space here (Settings → MiSD)",
          )}
        >
          <HardDrive className="h-4 w-4" />
          {t("To MiSD")}
        </button>
        <button
          onClick={() => {
            if (selected.size)
              void sdMarkRewards([...selected], true, "backup").then(() => exitSelect());
          }}
          disabled={selected.size === 0}
          className={cn(
            "inline-flex items-center gap-1.5 px-3 py-1.5 text-sm transition-colors disabled:opacity-40",
            control,
          )}
          title={t(
            "Copy the selected rewards to the MiSD disk on the next run — the files stay here too (Settings → MiSD)",
          )}
        >
          <DatabaseBackup className="h-4 w-4" />
          {t("Back up")}
        </button>
        <button
          onClick={renameSelection}
          disabled={selected.size === 0}
          className={cn(
            "inline-flex items-center gap-1.5 px-3 py-1.5 text-sm transition-colors disabled:opacity-40",
            control,
          )}
        >
          <Pencil className="h-4 w-4" />
          {t("Rename")}
        </button>
        <button
          onClick={deleteSelection}
          disabled={selected.size === 0}
          className="inline-flex items-center gap-1.5 rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-1.5 text-sm text-rose-200 transition-colors hover:bg-rose-500/20 disabled:opacity-40"
        >
          <Trash2 className="h-4 w-4" />
          {t("Delete")}
        </button>
        <button
          onClick={exitSelect}
          className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm text-zinc-400 hover:text-zinc-200"
          title={t("Done (Esc)")}
        >
          <X className="h-4 w-4" />
          {t("Done")}
        </button>
      </div>
    </>
  );

  return (
    <>
      {/* entry buttons in the page header */}
      {toolbarHost && !selectMode && createPortal(entryButtons, toolbarHost)}

      {/* toolbar row, hidden when the buttons are in the header and we're not selecting */}
      {(!toolbarHost || selectMode) && (
        <div className={cn("mb-3 flex items-center gap-2", selectMode && irid ? "min-h-8" : "h-8")}>
          {!selectMode ? (
            <div className="ml-auto flex items-center gap-2">{entryButtons}</div>
          ) : irid ? (
            // dark glass behind the selection toolbar so it's readable over the shader
            // (translateZ(0) against black flicker, 72% so the text stays readable)
            <div className="flex w-full items-center gap-2 rounded-xl border border-white/12 bg-zinc-900/72 px-3 py-1.5 shadow-lg shadow-black/20 backdrop-blur-xl [transform:translateZ(0)]">
              {selectionToolbar}
            </div>
          ) : (
            selectionToolbar
          )}
        </div>
      )}

      {addErr && (
        <div className="mb-3 rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">
          {addErr}
        </div>
      )}

      <div
        ref={setGridNode}
        onMouseDown={onGridMouseDown}
        onContextMenu={emptySpaceMenu}
        // fixed tracks, so opening Details or resizing doesn't resize the tiles
        style={{ gridTemplateColumns: `repeat(auto-fill, ${tiles.size}px)` }}
        className={cn(
          "relative grid gap-3",
          // fill the empty space below so right-click still hits the grid,
          // content-start keeps the rows at normal height
          fillHeight && "min-h-[60vh] content-start",
          selectMode && "select-none",
        )}
      >
        {items.map(({ reward, monthId }, i) => {
          // borrowed tiles don't take part in bulk actions or drops (no data-tile / drop
          // attributes)
          const borrowed = !!reward.collabFrom;
          return (
          <TileGate
            key={reward.id}
            data-tile={borrowed ? undefined : reward.id}
            // drop target: files dropped on a reward go into its folder
            data-drop-reward={borrowed ? undefined : reward.id}
            data-drop-label={borrowed ? undefined : reward.title}
            className="relative"
          >
            <RewardSlot
              reward={reward}
              index={i}
              aspect={shape.aspect}
              onOpen={() => openReward(reward, monthId)}
              onAdd={backed && !borrowed ? () => void addToReward(reward) : undefined}
              onContextMenu={(e) => rewardMenu(e, reward, monthId)}
              isNew={!!reward.fresh}
            />
            {selectMode && !borrowed && (
              <div
                onClick={(e) => clickSelect(e, i)}
                className={cn(
                  "absolute inset-0 z-20 cursor-pointer rounded-xl ring-2 ring-inset transition-colors",
                  selected.has(reward.id)
                    ? "bg-brand-500/20 ring-brand-500"
                    : "ring-transparent hover:bg-white/5 hover:ring-zinc-500",
                )}
              >
                <span
                  className={cn(
                    "absolute left-2 top-2 flex h-5 w-5 items-center justify-center rounded-md border shadow",
                    selected.has(reward.id)
                      ? "border-brand-400 bg-brand-500 text-white"
                      : "border-zinc-400 bg-black/40 text-transparent",
                  )}
                >
                  <CheckSquare className="h-3.5 w-3.5" strokeWidth={3} />
                </span>
              </div>
            )}
          </TileGate>
          );
        })}

        {marquee && (
          <div
            className="pointer-events-none absolute z-30 rounded-sm border border-brand-400 bg-brand-500/15"
            style={{ left: marquee.left, top: marquee.top, width: marquee.width, height: marquee.height }}
          />
        )}
      </div>

      {rename && (
        <RenameDialog
          kind="reward"
          targets={rename}
          onClose={() => setRename(null)}
          onDone={() => {
            void refresh();
            exitSelect();
          }}
        />
      )}

      <AnimatePresence>
        {details && (
          <RewardDetails
            reward={details}
            where={whereOf(items.find((it) => it.reward.id === details.id)?.monthId ?? "")}
            onReveal={() => reveal(details.folderPath)}
            // the rarer marks live in Details, not in the right-click menu
            onToggleExtra={
              details.status !== "missing" && !details.collabFrom
                ? () => {
                    const next = !details.isExtra;
                    void markExtra([details.id], next);
                    setDetails({ ...details, isExtra: next });
                  }
                : undefined
            }
            onCollab={
              backed && !details.collabFrom
                ? () => {
                    setCollabPick(details);
                    setDetails(null);
                  }
                : undefined
            }
            onClose={() => setDetails(null)}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {viewer && (
          <ImageViewer
            items={viewer.items}
            startIndex={viewer.index}
            coverTargets={viewer.coverTargets}
            onClose={() => setViewer(null)}
          />
        )}
      </AnimatePresence>

      {sdNotice && (
        <SdNoticeDialog
          title={sdNotice.title}
          volume={sdNotice.volume}
          onClose={() => setSdNotice(null)}
        />
      )}

      {sharePick && (
        <ShareSheet
          req={sharePick}
          onPhone={() => setShareReward({ srcs: sharePick.srcs, name: sharePick.name })}
          onMega={() =>
            setMegaReward({
              srcs: sharePick.srcs,
              name: sharePick.name,
              creator: sharePick.creator,
            })
          }
          onSaveCopy={() => void saveCopy(sharePick.srcs, sharePick.name)}
          onClose={() => setSharePick(null)}
        />
      )}

      <AnimatePresence>
        {shareReward && (
          <SharePhoneModal
            srcs={shareReward.srcs}
            name={shareReward.name}
            onClose={() => setShareReward(null)}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {megaReward && (
          <MegaUploadModal
            srcs={megaReward.srcs}
            name={megaReward.name}
            creator={megaReward.creator}
            onClose={() => setMegaReward(null)}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {movePick && (
          <MovePicker
            mode="rewards"
            count={movePick.rewardIds.length}
            fromArtistId={artistId}
            excludeMonthId={movePick.fromMonthId}
            excludeRewardIds={movePick.rewardIds}
            onPick={(dest) => {
              if (dest.rewardId) {
                // ask keep folder vs only files (or use the saved choice)
                const ids = movePick.rewardIds;
                const destRewardId = dest.rewardId;
                setMovePick(null);
                void startMerge(ids, destRewardId);
              } else if (dest.newPeriod) {
                const ids = movePick.rewardIds;
                const np = dest.newPeriod;
                setMovePick(null);
                void doMoveToNewPeriod(np, ids);
              } else if (dest.periodId) void doMoveRewards(dest.periodId);
            }}
            onClose={() => setMovePick(null)}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {mergeChoice && (
          <MergeChoiceDialog
            count={mergeChoice.ids.filter((id) => id !== mergeChoice.destRewardId).length}
            destTitle={items.find((it) => it.reward.id === mergeChoice.destRewardId)?.reward.title}
            busy={false}
            onChoose={(keepFolder, dontAsk) => {
              const { ids, destRewardId } = mergeChoice;
              setMergeChoice(null);
              void (async () => {
                if (dontAsk) {
                  await setSetting("merge_keep_folder", keepFolder ? "true" : "false").catch(() => {});
                }
                await doMergeRewards(destRewardId, ids, keepFolder);
              })();
            }}
            onCancel={() => setMergeChoice(null)}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {newFolder && (
          <NewFolderDialog onCreate={(name) => void doCreateFolder(name)} onClose={() => setNewFolder(null)} />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {newMissing && (
          <NewFolderDialog
            title={t("Add missing reward")}
            initial={t("New reward")}
            hint={t(
              "A placeholder card you can fill with files later — no folder is created until you do.",
            )}
            onCreate={(name) => void doCreateMissing(name)}
            onClose={() => setNewMissing(null)}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {collabPick && artistId && (
          <CollabPicker
            reward={collabPick}
            ownerArtistId={artistId}
            onClose={() => setCollabPick(null)}
            onDone={() => {
              setCollabPick(null);
              void refresh();
            }}
          />
        )}
      </AnimatePresence>
    </>
  );
}
