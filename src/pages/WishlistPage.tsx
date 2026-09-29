import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { open } from "@tauri-apps/plugin-dialog";
import { ChevronLeft, Gift, Plus, ImagePlus, Check, Trash2, X } from "lucide-react";
import { Layout } from "@/components/Layout";
import { Cover } from "@/components/Cover";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { useData } from "@/store";
import { useUpNavigate } from "@/lib/nav";
import { useDialogTheme } from "@/lib/dialogTheme";
import { cn } from "@/lib/utils";
import { useT, useTf } from "@/lib/i18n";
import {
  addWish,
  setWished,
  importWishCover,
  setRewardCover,
  setRewardStatus,
  deleteRewards,
} from "@/api/library";
import type { Artist } from "@/types";

/**
 * Wishlist: everything that's released but not owned, on one page.
 * There's no wishlist table, a wish is a "missing" reward with the wished flag.
 * When the files arrive it becomes "owned" and leaves this page by itself.
 * Template "missing" rewards don't have the flag, so they don't show here.
 */

interface Wish {
  rewardId: string;
  title: string;
  cover: string;
  artist: Artist;
  /** "Patreon · 03.25", or just the period label if the platform is unknown. */
  where: string;
  /** The row only exists because of the wish (removing the wish deletes it). */
  ours: boolean;
}

/** All wished rewards that aren't owned yet. */
function collectWishes(artists: Artist[]): Wish[] {
  const out: Wish[] = [];
  for (const artist of artists) {
    for (const platform of artist.platforms ?? []) {
      for (const month of platform.months ?? []) {
        for (const reward of month.rewards ?? []) {
          if (!reward.wished || reward.status !== "missing" || reward.collabFrom) continue;
          out.push({
            rewardId: reward.id,
            title: reward.title,
            cover: reward.cover,
            artist,
            where: [platform.name, month.label].filter(Boolean).join(" · "),
            ours: !!reward.wishOnly,
          });
        }
      }
    }
  }
  return out;
}

