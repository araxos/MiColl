import { useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import { useNavigate } from "react-router-dom";
import { Search, Image as ImageIcon, CornerDownLeft } from "lucide-react";
import { Thumb } from "@/components/Thumb";
import { useThumb } from "@/hooks/useThumb";
import { isTauri, thumbUrl } from "@/lib/tauri";
import { useData } from "@/store";
import { useAccent } from "@/lib/theme";
import { useDialogTheme } from "@/lib/dialogTheme";
import { cn } from "@/lib/utils";
import { useT, useTf } from "@/lib/i18n";
import { ownRewards } from "@/types";

/** Max rows for a typed search, the rest is just counted. */
const CAP = 200;

/** Thumbnail size for the 36px chip. */
const AVATAR = 128;

/**
 * Creator cover in the results, cropped to the TOP (heads are usually at the top).
 * loading="lazy" so we don't load every thumbnail at once.
 */
function CreatorAvatar({ path, alts, name }: { path?: string; alts?: string[]; name: string }) {
  const src = useThumb(path, AVATAR);
  const altUrls = isTauri() ? (alts ?? []).filter(Boolean).map((p) => thumbUrl(p, AVATAR)) : [];
  return (
    <Thumb
      src={src}
      alts={altUrls}
      seed={name}
      rounded="rounded-lg"
      className="object-top"
      loading="lazy"
    />
  );
}

type Entry =
  | {
      kind: "artist";
      id: string;
      label: string;
      sub: string;
      hay: string;
      /** The creator's cover for the row avatar. */
      path?: string;
      alts?: string[];
    }
  | { kind: "reward"; artistId: string; monthId: string; label: string; sub: string; hay: string };

/** Global Ctrl+K search over artists and rewards. */
export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT();
  const tf = useTf();
  const { artists } = useData();
  const navigate = useNavigate();
  const accent = useAccent();
  const dlg = useDialogTheme();
  const premium = accent === "sakura" || accent === "cyberpunk" || accent === "iridescent";
  // backdrop tinted per premium theme
  const scrim =
    accent === "cyberpunk"
      ? "bg-[#05070c]/70"
      : accent === "iridescent"
        ? "bg-[#0e0c18]/65"
        : accent === "sakura"
          ? "bg-[#1d121a]/70"
          : "bg-black/60";
  // the creator row chip uses the accent fill on premium themes
  const artistChip = premium
    ? cn(dlg.accent, "text-zinc-900", accent === "cyberpunk" && "rounded-none")
    : "bg-brand-600/20 text-brand-300";
  const [q, setQ] = useState("");
  // row refs so the selected row stays in view
  const rowsRef = useRef<(HTMLButtonElement | null)[]>([]);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // turn the library into searchable entries (artists + rewards)
  const all = useMemo<Entry[]>(() => {
    const out: Entry[] = [];
    for (const a of artists) {
      const tags = a.tags ?? [];
      // tags/type in the subtitle and in the search text
      const sub = tags.length
        ? `${t("Creator")} · ${tags.map(t).join(", ")}`
        : a.kind
          ? `${t("Creator")} · ${t(a.kind)}`
          : t("Creator");
      out.push({
        kind: "artist",
        id: a.id,
        label: a.name,
        path: a.previewPath,
        alts: a.previewAlts,
        sub,
        hay: `${a.name} ${(a.aliases ?? []).join(" ")} ${a.kind ?? ""} ${tags.join(" ")}`.toLowerCase(),
      });
      for (const p of a.platforms) {
        for (const m of p.months) {
          // skip borrowed collab rewards (would show twice)
          for (const r of ownRewards(m)) {
            out.push({
              kind: "reward",
              artistId: a.id,
              monthId: m.id,
              label: r.title,
              sub: `${a.name} · ${p.name} ${m.label}`,
              hay: `${r.title} ${a.name} ${p.name} ${m.label}`.toLowerCase(),
            });
          }
        }
      }
    }
    return out;
  }, [artists]);

  /**
   * Opening the palette lists ALL creators (no limit).
   * Typed searches also include rewards, those stop at CAP.
   */
  const { results, more } = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const hits = needle
      ? all.filter((e) => e.hay.includes(needle))
      : all.filter((e) => e.kind === "artist");
    return needle
      ? { results: hits.slice(0, CAP), more: Math.max(0, hits.length - CAP) }
      : { results: hits, more: 0 };
  }, [all, q]);

  // reset + focus when opened
  useEffect(() => {
    if (open) {
      setQ("");
      setActive(0);
      // focus after mount
      const t = window.setTimeout(() => inputRef.current?.focus(), 30);
      return () => window.clearTimeout(t);
    }
  }, [open]);

  useEffect(() => setActive(0), [q]);

  useEffect(() => {
    rowsRef.current[active]?.scrollIntoView({ block: "nearest" });
  }, [active]);

  if (!open) return null;

  const select = (e: Entry) => {
    onClose();
    if (e.kind === "artist") navigate(`/artist/${e.id}`);
    else navigate(`/artist/${e.artistId}/month/${e.monthId}`);
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(results.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const sel = results[active];
      if (sel) select(sel);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  return (
    <div
      className={cn(
        "fixed inset-0 z-[70] flex items-start justify-center p-4 pt-[12vh] backdrop-blur-sm",
        scrim,
      )}
      onClick={onClose}
    >
      <motion.div
        initial={{ opacity: 0, y: -8, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        onClick={(e) => e.stopPropagation()}
        // dlg.panel gives each theme its own surface, overflow-hidden keeps the list inside
        className={cn(
          "flex max-h-[70vh] w-[34rem] max-w-full flex-col overflow-hidden",
          dlg.panel,
        )}
      >
        <div className={cn("flex items-center gap-2 border-b px-4", dlg.divider)}>
          <Search className={cn("h-4 w-4 shrink-0", dlg.accentText)} />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onKey}
            placeholder={t("Search creators, tags & rewards…")}
            className="h-12 w-full bg-transparent text-sm text-zinc-100 placeholder:text-zinc-500 outline-none"
          />
          <kbd
            className={cn(
              "shrink-0 px-1.5 py-0.5 text-[10px] text-zinc-400",
              dlg.field,
            )}
          >
            Esc
          </kbd>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto py-1.5">
          {results.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-zinc-500">{t("No matches.")}</p>
          ) : (
            results.map((e, i) => (
              <button
                key={`${e.kind}-${i}`}
                ref={(el) => {
                  rowsRef.current[i] = el;
                }}
                onClick={() => select(e)}
                onMouseEnter={() => setActive(i)}
                className={cn(
                  "flex w-full items-center gap-3 px-4 py-2 text-left transition-colors",
                  // the selected row uses the menu hover style
                  i === active ? dlg.menuRowOpen : dlg.menuRow,
                )}
              >
                <span
                  className={cn(
                    "flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-lg",
                    e.kind === "artist" ? artistChip : cn("text-zinc-400", dlg.field),
                  )}
                >
                  {e.kind === "artist" ? (
                    <CreatorAvatar path={e.path} alts={e.alts} name={e.label} />
                  ) : (
                    <ImageIcon className="h-4 w-4" />
                  )}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-zinc-100">{e.label}</span>
                  <span className="block truncate text-xs text-zinc-500">{e.sub}</span>
                </span>
                {i === active && <CornerDownLeft className="h-3.5 w-3.5 shrink-0 text-zinc-500" />}
              </button>
            ))
          )}
          {more > 0 && (
            <p className="px-4 py-2 text-center text-xs text-zinc-500">
              {tf("{n} more matches — keep typing to narrow it down", { n: more })}
            </p>
          )}
        </div>
      </motion.div>
    </div>
  );
}
