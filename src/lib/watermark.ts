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
