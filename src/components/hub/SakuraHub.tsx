import { motion } from "framer-motion";
import { Loader2, Play, Plus, SlidersHorizontal, Wallpaper } from "lucide-react";
import type { WallSet } from "@/api/library";
import { Button } from "@/components/ui/Button";
import {
  FIT_LABEL,
  HubTargetSwitch,
  StageButtons,
  RunsOn,
  stageOf,
  Thumb,
  useHubMenu,
  useHubTimes,
  useHubWords,
  type HubOverviewProps,
} from "@/components/hub/shared";
import { useT, useTp } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * The overview on sakura: one slideshow on top as an unrolled hand scroll, the others as
 * hanging scrolls (index.css .sak-hub-*).
 */
export function SakuraOverview({ sets, busyId, onOpen, onRun, onNew, extra }: HubOverviewProps) {
  const t = useT();
  const w = useHubWords();
  const stage = stageOf(sets);
  return (
    <>
      <div className="sak-dash-bar relative mb-4 flex flex-wrap items-center justify-between gap-3 px-4 py-2.5">
        <h1 className="sak-hub-type text-3xl leading-none text-white">
          {t("Slideshows")}
          {!!sets?.length && <span className="text-xl text-[#ffd0e3]"> ({sets.length})</span>}
        </h1>
        <div className="flex flex-wrap items-center gap-3">
          <HubTargetSwitch />
          <Button variant="primary" onClick={onNew}>
            <Plus className="h-4 w-4" />
            {t("New slideshow")}
          </Button>
        </div>
      </div>
      {extra}

      {sets === null ? (
        <div className="flex justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-[#f9a8d4]" />
        </div>
      ) : sets.length === 0 ? (
        <div className="sak-hub-plate flex flex-col items-center gap-3 px-6 py-20 text-center">
          <Wallpaper className="h-10 w-10 text-[#f9a8d4]" />
          <p className="text-base font-semibold text-white">{t("No slideshows yet.")}</p>
          <p className="max-w-sm text-sm text-[#f5d3e3]">
            {w.empty}
          </p>
        </div>
      ) : (
        <>
          {stage && (
            <Stage
              key={stage.id}
              set={stage}
              busy={busyId === stage.id}
              onOpen={() => onOpen(stage.id)}
              onRun={(what) => onRun(stage.id, what)}
            />
          )}
          <div className="mb-3 mt-5 flex items-center gap-3">
            <h2 className="sak-hub-type text-lg text-white">{t("All slideshows")}</h2>
            <span aria-hidden className="sak-hub-line" />
          </div>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(250px,1fr))] gap-4">
            {sets
              .filter((s) => s.id !== stage?.id)
              .map((s) => (
                <SetPlate
                  key={s.id}
                  set={s}
                  busy={busyId === s.id}
                  onOpen={() => onOpen(s.id)}
                  onStart={() => onRun(s.id, "start")}
                />
              ))}
            <button onClick={onNew} className="sak-hub-plate sak-hub-new group">
              <Plus className="h-8 w-8 transition-transform group-hover:scale-110" />
              <span className="text-sm font-semibold">{t("New slideshow")}</span>
            </button>
          </div>
        </>
      )}
    </>
  );
}

