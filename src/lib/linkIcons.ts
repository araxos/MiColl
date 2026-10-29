import patreonIcon from "@/assets/patreon.png";
import fanslyIcon from "@/assets/fansly.png";
import onlyfansIcon from "@/assets/onlyfans.png";
import * as api from "@/api/library";
import { isTauri } from "@/lib/tauri";
import { BRAND_ICONS, type BrandKey } from "@/lib/brandIcons";

/** The icon a creator link shows: one of ours, or the site's own (fetched once). */
export type LinkIcon =
  | { kind: "img"; src: string }
  | { kind: "brand"; path: string; color: string };

/**
 * Sites the platform badges already have a logo for. Not Ko-fi: its dark cup would vanish
 * on the chips, it gets its brand mark below.
 */
const PLATFORM_SITES: [string, string][] = [
  ["patreon.com", patreonIcon],
  ["fansly.com", fanslyIcon],
  ["onlyfans.com", onlyfansIcon],
];

/** Domain (and its subdomains) -> brand mark. */
const BRAND_SITES: [string, BrandKey][] = [
  ["ko-fi.com", "kofi"],
  ["x.com", "x"],
  ["twitter.com", "x"],
  ["instagram.com", "instagram"],
  ["youtube.com", "youtube"],
  ["youtu.be", "youtube"],
  ["twitch.tv", "twitch"],
  ["bsky.app", "bluesky"],
  ["bsky.social", "bluesky"],
  ["discord.gg", "discord"],
  ["discord.com", "discord"],
  ["pixiv.net", "pixiv"],
  // FANBOX is pixiv's
  ["fanbox.cc", "pixiv"],
  ["gumroad.com", "gumroad"],
  ["deviantart.com", "deviantart"],
  ["artstation.com", "artstation"],
  ["tiktok.com", "tiktok"],
  ["reddit.com", "reddit"],
  ["linktr.ee", "linktree"],
  ["tumblr.com", "tumblr"],
  ["threads.net", "threads"],
  ["threads.com", "threads"],
  ["mastodon.social", "mastodon"],
  ["facebook.com", "facebook"],
  ["fb.com", "facebook"],
  ["itch.io", "itchio"],
  ["bilibili.com", "bilibili"],
  ["b23.tv", "bilibili"],
  ["kick.com", "kick"],
  ["buymeacoffee.com", "buymeacoffee"],
  ["carrd.co", "carrd"],
  ["t.me", "telegram"],
  ["telegram.me", "telegram"],
  ["boosty.to", "boosty"],
  ["vk.com", "vk"],
  ["newgrounds.com", "newgrounds"],
  ["github.com", "github"],
  ["pinterest.com", "pinterest"],
  ["substack.com", "substack"],
  ["bandcamp.com", "bandcamp"],
  ["vimeo.com", "vimeo"],
  ["soundcloud.com", "soundcloud"],
  ["spotify.com", "spotify"],
  ["nicovideo.jp", "niconico"],
  ["snapchat.com", "snapchat"],
];

const onSite = (host: string, site: string) => host === site || host.endsWith(`.${site}`);

/** Black marks (X, TikTok, Threads …) would vanish on the dark chips: those go light. */
function brandColor(hex: string): string {
  // the brightest channel: YouTube's red stays red, near-black and slate go light
  const n = parseInt(hex.slice(1), 16);
  return Math.max(n >> 16, (n >> 8) & 255, n & 255) < 100 ? "#f4f4f5" : hex;
}

/** The logo MiColl ships for this site, or null. No request. */
export function knownLinkIcon(host: string): LinkIcon | null {
  const h = host.toLowerCase();
  const png = PLATFORM_SITES.find(([site]) => onSite(h, site));
  if (png) return { kind: "img", src: png[1] };
  const brand = BRAND_SITES.find(([site]) => onSite(h, site));
  if (!brand) return null;
  const icon = BRAND_ICONS[brand[1]];
  return { kind: "brand", path: icon.path, color: brandColor(icon.hex) };
}

// one request per site and session, however many chips show it
const fetched = new Map<string, Promise<string | null>>();

/**
 * The site's own icon (a data: URL), for sites MiColl has no logo for. Fetched once from
 * the site itself by the backend and kept in the library, so it also shows offline.
 */
export function siteIcon(host: string): Promise<string | null> {
  if (!isTauri() || !host) return Promise.resolve(null);
  const h = host.toLowerCase();
  let p = fetched.get(h);
  if (!p) {
    p = api.siteIcon(h).catch(() => null);
    fetched.set(h, p);
  }
  return p;
}
