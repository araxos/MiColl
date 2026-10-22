import { useEffect } from "react";

/**
 * Arrow keys in the card grids (creators, months, rewards): the focus moves to the
 * card next to the focused one, Enter opens it (the cards are buttons). With nothing
 * focused the first arrow picks the first card on screen.
 *
 * The cards carry data-kbd-tile. Left / right go by page order (wrapping into the next
 * row), up / down by position, so grids with wide and narrow cells and several grids on
 * one page (drops, unsorted, inline rewards) work alike. The creator grid is virtual:
 * the rows next to the screen are always mounted, so the next card is there.
 */
export function GridKeys() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const dir = DIRS[e.key];
      if (!dir || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || e.defaultPrevented) return;
      // the viewer has its own arrows, a dialog or drawer on top owns the keys
      if (document.querySelector(".micoll-viewer") || overlayOpen()) return;
      const active = document.activeElement as HTMLElement | null;
      const onTile = active?.matches("[data-kbd-tile]") ? active : null;
      // only from a card or from nowhere (body), never from a field, a list or a menu
      if (!onTile && active && active !== document.body) return;

      const tiles = visibleTiles();
      if (tiles.length === 0) return;
      e.preventDefault();
      const next = onTile ? neighbour(tiles, onTile, dir) : firstOnScreen(tiles);
      if (!next) return;
      next.focus({ preventScroll: true });
      next.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return null;
}

type Dir = "left" | "right" | "up" | "down";
const DIRS: Record<string, Dir | undefined> = {
  ArrowLeft: "left",
  ArrowRight: "right",
  ArrowUp: "up",
  ArrowDown: "down",
};

/** A dialog, drawer or panel over the page (they're fixed and full-screen). */
function overlayOpen(): boolean {
  return [...document.querySelectorAll<HTMLElement>(".fixed.inset-0, [aria-modal]")].some((el) => {
    const z = Number(getComputedStyle(el).zIndex);
    return el.matches("[aria-modal]") || (Number.isFinite(z) && z >= 40);
  });
}

function visibleTiles(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>("[data-kbd-tile]")].filter((el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  });
}

function firstOnScreen(tiles: HTMLElement[]): HTMLElement | undefined {
  return tiles.find((el) => {
    const r = el.getBoundingClientRect();
    return r.bottom > 0 && r.top < window.innerHeight;
  }) ?? tiles[0];
}

function neighbour(tiles: HTMLElement[], from: HTMLElement, dir: Dir): HTMLElement | undefined {
  const i = tiles.indexOf(from);
  if (dir === "left") return i > 0 ? tiles[i - 1] : undefined;
  if (dir === "right") return i >= 0 ? tiles[i + 1] : undefined;
  // up / down: the nearest row in that direction, then the card closest in x
  const a = from.getBoundingClientRect();
  const ax = a.left + a.width / 2;
  let best: HTMLElement | undefined;
  let bestRow = Infinity;
  let bestX = Infinity;
  for (const el of tiles) {
    if (el === from) continue;
    const r = el.getBoundingClientRect();
    const cy = r.top + r.height / 2;
    // another row: its middle is past the edge of this card
    const dy = dir === "down" ? cy - a.bottom : a.top - cy;
    if (dy <= 0) continue;
    const row = Math.round(dy / 8); // cards of one row differ by a few px at most
    const dx = Math.abs(r.left + r.width / 2 - ax);
    if (row < bestRow || (row === bestRow && dx < bestX)) {
      best = el;
      bestRow = row;
      bestX = dx;
    }
  }
  return best;
}
