import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useDialogTheme } from "@/lib/dialogTheme";
import { cn } from "@/lib/utils";

/** Is this one or two typos away? Keeps "Sumer" next to "Sommer". */
function near(typed: string, name: string) {
  const limit = typed.length < 4 ? 1 : 2;
  if (Math.abs(typed.length - name.length) > limit) return false;
  let row = Array.from({ length: name.length + 1 }, (_, i) => i);
  for (let i = 1; i <= typed.length; i++) {
    const next = [i];
    for (let j = 1; j <= name.length; j++) {
      next[j] = Math.min(
        next[j - 1] + 1,
        row[j] + 1,
        row[j - 1] + (typed[i - 1] === name[j - 1] ? 0 : 1),
      );
    }
    row = next;
  }
  return row[name.length] <= limit;
}

/**
 * Free text with a list of known names below it while it has the focus (filtered by
 * what's typed). Saves on Enter, on leaving the field and on picking one, with live also
 * on every key. The list is our own (the native one ignores the theme) and portaled to
 * <body>, the review scrolls and would cut it off.
 */
export function NameCombo({
  value,
  onCommit,
  suggestions,
  label = (s) => s,
  placeholder,
  title,
  className,
  autoFocus,
  onLeave,
  maxLength = 120,
  live,
  typos,
  fieldId,
  onEnter,
  onEscape,
}: {
  value: string;
  onCommit: (v: string) => void;
  suggestions: string[];
  /** How a suggestion reads in the list. */
  label?: (s: string) => string;
  placeholder?: string;
  title?: string;
  className?: string;
  /** Focus it when it appears. */
  autoFocus?: boolean;
  /** The field lost the focus, with what it holds now. */
  onLeave?: (v: string) => void;
  maxLength?: number;
  /** For a form that reads the value on submit: every key goes to onCommit. */
  live?: boolean;
  /** Also list names one or two typos away from what's typed. */
  typos?: boolean;
  /** data-field id so focus can be restored after a remount. */
  fieldId?: string;
  /** Enter belongs to the form around it. */
  onEnter?: () => void;
  /** Escape with the list closed. */
  onEscape?: () => void;
}) {
  const dlg = useDialogTheme();
  const ref = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState(value);
  const [open, setOpen] = useState(false);
  // what's in the field already doesn't filter, only what gets typed
  const [typed, setTyped] = useState(false);
  const [box, setBox] = useState<{ left: number; top: number; width: number } | null>(null);
  // a name picked from the list (the blur that follows saves it, not the typed text)
  const picked = useRef<string | null>(null);
  const tabbed = useRef(false);
  const listRef = useRef<HTMLDivElement>(null);

  // outside changes while it isn't being edited
  useEffect(() => {
    if (!open) setDraft(value);
  }, [value, open]);

  const q = draft.trim().toLowerCase();
  const filter = typed ? q : "";
  // what's typed narrows the list, an exact match still shows (to see it's known)
  const hits = suggestions.filter((s) => !filter || s.toLowerCase().includes(filter));
  const shown =
    typos && filter
      ? [...hits, ...suggestions.filter((s) => !hits.includes(s) && near(filter, s.toLowerCase()))]
      : hits;

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
    const next = v.trim().slice(0, maxLength);
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
        maxLength={maxLength}
        data-field={fieldId}
        // Enter saves the name, it doesn't start the import (the review's Enter skips it)
        data-enter-local
        placeholder={placeholder}
        title={title}
        onChange={(e) => {
          setDraft(e.target.value);
          setTyped(true);
          setOpen(true);
          if (live) onCommit(e.target.value);
        }}
        onFocus={() => {
          setTyped(false);
          setOpen(true);
        }}
        onBlur={(e) => {
          setOpen(false);
          const changed = (picked.current ?? draft).trim() !== value;
          const left = commit(picked.current ?? draft);
          picked.current = null;
          onLeave?.(left);
          // saving can regroup the review and remount the field that was clicked or
          // tabbed to, so put focus back on its replacement (found by data-field)
          const nextId = (e.relatedTarget as HTMLElement | null)?.getAttribute("data-field");
          const byTab = tabbed.current;
          if (changed && nextId) {
            const esc = nextId.replace(/(["\\])/g, "\\$1");
            setTimeout(() => {
              const el = document.querySelector<HTMLElement>(`[data-field="${esc}"]`);
              if (!el || document.activeElement === el) return;
              el.focus();
              if (byTab && el instanceof HTMLInputElement) el.select();
            }, 0);
          }
        }}
        onKeyDown={(e) => {
          tabbed.current = e.key === "Tab";
          if (e.key === "Enter") {
            e.preventDefault();
            if (onEnter) {
              setOpen(false);
              onEnter();
            } else {
              ref.current?.blur();
            }
          } else if (e.key === "Escape") {
            if (open) {
              // close the list, not the review
              e.stopPropagation();
              setDraft(value);
              setOpen(false);
            } else {
              onEscape?.();
            }
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
                onClick={(e) => {
                  e.stopPropagation();
                  picked.current = s;
                  if (live) onCommit(s);
                  ref.current?.blur();
                }}
                className={cn(
                  "flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs text-zinc-100 transition-colors",
                  s.toLowerCase() === q ? cn("font-medium", dlg.menuRowOpen) : dlg.menuRow,
                )}
              >
                <span className="truncate">{label(s)}</span>
              </button>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}
