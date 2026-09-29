import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { Lock, ArrowRight, ShieldOff, KeyRound } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { AppWallpaper } from "@/components/AppWallpaper";
import { WindowControls } from "@/components/WindowControls";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n";
import { isTauri } from "@/lib/tauri";
import { useAccent, type AccentKey } from "@/lib/theme";
import { hasPassword, unlock, unlockRecovery, encryptionState, getSetting, readImage } from "@/api/library";

/**
 * Lock screen card style per theme. The background is always the real app
 * wallpaper (AppWallpaper), here we only style the card, icon and Unlock button.
 */
interface LockTheme {
  card: string;
  iconWrap: string;
  icon: string;
  title: string;
  /** Extra classes for the main buttons (! to override the brand fill). */
  btn?: string;
}

function lockTheme(accent: AccentKey): LockTheme {
  if (accent === "iridescent") {
    return {
      // neutral dark glass (the violet looked purple)
      card:
        "relative w-80 overflow-hidden rounded-2xl border border-white/15 bg-zinc-900/55 p-7 shadow-2xl shadow-black/50 ring-1 ring-white/10 backdrop-blur-2xl",
      iconWrap:
        "mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-[#c4b5fd] via-[#f5c2ff] to-[#a7f3d0] shadow-lg shadow-fuchsia-900/30",
      icon: "h-6 w-6 text-[#3a2a60] drop-shadow",
      title: "text-center text-lg font-semibold text-white",
      btn: "!bg-gradient-to-r !from-[#c4b5fd] !via-[#f5c2ff] !to-[#a7f3d0] !text-[#2e2150] hover:!opacity-90",
    };
  }
  if (accent === "sakura") {
    return {
      card:
        "relative w-80 overflow-hidden rounded-2xl border border-[#f9a8d4]/35 bg-[#2a1521]/65 p-7 shadow-2xl shadow-[#f472b6]/15 ring-1 ring-white/10 backdrop-blur-2xl",
      iconWrap:
        "mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-[#f472b6] to-[#ffd0e3] shadow-lg shadow-[#f472b6]/40",
      icon: "h-6 w-6 text-white drop-shadow",
      title: "text-center text-lg font-semibold text-zinc-50",
    };
  }
  if (accent === "cyberpunk") {
    return {
      card:
        "relative w-80 overflow-hidden rounded-lg border border-[#fcee0a]/40 bg-zinc-950/75 p-7 shadow-[0_0_34px_-6px_rgba(252,238,10,0.45)] ring-1 ring-[#00e5ff]/15 backdrop-blur-xl",
      iconWrap:
        "mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-lg bg-[#fcee0a] shadow-[0_0_18px_-2px_rgba(252,238,10,0.85)]",
      icon: "h-6 w-6 text-zinc-950",
      title:
        "text-center font-mono text-lg font-bold tracking-tight text-[#fcee0a] [text-shadow:0_0_12px_rgba(252,238,10,0.5)]",
      btn: "!bg-[#fcee0a] !text-zinc-950 hover:!bg-[#fff42a]",
    };
  }
  // basic accents: brand tinted (brand-* already follows the accent)
  return {
    card:
      "relative w-80 overflow-hidden rounded-2xl border border-brand-400/25 bg-brand-500/10 p-7 shadow-2xl shadow-brand-950/40 ring-1 ring-white/10 backdrop-blur-2xl",
    iconWrap:
      "mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-brand-500 to-accent2-600 shadow-lg shadow-brand-900/40",
    icon: "h-6 w-6 text-white",
    title: "text-center text-lg font-semibold text-zinc-100",
  };
}

/**
 * App lock. If a password is set you have to enter it. "Continue without a password"
 * only shows when there is none. The backend checks it against a salted hash.
 */
