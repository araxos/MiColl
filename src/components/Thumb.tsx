import { useEffect, useState } from "react";
import { cn, seedGradient } from "@/lib/utils";
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
    <div
      className={cn(
        "relative flex h-full w-full items-center justify-center overflow-hidden",
        rounded,
        className,
      )}
      style={{ background: seedGradient(seed) }}
    >
      <div className="absolute inset-0 bg-black/15" />
      {showMissingIcon ? (
        <ImageOff className="relative h-6 w-6 text-white/70" />
      ) : (
        label && (
          <span className="relative px-2 text-center text-sm font-semibold text-white/90 drop-shadow">
            {label}
          </span>
        )
      )}
    </div>
  );
}
