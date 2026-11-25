import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import { useNavigate } from "react-router-dom";
import { ImageViewer, type ViewerItem } from "@/components/ImageViewer";
import {
  Check,
  ChevronLeft,
  Eye,
  EyeOff,
  Folder,
  Heart,
  ImagePlus,
  Images,
  Loader2,
  Pencil,
  Play,
  Plus,
  RectangleHorizontal,
  Search,
  Shuffle,
  SlidersHorizontal,
  Square,
  Trash2,
  X,
  ZoomIn,
} from "lucide-react";
import { Layout } from "@/components/Layout";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { ImageEditor } from "@/components/ImageEditor";
import { refreshWallSets } from "@/components/AddToSlideshow";
import { CasualOverview } from "@/components/hub/CasualHub";
import { CyberOverview } from "@/components/hub/CyberHub";
import { HiddenSets } from "@/components/hub/HiddenSets";
import { HubExtra } from "@/components/hub/HubExtra";
import { PickPreview } from "@/components/hub/PickPreview";
import { IRI_BAR, IriOverview } from "@/components/hub/IriHub";
import { PyreOverview } from "@/components/hub/PyreHub";
import { SakuraOverview } from "@/components/hub/SakuraHub";
import {
  FIT_LABEL,
  HubTargetContext,
  HubTargetSwitch,
  RunButtons,
  RunsOn,
  Thumb,
  useEveryLabel,
  useHubBox,
  useHubWords,
  usePlaceNames,
  type HubOverviewProps,
  type HubTarget,
  type SaverInfo,
} from "@/components/hub/shared";
import { useData } from "@/store";
import { useActions } from "@/actions";
import { useDialogTheme } from "@/lib/dialogTheme";
import { isPremium, useAccent, type AccentKey } from "@/lib/theme";
import { isTauri } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import { useT, useTf, useTp } from "@/lib/i18n";
import { scrollPageToTop } from "@/lib/pageScroll";
import {
  activateWallSet,
  addToWallSet,
  artistImages,
  collectionFiles,
  createWallSet,
  deleteWallSet,
  favoriteImages,
  landscapePictures,
  listCollections,
  listWallSets,
  lockSetNext,
  lockSetStart,
  lockSetStop,
  saverPreview,
  saverState,
  setSaver,
  showWallSetIn,
  removeFromWallSet,
  updateWallSet,
  imageVersionsFor,
  wallSetItems,
  wallSetImages,
  wallSetNext,
  wallSetStop,
  type SaverOptions,
  type SlideshowFit,
  type WallSet,
} from "@/api/library";
import type { Artist, Collection } from "@/types";

/**
 * Wallpaper Hub: desktop slideshows made of pictures from any creator (the phone app
 * has the same page). A slideshow keeps only the files' paths, every picture stays
 * where it is. Windows runs one slideshow at a time, the running one is marked. The switch
 * in the bar shows the same slideshows for the desktop, for Windows' lock screen (where
 * MiColl changes the picture itself) or as MiColl's screen saver.
 */

/** "Change picture every" choices, in minutes. */
const EVERY = [1, 5, 10, 15, 30, 60, 180, 360, 720, 1440];
const FITS: SlideshowFit[] = ["fill", "fit", "stretch"];

/** The picture picker: only landscape ones (only on this PC). */
const LANDSCAPE_KEY = "micoll.hubPickLandscape";
/** Pictures looked at in one go, for the filter. */
const LOOK_AT = 200;

/** The last place the hub showed (only on this PC). */
const TARGET_KEY = "micoll.hubTarget";

const fileName = (p: string) => p.split(/[\\/]/).pop() || p;

/** The premium themes' overviews, the others share one (components/hub). */
const OVERVIEWS: Partial<Record<AccentKey, (p: HubOverviewProps) => React.ReactNode>> = {
  iridescent: IriOverview,
  cyberpunk: CyberOverview,
  sakura: SakuraOverview,
  corruptruby: PyreOverview,
};

