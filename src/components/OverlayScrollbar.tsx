import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

/**
 * A scrollbar that floats over the content instead of taking a column of its own.
 * The scroll element hides its native bar (.overlay-scroll-host); this one shows while
 * scrolling, while the mouse is near the right edge and while it's dragged, then fades.
 * Drag the thumb to scroll, click the track to jump a page. Styled per theme (index.css
 * .overlay-scroll-*).
 */
export function OverlayScrollbar({ target }: { target: React.RefObject<HTMLElement | null> }) {
  const [box, setBox] = useState({ top: 0, size: 0, needed: false });
  const [visible, setVisible] = useState(false);
  const [dragging, setDragging] = useState(false);
  const hideAt = useRef<number | undefined>(undefined);
  const trackRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ y: number; scroll: number } | null>(null);

  const flash = () => {
    setVisible(true);
    window.clearTimeout(hideAt.current);
    hideAt.current = window.setTimeout(() => setVisible(false), 1100);
  };

  useEffect(() => {
    const el = target.current;
    if (!el) return;
    const measure = () => {
      const track = trackRef.current?.clientHeight ?? el.clientHeight;
      const needed = el.scrollHeight > el.clientHeight + 1;
      const size = needed ? Math.max(36, (el.clientHeight / el.scrollHeight) * track) : 0;
      const room = el.scrollHeight - el.clientHeight;
      const top = needed && room > 0 ? (el.scrollTop / room) * (track - size) : 0;
      setBox({ top, size, needed });
    };
    const onScroll = () => {
      measure();
      flash();
    };
    // the mouse near the right edge brings it back (the hidden track lets clicks through)
    const onMove = (e: MouseEvent) => {
      if (e.clientX >= el.getBoundingClientRect().right - 14) flash();
    };
    measure();
    el.addEventListener("scroll", onScroll, { passive: true });
    el.addEventListener("mousemove", onMove, { passive: true });
    // the content grows and shrinks (pages, filters, images arriving)
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    for (const child of Array.from(el.children)) ro.observe(child);
    const mo = new MutationObserver(() => {
      for (const child of Array.from(el.children)) ro.observe(child);
      measure();
    });
    mo.observe(el, { childList: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      el.removeEventListener("mousemove", onMove);
      ro.disconnect();
      mo.disconnect();
      window.clearTimeout(hideAt.current);
    };
  }, [target]);

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
    const track = trackRef.current;
    if (!el || !d || !track) return;
    const room = el.scrollHeight - el.clientHeight;
    const travel = track.clientHeight - box.size;
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
    if (!el || e.button !== 0 || e.target !== e.currentTarget) return;
    const y = e.clientY - e.currentTarget.getBoundingClientRect().top;
    el.scrollBy({ top: y < box.top ? -el.clientHeight * 0.9 : el.clientHeight * 0.9, behavior: "smooth" });
  };

  if (!box.needed) return null;
  return (
    <div
      ref={trackRef}
      onPointerDown={onTrackDown}
      onPointerEnter={() => {
        setVisible(true);
        window.clearTimeout(hideAt.current);
      }}
      onPointerLeave={() => !dragging && flash()}
      className={cn(
        "overlay-scroll-track absolute bottom-1 right-0 top-1 z-40 w-3 transition-opacity duration-300",
        // hidden = invisible AND click-through, so it never steals a click from the page
        visible || dragging ? "opacity-100" : "pointer-events-none opacity-0",
      )}
    >
      <div
        onPointerDown={onThumbDown}
        onPointerMove={onThumbMove}
        onPointerUp={onThumbUp}
        onPointerCancel={onThumbUp}
        className={cn("overlay-scroll-thumb absolute right-0.5", dragging && "is-dragging")}
        style={{ top: box.top, height: box.size }}
      />
    </div>
  );
}
