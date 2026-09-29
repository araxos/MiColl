/**
 * Video thumbnails made in the webview.
 * The Rust image crate can't read videos, so we load the video hidden, seek a bit,
 * draw one frame on a canvas and turn it into a JPEG data URL. Cached per path,
 * only a few at once. If Chromium can't play it (mkv/avi...) we return "".
 */
import { mediaUrl } from "@/lib/tauri";

const VIDEO_RE = /\.(mp4|webm|mov|m4v|mkv|avi|wmv|flv)$/i;

/** Is this a video file? (same list as the indexer's VIDEO_EXTS) */
export const isVideoPath = (p: string | null | undefined): boolean => !!p && VIDEO_RE.test(p);

// one frame per path ("" = couldn't decode), always the same resolution
const cache = new Map<string, string>();
const inflight = new Map<string, Promise<string>>();
const TARGET = 512; // max edge of the generated thumbnail, in px

/** Clear the cache (e.g. on lock). */
export function clearVideoThumbMemo(): void {
  cache.clear();
}

// limit how many run at once
let active = 0;
const waiters: Array<() => void> = [];
const MAX_CONCURRENT = 3;
function acquire(): Promise<void> {
  if (active < MAX_CONCURRENT) {
    active++;
    return Promise.resolve();
  }
  return new Promise<void>((res) => waiters.push(res)).then(() => {
    active++;
  });
}
function release(): void {
  active--;
  waiters.shift()?.();
}

/** Load the video hidden, grab a frame and return a JPEG data URL (or ""). */
function capture(path: string): Promise<string> {
  return new Promise<string>((resolve) => {
    const url = mediaUrl(path);
    if (!url) return resolve("");

    const video = document.createElement("video");
    video.muted = true;
    video.crossOrigin = "anonymous";
    // "metadata" so it doesn't download the whole video ("auto" crashed the webview once)
    video.preload = "metadata";
    video.playsInline = true;

    let done = false;
    const finish = (out: string) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      video.removeAttribute("src");
      video.load(); // release the stream
      resolve(out);
    };
    // give up on slow files instead of leaking the element
    const timer = setTimeout(() => finish(""), 10000);

    const grab = () => {
      try {
        const vw = video.videoWidth;
        const vh = video.videoHeight;
        if (!vw || !vh) return finish("");
        const scale = Math.min(1, TARGET / Math.max(vw, vh));
        const cw = Math.max(1, Math.round(vw * scale));
        const ch = Math.max(1, Math.round(vh * scale));
        const canvas = document.createElement("canvas");
        canvas.width = cw;
        canvas.height = ch;
        const ctx = canvas.getContext("2d");
        if (!ctx) return finish("");
        ctx.drawImage(video, 0, 0, cw, ch);
        finish(canvas.toDataURL("image/jpeg", 0.8));
      } catch {
        finish(""); // tainted canvas / draw failure
      }
    };

    video.onloadedmetadata = () => {
      // with preload="metadata" nothing is decoded until we seek, a bit after the start
      // also avoids black first frames
      const t = Math.min(1, (video.duration || 0) * 0.1);
      try {
        video.currentTime = t > 0.05 ? t : 0.001; // grab() runs on `seeked`
      } catch {
        grab();
      }
    };
    video.onseeked = grab;
    video.onerror = () => finish("");

    video.src = url;
  });
}

/** Cached video thumbnail (JPEG data URL) or "". */
export function getVideoThumb(absPath: string): Promise<string> {
  const hit = cache.get(absPath);
  if (hit !== undefined) return Promise.resolve(hit);
  const pending = inflight.get(absPath);
  if (pending) return pending;

  const p = (async () => {
    await acquire();
    try {
      const out = await capture(absPath);
      cache.set(absPath, out);
      return out;
    } finally {
      release();
      inflight.delete(absPath);
    }
  })();
  inflight.set(absPath, p);
  return p;
}
