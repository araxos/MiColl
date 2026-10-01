import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { useNavigate } from "react-router-dom";
import { AlertTriangle, X, BellOff, Images, Loader2, MapPin, Tags } from "lucide-react";
import { ThemedSelect, type SelectOption } from "@/components/ThemedSelect";
import { useDialogTheme } from "@/lib/dialogTheme";
import { useData } from "@/store";
import { setPeriodPlatform } from "@/api/library";
import { NEEDS_REVIEW_DISMISSED, WARNINGS_RESET_EVENT } from "@/lib/warnings";
import { PLATFORMS } from "@/lib/platforms";
import { useAccent } from "@/lib/theme";
import { cn } from "@/lib/utils";
import { useT, useTf, useTp } from "@/lib/i18n";
import { type Artist, type Month, ownRewards } from "@/types";

interface ReviewItem {
  artist: Artist;
  month: Month;
}

/** All periods that have no platform yet. */
function collect(artists: Artist[]): ReviewItem[] {
  const out: ReviewItem[] = [];
  for (const a of artists) {
    for (const p of a.platforms) {
      for (const m of p.months) {
        if (m.needsReview) out.push({ artist: a, month: m });
      }
    }
  }
  return out;
}

// hidden for this session only (module variable, comes back after a restart)
let sessionDismissed = false;

/** Hidden for good? Saved, reset by Settings -> Reset warnings (key in lib/warnings.ts). */
function silencedForGood(): boolean {
  try {
    return localStorage.getItem(NEEDS_REVIEW_DISMISSED) === "1";
  } catch {
    return false;
  }
}

/**
 * Home banner for periods with unknown platform, plus a dialog to fix them.
 * Picking a platform saves it (set_period_platform).
 * X hides it for this session, the bell hides it until warnings are reset.
 */
export function NeedsReviewBanner() {
  const t = useT();
  const tf = useTf();
  const tp = useTp();
  const { artists, refresh, backed } = useData();
  const [open, setOpen] = useState(false);
  const [dismissed, setDismissed] = useState(() => sessionDismissed || silencedForGood());
  const items = useMemo(() => collect(artists), [artists]);
  // Reset warnings must show the banner right away (also clear the session flag)
  useEffect(() => {
    const back = () => {
      sessionDismissed = false;
      setDismissed(false);
    };
    window.addEventListener(WARNINGS_RESET_EVENT, back);
    return () => window.removeEventListener(WARNINGS_RESET_EVENT, back);
  }, []);
  // frosted glass on iridescent so it stays readable
  const irid = useAccent() === "iridescent";

  if (!backed || items.length === 0 || dismissed) return null;

  const dismiss = () => {
    sessionDismissed = true;
    setDismissed(true);
  };

  const silence = () => {
    try {
      localStorage.setItem(NEEDS_REVIEW_DISMISSED, "1");
    } catch {
      // private mode / storage full: hide it for the session
    }
    dismiss();
  };

  return (
    <>
      <div
        className={cn(
          "mb-5 flex w-full items-stretch overflow-hidden rounded-xl border transition-colors",
          irid
            ? "border-amber-400/50 bg-zinc-900/40 backdrop-blur-xl"
            : "border-amber-500/40 bg-amber-500/10",
        )}
      >
        {/* square hover, so it meets the square X button (the banner rounds the outer
            corners) */}
        <button
          onClick={() => setOpen(true)}
          className={cn(
            "flex min-w-0 flex-1 items-center gap-3 px-4 py-3 text-left transition-colors",
            irid ? "hover:bg-zinc-900/40" : "hover:bg-amber-500/10",
          )}
        >
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-amber-500/20 text-amber-300">
            <AlertTriangle className="h-4 w-4" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium text-amber-200">
              {tf("{n} need a platform", { n: tp("{n} periods", items.length) })}
            </span>
            <span className="block truncate text-xs text-amber-200/70">
              {t("MiColl couldn’t tell which platform these came from — click to assign them.")}
            </span>
          </span>
          <span className="shrink-0 rounded-lg bg-amber-500/20 px-2.5 py-1 text-xs font-medium text-amber-200">
            {t("Review")}
          </span>
        </button>
        <button
          onClick={dismiss}
          title={t("Dismiss until next app start")}
          aria-label={t("Dismiss")}
          className="flex shrink-0 items-center justify-center self-stretch px-5 text-amber-200/70 transition-colors hover:bg-amber-500/20 hover:text-amber-100"
        >
          <X className="h-4 w-4" />
        </button>
        <button
          onClick={silence}
          title={t("Dismiss and don’t ask again — bring it back with Settings → Reset warnings")}
          aria-label={t("Dismiss and don’t ask again")}
          className={cn(
            "flex shrink-0 items-center justify-center self-stretch border-l px-5 text-amber-200/70 transition-colors hover:bg-amber-500/20 hover:text-amber-100",
            irid ? "border-amber-400/30" : "border-amber-500/25",
          )}
        >
          <BellOff className="h-4 w-4" />
        </button>
      </div>

      {open && <ReviewModal items={items} onClose={() => setOpen(false)} onPick={refresh} />}
    </>
  );
}

