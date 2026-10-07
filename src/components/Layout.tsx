import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/Button";
import { Lock, Search, Settings, Tv, TvMinimal, Gift, Eye, EyeOff } from "lucide-react";
import { CyberHomeIcon } from "@/lib/classIcons";
import { GlobeSearchIcon } from "@/lib/globeSearchIcon";
import { BrandMark } from "@/components/BrandMark";
import { WindowControls } from "@/components/WindowControls";
import { SdTransportButton } from "@/components/SdTransportButton";
import { UpdateButton } from "@/components/UpdateButton";
import { SakuraMark } from "@/components/SakuraMark";
import { useNavigate, useLocation } from "react-router-dom";
import { isTauri } from "@/lib/tauri";
import { useAccent } from "@/lib/theme";
import { useSfwMode, toggleSfwMode, getHomeDblToggle } from "@/lib/contentMode";
import { useT, useTf } from "@/lib/i18n";
import { useSafeMode } from "@/lib/safeMode";
import { useMinimal, toggleMinimal } from "@/lib/minimal";
import { useCinemaButton, setCinemaButton } from "@/lib/cinemaButton";
import { usePasswordSet } from "@/lib/lock";
import { useActions } from "@/actions";
import { useData } from "@/store";
import { useShowHidden, toggleShowHidden } from "@/lib/showHidden";
import { useWishlistButton, setWishlistButton } from "@/lib/wishlistButton";
import {
  useGraveyardButton,
  setGraveyardButton,
  useGraveyardMode,
  setGraveyardMode,
} from "@/lib/graveyard";
import { GraveyardIcon } from "@/lib/graveyardIcon";
import { useTopbarHintSeen } from "@/lib/topbarHint";
import { TopbarHint } from "@/components/TopbarHint";
import { recordHistoryEntry } from "@/lib/nav";
import { markPhase } from "@/lib/markClock";

/**
 * Scroll position per history entry (by location.key). Back restores the scroll,
 * a new page starts at the top. Lives in the module so it survives remounts.
 */
const scrollPositions = new Map<string, number>();

interface LayoutProps {
  children: React.ReactNode;
  /** Optional search box. */
  search?: { value: string; onChange: (v: string) => void; placeholder?: string };
  onLock?: () => void;
  /** Breadcrumb / title in the top bar. */
  titleSlot?: React.ReactNode;
  /**
   * The page's own controls (Back button, filter), between the top bar and the
   * scroll area, so they never scroll away.
   */
  toolbar?: React.ReactNode;
}

/* ---- what the current page wants in the top bar ----------------------- */
// The top bar lives once in App (so it isn't rebuilt on every page change).
// Each page's Layout tells it its search box and title.

interface TopbarSlots {
  search?: LayoutProps["search"];
  titleSlot?: React.ReactNode;
}
let slots: TopbarSlots = {};
const slotSubs = new Set<() => void>();
function setTopbarSlots(next: TopbarSlots) {
  slots = next;
  slotSubs.forEach((l) => l());
}
function useTopbarSlots(): TopbarSlots {
  return useSyncExternalStore(
    (cb) => {
      slotSubs.add(cb);
      return () => slotSubs.delete(cb);
    },
    () => slots,
  );
}
/** The current page's scroll area (Home on the dashboard scrolls it to the top). */
let activeMain: HTMLElement | null = null;

