import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { motion } from "framer-motion";
import { listen } from "@tauri-apps/api/event";
import {
  X,
  CloudUpload,
  Loader2,
  FolderInput,
  ExternalLink,
  CheckCircle2,
  RefreshCw,
  Terminal,
  TriangleAlert,
  Layers,
} from "lucide-react";
import {
  megaStatus,
  megaUploadMedia,
  mediaDimensions,
  imageVersionsFor,
  MEGA_VERSION_KEY,
  openMegacmd,
  getSetting,
  setSetting,
  openUrl,
  type MegaStatus,
  type ResizeSpec,
  type ImageVersion,
} from "@/api/library";
import { useActions } from "@/actions";
import { useDialogTheme } from "@/lib/dialogTheme";
import { ThemedSelect } from "@/components/ThemedSelect";
import { cn } from "@/lib/utils";
import { useT, useTf, useTp } from "@/lib/i18n";

/** How many file names are listed before "+N more". */
const NAME_PREVIEW = 3;

/** Images bigger than this (px) show the "very large" hint. */
const BIG_SIDE = 4000;

type SizeMode = "orig" | "pct" | "width" | "height";

/** Which file of an image is uploaded: original, newest version, or a version id. */
type VersionPick = "original" | "newest" | `v${number}`;

const stemOf = (fn: string) => {
  const i = fn.lastIndexOf(".");
  return i > 0 ? fn.slice(0, i) : fn;
};
const extOf = (fn: string) => {
  const i = fn.lastIndexOf(".");
  return i > 0 ? fn.slice(i) : "";
};

/**
 * Upload to the user's MEGA account (via MEGAcmd). They pick the folder
 * (created if missing), then get it from the MEGA app on the phone.
 */