function ReviewModal({
  items,
  onClose,
  onPick,
}: {
  items: ReviewItem[];
  onClose: () => void;
  onPick: () => Promise<void>;
}) {
  const t = useT();
  const tf = useTf();
  const tp = useTp();
  const [busy, setBusy] = useState<string | null>(null);
  const navigate = useNavigate();
  const accent = useAccent();
  const dlg = useDialogTheme();

  // open the artist page on the Unsorted tab
  const locate = (artist: Artist) => {
    onClose();
    navigate(`/artist/${artist.id}?platform=${encodeURIComponent("Unsorted")}`);
  };

  const assign = async (month: Month, platform: string) => {
    setBusy(month.id);
    try {
      await setPeriodPlatform(month.id, platform);
      await onPick();
    } finally {
      setBusy(null);
    }
  };

  // Escape closes (the themed dropdown swallows its own Escape first)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const options: SelectOption[] = [
    { value: "", label: t("Choose platform…"), muted: true },
    ...PLATFORMS.map((p) => ({ value: p, label: p })),
  ];

  // header badge: the theme's own accent fill, dark ink on the light premium fills
  const badgeInk = accent === "iridescent" || accent === "cyberpunk" ? "text-zinc-950" : "text-white";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <motion.div
        initial={{ opacity: 0, y: 12, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal
        className={cn("flex max-h-[88vh] w-[40rem] max-w-full flex-col overflow-hidden", dlg.panel)}
      >
        <div className={cn("flex items-center gap-3 border-b px-5 py-4", dlg.divider)}>
          <span
            className={cn(
              "flex h-9 w-9 shrink-0 items-center justify-center",
              accent === "cyberpunk" ? "rounded-none" : "rounded-xl",
              dlg.accent,
              badgeInk,
              accent === "cyberpunk" && "shadow-[0_0_14px_rgba(252,238,10,0.35)]",
              accent === "iridescent" && "shadow-[0_0_16px_rgba(196,181,253,0.4)]",
              accent === "sakura" && "shadow-[0_0_14px_rgba(236,72,153,0.35)]",
            )}
          >
            <Tags className="h-4 w-4" />
          </span>
          <div className="min-w-0 flex-1">
            {accent === "cyberpunk" && (
              <div className="font-mono text-[10px] uppercase tracking-widest text-[#00e5ff]/80">
                {"// unsorted"}
              </div>
            )}
            <h2 className="text-base font-semibold text-zinc-100">{t("Assign platforms")}</h2>
            <p className="text-xs text-zinc-300">
              {tf("{n} need a platform", { n: tp("{n} periods", items.length) })}
            </p>
          </div>
          <button
            onClick={onClose}
            title={t("Close")}
            aria-label={t("Close")}
            className={cn("flex h-8 w-8 shrink-0 items-center justify-center", dlg.control)}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 space-y-2 overflow-y-auto px-5 py-4">
          {items.length === 0 ? (
            <p className="py-8 text-center text-sm text-zinc-300">{t("All periods are assigned. 🎉")}</p>
          ) : (
            <AnimatePresence initial={false}>
              {items.map(({ artist, month }) => (
                // an assigned row slides out instead of vanishing
                <motion.div
                  key={month.id}
                  layout
                  exit={{ opacity: 0, x: 24, transition: { duration: 0.22 } }}
                  className={cn("flex items-center gap-3 px-3 py-2.5", dlg.box)}
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-zinc-100">{artist.name}</div>
                    <div className="flex items-center gap-2 text-xs text-zinc-400">
                      <span>{month.label}</span>
                      <span className="inline-flex items-center gap-1">
                        <Images className="h-3 w-3" />
                        {ownRewards(month).length}
                      </span>
                    </div>
                  </div>
                  <button
                    onClick={() => locate(artist)}
                    title={t("Locate in MiColl — open these files to review them")}
                    className={cn("inline-flex h-8 items-center gap-1.5 px-2.5 text-xs", dlg.control)}
                  >
                    <MapPin className={cn("h-3.5 w-3.5", dlg.accentText)} />
                    {t("Locate")}
                  </button>
                  {busy === month.id ? (
                    <span className="flex h-8 min-w-[9.5rem] items-center justify-center">
                      <Loader2 className={cn("h-4 w-4 animate-spin", dlg.accentText)} />
                    </span>
                  ) : (
                    <ThemedSelect
                      value=""
                      options={options}
                      onChange={(v) => v && void assign(month, v)}
                      className={cn("h-8 min-w-[9.5rem] px-2.5 text-xs", dlg.field)}
                      ink="text-zinc-100"
                    />
                  )}
                </motion.div>
              ))}
            </AnimatePresence>
          )}
        </div>
      </motion.div>
    </div>
  );
}
