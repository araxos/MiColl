import { Download, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { showUpdatePrompt, useUpdater } from "@/lib/updater";
import { useT, useTf } from "@/lib/i18n";

/**
 * Top bar button that only shows up when a new version is ready (the auto check
 * found one). Opens the update prompt, which downloads, checks the signature,
 * installs and restarts. Can't be hidden on purpose.
 * data-lit gives it the lit look of each theme (see header [data-lit] in index.css).
 */
export function UpdateButton() {
  const t = useT();
  const tf = useTf();
  const { state } = useUpdater();
  if (state.kind !== "available" && state.kind !== "downloading" && state.kind !== "installing")
    return null;

  const busy = state.kind !== "available";
  const title = busy
    ? t("Updating…")
    : tf("MiColl {version} is ready — click to update", { version: state.version });
  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={showUpdatePrompt}
      title={title}
      aria-label={title}
      data-lit
      className="relative bg-brand-500/20 text-brand-200 hover:bg-brand-500/30 hover:text-brand-100"
    >
      {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
      {/* small dot so it catches the eye */}
      {!busy && (
        <span className="pointer-events-none absolute right-1 top-1 h-2 w-2 rounded-full bg-brand-400 shadow-[0_0_6px] shadow-brand-400" />
      )}
    </Button>
  );
}
