import { useEffect, useRef, useState } from "react";
import { Brush, Eraser, ImageIcon, Loader2, RotateCcw, SquareDashed } from "lucide-react";
import { useDialogTheme } from "@/lib/dialogTheme";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n";
import { mediaUrl, thumbUrl } from "@/lib/tauri";
import * as api from "@/api/library";

/** A frame on a picture, full-size px. */
export interface MarkFrame {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The mark as framed and touched up: what the search takes. */
export interface MarkState {
  /** The picture it's framed on (what it shows now). */
  path: string;
  frame: MarkFrame;
  /** Its strokes' width, px. */
  stroke: number;
  /** Its pixels in the frame as a grey PNG data URL (white = the mark). */
  mask: () => string;
}

/** The overlay's colour: the theme's accent, see through. */
function tint(): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue("--color-brand-400").trim();
  return v || "#f43f5e";
}

/**
 * "Same mark anywhere", the marking: pick a picture where the watermark shows well, draw
 * a frame around it, MiColl picks the mark out (its strokes, dark or light); a brush and
 * an eraser touch it up.
 */
export function WatermarkMark({ rewardId, onChange }: { rewardId: number; onChange: (m: MarkState | null) => void }) {
  const t = useT();
  const dlg = useDialogTheme();
  const [pics, setPics] = useState<api.WmPic[] | null>(null);
  const [ref, setRef] = useState<string | null>(null);
  const [frame, setFrame] = useState<MarkFrame | null>(null);
  const [stroke, setStroke] = useState(3);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [tool, setTool] = useState<"brush" | "eraser">("brush");
  const [size, setSize] = useState(8);
  // the frame being drawn (display px over the picture)
  const [drag, setDrag] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
  const [edits, setEdits] = useState(0);

  const imgRef = useRef<HTMLImageElement | null>(null);
  // the mark: white with alpha, the frame's size (full-size px)
  const maskRef = useRef<HTMLCanvasElement | null>(null);
  // as picked out by itself, for "Automatic again"
  const autoRef = useRef<HTMLCanvasElement | null>(null);
  const baseRef = useRef<HTMLCanvasElement | null>(null);
  const overRef = useRef<HTMLCanvasElement | null>(null);
  const last = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    void api
      .wmPictures(rewardId)
      .then(setPics)
      .catch((e) => setErr(String(e)));
  }, [rewardId]);

  // the editor's size: the frame fitted into ~700 x 420, small marks zoomed in
  const scale = frame ? Math.min(700 / frame.w, 420 / frame.h, 4) : 1;
  const dw = frame ? Math.max(1, Math.round(frame.w * scale)) : 0;
  const dh = frame ? Math.max(1, Math.round(frame.h * scale)) : 0;

  const redraw = () => {
    const over = overRef.current;
    const mask = maskRef.current;
    if (!over || !mask) return;
    const ctx = over.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, over.width, over.height);
    ctx.globalCompositeOperation = "source-over";
    ctx.drawImage(mask, 0, 0, over.width, over.height);
    ctx.globalCompositeOperation = "source-in";
    ctx.fillStyle = tint();
    ctx.fillRect(0, 0, over.width, over.height);
    ctx.globalCompositeOperation = "source-over";
  };

  // the picture under the editor
  useEffect(() => {
    const base = baseRef.current;
    const img = imgRef.current;
    if (!frame || !base || !img) return;
    const ctx = base.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, base.width, base.height);
    ctx.drawImage(img, frame.x, frame.y, frame.w, frame.h, 0, 0, base.width, base.height);
    redraw();
  }, [frame, dw, dh, edits]);

  // tell the window what's marked (after each change)
  useEffect(() => {
    if (!ref || !frame || !maskRef.current) {
      onChange(null);
      return;
    }
    const mask = maskRef.current;
    onChange({
      path: ref,
      frame,
      stroke,
      mask: () => {
        const c = document.createElement("canvas");
        c.width = mask.width;
        c.height = mask.height;
        const ctx = c.getContext("2d")!;
        ctx.fillStyle = "#000";
        ctx.fillRect(0, 0, c.width, c.height);
        ctx.drawImage(mask, 0, 0);
        return c.toDataURL("image/png");
      },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref, frame, stroke, edits]);

  /** Grey PNG (white = mark) into a white-with-alpha canvas of w x h. */
  const loadMask = (url: string, w: number, h: number) =>
    new Promise<HTMLCanvasElement>((resolve, reject) => {
      const im = new Image();
      im.onload = () => {
        const c = document.createElement("canvas");
        c.width = w;
        c.height = h;
        const ctx = c.getContext("2d")!;
        ctx.drawImage(im, 0, 0);
        const d = ctx.getImageData(0, 0, w, h);
        for (let i = 0; i < d.data.length; i += 4) {
          const v = d.data[i];
          d.data[i] = d.data[i + 1] = d.data[i + 2] = 255;
          d.data[i + 3] = v;
        }
        ctx.putImageData(d, 0, 0);
        resolve(c);
      };
      im.onerror = () => reject(new Error("mask"));
      im.src = url;
    });

  const copyOf = (src: HTMLCanvasElement) => {
    const c = document.createElement("canvas");
    c.width = src.width;
    c.height = src.height;
    c.getContext("2d")!.drawImage(src, 0, 0);
    return c;
  };

  /** The frame drawn: let MiColl pick the mark out of it. */
  const takeFrame = async (f: MarkFrame) => {
    if (!ref) return;
    setBusy(true);
    setErr(null);
    try {
      const m = await api.wmMarkAuto(ref, f.x, f.y, f.w, f.h);
      const c = await loadMask(m.mask, f.w, f.h);
      maskRef.current = c;
      autoRef.current = copyOf(c);
      setStroke(m.stroke);
      setSize(Math.max(4, Math.round(m.stroke * 2.5)));
      setFrame(f);
      setEdits((n) => n + 1);
    } catch (e) {
      setErr(String(e));
      // nothing picked out by itself: the frame opens empty, to paint the mark in
      if (String(e).startsWith("No mark found")) {
        const c = document.createElement("canvas");
        c.width = f.w;
        c.height = f.h;
        maskRef.current = c;
        autoRef.current = copyOf(c);
        setStroke(0);
        setFrame(f);
        setEdits((n) => n + 1);
      }
    } finally {
      setBusy(false);
    }
  };

  // --- drawing the frame on the picture ---
  const local = (e: React.PointerEvent) => {
    const r = imgRef.current!.getBoundingClientRect();
    return { x: Math.min(Math.max(e.clientX - r.left, 0), r.width), y: Math.min(Math.max(e.clientY - r.top, 0), r.height) };
  };
  const frameDown = (e: React.PointerEvent) => {
    if (!imgRef.current || busy) return;
    (e.target as Element).setPointerCapture(e.pointerId);
    const p = local(e);
    setDrag({ x0: p.x, y0: p.y, x1: p.x, y1: p.y });
  };
  const frameMove = (e: React.PointerEvent) => {
    if (!drag) return;
    const p = local(e);
    setDrag({ ...drag, x1: p.x, y1: p.y });
  };
  const frameUp = () => {
    const img = imgRef.current;
    if (!drag || !img) return;
    setDrag(null);
    const r = img.getBoundingClientRect();
    const k = img.naturalWidth / r.width;
    const [x0, x1] = [Math.min(drag.x0, drag.x1), Math.max(drag.x0, drag.x1)];
    const [y0, y1] = [Math.min(drag.y0, drag.y1), Math.max(drag.y0, drag.y1)];
    if (x1 - x0 < 8 || y1 - y0 < 8) return;
    const x = Math.round(x0 * k);
    const y = Math.round(y0 * k);
    void takeFrame({
      x,
      y,
      w: Math.min(Math.round((x1 - x0) * k), img.naturalWidth - x),
      h: Math.min(Math.round((y1 - y0) * k), img.naturalHeight - y),
    });
  };

  // --- painting on the mark ---
  const paintAt = (e: React.PointerEvent) => {
    const over = overRef.current;
    const mask = maskRef.current;
    if (!over || !mask || !frame) return;
    const r = over.getBoundingClientRect();
    const p = { x: ((e.clientX - r.left) / r.width) * frame.w, y: ((e.clientY - r.top) / r.height) * frame.h };
    const ctx = mask.getContext("2d")!;
    ctx.globalCompositeOperation = tool === "brush" ? "source-over" : "destination-out";
    ctx.strokeStyle = ctx.fillStyle = "#fff";
    ctx.lineWidth = size;
    ctx.lineCap = "round";
    ctx.beginPath();
    if (last.current) {
      ctx.moveTo(last.current.x, last.current.y);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
    } else {
      ctx.arc(p.x, p.y, size / 2, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalCompositeOperation = "source-over";
    last.current = p;
    redraw();
  };

  if (err && !pics) return <p className="text-sm text-rose-300">{err}</p>;
  if (!pics)
    return (
      <p className="flex items-center gap-2 text-sm text-zinc-400">
        <Loader2 className={cn("h-4 w-4 animate-spin", dlg.accentText)} />
        {t("Loading the pictures…")}
      </p>
    );

  // 1. which picture
  if (!ref)
    return (
      <div>
        <p className="mb-2 text-sm text-zinc-300">{t("Pick a picture where the watermark shows well.")}</p>
        <div className="grid max-h-[50vh] grid-cols-5 gap-2 overflow-y-auto pr-1">
          {pics.map((p) => (
            <button
              key={p.id}
              onClick={() => setRef(p.path)}
              className={cn("group overflow-hidden border transition-colors", dlg.divider, dlg.soft, "hover:border-brand-400/70")}
              title={p.path.split(/[\\/]/).pop()}
            >
              <img src={thumbUrl(p.path, 256)} alt="" className="aspect-[3/4] w-full object-cover transition-transform group-hover:scale-[1.03]" />
            </button>
          ))}
        </div>
      </div>
    );

  const tools = (
    <div className="flex flex-wrap items-center gap-1.5">
      <button
        onClick={() => {
          setRef(null);
          setFrame(null);
          setErr(null);
          maskRef.current = null;
        }}
        className={cn("flex items-center gap-1.5 px-2.5 py-1 text-xs", dlg.control)}
      >
        <ImageIcon className="h-3.5 w-3.5" />
        {t("Other picture")}
      </button>
      {frame && (
        <>
          <button
            onClick={() => {
              setFrame(null);
              setErr(null);
              maskRef.current = null;
            }}
            className={cn("flex items-center gap-1.5 px-2.5 py-1 text-xs", dlg.control)}
          >
            <SquareDashed className="h-3.5 w-3.5" />
            {t("New frame")}
          </button>
          <span className="mx-1 h-4 w-px bg-white/10" />
          <button
            onClick={() => setTool("brush")}
            className={cn("flex items-center gap-1.5 px-2.5 py-1 text-xs", tool === "brush" ? dlg.controlOn : dlg.control)}
            title={t("Paint parts of the mark that are missing")}
          >
            <Brush className="h-3.5 w-3.5" />
            {t("Brush")}
          </button>
          <button
            onClick={() => setTool("eraser")}
            className={cn("flex items-center gap-1.5 px-2.5 py-1 text-xs", tool === "eraser" ? dlg.controlOn : dlg.control)}
            title={t("Wipe off what isn't the mark")}
          >
            <Eraser className="h-3.5 w-3.5" />
            {t("Eraser")}
          </button>
          <label className="flex items-center gap-2 px-1 text-xs text-zinc-400">
            <input
              type="range"
              min={2}
              max={60}
              value={size}
              onChange={(e) => setSize(Number(e.target.value))}
              className="w-24 accent-brand-500"
            />
            <span className="w-5 tabular-nums">{size}</span>
          </label>
          <button
            onClick={() => {
              if (!autoRef.current) return;
              maskRef.current = copyOf(autoRef.current);
              setEdits((n) => n + 1);
            }}
            className={cn("flex items-center gap-1.5 px-2.5 py-1 text-xs", dlg.control)}
            title={t("Undo your touch-ups")}
          >
            <RotateCcw className="h-3.5 w-3.5" />
            {t("Automatic again")}
          </button>
        </>
      )}
    </div>
  );

  return (
    <div className="space-y-3">
      {tools}
      {err && <p className={cn("px-3 py-2 text-xs text-rose-200", dlg.box)}>{err}</p>}
      {/* 2. the frame around the mark */}
      <div className={cn(frame && "hidden")}>
        <p className="mb-2 text-sm text-zinc-300">{t("Draw a frame around the watermark.")}</p>
        <div className="relative mx-auto w-fit touch-none select-none" onPointerDown={frameDown} onPointerMove={frameMove} onPointerUp={frameUp} onPointerCancel={() => setDrag(null)}>
          <img
            ref={imgRef}
            src={mediaUrl(ref)}
            alt=""
            draggable={false}
            className="block max-h-[56vh] w-auto cursor-crosshair"
          />
          {drag && (
            <div
              className="pointer-events-none absolute border-2 border-dashed border-brand-300 bg-brand-400/10"
              style={{
                left: Math.min(drag.x0, drag.x1),
                top: Math.min(drag.y0, drag.y1),
                width: Math.abs(drag.x1 - drag.x0),
                height: Math.abs(drag.y1 - drag.y0),
              }}
            />
          )}
          {busy && (
            <div className="absolute inset-0 grid place-items-center bg-black/40">
              <Loader2 className={cn("h-6 w-6 animate-spin", dlg.accentText)} />
            </div>
          )}
        </div>
      </div>
      {/* 3. the mark, to touch up */}
      {frame && (
        <div>
          <p className="mb-2 text-sm text-zinc-300">
            {t("This is what’s looked for on the other pictures. Paint in what’s missing, wipe off what isn’t the mark.")}
          </p>
          <div
            className={cn("relative mx-auto w-fit touch-none overflow-hidden border", dlg.divider)}
            style={{ cursor: "none" }}
            onPointerDown={(e) => {
              (e.target as Element).setPointerCapture(e.pointerId);
              last.current = null;
              paintAt(e);
            }}
            onPointerMove={(e) => {
              const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
              setCursor({ x: e.clientX - r.left, y: e.clientY - r.top });
              if (e.buttons & 1) paintAt(e);
            }}
            onPointerUp={() => {
              last.current = null;
              setErr(null);
              setEdits((n) => n + 1);
            }}
            onPointerCancel={() => {
              last.current = null;
              setEdits((n) => n + 1);
            }}
            onPointerLeave={() => setCursor(null)}
          >
            <canvas ref={baseRef} width={dw} height={dh} className="block" />
            <canvas ref={overRef} width={dw} height={dh} className="absolute inset-0 opacity-75" />
            {cursor && (
              <div
                className="pointer-events-none absolute rounded-full border border-white shadow-[0_0_0_1px_rgba(0,0,0,0.6)]"
                style={{
                  left: cursor.x - (size * scale) / 2,
                  top: cursor.y - (size * scale) / 2,
                  width: size * scale,
                  height: size * scale,
                }}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}
