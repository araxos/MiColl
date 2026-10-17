import { useEffect, useState } from "react";

/**
 * Cyberpunk "hacked" label: while `active` turns on, the text scrambles into glyph
 * noise and decrypts left to right back into itself (~0.45 s). Skipped when
 * animations are off or the user prefers reduced motion.
 */

const GLYPHS = "!<>-_\\/[]{}=+*^?#01ABCDEF";
const DURATION = 450;
const TICK = 30;

export function CyberScramble({ text, active }: { text: string; active: boolean }) {
  const [shown, setShown] = useState(text);

  useEffect(() => {
    setShown(text);
    if (!active) return;
    const off =
      document.documentElement.dataset.animations === "off" ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (off) return;
    const start = performance.now();
    const id = window.setInterval(() => {
      const p = Math.min(1, (performance.now() - start) / DURATION);
      const solid = Math.floor(p * text.length);
      setShown(
        text
          .split("")
          .map((ch, i) =>
            i < solid || ch === " " ? ch : GLYPHS[Math.floor(Math.random() * GLYPHS.length)],
          )
          .join(""),
      );
      if (p >= 1) window.clearInterval(id);
    }, TICK);
    return () => window.clearInterval(id);
  }, [active, text]);

  // the real text, invisible, holds the width so the button doesn't jump while glyphs
  // of other widths flicker over it
  return (
    <span className="inline-grid" aria-label={text}>
      <span aria-hidden className="invisible col-start-1 row-start-1">
        {text}
      </span>
      <span aria-hidden className="col-start-1 row-start-1 whitespace-pre text-left">
        {shown}
      </span>
    </span>
  );
}
