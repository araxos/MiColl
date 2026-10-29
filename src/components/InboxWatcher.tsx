import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import * as api from "@/api/library";
import { useData } from "@/store";
import { IMPORTED_ARTISTS_EVENT, useActions } from "@/actions";
import { isTauri } from "@/lib/tauri";
import { useT, useTp } from "@/lib/i18n";

/** Settings sends this when the inbox folder was set, so it's looked at right away. */
export const INBOX_CHANGED_EVENT = "micoll:inbox-changed";
/** The inbox button in the top bar: import what's in the inbox, one after the other. */
const INBOX_START_EVENT = "micoll:inbox-start";

/* Shared with the top bar and the import review:
   - count: what's in the inbox now (the badge on the inbox button)
   - waiting: inbox downloads still to come after the review that's open ("+n")
   - reviews: import reviews open right now (any import, not only the inbox's) */
const state = { count: 0, waiting: 0, reviews: 0 };
const listeners = new Set<() => void>();
function set(patch: Partial<typeof state>) {
  Object.assign(state, patch);
  listeners.forEach((l) => l());
}
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};
export const useInboxCount = () => useSyncExternalStore(subscribe, () => state.count);
export const useInboxWaiting = () => useSyncExternalStore(subscribe, () => state.waiting);
export const startInboxImports = () => window.dispatchEvent(new Event(INBOX_START_EVENT));

/** A review closed (debounced: React's dev mode mounts effects twice). */
let closeTimer: number | undefined;
let onReviewClosed: () => void = () => {};
/** The import review calls this when it opens, and the returned function when it closes. */
export function noteImportReview(): () => void {
  window.clearTimeout(closeTimer);
  set({ reviews: state.reviews + 1 });
  return () => {
    set({ reviews: Math.max(0, state.reviews - 1) });
    window.clearTimeout(closeTimer);
    closeTimer = window.setTimeout(() => {
      if (state.reviews === 0) onReviewClosed();
    }, 120);
  };
}

/**
 * The inbox folder (Settings → Library → Inbox). MiColl looks in it at start, when the
 * window comes to the front and after an import, and keeps the top bar's inbox button
 * up to date. A note comes at start and when something new turned up, not again for
 * what was offered before. "Import" (or the button) goes through all of it: one review
 * after the other, until one is cancelled. No watcher in the background.
 */
export function InboxWatcher({ active }: { active: boolean }) {
  const t = useT();
  const tp = useTp();
  const { backed } = useData();
  const { importDropped, showToast, dismissToast } = useActions();
  // offered this session: a note only for what wasn't offered yet (a restart offers all)
  const offered = useRef(new Set<string>());
  const toast = useRef<number | null>(null);
  const looking = useRef(false);
  // the run through the inbox: what's left, the one in the review, did it get imported
  const queue = useRef<api.InboxItem[]>([]);
  const current = useRef<api.InboxItem | null>(null);
  const imported = useRef(false);
  const running = () => current.current !== null;

  const scan = useCallback(async () => {
    const items = await api.inboxScan().catch(() => [] as api.InboxItem[]);
    set({ count: items.length });
    return items;
  }, []);

  const finish = useCallback(() => {
    queue.current = [];
    current.current = null;
    set({ waiting: 0 });
    void scan();
  }, [scan]);

  // the next one of the run, or the end of it
  const next = useCallback(async () => {
    void scan();
    const item = queue.current.shift();
    if (!item) return finish();
    current.current = item;
    imported.current = false;
    set({ waiting: queue.current.length });
    await importDropped([item.path]);
    // The review takes over once it's open (see onReviewClosed). Before it there may be
    // the "files are moved" notice and the analysis. If none comes up at all (nothing
    // to import, an error), the run ends; the download stays in the inbox.
    const since = Date.now();
    const watch = window.setInterval(() => {
      if (current.current !== item || state.reviews > 0 || imported.current) return window.clearInterval(watch);
      if (Date.now() - since > 20_000) {
        window.clearInterval(watch);
        finish();
      }
    }, 500);
  }, [finish, importDropped, scan]);

  const start = useCallback(
    async (items?: api.InboxItem[]) => {
      if (running() || state.reviews > 0) return;
      if (toast.current != null) dismissToast(toast.current);
      toast.current = null;
      const list = items ?? (await scan());
      if (!list.length) return;
      queue.current = [...list];
      await next();
    },
    [dismissToast, next, scan],
  );

  const look = useCallback(async () => {
    if (!active || !backed || !isTauri() || looking.current) return;
    looking.current = true;
    try {
      const items = await scan();
      // while it runs through the inbox, the reviews are the note
      if (running() || state.reviews > 0) return;
      const fresh = items.filter((i) => !offered.current.has(i.key));
      if (!fresh.length) return;
      for (const i of items) offered.current.add(i.key);
      if (toast.current != null) dismissToast(toast.current);
      toast.current = showToast({
        tone: "success",
        title: tp("{n} new downloads in your inbox", items.length),
        detail: items.slice(0, 3).map((i) => i.name).join(" · ") + (items.length > 3 ? " …" : ""),
        duration: 30_000,
        action: {
          label: t("Import"),
          onClick: () => {
            toast.current = null;
            void start(items);
          },
        },
      });
    } finally {
      looking.current = false;
    }
  }, [active, backed, dismissToast, scan, showToast, start, t, tp]);

  // at start (a moment after the library shows) and when the inbox was just set
  useEffect(() => {
    if (!active || !backed) {
      set({ count: 0 });
      return;
    }
    const id = window.setTimeout(() => void look(), 1500);
    const now = () => void look();
    window.addEventListener(INBOX_CHANGED_EVENT, now);
    return () => {
      window.clearTimeout(id);
      window.removeEventListener(INBOX_CHANGED_EVENT, now);
    };
  }, [active, backed, look]);

  // the window comes to the front (back from the browser the download came from)
  useEffect(() => {
    if (!active || !isTauri()) return;
    let unlisten: (() => void) | undefined;
    let alive = true;
    getCurrentWindow()
      .onFocusChanged(({ payload: focused }) => {
        if (focused) void look();
      })
      .then((fn) => {
        if (alive) unlisten = fn;
        else fn();
      })
      .catch(() => {});
    return () => {
      alive = false;
      unlisten?.();
    };
  }, [active, look]);

  // the inbox button in the top bar
  useEffect(() => {
    const go = () => void start();
    window.addEventListener(INBOX_START_EVENT, go);
    return () => window.removeEventListener(INBOX_START_EVENT, go);
  }, [start]);

  // the run: imported -> remember it, next one. Cancelled -> stop (it stays in the inbox).
  useEffect(() => {
    const done = () => {
      if (running()) imported.current = true;
    };
    window.addEventListener(IMPORTED_ARTISTS_EVENT, done);
    onReviewClosed = () => {
      const item = current.current;
      if (!item) return void scan();
      if (!imported.current) return finish();
      // remembered: an import in place leaves it in the folder
      void api
        .inboxMarkSeen([item.key])
        .catch(() => {})
        .then(() => next());
    };
    return () => {
      window.removeEventListener(IMPORTED_ARTISTS_EVENT, done);
      onReviewClosed = () => {};
    };
  }, [finish, next, scan]);

  return null;
}
