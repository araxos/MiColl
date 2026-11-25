//! Windows' lock screen in the Wallpaper Hub: a hub slideshow can run there too, next to
//! (or instead of) one on the desktop. Windows has no slideshow for it a program can start,
//! so MiColl changes the picture itself, also from the tray; closed, the last one stays.
//!
//! Windows gets a finished picture of the screen's size (one way of fitting is all the lock
//! screen knows), never the library's file.

use crate::db::{self, DbLock};
use crate::{wallsets, Db};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Manager};

/// The slideshow on the lock screen ("" = none).
pub const ACTIVE_KEY: &str = "wallset_lock";
const STATE_KEY: &str = "wallset_lock_state";
/// How often the keeper looks whether the next picture is due.
const LOOK: std::time::Duration = std::time::Duration::from_secs(20);
/// Pictures read when one after the other turns out not to be one.
const TRIES: usize = 10;

/// One change at a time.
static CHANGING: Mutex<()> = Mutex::new(());
/// Where the finished pictures are (in MiColl's data folder).
static DIR: OnceLock<PathBuf> = OnceLock::new();

#[derive(Serialize, Deserialize, Default, Clone, Debug, PartialEq)]
#[serde(default)]
struct State {
    /// The picture on it (the file that's shown in MiColl) and its place in the order.
    last: String,
    pos: usize,
    /// The shuffled order.
    seed: u64,
    /// When it changed (unix seconds).
    at: i64,
    /// The finished picture's name.
    file: String,
    /// Windows said that this file is on the lock screen. Says it another one later, the
    /// user picked something else.
    seen: bool,
}

pub enum Step {
    Start(i64),
    Next,
    /// The same picture again (the fit changed).
    Same,
}

fn now() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

fn state(conn: &rusqlite::Connection) -> State {
    db::get_setting(conn, STATE_KEY)
        .ok()
        .flatten()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save(conn: &rusqlite::Connection, st: &State) -> Result<(), String> {
    let json = serde_json::to_string(st).map_err(|e| e.to_string())?;
    db::set_setting(conn, STATE_KEY, &json).map_err(|e| e.to_string())
}

fn active(conn: &rusqlite::Connection) -> Option<i64> {
    db::get_setting(conn, ACTIVE_KEY).ok().flatten()?.parse().ok()
}

/// The slideshow running on the lock screen (not when the user picked something else in
/// Windows since).
pub fn running(conn: &rusqlite::Connection) -> Option<i64> {
    let id = active(conn)?;
    (!replaced(&state(conn))).then_some(id)
}

fn replaced(st: &State) -> bool {
    st.seen && on_screen().is_some_and(|f| !f.eq_ignore_ascii_case(&st.file))
}

/// No slideshow anymore, the picture there stays.
pub fn stop(conn: &rusqlite::Connection) -> Result<(), String> {
    db::set_setting(conn, ACTIVE_KEY, "").map_err(|e| e.to_string())
}

/// The files in the order they come.
fn order<'a>(files: &'a [String], shuffle: bool, seed: u64) -> Vec<&'a String> {
    let mut out: Vec<&String> = files.iter().collect();
    if shuffle {
        use std::hash::{Hash, Hasher};
        out.sort_by_cached_key(|f| {
            let mut h = std::collections::hash_map::DefaultHasher::new();
            (seed, f.as_str()).hash(&mut h);
            h.finish()
        });
    }
    out
}

/// The picture after the last one. Every one comes once before one comes again.
fn advance(files: &[String], shuffle: bool, st: &mut State) -> Option<String> {
    if files.is_empty() {
        return None;
    }
    let mut list = order(files, shuffle, st.seed);
    let mut i = match list.iter().position(|f| **f == st.last) {
        Some(i) => i + 1,
        // (one that was taken out: what's at its place now)
        None if !st.last.is_empty() => st.pos,
        None => 0,
    };
    if i >= list.len() {
        st.seed = rand::random();
        list = order(files, shuffle, st.seed);
        i = usize::from(list.len() > 1 && *list[0] == st.last);
    }
    st.pos = i;
    st.last = list[i].clone();
    Some(st.last.clone())
}

