//! Window size and position: saved whenever an app window is moved or resized, the
//! main window opens there next time (a "New window" gets the size).
//!
//! In window.json in the app data folder, not in the database: it belongs to this PC's
//! screens, a restored backup on another setup would open off screen. A spot that isn't
//! on any screen anymore (monitor unplugged) is dropped, the window opens centered.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{Manager, PhysicalPosition, Runtime};

const FILE: &str = "window.json";
/// Saved once the window stood still this long (a drag sends many moves).
const SAVE_AFTER: Duration = Duration::from_millis(600);
/// This much of the top edge (where the window is dragged) has to be on a screen.
const GRIP_W: i64 = 120;
const GRIP_H: i64 = 32;

/// Physical pixels, the outer size (the inner one is off while the window isn't shown
/// yet: an undecorated window's hidden frame is only right after the first show).
/// width 0 = no normal size known (it was only seen maximized).
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Default)]
pub struct Geometry {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    maximized: bool,
}

/// A screen's work area (without the taskbar): x, y, width, height.
type Area = (i32, i32, u32, u32);

pub struct WinState {
    path: PathBuf,
    last: Mutex<Option<Geometry>>,
    saving: AtomicBool,
}

impl WinState {
    pub fn new(dir: &Path) -> Self {
        let path = dir.join(FILE);
        let last = std::fs::read_to_string(&path).ok().and_then(|s| serde_json::from_str(&s).ok());
        WinState { path, last: Mutex::new(last), saving: AtomicBool::new(false) }
    }

    fn saved(&self) -> Option<Geometry> {
        self.last.lock().ok().and_then(|g| *g)
    }
}

/// Where the window goes: the saved spot, made to fit the screens of today. None =
/// nothing usable, the window keeps its default.
fn fit(g: Geometry, areas: &[Area], primary: Option<Area>) -> Option<Geometry> {
    if g.width == 0 || g.height == 0 {
        return g.maximized.then_some(g);
    }
    let overlap = |a: &Area, x: i32, y: i32, w: u32, h: u32| {
        let (ax, ay, aw, ah) = (a.0 as i64, a.1 as i64, a.2 as i64, a.3 as i64);
        let w = (x as i64 + w as i64).min(ax + aw) - (x as i64).max(ax);
        let h = (y as i64 + h as i64).min(ay + ah) - (y as i64).max(ay);
        (w.max(0), h.max(0))
    };
    // the screen with the window's top edge on it
    let on = areas.iter().find(|a| {
        let (w, h) = overlap(a, g.x, g.y, g.width, GRIP_H as u32);
        w >= GRIP_W.min(g.width as i64) && h >= GRIP_H.min(g.height as i64)
    });
    match on {
        Some(a) => Some(Geometry { width: g.width.min(a.2), height: g.height.min(a.3), ..g }),
        // off screen: same size (as far as it fits), centered on the main screen
        None => {
            let a = primary.or_else(|| areas.first().copied())?;
            let (width, height) = (g.width.min(a.2), g.height.min(a.3));
            Some(Geometry {
                x: a.0 + ((a.2 - width) / 2) as i32,
                y: a.1 + ((a.3 - height) / 2) as i32,
                width,
                height,
                maximized: g.maximized,
            })
        }
    }
}

fn areas<R: Runtime, M: Manager<R>>(app: &M) -> (Vec<Area>, Option<Area>) {
    let area = |m: &tauri::Monitor| {
        let r = m.work_area();
        (r.position.x, r.position.y, r.size.width, r.size.height)
    };
    let all = app.app_handle().available_monitors().unwrap_or_default().iter().map(area).collect();
    let primary = app.app_handle().primary_monitor().ok().flatten().map(|m| area(&m));
    (all, primary)
}

/// Put a window that isn't shown yet where it was last time. `place`: also the
/// position and maximized (the main window), else only the size.
pub fn restore<R: Runtime>(window: &tauri::WebviewWindow<R>, place: bool) {
    let Some(state) = window.try_state::<WinState>() else { return };
    let Some(saved) = state.saved() else { return };
    let (all, primary) = areas(window);
    let Some(g) = fit(saved, &all, primary) else { return };
    if g.width > 0 {
        // position first: on a screen with another scaling the size would be rescaled
        if place {
            let _ = window.set_position(PhysicalPosition::new(g.x, g.y));
        }
        set_outer_size(window, g.width, g.height);
    }
    if place && g.maximized {
        // while hidden this only takes note, show() then opens it maximized
        let _ = window.maximize();
    }
}

