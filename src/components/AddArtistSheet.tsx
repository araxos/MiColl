import { useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import { open } from "@tauri-apps/plugin-dialog";
import {
  X,
  Image as ImageIcon,
  FolderInput,
  UserPlus,
  Loader2,
  Plus,
  CalendarDays,
  CalendarOff,
  Hash,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { useData } from "@/store";
import { useAccent } from "@/lib/theme";
import { useDialogTheme } from "@/lib/dialogTheme";
import { CREATOR_TYPES } from "@/lib/creatorTypes";
import type { ReleaseStyle } from "@/types";
import { usePlatformOptions, addPlatform as registerPlatform } from "@/lib/platformRegistry";
import { initials, cn } from "@/lib/utils";
import { useT } from "@/lib/i18n";
import * as api from "@/api/library";

/** How the creator releases (same 3 options as the import review and the platform menu). */
const RELEASE_STYLES: { key: ReleaseStyle; label: string; hint: string; Icon: typeof Hash }[] = [
  {
    key: "monthly",
    label: "Monthly",
    hint: "Year and month folders",
    Icon: CalendarDays,
  },
  {
    key: "numbered",
    label: "Numbered drops",
    hint: "Each drop its own card (#51, #52) — no dates",
    Icon: Hash,
  },
  {
    key: "none",
    label: "No schedule",
    hint: "Just rewards — no period cards at all",
    Icon: CalendarOff,
  },
];

/**
 * Sheet to create a new card (artist): name, types, thumbnail and optionally
 * empty folders (platforms x years x months) to fill later.
 */
export function AddArtistSheet({ onClose }: { onClose: () => void }) {
  const t = useT();
  const { refresh, artists } = useData();
  const accent = useAccent();
  const irid = accent === "iridescent";
  const sakura = accent === "sakura";
  // premium themes use the shared dialog theme, standard ones keep the old panel
  const premium = sakura || irid || accent === "cyberpunk";
  const dlg = useDialogTheme();
  // premium themes get their own surface, standard ones the plain dark panel
  const panelClass =
    accent === "cyberpunk"
      ? "rounded-none border border-[#fcee0a]/70 bg-zinc-950/95 ring-1 ring-inset ring-[#00e5ff]/15 shadow-[0_0_26px_rgba(252,238,10,0.18)] [clip-path:polygon(0_0,100%_0,100%_calc(100%-14px),calc(100%-14px)_100%,0_100%)]"
      : accent === "iridescent"
        ? "iri-menu relative rounded-2xl border border-white/15 bg-zinc-900/80 ring-1 ring-inset ring-white/10 backdrop-blur-2xl [transform:translateZ(0)]"
        : accent === "sakura"
          ? "sak-card rounded-2xl"
          : "rounded-2xl border border-zinc-800 bg-zinc-900";

  // chip styles per theme. On iridescent a picked chip uses .pick-on.
  // All chips have a 2px border so picking one doesn't move the row.
  const chipCls = (on: boolean) =>
    cn(
      "rounded-lg border px-2.5 py-1 text-xs transition-colors",
      irid && "border-2",
      // sakura uses .sak-chip (its own border and radius win over the classes above)
      sakura
        ? cn("sak-chip sak-petal-cut", on && "sak-chip--lead")
        : on
          ? irid
            ? "pick-on text-white"
            : "border-brand-500 bg-brand-500/20 text-brand-200"
          : irid
            ? "border-white/20 bg-white/10 text-zinc-200 hover:bg-white/20"
            : "border-zinc-700 bg-zinc-800 text-zinc-300 micoll-hover",
    );
  // thumbnail tile. Uses the theme's card face instead of seedGradient(name),
  // which changed color on every key press.
  const tileFrame = cn(
    "group relative h-28 w-24 shrink-0 overflow-hidden",
    accent === "iridescent"
      ? "iri-edge rounded-none" // hard edge, same as the dashboard card
      : accent === "sakura"
        ? "sak-edge rounded-xl"
        : accent === "cyberpunk"
          ? "cp-chip rounded-none"
          : "rounded-xl border border-zinc-700 bg-zinc-800",
  );
  const tileFill =
    accent === "iridescent"
      ? "iri-face text-zinc-900"
      : accent === "sakura"
        ? "bg-[linear-gradient(150deg,#f9a8d4,#ea5ba6_55%,#b3306f)] text-white"
        : accent === "cyberpunk"
          ? "bg-[linear-gradient(160deg,#0c0e16,#06080d)] text-[#fcee0a] [text-shadow:0_0_10px_rgba(252,238,10,0.55)]"
          : "bg-[linear-gradient(150deg,var(--color-brand-500),var(--color-accent2-500))] text-white/90";
  const fieldCls = cn(
    "px-2.5 text-sm text-zinc-100 outline-none placeholder:text-zinc-500",
    premium
      ? dlg.field
      : "rounded-lg border border-zinc-700 bg-zinc-950 focus:border-brand-500/60",
  );

  const [name, setName] = useState("");
  const [kinds, setKinds] = useState<Set<string>>(new Set());
  const [previewPath, setPreviewPath] = useState<string | null>(null);
  const [previewData, setPreviewData] = useState<string>("");
  const [style, setStyle] = useState<ReleaseStyle>("monthly");
  // only monthly creators get year folders
  const dated = style === "monthly";
  const [platforms, setPlatforms] = useState<Set<string>>(new Set(["Patreon"]));
  const [customPlatforms, setCustomPlatforms] = useState<string[]>([]);
  const [newPlatform, setNewPlatform] = useState<string | null>(null);
  const thisYear = new Date().getFullYear();
  const [years, setYears] = useState<Set<number>>(new Set([thisYear]));
  const [newYear, setNewYear] = useState("");
  // off by default
  const [months, setMonths] = useState(false);

  const [managed, setManaged] = useState(false);
  const [collectionRoot, setCollectionRoot] = useState("");
  const [baseDir, setBaseDir] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void (async () => {
      const [enabled, root] = await Promise.all([
        api.getSetting("managed_enabled"),
        api.getSetting("collection_root"),
      ]);
      setManaged(enabled === "true");
      setCollectionRoot(root ?? "");
    })();
  }, []);

  // the shared platform list + anything typed in here
  const offered = usePlatformOptions(artists);
  const platformOptions = useMemo(() => {
    const out = [...offered];
    for (const p of customPlatforms) {
      const key = p.trim().toLowerCase();
      if (key && key !== "unsorted" && key !== "misc" && !out.some((x) => x.toLowerCase() === key)) {
        out.push(p);
      }
    }
    return out;
  }, [offered, customPlatforms]);

  // recent years + the ones the user added, newest first
  const yearChoices = useMemo(() => {
    const s = new Set<number>([thisYear, thisYear - 1, thisYear - 2, thisYear - 3, ...years]);
    return [...s].sort((a, b) => b - a);
  }, [years, thisYear]);

  const toggleKind = (k: string) =>
    setKinds((prev) => {
      const next = new Set(prev);
      next.has(k) ? next.delete(k) : next.add(k);
      return next;
    });

  const togglePlatform = (p: string) =>
    setPlatforms((prev) => {
      const next = new Set(prev);
      next.has(p) ? next.delete(p) : next.add(p);
      return next;
    });

  const addCustomPlatform = () => {
    const nm = (newPlatform ?? "").trim();
    if (!nm) {
      setNewPlatform(null);
      return;
    }
    registerPlatform(nm); // persist it to the shared offered list (un-hides if removed)
    if (!platformOptions.some((p) => p.toLowerCase() === nm.toLowerCase())) {
      setCustomPlatforms((prev) => [...prev, nm]);
    }
    setPlatforms((prev) => new Set(prev).add(nm)); // select it right away
    setNewPlatform(null);
  };

  const toggleYear = (y: number) =>
    setYears((prev) => {
      const next = new Set(prev);
      next.has(y) ? next.delete(y) : next.add(y);
      return next;
    });

  const addCustomYear = () => {
    const y = parseInt(newYear.trim(), 10);
    if (Number.isFinite(y) && y >= 1900 && y <= 2999) {
      setYears((prev) => new Set(prev).add(y));
    }
    setNewYear("");
  };

  const pickThumbnail = async () => {
    const picked = await open({
      multiple: false,
      title: t("Choose a creator thumbnail"),
      filters: [{ name: "Images", extensions: ["jpg", "jpeg", "png", "webp", "gif", "bmp"] }],
    });
    if (typeof picked === "string") {
      setPreviewPath(picked);
      try {
        setPreviewData(await api.readImage(picked));
      } catch {
        setPreviewData("");
      }
    }
  };

  const pickBaseFolder = async () => {
    const picked = await open({ directory: true, multiple: false, title: t("Choose where to create this creator’s folders") });
    if (typeof picked === "string") setBaseDir(picked);
  };

  // where the folders will be created (for the info line)
  const scaffoldTarget = useMemo(() => {
    const safe = name.trim() || "Creator";
    if (baseDir) return `${baseDir}\\${safe}`;
    if (managed && collectionRoot) return `${collectionRoot}\\MiColl\\${safe}`;
    return null;
  }, [baseDir, managed, collectionRoot, name]);

  const canCreate = name.trim().length > 0 && !busy;

  const create = async () => {
    if (!canCreate) return;
    setBusy(true);
    try {
      await api.createArtist({
        name: name.trim(),
        preview: previewPath,
        baseDir,
        platforms: [...platforms],
        years: dated ? [...years] : [],
        months,
        releaseStyle: style,
        // keep the CREATOR_TYPES order no matter the click order
        kind: kinds.size
          ? CREATOR_TYPES.filter((t) => kinds.has(t.key)).map((t) => t.key).join(",")
          : null,
      });
      await refresh();
      onClose();
    } catch (e) {
      console.error("create artist failed", e);
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
      {/* keep the top bar draggable while the sheet is open */}
      <div data-tauri-drag-region className="absolute inset-x-0 top-0 h-14" />
      <motion.div
        initial={{ opacity: 0, y: 12, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        className={cn("flex max-h-[90vh] w-[40rem] max-w-full flex-col overflow-hidden shadow-2xl", panelClass)}
      >
        <div className="flex items-center justify-between border-b border-white/10 px-5 py-4">
          <div className="flex items-center gap-2">
            <UserPlus className={cn("h-4 w-4", irid ? "text-white" : "text-brand-400")} />
            <h2 className="text-base font-semibold text-zinc-100">{t("Create card")}</h2>
          </div>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-300">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {/* thumbnail + name */}
          <div className="flex items-start gap-4">
            <button onClick={pickThumbnail} className={tileFrame} title={t("Choose a thumbnail")}>
              {previewData ? (
                <img src={previewData} alt="" className="h-full w-full object-cover" />
              ) : (
                <div
                  className={cn(
                    "flex h-full w-full items-center justify-center text-lg font-bold",
                    tileFill,
                  )}
                >
                  {initials(name || "?")}
                </div>
              )}
              <div className="absolute inset-x-0 bottom-0 flex items-center justify-center gap-1 bg-black/60 py-1 text-[10px] text-zinc-200 opacity-0 transition-opacity group-hover:opacity-100">
                <ImageIcon className="h-3 w-3" />
                {t("Change")}
              </div>
            </button>

            <div className="min-w-0 flex-1 space-y-3">
              <div>
                <label className="mb-1 block text-xs font-medium text-zinc-400">{t("Card name")}</label>
                <input
                  autoFocus
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={t("e.g. Misato Katsuragi")}
                  className={cn("h-9 w-full", fieldCls)}
                />
              </div>
              <div>
                <div className="mb-1 text-xs font-medium text-zinc-400">
                  {t("Releases")}{" "}
                  <span className="text-zinc-600">{t("— can be changed per platform later")}</span>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {RELEASE_STYLES.map((r) => (
                    <button
                      key={r.key}
                      onClick={() => setStyle(r.key)}
                      title={t(r.hint)}
                      className={cn("inline-flex items-center gap-1.5", chipCls(style === r.key))}
                    >
                      <r.Icon className="h-3.5 w-3.5" />
                      {t(r.label)}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>

          {/* creator types (saved as "kind") */}
          <div className="mt-5">
            <div className="text-xs font-medium text-zinc-400">
              Type <span className="text-zinc-600">— pick any that fit (optional)</span>
            </div>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {CREATOR_TYPES.map((t) => {
                const on = kinds.has(t.key);
                return (
                  <button
                    key={t.key}
                    onClick={() => toggleKind(t.key)}
                    className={cn("inline-flex items-center gap-1.5", chipCls(on))}
                  >
                    <t.Icon className={cn("h-3.5 w-3.5", t.color)} />
                    {t.label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* folders */}
          <div
            className={cn(
              "mt-5 p-4",
              premium ? dlg.box : "rounded-xl border border-zinc-800 bg-zinc-950/40",
            )}
          >
            <h3 className="text-sm font-medium text-zinc-200">{t("Create folder hierarchy")}</h3>
            <p className="mt-0.5 text-xs text-zinc-500">
              {t("Optional — makes empty folders you can drop rewards into later.")}
            </p>

            <div className="mt-3 text-xs font-medium text-zinc-400">{t("Platforms")}</div>
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              {platformOptions.map((p) => (
                <button key={p} onClick={() => togglePlatform(p)} className={chipCls(platforms.has(p))}>
                  {p}
                </button>
              ))}
              {newPlatform === null ? (
                <button
                  onClick={() => setNewPlatform("")}
                  className={cn("inline-flex items-center gap-1", chipCls(false))}
                  title={t("Add a custom platform")}
                >
                  <Plus className="h-3.5 w-3.5" />
                  {t("Platform")}
                </button>
              ) : (
                <span className="inline-flex items-center gap-1">
                  <input
                    autoFocus
                    value={newPlatform}
                    onChange={(e) => setNewPlatform(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") addCustomPlatform();
                      else if (e.key === "Escape") setNewPlatform(null);
                    }}
                    placeholder={t("New platform")}
                    className={cn("h-7 w-32", fieldCls)}
                  />
                  <button
                    onClick={addCustomPlatform}
                    className={cn(
                      "px-2 py-1 text-xs font-medium",
                      premium
                        ? dlg.control
                        : "rounded-md border border-brand-500/40 bg-brand-500/15 text-brand-100 hover:bg-brand-500/25",
                    )}
                  >
                    Add
                  </button>
                </span>
              )}
            </div>

            {dated && (
              <>
                <div className="mt-4 text-xs font-medium text-zinc-400">{t("Years")}</div>
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                  {yearChoices.map((y) => (
                    <button key={y} onClick={() => toggleYear(y)} className={chipCls(years.has(y))}>
                      {y}
                    </button>
                  ))}
                  <input
                    value={newYear}
                    onChange={(e) => setNewYear(e.target.value.replace(/\D/g, "").slice(0, 4))}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") addCustomYear();
                    }}
                    onBlur={addCustomYear}
                    placeholder={t("Year…")}
                    title={t("Type any year and press Enter")}
                    className={cn("h-7 w-16", fieldCls)}
                  />
                </div>

                <label className="mt-3 flex cursor-pointer items-center gap-2 text-sm text-zinc-300">
                  <input
                    type="checkbox"
                    checked={months}
                    onChange={(e) => setMonths(e.target.checked)}
                    className="h-4 w-4 accent-brand-500"
                  />
                  {t("Create 12 month subfolders (01–12) under each year")}
                </label>
              </>
            )}

            {/* base location (fixed when managed) */}
            <div
              className={cn(
                "mt-4 flex items-center gap-2 rounded-lg border p-2.5",
                premium ? dlg.soft : "border-zinc-800 bg-zinc-950",
              )}
              title={
                managed
                  ? "Destination can't be chosen — managed collection is on (set the collection folder in Settings)."
                  : undefined
              }
            >
              <FolderInput className="h-4 w-4 shrink-0 text-zinc-600" />
              <span
                className={`min-w-0 flex-1 truncate text-xs ${
                  managed
                    ? "text-zinc-500"
                    : scaffoldTarget
                      ? "text-zinc-300"
                      : "text-zinc-500"
                }`}
              >
                {managed
                  ? scaffoldTarget ?? "Set a collection folder in Settings first"
                  : scaffoldTarget ?? "No folders will be created — pick a base to scaffold"}
              </span>
              {managed ? (
                <span className="shrink-0 rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[10px] uppercase tracking-wide text-zinc-500">
                  {t("Managed")}
                </span>
              ) : (
                <Button variant="outline" size="sm" onClick={pickBaseFolder} disabled={busy}>
                  {baseDir ? "Change…" : "Base…"}
                </Button>
              )}
            </div>
            {(managed || baseDir) && platforms.size === 0 && (
              <p className="mt-2 text-xs text-amber-400/80">
                {t("No platforms selected — only the creator folder will be created.")}
              </p>
            )}
          </div>
        </div>

        <div className="flex justify-end gap-2 border-t border-white/10 px-5 py-3">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {t("Cancel")}
          </Button>
          <Button variant="primary" disabled={!canCreate} onClick={create}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <UserPlus className="h-4 w-4" />}
            {busy ? "Creating…" : "Create card"}
          </Button>
        </div>
      </motion.div>
    </div>
  );
}
