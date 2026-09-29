import { X } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isTauri } from "@/lib/tauri";
import { useT } from "@/lib/i18n";

/**
 * Close button for the setup screens (they cover the title bar).
 * Nothing is saved until a step is done, so the next start asks again.
 */
export function SetupCloseButton() {
  const t = useT();
  if (!isTauri()) return null;
  return (
    <button
      onClick={() => void getCurrentWindow().close()}
      title={t("Close MiColl")}
      aria-label={t("Close MiColl")}
      className="absolute right-3 top-3 z-10 flex h-8 w-8 items-center justify-center rounded-full border border-white/10 bg-white/5 text-zinc-400 backdrop-blur-sm transition-colors hover:border-white/20 hover:bg-white/12 hover:text-white"
    >
      <X className="h-4 w-4" />
    </button>
  );
}
