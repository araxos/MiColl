/**
 * Image order for a reward in the viewer/filmstrip.
 * Files directly in the folder first, then each subfolder (A-Z), natural name order inside.
 * The reward folder is the longest common path of all images, each image's group is
 * its first folder below that ("" = directly in the reward folder).
 */

type ImgLike = { path?: string | null; name?: string | null };

const norm = (s: string) => s.replace(/\\/g, "/").replace(/\/+$/, "");
const dirOf = (p: string) => {
  const n = norm(p);
  const i = n.lastIndexOf("/");
  return i >= 0 ? n.slice(0, i) : "";
};
const baseName = (s: string | null | undefined) => {
  const n = norm(s ?? "");
  return n.split("/").pop() || n;
};

/** Longest common path prefix of the folders. */
function commonDir(dirs: string[]): string {
  if (dirs.length === 0) return "";
  const split = dirs.map((d) => d.split("/"));
  const first = split[0];
  let n = first.length;
  for (const s of split) {
    let i = 0;
    while (i < n && i < s.length && s[i].toLowerCase() === first[i].toLowerCase()) i++;
    n = i;
  }
  return first.slice(0, n).join("/");
}

/** Sorted images with their subfolder ("" = reward folder). Doesn't change the input. */
export function buildFolderOrder<T extends ImgLike>(images: T[]): { image: T; group: string }[] {
  const base = commonDir(images.filter((im) => im.path).map((im) => dirOf(im.path as string)));
  const groupOf = (im: T): string => {
    if (im.path) {
      const dir = dirOf(im.path);
      if (base && dir.toLowerCase().startsWith(base.toLowerCase() + "/")) {
        return dir.slice(base.length + 1).split("/")[0];
      }
      if (dir.toLowerCase() === base.toLowerCase()) return "";
    }
    // fallback to the relative name's folder (browser mock or weird paths)
    const d = dirOf(im.name ?? "");
    return d ? d.split("/")[0] : "";
  };
  return images
    .map((image) => ({ image, group: groupOf(image) }))
    .sort((a, b) => {
      if (a.group !== b.group) {
        if (!a.group) return -1; // reward-folder files before any subfolder
        if (!b.group) return 1;
        return a.group.localeCompare(b.group, undefined, { numeric: true, sensitivity: "base" });
      }
      return baseName(a.image.path ?? a.image.name).localeCompare(
        baseName(b.image.path ?? b.image.name),
        undefined,
        { numeric: true, sensitivity: "base" },
      );
    });
}
