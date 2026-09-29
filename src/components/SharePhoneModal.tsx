import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { motion } from "framer-motion";
import { X, Smartphone, Loader2, Wifi } from "lucide-react";
import { shareToPhone, shareFolderToPhone, stopSharing, type ShareInfo } from "@/api/library";
import { useT, useTp } from "@/lib/i18n";

/**
 * Shows a QR code the phone scans to download from this PC over the local network.
 * One image (path) or a whole reward as zip (srcs + name). The link stops on close.
 */
export function SharePhoneModal({
  path,
  srcs,
  name,
  onClose,
}: {
  path?: string;
  srcs?: string[];
  name?: string;
  onClose: () => void;
}) {
  const isFolder = !!srcs && srcs.length > 0;
  const t = useT();
  const tp = useTp();
  const [info, setInfo] = useState<ShareInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const op = isFolder
      ? shareFolderToPhone(srcs!, name ?? "reward")
      : shareToPhone(path ?? "");
    op.then((i) => alive && setInfo(i)).catch((e) => alive && setError(`${e}`));
    // stop the link (and delete the temp zip) on unmount
    return () => {
      alive = false;
      void stopSharing().catch(() => {});
    };
  }, [path, srcs, name, isFolder]);

  const minutes = info ? Math.round(info.expiresSecs / 60) : 10;

  // portaled, same stacking context problem as the MEGA modal
  return createPortal(
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      onClick={onClose}
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/70 backdrop-blur-sm"
    >
      <motion.div
        initial={{ scale: 0.96, opacity: 0, y: 8 }}
        animate={{ scale: 1, opacity: 1, y: 0 }}
        exit={{ scale: 0.96, opacity: 0, y: 8 }}
        onClick={(e) => e.stopPropagation()}
        className="w-[24rem] max-w-[92vw] overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-900 shadow-2xl"
      >
        <div className="flex items-center justify-between border-b border-zinc-800 px-5 py-3">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-zinc-100">
            <Smartphone className="h-4 w-4 text-brand-300" />
            {t("Send to phone")}
          </h2>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-300" title={t("Done (Esc)")}>
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex flex-col items-center px-5 py-5">
          {error ? (
            <div className="py-8 text-center text-sm text-rose-300">{error}</div>
          ) : !info ? (
            <div className="flex h-56 items-center justify-center text-zinc-400">
              <Loader2 className="h-7 w-7 animate-spin text-brand-400" />
            </div>
          ) : (
            <>
              {/* QR on a white card so cameras read it well */}
              <div
                className="rounded-xl bg-white p-3 shadow-lg [&_svg]:block [&_svg]:h-52 [&_svg]:w-52"
                // eslint-disable-next-line react/no-danger
                dangerouslySetInnerHTML={{ __html: info.qrSvg }}
              />
              <p className="mt-4 text-center text-sm text-zinc-300">
                {isFolder
                  ? t("Scan with your phone’s camera to download the files (.zip).")
                  : t("Scan with your phone’s camera to open the image.")}
              </p>
              <a
                href={info.url}
                className="mt-1 max-w-full select-text truncate text-xs text-brand-300/80"
                title={info.url}
                onClick={(e) => e.preventDefault()}
              >
                {info.url}
              </a>
              <div className="mt-4 flex items-start gap-2 rounded-lg border border-zinc-800 bg-zinc-950/50 p-2.5 text-[11px] leading-relaxed text-zinc-400">
                <Wifi className="mt-0.5 h-3.5 w-3.5 shrink-0 text-zinc-500" />
                <span>
                  {t("Phone and PC must be on the")}{" "}
                  <b className="text-zinc-300">{t("same Wi-Fi")}</b>. {t("The link works for")}{" "}
                  <b className="text-zinc-300">{tp("{n} minutes", minutes)}</b>
                  {t(
                    ", then expires. The first time, Windows may ask you to allow MiColl through the firewall — click Allow.",
                  )}
                </span>
              </div>
            </>
          )}

          <button
            onClick={onClose}
            className="mt-5 w-full rounded-lg border border-zinc-700 bg-zinc-800 py-2 text-sm font-medium text-zinc-100 transition-colors micoll-hover"
          >
            {t("Done")}
          </button>
        </div>
      </motion.div>
    </motion.div>,
    document.body,
  );
}
