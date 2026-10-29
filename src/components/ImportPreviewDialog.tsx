import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { motion } from "framer-motion";
import { Images, Loader2, PlayCircle, X } from "lucide-react";
import { Cover } from "@/components/Cover";
import { previewMedia } from "@/api/library";
import { useDialogTheme } from "@/lib/dialogTheme";
import { isVideoPath } from "@/lib/videoThumb";
import { cn } from "@/lib/utils";
import { useT, useTp } from "@/lib/i18n";

/** One reward of the period: its folder, and its subfolders that are rewards of their own. */
export interface PreviewReward {
  folder: string;
  title: string;
  skip: string[];
}

/** Thumbnails per reward. More is a long wait for a quick look. */
const LIMIT = 60;

/**
 * Small window over the import review with the pictures of one period, as small cached
 * thumbnails. Nothing loads before it opens.
 */
export function ImportPreviewDialog({
  label,
  rewards,
  onClose,
}: {
  label: string;
  rewards: PreviewReward[];
  onClose: () => void;
}) {
  const t = useT();
  const tp = useTp();
  const dlg = useDialogTheme();
  const [got, setGot] = useState<({ files: string[]; total: number } | null)[]>(() => rewards.map(() => null));

  useEffect(() => {
    let alive = true;
    rewards.forEach((r, i) => {
      previewMedia(r.folder, r.skip, LIMIT)
        .catch(() => ({ files: [], total: 0 }))
        .then((res) => alive && setGot((g) => g.map((x, k) => (k === i ? res : x))));
    });
    return () => {
      alive = false;
    };
  }, [rewards]);

  // Escape closes the preview, not the review under it
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  return createPortal(
    <div
      className="fixed inset-0 z-[120] flex items-center justify-center bg-black/50 p-4"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <motion.div
        initial={{ opacity: 0, y: 12, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        className={cn("flex max-h-[75vh] w-[36rem] max-w-full flex-col overflow-hidden", dlg.panel)}
      >
        <div className={cn("flex items-center gap-2 border-b px-4 py-3", dlg.divider)}>
          <Images className={cn("h-4 w-4", dlg.accentText)} />
          <h3 className="min-w-0 flex-1 truncate text-sm font-semibold text-zinc-100">
            {t("Preview")} · {label}
          </h3>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-300" title={t("Close")}>
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="flex-1 space-y-4 overflow-y-auto px-4 py-3">
          {rewards.map((r, i) => {
            const res = got[i];
            return (
              <section key={r.folder}>
                <div className="mb-1.5 flex items-baseline gap-2 text-xs">
                  <span className="truncate font-medium text-zinc-200">{r.title}</span>
                  {res && <span className="shrink-0 text-zinc-500">{tp("{n} files", res.total)}</span>}
                </div>
                {!res ? (
                  <Loader2 className="h-4 w-4 animate-spin text-zinc-500" />
                ) : res.files.length === 0 ? (
                  <p className="text-xs text-zinc-500">{t("No pictures or videos")}</p>
                ) : (
                  <div className="grid grid-cols-[repeat(auto-fill,minmax(64px,1fr))] gap-1.5">
                    {res.files.map((f) => (
                      <div
                        key={f}
                        title={f.split(/[\\/]/).pop()}
                        className="relative aspect-square overflow-hidden rounded-md bg-black/30"
                      >
                        <Cover path={f} seed={f} size={128} rounded="rounded-none" />
                        {isVideoPath(f) && (
                          <span className="pointer-events-none absolute inset-0 grid place-items-center">
                            <PlayCircle className="h-5 w-5 text-white/85 drop-shadow-[0_1px_3px_rgba(0,0,0,0.8)]" />
                          </span>
                        )}
                      </div>
                    ))}
                    {res.total > res.files.length && (
                      <div className="grid aspect-square place-items-center rounded-md border border-dashed border-white/15 text-xs text-zinc-400">
                        +{res.total - res.files.length}
                      </div>
                    )}
                  </div>
                )}
              </section>
            );
          })}
        </div>
      </motion.div>
    </div>,
    document.body,
  );
}
