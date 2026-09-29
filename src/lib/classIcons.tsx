import { useId, type SVGProps } from "react";

/**
 * Hand drawn class icons. One sharp set for the basic accents and one set per
 * premium theme. They work like lucide icons: outline by default, solid with
 * fill="currentColor" (except sakura, which always stays outlined).
 */

export type ClassIcon = (props: SVGProps<SVGSVGElement>) => React.JSX.Element;

const ROT5 = [0, 72, 144, 216, 288];

function Svg(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width={24}
      height={24}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      {...props}
    />
  );
}

/* ---- Sharp set (basic accents) ---------------------------------------- */

/** Low-poly heart. */
export const SharpHeartIcon: ClassIcon = (props) => (
  <Svg {...props}>
    <path d="M12 21 L3.5 11.5 L3.5 6.8 L7.8 3.8 L12 7.3 L16.2 3.8 L20.5 6.8 L20.5 11.5 Z" />
  </Svg>
);

/** Spiky 5-point star. */
export const SharpStarIcon: ClassIcon = (props) => (
  <Svg {...props}>
    <path d="M12 1 L14.65 8.36 L22.46 8.6 L16.28 13.39 L18.47 20.9 L12 16.5 L5.53 20.9 L7.72 13.39 L1.54 8.6 L9.35 8.36 Z" />
  </Svg>
);

/** Sharp almond eye with a round iris (cut out) and a pupil dot. */
export const SharpEyeIcon: ClassIcon = (props) => (
  <Svg {...props}>
    <path
      fillRule="evenodd"
      d="M2 12 L8 7 L16 7 L22 12 L16 17 L8 17 Z M12 8.5 A3.5 3.5 0 1 0 12 15.5 A3.5 3.5 0 1 0 12 8.5 Z"
    />
    <circle cx="12" cy="12" r="1.4" />
  </Svg>
);

/* ---- Sakura set (premium skin) ----------------------------------------- */

/* These get drawn filled on top of covers too, so the inside details are cut out
   of the path (fillRule="evenodd"), otherwise they'd just be blobs. */

/**
 * One petal (with the V-notch) and its 5 rotations for the flower.
 * Exported so the tree and the card frame use the same blossom.
 */
export const SAKURA_PETAL_D =
  "M12 11.6 C 9.6 10.8, 8.1 8.9, 8.1 6.8 C 8.1 5.0, 9.2 3.5, 10.5 2.7 L 12 4.6 L 13.5 2.7 C 14.8 3.5, 15.9 5.0, 15.9 6.8 C 15.9 8.9, 14.4 10.8, 12 11.6 Z";
export const SAKURA_PETAL_ROTATIONS = ROT5;

/** Sakura blossom: 5 petals around a center (star class). */
export const SakuraBlossomIcon: ClassIcon = (props) => (
  <Svg strokeWidth={1.2} {...props}>
    {ROT5.map((r) => (
      <path key={r} transform={`rotate(${r} 12 12)`} d={SAKURA_PETAL_D} />
    ))}
    {/* filled center dot */}
    <circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none" />
  </Svg>
);

/** Heart with a notch and a small cut-out facet (heart class). */
export const PetalGemIcon: ClassIcon = (props) => (
  <Svg {...props}>
    <path
      fillRule="evenodd"
      d="M12 21.2 C 9.4 19, 3 14.4, 3 9.2 C 3 6.2, 5.2 4, 8.1 4 C 9.8 4, 11.1 4.9, 12 6.1 L 12 6.1 C 12.9 4.9, 14.2 4, 15.9 4 C 18.8 4, 21 6.2, 21 9.2 C 21 14.4, 14.6 19, 12 21.2 Z M6.3 8.9 C 6.3 7.4, 7.3 6.3, 8.7 6.1 C 7.9 7, 7.4 8, 7.3 9.3 C 6.9 9.4, 6.5 9.2, 6.3 8.9 Z"
    />
  </Svg>
);

/** Diamond seen from the front, table facet cut out (diamond class). */
export const GemDiamondIcon: ClassIcon = (props) => (
  <Svg {...props}>
    <path
      fillRule="evenodd"
      d="M7.6 3.8 L16.4 3.8 L20.4 9.4 L12 21.2 L3.6 9.4 Z M9.5 5.7 L14.5 5.7 L16 8.9 L8 8.9 Z"
    />
    {/* girdle line + the two facets below it */}
    <path d="M4.6 9.4 L19.4 9.4 M8 8.9 L12 21.2 M16 8.9 L12 21.2" strokeWidth={1.1} />
  </Svg>
);

