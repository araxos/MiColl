import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { motion } from "framer-motion";
import { useNavigate } from "react-router-dom";
import { ArrowUpRight, Copy, Loader2, MoveRight, Trash2, Truck, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { fmtBytes } from "@/components/RewardDetails";
import { useDialogTheme } from "@/lib/dialogTheme";
import { cn } from "@/lib/utils";
import { useT, useTf, useTp } from "@/lib/i18n";
import * as api from "@/api/library";
import { useData } from "@/store";

/**
 * The MiSD truck's window: what waits to go to the disk, how (moved or copied) and how
 * much space it takes, with Transport at the bottom. Opens also while the disk isn't
 * connected (to look); Transport then stays off and says why.
 */
export function SdTransportDialog({
  disk,
  ready,
  busy,
  onRun,
  onClose,
}: {
  /** The disk's name. */
  disk: string;
  /** The disk is connected. */
  ready: boolean;
  busy: boolean;
  onRun: () => void;
  onClose: () => void;
}) {
  const t = useT();
  const tf = useTf();
  const tp = useTp();
  const dlg = useDialogTheme();
  const navigate = useNavigate();
  const [rows, setRows] = useState<api.SdQueuedReward[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const { refresh } = useData();
  // the rewards being taken off the queue right now
  const [removing, setRemoving] = useState<Set<number>>(new Set());

  /** Take a reward off the queue (it stays where it is). The list is measured again
   *  after it: a reward inside its folder no longer "goes along" with it. */
  const unqueue = async (r: api.SdQueuedReward) => {
    setRemoving((s) => new Set(s).add(r.id));
    try {
      await api.sdMark({ rewardIds: [r.id], marked: false, mode: r.mode === "copy" ? "backup" : "move" });
      setRows((list) => list?.filter((x) => x.id !== r.id) ?? null);
      void refresh();
      void api.sdQueuedRewards().then(setRows).catch(() => {});
    } catch (e) {
      setErr(String(e));
    } finally {
      setRemoving((s) => {
        const n = new Set(s);
        n.delete(r.id);
        return n;
      });
    }
  };

  useEffect(() => {
    let alive = true;
    api
      .sdQueuedRewards()
      .then((r) => alive && setRows(r))
      .catch((e) => alive && setErr(String(e)));
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [busy, onClose]);

  // a nested reward goes along with its parent folder, its size is already in there
  const size = (list: api.SdQueuedReward[]) => list.filter((r) => !r.nested).reduce((n, r) => n + r.bytes, 0);
  // by creator, in the order they come (the backend sorts by name)
  const groups = (list: api.SdQueuedReward[]) => {
    const m = new Map<string, api.SdQueuedReward[]>();
    for (const r of list) m.set(r.artist, [...(m.get(r.artist) ?? []), r]);
    return [...m.entries()];
  };
  const moves = rows?.filter((r) => r.mode === "move") ?? [];
  const copies = rows?.filter((r) => r.mode === "copy") ?? [];

  const section = (list: api.SdQueuedReward[], mode: "move" | "copy") =>
    list.length > 0 && (
      <div className={cn("mt-5 border-t pt-5 first:mt-0 first:border-t-0 first:pt-0", dlg.divider)}>
        {/* the section's head: bigger than the creator names below, icon in the theme
            colour. What it does shows under it while you point at the title */}
        <div className="flex items-center justify-between gap-3">
          <span className="group/head relative flex cursor-default items-center gap-2 text-base font-semibold text-zinc-100">
            {mode === "move" ? (
              <MoveRight className={cn("h-[18px] w-[18px]", dlg.accentText)} />
            ) : (
              <Copy className={cn("h-[18px] w-[18px]", dlg.accentText)} />
            )}
            {mode === "move" ? t("Move to the disk") : t("Copy to the disk (backup)")}
            <span className="pointer-events-none absolute left-0 top-full z-10 mt-1.5 w-max max-w-[22rem] rounded-md bg-black/90 px-2 py-1 text-[11px] font-medium text-zinc-200 opacity-0 shadow-lg ring-1 ring-white/15 transition-opacity duration-150 group-hover/head:opacity-100">
              {mode === "move"
                ? t("Copied, SHA-256-verified and only then removed from this PC.")
                : t("Copied to the disk, the files stay on this PC as well.")}
            </span>
          </span>
          <span className="shrink-0 text-xs font-medium tabular-nums text-zinc-300">
            {tp("{n} rewards", list.length)} · {fmtBytes(size(list))}
          </span>
        </div>
        {/* one box per creator, its name and total above it */}
        {groups(list).map(([artist, items]) => (
          <div key={artist} className="mt-3">
            <div className="flex items-baseline justify-between gap-3 px-0.5">
              <span className="truncate text-sm font-semibold text-zinc-100">{artist}</span>
              <span className="shrink-0 text-[11px] tabular-nums text-zinc-500">
                {tp("{n} rewards", items.length)} · {fmtBytes(size(items))}
              </span>
            </div>
            <div className={cn("mt-1.5", dlg.field)}>
              {items.map((r) => (
                <div
                  key={r.id}
                  className={cn("flex items-center gap-3 border-t px-3 py-2 first:border-t-0", dlg.divider)}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-center gap-1">
                      <span className="truncate text-sm text-zinc-100" title={r.title}>
                        {r.title}
                      </span>
                      {/* straight to the reward's month */}
                      <button
                        onClick={() => {
                          onClose();
                          navigate(`/artist/${r.artistId}/month/${r.periodId}`);
                        }}
                        title={t("Go to this reward")}
                        className={cn("shrink-0 rounded p-0.5 text-zinc-500 transition-colors hover:text-zinc-100", dlg.menuRow)}
                      >
                        <ArrowUpRight className="h-3.5 w-3.5" />
                      </button>
                      {/* off the queue after all: neither moved nor backed up */}
                      <button
                        onClick={() => void unqueue(r)}
                        disabled={busy || removing.has(r.id)}
                        title={t("Remove from the transport")}
                        className={cn(
                          "shrink-0 rounded p-0.5 text-zinc-500 transition-colors hover:text-rose-300 disabled:opacity-40",
                          dlg.menuRow,
                        )}
                      >
                        {removing.has(r.id) ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Trash2 className="h-3.5 w-3.5" />
                        )}
                      </button>
                    </div>
                    <div className="truncate text-xs text-zinc-500">
                      {[r.platform, r.period].filter(Boolean).join(" › ")}
                    </div>
                  </div>
                  <div className="shrink-0 text-right text-xs tabular-nums text-zinc-400">
                    <div>{fmtBytes(r.bytes)}</div>
                    <div className="text-zinc-500">
                      {r.nested ? t("goes along with its folder") : tp("{n} files", r.files)}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    );

  return createPortal(
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      onClick={() => !busy && onClose()}
      data-drop-block=""
      className="fixed inset-0 z-[90] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
    >
      <motion.div
        initial={{ scale: 0.96, opacity: 0, y: 8 }}
        animate={{ scale: 1, opacity: 1, y: 0 }}
        onClick={(e) => e.stopPropagation()}
        className={cn("flex max-h-[85vh] w-[34rem] max-w-[94vw] flex-col overflow-hidden", dlg.panel)}
      >
        <div className={cn("flex shrink-0 items-center justify-between border-b px-5 py-3", dlg.divider)}>
          <h2 className="flex items-center gap-2 text-sm font-semibold text-zinc-100">
            <Truck className={cn("h-4 w-4", dlg.accentText)} />
            {t("MiSD transport")}
          </h2>
          <button
            onClick={onClose}
            disabled={busy}
            className="text-zinc-500 transition-colors hover:text-zinc-300"
            title={t("Close (Esc)")}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className={cn("flex shrink-0 items-center gap-2 border-b px-5 py-2 text-xs", dlg.divider)}>
          <span className="text-zinc-400">{t("Disk")}</span>
          <span className="font-medium text-zinc-100">{disk}</span>
          <span
            className={cn(
              "ml-auto rounded-full px-2 py-0.5 font-medium",
              ready ? "bg-emerald-500/15 text-emerald-300" : "bg-amber-500/15 text-amber-300",
            )}
          >
            {ready ? t("Connected") : t("Not connected")}
          </span>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {err ? (
            <p className="text-sm text-rose-300">{err}</p>
          ) : rows === null ? (
            <p className="flex items-center gap-2 text-sm text-zinc-400">
              <Loader2 className={cn("h-4 w-4 animate-spin", dlg.accentText)} />
              {t("Measuring the folders…")}
            </p>
          ) : rows.length === 0 ? (
            <p className="text-sm text-zinc-400">{t("Nothing is waiting for the disk.")}</p>
          ) : (
            <>
              {section(moves, "move")}
              {section(copies, "copy")}
            </>
          )}
        </div>

        <div className={cn("flex shrink-0 items-center justify-between gap-3 border-t px-5 py-3", dlg.divider)}>
          <span className="truncate text-xs text-zinc-400">
            {rows && rows.length > 0
              ? tf("{rewards} · {size} in all", { rewards: tp("{n} rewards", rows.length), size: fmtBytes(size(rows)) })
              : ""}
          </span>
          <div className="flex shrink-0 gap-2">
            <Button variant="ghost" onClick={onClose} disabled={busy}>
              {t("Close")}
            </Button>
            {/* off while the disk isn't there; the wrapper takes the hover so it can say why */}
            <span title={ready ? undefined : tf("“{disk}” isn’t connected — plug it in to transport", { disk })}>
              <Button
                variant="primary"
                onClick={onRun}
                disabled={!ready || busy || !rows?.length}
                className={cn(!ready && "pointer-events-none")}
              >
                <Truck className="h-4 w-4" />
                {t("Transport")}
              </Button>
            </span>
          </div>
        </div>
      </motion.div>
    </motion.div>,
    document.body,
  );
}
