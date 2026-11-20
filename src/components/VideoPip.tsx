import { useEffect, useMemo, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { emit } from "@tauri-apps/api/event";
import { Pin, PinOff } from "lucide-react";
import { VideoPlayer } from "@/components/VideoPlayer";
import { takePipPayload } from "@/lib/pip";
import { rescanReward, claimAudioName } from "@/api/library";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * Picture in picture (?pip=<id>): only the video and its controls, in a small window on
 * top of the others. Pin = stays on top (on by default). Esc closes it. The app's lock
 * closes it too (lock in lib.rs).
 */
export function VideoPip({ id }: { id: string }) {
  const t = useT();
  // read once on mount
  const p = useMemo(() => takePipPayload(id), [id]);
  const [onTop, setOnTop] = useState(true);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") void getCurrentWindow().close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (!p) {
    return (
      <div className="grid h-screen place-items-center bg-black p-6 text-center text-sm text-zinc-400">
        {t("Nothing to show here. Close this window and try again.")}
      </div>
    );
  }

  return (
    // micoll-viewer: the viewer's theme looks (buttons, iridescent ink) apply here too
    <div className="micoll-viewer h-screen w-screen overflow-hidden bg-black">
      <svg aria-hidden width="0" height="0" className="absolute">
        <defs>
          <linearGradient id="micoll-iri-ink" x1="0" y1="0" x2="1" y2="1">
            <stop className="iri-ink iri-ink-1" offset="0%" />
            <stop className="iri-ink iri-ink-2" offset="55%" />
            <stop className="iri-ink iri-ink-3" offset="100%" />
          </linearGradient>
        </defs>
      </svg>
      <VideoPlayer
        src={p.src}
        path={p.path}
        title={p.title}
        startAt={p.time}
        autoPlay={p.playing}
        fill
        onPlay={() => void claimAudioName().catch(() => {})}
        onShot={(_, rewardId) => {
          if (rewardId == null) return;
          void rescanReward(String(rewardId))
            .then(() => emit("micoll://video-shot", { rewardId }))
            .catch(() => {});
        }}
        extra={
          <button
            onClick={() => {
              const next = !onTop;
              setOnTop(next);
              void getCurrentWindow().setAlwaysOnTop(next).catch(() => {});
            }}
            className="viewer-btn viewer-icon-btn flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-black/35 text-zinc-100 transition-colors micoll-hover"
            data-active={onTop || undefined}
            title={onTop ? t("Stays on top — click to let other windows over it") : t("Keep on top of other windows")}
          >
            {onTop ? <Pin className={cn("h-4 w-4")} /> : <PinOff className="h-4 w-4" />}
          </button>
        }
      />
    </div>
  );
}
