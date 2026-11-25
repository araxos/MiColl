import { createContext, useContext, type ReactNode } from "react";
import { Eye, Loader2, LockKeyhole, Monitor, MonitorPause, Play, SkipForward, Square } from "lucide-react";
import type { SaverOptions, SlideshowFit, WallSet } from "@/api/library";
import { Button } from "@/components/ui/Button";
import { useT, useTf } from "@/lib/i18n";
import { isTauri, thumbUrl } from "@/lib/tauri";
import { useAccent } from "@/lib/theme";
import { cn } from "@/lib/utils";

/** Where the hub's slideshows run: the desktop, Windows' lock screen or MiColl's screen
    saver. */
export type HubTarget = "desktop" | "lock" | "saver";

export type SaverInfo = SaverOptions & { windowsHasOwn: boolean };

export const HubTargetContext = createContext<{
  target: HubTarget;
  setTarget: (t: HubTarget) => void;
  /** The screen saver's options (null = not loaded yet). */
  saver: SaverInfo | null;
  onSaver: (c: Partial<SaverOptions>) => void;
  /** A slideshow's right-click menu. */
  onMenu: (e: React.MouseEvent, set: WallSet) => void;
}>({
  target: "desktop",
  setTarget: () => {},
  saver: null,
  onSaver: () => {},
  onMenu: () => {},
});

/** Spread onto a slideshow's card: its right-click menu. */
export function useHubMenu(set: WallSet) {
  const { onMenu } = useContext(HubTargetContext);
  return { onContextMenu: (e: React.MouseEvent) => onMenu(e, set) };
}

/** The hub's boxes: each theme's plate from its overview, lighter greys. */
export function useHubBox(): string {
  switch (useAccent()) {
    case "iridescent":
      return "rounded-none border border-white/15 bg-zinc-950/65 backdrop-blur [&_.text-zinc-500]:text-zinc-300";
    case "corruptruby":
      return "ruby-hub-plate [&_.text-zinc-500]:text-[#ecc9d6]";
    case "sakura":
      return "sak-hub-plate [&_.text-zinc-500]:text-[#e6bccd]";
    case "cyberpunk":
      return "cp-coll relative [&_.text-zinc-500]:text-[#b8c4cc]";
    default:
      return "cas-hub-plate [&_.text-zinc-500]:text-zinc-300";
  }
}

/** The texts (and the icon) that name the place the hub is showing. */
export function useHubWords(place?: HubTarget) {
  const t = useT();
  const ctx = useContext(HubTargetContext);
  // (the page is outside its own provider, it says the place itself)
  const target = place ?? ctx.target;
  if (target === "saver")
    return {
      Icon: MonitorPause,
      // it's the running one's other button, the screen saver shows itself instead
      next: t("Preview"),
      NextIcon: Eye,
      start: t("Set as screen saver"),
      on: t("Screen saver"),
      now: t("Is the screen saver"),
      stopHint: t("Turns the screen saver off"),
      empty: t("Make one, add pictures from your creators, favourites or collections, and set it as your screen saver."),
    };
  return target === "lock"
    ? {
        Icon: LockKeyhole,
        next: t("Next picture"),
        NextIcon: SkipForward,
        start: t("Set as lock screen slideshow"),
        on: t("On the lock screen"),
        now: t("On the lock screen now"),
        stopHint: t("The picture there now stays on your lock screen"),
        empty: t("Make one, add pictures from your creators, favourites or collections, and set it on your lock screen."),
      }
    : {
        Icon: Monitor,
        next: t("Next picture"),
        NextIcon: SkipForward,
        start: t("Set as desktop slideshow"),
        on: t("On the desktop"),
        now: t("On the desktop now"),
        stopHint: t("The picture on screen now stays as your background"),
        empty: t("Make one, add pictures from your creators, favourites or collections, and set it as your desktop background."),
      };
}

/** The places' names. */
export function usePlaceNames(): Record<HubTarget, string> {
  const t = useT();
  return { desktop: t("Desktop"), lock: t("Lock screen"), saver: t("Screen saver") };
}

/** Desktop / Lock screen / Screen saver, in each theme's look (index.css .hub-target). */
export function HubTargetSwitch() {
  const { target, setTarget } = useContext(HubTargetContext);
  const names = usePlaceNames();
  return (
    <div className="hub-target" role="group">
      {(
        [
          ["desktop", Monitor],
          ["lock", LockKeyhole],
          ["saver", MonitorPause],
        ] as const
      ).map(([key, Icon]) => (
        <button
          key={key}
          onClick={() => setTarget(key)}
          aria-pressed={target === key}
          className={cn("hub-target-btn", target === key && "hub-target-btn--on")}
        >
          <Icon className="h-4 w-4" />
          {names[key]}
        </button>
      ))}
    </div>
  );
}

/** What the Wallpaper Hub page hands a theme's own overview. A set is `active` when it
    runs on the target. */
export interface HubOverviewProps {
  /** null = still loading. */
  sets: WallSet[] | null;
  busyId: string | null;
  onOpen: (id: string) => void;
  onRun: (id: string, what: "start" | "next" | "stop") => void;
  onNew: () => void;
  /** Goes under the bar: what belongs to the place and not to one slideshow. */
  extra: ReactNode;
}

/** The slideshow that's big on top: the running one, else the last one that got pictures. */
export function stageOf(sets: WallSet[] | null): WallSet | undefined {
  return (
    sets?.find((s) => s.active) ??
    sets
      ?.filter((s) => s.count > 0)
      .sort((a, b) => (b.lastAdded ?? "").localeCompare(a.lastAdded ?? ""))[0]
  );
}

