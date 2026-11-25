import { motion } from "framer-motion";
import { ImagePlus, Loader2, Play, Plus, SlidersHorizontal, Wallpaper } from "lucide-react";
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
 * The overview on the standard themes: one slideshow on top on a big monitor that lights
 * the wall in its picture's colours, the others on small ones (index.css .cas-hub-*, all
 * in the theme's colours). The bar hangs from the top bar like on a creator's page.
 */
export function CasualOverview({ sets, busyId, onOpen, onRun, onNew, extra }: HubOverviewProps) {
  const t = useT();
  const w = useHubWords();
  const stage = stageOf(sets);
  return (
    <>
      <div className="casual-bar relative z-20 mb-4 flex flex-wrap items-center justify-between gap-3 px-4 pb-2.5 pt-3">
        <h1 className="text-3xl font-bold leading-none tracking-tight text-zinc-50">
          {t("Slideshows")}
          {!!sets?.length && <span className="text-xl font-medium text-brand-200"> ({sets.length})</span>}
        </h1>
        <div className="flex flex-wrap items-center gap-3">
          <HubTargetSwitch />
          <Button variant="primary" className="casual-lead" onClick={onNew}>
            <Plus className="h-4 w-4" />
            {t("New slideshow")}
          </Button>
        </div>
      </div>
      {extra}

      {sets === null ? (
        <div className="flex justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-brand-300" />
        </div>
      ) : sets.length === 0 ? (
        <div className="cas-hub-plate flex flex-col items-center gap-3 px-6 py-20 text-center">
          <Wallpaper className="h-10 w-10 text-brand-300" />
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
          <div className="mb-3 mt-5 flex items-center gap-3">
            <h2 className="text-lg font-semibold text-zinc-100">{t("All slideshows")}</h2>
            <span aria-hidden className="casual-rule h-px flex-1" />
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
            <button onClick={onNew} className="cas-hub-plate cas-hub-new group">
              <Plus className="h-8 w-8 transition-transform group-hover:scale-110" />
              <span className="text-sm font-semibold">{t("New slideshow")}</span>
            </button>
          </div>
        </>
      )}
    </>
  );
}

/** A monitor with a picture and its light on the wall, or switched off. */
function Monitor({ path, size, className }: { path?: string; size: number; className?: string }) {
  return (
    <span aria-hidden className={cn("cas-mon", !path && "cas-mon--off", className)}>
      {path && (
        <span className="cas-mon-light">
          {/* a small one, it's blurred */}
          <Thumb path={path} size={256} />
        </span>
      )}
      <span className="cas-mon-frame">
        <span className="cas-mon-screen">
          {path ? <Thumb path={path} size={size} /> : <ImagePlus className="h-6 w-6 text-zinc-500" />}
        </span>
      </span>
      <i className="cas-mon-neck" />
      <i className="cas-mon-foot" />
    </span>
  );
}

/** The big slideshow: what it is and its buttons, its first picture on the monitor. */
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
  const rest = s.preview.slice(1);
  const more = s.count - s.preview.length;
  return (
    <motion.div
      {...menu}
      // another one comes up from the plates below
      initial={{ opacity: 0, y: 24 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, ease: [0.2, 0.8, 0.2, 1] }}
      className="cas-hub-plate flex min-h-[318px] overflow-hidden"
    >
      <span aria-hidden className="cas-desk" />
      <div className="relative z-[1] flex w-[24rem] max-w-full shrink-0 flex-col justify-center gap-3 py-6 pl-7 pr-4">
        {s.active && <span className="cas-hub-live">{w.now}</span>}
        <button onClick={onOpen} className="cas-hub-name">
          <span>{s.name}</span>
        </button>
        <div className="flex flex-wrap gap-1.5">
          {chips.map((c) => (
            <span key={c} className="cas-hub-tag">
              {c}
            </span>
          ))}
          <RunsOn set={s} others named />
        </div>
        <StageButtons set={s} busy={busy} onRun={onRun} onOpen={onOpen} leadClass="casual-lead" />
      </div>
      <button onClick={onOpen} title={t("Open")} aria-label={t("Open")} className="cas-hub-scene">
        <Monitor path={s.preview[0]} size={1024} className="cas-mon--big" />
        {(rest.length > 0 || more > 0) && (
          <span className="cas-hub-rest">
            {rest.map((path) => (
              <span key={path} className="cas-hub-thumb">
                <Thumb path={path} size={256} />
              </span>
            ))}
            {more > 0 && <b>+{more}</b>}
          </span>
        )}
      </button>
    </motion.div>
  );
}

/** The other slideshows: a small monitor with the first picture, the name, Start. */
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
    <div className="cas-hub-plate group flex min-w-0 flex-col overflow-hidden" {...menu}>
      <RunsOn set={s} className="absolute right-2.5 top-2.5 z-10" />
      <button onClick={onOpen} title={t("Open")} aria-label={t("Open")} className="cas-hub-small">
        <span aria-hidden className="cas-desk" />
        <Monitor path={s.preview[0]} size={512} />
      </button>
      <div className="relative flex flex-col gap-1.5 p-3.5 pt-2">
        <button onClick={onOpen} className="truncate text-left text-base font-semibold text-white">
          {s.name}
        </button>
        <div className="flex justify-between gap-2 text-xs text-zinc-300">
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
