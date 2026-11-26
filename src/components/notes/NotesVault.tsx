import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { save } from "@tauri-apps/plugin-dialog";
import { Check, Download, Eye, EyeOff, KeyRound, Loader2, Lock, LockOpen, MoreHorizontal, ShieldCheck, Timer, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import type { MenuItem } from "@/components/ContextMenu";
import { useActions } from "@/actions";
import * as api from "@/api/notes";
import { exportTemplate } from "@/api/library";
import { useDialogTheme } from "@/lib/dialogTheme";
import { useT, useTf, useTp } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { useInk } from "@/components/notes/ink";

/** The notes password: the row in the list and its dialogs. */

export type VaultDialog = "setup" | "unlock" | "change" | "remove" | null;

/** The row under the search: set a password, unlock, or lock again (and its menu). */
export function VaultRow({
  status,
  onDialog,
  onLock,
  onChanged,
  onCode,
}: {
  status: api.NotesStatus;
  onDialog: (d: VaultDialog) => void;
  onLock: () => void;
  onChanged: () => void;
  /** a new recovery code to show */
  onCode: (code: string) => void;
}) {
  const t = useT();
  const tp = useTp();
  const dlg = useDialogTheme();
  const ink = useInk();
  const { openMenu, showToast } = useActions();
  if (!status.vault) {
    return (
      <button
        type="button"
        onClick={() => onDialog("setup")}
        className={cn("flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs hover:text-zinc-50", ink.soft, dlg.control)}
      >
        <ShieldCheck className="h-4 w-4 shrink-0" />
        {t("Protect notes with a password")}
      </button>
    );
  }
  if (!status.unlocked) {
    return (
      <button
        type="button"
        onClick={() => onDialog("unlock")}
        className={cn("flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs text-zinc-300 hover:text-zinc-50", dlg.control)}
      >
        <Lock className="h-4 w-4 shrink-0" />
        <span className="min-w-0 flex-1 truncate" title={t("Locked notes are hidden")}>{t("Locked notes")}</span>
        <span className={cn("font-medium", dlg.accentText)}>{t("Unlock")}</span>
      </button>
    );
  }
  const minutes = [1, 5, 10, 30, 60, 0];
  const menu = (e: React.MouseEvent) => {
    const items: MenuItem[] = [
      { label: t("Change the password…"), icon: <KeyRound className="h-4 w-4" />, onClick: () => onDialog("change") },
      {
        label: status.recovery ? t("New recovery code") : t("Make a recovery code"),
        icon: <ShieldCheck className="h-4 w-4" />,
        onClick: () =>
          void api
            .setNotesRecovery(true)
            .then((c) => c && onCode(c))
            .catch((err) => showToast({ tone: "error", title: `${err}` })),
      },
      ...(status.recovery
        ? [
            {
              label: t("Remove the recovery code"),
              icon: <X className="h-4 w-4" />,
              onClick: () =>
                void api
                  .setNotesRecovery(false)
                  .then(() => {
                    onChanged();
                    showToast({ tone: "success", title: t("The recovery code is gone"), detail: t("Only the password opens the locked notes now.") });
                  })
                  .catch((err) => showToast({ tone: "error", title: `${err}` })),
            },
          ]
        : []),
      {
        label: t("Lock by itself"),
        icon: <Timer className="h-4 w-4" />,
        hint: status.autolockMin ? tp("{n} min", status.autolockMin) : t("never"),
        children: minutes.map((m) => ({
          label: m ? tp("after {n} minutes", m) : t("only when MiColl locks"),
          icon: m === status.autolockMin ? <Check className="h-4 w-4" /> : <span className="h-4 w-4" />,
          onClick: () => void api.setNotesAutolock(m).then(onChanged),
        })),
      },
      { label: t("Remove the password…"), icon: <Trash2 className="h-4 w-4" />, danger: true, onClick: () => onDialog("remove") },
    ];
    openMenu(e, items);
  };
  return (
    <div className={cn("flex w-full items-center gap-1 py-1 pl-2.5 pr-1 text-xs text-zinc-300", dlg.control)}>
      <LockOpen className={cn("h-4 w-4 shrink-0", dlg.accentText)} />
      <span className="min-w-0 flex-1 truncate" title={t("Locked notes are open")}>{t("Locked notes")}</span>
      <button type="button" onClick={onLock} className="rounded-md px-2 py-0.5 font-medium text-zinc-200 micoll-hover">
        {t("Lock")}
      </button>
      <button
        type="button"
        aria-label={t("Notes password")}
        title={t("Notes password")}
        onClick={(e) => menu(e)}
        className={cn("rounded-md p-1 micoll-hover hover:text-zinc-50", ink.soft)}
      >
        <MoreHorizontal className="h-4 w-4" />
      </button>
    </div>
  );
}

/** A dialog box over everything, Esc closes it (unless it must be finished). */
function Modal({ title, icon, onClose, children, wide }: { title: string; icon: React.ReactNode; onClose?: () => void; children: React.ReactNode; wide?: boolean }) {
  const dlg = useDialogTheme();
  useEffect(() => {
    if (!onClose) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);
  return createPortal(
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
      <div role="dialog" aria-modal className={cn("max-w-full p-5", wide ? "w-[34rem]" : "w-[26rem]", dlg.panel)}>
        <div className="flex items-center gap-2">
          <span className={dlg.accentText}>{icon}</span>
          <h2 className="flex-1 text-base font-semibold text-zinc-100">{title}</h2>
          {onClose && (
            <button type="button" aria-label="close" onClick={onClose} className="rounded-md p-1 text-zinc-500 hover:text-zinc-200">
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
        {children}
      </div>
    </div>,
    document.body,
  );
}

function PasswordField({
  value,
  onChange,
  placeholder,
  autoFocus,
  onEnter,
  plain,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  autoFocus?: boolean;
  onEnter?: () => void;
  /** a recovery code: shown, in capitals */
  plain?: boolean;
}) {
  const t = useT();
  const dlg = useDialogTheme();
  const ink = useInk();
  const [show, setShow] = useState(false);
  return (
    <label className={cn("mt-3 flex h-10 items-center gap-2 px-3", dlg.field)}>
      <input
        type={plain || show ? "text" : "password"}
        value={value}
        autoFocus={autoFocus}
        onChange={(e) => onChange(plain ? e.target.value.toUpperCase() : e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && onEnter?.()}
        placeholder={placeholder}
        spellCheck={false}
        autoComplete="off"
        // (Windows' own eye in a password field: ours is next to it already)
        className={cn("min-w-0 flex-1 bg-transparent text-sm text-zinc-100 outline-none [&::-ms-reveal]:hidden", ink.hint, plain && "font-mono tracking-wider")}
      />
      {!plain && (
        <button type="button" tabIndex={-1} aria-label={show ? t("Hide") : t("Show")} onClick={() => setShow((s) => !s)} className={cn("hover:text-zinc-50", ink.faint)}>
          {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
        </button>
      )}
    </label>
  );
}

/** The backend's words in the user's language. */
function useErr() {
  const t = useT();
  const tf = useTf();
  return (e: unknown) => {
    const m = /^Too many wrong tries\. Wait (\d+) seconds\.$/.exec(`${e}`);
    return m ? tf("Too many wrong tries. Wait {n} seconds.", { n: m[1] }) : t(`${e}`);
  };
}

function Problem({ text }: { text: string | null }) {
  return text ? <p className="mt-2 text-xs text-rose-300">{text}</p> : null;
}

function Actions({ busy, label, disabled, onGo, onCancel }: { busy: boolean; label: string; disabled?: boolean; onGo: () => void; onCancel?: () => void }) {
  const t = useT();
  const dlg = useDialogTheme();
  return (
    <div className="mt-5 flex justify-end gap-2">
      {onCancel && (
        <Button variant="ghost" onClick={onCancel} disabled={busy}>
          {t("Cancel")}
        </Button>
      )}
      <Button variant="primary" className={dlg.primary} disabled={busy || disabled} onClick={onGo}>
        {busy && <Loader2 className="h-4 w-4 animate-spin" />}
        {label}
      </Button>
    </div>
  );
}

const MIN = 4;

/** The first notes password, and a recovery code if wanted. */
export function SetupDialog({ onClose, onDone }: { onClose: () => void; onDone: (code: string | null) => void }) {
  const t = useT();
  const tf = useTf();
  const dlg = useDialogTheme();
  const [pw, setPw] = useState("");
  const [again, setAgain] = useState("");
  const [recovery, setRecovery] = useState(true);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const short = pw.length > 0 && [...pw].length < MIN;
  const differs = again.length > 0 && again !== pw;
  const ok = [...pw].length >= MIN && pw === again;
  const go = async () => {
    if (!ok || busy) return;
    setBusy(true);
    setProblem(null);
    try {
      onDone(await api.createNotesVault(pw, recovery));
    } catch (e) {
      setProblem(`${e}`);
      setBusy(false);
    }
  };
  return (
    <Modal title={t("Protect notes with a password")} icon={<ShieldCheck className="h-5 w-5" />} onClose={busy ? undefined : onClose}>
      <p className="mt-2 text-sm leading-relaxed text-zinc-300">
        {t("Notes you lock can only be read with this password. Until you unlock them, MiColl doesn’t even show their titles. It can be the same as your MiColl password.")}
      </p>
      <PasswordField value={pw} onChange={setPw} placeholder={t("Notes password")} autoFocus onEnter={() => void go()} />
      <PasswordField value={again} onChange={setAgain} placeholder={t("Repeat the password")} onEnter={() => void go()} />
      <Problem text={short ? tf("At least {n} characters.", { n: MIN }) : differs ? t("The two passwords aren’t the same.") : problem} />
      <label className={cn("mt-4 flex cursor-pointer items-start gap-3 p-3", dlg.box)}>
        <input type="checkbox" checked={recovery} onChange={(e) => setRecovery(e.target.checked)} className="mt-0.5 h-4 w-4 accent-current" />
        <span className="text-sm">
          <span className="font-medium text-zinc-100">{t("Make a recovery code (recommended)")}</span>
          <span className="mt-0.5 block text-xs leading-relaxed text-zinc-400">
            {recovery
              ? t("If you ever forget the password, the code opens your locked notes. You’ll see it once, right after this.")
              : t("Without a code, a forgotten password means your locked notes are gone for good. Nobody can open them, not even MiColl.")}
          </span>
        </span>
      </label>
      <Actions busy={busy} label={t("Set the password")} disabled={!ok} onGo={() => void go()} onCancel={onClose} />
    </Modal>
  );
}

/** A recovery code, shown once: write it down, or save it as a file (for a USB stick). */
export function RecoveryCodeDialog({ code, onDone }: { code: string; onDone: () => void }) {
  const t = useT();
  const dlg = useDialogTheme();
  const { showToast } = useActions();
  const [kept, setKept] = useState(false);
  const [saved, setSaved] = useState(false);
  const download = async () => {
    const path = await save({
      title: t("Save the recovery code"),
      defaultPath: "MiColl notes recovery code.txt",
      filters: [{ name: "Text", extensions: ["txt"] }],
    });
    if (typeof path !== "string") return;
    try {
      await exportTemplate(path, `MiColl notes recovery code\r\n\r\n${code}\r\n`);
      setSaved(true);
    } catch (e) {
      showToast({ tone: "error", title: `${e}` });
    }
  };
  return (
    <Modal title={t("Your recovery code")} icon={<KeyRound className="h-5 w-5" />} wide>
      <p className="mt-2 text-sm leading-relaxed text-zinc-300">
        {t("If you forget the notes password, this code is the only way back in. It won’t be shown again.")}
      </p>
      <div className={cn("mt-4 select-all p-4 text-center font-mono text-xl tracking-[0.15em] text-zinc-50", dlg.box)}>{code}</div>
      <p className="mt-3 text-xs leading-relaxed text-zinc-400">
        {t("Best: write it on paper, or put it on a USB stick, and keep it away from this PC. Anyone with the code can read your locked notes.")}
      </p>
      <div className="mt-3 flex items-center gap-3">
        <Button variant="outline" size="sm" onClick={() => void download()}>
          <Download className="h-4 w-4" />
          {t("Save as a file…")}
        </Button>
        {saved && <span className="text-xs text-amber-200">{t("Move the file to a USB stick and delete it from this PC.")}</span>}
      </div>
      <label className="mt-4 flex cursor-pointer items-center gap-2 text-sm text-zinc-200">
        <input type="checkbox" checked={kept} onChange={(e) => setKept(e.target.checked)} className="h-4 w-4" />
        {t("I’ve put the code somewhere safe")}
      </label>
      <Actions busy={false} label={t("Done")} disabled={!kept} onGo={onDone} />
    </Modal>
  );
}

/** Opens the locked notes: the password, or the recovery code. */
export function UnlockDialog({ onClose, onDone }: { onClose: () => void; onDone: (byRecovery: boolean) => void }) {
  const t = useT();
  const err = useErr();
  const [secret, setSecret] = useState("");
  const [recovery, setRecovery] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const go = async () => {
    if (!secret || busy) return;
    setBusy(true);
    setProblem(null);
    try {
      await api.unlockNotes(secret, recovery);
      onDone(recovery);
    } catch (e) {
      setProblem(err(e));
      setSecret("");
      setBusy(false);
    }
  };
  return (
    <Modal title={t("Unlock your notes")} icon={<Lock className="h-5 w-5" />} onClose={busy ? undefined : onClose}>
      <p className="mt-2 text-sm text-zinc-300">
        {recovery ? t("Type your recovery code. Capitals and dashes don’t matter.") : t("Type your notes password.")}
      </p>
      <PasswordField
        key={recovery ? "code" : "pw"}
        value={secret}
        onChange={setSecret}
        placeholder={recovery ? "XXXXX-XXXXX-XXXXX-XXXXX-XXXXX" : t("Notes password")}
        plain={recovery}
        autoFocus
        onEnter={() => void go()}
      />
      <Problem text={problem} />
      <button
        type="button"
        onClick={() => {
          setRecovery((r) => !r);
          setSecret("");
          setProblem(null);
        }}
        className="mt-3 text-xs text-zinc-400 underline-offset-2 hover:text-zinc-100 hover:underline"
      >
        {recovery ? t("Use the password instead") : t("Forgot it? Use the recovery code")}
      </button>
      <Actions busy={busy} label={t("Unlock")} disabled={!secret} onGo={() => void go()} onCancel={onClose} />
    </Modal>
  );
}

/** A new password: with the current one, or (after the recovery code) without. */
export function ChangeDialog({ byRecovery, onClose, onDone }: { byRecovery: boolean; onClose?: () => void; onDone: () => void }) {
  const t = useT();
  const err = useErr();
  const tf = useTf();
  const [current, setCurrent] = useState("");
  const [pw, setPw] = useState("");
  const [again, setAgain] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const ok = [...pw].length >= MIN && pw === again && (byRecovery || !!current);
  const go = async () => {
    if (!ok || busy) return;
    setBusy(true);
    setProblem(null);
    try {
      await api.changeNotesPassword(byRecovery ? null : current, pw);
      onDone();
    } catch (e) {
      setProblem(err(e));
      setBusy(false);
    }
  };
  return (
    <Modal title={byRecovery ? t("Set a new notes password") : t("Change the notes password")} icon={<KeyRound className="h-5 w-5" />} onClose={busy ? undefined : onClose}>
      {byRecovery && (
        <p className="mt-2 text-sm text-zinc-300">{t("You opened your notes with the recovery code. Pick a new password now; the code keeps working.")}</p>
      )}
      {!byRecovery && <PasswordField value={current} onChange={setCurrent} placeholder={t("Current password")} autoFocus onEnter={() => void go()} />}
      <PasswordField value={pw} onChange={setPw} placeholder={t("New password")} autoFocus={byRecovery} onEnter={() => void go()} />
      <PasswordField value={again} onChange={setAgain} placeholder={t("Repeat the password")} onEnter={() => void go()} />
      <Problem
        text={
          pw && [...pw].length < MIN
            ? tf("At least {n} characters.", { n: MIN })
            : again && again !== pw
              ? t("The two passwords aren’t the same.")
              : problem
        }
      />
      <Actions busy={busy} label={t("Save the password")} disabled={!ok} onGo={() => void go()} onCancel={onClose} />
    </Modal>
  );
}

/** No notes password any more: the locked notes become normal ones. */
export function RemoveDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const t = useT();
  const err = useErr();
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const go = async () => {
    if (!pw || busy) return;
    setBusy(true);
    setProblem(null);
    try {
      await api.removeNotesVault(pw);
      onDone();
    } catch (e) {
      setProblem(err(e));
      setBusy(false);
    }
  };
  return (
    <Modal title={t("Remove the notes password?")} icon={<Trash2 className="h-5 w-5" />} onClose={busy ? undefined : onClose}>
      <p className="mt-2 text-sm leading-relaxed text-zinc-300">
        {t("Your locked notes become normal notes: still encrypted, but anyone using MiColl on this PC can read them. The recovery code stops working.")}
      </p>
      <PasswordField value={pw} onChange={setPw} placeholder={t("Notes password")} autoFocus onEnter={() => void go()} />
      <Problem text={problem} />
      <Actions busy={busy} label={t("Remove the password")} disabled={!pw} onGo={() => void go()} onCancel={onClose} />
    </Modal>
  );
}
