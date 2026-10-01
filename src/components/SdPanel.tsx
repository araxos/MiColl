import { useCallback, useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import {
  HardDrive,
  FolderOpen,
  Truck,
  Undo2,
  Plug,
  Unplug,
  RefreshCw,
  DatabaseBackup,
  Image as ImageIcon,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { ProgressModal } from "@/components/ProgressModal";
import { SdQueuedCreators } from "@/components/SdQueuedCreators";
import { useActions } from "@/actions";
import { useT, useTf, useTp } from "@/lib/i18n";
import { useData } from "@/store";
import { toggleOnClass, useAccent } from "@/lib/theme";
import { cn } from "@/lib/utils";
import * as api from "@/api/library";

/** sd-progress event, one tick per reward. */
type SdProgress = {
  phase: "transport" | "return" | "backup";
  done: number;
  total: number;
  item: string;
};

/**
 * Settings section for MiSD (external disk). Pick a folder on it (a marker file
 * identifies it even if the drive letter changes), see the queue and if the disk is
 * connected, then Transport (move to free space) or Back up (copy, keep local files).
 */
export function SdPanel({ backed }: { backed: boolean }) {
  const t = useT();
  const tf = useTf();
  const tp = useTp();
  const { showToast } = useActions();
  const { refresh } = useData();
  // light frosted surfaces on iridescent
  const irid = useAccent() === "iridescent";
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<api.SdStatus | null>(null);
  // creators each queue would touch (shown in the confirmation)
  const [who, setWho] = useState<api.SdQueuedCreator[]>([]);
  const [label, setLabel] = useState("");
  const [confirmTransport, setConfirmTransport] = useState(false);
  const [confirmReturn, setConfirmReturn] = useState(false);
  const [confirmBackup, setConfirmBackup] = useState(false);
  // live progress for the blocking overlay
  const [prog, setProg] = useState<SdProgress | null>(null);

  const reloadStatus = useCallback(async () => {
    if (!backed) return;
    try {
      const [s, w] = await Promise.all([api.sdStatus(), api.sdQueuedCreators()]);
      setStatus(s);
      setWho(w);
      if (s.label) setLabel(s.label);
    } catch {
      /* not fatal, the panel shows "not set up" */
    }
  }, [backed]);

  useEffect(() => {
    void reloadStatus();
  }, [reloadStatus]);

  // progress per reward (see sd.rs)
  useEffect(() => {
    // only ticks for the job this panel started
    const un = listen<SdProgress>("sd-progress", (e) =>
      setProg((cur) => (cur && cur.phase === e.payload.phase ? e.payload : cur)),
    );
    return () => {
      void un.then((f) => f());
    };
  }, []);

  const chooseFolder = async () => {
    const picked = await open({
      directory: true,
      multiple: false,
      title: t("Choose the MiSD folder on your external disk"),
    });
    if (typeof picked !== "string") return;
    setBusy(true);
    try {
      const s = await api.sdSetup(picked, label.trim() || "MiSD");
      setStatus(s);
      showToast({ tone: "success", title: t("MiSD disk ready"), detail: picked });
    } catch (e) {
      showToast({ tone: "error", title: t("MiSD setup failed"), detail: `${e}` });
    } finally {
      setBusy(false);
    }
  };

  const summarize = (verb: string, s: api.SdSummary, detail?: string) =>
    showToast(
      s.cancelled
        ? {
            tone: "warn",
            title: tf("MiSD: stopped after {rewards}", { rewards: tp("{n} rewards", s.moved) }),
            detail: t("The rest is still queued — nothing was left half-finished."),
          }
        : s.failed
        ? {
            tone: "warn",
            title: tf("MiSD: {verb} {moved}, {failed} failed", {
              verb: t(verb),
              moved: s.moved,
              failed: s.failed,
            }),
            detail: s.errors.slice(0, 3).join(" · "),
          }
        : {
            tone: "success",
            title: tf("MiSD: {verb} {rewards}", {
              verb: t(verb),
              rewards: tp("{n} rewards", s.moved),
            }),
            detail:
              detail ??
              t("Every file was copied and hash-verified before the original was removed."),
          },
    );

  const doTransport = async () => {
    setConfirmTransport(false);
    setBusy(true);
    setProg({ phase: "transport", done: 0, total: status?.marked ?? 0, item: "" });
    try {
      const s = await api.sdTransport();
      summarize("transported", s);
      await Promise.all([refresh(), reloadStatus()]);
    } catch (e) {
      showToast({ tone: "error", title: t("Transport failed"), detail: `${e}` });
    } finally {
      setBusy(false);
      setProg(null);
    }
  };

  const doBackup = async () => {
    setConfirmBackup(false);
    setBusy(true);
    setProg({ phase: "backup", done: 0, total: status?.backupMarked ?? 0, item: "" });
    try {
      const s = await api.sdBackupNow();
      summarize("backed up", s, "The local files were left exactly where they were.");
      await Promise.all([refresh(), reloadStatus()]);
    } catch (e) {
      showToast({ tone: "error", title: t("Backup failed"), detail: `${e}` });
    } finally {
      setBusy(false);
      setProg(null);
    }
  };

  // keep offline previews on transport. Applied right away, reverted if saving fails
  const setPreviews = async (v: boolean) => {
    setStatus((s) => (s ? { ...s, previews: v } : s));
    try {
      await api.setSetting("sd_previews", v ? "1" : "0");
    } catch (e) {
      showToast({ tone: "error", title: t("Couldn’t save that setting"), detail: `${e}` });
      await reloadStatus();
    }
  };

  const doReturnAll = async () => {
    setConfirmReturn(false);
    setBusy(true);
    setProg({ phase: "return", done: 0, total: status?.transported ?? 0, item: "" });
    try {
      const s = await api.sdReturn();
      summarize("brought back", s);
      await Promise.all([refresh(), reloadStatus()]);
    } catch (e) {
      showToast({ tone: "error", title: t("Bring back failed"), detail: `${e}` });
    } finally {
      setBusy(false);
      setProg(null);
    }
  };

  const st = status;
  return (
    <div>
      <h2 className="flex items-center gap-2 settings-title text-2xl font-bold tracking-tight text-zinc-50">
        <HardDrive className="h-6 w-6 text-brand-300" />
        MiSD
      </h2>
      <p className="settings-desc mt-1 text-sm text-zinc-400">
        {t("One external disk, two jobs — right-click a creator, month or reward to queue either.")}
        <br />
        <b className="text-zinc-300">{t("Move to MiSD")}</b>{" "}
        {t("frees space here: the files go to the disk and the reward keeps its preview and a")}{" "}
        <HardDrive className="inline h-3.5 w-3.5 -translate-y-px text-sky-300" />{" "}
        {t("mark, but needs the disk connected to open.")}
        <br />
        <b className="text-zinc-300">{t("Back up to MiSD")}</b>{" "}
        {t("changes nothing here: a copy goes to the disk, the reward stays fully local and gets a")}{" "}
        <DatabaseBackup className="inline h-3.5 w-3.5 -translate-y-px text-emerald-300" />{" "}
        {t("mark.")}
        <br />
        {t("Either way every file is")}{" "}
        <b className="text-zinc-300">{t("SHA-256-verified")}</b>{" "}
        {t(
          "after copying — nothing gets lost, nothing is re-encoded, and a transport only deletes the original once the copy checks out.",
        )}
      </p>

      {!backed ? (
        <div className="mt-4 rounded-xl border border-dashed border-zinc-800 bg-zinc-900/40 p-6 text-center text-sm text-zinc-400">
          {t("MiSD runs in the desktop app.")}
        </div>
      ) : (
        <>
          {/* disk: location + label + connected */}
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder={t("Disk name (e.g. Samsung T7)")}
              className={cn(
                "h-9 w-48 rounded-lg border px-3 text-sm text-zinc-100 outline-none placeholder:text-zinc-400",
                irid
                  ? "border-white/15 bg-white/10 backdrop-blur-md focus:border-white/45"
                  : "border-zinc-800 bg-zinc-950 focus:border-brand-500/60",
              )}
            />
            <Button variant="outline" onClick={chooseFolder} disabled={busy}>
              <FolderOpen className="h-4 w-4" />
              {st?.configured ? t("Change MiSD folder…") : t("Choose MiSD folder…")}
            </Button>
            {st?.configured && (
              <button
                onClick={() => void reloadStatus()}
                title={t("Re-check the disk")}
                className="rounded-lg p-1.5 text-white transition-colors hover:bg-white/10 hover:text-white"
              >
                <RefreshCw className="h-4 w-4" />
              </button>
            )}
          </div>

          {st?.configured && (
            <div
              className={cn(
                "mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-xl border px-4 py-3 text-sm",
                irid ? "glass-box border-white/15 bg-white/10 backdrop-blur-md" : "glass-box border-zinc-800 bg-zinc-900/40",
              )}
            >
              <span
                className={
                  st.available
                    ? "inline-flex items-center gap-1.5 font-medium text-emerald-300"
                    : "inline-flex items-center gap-1.5 font-medium text-amber-300"
                }
              >
                {st.available ? <Plug className="h-4 w-4" /> : <Unplug className="h-4 w-4" />}
                {st.available ? t("Connected") : t("Not connected")}
              </span>
              <span className="text-zinc-400">
                {tf("{rewards} on “{label}”", {
                  rewards: tp("{n} rewards", st.transported),
                  label: st.label ?? "MiSD",
                })}
              </span>
              <span className="text-zinc-400">
                {tf("{n} backed up", { n: st.backups })}
              </span>
              <span className="text-zinc-400">
                {tf("{moved} queued to move · {backup} queued to back up", {
                  moved: st.marked,
                  backup: st.backupMarked,
                })}
              </span>
              <code className="ml-auto truncate rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-zinc-300">
                {st.root}
              </code>
            </div>
          )}

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button
              variant="primary"
              onClick={() => setConfirmTransport(true)}
              disabled={busy || !st?.configured || !st.available || st.marked === 0}
              title={
                !st?.configured
                  ? t("Choose a MiSD folder first")
                  : !st.available
                    ? t("Connect the MiSD disk first")
                    : st.marked === 0
                      ? t("Nothing is queued — right-click a creator/month/reward → “Move to MiSD”")
                      : undefined
              }
            >
              <Truck className="h-4 w-4" />
              {busy
                ? t("Working…")
                : st?.marked
                  ? tf("Transport now ({n})", { n: st.marked })
                  : t("Transport now")}
            </Button>
            <Button
              variant="outline"
              onClick={() => setConfirmBackup(true)}
              disabled={busy || !st?.configured || !st.available || st.backupMarked === 0}
              title={
                !st?.configured
                  ? t("Choose a MiSD folder first")
                  : !st.available
                    ? t("Connect the MiSD disk first")
                    : st.backupMarked === 0
                      ? t("Nothing is queued — right-click a creator/month/reward → “Back up to MiSD”")
                      : undefined
              }
            >
              <DatabaseBackup className="h-4 w-4" />
              {busy
                ? t("Working…")
                : st?.backupMarked
                  ? tf("Back up now ({n})", { n: st.backupMarked })
                  : t("Back up now")}
            </Button>
            <Button
              variant="outline"
              onClick={() => setConfirmReturn(true)}
              disabled={busy || !st?.configured || !st.available || (st?.transported ?? 0) === 0}
              title={
                st && !st.available ? t("Connect the MiSD disk first") : undefined
              }
            >
              <Undo2 className="h-4 w-4" />
              {t("Bring everything back")}
            </Button>
          </div>
          {st?.configured && (
            <div
              className={cn(
                "mt-3 flex items-start justify-between gap-4 rounded-xl border px-4 py-3",
                irid ? "glass-box border-white/15 bg-white/10 backdrop-blur-md" : "glass-box border-zinc-800 bg-zinc-900/40",
              )}
            >
              <div className="min-w-0">
                <h3 className="flex items-center gap-2 text-sm font-semibold text-zinc-100">
                  <ImageIcon className="h-4 w-4 text-zinc-400" />
                  {t("Keep previews for moved rewards")}
                </h3>
                <p className="settings-desc mt-0.5 text-sm text-zinc-400">
                  {t(
                    "A transport copies each reward’s cover into this PC’s thumbnail cache before the files leave, so the card still shows its picture with the disk unplugged. Turn it off to keep that cache small — those cards then fall back to their coloured gradient until the disk is connected. Backups never need this: their files stay here. Applies to the next transport; previews already saved are kept.",
                  )}
                </p>
              </div>
              <Toggle checked={st.previews} onChange={(v) => void setPreviews(v)} />
            </div>
          )}

          <p className="settings-desc mt-3 text-xs text-zinc-500">
            {t(
              "The disk is recognized by a small marker file, so a changed drive letter (E: → F:) heals itself. While it’s unplugged, moved rewards show their preview and explain themselves when clicked — rescans and “Prune missing” never touch them. Backups live in their own",
            )}{" "}
            <code className="rounded bg-zinc-800 px-1 text-zinc-300">_backup</code>{" "}
            {t(
              "folder on the disk and are deliberately kept when you delete the reward here; Library health lists any that no longer belong to anything.",
            )}
          </p>
        </>
      )}

      {/* blocking while files move (verify -> delete must not race) */}
      {busy && prog && (
        <ProgressModal
          title={
            prog.phase === "return"
              ? t("Bringing rewards back…")
              : prog.phase === "backup"
                ? t("Backing up to MiSD…")
                : t("Transporting to MiSD…")
          }
          detail={prog.item}
          done={prog.done}
          total={prog.total}
          onCancel={() => void api.sdCancel()}
          cancelLabel={t("Stop")}
          cancelPendingLabel={t("Stopping after this one…")}
          note={
            prog.phase === "backup"
              ? t(
                  "Every file is copied and SHA-256-verified. Nothing is removed from this PC. Don’t unplug the disk.",
                )
              : t(
                  "Every file is copied, SHA-256-verified, and only then removed from the source. Don’t unplug the disk.",
                )
          }
        />
      )}

      {confirmTransport && (
        <ConfirmDialog
          title={tf("Transport {n} rewards to MiSD?", { n: st?.marked ?? 0 })}
          confirmLabel={t("Transport")}
          busy={busy}
          body={
            <>
              {t("The marked rewards are")} <b>{t("moved")}</b> {t("to")}{" "}
              <code className="rounded bg-zinc-800 px-1 py-0.5 text-zinc-200">{st?.root}</code>.
              {t("Every file is copied first,")}{" "}
              <b>{t("SHA-256-verified against the original")}</b>
              {t(
                ", and only then removed from the main disk — a failed check keeps both copies. Previews stay on this PC so the cards keep rendering with the disk unplugged.",
              )}
              <SdQueuedCreators names={who.filter((c) => c.moves > 0).map((c) => c.name)} />
            </>
          }
          onConfirm={doTransport}
          onCancel={() => setConfirmTransport(false)}
        />
      )}

      {confirmBackup && (
        <ConfirmDialog
          title={tf("Back up {n} rewards to MiSD?", { n: st?.backupMarked ?? 0 })}
          confirmLabel={t("Back up")}
          busy={busy}
          body={
            <>
              {t("A verified copy of each queued reward is written to")}{" "}
              <code className="rounded bg-zinc-800 px-1 py-0.5 text-zinc-200">
                {st?.root}\_backup
              </code>
              . <b>{t("Nothing on this PC is moved or deleted")}</b>{" "}
              {t(
                "— the rewards stay exactly where they are and keep opening with the disk unplugged. Running this again on an already-backed-up reward refreshes its copy.",
              )}
              <SdQueuedCreators names={who.filter((c) => c.backups > 0).map((c) => c.name)} />
            </>
          }
          onConfirm={doBackup}
          onCancel={() => setConfirmBackup(false)}
        />
      )}

      {confirmReturn && (
        <ConfirmDialog
          title={tf("Bring {n} rewards back?", { n: st?.transported ?? 0 })}
          confirmLabel={t("Bring back")}
          busy={busy}
          body={
            <>
              {t(
                "Everything on the MiSD disk is moved back to where it originally lived on the main disk (same verified copy, in reverse). Make sure the main disk has enough free space.",
              )}
            </>
          }
          onConfirm={doReturnAll}
          onCancel={() => setConfirmReturn(false)}
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
