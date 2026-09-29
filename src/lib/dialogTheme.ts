/**
 * Theme styles for small dialogs and toasts, so every dialog matches the theme
 * (premium themes shouldn't get a plain grey box). Import this instead of copying classes.
 */
import { useAccent } from "@/lib/theme";
import { cn } from "@/lib/utils";

export interface DialogTheme {
  /** The dialog panel (border, background, glow, clip-path). */
  panel: string;
  /** Text input inside the panel. */
  input: string;
  /**
   * Like input but only the border/background + focus color (no size/padding).
   * For wrappers, textareas, small buttons. Uses focus-within so it works on both.
   */
  field: string;
  /** Border color for a divider line (add border-b / border-t yourself). */
  divider: string;
  /** A box inside the panel (group, card, list item) with border, fill and radius. */
  box: string;
  /** Lighter version of box, without radius (set it yourself). */
  soft: string;
  /**
   * Small bordered control that isn't a <Button> (pill, icon button, chip).
   * Includes the radius, so don't add your own rounded-* after it.
   */
  control: string;
  /**
   * Right-click menu panel. Like panel but without the cyberpunk clip-path
   * and without overflow-hidden (submenus must not get cut off).
   */
  menu: string;
  /** Hover color for a menu row. */
  menuRow: string;
  /** Color for a row whose submenu is open. */
  menuRowOpen: string;
  /**
   * Extra classes for the primary button, each premium theme gets its own fill.
   * undefined = default.
   */
  primary: string | undefined;
  /**
   * Filled accent (progress bar etc). Can be a gradient, so use opacity-70 instead of
   * bg-x/70.
   */
  accent: string;
  /** Accent colored text or icons (spinner etc). */
  accentText: string;
  /**
   * Toast card in the corner. Like panel but no clip-path and no border
   * (the toast has its own colored border). On sakura .sak-card overrides the border.
   */
  toast: string;
}

