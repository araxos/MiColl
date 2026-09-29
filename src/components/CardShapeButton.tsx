import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { LayoutGrid } from "lucide-react";
import { useAccent } from "@/lib/theme";
import { useDialogTheme } from "@/lib/dialogTheme";
import {
  setTileOverride,
  TILE_SHAPES,
  useTileOverride,
  useTileShape,
  type TileScope,
  type TileShapeDef,
} from "@/lib/tileShape";
import { cn } from "@/lib/utils";
import { useT, useTf } from "@/lib/i18n";

/** About how tall the list is, only used to decide if it opens up or down. */
const NEEDED = 260;

/** A shape as a small rectangle, every row stays 16px high. */
function ShapeMark({ shape }: { shape: TileShapeDef }) {
  return (
    <span className="grid h-4 w-4 shrink-0 place-items-center">
      <span
        className={cn(
          "rounded-[2px] border border-current",
          shape.aspect,
          shape.ratioHW >= 1 ? "h-3.5" : "w-3.5",
        )}
      />
    </span>
  );
}

/**
 * Card shape button on a page: the same shapes as in Settings plus "Default".
 * It saves an override for one creator (overrideKey). "Default" removes the override
 * so the page follows Settings again.
 * Own popover instead of the context menu, because that one is off without a backend.
 */
export function CardShapeButton({
  scope,
  overrideKey,
  what,
  className,
}: {
  /** Which global setting this page uses by default. */
  scope: TileScope;
  /** Key like artist:12 or artist-months:12. */
  overrideKey: string;
  /** Used in the tooltip, e.g. "this creator". */
  what: string;
  className?: string;
}) {
  const t = useT();
  const tf = useTf();
  const accent = useAccent();
  const irid = accent === "iridescent";
  const cyber = accent === "cyberpunk";
  const sak = accent === "sakura";
  const { menu, menuRow, control } = useDialogTheme();
  const btnRef = useRef<HTMLButtonElement>(null);
  // list position on screen, null = closed
  const [at, setAt] = useState<{ right: number; top?: number; bottom?: number; maxH: number } | null>(
    null,
  );
  const open = !!at;
  const own = useTileOverride(overrideKey);
  const fallback = useTileShape(scope);
  const active = own ? (TILE_SHAPES.find((s) => s.key === own) ?? fallback) : fallback;

  const close = () => setAt(null);

  // portaled to <body> so the scroll container doesn't cut it off
  const toggle = () => {
    if (open) return close();
    const r = btnRef.current?.getBoundingClientRect();
    if (!r) return;
    const GAP = 6;
    // keep space for the top bar
    const above = r.top - 64 - GAP;
    const below = window.innerHeight - r.bottom - 8 - GAP;
    const right = window.innerWidth - r.right;
    // open upwards if possible (downwards would cover the grid)
    setAt(
      above >= NEEDED || above >= below
        ? { right, bottom: window.innerHeight - r.top + GAP, maxH: above }
        : { right, top: r.bottom + GAP, maxH: below },
    );
  };

  // close on scroll/resize (capture, the scrolling element is inside)
  useEffect(() => {
    if (!open) return;
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [open]);

  const pick = (key: TileShapeDef["key"] | null) => {
    setTileOverride(overrideKey, key);
    close();
  };

  const row = (
    selected: boolean,
    shape: TileShapeDef,
    label: string,
    note: string,
    onClick: () => void,
  ) => (
    <button
      key={label}
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-sm transition-colors",
        menuRow,
        selected && (irid ? "bg-white/12" : "text-brand-200"),
      )}
    >
      <ShapeMark shape={shape} />
      <span className="flex-1 truncate">{label}</span>
      <span className={cn("shrink-0 text-[11px] tabular-nums", irid ? "text-white/70" : "text-zinc-500")}>
        {note}
      </span>
      <span className="w-3 shrink-0 text-xs">{selected ? "✓" : ""}</span>
    </button>
  );

  return (
    <span className={cn("inline-flex", className)}>
      <button
        ref={btnRef}
        onClick={toggle}
        title={tf(
          own
            ? "Card shape for {what} — {shape} {ratio}"
            : "Card shape for {what} — {shape} {ratio} (from Settings)",
          { what, shape: t(active.label), ratio: active.ratio },
        )}
        aria-label={t("Card shape")}
        aria-expanded={open}
        className={cn(
          "inline-grid h-8 w-8 place-items-center outline-none transition-colors focus-visible:ring-2 focus-visible:ring-brand-500",
          control,
          // show a small marker if the page has its own shape
          own &&
            (irid
              ? "!border-white/60"
              : cyber
                ? "!border-[#fcee0a] !text-[#fcee0a]"
                : sak
                  ? "!border-[#f9a8d4] !text-[#f9a8d4]"
                  : "border-brand-500/60 text-brand-200"),
        )}
      >
        <LayoutGrid className="h-4 w-4" />
      </button>
      {at &&
        createPortal(
          <>
            {/* click-away layer */}
            <div className="fixed inset-0 z-[70]" onClick={close} />
            {/* position on a wrapper, because menu has "relative" on iridescent */}
            <div
              className="fixed z-[71] w-60 overflow-y-auto"
              style={{
                right: at.right,
                top: at.top,
                bottom: at.bottom,
                maxHeight: Math.max(160, at.maxH),
              }}
            >
              <div className={cn("p-1.5", menu)}>
                {row(!own, fallback, t("Default"), t(fallback.label), () => pick(null))}
                <div className={cn("my-1 h-px", irid ? "bg-white/10" : "bg-zinc-800")} />
                {TILE_SHAPES.map((s) => row(own === s.key, s, t(s.label), s.ratio, () => pick(s.key)))}
              </div>
            </div>
          </>,
          document.body,
        )}
    </span>
  );
}
