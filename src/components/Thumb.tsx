import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { cn, seedGradient, softScale } from "@/lib/utils";
import { useAccent } from "@/lib/theme";
import { ImageOff } from "lucide-react";

/**
 * Image preview. Shows src, or a gradient from seed if there's no image
 * (with an optional label).
 */
export function Thumb({
  src,
  alts,
  seed,
  label,
  className,
  rounded = "rounded-xl",
  showMissingIcon = false,
  loading,
}: {
  src?: string;
  /** Fallback URLs if src doesn't load. */
  alts?: string[];
  seed: string;
  label?: string;
  className?: string;
  rounded?: string;
  showMissingIcon?: boolean;
  /** "lazy" for long lists, otherwise eager so grids don't fade in tile by tile. */
  loading?: "eager" | "lazy";
}) {
  // if a thumbnail fails (deleted, MiSD unplugged, locked) try the next one,
  // the gradient is the last fallback
  const accent = useAccent();
  const [at, setAt] = useState(0);
  const chain = [src, ...(alts ?? [])].filter((s): s is string => !!s);
  const key = chain.join("|");
  useEffect(() => setAt(0), [key]);
  const current = chain[at];

  if (current) {
    return (
      <img
        // keyed by URL so a failed img is replaced, not reused
        key={current}
        src={current}
        alt={label ?? seed}
        // decode off the main thread (smoother scrolling)
        decoding="async"
        loading={loading}
        onError={() => setAt((i) => i + 1)}
        className={cn("h-full w-full object-cover", rounded, className)}
      />
    );
  }
  return (
    <ThumbFace
      seed={seed}
      label={label}
      className={className}
      rounded={rounded}
      showMissingIcon={showMissingIcon}
      irid={accent === "iridescent"}
    />
  );
}

/** The label's size at a 180px wide tile (text-sm). */
const FACE_LABEL_PX = 14;
const FACE_REF_PX = 180;

/**
 * No image: a gradient with the label, which grows with the tile (softly, see softScale).
 * Iridescent gets the theme's own pearl face (same as the new creator preview), not
 * the per-name gradient of the standard themes.
 */
function ThumbFace({
  seed,
  label,
  className,
  rounded,
  showMissingIcon,
  irid,
}: {
  seed: string;
  label?: string;
  className?: string;
  rounded?: string;
  showMissingIcon: boolean;
  irid: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [labelPx, setLabelPx] = useState(FACE_LABEL_PX);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !label) return;
    const place = () => setLabelPx(FACE_LABEL_PX * softScale(el.clientWidth, FACE_REF_PX));
    place();
    const ro = new ResizeObserver(place);
    ro.observe(el);
    return () => ro.disconnect();
  }, [label]);
  return (
    <div
      ref={ref}
      className={cn(
        "relative flex h-full w-full items-center justify-center overflow-hidden",
        irid && "iri-face",
        rounded,
        className,
      )}
      style={irid ? undefined : { background: seedGradient(seed) }}
    >
      {!irid && <div className="absolute inset-0 bg-black/15" />}
      {showMissingIcon ? (
        <ImageOff className={cn("relative h-6 w-6", irid ? "text-zinc-900/60" : "text-white/70")} />
      ) : (
        label && (
          <span
            className={cn(
              "relative px-2 text-center font-semibold leading-snug",
              irid ? "text-zinc-900/80" : "text-white/90 drop-shadow",
            )}
            style={{ fontSize: labelPx }}
          >
            {label}
          </span>
        )
      )}
    </div>
  );
}
