import { useCallback, useEffect, useRef } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import * as api from "@/api/library";
import { useData } from "@/store";
import { IMPORTED_ARTISTS_EVENT, useActions } from "@/actions";
import { isTauri } from "@/lib/tauri";
import { useT, useTf, useTp } from "@/lib/i18n";

/** Settings sends this when the inbox folder was set, so it's looked at right away. */
export const INBOX_CHANGED_EVENT = "micoll:inbox-changed";

/**
 * The inbox folder (Settings → Library → Inbox). At start, whenever the window comes to
 * the front and after an import from it, MiColl looks in it and offers what's new
 * ("2 new downloads in your inbox"). One at a time: the import opens for the oldest, the
 * rest is offered again once that one is done. No watcher in the background.
 */
export function InboxWatcher({ active }: { active: boolean }) {
  const t = useT();
  const tf = useTf();
  const tp = useTp();
  const { backed } = useData();
  const { importDropped, showToast, dismissToast } = useActions();
  // offered this session: closing the note means "not now" until MiColl starts again
  const offered = useRef(new Set<string>());
  // an import from the inbox ran: offer the rest right away, even if offered before
  const next = useRef(false);
  const toast = useRef<number | null>(null);
  const looking = useRef(false);

  const look = useCallback(async () => {
    if (!active || !backed || !isTauri() || looking.current) return;
    looking.current = true;
    try {
      const items = await api.inboxScan().catch(() => [] as api.InboxItem[]);
      const fresh = next.current ? items : items.filter((i) => !offered.current.has(i.key));
      next.current = false;
      if (!fresh.length) return;
      for (const i of items) offered.current.add(i.key);
      if (toast.current != null) dismissToast(toast.current);
      const first = items[0];
      toast.current = showToast({
        tone: "success",
        title: tp("{n} new downloads in your inbox", items.length),
        detail: items.slice(0, 3).map((i) => i.name).join(" · ") + (items.length > 3 ? " …" : ""),
        duration: 30_000,
        action: {
          label: items.length > 1 ? tf("Import “{name}”", { name: first.name }) : t("Import"),
          onClick: () => {
            toast.current = null;
            void (async () => {
              // remembered first: an import in place leaves it in the folder
              await api.inboxMarkSeen([first.key]).catch(() => {});
              next.current = items.length > 1;
              await importDropped([first.path]);
            })();
          },
        },
      });
    } finally {
      looking.current = false;
    }
  }, [active, backed, dismissToast, importDropped, showToast, t, tf, tp]);

  // at start (a moment after the library shows) and when the inbox was just set
  useEffect(() => {
    if (!active || !backed) return;
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

  // an inbox import finished: offer the next one
  useEffect(() => {
    const done = () => {
      if (next.current) void look();
    };
    window.addEventListener(IMPORTED_ARTISTS_EVENT, done);
    return () => window.removeEventListener(IMPORTED_ARTISTS_EVENT, done);
  }, [look]);

  return null;
}
