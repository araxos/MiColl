import { useCallback, useEffect, useState } from "react";
import { AnimatePresence } from "framer-motion";
import { Navigate, Route, Routes } from "react-router-dom";
import { DataProvider } from "@/store";
import { CoverCropMigration } from "@/components/CoverCropMigration";
import { UpdatePrompt } from "@/components/UpdatePrompt";
import { ActionsProvider } from "@/actions";
import { LockScreen } from "@/components/LockScreen";
import { LaunchActions } from "@/components/LaunchActions";
import { TopBar } from "@/components/Layout";
import { AppWallpaper } from "@/components/AppWallpaper";
import { DropZone } from "@/components/DropZone";
import { CommandPalette } from "@/components/CommandPalette";
import { DuplicatesPanel } from "@/components/DuplicatesPanel";
import { DUPLICATES_EVENT, type DuplicateScope } from "@/lib/duplicates";
import { StartPage } from "@/pages/StartPage";
import { WishlistPage } from "@/pages/WishlistPage";
import { ArtistPage } from "@/pages/ArtistPage";
import { MonthDetailPage } from "@/pages/MonthDetailPage";
import { SettingsPage } from "@/pages/SettingsPage";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isTauri } from "@/lib/tauri";
import { enterSafeMode, leaveSafeMode, useSafeMode } from "@/lib/safeMode";
import {
  firstRunPending,
  getSetting,
  hasPassword,
  lockSession,
  portableFirstRun,
  verifyThemeLicense,
  type PortableOffer,
} from "@/api/library";
import { PortableSetupGate } from "@/components/PortableSetupGate";
import { FirstRunWizard } from "@/components/FirstRunWizard";
import {
  applyAccent,
  getAccent,
  premiumUnlocked,
  setLicensee,
  setPremiumUnlocked,
  setTrialUntil,
  useAccent,
} from "@/lib/theme";
import { loadPrefs } from "@/lib/prefs";
import { applyAppIcon } from "@/lib/appIcon";
import { clearThumbMemo } from "@/hooks/useThumb";
import { LOCK_SETTINGS_EVENT } from "@/lib/lock";
import { getModeHotkey, eventToCombo, toggleSfwMode } from "@/lib/contentMode";
import { dismissSplash, splashReady } from "@/lib/splash";

