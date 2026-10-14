/**
 * The setting collection_root is the folder that HOLDS the collection: files live in
 * <root>\MiColl. The UI shows that real folder, and picking a folder that is already
 * called MiColl uses it directly instead of nesting a second MiColl inside it.
 */

/** The folder the files actually live in. */
export function collectionDir(root: string): string {
  return root ? `${root.replace(/[\\/]+$/, "")}\\MiColl` : "";
}

/** Turn a picked folder into the root to save (its parent when it's named MiColl). */
export function rootFromPicked(picked: string): string {
  const p = picked.replace(/[\\/]+$/, "");
  const i = Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/"));
  if (i > 0 && p.slice(i + 1).toLowerCase() === "micoll") {
    const parent = p.slice(0, i);
    // a drive root needs its backslash back ("E:" -> "E:\")
    return /^[A-Za-z]:$/.test(parent) ? `${parent}\\` : parent;
  }
  return picked;
}
