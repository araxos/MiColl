//! The Wallpaper Hub's screen saver: after some minutes without any input MiColl shows one
//! of the hub's slideshows on every screen, until the mouse moves or a key is pressed. Runs
//! while MiColl does (also in the tray).
//!
//! Not a .scr that Windows starts: dropping one and registering it is what malware does,
//! virus scanners don't take that well from an unsigned program. So MiColl looks at the
//! idle time itself and keeps out of the way like Windows does: not while a video, a game
//! or a presentation is on, the PC is locked or Windows' own screen saver runs.

use crate::db::{self, DbLock};
use crate::{own_webview, wallsets, Db};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};

const KEY: &str = "saver";
/// The windows are "saver-0", "saver-1"…, one per screen.
const LABEL: &str = "saver-";
/// After showing: opening a window moves the focus and sends a mouse move by itself.
const GRACE: Duration = Duration::from_millis(1000);
/// A window that didn't load its first picture by then is shown without it …
const PATIENCE: Duration = Duration::from_secs(4);
/// … and if not even one did, it's given up.
const GIVE_UP: Duration = Duration::from_secs(12);
/// A nudged desk moves the mouse a little, that's not somebody coming back.
const NUDGE: i32 = 10;

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
#[serde(default, rename_all = "camelCase")]
pub struct Options {
    /// The hub slideshow that is the screen saver, None = off.
    pub set: Option<i64>,
    /// Minutes without input before it starts.
    pub after: u32,
    /// Seconds between pictures.
    pub every: u32,
    /// Lock the PC when it ends.
    pub lock: bool,
    /// The pictures slowly grow or shrink.
    pub zoom: bool,
    /// Time and date on it.
    pub clock: bool,
    /// Every screen shows the same picture.
    pub same: bool,
}

impl Default for Options {
    fn default() -> Self {
        Options { set: None, after: 5, every: 15, lock: false, zoom: true, clock: true, same: false }
    }
}

impl Options {
    fn sane(mut self) -> Self {
        self.after = self.after.clamp(1, 240);
        self.every = self.every.clamp(3, 3600);
        self
    }
}

pub fn options(conn: &rusqlite::Connection) -> Options {
    db::get_setting(conn, KEY)
        .ok()
        .flatten()
        .and_then(|s| serde_json::from_str::<Options>(&s).ok())
        .unwrap_or_default()
        .sane()
}

pub fn save(conn: &rusqlite::Connection, o: Options) -> Result<(), String> {
    let json = serde_json::to_string(&o.sane()).map_err(|e| e.to_string())?;
    db::set_setting(conn, KEY, &json).map_err(|e| e.to_string())
}

/* ---- what Windows says ------------------------------------------------ */

/// The last input: when (GetTickCount) and where the mouse is.
#[derive(Clone, Copy, PartialEq, Debug)]
struct Input {
    tick: u32,
    at: (i32, i32),
}

#[cfg(windows)]
mod win {
    use super::Input;

    #[repr(C)]
    struct LastInput {
        size: u32,
        time: u32,
    }
    #[link(name = "user32")]
    extern "system" {
        fn GetLastInputInfo(info: *mut LastInput) -> i32;
        fn GetCursorPos(p: *mut [i32; 2]) -> i32;
        fn SystemParametersInfoW(action: u32, param: u32, pv: *mut core::ffi::c_void, ini: u32) -> i32;
        fn LockWorkStation() -> i32;
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn GetTickCount() -> u32;
    }

    pub fn now() -> u32 {
        unsafe { GetTickCount() }
    }

    pub fn input() -> Input {
        let mut li = LastInput { size: 8, time: 0 };
        let mut p = [0i32; 2];
        unsafe {
            // (failing = somebody is there)
            if GetLastInputInfo(&mut li) == 0 {
                li.time = GetTickCount();
            }
            GetCursorPos(&mut p);
        }
        Input { tick: li.time, at: (p[0], p[1]) }
    }

    fn flag(action: u32) -> bool {
        let mut on = 0i32;
        unsafe { SystemParametersInfoW(action, 0, (&raw mut on).cast(), 0) != 0 && on != 0 }
    }

    /// Something is on that a screen saver mustn't cover.
    pub fn blocked() -> bool {
        use windows::Win32::System::Power::{CallNtPowerInformation, SystemExecutionState, ES_DISPLAY_REQUIRED};
        use windows::Win32::UI::Shell::{
            SHQueryUserNotificationState, QUNS_BUSY, QUNS_NOT_PRESENT, QUNS_PRESENTATION_MODE,
            QUNS_RUNNING_D3D_FULL_SCREEN,
        };
        const SPI_GETSCREENSAVERRUNNING: u32 = 0x0072;
        unsafe {
            // a full screen program (a game, a video), a presentation, the PC is locked
            if let Ok(s) = SHQueryUserNotificationState() {
                if [QUNS_NOT_PRESENT, QUNS_BUSY, QUNS_RUNNING_D3D_FULL_SCREEN, QUNS_PRESENTATION_MODE].contains(&s) {
                    return true;
                }
            }
            // a program asks Windows to leave the screen on (a video in a window, a call)
            let mut state = 0u32;
            let ok = CallNtPowerInformation(SystemExecutionState, None, 0, Some((&raw mut state).cast()), 4);
            if ok.is_ok() && state & ES_DISPLAY_REQUIRED.0 != 0 {
                return true;
            }
        }
        flag(SPI_GETSCREENSAVERRUNNING)
    }

