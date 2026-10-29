import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useDialogTheme } from "@/lib/dialogTheme";
import { useTf } from "@/lib/i18n";
import { tierLabel } from "@/lib/tier";
import { cn } from "@/lib/utils";

/**
 * Tier field of the import review: free text, and while it has the focus a list of the
 * creator's tiers below it (filtered by what's typed). Saves on Enter, on leaving the
 * field and on picking one. The list is our own (the native one ignores the theme) and
 * portaled to <body>, the review scrolls and would cut it off.
 */
export function TierCombo({
  value,
  onCommit,
  suggestions,
  placeholder,
  title,
  className,
  autoFocus,
  onLeave,
}: {
  value: string;
  onCommit: (v: string) => void;
  suggestions: string[];
  placeholder?: string;
  title?: string;
  className?: string;
  /** Focus it when it appears (opened by the tier icon). */
  autoFocus?: boolean;
  /** The field lost the focus, with what it holds now. */
  onLeave?: (v: string) => void;
}) {
  const tf = useTf();
  const dlg = useDialogTheme();
  const ref = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState(value);
  const [open, setOpen] = useState(false);
  const [box, setBox] = useState<{ left: number; top: number; width: number } | null>(null);
  // a tier picked from the list (the blur that follows saves it, not the typed text)
  const picked = useRef<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // outside changes while it isn't being edited
  useEffect(() => {
    if (!open) setDraft(value);
  }, [value, open]);

  const q = draft.trim().toLowerCase();
  // what's typed narrows the list, an exact match still shows (to see it's known)
  const shown = suggestions.filter((s) => !q || s.toLowerCase().includes(q));

  useLayoutEffect(() => {
    if (!open) return;
    const r = ref.current?.getBoundingClientRect();
    if (r) setBox({ left: r.left, top: r.bottom + 4, width: Math.max(r.width, 140) });
  }, [open, draft]);

  // the review scrolls: close instead of floating away
  useEffect(() => {
    if (!open) return;
    const close = () => ref.current?.blur();
    // scrolling the list itself is fine
    const onScroll = (e: Event) => {
      if (!listRef.current?.contains(e.target as Node)) close();
    };
    window.addEventListener("resize", close);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [open]);

  const commit = (v: string) => {
    const next = v.trim().slice(0, 40);
    setDraft(next);
    if (next !== value) onCommit(next);
    return next;
  };

  useEffect(() => {
    if (autoFocus) ref.current?.focus();
    // only when it appears
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <>
      <input
        ref={ref}
        value={draft}
        maxLength={40}
        // Enter saves the tier, it doesn't start the import (the review's Enter skips it)
        data-enter-local
        placeholder={placeholder}
        title={title}
        onChange={(e) => setDraft(e.target.value)}
        onFocus={() => setOpen(true)}
        onBlur={() => {
          setOpen(false);
          const left = commit(picked.current ?? draft);
          picked.current = null;
          onLeave?.(left);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            ref.current?.blur();
          } else if (e.key === "Escape" && open) {
            // close the list, not the review
            e.stopPropagation();
            setDraft(value);
            setOpen(false);
          }
        }}
        className={className}
      />
      {open &&
        box &&
        shown.length > 0 &&
        createPortal(
          <div
            ref={listRef}
            // a click in the list must not blur the field before the pick lands
            onMouseDown={(e) => e.preventDefault()}
            className={cn(dlg.menu, "fixed z-[110] max-h-[14rem] overflow-y-auto overscroll-contain py-1")}
            style={{ left: box.left, top: box.top, width: box.width }}
          >
            {shown.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => {
                  picked.current = s;
                  ref.current?.blur();
                }}
                className={cn(
                  "flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs text-zinc-100 transition-colors",
                  s.toLowerCase() === q ? cn("font-medium", dlg.menuRowOpen) : dlg.menuRow,
                )}
              >
                <span className="truncate">{tierLabel(s, tf)}</span>
              </button>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}
