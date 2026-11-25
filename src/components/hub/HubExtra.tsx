import { useCallback, useContext, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AlertTriangle, ChevronRight, Clock, Copy, LockKeyhole, ZoomIn } from "lucide-react";
import {
  CLOSE_TO_TRAY_KEY,
  getAutostart,
  getSetting,
  openWindowsSaver,
  setAutostart,
  setCloseToTray,
  setSetting,
  type SaverOptions,
} from "@/api/library";
import { useActions } from "@/actions";
import { KeepRunningDialog } from "@/components/hub/KeepRunningDialog";
import { Button } from "@/components/ui/Button";
import { ThemedSelect } from "@/components/ThemedSelect";
import { HubTargetContext, useEveryLabel, useHubBox, useSecondsLabel } from "@/components/hub/shared";
import { useDialogTheme } from "@/lib/dialogTheme";
import { useT } from "@/lib/i18n";
import { KEEP_RUNNING_HINT } from "@/lib/warnings";
import { cn } from "@/lib/utils";

/** Minutes without input, seconds between pictures. */
const AFTER = [1, 2, 3, 5, 10, 15, 20, 30, 45, 60];
const EVERY = [5, 10, 15, 20, 30, 60, 120, 300];

const withValue = (list: number[], v: number) => [...new Set([...list, v])].sort((a, b) => a - b);

/**
 * What belongs to the place the hub is showing and not to one slideshow: the screen
 * saver's options, and a hint when MiColl isn't always running (lock screen too), which
 * opens a window with the settings for it. Under the bar of the overview and under an
 * opened slideshow's box.
 */
export function HubExtra({ className }: { className?: string }) {
  const t = useT();
  const { target, saver, onSaver } = useContext(HubTargetContext);
  const dlg = useDialogTheme();
  const box = useHubBox();
  const every = useEveryLabel();
  const seconds = useSecondsLabel();
  const navigate = useNavigate();
  const { showToast } = useActions();
  // (on until it's known, so the hint doesn't flash up)
  const [tray, setTray] = useState(true);
  const [autostart, setStart] = useState(true);
  const [dismissed, setDismissed] = useState(false);
  const [asking, setAsking] = useState(false);
  useEffect(() => {
    void Promise.all([getSetting(CLOSE_TO_TRAY_KEY), getAutostart(), getSetting(KEEP_RUNNING_HINT)])
      .then(([tr, start, hint]) => {
        setTray(tr === "true");
        setStart(start);
        setDismissed(hint === "off");
      })
      .catch(() => {});
  }, []);
  /** Change one of the two, back when it didn't work. */
  const change = (set: (on: boolean) => void, save: (on: boolean) => Promise<void>) => (on: boolean) => {
    set(on);
    save(on).catch((e) => {
      set(!on);
      showToast({ tone: "error", title: t("Couldn’t save the change"), detail: `${e}` });
    });
  };
  const close = useCallback(() => setAsking(false), []);

  const ownSaver = target === "saver" && !!saver?.windowsHasOwn;
  const hint =
    target === "desktop" || dismissed || (tray && autostart)
      ? null
      : tray
        ? t("It only runs once you’ve started MiColl. With “Start with Windows” it’s always there.")
        : t("It stops when you close MiColl. With “Keep running in the tray” it goes on.");
  const options = target === "saver" ? saver : null;
  const dialog = asking && (
    <KeepRunningDialog
      tray={tray}
      autostart={autostart}
      onTray={change(setTray, setCloseToTray)}
      onAutostart={change(setStart, setAutostart)}
      onSettings={() => navigate("/settings#performance")}
      onDismiss={() => {
        setDismissed(true);
        close();
        void setSetting(KEEP_RUNNING_HINT, "off").catch(() => {});
      }}
      onClose={close}
    />
  );
  if (!options && !ownSaver && !hint) return dialog || null;

  const toggles = [
    ["zoom", ZoomIn, t("Slow zoom"), t("The pictures slowly grow or shrink")],
    ["clock", Clock, t("Clock"), t("Shows the time and date")],
    ["same", Copy, t("Same on every screen"), t("Otherwise every screen shows another picture")],
    ["lock", LockKeyhole, t("Lock the PC afterwards"), t("When it ends you sign in to Windows again")],
  ] as const satisfies readonly (readonly [keyof SaverOptions, unknown, string, string])[];
  const select = (label: string, key: "after" | "every", list: number[], text: (n: number) => string, v: number) => (
    <div className="flex items-center gap-2">
      <span className="text-xs uppercase tracking-wide text-zinc-500">{label}</span>
      <ThemedSelect
        value={String(v)}
        onChange={(x) => onSaver({ [key]: Number(x) })}
        options={withValue(list, v).map((n) => ({ value: String(n), label: text(n) }))}
        title={label}
        ink="text-zinc-100"
        className={cn("h-8 w-28 px-2.5 text-sm", dlg.field)}
        minWidth={112}
      />
    </div>
  );

  return (
    <div className={cn("flex flex-col gap-3 px-4 py-3", box, className)}>
      {options && (
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
          <div>
            <div className="text-sm font-semibold text-zinc-100">{t("Screen saver")}</div>
            <div className="text-xs text-zinc-500">{t("For every slideshow")}</div>
          </div>
          {select(t("Starts after"), "after", AFTER, every, options.after)}
          {select(t("Change picture every"), "every", EVERY, seconds, options.every)}
          <div className="flex flex-wrap gap-1.5">
            {toggles.map(([key, Icon, label, tip]) => (
              <button
                key={key}
                onClick={() => onSaver({ [key]: !options[key] })}
                aria-pressed={!!options[key]}
                className={cn("inline-flex items-center gap-1.5 px-2.5 py-1 text-xs", options[key] ? dlg.controlOn : dlg.control)}
                title={tip}
              >
                <Icon className="h-3.5 w-3.5" />
                {label}
              </button>
            ))}
          </div>
        </div>
      )}
      {ownSaver && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-amber-200">
          <AlertTriangle className="h-4 w-4 shrink-0 text-amber-300" />
          <span className="min-w-0 flex-1">
            {t("Windows has a screen saver of its own turned on, turn that one off.")}
          </span>
          <Button variant="outline" size="sm" onClick={() => void openWindowsSaver().catch(() => {})}>
            {t("Open Windows settings")}
          </Button>
        </div>
      )}
      {hint && (
        <button
          onClick={() => setAsking(true)}
          className="group flex w-full items-center gap-3 text-left text-sm text-amber-200 transition-colors hover:text-amber-100"
        >
          <AlertTriangle className="h-4 w-4 shrink-0 text-amber-300" />
          <span className="min-w-0 flex-1">{hint}</span>
          <ChevronRight className="h-4 w-4 shrink-0 transition-transform group-hover:translate-x-0.5" />
        </button>
      )}
      {dialog}
    </div>
  );
}
