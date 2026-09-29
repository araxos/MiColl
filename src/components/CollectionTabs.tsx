import { useEffect, useRef, useState } from "react";
import { FolderOpen, MonitorPlay, Pencil, Plus, Settings2, Trash2 } from "lucide-react";
import { useActions } from "@/actions";
import { SlideshowSettingsDialog } from "@/components/SlideshowSettingsDialog";
import { useThumb } from "@/hooks/useThumb";
import { useAccent } from "@/lib/theme";
import { useDialogTheme } from "@/lib/dialogTheme";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n";

/** One tab: a collection of this creator's images. */
export interface CollectionTab {
  /** Key: "favs"/"wall" for the built-ins, the id for user ones. */
  key: string;
  name: string;
  /** How many of this creator's files are in it (0 = dimmed "empty" tab). */
  count: number;
  icon: React.ReactNode;
  /** One picture of the collection, shown dimmed behind the tab (random per visit). */
  preview?: string;
  onOpen: () => void;
  /** Set if the collection can be used for the desktop slideshow. */
  onSetWallpaper?: () => void;
  /** Only user collections can be renamed... */
  onRename?: (name: string) => void;
  /** ...or deleted. */
  onDelete?: () => void;
}

/**
 * Collection tabs on a creator's page: Favourites, Fav. Wallpaper and every user
 * collection, plus "+" to add one. The row hangs off the bottom of the box above
 * (like browser tabs). Renaming happens inline.
 */