/** The top bar, mounted once in App. */
export function TopBar({ onLock }: { onLock?: () => void }) {
  const navigate = useNavigate();
  // what the current page wants in the bar (set by its Layout)
  const { search, titleSlot } = useTopbarSlots();
  const [searchValue, setSearchValue] = useState(search?.value ?? "");
  useEffect(() => {
    setSearchValue(search?.value ?? "");
  }, [search?.value]);
  const location = useLocation();
  const accent = useAccent();
  const sfw = useSfwMode();
  const t = useT();
  const tf = useTf();
  const safe = useSafeMode();
  const minimal = useMinimal();
  const cinemaButton = useCinemaButton();
  const passwordSet = usePasswordSet();
  const onDashboard = location.pathname === "/";
  const sakura = accent === "sakura";
  const cyber = accent === "cyberpunk";
  const irid = accent === "iridescent";
  // keep the glitch animation in phase across page changes (markClock)
  const cyberSwapPhase = markPhase(4200);
  // no OS title bar (decorations off), the header is the drag region
  const customChrome = true;
  const tauri = isTauri();

  const { openMenu } = useActions();
  const { artists } = useData();
  const showHidden = useShowHidden();
  const hiddenCount = artists.filter((a) => a.hidden).length;
  const wishlistButton = useWishlistButton();
  const graveyardButton = useGraveyardButton();
  const graveyardMode = useGraveyardMode();
  // only lit on the dashboard
  const graveyardLit = graveyardMode && onDashboard;
  const topbarHintSeen = useTopbarHintSeen();
  // the three hideable buttons are in one group so the hint bubble can point at them
  const showCinema = onDashboard && cinemaButton;
  const showWishlist = !safe && wishlistButton;
  const showGraveyard = !safe && graveyardButton;
  const hideableShown = showCinema || showWishlist || showGraveyard;
  // only on the dashboard and not in cinema mode
  const showTopbarHint = !topbarHintSeen && hideableShown && onDashboard && !minimal;

  // Home button: on the dashboard already -> scroll to the top instead
  const goHome = () => {
    if (location.pathname !== "/") {
      navigate("/");
      return;
    }
    const main = activeMain;
    if (!main || main.scrollTop === 0) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    main.scrollTo({ top: 0, behavior: reduced ? "auto" : "smooth" });
  };

  return (
      <header
        // the header is the drag region (buttons still work)
        {...(customChrome && tauri ? { "data-tauri-drag-region": true } : {})}
        className={cn(
          // z-30 so the header stays above the dashboard's Creators bar (z-20)
          "app-header relative z-30 flex h-14 shrink-0 items-center gap-3 px-4",
          irid
            ? // Iridescent: a translucent dark glass bar so the title/search stay
              // readable over the shader, translateZ(0) so the blur doesn't flicker
              "border-b border-white/10 bg-zinc-900/45 backdrop-blur-xl [transform:translateZ(0)]"
            : "border-b border-white/5 bg-gradient-to-r from-brand-900/35 via-zinc-950/55 to-brand-900/30 backdrop-blur",
        )}
      >
        <button
          onClick={goHome}
          onDoubleClick={() => {
            if (getHomeDblToggle()) toggleSfwMode();
          }}
          title={
            getHomeDblToggle() ? t("Home (double-click: switch SFW/NSFW)") : t("Home")
          }
          className="flex items-center gap-2 transition-opacity hover:opacity-80"
        >
          {sakura ? (
            // sakura: the theme icon next to "Dashboard" morphs into a blossom (SakuraMark)
            <span className="relative inline-flex h-8 w-8 items-center justify-center">
              <SakuraMark className="absolute inset-0 h-8 w-8" />
              {sfw && (
                <span
                  title={t("SFW mode is on")}
                  className="sfw-dot absolute -right-0.5 -top-0.5"
                />
              )}
            </span>
          ) : cyber ? (
            // cyberpunk: house and M glitch-swap on the yellow plate.
            // the SFW dot sits outside the plate clip so its glow isn't cut off
            <span className="relative inline-flex h-8 w-8 items-center justify-center">
              <span className="flex h-8 w-8 items-center justify-center overflow-hidden rounded-lg bg-[#fcee0a] text-zinc-950 shadow-lg shadow-brand-900/40">
                {/* same phase offset so the swap stays in step (markClock) */}
                <span className="relative inline-flex h-5 w-5 items-center justify-center">
                  <CyberHomeIcon
                    fill="currentColor"
                    className="cyber-mark-house absolute inset-0 h-5 w-5"
                    style={{ animationDelay: cyberSwapPhase }}
                  />
                  <span
                    className="cyber-mark-m absolute inset-0 h-5 w-5"
                    style={{ animationDelay: cyberSwapPhase }}
                  >
                    <BrandMark solid="#09090b" className="h-5 w-5" />
                  </span>
                </span>
              </span>
              {sfw && (
                <span
                  title={t("SFW mode is on")}
                  className="sfw-dot absolute -right-0.5 -top-0.5"
                />
              )}
            </span>
          ) : (
            // iridescent + standard accents: the M mark next to "Dashboard"
            <span className="relative inline-flex h-8 w-8 items-center justify-center">
              <BrandMark className="h-8 w-8" />
              {sfw && (
                <span
                  title={t("SFW mode is on")}
                  className="sfw-dot absolute -right-0.5 -top-0.5"
                />
              )}
            </span>
          )}
          <span className="text-[15px] font-semibold tracking-tight text-zinc-100">
            {t("Dashboard")}
          </span>
        </button>

        {titleSlot && (
          <>
            <span data-tauri-drag-region className={irid ? "text-zinc-300" : "text-zinc-600"}>
              /
            </span>
            {/* breadcrumb as flex row so the leftover space is a drag region */}
            <div
              {...(customChrome && tauri ? { "data-tauri-drag-region": true } : {})}
              className="flex min-w-0 flex-1 items-center"
            >
              {titleSlot}
            </div>
          </>
        )}

        <div className="ml-auto flex items-center gap-2">
          {search && (
            <div className="relative">
              <Search
                className={cn(
                  "pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-brand-300/70",
                  irid && "text-white/80",
                )}
              />
              <input
                value={searchValue}
                onChange={(e) => {
                  setSearchValue(e.target.value);
                  search.onChange(e.target.value);
                }}
                placeholder={search.placeholder ?? t("Search…")}
                className={cn(
                  "h-9 w-56 rounded-lg border border-brand-500/25 bg-brand-500/10 pl-8 pr-3 text-sm text-zinc-100 placeholder:text-zinc-400 outline-none transition-colors hover:border-brand-500/40 focus:border-brand-500/60 focus:bg-brand-500/15 focus:ring-2 focus:ring-brand-500/20",
                  // frosted input on iridescent
                  irid &&
                    "border-white/20 bg-white/10 text-zinc-50 placeholder:text-zinc-200 hover:border-white/30 focus:border-white/40 focus:bg-white/15",
                )}
              />
            </div>
          )}
          <Button
            variant="ghost"
            size="icon"
            onClick={() => window.dispatchEvent(new CustomEvent("micoll:search"))}
            title={t("Global search — find any creator or reward (Ctrl+K)")}
            className="text-brand-300 hover:bg-brand-500/15 hover:text-brand-200"
          >
            <GlobeSearchIcon className="h-4 w-4" />
          </Button>
          {/* cinema mode button (the icon shows the state) */}
          {hideableShown && (
            <div className="relative flex items-center gap-2">
            {showCinema && (
              <Button
                variant="ghost"
                size="icon"
                onClick={() => toggleMinimal()}
                // the cinema button can be hidden too, the gear brings it back
                onContextMenu={(e) =>
                  openMenu(e, [
                    {
                      label: t("Hide this button"),
                      icon: <EyeOff className="h-4 w-4" />,
                      onClick: () => setCinemaButton(false),
                    },
                    { label: t("Right-click the gear to bring it back"), info: true },
                  ])
                }
                title={
                  minimal
                    ? t("Exit cinema mode (right-click to hide this button)")
                    : t("Cinema mode — hide dashboard chrome (right-click to hide this button)")
                }
                className="hover:bg-brand-500/15 hover:text-brand-200"
              >
                {minimal ? <TvMinimal className="h-4 w-4" /> : <Tv className="h-4 w-4" />}
              </Button>
            )}
            {/* wishlist button (hidden in safe mode) */}
            {showWishlist && (
              <Button
                variant="ghost"
                size="icon"
                onClick={() => navigate("/wishlist")}
                onContextMenu={(e) =>
                  openMenu(e, [
                    {
                      label: t("Hide this button"),
                      icon: <EyeOff className="h-4 w-4" />,
                      onClick: () => setWishlistButton(false),
                    },
                    { label: t("Right-click the gear to bring it back"), info: true },
                  ])
                }
                title={t("Wishlist — what you still want (right-click to hide)")}
                // data-lit: premium themes style a lit top bar button (see index.css)
                data-lit={location.pathname === "/wishlist" || undefined}
                className={
                  location.pathname === "/wishlist"
                    ? "bg-brand-500/20 text-brand-200 hover:bg-brand-500/30 hover:text-brand-100"
                    : "hover:bg-brand-500/15 hover:text-brand-200"
                }
              >
                <Gift className="h-4 w-4" />
              </Button>
            )}
            {/* graveyard: a switch, not a page. From another page it goes to the dashboard.
                Hidden in safe mode. */}
            {showGraveyard && (
              <Button
                variant="ghost"
                size="icon"
                onClick={() => {
                  if (!onDashboard) {
                    setGraveyardMode(true);
                    navigate("/");
                  } else {
                    setGraveyardMode(!graveyardMode);
                  }
                }}
                onContextMenu={(e) =>
                  openMenu(e, [
                    {
                      label: t("Hide this button"),
                      icon: <EyeOff className="h-4 w-4" />,
                      onClick: () => setGraveyardButton(false),
                    },
                    { label: t("Right-click the gear to bring it back"), info: true },
                  ])
                }
                title={
                  graveyardLit
                    ? t("Leave the graveyard (right-click to hide)")
                    : t("Graveyard — show only the creators laid to rest (right-click to hide)")
                }
                aria-pressed={graveyardLit}
                data-lit={graveyardLit || undefined}
                className={
                  graveyardLit
                    ? "bg-brand-500/20 text-brand-200 hover:bg-brand-500/30 hover:text-brand-100"
                    : "hover:bg-brand-500/15 hover:text-brand-200"
                }
              >
                <GraveyardIcon className="h-4 w-4" />
              </Button>
            )}
              {showTopbarHint && <TopbarHint />}
            </div>
          )}
          {/* only with a password (otherwise locking is pointless) */}
          {onLock && passwordSet && (
            <Button
              variant="ghost"
              size="icon"
              onClick={onLock}
              title={t("Lock MiColl")}
              className="hover:bg-brand-500/15 hover:text-brand-200"
            >
              <Lock className="h-4 w-4" />
            </Button>
          )}
          {/* only while MiSD has something queued (see SdTransportButton) */}
          {!safe && <SdTransportButton />}
          {/* only while a new version is ready, can't be hidden */}
          {!safe && <UpdateButton />}
          {/* safe mode: no settings gear (the route is guarded too) */}
          {!safe && (
            <Button
              variant="ghost"
              size="icon"
              onClick={() => navigate("/settings")}
              // the gear menu is where hidden creators can be shown again
              onContextMenu={(e) =>
                openMenu(e, [
                  {
                    label: showHidden ? t("Stop showing hidden creators") : t("Show hidden creators"),
                    icon: showHidden ? (
                      <EyeOff className="h-4 w-4" />
                    ) : (
                      <Eye className="h-4 w-4" />
                    ),
                    onClick: () => {
                      toggleShowHidden();
                      if (!showHidden) navigate("/");
                    },
                  },
                  {
                    label:
                      hiddenCount === 0
                        ? t("No creators hidden")
                        : tf("{n} hidden — right-click a card to bring one back", {
                            n: hiddenCount,
                          }),
                    info: true,
                  },
                  // the only way to bring back the wishlist button
                  ...(wishlistButton
                    ? []
                    : [
                        {
                          label: t("Show the wishlist button"),
                          icon: <Gift className="h-4 w-4" />,
                          onClick: () => setWishlistButton(true),
                        },
                      ]),
                  ...(graveyardButton
                    ? []
                    : [
                        {
                          label: t("Show the graveyard button"),
                          icon: <GraveyardIcon className="h-4 w-4" />,
                          onClick: () => setGraveyardButton(true),
                        },
                      ]),
                  // same for the cinema button (only on the dashboard)
                  ...(cinemaButton || !onDashboard
                    ? []
                    : [
                        {
                          label: t("Show the cinema-mode button"),
                          icon: <Tv className="h-4 w-4" />,
                          onClick: () => setCinemaButton(true),
                        },
                      ]),
                ])
              }
              title={t("Settings (right-click for hidden creators)")}
              data-lit={showHidden || undefined}
              className={
                showHidden
                  ? "bg-brand-500/20 text-brand-200 hover:bg-brand-500/30 hover:text-brand-100"
                  : "hover:bg-brand-500/15 hover:text-brand-200"
              }
            >
              <Settings className="h-4 w-4" />
            </Button>
          )}
          {/* minimize/close on every page (also on the lock screen) */}
          {tauri && <WindowControls />}
        </div>
      </header>
  );
}

