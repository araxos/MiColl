import patreonIcon from "@/assets/patreon.png";
import fanslyIcon from "@/assets/fansly.png";
import kofiIcon from "@/assets/kofi.png";
import onlyfansIcon from "@/assets/onlyfans.png";

export interface PlatformIcon {
  /** Platform name in lowercase, letters and numbers only. */
  key: string;
  src: string;
  label: string;
  /** Size classes. Heavier logos (Patreon's P) are a bit smaller so the row looks even. */
  size: string;
}

/** Platform name -> badge icon. */
export const PLATFORM_ICONS: PlatformIcon[] = [
  { key: "patreon", src: patreonIcon, label: "Patreon", size: "h-4 w-4" },
  { key: "fansly", src: fanslyIcon, label: "Fansly", size: "h-5 w-5" },
  { key: "onlyfans", src: onlyfansIcon, label: "OnlyFans", size: "h-5 w-5" },
  { key: "kofi", src: kofiIcon, label: "Ko-Fi", size: "h-5 w-5" },
];

/** How names get compared: "Ko-Fi" and "kofi" are the same platform. */
export function normalizePlatform(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}
