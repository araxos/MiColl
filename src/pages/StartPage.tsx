import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { useNavigate } from "react-router-dom";
import {
  UserPlus,
  Loader2,
  Plus,
  ArrowDownUp,
  ArrowUp,
  ArrowDown,
  Check,
  BarChart3,
  Tags,
  History,
  Dices,
  ChevronDown,
  Users,
  GripVertical,
  ArrowDownAZ,
  Clock,
  Images,
  type LucideIcon,
} from "lucide-react";
import { Layout } from "@/components/Layout";
import { ArtistCard } from "@/components/ArtistCard";
import { DASHBOARD_SHAPE } from "@/lib/tileShape";
import { VirtualGrid } from "@/components/VirtualGrid";
import { RecentPanel } from "@/components/RecentPanel";
import { AddArtistSheet } from "@/components/AddArtistSheet";
import { ImportFolderButton } from "@/components/ImportFolderButton";
import { NeedsReviewBanner } from "@/components/NeedsReview";
import { StatsPanel } from "@/components/StatsPanel";
import { Button } from "@/components/ui/Button";
import { useData } from "@/store";
import { librarySizes, storageBreakdown } from "@/api/library";
import { artistTags, tagRank } from "@/lib/artistTags";
import { useAccent } from "@/lib/theme";
import { CREATOR_TYPES, creatorTypeDefs } from "@/lib/creatorTypes";
import { useSfwMode, tagsAreNsfw } from "@/lib/contentMode";
import { usePins } from "@/lib/pins";
import { useShowHidden } from "@/lib/showHidden";
import { useGraveyardMode } from "@/lib/graveyard";
import { getCustomOrder, setCustomOrder, moveWithin, moveToPinBorder } from "@/lib/customOrder";
import { useMinimal } from "@/lib/minimal";
import { cn } from "@/lib/utils";
import { useT, useTf } from "@/lib/i18n";
import { type Artist, ownRewards } from "@/types";
import { queuePrefsSync } from "@/lib/prefs";
import { onPageDetails } from "@/lib/pageDetails";

type SortField = "name" | "class" | "edited" | "type" | "size" | "custom";
const FIELD_LABELS: Record<SortField, string> = {
  name: "Name",
  class: "Class",
  edited: "Last edited",
  type: "Type",
  size: "Size",
  custom: "Custom",
};
const SORT_FIELDS = Object.keys(FIELD_LABELS) as SortField[];
/** One icon per sort field. */
const FIELD_ICONS: Record<SortField, LucideIcon> = {
  name: ArrowDownAZ,
  class: Tags,
  edited: Clock,
  type: Users,
  size: Images,
  custom: GripVertical,
};

/** Which side of which card the dragged card would land on. */
type DropAt = { id: string; side: "before" | "after" };

/** Card sizes Ctrl+wheel steps through. Smaller steps at the small end. */
const CARD_STEPS = [120, 130, 140, 151, 163, 176, 190, 205, 221, 238, 256, 276, 297, 318, 340];
const CARD_MIN = CARD_STEPS[0];
const CARD_MAX = CARD_STEPS[CARD_STEPS.length - 1];

/** Next size up (dir = 1) or down, also snaps a saved size to the list. */
function nextCardSize(current: number, dir: 1 | -1): number {
  return dir > 0
    ? (CARD_STEPS.find((s) => s > current) ?? CARD_MAX)
    : (CARD_STEPS.filter((s) => s < current).pop() ?? CARD_MIN);
}

/**
 * Number of media files of a creator (no borrowed collabs).
 * Only used to notice when files were added/removed, the Size sort uses bytes.
 */
function artistFiles(a: Artist): number {
  return a.platforms.reduce(
    (s, p) =>
      s + p.months.reduce((m, mo) => m + ownRewards(mo).reduce((r, rw) => r + rw.imageCount, 0), 0),
    0,
  );
}

/**
 * Compare function for one sort field. order = the custom position per artist id,
 * creators not in it go to the end (A-Z).
 */
function compareBy(field: SortField, order: Map<string, number>, bytes: Map<string, number>) {
  return (a: Artist, b: Artist) => {
    switch (field) {
      case "custom": {
        const ai = order.get(a.id) ?? Number.MAX_SAFE_INTEGER;
        const bi = order.get(b.id) ?? Number.MAX_SAFE_INTEGER;
        return ai - bi || a.name.localeCompare(b.name);
      }
      case "class":
        // by class rank, no class (99) at the end
        return tagRank(a.tag) - tagRank(b.tag) || a.name.localeCompare(b.name);
      case "type":
        return (a.kind || "￿").localeCompare(b.kind || "￿") || a.name.localeCompare(b.name);
      case "size":
        // creators without a size yet count as 0 (at the end, by name)
        return (bytes.get(a.id) ?? 0) - (bytes.get(b.id) ?? 0) || a.name.localeCompare(b.name);
      case "edited":
        return (a.updatedAt || "").localeCompare(b.updatedAt || "") || a.name.localeCompare(b.name);
      case "name":
      default:
        return a.name.localeCompare(b.name);
    }
  };
}

