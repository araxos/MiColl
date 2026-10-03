import { useEffect, useRef, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { Info, RefreshCw, Download, Check, FolderOpen, Copy, Scale } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { LicensesDialog } from "@/components/LicensesDialog";
import { useActions } from "@/actions";
import { toggleOnClass, useAccent } from "@/lib/theme";
import { useDialogTheme } from "@/lib/dialogTheme";
import {
  checkForUpdates,
  setAutoUpdateCheck,
  showUpdatePrompt,
  useAutoUpdateCheck,
  useUpdater,
} from "@/lib/updater";
import { cn } from "@/lib/utils";
import { resolveLanguage, useLanguage, useT, useTf } from "@/lib/i18n";
import { isTauri } from "@/lib/tauri";
import * as api from "@/api/library";
import { version as PKG_VERSION } from "../../package.json";

/** Build date like "5 August 2026", in the chosen language. Empty if not set. */
function releaseDate(lang: string): string {
  const d = new Date(__BUILD_DATE__);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(lang, { day: "numeric", month: "long", year: "numeric" });
}

/** A path line, click to copy. */
function PathRow({
  label,
  path,
  ink,
  onCopy,
}: {
  label: string;
  path: string;
  ink: string;
  onCopy: (path: string) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onCopy(path)}
      title={`${path}

Click to copy`}
      className={cn(
        "group flex w-full items-center gap-1.5 rounded text-left transition-colors hover:text-zinc-100",
        ink,
      )}
    >
      <span className="truncate">
        {label} · {path}
      </span>
      <Copy className="h-3 w-3 shrink-0 opacity-0 transition-opacity group-hover:opacity-100" />
    </button>
  );
}

/**
 * Last Settings section: the MiColl version and updates
 * (auto check can be turned off, the button always works).
 */
