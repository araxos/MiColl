import { useEffect, useState } from "react";
import { Copy, KeyRound, Loader2, Smartphone, Wifi } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { useActions } from "@/actions";
import { useT } from "@/lib/i18n";
import { newPhoneBridgeKey, refreshPhoneBridge, setPhoneBridge, usePhoneBridge } from "@/lib/phoneBridge";
import { toggleOnClass, useAccent } from "@/lib/theme";
import { cn } from "@/lib/utils";

/**
 * Settings section for the MiColl phone app: the bridge switch, the pairing QR and
 * the address to type. The phone only reads (gallery, thumbnails, downloads).
 */
export function PhonePanel({ backed }: { backed: boolean }) {
  const t = useT();
  const { showToast } = useActions();
  const irid = useAccent() === "iridescent";
  const { on, info, error } = usePhoneBridge();
  const [confirmKey, setConfirmKey] = useState(false);
  const [busy, setBusy] = useState(false);

  // the addresses can change (other Wi-Fi), ask again when Settings opens
  useEffect(() => {
    if (backed && on) refreshPhoneBridge();
    // only on open
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backed]);

  const box = irid ? "glass-box border-white/15 bg-white/10 backdrop-blur-md" : "glass-box border-zinc-800 bg-zinc-900/40";
  const chip = irid
    ? "rounded bg-white/15 text-white ring-1 ring-inset ring-white/20"
    : "rounded bg-zinc-800 text-zinc-200";

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      showToast({ tone: "success", title: t("Copied"), detail: text });
    } catch {
      /* ignore */
    }
  };

  const doNewKey = async () => {
    setBusy(true);
    try {
      await newPhoneBridgeKey();
      showToast({ tone: "success", title: t("New pairing key. Scan the new code on your phone.") });
    } catch (e) {
      showToast({ tone: "error", title: t("Couldn't make a new key"), detail: `${e}` });
    } finally {
      setBusy(false);
      setConfirmKey(false);
    }
  };

  return (
    <div>
      <h2 className="flex items-center gap-2 settings-title text-2xl font-bold tracking-tight text-zinc-50">
        <Smartphone className="h-6 w-6 text-brand-300" />
        {t("Phone app")}
      </h2>
      <p className="settings-desc mt-1 text-sm text-zinc-400">
        {t(
          "Lets the MiColl phone app show your collection and download from it, while phone and PC are on the same Wi-Fi. The phone only reads: nothing here is changed or deleted.",
        )}
      </p>

      {!backed ? (
        <div className="mt-4 rounded-xl border border-dashed border-zinc-800 bg-zinc-900/40 p-6 text-center text-sm text-zinc-400">
          {t("The phone app connects to the desktop app.")}
        </div>
      ) : (
        <>
          <div className={cn("mt-4 flex items-start justify-between gap-3 rounded-xl border p-4", box)}>
            <div className="min-w-0">
              <h3 className="text-sm font-semibold text-zinc-100">{t("Share with the phone app")}</h3>
              <p className="settings-desc mt-0.5 text-sm text-zinc-400">
                {t("Turns off by itself while MiColl is locked. Only phones that scanned the code get in.")}
              </p>
            </div>
            <Toggle checked={on} onChange={setPhoneBridge} />
          </div>

          {on && error && (
            <div className="mt-3 rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">
              {error}
            </div>
          )}

          {on && !info && !error && (
            <div className="mt-3 flex h-24 items-center justify-center text-zinc-400">
              <Loader2 className="h-6 w-6 animate-spin text-brand-400" />
            </div>
          )}

          {on && info && (
            <div className={cn("mt-3 flex flex-wrap items-center gap-5 rounded-xl border p-4", box)}>
              {/* on a white card so cameras read it well */}
              <div
                className="shrink-0 rounded-xl bg-white p-2 shadow-lg [&_svg]:block [&_svg]:h-44 [&_svg]:w-44"
                // eslint-disable-next-line react/no-danger
                dangerouslySetInnerHTML={{ __html: info.qrSvg }}
              />
              <div className="min-w-0 flex-1 space-y-3 text-sm">
                <p className="text-zinc-300">
                  {t("In the phone app: tap the PC button, then Scan QR code. Or type the address:")}
                </p>
                <button
                  onClick={() => void copy(info.address)}
                  title={t("Click to copy")}
                  className={cn("flex max-w-full items-center gap-2 px-2 py-1 font-mono text-sm", chip)}
                >
                  <span className="truncate">{info.address}</span>
                  <Copy className="h-3.5 w-3.5 shrink-0 opacity-70" />
                </button>
                {info.others.length > 0 && (
                  <div className="text-xs text-zinc-400">
                    {t("Other addresses of this PC, if that one doesn't work:")}
                    <div className="mt-1 flex flex-wrap gap-1.5">
                      {info.others.map((a) => (
                        <button
                          key={a}
                          onClick={() => void copy(a)}
                          title={t("Click to copy")}
                          className={cn("px-1.5 py-0.5 font-mono", chip)}
                        >
                          {a}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                <p className="truncate text-xs text-zinc-400" title={info.folder}>
                  {t("Shared folder:")} <code className={cn("px-1 py-0.5", chip)}>{info.folder}</code>
                </p>
                <Button variant="outline" size="sm" onClick={() => setConfirmKey(true)} disabled={busy}>
                  <KeyRound className="h-4 w-4" />
                  {t("New pairing key…")}
                </Button>
              </div>
            </div>
          )}

          {on && (
            <div className="mt-3 flex items-start gap-2 text-xs leading-relaxed text-zinc-400">
              <Wifi className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>
                {t(
                  "The first time, Windows may ask to let MiColl through the firewall: allow it for private networks. With a VPN on, allow LAN connections in the VPN app.",
                )}
              </span>
            </div>
          )}
        </>
      )}

      {confirmKey && (
        <ConfirmDialog
          title={t("New pairing key?")}
          confirmLabel={t("New key")}
          busy={busy}
          body={t(
            "Every phone that is paired now loses access and has to scan the new code. Use this if somebody else got the code.",
          )}
          onConfirm={() => void doNewKey()}
          onCancel={() => setConfirmKey(false)}
        />
      )}
    </div>
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