/** The big slideshow: what it is and its buttons, its pictures on the hand scroll. */
function Stage({
  set: s,
  busy,
  onOpen,
  onRun,
}: {
  set: WallSet;
  busy: boolean;
  onOpen: () => void;
  onRun: (what: "start" | "next" | "stop") => void;
}) {
  const t = useT();
  const w = useHubWords();
  const tp = useTp();
  const times = useHubTimes();
  const menu = useHubMenu(s);
  const chips = [
    tp("{n} pictures", s.count),
    ...times(s.minutes),
    t(FIT_LABEL[s.fit]),
    ...(s.shuffle ? [t("Shuffle")] : []),
  ];
  const more = s.count - s.preview.length;
  return (
    <motion.div
      {...menu}
      // another one comes up from the plates below
      initial={{ opacity: 0, y: 24 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, ease: [0.2, 0.8, 0.2, 1] }}
      className="sak-hub-plate flex min-h-[282px]"
    >
      <div className="flex w-[25rem] max-w-full shrink-0 flex-col justify-center gap-3 py-6 pl-7 pr-4">
        {s.active && (
          <span className="sak-hub-live">
            <i aria-hidden className="sak-hub-bloom" />
            {w.now}
          </span>
        )}
        <button onClick={onOpen} className="sak-hub-name">
          {s.name}
        </button>
        <div className="flex flex-wrap gap-1.5">
          {chips.map((c) => (
            <span key={c} className="sak-hub-tag">
              {c}
            </span>
          ))}
          <RunsOn set={s} others named />
        </div>
        <StageButtons set={s} busy={busy} onRun={onRun} onOpen={onOpen} />
      </div>
      {/* the paper unrolls from the middle when it comes up */}
      <button onClick={onOpen} title={t("Open")} aria-label={t("Open")} className="sak-scroll">
        <span className="sak-scroll-cloth">
          <span className="sak-scroll-paper">
            {s.preview.map((path) => (
              <span key={path} className="sak-scroll-pic">
                <Thumb path={path} size={s.preview.length < 3 ? 1024 : 512} />
              </span>
            ))}
            {more > 0 && <span className="sak-scroll-more">+{more}</span>}
          </span>
        </span>
        <i aria-hidden className="sak-roller" />
        <i aria-hidden className="sak-roller sak-roller--r" />
      </button>
    </motion.div>
  );
}

/** The other slideshows: a hanging scroll with the first picture, the name, Start. */
function SetPlate({
  set: s,
  busy,
  onOpen,
  onStart,
}: {
  set: WallSet;
  busy: boolean;
  onOpen: () => void;
  onStart: () => void;
}) {
  const t = useT();
  const w = useHubWords();
  const tp = useTp();
  const times = useHubTimes();
  const menu = useHubMenu(s);
  return (
    <div className="sak-hub-plate group flex min-w-0 flex-col gap-1.5 p-3.5 pt-2" {...menu}>
      <RunsOn set={s} className="absolute right-3 top-3 z-10" />
      <button onClick={onOpen} title={t("Open")} aria-label={t("Open")} className="sak-kake">
        <svg aria-hidden viewBox="0 0 100 24" className="sak-kake-cord">
          <path d="M6 23 L50 5 L94 23" fill="none" stroke="#ffc4dd" strokeWidth="1.6" />
          <circle cx="50" cy="5" r="3.5" fill="#f472b6" />
        </svg>
        <i aria-hidden className="sak-kake-rod" />
        <span className="sak-kake-cloth">
          <span className={cn("sak-kake-pic", !s.preview[0] && "sak-kake-pic--empty")}>
            {s.preview[0] ? <Thumb path={s.preview[0]} size={512} /> : t("Add pictures")}
          </span>
        </span>
        <i aria-hidden className="sak-kake-rod sak-kake-rod--b" />
      </button>
      <button onClick={onOpen} className="mt-1 truncate text-left text-base font-semibold text-white">
        {s.name}
      </button>
      <div className="flex justify-between gap-2 text-xs text-[#e6bccd]">
        <span className="truncate">{tp("{n} pictures", s.count)}</span>
        <span className="shrink-0">{times(s.minutes).slice(-1)[0]}</span>
      </div>
      <div className="mt-1.5 flex gap-1.5">
        <Button
          variant="outline"
          size="sm"
          className="flex-1 justify-center"
          disabled={busy || s.count === 0}
          onClick={onStart}
          title={w.start}
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
          {t("Start")}
        </Button>
        <Button variant="ghost" size="sm" className="px-2" onClick={onOpen} title={t("Open")} aria-label={t("Open")}>
          <SlidersHorizontal className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
