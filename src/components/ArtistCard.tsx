import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { motion } from "framer-motion";
import { useNavigate } from "react-router-dom";
import {
  Images,
  FolderOpen,
  Trash2,
  Plus,
  BadgeCheck,
  ClipboardList,
  CopyCheck,
  RefreshCw,
  Info,
  Pin,
  PinOff,
  EyeOff,
  Eye,
  UserCog,
  Award,
  Ban,
  Pencil,
  HardDrive,
  DatabaseBackup,
} from "lucide-react";
import { cn, softScale } from "@/lib/utils";
import { useT, useTf } from "@/lib/i18n";
import { Cover } from "@/components/Cover";
import { TagParticles } from "@/components/TagParticles";
import { IriHoloCard } from "@/components/IriHoloCard";
import { IriTemplateHolo } from "@/components/IriTemplateHolo";
import { CyberHoloCard } from "@/components/CyberHoloCard";
import { CyberCardFrame, CyberCardScreen, CARD_CLIP } from "@/components/CyberCardFrame";
import { SakuraCardFrame, SakuraCardScreen, SAKURA_CARD_CLIP } from "@/components/SakuraCardFrame";
import { IriCardFrame, IriCardScreen } from "@/components/IriCardFrame";
import { CreatorDetails } from "@/components/CreatorDetails";
import { PlatformCheck } from "@/components/ThemeCheck";
import { useCardFx, useCardFxPref } from "@/lib/fx";
import { useCyberFrame } from "@/lib/cyberFrame";
import { useSakuraFrame } from "@/lib/sakuraFrame";
import { useIriFrame } from "@/lib/iriFrame";
import { useTemplateFont } from "@/lib/templateFont";
import { useHideNames } from "@/lib/hideNames";
import { cardNameScale, useCardNameSize } from "@/lib/cardNameSize";
import { useCardMeta } from "@/lib/cardMeta";
import { useShowHidden } from "@/lib/showHidden";
import { GraveyardIcon } from "@/lib/graveyardIcon";
import { useCardPlus } from "@/lib/cardPlus";
import { useAccent } from "@/lib/theme";
import { useActions } from "@/actions";
import { useLibraryActions } from "@/store";
import {
  revealArtist,
  setArtistKind,
  sdMark,
  sdBackupDrop,
} from "@/api/library";
import type { MenuItem } from "@/components/ContextMenu";
import { tagDef, artistTags } from "@/lib/artistTags";
import { useClassIconOpacity } from "@/lib/classIconOpacity";
import { CREATOR_TYPES, creatorTypeDefs } from "@/lib/creatorTypes";
import { openDuplicates } from "@/lib/duplicates";
import { usePins, togglePin } from "@/lib/pins";
import { type Artist, ownRewards, platformStats } from "@/types";
import { PLATFORM_ICONS, normalizePlatform } from "@/lib/platformIcons";

/** Min font size for a card name (below that it's not readable). */
const NAME_MIN_PX = 9.5;
/** How much the letter spacing may shrink (fraction of the font size). */
const NAME_MIN_TRACK = -0.06;
/**
 * Name and "?" grow and shrink with the card, softer than the card (softScale).
 * The base sizes were made for the default 180px card, its caption row is ~152px.
 */
const CARD_REF_PX = 180;
const NAME_ROW_REF_PX = 152;

/** How long to hover a shortened name before the tooltip shows (long on purpose). */
const NAME_TIP_DELAY_MS = 3000;
/** Shorter delay when only the first word is shown. */
const NAME_TIP_SHORT_MS = 500;

/**
 * Card name on ONE line.
 * Too long: first drop later words ("Nora Vale Art" -> "Nora"), then shrink the font,
 * then tighten the spacing, truncate as last resort. Never two lines.
 * The width comes from the caption row minus the badges (measuring the heading
 * itself would feed back into the font size).
 * If the name isn't shown fully, hovering it shows the full name.
 */
