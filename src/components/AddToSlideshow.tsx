import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { motion } from "framer-motion";
import { Images, Plus, Search, Wallpaper, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import type { MenuItem } from "@/components/ContextMenu";
import { useActions } from "@/actions";
import { useDialogTheme } from "@/lib/dialogTheme";
import { isTauri, thumbUrl } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import { useT, useTf, useTp } from "@/lib/i18n";
import { addToWallSet, createWallSet, listWallSets, type WallSet } from "@/api/library";

/**
 * "Add to slideshow" in the right-click menus (a picture in the viewer, a whole reward):
 * New slideshow…, the three slideshows that got pictures last, Browse…. The slideshows
 * are the Wallpaper Hub's. The menu is built when it opens, so it reads a cached list;
 * the dialogs live in SlideshowDialogsHost (mounted once in App).
 */

let cache: WallSet[] = [];
const DIALOG_EVENT = "micoll-slideshow-dialog";

/** Read the slideshows again (after a change in the hub or an add). */
export function refreshWallSets(): Promise<void> {
  if (!isTauri()) return Promise.resolve();
  return listWallSets()
    .then((s) => {
      cache = s;
    })
    .catch(() => {});
}

type DialogReq = { mode: "new" | "browse"; paths: string[] };
const openDialog = (req: DialogReq) => window.dispatchEvent(new CustomEvent<DialogReq>(DIALOG_EVENT, { detail: req }));

/** Add, tell the user, keep the list fresh. */
function useAdd() {
  const t = useT();
  const tf = useTf();
  const tp = useTp();
  const { showToast } = useActions();
  return async (set: { id: string; name: string }, paths: string[]) => {
    try {
      const n = await addToWallSet(set.id, paths);
      showToast({
        tone: "success",
        title: tf("Added to {name}", { name: set.name }),
        detail: n < paths.length ? `${tp("{n} pictures added", n)} · ${t("the rest was already in it")}` : tp("{n} pictures added", n),
      });
    } catch (e) {
      showToast({ tone: "error", title: t("Couldn’t add to the slideshow"), problem: String(e) });
    }
    void refreshWallSets();
  };
}

/** The menu entry for these pictures (original paths). */
export function useSlideshowMenu(): (paths: string[]) => MenuItem {
  const t = useT();
  const add = useAdd();
  return (paths) => {
    // fresh for the next time the menu opens
    void refreshWallSets();
    const recent = cache
      .filter((s) => s.lastAdded)
      .sort((a, b) => (b.lastAdded ?? "").localeCompare(a.lastAdded ?? ""))
      .slice(0, 3);
    return {
      label: t("Add to slideshow"),
      icon: <Wallpaper className="h-4 w-4" />,
      children: [
        { label: t("New slideshow…"), icon: <Plus className="h-4 w-4" />, onClick: () => openDialog({ mode: "new", paths }) },
        ...recent.map((s) => ({
          label: s.name,
          icon: <Images className="h-4 w-4" />,
          onClick: () => void add(s, paths),
        })),
        { label: t("Browse…"), icon: <Search className="h-4 w-4" />, onClick: () => openDialog({ mode: "browse", paths }) },
      ],
    };
  };
}

/** The New / Browse dialogs, mounted once. */
export function SlideshowDialogsHost() {
  const [req, setReq] = useState<DialogReq | null>(null);
  useEffect(() => {
    void refreshWallSets();
    const on = (e: Event) => setReq((e as CustomEvent<DialogReq>).detail);
    window.addEventListener(DIALOG_EVENT, on);
    return () => window.removeEventListener(DIALOG_EVENT, on);
  }, []);
  if (!req) return null;
  return req.mode === "new" ? (
    <NewDialog paths={req.paths} onClose={() => setReq(null)} />
  ) : (
    <BrowseDialog paths={req.paths} onClose={() => setReq(null)} />
  );
}

function Shell({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  const t = useT();
  const dlg = useDialogTheme();
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
  return createPortal(
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      onClick={onClose}
      className="fixed inset-0 z-[90] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
    >
      <motion.div
        initial={{ scale: 0.96, opacity: 0, y: 8 }}
        animate={{ scale: 1, opacity: 1, y: 0 }}
        onClick={(e) => e.stopPropagation()}
        className={cn("flex max-h-[80vh] w-[26rem] max-w-[92vw] flex-col overflow-hidden", dlg.panel)}
      >
        <div className={cn("flex shrink-0 items-center justify-between border-b px-5 py-3", dlg.divider)}>
          <h2 className="flex items-center gap-2 text-sm font-semibold text-zinc-100">
            <Wallpaper className={cn("h-4 w-4", dlg.accentText)} />
            {title}
          </h2>
          <button onClick={onClose} title={t("Close (Esc)")} className="text-zinc-500 transition-colors hover:text-zinc-300">
            <X className="h-4 w-4" />
          </button>
        </div>
        {children}
      </motion.div>
    </motion.div>,
    document.body,
  );
}

function NewDialog({ paths, onClose }: { paths: string[]; onClose: () => void }) {
  const t = useT();
  const tf = useTf();
  const tp = useTp();
  const dlg = useDialogTheme();
  const { showToast } = useActions();
  const add = useAdd();
  const [name, setName] = useState(() => tf("Slideshow {n}", { n: cache.length + 1 }));
  const [busy, setBusy] = useState(false);
  const create = async () => {
    const n = name.trim();
    if (!n || busy) return;
    setBusy(true);
    try {
      const id = await createWallSet(n);
      await add({ id, name: n }, paths);
      onClose();
    } catch (e) {
      showToast({ tone: "error", title: t("Couldn’t create the slideshow"), problem: String(e) });
      setBusy(false);
    }
  };
  return (
    <Shell title={t("New slideshow")} onClose={onClose}>
      <div className="space-y-3 px-5 py-4">
        <label className="block text-xs font-medium uppercase tracking-wide text-zinc-500">{t("Name")}</label>
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onFocus={(e) => e.currentTarget.select()}
          onKeyDown={(e) => e.key === "Enter" && void create()}
          className={cn("w-full", dlg.input)}
        />
        <p className="text-xs text-zinc-500">{tp("{n} pictures", paths.length)}</p>
      </div>
      <div className={cn("flex justify-end gap-2 border-t px-5 py-3", dlg.divider)}>
        <Button variant="ghost" size="sm" onClick={onClose}>
          {t("Cancel")}
        </Button>
        <Button variant="primary" size="sm" disabled={!name.trim() || busy} onClick={() => void create()}>
          <Plus className="h-4 w-4" />
          {t("Create and add")}
        </Button>
      </div>
    </Shell>
  );
}

function BrowseDialog({ paths, onClose }: { paths: string[]; onClose: () => void }) {
  const t = useT();
  const tp = useTp();
  const dlg = useDialogTheme();
  const add = useAdd();
  const [sets, setSets] = useState<WallSet[] | null>(cache.length ? cache : null);
  const [q, setQ] = useState("");
  const loaded = useRef(false);
  useEffect(() => {
    if (loaded.current) return;
    loaded.current = true;
    void listWallSets()
      .then(setSets)
      .catch(() => setSets([]));
  }, []);
  const shown = useMemo(
    () => (sets ?? []).filter((s) => s.name.toLowerCase().includes(q.trim().toLowerCase())),
    [sets, q],
  );
  return (
    <Shell title={t("Add to slideshow")} onClose={onClose}>
      <div className="px-4 pt-3">
        <div className={cn("flex items-center gap-1.5 px-2", dlg.field)}>
          <Search className="h-3.5 w-3.5 shrink-0 text-zinc-500" />
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t("Find a slideshow…")}
            className="h-9 w-full bg-transparent text-sm text-zinc-100 outline-none placeholder:text-zinc-500"
          />
        </div>
      </div>
      <div className="min-h-[8rem] flex-1 space-y-1 overflow-y-auto p-3">
        {sets && shown.length === 0 && (
          <p className="px-2 py-6 text-center text-sm text-zinc-500">
            {sets.length === 0 ? t("No slideshows yet.") : t("No slideshows match.")}
          </p>
        )}
        {shown.map((s) => (
          <button
            key={s.id}
            onClick={() => {
              void add(s, paths);
              onClose();
            }}
            className={cn("flex w-full items-center gap-3 rounded-lg px-2 py-1.5 text-left transition-colors", dlg.menuRow)}
          >
            <span className="h-10 w-10 shrink-0 overflow-hidden rounded-md bg-black/40">
              {s.preview[0] && isTauri() ? (
                <img src={thumbUrl(s.preview[0], 128)} alt="" className="h-full w-full object-cover" />
              ) : (
                <Images className="m-2.5 h-5 w-5 text-zinc-600" />
              )}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm text-zinc-100">{s.name}</span>
              <span className="block text-[11px] text-zinc-500">{tp("{n} pictures", s.count)}</span>
            </span>
          </button>
        ))}
      </div>
      <div className={cn("flex items-center justify-between border-t px-5 py-3", dlg.divider)}>
        <span className="text-xs text-zinc-500">{tp("{n} pictures", paths.length)}</span>
        <Button variant="ghost" size="sm" onClick={onClose}>
          {t("Cancel")}
        </Button>
      </div>
    </Shell>
  );
}
