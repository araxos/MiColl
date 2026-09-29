import { memo, useCallback, useMemo, useRef } from "react";
import { useParams } from "react-router-dom";
import { motion } from "framer-motion";
import { Check, FolderOpen, Trash2, RotateCcw, Coffee, BadgeCheck, CopyCheck, RefreshCw, HardDrive, DatabaseBackup, Sparkle } from "lucide-react";
import { SakuraBlossomIcon } from "@/lib/classIcons";
import { openDuplicates } from "@/lib/duplicates";
import { MonthMosaic } from "@/components/MonthMosaic";
import { Cover } from "@/components/Cover";
import { ProgressRing } from "@/components/ui/ProgressRing";
import { Badge } from "@/components/ui/Badge";
import { useActions } from "@/actions";
import { useAccent } from "@/lib/theme";
import { setVerifiedMark, useVerifiedMark } from "@/lib/verifiedMark";
import { useCardFx } from "@/lib/fx";
import type { MenuItem } from "@/components/ContextMenu";
import { useLibraryActions } from "@/store";
import {
  setPeriodPreview,
  setPeriodSkipped,
  revealPeriod,
  sdMark,
  sdBackupDrop,
} from "@/api/library";
import { SdBadge, type SdState } from "@/components/SdBadge";
import { cn } from "@/lib/utils";
import { useT, useTf, useTp } from "@/lib/i18n";
import { type Month, monthCompleteness, monthOwnedCount, ownRewards } from "@/types";

const ringColor: Record<string, string> = {
  complete: "stroke-emerald-500",
  partial: "stroke-amber-500",
  empty: "stroke-zinc-600",
};

