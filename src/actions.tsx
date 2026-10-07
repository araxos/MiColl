import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { ArrowLeft, FolderOpen, Info, RefreshCw } from "lucide-react";
import { askForPageDetails } from "@/lib/pageDetails";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { join } from "@tauri-apps/api/path";
import { ContextMenu, type MenuItem } from "@/components/ContextMenu";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { ProgressModal } from "@/components/ProgressModal";
import { DeleteDialog } from "@/components/DeleteDialog";
import { MoveNoticeDialog } from "@/components/MoveNoticeDialog";
import { ImportReviewTree } from "@/components/ImportReviewTree";
import { ConflictDialog } from "@/components/ConflictDialog";
import { Toaster, type ToastData } from "@/components/Toast";
import { fmtBytes } from "@/components/RewardDetails";
import { useLibraryActions } from "@/store";
import { useT, useTf, useTp } from "@/lib/i18n";
import * as api from "@/api/library";
import type { ReleaseStyle } from "@/types";

export interface DeleteRequest {
  title: string;
  /** Reward ids to delete (one reward, a month or a whole artist). */
  rewardIds?: string[];
  /** One image id (e.g. from the viewer). */
  imageId?: string;
  /** Several image ids (viewer selection). */
  imageIds?: string[];
  /** A whole artist (also empty ones). */
  artistId?: string;
  /** A whole month (a break or an empty month). */
  periodId?: string;
  /** Several months at once (e.g. delete a year). */
  periodIds?: string[];
  /** A whole platform of an artist. */
  platform?: { artistId: string; name: string };
  /** Always ask, even with "don't ask again" (used when a year still has files). */
  alwaysAsk?: boolean;
  /** Called after a delete worked (e.g. to close the viewer). */
  onDone?: () => void;
}

interface ActionsCtx {
  backed: boolean;
  /** Show a file/folder in Explorer. */
  reveal: (path?: string) => void;
  /** Open a right-click menu at the mouse (does nothing outside Tauri). */
  openMenu: (e: React.MouseEvent, items: MenuItem[]) => void;
  /** Start deleting (uses the saved "don't ask again" choice). */
  requestDelete: (req: DeleteRequest) => void;
  /**
   * Re-index the WHOLE collection (files added/removed in Explorer).
   * Use rescanArtist for a single creator.
   */
  reload: () => Promise<void>;
  /** Re-index ONE creator with the progress overlay. */
  rescanArtist: (artistId: string) => void;
  /**
   * Pick a folder or archive and import its rewards. In managed mode the files get
   * moved into the collection. With artist set (from an artist card) the rewards go
   * to that artist. noDates pre-checks "ignore year & month".
   * pick = folder (default) or archive (.zip/.rar/.7z) dialog.
   */
  addRewards: (opts?: {
    artist?: string;
    noDates?: boolean;
    /** Pre-select this release style. */
    style?: ReleaseStyle;
    pick?: "folder" | "archive";
  }) => Promise<void>;
  /**
   * Import a dropped folder/archive (same as Add folder). ctx has the artist/platform/month
   * under the mouse, so the rewards are pre-filled.
   */
  importDropped: (paths: string[], ctx?: DropContext) => Promise<void>;
  /**
   * Add dropped files straight into an existing reward (archives get extracted first).
   * label is shown in the toast.
   */
  importIntoReward: (rewardId: string, paths: string[], label?: string) => Promise<void>;
  /**
   * Copy files into a reward folder. Checks for name clashes first and asks
   * Replace / Rename / Skip per file. Returns the report or null if cancelled.
   */
  fillRewardInteractive: (
    rewardId: string,
    paths: string[],
    /** label = the target's name for the progress toast */
    opts?: { moveSources?: boolean; label?: string },
  ) => Promise<api.FillReport | null>;
  /**
   * Bring rewards back from the MiSD disk, with the same blocking overlay as a
   * transport, then reload the library.
   */
  bringBackFromSd: (rewardIds: number[]) => Promise<void>;
  /** Open a file with its default app. If there's none, show it in Explorer. */
  openExternally: (path?: string) => void;
  /** Show a toast in the bottom right. */
  /** Returns the toast's id (for updateToast / dismissToast). */
  showToast: (t: Omit<ToastData, "id">) => number;
  /**
   * Take back the newest history row (Ctrl+Z) or a given one, with the toast and a
   * library reload. Resolves true when it worked.
   */
  undoHistory: (id?: number) => Promise<boolean>;
}

/** Info from the element a drag was dropped on. */
export interface DropContext {
  /** Lock the import to this artist. */
  artist?: string;
  /** Pre-check "ignore year & month". */
  noDates?: boolean;
  /** Pre-select this release style. */
  releaseStyle?: ReleaseStyle;
  /** Pre-select this platform for every reward. */
  platform?: string;
  /** Pre-fill year/month. */
  year?: number;
  month?: number;
  /** Pre-fill the drop number. */
  number?: number;
  /** Add the files directly into this reward. */
  rewardId?: string;
}

