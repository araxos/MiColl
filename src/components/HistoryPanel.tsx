import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowRight,
  ChevronDown,
  FolderOpen,
  History,
  PenLine,
  RefreshCw,
  Search,
  Trash2,
  Combine,
  MoveRight,
  Undo2,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { useDialogTheme } from "@/lib/dialogTheme";
import { useAccent } from "@/lib/theme";
import { cn } from "@/lib/utils";
import { resolveLanguage, useLanguage, useT, useTf, useTp } from "@/lib/i18n";
import * as api from "@/api/library";
import { HISTORY_CHANGED_EVENT, useActions } from "@/actions";
import { useLocation } from "react-router-dom";

const PAGE = 100;

type Filter = "all" | "delete" | "move" | "rename" | "trash";

/** UTC "YYYY-MM-DD HH:MM:SS" from SQLite -> Date. */
const parseAt = (at: string) => new Date(at.replace(" ", "T") + "Z");

/**
 * Settings section: what was deleted, moved, renamed or sent to the Recycle Bin, and
 * when — so a missing file can be traced without digging through the Recycle Bin.
 * Reads the backend's history log (history.rs), newest first, paged.
 */
export function HistoryPanel({ backed }: { backed: boolean }) {
  const t = useT();
  const tf = useTf();
  const locale = resolveLanguage(useLanguage());
  const dlg = useDialogTheme();
  const square = useAccent() === "cyberpunk";
  const [rows, setRows] = useState<api.HistoryRow[]>([]);
  const [more, setMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
  const [q, setQ] = useState("");
  // the top bar drawer can send us here with one entry to open
  const location = useLocation();
  const wanted = (location.state as { historyOpen?: number } | null)?.historyOpen;
  const [open, setOpen] = useState<Set<number>>(() => new Set(wanted != null ? [wanted] : []));
  useEffect(() => {
    if (wanted != null) setOpen((o) => new Set(o).add(wanted));
  }, [wanted, location.key]);
  // the list scrolls in its own box, bring that entry up there (not the page)
  const listRef = useRef<HTMLDivElement>(null);
  const hasRows = rows.length > 0;
  useEffect(() => {
    if (wanted == null || !hasRows) return;
    const id = window.setTimeout(() => {
      const box = listRef.current;
      const el = box?.querySelector<HTMLElement>(`[data-hid="${wanted}"]`);
      if (box && el) {
        box.scrollTop += el.getBoundingClientRect().top - box.getBoundingClientRect().top - 8;
      }
    }, 450);
    return () => window.clearTimeout(id);
  }, [wanted, location.key, hasRows]);
  const [askClear, setAskClear] = useState(false);
  const { undoHistory } = useActions();
  const [undoing, setUndoing] = useState<number | null>(null);

  const load = useCallback(
    async (before?: number) => {
      if (!backed) return;
      setLoading(true);
      try {
        const page = await api.listHistory(before, PAGE);
        setRows((r) => (before ? [...r, ...page] : page));
        setMore(page.length === PAGE);
      } catch {
        /* just show what we have */
      } finally {
        setLoading(false);
      }
    },
    [backed],
  );
  useEffect(() => {
    void load();
  }, [load]);
  // Ctrl+Z elsewhere changed a row
  useEffect(() => {
    const on = () => void load();
    window.addEventListener(HISTORY_CHANGED_EVENT, on);
    return () => window.removeEventListener(HISTORY_CHANGED_EVENT, on);
  }, [load]);

  const shown = useMemo(() => {
    const ql = q.trim().toLowerCase();
    return rows.filter((r) => {
      if (filter === "move" && r.action !== "move" && r.action !== "merge") return false;
      if (filter !== "all" && filter !== "move" && r.action !== filter) return false;
      if (!ql) return true;
      const hay = [r.artist, r.place, ...r.items.flatMap((i) => [i.name, i.was, i.from, i.to])]
        .filter(Boolean)
        .join("\n")
        .toLowerCase();
      return hay.includes(ql);
    });
  }, [rows, filter, q]);

  // one heading per day (local time)
  const groups = useMemo(() => {
    const out: { day: string; rows: api.HistoryRow[] }[] = [];
    const today = new Date();
    const yest = new Date(Date.now() - 86_400_000);
    const same = (a: Date, b: Date) => a.toDateString() === b.toDateString();
    for (const r of shown) {
      const d = parseAt(r.at);
      const day = same(d, today)
        ? t("Today")
        : same(d, yest)
          ? t("Yesterday")
          : d.toLocaleDateString(locale, { weekday: "short", day: "numeric", month: "long", year: "numeric" });
      const last = out[out.length - 1];
      if (last && last.day === day) last.rows.push(r);
      else out.push({ day, rows: [r] });
    }
    return out;
  }, [shown, locale, t]);

  const { verb, Icon, what, where, filesNote, childLabel } = useHistoryText();

  const toggle = (id: number) =>
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const chip = (f: Filter, label: string) => (
    <button
      key={f}
      onClick={() => setFilter(f)}
      className={cn("px-2.5 py-1 text-xs", filter === f ? dlg.controlOn : dlg.control)}
    >
      {label}
    </button>
  );

  const radius = square ? "rounded-none" : "rounded-lg";

  return (
    <div>
      <h2 className="flex items-center gap-2 settings-title text-2xl font-bold tracking-tight text-zinc-50">
        <History className="h-6 w-6 text-brand-300" />
        {t("History")}
      </h2>
      <p className="settings-desc mt-1 text-sm text-zinc-400">
        {t(
          "What was deleted, moved, renamed or sent to the Recycle Bin, and when — so you can always find out where a file went. Open an entry to see the old and new paths.",
        )}{" "}
        {t("Ctrl+Z takes back the last rename, move or delete (deleted files come back out of the Recycle Bin).")}
      </p>

      {!backed ? (
        <div className="mt-4 rounded-xl border border-dashed border-zinc-800 bg-zinc-900/40 p-6 text-center text-sm text-zinc-400">
          {t("The history is kept by the desktop app.")}
        </div>
      ) : (
        <>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            {chip("all", t("All"))}
            {chip("delete", t("Deleted"))}
            {chip("move", t("Moved"))}
            {chip("rename", t("Renamed"))}
            {chip("trash", t("Recycle Bin"))}
            <div className={cn("ml-auto flex h-8 items-center gap-1.5 px-2", dlg.field)}>
              <Search className="h-3.5 w-3.5 shrink-0 text-zinc-500" />
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder={t("Search names and paths…")}
                className="w-44 bg-transparent text-xs text-zinc-100 outline-none placeholder:text-zinc-500"
              />
            </div>
            <button
              onClick={() => void load()}
              title={t("Refresh")}
              className={cn("flex h-8 w-8 items-center justify-center", dlg.control)}
            >
              <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
            </button>
          </div>

          {shown.length === 0 ? (
            <div className={cn("mt-4 p-6 text-center text-sm text-zinc-400", dlg.box)}>
              {rows.length === 0
                ? t("Nothing yet. From now on, every delete, move and rename shows up here.")
                : t("No entries match.")}
            </div>
          ) : (
            // about six entries high, then it scrolls inside (the page stays short)
            <div ref={listRef} className="mt-4 max-h-[38rem] space-y-4 overflow-y-auto pr-1">
              {groups.map((g) => (
                <div key={g.day}>
                  <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-zinc-500">{g.day}</div>
                  <ul className="space-y-1.5">
                    {g.rows.map((r) => {
                      const I = Icon(r);
                      const isOpen = open.has(r.id);
                      const note = filesNote(r);
                      const sub = where(r);
                      const kids = childLabel(r);
                      return (
                        <li key={r.id} data-hid={r.id} className={cn("overflow-hidden", radius, dlg.soft, r.undone && "opacity-55")}>
                          <button
                            onClick={() => toggle(r.id)}
                            className="flex w-full items-start gap-3 px-3 py-2 text-left"
                          >
                            <I
                              className={cn(
                                "mt-0.5 h-4 w-4 shrink-0",
                                r.action === "delete" || r.action === "trash" ? "text-rose-300" : dlg.accentText,
                              )}
                            />
                            <div className="min-w-0 flex-1">
                              <div className="flex flex-wrap items-baseline gap-x-2">
                                <span className="text-xs font-semibold uppercase tracking-wide text-zinc-400">
                                  {verb(r)}
                                </span>
                                <span className="min-w-0 break-words text-sm font-medium text-zinc-100">{what(r)}</span>
                                {kids && <span className="text-xs text-zinc-500">{kids}</span>}
                                {r.undone && (
                                  <span className="text-[10px] font-semibold uppercase tracking-wide text-zinc-400">
                                    {t("Undone")}
                                  </span>
                                )}
                              </div>
                              {sub && <div className="mt-0.5 truncate text-xs text-zinc-400">{sub}</div>}
                              {note && <div className="mt-0.5 text-xs text-zinc-500">{note}</div>}
                            </div>
                            <span className="shrink-0 text-xs tabular-nums text-zinc-500">
                              {parseAt(r.at).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" })}
                            </span>
                            <ChevronDown
                              className={cn("mt-0.5 h-4 w-4 shrink-0 text-zinc-500 transition-transform", isOpen && "rotate-180")}
                            />
                          </button>
                          {r.undoable && (
                            <div className="-mt-1 flex justify-end px-3 pb-2">
                              <button
                                onClick={async () => {
                                  setUndoing(r.id);
                                  await undoHistory(r.id);
                                  setUndoing(null);
                                }}
                                disabled={undoing != null}
                                className={cn("flex items-center gap-1.5 px-2 py-1 text-xs disabled:opacity-50", dlg.control)}
                              >
                                <Undo2 className="h-3.5 w-3.5" />
                                {t("Undo")}
                              </button>
                            </div>
                          )}
                          {isOpen && (
                            <ul className="space-y-1 border-t border-white/5 px-3 py-2">
                              {r.items.map((it, i) => (
                                <HistoryItem key={i} item={it} reveal={r.files !== "trash" && r.action !== "trash"} />
                              ))}
                              {r.count > r.items.length && (
                                <li className="text-xs text-zinc-500">
                                  {tf("… and {n} more", { n: r.count - r.items.length })}
                                </li>
                              )}
                            </ul>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ))}
            </div>
          )}

          <div className="mt-4 flex flex-wrap items-center gap-2">
            {more && (
              <Button variant="outline" onClick={() => void load(rows[rows.length - 1]?.id)} disabled={loading}>
                {t("Show older entries")}
              </Button>
            )}
            {rows.length > 0 && (
              <button
                onClick={() => setAskClear(true)}
                className={cn("ml-auto px-2.5 py-1 text-xs text-zinc-400", dlg.control)}
              >
                {t("Clear history")}
              </button>
            )}
          </div>
        </>
      )}

      {askClear && (
        <ConfirmDialog
          title={t("Clear the history?")}
          body={t("Only the log is emptied — no file and nothing in your library changes.")}
          confirmLabel={t("Clear history")}
          onConfirm={async () => {
            setAskClear(false);
            await api.clearHistory().catch(() => {});
            setRows([]);
            setMore(false);
          }}
          onCancel={() => setAskClear(false)}
        />
      )}
    </div>
  );
}

/** The words for a history row, shared by this section and the top bar drawer. */
export function useHistoryText() {
  const t = useT();
  const tf = useTf();
  const tp = useTp();
  const verb = (r: api.HistoryRow) =>
    r.action === "delete"
      ? t("Deleted")
      : r.action === "move"
        ? t("Moved")
        : r.action === "rename"
          ? t("Renamed")
          : r.action === "merge"
            ? t("Merged")
            : t("To the Recycle Bin");
  const Icon = (r: api.HistoryRow) =>
    r.action === "delete" || r.action === "trash"
      ? Trash2
      : r.action === "rename"
        ? PenLine
        : r.action === "merge"
          ? Combine
          : MoveRight;

  /** The bold line: what it was about. */
  const what = (r: api.HistoryRow): string => {
    const first = r.items[0];
    const many = (n: number) =>
      r.kind === "reward" ? tp("{n} rewards", n) : r.kind === "artist" ? tp("{n} creators", n) : tp("{n} files", n);
    switch (r.kind) {
      case "artist":
        return r.action === "rename" && first?.was
          ? tf("Creator “{was}” → “{name}”", { was: first.was, name: first.name })
          : tf("Creator “{name}”", { name: r.artist ?? first?.name ?? "" });
      case "period":
        return tf("Period {name}", { name: r.place ?? first?.name ?? "" });
      case "platform":
        return tf("Platform “{name}”", { name: r.place ?? first?.name ?? "" });
      case "library":
        return t("The whole collection folder");
      case "collection":
        return r.action === "rename" && first?.was
          ? tf("Collection “{was}” → “{name}”", { was: first.was, name: first.name })
          : tf("Collection “{name}”", { name: first?.name ?? "" });
      default:
        if (r.count > 1) return many(r.count);
        if (r.action === "rename" && first?.was) return `${first.was} → ${first.name}`;
        return first?.name ?? "";
    }
  };

  /** The grey line: creator and place (without repeating the bold line). */
  const where = (r: api.HistoryRow) => {
    const parts: string[] = [];
    if (r.artist && r.kind !== "artist") parts.push(r.artist);
    if (r.place && r.kind !== "period" && r.kind !== "platform") parts.push(r.place);
    return parts.join(" · ");
  };

  /** What happened to the files (deletes and Recycle Bin rows). */
  const filesNote = (r: api.HistoryRow) =>
    r.action === "trash"
      ? t("Sent to the Recycle Bin after it was imported and checked")
      : r.files === "trash"
        ? t("The files went to the Recycle Bin")
        : r.files === "kept"
          ? t("Only removed from MiColl — the files stayed where they were")
          : null;

  // a whole creator / period / platform lists its rewards inside
  const childLabel = (r: api.HistoryRow) =>
    r.action === "delete" &&
    (r.kind === "artist" || r.kind === "period" || r.kind === "platform") &&
    r.items[0]?.from
      ? tp("{n} rewards", r.count)
      : null;
  return { verb, Icon, what, where, filesNote, childLabel };
}

/** One file/folder of an entry: its name, the old name, old → new path. */
function HistoryItem({ item, reveal }: { item: api.HistoryItem; reveal: boolean }) {
  const t = useT();
  const tf = useTf();
  // the place it is now: the new path, or (files kept) where it always was
  const here = item.to ?? (reveal ? item.from : undefined);
  return (
    <li className="text-xs">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 break-words font-medium text-zinc-200">
          {item.name}
          {item.was && item.was !== item.name && (
            <span className="ml-1.5 font-normal text-zinc-500">{tf("(was “{name}”)", { name: item.was })}</span>
          )}
        </span>
        {here && (
          <button
            onClick={() => void api.showInExplorer(here)}
            title={t("Show in Explorer")}
            className="shrink-0 rounded p-1 text-zinc-500 transition-colors hover:bg-white/10 hover:text-zinc-200"
          >
            <FolderOpen className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      {(item.from || item.to) && (
        <div className="mt-0.5 flex flex-wrap items-center gap-1 break-all text-zinc-500">
          {item.from && <span>{item.from}</span>}
          {item.from && item.to && item.to !== item.from && <ArrowRight className="h-3 w-3 shrink-0" />}
          {item.to && item.to !== item.from && <span className="text-zinc-400">{item.to}</span>}
        </div>
      )}
    </li>
  );
}
