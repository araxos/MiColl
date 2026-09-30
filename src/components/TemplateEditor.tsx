import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { motion } from "framer-motion";
import { confirm, open } from "@tauri-apps/plugin-dialog";
import { Plus, Trash2, X, Save, Tag as TagIcon, ChevronDown, ChevronRight, Image as ImageIcon, ArrowDownUp, BadgeCheck } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { COVER_DROP_EVENT, type CoverDropDetail } from "@/components/DropZone";
import { useAccent } from "@/lib/theme";
import { cn } from "@/lib/utils";
import { useT, useTf, useTp, useMonthsShort } from "@/lib/i18n";
import { CREATOR_TYPES, creatorTypeDefs } from "@/lib/creatorTypes";
import { PLATFORMS } from "@/lib/platforms";
import { useData } from "@/store";
import * as api from "@/api/library";
import { type Artist, type ArtistLink, ownRewards } from "@/types";

/* ---- editor working model -------------------------------------------- */

let _uid = 0;
const uid = () => `e${++_uid}`;

interface EReward {
  title: string;
  category: string;
}
interface EPeriod {
  id: string;
  year: string; // "" = no year
  month: string; // "" = whole year / Misc
  span: string; // consecutive months covered (>=1)
  skipped: boolean; // artist break — no rewards
  verified: boolean; // verify just this period (needs the code unlocked)
  cover: string; // inline month cover (data URL), "" = none
  count: string;
  named: boolean;
  rewards: EReward[];
}
interface EPlatform {
  id: string;
  name: string;
  url: string;
  verified: boolean; // verify every period on this platform (code unlocked)
  periods: EPeriod[];
}


/** A new row. year is passed in so it continues from the last one (see lastYear). */
const blankPeriod = (year = String(new Date().getFullYear())): EPeriod => ({
  id: uid(),
  year,
  month: "",
  span: "1",
  skipped: false,
  verified: false,
  cover: "",
  count: "1",
  named: false,
  rewards: [],
});

const blankPlatform = (name = "Patreon", year?: string): EPlatform => ({
  id: uid(),
  name,
  url: "",
  verified: false,
  periods: [blankPeriod(year)],
});

/** Sort key for a period: newest first, undated at the bottom. */
const periodOrder = (pr: EPeriod): number => {
  if (!pr.year.trim()) return -Infinity;
  return Number(pr.year) * 100 + (pr.month.trim() ? Number(pr.month) : 0);
};
const sortPeriods = (arr: EPeriod[]): EPeriod[] =>
  [...arr].sort((a, b) => periodOrder(b) - periodOrder(a));

/** Short label for a period row. */
const periodChip = (pr: EPeriod, t: (s: string) => string): string => {
  if (pr.skipped) return t("Break");
  if (!pr.year.trim()) return t("Any");
  if (!pr.month.trim()) return pr.year;
  const base = `${pr.year}-${String(Number(pr.month)).padStart(2, "0")}`;
  return Number(pr.span) > 1 ? `${base} ×${pr.span}` : base;
};

/** Year group of a period. Undated rows get their own group. */
const yearKey = (pr: EPeriod): string => (pr.year.trim() ? pr.year.trim() : "—");

/** Split a platform's periods into year groups (the rows keep their order). */
function groupByYear(periods: EPeriod[]): { year: string; periods: EPeriod[] }[] {
  const out: { year: string; periods: EPeriod[] }[] = [];
  const at = new Map<string, { year: string; periods: EPeriod[] }>();
  for (const pr of periods) {
    const k = yearKey(pr);
    let g = at.get(k);
    if (!g) {
      g = { year: k, periods: [] };
      at.set(k, g);
      out.push(g);
    }
    g.periods.push(pr);
  }
  return out;
}

/** Build the editor model from an indexed artist (fills in counts). */
function fromArtist(a: Artist): {
  name: string;
  kind: string | null;
  links: ArtistLink[];
  platforms: EPlatform[];
} {
  return {
    name: a.name,
    kind: a.kind ?? null,
    links: a.links?.length ? a.links.map((l) => ({ ...l })) : [],
    platforms: a.platforms.map((p) => ({
      id: uid(),
      name: p.name,
      url: a.links?.find((l) => l.label.toLowerCase() === p.name.toLowerCase())?.url ?? "",
      verified: false,
      periods: sortPeriods(
        p.months.map((m) => ({
          id: uid(),
          year: m.year != null ? String(m.year) : "",
          month: m.month != null ? String(m.month) : "",
          span: String(m.span ?? 1),
          skipped: !!m.skipped,
          verified: false,
          cover: "",
          // only the creator's own rewards (no borrowed collabs)
          count: String(ownRewards(m).length),
          named: false,
          rewards: [],
        })),
      ),
    })),
  };
}

/* ---- component ------------------------------------------------------- */

/** Unwrap a signed file to its template JSON, plain JSON passes through. */
function unwrapSigned(json: string): string {
  try {
    const o = JSON.parse(json) as Record<string, unknown>;
    if (o && typeof o === "object" && "micollSigned" in o && typeof o.payload === "string") {
      const bin = atob(o.payload);
      return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
    }
  } catch {
    /* let the normal parser handle the error */
  }
  return json;
}

