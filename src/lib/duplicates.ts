/** Event to open the duplicate finder (mounted once in App). */
export const DUPLICATES_EVENT = "micoll:duplicates";

export interface DuplicateScope {
  /** Label for the header (artist or month name). */
  label?: string;
  /** Only scan this artist. */
  artistId?: number;
  /** With artistId: only this platform ("Unsorted" = no platform). */
  platform?: string;
  /** Only scan this month. */
  periodId?: number;
  /** Only scan this reward folder. */
  rewardId?: number;
}

/** Open the duplicate finder, optionally for one folder. */
export function openDuplicates(scope?: DuplicateScope) {
  window.dispatchEvent(new CustomEvent(DUPLICATES_EVENT, { detail: scope ?? {} }));
}