export function VersionPanel() {
  const t = useT();
  const tf = useTf();
  // real app: version from tauri.conf.json, browser: from package.json
  const [version, setVersion] = useState(PKG_VERSION);
  const { state: check } = useUpdater();
  const autoCheck = useAutoUpdateCheck();
  const dlg = useDialogTheme();
  const accent = useAccent();
  // where the library index is stored (user profile, or next to the exe when portable)
  const [where, setWhere] = useState<api.DataLocations | null>(null);
  const [libraryName, setLibraryName] = useState<string | null>(null);
  const { showToast } = useActions();
  const released = releaseDate(resolveLanguage(useLanguage()));
  const [showLicenses, setShowLicenses] = useState(false);
  // frosted sub-card on iridescent
  const irid = accent === "iridescent";
  const inner = irid
    ? "glass-box border-white/15 bg-white/10 backdrop-blur-md"
    : "glass-box border-zinc-800 bg-zinc-900";
  // lighter text on iridescent
  const pathInk = irid ? "text-white/75" : "text-zinc-400";

  useEffect(() => {
    if (!isTauri()) return;
    let alive = true;
    getVersion()
      .then((v) => alive && setVersion(v))
      .catch(() => {});
    api
      .dataLocations()
      .then((d) => alive && setWhere(d))
      .catch(() => {});
    // only set when a portable copy started a new named library
    api
      .getSetting("library_name")
      .then((n) => alive && setLibraryName(n?.trim() || null))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const copyPath = async (path: string) => {
    try {
      await navigator.clipboard.writeText(path);
      showToast({ tone: "success", title: t("Copied to clipboard"), detail: path });
    } catch (e) {
      showToast({ tone: "error", title: t("Couldn’t copy"), detail: `${e}` });
    }
  };

  // after a manual check finds nothing, the button itself turns green for 20 s ("You're on
  // the latest version"), then back. Local state, so leaving Settings resets it too.
  const [confirmed, setConfirmed] = useState(false);
  const manualRef = useRef(false);
  useEffect(() => {
    if (check.kind === "checking") return;
    if (check.kind === "current" && manualRef.current) setConfirmed(true);
    manualRef.current = false;
  }, [check.kind]);
  useEffect(() => {
    if (!confirmed) return;
    const id = window.setTimeout(() => setConfirmed(false), 20_000);
    return () => window.clearTimeout(id);
  }, [confirmed]);

  const runCheck = () => {
    setConfirmed(false);
    manualRef.current = true;
    void checkForUpdates({ manual: true });
  };

  return (
    <div>
      <h2 className="flex items-center gap-2 settings-title text-2xl font-bold tracking-tight text-zinc-50">
        <Info className="h-6 w-6 text-brand-300" />
        {t("Version")}
      </h2>
      <p className="settings-desc mt-1 text-sm text-zinc-400">
        {t(
          "Which build of MiColl you’re running, and its updates. MiColl looks for a new version shortly after it starts and every six hours — switch that off below and it only looks when you press the button.",
        )}
      </p>

      <div
        className={cn(
          "mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border p-4",
          inner,
        )}
      >
        <div>
          <div className="text-sm font-medium text-zinc-100">MiColl</div>
          <div className="mt-0.5 font-mono text-2xl font-semibold leading-tight text-brand-300">
            {version}
          </div>
          {/* lighter text on iridescent */}
          {released && (
            <div className={cn("mt-1 text-xs", irid ? "text-white/80" : "text-zinc-500")}>
              {tf("Released {date}", { date: released })}
            </div>
          )}
        </div>
        <Button
          variant="outline"
          onClick={runCheck}
          disabled={
            check.kind === "checking" ||
            check.kind === "downloading" ||
            check.kind === "installing"
          }
          // green in every theme (success), the transition makes the switch soft
          className={cn(
            "transition-[background-color,border-color,color,box-shadow] duration-300",
            confirmed &&
              "border-emerald-400/60 bg-emerald-500/15 text-emerald-200 shadow-[0_0_14px_rgba(52,211,153,0.25)] hover:bg-emerald-500/25",
          )}
        >
          {confirmed ? (
            <Check className="h-4 w-4" />
          ) : (
            <RefreshCw className={`h-4 w-4 ${check.kind === "checking" ? "animate-spin" : ""}`} />
          )}
          {check.kind === "checking"
            ? t("Checking…")
            : confirmed
              ? t("You’re on the latest version")
              : t("Check for updates")}
        </Button>
      </div>

      {(check.kind === "available" ||
        check.kind === "downloading" ||
        check.kind === "installing") && (
        <div className={cn("mt-3 flex flex-wrap items-center justify-between gap-3 p-4", dlg.box)}>
          <div className="min-w-0">
            <div className={cn("text-sm font-medium", dlg.accentText)}>
              {tf("MiColl {version} is available.", { version: check.version })}
            </div>
            {check.kind !== "available" && (
              <p className="mt-0.5 text-xs text-zinc-400">
                {check.kind === "installing" ? t("Installing…") : t("Downloading…")}
              </p>
            )}
          </div>
          {check.kind === "available" && (
            <Button variant="primary" onClick={showUpdatePrompt} className={dlg.primary}>
              <Download className="h-4 w-4" />
              {t("Update now")}
            </Button>
          )}
        </div>
      )}

      {check.kind === "unsupported" && (
        <p className="mt-3 text-sm text-zinc-400">
          {t("Updates are only available in the desktop app.")}
        </p>
      )}

      {check.kind === "error" && (
        <p className="mt-3 text-sm text-rose-300">
          {check.during === "install"
            ? tf("The update couldn’t be installed: {detail}", { detail: check.detail })
            : tf("Couldn’t check for updates: {detail}", { detail: check.detail })}
        </p>
      )}

      <div
        className={cn(
          "mt-3 flex items-center justify-between gap-3 rounded-xl border p-4",
          inner,
        )}
      >
        <div className="min-w-0">
          <div className="text-sm font-medium text-zinc-100">
            {t("Check for updates automatically")}
          </div>
          <p className="settings-desc mt-0.5 text-sm text-zinc-400">
            {t(
              "After starting and every six hours. Only the version number is fetched from GitHub; nothing is sent. Installing always waits for you.",
            )}
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={autoCheck}
          onClick={() => setAutoUpdateCheck(!autoCheck)}
          className={cn(
            "micoll-switch relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors",
            autoCheck ? toggleOnClass(accent) : irid ? "bg-white/25" : "bg-zinc-700",
          )}
        >
          <span
            className={cn(
              "micoll-switch-knob inline-block h-5 w-5 transform rounded-full bg-white transition-transform",
              autoCheck ? "translate-x-5" : "translate-x-0.5",
            )}
          />
        </button>
      </div>

      {where && (
        <div className={cn("mt-3 rounded-xl border p-4", inner)}>
          <div className="flex items-center gap-2 text-sm font-medium text-zinc-100">
            <FolderOpen className="h-4 w-4 text-zinc-400" />
            {where.portable
              ? t("Portable — data next to the app")
              : t("Installed — data in your user profile")}
          </div>
          <p className="settings-desc mt-1 text-sm text-zinc-400">
            {where.portable
              ? t(
                  "This copy keeps everything in its own folder, so the whole app can be moved or carried as one. Note that the reward files themselves stay where they are, and are remembered by their full path.",
                )
              : t(
                  "Put an empty file called micoll-portable.txt next to micoll.exe to make this copy portable — it then keeps its library index in its own folder instead, and asks on its first start whether to take this library over or begin with an empty one.",
                )}
          </p>
          <div className="mt-2 space-y-1 font-mono text-xs">
            {libraryName && (
              <div className={cn("truncate", pathInk)}>
                {t("Library")} · {libraryName}
              </div>
            )}
            <PathRow label={t("Library index")} path={where.data} ink={pathInk} onCopy={copyPath} />
            <PathRow label={t("Thumbnail cache")} path={where.cache} ink={pathInk} onCopy={copyPath} />
          </div>
        </div>
      )}

      <div
        className={cn(
          "mt-3 flex flex-wrap items-center justify-between gap-3 rounded-xl border p-4",
          inner,
        )}
      >
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm font-medium text-zinc-100">
            <Scale className="h-4 w-4 text-zinc-400" />
            {t("Third-party licenses")}
          </div>
          <p className="settings-desc mt-0.5 text-sm text-zinc-400">
            {t("MiColl is built with open-source software, fonts and AI models. Here are their licenses.")}
          </p>
        </div>
        <Button variant="outline" onClick={() => setShowLicenses(true)}>
          {t("Show licenses")}
        </Button>
      </div>

      {showLicenses && <LicensesDialog onClose={() => setShowLicenses(false)} />}
    </div>
  );
}
