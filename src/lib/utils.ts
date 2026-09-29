import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** Merge Tailwind classes (removes conflicts). */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Make a gradient from a string (always the same for the same string).
 * Used when there's no preview image.
 */
export function seedGradient(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash << 5) - hash + seed.charCodeAt(i);
    hash |= 0;
  }
  const h1 = Math.abs(hash) % 360;
  const h2 = (h1 + 40 + (Math.abs(hash >> 8) % 80)) % 360;
  return `linear-gradient(135deg, hsl(${h1} 70% 45%), hsl(${h2} 65% 30%))`;
}

/** Longest common folder of some paths. */
export function commonDir(paths: (string | undefined)[]): string | undefined {
  const valid = paths.filter((p): p is string => !!p);
  if (valid.length === 0) return undefined;
  const split = (p: string) => p.split(/[\\/]/);
  let prefix = split(valid[0]);
  for (const p of valid.slice(1)) {
    const parts = split(p);
    let i = 0;
    while (i < prefix.length && i < parts.length && prefix[i] === parts[i]) i++;
    prefix = prefix.slice(0, i);
  }
  return prefix.length ? prefix.join("\\") : undefined;
}

/** Initials for a name placeholder. */
export function initials(name: string): string {
  const parts = name.trim().split(/[\s_-]+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}
