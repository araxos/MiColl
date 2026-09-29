import { SAKURA_PETAL_D, SAKURA_PETAL_ROTATIONS } from "@/lib/classIcons";
import { cn } from "@/lib/utils";

/**
 * A year's completion as a cherry tree (sakura only): bare at 0%, fully blooming at 100%.
 * Replaces the % number, the bar stays next to it and the number is in the tooltip.
 */

/** The branches in a 56x56 box. Every blossom sits on one of them. */
const BRANCHES: { d: string; w: number }[] = [
  { d: "M28 53 C 28.5 46 27.5 41 28 35", w: 2.8 }, // trunk
  { d: "M28 36 C 23 34 19 31 15 27", w: 2 }, //       left limb
  { d: "M28 37 C 33 35 37 32 41 28", w: 2 }, //       right limb
  { d: "M28 35 C 27 30 27 25 27 21", w: 1.9 }, //     leader
  { d: "M15 27 C 12 26 9 25 6 24", w: 1.3 }, //       left limb, outward
  { d: "M20 31 C 19 27 18 23 17 19", w: 1.3 }, //     left limb, upward
  { d: "M41 28 C 44 27 47 26 50 25", w: 1.3 }, //     right limb, outward
  { d: "M36 32 C 37 28 38 24 39 20", w: 1.3 }, //     right limb, upward
  { d: "M27 22 C 25 19 23 17 21 15", w: 1.2 }, //     crown left
  { d: "M27 22 C 29 19 31 17 33 15", w: 1.2 }, //     crown right
  { d: "M27 22 C 27 18 27 15 27 12", w: 1.2 }, //     crown top
];

/**
 * Blossom spots from the trunk outwards, alternating sides, so the tree fills evenly.
 * The last 7 are the branch tips.
 */
const BLOOMS: [number, number][] = [
  [28, 33],
  [23, 34],
  [33, 34],
  [27, 28],
  [19, 31],
  [37, 31],
  [18, 24],
  [38, 25],
  [11, 26],
  [45, 26],
  [27, 22],
  [24, 18],
  [30, 18],
  [17, 19],
  [39, 20],
  [6, 24],
  [50, 25],
  [21, 15],
  [33, 15],
  [27, 12],
];

/** Blossom is drawn in 24 units, this scales it to ~6. */
const BLOOM_SCALE = 0.32;

export function SakuraTree({
  pct,
  className,
  label,
}: {
  /** 0...1 */
  pct: number;
  className?: string;
  label: string;
}) {
  // exact at 0% and 100%, rounded in between (but never up to a full tree)
  const open =
    pct <= 0
      ? 0
      : pct >= 1
        ? BLOOMS.length
        : Math.min(BLOOMS.length - 1, Math.max(1, Math.round(pct * BLOOMS.length)));

  return (
    <svg
      viewBox="0 0 56 56"
      className={cn("sak-tree", className)}
      role="img"
      aria-label={label}
      xmlns="http://www.w3.org/2000/svg"
    >
      <title>{label}</title>
      <g className="sak-tree-branch" fill="none" strokeLinecap="round" strokeLinejoin="round">
        {BRANCHES.map((b) => (
          <path key={b.d} d={b.d} strokeWidth={b.w} />
        ))}
      </g>
      <g className="sak-tree-blooms">
        {BLOOMS.slice(0, open).map(([x, y]) => (
          <g
            key={`${x},${y}`}
            className="sak-tree-bloom"
            transform={`translate(${x} ${y}) scale(${BLOOM_SCALE}) translate(-12 -12)`}
          >
            {SAKURA_PETAL_ROTATIONS.map((r) => (
              <path key={r} transform={`rotate(${r} 12 12)`} d={SAKURA_PETAL_D} />
            ))}
          </g>
        ))}
      </g>
    </svg>
  );
}
