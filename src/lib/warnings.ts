/**
 * "Don't show again" prompts. Some are saved in localStorage, some in backend settings.
 * Settings -> "Reset warnings" calls resetAllWarnings so they all show again.
 * When you add a new prompt with "remember my choice", add its key here too!
 */
import { setSetting } from "@/api/library";

/** NeedsReviewBanner "don't ask again" key (the X alone only hides it for this session). */
export const NEEDS_REVIEW_DISMISSED = "micoll.needsReviewDismissed";

/** localStorage keys that hide a warning. Removed on reset. */
const WARNING_LS_KEYS = [
  "micoll.quickImportWarned", // ImportReview: quick-import warning
  NEEDS_REVIEW_DISMISSED, // home banner: periods with no platform
];

/**
 * Backend settings that hide a prompt -> value that makes it ask again.
 * Also reset saved answers to the safe default (never keep e.g. delete "disk").
 */
const WARNING_SETTINGS: Record<string, string> = {
  managed_move_ask: "true", // actions.tsx: managed-library move notice ("false" hides it)
  merge_keep_folder: "ask", // RewardGrid: merge keep-folder vs. files ("true"/"false" remembers it)
  delete_ask: "true", // actions.tsx: delete confirm dialog ("false" hides it)
  delete_mode: "micoll", // …and its remembered answer — back to MiColl-only, never "disk"
};

/** Fired after a reset, so components with a session-only "hidden" flag clear it too. */
export const WARNINGS_RESET_EVENT = "micoll:warnings-reset";

/** Show all "don't show again" prompts again. */
export async function resetAllWarnings(): Promise<void> {
  for (const k of WARNING_LS_KEYS) localStorage.removeItem(k);
  for (const [key, value] of Object.entries(WARNING_SETTINGS)) {
    try {
      await setSetting(key, value);
    } catch {
      // browser mode, no backend
    }
  }
  window.dispatchEvent(new Event(WARNINGS_RESET_EVENT));
}
