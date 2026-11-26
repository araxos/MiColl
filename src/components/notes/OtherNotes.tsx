import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { ExternalLink, FolderOpen, User } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { useDialogTheme } from "@/lib/dialogTheme";
import { useInk } from "@/components/notes/ink";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { useData } from "@/store";
import { ownRewards } from "@/types";

/**
 * The notes written on creators and rewards (in their Details), under the user's own notes
 * and searched with them. The Ctrl+K search leaves them out on purpose.
 */
export interface OtherNote {
  key: string;
  kind: "artist" | "reward";
  name: string;
  /** creator · platform month, for a reward */
  place: string;
  text: string;
  snippet: string;
  artistId: string;
  monthId?: string;
}

/** ~120 characters around what was searched for, on one line. */
function snippet(text: string, want: string): string {
  const at = want ? text.toLowerCase().indexOf(want) : 0;
  const from = Math.max(0, at - 40);
  const s = text.slice(from, from + 120).replace(/\s+/g, " ").trim();
  return from > 0 ? `…${s}` : s;
}

export function useOtherNotes(query: string): OtherNote[] {
  const { artists } = useData();
  const t = useT();
  return useMemo(() => {
    const want = query.trim().toLowerCase();
    const out: OtherNote[] = [];
    const add = (n: Omit<OtherNote, "snippet">) => {
      const text = n.text.trim();
      if (!text) return;
      const inText = !want || text.toLowerCase().includes(want);
      if (!inText && !n.name.toLowerCase().includes(want)) return;
      out.push({ ...n, text, snippet: snippet(text, inText ? want : "") });
    };
    for (const a of artists) {
      add({ key: `a${a.id}`, kind: "artist", name: a.name, place: t("Creator"), text: a.notes ?? "", artistId: a.id });
      for (const p of a.platforms) {
        for (const m of p.months) {
          for (const r of ownRewards(m)) {
            add({
              key: `r${r.id}`,
              kind: "reward",
              name: r.title,
              place: `${a.name} · ${p.name} ${m.label}`,
              text: r.notes ?? "",
              artistId: a.id,
              monthId: m.id,
            });
          }
        }
      }
    }
    return out.sort((x, y) => x.name.localeCompare(y.name, undefined, { sensitivity: "base" }));
  }, [artists, query, t]);
}

export function OtherRow({ note, on, onPick }: { note: OtherNote; on: boolean; onPick: () => void }) {
  const dlg = useDialogTheme();
  const ink = useInk();
  const Icon = note.kind === "artist" ? User : FolderOpen;
  return (
    <button
      type="button"
      onClick={onPick}
      aria-current={on || undefined}
      className={cn("mb-1 block w-full px-3 py-2 text-left", on ? dlg.controlOn : "rounded-lg border border-transparent micoll-hover")}
    >
      <span className="flex items-center gap-1.5">
        <Icon className={cn("h-3 w-3 shrink-0", ink.faint)} />
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-zinc-100">{note.name}</span>
      </span>
      {note.kind === "reward" && <span className={cn("block truncate text-[11px]", ink.faint)}>{note.place}</span>}
      <span className={cn("mt-0.5 block truncate text-xs", ink.soft)}>{note.snippet}</span>
    </button>
  );
}

/** The note itself, to read; it's written in the creator's or reward's Details. */
export function OtherNoteView({ note }: { note: OtherNote }) {
  const t = useT();
  const dlg = useDialogTheme();
  const ink = useInk();
  const navigate = useNavigate();
  const open = () => navigate(note.monthId ? `/artist/${note.artistId}/month/${note.monthId}` : `/artist/${note.artistId}`);
  return (
    <>
      <div className={cn("flex items-center gap-3 border-b px-4 py-2.5", dlg.divider)}>
        <div className="min-w-0 flex-1">
          <div className="truncate text-lg font-semibold text-zinc-50">{note.name}</div>
          <div className={cn("truncate text-xs", ink.faint)}>{note.place}</div>
        </div>
        <Button size="sm" variant="outline" onClick={open}>
          <ExternalLink className="h-4 w-4" />
          {note.kind === "artist" ? t("Open the creator") : t("Open the reward")}
        </Button>
      </div>
      <div className="min-h-0 flex-1 select-text overflow-y-auto whitespace-pre-wrap px-4 py-3 text-sm leading-relaxed text-zinc-200">
        {note.text}
      </div>
      <div className={cn("border-t px-4 py-1.5 text-[11px]", ink.faint, dlg.divider)}>
        {note.kind === "artist" ? t("Change it in the creator’s Details.") : t("Change it in the reward’s Details.")}
      </div>
    </>
  );
}
