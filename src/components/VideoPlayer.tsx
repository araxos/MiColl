import { useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Camera,
  Check,
  FastForward,
  Gauge,
  PanelBottomClose,
  PanelBottomOpen,
  Pause,
  PictureInPicture2,
  Play,
  Repeat,
  Rewind,
  Volume1,
  Volume2,
  VolumeX,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useT, useTf } from "@/lib/i18n";
import { useDialogTheme } from "@/lib/dialogTheme";
import { isTauri, invoke } from "@/lib/tauri";
import { clock, fineClock, moveScrub, scrubLabel, startScrub, type Scrub } from "@/lib/fineScrub";
import { openVideoPip } from "@/lib/pip";
import {
  getVideoResume,
  getVideoVolume,
  RESUME_MIN_SECS,
  setVideoAutoHide,
  setVideoFull,
  setVideoLoop,
  setVideoRate,
  setVideoResume,
  setVideoSkip,
  setVideoVolume,
  SKIP_STEPS,
  useVideoAutoHide,
  useVideoFull,
  useVideoLoop,
  useVideoRate,
  useVideoSkip,
  VIDEO_RATES,
} from "@/lib/videoPrefs";

/** clicks closer together than this are a double click (the single one waits that long) */
const DOUBLE_MS = 250;
/** after a double click, more clicks within this keep skipping */
const STREAK_MS = 700;
/** the controls go this long after the mouse stops, while it plays */
const HIDE_MS = 2500;

