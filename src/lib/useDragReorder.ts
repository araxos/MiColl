import { useEffect, useRef, useState } from "react";

export type DropAt = { id: string; side: "before" | "after" };

/**
 * Drag items of one group into a new order. Items carry data-reorder={group} and
 * data-reorder-id, the drag starts from start() in their onPointerDown.
 * Pointer events like the start page's cards: WebView2 swallows in-page HTML5 drags
 * because file dropping is on. Starts after a few pixels, so a click still works.
 */
export function useDragReorder(
  group: string,
  axis: "x" | "y",
  enabled: boolean,
  onDrop: (id: string, at: DropAt) => void,
) {
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropAt, setDropAt] = useState<DropAt | null>(null);
  const drag = useRef<{ id: string; x: number; y: number; active: boolean } | null>(null);
  const dropRef = useRef<DropAt | null>(null);
  const onDropRef = useRef(onDrop);
  onDropRef.current = onDrop;

  const start = (e: React.PointerEvent, id: string) => {
    if (!enabled || e.button !== 0 || !e.isPrimary) return;
    drag.current = { id, x: e.clientX, y: e.clientY, active: false };
  };

  useEffect(() => {
    if (!enabled) return;
    const setDrop = (v: DropAt | null) => {
      dropRef.current = v;
      setDropAt(v);
    };
    // which screen edge the pointer is at (auto-scroll)
    let edge = 0;
    let raf = 0;
    const scroller = () => document.querySelector("main");
    const tick = () => {
      raf = 0;
      if (!drag.current?.active) return;
      if (edge !== 0) scroller()?.scrollBy({ top: edge * 18 });
      raf = requestAnimationFrame(tick);
    };

    const onMove = (e: PointerEvent) => {
      const d = drag.current;
      if (!d) return;
      if (!d.active) {
        if (Math.hypot(e.clientX - d.x, e.clientY - d.y) < 6) return;
        d.active = true;
        setDragId(d.id);
        document.body.style.userSelect = "none";
        raf = requestAnimationFrame(tick);
      }
      const over = (document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null)?.closest(
        `[data-reorder="${group}"]`,
      ) as HTMLElement | null;
      const overId = over?.dataset.reorderId;
      if (!over || !overId || overId === d.id) {
        setDrop(null);
      } else {
        const r = over.getBoundingClientRect();
        const first = axis === "x" ? e.clientX < r.left + r.width / 2 : e.clientY < r.top + r.height / 2;
        const side = first ? "before" : "after";
        if (dropRef.current?.id !== overId || dropRef.current.side !== side) {
          setDrop({ id: overId, side });
        }
      }
      const view = scroller()?.getBoundingClientRect();
      edge = !view ? 0 : e.clientY < view.top + 70 ? -1 : e.clientY > view.bottom - 70 ? 1 : 0;
    };

    const onUp = () => {
      const d = drag.current;
      drag.current = null;
      edge = 0;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      if (d?.active) {
        document.body.style.userSelect = "";
        if (dropRef.current) onDropRef.current(d.id, dropRef.current);
        // swallow the click after the drop, or the card opens / the year folds
        const swallow = (ev: MouseEvent) => {
          ev.preventDefault();
          ev.stopPropagation();
        };
        window.addEventListener("click", swallow, true);
        setTimeout(() => window.removeEventListener("click", swallow, true), 0);
      }
      setDragId(null);
      setDrop(null);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      document.body.style.userSelect = "";
      drag.current = null;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [enabled, group, axis]);

  return { start, dragId, dropAt };
}
