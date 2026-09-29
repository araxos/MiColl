import { useEffect, useRef, useState } from "react";
import { useCardFx } from "@/lib/fx";
import { subscribeRim } from "@/lib/rimClock";

/**
 * Iridescent card frame for dashboard cards (when the iridescent frame option is on).
 * Based on the frame-template.svg / frame-nontemplate.svg design (340x480 viewBox).
 * A card with two corners cut at 45 degrees, an inner line, hatching and a dot.
 * Cards with a template also get side brackets with a tick.
 * Template = blue -> lilac -> cyan, plain = mint -> lilac -> blue.
 * The cut corners are filled with the rim gradient (a clip on the body would remove them).
 */

/** The design's canvas, used as viewBox (preserveAspectRatio="none"). */
const VB_W = 340;
const VB_H = 480;

/** The rim, also used as % clip for the card body. */
const OUTER: [number, number][] = [
  [1, 45], //     down the left edge to where the top-left cut begins
  [45, 1], //     up across the cut
  [339, 1], //    the top edge
  [339, 435], //  down the right edge to the bottom-right cut
  [295, 479], //  across that cut
  [1, 479], //    and back along the bottom
];

const OUTER_D = `M${OUTER.map(([x, y]) => `${x},${y}`).join(" L")} Z`;

/**
 * The two cut corners as filled shapes in the rim gradient,
 * so they look like part of the border instead of a hole. Go to the very edge.
 */
const CORNER_TL_D = "M0,0 L0,46 L46,0 Z";
const CORNER_BR_D = "M340,480 L340,434 L294,480 Z";

/** Inner line, inset on all sides. */
const INNER_D = "M10,50 L50,10 L330,10 L330,431 L290,470 L10,470 Z";

/** Hatching where a cut meets an edge: 3 short lines, top and bottom. */
const HATCH_TOP_D = "M62,1 L54,9 M78,1 L70,9 M94,1 L86,9";
const HATCH_BOTTOM_D = "M246,479 L254,471 M262,479 L270,471 M278,479 L286,471";

/**
 * Template cards only: a bracket in each side wall + a small tick.
 * Both brackets have the same size now (the left one was smaller in the design).
 * 45 degree corners (inset = drop = 21).
 */
const BRACKET_RIGHT_D = "M339,150 L318,171 L318,309 L339,330";
const BRACKET_LEFT_D = "M1,330 L22,309 L22,171 L1,150";
/** Tick from each bracket, 14 long. */
const TICK_LEFT_D = "M22,240 L36,240";
const TICK_RIGHT_D = "M318,240 L304,240";

/* On hover the two brackets grow into one closed inner border.
   The shapes are in index.css (.iri-bracket-*) because d must be a CSS property
   to transition. Both paths need the same points (M + 3 L), so if you change
   BRACKET_LEFT_D or BRACKET_RIGHT_D, change the CSS too. */

type Tone = "prism" | "pearl";

/** The two gradients (iriA = template, iriB = plain). */
const STOPS: Record<Tone, string[]> = {
  prism: ["#9CCBF0", "#B5B0E8", "#B9DDE9"],
  pearl: ["#A9EDD9", "#B5B0E8", "#9CCBF0"],
};

const GLOW: Record<Tone, string> = {
  prism: "rgba(139,123,255,0.55)",
  pearl: "rgba(185,173,255,0.4)",
};

/** One mid color per gradient for the blurred halo below. */
const HALO: Record<Tone, string> = {
  prism: "#a9b6ee",
  pearl: "#a9d3e8",
};

