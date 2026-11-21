import { motion } from "framer-motion";
import { CopyCheck, SkipForward, Copy, Ban } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { useDialogTheme } from "@/lib/dialogTheme";
import type { ImportKnown } from "@/api/library";
import { cn } from "@/lib/utils";
import { useT, useTf } from "@/lib/i18n";

/**
 * Shown before an import when rewards in it are already in the library by their files
 * (same names and sizes), whatever their folders are called: the same package again.
 * Options: skip them, import them anyway, or cancel.
 */
export function ImportKnownDialog({
  known,
  busy,
  onSkip,
  onImportAnyway,
  onCancelAll,
}: {
  known: ImportKnown[];
  busy: boolean;
  /** Leave these out, import the rest. */
  onSkip: () => void;
  /** Import everything, a second copy. */
  onImportAnyway: () => void;
  /** Cancel the import and close the review. */
  onCancelAll: () => void;
}) {
  const t = useT();
  const tf = useTf();
  const dlg = useDialogTheme();
  const many = known.length > 1;
  const first = known[0];
  if (!first) return null;

  const option = "flex items-start gap-3 px-3.5 py-3 text-left transition-colors hover:brightness-125 disabled:opacity-50";

  return (
    <div className="fixed inset-0 z-[130] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
      <motion.div
        initial={{ opacity: 0, y: 12, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        className={cn("w-[34rem] max-w-full p-5", dlg.panel)}
      >
        <div className="flex items-start gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-amber-500/15 text-amber-300">
            <CopyCheck className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-zinc-100">
              {many
                ? tf("{n} of these are already in your library", { n: known.length })
                : t("This is already in your library")}
            </h2>
            <p className="mt-1 text-sm text-zinc-400">
              {many ? (
                t("Their files are already there under another name — same file names and sizes.")
              ) : (
                <>
                  <span className="font-medium text-zinc-200">“{first.title}”</span>{" "}
                  {t("has the same files as")}{" "}
                  <span className="font-medium text-zinc-200">“{first.existingTitle}”</span>{" "}
                  <span className="text-zinc-500">({first.location})</span> —{" "}
                  {tf("{matched} of {files} files, same name and size.", { matched: first.matched, files: first.files })}
                </>
              )}
            </p>
          </div>
        </div>

        {many && (
          <ul className={cn("mt-4 max-h-40 overflow-y-auto rounded-lg border p-2 text-xs", dlg.soft)}>
            {known.map((k) => (
              <li key={k.folder} className="py-1">
                <div className="flex items-baseline gap-2">
                  <span className="truncate font-medium text-zinc-200">{k.title}</span>
                  <span className="shrink-0 tabular-nums text-zinc-500">
                    {k.matched}/{k.files}
                  </span>
                </div>
                <div className="truncate text-zinc-500">
                  = “{k.existingTitle}” · {k.location}
                </div>
              </li>
            ))}
          </ul>
        )}

        <div className="mt-4 grid gap-2">
          <button disabled={busy} onClick={onSkip} className={cn(option, dlg.box)}>
            <SkipForward className={cn("mt-0.5 h-5 w-5 shrink-0", dlg.accentText)} />
            <span>
              <span className="block text-sm font-medium text-zinc-100">
                {many ? t("Skip them, import the rest") : t("Skip it, import the rest")}
              </span>
              <span className="block text-xs text-zinc-400">
                {t("Nothing of them is imported, their folders stay where they are.")}
              </span>
            </span>
          </button>
          <button disabled={busy} onClick={onImportAnyway} className={cn(option, dlg.box)}>
            <Copy className={cn("mt-0.5 h-5 w-5 shrink-0", dlg.accentText)} />
            <span>
              <span className="block text-sm font-medium text-zinc-100">
                {many ? t("Import them anyway") : t("Import it anyway")}
              </span>
              <span className="block text-xs text-zinc-400">{t("You’ll have a second copy in the library.")}</span>
            </span>
          </button>
          <button disabled={busy} onClick={onCancelAll} className={cn(option, dlg.box)}>
            <Ban className="mt-0.5 h-5 w-5 shrink-0 text-rose-300" />
            <span>
              <span className="block text-sm font-medium text-zinc-100">{t("Cancel the import")}</span>
              <span className="block text-xs text-zinc-400">{t("Close this and import nothing at all.")}</span>
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