/** Stable object so re-renders don't overwrite the overflow the filter bar sets. */
const FILTERS_STYLE = { overflow: "visible" } as const;

/** How long fading creators stay (keyframes in index.css + the longest delay). */
type SfwFade = { leaving: ReadonlySet<string>; entering: ReadonlySet<string> };
const NO_IDS: ReadonlySet<string> = new Set();
const NO_FADE: SfwFade = { leaving: NO_IDS, entering: NO_IDS };
const SFW_LEAVE_MS = 360;
const SFW_ENTER_MS = 480;

export function StartPage({ onLock }: { onLock: () => void }) {
  const { artists, loading, backed } = useData();
  const navigate = useNavigate();
  const t = useT();
  const tf = useTf();
  const sfw = useSfwMode();
  // switching SFW fades creators out/in instead of just removing them.
  // Computed during render (an effect would be too late).
  const artistsRef = useRef(artists);
  artistsRef.current = artists;
  const [fade, setFade] = useState<SfwFade>(NO_FADE);
  const [fadeFrom, setFadeFrom] = useState(sfw);
  if (fadeFrom !== sfw) {
    setFadeFrom(sfw);
    const ids: ReadonlySet<string> = new Set(
      artistsRef.current.filter((a) => tagsAreNsfw(a.tags)).map((a) => a.id),
    );
    setFade(
      ids.size === 0 ? NO_FADE
      : sfw ? { leaving: ids, entering: NO_IDS }
      : { leaving: NO_IDS, entering: ids },
    );
  }
  useEffect(() => {
    if (fade === NO_FADE) return;
    const ms = fade.leaving.size > 0 ? SFW_LEAVE_MS : SFW_ENTER_MS;
    const timer = setTimeout(() => setFade(NO_FADE), ms);
    return () => clearTimeout(timer);
  }, [fade]);
  const pins = usePins();
  // hidden creators are off the wall (see lib/showHidden)
  const showHidden = useShowHidden();
  // graveyard switch: on = only graveyard creators, off = everyone else
  const graveyard = useGraveyardMode();
  const minimal = useMinimal();
  // clip the filter bar while it animates, un-clip when idle (so dropdowns work).
  // Written to the node directly (no re-render). Clip in a layout effect,
  // compared with the previous value (StrictMode runs effects twice).
  // The timer is a backup in case the animation callback never comes.
  const filtersRef = useRef<HTMLDivElement | null>(null);
  const prevMinimal = useRef(minimal);
  const unclipAt = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const unclipFilters = () => {
    if (unclipAt.current) clearTimeout(unclipAt.current);
    unclipAt.current = undefined;
    const node = filtersRef.current;
    if (node) node.style.overflow = "visible";
  };
  useLayoutEffect(() => {
    if (prevMinimal.current === minimal) return; // mount, or a re-run that changed nothing
    prevMinimal.current = minimal;
    const node = filtersRef.current;
    if (!node) return;
    node.style.overflow = "hidden";
    if (unclipAt.current) clearTimeout(unclipAt.current);
    unclipAt.current = setTimeout(unclipFilters, 450);
  }, [minimal]);
  useEffect(() => () => clearTimeout(unclipAt.current), []);
  const accent = useAccent();
  // dropdown style, cyberpunk gets a hard-edged neon panel
  const cyber = accent === "cyberpunk";
  const irid = accent === "iridescent";
  // iridescent: Sort/Class labels and icons in a light holo tint so they're readable
  const iriLabel = "font-semibold text-[#C7F1FF]";
  const iriSym = "text-[#C7F1FF]";
  // iridescent: frosted outline buttons instead of a dark border.
  // iri-frost instead of backdrop-blur (see lib/glassButtons.ts)
  const iriOutline = irid
    ? "iri-frost border-white/20 bg-white/10 text-zinc-100 hover:bg-white/20"
    : undefined;
  // Create Card keeps the primary pill, iri-lead puts the spectrum on the rim
  const iriLead = irid ? "iri-lead" : undefined;
  // sakura: the petal-cut rose glass from the platform tabs, with blossom for the main
  // action
  const sakura = accent === "sakura";
  const sakChipLead = "sak-chip sak-chip--lead sak-petal-cut";
  const menuClass = (w: string, mt: string) =>
    cn(
      "absolute left-0 z-40 overflow-hidden py-1 shadow-2xl shadow-black/40",
      w,
      mt,
      cyber
        ? "rounded-none border border-[#fcee0a]/70 bg-zinc-950/95 ring-1 ring-inset ring-[#00e5ff]/15 shadow-[0_0_20px_rgba(252,238,10,0.2)] [clip-path:polygon(0_0,100%_0,100%_calc(100%-9px),calc(100%-9px)_100%,0_100%)]"
        : irid
          ? // 85%, not 70%: these three open straight over the animated shader at the
            // top of the page, where a thin fill let the moving colours read through
            // the rows. The app's other menus sit inside a dialog that already dims
            // its backdrop, so they get away with 80% (see lib/dialogTheme).
            "iri-menu rounded-2xl border border-white/15 bg-zinc-900/85 backdrop-blur-2xl ring-1 ring-inset ring-white/10"
          : // Solid opaque dark with a faint brand ring. (Don't pair bg-zinc-900 with
            // a bg-gradient here — twMerge drops the solid colour, leaving the menu
            // see-through over the wallpaper, which made the text unreadable.)
            "rounded-xl border border-brand-500/40 bg-zinc-900 ring-1 ring-inset ring-brand-500/15",
    );
  // disk size per artist (iridescent only), bigger collections shimmer more often
  const [artistBytes, setArtistBytes] = useState<Map<string, number>>(new Map());
  useEffect(() => {
    if (!backed || accent !== "iridescent") return;
    let alive = true;
    storageBreakdown()
      .then((rows) => {
        if (alive) setArtistBytes(new Map(rows.map((r) => [r.id, r.bytes])));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [backed, accent]);
  const GB = 1024 ** 3;
  const holoTierOf = (id: string) => {
    const b = artistBytes.get(id) ?? 0;
    return b >= 10 * GB ? 2 : b >= GB ? 1 : 0;
  };

  const [q, setQ] = useState("");
  const [addOpen, setAddOpen] = useState(false);
  const [statsOpen, setStatsOpen] = useState(false);
  // "Details" in the background menu = the collection stats here
  useEffect(() => onPageDetails(() => setStatsOpen(true)), []);
  const [recentOpen, setRecentOpen] = useState(false);
  // sort field + direction, saved
  const [sortField, setSortField] = useState<SortField>(
    () => (localStorage.getItem("micoll.sortField") as SortField) || "name",
  );
  const [sortDir, setSortDir] = useState<"asc" | "desc">(
    () => (localStorage.getItem("micoll.sortDir") as "asc" | "desc") || "asc",
  );
  // class filter (multi select), empty = all, "none" = no class
  const [classFilter, setClassFilter] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem("micoll.classFilter");
      const arr = raw ? (JSON.parse(raw) as string[]) : [];
      return new Set(Array.isArray(arr) ? arr : []);
    } catch {
      return new Set();
    }
  });
  const [sortOpen, setSortOpen] = useState(false);
  const [classOpen, setClassOpen] = useState(false);
  useEffect(() => {
    try {
      localStorage.setItem("micoll.classFilter", JSON.stringify([...classFilter]));
    } catch {
      /* ignore */
    }
    queuePrefsSync();
  }, [classFilter]);
  const toggleClass = (key: string) =>
    setClassFilter((prev) => {
      const n = new Set(prev);
      n.has(key) ? n.delete(key) : n.add(key);
      return n;
    });
  // creator type filter (multi select), empty = all, saved
  const [typeFilter, setTypeFilter] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem("micoll.typeFilter");
      const arr = raw ? (JSON.parse(raw) as string[]) : [];
      return new Set(Array.isArray(arr) ? arr : []);
    } catch {
      return new Set();
    }
  });
  const [typeOpen, setTypeOpen] = useState(false);
  // close the dropdowns on outside click / Escape. Each one watches its own wrapper.
  const typeRef = useRef<HTMLDivElement>(null);
  const sortRef = useRef<HTMLDivElement>(null);
  const classRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!typeOpen && !sortOpen && !classOpen) return;
    const closeAll = () => {
      setTypeOpen(false);
      setSortOpen(false);
      setClassOpen(false);
    };
    // pointerdown in capture phase (like ContextMenu), mousedown never comes
    // from the Tauri drag region
    const onDown = (e: PointerEvent) => {
      const node = e.target as Node;
      const away = (r: { current: HTMLDivElement | null }) => !r.current || !r.current.contains(node);
      if (typeOpen && away(typeRef)) setTypeOpen(false);
      if (sortOpen && away(sortRef)) setSortOpen(false);
      if (classOpen && away(classRef)) setClassOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && closeAll();
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [typeOpen, sortOpen, classOpen]);
  useEffect(() => {
    try {
      localStorage.setItem("micoll.typeFilter", JSON.stringify([...typeFilter]));
    } catch {
      /* ignore */
    }
    queuePrefsSync();
  }, [typeFilter]);
  const toggleType = (key: string) =>
    setTypeFilter((prev) => {
      const n = new Set(prev);
      n.has(key) ? n.delete(key) : n.add(key);
      return n;
    });
  useEffect(() => {
    try {
      localStorage.setItem("micoll.sortField", sortField);
      localStorage.setItem("micoll.sortDir", sortDir);
    } catch {
      /* ignore */
    }
    queuePrefsSync();
  }, [sortField, sortDir]);

  // the hand-arranged order for "Custom" (artist ids)
  const [customOrder, setCustomOrderState] = useState<string[]>(getCustomOrder);
  const orderMap = useMemo(
    () => new Map(customOrder.map((id, i) => [id, i] as const)),
    [customOrder],
  );

  // creator cards are always 4:6 (ratio for the grid, class for the card)
  const cardShape = DASHBOARD_SHAPE;
  const [cardSize, setCardSize] = useState(() => {
    const v = parseInt(localStorage.getItem("micoll.cardSize") ?? "", 10);
    return Number.isFinite(v) ? Math.min(CARD_MAX, Math.max(CARD_MIN, v)) : 180;
  });
  useEffect(() => {
    try {
      localStorage.setItem("micoll.cardSize", String(cardSize));
    } catch {
      /* ignore */
    }
    queuePrefsSync();
  }, [cardSize]);

  // non-passive wheel listener so Ctrl+wheel resizes cards (normal wheel scrolls)
  const wheelCleanup = useRef<(() => void) | undefined>(undefined);
  const gridRef = useCallback((node: HTMLDivElement | null) => {
    wheelCleanup.current?.();
    wheelCleanup.current = undefined;
    if (!node) return;
    const handler = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      setCardSize((s) => nextCardSize(s, e.deltaY < 0 ? 1 : -1));
    };
    node.addEventListener("wheel", handler, { passive: false });
    wheelCleanup.current = () => node.removeEventListener("wheel", handler);
  }, []);

  // does an artist match the type filter? empty = all, "none" = no type
  const matchesType = useCallback(
    (a: Artist) => {
      if (typeFilter.size === 0) return true;
      const defs = creatorTypeDefs(a.kind);
      if (defs.length === 0) return typeFilter.has("none");
      return defs.some((d) => typeFilter.has(d.key));
    },
    [typeFilter],
  );

  // disk sizes for the "Size" sort, only while that sort is on and only when
  // the file count changed (one stat per file)
  const [sizeBytes, setSizeBytes] = useState<Map<string, number>>(new Map());
  const libraryFiles = useMemo(() => artists.reduce((s, a) => s + artistFiles(a), 0), [artists]);
  useEffect(() => {
    if (!backed || sortField !== "size") return;
    let alive = true;
    void librarySizes()
      .then((rows) => {
        if (alive) setSizeBytes(new Map(rows.map((r) => [String(r.artistId), r.bytes])));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [backed, sortField, libraryFiles]);

  /** Sort like the dashboard: pinned first, then the chosen field inside each group. */
  const sortList = useCallback(
    (list: Artist[], field: SortField, dir: "asc" | "desc") => {
      const cmp = compareBy(field, orderMap, sizeBytes);
      const d = dir === "desc" ? -1 : 1;
      return [...list].sort((a, b) => {
        const ap = pins.has(a.id) ? 0 : 1;
        const bp = pins.has(b.id) ? 0 : 1;
        if (ap !== bp) return ap - bp;
        return cmp(a, b) * d;
      });
    },
    [orderMap, pins, sizeBytes],
  );

  const filtered = useMemo(() => {
    const ql = q.toLowerCase();
    const list = artists.filter(
      (a) =>
        (a.name.toLowerCase().includes(ql) ||
          (a.aliases ?? []).some((al) => al.toLowerCase().includes(ql))) &&
        // SFW hides nsfw artists (fading ones stay until the fade is done)
        !(sfw && tagsAreNsfw(a.tags) && !fade.leaving.has(a.id)) &&
        // hidden creators are left out unless "Show hidden creators" is on
        (showHidden || !a.hidden) &&
        !!a.graveyard === graveyard &&
        matchesType(a) &&
        // class filter: empty = all, else only the chosen classes ("none" = no class)
        (classFilter.size === 0 || classFilter.has(a.tag ?? "none")),
    );
    return sortList(list, sortField, sortDir);
  }, [
    artists,
    q,
    classFilter,
    sortField,
    sortDir,
    sfw,
    fade,
    showHidden,
    graveyard,
    matchesType,
    sortList,
  ]);

  /* ---- Custom order: pick it up, then drag the cards ------------------- */

  // first switch to Custom saves the current order as the start
  const chooseSort = (f: SortField) => {
    if (f === "custom" && customOrder.length === 0 && artists.length > 0) {
      persistOrder(sortList(artists, sortField, sortDir).map((a) => a.id));
    }
    // Size starts on the biggest (only when switching to it)
    if (f === "size" && sortField !== "size") setSortDir("desc");
    setSortField(f);
  };

  const persistOrder = (ids: string[]) => {
    setCustomOrderState(ids);
    setCustomOrder(ids);
  };

  const canDrag = sortField === "custom";
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropAt, setDropAt] = useState<DropAt | null>(null);
  // copies for the window listeners (attached once)
  const drag = useRef<{ id: string; x: number; y: number; active: boolean } | null>(null);
  const dropAtRef = useRef<DropAt | null>(null);
  const setDrop = (v: DropAt | null) => {
    dropAtRef.current = v;
    setDropAt(v);
  };

  /** The saved order plus new creators. */
  const fullOrder = useCallback(() => {
    const known = new Set(customOrder);
    return [
      ...customOrder,
      ...sortList(artists, "name", "asc")
        .map((a) => a.id)
        .filter((x) => !known.has(x)),
    ];
  }, [artists, customOrder, sortList]);

  const commitDrop = useCallback(
    (id: string) => {
      const at = dropAtRef.current;
      if (!at || at.id === id) return;
      // pinned cards stay on top, so a drag across the border can't land exactly there
      const next =
        pins.has(id) !== pins.has(at.id)
          ? moveToPinBorder(fullOrder(), id, (x) => pins.has(x))
          : moveWithin(
              fullOrder(),
              id,
              at.id,
              // the saved list is in normal order, when reversed a left edge means after
              sortDir === "desc" ? (at.side === "before" ? "after" : "before") : at.side,
            );
      persistOrderRef.current(next);
    },
    [fullOrder, pins, sortDir],
  );
  // keep the listener effect stable
  const persistOrderRef = useRef(persistOrder);
  persistOrderRef.current = persistOrder;

  const onCardPointerDown = (e: React.PointerEvent, id: string) => {
    if (!canDrag || e.button !== 0 || !e.isPrimary) return;
    drag.current = { id, x: e.clientX, y: e.clientY, active: false };
  };

  /**
   * Card dragging uses pointer events, not HTML5 drag and drop (WebView2 swallows
   * in-page drags because file dropping is enabled). Starts after a few pixels,
   * so a click still opens the creator.
   */
  useEffect(() => {
    if (!canDrag) return;
    // which screen edge the pointer is at (auto-scroll)
    let edge = 0;
    let raf = 0;
    const scroller = () => document.querySelector("main");
    const tick = () => {
      raf = 0;
      if (!drag.current?.active) return;
      if (edge !== 0) scroller()?.scrollBy({ top: edge * 18 });
      raf = requestAnimationFrame(tick);
    };

    const onMove = (e: PointerEvent) => {
      const d = drag.current;
      if (!d) return;
      if (!d.active) {
        if (Math.hypot(e.clientX - d.x, e.clientY - d.y) < 6) return;
        d.active = true;
        setDragId(d.id);
        document.body.style.userSelect = "none";
        raf = requestAnimationFrame(tick);
      }
      const card = (document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null)?.closest(
        "[data-card-id]",
      ) as HTMLElement | null;
      const overId = card?.dataset.cardId;
      if (!card || !overId || overId === d.id) {
        setDrop(null);
      } else {
        const r = card.getBoundingClientRect();
        const side = e.clientX < r.left + r.width / 2 ? "before" : "after";
        if (dropAtRef.current?.id !== overId || dropAtRef.current.side !== side) {
          setDrop({ id: overId, side });
        }
      }
      const view = scroller()?.getBoundingClientRect();
      edge = !view ? 0 : e.clientY < view.top + 70 ? -1 : e.clientY > view.bottom - 70 ? 1 : 0;
    };

    const onUp = () => {
      const d = drag.current;
      drag.current = null;
      edge = 0;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      if (d?.active) {
        document.body.style.userSelect = "";
        commitDrop(d.id);
        // swallow the click after the drop, otherwise the creator opens
        const swallow = (ev: MouseEvent) => {
          ev.preventDefault();
          ev.stopPropagation();
        };
        window.addEventListener("click", swallow, true);
        setTimeout(() => window.removeEventListener("click", swallow, true), 0);
      }
      setDragId(null);
      setDrop(null);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      document.body.style.userSelect = "";
      drag.current = null;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [canDrag, commitDrop]);

  // base list for the side panels (SFW aware, no hidden creators)
  const visibleAll = useMemo(
    () =>
      artists.filter(
        (a) =>
          !(sfw && tagsAreNsfw(a.tags)) &&
          (showHidden || !a.hidden) &&
          !!a.graveyard === graveyard,
      ),
    [artists, sfw, showHidden, graveyard],
  );
  // recently added/updated, newest first
  const recent = useMemo(
    () =>
      visibleAll
        .filter((a) => a.updatedAt)
        .sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""))
        .slice(0, 20),
    [visibleAll],
  );
  // random artist from the list on screen (respects the filters)
  const surprise = () => {
    if (filtered.length === 0) return;
    const a = filtered[Math.floor(Math.random() * filtered.length)];
    navigate(`/artist/${a.id}`);
  };

  // direction label per field (A-Z / Newest / Largest...)
  const dirLabel =
    sortField === "custom"
      ? sortDir === "asc" ? "Arranged" : "Reversed"
      : sortField === "edited"
      ? sortDir === "asc" ? "Oldest" : "Newest"
      : sortField === "size"
        ? sortDir === "asc" ? "Smallest" : "Largest"
        : sortField === "class"
          ? sortDir === "asc" ? "Top class" : "Low class"
          : sortDir === "asc" ? "A→Z" : "Z→A";
  // count next to "Creators"
  const typeCount = useMemo(
    () =>
      typeFilter.size === 0
        ? visibleAll.length
        : visibleAll.filter(matchesType).length,
    [visibleAll, typeFilter, matchesType],
  );

  return (
    <Layout
      onLock={onLock}
      search={{ value: q, onChange: setQ, placeholder: t("Search Creators…") }}
    >
      <div className="w-full px-6 pb-8 pt-5 2xl:px-10">
        {/* the filter bar collapses in cinema mode so the whole grid moves up */}
        <AnimatePresence initial={false}>
        {!minimal && (
        <motion.div
          key="filters"
          ref={filtersRef}
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: "auto", opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          // the fade ends a bit before the height, so the repaint happens during the
          // movement
          transition={{ duration: 0.3, ease: [0.4, 0, 0.2, 1], opacity: { duration: 0.18 } }}
          onAnimationComplete={unclipFilters}
          style={FILTERS_STYLE}
        >
        <div
          className={cn(
            // relative z-20 so the dropdowns are above the cards
            "relative z-20 mb-5 flex flex-wrap items-center justify-between gap-3",
            // iridescent: light frosted panel, translateZ(0) against black flicker
            irid &&
              "rounded-2xl border border-white/12 bg-zinc-900/28 px-4 py-2.5 backdrop-blur-xl [transform:translateZ(0)]",
          )}
        >
          <div className="relative" ref={typeRef}>
            <button
              onClick={() => setTypeOpen((o) => !o)}
              className="group flex items-center gap-2 rounded-lg outline-none"
              title={t("Filter by creator type")}
            >
              <h1 className="text-3xl font-bold leading-none tracking-tight text-zinc-50">
                {graveyard ? t("Graveyard") : t("Creators")}{" "}
                <span className="text-xl font-medium text-white">({typeCount})</span>
              </h1>
              <ChevronDown
                className={cn(
                  "h-5 w-5 text-white transition-transform group-hover:text-brand-300",
                  typeOpen && "rotate-180 text-brand-300",
                )}
              />
              {typeFilter.size > 0 && (
                <span className="flex -space-x-1.5">
                  {CREATOR_TYPES.filter((ct) => typeFilter.has(ct.key)).map((ct) => (
                    <span
                      key={ct.key}
                      className={cn(
                        "flex h-6 w-6 items-center justify-center rounded-full border",
                        irid
                          ? "border-white/30 bg-white/15 backdrop-blur"
                          : "border-zinc-900 bg-zinc-800",
                      )}
                      title={t(ct.label)}
                    >
                      <ct.Icon className={cn("h-3.5 w-3.5", ct.color)} />
                    </span>
                  ))}
                  {typeFilter.has("none") && (
                    // dash for "no type"
                    <span
                      className={cn(
                        "flex h-6 w-6 items-center justify-center rounded-full border text-xs font-medium text-zinc-300",
                        irid
                          ? "border-white/30 bg-white/15 backdrop-blur"
                          : "border-zinc-900 bg-zinc-800",
                      )}
                      title={t("No type")}
                    >
                      —
                    </span>
                  )}
                </span>
              )}
            </button>
            {typeOpen && (
              <>
                <div className={menuClass("w-52", "mt-2")}>
                  <SortItem
                    label={t("All creators")}
                    active={typeFilter.size === 0}
                    icon={<Users className="h-4 w-4 text-brand-300" />}
                    onClick={() => {
                      setTypeFilter(new Set());
                      setTypeOpen(false);
                    }}
                  />
                  <div className="my-1 h-px bg-brand-500/20" />
                  {CREATOR_TYPES.map((ct) => (
                    <SortItem
                      key={ct.key}
                      label={t(ct.label)}
                      active={typeFilter.has(ct.key)}
                      icon={<ct.Icon className={cn("h-4 w-4", ct.color)} />}
                      onClick={() => toggleType(ct.key)}
                    />
                  ))}
                  <div className="my-1 h-px bg-brand-500/20" />
                  <SortItem
                    label={t("No type")}
                    active={typeFilter.has("none")}
                    onClick={() => toggleType("none")}
                  />
                </div>
              </>
            )}
          </div>

          {/* sort, direction, class in the middle */}
          {artists.length > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              <div
                className={cn(
                  "inline-flex items-stretch rounded-xl border text-sm",
                  irid ? "border-white/15 bg-white/10" : "border-brand-500/30 bg-brand-500/10",
                )}
              >
                {/* field */}
                <div className="relative" ref={sortRef}>
                  <button
                    onClick={() => {
                      setSortOpen((o) => !o);
                      setClassOpen(false);
                    }}
                    className="flex h-full items-center gap-2 rounded-l-xl px-3.5 py-2 text-zinc-200 transition-colors hover:bg-brand-500/20"
                    title={
                      canDrag
                        ? t("Sort: Custom — drag the cards into any order (it's remembered)")
                        : t("Sort by — “Custom” lets you arrange the cards by hand")
                    }
                  >
                    {canDrag ? (
                      <GripVertical className={cn("h-4 w-4 text-brand-300", irid && iriSym)} />
                    ) : (
                      <ArrowDownUp className={cn("h-4 w-4 text-brand-300", irid && iriSym)} />
                    )}
                    <span className={cn("text-zinc-400", irid && iriLabel)}>{t("Sort:")}</span>
                    <span className="font-medium text-zinc-100">{t(FIELD_LABELS[sortField])}</span>
                  </button>
                  {sortOpen && (
                    <>
                      <div className={menuClass("w-44", "mt-1.5")}>
                        {SORT_FIELDS.map((f) => (
                          <SortItem
                            key={f}
                            label={t(FIELD_LABELS[f])}
                            active={sortField === f}
                            icon={(() => {
                              const Icon = FIELD_ICONS[f];
                              return <Icon className="h-4 w-4 text-brand-300" />;
                            })()}
                            onClick={() => {
                              chooseSort(f);
                              setSortOpen(false);
                            }}
                          />
                        ))}
                      </div>
                    </>
                  )}
                </div>

                <div className="w-px self-stretch bg-brand-500/25" />

                {/* direction */}
                <button
                  onClick={() => setSortDir((d) => (d === "asc" ? "desc" : "asc"))}
                  className="flex items-center gap-1.5 px-3.5 py-2 text-zinc-200 transition-colors hover:bg-brand-500/20"
                  title={t("Reverse order")}
                >
                  {sortDir === "asc" ? (
                    <ArrowUp className={cn("h-4 w-4 text-brand-300", irid && iriSym)} />
                  ) : (
                    <ArrowDown className={cn("h-4 w-4 text-brand-300", irid && iriSym)} />
                  )}
                  <span className="font-medium text-zinc-100">{t(dirLabel)}</span>
                </button>

                <div className="w-px self-stretch bg-brand-500/25" />

                {/* class filter */}
                <div className="relative" ref={classRef}>
                  <button
                    onClick={() => {
                      setClassOpen((o) => !o);
                      setSortOpen(false);
                    }}
                    className="flex h-full items-center gap-2 rounded-r-xl px-3.5 py-2 text-zinc-200 transition-colors hover:bg-brand-500/20"
                    title={t("Show only the classes you toggle on (others are hidden)")}
                  >
                    <Tags className={cn("h-4 w-4 text-brand-300", irid && iriSym)} />
                    <span className={cn("text-zinc-400", irid && iriLabel)}>{t("Class:")}</span>
                    {classFilter.size === 0 ? (
                      <span className="font-medium text-zinc-100">{t("All")}</span>
                    ) : (
                      <span className="flex items-center gap-1">
                        {artistTags()
                          .filter((t) => classFilter.has(t.key))
                          .map((t) => (
                            <t.Icon key={t.key} className={`h-4 w-4 ${t.color}`} fill="currentColor" />
                          ))}
                        {classFilter.has("none") && (
                          <span className="text-xs font-medium text-zinc-300">—</span>
                        )}
                      </span>
                    )}
                  </button>
                  {classOpen && (
                    <>
                      <div className={menuClass("w-44", "mt-1.5")}>
                        <SortItem
                          label={t("All classes")}
                          active={classFilter.size === 0}
                          icon={<Tags className="h-4 w-4 text-brand-300" />}
                          onClick={() => setClassFilter(new Set())}
                        />
                        <div className="my-1 h-px bg-brand-500/20" />
                        {artistTags().map(({ key, label, color, Icon }) => (
                          <SortItem
                            key={key}
                            label={t(label)}
                            active={classFilter.has(key)}
                            icon={<Icon className={`h-4 w-4 ${color}`} fill="currentColor" />}
                            onClick={() => toggleClass(key)}
                          />
                        ))}
                        <div className="my-1 h-px bg-brand-500/20" />
                        <SortItem
                          label={t("Unclassed")}
                          active={classFilter.has("none")}
                          onClick={() => toggleClass("none")}
                        />
                      </div>
                    </>
                  )}
                </div>
              </div>

              <Button
                variant="outline"
                size="icon"
                onClick={surprise}
                title={t("Surprise me — open a random creator")}
                className={iriOutline}
              >
                <Dices className="h-4 w-4" />
              </Button>
            </div>
          )}

          <div className="flex items-center gap-2">
            {artists.length > 0 && (
              <>
                <Button
                  variant="outline"
                  size="icon"
                  onClick={() => setStatsOpen(true)}
                  title={t("Stats")}
                  className={iriOutline}
                >
                  <BarChart3 className="h-4 w-4" />
                </Button>
                <Button
                  variant="outline"
                  size="icon"
                  onClick={() => setRecentOpen((o) => !o)}
                  title={t("Recently updated")}
                  className={iriOutline}
                >
                  <History className="h-4 w-4" />
                </Button>
              </>
            )}
            <ImportFolderButton className={iriOutline} />
            <Button
              // sakura glass on outline (primary's !important would paint over it)
              variant={sakura ? "outline" : "primary"}
              onClick={() => setAddOpen(true)}
              disabled={!backed}
              className={cn(iriLead, sakura && sakChipLead)}
            >
              <Plus className="h-4 w-4" />
              {t("Create Card")}
            </Button>
          </div>
        </div>
        </motion.div>
        )}
        </AnimatePresence>

        <NeedsReviewBanner />

        {loading ? (
          <div className="grid place-items-center py-24 text-zinc-400">
            <Loader2 className="h-8 w-8 animate-spin text-brand-400" />
            <p className="mt-3 text-sm">{t("Loading your library…")}</p>
          </div>
        ) : artists.length === 0 ? (
          <div className="grid place-items-center gap-4 rounded-2xl border border-dashed border-zinc-800 py-24 text-center">
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-zinc-800 text-zinc-400">
              <UserPlus className="h-6 w-6" />
            </div>
            <div>
              <p className="font-medium text-zinc-200">{t("No content yet")}</p>
              <p className="mt-1 text-sm text-zinc-500">
                {t("Create a creator, or use “Import folder” above to bulk-import one.")}
              </p>
            </div>
            {/* same button as in the corner */}
            <Button
              variant={sakura ? "outline" : "primary"}
              onClick={() => setAddOpen(true)}
              disabled={!backed}
              className={cn(iriLead, sakura && sakChipLead)}
            >
              <UserPlus className="h-4 w-4" />
              {t("Create Card")}
            </Button>
          </div>
        ) : filtered.length === 0 ? (
          <div className="grid place-items-center rounded-2xl border border-dashed border-zinc-800 py-24 text-center">
            <p className="text-zinc-400">
              {q
                ? tf("No creators match “{q}”.", { q })
                : typeFilter.size > 0
                  ? t("No creators of the selected type.")
                  : graveyard
                    ? t("The graveyard is empty. Right-click a creator card to move it here.")
                    : t("No creators to show.")}
            </p>
          </div>
        ) : (
          <VirtualGrid
            items={filtered}
            minColWidth={cardSize}
            aspectRatio={cardShape.ratioHW}
            gap={16}
            containerRef={gridRef}
            // isolate keeps the card pins below the filter bar
            className="isolate"
            // cards glide to their new spot on sort/filter/add/remove
            animate
            keyOf={(a) => a.id}
            renderItem={(a, { index, cols }) => {
              const going = fade.leaving.has(a.id);
              const coming = fade.entering.has(a.id);
              return (
                <div
                  // the wrapper always stays, otherwise the card remounts and reloads its
                  // cover
                  className={cn("grid", going && "card-leaving", coming && "card-entering")}
                  // short stagger so it clears/fills like a wave
                  style={
                    going || coming
                      ? { animationDelay: `${Math.min(index * 24, 140)}ms` }
                      : undefined
                  }
                >
                  {canDrag ? (
                // custom sort: the card is the drag handle, native image drag is turned off
                <div
                  data-card-id={a.id}
                  onPointerDown={(e) => onCardPointerDown(e, a.id)}
                  className={cn(
                    "relative grid cursor-grab select-none [&_img]:[-webkit-user-drag:none]",
                    dragId === a.id && "cursor-grabbing opacity-40",
                  )}
                >
                  <ArtistCard
                    artist={a}
                    holoTier={irid ? holoTierOf(a.id) : 0}
                    aspect={cardShape.aspect}
                    // diagonal of this tile, for the cyberpunk glitch wave
                    wave={Math.floor(index / cols) + (index % cols)}
                  />
                  {dropAt?.id === a.id && (
                    <span
                      className={cn(
                        "pointer-events-none absolute inset-y-1 w-[3px] rounded-full",
                        // dropped across the pin border: goes to the end of the pins (amber
                        // = not exactly here)
                        dragId && pins.has(dragId) !== pins.has(a.id)
                          ? "bg-amber-400 shadow-[0_0_10px_rgba(251,191,36,0.9)]"
                          : "bg-brand-400 shadow-[0_0_10px_rgba(168,85,247,0.9)]",
                        dropAt.side === "before" ? "-left-2.5" : "-right-2.5",
                      )}
                    />
                  )}
                </div>
              ) : (
                <ArtistCard
                  artist={a}
                  holoTier={irid ? holoTierOf(a.id) : 0}
                  aspect={cardShape.aspect}
                  wave={Math.floor(index / cols) + (index % cols)}
                />
              )}
                </div>
              );
            }}
          />
        )}
      </div>

      {addOpen && <AddArtistSheet onClose={() => setAddOpen(false)} />}
      {statsOpen && <StatsPanel onClose={() => setStatsOpen(false)} />}
      <AnimatePresence>
        {recentOpen && (
          <RecentPanel
            items={recent}
            onClose={() => setRecentOpen(false)}
            onPick={(id) => {
              setRecentOpen(false);
              navigate(`/artist/${id}`);
            }}
          />
        )}
      </AnimatePresence>
    </Layout>
  );
}

function SortItem({
  label,
  active,
  icon,
  onClick,
}: {
  label: string;
  active: boolean;
  icon?: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm transition-colors",
        active
          ? "bg-brand-500/15 text-brand-100"
          : "text-zinc-200 hover:bg-brand-500/15 hover:text-brand-100",
      )}
    >
      <span className="flex h-4 w-4 items-center justify-center">{icon}</span>
      <span className="flex-1">{label}</span>
      {active && <Check className="h-3.5 w-3.5 text-brand-300" />}
    </button>
  );
}
