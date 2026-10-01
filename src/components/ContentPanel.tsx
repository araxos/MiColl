import { useEffect, useState } from "react";
import { Eye, Keyboard, X } from "lucide-react";
import {
  useSfwMode,
  setSfwMode,
  getModeHotkey,
  setModeHotkey,
  comboLabel,
  eventToCombo,
  getHomeDblToggle,
  setHomeDblToggle,
} from "@/lib/contentMode";
import { useAccent, toggleOnClass } from "@/lib/theme";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n";

/** Simple on/off switch. */
function Switch({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  const accent = useAccent();
  return (
    <button
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={cn(
        "micoll-switch relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors",
        checked ? toggleOnClass(accent) : "bg-zinc-700",
      )}
    >
      <span
        className={cn(
          "micoll-switch-knob inline-block h-5 w-5 transform rounded-full bg-white transition-transform",
          checked ? "translate-x-5" : "translate-x-0.5",
        )}
      />
    </button>
  );
}

export function ContentPanel() {
  const t = useT();
  const sfw = useSfwMode();
  const accent = useAccent();
  // iridescent: light frosted cards instead of dark ones
  const irid = accent === "iridescent";
  const iriInner = "glass-box border-white/15 bg-white/10 backdrop-blur-md";
  const [hotkey, setHotkey] = useState(getModeHotkey);
  const [homeDbl, setHomeDbl] = useState(getHomeDblToggle);
  const [recording, setRecording] = useState(false);

  // while recording, save the next key combo
  useEffect(() => {
    if (!recording) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation(); // don't let the global toggler fire during capture
      if (e.key === "Escape") {
        setRecording(false);
        return;
      }
      const combo = eventToCombo(e);
      if (!combo) return; // modifier-only press — keep waiting
      setModeHotkey(combo);
      setHotkey(combo);
      setRecording(false);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [recording]);

  return (
    <div>
      <div className="flex items-center gap-2">
        <Eye className="h-6 w-6 text-brand-300" />
        <h1 className="settings-title text-2xl font-bold tracking-tight text-zinc-50">{t("Content")}</h1>
      </div>
      <p className="settings-desc mt-1 text-sm text-zinc-400">
        {t(
          "SFW mode hides every creator tagged nsfw — they’re only hidden, never deleted. Switch instantly with the pill in the top bar, a shortcut, or a double-click on the Home icon.",
        )}
      </p>

      <div className="mt-5 space-y-3">
        {/* SFW mode */}
        <div className={cn("glass-box flex items-center justify-between gap-3 rounded-xl border border-zinc-800 bg-zinc-900 p-4", irid && iriInner)}>
          <div>
            <div className="text-sm font-medium text-zinc-100">{t("SFW mode")}</div>
            <div className="mt-0.5 text-xs text-zinc-500">
              {t("Hide NSFW-tagged creators from the dashboard.")}
            </div>
          </div>
          <Switch checked={sfw} onChange={setSfwMode} />
        </div>

        {/* shortcut */}
        <div className={cn("glass-box flex items-center justify-between gap-3 rounded-xl border border-zinc-800 bg-zinc-900 p-4", irid && iriInner)}>
          <div className="min-w-0">
            <div className="text-sm font-medium text-zinc-100">{t("Quick-switch shortcut")}</div>
            <div className="mt-0.5 text-xs text-zinc-500">
              {recording
                ? t("Press a key combo… (Esc to cancel)")
                : t("A global hotkey to flip SFW/NSFW.")}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setRecording((r) => !r)}
              className={`inline-flex min-w-28 items-center justify-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm transition-colors ${
                recording
                  ? "border-brand-500/60 bg-brand-500/15 text-brand-200"
                  : "border-zinc-700 bg-zinc-800/60 text-zinc-200 micoll-hover"
              }`}
            >
              <Keyboard className="h-4 w-4" />
              {recording ? t("Recording…") : comboLabel(hotkey)}
            </button>
            {hotkey && !recording && (
              <button
                onClick={() => {
                  setModeHotkey("");
                  setHotkey("");
                }}
                title={t("Clear shortcut")}
                className="text-zinc-500 hover:text-rose-300"
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </div>
        </div>

        {/* home double-click */}
        <div className={cn("glass-box flex items-center justify-between gap-3 rounded-xl border border-zinc-800 bg-zinc-900 p-4", irid && iriInner)}>
          <div>
            <div className="text-sm font-medium text-zinc-100">{t("Double-click Home to switch")}</div>
            <div className="mt-0.5 text-xs text-zinc-500">
              {t("Double-click the Home icon (top-left) to flip modes fast.")}
            </div>
          </div>
          <Switch
            checked={homeDbl}
            onChange={(v) => {
              setHomeDblToggle(v);
              setHomeDbl(v);
            }}
          />
        </div>
      </div>
    </div>
  );
}