/** Almond eye with iris, pupil and one lash (eye class). */
export const MinimalEyeIcon: ClassIcon = (props) => (
  <Svg strokeWidth={1.5} {...props}>
    <path
      fillRule="evenodd"
      d="M12 6.6 C 15.7 6.6, 19.1 8.7, 21.9 12.5 C 19.1 16.3, 15.7 18.4, 12 18.4 C 8.3 18.4, 4.9 16.3, 2.1 12.5 C 4.9 8.7, 8.3 6.6, 12 6.6 Z M12 9.3 A3.2 3.2 0 1 0 12 15.7 A3.2 3.2 0 1 0 12 9.3 Z"
    />
    <circle cx="12" cy="12.5" r="1.3" fill="currentColor" stroke="none" />
    {/* the lash */}
    <path d="M18.6 8.4 C 19.9 7.1, 21.1 6.2, 22.2 5.7 C 21.7 6.9, 20.9 8.1, 19.8 9.2 Z" />
  </Svg>
);

/** Closed bud on a stem with one leaf (new class) - a flower that hasn't opened yet. */
export const SakuraBudIcon: ClassIcon = (props) => (
  <Svg strokeWidth={1.5} {...props}>
    <path
      fillRule="evenodd"
      d="M12 2.4 C 15.4 5.7, 17 8.6, 16.3 11.3 C 15.7 13.6, 14 14.9, 12 14.9 C 10 14.9, 8.3 13.6, 7.7 11.3 C 7 8.6, 8.6 5.7, 12 2.4 Z M11.3 6.3 C 10.2 8.4, 9.8 10.4, 10.2 12.4 C 10.9 10.4, 11.5 8.5, 12.4 6.9 Z"
    />
    <path d="M12 14.9 L 12 21.5" />
    {/* leaf on one side only */}
    <path d="M12.2 18.6 C 13.5 16.6, 15.8 15.7, 18.4 16 C 17.9 18.5, 16 20, 13.3 19.9 Z" />
  </Svg>
);

/* ---- Cyberpunk set (premium skin, Edgerunners style) ------------------- */

/* Pixel art icons. They use their own colors (yellow with a cyan/red fringe)
   and ignore currentColor and any fill/stroke passed in. */
const CP_YELLOW = "#FCEE0A";
const CP_CYAN = "#00F0FF";
const CP_RED = "#FF003C";

/** One pixel run on the 24 grid: [x, y, width, height]. */
type Px = readonly [number, number, number, number];

/**
 * Draws the pixels 3 times: cyan and red slightly shifted (screen blend) and yellow
 * on top, like a bad CRT. glint = extra highlight layer.
 * crispEdges keeps the pixels sharp.
 */
function CyberPixels({
  px,
  glint,
  ...props
}: { px: readonly Px[]; glint?: readonly Px[] } & SVGProps<SVGSVGElement>) {
  const layer = (fill: string, cells: readonly Px[]) =>
    cells.map(([x, y, w, h], i) => (
      <rect key={i} x={x} y={y} width={w} height={h} fill={fill} />
    ));
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width={24}
      height={24}
      shapeRendering="crispEdges"
      {...props}
      // after the spread on purpose so our colors win over fill="currentColor"
      fill="none"
      stroke="none"
    >
      <g style={{ mixBlendMode: "screen" }} transform="translate(-0.9 0.7)">
        {layer(CP_CYAN, px)}
      </g>
      <g style={{ mixBlendMode: "screen" }} transform="translate(0.9 -0.7)">
        {layer(CP_RED, px)}
      </g>
      <g>{layer(CP_YELLOW, px)}</g>
      {glint && <g>{layer("#FFFFFF", glint)}</g>}
    </svg>
  );
}

/** Pixel heart with a glint (heart class). */
const CP_HEART: readonly Px[] = [
  [5.75, 4.5, 3.75, 1.25], [14.5, 4.5, 3.75, 1.25],
  [3.25, 5.75, 7.5, 1.25], [13.25, 5.75, 7.5, 1.25],
  [2, 7, 20, 1.25], [2, 8.25, 20, 1.25], [2, 9.5, 20, 1.25], [2, 10.75, 20, 1.25],
  [3.25, 12, 17.5, 1.25], [4.5, 13.25, 15, 1.25], [5.75, 14.5, 12.5, 1.25],
  [7, 15.75, 10, 1.25], [8.25, 17, 7.5, 1.25], [9.5, 18.25, 5, 1.25],
  [10.75, 19.5, 2.5, 1.25],
];
const CP_HEART_GLINT: readonly Px[] = [
  [4.5, 7, 2.5, 1.25], [4.5, 8.25, 2.5, 1.25], [4.5, 9.5, 1.25, 1.25],
];
export const CyberHeartIcon: ClassIcon = (props) => (
  <CyberPixels px={CP_HEART} glint={CP_HEART_GLINT} {...props} />
);

