import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { motion } from "framer-motion";
import { listen } from "@tauri-apps/api/event";
import {
  X,
  Eraser,
  Crop,
  Undo2,
  Redo2,
  RotateCcw,
  Layers,
  FilePlus2,
  Loader2,
  Paintbrush,
  Trash2,
  Wand2,
  Sparkles,
  Bot,
  Download,
  Scaling,
  RotateCw,
  FlipHorizontal,
  FlipVertical,
  SlidersHorizontal,
  Scissors,
  Sun,
  Contrast,
  Droplet,
  Expand,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useT, useTf } from "@/lib/i18n";
import { isTauri } from "@/lib/tauri";
import { queuePrefsSync } from "@/lib/prefs";
import {
  readImage,
  editInpaint,
  editInpaintAi,
  editResize,
  editExpand,
  editUpscale,
  editCutout,
  editDetect,
  editSave,
  indexAddedImage,
  saveImageVersion,
  aiModelStatus,
  aiModelDownload,
  type AiModel,
  type AiModelStatus,
} from "@/api/library";
import { ModelDownloadDialog } from "@/components/ModelDownloadDialog";

type Tool = "erase" | "cutout" | "crop" | "transform" | "resize" | "expand" | "adjust";

/** The tools in the left bar, in order (also used for the options bar badge). */
const TOOLS: {
  id: Tool;
  label: string;
  Icon: typeof Eraser;
  title: string;
  /** Hint for the tool's normal mode. */
  hintAdd: string;
  /** Erase only: hint while un-selecting. */
  hintSub?: string;
}[] = [
  {
    id: "erase",
    label: "Erase",
    Icon: Eraser,
    title: "Object remover — paint over something and fill it in",
    hintAdd: "Paint over the area → Detect to snap to the object → adjust → Remove",
    hintSub: "Paint to un-select parts you want to keep",
  },
  {
    id: "cutout",
    label: "Cutout",
    Icon: Scissors,
    title: "Background removal — keep the subject, drop everything behind it",
    hintAdd: "Removes the background in one pass — the checkerboard is transparency",
  },
  { id: "crop", label: "Crop", Icon: Crop, title: "Crop", hintAdd: "Drag a box, then Apply crop" },
  {
    id: "transform",
    label: "Rotate",
    Icon: RotateCw,
    title: "Rotate, flip and straighten",
    hintAdd: "Quarter turns and flips are lossless — straightening trims the corners away",
  },
  {
    id: "resize",
    label: "Resize",
    Icon: Scaling,
    title: "Resize — smaller or larger (AI upscaling available)",
    hintAdd:
      "Set a new size — the ratio stays locked, and going above 100% switches to AI on its own",
  },
  {
    id: "expand",
    label: "Expand",
    Icon: Expand,
    title: "Expand — a wider or taller canvas, the new border gets filled in",
    hintAdd: "Pick a format and drag the picture into place — AI fill grows the border out of it",
  },
  {
    id: "adjust",
    label: "Adjust",
    Icon: SlidersHorizontal,
    title: "Brightness, contrast and saturation",
    hintAdd: "The preview is the result — the sliders bake in exactly what you see",
  },
];

/** All AI models the editor uses. */
const MODELS: AiModel[] = ["lama", "esrgan", "isnet", "sd15"];

/**
 * One undo step = the whole edit state (image, selection mask, crop box...).
 * mask = the selection canvas as PNG data URL (null = nothing selected).
 */
interface Snapshot {
  working: string;
  mask: string | null;
  crop: Rect | null;
}

/** Max undo steps (strokes share the working image string, but big images add up). */
const HISTORY_LIMIT = 60;

/** Expand formats (width : height). The canvas grows on one axis until it has this shape. */
const EXPAND_RATIOS: { id: string; w: number; h: number }[] = [
  { id: "16:9", w: 16, h: 9 },
  { id: "21:9", w: 21, h: 9 },
  { id: "16:10", w: 16, h: 10 },
  { id: "3:2", w: 3, h: 2 },
  { id: "4:3", w: 4, h: 3 },
  { id: "1:1", w: 1, h: 1 },
  { id: "9:16", w: 9, h: 16 },
];

/**
 * The expanded canvas for an image of w×h at ratio rw:rh, the picture placed at pos
 * (0 = left/top, 1 = right/bottom). null when it already has that shape.
 */
function expandPlan(w: number, h: number, rw: number, rh: number, pos: number) {
  const r = rw / rh;
  if (Math.abs(w / h - r) < 0.005) return null;
  const wider = w / h < r;
  const W = wider ? Math.round(h * r) : w;
  const H = wider ? h : Math.round(w / r);
  if (W > 16000 || H > 16000) return null;
  return {
    W,
    H,
    wider,
    x: wider ? Math.round((W - w) * pos) : 0,
    y: wider ? 0 : Math.round((H - h) * pos),
  };
}

/** Brightness / contrast / saturation in percent (100 = unchanged). */
interface Adjust {
  brightness: number;
  contrast: number;
  saturation: number;
}
const NO_ADJUST: Adjust = { brightness: 100, contrast: 100, saturation: 100 };

