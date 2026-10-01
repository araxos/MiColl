import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { motion } from "framer-motion";
import { open, save } from "@tauri-apps/plugin-dialog";
import {
  BadgeCheck,
  Check,
  ClipboardList,
  Clock,
  Download,
  FileJson,
  FolderInput,
  FolderOpen,
  Globe,
  PackageOpen,
  Pencil,
  Plus,
  PowerOff,
  RefreshCw,
  Sparkles,
  Trash2,
  Minimize2,
  RotateCcw,
  Upload,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { TemplateEditor } from "@/components/TemplateEditor";
import { useActions } from "@/actions";
import { useAccent } from "@/lib/theme";
import { useDialogTheme } from "@/lib/dialogTheme";
import { cn } from "@/lib/utils";
import { useT, useTf, useTp } from "@/lib/i18n";
import * as api from "@/api/library";

/**
 * Artist templates. Import a .micoll.json template and apply it: then the
 * completion % is a real "have / released" ratio and the artist is Verified.
 */
/** Rows before the list scrolls. */
const VISIBLE_ROWS = 5;

export function TemplatesPanel({
  backed,
  managed,
  collectionRoot,
  onApplied,
}: {
  backed: boolean;
  managed: boolean;
  collectionRoot: string;
  onApplied: () => void | Promise<void>;
}) {
  const t = useT();
  const tf = useTf();
  const tp = useTp();
  const { openMenu } = useActions();
  // verified check color per premium theme
  const accent = useAccent();
  const checkColor =
    accent === "iridescent"
      ? "text-[#f5c2ff]"
      : accent === "sakura"
        ? "text-[#f9a8d4]"
        : accent === "cyberpunk"
          ? "text-[#00e5ff]"
          : "text-brand-400";
  // badge colors: iridescent gets holo pink (its brand looks like the purple theme)
  const badgeAccent =
    accent === "iridescent"
      ? "bg-[#f5c2ff]/16 text-[#f5c2ff] ring-1 ring-inset ring-[#f5c2ff]/30"
      : "bg-brand-600/20 text-brand-200";
  // light frosted rows on iridescent
  const irid = accent === "iridescent";
  const [templates, setTemplates] = useState<api.TemplatePreview[]>([]);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [applyTarget, setApplyTarget] = useState<api.TemplatePreview | null>(null);
  const [editing, setEditing] = useState(false);
  // the JSON of the template being edited (fetched on edit)
  const [editTarget, setEditTarget] = useState<{ raw: string; fileName: string } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<api.TemplatePreview | null>(null);
  // templates turned off this session, shown with a "Deactivated" switch
  const [deactivated, setDeactivated] = useState<Set<string>>(new Set());
  // the list scrolls when it's long, height measured from the real rows
  const listRef = useRef<HTMLDivElement>(null);
  const [maxHeight, setMaxHeight] = useState<number>();
  const capped = templates.length > VISIBLE_ROWS && maxHeight !== undefined;
  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el || templates.length <= VISIBLE_ROWS) {
      setMaxHeight(undefined);
      return;
    }
    const rows = Array.from(el.children) as HTMLElement[];
    const first = rows[0];
    const last = rows[VISIBLE_ROWS - 1];
    if (!first || !last) return;
    // bottom of the last visible row
    setMaxHeight(last.offsetTop + last.offsetHeight - first.offsetTop);
  }, [templates]);

  const downloadTemplate = async (tpl: api.TemplatePreview) => {
    const path = await save({
      title: t("Download template"),
      defaultPath: tpl.fileName,
      filters: [{ name: t("MiColl template"), extensions: ["json"] }],
    });
    if (typeof path !== "string") return;
    try {
      await api.exportTemplate(path, await api.readTemplate(tpl.fileName));
      setStatus(`Saved “${tpl.artist}” template to ${path}.`);
    } catch (e) {
      setStatus(`Error: ${e}`);
    }
  };

  const load = useCallback(async () => {
    if (!backed) return;
    try {
      setTemplates(await api.listTemplates());
    } catch {
      /* ignore */
    }
  }, [backed]);

  useEffect(() => {
    void load();
  }, [load]);

  // re-apply a template (counts, links, type, verified, new rewards), no new folders
  const doUpdate = async (tpl: api.TemplatePreview) => {
    setBusy(true);
    setStatus(null);
    try {
      await api.applyTemplate(await api.readTemplate(tpl.fileName), false, null);
      await onApplied();
      await load();
      setStatus(`Updated “${tpl.artist}” from its template.`);
    } catch (e) {
      setStatus(`Error: ${e}`);
    } finally {
      setBusy(false);
    }
  };

  // deactivate: removes the tracking, keeps content and the template file
  const doDeactivate = async (tpl: api.TemplatePreview) => {
    setBusy(true);
    setStatus(null);
    try {
      await api.deactivateTemplate(await api.readTemplate(tpl.fileName));
      setDeactivated((s) => new Set(s).add(tpl.fileName));
      await onApplied();
      await load();
      setStatus(`Deactivated “${tpl.artist}” — its tracking was removed.`);
    } catch (e) {
      setStatus(`Error: ${e}`);
    } finally {
      setBusy(false);
    }
  };

  // turn a deactivated template back on
  const doActivate = async (tpl: api.TemplatePreview) => {
    setBusy(true);
    setStatus(null);
    try {
      await api.applyTemplate(await api.readTemplate(tpl.fileName), false, null);
      setDeactivated((s) => {
        const next = new Set(s);
        next.delete(tpl.fileName);
        return next;
      });
      await onApplied();
      await load();
      setStatus(`Re-activated “${tpl.artist}”.`);
    } catch (e) {
      setStatus(`Error: ${e}`);
    } finally {
      setBusy(false);
    }
  };

  // delete the template file (library data stays, deactivate first to remove that too)
  const doDelete = async (tpl: api.TemplatePreview) => {
    setDeleteTarget(null);
    setBusy(true);
    setStatus(null);
    try {
      await api.deleteTemplate(tpl.fileName);
      await load();
      setStatus(`Deleted the “${tpl.artist}” template file.`);
    } catch (e) {
      setStatus(`Error: ${e}`);
    } finally {
      setBusy(false);
    }
  };

  // Shift + right-click -> quick actions
  const templateMenu = (e: React.MouseEvent, tpl: api.TemplatePreview, applied: boolean) => {
    if (!e.shiftKey) return; // plain right-click is left to the OS
    e.preventDefault();
    openMenu(e, [
      {
        label: t("Show in Explorer"),
        icon: <FolderOpen className="h-4 w-4" />,
        onClick: () => void api.revealTemplate(tpl.fileName),
      },
      ...(applied
        ? [
            {
              label: t("Deactivate"),
              icon: <PowerOff className="h-4 w-4" />,
              onClick: () => void doDeactivate(tpl),
            },
          ]
        : []),
      ...(tpl.hasOriginal
        ? [
            {
              label: t("Restore the original covers"),
              icon: <RotateCcw className="h-4 w-4" />,
              onClick: () => void doRestoreCovers(tpl),
            },
          ]
        : [
            {
              label: `Shrink covers${tpl.bytes ? ` (${MB(tpl.bytes)})` : ""}`,
              icon: <Minimize2 className="h-4 w-4" />,
              onClick: () => void doShrink(tpl),
            },
          ]),
      {
        label:
          "Covers are stored inside the template file at full size. Shrinking re-encodes " +
          "them to 512px and keeps the untouched file next to it, so you can go back.",
        info: true,
      },
      {
        label: t("Delete template…"),
        icon: <Trash2 className="h-4 w-4" />,
        danger: true,
        onClick: () => setDeleteTarget(tpl),
      },
    ]);
  };

  const MB = (n: number) => `${(n / 1048576).toFixed(1)} MB`;

  // re-encode the inline covers (they used to be full size)
  const doShrink = async (tpl: api.TemplatePreview) => {
    setBusy(true);
    setStatus(null);
    try {
      const r = await api.shrinkTemplateCovers(tpl.fileName);
      await load();
      setStatus(
        r.covers === 0
          ? `“${tpl.artist}” has no oversized covers — nothing to do.`
          : `Shrank ${r.covers} cover(s) in “${tpl.artist}”: ${MB(r.before)} → ${MB(r.after)}. ` +
            "The original is kept — right-click to put it back.",
      );
    } catch (e) {
      setStatus(`Error: ${e}`);
    } finally {
      setBusy(false);
    }
  };

  const doRestoreCovers = async (tpl: api.TemplatePreview) => {
    setBusy(true);
    setStatus(null);
    try {
      await api.restoreTemplateCovers(tpl.fileName);
      await load();
      setStatus(`Put back the original covers of “${tpl.artist}”.`);
    } catch (e) {
      setStatus(`Error: ${e}`);
    } finally {
      setBusy(false);
    }
  };

  const importViaPicker = async () => {
    const picked = await open({
      multiple: false,
      title: t("Choose a creator template (.micoll.json)"),
      filters: [{ name: t("MiColl template"), extensions: ["json"] }],
    });
    if (typeof picked !== "string") return;
    setBusy(true);
    setStatus(null);
    try {
      const imported = await api.importTemplateFile(picked);
      await load();
      setStatus(
        tf("Imported template for “{artist}” ({rewards}).", {
          artist: imported.artist,
          rewards: tp("{n} rewards", imported.rewards),
        }),
      );
    } catch (e) {
      setStatus(`Error: ${e}`);
    } finally {
      setBusy(false);
    }
  };

  if (!backed) return null;

  return (
    // no top margin, the card already has padding
    <div>
      <div className="mb-1 flex items-center gap-2">
        <Sparkles className="h-6 w-6 text-brand-300" />
        <h1 className="text-2xl font-bold tracking-tight text-zinc-50">{t("Templates")}</h1>
      </div>
      <p className="settings-desc mt-1 text-sm text-zinc-400">
        {t("Apply a creator template to turn MiColl into a")}{" "}
        <b>{t("verified collection log")}</b>
        {t(
          "— it records exactly what an artist released (per platform / month), so your completion percentage becomes a true “have / released” ratio. Verified artists get a",
        )}{" "}
        <BadgeCheck className={`inline h-3.5 w-3.5 -translate-y-px ${checkColor}`} />{" "}
        {t("badge.")}
      </p>

      <div className="mt-4 flex items-center gap-2">
        <Button
          variant="primary"
          onClick={importViaPicker}
          disabled={busy}
          // white label, black on the light fills (cyberpunk yellow, iridescent pearl)
          className={
            accent === "cyberpunk" ? undefined : accent === "iridescent" ? "!text-zinc-950" : "!text-white"
          }
        >
          <Upload className={`h-4 w-4 ${busy ? "animate-pulse" : ""}`} />
          {t("Import template")}
        </Button>
        <Button variant="outline" onClick={() => setEditing(true)} disabled={busy}>
          <Plus className="h-4 w-4" />
          {t("Create template")}
        </Button>
        <Button variant="ghost" onClick={() => void load()} disabled={busy} title={t("Reload the template list")}>
          <RefreshCw className={`h-4 w-4 ${busy ? "animate-spin" : ""}`} />
          {t("Refresh")}
        </Button>
        <span
          className="ml-1 inline-flex cursor-not-allowed items-center gap-1.5 rounded-lg border border-zinc-800 bg-zinc-900/50 px-3 py-2 text-sm text-zinc-500"
          title={t("Coming soon — browse and download community templates")}
        >
          <Globe className="h-4 w-4" />
          {t("Browse community templates")}
          <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-zinc-400">
            soon
          </span>
        </span>
      </div>

      {status && <p className="mt-3 text-sm text-brand-300">{status}</p>}

      <div
        ref={listRef}
        className={cn("mt-5 space-y-2", capped && "overflow-y-auto pr-1 [scrollbar-gutter:stable]")}
        style={capped ? { maxHeight } : undefined}
      >
        {templates.length === 0 ? (
          <div className={cn("rounded-xl border border-dashed border-zinc-800 bg-zinc-900/40 p-8 text-center text-sm text-zinc-500", irid && "border-white/15 bg-white/8 text-zinc-300")}>
            {t("No templates imported yet. Import a")}{" "}
            <code className="rounded bg-zinc-800 px-1 py-0.5 text-zinc-300">.micoll.json</code>{" "}
            {t("file to get started.")}
          </div>
        ) : (
          templates.map((tpl) => {
            const applied = !!tpl.applied;
            const details =
              `${tp("{n} platforms", tpl.platforms)} · ` +
              `${tp("{n} periods", tpl.periods)} · ` +
              `${tp("{n} rewards", tpl.rewards)}` +
              (tpl.links ? ` · ${tp("{n} links", tpl.links)}` : "");
            return (
              <div
                key={tpl.fileName}
                onContextMenu={(e) => templateMenu(e, tpl, applied)}
                className={cn(
                  // raise the hovered row so its popover isn't covered by the next row
                  // (iridescent rows are their own stacking context because of
                  // backdrop-blur)
                  "glass-box relative flex items-center gap-3 rounded-xl border border-zinc-800 bg-zinc-900 p-3 hover:z-10",
                  irid && "border-white/12 bg-white/10 backdrop-blur-md",
                )}
              >
                <div
                  className={cn(
                    "flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand-600/20 text-brand-300",
                    irid && "bg-white/15 text-[#9CCBF0]",
                  )}
                >
                  <FileJson className="h-4 w-4" />
                </div>
                {/* hover the name to see the counts */}
                <div className="group/info relative min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="min-w-0 truncate text-sm font-medium text-zinc-100">{tpl.artist}</span>
                    {tpl.verified ? (
                      <span
                        className={cn(
                          "inline-flex shrink-0 items-center gap-0.5 rounded px-1.5 py-0.5 text-[10px]",
                          badgeAccent,
                        )}
                      >
                        <BadgeCheck className="h-3 w-3" />
                        {t("Verified")}
                      </span>
                    ) : (
                      <span
                        className={cn(
                          "inline-flex shrink-0 items-center gap-0.5 rounded px-1.5 py-0.5 text-[10px]",
                          irid
                            ? "bg-white/15 text-zinc-100 ring-1 ring-inset ring-white/20"
                            : "bg-zinc-800 text-zinc-400",
                        )}
                      >
                        <ClipboardList className="h-3 w-3" />
                        {t("Personal")}
                      </span>
                    )}
                    {tpl.kind && (
                      <span className={cn("shrink-0 rounded px-1.5 py-0.5 text-[10px]", badgeAccent)}>
                        {tpl.kind}
                      </span>
                    )}
                  </div>
                  {/* second line: the label */}
                  <div className="mt-0.5 flex items-center gap-1.5">
                    {tpl.label ? (
                      <span
                        className={cn(
                          "truncate rounded px-1.5 py-0.5 text-[11px]",
                          irid
                            ? "bg-white/15 text-white ring-1 ring-inset ring-white/20"
                            : "bg-zinc-800 text-zinc-300",
                        )}
                      >
                        {tpl.label}
                      </span>
                    ) : (
                      <span className={cn("text-[11px] italic", irid ? "text-white/55" : "text-zinc-600")}>
                        {t("No label")}
                      </span>
                    )}
                    {tpl.updated && (
                      <span
                        className={cn(
                          "inline-flex shrink-0 items-center gap-1 text-[11px]",
                          irid ? "text-white/75" : "text-zinc-600",
                        )}
                      >
                        <Clock className="h-3 w-3" />
                        {tpl.updated}
                      </span>
                    )}
                  </div>
                  {/* details popover */}
                  <div className="pointer-events-none absolute left-0 top-full z-50 mt-1 hidden whitespace-nowrap rounded-lg border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 text-xs text-zinc-300 shadow-2xl shadow-black/50 group-hover/info:block">
                    {details}
                  </div>
                </div>
                <div className="flex items-center gap-1.5">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => void downloadTemplate(tpl)}
                    disabled={busy}
                    title={t("Download this template (.json)")}
                  >
                    <Download className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() =>
                      void api
                        .readTemplate(tpl.fileName)
                        .then((raw) => setEditTarget({ raw, fileName: tpl.fileName }))
                        .catch((e) => setStatus(`Error: ${e}`))
                    }
                    disabled={busy}
                    title={t("Edit this template")}
                  >
                    <Pencil className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setDeleteTarget(tpl)}
                    disabled={busy}
                    title={t("Delete this template file")}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                  {applied ? (
                    <>
                      {/* "Applied" badge that turns into "Deactivate" on hover */}
                      <button
                        onClick={() => void doDeactivate(tpl)}
                        disabled={busy}
                        title={t("Applied — click to deactivate (removes this template’s tracking; keeps your files)")}
                        className="group/applied inline-flex items-center gap-1.5 rounded-lg border border-emerald-600/40 bg-emerald-500/10 px-3 py-1.5 text-sm font-medium text-emerald-300 transition-colors hover:border-rose-600/50 hover:bg-rose-500/15 hover:text-rose-300 disabled:opacity-50"
                      >
                        <Check className="h-4 w-4 group-hover/applied:hidden" strokeWidth={3} />
                        <X className="hidden h-4 w-4 group-hover/applied:block" strokeWidth={3} />
                        <span className="group-hover/applied:hidden">{t("Applied")}</span>
                        <span className="hidden group-hover/applied:inline">{t("Deactivate")}</span>
                      </button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => void doUpdate(tpl)}
                        disabled={busy}
                        title={t("Update — re-apply this template (refresh counts, links & newly added rewards)")}
                      >
                        <RefreshCw className={`h-4 w-4 ${busy ? "animate-spin" : ""}`} />
                      </Button>
                    </>
                  ) : deactivated.has(tpl.fileName) ? (
                    // deactivated this session: red switch, "Activate" on hover
                    <button
                      onClick={() => void doActivate(tpl)}
                      disabled={busy}
                      title={t("Deactivated — click to activate this template again")}
                      className="group/off inline-flex items-center gap-1.5 rounded-lg border border-rose-600/40 bg-rose-500/10 px-3 py-1.5 text-sm font-medium text-rose-300 transition-colors hover:border-emerald-600/50 hover:bg-emerald-500/15 hover:text-emerald-300 disabled:opacity-50"
                    >
                      <X className="h-4 w-4 group-hover/off:hidden" strokeWidth={3} />
                      <Check className="hidden h-4 w-4 group-hover/off:block" strokeWidth={3} />
                      <span className="group-hover/off:hidden">{t("Deactivated")}</span>
                      <span className="hidden group-hover/off:inline">{t("Activate")}</span>
                    </button>
                  ) : (
                    <Button variant="outline" size="sm" onClick={() => setApplyTarget(tpl)} disabled={busy}>
                      <Sparkles className="h-4 w-4" />
                      {t("Apply")}
                    </Button>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>

      {(editing || editTarget) && (
        <TemplateEditor
          initial={editTarget ?? undefined}
          onClose={() => {
            setEditing(false);
            setEditTarget(null);
          }}
          onSaved={async (msg) => {
            setEditing(false);
            setEditTarget(null);
            setStatus(msg);
            await load();
          }}
        />
      )}

      {deleteTarget && (
        <ConfirmDialog
          title={t("Delete this template?")}
          confirmLabel={t("Delete file")}
          busy={busy}
          body={
            <>
              {t("Removes the")} <b>{deleteTarget.artist}</b> {t("template file")}
              {deleteTarget.label ? ` (“${deleteTarget.label}”)` : ""}
              {t(
                ". This only deletes the template — any tracking it already added to your library stays. Use",
              )}{" "}
              <b>{t("Deactivate")}</b> {t("first if you also want to remove that.")}
            </>
          }
          onConfirm={() => void doDelete(deleteTarget)}
          onCancel={() => setDeleteTarget(null)}
        />
      )}

      {applyTarget && (
        <ApplyDialog
          tpl={applyTarget}
          managed={managed}
          collectionRoot={collectionRoot}
          onClose={() => setApplyTarget(null)}
          onDone={async (msg) => {
            setApplyTarget(null);
            setStatus(msg);
            await onApplied();
            // also reload the template list so "Applied" updates right away
            await load();
          }}
        />
      )}
    </div>
  );
}

function ApplyDialog({
  tpl,
  managed,
  collectionRoot,
  onClose,
  onDone,
}: {
  tpl: api.TemplatePreview;
  managed: boolean;
  collectionRoot: string;
  onClose: () => void;
  onDone: (msg: string) => void | Promise<void>;
}) {
  const t = useT();
  const tf = useTf();
  const tp = useTp();
  const [createFolders, setCreateFolders] = useState(true);
  const [baseDir, setBaseDir] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const dlg = useDialogTheme();
  const cyber = useAccent() === "cyberpunk";

  // lock the page behind the dialog
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

  // Escape closes, but not while applying
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busyRef.current) closeRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // managed mode: folders go into the collection, otherwise pick a base
  const needsBase = createFolders && !managed;
  const canApply = !createFolders || managed || !!baseDir;

  const chooseBase = async () => {
    const picked = await open({
      directory: true,
      multiple: false,
      title: `Where should ${tpl.artist}'s folders be created?`,
    });
    if (typeof picked === "string") setBaseDir(picked);
  };

  const apply = async () => {
    setBusy(true);
    setErr(null);
    try {
      const raw = await api.readTemplate(tpl.fileName);
      const s = await api.applyTemplate(raw, createFolders, managed ? null : baseDir);
      await onDone(
        tf("Applied “{artist}” — {rewards} tracked", {
          artist: tpl.artist,
          rewards: tp("{n} rewards", tpl.rewards),
        }) + (s.rewards ? tf(", {n} matched on disk.", { n: s.rewards }) : "."),
      );
    } catch (e) {
      setErr(`${e}`);
    } finally {
      setBusy(false);
    }
  };

  // portaled, the Settings sections are stacking contexts (backdrop-blur)
  return createPortal(
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
      {/* drag strip, the overlay covers the title bar */}
      <div data-tauri-drag-region className="absolute inset-x-0 top-0 h-14" />
      <motion.div
        initial={{ opacity: 0, y: 12, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        className={cn("w-[30rem] max-w-full p-5", dlg.panel)}
      >
        <div className="flex items-start gap-3">
          <div
            className={cn(
              "flex h-9 w-9 shrink-0 items-center justify-center",
              cyber ? "rounded-none" : "rounded-lg",
              dlg.soft,
              dlg.accentText,
            )}
          >
            <PackageOpen className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-zinc-100">
              {tf("Apply “{artist}” template", { artist: tpl.artist })}
            </h2>
            <p className="settings-desc mt-1 text-sm text-zinc-400">
              {t("Marks")} <b>{tpl.artist}</b>{" "}
              {tf(
                "as verified and tracks {rewards} across {platforms}. Anything already on disk is matched automatically; the rest show as",
                {
                  rewards: tp("{n} rewards", tpl.rewards),
                  platforms: tp("{n} platforms", tpl.platforms),
                },
              )}{" "}
              <span className="text-amber-300">{t("missing")}</span>.
            </p>
          </div>
        </div>

        <label className={cn("mt-4 flex cursor-pointer items-start gap-2.5 p-3", dlg.box)}>
          <input
            type="checkbox"
            checked={createFolders}
            onChange={(e) => setCreateFolders(e.target.checked)}
            className="mt-0.5 h-4 w-4 accent-brand-500"
          />
          <span className="text-sm text-zinc-300">
            {t("Also create the empty folder structure on disk")}
            <span className="mt-0.5 block text-xs text-zinc-500">
              {t("Builds")}{" "}
              <code className={cn("rounded px-1 py-0.5 text-zinc-200", dlg.soft)}>
                {t("Platform / Year / Month / Reward")}
              </code>{" "}
              {t("folders so you can drop content straight into the right place.")}
            </span>
          </span>
        </label>

        {needsBase && (
          <div
            className={cn(
              "mt-3 flex items-center gap-2 p-2.5",
              cyber ? "rounded-none" : "rounded-lg",
              dlg.soft,
            )}
          >
            <FolderInput className="h-4 w-4 shrink-0 text-zinc-500" />
            <span
              className={`min-w-0 flex-1 truncate text-sm ${baseDir ? "text-zinc-200" : "text-zinc-500"}`}
            >
              {baseDir || t("Choose where to create the folders…")}
            </span>
            <Button variant="outline" size="sm" onClick={chooseBase} disabled={busy}>
              {baseDir ? t("Change…") : t("Choose…")}
            </Button>
          </div>
        )}
        {createFolders && managed && (
          <p className="settings-desc mt-2 text-xs text-zinc-500">
            Managed mode is on — folders are created inside your collection
            {collectionRoot ? "" : " (set a collection folder in Library first)"}.
          </p>
        )}

        {err && <p className="mt-3 text-sm text-rose-300">{err}</p>}

        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {t("Cancel")}
          </Button>
          <Button
            variant="primary"
            onClick={apply}
            disabled={busy || !canApply}
            className={dlg.primary}
          >
            <Sparkles className="h-4 w-4" />
            {busy ? t("Applying…") : t("Apply template")}
          </Button>
        </div>
      </motion.div>
    </div>,
    document.body,
  );
}
