import { useCallback, useEffect, useState } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import { DatabaseBackup, Download, Upload, FolderOpen, History, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { useActions } from "@/actions";
import { useData } from "@/store";
import { useDialogTheme } from "@/lib/dialogTheme";
import { useAccent, toggleOnClass } from "@/lib/theme";
import { cn } from "@/lib/utils";
import { useT, useTf, useTp } from "@/lib/i18n";
import * as api from "@/api/library";

const MB = (n: number) => (n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`);

/** Default file name with date, e.g. micoll-backup-2026-06-11-1430.db */
function defaultName(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `micoll-backup-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(
    d.getHours(),
  )}${p(d.getMinutes())}.db`;
}

/**
 * Settings section to back up / restore the database (artists, tags, notes, templates,
 * covers, settings...). The media files are NOT included.
 */
export function BackupPanel({ backed, onLock }: { backed: boolean; onLock?: () => void }) {
  const t = useT();
  const tf = useTf();
  const tp = useTp();
  const { showToast } = useActions();
  const { refresh } = useData();
  const [busy, setBusy] = useState(false);
  const [confirmRestore, setConfirmRestore] = useState(false);
  const dlg = useDialogTheme();
  const cyber = useAccent() === "cyberpunk";
  // on unless it's "false"
  const [auto, setAuto] = useState(true);
  const [snaps, setSnaps] = useState<api.BackupInfo[]>([]);
  const [restoreSnap, setRestoreSnap] = useState<api.BackupInfo | null>(null);

  const loadSnaps = useCallback(async () => {
    if (!backed) return;
    try {
      const [list, flag] = await Promise.all([api.listBackups(), api.getSetting("auto_backup")]);
      setSnaps(list);
      setAuto(flag !== "false");
    } catch {
      /* just show nothing */
    }
  }, [backed]);

  useEffect(() => {
    void loadSnaps();
  }, [loadSnaps]);

  const toggleAuto = (on: boolean) => {
    setAuto(on);
    void api.setSetting("auto_backup", on ? "true" : "false");
  };

  const doRestoreSnap = async (snap: api.BackupInfo) => {
    setRestoreSnap(null);
    setBusy(true);
    try {
      await api.restoreBackup(snap.name);
      await refresh();
      showToast({
        tone: "success",
        title: tf("Restored the snapshot from {day}", { day: snap.day }),
        detail: t("MiColl was locked — sign in to continue."),
      });
      onLock?.();
    } catch (e) {
      showToast({ tone: "error", title: t("Restore failed"), detail: `${e}` });
    } finally {
      setBusy(false);
    }
  };

  const doBackup = async () => {
    if (!backed) return;
    const dest = await save({
      defaultPath: defaultName(),
      title: t("Save MiColl backup"),
      filters: [{ name: "MiColl backup", extensions: ["db"] }],
    });
    if (!dest) return;
    setBusy(true);
    try {
      await api.backupDatabase(dest);
      showToast({ tone: "success", title: t("Backup saved"), detail: dest });
    } catch (e) {
      showToast({ tone: "error", title: t("Backup failed"), detail: `${e}` });
    } finally {
      setBusy(false);
    }
  };

  const doRestore = async () => {
    setConfirmRestore(false);
    if (!backed) return;
    const src = await open({
      multiple: false,
      title: t("Choose a MiColl backup to restore"),
      filters: [{ name: "MiColl backup", extensions: ["db"] }],
    });
    if (typeof src !== "string") return;
    setBusy(true);
    try {
      await api.restoreDatabase(src);
      await refresh();
      showToast({
        tone: "success",
        title: t("Library restored"),
        detail: t("MiColl was locked — sign in to continue."),
      });
      // the restored DB may have another password/encryption, so log in again
      onLock?.();
    } catch (e) {
      showToast({ tone: "error", title: t("Restore failed"), detail: `${e}` });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <h2 className="flex items-center gap-2 settings-title text-2xl font-bold tracking-tight text-zinc-50">
        <DatabaseBackup className="h-6 w-6 text-brand-300" />
        {t("Backup DB")}
      </h2>
      <p className="settings-desc mt-1 text-sm text-zinc-400">
        {t(
          "Save or restore your library database — artists, tags, notes, templates, covers, statuses, settings, and the encryption keys.",
        )}{" "}
        <b className="text-zinc-300">{t("Your media files aren’t included")}</b>
        {t("; this protects the curation you’ve built, not the content itself.")}
      </p>

      {!backed ? (
        <div className="mt-4 rounded-xl border border-dashed border-zinc-800 bg-zinc-900/40 p-6 text-center text-sm text-zinc-400">
          {t("Backup & restore run in the desktop app.")}
        </div>
      ) : (
        <>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <Button variant="primary" onClick={doBackup} disabled={busy}>
              <Download className="h-4 w-4" />
              {t("Back up now…")}
            </Button>
            <Button variant="outline" onClick={() => setConfirmRestore(true)} disabled={busy}>
              <Upload className="h-4 w-4" />
              {t("Restore from backup…")}
            </Button>
          </div>
          <p className="settings-desc mt-3 text-xs text-zinc-500">
            {t(
              "Tip: keep a backup somewhere safe (and outside the encrypted collection). If you ever lose or reinstall MiColl, restoring this file rebuilds your whole library — pointed at the same media folders.",
            )}
          </p>

          {/* the automatic daily snapshots */}
          <div className={cn("mt-4 p-4", dlg.box)}>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h3 className="flex items-center gap-2 text-sm font-semibold text-zinc-100">
                  <History className="h-4 w-4" />
                  {t("Daily snapshot")}
                </h3>
                <p className="settings-desc mt-0.5 text-sm text-zinc-400">
                  {t(
                    "Once a day, when MiColl starts, it copies the database as the last session left it and keeps the last seven days. This is what saves you after a crash — leave it on unless you have a reason not to.",
                  )}
                </p>
              </div>
              <Toggle checked={auto} onChange={toggleAuto} />
            </div>

            {snaps.length > 0 && (
              <>
                <div className="mt-3 flex items-center justify-between gap-3">
                  <span className="text-xs text-zinc-400">
                    {tf("{snapshots} · {size} in total", {
                      snapshots: tp("{n} snapshots", snaps.length),
                      size: MB(snaps.reduce((n, s2) => n + s2.bytes, 0)),
                    })}
                  </span>
                  <button
                    onClick={() => void api.revealBackups()}
                    className={cn("flex items-center gap-1.5 px-2 py-1 text-xs", dlg.control)}
                  >
                    <FolderOpen className="h-3.5 w-3.5" />
                    {t("Show folder")}
                  </button>
                </div>
                <ul className="mt-2 max-h-56 space-y-1 overflow-y-auto">
                  {snaps.map((s2) => (
                    <li
                      key={s2.name}
                      className={cn(
                        "flex items-center justify-between gap-3 px-2.5 py-1.5",
                        cyber ? "rounded-none" : "rounded-lg",
                        dlg.soft,
                      )}
                    >
                      <span className="min-w-0 truncate text-sm text-zinc-200">{s2.day}</span>
                      <span className="shrink-0 text-xs text-zinc-500">{MB(s2.bytes)}</span>
                      <button
                        onClick={() => setRestoreSnap(s2)}
                        disabled={busy}
                        title={tf("Make the {day} snapshot the live library", { day: s2.day })}
                        className={cn(
                          "flex shrink-0 items-center gap-1.5 px-2 py-1 text-xs disabled:opacity-50",
                          dlg.control,
                        )}
                      >
                        <RotateCcw className="h-3.5 w-3.5" />
                        {t("Restore")}
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        </>
      )}

      {restoreSnap && (
        <ConfirmDialog
          title={tf("Go back to {day}?", { day: restoreSnap.day })}
          confirmLabel={t("Restore this snapshot")}
          busy={busy}
          body={
            <>
              {t("This")} <b>{t("replaces your current library database")}</b>{" "}
              {t("with the snapshot from")}{" "}
              <b>{restoreSnap.day}</b> — anything you curated since then is gone. Your media files on
              disk aren’t touched. MiColl will lock afterwards so you can sign in against the
              restored library.
            </>
          }
          onConfirm={() => void doRestoreSnap(restoreSnap)}
          onCancel={() => setRestoreSnap(null)}
        />
      )}

      {confirmRestore && (
        <ConfirmDialog
          title={t("Restore from a backup?")}
          confirmLabel={t("Choose file & restore")}
          busy={busy}
          body={
            <>
              {t("This")} <b>{t("replaces your current library database")}</b>{" "}
              {t(
                "with the chosen backup — all creators, tags, notes, templates and settings revert to that snapshot. Your media files on disk aren’t touched. MiColl will lock afterwards so you can sign in against the",
              )}
              restored library.
            </>
          }
          onConfirm={doRestore}
          onCancel={() => setConfirmRestore(false)}
        />
      )}
    </div>
  );
}

/** Simple on/off switch. */
function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  const accent = useAccent();
  return (
    <button
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={cn(
        "micoll-switch relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors",
        checked ? toggleOnClass(accent) : "bg-zinc-700",
      )}
    >
      <span
        className={cn(
          "micoll-switch-knob inline-block h-5 w-5 transform rounded-full bg-white transition-transform",
          checked ? "translate-x-5" : "translate-x-0.5",
        )}
      />
    </button>
  );
}
