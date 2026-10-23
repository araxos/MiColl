import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { motion } from "framer-motion";
import { Layers } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { useDialogTheme } from "@/lib/dialogTheme";
import { useT, useTf, useTp } from "@/lib/i18n";
import { tierLabel } from "@/lib/tier";
import { cn } from "@/lib/utils";

/**
 * Set a reward's tier (or several rewards' at once): free text, the creator's tiers so
 * far as one-click chips, "Remove tier" when one is set. Enter saves, Esc cancels.
 */
export function TierDialog({
  count,
  current,
  suggestions,
  busy = false,
  onSave,
  onCancel,
}: {
  /** how many rewards get it */
  count: number;
  /** their tier now, when they all have the same one */
  current: string | null;
  /** the tiers this creator already uses */
  suggestions: string[];
  busy?: boolean;
  /** null removes the tier */
  onSave: (tier: string | null) => void;
  onCancel: () => void;
}) {
  const t = useT();
  const tf = useTf();
  const tp = useTp();
  const dlg = useDialogTheme();
  const [value, setValue] = useState(current ?? "");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) {
        e.stopPropagation();
        onCancel();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [busy, onCancel]);

  const save = () => onSave(value.trim() || null);

  return createPortal(
    <div
      className="fixed inset-0 z-[120] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onCancel();
      }}
    >
      <motion.div
        initial={{ opacity: 0, y: 12, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        role="dialog"
        aria-label={t("Tier")}
        className={cn("w-[26rem] max-w-full p-5", dlg.panel)}
      >
        <div className="flex items-start gap-3">
          <div className={cn("flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-white/5", dlg.accentText)}>
            <Layers className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-zinc-100">
              {count > 1 ? tp("Tier for {n} rewards", count) : t("Tier")}
            </h2>
            <p className="mt-1 text-sm text-zinc-400">
              {t("Which of the creator’s tiers it came with. A number shows as “Tier 2”, anything else as you type it.")}
            </p>
          </div>
        </div>

        <input
          autoFocus
          value={value}
          maxLength={40}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !busy) save();
          }}
          placeholder={t("e.g. 2, Gold, $10")}
          className={cn("mt-4", dlg.input)}
        />
        {value.trim() && (
          <p className="mt-1.5 text-xs text-zinc-500">
            {tf("Shows as: {label}", { label: tierLabel(value, tf) })}
          </p>
        )}

        {suggestions.length > 0 && (
          <div className="mt-3">
            <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-zinc-500">
              {t("This creator’s tiers")}
            </p>
            <div className="flex flex-wrap gap-1.5">
              {suggestions.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setValue(s)}
                  className={cn(
                    "px-2 py-1 text-xs",
                    value.trim().toLowerCase() === s.toLowerCase() ? dlg.controlOn : dlg.control,
                  )}
                >
                  {tierLabel(s, tf)}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="mt-5 flex items-center justify-end gap-2">
          {current && (
            <Button variant="ghost" onClick={() => onSave(null)} disabled={busy} className="mr-auto">
              {t("Remove tier")}
            </Button>
          )}
          <Button variant="ghost" onClick={onCancel} disabled={busy}>
            {t("Cancel")}
          </Button>
          <Button variant="primary" onClick={save} disabled={busy} className={dlg.primary}>
            {busy ? t("Working…") : t("Save")}
          </Button>
        </div>
      </motion.div>
    </div>,
    document.body,
  );
}
