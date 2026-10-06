import { useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import {
  X,
  FolderInput,
  Images,
  Zap,
  AlertTriangle,
  CalendarDays,
  Hash,
  CalendarOff,
  CornerDownRight,
  UserPlus,
  Sparkles,
  Undo2,
  FolderTree,
  ArrowUpRight,
} from "lucide-react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { ThemedSelect } from "@/components/ThemedSelect";
import { ImportClashDialog } from "@/components/ImportClashDialog";
import { ImportStatsLine } from "@/components/ImportStatsLine";
import * as api from "@/api/library";
import type { ImportPlan, ResolvedReward, StyleChoice } from "@/api/library";
import type { ReleaseStyle } from "@/types";
import { PLATFORMS } from "@/lib/platforms";
import { usePlatformOptions, addPlatform as registerPlatform } from "@/lib/platformRegistry";
import { useData } from "@/store";
import { useActions } from "@/actions";
import { useAccent } from "@/lib/theme";
import { useDialogTheme } from "@/lib/dialogTheme";
import { useStripCreator, stripHandles } from "@/lib/stripCreator";
import { cn } from "@/lib/utils";
import { useT, useTf, useTp } from "@/lib/i18n";

const MISC = "__misc__"; // sentinel select value meaning the "Misc" bucket
// "Misc" files the reward under a real "Misc" platform (own tab/folder): "I don't know
// the platform and won't look it up". It stays there, no banner.
const MISC_PLATFORM = "Misc";
// "Unsorted" = no platform yet, still to do: the "need a platform" banner asks for it.
// Also where anything lands that no platform was found for.
const UNSORTED = "__unsorted__";
// what the backend calls "no platform" in a per-platform style override
const UNSORTED_PLATFORM = "Unsorted";

/**
 * Text input that keeps a local draft while focused and only saves on blur or
 * Enter (Escape reverts). Saving on every key would regroup the tree, remount
 * the input and lose the cursor.
 */
/** Was the last key Tab? (see onBlur) */
let leftByTab = false;

function CommitInput({
  value,
  onCommit,
  sanitize,
  normalize,
  fieldId,
  ...rest
}: {
  value: string;
  onCommit: (v: string) => void;
  /** Optional filter per key (e.g. digits only). */
  sanitize?: (v: string) => string;
  /** Optional clean-up on save (e.g. "26" -> "2026"). */
  normalize?: (v: string) => string;
  /** data-field id so focus can be restored after a remount. */
  fieldId?: string;
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, "value" | "onChange">) {
  const [draft, setDraft] = useState(value);
  const [focused, setFocused] = useState(false);
  // take outside changes while not focused
  useEffect(() => {
    if (!focused) setDraft(value);
  }, [value, focused]);
  return (
    <input
      {...rest}
      data-field={fieldId}
      value={draft}
      onChange={(e) => setDraft(sanitize ? sanitize(e.target.value) : e.target.value)}
      onFocus={(e) => {
        setFocused(true);
        rest.onFocus?.(e);
      }}
      onBlur={(e) => {
        setFocused(false);
        const v = normalize ? normalize(draft) : draft;
        if (v !== draft) setDraft(v);
        if (v !== value) {
          onCommit(v);
          // saving can regroup the tree and remount the field that was clicked/tabbed to,
          // so put focus back on its replacement (found by data-field)
          const nextId = (e.relatedTarget as HTMLElement | null)?.getAttribute("data-field");
          const byTab = leftByTab;
          if (nextId) {
            const esc = nextId.replace(/(["\\])/g, "\\$1");
            setTimeout(() => {
              const el = document.querySelector<HTMLElement>(`[data-field="${esc}"]`);
              if (!el || document.activeElement === el) return;
              el.focus();
              // if it was tabbed into, select the text again
              if (byTab && el instanceof HTMLInputElement) el.select();
            }, 0);
          }
        }
        rest.onBlur?.(e);
      }}
      onKeyDown={(e) => {
        leftByTab = e.key === "Tab";
        if (e.key === "Enter") {
          e.currentTarget.blur();
        } else if (e.key === "Escape") {
          setDraft(value);
          e.currentTarget.blur();
        }
        rest.onKeyDown?.(e);
      }}
    />
  );
}

/** Two-digit year = this century: "26" -> "2026". */
function expandYear(v: string): string {
  return /^\d{2}$/.test(v) ? `20${v}` : v;
}

/** Remove trailing slashes and return the last path part. */
function baseName(p: string): string {
  const parts = p.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || p;
}
/** Parent folder of a path. */
function parentDir(p: string): string {
  return p.replace(/[\\/]+$/, "").replace(/[\\/][^\\/]+$/, "");
}
/** Deepest folder that contains all paths. Null if they only share a drive letter. */
function commonAncestor(paths: string[]): string | null {
  if (paths.length === 0) return null;
  const split = paths.map((p) => p.replace(/[\\/]+$/, "").split(/[\\/]+/));
  const first = split[0];
  let k = first.length;
  for (const parts of split) {
    let i = 0;
    while (i < k && i < parts.length && parts[i] === first[i]) i++;
    k = i;
  }
  if (k < 2) return null;
  const sep = paths[0].includes("\\") ? "\\" : "/";
  return first.slice(0, k).join(sep);
}
const pad2 = (n: number) => String(n).padStart(2, "0");

/** One reward being edited (the preview tree is built from these). */
type DraftRow = {
  /** Source folder (the row's id). */
  folder: string;
  /** The artist detection found. */
  origArtist: string;
  creator: string;
  platform: string; // MISC / UNSORTED sentinel or a platform name
  title: string;
  category: string | null;
  root: boolean;
  /** Import as an extra: stays in its period but doesn't stand in for it (month card). */
  extra: boolean;
  imageCount: number;
  /** What the analyzer saw (used again when the style flips back). */
  det: { year: number | null; month: number | null; number: number | null };
  /** Editable period fields (text, can be empty). */
  year: string;
  month: string;
  num: string;
  /**
   * Parent reward folder this row is folded into (shown as a group inside it).
   * Null = its own reward.
   */
  mergedInto: string | null;
  /** Row created by "bundle into ONE reward". Unbundling removes it again. */
  synthetic?: boolean;
  /** The creator before "this is a creator, not a reward" was clicked (for undo). */
  promotedFrom?: string | null;
};

const STYLE_META: { key: ReleaseStyle; label: string; icon: typeof CalendarDays; hint: string }[] = [
  { key: "monthly", label: "Monthly", icon: CalendarDays, hint: "Periods are year + month (2026-02)" },
  { key: "numbered", label: "Numbered drops", icon: Hash, hint: "Each drop is its own card (#51, #52 …) — no dates" },
  { key: "none", label: "No schedule", icon: CalendarOff, hint: "Just rewards — no period cards at all" },
];

/**
 * Import review on one screen: pick each creator's release style (Monthly /
 * Numbered / No schedule) and see a live preview tree (Creator -> Period -> Reward).
 * Fix things inline: rename, change a period, make it root content, or turn
 * a reward into its own creator.
 */
export function ImportReviewTree({
  plan,
  busy,
  lockedArtist,
  sourcePath,
  allowCombine = true,
  defaultStyle,
  defaultPlatform,
  defaultYear,
  defaultMonth,
  defaultNumber,
  onConfirm,
  onCancel,
}: {
  plan: ImportPlan;
  busy: boolean;
  /** If set, everything goes to this artist and the name can't be changed. */
  lockedArtist?: string;
  /** The dropped/picked folder. Enables "one reward" + Quick import. */
  sourcePath?: string;
  /** Allow merging everything into one reward (off for a whole artist tree). */
  allowCombine?: boolean;
  /** Pre-select this release style. */
  defaultStyle?: ReleaseStyle;
  /** Pre-select this platform where none was detected. */
  defaultPlatform?: string;
  /** Pre-fill year/month/drop where none was detected. */
  defaultYear?: number;
  defaultMonth?: number;
  defaultNumber?: number;
  onConfirm: (
    rewards: ResolvedReward[],
    /** keepArchive: a merge didn't get every file in, so the dropped archive stays */
    opts: { styles: StyleChoice[]; keepArchive?: boolean },
  ) => void;
  onCancel: () => void;
}) {
  const t = useT();
  const tf = useTf();
  const tp = useTp();
  const root = sourcePath ? sourcePath.replace(/[\\/]+$/, "") : "";
  const rootName = root ? baseName(root) : "";

  const { artists, refresh } = useData();
  const navigate = useNavigate();
  const { fillRewardInteractive, showToast } = useActions();
  const accent = useAccent();
  // premium themes get their dialog surface, standard ones the dark panel
  const panelClass =
    accent === "cyberpunk"
      ? "rounded-none border border-[#fcee0a]/70 bg-zinc-950/95 ring-1 ring-inset ring-[#00e5ff]/15 shadow-[0_0_26px_rgba(252,238,10,0.18)] [clip-path:polygon(0_0,100%_0,100%_calc(100%-14px),calc(100%-14px)_100%,0_100%)]"
      : accent === "iridescent"
        ? "iri-menu relative rounded-2xl border border-white/15 bg-zinc-900/80 ring-1 ring-inset ring-white/10 backdrop-blur-2xl [transform:translateZ(0)]"
        : accent === "sakura"
          ? "sak-card rounded-2xl"
          : "rounded-2xl border border-zinc-800 bg-zinc-900";
  // inside styles from the dialog theme too (creator box, placeholders, dividers)
  const dlg = useDialogTheme();
  const sakura = accent === "sakura";
  // old names kept for these two
  const boxClass = dlg.box;
  const softClass = dlg.soft;

  /* ---- creator matching (carried over from the old review) ------------- */

  const normName = (s: string) => s.toLowerCase().replace(/[\s_.\-]+/g, "");
  /** Han, kana, hangul - one character can be a whole word. */
  const CJK = /[぀-ヿ㐀-䶿一-鿿豈-﫿가-힯]/;
  /**
   * Min handle length for matching. Latin: 3 (two letters appear everywhere),
   * CJK: 2 (two characters are a whole name).
   */
  const minHandle = (needle: string) => (CJK.test(needle) ? 2 : 3);
  // every creator name and alias -> the real name, so an alias fills in the real name
  const nameIndex = useMemo(() => {
    const out: { needle: string; canonical: string }[] = [];
    for (const a of artists) {
      const add = (raw?: string) => {
        const needle = normName(raw ?? "");
        if (needle.length >= minHandle(needle)) out.push({ needle, canonical: a.name });
      };
      add(a.name);
      for (const al of a.aliases ?? []) add(al);
    }
    return out;
  }, [artists]);
  /** The creator whose name/alias appears in texts (longest match wins), else null. */
  const matchCreator = (...texts: (string | null | undefined)[]): string | null => {
    const hay = texts.filter(Boolean).map((t) => normName(t as string)).join(" ");
    if (!hay) return null;
    let best: { canonical: string; len: number } | null = null;
    for (const { needle, canonical } of nameIndex) {
      if (hay.includes(needle) && (!best || needle.length > best.len)) {
        best = { canonical, len: needle.length };
      }
    }
    return best?.canonical ?? null;
  };
  const stripCreator = useStripCreator();
  /** All handles of this one creator (name + aliases, normalized). */
  const handlesOf = (canonical: string): string[] => {
    const out = nameIndex.filter((e) => e.canonical === canonical).map((e) => e.needle);
    // a creator not in the library yet: try the detected name directly
    const own = normName(canonical);
    if (own.length >= minHandle(own)) out.push(own);
    return out;
  };
  /** The reward name without the creator (if the setting is on), see lib/stripCreator. */
  const cleanTitle = (title: string, creator: string): string =>
    stripCreator ? stripHandles(title, handlesOf(creator)) : title;

  /**
   * The detected artist, unless the name reveals a known creator (then use the real name).
   */
  const resolveArtist = (
    detected: string | undefined,
    ...texts: (string | null | undefined)[]
  ): string => {
    const d = (detected ?? "").trim();
    if (d) {
      const exact = nameIndex.find((e) => e.needle === normName(d));
      if (exact) return exact.canonical;
    }
    return matchCreator(d, ...texts) ?? d;
  };
  const lastImportKey = (name: string) => `micoll.lastImportPlatform.${normName(name)}`;
  /**
   * Platform last used for this creator (saved on the last import, else the newest
   * period's).
   */
  const lastPlatformFor = (artistName: string): string | null => {
    const norm = normName(artistName);
    if (!norm) return null;
    try {
      const saved = localStorage.getItem(lastImportKey(artistName));
      if (saved) return saved;
    } catch {
      /* ignore storage errors */
    }
    const a = artists.find((x) => normName(x.name) === norm);
    if (!a) return null;
    let best: { plat: string; y: number; m: number } | null = null;
    for (const p of a.platforms) {
      if (p.name === "Unsorted") continue;
      for (const mo of p.months) {
        const y = mo.year ?? -1;
        const m = mo.month ?? 0;
        if (!best || y > best.y || (y === best.y && m > best.m)) best = { plat: p.name, y, m };
      }
    }
    return best?.plat ?? null;
  };
  const rememberPlatforms = (rewards: ResolvedReward[]) => {
    try {
      for (const rw of rewards) {
        if (rw.artist && rw.platform) localStorage.setItem(lastImportKey(rw.artist), rw.platform);
      }
    } catch {
      /* ignore storage errors */
    }
  };

  /**
   * The creator's saved release style for the platform of this import.
   * The platform setting wins over the artist setting.
   */
  const storedStyle = (name: string, platform?: string): ReleaseStyle | null => {
    const a = artists.find((x) => normName(x.name) === normName(name));
    if (!a) return null;
    // Misc can have its own style override too
    const plat = platform === MISC ? MISC_PLATFORM : platform === UNSORTED ? undefined : platform;
    const p = plat
      ? a.platforms.find((x) => x.name.toLowerCase() === plat.toLowerCase())
      : undefined;
    return ((p?.releaseStyle ?? a.releaseStyle) as ReleaseStyle | undefined) ?? null;
  };

  /**
   * The platform a row lands on (same as the draft rows use).
   * "Misc" is mapped back to the picker's sentinel so the field isn't empty next time.
   * Nothing known -> Unsorted (still to do), not Misc.
   */
  const platformFor = (detected: string | null | undefined, creator: string): string => {
    const p = detected ?? defaultPlatform ?? lastPlatformFor(creator) ?? UNSORTED;
    const low = p.trim().toLowerCase();
    // dropped on the Unsorted tab -> the sentinel, not a platform called "Unsorted"
    if (low === UNSORTED_PLATFORM.toLowerCase()) return UNSORTED;
    return low === MISC_PLATFORM.toLowerCase() ? MISC : p;
  };

  /**
   * Style from where it was dropped: a year/month card = monthly, a drop card = numbered.
   * This wins over the creator's setting.
   */
  const droppedStyle: ReleaseStyle | null =
    defaultYear != null || defaultMonth != null
      ? "monthly"
      : defaultNumber != null
        ? "numbered"
        : null;

  /* ---- draft state ------------------------------------------------------ */

  /**
   * Style guess for a new creator: numbered or monthly if the scan found that,
   * "none" falls back to the default (monthly).
   */
  const proposalFor = (origArtist: string): ReleaseStyle | null => {
    const s = plan.artists?.find((a) => a.name === origArtist)?.proposedStyle as ReleaseStyle | undefined;
    return s && s !== "none" ? s : null;
  };

  const [rows, setRows] = useState<DraftRow[]>(() => {
    const initial: DraftRow[] = plan.rewards.map((r) => {
      const texts = [r.title, r.folder];
      const creator = lockedArtist ?? (resolveArtist(r.artist, ...texts) || r.artist);
      return {
        folder: r.folder,
        origArtist: r.artist,
        creator,
        platform: platformFor(r.platform, creator),
        title: cleanTitle(r.title, creator),
        category: r.category,
        root: r.root,
        extra: false,
        imageCount: r.imageCount,
        det: { year: r.year, month: r.month, number: r.number },
        year: "",
        month: "",
        num: "",
        mergedInto: null,
      };
    });
    // a reward folder with detected rewards inside: fold them into the parent by default.
    // Not for dated root galleries ("2025-08"), there the subfolders are real rewards.
    const byFolder = new Map(initial.map((r) => [r.folder, r]));
    for (const row of initial) {
      const parent = byFolder.get(parentDir(row.folder));
      if (parent && !parent.root) row.mergedInto = parent.folder;
    }
    // fill the period fields from each creator's style
    const styleOfCreator = new Map<string, ReleaseStyle>();
    for (const row of initial) {
      const k = normName(row.creator);
      if (!styleOfCreator.has(k)) {
        styleOfCreator.set(
          k,
          droppedStyle ??
            storedStyle(row.creator, row.platform) ??
            proposalFor(row.origArtist) ??
            defaultStyle ??
            "monthly",
        );
      }
    }
    seedPeriods(initial, styleOfCreator);
    return initial;
  });

  /** Release style per creator (by normalized name). */
  const [styles, setStyles] = useState<Record<string, ReleaseStyle>>(() => {
    const out: Record<string, ReleaseStyle> = {};
    for (const r of plan.rewards) {
      const creator = lockedArtist ?? (resolveArtist(r.artist, r.title, r.folder) || r.artist);
      const k = normName(creator);
      if (!(k in out)) {
        out[k] =
          droppedStyle ??
          storedStyle(creator, platformFor(r.platform, creator)) ??
          proposalFor(r.artist) ??
          defaultStyle ??
          "monthly";
      }
    }
    return out;
  });

  /** Fill each row's period fields from detection, based on the creator's style. */
  function seedPeriods(list: DraftRow[], styleOf: Map<string, ReleaseStyle>) {
    // numbered creators: rows without a number get the next free one
    const nextNum = new Map<string, number>();
    for (const row of list) {
      const s = styleOf.get(normName(row.creator)) ?? "monthly";
      if (s !== "numbered") continue;
      const k = normName(row.creator);
      const n = row.det.number ?? 0;
      nextNum.set(k, Math.max(nextNum.get(k) ?? 0, n));
    }
    for (const row of list) {
      const s = styleOf.get(normName(row.creator)) ?? "monthly";
      if (s === "monthly") {
        row.year = row.det.year != null ? String(row.det.year) : defaultYear != null ? String(defaultYear) : "";
        row.month = row.det.month != null ? String(row.det.month) : defaultMonth != null ? String(defaultMonth) : "";
        row.num = "";
      } else if (s === "numbered") {
        let n = row.det.number ?? defaultNumber ?? null;
        if (n == null) {
          const k = normName(row.creator);
          n = (nextNum.get(k) ?? 0) + 1;
          nextNum.set(k, n);
        }
        row.num = String(n);
        row.year = "";
        row.month = "";
      } else {
        row.year = "";
        row.month = "";
        row.num = "";
      }
    }
  }

  const styleOf = (creator: string): ReleaseStyle => styles[normName(creator)] ?? "monthly";

  const setCreatorStyle = (creator: string, s: ReleaseStyle) => {
    const k = normName(creator);
    setStyles((prev) => ({ ...prev, [k]: s }));
    // rebuild all rows of this creator from detection
    setRows((prev) => {
      const next = prev.map((r) => ({ ...r }));
      const styleMap = new Map<string, ReleaseStyle>();
      for (const r of next) styleMap.set(normName(r.creator), styleOf(r.creator));
      styleMap.set(k, s);
      seedPeriods(
        next.filter((r) => normName(r.creator) === k),
        styleMap,
      );
      return next;
    });
  };

  const patchRow = (folder: string, patch: Partial<DraftRow>) =>
    setRows((prev) => prev.map((r) => (r.folder === folder ? { ...r, ...patch } : r)));

  /** Set year/month on ALL rewards of a creator at once (single-month import). */
  const setCreatorPeriod = (creator: string, patch: { year?: string; month?: string }) =>
    setRows((prev) => prev.map((r) => (r.creator === creator ? { ...r, ...patch } : r)));

  /** Rename a whole creator group (merges if the name already exists). */
  const renameCreator = (from: string, to: string) => {
    setRows((prev) => prev.map((r) => (r.creator === from ? { ...r, creator: to } : r)));
    setStyles((prev) => {
      const next = { ...prev };
      const kFrom = normName(from);
      const kTo = normName(to);
      if (kTo && !(kTo in next)) {
        // an existing library creator brings its saved style
        next[kTo] = storedStyle(to) ?? next[kFrom] ?? "monthly";
      }
      return next;
    });
  };

  /** Turn a reward into its own creator (remembers where it came from for undo). */
  const promoteToCreator = (row: DraftRow) => {
    const name = row.title.trim() || baseName(row.folder);
    setRows((prev) =>
      prev.map((r) =>
        r.folder === row.folder
          ? { ...r, creator: name, promotedFrom: r.promotedFrom ?? r.creator }
          : r,
      ),
    );
    setStyles((prev) => {
      const k = normName(name);
      return k in prev ? prev : { ...prev, [k]: storedStyle(name) ?? "none" };
    });
  };

  /* ---- merge ("one reward") + open-as-cards + platforms ---------------- */

  // the dropped folder was split into sub-rewards, probably ONE reward with galleries
  const splitFromRoot =
    !!root && plan.rewards.length >= 2 && plan.rewards.every((r) => parentDir(r.folder) === root);
  const [combine, setCombine] = useState(false);
  const [combinedTitle, setCombinedTitle] = useState(rootName);

  const [customPlatforms, setCustomPlatforms] = useState<string[]>([]);
  const [newPlatform, setNewPlatform] = useState<string | null>(null);
  // the platform list + anything typed in this review
  const offered = usePlatformOptions(artists);
  const platformOptions = useMemo(() => {
    const out = [...offered];
    for (const p of customPlatforms) {
      const key = p.trim().toLowerCase();
      if (key && key !== "unsorted" && key !== "misc" && !out.some((x) => x.toLowerCase() === key)) {
        out.push(p);
      }
    }
    return out;
  }, [offered, customPlatforms]);
  const addCustomPlatform = (creator: string) => {
    const name = (newPlatform ?? "").trim();
    if (!name) {
      setNewPlatform(null);
      return;
    }
    registerPlatform(name); // persist it to the shared offered list (un-hides if removed)
    setCustomPlatforms((prev) =>
      prev.includes(name) || (PLATFORMS as readonly string[]).includes(name) ? prev : [...prev, name],
    );
    setRows((prev) => prev.map((r) => (r.creator === creator ? { ...r, platform: name } : r)));
    setNewPlatform(null);
  };

  /* ---- derived preview tree --------------------------------------------- */

  type PeriodNode = { label: string; key: string; rows: DraftRow[] };
  type CreatorNode = { creator: string; style: ReleaseStyle; periods: PeriodNode[]; count: number };

  const periodKeyOf = (r: DraftRow, s: ReleaseStyle): { key: string; label: string; sort: number } => {
    if (s === "numbered") {
      const n = r.num.trim();
      return n
        ? { key: `n${n}`, label: `#${n}`, sort: Number(n) }
        : { key: "unscheduled", label: t("Unscheduled"), sort: -1 };
    }
    if (s === "monthly") {
      const y = r.year.trim();
      const m = r.month.trim();
      if (y && m) return { key: `${y}-${m}`, label: `${y}-${pad2(Number(m))}`, sort: Number(y) * 100 + Number(m) };
      if (y) return { key: y, label: y, sort: Number(y) * 100 };
      return { key: "misc", label: t("Misc"), sort: -1 };
    }
    return { key: "unscheduled", label: t("Unscheduled"), sort: -1 };
  };

  /** Direct child rewards of a reward folder. */
  const childRowsOf = (folder: string) => rows.filter((r) => parentDir(r.folder) === folder);
  /** Rows folded into this parent. */
  const mergedChildrenOf = (folder: string) => rows.filter((r) => r.mergedInto === folder);
  /**
   * Fold / unfold a parent's child rewards. Unfolding a bundle also removes the bundle row.
   */
  const toggleFoldChildren = (parent: DraftRow, fold: boolean) =>
    setRows((prev) => {
      const next = prev.map((r) => {
        const hit = fold ? parentDir(r.folder) === parent.folder : r.mergedInto === parent.folder;
        return hit ? { ...r, mergedInto: fold ? parent.folder : null } : r;
      });
      return !fold && parent.synthetic ? next.filter((r) => r.folder !== parent.folder) : next;
    });

  /**
   * Bundle sibling rewards (in a folder that isn't a reward, e.g. characters in a
   * month folder) into ONE reward. Date-like folder names get the name of the folder above.
   */
  const bundleRows = (children: DraftRow[], parentFolder: string) => {
    const first = children[0];
    if (!first) return;
    const nm = baseName(parentFolder);
    const looksDate = /^\d{1,4}([-._ ]\d{1,4}){0,2}$/.test(nm.trim());
    const title = looksDate ? baseName(parentDir(parentFolder)) || nm : nm;
    const parent: DraftRow = {
      folder: parentFolder,
      origArtist: first.origArtist,
      creator: first.creator,
      platform: first.platform,
      title,
      category: first.category,
      root: false,
      extra: false,
      imageCount: children.reduce((s, c) => s + c.imageCount, 0),
      det: { ...first.det },
      year: first.year,
      month: first.month,
      num: first.num,
      mergedInto: null,
      synthetic: true,
    };
    const folded = new Set(children.map((c) => c.folder));
    setRows((prev) => [
      ...prev.map((r) => (folded.has(r.folder) ? { ...r, mergedInto: parentFolder } : r)),
      parent,
    ]);
  };
  /**
   * The parent's own file count: total minus unfolded children (folded ones stay included).
   */
  const ownImageCount = (r: DraftRow) => {
    const unfolded = childRowsOf(r.folder).filter((c) => c.mergedInto === null);
    return Math.max(0, r.imageCount - unfolded.reduce((s, c) => s + c.imageCount, 0));
  };

  const tree = useMemo<CreatorNode[]>(() => {
    const byCreator = new Map<string, DraftRow[]>();
    for (const r of rows) {
      if (r.mergedInto !== null) continue; // shown inside their parent row instead
      const arr = byCreator.get(r.creator) ?? [];
      arr.push(r);
      byCreator.set(r.creator, arr);
    }
    return [...byCreator.entries()].map(([creator, list]) => {
      const s = styleOf(creator);
      const periods = new Map<string, PeriodNode & { sort: number }>();
      for (const r of list) {
        const { key, label, sort } = periodKeyOf(r, s);
        const node = periods.get(key) ?? { label, key, rows: [], sort };
        node.rows.push(r);
        periods.set(key, node);
      }
      const sorted = [...periods.values()].sort((a, b) => b.sort - a.sort);
      return { creator, style: s, periods: sorted, count: list.length };
    });
    // styles is read via styleOf — include it so the tree re-derives on flips.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, styles]);

  const activeRows = rows.filter((r) => r.mergedInto === null);
  const outCount = combine && root ? 1 : activeRows.length;
  const combinedImages = activeRows.reduce((s, r) => s + ownImageCount(r), 0);

  /* ---- build + confirm --------------------------------------------------- */

  /** Picker value -> platform for the backend. null = Unsorted (no platform yet). */
  const platformOf = (v: string): string | null =>
    v === MISC ? MISC_PLATFORM : v && v !== UNSORTED ? v : null;

  const num = (v: string): number | null => {
    const t = v.trim();
    if (!t) return null;
    const n = parseInt(t, 10);
    return Number.isFinite(n) ? n : null;
  };

  const rowToResolved = (r: DraftRow): ResolvedReward => {
    const s = styleOf(r.creator);
    return {
      artist: r.creator.trim() || r.origArtist,
      platform: platformOf(r.platform),
      year: s === "monthly" ? num(r.year) : null,
      month: s === "monthly" ? num(r.month) : null,
      number: s === "numbered" ? num(r.num) : null,
      category: r.category,
      title: r.title.trim() || baseName(r.folder),
      folder: r.folder,
      root: r.root,
      extra: r.extra,
    };
  };

  const build = (): ResolvedReward[] => {
    if (combine && root) {
      const first = rows[0];
      const creator = (lockedArtist ?? first?.creator ?? rootName).trim() || rootName;
      const s = styleOf(creator);
      return [
        {
          artist: creator,
          platform: platformOf(first?.platform ?? UNSORTED),
          year: s === "monthly" ? num(first?.year ?? "") : null,
          month: s === "monthly" ? num(first?.month ?? "") : null,
          number: s === "numbered" ? num(first?.num ?? "") : null,
          category: null,
          title: combinedTitle.trim() || rootName,
          folder: root,
          root: rows.every((r) => r.root) && rows.length > 0 ? true : false,
          extra: activeRows.length > 0 && activeRows.every((r) => r.extra),
        },
      ];
    }
    // folded rows are skipped, the backend indexes the parent folder recursively
    return activeRows.map(rowToResolved);
  };

  /**
   * One StyleChoice per creator whose style changes. Existing creators get
   * per-platform overrides, new creators get the artist default.
   */
  const buildStyles = (rewards: ResolvedReward[]): StyleChoice[] => {
    const out: StyleChoice[] = [];
    const seen = new Set<string>();
    for (const rw of rewards) {
      const k = normName(rw.artist);
      if (seen.has(k)) continue;
      seen.add(k);
      const chosen = styles[k] ?? "monthly";
      // compare with the setting for this platform, not the artist row
      const stored = storedStyle(rw.artist, rw.platform ?? UNSORTED);
      if (stored === chosen) continue; // nothing to change
      if (stored == null) {
        out.push({ artist: rw.artist, style: chosen });
      } else {
        // existing creator, other style -> override only the platforms in this import
        const plats = new Set(
          rewards.filter((x) => normName(x.artist) === k).map((x) => x.platform ?? UNSORTED_PLATFORM),
        );
        for (const p of plats) out.push({ artist: rw.artist, style: chosen, platform: p });
      }
    }
    return out;
  };

  /* ---- name clashes ------------------------------------------------------ */

  // check for name clashes before writing anything (see ImportClashDialog),
  // otherwise the folders merge and the new card points to a deleted folder
  const [clashes, setClashes] = useState<api.ImportClash[] | null>(null);
  const [merging, setMerging] = useState(false);
  // the import waiting for the answer
  const pending = useRef<{ rewards: ResolvedReward[]; styles: StyleChoice[] } | null>(null);

  /** Check for clashes first, then import. */
  const submit = async (rewards: ResolvedReward[], styleList: StyleChoice[]) => {
    rememberPlatforms(rewards);
    let found: api.ImportClash[] = [];
    try {
      found = await api.importClashes(rewards);
    } catch (e) {
      // if the check fails, import anyway (old behavior)
      console.error("clash check failed", e);
    }
    if (found.length > 0) {
      pending.current = { rewards, styles: styleList };
      setClashes(found);
      return;
    }
    onConfirm(rewards, { styles: styleList });
  };

  const confirm = () => {
    const rewards = build();
    void submit(rewards, buildStyles(rewards));
  };

  /**
   * "Add to the existing reward": copy the clashing folders in, import the rest normally.
   */
  const mergeClashes = async () => {
    const pend = pending.current;
    const list = clashes;
    if (!pend || !list) return;
    // close it, the per-file prompt is above this dialog
    setClashes(null);
    setMerging(true);
    const done = new Set<string>();
    const kept: string[] = [];
    try {
      for (const c of list) {
        const report = await fillRewardInteractive(String(c.rewardId), [c.folder], {
          moveSources: true,
        });
        // null = cancelled in the per-file prompt -> cancel the whole import
        if (report === null) {
          setMerging(false);
          if (done.size > 0) await refresh();
          onCancel();
          showToast({
            tone: "warn",
            title: t("Import cancelled"),
            detail:
              done.size > 0
                ? tf("{n} were already added.", { n: tp("{n} rewards", done.size) })
                : t("Nothing was imported."),
          });
          return;
        }
        done.add(c.folder);
        kept.push(...(report.keptSources ?? []));
        // not every file arrived (skipped/failed): its folder stays, and says so
        if (!report.allArrived) kept.push(c.folder);
      }
    } catch (e) {
      setMerging(false);
      showToast({ tone: "error", title: t("Couldn’t add to the existing reward"), detail: `${e}` });
      return;
    }
    setMerging(false);
    const rest = pend.rewards.filter((r) => !done.has(r.folder));
    if (rest.length > 0) {
      if (kept.length > 0) {
        showToast({
          tone: "warn",
          title: t("Added to the existing reward"),
          problem: `${t("Couldn’t remove the source folder — it’s still on disk:")}\n${kept.join("\n")}`,
        });
      }
      // the merged files are in place, the rest goes through the normal import
      onConfirm(rest, { styles: pend.styles, keepArchive: kept.length > 0 });
      return;
    }
    await refresh();
    onCancel();
    showToast({
      tone: kept.length > 0 ? "warn" : "success",
      title:
        done.size === 1
          ? t("Added to the existing reward")
          : tf("Added to {n} existing rewards", { n: done.size }),
      detail: t("The files went into the folder that was already there."),
      problem:
        kept.length > 0
          ? `${t("Couldn’t remove the source folder — it’s still on disk:")}\n${kept.join("\n")}`
          : undefined,
    });
  };

  /** "Give it a different name": back to the review with the name selected. */
  const renameClash = () => {
    const first = clashes?.[0];
    setClashes(null);
    pending.current = null;
    if (!first) return;
    const esc = `${first.folder}::title`.replace(/(["\\])/g, "\\$1");
    setTimeout(() => {
      const el = panelRef.current?.querySelector<HTMLInputElement>(`[data-field="${esc}"]`);
      el?.focus();
      el?.select();
    }, 0);
  };

  /** "Cancel the import": close everything, write nothing. */
  const cancelForClash = () => {
    setClashes(null);
    pending.current = null;
    onCancel();
    showToast({
      tone: "warn",
      title: t("Import cancelled"),
      detail: t("Nothing was imported."),
    });
  };

  /* ---- quick import ------------------------------------------------------ */

  const QUICK_WARN_KEY = "micoll.quickImportWarned";
  const [quickWarn, setQuickWarn] = useState(false);
  const [dontWarn, setDontWarn] = useState(false);
  const firstRow = rows[0];
  const quickArtist = (lockedArtist ?? firstRow?.creator ?? rootName).trim() || rootName;
  // quick import = sort it later: without a known platform it goes to Unsorted
  const quickPlatform = platformOf(firstRow?.platform ?? UNSORTED);
  const quickPlatformLabel = quickPlatform ?? t("Unsorted");
  const quickTitle = (combine ? combinedTitle : firstRow?.title ?? rootName).trim() || rootName;

  const runQuickImport = () => {
    const rewards: ResolvedReward[] = [
      {
        artist: quickArtist,
        platform: quickPlatform,
        year: null,
        month: null,
        number: null,
        category: null,
        title: quickTitle,
        folder: root,
        root: false,
      },
    ];
    // quick import never saves a release style, but still checks for clashes
    void submit(rewards, []);
  };

  const onQuickImport = () => {
    let warned = false;
    try {
      warned = localStorage.getItem(QUICK_WARN_KEY) === "1";
    } catch {
      /* ignore */
    }
    if (warned) runQuickImport();
    else setQuickWarn(true);
  };

  const confirmQuickImport = () => {
    if (dontWarn) {
      try {
        localStorage.setItem(QUICK_WARN_KEY, "1");
      } catch {
        /* ignore */
      }
    }
    setQuickWarn(false);
    runQuickImport();
  };

  /* ---- render ------------------------------------------------------------ */

  // dlg.field works on the wrapper and the input (focus-within)
  const inputCls = cn("px-2 text-xs text-zinc-100 outline-none", dlg.field);

  const panelRef = useRef<HTMLDivElement>(null);

  // Enter = Import (or confirm the quick-import warning). On window because
  // nothing is focused right after opening. A ref keeps the handler current.
  const enterRef = useRef<(e: KeyboardEvent) => void>(() => {});
  enterRef.current = (e: KeyboardEvent) => {
    if (e.key !== "Enter" || e.shiftKey || e.altKey || e.ctrlKey || e.metaKey) return;
    const target = e.target as HTMLElement | null;
    // let focused buttons/textareas and data-enter-local fields handle their own Enter
    if (
      target &&
      (target.closest("button") ||
        target.closest("[data-enter-local]") ||
        target.tagName === "TEXTAREA")
    )
      return;
    if (busy || merging) return;
    // don't import again while a clash question is open
    if (clashes) return;
    if (quickWarn) {
      e.preventDefault();
      confirmQuickImport();
      return;
    }
    if (rows.length === 0) return;
    e.preventDefault();
    target?.blur?.(); // commit a half-typed Year/Month field first
    setTimeout(() => confirm(), 0);
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => enterRef.current(e);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <>
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
        {/* drag strip, the overlay covers the header */}
        <div data-tauri-drag-region className="absolute inset-x-0 top-0 h-14" />
        <motion.div
          ref={panelRef}
          initial={{ opacity: 0, y: 12, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          className={cn(
            "import-review flex max-h-[90vh] w-[46rem] max-w-full flex-col overflow-hidden shadow-2xl",
            panelClass,
          )}
        >
          <div className={cn("flex items-center justify-between border-b px-5 py-4", dlg.divider)}>
            <div>
              <h2 className="text-base font-semibold text-zinc-100">
                {lockedArtist ? tf("Add rewards to {name}", { name: lockedArtist }) : t("Review import")}
              </h2>
              <p className="text-xs text-zinc-400">
                {tp("{n} rewards", outCount)}
                {lockedArtist || combine ? "" : ` · ${tp("{n} creators", tree.length)}`}
                {` · ${t("this is exactly what will be created")}`}
              </p>
            </div>
            <button onClick={onCancel} className="text-zinc-500 hover:text-zinc-300">
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="flex-1 overflow-y-auto px-5 py-4">
            {rows.length === 0 ? (
              <p className="py-8 text-center text-sm text-zinc-400">
                {t("No reward folders (with images) were found here.")}
              </p>
            ) : (
              <div className="space-y-4">
                {/* merge the dropped folder into ONE reward */}
                {allowCombine && splitFromRoot && (
                  <label className="flex cursor-pointer items-start gap-2 rounded-xl border border-brand-500/30 bg-brand-500/5 p-3 text-sm text-zinc-300">
                    <input
                      type="checkbox"
                      checked={combine}
                      onChange={(e) => setCombine(e.target.checked)}
                      className="mt-0.5 h-4 w-4 accent-brand-500"
                    />
                    <span>
                      Treat “{rootName}” as ONE reward
                      <span className="mt-0.5 block text-xs text-zinc-500">
                        {t("Its subfolders become images inside a single reward instead of separate rewards.")}
                      </span>
                    </span>
                  </label>
                )}

                {tree.map((node) => {
                  const isLocked = !!lockedArtist;
                  // the library creator of this group, if any
                  const known = artists.find((a) => normName(a.name) === normName(node.creator));
                  const allRows = node.periods.flatMap((p) => p.rows);
                  const groupPlatform = allRows.every((r) => r.platform === allRows[0]?.platform)
                    ? allRows[0]?.platform ?? UNSORTED
                    : "";
                  // year/month shared by all rewards (empty if they differ)
                  const sharedYear =
                    allRows.length > 0 && allRows.every((r) => r.year === allRows[0].year)
                      ? allRows[0].year
                      : "";
                  const sharedMonth =
                    allRows.length > 0 && allRows.every((r) => r.month === allRows[0].month)
                      ? allRows[0].month
                      : "";
                  return (
                    <div key={node.creator} className={cn("p-3", boxClass)}>
                      {/* creator header: name + release style + platform for all */}
                      <div className="mb-1 flex items-center gap-2">
                        <span className="text-xs font-medium uppercase tracking-wide text-zinc-500">
                          {t("Creator")}
                        </span>
                        {isLocked ? (
                          <span className="flex-1 truncate text-sm font-medium text-zinc-100">
                            {node.creator}
                          </span>
                        ) : (
                          <div className="relative flex min-w-0 flex-1">
                            <CommitInput
                              value={node.creator}
                              onCommit={(v) => renameCreator(node.creator, v)}
                              title={t(
                                "Creator name — type an existing creator’s name to file these under them (applied when you leave the field)",
                              )}
                              className={cn(
                                "h-8 w-full min-w-0 text-sm font-medium",
                                inputCls,
                                known && "pr-8",
                              )}
                            />
                            {/* known creator: one click cancels the import and opens their
                                page */}
                            {known && (
                              <button
                                type="button"
                                onClick={() => {
                                  onCancel();
                                  navigate(`/artist/${known.id}`);
                                }}
                                title={tf("Hop to creator — cancel this import and open {name}", {
                                  name: known.name,
                                })}
                                aria-label={t("Hop to creator")}
                                className="absolute right-1 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-md text-zinc-400 transition-colors hover:bg-brand-500/20 hover:text-brand-200"
                              >
                                <ArrowUpRight className="h-4 w-4" />
                              </button>
                            )}
                          </div>
                        )}
                        {/* set the month for the WHOLE import at once */}
                        {node.style === "monthly" && (
                          <span
                            className="flex items-center gap-1"
                            title={t(
                              "Year & month for every reward of this creator — set it once here instead of on each reward row",
                            )}
                          >
                            <CalendarDays className="h-3.5 w-3.5 shrink-0 text-zinc-500" />
                            <CommitInput
                              value={sharedYear}
                              fieldId={`${node.creator}::all-year`}
                              onCommit={(v) => setCreatorPeriod(node.creator, { year: v })}
                              sanitize={(v) => v.replace(/\D/g, "").slice(0, 4)}
                              normalize={expandYear}
                              placeholder={t("Year")}
                              className={cn("h-8 w-14", inputCls)}
                            />
                            <CommitInput
                              value={sharedMonth}
                              fieldId={`${node.creator}::all-month`}
                              onCommit={(v) => setCreatorPeriod(node.creator, { month: v })}
                              sanitize={(v) => v.replace(/\D/g, "").slice(0, 2)}
                              placeholder="M"
                              className={cn("h-8 w-10", inputCls)}
                            />
                          </span>
                        )}
                        <ThemedSelect
                          value={groupPlatform}
                          onChange={(v) => {
                            if (v === "__add__") {
                              setNewPlatform("");
                              return;
                            }
                            if (v)
                              setRows((prev) =>
                                prev.map((r) => (r.creator === node.creator ? { ...r, platform: v } : r)),
                              );
                          }}
                          options={[
                            ...(groupPlatform === ""
                              ? [{ value: "", label: t("(mixed)"), muted: true }]
                              : []),
                            ...platformOptions.map((p) => ({ value: p, label: p })),
                            // then Misc and Unsorted, "+ Platform…" always the very last
                            { value: MISC, label: t("Misc") },
                            { value: UNSORTED, label: t("Unsorted") },
                            { value: "__add__", label: t("+ Platform…"), muted: true },
                          ]}
                          title={t("Platform for every reward of this creator")}
                          className={cn("h-8 w-32 shrink-0", inputCls)}
                          // sakura uses blossom white for the values
                          ink={sakura ? "text-pink-100" : undefined}
                        />
                      </div>
                      {newPlatform !== null && (
                        <div className="mb-2 flex items-center gap-1.5">
                          <input
                            autoFocus
                            data-enter-local
                            value={newPlatform}
                            onChange={(e) => setNewPlatform(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") {
                                // Enter here only adds the platform, stop it so it doesn't
                                // run the import
                                e.preventDefault();
                                e.stopPropagation();
                                addCustomPlatform(node.creator);
                              } else if (e.key === "Escape") {
                                setNewPlatform(null);
                              }
                            }}
                            placeholder={t("New platform name")}
                            className={cn("h-7 w-40", inputCls)}
                          />
                          <button
                            onClick={() => addCustomPlatform(node.creator)}
                            className="rounded-lg border border-brand-500/40 bg-brand-500/15 px-2.5 py-1 text-xs font-medium text-brand-100 hover:bg-brand-500/25"
                          >
                            Add
                          </button>
                          <button
                            onClick={() => setNewPlatform(null)}
                            className="rounded-lg px-1.5 py-1 text-xs text-zinc-400 hover:text-zinc-200"
                          >
                            ✕
                          </button>
                        </div>
                      )}

                      {/* release style */}
                      <div className="mb-3 flex items-center gap-1.5">
                        <span className="mr-1 text-[11px] text-zinc-500">{t("Releases:")}</span>
                        {STYLE_META.map(({ key, label, icon: Icon, hint }) => (
                          <button
                            key={key}
                            onClick={() => setCreatorStyle(node.creator, key)}
                            title={t(hint)}
                            className={cn(
                              "inline-flex items-center gap-1.5 px-2.5 py-1 text-xs transition-colors",
                              node.style === key ? cn("font-medium", dlg.controlOn) : dlg.control,
                            )}
                          >
                            <Icon className="h-3 w-3" />
                            {t(label)}
                          </button>
                        ))}
                      </div>

                      {/* preview tree: Period -> Reward */}
                      {combine ? (
                        // one merged reward, its period comes from the first row
                        <div className={cn("flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs", softClass)}>
                          <CornerDownRight className="h-3 w-3 shrink-0 text-zinc-600" />
                          <input
                            value={combinedTitle}
                            onChange={(e) => setCombinedTitle(e.target.value)}
                            placeholder={rootName}
                            title={t("Reward folder name")}
                            className={cn("h-7 min-w-0 flex-1", inputCls)}
                          />
                          {node.style === "monthly" && rows[0] && (
                            <>
                              <CommitInput
                                value={rows[0].year}
                                onCommit={(v) => patchRow(rows[0].folder, { year: v })}
                                sanitize={(v) => v.replace(/\D/g, "").slice(0, 4)}
                                placeholder={t("Year")}
                                title={t("Year — leave blank for Misc")}
                                className={cn("h-7 w-14", inputCls, !rows[0].year && "border-amber-500/50")}
                              />
                              <CommitInput
                                value={rows[0].month}
                                onCommit={(v) => patchRow(rows[0].folder, { month: v })}
                                sanitize={(v) => v.replace(/\D/g, "").slice(0, 2)}
                                placeholder="M"
                                title={t("Month (1–12) — leave blank for a whole-year folder")}
                                className={cn("h-7 w-10", inputCls)}
                              />
                            </>
                          )}
                          {node.style === "numbered" && rows[0] && (
                            <span className="inline-flex items-center gap-0.5">
                              <Hash className="h-3 w-3 text-zinc-500" />
                              <CommitInput
                                value={rows[0].num}
                                onCommit={(v) => patchRow(rows[0].folder, { num: v })}
                                sanitize={(v) => v.replace(/\D/g, "").slice(0, 6)}
                                placeholder={t("Nr")}
                                title={t("Drop number — blank = Unscheduled")}
                                className={cn("h-7 w-12", inputCls, !rows[0].num && "border-amber-500/50")}
                              />
                            </span>
                          )}
                          {node.style === "none" && <Badge tone="neutral">{t("No schedule")}</Badge>}
                          <span className="inline-flex items-center gap-1 text-zinc-500">
                            <Images className="h-3 w-3" />
                            {combinedImages}
                          </span>
                        </div>
                      ) : (
                        <div className="space-y-2">
                          {node.periods.map((period) => {
                            // "Bundle into ONE reward" when the rewards share a folder
                            // (e.g. characters in a month folder:
                            // reward/2026-05/charX|charY|charZ)
                            const anc = commonAncestor(period.rows.map((r) => r.folder));
                            const rowAtAnc = anc != null ? rows.find((r) => r.folder === anc) : undefined;
                            // only an active row can take in siblings
                            const ancRow = rowAtAnc?.mergedInto === null ? rowAtAnc : undefined;
                            const bundleKids = period.rows.filter((r) => r.folder !== anc);
                            const canBundle =
                              anc != null &&
                              !(rowAtAnc && !ancRow) &&
                              bundleKids.length >= (ancRow ? 1 : 2) &&
                              // the dropped root has its own "Treat as ONE reward" checkbox
                              !(allowCombine && splitFromRoot && anc === root && !ancRow);
                            const doBundle = () => {
                              if (!anc) return;
                              if (ancRow) {
                                // fold the siblings into the reward at the shared folder
                                const folded = new Set(bundleKids.map((c) => c.folder));
                                setRows((prev) =>
                                  prev.map((r) =>
                                    folded.has(r.folder) ? { ...r, mergedInto: anc } : r,
                                  ),
                                );
                              } else {
                                bundleRows(bundleKids, anc);
                              }
                            };
                            return (
                            <div key={period.key}>
                              {(node.style !== "none" || canBundle) && (
                                <div className="mb-1 flex items-center gap-2 text-xs text-zinc-400">
                                  {node.style !== "none" && (
                                    <span
                                      className={cn(
                                        "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 font-medium",
                                        softClass,
                                        period.label === "Misc" || period.label === "Unscheduled"
                                          ? "text-zinc-500"
                                          : "text-zinc-200",
                                      )}
                                    >
                                      {node.style === "numbered" ? (
                                        <Hash className="h-3 w-3" />
                                      ) : (
                                        <CalendarDays className="h-3 w-3" />
                                      )}
                                      {period.label}
                                    </span>
                                  )}
                                  <span className="text-zinc-600">
                                    {period.rows.length} reward{period.rows.length === 1 ? "" : "s"}
                                  </span>
                                  {canBundle && (
                                    <button
                                      onClick={doBundle}
                                      title={
                                        ancRow
                                          ? `Fold ${bundleKids.length} reward${bundleKids.length === 1 ? "" : "s"} into “${ancRow.title || baseName(ancRow.folder)}” — they'll show as groups inside it in the viewer (undo via the toggle on that row)`
                                          : `Bundle these ${period.rows.length} rewards into ONE reward — they'll show as groups inside it in the viewer (undo via the toggle on the bundled row)`
                                      }
                                      className="inline-flex items-center gap-1 rounded-md border border-dashed border-brand-500/50 bg-brand-500/5 px-1.5 py-0.5 text-brand-200 transition-colors hover:bg-brand-500/15"
                                    >
                                      <FolderTree className="h-3 w-3" />
                                      {t("Bundle into ONE reward")}
                                    </button>
                                  )}
                                </div>
                              )}
                              <div className="space-y-1 pl-3">
                                {period.rows.map((r) => {
                                  const kids = childRowsOf(r.folder);
                                  const foldedKids = mergedChildrenOf(r.folder);
                                  const folded = foldedKids.length > 0;
                                  return (
                                  <div key={r.folder}>
                                  <div className={cn("flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs", softClass)}>
                                    <CornerDownRight className="h-3 w-3 shrink-0 text-zinc-600" />
                                    {r.root ? (
                                      <button
                                        onClick={() => patchRow(r.folder, { root: false })}
                                        title={`Files go straight into “${period.label}” (was “${baseName(
                                          r.folder,
                                        )}”). Click to give it a named folder again.`}
                                        className={cn(
                                          "flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-lg border border-dashed px-2 text-left text-xs text-zinc-500 hover:brightness-125",
                                          softClass,
                                        )}
                                      >
                                        <span className="shrink-0">→ files directly in this period</span>
                                        <span className="truncate text-zinc-600">{baseName(r.folder)}</span>
                                      </button>
                                    ) : (
                                      <input
                                        value={r.title}
                                        // data-field so the clash dialog can focus this row
                                        data-field={`${r.folder}::title`}
                                        onChange={(e) => patchRow(r.folder, { title: e.target.value })}
                                        title={t("Reward name")}
                                        className={cn("h-7 min-w-0 flex-1", inputCls)}
                                      />
                                    )}
                                    {r.category && <Badge tone="zinc">{r.category}</Badge>}
                                    {node.style === "monthly" && (
                                      <>
                                        <CommitInput
                                          value={r.year}
                                          fieldId={`${r.folder}::year`}
                                          onCommit={(v) => patchRow(r.folder, { year: v })}
                                          sanitize={(v) => v.replace(/\D/g, "").slice(0, 4)}
                                          normalize={expandYear}
                                          placeholder={t("Year")}
                                          title={t("Year — leave blank for Misc")}
                                          className={cn(
                                            "h-7 w-14",
                                            inputCls,
                                            !r.year && "border-amber-500/50",
                                          )}
                                        />
                                        <CommitInput
                                          value={r.month}
                                          fieldId={`${r.folder}::month`}
                                          onCommit={(v) => patchRow(r.folder, { month: v })}
                                          sanitize={(v) => v.replace(/\D/g, "").slice(0, 2)}
                                          placeholder="M"
                                          title={t("Month (1–12) — leave blank for a whole-year folder")}
                                          className={cn("h-7 w-10", inputCls)}
                                        />
                                      </>
                                    )}
                                    {node.style === "numbered" && (
                                      <span className="inline-flex items-center gap-0.5">
                                        <Hash className="h-3 w-3 text-zinc-500" />
                                        <CommitInput
                                          value={r.num}
                                          fieldId={`${r.folder}::num`}
                                          onCommit={(v) => patchRow(r.folder, { num: v })}
                                          sanitize={(v) => v.replace(/\D/g, "").slice(0, 6)}
                                          placeholder={t("Nr")}
                                          title={t("Drop number — rewards with the same number share one card; blank = Unscheduled")}
                                          className={cn("h-7 w-12", inputCls, !r.num && "border-amber-500/50")}
                                        />
                                      </span>
                                    )}
                                    {!r.root && (
                                      <button
                                        onClick={() => patchRow(r.folder, { root: true })}
                                        title={t(
                                          "Make this the period’s root content — files go straight into the period folder, no named reward inside",
                                        )}
                                        className="rounded-md p-1 text-zinc-500 micoll-hover hover:text-zinc-200"
                                      >
                                        <FolderInput className="h-3.5 w-3.5" />
                                      </button>
                                    )}
                                    <button
                                      onClick={() => patchRow(r.folder, { extra: !r.extra })}
                                      aria-pressed={r.extra}
                                      title={
                                        r.extra
                                          ? t("Imported as an extra — it stays in this period but doesn’t stand in for it. Click to import it normally")
                                          : t("Import as an extra — it stays in this period but doesn’t stand in for it (not used for the month card)")
                                      }
                                      className={cn(
                                        "rounded-md p-1",
                                        r.extra
                                          ? "bg-brand-500/15 text-brand-200 hover:bg-brand-500/25"
                                          : "text-zinc-500 micoll-hover hover:text-zinc-200",
                                      )}
                                    >
                                      <Sparkles className="h-3.5 w-3.5" />
                                    </button>
                                    {!isLocked &&
                                      (r.promotedFrom ? (
                                        <button
                                          onClick={() =>
                                            patchRow(r.folder, { creator: r.promotedFrom!, promotedFrom: null })
                                          }
                                          title={`Undo “this is a creator” — file it back under “${r.promotedFrom}” as a reward`}
                                          className="rounded-md bg-brand-500/15 p-1 text-brand-200 hover:bg-brand-500/25"
                                        >
                                          <Undo2 className="h-3.5 w-3.5" />
                                        </button>
                                      ) : (
                                        <button
                                          onClick={() => promoteToCreator(r)}
                                          title={t("This is a creator, not a reward — file it under its own name (undoable)")}
                                          className="rounded-md p-1 text-zinc-500 micoll-hover hover:text-zinc-200"
                                        >
                                          <UserPlus className="h-3.5 w-3.5" />
                                        </button>
                                      ))}
                                    {(kids.length > 0 || foldedKids.length > 0) && (
                                      <button
                                        onClick={() => toggleFoldChildren(r, !folded)}
                                        title={
                                          folded
                                            ? `The ${foldedKids.length} subfolder reward${foldedKids.length === 1 ? "" : "s"} show INSIDE this reward (one card, grouped in the viewer). Click to import them as separate cards.`
                                            : `This folder contains ${kids.length} subfolder reward${kids.length === 1 ? "" : "s"}. Click to show them inside this reward instead of as separate cards.`
                                        }
                                        className={cn(
                                          "rounded-md p-1",
                                          folded
                                            ? "bg-brand-500/15 text-brand-200 hover:bg-brand-500/25"
                                            : "text-zinc-500 micoll-hover hover:text-zinc-200",
                                        )}
                                      >
                                        <FolderTree className="h-3.5 w-3.5" />
                                      </button>
                                    )}
                                    <span className="inline-flex items-center gap-1 text-zinc-500">
                                      <Images className="h-3 w-3" />
                                      {ownImageCount(r)}
                                    </span>
                                  </div>
                                  {/* folded subfolder rewards shown indented (a group in
                                      the parent's viewer) */}
                                  {foldedKids.length > 0 && (
                                    <div className="mt-1 space-y-1 pl-7">
                                      {foldedKids.map((c) => (
                                        <div
                                          key={c.folder}
                                          className={cn(
                                            "flex items-center gap-2 rounded-lg border border-dashed px-2.5 py-1 text-xs text-zinc-500",
                                            softClass,
                                          )}
                                          title={`“${c.title}” stays inside “${r.title}” — its images appear as a group in the viewer`}
                                        >
                                          <CornerDownRight className="h-3 w-3 shrink-0 text-zinc-700" />
                                          <span className="truncate">{c.title}</span>
                                          <span className="text-zinc-600">· inside “{r.title || baseName(r.folder)}”</span>
                                          <span className="ml-auto inline-flex items-center gap-1 text-zinc-600">
                                            <Images className="h-3 w-3" />
                                            {c.imageCount}
                                          </span>
                                        </div>
                                      ))}
                                    </div>
                                  )}
                                  </div>
                                  );
                                })}
                              </div>
                            </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}

                {/* what comes in: images, videos, other files and the size */}
                <ImportStatsLine folders={plan.rewards.map((r) => r.folder)} />
              </div>
            )}
          </div>

          <div className={cn("flex justify-end gap-2 border-t px-5 py-3", dlg.divider)}>
            <Button variant="ghost" onClick={onCancel} disabled={busy}>
              {t("Cancel")}
            </Button>
            {allowCombine && root && (
              <Button
                variant="ghost"
                disabled={busy || rows.length === 0}
                onClick={onQuickImport}
                title={tf("Combine everything into one reward under “{platform}”, ignoring periods", {
                  platform: quickPlatformLabel,
                })}
              >
                <Zap className="h-4 w-4" />
                {t("Quick import")}
              </Button>
            )}
            {/* sakura uses the dashboard chip look (on outline, primary's !important would
                win) */}
            <Button
              variant={sakura ? "outline" : "primary"}
              className={sakura ? "sak-chip sak-chip--lead sak-petal-cut" : undefined}
              disabled={busy || rows.length === 0}
              onClick={confirm}
            >
              <FolderInput className="h-4 w-4" />
              {busy ? t("Importing…") : tf("Import {n}", { n: outCount })}
            </Button>
          </div>
        </motion.div>
      </div>

      {/* quick-import warning (can be hidden forever) */}
      {quickWarn && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
          <div data-tauri-drag-region className="absolute inset-x-0 top-0 h-14" />
          <motion.div
            initial={{ opacity: 0, scale: 0.96, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            // amber border stays, the surface follows the theme
            className={cn(
              "import-review w-[26rem] max-w-full overflow-hidden shadow-2xl !border-amber-500/30",
              panelClass,
            )}
          >
            <div className={cn("flex items-center gap-2 border-b px-5 py-3", dlg.divider)}>
              <AlertTriangle className="h-4 w-4 text-amber-400" />
              <h3 className="text-sm font-semibold text-zinc-100">{t("Quick import")}</h3>
            </div>
            <div className="px-5 py-4 text-sm text-zinc-300">
              <p>
                {tf("Everything in “{name}” will be combined into", { name: rootName })}{" "}
                <b>{t("one reward")}</b> {t("and filed under")} <b>{quickPlatformLabel}</b>,{" "}
                <b>{t("ignoring periods")}</b>. {t("You can sort it later.")}
              </p>
              <label className="mt-4 flex cursor-pointer items-center gap-2 text-xs text-zinc-400">
                <input
                  type="checkbox"
                  checked={dontWarn}
                  onChange={(e) => setDontWarn(e.target.checked)}
                  className="h-4 w-4 accent-brand-500"
                />
                {t("Don’t warn me again")}
              </label>
            </div>
            <div className={cn("flex justify-end gap-2 border-t px-5 py-3", dlg.divider)}>
              <Button variant="ghost" onClick={() => setQuickWarn(false)} disabled={busy}>
                {t("Cancel")}
              </Button>
              <Button variant="primary" onClick={confirmQuickImport} disabled={busy}>
                <Zap className="h-4 w-4" />
                {t("Quick import")}
              </Button>
            </div>
          </motion.div>
        </div>
      )}

      {/* a name that already exists where this import lands */}
      {clashes && (
        <ImportClashDialog
          clashes={clashes}
          busy={busy || merging}
          onMerge={() => void mergeClashes()}
          onRename={renameClash}
          onCancelAll={cancelForClash}
        />
      )}
    </>
  );
}
