import { motion } from "framer-motion";
import { Clock, ImagePlus, Images, Loader2, Monitor, Play, Plus, Shuffle, SlidersHorizontal, Wallpaper } from "lucide-react";
import type { WallSet } from "@/api/library";
import { Button } from "@/components/ui/Button";
import {
  FIT_LABEL,
  HubTargetSwitch,
  PreviewButton,
  RunButtons,
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

/** The square frosted bar of the iridescent dashboard ("Creators"). */
export const IRI_BAR =
  "mb-3 flex flex-wrap items-center justify-between gap-3 rounded-none border border-white/12 bg-zinc-900/45 px-4 py-2.5 backdrop-blur-xl [transform:translateZ(0)]";

/**
 * The overview on iridescent, square like the theme's other pages: the dashboard's bar,
 * one slideshow big on a stage with slanted picture strips (the running one, else the
 * last one that got pictures), the others as month-like foil cards.
 */
export function IriOverview({
  sets,
  busyId,
  onOpen,
  onRun,
  onNew,
  extra,
}: HubOverviewProps) {
  const t = useT();
  const w = useHubWords();
  const stage = stageOf(sets);
  return (
    <>
      <div className={IRI_BAR}>
        <h1 className="text-3xl font-bold leading-none tracking-tight text-zinc-50">
          {t("Slideshows")}
          {!!sets?.length && <span className="text-xl font-medium text-white"> ({sets.length})</span>}
        </h1>
        <div className="flex flex-wrap items-center gap-3">
          <HubTargetSwitch />
          <Button variant="primary" className="iri-lead iri-lead--fine rounded-lg" onClick={onNew}>
            <Plus className="h-4 w-4" />
            {t("New slideshow")}
          </Button>
        </div>
      </div>
      {extra}

      {sets === null ? (
        <div className="flex justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-white" />
        </div>
      ) : sets.length === 0 ? (
        <div className="iri-hub-panel flex flex-col items-center gap-3 px-6 py-20 text-center">
          <Wallpaper className="h-10 w-10 text-[#f5c2ff]" />
          <p className="text-base font-semibold text-white">{t("No slideshows yet.")}</p>
          <p className="max-w-sm text-sm text-zinc-200">
            {w.empty}
          </p>
        </div>
      ) : (
        <>
          {stage && (
            <IriStage
              key={stage.id}
              set={stage}
              busy={busyId === stage.id}
              onOpen={() => onOpen(stage.id)}
              onRun={(what) => onRun(stage.id, what)}
            />
          )}
          <section className="iri-hub-panel p-4">
            <div className="mb-3 flex items-center gap-3">
              <h2 className="text-lg font-semibold text-zinc-100">{t("All slideshows")}</h2>
              <span aria-hidden className="iri-rule h-[3px] flex-1 rounded-full" />
            </div>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-4">
              {sets
                .filter((s) => s.id !== stage?.id)
                .map((s) => (
                  <IriSetCard
                    key={s.id}
                    set={s}
                    busy={busyId === s.id}
                    onOpen={() => onOpen(s.id)}
                    onStart={() => onRun(s.id, "start")}
                  />
                ))}
              <button onClick={onNew} className="iri-hub-new group">
                <Plus className="h-8 w-8 transition-transform group-hover:scale-110" />
                <span className="text-sm font-semibold">{t("New slideshow")}</span>
              </button>
            </div>
          </section>
        </>
      )}
    </>
  );
}

/** The big slideshow on top: what it is and its buttons, its pictures beside. */
function IriStage({
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
    { icon: <Images className="h-3.5 w-3.5" />, text: tp("{n} pictures", s.count) },
    ...times(s.minutes).map((text) => ({ icon: <Clock className="h-3.5 w-3.5" />, text })),
    { icon: <Monitor className="h-3.5 w-3.5" />, text: t(FIT_LABEL[s.fit]) },
    ...(s.shuffle ? [{ icon: <Shuffle className="h-3.5 w-3.5" />, text: t("Shuffle") }] : []),
  ];
  return (
    <motion.div
      {...menu}
      // another one comes up from the cards below
      initial={{ opacity: 0, y: 24 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, ease: [0.2, 0.8, 0.2, 1] }}
      className="iri-card iri-hub-stage mb-3"
    >
      <div className="relative z-[1] flex w-[25rem] max-w-full shrink-0 flex-col justify-center gap-3 p-5">
        {s.active && (
          <span className="iri-hub-live">
            <w.Icon className="h-3.5 w-3.5" />
            {w.now}
          </span>
        )}
        <button onClick={onOpen} className="truncate text-left text-3xl leading-tight tracking-tight text-white">
          <span className="font-bold">{s.name}</span>
        </button>
        <div className="flex flex-wrap gap-1.5">
          {chips.map((c) => (
            <span key={c.text} className="iri-pill inline-flex h-7 items-center gap-1.5 px-2.5 text-xs font-medium">
              {c.icon}
              {c.text}
            </span>
          ))}
          <RunsOn set={s} others named />
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          {s.active ? (
            <RunButtons set={s} busy={busy} onRun={onRun} />
          ) : (
            <Button
              variant="primary"
              size="sm"
              className="iri-lead iri-lead--fine rounded-lg"
              disabled={busy}
              onClick={() => onRun("start")}
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
              {w.start}
            </Button>
          )}
          {!s.active && <PreviewButton set={s} busy={busy} onRun={onRun} />}
          <Button variant="outline" size="sm" onClick={onOpen}>
            {t("Open")}
          </Button>
        </div>
      </div>
      <button
        onClick={onOpen}
        title={t("Open")}
        className="iri-prism iri-hub-strips"
        style={{ "--n": Math.max(1, s.preview.length) } as React.CSSProperties}
      >
        {s.preview.map((path, i) => (
          <span key={path} className="iri-prism-strip" style={{ "--i": i } as React.CSSProperties}>
            <span className="iri-prism-pic">
              <Thumb path={path} size={s.preview.length < 3 ? 1024 : 640} />
            </span>
          </span>
        ))}
      </button>
    </motion.div>
  );
}

/** A slideshow as a foil card: its pictures, the name in the caption strip, Start. */
function IriSetCard({
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
  const shown = s.preview.slice(0, 3);
  return (
    <div className="iri-card iri-hub-card group relative flex min-w-0 flex-col" {...menu}>
      <RunsOn set={s} className="absolute right-2 top-2 z-10" />
      <button onClick={onOpen} title={t("Open")} className="iri-hub-pics">
        {shown.length === 0 ? (
          <span className="iri-hub-empty">
            <ImagePlus className="h-7 w-7" />
            <span className="text-xs font-medium">{t("Add pictures")}</span>
          </span>
        ) : (
          shown.map((path, i) => (
            <span
              key={path}
              className={cn(
                "overflow-hidden",
                shown.length === 1 && "col-span-2 row-span-2",
                (shown.length === 2 || (shown.length === 3 && i === 0)) && "row-span-2",
              )}
            >
              <Thumb path={path} size={i === 0 ? 512 : 256} />
            </span>
          ))
        )}
      </button>
      <div className="iri-foot flex items-center justify-between gap-2 border-t border-white/15 px-3 py-2.5">
        <button
          onClick={onOpen}
          className="iri-pill -my-2.5 -ml-3 flex min-w-0 items-center self-stretch rounded-none !border-y-0 !border-l-0 px-3 text-sm font-semibold"
        >
          <span className="truncate">{s.name}</span>
        </button>
        <span className="shrink-0 text-xs font-medium text-[#ece7ff]">{tp("{n} pictures", s.count)}</span>
      </div>
      <div className="flex items-center gap-1.5 border-t border-white/10 px-2.5 py-2">
        <span className="flex min-w-0 flex-1 items-center gap-1.5 text-xs text-zinc-200">
          <Clock className="h-3.5 w-3.5 shrink-0 text-[#bae6fd]" />
          <span className="truncate">{times(s.minutes).slice(-1)[0]}</span>
        </span>
        <Button
          variant="outline"
          size="sm"
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