/** Build the editor model from an existing template's JSON. */
function fromRaw(json: string) {
  const o = JSON.parse(unwrapSigned(json)) as Record<string, unknown>;
  const a = (o.artist ?? {}) as Record<string, unknown>;
  const rawPlatforms = (o.platforms ?? []) as Record<string, unknown>[];
  const platforms: EPlatform[] = rawPlatforms.map((p) => ({
    id: uid(),
    name: typeof p.name === "string" ? p.name : "",
    url: typeof p.url === "string" ? p.url : "",
    verified: !!p.verified,
    periods: sortPeriods(((p.periods ?? []) as Record<string, unknown>[]).map((pr) => {
      const rewards = Array.isArray(pr.rewards) ? (pr.rewards as Record<string, unknown>[]) : [];
      const named = rewards.length > 0;
      return {
        id: uid(),
        year: pr.year != null ? String(pr.year) : "",
        month: pr.month != null ? String(pr.month) : "",
        span: String((pr.span as number) ?? 1),
        skipped: !!pr.skipped,
        verified: !!pr.verified,
        cover: typeof pr.cover === "string" ? pr.cover : "",
        count: String((pr.count as number) ?? (named ? rewards.length : 1)),
        named,
        rewards: named
          ? rewards.map((r) => ({
              title: typeof r.title === "string" ? r.title : "",
              category: typeof r.category === "string" ? r.category : "",
            }))
          : [],
      };
    })),
  }));
  const links = Array.isArray(a.links)
    ? (a.links as Record<string, unknown>[]).map((l) => ({
        label: typeof l.label === "string" ? l.label : "",
        url: typeof l.url === "string" ? l.url : "",
      }))
    : [];
  return {
    name: typeof a.name === "string" ? a.name : "",
    label: typeof o.label === "string" ? o.label : "",
    kind: typeof a.type === "string" ? a.type : null,
    links,
    platforms: platforms.length ? platforms : [blankPlatform()],
    masterVerified: !!o.verified,
  };
}