    /// Windows has a screen saver of its own turned on (the two would fight).
    pub fn has_own() -> bool {
        use windows::core::w;
        use windows::Win32::System::Registry::{RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_SZ};
        const SPI_GETSCREENSAVEACTIVE: u32 = 0x0010;
        let mut buf = [0u16; 512];
        let mut size = std::mem::size_of_val(&buf) as u32;
        let got = unsafe {
            RegGetValueW(
                HKEY_CURRENT_USER,
                w!("Control Panel\\Desktop"),
                w!("SCRNSAVE.EXE"),
                RRF_RT_REG_SZ,
                None,
                Some(buf.as_mut_ptr().cast()),
                Some(&mut size),
            )
        };
        got.is_ok() && buf[0] != 0 && flag(SPI_GETSCREENSAVEACTIVE)
    }

    pub fn lock_pc() {
        unsafe {
            LockWorkStation();
        }
    }
}

#[cfg(not(windows))]
mod win {
    use super::Input;
    pub fn now() -> u32 {
        0
    }
    pub fn input() -> Input {
        Input { tick: 0, at: (0, 0) }
    }
    pub fn blocked() -> bool {
        true
    }
    pub fn has_own() -> bool {
        false
    }
    pub fn lock_pc() {}
}

pub use win::has_own;

/* ---- when to start and when to end -------------------------------------- */

/// What the watcher remembers between two looks.
#[derive(Default)]
struct Watch {
    /// When something was on that it mustn't cover: the time counts from there.
    blocked: Option<u32>,
    /// The input it was tried after and couldn't start (no pictures): not again before
    /// the next one.
    failed: Option<u32>,
}

impl Watch {
    /// The idle time is over (GetTickCount wraps around after 49 days).
    fn is_time(&self, now: u32, last_input: u32, after: u32) -> bool {
        let wait = after.saturating_mul(60_000);
        let idle = now.wrapping_sub(last_input);
        let since_blocked = self.blocked.map_or(u32::MAX, |b| now.wrapping_sub(b));
        self.failed != Some(last_input) && idle.min(since_blocked) >= wait
    }
}

/// Somebody is back: a key, a click or the wheel (an input that didn't move the mouse), or
/// the mouse moved away from where it lay.
fn is_back(start: Input, before: Input, now: Input) -> bool {
    if now.tick == before.tick {
        return false;
    }
    if now.at == before.at {
        return true;
    }
    (now.at.0 - start.at.0).abs() > NUDGE || (now.at.1 - start.at.1).abs() > NUDGE
}

/// The show that's on.
struct Run {
    labels: Vec<String>,
    /// Each screen's longer side in pixels (the window isn't as big yet when it loads).
    edges: Vec<u32>,
    /// The windows that have their first picture.
    ready: HashSet<String>,
    made: Instant,
    shown: Option<Instant>,
    /// The input when it started, where the mouse lay when it was shown, the last look.
    first: Input,
    start: Input,
    before: Input,
    pictures: Vec<String>,
    fit: String,
    options: Options,
    /// When it began (unix milliseconds).
    began: u64,
    /// Started by hand: the hand is still on the mouse.
    preview: bool,
}

static RUN: Mutex<Option<Run>> = Mutex::new(None);

fn run() -> MutexGuard<'static, Option<Run>> {
    RUN.lock().unwrap_or_else(|e| e.into_inner())
}

/// What a window shows.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Frames {
    pictures: Vec<String>,
    /// Seconds between two.
    every: u32,
    fit: String,
    zoom: bool,
    clock: bool,
    /// The same picture on every screen, else each begins somewhere else in the list.
    same: bool,
    /// When it began (unix milliseconds): the screens change together by it.
    began: u64,
    /// This window's screen.
    screen: usize,
    screens: usize,
    /// Its longer side in pixels.
    edge: u32,
}

pub fn frames(label: &str) -> Option<Frames> {
    let g = run();
    let r = g.as_ref()?;
    let screen = r.labels.iter().position(|l| l == label)?;
    Some(Frames {
        pictures: r.pictures.clone(),
        every: r.options.every,
        fit: r.fit.clone(),
        zoom: r.options.zoom,
        clock: r.options.clock,
        same: r.options.same,
        began: r.began,
        screen,
        screens: r.labels.len(),
        edge: r.edges.get(screen).copied().unwrap_or(2560),
    })
}

