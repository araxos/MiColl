import { useCallback, useEffect, useRef, useState } from "react";
import { ArchiveRestore, Lock, LockOpen, NotebookPen, PenLine, PenOff, Pin, PinOff, Plus, Search, Trash2, X } from "lucide-react";
import { Layout } from "@/components/Layout";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { useInk } from "@/components/notes/ink";
import { RichText } from "@/components/notes/RichText";
import type { Editor as TipTap } from "@tiptap/react";
import { OtherNoteView, OtherRow, useOtherNotes } from "@/components/notes/OtherNotes";
import { ChangeDialog, RecoveryCodeDialog, RemoveDialog, SetupDialog, UnlockDialog, VaultRow, type VaultDialog } from "@/components/notes/NotesVault";
import { Button } from "@/components/ui/Button";
import { useActions } from "@/actions";
import * as api from "@/api/notes";
import { useDialogTheme } from "@/lib/dialogTheme";
import { useLanguage, useT, useTf, useTp } from "@/lib/i18n";
import { isPremium, useAccent } from "@/lib/theme";
import { cn } from "@/lib/utils";

/** How long after the last key the note is saved. */
const SAVE_AFTER = 700;

/** The open note: "n<id>" (an own one), "o<key>" (a creator's or reward's), "" none. */
const OPEN_KEY = "micoll.notesOpen";
function readOpen(): string | null {
  try {
    return localStorage.getItem(OPEN_KEY);
  } catch {
    return null;
  }
}
function writeOpen(v: string) {
  try {
    localStorage.setItem(OPEN_KEY, v);
  } catch {
    /* just not remembered */
  }
}

/**
 * Notes: the user's own texts, sealed in MiColl's database (notes.rs). The list with its
 * own search on the left, the note on the right; it saves by itself.
 */
