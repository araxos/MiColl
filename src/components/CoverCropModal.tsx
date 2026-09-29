import { useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import { Crop, X, Loader2, RotateCcw } from "lucide-react";
import { readImage } from "@/api/library";
import { isTauri } from "@/lib/tauri";
import { useAccent } from "@/lib/theme";
import { useDialogTheme } from "@/lib/dialogTheme";
import { cn } from "@/lib/utils";
import { useT, useTf } from "@/lib/i18n";

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

// 8 resize handles + "move" in the middle. All sizes are in full image pixels,
// the overlay places them by percent.
type Handle = "move" | "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

const MIN_NAT = 24; // smallest crop width in natural px, so the box never collapses

/** Biggest centered box with this aspect that fits in the image. */
function fitBox(nat: { w: number; h: number }, aspect: number): Rect {
  let w = nat.w;
  let h = w / aspect;
  if (h > nat.h) {
    h = nat.h;
    w = h * aspect;
  }
  return { x: (nat.w - w) / 2, y: (nat.h - h) / 2, w, h };
}

/**
 * Crop dialog for "Crop & set" cover. The box is locked to the card's shape
 * (the caller passes the ratio), so what you frame is exactly what the tile shows.
 * Drag to move, resize from edges/corners. Returns the crop as a PNG data URL.
 */
export function CoverCropModal({
  path,
  targetLabel,
  aspect,
  shapeLabel,
  onCancel,
  onConfirm,
}: {
  path: string;
  /** e.g. "reward cover", shown in the header. */
  targetLabel: string;
  /** Card ratio (width / height). */
  aspect: number;
  /** Shape name + ratio for the header chip ("Card 4:6"). */
  shapeLabel?: string;
  onCancel: () => void;
  /** Gets the crop as PNG data URL. Resolve to close, the caller saves it. */
  onConfirm: (croppedDataUrl: string) => Promise<void>;
}) {
  const t = useT();
  const tf = useTf();
  const accent = useAccent();
  const dlg = useDialogTheme();
  // backdrop tinted per premium theme
  const scrim =
    accent === "cyberpunk"
      ? "bg-[#05070c]/88"
      : accent === "iridescent"
        ? "bg-[#0e0c18]/85"
        : accent === "sakura"
          ? "bg-[#1d121a]/88"
          : "bg-black/80";
  // top and bottom bars get a solid background so text and buttons stay readable
  const bar =
    accent === "cyberpunk"
      ? "bg-[#05070c]"
      : accent === "iridescent"
        ? "bg-[#0e0c18]"
        : accent === "sakura"
          ? "bg-[#1d121a]"
          : "bg-zinc-950";
  // handle color (the frame edge is .crop-frame in CSS)
  const handleFill =
    accent === "cyberpunk"
      ? "bg-[#fcee0a]"
      : accent === "iridescent"
        ? "bg-white"
        : accent === "sakura"
          ? "bg-[#f9a8d4]"
          : "bg-brand-400";
  const ghostBtn = cn("rounded-lg px-4 py-2 text-sm transition-colors disabled:opacity-50", dlg.menuRow);

  const [src, setSrc] = useState("");
  const [nat, setNat] = useState<{ w: number; h: number } | null>(null);
  const [rect, setRect] = useState<Rect | null>(null);
  const [busy, setBusy] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  // current drag: handle, box and pointer at the start
  const dragRef = useRef<{ handle: Handle; startBox: Rect; startPtr: { x: number; y: number } } | null>(
    null,
  );

  // load the full image once
  useEffect(() => {
    let alive = true;
    if (path && isTauri()) {
      readImage(path)
        .then((d) => alive && setSrc(d))
        .catch(() => alive && onCancel());
    }
    return () => {
      alive = false;
    };
  }, [path, onCancel]);

  // Esc cancels (not while saving). Capture so it runs before the viewer's Esc.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) {
        e.stopPropagation();
        onCancel();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [busy, onCancel]);

  const onImgLoad = (e: React.SyntheticEvent<HTMLImageElement>) => {
    const d = { w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight };
    setNat(d);
    setRect(fitBox(d, aspect));
  };

  // mouse -> image pixel coordinates, kept inside the image
  const toNat = (e: React.PointerEvent) => {
    const el = boxRef.current;
    if (!el || !nat) return { x: 0, y: 0 };
    const r = el.getBoundingClientRect();
    const scale = r.width / nat.w; // displayed px per natural px
    const clamp = (n: number, hi: number) => Math.min(hi, Math.max(0, n));
    return {
      x: clamp((e.clientX - r.left) / scale, nat.w),
      y: clamp((e.clientY - r.top) / scale, nat.h),
    };
  };

  const startDrag = (handle: Handle) => (e: React.PointerEvent) => {
    if (e.button !== 0 || busy || !rect) return;
    e.preventDefault();
    e.stopPropagation();
    boxRef.current?.setPointerCapture?.(e.pointerId);
    dragRef.current = { handle, startBox: rect, startPtr: toNat(e) };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d || !nat) return;
    const p = toNat(e);
    if (d.handle === "move") {
      const dx = p.x - d.startPtr.x;
      const dy = p.y - d.startPtr.y;
      const x = Math.min(nat.w - d.startBox.w, Math.max(0, d.startBox.x + dx));
      const y = Math.min(nat.h - d.startBox.h, Math.max(0, d.startBox.y + dy));
      setRect({ ...d.startBox, x, y });
      return;
    }
    setRect(resize(d.handle, d.startBox, p, nat, aspect));
  };

  const endDrag = () => {
    dragRef.current = null;
  };

  const confirm = async () => {
    const img = imgRef.current;
    if (!img || !rect || busy) return;
    setBusy(true);
    try {
      const cv = document.createElement("canvas");
      // limit the size (same as COVER_MAX_EDGE), a full size crop would be a huge base64
      // string
      const MAX_EDGE = 2048;
      const k = Math.min(1, MAX_EDGE / Math.max(rect.w, rect.h));
      cv.width = Math.max(1, Math.round(rect.w * k));
      cv.height = Math.max(1, Math.round(rect.h * k));
      const ctx = cv.getContext("2d");
      if (!ctx) throw new Error("no 2d context");
      ctx.drawImage(img, rect.x, rect.y, rect.w, rect.h, 0, 0, cv.width, cv.height);
      await onConfirm(cv.toDataURL("image/png"));
    } catch (err) {
      console.error("crop & set cover failed", err);
      setBusy(false);
    }
  };

  const pct = (v: number, total: number) => `${(v / total) * 100}%`;

  // the 8 handles: position + cursor
  const HANDLES: { h: Handle; style: React.CSSProperties; cursor: string }[] = [
    { h: "nw", style: { left: 0, top: 0 }, cursor: "nwse-resize" },
    { h: "n", style: { left: "50%", top: 0 }, cursor: "ns-resize" },
    { h: "ne", style: { left: "100%", top: 0 }, cursor: "nesw-resize" },
    { h: "e", style: { left: "100%", top: "50%" }, cursor: "ew-resize" },
    { h: "se", style: { left: "100%", top: "100%" }, cursor: "nwse-resize" },
    { h: "s", style: { left: "50%", top: "100%" }, cursor: "ns-resize" },
    { h: "sw", style: { left: 0, top: "100%" }, cursor: "nesw-resize" },
    { h: "w", style: { left: 0, top: "50%" }, cursor: "ew-resize" },
  ];

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className={cn("absolute inset-0 z-[70] flex flex-col backdrop-blur-sm", scrim)}
    >
      {/* header */}
      {/* relative z-10 so the crop shadow doesn't darken the bars */}
      <div
        className={cn(
          "relative z-10 flex items-center justify-between border-b px-5 py-3",
          dlg.divider,
          bar,
        )}
      >
        <div className="flex items-center gap-2.5 text-sm text-zinc-200">
          <Crop className={cn("h-4 w-4", dlg.accentText)} />
          {/* .fav-title is styled per theme */}
          <span className="fav-title text-[13px]">
            {tf("Crop & set: {what}", { what: targetLabel })}
          </span>
          {shapeLabel && (
            <span
              className={cn(
                "hidden shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium text-zinc-200 sm:inline",
                dlg.field,
              )}
            >
              {shapeLabel}
            </span>
          )}
          <span className="hidden text-zinc-500 lg:inline">
            {t("— drag the box or its edges (locked to the card shape)")}
          </span>
        </div>
        <button
          onClick={onCancel}
          disabled={busy}
          className={cn("rounded-lg p-1.5 transition-colors disabled:opacity-50", dlg.menuRow)}
          title={t("Cancel (Esc)")}
        >
          <X className="h-5 w-5" />
        </button>
      </div>

      {/* crop area */}
      <div className="flex min-h-0 flex-1 items-center justify-center px-6 pb-2">
        {src ? (
          <div
            ref={boxRef}
            onPointerMove={onPointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            className="relative inline-block max-h-full max-w-full select-none touch-none"
          >
            <img
              ref={imgRef}
              src={src}
              alt=""
              draggable={false}
              onLoad={onImgLoad}
              className="block max-h-[calc(100vh-11rem)] max-w-full rounded-lg shadow-2xl"
            />
            {rect && nat && (
              <>
                {/* darken everything outside the crop */}
                <div className="pointer-events-none absolute inset-0 bg-black/55" />
                {/* crop window: move area + 8 handles */}
                <div
                  onPointerDown={startDrag("move")}
                  className="crop-frame absolute cursor-move border-2 shadow-[0_0_0_9999px_rgba(0,0,0,0.55)]"
                  style={{
                    left: pct(rect.x, nat.w),
                    top: pct(rect.y, nat.h),
                    width: pct(rect.w, nat.w),
                    height: pct(rect.h, nat.h),
                  }}
                >
                  <div className="pointer-events-none absolute inset-0 ring-1 ring-inset ring-white/40" />
                  {/* rule of thirds lines */}
                  <div className="pointer-events-none absolute inset-0">
                    <div className="absolute left-1/3 top-0 h-full w-px bg-white/25" />
                    <div className="absolute left-2/3 top-0 h-full w-px bg-white/25" />
                    <div className="absolute left-0 top-1/3 h-px w-full bg-white/25" />
                    <div className="absolute left-0 top-2/3 h-px w-full bg-white/25" />
                  </div>
                  {HANDLES.map(({ h, style, cursor }) => (
                    <div
                      key={h}
                      onPointerDown={startDrag(h)}
                      style={{ ...style, cursor }}
                      className={cn(
                        "absolute h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 border border-zinc-900 shadow",
                        // no rounded corners on cyberpunk
                        accent === "cyberpunk" ? "rounded-none" : "rounded-sm",
                        handleFill,
                      )}
                    />
                  ))}
                </div>
              </>
            )}
          </div>
        ) : (
          <Loader2 className={cn("h-6 w-6 animate-spin", dlg.accentText)} />
        )}
      </div>

      {/* footer buttons */}
      <div
        className={cn(
          "relative z-10 flex items-center justify-between gap-3 border-t px-6 py-4",
          dlg.divider,
          bar,
        )}
      >
        <button
          onClick={() => nat && setRect(fitBox(nat, aspect))}
          disabled={!nat || busy}
          className={cn(ghostBtn, "flex items-center gap-1.5 !px-3 disabled:opacity-40")}
        >
          <RotateCcw className="h-4 w-4" />
          {t("Reset box")}
        </button>
        <div className="flex items-center gap-2">
          <button onClick={onCancel} disabled={busy} className={ghostBtn}>
            {t("Cancel")}
          </button>
          <button
            onClick={confirm}
            disabled={!rect || busy}
            className={cn(
              "flex items-center gap-2 rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-brand-500 disabled:opacity-40",
              // premium themes use their own button fill
              dlg.primary,
            )}
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Crop className="h-4 w-4" />}
            {t("Crop & set")}
          </button>
        </div>
      </div>
    </motion.div>
  );
}