export function LockScreen({ onUnlock }: { onUnlock: (decoy: boolean) => void }) {
  const [pwSet, setPwSet] = useState<boolean | null>(null); // null = still loading
  const [pin, setPin] = useState("");
  const [error, setError] = useState(false);
  const [checking, setChecking] = useState(false);
  const [bg, setBg] = useState<string>("");
  const [encEnabled, setEncEnabled] = useState(false);
  const [recoveryMode, setRecoveryMode] = useState(false);
  const accent = useAccent();
  const t = useT();
  const lt = lockTheme(accent);

  useEffect(() => {
    let alive = true;
    if (!isTauri()) {
      setPwSet(false); // browser prototype: no backend, no password
      return;
    }
    hasPassword()
      .then((v) => alive && setPwSet(v))
      .catch(() => alive && setPwSet(false));
    encryptionState()
      .then((s) => alive && setEncEnabled(s.enabled))
      .catch(() => {});
    // optional custom lock screen image (from the viewer's "Set as cover")
    getSetting("lock_bg")
      .then((p) => {
        if (alive && p) return readImage(p).then((d) => alive && setBg(d));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  // block right-click while locked (the app menu in actions.tsx would open otherwise).
  // Capture on document so it runs first.
  useEffect(() => {
    const swallow = (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
    };
    document.addEventListener("contextmenu", swallow, true);
    return () => document.removeEventListener("contextmenu", swallow, true);
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (checking) return;
    setChecking(true);
    try {
      // the decoy password looks like a normal unlock
      const res = !isTauri()
        ? { ok: true, decoy: false }
        : recoveryMode
          ? { ok: await unlockRecovery(pin), decoy: false }
          : await unlock(pin);
      if (res.ok) onUnlock(res.decoy);
      else {
        setError(true);
        setPin("");
      }
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center overflow-hidden bg-zinc-950">
      {/* custom lock image if set, otherwise the themed wallpaper (opaque, hides the
          library) */}
      {/* minimize/close in the same spot as in the header.
          No right-click menus on this screen. */}
      {isTauri() && (
        <div className="absolute right-4 top-0 z-20 flex h-14 items-center gap-2">
          <WindowControls menus={false} />
        </div>
      )}

      {bg ? (
        <>
          <div
            className="pointer-events-none absolute inset-0 bg-cover bg-center"
            style={{ backgroundImage: `url(${bg})` }}
          />
          <div className="pointer-events-none absolute inset-0 bg-zinc-950/60 backdrop-blur-sm" />
        </>
      ) : (
        <AppWallpaper />
      )}

      <motion.div
        initial={{ opacity: 0, y: 12, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.35, ease: "easeOut" }}
        className={cn("z-10", lt.card)}
      >
        <div className={lt.iconWrap}>
          <Lock className={lt.icon} />
        </div>
        <h1 className={lt.title}>{t("MiColl is locked")}</h1>

        {pwSet === null ? (
          <p className="mt-1 text-center text-sm text-zinc-500">…</p>
        ) : pwSet ? (
          <>
            <p className="mt-1 text-center text-sm text-zinc-400">
              {recoveryMode ? t("Enter your recovery key") : t("Enter your password to continue")}
            </p>
            <form onSubmit={submit} className="mt-6 space-y-3">
              <input
                autoFocus
                type={recoveryMode ? "text" : "password"}
                value={pin}
                onChange={(e) => {
                  setPin(e.target.value);
                  setError(false);
                }}
                placeholder={recoveryMode ? "XXXX-XXXX-…" : t("Password")}
                className={`h-11 w-full rounded-xl border bg-white/5 px-3 text-center text-zinc-100 placeholder:text-zinc-400 outline-none backdrop-blur-sm transition-colors ${
                  error
                    ? "border-rose-500/70 focus:ring-2 focus:ring-rose-500/30"
                    : "border-white/15 focus:border-brand-400/70 focus:bg-white/10 focus:ring-2 focus:ring-brand-500/25"
                }`}
              />
              {error && (
                <p className="text-center text-xs text-rose-400">
                  {recoveryMode
                    ? t("Wrong recovery key — try again.")
                    : t("Wrong password — try again.")}
                </p>
              )}
              <Button
                type="submit"
                variant="primary"
                className={cn("w-full", lt.btn)}
                disabled={checking || !pin}
              >
                {t("Unlock")}
                <ArrowRight className="h-4 w-4" />
              </Button>
            </form>
            {encEnabled && (
              <button
                onClick={() => {
                  setRecoveryMode((m) => !m);
                  setPin("");
                  setError(false);
                }}
                className="mx-auto mt-3 flex items-center gap-1.5 text-xs text-zinc-400 hover:text-zinc-200"
              >
                <KeyRound className="h-3.5 w-3.5" />
                {recoveryMode ? t("Use password instead") : t("Use recovery key")}
              </button>
            )}
          </>
        ) : (
          <>
            <p className="mt-1 text-center text-sm text-zinc-400">
              {t("No password is set. You can set one in Settings → Security.")}
            </p>
            <Button onClick={() => onUnlock(false)} variant="primary" className={cn("mt-6 w-full", lt.btn)}>
              <ShieldOff className="h-4 w-4" />
              {t("Continue without a password")}
            </Button>
          </>
        )}
      </motion.div>
    </div>
  );
}
