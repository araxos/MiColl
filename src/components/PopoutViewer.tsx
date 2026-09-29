import { useMemo } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ImageViewer } from "@/components/ImageViewer";
import { takePopoutPayload } from "@/lib/popout";
import { useT } from "@/lib/i18n";

/**
 * Viewer in a pop-out window (?popout=<id>). Reads the media list from localStorage
 * and shows the ImageViewer for it.
 */
export function PopoutViewer({ id }: { id: string }) {
  const t = useT();
  // read once on mount
  const payload = useMemo(() => takePopoutPayload(id), [id]);
  const close = () => void getCurrentWindow().close();

  if (!payload || payload.items.length === 0) {
    return (
      <div className="grid h-screen place-items-center bg-zinc-950 p-6 text-center text-sm text-zinc-400">
        {t("Nothing to show here. Close this window and try “Open in new window” again.")}
      </div>
    );
  }

  return (
    <ImageViewer
      items={payload.items}
      startIndex={payload.index}
      coverTargets={payload.coverTargets}
      onClose={close}
    />
  );
}