/// The next picture that can be shown, finished. Only looks at files until it has one.
fn next_picture(
    files: &[String],
    shuffle: bool,
    st: &mut State,
    usable: &dyn Fn(&str) -> bool,
    make: &dyn Fn(&str) -> Result<Vec<u8>, String>,
) -> Result<Vec<u8>, String> {
    let mut why = "None of its pictures can be a wallpaper right now (missing, encrypted or not a picture).".to_string();
    let mut seen = std::collections::HashSet::new();
    let mut failed = 0;
    // (a shuffled round that starts over can bring one again that was seen already)
    for _ in 0..files.len() * 2 {
        let Some(next) = advance(files, shuffle, st) else { break };
        if !seen.insert(next.clone()) || !usable(&next) {
            continue;
        }
        match make(&next) {
            Ok(j) => return Ok(j),
            Err(e) => {
                why = e;
                failed += 1;
                if failed == TRIES {
                    break;
                }
            }
        }
    }
    Err(why)
}

/// The picture as the lock screen shows it: exactly the screen's size. fit: "fill" (cut to
/// the screen), "fit" (whole, black around it) or "stretch".
fn finished(path: &str, fit: &str, (w, h): (u32, u32)) -> Result<Vec<u8>, String> {
    use image::imageops::FilterType::CatmullRom;
    let (img, _) = crate::wm_load(path, None)?;
    let img = image::DynamicImage::ImageRgba8(img);
    let img = match fit {
        "fit" => img.resize(w, h, CatmullRom),
        "stretch" => img.resize_exact(w, h, CatmullRom),
        _ => img.resize_to_fill(w, h, CatmullRom),
    };
    let mut out = image::RgbaImage::from_pixel(w, h, image::Rgba([0, 0, 0, 255]));
    let at = (i64::from(w.saturating_sub(img.width()) / 2), i64::from(h.saturating_sub(img.height()) / 2));
    image::imageops::overlay(&mut out, &img.to_rgba8(), at.0, at.1);
    let mut jpeg = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg, 92)
        .encode_image(&image::DynamicImage::ImageRgba8(out).to_rgb8())
        .map_err(|e| e.to_string())?;
    Ok(jpeg)
}

#[cfg(target_os = "windows")]
fn screen_size() -> (u32, u32) {
    use windows::Win32::UI::WindowsAndMessaging::{GetSystemMetrics, SM_CXSCREEN, SM_CYSCREEN};
    let (w, h) = unsafe { (GetSystemMetrics(SM_CXSCREEN), GetSystemMetrics(SM_CYSCREEN)) };
    if w > 0 && h > 0 {
        (w as u32, h as u32)
    } else {
        (1920, 1080)
    }
}
#[cfg(not(target_os = "windows"))]
fn screen_size() -> (u32, u32) {
    (1920, 1080)
}

/// A WinRT call on a thread of its own (the caller's may belong to a window).
#[cfg(target_os = "windows")]
fn apart<T: Send>(f: impl FnOnce() -> windows::core::Result<T> + Send) -> Result<T, String> {
    std::thread::scope(|s| s.spawn(|| f().map_err(|e| e.message())).join())
        .unwrap_or_else(|_| Err("the lock screen call crashed".into()))
}

/// The name of the picture Windows says is on the lock screen.
fn on_screen() -> Option<String> {
    #[cfg(target_os = "windows")]
    {
        use windows::Win32::Foundation::E_FAIL;
        use windows::System::UserProfile::LockScreen;
        let uri = apart(|| LockScreen::OriginalImageFile()?.Path().map_err(|_| E_FAIL.into())).ok()?;
        uri.to_string().rsplit('/').next().map(str::to_string)
    }
    #[cfg(not(target_os = "windows"))]
    None
}

