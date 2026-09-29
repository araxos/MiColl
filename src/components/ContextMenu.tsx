import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { useDialogTheme } from "@/lib/dialogTheme";

export interface MenuItem {
  label: string;
  icon?: React.ReactNode;
  /**
   * Action of the row. Can be combined with children: click runs this,
   * hover opens the submenu.
   */
  onClick?: () => void;
  danger?: boolean;
  /** Submenu items shown on hover. */
  children?: MenuItem[];
  /** Small grey hint on the right (e.g. a shortcut). */
  hint?: string;
  /** Not clickable, just an info line. */
  info?: boolean;
  /**
   * Show this item in the icon row at the top (lower number first).
   * The label becomes the tooltip, so it needs an icon. No submenus there.
   */
  quick?: number;
  /** Keep the menu open after clicking (for toggles). */
  keepOpen?: boolean;
  /** With keepOpen: how the item looks after it was clicked. */
  toggled?: { label: string; icon?: React.ReactNode };
}

/**
 * Order of the groups in every right-click menu (skip empty groups):
 *   1. context     - info rows
 *   2. open        - Show in Explorer, Go to, Details, Open in new window
 *   3. appearance  - Edit, Set as, Set as Wallpaper, Reset cover
 *   4. mark        - Pin, Favourite, Class, Set type, Mark as skipped
 *   5. organize    - Rename, Move, Collab with, Find duplicates
 *   6. share       - Share
 *   7. storage     - MiSD
 *   8. refresh     - Reload
 *   9. destructive - Remove link, Delete
 */

/** Simple right-click menu at (x, y) with one level of submenus. */
export function ContextMenu({
  x,
  y,
  items,
  onClose,
}: {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    // also close on pointerdown anywhere (capture), the title bar is above the backdrop
    const onDown = (e: PointerEvent) => {
      if (!panelRef.current?.contains(e.target as Node)) onClose();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onDown, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onDown, true);
    };
  }, [onClose]);

  // keep the menu inside the window (the quick row counts as one row)
  const quickCount = items.filter((it) => it.quick !== undefined).length;
  const rows = items.length - quickCount + (quickCount ? 1 : 0);
  const left = Math.min(x, window.innerWidth - 220);
  const top = Math.min(y, window.innerHeight - (rows * 40 + 12));
  // open submenus to the left if the menu is on the right half
  const flipLeft = left > window.innerWidth / 2;

  return (
    <div
      className="fixed inset-0 z-[100]"
      onClick={onClose}
      onContextMenu={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <div
        ref={panelRef}
        className="absolute"
        style={{ left, top }}
        onClick={(e) => e.stopPropagation()}
      >
        <MenuList items={items} onClose={onClose} flipLeft={flipLeft} />
      </div>
    </div>
  );
}

/** Which keepOpen items were clicked (index per list). */
function useFlips(): [Set<number>, (i: number) => void] {
  const [flipped, setFlipped] = useState<Set<number>>(() => new Set());
  const flip = (i: number) =>
    setFlipped((prev) => {
      const next = new Set(prev);
      next.has(i) ? next.delete(i) : next.add(i);
      return next;
    });
  return [flipped, flip];
}

/** The item as it looks right now (flipped if clicked). */
function view(it: MenuItem, isFlipped: boolean): MenuItem {
  if (!isFlipped || !it.toggled) return it;
  return { ...it, label: it.toggled.label, icon: it.toggled.icon ?? it.icon };
}