/**
 * Page frame: the page's toolbar and its scroll area. The top bar itself is in App,
 * this only tells it the page's search box and title.
 */
export function Layout({ children, search, titleSlot, toolbar }: LayoutProps) {
  const location = useLocation();
  // every render, so the search value and title stay current
  useLayoutEffect(() => {
    setTopbarSlots({ search, titleSlot });
  });

  // scroll restore: save the scroll all the time, restore it on Back
  const mainRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    activeMain = mainRef.current;
    return () => {
      if (activeMain === mainRef.current) activeMain = null;
    };
  }, []);
  const scrollKey = location.key;
  /** True while we are restoring the scroll. */
  const restoringRef = useRef(false);
  // remember which page each history entry is (for the back buttons)
  useEffect(() => {
    recordHistoryEntry(location.pathname);
  }, [location.pathname, scrollKey]);
  useEffect(() => {
    const main = mainRef.current;
    if (!main) return;
    const onScroll = () => {
      // don't save positions while we are restoring (they're clamped)
      if (restoringRef.current) return;
      scrollPositions.set(scrollKey, main.scrollTop);
    };
    main.addEventListener("scroll", onScroll, { passive: true });
    return () => main.removeEventListener("scroll", onScroll);
  }, [scrollKey]);
  useLayoutEffect(() => {
    const main = mainRef.current;
    if (!main) return;
    const saved = scrollPositions.get(scrollKey);
    if (!saved) return;
    // set it right away, then keep setting it while the page is still growing.
    // (the virtual grid starts too tall, then shrinks and would clamp the scroll)
    restoringRef.current = true;
    const apply = () => {
      if (Math.abs(main.scrollTop - saved) > 1) main.scrollTop = saved;
    };
    apply();
    let raf = 0;
    let tries = 0;
    const tick = () => {
      apply();
      if (++tries < 30) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    // later changes (grid, covers, sections) show up as resize
    const ro = new ResizeObserver(apply);
    if (main.firstElementChild) ro.observe(main.firstElementChild);
    let giveUp: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      restoringRef.current = false;
      cancelAnimationFrame(raf);
      ro.disconnect();
      clearTimeout(giveUp);
      main.removeEventListener("wheel", stop);
      main.removeEventListener("touchstart", stop);
      main.removeEventListener("pointerdown", stop);
      window.removeEventListener("keydown", stop);
    };
    // stop restoring as soon as the user scrolls
    main.addEventListener("wheel", stop, { passive: true });
    main.addEventListener("touchstart", stop, { passive: true });
    main.addEventListener("pointerdown", stop, { passive: true }); // scrollbar drag
    window.addEventListener("keydown", stop);
    giveUp = setTimeout(stop, 3000);
    return stop;
  }, [scrollKey]);

  return (
    <div className="relative z-10 flex min-h-0 flex-1 flex-col">
      {/* reserves the same scrollbar space as <main> so things line up */}
      {toolbar && (
        <div className="shrink-0 overflow-y-auto [scrollbar-gutter:stable]">{toolbar}</div>
      )}

      {/* scroll content */}
      {/* scrollbar-gutter: stable so the cards don't resize when the scrollbar disappears */}
      <main ref={mainRef} className={cn("flex-1 overflow-y-auto [scrollbar-gutter:stable]")}>
        {children}
      </main>
    </div>
  );
}