export default function App() {
  const [locked, setLocked] = useState(false);
  const [booted, setBooted] = useState(false); // gate the first paint until we know
  // the saved settings are in localStorage; nothing that reads them mounts before this
  const [prefsReady, setPrefsReady] = useState(false);
  // only set on a portable copy's first start when there's an installed library to adopt
  const [portableOffer, setPortableOffer] = useState<PortableOffer | null>(null);
  // new library: show the first-run questions first
  const [firstRun, setFirstRun] = useState(false);
  const [autoMinutes, setAutoMinutes] = useState(0); // 0 = never
  const [sleepLock, setSleepLock] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [dupScope, setDupScope] = useState<DuplicateScope | null>(null);

  const safe = useSafeMode();

  // keep the splash up until the dashboard (or the lock screen) can show. The portable
  // question and the first-run wizard don't load the library, they replace the splash.
  useEffect(() => {
    if (portableOffer || firstRun) dismissSplash();
    else if (booted) splashReady("app");
  }, [booted, portableOffer, firstRun]);

  // window/taskbar icon, applied at boot and when the accent changes ("auto" follows the
  // theme)
  const accent = useAccent();
  useEffect(() => {
    void applyAppIcon();
  }, [accent]);

  // lock: clear the data key + cached thumbnails. Safe mode also ends here.
  const lockNow = useCallback(() => {
    void lockSession().catch(() => {});
    clearThumbMemo();
    leaveSafeMode();
    setLocked(true);
  }, []);

  // duplicate finder, opened with an event from anywhere
  useEffect(() => {
    const onDup = (e: Event) => setDupScope((e as CustomEvent<DuplicateScope>).detail ?? {});
    window.addEventListener(DUPLICATES_EVENT, onDup);
    return () => window.removeEventListener(DUPLICATES_EVENT, onDup);
  }, []);

  // global search: Ctrl/Cmd+K or the "micoll:search" event
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSearchOpen((o) => !o);
      }
    };
    const openIt = () => setSearchOpen(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("micoll:search", openIt);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("micoll:search", openIt);
    };
  }, []);

  // F11 = real fullscreen (only in Tauri, in the browser F11 belongs to the browser)
  useEffect(() => {
    if (!isTauri()) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "F11" || e.ctrlKey || e.altKey || e.metaKey) return;
      e.preventDefault();
      const win = getCurrentWindow();
      void win
        .isFullscreen()
        .then((on) => win.setFullscreen(!on))
        .catch(() => {});
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // start locked if a password is set (checked before the first paint).
  // A portable copy first asks which library to use, so the lock check waits for that.
  useEffect(() => {
    let alive = true;
    if (!isTauri()) {
      setPrefsReady(true);
      setBooted(true);
      return;
    }
    (async () => {
      try {
        // load the library's saved settings first, lots of code reads them from localStorage
        await loadPrefs();
        // then the license, then the accent. applyAccent would downgrade a premium accent
        // if the license isn't known yet.
        await reconcileLicence();
        applyAccent(getAccent());
      } finally {
        // also on an error, so the app never stays empty
        if (alive) setPrefsReady(true);
      }
      try {
        const offer = await portableFirstRun();
        if (!alive) return;
        if (offer) {
          setPortableOffer(offer);
          return; // the gate takes over; `booted` stays false behind it
        }
      } catch {
        /* not portable or older build, continue */
      }
      try {
        if (await firstRunPending()) {
          if (alive) setFirstRun(true);
          return; // the wizard takes over; nothing to lock yet either
        }
      } catch {
        /* older backend, continue */
      }
      try {
        if (await hasPassword()) {
          if (alive) setLocked(true);
        }
      } catch {
        /* ignore */
      }
      if (alive) setBooted(true);
    })();
    return () => {
      alive = false;
    };
  }, []);

  /**
   * Premium unlock: the license in the DB is the real source, localStorage is just a copy
   * for the first paint. Checked on every start.
   */
  const reconcileLicence = async () => {
    try {
      const token = await getSetting("themes_license");
      if (!token || !token.trim()) {
        if (premiumUnlocked()) setPremiumUnlocked(false);
        setLicensee(null);
        setTrialUntil(null);
        return;
      }
      // this is also where revoked keys and expired test keys stop working
      const lic = await verifyThemeLicense(token);
      if (!premiumUnlocked()) setPremiumUnlocked(true);
      setLicensee(lic.buyer);
      setTrialUntil(lic.trial ? lic.until : null);
    } catch {
      if (premiumUnlocked()) setPremiumUnlocked(false);
      setLicensee(null);
      setTrialUntil(null);
    }
  };

  const loadLockCfg = useCallback(async () => {
    if (!isTauri()) return;
    try {
      const [a, s] = await Promise.all([
        getSetting("lock_auto_minutes"),
        getSetting("lock_on_sleep"),
      ]);
      setAutoMinutes(Number(a ?? "0") || 0);
      setSleepLock(s === "true");
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    void loadLockCfg();
    window.addEventListener(LOCK_SETTINGS_EVENT, loadLockCfg);
    return () => window.removeEventListener(LOCK_SETTINGS_EVENT, loadLockCfg);
  }, [loadLockCfg]);

  // SFW/NSFW hotkey (set in Settings)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const combo = getModeHotkey();
      if (!combo) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (eventToCombo(e) === combo) {
        e.preventDefault();
        toggleSfwMode();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // auto-lock after N minutes without input
  useEffect(() => {
    if (locked || autoMinutes <= 0) return;
    let timer: number | undefined;
    const arm = () => {
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(() => lockNow(), autoMinutes * 60_000);
    };
    const events = ["mousemove", "mousedown", "keydown", "wheel", "touchstart"];
    events.forEach((e) => window.addEventListener(e, arm, { passive: true }));
    arm();
    return () => {
      if (timer) window.clearTimeout(timer);
      events.forEach((e) => window.removeEventListener(e, arm));
    };
  }, [locked, autoMinutes, lockNow]);

  // lock after sleep: a timer whose gap gets huge when the PC was asleep
  useEffect(() => {
    if (locked || !sleepLock) return;
    let last = Date.now();
    const id = window.setInterval(() => {
      const now = Date.now();
      if (now - last > 30_000) lockNow(); // big gap ⇒ the PC was asleep
      last = now;
    }, 5_000);
    return () => window.clearInterval(id);
  }, [locked, sleepLock, lockNow]);

  // the portable question has to be answered first, then the app reloads
  if (portableOffer) {
    return (
      <PortableSetupGate offer={portableOffer} onDone={() => window.location.reload()} />
    );
  }

  // no reload here, a new password shouldn't lock you out right away
  if (firstRun) {
    return (
      <FirstRunWizard
        onDone={() => {
          setFirstRun(false);
          setBooted(true);
        }}
      />
    );
  }

  return (
    <DataProvider>
      <ActionsProvider>
        {/* the providers already load the library; the rest waits for the settings */}
        {!prefsReady ? (
          <div className="h-screen bg-zinc-950" />
        ) : (
        <div className="flex h-screen flex-col overflow-hidden bg-zinc-950">
          <div className="relative flex-1 overflow-hidden">
            {/* wallpaper + premium FX, mounted once behind everything so WebGL isn't
                rebuilt */}
            <AppWallpaper />
            {!booted && <div className="absolute inset-0 z-50 bg-zinc-950" />}
            <DropZone />
            <CoverCropMigration active={booted && !locked && !safe} />
            <UpdatePrompt active={booted && !locked && !safe} />
            <LaunchActions active={booted && !locked && !safe} />
            <CommandPalette open={searchOpen} onClose={() => setSearchOpen(false)} />
            {dupScope && (
              <DuplicatesPanel scope={dupScope} onClose={() => setDupScope(null)} />
            )}
            <AnimatePresence>
              {locked && (
                <LockScreen
                  key="lock"
                  onUnlock={(decoy) => {
                    if (decoy) enterSafeMode();
                    else leaveSafeMode();
                    setLocked(false);
                  }}
                />
              )}
            </AnimatePresence>

            {/* the top bar is mounted once here, the pages only fill it (see Layout) */}
            <div className="app-content relative z-10 flex h-full flex-col">
              <TopBar onLock={lockNow} />
            <Routes>
              <Route path="/" element={<StartPage onLock={lockNow} />} />
              <Route path="/wishlist" element={<WishlistPage onLock={lockNow} />} />
              <Route path="/artist/:artistId" element={<ArtistPage onLock={lockNow} />} />
              <Route
                path="/artist/:artistId/month/:monthId"
                element={<MonthDetailPage onLock={lockNow} />}
              />
              {/* no settings in safe mode (guard is on the route so typed URLs don't work
                  either) */}
              <Route
                path="/settings"
                element={safe ? <Navigate replace to="/" /> : <SettingsPage onLock={lockNow} />}
              />
            </Routes>
            </div>
          </div>
        </div>
        )}
      </ActionsProvider>
    </DataProvider>
  );
}
