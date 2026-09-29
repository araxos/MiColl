import { useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { motion } from "framer-motion";
import { X, Check, Users, Search } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { useData } from "@/store";
import { setRewardCollabs } from "@/api/library";
import { useDialogTheme } from "@/lib/dialogTheme";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n";
import type { Reward } from "@/types";

/**
 * Credit a reward to creators who worked on it together.
 * The reward stays where it is, the picked creators' cards just show it too
 * (marked as from the owner). Nothing is copied or counted twice.
 * The owner isn't in the list. Already credited ones are pre-checked,
 * unchecking one and saving removes the link.
 */
export function CollabPicker({
  reward,
  ownerArtistId,
  onClose,
  onDone,
}: {
  reward: Reward;
  ownerArtistId: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const { artists } = useData();
  const { panel, input, primary } = useDialogTheme();
  const t = useT();
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<string>>(
    () => new Set((reward.collabWith ?? []).map((c) => c.artistId)),
  );

  // never offer the owner (no self-collab)
  const candidates = useMemo(() => {
    const q = query.trim().toLowerCase();
    return artists
      .filter((a) => a.id !== ownerArtistId)
      .filter(
        (a) =>
          !q ||
          a.name.toLowerCase().includes(q) ||
          (a.aliases ?? []).some((al) => al.toLowerCase().includes(q)),
      );
  }, [artists, ownerArtistId, query]);

  const toggle = (id: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await setRewardCollabs(reward.id, [...picked]);
      onDone();
    } catch (err) {
      setError(`${err}`);
    } finally {
      setBusy(false);
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
      <motion.div
        initial={{ opacity: 0, y: 12, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        className={cn("flex max-h-[80vh] w-[26rem] max-w-full flex-col p-5", panel)}
      >
        <div className="mb-1 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="flex items-center gap-2 text-base font-semibold text-zinc-100">
              <Users className="h-4 w-4 text-violet-300" />
              {t("Collab with…")}
            </h2>
            <p className="mt-0.5 truncate text-xs text-zinc-400">{reward.title}</p>
          </div>
          <button onClick={onClose} className="shrink-0 text-zinc-500 hover:text-zinc-300">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="relative mt-3">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-500" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && onClose()}
            placeholder={t("Search creators…")}
            className={cn(input, "pl-8")}
          />
        </div>

        <div className="mt-3 min-h-0 flex-1 overflow-y-auto rounded-lg border border-zinc-800/70">
          {candidates.length === 0 ? (
            <p className="px-3 py-6 text-center text-xs text-zinc-500">
              {artists.length <= 1
                ? t("No other creators yet.")
                : t("No creators match that search.")}
            </p>
          ) : (
            candidates.map((a) => {
              const on = picked.has(a.id);
              return (
                <button
                  key={a.id}
                  onClick={() => toggle(a.id)}
                  className={cn(
                    "flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm transition-colors",
                    on ? "bg-violet-500/15 text-zinc-100" : "text-zinc-300 hover:bg-white/5",
                  )}
                >
                  <span
                    className={cn(
                      "flex h-4 w-4 shrink-0 items-center justify-center rounded border",
                      on
                        ? "border-violet-400 bg-violet-500 text-white"
                        : "border-zinc-600 text-transparent",
                    )}
                  >
                    <Check className="h-3 w-3" strokeWidth={3} />
                  </span>
                  <span className="truncate">{a.name}</span>
                </button>
              );
            })
          )}
        </div>

        <p className="mt-2 text-xs text-zinc-500">
          {t(
            "The reward stays in its own folder — the creators you pick just show it too, marked as a collab. Only creators that already have a card can be picked.",
          )}
        </p>
        {error && <p className="mt-2 text-xs text-rose-300">{error}</p>}

        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {t("Cancel")}
          </Button>
          <Button variant="primary" onClick={() => void save()} disabled={busy} className={primary}>
            <Check className="h-4 w-4" />
            {busy ? t("Saving…") : t("Save")}
          </Button>
        </div>
      </motion.div>
    </div>,
    document.body,
  );
}
