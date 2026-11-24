//! Long work: keeps the PC awake (awake.rs), fills the bar on MiColl's taskbar button and
//! makes the button flash when it's done and the user is in another program.
//!
//! Commands hold a `Work` for as long as they run. Work made of several commands (an
//! import, several tries of an expand) counts as one: it's over when nothing new started
//! for a moment.

use std::sync::{Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};

/// Nothing new started for this long: it's over.
const SETTLE: Duration = Duration::from_secs(3);
/// The same, when the work said another step follows (the next try of an expand).
const SETTLE_MORE: Duration = Duration::from_secs(60);
/// Shorter work never shows up on the taskbar.
const SHOW_AFTER: Duration = Duration::from_millis(1200);
/// Shorter work never makes the button flash.
const FLASH_AFTER: Duration = Duration::from_secs(5);

/// Which work a progress event belongs to (hold's `what`).
fn work_of(event: &str) -> &'static str {
    match event {
        "scan-progress" => "scanning the library",
        "organize-progress" => "import",
        "fill-progress" => "adding files",
        "collection-move-progress" => "moving the collection",
        "expand-progress" => "AI expand",
        "ai-model-progress" => "downloading an AI model",
        "alt-progress" => "adding alts",
        "wm-progress" => "removing watermarks",
        "encrypt-progress" => "encrypting",
        "mega-progress" => "uploading",
        "sd-progress" => "MiSD transport",
        "dup-progress" => "finding duplicates",
        _ => "",
    }
}

/// What the taskbar button shows.
#[derive(Clone, Copy, PartialEq, Debug)]
enum Bar {
    Off,
    /// something runs, nobody knows how far
    Running,
    /// 0 to 1000
    Part(u32),
}

struct Task {
    id: u64,
    what: &'static str,
    started: Instant,
    part: Option<u32>,
}

/// What runs and since when. Pure (the time comes in), so it can be tested.
struct Board {
    tasks: Vec<Task>,
    next: u64,
    /// since when something runs, small gaps included
    since: Option<Instant>,
    /// nothing runs since then, and how long to wait for more
    idle: Option<(Instant, Duration)>,
    bar: Bar,
    flash: bool,
}

impl Board {
    const fn new() -> Board {
        Board { tasks: Vec::new(), next: 1, since: None, idle: None, bar: Bar::Off, flash: false }
    }

    fn start(&mut self, what: &'static str, now: Instant) -> u64 {
        self.settle(now);
        self.since.get_or_insert(now);
        self.idle = None;
        let id = self.next;
        self.next += 1;
        self.tasks.push(Task { id, what, started: now, part: None });
        id
    }

    fn end(&mut self, id: u64, more: bool, now: Instant) {
        let Some(i) = self.tasks.iter().position(|t| t.id == id) else { return };
        let task = self.tasks.remove(i);
        if self.tasks.is_empty() {
            self.idle = Some((now, if more { SETTLE_MORE } else { SETTLE }));
        } else if !more
            && now.duration_since(task.started) >= FLASH_AFTER
            && self.tasks.iter().all(|t| t.what != task.what)
        {
            // something else goes on (a transport): this one is done all the same
            self.flash = true;
        }
    }

    /// The work said more follows, but it doesn't (stopped).
    fn no_more(&mut self) {
        if let Some((_, wait)) = &mut self.idle {
            *wait = SETTLE;
        }
    }

    fn progress(&mut self, what: &str, done: u64, total: u64) {
        if total == 0 {
            return;
        }
        // the newest of that kind
        if let Some(t) = self.tasks.iter_mut().rev().find(|t| t.what == what) {
            t.part = Some((done.min(total) as f64 / total as f64 * 1000.0) as u32);
        }
    }

    /// Nothing new for long enough: it's over.
    fn settle(&mut self, now: Instant) {
        let (Some(since), Some((idle, wait))) = (self.since, self.idle) else { return };
        if now.duration_since(idle) < wait {
            return;
        }
        if idle.duration_since(since) >= FLASH_AFTER {
            self.flash = true;
        }
        self.since = None;
        self.idle = None;
    }

