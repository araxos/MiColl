import { cn } from "@/lib/utils";

interface ProgressRingProps {
  value: number; // 0..1
  size?: number;
  stroke?: number;
  className?: string;
  trackClassName?: string;
  children?: React.ReactNode;
}

/** Small circular progress for month cards. */
export function ProgressRing({
  value,
  size = 44,
  stroke = 4,
  className,
  trackClassName,
  children,
}: ProgressRingProps) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const clamped = Math.max(0, Math.min(1, value));
  const offset = c * (1 - clamped);
  return (
    <div className="relative inline-flex items-center justify-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          strokeWidth={stroke}
          className={cn("stroke-zinc-700/70", trackClassName)}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={offset}
          className={cn("stroke-brand-500 transition-[stroke-dashoffset] duration-500", className)}
        />
      </svg>
      {children && (
        <span className="absolute inset-0 flex items-center justify-center text-[11px] font-semibold text-zinc-200">
          {children}
        </span>
      )}
    </div>
  );
}
