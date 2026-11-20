import { useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import { listen } from "@tauri-apps/api/event";
import { X, Loader2, Trash2, Check, Maximize2, ChevronRight, FolderX, Layers, Images } from "lucide-react";
import { Cover } from "@/components/Cover";
import { useData } from "@/store";
import { useActions } from "@/actions";
import {
  cancelDuplicateScan,
  findDuplicates,
  deleteImage,
  type DuplicateImage,
  type DuplicateProgress,
} from "@/api/library";
import { type DuplicateScope } from "@/lib/duplicates";
import { useAccent } from "@/lib/theme";
import { useDialogTheme } from "@/lib/dialogTheme";
import { cn } from "@/lib/utils";
import { useT, useTf, useTp } from "@/lib/i18n";

function fmtBytes(n: number): string {
  if (n <= 0) return "0 B";
  const u = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${u[i]}`;
}

/** 3:05 / 1:02:05 */
function fmtClock(sec: number): string {
  const s = Math.max(1, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${r}` : `${m}:${r}`;
}

/** Fullscreen side-by-side compare of one group's images. */
function CompareView({ images, onClose }: { images: DuplicateImage[]; onClose: () => void }) {
  const t = useT();
  const dlg = useDialogTheme();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center gap-1 bg-black p-2"
      onClick={onClose}
    >
      {images.map((im) => (
        <div key={im.id} className="flex h-full min-w-0 flex-1 items-center justify-center">
          <Cover path={im.path} seed={im.reward} size={1600} rounded="rounded-none" className="object-contain" />
        </div>
      ))}
      {/* the only visible button here, so it carries the theme */}
      <button
        onClick={onClose}
        className={cn("absolute right-3 top-3 p-2", dlg.control)}
        title={t("Close (Esc)")}
      >
        <X className="h-5 w-5" />
      </button>
    </div>
  );
}

/** One reward that has images with copies: what it has, and which rewards it shares them with. */
interface RewardRow {
  id: string;
  title: string;
  artist: string;
  platform: string | null;
  period: string;
  /** All images the reward has. */
  total: number;
  /** Its images that have a copy (somewhere in the results). */
  images: DuplicateImage[];
  /** Indexes into groups. */
  groups: number[];
  /** Other rewards with copies of its images: how many of its images they share. */
  others: { id: string; title: string; n: number }[];
}

function byReward(groups: DuplicateImage[][]): RewardRow[] {
  const rows = new Map<string, RewardRow & { otherMap: Map<string, { title: string; n: number }> }>();
  groups.forEach((g, gi) => {
    for (const im of g) {
      let r = rows.get(im.rewardId);
      if (!r) {
        r = {
          id: im.rewardId,
          title: im.reward,
          artist: im.artist,
          platform: im.platform,
          period: im.period,
          total: im.rewardImages,
          images: [],
          groups: [],
          others: [],
          otherMap: new Map(),
        };
        rows.set(im.rewardId, r);
      }
      r.images.push(im);
      if (r.groups[r.groups.length - 1] !== gi) r.groups.push(gi);
    }
    // how many of a reward's images in this group have a copy in each other reward
    const inGroup = new Map<string, { title: string; n: number }>();
    for (const im of g) {
      const e = inGroup.get(im.rewardId) ?? { title: im.reward, n: 0 };
      e.n += 1;
      inGroup.set(im.rewardId, e);
    }
    for (const [a, ea] of inGroup)
      for (const [b, eb] of inGroup) {
        if (a === b) continue;
        const m = rows.get(a)!.otherMap;
        const e = m.get(b) ?? { title: eb.title, n: 0 };
        e.n += ea.n;
        m.set(b, e);
      }
  });
  return [...rows.values()]
    .map(({ otherMap, ...r }) => ({
      ...r,
      others: [...otherMap.entries()].map(([id, e]) => ({ id, ...e })).sort((a, b) => b.n - a.n),
    }))
    .sort((a, b) => b.images.length - a.images.length || b.images.length / b.total - a.images.length / a.total);
}

