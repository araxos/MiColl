//! Optional error log (Settings → Feedback → "Error log").
//!
//! Nothing is written until the user turns it on. Then errors and warnings from both
//! sides (Rust and the webview) go to `<data>/logs/micoll-YYYY-MM-DD.log`, one file per
//! day, the last LOG_DAYS days kept. Turning it off deletes the folder.
//! The feedback form can attach the recent lines, with the user folder replaced by
//! %USERPROFILE% so the Windows account name doesn't go along.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};

/// Settings key (the frontend reads it too).
pub const SETTING_KEY: &str = "log_enabled";
/// Days of log files kept.
const LOG_DAYS: u64 = 7;
/// Lines the feedback form gets at most (newest).
const RECENT_LINES: usize = 200;
/// One message is cut here (a whole data URL in an error would bloat the file).
const MAX_MESSAGE: usize = 2000;

static ON: AtomicBool = AtomicBool::new(false);
static DIR: OnceLock<PathBuf> = OnceLock::new();
/// Serializes writes from different threads.
static WRITE: Mutex<()> = Mutex::new(());

/// Set the folder and the saved on/off state, and catch Rust panics from now on.
/// Called once at startup.
pub fn init(data_dir: &Path, on: bool) {
    let _ = DIR.set(data_dir.join("logs"));
    ON.store(on, Ordering::Relaxed);
    if on {
        prune();
    }
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let place = info
            .location()
            .map(|l| format!(" at {}:{}", l.file(), l.line()))
            .unwrap_or_default();
        let msg = info
            .payload()
            .downcast_ref::<&str>()
            .map(|s| s.to_string())
            .or_else(|| info.payload().downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "panic".into());
        write("PANIC", "rust", &format!("{msg}{place}"));
        previous(info);
    }));
}

pub fn enabled() -> bool {
    ON.load(Ordering::Relaxed)
}

/// Turn logging on or off. Off deletes every log file.
pub fn set_enabled(on: bool) -> Result<(), String> {
    ON.store(on, Ordering::Relaxed);
    let Some(dir) = DIR.get() else { return Ok(()) };
    if on {
        prune();
        Ok(())
    } else if dir.exists() {
        std::fs::remove_dir_all(dir).map_err(|e| format!("Couldn’t delete the logs ({e})."))
    } else {
        Ok(())
    }
}

/// The logs folder (made on demand, for "Open log folder").
pub fn dir() -> Option<PathBuf> {
    DIR.get().cloned()
}

/// Append one line, if logging is on. Never fails loudly: a log must not break the app.
pub fn write(level: &str, source: &str, message: &str) {
    if !enabled() {
        return;
    }
    let Some(dir) = DIR.get() else { return };
    let (date, time) = now_utc();
    let mut msg: String = message.chars().take(MAX_MESSAGE).collect();
    if msg.len() < message.len() {
        msg.push('…');
    }
    // one entry per line
    let msg = msg.replace(['\r', '\n'], " ");
    let _guard = WRITE.lock();
    if std::fs::create_dir_all(dir).is_err() {
        return;
    }
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join(format!("micoll-{date}.log")))
    {
        let _ = writeln!(f, "{date} {time}Z [{level}] [{source}] {msg}");
    }
}

/// The newest lines over all kept days, user folder hidden. "" when there are none.
pub fn recent() -> String {
    let Some(dir) = DIR.get() else { return String::new() };
    let mut files: Vec<PathBuf> = log_files(dir);
    files.sort();
    let mut lines: Vec<String> = Vec::new();
    for f in files {
        if let Ok(text) = std::fs::read_to_string(&f) {
            lines.extend(text.lines().map(str::to_string));
        }
    }
    let start = lines.len().saturating_sub(RECENT_LINES);
    anonymize(&lines[start..].join("\n"))
}

