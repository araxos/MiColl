import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { useDialogTheme } from "@/lib/dialogTheme";

/**
 * Our own dropdown instead of a native <select>.
 * The native list is drawn by Windows (grey menu, ignores all classes), so it can't
 * match the theme. The closed control uses the caller's field classes.
 * The list is portaled to <body> because the dialogs use overflow-hidden + transform.
 */

export interface SelectOption {
  value: string;
  label: string;
  /** A grey row: placeholder ("(mixed)") or action ("+ Platform..."). */
  muted?: boolean;
}

export function ThemedSelect({
  value,
  options,
  onChange,
  title,
  className,
  ink,
  minWidth = 160,
}: {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  title?: string;
  /** Classes for the closed control (same field token as the inputs next to it). */
  className?: string;
  /** Text color for the values (in the control and the list). */
  ink?: string;
  /** Min width of the list in px. */
  minWidth?: number;
}) {
  const dlg = useDialogTheme();
  const btnRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [box, setBox] = useState<{ left: number; top: number; width: number; up: boolean } | null>(
    null,
  );

  // measure the anchor before paint so the list is never in the wrong spot
  useLayoutEffect(() => {
    if (!open) {
      setBox(null);
      return;
    }
    const r = btnRef.current?.getBoundingClientRect();
    if (!r) return;
    const width = Math.max(r.width, minWidth);
    // rough list height to decide if it opens up or down
    const wanted = Math.min(options.length * 30 + 8, 272);
    const below = window.innerHeight - r.bottom - 8;
    setBox({
      left: Math.max(8, Math.min(r.left, window.innerWidth - width - 8)),
      top: below < wanted && r.top > below ? r.top : r.bottom,
      width,
      up: below < wanted && r.top > below,
    });
  }, [open, options.length, minWidth]);

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!listRef.current?.contains(t) && !btnRef.current?.contains(t)) close();
    };
    // scrolling the list itself is fine
    const onScroll = (e: Event) => {
      if (!listRef.current?.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // swallow Escape so the dialog around it doesn't close too
      e.stopPropagation();
      close();
    };
    // close on scroll (capture, the scroll happens inside the dialog)
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", close);
    };
  }, [open]);

  const current = options.find((o) => o.value === value);

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        title={title}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "flex items-center justify-between gap-1.5 transition-colors",
          className,
          open && dlg.menuRowOpen,
        )}
      >
        <span className={cn("truncate", ink, (!current || current.muted) && "text-zinc-400")}>
          {current?.label ?? ""}
        </span>
        <ChevronDown
          className={cn("h-3.5 w-3.5 shrink-0 opacity-60 transition-transform", open && "rotate-180")}
        />
      </button>

      {open &&
        box &&
        createPortal(
          <div
            ref={listRef}
            // theme surface first, our classes last, so twMerge keeps "fixed" over the
            // iridescent "relative" (otherwise the list ends up off screen).
            // overscroll-contain so the wheel doesn't scroll the dialog behind it
            className={cn(
              dlg.menu,
              "fixed z-[110] max-h-[17rem] overflow-y-auto overscroll-contain py-1",
            )}
            style={{
              left: box.left,
              width: box.width,
              ...(box.up
                ? { bottom: window.innerHeight - box.top + 4 }
                : { top: box.top + 4 }),
            }}
          >
            {options.map((o) => {
              const on = o.value === value;
              return (
                <button
                  key={o.value}
                  type="button"
                  onClick={() => {
                    onChange(o.value);
                    setOpen(false);
                  }}
                  className={cn(
                    "flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs transition-colors",
                    ink,
                    on ? cn("font-medium", dlg.menuRowOpen) : dlg.menuRow,
                    o.muted && "text-zinc-400",
                  )}
                >
                  <Check className={cn("h-3 w-3 shrink-0", on ? dlg.accentText : "opacity-0")} />
                  <span className="truncate">{o.label}</span>
                </button>
              );
            })}
          </div>,
          document.body,
        )}
    </>
  );
}
