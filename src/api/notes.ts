import { invoke } from "@/lib/tauri";

/** The user's own notes (notes.rs): sealed in the database, never files. */

export interface NotesStatus {
  /** a notes password is set */
  vault: boolean;
  unlocked: boolean;
  recovery: boolean;
  /** normal notes can't be opened on this PC right now (moved here) */
  normalClosed: boolean;
  autolockMin: number;
  /** unlocked with the recovery code: a new password is due */
  byRecovery: boolean;
}

export interface NoteItem {
  id: number;
  title: string;
  /** the text around what was searched for, else its start */
  snippet: string;
  locked: boolean;
  pinned: boolean;
  /** nothing can be written in it */
  readonly: boolean;
  /** unix seconds */
  created: number;
  updated: number;
  /** in the trash since then */
  deleted: number | null;
}

export interface Note {
  id: number;
  title: string;
  /** its plain words (the search looks there) */
  text: string;
  /** with its formatting: the editor's document as JSON; null for a plain note */
  rich: string | null;
  locked: boolean;
  pinned: boolean;
  /** nothing can be written in it */
  readonly: boolean;
  created: number;
  updated: number;
}

export const notesStatus = () => invoke<NotesStatus>("notes_status");
export const listNotes = (query = "", trash = false) => invoke<NoteItem[]>("notes_list", { query, trash });
export const getNote = (id: number) => invoke<Note>("notes_get", { id });
/** Writes a note, a new one without id. Returns its id. */
export const saveNote = (n: {
  id: number | null;
  title: string;
  text: string;
  rich?: string | null;
  locked: boolean;
  pinned: boolean;
  readonly?: boolean;
}) => invoke<number>("notes_save", n);
/** Into the trash (into = true) or back out. */
export const trashNote = (id: number, into: boolean) => invoke<void>("notes_trash", { id, into });
/** Out of the trash for good. */
export const purgeNote = (id: number) => invoke<void>("notes_purge", { id });
/** Sets the notes password; the recovery code comes back when one is wanted (shown once). */
export const createNotesVault = (password: string, recovery: boolean) =>
  invoke<string | null>("notes_vault_create", { password, recovery });
export const unlockNotes = (secret: string, recovery = false) => invoke<void>("notes_unlock", { secret, recovery });
export const lockNotes = () => invoke<void>("notes_lock");
export const changeNotesPassword = (current: string | null, password: string) =>
  invoke<void>("notes_change_password", { current, password });
/** A new recovery code (on) or none (off). */
export const setNotesRecovery = (on: boolean) => invoke<string | null>("notes_set_recovery", { on });
export const removeNotesVault = (password: string) => invoke<void>("notes_remove_vault", { password });
export const setNotesAutolock = (minutes: number) => invoke<void>("notes_set_autolock", { minutes });
