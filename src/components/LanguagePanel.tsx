import { Languages } from "lucide-react";
import { ThemedSelect } from "@/components/ThemedSelect";
import {
  LANGUAGES,
  resolveLanguage,
  setLanguage,
  useLanguage,
  useT,
  type LangKey,
} from "@/lib/i18n";
import { useAccent } from "@/lib/theme";
import { useDialogTheme } from "@/lib/dialogTheme";
import { cn } from "@/lib/utils";

/**
 * Settings -> Language.
 * A dropdown (ThemedSelect, not a native select that would look grey).
 * Every option is written in its own language (日本語 etc).
 * "Follow the system" is saved as its own value, so it follows Windows later too.
 */
export function LanguagePanel() {
  const t = useT();
  const choice = useLanguage();
  const accent = useAccent();
  const dlg = useDialogTheme();
  const irid = accent === "iridescent";
  const iriInner = "glass-box border-white/15 bg-white/10 backdrop-blur-md";

  const active = resolveLanguage(choice);
  const def = LANGUAGES.find((l) => l.key === active);

  const options = [
    { value: "system", label: t("Follow the system") },
    ...LANGUAGES.map((l) => ({ value: l.key, label: l.native })),
  ];

  return (
    <div>
      <div className="flex items-center gap-2">
        <Languages className="h-6 w-6 text-brand-300" />
        <h1 className="text-2xl font-bold tracking-tight text-zinc-50">{t("Language")}</h1>
      </div>
      <p className="settings-desc mt-1 text-sm text-zinc-400">
        {t(
          "The language MiColl speaks. Your choice is kept with the library, so it survives an update, a reinstall and a restored backup.",
        )}
      </p>

      <div className="mt-5 space-y-3">
        <div
          className={cn(
            "glass-box flex items-center justify-between gap-3 rounded-xl border border-zinc-800 bg-zinc-900 p-4",
            irid && iriInner,
          )}
        >
          {/* left shows the current language, right changes it */}
          <div className="min-w-0">
            <div className="text-sm font-medium text-zinc-100" lang={active}>
              {def?.native ?? active}
            </div>
            <div className="mt-0.5 truncate text-xs text-zinc-500">
              {choice === "system"
                ? `${t("Follow the system")} — ${def?.english ?? active}`
                : (def?.english ?? active)}
            </div>
          </div>
          <ThemedSelect
            value={choice}
            onChange={(v) => setLanguage(v as LangKey)}
            options={options}
            title={t("Language")}
            ink="text-zinc-100"
            className={cn("h-9 w-52 shrink-0 px-3 text-sm", dlg.field)}
            minWidth={208}
          />
        </div>

        {/* note that not everything is translated yet (remove once it is) */}
        <div
          className={cn(
            "glass-box rounded-xl border border-zinc-800 bg-zinc-900 p-4",
            irid && iriInner,
          )}
        >
          <div className="text-sm font-medium text-zinc-100">
            {t("Not everything is translated yet")}
          </div>
          <p className="mt-0.5 text-xs text-zinc-500">
            {t(
              "The settings navigation and the top bar follow your choice. The rest of MiColl still reads English until its text has been translated too.",
            )}
          </p>
        </div>
      </div>
    </div>
  );
}
