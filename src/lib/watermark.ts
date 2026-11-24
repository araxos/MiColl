/** Event to open the watermark remover (WatermarkHost, mounted once per window). */
export const WATERMARK_EVENT = "micoll:watermark";

export interface WatermarkTarget {
  /** The reward, or a picture of it (the editor's). */
  rewardId?: number;
  imagePath?: string;
  /** Its name for the header. */
  label?: string;
}

/** Open the watermark remover for a reward (or the reward of a picture). */
export function openWatermark(target: WatermarkTarget) {
  window.dispatchEvent(new CustomEvent(WATERMARK_EVENT, { detail: target }));
}

/** The corners to search for a line of text. */
export const WM_CORNERS: { id: string; label: string }[] = [
  { id: "tl", label: "Top left" },
  { id: "tr", label: "Top right" },
  { id: "bl", label: "Bottom left" },
  { id: "bc", label: "Bottom middle" },
  { id: "br", label: "Bottom right" },
];

/** "corner" = a line of text in a corner, "mark" = a mark that's framed. */
export type WmMode = "corner" | "mark";

const CORNERS_KEY = "micoll.wmCorners";
const MODE_KEY = "micoll.wmMode";

export function savedWmMode(): WmMode {
  try {
    return localStorage.getItem(MODE_KEY) === "mark" ? "mark" : "corner";
  } catch {
    return "corner";
  }
}

export function saveWmMode(mode: WmMode) {
  try {
    localStorage.setItem(MODE_KEY, mode);
  } catch {
    /* only not remembered */
  }
}

export function savedWmCorners(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(CORNERS_KEY) ?? "null");
    if (Array.isArray(v) && v.length && v.every((c) => WM_CORNERS.some((k) => k.id === c))) return v;
  } catch {
    /* default */
  }
  return ["br"];
}

export function saveWmCorners(corners: string[]) {
  try {
    if (corners.length) localStorage.setItem(CORNERS_KEY, JSON.stringify(corners));
  } catch {
    /* only not remembered */
  }
}
