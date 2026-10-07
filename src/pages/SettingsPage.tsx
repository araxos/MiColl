import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { open } from "@tauri-apps/plugin-dialog";
import { getVersion } from "@tauri-apps/api/app";
import {
  ChevronLeft,
  FolderPlus,
  FolderOpen,
  RefreshCw,
  Trash2,
  HardDrive,
  Boxes,
  FolderInput,
  Check,
  ChevronDown,
  Activity,
  BellRing,
  CloudUpload,
  Lock,
  Palette,
  Languages,
  Layers,
  Sparkles,
  DatabaseBackup,
  History,
  Eye,
  Info,
  Image as ImageIcon,
  MessageSquare,
  Search,
  RotateCcw,
  Type,
  SquareDashed,
  X,
} from "lucide-react";
import { Layout } from "@/components/Layout";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { ImportReviewTree } from "@/components/ImportReviewTree";
import { PlatformSettings } from "@/components/PlatformSettings";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { TemplatesPanel } from "@/components/TemplatesPanel";
import { ThemeUnlockDialog } from "@/components/ThemeUnlockDialog";
import { SecurityPanel } from "@/components/SecurityPanel";
import { BackupPanel } from "@/components/BackupPanel";
import { HistoryPanel } from "@/components/HistoryPanel";
import { SdPanel } from "@/components/SdPanel";
import { ContentPanel } from "@/components/ContentPanel";
import { VersionPanel } from "@/components/VersionPanel";
import { FeedbackPanel } from "@/components/FeedbackPanel";
import { LanguagePanel } from "@/components/LanguagePanel";
import { HealthPanel } from "@/components/HealthPanel";
import { useData } from "@/store";
import { useActions } from "@/actions";
import * as api from "@/api/library";
import { ACCENTS, applyAccent, getAccent, useAccent, useLicensee, useTrialUntil, toggleOnClass, isPremium, premiumUnlocked, THEME_PACKS, type AccentDef, type AccentKey } from "@/lib/theme";
import { SALES_OPEN } from "@/lib/sales";
import { cn } from "@/lib/utils";
import { isTauri } from "@/lib/tauri";
import { version as PKG_VERSION } from "../../package.json";
import { useT, useTf } from "@/lib/i18n";
import { getCardFx, setCardFx } from "@/lib/fx";
import { getHoloFreq, setHoloFreq, HOLO_FREQ_LABELS, type HoloFreq } from "@/lib/holoFreq";
import { getGlassButtons, setGlassButtons } from "@/lib/glassButtons";
import { getTemplateFont, setTemplateFont, useTemplateFont } from "@/lib/templateFont";
import { getClassIconOpacity, setClassIconOpacity } from "@/lib/classIconOpacity";
import {
  CARD_NAME_MAX,
  CARD_NAME_MIN,
  getCardNameSize,
  setCardNameSize,
} from "@/lib/cardNameSize";
import {
  getWallpaper,
  setWallpaper,
  getWallpaperDim,
  setWallpaperDim,
  isWallpaperPreset,
  WALLPAPER_PRESET_PREFIX,
  MAX_DIM,
} from "@/lib/wallpaper";
import { themeWallpapers } from "@/lib/wallpaperPresets";
import { getHideNames, setHideNames } from "@/lib/hideNames";
import { getViewerStartsInGrid, setViewerStartsInGrid } from "@/lib/viewerStart";
import { getCardPlus, setCardPlus } from "@/lib/cardPlus";
import { getCardMeta, setCardMeta } from "@/lib/cardMeta";
import { getShowHidden, setShowHidden } from "@/lib/showHidden";
import { getWindowButtons, setWindowButtons } from "@/lib/windowButtons";
import { getStripCreator, setStripCreator } from "@/lib/stripCreator";
import { getAnimatedBg, setAnimatedBg } from "@/lib/animatedBg";
import { getClassicLuxe, setClassicLuxe } from "@/lib/classicLuxe";
import { getCyberFrame, setCyberFrame } from "@/lib/cyberFrame";
import { getSakuraFrame, setSakuraFrame } from "@/lib/sakuraFrame";
import { getIriFrame, setIriFrame } from "@/lib/iriFrame";
import { gpuInfo } from "@/lib/gpuInfo";
import { getOptimizeLargeImages, setOptimizeLargeImages } from "@/lib/optimizeLarge";
import { getPlayGifs, setPlayGifs } from "@/lib/playGifs";
import { getIdlePause, setIdlePause, type IdlePause } from "@/lib/perf";
import {
  getTileShape,
  resetTileShapes as resetTileShapeStorage,
  setTileShape,
  TILE_SCOPES,
  TILE_SHAPES,
  type TileScope,
  type TileShape,
} from "@/lib/tileShape";
import { useDialogTheme } from "@/lib/dialogTheme";
import { ThemedSelect } from "@/components/ThemedSelect";
import { APP_ICONS, autoAppIcon, setAppIconChoice, useAppIconChoice } from "@/lib/appIcon";
import { useConcise, setConcise } from "@/lib/concise";
import { resetAllWarnings } from "@/lib/warnings";
import { useUpNavigate } from "@/lib/nav";
import { useLocation } from "react-router-dom";

/**
 * One settings section: a link in the left rail and a search target.
 * keywords = words users would search for that aren't in the heading
 * ("password" -> Security, "sd card" -> MiSD). Keep them up to date.
 */
interface NavSection {
  id: string;
  label: string;
  Icon: typeof Lock;
  keywords: string;
  /** Sections that only exist in the desktop app. */
  desktopOnly?: boolean;
}

/** The idle pause options. The selected one's hint is shown under the heading. */
const IDLE_PAUSE_OPTIONS: [IdlePause, string, string][] = [
  ["minimized", "When minimized", "Keeps animating behind other windows."],
  ["unfocused", "When not active", "Another window in front, MiColl still on screen."],
  ["inactive", "Both", "Either of the two above — the quietest."],
  ["off", "Never", "Always animate, whatever it costs."],
];

const SECTIONS: NavSection[] = [
  {
    id: "appearance",
    label: "Appearance",
    Icon: Palette,
    keywords:
      "theme accent colour color premium look sand grain crystal glints classic unlock beta iridescent sakura cyberpunk animation animations motion background wallpaper custom picture image dim darken brightness reset hide creator names card shapes reward tiles tile shape format ratio square card poster banner portrait 4x5 4x6 5x10 10x5 creator page month page app icon taskbar logo colour rose purple blue green yellow overview grid gallery thumbnails tiles open reward folder explorer viewer first picture start mode",
  },
  {
    id: "performance",
    label: "Performance",
    Icon: Activity,
    keywords:
      "performance cpu processor fan noise battery power idle background minimized minimised inactive unfocused animations pause holo frequency glint shimmer webview webview2 usage load lag stutter slow gif gifs play animated optimize optimise large images downscale preview huge resolution graphics gpu renderer driver hardware acceleration software swiftshader webgl frosted buttons blur backdrop glass line seam edge black stripe artifact tray taskbar notification area system close quit hide minimize background running resident",
  },
  {
    id: "content",
    label: "Content",
    Icon: Eye,
    keywords: "sfw nsfw content mode adult blur safe for work",
  },
  {
    id: "platforms",
    label: "Platforms",
    Icon: Layers,
    keywords: "patreon ko-fi kofi gumroad fansly onlyfans release style monthly numbered custom",
  },
  {
    id: "templates",
    label: "Templates",
    Icon: Sparkles,
    keywords: "template verified official total released periods apply import personal log",
    desktopOnly: true,
  },
  {
    id: "library",
    label: "Library",
    Icon: FolderOpen,
    keywords:
      "folder folders add root roots managed collection organize move rescan reindex health missing files clear database warnings reset",
  },
  {
    id: "history",
    label: "History",
    Icon: History,
    keywords:
      "history log activity protocol deleted delete removed moved move renamed rename merged recycle bin trash where did my files go missing lost undo",
    desktopOnly: true,
  },
  {
    id: "security",
    label: "Security & lock",
    Icon: Lock,
    keywords: "password lock unlock auto-lock encryption encrypt decrypt recovery code key privacy",
    desktopOnly: true,
  },
  {
    id: "backup",
    label: "Backup DB",
    Icon: DatabaseBackup,
    keywords: "database backup restore snapshot save copy export",
    desktopOnly: true,
  },
  {
    id: "misd",
    label: "MiSD",
    Icon: HardDrive,
    keywords: "sd card external disk drive transport offline preview bring back volume storage space",
    desktopOnly: true,
  },
  {
    id: "sharing",
    label: "Sharing",
    Icon: CloudUpload,
    keywords: "mega upload cloud phone share send version versions edited edit original newest latest",
    desktopOnly: true,
  },
  {
    id: "feedback",
    label: "Feedback",
    Icon: MessageSquare,
    keywords: "feedback bug report idea suggestion contact support anonymous write message",
  },
  {
    id: "language",
    label: "Language",
    Icon: Languages,
    keywords:
      "language languages translate translation translated locale localisation localization region english deutsch german espanol spanish francais french portugues portuguese italiano italian polski polish russian japanese chinese system",
  },
  {
    id: "version",
    label: "Version",
    Icon: Info,
    keywords:
      "about build release update updates updater upgrade install automatic automatically check changelog new latest license licenses third-party open source credits attribution",
  },
];

