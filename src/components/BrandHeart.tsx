import { useId } from "react";

/**
 * Heart in the app icon colors (orange -> pink) for the setup screens.
 * Drawn as SVG instead of an emoji.
 */
export function BrandHeart({ className }: { className?: string }) {
  const id = useId();
  return (
    <svg viewBox="0 0 48 44" aria-hidden className={className}>
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="var(--color-brand-400)" />
          <stop offset="55%" stopColor="var(--color-brand-500)" />
          <stop offset="100%" stopColor="var(--color-accent2-500)" />
        </linearGradient>
      </defs>
      <path
        fill={`url(#${id})`}
        d="M24 42.2C10.6 33.4 2 25.9 2 16.3 2 8.9 7.6 3.5 14.6 3.5c4 0 7.5 1.9 9.4 4.7 1.9-2.8 5.4-4.7 9.4-4.7 7 0 12.6 5.4 12.6 12.8 0 9.6-8.6 17.1-22 25.9Z"
      />
      {/* highlight */}
      <path
        fill="rgba(255,255,255,0.45)"
        d="M13.4 9.2c-2.9.6-5 3-5.3 6 -.1.9.6 1.6 1.5 1.5.7-.1 1.2-.6 1.3-1.3.2-1.7 1.4-3 3-3.4.8-.2 1.3-1 1.1-1.8-.2-.7-.9-1.1-1.6-1Z"
      />
    </svg>
  );
}

/** The heart with a glow behind it. */
export function BrandHeartMark({ className, size = "h-20 w-20" }: { className?: string; size?: string }) {
  return (
    <div className={`relative ${size} ${className ?? ""}`}>
      <div
        aria-hidden
        className="absolute inset-0 -z-10 rounded-full blur-2xl"
        style={{
          background:
            "radial-gradient(circle, color-mix(in srgb, var(--color-brand-500) 70%, transparent), transparent 70%)",
        }}
      />
      <BrandHeart className={`${size} drop-shadow-[0_6px_18px_rgba(0,0,0,0.55)]`} />
    </div>
  );
}