export function NotesPage({ onLock }: { onLock?: () => void }) {
  const t = useT();
  const tf = useTf();
  const dlg = useDialogTheme();
  const ink = useInk();
  // the standard themes: the page's own dark plate in the theme's colour, not grey
  const casual = !isPremium(useAccent());
  const plate = casual ? "notes-cas-plate" : dlg.panel;
  const { showToast } = useActions();
  const [status, setStatus] = useState<api.NotesStatus | null>(null);
  const [query, setQuery] = useState("");
  const [trash, setTrash] = useState(false);
  const [items, setItems] = useState<api.NoteItem[] | null>(null);
  const [trashCount, setTrashCount] = useState(0);
  const [openId, setOpenIdState] = useState<number | null>(null);
  /** a creator's or reward's note picked instead (its key) */
  const [otherKey, setOtherKey] = useState<string | null>(null);
  const setOpenId: typeof setOpenIdState = (v) => {
    setOtherKey(null);
    setOpenIdState(v);
  };
  const allOthers = useOtherNotes(query);
  // not in the trash
  const others = trash ? [] : allOthers;
  const other = others.find((o) => o.key === otherKey) ?? null;
  // The note that was open comes back when the page does (from the dashboard, after a
  // restart). Only its id is kept; a note that's locked or gone meanwhile stays closed.
  const remembered = useRef<string | null>(readOpen());
  useEffect(() => {
    if (remembered.current !== null || !items) return;
    writeOpen(openId != null ? `n${openId}` : otherKey ? `o${otherKey}` : "");
  }, [openId, otherKey, items]);
  useEffect(() => {
    const want = remembered.current;
    if (want === null || !items || trash) return;
    remembered.current = null;
    if (want.startsWith("n") && items.some((n) => `n${n.id}` === want)) setOpenIdState(Number(want.slice(1)));
    else if (want.startsWith("o") && allOthers.some((o) => `o${o.key}` === want)) setOtherKey(want.slice(1));
  }, [items, allOthers, trash]);
  const [askPurge, setAskPurge] = useState<api.NoteItem | null>(null);
  const [dialog, setDialog] = useState<VaultDialog>(null);
  const [code, setCode] = useState<string | null>(null);
  /** the open note's unsaved text goes in before the notes lock */
  const flush = useRef<() => Promise<void>>(async () => {});
  /** after the vault opened: what was waiting for it (locking the open note) */
  const afterUnlock = useRef<(() => void) | null>(null);
  // (not new on every render: they'd load everything again each time)
  const toastRef = useRef(showToast);
  toastRef.current = showToast;
  const tRef = useRef(t);
  tRef.current = t;

  const reload = useCallback(async () => {
    try {
      const [s, list, bin] = await Promise.all([api.notesStatus(), api.listNotes(query, trash), api.listNotes("", true)]);
      setStatus(s);
      setItems(list);
      setTrashCount(bin.length);
    } catch (e) {
      toastRef.current({ tone: "error", title: tRef.current("Couldn’t load the notes"), detail: `${e}` });
    }
  }, [query, trash]);
  useEffect(() => {
    void reload();
  }, [reload]);
  // the locked ones go when the notes lock by themselves
  useEffect(() => {
    let off: (() => void) | undefined;
    void import("@tauri-apps/api/event")
      .then(({ listen }) =>
        listen("notes-locked", () => {
          setOpenId((id) => (id != null && lockedIds.current.has(id) ? null : id));
          void reload();
        }),
      )
      .then((f) => (off = f))
      .catch(() => {});
    return () => off?.();
  }, [reload]);

  const create = async () => {
    try {
      const id = await api.saveNote({ id: null, title: "", text: "", locked: false, pinned: false });
      setTrash(false);
      setQuery("");
      setOpenId(id);
      fresh.current.add(id);
      void reload();
    } catch (e) {
      showToast({ tone: "error", title: t("Couldn’t create the note"), detail: `${e}` });
    }
  };
  // made here and still empty when left: gone again, not into the trash
  const fresh = useRef(new Set<number>());
  const leave = async (id: number, empty: boolean) => {
    if (!empty || !fresh.current.has(id)) return;
    fresh.current.delete(id);
    await api.trashNote(id, true).catch(() => {});
    await api.purgeNote(id).catch(() => {});
    void reload();
  };

  const open = items?.find((n) => n.id === openId) ?? null;
  const lockedIds = useRef(new Set<number>());
  lockedIds.current = new Set((items ?? []).filter((n) => n.locked).map((n) => n.id));

  const lockNow = async () => {
    await flush.current();
    await api.lockNotes().catch(() => {});
    if (openId != null && lockedIds.current.has(openId)) setOpenId(null);
    void reload();
  };
  /** Moves the open note behind the password (or back): needs the password set and open. */
  const needVault = (then: () => void) => {
    if (!status?.vault) setDialog("setup");
    else if (!status.unlocked) setDialog("unlock");
    else return then();
    afterUnlock.current = then;
  };
  const vaultOpened = () => {
    setDialog(null);
    void reload();
    const then = afterUnlock.current;
    afterUnlock.current = null;
    then?.();
  };

  return (
    <Layout onLock={onLock}>
      <div className="flex h-full min-h-0 gap-4 px-6 py-5 2xl:px-10">
        {/* the list */}
        <aside className={cn("flex w-80 shrink-0 flex-col overflow-hidden", plate)}>
          <div className={cn("space-y-2 border-b p-3", dlg.divider)}>
            <div className="flex items-center gap-2">
              <h1 className="flex min-w-0 flex-1 items-center gap-2 text-base font-semibold text-zinc-100">
                <NotebookPen className={cn("h-4 w-4 shrink-0", dlg.accentText)} />
                <span className="truncate">{trash ? t("Trash") : t("Notes")}</span>
              </h1>
              {!trash && (
                <Button size="sm" variant="primary" className={casual ? "casual-lead" : dlg.primary} onClick={() => void create()}>
                  <Plus className="h-4 w-4" />
                  {t("New note")}
                </Button>
              )}
            </div>
            <label className={cn("flex h-9 items-center gap-2 px-2.5", dlg.field)}>
              <Search className={cn("h-4 w-4 shrink-0", ink.faint)} />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t("Search notes…")}
                spellCheck={false}
                className={cn("min-w-0 flex-1 bg-transparent text-sm text-zinc-100 outline-none", ink.hint)}
              />
              {query && (
                <button type="button" aria-label={t("Clear")} onClick={() => setQuery("")} className={cn("hover:text-zinc-50", ink.faint)}>
                  <X className="h-4 w-4" />
                </button>
              )}
            </label>
            {status && !trash && (
              <VaultRow
                status={status}
                onDialog={setDialog}
                onLock={() => void lockNow()}
                onChanged={() => void reload()}
                onCode={setCode}
              />
            )}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            {status?.normalClosed && (
              <p className={cn("mb-2 p-3 text-xs leading-relaxed text-amber-200", dlg.box)}>
                {t("Your notes can’t be opened on this PC yet. Unlock MiColl (or your locked notes) and they’re back.")}
              </p>
            )}
            {items?.length === 0 && !(query && others.length > 0) && (
              <p className={cn("px-3 py-8 text-center text-sm", ink.faint)}>
                {query ? t("No note has that in it.") : trash ? t("The trash is empty.") : t("No notes yet.")}
              </p>
            )}
            {items?.map((n) => (
              <NoteRow key={n.id} note={n} on={n.id === openId && !other} onPick={() => setOpenId(n.id)} />
            ))}
            {!trash && others.length > 0 && (
              <>
                <div className={cn("mb-1 mt-4 flex items-center gap-2 px-3 text-[11px] font-semibold uppercase tracking-wide", ink.faint)}>
                  <span className="min-w-0 flex-1 truncate">{t("Creators and rewards")}</span>
                  <span className="font-normal">{others.length}</span>
                </div>
                {others.map((o) => (
                  <OtherRow
                    key={o.key}
                    note={o}
                    on={o.key === otherKey}
                    onPick={() => {
                      setOpenIdState(null);
                      setOtherKey(o.key);
                    }}
                  />
                ))}
              </>
            )}
          </div>
          <div className={cn("border-t p-2", dlg.divider)}>
            <button
              type="button"
              onClick={() => {
                setTrash((v) => !v);
                setOpenId(null);
              }}
              className={cn("flex w-full items-center gap-2 px-2.5 py-1.5 text-sm hover:text-zinc-50", ink.soft, dlg.control)}
            >
              {trash ? <NotebookPen className="h-4 w-4" /> : <Trash2 className="h-4 w-4" />}
              <span className="flex-1 text-left">{trash ? t("Back to the notes") : t("Trash")}</span>
              {!trash && trashCount > 0 && <span className={cn("text-xs", ink.faint)}>{trashCount}</span>}
            </button>
            {trash && <p className={cn("px-2.5 pt-1.5 text-[11px]", ink.faint)}>{t("Notes in the trash are deleted after 30 days.")}</p>}
          </div>
        </aside>

        {/* the note */}
        <section className={cn("flex min-w-0 flex-1 flex-col overflow-hidden", plate)}>
          {other && !trash ? (
            <OtherNoteView key={other.key} note={other} />
          ) : open && trash ? (
            <TrashedNote
              key={open.id}
              item={open}
              onRestore={async () => {
                await api.trashNote(open.id, false).catch((e) => showToast({ tone: "error", title: `${e}` }));
                setOpenId(null);
                void reload();
              }}
              onPurge={() => setAskPurge(open)}
            />
          ) : openId != null && !trash ? (
            <Editor
              key={openId}
              id={openId}
              onSaved={() => void reload()}
              onLeave={(empty) => void leave(openId, empty)}
              flush={flush}
              onNeedVault={needVault}
              onTrash={async () => {
                fresh.current.delete(openId);
                await api.trashNote(openId, true).catch((e) => showToast({ tone: "error", title: `${e}` }));
                setOpenId(null);
                void reload();
                showToast({ tone: "success", title: t("Moved to the trash"), detail: t("Notes in the trash are deleted after 30 days.") });
              }}
            />
          ) : (
            <div className={cn("flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center", ink.faint)}>
              <NotebookPen className="h-10 w-10 opacity-40" />
              <p className="max-w-sm text-sm">
                {trash
                  ? t("Pick a note to bring it back or delete it for good.")
                  : t("Pick a note, or make a new one. Notes are encrypted and only MiColl can open them.")}
              </p>
              {!trash && (
                <Button variant={casual ? "primary" : "outline"} size="sm" className={casual ? "casual-lead" : undefined} onClick={() => void create()}>
                  <Plus className="h-4 w-4" />
                  {t("New note")}
                </Button>
              )}
            </div>
          )}
        </section>
      </div>
      {dialog === "setup" && (
        <SetupDialog
          onClose={() => {
            afterUnlock.current = null;
            setDialog(null);
          }}
          onDone={(c) => {
            if (c) setCode(c);
            vaultOpened();
          }}
        />
      )}
      {dialog === "unlock" && (
        <UnlockDialog
          onClose={() => {
            afterUnlock.current = null;
            setDialog(null);
          }}
          onDone={(byRecovery) => {
            vaultOpened();
            if (byRecovery) setDialog("change");
          }}
        />
      )}
      {dialog === "change" && status && (
        <ChangeDialog
          byRecovery={!!status.byRecovery || !status.unlocked}
          // after the recovery code it has to be done
          onClose={status.byRecovery ? undefined : () => setDialog(null)}
          onDone={() => {
            setDialog(null);
            void reload();
            showToast({ tone: "success", title: t("The notes password is changed") });
          }}
        />
      )}
      {dialog === "remove" && (
        <RemoveDialog
          onClose={() => setDialog(null)}
          onDone={() => {
            setDialog(null);
            void reload();
            showToast({ tone: "success", title: t("The notes password is removed"), detail: t("Your locked notes are normal notes now.") });
          }}
        />
      )}
      {code && <RecoveryCodeDialog code={code} onDone={() => setCode(null)} />}
      {askPurge && (
        <ConfirmDialog
          title={t("Delete for good?")}
          body={tf("“{name}” is deleted and can’t be brought back.", { name: askPurge.title || t("Untitled") })}
          confirmLabel={t("Delete")}
          onCancel={() => setAskPurge(null)}
          onConfirm={async () => {
            const id = askPurge.id;
            setAskPurge(null);
            await api.purgeNote(id).catch((e) => showToast({ tone: "error", title: `${e}` }));
            setOpenId(null);
            void reload();
          }}
        />
      )}
    </Layout>
  );
}

