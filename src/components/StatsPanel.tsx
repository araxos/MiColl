import { useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import { X, Users, Image as ImageIcon, Package, HardDrive, Layers } from "lucide-react";
import { useData } from "@/store";
import { useAccent } from "@/lib/theme";
import { useDialogTheme } from "@/lib/dialogTheme";
import { cn } from "@/lib/utils";
import { useT, useTp } from "@/lib/i18n";
import { librarySize, storageBreakdown, type ArtistStorage } from "@/api/library";
import { artistTags } from "@/lib/artistTags";
import { type Artist, ownRewards } from "@/types";

interface PlatformStat {
  name: string;
  artists: number;
  rewards: number;
  images: number;
}

function computeStats(artists: Artist[]) {
  let rewards = 0;
  let ownedRewards = 0;
  let images = 0;
  const platformMap = new Map<string, { artists: Set<string>; rewards: number; images: number }>();
  const tagCounts = new Map<string, number>();

  for (const a of artists) {
    if (a.tag) tagCounts.set(a.tag, (tagCounts.get(a.tag) ?? 0) + 1);
    for (const p of a.platforms) {
      const entry = platformMap.get(p.name) ?? { artists: new Set(), rewards: 0, images: 0 };
      let hasReward = false;
      for (const m of p.months) {
        // don't count borrowed collab rewards (they exist once but show twice)
        for (const r of ownRewards(m)) {
          rewards++;
          entry.rewards++;
          if (r.status === "owned") ownedRewards++;
          entry.images += r.imageCount;
          images += r.imageCount;
          hasReward = true;
        }
      }
      if (hasReward) entry.artists.add(a.id);
      platformMap.set(p.name, entry);
    }
  }

  const platforms: PlatformStat[] = [...platformMap.entries()]
    .map(([name, e]) => ({ name, artists: e.artists.size, rewards: e.rewards, images: e.images }))
    .filter((p) => p.rewards > 0)
    .sort((a, b) => b.rewards - a.rewards);

  return { artists: artists.length, rewards, ownedRewards, images, platforms, tagCounts };
}

function formatBytes(n: number): string {
  if (n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/** Dialog with stats for the whole collection. */
export function StatsPanel({ onClose }: { onClose: () => void }) {
  const t = useT();
  const tp = useTp();
  const { artists, backed } = useData();
  // all styles come from lib/dialogTheme
  const { panel, divider, box, soft, accent: accentFill, accentText } = useDialogTheme();
  const accent = useAccent();
  const cyber = accent === "cyberpunk";
  const premium = cyber || accent === "iridescent" || accent === "sakura";
  // soft has no radius, cyberpunk gets square corners
  const rowRadius = cyber ? "rounded-none" : "rounded-lg";
  // bars use the accent fill on premium themes, standard ones keep their two colors
  const barTrack = cyber ? "bg-[#fcee0a]/15" : premium ? "bg-white/12" : "bg-zinc-800";
  const meterGlow = cyber
    ? "shadow-[0_0_10px_rgba(252,238,10,0.45)]"
    : accent === "iridescent"
      ? "shadow-[0_0_10px_rgba(245,194,255,0.35)]"
      : accent === "sakura"
        ? "shadow-[0_0_10px_rgba(236,72,153,0.4)]"
        : "";
  // dashed placeholder ("No rewards yet", "Measuring...")
  const emptyBox = cn("border border-dashed p-3 text-center text-xs text-zinc-500", divider, rowRadius);
  const stats = useMemo(() => computeStats(artists), [artists]);
  const [size, setSize] = useState<number | null>(null);
  const [storage, setStorage] = useState<ArtistStorage[] | null>(null);

  useEffect(() => {
    if (!backed) return;
    let alive = true;
    librarySize()
      .then((b) => alive && setSize(b))
      .catch(() => alive && setSize(0));
    storageBreakdown()
      .then((s) => alive && setStorage(s))
      .catch(() => alive && setStorage([]));
    return () => {
      alive = false;
    };
  }, [backed]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
      <motion.div
        initial={{ opacity: 0, y: 12, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        className={cn("flex max-h-[88vh] w-[40rem] max-w-full flex-col overflow-hidden", panel)}
      >
        <div className={cn("flex shrink-0 items-center justify-between border-b px-5 py-4", divider)}>
          <h2 className="text-base font-semibold text-zinc-100">{t("Collection stats")}</h2>
          {/* duplicate scan isn't here anymore, it's in the right-click menus */}
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-300">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {/* top tiles */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Tile box={box} ink={accentText} icon={<Users className="h-4 w-4" />} label={t("Creators")} value={stats.artists} />
            <Tile box={box} ink={accentText} icon={<Package className="h-4 w-4" />} label={t("Rewards")} value={stats.rewards} />
            <Tile box={box} ink={accentText} icon={<ImageIcon className="h-4 w-4" />} label={t("Images")} value={stats.images} />
            <Tile
              box={box}
              ink={accentText}
              icon={<HardDrive className="h-4 w-4" />}
              label={t("On disk")}
              value={size == null ? "…" : formatBytes(size)}
            />
          </div>

          {/* owned vs total */}
          <div className={cn("mt-4 p-3", box)}>
            <div className="flex items-center justify-between text-sm">
              <span className="text-zinc-400">{t("Owned rewards")}</span>
              <span className="font-medium text-zinc-100">
                {stats.ownedRewards} / {stats.rewards}
              </span>
            </div>
            {/* main meter: accent fill + glow on premium, emerald otherwise */}
            <div className={cn("mt-2 h-2 overflow-hidden rounded-full", barTrack)}>
              <div
                className={cn(
                  "h-full rounded-full",
                  premium ? cn(accentFill, meterGlow) : "bg-emerald-500",
                )}
                style={{
                  width: `${stats.rewards > 0 ? (stats.ownedRewards / stats.rewards) * 100 : 0}%`,
                }}
              />
            </div>
          </div>

          {/* per platform */}
          <div className="mt-5">
            <div className="mb-2 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-zinc-500">
              <Layers className={cn("h-3.5 w-3.5", accentText)} />
              {t("By platform")}
            </div>
            {stats.platforms.length === 0 ? (
              <p className={emptyBox}>{t("No rewards yet.")}</p>
            ) : (
              <div className="space-y-1.5">
                {stats.platforms.map((p) => {
                  const max = stats.platforms[0].rewards || 1;
                  return (
                    <div key={p.name} className={cn("border px-3 py-2", soft, rowRadius)}>
                      <div className="flex items-center justify-between text-sm">
                        <span className="font-medium text-zinc-200">{p.name}</span>
                        <span className="text-xs text-zinc-500">
                          {tp("{n} creators", p.artists)} · {tp("{n} rewards", p.rewards)} ·{" "}
                          {tp("{n} images", p.images)}
                        </span>
                      </div>
                      <div className={cn("mt-1.5 h-1.5 overflow-hidden rounded-full", barTrack)}>
                        <div
                          className={cn("h-full rounded-full", premium ? accentFill : "bg-brand-500")}
                          style={{ width: `${(p.rewards / max) * 100}%` }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* storage per artist */}
          <div className="mt-5">
            <div className="mb-2 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-zinc-500">
              <HardDrive className={cn("h-3.5 w-3.5", accentText)} />
              {t("Storage by creator")}
            </div>
            {storage == null ? (
              <p className={emptyBox}>{t("Measuring…")}</p>
            ) : storage.length === 0 ? (
              <p className={emptyBox}>{t("Nothing on disk yet.")}</p>
            ) : (
              <div className="space-y-1.5">
                {storage.slice(0, 10).map((s) => {
                  const max = storage[0].bytes || 1;
                  return (
                    <div key={s.id} className={cn("border px-3 py-2", soft, rowRadius)}>
                      <div className="flex items-center justify-between text-sm">
                        <span className="truncate font-medium text-zinc-200">{s.name}</span>
                        <span className="shrink-0 text-xs text-zinc-500">
                          {formatBytes(s.bytes)} · {tp("{n} files", s.files)}
                        </span>
                      </div>
                      <div className={cn("mt-1.5 h-1.5 overflow-hidden rounded-full", barTrack)}>
                        {/* a bit quieter than the platform bars */}
                        <div
                          className={cn(
                            "h-full rounded-full",
                            premium ? cn(accentFill, "opacity-70") : "bg-accent2-500",
                          )}
                          style={{ width: `${(s.bytes / max) * 100}%` }}
                        />
                      </div>
                    </div>
                  );
                })}
                {storage.length > 10 && (
                  <p className="px-1 pt-1 text-xs text-zinc-500">
                    + {tp("{n} more creators", storage.length - 10)}
                  </p>
                )}
              </div>
            )}
          </div>

          {/* tags */}
          <div className="mt-5">
            <div className="mb-2 text-xs font-medium uppercase tracking-wide text-zinc-500">
              {t("By class")}
            </div>
            <div className="flex flex-wrap gap-2">
              {artistTags().map(({ key, label, color, Icon }) => (
                <div
                  key={key}
                  className={cn("inline-flex items-center gap-1.5 border px-2.5 py-1.5 text-sm", soft, rowRadius)}
                >
                  <Icon className={`h-4 w-4 ${color}`} fill="currentColor" />
                  <span className="text-zinc-300">{t(label)}</span>
                  <span className="font-medium text-zinc-100">{stats.tagCounts.get(key) ?? 0}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </motion.div>
    </div>
  );
}

function Tile({
  icon,
  label,
  value,
  box,
  ink,
}: {
  icon: React.ReactNode;
  label: string;
  value: number | string;
  /** The accent's box style (border, fill, radius). */
  box: string;
  /** Accent color for the icon. */
  ink: string;
}) {
  return (
    <div className={cn("p-3", box)}>
      <div className="flex items-center gap-1.5 text-xs text-zinc-500">
        <span className={ink}>{icon}</span>
        {label}
      </div>
      <div className="mt-1 text-xl font-bold text-zinc-50">{value}</div>
    </div>
  );
}
