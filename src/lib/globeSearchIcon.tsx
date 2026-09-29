import { type SVGProps } from "react";

/**
 * Global search icon: a magnifier where the lens is a globe.
 * lucide has nothing for this. Drawn in lucide style (24 box, round caps, no fill),
 * the handle is a bit thicker so it doesn't look like a stray line.
 */
export function GlobeSearchIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width={24}
      height={24}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <circle cx="10.2" cy="10.2" r="7.2" />
      {/* horizon + meridian lines make the circle a globe */}
      <path d="M3 10.2h14.4" />
      <path d="M10.2 3a10.4 10.4 0 0 0 0 14.4 10.4 10.4 0 0 0 0-14.4" />
      {/* handle starts on the rim at 45 degrees */}
      <path d="m21.5 21.5-6.2-6.2" strokeWidth={2.6} />
    </svg>
  );
}