function NoteRow({ note, on, onPick }: { note: api.NoteItem; on: boolean; onPick: () => void }) {
  const t = useT();
  const dlg = useDialogTheme();
  const ink = useInk();
  const when = useWhen();
  return (
    <button
      type="button"
      onClick={onPick}
      aria-current={on || undefined}
      className={cn(
        "mb-1 block w-full px-3 py-2 text-left",
        on ? dlg.controlOn : "rounded-lg border border-transparent micoll-hover",
      )}
    >
      <span className="flex items-center gap-1.5">
        {note.pinned && <Pin className={cn("h-3 w-3 shrink-0", dlg.accentText)} />}
        {note.locked && <Lock className={cn("h-3 w-3 shrink-0", ink.soft)} />}
        {note.readonly && <PenOff className={cn("h-3 w-3 shrink-0", ink.soft)} />}
        <span className={cn("min-w-0 flex-1 truncate text-sm font-medium", note.title ? "text-zinc-100" : cn("italic", ink.faint))}>
          {note.title || t("Untitled")}
        </span>
        <span className={cn("shrink-0 text-[11px]", ink.faint)}>{when(note.deleted ?? note.updated)}</span>
      </span>
      {note.snippet && <span className={cn("mt-0.5 block truncate text-xs", ink.soft)}>{note.snippet}</span>}
    </button>
  );
}

