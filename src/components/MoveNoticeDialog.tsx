import { useState } from "react";
import { motion } from "framer-motion";
import { Boxes } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { useDialogTheme } from "@/lib/dialogTheme";
import { useAccent } from "@/lib/theme";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n";

/**
 * Info before an import in managed mode: the folder content will be MOVED into
 * the collection. Can be turned off ("don't show again"). Styled per theme.
 */
export function MoveNoticeDialog({
  collectionRoot,
  busy,
  onConfirm,
  onCancel,
}: {
  collectionRoot: string;
  busy: boolean;
  onConfirm: (dontShowAgain: boolean) => void;
  onCancel: () => void;
}) {
  const t = useT();
  const dlg = useDialogTheme();
  const accent = useAccent();
  const [dontShow, setDontShow] = useState(false);

  // square corners on cyberpunk
  const square = accent === "cyberpunk";

  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
      <motion.div
        initial={{ opacity: 0, y: 12, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        className={cn("w-[30rem] max-w-full p-5", dlg.panel)}
      >
        <div className="flex items-start gap-3">
          <div
            className={cn(
              "flex h-9 w-9 shrink-0 items-center justify-center",
              dlg.box,
              dlg.accentText,
            )}
          >
            <Boxes className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-zinc-100">{t("Files will be moved")}</h2>
            <p className="mt-1 text-sm text-zinc-400">
              <b>{t("Managed collection")}</b>{" "}
              {t("is on, so the folder you pick will be")} <b>{t("moved")}</b>{" "}
              {t("into your MiColl collection")}
              {collectionRoot ? (
                <>
                  {" "}
                  at{" "}
                  <code
                    className={cn(
                      "border px-1 py-0.5 text-zinc-200",
                      square ? "rounded-none" : "rounded",
                      dlg.soft,
                    )}
                  >
                    {collectionRoot}\MiColl
                  </code>
                </>
              ) : null}
              {t(
                ", arranged as Creator / Platform / Year / Month / Reward. The originals are relocated (not copied). You can turn this off in Settings.",
              )}
            </p>
          </div>
        </div>

        {/* accent-brand-500 follows the current theme color */}
        <label className="mt-4 flex cursor-pointer items-center gap-2 text-sm text-zinc-300">
          <input
            type="checkbox"
            checked={dontShow}
            onChange={(e) => setDontShow(e.target.checked)}
            className="h-4 w-4 accent-brand-500"
          />
          {t("Don’t show this again")}
        </label>

        <div className={cn("mt-5 flex justify-end gap-2 border-t pt-4", dlg.divider)}>
          <Button variant="ghost" onClick={onCancel} disabled={busy}>
            {t("Cancel")}
          </Button>
          {/* no dlg.primary, the primary Button already has each theme's fill */}
          <Button variant="primary" onClick={() => onConfirm(dontShow)} disabled={busy}>
            {busy ? t("Working…") : t("Choose folder & continue")}
          </Button>
        </div>
      </motion.div>
    </div>
  );
}
