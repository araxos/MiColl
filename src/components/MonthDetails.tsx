import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { motion } from "framer-motion";
import { FolderOpen, Info, Loader2, X } from "lucide-react";
import { folderPathOf, mediaStats, revealPeriod } from "@/api/library";
import { useActions } from "@/actions";
import { fmtBytes } from "@/components/RewardDetails";
import { accessLabel, ACCESS_KINDS, type Access } from "@/lib/access";
import { isTauri } from "@/lib/tauri";
import { tierLabel } from "@/lib/tier";
import { useDialogTheme } from "@/lib/dialogTheme";
import { cn } from "@/lib/utils";
import { useT, useTf, useTp } from "@/lib/i18n";
import { type Month, ownRewards } from "@/types";

/**
 * Details for a month folder (right-click → Details), like the reward's: what's in it,
 * its marks and where it lives (click the path to copy it). Size loads after opening.
 */
export function MonthDetails({ month, onClose }: { month: Month; onClose: () => void }) {
  const t = useT();
  const tf = useTf();
  const tp = useTp();
  const dlg = useDialogTheme();
  const { showToast } = useActions();
  const own = ownRewards(month);
  const [size, setSize] = useState<number | null>(null);
  const [modified, setModified] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [path, setPath] = useState<string | null>(null);

  const paths = own.flatMap((r) => r.images.map((im) => im.path)).filter((p): p is string => !!p);

  useEffect(() => {
    if (!isTauri() || month.collabOnly) return;
    folderPathOf("period", month.id)
      .then(setPath)
      .catch(() => {});
  }, [month.id, month.collabOnly]);

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
    // the path list is derived fresh each render; key the fetch on the month instead
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [month.id, paths.length]);

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

  const copyPath = async () => {
    if (!path) return;
    try {
      await navigator.clipboard.writeText(path);
      showToast({ tone: "success", title: t("Path copied"), detail: path });
    } catch (e) {
      showToast({ tone: "error", title: t("Couldn’t copy the path"), detail: String(e) });
    }
  };

  const owned = own.filter((r) => r.status === "owned").length;
  const missing = own.filter((r) => r.status === "missing").length;
  const borrowed = month.rewards.length - own.length;
  const files = own.reduce((n, r) => n + (r.images.length || r.imageCount || 0), 0);
  const access = month.access && ACCESS_KINDS.includes(month.access as Access) ? (month.access as Access) : null;
  const name = month.yearName && month.month != null ? `${month.yearName} › ${month.label}` : month.label;

  const rows: [string, string][] = [
    ...(month.platform ? ([[t("Platform"), month.platform]] as [string, string][]) : []),
    [
      t("Rewards"),
      [
        tp("{n} rewards", own.length),
        missing ? tf("{n} missing", { n: missing }) : null,
        own.length && owned !== own.length - missing ? tf("{n} owned", { n: owned }) : null,
      ]
        .filter(Boolean)
        .join(" · "),
    ],
    ...(borrowed ? ([[t("Collab"), tp("{n} rewards", borrowed)]] as [string, string][]) : []),
    ...(month.officialTotal != null
      ? ([[t("Released"), tf("{have} of {total}", { have: owned, total: month.officialTotal })]] as [string, string][])
      : []),
    [t("Files"), tp("{n} files", files)],
    [t("Size"), busy && size == null ? "…" : size == null ? "—" : fmtBytes(size)],
    [t("Last changed"), modified ? new Date(modified).toLocaleString() : "—"],
    ...(month.tier ? ([[t("Tier"), tierLabel(month.tier, tf)]] as [string, string][]) : []),
    ...(access ? ([[t("Free / paid / leaked"), accessLabel(access, t)]] as [string, string][]) : []),
    ...(month.span > 1 ? ([[t("Spans months"), tp("{n} months", month.span)]] as [string, string][]) : []),
    ...(month.skipped ? ([[t("Break"), t("Marked as skipped")]] as [string, string][]) : []),
    [t("Cover"), month.coverImage ? month.coverImage.split(/[\\/]/).pop() || month.coverImage : t("Reward covers (automatic)")],
  ];

  return createPortal(
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      onClick={onClose}
      data-drop-block=""
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
    >
      <motion.div
        initial={{ scale: 0.96, opacity: 0, y: 8 }}
        animate={{ scale: 1, opacity: 1, y: 0 }}
        onClick={(e) => e.stopPropagation()}
        className={cn("flex max-h-[88vh] w-[28rem] max-w-[92vw] flex-col overflow-hidden", dlg.panel)}
      >
        <div className={cn("flex shrink-0 items-center justify-between border-b px-5 py-3", dlg.divider)}>
          <h2 className="flex items-center gap-2 text-sm font-semibold text-zinc-100">
            <Info className={cn("h-4 w-4", dlg.accentText)} />
            {t("Details")}
          </h2>
          <button onClick={onClose} className="text-zinc-500 transition-colors hover:text-zinc-300" title={t("Close (Esc)")}>
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <label className="block text-xs font-medium uppercase tracking-wide text-zinc-500">{t("Name")}</label>
          <p className={cn("mt-1.5 break-words px-2.5 py-2 text-sm text-zinc-100", dlg.field)}>{name}</p>

          <div className={cn("mt-4", dlg.field)}>
            {rows.map(([k, v]) => (
              <div
                key={k}
                className={cn("flex items-start justify-between gap-4 border-t px-3 py-2 first:border-t-0", dlg.divider)}
              >
                <span className="shrink-0 text-xs uppercase tracking-wide text-zinc-500">{k}</span>
                <span className="min-w-0 text-right text-sm text-zinc-200 [overflow-wrap:anywhere]">{v}</span>
              </div>
            ))}
          </div>

          {busy && (
            <p className="mt-3 flex items-center gap-2 text-xs text-zinc-500">
              <Loader2 className={cn("h-3.5 w-3.5 animate-spin", dlg.accentText)} />
              {t("Measuring the folder…")}
            </p>
          )}

          {path && (
            <>
              <label className="mt-5 block text-xs font-medium uppercase tracking-wide text-zinc-500">
                {t("Location")}
              </label>
              <div className="mt-1.5 flex items-stretch gap-2">
                <button
                  type="button"
                  onClick={() => void copyPath()}
                  className={cn(
                    "min-w-0 flex-1 truncate px-2.5 py-2 text-left text-xs text-zinc-400 transition-colors hover:text-zinc-200",
                    dlg.field,
                  )}
                  title={`${path}\n${t("Click to copy the path")}`}
                >
                  {path}
                </button>
                <button
                  onClick={() => void revealPeriod(month.id)}
                  title={t("Show in Explorer")}
                  className={cn("shrink-0 px-2.5 text-zinc-300 transition-colors", dlg.field, dlg.menuRow)}
                >
                  <FolderOpen className="h-4 w-4" />
                </button>
              </div>
            </>
          )}
        </div>
      </motion.div>
    </motion.div>,
    document.body,
  );
}
