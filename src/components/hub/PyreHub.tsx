import { motion } from "framer-motion";
import { Loader2, Play, Plus, SlidersHorizontal, Wallpaper } from "lucide-react";
import type { WallSet } from "@/api/library";
import { Button } from "@/components/ui/Button";
import {
  Bouquet,
  Candles,
  CARD_COFFIN,
  Coffin,
  PyreCoffinDefs,
  STAGE_COFFIN,
  type CandleSpec,
} from "@/components/hub/PyreCoffin";
import {
  FIT_LABEL,
  HubTargetSwitch,
  StageButtons,
  RunsOn,
  stageOf,
  useHubMenu,
  useHubTimes,
  useHubWords,
  type HubOverviewProps,
} from "@/components/hub/shared";
import { useT, useTp } from "@/lib/i18n";

/** The candles beside the sarcophagi: on the stage (left, the right is mirrored), on a card. */
const STAGE_CANDLES: CandleSpec[] = [
  [14, 92, 44, 8],
  [40, 86, 30, 8],
  [64, 80, 40, 8],
  [12, 118, 34, 9],
  [26, 130, 16, 9],
  [38, 122, 24, 9],
  [58, 112, 30, 9],
  [74, 124, 18, 9],
  [100, 128, 14, 9],
];
const CARD_CANDLES: CandleSpec[] = [
  [14, 70, 40, 9],
  [36, 74, 22, 8],
];

/**
 * The overview on Pyre: one slideshow on top, its pictures on sarcophagi on the steps
 * among candles and roses; the others one sarcophagus each. Drawn in PyreCoffin, looks in
 * index.css (.ruby-hub-*).
 */
export function PyreOverview({ sets, busyId, onOpen, onRun, onNew, extra }: HubOverviewProps) {
  const t = useT();
  const w = useHubWords();
  const stage = stageOf(sets);
  return (
    <>
      <PyreCoffinDefs />
      <div className="ruby-bar mb-4 flex flex-wrap items-center justify-between gap-3 px-4 py-2.5">
        <h1 className="ruby-page-title text-3xl leading-none text-white">
          {t("Slideshows")}
          {!!sets?.length && <span className="text-xl"> ({sets.length})</span>}
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
          <Loader2 className="h-6 w-6 animate-spin text-[#ff7aa8]" />
        </div>
      ) : sets.length === 0 ? (
        <div className="ruby-hub-plate flex flex-col items-center gap-3 px-6 py-20 text-center">
          <Wallpaper className="h-10 w-10 text-[#ff7aa8]" />
          <p className="text-base font-semibold text-white">{t("No slideshows yet.")}</p>
          <p className="max-w-sm text-sm text-[#ecc9d6]">
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
            <h2 className="ruby-page-title text-xl text-white">{t("All slideshows")}</h2>
            <span aria-hidden className="ruby-hub-line" />
          </div>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(250px,1fr))] gap-4">
            {sets
              .filter((s) => s.id !== stage?.id)
              .map((s, i) => (
                <SetPlate
                  key={s.id}
                  set={s}
                  index={i + 1}
                  busy={busyId === s.id}
                  onOpen={() => onOpen(s.id)}
                  onStart={() => onRun(s.id, "start")}
                />
              ))}
            <button onClick={onNew} className="ruby-hub-plate ruby-hub-new group">
              <svg aria-hidden width={CARD_COFFIN.w} height={CARD_COFFIN.h} className="overflow-visible">
                <path d={CARD_COFFIN.face} fill="rgba(60,10,24,0.25)" stroke="#ffb0cb" strokeWidth={1.4} strokeDasharray="5 5" />
                <path d="M56 80v36M38 98h36" stroke="#ffc9da" strokeWidth={3} />
              </svg>
              <span className="text-sm font-semibold">{t("New slideshow")}</span>
            </button>
          </div>
        </>
      )}
    </>
  );
}

