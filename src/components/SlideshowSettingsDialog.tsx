import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { motion } from "framer-motion";
import { MonitorPlay } from "lucide-react";
import { Button } from "@/components/ui/Button";
import {
  DEFAULT_SLIDESHOW,
  getSlideshowSettings,
  saveSlideshowSettings,
  type SlideshowFit,
  type SlideshowSettings,
} from "@/api/library";
import { useDialogTheme } from "@/lib/dialogTheme";
import { toggleOnClass, useAccent } from "@/lib/theme";
import { useT, useTf } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/** Interval presets in minutes, anything else is "Custom". */
const PRESETS = [1, 5, 10, 30, 60];

const FITS: { key: SlideshowFit; label: string; hint: string }[] = [
  { key: "fill", label: "Fill", hint: "Covers the whole screen; the edges may be cut off" },
  { key: "stretch", label: "Stretch", hint: "Pulled to the screen's shape; the picture may be distorted" },
  { key: "fit", label: "Fit", hint: "The whole picture, with bars where the shapes differ" },
];

/**
 * Desktop slideshow settings: interval, picture position and shuffle.
 * Opened by right-clicking the collection tab's wallpaper button.
 * Every "set as slideshow" uses these.
 */
export function SlideshowSettingsDialog({ onClose }: { onClose: () => void }) {
  const t = useT();
  const tf = useTf();
  const accent = useAccent();
  const dlg = useDialogTheme();
  const [s, setS] = useState<SlideshowSettings | null>(null);
  // custom is its own mode so the input shows even with a preset value
  const [custom, setCustom] = useState(false);
  const [customText, setCustomText] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let alive = true;
    getSlideshowSettings()
      .catch(() => DEFAULT_SLIDESHOW)
      .then((v) => {
        if (!alive) return;
        setS(v);
        setCustom(!PRESETS.includes(v.minutes));
        setCustomText(String(v.minutes));
      });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const customMinutes = Number(customText);
  const customValid = Number.isInteger(customMinutes) && customMinutes >= 1 && customMinutes <= 1440;
  const minutes = custom ? customMinutes : (s?.minutes ?? DEFAULT_SLIDESHOW.minutes);
  const canSave = !!s && !saving && (!custom || customValid);

  const save = async () => {
    if (!s || !canSave) return;
    setSaving(true);
    try {
      await saveSlideshowSettings({ ...s, minutes });
      onClose();
    } catch (e) {
      // stay open with the choices so nothing is lost
      console.error("saving slideshow settings failed", e);
    } finally {
      setSaving(false);
    }
  };

  // own "picked" style per theme (the dialog tint was invisible on cyberpunk)
  const chosen =
    accent === "cyberpunk"
      ? "border-[#fcee0a] bg-[#fcee0a] text-zinc-950"
      : accent === "sakura"
        ? "border-pink-300/70 bg-pink-500/25 text-pink-50"
        : accent === "iridescent"
          ? "border-white/50 text-white [background-image:linear-gradient(100deg,rgba(196,181,253,0.4),rgba(245,194,255,0.4)_50%,rgba(167,243,208,0.35))]"
          : "border-brand-500/70 bg-brand-500/25 text-brand-100";
  const chip = (on: boolean) =>
    cn(
      "inline-flex h-8 items-center justify-center px-3 text-xs transition-colors",
      dlg.control,
      on && cn("font-medium", chosen),
    );
  const label = "mb-2 block text-[11px] font-medium uppercase tracking-wide text-zinc-500";
  const intervalLabel = (m: number) => (m === 60 ? t("1 hour") : tf("{n} min", { n: m }));

  return createPortal(
    <div
      className="fixed inset-0 z-[120] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <motion.div
        initial={{ opacity: 0, y: 12, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        role="dialog"
        aria-label={t("Slideshow settings")}
        className={cn("w-[29rem] max-w-full p-5", dlg.panel)}
      >
        <div className="mb-4 flex items-start gap-3">
          <div
            className={cn(
              "flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-white/5",
              dlg.accentText,
            )}
          >
            <MonitorPlay className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-zinc-100">{t("Slideshow settings")}</h2>
            <p className="mt-0.5 text-xs text-zinc-400">
              {t("Used whenever MiColl sets a desktop wallpaper slideshow.")}
            </p>
          </div>
        </div>

        {s && (
          <div className="space-y-4">
            <div>
              <span className={label}>{t("Change picture every")}</span>
              <div className="flex flex-wrap gap-1.5">
                {PRESETS.map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => {
                      setCustom(false);
                      setS({ ...s, minutes: m });
                    }}
                    className={chip(!custom && s.minutes === m)}
                  >
                    {intervalLabel(m)}
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => setCustom(true)}
                  className={chip(custom)}
                >
                  {t("Custom")}
                </button>
              </div>
              {custom && (
                <label className="mt-2 flex items-center gap-2 text-xs text-zinc-400">
                  <input
                    autoFocus
                    inputMode="numeric"
                    value={customText}
                    onChange={(e) => setCustomText(e.target.value.replace(/\D/g, "").slice(0, 4))}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void save();
                    }}
                    className={cn(
                      "h-8 w-20 px-2 text-sm text-zinc-100 outline-none",
                      dlg.field,
                      !customValid && "border-rose-500/60",
                    )}
                  />
                  {t("minutes (1–1440)")}
                </label>
              )}
            </div>

            <div>
              <span className={label}>{t("Picture position")}</span>
              <div className="flex flex-wrap gap-1.5">
                {FITS.map((f) => (
                  <button
                    key={f.key}
                    type="button"
                    title={t(f.hint)}
                    onClick={() => setS({ ...s, fit: f.key })}
                    className={chip(s.fit === f.key)}
                  >
                    {t(f.label)}
                  </button>
                ))}
              </div>
            </div>

            <button
              type="button"
              role="switch"
              aria-checked={s.shuffle}
              onClick={() => setS({ ...s, shuffle: !s.shuffle })}
              className={cn("flex w-full items-center gap-3 px-3 py-2.5 text-left", dlg.box)}
            >
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium text-zinc-100">{t("Shuffle")}</span>
                <span className="block text-[11px] leading-tight text-zinc-400">
                  {t("Random order instead of the collection's own")}
                </span>
              </span>
              <span
                data-on={s.shuffle ? "" : undefined}
                className={cn(
                  "micoll-switch relative h-5 w-9 shrink-0 rounded-full transition-colors",
                  s.shuffle
                    ? toggleOnClass(accent)
                    : accent === "iridescent"
                      ? "bg-white/25"
                      : "bg-zinc-700",
                )}
              >
                <span
                  className={cn(
                    "micoll-switch-knob absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all",
                    s.shuffle ? "left-[1.125rem]" : "left-0.5",
                  )}
                />
              </span>
            </button>

            <p className="text-[11px] text-zinc-500">
              {t("Takes effect the next time you set a slideshow.")}
            </p>
          </div>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            {t("Cancel")}
          </Button>
          <Button variant="primary" onClick={() => void save()} disabled={!canSave} className={dlg.primary}>
            {t("Save")}
          </Button>
        </div>
      </motion.div>
    </div>,
    document.body,
  );
}