/** Tall 4-point sparkle (star class). */
const CP_STAR: readonly Px[] = [
  [10.75, 2, 2.5, 1.25], [10.75, 3.25, 2.5, 1.25], [10.75, 4.5, 2.5, 1.25],
  [9.5, 5.75, 5, 1.25], [9.5, 7, 5, 1.25], [8.25, 8.25, 7.5, 1.25],
  [7, 9.5, 10, 1.25], [2, 10.75, 20, 1.25], [2, 12, 20, 1.25],
  [7, 13.25, 10, 1.25], [8.25, 14.5, 7.5, 1.25], [9.5, 15.75, 5, 1.25],
  [9.5, 17, 5, 1.25], [10.75, 18.25, 2.5, 1.25], [10.75, 19.5, 2.5, 1.25],
  [10.75, 20.75, 2.5, 1.25],
];
export const CyberStarIcon: ClassIcon = (props) => <CyberPixels px={CP_STAR} {...props} />;

/** Faceted gem (diamond class). */
const CP_DIAMOND: readonly Px[] = [
  [19.5, 2, 1.25, 1.25], [18.25, 3.25, 3.75, 1.25],
  [8.25, 4.5, 7.5, 1.25], [19.5, 4.5, 1.25, 1.25],
  [5.75, 5.75, 12.5, 1.25],
  [3.25, 7, 3.75, 1.25], [8.25, 7, 7.5, 1.25], [17, 7, 3.75, 1.25],
  [2, 8.25, 20, 1.25],
  [3.25, 9.5, 5, 1.25], [9.5, 9.5, 5, 1.25], [15.75, 9.5, 5, 1.25],
  [4.5, 10.75, 3.75, 1.25], [9.5, 10.75, 5, 1.25], [15.75, 10.75, 3.75, 1.25],
  [5.75, 12, 3.75, 1.25], [10.75, 12, 2.5, 1.25], [14.5, 12, 3.75, 1.25],
  [7, 13.25, 2.5, 1.25], [10.75, 13.25, 2.5, 1.25], [14.5, 13.25, 2.5, 1.25],
  [8.25, 14.5, 7.5, 1.25], [9.5, 15.75, 5, 1.25], [10.75, 17, 2.5, 1.25],
];
export const CyberDiamondIcon: ClassIcon = (props) => <CyberPixels px={CP_DIAMOND} {...props} />;

/** Wide eye with a square pupil (eye class). */
const CP_EYE: readonly Px[] = [
  [9.5, 7, 5, 1.25],
  [7, 8.25, 2.5, 1.25], [14.5, 8.25, 2.5, 1.25],
  [4.5, 9.5, 2.5, 1.25], [17, 9.5, 2.5, 1.25],
  [3.25, 10.75, 2.5, 1.25], [9.5, 10.75, 5, 1.25], [18.25, 10.75, 2.5, 1.25],
  [2, 12, 2.5, 1.25], [9.5, 12, 5, 1.25], [19.5, 12, 2.5, 1.25],
  [3.25, 13.25, 2.5, 1.25], [9.5, 13.25, 5, 1.25], [18.25, 13.25, 2.5, 1.25],
  [4.5, 14.5, 2.5, 1.25], [17, 14.5, 2.5, 1.25],
  [7, 15.75, 2.5, 1.25], [14.5, 15.75, 2.5, 1.25],
  [9.5, 17, 5, 1.25],
];
export const CyberEyeIcon: ClassIcon = (props) => <CyberPixels px={CP_EYE} {...props} />;

/** Twinkle with a spark (new class). Uses a 2-unit grid. */
const CP_NEW: readonly Px[] = [
  [8, 2, 2, 2], [8, 4, 2, 2], [6, 6, 6, 2], [2, 8, 14, 2], [6, 10, 6, 2],
  [8, 12, 2, 2], [8, 14, 2, 2],
  [18, 16, 2, 2], [16, 18, 6, 2], [18, 20, 2, 2],
];
export const CyberSparkIcon: ClassIcon = (props) => <CyberPixels px={CP_NEW} {...props} />;

