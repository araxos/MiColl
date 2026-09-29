import { BadgeCheck, Check } from "lucide-react";
import { SakuraBlossomIcon } from "@/lib/classIcons";
import { useT } from "@/lib/i18n";
import { useAccent } from "@/lib/theme";
import { cn } from "@/lib/utils";

/**
 * The "verified" check in the theme's style: sakura blossom, cyberpunk glitch check,
 * iridescent holo check, BadgeCheck everywhere else. Sized with className.
 * PlatformCheck below is the version for the corner of a platform badge.
 */
export function ThemeCheck({ className, label }: { className?: string; label: string }) {
  const accent = useAccent();

  if (accent === "sakura") {
    return (
      <span
        aria-label={label}
        role="img"
        className={cn("relative grid shrink-0 place-items-center", className)}
      >
        <SakuraBlossomIcon
          className="sak-bloom-badge absolute inset-0 h-full w-full"
          fill="currentColor"
          stroke="none"
        />
        <span className="sak-bloom-core relative grid h-1/2 w-1/2 place-items-center rounded-full">
          <Check className="h-[55%] w-[55%] text-white" strokeWidth={4} />
        </span>
      </span>
    );
  }
  if (accent === "cyberpunk") {
    return (
      <span
        aria-label={label}
        role="img"
        className={cn("cp-check relative grid shrink-0 place-items-center", className)}
      >
        <Check className="cp-check-base absolute inset-0 h-full w-full" strokeWidth={3.5} />
        <Check className="cp-check-ghost absolute inset-0 h-full w-full" strokeWidth={3.5} />
      </span>
    );
  }
  if (accent === "iridescent") {
    return <Check aria-label={label} className={cn("iri-check shrink-0", className)} strokeWidth={3.5} />;
  }
  return <BadgeCheck aria-label={label} className={cn("shrink-0 text-brand-400", className)} />;
}

/** Same mark in the corner of a platform badge, with its own offsets and a dark disc. */
export function PlatformCheck() {
  const t = useT();
  const accent = useAccent();
  if (accent === "sakura") {
    return (
      <span
        aria-label={t("Verified")}
        className="absolute -bottom-1 -right-1 grid h-3 w-3 place-items-center"
      >
        <SakuraBlossomIcon
          className="sak-bloom-badge absolute inset-0 h-3 w-3"
          fill="currentColor"
          stroke="none"
        />
        <span className="sak-bloom-core relative grid h-1.5 w-1.5 place-items-center rounded-full">
          <Check className="h-1 w-1 text-white" strokeWidth={4} />
        </span>
      </span>
    );
  }
  if (accent === "cyberpunk") {
    return (
      <span
        aria-label={t("Verified")}
        className="cp-check absolute -bottom-1 -right-1 grid h-3 w-3 place-items-center rounded-full bg-zinc-950/90 ring-1 ring-zinc-950"
      >
        <Check className="cp-check-base absolute inset-0.5 h-2 w-2" strokeWidth={3.5} />
        <Check className="cp-check-ghost absolute inset-0.5 h-2 w-2" strokeWidth={3.5} />
      </span>
    );
  }
  if (accent === "iridescent") {
    return (
      <span
        aria-label={t("Verified")}
        className="absolute -bottom-1 -right-1 grid h-3 w-3 place-items-center rounded-full bg-zinc-950/90 ring-1 ring-zinc-950"
      >
        <Check className="iri-check h-2 w-2" strokeWidth={3.5} />
      </span>
    );
  }
  return (
    <BadgeCheck className="absolute bottom-0 right-0 h-2.5 w-2.5 rounded-full bg-zinc-950 text-brand-300 ring-1 ring-zinc-950" />
  );
}