/** One bar the mouse can drag (the seek bar and the volume). The themes dress it (index.css .vid-*). */
function Track({
  value,
  max,
  onChange,
  onDrag,
  fine,
  hoverLabel,
  label,
  className,
}: {
  value: number;
  max: number;
  onChange: (v: number) => void;
  /** dragging starts (true) / ends (false) */
  onDrag?: (on: boolean, speed: number) => void;
  /** moving the mouse up while dragging goes slower (fineScrub.ts) */
  fine?: boolean;
  /** text over the bar where the mouse is (the seek bar's time) */
  hoverLabel?: (v: number) => string;
  label: string;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const scrub = useRef<Scrub | null>(null);
  const [drag, setDrag] = useState(false);
  const [hover, setHover] = useState<{ x: number; v: number } | null>(null);
  const pct = max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0;
  const at = (x: number) => {
    const b = ref.current!.getBoundingClientRect();
    return Math.min(1, Math.max(0, (x - b.left) / b.width)) * max;
  };
  return (
    <div
      ref={ref}
      className={cn("group/track relative h-5 cursor-pointer touch-none", className)}
      onPointerDown={(e) => {
        if (e.button !== 0 || !max) return;
        e.stopPropagation();
        e.currentTarget.setPointerCapture(e.pointerId);
        const v = at(e.clientX);
        scrub.current = startScrub(e.clientX, e.clientY, v);
        setDrag(true);
        onDrag?.(true, 1);
        onChange(v);
      }}
      onPointerMove={(e) => {
        const b = ref.current!.getBoundingClientRect();
        setHover({ x: Math.min(b.width, Math.max(0, e.clientX - b.left)), v: at(e.clientX) });
        const s = scrub.current;
        if (!s || !max) return;
        const v = fine ? moveScrub(s, e.clientX, e.clientY, max / b.width, 0, max) : at(e.clientX);
        onDrag?.(true, fine ? s.speed : 1);
        onChange(v);
      }}
      onPointerUp={() => {
        scrub.current = null;
        setDrag(false);
        onDrag?.(false, 1);
      }}
      onPointerCancel={() => {
        scrub.current = null;
        setDrag(false);
        onDrag?.(false, 1);
      }}
      onPointerLeave={() => setHover(null)}
      onClick={(e) => e.stopPropagation()}
      role="slider"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={Math.round(max)}
      aria-valuenow={Math.round(value)}
    >
      {hoverLabel && hover && !drag && (
        <span
          className="pointer-events-none absolute bottom-full mb-1 -translate-x-1/2 rounded bg-black/80 px-1.5 py-0.5 text-[10px] tabular-nums text-white"
          style={{ left: hover.x }}
        >
          {hoverLabel(hover.v)}
        </span>
      )}
      <div className="vid-track absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-white/30 transition-[height] group-hover/track:h-1.5">
        <div className="vid-fill h-full rounded-full bg-brand-400" style={{ width: `${pct}%` }} />
      </div>
      <div
        className={cn(
          "vid-knob absolute top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow transition-[width,height] duration-100",
          drag ? "h-4 w-4" : "h-3 w-3",
        )}
        data-drag={drag || undefined}
        style={{ left: `${pct}%` }}
      />
    </div>
  );
}

export interface VideoPlayerProps {
  /** What the <video> plays. */
  src: string;
  /** The file on disk: where it was left, screenshots, its own window. */
  path?: string;
  title: string;
  /** Start here (seconds), e.g. coming from the viewer into its own window. */
  startAt?: number;
  autoPlay?: boolean;
  /** Space / K, J / L, Shift+←/→, M work (only for the video on screen). */
  keys?: boolean;
  /** Fill the whole space, also bigger than the video (its own window). */
  fill?: boolean;
  /** As big as the space allows, also bigger than the video itself (comfy / full view). */
  grow?: boolean;
  /** Show "Open in its own window". */
  canPip?: boolean;
  onDims?: (w: number, h: number) => void;
  onContextMenu?: (e: React.MouseEvent) => void;
  onPlay?: () => void;
  /** A screenshot was saved (path, and the reward it's in, to rescan). */
  onShot?: (path: string, rewardId: number | null) => void;
  /** Played to the end (not while it loops). */
  onEnded?: () => void;
  /** Opened in its own window (it pauses here). */
  onPipOpened?: () => void;
  /** Buttons at the end of the bar (the own window's pin). */
  extra?: React.ReactNode;
  /** Keep everything shown (the mouse is on the viewer's bars, a menu is open). */
  hold?: boolean;
  /** Space kept free at the bottom (px): the viewer's strip lies over it in comfy mode. */
  insetBottom?: number;
  /** Show the full-view button (the viewer hides its strip for videos). */
  canFull?: boolean;
  /** Its controls went / came back (the viewer hides its bars with them). */
  onHiddenChange?: (hidden: boolean) => void;
}

/**
 * MiColl's video player (like the phone's): its own controls in the theme's look, a
 * double click on the right half skips forward and on the left back, speed, screenshot,
 * loop, picture in picture, and long videos go on where they were left.
 */
export function VideoPlayer({
  src,
  path,
  title,
  startAt,
  autoPlay = true,
  keys = true,
  fill = false,
  grow = false,
  canPip = false,
  onDims,
  onContextMenu,
  onPlay,
  onShot,
  onEnded,
  onPipOpened,
  extra,
  hold = false,
  onHiddenChange,
  insetBottom = 0,
  canFull = false,
}: VideoPlayerProps) {
  const t = useT();
  const tf = useTf();
  const dlg = useDialogTheme();
  const vidRef = useRef<HTMLVideoElement>(null);
  const areaRef = useRef<HTMLDivElement>(null);
  const [el, setEl] = useState<HTMLVideoElement | null>(null);
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  const rate = useVideoRate();
  const skipSecs = useVideoSkip();
  const autoHide = useVideoAutoHide();
  const loop = useVideoLoop();
  const full = useVideoFull();

  // ---- the video's box: the video's own shape fitted into the space (never bigger than
  // the video unless it fills its window), so the controls sit on the video
  const [area, setArea] = useState({ w: 0, h: 0 });
  const [nat, setNat] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const a = areaRef.current;
    if (!a) return;
    const measure = () => setArea({ w: a.clientWidth, h: a.clientHeight });
    const ro = new ResizeObserver(measure);
    ro.observe(a);
    measure();
    return () => ro.disconnect();
  }, []);
  const box = (() => {
    if (fill || !nat.w || !nat.h || !area.w || !area.h) return null;
    // the space kept free at the bottom (the viewer's strip) isn't the video's
    const h = area.h - insetBottom;
    if (h <= 0) return null;
    const s = Math.min(grow ? Infinity : 1, area.w / nat.w, h / nat.h);
    return { width: Math.round(nat.w * s), height: Math.round(nat.h * s) };
  })();

  // ---- time / state redraws: smooth while it plays, the events for the rest
  useEffect(() => {
    if (!el) return;
    let raf = 0;
    const loopFn = () => {
      redraw();
      if (!el.paused) raf = requestAnimationFrame(loopFn);
    };
    const go = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(loopFn);
    };
    const evs = ["play", "pause", "durationchange", "loadedmetadata", "volumechange", "seeked", "ended", "ratechange"];
    evs.forEach((e) => el.addEventListener(e, go));
    go();
    return () => {
      cancelAnimationFrame(raf);
      evs.forEach((e) => el.removeEventListener(e, go));
    };
  }, [el]);

  // speed (a new source falls back to the default rate, so that one too)
  useEffect(() => {
    if (!el) return;
    el.defaultPlaybackRate = rate;
    el.playbackRate = rate;
  }, [el, rate]);

  // volume from last time (muting is only for now)
  useEffect(() => {
    if (el) el.volume = getVideoVolume();
  }, [el]);

  // ---- a notice over the video ("going on at…", "screenshot saved")
  const [notice, setNotice] = useState<{ text: string; undo?: () => void; error?: boolean } | null>(null);
  useEffect(() => {
    if (!notice) return;
    const tm = window.setTimeout(() => setNotice(null), notice.undo ? 6000 : 3000);
    return () => window.clearTimeout(tm);
  }, [notice]);

  // ---- long videos go on where they were left, and remember where they are now
  useEffect(() => {
    if (!el || !path) return;
    const long = () => Number.isFinite(el.duration) && el.duration >= RESUME_MIN_SECS;
    let started = false;
    const start = () => {
      if (started) return;
      started = true;
      if (startAt != null && startAt > 0) {
        el.currentTime = startAt;
        return;
      }
      if (!long()) return;
      const at = getVideoResume(path);
      if (at === null || at < 3 || at > el.duration - 5) return;
      el.currentTime = at;
      setNotice({ text: tf("Going on at {time}", { time: clock(at) }), undo: () => (el.currentTime = 0) });
    };
    // near the start or the end: next time from the beginning
    const save = () => {
      if (!started || !long()) return;
      const tm = el.currentTime;
      setVideoResume(path, tm >= 3 && tm <= el.duration - 5 ? tm : null);
    };
    let last = 0;
    const tick = () => {
      if (Date.now() - last < 2000) return;
      last = Date.now();
      save();
    };
    const done = () => setVideoResume(path, null);
    if (el.readyState >= 1) start();
    el.addEventListener("loadedmetadata", start);
    el.addEventListener("timeupdate", tick);
    el.addEventListener("pause", save);
    el.addEventListener("ended", done);
    return () => {
      save();
      el.removeEventListener("loadedmetadata", start);
      el.removeEventListener("timeupdate", tick);
      el.removeEventListener("pause", save);
      el.removeEventListener("ended", done);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [el, path]);

  const toggle = useCallback(() => {
    const v = vidRef.current;
    if (!v) return;
    if (v.paused) void v.play().catch(() => {});
    else v.pause();
  }, []);

  // ---- skipping: a bubble on that side counts up while the clicks go on
  const [skipFx, setSkipFx] = useState<{ side: "left" | "right"; total: number; at: number } | null>(null);
  useEffect(() => {
    if (!skipFx) return;
    const tm = window.setTimeout(() => setSkipFx(null), STREAK_MS + 200);
    return () => window.clearTimeout(tm);
  }, [skipFx]);
  const skip = useCallback(
    (side: "left" | "right") => {
      const v = vidRef.current;
      if (!v) return;
      const d = Number.isFinite(v.duration) ? v.duration : Infinity;
      v.currentTime = Math.min(d, Math.max(0, v.currentTime + (side === "right" ? skipSecs : -skipSecs)));
      setSkipFx((f) => ({ side, total: f && f.side === side ? f.total + skipSecs : skipSecs, at: Date.now() }));
    },
    [skipSecs],
  );

  // one click = play/pause (it waits a moment, it could still become a double click),
  // a double click = skip on that half, more clicks right after keep skipping
  const single = useRef(0);
  const streak = useRef(0);
  useEffect(() => () => window.clearTimeout(single.current), []);
  const onSurfaceClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const b = e.currentTarget.getBoundingClientRect();
    const side = e.clientX < b.left + b.width / 2 ? "left" : "right";
    const now = Date.now();
    if (e.detail >= 2 || now < streak.current) {
      window.clearTimeout(single.current);
      streak.current = now + STREAK_MS;
      skip(side);
      return;
    }
    window.clearTimeout(single.current);
    single.current = window.setTimeout(toggle, DOUBLE_MS);
  };

  // ---- the controls go a moment after the mouse stops while it plays
  const [idle, setIdle] = useState(false);
  const idleTimer = useRef(0);
  const poke = useCallback(() => {
    setIdle(false);
    window.clearTimeout(idleTimer.current);
    idleTimer.current = window.setTimeout(() => setIdle(true), HIDE_MS);
  }, []);
  // any mouse move in the window counts (also over the viewer's bars), not only over the video
  useEffect(() => {
    const evs = ["pointermove", "pointerdown", "wheel"] as const;
    evs.forEach((e) => window.addEventListener(e, poke, { passive: true }));
    poke();
    return () => {
      evs.forEach((e) => window.removeEventListener(e, poke));
      window.clearTimeout(idleTimer.current);
    };
  }, [poke]);
  // the settings menu sits on the page (fixed), so a small video doesn't cut it off
  const [menu, setMenu] = useState<{ bottom: number; right: number } | null>(null);
  const [seeking, setSeeking] = useState<{ speed: number } | null>(null);
  const paused = !el || el.paused;
  const hidden = autoHide && !paused && idle && !menu && !seeking && !hold;
  const hiddenCb = useRef(onHiddenChange);
  hiddenCb.current = onHiddenChange;
  useEffect(() => {
    hiddenCb.current?.(hidden);
  }, [hidden]);
  // gone (next file, closed): the viewer's bars come back
  useEffect(() => () => hiddenCb.current?.(false), []);

  // ---- keys, before the viewer's own (Space would start its slideshow there)
  useEffect(() => {
    if (!keys) return;
    const onKey = (e: KeyboardEvent) => {
      const v = vidRef.current;
      if (!v || e.ctrlKey || e.metaKey || e.altKey) return;
      const tgt = e.target instanceof Element ? e.target : null;
      if (tgt?.closest('input:not([type="range"]), textarea, select, [contenteditable="true"]')) return;
      const k = e.key.toLowerCase();
      let done = true;
      if (k === " " || k === "k") toggle();
      else if (k === "j" || (e.shiftKey && e.key === "ArrowLeft")) skip("left");
      else if (k === "l" || (e.shiftKey && e.key === "ArrowRight")) skip("right");
      else if (k === "m") v.muted = !v.muted;
      else done = false;
      if (!done) return;
      e.preventDefault();
      e.stopPropagation();
      poke();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [keys, toggle, skip, poke]);

  // ---- screenshot: the frame on screen as a picture next to the video
  const shoot = async () => {
    const v = vidRef.current;
    if (!v || !path || !v.videoWidth) return;
    const at = v.currentTime;
    try {
      const c = document.createElement("canvas");
      c.width = v.videoWidth;
      c.height = v.videoHeight;
      c.getContext("2d")!.drawImage(v, 0, 0);
      const data = c.toDataURL("image/png");
      const r = await invoke<{ path: string; rewardId: number | null }>("save_video_screenshot", {
        videoPath: path,
        at,
        imageB64: data,
      });
      setNotice({ text: tf("Screenshot saved: {name}", { name: r.path.split(/[\\/]/).pop() ?? "" }) });
      onShot?.(r.path, r.rewardId);
    } catch (e) {
      setNotice({ text: `${t("Couldn’t take the screenshot")} — ${e}`, error: true });
    }
  };

  // ---- its own window: it goes on there from here, this one pauses
  const pip = async () => {
    const v = vidRef.current;
    if (!v) return;
    const playing = !v.paused;
    try {
      await openVideoPip({ src, path, title, time: v.currentTime, playing }, v.videoWidth, v.videoHeight);
      v.pause();
      onPipOpened?.();
    } catch (e) {
      setNotice({ text: `${t("Couldn’t open the window")} — ${e}`, error: true });
    }
  };

  // a narrow player (a small own window): no volume bar, the speed without its icon
  const width = fill ? area.w : (box?.width ?? area.w);
  // (below ~560 px the whole row wouldn't fit and the buttons on the right got cut off)
  const narrow = width > 0 && width < 560;
  const dur = el && Number.isFinite(el.duration) ? el.duration : 0;
  const [dragT, setDragT] = useState<number | null>(null);
  const now = dragT ?? el?.currentTime ?? 0;
  const vol = el ? (el.muted ? 0 : el.volume) : 0;
  const btn =
    "viewer-btn viewer-icon-btn flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-black/35 text-zinc-100 transition-colors micoll-hover";

  return (
    <div
      ref={areaRef}
      className="pointer-events-none relative flex h-full w-full items-center justify-center"
      style={insetBottom ? { paddingBottom: insetBottom } : undefined}
    >
      <div
        className={cn(
          "vid-player pointer-events-auto relative overflow-hidden bg-black",
          fill ? "h-full w-full" : "rounded-lg shadow-2xl",
          hidden && "cursor-none",
        )}
        style={fill ? undefined : (box ?? { maxWidth: "100%", maxHeight: "100%" })}
        onContextMenu={onContextMenu}
      >
        <video
          ref={(v) => {
            vidRef.current = v;
            setEl(v);
          }}
          src={src}
          // our protocol sends CORS headers, so the canvas may read a frame (screenshot)
          crossOrigin={isTauri() ? "anonymous" : undefined}
          autoPlay={autoPlay}
          loop={loop}
          playsInline
          onLoadedMetadata={(e) => {
            const v = e.currentTarget;
            setNat({ w: v.videoWidth, h: v.videoHeight });
            onDims?.(v.videoWidth, v.videoHeight);
          }}
          onPlay={onPlay}
          onEnded={onEnded}
          className={cn("block h-full w-full object-contain", !box && !fill && "max-h-full max-w-full")}
        />

        {/* clicks on the picture: play/pause, double click skips */}
        <div className="absolute inset-0" onClick={onSurfaceClick} />

        {skipFx && (
          <div
            key={skipFx.at}
            className={cn(
              "pointer-events-none absolute top-1/2 flex -translate-y-1/2 items-center gap-1 rounded-full bg-black/60 px-4 py-2 text-sm font-semibold text-white",
              skipFx.side === "right" ? "right-[12%]" : "left-[12%]",
            )}
          >
            {skipFx.side === "left" && <Rewind className="h-4 w-4" fill="currentColor" />}
            {skipFx.total} s
            {skipFx.side === "right" && <FastForward className="h-4 w-4" fill="currentColor" />}
          </div>
        )}

        {/* the big play button while it's paused */}
        {paused && el && (
          <button
            onClick={toggle}
            className="viewer-btn vid-play absolute left-1/2 top-1/2 flex h-16 w-16 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-black/45 text-white transition-colors hover:bg-black/60"
            aria-label={t("Play")}
          >
            <Play className="ml-1 h-7 w-7" fill="currentColor" />
          </button>
        )}

        {notice && (
          <div
            className={cn(
              "absolute left-1/2 top-3 flex max-w-[90%] -translate-x-1/2 items-center gap-2 rounded-full bg-black/75 px-3 py-1.5 text-xs text-white shadow-lg",
              notice.error && "text-rose-200",
            )}
          >
            <span className="truncate">{notice.text}</span>
            {notice.undo && (
              <button
                onClick={() => {
                  notice.undo?.();
                  setNotice(null);
                }}
                className={cn("shrink-0 font-semibold underline-offset-2 hover:underline", dlg.accentText)}
              >
                {t("Start over")}
              </button>
            )}
          </div>
        )}

        {/* the controls, at the bottom of the video */}
        <div
          className={cn(
            "vid-ctrl absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 via-black/45 to-transparent px-3 pb-2 pt-8 transition-opacity duration-300 [text-shadow:0_1px_3px_#000]",
            hidden && "pointer-events-none opacity-0",
          )}
          onClick={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
        >
          <div className="relative">
            {/* slower while the mouse is up: says how much */}
            {seeking && seeking.speed < 1 && (
              <div className="pointer-events-none absolute bottom-full left-1/2 mb-1 -translate-x-1/2 whitespace-nowrap rounded-full bg-black/75 px-3 py-1 text-[11px] font-semibold text-white">
                {t(scrubLabel(seeking.speed))} · {fineClock(now)}
              </div>
            )}
            {seeking && seeking.speed === 1 && (
              <div className="pointer-events-none absolute bottom-full left-1/2 mb-1 -translate-x-1/2 whitespace-nowrap text-[10px] text-white/70">
                {t("Move the mouse up for finer seeking")}
              </div>
            )}
            <Track
              value={now}
              max={dur}
              fine
              label={t("Seek")}
              hoverLabel={clock}
              onChange={(v) => {
                setDragT(v);
                if (el) el.currentTime = v;
              }}
              onDrag={(on, speed) => {
                setSeeking(on ? { speed } : null);
                if (!on) setDragT(null);
              }}
            />
          </div>
          <div className="mt-0.5 flex items-center gap-1.5">
            <button onClick={toggle} className={btn} title={paused ? t("Play (Space)") : t("Pause (Space)")}>
              {paused ? <Play className="ml-0.5 h-4 w-4" fill="currentColor" /> : <Pause className="h-4 w-4" fill="currentColor" />}
            </button>
            {/* sound: the button mutes, the bar next to it sets the volume */}
            <button
              onClick={() => el && (el.muted = !el.muted)}
              className={btn}
              title={el?.muted ? t("Sound on (M)") : t("Mute (M)")}
            >
              {vol === 0 ? <VolumeX className="h-4 w-4" /> : vol < 0.5 ? <Volume1 className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
            </button>
            {!narrow && (
              <Track
                value={vol}
                max={1}
                label={t("Volume")}
                className="w-20 shrink-0"
                onChange={(v) => {
                  if (!el) return;
                  el.volume = v;
                  el.muted = v === 0;
                  setVideoVolume(v);
                }}
              />
            )}
            <span className="vid-time ml-1.5 truncate text-xs tabular-nums text-white">
              {seeking && seeking.speed < 1 ? fineClock(now) : clock(now)} <span className="text-white/60">/ {clock(dur)}</span>
            </span>
            <span className="flex-1" />
            {/* speed, skip step and hiding, in a small menu */}
            <div className="relative">
              <button
                onClick={(e) => {
                  const b = e.currentTarget.getBoundingClientRect();
                  setMenu((m) =>
                    m ? null : { bottom: window.innerHeight - b.top + 8, right: Math.max(8, window.innerWidth - b.right) },
                  );
                }}
                className={cn(btn, "w-auto gap-1 px-2 text-[11px] font-semibold tabular-nums")}
                data-active={menu || rate !== 1 || undefined}
                title={t("Speed and settings")}
              >
                {!narrow && <Gauge className="h-4 w-4" />}
                {rate}×
              </button>
              {menu &&
                createPortal(
                <>
                  <div className="fixed inset-0 z-[95]" onClick={() => setMenu(null)} />
                  <div
                    className={cn(dlg.menu, "fixed z-[96] max-h-[calc(100vh-16px)] w-56 overflow-y-auto p-2 text-xs")}
                    style={{ bottom: Math.min(menu.bottom, window.innerHeight - 40), right: menu.right }}
                  >
                    <div className="px-1 pb-1 text-[10px] font-semibold uppercase tracking-wide text-zinc-500">{t("Speed")}</div>
                    <div className="grid grid-cols-3 gap-1">
                      {VIDEO_RATES.map((r) => (
                        <button
                          key={r}
                          onClick={() => setVideoRate(r)}
                          className={cn(
                            "rounded-md py-1 font-medium tabular-nums",
                            rate === r ? cn(dlg.menuRowOpen, dlg.accentText) : cn("text-zinc-300", dlg.menuRow),
                          )}
                        >
                          {r}×
                        </button>
                      ))}
                    </div>
                    <div className="mt-2 px-1 pb-1 text-[10px] font-semibold uppercase tracking-wide text-zinc-500">
                      {t("Double click skips")}
                    </div>
                    <div className="grid grid-cols-5 gap-1">
                      {SKIP_STEPS.map((s) => (
                        <button
                          key={s}
                          onClick={() => setVideoSkip(s)}
                          className={cn(
                            "rounded-md py-1 font-medium tabular-nums",
                            skipSecs === s ? cn(dlg.menuRowOpen, dlg.accentText) : cn("text-zinc-300", dlg.menuRow),
                          )}
                        >
                          {s}s
                        </button>
                      ))}
                    </div>
                    <div className={cn("my-2 border-t", dlg.divider)} />
                    <button
                      onClick={() => setVideoAutoHide(!autoHide)}
                      className={cn("flex w-full items-center gap-2 rounded-md px-1.5 py-1.5 text-left text-zinc-200", dlg.menuRow)}
                    >
                      <span className={cn("grid h-4 w-4 shrink-0 place-items-center", autoHide && dlg.accentText)}>
                        {autoHide && <Check className="h-4 w-4" />}
                      </span>
                      <span>
                        {t("Hide everything while it plays")}
                        <span className="block text-[10px] text-zinc-500">
                          {t("Controls, bars and the strip, after a moment without the mouse moving")}
                        </span>
                      </span>
                    </button>
                  </div>
                </>,
                document.body,
              )}
            </div>
            {path && isTauri() && (
              <button onClick={() => void shoot()} className={btn} title={t("Take screenshot")}>
                <Camera className="h-4 w-4" />
              </button>
            )}
            <button
              onClick={() => setVideoLoop(!loop)}
              className={btn}
              data-active={loop || undefined}
              title={loop ? t("Repeat: on") : t("Repeat: off")}
            >
              <Repeat className="h-4 w-4" />
            </button>
            {/* full view: the strip under the video goes, the video reaches the bottom */}
            {canFull && (
              <button
                onClick={() => setVideoFull(!full)}
                className={btn}
                data-active={full || undefined}
                title={full ? t("Show the strip again") : t("Full view — hide the strip, the video goes down to the bottom")}
              >
                {full ? <PanelBottomOpen className="h-4 w-4" /> : <PanelBottomClose className="h-4 w-4" />}
              </button>
            )}
            {canPip && isTauri() && (
              <button onClick={() => void pip()} className={btn} title={t("Picture in picture — its own window, MiColl stays usable")}>
                <PictureInPicture2 className="h-4 w-4" />
              </button>
            )}
            {extra}
          </div>
        </div>
      </div>
    </div>
  );
}
