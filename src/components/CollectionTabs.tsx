import { useEffect, useRef, useState } from "react";
import { FolderOpen, MonitorPlay, Pencil, Plus, Settings2, Trash2 } from "lucide-react";
import { useActions } from "@/actions";
import { PyreFlames } from "@/components/PyreFlames";
import { SakuraFan } from "@/components/SakuraFan";
import { SlideshowSettingsDialog } from "@/components/SlideshowSettingsDialog";
import { useThumb } from "@/hooks/useThumb";
import { useAccent } from "@/lib/theme";
import { useDialogTheme } from "@/lib/dialogTheme";
import { cn } from "@/lib/utils";
import { useT, useTp } from "@/lib/i18n";

/** One card: a collection of this creator's images. */
export interface CollectionTab {
  /** Key: "favs"/"wall" for the built-ins, the id for user ones. */
  key: string;
  name: string;
  /** How many of this creator's files are in it (0 = dimmed "empty" card). */
  count: number;
  icon: React.ReactNode;
  /** Up to five pictures of the collection (random per visit). */
  previews: string[];
  onOpen: () => void;
  /** Set if the collection can be used for the desktop slideshow. */
  onSetWallpaper?: () => void;
  /** Only user collections can be renamed... */
  onRename?: (name: string) => void;
  /** ...or deleted. */
  onDelete?: () => void;
}

/** A theme's card: its frame, the card width, the "+" and the wallpaper button. */
interface Skin {
  card: string;
  width: string;
  count: string;
  add: string;
  wallpaper: string;
  art: (paths: string[]) => React.ReactNode;
}
const SKINS: Record<"iridescent" | "cyberpunk" | "sakura" | "corruptruby" | "casual", Skin> = {
  iridescent: {
    card: "rounded-none shadow-lg shadow-black/20 hover:border-white/45",
    width: "22rem",
    count: "text-zinc-200",
    add: "rounded-none border-dashed border-white/30 hover:border-white/45 hover:bg-white/10",
    wallpaper: "right-2 border-white/25 bg-zinc-950/70 text-zinc-100 hover:border-white/60",
    art: (paths) => <PrismStrips paths={paths} />,
  },
  cyberpunk: {
    card: "cp-coll",
    width: "23.5rem",
    count: "font-mono text-[#8fe9f7]",
    add: "cp-coll cp-coll--new text-[#fcee0a]",
    wallpaper:
      "right-[15px] border-[#fcee0a]/60 bg-zinc-950/85 text-[#fcee0a] hover:border-[#fcee0a] hover:bg-[#fcee0a] hover:text-zinc-950",
    art: (paths) => <ChipBay paths={paths} />,
  },
  sakura: {
    card: "sak-coll",
    width: "22.5rem",
    count: "text-[#f5d3e3]",
    add: "sak-coll text-[#f9a8d4]",
    wallpaper:
      "right-3 rounded-[0.4rem_0.9rem_0.4rem_0.9rem] border-[#f9a8d4]/60 bg-[#2a141f]/90 text-[#ffd0e3] hover:border-[#ffd0e3] hover:bg-[#ea5ba6] hover:text-white",
    art: (paths) => <SakuraFan paths={paths} />,
  },
  corruptruby: {
    card: "ruby-coll",
    width: "23.5rem",
    count: "text-[#ecc9d6]",
    add: "ruby-coll text-[#ff7aa8]",
    wallpaper:
      "right-3 rounded-[3px] border-[#ff7aa8]/70 bg-[#080206]/85 text-[#ffd6e4] hover:border-white hover:bg-[#ff1464] hover:text-white",
    art: (paths) => <PyreFlames paths={paths} />,
  },
  casual: {
    card: "casual-coll",
    width: "23.5rem",
    count: "text-zinc-300",
    add: "casual-coll text-brand-300",
    wallpaper:
      "right-3 rounded-lg border-brand-400/50 bg-zinc-950/85 text-brand-200 hover:border-brand-300 hover:bg-brand-500 hover:text-zinc-950",
    art: (paths) => <CardHand paths={paths} />,
  },
};

/**
 * Collection cards on a creator's page: Favourites, Fav. Wallpaper and every user
 * collection, plus "+" to add one. The pictures on the right are drawn per theme: slanted
 * strips on iridescent (index.css .iri-prism), data chips on cyberpunk (.cp-coll), a folding
 * fan on sakura (SakuraFan), flame pieces on Pyre (PyreFlames), a hand of cards on the
 * standard themes (.card-hand). Renaming happens inline.
 */
