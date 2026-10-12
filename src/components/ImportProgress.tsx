import { useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import { useAccent } from "@/lib/theme";
import { useDialogTheme } from "@/lib/dialogTheme";
import { cn } from "@/lib/utils";
import { useT, useTf } from "@/lib/i18n";

/** The steps an import runs through, in order (see doImport in actions.tsx). */
export type ImportStep = "commit" | "organize" | "encrypt" | "refresh" | "done";

/** Where the backend is inside the current step (organize: rewards, encrypt: files). */
export type ImportSub = { done: number; total: number };

/** How much of the bar each step gets (the move into the collection is the long one). */
const WEIGHT: Record<Exclude<ImportStep, "done">, number> = {
  commit: 30,
  organize: 50,
  encrypt: 12,
  refresh: 8,
};

/**
 * Loading bar under the import review while an import runs. Each step owns a stretch of
 * the bar. Steps that report how far they are (moving into the collection, encrypting)
 * fill their stretch by that, creeping only through the item in work; the others creep
 * through the whole stretch (slowing down, never past it) and jump on when done. A strip at the bottom of the review panel (it grows open), styled per theme
 * in index.css (.imp-*).
 */
export function ImportProgress({
  steps,
  step,
  sub,
}: {
  steps: ImportStep[];
  step: ImportStep;
  sub?: ImportSub;
}) {
  const t = useT();
  const tf = useTf();
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

  // creep: 1 - e^(-t/τ), at most 92 % of what's left until the next report. With a
  // report it's (done + creep) / total of the stretch, so it never runs ahead
  const subDone = sub?.done ?? 0;
  const subTotal = sub?.total ?? 0;
  const [pct, setPct] = useState(from);
  const startRef = useRef(performance.now());
  // the reports come faster than the timer below, so they live in a ref (restarting the
  // timer on each one would keep it from ever ticking)
  const subRef = useRef({ done: subDone, total: subTotal });
  const shareAt = (secs: number) => {
    const { done, total } = subRef.current;
    const creep = 0.92 * (1 - Math.exp(-secs / 1.5));
    return total > 0 ? Math.min(1, (done + (done < total ? creep : 0)) / total) : creep;
  };
  useEffect(() => {
    startRef.current = performance.now();
    setPct((p) => Math.max(p, from));
    if (step === "done") return;
    const id = window.setInterval(() => {
      const secs = (performance.now() - startRef.current) / 1000;
      setPct((p) => Math.max(p, from + (to - from) * shareAt(secs)));
    }, 100);
    return () => window.clearInterval(id);
    // shareAt only reads refs
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, from, to]);
  // a report: jump to it, then creep through the next item
  useEffect(() => {
    subRef.current = { done: subDone, total: subTotal };
    if (subTotal === 0 || step === "done") return;
    startRef.current = performance.now();
    setPct((p) => Math.max(p, from + (to - from) * shareAt(0)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subDone, subTotal]);

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
      initial={{ height: 0, opacity: 0 }}
      animate={{ height: "auto", opacity: 1 }}
      exit={{ height: 0, opacity: 0 }}
      transition={{ duration: 0.22, ease: "easeOut" }}
      className={cn("imp-card shrink-0 overflow-hidden border-t", dlg.divider)}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(pct)}
      aria-label={label}
    >
      <div className="px-5 pb-4 pt-3">
      <div className="mb-2 flex items-center justify-between gap-3 text-xs">
        <span className={cn("imp-label font-medium", dlg.accentText)}>
          {label}
          {/* the rewards being filed in; encrypting checks the whole library, no count there */}
          {step === "organize" && subTotal > 0 && (
            <span className="ml-1.5 font-normal tabular-nums text-zinc-400">
              {tf("{i} of {n}", { i: Math.min(subDone + 1, subTotal), n: subTotal })}
            </span>
          )}
        </span>
        <span className="tabular-nums text-zinc-400">{Math.round(pct)}%</span>
      </div>
      <div className={cn("imp-track h-2 overflow-hidden", accent === "cyberpunk" ? "rounded-none" : "rounded-full")}>
        <div className="imp-fill h-full" style={{ width: `${pct}%` }} />
      </div>
      </div>
    </motion.div>
  );
}
