import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { listen } from "@tauri-apps/api/event";
import { Truck } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { SdTransportDialog } from "@/components/SdTransportDialog";
import { ProgressModal } from "@/components/ProgressModal";
import { useActions } from "@/actions";
import { useData } from "@/store";
import { useT, useTf, useTp } from "@/lib/i18n";
import { cn } from "@/lib/utils";
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
      return;
    }
    try {
      setStatus(await api.sdStatus());
    } catch {
      setStatus(null);
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

  // MiSD is a name, the same in every language
  const disk = status.label || "MiSD";

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
    ? tf("MiSD: {counts} — click to see and run it", { counts })
    : tf("MiSD: {counts} — “{disk}” isn’t connected, click to see what waits", { counts, disk });

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
          disabled={busy}
          onClick={() => setConfirm(true)}
          aria-label={tipText}
          // greyed (not off) while the disk isn't there: the window still opens
          className={cn(
            "relative hover:bg-brand-500/15",
            ready ? "text-brand-300 hover:text-brand-200" : "text-zinc-500 hover:text-zinc-300",
          )}
        >
          <Truck className="h-4 w-4" />
          {/* the disk is plugged in: the same dot as the gear's for MiColl Mobile */}
          {status.available && (
            <span aria-hidden className="conn-dot-hit">
              <span className="conn-dot" />
            </span>
          )}
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
        <SdTransportDialog disk={disk} ready={ready} busy={busy} onRun={run} onClose={() => setConfirm(false)} />
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
