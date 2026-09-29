/**
 * "Open in new window" for the viewer. Opens a second window with ?popout=<id>
 * that only shows the viewer. The data is passed through localStorage
 * (Tauri windows share it), the popout reads it once and deletes it.
 */
import type { ViewerItem, CoverTargets } from "@/components/ImageViewer";

export interface PopoutPayload {
  items: ViewerItem[];
  index: number;
  coverTargets?: CoverTargets;
  /** Window title (e.g. the reward name). */
  title?: string;
}

const keyFor = (id: string) => `micoll.popout.${id}`;

/** Open the media list in a new window, starting at index. */
export async function openInNewWindow(payload: PopoutPayload): Promise<void> {
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  localStorage.setItem(keyFor(id), JSON.stringify(payload));
  // lazy import so the browser version doesn't load the window API
  const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  new WebviewWindow(`popout-${id}`, {
    url: `index.html?popout=${id}`,
    title: payload.title ? `MiColl — ${payload.title}` : "MiColl",
    width: 1000,
    height: 720,
    decorations: true,
  });
}

// cache per id, React StrictMode mounts twice in dev
const cache = new Map<string, PopoutPayload | null>();

/** Read and remove a popout's data. Returns null if missing. */
export function takePopoutPayload(id: string): PopoutPayload | null {
  if (cache.has(id)) return cache.get(id) ?? null;
  const raw = localStorage.getItem(keyFor(id));
  localStorage.removeItem(keyFor(id));
  let parsed: PopoutPayload | null = null;
  if (raw) {
    try {
      parsed = JSON.parse(raw) as PopoutPayload;
    } catch {
      parsed = null;
    }
  }
  cache.set(id, parsed);
  return parsed;
}
