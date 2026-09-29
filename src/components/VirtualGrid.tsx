import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { motion } from "framer-motion";

interface VirtualGridProps<T> {
  items: T[];
  /** Min column width (px), like repeat(auto-fill, minmax(min, 1fr)). */
  minColWidth: number;
  /** Tile height / width (e.g. 5/4 for a 4:5 card). Used to compute the row height. */
  aspectRatio: number;
  /** Gap in px (default 16 = gap-4). */
  gap?: number;
  /** Extra rows above/below the viewport. */
  overscan?: number;
  /**
   * Must return an element with a stable key. pos = index + column count
   * (used by the cyberpunk glitch wave).
   */
  renderItem: (item: T, pos: { index: number; cols: number }) => React.ReactNode;
  className?: string;
  /** Passed to the outer element (e.g. the Ctrl+wheel listener). */
  containerRef?: (node: HTMLDivElement | null) => void;
  /**
   * Animate tiles to their new spot on sort/add/remove (FLIP). Needs keyOf.
   * Not while scrolling/resizing. Off by default.
   */
  animate?: boolean;
  /** Stable key per item (needed for animate). */
  keyOf?: (item: T) => React.Key;
}

/**
 * Virtualized grid: only tiles near the viewport are mounted, but the grid keeps
 * its full height so the scrollbar is right. Works like a CSS auto-fill grid,
 * columns and row height come from the width and the tile ratio.
 */