export function IriCardFrame({ tone }: { tone: Tone }) {
  const anim = useCardFx();
  // gradient moves along the rim, driven by the shared 12 fps clock (lib/rimClock)
  // instead of SMIL at 60 fps
  const gradRef = useRef<SVGLinearGradientElement | null>(null);
  useEffect(() => {
    const grad = gradRef.current;
    if (!anim || !grad) return;
    const unsub = subscribeRim((phase) => {
      // translate(-VB_W -VB_H) -> (0 0) over one period, seamless with
      // spreadMethod="repeat"
      const k = phase - 1;
      grad.setAttribute(
        "gradientTransform",
        `translate(${(k * VB_W).toFixed(2)} ${(k * VB_H).toFixed(2)})`,
      );
    });
    return () => {
      unsub();
      // back to the normal gradient
      grad.removeAttribute("gradientTransform");
    };
  }, [anim]);
  const rimId = `iri-rim-${tone}`;
  const rim = `url(#${rimId})`;
  const stops = STOPS[tone];
  /** Template card with brackets and ticks. */
  const graded = tone === "prism";
  return (
    <>
      {/* the halo on its own layer, so it's only rendered once (a drop-shadow would re-blur
          every frame) */}
      <svg
        aria-hidden
        viewBox={`0 0 ${VB_W} ${VB_H}`}
        preserveAspectRatio="none"
        className="pointer-events-none absolute inset-0 z-20 h-full w-full"
        style={{ filter: `drop-shadow(0 0 7px ${GLOW[tone]})` }}
      >
        <path
          d={OUTER_D}
          fill="none"
          stroke={HALO[tone]}
          strokeWidth={2}
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      <svg
        aria-hidden
        viewBox={`0 0 ${VB_W} ${VB_H}`}
        preserveAspectRatio="none"
        className="pointer-events-none absolute inset-0 z-20 h-full w-full"
      >
        <defs>
          {/* userSpaceOnUse so horizontal lines get the gradient too.
              spreadMethod="repeat" makes the movement seamless. */}
          <linearGradient
            ref={gradRef}
            id={rimId}
            gradientUnits="userSpaceOnUse"
            x1="0"
            y1="0"
            x2={VB_W}
            y2={VB_H}
            spreadMethod="repeat"
          >
            {stops.map((c, i) => (
              <stop key={c + i} offset={`${(i / (stops.length - 1)) * 100}%`} stopColor={c} />
            ))}
          </linearGradient>
        </defs>

        {/* cut corners filled with the gradient, drawn before the strokes */}
        <g fill={rim} stroke="none">
          <path d={CORNER_TL_D} />
          <path d={CORNER_BR_D} />
        </g>
        {/* dark line under the rim so it's visible on bright covers */}
        <path
          d={OUTER_D}
          fill="none"
          stroke="rgba(12,10,22,0.55)"
          strokeWidth={4}
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
        {/* non-scaling-stroke keeps the lines even when stretched */}
        <path
          d={OUTER_D}
          fill="none"
          stroke={rim}
          strokeWidth={2}
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
        <path
          d={INNER_D}
          fill="none"
          stroke={rim}
          strokeWidth={0.75}
          opacity={0.6}
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
        <g fill="none" stroke={rim} strokeWidth={1.5}>
          <path d={HATCH_TOP_D} vectorEffect="non-scaling-stroke" />
          <path d={HATCH_BOTTOM_D} vectorEffect="non-scaling-stroke" />
        </g>

        {/* brackets (template only). On hover they turn into a closed border (see
            index.css),
            the ticks go with them. */}
        {graded && (
          <g fill="none" stroke={rim}>
            <path
              className="iri-bracket-r"
              d={BRACKET_RIGHT_D}
              strokeWidth={2}
              vectorEffect="non-scaling-stroke"
            />
            <path
              className="iri-bracket-l"
              d={BRACKET_LEFT_D}
              strokeWidth={2}
              vectorEffect="non-scaling-stroke"
            />
            <path
              className="iri-bracket-tick"
              d={TICK_LEFT_D}
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
            />
            <path
              className="iri-bracket-tick"
              d={TICK_RIGHT_D}
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
            />
          </g>
        )}

        {/* dot on the top rim */}
        <circle cx={VB_W / 2} cy={8} r={2.5} fill={rim} stroke="none" />
      </svg>
    </>
  );
}

/** Duration of one light band pass (slow on purpose). */
const SWEEP_MS = 8000;

/**
 * Foil glitter, only on template cards.
 * Fixed positions with staggered delays, only one or two light up at a time.
 */
const SPARKS = [
  { left: "22%", top: "16%", size: 7, dur: "6.5s", delay: "-0.8s" },
  { left: "68%", top: "11%", size: 5.5, dur: "7.5s", delay: "-3.4s" },
  { left: "45%", top: "31%", size: 8, dur: "6s", delay: "-5.1s" },
  { left: "81%", top: "38%", size: 5, dur: "8s", delay: "-1.9s" },
  { left: "13%", top: "47%", size: 6, dur: "7s", delay: "-6.2s" },
  { left: "58%", top: "56%", size: 7.5, dur: "6.8s", delay: "-2.6s" },
  { left: "33%", top: "68%", size: 5.5, dur: "7.8s", delay: "-4.7s" },
  { left: "74%", top: "72%", size: 6.5, dur: "6.2s", delay: "-7.3s" },
];

/**
 * Effects inside a framed card: a light band crosses sometimes, template cards also
 * glitter.
 * Clipped by the frame outline.
 */
export function IriCardScreen({ tone }: { tone: Tone }) {
  const anim = useCardFx();
  // one pass, then a random wait, so cards never do it together (like SakuraCardScreen)
  const graded = tone === "prism";
  const [sweeping, setSweeping] = useState(false);
  useEffect(() => {
    if (!anim) return;
    // running: safety timer in case onAnimationEnd never fires.
    // idle: 15-75s until the next one (half on template cards)
    const delay = sweeping
      ? SWEEP_MS * 2
      : (graded ? 7_000 : 15_000) + Math.random() * (graded ? 28_000 : 60_000);
    const t = setTimeout(() => setSweeping(!sweeping), delay);
    return () => clearTimeout(t);
  }, [sweeping, anim, graded]);
  const band =
    tone === "prism"
      ? "transparent 26%, rgba(196,181,253,0.3) 39%, rgba(245,194,255,0.26) 47%, rgba(167,243,208,0.24) 55%, rgba(186,230,253,0.28) 62%, transparent 76%"
      : "transparent 28%, rgba(233,228,255,0.24) 41%, rgba(255,255,255,0.3) 50%, rgba(220,247,236,0.2) 59%, transparent 74%";
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 z-[15] overflow-hidden">
      {sweeping && (
        <div
          className="absolute inset-0 mix-blend-soft-light"
          style={{
            backgroundImage: `linear-gradient(108deg, ${band})`,
            backgroundSize: "260% 100%",
            // forwards is needed, otherwise the band flashes before unmount
            animation: `micoll-sak-silk ${SWEEP_MS}ms linear 1 forwards`,
          }}
          onAnimationEnd={() => setSweeping(false)}
        />
      )}
      {graded &&
        anim &&
        SPARKS.map((sp) => (
          <span
            key={sp.left + sp.top}
            className="iri-card-spark"
            style={{
              left: sp.left,
              top: sp.top,
              width: `${sp.size}%`,
              paddingBottom: `${sp.size}%`,
              animationDuration: sp.dur,
              animationDelay: sp.delay,
            }}
          />
        ))}
    </div>
  );
}