#[cfg(windows)]
fn set_outer_size<R: Runtime>(window: &tauri::WebviewWindow<R>, width: u32, height: u32) {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{SetWindowPos, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOZORDER};
    let Ok(h) = window.hwnd() else { return };
    let flags = SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE;
    let _ = unsafe { SetWindowPos(HWND(h.0 as _), None, 0, 0, width as i32, height as i32, flags) };
}
#[cfg(not(windows))]
fn set_outer_size<R: Runtime>(window: &tauri::WebviewWindow<R>, width: u32, height: u32) {
    let _ = window.set_size(tauri::PhysicalSize::new(width, height));
}

/// An app window was moved or resized: saved once it stands still. Read then and not
/// now: while maximizing, Windows reports the move before the window counts as
/// maximized, and the full-screen frame would be taken for the normal size.
pub fn track<R: Runtime>(window: &tauri::Window<R>) {
    let Some(state) = window.try_state::<WinState>() else { return };
    if state.saving.swap(true, Ordering::AcqRel) {
        return;
    }
    let window = window.clone();
    std::thread::spawn(move || {
        std::thread::sleep(SAVE_AFTER);
        let state = window.state::<WinState>();
        state.saving.store(false, Ordering::Release);
        let Some(now) = current(&window, state.saved()) else { return };
        match state.last.lock() {
            Ok(mut last) if *last != Some(now) => *last = Some(now),
            _ => return,
        }
        if let Ok(json) = serde_json::to_string(&now) {
            if let Err(e) = std::fs::write(&state.path, json) {
                crate::elog!("micoll: window size not saved: {e}");
            }
        }
    });
}

/// Where the window is now. None while hidden (tray), minimized or full screen.
fn current<R: Runtime>(window: &tauri::Window<R>, before: Option<Geometry>) -> Option<Geometry> {
    if !window.is_visible().ok()? || window.is_minimized().ok()? || window.is_fullscreen().ok()? {
        return None;
    }
    if window.is_maximized().ok()? {
        // keep the normal size for the next start, only note "maximized"
        return Some(Geometry { maximized: true, ..before.unwrap_or_default() });
    }
    let (p, s) = (window.outer_position().ok()?, window.outer_size().ok()?);
    Some(Geometry { x: p.x, y: p.y, width: s.width, height: s.height, maximized: false })
}

#[cfg(test)]
mod tests {
    use super::*;

    const SCREEN: Area = (0, 0, 1920, 1040);
    const RIGHT: Area = (1920, 0, 2560, 1400);

    fn g(x: i32, y: i32, width: u32, height: u32) -> Geometry {
        Geometry { x, y, width, height, maximized: false }
    }

    #[test]
    fn keeps_a_spot_that_is_on_screen() {
        assert_eq!(fit(g(100, 80, 1280, 832), &[SCREEN], Some(SCREEN)), Some(g(100, 80, 1280, 832)));
        // on the second screen, partly hanging off the bottom is fine
        assert_eq!(fit(g(2500, 900, 1280, 832), &[SCREEN, RIGHT], Some(SCREEN)), Some(g(2500, 900, 1280, 832)));
    }

    #[test]
    fn moves_back_what_is_off_screen() {
        // the second screen is gone: centered on the main one
        assert_eq!(fit(g(2500, 100, 1280, 832), &[SCREEN], Some(SCREEN)), Some(g(320, 104, 1280, 832)));
        // only the bottom is visible, the top edge to drag it isn't
        assert_eq!(fit(g(100, -900, 1280, 832), &[SCREEN], Some(SCREEN)), Some(g(320, 104, 1280, 832)));
        // bigger than the screen now: shrunk to it
        assert_eq!(fit(g(5000, 0, 3000, 2000), &[SCREEN], Some(SCREEN)), Some(g(0, 0, 1920, 1040)));
        assert_eq!(fit(g(0, 0, 3000, 2000), &[SCREEN], Some(SCREEN)), Some(g(0, 0, 1920, 1040)));
    }

    #[test]
    fn maximized_without_a_size() {
        let m = Geometry { maximized: true, ..Geometry::default() };
        assert_eq!(fit(m, &[SCREEN], Some(SCREEN)), Some(m));
        assert_eq!(fit(Geometry::default(), &[SCREEN], Some(SCREEN)), None);
        let big = Geometry { maximized: true, ..g(-3000, 0, 1280, 832) };
        assert_eq!(fit(big, &[SCREEN], Some(SCREEN)), Some(Geometry { maximized: true, ..g(320, 104, 1280, 832) }));
    }
}
