/**
 * Small helpers around Tauri. The app runs either in the Tauri window (real backend)
 * or in a normal browser with `npm run dev` (mock data, no backend).
 */
import { convertFileSrc, invoke as tauriInvoke } from "@tauri-apps/api/core";

export const isTauri = (): boolean =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  return tauriInvoke<T>(cmd, args);
}

/** Turn a file path into a URL the webview can load. */
export function fileUrl(absPath: string | null | undefined): string {
  if (!absPath) return "";
  try {
    return convertFileSrc(absPath);
  } catch {
    return "";
  }
}

/**
 * Streaming URL on our micollmedia protocol (images and videos, also encrypted ones).
 * Uses ETag so edits show up right away.
 */
export function mediaUrl(absPath: string | null | undefined): string {
  if (!absPath) return "";
  try {
    return convertFileSrc(absPath, "micollmedia");
  } catch {
    return "";
  }
}

/** Thumbnail URL (?thumb=<size>). The backend makes it once and caches it. */
export function thumbUrl(absPath: string | null | undefined, size = 512): string {
  const base = mediaUrl(absPath);
  return base ? `${base}?thumb=${size}` : "";
}

/**
 * GIF re-encoded to size x size (?gif=<size>), cached like a thumbnail.
 * The browser always decodes a GIF at full size, so we make a smaller file.
 * Small GIFs are served as they are.
 */
export function gifUrl(absPath: string | null | undefined, size = 512): string {
  const base = mediaUrl(absPath);
  return base ? `${base}?gif=${size}` : "";
}

/**
 * URL that downscales only very large images (fit in edge x edge), otherwise the
 * original. Used by "Optimize large images". The file itself isn't changed.
 */
export function previewUrl(absPath: string | null | undefined, edge = 2560): string {
  const base = mediaUrl(absPath);
  return base ? `${base}?preview=${edge}` : "";
}
