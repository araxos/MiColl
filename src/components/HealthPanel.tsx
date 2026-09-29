import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { open } from "@tauri-apps/plugin-dialog";
import {
  X,
  Activity,
  Loader2,
  RefreshCw,
  Link2,
  Trash2,
  AlertTriangle,
  CheckCircle2,
  HardDriveDownload,
  User,
  Unlink,
  DatabaseBackup,
} from "lucide-react";
import {
  libraryHealth,
  relinkLibrary,
  pruneMissing,
  clearBrokenCollabs,
  type HealthReport,
} from "@/api/library";
import { useActions } from "@/actions";
import { useData } from "@/store";
import { useT, useTf, useTp } from "@/lib/i18n";

/**
 * Library health: finds images missing on disk, grouped by the folder/drive that's gone.
 * You can re-link the folder to its new location or prune the dead entries.
 */
export function HealthPanel({ onClose }: { onClose: () => void }) {
  const t = useT();
  const tf = useTf();
  const tp = useTp();
  const { showToast } = useActions();
  const { refresh } = useData();
  const [report, setReport] = useState<HealthReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [confirmPrune, setConfirmPrune] = useState(false);

  const scan = async () => {
    setLoading(true);
    try {
      setReport(await libraryHealth());
    } catch (e) {
      showToast({ tone: "error", title: t("Couldn’t scan library"), detail: `${e}` });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void scan();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const relink = async (oldPath: string) => {
    const dir = await open({ directory: true, multiple: false, title: tf("Re-link “{path}” to…", { path: oldPath }) });
    if (typeof dir !== "string") return;
    setBusy(true);
    try {
      const n = await relinkLibrary(oldPath, dir);
      await refresh();
      showToast({ tone: "success", title: tp("Re-linked {n} files", n), detail: dir });
      await scan();
    } catch (e) {
      showToast({ tone: "error", title: t("Couldn’t re-link"), detail: `${e}` });
    } finally {
      setBusy(false);
    }
  };

  const prune = async () => {
    setConfirmPrune(false);
    setBusy(true);
    try {
      const n = await pruneMissing();
      await refresh();
      showToast({ tone: "success", title: tp("Pruned {n} missing entries", n) });
      await scan();
    } catch (e) {
      showToast({ tone: "error", title: t("Couldn’t prune"), detail: `${e}` });
    } finally {
      setBusy(false);
    }
  };

  /** Only remove broken collab links (never rewards or files). */
  const dropBrokenCollabs = async () => {
    setBusy(true);
    try {
      const n = await clearBrokenCollabs();
      await refresh();
      showToast({
        tone: "success",
        title: tp("Removed {n} broken collab links", n),
      });
      await scan();
    } catch (e) {
      showToast({ tone: "error", title: t("Couldn’t remove the links"), detail: `${e}` });
    } finally {
      setBusy(false);
    }
  };

  const healthy =
    report &&
    report.missing === 0 &&
    report.brokenCollabs.length === 0 &&
    report.orphanBackups.length === 0;

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      onClick={onClose}
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
    >
      <motion.div
        initial={{ scale: 0.96, opacity: 0, y: 8 }}
        animate={{ scale: 1, opacity: 1, y: 0 }}
        exit={{ scale: 0.96, opacity: 0, y: 8 }}
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[85vh] w-[38rem] max-w-[94vw] flex-col overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-900 shadow-2xl"
      >
        <div className="flex items-center justify-between border-b border-zinc-800 px-5 py-3">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-zinc-100">
            <Activity className="h-4 w-4 text-brand-300" />
            {t("Library health")}
          </h2>
          <div className="flex items-center gap-1">
            <button
              onClick={() => void scan()}
              disabled={loading || busy}
              title={t("Re-scan")}
              className="rounded-lg p-1.5 text-zinc-400 micoll-hover hover:text-zinc-200 disabled:opacity-40"
            >
              <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
            </button>
            <button onClick={onClose} className="rounded-lg p-1.5 text-zinc-500 hover:text-zinc-300" title={t("Close (Esc)")}>
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {loading ? (
            <div className="flex h-32 flex-col items-center justify-center gap-3 text-zinc-400">
              <Loader2 className="h-6 w-6 animate-spin text-brand-400" />
              <p className="text-sm">{t("Checking every file…")}</p>
            </div>
          ) : !report ? (
            <p className="py-8 text-center text-sm text-zinc-500">{t("Couldn’t read the library.")}</p>
          ) : healthy ? (
            <div className="flex flex-col items-center justify-center gap-3 py-10 text-center">
              <CheckCircle2 className="h-10 w-10 text-emerald-400" />
              <p className="text-sm font-medium text-zinc-100">{t("Everything’s in place")}</p>
              <p className="text-xs text-zinc-500">
                {tf("Checked {files} — none missing.", {
                  files: tp("{n} files", report.checked),
                })}
                {report.sdOffline > 0 && (
                  <>
                    {" "}
                    {tf("({n} on the unplugged MiSD disk — safe, not counted as missing.)", {
                      n: report.sdOffline.toLocaleString(),
                    })}
                  </>
                )}
              </p>
            </div>
          ) : (
            <>
              {report.missing > 0 && (
                <div className="mb-4 flex items-center gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-sm text-amber-200">
                  <AlertTriangle className="h-4 w-4 shrink-0" />
                  <span>
                    {tf("{missing} of {checked} files are missing on disk.", {
                      missing: report.missing.toLocaleString(),
                      checked: report.checked.toLocaleString(),
                    })}
                    {report.sdOffline > 0 && (
                      <>
                        {" "}
                        {tf(
                          "({n} more are on the unplugged MiSD disk — those are safe and not counted.)",
                          { n: report.sdOffline.toLocaleString() },
                        )}
                      </>
                    )}
                  </span>
                </div>
              )}

              {/* collab links to folders that don't exist anymore (moved outside MiColl) */}
              {report.brokenCollabs.length > 0 && (
                <div className="mb-4 rounded-xl border border-violet-500/30 bg-violet-500/10 p-3">
                  <div className="flex items-center gap-2 text-sm text-violet-200">
                    <Unlink className="h-4 w-4 shrink-0" />
                    <span>
                      {tp(
                        "{n} collab links point at a folder that no longer exists — most likely renamed or moved outside MiColl.",
                        report.brokenCollabs.length,
                      )}
                    </span>
                  </div>
                  <div className="mt-2 max-h-32 space-y-1 overflow-y-auto">
                    {report.brokenCollabs.map((c) => (
                      <div
                        key={`${c.rewardId}-${c.partnerName}`}
                        className="rounded-lg bg-zinc-950/40 px-2.5 py-1.5 text-xs"
                        title={c.folderPath}
                      >
                        <span className="text-zinc-200">“{c.title}”</span>{" "}
                        <span className="text-zinc-500">
                          — {c.ownerName} → {c.partnerName}
                        </span>
                      </div>
                    ))}
                  </div>
                  <div className="mt-2 flex items-center justify-between gap-2">
                    <p className="text-xs text-zinc-500">
                      {t("Removing a link never touches a reward or a file.")}
                    </p>
                    <button
                      onClick={() => void dropBrokenCollabs()}
                      disabled={busy}
                      className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-violet-500/40 bg-violet-500/10 px-2.5 py-1.5 text-xs font-medium text-violet-200 transition-colors hover:bg-violet-500/20 disabled:opacity-40"
                    >
                      <Unlink className="h-3.5 w-3.5" />
                      {t("Remove broken links")}
                    </button>
                  </div>
                </div>
              )}

              {/* MiSD backup folders nothing points to anymore. Only listed, never deleted
                  automatically. */}
              {report.orphanBackups.length > 0 && (
                <div className="mb-4 rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-3">
                  <div className="flex items-center gap-2 text-sm text-emerald-200">
                    <DatabaseBackup className="h-4 w-4 shrink-0" />
                    <span>
                      {tp(
                        "{n} MiSD backup folders no longer belong to a reward — kept on purpose when the reward was deleted here.",
                        report.orphanBackups.length,
                      )}
                    </span>
                  </div>
                  <div className="mt-2 max-h-32 space-y-1 overflow-y-auto">
                    {report.orphanBackups.map((p) => (
                      <div
                        key={p}
                        className="truncate rounded-lg bg-zinc-950/40 px-2.5 py-1.5 text-xs text-zinc-300"
                        title={p}
                      >
                        {p}
                      </div>
                    ))}
                  </div>
                  <p className="mt-2 text-xs text-zinc-500">
                    {t(
                      "MiColl won’t delete these. Remove them in your file manager if you want the space back.",
                    )}
                  </p>
                </div>
              )}

              {/* broken roots */}
              {report.brokenRoots.length > 0 && (
                <>
                  <div className="mb-2 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-zinc-500">
                    <HardDriveDownload className="h-3.5 w-3.5" />
                    {t("Missing folders — reconnect the drive, or re-link if moved")}
                  </div>
                  <div className="mb-4 space-y-2">
                    {report.brokenRoots.map((r) => (
                      <div
                        key={r.path}
                        className="flex items-center gap-2 rounded-xl border border-zinc-800 bg-zinc-950/40 p-2.5"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm text-zinc-200" title={r.path}>
                            {r.path}
                          </div>
                          <div className="text-xs text-zinc-500">
                            {tp("{n} files", r.count)}
                          </div>
                        </div>
                        <button
                          onClick={() => void relink(r.path)}
                          disabled={busy}
                          title={t("Point this folder at its new location")}
                          className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-brand-500/40 bg-brand-500/10 px-2.5 py-1.5 text-xs font-medium text-brand-200 transition-colors hover:bg-brand-500/20 disabled:opacity-40"
                        >
                          <Link2 className="h-3.5 w-3.5" />
                          {t("Re-link…")}
                        </button>
                      </div>
                    ))}
                  </div>
                </>
              )}

              {/* affected artists */}
              {report.artists.length > 0 && (
                <>
                  <div className="mb-2 text-xs font-medium uppercase tracking-wide text-zinc-500">
                    {t("Affected creators")}
                  </div>
                  <div className="max-h-48 space-y-1 overflow-y-auto">
                    {report.artists.map((a) => (
                      <div
                        key={a.id}
                        className="flex items-center gap-2 rounded-lg bg-zinc-950/40 px-2.5 py-1.5 text-sm"
                      >
                        <User className="h-4 w-4 shrink-0 text-zinc-500" />
                        <span className="min-w-0 flex-1 truncate text-zinc-200">{a.name}</span>
                        <span className="shrink-0 rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] tabular-nums text-zinc-400">
                          {a.missing} missing
                        </span>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </>
          )}
        </div>

        {/* only about missing files, collab links have their own button */}
        {report && report.missing > 0 && !loading && (
          <div className="flex items-center justify-between gap-2 border-t border-zinc-800 px-5 py-3">
            <p className="text-xs text-zinc-500">
              {t("Pruning removes the database entries for files that are truly gone.")}
            </p>
            <button
              onClick={() => setConfirmPrune(true)}
              disabled={busy}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium text-rose-300 transition-colors hover:bg-rose-500/10 hover:text-rose-200 disabled:opacity-40"
            >
              <Trash2 className="h-4 w-4" />
              {t("Prune missing…")}
            </button>
          </div>
        )}
      </motion.div>

      {/* prune confirmation */}
      {confirmPrune && (
        <div
          className="fixed inset-0 z-[80] flex items-center justify-center bg-black/70 p-4"
          onClick={(e) => {
            e.stopPropagation();
            setConfirmPrune(false);
          }}
        >
          <motion.div
            initial={{ scale: 0.96, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            onClick={(e) => e.stopPropagation()}
            className="w-[24rem] max-w-full overflow-hidden rounded-2xl border border-rose-500/30 bg-zinc-900 shadow-2xl"
          >
            <div className="flex items-center gap-2 border-b border-zinc-800 px-5 py-3">
              <AlertTriangle className="h-4 w-4 text-rose-400" />
              <h3 className="text-sm font-semibold text-zinc-100">{t("Prune missing files?")}</h3>
            </div>
            <div className="px-5 py-4 text-sm text-zinc-300">
              {t(
                "This removes MiColl’s database entries for files that no longer exist on disk. Your actual files aren’t touched (there are none to touch). Only do this if the files are truly gone — not just on an unplugged drive.",
              )}
            </div>
            <div className="flex justify-end gap-2 border-t border-zinc-800 px-5 py-3">
              <button
                onClick={() => setConfirmPrune(false)}
                className="rounded-lg px-3 py-2 text-sm text-zinc-300 micoll-hover"
              >
                {t("Cancel")}
              </button>
              <button
                onClick={() => void prune()}
                className="inline-flex items-center gap-1.5 rounded-lg bg-rose-600 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-rose-500"
              >
                <Trash2 className="h-4 w-4" />
                {t("Prune")}
              </button>
            </div>
          </motion.div>
        </div>
      )}
    </motion.div>
  );
}
