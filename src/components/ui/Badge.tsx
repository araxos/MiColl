import { cn } from "@/lib/utils";

type Tone = "neutral" | "brand" | "green" | "amber" | "rose" | "zinc";

const tones: Record<Tone, string> = {
  neutral: "bg-zinc-800/80 text-zinc-300 ring-1 ring-inset ring-zinc-700",
  brand: "bg-brand-500/15 text-brand-300 ring-1 ring-inset ring-brand-500/30",
  green: "bg-emerald-500/15 text-emerald-300 ring-1 ring-inset ring-emerald-500/30",
  amber: "bg-amber-500/15 text-amber-300 ring-1 ring-inset ring-amber-500/30",
  rose: "bg-rose-500/15 text-rose-300 ring-1 ring-inset ring-rose-500/30",
  zinc: "bg-zinc-700/40 text-zinc-400 ring-1 ring-inset ring-zinc-700",
};

export function Badge({
  tone = "neutral",
  className,
  children,
}: {
  tone?: Tone;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium",
        tones[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}