function MenuList({
  items,
  onClose,
  flipLeft,
  scrollable,
}: {
  items: MenuItem[];
  onClose: () => void;
  flipLeft: boolean;
  /** Max height for long submenus (only leaf lists, fly-outs must not be cut off). */
  scrollable?: boolean;
}) {
  const [openSub, setOpenSub] = useState<number | null>(null);
  const { menu, menuRow, menuRowOpen, divider } = useDialogTheme();
  const [flipped, flip] = useFlips();
  // lists with submenus can't scroll, overflow-y would cut the fly-outs
  const hasNested = items.some((it) => !!it.children?.length);

  // quick row items, in their own order
  const quick = items
    .filter((it) => it.quick !== undefined && it.icon && !it.info)
    .sort((a, b) => a.quick! - b.quick!);
  const listed = items.filter((it) => !quick.includes(it));

  return (
    <div
      className={cn(
        "min-w-[12rem] py-1",
        menu,
        scrollable && !hasNested && "max-h-[85vh] overflow-y-auto",
      )}
    >
      {quick.length > 0 && <QuickRow items={quick} onClose={onClose} />}
      {listed.map((raw, i) => {
        if (raw.info) {
          return (
            <div
              key={i}
              className={cn(
                "flex items-center gap-2.5 border-t px-3 py-1.5 text-xs text-zinc-500 first:border-t-0",
                divider,
              )}
            >
              {raw.icon}
              <span className="flex-1">{raw.label}</span>
            </div>
          );
        }
        const it = view(raw, flipped.has(i));
        const hasChildren = !!it.children?.length;
        // a parent without its own action only opens the submenu
        const clickable = !hasChildren || !!it.onClick;
        return (
          <div
            key={i}
            className="relative"
            onMouseEnter={() => setOpenSub(hasChildren ? i : null)}
          >
            <button
              onClick={() => {
                if (!clickable) return; // pure submenu parent: hover-only
                it.onClick?.();
                if (it.keepOpen) flip(i);
                else onClose();
              }}
              className={cn(
                "flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm transition-colors",
                it.danger ? "text-rose-300 hover:bg-rose-500/15" : cn("text-zinc-200", menuRow),
                hasChildren && openSub === i && menuRowOpen,
              )}
            >
              {it.icon}
              <span className="flex-1">{it.label}</span>
              {it.hint && <span className="text-xs text-zinc-500">{it.hint}</span>}
              {hasChildren && <ChevronRight className="h-4 w-4 text-zinc-500" />}
            </button>

            {hasChildren && openSub === i && (
              <SubFlyout flipLeft={flipLeft}>
                <MenuList items={it.children!} onClose={onClose} flipLeft={flipLeft} scrollable />
              </SubFlyout>
            )}
          </div>
        );
      })}
    </div>
  );
}

/**
 * Icon row at the top of the menu. Tooltip is below the icon
 * (no room above near the top of the window).
 */
function QuickRow({ items, onClose }: { items: MenuItem[]; onClose: () => void }) {
  const [hover, setHover] = useState<number | null>(null);
  const { menuRow, divider } = useDialogTheme();
  const [flipped, flip] = useFlips();

  return (
    <div className={cn("mb-1 flex items-stretch gap-1 border-b px-1 pb-1", divider)}>
      {items.map((raw, i) => {
        const it = view(raw, flipped.has(i));
        return (
        <div key={i} className="relative flex-1">
          <button
            onClick={() => {
              it.onClick?.();
              if (it.keepOpen) flip(i);
              else onClose();
            }}
            onMouseEnter={() => setHover(i)}
            onMouseLeave={() => setHover((h) => (h === i ? null : h))}
            title={it.label}
            aria-label={it.label}
            className={cn(
              "flex w-full items-center justify-center rounded-lg py-2 transition-colors",
              it.danger ? "text-rose-300 hover:bg-rose-500/15" : cn("text-zinc-200", menuRow),
            )}
          >
            {it.icon}
          </button>
          {hover === i && (
            <div className="pointer-events-none absolute left-1/2 top-full z-10 mt-1 -translate-x-1/2 whitespace-nowrap rounded-md bg-black/90 px-2 py-1 text-[11px] font-medium text-white shadow-lg ring-1 ring-white/15">
              {it.label}
            </div>
          )}
        </div>
        );
      })}
    </div>
  );
}

/** Submenu that moves up if it would go past the bottom of the window. */
function SubFlyout({ flipLeft, children }: { flipLeft: boolean; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [dy, setDy] = useState(0);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const margin = 8;
    const r = el.getBoundingClientRect();
    let shift = 0;
    if (r.bottom > window.innerHeight - margin) {
      shift = window.innerHeight - margin - r.bottom; // pull it up into view
    }
    if (r.top + shift < margin) shift = margin - r.top; // but never above the top edge
    setDy(shift);
  }, []);

  return (
    <div
      ref={ref}
      className={cn("absolute top-0", flipLeft ? "right-full mr-1" : "left-full ml-1")}
      style={{ transform: `translateY(${dy}px)` }}
    >
      {children}
    </div>
  );
}
