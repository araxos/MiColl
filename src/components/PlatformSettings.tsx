import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ChevronRight, Layers, Plus, X } from "lucide-react";
import { CreatorAvatar } from "@/components/CommandPalette";
import type { Artist } from "@/types";
import { useData } from "@/store";
import { usePlatformOptions, addPlatform, isMiscPlatform, removePlatform } from "@/lib/platformRegistry";
import { PLATFORMS } from "@/lib/platforms";
import { cn } from "@/lib/utils";
import { useT, useTf, useTp } from "@/lib/i18n";

/**
 * Settings section for the platform list: add or remove platforms.
 * Removing only hides it from the menus, creators keep it.
 */
export function PlatformSettings({ glass, irid }: { glass: string; irid: boolean }) {
  const t = useT();
  const tf = useTf();
  const tp = useTp();
  const navigate = useNavigate();
  const { artists } = useData();
  const [draft, setDraft] = useState("");
  // the platform whose creators are listed below the chips
  const [open, setOpen] = useState<string | null>(null);

  // same list and hook as the "+ Platform" menus, so both always match
  const options = usePlatformOptions(artists);

  // all built-ins that aren't in the list (also removed ones), so they can be added back
  const suggestions = useMemo(() => {
    const known = new Set(options.map((p) => p.toLowerCase()));
    return PLATFORMS.filter((p) => !known.has(p.toLowerCase()));
  }, [options.join("")]);

  // who uses each platform and with how many rewards (removing doesn't delete anything)
  const users = useMemo(() => {
    const m = new Map<string, { name: string; list: { artist: Artist; rewards: number }[] }>();
    for (const a of artists)
      for (const p of a.platforms) {
        const k = p.name.trim().toLowerCase();
        if (!k) continue;
        const rewards = p.months.reduce((n, mo) => n + mo.rewards.filter((r) => !r.collabFrom).length, 0);
        const e = m.get(k) ?? { name: p.name.trim(), list: [] };
        const had = e.list.find((x) => x.artist.id === a.id);
        if (had) had.rewards += rewards;
        else e.list.push({ artist: a, rewards });
        m.set(k, e);
      }
    for (const e of m.values()) e.list.sort((x, y) => x.artist.name.localeCompare(y.artist.name));
    return m;
  }, [artists]);
  const usage = useMemo(() => new Map([...users].map(([k, e]) => [k, e.list.length])), [users]);
  // in use but not offered: "Misc" from before it was locked, platforms taken off the list
  const leftovers = useMemo(() => {
    const offered = new Set(options.map((p) => p.trim().toLowerCase()));
    return [...users.entries()]
      .filter(([k]) => !offered.has(k) && k !== "unsorted")
      .map(([, e]) => e.name)
      .sort((a, b) => Number(isMiscPlatform(b)) - Number(isMiscPlatform(a)) || a.localeCompare(b));
  }, [users, options.join("")]);
  const openEntry = open ? users.get(open.trim().toLowerCase()) : undefined;
  const toggle = (p: string) => setOpen((o) => (o?.toLowerCase() === p.toLowerCase() ? null : p));
  const isOpen = (p: string) => open?.toLowerCase() === p.toLowerCase();

  const miscTyped = isMiscPlatform(draft);
  const add = () => {
    if (miscTyped) return;
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
      <h1 className="flex items-center gap-2 settings-title text-2xl font-bold tracking-tight text-zinc-50">
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
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full border py-1 pl-3 pr-1.5 text-sm",
                chip,
                isOpen(p) && "ring-2 ring-brand-400/60",
              )}
            >
              {/* click: the creators that use it */}
              <button
                onClick={() => toggle(p)}
                disabled={used === 0}
                title={used > 0 ? tf("Used by {n} creators", { n: used }) : undefined}
                className="inline-flex items-center gap-1.5 disabled:cursor-default"
              >
                {p}
                {used > 0 && <span className={cn("text-xs", irid ? "text-white/80" : "text-zinc-500")}>{used}</span>}
              </button>
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

      {/* in use but not on the list (Misc from before it was locked): count and creators,
          so they can be cleaned up. No remove, there's nothing to take off */}
      {leftovers.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className="text-xs text-zinc-500">{t("Still in use:")}</span>
          {leftovers.map((p) => {
            const used = usage.get(p.toLowerCase()) ?? 0;
            const misc = isMiscPlatform(p);
            return (
              <button
                key={p}
                onClick={() => toggle(p)}
                title={
                  misc
                    ? t("“Misc” can’t be a platform any more — these creators still have it. Click to see them.")
                    : tf("Used by {n} creators", { n: used })
                }
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-full border border-dashed px-3 py-1 text-sm",
                  misc ? "border-amber-400/50 bg-amber-500/10 text-amber-200" : chip,
                  isOpen(p) && "ring-2 ring-brand-400/60",
                )}
              >
                {p}
                <span className={cn("text-xs", misc ? "text-amber-300/80" : "text-zinc-500")}>{used}</span>
              </button>
            );
          })}
        </div>
      )}

      {/* the creators on the clicked platform; a click opens the creator */}
      {open && openEntry && (
        <div className={cn("mt-3 overflow-hidden rounded-xl border", irid ? "border-white/15 bg-white/5" : "border-zinc-800 bg-zinc-950/60")}>
          <div className={cn("flex items-center justify-between border-b px-3 py-2", irid ? "border-white/10" : "border-zinc-800")}>
            <span className="text-sm font-semibold text-zinc-100">
              {openEntry.name}
              <span className="ml-2 text-xs font-normal text-zinc-500">
                {tp("{n} creators", openEntry.list.length)} ·{" "}
                {tp("{n} rewards", openEntry.list.reduce((n, x) => n + x.rewards, 0))}
              </span>
            </span>
            <button onClick={() => setOpen(null)} className="text-zinc-500 hover:text-zinc-300" title={t("Close")}>
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="max-h-72 overflow-y-auto p-1">
            {openEntry.list.map(({ artist: a, rewards }) => (
              <button
                key={a.id}
                onClick={() => navigate(`/artist/${a.id}`)}
                className={cn(
                  "flex w-full items-center gap-3 rounded-lg px-2 py-1.5 text-left transition-colors",
                  irid ? "hover:bg-white/10" : "micoll-hover",
                )}
              >
                <span className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-zinc-800">
                  <CreatorAvatar path={a.previewPath} alts={a.previewAlts} name={a.name} />
                </span>
                <span className="min-w-0 flex-1 truncate text-sm text-zinc-100">{a.name}</span>
                <span className="shrink-0 text-xs tabular-nums text-zinc-500">{tp("{n} rewards", rewards)}</span>
                <ChevronRight className="h-4 w-4 shrink-0 text-zinc-500" />
              </button>
            ))}
          </div>
        </div>
      )}

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
          disabled={!draft.trim() || miscTyped}
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
      {miscTyped && <p className="mt-1.5 text-xs text-amber-300">{t("“Misc” can’t be a platform.")}</p>}

      {/* built-ins not in the list, so you don't have to type them (and misspell them) */}
      {suggestions.length > 0 && (
        <div className="mt-5">
          <div className="text-xs font-medium text-zinc-400">{t("Common platforms")}</div>
          {/* one row that scrolls sideways instead of wrapping */}
          <div className="mt-2 flex gap-2 overflow-x-auto pb-1.5">
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