export function CollectionTabs({
  tabs,
  onCreate,
  glass,
}: {
  tabs: CollectionTab[];
  /** Not set in the browser version (no backend). */
  onCreate?: (name: string) => void;
  /** Surface of the box above, so the cards use the same material (iridescent only). */
  glass?: string;
}) {
  const t = useT();
  const tp = useTp();
  const { openMenu } = useActions();
  const { field } = useDialogTheme();
  const accent = useAccent();
  const irid = accent === "iridescent";
  const cyber = accent === "cyberpunk";
  const skin = accent in SKINS ? SKINS[accent as keyof typeof SKINS] : SKINS.casual;
  const casual = skin === SKINS.casual;
  // iridescent brings its glass, the others paint their own plate
  const surface = irid ? glass : undefined;
  // key of the card being renamed, or null
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

  const nameField = cn(
    "h-16 px-4 text-[12px] text-zinc-100 outline-none placeholder:text-zinc-500",
    surface ?? field,
    irid && "rounded-none",
  );
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
      style={{ width: skin.width }}
      className={nameField}
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

  return (
    <div className={irid ? "mb-3" : casual ? "mb-4" : "mb-5"}>
      <div className="flex flex-wrap items-start gap-3">
        {/* gradient definition for the iridescent icons (used by id in index.css) */}
        {irid && (
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
              style={{ minWidth: skin.width }}
              className={cn(
                "group/tab relative flex h-16 overflow-hidden transition-colors",
                surface,
                skin.card,
                tab.count === 0 && "opacity-60",
              )}
            >
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
                  "flex min-w-0 flex-1 items-stretch justify-between gap-3 pl-4 text-left transition-colors",
                  irid && "pl-3.5",
                  irid && tab.count > 0 && "hover:bg-white/10",
                )}
              >
                <span className={cn("flex min-w-0 flex-col justify-center gap-1.5", cyber && "cp-coll-label pb-3")}>
                  <span className="flex items-center gap-2">
                    <span className="shrink-0">{tab.icon}</span>
                    <span className="fav-title max-w-[11rem] truncate pr-0.5 text-[12px] leading-tight">
                      {tab.name}
                    </span>
                  </span>
                  <span className={cn("text-[11px] leading-none", skin.count)}>
                    {tab.count ? tp("{n} files", tab.count) : "empty"}
                  </span>
                </span>
                {skin.art(tab.previews)}
              </button>
              {/* set-as-wallpaper button over the pictures */}
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
                    "absolute top-1/2 grid h-8 w-8 -translate-y-1/2 place-items-center border opacity-0 transition-opacity focus-visible:opacity-100 group-hover/tab:opacity-100",
                    skin.wallpaper,
                  )}
                >
                  <MonitorPlay className="h-4 w-4" />
                </button>
              )}
            </div>
          ),
        )}

        {onCreate && (
          <NewCollectionButton
            onCreate={onCreate}
            className={cn("relative grid h-16 w-12 place-items-center transition-colors", surface, skin.add)}
            inputClassName={cn(nameField, "w-52")}
          />
        )}
      </div>
      {slideshowSettings && <SlideshowSettingsDialog onClose={() => setSlideshowSettings(false)} />}
    </div>
  );
}

/** A hand of cards on the standard themes (index.css .card-hand). */
function CardHand({ paths }: { paths: string[] }) {
  // an empty collection shows three blank cards
  const cards = paths.length ? paths : [undefined, undefined, undefined];
  return (
    <span aria-hidden className="card-hand">
      {cards.map((p, i) => (
        <HandCard key={p ?? i} path={p} turn={i - (cards.length - 1) / 2} />
      ))}
    </span>
  );
}

/** Own component because it uses a hook per card. */
function HandCard({ path, turn }: { path?: string; turn: number }) {
  const src = useThumb(path, 160);
  return (
    <span
      className="card-hand-card"
      style={{ "--turn": turn, "--lift": Math.abs(turn) } as React.CSSProperties}
    >
      <span>{src && <img src={src} alt="" decoding="async" />}</span>
    </span>
  );
}

/** The slanted picture strips on the right of an iridescent collection card. */
function PrismStrips({ paths }: { paths: string[] }) {
  if (!paths.length) return null;
  return (
    <span aria-hidden className="iri-prism" style={{ "--n": paths.length } as React.CSSProperties}>
      {paths.map((p, i) => (
        <PrismStrip key={p} path={p} index={i} wide={paths.length < 3} />
      ))}
    </span>
  );
}

/** Own component because it uses a hook per strip. */
function PrismStrip({ path, index, wide }: { path: string; index: number; wide: boolean }) {
  const src = useThumb(path, wide ? 320 : 160);
  return (
    <span className="iri-prism-strip" style={{ "--i": index } as React.CSSProperties}>
      <span className="iri-prism-pic">{src && <img src={src} alt="" decoding="async" />}</span>
    </span>
  );
}

/** The four chip slots on the right of a cyberpunk collection card. */
function ChipBay({ paths }: { paths: string[] }) {
  return (
    <span aria-hidden className="cp-bay">
      {[0, 1, 2, 3].map((i) =>
        paths[i] ? (
          <Chip key={i} path={paths[i]} index={i} />
        ) : (
          <span key={i} className="cp-shard-gap" style={{ "--i": i } as React.CSSProperties} />
        ),
      )}
      {/* a light per slot under the chips */}
      <span className="cp-slot">
        {[0, 1, 2, 3].map((i) => (
          <span key={i} data-on={paths[i] ? "" : undefined} className="cp-slot-cell" />
        ))}
      </span>
    </span>
  );
}

/** One picture as a data chip. Own component because it uses a hook per chip. */
function Chip({ path, index }: { path: string; index: number }) {
  const src = useThumb(path, 160);
  return (
    <span className="cp-shard" style={{ "--i": index } as React.CSSProperties}>
      <span className="cp-shard-pic">{src && <img src={src} alt="" decoding="async" />}</span>
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
