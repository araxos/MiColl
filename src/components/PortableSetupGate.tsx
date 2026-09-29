import { useState } from "react";
import { motion } from "framer-motion";
import { FolderInput, HardDrive, Loader2, Sparkles } from "lucide-react";
import { portableAdopt, portableStartFresh, type PortableOffer } from "@/api/library";
import { BrandHeartMark } from "@/components/BrandHeart";
import { SetupCloseButton } from "@/components/SetupCloseButton";
import { useT, useTp } from "@/lib/i18n";

/**
 * Question a portable copy asks on its first start if there's an installed library:
 * use that one or start empty? Using it is the default.
 * The window reloads after, because the answer decides which database is used.
 */
export function PortableSetupGate({ offer, onDone }: { offer: PortableOffer; onDone: () => void }) {
  const t = useT();
  const tp = useTp();
  const [busy, setBusy] = useState<"adopt" | "fresh" | null>(null);
  const [name, setName] = useState("My library");
  const [error, setError] = useState<string | null>(null);

  const run = async (which: "adopt" | "fresh") => {
    setBusy(which);
    setError(null);
    try {
      if (which === "adopt") await portableAdopt();
      else await portableStartFresh(name.trim() || "My library");
      onDone();
    } catch (e) {
      setError(String(e));
      setBusy(null);
    }
  };

  const n = (v: number) => v.toLocaleString();

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
        <div className="min-h-0 flex-1 overflow-y-auto px-8 pb-2 pt-8">
          <div className="text-center">
            <BrandHeartMark className="mx-auto mb-5" size="h-14 w-14" />
            <h1 className="text-[1.6rem] font-semibold tracking-tight text-white">
              {t("Welcome back")}
            </h1>
            <p className="mx-auto mt-2 max-w-[27rem] text-[15px] leading-relaxed text-zinc-300">
              This copy runs portable — it keeps its own library next to the executable.
              There is already one on this computer. Should this copy carry on with it, or
              start its own?
            </p>
          </div>

          <div className="mt-7 space-y-3">
            <div className="setup-card rounded-2xl px-5 py-4">
              <div className="flex items-center gap-2 text-sm font-medium text-zinc-100">
                <FolderInput className="h-4 w-4" style={{ color: "var(--color-brand-400)" }} />
                {t("Take your collection along")}
              </div>
              <p className="mt-1.5 text-xs leading-relaxed text-zinc-400">
                {tp("{n} creators", offer.artists, { n: n(offer.artists) })} ·{" "}
                {tp("{n} rewards", offer.rewards, { n: n(offer.rewards) })}. {t("It is")}{" "}
                <b className="text-zinc-300">{t("copied")}</b>
                {t(
                  ", not moved — the installed version keeps working exactly as it does now, and the two go their own way from here.",
                )}
              </p>
              <p className="mt-1.5 break-all font-mono text-[11px] text-zinc-500">{offer.path}</p>
              <button
                onClick={() => void run("adopt")}
                disabled={busy !== null}
                className="setup-btn setup-btn--primary mt-4"
              >
                {busy === "adopt" && <Loader2 className="h-4 w-4 animate-spin" />}
                {t("Use this library")}
              </button>
            </div>

            <div className="setup-card rounded-2xl px-5 py-4">
              <div className="flex items-center gap-2 text-sm font-medium text-zinc-100">
                <Sparkles className="h-4 w-4" style={{ color: "var(--color-brand-400)" }} />
                {t("Start a second one")}
              </div>
              <p className="mt-1.5 text-xs leading-relaxed text-zinc-400">
                {t(
                  "Empty, and named so you can tell the two apart later. Nothing on this computer is read or changed — you add folders yourself.",
                )}
              </p>
              <div className="mt-4 flex items-center gap-2">
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && void run("fresh")}
                  placeholder={t("Name it")}
                  maxLength={60}
                  className="h-10 w-full flex-1 rounded-xl border border-white/12 bg-black/25 px-3 text-sm text-zinc-100 outline-none transition-colors placeholder:text-zinc-500 focus:border-white/35"
                />
                <button
                  onClick={() => void run("fresh")}
                  disabled={busy !== null}
                  className="setup-btn setup-btn--ghost shrink-0"
                >
                  {busy === "fresh" && <Loader2 className="h-4 w-4 animate-spin" />}
                  {t("Start empty")}
                </button>
              </div>
            </div>
          </div>

          {error && <p className="mt-3 text-xs text-rose-300">{error}</p>}
        </div>

        <div className="flex items-start gap-2 px-8 pb-7 pt-4 text-[11px] leading-relaxed text-zinc-500">
          <HardDrive className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            {t(
              "Asked once. Either way, your media files stay where they are — a library is an index, not a copy of your collection.",
            )}
          </span>
        </div>
      </motion.div>
    </div>
  );
}
