import { useState } from "react";
import { motion } from "framer-motion";
import { FolderInput, FolderTree, Files } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { useT, useTf } from "@/lib/i18n";

/**
 * Shown when moving a reward into another reward: keep the whole folder
 * (as a subfolder) or move only the files. The choice can be remembered.
 */
export function MergeChoiceDialog({
  count,
  destTitle,
  busy,
  onChoose,
  onCancel,
}: {
  /** How many rewards are merged. */
  count: number;
  /** Target reward title. */
  destTitle?: string;
  busy: boolean;
  onChoose: (keepFolder: boolean, dontAskAgain: boolean) => void;
  onCancel: () => void;
}) {
  const t = useT();
  const tf = useTf();
  const [dontAsk, setDontAsk] = useState(false);
  const what = count === 1 ? t("this folder") : tf("these {n} folders", { n: count });
  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
      <motion.div
        initial={{ opacity: 0, y: 12, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        className="w-[32rem] max-w-full rounded-2xl border border-zinc-800 bg-zinc-900 p-5 shadow-2xl"
      >
        <div className="flex items-start gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand-500/15 text-brand-300">
            <FolderInput className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-zinc-100">{t("Move into reward")}</h2>
            <p className="mt-1 text-sm text-zinc-400">
              {tf("How should {what} land", { what })}
              {destTitle ? (
                <>
                  {" "}
                  {t("in")} <span className="font-medium text-zinc-200">{destTitle}</span>
                </>
              ) : null}
              ?
            </p>
          </div>
        </div>

        <div className="mt-4 grid gap-2">
          <button
            disabled={busy}
            onClick={() => onChoose(false, dontAsk)}
            className="flex items-start gap-3 rounded-xl border border-zinc-800 bg-zinc-950/60 px-3.5 py-3 text-left transition-colors hover:border-brand-500/50 hover:bg-brand-500/5 disabled:opacity-50"
          >
            <Files className="mt-0.5 h-5 w-5 shrink-0 text-brand-300" />
            <span>
              <span className="block text-sm font-medium text-zinc-100">{t("Move only the files")}</span>
              <span className="block text-xs text-zinc-400">
                {t("Add the files directly into the reward (no wrapper folder).")}
              </span>
            </span>
          </button>
          <button
            disabled={busy}
            onClick={() => onChoose(true, dontAsk)}
            className="flex items-start gap-3 rounded-xl border border-zinc-800 bg-zinc-950/60 px-3.5 py-3 text-left transition-colors hover:border-brand-500/50 hover:bg-brand-500/5 disabled:opacity-50"
          >
            <FolderTree className="mt-0.5 h-5 w-5 shrink-0 text-brand-300" />
            <span>
              <span className="block text-sm font-medium text-zinc-100">{t("Move the whole folder")}</span>
              <span className="block text-xs text-zinc-400">
                {t("Keep it as its own subfolder inside the reward (structure preserved).")}
              </span>
            </span>
          </button>
        </div>

        <label className="mt-4 flex cursor-pointer items-center gap-2 text-sm text-zinc-300">
          <input
            type="checkbox"
            checked={dontAsk}
            onChange={(e) => setDontAsk(e.target.checked)}
            className="h-4 w-4 accent-brand-500"
          />
          {t("Remember my choice (don’t ask again)")}
        </label>

        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={onCancel} disabled={busy}>
            {t("Cancel")}
          </Button>
        </div>
      </motion.div>
    </div>
  );
}
