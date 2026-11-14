import { useEffect, useId, useRef } from "react";

/**
 * Drop files from Explorer onto a box instead of browsing for them. A box spreads the
 * props from useFileDrop; DropZone sees the data-drop-file attribute under the mouse,
 * highlights it and hands it the dropped paths (filtered by `accept`).
 */
export const FILE_DROP_EVENT = "micoll:file-drop";
export interface FileDropDetail {
  key: string;
  paths: string[];
}

/** image = pictures, zip = .zip, json = .json, any = files and folders (the box checks). */
export type FileAccept = "image" | "zip" | "json" | "any";

const IMAGE_RE = /\.(png|jpe?g|webp|gif|bmp|avif)$/i;
export const acceptsPath = (accept: string | undefined, p: string): boolean =>
  accept === "image"
    ? IMAGE_RE.test(p)
    : accept === "zip"
      ? /\.zip$/i.test(p)
      : accept === "json"
        ? /\.json$/i.test(p)
        : true;

export function useFileDrop(
  accept: FileAccept,
  /** Shown over the box while dragging, e.g. "Add as alt". */
  label: string,
  onFiles: (paths: string[]) => void,
  opts: { multiple?: boolean; enabled?: boolean } = {},
): Record<string, string> {
  const key = useId();
  const cb = useRef(onFiles);
  cb.current = onFiles;
  const enabled = opts.enabled ?? true;
  useEffect(() => {
    if (!enabled) return;
    const on = (e: Event) => {
      const d = (e as CustomEvent<FileDropDetail>).detail;
      if (d.key === key) cb.current(d.paths);
    };
    window.addEventListener(FILE_DROP_EVENT, on);
    return () => window.removeEventListener(FILE_DROP_EVENT, on);
  }, [key, enabled]);
  if (!enabled) return {};
  return {
    "data-drop-file": key,
    "data-drop-file-accept": accept,
    "data-drop-file-label": label,
    ...(opts.multiple ? { "data-drop-file-multi": "" } : {}),
  };
}
