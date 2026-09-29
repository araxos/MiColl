/**
 * One clock for endless header animations (mainly the logo).
 * Each page mounts a new header, so CSS animations would restart at 0% on every
 * click. A negative animation-delay based on the app start time lets them
 * continue where they were.
 */

/** When the animations started (lives as long as the app). */
const EPOCH = Date.now();

/** The animation-delay to continue a periodMs loop in phase. Read it at render time. */
export const markPhase = (periodMs: number): string =>
  `-${(Date.now() - EPOCH) % periodMs}ms`;
