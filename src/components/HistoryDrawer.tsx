import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { motion } from "framer-motion";
import { History, Settings, Undo2, X } from "lucide-react";
import { useAccent } from "@/lib/theme";
import { useDialogTheme } from "@/lib/dialogTheme";
import { cn } from "@/lib/utils";
import { resolveLanguage, useLanguage, useT } from "@/lib/i18n";
import * as api from "@/api/library";
import { HISTORY_CHANGED_EVENT, useActions } from "@/actions";
import { useHistoryText } from "@/components/HistoryPanel";

/** How many entries the drawer shows, the rest is in Settings → History. */
const LAST = 15;

const parseAt = (at: string) => new Date(at.replace(" ", "T") + "Z");

/**
 * Right side drawer from the top bar's history button: the last few renames, moves and
 * deletes in short. Starts below the top bar like RecentPanel. In a portal, the header's
 * backdrop blur would otherwise pin the fixed drawer to the header.
 */
export function HistoryDrawer({
  onClose,
  onOpenSettings,
}: {
  onClose: () => void;
  /** Settings → History, optionally with one entry opened */
  onOpenSettings: (id?: number) => void;
}) {
  const t = useT();
  const locale = resolveLanguage(useLanguage());
  const accent = useAccent();
  const dlg = useDialogTheme();
  const { verb, Icon, what, where } = useHistoryText();
  const { undoHistory } = useActions();
  const [rows, setRows] = useState<api.HistoryRow[] | null>(null);
  const [undoing, setUndoing] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      setRows(await api.listHistory(undefined, LAST));
    } catch {
      setRows((r) => r ?? []);
    }
  }, []);
  useEffect(() => {
    void load();
    const on = () => void load();
    window.addEventListener(HISTORY_CHANGED_EVENT, on);
    return () => window.removeEventListener(HISTORY_CHANGED_EVENT, on);
  }, [load]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // panel style per theme (like ArtistSidebar)
  const surface =
    accent === "cyberpunk"
      ? "border-l border-[#fcee0a]/40 bg-zinc-950/85 backdrop-blur-2xl"
      : accent === "iridescent"
        ? "border-l border-white/12 bg-zinc-900/70 backdrop-blur-2xl"
        : accent === "sakura"
          ? "border-l border-[#f9a8d4]/30 bg-zinc-950/80 backdrop-blur-2xl"
          : "border-l border-brand-500/20 bg-gradient-to-b from-brand-950/85 to-zinc-950/95 backdrop-blur-xl";
  const headerBar =
    accent === "cyberpunk"
      ? "border-b border-[#fcee0a]/25 bg-[#fcee0a]/5"
      : accent === "iridescent"
        ? "border-b border-white/10 bg-white/5"
        : accent === "sakura"
          ? "border-b border-[#f9a8d4]/20 bg-[#f9a8d4]/5"
          : "border-b border-brand-500/20";
  const radius = accent === "cyberpunk" ? "rounded-none" : "rounded-lg";

  // today: just the time, otherwise the date too
  const when = (at: string) => {
    const d = parseAt(at);
    const time = d.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
    if (d.toDateString() === new Date().toDateString()) return time;
    return `${d.toLocaleDateString(locale, { day: "numeric", month: "short" })} ${time}`;
  };

  return createPortal(
    <>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        onClick={onClose}
        className="fixed inset-x-0 bottom-0 top-14 z-40 bg-black/30"
      />
      <motion.aside
        initial={{ x: "100%" }}
        animate={{ x: 0 }}
        exit={{ x: "100%" }}
        transition={{ type: "spring", stiffness: 380, damping: 38 }}
        className={cn(
          "fixed bottom-0 right-0 top-14 z-50 flex w-80 flex-col shadow-2xl shadow-black/50",
          surface,
        )}
      >
        <div className={cn("flex items-center justify-between px-4 py-3", headerBar)}>
          <div className="flex items-center gap-2 text-sm font-semibold text-zinc-100">
            <History className={cn("h-4 w-4", dlg.accentText)} />
            {t("History")}
          </div>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-200" title={t("Close")}>
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-1 overflow-y-auto p-2">
          {rows && rows.length === 0 && (
            <p className="p-4 text-center text-xs text-zinc-500">
              {t("Nothing yet. From now on, every delete, move and rename shows up here.")}
            </p>
          )}
          {rows?.map((r) => {
            const I = Icon(r);
            const sub = where(r);
            return (
              <div
                key={r.id}
                className={cn(
                  "group flex items-start gap-2.5 px-2 py-2 transition-colors hover:bg-white/5",
                  radius,
                  r.undone && "opacity-55",
                )}
              >
                <button
                  onClick={() => onOpenSettings(r.id)}
                  // full text for long names, a click opens it in Settings
                  title={`${what(r)}\n${t("Show in Settings → History")}`}
                  className="flex min-w-0 flex-1 items-start gap-2.5 text-left"
                >
                  <I
                    className={cn(
                      "mt-0.5 h-4 w-4 shrink-0",
                      r.action === "delete" || r.action === "trash" ? "text-rose-300" : dlg.accentText,
                    )}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-zinc-100">{what(r)}</span>
                    <span className="block truncate text-[11px] text-zinc-400">
                      {verb(r)}
                      {r.undone && ` · ${t("Undone")}`}
                      {sub && ` · ${sub}`}
                    </span>
                    <span className="block text-[11px] tabular-nums text-zinc-500">{when(r.at)}</span>
                  </span>
                </button>
                {r.undoable && (
                  <button
                    onClick={async () => {
                      setUndoing(r.id);
                      await undoHistory(r.id);
                      setUndoing(null);
                    }}
                    disabled={undoing != null}
                    title={t("Undo")}
                    className={cn("mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center disabled:opacity-50", dlg.control)}
                  >
                    <Undo2 className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            );
          })}
        </div>

        <div className={cn("border-t p-3", dlg.divider)}>
          <button
            onClick={() => onOpenSettings()}
            className={cn("flex w-full items-center justify-center gap-2 px-3 py-2 text-xs", dlg.control)}
          >
            <Settings className="h-3.5 w-3.5" />
            {t("Full history in Settings")}
          </button>
        </div>
      </motion.aside>
    </>,
    document.body,
  );
}
