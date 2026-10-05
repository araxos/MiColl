import { useEffect, useState } from "react";
import { FileArchive, HardDrive, Image as ImageIcon, PlayCircle } from "lucide-react";
import { importStats, type ImportStats } from "@/api/library";
import { fmtBytes } from "@/components/RewardDetails";
import { isTauri } from "@/lib/tauri";
import { useT, useTp } from "@/lib/i18n";

/**
 * The line at the bottom of the import review: how many images, videos and other files
 * the import brings in, and their size. Counted in the backend with the import's own
 * rules (one walk per folder), a folder inside another one only once.
 */
export function ImportStatsLine({ folders }: { folders: string[] }) {
  const t = useT();
  const tp = useTp();
  const [stats, setStats] = useState<ImportStats | null>(null);
  // the folder list is rebuilt every render, count again only when it really changes
  const key = folders.join("\n");
  useEffect(() => {
    setStats(null);
    if (!isTauri() || folders.length === 0) return;
    let alive = true;
    importStats(folders)
      .then((s) => alive && setStats(s))
      .catch(() => {});
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  if (!isTauri() || folders.length === 0) return null;
  const sep = <span className="opacity-40">·</span>;
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs tabular-nums text-zinc-500">
      {stats == null ? (
        <span>{t("Counting files…")}</span>
      ) : (
        <>
          <span className="inline-flex items-center gap-1">
            <ImageIcon className="h-3.5 w-3.5" />
            {tp("{n} images", stats.images)}
          </span>
          {stats.videos > 0 && (
            <>
              {sep}
              <span className="inline-flex items-center gap-1">
                <PlayCircle className="h-3.5 w-3.5" />
                {tp("{n} videos", stats.videos)}
              </span>
            </>
          )}
          {stats.other > 0 && (
            <>
              {sep}
              <span className="inline-flex items-center gap-1">
                <FileArchive className="h-3.5 w-3.5" />
                {tp("{n} other files", stats.other)}
              </span>
            </>
          )}
          {sep}
          <span className="inline-flex items-center gap-1">
            <HardDrive className="h-3.5 w-3.5" />
            {fmtBytes(stats.bytes)}
          </span>
        </>
      )}
    </div>
  );
}