/** How much a straighten has to zoom in so there are no empty corners. */
function straightenScale(w: number, h: number, deg: number): number {
  const a = (Math.abs(deg) * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const fit = Math.min(w / (w * c + h * s), h / (w * s + h * c));
  // pull the crop 1.5px inside, the exact rectangle leaves half transparent edge pixels.
  // the preview uses the same function
  return fit * Math.max(0.01, 1 - 1.5 / Math.min(w * fit, h * fit));
}

interface Dims {
  w: number;
  h: number;
}
interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Fullscreen image editor: object remover (paint a mask, Erase fills it),
 * crop, resize, cutout, transform and adjust. The working image is a PNG data URL,
 * every edit goes on the undo stack. Save as a copy or as a version.
 */
export function ImageEditor({
  path,
  origPath,
  name,
  onClose,
  onSavedCopy,
  onSavedVersion,
}: {
  /** The image to edit (the shown file, a version or the original). */
  path: string;
  /** The ORIGINAL image path (versions are attached to it). Defaults to path. */
  origPath?: string;
  name?: string;
  onClose: () => void;
  /** "Save a copy" made a new image at this path. */
  onSavedCopy?: (savedPath: string) => void;
  /** "Save as version" added a version to the original. */
  onSavedVersion?: () => void;
}) {
  const t = useT();
  const tf = useTf();
  const versionKey = origPath ?? path;
  const [working, setWorking] = useState<string>("");
  const [original, setOriginal] = useState<string>("");
  const [history, setHistory] = useState<Snapshot[]>([]);
  const [future, setFuture] = useState<Snapshot[]>([]);
  const [dims, setDims] = useState<Dims | null>(null);
  const [tool, setTool] = useState<Tool>("erase");
  const [maskMode, setMaskMode] = useState<"add" | "subtract">("add");
  const [brush, setBrush] = useState(28); // on-screen radius (px)
  const [detectStrength, setDetectStrength] = useState(60); // detect sensitivity 0..100
  const [hasMask, setHasMask] = useState(false);
  const [cropRect, setCropRect] = useState<Rect | null>(null);
  const [busy, setBusy] = useState(false);
  const [busyMsg, setBusyMsg] = useState(() => t("Working…"));
  // remove engine: classic (PatchMatch) or AI (local LaMa)
  const [removeMode, setRemoveModeState] = useState<"classic" | "ai">(() =>
    localStorage.getItem("micoll.removeMode") === "ai" ? "ai" : "classic",
  );
  // download state per model: null = not asked, false = missing, true = on disk
  const [ready, setReady] = useState<Record<AiModel, boolean | null>>({
    lama: null,
    esrgan: null,
    isnet: null,
    sd15: null,
  });
  const [dl, setDl] = useState<Partial<Record<AiModel, { done: number; total: number }>>>({});
  // model info from the backend (URL + folder) for the download dialog
  const [modelInfo, setModelInfo] = useState<Partial<Record<AiModel, AiModelStatus>>>({});
  // the model whose download dialog is open
  const [askModel, setAskModel] = useState<AiModel | null>(null);
  // resize tool: target size (keeps the ratio) + engine
  const [rsW, setRsW] = useState("");
  const [rsH, setRsH] = useState("");
  const [rsPct, setRsPct] = useState("100");
  // resize engine follows the size by itself, so it isn't saved
  const [resizeEngine, setResizeEngine] = useState<"classic" | "ai">("classic");
  // transform tool: straighten angle (turns/flips apply right away)
  const [angle, setAngle] = useState(0);
  // adjust tool: live values, Apply bakes them in
  const [adjust, setAdjust] = useState<Adjust>(NO_ADJUST);
  // cutout tool: edge softness in px
  const [feather, setFeather] = useState(2);
  // expand tool: format, where the picture sits (0..1) and how the border is filled
  const [exRatio, setExRatio] = useState("16:9");
  const [exPos, setExPos] = useState(0.5);
  const [exMode, setExModeState] = useState<"ai" | "hq" | "blur">(() => {
    const m = localStorage.getItem("micoll.expandMode");
    return m === "blur" || m === "hq" ? m : "ai";
  });
  const setExMode = (m: "ai" | "hq" | "blur") => {
    setExModeState(m);
    localStorage.setItem("micoll.expandMode", m);
    queuePrefsSync();
  };
  // displayed image size (fits the stage)
  const [box, setBox] = useState<{ w: number; h: number } | null>(null);

  const stageRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const maskRef = useRef<HTMLCanvasElement>(null);
  const dimsRef = useRef<Dims | null>(null);
  const paintingRef = useRef(false);
  const lastRef = useRef<{ x: number; y: number } | null>(null);
  const cropStartRef = useRef<{ x: number; y: number } | null>(null);
  // the raw brush before Detect, so re-detecting starts from the original strokes
  const roughMaskRef = useRef<string | null>(null);
  // cached mask data URL. undefined = needs re-reading, null = empty
  const maskCacheRef = useRef<string | null | undefined>(undefined);
  // a mask from undo/redo waits here until the new image loaded (resizing wipes the canvas)
  const pendingMaskRef = useRef<string | null | undefined>(undefined);
  // state at drag start, pushed when the drag ends (one stroke = one undo step)
  const dragUndoRef = useRef<Snapshot | null>(null);

  const setRemoveMode = (m: "classic" | "ai") => {
    setRemoveModeState(m);
    localStorage.setItem("micoll.removeMode", m);
    queuePrefsSync();
  };

  /* ---- AI model availability + download progress ------------------------ */
  useEffect(() => {
    if (!isTauri()) return;
    for (const m of MODELS) {
      aiModelStatus(m)
        .then((s) => {
          setReady((r) => ({ ...r, [m]: s.ready }));
          setModelInfo((i) => ({ ...i, [m]: s }));
        })
        .catch(() => setReady((r) => ({ ...r, [m]: false })));
    }
    const un = listen<{ model?: string; done: number; total: number; ready?: boolean }>(
      "ai-model-progress",
      (e) => {
        // old events have no model name, default to lama
        const m = (e.payload.model ?? "lama") as AiModel;
        if (e.payload.ready) {
          setReady((r) => ({ ...r, [m]: true }));
          setDl((d) => ({ ...d, [m]: undefined }));
        } else {
          setDl((d) => ({ ...d, [m]: { done: e.payload.done, total: e.payload.total } }));
        }
      },
    );
    return () => {
      void un.then((f) => f());
    };
  }, []);

  const downloadModel = async (model: AiModel) => {
    if (dl[model]) return;
    setDl((d) => ({ ...d, [model]: { done: 0, total: 0 } }));
    try {
      await aiModelDownload(model);
      setReady((r) => ({ ...r, [model]: true }));
    } catch (err) {
      console.error("AI model download failed", err);
    } finally {
      setDl((d) => ({ ...d, [model]: undefined }));
    }
  };

  /** Download button for a missing model. Asks first (ModelDownloadDialog). */
  const DownloadModelBtn = ({ model, label }: { model: AiModel; label: string }) => {
    const p = dl[model];
    return (
      <ActionBtn onClick={() => setAskModel(model)} disabled={!!p} tone="brand">
        <Download className="h-4 w-4" />
        {p
          ? p.total > 0
            ? tf("Downloading… {pct}%", { pct: Math.round((p.done / p.total) * 100) })
            : t("Downloading…")
          : label}
      </ActionBtn>
    );
  };

  /* ---- resize: ratio-locked width / height / percent -------------------- */
  // changing one field updates the other two (keeps the ratio)
  const syncFromWidth = (v: string) => {
    setRsW(v);
    const n = Math.round(Number(v));
    if (dims && n > 0) {
      setRsH(String(Math.max(1, Math.round(n * (dims.h / dims.w)))));
      setRsPct(String(Math.round((n / dims.w) * 1000) / 10));
    }
  };
  const syncFromHeight = (v: string) => {
    setRsH(v);
    const n = Math.round(Number(v));
    if (dims && n > 0) {
      setRsW(String(Math.max(1, Math.round(n * (dims.w / dims.h)))));
      setRsPct(String(Math.round((n / dims.h) * 1000) / 10));
    }
  };
  const syncFromPct = (v: string) => {
    setRsPct(v);
    const p = Number(v);
    if (dims && p > 0) {
      setRsW(String(Math.max(1, Math.round((dims.w * p) / 100))));
      setRsH(String(Math.max(1, Math.round((dims.h * p) / 100))));
    }
  };

  // always call the latest onClose (the viewer passes a new closure every render)
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  /* ---- load the original ------------------------------------------------ */
  // load only once per image (depending on onClose made it reload and lose the edit)
  const loadedRef = useRef(false);
  useEffect(() => {
    let alive = true;
    loadedRef.current = false;
    if (path && isTauri()) {
      readImage(path)
        .then((d) => {
          if (!alive || loadedRef.current) return;
          loadedRef.current = true;
          setWorking(d);
          setOriginal(d);
        })
        .catch(() => alive && onCloseRef.current());
    }
    return () => {
      alive = false;
    };
  }, [path]);

  /* ---- mouse "Back" closes the editor first (same trick as the viewer) -- */
  const hasMarker = () =>
    !!(window.history.state && (window.history.state as { micollEditor?: boolean }).micollEditor);
  useEffect(() => {
    if (!hasMarker()) window.history.pushState({ micollEditor: true }, "");
    // only close when our own marker is gone
    const onPop = () => {
      if (!hasMarker()) onCloseRef.current();
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const requestClose = useCallback(() => {
    if (hasMarker()) window.history.back();
    else onCloseRef.current();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") requestClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [requestClose]);

  /* ---- canvas / coordinate helpers ------------------------------------- */
  // fit the image in the stage so the mask/crop overlay lines up exactly
  const computeBox = useCallback(() => {
    const st = stageRef.current;
    const d = dimsRef.current;
    if (!st || !d) return;
    const availW = st.clientWidth - 32; // p-4 (16px) on each side
    const availH = st.clientHeight - 32;
    if (availW <= 0 || availH <= 0) return;
    const fit = Math.min(availW / d.w, availH / d.h);
    setBox({ w: Math.max(1, Math.floor(d.w * fit)), h: Math.max(1, Math.floor(d.h * fit)) });
  }, []);

  useEffect(() => {
    const st = stageRef.current;
    if (!st) return;
    const ro = new ResizeObserver(() => computeBox());
    ro.observe(st);
    return () => ro.disconnect();
  }, [computeBox]);

  /* ---- zoom: Ctrl + wheel ---------------------------------------------- */
  // zoom is a CSS transform on the box, 1 = fitted (minimum).
  // the brush stays right because toNat reads the on-screen rect
  const [view, setView] = useState({ z: 1, x: 0, y: 0 });
  const viewRef = useRef(view);
  viewRef.current = view;
  // use the ref, a fast wheel fires several times per frame
  const moveView = (v: { z: number; x: number; y: number }) => {
    viewRef.current = v;
    setView(v);
  };
  const boxRef = useRef(box);
  boxRef.current = box;
  /** Keep the zoomed image covering its frame (no panning into empty space). */
  const clampView = (z: number, x: number, y: number) => {
    const b = boxRef.current;
    if (!b || z <= 1.001) return { z: 1, x: 0, y: 0 };
    const mx = (b.w * (z - 1)) / 2;
    const my = (b.h * (z - 1)) / 2;
    return { z, x: Math.max(-mx, Math.min(mx, x)), y: Math.max(-my, Math.min(my, y)) };
  };
  // new picture = reset the zoom
  useEffect(() => {
    moveView({ z: 1, x: 0, y: 0 });
  }, [box?.w, box?.h]);

  useEffect(() => {
    const st = stageRef.current;
    if (!st) return;
    const onWheel = (e: WheelEvent) => {
      const v = viewRef.current;
      if (e.ctrlKey) {
        // non-passive so it also stops the webview's page zoom
        e.preventDefault();
        e.stopPropagation();
        // keep the point under the cursor in place
        const r = st.getBoundingClientRect();
        const cx = e.clientX - (r.left + r.width / 2);
        const cy = e.clientY - (r.top + r.height / 2);
        const z = Math.min(16, Math.max(1, v.z * (e.deltaY < 0 ? 1.2 : 1 / 1.2)));
        const qx = (cx - v.x) / v.z;
        const qy = (cy - v.y) / v.z;
        moveView(clampView(z, cx - qx * z, cy - qy * z));
      } else if (v.z > 1) {
        // zoomed in: wheel pans (Shift = sideways)
        e.preventDefault();
        const dx = e.shiftKey ? e.deltaY : e.deltaX;
        const dy = e.shiftKey ? 0 : e.deltaY;
        moveView(clampView(v.z, v.x - dx, v.y - dy));
      }
    };
    st.addEventListener("wheel", onWheel, { passive: false });
    return () => st.removeEventListener("wheel", onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // middle mouse drag pans too
  const panRef = useRef<{ px: number; py: number; x: number; y: number } | null>(null);
  const onStagePointerDown = (e: React.PointerEvent) => {
    if (e.button !== 1 || viewRef.current.z <= 1) return;
    e.preventDefault();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* pointer already gone, the drag still works */
    }
    panRef.current = { px: e.clientX, py: e.clientY, x: viewRef.current.x, y: viewRef.current.y };
  };
  const onStagePointerMove = (e: React.PointerEvent) => {
    const p = panRef.current;
    if (!p) return;
    moveView(clampView(viewRef.current.z, p.x + e.clientX - p.px, p.y + e.clientY - p.py));
  };
  const onStagePointerUp = () => {
    panRef.current = null;
  };

  const onImgLoad = (e: React.SyntheticEvent<HTMLImageElement>) => {
    const im = e.currentTarget;
    const c = maskRef.current;
    if (c) {
      c.width = im.naturalWidth;
      c.height = im.naturalHeight;
    }
    const d = { w: im.naturalWidth, h: im.naturalHeight };
    dimsRef.current = d;
    setDims(d);
    // resizing wiped the canvas, restore a waiting undo mask or start clean
    const pending = pendingMaskRef.current;
    pendingMaskRef.current = undefined;
    if (pending !== undefined) {
      restoreMask(pending);
    } else {
      setHasMask(false);
      maskCacheRef.current = null;
      roughMaskRef.current = null;
      setCropRect(null);
    }
    // a new image makes all pending edits invalid
    setAngle(0);
    setAdjust(NO_ADJUST);
    // reset the resize fields to the new size
    setRsW(String(d.w));
    setRsH(String(d.h));
    setRsPct("100");
    computeBox();
  };

  // mouse -> image pixel coordinates + display scale
  const toNat = (e: React.PointerEvent) => {
    const c = maskRef.current!;
    const r = c.getBoundingClientRect();
    const scale = r.width / c.width; // displayed px per natural px
    return {
      x: (e.clientX - r.left) / scale,
      y: (e.clientY - r.top) / scale,
      scale,
    };
  };

  const clamp = (n: number, hi: number) => Math.min(hi, Math.max(0, n));

  /* ---- erase: paint / un-paint the selection mask ---------------------- */
  // check (cheaply) if anything is still selected, for the button state
  const recomputeHasMask = () => {
    const c = maskRef.current;
    if (!c) return;
    const tw = Math.min(96, c.width);
    const th = Math.min(96, c.height);
    const tmp = document.createElement("canvas");
    tmp.width = tw;
    tmp.height = th;
    const tctx = tmp.getContext("2d");
    if (!tctx) return;
    tctx.drawImage(c, 0, 0, tw, th);
    const d = tctx.getImageData(0, 0, tw, th).data;
    let any = false;
    for (let i = 3; i < d.length; i += 4) {
      if (d[i] > 12) {
        any = true;
        break;
      }
    }
    setHasMask(any);
  };

  const strokeTo = (x: number, y: number, natRadius: number) => {
    const c = maskRef.current;
    const ctx = c?.getContext("2d");
    if (!c || !ctx) return;
    // "subtract" erases the mask, "add" paints the selection
    ctx.globalCompositeOperation = maskMode === "subtract" ? "destination-out" : "source-over";
    ctx.strokeStyle = "#f43f5e";
    ctx.fillStyle = "#f43f5e";
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.lineWidth = natRadius * 2;
    const last = lastRef.current;
    if (last) {
      ctx.beginPath();
      ctx.moveTo(last.x, last.y);
      ctx.lineTo(x, y);
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.arc(x, y, natRadius, 0, Math.PI * 2);
    ctx.fill();
    lastRef.current = { x, y };
    maskCacheRef.current = undefined; // the canvas changed — re-read it next time
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || busy || !dims) return;
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    const p = toNat(e);
    // remember the "before" state now, push it when the drag ends
    if (tool === "erase" || tool === "crop") dragUndoRef.current = snapshot();
    if (tool === "erase") {
      paintingRef.current = true;
      lastRef.current = null;
      strokeTo(clamp(p.x, dims.w), clamp(p.y, dims.h), brush / p.scale);
      if (maskMode === "add") setHasMask(true);
    } else if (tool === "crop") {
      cropStartRef.current = { x: clamp(p.x, dims.w), y: clamp(p.y, dims.h) };
      setCropRect({ x: cropStartRef.current.x, y: cropStartRef.current.y, w: 0, h: 0 });
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!dims) return;
    const p = toNat(e);
    if (tool === "erase" && paintingRef.current) {
      strokeTo(clamp(p.x, dims.w), clamp(p.y, dims.h), brush / p.scale);
    } else if (tool === "crop" && cropStartRef.current) {
      const s = cropStartRef.current;
      const cx = clamp(p.x, dims.w);
      const cy = clamp(p.y, dims.h);
      setCropRect({
        x: Math.min(s.x, cx),
        y: Math.min(s.y, cy),
        w: Math.abs(cx - s.x),
        h: Math.abs(cy - s.y),
      });
    }
  };

  const onPointerUp = () => {
    const painted = paintingRef.current && tool === "erase";
    const cropped = !!cropStartRef.current && tool === "crop";
    if (painted) {
      recomputeHasMask();
      // save the brush as input for Detect (also fills the cache)
      const now = maskRef.current?.toDataURL("image/png") ?? null;
      roughMaskRef.current = now;
      maskCacheRef.current = now;
    }
    // drag done -> one undo step
    if ((painted || cropped) && dragUndoRef.current) commit(dragUndoRef.current);
    dragUndoRef.current = null;
    paintingRef.current = false;
    lastRef.current = null;
    cropStartRef.current = null;
  };

  /* ---- undo history ----------------------------------------------------- */
  /** The mask canvas as data URL (cached). */
  const maskNow = (): string | null => {
    if (maskCacheRef.current !== undefined) return maskCacheRef.current;
    const c = maskRef.current;
    const v = c && c.width > 0 ? c.toDataURL("image/png") : null;
    maskCacheRef.current = v;
    return v;
  };

  const snapshot = (): Snapshot => ({ working, mask: maskNow(), crop: cropRect });

  /** Save the state BEFORE a change so it can be undone. Call it first. */
  const commit = (before: Snapshot = snapshot()) => {
    setHistory((h) => [...h, before].slice(-HISTORY_LIMIT));
    setFuture([]); // a fresh edit clears the redo trail
  };

  /** Paint a saved mask back on the canvas (null = keep empty). */
  const restoreMask = (src: string | null) => {
    const c = maskRef.current;
    const ctx = c?.getContext("2d");
    if (!c || !ctx) return;
    ctx.globalCompositeOperation = "source-over";
    ctx.clearRect(0, 0, c.width, c.height);
    maskCacheRef.current = src;
    roughMaskRef.current = src;
    if (!src) {
      setHasMask(false);
      return;
    }
    const im = new Image();
    im.onload = () => {
      ctx.drawImage(im, 0, 0, c.width, c.height);
      recomputeHasMask();
    };
    im.src = src;
  };

  const applySnapshot = (s: Snapshot) => {
    setCropRect(s.crop);
    if (s.working === working) {
      restoreMask(s.mask);
    } else {
      // the canvas gets resized on load (wipes it), so hand the mask over
      pendingMaskRef.current = s.mask;
      setWorking(s.working);
    }
  };

  const clearMask = () => {
    const c = maskRef.current;
    const ctx = c?.getContext("2d");
    if (c && ctx) ctx.clearRect(0, 0, c.width, c.height);
    roughMaskRef.current = null;
    maskCacheRef.current = null;
    setHasMask(false);
  };

  const pushWorking = (next: string) => {
    commit();
    setWorking(next);
  };

  /* ---- actions ---------------------------------------------------------- */
  const loadImage = (src: string) =>
    new Promise<HTMLImageElement>((resolve, reject) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = reject;
      im.src = src;
    });

  // smart detect: shrink the rough brush to the object and show it for review
  const doDetect = async () => {
    if (!hasMask || busy) return;
    // detect from the original brush strokes
    const mask = roughMaskRef.current ?? maskRef.current?.toDataURL("image/png");
    if (!mask) return;
    const before = snapshot();
    setBusy(true);
    try {
      const refined = await editDetect(working, mask, detectStrength / 100);
      const im = await loadImage(refined);
      const c = maskRef.current;
      const ctx = c?.getContext("2d");
      if (c && ctx) {
        ctx.globalCompositeOperation = "source-over";
        ctx.clearRect(0, 0, c.width, c.height);
        ctx.drawImage(im, 0, 0, c.width, c.height);
        maskCacheRef.current = undefined;
      }
      // detect is its own undo step (undo brings the rough brush back)
      commit(before);
      recomputeHasMask();
    } catch (err) {
      console.error("detect failed", err);
    } finally {
      setBusy(false);
    }
  };

  const doErase = async () => {
    if (!hasMask || busy) return;
    const mask = maskRef.current?.toDataURL("image/png");
    if (!mask) return;
    const useAi = removeMode === "ai" && ready.lama === true;
    setBusyMsg(useAi ? t("Removing (AI)…") : t("Removing…"));
    setBusy(true);
    try {
      const res = useAi ? await editInpaintAi(working, mask) : await editInpaint(working, mask);
      pushWorking(res);
      clearMask();
    } catch (err) {
      console.error("inpaint failed", err);
    } finally {
      setBusy(false);
      setBusyMsg(t("Working…"));
    }
  };

  // resize: classic Lanczos, or AI upscale when enlarging
  const targetW = Math.round(Number(rsW));
  const targetH = Math.round(Number(rsH));
  const resizeValid =
    !!dims && targetW >= 1 && targetH >= 1 && targetW <= 16000 && targetH <= 16000;
  const resizeChanged = !!dims && resizeValid && (targetW !== dims.w || targetH !== dims.h);
  const enlarging = !!dims && resizeValid && (targetW > dims.w || targetH > dims.h);

  // enlarging needs AI for real detail, so going above 100% picks AI, back to 100%
  // or below picks Classic. Only when crossing, so a manual choice sticks.
  const wasEnlarging = useRef<boolean | null>(null);
  useEffect(() => {
    if (wasEnlarging.current === enlarging) return;
    wasEnlarging.current = enlarging;
    setResizeEngine(enlarging ? "ai" : "classic");
  }, [enlarging]);

  const doResize = async () => {
    if (!resizeValid || !resizeChanged || busy) return;
    const useAi = resizeEngine === "ai" && enlarging && ready.esrgan === true;
    setBusyMsg(useAi ? t("Upscaling (AI)…") : t("Resizing…"));
    setBusy(true);
    try {
      const res = useAi
        ? await editUpscale(working, targetW, targetH)
        : await editResize(working, targetW, targetH);
      pushWorking(res);
    } catch (err) {
      console.error("resize failed", err);
    } finally {
      setBusy(false);
      setBusyMsg(t("Working…"));
    }
  };

  /* ---- expand: a wider / taller canvas, the border filled in ----------- */
  const exDef = EXPAND_RATIOS.find((r) => r.id === exRatio) ?? EXPAND_RATIOS[0];
  const exPlan = dims ? expandPlan(dims.w, dims.h, exDef.w, exDef.h, exPos) : null;

  // AI fill needs LaMa, HQ needs LaMa (the layout) and Stable Diffusion (the detail)
  const exModelsReady =
    exMode === "blur" ||
    (ready.lama === true && (exMode === "ai" || ready.sd15 === true));

  const doExpand = async () => {
    if (busy || !working || !exPlan || !exModelsReady) return;
    setBusyMsg(exMode === "blur" ? t("Expanding…") : t("Expanding (AI)…"));
    setBusy(true);
    // AI fill grows in strips, a big picture takes a while: show "3 / 8". HQ then adds the
    // detail on the graphics card (its own count).
    const off = await listen<{ phase?: string; done: number; total: number }>(
      "expand-progress",
      (e) =>
        setBusyMsg(
          `${e.payload.phase === "detail" ? t("Adding detail (HQ)…") : t("Expanding (AI)…")} ${e.payload.done} / ${e.payload.total}`,
        ),
    );
    try {
      pushWorking(await editExpand(working, exPlan.W, exPlan.H, exPlan.x, exPlan.y, exMode));
    } catch (err) {
      console.error("expand failed", err);
    } finally {
      off();
      setBusy(false);
      setBusyMsg(t("Working…"));
    }
  };

  // drag the picture along the new canvas in the preview
  const exDragRef = useRef<{ px: number; py: number; pos: number; span: number } | null>(null);
  const onExpandDown = (e: React.PointerEvent, span: number) => {
    if (e.button !== 0 || busy || span <= 0) return;
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* pointer already gone */
    }
    exDragRef.current = { px: e.clientX, py: e.clientY, pos: exPos, span };
  };
  const onExpandMove = (e: React.PointerEvent) => {
    const d = exDragRef.current;
    if (!d || !exPlan) return;
    const delta = exPlan.wider ? e.clientX - d.px : e.clientY - d.py;
    setExPos(Math.min(1, Math.max(0, d.pos + delta / d.span)));
  };
  const onExpandUp = () => {
    exDragRef.current = null;
  };

  /* ---- cutout: drop the background, keep the subject -------------------- */
  const doCutout = async () => {
    if (busy || !working || ready.isnet !== true) return;
    setBusyMsg(t("Removing background…"));
    setBusy(true);
    try {
      pushWorking(await editCutout(working, feather));
    } catch (err) {
      console.error("cutout failed", err);
    } finally {
      setBusy(false);
      setBusyMsg(t("Working…"));
    }
  };

  /* ---- transform: quarter turns, flips, straighten ---------------------- */
  // draw the natural image with a canvas transform (CSS on the <img> doesn't reach
  // drawImage)
  const drawToWorking = (w: number, h: number, paint: (ctx: CanvasRenderingContext2D) => void) => {
    const cv = document.createElement("canvas");
    cv.width = Math.max(1, Math.round(w));
    cv.height = Math.max(1, Math.round(h));
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    paint(ctx);
    pushWorking(cv.toDataURL("image/png"));
  };

  // turns and flips are exact (4 turns = original)
  const rotateQuarter = (dir: 1 | -1) => {
    const img = imgRef.current;
    if (!img || !dims || busy) return;
    drawToWorking(dims.h, dims.w, (ctx) => {
      ctx.translate(dims.h / 2, dims.w / 2);
      ctx.rotate((dir * Math.PI) / 2);
      ctx.drawImage(img, -dims.w / 2, -dims.h / 2);
    });
  };

  const flipImage = (axis: "h" | "v") => {
    const img = imgRef.current;
    if (!img || !dims || busy) return;
    drawToWorking(dims.w, dims.h, (ctx) => {
      ctx.translate(axis === "h" ? dims.w : 0, axis === "v" ? dims.h : 0);
      ctx.scale(axis === "h" ? -1 : 1, axis === "v" ? -1 : 1);
      ctx.drawImage(img, 0, 0);
    });
  };

  // straighten zooms in so there are no empty corners (same as the preview)
  const straighten = () => {
    const img = imgRef.current;
    if (!img || !dims || !angle || busy) return;
    const k = straightenScale(dims.w, dims.h, angle);
    const ow = Math.max(1, Math.round(dims.w * k));
    const oh = Math.max(1, Math.round(dims.h * k));
    drawToWorking(ow, oh, (ctx) => {
      ctx.translate(ow / 2, oh / 2);
      ctx.rotate((angle * Math.PI) / 180);
      ctx.drawImage(img, -dims.w / 2, -dims.h / 2);
    });
  };

  /* ---- adjust: brightness / contrast / saturation ----------------------- */
  // only what a CSS filter can do, the canvas uses the same filter string
  const adjustCss = `brightness(${adjust.brightness}%) contrast(${adjust.contrast}%) saturate(${adjust.saturation}%)`;
  const adjusted =
    adjust.brightness !== 100 || adjust.contrast !== 100 || adjust.saturation !== 100;

  const applyAdjust = () => {
    const img = imgRef.current;
    if (!img || !dims || !adjusted || busy) return;
    drawToWorking(dims.w, dims.h, (ctx) => {
      ctx.filter = adjustCss;
      ctx.drawImage(img, 0, 0);
    });
  };

  const applyCrop = () => {
    const img = imgRef.current;
    if (!img || !cropRect || cropRect.w < 2 || cropRect.h < 2) return;
    const cv = document.createElement("canvas");
    cv.width = Math.round(cropRect.w);
    cv.height = Math.round(cropRect.h);
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(
      img,
      cropRect.x,
      cropRect.y,
      cropRect.w,
      cropRect.h,
      0,
      0,
      cv.width,
      cv.height,
    );
    pushWorking(cv.toDataURL("image/png"));
    setCropRect(null);
  };

  const undo = () => {
    if (history.length === 0 || busy) return;
    const prev = history[history.length - 1];
    const cur = snapshot(); // taken outside the updater: it isn't a pure function
    setHistory((h) => h.slice(0, -1));
    setFuture((f) => [cur, ...f]); // the current state becomes redoable
    applySnapshot(prev);
  };

  const redo = () => {
    if (future.length === 0 || busy) return;
    const ahead = future[0];
    const cur = snapshot();
    setFuture((f) => f.slice(1));
    setHistory((h) => [...h, cur].slice(-HISTORY_LIMIT));
    applySnapshot(ahead);
  };

  // reset is an undo step too
  const reset = () => {
    if (!original || busy) return;
    commit();
    pendingMaskRef.current = null;
    setCropRect(null);
    if (original === working) restoreMask(null);
    else setWorking(original);
  };

  // save as VERSION of the original (the original file isn't touched)
  const saveVersion = async () => {
    if (busy || !working) return;
    setBusy(true);
    try {
      await saveImageVersion(versionKey, working);
      onSavedVersion?.();
      requestClose();
    } catch (err) {
      console.error("save version failed", err);
      setBusy(false);
    }
  };

  // save a SEPARATE image (<name>_edited.png) next to the original
  const saveCopy = async () => {
    if (busy || !working) return;
    setBusy(true);
    try {
      const saved = await editSave(working, versionKey, "copy");
      try {
        await indexAddedImage(versionKey, saved);
      } catch (e) {
        console.error("index copy failed", e);
      }
      onSavedCopy?.(saved);
      requestClose();
    } catch (err) {
      console.error("save copy failed", err);
      setBusy(false);
    }
  };

  // two questions: "is there something to undo" and "are the pixels different from the
  // file"
  const canUndo = history.length > 0;
  const imageEdited = !!original && working !== original;
  const cropPct = (v: number, total: number) => `${(v / total) * 100}%`;
  const activeTool = TOOLS.find((x) => x.id === tool)!;
  // straighten preview only with an angle AND a size
  const straightening = tool === "transform" && angle !== 0 && !!dims;
  const hint =
    tool === "erase" && maskMode === "subtract" ? activeTool.hintSub! : activeTool.hintAdd;

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="micoll-viewer fixed inset-0 z-[60] flex flex-col bg-zinc-950/97 backdrop-blur-sm"
    >
      {askModel && (
        <ModelDownloadDialog
          model={askModel}
          info={modelInfo[askModel]}
          onConfirm={() => {
            const m = askModel;
            setAskModel(null);
            void downloadModel(m);
          }}
          onCancel={() => setAskModel(null)}
        />
      )}
      {/* title row: file, history, save. Also the drag area for the window. */}
      <div
        data-tauri-drag-region
        className="viewer-topbar flex items-center gap-2 border-b border-white/5 bg-gradient-to-r from-brand-900/40 via-zinc-950 to-brand-900/30 px-4 py-2"
      >
        <div data-tauri-drag-region className="mr-2 min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-zinc-100">
            {name ? tf("Edit — {name}", { name }) : t("Edit")}
          </div>
          {dims && (
            <div className="text-[11px] tabular-nums text-zinc-500">
              {dims.w} × {dims.h} px
            </div>
          )}
        </div>

        <ActionBtn onClick={undo} disabled={!canUndo || busy} title={t("Undo")}>
          <Undo2 className="h-4 w-4" />
        </ActionBtn>
        <ActionBtn onClick={redo} disabled={future.length === 0 || busy} title={t("Redo")}>
          <Redo2 className="h-4 w-4" />
        </ActionBtn>
        <ActionBtn onClick={reset} disabled={(!canUndo && !imageEdited) || busy} title={t("Reset to original")}>
          <RotateCcw className="h-4 w-4" />
          {t("Reset")}
        </ActionBtn>

        <div className="mx-1 h-6 w-px bg-zinc-800" />

        <ActionBtn
          onClick={() => void saveVersion()}
          disabled={busy || !imageEdited}
          tone="primary"
          title={t("Keep the original and save this edit as a switchable version")}
        >
          <Layers className="h-4 w-4" />
          {t("Save as version")}
        </ActionBtn>
        <ActionBtn
          onClick={() => void saveCopy()}
          disabled={busy}
          // theme color but quieter than "Save as version" (the one to use first)
          tone="secondary"
          title={t("Save as a separate new image next to the original")}
        >
          <FilePlus2 className="h-4 w-4" />
          {t("Save a copy")}
        </ActionBtn>
        <button
          onClick={requestClose}
          title={t("Close (Esc)")}
          className="ml-1 flex h-9 w-9 items-center justify-center rounded-lg text-zinc-300 transition-colors hover:bg-brand-500/15 hover:text-brand-200"
        >
          <X className="h-5 w-5" />
        </button>
      </div>

      {/* options bar for the selected tool, its action on the right.
          Always the same height (every control is h-9, it scrolls instead of wrapping). */}
      <div className="editor-optionsbar flex h-[3.25rem] shrink-0 items-center gap-2 overflow-x-auto border-b border-white/5 bg-zinc-900/40 px-3 [&>*]:shrink-0">
        <div className="flex h-9 items-center gap-1.5 text-sm font-medium text-zinc-200">
          <activeTool.Icon className="h-4 w-4 text-brand-300" />
          {t(activeTool.label)}
        </div>
        <div className="mx-1 h-6 w-px shrink-0 bg-zinc-800" />

        {tool === "erase" && (
          <>
            <div className="flex h-9 items-center gap-1 rounded-xl border border-zinc-800 bg-zinc-900/70 p-1">
              <IconToolBtn
                Icon={Paintbrush}
                label={t("Select")}
                hint={t("Select — paint over the object")}
                active={maskMode === "add"}
                onClick={() => setMaskMode("add")}
              />
              <IconToolBtn
                Icon={Eraser}
                label={t("Un-select")}
                hint={t("Un-select — wipe parts of the selection you want to keep")}
                active={maskMode === "subtract"}
                onClick={() => setMaskMode("subtract")}
              />
            </div>
            <label className="viewer-chip flex h-9 items-center gap-2 rounded-xl border border-zinc-800 bg-zinc-900/70 px-3 text-xs text-zinc-300">
              {t("Brush")}
              <input
                type="range"
                min={6}
                max={90}
                value={brush}
                onChange={(e) => setBrush(Number(e.target.value))}
                className="accent-brand-500"
              />
              <span className="w-6 tabular-nums text-zinc-400">{brush}</span>
            </label>
            <button
              onClick={() => {
                commit();
                clearMask();
              }}
              disabled={!hasMask}
              title={t("Clear the whole selection")}
              className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-zinc-800 bg-zinc-900 px-2.5 text-xs text-zinc-300 transition-colors micoll-hover disabled:opacity-40 disabled:pointer-events-none"
            >
              <Trash2 className="h-3.5 w-3.5" />
              {t("Clear")}
            </button>
            <label
              className="viewer-chip flex h-9 items-center gap-2 rounded-xl border border-zinc-800 bg-zinc-900/70 px-3 text-xs text-zinc-300"
              title={t("Detect sensitivity — raise it to catch fainter watermarks / text")}
            >
              <Sparkles className="h-3.5 w-3.5 text-brand-300" />
              <input
                type="range"
                min={10}
                max={100}
                value={detectStrength}
                onChange={(e) => setDetectStrength(Number(e.target.value))}
                className="accent-brand-500"
              />
            </label>
          </>
        )}

        {tool === "cutout" && (
          <label
            className="viewer-chip flex h-9 items-center gap-2 rounded-xl border border-zinc-800 bg-zinc-900/70 px-3 text-xs text-zinc-300"
            title={t(
              "Edge softness — a pixel or two hides the cutout’s stair-stepping; raise it for hair and fur",
            )}
          >
            {t("Edge")}
            <input
              type="range"
              min={0}
              max={12}
              value={feather}
              onChange={(e) => setFeather(Number(e.target.value))}
              className="accent-brand-500"
            />
            <span className="w-8 tabular-nums text-zinc-400">{feather} px</span>
          </label>
        )}

        {tool === "transform" && (
          <>
            <div className="flex h-9 items-center gap-1 rounded-xl border border-zinc-800 bg-zinc-900/70 p-1">
              <ToolBtn
                active={false}
                onClick={() => rotateQuarter(-1)}
                title={t("Rotate 90° left (lossless)")}
              >
                <RotateCcw className="h-4 w-4" />
                {t("90° left")}
              </ToolBtn>
              <ToolBtn
                active={false}
                onClick={() => rotateQuarter(1)}
                title={t("Rotate 90° right (lossless)")}
              >
                <RotateCw className="h-4 w-4" />
                {t("90° right")}
              </ToolBtn>
            </div>
            <div className="flex h-9 items-center gap-1 rounded-xl border border-zinc-800 bg-zinc-900/70 p-1">
              <ToolBtn active={false} onClick={() => flipImage("h")} title={t("Mirror left ↔ right")}>
                <FlipHorizontal className="h-4 w-4" />
                {t("Flip")}
              </ToolBtn>
              <ToolBtn active={false} onClick={() => flipImage("v")} title={t("Mirror top ↔ bottom")}>
                <FlipVertical className="h-4 w-4" />
                {t("Flip")}
              </ToolBtn>
            </div>
            <label
              className="viewer-chip flex h-9 items-center gap-2 rounded-xl border border-zinc-800 bg-zinc-900/70 px-3 text-xs text-zinc-300"
              title={t("Straighten — the stage previews the exact crop this leaves behind")}
            >
              {t("Straighten")}
              <input
                type="range"
                min={-45}
                max={45}
                step={0.1}
                value={angle}
                onChange={(e) => setAngle(Number(e.target.value))}
                className="accent-brand-500"
              />
              <span className="w-12 tabular-nums text-zinc-400">{angle.toFixed(1)}°</span>
            </label>
            <button
              onClick={() => setAngle(0)}
              disabled={!angle}
              title={t("Back to level")}
              className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-zinc-800 bg-zinc-900 px-2.5 text-xs text-zinc-300 transition-colors micoll-hover disabled:opacity-40 disabled:pointer-events-none"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              0°
            </button>
          </>
        )}

        {tool === "adjust" && (
          <>
            <AdjustSlider
              Icon={Sun}
              label={t("Brightness")}
              value={adjust.brightness}
              onChange={(v) => setAdjust((a) => ({ ...a, brightness: v }))}
            />
            <AdjustSlider
              Icon={Contrast}
              label={t("Contrast")}
              value={adjust.contrast}
              onChange={(v) => setAdjust((a) => ({ ...a, contrast: v }))}
            />
            <AdjustSlider
              Icon={Droplet}
              label={t("Saturation")}
              value={adjust.saturation}
              max={200}
              onChange={(v) => setAdjust((a) => ({ ...a, saturation: v }))}
            />
            <button
              onClick={() => setAdjust(NO_ADJUST)}
              disabled={!adjusted}
              title={t("Back to the untouched image")}
              className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-zinc-800 bg-zinc-900 px-2.5 text-xs text-zinc-300 transition-colors micoll-hover disabled:opacity-40 disabled:pointer-events-none"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              {t("Reset")}
            </button>
          </>
        )}

        {tool === "expand" && (
          <>
            <div className="flex h-9 items-center gap-1 rounded-xl border border-zinc-800 bg-zinc-900/70 p-1">
              {EXPAND_RATIOS.map((r) => (
                <ToolBtn
                  key={r.id}
                  active={exRatio === r.id}
                  onClick={() => setExRatio(r.id)}
                  title={r.id === "9:16" ? t("Phone wallpaper") : undefined}
                >
                  {r.id}
                </ToolBtn>
              ))}
            </div>
            <label
              className="viewer-chip flex h-9 items-center gap-2 rounded-xl border border-zinc-800 bg-zinc-900/70 px-3 text-xs text-zinc-300"
              title={t("Where the picture sits on the new canvas — you can also drag it")}
            >
              {exPlan && !exPlan.wider ? t("Top") : t("Left")}
              <input
                type="range"
                min={0}
                max={100}
                value={Math.round(exPos * 100)}
                disabled={!exPlan}
                onChange={(e) => setExPos(Number(e.target.value) / 100)}
                onDoubleClick={() => setExPos(0.5)}
                className="accent-brand-500"
              />
              {exPlan && !exPlan.wider ? t("Bottom") : t("Right")}
            </label>
          </>
        )}

        {/* crop shows the current selection instead of options */}
        {tool === "crop" && (
          <>
            <span className="viewer-chip inline-flex h-9 items-center rounded-xl border border-zinc-800 bg-zinc-900/70 px-3 text-xs tabular-nums text-zinc-300">
              {cropRect && cropRect.w >= 2 && cropRect.h >= 2
                ? `${Math.round(cropRect.w)} × ${Math.round(cropRect.h)} px`
                : t("No selection")}
            </span>
            <button
              onClick={() => {
                commit();
                setCropRect(null);
              }}
              disabled={!cropRect}
              title={t("Discard the crop box")}
              className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-zinc-800 bg-zinc-900 px-2.5 text-xs text-zinc-300 transition-colors micoll-hover disabled:opacity-40 disabled:pointer-events-none"
            >
              <Trash2 className="h-3.5 w-3.5" />
              {t("Clear")}
            </button>
          </>
        )}

        {/* size controls (resize), locked to the ratio */}
        {tool === "resize" && dims && (
          <>
            <label className="viewer-chip flex h-9 items-center gap-1.5 rounded-xl border border-zinc-800 bg-zinc-900/70 px-3 text-xs text-zinc-300">
              W
              <input
                type="number"
                min={1}
                max={16000}
                value={rsW}
                onChange={(e) => syncFromWidth(e.target.value)}
                className="w-16 bg-transparent text-zinc-100 outline-none [appearance:textfield]"
              />
              px
            </label>
            <label className="viewer-chip flex h-9 items-center gap-1.5 rounded-xl border border-zinc-800 bg-zinc-900/70 px-3 text-xs text-zinc-300">
              H
              <input
                type="number"
                min={1}
                max={16000}
                value={rsH}
                onChange={(e) => syncFromHeight(e.target.value)}
                className="w-16 bg-transparent text-zinc-100 outline-none [appearance:textfield]"
              />
              px
            </label>
            <label className="viewer-chip flex h-9 items-center gap-1.5 rounded-xl border border-zinc-800 bg-zinc-900/70 px-3 text-xs text-zinc-300">
              <input
                type="number"
                min={1}
                max={1600}
                value={rsPct}
                onChange={(e) => syncFromPct(e.target.value)}
                className="w-14 bg-transparent text-zinc-100 outline-none [appearance:textfield]"
              />
              %
            </label>
          </>
        )}

        <div className="ml-auto flex h-9 items-center gap-1.5">
          {tool === "erase" ? (
            <>
              <ActionBtn onClick={doDetect} disabled={!hasMask || busy} tone="ghost">
                <Sparkles className="h-4 w-4" />
                {t("Detect")}
              </ActionBtn>
              {/* fill engine: classic or AI (LaMa) */}
              <div className="flex h-9 items-center gap-1 rounded-xl border border-zinc-800 bg-zinc-900/70 p-1">
                <ToolBtn
                  active={removeMode === "classic"}
                  onClick={() => setRemoveMode("classic")}
                  title={t("Classic fill — rebuilds the area from surrounding patches (fast, offline)")}
                >
                  <Wand2 className="h-4 w-4" />
                  {t("Classic")}
                </ToolBtn>
                <ToolBtn
                  active={removeMode === "ai"}
                  onClick={() => setRemoveMode("ai")}
                  title={t(
                    "AI fill — local LaMa model (best quality, one-time ~200 MB download, nothing leaves your PC)",
                  )}
                >
                  <Bot className="h-4 w-4" />
                  {t("AI")}
                </ToolBtn>
              </div>
              {removeMode === "ai" && ready.lama === false ? (
                <DownloadModelBtn model="lama" label={t("Get AI model (~200 MB)")} />
              ) : (
                <ActionBtn
                  onClick={doErase}
                  disabled={!hasMask || busy || (removeMode === "ai" && ready.lama !== true)}
                  tone="brand"
                >
                  {removeMode === "ai" ? <Bot className="h-4 w-4" /> : <Wand2 className="h-4 w-4" />}
                  {t("Remove object")}
                </ActionBtn>
              )}
            </>
          ) : tool === "cutout" ? (
            ready.isnet === false ? (
              <DownloadModelBtn model="isnet" label={t("Get cutout model (~178 MB)")} />
            ) : (
              <ActionBtn
                onClick={() => void doCutout()}
                disabled={busy || ready.isnet !== true}
                tone="brand"
                title={t("Detect the subject and make everything behind it transparent")}
              >
                <Scissors className="h-4 w-4" />
                {t("Remove background")}
              </ActionBtn>
            )
          ) : tool === "transform" ? (
            <ActionBtn onClick={straighten} disabled={!angle || busy} tone="brand">
              <RotateCw className="h-4 w-4" />
              {t("Apply straighten")}
            </ActionBtn>
          ) : tool === "adjust" ? (
            <ActionBtn onClick={applyAdjust} disabled={!adjusted || busy} tone="brand">
              <SlidersHorizontal className="h-4 w-4" />
              {t("Apply adjustments")}
            </ActionBtn>
          ) : tool === "expand" ? (
            <>
              <span className="mr-1 text-[11px] tabular-nums text-zinc-500">
                {exPlan
                  ? `${dims?.w} × ${dims?.h} → ${exPlan.W} × ${exPlan.H} px`
                  : t("Already this shape")}
              </span>
              <div className="flex h-9 items-center gap-1 rounded-xl border border-zinc-800 bg-zinc-900/70 p-1">
                <ToolBtn
                  active={exMode === "ai"}
                  onClick={() => setExMode("ai")}
                  title={t(
                    "AI fill — grows the new border out of the picture with the local LaMa model (nothing leaves your PC). Big pictures take a little while",
                  )}
                >
                  <Bot className="h-4 w-4" />
                  {t("AI fill")}
                </ToolBtn>
                <ToolBtn
                  active={exMode === "hq"}
                  onClick={() => setExMode("hq")}
                  title={t(
                    "AI fill HQ — AI fill lays out the border, then Stable Diffusion redraws it with real detail on your graphics card (one-time ~1.9 GB download, nothing leaves your PC)",
                  )}
                >
                  <Sparkles className="h-4 w-4" />
                  {t("AI fill HQ")}
                </ToolBtn>
                <ToolBtn
                  active={exMode === "blur"}
                  onClick={() => setExMode("blur")}
                  title={t("Blur fill — a soft, darker copy of the picture behind it, instant")}
                >
                  <Droplet className="h-4 w-4" />
                  {t("Blur fill")}
                </ToolBtn>
              </div>
              {exMode !== "blur" && ready.lama === false ? (
                <DownloadModelBtn model="lama" label={t("Get AI model (~200 MB)")} />
              ) : exMode === "hq" && ready.sd15 === false ? (
                <DownloadModelBtn model="sd15" label={t("Get HQ model (~1.9 GB)")} />
              ) : (
                <ActionBtn
                  onClick={() => void doExpand()}
                  disabled={!exPlan || busy || !exModelsReady}
                  tone="brand"
                >
                  <Expand className="h-4 w-4" />
                  {t("Expand")}
                </ActionBtn>
              )}
            </>
          ) : tool === "crop" ? (
            <ActionBtn
              onClick={applyCrop}
              disabled={!cropRect || cropRect.w < 2 || busy}
              tone="brand"
            >
              <Crop className="h-4 w-4" />
              {t("Apply crop")}
            </ActionBtn>
          ) : (
            <>
              {/* resize engine, picked from the size, can be changed */}
              <span className="mr-1 text-[11px] text-zinc-500" title={t("Current size")}>
                {dims ? tf("now {w} × {h} px", { w: dims.w, h: dims.h }) : ""}
              </span>
              <div className="flex h-9 items-center gap-1 rounded-xl border border-zinc-800 bg-zinc-900/70 p-1">
                <ToolBtn
                  active={resizeEngine === "classic"}
                  onClick={() => setResizeEngine("classic")}
                  title={
                    enlarging
                      ? t(
                          "Classic — Lanczos. Enlarging with it only stretches the pixels you already have; it won’t add detail",
                        )
                      : t(
                          "Classic — high-quality Lanczos filter (best for shrinking), chosen automatically at 100% or less",
                        )
                  }
                >
                  <Scaling className="h-4 w-4" />
                  {t("Classic")}
                </ToolBtn>
                <ToolBtn
                  active={resizeEngine === "ai" && enlarging}
                  onClick={() => enlarging && setResizeEngine("ai")}
                  disabled={!enlarging}
                  title={
                    enlarging
                      ? t(
                          "AI — local Real-ESRGAN upscaler, chosen automatically above 100% because it’s the only way to gain detail",
                        )
                      : t("AI upscaling only applies when making the image larger")
                  }
                >
                  <Bot className="h-4 w-4" />
                  {t("AI")}
                </ToolBtn>
              </div>
              {resizeEngine === "ai" && enlarging && ready.esrgan === false ? (
                <DownloadModelBtn model="esrgan" label={t("Get AI upscaler (~5 MB)")} />
              ) : (
                <ActionBtn
                  onClick={() => void doResize()}
                  disabled={
                    !resizeValid ||
                    !resizeChanged ||
                    busy ||
                    (resizeEngine === "ai" && enlarging && ready.esrgan !== true)
                  }
                  tone="brand"
                >
                  {resizeEngine === "ai" && enlarging ? (
                    <Bot className="h-4 w-4" />
                  ) : (
                    <Scaling className="h-4 w-4" />
                  )}
                  {t("Apply resize")}
                </ActionBtn>
              )}
            </>
          )}
        </div>
      </div>

      {/* body: tool bar left, stage right */}
      <div className="flex min-h-0 flex-1">
        <div className="flex w-16 shrink-0 flex-col gap-1 border-r border-white/5 bg-zinc-900/40 p-2">
          {TOOLS.map((x) => (
            <RailBtn
              key={x.id}
              Icon={x.Icon}
              label={t(x.label)}
              title={t(x.title)}
              active={tool === x.id}
              onClick={() => setTool(x.id)}
            />
          ))}
        </div>

        {/* stage */}
        <div
          ref={stageRef}
          onPointerDown={onStagePointerDown}
          onPointerMove={onStagePointerMove}
          onPointerUp={onStagePointerUp}
          onPointerCancel={onStagePointerUp}
          // stop Windows middle-click autoscroll
          onMouseDown={(e) => e.button === 1 && e.preventDefault()}
          className="relative flex min-h-0 min-w-0 flex-1 items-center justify-center overflow-hidden p-4"
        >
          {working ? (
            <div
              className={cn(
                // checkerboard behind transparent parts
                "editor-checker relative rounded-lg leading-[0] shadow-2xl",
                // clip the straighten preview to the frame
                straightening && "overflow-hidden",
                // the expand preview stands in for it (kept mounted, it still loads new
                // pictures)
                tool === "expand" && exPlan && "invisible",
              )}
              style={
                box
                  ? {
                      width: box.w,
                      height: box.h,
                      transform:
                        view.z > 1 ? `translate(${view.x}px, ${view.y}px) scale(${view.z})` : undefined,
                    }
                  : undefined
              }
            >
              <img
                ref={imgRef}
                src={working}
                alt={name ?? "image"}
                draggable={false}
                onLoad={onImgLoad}
                className={cn(
                  "block select-none rounded-lg",
                  box ? "h-full w-full" : "max-h-full max-w-full",
                )}
                style={{
                  // preview only, drawToWorking uses the untouched image
                  filter: tool === "adjust" && adjusted ? adjustCss : undefined,
                  transform: straightening
                    ? `rotate(${angle}deg) scale(${1 / straightenScale(dims!.w, dims!.h, angle)})`
                    : undefined,
                }}
              />
              {/* mask surface (also for crop drags), hidden for tools that don't use it */}
              <canvas
                ref={maskRef}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                className={cn(
                  "absolute inset-0 h-full w-full rounded-lg",
                  tool === "erase" || tool === "crop"
                    ? "cursor-crosshair opacity-50"
                    : "pointer-events-none opacity-0",
                  busy && "pointer-events-none",
                )}
              />
              {/* thirds lines for leveling */}
              {straightening && (
                <div className="pointer-events-none absolute inset-0">
                  <div className="absolute inset-x-0 top-1/3 h-px bg-white/25" />
                  <div className="absolute inset-x-0 top-2/3 h-px bg-white/25" />
                  <div className="absolute inset-y-0 left-1/3 w-px bg-white/25" />
                  <div className="absolute inset-y-0 left-2/3 w-px bg-white/25" />
                </div>
              )}
              {/* crop rectangle */}
              {tool === "crop" && cropRect && dims && (
                <div
                  className="pointer-events-none absolute border-2 border-brand-400 bg-brand-500/10 shadow-[0_0_0_9999px_rgba(0,0,0,0.45)]"
                  style={{
                    left: cropPct(cropRect.x, dims.w),
                    top: cropPct(cropRect.y, dims.h),
                    width: cropPct(cropRect.w, dims.w),
                    height: cropPct(cropRect.h, dims.h),
                  }}
                />
              )}
            </div>
          ) : (
            <div className="flex items-center gap-2 text-zinc-400">
              <Loader2 className="h-5 w-5 animate-spin" />
              {t("Loading…")}
            </div>
          )}

          {/* expand preview: the new canvas, the picture on it (drag to move) */}
          {working && tool === "expand" && exPlan && dims && (() => {
            const st = stageRef.current;
            const availW = Math.max(1, (st?.clientWidth ?? 0) - 32);
            const availH = Math.max(1, (st?.clientHeight ?? 0) - 32);
            const fit = Math.min(availW / exPlan.W, availH / exPlan.H);
            const pw = Math.max(1, Math.floor(exPlan.W * fit));
            const ph = Math.max(1, Math.floor(exPlan.H * fit));
            const iw = dims.w * fit;
            const ih = dims.h * fit;
            const span = exPlan.wider ? pw - iw : ph - ih;
            // the note sits in the bigger empty part, the picture covers the middle
            const before = exPlan.wider ? (exPlan.x / exPlan.W) * pw : (exPlan.y / exPlan.H) * ph;
            const after = span - before;
            const noteAt = before >= after ? before / 2 : before + (exPlan.wider ? iw : ih) + after / 2;
            return (
              <div
                className="expand-preview absolute overflow-hidden rounded-lg shadow-2xl"
                style={{ width: pw, height: ph }}
              >
                {exMode === "blur" ? (
                  // same look as the result: a soft, darker copy covering the canvas
                  <img
                    src={working}
                    alt=""
                    draggable={false}
                    className="absolute inset-0 h-full w-full scale-110 object-cover"
                    style={{ filter: "blur(18px) brightness(0.72)" }}
                  />
                ) : (
                  <div className="expand-new absolute inset-0">
                    {Math.max(before, after) > 40 && (
                      <span
                        className="absolute max-w-[12rem] -translate-x-1/2 -translate-y-1/2 rounded-full bg-zinc-950/75 px-3 py-1 text-center text-[11px] text-zinc-300"
                        style={exPlan.wider ? { left: noteAt, top: "50%" } : { top: noteAt, left: "50%" }}
                      >
                        {t("AI fills the striped part")}
                      </span>
                    )}
                  </div>
                )}
                <img
                  src={working}
                  alt={name ?? "image"}
                  draggable={false}
                  onPointerDown={(e) => onExpandDown(e, span)}
                  onPointerMove={onExpandMove}
                  onPointerUp={onExpandUp}
                  onPointerCancel={onExpandUp}
                  className={cn(
                    "absolute select-none outline outline-1 outline-white/40",
                    exPlan.wider ? "cursor-ew-resize" : "cursor-ns-resize",
                    busy && "pointer-events-none",
                  )}
                  style={{
                    left: (exPlan.x / exPlan.W) * pw,
                    top: (exPlan.y / exPlan.H) * ph,
                    width: iw,
                    height: ih,
                  }}
                />
              </div>
            );
          })()}

          {/* zoom level, click to reset */}
          {working && view.z > 1 && (
            <button
              onClick={() => moveView({ z: 1, x: 0, y: 0 })}
              title={t("Back to the full view (Ctrl + mouse wheel zooms)")}
              className="absolute right-3 top-3 rounded-full bg-zinc-950/80 px-3 py-1 text-[11px] tabular-nums text-zinc-300 backdrop-blur transition-colors hover:text-zinc-100"
            >
              {Math.round(view.z * 100)}%
            </button>
          )}

          {/* tool hint at the bottom of the stage */}
          {working && (
            <div className="pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full bg-zinc-950/80 px-3 py-1 text-[11px] text-zinc-400 backdrop-blur">
              {t(hint)}
            </div>
          )}

          {busy && (
            <div className="absolute inset-0 z-10 grid place-items-center bg-black/40">
              <div className="flex items-center gap-2 rounded-xl bg-zinc-900/90 px-4 py-2.5 text-sm text-zinc-100 shadow-2xl">
                <Loader2 className="h-4 w-4 animate-spin text-brand-300" />
                {busyMsg}
              </div>
            </div>
          )}
        </div>
      </div>
    </motion.div>
  );
}

/**
 * Square icon button with a label on hover. The label is portaled to <body>
 * because the options bar would clip it.
 */
function IconToolBtn({
  Icon,
  label,
  hint,
  active,
  onClick,
}: {
  Icon: typeof Eraser;
  label: string;
  /** Longer text for screen readers and title. */
  hint: string;
  active: boolean;
  onClick: () => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const [tip, setTip] = useState<{ x: number; y: number } | null>(null);
  // show it on focus too
  const show = () => {
    const r = ref.current?.getBoundingClientRect();
    if (r) setTip({ x: r.left + r.width / 2, y: r.bottom + 8 });
  };
  const hide = () => setTip(null);

  return (
    <>
      <button
        ref={ref}
        onClick={onClick}
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
        aria-label={hint}
        aria-pressed={active}
        data-active={active || undefined}
        className={cn(
          "viewer-btn inline-flex h-7 w-8 items-center justify-center rounded-lg transition-colors",
          active ? "bg-brand-600 text-white" : "text-zinc-300 micoll-hover",
        )}
      >
        <Icon className="h-4 w-4" />
      </button>
      {tip &&
        createPortal(
          <div
            style={{ left: tip.x, top: tip.y }}
            // above the editor (z-60), below toasts (z-200)
            className="pointer-events-none fixed z-[80] -translate-x-1/2 whitespace-nowrap rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-100 shadow-lg shadow-black/40"
          >
            {label}
          </div>,
          document.body,
        )}
    </>
  );
}

/** Adjust slider: icon, range and the value (shown as offset from 100). */
function AdjustSlider({
  Icon,
  label,
  value,
  onChange,
  max = 200,
}: {
  Icon: typeof Sun;
  label: string;
  value: number;
  onChange: (v: number) => void;
  max?: number;
}) {
  return (
    <label
      className="viewer-chip flex h-9 items-center gap-2 rounded-xl border border-zinc-800 bg-zinc-900/70 px-3 text-xs text-zinc-300"
      title={label}
    >
      <Icon className="h-3.5 w-3.5 text-brand-300" />
      <input
        type="range"
        min={0}
        max={max}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="accent-brand-500"
      />
      <span className="w-9 tabular-nums text-zinc-400">
        {value === 100 ? "0" : `${value > 100 ? "+" : ""}${value - 100}`}
      </span>
    </label>
  );
}

/**
 * A tool in the left bar: icon + small caption.
 * viewer-btn so the iridescent style applies.
 */
function RailBtn({
  Icon,
  label,
  active,
  onClick,
  title,
}: {
  Icon: typeof Eraser;
  label: string;
  active: boolean;
  onClick: () => void;
  title?: string;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      data-active={active || undefined}
      className={cn(
        "viewer-btn flex w-full flex-col items-center gap-1 rounded-lg px-1 py-2 text-[10px] font-medium transition-colors",
        active ? "bg-brand-600 text-white" : "text-zinc-400 micoll-hover hover:text-zinc-100",
      )}
    >
      <Icon className="h-5 w-5" />
      {label}
    </button>
  );
}

function ToolBtn({
  children,
  active,
  onClick,
  title,
  disabled,
}: {
  children: React.ReactNode;
  active: boolean;
  onClick: () => void;
  title?: string;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      disabled={disabled}
      data-active={active || undefined}
      className={cn(
        "viewer-btn inline-flex h-7 items-center gap-1.5 rounded-lg px-3 text-sm font-medium transition-colors",
        active ? "bg-brand-600 text-white" : "text-zinc-300 micoll-hover",
        disabled && "opacity-40 hover:bg-transparent",
      )}
    >
      {children}
    </button>
  );
}

function ActionBtn({
  children,
  onClick,
  disabled,
  tone = "ghost",
  title,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  tone?: "ghost" | "brand" | "secondary" | "primary";
  title?: string;
}) {
  const tones = {
    ghost: "border border-zinc-800 bg-zinc-900 text-zinc-200 micoll-hover",
    brand: "border border-brand-500/40 bg-brand-500/15 text-brand-200 hover:bg-brand-500/25",
    // a second save button, tinted with the accent (premium themes style it in index.css)
    secondary:
      "border border-brand-500/35 bg-brand-500/10 text-brand-100 hover:border-brand-500/55 hover:bg-brand-500/20",
    primary: "bg-brand-600 text-white hover:bg-brand-500 shadow-lg shadow-brand-900/30",
  } as const;
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      data-active={tone === "primary" || undefined}
      data-secondary={tone === "secondary" || undefined}
      className={cn(
        "viewer-btn inline-flex h-9 items-center gap-1.5 rounded-lg px-3 text-sm font-medium transition-colors disabled:opacity-40 disabled:pointer-events-none",
        tones[tone],
      )}
    >
      {children}
    </button>
  );
}