fn put_on_screen(file: &Path) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use windows::core::HSTRING;
        use windows::Storage::StorageFile;
        use windows::System::UserProfile::LockScreen;
        let path = HSTRING::from(file.as_os_str());
        apart(move || {
            let f = StorageFile::GetFileFromPathAsync(&path)?.get()?;
            LockScreen::SetImageFileAsync(&f)?.get()
        })?;
    }
    #[cfg(not(target_os = "windows"))]
    let _ = file;
    Ok(())
}

/// Only what's made here: "1764058000123.jpg".
fn is_ours(name: &str) -> bool {
    name.strip_suffix(".jpg").is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
}

/// Keep only the picture that's on the lock screen.
fn tidy(dir: &Path, keep: &str) {
    for e in std::fs::read_dir(dir).into_iter().flatten().flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        if name != keep && is_ours(&name) {
            let _ = std::fs::remove_file(e.path());
        }
    }
}

fn folder() -> Result<&'static Path, String> {
    let dir = DIR.get().ok_or("The lock screen folder isn't ready yet.")?;
    std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    Ok(dir)
}

/// Put a finished picture on the lock screen. Returns its name.
fn place(dir: &Path, jpeg: &[u8]) -> Result<String, String> {
    // a new name each time, Windows keeps the old picture under a known one
    let name = format!(
        "{}.jpg",
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0)
    );
    let file = dir.join(&name);
    std::fs::write(&file, jpeg).map_err(|e| format!("{}: {e}", file.display()))?;
    if let Err(e) = put_on_screen(&file) {
        let _ = std::fs::remove_file(&file);
        return Err(format!("Windows didn’t take it: {e}"));
    }
    tidy(dir, &name);
    Ok(name)
}

/// One picture, it ends a slideshow there.
pub fn picture(app: &AppHandle, path: &str) -> Result<(), String> {
    if crate::crypto::file_is_encrypted(Path::new(path)) {
        return Err("This picture is encrypted.".into());
    }
    let _one = CHANGING.lock().unwrap_or_else(|e| e.into_inner());
    let jpeg = finished(path, "fill", screen_size())?;
    place(folder()?, &jpeg)?;
    stop(&app.state::<Db>().conn())
}

/// The next picture if a slideshow runs there (the screen saver came: locking the PC after
/// it shows another one).
pub fn next_if_running(app: &AppHandle) {
    let runs = running(&app.state::<Db>().conn()).is_some();
    if runs {
        if let Err(e) = change(app, Step::Next) {
            crate::elog!("micoll: lock screen: {e}");
        }
    }
}

/// Change the picture. Takes a moment (a big picture is decoded), so never on the window's
/// thread.
pub fn change(app: &AppHandle, step: Step) -> Result<(), String> {
    let _one = CHANGING.lock().unwrap_or_else(|e| e.into_inner());
    let db = app.state::<Db>();
    let (id, files, fit, shuffle, mut st) = {
        let conn = db.conn();
        let id = match step {
            Step::Start(id) => id,
            _ => active(&conn).ok_or("No slideshow runs on the lock screen.")?,
        };
        let (_, fit, shuffle) =
            wallsets::get(&conn, id).map_err(|e| e.to_string())?.ok_or("That slideshow is gone.")?;
        // only the names: the files are looked at one by one, without the database
        let files = wallsets::listed(&conn, id, false).map_err(|e| e.to_string())?;
        let st = match step {
            Step::Start(_) => State { seed: rand::random(), ..Default::default() },
            _ => state(&conn),
        };
        (id, files, fit, shuffle, st)
    };
    let dir = folder()?;
    let size = screen_size();
    let make = |p: &str| finished(p, &fit, size);
    let same = matches!(step, Step::Same) && files.contains(&st.last) && wallsets::usable(&st.last);
    let jpeg = match same.then(|| make(&st.last).ok()).flatten() {
        Some(j) => j,
        None => next_picture(&files, shuffle, &mut st, &wallsets::usable, &make)?,
    };
    let name = place(dir, &jpeg)?;
    st.at = now();
    st.seen = on_screen().is_some_and(|f| f.eq_ignore_ascii_case(&name));
    st.file = name;
    let conn = db.conn();
    // stopped meanwhile: it stays stopped
    if !matches!(step, Step::Start(_)) && active(&conn) != Some(id) {
        return Ok(());
    }
    save(&conn, &st)?;
    db::set_setting(&conn, ACTIVE_KEY, &id.to_string()).map_err(|e| e.to_string())
}