function FitName({ name, base, className }: { name: string; base: number; className: string }) {
  const ref = useRef<HTMLHeadingElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const [cut, setCut] = useState(false);
  /** True if only the first word is shown. */
  const [short, setShort] = useState(false);
  const first = name.trim().split(/\s+/)[0] ?? name;
  const canShorten = first.length > 0 && first !== name.trim();
  /** Name position on screen and where the bubble ended up. */
  const [tip, setTip] = useState<{
    left: number;
    top: number;
    bottom: number;
    below: boolean;
  } | null>(null);
  const timer = useRef<number | undefined>(undefined);

  useLayoutEffect(() => {
    const el = ref.current;
    const row = el?.parentElement;
    if (!el || !row) return;

    // written straight to the node (a React round trip would flash the reset).
    // only "was it squeezed" goes to state, because it decides the tooltip.
    const measure = () => {
      // the base size follows the card size (softly), then the fitting below
      const start = base * softScale(row.clientWidth, NAME_ROW_REF_PX);
      el.style.fontSize = `${start}px`;
      el.style.letterSpacing = "normal";
      el.textContent = name;
      const full = el.scrollWidth;

      const gap = parseFloat(getComputedStyle(row).columnGap) || 0;
      let avail = row.clientWidth;
      for (const sib of row.children) {
        if (sib !== el) avail -= sib.getBoundingClientRect().width + gap;
      }
      if (avail <= 0 || full <= 0) return; // not laid out yet — no verdict to give

      // drop later words first, mirrored into state below
      const only = canShorten && full > avail;
      if (only) el.textContent = first;
      const text = only ? first : name;
      const natural = only ? el.scrollWidth : full;

      let size = start;
      let track = 0;
      if (natural > avail) {
        size = Math.max(NAME_MIN_PX, (start * avail) / natural);
        // text width scales with the font size
        const over = (natural * size) / start - avail;
        if (over > 0) {
          track = Math.max(-over / Math.max(1, text.length - 1), NAME_MIN_TRACK * size);
        }
      }

      el.style.fontSize = `${size}px`;
      el.style.letterSpacing = track ? `${track}px` : "normal";
      setShort(only);
      setCut(only || natural > avail);
    };

    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(row);
    // wait for the display font before measuring
    void document.fonts?.ready.then(measure).catch(() => {});
    return () => ro.disconnect();
  }, [name, base]);

  const hide = () => {
    window.clearTimeout(timer.current);
    setTip(null);
  };
  useEffect(() => hide, []);

  // hide the tooltip on scroll (it's fixed to the viewport)
  useEffect(() => {
    if (!tip) return;
    window.addEventListener("scroll", hide, true);
    return () => window.removeEventListener("scroll", hide, true);
  }, [tip]);

  // push the bubble back inside the window if needed
  useLayoutEffect(() => {
    const el = tipRef.current;
    if (!tip || !el) return;
    const r = el.getBoundingClientRect();
    const pad = 8;
    const half = r.width / 2;
    const lo = pad + half;
    const hi = window.innerWidth - pad - half;
    const left = hi >= lo ? Math.min(Math.max(tip.left, lo), hi) : window.innerWidth / 2;
    const below = tip.top - pad - r.height < pad; // no room above ⇒ hang it underneath
    if (Math.abs(left - tip.left) > 0.5 || below !== tip.below) setTip({ ...tip, left, below });
  }, [tip]);

  return (
    <>
      <h3
        // re-enable pointer events here, no stopPropagation so the card still opens
        className={cn(className, cut && "pointer-events-auto")}
        ref={ref}
        onMouseEnter={() => {
          if (!cut) return;
          timer.current = window.setTimeout(() => {
            const r = ref.current?.getBoundingClientRect();
            if (r) setTip({ left: r.left + r.width / 2, top: r.top, bottom: r.bottom, below: false });
          }, short ? NAME_TIP_SHORT_MS : NAME_TIP_DELAY_MS);
        }}
        onMouseLeave={hide}
      >
        {short ? first : name}
      </h3>
      {tip &&
        createPortal(
          <div
            ref={tipRef}
            style={{ left: tip.left, top: tip.below ? tip.bottom + 8 : tip.top - 8 }}
            className={cn(
              "pointer-events-none fixed z-[120] max-w-[18rem] -translate-x-1/2 rounded-md bg-black/90 px-2 py-1 text-[11px] font-medium text-white shadow-lg ring-1 ring-white/15",
              !tip.below && "-translate-y-full",
            )}
          >
            {name}
          </div>,
          document.body,
        )}
    </>
  );
}

/** Small "verified" check on a platform badge corner, in the theme's style. */
/** FNV-1a string hash -> stable seed for the per-artist holo. */
function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * Small seeded random generator (mulberry32) so each artist's holo is random but stable.
 */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Random holo settings per artist (hue, angle, scanlines, timing).
 * premium = stronger for template artists, soft = pastel pearl (iridescent).
 */
function holoVars(seed: string, premium: boolean, soft: boolean): React.CSSProperties {
  const r = rng(hashStr(seed));
  const rand = (min: number, max: number) => min + r() * (max - min);
  const baseAlpha = soft ? (premium ? 0.28 : 0.2) : premium ? 0.22 : 0.15;
  const sat = soft ? 85 : 100;
  const light = soft ? 82 : 62;
  const h1 = Math.floor(rand(0, 360));
  const h2 = Math.floor(h1 + rand(40, 120)) % 360;
  const h3 = Math.floor(h1 + rand(150, 260)) % 360;
  return {
    "--holo-angle": `${Math.floor(rand(96, 140))}deg`,
    "--holo-c1": `hsla(${h1}, ${sat}%, ${light}%, ${baseAlpha.toFixed(2)})`,
    "--holo-c2": `hsla(${h2}, ${sat}%, ${light - 2}%, ${(baseAlpha - 0.04).toFixed(2)})`,
    "--holo-c3": `hsla(${h3}, ${sat}%, ${light}%, ${(baseAlpha - 0.02).toFixed(2)})`,
    "--holo-scan": `hsla(${h1}, ${soft ? 70 : 90}%, ${soft ? 88 : 72}%, ${premium ? "0.06" : "0.05"})`,
    "--holo-scan-gap": `${Math.floor(rand(4, 7))}px`,
    // iridescent comes in bursts (5s shower + 15-30s pause), delay desyncs the cards
    "--holo-dur": soft
      ? `${rand(20, 35).toFixed(2)}s`
      : `${rand(premium ? 4.5 : 5.5, premium ? 7.5 : 9).toFixed(2)}s`,
    "--holo-delay": soft
      ? `${(-rand(0, 35)).toFixed(2)}s`
      : `${(-rand(0, 7)).toFixed(2)}s`,
    "--holo-prism": `${rand(6, 11).toFixed(2)}s`,
  } as React.CSSProperties;
}

/** Simple pushpin, colored with Tailwind fill-* classes. glow = neon halo (cyberpunk). */
function Pushpin({
  head,
  skirt,
  glow,
}: {
  head: string;
  skirt: string;
  glow?: string;
}) {
  return (
    <svg
      viewBox="0 0 24 34"
      className={`h-9 w-9 rotate-[24deg] ${glow ?? "drop-shadow-[0_2px_3px_rgba(0,0,0,0.4)]"}`}
    >
      {/* needle */}
      <path d="M11.3 17.5 L12 32 L12.7 17.5 Z" className="fill-zinc-400" />
      {/* where the needle leaves the head */}
      <ellipse cx="12" cy="17.5" rx="5" ry="2" className={skirt} />
      {/* round head */}
      <circle cx="12" cy="10" r="8" className={head} />
      {/* shine */}
      <ellipse
        cx="8.6"
        cy="7"
        rx="2.6"
        ry="1.5"
        className="fill-white/45"
        transform="rotate(-32 8.6 7)"
      />
    </svg>
  );
}

