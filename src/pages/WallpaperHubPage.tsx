import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import { useNavigate } from "react-router-dom";
import { ImageViewer, type ViewerItem } from "@/components/ImageViewer";
import {
  Check,
  ChevronLeft,
  Folder,
  Heart,
  ImagePlus,
  Images,
  Loader2,
  Monitor,
  Pencil,
  Play,
  Plus,
  Search,
  Shuffle,
  SkipForward,
  Square,
  Trash2,
  Wallpaper,
  X,
} from "lucide-react";
import { Layout } from "@/components/Layout";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { ImageEditor } from "@/components/ImageEditor";
import { refreshWallSets } from "@/components/AddToSlideshow";
import { useData } from "@/store";
import { useActions } from "@/actions";
import { useDialogTheme, type DialogTheme } from "@/lib/dialogTheme";
import { isPremium, useAccent } from "@/lib/theme";
import { isTauri, thumbUrl } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import { useT, useTf, useTp } from "@/lib/i18n";
import {
  activateWallSet,
  addToWallSet,
  artistImages,
  collectionFiles,
  createWallSet,
  deleteWallSet,
  favoriteImages,
  listCollections,
  listWallSets,
  removeFromWallSet,
  updateWallSet,
  imageVersionsFor,
  wallSetItems,
  wallSetImages,
  wallSetNext,
  wallSetStop,
  type SlideshowFit,
  type WallSet,
} from "@/api/library";
import type { Artist, Collection } from "@/types";

/**
 * Wallpaper Hub: desktop slideshows made of pictures from any creator (the phone app
 * has the same page). A slideshow keeps only the files' paths, every picture stays
 * where it is. Windows runs one slideshow at a time, the running one is marked.
 */

/** "Change picture every" choices, in minutes. */
const EVERY = [1, 5, 10, 15, 30, 60, 180, 360, 720, 1440];
const FITS: SlideshowFit[] = ["fill", "fit", "stretch"];
const FIT_LABEL: Record<SlideshowFit, string> = { fill: "Fill", fit: "Fit", stretch: "Stretch" };

const fileName = (p: string) => p.split(/[\\/]/).pop() || p;

/** "10 min", "1 h", "1 day" */
function useEveryLabel() {
  const tf = useTf();
  const t = useT();
  return (m: number) =>
    m >= 1440 ? t("1 day") : m >= 60 ? tf("{n} h", { n: m / 60 }) : tf("{n} min", { n: m });
}

/** A square picture, lazily loaded (a gradient in the browser). */
function Thumb({ path, className }: { path: string; className?: string }) {
  const src = isTauri() ? thumbUrl(path, 256) : "";
  return src ? (
    <img src={src} loading="lazy" draggable={false} alt="" className={cn("h-full w-full object-cover", className)} />
  ) : (
    <div className={cn("h-full w-full bg-gradient-to-br from-brand-700/40 to-zinc-800", className)} />
  );
}

/**
 * The hub's cards and boxes. The casual themes get their own color, dark, instead of
 * the dialogs' grey box (index.css .hub-card); iridescent a darker frost so the text
 * reads over a bright wallpaper. The other premium themes keep their dialog box.
 */
function useHubBox(dlg: DialogTheme): string {
  const accent = useAccent();
  if (accent === "iridescent")
    return "rounded-xl border border-white/15 bg-zinc-950/65 backdrop-blur [&_.text-zinc-500]:text-zinc-300";
  return isPremium(accent) ? dlg.box : "hub-card rounded-xl";
}

