import { useEffect, useMemo, useRef } from "react";

/**
 * Iridescent holo for cards with a template. Two band layers drift slowly (CSS only).
 * On hover a rAF loop makes the bands follow the mouse, adds a glare and tilts the
 * card in 3D. Other cards keep the shared WebGL plasma (IriHoloCard).
 * Pointer is read from the parent, the tilt goes on the same element.
 * skin="sak": the same holo in blossom colours (sak-tpl-* in index.css), plus a few
 * petals drifting down the card.
 */
export function IriTemplateHolo({ skin = "iri" }: { skin?: "iri" | "sak" }) {
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const body = root.parentElement; // the card's clipped body (overflow-hidden)
    if (!body) return;
    const btn = body.parentElement; // the motion.button — hosts the perspective
    const band1 = root.querySelector<HTMLElement>(`.${skin}-tpl-band1`);
    const band2 = root.querySelector<HTMLElement>(`.${skin}-tpl-band2`);
    const glare = root.querySelector<HTMLElement>(`.${skin}-tpl-glare`);
    // reduced motion: only the static sheen
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    if (btn) btn.style.perspective = "900px";

    const TILT = 7; // deg — grid cards are small; the prototype's 10° reads huge here
    const ptr = { x: 0.5, y: 0.5 };
    const cur = { x: 0.5, y: 0.5, act: 0 };
    let active = false;
    let running = false;
    let raf = 0;

    const settle = () => {
      // give the bands back to the CSS drift and stop the loop
      running = false;
      body.style.transform = "";
      for (const el of [band1, band2]) {
        if (!el) continue;
        el.style.animation = "";
        el.style.backgroundPosition = "";
        el.style.opacity = "";
      }
      if (glare) glare.style.opacity = "0";
    };

    const frame = () => {
      cur.x += (ptr.x - cur.x) * 0.12;
      cur.y += (ptr.y - cur.y) * 0.12;
      cur.act += ((active ? 1 : 0) - cur.act) * 0.08;
      const { x, y, act } = cur;
      if (!active && act < 0.02) {
        settle();
        return;
      }
      const rx = (0.5 - y) * TILT * act;
      const ry = (x - 0.5) * TILT * 1.15 * act;
      body.style.transform = `rotateX(${rx.toFixed(3)}deg) rotateY(${ry.toFixed(3)}deg)`;
      if (band1) {
        band1.style.backgroundPosition = `${((1 - x) * 100).toFixed(2)}% ${((1 - y) * 100).toFixed(2)}%`;
        band1.style.opacity = (0.22 + 0.16 * act).toFixed(3);
      }
      if (band2) {
        band2.style.backgroundPosition = `${(x * 100).toFixed(2)}% ${(y * 100).toFixed(2)}%`;
        band2.style.opacity = (0.12 + 0.1 * act).toFixed(3);
      }
      if (glare) {
        glare.style.background = `radial-gradient(180px 180px at ${(x * 100).toFixed(2)}% ${(y * 100).toFixed(2)}%, rgba(255,255,255,0.5) 0%, rgba(255,255,255,0.07) 45%, rgba(255,255,255,0) 70%)`;
        glare.style.opacity = (0.32 * act).toFixed(3);
      }
      raf = requestAnimationFrame(frame);
    };

    const onMove = (e: PointerEvent) => {
      const r = body.getBoundingClientRect();
      ptr.x = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
      ptr.y = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
      active = true;
      if (!running) {
        running = true;
        // pause the CSS drift so the mouse positions win
        if (band1) band1.style.animation = "none";
        if (band2) band2.style.animation = "none";
        raf = requestAnimationFrame(frame);
      }
    };
    const onLeave = () => {
      active = false; // the loop eases back to rest, then settles itself
    };

    body.addEventListener("pointermove", onMove);
    body.addEventListener("pointerleave", onLeave);
    return () => {
      cancelAnimationFrame(raf);
      body.removeEventListener("pointermove", onMove);
      body.removeEventListener("pointerleave", onLeave);
      settle();
      if (btn) btn.style.perspective = "";
    };
  }, [skin]);

  // sakura: a few petals drifting down the card. Everything is random per card and per
  // petal (how many, where, how big, how fast, when): each petal falls once in a long
  // cycle and then rests, and starts after its own pause, so they don't all show at
  // once and no two cards look alike.
  const petals = useMemo(() => {
    if (skin !== "sak") return null;
    const rnd = (a: number, b: number) => a + Math.random() * (b - a);
    const count = 2 + Math.floor(Math.random() * 4); // 2-5
    return Array.from({ length: count }, (_, i) => {
      const cycle = rnd(14, 32); // the fall takes the first ~55% (sak-tpl-fall)
      const delay = rnd(0, 26);
      const size = rnd(6, 11);
      const sway = rnd(2.4, 4.8);
      return (
        <span
          key={i}
          className="sak-tpl-petal"
          style={{
            left: `${rnd(2, 94).toFixed(1)}%`,
            animation: `sak-tpl-fall ${cycle.toFixed(2)}s linear ${delay.toFixed(2)}s infinite`,
            ["--drift" as string]: `${rnd(-18, 18).toFixed(0)}px`,
          }}
        >
          <span
            style={{
              animation: `micoll-sak-sway ${sway.toFixed(2)}s ease-in-out ${(-rnd(0, sway)).toFixed(2)}s infinite alternate`,
            }}
          >
            <span
              style={{
                width: `${size.toFixed(1)}px`,
                height: `${(size * 1.3).toFixed(1)}px`,
                opacity: rnd(0.55, 1).toFixed(2),
              }}
            />
          </span>
        </span>
      );
    });
  }, [skin]);

  return (
    <div ref={rootRef} aria-hidden className={`${skin}-tpl-holo pointer-events-none absolute inset-0 z-10`}>
      {/* broad holo bands */}
      <div className={`${skin}-tpl-band1 absolute inset-0`} />
      {/* finer bands at the opposite angle */}
      <div className={`${skin}-tpl-band2 absolute inset-0`} />
      {petals && <div className="sak-tpl-petals absolute inset-0">{petals}</div>}
      {/* glare following the mouse (hover only) */}
      <div className={`${skin}-tpl-glare absolute inset-0`} />
      {/* thin inner line (the outer edge is .iri-edge / .sak-edge) */}
      <div className={`${skin}-tpl-inner absolute`} />
    </div>
  );
}
