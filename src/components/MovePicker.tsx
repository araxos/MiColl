import { useState } from "react";
import { createPortal } from "react-dom";
import { motion } from "framer-motion";
import { X, FolderInput, Folder, Check, Plus } from "lucide-react";
import { useData } from "@/store";
import { Button } from "@/components/ui/Button";
import { useDialogTheme } from "@/lib/dialogTheme";
import { useAccent } from "@/lib/theme";
import { addPlatform, usePlatformOptions } from "@/lib/platformRegistry";
import { cn } from "@/lib/utils";
import { useT, useTf } from "@/lib/i18n";
import { ownRewards } from "@/types";

const MONTH_NAMES = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];

/**
 * Read the month field: a number ("3", "03") or a name ("mar", "March").
 * Returns 1-12 or undefined. Empty is handled by the caller (= no month).
 */
function parseMonth(text: string): number | undefined {
  const t = text.trim().toLowerCase();
  if (!t) return undefined;
  if (/^\d{1,2}$/.test(t)) {
    const n = Number(t);
    return n >= 1 && n <= 12 ? n : undefined;
  }
  if (t.length < 3) return undefined;
  const hits = MONTH_NAMES.filter((m) => m.startsWith(t));
  return hits.length === 1 ? MONTH_NAMES.indexOf(hits[0]) + 1 : undefined;
}

/** The labels the year/month will get (same as the backend). */
function destLabel(year: number | null, month: number | null): string {
  if (year == null) return "Misc";
  return month == null ? String(year) : `${year}-${String(month).padStart(2, "0")}`;
}

/**
 * Label of a row in the Month column ("2026" and "Misc" should look like destinations too).
 */
function monthHint(m: { year: number | null; month: number | null; number?: number | null }): string {
  if (m.number != null) return "";
  if (m.year == null) return "no date";
  if (m.month == null) return "whole year";
  return "";
}

/**
 * One column of the picker and one row in it.
 * Declared at module level on purpose: inside the render they would be a new
 * component every time and autoFocus would steal the cursor while typing.
 */
function PickerCol({ children, label }: { children: React.ReactNode; label: string }) {
  const dlg = useDialogTheme();
  return (
    <div className={cn("flex w-44 shrink-0 flex-col border-r last:border-r-0", dlg.divider)}>
      <div
        className={cn(
          "border-b px-3 py-1.5 text-[11px] font-medium uppercase tracking-wide text-zinc-500",
          dlg.divider,
        )}
      >
        {label}
      </div>
      <div className="flex-1 overflow-y-auto p-1">{children}</div>
    </div>
  );
}

function PickerRow({
  active,
  disabled,
  onClick,
  children,
}: {
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  const dlg = useDialogTheme();
  const hard = useAccent() === "cyberpunk"; // square corners, like the rest of it
  return (
    <button
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2 truncate px-2.5 py-1.5 text-left text-sm transition-colors",
        hard ? "rounded-none" : "rounded-lg",
        // rows use the menu hover fill, picked = the open-submenu fill
        active
          ? cn("text-zinc-50", dlg.menuRowOpen)
          : disabled
            ? "cursor-not-allowed text-zinc-600"
            : cn("text-zinc-200", dlg.menuRow),
      )}
    >
      {children}
    </button>
  );
}

/**
 * Pick a destination: Artist -> Platform -> Month (-> Reward when moving files).
 * Used by the right-click "Move to..." actions.
 */
