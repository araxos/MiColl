/**
 * Decides when animations should pause (Settings -> Performance).
 * Kept in its own file with no imports so it's easy to test.
 */

/**
 * off = never pause, minimized = only when minimized,
 * unfocused = only when another window is in front, inactive = both (default).
 */
export type IdlePause = "off" | "minimized" | "unfocused" | "inactive";

/** Returns true if animations should be paused right now. */
export function pauseWanted(level: IdlePause, unfocused: boolean, minimized: boolean): boolean {
  switch (level) {
    case "off":
      return false;
    case "minimized":
      return minimized;
    // only when behind another window, not when minimized (that's the level above)
    case "unfocused":
      return unfocused && !minimized;
    case "inactive":
      return unfocused;
  }
}
