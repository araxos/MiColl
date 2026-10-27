import { useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import { X, Heart, Loader2 } from "lucide-react";
import { Cover } from "@/components/Cover";
import { favoriteCounts, type FavoriteCount } from "@/api/library";
import { useT, useTp } from "@/lib/i18n";
import type { Artist } from "@/types";

/**
 * Right side drawer with every creator that has Favourites (the heart on the start
 * page), most first. Only the "Favourites" collection counts, not Fav. Wallpaper or own
 * collections. Same drawer as RecentPanel.
 */
export function FavoritesPanel({
  artists,
  onPick,
  onClose,
}: {
  /** The creators the start page may show (SFW, hidden, graveyard already applied). */
  artists: Artist[];
  onPick: (id: string) => void;
  onClose: () => void;
}) {
  const t = useT();
  const tp = useTp();
  const [counts, setCounts] = useState<FavoriteCount[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    favoriteCounts()
      .then((c) => alive && setCounts(c))
      .catch((e) => alive && setError(String(e)));
    return () => {
      alive = false;
    };
  }, []);

  const rows = useMemo(() => {
    if (!counts) return [];
    const byId = new Map(artists.map((a) => [a.id, a]));
    return counts
      .flatMap((c) => {
        const a = byId.get(c.artistId);
        return a ? [{ artist: a, count: c.count, preview: c.preview }] : [];
      })
      .sort((x, y) => y.count - x.count || x.artist.name.localeCompare(y.artist.name));
  }, [counts, artists]);

  return (
    <>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        onClick={onClose}
        className="fixed inset-x-0 bottom-0 top-14 z-40 bg-black/30"
      />
      <motion.aside
        initial={{ x: "100%" }}
        animate={{ x: 0 }}
        exit={{ x: "100%" }}
        transition={{ type: "spring", stiffness: 380, damping: 38 }}
        className="fixed bottom-0 right-0 top-14 z-50 flex w-72 flex-col border-l border-brand-500/20 bg-gradient-to-b from-brand-950/85 to-zinc-950/95 shadow-2xl shadow-black/50 backdrop-blur-xl"
      >
        <div className="flex items-center justify-between border-b border-brand-500/20 px-4 py-3">
          <div className="flex items-center gap-2 text-sm font-semibold text-zinc-100">
            <Heart className="h-4 w-4 fill-rose-400 text-rose-400" />
            {t("Favourites")}
          </div>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-200" title={t("Close")}>
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {error ? (
            <p className="p-4 text-center text-xs text-rose-300">{error}</p>
          ) : !counts ? (
            <div className="grid place-items-center p-6">
              <Loader2 className="h-4 w-4 animate-spin text-zinc-500" />
            </div>
          ) : rows.length === 0 ? (
            <p className="p-4 text-center text-xs text-zinc-500">
              {t("No favourites yet. Mark pictures with the heart in the viewer.")}
            </p>
          ) : (
            rows.map(({ artist: a, count, preview }) => (
              <button
                key={a.id}
                onClick={() => onPick(a.id)}
                title={a.name}
                className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left transition-colors hover:bg-brand-500/10"
              >
                <div className="h-11 w-11 shrink-0 overflow-hidden rounded-md">
                  <Cover path={preview ?? a.previewPath} seed={a.name} rounded="rounded-none" />
                </div>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-zinc-200">{a.name}</span>
                  <span className="block text-[11px] text-brand-100/85">{tp("{n} favourites", count)}</span>
                </span>
              </button>
            ))
          )}
        </div>
      </motion.aside>
    </>
  );
}