/** Home button house with a glitch slice (cyberpunk header). */
export const CyberHomeIcon: ClassIcon = (props) => (
  <Svg {...props}>
    <path d="M11 3 L20 10.5 L20 11 L2 11 L2 10.5 Z" />
    <path d="M4 12 L22 12 L22 21 L15.5 21 L15.5 15 L10.5 15 L10.5 21 L4 21 Z" />
  </Svg>
);

/* ---- Iridescent set (premium skin, holographic-jewel style) ------------ */
/* Flat faceted icons with one holographic gradient (no outline).
   They ignore the text color. Each one gets its own gradient id (useId)
   so copies don't steal each other's fill. */

/** Gradient used by all iridescent icons. */
function IriGrad({ id }: { id: string }) {
  return (
    <linearGradient id={id} x1="1" y1="1" x2="23" y2="23" gradientUnits="userSpaceOnUse">
      <stop offset="0" stopColor="#9CCBF0" />
      <stop offset="0.45" stopColor="#B5B0E8" />
      <stop offset="1" stopColor="#A9EDD9" />
    </linearGradient>
  );
}

/** Plain svg wrapper for the gradient icons. */
function IriSvg(props: SVGProps<SVGSVGElement>) {
  return <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width={24} height={24} {...props} />;
}

/** Crystal heart (heart class). */
export const IriHeartIcon: ClassIcon = (props) => {
  const id = useId();
  const g = `url(#${id})`;
  return (
    <IriSvg {...props}>
      <defs><IriGrad id={id} /></defs>
      <path fill={g} d="M9.04 4.75 L6.8 3.2 L2.8 6.8 L2.8 11.2 L12 21 L14.38 18.47 Z" />
      <path fill={g} d="M10.79 5.96 L12 6.8 L17.2 3.2 L21.2 6.8 L21.2 11.2 L15.28 17.5 Z" />
    </IriSvg>
  );
};

/** 4-point sparkle (star class). */
export const IriStarIcon: ClassIcon = (props) => {
  const id = useId();
  const g = `url(#${id})`;
  return (
    <IriSvg {...props}>
      <defs><IriGrad id={id} /></defs>
      <path fill={g} d="M12 1 L12.97 4.89 L11.18 4.29 Z" />
      <path fill={g} d="M10.89 5.46 L13.32 6.27 L14.2 9.8 L23 12 L14.2 14.2 L12 23 L9.8 14.2 L1 12 L9.8 9.8 Z" />
    </IriSvg>
  );
};

/** Faceted diamond (diamond class). */
export const IriDiamondIcon: ClassIcon = (props) => {
  const id = useId();
  const g = `url(#${id})`;
  return (
    <IriSvg {...props}>
      <defs><IriGrad id={id} /></defs>
      <path fill={g} d="M7 4 L9.73 4 L11.38 8.5 L2.95 8.5 Z" />
      <path fill={g} d="M11.01 4 L17 4 L21.05 8.5 L12.66 8.5 Z" />
      <path fill={g} d="M2.90 9.5 L11.75 9.5 L14.72 17.56 L12 21 Z" />
      <path fill={g} d="M13.03 9.5 L21.10 9.5 L15.59 16.46 Z" />
    </IriSvg>
  );
};

/** Almond eye with a twinkle (eye class). */
export const IriEyeIcon: ClassIcon = (props) => {
  const id = useId();
  const g = `url(#${id})`;
  return (
    <IriSvg {...props}>
      <defs><IriGrad id={id} /></defs>
      <path fill={g} d="M8.45 7 L7 7 L2 12 L7 17 L11.30 17 Z" />
      <path fill={g} fillRule="evenodd" d="M9.70 7 L17 7 L22 12 L17 17 L12.55 17 Z M13.9 9.7 L16.2 12 L13.9 14.3 L11.6 12 Z" />
      <path fill={g} d="M19.5 2.5 L20.1 4.4 L22 5 L20.1 5.6 L19.5 7.5 L18.9 5.6 L17 5 L18.9 4.4 Z" />
    </IriSvg>
  );
};

