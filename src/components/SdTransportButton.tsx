import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { listen } from "@tauri-apps/api/event";
import { Truck } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { ProgressModal } from "@/components/ProgressModal";
import { SdQueuedCreators } from "@/components/SdQueuedCreators";
import { useActions } from "@/actions";
import { useData } from "@/store";
import { useT, useTf, useTp } from "@/lib/i18n";
import * as api from "@/api/library";

type SdProgress = { phase: "transport" | "return" | "backup"; done: number; total: number; item: string };

/**
 * Top bar MiSD button: runs the queued jobs without going to Settings.
 * Only visible while something is queued. Runs both queues (move and backup) as two
 * jobs. Still asks for confirmation first.
 */
export function SdTransportButton() {
  const t = useT();
  const tf = useTf();
  const tp = useTp();
  const { showToast } = useActions();
  const { artists, backed, refresh } = useData();
  const [status, setStatus] = useState<api.SdStatus | null>(null);
  const [who, setWho] = useState<api.SdQueuedCreator[]>([]);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [prog, setProg] = useState<SdProgress | null>(null);
  // own tooltip instead of title (shows right away, e.g. "disk not connected").
  // On a wrapper so it doesn't depend on the button state.
  const hostRef = useRef<HTMLSpanElement>(null);
  const [tip, setTip] = useState<{ left: number; top: number } | null>(null);
  const showTip = () => {
    const r = hostRef.current?.getBoundingClientRect();
    if (r) setTip({ left: r.left + r.width / 2, top: r.bottom + 8 });
  };

  const reload = useCallback(async () => {
    if (!backed) {
      setStatus(null);
      setWho([]);
      return;
    }
    try {
      const [s, w] = await Promise.all([api.sdStatus(), api.sdQueuedCreators()]);
      setStatus(s);
      setWho(w);
    } catch {
      setStatus(null);
      setWho([]);
    }
  }, [backed]);

  // reload on mount and whenever the library reloads (queuing always ends in refresh())
  useEffect(() => {
    void reload();
  }, [reload, artists]);

  // real progress ticks from the mover
  useEffect(() => {
    if (!backed) return;
    // only handle ticks for our own job (other jobs have their own overlay)
    const un = listen<SdProgress>("sd-progress", (e) =>
      setProg((cur) => (cur && cur.phase === e.payload.phase ? e.payload : cur)),
    );
    return () => {
      void un.then((f) => f());
    };
  }, [backed]);

  const moves = status?.marked ?? 0;
  const backups = status?.backupMarked ?? 0;
  const queued = moves + backups;
  if (!backed || !status?.configured || queued === 0) return null;

  const disk = status.label || t("MiSD");

  const summarize = (verb: string, s: api.SdSummary, detail: string) =>
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
            title: tf("MiSD: {verb} {rewards}", { verb: t(verb), rewards: tp("{n} rewards", s.moved) }),
            detail: t(detail),
          },
    );

  const run = async () => {
    setConfirm(false);
    setBusy(true);
    try {
      // move first, then copy (a transport replaces a backup)
      let stopped = false;
      if (moves > 0) {
        setProg({ phase: "transport", done: 0, total: moves, item: "" });
        const s = await api.sdTransport();
        stopped = s.cancelled;
        summarize(
          "transported",
          s,
          "Every file was copied and hash-verified before the original was removed.",
        );
      }
      // stop means stop, don't continue with the copies
      if (!stopped && backups > 0) {
        setProg({ phase: "backup", done: 0, total: backups, item: "" });
        summarize(
          "backed up",
          await api.sdBackupNow(),
          "The local files were left exactly where they were.",
        );
      }
      await refresh();
      await reload();
    } catch (e) {
      showToast({ tone: "error", title: t("Transport failed"), detail: `${e}` });
    } finally {
      setBusy(false);
      setProg(null);
    }
  };

  // queued but no disk: still show the button, but say what's missing
  const ready = status.available;
  const counts =
    moves > 0 && backups > 0
      ? tf("{moves} to move, {backups} to back up", { moves, backups })
      : moves > 0
        ? tf("{rewards} to move", { rewards: tp("{n} rewards", moves) })
        : tf("{rewards} to back up", { rewards: tp("{n} rewards", backups) });

  const tipText = ready
    ? tf("MiSD: {counts} — run it now", { counts })
    : tf("MiSD: {counts} — connect “{disk}” to run it", { counts, disk });

  return (
    <>
      <span
        ref={hostRef}
        className="inline-flex"
        onMouseEnter={showTip}
        onMouseLeave={() => setTip(null)}
      >
        <Button
          variant="ghost"
          size="icon"
          disabled={!ready || busy}
          onClick={() => setConfirm(true)}
          aria-label={tipText}
          className="text-brand-300 hover:bg-brand-500/15 hover:text-brand-200"
        >
          <Truck className="h-4 w-4" />
        </Button>
      </span>
      {tip &&
        createPortal(
          <div
            style={{ left: tip.left, top: tip.top }}
            className="pointer-events-none fixed z-[120] max-w-[18rem] -translate-x-1/2 rounded-md bg-black/90 px-2 py-1 text-center text-[11px] font-medium text-white shadow-lg ring-1 ring-white/15"
          >
            {tipText}
          </div>,
          document.body,
        )}

      {confirm && (
        <ConfirmDialog
          title={tf("Run the MiSD transport ({counts})?", { counts })}
          confirmLabel={t("Run")}
          busy={busy}
          // full sentences for the translations (not stitched from pieces)
          body={
            <>
              {moves > 0 && (
                <p>
                  {tf(
                    "{rewards} are moved to “{disk}” — copied, SHA-256-verified, and only then removed from the main disk.",
                    { rewards: tp("{n} rewards", moves), disk },
                  )}
                </p>
              )}
              {backups > 0 && (
                <p className={moves > 0 ? "mt-2" : undefined}>
                  {tf("{rewards} are copied to “{disk}” and stay here as well.", {
                    rewards: tp("{n} rewards", backups),
                    disk,
                  })}
                </p>
              )}
              <SdQueuedCreators names={who.map((c) => c.name)} />
            </>
          }
          onConfirm={run}
          onCancel={() => setConfirm(false)}
        />
      )}

      {prog && (
        <ProgressModal
          title={prog.phase === "backup" ? t("Backing up to MiSD…") : t("Transporting to MiSD…")}
          detail={prog.item}
          done={prog.done}
          total={prog.total}
          onCancel={() => void api.sdCancel()}
          cancelLabel={t("Stop")}
          cancelPendingLabel={t("Stopping after this one…")}
        />
      )}
    </>
  );
}
