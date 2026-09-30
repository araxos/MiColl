import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { open, save } from "@tauri-apps/plugin-dialog";
import { documentDir, join } from "@tauri-apps/api/path";
import {
  AlertTriangle,
  ArrowRight,
  Check,
  Download,
  Eye,
  EyeOff,
  FolderOpen,
  KeyRound,
  Loader2,
  Plus,
  Sparkles,
  X,
} from "lucide-react";
import * as api from "@/api/library";
import { BrandHeartMark } from "@/components/BrandHeart";
import { SetupCloseButton } from "@/components/SetupCloseButton";
import { PLATFORMS } from "@/lib/platforms";
import { addPlatform, setPlatformsInitialized } from "@/lib/platformRegistry";
import { ACCENTS, applyAccent, useAccent } from "@/lib/theme";
import { cn } from "@/lib/utils";
import { useT, useTf } from "@/lib/i18n";

/**
 * First-run screens for a new library: welcome + 4 questions
 * (platforms, managed collection, password, theme).
 * Everything can be skipped and changed later in Settings.
 * The theme comes last because it's the only answer you see right away.
 */

const STEPS = ["Welcome", "Platforms", "Library", "Password", "Look"] as const;
const LAST = STEPS.length - 1;

export function FirstRunWizard({ onDone }: { onDone: () => void }) {
  const t = useT();
  const tf = useTf();
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);

  // step 1 - which platforms
  const [chosen, setChosen] = useState<string[]>([]);
  const [custom, setCustom] = useState("");

  // step 2 - managed collection. Off, but Documents\MiColl is already filled in
  const [root, setRoot] = useState<string | null>(null);
  const [managedWanted, setManagedWanted] = useState(false);
  const [managedOn, setManagedOn] = useState(false);

  // step 3 - lock password
  const [pw1, setPw1] = useState("");
  const [pw2, setPw2] = useState("");
  const [pwNote, setPwNote] = useState<string | null>(null);
  const [showPw, setShowPw] = useState(false);
  // "are you sure" windows: going on without a managed collection, and the password
  const [confirmUnmanaged, setConfirmUnmanaged] = useState(false);
  const [confirmPw, setConfirmPw] = useState(false);
  const [pwSaved, setPwSaved] = useState(false);

  // step 4 - theme (only the standard ones, premium must be bought)
  const accent = useAccent();

  // suggested folder, fails harmlessly in the browser
  useEffect(() => {
    void (async () => {
      try {
        const p = await join(await documentDir(), "MiColl");
        setRoot((r) => r ?? p);
      } catch {
        /* no path API, the user picks one */
      }
    })();
  }, []);

  const toggle = (name: string) =>
    setChosen((c) =>
      c.some((x) => x.toLowerCase() === name.toLowerCase())
        ? c.filter((x) => x.toLowerCase() !== name.toLowerCase())
        : [...c, name],
    );

  const addCustom = () => {
    const nm = custom.trim();
    if (!nm) return;
    if (!chosen.some((x) => x.toLowerCase() === nm.toLowerCase())) setChosen((c) => [...c, nm]);
    setCustom("");
  };

  /** The platform step must be saved before moving on. */
  const commitPlatforms = () => {
    for (const p of chosen) addPlatform(p);
    setPlatformsInitialized();
  };

  const pickFolder = async () => {
    const picked = await open({
      directory: true,
      multiple: false,
      title: t("Choose where the MiColl collection should live"),
    });
    if (typeof picked === "string") setRoot(picked);
  };

  /** Turn on the managed collection only if the box is checked. */
  const commitLibrary = async () => {
    if (!managedWanted || !root) {
      // without it is the less tested way, ask first
      setConfirmUnmanaged(true);
      return;
    }
    setBusy(true);
    try {
      await api.setSetting("collection_root", root);
      await api.setSetting("managed_enabled", "true");
      setManagedOn(true);
      setStep(3);
    } finally {
      setBusy(false);
    }
  };

  const savePassword = async () => {
    if (!pw1) {
      setPwNote(t("Type a password, or skip this step."));
      return;
    }
    if (pw1 !== pw2) {
      setPwNote(t("The two don’t match."));
      return;
    }
    setPwNote(null);
    setPwSaved(false);
    setConfirmPw(true);
  };

  /** After the no-recovery warning: really set it. */
  const commitPassword = async () => {
    setBusy(true);
    try {
      await api.setPassword(pw1);
      setConfirmPw(false);
      setStep(4);
    } finally {
      setBusy(false);
    }
  };

  /** Save the password as a text file where the user wants it. */
  const downloadPassword = async () => {
    const path = await save({
      title: t("Save your MiColl password"),
      defaultPath: "pw.txt",
      filters: [{ name: "Text", extensions: ["txt"] }],
    });
    if (typeof path !== "string") return;
    // plain text write (the same command the template download uses)
    await api.exportTemplate(path, `MiColl password: ${pw1}\r\n`);
    setPwSaved(true);
  };

  const finish = async () => {
    setBusy(true);
    try {
      await api.setSetting("first_run_done", "true");
    } finally {
      setBusy(false);
      onDone();
    }
  };

  /** Skip = move on without doing the step (the platform step still saves "answered"). */
  const skip = () => {
    if (step === 2) {
      setConfirmUnmanaged(true);
      return;
    }
    if (step === 1) commitPlatforms();
    if (step < LAST) setStep(step + 1);
    else void finish();
  };

  const fieldCls =
    "h-10 w-full rounded-xl border border-white/12 bg-black/25 px-3 text-sm text-zinc-100 outline-none transition-colors placeholder:text-zinc-500 focus:border-white/35";

  return (
    <div className="setup-bg fixed inset-0 z-[200] flex items-center justify-center p-4">
      {/* drag strip, this screen covers the header */}
      <div data-tauri-drag-region className="absolute inset-x-0 top-0 h-14" />
      <SetupCloseButton />
      <motion.div
        initial={{ opacity: 0, y: 14, scale: 0.985 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
        className="setup-panel flex max-h-[92vh] w-[38rem] max-w-full flex-col overflow-hidden rounded-3xl"
      >
        {/* ---- welcome ---- */}
        {step === 0 ? (
          <>
          {/* scrollable, the button stays below it so it's always visible (min window is
              640 high) */}
          <div className="min-h-0 flex-1 overflow-y-auto px-9 pb-2 pt-9 text-center">
            <BrandHeartMark className="mx-auto mb-6" />

            <h1 className="text-[1.75rem] font-semibold tracking-tight text-white">
              {t("Welcome to MiColl")}
            </h1>
            <p className="mx-auto mt-2 max-w-[26rem] text-[15px] leading-relaxed text-zinc-300">
              {t(
                "Everything you’ve collected, finally in one place — sorted by the people who made it, and quiet enough to actually enjoy looking at.",
              )}
            </p>

            <div className="mx-auto mt-7 grid max-w-[26rem] gap-2.5 text-left">
              {[
                {
                  title: "One shelf for all of it",
                  body: "Creators, months, rewards — whatever platform they came from.",
                },
                {
                  title: "You can see what’s missing",
                  body: "Months you skipped and rewards you don’t have yet are visible, not guessed.",
                },
                {
                  title: "It stays yours",
                  body: "Everything lives on your disk. MiColl never uploads a thing.",
                },
              ].map((f) => (
                <div key={f.title} className="setup-card flex gap-3 rounded-2xl px-4 py-3">
                  <Check
                    className="mt-0.5 h-4 w-4 shrink-0"
                    style={{ color: "var(--color-brand-400)" }}
                  />
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-zinc-100">{t(f.title)}</div>
                    <div className="mt-0.5 text-xs leading-relaxed text-zinc-400">{t(f.body)}</div>
                  </div>
                </div>
              ))}
            </div>

          </div>
          <div className="px-9 pb-8 pt-4 text-center">
            <button onClick={() => setStep(1)} className="setup-btn setup-btn--primary px-6">
              {t("Set it up")}
              <ArrowRight className="h-4 w-4" />
            </button>
            <p className="mt-3 text-[11px] text-zinc-500">
              {t("Four short questions. All of them optional, all of them in Settings later.")}
            </p>
          </div>
          </>
        ) : (
          <>
            <div className="border-b border-white/8 px-7 pb-4 pt-6">
              <div className="flex items-center gap-1.5">
                {STEPS.slice(1).map((label, i) => {
                  const n = i + 1;
                  const done = n < step;
                  const on = n === step;
                  return (
                    <span key={label} className="flex items-center gap-1.5">
                      <span
                        className={cn(
                          "flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors",
                          on
                            ? "text-white"
                            : done
                              ? "text-zinc-300"
                              : "text-zinc-400",
                        )}
                        style={
                          on
                            ? {
                                backgroundColor:
                                  "color-mix(in srgb, var(--color-brand-500) 22%, transparent)",
                              }
                            : undefined
                        }
                      >
                        {done ? (
                          <Check
                            className="h-3 w-3"
                            style={{ color: "var(--color-brand-400)" }}
                          />
                        ) : (
                          <span className="tabular-nums">{n}</span>
                        )}
                        {t(label)}
                      </span>
                      {n < LAST && <span className="h-px w-3 bg-white/10" />}
                    </span>
                  );
                })}
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-7 py-6">
              {step === 1 && (
                <>
                  <h2 className="text-lg font-semibold text-white">
                    {t("Which platforms do you use?")}
                  </h2>
                  <p className="mt-1.5 text-sm leading-relaxed text-zinc-400">
                    {t(
                      "These fill the platform menus. Pick the ones you actually buy from — the list stays short and useful that way. Anything without a platform waits in",
                    )}{" "}
                    <b className="text-zinc-300">{t("Unsorted")}</b>
                    {t(" until you pick one;")}{" "}
                    <b className="text-zinc-300">{t("Misc")}</b>
                    {t(" is for the ones you’ll never know. You can add more platforms whenever.")}
                  </p>

                  <div className="mt-5 flex flex-wrap justify-center gap-2">
                    {PLATFORMS.map((p) => {
                      const on = chosen.some((x) => x.toLowerCase() === p.toLowerCase());
                      return (
                        <button
                          key={p}
                          data-on={on ? "1" : "0"}
                          onClick={() => toggle(p)}
                          className="setup-chip inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-zinc-300"
                        >
                          {on ? (
                            <Check className="h-3.5 w-3.5" />
                          ) : (
                            <Plus className="h-3.5 w-3.5 opacity-70" />
                          )}
                          {p}
                        </button>
                      );
                    })}
                  </div>

                  {/* other platforms (shop, Discord, website...) */}
                  <div className="mt-5 flex items-center gap-2">
                    <input
                      value={custom}
                      onChange={(e) => setCustom(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && addCustom()}
                      placeholder={t("Somewhere else you buy from…")}
                      className={fieldCls}
                    />
                    <button
                      onClick={addCustom}
                      disabled={!custom.trim()}
                      className="setup-btn setup-btn--ghost"
                    >
                      <Plus className="h-4 w-4" />
                      {t("Add")}
                    </button>
                  </div>

                  {chosen.length > 0 && (
                    <div className="setup-card mt-5 rounded-2xl px-4 py-3">
                      <div className="text-[11px] font-medium uppercase tracking-wide text-zinc-500">
                        {t("Your list")}
                      </div>
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {chosen.map((p) => (
                          <span
                            key={p}
                            className="inline-flex items-center gap-1 rounded-full border border-white/12 bg-white/5 px-2.5 py-0.5 text-xs text-zinc-200"
                          >
                            {p}
                            <button
                              onClick={() => toggle(p)}
                              title={tf("Remove {name}", { name: p })}
                              className="text-zinc-500 transition-colors hover:text-zinc-200"
                            >
                              <X className="h-3 w-3" />
                            </button>
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                </>
              )}

              {step === 2 && (
                <>
                  <h2 className="text-lg font-semibold text-white">{t("Keep it all in one folder?")}</h2>
                  <p className="mt-1.5 text-sm leading-relaxed text-zinc-400">
                    {t("A")} <b className="text-zinc-300">{t("managed collection")}</b>{" "}
                    {t("is one folder MiColl owns and files everything into, as")}{" "}
                    <span className="text-zinc-300">
                      {t("Creator / Platform / Year / Month")}
                    </span>
                    {t(
                      ". Imports sort themselves, nothing stays scattered across download folders, and a backup is one folder to copy.",
                    )}
                  </p>
                  <p className="mt-2 text-sm leading-relaxed text-zinc-400">
                    {t(
                      "Without it MiColl reads your folders where they are and never moves a file. That works too — it just leaves the tidying to you.",
                    )}
                  </p>

                  <div className="setup-card mt-5 rounded-2xl px-4 py-4">
                    <div className="flex items-start justify-between gap-3">
                      <label className="flex cursor-pointer items-center gap-2.5 text-sm font-medium text-zinc-100">
                        <input
                          type="checkbox"
                          checked={managedWanted}
                          onChange={(e) => setManagedWanted(e.target.checked)}
                          className="peer sr-only"
                        />
                        {/* own checkbox instead of the grey Windows one */}
                        <span
                          aria-hidden
                          className="flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-[6px] border border-white/25 bg-black/25 transition-colors peer-checked:border-transparent peer-focus-visible:ring-2 peer-focus-visible:ring-white/40"
                          style={
                            managedWanted
                              ? { backgroundColor: "var(--color-brand-500)" }
                              : undefined
                          }
                        >
                          {managedWanted && (
                            <Check className="h-3 w-3 text-white" strokeWidth={3.5} />
                          )}
                        </span>
                        {t("Use a managed collection")}
                      </label>
                      <span className="shrink-0 rounded-full border border-emerald-400/30 bg-emerald-400/12 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-300">
                        {t("Recommended")}
                      </span>
                    </div>

                    <div
                      className={cn(
                        "mt-3.5 transition-opacity",
                        managedWanted ? "opacity-100" : "opacity-45",
                      )}
                    >
                      <div className="flex items-center gap-2 text-xs font-medium text-zinc-300">
                        <FolderOpen
                          className="h-3.5 w-3.5"
                          style={{ color: "var(--color-brand-400)" }}
                        />
                        {t("Collection folder")}
                      </div>
                      <p className="mt-1.5 break-all font-mono text-xs text-zinc-400">
                        {root ?? t("Choose one below")}
                      </p>
                      <button
                        onClick={() => void pickFolder()}
                        className="setup-btn setup-btn--ghost mt-3"
                      >
                        {t("Change folder…")}
                      </button>
                    </div>

                    <p className="mt-3.5 text-[11px] leading-relaxed text-zinc-500">
                      {t(
                        "Nothing moves now. Content you already have is only relocated when you press “Organize now” in Settings.",
                      )}
                    </p>
                  </div>
                </>
              )}

              {step === 3 && (
                <>
                  <h2 className="text-lg font-semibold text-white">
                    {t("Lock MiColl with a password?")}
                  </h2>
                  <p className="mt-1.5 text-sm leading-relaxed text-zinc-400">
                    {t(
                      "It gates the app on start and whenever you lock it. This is a door, not a safe — it doesn’t encrypt anything, and your files stay readable in Explorer. Encryption is its own switch in Settings → Security.",
                    )}
                  </p>

                  <div className="setup-card mt-5 space-y-2.5 rounded-2xl px-4 py-4">
                    <div className="flex items-center gap-2 text-sm font-medium text-zinc-100">
                      <KeyRound className="h-4 w-4" style={{ color: "var(--color-brand-400)" }} />
                      {t("Password")}
                    </div>
                    {[
                      { value: pw1, set: setPw1, placeholder: "Password", enter: false },
                      { value: pw2, set: setPw2, placeholder: "Repeat it", enter: true },
                    ].map((f) => (
                      <div key={f.placeholder} className="relative">
                        <input
                          type={showPw ? "text" : "password"}
                          value={f.value}
                          onChange={(e) => f.set(e.target.value)}
                          onKeyDown={
                            f.enter ? (e) => e.key === "Enter" && void savePassword() : undefined
                          }
                          placeholder={t(f.placeholder)}
                          className={cn(fieldCls, "pr-10")}
                        />
                        <button
                          type="button"
                          onClick={() => setShowPw((s) => !s)}
                          title={showPw ? t("Hide password") : t("Show password")}
                          aria-label={showPw ? t("Hide password") : t("Show password")}
                          className="absolute right-1.5 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-lg text-zinc-400 transition-colors hover:bg-white/10 hover:text-zinc-100"
                        >
                          {showPw ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                        </button>
                      </div>
                    ))}
                    {pwNote && <p className="text-xs text-amber-300">{pwNote}</p>}
                    <p className="flex items-start gap-2 text-[13px] font-medium leading-relaxed text-rose-300">
                      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                      {t(
                        "There is no recovery for this — MiColl stores a hash, never the password itself.",
                      )}
                    </p>
                  </div>

                  {managedOn && (
                    <p className="mt-4 flex items-center gap-2 text-xs text-zinc-400">
                      <Sparkles className="h-3.5 w-3.5" style={{ color: "var(--color-brand-400)" }} />
                      {t("Managed collection is on — imports will file themselves from here.")}
                    </p>
                  )}
                </>
              )}
              {step === 4 && (
                <>
                  <h2 className="text-lg font-semibold text-white">
                    {t("What should MiColl look like?")}
                  </h2>
                  <p className="mt-1.5 text-sm leading-relaxed text-zinc-400">
                    {t(
                      "Pick a colour and the whole app takes it — including this window, right now. Nothing is settled here for good; the full list lives in Settings under Appearance.",
                    )}
                  </p>

                  <div className="mt-5 grid grid-cols-3 gap-2.5">
                    {ACCENTS.filter((a) => a.tier === "basic").map((a) => {
                      const on = accent === a.key;
                      return (
                        <button
                          key={a.key}
                          data-on={on ? "1" : "0"}
                          onClick={() => applyAccent(a.key)}
                          // same chip as the platforms, lit in the theme it stands for
                          className="setup-chip flex items-center gap-2.5 px-3 py-2.5 text-left text-sm font-medium text-zinc-300"
                        >
                          <span
                            aria-hidden
                            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full shadow-inner ring-1 ring-white/25"
                            style={{
                              background: a.swatch ?? `linear-gradient(135deg, ${a.from}, ${a.to})`,
                            }}
                          >
                            {on && (
                              <Check
                                className="h-3.5 w-3.5 text-white drop-shadow-[0_1px_2px_rgba(0,0,0,0.85)]"
                                strokeWidth={3}
                              />
                            )}
                          </span>
                          <span className="truncate">{t(a.label)}</span>
                        </button>
                      );
                    })}
                  </div>

                  <p className="mt-4 text-[11px] leading-relaxed text-zinc-500">
                    {t(
                      "Three more — Iridescent, Sakura and Cyberpunk — are themes of their own rather than colours, and are unlocked with a theme key. They sit in Settings whenever you are curious.",
                    )}
                  </p>
                </>
              )}
            </div>

            <div className="flex items-center justify-between gap-3 border-t border-white/8 px-7 py-4">
              <button
                onClick={skip}
                disabled={busy}
                className="text-sm text-zinc-500 transition-colors hover:text-zinc-200"
              >
                {step === 3 ? t("Skip — no password") : t("Skip this")}
              </button>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setStep(step - 1)}
                  disabled={busy}
                  className="setup-btn setup-btn--ghost"
                >
                  {t("Back")}
                </button>
                {step === 1 && (
                  <button
                    onClick={() => {
                      commitPlatforms();
                      setStep(2);
                    }}
                    className="setup-btn setup-btn--primary"
                  >
                    {chosen.length > 0 ? tf("Use these {n}", { n: chosen.length }) : t("Continue")}
                    <ArrowRight className="h-4 w-4" />
                  </button>
                )}
                {step === 2 && (
                  <button
                    onClick={() => void commitLibrary()}
                    disabled={busy || (managedWanted && !root)}
                    className="setup-btn setup-btn--primary"
                  >
                    {busy && <Loader2 className="h-4 w-4 animate-spin" />}
                    {t("Continue")}
                    <ArrowRight className="h-4 w-4" />
                  </button>
                )}
                {step === 3 && (
                  <button
                    onClick={() => void savePassword()}
                    disabled={busy}
                    className="setup-btn setup-btn--primary"
                  >
                    {busy && <Loader2 className="h-4 w-4 animate-spin" />}
                    {t("Set password")}
                  </button>
                )}
                {step === 4 && (
                  <button
                    onClick={() => void finish()}
                    disabled={busy}
                    className="setup-btn setup-btn--primary"
                  >
                    {busy && <Loader2 className="h-4 w-4 animate-spin" />}
                    {t("Done")}
                  </button>
                )}
              </div>
            </div>
          </>
        )}
      </motion.div>

      {confirmUnmanaged && (
        <WizardAsk
          title={t("Continue without a managed collection?")}
          body={t(
            "Reading your folders where they are hasn’t been tested as much yet and may be unstable, so there’s no guarantee it works in every case. You can turn the managed collection on later in Settings.",
          )}
          onCancel={() => setConfirmUnmanaged(false)}
          actions={
            <button
              onClick={() => {
                setConfirmUnmanaged(false);
                setStep(3);
              }}
              className="setup-btn setup-btn--primary"
            >
              {t("Continue anyway")}
              <ArrowRight className="h-4 w-4" />
            </button>
          }
        />
      )}

      {confirmPw && (
        <WizardAsk
          title={t("There’s no way to recover this password")}
          body={t(
            "If you forget it, MiColl can’t get you back in. Save it somewhere safe — for example as a text file.",
          )}
          onCancel={() => setConfirmPw(false)}
          actions={
            <>
              <button
                onClick={() => void downloadPassword()}
                disabled={busy}
                className="setup-btn setup-btn--ghost"
              >
                {pwSaved ? <Check className="h-4 w-4" /> : <Download className="h-4 w-4" />}
                {pwSaved ? t("Saved") : t("Download pw.txt")}
              </button>
              <button
                onClick={() => void commitPassword()}
                disabled={busy}
                className="setup-btn setup-btn--primary"
              >
                {busy && <Loader2 className="h-4 w-4 animate-spin" />}
                {t("Continue")}
                <ArrowRight className="h-4 w-4" />
              </button>
            </>
          }
        />
      )}
    </div>
  );
}

/** Small "are you sure" window over the wizard, in the wizard's own look. */
function WizardAsk({
  title,
  body,
  actions,
  onCancel,
}: {
  title: string;
  body: string;
  actions: React.ReactNode;
  onCancel: () => void;
}) {
  const t = useT();
  return (
    <div
      className="absolute inset-0 z-10 flex items-center justify-center bg-black/55 p-4 backdrop-blur-sm"
      onClick={onCancel}
    >
      <motion.div
        initial={{ opacity: 0, y: 8, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
        onClick={(e) => e.stopPropagation()}
        role="alertdialog"
        aria-modal
        className="setup-panel w-[28rem] max-w-full rounded-3xl px-6 py-5"
      >
        <div className="flex items-start gap-3">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-300" />
          <div className="min-w-0">
            <h3 className="text-base font-semibold text-white">{title}</h3>
            <p className="mt-1.5 text-sm leading-relaxed text-zinc-300">{body}</p>
          </div>
        </div>
        <div className="mt-5 flex flex-wrap items-center justify-end gap-2">
          <button onClick={onCancel} className="setup-btn setup-btn--ghost">
            {t("Cancel")}
          </button>
          {actions}
        </div>
      </motion.div>
    </div>
  );
}