    /// The bar now, and whether to flash (once).
    fn look(&mut self, now: Instant) -> (Bar, bool) {
        self.settle(now);
        self.bar = match self.since {
            None => Bar::Off,
            Some(s) if now.duration_since(s) < SHOW_AFTER => Bar::Off,
            // between two steps it stays as it is
            Some(_) if self.tasks.is_empty() => self.bar,
            // several things run: the one that runs longest and knows how far it is
            Some(_) => self.tasks.iter().find_map(|t| t.part).map_or(Bar::Running, Bar::Part),
        };
        (self.bar, std::mem::take(&mut self.flash))
    }

    fn quiet(&self) -> bool {
        self.since.is_none() && !self.flash
    }
}

static BOARD: Mutex<Board> = Mutex::new(Board::new());
static CHANGED: Condvar = Condvar::new();
static APP: OnceLock<tauri::AppHandle> = OnceLock::new();

fn board() -> std::sync::MutexGuard<'static, Board> {
    BOARD.lock().unwrap_or_else(|e| e.into_inner())
}

/// Held for as long as the work runs.
#[must_use]
pub struct Work {
    id: u64,
    more: bool,
    _awake: crate::awake::Awake,
}

pub fn hold(what: &'static str) -> Work {
    let id = board().start(what, Instant::now());
    CHANGED.notify_all();
    Work { id, more: false, _awake: crate::awake::hold(what) }
}

impl Work {
    /// Another command carries on after this one, however long that takes to start.
    pub fn more_follows(&mut self) {
        self.more = true;
    }
}

impl Drop for Work {
    fn drop(&mut self) {
        board().end(self.id, self.more, Instant::now());
        CHANGED.notify_all();
    }
}

/// How far it is, said with the event the window gets.
pub fn progress(event: &str, done: u64, total: u64) {
    board().progress(work_of(event), done, total);
}

pub fn no_more() {
    board().no_more();
}

/// Starts watching, once.
pub fn watch(app: &tauri::AppHandle) {
    if APP.set(app.clone()).is_err() {
        return;
    }
    let _ = std::thread::Builder::new().name("micoll-taskbar".into()).spawn(|| {
        let mut shown = Bar::Off;
        let mut at = Instant::now();
        loop {
            let (bar, flash) = {
                let mut b = board();
                while b.quiet() && shown == Bar::Off {
                    b = CHANGED.wait(b).unwrap_or_else(|e| e.into_inner());
                }
                b.look(Instant::now())
            };
            // again now and then: a window that was opened meanwhile, a restarted Explorer
            if bar != shown || (bar != Bar::Off && at.elapsed() > Duration::from_secs(2)) {
                show(bar);
                shown = bar;
                at = Instant::now();
            }
            if flash {
                flash_button();
            }
            std::thread::sleep(Duration::from_millis(250));
        }
    });
}

/// MiColl's normal windows (the ones with a taskbar button of MiColl, no pop-outs).
#[cfg(windows)]
fn windows_of(app: &tauri::AppHandle) -> Vec<windows::Win32::Foundation::HWND> {
    use tauri::Manager;
    app.webview_windows()
        .into_iter()
        .filter(|(label, _)| crate::is_app_window(label))
        .filter_map(|(_, w)| w.hwnd().ok())
        .map(|h| windows::Win32::Foundation::HWND(h.0 as _))
        .collect()
}

