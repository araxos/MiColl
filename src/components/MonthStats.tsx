import { useEffect, useMemo, useState } from "react";
import { FileArchive, HardDrive, Image as ImageIcon, PlayCircle } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { fmtBytes } from "@/components/RewardDetails";
import { mediaStats } from "@/api/library";
import { isTauri } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import { useTf, useTp } from "@/lib/i18n";
import type { Month } from "@/types";

/**
 * What's in a month, next to "n owned": images, videos, other files and the size.
 * Only the month's own rewards (a borrowed collab counts toward its creator, a missing
 * one has no files). The size is one stat per file in the backend, measured when the
 * page opens (milliseconds on an SSD); rewards moved to an unplugged MiSD disk can't
 * be measured and are said so.
 */
export function MonthStats({ month, className }: { month: Month; className?: string }) {
  const tf = useTf();
  const tp = useTp();
  const own = month.rewards.filter((r) => r.status === "owned" && !r.collabFrom);
  const offline = own.filter((r) => r.sdVolume).length;
  const files = own.filter((r) => !r.sdVolume).flatMap((r) => r.images);
  const images = files.filter((f) => (f.kind ?? "image") === "image").length;
  const videos = files.filter((f) => f.kind === "video").length;
  const other = files.length - images - videos;

  const paths = useMemo(
    () => files.map((f) => f.path).filter((p): p is string => !!p),
    // the list is rebuilt every render; measure again only when it really changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [files.length, files[0]?.path, files[files.length - 1]?.path],
  );
  const [bytes, setBytes] = useState<number | null>(null);
  useEffect(() => {
    setBytes(null);
    if (!isTauri() || paths.length === 0) return;
    let alive = true;
    mediaStats(paths)
      .then((s) => alive && setBytes(s.reduce((n, f) => n + f.size, 0)))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [paths]);

  if (files.length === 0 && offline === 0) return null;
  const sep = <span className="opacity-40">·</span>;
  return (
    <Badge tone="neutral" className={cn("gap-1.5 tabular-nums", className)}>
      {images > 0 && (
        <span className="inline-flex items-center gap-1">
          <ImageIcon className="h-3 w-3" />
          {tp("{n} images", images)}
        </span>
      )}
      {videos > 0 && (
        <>
          {images > 0 && sep}
          <span className="inline-flex items-center gap-1">
            <PlayCircle className="h-3 w-3" />
            {tp("{n} videos", videos)}
          </span>
        </>
      )}
      {other > 0 && (
        <>
          {images + videos > 0 && sep}
          <span className="inline-flex items-center gap-1">
            <FileArchive className="h-3 w-3" />
            {tp("{n} other files", other)}
          </span>
        </>
      )}
      {files.length > 0 && (
        <>
          {sep}
          <span>{bytes == null ? "…" : fmtBytes(bytes)}</span>
        </>
      )}
      {offline > 0 && (
        <>
          {files.length > 0 && sep}
          <span className="inline-flex items-center gap-1">
            <HardDrive className="h-3 w-3" />
            {tf("{n} on MiSD, not counted", { n: offline })}
          </span>
        </>
      )}
    </Badge>
  );
}
