import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { FolderOpen, Info, Loader2, X } from "lucide-react";
import { mediaStats } from "@/api/library";
import { isTauri } from "@/lib/tauri";
import { useDialogTheme } from "@/lib/dialogTheme";
import { cn } from "@/lib/utils";
import { useT, useTf } from "@/lib/i18n";
import type { Reward } from "@/types";

function fmtBytes(n: number): string {
  if (n <= 0) return "0 B";
  const u = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${u[i]}`;
}

const STATUS: Record<Reward["status"], string> = {
  owned: "Owned",
  missing: "Missing — released but not bought",
  skipped: "Skipped on purpose",
};

/**
 * Details for one reward folder (like the viewer's per-image Details). Read-only,
 * rename/move/MiSD have their own menu entries. Size and "last changed" load
 * after opening, the rest shows right away.
 */
export function RewardDetails({
  reward,
  where,
  onReveal,
  onClose,
}: {
  reward: Reward;
  /** Where it is in the library, e.g. "Patreon · 05.25". */
  where?: string;
  onReveal: () => void;
  onClose: () => void;
}) {
  const t = useT();
  const tf = useTf();
  const dlg = useDialogTheme();
  const [size, setSize] = useState<number | null>(null);
  const [modified, setModified] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  const paths = reward.images.map((im) => im.path).filter((p): p is string => !!p);

  useEffect(() => {
    if (!isTauri() || paths.length === 0) return;
    let alive = true;
    setBusy(true);
    mediaStats(paths)
      .then((s) => {
        if (!alive) return;
        setSize(s.reduce((n, f) => n + f.size, 0));
        setModified(s.reduce((m, f) => Math.max(m, f.modified), 0) || null);
      })
      .catch(() => {})
      .finally(() => alive && setBusy(false));
    return () => {
      alive = false;
    };
    // The path list is derived fresh each render; key the fetch on the reward instead.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reward.id, reward.images.length]);

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

  // count from the loaded gallery if there, else the DB count
  const kinds = reward.images.reduce<Record<string, number>>((acc, im) => {
    const k = im.kind ?? "image";
    acc[k] = (acc[k] ?? 0) + 1;
    return acc;
  }, {});
  const files = reward.images.length
    ? Object.entries(kinds)
        .map(([k, n]) => `${n} ${k}${n === 1 ? "" : "s"}`)
        .join(" · ")
    : `${reward.imageCount} file${reward.imageCount === 1 ? "" : "s"}`;

  const sd = reward.sdVolume
    ? `On the MiSD disk “${reward.sdVolume}” — connect it to open`
    : reward.sdBackup
      ? `Backed up on “${reward.sdBackup}”${reward.sdBackupAt ? ` · ${reward.sdBackupAt}` : ""}`
      : reward.sdMarked
        ? t("Queued for the next MiSD move")
        : reward.sdBackupMarked
          ? t("Queued for the next MiSD backup")
          : null;

  const rows: [string, string][] = [
    [t("Status"), t(STATUS[reward.status])],
    [t("Files"), files],
    [t("Size"), busy && size == null ? "…" : size == null ? "—" : fmtBytes(size)],
    [t("Last changed"), modified ? new Date(modified).toLocaleString() : "—"],
    ...(where ? ([[t("Where"), where]] as [string, string][]) : []),
    [t("Cover"), reward.coverCustom ? t("Picked by you") : t("First file (automatic)")],
    ...(reward.collabFrom
      ? ([[t("Collab"), tf("Lives in {name}’s folder", { name: reward.collabFrom.artistName })]] as [
          string,
          string,
        ][])
      : []),
    ...(reward.collabWith?.length
      ? ([[t("Also shown in"), reward.collabWith.map((c) => c.artistName).join(", ")]] as [
          string,
          string,
        ][])
      : []),
    ...(sd ? ([["MiSD", sd]] as [string, string][]) : []),
  ];

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      onClick={onClose}
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
    >
      <motion.div
        initial={{ scale: 0.96, opacity: 0, y: 8 }}
        animate={{ scale: 1, opacity: 1, y: 0 }}
        onClick={(e) => e.stopPropagation()}
        className={cn("flex max-h-[88vh] w-[28rem] max-w-[92vw] flex-col overflow-hidden", dlg.panel)}
      >
        <div
          className={cn("flex shrink-0 items-center justify-between border-b px-5 py-3", dlg.divider)}
        >
          <h2 className="flex items-center gap-2 text-sm font-semibold text-zinc-100">
            <Info className={cn("h-4 w-4", dlg.accentText)} />
            {t("Details")}
          </h2>
          <button
            onClick={onClose}
            className="text-zinc-500 transition-colors hover:text-zinc-300"
            title={t("Close (Esc)")}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <label className="block text-xs font-medium uppercase tracking-wide text-zinc-500">
            {t("Name")}
          </label>
          <p className={cn("mt-1.5 break-words px-2.5 py-2 text-sm text-zinc-100", dlg.field)}>
            {reward.title}
          </p>

          <div className={cn("mt-4", dlg.field)}>
            {rows.map(([k, v]) => (
              <div
                key={k}
                className={cn(
                  "flex items-start justify-between gap-4 border-t px-3 py-2 first:border-t-0",
                  dlg.divider,
                )}
              >
                <span className="shrink-0 text-xs uppercase tracking-wide text-zinc-500">{k}</span>
                <span className="text-right text-sm text-zinc-200">{v}</span>
              </div>
            ))}
          </div>

          {reward.folderPath && (
            <>
              <label className="mt-4 block text-xs font-medium uppercase tracking-wide text-zinc-500">
                {t("Location")}
              </label>
              <div className="mt-1.5 flex items-center gap-2">
                <p
                  className={cn("min-w-0 flex-1 truncate px-2.5 py-2 text-xs text-zinc-400", dlg.field)}
                  title={reward.folderPath}
                >
                  {reward.folderPath}
                </p>
                {isTauri() && (
                  <button
                    onClick={onReveal}
                    title={t("Show in Explorer")}
                    className={cn(
                      "inline-flex shrink-0 items-center gap-1.5 px-3 py-2 text-sm text-zinc-200 transition-colors",
                      dlg.field,
                      dlg.menuRow,
                    )}
                  >
                    <FolderOpen className="h-4 w-4" />
                  </button>
                )}
              </div>
            </>
          )}

          {busy && (
            <p className="mt-3 flex items-center gap-2 text-xs text-zinc-500">
              <Loader2 className={cn("h-3.5 w-3.5 animate-spin", dlg.accentText)} />
              {t("Measuring the folder…")}
            </p>
          )}
        </div>
      </motion.div>
    </motion.div>
  );
}
