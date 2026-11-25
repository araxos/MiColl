import { useEffect } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronLeft, ChevronRight, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { useDialogTheme } from "@/lib/dialogTheme";
import { useT } from "@/lib/i18n";
import { isTauri, previewUrl } from "@/lib/tauri";
import { cn } from "@/lib/utils";

/**
 * A picture of the picker in big: left and right go through the pictures, the button picks
 * it (space too). Esc only closes this, not the picker.
 */
export function PickPreview({
  path,
  name,
  picked,
  locked,
  place,
  onStep,
  onToggle,
  onClose,
}: {
  /** The file that's shown (the active version). */
  path: string;
  name: string;
  picked: boolean;
  /** It's in the slideshow already. */
  locked: boolean;
  /** "3 / 40" */
  place: string;
  onStep: (by: 1 | -1) => void;
  onToggle: () => void;
  onClose: () => void;
}) {
  const t = useT();
  const dlg = useDialogTheme();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const run = {
        Escape: onClose,
        ArrowLeft: () => onStep(-1),
        ArrowRight: () => onStep(1),
        " ": () => !locked && onToggle(),
      }[e.key];
      if (!run) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      run();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose, onStep, onToggle, locked]);

  const side = (by: 1 | -1) => (
    <button
      onClick={(e) => {
        e.stopPropagation();
        onStep(by);
      }}
      title={by < 0 ? t("Previous (←)") : t("Next (→)")}
      aria-label={by < 0 ? t("Previous (←)") : t("Next (→)")}
      className={cn("hub-run absolute top-1/2 -translate-y-1/2", by < 0 ? "left-4" : "right-4")}
      // (bigger than a badge)
      style={{ width: 44, height: 44 }}
    >
      {by < 0 ? <ChevronLeft className="h-5 w-5" /> : <ChevronRight className="h-5 w-5" />}
    </button>
  );
  return createPortal(
    <div onClick={onClose} className="fixed inset-0 z-[90] flex flex-col bg-black/90" role="dialog" aria-modal>
      <div className="flex min-h-0 flex-1 items-center justify-center p-4 pb-2">
        {isTauri() && (
          <img
            key={path}
            src={previewUrl(path)}
            alt=""
            draggable={false}
            onClick={(e) => e.stopPropagation()}
            className="max-h-full max-w-full object-contain"
          />
        )}
      </div>
      {side(-1)}
      {side(1)}
      <div
        onClick={(e) => e.stopPropagation()}
        className={cn("m-4 mt-0 flex items-center gap-3 px-4 py-2.5", dlg.panel)}
      >
        <span className="shrink-0 text-xs text-zinc-400">{place}</span>
        <span className="min-w-0 flex-1 truncate text-sm text-zinc-200">{name}</span>
        {locked ? (
          <span className="flex items-center gap-1.5 text-sm text-zinc-400">
            <Check className="h-4 w-4" />
            {t("Already in this slideshow")}
          </span>
        ) : (
          <Button variant={picked ? "outline" : "primary"} size="sm" className={picked ? undefined : dlg.primary} onClick={onToggle}>
            {picked ? <Check className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
            {picked ? t("Selected") : t("Select")}
          </Button>
        )}
        <Button variant="ghost" size="sm" onClick={onClose}>
          <X className="h-4 w-4" />
          {t("Close")}
        </Button>
      </div>
    </div>,
    document.body,
  );
}
