import { useCallback, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { KeyRound, Lock, Moon, ShieldCheck, Check, Trash2, ShieldAlert, Copy, Loader2, Image, RotateCcw, VenetianMask } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { useData } from "@/store";
import * as api from "@/api/library";
import { AUTO_LOCK_OPTIONS, LOCK_SETTINGS_EVENT } from "@/lib/lock";
import { useAccent, toggleOnClass } from "@/lib/theme";
import { cn } from "@/lib/utils";
import { useT, useTf } from "@/lib/i18n";

/**
 * Security settings: lock password, auto-lock timer, lock on sleep.
 * Saved in the DB, changes fire a window event so App re-arms the timers.
 */
export function SecurityPanel({ backed }: { backed: boolean }) {
  const t = useT();
  const tf = useTf();
  // light frosted inputs on iridescent
  const irid = useAccent() === "iridescent";
  // frosted fields with readable placeholder on iridescent
  const inputCls = (focus = "focus:border-brand-500/60 focus:ring-2 focus:ring-brand-500/20") =>
    cn(
      "h-9 rounded-lg border px-3 text-sm text-zinc-100 outline-none",
      irid
        ? "border-white/20 bg-white/10 backdrop-blur-md placeholder:text-zinc-300 focus:border-white/45"
        : cn("border-zinc-700 bg-zinc-950", focus),
    );
  const [pwSet, setPwSet] = useState(false);
  const [pw1, setPw1] = useState("");
  const [pw2, setPw2] = useState("");
  const [autoMinutes, setAutoMinutes] = useState(0);
  const [sleepLock, setSleepLock] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  // decoy password (opens safe mode)
  const [decoySet, setDecoySet] = useState(false);
  const [decoy1, setDecoy1] = useState("");
  const [decoy2, setDecoy2] = useState("");
  const [decoyNote, setDecoyNote] = useState<string | null>(null);
  // custom lock screen image (from the viewer), empty = default
  const [hasLockBg, setHasLockBg] = useState(false);

  // encryption
  const { refresh } = useData();
  const [encEnabled, setEncEnabled] = useState(false);
  const [encModal, setEncModal] = useState<null | "enable" | "disable">(null);
  const [understand, setUnderstand] = useState("");
  const [encPw, setEncPw] = useState("");
  const [encBusy, setEncBusy] = useState(false);
  const [encErr, setEncErr] = useState<string | null>(null);
  const [recovery, setRecovery] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);

  const load = useCallback(async () => {
    if (!backed) return;
    const [has, a, s, enc, bg, decoy] = await Promise.all([
      api.hasPassword(),
      api.getSetting("lock_auto_minutes"),
      api.getSetting("lock_on_sleep"),
      api.encryptionState(),
      api.getSetting("lock_bg"),
      api.hasDecoyPassword(),
    ]);
    setPwSet(has);
    setDecoySet(decoy);
    setAutoMinutes(Number(a ?? "0") || 0);
    setSleepLock(s === "true");
    setEncEnabled(enc.enabled);
    setHasLockBg(!!bg);
  }, [backed]);

  useEffect(() => {
    void load();
  }, [load]);

  // live progress for encrypt/decrypt
  useEffect(() => {
    const un = listen<{ done: number; total: number }>("encrypt-progress", (e) =>
      setProgress({ done: e.payload.done, total: e.payload.total }),
    );
    return () => {
      void un.then((f) => f());
    };
  }, []);

  const closeEncModal = () => {
    setEncModal(null);
    setUnderstand("");
    setEncPw("");
    setEncErr(null);
  };

  const confirmEnable = async () => {
    setEncBusy(true);
    setEncErr(null);
    setProgress({ done: 0, total: 0 });
    try {
      const code = await api.enableEncryption(encPw);
      setEncEnabled(true);
      closeEncModal();
      setRecovery(code);
      await refresh();
    } catch (e) {
      setEncErr(`${e}`);
    } finally {
      setEncBusy(false);
      setProgress(null);
    }
  };

  const confirmDisable = async () => {
    setEncBusy(true);
    setEncErr(null);
    setProgress({ done: 0, total: 0 });
    try {
      await api.disableEncryption(encPw);
      setEncEnabled(false);
      closeEncModal();
      await refresh();
    } catch (e) {
      setEncErr(`${e}`);
    } finally {
      setEncBusy(false);
      setProgress(null);
    }
  };

  const notifyApp = () => window.dispatchEvent(new Event(LOCK_SETTINGS_EVENT));

  const savePassword = async () => {
    if (pw1 !== pw2) {
      setNote(t("Passwords don’t match."));
      return;
    }
    if (!pw1) {
      setNote(t("Enter a password (or use Remove to clear it)."));
      return;
    }
    setBusy(true);
    try {
      await api.setPassword(pw1);
      setPw1("");
      setPw2("");
      setPwSet(true);
      // the Lock button only shows while a password exists
      notifyApp();
      setNote(t("Password saved."));
    } finally {
      setBusy(false);
    }
  };

  const removePassword = async () => {
    setBusy(true);
    try {
      await api.setPassword("");
      setPw1("");
      setPw2("");
      setPwSet(false);
      notifyApp();
      setNote(t("Password removed."));
    } finally {
      setBusy(false);
    }
  };

  const saveDecoy = async () => {
    if (decoy1 !== decoy2) {
      setDecoyNote(t("Decoy passwords don’t match."));
      return;
    }
    setBusy(true);
    try {
      await api.setDecoyPassword(decoy1);
      setDecoy1("");
      setDecoy2("");
      setDecoySet(true);
      setDecoyNote(t("Decoy saved. Lock MiColl and try it — you should land in safe mode."));
    } catch (e) {
      // the backend refuses a decoy = real password, one without a real password,
      // or (with encryption) one set while locked
      setDecoyNote(`${e}`);
    } finally {
      setBusy(false);
    }
  };

  const removeDecoy = async () => {
    setBusy(true);
    try {
      await api.setDecoyPassword("");
      setDecoy1("");
      setDecoy2("");
      setDecoySet(false);
      setDecoyNote(t("Decoy removed — only your real password opens MiColl now."));
    } finally {
      setBusy(false);
    }
  };

  const chooseAuto = async (minutes: number) => {
    setAutoMinutes(minutes);
    await api.setSetting("lock_auto_minutes", String(minutes));
    notifyApp();
  };

  const toggleSleep = async (on: boolean) => {
    setSleepLock(on);
    await api.setSetting("lock_on_sleep", on ? "true" : "false");
    notifyApp();
  };

  // clear the custom lock image
  const resetLockBg = async () => {
    setBusy(true);
    try {
      await api.setSetting("lock_bg", "");
      setHasLockBg(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section>
      <div className="flex items-center gap-2">
        <ShieldCheck className="h-5 w-5 text-brand-300" />
        <h1 className="text-2xl font-bold tracking-tight text-zinc-50">{t("Security & lock")}</h1>
      </div>
      <p className="settings-desc mt-1 text-sm text-zinc-400">
        {t("Protect MiColl with a password and lock it automatically when you step away.")}
      </p>

      {!backed ? (
        <div className="mt-6 rounded-xl border border-dashed border-zinc-800 bg-zinc-900/40 p-6 text-center text-sm text-zinc-400">
          {t("Lock settings run in the desktop app.")}
        </div>
      ) : (
        <div className="mt-5 space-y-4">
          {/* password */}
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
            <div className="flex items-center gap-2">
              <KeyRound className="h-4 w-4 text-zinc-400" />
              <h2 className="text-base font-semibold text-zinc-100">{t("Password")}</h2>
              {pwSet ? (
                <span className="ml-auto inline-flex items-center gap-1 rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-xs text-emerald-300">
                  <Check className="h-3 w-3" /> {t("Set")}
                </span>
              ) : (
                <span className="ml-auto rounded-full border border-zinc-700 bg-zinc-800 px-2 py-0.5 text-xs text-zinc-400">
                  {t("None")}
                </span>
              )}
            </div>
            <p className="settings-desc mt-1 text-sm text-zinc-400">
              {pwSet
                ? t("A password is required to unlock MiColl. Enter a new one to change it, or remove it.")
                : t("No password yet — the lock screen lets anyone continue. Set one to require it.")}
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <input
                type="password"
                value={pw1}
                onChange={(e) => {
                  setPw1(e.target.value);
                  setNote(null);
                }}
                placeholder={pwSet ? t("New password") : t("Password")}
                className={cn("w-44", inputCls())}
              />
              <input
                type="password"
                value={pw2}
                onChange={(e) => {
                  setPw2(e.target.value);
                  setNote(null);
                }}
                placeholder={t("Confirm")}
                className={cn("w-44", inputCls())}
              />
              <Button variant="primary" size="sm" onClick={savePassword} disabled={busy || !pw1}>
                <Lock className="h-4 w-4" />
                {pwSet ? t("Change") : t("Set password")}
              </Button>
              {pwSet && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={removePassword}
                  disabled={busy}
                  className="text-rose-300 hover:bg-rose-500/10 hover:text-rose-200"
                >
                  <Trash2 className="h-4 w-4" />
                  {t("Remove")}
                </Button>
              )}
            </div>
            {note && <p className="mt-2 text-xs text-brand-300">{note}</p>}
          </div>

          {/* decoy password -> safe mode */}
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
            <div className="flex items-center gap-2">
              <VenetianMask className="h-4 w-4 text-zinc-400" />
              <h2 className="text-base font-semibold text-zinc-100">{t("Decoy password")}</h2>
              {decoySet ? (
                <span className="ml-auto inline-flex items-center gap-1 rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-xs text-emerald-300">
                  <Check className="h-3 w-3" /> {t("Set")}
                </span>
              ) : (
                <span className="ml-auto rounded-full border border-zinc-700 bg-zinc-800 px-2 py-0.5 text-xs text-zinc-400">
                  {t("None")}
                </span>
              )}
            </div>
            <p className="settings-desc mt-1 text-sm text-zinc-400">
              {t("A second password that opens MiColl in")}{" "}
              <b className="text-zinc-300">{t("safe mode")}</b>
              {t(
                ": SFW only, with no way to switch it off and no settings. The lock screen gives nothing away — it opens exactly like the real one. To get back, lock MiColl and unlock it with your real password.",
              )}
            </p>
            {!pwSet && (
              <p className="mt-2 text-xs text-zinc-500">
                {t("Set a password above first — a decoy needs a real one to hide behind.")}
              </p>
            )}
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <input
                type="password"
                value={decoy1}
                onChange={(e) => {
                  setDecoy1(e.target.value);
                  setDecoyNote(null);
                }}
                placeholder={decoySet ? t("New decoy") : t("Decoy password")}
                disabled={!pwSet}
                className={cn("w-44 disabled:opacity-50", inputCls())}
              />
              <input
                type="password"
                value={decoy2}
                onChange={(e) => {
                  setDecoy2(e.target.value);
                  setDecoyNote(null);
                }}
                placeholder={t("Confirm")}
                disabled={!pwSet}
                className={cn("w-44 disabled:opacity-50", inputCls())}
              />
              <Button
                variant="primary"
                size="sm"
                onClick={saveDecoy}
                disabled={busy || !pwSet || !decoy1}
              >
                <VenetianMask className="h-4 w-4" />
                {decoySet ? t("Change") : t("Set decoy")}
              </Button>
              {decoySet && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={removeDecoy}
                  disabled={busy}
                  className="text-rose-300 hover:bg-rose-500/10 hover:text-rose-200"
                >
                  <Trash2 className="h-4 w-4" />
                  {t("Remove")}
                </Button>
              )}
            </div>
            {decoyNote && <p className="mt-2 text-xs text-brand-300">{decoyNote}</p>}
            <p className="settings-desc mt-2 text-xs text-zinc-500">
              {t(
                "Safe mode hides what MiColl shows — it isn’t a second, separate library. The files are still on disk, and turning encryption on clears the decoy (the new key can’t be wrapped under a password only its hash was kept for), so set it again afterwards.",
              )}
            </p>
          </div>

          {/* encryption */}
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
            <div className="flex items-center gap-2">
              <ShieldAlert className="h-4 w-4 text-zinc-400" />
              <h2 className="text-base font-semibold text-zinc-100">{t("Encrypt files")}</h2>
              {encEnabled ? (
                <span className="ml-auto inline-flex items-center gap-1 rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-xs text-emerald-300">
                  <Check className="h-3 w-3" /> On
                </span>
              ) : (
                <span className="ml-auto rounded-full border border-zinc-700 bg-zinc-800 px-2 py-0.5 text-xs text-zinc-400">
                  Off
                </span>
              )}
            </div>
            <p className="settings-desc mt-1 text-sm text-zinc-400">
              {encEnabled
                ? t("Your files are encrypted at rest — unreadable in Explorer and only viewable inside MiColl while unlocked.")
                : t("Scramble every media file on disk so it’s unreadable outside MiColl. Only your password (or recovery key) can open it.")}
            </p>
            {!pwSet && !encEnabled && (
              <p className="mt-2 text-xs text-amber-300">
                {t("Set a password above first — encryption is tied to it.")}
              </p>
            )}
            <div className="mt-3">
              {encEnabled ? (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setEncModal("disable")}
                  className="text-rose-300 hover:bg-rose-500/10 hover:text-rose-200"
                >
                  <Trash2 className="h-4 w-4" />
                  {t("Decrypt all files…")}
                </Button>
              ) : (
                <Button
                  variant="primary"
                  size="sm"
                  disabled={!pwSet}
                  onClick={() => setEncModal("enable")}
                >
                  <ShieldAlert className="h-4 w-4" />
                  {t("Encrypt all files…")}
                </Button>
              )}
            </div>
          </div>

          {/* auto-lock timer */}
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
            <div className="flex items-center gap-2">
              <Lock className="h-4 w-4 text-zinc-400" />
              <h2 className="text-base font-semibold text-zinc-100">{t("Auto-lock when idle")}</h2>
            </div>
            <p className="settings-desc mt-1 text-sm text-zinc-400">
              {t("Lock MiColl automatically after a stretch with no mouse or keyboard activity.")}
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              {AUTO_LOCK_OPTIONS.map((o) => {
                const active = autoMinutes === o.value;
                return (
                  <button
                    key={o.value}
                    onClick={() => void chooseAuto(o.value)}
                    className={cn(
                      "rounded-lg border px-3 py-1.5 text-sm transition-colors",
                      active
                        ? "border-brand-500/50 bg-brand-500/15 text-brand-200"
                        : irid
                          ? "border-white/15 bg-white/10 text-zinc-100 backdrop-blur-md hover:bg-white/20"
                          : "border-zinc-800 bg-zinc-900 text-zinc-300 micoll-hover",
                    )}
                  >
                    {o.label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* lock on sleep */}
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
            <div className="flex items-center gap-3">
              <Moon className="h-4 w-4 shrink-0 text-zinc-400" />
              <div className="min-w-0 flex-1">
                <h2 className="text-base font-semibold text-zinc-100">{t("Lock when the PC sleeps")}</h2>
                <p className="settings-desc mt-0.5 text-sm text-zinc-400">
                  {t("When your computer wakes from sleep, MiColl locks itself.")}
                </p>
              </div>
              <Toggle checked={sleepLock} onChange={(v) => void toggleSleep(v)} />
            </div>
          </div>

          {/* lock screen image */}
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
            <div className="flex items-center gap-3">
              <Image className="h-4 w-4 shrink-0 text-zinc-400" />
              <div className="min-w-0 flex-1">
                <h2 className="text-base font-semibold text-zinc-100">{t("Lock screen wallpaper")}</h2>
                <p className="settings-desc mt-0.5 text-sm text-zinc-400">
                  {hasLockBg
                    ? t("A custom wallpaper is set (chosen from the image viewer). Reset it to return to the default MiColl lock screen.")
                    : t("Using the default MiColl lock screen. Pick a custom one from any image in the viewer (right-click → Set as → Lock screen).")}
                </p>
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void resetLockBg()}
                disabled={busy || !hasLockBg}
                className="shrink-0"
              >
                <RotateCcw className="h-4 w-4" />
                {t("Reset")}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* enable/disable confirmation */}
      {encModal && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
          <div className="w-[32rem] max-w-full rounded-2xl border border-zinc-800 bg-zinc-900 p-5 shadow-2xl">
            <div className="flex items-center gap-2">
              <ShieldAlert className={`h-5 w-5 ${encModal === "enable" ? "text-rose-400" : "text-amber-400"}`} />
              <h2 className="text-base font-semibold text-zinc-100">
                {encModal === "enable" ? t("Encrypt all files") : t("Decrypt all files")}
              </h2>
            </div>

            {encModal === "enable" ? (
              <div className="mt-3 space-y-2 text-sm text-zinc-300">
                <p>{t("This encrypts every media file in your collection. Once on:")}</p>
                <ul className="list-disc space-y-1 pl-5 text-zinc-400">
                  <li>
                    {t("Files become")} <b className="text-zinc-200">{t("unreadable in Explorer")}</b>{" "}
                    {t("and any other app.")}
                  </li>
                  <li>{t("They open only inside MiColl, after you unlock with your password.")}</li>
                  <li>
                    <b className="text-rose-300">
                      {t("If you lose your password (and recovery key), the files are gone for good")}
                    </b>
                    {t("— there is no way to recover them.")}
                  </li>
                </ul>
                <p className="text-zinc-400">{t("A one-time recovery key will be shown right after.")}</p>
              </div>
            ) : (
              <p className="mt-3 text-sm text-zinc-300">
                {t("This decrypts every file back to normal, readable form on disk. Encryption will be turned off.")}
              </p>
            )}

            <div className="mt-4 space-y-2">
              <input
                type="password"
                value={encPw}
                onChange={(e) => {
                  setEncPw(e.target.value);
                  setEncErr(null);
                }}
                placeholder={t("Your MiColl password")}
                className="h-9 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 text-sm text-zinc-100 outline-none focus:border-brand-500/60"
              />
              {encModal === "enable" && (
                <input
                  value={understand}
                  onChange={(e) => setUnderstand(e.target.value)}
                  placeholder={tf("Type “{phrase}” to confirm", { phrase: t("I understand") })}
                  className="h-9 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 text-sm text-zinc-100 outline-none focus:border-rose-500/60"
                />
              )}
            </div>

            {progress && (
              <div className="mt-3">
                <div className="mb-1 flex items-center justify-between text-xs text-zinc-400">
                  <span className="inline-flex items-center gap-1.5">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    {encModal === "enable" ? t("Encrypting…") : t("Decrypting…")}
                  </span>
                  <span className="tabular-nums">
                    {progress.done}
                    {progress.total ? ` / ${progress.total}` : ""}
                  </span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-zinc-800">
                  <div
                    className="h-full rounded-full bg-brand-500 transition-all"
                    style={{ width: `${progress.total ? (progress.done / progress.total) * 100 : 10}%` }}
                  />
                </div>
              </div>
            )}

            {encErr && <p className="mt-2 text-sm text-rose-300">{encErr}</p>}

            <div className="mt-4 flex justify-end gap-2">
              <Button variant="ghost" onClick={closeEncModal} disabled={encBusy}>
                {t("Cancel")}
              </Button>
              {encModal === "enable" ? (
                <Button
                  variant="primary"
                  onClick={() => void confirmEnable()}
                  disabled={encBusy || !encPw || understand.trim() !== t("I understand")}
                >
                  {encBusy ? t("Encrypting…") : t("Encrypt everything")}
                </Button>
              ) : (
                <Button
                  variant="primary"
                  onClick={() => void confirmDisable()}
                  disabled={encBusy || !encPw}
                >
                  {encBusy ? t("Decrypting…") : t("Decrypt everything")}
                </Button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* one-time recovery key */}
      {recovery && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
          <div className="w-[32rem] max-w-full rounded-2xl border border-zinc-800 bg-zinc-900 p-5 shadow-2xl">
            <div className="flex items-center gap-2">
              <KeyRound className="h-5 w-5 text-brand-300" />
              <h2 className="text-base font-semibold text-zinc-100">{t("Save your recovery key")}</h2>
            </div>
            <p className="mt-2 text-sm text-zinc-300">
              {t("Store this somewhere safe. It’s the")} <b>{t("only")}</b>{" "}
              {t("way back in if you forget your password. It won’t be shown again.")}
            </p>
            <div className="mt-3 flex items-center gap-2 rounded-lg border border-brand-500/30 bg-brand-500/10 p-3">
              <code className="flex-1 select-all break-all font-mono text-sm text-brand-100">{recovery}</code>
              <button
                onClick={() => void navigator.clipboard.writeText(recovery)}
                title={t("Copy")}
                className="shrink-0 rounded-md p-1.5 text-zinc-300 hover:bg-white/10 hover:text-white"
              >
                <Copy className="h-4 w-4" />
              </button>
            </div>
            <div className="mt-4 flex justify-end">
              <Button variant="primary" onClick={() => setRecovery(null)}>
                {t("I’ve saved it")}
              </Button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

/** Simple on/off switch. */
function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  const accent = useAccent();
  return (
    <button
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={cn(
        "micoll-switch relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors",
        checked ? toggleOnClass(accent) : "bg-zinc-700",
      )}
    >
      <span
        className={cn(
          "micoll-switch-knob inline-block h-5 w-5 transform rounded-full bg-white transition-transform",
          checked ? "translate-x-5" : "translate-x-0.5",
        )}
      />
    </button>
  );
}