export const FIT_LABEL: Record<SlideshowFit, string> = { fill: "Fill", fit: "Fit", stretch: "Stretch" };

/** "10 min", "1 h", "1 day" */
export function useEveryLabel() {
  const tf = useTf();
  const t = useT();
  return (m: number) =>
    m >= 1440 ? t("1 day") : m >= 60 ? tf("{n} h", { n: m / 60 }) : tf("{n} min", { n: m });
}

/** "15 s", "2 min" */
export function useSecondsLabel() {
  const tf = useTf();
  const every = useEveryLabel();
  return (s: number) => (s < 60 ? tf("{n} s", { n: s }) : every(s / 60));
}

/** When a slideshow's pictures change on the place that's shown: "every 10 min", the
    screen saver also has "after 5 min" before it. */
export function useHubTimes() {
  const tf = useTf();
  const every = useEveryLabel();
  const seconds = useSecondsLabel();
  const { target, saver } = useContext(HubTargetContext);
  return (minutes: number): string[] =>
    target === "saver" && saver
      ? [tf("after {time}", { time: every(saver.after) }), tf("every {time}", { time: seconds(saver.every) })]
      : [tf("every {time}", { time: every(minutes) })];
}

/** Where a slideshow runs, as small badges: on a card only the icons, else with their
    names. `others` leaves out the place that's shown (that one has its own label). */
export function RunsOn({ set, others, named, className }: {
  set: WallSet;
  others?: boolean;
  named?: boolean;
  className?: string;
}) {
  const t = useT();
  const { target } = useContext(HubTargetContext);
  const places = (
    [
      ["desktop", Monitor, t("On the desktop"), set.desktop],
      ["lock", LockKeyhole, t("On the lock screen"), set.lock],
      ["saver", MonitorPause, t("Is the screen saver"), set.saver],
    ] as const
  ).filter(([key, , , on]) => on && !(others && key === target));
  if (places.length === 0) return null;
  return (
    <span className={cn("hub-runs", className)}>
      {places.map(([key, Icon, label]) => (
        <span key={key} className={cn("hub-run", named && "hub-run--named")} title={label}>
          <Icon className="h-3.5 w-3.5" />
          {named && label}
        </span>
      ))}
    </span>
  );
}

/** The screen saver can be looked at without setting it. */
export function PreviewButton({ set, busy, onRun }: { set: WallSet; busy: boolean; onRun: (what: "next") => void }) {
  const w = useHubWords();
  if (useContext(HubTargetContext).target !== "saver") return null;
  return (
    <Button variant="outline" size="sm" disabled={busy || set.count === 0} onClick={() => onRun("next")}>
      <w.NextIcon className="h-4 w-4" />
      {w.next}
    </Button>
  );
}

/** A square picture, lazily loaded (a gradient in the browser). */
export function Thumb({ path, className, size = 256 }: { path: string; className?: string; size?: number }) {
  const src = isTauri() ? thumbUrl(path, size) : "";
  return src ? (
    <img src={src} loading="lazy" draggable={false} alt="" className={cn("h-full w-full object-cover", className)} />
  ) : (
    <div className={cn("h-full w-full bg-gradient-to-br from-brand-700/40 to-zinc-800", className)} />
  );
}

/** The big slideshow's buttons: start it, or Next + Stop while it runs, and Open. */
export function StageButtons({
  set: s,
  busy,
  onRun,
  onOpen,
  openClass,
  leadClass,
}: {
  set: WallSet;
  busy: boolean;
  onRun: (what: "start" | "next" | "stop") => void;
  onOpen: () => void;
  /** Open's own look, else an outline button. */
  openClass?: string;
  /** On the main button (Next / Start). */
  leadClass?: string;
}) {
  const t = useT();
  const w = useHubWords();
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      {s.active ? (
        <>
          <Button variant="primary" size="sm" className={leadClass} disabled={busy} onClick={() => onRun("next")}>
            <w.NextIcon className="h-4 w-4" />
            {w.next}
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => onRun("stop")}
            title={w.stopHint}
          >
            <Square className="h-3.5 w-3.5" />
            {t("Stop")}
          </Button>
        </>
      ) : (
        <>
          <Button variant="primary" size="sm" className={leadClass} disabled={busy} onClick={() => onRun("start")}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
            {w.start}
          </Button>
          <PreviewButton set={s} busy={busy} onRun={onRun} />
        </>
      )}
      {openClass ? (
        <button onClick={onOpen} className={openClass}>
          {t("Open")}
        </button>
      ) : (
        <Button variant="outline" size="sm" onClick={onOpen}>
          {t("Open")}
        </Button>
      )}
    </div>
  );
}

/** Start, or Next + Stop while it runs. */
export function RunButtons({
  set,
  busy,
  onRun,
}: {
  set: WallSet;
  busy: boolean;
  onRun: (what: "start" | "next" | "stop") => void;
}) {
  const t = useT();
  const w = useHubWords();
  if (set.active) {
    return (
      <div className="mt-auto flex gap-2">
        <Button variant="outline" size="sm" disabled={busy} onClick={() => onRun("next")}>
          <w.NextIcon className="h-4 w-4" />
          {w.next}
        </Button>
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => onRun("stop")} title={w.stopHint}>
          <Square className="h-3.5 w-3.5" />
          {t("Stop")}
        </Button>
      </div>
    );
  }
  return (
    <div className="mt-auto flex gap-2">
      <Button variant="outline" size="sm" disabled={busy || set.count === 0} onClick={() => onRun("start")}>
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
        {w.start}
      </Button>
      <PreviewButton set={set} busy={busy} onRun={onRun} />
    </div>
  );
}
