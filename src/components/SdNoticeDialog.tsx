import { createPortal } from "react-dom";
import { motion } from "framer-motion";
import { HardDrive, Unplug } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { useDialogTheme } from "@/lib/dialogTheme";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n";

/**
 * Shown when opening a reward that's on the MiSD disk while the disk isn't connected.
 * Only info (no "don't show again"), the files are safe. Styled per theme.
 */
export function SdNoticeDialog({
  title,
  volume,
  onClose,
}: {
  /** The reward/creator the user tried to open. */
  title: string;
  /** Label of the MiSD disk. */
  volume: string;
  onClose: () => void;
}) {
  const t = useT();
  const dlg = useDialogTheme();
  // portaled to <body> so it centers in the window
  return createPortal(
    <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
      {/* keep the window draggable */}
      <div data-tauri-drag-region className="absolute inset-x-0 top-0 h-14" />
      <motion.div
        initial={{ opacity: 0, y: 12, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        className={cn("w-[26rem] max-w-full p-5", dlg.panel)}
      >
        <div className="flex items-start gap-3">
          <div
            className={cn(
              "flex h-9 w-9 shrink-0 items-center justify-center",
              dlg.box,
              dlg.accentText,
            )}
          >
            <HardDrive className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-zinc-100">{t("Stored on your MiSD disk")}</h2>
            <p className="mt-1 text-sm text-zinc-400">
              “<span className="text-zinc-200">{title}</span>” {t("lives on")}{" "}
              <b className={dlg.accentText}>{volume}</b>
              {t(
                ", which isn’t connected right now. The files are safe — plug the disk in and it opens like any other reward.",
              )}
            </p>
          </div>
        </div>
        <div className={cn("mt-4 flex items-center justify-between gap-2 border-t pt-4", dlg.divider)}>
          <span className="inline-flex items-center gap-1.5 text-xs text-zinc-500">
            <Unplug className="h-3.5 w-3.5" />
            {t("Disk not detected")}
          </span>
          <Button variant="primary" onClick={onClose}>
            {t("Got it")}
          </Button>
        </div>
      </motion.div>
    </div>,
    document.body,
  );
}
