import { useThumb } from "@/hooks/useThumb";

/* The pictures on a Pyre collection card: a pane in a 190 x 64 box that broke into flame
   shaped pieces around one hot point. Up to five pictures; with fewer, neighbouring pieces
   are one. Styles: index.css .ruby-flames. */
const W = 190;
const H = 64;

type P = [number, number];
/** A start point, then cubic curves (two control points and the end). */
type Edge = [P, ...[P, P, P][]];

/** where three cuts meet on the left */
const FORK: P = [48, 37];
/** the hot point */
const HOT: P = [86, 31];

const EDGES: Record<string, Edge> = {
  // the outer edge on the left, bottom to top
  left: [
    [12, 62],
    [[8, 58], [10, 54], [7, 50]],
    [[3, 45], [3, 39], [2, 31]],
    [[5, 37], [9, 37], [10, 33]],
    [[12, 25], [5, 18], [9, 5]],
    [[11, 13], [17, 16], [20, 12]],
    [[23, 8], [24, 5], [28, 2]],
  ],
  // the cuts between the pieces, each with a tongue
  a: [FORK, [[46, 32], [34, 33], [29, 13]], [[34, 22], [41, 25], [45, 20]], [[49, 14], [48, 8], [54, 2]]],
  b: [
    FORK,
    [[45, 42], [41, 45], [35, 44]],
    [[26, 43], [19, 36], [19, 25]],
    [[15, 40], [19, 50], [27, 53]],
    [[25, 57], [21, 60], [17, 62]],
  ],
  c: [FORK, [[54, 41], [60, 37], [62, 30]], [[64, 22], [60, 16], [67, 5]], [[67, 15], [72, 21], [72, 27]], [[73, 33], [80, 35], HOT]],
  d: [HOT, [[87, 25], [80, 23], [79, 7]], [[84, 17], [91, 19], [95, 15]], [[98, 11], [97, 6], [102, 2]]],
  e: [HOT, [[90, 39], [97, 40], [101, 35]], [[107, 28], [105, 21], [117, 11]], [[113, 23], [115, 34], [107, 43]], [[101, 50], [102, 56], [108, 62]]],
  f: [
    [116, 62],
    [[120, 53], [133, 52], [135, 43]],
    [[137, 34], [128, 30], [128, 12]],
    [[133, 24], [141, 27], [146, 22]],
    [[151, 16], [149, 9], [158, 2]],
  ],
};

const pt = (p: P) => `${p[0]} ${p[1]}`;
/** An edge as path data, `lead` is M for a new path or L to go on. */
const fwd = (key: string, lead: "M" | "L" = "L") => {
  const [start, ...curves] = EDGES[key];
  return `${lead}${pt(start)} ${curves.map((c) => `C${c.map(pt).join(" ")}`).join(" ")} `;
};
/** The same edge walked backwards. */
const rev = (key: string, lead: "M" | "L" = "L") => {
  const [start, ...curves] = EDGES[key];
  const ends: P[] = [start, ...curves.map((c) => c[2])];
  const back = curves.map((c, i) => `C${pt(c[1])} ${pt(c[0])} ${pt(ends[i])}`).reverse();
  return `${lead}${pt(ends[ends.length - 1])} ${back.join(" ")} `;
};

const RIGHT = "L186 2 L186 62 ";
const OUTLINE = `${fwd("left", "M")}${RIGHT}Z`;

