import { useState } from "react";
import { motion } from "framer-motion";
import { Files, Replace, Copy, Ban } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { useT, useTf } from "@/lib/i18n";
import type { ConflictChoice, FillConflict } from "@/api/library";

/**
 * Asks for each incoming file that already exists in the reward folder ("File n of x"):
 *   • Replace - overwrite the existing file
 *   • Rename  - keep both, the new one gets " (2)"
 *   • Skip    - don't import it
 * "Apply to all remaining" uses the same choice for the rest.
 * onResolve gets all choices, cancel calls onCancelAll (nothing is copied).
 */
export function ConflictDialog({
  conflicts,
  onResolve,
  onCancelAll,
}: {
  conflicts: FillConflict[];
  onResolve: (resolutions: Record<string, ConflictChoice>) => void;
  onCancelAll: () => void;
}) {
  const t = useT();
  const tf = useTf();
  const [index, setIndex] = useState(0);
  const [resolutions, setResolutions] = useState<Record<string, ConflictChoice>>({});
  const [applyAll, setApplyAll] = useState(false);

  const total = conflicts.length;
  const current = conflicts[index];
  if (!current) return null;

  const choose = (choice: ConflictChoice) => {
    const next = { ...resolutions };
    if (applyAll) {
      for (let i = index; i < total; i++) next[conflicts[i].rel] = choice;
      onResolve(next);
      return;
    }
    next[current.rel] = choice;
    if (index + 1 >= total) {
      onResolve(next);
    } else {
      setResolutions(next);
      setIndex(index + 1);
    }
  };

  return (
    // above the import review (z-50) and its clash dialog (z-130)
    <div className="fixed inset-0 z-[140] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
      <motion.div
        initial={{ opacity: 0, y: 12, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        className="w-[30rem] rounded-2xl border border-zinc-800 bg-zinc-900 p-5 shadow-2xl"
      >
        <div className="flex items-start gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-amber-500/15 text-amber-300">
            <Files className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-zinc-100">
              {t("File already exists")}
              {total > 1 ? ` (${tf("{i} of {n}", { i: index + 1, n: total })})` : ""}
            </h2>
            <p className="mt-1 text-sm text-zinc-400">
              {t("A file named")}{" "}
              <span className="break-all font-medium text-zinc-200">{current.name}</span>{" "}
              {t("is already in this folder. What would you like to do?")}
            </p>
          </div>
        </div>

        {total > 1 && (
          <label className="mt-4 flex cursor-pointer items-center gap-2 text-sm text-zinc-400">
            <input
              type="checkbox"
              checked={applyAll}
              onChange={(e) => setApplyAll(e.target.checked)}
              className="h-4 w-4 rounded border-zinc-600 bg-zinc-800 accent-brand-500"
            />
            {tf("Apply to all remaining {n} conflicts", { n: total - index })}
          </label>
        )}

        <div className="mt-5 grid gap-2">
          <Button variant="primary" onClick={() => choose("replace")} className="justify-start">
            <Replace className="h-4 w-4" />
            {t("Replace the existing file")}
          </Button>
          <Button variant="outline" onClick={() => choose("rename")} className="justify-start">
            <Copy className="h-4 w-4" />
            {t("Keep both — import as a renamed copy")}
          </Button>
          <Button variant="outline" onClick={() => choose("skip")} className="justify-start">
            <Ban className="h-4 w-4" />
            {t("Skip — don’t import this file")}
          </Button>
        </div>

        <div className="mt-4 flex justify-end border-t border-zinc-800 pt-3">
          <Button variant="ghost" onClick={onCancelAll}>
            {t("Cancel import")}
          </Button>
        </div>
      </motion.div>
    </div>
  );
}
