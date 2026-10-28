//! The inbox folder (Settings → Library → Inbox): a folder the user saves downloads to.
//! MiColl looks in it at start and when the window comes to the front, and offers to
//! import what's new. No watcher in the background.
//!
//! New = a file or folder at its top level that isn't half downloaded, isn't still being
//! written, isn't in the library already and wasn't imported from the inbox before
//! (SEEN_KEY, by name, size and time, so a new download with the same name counts again).

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use serde::Serialize;

/// Setting: the inbox folder ("" or missing = off).
pub const FOLDER_KEY: &str = "inbox_folder";
/// Setting: JSON list of the keys already imported from the inbox.
pub const SEEN_KEY: &str = "inbox_seen";

/// Younger than this, a file may still be written (a download that just finished, a
/// copy in progress). The next look picks it up.
const SETTLE: Duration = Duration::from_secs(4);

/// Endings of downloads that aren't done (Chrome/Edge, Firefox, Safari, Opera, uTorrent,
/// WinSCP, aria2, IDM and others).
const PARTIAL: &[&str] = &["crdownload", "part", "partial", "download", "opdownload", "tmp", "!ut", "filepart", "aria2", "temp"];

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct InboxItem {
    pub path: String,
    pub name: String,
    /// What it's remembered by once imported: name, size and modified time.
    pub key: String,
    pub is_dir: bool,
}

fn ext_of(p: &Path) -> String {
    p.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default()
}

/// Not a download of its own: half done, hidden, or Windows' own files.
fn skip_name(p: &Path) -> bool {
    let name = p.file_name().map(|n| n.to_string_lossy().to_lowercase()).unwrap_or_default();
    name.is_empty()
        || name.starts_with('.')
        || name.starts_with("~$")
        || name == "desktop.ini"
        || name == "thumbs.db"
        || PARTIAL.contains(&ext_of(p).as_str())
}

fn modified(p: &Path) -> Option<SystemTime> {
    std::fs::metadata(p).and_then(|m| m.modified()).ok()
}

/// Still on its way in: changed just now, or (a folder) has a half-done file inside.
fn still_coming(p: &Path, now: SystemTime) -> bool {
    let fresh = |t: Option<SystemTime>| t.is_some_and(|t| now.duration_since(t).unwrap_or_default() < SETTLE);
    if !p.is_dir() {
        return fresh(modified(p));
    }
    walkdir::WalkDir::new(p).into_iter().flatten().any(|e| {
        let q = e.path();
        fresh(modified(q)) || (e.file_type().is_file() && PARTIAL.contains(&ext_of(q).as_str()))
    })
}

/// Paths compare without case and slash direction.
fn norm(p: &Path) -> String {
    p.to_string_lossy().replace('/', "\\").trim_end_matches('\\').to_lowercase()
}

/// What's new in `dir`, oldest first. `known` = folders the library has (roots, periods,
/// rewards): an entry that is one of them or holds one is in the library already.
pub fn scan(dir: &Path, seen: &HashSet<String>, known: &[PathBuf], now: SystemTime) -> Vec<InboxItem> {
    let Ok(entries) = std::fs::read_dir(dir) else { return Vec::new() };
    let known: Vec<String> = known.iter().map(|k| norm(k)).collect();
    let mut out: Vec<(SystemTime, InboxItem)> = Vec::new();
    let names: HashSet<String> = std::fs::read_dir(dir)
        .map(|r| r.flatten().map(|e| e.file_name().to_string_lossy().to_lowercase()).collect())
        .unwrap_or_default();
    for e in entries.flatten() {
        let p = e.path();
        let Ok(meta) = e.metadata() else { continue };
        if skip_name(&p) || (!meta.is_dir() && meta.len() == 0) {
            continue;
        }
        // Firefox writes "x.zip" and "x.zip.part" side by side until it's done
        let name = e.file_name().to_string_lossy().to_string();
        let lower = name.to_lowercase();
        if PARTIAL.iter().any(|x| names.contains(&format!("{lower}.{x}"))) {
            continue;
        }
        if still_coming(&p, now) {
            continue;
        }
        let here = norm(&p);
        let inside = format!("{here}\\");
        if known.iter().any(|k| *k == here || k.starts_with(&inside)) {
            continue;
        }
        let at = meta.modified().unwrap_or(SystemTime::UNIX_EPOCH);
        let secs = at.duration_since(SystemTime::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
        let key = format!("{name}|{}|{secs}", if meta.is_dir() { 0 } else { meta.len() });
        if seen.contains(&key) {
            continue;
        }
        out.push((at, InboxItem { path: p.to_string_lossy().to_string(), name, key, is_dir: meta.is_dir() }));
    }
    out.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.name.cmp(&b.1.name)));
    out.into_iter().map(|(_, i)| i).collect()
}

