import { useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import { useAccent } from "@/lib/theme";
import { useDialogTheme } from "@/lib/dialogTheme";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n";

/** The steps an import runs through, in order (see doImport in actions.tsx). */
export type ImportStep = "commit" | "organize" | "encrypt" | "refresh" | "done";

/** How much of the bar each step gets (the move into the collection is the long one). */
const WEIGHT: Record<Exclude<ImportStep, "done">, number> = {
  commit: 30,
  organize: 50,
  encrypt: 12,
  refresh: 8,
};

/**
 * Loading bar under the import review while an import runs. The backend doesn't report
 * per file, so it shows the real steps: each one owns a stretch of the bar, the fill
 * creeps through that stretch (slowing down, never past it) and jumps on when the step
 * is done. Styled per theme in index.css (.imp-*).
 */
export function ImportProgress({ steps, step }: { steps: ImportStep[]; step: ImportStep }) {
  const t = useT();
  const accent = useAccent();
  const dlg = useDialogTheme();

  // where the current step's stretch starts and ends (0..100)
  const real = steps.filter((s): s is Exclude<ImportStep, "done"> => s !== "done");
  const total = real.reduce((n, s) => n + WEIGHT[s], 0) || 1;
  let from = 0;
  let to = 100;
  if (step !== "done") {
    let acc = 0;
    for (const s of real) {
      if (s === step) {
        from = (acc / total) * 100;
        to = ((acc + WEIGHT[s]) / total) * 100;
        break;
      }
      acc += WEIGHT[s];
    }
  } else from = 100;

  // creep: 1 - e^(-t/τ) of the stretch, at most 92 % of it until the step is done
  const [pct, setPct] = useState(from);
  const startRef = useRef(performance.now());
  useEffect(() => {
    startRef.current = performance.now();
    setPct((p) => Math.max(p, from));
    if (step === "done") return;
    const id = window.setInterval(() => {
      const secs = (performance.now() - startRef.current) / 1000;
      const share = 0.92 * (1 - Math.exp(-secs / 1.5));
      setPct((p) => Math.max(p, from + (to - from) * share));
    }, 100);
    return () => window.clearInterval(id);
  }, [step, from, to]);

  const label =
    step === "commit"
      ? t("Adding to your library…")
      : step === "organize"
        ? t("Moving into your collection…")
        : step === "encrypt"
          ? t("Encrypting the new files…")
          : step === "refresh"
            ? t("Finishing up…")
            : t("Done");

  return (
    <motion.div
      initial={{ opacity: 0, y: -6 }}
      animate={{ opacity: 1, y: 0 }}
      className={cn("imp-card w-[46rem] max-w-full px-4 py-3", dlg.panel)}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(pct)}
      aria-label={label}
    >
      <div className="mb-2 flex items-center justify-between gap-3 text-xs">
        <span className={cn("imp-label font-medium", dlg.accentText)}>{label}</span>
        <span className="tabular-nums text-zinc-400">{Math.round(pct)}%</span>
      </div>
      <div className={cn("imp-track h-2 overflow-hidden", accent === "cyberpunk" ? "rounded-none" : "rounded-full")}>
        <div className="imp-fill h-full" style={{ width: `${pct}%` }} />
      </div>
    </motion.div>
  );
}
