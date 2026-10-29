import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AnimatePresence } from "framer-motion";
import { ChevronLeft, Heart, Loader2, PlayCircle, Play } from "lucide-react";
import { Layout } from "@/components/Layout";
import { Cover } from "@/components/Cover";
import { TileGate } from "@/components/TileGate";
import { ImageViewer, type ViewerItem } from "@/components/ImageViewer";
import { Button } from "@/components/ui/Button";
import { useData } from "@/store";
import { useUpNavigate } from "@/lib/nav";
import { useDialogTheme } from "@/lib/dialogTheme";
import { useCardSize } from "@/lib/useCardSize";
import { useSfwMode, tagsAreNsfw } from "@/lib/contentMode";
import { useShowHidden } from "@/lib/showHidden";
import { useGraveyardMode } from "@/lib/graveyard";
import { cn } from "@/lib/utils";
import { useT, useTp } from "@/lib/i18n";
import { favoriteImages, type FavoriteImage } from "@/api/library";
import type { Artist } from "@/types";

/**
 * All favourites: every file in Favourites (the heart in the viewer) from every creator
 * on one page, grouped by creator. Opens from the heart list on the start page. The
 * viewer pages through all of them, not just one creator's.
 */

interface Fav {
  artist: Artist;
  monthId: string;
  image: FavoriteImage["image"];
}

/** In the browser there's no backend: the favourites the loaded library knows. */
function storeFavorites(artists: Artist[]): FavoriteImage[] {
  const out: FavoriteImage[] = [];
  const seen = new Set<string>();
  for (const a of artists)
    for (const p of a.platforms)
      for (const m of p.months)
        for (const r of m.rewards)
          for (const im of r.images)
            if (im.favorite && !r.collabFrom && !seen.has(im.path || im.id)) {
              seen.add(im.path || im.id);
              out.push({ artistId: a.id, rewardId: r.id, image: im });
            }
  return out;
}