/// The saved keys of what was imported from the inbox.
pub fn load_seen(conn: &rusqlite::Connection) -> HashSet<String> {
    crate::db::get_setting(conn, SEEN_KEY)
        .ok()
        .flatten()
        .and_then(|s| serde_json::from_str::<Vec<String>>(&s).ok())
        .unwrap_or_default()
        .into_iter()
        .collect()
}

/// Remember keys as imported. Keys whose file has left the inbox are dropped, so the
/// list doesn't grow forever.
pub fn mark_seen(conn: &rusqlite::Connection, dir: Option<&Path>, keys: &[String]) -> rusqlite::Result<()> {
    let mut seen = load_seen(conn);
    seen.extend(keys.iter().cloned());
    if let Some(dir) = dir {
        // everything in the folder now, imported or not
        let later = SystemTime::now() + Duration::from_secs(86_400);
        let present: HashSet<String> = scan(dir, &HashSet::new(), &[], later)
            .into_iter()
            .map(|i| i.key)
            .collect();
        seen.retain(|k| present.contains(k));
    }
    let mut list: Vec<String> = seen.into_iter().collect();
    list.sort();
    crate::db::set_setting(conn, SEEN_KEY, &serde_json::to_string(&list).unwrap_or_else(|_| "[]".into()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("micoll-inbox-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn only_finished_new_downloads_count() {
        let d = tmp("scan");
        let w = |name: &str, body: &[u8]| std::fs::write(d.join(name), body).unwrap();
        w("Mira - Set.zip", b"zip");
        w("half.zip.crdownload", b"x");
        w("ff.zip", b"x"); // Firefox: the final name already there, still writing
        w("ff.zip.part", b"x");
        w("empty.png", b"");
        w("desktop.ini", b"x");
        w(".hidden", b"x");
        std::fs::create_dir_all(d.join("Folder Set")).unwrap();
        std::fs::write(d.join("Folder Set").join("01.png"), b"png").unwrap();
        std::fs::create_dir_all(d.join("Coming")).unwrap();
        std::fs::write(d.join("Coming").join("02.png.part"), b"x").unwrap();
        // a folder the library has already (imported in place)
        std::fs::create_dir_all(d.join("In Library").join("R")).unwrap();
        std::fs::write(d.join("In Library").join("R").join("a.png"), b"png").unwrap();
        let known = [d.join("IN LIBRARY").join("R")];
        let later = SystemTime::now() + Duration::from_secs(60);

        let names = |items: Vec<InboxItem>| items.into_iter().map(|i| i.name).collect::<Vec<_>>();
        let mut got = names(scan(&d, &HashSet::new(), &known, later));
        got.sort();
        assert_eq!(got, ["Folder Set", "Mira - Set.zip"]);
        // right after it landed it's left for the next look
        assert!(scan(&d, &HashSet::new(), &known, SystemTime::now()).is_empty());

        // imported once: not offered again, a new download with the same name is
        let items = scan(&d, &HashSet::new(), &known, later);
        let zip = items.iter().find(|i| i.name == "Mira - Set.zip").unwrap().key.clone();
        let seen: HashSet<String> = [zip].into();
        assert_eq!(names(scan(&d, &seen, &known, later)), ["Folder Set"]);
        w("Mira - Set.zip", b"a longer zip");
        assert_eq!(scan(&d, &seen, &known, later).len(), 2);
        let _ = std::fs::remove_dir_all(&d);
    }
}
