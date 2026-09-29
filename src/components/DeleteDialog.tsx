import { useState } from "react";
import { motion } from "framer-motion";
import { Trash2, Database, HardDrive } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { useDialogTheme } from "@/lib/dialogTheme";
import { useAccent } from "@/lib/theme";
import { cn } from "@/lib/utils";
import { useT, useTf } from "@/lib/i18n";

/**
 * Asks how to delete a reward: only from MiColl, or also move the files to the
 * Recycle Bin. Can remember the choice.
 * The panel follows the theme, but the red stays red (it's a warning).
 */
export function DeleteDialog({
  title,
  busy,
  onConfirm,
  onCancel,
}: {
  title: string;
  busy: boolean;
  onConfirm: (alsoFiles: boolean, dontAskAgain: boolean) => void;
  onCancel: () => void;
}) {
  const t = useT();
  const tf = useTf();
  const dlg = useDialogTheme();
  const accent = useAccent();
  const [alsoFiles, setAlsoFiles] = useState(false);
  const [dontAsk, setDontAsk] = useState(false);

  // square corners on cyberpunk
  const square = accent === "cyberpunk";
  const round = square ? "rounded-none" : "rounded-xl";
  // both options have a 2px border so picking one doesn't move the text
  const rowBase = cn("flex w-full items-start gap-3 border-2 p-3 text-left transition-colors", round);
  const resting = cn(dlg.soft, dlg.menuRow);

  return (
    <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
      <motion.div
        initial={{ opacity: 0, y: 12, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        className={cn("w-[28rem] max-w-full p-5", dlg.panel)}
      >
        <div className="flex items-start gap-3">
          <div
            className={cn(
              "flex h-9 w-9 shrink-0 items-center justify-center bg-rose-500/15 text-rose-300",
              square ? "rounded-none" : "rounded-lg",
            )}
          >
            <Trash2 className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-zinc-100">
              {tf("Delete “{name}”?", { name: title })}
            </h2>
            <p className="mt-0.5 text-sm text-zinc-400">{t("Choose what to remove.")}</p>
          </div>
        </div>

        <div className="mt-4 space-y-2">
          <button
            onClick={() => setAlsoFiles(false)}
            // the safe option gets the theme's "picked" rim
            className={cn(rowBase, !alsoFiles ? "pick-on" : resting)}
          >
            <Database className="mt-0.5 h-4 w-4 shrink-0 text-zinc-400" />
            <div>
              <div className="text-sm font-medium text-zinc-100">{t("Remove from MiColl only")}</div>
              <div className="text-xs text-zinc-500">{t("Your files on disk stay untouched.")}</div>
            </div>
          </button>
          <button
            onClick={() => setAlsoFiles(true)}
            className={cn(
              rowBase,
              alsoFiles
                ? "border-rose-500/70 bg-rose-500/10 shadow-[0_0_14px_rgba(244,63,94,0.28)]"
                : resting,
            )}
          >
            <HardDrive className="mt-0.5 h-4 w-4 shrink-0 text-zinc-400" />
            <div>
              <div className="text-sm font-medium text-zinc-100">{t("Delete files too")}</div>
              <div className="text-xs text-zinc-500">{t("Sends the files to the Recycle Bin.")}</div>
            </div>
          </button>
        </div>

        {/* accent-brand-500 follows the current theme color */}
        <label className="mt-4 flex cursor-pointer items-center gap-2 text-sm text-zinc-300">
          <input
            type="checkbox"
            checked={dontAsk}
            onChange={(e) => setDontAsk(e.target.checked)}
            className="h-4 w-4 accent-brand-500"
          />
          {t("Don’t ask again (remember my choice)")}
        </label>

        <div className={cn("mt-5 flex justify-end gap-2 border-t pt-4", dlg.divider)}>
          <Button variant="ghost" onClick={onCancel} disabled={busy}>
            {t("Cancel")}
          </Button>
          <Button
            variant="primary"
            onClick={() => onConfirm(alsoFiles, dontAsk)}
            disabled={busy}
            // red has to win over the premium button fills (hence ! and background-image
            // none)
            className={
              alsoFiles
                ? "!border-0 !bg-rose-600 !text-white [background-image:none] shadow-lg shadow-rose-900/30 hover:!bg-rose-500"
                : undefined
            }
          >
            {busy ? t("Deleting…") : alsoFiles ? t("Delete files") : t("Remove")}
          </Button>
        </div>
      </motion.div>
    </div>
  );
}