export function MegaUploadModal({
  path,
  srcs,
  name,
  creator,
  renameBase,
  onClose,
}: {
  /** One file... */
  path?: string;
  /** ...or all files of a reward (uploaded into <folder>/<sub>/). */
  srcs?: string[];
  name?: string;
  /** Creator name, added to the folder name. */
  creator?: string;
  /** Pre-fills the "Name + number" base (e.g. creator_reward). */
  renameBase?: string;
  onClose: () => void;
}) {
  const t = useT();
  const tf = useTf();
  const tp = useTp();
  const isFolder = !!srcs && srcs.length > 0;
  const files = useMemo(() => (isFolder ? srcs! : path ? [path] : []), [isFolder, srcs, path]);
  // file name of each staged file (for the rename preview)
  const fileNames = useMemo(
    () => files.map((p) => p.split(/[\\/]/).pop() ?? "file"),
    [files],
  );
  const { showToast } = useActions();
  // all surfaces come from the theme (see lib/dialogTheme)
  const { panel, input, field, divider, primary, accent: accentFill, accentText } = useDialogTheme();
  const [status, setStatus] = useState<MegaStatus | null>(null);
  const [folder, setFolder] = useState("/MiColl");
  // subfolder name "<creator> - <reward>", editable, no slashes
  const defaultSub = useMemo(() => {
    const n = (name ?? "reward").trim();
    const c = creator?.trim();
    const full = c && !n.toLowerCase().startsWith(c.toLowerCase()) ? `${c} - ${n}` : n;
    return full.replace(/[/\\]+/g, " ").trim();
  }, [name, creator]);
  const [sub, setSub] = useState(defaultSub);
  useEffect(() => setSub(defaultSub), [defaultSub]);
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  // downscale before upload (keeps ratio, never bigger)
  const [sizeMode, setSizeMode] = useState<SizeMode>("orig");
  const [sizeVal, setSizeVal] = useState("50");
  // optional rename of the uploaded copies (like RenameDialog: number or find/replace)
  const [renameMode, setRenameMode] = useState<"keep" | "number" | "replace">("keep");
  const [renameBaseVal, setRenameBaseVal] = useState(renameBase ?? "");
  const [renameStart, setRenameStart] = useState("1");
  const [renamePad, setRenamePad] = useState("2");
  const [renameFind, setRenameFind] = useState("");
  const [renameReplace, setRenameReplace] = useState("");
  // largest image + how many are "very large"
  const [bigInfo, setBigInfo] = useState<{ count: number; w: number; h: number } | null>(null);
  // progress: resizing -> uploading
  const [prog, setProg] = useState<{ phase: string; done: number; total: number } | null>(null);

  const check = useCallback(async () => {
    setChecking(true);
    const s = await megaStatus().catch(
      () => ({ installed: false, loggedIn: false, account: null }) as MegaStatus,
    );
    setStatus(s);
    setChecking(false);
  }, []);

  useEffect(() => {
    void check();
    void getSetting("mega_folder")
      .then((v) => v && setFolder(v))
      .catch(() => {});
  }, [check]);

  // versions of the selected images and which one goes up (default from Settings)
  const [vers, setVers] = useState<Record<string, { versions: ImageVersion[]; activeId: number | null }>>({});
  const [pick, setPick] = useState<VersionPick>("original");
  useEffect(() => {
    if (files.length === 0) return;
    let alive = true;
    void Promise.all([
      imageVersionsFor(files).catch(() => ({}) as Awaited<ReturnType<typeof imageVersionsFor>>),
      getSetting(MEGA_VERSION_KEY).catch(() => null),
    ]).then(([v, pref]) => {
      if (!alive) return;
      setVers(v);
      // for a single image "newest" = the id of its last version
      const one = isFolder ? undefined : v[files[0]]?.versions;
      setPick(
        pref !== "newest" ? "original" : one?.length ? `v${one[one.length - 1].id}` : "newest",
      );
    });
    return () => {
      alive = false;
    };
  }, [files, isFolder]);
  const withVersions = files.filter((f) => vers[f]).length;
  // version per file, null = original
  const chosen = useMemo<(ImageVersion | null)[]>(
    () =>
      files.map((f) => {
        const list = vers[f]?.versions;
        if (!list?.length || pick === "original") return null;
        if (pick === "newest") return list[list.length - 1];
        return list.find((v) => `v${v.id}` === pick) ?? null;
      }),
    [files, vers, pick],
  );
  // the file read from disk and its upload name.
  // a version is saved as <id>.png, so "pic.jpg" edited becomes "pic.png"
  const uploadSrcs = useMemo(
    () => files.map((f, i) => chosen[i]?.filePath ?? f),
    [files, chosen],
  );
  const effNames = useMemo(
    () =>
      fileNames.map((fn, i) => {
        const v = chosen[i];
        return v ? stemOf(fn) + extOf(v.filePath.split(/[\\/]/).pop() ?? "") : fn;
      }),
    [fileNames, chosen],
  );

  // detect very large images (> 4000 px) and suggest downsizing
  useEffect(() => {
    if (uploadSrcs.length === 0) return;
    let alive = true;
    mediaDimensions(uploadSrcs)
      .then((dims) => {
        if (!alive) return;
        let count = 0;
        let bw = 0;
        let bh = 0;
        for (const [w, h] of dims) {
          if (w > BIG_SIDE || h > BIG_SIDE) count++;
          if (w * h > bw * bh) {
            bw = w;
            bh = h;
          }
        }
        setBigInfo({ count, w: bw, h: bh });
        if (count > 0) setSizeMode((m) => (m === "orig" ? "pct" : m));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [uploadSrcs]);

  // While uploading the dialog can't be closed (click outside, X, Esc): it shakes
  // instead and says why. Esc is caught here first, the viewer below would close too.
  const [nudge, setNudge] = useState(false);
  const [held, setHeld] = useState(false);
  const busyRef = useRef(false);
  busyRef.current = busy;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const tryClose = useCallback(() => {
    if (busyRef.current) {
      setNudge(true);
      setHeld(true);
    } else onCloseRef.current();
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopImmediatePropagation();
      tryClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [tryClose]);

  // progress events from the backend
  useEffect(() => {
    const un = listen<{ phase: string; done: number; total: number }>("mega-progress", (e) =>
      setProg(e.payload),
    );
    return () => {
      void un.then((f) => f());
    };
  }, []);

  // before -> after preview for the largest image (same rules as the backend)
  const preview = useMemo(() => {
    if (!bigInfo || bigInfo.w === 0 || bigInfo.h === 0 || sizeMode === "orig") return null;
    const n = Number(sizeVal);
    if (!n || n <= 0) return null;
    const { w, h } = bigInfo;
    let tw: number;
    let th: number;
    if (sizeMode === "pct") {
      if (n >= 100) return null;
      tw = Math.max(1, Math.round((w * n) / 100));
      th = Math.max(1, Math.round((h * n) / 100));
    } else if (sizeMode === "width") {
      if (n >= w) return null;
      tw = Math.round(n);
      th = Math.max(1, Math.round((h * n) / w));
    } else {
      if (n >= h) return null;
      th = Math.round(n);
      tw = Math.max(1, Math.round((w * n) / h));
    }
    return { w, h, tw, th };
  }, [bigInfo, sizeMode, sizeVal]);

  const resizeSpec = (): ResizeSpec | undefined => {
    const n = Number(sizeVal);
    if (sizeMode === "orig" || !n || n <= 0) return undefined;
    if (sizeMode === "pct") return n < 100 ? { pct: n } : undefined;
    if (sizeMode === "width") return { width: Math.round(n) };
    return { height: Math.round(n) };
  };

  // new file names per file, or null to keep. Same rules as RenameDialog, extension stays.
  const renamedNames = useMemo<(string | null)[] | undefined>(() => {
    if (renameMode === "keep") return undefined;
    const ext = extOf;
    const stem = stemOf;
    if (renameMode === "number") {
      const base = renameBaseVal.trim();
      const startN = Number.parseInt(renameStart, 10) || 1;
      const width = Math.max(0, Math.min(6, Number.parseInt(renamePad, 10) || 0));
      return effNames.map((fn, i) => {
        const num = String(startN + i).padStart(width, "0");
        const s = `${base} ${num}`.trim();
        return s ? s + ext(fn) : null;
      });
    }
    // find & replace on the name
    return effNames.map((fn) => {
      if (!renameFind) return null;
      const s = stem(fn).split(renameFind).join(renameReplace).trim();
      return s ? s + ext(fn) : null;
    });
  }, [renameMode, renameBaseVal, renameStart, renamePad, renameFind, renameReplace, effNames]);

  const doUpload = async () => {
    if (files.length === 0) return;
    const dest = folder.trim() || "/";
    setBusy(true);
    setHeld(false);
    setProg(null);
    try {
      // a version always needs a name (rename or the original's name with its extension)
      const names = chosen.some(Boolean)
        ? effNames.map((fn, i) => renamedNames?.[i] ?? (chosen[i] ? fn : null))
        : renamedNames;
      const sum = await megaUploadMedia(
        uploadSrcs,
        dest,
        isFolder ? (sub.replace(/[/\\]+/g, " ").trim() || defaultSub) : undefined,
        resizeSpec(),
        names,
      );
      await setSetting("mega_folder", dest).catch(() => {});
      showToast({
        tone: "success",
        title: t("Uploaded to MEGA"),
        detail:
          tf("{done} of {total} uploaded", { done: sum.uploaded, total: files.length }) +
          (sum.resized > 0 ? tf(" · {n} downsized", { n: sum.resized }) : "") +
          t(" · open the MEGA app on your phone"),
      });
      onClose();
    } catch (e) {
      showToast({ tone: "error", title: t("MEGA upload failed"), detail: `${e}` });
    } finally {
      setBusy(false);
      setProg(null);
    }
  };

  // portaled to <body>, on iridescent the year box is a stacking context and
  // the modal slid under the top bar
  return createPortal(
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      onClick={tryClose}
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/70 backdrop-blur-sm"
    >
      {/* own wrapper for the shake, the panel's transform belongs to framer */}
      <div
        className={cn("flex max-h-[92vh] max-w-[92vw]", nudge && "dialog-nudge")}
        onAnimationEnd={() => setNudge(false)}
      >
      <motion.div
        initial={{ scale: 0.96, opacity: 0, y: 8 }}
        animate={{ scale: 1, opacity: 1, y: 0 }}
        exit={{ scale: 0.96, opacity: 0, y: 8 }}
        onClick={(e) => e.stopPropagation()}
        // max-h + scrolling body so the upload button never gets cut off
        className={cn("flex max-h-[92vh] w-[26rem] max-w-[92vw] flex-col overflow-hidden", panel)}
      >
        <div className={cn("flex shrink-0 items-center justify-between border-b px-5 py-3", divider)}>
          <h2 className="flex items-center gap-2 text-sm font-semibold text-zinc-100">
            <CloudUpload className={cn("h-4 w-4", accentText)} />
            {t("Upload to MEGA")}
          </h2>
          <button onClick={tryClose} className="text-zinc-500 hover:text-zinc-300" title={t("Close (Esc)")}>
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
          {!status ? (
            <div className="flex h-32 items-center justify-center text-zinc-400">
              <Loader2 className={cn("h-6 w-6 animate-spin", accentText)} />
            </div>
          ) : !status.installed ? (
            /* Not installed -> link to the download. */
            <div>
              <p className="text-sm font-medium text-zinc-100">{t("MEGAcmd isn’t installed")}</p>
              <p className="mt-1 text-xs text-zinc-400">
                {t(
                  "MiColl uploads through MEGA’s official command‑line tool, so it never handles your MEGA password.",
                )}
              </p>
              <ol className="mt-3 list-decimal space-y-1 pl-5 text-xs text-zinc-300">
                <li>{t("Install MEGAcmd (the official MEGA CLI).")}</li>
                <li>
                  {t("Open it once and run")}{" "}
                  <code className={accentText}>login your@email</code>.
                </li>
                <li>{t("Come back here and re‑check.")}</li>
              </ol>
              <div className="mt-4 flex gap-2">
                <button
                  onClick={() => void openUrl("https://mega.io/cmd")}
                  className={cn(
                    "inline-flex items-center gap-1.5 px-3 py-1.5 text-xs text-zinc-200 transition-colors hover:brightness-125",
                    field,
                  )}
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                  {t("Get MEGAcmd")}
                </button>
                <RecheckButton checking={checking} onClick={check} />
              </div>
            </div>
          ) : !status.loggedIn ? (
            /* Installed but not logged in -> help with login. */
            <div>
              <div className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2.5 py-1 text-xs font-medium text-emerald-300">
                <CheckCircle2 className="h-3.5 w-3.5" />
                {t("MEGAcmd installed")}
              </div>
              <p className="mt-3 text-sm font-medium text-zinc-100">{t("Not signed in yet")}</p>
              <p className="mt-1 text-xs text-zinc-400">
                {t("Open MEGAcmd and run")}{" "}
                <code className={accentText}>login your@email yourpassword</code>{" "}
                {t(
                  "(it’ll prompt for the password if you leave it off). Then re‑check here.",
                )}
              </p>
              <div className="mt-4 flex flex-wrap gap-2">
                <button
                  onClick={() => void openMegacmd().catch((e) => showToast({ tone: "error", title: t("Couldn’t open MEGAcmd"), detail: `${e}` }))}
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-brand-500",
                    primary,
                  )}
                >
                  <Terminal className="h-3.5 w-3.5" />
                  {t("Open MEGAcmd")}
                </button>
                <RecheckButton checking={checking} onClick={check} />
              </div>
              {status.raw && (
                <details className="mt-4">
                  <summary className="cursor-pointer text-[11px] text-zinc-500 hover:text-zinc-300">
                    {t("Diagnostics (what MEGAcmd returned)")}
                  </summary>
                  <div className="mt-1.5">
                    <pre
                      className={cn(
                        "max-h-40 overflow-auto whitespace-pre-wrap p-2 text-[10px] leading-relaxed text-zinc-400",
                        field,
                      )}
                    >
                      {status.raw}
                    </pre>
                    <button
                      onClick={() => {
                        void navigator.clipboard.writeText(status.raw ?? "").then(() =>
                          showToast({ tone: "success", title: t("Copied diagnostics") }),
                        );
                      }}
                      className={cn(
                        "mt-1.5 px-2 py-1 text-[11px] text-zinc-200 transition-colors hover:brightness-125",
                        field,
                      )}
                    >
                      {t("Copy")}
                    </button>
                  </div>
                </details>
              )}
            </div>
          ) : (
            /* Logged in -> pick folder + upload. */
            <>
              <div className="flex items-center gap-1.5 text-sm text-zinc-300">
                <CheckCircle2 className="h-4 w-4 text-emerald-400" />
                {t("Signed in as")}{" "}
                <span className="font-medium text-zinc-100">{status.account}</span>
              </div>
              <label className="mt-4 block text-xs font-medium uppercase tracking-wide text-zinc-500">
                {t("Destination folder in MEGA")}
              </label>
              <div className={cn("mt-1.5 flex items-center gap-2 px-2.5 py-2", field)}>
                <FolderInput className="h-4 w-4 shrink-0 text-zinc-500" />
                <input
                  value={folder}
                  onChange={(e) => setFolder(e.target.value)}
                  placeholder="/MiColl"
                  spellCheck={false}
                  className="min-w-0 flex-1 bg-transparent text-sm text-zinc-100 outline-none placeholder:text-zinc-600"
                />
              </div>
              {/* subfolder named after creator and reward */}
              {isFolder && (
                <>
                  <label className="mt-3 block text-xs font-medium uppercase tracking-wide text-zinc-500">
                    {t("Folder name")}
                  </label>
                  <div className={cn("mt-1.5 flex items-center gap-2 px-2.5 py-2", field)}>
                    <FolderInput className="h-4 w-4 shrink-0 text-zinc-500" />
                    <input
                      value={sub}
                      onChange={(e) => setSub(e.target.value)}
                      placeholder={defaultSub}
                      spellCheck={false}
                      className="min-w-0 flex-1 bg-transparent text-sm text-zinc-100 outline-none placeholder:text-zinc-600"
                    />
                  </div>
                </>
              )}
              <p className="mt-1.5 text-[11px] text-zinc-500">
                {t("Created automatically if it doesn’t exist. Uploading")}{" "}
                <span className="text-zinc-300">
                  {isFolder
                    ? `${tp("{n} files", files.length)} → ${sub || defaultSub}`
                    : (name ?? t("this file"))}
                </span>{" "}
                {t("— it appears in the MEGA app on your phone.")}
              </p>

              {/* which file goes up (only if there's a choice) */}
              {withVersions > 0 && (
                <>
                  <label className="mt-4 block text-xs font-medium uppercase tracking-wide text-zinc-500">
                    {t("Version")}
                  </label>
                  <ThemedSelect
                    value={pick}
                    onChange={(v) => setPick(v as VersionPick)}
                    options={
                      isFolder
                        ? [
                            { value: "original", label: t("Original files") },
                            { value: "newest", label: t("Newest version") },
                          ]
                        : [
                            { value: "original", label: t("Original") },
                            // newest first
                            ...(vers[files[0]]?.versions ?? [])
                              .map((v, i) => ({
                                value: `v${v.id}`,
                                label:
                                  (v.label || `Edit ${i + 1}`) +
                                  (vers[files[0]]?.activeId === v.id ? ` · ${t("shown")}` : ""),
                              }))
                              .reverse(),
                          ]
                    }
                    title={t("Upload the original file or one of its edited versions")}
                    ink="text-zinc-100"
                    className={cn("mt-1.5 h-[38px] w-full px-2.5 text-sm", field)}
                  />
                  <p className="mt-1 flex items-start gap-1.5 text-[11px] text-zinc-500">
                    <Layers className="mt-px h-3 w-3 shrink-0" />
                    <span>
                      {isFolder
                        ? tf("{n} of {total} files have versions — the rest always go up as originals.", {
                            n: withVersions,
                            total: files.length,
                          })
                        : t("Edited versions upload as PNG, under the original’s name.")}
                    </span>
                  </p>
                </>
              )}

              {/* very large image hint */}
              {bigInfo && bigInfo.count > 0 && (
                <div className="mt-3 flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] leading-relaxed text-amber-200">
                  <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>
                    {tf(
                      "{images} very large (up to {w} × {h} px) — downsizing is recommended for a faster upload.",
                      { images: tp("{n} images", bigInfo.count), w: bigInfo.w, h: bigInfo.h },
                    )}
                  </span>
                </div>
              )}

              {/* size before upload */}
              <label className="mt-4 block text-xs font-medium uppercase tracking-wide text-zinc-500">
                {t("Image size")}
              </label>
              <div className="mt-1.5 flex items-center gap-2">
                {/* ThemedSelect instead of a native select (that one would be a grey system
                    menu) */}
                <ThemedSelect
                  value={sizeMode}
                  onChange={(v) => {
                    const m = v as SizeMode;
                    setSizeMode(m);
                    setSizeVal(m === "pct" ? "50" : "2048");
                  }}
                  options={[
                    { value: "orig", label: t("Keep original size") },
                    { value: "pct", label: t("Scale down to %") },
                    { value: "width", label: t("Max width (px)") },
                    { value: "height", label: t("Max height (px)") },
                  ]}
                  title={t("How large the uploaded copies are")}
                  ink="text-zinc-100"
                  className={cn("h-[38px] min-w-0 flex-1 px-2.5 text-sm", field)}
                />
                {sizeMode !== "orig" && (
                  <div className={cn("flex items-center gap-1 px-2.5 py-2", field)}>
                    <input
                      type="number"
                      min={1}
                      max={sizeMode === "pct" ? 99 : 16000}
                      value={sizeVal}
                      onChange={(e) => setSizeVal(e.target.value)}
                      className="w-16 bg-transparent text-sm text-zinc-100 outline-none [appearance:textfield]"
                    />
                    <span className="text-xs text-zinc-500">{sizeMode === "pct" ? "%" : "px"}</span>
                  </div>
                )}
              </div>
              {sizeMode !== "orig" && (
                <p className="mt-1 text-[11px] text-zinc-500">
                  {preview && (
                    <span className="tabular-nums text-zinc-300">
                      {preview.w} × {preview.h}
                      <span className={cn("mx-1", accentText)}>→</span>
                      {preview.tw} × {preview.th}
                      {files.length > 1 && (
                        <span className="text-zinc-500"> {t("(largest image)")}</span>
                      )}
                      <span className="text-zinc-600"> · </span>
                    </span>
                  )}
                  {t(
                    "Ratio stays locked; smaller images are left untouched. Originals on disk are never changed.",
                  )}
                </p>
              )}

              {/* file names (only the uploaded copies are renamed) */}
              <label className="mt-4 block text-xs font-medium uppercase tracking-wide text-zinc-500">
                {t("File names")}
              </label>
              <ThemedSelect
                value={renameMode}
                onChange={(v) => {
                  const m = v as "keep" | "number" | "replace";
                  setRenameMode(m);
                  if (m === "number" && !renameBaseVal.trim()) setRenameBaseVal(renameBase ?? "");
                }}
                options={[
                  { value: "keep", label: t("Keep original names") },
                  { value: "number", label: t("Rename — name + numbering") },
                  { value: "replace", label: t("Rename — find & replace") },
                ]}
                title={t("Names for the uploaded copies — the files on disk are untouched")}
                ink="text-zinc-100"
                className={cn("mt-1.5 h-[38px] w-full px-2.5 text-sm", field)}
              />

              {renameMode === "number" && (
                <div className="mt-2 flex flex-wrap items-end gap-2">
                  <label className="min-w-0 flex-1">
                    <span className="mb-1 block text-[11px] text-zinc-500">{t("Base name")}</span>
                    <input
                      value={renameBaseVal}
                      onChange={(e) => setRenameBaseVal(e.target.value)}
                      placeholder={t("e.g. Creator_Reward")}
                      className={input}
                    />
                  </label>
                  <label className="w-16">
                    <span className="mb-1 block text-[11px] text-zinc-500">{t("Start #")}</span>
                    <input
                      value={renameStart}
                      onChange={(e) => setRenameStart(e.target.value.replace(/\D/g, "").slice(0, 5))}
                      className={input}
                    />
                  </label>
                  <label className="w-16">
                    <span className="mb-1 block text-[11px] text-zinc-500">{t("Digits")}</span>
                    <input
                      value={renamePad}
                      onChange={(e) => setRenamePad(e.target.value.replace(/\D/g, "").slice(0, 1))}
                      className={input}
                    />
                  </label>
                </div>
              )}
              {renameMode === "replace" && (
                <div className="mt-2 flex flex-wrap items-end gap-2">
                  <label className="min-w-0 flex-1">
                    <span className="mb-1 block text-[11px] text-zinc-500">{t("Find")}</span>
                    <input
                      value={renameFind}
                      onChange={(e) => setRenameFind(e.target.value)}
                      className={input}
                    />
                  </label>
                  <label className="min-w-0 flex-1">
                    <span className="mb-1 block text-[11px] text-zinc-500">{t("Replace with")}</span>
                    <input
                      value={renameReplace}
                      onChange={(e) => setRenameReplace(e.target.value)}
                      className={input}
                    />
                  </label>
                </div>
              )}
              {/* the first few names, also as before -> after preview when renaming */}
              {effNames.length > 0 && (
                <div className="mt-2 space-y-1 text-[11px] leading-snug">
                  {effNames.slice(0, NAME_PREVIEW).map((fn, i) => {
                    const to = renameMode === "keep" ? null : (renamedNames?.[i] ?? fn);
                    return (
                      <div key={fn + i} className="flex min-w-0 items-center gap-1">
                        <span className="min-w-0 flex-1 truncate text-zinc-400" title={fn}>
                          {fn}
                        </span>
                        {to !== null && (
                          <>
                            <span className={cn("shrink-0", accentText)}>→</span>
                            <span className="min-w-0 flex-1 truncate text-zinc-200" title={to}>
                              {to}
                            </span>
                          </>
                        )}
                      </div>
                    );
                  })}
                  {fileNames.length > NAME_PREVIEW && (
                    <div className="text-zinc-600">
                      +{tp("{n} more files", fileNames.length - NAME_PREVIEW)}
                    </div>
                  )}
                </div>
              )}

              <button
                onClick={() => void doUpload()}
                disabled={busy}
                className={cn(
                  "mt-5 flex w-full items-center justify-center gap-2 rounded-lg bg-brand-600 py-2 text-sm font-semibold text-white transition-colors hover:bg-brand-500 disabled:opacity-50",
                  primary,
                )}
              >
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <CloudUpload className="h-4 w-4" />}
                {busy
                  ? prog
                    ? tf(
                        prog.phase === "resize" ? "Preparing {done}/{total}…" : "Uploading {done}/{total}…",
                        { done: prog.done, total: prog.total },
                      )
                    : t("Starting…")
                  : t("Upload")}
              </button>
              {busy && prog && (
                <div className="mt-2 h-1 overflow-hidden rounded-full bg-white/10">
                  <div
                    className={cn("h-full transition-[width] duration-200", accentFill)}
                    style={{
                      width: `${Math.round(
                        // resize = first half, upload = second half
                        ((prog.phase === "resize" ? 0 : 50) +
                          (prog.done / Math.max(1, prog.total)) * 50),
                      )}%`,
                    }}
                  />
                </div>
              )}
              {busy && held && (
                <p className={cn("mt-2 text-center text-xs", accentText)}>
                  {t("The upload is still running — this window closes by itself when it’s done.")}
                </p>
              )}
            </>
          )}
        </div>
      </motion.div>
      </div>
    </motion.div>,
    document.body,
  );
}

function RecheckButton({ checking, onClick }: { checking: boolean; onClick: () => void }) {
  const t = useT();
  const { field } = useDialogTheme();
  return (
    <button
      onClick={onClick}
      disabled={checking}
      className={cn(
        "inline-flex items-center gap-1.5 px-3 py-1.5 text-xs text-zinc-200 transition-colors hover:brightness-125 disabled:opacity-50",
        field,
      )}
    >
      <RefreshCw className={`h-3.5 w-3.5 ${checking ? "animate-spin" : ""}`} />
      {checking ? t("Checking…") : t("Re-check")}
    </button>
  );
}
