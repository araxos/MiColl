import { motion } from "framer-motion";
import { FolderSymlink, FolderPlus, TextCursorInput, Ban } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { useDialogTheme } from "@/lib/dialogTheme";
import type { ImportClash } from "@/api/library";
import { cn } from "@/lib/utils";
import { useT, useTf } from "@/lib/i18n";

/**
 * Shown before an import when a reward name already exists in that month.
 * Without it both would end up in the same folder and the new card would point
 * to a deleted folder. Options: merge, rename or cancel.
 */
export function ImportClashDialog({
  clashes,
  busy,
  onMerge,
  onRename,
  onCancelAll,
}: {
  clashes: ImportClash[];
  busy: boolean;
  /** Add the files to the existing reward folder. */
  onMerge: () => void;
  /** Back to the review with the first clashing name selected. */
  onRename: () => void;
  /** Cancel the import and close the review. */
  onCancelAll: () => void;
}) {
  const t = useT();
  const tf = useTf();
  const dlg = useDialogTheme();
  const many = clashes.length > 1;
  const first = clashes[0];
  if (!first) return null;

  return (
    <div className="fixed inset-0 z-[130] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
      <motion.div
        initial={{ opacity: 0, y: 12, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        className={cn("w-[34rem] max-w-full p-5", dlg.panel)}
      >
        <div className="flex items-start gap-3">
          <div
            className={cn(
              "flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-amber-500/15 text-amber-300",
            )}
          >
            <FolderSymlink className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-zinc-100">
              {many
                ? tf("That name is already taken ({n} of them)", { n: clashes.length })
                : t("That name is already taken")}
            </h2>
            <p className="mt-1 text-sm text-zinc-400">
              {many ? (
                <>
                  {tf(
                    "{n} of the rewards you’re importing have names that already exist where they’d land — starting with",
                    { n: clashes.length },
                  )}{" "}
                  <span className="font-medium text-zinc-200">“{first.title}”</span>.
                </>
              ) : (
                <>
                  <span className="font-medium text-zinc-200">“{first.title}”</span>{" "}
                  {t("already exists in")}{" "}
                  <span className="font-medium text-zinc-200">{first.location}</span>.
                </>
              )}
            </p>
          </div>
        </div>

        {many && (
          <ul className={cn("mt-4 max-h-32 overflow-y-auto rounded-lg border p-2 text-xs", dlg.soft)}>
            {clashes.map((c) => (
              <li key={c.folder} className="flex items-baseline gap-2 py-0.5">
                <span className="truncate font-medium text-zinc-200">{c.title}</span>
                <span className="truncate text-zinc-500">{c.location}</span>
              </li>
            ))}
          </ul>
        )}

        <div className="mt-4 grid gap-2">
          <button
            disabled={busy}
            onClick={onMerge}
            className={cn(
              "flex items-start gap-3 px-3.5 py-3 text-left transition-colors hover:brightness-125 disabled:opacity-50",
              dlg.box,
            )}
          >
            <FolderPlus className={cn("mt-0.5 h-5 w-5 shrink-0", dlg.accentText)} />
            <span>
              <span className="block text-sm font-medium text-zinc-100">
                {many ? t("Add them to the existing reward") : t("Add it to the existing reward")}
              </span>
              <span className="block text-xs text-zinc-400">
                {t(
                  "The files go into the folder that’s already there. Same-named files are kept side by side unless you say otherwise.",
                )}
              </span>
            </span>
          </button>
          <button
            disabled={busy}
            onClick={onRename}
            className={cn(
              "flex items-start gap-3 px-3.5 py-3 text-left transition-colors hover:brightness-125 disabled:opacity-50",
              dlg.box,
            )}
          >
            <TextCursorInput className={cn("mt-0.5 h-5 w-5 shrink-0", dlg.accentText)} />
            <span>
              <span className="block text-sm font-medium text-zinc-100">
                {many ? t("Give them a different name") : t("Give it a different name")}
              </span>
              <span className="block text-xs text-zinc-400">
                {t(
                  "Back to the review with the name selected — type the new one and import again. Nothing has been written yet.",
                )}
              </span>
            </span>
          </button>
          <button
            disabled={busy}
            onClick={onCancelAll}
            className={cn(
              "flex items-start gap-3 px-3.5 py-3 text-left transition-colors hover:brightness-125 disabled:opacity-50",
              dlg.box,
            )}
          >
            <Ban className="mt-0.5 h-5 w-5 shrink-0 text-rose-300" />
            <span>
              <span className="block text-sm font-medium text-zinc-100">{t("Cancel the import")}</span>
              <span className="block text-xs text-zinc-400">
                {t("Close this and import nothing at all.")}
              </span>
            </span>
          </button>
        </div>

        <div className={cn("mt-4 flex justify-end border-t pt-3", dlg.divider)}>
          <Button variant="ghost" onClick={onCancelAll} disabled={busy}>
            {t("Cancel import")}
          </Button>
        </div>
      </motion.div>
    </div>
  );
}
