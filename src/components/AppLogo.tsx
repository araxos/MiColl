import { BrandMark } from "@/components/BrandMark";
import { CyberLogo } from "@/components/CyberLogo";
import { KdaMark } from "@/components/KdaMark";
import { SakuraMark } from "@/components/SakuraMark";
import { useSfwMode } from "@/lib/contentMode";
import { useIriAltIcon } from "@/lib/iriAltIcon";
import { useT } from "@/lib/i18n";
import { setSidebar, useSidebar } from "@/lib/sidebar";
import { useAccent } from "@/lib/theme";

/**
 * The logo top left. Shows and hides the left bar (SideBar), it sits in the bar while
 * that's open and in the top bar otherwise, at the same spot.
 */
export function AppLogo() {
  const t = useT();
  const accent = useAccent();
  const sfw = useSfwMode();
  const open = useSidebar();
  // iridescent alternate logo (right-click the swatch): the holo outline M
  const iriAlt = useIriAltIcon();
  const kda = accent === "iridescent" && iriAlt;
  return (
    <button
      type="button"
      onClick={() => setSidebar(!open)}
      // no tooltip while the bar is hidden, the page buttons slide down there
      title={open ? t("Hide the sidebar") : undefined}
      aria-label={open ? undefined : t("Show the sidebar")}
      aria-expanded={open}
      className="flex shrink-0 items-center"
    >
      {kda ? (
        // the holo outline M with its colours running through it, glowing (same as
        // MiColl Mobile's "Alt. icon"), a bit bigger than its 32px box
        <span className="kda-glow relative -m-1 inline-flex">
          <KdaMark className="h-10 w-10" />
          {sfw && (
            <span title={t("SFW mode is on")} className="sfw-dot absolute right-0.5 top-0.5" />
          )}
        </span>
      ) : (
        <span className="relative inline-flex h-8 w-8 items-center justify-center">
          {accent === "sakura" ? (
            // the theme icon morphs into a blossom
            <SakuraMark className="absolute inset-0 h-8 w-8" />
          ) : accent === "cyberpunk" ? (
            // the app icon with animations off, else the colour-glitching mark. The SFW
            // dot sits outside its clip so the glow isn't cut off
            <CyberLogo />
          ) : (
            <BrandMark className="h-8 w-8" />
          )}
          {sfw && (
            <span title={t("SFW mode is on")} className="sfw-dot absolute -right-0.5 -top-0.5" />
          )}
        </span>
      )}
    </button>
  );
}