const Ctx = createContext<ActionsCtx | null>(null);

/** Fired after an import with the creator names that got rewards (detail: string[]). */
export const IMPORTED_ARTISTS_EVENT = "micoll:imported-artists";

/** Fired when the history changed (an undo), the History view reloads. */
export const HISTORY_CHANGED_EVENT = "micoll:history-changed";

/** Toasts shown at once, more push the oldest out. */
const MAX_TOASTS = 4;

export function ActionsProvider({ children }: { children: React.ReactNode }) {
  const t = useT();
  const tf = useTf();
  const tp = useTp();
  const { backed, refresh } = useLibraryActions();
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [del, setDel] = useState<DeleteRequest | null>(null);
  const [busy, setBusy] = useState(false);
  const [toasts, setToasts] = useState<ToastData[]>([]);
  const toastSeq = useRef(0);

  const showToast = useCallback((t: Omit<ToastData, "id">) => {
    const id = ++toastSeq.current;
    setToasts((prev) => {
      const next = [...prev, { ...t, id }];
      // at most MAX_TOASTS at once: the oldest finished ones make room (a running job's
      // progress toast always stays)
      let extra = next.length - MAX_TOASTS;
      if (extra <= 0) return next;
      return next.filter((x) => {
        if (extra > 0 && x.tone !== "progress" && x.id !== id) {
          extra--;
          return false;
        }
        return true;
      });
    });
    return id;
  }, []);
  const updateToast = useCallback(
    (id: number, patch: Partial<Omit<ToastData, "id">>) =>
      setToasts((prev) => prev.map((x) => (x.id === id ? { ...x, ...patch } : x))),
    [],
  );
  const dismissToast = useCallback(
    (id: number) => setToasts((prev) => prev.filter((t) => t.id !== id)),
    [],
  );

  // add-rewards state
  const [moveNotice, setMoveNotice] = useState(false);
  // the same notice for a drop onto a reward card, answered through a promise
  const [dropMoveAsk, setDropMoveAsk] = useState<((ok: boolean) => void) | null>(null);
  const [collectionRoot, setCollectionRoot] = useState("");
  const [importPlan, setImportPlan] = useState<api.ImportPlan | null>(null);
  const [importSource, setImportSource] = useState("");
  const [importManaged, setImportManaged] = useState(false);
  const [lockedArtist, setLockedArtist] = useState<string | undefined>(undefined);
  const [defStyle, setDefStyle] = useState<ReleaseStyle | undefined>(undefined);
  // pre-fill from the drop target
  const [defPlatform, setDefPlatform] = useState<string | undefined>(undefined);
  const [defYear, setDefYear] = useState<number | undefined>(undefined);
  const [defMonth, setDefMonth] = useState<number | undefined>(undefined);
  const [defNumber, setDefNumber] = useState<number | undefined>(undefined);
  // if set, import this folder instead of opening a picker (dropped folder)
  const [pendingPath, setPendingPath] = useState<string | null>(null);
  // which dialog to open (folder or archive)
  const [pickMode, setPickMode] = useState<"folder" | "archive">("folder");
  // the dropped archive, goes to the recycle bin after a successful import
  const [archiveSource, setArchiveSource] = useState<string | null>(null);
  // loose files that were dropped (copied in via staging): they go to the Recycle Bin after
  // a managed import, each only when an identical copy is in the library
  const looseDropped = useRef<string[]>([]);

  // current conflict prompt, resolve gets the choices or null if cancelled
  const [conflict, setConflict] = useState<{
    conflicts: api.FillConflict[];
    resolve: (r: Record<string, api.ConflictChoice> | null) => void;
  } | null>(null);

  /** Show the conflict prompt and wait for the answers. */
  const askConflicts = (conflicts: api.FillConflict[]) =>
    new Promise<Record<string, api.ConflictChoice> | null>((resolve) =>
      setConflict({ conflicts, resolve }),
    );

  // rewards that are being filled right now: a second drop on one would copy everything
  // again next to the first run
  const filling = useRef(new Set<string>());
  const fillJob = useRef(0);

  const fillRewardInteractive = async (
    rewardId: string,
    paths: string[],
    opts?: { moveSources?: boolean; label?: string },
  ): Promise<api.FillReport | null> => {
    if (filling.current.has(rewardId)) {
      showToast({
        tone: "warn",
        title: t("Still adding files here"),
        detail: t("Wait until the running copy is done."),
      });
      return null;
    }
    filling.current.add(rewardId);
    try {
      return await fillRewardRun(rewardId, paths, opts);
    } finally {
      filling.current.delete(rewardId);
    }
  };

  const fillRewardRun = async (
    rewardId: string,
    paths: string[],
    opts?: { moveSources?: boolean; label?: string },
  ): Promise<api.FillReport | null> => {
    let resolutions: Record<string, api.ConflictChoice> | undefined;
    // check for name clashes first and ask per file
    try {
      const plan = await api.fillRewardPlan(rewardId, paths);
      if (plan.conflicts.length > 0) {
        const answer = await askConflicts(plan.conflicts);
        if (answer === null) return null; // cancelled the whole import
        resolutions = answer;
      }
    } catch (e) {
      // if checking fails, just let the backend rename on clash
      console.error("conflict plan failed", e);
    }
    // bottom right: a bar that fills while the files are copied
    const job = ++fillJob.current;
    const detail = opts?.label ? tf("to {name}", { name: opts.label }) : undefined;
    const toastId = showToast({
      tone: "progress",
      title: t("Adding files…"),
      detail,
      progress: null,
      // the X stops it: what was copied is taken back, the originals stay
      onCancel: () => {
        void api.cancelFill(job).catch(() => {});
        updateToast(toastId, { title: t("Cancelling…"), onCancel: undefined });
      },
    });
    const off = await listen<api.FillProgress>("fill-progress", (e) => {
      const p = e.payload;
      if (p.job !== job) return;
      if (p.phase === "copy") {
        updateToast(toastId, {
          title: t("Adding files…"),
          detail: [`${fmtBytes(p.done)} / ${fmtBytes(p.total)}`, opts?.label].filter(Boolean).join(" · "),
          progress: p.total > 0 ? p.done / p.total : null,
        });
      } else if (p.phase === "encrypt") {
        // past the copy there's nothing to stop anymore
        updateToast(toastId, {
          onCancel: undefined,
          title: t("Encrypting…"),
          detail: `${p.done} / ${p.total}`,
          progress: p.total > 0 ? p.done / p.total : null,
        });
      } else {
        updateToast(toastId, { title: t("Indexing…"), detail, progress: null, onCancel: undefined });
      }
    });
    try {
      const report = await api.fillReward(rewardId, paths, resolutions, opts?.moveSources, job);
      if (report.cancelled) {
        showToast({ tone: "warn", title: t("Copy cancelled"), detail: t("Nothing was changed.") });
        return null; // like a cancelled prompt for the callers
      }
      return report;
    } finally {
      off();
      dismissToast(toastId);
    }
  };

  const reveal = (path?: string) => {
    if (backed && path) void api.showInExplorer(path);
  };

  const openExternally = (path?: string) => {
    if (!backed || !path) return;
    void api.openWithDefault(path).catch((e) =>
      // no default app -> show it in Explorer
      void api.showInExplorer(path).then(() =>
        showToast({ tone: "warn", title: t("No app is set for this file type"), detail: `${e}` }),
      ),
    );
  };

  const openMenuAt = (x: number, y: number, items: MenuItem[]) => {
    if (!backed) return;
    setMenu({ x, y, items });
  };

  const openMenu = (e: React.MouseEvent, items: MenuItem[]) => {
    if (!backed) return;
    e.preventDefault();
    openMenuAt(e.clientX, e.clientY, items);
  };

  const run = async (req: DeleteRequest, alsoFiles: boolean, dontAsk = false) => {
    setBusy(true);
    try {
      if (dontAsk) {
        await api.setSetting("delete_ask", "false");
        await api.setSetting("delete_mode", alsoFiles ? "disk" : "micoll");
      }
      if (req.imageIds?.length) await api.deleteImages(req.imageIds, alsoFiles);
      else if (req.imageId) await api.deleteImage(req.imageId, alsoFiles);
      else if (req.platform)
        await api.deletePlatform(req.platform.artistId, req.platform.name, alsoFiles);
      else if (req.artistId) await api.deleteArtist(req.artistId, alsoFiles);
      else if (req.periodIds?.length)
        for (const id of req.periodIds) await api.deletePeriod(id, alsoFiles);
      else if (req.periodId) await api.deletePeriod(req.periodId, alsoFiles);
      else if (req.rewardIds?.length) await api.deleteRewards(req.rewardIds, alsoFiles);
      await refresh();
      req.onDone?.();
    } catch (e) {
      // Windows can refuse "delete files too" (e.g. too big for the recycle bin),
      // tell the user so they know the files are still on disk
      console.error("delete failed", e);
      await refresh();
      showToast({ tone: "error", title: t("Couldn’t delete everything"), problem: String(e) });
    } finally {
      setBusy(false);
      setDel(null);
    }
  };

  /** Re-index everything. Slow, so it asks first. */
  const reload = async () => {
    if (!backed) return;
    try {
      const managed = (await api.getSetting("managed_enabled")) === "true";
      if (managed) await api.rescanCollection();
      else await api.rescan();
      await refresh();
    } catch (e) {
      console.error("reload failed", e);
    }
  };

  /** Re-index one creator, fast enough to not ask. */
  const reloadArtist = async (artistId: string) => {
    if (!backed) return;
    try {
      await api.rescanArtist(artistId);
      await refresh();
    } catch (e) {
      console.error("artist reload failed", e);
      showToast({ tone: "error", title: t("Rescan failed"), problem: String(e) });
    }
  };

  // a scan blocks the UI with ProgressModal, only one at a time
  const [scanning, setScanning] = useState<string | null>(null);
  const [confirmFull, setConfirmFull] = useState(false);
  // live progress, total 0 = still walking folders
  const [scanProg, setScanProg] = useState<{ done: number; total: number; item: string }>({
    done: 0,
    total: 0,
    item: "",
  });
  useEffect(() => {
    if (!backed) return;
    let off: (() => void) | undefined;
    void listen<{ done: number; total: number; item: string }>("scan-progress", (e) =>
      setScanProg(e.payload),
    ).then((fn) => {
      off = fn;
    });
    return () => off?.();
  }, [backed]);

  // bring back = transport in reverse, so it blocks the window with the same overlay
  const [returning, setReturning] = useState<{ done: number; total: number; item: string } | null>(
    null,
  );
  useEffect(() => {
    if (!backed) return;
    let off: (() => void) | undefined;
    void listen<{ phase: string; done: number; total: number; item: string }>(
      "sd-progress",
      (e) => {
        if (e.payload.phase !== "return") return;
        // null = no bring-back running
        setReturning((cur) =>
          cur
            ? { done: e.payload.done, total: e.payload.total || cur.total, item: e.payload.item }
            : cur,
        );
      },
    ).then((fn) => {
      off = fn;
    });
    return () => off?.();
  }, [backed]);

  const bringBackFromSd = async (rewardIds: number[]) => {
    if (returning) return;
    // start with the count we asked for so the bar has a total right away
    setReturning({ done: 0, total: rewardIds.length, item: "" });
    try {
      const s = await api.sdReturn(rewardIds);
      showToast(
        s.failed
          ? {
              tone: "warn",
              title: tf("MiSD: brought back {moved}, {failed} failed", {
                moved: s.moved,
                failed: s.failed,
              }),
              detail: s.errors.slice(0, 3).join(" · "),
            }
          : s.cancelled
            ? {
                tone: "warn",
                title: tf("MiSD: stopped after {rewards}", { rewards: tp("{n} rewards", s.moved) }),
                detail: t("The rest is still queued — nothing was left half-finished."),
              }
            : {
                tone: "success",
                title: t("Brought back from MiSD"),
                detail: tf("{n} back on the main disk.", { n: s.moved }),
              },
      );
      await refresh();
    } catch (e) {
      showToast({ tone: "error", title: t("Bring back failed"), detail: `${e}` });
    } finally {
      setReturning(null);
    }
  };

  const runScan = async (label: string, job: () => Promise<void>) => {
    if (scanning) return;
    setScanProg({ done: 0, total: 0, item: "" });
    setScanning(label);
    try {
      await job();
      showToast({ tone: "success", title: t("Rescanned for new files") });
    } finally {
      setScanning(null);
    }
  };

  // F5 = rescan. Inside a creator only that creator, on the dashboard everything (asks
  // first).
  // Ignores F5 with modifiers (Ctrl+F5 = dev reload).
  const location = useLocation();
  const pathRef = useRef(location.pathname);
  pathRef.current = location.pathname;
  const scanRef = useRef(runScan);
  scanRef.current = runScan;
  const refreshHere = useCallback(() => {
    const artistId = pathRef.current.match(/^\/artist\/([^/]+)/)?.[1];
    if (artistId) {
      void scanRef.current("Rescanning this creator…", () => reloadArtist(artistId));
    } else {
      setConfirmFull(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "F5" || e.ctrlKey || e.shiftKey || e.altKey || e.metaKey) return;
      e.preventDefault();
      refreshHere();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [refreshHere]);

  /* ---- the menu for the page itself ------------------------------------- */
  /* Replace the webview's own right-click menu (Back/Reload/Print...) with our own
     menu for the current page. Text fields keep the normal menu (cut/copy/paste). */
  const navigate = useNavigate();

  /** Show in Explorer: the managed collection, or the first root folder. */
  const revealCollectionRoot = async () => {
    try {
      const root = (await api.getSetting("collection_root"))?.trim();
      if (root) {
        // use join, a template string ate the backslash once ("C:CollMiColl")
        try {
          await api.showInExplorer(await join(root, "MiColl"));
        } catch {
          await api.showInExplorer(root);
        }
        return;
      }
      const roots = await api.listRoots();
      if (roots[0]?.path) {
        await api.showInExplorer(roots[0].path);
        return;
      }
      showToast({
        tone: "warn",
        title: t("No folder yet"),
        detail: t("Add one in Settings, or switch on a managed collection."),
      });
    } catch (e) {
      showToast({ tone: "error", title: t("Couldn’t open the folder"), detail: `${e}` });
    }
  };

  const backgroundItems = (): MenuItem[] => {
    const path = pathRef.current;
    const m = /^\/artist\/([^/]+)(?:\/month\/([^/?]+))?/.exec(path);
    const artistId = m?.[1];
    const monthId = m?.[2];
    const items: MenuItem[] = [
      {
        label: t("Show in Explorer"),
        icon: <FolderOpen className="h-4 w-4" />,
        onClick: () => {
          if (monthId) void api.revealPeriod(monthId);
          else if (artistId) void api.revealArtist(artistId);
          else void revealCollectionRoot();
        },
      },
    ];
    // Details = stats on the dashboard, the creator panel on a creator page.
    // A month opens its creator's panel.
    if (path !== "/settings") {
      items.push({
        label: t("Details"),
        icon: <Info className="h-4 w-4" />,
        onClick: () => {
          if (monthId && artistId) navigate(`/artist/${artistId}?details=1`);
          else askForPageDetails();
        },
      });
    }
    items.push(
      { label: t("Back"), icon: <ArrowLeft className="h-4 w-4" />, onClick: () => navigate(-1) },
      { label: t("Refresh"), icon: <RefreshCw className="h-4 w-4" />, onClick: refreshHere },
    );
    return items;
  };

  // registered once, reads everything through refs
  const backedRef = useRef(backed);
  backedRef.current = backed;
  const bgRef = useRef(backgroundItems);
  bgRef.current = backgroundItems;
  const showRef = useRef(openMenuAt);
  showRef.current = openMenuAt;
  useEffect(() => {
    const onCtx = (e: MouseEvent) => {
      // cards with their own menu call preventDefault, then we stay out
      if (e.defaultPrevented) return;
      const t = e.target as HTMLElement | null;
      if (t?.closest('input, textarea, select, [contenteditable="true"]')) return;
      // browser version has no backend, keep the normal menu there
      if (!backedRef.current) return;
      e.preventDefault();
      showRef.current(e.clientX, e.clientY, bgRef.current());
    };
    document.addEventListener("contextmenu", onCtx);
    return () => document.removeEventListener("contextmenu", onCtx);
  }, []);

  const requestDelete = async (req: DeleteRequest) => {
    const ask = await api.getSetting("delete_ask");
    if (ask === "false" && !req.alwaysAsk) {
      const mode = await api.getSetting("delete_mode");
      await run(req, mode === "disk");
    } else {
      setDel(req);
    }
  };

  /* ---- add rewards ---------------------------------------------------- */

  const pickAndAnalyze = async (
    sourcePath?: string | null,
    pick: "folder" | "archive" = "folder",
  ) => {
    // use the dropped folder if there is one, else open a picker
    const picked =
      sourcePath ??
      (pick === "archive"
        ? await open({
            multiple: false,
            title: t("Choose an archive to add"),
            filters: [{ name: "Archives", extensions: ["zip", "rar", "7z"] }],
          })
        : await open({ directory: true, multiple: false, title: t("Choose a folder to add") }));
    setPendingPath(null);
    if (typeof picked !== "string") return;
    setBusy(true);
    try {
      // dropped archives are extracted to a temp folder first, remember it to delete later
      const isArchive = /\.(zip|rar|7z)$/i.test(picked);
      setArchiveSource(isArchive ? picked : null);
      // permanent: in an unmanaged library it unpacks next to the archive
      const target = isArchive ? await api.extractArchive(picked, true) : picked;
      const plan = await api.analyzeImport(target);
      setImportSource(target);
      setImportPlan(plan);
    } catch (e) {
      console.error("analyze failed", e);
      showToast({ tone: "error", title: t("Couldn’t analyze that folder"), detail: `${e}` });
    } finally {
      setBusy(false);
    }
  };

  /** Decide managed vs normal, warn if needed, then analyze. */
  const beginImport = async (opts: {
    artist?: string;
    noDates?: boolean;
    style?: ReleaseStyle;
    sourcePath?: string | null;
    pick?: "folder" | "archive";
    platform?: string;
    year?: number;
    month?: number;
    number?: number;
  }) => {
    if (!backed) return;
    setLockedArtist(opts.artist);
    setDefStyle(opts.style ?? (opts.noDates ? "none" : undefined));
    setPendingPath(opts.sourcePath ?? null);
    setPickMode(opts.pick ?? "folder");
    setDefPlatform(opts.platform);
    setDefYear(opts.year);
    setDefMonth(opts.month);
    setDefNumber(opts.number);
    const [enabled, root] = await Promise.all([
      api.getSetting("managed_enabled"),
      api.getSetting("collection_root"),
    ]);
    const managed = enabled === "true" && !!root;
    setImportManaged(managed);
    setCollectionRoot(root ?? "");

    if (managed) {
      const ask = await api.getSetting("managed_move_ask");
      if (ask === "false") {
        await pickAndAnalyze(opts.sourcePath ?? null, opts.pick ?? "folder");
      } else {
        setMoveNotice(true); // warn first; the pending folder/picker runs on confirm
      }
    } else {
      await pickAndAnalyze(opts.sourcePath ?? null, opts.pick ?? "folder");
    }
  };

  const addRewards = (opts?: {
    artist?: string;
    noDates?: boolean;
    style?: ReleaseStyle;
    pick?: "folder" | "archive";
  }) => {
    looseDropped.current = [];
    return beginImport({ artist: opts?.artist, noDates: opts?.noDates, style: opts?.style, pick: opts?.pick });
  };

  const importDropped = async (paths: string[], ctx?: DropContext) => {
    // single loose files are put into a temp reward folder first
    let source: string | null = paths[0] ?? null;
    looseDropped.current = [];
    try {
      const staged = await api.stageFilesForImport(paths);
      if (staged) {
        source = staged;
        looseDropped.current = paths;
      }
    } catch (e) {
      console.error("stage files failed", e);
    }
    if (!source) return;
    await beginImport({
      sourcePath: source,
      artist: ctx?.artist,
      noDates: ctx?.noDates,
      style: ctx?.releaseStyle,
      platform: ctx?.platform,
      year: ctx?.year,
      month: ctx?.month,
      number: ctx?.number,
    });
  };

  const importIntoReward = async (rewardId: string, paths: string[], label?: string) => {
    if (!backed || paths.length === 0) return;
    // like a normal import: in a managed collection the dropped files are moved (copy,
    // then the originals go to the Recycle Bin), with the same notice first
    const [enabled, root, ask] = await Promise.all([
      api.getSetting("managed_enabled"),
      api.getSetting("collection_root"),
      api.getSetting("managed_move_ask"),
    ]);
    const managed = enabled === "true" && !!root;
    if (managed && ask !== "false") {
      setCollectionRoot(root ?? "");
      const ok = await new Promise<boolean>((resolve) => setDropMoveAsk(() => resolve));
      setDropMoveAsk(null);
      if (!ok) return;
    }
    setBusy(true);
    // archives unpack into a temp folder, that one is deleted once the files are copied
    const unpacked: string[] = [];
    try {
      const resolved: string[] = [];
      for (const p of paths) {
        if (/\.(zip|rar|7z)$/i.test(p)) {
          const dir = await api.extractArchive(p);
          unpacked.push(dir);
          resolved.push(dir);
        } else {
          resolved.push(p);
        }
      }
      // managed: the backend sends the dropped folders/files to the Recycle Bin, but only
      // once every single file arrived and was checked
      const report = await fillRewardInteractive(rewardId, resolved, { label, moveSources: managed });
      if (report === null) return; // user cancelled the whole import
      await refresh();
      const problems: string[] = [];
      if (report.failed > 0) problems.push(tf("{n} couldn’t be imported", { n: report.failed }));
      if (report.skipped > 0) problems.push(tf("{n} skipped", { n: report.skipped }));
      const kept = report.keptSources.map((k) => k.split(/[\\/]/).pop() || k);
      // the archives themselves, same rule (their unpacked copy went in)
      if (managed && report.allArrived) {
        for (const p of paths.filter((x) => /\.(zip|rar|7z)$/i.test(x))) {
          await api.trashPath(p, "import").catch(() => kept.push(p.split(/[\\/]/).pop() || p));
        }
      }
      if (kept.length) problems.push(tf("Still in place: {names}", { names: kept.join(", ") }));
      // not everything arrived: nothing was removed
      if (managed && !report.allArrived) problems.push(t("The originals stay where they are."));
      showToast({
        tone: report.failed > 0 || kept.length > 0 ? "warn" : "success",
        title: tf("{n} added", { n: tp("{n} files", report.added) }),
        detail: label ? tf("to {name}", { name: label }) : undefined,
        problem: problems.length ? problems.join(" · ") : undefined,
      });
    } catch (e) {
      console.error("add to reward failed", e);
      showToast({ tone: "error", title: t("Couldn’t add files"), detail: `${e}` });
    } finally {
      for (const d of unpacked) await api.discardExtracted(d).catch(() => {});
      setBusy(false);
    }
  };

  /* ---- undo (history stage 2: renames and moves) ---------------------- */

  const undoHistory = async (id?: number): Promise<boolean> => {
    if (!backed) return false;
    try {
      const done = await api.undoHistory(id);
      await refresh();
      window.dispatchEvent(new CustomEvent(HISTORY_CHANGED_EVENT));
      const first = done.names[0] ?? "";
      const names = done.names.length > 1 ? tf("{name} and {n} more", { name: first, n: done.names.length - 1 }) : first;
      showToast({
        tone: "success",
        title: t("Undone"),
        detail:
          done.action === "rename"
            ? tf("Renamed back: {names}", { names })
            : done.action === "delete"
              ? tf("Restored: {names}", { names })
              : tf("Moved back: {names}", { names }),
      });
      return true;
    } catch (e) {
      const msg = String(e);
      const [code, ...rest] = msg.split(":").slice(1);
      const arg = rest.join(":");
      const text = !msg.startsWith("undo:")
        ? msg
        : code === "nothing"
          ? t("There’s nothing to undo.")
          : code === "already"
            ? t("That was already undone.")
            : code === "not-yet"
              ? t("This kind of action can’t be undone. Settings → History shows where everything went.")
              : code === "changed"
                ? tf("“{name}” was changed since, so it can’t be undone safely.", { name: arg })
                : code === "taken"
                  ? tf("Something else is at the old place now: {path}", { path: arg })
                  : code === "gone"
                    ? tf("“{path}” isn’t in the Recycle Bin anymore, so it can’t come back.", { path: arg })
                    : code === "restore"
                      ? tf("Windows couldn’t take it out of the Recycle Bin: {why}", { why: arg })
                      : msg;
      showToast({ tone: "warn", title: t("Can’t undo"), detail: text });
      return false;
    }
  };

  // Ctrl+Z anywhere in the library (not while typing, not in the viewer/editor, which
  // have their own steps)
  const undoRef = useRef(undoHistory);
  undoRef.current = undoHistory;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey || e.key.toLowerCase() !== "z") return;
      const el = e.target instanceof Element ? e.target : null;
      if (el?.closest('input, textarea, select, [contenteditable="true"]')) return;
      if (document.querySelector(".micoll-viewer")) return;
      e.preventDefault();
      void undoRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const onMoveConfirm = async (dontShow: boolean) => {
    if (dontShow) await api.setSetting("managed_move_ask", "false");
    setMoveNotice(false);
    await pickAndAnalyze(pendingPath, pickMode);
  };

  const doImport = async (
    rewards: api.ResolvedReward[],
    opts: { styles: api.StyleChoice[]; keepArchive?: boolean },
  ) => {
    setBusy(true);
    // the dropped archive goes to the Recycle Bin only when every file landed: any
    // organize problem keeps it (its files might still be in the temp unpack folder)
    let archiveSafe = !opts.keepArchive;
    try {
      await api.commitImport(rewards, importSource, opts.styles);
      if (importManaged) {
        // managed mode: move the new content into the collection and remove the old folder
        const org = await api.organizeCollection();
        await api.clearRoots();
        // show organize problems (e.g. leftover duplicates) instead of ignoring them
        // the loose dropped files: only after a clean organize, and before encrypting (the
        // check compares the bytes)
        if (org.failed === 0 && org.errors.length === 0 && looseDropped.current.length > 0) {
          const kept = await api.trashImportedOriginals(looseDropped.current).catch(() => []);
          if (kept.length > 0) {
            showToast({
              tone: "warn",
              title: t("Imported"),
              problem: tf("Still in place: {names}", {
                names: kept.map((k) => k.split(/[\\/]/).pop() || k).join(", "),
              }),
            });
          }
        }
        if (org.failed > 0 || org.errors.length > 0) {
          archiveSafe = false;
          showToast({
            tone: "warn",
            title: t("Imported, but the collection needs a look"),
            detail: org.errors.slice(0, 2).join(" · "),
          });
        }
      }
      // remove the temp staging copy (backend refuses if it's a real folder)
      await api.discardStaging(importSource).catch(() => {});
      // encrypt the new files if encryption is on
      try {
        if ((await api.encryptionState()).enabled) await api.encryptCollection();
      } catch {
        /* if encrypting fails keep the files unencrypted, don't fail the import */
      }
      setImportPlan(null);
      await refresh();
      // the creator overview scrolls to the creators that got rewards and lights them up
      window.dispatchEvent(
        new CustomEvent<string[]>(IMPORTED_ARTISTS_EVENT, {
          detail: [...new Set(rewards.map((r) => r.artist))],
        }),
      );
      // import worked, move the dropped archive to the recycle bin
      if (archiveSource) {
        if (archiveSafe) await api.trashPath(archiveSource, "import").catch(() => {});
        setArchiveSource(null);
      }
    } catch (e) {
      console.error("import failed", e);
    } finally {
      looseDropped.current = [];
      setBusy(false);
    }
  };

  // the context value is built once and forwards to the newest functions,
  // otherwise every render would re-render all consumers
  const latest: ActionsCtx = {
    backed,
    reveal,
    openMenu,
    requestDelete,
    reload,
    rescanArtist: (artistId: string) =>
      void runScan("Rescanning this creator…", () => reloadArtist(artistId)),
    addRewards,
    importDropped,
    importIntoReward,
    fillRewardInteractive,
    bringBackFromSd,
    openExternally,
    showToast,
    undoHistory,
  };
  const live = useRef(latest);
  useLayoutEffect(() => {
    live.current = latest;
  });
  const value = useMemo((): ActionsCtx => {
    const fwd = <K extends Exclude<keyof ActionsCtx, "backed">>(k: K) =>
      ((...args: never[]) =>
        (live.current[k] as (...a: never[]) => unknown)(...args)) as unknown as ActionsCtx[K];
    return {
      backed,
      reveal: fwd("reveal"),
      openMenu: fwd("openMenu"),
      requestDelete: fwd("requestDelete"),
      reload: fwd("reload"),
      rescanArtist: fwd("rescanArtist"),
      addRewards: fwd("addRewards"),
      importDropped: fwd("importDropped"),
      importIntoReward: fwd("importIntoReward"),
      fillRewardInteractive: fwd("fillRewardInteractive"),
      bringBackFromSd: fwd("bringBackFromSd"),
      openExternally: fwd("openExternally"),
      showToast,
      undoHistory: fwd("undoHistory"),
    };
  }, [backed, showToast]);

  return (
    <Ctx.Provider value={value}>
      {children}
      <Toaster toasts={toasts} onDismiss={dismissToast} />
      {confirmFull && (
        <ConfirmDialog
          title={t("Rescan the whole library?")}
          body={
            <>
              This walks every folder in your library and re-indexes it. Depending on how
              many files you have, it can take a while — MiColl stays blocked until it
              finishes.
              <br />
              <br />
              {t("To refresh just one creator, open them and press F5 there.")}
            </>
          }
          confirmLabel={t("Rescan everything")}
          onConfirm={() => {
            setConfirmFull(false);
            void runScan("Rescanning the whole library…", reload);
          }}
          onCancel={() => setConfirmFull(false)}
        />
      )}
      {scanning && (
        <ProgressModal
          title={scanning}
          total={scanProg.total}
          done={scanProg.done}
          detail={scanProg.total === 0 ? "Reading folders…" : scanProg.item || "Indexing…"}
          note="Looking for files added or removed outside MiColl."
        />
      )}
      {returning && (
        <ProgressModal
          title={t("Bringing back from MiSD…")}
          total={returning.total}
          done={returning.done}
          detail={returning.item}
          note={t("Every file is copied and hash-verified before it leaves the disk.")}
          onCancel={() => void api.sdCancel()}
          cancelLabel={t("Stop")}
          cancelPendingLabel={t("Stopping after this one…")}
        />
      )}
      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />
      )}
      {del && (
        <DeleteDialog
          title={del.title}
          busy={busy}
          onConfirm={(alsoFiles, dontAsk) => void run(del, alsoFiles, dontAsk)}
          onCancel={() => setDel(null)}
        />
      )}
      {moveNotice && (
        <MoveNoticeDialog
          collectionRoot={collectionRoot}
          busy={busy}
          onConfirm={(dontShow) => void onMoveConfirm(dontShow)}
          onCancel={() => setMoveNotice(false)}
        />
      )}
      {dropMoveAsk && (
        <MoveNoticeDialog
          collectionRoot={collectionRoot}
          busy={false}
          dropped
          onConfirm={(dontShow) => {
            if (dontShow) void api.setSetting("managed_move_ask", "false");
            dropMoveAsk(true);
          }}
          onCancel={() => dropMoveAsk(false)}
        />
      )}
      {importPlan && (
        <ImportReviewTree
          plan={importPlan}
          busy={busy}
          lockedArtist={lockedArtist}
          sourcePath={importSource}
          defaultStyle={defStyle}
          defaultPlatform={defPlatform}
          defaultYear={defYear}
          defaultMonth={defMonth}
          defaultNumber={defNumber}
          onConfirm={(rewards, opts) => void doImport(rewards, opts)}
          onCancel={() => {
            // nothing was imported, remove the staged copy
            void api.discardStaging(importSource).catch(() => {});
            setImportPlan(null);
            setArchiveSource(null);
          }}
        />
      )}
      {conflict && (
        <ConflictDialog
          conflicts={conflict.conflicts}
          onResolve={(resolutions) => {
            conflict.resolve(resolutions);
            setConflict(null);
          }}
          onCancelAll={() => {
            conflict.resolve(null);
            setConflict(null);
          }}
        />
      )}
    </Ctx.Provider>
  );
}

export function useActions(): ActionsCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useActions must be used within ActionsProvider");
  return ctx;
}
