/**
 * Picture in picture: a video in its own small window that stays on top, only the video
 * and its controls, while MiColl stays usable. Like the pop-out viewer (popout.ts), its
 * data waits in localStorage (the windows share it), the window reads it once.
 */

export interface PipPayload {
  /** What the <video> plays. */
  src: string;
  /** The file on disk (screenshot, where it was left). */
  path?: string;
  title: string;
  /** Where it was in the viewer (seconds). */
  time: number;
  /** It was playing, so it goes on playing. */
  playing: boolean;
}

const keyFor = (id: string) => `micoll.pip.${id}`;

/** Open the video in its own window, sized to its shape. */
export async function openVideoPip(payload: PipPayload, videoW: number, videoH: number): Promise<void> {
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  localStorage.setItem(keyFor(id), JSON.stringify(payload));
  // about 480 px on its long side, its own shape
  const ratio = videoW > 0 && videoH > 0 ? videoW / videoH : 16 / 9;
  const w = ratio >= 1 ? 520 : Math.round(420 * ratio);
  const h = ratio >= 1 ? Math.round(520 / ratio) : 420;
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("open_video_pip", { id, title: `MiColl — ${payload.title}`, w, h });
}

// cache per id, React StrictMode mounts twice in dev
const cache = new Map<string, PipPayload | null>();

/** Read and remove a pip window's data. Returns null if missing. */
export function takePipPayload(id: string): PipPayload | null {
  if (cache.has(id)) return cache.get(id) ?? null;
  const raw = localStorage.getItem(keyFor(id));
  localStorage.removeItem(keyFor(id));
  let parsed: PipPayload | null = null;
  if (raw) {
    try {
      parsed = JSON.parse(raw) as PipPayload;
    } catch {
      parsed = null;
    }
  }
  cache.set(id, parsed);
  return parsed;
}