export function VirtualGrid<T>({
  items,
  minColWidth,
  aspectRatio,
  gap = 16,
  overscan = 3,
  renderItem,
  className,
  containerRef,
  animate = false,
  keyOf,
}: VirtualGridProps<T>) {
  const outerRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLElement | null>(null);
  const [metrics, setMetrics] = useState({ cols: 1, rowHeight: minColWidth * aspectRatio + gap });
  const [firstRow, setFirstRow] = useState(0);
  const [winRows, setWinRows] = useState(12);
  // layout animations only for real list changes, not while scrolling or resizing
  const [layoutIdle, setLayoutIdle] = useState(true);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // ref so scroll events only touch state at the start and end
  const idleRef = useRef(true);
  const suspendLayout = useCallback(() => {
    if (idleRef.current) {
      idleRef.current = false;
      setLayoutIdle(false);
    }
    if (idleTimer.current) clearTimeout(idleTimer.current);
    idleTimer.current = setTimeout(() => {
      idleRef.current = true;
      setLayoutIdle(true);
    }, 180);
  }, []);
  useEffect(() => () => clearTimeout(idleTimer.current), []);
  // on card resize the glide is the feedback, so keep layout on and mount
  // extra rows so new tiles don't just pop in
  const [resizing, setResizing] = useState(false);
  const resizeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const firstSize = useRef(true);
  useEffect(() => {
    if (firstSize.current) {
      firstSize.current = false; // initial mount is not a resize
      return;
    }
    setResizing(true);
    if (resizeTimer.current) clearTimeout(resizeTimer.current);
    resizeTimer.current = setTimeout(() => setResizing(false), 500);
  }, [minColWidth]);
  useEffect(() => () => clearTimeout(resizeTimer.current), []);

  // Is a reorder happening? layout is only on then, because framer-motion's
  // layout nodes measure every tile every frame while it's on.
  const orderKey = animate && keyOf ? items.map(keyOf).join("") : "";
  const [reordering, setReordering] = useState(false);
  const prevOrder = useRef(orderKey);
  const reorderTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    if (prevOrder.current === orderKey) return; // first render, or nothing moved
    prevOrder.current = orderKey;
    setReordering(true);
    if (reorderTimer.current) clearTimeout(reorderTimer.current);
    // a bit longer than the spring (stiffness 500 / damping 42)
    reorderTimer.current = setTimeout(() => setReordering(false), 700);
  }, [orderKey]);
  useEffect(() => () => clearTimeout(reorderTimer.current), []);

  const setOuter = useCallback(
    (node: HTMLDivElement | null) => {
      outerRef.current = node;
      containerRef?.(node);
    },
    [containerRef],
  );

  const recompute = useCallback(() => {
    const outer = outerRef.current;
    if (!outer) return;
    const width = outer.clientWidth;
    if (width <= 0) return;
    const cols = Math.max(1, Math.floor((width + gap) / (minColWidth + gap)));
    const colWidth = (width - (cols - 1) * gap) / cols;
    const rowHeight = colWidth * aspectRatio + gap;
    setMetrics((m) =>
      m.cols === cols && Math.abs(m.rowHeight - rowHeight) < 0.5 ? m : { cols, rowHeight },
    );

    const sc = scrollRef.current;
    if (sc) {
      const gridTop =
        outer.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop;
      const rel = sc.scrollTop - gridTop;
      setFirstRow(Math.max(0, Math.floor(rel / rowHeight) - overscan));
      setWinRows(Math.ceil(sc.clientHeight / rowHeight) + overscan * 2);
    } else {
      setFirstRow(0);
      setWinRows(Math.ceil(window.innerHeight / rowHeight) + overscan * 2);
    }
  }, [aspectRatio, gap, minColWidth, overscan]);

  // find the scrolling parent
  useLayoutEffect(() => {
    let el: HTMLElement | null = outerRef.current?.parentElement ?? null;
    while (el) {
      const oy = getComputedStyle(el).overflowY;
      if (oy === "auto" || oy === "scroll") break;
      el = el.parentElement;
    }
    // fallback: the document scroller
    scrollRef.current = el ?? (document.scrollingElement as HTMLElement | null);
    recompute();
  }, [recompute]);

  // recompute on scroll/resize/content change, max once per frame
  useEffect(() => {
    const sc = scrollRef.current;
    let raf = 0;
    const onScroll = () => {
      if (animate) suspendLayout();
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        recompute();
      });
    };
    sc?.addEventListener("scroll", onScroll, { passive: true });
    // document scroller fires scroll on window
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    let ro: ResizeObserver | undefined;
    if (outerRef.current && typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(() => recompute());
      ro.observe(outerRef.current);
    }
    recompute();
    return () => {
      if (raf) cancelAnimationFrame(raf);
      sc?.removeEventListener("scroll", onScroll);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      ro?.disconnect();
    };
  }, [recompute, items.length, animate, suspendLayout]);

  const { cols, rowHeight } = metrics;
  const totalRows = Math.max(1, Math.ceil(items.length / cols));
  // extra rows around a resize
  const pad = resizing ? Math.max(4, overscan * 2) : 0;
  const startRow = Math.max(0, Math.min(firstRow, Math.max(0, totalRows - 1)) - pad);
  const endRow = Math.min(totalRows, startRow + winRows + pad * 2);
  const start = startRow * cols;
  const end = Math.min(items.length, endRow * cols);
  const visible = items.slice(start, end);
  // N rows = N heights + (N-1) gaps, so remove one gap
  const totalHeight = Math.max(0, totalRows * rowHeight - gap);

  return (
    <div ref={setOuter} className={className} style={{ position: "relative", height: totalHeight }}>
      <div
        style={{
          position: "absolute",
          // move the window with transform instead of top (cheaper)
          top: 0,
          transform: `translate3d(0, ${startRow * rowHeight}px, 0)`,
          willChange: "transform",
          left: 0,
          right: 0,
          display: "grid",
          gridTemplateColumns: `repeat(auto-fill, minmax(${minColWidth}px, 1fr))`,
          gap,
        }}
      >
        {animate && keyOf
          ? visible.map((item, i) => (
              <motion.div
                key={keyOf(item)}
                // only animate position, never size. Only on around a reorder/resize.
                layout={(reordering || resizing) && layoutIdle ? "position" : false}
                transition={{ type: "spring", stiffness: 500, damping: 42, mass: 0.7 }}
                // single-cell grid so the tile stretches like a normal grid child
                style={{ display: "grid" }}
              >
                {renderItem(item, { index: start + i, cols })}
              </motion.div>
            ))
          : visible.map((item, i) => renderItem(item, { index: start + i, cols }))}
      </div>
    </div>
  );
}