export function MovePicker({
  mode,
  count,
  fromArtistId,
  excludeMonthId,
  excludeRewardId,
  excludeRewardIds,
  onPick,
  onClose,
}: {
  /**
   * "rewards" = target is a month (or a reward to merge into), "images" = target is a
   * reward.
   */
  mode: "rewards" | "images";
  /** How many items are moved (shown in the header). */
  count: number;
  /** Open the picker at the source location. */
  fromArtistId?: string;
  /** The source month (moving into it does nothing, but you can merge into its rewards). */
  excludeMonthId?: string;
  /** Hide this reward as target (moving files onto their own reward). */
  excludeRewardId?: string;
  /** Rewards being moved (can't merge a reward into itself). */
  excludeRewardIds?: string[];
  onPick: (dest: {
    periodId?: string;
    rewardId?: string;
    /** A year/month that doesn't exist yet, the caller creates it and then moves. */
    newPeriod?: {
      artistId: string;
      platform: string | null;
      /** null = the "Misc" bucket (a real destination). */
      year: number | null;
      month: number | null;
    };
  }) => void;
  onClose: () => void;
}) {
  const t = useT();
  const tf = useTf();
  const { artists } = useData();
  // styled per theme
  const dlg = useDialogTheme();
  const platformOptions = usePlatformOptions(artists);
  // open at the source location
  const initArtist = fromArtistId ?? (artists.length === 1 ? artists[0].id : null);
  const initPlatform =
    artists
      .find((a) => a.id === initArtist)
      ?.platforms.find((p) => p.months.some((m) => m.id === excludeMonthId))?.id ?? null;
  const [aId, setAId] = useState<string | null>(initArtist);
  const [pId, setPId] = useState<string | null>(initPlatform);
  const [mId, setMId] = useState<string | null>(initPlatform ? excludeMonthId ?? null : null);
  const [rId, setRId] = useState<string | null>(null);
  // inline "new year/month" form (rewards mode only)
  const [newOpen, setNewOpen] = useState(false);
  const [newYear, setNewYear] = useState(String(new Date().getFullYear()));
  const [newMonth, setNewMonth] = useState("");
  // a new platform for this creator. It only exists through its periods,
  // so picking it opens the year/month form and the move creates both
  const [newPlat, setNewPlat] = useState<string | null>(null);
  const [platDraft, setPlatDraft] = useState<string | null>(null);

  const artist = artists.find((a) => a.id === aId);
  const platform = artist?.platforms.find((p) => p.id === pId);
  const month = platform?.months.find((m) => m.id === mId);
  // collab-only months and borrowed rewards can't be targets (no DB row, other creator's
  // files)
  const months = (platform?.months ?? []).filter((m) => !m.collabOnly);
  const monthRewards = month ? ownRewards(month) : [];
  const isExcludedReward = (id: string) =>
    id === excludeRewardId || (excludeRewardIds?.includes(id) ?? false);

  // rewards mode: a reward -> merge, a month -> move next to it (not the source month).
  // images mode: must be a reward.
  const canMove =
    mode === "rewards" ? !!rId || (!!mId && mId !== excludeMonthId) : !!rId;
  const confirm = () => {
    if (rId) onPick({ rewardId: rId });
    else if (mode === "rewards" && mId && mId !== excludeMonthId) onPick({ periodId: mId });
  };

  // create a new period and move into it. An empty year = the "Misc" bucket
  const yearBlank = !newYear.trim();
  const newYearNum = yearBlank ? null : Number(newYear.trim());
  const parsedMonth = parseMonth(newMonth);
  const monthBlank = !newMonth.trim();
  const newMonthNum = monthBlank ? null : parsedMonth ?? null;
  const yearOk =
    yearBlank ||
    (newYearNum !== null && Number.isInteger(newYearNum) && newYearNum >= 1900 && newYearNum <= 2999);
  // a month without a year isn't allowed (folders are <Year>/<MM>)
  const monthOk = monthBlank || (parsedMonth !== undefined && !yearBlank);
  const newValid = !!aId && yearOk && monthOk;
  const newError = !yearOk
    ? "Year must be 1900–2999, or empty for Misc."
    : !monthBlank && parsedMonth === undefined
      ? "Month: 1–12 or a name like “Mar”."
      : !monthBlank && yearBlank
        ? "A month needs a year — Misc holds no months."
        : "";
  const confirmNew = () => {
    if (!newValid || !aId) return;
    const plat = platform?.name ?? newPlat ?? null;
    // offer it from now on
    if (newPlat) addPlatform(newPlat);
    onPick({
      newPeriod: {
        artistId: aId,
        platform: plat,
        year: newYearNum,
        month: newMonthNum,
      },
    });
  };

  // take the typed platform, an existing one (any case) is just selected
  const commitPlatform = () => {
    const name = (platDraft ?? "").trim();
    setPlatDraft(null);
    if (!name || !artist) return;
    const existing = artist.platforms.find((pl) => pl.name.toLowerCase() === name.toLowerCase());
    setMId(null);
    setRId(null);
    if (existing) {
      setNewPlat(null);
      setPId(existing.id);
      setNewOpen(false);
    } else {
      setNewPlat(name);
      setPId(null);
      setNewOpen(true);
    }
  };
  // suggestions: the platform list minus what the creator already has
  const platSuggestions = platformOptions.filter(
    (o) => !artist?.platforms.some((pl) => pl.name.toLowerCase() === o.toLowerCase()),
  );

  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
      <motion.div
        initial={{ opacity: 0, y: 12, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        className={cn("flex max-h-[80vh] w-[48rem] max-w-full flex-col overflow-hidden", dlg.panel)}
      >
        <div className={cn("flex items-center justify-between border-b px-5 py-4", dlg.divider)}>
          <div>
            <h2 className="text-base font-semibold text-zinc-100">
              Move {count} {mode === "images" ? (count === 1 ? "file" : "files") : count === 1 ? "reward" : "rewards"}
            </h2>
            <p className="text-xs text-zinc-400">
              {mode === "images"
                ? "Choose a destination reward inside MiColl."
                : "Choose a destination month — or a reward to merge into."}
            </p>
          </div>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-300">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex min-h-[16rem] flex-1 overflow-x-auto">
          <PickerCol label={t("Creator")}>
            {artists.map((a) => (
              <PickerRow
                key={a.id}
                active={a.id === aId}
                onClick={() => {
                  setAId(a.id);
                  setPId(null);
                  setMId(null);
                  setRId(null);
                  setNewOpen(false);
                  setNewPlat(null);
                  setPlatDraft(null);
                }}
              >
                <span className="truncate">{a.name}</span>
              </PickerRow>
            ))}
          </PickerCol>

          {artist && (
            <PickerCol label={t("Platform")}>
              {artist.platforms.length === 0 && !newPlat && mode !== "rewards" ? (
                <p className="px-2 py-2 text-xs text-zinc-500">{t("No platforms.")}</p>
              ) : (
                artist.platforms.map((p) => (
                  <PickerRow
                    key={p.id}
                    active={p.id === pId}
                    onClick={() => {
                      setPId(p.id);
                      setMId(null);
                      setRId(null);
                      setNewOpen(false);
                      setNewPlat(null);
                    }}
                  >
                    <span className="truncate">{p.name}</span>
                  </PickerRow>
                ))
              )}
              {/* the new platform, shown where it will appear */}
              {newPlat && (
                <PickerRow active onClick={() => setNewOpen(true)}>
                  <span className="truncate">{newPlat}</span>
                  <span className="shrink-0 text-[10px] text-zinc-400">{t("new")}</span>
                </PickerRow>
              )}
              {/* new platform (only when moving rewards) */}
              {mode === "rewards" && (
                <div className={cn("mt-1 border-t pt-1", dlg.divider)}>
                  {platDraft === null ? (
                    <PickerRow active={false} onClick={() => setPlatDraft("")}>
                      <Plus className={cn("h-3.5 w-3.5 shrink-0", dlg.accentText)} />
                      <span className={cn("truncate", dlg.accentText)}>{t("New platform…")}</span>
                    </PickerRow>
                  ) : (
                    <div className="space-y-1.5 px-1.5 py-1.5">
                      <input
                        autoFocus
                        data-enter-local
                        list="micoll-move-platforms"
                        placeholder={t("New platform name")}
                        value={platDraft}
                        onChange={(e) => setPlatDraft(e.target.value)}
                        onKeyDown={(e) => {
                          // Enter here only adds the platform, it doesn't move yet
                          if (e.key === "Enter") {
                            e.preventDefault();
                            e.stopPropagation();
                            commitPlatform();
                          } else if (e.key === "Escape") {
                            e.stopPropagation();
                            setPlatDraft(null);
                          }
                        }}
                        className={cn(dlg.input, "h-8 px-2")}
                      />
                      <datalist id="micoll-move-platforms">
                        {platSuggestions.map((o) => (
                          <option key={o} value={o} />
                        ))}
                      </datalist>
                      <div className="flex justify-end gap-1.5">
                        <Button variant="ghost" size="sm" onClick={() => setPlatDraft(null)}>
                          {t("Cancel")}
                        </Button>
                        <Button
                          variant="primary"
                          size="sm"
                          disabled={!platDraft.trim()}
                          onClick={commitPlatform}
                        >
                          <Check className="h-3.5 w-3.5" />
                          {t("Add")}
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </PickerCol>
          )}

          {(platform || newPlat) && (
            <PickerCol label={t("Month")}>
              {/* collab-only months can't be targets (no DB row) */}
              {months.length === 0 && !newOpen && mode !== "rewards" ? (
                <p className="px-2 py-2 text-xs text-zinc-500">{t("No months.")}</p>
              ) : (
                months.map((m) => (
                  <PickerRow
                    key={m.id}
                    active={m.id === mId}
                    onClick={() => {
                      setMId(m.id);
                      setRId(null);
                    }}
                  >
                    <Folder className="h-3.5 w-3.5 shrink-0 text-zinc-500" />
                    <span className="truncate">{m.label}</span>
                    {/* "2026" and "Misc" get a description so they look like destinations */}
                    {monthHint(m) && (
                      <span className="shrink-0 text-[10px] text-zinc-500">{monthHint(m)}</span>
                    )}
                  </PickerRow>
                ))
              )}
              {/* move into a new period (new month, or "Misc" with an empty year) */}
              {mode === "rewards" && (
                <div className={cn(months.length > 0 && "mt-1 border-t pt-1", dlg.divider)}>
                  {!newOpen ? (
                    <PickerRow
                      active={false}
                      onClick={() => {
                        setNewOpen(true);
                        setMId(null);
                        setRId(null);
                      }}
                    >
                      <Plus className={cn("h-3.5 w-3.5 shrink-0", dlg.accentText)} />
                      <span className={cn("truncate", dlg.accentText)}>{t("New year / month…")}</span>
                    </PickerRow>
                  ) : (
                    <div className="space-y-1.5 px-1.5 py-1.5">
                      <input
                        autoFocus
                        inputMode="numeric"
                        placeholder={t("Year — empty for Misc")}
                        value={newYear}
                        onChange={(e) => setNewYear(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && newValid) confirmNew();
                        }}
                        className={cn(dlg.input, "h-8 px-2")}
                      />
                      <input
                        placeholder={t("Month — 1–12 or “Mar”")}
                        value={newMonth}
                        onChange={(e) => setNewMonth(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && newValid) confirmNew();
                        }}
                        className={cn(dlg.input, "h-8 px-2")}
                      />
                      {/* preview of the folder name (empty year -> Misc, empty month -> the
                          year itself) */}
                      <p className={cn("truncate text-[11px]", newValid ? "text-zinc-500" : "text-amber-300")}>
                        {newValid
                          ? newPlat
                            ? tf("Creates “{platform} › {period}”", {
                                platform: newPlat,
                                period: destLabel(newYearNum, newMonthNum),
                              })
                            : `Creates “${destLabel(newYearNum, newMonthNum)}”`
                          : newError}
                      </p>
                      <div className="flex justify-end gap-1.5">
                        <Button variant="ghost" size="sm" onClick={() => setNewOpen(false)}>
                          {t("Cancel")}
                        </Button>
                        <Button variant="primary" size="sm" disabled={!newValid} onClick={confirmNew}>
                          <Check className="h-3.5 w-3.5" />
                          {t("Move here")}
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </PickerCol>
          )}

          {month && (
            <PickerCol label={mode === "images" ? "Reward" : "Reward (merge)"}>
              {/* no borrowed collabs (would write into another creator's folder) */}
              {monthRewards.length === 0 ? (
                <p className="px-2 py-2 text-xs text-zinc-500">{t("No rewards.")}</p>
              ) : (
                monthRewards.map((r) => (
                  <PickerRow
                    key={r.id}
                    active={r.id === rId}
                    disabled={isExcludedReward(r.id)}
                    onClick={() => setRId(r.id === rId ? null : r.id)}
                  >
                    <Folder className="h-3.5 w-3.5 shrink-0 text-zinc-500" />
                    <span className="truncate">{r.title}</span>
                  </PickerRow>
                ))
              )}
            </PickerCol>
          )}
        </div>

        <div className={cn("flex items-center justify-between gap-2 border-t px-5 py-3", dlg.divider)}>
          <span className="truncate text-xs text-zinc-500">
            {artist?.name}
            {platform ? ` › ${platform.name}` : newPlat ? ` › ${newPlat}` : ""}
            {month ? ` › ${month.label}` : ""}
            {rId ? ` › ${month?.rewards.find((r) => r.id === rId)?.title ?? ""}` : ""}
          </span>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={onClose}>
              {t("Cancel")}
            </Button>
            <Button variant="primary" disabled={!canMove} onClick={confirm}>
              <FolderInput className="h-4 w-4" />
              {mode === "rewards" && rId ? "Merge here" : "Move here"}
            </Button>
          </div>
        </div>
      </motion.div>
    </div>,
    document.body,
  );
}

/**
 * Small dialog to name a new folder (or a missing-reward card). With years it also
 * shows a year picker (existing or new, created on disk).
 */
export function NewFolderDialog({
  onCreate,
  onClose,
  title = "New folder",
  initial = "New folder",
  hint,
  years,
  initialYear,
}: {
  onCreate: (name: string, year?: string) => void;
  onClose: () => void;
  /** Title of the dialog. */
  title?: string;
  /** Pre-filled value. */
  initial?: string;
  /** Optional help text under the input. */
  hint?: string;
  /** Existing years (newest first). Shows the year picker when set. */
  years?: number[];
  /** Pre-filled year (newest existing, else this year). */
  initialYear?: string;
}) {
  const t = useT();
  const [name, setName] = useState(initial);
  const showYear = years !== undefined;
  // start empty so the datalist shows all years
  const [year, setYear] = useState(initialYear ?? "");
  // name is needed, year is optional (empty = Misc, otherwise 4 digits)
  const yearOk = !showYear || year.trim() === "" || /^\d{4}$/.test(year.trim());
  const valid = !!name.trim() && yearOk;
  const submit = () => valid && onCreate(name.trim(), showYear ? year.trim() : undefined);

  // premium themes get their own surface, standard ones the dark dialog
  const { panel: panelClass, input: inputClass, primary: createClass } = useDialogTheme();
  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
      <motion.div
        initial={{ opacity: 0, y: 12, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        className={cn("w-[24rem] p-5", panelClass)}
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-base font-semibold text-zinc-100">{title}</h2>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-300">
            <X className="h-4 w-4" />
          </button>
        </div>
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && valid) submit();
            if (e.key === "Escape") onClose();
          }}
          onFocus={(e) => e.target.select()}
          className={inputClass}
        />
        {showYear && (
          <>
            <input
              list="micoll-folder-years"
              inputMode="numeric"
              value={year}
              onChange={(e) => setYear(e.target.value.replace(/[^0-9]/g, "").slice(0, 4))}
              onKeyDown={(e) => {
                if (e.key === "Enter" && valid) submit();
                if (e.key === "Escape") onClose();
              }}
              placeholder={t("Year (optional) — pick, type a new one, or leave blank for Misc")}
              className={cn(inputClass, "mt-2")}
            />
            <datalist id="micoll-folder-years">
              {(years ?? []).map((y) => (
                <option key={y} value={String(y)} />
              ))}
            </datalist>
            {year.trim() === "" && (
              <p className="mt-1 text-xs text-zinc-500">{t("No year → filed under “Misc”.")}</p>
            )}
          </>
        )}
        {hint && <p className="mt-2 text-xs text-zinc-500">{hint}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            {t("Cancel")}
          </Button>
          <Button variant="primary" disabled={!valid} onClick={submit} className={createClass}>
            <Check className="h-4 w-4" />
            {t("Create")}
          </Button>
        </div>
      </motion.div>
    </div>,
    document.body,
  );
}
