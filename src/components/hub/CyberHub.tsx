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

/** Chips in the big reader / on a card. */
const READER_SLOTS = 5;
const CARD_SLOTS = 3;

/**
 * The overview on cyberpunk: one slideshow on top as a row of data chips in a reader, the
 * others as plates with smaller chips (index.css .cp-hub-*). The plates are the collection
 * cards' (.cp-coll).
 */
export function CyberOverview({ sets, busyId, onOpen, onRun, onNew, extra }: HubOverviewProps) {
  const t = useT();
  const w = useHubWords();
  const stage = stageOf(sets);
  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <h1 className="cp-hub-title">{t("Slideshows")}</h1>
        {!!sets?.length && <span className="cp-hub-count">{String(sets.length).padStart(2, "0")}</span>}
        <span aria-hidden className="cp-hub-line" />
        <HubTargetSwitch />
        <Button variant="primary" onClick={onNew}>
          <Plus className="h-4 w-4" strokeWidth={2.5} />
          {t("New slideshow")}
        </Button>
      </div>
      {extra}

      {sets === null ? (
        <div className="flex justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-[#fcee0a]" />
        </div>
      ) : sets.length === 0 ? (
        <div className="cp-coll relative flex flex-col items-center gap-3 px-6 py-20 text-center">
          <Wallpaper className="h-10 w-10 text-[#fcee0a]" />
          <p className="text-base font-semibold text-white">{t("No slideshows yet.")}</p>
          <p className="max-w-sm text-sm text-zinc-300">
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
          <h2 className="cp-hub-sub">{t("All slideshows")}</h2>
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
            <button
              onClick={onNew}
              className="cp-coll cp-coll--new relative flex min-h-[16rem] flex-col items-center justify-center gap-2 text-[#fcee0a]"
            >
              <Plus className="h-8 w-8" />
              <span className="text-sm font-semibold">{t("New slideshow")}</span>
            </button>
          </div>
        </>
      )}
    </>
  );
}

/** The big slideshow: what it is and its buttons, its pictures as chips in the reader. */
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
      className="cp-coll cp-hub-stage group"
    >
      <div className="flex w-[24rem] max-w-full shrink-0 flex-col justify-center gap-3 py-6 pl-7 pr-4">
        {s.active && <span className="cp-hub-live">{w.now}</span>}
        <button onClick={onOpen} className="cp-hub-name">
          {s.name}
        </button>
        <div className="flex flex-wrap gap-1.5">
          {chips.map((c) => (
            <span key={c} className="cp-hub-tag">
              {c}
            </span>
          ))}
          <RunsOn set={s} others named />
        </div>
        <StageButtons set={s} busy={busy} onRun={onRun} onOpen={onOpen} openClass="cp-hub-open" />
      </div>
      <button onClick={onOpen} title={t("Open")} aria-label={t("Open")} className="cp-hub-reader">
        {Array.from({ length: READER_SLOTS }, (_, i) => {
          const path = s.preview[i];
          // the slot after the pictures says how many more there are
          const rest = !path && i === s.preview.length && more > 0 ? `+${more}` : null;
          return (
            <Chip
              key={path ?? i}
              path={path}
              index={i}
              size={512}
              foot={path ? String(i + 1).padStart(2, "0") : undefined}
              text={rest}
            />
          );
        })}
      </button>
    </motion.div>
  );
}

/** A data chip with a picture, or an empty slot. */
function Chip({
  path,
  index,
  size,
  foot,
  text,
}: {
  path?: string;
  index: number;
  size: number;
  /** The number at the chip's foot (the big reader's chips). */
  foot?: string;
  /** Written into an empty slot. */
  text?: string | null;
}) {
  return (
    <span
      className={cn("cp-hub-chip", !path && "cp-hub-chip--gap")}
      style={{ "--i": index } as React.CSSProperties}
    >
      <span className="cp-hub-chip-in">
        <span className="cp-hub-chip-pic">
          {path ? <Thumb path={path} size={size} /> : text && <b>{text}</b>}
        </span>
        <span className="cp-hub-chip-foot">
          {foot && <em>{foot}</em>}
          <i />
        </span>
      </span>
    </span>
  );
}

/** The other slideshows: three chips, the name, Start. */
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
    <div className="cp-coll group relative flex min-w-0 flex-col gap-2 p-3.5" {...menu}>
      <RunsOn set={s} className="absolute right-5 top-5 z-10" />
      <button onClick={onOpen} title={t("Open")} aria-label={t("Open")} className="cp-hub-slots">
        {Array.from({ length: CARD_SLOTS }, (_, i) => (
          <Chip key={s.preview[i] ?? i} path={s.preview[i]} index={i} size={256} />
        ))}
      </button>
      <button onClick={onOpen} className="mt-1 truncate text-left text-base font-semibold text-white">
        {s.name}
      </button>
      <div className="flex justify-between gap-2 text-[11px] text-[#b8c4cc]">
        <span className="truncate">{tp("{n} pictures", s.count)}</span>
        <span className="shrink-0">{times(s.minutes).slice(-1)[0]}</span>
      </div>
      <div className="mt-1 flex gap-1.5">
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
