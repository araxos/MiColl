import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { X, KeyRound, Sparkles, Copy, Check, BadgeCheck, Trash2, Clock } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/utils";
import { useT, useTf } from "@/lib/i18n";
import { useDialogTheme } from "@/lib/dialogTheme";
import * as api from "@/api/library";
import { setLicensee, setPremiumUnlocked, setTrialUntil, useAccent, THEME_PACKS } from "@/lib/theme";
import { PATREON_URL, SALES_OPEN } from "@/lib/sales";

/**
 * Unlock or manage the premium themes with a signed key.
 *   - locked: paste a key -> checked offline -> saved in the DB -> unlocked
 *   - unlocked: show the state + "remove key from this device"
 *   - owner (signing key installed): generate keys for buyers
 */
export function ThemeUnlockDialog({
  onClose,
  onUnlocked,
}: {
  onClose: () => void;
  /** Called after a key was accepted. */
  onUnlocked?: () => void;
}) {
  const t = useT();
  const tf = useTf();
  const accent = useAccent();
  /** All surfaces come from the theme (see lib/dialogTheme). */
  const dlg = useDialogTheme();
  /** square corners on cyberpunk */
  const round = accent === "cyberpunk" ? "rounded-none" : "rounded-lg";
  /** The pack this dialog sells (only one for now). */
  const pack = THEME_PACKS[0];
  const [unlocked, setUnlocked] = useState(false);
  const [buyerOnKey, setBuyerOnKey] = useState<string | null>(null);
  /** Short fingerprint of the key (for leak reports and the revocation list). */
  const [fingerprint, setFingerprint] = useState<string | null>(null);
  /** Last day of a test key. */
  const [endsOn, setEndsOn] = useState<string | null>(null);
  const [token, setToken] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // key generation, only where the signing key is
  const [canSign, setCanSign] = useState(false);
  const [buyer, setBuyer] = useState("");
  /** Test key type: ends on a date OR after some days, never both. */
  const [term, setTerm] = useState<"forever" | "until" | "days">("forever");
  const [until, setUntil] = useState("");
  /** A date in the past (allowed, but show a warning). */
  const pastDate =
    term === "until" &&
    until.trim().length === 10 &&
    until.trim() < new Date().toISOString().slice(0, 10);
  const [days, setDays] = useState("30");
  const [issued, setIssued] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    api.canSign().then(setCanSign).catch(() => setCanSign(false));
    // load the current state (and the buyer of the saved key)
    api
      .getSetting("themes_license")
      .then(async (stored) => {
        if (!stored || !stored.trim()) return;
        try {
          const lic = await api.verifyThemeLicense(stored);
          setBuyerOnKey(lic.buyer);
          setLicensee(lic.buyer);
          const ends = lic.trial ? lic.until : null;
          setEndsOn(ends);
          setTrialUntil(ends);
          setUnlocked(true);
          setFingerprint(await api.themeKeyFingerprint(stored).catch(() => null));
        } catch {
          /* broken saved key -> treat as locked */
        }
      })
      .catch(() => {});
  }, []);

  const activate = async () => {
    setBusy(true);
    setErr(null);
    try {
      const lic = await api.verifyThemeLicense(token);
      await api.setSetting("themes_license", token.trim());
      setPremiumUnlocked(true);
      setBuyerOnKey(lic.buyer);
      setLicensee(lic.buyer);
      const ends = lic.trial ? lic.until : null;
      setEndsOn(ends);
      setTrialUntil(ends);
      setFingerprint(await api.themeKeyFingerprint(token).catch(() => null));
      setUnlocked(true);
      onUnlocked?.();
    } catch (e) {
      setErr(`${e}`);
    } finally {
      setBusy(false);
    }
  };

  const removeKey = async () => {
    setBusy(true);
    try {
      await api.setSetting("themes_license", "");
      setPremiumUnlocked(false);
      setLicensee(null);
      setTrialUntil(null);
      setUnlocked(false);
      setBuyerOnKey(null);
      setFingerprint(null);
      setEndsOn(null);
      setToken("");
    } finally {
      setBusy(false);
    }
  };

  const generate = async () => {
    setBusy(true);
    setErr(null);
    try {
      setIssued(
        await api.issueThemeKey(
          buyer,
          term === "until" ? { expires: until.trim() }
          : term === "days" ? { days: Number(days) || 0 }
          : undefined,
        ),
      );
      setCopied(false);
    } catch (e) {
      setErr(`${e}`);
    } finally {
      setBusy(false);
    }
  };

  const copyIssued = async () => {
    if (!issued) return;
    try {
      await navigator.clipboard.writeText(issued);
      setCopied(true);
    } catch {
      /* no clipboard, the key can still be selected below */
    }
  };

  // dialog surface per theme. overflow-y-auto after it because iridescent sets
  // overflow-hidden
  const panelClass = cn(
    "relative flex max-h-[85vh] w-[30rem] max-w-full flex-col p-5",
    dlg.panel,
    "overflow-y-auto",
  );
  const headerGrad =
    accent === "cyberpunk"
      ? "from-[#fcee0a] to-[#00e5ff]"
      : accent === "sakura"
        ? "from-[#f472b6] to-[#ffe1ee]"
        : accent === "iridescent"
          ? "from-[#c4b5fd] via-[#f5c2ff] to-[#a7f3d0]"
          : "from-brand-300 to-accent2-300";

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
      {/* keep the window draggable */}
      <div data-tauri-drag-region className="absolute inset-x-0 top-0 h-14" />
      <motion.div
        initial={{ opacity: 0, y: 14, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        className={panelClass}
      >
        <div className="flex items-start justify-between">
          <div>
            <h2
              className={cn(
                "flex items-center gap-2 bg-gradient-to-r bg-clip-text text-lg font-bold text-transparent",
                headerGrad,
              )}
            >
              <Sparkles className="h-5 w-5 text-yellow-300" />
              {/* the pack's name (there could be more packs later) */}
              {pack.name}
            </h2>
            <p className="mt-1 text-sm text-zinc-400">
              {t("Iridescent, Sakura and Cyberpunk — unlocked permanently with a personal key.")}
            </p>
          </div>
          <button
            onClick={onClose}
            className={cn("shrink-0 p-1.5 text-zinc-400 transition-colors", round, dlg.menuRow)}
            title={t("Close")}
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {unlocked ? (
          <div className="mt-4 space-y-3">
            {/* green in every theme (it's a state) */}
            <div
              className={cn(
                "flex items-center gap-2.5 border border-emerald-400/30 bg-emerald-500/10 px-3 py-2.5 text-sm text-emerald-200",
                accent === "cyberpunk" ? "rounded-none" : "rounded-xl",
              )}
            >
              <BadgeCheck className="h-5 w-5 shrink-0" />
              <span>
                {tf("{pack} is unlocked on this device", { pack: pack.name })}
                {buyerOnKey ? (
                  <>
                    {" "}
                    {t("— key issued to")}{" "}
                    <span className="font-semibold">{buyerOnKey}</span>
                  </>
                ) : null}
                .
              </span>
            </div>
            {/* the buyer's name stays visible (makes sharing keys awkward) */}
            {endsOn && (
              <p className="text-xs text-amber-300/90">
                {tf("Test key — the themes stay unlocked until {date}.", { date: endsOn })}
              </p>
            )}
            {fingerprint && (
              <p className="text-xs text-zinc-500">
                {t("Key")} <span className="font-mono text-zinc-400">{fingerprint}</span>{" "}
                {t("— quote this if you ever need it replaced.")}
              </p>
            )}
            <button
              onClick={removeKey}
              disabled={busy}
              className="flex items-center gap-1.5 text-xs text-zinc-500 hover:text-rose-300"
              title={t(
                "Removes the key from this device only — the key itself stays valid and can be entered again.",
              )}
            >
              <Trash2 className="h-3.5 w-3.5" />
              {t("Remove key from this device")}
            </button>
          </div>
        ) : (
          <div className="mt-4 space-y-3">
            <label className="block text-xs font-medium uppercase tracking-wide text-zinc-500">
              {t("Your theme key")}
            </label>
            <textarea
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="MICOLL-THEMES.…"
              rows={3}
              spellCheck={false}
              className={cn(
                "w-full resize-none px-3 py-2 font-mono text-xs text-zinc-100 outline-none transition-colors placeholder:text-zinc-500",
                dlg.field,
              )}
            />
            {err && <p className="text-sm text-rose-300">{err}</p>}
            <div className="flex items-center justify-between gap-2">
              {SALES_OPEN && PATREON_URL ? (
                <button
                  onClick={() => void api.openUrl(PATREON_URL)}
                  className="text-sm text-zinc-400 underline decoration-zinc-600 underline-offset-2 hover:text-zinc-200"
                >
                  {t("Get a key on Patreon ($5, yours forever)")}
                </button>
              ) : (
                // buying isn't open yet (see lib/sales.ts)
                <p className="flex items-center gap-1.5 text-sm text-zinc-400">
                  <Clock className="h-4 w-4 shrink-0" />
                  {t("Buying a key isn’t available yet — it opens soon.")}
                </p>
              )}
              <Button
                variant="primary"
                onClick={activate}
                disabled={busy || !token.trim()}
                className={dlg.primary}
              >
                <KeyRound className="h-4 w-4" />
                {busy ? t("Checking…") : t("Unlock")}
              </Button>
            </div>
          </div>
        )}

        {canSign && (
          <div className={cn("mt-5 border-t pt-4", dlg.divider)}>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
              {t("Issue a key (owner)")}
            </h3>
            <p className="mt-1 text-xs text-zinc-500">
              {t(
                "Generate a personal key for a buyer and send it to them — their name is baked into the key.",
              )}
            </p>
            <div className="mt-2 flex gap-2">
              <input
                value={buyer}
                onChange={(e) => setBuyer(e.target.value)}
                placeholder={t("Buyer name / Patreon handle")}
                className={cn(
                  "h-9 flex-1 px-3 text-sm text-zinc-100 outline-none transition-colors placeholder:text-zinc-500",
                  dlg.field,
                )}
              />
              <Button variant="ghost" onClick={generate} disabled={busy || !buyer.trim()}>
                {t("Generate")}
              </Button>
            </div>
            {/* test keys have their own product name so old builds reject them */}
            <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-zinc-400">
              {(
                [
                  ["forever", t("Permanent")],
                  ["until", t("Runs until")],
                  ["days", t("Runs for")],
                ] as const
              ).map(([key, label]) => (
                <button
                  key={key}
                  onClick={() => setTerm(key)}
                  // picked tile = pick-on, resting = the hover fill
                  className={cn(
                    "border px-2.5 py-1 transition-colors",
                    round,
                    term === key
                      ? "pick-on text-white"
                      : cn("appearance-chip border-transparent text-zinc-400", dlg.menuRow),
                  )}
                >
                  {label}
                </button>
              ))}
              {term === "until" && (
                <input
                  value={until}
                  onChange={(e) => setUntil(e.target.value)}
                  placeholder="2026-09-30"
                  spellCheck={false}
                  className={cn(
                    "h-8 w-32 px-2 font-mono text-xs text-zinc-100 outline-none transition-colors placeholder:text-zinc-600",
                    dlg.field,
                  )}
                />
              )}
              {term === "days" && (
                <span className="flex items-center gap-1.5">
                  <input
                    value={days}
                    onChange={(e) => setDays(e.target.value.replace(/\D/g, ""))}
                    inputMode="numeric"
                    className={cn(
                      "h-8 w-16 px-2 text-center font-mono text-xs text-zinc-100 outline-none transition-colors",
                      dlg.field,
                    )}
                  />
                  {t("days from the day it is pasted")}
                </span>
              )}
            </div>
            {issued && pastDate && (
              <p className="mt-2 text-xs text-amber-300">
                {tf(
                  "{date} is already past — MiColl will refuse this key as expired. Which is the point, if that is what you are testing.",
                  { date: until.trim() },
                )}
              </p>
            )}
            {issued && (
              <div className={cn("mt-2 flex items-start gap-2 p-2", dlg.box)}>
                <code className="min-w-0 flex-1 select-all break-all font-mono text-[11px] leading-snug text-zinc-300">
                  {issued}
                </code>
                <button
                  onClick={copyIssued}
                  className={cn("shrink-0 p-1.5 text-zinc-400 transition-colors", round, dlg.menuRow)}
                  title={t("Copy key")}
                >
                  {copied ? <Check className="h-4 w-4 text-emerald-300" /> : <Copy className="h-4 w-4" />}
                </button>
              </div>
            )}
          </div>
        )}
      </motion.div>
    </div>
  );
}
