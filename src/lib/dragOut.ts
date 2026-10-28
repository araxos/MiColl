import { useCallback, useEffect, useRef } from "react";
import { dragOut } from "@/api/library";
import { useActions } from "@/actions";
import { useT } from "@/lib/i18n";
import { isTauri } from "@/lib/tauri";

/**
 * Drag files or folders out of MiColl (desktop, Explorer, a chat) as a copy. Returns
 * arm(e, paths): call it on left button down, the drag starts once the mouse moves a
 * few pixels with the button still held, so a plain click stays a click.
 */
export function useDragOut(): (e: React.MouseEvent, paths: string[]) => void {
  const t = useT();
  const { showToast } = useActions();
  const armed = useRef<{ x: number; y: number; paths: string[] } | null>(null);
  useEffect(() => {
    const move = (e: MouseEvent) => {
      const d = armed.current;
      if (!d) return;
      if (!(e.buttons & 1)) {
        armed.current = null;
        return;
      }
      if (Math.hypot(e.clientX - d.x, e.clientY - d.y) < 8) return;
      armed.current = null;
      dragOut(d.paths).catch((err) =>
        showToast({ tone: "error", title: t("Couldn’t drag the file out"), problem: String(err) }),
      );
    };
    const up = () => {
      armed.current = null;
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return useCallback((e: React.MouseEvent, paths: string[]) => {
    if (e.button !== 0 || !isTauri() || !paths.length) return;
    armed.current = { x: e.clientX, y: e.clientY, paths };
  }, []);
}
