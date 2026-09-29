import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { motion } from "framer-motion";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { useDialogTheme } from "@/lib/dialogTheme";
import { cn } from "@/lib/utils";

/**
 * Blocking progress overlay for long file operations. Nothing behind it can be
 * clicked, so things like verify -> delete can't run twice at once.
 * Portaled to <body>. Long jobs should offer onCancel.
 */
export function ProgressModal({
  title,
  detail,
  done,
  total,
  note,
  onCancel,
  cancelLabel,
  cancelPendingLabel,
}: {
  title: string;
  /** Current item (a folder name), optional. */
  detail?: string;
  done: number;
  /** 0 = unknown -> bar without a value. */
  total: number;
  note?: React.ReactNode;
  /** Cancel button, only for jobs that can stop safely. */
  onCancel?: () => void;
  cancelLabel?: string;
  /** Shown after clicking: it stops after the current item. */
  cancelPendingLabel?: string;
}) {
  // block keyboard shortcuts while it's open
  useEffect(() => {
    const stop = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener("keydown", stop, true);
    return () => window.removeEventListener("keydown", stop, true);
  }, []);

  // only ask once, the job checks the flag at its next safe point
  const [asked, setAsked] = useState(false);

  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
  // premium themes use their own surface and fill
  const { panel, accent, accentText } = useDialogTheme();

  return createPortal(
    <div className="fixed inset-0 z-[125] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
      <motion.div
        initial={{ opacity: 0, y: 12, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        className={cn("w-[26rem] p-5", panel)}
      >
        <div className="flex items-center gap-2.5">
          <Loader2 className={cn("h-4 w-4 animate-spin", accentText)} />
          <h2 className="text-base font-semibold text-zinc-100">{title}</h2>
          {total > 0 && (
            <span className="ml-auto text-sm tabular-nums text-zinc-400">
              {done}/{total}
            </span>
          )}
        </div>

        <div className="mt-3 h-2 overflow-hidden rounded-full bg-white/10">
          {total > 0 ? (
            <motion.div
              className={cn("h-full rounded-full", accent)}
              animate={{ width: `${pct}%` }}
              transition={{ duration: 0.25 }}
            />
          ) : (
            // accent can be a gradient, so use opacity instead of /70
            <div className={cn("h-full w-1/3 animate-pulse rounded-full opacity-70", accent)} />
          )}
        </div>

        <p className="mt-2 truncate text-xs text-zinc-400" title={detail}>
          {detail || "Preparing…"}
        </p>
        {note && <p className="mt-3 text-xs text-zinc-500">{note}</p>}

        {onCancel && (
          <div className="mt-4 flex justify-end">
            <Button
              variant="outline"
              size="sm"
              disabled={asked}
              onClick={() => {
                setAsked(true);
                onCancel();
              }}
            >
              {asked ? cancelPendingLabel : cancelLabel}
            </Button>
          </div>
        )}
      </motion.div>
    </div>,
    document.body,
  );
}
