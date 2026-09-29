import { useEffect, useState } from "react";
import { isTauri, thumbUrl } from "@/lib/tauri";
import { getVideoThumb, isVideoPath, clearVideoThumbMemo } from "@/lib/videoThumb";

/**
 * Turn a file path into a thumbnail URL.
 * Images: a micollmedia://...?thumb=N URL (the backend caches the JPEG).
 * Videos: a frame captured in the webview (see videoThumb), async.
 * In the browser this returns "" so callers show a gradient.
 */
export function clearThumbMemo() {
  clearVideoThumbMemo();
}

export function useThumb(absPath: string | undefined, size = 512): string {
  const video = isVideoPath(absPath);
  const [videoThumb, setVideoThumb] = useState("");

  useEffect(() => {
    if (!absPath || !video || !isTauri()) {
      setVideoThumb("");
      return;
    }
    let alive = true;
    getVideoThumb(absPath)
      .then((dataUrl) => {
        if (alive) setVideoThumb(dataUrl);
      })
      .catch(() => {
        if (alive) setVideoThumb("");
      });
    return () => {
      alive = false;
    };
  }, [absPath, video]);

  if (!absPath || !isTauri()) return "";
  return video ? videoThumb : thumbUrl(absPath, size);
}