export function WallpaperHubPage({ onLock }: { onLock?: () => void }) {
  const t = useT();
  const tf = useTf();
  const accent = useAccent();
  const Overview = OVERVIEWS[accent] ?? CasualOverview;
  const { showToast, openMenu } = useActions();
  const names = usePlaceNames();
  const [askDelete, setAskDelete] = useState<WallSet | null>(null);
  const [sets, setSets] = useState<WallSet[] | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [target, setTargetState] = useState<HubTarget>(() => {
    try {
      const v = localStorage.getItem(TARGET_KEY);
      return v === "lock" || v === "saver" ? v : "desktop";
    } catch {
      return "desktop";
    }
  });
  const words = useHubWords(target);
  const [saver, setSaverState] = useState<SaverInfo | null>(null);
  const loadSaver = useCallback(() => {
    void saverState()
      .then(setSaverState)
      .catch(() => {});
  }, []);
  // also when the window comes back (Windows' own screen saver may have been turned off)
  useEffect(() => {
    loadSaver();
    window.addEventListener("focus", loadSaver);
    return () => window.removeEventListener("focus", loadSaver);
  }, [loadSaver]);
  const changeSaver = async (c: Partial<SaverOptions>) => {
    const { windowsHasOwn: _, ...cur } = await saverState();
    await setSaver({ ...cur, ...c });
    loadSaver();
  };
  const changeRef = useRef<(c: Partial<SaverOptions>) => void>(() => {});
  const menuRef = useRef<(e: React.MouseEvent, set: WallSet) => void>(() => {});

  const hubTarget = useMemo(
    () => ({
      target,
      setTarget: (to: HubTarget) => {
        setTargetState(to);
        try {
          localStorage.setItem(TARGET_KEY, to);
        } catch {
          /* just not remembered */
        }
      },
      saver,
      onSaver: (c: Partial<SaverOptions>) => changeRef.current(c),
      onMenu: (e: React.MouseEvent, set: WallSet) => menuRef.current(e, set),
    }),
    [target, saver],
  );

  // The one just started counts as running until Windows says so itself, it needs a moment
  // after the start (asked right away, none runs).
  const started = useRef<{ id: string; until: number } | null>(null);
  const again = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(again.current), []);

  const reload = useCallback(async () => {
    window.clearTimeout(again.current);
    try {
      const rows = await listWallSets();
      const st = started.current;
      if (st && !rows.some((r) => r.active) && Date.now() < st.until) {
        setSets(rows.map((r) => ({ ...r, active: r.id === st.id })));
        again.current = window.setTimeout(() => void reload(), 1000);
      } else {
        started.current = null;
        setSets(rows);
      }
    } catch {
      setSets([]);
    }
    // the right-click menus' list too
    void refreshWallSets();
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);

  const fail = (title: string) => (e: unknown) => showToast({ tone: "error", title, problem: String(e) });
  changeRef.current = (c) => void changeSaver(c).catch(fail(t("Couldn’t save the change")));

  /** Start / next / stop, then read the state again. */
  const run = async (id: string, what: "start" | "next" | "stop") => {
    setBusyId(id);
    if (target === "saver") {
      try {
        if (what === "next") await saverPreview(id);
        else await changeSaver({ set: what === "start" ? Number(id) : null });
        if (what === "start") {
          showToast({
            tone: "success",
            title: t("Screen saver set"),
            detail: t("It starts while MiColl is running, also in the tray."),
          });
          if (!openId) scrollPageToTop();
        }
      } catch (e) {
        fail(t("Couldn’t start the screen saver"))(e);
      } finally {
        setBusyId(null);
        void reload();
      }
      return;
    }
    if (target === "lock") {
      try {
        if (what === "start") await lockSetStart(id);
        else if (what === "next") await lockSetNext();
        else await lockSetStop();
        if (what === "start") {
          showToast({
            tone: "success",
            title: t("Slideshow is on the lock screen"),
            detail: t("The picture changes while MiColl is running, also in the tray."),
          });
          if (!openId) scrollPageToTop();
        }
      } catch (e) {
        fail(t("Couldn’t change the lock screen"))(e);
      } finally {
        setBusyId(null);
        void reload();
      }
      return;
    }
    try {
      if (what === "start") await activateWallSet(id);
      else if (what === "next") await wallSetNext();
      else await wallSetStop();
      if (what !== "next") started.current = null;
      if (what === "start") {
        started.current = { id, until: Date.now() + 10_000 };
        showToast({ tone: "success", title: t("Slideshow is on the desktop") });
        // it moves up to the top as the running one
        if (!openId) scrollPageToTop();
      }
    } catch (e) {
      fail(t("Couldn’t change the wallpaper"))(e);
    } finally {
      setBusyId(null);
      void reload();
    }
  };

  const newSet = async () => {
    try {
      const n = (sets?.length ?? 0) + 1;
      const id = await createWallSet(tf("Slideshow {n}", { n }));
      await reload();
      setOpenId(id);
    } catch (e) {
      fail(t("Couldn’t create the slideshow"))(e);
    }
  };

  // `active` is about the place that's shown
  const shown = useMemo(
    () =>
      sets?.map((s) => ({
        ...s,
        desktop: s.active,
        active: target === "lock" ? s.lock : target === "saver" ? s.saver : s.active,
      })) ?? null,
    [sets, target],
  );
  const open = shown?.find((s) => s.id === openId) ?? null;
  // the running one always shows
  const isHidden = (s: WallSet) => s.hiddenIn.includes(target) && !s.active;

  const showIn = async (s: WallSet, place: HubTarget, how: "show" | "hide" | "only" | "all") => {
    try {
      await showWallSetIn(s.id, place, how);
      if (how === "hide" || how === "only")
        showToast({
          tone: "success",
          title: how === "hide" ? tf("Hidden in “{place}”", { place: names[place] }) : tf("Only shown in “{place}”", { place: names[place] }),
          detail: s.name,
          action: { label: t("Show everywhere again"), onClick: () => void showIn(s, place, "all") },
        });
    } catch (e) {
      fail(t("Couldn’t save the change"))(e);
    }
    void reload();
  };

  const PLACES: HubTarget[] = ["desktop", "lock", "saver"];
  menuRef.current = (e, s) => {
    const here = names[target];
    const shownIn = PLACES.filter((p) => !s.hiddenIn.includes(p));
    openMenu(e, [
      { label: t("Open"), icon: <SlidersHorizontal className="h-4 w-4" />, onClick: () => setOpenId(s.id) },
      ...(s.active
        ? [
            { label: words.next, icon: <words.NextIcon className="h-4 w-4" />, onClick: () => void run(s.id, "next") },
            { label: t("Stop"), icon: <Square className="h-4 w-4" />, onClick: () => void run(s.id, "stop") },
          ]
        : s.count > 0
          ? [{ label: words.start, icon: <Play className="h-4 w-4" />, onClick: () => void run(s.id, "start") }]
          : []),
      // where it's offered
      ...(shownIn.length === 1 && shownIn[0] === target
        ? []
        : [
            {
              label: tf("Show only in “{place}”", { place: here }),
              icon: <Eye className="h-4 w-4" />,
              onClick: () => void showIn(s, target, "only"),
            },
            s.hiddenIn.includes(target)
              ? {
                  label: t("Show here"),
                  icon: <Eye className="h-4 w-4" />,
                  onClick: () => void showIn(s, target, "show"),
                }
              : {
                  label: tf("Hide in “{place}”", { place: here }),
                  icon: <EyeOff className="h-4 w-4" />,
                  onClick: () => void showIn(s, target, "hide"),
                },
          ]),
      {
        label: t("Show in"),
        icon: <Eye className="h-4 w-4" />,
        children: [
          ...PLACES.map((p) => {
            const on = !s.hiddenIn.includes(p);
            const label = names[p];
            const icon = on ? <Check className="h-4 w-4" /> : <span className="inline-block h-4 w-4" />;
            // the last place can't go, it has to be shown somewhere
            if (on && shownIn.length === 1) return { label, icon, info: true };
            return {
              label,
              icon,
              onClick: () => void showIn(s, p, on ? "hide" : "show"),
            };
          }),
          ...(s.hiddenIn.length > 0
            ? [{ label: t("Everywhere"), icon: <Eye className="h-4 w-4" />, onClick: () => void showIn(s, target, "all") }]
            : []),
        ],
      },
      { label: t("Delete slideshow"), icon: <Trash2 className="h-4 w-4" />, danger: true, onClick: () => setAskDelete(s) },
    ]);
  };

  return (
    <HubTargetContext.Provider value={hubTarget}>
    <Layout onLock={onLock}>
      {/* the standard themes' bar hangs from the top bar and needs the bigger padding */}
      <div className={cn("w-full px-6 pb-8 2xl:px-10", isPremium(accent) ? "pt-3" : "pt-6")}>
        {open ? (
          <SetDetail
            set={open}
            onDesktop={!!sets?.find((s) => s.id === open.id)?.active}
            target={target}
            busy={busyId === open.id}
            onBack={() => setOpenId(null)}
            onRun={(what) => void run(open.id, what)}
            onChanged={() => void reload()}
            onDeleted={() => {
              setOpenId(null);
              void reload();
            }}
          />
        ) : (
          <>
          <Overview
            sets={shown && shown.filter((s) => !isHidden(s))}
            busyId={busyId}
            onOpen={setOpenId}
            onRun={(id, what) => void run(id, what)}
            onNew={() => void newSet()}
            extra={<HubExtra className={accent === "iridescent" ? "mb-3" : "mb-4"} />}
          />
          <HiddenSets
            key={target}
            sets={(shown ?? []).filter(isHidden)}
            onOpen={setOpenId}
            onShow={(id) => {
              const s = shown?.find((x) => x.id === id);
              if (s) void showIn(s, target, "show");
            }}
          />
          </>
        )}
        {askDelete && (
          <ConfirmDialog
            title={tf("Delete “{name}”?", { name: askDelete.name })}
            body={t("Only the slideshow goes, every picture stays where it is.")}
            confirmLabel={t("Delete slideshow")}
            onCancel={() => setAskDelete(null)}
            onConfirm={async () => {
              const id = askDelete.id;
              setAskDelete(null);
              await deleteWallSet(id).catch(() => {});
              void reload();
            }}
          />
        )}
      </div>
    </Layout>
    </HubTargetContext.Provider>
  );
}

