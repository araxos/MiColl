import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { motion } from "framer-motion";
import { listen } from "@tauri-apps/api/event";
import { Check, Download, Eraser, Loader2, RotateCcw, Search, Square, Stamp, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { ModelDownloadDialog } from "@/components/ModelDownloadDialog";
import { WatermarkMark, type MarkState } from "@/components/WatermarkMark";
import { useDialogTheme } from "@/lib/dialogTheme";
import { useAccent } from "@/lib/theme";
import { cn } from "@/lib/utils";
import { useT, useTf } from "@/lib/i18n";
import { isTauri } from "@/lib/tauri";
import {
  WATERMARK_EVENT,
  WM_CORNERS as CORNERS,
  savedWmCorners,
  savedWmMode,
  saveWmCorners,
  saveWmMode,
  type WatermarkTarget,
  type WmMode as Mode,
} from "@/lib/watermark";
import { useData } from "@/store";
import * as api from "@/api/library";

/** How many pictures the preview shows. */
const PREVIEW_N = 6;

/** 3:05 / 1:02:05 */
function clock(sec: number): string {
  const s = Math.max(1, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${r}` : `${m}:${r}`;
}

/** Bar with "a of b" and about how long is left (from the speed so far). */
function Progress({ p, label }: { p: api.WmProgress | null; label: string }) {
  const t = useT();
  const tf = useTf();
  const dlg = useDialogTheme();
  const sharp = useAccent() === "cyberpunk";
  const start = useRef<{ phase: string; at: number; done: number } | null>(null);
  const [eta, setEta] = useState<number | null>(null);
  useEffect(() => {
    if (!p) return;
    const now = performance.now();
    const st = start.current;
    if (!st || st.phase !== p.phase) {
      start.current = { phase: p.phase, at: now, done: p.done };
      setEta(null);
      return;
    }
    const secs = (now - st.at) / 1000;
    const did = p.done - st.done;
    if (secs > 1.5 && did > 0) {
      const left = ((p.total - p.done) / did) * secs;
      setEta((old) => (old == null ? left : old * 0.6 + left * 0.4));
    }
  }, [p]);
  const pct = p && p.total > 0 ? Math.min(100, (p.done / p.total) * 100) : 0;
  return (
    <div className="mx-auto flex max-w-sm flex-col items-center py-10 text-zinc-400">
      <Loader2 className={cn("h-8 w-8 animate-spin", dlg.accentText)} />
      <p className="mt-3 text-sm text-zinc-300">{label}</p>
      <div className={cn("mt-4 h-1.5 w-full overflow-hidden", dlg.field, sharp ? "rounded-none" : "rounded-full")}>
        <div className={cn("h-full transition-[width] duration-200", dlg.accent)} style={{ width: `${pct}%` }} />
      </div>
      <div className="mt-1.5 flex w-full justify-between text-[11px] tabular-nums text-zinc-500">
        <span>{p && p.total > 0 ? tf("{done} of {total}", { done: p.done, total: p.total }) : ""}</span>
        <span>
          {p && p.total > 0 && p.done < p.total
            ? eta == null
              ? t("Estimating time…")
              : eta < 5
                ? t("Almost done")
                : tf("About {time} left", { time: clock(eta) })
            : ""}
        </span>
      </div>
    </div>
  );
}

type Step = "setup" | "scanning" | "preview" | "running" | "done";

/**
 * "Remove watermark" for a whole reward: a line of text in a corner, or a mark framed once
 * on one picture (WatermarkMark), is found in every picture, a preview shows 4-6 of them before/after with a tick each, then all go
 * with progress and Stop. Each result is a version of its picture (the original stays),
 * Undo switches them back.
 */
export function WatermarkDialog({ rewardId, label, onClose }: { rewardId: number; label: string; onClose: () => void }) {
  const t = useT();
  const tf = useTf();
  const dlg = useDialogTheme();
  const { refresh } = useData();
  const [step, setStep] = useState<Step>("setup");
  const [corners, setCorners] = useState<string[]>(savedWmCorners);
  const [mode, setModeState] = useState<Mode>(savedWmMode);
  // mode "mark": the mark as framed and touched up
  const [mark, setMark] = useState<MarkState | null>(null);
  const setMode = (m: Mode) => {
    setModeState(m);
    saveWmMode(m);
  };
  const [model, setModel] = useState<api.AiModelStatus | null>(null);
  const [askModel, setAskModel] = useState(false);
  const [dl, setDl] = useState<{ done: number; total: number } | null>(null);
  const [scan, setScan] = useState<api.WmScan | null>(null);
  const [progress, setProgress] = useState<api.WmProgress | null>(null);
  const [previews, setPreviews] = useState<Record<string, { before: string; after: string } | "error">>({});
  // the pictures the preview shows
  const [picks, setPicks] = useState<api.WmItem[]>([]);
  // pictures left out (unticked in the preview)
  const [off, setOff] = useState<Set<string>>(new Set());
  const [result, setResult] = useState<{ done: number; failed: string[]; stopped: boolean } | null>(null);
  const [undone, setUndone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const job = useRef(0);
  const busy = step === "scanning" || step === "running";

  // the remover's model, and its download progress
  useEffect(() => {
    if (!isTauri()) return;
    void api.aiModelStatus("lama").then(setModel).catch(() => {});
    let alive = true;
    let un: (() => void) | undefined;
    void listen<{ model?: string; done: number; total: number; ready?: boolean }>("ai-model-progress", (e) => {
      if ((e.payload.model ?? "lama") !== "lama") return;
      if (e.payload.ready) {
        setDl(null);
        void api.aiModelStatus("lama").then(setModel).catch(() => {});
      } else setDl({ done: e.payload.done, total: e.payload.total });
    }).then((f) => (alive ? (un = f) : f()));
    return () => {
      alive = false;
      un?.();
    };
  }, []);

  // progress of this window's job
  useEffect(() => {
    let alive = true;
    let un: (() => void) | undefined;
    void listen<api.WmProgress>("wm-progress", (e) => {
      if (e.payload.job === job.current) setProgress(e.payload);
    }).then((f) => (alive ? (un = f) : f()));
    return () => {
      alive = false;
      un?.();
    };
  }, []);

  // closing stops what runs and forgets the job
  useEffect(
    () => () => {
      if (job.current) {
        void api.wmStop().catch(() => {});
        void api.wmClose(job.current).catch(() => {});
      }
    },
    [],
  );

  const close = () => {
    if (busy) void api.wmStop().catch(() => {});
    onClose();
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || askModel) return;
      e.stopPropagation();
      close();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  const toggleCorner = (id: string) =>
    setCorners((c) => {
      const next = c.includes(id) ? c.filter((x) => x !== id) : [...c, id];
      saveWmCorners(next);
      return next;
    });

  const downloadModel = async () => {
    setDl({ done: 0, total: 0 });
    try {
      await api.aiModelDownload("lama");
      setModel(await api.aiModelStatus("lama"));
    } catch (e) {
      setError(`${t("Model download failed")} — ${e}`);
    } finally {
      setDl(null);
    }
  };

  /** Search (the corners, or for the framed mark), then preview a few pictures one by one. */
  const runScan = async () => {
    setError(null);
    if (job.current) void api.wmClose(job.current).catch(() => {});
    job.current = Math.floor(Math.random() * 1e15) + 1;
    setProgress(null);
    setPreviews({});
    setOff(new Set());
    setStep("scanning");
    let s: api.WmScan;
    try {
      s =
        mode === "mark" && mark
          ? await api.wmScanMark(
              rewardId,
              { path: mark.path, x: mark.frame.x, y: mark.frame.y, mask: mark.mask(), stroke: mark.stroke },
              job.current,
            )
          : await api.wmScan(rewardId, corners, job.current);
    } catch (e) {
      setStep("setup");
      if (`${e}` !== "stopped") setError(`${e}`);
      return;
    }
    setScan(s);
    setStep("preview");
    // the unsure ones first (off until ticked), then spread over the reward: the first,
    // the last and some between
    const unsure = s.items.filter((i) => i.unsure);
    const sure = s.items.filter((i) => !i.unsure);
    setOff(new Set(unsure.map((i) => i.id)));
    const n = Math.min(PREVIEW_N, sure.length);
    const chosen = [
      ...unsure,
      ...new Set(Array.from({ length: n }, (_, i) => sure[Math.round((i * (sure.length - 1)) / Math.max(1, n - 1))])),
    ];
    setPicks(chosen);
    const mine = job.current;
    for (const it of chosen) {
      if (job.current !== mine) return;
      try {
        const p = await api.wmPreview(mine, it.id);
        setPreviews((v) => ({ ...v, [it.id]: p }));
      } catch {
        setPreviews((v) => ({ ...v, [it.id]: "error" }));
      }
    }
  };

  const picked = scan ? scan.items.filter((i) => !off.has(i.id)) : [];

  const runApply = async () => {
    if (!picked.length) return;
    setError(null);
    setProgress(null);
    setStep("running");
    try {
      const r = await api.wmApply(job.current, picked.map((i) => i.id));
      setResult(r);
      setStep("done");
      await refresh();
    } catch (e) {
      setError(`${e}`);
      setStep("preview");
    }
  };

  const undo = async () => {
    try {
      await api.wmUndo(job.current);
      setUndone(true);
      await refresh();
    } catch (e) {
      setError(`${e}`);
    }
  };

  const ready = model?.ready === true;

  return createPortal(
    <div className="fixed inset-0 z-[125] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm" data-drop-block="">
      <motion.div
        initial={{ opacity: 0, y: 12, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        className={cn(
          "flex max-h-[92vh] max-w-full flex-col overflow-hidden",
          mode === "mark" && step === "setup" ? "w-[60rem]" : "w-[46rem]",
          dlg.panel,
        )}
      >
        <div className={cn("flex items-center justify-between border-b px-5 py-3.5", dlg.divider)}>
          <div className="min-w-0">
            <h2 className="flex items-center gap-2 text-base font-semibold text-zinc-100">
              <Stamp className={cn("h-4 w-4", dlg.accentText)} />
              {t("Remove watermark")}
            </h2>
            <p className="truncate text-xs text-zinc-500">{label}</p>
          </div>
          <button onClick={close} className="text-zinc-500 hover:text-zinc-300" title={t("Close (Esc)")}>
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {error && <p className={cn("mb-3 px-3 py-2 text-xs text-rose-200", dlg.box)}>{error}</p>}

          {step === "setup" && (
            <div className={cn("space-y-4", mode === "mark" && "mb-4")}>
              {/* which kind of watermark */}
              <div className="flex flex-wrap gap-1.5">
                {(
                  [
                    ["corner", t("Text in a corner")],
                    ["mark", t("Same mark anywhere")],
                  ] as [Mode, string][]
                ).map(([id, name]) => (
                  <button
                    key={id}
                    onClick={() => setMode(id)}
                    className={cn("px-3 py-1.5 text-xs font-medium", mode === id ? dlg.controlOn : dlg.control)}
                  >
                    {name}
                  </button>
                ))}
              </div>
              <p className="text-sm text-zinc-300">
                {mode === "corner"
                  ? t(
                      "Finds a line of text (like a link) in a corner of every picture of this reward and removes it. You see a preview first; each result is saved as a version, the originals stay.",
                    )
                  : t(
                      "For a mark (a logo, a signature) that sits somewhere else on every picture, bigger or smaller, dark or light: frame it once, it's looked for on all pictures. You see a preview first; the originals stay.",
                    )}
              </p>
              {mode === "corner" && (
              <div>
                <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-zinc-500">{t("Where is it?")}</div>
                <div className="flex items-start gap-4">
                  {/* the picture with the chosen areas */}
                  <div className={cn("relative h-24 w-36 shrink-0 border", dlg.divider, dlg.soft)}>
                    {corners.map((c) => (
                      <span
                        key={c}
                        className={cn(
                          "absolute h-[15%] bg-current opacity-60",
                          dlg.accentText,
                          c === "bc" ? "left-[30%] w-[40%]" : "w-[30%]",
                          c === "tl" || c === "bl" ? "left-0" : c === "bc" ? "" : "right-0",
                          c === "tl" || c === "tr" ? "top-0" : "bottom-0",
                        )}
                      />
                    ))}
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {CORNERS.map((c) => (
                      <button
                        key={c.id}
                        onClick={() => toggleCorner(c.id)}
                        className={cn("px-2.5 py-1 text-xs", corners.includes(c.id) ? dlg.controlOn : dlg.control)}
                      >
                        {t(c.label)}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
              )}
              {model && !ready && (
                <div className={cn("flex items-center gap-3 px-3 py-2.5", dlg.box)}>
                  <p className="flex-1 text-xs text-zinc-300">
                    {t("The remover uses the local AI model (LaMa). It’s downloaded once, nothing leaves your PC.")}
                  </p>
                  <Button variant="primary" className={dlg.primary} onClick={() => setAskModel(true)} disabled={!!dl}>
                    <Download className="h-4 w-4" />
                    {dl
                      ? dl.total > 0
                        ? tf("Downloading… {pct}%", { pct: Math.round((dl.done / dl.total) * 100) })
                        : t("Downloading…")
                      : t("Get AI model (~200 MB)")}
                  </Button>
                </div>
              )}
            </div>
          )}

          {/* stays mounted while searching, so "Search again" comes back to the same mark */}
          {mode === "mark" && (
            <div className={cn(step !== "setup" && "hidden")}>
              <WatermarkMark rewardId={rewardId} onChange={setMark} />
            </div>
          )}

          {step === "scanning" && (
            <Progress
              p={progress}
              label={
                mode === "mark"
                  ? t("Looking for the mark on every picture…")
                  : progress?.phase === "check"
                    ? t("Checking the other pictures…")
                    : t("Looking for text in the corners…")
              }
            />
          )}

          {step === "preview" && scan && (
            <div className="space-y-3">
              <p className="text-sm text-zinc-300">
                {scan.items.length === 0
                  ? t("No watermark found in the chosen corners.")
                  : tf("Found in {n} of {total} pictures.", { n: scan.items.length, total: scan.pictures })}{" "}
                {scan.shared && (
                  <span className="text-zinc-400">
                    {tf("The watermark was taken from the clearest picture ({name}) and laid onto the others.", {
                      name: scan.templateFrom ?? "?",
                    })}
                  </span>
                )}
              </p>
              {scan.missed.length > 0 && (
                <p className="text-xs text-amber-200" title={scan.missed.join("\n")}>
                  {tf("Not found on: {names}", {
                    names: scan.missed.slice(0, 6).join(", ") + (scan.missed.length > 6 ? " …" : ""),
                  })}
                </p>
              )}
              {scan.skipped > 0 && (
                <p className="text-xs text-zinc-500">{tf("Skipped (videos, GIFs, other files): {n}", { n: scan.skipped })}</p>
              )}
              {scan.items.length > 0 && (
                <>
                  <p className="text-xs text-zinc-500">
                    {t("A few of them before and after. Untick one to leave it as it is.")}
                  </p>
                  <div className="grid grid-cols-2 gap-3">
                    {picks.map((it) => {
                        const p = previews[it.id];
                        const on = !off.has(it.id);
                        return (
                          <div key={it.id} className={cn("overflow-hidden p-2", dlg.box)}>
                            <div className="mb-1.5 flex items-center justify-between gap-2">
                              <span className="truncate text-[11px] text-zinc-400" title={it.path}>
                                {it.path.split(/[\\/]/).pop()}
                              </span>
                              <button
                                onClick={() =>
                                  setOff((s) => {
                                    const n = new Set(s);
                                    if (n.has(it.id)) n.delete(it.id);
                                    else n.add(it.id);
                                    return n;
                                  })
                                }
                                className={cn("flex h-5 w-5 shrink-0 items-center justify-center", on ? dlg.controlOn : dlg.control)}
                                title={on ? t("Leave this one as it is") : t("Remove it here too")}
                              >
                                {on && <Check className="h-3.5 w-3.5" />}
                              </button>
                            </div>
                            {it.guessed && (
                              <p className="mb-1 text-[10px] text-amber-200">{t("Found through the other pictures")}</p>
                            )}
                            {it.unsure && (
                              <p className="mb-1 text-[10px] text-amber-200">
                                {t("Not sure it’s the mark — tick it if it is")}
                              </p>
                            )}
                            {p === undefined ? (
                              <div className="grid h-28 place-items-center">
                                <Loader2 className={cn("h-5 w-5 animate-spin", dlg.accentText)} />
                              </div>
                            ) : p === "error" ? (
                              <p className="py-6 text-center text-xs text-rose-300">{t("Couldn’t make the preview")}</p>
                            ) : (
                              <div className={cn("space-y-1", !on && !it.unsure && "opacity-40")}>
                                {[
                                  [p.before, t("Before")],
                                  [p.after, t("After")],
                                ].map(([src, tag]) => (
                                  <div key={tag} className="relative">
                                    <img src={src} alt="" className="w-full rounded" />
                                    <span className="absolute left-1 top-1 rounded bg-black/70 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white">
                                      {tag}
                                    </span>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        );
                      })}
                  </div>
                </>
              )}
            </div>
          )}

          {step === "running" && <Progress p={progress} label={t("Removing the watermark…")} />}

          {step === "done" && result && (
            <div className="space-y-3 py-4 text-center">
              <Check className={cn("mx-auto h-8 w-8", dlg.accentText)} />
              <p className="text-sm text-zinc-200">
                {undone
                  ? t("Undone — the pictures show what they showed before.")
                  : tf("Removed from {n} pictures. Each is a version, the originals stay.", { n: result.done })}
              </p>
              {result.stopped && !undone && <p className="text-xs text-zinc-400">{t("Stopped — the rest stays as it was.")}</p>}
              {result.failed.length > 0 && (
                <p className={cn("whitespace-pre-line px-3 py-2 text-left text-xs text-rose-200", dlg.box)}>
                  {result.failed.join("\n")}
                </p>
              )}
            </div>
          )}
        </div>

        <div className={cn("flex items-center justify-end gap-2 border-t px-5 py-3", dlg.divider)}>
          {step === "setup" && (
            <>
              <Button variant="ghost" onClick={close}>
                {t("Close")}
              </Button>
              <Button
                variant="primary"
                className={dlg.primary}
                onClick={() => void runScan()}
                disabled={!ready || (mode === "mark" ? !mark : !corners.length)}
              >
                <Search className="h-4 w-4" />
                {t("Search")}
              </Button>
            </>
          )}
          {busy && (
            <Button variant="ghost" onClick={() => void api.wmStop()}>
              <Square className="h-4 w-4" />
              {t("Stop")}
            </Button>
          )}
          {step === "preview" && (
            <>
              <Button variant="ghost" onClick={() => setStep("setup")}>
                {t("Search again")}
              </Button>
              <Button variant="primary" className={dlg.primary} onClick={() => void runApply()} disabled={!picked.length}>
                <Eraser className="h-4 w-4" />
                {tf("Remove from {n} pictures", { n: picked.length })}
              </Button>
            </>
          )}
          {step === "done" && (
            <>
              {!undone && result && result.done > 0 && (
                <Button variant="ghost" onClick={() => void undo()}>
                  <RotateCcw className="h-4 w-4" />
                  {t("Undo")}
                </Button>
              )}
              <Button variant="primary" className={dlg.primary} onClick={close}>
                {t("Close")}
              </Button>
            </>
          )}
        </div>
      </motion.div>

      {askModel && (
        <ModelDownloadDialog
          model="lama"
          info={model ?? undefined}
          onConfirm={() => {
            setAskModel(false);
            void downloadModel();
          }}
          onCancel={() => setAskModel(false)}
        />
      )}
    </div>,
    document.body,
  );
}

/** Listens for openWatermark() and shows the window (mounted once per window). */
export function WatermarkHost() {
  const [target, setTarget] = useState<{ rewardId: number; label: string } | null>(null);
  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent<WatermarkTarget>).detail ?? {};
      if (d.rewardId != null) {
        setTarget({ rewardId: d.rewardId, label: d.label ?? "" });
      } else if (d.imagePath) {
        void api
          .wmRewardOf(d.imagePath)
          .then((r) => r && setTarget({ rewardId: r[0], label: r[1] }))
          .catch(() => {});
      }
    };
    window.addEventListener(WATERMARK_EVENT, on);
    return () => window.removeEventListener(WATERMARK_EVENT, on);
  }, []);
  if (!target) return null;
  return <WatermarkDialog rewardId={target.rewardId} label={target.label} onClose={() => setTarget(null)} />;
}