#[cfg(windows)]
fn show(bar: Bar) {
    let Some(app) = APP.get() else { return };
    let app2 = app.clone();
    let _ = app.run_on_main_thread(move || {
        use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_INPROC_SERVER};
        use windows::Win32::UI::Shell::{
            ITaskbarList3, TaskbarList, TBPF_INDETERMINATE, TBPF_NOPROGRESS, TBPF_NORMAL,
        };
        // not tao's: that one panics when Explorer isn't there
        let Ok(list) = (unsafe { CoCreateInstance::<_, ITaskbarList3>(&TaskbarList, None, CLSCTX_INPROC_SERVER) })
        else {
            return;
        };
        for hwnd in windows_of(&app2) {
            unsafe {
                let _ = match bar {
                    Bar::Off => list.SetProgressState(hwnd, TBPF_NOPROGRESS),
                    Bar::Running => list.SetProgressState(hwnd, TBPF_INDETERMINATE),
                    Bar::Part(p) => list
                        .SetProgressState(hwnd, TBPF_NORMAL)
                        .and_then(|_| list.SetProgressValue(hwnd, u64::from(p.max(10)), 1000)),
                };
            }
        }
    });
}

/// Flash MiColl's taskbar button, unless the user is in MiColl. It stays lit until they
/// come back.
#[cfg(windows)]
fn flash_button() {
    let Some(app) = APP.get() else { return };
    let app2 = app.clone();
    let _ = app.run_on_main_thread(move || {
        use windows::Win32::UI::WindowsAndMessaging::{
            FlashWindowEx, GetForegroundWindow, GetWindowThreadProcessId, IsWindowVisible, FLASHWINFO, FLASHW_TRAY,
        };
        unsafe {
            let mut pid = 0u32;
            GetWindowThreadProcessId(GetForegroundWindow(), Some(&mut pid));
            if pid == std::process::id() {
                return;
            }
            // hidden in the tray there's no button
            for hwnd in windows_of(&app2).into_iter().filter(|h| IsWindowVisible(*h).as_bool()) {
                let info = FLASHWINFO {
                    cbSize: std::mem::size_of::<FLASHWINFO>() as u32,
                    hwnd,
                    dwFlags: FLASHW_TRAY,
                    uCount: 5,
                    dwTimeout: 0,
                };
                let _ = FlashWindowEx(&info);
            }
        }
    });
}