/// Replace the Windows user folder (both slash styles) with %USERPROFILE%.
fn anonymize(text: &str) -> String {
    let Ok(home) = std::env::var("USERPROFILE") else { return text.to_string() };
    if home.len() < 4 {
        return text.to_string();
    }
    let mut out = text.to_string();
    for variant in [home.clone(), home.replace('\\', "/"), home.replace('\\', "\\\\")] {
        out = replace_ignore_case(&out, &variant, "%USERPROFILE%");
    }
    out
}

fn replace_ignore_case(text: &str, needle: &str, with: &str) -> String {
    let lower = text.to_lowercase();
    let n = needle.to_lowercase();
    // to_lowercase can change byte lengths for some letters: then only exact matches
    if lower.len() != text.len() || n.len() != needle.len() {
        return text.replace(needle, with);
    }
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    while let Some(pos) = lower[i..].find(&n) {
        out.push_str(&text[i..i + pos]);
        out.push_str(with);
        i += pos + n.len();
    }
    out.push_str(&text[i..]);
    out
}

fn log_files(dir: &Path) -> Vec<PathBuf> {
    std::fs::read_dir(dir)
        .map(|rd| {
            rd.flatten()
                .map(|e| e.path())
                .filter(|p| {
                    p.file_name()
                        .and_then(|n| n.to_str())
                        .is_some_and(|n| n.starts_with("micoll-") && n.ends_with(".log"))
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Delete day files older than LOG_DAYS (by their date in the name).
fn prune() {
    let Some(dir) = DIR.get() else { return };
    let today = days_since_epoch();
    for p in log_files(dir) {
        let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
        let date = name.trim_start_matches("micoll-").trim_end_matches(".log");
        if let Some(day) = parse_day(date) {
            if today.saturating_sub(day) >= LOG_DAYS {
                let _ = std::fs::remove_file(&p);
            }
        }
    }
}

fn days_since_epoch() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() / 86_400)
        .unwrap_or(0)
}

/// ("YYYY-MM-DD", "HH:MM:SS") in UTC.
fn now_utc() -> (String, String) {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let (y, m, d) = civil_from_days((secs / 86_400) as i64);
    let s = secs % 86_400;
    (
        format!("{y:04}-{m:02}-{d:02}"),
        format!("{:02}:{:02}:{:02}", s / 3600, s / 60 % 60, s % 60),
    )
}

/// Days since 1970-01-01 -> (year, month, day) (Howard Hinnant's algorithm).
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let y = yoe + era * 400 + i64::from(m <= 2);
    (y, m, d)
}

/// "YYYY-MM-DD" -> days since 1970-01-01.
fn parse_day(s: &str) -> Option<u64> {
    let mut it = s.split('-');
    let y: i64 = it.next()?.parse().ok()?;
    let m: i64 = it.next()?.parse().ok()?;
    let d: i64 = it.next()?.parse().ok()?;
    // inverse of civil_from_days
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y.rem_euclid(400);
    let mp = if m > 2 { m - 3 } else { m + 9 };
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    u64::try_from(era * 146_097 + doe - 719_468).ok()
}

/// eprintln! that also goes to the error log (when it's on).
#[macro_export]
macro_rules! elog {
    ($($arg:tt)*) => {{
        let m = format!($($arg)*);
        eprintln!("{m}");
        $crate::applog::write("ERROR", "rust", &m);
    }};
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dates_round_trip() {
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(civil_from_days(20_740), (2026, 10, 14));
        assert_eq!(parse_day("2026-10-14"), Some(20_740));
        assert_eq!(parse_day("2024-02-29").map(|d| civil_from_days(d as i64)), Some((2024, 2, 29)));
        assert_eq!(parse_day("nope"), None);
    }

    #[test]
    fn user_folder_is_hidden() {
        assert_eq!(
            replace_ignore_case(r"read C:\Users\ONI\a.png and c:\users\oni\b", r"C:\Users\ONI", "%USERPROFILE%"),
            r"read %USERPROFILE%\a.png and %USERPROFILE%\b"
        );
    }
}
