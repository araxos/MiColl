import { useEffect } from "react";
import { createPortal } from "react-dom";
import { motion } from "framer-motion";
import { Download, ExternalLink, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { useDialogTheme } from "@/lib/dialogTheme";
import { useAccent } from "@/lib/theme";
import { cn } from "@/lib/utils";
import { useT, useTf } from "@/lib/i18n";
import { openUrl, type AiModel, type AiModelStatus } from "@/api/library";

/**
 * Description of each model. The URL comes from the backend (ai_model_status).
 * licenceUrl: the licence text, shown as a link; agree: the licence has use restrictions
 * that have to be passed on to whoever uses the model (CreativeML OpenRAIL-M).
 */
const ABOUT: Record<
  AiModel,
  { name: string; does: string; size: string; licence: string; licenceUrl?: string; agree?: boolean }
> = {
  lama: {
    name: "LaMa",
    does: "Fills what you paint over so it blends into its surroundings — the AI mode of the Erase tool.",
    size: "~200 MB",
    licence: "Apache-2.0",
  },
  isnet: {
    name: "IS-Net",
    does: "Separates the subject from its background — used by the Cutout tool.",
    size: "~178 MB",
    licence: "Apache-2.0",
  },
  esrgan: {
    name: "Real-ESRGAN",
    does: "Enlarges images and adds back detail — the AI mode of the Resize tool.",
    size: "~5 MB",
    licence: "BSD-3-Clause",
  },
  sd15: {
    name: "Stable Diffusion 1.5",
    does: "Redraws the new border of the Expand tool with real detail (AI fill HQ). Runs on the graphics card — without one it takes minutes.",
    size: "~1.9 GB",
    licence: "CreativeML OpenRAIL-M",
    licenceUrl:
      "https://github.com/araxos/MiColl/releases/download/models-sd15-inpaint-v1/LICENSE.txt",
    agree: true,
  },
};

/** "huggingface.co · Carve/LaMa-ONNX" from a model URL (host + owner/repo). */
function sourceOf(url: string): string {
  try {
    const u = new URL(url);
    const [owner, repo] = u.pathname.split("/").filter(Boolean);
    return owner && repo ? `${u.host} · ${owner}/${repo}` : u.host;
  } catch {
    return url;
  }
}

/**
 * Asked before an AI model is downloaded: what it is, size, source, folder, licence.
 * So the first click isn't a surprise 200 MB download.
 */
export function ModelDownloadDialog({
  model,
  info,
  onConfirm,
  onCancel,
}: {
  model: AiModel;
  /** Status from the backend (URL + target folder). */
  info: AiModelStatus | undefined;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const t = useT();
  const tf = useTf();
  const dlg = useDialogTheme();
  const square = useAccent() === "cyberpunk";
  const about = ABOUT[model];

  // Escape closes this and not the editor below (capture)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      onCancel();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onCancel]);

  const row = (label: string, value: React.ReactNode) => (
    <div className={cn("grid grid-cols-[6.5rem_1fr] gap-3 border-t py-2 first:border-t-0", dlg.divider)}>
      <dt className="text-zinc-500">{label}</dt>
      <dd className="min-w-0 text-zinc-200">{value}</dd>
    </div>
  );

  return createPortal(
    <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
      <motion.div
        initial={{ opacity: 0, y: 12, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        className={cn("w-[32rem] max-w-full p-5", dlg.panel)}
      >
        <div className="flex items-start gap-3">
          <div
            className={cn(
              "flex h-9 w-9 shrink-0 items-center justify-center",
              dlg.box,
              dlg.accentText,
            )}
          >
            <Download className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-zinc-100">
              {tf("Download the {name} model?", { name: about.name })}
            </h2>
            <p className="mt-1 text-sm text-zinc-400">{t(about.does)}</p>
          </div>
        </div>

        <dl className={cn("mt-4 px-3 text-sm", dlg.box)}>
          {row(t("Size"), tf("{size}, downloaded once", { size: about.size }))}
          {row(
            t("Source"),
            info?.url ? (
              <>
                <div>{sourceOf(info.url)}</div>
                <div className="mt-0.5 select-text break-all font-mono text-[11px] text-zinc-500">
                  {info.url}
                </div>
              </>
            ) : (
              "—"
            ),
          )}
          {row(
            t("Saved to"),
            info?.folder ? (
              <span className="select-text break-all font-mono text-[11px] text-zinc-400">
                {info.folder}
              </span>
            ) : (
              "—"
            ),
          )}
          {row(
            t("Licence"),
            about.licenceUrl ? (
              <button
                type="button"
                onClick={() => void openUrl(about.licenceUrl!)}
                className={cn("inline-flex items-center gap-1 underline-offset-2 hover:underline", dlg.accentText)}
              >
                {about.licence}
                <ExternalLink className="h-3 w-3" />
              </button>
            ) : (
              about.licence
            ),
          )}
        </dl>

        {about.agree && (
          <p className="mt-3 text-xs text-zinc-400">
            {t(
              "By downloading you agree to this licence, including its use restrictions (Attachment A).",
            )}
          </p>
        )}

        <p
          className={cn(
            "mt-3 flex items-start gap-2 border px-3 py-2 text-xs text-zinc-400",
            square ? "rounded-none" : "rounded-lg",
            dlg.soft,
          )}
        >
          <ShieldCheck className={cn("mt-px h-4 w-4 shrink-0", dlg.accentText)} />
          {t(
            "The model runs on this PC. Your images are never uploaded — this download is the only connection it makes.",
          )}
        </p>

        <div className={cn("mt-5 flex justify-end gap-2 border-t pt-4", dlg.divider)}>
          <Button variant="ghost" onClick={onCancel}>
            {t("Cancel")}
          </Button>
          <Button variant="primary" onClick={onConfirm}>
            <Download className="h-4 w-4" />
            {t("Download")}
          </Button>
        </div>
      </motion.div>
    </div>,
    document.body,
  );
}