/**
 * Resize the box towards the pointer, keeping the ratio and staying inside the image.
 * Corners grow from the opposite corner, edges from the opposite edge (centered).
 */
function resize(
  handle: Handle,
  start: Rect,
  p: { x: number; y: number },
  nat: { w: number; h: number },
  aspect: number,
): Rect {
  const minW = MIN_NAT;

  // --- corners: the opposite corner stays fixed ---
  const corner = (ax: number, ay: number, sx: number, sy: number): Rect => {
    const desiredW = Math.abs(p.x - ax);
    const desiredH = Math.abs(p.y - ay);
    let w = Math.max(desiredW, desiredH * aspect); // follow the farther axis
    const maxWx = sx > 0 ? nat.w - ax : ax;
    const maxHy = sy > 0 ? nat.h - ay : ay;
    w = Math.min(w, maxWx, maxHy * aspect);
    w = Math.max(w, minW);
    const h = w / aspect;
    return { x: sx > 0 ? ax : ax - w, y: sy > 0 ? ay : ay - h, w, h };
  };

  // --- left/right edges: one X edge fixed, centered vertically ---
  const edgeX = (fixedX: number, dir: number, cy: number): Rect => {
    let w = Math.abs(p.x - fixedX);
    const maxWx = dir > 0 ? nat.w - fixedX : fixedX;
    const maxHcentred = 2 * Math.min(cy, nat.h - cy);
    w = Math.min(w, maxWx, maxHcentred * aspect);
    w = Math.max(w, minW);
    const h = w / aspect;
    return { x: dir > 0 ? fixedX : fixedX - w, y: cy - h / 2, w, h };
  };

  // --- top/bottom edges: one Y edge fixed, centered horizontally ---
  const edgeY = (fixedY: number, dir: number, cx: number): Rect => {
    let h = Math.abs(p.y - fixedY);
    const maxHy = dir > 0 ? nat.h - fixedY : fixedY;
    const maxWcentred = 2 * Math.min(cx, nat.w - cx);
    h = Math.min(h, maxHy, maxWcentred / aspect);
    h = Math.max(h, minW / aspect);
    const w = h * aspect;
    return { x: cx - w / 2, y: dir > 0 ? fixedY : fixedY - h, w, h };
  };

  const l = start.x;
  const t = start.y;
  const r = start.x + start.w;
  const b = start.y + start.h;
  const cx = start.x + start.w / 2;
  const cy = start.y + start.h / 2;

  switch (handle) {
    case "se":
      return corner(l, t, 1, 1);
    case "sw":
      return corner(r, t, -1, 1);
    case "ne":
      return corner(l, b, 1, -1);
    case "nw":
      return corner(r, b, -1, -1);
    case "e":
      return edgeX(l, 1, cy);
    case "w":
      return edgeX(r, -1, cy);
    case "s":
      return edgeY(t, 1, cx);
    case "n":
      return edgeY(b, -1, cx);
    default:
      return start;
  }
}