export function FavoritesPage({ onLock }: { onLock?: () => void }) {
  const t = useT();
  const tp = useTp();
  const { artists, backed } = useData();
  const navigate = useNavigate();
  const upNavigate = useUpNavigate();
  const dlg = useDialogTheme();
  const sfw = useSfwMode();
  const showHidden = useShowHidden();
  const graveyard = useGraveyardMode();
  const tiles = useCardSize("micoll.favoriteSize", 170, 110, 320);

  const [rows, setRows] = useState<FavoriteImage[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [viewer, setViewer] = useState<number | null>(null);

  const load = useCallback(() => {
    if (!backed) return;
    favoriteImages()
      .then((r) => {
        setRows(r);
        setError(null);
      })
      .catch((e) => setError(String(e)));
  }, [backed]);
  useEffect(load, [load]);
  const fromStore = useMemo(() => (backed ? null : storeFavorites(artists)), [backed, artists]);
  const all = backed ? rows : fromStore;

  /* the creators' own order: platforms, months and rewards as on their page. Same
     creators as the start page (SFW, hidden, graveyard). */
  const groups = useMemo(() => {
    if (!all) return null;
    const place = new Map<string, { artist: Artist; monthId: string; rank: number }>();
    for (const a of artists) {
      if ((sfw && tagsAreNsfw(a.tags)) || (!showHidden && a.hidden) || !!a.graveyard !== graveyard) continue;
      let rank = 0;
      for (const p of a.platforms)
        for (const m of p.months)
          for (const r of m.rewards) place.set(r.id, { artist: a, monthId: m.id, rank: rank++ });
    }
    const by = new Map<string, { artist: Artist; items: (Fav & { rank: number })[] }>();
    for (const f of all) {
      const at = place.get(f.rewardId);
      if (!at || at.artist.id !== f.artistId) continue;
      const g = by.get(at.artist.id) ?? { artist: at.artist, items: [] };
      g.items.push({ artist: at.artist, monthId: at.monthId, image: f.image, rank: at.rank });
      by.set(at.artist.id, g);
    }
    // stable sort: inside a reward the backend's folder order stays
    for (const g of by.values()) g.items.sort((x, y) => x.rank - y.rank);
    return [...by.values()].sort((a, b) => a.artist.name.localeCompare(b.artist.name));
  }, [all, artists, sfw, showHidden, graveyard]);

  const flat = useMemo(() => groups?.flatMap((g) => g.items) ?? [], [groups]);
  const start = new Map(flat.map((f, i) => [f, i]));

  const items = useMemo<ViewerItem[]>(
    () =>
      flat.map(({ artist, image: im }) => {
        const file = im.name ? im.name.split(/[\\/]/).pop() || im.name : "";
        return {
          id: im.id,
          title: file ? `${artist.name} — ${file}` : artist.name,
          src: im.src,
          path: im.path,
          displayPath: im.displayPath,
          versionCount: im.versionCount,
          onOriginal: im.onOriginal,
          name: file || undefined,
          kind: im.kind,
          favorite: im.favorite,
          favWallpaper: im.favWallpaper,
          collections: im.collections,
        };
      }),
    [flat],
  );

  const summary =
    flat.length === 0
      ? t("No favourites yet")
      : `${tp("{n} favourites", flat.length)} · ${tp("{n} creators", groups?.length ?? 0)}`;

  return (
    <Layout
      onLock={onLock}
      titleSlot={<span className="font-medium text-zinc-100">{t("All favourites")}</span>}
      toolbar={
        <div className="mx-auto flex w-full max-w-6xl items-center gap-3 px-6 pb-4 pt-6">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => upNavigate("/", () => true)}
            className="gap-1.5"
          >
            <ChevronLeft className="h-4 w-4" />
            {t("Back")}
          </Button>
          <div className="text-sm text-white">{groups ? summary : ""}</div>
          {flat.length > 0 && (
            <Button size="sm" className="ml-auto" onClick={() => setViewer(0)}>
              <Play className="mr-1.5 h-4 w-4" />
              {t("View all")}
            </Button>
          )}
        </div>
      }
    >
      <div ref={tiles.ref} className="mx-auto w-full max-w-6xl px-6 pb-16">
        {error ? (
          <p className="mt-10 text-center text-sm text-rose-300">{error}</p>
        ) : !groups ? (
          <div className="mt-16 grid place-items-center">
            <Loader2 className="h-5 w-5 animate-spin text-zinc-500" />
          </div>
        ) : flat.length === 0 ? (
          <div
            className={cn(
              "mt-10 flex flex-col items-center gap-3 px-6 py-14 text-center text-white",
              dlg.box,
            )}
          >
            <Heart className="h-8 w-8 text-white" />
            <p className="max-w-md text-sm">
              {t("No favourites yet. Mark pictures with the heart in the viewer.")}
            </p>
          </div>
        ) : (
          groups.map((g) => (
            <section key={g.artist.id} className="mb-9">
              <button
                onClick={() => navigate(`/artist/${g.artist.id}`)}
                className="mb-3 text-left text-sm font-semibold text-zinc-200 transition-colors hover:text-brand-300"
              >
                {g.artist.name}
                <span className="ml-2 font-normal text-zinc-500">{g.items.length}</span>
              </button>
              <div
                className="grid gap-3"
                // fixed tracks, Ctrl+wheel resizes them (like the reward grid)
                style={{ gridTemplateColumns: `repeat(auto-fill, ${tiles.size}px)` }}
              >
                {g.items.map((f) => (
                  <TileGate key={f.image.path || f.image.id} className="relative">
                    <button
                      type="button"
                      onClick={() => setViewer(start.get(f) ?? 0)}
                      title={f.image.name?.split(/[\\/]/).pop()}
                      className={cn(
                        "group relative block aspect-square w-full overflow-hidden outline-none focus-visible:ring-2 focus-visible:ring-brand-500",
                        dlg.box,
                      )}
                    >
                      <div className="h-full w-full transition-transform duration-500 group-hover:scale-105">
                        <Cover
                          path={f.image.displayPath || f.image.path}
                          seed={f.image.name || f.artist.name}
                          size={400}
                          rounded="rounded-none"
                        />
                      </div>
                      {f.image.kind === "video" && (
                        <span className="pointer-events-none absolute inset-0 grid place-items-center">
                          <PlayCircle className="h-10 w-10 text-white/85 drop-shadow-[0_2px_6px_rgba(0,0,0,0.8)]" />
                        </span>
                      )}
                    </button>
                  </TileGate>
                ))}
              </div>
            </section>
          ))
        )}
      </div>

      <AnimatePresence>
        {viewer != null && items.length > 0 && (
          <ImageViewer
            items={items}
            startIndex={Math.min(viewer, items.length - 1)}
            onGoToFolder={(it) => {
              const f = flat.find((x) => x.image.path === it.path);
              if (!f) return;
              setViewer(null);
              navigate(`/artist/${f.artist.id}/month/${f.monthId}`);
            }}
            onClose={() => {
              setViewer(null);
              // hearts taken off in the viewer leave the page
              load();
            }}
          />
        )}
      </AnimatePresence>
    </Layout>
  );
}
