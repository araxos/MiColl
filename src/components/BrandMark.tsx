import { useAccent, type AccentKey } from "@/lib/theme";
import { cn } from "@/lib/utils";
import { DASHBOARD_ICONS } from "@/lib/appIcon";
import { markPhase } from "@/lib/markClock";
import logoUrl from "@/assets/micoll-logo.png";

/**
 * Gradient colors per theme for the app icon mark. Only the color changes.
 * purple is left out on purpose (original colors).
 */
const MARK_GRADIENTS: Partial<Record<AccentKey, string[]>> = {
  rose: ["#f472b6", "#d946ef"],
  blue: ["#0ea5e9", "#06b6d4"],
  green: ["#22c55e", "#14b8a6"],
  yellow: ["#fbbf24", "#eab308"],
  sakura: ["#ffc1da", "#f472b6", "#d6418f"],
  iridescent: ["#c4b5fd", "#f5c2ff", "#a7f3d0", "#bae6fd"],
  // cyberpunk yellow
  cyberpunk: ["#fff15c", "#fcee0a", "#f5a623"],
};

/**
 * The app icon next to the window title. Other accents tint the same shape
 * (the icon alpha is used as a mask). Size it with className.
 */
export function BrandMark({ className, solid }: { className?: string; solid?: string }) {
  const accent = useAccent();
  const stops = MARK_GRADIENTS[accent];

  // solid: the logo shape in one flat color ("currentColor" works: CyberLogo colours it)
  if (solid) {
    const mid = "micoll-mark-mask-solid";
    return (
      <div className={cn("relative", className)}>
        <svg viewBox="0 0 100 100" className="h-full w-full" xmlns="http://www.w3.org/2000/svg">
          <defs>
            <mask id={mid} style={{ maskType: "alpha" }}>
              <image href={logoUrl} x="0" y="0" width="100" height="100" preserveAspectRatio="xMidYMid meet" />
            </mask>
          </defs>
          <rect x="0" y="0" width="100" height="100" fill={solid} mask={`url(#${mid})`} />
        </svg>
      </div>
    );
  }

  // purple/blue/green/yellow have their own artwork, rose uses the original file,
  // premium accents draw the mark in Layout
  const own = DASHBOARD_ICONS[accent];
  if (own) {
    return <img src={own} alt="" draggable={false} className={cn("object-contain", className)} />;
  }

  // no artwork and no gradient -> the normal icon
  if (!stops) {
    return (
      <img
        src={logoUrl}
        alt=""
        draggable={false}
        className={cn("object-contain", className)}
      />
    );
  }

  const gid = `micoll-mark-grad-${accent}`;
  const mid = `micoll-mark-mask-${accent}`;
  // cyberpunk = glitch, iridescent = hue shimmer, others static
  const markAnim =
    accent === "cyberpunk"
      ? "micoll-mark-glitch 4s steps(1, end) infinite"
      : accent === "iridescent"
        ? "micoll-iri-mark 7s ease-in-out infinite"
        : undefined;
  // continue the animation where it was (see markClock)
  const markPeriod = accent === "cyberpunk" ? 4000 : 7000;
  return (
    // fx-logo: the "Logo" animation switch (index.css)
    <div className={cn("fx-logo relative", className)}>
      <svg
        viewBox="0 0 100 100"
        className="h-full w-full"
        xmlns="http://www.w3.org/2000/svg"
        style={markAnim ? { animation: markAnim, animationDelay: markPhase(markPeriod) } : undefined}
      >
        <defs>
          <linearGradient id={gid} x1="0" y1="0" x2="1" y2="1">
            {stops.map((c, i) => (
              <stop key={i} offset={i / (stops.length - 1)} stopColor={c} />
            ))}
          </linearGradient>
          {/* icon alpha as mask */}
          <mask id={mid} style={{ maskType: "alpha" }}>
            <image href={logoUrl} x="0" y="0" width="100" height="100" preserveAspectRatio="xMidYMid meet" />
          </mask>
        </defs>
        <rect x="0" y="0" width="100" height="100" fill={`url(#${gid})`} mask={`url(#${mid})`} />
      </svg>
    </div>
  );
}
