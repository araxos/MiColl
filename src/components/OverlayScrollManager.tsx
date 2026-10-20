import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";

/**
 * The floating scrollbar for every other scroll box (panels, dialogs, lists, menus).
 * The native vertical bars are hidden app-wide (index.css "Custom scrollbars"); one bar
 * floats over whichever box is being scrolled, or whose right edge the mouse is at,
 * then fades. Drag it, or click the track to jump a page. The main page has its own
 * (OverlayScrollbar), skipped here. Same look as that one (.overlay-scroll-*).
 *
 * The bar is portaled to <body>, so "click outside" handlers have to ignore it
 * (isOverlayScrollbar), or dragging it would close the menu it scrolls.
 */

/** True for a pointer event on the floating bar (for click-outside handlers). */
export function isOverlayScrollbar(target: EventTarget | null): boolean {
  return target instanceof Element && !!target.closest("[data-overlay-scroll]");
}

/** A box that scrolls vertically and gets the floating bar. */
function scrollsY(el: Element): el is HTMLElement {
  if (!(el instanceof HTMLElement)) return false;
  // the main page has its own bar
  if (el.classList.contains("overlay-scroll-host")) return false;
  if (el.scrollHeight <= el.clientHeight + 1) return false;
  const oy = getComputedStyle(el).overflowY;
  return oy === "auto" || oy === "scroll";
}

function scrollParent(node: Element | null): HTMLElement | null {
  for (let el = node; el && el !== document.body; el = el.parentElement) {
    if (scrollsY(el)) return el;
  }
  return null;
}

// gap between the bar and the box's top/bottom edge
const INSET = 4;

interface Box {
  left: number;
  top: number;
  height: number;
  thumbTop: number;
  thumbSize: number;
}

export function OverlayScrollManager() {
  const [box, setBox] = useState<Box | null>(null);
  const [visible, setVisible] = useState(false);
  const [dragging, setDragging] = useState(false);
  const target = useRef<HTMLElement | null>(null);
  const hideAt = useRef<number | undefined>(undefined);
  // pointer on the bar: it stays
  const over = useRef(false);
  const drag = useRef<{ y: number; scroll: number } | null>(null);

  const measure = () => {
    const el = target.current;
    if (!el || !el.isConnected || el.scrollHeight <= el.clientHeight + 1) {
      setBox(null);
      return;
    }
    const r = el.getBoundingClientRect();
    const track = Math.max(0, r.height - INSET * 2);
    const size = Math.max(28, (el.clientHeight / el.scrollHeight) * track);
    const room = el.scrollHeight - el.clientHeight;
    setBox({
      left: r.right - 12,
      top: r.top + INSET,
      height: track,
      thumbTop: room > 0 ? (el.scrollTop / room) * (track - size) : 0,
      thumbSize: size,
    });
  };

  const flash = () => {
    setVisible(true);
    window.clearTimeout(hideAt.current);
    hideAt.current = window.setTimeout(() => {
      if (!over.current && !drag.current) setVisible(false);
    }, 1100);
  };

  useEffect(() => {
    const onScroll = (e: Event) => {
      const el = e.target;
      // the document itself never scrolls, and the main page has its own bar
      if (!(el instanceof HTMLElement) || !scrollsY(el)) return;
      target.current = el;
      measure();
      flash();
    };
    // the mouse at a box's right edge brings its bar (checked once per frame)
    let raf = 0;
    const onMove = (e: PointerEvent) => {
      if (drag.current || raf) return;
      const { clientX: x, clientY: y } = e;
      const t = e.target as Element | null;
      raf = requestAnimationFrame(() => {
        raf = 0;
        if (isOverlayScrollbar(t)) return;
        const el = scrollParent(t);
        if (!el) return;
        const r = el.getBoundingClientRect();
        if (x >= r.right - 14 && x <= r.right && y >= r.top && y <= r.bottom) {
          target.current = el;
          measure();
          flash();
        }
      });
    };
    const onResize = () => target.current && measure();
    document.addEventListener("scroll", onScroll, { capture: true, passive: true });
    window.addEventListener("pointermove", onMove, { passive: true });
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("scroll", onScroll, { capture: true });
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("resize", onResize);
      cancelAnimationFrame(raf);
      window.clearTimeout(hideAt.current);
    };
  }, []);

  const onThumbDown = (e: React.PointerEvent) => {
    const el = target.current;
    if (!el || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* pointer already gone, the drag still follows the moves */
    }
    drag.current = { y: e.clientY, scroll: el.scrollTop };
    setDragging(true);
  };
  const onThumbMove = (e: React.PointerEvent) => {
    const el = target.current;
    const d = drag.current;
    if (!el || !d || !box) return;
    const room = el.scrollHeight - el.clientHeight;
    const travel = box.height - box.thumbSize;
    if (travel <= 0) return;
    el.scrollTop = d.scroll + ((e.clientY - d.y) / travel) * room;
  };
  const onThumbUp = () => {
    drag.current = null;
    setDragging(false);
    flash();
  };
  // a click on the empty track jumps one page towards it
  const onTrackDown = (e: React.PointerEvent) => {
    const el = target.current;
    if (!el || !box || e.button !== 0 || e.target !== e.currentTarget) return;
    e.preventDefault();
    const y = e.clientY - e.currentTarget.getBoundingClientRect().top;
    el.scrollBy({
      top: y < box.thumbTop ? -el.clientHeight * 0.9 : el.clientHeight * 0.9,
      behavior: "smooth",
    });
  };

  if (!box) return null;
  return createPortal(
    <div
      data-overlay-scroll
      onPointerDown={onTrackDown}
      onPointerEnter={() => {
        over.current = true;
        setVisible(true);
        window.clearTimeout(hideAt.current);
      }}
      onPointerLeave={() => {
        over.current = false;
        if (!drag.current) flash();
      }}
      className={cn(
        "overlay-scroll-track fixed z-[1000] w-3 transition-opacity duration-300",
        // hidden = invisible AND click-through, so it never steals a click
        visible || dragging ? "opacity-100" : "pointer-events-none opacity-0",
      )}
      style={{ left: box.left, top: box.top, height: box.height }}
    >
      <div
        onPointerDown={onThumbDown}
        onPointerMove={onThumbMove}
        onPointerUp={onThumbUp}
        onPointerCancel={onThumbUp}
        className={cn("overlay-scroll-thumb absolute right-0.5", dragging && "is-dragging")}
        style={{ top: box.thumbTop, height: box.thumbSize }}
      />
    </div>,
    document.body,
  );
}