/** The big slideshow: what it is and its buttons, its pictures on the sarcophagi. */
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
  const count = s.preview.length + (more > 0 ? 1 : 0);
  // they lean away from the middle, the side faces are on the outer sides
  const lean = (i: number) => (i - (count - 1) / 2) * 2.4;
  const flip = (i: number) => i > (count - 1) / 2;
  return (
    <motion.div
      {...menu}
      // another one comes up from the plates below
      initial={{ opacity: 0, y: 24 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, ease: [0.2, 0.8, 0.2, 1] }}
      className="ruby-hub-plate group flex min-h-[320px] overflow-hidden"
    >
      <div className="relative z-[1] flex w-[24rem] max-w-full shrink-0 flex-col justify-center gap-3 py-6 pl-7 pr-4">
        {s.active && <span className="ruby-hub-live">{w.now}</span>}
        <button onClick={onOpen} className="ruby-hub-name">
          {s.name}
        </button>
        <div className="flex flex-wrap gap-1.5">
          {chips.map((c) => (
            <span key={c} className="ruby-hub-tag">
              {c}
            </span>
          ))}
          <RunsOn set={s} others named />
        </div>
        <StageButtons set={s} busy={busy} onRun={onRun} onOpen={onOpen} />
      </div>
      <button onClick={onOpen} title={t("Open")} aria-label={t("Open")} className="ruby-crypt">
        <span aria-hidden className="ruby-crypt-steps" />
        <span className="ruby-crypt-row">
          {s.preview.map((path, i) => (
            <Coffin key={path} shape={STAGE_COFFIN} path={path} size={512} mark={i} lean={lean(i)} flip={flip(i)} />
          ))}
          {more > 0 && (
            <Coffin
              shape={STAGE_COFFIN}
              size={512}
              mark={0}
              lean={lean(count - 1)}
              flip={flip(count - 1)}
              text={`+${more}`}
            />
          )}
          <Bouquet width={Math.max(1, count) * 122 + 30} seed={3} className="ruby-crypt-roses" />
          <Candles list={STAGE_CANDLES} width={110} height={130} className="ruby-crypt-candles" />
          <Candles list={STAGE_CANDLES} width={110} height={130} className="ruby-crypt-candles ruby-crypt-candles--r" />
        </span>
      </button>
    </motion.div>
  );
}

/** The other slideshows: a sarcophagus, the name, Start. An empty one is closed and unlit. */
function SetPlate({
  set: s,
  index,
  busy,
  onOpen,
  onStart,
}: {
  set: WallSet;
  index: number;
  busy: boolean;
  onOpen: () => void;
  onStart: () => void;
}) {
  const t = useT();
  const w = useHubWords();
  const tp = useTp();
  const times = useHubTimes();
  const menu = useHubMenu(s);
  const path = s.preview[0];
  return (
    <div className="ruby-hub-plate group flex min-w-0 flex-col overflow-hidden" {...menu}>
      <RunsOn set={s} className="absolute right-2.5 top-2.5 z-10" />
      <button onClick={onOpen} title={t("Open")} aria-label={t("Open")} className="ruby-crypt-one">
        <Coffin shape={CARD_COFFIN} path={path} size={512} mark={index} dim={!path} />
        {path && <Bouquet width={150} seed={7 + index} scale={0.8} className="ruby-crypt-one-roses" />}
        <Candles list={CARD_CANDLES} width={50} height={74} out={!path} className="ruby-crypt-one-candles" />
        <Candles
          list={CARD_CANDLES}
          width={50}
          height={74}
          out={!path}
          className="ruby-crypt-one-candles ruby-crypt-one-candles--r"
        />
      </button>
      <div className="flex flex-col gap-1.5 p-3.5 pt-2">
        <button onClick={onOpen} className="truncate text-left text-base font-semibold text-white">
          {s.name}
        </button>
        <div className="flex justify-between gap-2 text-xs text-[#ecc9d6]">
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
    </div>
  );
}