/** One slideshow: name, settings, its pictures. */
function SetDetail({
  set,
  onDesktop,
  target,
  busy,
  onBack,
  onRun,
  onChanged,
  onDeleted,
}: {
  set: WallSet;
  /** It's the desktop's slideshow (whatever place is shown). */
  onDesktop: boolean;
  target: HubTarget;
  busy: boolean;
  onBack: () => void;
  onRun: (what: "start" | "next" | "stop") => void;
  onChanged: () => void;
  onDeleted: () => void;
}) {
  const t = useT();
  const tf = useTf();
  const tp = useTp();
  const w = useHubWords();
  const dlg = useDialogTheme();
  const hubBox = useHubBox();
  const accent = useAccent();
  const pyre = accent === "corruptruby";
  const irid = accent === "iridescent";
  const cyber = accent === "cyberpunk";
  const sakura = accent === "sakura";
  const { showToast } = useActions();
  const every = useEveryLabel();
  const [name, setName] = useState(set.name);
  const [items, setItems] = useState<string[] | null>(null);
  const [picking, setPicking] = useState(false);
  const [askDelete, setAskDelete] = useState(false);
  // the picture being edited (its original, and what's shown: the active version)
  const [editing, setEditing] = useState<string | null>(null);
  // original -> the active edit version's file (only pictures that have one)
  const [shown, setShown] = useState<Record<string, string>>({});
  // the viewer over the slideshow's own pictures (it scrolls the slideshow, not the reward)
  const [viewer, setViewer] = useState<{ items: ViewerItem[]; start: number; rewardOf: Map<string, string> } | null>(null);
  const { artists } = useData();
  const navigate = useNavigate();
  const openViewer = async (path: string) => {
    const rows = await wallSetImages(set.id).catch(() => []);
    const byId = new Map(artists.map((a) => [a.id, a]));
    const items: ViewerItem[] = rows.map(({ artistId, image: im }) => {
      const file = im.name ? im.name.split(/[\\/]/).pop() || im.name : "";
      const who = byId.get(artistId)?.name ?? "";
      return {
        id: im.id,
        title: file && who ? `${who} — ${file}` : file || who,
        src: im.src,
        path: im.path,
        displayPath: im.displayPath,
        versionCount: im.versionCount,
        onOriginal: im.onOriginal,
        name: file || undefined,
        kind: im.kind,
        favorite: im.favorite,
        favWallpaper: im.favWallpaper,
        collections: im.collections,
      };
    });
    if (items.length === 0) return;
    setViewer({
      items,
      start: Math.max(0, items.findIndex((it) => it.path === path)),
      rewardOf: new Map(rows.map((r) => [r.image.path, r.rewardId])),
    });
  };
  /** The month a picture's reward is in (the viewer's "Go to folder"). */
  const goToFolder = (it: ViewerItem) => {
    const rid = it.path ? viewer?.rewardOf.get(it.path) : undefined;
    if (!rid) return;
    for (const a of artists)
      for (const pl of a.platforms ?? [])
        for (const m of pl.months ?? [])
          if ((m.rewards ?? []).some((r) => r.id === rid)) {
            setViewer(null);
            navigate(`/artist/${a.id}/month/${m.id}`);
            return;
          }
  };

  const loadItems = useCallback(async () => {
    const list = await wallSetItems(set.id).catch(() => [] as string[]);
    setItems(list);
    // tiles and the editor show each picture as MiColl shows it (its active version)
    const vers = await imageVersionsFor(list).catch(() => ({}) as Awaited<ReturnType<typeof imageVersionsFor>>);
    const map: Record<string, string> = {};
    for (const [orig, v] of Object.entries(vers ?? {})) {
      const act = v.activeId != null ? v.versions.find((x) => x.id === v.activeId) : undefined;
      if (act) map[orig] = act.filePath;
    }
    setShown(map);
  }, [set.id]);
  useEffect(() => {
    void loadItems();
  }, [loadItems]);
  useEffect(() => setName(set.name), [set.name]);

  const change = async (c: Parameters<typeof updateWallSet>[1]) => {
    try {
      await updateWallSet(set.id, c);
    } catch (e) {
      showToast({ tone: "error", title: t("Couldn’t save the change"), problem: String(e) });
    }
    onChanged();
  };
  const saveName = () => {
    const n = name.trim();
    if (!n) setName(set.name);
    else if (n !== set.name) void change({ name: n });
  };

  const remove = async (p: string) => {
    setItems((cur) => cur?.filter((x) => x !== p) ?? cur);
    await removeFromWallSet(set.id, [p]).catch(() => {});
    onChanged();
  };

  return (
    <div>
      <div className={irid ? cn(IRI_BAR, "!justify-start px-2 py-2") : "mb-4 flex flex-wrap items-center gap-3"}>
        <Button
          variant="ghost"
          size="sm"
          onClick={onBack}
          // pyre: the arrow plate of the other back buttons (index.css .ruby-back)
          className={pyre ? "ruby-back" : undefined}
        >
          <ChevronLeft className="h-4 w-4" />
          {t("All slideshows")}
        </Button>
        {set.active && (
          <span
            className={
              irid
                ? "iri-hub-live"
                : cyber
                  ? "cp-hub-live"
                  : sakura
                    ? "sak-hub-live"
                    : pyre
                      ? "ruby-hub-live"
                      : "cas-hub-live"
            }
          >
            {(irid || sakura) && <w.Icon className="h-3 w-3" />}
            {w.on}
          </span>
        )}
        <RunsOn set={set} others named />
        <div className="ml-auto">
          <HubTargetSwitch />
        </div>
      </div>

      <div className={cn("flex flex-col gap-4 p-4", hubBox)}>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={saveName}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
            if (e.key === "Escape") {
              setName(set.name);
              e.currentTarget.blur();
            }
          }}
          className={cn("max-w-md text-base font-semibold", dlg.input)}
          aria-label={t("Name")}
        />

        <div className="flex flex-wrap items-center gap-x-6 gap-y-3 text-sm text-zinc-300">
          {target !== "saver" && (
            <label className="flex items-center gap-2">
              <span className="text-xs uppercase tracking-wide text-zinc-500">{t("Change picture every")}</span>
              <select
                value={set.minutes}
                onChange={(e) => void change({ minutes: Number(e.target.value) })}
                className={cn("h-8 px-2 text-sm text-zinc-100 outline-none", dlg.field)}
              >
                {[...new Set([...EVERY, set.minutes])]
                  .sort((a, b) => a - b)
                  .map((m) => (
                    <option key={m} value={m} className="bg-zinc-900">
                      {every(m)}
                    </option>
                  ))}
              </select>
            </label>
          )}
          <div className="flex items-center gap-2">
            <span className="text-xs uppercase tracking-wide text-zinc-500">{t("Fit")}</span>
            <div className="flex gap-1">
              {FITS.map((f) => (
                <button
                  key={f}
                  onClick={() => f !== set.fit && void change({ fit: f })}
                  className={cn("px-2.5 py-1 text-xs", set.fit === f ? dlg.controlOn : dlg.control)}
                >
                  {t(FIT_LABEL[f])}
                </button>
              ))}
            </div>
          </div>
          <button
            onClick={() => void change({ shuffle: !set.shuffle })}
            className={cn("inline-flex items-center gap-1.5 px-2.5 py-1 text-xs", set.shuffle ? dlg.controlOn : dlg.control)}
            title={t("Show the pictures in a random order")}
          >
            <Shuffle className="h-3.5 w-3.5" />
            {t("Shuffle")}
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button
          variant="primary"
          size="sm"
          className={irid ? "iri-lead iri-lead--fine rounded-lg" : isPremium(accent) ? undefined : "casual-lead"}
          onClick={() => setPicking(true)}
        >
            <ImagePlus className="h-4 w-4" />
            {t("Add pictures")}
          </Button>
          <RunButtons set={{ ...set, count: items?.length ?? set.count }} busy={busy} onRun={onRun} />
          <div className="flex-1" />
          <Button variant="ghost" size="sm" onClick={() => setAskDelete(true)}>
            <Trash2 className="h-4 w-4" />
            {t("Delete slideshow")}
          </Button>
        </div>
      </div>

      <HubExtra className="mt-3" />

      {/* iridescent: its own dark plate, the wallpaper is too bright for grey text */}
      <div
        className={
          irid
            ? "mb-3 mt-3 w-fit border border-white/15 bg-zinc-950/65 px-3 py-1.5 text-xs font-medium text-white backdrop-blur"
            : cn("mb-2 mt-5 text-xs", cyber ? "text-[#b8c4cc]" : sakura ? "text-[#e6bccd]" : pyre ? "text-[#ecc9d6]" : "text-zinc-300")
        }
      >
        {items ? tp("{n} pictures", items.length) : "…"}
        {target === "lock"
          ? ` · ${t("The picture changes while MiColl is running, also in the tray.")}`
          : target === "saver"
            ? ` · ${t("It starts while MiColl is running, also in the tray.")}`
          : set.active
            ? ` · ${t("Changes go to the desktop right away.")}`
            : ""}
      </div>
      {items && items.length === 0 ? (
        <div className={cn("flex flex-col items-center gap-3 px-6 py-12 text-center", hubBox)}>
          <Images className="h-8 w-8 text-zinc-600" />
          <p className="text-sm text-zinc-400">{t("No pictures yet — add some from your creators.")}</p>
        </div>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(130px,1fr))] gap-2">
          {(items ?? []).map((p) => (
            <div key={p} className={cn("group relative aspect-square overflow-hidden bg-black/30", irid ? "iri-hub-tile" : cyber ? "cp-hub-tile" : sakura ? "sak-hub-tile" : pyre ? "ruby-hub-tile" : "rounded-lg")} title={fileName(p)}>
              <Thumb path={shown[p] ?? p} />
              {/* the picture opens the viewer over this slideshow */}
              <button
                onClick={() => void openViewer(p)}
                aria-label={t("Open")}
                className="absolute inset-0 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-400"
              />
              {isTauri() && (
                <button
                  onClick={() => setEditing(p)}
                  title={t("Edit")}
                  className="absolute left-1 top-1 flex h-6 w-6 items-center justify-center rounded-full bg-black/70 text-zinc-200 opacity-0 transition-opacity hover:text-white group-hover:opacity-100"
                >
                  <Pencil className="h-3.5 w-3.5" />
                </button>
              )}
              <button
                onClick={() => void remove(p)}
                title={t("Remove from this slideshow")}
                className="absolute right-1 top-1 flex h-6 w-6 items-center justify-center rounded-full bg-black/70 text-zinc-200 opacity-0 transition-opacity hover:text-white group-hover:opacity-100"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}

      {picking && (
        <PicturePicker
          have={new Set(items ?? [])}
          onClose={() => setPicking(false)}
          onAdd={async (paths) => {
            setPicking(false);
            try {
              const n = await addToWallSet(set.id, paths);
              showToast({ tone: "success", title: tp("{n} pictures added", n) });
            } catch (e) {
              showToast({ tone: "error", title: t("Couldn’t add the pictures"), problem: String(e) });
            }
            void loadItems();
            onChanged();
          }}
        />
      )}
      <AnimatePresence>
        {viewer && (
          <ImageViewer
            items={viewer.items}
            startIndex={Math.min(viewer.start, viewer.items.length - 1)}
            onGoToFolder={goToFolder}
            onClose={() => {
              setViewer(null);
              // deleted, edited or moved in the viewer: read the slideshow again
              void loadItems();
              onChanged();
            }}
          />
        )}
      </AnimatePresence>
      {/* to <body> like the viewer: inside the page the app's top bar covered the
          editor's own bar (Save, Close) */}
      {editing &&
        createPortal(
        <ImageEditor
          // edit what's shown, versions attach to the original (like the viewer)
          path={shown[editing] ?? editing}
          origPath={editing}
          name={fileName(editing)}
          onClose={() => setEditing(null)}
          onSavedVersion={() => {
            void loadItems();
            // the desktop shows the new version right away
            if (onDesktop) void activateWallSet(set.id).catch(() => {});
            onChanged();
          }}
        />,
          document.body,
        )}
      {askDelete && (
        <ConfirmDialog
          title={tf("Delete “{name}”?", { name: set.name })}
          body={t("Only the slideshow goes, every picture stays where it is.")}
          confirmLabel={t("Delete slideshow")}
          onCancel={() => setAskDelete(false)}
          onConfirm={async () => {
            setAskDelete(false);
            await deleteWallSet(set.id).catch(() => {});
            onDeleted();
          }}
        />
      )}
    </div>
  );
}

