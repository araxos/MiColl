import { Thumb } from "@/components/Thumb";
import { useThumb } from "@/hooks/useThumb";
import { gifUrl, isTauri, thumbUrl } from "@/lib/tauri";
import { isVideoPath } from "@/lib/videoThumb";
import { usePlayGifs, isGifPath } from "@/lib/playGifs";
import { useFxIdle } from "@/lib/fx";
import { useTileOffScreen } from "@/components/TileGate";
import { cn } from "@/lib/utils";

/**
 * Cover image using the cached thumbnails. Takes a file path, loads a small cached
 * JPEG (in Tauri) and shows a gradient if there's no image.
 * GIFs play if "Play GIFs" is on.
 */
export function Cover({
  path,
  alts,
  seed,
  label,
  size = 512,
  rounded,
  className,
}: {
  path?: string;
  /** Fallback paths if path doesn't load (only images, no videos). */
  alts?: string[];
  seed: string;
  label?: string;
  size?: number;
  rounded?: string;
  className?: string;
}) {
  const playGifs = usePlayGifs();
  const thumb = useThumb(path, size);
  // GIFs can't be paused with CSS, so show the still thumbnail when idle or off screen
  const idle = useFxIdle();
  const offScreen = useTileOffScreen();
  const still = idle || offScreen;
  const animatable = playGifs && isTauri() && isGifPath(path);
  const altUrls = isTauri()
    ? (alts ?? []).filter((p) => p && !isVideoPath(p)).map((p) => thumbUrl(p, size))
    : [];

  const base = (
    <Thumb
      src={thumb}
      alts={altUrls}
      seed={seed}
      label={label}
      rounded={rounded}
      className={className}
    />
  );
  // nothing to animate, normal markup
  if (!animatable) return base;

  // GIF = still thumbnail with the animated file on top (swapping the src would make it
  // blink)
  return (
    <div className="relative h-full w-full">
      {base}
      {!still && (
        <img
          // use the small re-encoded GIF (see gifUrl), not the original file
          src={gifUrl(path, size)}
          alt=""
          aria-hidden
          decoding="async"
          className={cn("absolute inset-0 h-full w-full object-cover", rounded, className)}
        />
      )}
    </div>
  );
}
