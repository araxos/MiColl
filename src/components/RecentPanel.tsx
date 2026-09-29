import { motion } from "framer-motion";
import { X, History } from "lucide-react";
import { Cover } from "@/components/Cover";
import { useT } from "@/lib/i18n";
import type { Artist } from "@/types";

/** Right side drawer with the recently updated artists. */
export function RecentPanel({
  items,
  onPick,
  onClose,
}: {
  items: Artist[];
  onPick: (id: string) => void;
  onClose: () => void;
}) {
  const t = useT();
  return (
    <>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        onClick={onClose}
        className="fixed inset-0 z-40 bg-black/30"
      />
      <motion.aside
        initial={{ x: "100%" }}
        animate={{ x: 0 }}
        exit={{ x: "100%" }}
        transition={{ type: "spring", stiffness: 380, damping: 38 }}
        className="fixed right-0 top-0 z-50 flex h-full w-72 flex-col border-l border-brand-500/20 bg-gradient-to-b from-brand-950/85 to-zinc-950/95 shadow-2xl shadow-black/50 backdrop-blur-xl"
      >
        <div className="flex items-center justify-between border-b border-brand-500/20 px-4 py-3">
          <div className="flex items-center gap-2 text-sm font-semibold text-zinc-100">
            <History className="h-4 w-4 text-brand-300" />
            {t("Recently updated")}
          </div>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-200" title={t("Close")}>
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {items.length === 0 ? (
            <p className="p-4 text-center text-xs text-zinc-500">{t("Nothing updated yet.")}</p>
          ) : (
            items.map((a) => (
              <button
                key={a.id}
                onClick={() => onPick(a.id)}
                title={a.name}
                className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left transition-colors hover:bg-brand-500/10"
              >
                <div className="h-11 w-11 shrink-0 overflow-hidden rounded-md">
                  <Cover path={a.previewPath} seed={a.name} rounded="rounded-none" />
                </div>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-zinc-200">{a.name}</span>
                  {a.updatedAt && (
                    <span className="block text-[11px] text-zinc-500">{a.updatedAt.slice(0, 10)}</span>
                  )}
                </span>
              </button>
            ))
          )}
        </div>
      </motion.aside>
    </>
  );
}