export function WallpaperHubPage({ onLock }: { onLock?: () => void }) {
  const t = useT();
  const tf = useTf();
  const tp = useTp();
  const dlg = useDialogTheme();
  const hubBox = useHubBox(dlg);
  const irid = useAccent() === "iridescent";
  const { showToast } = useActions();
  const every = useEveryLabel();
  const [sets, setSets] = useState<WallSet[] | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setSets(await listWallSets());
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

  /** Start / next / stop, then read the state again. */
  const run = async (id: string, what: "start" | "next" | "stop") => {
    setBusyId(id);
    try {
      if (what === "start") await activateWallSet(id);
      else if (what === "next") await wallSetNext();
      else await wallSetStop();
      if (what === "start") showToast({ tone: "success", title: t("Slideshow is on the desktop") });
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

  const open = sets?.find((s) => s.id === openId) ?? null;

  return (
    <Layout onLock={onLock}>
      <div className="mx-auto w-full max-w-6xl px-6 py-6">
        {open ? (
          <SetDetail
            set={open}
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
            <div
              // iridescent: a dark frost behind the title, the wallpaper is too bright for it
              className={cn(
                "mb-5",
                irid &&
                  "w-fit max-w-full rounded-xl border border-white/15 bg-zinc-950/60 px-4 py-3 backdrop-blur [&_.text-zinc-400]:text-zinc-200 [&_.text-zinc-500]:text-zinc-300",
              )}
            >
              <h1 className="flex items-center gap-2 text-lg font-semibold text-zinc-100">
                <Wallpaper className={cn("h-5 w-5", dlg.accentText)} />
                {t("Slideshows")}
                {!!sets?.length && <span className="text-sm font-normal text-zinc-500">({sets.length})</span>}
              </h1>
              <p className="mt-1 max-w-2xl text-sm text-zinc-400">
                {t(
                  "Desktop slideshows with pictures from any creator. The pictures stay where they are; Windows runs one slideshow at a time.",
                )}
              </p>
            </div>

            {sets === null ? (
              <div className="flex justify-center py-16">
                <Loader2 className={cn("h-6 w-6 animate-spin", dlg.accentText)} />
              </div>
            ) : sets.length === 0 ? (
              <div className={cn("flex flex-col items-center gap-3 px-6 py-16 text-center", hubBox)}>
                <Wallpaper className={cn("h-10 w-10", dlg.accentText)} />
                <p className="text-sm text-zinc-300">{t("No slideshows yet.")}</p>
                <p className="max-w-sm text-xs text-zinc-500">
                  {t("Make one, add pictures from your creators, favourites or collections, and set it as your desktop background.")}
                </p>
                <Button variant="primary" size="sm" onClick={() => void newSet()}>
                  <Plus className="h-4 w-4" />
                  {t("New slideshow")}
                </Button>
              </div>
            ) : (
              <div className="grid grid-cols-[repeat(auto-fill,minmax(250px,1fr))] gap-4">
                {/* New slideshow as the first tile, the size of a card */}
                <button
                  onClick={() => void newSet()}
                  className={cn(
                    "group flex min-h-[14rem] flex-col items-center justify-center gap-2 border-dashed text-zinc-400 transition-colors hover:text-zinc-100",
                    hubBox,
                  )}
                >
                  <span className={cn("flex h-11 w-11 items-center justify-center rounded-full transition-transform group-hover:scale-110", dlg.control)}>
                    <Plus className={cn("h-5 w-5", dlg.accentText)} />
                  </span>
                  <span className="text-sm font-medium">{t("New slideshow")}</span>
                </button>
                {sets.map((s) => (
                  <div key={s.id} className={cn("flex flex-col overflow-hidden", hubBox)}>
                    <button
                      onClick={() => setOpenId(s.id)}
                      title={t("Open")}
                      className="relative grid aspect-video grid-cols-2 grid-rows-2 gap-px overflow-hidden bg-black/40"
                    >
                      {s.preview.length === 0 ? (
                        <div className="col-span-2 row-span-2 flex items-center justify-center">
                          <Images className="h-8 w-8 text-zinc-600" />
                        </div>
                      ) : (
                        s.preview.map((p, i) => (
                          <div
                            key={p}
                            className={cn(
                              "overflow-hidden",
                              s.preview.length === 1 && "col-span-2 row-span-2",
                              s.preview.length === 2 && "row-span-2",
                              s.preview.length === 3 && i === 0 && "row-span-2",
                            )}
                          >
                            <Thumb path={p} />
                          </div>
                        ))
                      )}
                      {s.active && (
                        <span
                          className={cn(
                            "absolute left-2 top-2 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium text-white",
                            dlg.accent,
                          )}
                        >
                          <Monitor className="h-3 w-3" />
                          {t("On the desktop")}
                        </span>
                      )}
                    </button>
                    <div className="flex flex-1 flex-col gap-2 p-3">
                      <button onClick={() => setOpenId(s.id)} className="truncate text-left text-sm font-semibold text-zinc-100">
                        {s.name}
                      </button>
                      <div className="flex flex-wrap items-center gap-x-2 text-[11px] text-zinc-400">
                        <span>{tp("{n} pictures", s.count)}</span>
                        <span>·</span>
                        <span>{tf("every {time}", { time: every(s.minutes) })}</span>
                        {s.shuffle && <Shuffle className="h-3 w-3" />}
                        <span>· {t(FIT_LABEL[s.fit])}</span>
                      </div>
                      <RunButtons set={s} busy={busyId === s.id} onRun={(what) => void run(s.id, what)} />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </Layout>
  );
}

/** Start, or Next + Stop while it runs. */
function RunButtons({
  set,
  busy,
  onRun,
}: {
  set: WallSet;
  busy: boolean;
  onRun: (what: "start" | "next" | "stop") => void;
}) {
  const t = useT();
  if (set.active) {
    return (
      <div className="mt-auto flex gap-2">
        <Button variant="outline" size="sm" disabled={busy} onClick={() => onRun("next")}>
          <SkipForward className="h-4 w-4" />
          {t("Next picture")}
        </Button>
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => onRun("stop")} title={t("The picture on screen now stays as your background")}>
          <Square className="h-3.5 w-3.5" />
          {t("Stop")}
        </Button>
      </div>
    );
  }
  return (
    <div className="mt-auto flex">
      <Button variant="outline" size="sm" disabled={busy || set.count === 0} onClick={() => onRun("start")}>
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
        {t("Set as desktop slideshow")}
      </Button>
    </div>
  );
}

/** One slideshow: name, settings, its pictures. */
function SetDetail({
  set,
  busy,
  onBack,
  onRun,
  onChanged,
  onDeleted,
}: {
  set: WallSet;
  busy: boolean;
  onBack: () => void;
  onRun: (what: "start" | "next" | "stop") => void;
  onChanged: () => void;
  onDeleted: () => void;
}) {
  const t = useT();
  const tf = useTf();
  const tp = useTp();
  const dlg = useDialogTheme();
  const hubBox = useHubBox(dlg);
  const pyre = useAccent() === "corruptruby";
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
      <div className="mb-4 flex flex-wrap items-center gap-3">
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
          <span className={cn("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium text-white", dlg.accent)}>
            <Monitor className="h-3 w-3" />
            {t("On the desktop")}
          </span>
        )}
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
          <Button variant="primary" size="sm" onClick={() => setPicking(true)}>
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

      <div className="mb-2 mt-5 text-xs text-zinc-500">
        {items ? tp("{n} pictures", items.length) : "…"}
        {set.active ? ` · ${t("Changes go to the desktop right away.")}` : ""}
      </div>
      {items && items.length === 0 ? (
        <div className={cn("flex flex-col items-center gap-3 px-6 py-12 text-center", hubBox)}>
          <Images className="h-8 w-8 text-zinc-600" />
          <p className="text-sm text-zinc-400">{t("No pictures yet — add some from your creators.")}</p>
        </div>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(130px,1fr))] gap-2">
          {(items ?? []).map((p) => (
            <div key={p} className="group relative aspect-square overflow-hidden rounded-lg bg-black/30" title={fileName(p)}>
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
            if (set.active) void activateWallSet(set.id).catch(() => {});
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
      if (e.key === "Escape") {
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
            ) : (
              groups.map((g) => {
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
                          <button
                            key={p}
                            disabled={inSet}
                            onClick={() => toggle([p], !on)}
                            title={inSet ? t("Already in this slideshow") : fileName(p)}
                            className={cn(
                              "relative aspect-square overflow-hidden rounded-md bg-black/30 ring-2 ring-inset transition",
                              on ? "ring-brand-400" : "ring-transparent",
                              inSet && "opacity-40",
                            )}
                          >
                            <Thumb path={p} />
                            {(on || inSet) && (
                              <span className={cn("absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-full text-white", dlg.accent)}>
                                <Check className="h-3 w-3" />
                              </span>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  </section>
                );
              })
            )}
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
    </motion.div>,
    document.body,
  );
}