/**
 * Cyberpunk pin: octagon head + sharp needle, no curves.
 * fill colors it all (for the ghosts), faceted adds seams + circuit lines.
 */
function CyberPin({ fill, faceted, glow }: { fill: string; faceted?: boolean; glow?: string }) {
  return (
    <svg viewBox="0 0 24 34" className={`h-9 w-9 rotate-[24deg] ${glow ?? ""}`}>
      {/* needle + octagon head */}
      <path d="M10 17 L12 32 L14 17 Z" className={fill} />
      <path d="M7 2 L17 2 L20 5 L20 14 L17 17 L7 17 L4 14 L4 5 Z" className={fill} />
      {faceted && (
        <>
          {/* bevel facets */}
          <path d="M7 2 L4 5 L4 14 L7 17 Z" className="fill-black/30" />
          <path d="M17 2 L20 5 L20 14 L17 17 Z" className="fill-white/20" />
          {/* circuit lines */}
          <path
            d="M9 6 L15 6 M8 10 L16 10 M12 17 L12 31"
            stroke="#0b0b0b"
            strokeWidth="0.9"
            strokeOpacity="0.55"
          />
        </>
      )}
    </svg>
  );
}

/** A flicker animation + opacity for an inline style. */
const flicker = (anim: string, o: number): React.CSSProperties =>
  ({ animation: anim, "--fx-o": o }) as React.CSSProperties;

/**
 * The "pinned" marker on the card corner. Pushpin for basic accents,
 * blossom for sakura, glitching neon pin for cyberpunk, crystal for iridescent.
 */
function CardPin({ accent }: { accent: string }) {
  if (accent === "sakura") {
    // cherry blossom
    return (
      <svg
        viewBox="0 0 32 32"
        className="h-8 w-8 rotate-[8deg] drop-shadow-[0_2px_3px_rgba(0,0,0,0.4)]"
      >
        {[0, 72, 144, 216, 288].map((a) => (
          <g key={a} transform={`rotate(${a} 16 16)`}>
            <ellipse cx="16" cy="8" rx="4.4" ry="6.6" className="fill-[#f9a8d4]" />
            <ellipse cx="16" cy="9" rx="2.2" ry="3.6" className="fill-[#fbcfe8]" />
          </g>
        ))}
        <circle cx="16" cy="16" r="3" className="fill-[#fde68a]" />
      </svg>
    );
  }
  if (accent === "iridescent") {
    // thin sharp crystal leaning to the right
    return (
      <svg
        viewBox="0 0 32 32"
        className="h-8 w-8 rotate-[24deg] drop-shadow-[0_1px_3px_rgba(0,0,0,0.55)]"
        style={{ animation: "micoll-iri-mark 6s ease-in-out infinite" }}
      >
        <defs>
          <linearGradient id="micoll-pin-irid" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#c4b5fd" />
            <stop offset="35%" stopColor="#f5c2ff" />
            <stop offset="65%" stopColor="#a7f3d0" />
            <stop offset="100%" stopColor="#bae6fd" />
          </linearGradient>
        </defs>
        <path d="M16 1.5 L21.4 11 L16 30.5 L10.6 11 Z" fill="url(#micoll-pin-irid)" />
        <path
          d="M10.6 11 H21.4 M16 1.5 L13.5 11 L16 30.5 M16 1.5 L18.5 11 L16 30.5"
          fill="none"
          stroke="white"
          strokeWidth="0.6"
          strokeOpacity="0.6"
        />
        {/* one shine line on the left facet */}
        <path d="M16 3.4 L14.6 10.8 L16 25" fill="none" stroke="white" strokeWidth="0.9" strokeOpacity="0.75" />
      </svg>
    );
  }
  if (accent === "cyberpunk") {
    // RGB split: cyan ghost top right, magenta ghost bottom left, yellow pin jittering on
    // top
    return (
      <div className="relative h-9 w-9">
        {/* magenta - bottom left */}
        <div
          className="absolute inset-0 mix-blend-screen"
          style={{ transform: "translate(-2px,2px)", ...flicker("micoll-flicker 2.3s steps(2) 0.3s infinite", 0.75) }}
        >
          <CyberPin fill="fill-[#ff2bd6]" />
        </div>
        {/* cyan - top right */}
        <div
          className="absolute inset-0 mix-blend-screen"
          style={{ transform: "translate(2px,-2px)", ...flicker("micoll-flicker 1.7s steps(2) infinite", 0.75) }}
        >
          <CyberPin fill="fill-[#00e5ff]" />
        </div>
        {/* yellow pin */}
        <div className="absolute inset-0" style={{ animation: "micoll-icon-glitch 3.4s infinite" }}>
          <CyberPin fill="fill-[#fcee0a]" faceted glow="drop-shadow-[0_0_5px_rgba(252,238,10,0.85)]" />
        </div>
        {/* glitch slivers top right */}
        <span
          className="absolute right-0 top-1 h-[2px] w-3.5 bg-[#00e5ff]"
          style={flicker("micoll-flicker 1.4s steps(2) infinite", 0.9)}
        />
        <span
          className="absolute right-1 top-2 h-[2px] w-2 bg-[#fcee0a]"
          style={flicker("micoll-flicker 2.1s steps(2) 0.5s infinite", 0.7)}
        />
        {/* glitch slivers bottom left */}
        <span
          className="absolute bottom-2 left-0 h-[2px] w-3.5 bg-[#ff2bd6]"
          style={flicker("micoll-flicker 1.9s steps(2) 0.6s infinite", 0.9)}
        />
        <span
          className="absolute bottom-3 left-1 h-[2px] w-2 bg-[#00e5ff]"
          style={flicker("micoll-flicker 2.6s steps(2) 0.2s infinite", 0.7)}
        />
      </div>
    );
  }
  // basic accents: pushpin in the brand color
  return <Pushpin head="fill-brand-500" skirt="fill-brand-700" />;
}

