import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import { Download, Loader2 } from "lucide-react";
import { getVersion } from "@tauri-apps/api/app";
import { Button } from "@/components/ui/Button";
import { useDialogTheme } from "@/lib/dialogTheme";
import { useAccent } from "@/lib/theme";
import { useT, useTf } from "@/lib/i18n";
import { isTauri } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import {
  dismissUpdatePrompt,
  installUpdate,
  startAutoUpdateChecks,
  useUpdater,
} from "@/lib/updater";

const mb = (n: number) => (n / (1024 * 1024)).toFixed(1);

/**
 * Popup that shows a new version with its notes and "Later" / "Update now".
 * Mounted once for the whole app and also starts the auto checks.
 * Hidden while locked or in safe mode.
 */
export function UpdatePrompt({ active }: { active: boolean }) {
  const t = useT();
  const tf = useTf();
  const dlg = useDialogTheme();
  // cyberpunk has square edges
  const bar = useAccent() === "cyberpunk" ? "rounded-none" : "rounded-full";
  const { state, prompt } = useUpdater();
  const [current, setCurrent] = useState<string | null>(null);

  useEffect(() => startAutoUpdateChecks(), []);
  useEffect(() => {
    if (!isTauri()) return;
    getVersion()
      .then(setCurrent)
      .catch(() => {});
  }, []);

  const busy = state.kind === "downloading" || state.kind === "installing";
  const open = active && prompt && state.kind !== "idle" && state.kind !== "checking";

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") dismissUpdatePrompt();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const version =
    state.kind === "available" || state.kind === "downloading" || state.kind === "installing"
      ? state.version
      : null;
  const notes = state.kind === "available" ? state.notes : undefined;
  const pct =
    state.kind === "downloading" && state.total
      ? Math.min(100, Math.round((state.done / state.total) * 100))
      : null;

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          key="update"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-[130] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget && !busy) dismissUpdatePrompt();
          }}
        >
          <motion.div
            initial={{ opacity: 0, y: 12, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.98 }}
            role="dialog"
            aria-label={t("Update available")}
            className={cn("w-[30rem] max-w-full p-5", dlg.panel)}
          >
            <div className="mb-4 flex items-start gap-3">
              <div
                className={cn(
                  "flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-white/5",
                  dlg.accentText,
                )}
              >
                <Download className="h-5 w-5" />
              </div>
              <div className="min-w-0">
                <h2 className="text-base font-semibold text-zinc-100">
                  {state.kind === "error" ? t("Update failed") : t("Update available")}
                </h2>
                {version && (
                  <p className="mt-0.5 text-xs text-zinc-400">
                    {current
                      ? tf("MiColl {version} is ready — you have {current}.", { version, current })
                      : tf("MiColl {version} is ready.", { version })}
                  </p>
                )}
              </div>
            </div>

            {notes && (
              <div
                className={cn(
                  "max-h-56 overflow-y-auto whitespace-pre-line px-3 py-2.5 text-sm leading-relaxed text-zinc-300",
                  dlg.box,
                )}
              >
                {notes}
              </div>
            )}

            {state.kind === "downloading" && (
              <div>
                <div className={cn("h-2 overflow-hidden border", bar, dlg.soft)}>
                  <div
                    className={cn("h-full transition-[width] duration-200", dlg.accent)}
                    style={{ width: pct === null ? "35%" : `${pct}%` }}
                  />
                </div>
                <p className="mt-2 text-xs text-zinc-400">
                  {state.total
                    ? tf("Downloading… {done} / {total} MB", {
                        done: mb(state.done),
                        total: mb(state.total),
                      })
                    : t("Downloading…")}
                </p>
              </div>
            )}

            {state.kind === "installing" && (
              <p className="flex items-center gap-2 text-sm text-zinc-300">
                <Loader2 className={cn("h-4 w-4 animate-spin", dlg.accentText)} />
                {t("Installing — MiColl restarts on its own.")}
              </p>
            )}

            {state.kind === "error" && (
              <p className="text-sm text-rose-300">
                {state.during === "install"
                  ? tf("The update couldn’t be installed: {detail}", { detail: state.detail })
                  : tf("Couldn’t check for updates: {detail}", { detail: state.detail })}
              </p>
            )}

            {state.kind === "current" && (
              <p className="text-sm text-zinc-300">{t("You’re on the latest version.")}</p>
            )}

            {state.kind === "available" && (
              <p className="mt-3 text-[11px] text-zinc-500">
                {t("Your library and settings stay as they are. MiColl closes for a moment and starts again.")}
              </p>
            )}

            <div className="mt-5 flex justify-end gap-2">
              {!busy && (
                <Button variant="ghost" onClick={dismissUpdatePrompt}>
                  {state.kind === "available" ? t("Later") : t("Close")}
                </Button>
              )}
              {(state.kind === "available" ||
                (state.kind === "error" && state.during === "install")) && (
                <Button variant="primary" onClick={() => void installUpdate()} className={dlg.primary}>
                  <Download className="h-4 w-4" />
                  {state.kind === "error" ? t("Try again") : t("Update now")}
                </Button>
              )}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