#[cfg(not(windows))]
fn show(_bar: Bar) {}
#[cfg(not(windows))]
fn flash_button() {}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(start: Instant, ms: u64) -> Instant {
        start + Duration::from_millis(ms)
    }

    #[test]
    fn short_work_shows_nothing() {
        let t = Instant::now();
        let mut b = Board::new();
        let id = b.start("AI edit", t);
        assert_eq!(b.look(at(t, 900)), (Bar::Off, false));
        b.end(id, false, at(t, 1000));
        assert_eq!(b.look(at(t, 1100)), (Bar::Off, false));
        assert_eq!(b.look(at(t, 9000)), (Bar::Off, false));
        assert!(b.quiet());
    }

    #[test]
    fn long_work_fills_the_bar_and_flashes_once() {
        let t = Instant::now();
        let mut b = Board::new();
        let id = b.start("removing watermarks", t);
        assert_eq!(b.look(at(t, 1500)).0, Bar::Running);
        b.progress(work_of("wm-progress"), 1, 4);
        assert_eq!(b.look(at(t, 2000)).0, Bar::Part(250));
        // another kind's event, and one without a total, change nothing
        b.progress(work_of("sd-progress"), 4, 4);
        b.progress(work_of("wm-progress"), 0, 0);
        assert_eq!(b.look(at(t, 2500)).0, Bar::Part(250));
        b.end(id, false, at(t, 20_000));
        // it might go on
        assert_eq!(b.look(at(t, 21_000)), (Bar::Part(250), false));
        assert_eq!(b.look(at(t, 23_100)), (Bar::Off, true));
        assert_eq!(b.look(at(t, 23_400)), (Bar::Off, false));
        assert!(b.quiet());
    }

    /// An import: several commands right after each other are one piece of work.
    #[test]
    fn steps_in_a_row_are_one_piece_of_work() {
        let t = Instant::now();
        let mut b = Board::new();
        let mut flashes = 0;
        let mut look = |b: &mut Board, ms| {
            let (bar, f) = b.look(at(t, ms));
            flashes += f as u32;
            bar
        };
        for k in 0..4u64 {
            let id = b.start("import", at(t, k * 3000));
            assert_ne!(look(&mut b, k * 3000 + 1500), Bar::Off);
            b.end(id, false, at(t, k * 3000 + 2000));
            assert_ne!(look(&mut b, k * 3000 + 2500), Bar::Off);
        }
        assert_eq!(look(&mut b, 14_500), Bar::Off);
        assert_eq!(flashes, 1);
    }

    /// "Make 5 at once": the window takes a while to come with the next try.
    #[test]
    fn tries_of_an_expand_flash_after_the_last_one() {
        let t = Instant::now();
        let mut b = Board::new();
        let a = b.start("AI expand", t);
        b.end(a, true, at(t, 10_000));
        assert_eq!(b.look(at(t, 18_000)).1, false);
        let c = b.start("AI expand", at(t, 20_000));
        b.end(c, false, at(t, 30_000));
        assert_eq!(b.look(at(t, 31_000)).1, false);
        assert_eq!(b.look(at(t, 33_100)), (Bar::Off, true));
        // stopped between two tries: not a minute of waiting
        let d = b.start("AI expand", at(t, 40_000));
        b.look(at(t, 45_000));
        b.end(d, true, at(t, 50_000));
        b.no_more();
        assert_eq!(b.look(at(t, 53_100)), (Bar::Off, true));
    }

    /// An expand done while a transport goes on: flashes at once, the bar stays.
    #[test]
    fn something_done_next_to_other_work_flashes_too() {
        let t = Instant::now();
        let mut b = Board::new();
        let sd = b.start("MiSD transport", t);
        b.progress(work_of("sd-progress"), 1, 2);
        let ex = b.start("AI expand", at(t, 1000));
        b.end(ex, false, at(t, 9000));
        assert_eq!(b.look(at(t, 9100)), (Bar::Part(500), true));
        // a short one doesn't, nor one of several of a kind
        let s = b.start("AI expand", at(t, 10_000));
        b.end(s, false, at(t, 11_000));
        let p1 = b.start("removing watermarks", at(t, 12_000));
        let p2 = b.start("removing watermarks", at(t, 12_000));
        b.end(p1, false, at(t, 20_000));
        assert_eq!(b.look(at(t, 20_100)).1, false);
        b.end(p2, false, at(t, 21_000));
        assert_eq!(b.look(at(t, 21_100)).1, true);
        b.end(sd, false, at(t, 60_000));
        assert_eq!(b.look(at(t, 64_000)), (Bar::Off, true));
    }

    /// A gap longer than the wait, nobody looked meanwhile: the old work still flashes.
    #[test]
    fn new_work_after_a_pause_is_its_own() {
        let t = Instant::now();
        let mut b = Board::new();
        let a = b.start("import", t);
        b.end(a, false, at(t, 8000));
        let c = b.start("import", at(t, 20_000));
        assert_eq!(b.look(at(t, 20_100)), (Bar::Off, true));
        b.end(c, false, at(t, 21_000));
        assert_eq!(b.look(at(t, 30_000)), (Bar::Off, false));
    }

    #[test]
    fn every_event_belongs_to_work_a_command_holds() {
        let src = include_str!("lib.rs");
        for event in [
            "scan-progress", "organize-progress", "fill-progress", "collection-move-progress", "expand-progress",
            "ai-model-progress", "alt-progress", "wm-progress", "encrypt-progress", "mega-progress", "sd-progress",
            "dup-progress",
        ] {
            let what = work_of(event);
            assert!(!what.is_empty() && src.contains(&format!("busy::hold(\"{what}\")")), "{event}: {what}");
            assert!(src.contains(&format!("\"{event}\"")), "{event} isn't sent");
        }
    }
}