interface Piece {
  d: string;
  /** the picture's box: left, top, width, height */
  box: [number, number, number, number];
}
const PIECE: Record<string, Piece> = {
  all: { d: OUTLINE, box: [0, 0, 188, 64] },
  tail: { d: `${fwd("left", "M")}${rev("a")}${fwd("b")}Z`, box: [0, 0, 58, 64] },
  top: { d: `${fwd("a", "M")}${rev("d")}${rev("c")}Z`, box: [26, 0, 80, 44] },
  heart: { d: `${rev("b", "M")}${fwd("c")}${fwd("e")}Z`, box: [14, 2, 106, 62] },
  crest: { d: `${rev("e", "M")}${fwd("d")}${rev("f")}Z`, box: [76, 0, 86, 64] },
  end: { d: `${fwd("f", "M")}${RIGHT}Z`, box: [112, 0, 76, 64] },
  // merged ones for fewer pictures
  tailTop: { d: `${fwd("left", "M")}${rev("d")}${rev("c")}${fwd("b")}Z`, box: [0, 0, 106, 64] },
  crestEnd: { d: `${rev("e", "M")}${fwd("d")}${RIGHT}Z`, box: [76, 0, 112, 64] },
  front: { d: `${fwd("left", "M")}${rev("d")}${fwd("e")}Z`, box: [0, 0, 120, 64] },
};
/** Pieces and cuts per number of pictures. */
const LAYOUT: { pieces: string[]; cuts: string[] }[] = [
  { pieces: [], cuts: ["a", "b", "c", "d", "e", "f"] },
  { pieces: ["all"], cuts: [] },
  { pieces: ["front", "crestEnd"], cuts: ["d", "e"] },
  { pieces: ["tailTop", "heart", "crestEnd"], cuts: ["b", "c", "d", "e"] },
  { pieces: ["tail", "top", "heart", "crestEnd"], cuts: ["a", "b", "c", "d", "e"] },
  { pieces: ["tail", "top", "heart", "crest", "end"], cuts: ["a", "b", "c", "d", "e", "f"] },
];
/** fine flame lines over the pictures */
const LINES = [
  "M86 31 C76 27 73 22 74 14",
  "M86 31 C84 42 78 44 78 54",
  "M86 31 C98 27 100 20 106 11",
  "M48 37 C53 45 49 50 54 57",
  "M162 62 C158 50 168 42 163 28 C161 21 164 16 167 11",
  "M176 62 C173 54 178 48 175 40",
].join("");

export function PyreFlames({ paths }: { paths: string[] }) {
  const { pieces, cuts } = LAYOUT[Math.min(paths.length, LAYOUT.length - 1)];
  const cut = cuts.map((k) => fwd(k, "M")).join("");
  return (
    <span aria-hidden className="ruby-flames" style={{ width: W, height: H }}>
      {pieces.map((key, i) => (
        <FlamePiece key={paths[i]} path={paths[i]} piece={PIECE[key]} />
      ))}
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="absolute inset-0">
        {paths.length === 0 && <path d={OUTLINE} fill="rgba(255,20,100,0.1)" />}
        {/* a cut is a hot gap with a white rim on both sides; it ends at the outline */}
        <g fill="none" strokeMiterlimit={12} style={{ clipPath: `path("${OUTLINE}")` }}>
          <path d={cut} stroke="#ffe3ee" strokeWidth={4.2} />
          <path d={cut} className="ruby-flames-gap" strokeWidth={2.4} />
        </g>
        {paths.length > 0 && (
          <path d={LINES} fill="none" stroke="#fff" strokeWidth={0.7} strokeLinecap="round" opacity={0.8} />
        )}
        <path d={OUTLINE} fill="none" stroke="#ffe3ee" strokeWidth={1.2} strokeLinejoin="round" />
        {paths.length > 1 && <circle cx={HOT[0]} cy={HOT[1]} r={2.2} className="ruby-flames-hot" />}
      </svg>
    </span>
  );
}

/** One picture, cut to its piece. Own component because it uses a hook per piece. */
function FlamePiece({ path, piece }: { path: string; piece: Piece }) {
  const [x, y, w, h] = piece.box;
  const src = useThumb(path, w > 80 ? 320 : 160);
  return (
    <span className="absolute inset-0 bg-[#1a040d]" style={{ clipPath: `path("${piece.d}")` }}>
      {src && (
        <img
          src={src}
          alt=""
          decoding="async"
          className="absolute max-w-none object-cover object-[50%_25%]"
          style={{ left: x, top: y, width: w, height: h }}
        />
      )}
    </span>
  );
}
