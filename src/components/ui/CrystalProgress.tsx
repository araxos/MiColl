import { useId } from "react";
import { cn } from "@/lib/utils";

interface CrystalProgressProps {
  value: number; // 0..1
  /** Height in px (width = size * 0.75). */
  size?: number;
  className?: string;
  children?: React.ReactNode;
}

// the gem shape in its 24x32 viewBox (straight lines only)
const GEM = "M12 1 L21 10 L12 31 L3 10 Z";
const GEM_TOP = 1;
const GEM_BOTTOM = 31;

/**
 * Iridescent version of the ProgressRing on the month header: a crystal that fills
 * from the bottom with the pearl gradient, with facet lines on top.
 * Only used on iridescent.
 */
export function CrystalProgress({
  value,
  size = 64,
  className,
  children,
}: CrystalProgressProps) {
  const uid = useId();
  const clipId = `crystal-clip-${uid}`;
  const gradId = `crystal-foil-${uid}`;
  const clamped = Math.max(0, Math.min(1, value));
  const level = GEM_BOTTOM - (GEM_BOTTOM - GEM_TOP) * clamped;
  const width = (size * 24) / 32;
  return (
    <div
      className={cn("relative inline-flex items-center justify-center", className)}
      style={{ width, height: size }}
      role="img"
      aria-label={`${Math.round(clamped * 100)}% owned`}
    >
      <svg viewBox="0 0 24 32" width={width} height={size}>
        <defs>
          <clipPath id={clipId}>
            <path d={GEM} />
          </clipPath>
          <linearGradient id={gradId} x1="0" y1="32" x2="24" y2="0" gradientUnits="userSpaceOnUse">
            <stop offset="0" stopColor="#bae6fd" />
            <stop offset="0.35" stopColor="#a7f3d0" />
            <stop offset="0.7" stopColor="#f5c2ff" />
            <stop offset="1" stopColor="#c4b5fd" />
          </linearGradient>
        </defs>
        <g clipPath={`url(#${clipId})`}>
          {/* dark glass (the empty part) */}
          <rect x="0" y="0" width="24" height="32" fill="rgba(9,9,11,0.55)" />
          {/* pearl fill, rises with the owned share */}
          <rect
            className="iri-crystal-fill"
            x="0"
            y={level}
            width="24"
            height={GEM_BOTTOM - level}
            fill={`url(#${gradId})`}
          />
          {/* bright line at the fill level (hidden when empty/full) */}
          {clamped > 0.02 && clamped < 0.98 && (
            <rect x="0" y={level - 0.4} width="24" height="0.8" fill="#ffffff" opacity="0.8" />
          )}
          {/* diagonal shine on the top left */}
          <path d="M5.5 7.5 L12 1 L14.5 3.5 L7 10.5 Z" fill="#ffffff" opacity="0.28" />
          {/* facet lines */}
          <g stroke="rgba(255,255,255,0.35)" strokeWidth="0.6" fill="none">
            <path d="M3 10 L21 10" />
            <path d="M12 1 L7.5 10 M12 1 L16.5 10" />
            <path d="M7.5 10 L12 31 M16.5 10 L12 31" />
          </g>
        </g>
        {/* outer edge */}
        <path d={GEM} fill="none" stroke="rgba(236,231,255,0.65)" strokeWidth="0.8" />
      </svg>
      {children && (
        <span className="absolute inset-0 flex items-center justify-center pb-[22%] text-[11px] font-semibold text-zinc-50 drop-shadow-[0_1px_2px_rgba(0,0,0,0.7)]">
          {children}
        </span>
      )}
    </div>
  );
}