/**
 * Finds duplicate images and lets you keep one per group and delete the rest.
 * Results are listed per reward (click one to see its copies, or delete the whole
 * reward), or as plain groups. "Compare" shows a group side by side.
 * Two modes: exact copies (default) or images that look the same (e.g. resized copies).
 * While it scans, a bar shows how far it is and about how long is left.
 */
export function DuplicatesPanel({
  scope,
  onClose,
}: {
  scope?: DuplicateScope;
  onClose: () => void;
}) {
  const t = useT();
  const tf = useTf();
  const tp = useTp();
  const { refresh } = useData();
  const { requestDelete } = useActions();
  // uses the dialog theme. sharp = cyberpunk square corners for the few own-colored
  // controls
  const accent = useAccent();
  const dlg = useDialogTheme();
  const sharp = accent === "cyberpunk";
  const [loading, setLoading] = useState(true);
  const [groups, setGroups] = useState<DuplicateImage[][]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [compare, setCompare] = useState<DuplicateImage[] | null>(null);
  // off = exact copies only, on = also resized/re-saved ones. Off by default since this
  // deletes files.
  const [similar, setSimilar] = useState(false);
  // per reward (default) or the plain groups
  const [view, setView] = useState<"rewards" | "groups">("rewards");
  const [open, setOpen] = useState<string | null>(null);
  const [progress, setProgress] = useState<DuplicateProgress | null>(null);
  // where the current phase started, for the time left
  const phaseStart = useRef<{ phase: string; at: number; done: number } | null>(null);
  const [eta, setEta] = useState<number | null>(null);

  useEffect(() => {
    let alive = true;
    const scanId = Math.floor(Math.random() * 1e15) + 1;
    setLoading(true);
    setProgress(null);
    setEta(null);
    phaseStart.current = null;
    let unlisten: (() => void) | null = null;
    void listen<DuplicateProgress>("dup-progress", (e) => {
      if (!alive || e.payload.scan !== scanId) return;
      const p = e.payload;
      const now = performance.now();
      const st = phaseStart.current;
      if (!st || st.phase !== p.phase) {
        phaseStart.current = { phase: p.phase, at: now, done: p.done };
        setEta(null);
      } else {
        // after a moment, from the speed so far in this phase
        const secs = (now - st.at) / 1000;
        const did = p.done - st.done;
        if (secs > 1.5 && did > 0) {
          const left = ((p.total - p.done) / did) * secs;
          setEta((old) => (old == null ? left : old * 0.7 + left * 0.3));
        }
      }
      setProgress(p);
    }).then((off) => {
      if (alive) unlisten = off;
      else off();
    });
    findDuplicates(scope, similar, scanId)
      .then((g) => {
        if (!alive) return;
        setGroups(g);
        const sel = new Set<string>();
        g.forEach((grp) => grp.slice(1).forEach((im) => sel.add(im.id)));
        setSelected(sel);
        setOpen(null);
      })
      .catch(() => alive && setGroups([]))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
      unlisten?.();
      // closed or switched mode: the old scan stops instead of running on
      void cancelDuplicateScan(scanId).catch(() => {});
    };
  }, [scope?.artistId, scope?.platform, scope?.periodId, scope?.rewardId, similar]);

  const rewards = useMemo(() => byReward(groups), [groups]);
  // a single reward (scanned on its own) is open right away
  useEffect(() => {
    if (rewards.length === 1) setOpen(rewards[0].id);
  }, [rewards]);

  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  /**
   * Mark all of one reward's copies to delete (del) or keep. A group never loses all its
   * images: the biggest one from another reward stays.
   */
  const markReward = (row: RewardRow, del: boolean) =>
    setSelected((s) => {
      const n = new Set(s);
      for (const gi of row.groups) {
        const g = groups[gi];
        for (const im of g) if (im.rewardId === row.id) del ? n.add(im.id) : n.delete(im.id);
        if (del && g.every((im) => n.has(im.id))) {
          const keep = g.find((im) => im.rewardId !== row.id);
          if (keep) n.delete(keep.id);
        }
      }
      return n;
    });

  const deleteReward = (row: RewardRow) =>
    requestDelete({
      title: row.title,
      rewardIds: [row.id],
      alwaysAsk: true,
      onDone: () => {
        const gone = new Set(row.images.map((im) => im.id));
        setGroups((gs) => gs.map((g) => g.filter((im) => im.rewardId !== row.id)).filter((g) => g.length > 1));
        setSelected((s) => new Set([...s].filter((id) => !gone.has(id))));
        setOpen(null);
      },
    });

  const dupCount = groups.reduce((n, g) => n + g.length, 0);

  const deleteSelected = async () => {
    if (selected.size === 0) return;
    setBusy(true);
    try {
      // a file another program holds stays (and so does its image)
      const gone = new Set<string>();
      for (const id of selected) {
        const r = await deleteImage(id, true).catch(() => null);
        if (r && !r.kept.includes(id)) gone.add(id);
      }
      await refresh();
      setGroups((gs) =>
        gs.map((g) => g.filter((im) => !gone.has(im.id))).filter((g) => g.length > 1),
      );
      setSelected(new Set());
    } finally {
      setBusy(false);
    }
  };

  const jumpTo = (id: string) => {
    setOpen(id);
    requestAnimationFrame(() =>
      document.getElementById(`dup-reward-${id}`)?.scrollIntoView({ block: "start", behavior: "smooth" }),
    );
  };

  /** One group's tiles (keep/delete), with its head and Compare. */
  const groupCard = (g: DuplicateImage[], gi: number, label: string, mine?: string) => (
    <div key={gi} className={cn("p-3", dlg.box)}>
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs font-medium uppercase tracking-wide text-zinc-500">{label}</span>
        <button
          onClick={() => setCompare(g)}
          className={cn("inline-flex items-center gap-1 px-2 py-1 text-[11px]", dlg.control)}
          title={t("View full size, side by side")}
        >
          <Maximize2 className="h-3 w-3" />
          {t("Compare")}
        </button>
      </div>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(120px,1fr))] gap-2.5">
        {g.map((im) => {
          const del = selected.has(im.id);
          const other = mine != null && im.rewardId !== mine;
          return (
            <button
              key={im.id}
              onClick={() => toggle(im.id)}
              className={cn(
                "group relative overflow-hidden border-2 text-left transition-colors",
                sharp ? "rounded-none" : "rounded-lg",
                // keep/delete stays green/red in every theme
                del ? "border-rose-500/70" : "border-emerald-500/60",
              )}
            >
              <div className="aspect-square w-full">
                <Cover path={im.path} seed={im.reward} size={400} rounded="rounded-none" />
              </div>
              <span
                className={cn(
                  "absolute left-1.5 top-1.5 inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide backdrop-blur",
                  sharp ? "rounded-none" : "rounded-md",
                  del ? "bg-rose-500/85 text-white" : "bg-emerald-500/85 text-white",
                )}
              >
                {del ? <Trash2 className="h-3 w-3" /> : <Check className="h-3 w-3" />}
                {del ? t("Delete") : t("Keep")}
              </span>
              <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/90 to-transparent p-1.5 pt-6">
                <div className="truncate text-[11px] font-medium text-white" title={im.name}>
                  {im.name}
                </div>
                <div className="truncate text-[10px] text-zinc-300">
                  {im.width > 0 ? `${im.width}×${im.height} · ` : ""}
                  {fmtBytes(im.bytes)}
                </div>
                <div
                  className={cn("truncate text-[10px]", other ? "font-medium text-amber-200" : "text-zinc-400")}
                  title={`${im.artist} · ${im.reward}`}
                >
                  {other ? `↗ ${im.reward}` : `${im.artist} · ${im.reward}`}
                </div>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );

  const groupLabel = (g: DuplicateImage[], i: number) =>
    tf(similar ? "Group {i} · {n} similar copies" : "Group {i} · {n} identical copies", { i, n: g.length });

  const phaseLabel = (p: DuplicateProgress | null) =>
    !p
      ? t("Getting ready…")
      : p.phase === "look"
        ? t("Looking at each picture…")
        : p.phase === "compare"
          ? t("Comparing pictures…")
          : t("Comparing files…");

  const pct = progress && progress.total > 0 ? Math.min(100, (progress.done / progress.total) * 100) : 0;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
      <motion.div
        initial={{ opacity: 0, y: 12, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        className={cn("flex max-h-[92vh] w-[52rem] max-w-full flex-col overflow-hidden", dlg.panel)}
      >
        <div className={cn("flex items-center justify-between border-b px-5 py-4", dlg.divider)}>
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-zinc-100">
              {t("Duplicate finder")}
              {scope?.label && <span className="text-zinc-400"> · {scope.label}</span>}
            </h2>
            <p className="text-xs text-zinc-500">
              {loading
                ? t("Scanning…")
                : groups.length === 0
                  ? similar
                    ? t("Nothing here looks alike.")
                    : t("No exact duplicates here.")
                  : tf("{rewards} · {groups} group(s) · {images} · {marked} marked to delete", {
                      rewards: tp("{n} rewards", rewards.length),
                      groups: groups.length,
                      images: tp("{n} images", dupCount),
                      marked: selected.size,
                    })}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {/* per reward or the plain groups */}
            {!loading && groups.length > 0 && (
              <div className={cn("flex overflow-hidden", dlg.field)}>
                {[
                  { v: "rewards" as const, icon: <Layers className="h-3 w-3" />, label: t("By reward") },
                  { v: "groups" as const, icon: <Images className="h-3 w-3" />, label: t("All groups") },
                ].map((m) => (
                  <button
                    key={m.v}
                    onClick={() => setView(m.v)}
                    className={cn(
                      "inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-medium transition-colors",
                      view === m.v ? cn(dlg.menuRowOpen, dlg.accentText) : cn("text-zinc-400", dlg.menuRow),
                    )}
                  >
                    {m.icon}
                    {m.label}
                  </button>
                ))}
              </div>
            )}
            {/* two separate modes, exact and similar results never mixed in one list */}
            <div className={cn("flex overflow-hidden", dlg.field)}>
              {[
                { on: false, label: t("Identical"), hint: t("Byte-for-byte identical files") },
                {
                  on: true,
                  label: t("Similar"),
                  hint: t("Also finds resized or re-saved copies — slower, and can group different pictures"),
                },
              ].map((m) => (
                <button
                  key={m.label}
                  onClick={() => setSimilar(m.on)}
                  title={m.hint}
                  disabled={busy}
                  className={cn(
                    "px-2.5 py-1 text-[11px] font-medium transition-colors",
                    similar === m.on
                      ? cn(dlg.menuRowOpen, dlg.accentText)
                      : cn("text-zinc-400", dlg.menuRow),
                  )}
                >
                  {m.label}
                </button>
              ))}
            </div>
            <button onClick={onClose} className="text-zinc-500 hover:text-zinc-300">
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {loading ? (
            <div className="mx-auto flex max-w-sm flex-col items-center py-16 text-zinc-400">
              <Loader2 className={cn("h-8 w-8 animate-spin", dlg.accentText)} />
              <p className="mt-3 text-sm text-zinc-300">{phaseLabel(progress)}</p>
              {similar && progress && (
                <p className="mt-0.5 text-[11px] text-zinc-500">
                  {tf("Step {i} of {n}", { i: progress.phase === "compare" ? 2 : 1, n: 2 })}
                </p>
              )}
              {/* how far, and about how long is left */}
              <div className={cn("mt-4 h-1.5 w-full overflow-hidden", dlg.field, sharp ? "rounded-none" : "rounded-full")}>
                <div
                  className={cn("h-full transition-[width] duration-200", dlg.accent)}
                  style={{ width: `${pct}%` }}
                />
              </div>
              <div className="mt-1.5 flex w-full justify-between text-[11px] tabular-nums text-zinc-500">
                <span>
                  {progress && progress.total > 0
                    ? progress.phase === "compare"
                      ? `${Math.floor(pct)}%`
                      : tf("{done} / {total} images", { done: progress.done.toLocaleString(), total: progress.total.toLocaleString() })
                    : ""}
                </span>
                <span>
                  {progress && progress.total > 0
                    ? eta == null
                      ? t("Estimating time…")
                      : eta < 5
                        ? t("Almost done")
                        : tf("About {time} left", { time: fmtClock(eta) })
                    : ""}
                </span>
              </div>
              {similar && (
                <p className="mt-4 text-center text-xs text-zinc-500">
                  {t("Every image has to be looked at once — the first run is the slow one.")}
                </p>
              )}
            </div>
          ) : groups.length === 0 ? (
            <div className="grid place-items-center gap-2 py-20 text-center">
              {/* "nothing found" uses the accent color, not green */}
              <Check className={cn("h-8 w-8", dlg.accentText)} />
              <p className="text-sm text-zinc-300">
                {similar ? t("No look-alike images found.") : t("No identical images found.")}
              </p>
            </div>
          ) : (
            <div className="space-y-5">
              {similar && (
                // the warning text stays amber
                <p className={cn("px-3 py-2 text-xs text-amber-200", dlg.box)}>
                  {t(
                    "These are grouped by how they look, not by their contents — two different pictures can land together. The biggest version of each group is the one kept; check a group with Compare before deleting.",
                  )}
                </p>
              )}
              {view === "groups" ? (
                groups.map((g, gi) => groupCard(g, gi, groupLabel(g, gi + 1)))
              ) : (
                <div className="space-y-2">
                  {rewards.map((r) => {
                    const isOpen = open === r.id;
                    const all = r.total > 0 && r.images.length >= r.total;
                    const marked = r.images.filter((im) => selected.has(im.id)).length;
                    return (
                      <div key={r.id} id={`dup-reward-${r.id}`} className={cn("scroll-mt-2 overflow-hidden", dlg.box)}>
                        {/* the reward: its first copy as picture, how much of it has copies, with whom */}
                        <button
                          onClick={() => setOpen(isOpen ? null : r.id)}
                          className={cn("flex w-full items-center gap-3 p-2.5 text-left transition-colors", dlg.menuRow)}
                        >
                          <div
                            className={cn(
                              "aspect-[4/5] w-11 shrink-0 overflow-hidden ring-1 ring-white/10",
                              sharp ? "rounded-none" : "rounded-md",
                            )}
                          >
                            <Cover path={r.images[0].path} seed={r.title} size={200} rounded="rounded-none" />
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="flex min-w-0 items-center gap-2">
                              <span className="truncate text-sm font-medium text-zinc-100" title={r.title}>
                                {r.title}
                              </span>
                              {all && (
                                <span
                                  className={cn(
                                    "shrink-0 bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-amber-200",
                                    sharp ? "rounded-none" : "rounded",
                                  )}
                                  title={t("Every image of this reward has a copy somewhere")}
                                >
                                  {t("All images")}
                                </span>
                              )}
                            </div>
                            <div className="truncate text-xs text-zinc-500">
                              {[r.artist, r.platform, r.period].filter(Boolean).join(" › ")}
                            </div>
                            {r.others.length > 0 && (
                              <div className="truncate text-[11px] text-zinc-400">
                                {t("Looks like:")}{" "}
                                {r.others
                                  .slice(0, 3)
                                  .map((o) => `${o.title} (${o.n})`)
                                  .join(" · ")}
                                {r.others.length > 3 ? ` +${r.others.length - 3}` : ""}
                              </div>
                            )}
                          </div>
                          <div className="shrink-0 text-right text-xs tabular-nums">
                            <div className="text-zinc-200">
                              {tf("{n} of {total}", { n: r.images.length, total: r.total })}
                            </div>
                            <div className="text-[11px] text-zinc-500">
                              {marked > 0 ? tf("{n} to delete", { n: marked }) : t("all kept")}
                            </div>
                          </div>
                          <ChevronRight
                            className={cn("h-4 w-4 shrink-0 text-zinc-500 transition-transform", isOpen && "rotate-90")}
                          />
                        </button>

                        {isOpen && (
                          <div className={cn("space-y-3 border-t p-3", dlg.divider)}>
                            <div className="flex flex-wrap items-center gap-2">
                              <button
                                onClick={() => markReward(r, true)}
                                className={cn("px-2 py-1 text-[11px]", dlg.control)}
                                title={t("Its images get Delete, the copies elsewhere stay")}
                              >
                                {t("Delete its copies")}
                              </button>
                              <button
                                onClick={() => markReward(r, false)}
                                className={cn("px-2 py-1 text-[11px]", dlg.control)}
                              >
                                {t("Keep all of it")}
                              </button>
                              {/* the whole reward (folder and all), asks first */}
                              <button
                                onClick={() => deleteReward(r)}
                                disabled={busy}
                                className={cn(
                                  "ml-auto inline-flex items-center gap-1.5 border border-rose-500/40 bg-rose-500/10 px-2 py-1 text-[11px] font-medium text-rose-200 transition-colors hover:bg-rose-500/20 disabled:opacity-40",
                                  sharp ? "rounded-none" : "rounded-md",
                                )}
                              >
                                <FolderX className="h-3.5 w-3.5" />
                                {t("Delete whole reward")}
                              </button>
                            </div>
                            {/* the rewards it shares pictures with, a click opens that one */}
                            {r.others.length > 0 && (
                              <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
                                <span className="text-zinc-500">{t("Looks like:")}</span>
                                {r.others.map((o) => (
                                  <button
                                    key={o.id}
                                    onClick={() => jumpTo(o.id)}
                                    className={cn("max-w-[16rem] truncate px-2 py-0.5", dlg.control)}
                                    title={o.title}
                                  >
                                    {o.title} · {o.n}
                                  </button>
                                ))}
                              </div>
                            )}
                            {r.groups.map((gi, i) =>
                              groupCard(groups[gi], gi, groupLabel(groups[gi], i + 1), r.id),
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>

        <div className={cn("flex items-center justify-between gap-3 border-t px-5 py-3.5", dlg.divider)}>
          <span className="text-xs text-zinc-500">
            {view === "rewards"
              ? t("Click a reward to see its copies · click a tile to keep/delete it. Deleting → Recycle Bin.")
              : t("Click a tile to keep/delete it · Compare to view full size. Deleting → Recycle Bin.")}
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              className={cn("px-3 py-1.5 text-sm", dlg.control)}
            >
              {t("Close")}
            </button>
            {/* delete button stays red, only the shape follows the theme */}
            <button
              onClick={() => void deleteSelected()}
              disabled={busy || selected.size === 0}
              className={cn(
                "inline-flex items-center gap-1.5 border border-rose-500/40 bg-rose-500/10 px-3 py-1.5 text-sm font-medium text-rose-200 transition-colors hover:bg-rose-500/20 disabled:opacity-40",
                sharp ? "rounded-none" : "rounded-lg",
              )}
            >
              <Trash2 className={`h-4 w-4 ${busy ? "animate-pulse" : ""}`} />
              {tf("Delete {n} selected", { n: selected.size })}
            </button>
          </div>
        </div>
      </motion.div>

      {compare && <CompareView images={compare} onClose={() => setCompare(null)} />}
    </div>
  );
}
