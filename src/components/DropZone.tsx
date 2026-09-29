import { useEffect, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { AnimatePresence, motion } from "framer-motion";
import { FolderInput, Image as ImageIcon } from "lucide-react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { isTauri } from "@/lib/tauri";
import { useActions, type DropContext } from "@/actions";
import { useT } from "@/lib/i18n";

interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface DropTarget {
  /** Where the import should go (artist / platform / month / reward). */
  ctx: DropContext;
  /** Highlight box over the target, in CSS pixels. */
  rect: Rect;
  /** Breadcrumb for the user, e.g. "1123 › Patreon › 11.25". */
  caption: string;
  /** True if the target is a reward folder (files get added into it). */
  reward: boolean;
}

/**
 * What the mouse is over.
 * cover = a cover slot in the template editor, blocked = Settings/editor (nothing to import
 * into).
 */
type Resolution =
  | { kind: "cover"; key: string; rect: Rect; caption: string }
  | { kind: "blocked" }
  | { kind: "target"; target: DropTarget }
  | { kind: "none" };

/** Event a data-drop-cover slot listens to. */
export const COVER_DROP_EVENT = "micoll:cover-drop";
export interface CoverDropDetail {
  /** The value of data-drop-cover (the editor's row key). */
  key: string;
  path: string;
}

const IMAGE_RE = /\.(png|jpe?g|webp|gif|bmp|avif)$/i;

/**
 * Find the element under the drop point (divide by devicePixelRatio for CSS pixels)
 * and walk up collecting the first data-drop-* of each kind.
 */
function resolveDrop(pos: { x: number; y: number }, routeBlocked: boolean): Resolution {
  if (typeof document === "undefined") return { kind: "none" };
  const dpr = window.devicePixelRatio || 1;
  let el = document.elementFromPoint(pos.x / dpr, pos.y / dpr) as HTMLElement | null;
  const ctx: DropContext = {};
  let highlight: HTMLElement | null = null;
  let folderLabel: string | undefined;
  let found = false;
  let blocked = routeBlocked;
  let cover: { key: string; el: HTMLElement } | null = null;
  while (el) {
    const d = el.dataset;
    const isDropEl =
      d.dropArtist ||
      d.dropReward ||
      d.dropYear ||
      d.dropMonth ||
      d.dropNumber ||
      d.dropPlatform ||
      d.dropLabel;
    if (isDropEl && !highlight) highlight = el; // deepest = most specific
    if (!cover && d.dropCover) cover = { key: d.dropCover, el };
    if (d.dropBlock !== undefined) blocked = true;
    if (ctx.artist === undefined && d.dropArtist) {
      ctx.artist = d.dropArtist;
      found = true;
    }
    if (ctx.noDates === undefined && d.dropNodate !== undefined) ctx.noDates = d.dropNodate === "1";
    if (ctx.releaseStyle === undefined && d.dropStyle) {
      ctx.releaseStyle = d.dropStyle as DropContext["releaseStyle"];
    }
    if (ctx.platform === undefined && d.dropPlatform) ctx.platform = d.dropPlatform;
    if (ctx.number === undefined && d.dropNumber) {
      const n = Number(d.dropNumber);
      if (Number.isFinite(n)) ctx.number = n;
    }
    if (ctx.rewardId === undefined && d.dropReward) {
      ctx.rewardId = d.dropReward;
      found = true;
    }
    if (ctx.year === undefined && d.dropYear) {
      const y = Number(d.dropYear);
      if (Number.isFinite(y)) ctx.year = y;
    }
    if (ctx.month === undefined && d.dropMonth) {
      const m = Number(d.dropMonth);
      if (Number.isFinite(m)) ctx.month = m;
    }
    if (folderLabel === undefined && d.dropLabel) folderLabel = d.dropLabel;
    el = el.parentElement;
  }
  if (cover) {
    const r = cover.el.getBoundingClientRect();
    return {
      kind: "cover",
      key: cover.key,
      rect: { left: r.left, top: r.top, width: r.width, height: r.height },
      caption: cover.el.dataset.dropCoverLabel ?? "this month",
    };
  }
  if (blocked) return { kind: "blocked" };
  if (!found || !highlight) return { kind: "none" };
  const caption = [ctx.artist, ctx.platform, folderLabel].filter(Boolean).join(" › ");
  const r = highlight.getBoundingClientRect();
  return {
    kind: "target",
    target: {
      ctx,
      rect: { left: r.left, top: r.top, width: r.width, height: r.height },
      caption,
      reward: !!ctx.rewardId,
    },
  };
}

/**
 * Drag and drop import for the whole window (Tauri file drop events).
 * While dragging it highlights the card/month/reward under the mouse with a
 * breadcrumb, on an empty area it shows "drop to import".
 */
export function DropZone() {
  const t = useT();
  const { importDropped, importIntoReward, backed } = useActions();
  const [over, setOver] = useState(false);
  const [hit, setHit] = useState<Resolution>({ kind: "none" });
  // dropping on Settings does nothing. Read through a ref because the listener is
  // registered once.
  const route = useLocation().pathname;
  const routeRef = useRef(route);
  routeRef.current = route;

  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: (() => void) | undefined;
    let alive = true;
    const blockedRoute = () => routeRef.current.startsWith("/settings");

    getCurrentWebview()
      .onDragDropEvent((event) => {
        const p = event.payload;
        if (p.type === "enter" || p.type === "over") {
          setOver(true);
          setHit(resolveDrop(p.position, blockedRoute()));
        } else if (p.type === "leave") {
          setOver(false);
          setHit({ kind: "none" });
        } else if (p.type === "drop") {
          setOver(false);
          const r = resolveDrop(p.position, blockedRoute());
          setHit({ kind: "none" });
          if (!p.paths || p.paths.length === 0) return;
          if (r.kind === "cover") {
            // a cover is one picture: take the first image, folders are ignored
            const img = p.paths.find((f) => IMAGE_RE.test(f));
            if (img) {
              const detail: CoverDropDetail = { key: r.key, path: img };
              window.dispatchEvent(new CustomEvent(COVER_DROP_EVENT, { detail }));
            }
            return;
          }
          if (r.kind === "blocked") return;
          const ctx = r.kind === "target" ? r.target.ctx : undefined;
          if (ctx?.rewardId) void importIntoReward(ctx.rewardId, p.paths, r.kind === "target" ? r.target.caption : "");
          else void importDropped(p.paths, ctx);
        }
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
  }, [importDropped, importIntoReward]);

  if (!over || hit.kind === "blocked") return null;

  // cover slot: its own highlight, nothing gets imported
  if (hit.kind === "cover") {
    return (
      <div className="pointer-events-none fixed inset-0 z-[120]">
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className="absolute rounded-lg border-2 border-brand-400 ring-4 ring-brand-400/30 shadow-[0_0_0_9999px_rgba(9,9,11,0.55)]"
          style={{ left: hit.rect.left, top: hit.rect.top, width: hit.rect.width, height: hit.rect.height }}
        >
          <div className="absolute -top-3 left-1/2 flex max-w-[90vw] -translate-x-1/2 -translate-y-full items-center gap-2 whitespace-nowrap rounded-full border border-brand-400/60 bg-zinc-900/95 px-3.5 py-1.5 text-sm shadow-2xl">
            <ImageIcon className="h-4 w-4 shrink-0 text-brand-300" />
            <span className="text-zinc-400">{t("Cover for")}</span>
            <span className="truncate font-semibold text-zinc-50">{hit.caption}</span>
          </div>
        </motion.div>
      </div>
    );
  }

  // everything below needs a collection
  if (!backed) return null;
  const target = hit.kind === "target" ? hit.target : null;

  // highlight the target with a breadcrumb (pointer-events-none so it doesn't block
  // elementFromPoint)
  if (target) {
    const verb = target.reward ? "Add files to" : "Import into";
    return (
      <div className="pointer-events-none fixed inset-0 z-[120]">
        {/* spotlight: the big box-shadow darkens everything except the target */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className="absolute rounded-2xl border-2 border-brand-400 ring-4 ring-brand-400/30 shadow-[0_0_0_9999px_rgba(9,9,11,0.55)]"
          style={{
            left: target.rect.left,
            top: target.rect.top,
            width: target.rect.width,
            height: target.rect.height,
          }}
        >
          <div className="absolute -top-3 left-1/2 flex max-w-[90vw] -translate-x-1/2 -translate-y-full items-center gap-2 whitespace-nowrap rounded-full border border-brand-400/60 bg-zinc-900/95 px-3.5 py-1.5 text-sm shadow-2xl">
            <FolderInput className="h-4 w-4 shrink-0 text-brand-300" />
            <span className="text-zinc-400">{verb}</span>
            <span className="truncate font-semibold text-zinc-50">{target.caption}</span>
          </div>
        </motion.div>
      </div>
    );
  }

  // empty area -> normal import (the review asks for the artist)
  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="pointer-events-none fixed inset-0 z-[120] flex items-center justify-center bg-brand-950/70 backdrop-blur-sm"
      >
        <div className="flex flex-col items-center gap-4 rounded-3xl border-2 border-dashed border-brand-400/70 bg-zinc-900/80 px-16 py-12 text-center shadow-2xl">
          <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-brand-500/20 text-brand-200">
            <FolderInput className="h-8 w-8" />
          </div>
          <div>
            <div className="text-lg font-semibold text-zinc-50">{t("Drop to import")}</div>
            <div className="mt-1 text-sm text-zinc-400">
              {t("Release a folder or a .zip / .rar / .7z to add its rewards to your collection.")}
            </div>
            <div className="mt-1 text-xs text-zinc-500">
              {t("Tip: drop onto a creator, a month, or a reward to file it straight there.")}
            </div>
          </div>
        </div>
      </motion.div>
    </AnimatePresence>
  );
}
