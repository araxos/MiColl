/**
 * What a pasted creator link tells us: the platform and the creator's name on it
 * ("https://www.patreon.com/cw/NoraVale" -> Patreon, "NoraVale"). Used by Create card.
 */

import { hostOf } from "@/lib/linkIcons";

/** Site -> platform name (as in lib/platforms) and where the name sits in the address. */
const SITES: { site: string; platform: string; from: "path" | "subdomain" | "none" }[] = [
  { site: "patreon.com", platform: "Patreon", from: "path" },
  { site: "onlyfans.com", platform: "OnlyFans", from: "path" },
  { site: "fansly.com", platform: "Fansly", from: "path" },
  { site: "ko-fi.com", platform: "Ko-Fi", from: "path" },
  { site: "gumroad.com", platform: "Gumroad", from: "subdomain" },
  { site: "fanbox.cc", platform: "Fanbox", from: "subdomain" },
  { site: "subscribestar.com", platform: "SubscribeStar", from: "path" },
  { site: "subscribestar.adult", platform: "SubscribeStar", from: "path" },
  { site: "boosty.to", platform: "Boosty", from: "path" },
  // fanclub numbers, no name in the address
  { site: "fantia.jp", platform: "Fantia", from: "none" },
  { site: "instagram.com", platform: "Instagram", from: "path" },
  { site: "x.com", platform: "Twitter", from: "path" },
  { site: "twitter.com", platform: "Twitter", from: "path" },
  { site: "weibo.com", platform: "Weibo", from: "path" },
];

/** Path words that come before the name or are pages, not names. */
const PREFIXES = new Set(["c", "cw", "@"]);
const NOT_NAMES = new Set([
  "home", "login", "signup", "search", "explore", "user", "u", "posts", "join", "s",
  "p", "i", "intent", "share", "messages", "settings", "notifications", "discover",
]);

const onSite = (host: string, site: string) => host === site || host.endsWith(`.${site}`);

const clean = (s: string) => {
  try {
    s = decodeURIComponent(s);
  } catch {
    /* keep it as it is */
  }
  return s.replace(/^@/, "").trim();
};

/** The platform and name in a link, null if it isn't one of the platforms. */
export function parseCreatorLink(url: string): { platform: string; name: string | null } | null {
  const host = hostOf(url.trim()).toLowerCase();
  const site = SITES.find((s) => onSite(host, s.site));
  if (!site) return null;
  let name: string | null = null;
  if (site.from === "subdomain") {
    const sub = host.slice(0, -site.site.length - 1).replace(/^www$/, "");
    if (sub && !sub.includes(".")) name = sub;
  }
  if (!name && site.from !== "none") {
    let path = "";
    try {
      const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(url.trim()) ? url.trim() : `https://${url.trim()}`;
      path = new URL(withScheme).pathname;
    } catch {
      path = "";
    }
    const parts = path.split("/").filter(Boolean);
    const first = parts[0] && PREFIXES.has(parts[0].toLowerCase()) ? parts[1] : parts[0];
    const word = first ? clean(first) : "";
    if (word && !NOT_NAMES.has(word.toLowerCase()) && !/^\d+$/.test(word)) name = word;
  }
  return { platform: site.platform, name };
}

/** The link as it gets saved: with https:// in front. */
export function withScheme(url: string): string {
  const u = url.trim();
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(u) ? u : `https://${u}`;
}