export function TemplateEditor({
  onClose,
  onSaved,
  initial,
}: {
  onClose: () => void;
  onSaved: (msg: string) => void | Promise<void>;
  /**
   * If set, the editor opens with this template.
   * fileName lets a rename replace the file instead of making a copy.
   */
  initial?: { raw: string; fileName?: string };
}) {
  const t = useT();
  const tf = useTf();
  const tp = useTp();
  const months = useMonthsShort();
  const { artists } = useData();
  const [sourceId, setSourceId] = useState("");
  const [name, setName] = useState("");
  const [label, setLabel] = useState("");
  const [kind, setKind] = useState<string | null>(null);
  const [links, setLinks] = useState<ArtistLink[]>([]);
  const [platforms, setPlatforms] = useState<EPlatform[]>([blankPlatform()]);
  const [canSign, setCanSign] = useState(false);
  const [masterVerified, setMasterVerified] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // year for new periods: the last typed one (updated by the year inputs)
  const [lastYear, setLastYear] = useState(String(new Date().getFullYear()));
  // collapsed year groups (platformId:year), only view state
  const [folded, setFolded] = useState<Set<string>>(() => new Set());
  const toggleFold = (key: string) =>
    setFolded((prev) => {
      const next = new Set(prev);
      if (!next.delete(key)) next.add(key);
      return next;
    });

  // verified mode only where the signing key is installed (owner's PC),
  // saving then signs the file. Everyone else makes personal logs.
  useEffect(() => {
    api.canSign().then(setCanSign).catch(() => setCanSign(false));
  }, []);
  const unlocked = canSign;

  // keep the latest onClose without re-running the history effect
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // lock the page behind the editor (<main> scrolls, not <body>)
  useEffect(() => {
    const scroller = document.querySelector<HTMLElement>("main");
    const prevMain = scroller?.style.overflow ?? "";
    const prevBody = document.body.style.overflow;
    if (scroller) scroller.style.overflow = "hidden";
    document.body.style.overflow = "hidden";
    return () => {
      if (scroller) scroller.style.overflow = prevMain;
      document.body.style.overflow = prevBody;
    };
  }, []);

  // mouse/keyboard Back closes the editor first (same trick as the viewer)
  const hasMarker = () =>
    !!(window.history.state && (window.history.state as { micollTemplate?: boolean }).micollTemplate);
  // closing with a button removes our history marker
  const requestClose = () => {
    if (hasMarker()) window.history.back();
    else onCloseRef.current();
  };
  useEffect(() => {
    if (!hasMarker()) window.history.pushState({ micollTemplate: true }, "");
    // only close when our marker is gone
    const onPop = () => {
      if (!hasMarker()) onCloseRef.current();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && hasMarker()) window.history.back();
    };
    window.addEventListener("popstate", onPop);
    window.addEventListener("keydown", onKey);
    // cleanup must not touch history (StrictMode mounts twice, see the hasMarker check)
    return () => {
      window.removeEventListener("popstate", onPop);
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  // premium themes get their dialog surface, standard ones the dark panel
  const accent = useAccent();
  const panelClass =
    accent === "cyberpunk"
      ? "rounded-none border border-[#fcee0a]/70 bg-zinc-950/95 ring-1 ring-inset ring-[#00e5ff]/15 shadow-[0_0_26px_rgba(252,238,10,0.18)]"
      : accent === "iridescent"
        ? "iri-menu rounded-2xl border border-white/15 bg-zinc-900/80 ring-1 ring-inset ring-white/10 shadow-2xl shadow-black/40 backdrop-blur-2xl"
        : accent === "sakura"
          ? "sak-card rounded-2xl shadow-2xl"
          : "rounded-2xl border border-zinc-800 bg-zinc-900 shadow-2xl";
  // divider color (zinc-800 disappears on premium)
  const divider =
    accent === "cyberpunk"
      ? "border-[#fcee0a]/25"
      : accent === "iridescent"
        ? "border-white/15"
        : accent === "sakura"
          ? "border-[#f9a8d4]/25"
          : "border-zinc-800";

  // several creator types possible, kind is a comma separated string
  const activeKindKeys = creatorTypeDefs(kind).map((d) => d.key);
  const toggleKind = (key: string) => {
    const next = activeKindKeys.includes(key)
      ? activeKindKeys.filter((k) => k !== key)
      : [...activeKindKeys, key];
    setKind(next.length ? next.join(", ") : null);
  };

  // editing a template: fill the model from its JSON
  useEffect(() => {
    if (!initial) return;
    try {
      const m = fromRaw(initial.raw);
      setName(m.name);
      setLabel(m.label);
      setKind(m.kind);
      setLinks(m.links);
      setPlatforms(m.platforms);
      // continue from the template's last year
      const newest = m.platforms.flatMap((p) => p.periods).find((pr) => pr.year.trim());
      if (newest) setLastYear(newest.year.trim());
      // verified state is kept, but only survives saving where it can be re-signed
      setMasterVerified(m.masterVerified);
    } catch {
      /* ignore broken JSON */
    }
  }, [initial]);

  const today = useMemo(() => new Date().toISOString().slice(0, 10), []);

  const loadFrom = (id: string) => {
    setSourceId(id);
    if (!id) return;
    const a = artists.find((x) => x.id === id);
    if (!a) return;
    const m = fromArtist(a);
    setName(m.name);
    setKind(m.kind);
    setLinks(m.links);
    setPlatforms(m.platforms.length ? m.platforms : [blankPlatform()]);
    const newest = m.platforms.flatMap((p) => p.periods).find((pr) => pr.year.trim());
    if (newest) setLastYear(newest.year.trim());
  };

  /* --- changes --- */
  const patchPlatform = (pid: string, patch: Partial<EPlatform>) =>
    setPlatforms((ps) => ps.map((p) => (p.id === pid ? { ...p, ...patch } : p)));
  const patchPeriod = (pid: string, prid: string, patch: Partial<EPeriod>) =>
    setPlatforms((ps) =>
      ps.map((p) =>
        p.id !== pid
          ? p
          : { ...p, periods: p.periods.map((pr) => (pr.id === prid ? { ...pr, ...patch } : pr)) },
      ),
    );
  // sort periods newest first (manual, so rows don't jump while typing)
  const sortPlatformPeriods = (pid: string) =>
    setPlatforms((ps) => ps.map((p) => (p.id === pid ? { ...p, periods: sortPeriods(p.periods) } : p)));

  // pick a month cover -> saved inline (data URL)
  const pickCover = async (pid: string, prid: string) => {
    const picked = await open({
      multiple: false,
      title: t("Choose a cover image for this month"),
      filters: [{ name: "Image", extensions: ["png", "jpg", "jpeg", "webp", "gif"] }],
    });
    if (typeof picked !== "string") return;
    void setCoverFromPath(pid, prid, picked);
  };

  const setCoverFromPath = async (pid: string, prid: string, path: string) => {
    try {
      // downscaled, full images made templates huge
      const dataUrl = await api.getThumbnail(path, api.TEMPLATE_COVER_PX);
      patchPeriod(pid, prid, { cover: dataUrl });
    } catch {
      /* ignore unreadable image */
    }
  };

  // drop a picture on a cover slot. DropZone re-emits drops on data-drop-cover elements
  // with the platformId:periodId key
  useEffect(() => {
    const onCoverDrop = (e: Event) => {
      const { key, path } = (e as CustomEvent<CoverDropDetail>).detail ?? {};
      if (!key || !path) return;
      const [pid, prid] = key.split(":");
      if (!pid || !prid) return;
      void setCoverFromPath(pid, prid, path);
    };
    window.addEventListener(COVER_DROP_EVENT, onCoverDrop);
    return () => window.removeEventListener(COVER_DROP_EVENT, onCoverDrop);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* --- save --- */
  const buildJson = (): string => {
    const verified = unlocked && masterVerified;
    const obj: Record<string, unknown> = {
      micollTemplate: 1,
      ...(label.trim() ? { label: label.trim() } : {}),
      verified,
      artist: {
        name: name.trim(),
        ...(kind ? { type: kind } : {}),
        links: links
          .filter((l) => l.url.trim())
          .map((l) => ({ label: l.label.trim(), url: l.url.trim() })),
      },
      platforms: platforms
        .filter((p) => p.name.trim())
        .map((p) => ({
          name: p.name.trim(),
          ...(p.url.trim() ? { url: p.url.trim() } : {}),
          ...(unlocked && p.verified ? { verified: true } : {}),
          periods: p.periods.map((pr) => {
            const o: Record<string, unknown> = {};
            if (pr.year.trim()) o.year = Number(pr.year);
            if (pr.month.trim()) o.month = Number(pr.month);
            const span = Math.max(1, Number(pr.span) || 1);
            if (span > 1) o.span = span;
            if (unlocked && pr.verified) o.verified = true;
            if (pr.cover) o.cover = pr.cover;
            if (pr.skipped) {
              o.skipped = true; // a break — no rewards
            } else if (pr.named && pr.rewards.some((r) => r.title.trim())) {
              o.rewards = pr.rewards
                .filter((r) => r.title.trim())
                .map((r) => ({
                  title: r.title.trim(),
                  ...(r.category.trim() ? { category: r.category.trim() } : {}),
                }));
            } else {
              o.count = Math.max(0, Number(pr.count) || 0);
            }
            return o;
          }),
        })),
      meta: { version: "1.0.0", author: "self", updated: today },
    };
    return JSON.stringify(obj, null, 2);
  };

  const save = async () => {
    if (!name.trim()) {
      setErr(t("Please enter a creator name."));
      return;
    }
    // only verified templates need a signature, personal logs stay plain JSON
    const wantsVerified =
      unlocked &&
      (masterVerified || platforms.some((p) => p.verified || p.periods.some((pr) => pr.verified)));
    if (wantsVerified) {
      const covers = platforms.reduce(
        (n, p) => n + p.periods.filter((pr) => pr.cover).length,
        0,
      );
      if (covers > 0) {
        // verified templates get shared, so no inline covers (paywalled artwork)
        const ok = await confirm(
          tf(
            "This verified template embeds {covers}, which will be distributed with the file.",
            { covers: tp("{n} inline cover images", covers) },
          ) +
            "\n\n" +
            t("Use only public/promo images as covers — never artwork from paywalled rewards.") +
            "\n\n" +
            t("Sign and save anyway?"),
          { title: t("Covers ship with the template"), kind: "warning" },
        );
        if (!ok) return;
      }
    }
    setBusy(true);
    setErr(null);
    try {
      let json = buildJson();
      if (wantsVerified) json = await api.signTemplate(json);
      const saved = await api.importTemplate(json, initial?.fileName);
      // remove our history marker before the panel closes us
      if (hasMarker()) window.history.back();
      await onSaved(
        tf(
          wantsVerified
            ? "Saved verified (signed) template for “{artist}” ({rewards})."
            : "Saved personal template for “{artist}” ({rewards}).",
          { artist: saved.artist, rewards: tp("{n} rewards", saved.rewards) },
        ),
      );
    } catch (e) {
      setErr(`${e}`);
    } finally {
      setBusy(false);
    }
  };

  return createPortal(
    // data-drop-block: no imports here, only the cover slots accept drops
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
      data-drop-block=""
    >
      {/* drag strip, the overlay covers the title bar */}
      <div data-tauri-drag-region className="absolute inset-x-0 top-0 h-14" />
      <motion.div
        initial={{ opacity: 0, y: 16, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        className={cn(
          "flex max-h-[90vh] w-[44rem] max-w-full flex-col overflow-hidden",
          panelClass,
        )}
      >
        {/* header */}
        <div className={cn("flex items-center justify-between border-b px-5 py-3.5", divider)}>
          <div>
            <h2 className="text-base font-semibold text-zinc-100">
              {initial ? t("Edit template") : t("Create template")}
            </h2>
            <p className="text-xs text-zinc-500">
              {unlocked
                ? t("Verified mode — marked periods get the blue check.")
                : t("Personal templates aren’t “verified”, but still track owned / released.")}
            </p>
          </div>
          <button onClick={requestClose} className="text-zinc-500 hover:text-zinc-300" title={t("Close")}>
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* body */}
        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-4">
          {/* start from */}
          <div className="rounded-xl border border-zinc-800 bg-zinc-950/40 p-3">
            <label className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-zinc-500">
              {t("Start from")}
            </label>
            <div className="relative">
              <select
                value={sourceId}
                onChange={(e) => loadFrom(e.target.value)}
                className="h-9 w-full appearance-none rounded-lg border border-zinc-800 bg-zinc-950 pl-3 pr-8 text-sm text-zinc-100 outline-none focus:border-brand-500/60"
              >
                <option value="">{t("Blank template")}</option>
                {artists.map((a) => (
                  <option key={a.id} value={a.id}>
                    {tf("{name} — auto-fill counts from disk", { name: a.name })}
                  </option>
                ))}
              </select>
              <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500" />
            </div>
          </div>

          {/* artist */}
          <div className="space-y-3">
            <div>
              <label className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-zinc-500">
                {t("Creator name")}
              </label>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t("e.g. Bonnie")}
                className="h-9 w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 text-sm text-zinc-100 outline-none focus:border-brand-500/60"
              />
            </div>

            {/* label + signing status (verified only with the signing key) */}
            <div className={`grid gap-3 ${unlocked ? "grid-cols-2" : "grid-cols-1"}`}>
              <div>
                <label className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-zinc-500">
                  {t("Label")}{" "}
                  <span className="normal-case text-zinc-600">{t("(optional)")}</span>
                </label>
                <input
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  placeholder={t("e.g. Patreon 2025")}
                  className="h-9 w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 text-sm text-zinc-100 outline-none focus:border-brand-500/60"
                />
              </div>
              {unlocked && (
                <div>
                  <label className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-zinc-500">
                    {t("Signing")}
                  </label>
                  <div
                    className="flex h-9 items-center gap-2 rounded-lg border border-brand-500/60 bg-zinc-950 px-3 text-sm text-brand-200 ring-1 ring-brand-500/40"
                    title={t(
                      "The private signing key on this machine matches this build — verified saves are wrapped in a signed envelope.",
                    )}
                  >
                    <BadgeCheck className="h-4 w-4 shrink-0" />
                    {t("Signing key active")}
                  </div>
                </div>
              )}
            </div>

            {unlocked && (
              <label className="flex items-center gap-2 rounded-lg border border-brand-500/40 bg-brand-500/10 px-3 py-2 text-sm text-brand-100">
                <input
                  type="checkbox"
                  checked={masterVerified}
                  onChange={(e) => setMasterVerified(e.target.checked)}
                  className="h-4 w-4 accent-brand-500"
                />
                {t("Verified template — mark every period below as verified")}
                <span className="ml-auto text-xs text-brand-200/70">
                  {t("or tick individual platforms / months")}
                </span>
              </label>
            )}

            <div>
              <label className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-zinc-500">
                {t("Type")}{" "}
                <span className="normal-case text-zinc-600">{t("(choose one or more)")}</span>
              </label>
              <div className="flex flex-wrap gap-1.5">
                {CREATOR_TYPES.map(({ key, label, color, Icon }) => {
                  const active = activeKindKeys.includes(key);
                  return (
                    <button
                      key={key}
                      onClick={() => toggleKind(key)}
                      className={`inline-flex items-center gap-1.5 rounded-xl border px-2.5 py-1.5 text-xs transition-colors ${
                        active
                          ? "border-zinc-600 bg-zinc-800 text-zinc-100"
                          : "border-zinc-800 bg-zinc-950 text-zinc-400 micoll-hover"
                      }`}
                    >
                      <Icon className={`h-4 w-4 ${active ? color : "text-zinc-600"}`} />
                      {t(label)}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* links */}
            <div>
              <div className="mb-1.5 flex items-center justify-between">
                <label className="text-xs font-medium uppercase tracking-wide text-zinc-500">
                  {t("Links")}
                </label>
                <button
                  onClick={() => setLinks((l) => [...l, { label: "", url: "" }])}
                  className="inline-flex items-center gap-1 text-xs text-brand-300 hover:text-brand-200"
                >
                  <Plus className="h-3.5 w-3.5" />
                  {t("Add link")}
                </button>
              </div>
              {links.length === 0 ? (
                <p className="text-xs text-zinc-600">{t("No links yet.")}</p>
              ) : (
                <div className="space-y-1.5">
                  {links.map((l, i) => (
                    <div key={i} className="flex items-center gap-1.5">
                      <input
                        value={l.label}
                        onChange={(e) =>
                          setLinks((ls) => ls.map((x, k) => (k === i ? { ...x, label: e.target.value } : x)))
                        }
                        placeholder={t("Label")}
                        className="h-8 w-28 shrink-0 rounded-md border border-zinc-800 bg-zinc-950 px-2 text-xs text-zinc-100 outline-none focus:border-brand-500/60"
                      />
                      <input
                        value={l.url}
                        onChange={(e) =>
                          setLinks((ls) => ls.map((x, k) => (k === i ? { ...x, url: e.target.value } : x)))
                        }
                        placeholder={t("https://…")}
                        className="h-8 min-w-0 flex-1 rounded-md border border-zinc-800 bg-zinc-950 px-2 text-xs text-zinc-300 outline-none focus:border-brand-500/60"
                      />
                      <button
                        onClick={() => setLinks((ls) => ls.filter((_, k) => k !== i))}
                        className="text-zinc-500 hover:text-rose-300"
                        title={t("Remove link")}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* platforms */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium uppercase tracking-wide text-zinc-500">
                {t("Platforms & releases")}
              </span>
              <button
                onClick={() => setPlatforms((ps) => [...ps, blankPlatform("", lastYear)])}
                className="inline-flex items-center gap-1 text-xs text-brand-300 hover:text-brand-200"
              >
                <Plus className="h-3.5 w-3.5" />
                {t("Add platform")}
              </button>
            </div>

            {platforms.map((p) => (
              <div key={p.id} className="rounded-xl border border-zinc-800 bg-zinc-950/40 p-3">
                <div className="flex items-center gap-2">
                  <input
                    list="micoll-platforms"
                    value={p.name}
                    onChange={(e) => patchPlatform(p.id, { name: e.target.value })}
                    placeholder={t("Platform")}
                    className="h-8 w-36 rounded-md border border-zinc-800 bg-zinc-950 px-2 text-sm text-zinc-100 outline-none focus:border-brand-500/60"
                  />
                  <input
                    value={p.url}
                    onChange={(e) => patchPlatform(p.id, { url: e.target.value })}
                    placeholder={t("Platform URL (optional)")}
                    className="h-8 min-w-0 flex-1 rounded-md border border-zinc-800 bg-zinc-950 px-2 text-xs text-zinc-300 outline-none focus:border-brand-500/60"
                  />
                  {unlocked && !masterVerified && (
                    <label
                      className="flex shrink-0 items-center gap-1 text-[11px] text-brand-200"
                      title={t("Verify every period on this platform")}
                    >
                      <input
                        type="checkbox"
                        checked={p.verified}
                        onChange={(e) => patchPlatform(p.id, { verified: e.target.checked })}
                        className="h-3.5 w-3.5 accent-brand-500"
                      />
                      {t("verify")}
                    </label>
                  )}
                  <button
                    onClick={() => setPlatforms((ps) => ps.filter((x) => x.id !== p.id))}
                    className="text-zinc-500 hover:text-rose-300"
                    title={t("Remove platform")}
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>

                {/* periods */}
                <div className="mt-2.5 space-y-2.5">
                  <div className="flex items-center justify-between px-0.5">
                    <span className="text-[10px] font-medium uppercase tracking-wide text-zinc-600">
                      {t("Periods — newest first · year · month · how many rewards")}
                    </span>
                    <button
                      onClick={() =>
                        patchPlatform(p.id, { periods: [blankPeriod(lastYear), ...p.periods] })
                      }
                      className="inline-flex items-center gap-1 rounded-md border border-brand-500/40 bg-brand-500/10 px-2 py-1 text-[11px] text-brand-200 hover:bg-brand-500/20"
                      title={t("Add a new period at the top")}
                    >
                      <Plus className="h-3 w-3" />
                      {t("Add period")}
                    </button>
                  </div>
                  {/* periods folded by year (same list, rows keep their order) */}
                  {groupByYear(p.periods).map((g) => {
                    const gkey = `${p.id}:${g.year}`;
                    // not "open", that's the file dialog import
                    const expanded = !folded.has(gkey);
                    const yearLabel = g.year === "—" ? t("Undated") : g.year;
                    const rewardCount = g.periods.reduce(
                      (n, pr) =>
                        n +
                        (pr.skipped ? 0 : pr.named ? pr.rewards.length : Math.max(0, Number(pr.count) || 0)),
                      0,
                    );
                    return (
                      <div key={gkey} className="space-y-2.5">
                        <div className="flex items-center gap-2">
                          <button
                            onClick={() => toggleFold(gkey)}
                            title={
                              expanded
                                ? tf("Collapse {year}", { year: yearLabel })
                                : tf("Expand {year}", { year: yearLabel })
                            }
                            className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-1 py-0.5 text-left text-xs text-zinc-400 micoll-hover"
                          >
                            {expanded ? (
                              <ChevronDown className="h-3.5 w-3.5 shrink-0" />
                            ) : (
                              <ChevronRight className="h-3.5 w-3.5 shrink-0" />
                            )}
                            <span className="font-semibold text-zinc-200">{yearLabel}</span>
                            <span className="text-zinc-600">·</span>
                            <span>{tp("{n} periods", g.periods.length)}</span>
                            <span className="text-zinc-600">·</span>
                            <span>{tp("{n} rewards", rewardCount)}</span>
                          </button>
                          <button
                            onClick={() =>
                              patchPlatform(p.id, {
                                periods: [
                                  ...p.periods.slice(0, p.periods.indexOf(g.periods[0])),
                                  blankPeriod(g.year === "—" ? "" : g.year),
                                  ...p.periods.slice(p.periods.indexOf(g.periods[0])),
                                ],
                              })
                            }
                            title={tf("Add a period to {year}", { year: yearLabel })}
                            className="shrink-0 rounded-md p-1 text-zinc-500 micoll-hover hover:text-brand-200"
                          >
                            <Plus className="h-3.5 w-3.5" />
                          </button>
                        </div>
                        {expanded &&
                          g.periods.map((pr) => (
                    <div key={pr.id} className="rounded-lg border border-zinc-700 bg-zinc-900 p-2.5 shadow-sm ring-1 ring-black/20">
                      <div className="flex flex-wrap items-center gap-2">
                        {/* period label */}
                        <span
                          className={`inline-flex min-w-[3.5rem] shrink-0 items-center justify-center rounded-md px-1.5 py-1 text-[11px] font-semibold ${
                            pr.skipped ? "bg-zinc-800 text-zinc-500" : "bg-brand-500/15 text-brand-200"
                          }`}
                          title={t("This period")}
                        >
                          {periodChip(pr, t)}
                        </span>
                        <input
                          value={pr.year}
                          onChange={(e) => {
                            const year = e.target.value.replace(/[^0-9]/g, "");
                            patchPeriod(p.id, pr.id, { year });
                            // only remember a full year (not a half typed "20")
                            if (year.length === 4) setLastYear(year);
                          }}
                          placeholder={t("Year")}
                          className="h-8 w-16 rounded-md border border-zinc-800 bg-zinc-950 px-2 text-xs text-zinc-100 outline-none focus:border-brand-500/60"
                        />
                        <select
                          value={pr.month}
                          onChange={(e) => patchPeriod(p.id, pr.id, { month: e.target.value })}
                          className="h-8 rounded-md border border-zinc-800 bg-zinc-950 px-2 text-xs text-zinc-100 outline-none focus:border-brand-500/60"
                        >
                          <option value="">{"—"}</option>
                          {months.map((mn, idx) => (
                            <option key={mn} value={String(idx + 1)}>
                              {mn}
                            </option>
                          ))}
                        </select>
                        {/* span (several months) */}
                        <label
                          className="flex items-center gap-1 text-xs text-zinc-400"
                          title={t("How many consecutive months this release covers")}
                        >
                          ×
                          <input
                            value={pr.span}
                            onChange={(e) =>
                              patchPeriod(p.id, pr.id, { span: e.target.value.replace(/[^0-9]/g, "") })
                            }
                            className="h-8 w-12 rounded-md border border-zinc-800 bg-zinc-950 px-2 text-center text-xs text-zinc-100 outline-none focus:border-brand-500/60"
                          />
                          {t("mo")}
                        </label>

                        {/* break (skipped month) */}
                        <label
                          className="flex items-center gap-1 text-xs text-zinc-400"
                          title={t("The creator skipped this month (a break)")}
                        >
                          <input
                            type="checkbox"
                            checked={pr.skipped}
                            onChange={(e) => patchPeriod(p.id, pr.id, { skipped: e.target.checked })}
                            className="h-3.5 w-3.5 accent-brand-500"
                          />
                          {t("break")}
                        </label>

                        {/* month cover (saved inline) */}
                        {pr.cover ? (
                          <span
                            className="relative inline-flex h-8 w-8 shrink-0 overflow-hidden rounded-md border border-zinc-700"
                            data-drop-cover={`${p.id}:${pr.id}`}
                            data-drop-cover-label={periodChip(pr, t)}
                            title={t("Drop an image here to replace this cover")}
                          >
                            <img src={pr.cover} alt="cover" className="h-full w-full object-cover" />
                            <button
                              onClick={() => patchPeriod(p.id, pr.id, { cover: "" })}
                              className="absolute inset-0 flex items-center justify-center bg-black/55 opacity-0 transition-opacity hover:opacity-100"
                              title={t("Remove cover")}
                            >
                              <X className="h-3.5 w-3.5 text-white" />
                            </button>
                          </span>
                        ) : (
                          <button
                            onClick={() => void pickCover(p.id, pr.id)}
                            data-drop-cover={`${p.id}:${pr.id}`}
                            data-drop-cover-label={periodChip(pr, t)}
                            title={t(
                              "Set a cover image for this month — click to browse, or drop an image straight onto it",
                            )}
                            className="inline-flex items-center gap-1 rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1 text-[11px] text-zinc-400 micoll-hover"
                          >
                            <ImageIcon className="h-3 w-3" />
                            {t("Cover")}
                          </button>
                        )}

                        {!pr.skipped &&
                          (!pr.named ? (
                            <label className="flex items-center gap-1 text-xs text-zinc-400">
                              <input
                                value={pr.count}
                                onChange={(e) =>
                                  patchPeriod(p.id, pr.id, { count: e.target.value.replace(/[^0-9]/g, "") })
                                }
                                className="h-8 w-14 rounded-md border border-zinc-800 bg-zinc-950 px-2 text-center text-xs text-zinc-100 outline-none focus:border-brand-500/60"
                              />
                              {t("rewards")}
                            </label>
                          ) : (
                            <span className="text-xs text-zinc-500">
                              {tf("{n} named", { n: pr.rewards.length })}
                            </span>
                          ))}
                        {!pr.skipped && (
                          <button
                            onClick={() =>
                              patchPeriod(p.id, pr.id, {
                                named: !pr.named,
                                rewards:
                                  !pr.named && pr.rewards.length === 0
                                    ? Array.from({ length: Math.max(1, Number(pr.count) || 1) }, () => ({
                                        title: "",
                                        category: "",
                                      }))
                                    : pr.rewards,
                              })
                            }
                            title={t("Name the individual rewards (optional)")}
                            className="inline-flex items-center gap-1 rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1 text-[11px] text-zinc-400 micoll-hover"
                          >
                            <TagIcon className="h-3 w-3" />
                            {pr.named ? t("Use count") : t("Name rewards")}
                          </button>
                        )}
                        {unlocked && !masterVerified && !platforms.find((x) => x.id === p.id)?.verified && (
                          <label
                            className="flex items-center gap-1 text-[11px] text-brand-200"
                            title={t("Verify just this month")}
                          >
                            <input
                              type="checkbox"
                              checked={pr.verified}
                              onChange={(e) => patchPeriod(p.id, pr.id, { verified: e.target.checked })}
                              className="h-3.5 w-3.5 accent-brand-500"
                            />
                            {t("verify")}
                          </label>
                        )}
                        <button
                          onClick={() =>
                            setPlatforms((ps) =>
                              ps.map((x) =>
                                x.id !== p.id
                                  ? x
                                  : { ...x, periods: x.periods.filter((q) => q.id !== pr.id) },
                              ),
                            )
                          }
                          className="ml-auto text-zinc-500 hover:text-rose-300"
                          title={t("Remove period")}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>

                      {/* named rewards (optional) */}
                      {!pr.skipped && pr.named && (
                        <div className="mt-2 space-y-1.5 border-t border-zinc-800/70 pt-2">
                          {pr.rewards.map((r, ri) => (
                            <div key={ri} className="flex items-center gap-1.5">
                              <input
                                value={r.title}
                                onChange={(e) =>
                                  patchPeriod(p.id, pr.id, {
                                    rewards: pr.rewards.map((x, k) =>
                                      k === ri ? { ...x, title: e.target.value } : x,
                                    ),
                                  })
                                }
                                placeholder={tf("Reward {n} title", { n: ri + 1 })}
                                className="h-7 min-w-0 flex-1 rounded-md border border-zinc-800 bg-zinc-950 px-2 text-xs text-zinc-100 outline-none focus:border-brand-500/60"
                              />
                              <input
                                value={r.category}
                                onChange={(e) =>
                                  patchPeriod(p.id, pr.id, {
                                    rewards: pr.rewards.map((x, k) =>
                                      k === ri ? { ...x, category: e.target.value } : x,
                                    ),
                                  })
                                }
                                placeholder={t("NSFW")}
                                className="h-7 w-24 rounded-md border border-zinc-800 bg-zinc-950 px-2 text-xs text-zinc-300 outline-none focus:border-brand-500/60"
                              />
                              <button
                                onClick={() =>
                                  patchPeriod(p.id, pr.id, {
                                    rewards: pr.rewards.filter((_, k) => k !== ri),
                                  })
                                }
                                className="text-zinc-500 hover:text-rose-300"
                                title={t("Remove reward")}
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                            </div>
                          ))}
                          <button
                            onClick={() =>
                              patchPeriod(p.id, pr.id, {
                                rewards: [...pr.rewards, { title: "", category: "" }],
                              })
                            }
                            className="inline-flex items-center gap-1 text-[11px] text-brand-300 hover:text-brand-200"
                          >
                            <Plus className="h-3 w-3" />
                            {t("Add reward")}
                          </button>
                        </div>
                      )}
                    </div>
                          ))}
                      </div>
                    );
                  })}
                  <div className="flex items-center gap-3">
                    <button
                      onClick={() =>
                        patchPlatform(p.id, { periods: [...p.periods, blankPeriod(lastYear)] })
                      }
                      className="inline-flex items-center gap-1 text-[11px] text-brand-300 hover:text-brand-200"
                    >
                      <Plus className="h-3 w-3" />
                      {t("Add period")}
                    </button>
                    {p.periods.length > 1 && (
                      <button
                        onClick={() => sortPlatformPeriods(p.id)}
                        className="inline-flex items-center gap-1 text-[11px] text-zinc-400 hover:text-zinc-200"
                        title={t("Reorder these periods newest-first")}
                      >
                        <ArrowDownUp className="h-3 w-3" />
                        {t("Sort by date")}
                      </button>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>

          {err && <p className="text-sm text-rose-300">{err}</p>}
        </div>

        {/* footer */}
        <div className={cn("flex items-center justify-between border-t px-5 py-3.5", divider)}>
          <span className="text-xs text-zinc-500">
            {unlocked
              ? t("Saved signed — only signed files ever show the verified check.")
              : t("Saved to your Templates list as a personal log.")}
          </span>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={requestClose} disabled={busy}>
              {t("Cancel")}
            </Button>
            <Button variant="primary" onClick={save} disabled={busy}>
              <Save className="h-4 w-4" />
              {busy ? t("Saving…") : t("Save template")}
            </Button>
          </div>
        </div>
      </motion.div>

      <datalist id="micoll-platforms">
        {PLATFORMS.map((p) => (
          <option key={p} value={p} />
        ))}
      </datalist>
    </div>,
    document.body,
  );
}