export function CollectionTabs({
  tabs,
  onCreate,
  glass,
  inset = false,
}: {
  tabs: CollectionTab[];
  /** Not set in the browser version (no backend). */
  onCreate?: (name: string) => void;
  /** Surface of the box above, so the tabs use the same material (glass themes only). */
  glass?: string;
  /** Indent the row to the box padding. */
  inset?: boolean;
}) {
  const t = useT();
  const { openMenu } = useActions();
  const { field, divider } = useDialogTheme();
  const accent = useAccent();
  // tab hover: light the edge instead of the opaque menuRow fill (keeps the picture
  // visible)
  const tabEdge =
    accent === "cyberpunk"
      ? "hover:border-[#fcee0a]/80"
      : accent === "sakura"
        ? "hover:border-[#f9a8d4]/70"
        : accent === "iridescent"
          ? "hover:border-white/45"
          : "hover:border-brand-500/60";
  const tabFill =
    accent === "cyberpunk"
      ? "hover:bg-[#fcee0a]/10 hover:text-[#fcee0a]"
      : accent === "sakura"
        ? "hover:bg-[#f9a8d4]/10"
        : "hover:bg-white/10";
  // tabs have no top edge, square corners on the hard-edged themes
  const tabShape = cn(
    glass ?? field,
    "rounded-t-none border-t-0",
    accent === "cyberpunk" || accent === "iridescent" ? "rounded-b-none" : "rounded-b-xl",
  );
  // key of the tab being renamed, or null
  const [slideshowSettings, setSlideshowSettings] = useState(false);
  const slideshowItem = {
    label: t("Slideshow settings"),
    icon: <Settings2 className="h-4 w-4" />,
    onClick: () => setSlideshowSettings(true),
  };
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  const start = (key: string, initial = "") => {
    setDraft(initial);
    setEditing(key);
  };
  const cancel = () => {
    setEditing(null);
    setDraft("");
  };
  const commit = () => {
    const name = draft.trim();
    const key = editing;
    cancel();
    if (!name || !key) return;
    tabs.find((t) => t.key === key)?.onRename?.(name);
  };

  const editor = (
    <input
      ref={inputRef}
      value={draft}
      autoFocus
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
        if (e.key === "Escape") cancel();
        // don't trigger page shortcuts while typing a name
        e.stopPropagation();
      }}
      placeholder={t("Collection name")}
      spellCheck={false}
      className={cn(
        "h-11 w-40 px-2.5 text-[12px] text-zinc-100 outline-none placeholder:text-zinc-500",
        tabShape,
      )}
    />
  );

  const tabMenu = (e: React.MouseEvent, tab: CollectionTab) =>
    openMenu(e, [
      { label: t("Open"), icon: <FolderOpen className="h-4 w-4" />, onClick: tab.onOpen },
      ...(tab.onSetWallpaper && tab.count > 0
        ? [
            {
              label: t("Set as Wallpaper"),
              icon: <MonitorPlay className="h-4 w-4" />,
              onClick: tab.onSetWallpaper,
            },
            slideshowItem,
          ]
        : []),
      ...(tab.onRename
        ? [
            {
              label: t("Rename collection"),
              icon: <Pencil className="h-4 w-4" />,
              onClick: () => start(tab.key, tab.name),
            },
          ]
        : []),
      ...(tab.onDelete
        ? [
            {
              label: t("Delete collection"),
              icon: <Trash2 className="h-4 w-4" />,
              danger: true,
              onClick: tab.onDelete,
            },
          ]
        : []),
    ]);

  // the line the tabs hang from (not on iridescent, there the glass box above is the edge)
  const rail =
    accent === "cyberpunk" ? (
      // cyberpunk: yellow line with a cyan trace
      <div className="relative h-px w-full bg-[#fcee0a]/45 shadow-[0_1px_0_rgba(0,229,255,0.28)]">
        <span className="absolute left-0 top-[-1px] h-[3px] w-16 bg-[#fcee0a]" />
      </div>
    ) : accent === "sakura" ? (
      // sakura: pink line that fades out at both ends
      <div className="h-px w-full bg-[linear-gradient(90deg,transparent,#f9a8d4_18%,#ea5ba6_50%,#f9a8d4_82%,transparent)] opacity-80" />
    ) : (
      <div className={cn("w-full border-t", divider)} />
    );

  // iridescent: no line, the tabs overlap the glass box border
  const hasRail = accent !== "iridescent";

  return (
    <div className={cn("mb-6", inset && "pl-4")}>
      {/* tabs start right under the line, no overlap (the opaque tabs would hide it) */}
      {hasRail && <div className="pt-2">{rail}</div>}
      {/* without a line, -mt-px lets the tabs overlap the box border */}
      <div className={cn("flex flex-wrap items-start gap-1", !hasRail && "-mt-px")}>
      {/* gradient definition for the iridescent tab icons (used by id in index.css) */}
      {accent === "iridescent" && (
        <svg aria-hidden width="0" height="0" className="absolute">
          <defs>
            <linearGradient id="micoll-iri-foil" x1="0" y1="0" x2="1" y2="1">
              <stop className="iri-star-ink" offset="0%" />
              <stop className="iri-star-ink iri-star-ink-2" offset="100%" />
            </linearGradient>
          </defs>
        </svg>
      )}
      {tabs.map((tab) =>
        editing === tab.key ? (
          <div key={tab.key}>{editor}</div>
        ) : (
          <div
            key={tab.key}
            className={cn(
              "group/tab relative flex h-11 items-stretch overflow-hidden transition-colors",
              tabShape,
              tab.count > 0 && tabEdge,
              tab.count === 0 && "opacity-60",
            )}
          >
            {tab.preview && <TabBackdrop path={tab.preview} />}
            <button
              onClick={tab.onOpen}
              onContextMenu={(e) => tabMenu(e, tab)}
              disabled={tab.count === 0}
              title={
                tab.count
                  ? `Open ${tab.name} · right-click for options`
                  : `${tab.name} is empty — right-click an image to add it`
              }
              className={cn(
                // relative keeps the label above the backdrop
                "relative flex items-center gap-2 px-3 text-left transition-colors",
                tab.count > 0 && tabFill,
              )}
            >
              <span className="shrink-0 opacity-90">{tab.icon}</span>
              <span className="fav-title max-w-[11rem] truncate text-[12px] leading-none">
                {tab.name}
              </span>
              {/* white text on iridescent */}
              <span
                className={cn(
                  "shrink-0 text-[10px] font-medium tabular-nums",
                  accent === "iridescent" ? "text-white" : "text-zinc-400",
                )}
              >
                {tab.count ? tab.count : "empty"}
              </span>
            </button>
            {/* set-as-wallpaper button right in the tab */}
            {tab.onSetWallpaper && tab.count > 0 && (
              <button
                onClick={tab.onSetWallpaper}
                // its own menu for the slideshow settings
                onContextMenu={(e) => {
                  e.stopPropagation();
                  openMenu(e, [slideshowItem]);
                }}
                title={t("Set these as a desktop wallpaper slideshow (right-click for slideshow settings)")}
                className={cn(
                  "relative grid w-0 place-items-center overflow-hidden border-l border-transparent opacity-0 transition-all group-hover/tab:w-8 group-hover/tab:opacity-100",
                  divider,
                  tabFill,
                )}
              >
                <MonitorPlay className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        ),
      )}

      {onCreate && (
        <NewCollectionButton
          onCreate={onCreate}
          className={cn("grid h-11 w-9 place-items-center transition-colors", tabShape, tabEdge, tabFill)}
          inputClassName={cn(
            "h-11 w-40 px-2.5 text-[12px] text-zinc-100 outline-none placeholder:text-zinc-500",
            tabShape,
          )}
        />
      )}
      </div>
      {slideshowSettings && <SlideshowSettingsDialog onClose={() => setSlideshowSettings(false)} />}
    </div>
  );
}

/**
 * The dimmed picture behind a tab, with a dark overlay so the text stays readable.
 * Own component because it uses a hook per tab. Renders nothing without a thumbnail.
 */
function TabBackdrop({ path }: { path: string }) {
  const src = useThumb(path, 160);
  if (!src) return null;
  return (
    <span aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
      <img src={src} alt="" decoding="async" className="h-full w-full object-cover opacity-70" />
      <span className="absolute inset-0 bg-zinc-950/35" />
    </span>
  );
}

/**
 * The "+" button to create a collection, with an inline name field.
 * Separate from the row: without any collections it sits next to the card shape icon.
 */
export function NewCollectionButton({
  onCreate,
  className,
  inputClassName,
}: {
  onCreate: (name: string) => void;
  className?: string;
  /** Style for the name field. */
  inputClassName?: string;
}) {
  const t = useT();
  const [typing, setTyping] = useState(false);
  const [draft, setDraft] = useState("");

  const commit = () => {
    const name = draft.trim();
    setTyping(false);
    setDraft("");
    if (name) onCreate(name);
  };

  if (typing)
    return (
      <input
        value={draft}
        autoFocus
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          if (e.key === "Escape") {
            setTyping(false);
            setDraft("");
          }
          // don't trigger page shortcuts while typing a name
          e.stopPropagation();
        }}
        placeholder={t("Collection name")}
        spellCheck={false}
        className={inputClassName}
      />
    );

  return (
    <button
      onClick={() => setTyping(true)}
      title={t("New collection — a group of images you pick yourself")}
      aria-label={t("New collection")}
      className={className}
    >
      <Plus className="h-4 w-4" />
    </button>
  );
}
