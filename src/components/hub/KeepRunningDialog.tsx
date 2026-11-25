import { useEffect } from "react";
import { createPortal } from "react-dom";
import { motion } from "framer-motion";
import { MonitorPause, Power, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { useDialogTheme } from "@/lib/dialogTheme";
import { toggleOnClass, useAccent } from "@/lib/theme";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * Wallpaper Hub: the lock screen and the screen saver only run while MiColl does. Offers
 * the two settings that keep it running, the same ones as in Settings → Performance.
 */
export function KeepRunningDialog({
  tray,
  autostart,
  onTray,
  onAutostart,
  onSettings,
  onDismiss,
  onClose,
}: {
  tray: boolean;
  autostart: boolean;
  onTray: (on: boolean) => void;
  onAutostart: (on: boolean) => void;
  onSettings: () => void;
  /** Close and never show the hint again. */
  onDismiss: () => void;
  onClose: () => void;
}) {
  const t = useT();
  const dlg = useDialogTheme();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const rows = [
    {
      Icon: MonitorPause,
      label: t("Keep running in the tray"),
      text: t("Closing the window hides MiColl next to the clock instead of ending it."),
      on: tray,
      change: onTray,
    },
    {
      Icon: Power,
      label: t("Start with Windows"),
      text: t("MiColl starts when you sign in to Windows, with the tray on without a window."),
      on: autostart,
      change: onAutostart,
    },
  ];
  // to <body>, the page's boxes would move the fixed overlay
  return createPortal(
    <div
      onClick={onClose}
      className="fixed inset-0 z-[120] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
    >
      <motion.div
        initial={{ opacity: 0, y: 12, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal
        className={cn("w-[32rem] max-w-full p-5", dlg.panel)}
      >
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-semibold text-zinc-100">{t("Let it always run")}</h2>
            <p className="mt-1 text-sm text-zinc-300">
              {t("The lock screen and the screen saver only work while MiColl is running. With these two on they’re always there, without a window open.")}
            </p>
          </div>
          <button onClick={onClose} title={t("Close")} className="text-zinc-500 transition-colors hover:text-zinc-300">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="mt-4 flex flex-col gap-2.5">
          {rows.map(({ Icon, label, text, on, change }) => (
            <div key={label} className={cn("flex items-center gap-3 p-3", dlg.box)}>
              <Icon className={cn("h-5 w-5 shrink-0", dlg.accentText)} />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-x-2 text-sm font-semibold text-zinc-100">
                  {label}
                  {!on && <span className={cn("text-xs font-medium", dlg.accentText)}>{t("Recommended")}</span>}
                </div>
                <p className="mt-0.5 text-xs text-zinc-400">{text}</p>
              </div>
              <Toggle checked={on} label={label} onChange={change} />
            </div>
          ))}
        </div>
        <div className="mt-5 flex flex-wrap items-center gap-2">
          <Button variant="ghost" onClick={onDismiss} title={t("Don’t show this hint again")}>
            {t("Dismiss")}
          </Button>
          <div className="flex-1" />
          <Button variant="outline" onClick={onSettings}>
            {t("Settings")}
          </Button>
          <Button variant="primary" onClick={onClose} className={dlg.primary}>
            {t("Close")}
          </Button>
        </div>
      </motion.div>
    </div>,
    document.body,
  );
}

function Toggle({ checked, label, onChange }: { checked: boolean; label: string; onChange: (v: boolean) => void }) {
  const accent = useAccent();
  return (
    <button
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={cn(
        // cyberpunk styles these as power cells with a bolt knob (index.css)
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
