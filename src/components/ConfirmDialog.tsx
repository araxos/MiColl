import { createPortal } from "react-dom";
import { motion } from "framer-motion";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { useDialogTheme } from "@/lib/dialogTheme";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n";

/** Small dialog to confirm a destructive action. */
export function ConfirmDialog({
  title,
  body,
  confirmLabel,
  extraLabel,
  onExtra,
  busy = false,
  onConfirm,
  onCancel,
}: {
  title: string;
  body: React.ReactNode;
  confirmLabel?: string;
  /** Optional second button next to Confirm. */
  extraLabel?: string;
  onExtra?: () => void;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  // premium themes use their own surface and button fill
  const t = useT();
  const { panel, primary } = useDialogTheme();

  // portaled to <body>, otherwise a transformed parent would move the fixed overlay
  return createPortal(
    <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
      <motion.div
        initial={{ opacity: 0, y: 12, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        className={cn("w-[28rem] p-5", panel)}
      >
        <div className="flex items-start gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-amber-500/15 text-amber-300">
            <AlertTriangle className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-zinc-100">{title}</h2>
            <div className="mt-1 text-sm text-zinc-400">{body}</div>
          </div>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={onCancel} disabled={busy}>
            {t("Cancel")}
          </Button>
          {extraLabel && onExtra && (
            <Button variant="outline" onClick={onExtra} disabled={busy}>
              {extraLabel}
            </Button>
          )}
          <Button variant="primary" onClick={onConfirm} disabled={busy} className={primary}>
            {busy ? t("Working…") : (confirmLabel ?? t("Confirm"))}
          </Button>
        </div>
      </motion.div>
    </div>,
    document.body,
  );
}
