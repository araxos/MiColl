import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { motion } from "framer-motion";
import {
  X,
  Smartphone,
  ClipboardCopy,
  Image as ImageIcon,
  CloudUpload,
  Save,
  Share2,
  Loader2,
} from "lucide-react";
import { useDialogTheme } from "@/lib/dialogTheme";
import { useActions } from "@/actions";
import { cn } from "@/lib/utils";
import { useT, useTf, useTp } from "@/lib/i18n";
import { copyFilesToClipboard, copyImageToClipboard, windowsShare } from "@/api/library";

/**
 * What's shared. Always just a list of files (one photo, a selection or reward folders).
 */
export interface ShareRequest {
  /** Paths of the files. */
  srcs: string[];
  /** Name for the bundle (zip name, MEGA folder, copy folder). */
  name: string;
  /** Creator name if known (MEGA adds it to the folder). */
  creator?: string;
  /** The image if it's exactly one picture (enables "Copy picture"). */
  image?: string | null;
}

interface Target {
  key: string;
  label: string;
  hint: string;
  Icon: typeof Share2;
  /** Resolves when done, the sheet closes unless it threw. */
  run: () => void | Promise<void>;
}

/**
 * Share sheet with a row of destination tiles (like Windows 11).
 * The Windows share sheet is one of the tiles. "Copy files" works for Discord,
 * Telegram, Explorer etc. Phone / MEGA / Save a copy open their own dialogs.
 */
export function ShareSheet({
  req,
  onPhone,
  onMega,
  onSaveCopy,
  onClose,
}: {
  req: ShareRequest;
  onPhone: () => void;
  onMega: () => void;
  onSaveCopy: () => void;
  onClose: () => void;
}) {
  const t = useT();
  const tf = useTf();
  const tp = useTp();
  const { panel } = useDialogTheme();
  const { showToast } = useActions();
  const [busy, setBusy] = useState<string | null>(null);
  const n = req.srcs.length;
  const files = tp("{n} files", n);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const copyFiles = async () => {
    const count = await copyFilesToClipboard(req.srcs);
    showToast({
      tone: "success",
      title: tf("Copied {n}", { n: tp("{n} files", count) }),
      detail: t("Paste with Ctrl+V — Explorer, Discord, an upload field…"),
    });
  };

  const copyPicture = async () => {
    await copyImageToClipboard(req.image!);
    showToast({
      tone: "success",
      title: t("Picture copied"),
      detail: t("Paste it straight into a chat or a document."),
    });
  };

  const openWindowsSheet = async () => {
    await windowsShare(req.srcs, req.name);
  };

  const targets: Target[] = [
    {
      key: "phone",
      label: t("Send to phone"),
      hint: t("QR over Wi-Fi"),
      Icon: Smartphone,
      run: onPhone,
    },
    {
      key: "files",
      label: t("Copy files"),
      hint: tf("Paste {files} anywhere", { files }),
      Icon: ClipboardCopy,
      run: copyFiles,
    },
    // only for a single picture
    ...(req.image
      ? [
          {
            key: "picture",
            label: t("Copy picture"),
            hint: t("Paste as an image"),
            Icon: ImageIcon,
            run: copyPicture,
          } satisfies Target,
        ]
      : []),
    {
      key: "mega",
      label: t("Upload to MEGA"),
      hint: t("Share a link"),
      Icon: CloudUpload,
      run: onMega,
    },
    {
      key: "save",
      label: t("Save a copy"),
      hint: t("Into a folder"),
      Icon: Save,
      run: onSaveCopy,
    },
    {
      key: "windows",
      label: t("Windows share"),
      hint: t("Nearby, Mail, Phone Link"),
      Icon: Share2,
      run: openWindowsSheet,
    },
  ];

  const pick = async (tg: Target) => {
    if (busy) return;
    setBusy(tg.key);
    try {
      await tg.run();
      onClose();
    } catch (e) {
      // stay open on failure so another destination can be picked
      showToast({
        tone: "error",
        title: tf("Couldn’t: {what}", { what: tg.label }),
        detail: `${e}`,
      });
      setBusy(null);
    }
  };

  return createPortal(
    <div
      onClick={onClose}
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
    >
      <motion.div
        initial={{ opacity: 0, y: 12, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        onClick={(e) => e.stopPropagation()}
        className={cn("w-[27rem] max-w-[94vw] p-5", panel)}
      >
        <div className="mb-1 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-zinc-100">{t("Share")}</h2>
            <p className="truncate text-xs text-zinc-400" title={req.name}>
              {req.name} · {files}
            </p>
          </div>
          <button
            onClick={onClose}
            title={t("Close (Esc)")}
            className="shrink-0 text-zinc-500 transition-colors hover:text-zinc-300"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="mt-4 grid grid-cols-3 gap-2">
          {targets.map((tg) => (
            <button
              key={tg.key}
              type="button"
              disabled={!!busy}
              onClick={() => void pick(tg)}
              title={tg.hint}
              className={cn(
                "group flex flex-col items-center gap-2 rounded-xl border border-white/10 bg-white/[0.05] px-2 py-3 text-center transition-colors",
                "hover:border-white/25 hover:bg-white/[0.12] disabled:opacity-50",
                busy === tg.key && "border-white/30 bg-white/[0.14]",
              )}
            >
              <span className="grid h-10 w-10 place-items-center rounded-full bg-white/[0.07] ring-1 ring-inset ring-white/10 transition-transform group-hover:scale-105">
                {busy === tg.key ? (
                  <Loader2 className="h-5 w-5 animate-spin text-zinc-200" />
                ) : (
                  <tg.Icon className="h-5 w-5 text-zinc-100" />
                )}
              </span>
              <span className="text-[11px] font-medium leading-tight text-zinc-200">{tg.label}</span>
            </button>
          ))}
        </div>

        <p className="mt-4 text-[11px] leading-relaxed text-zinc-500">
          {t(
            "The Windows sheet only lists apps that registered with Windows as share targets. For Discord, Telegram or an upload field, use",
          )}{" "}
          <b className="text-zinc-400">{t("Copy files")}</b>
          {t(" and paste.")}
        </p>
      </motion.div>
    </div>,
    document.body,
  );
}