export function WishlistPage({ onLock }: { onLock?: () => void }) {
  const t = useT();
  const tf = useTf();
  const { artists, refresh, backed } = useData();
  const navigate = useNavigate();
  const upNavigate = useUpNavigate();
  const dlg = useDialogTheme();

  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<Wish | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const wishes = useMemo(() => collectWishes(artists), [artists]);

  /** Grouped by creator. */
  const groups = useMemo(() => {
    const by = new Map<string, { artist: Artist; items: Wish[] }>();
    for (const w of wishes) {
      const g = by.get(w.artist.id) ?? { artist: w.artist, items: [] };
      g.items.push(w);
      by.set(w.artist.id, g);
    }
    return [...by.values()].sort((a, b) => a.artist.name.localeCompare(b.artist.name));
  }, [wishes]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const pickImage = () =>
    open({
      multiple: false,
      filters: [{ name: "Image", extensions: ["jpg", "jpeg", "png", "webp", "gif", "bmp"] }],
    });

  const summary =
    wishes.length === 0
      ? t("Nothing on the list")
      : tf("{wishes} wishes from {creators} creators", {
          wishes: wishes.length,
          creators: groups.length,
        });

  return (
    <Layout
      onLock={onLock}
      titleSlot={<span className="font-medium text-zinc-100">{t("Wishlist")}</span>}
      toolbar={
        <div className="mx-auto flex w-full max-w-5xl items-center gap-3 px-6 pb-4 pt-6">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => upNavigate("/", () => true)}
            className="gap-1.5"
          >
            <ChevronLeft className="h-4 w-4" />
            {t("Back")}
          </Button>
          <div className="text-sm text-white">{summary}</div>
          <Button
            size="sm"
            className="ml-auto"
            onClick={() => setAdding(true)}
            disabled={!backed || busy}
          >
            <Plus className="mr-1.5 h-4 w-4" />
            {t("Add a wish")}
          </Button>
        </div>
      }
    >
      <div className="mx-auto w-full max-w-5xl px-6 pb-16">
        {error && (
          <div className="mb-4 flex items-start gap-2 rounded-lg border border-red-500/40 bg-red-950/40 px-3 py-2 text-sm text-red-200">
            <span className="min-w-0 flex-1">{error}</span>
            <button onClick={() => setError(null)} aria-label={t("Dismiss")}>
              <X className="h-4 w-4" />
            </button>
          </div>
        )}

        {wishes.length === 0 ? (
          <div
            className={cn(
              "mt-10 flex flex-col items-center gap-3 px-6 py-14 text-center text-white",
              dlg.box,
            )}
          >
            <Gift className="h-8 w-8 text-white" />
            <p className="max-w-md text-sm">
              {t(
                "Nothing here yet. Add what you are still after — it also shows up as a placeholder card on that creator, and when you finally get the files MiColl matches them and the wish turns into a real reward by itself.",
              )}
            </p>
            <Button size="sm" className="mt-1" onClick={() => setAdding(true)} disabled={!backed}>
              <Plus className="mr-1.5 h-4 w-4" />
              {t("Add a wish")}
            </Button>
          </div>
        ) : (
          groups.map((g) => (
            <section key={g.artist.id} className="mb-9">
              <button
                onClick={() => navigate(`/artist/${g.artist.id}`)}
                className="mb-3 text-left text-sm font-semibold text-zinc-200 transition-colors hover:text-brand-300"
              >
                {g.artist.name}
                <span className="ml-2 font-normal text-zinc-500">{g.items.length}</span>
              </button>
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
                {g.items.map((w) => (
                  <div
                    key={w.rewardId}
                    className={cn("group relative overflow-hidden", dlg.box)}
                  >
                    <div className="aspect-[3/4] w-full">
                      <Cover path={w.cover} seed={w.title} label={w.title} rounded="rounded-none" />
                    </div>
                    <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 via-black/40 to-transparent px-3 pb-2 pt-7">
                      <div className="truncate text-[13px] font-semibold text-white">{w.title}</div>
                      <div className="truncate text-[10px] text-zinc-300">{w.where}</div>
                    </div>
                    {/* only on hover so they don't cover the picture */}
                    <div className="absolute right-1.5 top-1.5 flex gap-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
                      <TileBtn
                        title={t("Choose a cover…")}
                        disabled={busy}
                        onClick={() =>
                          void run(async () => {
                            const picked = await pickImage();
                            if (typeof picked !== "string") return;
                            // copied into MiColl's data folder, a picture in the reward
                            // folder would count as owned
                            const stored = await importWishCover(picked);
                            await setRewardCover(w.rewardId, stored);
                          })
                        }
                      >
                        <ImagePlus className="h-3.5 w-3.5" />
                      </TileBtn>
                      <TileBtn
                        title={t("I have this now — mark as owned")}
                        disabled={busy}
                        onClick={() => void run(() => setRewardStatus(w.rewardId, "owned"))}
                      >
                        <Check className="h-3.5 w-3.5" />
                      </TileBtn>
                      <TileBtn
                        title={t("Remove from the wishlist")}
                        disabled={busy}
                        onClick={() => setRemoving(w)}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </TileBtn>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          ))
        )}
      </div>

      {adding && (
        <AddWishDialog
          artists={artists}
          pickImage={pickImage}
          onClose={() => setAdding(false)}
          onSave={async (v) => {
            await run(async () => {
              const id = await addWish(v.creator, v.title, v.platform, v.year, v.month);
              if (v.cover) {
                const stored = await importWishCover(v.cover);
                await setRewardCover(String(id), stored);
              }
            });
            setAdding(false);
          }}
        />
      )}

      {removing && (
        <ConfirmDialog
          title={t("Remove this wish?")}
          body={
            <>
              <span className="font-medium text-zinc-100">{removing.title}</span> comes off the
              wishlist. Nothing on disk is touched — a wish has no files.
              {!removing.ours && " A template lists this reward, so its placeholder card stays on the creator."}
            </>
          }
          confirmLabel={t("Remove")}
          busy={busy}
          onCancel={() => setRemoving(null)}
          onConfirm={() => {
            const w = removing;
            setRemoving(null);
            // clear the flag instead of deleting the row (a template may list it too)
            void run(() =>
              w.ours ? deleteRewards([w.rewardId], false) : setWished(w.rewardId, 0),
            );
          }}
        />
      )}
    </Layout>
  );
}

/** Icon on a dark disc over a cover (like the reward tiles). */
function TileBtn({
  title,
  onClick,
  disabled,
  children,
}: {
  title: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={onClick}
      className="flex h-7 w-7 items-center justify-center rounded-full bg-black/60 text-white backdrop-blur-sm transition-colors hover:bg-black/80 disabled:opacity-40"
    >
      {children}
    </button>
  );
}

interface WishDraft {
  creator: string;
  title: string;
  platform: string | null;
  year: number | null;
  month: number | null;
  cover: string | null;
}

/**
 * Creator is free text with the library as suggestions. A new name creates a card,
 * an existing one is used (the backend matches by name).
 */
function AddWishDialog({
  artists,
  pickImage,
  onClose,
  onSave,
}: {
  artists: Artist[];
  pickImage: () => Promise<unknown>;
  onClose: () => void;
  onSave: (v: WishDraft) => Promise<void>;
}) {
  const t = useT();
  const dlg = useDialogTheme();
  const [creator, setCreator] = useState("");
  const [title, setTitle] = useState("");
  const [platform, setPlatform] = useState("");
  const [year, setYear] = useState("");
  const [month, setMonth] = useState("");
  const [cover, setCover] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const platforms = useMemo(() => {
    const set = new Set<string>();
    for (const a of artists) for (const p of a.platforms ?? []) if (p.name) set.add(p.name);
    return [...set].sort();
  }, [artists]);

  const known = artists.some((a) => a.name.toLowerCase() === creator.trim().toLowerCase());
  const canSave = creator.trim() !== "" && title.trim() !== "" && !saving;
  const label = "mb-1 block text-xs font-medium text-zinc-400";

  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
      <div className={cn("w-full max-w-md p-5", dlg.panel)}>
        <h2 className="mb-4 text-base font-semibold text-zinc-100">{t("Add a wish")}</h2>

        <div className="space-y-3">
          <div>
            <label className={label} htmlFor="wish-creator">
              {t("Creator")}
            </label>
            <input
              id="wish-creator"
              list="wish-creators"
              className={dlg.input}
              value={creator}
              onChange={(e) => setCreator(e.target.value)}
              placeholder={t("Who released it?")}
              autoFocus
            />
            <datalist id="wish-creators">
              {artists.map((a) => (
                <option key={a.id} value={a.name} />
              ))}
            </datalist>
            {creator.trim() !== "" && !known && (
              <p className="mt-1 text-[11px] text-zinc-500">
                {t("New creator — a card is created for them.")}
              </p>
            )}
          </div>

          <div>
            <label className={label} htmlFor="wish-title">
              {t("Reward")}
            </label>
            <input
              id="wish-title"
              className={dlg.input}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={t("What are you after?")}
            />
          </div>

          <div>
            <label className={label} htmlFor="wish-platform">
              {t("Platform")} <span className="font-normal opacity-60">{t("(optional)")}</span>
            </label>
            <input
              id="wish-platform"
              list="wish-platforms"
              className={dlg.input}
              value={platform}
              onChange={(e) => setPlatform(e.target.value)}
              placeholder={t("Patreon, Ko-Fi, …")}
            />
            <datalist id="wish-platforms">
              {platforms.map((p) => (
                <option key={p} value={p} />
              ))}
            </datalist>
          </div>

          <div className="grid grid-cols-3 gap-2">
            <div className="col-span-2">
              <label className={label} htmlFor="wish-year">
                {t("Year")} <span className="font-normal opacity-60">{t("(optional)")}</span>
              </label>
              <input
                id="wish-year"
                className={dlg.input}
                inputMode="numeric"
                value={year}
                onChange={(e) => setYear(e.target.value.replace(/[^0-9]/g, "").slice(0, 4))}
                placeholder="2026"
              />
            </div>
            <div>
              <label className={label} htmlFor="wish-month">
                {t("Month")}
              </label>
              <input
                id="wish-month"
                className={dlg.input}
                inputMode="numeric"
                value={month}
                onChange={(e) => setMonth(e.target.value.replace(/[^0-9]/g, "").slice(0, 2))}
                placeholder="03"
              />
            </div>
          </div>

          <div>
            <span className={label}>{t("Cover")}</span>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={async () => {
                  const picked = await pickImage();
                  if (typeof picked === "string") setCover(picked);
                }}
              >
                <ImagePlus className="mr-1.5 h-4 w-4" />
                {cover ? t("Change…") : t("Choose a picture…")}
              </Button>
              {cover && (
                <span className="min-w-0 flex-1 truncate text-[11px] text-zinc-500" title={cover}>
                  {cover.split(/[\\/]/).pop()}
                </span>
              )}
            </div>
          </div>
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose} disabled={saving}>
            {t("Cancel")}
          </Button>
          <Button
            size="sm"
            disabled={!canSave}
            onClick={() => {
              setSaving(true);
              void onSave({
                creator,
                title,
                platform: platform.trim() || null,
                year: year ? Number(year) : null,
                // a month without a year is cleared too
                month: year && month ? Number(month) : null,
                cover,
              }).finally(() => setSaving(false));
            }}
          >
            {saving ? t("Adding…") : t("Add")}
          </Button>
        </div>
      </div>
    </div>
  );
}