export function SettingsPage({ onLock }: { onLock: () => void }) {
  const t = useT();
  const tf = useTf();
  const upNavigate = useUpNavigate();
  const location = useLocation();
  const { backed, refresh, artists } = useData();
  const { openMenu } = useActions();
  const [roots, setRoots] = useState<api.RootDto[]>([]);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [review, setReview] = useState<api.ImportPlan | null>(null);
  const [source, setSource] = useState("");

  // managed library state
  const [managed, setManaged] = useState(false);
  const [collectionRoot, setCollectionRoot] = useState("");
  const [confirmOrganize, setConfirmOrganize] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [confirmCovers, setConfirmCovers] = useState(false);
  const [healthOpen, setHealthOpen] = useState(false);
  // a newly picked collection folder waiting for "move / just switch"
  const [pendingRoot, setPendingRoot] = useState<string | null>(null);

  // appearance
  const [accent, setAccent] = useState<AccentKey>(getAccent());
  // per-accent styles for the tile shape picker
  const dlg = useDialogTheme();
  const [premium, setPremium] = useState(premiumUnlocked());
  /** Who the theme key was issued to (stays visible, makes sharing awkward). */
  const licensee = useLicensee();
  /** A test key says so on the plate. */
  const trialUntil = useTrialUntil();
  const [unlockOpen, setUnlockOpen] = useState(false);
  // the premium accent clicked while locked, applied right after unlocking
  const [pendingAccent, setPendingAccent] = useState<AccentKey | null>(null);
  const chooseAccent = (key: AccentKey) => {
    if (isPremium(key) && !premiumUnlocked()) {
      setPendingAccent(key);
      setUnlockOpen(true);
      return;
    }
    setAccent(key);
    applyAccent(key);
  };
  // cyberpunk card frame is in the swatch's right-click menu (only for that theme)
  const [cyberFrame, setCyberFrameOn] = useState(getCyberFrame());
  const [sakuraFrame, setSakuraFrameOn] = useState(getSakuraFrame());
  const [iriFrame, setIriFrameOn] = useState(getIriFrame());
  // template display font, read as hook, the click reads the live value (menu stays open)
  const templateFont = useTemplateFont();
  const accentMenu = (e: React.MouseEvent, key: AccentKey) => {
    // all frames share the same menu
    const frame =
      key === "cyberpunk"
        ? {
            is: cyberFrame,
            read: getCyberFrame,
            write: (v: boolean) => {
              setCyberFrameOn(v);
              setCyberFrame(v);
            },
            info: "Yellow frame with a template, cyan without. Replaces the card's holo effects.",
          }
        : key === "sakura"
          ? {
              is: sakuraFrame,
              read: getSakuraFrame,
              write: (v: boolean) => {
                setSakuraFrameOn(v);
                setSakuraFrame(v);
              },
              info: "Petal-cut cards with a blossom in the notch — deep rose with a template, pale without. Replaces the card's holo effects with silk and drifting petals.",
            }
          : key === "iridescent"
            ? {
                is: iriFrame,
                read: getIriFrame,
                write: (v: boolean) => {
                  setIriFrameOn(v);
                  setIriFrame(v);
                },
                info: "Liquid-drop cards with a travelling prism rim — full spectrum with a template, pale shell without. Replaces the card's holo effects with drifting caustics.",
              }
            : null;
    if (!frame) return;
    // locked themes still show their menu, plus a line that it isn't unlocked yet
    const isLocked = !premium;
    const on = { label: t("Turn off the card frame"), icon: <SquareDashed className="h-4 w-4" /> };
    const off = { label: t("Card frame on the dashboard"), icon: <SquareDashed className="h-4 w-4" /> };
    // only iridescent and cyberpunk have a display font
    const hasFace = key === "iridescent" || key === "cyberpunk";
    const fontOn = { label: t("Turn off the template font"), icon: <Type className="h-4 w-4" /> };
    const fontOff = { label: t("Template font on card names"), icon: <Type className="h-4 w-4" /> };
    openMenu(e, [
      {
        ...(frame.is ? on : off),
        keepOpen: true,
        toggled: frame.is ? off : on,
        // read the live value, the item can be clicked several times (keepOpen)
        onClick: () => frame.write(!frame.read()),
      },
      { label: frame.info, info: true },
      ...(hasFace
        ? [
            {
              ...(templateFont ? fontOn : fontOff),
              keepOpen: true,
              toggled: templateFont ? fontOff : fontOn,
              onClick: () => setTemplateFont(!getTemplateFont()),
            },
            {
              label:
                key === "iridescent"
                  ? "Creator cards with a template write their name in KDA. Off puts them back in the theme's normal font — and brings the verified check back."
                  : "Creator cards with a template write their name in MiColl Cut. Off puts them back in the theme's normal font — and brings the verified check back.",
              info: true,
            },
          ]
        : []),
      ...(isLocked
        ? [
            {
              label: tf("{name} is locked — these take effect once you unlock the premium themes.", {
                name: t(ACCENTS.find((a) => a.key === key)?.label ?? "This theme"),
              }),
              info: true as const,
            },
          ]
        : []),
    ]);
  };
  const [cardFx, setCardFxOn] = useState(getCardFx());
  const toggleCardFx = (on: boolean) => {
    setCardFxOn(on);
    setCardFx(on);
  };
  const [holoFreq, setHoloFreqOn] = useState<HoloFreq>(getHoloFreq());
  const changeHoloFreq = (v: HoloFreq) => {
    setHoloFreqOn(v);
    setHoloFreq(v);
  };
  const [nameSize, setNameSizeStep] = useState(getCardNameSize());
  const changeNameSize = (v: number) => {
    setNameSizeStep(v);
    setCardNameSize(v);
  };
  const [classIcons, setClassIconsPct] = useState(getClassIconOpacity());
  const changeClassIcons = (v: number) => {
    setClassIconsPct(v);
    setClassIconOpacity(v);
  };
  const [wallpaper, setWallpaperPath] = useState(getWallpaper());
  const changeWallpaper = (p: string) => {
    setWallpaperPath(p);
    setWallpaper(p);
  };
  const [wallDim, setWallDimPct] = useState(getWallpaperDim());
  const changeWallDim = (v: number) => {
    setWallDimPct(v);
    setWallpaperDim(v);
  };
  /**
   * What the wallpaper dropdown shows. A custom file shows as custom, nothing saved =
   * the theme default, "Shader still" is its own saved choice.
   */
  const themeWalls = themeWallpapers(accent);
  const presetLabel = t(
    !wallpaper
      ? (themeWalls.list.find((p) => p.id === themeWalls.fallback)?.label ?? "Custom picture")
      : (themeWalls.list.find((p) => wallpaper === `${WALLPAPER_PRESET_PREFIX}${p.id}`)?.label ??
          "Custom picture"),
  );

  const pickWallpaper = async () => {
    const picked = await open({
      multiple: false,
      title: t("Choose a wallpaper"),
      filters: [{ name: "Images", extensions: ["jpg", "jpeg", "png", "webp", "avif", "gif", "bmp"] }],
    });
    if (typeof picked === "string") changeWallpaper(picked);
  };
  const [hideNames, setHideNamesOn] = useState(getHideNames());
  // saved as "show +", shown here as "hide", flipped only here
  const [cardPlus, setCardPlusOn] = useState(getCardPlus);
  const toggleHidePlus = (hide: boolean) => {
    setCardPlusOn(!hide);
    setCardPlus(!hide);
  };
  const [cardMeta, setCardMetaOn] = useState(getCardMeta);
  const toggleCardMeta = (on: boolean) => {
    setCardMetaOn(on);
    setCardMeta(on);
  };
  const [winButtons, setWinButtonsOn] = useState(getWindowButtons);
  const toggleWinButtons = (one: boolean) => {
    setWinButtonsOn(one ? "one" : "both");
    setWindowButtons(one ? "one" : "both");
  };
  const [showHidden, setShowHiddenOn] = useState(getShowHidden);
  const toggleShowHiddenRow = (on: boolean) => {
    setShowHiddenOn(on);
    setShowHidden(on);
  };
  const hiddenCreators = artists.filter((a) => a.hidden).length;
  const [stripCreator, setStripCreatorOn] = useState(getStripCreator);
  const toggleStripCreator = (on: boolean) => {
    setStripCreatorOn(on);
    setStripCreator(on);
  };
  const toggleHideNames = (on: boolean) => {
    setHideNamesOn(on);
    setHideNames(on);
  };
  const [viewerGrid, setViewerGridOn] = useState(getViewerStartsInGrid);
  const toggleViewerGrid = (on: boolean) => {
    setViewerGridOn(on);
    setViewerStartsInGrid(on);
  };
  const [animatedBg, setAnimatedBgOn] = useState(getAnimatedBg());
  const [classicLuxe, setClassicLuxeOn] = useState(getClassicLuxe());
  const toggleClassicLuxe = (on: boolean) => {
    setClassicLuxeOn(on);
    setClassicLuxe(on);
  };
  const toggleAnimatedBg = (on: boolean) => {
    setAnimatedBgOn(on);
    setAnimatedBg(on);
  };
  const [optimizeLarge, setOptimizeLargeOn] = useState(getOptimizeLargeImages());
  const toggleOptimizeLarge = (on: boolean) => {
    setOptimizeLargeOn(on);
    setOptimizeLargeImages(on);
  };
  const appIcon = useAppIconChoice();
  // one shape per page type, the dashboard is always 4:6
  const [tileShapes, setTileShapesState] = useState<Record<TileScope, TileShape>>({
    year: getTileShape("year"),
    month: getTileShape("month"),
  });
  const changeTileShape = (scope: TileScope, key: TileShape) => {
    setTileShapesState((s) => ({ ...s, [scope]: key }));
    setTileShape(scope, key);
  };
  const resetTileShapes = () => {
    resetTileShapeStorage();
    setTileShapesState({
      year: getTileShape("year"),
      month: getTileShape("month"),
    });
  };
  const [playGifs, setPlayGifsOn] = useState(getPlayGifs());
  const togglePlayGifs = (on: boolean) => {
    setPlayGifsOn(on);
    setPlayGifs(on);
  };
  // "Keep running in the tray", saved in the DB, the command also adds/removes the tray
  // icon
  const [closeToTray, setCloseToTrayOn] = useState(false);
  useEffect(() => {
    if (!backed) return;
    let alive = true;
    api.getSetting(api.CLOSE_TO_TRAY_KEY)
      .then((v) => alive && setCloseToTrayOn(v === "true"))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [backed]);
  const toggleCloseToTray = (on: boolean) => {
    setCloseToTrayOn(on);
    api.setCloseToTray(on).catch((e) => {
      setCloseToTrayOn(!on); // the tray couldn't be built — don't claim it worked
      setStatus(`Couldn’t change the tray option: ${e}`);
    });
  };
  // which file MEGA uploads by default (saved in the DB)
  const [megaVersion, setMegaVersionOn] = useState<"original" | "newest">("original");
  useEffect(() => {
    if (!backed) return;
    let alive = true;
    api.getSetting(api.MEGA_VERSION_KEY)
      .then((v) => alive && setMegaVersionOn(v === "newest" ? "newest" : "original"))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [backed]);
  const changeMegaVersion = (v: "original" | "newest") => {
    setMegaVersionOn(v);
    api.setSetting(api.MEGA_VERSION_KEY, v).catch(() => {});
  };
  const [glassButtons, setGlassButtonsOn] = useState(getGlassButtons);
  const toggleGlassButtons = (on: boolean) => {
    setGlassButtonsOn(on);
    setGlassButtons(on);
  };
  const [idlePause, setIdlePauseOn] = useState<IdlePause>(getIdlePause);
  const changeIdlePause = (v: IdlePause) => {
    setIdlePauseOn(v);
    setIdlePause(v);
  };
  // read once, the renderer can't change while running
  const gpu = gpuInfo();

  const renderSwatch = (a: AccentDef) => {
    const active = accent === a.key;
    const locked = a.tier === "premium" && !premium;
    const fill = a.swatch ?? `linear-gradient(135deg, ${a.from}, ${a.to})`;
    return (
      <button
        key={a.key}
        onClick={() => chooseAccent(a.key)}
        onContextMenu={(e) => accentMenu(e, a.key)}
        title={
          a.key === "cyberpunk" || a.key === "sakura" || a.key === "iridescent"
            ? (locked
                ? tf("{name} — premium, unlock with a theme key.", { name: t(a.label) }) + " "
                : "") +
              (a.key === "sakura"
                ? tf("Right-click {name} for its card frame option", { name: t(a.label) })
                : tf("Right-click {name} for its card frame and template font options", {
                    name: t(a.label),
                  }))
            : t(a.label)
        }
        className={cn(
          "group relative flex items-center gap-2.5 rounded-xl border px-3 py-2 transition-colors",
          active
            ? "border-white/40 bg-white/10 shadow-lg"
            : irid
              ? "border-white/15 bg-white/10 backdrop-blur-md hover:bg-white/20"
              : "appearance-chip border-zinc-800 bg-zinc-900 micoll-hover",
        )}
        // selected: a light tint of the theme itself
        style={active ? { boxShadow: `0 0 0 1px rgba(255,255,255,0.06), 0 8px 22px -10px ${a.from}` } : undefined}
      >
        {active && (
          <span
            aria-hidden
            className="pointer-events-none absolute inset-0 rounded-xl opacity-20"
            style={{ background: fill }}
          />
        )}
        <span
          className={`relative flex h-6 w-6 items-center justify-center rounded-full shadow-inner ring-1 ring-white/20 ${locked ? "opacity-60 saturate-50" : ""}`}
          style={{ background: fill }}
        >
          {active && <Check className="h-3.5 w-3.5 text-white drop-shadow-[0_1px_2px_rgba(0,0,0,0.8)]" strokeWidth={3} />}
          {locked && <Lock className="h-3 w-3 text-white drop-shadow-[0_1px_2px_rgba(0,0,0,0.9)]" strokeWidth={2.5} />}
        </span>
        {/* cyberpunk font is wider, one size smaller so "Yellow" fits */}
        <span
          className={cn(
            "relative",
            cyber ? "text-xs" : "text-sm",
            active ? "font-medium text-zinc-50" : locked ? "text-zinc-400" : "text-zinc-300",
          )}
        >
          {t(a.label)}
        </span>
      </button>
    );
  };

  const loadRoots = useCallback(async () => {
    if (!backed) return;
    const [r, enabled, root] = await Promise.all([
      api.listRoots(),
      api.getSetting("managed_enabled"),
      api.getSetting("collection_root"),
    ]);
    setRoots(r);
    setManaged(enabled === "true");
    setCollectionRoot(root ?? "");
  }, [backed]);

  useEffect(() => {
    void loadRoots();
  }, [loadRoots]);

  const toggleManaged = async (on: boolean) => {
    setManaged(on);
    await api.setSetting("managed_enabled", on ? "true" : "false");
  };

  const chooseCollectionFolder = async () => {
    const picked = await open({
      directory: true,
      multiple: false,
      title: t("Choose where the MiColl collection should live"),
    });
    if (typeof picked !== "string") return;
    // first choice (or same folder) -> just save. Changing it asks to move the folder too.
    if (collectionRoot && collectionRoot !== picked) {
      setPendingRoot(picked);
    } else {
      setCollectionRoot(picked);
      await api.setSetting("collection_root", picked);
    }
  };

  // "Move it here": move the MiColl folder to the new root
  const doMoveCollection = async () => {
    if (!pendingRoot) return;
    setBusy(true);
    setStatus(null);
    try {
      const r = await api.moveCollection(pendingRoot);
      setCollectionRoot(r.newRoot);
      await Promise.all([loadRoots(), refresh()]);
      setStatus(
        r.moved
          ? `Moved your collection to ${r.newRoot}\\MiColl (${r.images} file${r.images === 1 ? "" : "s"} re-linked).`
          : `Collection folder set to ${r.newRoot}.`,
      );
    } catch (e) {
      setStatus(`Error: ${e}`);
    } finally {
      setBusy(false);
      setPendingRoot(null);
    }
  };

  // "Just switch": only change the setting, files stay
  const doSwitchCollectionOnly = async () => {
    const picked = pendingRoot;
    setPendingRoot(null);
    if (!picked) return;
    setCollectionRoot(picked);
    await api.setSetting("collection_root", picked);
    setStatus(`Collection folder set to ${picked}. Existing files were left in place.`);
  };

  const doOrganize = async () => {
    setBusy(true);
    setStatus(null);
    try {
      const s = await api.organizeCollection();
      // content is in the collection now, the old folders are stale
      await api.clearRoots();
      await Promise.all([loadRoots(), refresh()]);
      setStatus(
        `Organized: moved ${s.moved}, skipped ${s.skipped}` +
          (s.failed ? `, failed ${s.failed} (${s.errors.join("; ")})` : "."),
      );
    } catch (e) {
      setStatus(`Error: ${e}`);
    } finally {
      setBusy(false);
      setConfirmOrganize(false);
    }
  };

  const chooseFolder = async () => {
    const picked = await open({ directory: true, multiple: false, title: t("Choose a folder to import") });
    if (typeof picked !== "string") return;
    setBusy(true);
    setStatus(null);
    try {
      const plan = await api.analyzeImport(picked);
      setSource(picked);
      setReview(plan);
    } catch (e) {
      setStatus(`Error: ${e}`);
    } finally {
      setBusy(false);
    }
  };

  const doImport = async (
    rewards: api.ResolvedReward[],
    opts: { styles: api.StyleChoice[] },
  ) => {
    setBusy(true);
    setStatus(null);
    try {
      const s = await api.commitImport(rewards, source, opts.styles);
      if (managed && collectionRoot) {
        // managed mode: move the new content into the collection and remove the old folder
        await api.organizeCollection();
        await api.clearRoots();
      }
      setReview(null);
      await Promise.all([loadRoots(), refresh()]);
      setStatus(
        managed && collectionRoot
          ? `Imported & moved ${s.rewards} reward(s) into your collection.`
          : `Imported ${s.rewards} reward(s) across ${s.artists} artist(s)` +
              (s.needsReview ? ` — ${s.needsReview} still need a platform.` : "."),
      );
    } catch (e) {
      setStatus(`Error: ${e}`);
    } finally {
      setBusy(false);
    }
  };

  const doRescan = async () => {
    setBusy(true);
    setStatus(null);
    try {
      const s = await api.rescan();
      await refresh();
      setStatus(`Rescanned: ${s.artists} artist(s), ${s.rewards} reward(s), ${s.images} image(s).`);
    } catch (e) {
      setStatus(`Error: ${e}`);
    } finally {
      setBusy(false);
    }
  };

  const doRescanCollection = async () => {
    setBusy(true);
    setStatus(null);
    try {
      const s = await api.rescanCollection();
      await Promise.all([loadRoots(), refresh()]);
      setStatus(
        `Rescanned collection: ${s.artists} artist(s), ${s.rewards} reward(s), ${s.images} image(s).`,
      );
    } catch (e) {
      setStatus(`Error: ${e}`);
    } finally {
      setBusy(false);
    }
  };

  const doRemove = async (id: number) => {
    setBusy(true);
    try {
      await api.removeRoot(id);
      await Promise.all([loadRoots(), refresh()]);
    } finally {
      setBusy(false);
    }
  };

  const doResetCovers = async () => {
    setBusy(true);
    setStatus(null);
    try {
      const n = await api.resetMissingCovers();
      await refresh();
      setStatus(n > 0 ? t("Missing covers reset.") : t("No missing covers found."));
    } catch (e) {
      setStatus(`Error: ${e}`);
    } finally {
      setBusy(false);
      setConfirmCovers(false);
    }
  };

  const doClear = async () => {
    setBusy(true);
    setStatus(null);
    try {
      await api.clearLibrary();
      await Promise.all([loadRoots(), refresh()]);
      setStatus("Library cleared. Add a folder to import fresh.");
    } catch (e) {
      setStatus(`Error: ${e}`);
    } finally {
      setBusy(false);
      setConfirmClear(false);
    }
  };

  // frosted glass panel for each section
  const glass =
    "settings-glass rounded-2xl border border-white/10 bg-zinc-900/55 p-5 shadow-xl shadow-black/20 backdrop-blur-lg";
  // light frosted inner cards on iridescent
  const irid = accent === "iridescent";
  const sak = accent === "sakura";
  const cyber = accent === "cyberpunk";
  /** The license plate per premium theme, basic accents keep the simple chip. */
  const platePremium = irid || sak || cyber;
  // sliders: iridescent/sakura have their own style, others use the brand color
  const rangeClass =
    accent === "iridescent" ? "iri-range" : accent === "sakura" ? "sak-range" : "accent-brand-500";
  // these motion settings only affect premium themes, so they're greyed out on others
  const fxLive = isPremium(accent);
  const fxHint = fxLive
    ? undefined
    : t("Only affects the premium themes (sakura, cyberpunk, iridescent)");
  const iriInner = "glass-box border-white/15 bg-white/10 backdrop-blur-md";
  // inner rows: light frosted on iridescent, dark on the others
  const cardInner = cn(
    "rounded-xl border p-4",
    irid ? iriInner : "glass-box border-zinc-800 bg-zinc-900/40",
  );
  /** Empty/hint box: same surface with a dashed border. */
  const iriDashed = "border-white/25 bg-white/5 backdrop-blur-md";
  /** Icon square in a list row (frosted on iridescent). */
  const iriTile = "bg-white/15 text-white ring-1 ring-inset ring-white/20";
  /** Inline <code> (frosted on iridescent). */
  const codeChip = irid
    ? "rounded bg-white/15 text-white ring-1 ring-inset ring-white/20"
    : "rounded bg-zinc-800 text-zinc-200";

  // "Back" sits on the wallpaper, premium themes get a dark glass pill so it's visible
  const premiumAccent =
    accent === "iridescent" || accent === "sakura" || accent === "cyberpunk";
  // "No descriptions" (see lib/concise.ts): data-concise on the page + settings-desc on
  // texts
  const concise = useConcise();
  // the installed version for the box under the quick links (package.json in the browser)
  const [appVersion, setAppVersion] = useState(PKG_VERSION);
  useEffect(() => {
    if (!isTauri()) return;
    getVersion()
      .then(setAppVersion)
      .catch(() => {});
  }, []);

  /* ---- search + quick-links ------------------------------------------ */

  const [query, setQuery] = useState("");
  // every word must match
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const searching = terms.length > 0;
  /** Does the section heading or keywords match? Then the whole section shows. */
  const metaHit = useCallback(
    (id: string) => {
      if (!terms.length) return true;
      const s = SECTIONS.find((x) => x.id === id);
      if (!s) return true;
      // both names, the keywords are English only
      const hay = `${s.label} ${t(s.label)} ${s.keywords}`.toLowerCase();
      return terms.every((t) => hay.includes(t));
    },
    // `terms` is rebuilt each render from `query`; keying on the joined string keeps
    // the callback stable while the query itself doesn't change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [terms.join(" "), t],
  );
  /** Sections that exist right now. */
  const present = SECTIONS.filter((s) => !s.desktopOnly || backed);
  /** Sections with something left to show (filled in below). Empty = not searching. */
  const [shownIds, setShownIds] = useState<string[]>([]);
  const shown = searching ? present.filter((s) => shownIds.includes(s.id)) : present;

  /**
   * Filter down to single settings by the text on screen.
   * The unit is a section's direct child (one setting box). Panels that are a
   * single child (MiSD, Security...) are shown whole.
   * Runs after every render because panels fill in async.
   */
  useEffect(() => {
    const alive: string[] = [];
    for (const s of present) {
      const sec = document.getElementById(s.id);
      if (!sec) continue;
      const units = Array.from(sec.children).filter(
        (el): el is HTMLElement =>
          el instanceof HTMLElement &&
          // heading and intro always stay
          !/^H[12]$/.test(el.tagName) &&
          !(el.tagName === "P" && el.classList.contains("settings-desc")),
      );
      const hits = searching
        ? units.filter((u) => terms.every((t) => (u.textContent ?? "").toLowerCase().includes(t)))
        : units;
      // single settings win, keywords only count when nothing on screen matched
      // (e.g. "gpu" still finds Performance)
      const whole = !searching || (hits.length === 0 && metaHit(s.id));
      for (const u of units) u.hidden = !whole && !hits.includes(u);
      const any = whole || hits.length > 0;
      sec.hidden = !any;
      if (any) alive.push(s.id);
    }
    // only write when it changed (no dependency list)
    setShownIds((prev) => (prev.join("|") === alive.join("|") ? prev : alive));
  });

  // which section the rail highlights: the top one on screen
  const [activeId, setActiveId] = useState<string>("appearance");
  useEffect(() => {
    const els = shown
      .map((s) => document.getElementById(s.id))
      .filter((e): e is HTMLElement => !!e);
    if (!els.length) return;
    const io = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) setActiveId(visible[0].target.id);
      },
      // bias toward the top of the viewport
      { rootMargin: "-72px 0px -60% 0px", threshold: 0 },
    );
    els.forEach((e) => io.observe(e));
    return () => io.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown.map((s) => s.id).join(","), backed]);

  const goTo = (id: string) => {
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    document
      .getElementById(id)
      ?.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "start" });
    setActiveId(id);
  };

  // /settings#history (top bar button): jump to that section. Again a bit later,
  // the panels above fill in async and push it down
  useEffect(() => {
    const id = location.hash.slice(1);
    if (!id) return;
    const jump = () => {
      document.getElementById(id)?.scrollIntoView({ block: "start" });
      setActiveId(id);
    };
    const raf = requestAnimationFrame(jump);
    const late = window.setTimeout(jump, 400);
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(late);
    };
  }, [location.key, location.hash, backed]);

  // collection tools, each in its own box below Library (as data so search can filter them)
  const tools = [
    { id: "history", node: <HistoryPanel backed={backed} /> },
    { id: "security", node: <SecurityPanel backed={backed} /> },
    { id: "backup", node: <BackupPanel backed={backed} onLock={onLock} /> },
    { id: "misd", node: <SdPanel backed={backed} /> },
  ];
  const backBtnClass = !premiumAccent
    ? undefined
    : cn(
        "border backdrop-blur-md shadow-lg shadow-black/25",
        accent === "iridescent"
          ? "border-white/15 !bg-zinc-900/55 !text-zinc-100 hover:!bg-zinc-900/80"
          : accent === "sakura"
            ? "border-[#f9a8d4]/30 !bg-zinc-900/50 !text-zinc-100 hover:!bg-zinc-900/75"
            : "!rounded-none border-[#fcee0a]/50 !bg-zinc-950/60 !text-zinc-100 hover:!bg-zinc-950/85",
      );

  return (
    <Layout
      onLock={onLock}
      titleSlot={<span className="font-medium text-zinc-100">{t("Settings")}</span>}
      // Back left, search middle, "no descriptions" right. In the Layout toolbar
      // so Back is always reachable.
      toolbar={
        <div className="mx-auto flex max-w-5xl items-center gap-3 px-6 pb-4 pt-6 lg:gap-6">
          {/* Back is as wide as the rail so the search lines up with the boxes */}
          <div className="shrink-0 lg:w-52">
            <Button
              variant="ghost"
              size="sm"
              // Back goes to the previous page, the dashboard only if there is none
              onClick={() => upNavigate("/", () => true)}
              className={cn(premiumAccent ? "" : "-ml-2", backBtnClass)}
            >
              <ChevronLeft className="h-4 w-4" />
              {t("Back")}
            </Button>
          </div>

          {/* searches only these settings (Ctrl+K searches the library) */}
          <div className="relative min-w-0 flex-1">
            {/* z-10 so the icon isn't covered by the input (backdrop-blur makes it a
                stacking context).
                white only where grey would disappear */}
            <Search
              className={cn(
                "pointer-events-none absolute left-3 top-1/2 z-10 h-4 w-4 -translate-y-1/2",
                irid ? "text-white" : "text-zinc-500",
              )}
            />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") setQuery("");
              }}
              placeholder={t("Search settings…")}
              aria-label={t("Search settings")}
              className={cn(
                "h-9 w-full pl-9 pr-8 text-sm text-zinc-100 shadow-lg shadow-black/20 outline-none transition-colors placeholder:text-white",
                premiumAccent
                  ? accent === "iridescent"
                    ? "rounded-lg border border-white/15 bg-zinc-900/55 backdrop-blur-md focus:border-white/40"
                    : accent === "sakura"
                      ? "rounded-lg border border-[#f9a8d4]/30 bg-zinc-900/50 backdrop-blur-md focus:border-[#f9a8d4]/70"
                      : "rounded-none border border-[#fcee0a]/50 bg-zinc-950/60 backdrop-blur-md focus:border-[#fcee0a]/80"
                  : "rounded-lg border border-zinc-800 bg-zinc-900/60 focus:border-brand-500/60",
              )}
            />
            {query && (
              <button
                onClick={() => setQuery("")}
                title={t("Clear (Esc)")}
                className={cn(
                  "absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 transition-colors",
                  // white where grey would disappear, hover brightens the plate
                  irid
                    ? "text-white hover:bg-white/15"
                    : "text-zinc-500 hover:bg-white/10 hover:text-zinc-200",
                )}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>

          <div
            className={cn(
              "flex items-center gap-2.5 px-3 py-1.5 text-sm",
              premiumAccent
                ? cn(
                    "border shadow-lg shadow-black/25 backdrop-blur-md",
                    accent === "iridescent"
                      ? "rounded-lg border-white/15 bg-zinc-900/55 text-zinc-100"
                      : accent === "sakura"
                        ? "rounded-lg border-[#f9a8d4]/30 bg-zinc-900/50 text-zinc-100"
                        : "rounded-none border-[#fcee0a]/50 bg-zinc-950/60 text-zinc-100",
                  )
                : "rounded-lg text-zinc-400",
            )}
            title={t("Simple mode — hide the explanatory text, keep only headings and controls")}
          >
            <span>{t("Simple Mode")}</span>
            <Toggle checked={concise} onChange={setConcise} />
          </div>
        </div>
      }
    >
      {/* no top padding, the toolbar gives the gap */}
      {/* data-drop-block: nothing to import into here */}
      <div
        className="settings-body mx-auto max-w-5xl px-6 pb-6"
        data-concise={concise ? "1" : undefined}
        data-drop-block=""
      >
        <div className="flex gap-6">
        {/* quick links + the installed version below, sticky, hidden on narrow windows */}
        <div className="sticky top-4 hidden h-fit w-52 shrink-0 space-y-3 lg:block">
        <nav className="rounded-2xl border border-white/10 bg-zinc-900/55 p-2 shadow-xl shadow-black/20 backdrop-blur-lg">
          {shown.length === 0 ? (
            <p className="px-2.5 py-1.5 text-sm text-zinc-500">{t("No matches")}</p>
          ) : (
            <ul className="space-y-0.5">
              {shown.map((s) => (
                <li key={s.id}>
                  <button
                    onClick={() => goTo(s.id)}
                    title={t(s.label)}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm transition-colors",
                      activeId === s.id
                        ? "bg-white/10 font-medium text-zinc-100"
                        : "text-zinc-400 hover:bg-white/5 hover:text-zinc-200",
                    )}
                  >
                    <s.Icon className="h-4 w-4 shrink-0" />
                    <span className="truncate">{t(s.label)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </nav>
        {/* the installed version at a glance, a click jumps to Version */}
        <button
          onClick={() => goTo("version")}
          title={t("Version")}
          className="settings-version flex w-full items-baseline justify-between gap-2 rounded-2xl border border-white/10 bg-zinc-900/55 px-4 py-3 text-left shadow-xl shadow-black/20 backdrop-blur-lg transition-colors hover:bg-zinc-900/70"
        >
          <span className="settings-title text-sm font-bold tracking-tight text-zinc-50">MiColl</span>
          <span className="font-mono text-xs text-zinc-400">v{appVersion}</span>
        </button>
        </div>

        <div className="min-w-0 flex-1 space-y-6">
        {searching && shown.length === 0 && (
          <div className={cn(glass, "text-center text-sm text-zinc-400")}>
            No settings match “{query.trim()}”.
          </div>
        )}
        {/* appearance */}
        {(
        <section id="appearance" className={cn(glass, "scroll-mt-4")}>
        <h1 className="flex items-center gap-2 settings-title text-2xl font-bold tracking-tight text-zinc-50">
          <Palette className="h-6 w-6 text-brand-300" />
          {t("Appearance")}
        </h1>
        <p className="settings-desc mt-1 text-sm text-zinc-400">
          {t("Pick an accent color — it recolors the whole app instantly.")}
        </p>
        {/* the basic accents get their own box too, like the pack below */}
        <div className={cn("mt-4 flex flex-wrap gap-3", cardInner, "p-3")}>
          {ACCENTS.filter((a) => a.tier === "basic").map(renderSwatch)}
        </div>
        {/* The premium themes are sold together, so they're one box with their name,
            unlock button and license plate. A second pack would be another box. */}
        {THEME_PACKS.map((pack) => (
        <div
          key={pack.id}
          className={cn(
            "mt-6 rounded-xl border p-3",
            irid ? iriInner : "border-yellow-300/20 bg-yellow-300/[0.03]",
          )}
        >
        <div className="mb-3">
        <div className="flex items-center gap-3">
          <span className="text-xs font-bold uppercase tracking-widest text-yellow-300 [text-shadow:0_0_10px_rgba(250,204,21,0.85)]">
            ✦ {pack.name}
          </span>
          <BetaTag />
          <div className="h-px flex-1 bg-gradient-to-r from-yellow-300/40 to-transparent" />
          <button
            onClick={() => {
              setPendingAccent(null);
              setUnlockOpen(true);
            }}
            className={`rounded-full border px-3 py-1 text-xs transition-colors ${
              premium
                ? "border-emerald-400/30 text-emerald-300/90 hover:bg-emerald-500/10"
                : "border-yellow-300/40 text-yellow-200 hover:bg-yellow-300/10"
            }`}
          >
            {premium ? t("Unlocked ✓") : SALES_OPEN ? t("Unlock — $5") : t("Unlock — coming soon")}
          </button>
        </div>
        </div>
        <div className="flex flex-wrap items-stretch gap-3">
          {ACCENTS.filter((a) => pack.accents.includes(a.key)).map(renderSwatch)}
          {premium && licensee && (
            /* ml-auto puts it at the right end of the row. Square so it reads like a plate,
               not a button. */
            /* iridescent: dark ink plate + pastel sheen on top, otherwise the text was
               unreadable
               over the bright wallpaper */
            <div
              className={cn(
                "ml-auto border border-l-2",
                // one line, each premium theme has its own plate class
                platePremium
                  ? "flex max-w-[22rem] items-center gap-2.5 px-4 py-2.5 backdrop-blur-md"
                  : "flex max-w-[16rem] flex-col justify-center border-white/10 px-3 py-1.5",
                irid && "iri-licence border-white/20",
                sak && "sak-licence border-[#f9a8d4]/30",
                cyber && "cp-licence border-[#fcee0a]/40",
              )}
              // each premium theme: dark ink plate + a wash in its color (the ink keeps the
              // text readable)
              style={
                irid
                  ? {
                      borderLeftColor: "#B5B0E8",
                      // sheen on top, ink below
                      background:
                        "linear-gradient(100deg, rgba(181,176,232,0.20), rgba(156,203,240,0.12) 55%, rgba(255,255,255,0.04)), linear-gradient(rgba(26,22,52,0.70), rgba(26,22,52,0.70))",
                      boxShadow: "inset 0 1px 0 rgba(255,255,255,0.16)",
                    }
                  : sak
                    ? {
                        borderLeftColor: "#F9A8D4",
                        background:
                          "linear-gradient(100deg, rgba(249,168,212,0.22), rgba(255,214,233,0.10) 60%, rgba(255,255,255,0.03)), linear-gradient(rgba(42,20,33,0.72), rgba(42,20,33,0.72))",
                        boxShadow: "inset 0 1px 0 rgba(255,236,245,0.18)",
                      }
                    : cyber
                      ? {
                          borderLeftColor: "#FCEE0A",
                          background:
                            "linear-gradient(100deg, rgba(252,238,10,0.14), rgba(0,229,255,0.10) 62%, transparent), linear-gradient(rgba(6,8,14,0.80), rgba(6,8,14,0.80))",
                          boxShadow:
                            "inset 0 0 0 1px rgba(252,238,10,0.14), inset 0 0 8px rgba(0,229,255,0.12)",
                        }
                      : {
                          borderLeftColor: "var(--color-brand-500)",
                          background:
                            "linear-gradient(100deg, color-mix(in srgb, var(--color-brand-500) 16%, transparent), transparent 85%)",
                        }
              }
            >
              <span
                className={cn(
                  "shrink-0 text-[9px] font-semibold uppercase leading-none tracking-[0.18em]",
                  irid ? "text-white/70" : sak ? "text-[#ffd6e8]/80" : cyber ? "text-[#fcee0a]/80" : "text-zinc-500",
                )}
              >
                {trialUntil ? tf("Test key — until {date}", { date: trialUntil }) : t("Licensed to")}
              </span>
              {/* engraved line between label and name */}
              {platePremium && (
                <span
                  aria-hidden
                  className={cn(
                    "h-3.5 w-px shrink-0",
                    irid ? "bg-white/25" : sak ? "bg-[#ffd6e8]/30" : "bg-[#fcee0a]/35",
                  )}
                />
              )}
              <span
                className={cn(
                  "truncate font-semibold leading-none",
                  irid
                    ? "text-sm tracking-[0.06em] text-white"
                    : sak
                      ? "text-sm tracking-[0.06em] text-[#fff2f8]"
                      : cyber
                        ? "font-mono text-sm uppercase tracking-[0.08em] text-[#eaffff]"
                        : "mt-1.5 text-[13px] tracking-wide text-zinc-100",
                )}
              >
                {licensee}
              </span>
            </div>
          )}
        </div>
        </div>
        ))}
        <div className={cn("mt-4 flex items-center justify-between gap-3", cardInner, !fxLive && "opacity-60")}>
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-zinc-100">{t("Animated background")}</h2>
            <p className="settings-desc mt-0.5 text-sm text-zinc-400">
              {t(
                "The flowing premium backdrop (iridescent foil, cyberpunk, sakura) is rendered live and can be CPU-heavy without GPU acceleration. Turn it off for a static gradient and lower CPU use.",
              )}
              {!fxLive && <span className="text-zinc-500"> {fxHint}.</span>}
            </p>
          </div>
          <Toggle
            checked={animatedBg}
            onChange={toggleAnimatedBg}
            disabled={!fxLive}
            title={fxHint}
          />
        </div>
        {/* classic accents only: the sand/crystal backdrop and glassier surfaces.
            Off = the old look, untouched. */}
        {!fxLive && (
          <div className={cn("mt-3 flex items-center justify-between gap-3", cardInner)}>
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-zinc-100">{t("Premium look")}</h2>
              <p className="settings-desc mt-0.5 text-sm text-zinc-400">
                {t(
                  "A sand-grain backdrop with crystal glints and glassier panels, cards and header for the classic themes. Turn it off for the plain look.",
                )}
              </p>
            </div>
            <Toggle checked={classicLuxe} onChange={toggleClassicLuxe} />
          </div>
        )}
        {/* custom wallpaper with a dark veil */}
        <div className={cn("mt-3", cardInner)}>
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-zinc-100">{t("Wallpaper")}</h2>
              <p className="settings-desc mt-0.5 text-sm text-zinc-400">
                {t(
                  "Use your own picture as the background of the whole app, instead of the theme’s. It stays where it is on disk — MiColl only remembers where to find it.",
                )}
                {!backed && <span className="text-zinc-500"> {t("Picking a file needs the desktop app.")}</span>}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {/* the theme's own stills as a dropdown (our own menu, not a native select) */}
              {themeWalls.list.length > 0 && (
                <button
                  onClick={(e) =>
                    openMenu(
                      e,
                      themeWalls.list.map((p) => {
                        // every preset saves its own id, empty = the theme default
                        const value = `${WALLPAPER_PRESET_PREFIX}${p.id}`;
                        const current =
                          wallpaper === value ||
                          (!wallpaper && p.id === themeWalls.fallback);
                        return {
                          label: t(p.label),
                          hint: current ? "Current" : undefined,
                          icon: current ? (
                            <Check className="h-4 w-4" />
                          ) : (
                            <ImageIcon className="h-4 w-4" />
                          ),
                          onClick: () => changeWallpaper(value),
                        };
                      }),
                    )
                  }
                  title={t(
                    cyber
                      ? "The cyberpunk theme’s own backgrounds"
                      : sak
                        ? "The sakura theme’s own backgrounds"
                        : "The iridescent theme’s own backgrounds",
                  )}
                  className={cn(
                    "flex h-9 items-center gap-2 rounded-lg border border-zinc-800 px-3 text-sm font-medium transition-colors",
                    "appearance-chip",
                    dlg.menuRow,
                  )}
                >
                  {presetLabel}
                  <ChevronDown className="h-4 w-4 opacity-70" />
                </button>
              )}
              <Button variant="outline" onClick={() => void pickWallpaper()} disabled={!backed}>
                <ImageIcon className="h-4 w-4" />
                {t("Custom")}
              </Button>
              {/* Reset only for a custom picture */}
              {wallpaper && !isWallpaperPreset(wallpaper) && (
                <Button variant="ghost" onClick={() => changeWallpaper("")} title={t("Back to the theme’s background")}>
                  <X className="h-4 w-4" />
                  {t("Reset")}
                </Button>
              )}
            </div>
          </div>
          {/* the path, only for a custom picture */}
          {wallpaper && !isWallpaperPreset(wallpaper) && (
            <p className="mt-2 truncate font-mono text-xs text-zinc-500" title={wallpaper}>
              {wallpaper}
            </p>
          )}

          <div className="mt-4 flex items-center justify-between gap-3">
            <h2 className="text-sm font-semibold text-zinc-100">{t("Dim")}</h2>
            <span
              className={cn(
                "shrink-0 rounded-md px-2 py-1 text-xs font-medium tabular-nums",
                irid
                  ? "bg-white/15 text-white ring-1 ring-inset ring-white/25"
                  : "bg-zinc-800 text-zinc-200",
              )}
            >
              {wallDim === 0 ? t("Off") : `${wallDim}%`}
            </span>
          </div>
          <p className="settings-desc mt-0.5 text-sm text-zinc-400">
            {tf(
              "Darkens the background so cards and text stay readable over a bright picture. Stops at {max}% — past that there’d be nothing left to see.",
              { max: MAX_DIM },
            )}
          </p>
          <input
            type="range"
            min={0}
            max={MAX_DIM}
            step={5}
            value={wallDim}
            onChange={(e) => changeWallDim(Number(e.target.value))}
            className={cn("mt-3 w-full", rangeClass)}
          />
          <div
            className={cn(
              "flex justify-between text-[10px] font-medium uppercase tracking-wide",
              irid ? "text-white/75" : "text-zinc-600",
            )}
          >
            <span>{t("Off")}</span>
            <span>{t("Subtle")}</span>
            <span>{t("Dark")}</span>
          </div>
        </div>
        <div className={cn("mt-3 flex items-center justify-between gap-3", cardInner, !fxLive && "opacity-60")}>
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-zinc-100">{t("Animations")}</h2>
            <p className="settings-desc mt-0.5 text-sm text-zinc-400">
              {t(
                "All decorative motion: the premium card holo / sparkle / glitch, theme shimmer, and the floating class icons (♥, stars, …) on hover. Turn off for a calmer, lighter UI — the animated background has its own toggle above.",
              )}
              {!fxLive && <span className="text-zinc-500"> {fxHint}.</span>}
            </p>
          </div>
          <Toggle checked={cardFx} onChange={toggleCardFx} disabled={!fxLive} title={fxHint} />
        </div>
        {/* holo frequency moved to Performance */}
        {/* class icon visibility (0% removes it) */}
        <div className={cn("mt-3", cardInner)}>
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-zinc-100">{t("Class icons")}</h2>
              <p className="settings-desc mt-0.5 text-sm text-zinc-400">
                How strongly the class icon (♥, star, …) shows in the corner of a creator card.
                Lower values let it sit quietly over a busy cover; 0% hides it completely. The
                class itself is unaffected — sorting, filtering and the right-click menu keep
                working.
              </p>
            </div>
            <span
              className={cn(
                "shrink-0 rounded-md px-2 py-1 text-xs font-medium tabular-nums",
                irid
                  ? "bg-white/15 text-white ring-1 ring-inset ring-white/25"
                  : "bg-zinc-800 text-zinc-200",
              )}
            >
              {classIcons === 0 ? "Hidden" : `${classIcons}%`}
            </span>
          </div>
          <input
            type="range"
            min={0}
            max={100}
            step={5}
            value={classIcons}
            onChange={(e) => changeClassIcons(Number(e.target.value))}
            className={cn("mt-3 w-full", rangeClass)}
          />
          <div
            className={cn(
              "flex justify-between text-[10px] font-medium uppercase tracking-wide",
              irid ? "text-white/75" : "text-zinc-600",
            )}
          >
            <span>{t("Hidden")}</span>
            <span>{t("Faint")}</span>
            <span>{t("Full")}</span>
          </div>
        </div>
        {/* app icon (taskbar) */}
        <div className={cn("mt-3", cardInner)}>
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-zinc-100">{t("App icon")}</h2>
            <p className="settings-desc mt-0.5 text-sm text-zinc-400">
              The icon on MiColl’s taskbar button and title bar. Left on “Match theme” it
              follows the accent, so the taskbar changes colour with the app; pick one to pin
              it instead. The three premium artworks belong to the premium themes and unlock
              with them. The pinned shortcut and the installed program keep the icon they were
              built with — that one isn’t MiColl’s to change while it’s running.
            </p>
          </div>
          {/* one row that scrolls sideways, negative margin so the selected glow isn't
              clipped */}
          <div className="-mx-1 mt-3 flex gap-2 overflow-x-auto px-1 pb-1.5">
            {/* the first tile shows what the accent would give */}
            {[{ key: "auto" as const, label: t("Match theme"), url: autoAppIcon().url }, ...APP_ICONS].map(
              (opt, i) => {
                const on = appIcon === opt.key;
                // premium icons without license: shown but not selectable
                const locked = "premium" in opt && opt.premium === true && !premium;
                return (
                  <button
                    key={opt.key}
                    onClick={() => (locked ? setUnlockOpen(true) : setAppIconChoice(opt.key))}
                    title={
                      locked
                        ? tf("{name} — unlocks with the premium themes", { name: t(opt.label) })
                        : i === 0
                          ? t("Follow the accent — the icon changes with the theme")
                          : tf("Always use the {name} icon", { name: t(opt.label) })
                    }
                    aria-pressed={on}
                    className={cn(
                      // shrink-0 so the row can scroll
                      "relative flex w-[6.5rem] shrink-0 flex-col items-center gap-1.5 px-2 py-2.5 transition-colors",
                      dlg.field,
                      // selected = colored edge (index.css), the artwork stays readable
                      on ? "pick-on text-white" : cn("appearance-chip", dlg.menuRow),
                    )}
                  >
                    <img
                      src={opt.url}
                      alt=""
                      draggable={false}
                      className={cn(
                        "h-10 w-10 object-contain",
                        i === 0 && "opacity-90",
                        locked && "opacity-40 grayscale",
                      )}
                    />
                    <span
                      className={cn(
                        "flex w-full items-center justify-center gap-1 truncate text-center text-[11px] font-medium",
                        locked && "text-zinc-500",
                      )}
                    >
                      {locked && <Lock className="h-3 w-3 shrink-0" />}
                      {t(opt.label)}
                    </span>
                  </button>
                );
              },
            )}
          </div>
        </div>

        {/* card shape per page type, each button previews the ratio */}
        <div className={cn("mt-3", cardInner)}>
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-zinc-100">{t("Card shapes")}</h2>
              <p className="settings-desc mt-0.5 text-sm text-zinc-400">
                {t(
                  "The shape of the reward tiles in each grid. Square fits the most on screen but crops every cover to its middle; the taller shapes keep more of a standing figure, and Banner suits landscape art. Each place is set on its own — a creator page mixes rewards in among year and month cards, so a flatter shape works there while a month page can go tall. The dashboard’s creator cards are always 4 : 6. How wide the cards are stays on Ctrl+wheel over the grid itself.",
                )}
              </p>
            </div>
            <button
              onClick={resetTileShapes}
              title={t("Back to the defaults: Square on a creator page, Poster on a month page")}
              className={cn(
                "appearance-chip flex shrink-0 items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-zinc-300 transition-colors",
                dlg.field,
                dlg.menuRow,
              )}
            >
              <RotateCcw className="h-3.5 w-3.5" />
              {t("Reset")}
            </button>
          </div>
          {TILE_SCOPES.map((scope) => (
            <div key={scope.key} className="mt-3">
              <div
                className={cn(
                  "text-[11px] font-semibold uppercase tracking-wide",
                  irid ? "text-white/75" : "text-zinc-400",
                )}
                title={t(scope.hint)}
              >
                {t(scope.label)}
              </div>
              {/* 5 fixed columns, never wrapping */}
              <div className="mt-1.5 grid grid-cols-5 gap-2">
                {TILE_SHAPES.map((s) => {
                  const on = s.key === tileShapes[scope.key];
                  return (
                    <button
                      key={s.key}
                      onClick={() => changeTileShape(scope.key, s.key)}
                      title={s.hint}
                      aria-pressed={on}
                      className={cn(
                        "flex min-w-0 items-center gap-2 px-2.5 py-2 text-left transition-colors",
                        dlg.field,
                        on
                          ? // Iridescent: the colour rides the edge, not the fill
                            // (`.pick-on`) — the same choice the app-icon picker
                            // already made, and for the same reason. A filled
                            // pastel here lands on a pastel wash and the little
                            // ratio preview inside, which is the whole point of the
                            // button, goes with it.
                            irid
                            ? "pick-on text-white"
                            : (dlg.primary ?? "border-transparent bg-brand-500 text-white")
                          : cn("appearance-chip", dlg.menuRow),
                      )}
                    >
                      <span
                        className={cn(
                          "w-4 shrink-0 rounded-[3px] border",
                          s.aspect,
                          on
                            ? // Unfilled on iridescent: the button is no longer a
                              // solid block, so a dark wash inside the preview would
                              // be the only heavy thing on the row.
                              irid
                              ? "border-current bg-white/20"
                              : "border-current bg-black/15"
                            : "border-zinc-500 bg-zinc-700/60",
                        )}
                      />
                      <span className="min-w-0">
                        <span className="block truncate text-[13px] font-semibold">{t(s.label)}</span>
                        <span
                          className={cn(
                            "block text-[11px] tabular-nums",
                            on ? "opacity-70" : "text-zinc-400",
                          )}
                        >
                          {s.ratio}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
        <div className={cn("mt-3 flex items-center justify-between gap-3", cardInner)}>
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-zinc-100">{t("Open rewards in the overview")}</h2>
            <p className="settings-desc mt-0.5 text-sm text-zinc-400">
              {t(
                "Going into a reward shows every file as a tile first — the way Explorer shows a folder — and you pick which one to open. Off by default: a reward opens on its first picture, full size. Either way the viewer’s overview button (or G) switches between the two whenever you like, without changing this.",
              )}
            </p>
          </div>
          <Toggle checked={viewerGrid} onChange={toggleViewerGrid} />
        </div>
        <div className={cn("mt-3 flex items-center justify-between gap-3", cardInner)}>
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-zinc-100">{t("Hide creator names")}</h2>
            <p className="settings-desc mt-0.5 text-sm text-zinc-400">
              {t(
                "Creator cards show no name until you hover over them — handy for discreet browsing or screen-sharing.",
              )}
            </p>
          </div>
          <Toggle checked={hideNames} onChange={toggleHideNames} />
        </div>
        {/* name size on the creator cards, 7 steps, 4 = the tuned size */}
        <div className={cn("mt-3", cardInner)}>
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-zinc-100">
                {t("Name size on creator cards")}
              </h2>
              <p className="settings-desc mt-0.5 text-sm text-zinc-400">
                {t(
                  "How big the creator’s name is on the dashboard cards, in seven steps. 4 is the standard size; long names still shrink to fit.",
                )}
              </p>
            </div>
            <span
              className={cn(
                "shrink-0 rounded-md px-2 py-1 text-xs font-medium tabular-nums",
                irid
                  ? "bg-white/15 text-white ring-1 ring-inset ring-white/25"
                  : "bg-zinc-800 text-zinc-200",
              )}
            >
              {nameSize} / {CARD_NAME_MAX}
            </span>
          </div>
          <input
            type="range"
            min={CARD_NAME_MIN}
            max={CARD_NAME_MAX}
            step={1}
            value={nameSize}
            onChange={(e) => changeNameSize(Number(e.target.value))}
            className={cn("mt-3 w-full", rangeClass)}
          />
          <div
            className={cn(
              "flex justify-between text-[10px] font-medium uppercase tracking-wide",
              irid ? "text-white/75" : "text-zinc-600",
            )}
          >
            <span>{t("Very small")}</span>
            <span>{t("Default")}</span>
            <span>{t("Very large")}</span>
          </div>
        </div>
        <div className={cn("mt-3 flex items-center justify-between gap-3", cardInner)}>
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-zinc-100">{t("Hide add button on creator cards")}</h2>
            <p className="settings-desc mt-0.5 text-sm text-zinc-400">
              {t(
                "The plus (“+”) that appears in a card’s corner on hover and opens a folder picker. Turn this on for a cleaner cover — dropping a folder or an archive straight onto the card adds rewards just the same.",
              )}
            </p>
          </div>
          <Toggle checked={!cardPlus} onChange={toggleHidePlus} />
        </div>
        <div className={cn("mt-3 flex items-center justify-between gap-3", cardInner)}>
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-zinc-100">
              {t("Platforms and reward count on cards")}
            </h2>
            <p className="settings-desc mt-0.5 text-sm text-zinc-400">
              {t(
                "The row that slides up under a creator’s name on hover — their platform logos and how many rewards you have. Turn it off to hide it and keep the cover clean; the name then sits a little lower and the shading behind it is lighter. Everything it says is on the creator’s own page anyway.",
              )}
            </p>
          </div>
          <Toggle checked={cardMeta} onChange={toggleCardMeta} />
        </div>
        <div className={cn("mt-3 flex items-center justify-between gap-3", cardInner)}>
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-zinc-100">{t("Show hidden creators")}</h2>
            <p className="settings-desc mt-0.5 text-sm text-zinc-400">
              {t(
                "Right-clicking a creator card offers Hide creator, which takes it off the dashboard for good — nothing is deleted, and it stays hidden after a restart. Turn this on to put those cards back in the grid, faded, so you can open them or right-click to bring one back permanently.",
              )}{" "}
              {hiddenCreators === 0
                ? t("Nothing is hidden right now.")
                : tf("{n} creators are hidden.", { n: hiddenCreators })}{" "}
              {t("The same switch sits on the settings gear’s right-click menu.")}
            </p>
          </div>
          <Toggle checked={showHidden} onChange={toggleShowHiddenRow} />
        </div>
        {/* it's visible right above the page */}
        {backed && (
          <div className={cn("mt-3 flex items-center justify-between gap-3", cardInner)}>
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-zinc-100">
                {t("One window button instead of two")}
              </h2>
              <p className="settings-desc mt-0.5 text-sm text-zinc-400">
                {t(
                  "The top right corner carries the two buttons every window has: minimize, then close, each doing what its icon says the moment you click it. Turn this on to fold them into a single button — one click runs your default, a double-click runs the other one, and right-clicking it chooses which way round. Off by default: the combined button has to wait a moment on every click in case a second one follows, and a button that means two things has to be learned first.",
                )}
              </p>
            </div>
            <Toggle checked={winButtons === "one"} onChange={toggleWinButtons} />
          </div>
        )}
        {/* "Optimize large images" and "Play GIFs" moved to Performance */}
        </section>
        )}

        {/* performance */}
        {(
          <section id="performance" className={cn(glass, "scroll-mt-4")}>
            <h1 className="settings-title mb-4 flex items-center gap-2 text-2xl font-bold tracking-tight text-zinc-50">
              <Activity className="h-6 w-6 text-brand-300" />
              {t("Performance")}
            </h1>
            {/* dropdown next to the heading, the selected hint is shown below */}
            <div className={cn("flex items-center justify-between gap-3", cardInner)}>
              <div className="min-w-0">
                <h2 className="text-sm font-semibold text-zinc-100">
                  {t("Pause animations when MiColl is in the background")}
                </h2>
                <p className="settings-desc mt-0.5 text-sm text-zinc-400">
                  {t(
                    "The moving parts — the wallpaper, the card effects, the shimmer — are what keep the window busy, and they cost the same whether or not anyone is watching them. This turns them off while MiColl is out of the way, exactly like the Animations switch under Appearance, and turns them back on the moment you come back. Nothing about how the app looks in use changes.",
                  )}
                </p>
                <p className="mt-1 text-xs text-zinc-500">
                  {t(IDLE_PAUSE_OPTIONS.find(([v]) => v === idlePause)?.[2] ?? "")}
                </p>
              </div>
              <ThemedSelect
                value={idlePause}
                onChange={(v) => changeIdlePause(v as IdlePause)}
                options={IDLE_PAUSE_OPTIONS.map(([value, label]) => ({ value, label: t(label) }))}
                title={t("When to pause the animations")}
                ink="text-zinc-100"
                className={cn("h-9 w-44 shrink-0 px-3 text-sm", dlg.field)}
                minWidth={176}
              />
            </div>

            {/* next to the pause setting, both are about MiColl in the background */}
            {backed && (
              <div className={cn("mt-3 flex items-center justify-between gap-3", cardInner)}>
                <div className="min-w-0">
                  <h2 className="text-sm font-semibold text-zinc-100">{t("Keep running in the tray")}</h2>
                  <p className="settings-desc mt-0.5 text-sm text-zinc-400">
                    {t(
                      "The window button at the top right hides MiColl instead of quitting it, and the app keeps running behind a small icon in the notification area — Windows tucks that under the chevron next to the clock unless you drag it out. Click the icon to come back, or right-click it to quit for real. Off by default: with it off, closing the window ends the program and nothing sits in the tray.",
                    )}
                  </p>
                </div>
                <Toggle checked={closeToTray} onChange={toggleCloseToTray} />
              </div>
            )}

            <div className={cn("mt-3 flex items-center justify-between gap-3", cardInner)}>
              <div className="min-w-0">
                <h2 className="text-sm font-semibold text-zinc-100">{t("Play GIFs")}</h2>
                <p className="settings-desc mt-0.5 text-sm text-zinc-400">
                  {t(
                    "Animated GIFs play and loop — including when a GIF is used as a card cover. A looping GIF is the one animation the pause above can’t reach, so turn this off if your covers are mostly animated. Off shows a still first frame instead.",
                  )}
                </p>
              </div>
              <Toggle checked={playGifs} onChange={togglePlayGifs} />
            </div>

            {/* holo frequency (rarer = quieter fans) */}
            <div className={cn("mt-3", cardInner, !fxLive && "opacity-60")}>
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <h2 className="text-sm font-semibold text-zinc-100">{t("Holo frequency")}</h2>
                  <p className="settings-desc mt-0.5 text-sm text-zinc-400">
                    {t(
                      "How often the iridescent creator cards play their holographic glint. The two lowest levels also freeze the always-on shimmer loops (card borders, month auras, band drift) — that’s the big fan-saver.",
                    )}
                    {!fxLive && <span className="text-zinc-500"> {fxHint}.</span>}
                  </p>
                </div>
                <span
                  className={cn(
                    "shrink-0 rounded-md px-2 py-1 text-xs font-medium",
                    irid
                      ? "bg-white/15 text-white ring-1 ring-inset ring-white/25"
                      : "bg-zinc-800 text-zinc-200",
                  )}
                >
                  {t(HOLO_FREQ_LABELS[holoFreq])}
                </span>
              </div>
              <input
                type="range"
                min={1}
                max={5}
                step={1}
                value={holoFreq}
                onChange={(e) => changeHoloFreq(Number(e.target.value) as HoloFreq)}
                disabled={!fxLive || !cardFx}
                title={fxHint ?? (!cardFx ? t("Animations are turned off under Appearance") : undefined)}
                className={cn("mt-3 w-full disabled:opacity-40", rangeClass)}
              />
              <div
                className={cn(
                  "flex justify-between text-[10px] font-medium uppercase tracking-wide",
                  irid ? "text-white/75" : "text-zinc-600",
                )}
              >
                <span>{t("Rare")}</span>
                <span>{t("Normal")}</span>
                <span>{t("Frequent")}</span>
              </div>
            </div>

            {/* frosted buttons (iridescent only) */}
            {irid && (
              <div className={cn("mt-3 flex items-center justify-between gap-3", cardInner)}>
                <div className="min-w-0">
                  <h2 className="text-sm font-semibold text-zinc-100">{t("Frosted buttons")}</h2>
                  <p className="settings-desc mt-0.5 text-sm text-zinc-400">
                    Blurs the wallpaper behind the small pills (Import folder, + Platform,
                    Break…). Off by default: the bars they sit in are already frosted, and
                    blurring on top of that can draw a thin dark line down a button&apos;s
                    edge — which one, and whether at all, shifts with the window size. Turn
                    it on if you prefer the look and don&apos;t see the line.
                  </p>
                </div>
                <Toggle checked={glassButtons} onChange={toggleGlassButtons} />
              </div>
            )}

            <div className={cn("mt-3 flex items-center justify-between gap-3", cardInner)}>
              <div className="min-w-0">
                <h2 className="text-sm font-semibold text-zinc-100">{t("Optimize large images")}</h2>
                <p className="settings-desc mt-0.5 text-sm text-zinc-400">
                  Very large images (over 3000&nbsp;px on both sides, e.g. 5000×8000) can make the
                  viewer scroll slowly and load slowly. When on, the viewer shows a lighter
                  downscaled preview of only those images — the original files are never resized
                  or modified.
                </p>
              </div>
              <Toggle checked={optimizeLarge} onChange={toggleOptimizeLarge} />
            </div>

            {/* the renderer (software = shader on the CPU) */}
            <div className={cn("mt-3", cardInner)}>
              <div className="min-w-0">
                <h2 className="text-sm font-semibold text-zinc-100">{t("Graphics")}</h2>
                <p className="settings-desc mt-0.5 text-sm text-zinc-400">
                  {gpu.unavailable ? (
                    <>
                      {t(
                        "This machine gives MiColl no WebGL at all. The iridescent wallpaper and the card holo can’t draw, so they quietly don’t — everything else works normally.",
                      )}
                    </>
                  ) : gpu.software ? (
                    <>
                      <span className="font-medium text-amber-300">
                        {t("No GPU acceleration — drawing in software.")}
                      </span>{" "}
                      {t(
                        "Every effect is being rendered by the processor, which is why MiColl can sit at several percent doing nothing. Turning Animated background off under Appearance is the single biggest saving here; updating the graphics driver is the real fix.",
                      )}
                    </>
                  ) : (
                    <>
                      {t(
                        "The effects are drawn by the graphics card, which is the cheap case. If MiColl still feels heavy, Animated background under Appearance is the largest single cost.",
                      )}
                    </>
                  )}
                </p>
                <p className="mt-1.5 break-words font-mono text-xs text-zinc-500">{gpu.renderer}</p>
              </div>
            </div>
          </section>
        )}

        {/* content mode (SFW/NSFW) */}
        {(
          <section id="content" className={cn(glass, "scroll-mt-4")}>
            <ContentPanel />
          </section>
        )}

        {(
          <div id="platforms" className="scroll-mt-4">
            <PlatformSettings glass={glass} irid={irid} iriInner={iriInner} />
          </div>
        )}

        {backed && (
          <section id="templates" className={cn(glass, "scroll-mt-4")}>
            <TemplatesPanel
              backed={backed}
              managed={managed}
              collectionRoot={collectionRoot}
              onApplied={refresh}
            />
          </section>
        )}

        {(
        <section id="library" className={cn(glass, "scroll-mt-4")}>
        <h1 className="flex items-center gap-2 settings-title text-2xl font-bold tracking-tight text-zinc-50">
          <FolderOpen className="h-6 w-6 text-brand-300" />
          {t("Library")}
        </h1>
        <p className="settings-desc mt-1 text-sm text-zinc-400">
          {managed
            ? t(
                "Managed mode is on — content lives in your MiColl collection. Adding new content moves it into the collection automatically.",
              )
            : t(
                "MiColl reads your folders directly and never moves your files. Point them at any disk — your rewards can live wherever you like.",
              )}
        </p>

        {!backed ? (
          <div className={cn("mt-6 rounded-xl border border-dashed p-6 text-center text-sm", irid ? iriDashed + " text-white/80" : "border-zinc-800 bg-zinc-900/40 text-zinc-400")}>
            {t("Library management runs in the desktop app. Launch MiColl with")}{" "}
            <code className={cn(codeChip, "px-1.5 py-0.5")}>npm run tauri dev</code>
            {/* the space is part of the string (German continues with a comma) */}
            {t(" to add folders and index real content.")}
          </div>
        ) : (
          <>
            <div className="mt-6 flex items-center gap-2">
              {/* only unmanaged mode ("Add folder"), managed mode uses Import folder / drag
                  and drop */}
              {!managed && (
                <Button variant="primary" onClick={chooseFolder} disabled={busy}>
                  <FolderPlus className={`h-4 w-4 ${busy ? "animate-pulse" : ""}`} />
                  {busy ? t("Scanning…") : t("Add folder")}
                </Button>
              )}
              {!managed && (
                <Button variant="outline" onClick={doRescan} disabled={busy || roots.length === 0}>
                  <RefreshCw className={`h-4 w-4 ${busy ? "animate-spin" : ""}`} />
                  {t("Rescan all")}
                </Button>
              )}
              {managed && (
                <Button
                  variant="outline"
                  onClick={doRescanCollection}
                  disabled={busy || !collectionRoot}
                  title={t("Re-index every creator folder in your MiColl collection")}
                >
                  <RefreshCw className={`h-4 w-4 ${busy ? "animate-spin" : ""}`} />
                  {t("Rescan collection")}
                </Button>
              )}
              <Button
                variant="outline"
                onClick={() => setHealthOpen(true)}
                disabled={busy}
                title={t("Find missing files and re-link moved folders")}
              >
                <Activity className="h-4 w-4" />
                {t("Library health")}
              </Button>
              <Button
                variant="outline"
                onClick={async () => {
                  await resetAllWarnings();
                  setStatus("All warnings reset — dismissed prompts will show again.");
                }}
                disabled={busy}
                title={t("Re-enable every “don’t show again” warning")}
              >
                <BellRing className="h-4 w-4" />
                {t("Reset warnings")}
              </Button>
              <Button
                variant="outline"
                onClick={() => setConfirmCovers(true)}
                disabled={busy}
                title={t("Covers whose image file is gone go back to the automatic image")}
              >
                <RotateCcw className="h-4 w-4" />
                {t("Reset missing covers")}
              </Button>
              <Button
                variant="ghost"
                onClick={() => setConfirmClear(true)}
                disabled={busy}
                className="ml-auto text-rose-300 hover:bg-rose-500/10 hover:text-rose-200"
              >
                <Trash2 className="h-4 w-4" />
                {t("Clear library")}
              </Button>
            </div>

            {status && <p className="mt-3 text-sm text-brand-300">{status}</p>}

            <div className={cn("mt-6 flex items-center justify-between gap-3", cardInner)}>
              <div className="min-w-0">
                <h2 className="text-sm font-semibold text-zinc-100">
                  {t("Drop the creator’s name from imported rewards")}
                </h2>
                <p className="settings-desc mt-0.5 text-sm text-zinc-400">
                  {t("Content often arrives named")}{" "}
                  <code className={cn(codeChip, "px-1 py-0.5")}>
                    [Creator] - [Reward]
                  </code>
                  {t(
                    ". MiColl already reads the creator out of that and files the import under them, so the name says it twice. With this on the creator part is removed from the reward name — brackets and the dash joining them included — leaving",
                  )}{" "}
                  <code className={cn(codeChip, "px-1 py-0.5")}>[Reward]</code>
                  {t(
                    ", which is also what the folder ends up called. Off by default: it rewrites the name your files arrived with. Only applies to names that actually repeat the creator, and never leaves a reward without a name.",
                  )}
                </p>
              </div>
              <Toggle checked={stripCreator} onChange={toggleStripCreator} />
            </div>

            {managed ? (
              <div className={cn("mt-5 flex items-start gap-2 rounded-xl border p-4 text-sm", irid ? iriInner + " text-white/80" : "glass-box border-zinc-800 bg-zinc-900/40 text-zinc-400")}>
                <Boxes className="mt-0.5 h-4 w-4 shrink-0 text-zinc-500" />
                <span>
                  {t(
                    "In managed mode there are no separate source folders — everything is stored in your MiColl collection",
                  )}
                  {collectionRoot ? "" : t(" (choose a collection folder below first)")}
                  {t(
                    ". To add content, use Import folder on the dashboard or drop a folder onto the window — either way it’s moved into the collection automatically.",
                  )}
                </span>
              </div>
            ) : (
              <>
                <div className="mt-5 space-y-2">
                  {roots.length === 0 ? (
                    <div className={cn("rounded-xl border border-dashed p-8 text-center text-sm", irid ? iriDashed + " text-white/70" : "border-zinc-800 bg-zinc-900/40 text-zinc-500")}>
                      {t("No library folders yet. Add one to start indexing.")}
                    </div>
                  ) : (
                    roots.map((r) => (
                      <div
                        key={r.id}
                        className={cn("flex items-center gap-3 rounded-xl border p-3", irid ? iriInner : "glass-box border-zinc-800 bg-zinc-900")}
                      >
                        <div className={cn("flex h-9 w-9 shrink-0 items-center justify-center rounded-lg", irid ? iriTile : "bg-zinc-800 text-zinc-300")}>
                          <HardDrive className="h-4 w-4" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm text-zinc-100">{r.path}</div>
                          <div className="mt-0.5">
                            {r.defaultPlatform ? (
                              <Badge tone="brand">{r.defaultPlatform}</Badge>
                            ) : (
                              <Badge tone="amber">{t("platform: ask per folder")}</Badge>
                            )}
                          </div>
                        </div>
                        <Button
                          variant="ghost"
                          size="icon"
                          title={t("Remove from library")}
                          onClick={() => doRemove(r.id)}
                          disabled={busy}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    ))
                  )}
                </div>

                <div className={cn("mt-8 flex items-start gap-2 rounded-xl border p-4 text-sm", irid ? iriInner + " text-white/80" : "glass-box border-zinc-800 bg-zinc-900/40 text-zinc-400")}>
                  <FolderOpen className="mt-0.5 h-4 w-4 shrink-0 text-zinc-500" />
                  <span>
                    {t("Tip: pick any folder — a single creator (e.g.")}{" "}
                    <code className={cn(codeChip, "px-1 py-0.5")}>Bonnie</code>
                    {t(
                      ") or a whole library of creators. MiColl detects platform / year / month wherever it can and shows you a review screen to confirm and fill in anything it couldn’t determine.",
                    )}
                  </span>
                </div>
              </>
            )}

            {/* managed collection (optional, off by default) */}
            <div className={cn("glass-box mt-6 rounded-xl border border-zinc-800 bg-zinc-900/40 p-4", irid && iriInner)}>
              <div className="flex items-start gap-3">
                <div className={cn("flex h-9 w-9 shrink-0 items-center justify-center rounded-lg", irid ? iriTile : "bg-zinc-800 text-zinc-300")}>
                  <Boxes className="h-4 w-4" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2">
                      <h2 className="text-base font-semibold text-zinc-100">{t("Managed collection")}</h2>
                      <span className="inline-flex items-center rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-xs font-medium text-emerald-300">
                        {t("Recommended")}
                      </span>
                    </div>
                    <Toggle checked={managed} onChange={toggleManaged} />
                  </div>
                  <p className="settings-desc mt-1 text-sm text-zinc-400">
                    <b className="text-zinc-300">{t("Recommended.")}</b>{" "}
                    {t("When on, MiColl keeps your rewards in one tidy collection folder organized as")}{" "}
                    <code className={cn(codeChip, "px-1 py-0.5")}>
                      {t("MiColl / Creator / Platform / Year / Month / Reward")}
                    </code>{" "}
                    {t(
                      "— handy if you’d rather not have files scattered across your PC. You can place it on another disk.",
                    )}
                  </p>

                  {managed && (
                    <div className="mt-4 space-y-3">
                      <div className={cn("glass-box flex items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-950 p-2.5", irid && iriInner)}>
                        <FolderInput className="h-4 w-4 shrink-0 text-zinc-500" />
                        <span
                          className={`min-w-0 flex-1 truncate text-sm ${
                            collectionRoot ? "text-zinc-200" : "text-zinc-500"
                          }`}
                        >
                          {collectionRoot || t("No collection folder chosen yet")}
                        </span>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={chooseCollectionFolder}
                          disabled={busy}
                        >
                          {collectionRoot ? t("Change…") : t("Choose…")}
                        </Button>
                      </div>
                      <div className="flex items-center justify-between gap-3">
                        <p className="settings-desc text-xs text-zinc-500">
                          {t("Relocates files into the collection (moved, not copied).")}
                        </p>
                        <Button
                          variant="primary"
                          size="sm"
                          disabled={busy || !collectionRoot}
                          onClick={() => setConfirmOrganize(true)}
                        >
                          <FolderInput className="h-4 w-4" />
                          {t("Organize collection now")}
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>

          </>
        )}
        </section>
        )}

        {/* Security, Backup and MiSD each have their own box */}
        {backed &&
          tools.map((t) => (
            <section key={t.id} id={t.id} className={cn(glass, "scroll-mt-4")}>
              {t.node}
            </section>
          ))}

        {/* sharing: original or newest version for MEGA uploads */}
        {backed && (
          <section id="sharing" className={cn(glass, "scroll-mt-4")}>
            <h1 className="flex items-center gap-2 settings-title text-2xl font-bold tracking-tight text-zinc-50">
              <CloudUpload className="h-6 w-6 text-brand-300" />
              {t("Sharing")}
            </h1>
            <div className={cn("mt-5 flex items-center justify-between gap-3", cardInner)}>
              <div className="min-w-0">
                <h2 className="text-sm font-semibold text-zinc-100">{t("MEGA uploads edited images as")}</h2>
                <p className="settings-desc mt-0.5 text-sm text-zinc-400">
                  {t(
                    "When an image has versions from the editor, this picks which file goes up by default — the untouched original, or the newest version. The upload dialog still lets you choose another one each time; images without versions always go up as they are.",
                  )}
                </p>
              </div>
              <ThemedSelect
                value={megaVersion}
                onChange={(v) => changeMegaVersion(v as "original" | "newest")}
                options={[
                  { value: "original", label: t("Original file") },
                  { value: "newest", label: t("Newest version") },
                ]}
                title={t("Which file MEGA uploads by default")}
                ink="text-zinc-100"
                className={cn("h-9 w-44 shrink-0 px-3 text-sm", dlg.field)}
                minWidth={176}
              />
            </div>
          </section>
        )}

        {/* feedback, then version */}
        {(
          <section id="feedback" className={cn(glass, "scroll-mt-4")}>
            <FeedbackPanel />
          </section>
        )}

        {/* language, then version (about the app itself) */}
        {(
          <section id="language" className={cn(glass, "scroll-mt-4")}>
            <LanguagePanel />
          </section>
        )}

        {(
          <section id="version" className={cn(glass, "scroll-mt-4")}>
            <VersionPanel />
          </section>
        )}
        </div>
        </div>
      </div>

      {review && (
        <ImportReviewTree
          plan={review}
          busy={busy}
          sourcePath={source}
          onConfirm={doImport}
          onCancel={() => setReview(null)}
        />
      )}

      {confirmOrganize && (
        <ConfirmDialog
          title={t("Organize collection now?")}
          confirmLabel={t("Move files")}
          busy={busy}
          body={
            <>
              {t("This will")} <b>{t("move")}</b>{" "}
              {t("all indexed reward folders into")}{" "}
              <code className={cn(codeChip, "px-1 py-0.5")}>
                {collectionRoot}\MiColl
              </code>
              , arranged as Artist / Platform / Year / Month / Reward. Originals are relocated (not
              copied), so this isn’t auto-undoable.
            </>
          }
          onConfirm={doOrganize}
          onCancel={() => setConfirmOrganize(false)}
        />
      )}

      {pendingRoot && (
        <ConfirmDialog
          title={t("Move your collection here?")}
          confirmLabel={t("Move it here")}
          extraLabel="Just switch (don't move)"
          onExtra={() => void doSwitchCollectionOnly()}
          busy={busy}
          body={
            <>
              Relocate your existing collection from{" "}
              <code className={cn(codeChip, "px-1 py-0.5")}>{collectionRoot}\MiColl</code>{" "}
              to{" "}
              <code className={cn(codeChip, "px-1 py-0.5")}>{pendingRoot}\MiColl</code>?
              {t("The whole folder is")} <b>{t("moved")}</b>{" "}
              {t("(not copied) and every file is re-linked. Choose")}{" "}
              <b>{t("Just switch")}</b>{" "}
              {t("to only point new content at the new folder and leave existing files")}
              where they are.
            </>
          }
          onConfirm={() => void doMoveCollection()}
          onCancel={() => setPendingRoot(null)}
        />
      )}

      {confirmCovers && (
        <ConfirmDialog
          title={t("Reset missing covers?")}
          confirmLabel={t("Reset covers")}
          busy={busy}
          body={t(
            "Creators, months and rewards whose cover image no longer exists go back to the automatic image. Covers on a disk that isn’t connected right now stay as they are. Your files aren’t touched.",
          )}
          onConfirm={() => void doResetCovers()}
          onCancel={() => setConfirmCovers(false)}
        />
      )}

      {confirmClear && (
        <ConfirmDialog
          title={t("Clear the whole library?")}
          confirmLabel={t("Clear everything")}
          busy={busy}
          body={
            <>
              Removes all indexed artists, periods, rewards and library folders from MiColl’s
              {t("database.")} <b>{t("Your files on disk are not touched")}</b>{" "}
              {t("— you can re-add folders")}
              afterwards. Useful for clearing out test data.
            </>
          }
          onConfirm={doClear}
          onCancel={() => setConfirmClear(false)}
        />
      )}

      {healthOpen && <HealthPanel onClose={() => setHealthOpen(false)} />}

      {unlockOpen && (
        <ThemeUnlockDialog
          onUnlocked={() => {
            setPremium(true);
            if (pendingAccent) {
              setAccent(pendingAccent);
              applyAccent(pendingAccent);
            }
          }}
          onClose={() => {
            setUnlockOpen(false);
            setPendingAccent(null);
            // re-sync after unlock / key removal
            setPremium(premiumUnlocked());
            setAccent(getAccent());
          }}
        />
      )}
    </Layout>
  );
}

/**
 * Beta badge next to the premium themes (they're not finished yet).
 * Own tooltip instead of title (same style as the MiSD badge).
 */
function BetaTag() {
  const t = useT();
  const ref = useRef<HTMLSpanElement>(null);
  const [tip, setTip] = useState<{ left: number; top: number } | null>(null);
  const show = () => {
    const r = ref.current?.getBoundingClientRect();
    if (r) setTip({ left: r.left + r.width / 2, top: r.top });
  };
  return (
    <>
      <span
        ref={ref}
        onMouseEnter={show}
        onMouseLeave={() => setTip(null)}
        tabIndex={0}
        onFocus={show}
        onBlur={() => setTip(null)}
        // amber and quieter than the gold "✦ Premium"
        className="cursor-help rounded-full border border-amber-300/40 bg-amber-300/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest text-amber-200 outline-none focus-visible:ring-2 focus-visible:ring-amber-300/60"
      >
        {t("Beta")}
      </span>
      {tip &&
        createPortal(
          <div
            style={{ left: tip.left, top: tip.top - 8 }}
            className="pointer-events-none fixed z-[120] max-w-[22rem] -translate-x-1/2 -translate-y-full rounded-md bg-black/90 px-2.5 py-1.5 text-[11px] font-medium leading-relaxed text-white shadow-lg ring-1 ring-white/15"
          >
            {t(
              "The premium themes are not all at the same stage: they were built one after another, parts of them are still unfinished, and all three keep changing.",
            )}
          </div>,
          document.body,
        )}
    </>
  );
}

/** Simple on/off switch. */
function Toggle({
  checked,
  onChange,
  disabled,
  title,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  title?: string;
}) {
  const accent = useAccent();
  return (
    <button
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      title={title}
      onClick={() => onChange(!checked)}
      className={cn(
        // cyberpunk styles these as power cells with a bolt knob (index.css)
        "micoll-switch relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors",
        checked ? toggleOnClass(accent) : "bg-zinc-700",
        disabled && "cursor-not-allowed opacity-40",
      )}
    >
      <span
        className={cn(
          "micoll-switch-knob inline-block h-5 w-5 transform rounded-full bg-white transition-transform",
          checked ? "translate-x-5" : "translate-x-0.5",
        )}
      />
    </button>
  );
}