/// A window has its first picture.
pub fn ready(label: &str) {
    if let Some(r) = run().as_mut() {
        r.ready.insert(label.to_string());
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// Start the show. Never on the window's thread (it makes windows).
pub fn start(app: &AppHandle, set: i64, preview: bool) -> Result<(), String> {
    let (mut pictures, fit, shuffle, o) = {
        let db = app.state::<Db>();
        let conn = db.conn();
        let (_, fit, shuffle) =
            wallsets::get(&conn, set).map_err(|e| e.to_string())?.ok_or("That slideshow is gone.")?;
        let hide = crate::hides_nsfw().unwrap_or(true);
        let pictures = wallsets::showable(&conn, set, hide).map_err(|e| e.to_string())?;
        (pictures, fit, shuffle, options(&conn))
    };
    if pictures.is_empty() {
        return Err("None of its pictures can be shown right now (missing, encrypted or not a picture).".into());
    }
    if shuffle {
        use rand::seq::SliceRandom;
        pictures.shuffle(&mut rand::thread_rng());
    }
    let screens = app.available_monitors().map_err(|e| e.to_string())?;
    if screens.is_empty() {
        return Err("No screen found.".into());
    }
    let labels: Vec<String> = (0..screens.len()).map(|i| format!("{LABEL}{i}")).collect();
    {
        let mut g = run();
        if g.is_some() || labels.iter().any(|l| app.get_webview_window(l).is_some()) {
            return Ok(());
        }
        let first = win::input();
        *g = Some(Run {
            labels: labels.clone(),
            edges: screens.iter().map(|m| m.size().width.max(m.size().height)).collect(),
            ready: HashSet::new(),
            made: Instant::now(),
            shown: None,
            first,
            start: first,
            before: first,
            pictures,
            fit,
            options: o,
            // the windows need about this long to open
            began: now_ms() + 800,
            preview,
        });
    }
    for (i, (label, m)) in labels.iter().zip(&screens).enumerate() {
        let url = tauri::WebviewUrl::App(format!("index.html?saver={i}").into());
        let made = own_webview(tauri::WebviewWindowBuilder::new(app, label, url))
            .title("MiColl")
            .decorations(false)
            .resizable(false)
            .skip_taskbar(true)
            .always_on_top(true)
            .shadow(false)
            .visible(false)
            .focused(false)
            // it fades in over the desktop (saver.css)
            .transparent(true)
            .background_color(tauri::window::Color(0, 0, 0, 0))
            .build()
            .and_then(|w| {
                // onto its screen first, then as big as it is
                w.set_position(*m.position())?;
                w.set_size(*m.size())?;
                w.set_fullscreen(true)?;
                w.set_cursor_visible(false)
            });
        if let Err(e) = made {
            end(app);
            return Err(e.to_string());
        }
    }
    Ok(())
}

/// Is it on (or about to be)?
pub fn is_on() -> bool {
    run().is_some()
}

/// End it.
fn end(app: &AppHandle) {
    let Some(r) = run().take() else { return };
    // first, so the desktop isn't seen in between
    if r.options.lock && !r.preview && r.shown.is_some() {
        win::lock_pc();
        std::thread::sleep(Duration::from_millis(250));
    }
    for (label, w) in app.webview_windows() {
        if label.starts_with(LABEL) {
            let _ = w.destroy();
        }
    }
}

fn show(app: &AppHandle, labels: &[String]) {
    for l in labels {
        if let Some(w) = app.get_webview_window(l) {
            let _ = w.show();
            // (the taskbar stays above a window that was only made fullscreen hidden)
            let _ = w.set_fullscreen(true);
            let _ = w.eval("document.documentElement.dataset.shown = ''");
        }
    }
    // keys go to it and not into the program below
    if let Some(w) = labels.first().and_then(|l| app.get_webview_window(l)) {
        let _ = w.set_focus();
    }
}

/// One look while it's on. True when it was given up: not one picture could be shown.
fn look(app: &AppHandle) -> bool {
    enum Do {
        Nothing,
        Show(Vec<String>, bool),
        End,
        GiveUp,
    }
    let todo = {
        let mut g = run();
        let Some(r) = g.as_mut() else { return false };
        let now = win::input();
        match r.shown {
            None => {
                let waited = r.made.elapsed();
                if !r.preview && now.tick != r.first.tick {
                    // back before it was there
                    Do::End
                } else if r.ready.len() == r.labels.len() || (waited > PATIENCE && !r.ready.is_empty()) {
                    r.shown = Some(Instant::now());
                    Do::Show(r.labels.clone(), r.preview)
                } else if waited > GIVE_UP {
                    Do::GiveUp
                } else {
                    Do::Nothing
                }
            }
            Some(at) if at.elapsed() < GRACE => {
                r.start = now;
                r.before = now;
                Do::Nothing
            }
            Some(_) => {
                let back = is_back(r.start, r.before, now);
                r.before = now;
                if back {
                    Do::End
                } else {
                    Do::Nothing
                }
            }
        }
    };
    match todo {
        Do::Nothing => {}
        Do::Show(labels, preview) => {
            show(app, &labels);
            if !preview {
                let app = app.clone();
                std::thread::spawn(move || crate::lockscreen::next_if_running(&app));
            }
        }
        Do::End => end(app),
        Do::GiveUp => {
            end(app);
            return true;
        }
    }
    false
}

/// One look while it isn't.
fn wait(app: &AppHandle, w: &mut Watch) {
    let Some(db) = app.try_state::<Db>() else { return };
    let o = options(&db.conn());
    let Some(set) = o.set else { return };
    let (now, last) = (win::now(), win::input().tick);
    if !w.is_time(now, last, o.after) {
        return;
    }
    // (not known yet what may be shown: MiColl is still starting)
    if crate::hides_nsfw().is_none() || win::blocked() {
        w.blocked = Some(now);
        return;
    }
    w.blocked = None;
    if let Err(e) = start(app, set, false) {
        crate::elog!("micoll: screen saver: {e}");
        w.failed = Some(last);
    }
}

/// Starts and ends it while MiColl runs.
pub fn keep(app: AppHandle) {
    std::thread::spawn(move || {
        let mut w = Watch::default();
        loop {
            let on = is_on();
            std::thread::sleep(Duration::from_millis(if on { 50 } else { 1000 }));
            if is_on() {
                if look(&app) {
                    crate::elog!("micoll: screen saver: no picture could be shown");
                    w.failed = Some(win::input().tick);
                }
            } else {
                wait(&app, &mut w);
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn it_starts_after_the_idle_time() {
        let w = Watch::default();
        assert!(!w.is_time(1_000_000, 1_000_000 - 299_999, 5));
        assert!(w.is_time(1_000_000, 1_000_000 - 300_000, 5));
        // GetTickCount starts over at zero
        assert!(w.is_time(200_000, u32::MAX - 100_000, 5));
        assert!(!w.is_time(100_000, u32::MAX - 100_000, 5));
    }

    #[test]
    fn a_video_that_ends_gives_the_full_time_again() {
        let mut w = Watch { blocked: Some(1_000_000), failed: None };
        // idle for an hour, the video ended a minute ago
        assert!(!w.is_time(1_060_000, 0, 5));
        assert!(w.is_time(1_300_000, 0, 5));
        // couldn't start: not again until somebody was there
        w = Watch { blocked: None, failed: Some(500) };
        assert!(!w.is_time(1_000_000, 500, 5));
        assert!(w.is_time(1_000_000, 501, 5));
    }

    #[test]
    fn a_nudge_is_not_somebody_coming_back() {
        let i = |tick, x, y| Input { tick, at: (x, y) };
        let start = i(10, 500, 500);
        // nothing happened
        assert!(!is_back(start, start, start));
        // a nudge, and one more in the same direction that adds up
        let a = i(20, 504, 500);
        assert!(!is_back(start, start, a));
        assert!(is_back(start, a, i(30, 511, 500)));
        assert!(is_back(start, a, i(30, 504, 480)));
        // a key or a click: an input and the mouse is where it was
        assert!(is_back(start, start, i(20, 500, 500)));
        assert!(is_back(start, a, i(30, 504, 500)));
        // the mouse was moved by a program: that's no input
        assert!(!is_back(start, start, i(10, 900, 900)));
    }

    #[test]
    fn the_options_are_kept_and_sane() {
        let dir = std::env::temp_dir().join(format!("micoll_saver_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let c = db::open(&dir.join("t.db")).unwrap();
        assert_eq!(options(&c), Options::default());
        assert_eq!(options(&c).set, None, "off until somebody turns it on");
        let o = Options { set: Some(3), after: 0, every: 1, lock: true, zoom: false, clock: false, same: true };
        save(&c, o.clone()).unwrap();
        assert_eq!(options(&c), Options { after: 1, every: 3, ..o });
        // an option that came later has its default
        db::set_setting(&c, KEY, r#"{"set":2,"after":9}"#).unwrap();
        assert_eq!(options(&c), Options { set: Some(2), after: 9, ..Default::default() });
        db::set_setting(&c, KEY, "broken").unwrap();
        assert_eq!(options(&c), Options::default());
        drop(c);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(windows)]
    #[test]
    fn windows_answers() {
        let a = win::input();
        assert!(win::now().wrapping_sub(a.tick) < u32::MAX / 2);
        let _ = (win::blocked(), win::has_own());
    }
}