/** A group of pictures the picker shows (a reward, favourites, a collection). */
interface PickGroup {
  key: string;
  title: string;
  paths: string[];
}

type Source = { kind: "favorites" } | { kind: "collection"; c: Collection } | { kind: "artist"; a: Artist };

const isPicture = (p: string) => /\.(jpe?g|jfif|png|bmp|gif|tiff?|webp)$/i.test(p);

/** Pick pictures from any creator, favourites or a collection. */
function PicturePicker({
  have,
  onClose,
  onAdd,
}: {
  have: Set<string>;
  onClose: () => void;
  onAdd: (paths: string[]) => void;
}) {
  const t = useT();
  const tf = useTf();
  const tp = useTp();
  const dlg = useDialogTheme();
  const { artists } = useData();
  const [collections, setCollections] = useState<Collection[]>([]);
  const [source, setSource] = useState<Source | null>(null);
  const [groups, setGroups] = useState<PickGroup[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [q, setQ] = useState("");
  // what each picture shows: its active version (an expanded one is landscape, its original
  // may not be). null = not known yet
  const [versions, setVersions] = useState<Record<string, string> | null>(null);
  const [landscape, setLandscape] = useState(() => {
    try {
      return localStorage.getItem(LANDSCAPE_KEY) === "true";
    } catch {
      return false;
    }
  });
  // file -> landscape or not, null = can't be told (then it's offered)
  const shapes = useRef(new Map<string, boolean | null>());
  const [looked, setLooked] = useState<{ done: number; total: number } | null>(null);
  /** The picture that's shown in big. */
  const [big, setBig] = useState<string | null>(null);
  const bigRef = useRef(big);
  bigRef.current = big;
  const loadSeq = useRef(0);
  // t is a new function every render: read it through a ref, or the load below re-runs forever
  const tRef = useRef(t);
  tRef.current = t;

  useEffect(() => {
    void listCollections()
      .then(setCollections)
      .catch(() => {});
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // (the big picture has its own keys)
      if (e.key === "Escape" && !bigRef.current) {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const creators = useMemo(
    () =>
      artists
        .filter((a) => !a.graveyard && a.name.toLowerCase().includes(q.trim().toLowerCase()))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [artists, q],
  );

  // the source's pictures, grouped (a creator by reward, newest month first as on its page)
  useEffect(() => {
    if (!source) return;
    const seq = ++loadSeq.current;
    setGroups(null);
    const done = (g: PickGroup[]) => seq === loadSeq.current && setGroups(g.filter((x) => x.paths.length > 0));
    if (source.kind === "favorites") {
      void favoriteImages()
        .then((rows) => done([{ key: "fav", title: tRef.current("Favourites"), paths: rows.map((r) => r.image.path).filter(isPicture) }]))
        .catch(() => done([]));
    } else if (source.kind === "collection") {
      void collectionFiles(source.c.id)
        .then((paths) => done([{ key: "col", title: source.c.name, paths: paths.filter(isPicture) }]))
        .catch(() => done([]));
    } else {
      const a = source.a;
      void artistImages(a.id)
        .then((byReward) => {
          const out: PickGroup[] = [];
          for (const pl of a.platforms ?? []) {
            for (const m of pl.months ?? []) {
              for (const r of m.rewards ?? []) {
                const imgs = byReward.get(r.id) ?? [];
                out.push({
                  key: r.id,
                  title: [pl.name, m.label, r.title].filter(Boolean).join(" · "),
                  paths: imgs.filter((im) => (im.kind ?? "image") === "image" && isPicture(im.path)).map((im) => im.path),
                });
              }
            }
          }
          done(out);
        })
        .catch(() => done([]));
    }
  }, [source]);

  // their active versions
  useEffect(() => {
    setVersions(null);
    if (!groups) return;
    let alive = true;
    const all = [...new Set(groups.flatMap((g) => g.paths))];
    void imageVersionsFor(all)
      .catch(() => ({}) as Awaited<ReturnType<typeof imageVersionsFor>>)
      .then((vers) => {
        if (!alive) return;
        const map: Record<string, string> = {};
        for (const [orig, v] of Object.entries(vers ?? {})) {
          const act = v.activeId != null ? v.versions.find((x) => x.id === v.activeId) : undefined;
          if (act) map[orig] = act.filePath;
        }
        setVersions(map);
      });
    return () => {
      alive = false;
    };
  }, [groups]);
  const file = (p: string) => versions?.[p] ?? p;

  // with the filter on: look at the ones that aren't known yet, a few hundred at a time
  useEffect(() => {
    setLooked(null);
    if (!landscape || !groups || !versions) return;
    let alive = true;
    const all = [...new Set(groups.flatMap((g) => g.paths.map((p) => versions[p] ?? p)))];
    const open = all.filter((p) => !shapes.current.has(p));
    void (async () => {
      for (let i = 0; i < open.length; i += LOOK_AT) {
        setLooked({ done: all.length - open.length + i, total: all.length });
        const part = open.slice(i, i + LOOK_AT);
        const res = await landscapePictures(part).catch(() => part.map(() => null));
        if (!alive) return;
        part.forEach((p, k) => shapes.current.set(p, res[k] ?? null));
      }
      if (alive) setLooked({ done: all.length, total: all.length });
    })();
    return () => {
      alive = false;
    };
  }, [landscape, groups, versions]);
  const looking = landscape && !!groups && (!looked || looked.done < looked.total);

  // what's offered (looked is here because it says that shapes got more)
  const offered = useMemo(() => {
    if (!groups || !landscape) return groups;
    const ok = (p: string) => {
      const v = versions ? shapes.current.get(versions[p] ?? p) : undefined;
      return v === true || v === null;
    };
    return groups.map((g) => ({ ...g, paths: g.paths.filter(ok) })).filter((g) => g.paths.length > 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groups, landscape, versions, looked]);
  const flat = useMemo(() => [...new Set((offered ?? []).flatMap((g) => g.paths))], [offered]);
  const flatFree = flat.filter((p) => !have.has(p));
  const allPicked = flatFree.length > 0 && flatFree.every((p) => picked.has(p));

  const switchLandscape = () => {
    setLandscape(!landscape);
    try {
      localStorage.setItem(LANDSCAPE_KEY, landscape ? "false" : "true");
    } catch {
      /* just not remembered */
    }
  };

  const toggle = (paths: string[], on: boolean) =>
    setPicked((cur) => {
      const n = new Set(cur);
      for (const p of paths) if (!have.has(p)) on ? n.add(p) : n.delete(p);
      return n;
    });

  const srcBtn = (active: boolean) =>
    cn(
      "flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm transition-colors",
      active ? cn(dlg.menuRowOpen, "text-zinc-100") : cn("text-zinc-300", dlg.menuRow),
    );
  const isSrc = (s: Source) =>
    !!source &&
    source.kind === s.kind &&
    (s.kind === "favorites" ||
      (s.kind === "collection" && source.kind === "collection" && source.c.id === s.c.id) ||
      (s.kind === "artist" && source.kind === "artist" && source.a.id === s.a.id));

  return createPortal(
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      onClick={onClose}
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
    >
      <motion.div
        initial={{ scale: 0.97, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        onClick={(e) => e.stopPropagation()}
        className={cn("flex h-[85vh] w-[min(1100px,94vw)] flex-col overflow-hidden", dlg.panel)}
      >
        <div className={cn("flex shrink-0 items-center justify-between border-b px-5 py-3", dlg.divider)}>
          <h2 className="flex items-center gap-2 text-sm font-semibold text-zinc-100">
            <ImagePlus className={cn("h-4 w-4", dlg.accentText)} />
            {t("Add pictures")}
          </h2>
          <button onClick={onClose} title={t("Close (Esc)")} className="text-zinc-500 transition-colors hover:text-zinc-300">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex min-h-0 flex-1">
          {/* sources */}
          <div className={cn("flex w-60 shrink-0 flex-col border-r", dlg.divider)}>
            <div className="space-y-0.5 p-2">
              <button onClick={() => setSource({ kind: "favorites" })} className={srcBtn(isSrc({ kind: "favorites" }))}>
                <Heart className="h-4 w-4 shrink-0" />
                {t("Favourites")}
              </button>
              {collections.map((c) => (
                <button key={c.id} onClick={() => setSource({ kind: "collection", c })} className={srcBtn(isSrc({ kind: "collection", c }))}>
                  <Folder className="h-4 w-4 shrink-0" />
                  <span className="truncate">{c.name}</span>
                </button>
              ))}
            </div>
            <div className={cn("border-t px-2 pb-1 pt-2", dlg.divider)}>
              <div className="mb-1 px-1 text-[11px] uppercase tracking-wide text-zinc-500">{t("Creators")}</div>
              <div className={cn("flex items-center gap-1.5 px-2", dlg.field)}>
                <Search className="h-3.5 w-3.5 shrink-0 text-zinc-500" />
                <input
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder={t("Search…")}
                  className="h-8 w-full bg-transparent text-sm text-zinc-100 outline-none placeholder:text-zinc-500"
                />
              </div>
            </div>
            <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto p-2">
              {creators.map((a) => (
                <button key={a.id} onClick={() => setSource({ kind: "artist", a })} className={srcBtn(isSrc({ kind: "artist", a }))}>
                  <span className="truncate">{a.name}</span>
                </button>
              ))}
            </div>
          </div>

          {/* the source's pictures */}
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            {source && groups && groups.length > 0 && (
              <div className={cn("flex shrink-0 flex-wrap items-center gap-2 border-b px-4 py-2", dlg.divider)}>
                <span className="min-w-0 flex-1 text-xs text-zinc-400">
                  {looking
                    ? tf("Checking {n} of {total}…", { n: looked?.done ?? 0, total: looked?.total ?? "…" })
                    : tp("{n} pictures", flat.length)}
                </span>
                <button
                  onClick={switchLandscape}
                  aria-pressed={landscape}
                  title={t("Show only landscape pictures, expanded ones count too")}
                  className={cn("inline-flex items-center gap-1.5 px-2.5 py-1 text-xs", landscape ? dlg.controlOn : dlg.control)}
                >
                  {looking ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RectangleHorizontal className="h-3.5 w-3.5" />}
                  {t("Landscape only")}
                </button>
                {flatFree.length > 0 && (
                  <button
                    onClick={() => toggle(flatFree, !allPicked)}
                    className={cn("px-2.5 py-1 text-xs", allPicked ? dlg.controlOn : dlg.control)}
                  >
                    {allPicked ? t("Select none") : t("Select all")}
                  </button>
                )}
              </div>
            )}
          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            {!source ? (
              <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-sm text-zinc-500">
                <Images className="h-8 w-8" />
                {t("Pick a creator, your favourites or a collection on the left.")}
              </div>
            ) : groups === null ? (
              <div className="flex h-full items-center justify-center">
                <Loader2 className={cn("h-6 w-6 animate-spin", dlg.accentText)} />
              </div>
            ) : groups.length === 0 ? (
              <div className="flex h-full items-center justify-center text-sm text-zinc-500">{t("No pictures here.")}</div>
            ) : !offered || offered.length === 0 ? (
              <div className="flex h-full items-center justify-center text-sm text-zinc-500">
                {looking ? <Loader2 className={cn("h-6 w-6 animate-spin", dlg.accentText)} /> : t("No landscape pictures here.")}
              </div>
            ) : (
              offered.map((g) => {
                const free = g.paths.filter((p) => !have.has(p));
                const all = free.length > 0 && free.every((p) => picked.has(p));
                return (
                  <section key={g.key} className="mb-5">
                    <div className="mb-2 flex items-center gap-2">
                      <h3 className="min-w-0 flex-1 truncate text-xs font-medium text-zinc-300">{g.title}</h3>
                      <span className="text-[11px] text-zinc-500">{tp("{n} pictures", g.paths.length)}</span>
                      {free.length > 0 && (
                        <button onClick={() => toggle(free, !all)} className={cn("px-2 py-0.5 text-[11px]", all ? dlg.controlOn : dlg.control)}>
                          {all ? t("Select none") : t("Select all")}
                        </button>
                      )}
                    </div>
                    <div className="grid grid-cols-[repeat(auto-fill,minmax(96px,1fr))] gap-1.5">
                      {g.paths.map((p) => {
                        const inSet = have.has(p);
                        const on = picked.has(p);
                        return (
                          <div key={p} className="group relative aspect-square">
                            <button
                              disabled={inSet}
                              onClick={() => toggle([p], !on)}
                              title={inSet ? t("Already in this slideshow") : fileName(p)}
                              className={cn(
                                "absolute inset-0 overflow-hidden rounded-md bg-black/30 ring-2 ring-inset transition",
                                on ? "ring-brand-400" : "ring-transparent",
                                inSet && "opacity-40",
                              )}
                            >
                              <Thumb path={file(p)} />
                              {(on || inSet) && (
                                <span className={cn("absolute left-1 top-1 flex h-5 w-5 items-center justify-center rounded-full text-white", dlg.accent)}>
                                  <Check className="h-3 w-3" />
                                </span>
                              )}
                            </button>
                            <button
                              onClick={() => setBig(p)}
                              title={t("Show it large")}
                              aria-label={t("Show it large")}
                              className="hub-run absolute right-1 top-1 opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100"
                            >
                              <ZoomIn className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  </section>
                );
              })
            )}
          </div>
          </div>
        </div>

        <div className={cn("flex shrink-0 items-center gap-3 border-t px-5 py-3", dlg.divider)}>
          <span className="text-sm text-zinc-400">{tp("{n} pictures selected", picked.size)}</span>
          {picked.size > 0 && (
            <button onClick={() => setPicked(new Set())} className="text-xs text-zinc-500 hover:text-zinc-300">
              {t("Clear")}
            </button>
          )}
          <div className="flex-1" />
          <Button variant="ghost" size="sm" onClick={onClose}>
            {t("Cancel")}
          </Button>
          <Button variant="primary" size="sm" disabled={picked.size === 0} onClick={() => onAdd([...picked])}>
            <Plus className="h-4 w-4" />
            {picked.size > 0 ? tf("Add {n}", { n: picked.size }) : t("Add")}
          </Button>
        </div>
      </motion.div>
      {big && (
        // (a portal of its own, but its clicks would come up here as React events)
        <div onClick={(e) => e.stopPropagation()}>
          <PickPreview
            path={file(big)}
            name={fileName(big)}
            picked={picked.has(big)}
            locked={have.has(big)}
            place={`${flat.indexOf(big) + 1} / ${flat.length}`}
            onStep={(by) => {
              const i = flat.indexOf(big);
              setBig(flat[(i + by + flat.length) % flat.length] ?? big);
            }}
            onToggle={() => toggle([big], !picked.has(big))}
            onClose={() => setBig(null)}
          />
        </div>
      )}
    </motion.div>,
    document.body,
  );
}
