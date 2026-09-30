import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import { MousePointerClick, X } from "lucide-react";
import { useAccent } from "@/lib/theme";
import { useT } from "@/lib/i18n";
import { dismissTopbarHint } from "@/lib/topbarHint";

/**
 * One-time hint bubble under the cinema / wishlist / graveyard buttons
 * (they can be hidden with right-click). Layout decides when to show it.
 * Styles are in index.css (.tb-hint). The arrow is a sibling of the panel
 * so the cyberpunk clip-path doesn't cut it off.
 */
/** Shown after this long on the dashboard, not right away (first start is busy enough). */
const HINT_DELAY_MS = 10_000;

export function TopbarHint() {
  const [due, setDue] = useState(false);
  useEffect(() => {
    const id = window.setTimeout(() => setDue(true), HINT_DELAY_MS);
    return () => window.clearTimeout(id);
  }, []);
  return due ? <TopbarHintBubble /> : null;
}

function TopbarHintBubble() {
  const t = useT();
  const accent = useAccent();
  // right-aligned under the buttons (centered it went off screen),
  // the arrow still points at the middle of the group
  const ref = useRef<HTMLDivElement | null>(null);
  const [arrowRight, setArrowRight] = useState(56);
  useLayoutEffect(() => {
    const group = ref.current?.parentElement;
    if (!group) return;
    const place = () => setArrowRight(group.getBoundingClientRect().width / 2 - 6);
    place();
    const ro = new ResizeObserver(place);
    ro.observe(group);
    return () => ro.disconnect();
  }, []);
  return (
    <motion.div
      ref={ref}
      role="note"
      initial={{ opacity: 0, y: -6, scale: 0.96 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
      style={{ transformOrigin: `calc(100% - ${arrowRight + 6}px) 0` }}
      className="tb-hint-wrap absolute right-0 top-full z-40 mt-3"
    >
      <span className="tb-hint-arrow" style={{ right: arrowRight }} aria-hidden />
      <div className="tb-hint">
        {accent === "sakura" && <SakuraBlossom />}
        <div className="flex items-start gap-2.5">
          <MousePointerClick className="tb-hint-icon mt-0.5 h-4 w-4 shrink-0" />
          <div className="min-w-0 flex-1">
            {accent === "cyberpunk" && (
              <div className="tb-hint-tag">{"// tip"}</div>
            )}
            <div className="tb-hint-title">{t("Right-click to hide")}</div>
            <p className="tb-hint-body">
              {t(
                "Don’t need one of these buttons? Right-click it to hide it — right-click the gear to bring it back.",
              )}
            </p>
          </div>
          <button
            type="button"
            onClick={dismissTopbarHint}
            title={t("Dismiss")}
            aria-label={t("Dismiss")}
            className="tb-hint-close -mr-1 -mt-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-md"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </motion.div>
  );
}

/** Sakura: small blossom on the corner. */
function SakuraBlossom() {
  return (
    <svg viewBox="0 0 24 24" className="tb-hint-blossom" aria-hidden>
      {[0, 72, 144, 216, 288].map((r) => (
        <ellipse
          key={r}
          cx="12"
          cy="6.4"
          rx="3.6"
          ry="5.4"
          transform={`rotate(${r} 12 12)`}
          fill="#fbcfe8"
          stroke="#f472b6"
          strokeWidth="0.6"
        />
      ))}
      <circle cx="12" cy="12" r="2.2" fill="#fde68a" />
    </svg>
  );
}
