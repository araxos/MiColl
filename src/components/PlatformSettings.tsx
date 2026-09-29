import { useMemo, useState } from "react";
import { Layers, Plus, X } from "lucide-react";
import { useData } from "@/store";
import { usePlatformOptions, addPlatform, removePlatform } from "@/lib/platformRegistry";
import { PLATFORMS } from "@/lib/platforms";
import { cn } from "@/lib/utils";
import { useT, useTf } from "@/lib/i18n";

/**
 * Settings section for the platform list: add or remove platforms.
 * Removing only hides it from the menus, creators keep it.
 */
export function PlatformSettings({ glass, irid, iriInner }: { glass: string; irid: boolean; iriInner: string }) {
  const t = useT();
  const tf = useTf();
  const { artists } = useData();
  const [draft, setDraft] = useState("");

  // same list and hook as the "+ Platform" menus, so both always match
  const options = usePlatformOptions(artists);

  // all built-ins that aren't in the list (also removed ones), so they can be added back
  const suggestions = useMemo(() => {
    const known = new Set(options.map((p) => p.toLowerCase()));
    return PLATFORMS.filter((p) => !known.has(p.toLowerCase()));
  }, [options.join("")]);

  // how many creators use each platform (removing doesn't delete anything)
  const usage = useMemo(() => {
    const m = new Map<string, number>();
    for (const a of artists)
      for (const p of a.platforms) {
        const k = p.name.trim().toLowerCase();
        m.set(k, (m.get(k) ?? 0) + 1);
      }
    return m;
  }, [artists]);

  const add = () => {
    const nm = draft.trim();
    if (nm) addPlatform(nm);
    setDraft("");
  };

  const chip = irid
    ? "border-white/20 bg-white/10 text-zinc-100"
    : "border-zinc-700 bg-zinc-900 text-zinc-200";
  const field = cn(
    "h-9 rounded-lg border px-2.5 text-sm outline-none",
    irid
      ? "border-white/20 bg-white/10 text-zinc-50 placeholder:text-zinc-300 focus:border-white/40"
      : "border-zinc-700 bg-zinc-950 text-zinc-100 focus:border-brand-500/60",
  );

  return (
    <section className={glass}>
      <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight text-zinc-50">
        <Layers className="h-6 w-6 text-brand-300" />
        {t("Platforms")}
      </h1>
      <p className="settings-desc mt-1 text-sm text-zinc-400">
        {t(
          "The platforms offered when adding one to a creator, importing, or creating a card. Removing a platform only takes it off this list — creators that already have it keep it.",
        )}
      </p>

      <div className="mt-4 flex flex-wrap gap-2">
        {options.map((p) => {
          const used = usage.get(p.toLowerCase()) ?? 0;
          return (
            <span
              key={p}
              className={cn("inline-flex items-center gap-1.5 rounded-full border py-1 pl-3 pr-1.5 text-sm", chip)}
            >
              {p}
              {used > 0 && (
                <span
                  className={cn("text-xs", irid ? "text-white/80" : "text-zinc-500")}
                  title={tf("Used by {n} creators", { n: used })}
                >
                  {used}
                </span>
              )}
              <button
                onClick={() => removePlatform(p)}
                title={
                  used > 0
                    ? tf("Remove “{name}” from the list — the {n} creators using it keep it", {
                        name: p,
                        n: used,
                      })
                    : tf("Remove “{name}” from the list", { name: p })
                }
                className="grid h-5 w-5 place-items-center rounded-full text-zinc-500 transition-colors hover:bg-rose-500/20 hover:text-rose-300"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </span>
          );
        })}
      </div>

      {/* add a platform */}
      <div className="mt-4 flex items-center gap-2">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") add();
          }}
          placeholder={t("New platform name…")}
          className={cn("w-56", field)}
        />
        <button
          onClick={add}
          disabled={!draft.trim()}
          className={cn(
            "inline-flex h-9 items-center gap-1.5 rounded-lg border px-3 text-sm font-medium transition-colors disabled:opacity-40",
            irid
              ? "border-white/25 bg-white/15 text-white hover:bg-white/25"
              : "border-brand-500/40 bg-brand-500/15 text-brand-100 hover:bg-brand-500/25",
          )}
        >
          <Plus className="h-4 w-4" />
          {t("Add platform")}
        </button>
      </div>

      {/* built-ins not in the list, so you don't have to type them (and misspell them) */}
      {suggestions.length > 0 && (
        <div className={cn("mt-5 rounded-xl border p-3", irid ? iriInner : "border-zinc-800 bg-zinc-900/40")}>
          <div className="text-xs font-medium text-zinc-400">{t("Common platforms")}</div>
          {/* one row that scrolls sideways instead of wrapping */}
          <div className="-mx-3 mt-2 flex gap-2 overflow-x-auto px-3 pb-1.5">
            {suggestions.map((p) => (
              <button
                key={p}
                onClick={() => addPlatform(p)}
                title={tf("Add “{name}” to the list", { name: p })}
                className={cn(
                  "inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-3 py-1 text-sm text-zinc-400 transition-colors",
                  irid ? "border-white/15 hover:bg-white/10" : "border-zinc-700 micoll-hover",
                )}
              >
                <Plus className="h-3.5 w-3.5" />
                {p}
              </button>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
