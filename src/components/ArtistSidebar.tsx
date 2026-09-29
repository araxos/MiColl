import { useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import { X, Plus, Check, Trash2, ExternalLink, Link as LinkIcon, RotateCcw, HelpCircle, StickyNote, MonitorPlay } from "lucide-react";
import { Cover } from "@/components/Cover";
import { artistTags, isNsfwTag, nsfwChipColors } from "@/lib/artistTags";
import { CREATOR_TYPES, parseKinds } from "@/lib/creatorTypes";
import { useData } from "@/store";
import { useActions } from "@/actions";
import { useAccent, toggleOnClass } from "@/lib/theme";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n";
import * as api from "@/api/library";
import type { Artist, ArtistLink } from "@/types";

/** Right side panel for an artist: class, types, aliases, tags, notes and links. */
export function ArtistSidebar({
  artist,
  onClose,
  focusName,
}: {
  artist: Artist;
  onClose: () => void;
  /** Open with the name selected ("Rename" in the creator menu). */
  focusName?: boolean;
}) {
  const t = useT();
  const { backed, refresh } = useData();
  const { showToast } = useActions();
  const [name, setName] = useState(artist.name);
  const nameRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (!focusName) return;
    const el = nameRef.current;
    if (!el) return;
    el.focus();
    el.select();
  }, [focusName]);
  const [savingName, setSavingName] = useState(false);
  const [links, setLinks] = useState<ArtistLink[]>(artist.links ?? []);
  /**
   * What's saved in the DB. links = what's on screen, the difference shows the save
   * checkmark.
   */
  const [savedLinks, setSavedLinks] = useState<ArtistLink[]>(artist.links ?? []);
  const [tags, setTags] = useState<string[]>(artist.tags ?? []);
  const [tagInput, setTagInput] = useState("");
  const [aliases, setAliases] = useState<string[]>(artist.aliases ?? []);
  const [aliasInput, setAliasInput] = useState("");
  const [notes, setNotes] = useState(artist.notes ?? "");
  const [wallpaperFav, setWallpaperFav] = useState(!!artist.wallpaperFav);

  // reset when switching to another artist
  useEffect(() => {
    setName(artist.name);
    setLinks(artist.links ?? []);
    setSavedLinks(artist.links ?? []);
    setTags(artist.tags ?? []);
    setTagInput("");
    setAliases(artist.aliases ?? []);
    setAliasInput("");
    setNotes(artist.notes ?? "");
    setWallpaperFav(!!artist.wallpaperFav);
  }, [artist.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // rename the creator (also renames the folder and updates all paths).
  // saves on Enter/blur, only if it changed
  const saveName = async () => {
    const next = name.trim();
    if (!backed || savingName || next === artist.name) {
      if (!next) setName(artist.name); // don't allow blank
      return;
    }
    if (!next) {
      setName(artist.name);
      return;
    }
    setSavingName(true);
    try {
      await api.renameArtist(artist.id, next);
      setName(next); // reflect the trimmed value
      await refresh();
      showToast({ tone: "success", title: t("Creator renamed"), detail: `“${artist.name}” → “${next}”` });
    } catch (e) {
      setName(artist.name); // revert on failure (e.g. name already taken)
      showToast({ tone: "error", title: t("Couldn’t rename"), detail: `${e}` });
    } finally {
      setSavingName(false);
    }
  };

  const toggleWallpaperFav = async () => {
    if (!backed) return;
    const next = !wallpaperFav;
    setWallpaperFav(next); // optimistic
    await api.setArtistWallpaperFav(artist.id, next);
    await refresh();
  };

  // save notes on blur if they changed
  const saveNotes = async () => {
    if (!backed || notes === (artist.notes ?? "")) return;
    await api.setArtistNotes(artist.id, notes.trim() || null);
    await refresh();
  };

  const saveTags = async (next: string[]) => {
    setTags(next);
    if (backed) {
      await api.setArtistTags(artist.id, next);
      await refresh();
    }
  };
  const hasTag = (val: string) => tags.some((x) => x.toLowerCase() === val.toLowerCase());
  const toggleTag = (val: string) =>
    void saveTags(
      hasTag(val) ? tags.filter((x) => x.toLowerCase() !== val.toLowerCase()) : [...tags, val],
    );
  const addTag = (raw: string) => {
    const t = raw.trim();
    setTagInput("");
    if (t && !hasTag(t)) void saveTags([...tags, t]);
  };

  const saveAliases = async (next: string[]) => {
    setAliases(next);
    if (backed) {
      await api.setArtistAliases(artist.id, next);
      await refresh();
    }
  };
  const hasAlias = (val: string) => aliases.some((x) => x.toLowerCase() === val.toLowerCase());
  const copyAlias = async (val: string) => {
    try {
      await navigator.clipboard.writeText(val);
      showToast({ tone: "success", title: t("Copied to clipboard"), detail: `“${val}”` });
    } catch (e) {
      showToast({ tone: "error", title: t("Couldn’t copy"), detail: `${e}` });
    }
  };
  const addAlias = (raw: string) => {
    const t = raw.trim();
    setAliasInput("");
    if (t && !hasAlias(t)) void saveAliases([...aliases, t]);
  };

  const setTag = async (key: string) => {
    if (!backed) return;
    const next = artist.tag === key ? null : key; // click active → clear
    await api.setArtistTag(artist.id, next);
    await refresh();
  };

  // several types possible (e.g. Cosplayer AND Artist)
  const setKind = async (key: string) => {
    if (!backed) return;
    const current = parseKinds(artist.kind);
    const next = current.includes(key)
      ? current.filter((k) => k !== key)
      : [...current, key];
    await api.setArtistKind(artist.id, next.length ? next.join(",") : null);
    await refresh();
  };

  /** A row worth saving (a new empty row isn't saved). */
  const linkFilled = (l?: ArtistLink) => !!(l && (l.label.trim() || l.url.trim()));

  /**
   * Save the links and reload the library (otherwise the store still has the old links).
   */
  const persistLinks = async (next: ArtistLink[]) => {
    setLinks(next);
    if (!backed) {
      setSavedLinks(next);
      return;
    }
    try {
      await api.setArtistLinks(artist.id, next.filter(linkFilled));
      setSavedLinks(next); // mirrors the rows on screen, so the row indices line up
      await refresh();
    } catch (e) {
      showToast({ tone: "error", title: t("Couldn’t save the link"), detail: `${e}` });
    }
  };

  const updateLink = (i: number, patch: Partial<ArtistLink>) =>
    setLinks((prev) => prev.map((l, k) => (k === i ? { ...l, ...patch } : l)));

  /** True if a row has unsaved changes (shows its save checkmark). */
  const linkDirty = (i: number) =>
    linkFilled(links[i]) && JSON.stringify(links[i]) !== JSON.stringify(savedLinks[i] ?? null);
  /** Save on blur/Enter. Skips if nothing changed and ignores empty rows. */
  const saveLinksIfDirty = () => {
    const stored = (ls: ArtistLink[]) => JSON.stringify(ls.filter(linkFilled));
    if (stored(links) !== stored(savedLinks)) void persistLinks(links);
  };

  // panel style per theme
  const accent = useAccent();
  const surface =
    accent === "cyberpunk"
      ? "border-l border-[#fcee0a]/40 bg-zinc-950/85 backdrop-blur-2xl"
      : accent === "iridescent"
        ? "border-l border-white/12 bg-zinc-900/70 backdrop-blur-2xl"
        : accent === "sakura"
          ? "border-l border-[#f9a8d4]/30 bg-zinc-950/80 backdrop-blur-2xl"
          : "border-l border-brand-500/20 bg-gradient-to-b from-brand-950/50 via-zinc-950/90 to-zinc-950/90 backdrop-blur-xl";
  const headerBar =
    accent === "cyberpunk"
      ? "border-b border-[#fcee0a]/25 bg-[#fcee0a]/5"
      : accent === "iridescent"
        ? "border-b border-white/10 bg-white/5"
        : accent === "sakura"
          ? "border-b border-[#f9a8d4]/20 bg-[#f9a8d4]/5"
          : "border-b border-brand-500/15 bg-gradient-to-r from-brand-900/40 to-transparent";

  // control styles per accent. Standard accents use brand-*, premium ones get their own
  // (a brand chip would look wrong in their chrome).
  const irid = accent === "iridescent";
  const SKINS = {
    iridescent: {
      // frosted glass (dark looked too heavy)
      ctlIdle: "border-white/15 bg-white/10 text-zinc-200 hover:bg-white/20",
      ctlActive: "border-white/45 bg-white/25 text-white",
      ctlActiveNeutral: "border-white/45 bg-white/25 text-white",
      field:
        "border-white/15 bg-white/10 text-zinc-100 placeholder:text-zinc-400 focus:border-white/50",
      idleIcon: "text-zinc-200",
      label: "text-zinc-200",
      hint: "text-zinc-300",
      chip: "border-white/25 bg-white/12 text-zinc-100",
      chipHover: "hover:bg-white/15",
      chipX: "text-zinc-300 hover:bg-white/20 hover:text-white",
      link: "text-zinc-100 hover:text-white",
      focus: "focus:border-white/40",
      close: "hover:bg-white/15 hover:text-white",
      favOn: "border-white/45 bg-white/15",
      favIcon: "text-white",
      idleText: "text-zinc-300",
      tip: "border-white/15 bg-zinc-900/90 backdrop-blur-xl",
      box: "border-white/15 bg-white/5",
      btn: "border-white/20 bg-white/12 hover:bg-white/20",
    },
    cyberpunk: {
      // yellow on black, hard edges
      ctlIdle:
        "rounded-none border-[#fcee0a]/20 bg-zinc-950/70 text-zinc-400 hover:border-[#fcee0a]/45 hover:bg-[#fcee0a]/10",
      ctlActive:
        "rounded-none border-[#fcee0a]/80 bg-[#fcee0a]/15 text-[#fcee0a] shadow-[0_0_12px_rgba(252,238,10,0.22)]",
      ctlActiveNeutral: "rounded-none border-[#00e5ff]/70 bg-[#00e5ff]/12 text-[#7df3ff]",
      field:
        "rounded-none border-[#fcee0a]/25 bg-zinc-950/70 text-zinc-100 placeholder:text-zinc-500 focus:border-[#fcee0a]/80",
      idleIcon: "text-zinc-600",
      label: "text-[#fcee0a]/70",
      hint: "text-zinc-500",
      chip: "rounded-none border-[#fcee0a]/40 bg-[#fcee0a]/10 text-[#fcee0a]",
      chipHover: "hover:bg-[#fcee0a]/20",
      chipX: "text-[#fcee0a]/60 hover:bg-[#fcee0a]/25 hover:text-[#fcee0a]",
      link: "text-[#fcee0a] hover:text-[#fff45c]",
      focus: "focus:border-[#fcee0a]/80",
      close: "hover:bg-[#fcee0a]/15 hover:text-[#fcee0a]",
      favOn: "rounded-none border-[#fcee0a]/70 bg-[#fcee0a]/10",
      favIcon: "text-[#fcee0a]",
      idleText: "text-zinc-500",
      tip: "rounded-none border-[#fcee0a]/40 bg-zinc-950/95 backdrop-blur-xl",
      box: "rounded-none border-[#fcee0a]/20 bg-zinc-950/50",
      btn: "rounded-none border-[#fcee0a]/35 bg-zinc-950/70 hover:bg-[#fcee0a]/15",
    },
    sakura: {
      // soft pink
      ctlIdle: "border-[#f9a8d4]/20 bg-zinc-950/60 text-zinc-400 hover:bg-[#f9a8d4]/10",
      ctlActive: "border-[#f472b6]/60 bg-[#f472b6]/15 text-[#fbcfe8]",
      ctlActiveNeutral: "border-[#f9a8d4]/50 bg-[#f9a8d4]/15 text-zinc-100",
      field:
        "border-[#f9a8d4]/25 bg-zinc-950/60 text-zinc-100 placeholder:text-zinc-500 focus:border-[#f472b6]/70",
      idleIcon: "text-zinc-600",
      label: "text-[#f9a8d4]/80",
      hint: "text-zinc-500",
      chip: "border-[#f9a8d4]/35 bg-[#f472b6]/12 text-[#fbcfe8]",
      chipHover: "hover:bg-[#f472b6]/25",
      chipX: "text-[#f9a8d4]/70 hover:bg-[#f472b6]/25 hover:text-[#fbcfe8]",
      link: "text-[#f9a8d4] hover:text-[#fbcfe8]",
      focus: "focus:border-[#f472b6]/70",
      close: "hover:bg-[#f472b6]/20 hover:text-[#fbcfe8]",
      favOn: "border-[#f472b6]/60 bg-[#f472b6]/10",
      favIcon: "text-[#f9a8d4]",
      idleText: "text-zinc-500",
      tip: "border-[#f9a8d4]/30 bg-zinc-950/92 backdrop-blur-xl",
      box: "border-[#f9a8d4]/20 bg-zinc-950/40",
      btn: "border-[#f9a8d4]/30 bg-[#f9a8d4]/10 hover:bg-[#f9a8d4]/20",
    },
    default: {
      ctlIdle: "border-zinc-800 bg-zinc-950 text-zinc-400 micoll-hover",
      ctlActive: "border-brand-500/50 bg-brand-500/15 text-brand-100",
      ctlActiveNeutral: "border-zinc-600 bg-zinc-800 text-zinc-100",
      field: "border-zinc-800 bg-zinc-950 text-zinc-100 focus:border-brand-500/60",
      idleIcon: "text-zinc-600",
      label: "text-zinc-500",
      hint: "text-zinc-500",
      chip: "border-brand-500/30 bg-brand-500/10 text-brand-200",
      chipHover: "hover:bg-brand-500/20",
      chipX: "text-brand-300/70 hover:bg-brand-500/20 hover:text-brand-100",
      link: "text-brand-300 hover:text-brand-200",
      focus: "focus:border-brand-500/60",
      close: "hover:bg-brand-500/15 hover:text-brand-200",
      favOn: "border-brand-500/50 bg-brand-500/10",
      favIcon: "text-brand-300",
      idleText: "text-zinc-500",
      tip: "border-zinc-700 bg-zinc-900",
      box: "border-zinc-800 bg-zinc-950/40",
      btn: "border-zinc-700 bg-zinc-800 micoll-hover",
    },
  } as const;
  const skin =
    accent === "iridescent"
      ? SKINS.iridescent
      : accent === "cyberpunk"
        ? SKINS.cyberpunk
        : accent === "sakura"
          ? SKINS.sakura
          : SKINS.default;

  const ctlIdle = skin.ctlIdle;
  const ctlActive = skin.ctlActive;
  const ctlActiveNeutral = skin.ctlActiveNeutral;
  const fieldCls = skin.field;
  const idleIcon = skin.idleIcon;
  const labelCls = cn("text-xs font-medium uppercase tracking-wide", skin.label);
  const hintCls = skin.hint;

  return (
    <motion.aside
      initial={{ x: 360, opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      exit={{ x: 360, opacity: 0 }}
      transition={{ type: "spring", stiffness: 380, damping: 36 }}
      className={cn(
        // z-20 so it stays under the header (z-30), will-change-transform to avoid flicker
        "fixed right-0 top-14 bottom-0 z-20 flex w-80 flex-col shadow-2xl shadow-black/40 will-change-transform",
        surface,
      )}
    >
      <div className={cn("flex items-center justify-between px-4 py-3", headerBar)}>
        <h2 className="text-sm font-semibold text-zinc-100">{t("Creator Details")}</h2>
        <button
          onClick={onClose}
          className={cn("rounded-lg p-1 text-zinc-400 transition-colors", skin.close)}
          title={t("Close")}
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-4">
        {/* identity */}
        <div className="flex items-center gap-3">
          <div className="h-16 w-14 shrink-0 overflow-hidden rounded-lg">
            <Cover path={artist.previewPath} seed={artist.name} label={artist.name} rounded="rounded-none" />
          </div>
          <div className="min-w-0">
            {/* editable name (also renames the folder) */}
            <input
              ref={nameRef}
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  e.currentTarget.blur();
                } else if (e.key === "Escape") {
                  setName(artist.name);
                  e.currentTarget.blur();
                }
              }}
              onBlur={() => void saveName()}
              disabled={!backed || savingName}
              spellCheck={false}
              title={t("Rename this creator — also renames the folder on disk")}
              className={cn(
                "w-full min-w-0 truncate rounded-md border border-transparent bg-transparent px-1 -mx-1 text-base font-semibold text-zinc-100 outline-none transition-colors hover:border-white/10 focus:bg-white/5",
                skin.focus,
              )}
            />
            {/* lighter text on iridescent */}
            <div className={cn("mt-0.5 px-1 text-xs", irid ? "text-white/80" : "text-zinc-500")}>
              {artist.platforms.length} platform(s)
            </div>
            <button
              onClick={() => {
                if (!backed) return;
                void api.setArtistPreview(artist.id, "").then(() => refresh());
              }}
              disabled={!backed}
              title={t("Use the first reward image as the cover again")}
              className={cn(
                "mt-1 inline-flex items-center gap-1 text-[11px] transition-colors disabled:opacity-40",
                skin.idleText,
                irid ? "hover:text-white" : "hover:text-zinc-300",
              )}
            >
              <RotateCcw className="h-3 w-3" />
              {t("Reset cover")}
            </button>
          </div>
        </div>

        {/* class */}
        <div className="mt-5">
          {/* help bubble is as wide as the row so it can't cause a horizontal scrollbar */}
          <div className="group relative mb-2 flex items-center gap-1.5">
            <span className={labelCls}>{t("Class")}</span>
            <HelpCircle className="h-3.5 w-3.5 cursor-help text-zinc-500 transition-colors group-hover:text-zinc-300" />
            <div
              className={cn(
                "pointer-events-none absolute inset-x-0 top-6 z-50 rounded-xl border p-3 opacity-0 shadow-2xl shadow-black/50 transition-opacity duration-150 group-hover:opacity-100",
                skin.tip,
              )}
            >
              <div className="mb-1.5 text-[11px] font-semibold text-zinc-200">
                {t("What the classes mean")}
              </div>
              <ul className="space-y-1">
                {artistTags().map(({ key, label, desc, color, Icon }) => (
                  <li key={key} className="flex items-center gap-1.5 text-[11px]">
                    <Icon className={`h-3.5 w-3.5 shrink-0 ${color}`} fill="currentColor" />
                    <span className="font-medium text-zinc-200">{t(label)}</span>
                    <span className="text-zinc-400">— {t(desc)}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            {artistTags().map(({ key, label, desc, color, Icon }) => {
              const active = artist.tag === key;
              return (
                <button
                  key={key}
                  onClick={() => void setTag(key)}
                  title={`${t(label)} — ${t(desc)}`}
                  disabled={!backed}
                  className={cn(
                    "flex h-10 w-10 items-center justify-center rounded-xl border transition-colors",
                    active ? ctlActive : ctlIdle,
                  )}
                >
                  <Icon
                    className={cn("h-5 w-5", active ? color : idleIcon)}
                    {...(active ? { fill: "currentColor" } : {})}
                  />
                </button>
              );
            })}
          </div>
        </div>

        {/* creator type pills */}
        <div className="mt-5">
          <div className={cn("mb-2", labelCls)}>{t("Type")}</div>
          <div className="flex flex-wrap items-center gap-1.5">
            {CREATOR_TYPES.map(({ key, label, color, Icon }) => {
              const active = parseKinds(artist.kind).includes(key);
              return (
                <button
                  key={key}
                  onClick={() => void setKind(key)}
                  title={label}
                  disabled={!backed}
                  className={cn(
                    "inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-1 text-[11px] transition-colors",
                    active ? ctlActive : ctlIdle,
                  )}
                >
                  <Icon className={cn("h-3.5 w-3.5", active ? color : idleIcon)} />
                  {label}
                </button>
              );
            })}
          </div>
        </div>

        {/* aliases (search finds them too) */}
        <div className="mt-5">
          <div className={cn("mb-2", labelCls)}>{t("Also known as")}</div>
          <div className="flex flex-wrap gap-1.5">
            {aliases.length === 0 ? (
              <span className={cn("text-[11px]", hintCls)}>
                {t("No aliases yet — add former or alternate names.")}
              </span>
            ) : (
              aliases.map((val) => (
                <span
                  key={val}
                  className={cn(
                    "inline-flex items-center gap-1 rounded-full border py-1 pl-1 pr-1 text-xs",
                    skin.chip,
                  )}
                >
                  {/* click to copy, X removes */}
                  <button
                    onClick={() => void copyAlias(val)}
                    title={t("Click to copy")}
                    className={cn(
                      "rounded-full px-1.5 py-0.5 transition-colors",
                      skin.chipHover,
                    )}
                  >
                    {val}
                  </button>
                  <button
                    onClick={() => void saveAliases(aliases.filter((x) => x !== val))}
                    disabled={!backed}
                    title={t("Remove alias")}
                    className={cn(
                      "rounded-full p-0.5 transition-colors",
                      skin.chipX,
                    )}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))
            )}
          </div>
          <input
            value={aliasInput}
            onChange={(e) => setAliasInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addAlias(aliasInput);
              }
            }}
            onBlur={() => addAlias(aliasInput)}
            placeholder={t("Add another name they go by…")}
            disabled={!backed}
            className={cn("mt-2 h-7 w-full min-w-0 rounded-md border px-2 text-xs outline-none", fieldCls)}
          />
        </div>

        {/* tags */}
        <div className="mt-5">
          <div className={cn("mb-2", labelCls)}>{t("Tags")}</div>
          <div className="flex flex-wrap gap-1.5">
            {tags.length === 0 ? (
              <span className={cn("text-[11px]", hintCls)}>{t("No tags yet.")}</span>
            ) : (
              tags.map((val) => (
                <span
                  key={val}
                  className={cn(
                    "inline-flex items-center gap-1 rounded-full border py-1 pl-2.5 pr-1 text-xs",
                    isNsfwTag(val) ? nsfwChipColors(accent) : skin.chip,
                  )}
                >
                  {val}
                  <button
                    onClick={() => void saveTags(tags.filter((x) => x !== val))}
                    disabled={!backed}
                    title={t("Remove tag")}
                    className={cn(
                      "rounded-full p-0.5 transition-colors",
                      skin.chipX,
                    )}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))
            )}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {["NSFW", "SFW"].map((val) => {
              const active = hasTag(val);
              return (
                <button
                  key={val}
                  onClick={() => toggleTag(val)}
                  disabled={!backed}
                  className={cn(
                    "rounded-full border px-2.5 py-1 text-xs transition-colors",
                    active ? ctlActiveNeutral : ctlIdle,
                  )}
                >
                  {val}
                </button>
              );
            })}
            <input
              value={tagInput}
              onChange={(e) => setTagInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addTag(tagInput);
                }
              }}
              placeholder={t("Add a tag (e.g. a character)…")}
              disabled={!backed}
              className={cn("h-7 min-w-0 flex-1 rounded-md border px-2 text-xs outline-none", fieldCls)}
            />
          </div>
        </div>

        {/* notes (saved on blur) */}
        <div className="mt-6">
          <div className="mb-2 flex items-center gap-1.5">
            <StickyNote className={cn("h-3.5 w-3.5", skin.idleText)} />
            <span className={labelCls}>{t("Notes")}</span>
          </div>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            onBlur={() => void saveNotes()}
            disabled={!backed}
            rows={4}
            placeholder={t("Private notes about this creator — pledge tier, what you collect, reminders…")}
            className={cn(
              "w-full resize-y rounded-lg border px-2.5 py-2 text-xs leading-relaxed outline-none transition-colors disabled:opacity-40",
              fieldCls,
            )}
          />
        </div>

        {/* wallpaper favourites */}
        <div className="mt-6">
          <button
            onClick={() => void toggleWallpaperFav()}
            disabled={!backed}
            className={cn(
              "flex w-full items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition-colors disabled:opacity-40",
              wallpaperFav ? skin.favOn : ctlIdle,
            )}
            title={t("Collect this creator’s best images into a “Fav. Wallpaper” folder")}
          >
            <MonitorPlay
              className={cn(
                "h-5 w-5 shrink-0",
                wallpaperFav ? skin.favIcon : skin.idleText,
              )}
            />
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium text-zinc-100">{t("Wallpaper favourites")}</span>
              <span
                className={cn(
                  "block text-[11px] leading-tight",
                  skin.idleText,
                )}
              >
                {t("Mark images as “Fav. wallpaper” — they collect into a folder you can set as a slideshow.")}
              </span>
            </span>
            <span
              // the track is a span, so data-on is used instead of aria-checked for styling
              data-on={wallpaperFav ? "" : undefined}
              className={cn(
                "micoll-switch relative h-5 w-9 shrink-0 rounded-full transition-colors",
                wallpaperFav ? toggleOnClass(accent) : irid ? "bg-white/25" : "bg-zinc-700",
              )}
            >
              <span
                className={`micoll-switch-knob absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${
                  wallpaperFav ? "left-[1.125rem]" : "left-0.5"
                }`}
              />
            </span>
          </button>
        </div>

        {/* social links */}
        <div className="mt-6">
          <div className="mb-2 flex items-center justify-between">
            <span className={labelCls}>{t("Links")}</span>
            <button
              // only local, an empty row isn't saved until it's filled in
              onClick={() => setLinks((prev) => [...prev, { label: "", url: "" }])}
              className={cn(
                "inline-flex items-center gap-1 text-xs",
                skin.link,
              )}
            >
              <Plus className="h-3.5 w-3.5" />
              Add
            </button>
          </div>

          {links.length === 0 ? (
            <p
              className={cn(
                "rounded-lg border border-dashed p-3 text-center text-xs",
                skin.box,
                skin.hint,
              )}
            >
              {t("No links yet. Add Patreon, Twitter, etc.")}
            </p>
          ) : (
            <div className="space-y-2">
              {links.map((l, i) => (
                <div
                  key={i}
                  className={cn(
                    "rounded-lg border p-2",
                    skin.box,
                  )}
                >
                  <div className="flex items-center gap-1.5">
                    <LinkIcon className="h-3.5 w-3.5 shrink-0 text-zinc-600" />
                    <input
                      value={l.label}
                      onChange={(e) => updateLink(i, { label: e.target.value })}
                      onBlur={saveLinksIfDirty}
                      onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
                      placeholder={t("Label (e.g. Patreon)")}
                      className={cn("h-7 min-w-0 flex-1 rounded-md border px-2 text-xs outline-none", fieldCls)}
                    />
                    <button
                      onClick={() => void persistLinks(links.filter((_, k) => k !== i))}
                      className="text-zinc-500 hover:text-rose-300"
                      title={t("Remove link")}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                  <div className="mt-1.5 flex items-center gap-1.5">
                    <input
                      value={l.url}
                      onChange={(e) => updateLink(i, { url: e.target.value })}
                      onBlur={saveLinksIfDirty}
                      onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
                      placeholder={t("https://…")}
                      className={cn("h-7 min-w-0 flex-1 rounded-md border px-2 text-xs outline-none", fieldCls)}
                    />
                    {/* save button (clicking away also saves) */}
                    <button
                      onMouseDown={(e) => e.preventDefault()} // keep focus so blur can't double-save
                      onClick={() => void persistLinks(links)}
                      disabled={!linkDirty(i)}
                      className={cn(
                        "inline-flex h-7 items-center gap-1 rounded-md border px-2 text-xs transition-colors disabled:opacity-40",
                        linkDirty(i) ? ctlActive : ctlIdle,
                      )}
                      title={linkDirty(i) ? "Save this link" : "Saved"}
                      aria-label={linkDirty(i) ? "Save this link" : "Saved"}
                    >
                      <Check className="h-3.5 w-3.5" />
                    </button>
                    <button
                      onClick={() => l.url && backed && void api.openUrl(l.url)}
                      disabled={!l.url || !backed}
                      className={cn(
                        "inline-flex h-7 items-center gap-1 rounded-md border px-2 text-xs text-zinc-200 transition-colors disabled:opacity-40",
                        skin.btn,
                      )}
                      title={t("Open in browser")}
                    >
                      <ExternalLink className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </motion.aside>
  );
}
