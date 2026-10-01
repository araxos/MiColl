import { useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { ChevronLeft, ClipboardList, Plus, Sparkles, Users } from "lucide-react";
import { Layout } from "@/components/Layout";
import { ThemeCheck } from "@/components/ThemeCheck";
import { RewardGrid } from "@/components/RewardGrid";
import { CardShapeButton } from "@/components/CardShapeButton";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { ProgressRing } from "@/components/ui/ProgressRing";
import { CrystalProgress } from "@/components/ui/CrystalProgress";
import { useArtistImages, useData } from "@/store";
import { useActions } from "@/actions";
import { SakuraTree } from "@/components/SakuraTree";
import { useUpNavigate } from "@/lib/nav";
import { useAccent } from "@/lib/theme";
import { cn } from "@/lib/utils";
import { useT, useTf } from "@/lib/i18n";
import { monthOwnedCount } from "@/types";
import { PLATFORMS } from "@/lib/platforms";

export function MonthDetailPage({ onLock }: { onLock: () => void }) {
  const { artistId = "", monthId = "" } = useParams();
  const upNavigate = useUpNavigate();
  const { findArtist } = useData();
  const t = useT();
  const tf = useTf();
  const { showToast } = useActions();
  // place for the grid's buttons (New folder / Add missing / Select) in the month header
  const [toolbarHost, setToolbarHost] = useState<HTMLDivElement | null>(null);
  // make sure this artist's images are loaded (e.g. after a refresh on a month page)
  useArtistImages(artistId);
  // iridescent: the header is in a frosted glass box. Only the header, so the grid's
  // fixed dialogs aren't trapped by a backdrop-filter
  const accent = useAccent();
  const irid = accent === "iridescent";
  // the header box, styled per theme
  const headerBox =
    accent === "iridescent"
      ? "rounded-2xl border border-white/12 bg-zinc-900/42 backdrop-blur-xl"
      : accent === "cyberpunk"
        ? // The theme's plate: square, acid edge, cyan inner ring, and the cut
          // corner every cyberpunk surface in MiColl wears.
          "rounded-none border border-[#fcee0a]/45 bg-zinc-950/75 ring-1 ring-inset ring-[#00e5ff]/10 shadow-[0_0_24px_rgba(252,238,10,0.10)] [clip-path:polygon(0_0,100%_0,100%_calc(100%-16px),calc(100%-16px)_100%,0_100%)]"
        : accent === "sakura"
          ? "sak-card rounded-2xl"
          : "rounded-2xl border border-zinc-800 bg-zinc-900/60";

  // iridescent "Add rewards": same iri-lead rim as Create Card (index.css)
  const iriLeadBtn = irid ? "iri-lead rounded-lg" : undefined;

  // the two count badges under the title, colored per theme.
  // Owned uses the theme's "collected" color (mint / neon green / blossom),
  // released uses the neutral surface, missing stays amber everywhere.
  // Dark base so the text stays readable over the wallpaper.
  const ownedBadge =
    accent === "iridescent"
      ? "bg-zinc-950/55 text-[#a7f3d0] ring-1 ring-inset ring-[#a7f3d0]/45"
      : accent === "sakura"
        ? "bg-[#1b1016]/70 text-[#f9a8d4] ring-1 ring-inset ring-[#f9a8d4]/45"
        : accent === "cyberpunk"
          ? "rounded-none bg-zinc-950/70 text-[#39ff14] ring-1 ring-inset ring-[#39ff14]/50"
          : undefined;
  const releasedBadge =
    accent === "iridescent"
      ? "bg-zinc-950/45 text-zinc-100 ring-1 ring-inset ring-white/25"
      : accent === "sakura"
        ? "bg-[#1b1016]/70 text-zinc-100 ring-1 ring-inset ring-[#f9a8d4]/30"
        : accent === "cyberpunk"
          ? "rounded-none bg-zinc-950/70 text-[#00e5ff] ring-1 ring-inset ring-[#00e5ff]/40"
          : undefined;

  const artist = findArtist(artistId);
  const located = useMemo(() => {
    for (const p of artist?.platforms ?? []) {
      const m = p.months.find((mm) => mm.id === monthId);
      if (m) return { platform: p, month: m };
    }
    return undefined;
  }, [artist, monthId]);

  if (!artist || !located) {
    return (
      <Layout onLock={onLock}>
        <div className="grid h-full place-items-center text-zinc-400">{t("Month not found.")}</div>
      </Layout>
    );
  }

  const { platform, month } = located;
  const owned = monthOwnedCount(month);
  // released / % only with a template total
  const tracked = month.officialTotal != null;
  // a month that only shows borrowed collabs: no DB row, read-only
  const collabOnly = !!month.collabOnly;
  const pct = tracked && month.officialTotal! > 0 ? owned / month.officialTotal! : 0;
  // a template owns this platform if a period is verified or has a total,
  // then "Add missing" is hidden
  const templateActive =
    !!platform.verified || platform.months.some((m) => m.officialTotal != null);

  // click the creator name to copy it (going up = the Back button)
  const copyName = async () => {
    try {
      await navigator.clipboard.writeText(artist.name);
      showToast({ tone: "success", title: t("Copied to clipboard"), detail: `“${artist.name}”` });
    } catch (e) {
      showToast({ tone: "error", title: t("Couldn’t copy name"), detail: `${e}` });
    }
  };

  return (
    <Layout
      onLock={onLock}
      titleSlot={
        // lighter crumbs on iridescent
        <span className="flex min-w-0 items-center gap-1.5">
          <button
            type="button"
            onClick={copyName}
            title={t("Click to copy the creator name")}
            className={cn(
              "truncate font-medium transition-colors",
              irid ? "text-zinc-100 hover:text-white" : "text-zinc-100 hover:text-brand-300",
            )}
          >
            {artist.name}
          </button>
          {/* the creator's mark next to the name */}
          {artist.verified ? (
            <ThemeCheck
              className="h-4 w-4"
              label={t("Verified — an official template is applied")}
            />
          ) : artist.personalLog ? (
            <ClipboardList
              className="h-4 w-4 shrink-0 text-zinc-400"
              aria-label={t("Personal collection log applied")}
            />
          ) : null}
          <span className={irid ? "text-zinc-300" : "text-zinc-600"}>/</span>
          <button
            type="button"
            onClick={() =>
              upNavigate(`/artist/${artist.id}?platform=${encodeURIComponent(platform.name)}`)
            }
            title={tf("Back to {platform} — this creator’s year/month view", {
              platform: platform.name,
            })}
            // same color as the other crumbs (a dim one looked disabled)
            className={cn(
              "truncate font-medium transition-colors",
              irid ? "text-zinc-100 hover:text-white" : "text-zinc-100 hover:text-brand-300",
            )}
          >
            {platform.name}
          </button>
          <span className={irid ? "text-zinc-300" : "text-zinc-600"}>/</span>
          <span className="truncate font-medium text-zinc-100">{month.label}</span>
        </span>
      }
    >
      <div
        // min-h-full so the drop target reaches the bottom of the window
        className="min-h-full w-full px-6 py-6 2xl:px-10"
        // drop target: drops go into this month
        data-drop-artist={artist.name}
        data-drop-nodate={artist.noDates ? "1" : "0"}
        data-drop-platform={
          (PLATFORMS as readonly string[]).includes(platform.name) ? platform.name : undefined
        }
        data-drop-year={month.year ?? undefined}
        data-drop-month={month.month ?? undefined}
        data-drop-number={month.number ?? undefined}
        data-drop-style={platform.releaseStyle ?? undefined}
      >
        {/* month header (frosted on iridescent): Back + title + badges + actions */}
        <div className={cn("mb-6 p-4", headerBox)}>
          {/* top row: back on the left, month actions on the right */}
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <Button
              variant="ghost"
              size="sm"
              // keep the platform so we land on the same tab, matches allows history back
              onClick={() =>
                upNavigate(
                  `/artist/${artist.id}?platform=${encodeURIComponent(platform.name)}`,
                  (prev) => prev === `/artist/${artist.id}`,
                )
              }
              // bright frosted pill on iridescent
              className={
                irid
                  ? "border border-white/30 !bg-white/15 !text-white backdrop-blur-md hover:!bg-white/25"
                  : "-ml-2"
              }
            >
              <ChevronLeft className="h-4 w-4" />
              {tf("Back to {name}", { name: artist.name })}
            </Button>
            <div className="flex items-center gap-2">
              {/* the grid buttons portal here */}
              <div ref={setToolbarHost} className="flex items-center gap-2" />
              {/* collab-only month: nothing can be added or totalled */}
              {!collabOnly && (
                <>
                  <Button variant="outline" size="sm">
                    <Sparkles className="h-4 w-4" />
                    {t("Edit total")}
                  </Button>
                  <Button variant="primary" size="sm" className={iriLeadBtn}>
                    <Plus className="h-4 w-4" />
                    {t("Add rewards")}
                  </Button>
                </>
              )}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-4">
            {tracked &&
              // iridescent shows the progress crystal, sakura a blooming tree (% in the
              // tooltip)
              (irid ? (
                <CrystalProgress value={pct} size={64}>
                  <span className="text-xs">{Math.round(pct * 100)}%</span>
                </CrystalProgress>
              ) : accent === "sakura" ? (
                <SakuraTree
                  pct={pct}
                  className="h-16 w-16 shrink-0"
                  label={tf("{n}% of this month collected", { n: Math.round(pct * 100) })}
                />
              ) : (
                <ProgressRing value={pct} size={64} stroke={6}>
                  <span className="text-xs">{Math.round(pct * 100)}%</span>
                </ProgressRing>
              ))}
            <div className="flex-1">
              <h1 className="text-xl font-bold text-zinc-50">
                {month.label === "Misc" ? t("Unsorted") : month.label}
              </h1>
              <div className="mt-1.5 flex flex-wrap items-center gap-2">
                <Badge tone="green" className={ownedBadge}>
                  {tf("{n} owned", { n: owned })}
                </Badge>
                {tracked && (
                  <Badge tone="neutral" className={releasedBadge}>
                    {tf("{n} released", { n: month.officialTotal ?? 0 })}
                  </Badge>
                )}
                {tracked && month.officialTotal! - owned > 0 && (
                  <Badge tone="amber">{tf("{n} missing", { n: month.officialTotal! - owned })}</Badge>
                )}
              </div>
              {collabOnly && (
                <p className="collab-ink mt-2 flex items-center gap-1.5 text-xs">
                  <Users className="h-3.5 w-3.5 shrink-0" />
                  {t(
                    "Collab month — these rewards live in another creator’s folder and count toward theirs, not this one.",
                  )}
                </p>
              )}
            </div>
            {/* card shape for all of this creator's month pages */}
            <CardShapeButton
              scope="month"
              overrideKey={`artist-months:${artist.id}`}
              what={tf("{name}’s month pages", { name: artist.name })}
              className="self-end"
            />
          </div>
        </div>

        <RewardGrid
          items={month.rewards.map((r) => ({ reward: r, monthId: month.id }))}
          artistId={artist.id}
          shapeScope="month"
          shapeKey={`artist-months:${artist.id}`}
          defaultPeriodId={collabOnly ? undefined : month.id}
          allowMissing={!templateActive && !collabOnly}
          toolbarHost={toolbarHost}
          // the grid owns the empty space below so right-click offers "New folder here..."
          fillHeight
        />
      </div>
    </Layout>
  );
}
