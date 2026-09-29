import { useEffect, useState } from "react";
import { useCardFx } from "@/lib/fx";

/**
 * Cyberpunk card frame for dashboard cards (when the theme's frame option is on).
 * Yellow for creators with a template, cyan for the rest. The offset "ghost" copies
 * in the other colors make it glitch (off when animations are off).
 * Drawn at 340x480 and stretched. non-scaling-stroke keeps the lines even.
 * CARD_CLIP cuts the card to the same outline, edit both together.
 */

/** Frame outline as a % polygon for clip-path (SVG points / 340 x 480). */
export const CARD_CLIP =
  "polygon(0.588% 5.833%, 8.235% 0.417%, 69.412% 0.417%, 73.529% 3.333%, 99.412% 3.333%, 99.412% 80.833%, 94.118% 84.583%, 94.118% 99.583%, 29.412% 99.583%, 25.294% 96.667%, 0.588% 96.667%)";

const OUTLINE =
  "M2,28 L28,2 L236,2 L250,16 L338,16 L338,388 L320,406 L320,478 L100,478 L86,464 L2,464 Z";

/** One color version of the frame: outline, inner line and HUD ticks. */
function Frame({ color }: { color: string }) {
  return (
    <g fill="none" stroke={color} strokeWidth={4} vectorEffect="non-scaling-stroke">
      <path d={OUTLINE} />
      {/* line inside the top-left corner */}
      <path d="M10,34 L34,10 L232,10" strokeWidth={2} opacity={0.55} vectorEffect="non-scaling-stroke" />
      {/* crossed socket bottom left */}
      <rect x={14} y={374} width={22} height={22} vectorEffect="non-scaling-stroke" />
      <path d="M14,374 L36,396 M36,374 L14,396" strokeWidth={2} vectorEffect="non-scaling-stroke" />
      {/* tabs on the right edge */}
      <rect x={322} y={296} width={14} height={30} fill={color} stroke="none" />
      <rect x={326} y={60} width={6} height={6} fill={color} stroke="none" />
      {/* chevron and dashes along the bottom */}
      <path d="M168,478 L178,466 L188,478" vectorEffect="non-scaling-stroke" />
      <path d="M212,470 L226,470 M234,470 L240,470" vectorEffect="non-scaling-stroke" />
      <path d="M330,404 L330,440" vectorEffect="non-scaling-stroke" />
    </g>
  );
}

/** Delay per diagonal step (s), so the cards glitch like one wave. */
const WAVE_STEP = 0.09;

export function CyberCardFrame({ tone, wave = 0 }: { tone: "yellow" | "cyan"; wave?: number }) {
  const anim = useCardFx();
  const delay = `${(wave * WAVE_STEP).toFixed(2)}s`;
  const main = tone === "yellow" ? "#FCEE0A" : "#00F0FF";
  // the ghosts use the two other colors
  const ghostA = tone === "yellow" ? "#00F0FF" : "#FCEE0A";
  const ghostB = "#FF003C";
  return (
    <svg
      aria-hidden
      viewBox="0 0 340 480"
      preserveAspectRatio="none"
      className="pointer-events-none absolute inset-0 z-20 h-full w-full"
    >
      {anim && (
        <>
          {/* opacity comes from the keyframes. The delay puts the card in the wave. */}
          <g
            style={{
              animation: "micoll-cp-ghost-a 5.5s steps(1, end) infinite",
              animationDelay: delay,
              opacity: 0,
            }}
          >
            <Frame color={ghostA} />
          </g>
          <g
            style={{
              animation: "micoll-cp-ghost-b 5.5s steps(1, end) infinite",
              animationDelay: delay,
              opacity: 0,
            }}
          >
            <Frame color={ghostB} />
          </g>
        </>
      )}
      <Frame color={main} />
    </svg>
  );
}

/**
 * Effects inside a framed card: scanlines, a shine and tape tears.
 * All in percent so it fits any tile shape. Clipped by the frame.
 */
export function CyberCardScreen({ tone, wave = 0 }: { tone: "yellow" | "cyan"; wave?: number }) {
  // shine in the opposite color (yellow card -> blue shine, blue card -> red)
  const shine = tone === "yellow" ? "rgba(0,240,255,0.38)" : "rgba(255,0,60,0.34)";
  // same wave delay as the frame glitch (the shine is random on purpose)
  const tearDelay = `${(wave * WAVE_STEP).toFixed(2)}s`;
  // one pass, then a long random wait, so the cards don't pulse together
  const [sweeping, setSweeping] = useState(false);
  useEffect(() => {
    // running: remove after 5s (in case onAnimationEnd never fires).
    // idle: wait 30s-3min for the next one.
    const delay = sweeping ? 5_000 : 30_000 + Math.random() * 150_000;
    const t = setTimeout(() => setSweeping(!sweeping), delay);
    return () => clearTimeout(t);
  }, [sweeping]);

  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 z-[15] overflow-hidden">
      {/* scanlines (multiply, very faint) */}
      <div
        className="absolute inset-0 mix-blend-multiply"
        style={{
          backgroundImage:
            "repeating-linear-gradient(180deg, rgba(0,0,0,0.1) 0px, rgba(0,0,0,0.1) 1px, transparent 1px, transparent 4px)",
          animation: "micoll-cp-crawl 6s linear infinite",
        }}
      />
      {/* the shine, only mounted for one pass */}
      {sweeping && (
        <div
          className="absolute inset-x-0 top-0 h-[14%]"
          style={{
            background: `linear-gradient(180deg, transparent, ${shine}, transparent)`,
            animation: "micoll-cp-sweep 4.2s linear 1",
          }}
          onAnimationEnd={() => setSweeping(false)}
        />
      )}
      {/* tape tears (red band + cyan line) on the same delay as the frame glitch.
          top/opacity also set here so the band isn't visible before its delay */}
      <div
        className="absolute inset-x-0 h-[1.7%] mix-blend-screen"
        style={{
          background: "rgba(255,0,60,0.18)",
          animation: "micoll-cp-tear 15s steps(1, end) infinite",
          animationDelay: tearDelay,
          top: "12%",
          opacity: 0,
        }}
      />
      <div
        className="absolute inset-x-0 h-[0.8%] mix-blend-screen"
        style={{
          background: "rgba(0,240,255,0.24)",
          animation: "micoll-cp-tear 15s steps(1, end) infinite",
          animationDelay: `${(wave * WAVE_STEP + 0.35).toFixed(2)}s`,
          top: "12%",
          opacity: 0,
        }}
      />
    </div>
  );
}
