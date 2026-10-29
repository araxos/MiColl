import { useEffect, useState } from "react";
import type { ArtistLink } from "@/types";
import * as api from "@/api/library";
import { cn } from "@/lib/utils";
import { useTf } from "@/lib/i18n";
import { knownLinkIcon, siteIcon, type LinkIcon } from "@/lib/linkIcons";

/**
 * Hostname of a link without www (also works without https://). Empty if it's not a URL.
 */
function hostOf(url: string): string {
  try {
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `https://${url}`;
    return new URL(withScheme).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/**
 * The link's icon: our own logo for known platforms, else the site's own icon (fetched
 * once by the backend, never through a third party). null while it loads or if none.
 */
function useLinkIcon(host: string): LinkIcon | null {
  const known = host ? knownLinkIcon(host) : null;
  const isKnown = !!known;
  const [fetched, setFetched] = useState<{ host: string; src: string | null } | null>(null);
  useEffect(() => {
    if (!host || isKnown) return;
    let alive = true;
    void siteIcon(host).then((src) => alive && setFetched({ host, src }));
    return () => {
      alive = false;
    };
  }, [host, isKnown]);
  if (known) return known;
  return fetched?.host === host && fetched.src ? { kind: "img", src: fetched.src } : null;
}

/**
 * One link as a logo button. Name shows on hover, colored border
 * (cyan on cyberpunk, blue elsewhere). First letter if there's no icon.
 */
function LinkChip({ link, cyber }: { link: ArtistLink; cyber: boolean }) {
  const tf = useTf();
  const [broken, setBroken] = useState(false);
  const url = link.url.trim();
  const host = hostOf(url);
  const text = link.label.trim() || host || url;
  const letter = text.charAt(0).toUpperCase() || "?";
  const icon = useLinkIcon(host);
  return (
    <button
      type="button"
      onClick={() => url && void api.openUrl(url)}
      aria-label={tf("Open link: {text}", { text })}
      className={cn(
        "group/link inline-flex h-7 items-center rounded-md border px-1 transition-colors",
        cyber
          ? "border-[#00e5ff]/70 bg-[#00e5ff]/10 hover:border-[#00e5ff] hover:bg-[#00e5ff]/20"
          : "border-blue-400/70 bg-blue-400/10 hover:border-blue-400 hover:bg-blue-400/20",
      )}
    >
      <span className="grid h-5 w-5 shrink-0 place-items-center">
        {icon?.kind === "brand" ? (
          <svg viewBox="0 0 24 24" aria-hidden className="h-3.5 w-3.5" fill={icon.color}>
            <path d={icon.path} />
          </svg>
        ) : icon && !broken ? (
          <img
            src={icon.src}
            alt=""
            width={16}
            height={16}
            className="h-4 w-4 rounded-sm object-contain"
            onError={() => setBroken(true)}
          />
        ) : (
          <span className={cn("text-[11px] font-bold", cyber ? "text-[#00e5ff]" : "text-blue-200")}>
            {letter}
          </span>
        )}
      </span>
      {/* site name slides out on hover */}
      <span
        className={cn(
          "max-w-0 truncate whitespace-nowrap text-xs font-medium opacity-0 transition-all duration-200 group-hover/link:ml-1 group-hover/link:max-w-[10rem] group-hover/link:opacity-100",
          cyber ? "text-[#00e5ff]" : "text-blue-100",
        )}
      >
        {text}
      </span>
    </button>
  );
}

/** The creator's social links as logo chips next to the tags. Nothing if there are none. */
export function ArtistLinks({ links, accent }: { links?: ArtistLink[]; accent: string }) {
  const valid = (links ?? []).filter((l) => l.url.trim());
  if (valid.length === 0) return null;
  const cyber = accent === "cyberpunk";
  return (
    <span className="ml-2 inline-flex items-center gap-1.5">
      {valid.map((l, i) => (
        <LinkChip key={i} link={l} cyber={cyber} />
      ))}
    </span>
  );
}