/** A date short: the time today, else the day. */
function useWhen() {
  const lang = useLanguage();
  return (secs: number) => {
    const d = new Date(secs * 1000);
    const today = new Date().toDateString() === d.toDateString();
    try {
      return today
        ? d.toLocaleTimeString(lang, { timeStyle: "short" })
        : d.toLocaleDateString(lang, { dateStyle: "medium" });
    } catch {
      return d.toLocaleString();
    }
  };
}

/** One note to write in: title and text, saved a moment after the last key. */
function Editor({
  id,
  onSaved,
  onLeave,
  onTrash,
  flush,
  onNeedVault,
}: {
  id: number;
  onSaved: () => void;
  /** it's closed (empty = nothing written) */
  onLeave: (empty: boolean) => void;
  onTrash: () => void;
  /** set to this note's "save now" */
  flush: React.MutableRefObject<() => Promise<void>>;
  /** the notes password must be set and open first: runs `then` once it is */
  onNeedVault: (then: () => void) => void;
}) {
  const t = useT();
  const tp = useTp();
  const dlg = useDialogTheme();
  const ink = useInk();
  const when = useWhen();
  const { showToast } = useActions();
  const [note, setNote] = useState<api.Note | null>(null);
  const [state, setState] = useState<"saved" | "saving" | "dirty" | "failed">("saved");
  const current = useRef<api.Note | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const textRef = useRef<TipTap | null>(null);
  const titleRef = useRef<HTMLInputElement | null>(null);
  const toastRef = useRef(showToast);
  toastRef.current = showToast;
  const tRef = useRef(t);
  tRef.current = t;
  const savedRef = useRef(onSaved);
  savedRef.current = onSaved;

  useEffect(() => {
    let alive = true;
    api
      .getNote(id)
      .then((n) => {
        if (!alive) return;
        setNote(n);
        current.current = n;
        // a new one: straight into the title
        if (!n.title && !n.text) requestAnimationFrame(() => titleRef.current?.focus());
      })
      .catch((e) => toastRef.current({ tone: "error", title: tRef.current("Couldn’t open the note"), detail: `${e}` }));
    return () => {
      alive = false;
    };
  }, [id]);

  const save = useCallback(async () => {
    clearTimeout(timer.current);
    const n = current.current;
    if (!n) return;
    setState("saving");
    try {
      await api.saveNote({ id: n.id, title: n.title, text: n.text, rich: n.rich, locked: n.locked, pinned: n.pinned, readonly: n.readonly });
      // typed on meanwhile: that's saved with the next round
      setState(current.current === n ? "saved" : "dirty");
      const updated = Math.floor(Date.now() / 1000);
      if (current.current) current.current = { ...current.current, updated };
      setNote((cur) => (cur ? { ...cur, updated } : cur));
      savedRef.current();
    } catch (e) {
      setState("failed");
      toastRef.current({ tone: "error", title: tRef.current("Couldn’t save the note"), detail: `${e}` });
    }
  }, []);

  const change = (c: Partial<api.Note>, now = false) => {
    if (!current.current) return;
    const n = { ...current.current, ...c };
    current.current = n;
    setNote(n);
    setState("dirty");
    clearTimeout(timer.current);
    if (now) void save();
    else timer.current = setTimeout(() => void save(), SAVE_AFTER);
  };

  // closed or another note picked: what's still unsaved is saved now
  const saveRef = useRef(save);
  saveRef.current = save;
  const stateRef = useRef(state);
  stateRef.current = state;
  const leaveRef = useRef(onLeave);
  leaveRef.current = onLeave;
  useEffect(
    () => () => {
      const n = current.current;
      const pending = stateRef.current === "dirty" || stateRef.current === "failed";
      const empty = !!n && !n.title.trim() && !n.text.trim();
      if (pending && !empty) void saveRef.current();
      leaveRef.current(empty);
    },
    [],
  );

  // the page saves it before the notes lock
  useEffect(() => {
    flush.current = async () => {
      if (stateRef.current === "dirty" || stateRef.current === "failed") await saveRef.current();
    };
    return () => {
      flush.current = async () => {};
    };
  }, [flush]);

  // Ctrl+S saves right away
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void save();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [save]);

  if (!note) return <div className="flex-1" />;
  const words = note.text.trim() ? note.text.trim().split(/\s+/).length : 0;

  return (
    <>
      <div className={cn("flex items-center gap-2 border-b px-4 py-2.5", dlg.divider)}>
        <input
          ref={titleRef}
          value={note.title}
          onChange={(e) => change({ title: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              textRef.current?.commands.focus("start");
            }
          }}
          placeholder={t("Title")}
          spellCheck={false}
          readOnly={note.readonly}
          maxLength={300}
          className={cn("min-w-0 flex-1 bg-transparent text-lg font-semibold text-zinc-50 outline-none", ink.hint)}
        />
        <Button
          size="icon"
          variant="ghost"
          title={note.pinned ? t("Unpin") : t("Pin to the top")}
          aria-label={note.pinned ? t("Unpin") : t("Pin to the top")}
          aria-pressed={note.pinned}
          onClick={() => change({ pinned: !note.pinned }, true)}
          className={note.pinned ? dlg.accentText : undefined}
        >
          {note.pinned ? <PinOff className="h-4 w-4" /> : <Pin className="h-4 w-4" />}
        </Button>
        <Button
          size="icon"
          variant="ghost"
          title={note.readonly ? t("Allow writing again") : t("Write-protect: nothing can be changed")}
          aria-label={note.readonly ? t("Allow writing again") : t("Write-protect: nothing can be changed")}
          aria-pressed={note.readonly}
          onClick={() => change({ readonly: !current.current?.readonly }, true)}
          className={note.readonly ? dlg.accentText : undefined}
        >
          {note.readonly ? <PenOff className="h-4 w-4" /> : <PenLine className="h-4 w-4" />}
        </Button>
        <Button
          size="icon"
          variant="ghost"
          title={note.locked ? t("Take it out from behind the password") : t("Lock it with the notes password")}
          aria-label={note.locked ? t("Take it out from behind the password") : t("Lock it with the notes password")}
          aria-pressed={note.locked}
          onClick={() => onNeedVault(() => change({ locked: !current.current?.locked }, true))}
          className={note.locked ? dlg.accentText : undefined}
        >
          {note.locked ? <Lock className="h-4 w-4" /> : <LockOpen className="h-4 w-4" />}
        </Button>
        <Button size="icon" variant="ghost" title={t("Move to the trash")} aria-label={t("Move to the trash")} onClick={onTrash}>
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>
      <RichText
        text={note.text}
        rich={note.rich}
        editable={!note.readonly}
        placeholder={t("Write something…")}
        onChange={(text, rich) => change({ text, rich })}
        onReady={(ed) => (textRef.current = ed)}
      />
      <div className={cn("flex items-center gap-3 border-t px-4 py-1.5 text-[11px]", ink.faint, dlg.divider)}>
        <span>{tp("{n} words", words)}</span>
        {note.readonly && (
          <span className={cn("flex items-center gap-1", dlg.accentText)}>
            <PenOff className="h-3 w-3" />
            {t("Write-protected")}
          </span>
        )}
        <span className="ml-auto">
          {state === "saving" || state === "dirty"
            ? t("Saving…")
            : state === "failed"
              ? t("Not saved")
              : `${t("Saved")} · ${when(note.updated)}`}
        </span>
      </div>
    </>
  );
}

function TrashedNote({ item, onRestore, onPurge }: { item: api.NoteItem; onRestore: () => void; onPurge: () => void }) {
  const t = useT();
  const dlg = useDialogTheme();
  const [note, setNote] = useState<api.Note | null>(null);
  useEffect(() => {
    void api.getNote(item.id).then(setNote).catch(() => {});
  }, [item.id]);
  return (
    <>
      <div className={cn("flex items-center gap-2 border-b px-4 py-2.5", dlg.divider)}>
        <span className="min-w-0 flex-1 truncate text-lg font-semibold text-zinc-300">{item.title || t("Untitled")}</span>
        <Button size="sm" variant="outline" onClick={onRestore}>
          <ArchiveRestore className="h-4 w-4" />
          {t("Restore")}
        </Button>
        <Button size="sm" variant="ghost" onClick={onPurge} className="text-rose-300">
          <Trash2 className="h-4 w-4" />
          {t("Delete for good")}
        </Button>
      </div>
      {note && <RichText key={note.id} text={note.text} rich={note.rich} editable={false} />}
    </>
  );
}
