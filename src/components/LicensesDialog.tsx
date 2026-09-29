import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { motion } from "framer-motion";
import { Scale, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { useDialogTheme } from "@/lib/dialogTheme";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n";

/**
 * Shows the third-party license list (src/assets/third-party-licenses.txt, made by
 * `npm run licenses`). The file is ~450 KB, so it's only loaded when this opens.
 */
export function LicensesDialog({ onClose }: { onClose: () => void }) {
  const t = useT();
  const { panel, box, primary } = useDialogTheme();
  const [text, setText] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    import("@/assets/third-party-licenses.txt?raw")
      .then((m) => alive && setText(m.default))
      .catch((e) => alive && setText(`${e}`));
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // portaled to <body>, otherwise a transformed parent would move the fixed overlay
  return createPortal(
    <div
      className="fixed inset-0 z-[120] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <motion.div
        initial={{ opacity: 0, y: 12, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        onClick={(e) => e.stopPropagation()}
        className={cn("flex max-h-[85vh] w-[48rem] max-w-full flex-col p-5", panel)}
      >
        <div className="flex items-center justify-between gap-3">
          <h2 className="flex items-center gap-2 text-base font-semibold text-zinc-100">
            <Scale className="h-5 w-5 text-brand-300" />
            {t("Third-party licenses")}
          </h2>
          <button
            type="button"
            onClick={onClose}
            title={t("Close")}
            className="rounded p-1 text-zinc-400 transition-colors hover:text-zinc-100"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <pre
          className={cn(
            "mt-3 min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words p-3 font-mono text-[11px] leading-relaxed text-zinc-300",
            box,
          )}
        >
          {text ?? t("Loading…")}
        </pre>
        <div className="mt-4 flex justify-end">
          <Button variant="primary" onClick={onClose} className={primary}>
            {t("Close")}
          </Button>
        </div>
      </motion.div>
    </div>,
    document.body,
  );
}
