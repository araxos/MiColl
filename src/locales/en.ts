/**
 * English (English) — plural forms only.
 *
 * Every other string falls through to the key, which *is* the English (see
 * lib/i18n.ts). Counted strings can't: `"{n} months"` is wrong for one month and
 * `"{n} month"` is wrong for the rest, so English needs the same `#one` / `#other`
 * split every other language gets. Nothing but plurals belongs in this file — an
 * ordinary entry here would silently shadow the key it duplicates.
 */

import type { Dict } from "./index";

export const dict: Dict = {
  "{n} months#one": "{n} month",
  "{n} months#other": "{n} months",
  "{n} rewards#one": "{n} reward",
  "{n} rewards#other": "{n} rewards",
  "{n} more#one": "{n} more",
  "{n} more#other": "{n} more",
  "{n} files#one": "{n} file",
  "{n} files#other": "{n} files",
  "Re-linked {n} files#one": "Re-linked {n} file",
  "Re-linked {n} files#other": "Re-linked {n} files",
  "Pruned {n} missing entries#one": "Pruned {n} missing entry",
  "Pruned {n} missing entries#other": "Pruned {n} missing entries",
  "Removed {n} broken collab links#one": "Removed {n} broken collab link",
  "Removed {n} broken collab links#other": "Removed {n} broken collab links",
  "{n} collab links point at a folder that no longer exists — most likely renamed or moved outside MiColl.#one": "{n} collab link points at a folder that no longer exists — most likely renamed or moved outside MiColl.",
  "{n} collab links point at a folder that no longer exists — most likely renamed or moved outside MiColl.#other": "{n} collab links point at a folder that no longer exists — most likely renamed or moved outside MiColl.",
  "{n} MiSD backup folders no longer belong to a reward — kept on purpose when the reward was deleted here.#one": "{n} MiSD backup folder no longer belongs to a reward — kept on purpose when the reward was deleted here.",
  "{n} MiSD backup folders no longer belong to a reward — kept on purpose when the reward was deleted here.#other": "{n} MiSD backup folders no longer belong to a reward — kept on purpose when the reward was deleted here.",
  "{n} snapshots#one": "{n} snapshot",
  "{n} snapshots#other": "{n} snapshots",
  "{n} platforms#one": "{n} platform",
  "{n} platforms#other": "{n} platforms",
  "{n} periods#one": "{n} period",
  "{n} periods#other": "{n} periods",
  "{n} links#one": "{n} link",
  "{n} links#other": "{n} links",
  "{n} inline cover images#one": "{n} inline cover image",
  "{n} inline cover images#other": "{n} inline cover images",
  "{n} creators#one": "{n} creator",
  "{n} creators#other": "{n} creators",
  "{n} images#one": "{n} image",
  "{n} images#other": "{n} images",
  "{n} more creators#one": "{n} more creator",
  "{n} more creators#other": "{n} more creators",
  "{n} more files#one": "{n} more file",
  "{n} more files#other": "{n} more files",
  "{n} minutes#one": "{n} minute",
  "{n} minutes#other": "{n} minutes",
  "{n} photos#one": "{n} photo",
  "{n} photos#other": "{n} photos",
  "{n} stars#one": "{n} star",
  "{n} stars#other": "{n} stars",
};
