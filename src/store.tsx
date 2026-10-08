import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { artists as mockArtists } from "@/data/mock";
import { isTauri } from "@/lib/tauri";
import { splashReady } from "@/lib/splash";
import * as api from "@/api/library";
import type { Artist, Month, Reward } from "@/types";

/**
 * App data store. In Tauri it loads the library from SQLite, in the browser it uses mock
 * data.
 */
interface LibraryData {
  artists: Artist[];
  loading: boolean;
  error: string | null;
  findArtist: (id: string) => Artist | undefined;
}

/**
 * The part of the store that never changes (flag + functions).
 * Separate context so cards that only need these don't re-render on every change.
 * Use useLibraryActions().
 */
export interface LibraryActions {
  backed: boolean; // true when running against the real backend
  refresh: () => Promise<void>;
  /**
   * Keep an artist's images loaded while something shows them, call the returned
   * function when done. Pages use useArtistImages.
   */
  holdArtistImages: (artistId: string) => () => void;
  /**
   * Are this artist's images loaded yet?
   * The library loads without images first, so counts can be 0 for a moment.
   */
  imagesLoaded: (artistId: string) => boolean;
  toggleReward: (monthId: string, rewardId: string) => void;
  /** Set/clear an artist's class (in memory first so the card animates, then saved). */
  setArtistClass: (artistId: string, tag: string | null) => void;
  /** Hide or unhide a creator (in memory first, then saved). */
  setArtistHidden: (artistId: string, hidden: boolean) => void;
  /**
   * Move a creator into the graveyard or back (in memory first).
   * In a managed collection the folder moves too, so the library reloads after.
   * Rejects if the move failed (e.g. folder already exists).
   */
  setArtistGraveyard: (artistId: string, on: boolean) => Promise<void>;
  /** Remove a reward's "new" badge the first time its viewer opens. */
  markRewardSeen: (rewardId: string) => void;
}

type DataCtx = LibraryData & LibraryActions;

const DataContext = createContext<LibraryData | null>(null);
const ActionsContext = createContext<LibraryActions | null>(null);

/** Like arr.map(fn), but returns arr itself if nothing changed. */
function mapShared<T>(arr: T[], fn: (x: T) => T): T[] {
  let out: T[] | null = null;
  for (let i = 0; i < arr.length; i++) {
    const next = fn(arr[i]);
    if (next !== arr[i]) (out ??= arr.slice())[i] = next;
  }
  return out ?? arr;
}

/**
 * Apply fn to every reward, only rebuild objects that changed so memo can skip the rest.
 * Returns artists as is if nothing changed.
 */
function mapRewards(
  artists: Artist[],
  fn: (r: Reward, m: Month) => Reward,
  onlyArtist?: string,
): Artist[] {
  return mapShared(artists, (a) => {
    if (onlyArtist !== undefined && a.id !== onlyArtist) return a;
    const platforms = mapShared(a.platforms, (p) => {
      const months = mapShared(p.months, (m) => {
        const rewards = mapShared(m.rewards, (r) => fn(r, m));
        return rewards === m.rewards ? m : { ...m, rewards };
      });
      return months === p.months ? p : { ...p, months };
    });
    return platforms === a.platforms ? a : { ...a, platforms };
  });
}

const nextStatus = (s: Reward["status"]): Reward["status"] =>
  s === "owned" ? "missing" : "owned";