export function useDialogTheme(): DialogTheme {
  const accent = useAccent();
  const panel =
    accent === "cyberpunk"
      ? "rounded-none border border-[#fcee0a]/70 bg-zinc-950/95 ring-1 ring-inset ring-[#00e5ff]/15 shadow-[0_0_26px_rgba(252,238,10,0.18)] [clip-path:polygon(0_0,100%_0,100%_calc(100%-14px),calc(100%-14px)_100%,0_100%)]"
      : accent === "iridescent"
        ? "iri-menu relative overflow-hidden rounded-2xl border border-white/15 bg-zinc-900/70 ring-1 ring-inset ring-white/10 shadow-2xl shadow-black/40 backdrop-blur-2xl [transform:translateZ(0)]"
        : accent === "sakura"
          ? "sak-card rounded-2xl shadow-2xl"
          : "rounded-2xl border border-zinc-800 bg-zinc-900 shadow-2xl";
  const field =
    accent === "cyberpunk"
      ? "rounded-none border border-[#fcee0a]/40 bg-zinc-950 focus-within:border-[#fcee0a]/80"
      : accent === "iridescent"
        ? "rounded-lg border border-white/15 bg-white/10 focus-within:border-white/45"
        : accent === "sakura"
          ? "rounded-lg border border-[#f9a8d4]/30 bg-white/5 focus-within:border-[#f9a8d4]/70"
          : "rounded-lg border border-zinc-700 bg-zinc-950 focus-within:border-brand-500/60";
  const input = cn(
    "h-9 w-full px-3 text-sm text-zinc-100 outline-none transition-colors placeholder:text-zinc-500",
    field,
  );
  const divider =
    accent === "cyberpunk"
      ? "border-[#fcee0a]/25"
      : accent === "iridescent"
        ? "border-white/10"
        : accent === "sakura"
          ? "border-[#f9a8d4]/25"
          : "border-zinc-800";
  const box =
    accent === "cyberpunk"
      ? "rounded-none border border-[#fcee0a]/35 bg-zinc-950/60"
      : accent === "iridescent"
        ? "rounded-xl border border-white/12 bg-white/5 backdrop-blur"
        : accent === "sakura"
          ? "rounded-xl border border-[#f9a8d4]/25 bg-[#1b1016]/55"
          : "rounded-xl border border-zinc-800 bg-zinc-900";
  const soft =
    accent === "cyberpunk"
      ? "border-[#fcee0a]/25 bg-zinc-950/60"
      : accent === "iridescent"
        ? "border-white/15 bg-white/5"
        : accent === "sakura"
          ? "border-[#f9a8d4]/20 bg-[#1b1016]/45"
          : "border-zinc-700/60 bg-zinc-950/60";
  const control =
    accent === "cyberpunk"
      ? "rounded-none border border-[#fcee0a]/55 bg-zinc-950/60 text-zinc-100 hover:border-[#fcee0a]/90 hover:bg-[#fcee0a]/12 hover:text-[#fcee0a]"
      : accent === "iridescent"
        ? // `iri-frost` rather than `backdrop-blur`: these pills sit inside frosted
          // panels and bars, and a backdrop filter nested in another one draws a
          // dark seam down the pill's edge in WebView2. See lib/glassButtons.ts —
          // the blur is a setting now, not a class.
          "iri-frost rounded-lg border border-white/20 bg-white/10 text-zinc-100 hover:bg-white/20"
        : accent === "sakura"
          ? "rounded-lg border border-[#f9a8d4]/40 bg-[#f9a8d4]/10 text-zinc-100 hover:bg-[#f9a8d4]/20"
          : // `micoll-hover` = the accent's own hover fill (index.css), not zinc.
            "rounded-lg border border-zinc-700 text-zinc-200 micoll-hover micoll-hover-ink";
  const primary =
    accent === "cyberpunk"
      ? "!rounded-none !bg-[#fcee0a] !text-zinc-950 shadow-[0_0_16px_rgba(252,238,10,0.35)] hover:!bg-[#fff35c]"
      : accent === "iridescent"
        ? "!border-0 !text-zinc-900 [background-image:linear-gradient(90deg,#c4b5fd,#f5c2ff,#a7f3d0,#bae6fd)] hover:opacity-90"
        : accent === "sakura"
          ? "!border-0 !text-white [background-image:linear-gradient(90deg,#f472b6,#ec4899)] hover:opacity-90"
          : undefined;
  // same fills as primary, without the button parts
  const accentFill =
    accent === "cyberpunk"
      ? "bg-[#fcee0a]"
      : accent === "iridescent"
        ? "[background-image:linear-gradient(90deg,#c4b5fd,#f5c2ff,#a7f3d0,#bae6fd)]"
        : accent === "sakura"
          ? "[background-image:linear-gradient(90deg,#f472b6,#ec4899)]"
          : "bg-brand-500";
  const accentText =
    accent === "cyberpunk"
      ? "text-[#fcee0a]"
      : accent === "iridescent"
        ? "text-white"
        : accent === "sakura"
          ? "text-[#f9a8d4]"
          : "text-brand-300";
  const menu =
    accent === "cyberpunk"
      ? "rounded-none border border-[#fcee0a]/60 bg-zinc-950/95 ring-1 ring-inset ring-[#00e5ff]/15 shadow-[0_0_22px_rgba(252,238,10,0.16)] backdrop-blur"
      : accent === "iridescent"
        ? // `relative` is required: .iri-menu hangs its holographic strip off ::before.
          "iri-menu relative rounded-xl border border-white/15 bg-zinc-900/80 ring-1 ring-inset ring-white/10 shadow-2xl shadow-black/40 backdrop-blur-2xl"
        : accent === "sakura"
          ? "sak-card rounded-xl shadow-2xl backdrop-blur"
          : "rounded-xl border border-zinc-700 bg-zinc-900/95 shadow-2xl backdrop-blur";
  const menuRow =
    accent === "cyberpunk"
      ? "hover:bg-[#fcee0a]/15 hover:text-[#fcee0a]"
      : accent === "iridescent"
        ? "hover:bg-white/12"
        : accent === "sakura"
          ? "hover:bg-[#f9a8d4]/15"
          : "micoll-hover";
  const menuRowOpen =
    accent === "cyberpunk"
      ? "bg-[#fcee0a]/15 text-[#fcee0a]"
      : accent === "iridescent"
        ? "bg-white/12"
        : accent === "sakura"
          ? "bg-[#f9a8d4]/15"
          : "bg-brand-500/20";
  const toast =
    accent === "cyberpunk"
      ? "rounded-none bg-zinc-950/95 ring-1 ring-inset ring-[#00e5ff]/15 shadow-[0_0_20px_rgba(252,238,10,0.16)] backdrop-blur"
      : accent === "iridescent"
        ? // `relative` is required: .iri-menu hangs its holographic strip off ::before.
          "iri-menu relative rounded-xl bg-zinc-900/70 shadow-2xl shadow-black/40 backdrop-blur-2xl [transform:translateZ(0)]"
        : accent === "sakura"
          ? "sak-card rounded-xl shadow-2xl"
          : "rounded-xl bg-zinc-900/95 shadow-2xl shadow-black/40 backdrop-blur";
  return {
    panel,
    input,
    field,
    divider,
    box,
    soft,
    control,
    menu,
    menuRow,
    menuRowOpen,
    primary,
    accent: accentFill,
    accentText,
    toast,
  };
}