function MonthCardBase({
  month,
  onOpen: onOpenMonth,
  hideYear = false,
}: {
  month: Month;
  /** Called with the month id. One function for the whole grid so memo works. */
  onOpen: (monthId: string) => void;
  /** Remove the year from the label (the section heading already shows it). */
  hideYear?: boolean;
}) {
  const t = useT();
  const tf = useTf();
  const tp = useTp();
  const { openMenu, requestDelete, backed, rescanArtist, bringBackFromSd, showToast } =
    useActions();
  const { refresh } = useLibraryActions();
  const onOpen = () => onOpenMonth(month.id);
  // month cards are only on a creator page, so the route gives us the artist
  const { artistId } = useParams<{ artistId: string }>();

  // ── mouse holo (iridescent template cards) ──
  // the mouse sets CSS variables for a 3D tilt + glare (throttled with rAF).
  // Off with reduced motion.
  const sceneRef = useRef<HTMLButtonElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const ptrRef = useRef({ x: 50, y: 50 });
  const reduceMotion =
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const onHoloMove = useCallback(
    (e: React.PointerEvent) => {
      if (reduceMotion) return;
      const el = sceneRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      ptrRef.current.x = Math.max(0, Math.min(100, ((e.clientX - r.left) / r.width) * 100));
      ptrRef.current.y = Math.max(0, Math.min(100, ((e.clientY - r.top) / r.height) * 100));
      if (rafRef.current == null) {
        rafRef.current = requestAnimationFrame(() => {
          rafRef.current = null;
          const node = sceneRef.current;
          if (!node) return;
          const { x, y } = ptrRef.current;
          const tilt = 9;
          node.style.setProperty("--px", `${x.toFixed(1)}%`);
          node.style.setProperty("--py", `${y.toFixed(1)}%`);
          node.style.setProperty("--rx", `${(((50 - y) / 50) * tilt).toFixed(2)}deg`);
          node.style.setProperty("--ry", `${(((x - 50) / 50) * tilt).toFixed(2)}deg`);
          node.style.setProperty("--active", "1");
        });
      }
    },
    [reduceMotion],
  );
  const onHoloLeave = useCallback(() => {
    const node = sceneRef.current;
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (!node) return;
    node.style.setProperty("--active", "0");
    node.style.setProperty("--rx", "0deg");
    node.style.setProperty("--ry", "0deg");
    node.style.setProperty("--px", "50%");
    node.style.setProperty("--py", "50%");
  }, []);

  const owned = monthOwnedCount(month);
  const state = monthCompleteness(month);
  // under a "2026" heading: "2026-04" -> "04", multi-year spans keep the full label
  const label = (() => {
    if (!hideYear || month.year == null) return month.label;
    const stripped = month.label.replace(new RegExp(`^${month.year}[-\\s]?`), "");
    if (stripped === month.label) return month.label; // didn't start with this year
    const m = /^(\d{1,2})$/.exec(stripped);
    return m ? String(Number(m[1])).padStart(2, "0") : stripped;
  })();
  // released count / % only with a template
  const tracked = month.officialTotal != null;
  const pct = tracked && month.officialTotal! > 0 ? owned / month.officialTotal! : 0;
  const skipped = month.skipped;
  // a month with only borrowed collabs counts as empty for this creator
  const own = ownRewards(month);
  const empty = own.length === 0;
  // mosaic uses the creator's own covers (collab-only months use the borrowed ones).
  // Extras are left out, unless the month has nothing else.
  const pool = own.length > 0 ? own : month.rewards;
  const feature = pool.filter((r) => !r.isExtra);
  const mosaic = feature.length > 0 ? feature : pool;

  // MiSD state of the month's rewards (marker + menu), no borrowed collabs
  const sdOwned = own.filter((r) => r.status === "owned");
  const sdOn = sdOwned.filter((r) => r.sdVolume);
  const sdQueued = sdOwned.filter((r) => !r.sdVolume && r.sdMarked).length;
  const sdBackedUp = sdOwned.filter((r) => !r.sdVolume && r.sdBackup);
  const sdBackupQueued = sdOwned.filter((r) => !r.sdVolume && r.sdBackupMarked).length;
  // same order as a single tile (see rewardSdState)
  const n = (k: number) => tp("{n} rewards", k);
  const sdMarker: { state: SdState; title: string } | null =
    sdOn.length > 0
      ? {
          state: "onSd",
          title:
            sdOn.length === sdOwned.length
              ? tf("Stored only on your MiSD disk “{volume}” — connect it to open", {
                  volume: sdOn[0]?.sdVolume ?? "",
                })
              : tf("{n} of {total} stored only on your MiSD disk “{volume}”", {
                  n: sdOn.length,
                  total: n(sdOwned.length),
                  volume: sdOn[0]?.sdVolume ?? "",
                }),
        }
      : sdQueued > 0
        ? {
            state: "marked",
            title: tf(
              "{n} marked for the next MiSD transport — the files will move to the disk",
              { n: n(sdQueued) },
            ),
          }
        : sdBackupQueued > 0
          ? {
              state: "backupMarked",
              title: tf("{n} marked for the next MiSD backup — the files stay here", {
                n: n(sdBackupQueued),
              }),
            }
          : sdBackedUp.length > 0
            ? {
                state: "backedUp",
                title:
                  sdBackedUp.length === sdOwned.length
                    ? tf(
                        "Backed up on your MiSD disk “{volume}” — the files also stay here",
                        { volume: sdBackedUp[0]?.sdBackup ?? "" },
                      )
                    : tf("{n} of {total} backed up on your MiSD disk “{volume}”", {
                        n: sdBackedUp.length,
                        total: n(sdOwned.length),
                        volume: sdBackedUp[0]?.sdBackup ?? "",
                      }),
              }
            : null;
  const sdChip = sdMarker && (
    <SdBadge
      state={sdMarker.state}
      className="absolute bottom-2 left-2 z-10"
      title={sdMarker.title}
    />
  );

  // cyberpunk: template months are a glowing "data chip", the glow grows with completion
  const accent = useAccent();
  const cyber = accent === "cyberpunk";
  const irid = accent === "iridescent";
  const sakura = accent === "sakura";
  // classic = blossom badge, minimal = the frame glows. Right-click the mark to switch.
  const markStyle = useVerifiedMark();
  const litEdge = sakura && month.verified && markStyle === "minimal";
  const markMenu = (e: React.MouseEvent) => {
    e.stopPropagation();
    openMenu(e, [
      markStyle === "classic"
        ? {
            label: t("Minimal mode"),
            icon: <Sparkle className="h-4 w-4" />,
            hint: t("all cards"),
            onClick: () => setVerifiedMark("minimal"),
          }
        : {
            label: t("Classic mode"),
            icon: <BadgeCheck className="h-4 w-4" />,
            hint: t("all cards"),
            onClick: () => setVerifiedMark("classic"),
          },
      {
        label:
          markStyle === "classic"
            ? t("Shows the template mark as a lit border instead of a badge.")
            : t("Puts the blossom badge back on the cover."),
        info: true,
      },
    ]);
  };
  // both looks of the verified mark, used by both sakura versions
  const sakVerifiedMark = sakura && month.verified && markStyle === "classic" && (
    <div
      className="absolute left-1 top-1 z-20 grid h-5 w-5 place-items-center"
      aria-label={t("Verified by a template")}
      title={t("Template-verified — right-click for the mark’s style")}
      onContextMenu={markMenu}
    >
      <SakuraBlossomIcon
        className="sak-bloom-badge absolute inset-0 h-5 w-5"
        fill="currentColor"
        stroke="none"
      />
      <span className="sak-bloom-core relative grid h-2.5 w-2.5 place-items-center rounded-full">
        <Check className="h-1.5 w-1.5 text-white" strokeWidth={4} />
      </span>
    </div>
  );
  // minimal mode: 4 thin strips on the edge to right-click (the rest still opens the month)
  const sakEdgeStrips = litEdge && (
    <div aria-hidden className="pointer-events-none absolute inset-0 z-20">
      {(
        [
          "inset-x-0 top-0 h-2",
          "inset-x-0 bottom-0 h-2",
          "inset-y-0 left-0 w-2",
          "inset-y-0 right-0 w-2",
        ] as const
      ).map((pos) => (
        <span
          key={pos}
          onContextMenu={markMenu}
          title={t("Template-verified — right-click for the mark’s style")}
          className={cn("pointer-events-auto absolute", pos)}
        />
      ))}
    </div>
  );
  const pctInt = Math.round(pct * 100);
  const cpTier: "none" | "low" | "mid" | "max" =
    pctInt >= 100 ? "max" : pctInt >= 51 ? "mid" : pctInt >= 1 ? "low" : "none";
  // glow color by level: 100% green, 51-99% yellow, 1-50% orange, 0% red.
  // more glitching when fuller. At 100% the glow is neon orange + a sweep.
  const CP = {
    none: { glow: "#ff2b4d", line: "rgba(255,43,77,.55)", pct: "#ff4d63", gdur: "6.5s", spin: "0s" },
    low: { glow: "#1e90ff", line: "rgba(56,160,255,.6)", pct: "#ff9d2e", gdur: "5s", spin: "7s" },
    mid: { glow: "#a855f7", line: "rgba(168,85,247,.65)", pct: "#fde047", gdur: "3.6s", spin: "4.5s" },
    max: { glow: "#ff7a18", line: "rgba(255,122,24,.7)", pct: "#4ade80", gdur: "2.4s", spin: "3s" },
  }[cpTier];
  // 3 progress pips (at least 1 once anything is owned)
  const cpFilled = cpTier === "none" ? 0 : Math.min(3, Math.max(1, Math.round(pct * 3)));
  // iridescent: glossy crystal card, the foil gets stronger with completion

  // foil level: 2 (strong + sparkle) at 100%, 1 at 50-99%, none below.
  // up here because the sparkles use a hook. Off when animations are off.
  const anim = useCardFx();
  // foil level for a tracked month (iridescent and sakura each draw their own)
  const holoTier = tracked ? (pctInt >= 100 ? 2 : pctInt >= 50 ? 1 : 0) : 0;
  const iriHolo = anim && irid ? holoTier : 0;
  const sakHolo = anim && sakura ? holoTier : 0;
  // iridescent sparkles at stable random spots (per month). Long cycles so it only
  // glints now and then. The negative delay uses each speck's own duration.
  const iriSparkles = useMemo(() => {
    if (iriHolo !== 2) return null;
    const rnd = (a: number, b: number) => a + Math.random() * (b - a);
    const hues = ["#ffd0e6", "#cdeeff", "#e0d4ff", "#ffe2cc", "#d2f7ea"];
    const pick = () => hues[Math.floor(Math.random() * hues.length)];
    const dots = Array.from({ length: 22 }, (_, i) => {
      const c = pick();
      const s = rnd(2.6, 5);
      const dur = rnd(5, 11);
      return (
        <span
          key={`d${i}`}
          style={{
            position: "absolute",
            left: `${rnd(4, 96).toFixed(1)}%`,
            top: `${rnd(4, 96).toFixed(1)}%`,
            width: `${s.toFixed(1)}px`,
            height: `${s.toFixed(1)}px`,
            marginLeft: `${(-s / 2).toFixed(1)}px`,
            marginTop: `${(-s / 2).toFixed(1)}px`,
            borderRadius: "50%",
            background: `radial-gradient(circle, #fff 0%, ${c} 55%, transparent 100%)`,
            boxShadow: `0 0 6px 1px ${c}`,
            opacity: 0,
            animation: `micoll-holo-twinkle ${dur.toFixed(2)}s ease-in-out ${(-rnd(0, dur)).toFixed(2)}s infinite`,
          }}
        />
      );
    });
    const stars = Array.from({ length: 5 }, (_, i) => {
      const c = pick();
      const s = rnd(10, 16);
      const dur = rnd(7, 14);
      return (
        <span
          key={`s${i}`}
          style={{
            position: "absolute",
            left: `${rnd(8, 92).toFixed(1)}%`,
            top: `${rnd(8, 92).toFixed(1)}%`,
            width: `${s.toFixed(1)}px`,
            height: `${s.toFixed(1)}px`,
            marginLeft: `${(-s / 2).toFixed(1)}px`,
            marginTop: `${(-s / 2).toFixed(1)}px`,
            background: `radial-gradient(circle, #fff 0%, ${c} 48%, transparent 74%)`,
            clipPath: "polygon(50% 0,58% 42%,100% 50%,58% 58%,50% 100%,42% 58%,0 50%,42% 42%)",
            filter: `drop-shadow(0 0 4px ${c})`,
            opacity: 0,
            animation: `micoll-holo-star ${dur.toFixed(2)}s ease-in-out ${(-rnd(0, dur)).toFixed(2)}s infinite`,
          }}
        />
      );
    });
    return [...dots, ...stars];
  }, [iriHolo, month.id]);

  // ── sakura: cherry blossom foil (template months) ──
  // falling petals + sparkles at 100%. Random per month so positions stay stable.
  const sakPetals = useMemo(() => {
    if (sakHolo < 1) return null;
    const rnd = (a: number, b: number) => a + Math.random() * (b - a);
    const hues = ["255,180,224", "206,150,255", "255,150,200", "232,168,255", "255,196,224"];
    const pick = () => hues[Math.floor(Math.random() * hues.length)];
    const v2 = sakHolo === 2;
    // fewer petals at 100% (the sparkles show "complete")
    const count = v2 ? 6 : 9;
    return Array.from({ length: count }, (_, i) => {
      const hue = pick();
      const size = rnd(8, v2 ? 17 : 14);
      // x0.9 so the petals aren't the loudest thing
      const op = rnd(v2 ? 0.5 : 0.34, v2 ? 0.82 : 0.5) * 0.9;
      const dur = rnd(v2 ? 5 : 7, v2 ? 9 : 12);
      const delay = -rnd(0, dur);
      const sway = rnd(2.4, 4.6);
      const blur = rnd(0.3, v2 ? 0.9 : 1.3);
      const glow = rnd(4, v2 ? 11 : 7);
      return (
        <span
          key={`pt${i}`}
          style={{
            position: "absolute",
            left: `${rnd(-4, 98).toFixed(1)}%`,
            top: 0,
            animation: `micoll-sak-fall ${dur.toFixed(2)}s linear ${delay.toFixed(2)}s infinite`,
            willChange: "transform",
          }}
        >
          <span
            style={{
              display: "block",
              animation: `micoll-sak-sway ${sway.toFixed(2)}s ease-in-out ${delay.toFixed(2)}s infinite alternate`,
            }}
          >
            <span
              style={{
                display: "block",
                width: `${size.toFixed(1)}px`,
                height: `${(size * 1.3).toFixed(1)}px`,
                borderRadius: "100% 0 100% 0",
                background: `radial-gradient(125% 120% at 30% 22%, rgba(255,255,255,.92), rgba(${hue},${op.toFixed(2)}) 55%, rgba(${hue},0) 100%)`,
                mixBlendMode: "screen",
                filter: `blur(${blur.toFixed(2)}px) drop-shadow(0 0 ${glow.toFixed(1)}px rgba(${hue},.5))`,
                transform: "rotate(35deg)",
              }}
            />
          </span>
        </span>
      );
    });
  }, [sakHolo, month.id]);
  // sakura sparkles: white stars that twinkle, on top of the foil
  const sakSparkles = useMemo(() => {
    if (sakHolo !== 2) return null;
    const rnd = (a: number, b: number) => a + Math.random() * (b - a);
    return Array.from({ length: 24 }, (_, i) => {
      const size = rnd(5, 12);
      const dur = rnd(1.6, 3.2);
      const delay = -rnd(0, dur * 1.5);
      const glow = rnd(4, 9);
      return (
        <span
          key={`sk${i}`}
          style={{
            position: "absolute",
            left: `${rnd(4, 94).toFixed(1)}%`,
            top: `${rnd(4, 94).toFixed(1)}%`,
            width: `${size.toFixed(1)}px`,
            height: `${size.toFixed(1)}px`,
            marginLeft: `${(-size / 2).toFixed(1)}px`,
            marginTop: `${(-size / 2).toFixed(1)}px`,
            background: "radial-gradient(circle, #ffffff 0%, rgba(255,200,236,.92) 48%, rgba(255,160,220,0) 100%)",
            clipPath: "polygon(50% 0%,60% 40%,100% 50%,60% 60%,50% 100%,40% 60%,0% 50%,40% 40%)",
            filter: `drop-shadow(0 0 ${glow.toFixed(1)}px rgba(255,205,238,.95))`,
            opacity: 0,
            animation: `micoll-sak-twinkle ${dur.toFixed(2)}s ease-in-out ${delay.toFixed(2)}s infinite`,
            willChange: "transform,opacity",
          }}
        />
      );
    });
  }, [sakHolo, month.id]);

  const onContextMenu = (e: React.MouseEvent) => {
    const items: MenuItem[] = [
      {
        label: t("Show in Explorer"),
        icon: <FolderOpen className="h-4 w-4" />,
        onClick: () => {
          if (backed) void revealPeriod(month.id);
        },
      },
      // reset cover only for a real month
      ...(!skipped
        ? [
            {
              label: t("Reset cover"),
              icon: <RotateCcw className="h-4 w-4" />,
              onClick: () => {
                if (backed) void setPeriodPreview(month.id, "").then(() => refresh());
              },
            },
          ]
        : []),
      // breaks only exist for monthly creators
      ...(month.number == null
        ? [
            {
              label: skipped ? t("Unmark skipped (break)") : t("Mark as skipped (break)"),
              icon: <Coffee className="h-4 w-4" />,
              onClick: () => {
                if (backed) void setPeriodSkipped(month.id, !skipped).then(() => refresh());
              },
            },
          ]
        : []),
    ];
    if (!empty) {
      items.push({
        label: t("Find duplicates"),
        icon: <CopyCheck className="h-4 w-4" />,
        onClick: () => openDuplicates({ label: month.label, periodId: Number(month.id) }),
      });
    }
    // MiSD submenu: two separate queues + what's already on the disk
    const sdItems: MenuItem[] = [];
    if (backed && sdOwned.length > sdOn.length) {
      sdItems.push(
        sdQueued > 0
          ? {
              label: `Unmark move (${sdQueued})`,
              icon: <HardDrive className="h-4 w-4" />,
              onClick: () =>
                void sdMark({ periodId: Number(month.id), marked: false }).then(() => refresh()),
            }
          : {
              label: t("Move to disk"),
              icon: <HardDrive className="h-4 w-4" />,
              onClick: () =>
                void sdMark({ periodId: Number(month.id), marked: true }).then(() => refresh()),
            },
        sdBackupQueued > 0
          ? {
              label: `Unmark backup (${sdBackupQueued})`,
              icon: <DatabaseBackup className="h-4 w-4" />,
              onClick: () =>
                void sdMark({ periodId: Number(month.id), marked: false, mode: "backup" }).then(
                  () => refresh(),
                ),
            }
          : {
              label: t("Back up to disk"),
              icon: <DatabaseBackup className="h-4 w-4" />,
              onClick: () =>
                void sdMark({ periodId: Number(month.id), marked: true, mode: "backup" }).then(
                  () => refresh(),
                ),
            },
      );
    }
    if (backed && sdBackedUp.length) {
      sdItems.push({
        label: `Remove backup (${sdBackedUp.length})`,
        icon: <DatabaseBackup className="h-4 w-4" />,
        danger: true,
        onClick: () =>
          void sdBackupDrop(sdBackedUp.map((r) => Number(r.id)))
            .then((s) => {
              showToast(
                s.failed
                  ? {
                      tone: "warn",
                      title: `MiSD: removed ${s.moved} backups, ${s.failed} failed`,
                      detail: s.errors.slice(0, 3).join(" · "),
                    }
                  : {
                      tone: "success",
                      title: t("MiSD backups removed"),
                      detail: t("The local files were not touched."),
                    },
              );
              return refresh();
            })
            .catch((err) => showToast({ tone: "error", title: "MiSD", detail: `${err}` })),
      });
    }
    if (backed && sdOn.length) {
      sdItems.push({
        label: `Bring back (${sdOn.length})`,
        icon: <HardDrive className="h-4 w-4" />,
        onClick: () => void bringBackFromSd(sdOn.map((r) => Number(r.id))),
      });
    }
    if (sdItems.length) {
      items.push({ label: "MiSD", icon: <HardDrive className="h-4 w-4" />, children: sdItems });
    }
    items.push({
      // only this creator (see rescanArtist)
      label: t("Reload"),
      icon: <RefreshCw className="h-4 w-4" />,
      onClick: () => artistId && rescanArtist(artistId),
    });
    // collab-only months have nothing to delete, remove the link on the reward instead
    if (!month.collabOnly) {
      items.push({
        label: skipped ? t("Delete break…") : t("Delete month…"),
        icon: <Trash2 className="h-4 w-4" />,
        danger: true,
        // break/empty month -> delete the period, otherwise delete its rewards
        onClick: () =>
          requestDelete(
            skipped || empty
              ? { title: month.label, periodId: month.id }
              : { title: month.label, rewardIds: own.map((r) => r.id) },
          ),
      });
    }
    openMenu(e, items);
  };

  // sizing: the card fills its grid cell (h-full) and the cover takes the rest (grow),
  // so all cards in a row are the same size even with different footers

  // break: a slim grey "Break" card, half width (see ArtistPage), full row height.
  // The cup takes the theme color. No verified check.
  if (skipped) {
    const cupColor = cyber
      ? "text-[#fcee0a]"
      : sakura
        ? "text-pink-300"
        : irid
          ? "text-violet-200"
          : "text-brand-300";
    const cupGlow = cyber
      ? "drop-shadow-[0_0_7px_rgba(252,238,10,0.8)]"
      : sakura
        ? "drop-shadow-[0_0_6px_rgba(244,114,182,0.55)]"
        : irid
          ? "drop-shadow-[0_0_7px_rgba(196,181,253,0.7)]"
          : "";
    // iridescent: slow hue shimmer on the cup
    const cupStyle = irid ? { animation: "micoll-iri-mark 6s ease-in-out infinite" } : undefined;
    return (
      <motion.button
        layout
        whileHover={{ y: -3 }}
        whileTap={{ scale: 0.98 }}
        transition={{ type: "spring", stiffness: 400, damping: 28 }}
        onClick={onOpen}
        onContextMenu={onContextMenu}
        data-drop-year={month.year ?? undefined}
        data-drop-month={month.month ?? undefined}
        className="group relative flex h-full flex-col overflow-hidden rounded-xl border border-dashed border-zinc-700 bg-zinc-900/60 text-left outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
      >
        <div className="relative flex min-h-[6rem] flex-1 items-center justify-center bg-[repeating-linear-gradient(135deg,theme(colors.zinc.800/.5)_0_10px,transparent_10px_20px)] px-2">
          <div className="flex flex-col items-center gap-1.5">
            <Coffee className={cn("h-8 w-8", cupColor, cupGlow)} style={cupStyle} />
            <span className="text-[11px] font-medium uppercase tracking-wide text-zinc-400">
              {t("Break")}
            </span>
          </div>
        </div>
        <div className="px-2 py-2 text-center">
          <div className="truncate text-sm font-semibold text-zinc-300">{label}</div>
        </div>
      </motion.button>
    );
  }

  // ── cyberpunk: glowing "data chip" for template months ──
  if (cyber && tracked) {
    return (
      <motion.div
        layout
        className={cn("cp-aura cyber-fx", cpTier !== "none" && `cp-${cpTier}`)}
        style={{ "--cp-glow": CP.glow, "--cp-spin": CP.spin } as React.CSSProperties}
      >
        {/* neon charge running around the chip + energy on the top edge */}
        {cpTier !== "none" && (
          <>
            <div className="cp-ring" aria-hidden />
            <div className="cp-flames" aria-hidden>
              <span />
              <span />
            </div>
          </>
        )}
        <motion.button
          whileHover={{ y: -3 }}
          whileTap={{ scale: 0.98 }}
          transition={{ type: "spring", stiffness: 400, damping: 28 }}
          onClick={onOpen}
          onContextMenu={onContextMenu}
          data-drop-year={month.year ?? undefined}
          data-drop-month={month.month ?? undefined}
          style={{ "--cp-line": CP.line, "--cp-gdur": CP.gdur } as React.CSSProperties}
          className="cp-chip group relative flex h-full w-full flex-col overflow-hidden text-left outline-none"
        >
          <div className="relative aspect-square w-full grow overflow-hidden">
            <div className="h-full w-full transition-transform duration-500 group-hover:scale-105">
              {month.coverImage ? (
                <Cover path={month.coverImage} seed={month.label} rounded="rounded-none" />
              ) : (
                <MonthMosaic covers={mosaic.map((r) => r.cover)} seed={month.label} />
              )}
            </div>
            {/* scanlines + glitch slices, a sweep at 100% */}
            <div className="cp-scan" />
            <div className="cp-glitch" />
            {cpTier === "max" && <div className="micoll-holo absolute inset-0" />}
            {month.verified && (
              <div className="cp-check absolute left-2 top-2 h-5 w-5" aria-label={t("Verified by a template")}>
                <Check className="cp-check-base absolute inset-0 h-5 w-5" strokeWidth={3} />
                <Check className="cp-check-ghost absolute inset-0 h-5 w-5" strokeWidth={3} />
              </div>
            )}
            {sdChip}
          </div>

          {/* one line footer, the % shows on hover over the pips (more room for the cover) */}
          <div
            className="relative flex items-center justify-between gap-2 px-3 py-2.5"
            style={{ borderTop: `1px solid ${CP.line}` }}
          >
            {/* month number in the top left corner of the strip (square corners) */}
            <div
              className="-ml-3 -mt-2.5 grid h-7 min-w-[1.75rem] max-w-[5rem] place-items-center truncate rounded-none border border-l-0 border-t-0 px-2 font-mono text-xs font-bold"
              style={{ borderColor: CP.glow, color: CP.glow, boxShadow: `0 0 9px -2px ${CP.glow}` }}
            >
              {label}
            </div>
            {/* pips and % swap in a fixed size box so hover doesn't jump.
                group/pips is separate from the card group (cover zoom) */}
            <div className="group/pips relative flex h-4 shrink-0 items-center">
              {/* the 3 level bars (see .cp-pips in index.css) */}
              <div className="cp-pips flex items-center gap-1 transition-opacity duration-150 group-hover/pips:opacity-0">
                {[0, 1, 2].map((i) => (
                  <span
                    key={i}
                    className="h-3.5 w-1.5 -skew-x-12 rounded-[1px]"
                    style={
                      i < cpFilled
                        ? { background: CP.pct, boxShadow: `0 0 7px ${CP.pct}` }
                        : { border: `1px solid ${CP.pct}`, opacity: 0.3 }
                    }
                  />
                ))}
              </div>
              {/* % in the level color, right aligned, pointer-events-none so it doesn't
                  flicker */}
              <div
                className="cp-pct pointer-events-none absolute inset-y-0 right-0 flex items-center whitespace-nowrap font-mono text-sm font-extrabold tabular-nums tracking-wider opacity-0 transition-opacity duration-150 group-hover/pips:opacity-100"
                style={{ color: CP.pct, textShadow: `0 0 12px ${CP.pct}` }}
              >
                {pctInt}%
              </div>
            </div>
          </div>
        </motion.button>
      </motion.div>
    );
  }

  // ── iridescent: crystal card for template months ──
  if (irid && tracked) {
    const iriTier = cpTier; // none | low | mid | max
    return (
      <motion.div
        layout
        className={cn("iri-aura", iriTier !== "none" && `iri-${iriTier}`)}
      >
        <motion.button
          ref={sceneRef}
          whileHover={{ y: -3 }}
          whileTap={{ scale: 0.98 }}
          transition={{ type: "spring", stiffness: 400, damping: 28 }}
          onClick={onOpen}
          onContextMenu={onContextMenu}
          onPointerMove={iriHolo ? onHoloMove : undefined}
          onPointerLeave={iriHolo ? onHoloLeave : undefined}
          data-drop-year={month.year ?? undefined}
          data-drop-month={month.month ?? undefined}
          className="iri-holo-scene group relative block h-full w-full text-left outline-none"
        >
          <div className={cn("iri-card iri-holo-card flex h-full w-full flex-col overflow-hidden", iriHolo && "iri-holo-tilt")}>
          <div className="relative aspect-square w-full grow overflow-hidden">
            <div className="h-full w-full transition-transform duration-500 group-hover:scale-105">
              {month.coverImage ? (
                <Cover path={month.coverImage} seed={month.label} rounded="rounded-none" />
              ) : (
                <MonthMosaic covers={mosaic.map((r) => r.cover)} seed={month.label} />
              )}
            </div>
            {/* holo foil: pastel bands + mouse grain & glare. At 100% a prism band +
                sparkles */}
            {iriHolo >= 1 && (
              <div
                className={cn("iri-holo", iriHolo === 2 ? "iri-holo--v2" : "iri-holo--v1")}
                aria-hidden
              >
                <div className="iri-holo-bands" />
                {iriHolo === 2 && <div className="iri-holo-prism" />}
                <div className="iri-holo-grain" />
                <div className="iri-holo-pearl" />
                <div className="iri-holo-glare" />
                <div className="iri-holo-gloss" />
                {/* sparkles last so they're on top */}
                {iriHolo === 2 && <div className="iri-holo-spark">{iriSparkles}</div>}
              </div>
            )}
            {month.verified && (
              <Check
                className="iri-check absolute left-2 top-2 h-5 w-5"
                strokeWidth={3}
                aria-label={t("Verified by a template")}
              />
            )}
            {sdChip}
          </div>

          {/* one line footer, % shows on hover over the crystals */}
          <div className="iri-foot relative flex items-center justify-between gap-2 border-t border-white/15 px-3 py-2.5">
            {/* month label in the strip's top left corner (negative margins cancel the
                padding,
                only the inner corner is rounded) */}
            <div className="iri-pill -ml-3 -mt-2.5 inline-block min-w-0 max-w-full truncate rounded-none rounded-br-lg !border-l-0 !border-t-0 px-2.5 py-1 text-xs font-semibold">
              {label}
            </div>
            {/* crystals and % swap in a fixed size box. h-4 keeps the strip height. */}
            <div className="group/pips relative flex h-4 shrink-0 items-center">
              <div className="flex items-center gap-1.5 transition-opacity duration-150 group-hover/pips:opacity-0">
                {[0, 1, 2].map((i) => (
                  <span
                    key={i}
                    className={cn(
                      "iri-kite h-3 w-3 rotate-45",
                      i < cpFilled ? "iri-kite--on" : "iri-kite--off",
                    )}
                  />
                ))}
              </div>
              {/* right aligned so "100%" isn't clipped, pointer-events-none */}
              <span className="iri-pct pointer-events-none absolute inset-y-0 right-0 flex items-center whitespace-nowrap text-sm font-extrabold tabular-nums tracking-wide opacity-0 transition-opacity duration-150 group-hover/pips:opacity-100">
                {pctInt}%
              </span>
            </div>
          </div>
          </div>
        </motion.button>
      </motion.div>
    );
  }

  // ── sakura: cherry blossom foil for template months ──
  if (sakura && tracked) {
    return (
      <motion.button
        ref={sceneRef}
        layout
        whileHover={{ y: -3 }}
        whileTap={{ scale: 0.98 }}
        transition={{ type: "spring", stiffness: 400, damping: 28 }}
        onClick={onOpen}
        onContextMenu={onContextMenu}
        onPointerMove={sakHolo ? onHoloMove : undefined}
        onPointerLeave={sakHolo ? onHoloLeave : undefined}
        data-drop-year={month.year ?? undefined}
        data-drop-month={month.month ?? undefined}
        className="sak-holo-scene group relative block h-full w-full text-left outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
      >
        <div
          className={cn(
            "sak-card sak-holo-card relative flex h-full w-full flex-col overflow-hidden rounded-xl",
            sakHolo && "sak-holo-tilt",
            litEdge && "sak-verified-edge",
          )}
        >
          {sakEdgeStrips}
          <div className="relative aspect-square w-full grow overflow-hidden">
            <div className="h-full w-full transition-transform duration-500 group-hover:scale-105">
              {month.coverImage ? (
                <Cover path={month.coverImage} seed={month.label} rounded="rounded-none" />
              ) : (
                <MonthMosaic covers={mosaic.map((r) => r.cover)} seed={month.label} />
              )}
            </div>
            {/* foil: pastel bands + falling petals. At 100% a prism band + sparkles */}
            {sakHolo >= 1 && (
              <div
                className={cn("sak-holo", sakHolo === 2 ? "sak-holo--v2" : "sak-holo--v1")}
                aria-hidden
              >
                <div className="sak-holo-bands" />
                {sakHolo === 2 && <div className="sak-holo-prism" />}
                <div className="sak-holo-pearl" />
                <div className="sak-holo-glare" />
                <div className="sak-holo-petals">{sakPetals}</div>
                <div className="sak-holo-gloss" />
                {/* sparkles last so they're on top */}
                {sakHolo === 2 && <div className="sak-holo-spark">{sakSparkles}</div>}
              </div>
            )}
            {/* no green "complete" disc, the foil already shows it */}
            {/* verified: pink blossom badge in the corner (20px). Right-click to switch
                style. */}
            {sakVerifiedMark}
            {sdChip}
          </div>

          {/* one line footer: month pill + 3 petal pips, % on hover */}
          <div className="sak-foot relative flex items-center justify-between gap-2 px-3 py-2.5">
            {/* in the top left corner (see the iridescent footer) */}
            <div className="sak-pill -ml-3 -mt-2.5 inline-block min-w-0 max-w-full truncate rounded-none rounded-br-lg !border-l-0 !border-t-0 px-2.5 py-1 text-xs font-semibold">
              {label}
            </div>
            {/* petals and % swap in a fixed size box */}
            {/* h-4 keeps the footer height */}
            <div className="group/pips relative flex h-4 shrink-0 items-center">
              {/* positions are in .sak-pip-cluster (index.css) */}
              <div className="sak-pip-cluster transition-opacity duration-150 group-hover/pips:opacity-0">
                {[0, 1, 2].map((i) => (
                  <span
                    key={i}
                    className={cn(
                      "sak-petal-pip",
                      i < cpFilled ? "sak-petal-pip--on" : "sak-petal-pip--off",
                    )}
                  />
                ))}
              </div>
              {/* right aligned so "100%" isn't clipped */}
              <span className="sak-pct pointer-events-none absolute inset-y-0 right-0 flex items-center whitespace-nowrap text-sm font-extrabold tabular-nums tracking-wide opacity-0 transition-opacity duration-150 group-hover/pips:opacity-100">
                {pctInt}%
              </span>
            </div>
          </div>
        </div>
      </motion.button>
    );
  }

  // ── iridescent without template: same glass, no effects ──
  // the theme's look but no holo/tilt/%, the foil is for template months.
  // Nothing animates, so it's cheap.
  if (irid) {
    return (
      <motion.button
        layout
        whileHover={{ y: -3 }}
        whileTap={{ scale: 0.98 }}
        transition={{ type: "spring", stiffness: 400, damping: 28 }}
        onClick={onOpen}
        onContextMenu={onContextMenu}
        data-drop-year={month.year ?? undefined}
        data-drop-month={month.month ?? undefined}
        className="group relative block h-full w-full text-left outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
      >
        <div className="iri-card-quiet flex h-full w-full flex-col overflow-hidden">
          <div className="relative aspect-square w-full grow overflow-hidden">
            <div className="h-full w-full transition-transform duration-500 group-hover:scale-105">
              {month.coverImage ? (
                <Cover path={month.coverImage} seed={month.label} rounded="rounded-none" />
              ) : (
                <MonthMosaic covers={mosaic.map((r) => r.cover)} seed={month.label} />
              )}
            </div>
            {/* only for a verified template without official count */}
            {month.verified && (
              <Check
                className="iri-check absolute left-2 top-2 h-5 w-5"
                strokeWidth={3}
                aria-label={t("Verified by a template")}
              />
            )}
            {sdChip}
          </div>

          <div className="iri-foot-quiet relative flex items-center justify-between gap-2 border-t border-white/12 px-3 py-2.5">
            {/* same corner label as the template card */}
            <div className="iri-pill -ml-3 -mt-2.5 inline-block min-w-0 max-w-full truncate rounded-none rounded-br-lg !border-l-0 !border-t-0 px-2.5 py-1 text-xs font-semibold">
              {label}
            </div>
            {/* one outline crystal next to the count */}
            <div className="flex shrink-0 items-center gap-1.5 text-[11px] font-medium text-[#dbe7ff]">
              <span className="iri-kite iri-kite--off h-3 w-3 rotate-45" />
              {tp("{n} rewards", owned)}
            </div>
          </div>
        </div>
      </motion.button>
    );
  }

  // ── sakura without template: same frame, no foil ──
  // rose glass + month pill, but no holo/petals/tilt/%.
  if (sakura) {
    return (
      <motion.button
        layout
        whileHover={{ y: -3 }}
        whileTap={{ scale: 0.98 }}
        transition={{ type: "spring", stiffness: 400, damping: 28 }}
        onClick={onOpen}
        onContextMenu={onContextMenu}
        data-drop-year={month.year ?? undefined}
        data-drop-month={month.month ?? undefined}
        className="group relative block h-full w-full text-left outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
      >
        <div
          className={cn(
            "sak-card relative flex h-full w-full flex-col overflow-hidden rounded-xl",
            litEdge && "sak-verified-edge",
          )}
        >
          {sakEdgeStrips}
          <div className="relative aspect-square w-full grow overflow-hidden">
            <div className="h-full w-full transition-transform duration-500 group-hover:scale-105">
              {month.coverImage ? (
                <Cover path={month.coverImage} seed={month.label} rounded="rounded-none" />
              ) : (
                <MonthMosaic covers={mosaic.map((r) => r.cover)} seed={month.label} />
              )}
            </div>
            {/* only for a verified template without official count */}
            {sakVerifiedMark}
            {sdChip}
          </div>

          <div className="sak-foot relative flex items-center justify-between gap-2 px-3 py-2.5">
            <div className="sak-pill -ml-3 -mt-2.5 inline-block min-w-0 max-w-full truncate rounded-none rounded-br-lg !border-l-0 !border-t-0 px-2.5 py-1 text-xs font-semibold">
              {label}
            </div>
            {/* one outline petal next to the count */}
            <div className="flex shrink-0 items-center gap-1.5 text-[11px] font-medium text-[#f0c8dc]">
              <span className="sak-petal-pip sak-petal-pip--off h-3.5 w-2.5" />
              {tp("{n} rewards", owned)}
            </div>
          </div>
        </div>
      </motion.button>
    );
  }

  return (
    <motion.button
      layout
      whileHover={{ y: -3 }}
      whileTap={{ scale: 0.98 }}
      transition={{ type: "spring", stiffness: 400, damping: 28 }}
      onClick={onOpen}
      onContextMenu={onContextMenu}
      data-drop-year={month.year ?? undefined}
      data-drop-month={month.month ?? undefined}
      // standard accents: a bit of the accent color in the card and border
      className="group relative flex h-full flex-col overflow-hidden rounded-xl border border-brand-500/25 bg-[color-mix(in_srgb,var(--color-brand-500)_7%,#18181b)] text-left outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
    >
      <div className="relative aspect-square w-full grow overflow-hidden">
        <div className="h-full w-full transition-transform duration-500 group-hover:scale-105">
          {month.coverImage ? (
            <Cover path={month.coverImage} seed={month.label} rounded="rounded-none" />
          ) : (
            <MonthMosaic covers={mosaic.map((r) => r.cover)} seed={month.label} />
          )}
        </div>
        {state === "complete" && (
          <div className="absolute right-2 top-2 flex h-6 w-6 items-center justify-center rounded-full bg-emerald-500 shadow-lg">
            <Check className="h-4 w-4 text-white" strokeWidth={3} />
          </div>
        )}
        {month.verified && (
          <BadgeCheck
            className="absolute left-2 top-2 h-5 w-5 text-brand-300 drop-shadow-[0_1px_2px_rgba(0,0,0,0.9)]"
            aria-label={t("Verified by a template")}
          />
        )}
        {sdChip}
      </div>

      <div className="flex items-center justify-between gap-2 px-3 py-2.5">
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-zinc-100">{label}</div>
          <div className="mt-0.5">
            <Badge tone={!tracked ? "zinc" : state === "complete" ? "green" : state === "partial" ? "amber" : "zinc"}>
              {tracked
                ? tf("{owned}/{total} owned", { owned, total: month.officialTotal ?? 0 })
                : tp("{n} rewards", owned)}
            </Badge>
          </div>
        </div>
        {tracked && (
          <ProgressRing value={pct} className={ringColor[state]}>
            {Math.round(pct * 100)}%
          </ProgressRing>
        )}
      </div>
    </motion.button>
  );
}

// memo: only the changed month re-renders (the store keeps the others the same object)
export const MonthCard = memo(MonthCardBase);