/** Two sparkles + a small one (new class). */
export const IriSparkIcon: ClassIcon = (props) => {
  const id = useId();
  const g = `url(#${id})`;
  return (
    <IriSvg {...props}>
      <defs><IriGrad id={id} /></defs>
      <path fill={g} d="M7.81 6.91 L7.6 7.6 L1.5 9.5 L7.6 11.4 L9.5 17.5 L10.62 13.92 Z" />
      <path fill={g} d="M8.38 5.08 L9.5 1.5 L11.4 7.6 L17.5 9.5 L11.4 11.4 L11.19 12.09 Z" />
      <path fill={g} d="M18 12 L19.2 15.8 L23 17 L19.2 18.2 L18 22 L16.8 18.2 L13 17 L16.8 15.8 Z" />
    </IriSvg>
  );
};

/** Rounded house with an arched door (iridescent header). */
export const IriHomeIcon: ClassIcon = (props) => (
  <Svg {...props} strokeLinejoin="round" strokeLinecap="round">
    {/* roof */}
    <path d="M12 2.7 C11.65 2.7 11.3 2.83 11.03 3.07 L3.3 9.93 C2.85 10.33 3.13 11 3.7 11 H20.3 C20.87 11 21.15 10.33 20.7 9.93 L12.97 3.07 C12.7 2.83 12.35 2.7 12 2.7 Z" />
    {/* walls + door */}
    <path d="M5 12 H19 V20 C19 20.55 18.55 21 18 21 H14.5 V16 C14.5 15.3 13.8 15 13 15 H11 C10.2 15 9.5 15.3 9.5 16 V21 H6 C5.45 21 5 20.55 5 20 Z" />
  </Svg>
);

/* ---- Backup class (move-to-another-SD-card reminder) ------------------- */
/* All of them are an SD card shape (cut corner top right), each theme styles it. */

/** Plain SD card (basic accents). */
export const BackupCardIcon: ClassIcon = (props) => (
  <Svg {...props}>
    <path
      fillRule="evenodd"
      d="M5 3 H15 L19 7 V21 H5 Z M6.9 5.2 H8 V8 H6.9 Z M9.45 5.2 H10.55 V8 H9.45 Z M12 5.2 H13.1 V8 H12 Z"
    />
  </Svg>
);

/** SD card split by a glitch (cyberpunk). */
export const CyberBackupIcon: ClassIcon = (props) => (
  <Svg {...props}>
    <path d="M6 3 H16 L20 7 V11.4 H6 Z" />
    <path d="M8 5 H9 V8 H8 Z M10.6 5 H11.6 V8 H10.6 Z" />
    <path d="M4 12.6 H18 V21 H4 Z" />
  </Svg>
);

/** Faceted SD card with the gradient (iridescent). */
export const IriBackupIcon: ClassIcon = (props) => {
  const id = useId();
  const g = `url(#${id})`;
  return (
    <IriSvg {...props}>
      <defs><IriGrad id={id} /></defs>
      <path fill={g} d="M5.5 2.5 L7.37 2.5 L13.87 21.5 L5.5 21.5 Z" />
      <path fill={g} d="M8.63 2.5 L14.2 2.5 L14.2 8 L19.5 8 L19.5 21.5 L15.13 21.5 Z" />
      <path fill={g} d="M15.4 2.9 L19.3 6.8 L15.4 6.8 Z" />
    </IriSvg>
  );
};

/** Card with a small blossom (sakura). */
export const SakuraBackupIcon: ClassIcon = (props) => (
  <Svg strokeWidth={1.5} {...props}>
    <path d="M5 3 H15 L19 7 V21 H5 Z" />
    {ROT5.map((r) => (
      <path
        key={r}
        transform={`rotate(${r} 12 13)`}
        d="M12 11.4 C 11.3 10.9 11.1 9.9 11.4 8.6 L12 9.2 L12.6 8.6 C 12.9 9.9 12.7 10.9 12 11.4 Z"
      />
    ))}
    <circle cx="12" cy="13" r="1.1" />
  </Svg>
);

/** Home button blossom (petals around a dot). */
export const SakuraHomeIcon: ClassIcon = (props) => (
  <Svg strokeWidth={1.5} {...props}>
    {ROT5.map((r) => (
      <path
        key={r}
        transform={`rotate(${r} 12 12)`}
        d="M12 10.4 C 10.5 9.3, 9.8 6.9, 10.4 3.4 L 12 4.9 L 13.6 3.4 C 14.2 6.9, 13.5 9.3, 12 10.4 Z"
      />
    ))}
    <circle cx="12" cy="12" r="1.8" />
  </Svg>
);