/**
 * Folded corner "set type" ribbon on cards without a creator type.
 * Click opens the type picker. Styled per theme, shows a "?".
 * Gone once a type is set.
 */
function TypeCorner({
  accent,
  onOpen,
}: {
  accent: string;
  onOpen: (e: React.MouseEvent) => void;
}) {
  const t = useT();
  const cyber = accent === "cyberpunk";
  const irid = accent === "iridescent";
  const sakura = accent === "sakura";
  // top right corner fold
  const tri = "polygon(100% 0, 0 0, 100% 100%)";
  // "?" is black on cyberpunk yellow, white elsewhere
  const qClass = cyber ? "text-zinc-950" : "text-white";

  // follows the card size softly (zoom scales the hit area too, not just the look)
  const ref = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  useLayoutEffect(() => {
    const card = ref.current?.parentElement;
    if (!card) return;
    const place = () => setScale(softScale(card.clientWidth, CARD_REF_PX));
    place();
    const ro = new ResizeObserver(place);
    ro.observe(card);
    return () => ro.disconnect();
  }, [irid]);

  // mouse: open at the cursor, keyboard: under the corner
  const open = (e: React.MouseEvent | React.KeyboardEvent) => {
    e.stopPropagation();
    const me = e as React.MouseEvent;
    if (typeof me.clientX === "number" && (me.clientX || me.clientY)) {
      onOpen(me);
      return;
    }
    const r = e.currentTarget.getBoundingClientRect();
    onOpen({
      preventDefault() {},
      stopPropagation() {},
      clientX: r.left + r.width / 2,
      clientY: r.bottom,
    } as React.MouseEvent);
  };

  const buttonProps = {
    ref,
    style: { zoom: scale },
    role: "button",
    tabIndex: 0,
    "aria-label": t("Set creator type"),
    title: t("Set creator type — model, artist, cosplayer…"),
    onClick: open,
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        open(e);
      }
    },
  } as const;

  // iridescent: no fold, a small glass disc with a turning pearl ring (.iri-type-dot)
  if (irid) {
    return (
      <div
        {...buttonProps}
        className="iri-type-dot absolute right-3 top-3 z-20 flex h-7 w-7 cursor-pointer items-center justify-center rounded-full outline-none"
      >
        <span className="iri-type-dot-q pointer-events-none text-[13px] font-bold leading-none">
          ?
        </span>
      </div>
    );
  }

  return (
    <div
      {...buttonProps}
      className="absolute right-0 top-0 z-20 h-12 w-12 cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-white/70"
    >
      {cyber ? (
        <>
          {/* magenta/cyan ghosts + yellow base */}
          <div
            className="absolute inset-0 mix-blend-screen"
            style={{
              clipPath: tri,
              background: "#ff2bd6",
              transform: "translate(-1.5px,1.5px)",
              ...flicker("micoll-flicker 2.3s steps(2) .3s infinite", 0.7),
            }}
          />
          <div
            className="absolute inset-0 mix-blend-screen"
            style={{
              clipPath: tri,
              background: "#00e5ff",
              transform: "translate(1.5px,-1.5px)",
              ...flicker("micoll-flicker 1.7s steps(2) infinite", 0.7),
            }}
          />
          <div
            className="absolute inset-0 shadow-[0_0_8px_rgba(252,238,10,0.6)]"
            style={{ clipPath: tri, background: "#fcee0a", animation: "micoll-icon-glitch 3.4s infinite" }}
          />
        </>
      ) : sakura ? (
        <>
          <div
            className="absolute inset-0"
            style={{ clipPath: tri, background: "linear-gradient(225deg,#fbcfe8 0%,#f9a8d4 45%,#ec4899 100%)" }}
          />
          {/* soft blossom highlight */}
          <div
            className="absolute inset-0"
            style={{ clipPath: tri, background: "radial-gradient(circle at 82% 14%, rgba(255,255,255,0.85), transparent 46%)" }}
          />
        </>
      ) : (
        <div
          className="absolute inset-0 bg-gradient-to-bl from-brand-400 to-brand-600"
          style={{ clipPath: tri }}
        />
      )}
      <span
        className={cn(
          "pointer-events-none absolute right-3 top-2 text-[13px] font-extrabold leading-none drop-shadow-[0_1px_2px_rgba(0,0,0,0.45)]",
          qClass,
        )}
      >
        ?
      </span>
    </div>
  );
}

