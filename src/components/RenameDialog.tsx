import { useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { motion } from "framer-motion";
import { X, Pencil, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { renameRewards, renameImages, type RenameItem } from "@/api/library";
import { useDialogTheme } from "@/lib/dialogTheme";
import { useAccent } from "@/lib/theme";
import { cn } from "@/lib/utils";
import { useT, useTf, useTp } from "@/lib/i18n";

export interface RenameTarget {
  id: string;
  /** Current name. For images the file name with extension. */
  name: string;
}

/** "photo.jpg" -> ["photo", "jpg"], folders have no extension. */
function splitExt(name: string, hasExt: boolean): [string, string] {
  if (!hasExt) return [name, ""];
  const i = name.lastIndexOf(".");
  return i > 0 ? [name.slice(0, i), name.slice(i + 1)] : [name, ""];
}

/**
 * Rename one item, or several (base name + number, or find & replace) with a preview.
 * The backend renames on disk.
 */
export function RenameDialog({
  kind,
  targets,
  onClose,
  onDone,
}: {
  kind: "reward" | "image";
  targets: RenameTarget[];
  onClose: () => void;
  onDone: () => void;
}) {
  const t = useT();
  const tf = useTf();
  const tp = useTp();
  const dlg = useDialogTheme();
  // square corners on cyberpunk for the small controls too
  const accent = useAccent();
  const round = accent === "cyberpunk" ? "rounded-none" : "rounded-lg";
  const isImage = kind === "image";
  const bulk = targets.length > 1;

  // editable names (extension shown but not editable)
  const parts = useMemo(
    () => targets.map((x) => splitExt(x.name, isImage)),
    [targets, isImage],
  );

  const [single, setSingle] = useState(parts[0]?.[0] ?? "");
  const [mode, setMode] = useState<"number" | "replace">("number");
  const [base, setBase] = useState(parts[0]?.[0] ?? "");
  const [start, setStart] = useState("1");
  const [pad, setPad] = useState("2");
  const [find, setFind] = useState("");
  const [replace, setReplace] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // new name for each item
  const newStems = useMemo<string[]>(() => {
    if (!bulk) return [single.trim()];
    if (mode === "number") {
      const s = parseInt(start, 10);
      const startN = Number.isFinite(s) ? s : 1;
      const width = Math.max(0, Math.min(6, parseInt(pad, 10) || 0));
      return targets.map((_, i) => {
        const num = String(startN + i).padStart(width, "0");
        return `${base.trim()} ${num}`.trim();
      });
    }
    // find & replace on the name
    return parts.map(([stem]) => (find ? stem.split(find).join(replace) : stem));
  }, [bulk, single, mode, base, start, pad, find, replace, targets, parts]);

  const valid = newStems.every((s) => s.trim().length > 0);

  const save = async () => {
    if (!valid) {
      setError(t("Names can’t be empty."));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const items: RenameItem[] = targets.map((x, i) => ({ id: x.id, name: newStems[i].trim() }));
      if (isImage) await renameImages(items);
      else await renameRewards(items);
      onDone();
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const title = bulk
    ? tf("Rename {n}", {
        n: isImage ? tp("{n} photos", targets.length) : tp("{n} rewards", targets.length),
      })
    : isImage
      ? t("Rename photo")
      : t("Rename reward");

  // portaled, the iridescent year box is a stacking context (same as the MEGA modal)
  return createPortal(
    <div className="fixed inset-0 z-[115] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
      <motion.div
        initial={{ opacity: 0, y: 12, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        // dlg.panel gives each theme its surface, overflow-hidden keeps the body inside
        className={cn("flex max-h-[88vh] w-[34rem] max-w-full flex-col overflow-hidden", dlg.panel)}
      >
        <div className={cn("flex shrink-0 items-center justify-between border-b px-5 py-4", dlg.divider)}>
          {/* .fav-title is styled per theme (same header as the crop dialog) */}
          <h2 className="flex min-w-0 items-center gap-2">
            <Pencil className={cn("h-4 w-4 shrink-0", dlg.accentText)} />
            <span className="fav-title truncate text-[13px]">{title}</span>
          </h2>
          <button
            onClick={onClose}
            title={t("Close")}
            className={cn("shrink-0 p-1.5 text-zinc-400 transition-colors", round, dlg.menuRow)}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {!bulk ? (
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-zinc-500">
                {t("New name")}
              </span>
              <input
                autoFocus
                value={single}
                onChange={(e) => setSingle(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && void save()}
                className={dlg.input}
              />
              {isImage && parts[0]?.[1] && (
                <span className="mt-1 block text-xs text-zinc-500">
                  {t("Extension")} <code className="text-zinc-400">.{parts[0][1]}</code>{" "}
                  {t("is kept.")}
                </span>
              )}
            </label>
          ) : (
            <>
              {/* mode switch */}
              <div className={cn("mb-4 inline-flex p-0.5 text-sm", dlg.field)}>
                {(["number", "replace"] as const).map((m) => (
                  <button
                    key={m}
                    onClick={() => setMode(m)}
                    className={cn(
                      "px-3 py-1 transition-colors",
                      round,
                      mode === m
                        ? // `dlg.primary` is the accent's own signature fill and the
                          // ink that stays readable on it (acid plate, blossom
                          // gradient, pearl foil). It is `undefined` on the standard
                          // accents, which keep the flat brand pill.
                          cn("text-white", dlg.primary ?? "bg-brand-600")
                        : cn("text-zinc-300", dlg.menuRow),
                    )}
                  >
                    {m === "number" ? t("Name + numbering") : t("Find & replace")}
                  </button>
                ))}
              </div>

              {mode === "number" ? (
                <div className="flex flex-wrap items-end gap-3">
                  <label className="min-w-0 flex-1">
                    <span className="mb-1 block text-xs text-zinc-500">{t("Base name")}</span>
                    <input
                      autoFocus
                      value={base}
                      onChange={(e) => setBase(e.target.value)}
                      placeholder={t("e.g. Beach")}
                      className={dlg.input}
                    />
                  </label>
                  <label className="w-20">
                    <span className="mb-1 block text-xs text-zinc-500">{t("Start #")}</span>
                    <input
                      value={start}
                      onChange={(e) => setStart(e.target.value.replace(/\D/g, "").slice(0, 5))}
                      className={dlg.input}
                    />
                  </label>
                  <label className="w-20">
                    <span className="mb-1 block text-xs text-zinc-500">{t("Digits")}</span>
                    <input
                      value={pad}
                      onChange={(e) => setPad(e.target.value.replace(/\D/g, "").slice(0, 1))}
                      className={dlg.input}
                    />
                  </label>
                </div>
              ) : (
                <div className="flex flex-wrap items-end gap-3">
                  <label className="min-w-0 flex-1">
                    <span className="mb-1 block text-xs text-zinc-500">{t("Find")}</span>
                    <input
                      autoFocus
                      value={find}
                      onChange={(e) => setFind(e.target.value)}
                      className={dlg.input}
                    />
                  </label>
                  <label className="min-w-0 flex-1">
                    <span className="mb-1 block text-xs text-zinc-500">{t("Replace with")}</span>
                    <input
                      value={replace}
                      onChange={(e) => setReplace(e.target.value)}
                      className={dlg.input}
                    />
                  </label>
                </div>
              )}

              {/* live preview */}
              <div className="mt-4">
                <div className="mb-1.5 text-xs font-medium uppercase tracking-wide text-zinc-500">
                  {t("Preview")}
                </div>
                <div className={cn("max-h-56 space-y-1 overflow-y-auto p-2", dlg.box)}>
                  {targets.map((x, i) => (
                    <div key={x.id} className="flex items-center gap-2 text-xs">
                      <span className="min-w-0 flex-1 truncate text-zinc-500">{x.name}</span>
                      <ArrowRight className={cn("h-3 w-3 shrink-0", dlg.accentText)} />
                      <span className="min-w-0 flex-1 truncate font-medium text-zinc-100">
                        {newStems[i]?.trim() || <span className="text-rose-400">{t("(empty)")}</span>}
                        {isImage && parts[i]?.[1] ? `.${parts[i][1]}` : ""}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}

          {error && <p className="mt-3 text-sm text-rose-400">{error}</p>}
        </div>

        <div className={cn("flex shrink-0 justify-end gap-2 border-t px-5 py-3", dlg.divider)}>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {t("Cancel")}
          </Button>
          <Button variant="primary" onClick={() => void save()} disabled={busy || !valid}>
            <Pencil className="h-4 w-4" />
            {busy ? t("Renaming…") : t("Rename")}
          </Button>
        </div>
      </motion.div>
    </div>,
    document.body,
  );
}
