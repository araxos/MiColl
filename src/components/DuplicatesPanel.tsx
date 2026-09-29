import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { X, Loader2, Trash2, Check, Maximize2 } from "lucide-react";
import { Cover } from "@/components/Cover";
import { useData } from "@/store";
import { findDuplicates, deleteImage, type DuplicateImage } from "@/api/library";
import { type DuplicateScope } from "@/lib/duplicates";
import { useAccent } from "@/lib/theme";
import { useDialogTheme } from "@/lib/dialogTheme";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n";

function fmtBytes(n: number): string {
  if (n <= 0) return "0 B";
  const u = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${u[i]}`;
}

/** Fullscreen side-by-side compare of one group's images. */
function CompareView({ images, onClose }: { images: DuplicateImage[]; onClose: () => void }) {
  const t = useT();
  const dlg = useDialogTheme();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center gap-1 bg-black p-2"
      onClick={onClose}
    >
      {images.map((im) => (
        <div key={im.id} className="flex h-full min-w-0 flex-1 items-center justify-center">
          <Cover path={im.path} seed={im.reward} size={1600} rounded="rounded-none" className="object-contain" />
        </div>
      ))}
      {/* the only visible button here, so it carries the theme */}
      <button
        onClick={onClose}
        className={cn("absolute right-3 top-3 p-2", dlg.control)}
        title={t("Close (Esc)")}
      >
        <X className="h-5 w-5" />
      </button>
    </div>
  );
}

/**
 * Finds duplicate images and lets you keep one per group and delete the rest.
 * "Compare" shows a group side by side.
 * Two modes: exact copies (default) or images that look the same (e.g. resized copies).
 */
export function DuplicatesPanel({
  scope,
  onClose,
}: {
  scope?: DuplicateScope;
  onClose: () => void;
}) {
  const t = useT();
  const { refresh } = useData();
  // uses the dialog theme. sharp = cyberpunk square corners for the few own-colored
  // controls
  const accent = useAccent();
  const dlg = useDialogTheme();
  const sharp = accent === "cyberpunk";
  const [loading, setLoading] = useState(true);
  const [groups, setGroups] = useState<DuplicateImage[][]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [compare, setCompare] = useState<DuplicateImage[] | null>(null);
  // off = exact copies only, on = also resized/re-saved ones. Off by default since this
  // deletes files.
  const [similar, setSimilar] = useState(false);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    findDuplicates(scope, similar)
      .then((g) => {
        if (!alive) return;
        setGroups(g);
        const sel = new Set<string>();
        g.forEach((grp) => grp.slice(1).forEach((im) => sel.add(im.id)));
        setSelected(sel);
      })
      .catch(() => alive && setGroups([]))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [scope?.artistId, scope?.platform, scope?.periodId, similar]);

  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const dupCount = groups.reduce((n, g) => n + g.length, 0);

  const deleteSelected = async () => {
    if (selected.size === 0) return;
    setBusy(true);
    try {
      for (const id of selected) {
        await deleteImage(id, true).catch(() => {});
      }
      await refresh();
      setGroups((gs) =>
        gs.map((g) => g.filter((im) => !selected.has(im.id))).filter((g) => g.length > 1),
      );
      setSelected(new Set());
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
      <motion.div
        initial={{ opacity: 0, y: 12, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        className={cn("flex max-h-[92vh] w-[52rem] max-w-full flex-col overflow-hidden", dlg.panel)}
      >
        <div className={cn("flex items-center justify-between border-b px-5 py-4", dlg.divider)}>
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-zinc-100">
              Duplicate finder
              {scope?.label && <span className="text-zinc-400"> · {scope.label}</span>}
            </h2>
            <p className="text-xs text-zinc-500">
              {loading
                ? "Scanning…"
                : groups.length === 0
                  ? similar
                    ? "Nothing here looks alike."
                    : "No exact duplicates here."
                  : `${groups.length} group(s) · ${dupCount} images · ${selected.size} marked to delete`}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {/* two separate modes, exact and similar results never mixed in one list */}
            <div className={cn("flex overflow-hidden", dlg.field)}>
              {[
                { on: false, label: t("Identical"), hint: t("Byte-for-byte identical files") },
                {
                  on: true,
                  label: t("Similar"),
                  hint: t("Also finds resized or re-saved copies — slower, and can group different pictures"),
                },
              ].map((m) => (
                <button
                  key={m.label}
                  onClick={() => setSimilar(m.on)}
                  title={m.hint}
                  disabled={busy}
                  className={cn(
                    "px-2.5 py-1 text-[11px] font-medium transition-colors",
                    similar === m.on
                      ? cn(dlg.menuRowOpen, dlg.accentText)
                      : cn("text-zinc-400", dlg.menuRow),
                  )}
                >
                  {m.label}
                </button>
              ))}
            </div>
            <button onClick={onClose} className="text-zinc-500 hover:text-zinc-300">
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {loading ? (
            <div className="grid place-items-center py-20 text-zinc-400">
              <Loader2 className={cn("h-8 w-8 animate-spin", dlg.accentText)} />
              <p className="mt-3 text-sm">
                {similar ? "Comparing pictures…" : "Comparing files…"}
              </p>
              {similar && (
                <p className="mt-1 text-xs text-zinc-500">
                  {t("Every image has to be looked at once — the first run is the slow one.")}
                </p>
              )}
            </div>
          ) : groups.length === 0 ? (
            <div className="grid place-items-center gap-2 py-20 text-center">
              {/* "nothing found" uses the accent color, not green */}
              <Check className={cn("h-8 w-8", dlg.accentText)} />
              <p className="text-sm text-zinc-300">
                {similar ? "No look-alike images found." : "No identical images found."}
              </p>
            </div>
          ) : (
            <div className="space-y-5">
              {similar && (
                // the warning text stays amber
                <p className={cn("px-3 py-2 text-xs text-amber-200", dlg.box)}>
                  These are grouped by how they look, not by their contents — two
                  different pictures can land together. The biggest version of each
                  group is the one kept; check a group with Compare before deleting.
                </p>
              )}
              {groups.map((g, gi) => (
                <div key={gi} className={cn("p-3", dlg.box)}>
                  <div className="mb-2 flex items-center justify-between">
                    <span className="text-xs font-medium uppercase tracking-wide text-zinc-500">
                      Group {gi + 1} · {g.length} {similar ? "similar" : "identical"} copies
                    </span>
                    <button
                      onClick={() => setCompare(g)}
                      className={cn(
                        "inline-flex items-center gap-1 px-2 py-1 text-[11px]",
                        dlg.control,
                      )}
                      title={t("View full size, side by side")}
                    >
                      <Maximize2 className="h-3 w-3" />
                      {t("Compare")}
                    </button>
                  </div>
                  <div className="grid grid-cols-[repeat(auto-fill,minmax(120px,1fr))] gap-2.5">
                    {g.map((im) => {
                      const del = selected.has(im.id);
                      return (
                        <button
                          key={im.id}
                          onClick={() => toggle(im.id)}
                          className={cn(
                            "group relative overflow-hidden border-2 text-left transition-colors",
                            sharp ? "rounded-none" : "rounded-lg",
                            // keep/delete stays green/red in every theme
                            del ? "border-rose-500/70" : "border-emerald-500/60",
                          )}
                        >
                          <div className="aspect-square w-full">
                            <Cover path={im.path} seed={im.reward} size={400} rounded="rounded-none" />
                          </div>
                          <span
                            className={cn(
                              "absolute left-1.5 top-1.5 inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide backdrop-blur",
                              sharp ? "rounded-none" : "rounded-md",
                              del ? "bg-rose-500/85 text-white" : "bg-emerald-500/85 text-white",
                            )}
                          >
                            {del ? <Trash2 className="h-3 w-3" /> : <Check className="h-3 w-3" />}
                            {del ? "Delete" : "Keep"}
                          </span>
                          <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/90 to-transparent p-1.5 pt-6">
                            <div className="truncate text-[11px] font-medium text-white" title={im.name}>
                              {im.name}
                            </div>
                            <div className="truncate text-[10px] text-zinc-300">
                              {im.width > 0 ? `${im.width}×${im.height} · ` : ""}
                              {fmtBytes(im.bytes)}
                            </div>
                            <div className="truncate text-[10px] text-zinc-400" title={`${im.artist} · ${im.reward}`}>
                              {im.artist} · {im.reward}
                            </div>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className={cn("flex items-center justify-between gap-3 border-t px-5 py-3.5", dlg.divider)}>
          <span className="text-xs text-zinc-500">
            {t("Click a tile to keep/delete it · Compare to view full size. Deleting → Recycle Bin.")}
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              className={cn("px-3 py-1.5 text-sm", dlg.control)}
            >
              {t("Close")}
            </button>
            {/* delete button stays red, only the shape follows the theme */}
            <button
              onClick={() => void deleteSelected()}
              disabled={busy || selected.size === 0}
              className={cn(
                "inline-flex items-center gap-1.5 border border-rose-500/40 bg-rose-500/10 px-3 py-1.5 text-sm font-medium text-rose-200 transition-colors hover:bg-rose-500/20 disabled:opacity-40",
                sharp ? "rounded-none" : "rounded-lg",
              )}
            >
              <Trash2 className={`h-4 w-4 ${busy ? "animate-pulse" : ""}`} />
              Delete {selected.size} selected
            </button>
          </div>
        </div>
      </motion.div>

      {compare && <CompareView images={compare} onClose={() => setCompare(null)} />}
    </div>
  );
}
