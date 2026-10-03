import { motion } from "framer-motion";
import { Ban, PlayCircle, FolderPlus, FileArchive, Users, Unlink } from "lucide-react";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n";
import { useAccent } from "@/lib/theme";
import { Cover } from "@/components/Cover";
import { SdBadge, rewardSdState, rewardSdTitle } from "@/components/SdBadge";
import { FileCountChip } from "@/components/FileCountChip";
import type { Reward } from "@/types";

export function RewardSlot({
  reward,
  index,
  onOpen,
  onAdd,
  onContextMenu,
  isNew,
  aspect = "aspect-square",
}: {
  reward: Reward;
  index: number;
  onOpen: () => void;
  /** Fill a missing reward (browse for files). */
  onAdd?: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
  /** Show the "new" badge. The grid decides (it knows what was opened this session). */
  isNew?: boolean;
  /** Tile shape, passed down by the grid so 200 tiles don't each subscribe. */
  aspect?: string;
}) {
  const owned = reward.status === "owned";
  const skipped = reward.status === "skipped";
  // borrowed rewards never show "new" (the owner's card does)
  const showNew = !!isNew && owned;
  // borrowed collab reward (belongs to another creator): dashed frame + faded cover.
  // The frame is solid so it doesn't disappear on the premium wallpapers.
  const borrowed = !!reward.collabFrom;
  // the owner's folder is gone (renamed outside MiColl), say so on the tile
  const brokenLink = borrowed && reward.imageCount === 0;
  // missing slot is clickable when there's an add handler (never for borrowed ones)
  const canAdd = !owned && !skipped && !!onAdd && !borrowed;
  // play badge only if the reward is all video
  const onlyVideo =
    reward.images.length > 0 && reward.images.every((im) => im.kind === "video");
  // cover: the saved cover, or the first video for a video-only reward
  const coverPath =
    reward.cover || reward.images.find((im) => im.kind === "video")?.path || "";
  // only archives -> zip badge
  const onlyArchive =
    reward.images.length > 0 && reward.images.every((im) => im.kind === "archive");
  const cat = reward.category?.trim();
  // NSFW-ish categories get a rose tint
  const catRose = !!cat && /nsfw|18\+|r18|explicit/i.test(cat);
  // an extra: same tile shape (the grid rows are fixed), marked with a label and
  // an edge (.reward-extra in index.css)
  const isExtra = owned && !!reward.isExtra;

  // premium themes: darker frosted background + lighter text for missing slots
  const t = useT();
  const accent = useAccent();
  const premium = accent === "iridescent" || accent === "sakura" || accent === "cyberpunk";
  const missingBorder = premium
    ? canAdd
      ? "cursor-pointer border-dashed border-white/30 hover:border-white/55 hover:bg-white/10"
      : "cursor-default border-dashed border-white/25"
    : canAdd
      ? "cursor-pointer border-dashed border-zinc-700/80 hover:border-brand-500/60 hover:bg-brand-500/5"
      : "cursor-default border-dashed border-zinc-700/80";

  // MiSD marker for this reward
  const sdState = rewardSdState(reward);

  return (
    <motion.div layout className="group relative" onContextMenu={onContextMenu}>
      <button
        onClick={owned ? onOpen : canAdd ? onAdd : undefined}
        title={canAdd ? `Add files for “${reward.title}”` : undefined}
        className={cn(
          "relative block w-full overflow-hidden rounded-xl border outline-none transition-all focus-visible:ring-2 focus-visible:ring-brand-500",
          aspect,
          // standard accents tint the tile edge, premium themes have their own
          owned ? (premium ? "border-zinc-800" : "border-brand-500/25") : missingBorder,
          // own reward that's also credited to others (see .collab-shared)
          owned && !borrowed && !!reward.collabWith?.length && "collab-shared",
          isExtra && !borrowed && "reward-extra",
          // collab styles come from index.css (.collab-*), a broken link stays amber (it's
          // an error)
          borrowed &&
            (brokenLink
              ? "!border-dashed !border-amber-400/70 shadow-[0_0_0_1px_rgba(251,191,36,0.22)]"
              : "collab-ghost"),
        )}
      >
        {owned ? (
          <>
            <div
              className={cn(
                "h-full w-full transition-all duration-500 group-hover:scale-105",
                borrowed &&
                  "opacity-55 saturate-[.45] group-hover:opacity-90 group-hover:saturate-100",
              )}
            >
              <Cover path={coverPath} seed={reward.title} size={400} rounded="rounded-none" />
            </div>
            {borrowed && (
              // color tint so it reads as "not yours" on every background
              <span
                className={cn(
                  "pointer-events-none absolute inset-0",
                  brokenLink ? "bg-amber-500/12" : "collab-wash",
                )}
              />
            )}
            {onlyVideo && (
              <span className="pointer-events-none absolute inset-0 grid place-items-center">
                <PlayCircle className="h-10 w-10 text-white/85 drop-shadow-[0_2px_6px_rgba(0,0,0,0.8)]" />
              </span>
            )}
            {onlyArchive && (
              <span className="pointer-events-none absolute inset-0 grid place-items-center">
                <FileArchive className="h-10 w-10 text-amber-300/90 drop-shadow-[0_2px_6px_rgba(0,0,0,0.8)]" />
              </span>
            )}
            {showNew && !borrowed && (
              // top left so it stands out
              <span
                title={t("New — you haven’t opened this one yet")}
                className="new-badge pointer-events-none absolute left-2 top-2 px-1.5 py-0.5 text-[10px] font-bold uppercase"
              >
                New
              </span>
            )}
            <span className="pointer-events-none absolute right-2 top-2 flex items-center gap-1">
              {isExtra && (
                // in the badge row with the collab and MiSD chips
                <span
                  className="reward-extra-chip inline-flex items-center px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide backdrop-blur"
                  title={t("An extra — it doesn’t stand in for this month")}
                >
                  {t("Extra")}
                </span>
              )}
              {!borrowed && !!reward.collabWith?.length && (
                <span
                  title={`Collab with ${reward.collabWith.map((c) => c.artistName).join(", ")} — also shown in their card`}
                  className="collab-chip inline-flex max-w-[8rem] items-center gap-1 px-1.5 py-0.5 text-[10px] font-semibold backdrop-blur"
                >
                  <Users className="h-3 w-3 shrink-0" />
                  <span className="truncate">
                    {reward.collabWith.length === 1
                      ? reward.collabWith[0].artistName
                      : `${reward.collabWith.length} collabs`}
                  </span>
                </span>
              )}
              {sdState && <SdBadge state={sdState} title={rewardSdTitle(sdState, reward)} />}
              {reward.imageCount > 1 && (
                // hover shows the folder's size
                <FileCountChip reward={reward} />
              )}
            </span>
            {cat && (
              <span
                className={cn(
                  "absolute left-2 top-2 inline-flex items-center rounded-md px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide backdrop-blur",
                  catRose ? "bg-rose-500/85 text-white" : "bg-black/65 text-zinc-100",
                )}
              >
                {cat}
              </span>
            )}
            <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 to-transparent p-2 pt-6">
              {borrowed &&
                (brokenLink ? (
                  <span
                    title={`The folder for this collab is gone from disk — it was probably renamed or moved outside MiColl. Settings → Library health can remove the broken link.`}
                    className="mb-1 flex max-w-full items-center gap-1 rounded-md bg-amber-500/90 px-1.5 py-0.5 text-[10px] font-semibold text-white"
                  >
                    <Unlink className="h-3 w-3 shrink-0" />
                    <span className="truncate">{t("link broken")}</span>
                  </span>
                ) : (
                  <span
                    title={`Collab — this reward lives in ${reward.collabFrom!.artistName}’s folder`}
                    className="collab-chip mb-1 flex max-w-full items-center gap-1 px-1.5 py-0.5 text-[10px] font-semibold"
                  >
                    <Users className="h-3 w-3 shrink-0" />
                    <span className="truncate">from {reward.collabFrom!.artistName}</span>
                  </span>
                ))}
              <span className="line-clamp-2 text-[11px] font-medium leading-tight text-white">
                {reward.title}
              </span>
            </div>
          </>
        ) : (
          <>
          <div
            className={cn(
              "flex h-full w-full flex-col items-center justify-center gap-1 p-2 text-center",
              premium
                ? "bg-zinc-950/70 backdrop-blur-md"
                : "bg-[color-mix(in_srgb,var(--color-brand-500)_6%,#18181b)]",
            )}
          >
            {skipped ? (
              <Ban className={cn("h-5 w-5", premium ? "text-zinc-400" : "text-zinc-600")} />
            ) : (
              <span className={cn("text-2xl font-light", premium ? "text-zinc-300/80" : "text-zinc-700")}>
                #{index + 1}
              </span>
            )}
            <span
              className={cn(
                "text-[10px] font-semibold uppercase tracking-wide",
                // "missing" gets amber, "skipped" stays neutral
                skipped
                  ? premium
                    ? "text-zinc-300"
                    : "text-zinc-600"
                  : premium
                    ? "text-amber-300"
                    : "text-amber-500",
              )}
            >
              {skipped ? "skipped" : "missing"}
            </span>
            {cat && (
              <span
                className={cn(
                  "mt-0.5 inline-flex items-center rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide",
                  catRose
                    ? "bg-rose-500/25 text-rose-200"
                    : premium
                      ? "bg-black/45 text-zinc-200"
                      : "bg-zinc-800 text-zinc-400",
                )}
              >
                {cat}
              </span>
            )}
            <span
              className={cn(
                "line-clamp-2 px-1 text-[10px] leading-tight",
                premium ? "text-zinc-200" : "text-zinc-500",
              )}
            >
              {reward.title}
            </span>
          </div>
          {canAdd && (
            // dark frosted overlay so "Add files" is readable on hover
            <span className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-1 bg-zinc-950/80 opacity-0 backdrop-blur-sm transition-opacity group-hover:opacity-100">
              <FolderPlus className="h-6 w-6 text-brand-200" />
              <span className="text-[11px] font-semibold uppercase tracking-wide text-brand-100">
                {t("Add files")}
              </span>
            </span>
          )}
          </>
        )}
      </button>
    </motion.div>
  );
}
