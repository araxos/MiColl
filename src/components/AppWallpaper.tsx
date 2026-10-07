import { useEffect, useState } from "react";
import { isPremium, useAccent } from "@/lib/theme";
import { useAnimatedBg } from "@/lib/animatedBg";
import { useClassicLuxe } from "@/lib/classicLuxe";
import { useIridSnapshot } from "@/lib/iridSnapshot";
import {
  useWallpaper,
  useWallpaperDim,
  isWallpaperPreset,
  wallpaperPresetId,
} from "@/lib/wallpaper";
import { findWallpaperPreset, IRI_DEFAULT_WALLPAPER } from "@/lib/wallpaperPresets";
import { isTauri } from "@/lib/tauri";
import { readImage } from "@/api/library";
import { SakuraFx } from "@/components/SakuraFx";
import { SakuraStill } from "@/components/SakuraStill";
import { CyberpunkFx } from "@/components/CyberpunkFx";
import { CyberpunkStill } from "@/components/CyberpunkStill";
import { IridescentFx } from "@/components/IridescentFx";

/**
 * The app background, mounted ONCE in App (not per page), so the WebGL effects
 * aren't rebuilt on every navigation (that caused black flashes). Behind everything.
 */
export function AppWallpaper() {
  const accent = useAccent();
  // "Animated background" off -> skip the live FX and show the static gradient
  const animated = useAnimatedBg();
  const sakura = animated && accent === "sakura";
  const cyber = animated && accent === "cyberpunk";
  const irid = animated && accent === "iridescent";
  // iridescent without animation: show the saved shader snapshot (see iridSnapshot)
  const snapshot = useIridSnapshot();
  // "Premium look" on a classic accent. The flag on <html> drives all of its CSS
  // (index.css, "Classic premium look"), this is just the one place that sets it.
  const luxePref = useClassicLuxe();
  const luxe = luxePref && !isPremium(accent);
  useEffect(() => {
    document.documentElement.dataset.classicLuxe = luxe ? "1" : "0";
  }, [luxe]);

  // chosen wallpaper: a preset (bundled image) or a file path (read here)
  // if the file is gone we fall back to the theme
  const wallpaperPath = useWallpaper();
  const dim = useWallpaperDim();
  const preset = isWallpaperPreset(wallpaperPath)
    ? findWallpaperPreset(wallpaperPresetId(wallpaperPath))
    : undefined;
  const [file, setFile] = useState("");
  useEffect(() => {
    if (!wallpaperPath || isWallpaperPreset(wallpaperPath) || !isTauri()) {
      setFile("");
      return;
    }
    let alive = true;
    readImage(wallpaperPath)
      .then((d) => alive && setFile(d))
      .catch(() => alive && setFile(""));
    return () => {
      alive = false;
    };
  }, [wallpaperPath]);
  // iridescent default still, used when nothing is chosen and the animation is off
  const iriDefault =
    accent === "iridescent" && !animated && !wallpaperPath
      ? findWallpaperPreset(IRI_DEFAULT_WALLPAPER)
      : undefined;
  // the picture painted over the whole background (the shader preset is handled by
  // iridStill)
  const custom = preset ? preset.url : (iriDefault?.url ?? file);

  // a custom picture covers everything, so skip the iridescent shader behind it
  const iridStill = !custom && !animated && accent === "iridescent" && !!snapshot;
  // cyberpunk still is drawn from scratch (nothing to capture)
  const cyberStill = !custom && !animated && accent === "cyberpunk";
  // same for sakura
  const sakStill = !custom && !animated && accent === "sakura";
  return (
    <div
      aria-hidden
      className="app-wallpaper pointer-events-none absolute inset-0 z-0 overflow-hidden"
    >
      <div className="app-blobs absolute inset-0">
        <div className="absolute -left-[12%] -top-[18%] h-[55vh] w-[55vh] rounded-full bg-brand-600/25 blur-[120px]" />
        <div className="absolute right-[-10%] top-[8%] h-[48vh] w-[48vh] rounded-full bg-accent2-600/20 blur-[130px]" />
        <div className="absolute bottom-[-15%] left-[20%] h-[50vh] w-[50vh] rounded-full bg-brand-800/25 blur-[140px]" />
        <div className="absolute bottom-[5%] right-[12%] h-[36vh] w-[36vh] rounded-full bg-accent2-600/12 blur-[120px]" />
      </div>
      {/* grain/vignette so cards stay readable */}
      <div className="app-veil absolute inset-0 bg-zinc-950/40" />
      {/* classic premium look: the setup screens' sand + glow, with crystal glints */}
      {luxe && !custom && (
        <>
          <div className="classic-luxe-bg absolute inset-0" />
          <div className="classic-luxe-glints absolute inset-0" />
        </>
      )}
      {/* static iridescent wallpaper when animation is off */}
      {iridStill && (
        <div
          className="absolute inset-0 bg-cover bg-center"
          style={{ backgroundImage: `url(${snapshot})` }}
        />
      )}
      {/* static cyberpunk wallpaper when animation is off (see CyberpunkStill) */}
      {cyberStill && <CyberpunkStill />}
      {/* static sakura wallpaper when animation is off (see SakuraStill) */}
      {sakStill && <SakuraStill />}
      {/* premium FX above the veil. Only the iridescent shader gets replaced by a
          custom wallpaper, petals and rain still fall over it. */}
      {irid && !custom && <IridescentFx />}
      {custom && (
        <div
          className="absolute inset-0 bg-cover bg-center"
          // quoted, because data URIs and paths like "C:\My (photos)" can contain ")"
          style={{ backgroundImage: `url("${custom}")` }}
        />
      )}
      {dim > 0 && (
        <div className="absolute inset-0 bg-black" style={{ opacity: dim / 100 }} />
      )}
      {sakura && <SakuraFx />}
      {cyber && <CyberpunkFx />}
    </div>
  );
}
