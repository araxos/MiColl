import { createContext, useContext } from "react";
import { useOnScreen } from "@/lib/onScreen";

/**
 * True while the tile is scrolled out of view (for things CSS can't pause, like GIFs).
 * Default is visible.
 */
const OffScreenCtx = createContext(false);

export function useTileOffScreen(): boolean {
  return useContext(OffScreenCtx);
}

/**
 * A div that also reports if it's near the viewport. Sets data-offscreen="1"
 * when it isn't, index.css pauses the animations inside.
 * Own component because the tiles are rendered in a map. Replaces the wrapper
 * div the grids already had. Not needed on the dashboard (VirtualGrid).
 */
export function TileGate({
  children,
  ...rest
}: React.HTMLAttributes<HTMLDivElement> & Record<`data-${string}`, unknown>) {
  const { ref, onScreen } = useOnScreen<HTMLDivElement>();
  return (
    <div ref={ref} data-offscreen={onScreen ? undefined : "1"} {...rest}>
      <OffScreenCtx.Provider value={!onScreen}>{children}</OffScreenCtx.Provider>
    </div>
  );
}
