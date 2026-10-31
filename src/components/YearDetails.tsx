import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { motion } from "framer-motion";
import { Loader2, X } from "lucide-react";
import { mediaStats } from "@/api/library";
import { Cover } from "@/components/Cover";
import { fmtBytes } from "@/components/RewardDetails";
import { ThemeCheck } from "@/components/ThemeCheck";
import { isTauri } from "@/lib/tauri";
import { useDialogTheme } from "@/lib/dialogTheme";
import { useAccent } from "@/lib/theme";
import { resolveLanguage, useLanguage, useT, useTf } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { ownRewards, type Month, type Reward } from "@/types";

/* No plurals in here on purpose, like CreatorDetails: every row has its unit as a label. */

/**
 * Details of one year (or Misc) on a creator page, from the year header's right-click menu.
 * Counted from the library in memory, only the size is measured (one stat per file).
 * Rewards on an unplugged MiSD disk aren't measured and are said so.
 */
export function YearDetails({
  label,
  artistName,
  platform,
  verified,
  monthPeriods,
  yearRewards,
  onClose,
}: {
  /** "2025" or "Misc", already translated. */
  label: string;
  artistName: string;
  platform: string | null;
  verified: boolean;
  monthPeriods: Month[];
  /** Rewards right in the year (no month). */
  yearRewards: Reward[];
  onClose: () => void;
}) {
  const t = useT();
  const tf = useTf();
  const active = resolveLanguage(useLanguage());
  const dlg = useDialogTheme();
  const accent = useAccent();

  const stats = useMemo(() => {
    const rewards = [
      ...monthPeriods.filter((m) => !m.skipped).flatMap((m) => ownRewards(m)),
      ...yearRewards.filter((r) => !r.collabFrom),
    ];
    const owned = rewards.filter((r) => r.status === "owned");
    const local = owned.filter((r) => !r.sdVolume);
    const tracked = monthPeriods.filter((m) => !m.skipped && m.officialTotal != null);
    return {
      owned: owned.length,
      missing: rewards.filter((r) => r.status === "missing").length,
      skippedRewards: rewards.filter((r) => r.status !== "owned" && r.status !== "missing").length,
      files: owned.reduce((n, r) => n + r.imageCount, 0),
      localFiles: local.reduce((n, r) => n + r.imageCount, 0),
      months: monthPeriods.filter((m) => !m.skipped).length,
      breaks: monthPeriods.filter((m) => m.skipped).length,
      offline: owned.length - local.length,
      official: tracked.length ? tracked.reduce((n, m) => n + (m.officialTotal || 0), 0) : null,
      paths: local.flatMap((r) => r.images.map((i) => i.path)).filter((p): p is string => !!p),
      cover: owned.find((r) => r.cover)?.cover ?? "",
    };
  }, [monthPeriods, yearRewards]);

  // size, unreadable files and the newest change, measured once on open
  const [size, setSize] = useState<{ bytes: number; missing: number; modified: number } | null>(null);
  useEffect(() => {
    if (!isTauri() || stats.paths.length === 0) return;
    let alive = true;
    mediaStats(stats.paths)
      .then(
        (list) =>
          alive &&
          setSize({
            bytes: list.reduce((n, f) => n + f.size, 0),
            // a file that's gone comes back with no date
            missing: list.filter((f) => f.modified === 0).length,
            modified: list.reduce((n, f) => Math.max(n, f.modified), 0),
          }),
      )
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [stats.paths]);
  const busy = isTauri() && stats.paths.length > 0 && !size;

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

  const num = (n: number) => n.toLocaleString(active);
  const row = (k: string, v: string): [string, string] => [t(k), v];
  // no paths yet while the creator's images still load
  const sizeText = !isTauri()
    ? t("desktop app only")
    : size
      ? fmtBytes(size.bytes)
      : busy || stats.localFiles > 0
        ? t("measuring…")
        : fmtBytes(0);

  const tiles: { key: string; label: string; value: string; note?: string }[] = [
    {
      key: "rewards",
      label: t("Rewards"),
      value: num(stats.owned),
      note: stats.official != null ? tf("of {total} released", { total: num(stats.official) }) : undefined,
    },
    { key: "files", label: t("Files"), value: num(stats.files) },
    { key: "size", label: t("Size"), value: sizeText },
  ];

  const rows: [string, string][] = [
    ...(stats.months > 0 ? [row("Periods", num(stats.months))] : []),
    ...(stats.breaks > 0 ? [row("Breaks", num(stats.breaks))] : []),
    ...(stats.missing > 0 ? [row("Missing", num(stats.missing))] : []),
    ...(stats.skippedRewards > 0 ? [row("Skipped", num(stats.skippedRewards))] : []),
    ...(stats.offline > 0 ? [row("On MiSD", tf("{n} on MiSD, not counted", { n: num(stats.offline) }))] : []),
    ...(size && size.missing > 0
      ? [row("Not readable", tf("{n} — deleted, or on an unplugged disk", { n: num(size.missing) }))]
      : []),
    ...(platform ? [row("Platform", platform)] : []),
    ...(verified ? [row("Template", t("Verified"))] : []),
    row("Last changed", size?.modified ? new Date(size.modified).toLocaleString(active) : "—"),
  ];

  const round = accent === "cyberpunk" ? "rounded-none" : "rounded-lg";

  return createPortal(
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      onClick={(e) => {
        e.stopPropagation();
        onClose();
      }}
      onContextMenu={(e) => {
        e.stopPropagation();
        e.preventDefault();
      }}
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
    >
      <motion.div
        initial={{ scale: 0.96, opacity: 0, y: 8 }}
        animate={{ scale: 1, opacity: 1, y: 0 }}
        onClick={(e) => e.stopPropagation()}
        className={cn("flex max-h-[88vh] w-[28rem] max-w-[92vw] flex-col overflow-hidden", dlg.panel)}
      >
        {/* head: a reward cover of the year blurred behind the title */}
        <div className={cn("relative shrink-0 overflow-hidden border-b", dlg.divider)}>
          {stats.cover && (
            <div aria-hidden className="absolute inset-0 scale-125 opacity-40 blur-2xl">
              <Cover path={stats.cover} seed={label} rounded="rounded-none" />
            </div>
          )}
          <div
            aria-hidden
            className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/55 to-black/30"
          />
          <button
            onClick={onClose}
            title={t("Close (Esc)")}
            className={cn(
              "absolute right-2.5 top-2.5 z-10 p-1.5 text-white/70 backdrop-blur-sm transition-colors hover:text-white",
              round,
              dlg.menuRow,
            )}
          >
            <X className="h-4 w-4" />
          </button>
          <div className="relative px-5 pb-5 pt-6">
            <p className="text-[10px] font-medium uppercase tracking-[0.14em] text-white/45">
              {t("Year details")}
            </p>
            <h2 className="mt-1 flex items-center gap-1.5 text-lg font-semibold leading-tight text-white">
              <span className="min-w-0 break-words">{label}</span>
              {verified && <ThemeCheck className="h-4 w-4" label={t("Whole year verified by a template")} />}
            </h2>
            <p className="mt-0.5 truncate text-sm text-white/60">{artistName}</p>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <div className="grid grid-cols-3 gap-2">
            {tiles.map((tile) => (
              <div key={tile.key} className={cn("px-3 py-2.5", round, dlg.box)}>
                <p className="text-[10px] uppercase tracking-wide text-zinc-500">{tile.label}</p>
                <p className="mt-0.5 truncate text-lg font-semibold leading-tight text-zinc-100">
                  {tile.value}
                </p>
                {tile.note && <p className="mt-0.5 truncate text-[10px] text-zinc-500">{tile.note}</p>}
              </div>
            ))}
          </div>

          <div className={cn("mt-3", dlg.field)}>
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

          {busy && (
            <p className="mt-3 flex items-center gap-2 text-xs text-zinc-500">
              <Loader2 className={cn("h-3.5 w-3.5 animate-spin", dlg.accentText)} />
              {t("Measuring this year’s files…")}
            </p>
          )}
        </div>
      </motion.div>
    </motion.div>,
    document.body,
  );
}