export function DataProvider({ children }: { children: React.ReactNode }) {
  const backed = isTauri();
  const [artists, setArtists] = useState<Artist[]>(backed ? [] : mockArtists);
  const [loading, setLoading] = useState<boolean>(backed);
  const [error, setError] = useState<string | null>(null);

  // full screen spinner only on the first load, later refreshes swap the data in place
  const loadedRef = useRef(false);
  // artist ids whose images were requested (set before the request)
  const hydratedRef = useRef<Set<string>>(new Set());
  // artists whose page is open right now, counted (pages overlap for a moment, StrictMode
  // mounts twice)
  const openRef = useRef<Map<string, number>>(new Map());
  // artist ids whose images actually arrived
  const mergedRef = useRef<Set<string>>(new Set());
  // latest loadArtistImages, so refresh can use it without a dependency cycle
  const loadImagesRef = useRef<(artistId: string) => void>(() => {});

  const refresh = useCallback(async () => {
    if (!backed) {
      setArtists(mockArtists);
      splashReady("library");
      return;
    }
    if (!loadedRef.current) setLoading(true);
    setError(null);
    try {
      setArtists(await api.getLibrary());
      loadedRef.current = true;
      // the new library has no images, reload them only for open pages
      hydratedRef.current.clear();
      mergedRef.current.clear();
      for (const id of openRef.current.keys()) loadImagesRef.current(id);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
      // the splash can go in any case, also on error (App still has to be ready)
      splashReady("library");
    }
  }, [backed]);

  const loadArtistImages = useCallback(
    async (artistId: string) => {
      if (!backed || hydratedRef.current.has(artistId)) return;
      hydratedRef.current.add(artistId); // mark first so concurrent callers dedupe
      try {
        const byReward = await api.artistImages(artistId);
        setArtists((prev) =>
          mapRewards(
            prev,
            (r) => {
              const imgs = byReward.get(r.id);
              return imgs ? { ...r, images: imgs } : r;
            },
            artistId,
          ),
        );
        mergedRef.current.add(artistId);
      } catch {
        hydratedRef.current.delete(artistId); // allow a retry
      }
    },
    [backed],
  );
  useEffect(() => {
    loadImagesRef.current = loadArtistImages;
  }, [loadArtistImages]);

  const holdArtistImages = useCallback(
    (artistId: string) => {
      const open = openRef.current;
      open.set(artistId, (open.get(artistId) ?? 0) + 1);
      void loadArtistImages(artistId);
      return () => {
        const n = (open.get(artistId) ?? 1) - 1;
        if (n > 0) open.set(artistId, n);
        else open.delete(artistId);
      };
    },
    [loadArtistImages],
  );

  // a ref is fine, setArtists already causes a render
  const imagesLoaded = useCallback(
    (artistId: string) => !backed || mergedRef.current.has(artistId),
    [backed],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const toggleReward = useCallback(
    (monthId: string, rewardId: string) => {
      let newStatus: Reward["status"] = "owned";
      setArtists((prev) =>
        mapRewards(prev, (r, m) => {
          if (m.id !== monthId || r.id !== rewardId) return r;
          newStatus = nextStatus(r.status);
          return { ...r, status: newStatus };
        }),
      );
      if (backed) void api.setRewardStatus(rewardId, newStatus).catch(() => void refresh());
    },
    [backed, refresh],
  );

  const markRewardSeen = useCallback(
    (rewardId: string) => {
      // update in place, refresh fixes it if the save fails
      setArtists((prev) =>
        mapRewards(prev, (r) => (r.id === rewardId && r.fresh ? { ...r, fresh: false } : r)),
      );
      if (backed) void api.markRewardSeen(rewardId).catch(() => void refresh());
    },
    [backed, refresh],
  );

  const setArtistClass = useCallback(
    (artistId: string, tag: string | null) => {
      // update in place so the card animates to its new spot
      setArtists((prev) => prev.map((a) => (a.id === artistId ? { ...a, tag } : a)));
      if (backed) void api.setArtistTag(artistId, tag).catch(() => void refresh());
    },
    [backed, refresh],
  );

  const setArtistHidden = useCallback(
    (artistId: string, hidden: boolean) => {
      setArtists((prev) => prev.map((a) => (a.id === artistId ? { ...a, hidden } : a)));
      if (backed) void api.setArtistHidden(artistId, hidden).catch(() => void refresh());
    },
    [backed, refresh],
  );

  const setArtistGraveyard = useCallback(
    async (artistId: string, on: boolean) => {
      setArtists((prev) => prev.map((a) => (a.id === artistId ? { ...a, graveyard: on } : a)));
      if (!backed) return;
      try {
        await api.setArtistGraveyard(artistId, on);
      } finally {
        await refresh();
      }
    },
    [backed, refresh],
  );

  const data = useMemo<LibraryData>(
    () => ({
      artists,
      loading,
      error,
      findArtist: (id) => artists.find((a) => a.id === id),
    }),
    [artists, loading, error],
  );
  // everything in here is stable, so this object is built once
  const actions = useMemo<LibraryActions>(
    () => ({
      backed,
      refresh,
      holdArtistImages,
      imagesLoaded,
      toggleReward,
      setArtistClass,
      setArtistHidden,
      setArtistGraveyard,
      markRewardSeen,
    }),
    [
      backed,
      refresh,
      holdArtistImages,
      imagesLoaded,
      toggleReward,
      setArtistClass,
      setArtistHidden,
      setArtistGraveyard,
      markRewardSeen,
    ],
  );

  return (
    <ActionsContext.Provider value={actions}>
      <DataContext.Provider value={data}>{children}</DataContext.Provider>
    </ActionsContext.Provider>
  );
}

/**
 * The library and all functions to change it. Re-renders on every data change,
 * use useLibraryActions if you only need the functions.
 */
export function useData(): DataCtx {
  const data = useContext(DataContext);
  const actions = useContext(ActionsContext);
  if (!data || !actions) throw new Error("useData must be used within DataProvider");
  return useMemo(() => ({ ...data, ...actions }), [data, actions]);
}

/**
 * Load this artist's images and keep them while the page is mounted.
 * Does nothing in the browser (mock data has images).
 */
export function useArtistImages(artistId: string | undefined) {
  const { holdArtistImages } = useLibraryActions();
  useEffect(() => {
    if (artistId) return holdArtistImages(artistId);
  }, [artistId, holdArtistImages]);
}

/** Only the stable part, never causes a render. */
export function useLibraryActions(): LibraryActions {
  const actions = useContext(ActionsContext);
  if (!actions) throw new Error("useLibraryActions must be used within DataProvider");
  return actions;
}
