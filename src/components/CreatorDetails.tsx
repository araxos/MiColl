import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { motion } from "framer-motion";
import { ClipboardList, Loader2, PanelRight, X } from "lucide-react";
import { artistSize, type ArtistSize } from "@/api/library";
import { Cover } from "@/components/Cover";
import { PlatformCheck, ThemeCheck } from "@/components/ThemeCheck";
import { isTauri } from "@/lib/tauri";
import { useDialogTheme } from "@/lib/dialogTheme";
import { isNsfwTag, nsfwChipColors, tagDef } from "@/lib/artistTags";
import { creatorTypeDefs } from "@/lib/creatorTypes";
import { PLATFORM_ICONS, normalizePlatform } from "@/lib/platformIcons";
import { useAccent } from "@/lib/theme";
import { resolveLanguage, useLanguage, useT, useTf } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { ownRewards, platformStats } from "@/types";
import type { Artist } from "@/types";

function fmtBytes(n: number): string {
  if (n <= 0) return "0 B";
  const u = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${u[i]}`;
}

/* No plurals in here on purpose: every row has its unit as a label, so the
   value is just the number (plurals differ a lot between languages). */

/**
 * Creator details window from the dashboard (like a reward's Details).
 * Shows the creator's cover at the top, the 3 main numbers under it and a table.
 * Read-only, editing is in the Details panel on the creator page.
 * Everything is counted from the library in memory, only the disk size loads later.
 */
export function CreatorDetails({
  artist,
  onOpenPanel,
  onClose,
}: {
  artist: Artist;
  /** Open the creator page with the Details panel open. */
  onOpenPanel: () => void;
  onClose: () => void;
}) {
  const t = useT();
  const tf = useTf();
  // numbers and dates in the chosen language
  const active = resolveLanguage(useLanguage());
  const dlg = useDialogTheme();
  const accent = useAccent();
  const [size, setSize] = useState<ArtistSize | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!isTauri()) return;
    let alive = true;
    setBusy(true);
    artistSize(artist.id)
      .then((s) => alive && setSize(s))
      .catch(() => {})
      .finally(() => alive && setBusy(false));
    return () => {
      alive = false;
    };
  }, [artist.id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const stats = useMemo(() => {
    let owned = 0;
    let missing = 0;
    let skippedRewards = 0;
    let files = 0;
    let periods = 0;
    let breaks = 0;
    let tracked = 0;
    let official = 0;
    let borrowed = 0;
    let years = new Set<number>();
    for (const p of artist.platforms ?? []) {
      const ps = platformStats(p);
      tracked += ps.tracked ? ps.totalRewards : 0;
      official += ps.tracked ? ps.totalRewards : 0;
      for (const m of p.months ?? []) {
        if (m.collabOnly) continue;
        if (m.skipped) {
          breaks += 1;
          continue;
        }
        periods += 1;
        if (m.year != null) years.add(m.year);
        for (const r of m.rewards ?? []) {
          // don't count borrowed rewards (they belong to another creator)
          if (r.collabFrom) {
            borrowed += 1;
            continue;
          }
          if (r.status === "owned") owned += 1;
          else if (r.status === "missing") missing += 1;
          else skippedRewards += 1;
          files += r.imageCount;
        }
      }
    }
    const yearList = [...years].sort((a, b) => a - b);
    return {
      owned,
      missing,
      skippedRewards,
      files,
      periods,
      breaks,
      borrowed,
      official,
      tracked: tracked > 0,
      span:
        yearList.length === 0
          ? null
          : yearList.length === 1
            ? `${yearList[0]}`
            : `${yearList[0]}–${yearList[yearList.length - 1]}`,
    };
  }, [artist]);

  const platformNames = (artist.platforms ?? []).map((p) => p.name).filter(Boolean);

  // same platform badges as the dashboard card
  const ownedPlatforms = new Set(
    (artist.platforms ?? [])
      .filter((p) => (p.months ?? []).some((m) => ownRewards(m).length > 0))
      .map((p) => normalizePlatform(p.name)),
  );
  const badges = PLATFORM_ICONS.filter((p) => ownedPlatforms.has(p.key));
  const verifiedPlatforms = new Set(
    (artist.platforms ?? []).filter((p) => p.verified).map((p) => normalizePlatform(p.name)),
  );

  // class and types in the theme's icons
  const cls = tagDef(artist.tag);
  const kinds = creatorTypeDefs(artist.kind);
  // tags next to the platforms, max 4, the rest as "+n" with a tooltip
  const freeTags = (artist.tags ?? []).filter(Boolean);
  const shownTags = freeTags.slice(0, 4);
  const restTags = freeTags.slice(4);
  // everything except the one shown big at the top
  const strip = (artist.previewAlts ?? []).filter((p) => p && p !== artist.previewPath).slice(0, 5);

  const row = (label: string, value: string): [string, string] => [t(label), value];
  const num = (n: number) => n.toLocaleString(active);

  const sizeText =
    busy && !size
      ? t("measuring…")
      : size
        ? fmtBytes(size.bytes)
        : isTauri()
          ? "—"
          : t("desktop app only");

  // the 3 main numbers
  const tiles: { key: string; label: string; value: string; note?: string }[] = [
    {
      key: "rewards",
      label: t("Rewards"),
      value: num(stats.owned),
      note: stats.tracked ? tf("of {total} released", { total: num(stats.official) }) : undefined,
    },
    { key: "files", label: t("Files"), value: num(stats.files) },
    // no "n not readable" note here, the row below says it
    { key: "size", label: t("Size"), value: sizeText },
  ];

  const rows: [string, string][] = [
    ...(stats.missing > 0 ? [row("Missing", num(stats.missing))] : []),
    ...(stats.skippedRewards > 0 ? [row("Skipped", num(stats.skippedRewards))] : []),
    ...(size && size.missing > 0
      ? [row("Not readable", tf("{n} — deleted, or on an unplugged disk", { n: num(size.missing) }))]
      : []),
    row(
      "Platforms",
      platformNames.length ? `${platformNames.length} · ${platformNames.join(", ")}` : "—",
    ),
    row("Periods", stats.span ? `${num(stats.periods)} · ${stats.span}` : num(stats.periods)),
    ...(stats.breaks > 0 ? [row("Breaks", num(stats.breaks))] : []),
    ...(stats.borrowed > 0 ? [row("Collabs shown", num(stats.borrowed))] : []),
    row("Release style", t(artist.releaseStyle ?? "monthly")),
    ...(artist.aliases?.length ? [row("Also known as", artist.aliases.join(", "))] : []),
    ...(artist.verified || artist.personalLog
      ? [row("Template", artist.verified ? t("Verified") : t("Personal log"))]
      : []),
    row(
      "Last changed",
      artist.updatedAt
        ? new Date(artist.updatedAt).toLocaleString(active)
        : size?.modified
          ? new Date(size.modified).toLocaleString(active)
          : "—",
    ),
    ...(artist.hidden ? [row("Hidden", t("Not shown on the dashboard"))] : []),
  ];

  // square corners on cyberpunk
  const round = accent === "cyberpunk" ? "rounded-none" : "rounded-lg";

  // portaled to <body>: it's opened from a card button with a transform,
  // otherwise the overlay would be positioned inside the card
  return createPortal(
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      // stop the events, the portal still bubbles to the card in React
      // (otherwise closing it would open the creator behind it)
      onClick={(e) => {
        e.stopPropagation();
        onClose();
      }}
      onContextMenu={(e) => {
        e.stopPropagation();
        e.preventDefault();
      }}
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
    >
      <motion.div
        initial={{ scale: 0.96, opacity: 0, y: 8 }}
        animate={{ scale: 1, opacity: 1, y: 0 }}
        onClick={(e) => e.stopPropagation()}
        className={cn("flex max-h-[88vh] w-[32rem] max-w-[92vw] flex-col overflow-hidden", dlg.panel)}
      >
        {/* head: the cover blurred as background + small and sharp in front
            (same thumbnail, so only one decode) */}
        <div className={cn("relative shrink-0 overflow-hidden border-b", dlg.divider)}>
          <div aria-hidden className="absolute inset-0 scale-125 opacity-40 blur-2xl">
            <Cover path={artist.previewPath} alts={artist.previewAlts} seed={artist.name} rounded="rounded-none" />
          </div>
          {/* black overlay so the name is readable */}
          <div
            aria-hidden
            className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/55 to-black/30"
          />

          <button
            onClick={onClose}
            title={t("Close (Esc)")}
            className={cn(
              "absolute right-2.5 top-2.5 z-10 p-1.5 text-white/70 backdrop-blur-sm transition-colors hover:text-white",
              round,
              dlg.menuRow,
            )}
          >
            <X className="h-4 w-4" />
          </button>

          <div className="relative flex items-end gap-4 px-5 pb-5 pt-6">
            {/* cover in 4:5 like everywhere else */}
            <div
              className={cn(
                "aspect-[4/5] w-[6.25rem] shrink-0 overflow-hidden shadow-xl shadow-black/50 ring-1 ring-white/15",
                accent === "cyberpunk" ? "rounded-none" : "rounded-xl",
              )}
            >
              {/* no label, the name is already next to it */}
              <Cover
                path={artist.previewPath}
                alts={artist.previewAlts}
                seed={artist.name}
                rounded="rounded-none"
              />
            </div>

            <div className="min-w-0 flex-1 pb-0.5">
              <p className="text-[10px] font-medium uppercase tracking-[0.14em] text-white/45">
                {t("Creator details")}
              </p>
              <h2 className="mt-1 flex items-center gap-1.5 text-lg font-semibold leading-tight text-white">
                {cls && (
                  <cls.Icon
                    aria-label={t(cls.label)}
                    className={cn("h-5 w-5 shrink-0", cls.color)}
                    fill="currentColor"
                  />
                )}
                <span className="min-w-0 break-words">{artist.name}</span>
                {artist.verified ? (
                  <ThemeCheck className="h-4 w-4" label={t("Verified template")} />
                ) : artist.personalLog ? (
                  <ClipboardList
                    aria-label={t("Personal collection log")}
                    className="h-4 w-4 shrink-0 text-zinc-300"
                  />
                ) : null}
              </h2>

              {(kinds.length > 0 || badges.length > 0 || shownTags.length > 0) && (
                <div className="mt-2 flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
                  {kinds.map((k) => (
                    <span
                      key={k.key}
                      className={cn(
                        "inline-flex items-center gap-1 text-[11px] font-medium",
                        k.color,
                      )}
                    >
                      <k.Icon className="h-3.5 w-3.5" />
                      {t(k.label)}
                    </span>
                  ))}
                  {badges.length > 0 && kinds.length > 0 && (
                    <span aria-hidden className="h-3 w-px bg-white/15" />
                  )}
                  {badges.map((b) => (
                    <span key={b.key} className="relative inline-flex" title={b.label}>
                      <img
                        src={b.src}
                        alt={b.label}
                        className={cn(b.size, "object-contain drop-shadow-[0_1px_3px_rgba(0,0,0,0.9)]")}
                      />
                      {verifiedPlatforms.has(b.key) && <PlatformCheck />}
                    </span>
                  ))}
                  {shownTags.length > 0 && (kinds.length > 0 || badges.length > 0) && (
                    <span aria-hidden className="h-3 w-px bg-white/15" />
                  )}
                  {shownTags.map((tag) => (
                    <span
                      key={tag}
                      className={cn(
                        "inline-flex items-center rounded-full border px-2 py-px text-[10px] backdrop-blur-sm",
                        isNsfwTag(tag)
                          ? nsfwChipColors(accent)
                          : "border-white/20 bg-white/10 text-white/85",
                      )}
                    >
                      {tag}
                    </span>
                  ))}
                  {restTags.length > 0 && (
                    <span
                      title={restTags.join(", ")}
                      className="inline-flex cursor-default items-center rounded-full border border-white/15 bg-white/5 px-2 py-px text-[10px] text-white/60 backdrop-blur-sm"
                    >
                      +{restTags.length}
                    </span>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {/* the next few reward covers as portrait tiles (5 columns),
              only shown with 2 or more */}
          {strip.length > 1 && (
            <div className="mb-3 grid grid-cols-5 gap-2">
              {strip.map((path) => (
                <div
                  key={path}
                  className={cn(
                    "aspect-[4/5] overflow-hidden ring-1 ring-white/10",
                    accent === "cyberpunk" ? "rounded-none" : "rounded-lg",
                  )}
                >
                  <Cover path={path} seed={path} rounded="rounded-none" />
                </div>
              ))}
            </div>
          )}

          {/* the 3 main numbers */}
          <div className="grid grid-cols-3 gap-2">
            {tiles.map((tile) => (
              <div key={tile.key} className={cn("px-3 py-2.5", round, dlg.box)}>
                <p className="text-[10px] uppercase tracking-wide text-zinc-500">{tile.label}</p>
                <p className="mt-0.5 truncate text-lg font-semibold leading-tight text-zinc-100">
                  {tile.value}
                </p>
                {tile.note && (
                  <p className="mt-0.5 truncate text-[10px] text-zinc-500">{tile.note}</p>
                )}
              </div>
            ))}
          </div>

          <div className={cn("mt-3", dlg.field)}>
            {rows.map(([k, v]) => (
              <div
                key={k}
                className={cn(
                  "flex items-start justify-between gap-4 border-t px-3 py-2 first:border-t-0",
                  dlg.divider,
                )}
              >
                <span className="shrink-0 text-xs uppercase tracking-wide text-zinc-500">{k}</span>
                <span className="text-right text-sm text-zinc-200">{v}</span>
              </div>
            ))}
          </div>

          {artist.notes && (
            <>
              <label className="mt-4 block text-xs font-medium uppercase tracking-wide text-zinc-500">
                {t("Notes")}
              </label>
              <p
                className={cn(
                  "mt-1.5 whitespace-pre-wrap break-words px-2.5 py-2 text-sm text-zinc-300",
                  dlg.field,
                )}
              >
                {artist.notes}
              </p>
            </>
          )}

          {busy && (
            <p className="mt-3 flex items-center gap-2 text-xs text-zinc-500">
              <Loader2 className={cn("h-3.5 w-3.5 animate-spin", dlg.accentText)} />
              {t("Measuring this creator’s files…")}
            </p>
          )}
        </div>

        {/* link to the editable Details */}
        <div className={cn("shrink-0 border-t px-5 py-3", dlg.divider)}>
          <button
            onClick={onOpenPanel}
            className={cn(
              "flex w-full items-center justify-center gap-2 px-3 py-2 text-sm font-medium text-zinc-100 transition-colors",
              dlg.field,
              dlg.menuRow,
            )}
          >
            <PanelRight className="h-4 w-4" />
            {t("Edit in the creator’s details panel")}
          </button>
        </div>
      </motion.div>
    </motion.div>,
    document.body,
  );
}
