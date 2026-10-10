import { cn } from "@/lib/utils";
import { useAccent } from "@/lib/theme";
import { forwardRef, type ButtonHTMLAttributes } from "react";

type Variant = "primary" | "secondary" | "ghost" | "outline";
type Size = "sm" | "md" | "icon";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
}

// micoll-hover = hover fill from the accent (see index.css), not flat grey
const variants: Record<Variant, string> = {
  primary:
    "border border-transparent bg-brand-600 text-white hover:bg-brand-500 shadow-lg shadow-brand-900/30",
  secondary: "border border-transparent bg-zinc-800 text-zinc-100 micoll-hover",
  ghost: "text-zinc-300 micoll-hover micoll-hover-ink",
  outline: "border border-zinc-700 text-zinc-200 micoll-hover micoll-hover-ink",
};

const sizes: Record<Size, string> = {
  sm: "h-8 px-3 text-sm gap-1.5",
  md: "h-10 px-4 text-sm gap-2",
  icon: "h-9 w-9",
};

// premium themes get their own button look (primary = the theme's fill,
// outline = its frosted/neon edge). Standard accents keep the brand style.
const premium: Partial<Record<string, Partial<Record<Variant, string>>>> = {
  iridescent: {
    // iridescent primary: glossy holo pill with a gradient that moves on hover
    primary:
      "rounded-full border-0 text-zinc-900 [background-image:linear-gradient(90deg,#c4b5fd,#f5c2ff,#a7f3d0,#bae6fd)] bg-[length:200%_100%] bg-left shadow-lg shadow-accent2-500/30 ring-1 ring-inset ring-white/25 transition-[background-position,box-shadow] duration-500 ease-out hover:bg-right hover:opacity-90 hover:shadow-accent2-500/50",
    // iri-frost instead of backdrop-blur (blur in blur draws a dark line, see
    // lib/glassButtons.ts)
    outline: "iri-frost border border-white/20 bg-white/10 text-zinc-100 hover:bg-white/20",
    ghost: "text-zinc-100 hover:bg-white/15 hover:text-white",
    secondary: "border-0 bg-white/12 text-zinc-100 backdrop-blur hover:bg-white/20",
  },
  sakura: {
    primary:
      "!border-0 !text-white [background-image:linear-gradient(90deg,#f472b6,#ec4899)] shadow-lg shadow-[#f472b6]/30 hover:opacity-90",
    outline: "border border-[#f9a8d4]/40 bg-[#f9a8d4]/10 text-zinc-100 hover:bg-[#f9a8d4]/20",
    ghost: "text-zinc-200 hover:bg-[#f9a8d4]/15 hover:text-white",
    secondary: "border-0 bg-[#f9a8d4]/15 text-zinc-100 hover:bg-[#f9a8d4]/25",
  },
  cyberpunk: {
    primary:
      "!rounded-none !border-0 !bg-[#fcee0a] !text-zinc-950 shadow-[0_0_16px_rgba(252,238,10,0.35)] hover:!bg-[#fff35c]",
    outline:
      "!rounded-none border border-[#fcee0a]/60 bg-zinc-950/50 text-zinc-100 hover:bg-[#fcee0a]/10",
    // square, yellow on hover (not grey)
    ghost: "!rounded-none text-zinc-200 hover:bg-[#fcee0a]/12 hover:text-[#fcee0a]",
    secondary:
      "!rounded-none border border-[#fcee0a]/35 bg-zinc-950/60 text-zinc-100 hover:border-[#fcee0a]/70 hover:bg-[#fcee0a]/10",
  },
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = "secondary", size = "md", ...props }, ref) => {
    const accent = useAccent();
    const themed = premium[accent]?.[variant];
    return (
      <button
        ref={ref}
        className={cn(
          "inline-flex items-center justify-center rounded-lg font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-brand-500 disabled:opacity-50 disabled:pointer-events-none",
          // standard accents: a hook per variant for the classic "Premium look" (only
          // styled inside a .classic-panel, see index.css)
          themed ?? cn(variants[variant], `classic-btn classic-btn--${variant}`),
          sizes[size],
          className,
        )}
        {...props}
      />
    );
  },
);
Button.displayName = "Button";
