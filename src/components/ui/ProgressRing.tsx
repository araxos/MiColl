import { useId } from "react";
import { cn } from "@/lib/utils";

interface ProgressRingProps {
  value: number; // 0..1
  size?: number;
  stroke?: number;
  className?: string;
  trackClassName?: string;
  /** the arc in the theme's two colours with a soft glow (casual month cards) */
  glow?: boolean;
  children?: React.ReactNode;
}

/** Small circular progress for month cards. */
export function ProgressRing({
  value,
  size = 44,
  stroke = 4,
  className,
  trackClassName,
  glow,
  children,
}: ProgressRingProps) {
  const id = useId();
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const clamped = Math.max(0, Math.min(1, value));
  const offset = c * (1 - clamped);
  const arc = (extra?: string, style?: React.CSSProperties) => (
    <circle
      cx={size / 2}
      cy={size / 2}
      r={r}
      fill="none"
      strokeWidth={stroke}
      strokeLinecap="round"
      strokeDasharray={c}
      strokeDashoffset={offset}
      stroke={glow ? `url(#${id}g)` : undefined}
      style={style}
      className={cn("transition-[stroke-dashoffset] duration-500", !glow && "stroke-brand-500", !glow && className, extra)}
    />
  );
  return (
    <div className="relative inline-flex items-center justify-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90 overflow-visible">
        {glow && (
          <defs>
            <linearGradient id={`${id}g`} x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" style={{ stopColor: "var(--color-brand-300)" }} />
              <stop offset="1" style={{ stopColor: "var(--color-accent2-500)" }} />
            </linearGradient>
          </defs>
        )}
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          strokeWidth={stroke}
          className={cn(glow ? "stroke-brand-500/15" : "stroke-zinc-700/70", trackClassName)}
        />
        {/* the glow: a blurred copy under the arc */}
        {glow && clamped > 0 && arc("opacity-80", { filter: "blur(1.6px)" })}
        {(!glow || clamped > 0) && arc()}
      </svg>
      {children && (
        <span
          className={cn(
            "absolute inset-0 flex items-center justify-center text-[11px] font-semibold",
            glow ? "text-brand-100" : "text-zinc-200",
          )}
        >
          {children}
        </span>
      )}
    </div>
  );
}
