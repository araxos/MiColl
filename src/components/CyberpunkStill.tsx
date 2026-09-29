/**
 * Cyberpunk background when "Animated background" is off.
 * Same style as CyberpunkFx but static: a perspective floor grid, a striped sun
 * and scanlines. No animation, no canvas, just gradients.
 */

/** Horizon height (used by the grid, the line and the sun). */
const HORIZON = "46vh";

export function CyberpunkStill() {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
      {/* striped sun: two mask layers, solid on top and bars below */}
      <div
        className="absolute h-[30vh] w-[30vh] -translate-x-1/2 rounded-full"
        style={{
          left: "64%",
          bottom: HORIZON,
          background: "linear-gradient(180deg, #fcee0a 0%, #ff7a00 72%, #ff2bd6 100%)",
          opacity: 0.17,
          maskImage:
            "linear-gradient(180deg, #000 0 46%, transparent 46%), repeating-linear-gradient(180deg, transparent 0 6px, #000 6px 13px)",
          WebkitMaskImage:
            "linear-gradient(180deg, #000 0 46%, transparent 46%), repeating-linear-gradient(180deg, transparent 0 6px, #000 6px 13px)",
        }}
      />

      {/* horizon line */}
      <div
        className="absolute inset-x-0 h-px bg-[#fcee0a]/45 shadow-[0_0_22px_3px_rgba(252,238,10,0.28)]"
        style={{ bottom: HORIZON }}
      />

      {/* floor grid tilted back with rotateX, the mask fades the far end.
          wider than the screen because the rotation pulls it in */}
      <div
        className="absolute inset-x-0 bottom-0 overflow-hidden [perspective-origin:50%_0%] [perspective:62vh]"
        style={{ height: HORIZON }}
      >
        <div
          className="absolute -inset-x-1/2 bottom-[-45vh] top-0 origin-top"
          style={{
            transform: "rotateX(74deg)",
            backgroundImage:
              "repeating-linear-gradient(90deg, rgba(0,229,255,0.5) 0 1px, transparent 1px 104px), repeating-linear-gradient(0deg, rgba(0,229,255,0.32) 0 1px, transparent 1px 104px)",
            maskImage: "linear-gradient(180deg, transparent, #000 52%)",
            WebkitMaskImage: "linear-gradient(180deg, transparent, #000 52%)",
            opacity: 0.5,
          }}
        />
      </div>

      {/* hazard bar + HUD corners like CyberpunkFx */}
      <div
        className="absolute bottom-[7%] left-0 h-4 w-[30%] opacity-[0.18]"
        style={{
          backgroundImage:
            "repeating-linear-gradient(45deg, rgba(252,238,10,0.7) 0 14px, transparent 14px 28px)",
          clipPath: "polygon(0 0, 100% 0, calc(100% - 16px) 100%, 0 100%)",
        }}
      />
      <div className="absolute left-3 top-12 h-10 w-10 border-l-2 border-t-2 border-yellow-300/20" />
      <div className="absolute bottom-3 right-3 h-10 w-10 border-b-2 border-r-2 border-yellow-300/20" />

      {/* scanlines on top of everything */}
      <div
        className="absolute inset-0"
        style={{
          backgroundImage:
            "repeating-linear-gradient(0deg, rgba(255,255,255,0.045) 0 1px, transparent 1px 3px)",
        }}
      />
    </div>
  );
}