function ArtistCardBase({
  artist,
  holoTier = 0,
  aspect = "aspect-[4/5]",
  wave = 0,
}: {
  artist: Artist;
  holoTier?: number;
  /**
   * Card shape from the dashboard (the virtual grid needs the same value for row height).
   */
  aspect?: string;
  /**
   * Diagonal distance from the top left (row + column). Used as delay for the cyberpunk
   * glitch wave.
   */
  wave?: number;
}) {
  const t = useT();
  const tf = useTf();
  const navigate = useNavigate();
  const { openMenu, requestDelete, addRewards, rescanArtist, bringBackFromSd, showToast } =
    useActions();
  const showHidden = useShowHidden();
  const [detailsOpen, setDetailsOpen] = useState(false);
  // only the stable store part, otherwise every card re-renders on every change
  const { backed, refresh, setArtistClass, setArtistHidden, setArtistGraveyard } =
    useLibraryActions();

  const pStats = artist.platforms.map(platformStats);
  const owned = pStats.reduce((s, x) => s + x.ownedRewards, 0);
  const total = pStats.reduce((s, x) => s + x.totalRewards, 0);
  // only show owned/total when a template tracks at least one period
  const tracked = pStats.some((x) => x.tracked);

  // one icon per platform this artist has rewards in
  const ownedPlatforms = new Set(
    artist.platforms
      .filter((p) => p.months.some((m) => ownRewards(m).length > 0))
      .map((p) => normalizePlatform(p.name)),
  );
  // MiSD state of this creator's rewards (only for the menu), no borrowed collabs
  const allOwned = artist.platforms
    .flatMap((p) => p.months.flatMap((m) => ownRewards(m)))
    .filter((r) => r.status === "owned");
  const sdOn = allOwned.filter((r) => r.sdVolume);
  const sdQueued = allOwned.filter((r) => !r.sdVolume && r.sdMarked).length;
  const sdBackedUp = allOwned.filter((r) => !r.sdVolume && r.sdBackup);
  const sdBackupQueued = allOwned.filter((r) => !r.sdVolume && r.sdBackupMarked).length;

  const pins = usePins();
  const pinned = pins.has(artist.id);
  const badges = PLATFORM_ICONS.filter((p) => ownedPlatforms.has(p.key));
  // platforms with verified periods get a check on the badge
  const verifiedPlatforms = new Set(
    artist.platforms.filter((p) => p.verified).map((p) => normalizePlatform(p.name)),
  );
  const tag = tagDef(artist.tag);
  const classIconOpacity = useClassIconOpacity();
  // no creator type -> show the "set type" fold
  const noType = creatorTypeDefs(artist.kind).length === 0;
  const showTypeCorner = backed && noType;
  const openTypeMenu = (e: React.MouseEvent) =>
    openMenu(
      e,
      CREATOR_TYPES.map((t) => ({
        label: t.label,
        icon: <t.Icon className={`h-4 w-4 ${t.color}`} />,
        onClick: () => void setArtistKind(artist.id, t.key).then(() => refresh()),
      })),
    );

  // premium hover: tag icons floating along the edges (falling on sakura)
  const cardFx = useCardFx();
  // hover effects use the saved switch only (see useCardFxPref)
  const fxPref = useCardFxPref();
  const hideNames = useHideNames();
  const nameSize = useCardNameSize();
  // platform logos + reward count under the name
  const cardMeta = useCardMeta();
  // the hover "+" button
  const showPlus = useCardPlus();
  const accent = useAccent();
  const [hovered, setHovered] = useState(false);

  // holo per artist (cyberpunk). Template artists get the stronger one.
  const irid = accent === "iridescent";
  const cyber = accent === "cyberpunk";
  const sak = accent === "sakura";
  /** The three paid themes (they have their own hover effect). */
  const premium = irid || cyber || sak;
  const hasTemplate = !!artist.verified || !!artist.personalLog;
  // cyberpunk frame option: clips the card and replaces the holo/foil
  const frameSetting = useCyberFrame();
  const cyberFrame = cyber && frameSetting;
  // sakura frame option: petal shape instead of sak-edge + holo
  const sakFrameSetting = useSakuraFrame();
  const sakFrame = sak && sakFrameSetting;
  // iridescent frame option: drop outline instead of iri-edge + holo
  const iriFrameSetting = useIriFrame();
  const iriFrame = irid && iriFrameSetting;
  // true if the name uses a display font (template font on AND the accent has one)
  const displayFace = useTemplateFont() && hasTemplate && (irid || cyber);
  // any frame replaces the edge, so treat them as one flag where it doesn't matter
  const framed = cyberFrame || sakFrame || iriFrame;
  // square corners on iridescent and on framed cards
  const cardRadius = irid || framed ? "rounded-none" : "rounded-2xl";
  const holoStyle = holoVars(artist.id + artist.name, hasTemplate, irid);

  // MiSD submenu: move and backup are separate queues
  const sdChildren: MenuItem[] = !backed
    ? []
    : [
        ...(allOwned.length > sdOn.length
          ? [
              sdQueued > 0
                ? {
                    label: tf("Unmark move ({n})", { n: sdQueued }),
                    icon: <HardDrive className="h-4 w-4" />,
                    onClick: () =>
                      void sdMark({ artistId: Number(artist.id), marked: false }).then(() =>
                        refresh(),
                      ),
                  }
                : {
                    label: t("Move to disk"),
                    icon: <HardDrive className="h-4 w-4" />,
                    onClick: () =>
                      void sdMark({ artistId: Number(artist.id), marked: true }).then(() =>
                        refresh(),
                      ),
                  },
              sdBackupQueued > 0
                ? {
                    label: tf("Unmark backup ({n})", { n: sdBackupQueued }),
                    icon: <DatabaseBackup className="h-4 w-4" />,
                    onClick: () =>
                      void sdMark({
                        artistId: Number(artist.id),
                        marked: false,
                        mode: "backup",
                      }).then(() => refresh()),
                  }
                : {
                    label: t("Back up to disk"),
                    icon: <DatabaseBackup className="h-4 w-4" />,
                    onClick: () =>
                      void sdMark({
                        artistId: Number(artist.id),
                        marked: true,
                        mode: "backup",
                      }).then(() => refresh()),
                  },
            ]
          : []),
        ...(sdBackedUp.length
          ? [
              {
                label: tf("Remove backup ({n})", { n: sdBackedUp.length }),
                icon: <DatabaseBackup className="h-4 w-4" />,
                danger: true,
                onClick: () =>
                  void sdBackupDrop(sdBackedUp.map((r) => Number(r.id)))
                    .then((s) => {
                      showToast(
                        s.failed
                          ? {
                              tone: "warn",
                              title: tf("MiSD: removed {moved} backups, {failed} failed", {
                                moved: s.moved,
                                failed: s.failed,
                              }),
                              detail: s.errors.slice(0, 3).join(" · "),
                            }
                          : {
                              tone: "success",
                              title: t("MiSD backups removed"),
                              detail: t("The local files were not touched."),
                            },
                      );
                      return refresh();
                    })
                    .catch((err) => showToast({ tone: "error", title: "MiSD", detail: `${err}` })),
              },
            ]
          : []),
        ...(sdOn.length
          ? [
              {
                label: tf("Bring back ({n})", { n: sdOn.length }),
                icon: <HardDrive className="h-4 w-4" />,
                onClick: () => void bringBackFromSd(sdOn.map((r) => Number(r.id))),
              },
            ]
          : []),
      ];

  const onContextMenu = (e: React.MouseEvent) =>
    openMenu(e, [
      // quick buttons at the top: Details, Rename, Reload
      {
        label: t("Details"),
        icon: <Info className="h-4 w-4" />,
        quick: 0,
        onClick: () => setDetailsOpen(true),
      },
      {
        label: t("Show in Explorer"),
        icon: <FolderOpen className="h-4 w-4" />,
        onClick: () => void revealArtist(artist.id),
      },
      {
        label: pinned ? t("Unpin from top") : t("Pin to top"),
        icon: pinned ? <PinOff className="h-4 w-4" /> : <Pin className="h-4 w-4" />,
        onClick: () => togglePin(artist.id),
      },
      // hiding is saved in the library, "Show hidden creators" brings it back
      ...(backed
        ? [
            {
              label: artist.hidden ? t("Show on dashboard") : t("Hide creator"),
              icon: artist.hidden ? (
                <Eye className="h-4 w-4" />
              ) : (
                <EyeOff className="h-4 w-4" />
              ),
              onClick: () => {
                setArtistHidden(artist.id, !artist.hidden);
                if (!artist.hidden && !showHidden) {
                  showToast({
                    tone: "success",
                    title: tf("{name} hidden", { name: artist.name }),
                    detail: t("Right-click the settings gear to see hidden creators."),
                  });
                }
              },
            },
          ]
        : []),
      // pick the artist's class (click the active one or "Remove" to clear it)
      ...(backed
        ? [
            {
              label: t("Class"),
              icon: <Award className="h-4 w-4" />,
              children: [
                ...artistTags().map((tag) => ({
                  label: artist.tag === tag.key ? `${t(tag.label)} ✓` : t(tag.label),
                  icon: <tag.Icon className={`h-4 w-4 ${tag.color}`} fill="currentColor" />,
                  onClick: () =>
                    setArtistClass(artist.id, artist.tag === tag.key ? null : tag.key),
                })),
                ...(artist.tag
                  ? [
                      {
                        label: t("Remove class"),
                        icon: <Ban className="h-4 w-4" />,
                        danger: true,
                        onClick: () => setArtistClass(artist.id, null),
                      },
                    ]
                  : []),
              ],
            },
          ]
        : []),
      // set type, only when none is set yet (otherwise in the Details panel)
      ...(backed && creatorTypeDefs(artist.kind).length === 0
        ? [
            {
              label: t("Set type"),
              icon: <UserCog className="h-4 w-4" />,
              children: CREATOR_TYPES.map((ct) => ({
                label: t(ct.label),
                icon: <ct.Icon className={`h-4 w-4 ${ct.color}`} />,
                onClick: () => void setArtistKind(artist.id, ct.key).then(() => refresh()),
              })),
            },
          ]
        : []),
      {
        label: t("Rename"),
        icon: <Pencil className="h-4 w-4" />,
        quick: 1,
        // opens Details with the name selected (renaming also renames the folder)
        onClick: () => navigate(`/artist/${artist.id}?details=1&rename=1`),
      },
      {
        label: t("Find duplicates"),
        icon: <CopyCheck className="h-4 w-4" />,
        onClick: () => openDuplicates({ label: artist.name, artistId: Number(artist.id) }),
      },
      ...(sdChildren.length
        ? [{ label: "MiSD", icon: <HardDrive className="h-4 w-4" />, children: sdChildren }]
        : []),
      // right above Delete: the soft version, the creator and files stay
      ...(backed
        ? [
            {
              label: artist.graveyard ? t("Bring back from graveyard") : t("Move to graveyard"),
              icon: <GraveyardIcon className="h-4 w-4" />,
              onClick: () =>
                void setArtistGraveyard(artist.id, !artist.graveyard)
                  .then(() =>
                    showToast({
                      tone: "success",
                      title: artist.graveyard
                        ? tf("{name} is back on the dashboard", { name: artist.name })
                        : tf("{name} moved to the graveyard", { name: artist.name }),
                      detail: artist.graveyard
                        ? undefined
                        : t("The graveyard button in the top bar shows it again."),
                    }),
                  )
                  .catch((err) =>
                    showToast({
                      tone: "error",
                      title: t("Couldn’t move the creator’s folder"),
                      detail: `${err}`,
                    }),
                  ),
            },
          ]
        : []),
      {
        // only this creator (see rescanArtist in actions.tsx)
        label: t("Reload"),
        icon: <RefreshCw className="h-4 w-4" />,
        quick: 2,
        onClick: () => rescanArtist(artist.id),
      },
      {
        label: t("Delete creator…"),
        icon: <Trash2 className="h-4 w-4" />,
        danger: true,
        onClick: () => requestDelete({ title: artist.name, artistId: artist.id }),
      },
    ]);

  return (
    <motion.button
      whileHover={{ y: -4 }}
      whileTap={{ scale: 0.98 }}
      transition={{ type: "spring", stiffness: 400, damping: 28 }}
      onClick={() => navigate(`/artist/${artist.id}`)}
      onContextMenu={onContextMenu}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      // drop target: files dropped here go to this artist
      data-drop-artist={artist.name}
      data-drop-nodate={artist.noDates ? "1" : "0"}
      // hidden creators (while shown) are a bit faded
      className={cn(
        "group relative text-left outline-none focus-visible:ring-2 focus-visible:ring-brand-500",
        cardRadius,
        artist.hidden && "opacity-55 saturate-50 transition hover:opacity-100 hover:saturate-100",
      )}
      title={artist.hidden ? `${artist.name} — hidden from the dashboard` : undefined}
    >
      {/* clipped card body. The pin is outside the clip so it can hang over the corner. */}
      <div
        className={`relative overflow-hidden shadow-lg shadow-black/20 ${cardRadius} ${
          cyberFrame
            ? "bg-[#0b0b12]"
            : sakFrame
              ? "bg-[#1b1016]"
              : iriFrame
                ? // No `iri-edge` here: that draws its own gradient border, and a
                  // border on a clipped body gets sliced by the drop outline. The
                  // rim over the top is the edge now.
                  "bg-[#0c0a14]"
                : irid
                  ? "iri-edge"
                  : sak
                    ? "sak-edge"
                    : "border border-zinc-800 bg-zinc-900"
        }`}
        // clip to the frame outline so the cover ends at the border.
        // Not on iridescent: its cut corners are filled by the frame, a clip would remove
        // them.
        style={
          cyberFrame
            ? { clipPath: CARD_CLIP }
            : sakFrame
              ? { clipPath: SAKURA_CARD_CLIP }
              : undefined
        }
      >
      <div className={cn("w-full overflow-hidden", aspect)}>
        <div className="h-full w-full transition-transform duration-500 group-hover:scale-105">
          <Cover
            path={artist.previewPath}
            alts={artist.previewAlts}
            seed={artist.name}
            label={artist.name}
            rounded="rounded-none"
          />
        </div>
      </div>

      {/* holo overlay. Iridescent: template cards get IriTemplateHolo, others IriHoloCard.
          Cyberpunk: template cards get CyberHoloCard, others the CSS sheen. Other accents:
          CSS sheen. */}
      {/* framed cards have their own effects instead of the holo */}
      {cyberFrame && cardFx && (
        <CyberCardScreen tone={hasTemplate ? "yellow" : "cyan"} wave={wave} />
      )}
      {/* every framed card, each one has its own timer (see SakuraCardScreen) */}
      {sakFrame && cardFx && <SakuraCardScreen tone={hasTemplate ? "bloom" : "petal"} />}
      {iriFrame && cardFx && <IriCardScreen tone={hasTemplate ? "prism" : "pearl"} />}

      {cardFx &&
        !framed &&
        (irid ? (
          hasTemplate ? (
            <IriTemplateHolo />
          ) : (
            <IriHoloCard hovered={hovered} tier={holoTier} />
          )
        ) : cyber && hasTemplate ? (
          <CyberHoloCard />
        ) : (
          <div
            aria-hidden
            style={holoStyle}
            className={`micoll-holo pointer-events-none absolute inset-0 z-10 rounded-2xl${
              hasTemplate ? " micoll-holo--premium" : ""
            }`}
          />
        ))}

      {/* the frame: yellow = template creator, cyan = the rest */}
      {cyberFrame && <CyberCardFrame tone={hasTemplate ? "yellow" : "cyan"} wave={wave} />}
      {/* sakura: deep rose = template, pale pink = the rest */}
      {sakFrame && <SakuraCardFrame tone={hasTemplate ? "bloom" : "petal"} />}
      {/* iridescent: full spectrum = template, paler = the rest */}
      {iriFrame && <IriCardFrame tone={hasTemplate ? "prism" : "pearl"} />}

      {cardFx && tag && hovered && (
        <TagParticles
          Icon={tag.Icon}
          colorClass={tag.color}
          // the iridescent streak is only for the Star class
          direction={
            accent === "sakura"
              ? "fall"
              : accent === "cyberpunk"
                ? "glitch"
                : accent === "iridescent" && tag.key === "star"
                  ? "shoot"
                  : "rise"
          }
        />
      )}

      {/* class icon top left. Its visibility is a setting (0% = not rendered).
          On premium accents it fades out on hover (the hover effect replaces it).
          Uses the saved switch (fxPref), not the idle pause. */}
      {tag && classIconOpacity > 0 && (
        // own layer as query container (container-type on the card root would break fixed
        // children)
        <div className="pointer-events-none absolute inset-0 z-10 [container-type:size]">
          <div
            className="absolute left-2 top-2 transition-opacity duration-200 ease-out"
            style={{ opacity: premium && fxPref && hovered ? 0 : classIconOpacity / 100 }}
          >
            <tag.Icon
              aria-label={tag.label}
              className={`${tag.color} drop-shadow-[0_1px_3px_rgba(0,0,0,0.8)]`}
              fill="currentColor"
              // 24px on the default 180px card, scales with the card. 8px inset stays
              // fixed.
              style={{ width: "13.33cqw", height: "13.33cqw" }}
            />
          </div>
        </div>
      )}

      {/* "+" add rewards on hover (top right). Opens a folder picker, archives can be
          dropped.
          Can be turned off in Settings. */}
      {showPlus && (
      <span
        role="button"
        tabIndex={0}
        title={`Add a folder to ${artist.name} (drag a .zip/.rar/.7z onto the card for archives)`}
        onClick={(e) => {
          e.stopPropagation();
          void addRewards({ artist: artist.name, noDates: artist.noDates });
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            e.stopPropagation();
            void addRewards({ artist: artist.name, noDates: artist.noDates });
          }
        }}
        className={cn(
          "absolute top-2 z-10 flex h-8 w-8 items-center justify-center rounded-full bg-transparent text-white opacity-0 transition-all hover:bg-white/5 focus-visible:opacity-100 group-hover:opacity-100",
          // move left of the "set type" fold
          showTypeCorner ? "right-12" : "right-2",
        )}
      >
        <Plus className="h-5 w-5 drop-shadow-[0_1px_3px_rgba(0,0,0,0.9)]" />
      </span>
      )}

      {/* "set type" fold, only without a type */}
      {showTypeCorner && <TypeCorner accent={accent} onOpen={openTypeMenu} />}

      {/* caption: the name, on hover it moves up and the platforms + count appear */}
      <div
        className={cn(
          "pointer-events-none absolute inset-x-0 -bottom-0 bg-gradient-to-t to-transparent px-3.5",
          // one or two lines, a lighter shadow when the platform row is off
          cardMeta
            ? "from-black/85 via-black/40 pb-2 pt-7"
            : "from-black/65 via-black/25 pb-2.5 pt-5",
          // iridescent frame, single line: lift the name off the frame's bottom edge
          // (template creators only, the others keep it low)
          iriFrame && !cardMeta && hasTemplate && "pb-4",
          // with hidden names fade the whole shadow with the text
          hideNames &&
            "opacity-0 transition-opacity duration-300 ease-out group-hover:opacity-100 group-focus-visible:opacity-100",
        )}
      >
        <div
          className={cn(
            "flex min-w-0 items-center gap-1.5",
            // framed cards center the name
            framed && "justify-center",
            hideNames &&
              "translate-y-1 opacity-0 transition-all duration-300 ease-out group-hover:translate-y-0 group-hover:opacity-100 group-focus-visible:translate-y-0 group-focus-visible:opacity-100",
          )}
        >
          <FitName
            name={artist.name}
            className={cn(
              "min-w-0 truncate font-semibold leading-tight text-white",
              // template cards use the display font on the name only
              hasTemplate && "cc-template-type",
              // framed cards color the name like the border (yellow/cyan)
              cyberFrame &&
                (hasTemplate
                  ? "text-[#FCEE0A] [text-shadow:0_2px_12px_rgba(7,7,10,0.95)]"
                  : "text-[#00F0FF] [text-shadow:0_2px_12px_rgba(7,7,10,0.95)]"),
              // same on sakura
              sakFrame &&
                (hasTemplate
                  ? "text-[#ffd0e3] [text-shadow:0_2px_12px_rgba(24,10,18,0.95)]"
                  : "text-[#ffe6f2] [text-shadow:0_2px_12px_rgba(24,10,18,0.95)]"),
              // and on iridescent
              iriFrame &&
                (hasTemplate
                  ? "text-[#e6dcff] [text-shadow:0_2px_12px_rgba(10,10,20,0.95)]"
                  : "text-[#f2f0ff] [text-shadow:0_2px_12px_rgba(10,10,20,0.95)]"),
            )}
            // name size: smaller for KDA, bigger for the cyberpunk font, else 15px (keys
            // off displayFace)
            // times the size step from Settings (4 = these sizes)
            base={
              (displayFace && irid ? 10.5 : displayFace && cyber ? 13 : irid ? 13 : 15) *
              cardNameScale(nameSize)
            }
          />
          {artist.verified ? (
            // hide the verified check when the display font already shows it's a template
            displayFace ? null : (
              <BadgeCheck
                aria-label={t("Verified template")}
                className="h-4 w-4 shrink-0 text-brand-300 drop-shadow-[0_1px_2px_rgba(0,0,0,0.9)]"
              />
            )
          ) : artist.personalLog ? (
            <ClipboardList
              aria-label={t("Personal collection log")}
              className="h-4 w-4 shrink-0 text-zinc-300 drop-shadow-[0_1px_2px_rgba(0,0,0,0.9)]"
            />
          ) : null}
          {/* no MiSD marker here, it's shown on month/reward cards (actions stay in the
              menu) */}
        </div>
        {cardMeta && (
        <div className="flex max-h-0 translate-y-2 items-center gap-2.5 overflow-hidden text-[9.5px] text-zinc-300 opacity-0 transition-all duration-300 ease-out group-hover:mt-1.5 group-hover:max-h-12 group-hover:translate-y-0 group-hover:opacity-100">
          {badges.map((b) => (
            <span key={b.key} className="relative inline-flex">
              <img
                src={b.src}
                alt={b.label}
                title={
                  verifiedPlatforms.has(b.key)
                    ? `Verified ${b.label} rewards`
                    : `Contains ${b.label} rewards`
                }
                className={`${b.size} object-contain drop-shadow-[0_1px_3px_rgba(0,0,0,0.9)]`}
              />
              {verifiedPlatforms.has(b.key) && <PlatformCheck />}
            </span>
          ))}
          <span className="ml-auto inline-flex items-center gap-1">
            <Images className="h-3 w-3" />
            {tracked ? `${owned}/${total}` : owned}
          </span>
        </div>
        )}
      </div>
      </div>

      {detailsOpen && (
        <CreatorDetails
          artist={artist}
          onClose={() => setDetailsOpen(false)}
          onOpenPanel={() => {
            setDetailsOpen(false);
            navigate(`/artist/${artist.id}?details=1`);
          }}
        />
      )}

      {/* pin marker on the top right, outside the clip */}
      {pinned && (
        <div
          aria-label={t("Pinned")}
          className="pointer-events-none absolute -right-2 -top-3 z-30"
        >
          <CardPin accent={accent} />
        </div>
      )}
    </motion.button>
  );
}

// memo so unchanged cards don't re-render while scrolling (artists are stable refs)
export const ArtistCard = memo(ArtistCardBase);
