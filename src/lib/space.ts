/**
 * The backend refuses a big copy onto a drive that's too full with one fixed sentence
 * (src-tauri/src/space.rs), sometimes with a reward's name in front. This shows it in the
 * user's language, any other text stays as it is.
 */
const TOO_FULL = /Not enough space on (.+?) \(([\d.]+ [GM]B) needed, ([\d.]+ [GM]B) free\)/g;

export function spaceText(
  text: string,
  tf: (text: string, vars: Record<string, string | number>) => string,
): string {
  return text.replace(TOO_FULL, (_all, disk: string, need: string, free: string) =>
    tf("Not enough space on {disk} ({need} needed, {free} free)", { disk, need, free }),
  );
}
