import { type SVGProps } from "react";

/**
 * Graveyard icon: a headstone with a cross. lucide doesn't have one,
 * so it's drawn in the same style (24 box, 2px round strokes, no fill).
 */
export function GraveyardIcon(props: SVGProps<SVGSVGElement>) {
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
      {/* the stone */}
      <path d="M6 20V9a6 6 0 0 1 12 0v11" />
      <path d="M3 20h18" />
      {/* the cross */}
      <path d="M12 7.5v7" />
      <path d="M9.5 10h5" />
    </svg>
  );
}
