/** Sort options for the image viewer (same as the dashboard sort). */
export type ImgSortField = "name" | "edited" | "type" | "size" | "orientation";
export type SortDir = "asc" | "desc";

export const IMG_SORT_LABELS: Record<ImgSortField, string> = {
  name: "Name",
  edited: "Last edited",
  type: "Type",
  size: "Size",
  orientation: "Orientation",
};
export const IMG_SORT_FIELDS = Object.keys(IMG_SORT_LABELS) as ImgSortField[];

/** Short direction label next to the active field. */
export function dirLabel(field: ImgSortField, dir: SortDir): string {
  if (field === "edited") return dir === "asc" ? "Oldest" : "Newest";
  if (field === "size") return dir === "asc" ? "Smallest" : "Largest";
  if (field === "orientation") return dir === "asc" ? "Vertical 1st" : "Horizontal 1st";
  return dir === "asc" ? "A→Z" : "Z→A";
}

interface SortableItem {
  id: string;
  name?: string;
  title: string;
  path?: string;
  kind?: "image" | "video" | "archive";
  /** Subfolder group ("" = the reward folder itself). */
  group?: string;
}
interface Stat {
  size: number;
  modified: number;
  /** Image size (for orientation sort), missing until loaded. */
  w?: number;
  h?: number;
}

const nameOf = (it: SortableItem) => (it.name ?? it.title ?? "").trim();
const extOf = (it: SortableItem) => {
  const n = nameOf(it);
  const i = n.lastIndexOf(".");
  return i >= 0 ? n.slice(i + 1).toLowerCase() : "";
};
const byName = (a: SortableItem, b: SortableItem) =>
  nameOf(a).localeCompare(nameOf(b), undefined, { numeric: true, sensitivity: "base" });

/** Orientation: portrait first, then square, then landscape, unknown (videos) last. */
const orientRank = (s?: Stat) => {
  if (!s?.w || !s?.h) return 3; // unknown → last
  if (s.h > s.w) return 0; // vertical / portrait
  if (s.h < s.w) return 2; // horizontal / landscape
  return 1; // square
};

/** Return a sorted copy. Name uses natural sort (image1 ... image10), ties sort by name. */
export function sortViewerItems<T extends SortableItem>(
  items: T[],
  field: ImgSortField,
  dir: SortDir,
  stats: Record<string, Stat>,
): T[] {
  const mul = dir === "desc" ? -1 : 1;
  const statOf = (it: SortableItem) => (it.path ? stats[it.path] : undefined);
  return [...items].sort((a, b) => {
    let c = 0;
    switch (field) {
      case "name":
        c = byName(a, b);
        break;
      case "type":
        c = (a.kind ?? "").localeCompare(b.kind ?? "") || extOf(a).localeCompare(extOf(b));
        break;
      case "edited":
        c = (statOf(a)?.modified ?? 0) - (statOf(b)?.modified ?? 0);
        break;
      case "size":
        c = (statOf(a)?.size ?? 0) - (statOf(b)?.size ?? 0);
        break;
      case "orientation":
        c = orientRank(statOf(a)) - orientRank(statOf(b));
        break;
    }
    if (c === 0) c = byName(a, b);
    return c * mul;
  });
}

/**
 * Like sortViewerItems but keeps each subfolder together.
 * The reward's own files first, then each subfolder, sorted inside each group.
 * folderOrder: subfolder names the user put first, in that order (any case); the
 * others follow as they are. Only saved in MiColl, the folders stay as they are.
 */
export function sortViewerItemsGrouped<T extends SortableItem>(
  items: T[],
  field: ImgSortField,
  dir: SortDir,
  stats: Record<string, Stat>,
  folderOrder?: string[] | null,
): T[] {
  let order: string[] = [];
  const groups = new Map<string, T[]>();
  for (const it of items) {
    const g = it.group ?? "";
    let arr = groups.get(g);
    if (!arr) {
      arr = [];
      groups.set(g, arr);
      order.push(g);
    }
    arr.push(it);
  }
  if (folderOrder?.length && order.length > 1) {
    const want = folderOrder.map((f) => f.toLowerCase());
    // the reward's own files stay first
    const rank = (g: string) => {
      if (!g) return -1;
      const i = want.indexOf(g.toLowerCase());
      return i < 0 ? want.length : i;
    };
    order = order
      .map((g, i) => ({ g, i }))
      .sort((a, b) => rank(a.g) - rank(b.g) || a.i - b.i)
      .map((x) => x.g);
  }
  // only one group -> normal sort
  return order.flatMap((g) => sortViewerItems(groups.get(g) as T[], field, dir, stats));
}

/** Where a reward's / a creator's folder order is saved (MiColl's settings). */
export const folderOrderKey = (scope: "reward" | "artist", id: string) => `folder_order:${scope}:${id}`;

export function parseFolderOrder(raw: string | null | undefined): string[] | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) && v.every((x) => typeof x === "string") && v.length ? v : null;
  } catch {
    return null;
  }
}

/** Saved per reward (shared key if there's no reward id). */
function storageKey(rewardId?: string | null): string {
  return `micoll.imgSort:${rewardId ?? "default"}`;
}
export function loadImgSort(rewardId?: string | null): { field: ImgSortField; dir: SortDir } {
  try {
    const raw = localStorage.getItem(storageKey(rewardId));
    if (raw) {
      const v = JSON.parse(raw) as { field: ImgSortField; dir: SortDir };
      if (IMG_SORT_FIELDS.includes(v.field) && (v.dir === "asc" || v.dir === "desc")) return v;
    }
  } catch {
    /* ignore */
  }
  return { field: "name", dir: "asc" };
}
export function saveImgSort(rewardId: string | null | undefined, field: ImgSortField, dir: SortDir) {
  try {
    localStorage.setItem(storageKey(rewardId), JSON.stringify({ field, dir }));
  } catch {
    /* ignore */
  }
}
