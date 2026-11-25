import { useState } from "react";
import { ChevronDown, Eye, EyeOff, Images } from "lucide-react";
import type { WallSet } from "@/api/library";
import { Button } from "@/components/ui/Button";
import { RunsOn, Thumb, useHubBox, useHubMenu } from "@/components/hub/shared";
import { useDialogTheme } from "@/lib/dialogTheme";
import { useT, useTf, useTp } from "@/lib/i18n";
import { useAccent } from "@/lib/theme";
import { cn } from "@/lib/utils";

/** Under the overview: the slideshows that are hidden on the place that's shown. */
export function HiddenSets({
  sets,
  onOpen,
  onShow,
}: {
  sets: WallSet[];
  onOpen: (id: string) => void;
  onShow: (id: string) => void;
}) {
  const tf = useTf();
  const dlg = useDialogTheme();
  const irid = useAccent() === "iridescent";
  const [open, setOpen] = useState(false);
  if (sets.length === 0) return null;
  return (
    <div className="mt-5">
      {/* iridescent: its own dark plate, the wallpaper is too bright for the pill */}
      <div className={cn("w-fit", irid && "border border-white/15 bg-zinc-950/65 p-1.5 backdrop-blur")}>
        <button
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          className={cn("inline-flex items-center gap-2 px-3 py-1.5 text-xs font-medium", open ? dlg.controlOn : dlg.control)}
        >
          <EyeOff className="h-3.5 w-3.5" />
          {tf("{n} hidden here", { n: sets.length })}
          <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", open && "rotate-180")} />
        </button>
      </div>
      {open && (
        <div className="mt-3 grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-3">
          {sets.map((s) => (
            <HiddenSet key={s.id} set={s} onOpen={() => onOpen(s.id)} onShow={() => onShow(s.id)} />
          ))}
        </div>
      )}
    </div>
  );
}

function HiddenSet({ set: s, onOpen, onShow }: { set: WallSet; onOpen: () => void; onShow: () => void }) {
  const t = useT();
  const tp = useTp();
  const box = useHubBox();
  const menu = useHubMenu(s);
  return (
    <div className={cn("flex min-w-0 items-center gap-3 p-2.5", box)} {...menu}>
      <button onClick={onOpen} title={t("Open")} aria-label={t("Open")} className="h-12 w-16 shrink-0 overflow-hidden rounded-md bg-black/40">
        {s.preview[0] ? (
          <Thumb path={s.preview[0]} />
        ) : (
          <span className="flex h-full w-full items-center justify-center">
            <Images className="h-4 w-4 text-zinc-500" />
          </span>
        )}
      </button>
      <div className="min-w-0 flex-1">
        <button onClick={onOpen} className="block max-w-full truncate text-left text-sm font-semibold text-zinc-100">
          {s.name}
        </button>
        <div className="truncate text-xs text-zinc-500">{tp("{n} pictures", s.count)}</div>
      </div>
      <RunsOn set={s} />
      <Button variant="outline" size="sm" onClick={onShow}>
        <Eye className="h-4 w-4" />
        {t("Show here")}
      </Button>
    </div>
  );
}
