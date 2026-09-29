import { useEffect, useRef } from "react";
import { useActions } from "@/actions";
import { useData } from "@/store";
import { useT, useTf } from "@/lib/i18n";
import { isTauri } from "@/lib/tauri";
import { migrateCoverCrops } from "@/api/library";

/**
 * One-time move of old cover crops out of the reward folders.
 * Old builds saved "Crop & set" results as _cover_<ts>.png inside the reward folder,
 * now they live in the app's covers folder (see migrate_cover_crops in lib.rs).
 * Waits for active (after unlock, never in safe mode) because encrypted crops need the key.
 */
export function CoverCropMigration({ active }: { active: boolean }) {
  const t = useT();
  const tf = useTf();
  const { showToast } = useActions();
  const { refresh } = useData();
  const ran = useRef(false);

  useEffect(() => {
    if (!active || ran.current || !isTauri()) return;
    ran.current = true;
    void migrateCoverCrops()
      .then(async (m) => {
        const n = m.moved + m.binned;
        if (n === 0 && m.errors.length === 0) return;
        if (m.moved > 0) await refresh();
        showToast({
          tone: m.errors.length ? "warn" : "success",
          title: tf("{n} cover crops moved out of your reward folders", { n }),
          detail: t("The old files are in the recycle bin."),
          problem: m.errors.length ? m.errors.slice(0, 2).join(" · ") : undefined,
        });
      })
      .catch(() => {
        /* just try again next start */
      });
  }, [active, refresh, showToast, t, tf]);

  return null;
}
