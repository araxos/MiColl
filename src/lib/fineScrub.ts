/**
 * Fine seeking (from the phone): while the seek bar is held, the further the mouse goes up
 * from where it started, the slower a move to the side changes the time. A speed change
 * starts from where it is now, so nothing jumps.
 */

/** how much a move to the side counts, by how far the mouse is above its start (px) */
export function scrubSpeed(up: number): number {
  if (up < 40) return 1;
  if (up < 100) return 0.5;
  if (up < 170) return 0.25;
  return 0.1;
}

/** the hint while it's slower (an English key for t()), "" at full speed */
export function scrubLabel(speed: number): string {
  if (speed >= 1) return "";
  if (speed >= 0.5) return "Half speed";
  if (speed >= 0.25) return "Quarter speed";
  return "Fine seeking";
}

export interface Scrub {
  /** where the mouse went down (y) */
  y0: number;
  /** x and value the current speed counts from */
  ax: number;
  av: number;
  speed: number;
  lastX: number;
  lastV: number;
}

export const startScrub = (x: number, y: number, value: number): Scrub => ({
  y0: y,
  ax: x,
  av: value,
  speed: 1,
  lastX: x,
  lastV: value,
});

/** the value for the mouse at x / y. perPx = how much 1 px to the side is at full speed */
export function moveScrub(s: Scrub, x: number, y: number, perPx: number, min: number, max: number): number {
  const sp = scrubSpeed(s.y0 - y);
  if (sp !== s.speed) {
    s.ax = s.lastX;
    s.av = s.lastV;
    s.speed = sp;
  }
  const v = Math.min(max, Math.max(min, s.av + (x - s.ax) * perPx * sp));
  s.lastX = x;
  s.lastV = v;
  return v;
}

/** m:ss or h:mm:ss */
export const clock = (t: number) => {
  const n = Math.max(0, Math.floor(t || 0));
  const h = Math.floor(n / 3600);
  const m = Math.floor((n % 3600) / 60);
  const sec = String(n % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
};

/** time with tenths (m:ss.t), for picking the exact second */
export const fineClock = (t: number) => {
  // rounded to tenths first, so 9.98 is 0:10.0 and not 0:010.0
  const n = Math.round(Math.max(0, t || 0) * 10);
  const m = Math.floor(n / 600);
  const s = (n - m * 600) / 10;
  return `${m}:${s < 10 ? "0" : ""}${s.toFixed(1)}`;
};
