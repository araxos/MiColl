/**
 * A screen saver window (index.html?saver=<screen>, made by screensaver.rs): only pictures
 * and a clock. It's its own small entry, the app itself isn't loaded for it. Rust shows the
 * window when the first picture is there and closes it at the first input.
 */
import { useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { mediaUrl, previewUrl, thumbUrl } from "@/lib/tauri";
import "./saver.css";

interface Frames {
  pictures: string[];
  /** Seconds between two. */
  every: number;
  fit: "fill" | "fit" | "stretch";
  /** Pictures slowly grow or shrink. */
  zoom: boolean;
  clock: boolean;
  /** Every screen shows the same picture. */
  same: boolean;
  /** When it began (ms), the screens change together by it. */
  began: number;
  /** This window's screen of how many. */
  screen: number;
  screens: number;
  /** Its longer side in pixels. */
  edge: number;
}

interface Layer {
  id: number;
  url: string;
  /** A small one for the blur around it. */
  back: string;
  /** It comes with the window, the others fade in. */
  first: boolean;
}

/** saver.css has the same one. */
const FADE_MS = 1600;
/** A slow zoom takes this long at most, then it goes back (a picture can stay for minutes). */
const ZOOM_MAX_S = 40;

/** Decoded, so it can be shown without a gap. False when it can't be. */
async function load(url: string): Promise<boolean> {
  const img = new Image();
  img.src = url;
  try {
    await img.decode();
    return true;
  } catch {
    return false;
  }
}

/** The picture for this screen; a big one shrunk to it, the original if that fails. */
async function pictureUrl(path: string, edge: number): Promise<string | null> {
  for (const url of [previewUrl(path, edge), mediaUrl(path)]) {
    if (url && (await load(url))) return url;
  }
  return null;
}

const wait = (ms: number) => new Promise((r) => window.setTimeout(r, ms));

function Saver({ frames }: { frames: Frames }) {
  // the picture that's there and the one fading in over it
  const [layers, setLayers] = useState<Layer[]>([]);

  useEffect(() => {
    let alive = true;
    const { pictures, every, screen, screens, edge, same, began, fit } = frames;
    const n = pictures.length;
    const start = same ? 0 : Math.floor((screen * n) / Math.max(1, screens));
    void (async () => {
      let missed = 0;
      let shown = false;
      for (let k = 0; alive; k++) {
        // by the clock and not by counting, so the screens stay together
        const due = began + k * every * 1000;
        // too late for this one (the PC was busy or asleep)
        if (shown && Date.now() > due + every * 500) continue;
        const path = pictures[(start + k) % n];
        const url = await pictureUrl(path, edge);
        if (!alive) return;
        if (!url) {
          // not one of them can be shown: stay black, Rust gives up by itself
          if (++missed >= n) return;
          continue;
        }
        missed = 0;
        if (shown) await wait(Math.max(0, due - Date.now()));
        if (!alive) return;
        const back = fit === "fit" ? thumbUrl(path, 256) : "";
        const first = !shown;
        setLayers((cur) => [...cur.slice(-1), { id: k, url, back, first }]);
        if (first) {
          shown = true;
          await invoke("saver_ready").catch(() => {});
          if (n === 1) return;
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [frames]);

  // the one below isn't needed anymore when the new one is fully there
  const top = layers[layers.length - 1]?.id;
  useEffect(() => {
    const id = window.setTimeout(() => setLayers((cur) => cur.slice(-1)), FADE_MS + 200);
    return () => window.clearTimeout(id);
  }, [top]);

  const zoomTime = Math.min(ZOOM_MAX_S, frames.every + FADE_MS / 1000);
  return (
    <>
      {layers.map((l) => (
        <div key={l.id} className="saver-layer" data-first={l.first || undefined}>
          {l.back && <img className="saver-back" src={l.back} alt="" draggable={false} />}
          <img
            className="saver-picture"
            data-fit={frames.fit}
            // the next one the other way round, and the screens differ
            data-zoom={frames.zoom ? ((l.id + (frames.same ? 0 : frames.screen)) % 4) + 1 : undefined}
            style={{ "--zoom-time": `${zoomTime}s` } as React.CSSProperties}
            src={l.url}
            alt=""
            draggable={false}
          />
        </div>
      ))}
      {frames.clock && layers.length > 0 && <Clock />}
    </>
  );
}

/** The app's language and theme, as the app saved them. */
function saved(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function language(): string | undefined {
  const l = saved("micoll.language");
  return l && l !== "system" ? l : undefined;
}

function Clock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    // on the minute
    let id = 0;
    const tick = () => {
      setNow(new Date());
      id = window.setTimeout(tick, 60_000 - (Date.now() % 60_000) + 50);
    };
    tick();
    return () => window.clearTimeout(id);
  }, []);
  const lang = language();
  // it wanders a little, so nothing burns in on an OLED screen
  const m = now.getHours() * 60 + now.getMinutes();
  const at = { transform: `translate(${(m % 7) * 14}px, ${-(m % 5) * 12}px)` };
  return (
    <>
      <div className="saver-shade" />
      <div className="saver-clock" style={at}>
        <div className="saver-time">{new Intl.DateTimeFormat(lang, { timeStyle: "short" }).format(now)}</div>
        <div className="saver-line" />
        <div className="saver-date">
          {new Intl.DateTimeFormat(lang, { weekday: "long", day: "numeric", month: "long" }).format(now)}
        </div>
      </div>
    </>
  );
}

document.getElementById("micoll-splash")?.remove();
document.documentElement.dataset.saverTheme = saved("micoll.accent") ?? "original";

void invoke<Frames | null>("saver_frames").then((frames) => {
  if (!frames || frames.pictures.length === 0) return;
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(<Saver frames={frames} />);
});