/// Is the next picture due?
fn due(st: &State, minutes: i64, now: i64) -> bool {
    // (a clock that was set back mustn't hold it forever)
    now >= st.at + minutes * 60 || st.at > now + 60
}

/// Changes the picture while MiColl runs.
pub fn keep(app: AppHandle, data_dir: &Path) {
    let _ = DIR.set(data_dir.join("lock-screen"));
    std::thread::spawn(move || loop {
        std::thread::sleep(LOOK);
        let Some(db) = app.try_state::<Db>() else { continue };
        let st = {
            let conn = db.conn();
            let Some(id) = active(&conn) else { continue };
            let Ok(Some((minutes, _, _))) = wallsets::get(&conn, id) else { continue };
            let st = state(&conn);
            if !due(&st, minutes, now()) {
                continue;
            }
            st
        };
        // the user picked something else in Windows: that stays
        if replaced(&st) {
            let _ = stop(&db.conn());
            continue;
        }
        if let Err(e) = change(&app, Step::Next) {
            crate::elog!("micoll: lock screen: {e}");
            // not again every few seconds
            let conn = db.conn();
            let _ = save(&conn, &State { at: now(), ..state(&conn) });
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn files(n: usize) -> Vec<String> {
        (0..n).map(|i| format!("C:\\p\\{i}.jpg")).collect()
    }

    #[test]
    fn every_picture_comes_once_before_one_comes_again() {
        let f = files(7);
        for shuffle in [false, true] {
            let mut st = State { seed: 5, ..Default::default() };
            let mut before = String::new();
            for _ in 0..4 {
                let round: Vec<String> = (0..7).map(|_| advance(&f, shuffle, &mut st).unwrap()).collect();
                if !shuffle {
                    assert_eq!(round, f);
                }
                assert_ne!(round[0], before, "never the same twice in a row");
                before = round[6].clone();
            }
        }
        // (only a round that begins with the last one starts one later, so count two
        // rounds from the start)
        let mut st = State { seed: 9, ..Default::default() };
        let first: std::collections::HashSet<String> =
            (0..7).map(|_| advance(&f, true, &mut st).unwrap()).collect();
        assert_eq!(first.len(), 7);
    }

    #[test]
    fn a_picture_that_was_taken_out_or_added_does_not_start_over() {
        let mut f = files(5);
        let mut st = State::default();
        for _ in 0..3 {
            advance(&f, false, &mut st);
        }
        assert_eq!(st.last, f[2]);
        f.remove(2);
        assert_eq!(advance(&f, false, &mut st).unwrap(), "C:\\p\\3.jpg");
        f.push("C:\\p\\new.jpg".into());
        assert_eq!(advance(&f, false, &mut st).unwrap(), "C:\\p\\4.jpg");
        assert_eq!(advance(&f, false, &mut st).unwrap(), "C:\\p\\new.jpg");
        // one picture just stays, none is none
        let one = files(1);
        let mut st = State::default();
        assert_eq!(advance(&one, true, &mut st).unwrap(), one[0]);
        assert_eq!(advance(&one, true, &mut st).unwrap(), one[0]);
        assert!(advance(&[], true, &mut st).is_none());
    }

    #[test]
    fn only_files_up_to_the_next_good_one_are_looked_at() {
        let f = files(100);
        let looked = std::cell::RefCell::new(Vec::new());
        let get = |st: &mut State, good: &dyn Fn(&str) -> bool| {
            looked.borrow_mut().clear();
            let usable = |p: &str| {
                looked.borrow_mut().push(p.to_string());
                good(p)
            };
            next_picture(&f, false, st, &usable, &|p| Ok(p.as_bytes().to_vec())).map(|b| String::from_utf8(b).unwrap())
        };
        let mut st = State::default();
        assert_eq!(get(&mut st, &|_| true).unwrap(), f[0]);
        assert_eq!(get(&mut st, &|_| true).unwrap(), f[1]);
        assert_eq!(*looked.borrow(), [f[1].clone()], "one file, not the whole slideshow");
        // more missing ones in a row than it would read
        assert_eq!(get(&mut st, &|p| p == f[40]).unwrap(), f[40]);
        assert_eq!(looked.borrow().len(), 39);
        // it goes round, also back to the same one
        assert_eq!(get(&mut st, &|p| p == f[3]).unwrap(), f[3]);
        assert_eq!(get(&mut st, &|p| p == f[3]).unwrap(), f[3]);
        assert!(get(&mut st, &|_| false).unwrap_err().starts_with("None of its pictures"));
        // broken pictures: not all of them are read
        let read = std::cell::Cell::new(0);
        let broken = |_: &str| {
            read.set(read.get() + 1);
            Err("broken".to_string())
        };
        assert_eq!(next_picture(&f, true, &mut State::default(), &|_| true, &broken).unwrap_err(), "broken");
        assert_eq!(read.get(), TRIES);
        assert!(next_picture(&[], true, &mut State::default(), &|_| true, &broken).is_err());
    }

    #[test]
    fn the_next_picture_is_due_after_its_minutes() {
        let st = State { at: 1000, ..Default::default() };
        assert!(!due(&st, 10, 1000 + 599));
        assert!(due(&st, 10, 1000 + 600));
        // never shown, and a clock that went back
        assert!(due(&State::default(), 1440, now()));
        assert!(due(&State { at: 5000, ..Default::default() }, 10, 1000));
    }

    #[test]
    fn the_finished_picture_has_the_screens_size() {
        let dir = std::env::temp_dir().join(format!("micoll_lock_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let at = dir.join("tall.png");
        // red on top, blue below
        image::RgbImage::from_fn(200, 400, |_, y| image::Rgb(if y < 200 { [220, 0, 0] } else { [0, 0, 220] }))
            .save(&at)
            .unwrap();
        let show = |fit: &str| {
            let j = finished(&at.to_string_lossy(), fit, (320, 180)).unwrap();
            image::load_from_memory(&j).unwrap().to_rgb8()
        };
        for fit in ["fill", "fit", "stretch"] {
            assert_eq!(show(fit).dimensions(), (320, 180), "{fit}");
        }
        let black = |p: &image::Rgb<u8>| p.0.iter().all(|v| *v < 25);
        // whole: black beside it, the picture in the middle
        let f = show("fit");
        assert!(black(f.get_pixel(5, 90)) && !black(f.get_pixel(160, 20)) && !black(f.get_pixel(160, 160)));
        // cut or stretched: nothing black
        for fit in ["fill", "stretch"] {
            let p = show(fit);
            assert!([(2, 2), (317, 2), (2, 177), (317, 177)].iter().all(|&(x, y)| !black(p.get_pixel(x, y))), "{fit}");
        }
        // only its own files are tidied up
        for n in ["17640.jpg", "17650.jpg", "holiday.jpg", "1764.png", ".jpg"] {
            std::fs::write(dir.join(n), b"x").unwrap();
        }
        tidy(&dir, "17650.jpg");
        let left = |n: &str| dir.join(n).exists();
        assert!(!left("17640.jpg") && left("17650.jpg") && left("holiday.jpg") && left("1764.png") && left(".jpg"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_stopped_slideshow_runs_no_more() {
        let dir = std::env::temp_dir().join(format!("micoll_lockset_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let c = db::open(&dir.join("t.db")).unwrap();
        assert_eq!(running(&c), None);
        db::set_setting(&c, ACTIVE_KEY, "4").unwrap();
        let st = State { last: "a".into(), pos: 2, seed: u64::MAX, at: 7, file: "1.jpg".into(), seen: false };
        save(&c, &st).unwrap();
        assert_eq!((running(&c), state(&c)), (Some(4), st));
        stop(&c).unwrap();
        assert_eq!(running(&c), None);
        drop(c);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
