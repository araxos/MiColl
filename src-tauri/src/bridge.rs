//! Phone bridge: the PC side of the MiColl phone app, built in (it used to be the
//! separate "MiColl Bridge" program).
//!
//! While it's on, the managed collection (<collection_root>\MiColl) is served over
//! the local network, read-only: the gallery as JSON, thumbnails and the files. The
//! phone's paths are relative to that folder, so a download lands at the same place
//! in the phone's own library.
//!
//! Every request needs the pairing key: the urls look like /k/<key>/api/... and the
//! QR code in Settings carries the key, so somebody else on the same Wi-Fi gets
//! nothing. A new key unpairs every phone. Encrypted files are decrypted on the fly,
//! and the app turns the bridge off while MiColl is locked.
//!
//! A device that tries many different wrong keys is shut out for a while, and the
//! bridge doesn't answer devices on a network Windows calls public (café, hotel …),
//! unless the user allowed that network in Settings.
//!
//! The phone can also send pictures back (PUT /api/upload) and edited versions of a
//! picture (PUT /api/version). An upload never replaces a file: same content is
//! skipped, a different file with the same name gets "name (2).jpg". A version is only
//! added, the original stays the active one. POST /api/check asks first (path + SHA-256),
//! so files that are already here don't get sent at all.
//!
//! The other way the phone gets the versions made here: /api/gallery counts them per
//! picture, /api/versions lists one picture's, /api/version-file sends one.
//! The gallery also carries each reward's tier and each creator's tier list.
//!
//! What came from the phone goes into the history (action "phone"), one row for the
//! files and one for the versions of each batch, and can be undone from there.

use crate::{app_cache, crypto, db, history, indexer, map_err, media_mime, parse_range, read_window, session_key, Db, DekState, RANGE_CHUNK};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::io::{Read, Seek, SeekFrom, Write};
use std::net::{IpAddr, Ipv4Addr};
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State};

/// The phone app uses this port when none is typed.
const PORT: u16 = 8787;
/// Setting with the pairing key.
const KEY_SETTING: &str = "phone_bridge_key";
/// Server threads (a playing video keeps one busy).
const WORKERS: usize = 6;
/// Biggest file the phone may send.
const MAX_UPLOAD: usize = 4 * 1024 * 1024 * 1024;
/// Room the drive keeps after an upload.
const KEEP_FREE: u64 = 256 * 1024 * 1024;
/// A device that tries this many different wrong keys within MISS_WINDOW is shut
/// out for BLOCK_FOR. A phone with an old key repeats the same one, that counts once.
const MISS_LIMIT: usize = 10;
const MISS_WINDOW: Duration = Duration::from_secs(60);
const BLOCK_FOR: Duration = Duration::from_secs(5 * 60);
/// Setting with the public networks the bridge answers on anyway (network ids,
/// comma separated).
const TRUSTED_SETTING: &str = "phone_bridge_trusted_networks";
/// MiColl re-reads a creator once the phone stopped sending for this long (the
/// phone sends one file after the other, a big one takes a moment).
const SETTLE: std::time::Duration = std::time::Duration::from_millis(3000);

/* ---- gallery (camelCase, the phone's types.ts) ------------------------- */

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ImageDto {
    id: String,
    src: String,
    /// relative to the collection folder, forward slashes
    path: String,
    name: String,
    kind: String,
    /// how many edited versions MiColl has of it (left out when none)
    #[serde(skip_serializing_if = "Option::is_none")]
    versions: Option<usize>,
}
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct RewardDto {
    id: String,
    title: String,
    category: Option<String>,
    folder_path: String,
    cover: String,
    images: Vec<ImageDto>,
    status: String,
    /// the creator's tier it came with ("2", "Gold"; left out when none is set)
    #[serde(skip_serializing_if = "Option::is_none")]
    tier: Option<String>,
}
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct MonthDto {
    id: String,
    month: Option<u32>,
    year: Option<i32>,
    label: String,
    span: u32,
    skipped: bool,
    verified: bool,
    preview_path: String,
    cover_image: Option<String>,
    official_total: Option<usize>,
    rewards: Vec<RewardDto>,
    platform: Option<String>,
    needs_review: bool,
    /// month folder, the phone names its folders after it
    folder_path: String,
}
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct PlatformDto {
    id: String,
    name: String,
    months: Vec<MonthDto>,
}
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ArtistDto {
    id: String,
    name: String,
    preview_path: String,
    platforms: Vec<PlatformDto>,
    kind: Option<String>,
    // creator details from the database
    tag: Option<String>,
    tags: Vec<String>,
    links: Vec<LinkDto>,
    notes: Option<String>,
    aliases: Vec<String>,
    verified: bool,
    no_dates: bool,
    /// the creator's tiers (Details → Tiers)
    tiers: Vec<String>,
}
#[derive(Serialize, serde::Deserialize, Clone)]
struct LinkDto {
    label: String,
    url: String,
}

#[derive(Default, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Meta {
    kind: Option<String>,
    tag: Option<String>,
    tags: Vec<String>,
    links: Vec<LinkDto>,
    notes: Option<String>,
    aliases: Vec<String>,
    verified: bool,
    no_dates: bool,
    /// the creator's tiers (Details → Tiers)
    tiers: Vec<String>,
}

/// Creator details by lowercased name (= the creator's folder name).
fn load_meta(conn: &rusqlite::Connection) -> Result<HashMap<String, Meta>, String> {
    let mut stmt = conn
        .prepare("SELECT name, kind, tag, tags, links, notes, aliases, template_verified, no_dates, tier_list FROM artists")
        .map_err(map_err)?;
    let list = |s: Option<String>| -> Vec<String> {
        s.and_then(|s| serde_json::from_str::<Vec<String>>(&s).ok()).unwrap_or_default()
    };
    let text = |s: Option<String>| s.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    let rows = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, Option<String>>(1)?,
                r.get::<_, Option<String>>(2)?,
                r.get::<_, Option<String>>(3)?,
                r.get::<_, Option<String>>(4)?,
                r.get::<_, Option<String>>(5)?,
                r.get::<_, Option<String>>(6)?,
                r.get::<_, Option<i64>>(7)?,
                r.get::<_, Option<i64>>(8)?,
                r.get::<_, Option<String>>(9)?,
            ))
        })
        .map_err(map_err)?;
    let mut out = HashMap::new();
    for (name, kind, tag, tags, links, notes, aliases, verified, no_dates, tiers) in rows.flatten() {
        out.insert(
            name.to_lowercase(),
            Meta {
                kind: text(kind),
                tag: text(tag),
                tags: list(tags),
                links: links.and_then(|s| serde_json::from_str::<Vec<LinkDto>>(&s).ok()).unwrap_or_default(),
                notes: text(notes),
                aliases: list(aliases),
                verified: verified.unwrap_or(0) != 0,
                no_dates: no_dates.unwrap_or(0) != 0,
                tiers: list(tiers),
            },
        );
    }
    Ok(out)
}

/* ---- scanning the folder ----------------------------------------------- */

// the ids are a hash of the relative path, the phone makes the same ones for its copies
fn id_for(s: &str) -> String {
    let mut hash: u64 = 0xcbf29ce484222325;
    for b in s.bytes() {
        hash ^= b as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{:016x}", hash)
}
fn ext_lower(p: &Path) -> String {
    p.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase()
}
fn kind_for(ext: &str) -> Option<&'static str> {
    match ext {
        "jpg" | "jpeg" | "png" | "webp" | "gif" | "bmp" | "avif" | "jfif" => Some("image"),
        "mp4" | "webm" | "mov" | "mkv" | "m4v" => Some("video"),
        "zip" | "rar" | "7z" => Some("archive"),
        _ => None,
    }
}
fn name_of(p: &Path) -> String {
    p.file_name().and_then(|n| n.to_str()).unwrap_or("").to_string()
}
fn subdirs(dir: &Path) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = std::fs::read_dir(dir)
        .map(|rd| rd.flatten().map(|e| e.path()).filter(|p| p.is_dir()).collect())
        .unwrap_or_default();
    out.sort();
    out
}
fn rel(root: &Path, p: &Path) -> String {
    p.strip_prefix(root).unwrap_or(p).to_string_lossy().replace('\\', "/")
}
fn is_year(name: &str) -> bool {
    name.len() == 4
        && name.chars().all(|c| c.is_ascii_digit())
        && (1900..=2200).contains(&name.parse::<i32>().unwrap_or(0))
}
fn parse_month(name: &str) -> Option<u32> {
    let digits: String = name.chars().take_while(|c| c.is_ascii_digit()).collect();
    digits.parse::<u32>().ok().filter(|m| (1..=12).contains(m))
}
/// "2025-05" / "05.25"-style period folders without a year level
fn parse_period(name: &str) -> (Option<i32>, Option<u32>, String) {
    let digits: Vec<&str> = name.split(|c: char| !c.is_ascii_digit()).filter(|s| !s.is_empty()).collect();
    if digits.len() >= 2 {
        if let (Ok(y), Ok(m)) = (digits[0].parse::<i32>(), digits[1].parse::<u32>()) {
            if (1900..=2200).contains(&y) && (1..=12).contains(&m) {
                return (Some(y), Some(m), format!("{:02}.{:02}", m, y % 100));
            }
        }
    }
    (None, None, name.to_string())
}

/// Media files of a reward, with its subfolders (step-by-step folders), by path.
fn media_under(dir: &Path, recursive: bool) -> Vec<PathBuf> {
    let mut out = Vec::new();
    if recursive {
        for e in walkdir::WalkDir::new(dir).max_depth(4).into_iter().flatten() {
            let p = e.path();
            if p.is_file() && kind_for(&ext_lower(p)).is_some() {
                out.push(p.to_path_buf());
            }
        }
    } else if let Ok(rd) = std::fs::read_dir(dir) {
        for e in rd.flatten() {
            let p = e.path();
            if p.is_file() && kind_for(&ext_lower(&p)).is_some() {
                out.push(p);
            }
        }
    }
    out.sort();
    out
}

fn make_reward(root: &Path, dir: &Path, title: &str, recursive: bool) -> Option<RewardDto> {
    let media = media_under(dir, recursive);
    if media.is_empty() {
        return None;
    }
    let images = media
        .iter()
        .map(|p| ImageDto {
            id: id_for(&rel(root, p)),
            src: String::new(),
            path: rel(root, p),
            name: name_of(p),
            kind: kind_for(&ext_lower(p)).unwrap_or("image").to_string(),
            versions: None,
        })
        .collect();
    Some(RewardDto {
        id: id_for(&rel(root, dir)),
        title: title.to_string(),
        category: None,
        folder_path: rel(root, dir),
        cover: rel(root, &media[0]),
        images,
        status: "owned".to_string(),
        tier: None,
    })
}

fn rewards_in(root: &Path, month_dir: &Path) -> Vec<RewardDto> {
    let mut out: Vec<RewardDto> = subdirs(month_dir)
        .iter()
        .filter_map(|r| make_reward(root, r, &name_of(r), true))
        .collect();
    // pictures right in the month folder are one more reward
    out.extend(make_reward(root, month_dir, &name_of(month_dir), false));
    out
}

fn month_dto(root: &Path, dir: &Path, year: Option<i32>, month: Option<u32>, label: String, platform: &str) -> Option<MonthDto> {
    let rewards = rewards_in(root, dir);
    if rewards.is_empty() {
        return None;
    }
    Some(MonthDto {
        id: id_for(&rel(root, dir)),
        month,
        year,
        label,
        span: 1,
        skipped: false,
        verified: false,
        preview_path: String::new(),
        cover_image: None,
        // the phone has no templates, it shows plain counts
        official_total: None,
        rewards,
        platform: Some(platform.to_string()),
        needs_review: false,
        folder_path: rel(root, dir),
    })
}

/// Top-level folders that aren't creators: the graveyard, hidden and `_` folders.
fn is_artist_dir(p: &Path) -> bool {
    let n = name_of(p);
    !n.eq_ignore_ascii_case(indexer::GRAVEYARD_DIR) && !n.starts_with('.') && !n.starts_with('_')
}

fn scan(root: &Path) -> Vec<ArtistDto> {
    let mut artists = Vec::new();
    for adir in subdirs(root).into_iter().filter(|d| is_artist_dir(d)) {
        let mut platforms = Vec::new();
        for pdir in subdirs(&adir) {
            let pname = name_of(&pdir);
            let mut months = Vec::new();
            for ydir in subdirs(&pdir) {
                let yname = name_of(&ydir);
                // "Misc" is the year level of undated rewards (Misc/Misc/Reward)
                if is_year(&yname) || yname.eq_ignore_ascii_case("misc") {
                    let year: Option<i32> = yname.parse().ok().filter(|_| is_year(&yname));
                    for mdir in subdirs(&ydir) {
                        let m = parse_month(&name_of(&mdir));
                        let label = match (m, year) {
                            (Some(mm), Some(y)) => format!("{:02}.{:02}", mm, y % 100),
                            _ => name_of(&mdir),
                        };
                        months.extend(month_dto(root, &mdir, year, m, label, &pname));
                    }
                } else {
                    let (y, m, label) = parse_period(&yname);
                    months.extend(month_dto(root, &ydir, y, m, label, &pname));
                }
            }
            if months.is_empty() {
                continue;
            }
            months.sort_by(|a, b| b.year.cmp(&a.year).then(b.month.cmp(&a.month)));
            platforms.push(PlatformDto { id: id_for(&rel(root, &pdir)), name: pname, months });
        }
        if platforms.is_empty() {
            continue;
        }
        let preview = platforms
            .iter()
            .flat_map(|p| &p.months)
            .flat_map(|m| &m.rewards)
            .map(|r| r.cover.clone())
            .next()
            .unwrap_or_default();
        artists.push(ArtistDto {
            id: id_for(&rel(root, &adir)),
            name: name_of(&adir),
            preview_path: preview,
            platforms,
            kind: None,
            tag: None,
            tags: Vec::new(),
            links: Vec::new(),
            notes: None,
            aliases: Vec::new(),
            verified: false,
            no_dates: false,
            tiers: Vec::new(),
        });
    }
    artists.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    artists
}

/* ---- server ------------------------------------------------------------- */

/// Where the server gets the library, data key and folders from (MiColl itself, or a
/// test folder).
trait Source: Send + Sync {
    fn db(&self) -> &Db;
    /// the data key, None while locked or without encryption
    fn data_key(&self) -> Option<[u8; 32]>;
    fn cache(&self) -> Result<PathBuf, String>;
    /// where MiColl keeps the edited versions
    fn versions_dir(&self) -> Result<PathBuf, String>;
    /// Files arrived (new files, and originals that got a version): re-read these
    /// creators, note it in the history and tell the window.
    fn arrived(&self, creators: &[String], files: &[FileArrival], versions: &[VersionArrival]);
    /// A device was just shut out for too many wrong keys: tell the window.
    fn shut_out(&self, _ip: IpAddr) {}
}

struct AppSource(AppHandle);

/// A new file, and the top folder its upload made (None = the folder was there).
type FileArrival = (PathBuf, Option<PathBuf>);
/// The original that got a version, and the version's id.
type VersionArrival = (PathBuf, i64);

/// One reward that got something from the phone (for the toast and its button).
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
struct ArrivedPlace {
    artist_id: i64,
    period_id: i64,
    reward_id: i64,
    creator: String,
    /// the month as MiColl shows it ("03.26")
    period: String,
    reward: String,
    files: usize,
    versions: usize,
}

#[derive(Serialize, Clone)]
struct PhoneUpload {
    files: usize,
    versions: usize,
    /// in the order they arrived
    places: Vec<ArrivedPlace>,
}

/// The reward a file is in (as MiColl indexed it).
fn file_place(conn: &rusqlite::Connection, file: &Path) -> Option<ArrivedPlace> {
    conn.query_row(
        "SELECT a.id, p.id, r.id, a.name, p.label, r.title FROM images i
         JOIN rewards r ON r.id = i.reward_id
         JOIN periods p ON p.id = r.period_id
         JOIN artists a ON a.id = p.artist_id
         WHERE i.file_path = ?1 COLLATE NOCASE LIMIT 1",
        [file.to_string_lossy()],
        |r| {
            Ok(ArrivedPlace {
                artist_id: r.get(0)?,
                period_id: r.get(1)?,
                reward_id: r.get(2)?,
                creator: r.get(3)?,
                period: r.get(4)?,
                reward: r.get(5)?,
                files: 0,
                versions: 0,
            })
        },
    )
    .ok()
}

/// One history row for a batch's files and one for its versions. Each item keeps what
/// undoing needs: the file (`to`), the folder the upload made (`from`), its reward
/// (`back`), and a creator the upload made (`into`); a version item its id.
fn log_arrivals(conn: &rusqlite::Connection, root: &Path, files: &[FileArrival], versions: &[VersionArrival]) {
    let name_of = |p: &Path| p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    // the creator and the reward when the whole batch is one
    let common = |places: &[Option<ArrivedPlace>]| {
        let first = places.first().cloned().flatten();
        let one_creator = first.as_ref().filter(|f| places.iter().all(|p| p.as_ref().is_some_and(|p| p.artist_id == f.artist_id)));
        let one_reward = first.as_ref().filter(|f| places.iter().all(|p| p.as_ref().is_some_and(|p| p.reward_id == f.reward_id)));
        (one_creator.map(|f| f.creator.clone()), one_reward.map(|f| format!("{} › {}", f.period, f.reward)))
    };
    if !files.is_empty() {
        let places: Vec<Option<ArrivedPlace>> = files.iter().map(|(f, _)| file_place(conn, f)).collect();
        let items = files
            .iter()
            .zip(&places)
            .map(|((f, made), place)| {
                // the upload made the creator's own folder: a new creator
                let new_creator = made.as_ref().is_some_and(|m| m.parent() == Some(root));
                history::Item {
                    name: name_of(f),
                    to: Some(f.to_string_lossy().into_owned()),
                    from: made.as_ref().map(|m| m.to_string_lossy().into_owned()),
                    back: place.as_ref().map(|p| p.reward_id),
                    into: place.as_ref().filter(|_| new_creator).map(|p| p.artist_id),
                    ..Default::default()
                }
            })
            .collect();
        let (artist, place) = common(&places);
        history::log(conn, history::Entry { action: "phone", kind: "image", artist, place, files: history::Files::None, items });
    }
    if !versions.is_empty() {
        let places: Vec<Option<ArrivedPlace>> = versions.iter().map(|(o, _)| file_place(conn, o)).collect();
        let items = versions
            .iter()
            .zip(&places)
            .map(|((orig, id), place)| history::Item {
                name: name_of(orig),
                to: Some(orig.to_string_lossy().into_owned()),
                id: Some(*id),
                back: place.as_ref().map(|p| p.reward_id),
                ..Default::default()
            })
            .collect();
        let (artist, place) = common(&places);
        history::log(conn, history::Entry { action: "phone", kind: "version", artist, place, files: history::Files::None, items });
    }
}

/// Take back what the phone sent (from the history). Files go to the Recycle Bin, the
/// folders the upload made go when they're empty, the rewards are read again (a reward
/// that was there before stays, only emptied) and creators the upload made are removed
/// again. Versions are removed, their file goes to the Recycle Bin.
pub(crate) fn undo_phone(
    conn: &rusqlite::Connection,
    row: &history::Row,
    recycle: &dyn Fn(&Path) -> Result<(), String>,
) -> Result<(), String> {
    let changed = |n: &str| format!("undo:changed:{n}");
    if row.kind == "version" {
        let mut files = Vec::new();
        for it in &row.items {
            let id = it.id.unwrap_or_default();
            let fp: Option<String> = conn
                .query_row("SELECT file_path FROM image_versions WHERE id = ?1", [id], |r| r.get(0))
                .ok();
            files.push((id, fp.ok_or_else(|| changed(&it.name))?));
        }
        for (id, fp) in files {
            if Path::new(&fp).exists() {
                recycle(Path::new(&fp)).map_err(|e| format!("undo:trash:{e}"))?;
            }
            db::delete_image_version(conn, id).map_err(map_err)?;
        }
        return Ok(());
    }

    // all still there, before anything moves
    for it in &row.items {
        if !it.to.as_deref().is_some_and(|t| Path::new(t).is_file()) {
            return Err(changed(&it.name));
        }
    }
    for it in &row.items {
        recycle(Path::new(it.to.as_deref().unwrap_or_default())).map_err(|e| format!("undo:trash:{e}"))?;
    }
    for made in row.items.iter().filter_map(|i| i.from.as_deref()) {
        remove_empty_dirs(Path::new(made));
    }
    let mut rewards: Vec<i64> = row.items.iter().filter_map(|i| i.back).collect();
    rewards.sort_unstable();
    rewards.dedup();
    for id in rewards {
        let folder: Option<String> = conn.query_row("SELECT folder_path FROM rewards WHERE id = ?1", [id], |r| r.get(0)).ok();
        match folder {
            // its folder went with the upload's folders: the reward goes too
            Some(f) if !Path::new(&f).exists() => db::delete_rewards(conn, &[id]).map_err(map_err)?,
            Some(_) => crate::reindex_rewards(conn, &[id])?,
            None => {}
        }
    }
    let mut made: Vec<i64> = row.items.iter().filter_map(|i| i.into).collect();
    made.sort_unstable();
    made.dedup();
    for artist_id in made {
        let left: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM rewards r JOIN periods p ON r.period_id = p.id WHERE p.artist_id = ?1",
                [artist_id],
                |r| r.get(0),
            )
            .map_err(map_err)?;
        if left == 0 {
            db::delete_artist(conn, artist_id).map_err(map_err)?;
        }
    }
    Ok(())
}

/// Remove a folder and the folders in it, but only when no file is left anywhere inside.
fn remove_empty_dirs(dir: &Path) {
    if !dir.is_dir() || walkdir::WalkDir::new(dir).into_iter().flatten().any(|e| !e.file_type().is_dir()) {
        return;
    }
    let mut dirs: Vec<PathBuf> = walkdir::WalkDir::new(dir).into_iter().flatten().map(|e| e.into_path()).collect();
    // deepest first
    dirs.sort_by_key(|d| std::cmp::Reverse(d.components().count()));
    for d in dirs {
        let _ = std::fs::remove_dir(&d);
    }
}

/// Which rewards the files are in now (after the re-read). Files MiColl didn't pick
/// up are only counted.
fn arrived_places(conn: &rusqlite::Connection, files: &[PathBuf], versions: &[PathBuf]) -> Vec<ArrivedPlace> {
    let mut out: Vec<ArrivedPlace> = Vec::new();
    let all = files.iter().map(|f| (f, true)).chain(versions.iter().map(|f| (f, false)));
    for (file, is_file) in all {
        let Some(found) = file_place(conn, file) else { continue };
        let i = match out.iter().position(|p| p.reward_id == found.reward_id) {
            Some(i) => i,
            None => {
                out.push(found);
                out.len() - 1
            }
        };
        if is_file {
            out[i].files += 1;
        } else {
            out[i].versions += 1;
        }
    }
    out
}

impl Source for AppSource {
    fn db(&self) -> &Db {
        self.0.state::<Db>().inner()
    }
    fn data_key(&self) -> Option<[u8; 32]> {
        session_key(&self.0.state::<DekState>())
    }
    fn cache(&self) -> Result<PathBuf, String> {
        app_cache(&self.0)
    }
    fn versions_dir(&self) -> Result<PathBuf, String> {
        Ok(crate::app_data(&self.0)?.join("versions"))
    }
    fn arrived(&self, creators: &[String], files: &[FileArrival], versions: &[VersionArrival]) {
        let mut places = Vec::new();
        if let Ok(conn) = self.db().lock() {
            if let Ok(root) = served_root(&conn) {
                crate::allow_asset_dir(&self.0, &root.to_string_lossy());
                for c in creators {
                    let _ = reindex_creator(&conn, &root, c);
                }
                let _ = db::repair_missing_previews(&conn);
                log_arrivals(&conn, &root, files, versions);
            }
            let paths: Vec<PathBuf> = files.iter().map(|(f, _)| f.clone()).collect();
            let origs: Vec<PathBuf> = versions.iter().map(|(o, _)| o.clone()).collect();
            places = arrived_places(&conn, &paths, &origs);
        }
        let _ = self.0.emit(
            "phone-upload",
            PhoneUpload { files: files.len(), versions: versions.len(), places },
        );
    }
    fn shut_out(&self, ip: IpAddr) {
        let _ = self.0.emit("phone-bridge-blocked", serde_json::json!({ "ip": ip.to_string(), "minutes": BLOCK_FOR.as_secs() / 60 }));
    }
}

/// Re-read one creator's folder, like F5 on the creator page. Their name in the
/// database is kept (the folder name can differ by characters Windows doesn't allow).
fn reindex_creator(conn: &rusqlite::Connection, root: &Path, folder: &str) -> Result<(), String> {
    let mut stmt = conn.prepare("SELECT name FROM artists").map_err(map_err)?;
    let names: Vec<String> = stmt.query_map([], |r| r.get(0)).map_err(map_err)?.flatten().collect();
    let name = names
        .into_iter()
        .find(|n| crate::sanitize_name(n).eq_ignore_ascii_case(folder))
        .unwrap_or_else(|| folder.to_string());
    let dir = root.join(folder);
    let plan = indexer::plan_artist_dir(conn, &dir.to_string_lossy(), None, &name).map_err(map_err)?;
    indexer::commit_with_progress(conn, &plan, None, &|_, _, _| {}).map_err(map_err)?;
    Ok(())
}

/// What arrived since MiColl last re-read (see SETTLE).
#[derive(Default)]
struct Pending {
    creators: HashSet<String>,
    files: Vec<FileArrival>,
    versions: Vec<VersionArrival>,
    last: Option<std::time::Instant>,
    /// a thread waits to hand it over
    waiting: bool,
}

/// The different wrong keys one device tried (see MISS_LIMIT).
#[derive(Default)]
struct Misses {
    keys: HashSet<String>,
    since: Option<Instant>,
    /// shut out until then
    until: Option<Instant>,
}

/// What the server threads share.
struct Shared {
    src: Box<dyn Source>,
    key: RwLock<String>,
    pending: Mutex<Pending>,
    misses: Mutex<HashMap<IpAddr, Misses>>,
    /// public networks the user allowed (TRUSTED_SETTING)
    trusted: RwLock<HashSet<String>>,
}

impl Shared {
    fn new(src: Box<dyn Source>, key: String, trusted: HashSet<String>) -> Self {
        Shared {
            src,
            key: RwLock::new(key),
            pending: Mutex::new(Pending::default()),
            misses: Mutex::new(HashMap::new()),
            trusted: RwLock::new(trusted),
        }
    }

    /// Is this device shut out right now?
    fn shut_out(&self, ip: IpAddr) -> bool {
        let Ok(mut m) = self.misses.lock() else { return false };
        match m.get(&ip).and_then(|x| x.until) {
            Some(t) if t > Instant::now() => true,
            Some(_) => {
                m.remove(&ip);
                false
            }
            None => false,
        }
    }

    /// A wrong key from this device. true = that was one too many, it's shut out now.
    fn wrong_key(&self, ip: IpAddr, key: &str) -> bool {
        let Ok(mut m) = self.misses.lock() else { return false };
        let now = Instant::now();
        let fresh = |s: Option<Instant>| s.is_some_and(|s| now.duration_since(s) < MISS_WINDOW);
        if m.len() > 1000 {
            m.retain(|_, x| x.until.is_some_and(|t| t > now) || fresh(x.since));
        }
        let e = m.entry(ip).or_default();
        if !fresh(e.since) {
            e.keys.clear();
            e.since = Some(now);
        }
        e.keys.insert(key.chars().take(32).collect());
        if e.keys.len() < MISS_LIMIT {
            return false;
        }
        *e = Misses { until: Some(now + BLOCK_FOR), ..Misses::default() };
        true
    }

    /// Is this device on a public network the user didn't allow?
    fn on_closed_network(&self, ip: IpAddr) -> bool {
        let IpAddr::V4(ip) = ip else { return false };
        if ip.is_loopback() {
            return false;
        }
        let Ok(trusted) = self.trusted.read() else { return false };
        let addrs = net_addrs(false);
        let shut = closed(&addrs, &trusted).any(|a| same_subnet(a.ip, ip, a.prefix));
        shut
    }
}

/// Note an arrival (a new file, or the original that got a version). Once the phone
/// is quiet for SETTLE, MiColl re-reads the creators once (not once per file).
fn note_arrival(sh: &Arc<Shared>, creator: Option<&str>, file: Option<FileArrival>, version: Option<VersionArrival>) {
    let Ok(mut p) = sh.pending.lock() else { return };
    p.creators.extend(creator.map(str::to_string));
    p.files.extend(file);
    p.versions.extend(version);
    p.last = Some(std::time::Instant::now());
    if p.waiting {
        return;
    }
    p.waiting = true;
    let sh = sh.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(SETTLE / 3);
        let done = {
            let Ok(mut p) = sh.pending.lock() else { return };
            if p.last.is_some_and(|t| t.elapsed() < SETTLE) {
                continue;
            }
            p.waiting = false;
            let creators: Vec<String> = p.creators.drain().collect();
            (creators, std::mem::take(&mut p.files), std::mem::take(&mut p.versions))
        };
        sh.src.arrived(&done.0, &done.1, &done.2);
        return;
    });
}

#[derive(Default)]
pub struct BridgeInner {
    server: Option<Arc<tiny_http::Server>>,
    shared: Option<Arc<Shared>>,
}
pub type BridgeState = Mutex<BridgeInner>;

/// The served folder: <collection_root>\MiColl.
fn served_root(conn: &rusqlite::Connection) -> Result<PathBuf, String> {
    let col = db::get_setting(conn, "collection_root")
        .map_err(map_err)?
        .filter(|s| !s.trim().is_empty())
        .ok_or("Choose a collection folder first (Library → Managed collection).")?;
    let dir = Path::new(&col).join("MiColl");
    if !dir.is_dir() {
        return Err("The collection folder has no creators yet.".into());
    }
    Ok(dir)
}

/// A path from the phone, relative to the root: only plain parts (no .., drive
/// letters or absolute paths), and only inside creator folders (not the graveyard,
/// "." or "_" folders, the same ones the gallery leaves out).
fn safe_path(root: &Path, token: &str) -> Option<PathBuf> {
    let token = token.replace('\\', "/");
    let rel = Path::new(&token);
    let mut out = root.to_path_buf();
    for (i, c) in rel.components().enumerate() {
        let Component::Normal(part) = c else { return None };
        let part_s = part.to_str()?;
        if part_s.starts_with('.') || (i == 0 && !is_artist_dir(Path::new(part_s))) {
            return None;
        }
        out.push(part);
    }
    (out != root).then_some(out)
}

fn query_param(url: &str, key: &str) -> Option<String> {
    let q = url.split_once('?')?.1;
    q.split('&').find_map(|pair| {
        let (k, v) = pair.split_once('=')?;
        (k == key).then(|| urlencoding::decode(v).map(|s| s.into_owned()).unwrap_or_else(|_| v.to_string()))
    })
}

/// Headers only take plain ascii, anything else is dropped (a non-ascii value would
/// panic in tiny_http).
fn header(name: &str, value: &str) -> tiny_http::Header {
    let clean: String = value.chars().filter(|c| c.is_ascii() && !c.is_ascii_control()).collect();
    tiny_http::Header::from_bytes(name.as_bytes(), clean.as_bytes())
        .unwrap_or_else(|_| tiny_http::Header::from_bytes(name.as_bytes(), &b""[..]).expect("ascii header name"))
}

/// Same length and same bytes, without stopping at the first difference.
fn same_key(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0u8, |d, (x, y)| d | (x ^ y)) == 0
}

fn cors() -> tiny_http::Header {
    header("Access-Control-Allow-Origin", "*")
}

fn fail(req: tiny_http::Request, code: u16, msg: &str) {
    let _ = req.respond(tiny_http::Response::from_string(msg).with_status_code(code).with_header(cors()));
}

fn json(req: tiny_http::Request, code: u16, body: &serde_json::Value) {
    let _ = req.respond(
        tiny_http::Response::from_string(body.to_string())
            .with_status_code(code)
            .with_header(header("Content-Type", "application/json; charset=utf-8"))
            .with_header(cors()),
    );
}

fn handle(req: tiny_http::Request, sh: &Arc<Shared>) {
    let url = req.url().to_string();
    let path = url.split('?').next().unwrap_or("/");

    let ip = req.remote_addr().map(|a| a.ip());
    if let Some(ip) = ip {
        if sh.shut_out(ip) {
            return fail(req, 429, "too many wrong pairing keys, try again in a few minutes");
        }
        if sh.on_closed_network(ip) {
            return fail(req, 403, "MiColl doesn't answer on public networks, see Settings > Phone app on the PC");
        }
    }

    // /k/<key>/api/... , anything else gets nothing
    let given = path.strip_prefix("/k/").map(|rest| rest.split_once('/').unwrap_or((rest, "")));
    let route = given.and_then(|(key, route)| {
        let ok = sh.key.read().map(|k| same_key(key, &k)).unwrap_or(false);
        ok.then(|| format!("/{route}"))
    });
    let Some(route) = route else {
        if let Some(ip) = ip.filter(|ip| sh.wrong_key(*ip, given.map_or("", |g| g.0))) {
            sh.src.shut_out(ip);
        }
        return fail(req, 401, "pairing key missing or wrong, scan the QR code in MiColl again");
    };

    let root = match sh.src.db().lock().map_err(map_err).and_then(|c| served_root(&c)) {
        Ok(r) => r,
        Err(e) => return fail(req, 503, &e),
    };
    let key = sh.src.data_key();
    let meta = || sh.src.db().lock().map_err(map_err).and_then(|c| load_meta(&c)).unwrap_or_default();

    match route.as_str() {
        "/api/ping" => json(req, 200, &serde_json::json!({ "app": "micoll-bridge", "ok": true, "host": "micoll" })),
        // scanned fresh each time, so moves and renames in MiColl show up right away
        "/api/gallery" => {
            let mut artists = scan(&root);
            let counts = sh.src.db().lock().map_err(map_err).and_then(|c| version_counts(&c)).unwrap_or_default();
            if !counts.is_empty() {
                let images = artists
                    .iter_mut()
                    .flat_map(|a| &mut a.platforms)
                    .flat_map(|p| &mut p.months)
                    .flat_map(|m| &mut m.rewards)
                    .flat_map(|r| &mut r.images);
                for im in images {
                    let full = im.path.split('/').fold(root.clone(), |p, part| p.join(part));
                    im.versions = counts.get(&path_key(&full)).copied();
                }
            }
            let meta = meta();
            for a in &mut artists {
                if let Some(m) = meta.get(&a.name.to_lowercase()).cloned() {
                    a.kind = m.kind;
                    a.tag = m.tag;
                    a.tags = m.tags;
                    a.links = m.links;
                    a.notes = m.notes;
                    a.aliases = m.aliases;
                    a.verified = m.verified;
                    a.no_dates = m.no_dates;
                    a.tiers = m.tiers;
                }
            }
            // each reward's tier, by its folder
            let tiers = sh.src.db().lock().map_err(map_err).and_then(|c| reward_tiers(&c)).unwrap_or_default();
            if !tiers.is_empty() {
                let rewards = artists
                    .iter_mut()
                    .flat_map(|a| &mut a.platforms)
                    .flat_map(|p| &mut p.months)
                    .flat_map(|m| &mut m.rewards);
                for r in rewards {
                    let full = r.folder_path.split('/').fold(root.clone(), |p, part| p.join(part));
                    r.tier = tiers.get(&path_key(&full)).cloned();
                }
            }
            json(req, 200, &serde_json::to_value(&artists).unwrap_or_default());
        }
        // the creator details by lowercased name (the phone copies them on download)
        "/api/meta" => json(req, 200, &serde_json::to_value(meta()).unwrap_or_default()),
        // the gallery is always scanned fresh, nothing to do
        "/api/rescan" => json(req, 200, &serde_json::json!({ "ok": true })),
        "/api/thumb" => {
            let Some(full) = query_param(&url, "p").and_then(|p| safe_path(&root, &p)) else {
                return fail(req, 400, "bad path");
            };
            if !full.is_file() {
                return fail(req, 404, "not found");
            }
            if key.is_none() && crypto::file_is_encrypted(&full) {
                return fail(req, 503, "MiColl is locked");
            }
            // a few sizes only, every size is a file in the thumbnail cache
            let asked: u32 = query_param(&url, "s").and_then(|s| s.parse().ok()).unwrap_or(512);
            let size = [256, 512, 1024].into_iter().find(|s| *s >= asked).unwrap_or(1024);
            let jpeg = sh
                .src
                .cache()
                .and_then(|cache| crate::thumbs::thumb_jpeg(&cache, &full.to_string_lossy(), size, key));
            match jpeg {
                Ok(bytes) => {
                    let _ = req.respond(
                        tiny_http::Response::from_data(bytes)
                            .with_header(header("Content-Type", "image/jpeg"))
                            .with_header(header("Cache-Control", "public, max-age=86400"))
                            .with_header(cors()),
                    );
                }
                Err(_) => fail(req, 500, "thumb error"),
            }
        }
        "/api/file" => {
            let Some(full) = query_param(&url, "p").and_then(|p| safe_path(&root, &p)) else {
                return fail(req, 400, "bad path");
            };
            if !full.is_file() {
                return fail(req, 404, "not found");
            }
            serve_file(req, &full, key);
        }
        "/api/upload" => upload(req, sh, &root, &url),
        "/api/version" => add_version(req, sh, &root, &url),
        "/api/check" => check(req, sh, &root),
        "/api/versions" => {
            let Some(full) = query_param(&url, "p").and_then(|p| safe_path(&root, &p)) else {
                return fail(req, 400, "bad path");
            };
            let Some(orig) = full.is_file().then(|| known_original(sh, &full)).flatten() else {
                return fail(req, 404, "MiColl doesn't know this picture");
            };
            let found = sh.src.db().lock().map_err(map_err).and_then(|c| db::list_image_versions(&c, &orig).map_err(map_err));
            let (versions, active) = match found {
                Ok(v) => v,
                Err(e) => return fail(req, 500, &e),
            };
            if key.is_none() && versions.iter().any(|v| crypto::file_is_encrypted(Path::new(&v.file_path))) {
                return fail(req, 503, "MiColl is locked");
            }
            // checksum and size of exactly the bytes /api/version-file sends
            let list: Vec<serde_json::Value> = versions
                .iter()
                .filter_map(|v| {
                    let (sha256, size) = content_hash_size(Path::new(&v.file_path), key)?;
                    Some(serde_json::json!({
                        "id": v.id, "label": v.label, "createdAt": v.created_at, "sha256": sha256, "size": size,
                    }))
                })
                .collect();
            json(req, 200, &serde_json::json!({ "list": list, "active": active }));
        }
        "/api/version-file" => {
            let id: Option<i64> = query_param(&url, "id").and_then(|s| s.parse().ok());
            let file: Option<String> = id.and_then(|id| {
                sh.src.db().lock().ok()?.query_row("SELECT file_path FROM image_versions WHERE id = ?1", [id], |r| r.get(0)).ok()
            });
            match file.map(PathBuf::from).filter(|f| f.is_file()) {
                Some(f) => serve_file(req, &f, key),
                None => fail(req, 404, "no such version"),
            }
        }
        _ => fail(req, 404, "not found"),
    }
}

/// A file with Range support (videos seek). Plain files are streamed from disk,
/// encrypted ones are decrypted in memory first.
fn serve_file(req: tiny_http::Request, full: &Path, key: Option<[u8; 32]>) {
    let ct = media_mime(&full.to_string_lossy());
    let cors = || header("Access-Control-Allow-Origin", "*");
    let range = req.headers().iter().find(|h| h.field.equiv("Range")).map(|h| h.value.as_str().to_string());
    let fail = |req: tiny_http::Request, code: u16| {
        let _ = req.respond(tiny_http::Response::from_string("").with_status_code(code).with_header(cors()));
    };
    let partial = |req: tiny_http::Request, body: Vec<u8>, start: usize, end: usize, total: usize| {
        let _ = req.respond(
            tiny_http::Response::from_data(body)
                .with_status_code(206)
                .with_header(header("Content-Type", ct))
                .with_header(header("Accept-Ranges", "bytes"))
                .with_header(header("Content-Range", &format!("bytes {start}-{end}/{total}")))
                .with_header(cors()),
        );
    };

    if !crypto::file_is_encrypted(full) {
        let Ok(mut file) = std::fs::File::open(full) else {
            return fail(req, 404);
        };
        let total = file.metadata().map(|m| m.len() as usize).unwrap_or(0);
        if let Some((start, end)) = range.as_deref().and_then(|r| parse_range(r, total)) {
            // one capped piece, the player asks for the next one
            let end = end.min(start.saturating_add(RANGE_CHUNK - 1));
            return match read_window(full, start, end - start + 1) {
                Ok(body) => partial(req, body, start, end, total),
                Err(_) => fail(req, 404),
            };
        }
        if file.seek(SeekFrom::Start(0)).is_err() {
            return fail(req, 404);
        }
        let _ = req.respond(
            tiny_http::Response::from_file(file)
                .with_header(header("Content-Type", ct))
                .with_header(header("Accept-Ranges", "bytes"))
                .with_header(cors()),
        );
        return;
    }

    let Some(k) = key else {
        return fail(req, 503); // locked
    };
    let data = match std::fs::read(full).map_err(map_err).and_then(|b| crypto::Dek::from_bytes(k).decrypt_bytes(&b)) {
        Ok(d) => d,
        Err(_) => return fail(req, 403),
    };
    let total = data.len();
    if let Some((start, end)) = range.as_deref().and_then(|r| parse_range(r, total)) {
        let end = end.min(start.saturating_add(RANGE_CHUNK - 1));
        return partial(req, data[start..=end].to_vec(), start, end, total);
    }
    let _ = req.respond(
        tiny_http::Response::from_data(data)
            .with_header(header("Content-Type", ct))
            .with_header(header("Accept-Ranges", "bytes"))
            .with_header(cors()),
    );
}

/* ---- phone -> PC -------------------------------------------------------- */

/// Free bytes on the drive of `dir` (None when Windows doesn't say).
#[cfg(windows)]
fn free_space(dir: &Path) -> Option<u64> {
    use windows::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
    let mut free = 0u64;
    unsafe { GetDiskFreeSpaceExW(&windows::core::HSTRING::from(dir.as_os_str()), Some(&mut free), None, None) }.ok()?;
    Some(free)
}
#[cfg(not(windows))]
fn free_space(_dir: &Path) -> Option<u64> {
    None
}

/// The body of a PUT, checked and written to `temp`. Returns its SHA-256 (hex) or the
/// answer to send. `encrypt`: the file gets encrypted after, that needs it once more.
fn receive(req: &mut tiny_http::Request, temp: &Path, encrypt: bool) -> Result<String, (u16, String)> {
    if *req.method() != tiny_http::Method::Put {
        return Err((405, "use PUT".into()));
    }
    let len = req.body_length().ok_or((411, "Content-Length is missing".to_string()))?;
    if len > MAX_UPLOAD {
        return Err((413, "file too big".into()));
    }
    // asked before, so a full drive doesn't end in half a file
    let need = len as u64 * if encrypt { 2 } else { 1 } + KEEP_FREE;
    if let Some(free) = temp.parent().and_then(free_space).filter(|f| *f < need) {
        const MB: u64 = 1024 * 1024;
        return Err((507, format!("not enough space on the PC: {} MB free, {} MB needed", free / MB, need / MB)));
    }
    let want = req
        .headers()
        .iter()
        .find(|h| h.field.equiv("X-Sha256"))
        .map(|h| h.value.as_str().trim().to_ascii_lowercase());
    let full_disk = |e: &std::io::Error| matches!(e.raw_os_error(), Some(39) | Some(112));
    let mut file = std::fs::File::create(temp).map_err(|e| (if full_disk(&e) { 507 } else { 500 }, e.to_string()))?;
    let mut hasher = Sha256::new();
    let mut got = 0usize;
    let mut buf = vec![0u8; 1024 * 1024];
    let body = req.as_reader();
    loop {
        let n = body.read(&mut buf).map_err(|e| (400, e.to_string()))?;
        if n == 0 {
            break;
        }
        got += n;
        if got > len {
            return Err((400, "more data than Content-Length".into()));
        }
        hasher.update(&buf[..n]);
        file.write_all(&buf[..n]).map_err(|e| (if full_disk(&e) { 507 } else { 500 }, e.to_string()))?;
    }
    file.sync_all().map_err(|e| (if full_disk(&e) { 507 } else { 500 }, e.to_string()))?;
    if got != len {
        return Err((400, "the upload was cut off".into()));
    }
    let hash: String = hasher.finalize().iter().map(|b| format!("{b:02x}")).collect();
    if want.is_some_and(|w| w != hash) {
        return Err((422, "checksum doesn't match".into()));
    }
    Ok(hash)
}

/// A path as the database stores it, for comparing (backslashes, lower case).
fn path_key(p: &Path) -> String {
    p.to_string_lossy().replace('/', "\\").to_lowercase()
}

/// The tier of every reward that has one (by path_key of its folder).
fn reward_tiers(conn: &rusqlite::Connection) -> Result<HashMap<String, String>, String> {
    let mut stmt = conn
        .prepare("SELECT folder_path, tier FROM rewards WHERE tier IS NOT NULL AND trim(tier) <> ''")
        .map_err(map_err)?;
    let rows = stmt
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
        .map_err(map_err)?;
    Ok(rows.flatten().map(|(f, t)| (path_key(Path::new(&f)), t)).collect())
}

/// How many versions each original has (by path_key).
fn version_counts(conn: &rusqlite::Connection) -> Result<HashMap<String, usize>, String> {
    let mut stmt = conn.prepare("SELECT orig_path, COUNT(*) FROM image_versions GROUP BY orig_path").map_err(map_err)?;
    let rows = stmt
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))
        .map_err(map_err)?;
    let mut out = HashMap::new();
    for (p, n) in rows.flatten() {
        *out.entry(path_key(Path::new(&p))).or_insert(0) += n as usize;
    }
    Ok(out)
}

/// SHA-256 and size of a file's content (decrypted when it's encrypted).
fn content_hash_size(path: &Path, key: Option<[u8; 32]>) -> Option<(String, u64)> {
    let mut hasher = Sha256::new();
    let size = if crypto::file_is_encrypted(path) {
        let plain = crypto::Dek::from_bytes(key?).decrypt_bytes(&std::fs::read(path).ok()?).ok()?;
        hasher.update(&plain);
        plain.len() as u64
    } else {
        let mut f = std::fs::File::open(path).ok()?;
        std::io::copy(&mut f, &mut hasher).ok()?
    };
    Some((hasher.finalize().iter().map(|b| format!("{b:02x}")).collect(), size))
}

/// SHA-256 of a file's content (decrypted when it's encrypted).
fn content_hash(path: &Path, key: Option<[u8; 32]>) -> Option<String> {
    let mut hasher = Sha256::new();
    if crypto::file_is_encrypted(path) {
        let plain = crypto::Dek::from_bytes(key?).decrypt_bytes(&std::fs::read(path).ok()?).ok()?;
        hasher.update(&plain);
    } else {
        let mut f = std::fs::File::open(path).ok()?;
        std::io::copy(&mut f, &mut hasher).ok()?;
    }
    Some(hasher.finalize().iter().map(|b| format!("{b:02x}")).collect())
}

/// Give `temp` the name `dest`, but never over an existing file: a hard link fails
/// when the name exists (no gap between checking and writing). Drives without hard
/// links (exFAT) get a copy into a file opened with create_new, same guarantee.
/// false = the name is taken.
fn place_new(temp: &Path, dest: &Path) -> std::io::Result<bool> {
    match std::fs::hard_link(temp, dest) {
        Ok(()) => {
            let _ = std::fs::remove_file(temp);
            return Ok(true);
        }
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => return Ok(false),
        Err(_) => {}
    }
    let mut out = match std::fs::OpenOptions::new().write(true).create_new(true).open(dest) {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => return Ok(false),
        Err(e) => return Err(e),
    };
    let copied = std::fs::File::open(temp).and_then(|mut src| std::io::copy(&mut src, &mut out)).and_then(|_| out.sync_all());
    if let Err(e) = copied {
        // only our own half-written file goes
        drop(out);
        let _ = std::fs::remove_file(dest);
        return Err(e);
    }
    let _ = std::fs::remove_file(temp);
    Ok(true)
}

/// "name.jpg", "name (2).jpg", "name (3).jpg" ...
fn numbered(path: &Path, n: u32) -> PathBuf {
    if n < 2 {
        return path.to_path_buf();
    }
    let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("file");
    let name = match path.extension().and_then(|e| e.to_str()) {
        Some(ext) => format!("{stem} ({n}).{ext}"),
        None => format!("{stem} ({n})"),
    };
    path.with_file_name(name)
}

/// A temp file name next to the target ("." in front: the gallery and MiColl skip it).
fn temp_in(dir: &Path) -> PathBuf {
    let mut raw = [0u8; 8];
    rand::RngCore::fill_bytes(&mut rand::rngs::OsRng, &mut raw);
    dir.join(format!(".micoll-upload-{}.part", raw.iter().map(|b| format!("{b:02x}")).collect::<String>()))
}

/// The data key when new files must be encrypted, Err while that can't be done.
fn encrypt_key(sh: &Shared) -> Result<Option<[u8; 32]>, String> {
    let on = sh.src.db().lock().map(|c| crate::enc_enabled(&c)).map_err(map_err)?;
    match (on, sh.src.data_key()) {
        (false, _) => Ok(None),
        (true, Some(k)) => Ok(Some(k)),
        (true, None) => Err("MiColl is locked".into()),
    }
}

/// Where a file from the phone belongs: the same file is already there (at its name or
/// a numbered one), or the first free name it would get.
enum Spot {
    Same(PathBuf),
    Free(PathBuf, u32),
    Full,
}

/// `size` = the file's size, when known: a plain file of another size can't be the same,
/// so it isn't read.
fn find_spot(full: &Path, hash: &str, size: Option<u64>, key: Option<[u8; 32]>) -> Spot {
    for n in 1..1000 {
        let cand = numbered(full, n);
        let Ok(meta) = std::fs::metadata(&cand) else {
            return Spot::Free(cand, n);
        };
        let other_size = size.is_some_and(|s| s != meta.len()) && !crypto::file_is_encrypted(&cand);
        if !other_size && content_hash(&cand, key).as_deref() == Some(hash) {
            return Spot::Same(cand);
        }
    }
    Spot::Full
}

/// The original as MiColl knows it (the versions hang on that exact path).
fn known_original(sh: &Shared, full: &Path) -> Option<String> {
    sh.src.db().lock().ok().and_then(|c| {
        c.query_row(
            "SELECT file_path FROM images WHERE file_path = ?1 COLLATE NOCASE",
            [full.to_string_lossy()],
            |r| r.get(0),
        )
        .ok()
    })
}

/// Is this picture already the original or one of its versions? Some(None) = the
/// original itself, Some(Some(id)) = that version, None = it's new.
fn same_version(
    conn: &rusqlite::Connection,
    full: &Path,
    orig: &str,
    hash: &str,
    key: Option<[u8; 32]>,
) -> Result<Option<Option<i64>>, String> {
    if content_hash(full, key).as_deref() == Some(hash) {
        return Ok(Some(None));
    }
    let (versions, _) = db::list_image_versions(conn, orig).map_err(map_err)?;
    Ok(versions
        .iter()
        .find(|v| content_hash(Path::new(&v.file_path), key).as_deref() == Some(hash))
        .map(|v| Some(v.id)))
}

/// PUT /api/upload?p=<path>: a picture or video from the phone into the collection.
fn upload(mut req: tiny_http::Request, sh: &Arc<Shared>, root: &Path, url: &str) {
    let rel_in = query_param(url, "p").unwrap_or_default();
    let Some(full) = safe_path(root, &rel_in) else {
        return fail(req, 400, "bad path");
    };
    // at least Creator/<folder>/file, and only pictures and videos
    let depth = full.strip_prefix(root).map(|r| r.components().count()).unwrap_or(0);
    if depth < 3 || !matches!(kind_for(&ext_lower(&full)), Some("image" | "video")) {
        return fail(req, 400, "only pictures and videos inside a creator folder");
    }
    let enc = match encrypt_key(sh) {
        Ok(k) => k,
        Err(e) => return fail(req, 503, &e),
    };
    let dir = full.parent().unwrap_or(root).to_path_buf();
    // the top folder this upload makes (an undo removes it again when it's empty)
    let made = dir.ancestors().take_while(|a| *a != root && !a.exists()).last().map(Path::to_path_buf);
    if let Err(e) = std::fs::create_dir_all(&dir) {
        return fail(req, 500, &e.to_string());
    }
    let temp = temp_in(&dir);
    let hash = match receive(&mut req, &temp, enc.is_some()) {
        Ok(h) => h,
        Err((code, msg)) => {
            let _ = std::fs::remove_file(&temp);
            if let Some(m) = &made {
                remove_empty_dirs(m);
            }
            return fail(req, code, &msg);
        }
    };
    let size = std::fs::metadata(&temp).map(|m| m.len()).ok();
    if let Some(k) = enc {
        if let Err(e) = crypto::encrypt_file_in_place(&crypto::Dek::from_bytes(k), &temp) {
            let _ = std::fs::remove_file(&temp);
            return fail(req, 500, &e);
        }
    }

    // the name, or the next free number. A file with the same content is the same file
    for _ in 0..1000 {
        let (cand, n) = match find_spot(&full, &hash, size, sh.src.data_key()) {
            Spot::Same(cand) => {
                let _ = std::fs::remove_file(&temp);
                return json(req, 200, &serde_json::json!({ "result": "same", "path": rel(root, &cand) }));
            }
            Spot::Free(cand, n) => (cand, n),
            Spot::Full => break,
        };
        match place_new(&temp, &cand) {
            Ok(true) => {
                let creator = rel(root, &cand).split('/').next().map(str::to_string);
                note_arrival(sh, creator.as_deref(), Some((cand.clone(), made.clone())), None);
                let result = if n == 1 { "saved" } else { "renamed" };
                return json(req, 201, &serde_json::json!({ "result": result, "path": rel(root, &cand) }));
            }
            // somebody took the name in between: next number
            Ok(false) => continue,
            Err(e) => {
                let _ = std::fs::remove_file(&temp);
                let code = if matches!(e.raw_os_error(), Some(39) | Some(112)) { 507 } else { 500 };
                return fail(req, code, &e.to_string());
            }
        }
    }
    let _ = std::fs::remove_file(&temp);
    fail(req, 409, "no free name left")
}

/// PUT /api/version?p=<original>&label=<text>: an edited version of a picture. Only
/// added to the picture's versions, the original stays the active one.
fn add_version(mut req: tiny_http::Request, sh: &Arc<Shared>, root: &Path, url: &str) {
    let Some(full) = query_param(url, "p").and_then(|p| safe_path(root, &p)) else {
        return fail(req, 400, "bad path");
    };
    if !full.is_file() {
        return fail(req, 404, "original not found");
    }
    let Some(orig) = known_original(sh, &full) else {
        return fail(req, 404, "MiColl doesn't know this picture yet");
    };
    let label = query_param(url, "label").map(|l| l.trim().to_string()).filter(|l| !l.is_empty());
    let enc = match encrypt_key(sh) {
        Ok(k) => k,
        Err(e) => return fail(req, 503, &e),
    };
    let dir = match sh.src.versions_dir() {
        Ok(d) => d,
        Err(e) => return fail(req, 500, &e),
    };
    if let Err(e) = std::fs::create_dir_all(&dir) {
        return fail(req, 500, &e.to_string());
    }
    let temp = temp_in(&dir);
    let hash = match receive(&mut req, &temp, enc.is_some()) {
        Ok(h) => h,
        Err((code, msg)) => {
            let _ = std::fs::remove_file(&temp);
            return fail(req, code, &msg);
        }
    };
    // pictures only, named after what they really are
    let mut head = [0u8; 64];
    let n = std::fs::File::open(&temp).and_then(|mut f| f.read(&mut head)).unwrap_or(0);
    let ext = match image::guess_format(&head[..n]) {
        Ok(image::ImageFormat::Png) => "png",
        Ok(image::ImageFormat::Jpeg) => "jpg",
        Ok(image::ImageFormat::WebP) => "webp",
        Ok(image::ImageFormat::Gif) => "gif",
        Ok(image::ImageFormat::Bmp) => "bmp",
        _ => {
            let _ = std::fs::remove_file(&temp);
            return fail(req, 415, "only pictures can be versions");
        }
    };

    let Ok(conn) = sh.src.db().lock() else {
        let _ = std::fs::remove_file(&temp);
        return fail(req, 500, "database busy");
    };
    // the same picture again (the original or a version it already has) isn't new
    match same_version(&conn, &full, &orig, &hash, sh.src.data_key()) {
        Ok(None) => {}
        Ok(Some(id)) => {
            let _ = std::fs::remove_file(&temp);
            return json(req, 200, &serde_json::json!({ "result": "same", "id": id }));
        }
        Err(e) => {
            let _ = std::fs::remove_file(&temp);
            return fail(req, 500, &e);
        }
    }

    if let Some(k) = enc {
        if let Err(e) = crypto::encrypt_file_in_place(&crypto::Dek::from_bytes(k), &temp) {
            let _ = std::fs::remove_file(&temp);
            return fail(req, 500, &e);
        }
    }
    let id = match db::add_image_version(&conn, &orig, "", label.as_deref()) {
        Ok(id) => id,
        Err(e) => {
            let _ = std::fs::remove_file(&temp);
            return fail(req, 500, &e.to_string());
        }
    };
    // <id>.<ext>, never over a file that's there (left over from an old version)
    let base = dir.join(format!("{id}.{ext}"));
    let placed = (1..100).find_map(|n| {
        let cand = numbered(&base, n);
        match place_new(&temp, &cand) {
            Ok(true) => Some(Ok(cand)),
            Ok(false) => None,
            Err(e) => Some(Err(e)),
        }
    });
    let dest = match placed {
        Some(Ok(d)) => d,
        other => {
            let _ = std::fs::remove_file(&temp);
            let _ = conn.execute("DELETE FROM image_versions WHERE id = ?1", [id]);
            let msg = match other {
                Some(Err(e)) => e.to_string(),
                _ => "no free name left".into(),
            };
            return fail(req, 500, &msg);
        }
    };
    let _ = conn.execute(
        "UPDATE image_versions SET file_path = ?2 WHERE id = ?1",
        rusqlite::params![id, dest.to_string_lossy()],
    );
    drop(conn);
    note_arrival(sh, None, None, Some((PathBuf::from(&orig), id)));
    json(req, 201, &serde_json::json!({ "result": "added", "id": id }))
}

#[derive(serde::Deserialize)]
struct CheckRequest {
    #[serde(default)]
    files: Vec<CheckItem>,
    #[serde(default)]
    versions: Vec<CheckItem>,
}

#[derive(serde::Deserialize)]
struct CheckItem {
    /// the file's path (files), or the original's (versions)
    p: String,
    sha256: String,
    /// the file's size: speeds up the comparison
    #[serde(default)]
    size: Option<u64>,
}

/// Most entries one check takes (the phone asks in parts).
const MAX_CHECK: usize = 5000;

/// POST /api/check: which of these does MiColl already have? Nothing is written.
/// files: "same" + where it is, or "new" + where an upload would land.
/// versions: "same" (+ the version id, null = it's the original), "new", or "unknown"
/// (MiColl doesn't know the original, an upload would answer 404).
fn check(mut req: tiny_http::Request, sh: &Arc<Shared>, root: &Path) {
    if *req.method() != tiny_http::Method::Post {
        return fail(req, 405, "use POST");
    }
    // encrypted files can only be compared while unlocked
    if let Err(e) = encrypt_key(sh) {
        return fail(req, 503, &e);
    }
    let mut body = Vec::new();
    if req.as_reader().take(16 * 1024 * 1024 + 1).read_to_end(&mut body).is_err() || body.len() > 16 * 1024 * 1024 {
        return fail(req, 413, "too much at once");
    }
    let ask: CheckRequest = match serde_json::from_slice(&body) {
        Ok(a) => a,
        Err(e) => return fail(req, 400, &e.to_string()),
    };
    if ask.files.len() + ask.versions.len() > MAX_CHECK {
        return fail(req, 413, "too many at once, ask in parts");
    }
    let key = sh.src.data_key();
    let hash_ok = |h: &str| h.len() == 64 && h.bytes().all(|b| b.is_ascii_hexdigit());

    let files: Vec<serde_json::Value> = ask
        .files
        .iter()
        .map(|f| {
            let hash = f.sha256.to_ascii_lowercase();
            let full = safe_path(root, &f.p).filter(|full| {
                let depth = full.strip_prefix(root).map(|r| r.components().count()).unwrap_or(0);
                depth >= 3 && matches!(kind_for(&ext_lower(full)), Some("image" | "video"))
            });
            match full {
                Some(full) if hash_ok(&hash) => match find_spot(&full, &hash, f.size, key) {
                    Spot::Same(at) => serde_json::json!({ "p": f.p, "result": "same", "path": rel(root, &at) }),
                    Spot::Free(at, _) => serde_json::json!({ "p": f.p, "result": "new", "path": rel(root, &at) }),
                    Spot::Full => serde_json::json!({ "p": f.p, "result": "bad" }),
                },
                _ => serde_json::json!({ "p": f.p, "result": "bad" }),
            }
        })
        .collect();

    let versions: Vec<serde_json::Value> = ask
        .versions
        .iter()
        .map(|v| {
            let hash = v.sha256.to_ascii_lowercase();
            let Some(full) = safe_path(root, &v.p).filter(|f| f.is_file() && hash_ok(&hash)) else {
                return serde_json::json!({ "p": v.p, "result": "bad" });
            };
            let Some(orig) = known_original(sh, &full) else {
                return serde_json::json!({ "p": v.p, "result": "unknown" });
            };
            let found = sh.src.db().lock().map_err(map_err).and_then(|c| same_version(&c, &full, &orig, &hash, key));
            match found {
                Ok(Some(id)) => serde_json::json!({ "p": v.p, "result": "same", "id": id }),
                Ok(None) => serde_json::json!({ "p": v.p, "result": "new" }),
                Err(_) => serde_json::json!({ "p": v.p, "result": "bad" }),
            }
        })
        .collect();

    json(req, 200, &serde_json::json!({ "files": files, "versions": versions }))
}

/* ---- addresses + pairing ------------------------------------------------ */

/// Every IPv4 address of this PC, the home network first: the default route can
/// be a VPN or a virtual adapter the phone can't reach.
fn lan_addresses() -> Vec<String> {
    let mut ips: Vec<(String, String)> = local_ip_address::list_afinet_netifas()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|(name, ip)| match ip {
            std::net::IpAddr::V4(v4) if !v4.is_loopback() && !v4.is_link_local() => Some((name, v4.to_string())),
            _ => None,
        })
        .collect();
    let rank = |name: &str, ip: &str| {
        let n = name.to_lowercase();
        let virt = virtual_adapter(name, ip);
        let real = ["wi-fi", "wifi", "wlan", "wireless", "ethernet"].iter().any(|v| n.contains(v));
        let lan = if ip.starts_with("192.168.") {
            0
        } else if ip.starts_with("172.") || ip.starts_with("10.") {
            1
        } else {
            2
        };
        (virt as u8, !real as u8, lan)
    };
    ips.sort_by_key(|(name, ip)| rank(name, ip));
    ips.into_iter().map(|(_, ip)| ip).collect()
}

/// A VPN, a virtual machine's network and the like (by the adapter's name).
fn virtual_adapter(name: &str, ip: &str) -> bool {
    let n = name.to_lowercase();
    ["virtualbox", "vmware", "vethernet", "hyper-v", "wsl", "vpn", "tap", "tun", "loopback", "bluetooth"]
        .iter()
        .any(|v| n.contains(v))
        || ip.starts_with("192.168.56.")
}

/* ---- public networks ---------------------------------------------------- */

/// One IPv4 address of this PC and the network Windows says it's on.
#[derive(Clone, Debug)]
struct NetAddr {
    ip: Ipv4Addr,
    prefix: u8,
    /// the adapter's name ("Wi-Fi", "Ethernet", a VPN …)
    adapter: String,
    /// Windows calls the network public
    public: bool,
    /// the network's id and name, None when Windows has none for it
    network: Option<(String, String)>,
}

/// This PC's addresses with their networks. Asked again at most every 10 s (a laptop
/// changes Wi-Fi), `fresh` asks right away (Settings opened).
fn net_addrs(fresh: bool) -> Vec<NetAddr> {
    static CACHE: Mutex<Option<(Instant, Vec<NetAddr>)>> = Mutex::new(None);
    let Ok(mut cache) = CACHE.lock() else { return read_net_addrs() };
    match cache.as_ref() {
        Some((at, addrs)) if !fresh && at.elapsed() < Duration::from_secs(10) => addrs.clone(),
        _ => {
            let addrs = read_net_addrs();
            *cache = Some((Instant::now(), addrs.clone()));
            addrs
        }
    }
}

/// The adapters' IPv4 addresses (GetAdaptersAddresses) and what the Network List
/// Manager says about their networks. COM runs on a thread of its own, the caller can
/// be the UI thread.
#[cfg(windows)]
fn read_net_addrs() -> Vec<NetAddr> {
    use windows::Win32::NetworkManagement::IpHelper::{
        GetAdaptersAddresses, GAA_FLAG_SKIP_ANYCAST, GAA_FLAG_SKIP_DNS_SERVER, GAA_FLAG_SKIP_MULTICAST, IP_ADAPTER_ADDRESSES_LH,
    };
    use windows::Win32::Networking::NetworkListManager::{INetworkListManager, NetworkListManager, NLM_NETWORK_CATEGORY_PUBLIC};
    use windows::Win32::Networking::WinSock::{AF_INET, SOCKADDR_IN};
    use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_ALL, COINIT_MULTITHREADED};

    std::thread::spawn(|| unsafe {
        let guid = |g: windows::core::GUID| format!("{g:?}").to_uppercase();
        // adapter id -> (public, network id, network name)
        let mut nets: HashMap<String, (bool, String, String)> = HashMap::new();
        let com = CoInitializeEx(None, COINIT_MULTITHREADED).is_ok();
        if let Ok(nlm) = CoCreateInstance::<_, INetworkListManager>(&NetworkListManager, None, CLSCTX_ALL) {
            if let Ok(conns) = nlm.GetNetworkConnections() {
                loop {
                    let mut one = [None];
                    let mut got = 0u32;
                    if conns.Next(&mut one, Some(&mut got)).is_err() || got == 0 {
                        break;
                    }
                    let Some(c) = one[0].take() else { break };
                    let (Ok(adapter), Ok(net)) = (c.GetAdapterId(), c.GetNetwork()) else { continue };
                    let public = net.GetCategory().is_ok_and(|k| k == NLM_NETWORK_CATEGORY_PUBLIC);
                    let id = net.GetNetworkId().map(guid).unwrap_or_default();
                    let name = net.GetName().map(|n| n.to_string()).unwrap_or_default();
                    nets.insert(guid(adapter), (public, id, name));
                }
            }
        }
        if com {
            CoUninitialize();
        }

        let mut out = Vec::new();
        // u64s: the list wants 8-byte alignment
        let mut buf = vec![0u64; 2048];
        for _ in 0..3 {
            let mut size = (buf.len() * 8) as u32;
            let flags = GAA_FLAG_SKIP_ANYCAST | GAA_FLAG_SKIP_MULTICAST | GAA_FLAG_SKIP_DNS_SERVER;
            let first = buf.as_mut_ptr() as *mut IP_ADAPTER_ADDRESSES_LH;
            match GetAdaptersAddresses(AF_INET.0 as u32, flags, None, Some(first), &mut size) {
                0 => {}
                // ERROR_BUFFER_OVERFLOW: `size` says how much it needs
                111 => {
                    buf = vec![0u64; size as usize / 8 + 1];
                    continue;
                }
                _ => break,
            }
            let mut a = first as *const IP_ADAPTER_ADDRESSES_LH;
            while let Some(ad) = a.as_ref() {
                let id = ad.AdapterName.to_string().unwrap_or_default().trim_matches(|c| c == '{' || c == '}').to_uppercase();
                let adapter = ad.FriendlyName.to_string().unwrap_or_default();
                let net = nets.get(&id);
                let mut u = ad.FirstUnicastAddress;
                while let Some(ua) = u.as_ref() {
                    let sa = ua.Address.lpSockaddr;
                    if !sa.is_null() && (*sa).sa_family == AF_INET {
                        let b = (*(sa as *const SOCKADDR_IN)).sin_addr.S_un.S_un_b;
                        out.push(NetAddr {
                            ip: Ipv4Addr::new(b.s_b1, b.s_b2, b.s_b3, b.s_b4),
                            prefix: ua.OnLinkPrefixLength,
                            adapter: adapter.clone(),
                            public: net.is_some_and(|n| n.0),
                            network: net.map(|n| (n.1.clone(), n.2.clone())),
                        });
                    }
                    u = ua.Next;
                }
                a = ad.Next;
            }
            break;
        }
        out
    })
    .join()
    .unwrap_or_default()
}
#[cfg(not(windows))]
fn read_net_addrs() -> Vec<NetAddr> {
    Vec::new()
}

/// The addresses on a public network the user didn't allow: nobody there gets an
/// answer. VPNs and virtual adapters don't count, they aren't the café's Wi-Fi.
fn closed<'a>(addrs: &'a [NetAddr], trusted: &'a HashSet<String>) -> impl Iterator<Item = &'a NetAddr> + 'a {
    addrs.iter().filter(move |a| {
        a.public
            && !virtual_adapter(&a.adapter, &a.ip.to_string())
            && !a.network.as_ref().is_some_and(|(id, _)| trusted.contains(id))
    })
}

/// Same network (the first `prefix` bits). A strange prefix only matches itself.
fn same_subnet(a: Ipv4Addr, b: Ipv4Addr, prefix: u8) -> bool {
    if !(8..=32).contains(&prefix) {
        return a == b;
    }
    let mask = u32::MAX << (32 - prefix as u32);
    u32::from(a) & mask == u32::from(b) & mask
}

fn trusted_networks(conn: &rusqlite::Connection) -> HashSet<String> {
    db::get_setting(conn, TRUSTED_SETTING)
        .ok()
        .flatten()
        .map(|s| s.split(',').map(str::trim).filter(|s| !s.is_empty()).map(str::to_string).collect())
        .unwrap_or_default()
}

/// A public network the PC is on, for Settings.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicNetwork {
    id: String,
    name: String,
    /// the user allowed the bridge there
    allowed: bool,
}

/// 12 letters and digits, no look-alikes (0/o, 1/l), so it can also be typed.
fn new_key() -> String {
    const ABC: &[u8] = b"abcdefghijkmnpqrstuvwxyz23456789";
    let mut raw = [0u8; 12];
    rand::RngCore::fill_bytes(&mut rand::rngs::OsRng, &mut raw);
    raw.iter().map(|b| ABC[*b as usize % ABC.len()] as char).collect()
}

/// The saved key, made on first use.
fn stored_key(conn: &rusqlite::Connection) -> Result<String, String> {
    if let Some(k) = db::get_setting(conn, KEY_SETTING).map_err(map_err)?.filter(|k| k.len() >= 8) {
        return Ok(k);
    }
    let k = new_key();
    db::set_setting(conn, KEY_SETTING, &k).map_err(map_err)?;
    Ok(k)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeInfo {
    running: bool,
    /// the address for typing on the phone (ip:port/k/key)
    address: String,
    /// the other addresses of this PC
    others: Vec<String>,
    qr_svg: String,
    /// the served folder
    folder: String,
    /// public networks the PC is on, the bridge only answers there when allowed
    public_networks: Vec<PublicNetwork>,
}

/// The addresses and the QR. Addresses on a closed public network are left out;
/// when nothing is left, `address` and `qr_svg` are empty and Settings says why.
fn info(key: &str, folder: &Path, trusted: &HashSet<String>) -> Result<BridgeInfo, String> {
    let addrs = net_addrs(true);
    let shut: HashSet<String> = closed(&addrs, trusted).map(|a| a.ip.to_string()).collect();
    let mut public_networks: Vec<PublicNetwork> = Vec::new();
    for a in addrs.iter().filter(|a| a.public && !virtual_adapter(&a.adapter, &a.ip.to_string())) {
        if let Some((id, name)) = a.network.as_ref().filter(|(id, _)| public_networks.iter().all(|p| &p.id != id)) {
            public_networks.push(PublicNetwork { id: id.clone(), name: name.clone(), allowed: trusted.contains(id) });
        }
    }
    let ips: Vec<String> = lan_addresses().into_iter().filter(|ip| !shut.contains(ip)).collect();
    let Some(first) = ips.first().cloned() else {
        if shut.is_empty() {
            return Err("No network found — is the PC on Wi-Fi or LAN?".into());
        }
        return Ok(BridgeInfo {
            running: true,
            address: String::new(),
            others: Vec::new(),
            qr_svg: String::new(),
            folder: folder.to_string_lossy().into_owned(),
            public_networks,
        });
    };
    let address = format!("{first}:{PORT}/k/{key}");
    // the qr also carries the other addresses, the phone tries them when the first fails
    let alt: Vec<String> = ips.iter().skip(1).map(|ip| format!("{ip}:{PORT}")).collect();
    let qr = if alt.is_empty() {
        format!("http://{address}/")
    } else {
        format!("http://{address}/?alt={}", alt.join(","))
    };
    let qr_svg = qrcode::QrCode::new(qr.as_bytes())
        .map_err(map_err)?
        .render::<qrcode::render::svg::Color>()
        .min_dimensions(200, 200)
        .quiet_zone(true)
        .build();
    Ok(BridgeInfo {
        running: true,
        address,
        others: alt.iter().map(|a| format!("{a}/k/{key}")).collect(),
        qr_svg,
        folder: folder.to_string_lossy().into_owned(),
        public_networks,
    })
}

/// Turn the bridge on (again) and get the pairing QR.
#[tauri::command]
pub fn phone_bridge_start(app: AppHandle, db: State<Db>, state: State<BridgeState>) -> Result<BridgeInfo, String> {
    let (key, folder, trusted) = {
        let conn = db.lock().map_err(map_err)?;
        (stored_key(&conn)?, served_root(&conn)?, trusted_networks(&conn))
    };
    let mut inner = state.lock().map_err(map_err)?;
    if inner.server.is_none() {
        let shared = Arc::new(Shared::new(Box::new(AppSource(app.clone())), key.clone(), trusted.clone()));
        let server = serve(PORT, shared.clone()).map_err(|_| {
            format!("Port {PORT} is taken. Is the old MiColl Bridge program still running? Close it and try again.")
        })?;
        inner.server = Some(server);
        inner.shared = Some(shared);
    }
    info(&key, &folder, &trusted)
}

/// Listen on all networks and start the workers.
fn serve(port: u16, shared: Arc<Shared>) -> Result<Arc<tiny_http::Server>, String> {
    let server = Arc::new(tiny_http::Server::http(("0.0.0.0", port)).map_err(|e| e.to_string())?);
    for _ in 0..WORKERS {
        let (server, shared) = (server.clone(), shared.clone());
        std::thread::spawn(move || {
            for req in server.incoming_requests() {
                // one bad request must never take the worker down
                let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| handle(req, &shared)));
            }
        });
    }
    Ok(server)
}

/// Turn the bridge off (the workers end).
#[tauri::command]
pub fn phone_bridge_stop(state: State<BridgeState>) -> Result<(), String> {
    let mut inner = state.lock().map_err(map_err)?;
    if let Some(server) = inner.server.take() {
        // one unblock ends one worker, the port closes when the last one is gone
        for _ in 0..WORKERS {
            server.unblock();
        }
    }
    inner.shared = None;
    Ok(())
}

/// A new pairing key: every paired phone has to scan the new QR code.
#[tauri::command]
pub fn phone_bridge_new_key(db: State<Db>, state: State<BridgeState>) -> Result<BridgeInfo, String> {
    let (key, folder, trusted) = {
        let conn = db.lock().map_err(map_err)?;
        let key = new_key();
        db::set_setting(&conn, KEY_SETTING, &key).map_err(map_err)?;
        (key, served_root(&conn)?, trusted_networks(&conn))
    };
    let inner = state.lock().map_err(map_err)?;
    if let Some(sh) = &inner.shared {
        *sh.key.write().map_err(map_err)? = key.clone();
        // re-pairing: whoever was shut out gets another go
        if let Ok(mut m) = sh.misses.lock() {
            m.clear();
        }
    }
    let mut out = info(&key, &folder, &trusted)?;
    out.running = inner.server.is_some();
    Ok(out)
}

/// Let the bridge answer on a public network after all (`allow` false takes it back).
#[tauri::command]
pub fn phone_bridge_trust_network(id: String, allow: bool, db: State<Db>, state: State<BridgeState>) -> Result<BridgeInfo, String> {
    let (key, folder, trusted) = {
        let conn = db.lock().map_err(map_err)?;
        let mut trusted = trusted_networks(&conn);
        if allow {
            trusted.insert(id);
        } else {
            trusted.remove(&id);
        }
        let mut list: Vec<&str> = trusted.iter().map(String::as_str).collect();
        list.sort();
        db::set_setting(&conn, TRUSTED_SETTING, &list.join(",")).map_err(map_err)?;
        (stored_key(&conn)?, served_root(&conn)?, trusted)
    };
    let inner = state.lock().map_err(map_err)?;
    if let Some(sh) = &inner.shared {
        *sh.trusted.write().map_err(map_err)? = trusted.clone();
    }
    let mut out = info(&key, &folder, &trusted)?;
    out.running = inner.server.is_some();
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    struct TestSource {
        db: Db,
        cache: PathBuf,
        versions: PathBuf,
        key: Option<[u8; 32]>,
        arrivals: Arc<Mutex<Vec<(Vec<String>, usize, usize)>>>,
    }
    impl Source for TestSource {
        fn db(&self) -> &Db {
            &self.db
        }
        fn data_key(&self) -> Option<[u8; 32]> {
            self.key
        }
        fn cache(&self) -> Result<PathBuf, String> {
            Ok(self.cache.clone())
        }
        fn versions_dir(&self) -> Result<PathBuf, String> {
            Ok(self.versions.clone())
        }
        fn arrived(&self, creators: &[String], files: &[FileArrival], versions: &[VersionArrival]) {
            let mut c = creators.to_vec();
            c.sort();
            self.arrivals.lock().unwrap().push((c, files.len(), versions.len()));
        }
    }

    /// the tables the bridge reads
    fn test_db(collection: &Path, encrypted: bool) -> Db {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
             CREATE TABLE artists (name TEXT, kind TEXT, tag TEXT, tags TEXT, links TEXT, notes TEXT,
                                   aliases TEXT, template_verified INTEGER, no_dates INTEGER, tier_list TEXT);
             CREATE TABLE rewards (folder_path TEXT, tier TEXT);
             CREATE TABLE images (file_path TEXT);
             CREATE TABLE image_versions (id INTEGER PRIMARY KEY AUTOINCREMENT, orig_path TEXT,
                                          file_path TEXT, label TEXT, created_at TEXT);
             CREATE TABLE image_active_version (orig_path TEXT PRIMARY KEY, version_id INTEGER);
             INSERT INTO artists (name, kind) VALUES ('Ahri', 'artist');",
        )
        .unwrap();
        db::set_setting(&conn, "collection_root", &collection.to_string_lossy()).unwrap();
        if encrypted {
            db::set_setting(&conn, "enc_enabled", "true").unwrap();
        }
        Mutex::new(conn)
    }

    fn put(url: &str, body: &[u8], sha: Option<&str>) -> (u16, serde_json::Value) {
        let mut r = ureq::put(url);
        if let Some(h) = sha {
            r = r.set("X-Sha256", h);
        }
        match r.send_bytes(body) {
            Ok(resp) => (resp.status(), serde_json::from_str(&resp.into_string().unwrap_or_default()).unwrap_or_default()),
            Err(ureq::Error::Status(code, resp)) => (code, serde_json::json!(resp.into_string().unwrap_or_default())),
            Err(e) => panic!("{e}"),
        }
    }

    fn sha_hex(b: &[u8]) -> String {
        Sha256::digest(b).iter().map(|x| format!("{x:02x}")).collect()
    }

    fn get(url: &str, range: Option<&str>) -> (u16, Vec<u8>) {
        let mut r = ureq::get(url);
        if let Some(v) = range {
            r = r.set("Range", v);
        }
        let resp = match r.call() {
            Ok(resp) => resp,
            Err(ureq::Error::Status(code, resp)) => return (code, resp.into_string().unwrap_or_default().into_bytes()),
            Err(e) => panic!("{e}"),
        };
        let code = resp.status();
        let mut buf = Vec::new();
        resp.into_reader().read_to_end(&mut buf).unwrap();
        (code, buf)
    }

    /// The whole server over real http: key check, gallery, thumbnail, ranges,
    /// path traversal and encrypted files (locked and unlocked).
    #[test]
    fn serves_only_with_the_key() {
        let base = std::env::temp_dir().join(format!("micoll_bridge_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let root = base.join("MiColl");
        let reward = root.join("Ahri").join("Patreon").join("2026").join("03").join("Set");
        std::fs::create_dir_all(&reward).unwrap();
        std::fs::create_dir_all(root.join(indexer::GRAVEYARD_DIR).join("Old").join("Patreon").join("2025").join("01").join("R")).unwrap();
        std::fs::write(root.join(indexer::GRAVEYARD_DIR).join("Old").join("Patreon").join("2025").join("01").join("R").join("x.png"), b"x").unwrap();
        image::RgbImage::from_pixel(64, 48, image::Rgb([200, 40, 90])).save(reward.join("a.png")).unwrap();
        std::fs::write(reward.join("clip.mp4"), b"0123456789").unwrap();
        let dek = crypto::generate_dek();
        std::fs::write(reward.join("secret.jpg"), dek.encrypt_bytes(b"hidden bytes")).unwrap();

        let run = |key: Option<[u8; 32]>| {
            let src = TestSource {
                db: test_db(&base, false),
                cache: base.join("cache"),
                versions: base.join("versions"),
                key,
                arrivals: Arc::default(),
            };
            // a tier on the reward and the creator's tier list
            {
                let c = src.db.lock().unwrap();
                c.execute("INSERT INTO rewards (folder_path, tier) VALUES (?1, '2')", [reward.to_string_lossy()]).unwrap();
                c.execute("UPDATE artists SET tier_list = '[\"1\",\"2\"]'", []).unwrap();
            }
            let shared = Arc::new(Shared::new(Box::new(src), "testkey1234".into(), HashSet::new()));
            let server = serve(0, shared).unwrap();
            let port = server.server_addr().to_ip().unwrap().port();
            (server, format!("http://127.0.0.1:{port}"))
        };

        let (server, url) = run(None);
        assert_eq!(get(&format!("{url}/api/ping"), None).0, 401);
        assert_eq!(get(&format!("{url}/k/wrongkey123/api/ping"), None).0, 401);
        let k = format!("{url}/k/testkey1234");
        let (code, body) = get(&format!("{k}/api/ping"), None);
        assert_eq!(code, 200);
        assert!(String::from_utf8_lossy(&body).contains("micoll-bridge"));

        let (code, body) = get(&format!("{k}/api/gallery"), None);
        assert_eq!(code, 200);
        let g: serde_json::Value = serde_json::from_slice(&body).unwrap();
        let artists = g.as_array().unwrap();
        // the graveyard isn't a creator
        assert_eq!(artists.len(), 1);
        assert_eq!(artists[0]["name"], "Ahri");
        assert_eq!(artists[0]["kind"], "artist");
        let month = &artists[0]["platforms"][0]["months"][0];
        assert_eq!(month["label"], "03.26");
        assert_eq!(month["rewards"][0]["images"].as_array().unwrap().len(), 3);
        assert_eq!(month["rewards"][0]["cover"], "Ahri/Patreon/2026/03/Set/a.png");
        // the tier goes along, and the creator's list
        assert_eq!(month["rewards"][0]["tier"], "2");
        assert_eq!(artists[0]["tiers"], serde_json::json!(["1", "2"]));

        let (code, body) = get(&format!("{k}/api/thumb?p=Ahri%2FPatreon%2F2026%2F03%2FSet%2Fa.png&s=300"), None);
        assert_eq!(code, 200);
        assert_eq!(&body[..2], &[0xFF, 0xD8]);

        let clip = format!("{k}/api/file?p=Ahri/Patreon/2026/03/Set/clip.mp4");
        assert_eq!(get(&clip, None), (200, b"0123456789".to_vec()));
        assert_eq!(get(&clip, Some("bytes=2-5")), (206, b"2345".to_vec()));
        assert_eq!(get(&format!("{k}/api/file?p=..%2F..%2Fsecret.txt"), None).0, 400);
        assert_eq!(get(&format!("{k}/api/file?p=Ahri/none.jpg"), None).0, 404);
        // the graveyard and hidden folders aren't served
        let grave = urlencoding::encode(indexer::GRAVEYARD_DIR);
        assert_eq!(get(&format!("{k}/api/file?p={grave}/Old/Patreon/2025/01/R/x.png"), None).0, 400);
        assert_eq!(get(&format!("{k}/api/file?p=Ahri/.hidden/x.png"), None).0, 400);

        // encrypted: nothing while locked
        let secret = format!("{k}/api/file?p=Ahri/Patreon/2026/03/Set/secret.jpg");
        assert_eq!(get(&secret, None).0, 503);
        for _ in 0..WORKERS {
            server.unblock();
        }
        drop(server);

        let (_server, url) = run(Some(dek.raw()));
        let secret = format!("{url}/k/testkey1234/api/file?p=Ahri/Patreon/2026/03/Set/secret.jpg");
        assert_eq!(get(&secret, None), (200, b"hidden bytes".to_vec()));
        assert_eq!(get(&secret, Some("bytes=0-5")), (206, b"hidden".to_vec()));

        let _ = std::fs::remove_dir_all(&base);
    }

    /// Uploads never replace a file: same content is skipped, other content gets a
    /// number. Versions are only added. Encrypted collections get encrypted files.
    #[test]
    fn uploads_never_overwrite() {
        for encrypted in [false, true] {
            let base = std::env::temp_dir().join(format!("micoll_bridge_up_{}_{encrypted}", std::process::id()));
            let _ = std::fs::remove_dir_all(&base);
            let root = base.join("MiColl");
            let reward = root.join("Ahri").join("Patreon").join("2026").join("03").join("Set");
            std::fs::create_dir_all(&reward).unwrap();
            let dek = crypto::generate_dek();
            let mut png = Vec::new();
            image::RgbImage::from_pixel(8, 8, image::Rgb([1, 2, 3]))
                .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
                .unwrap();
            let orig = reward.join("a.png");
            if encrypted {
                std::fs::write(&orig, dek.encrypt_bytes(&png)).unwrap();
            } else {
                std::fs::write(&orig, &png).unwrap();
            }

            let arrivals: Arc<Mutex<Vec<(Vec<String>, usize, usize)>>> = Arc::default();
            let db = test_db(&base, encrypted);
            db.lock().unwrap().execute("INSERT INTO images VALUES (?1)", [orig.to_string_lossy()]).unwrap();
            let src = TestSource {
                db,
                cache: base.join("cache"),
                versions: base.join("versions"),
                key: Some(dek.raw()),
                arrivals: arrivals.clone(),
            };
            let shared = Arc::new(Shared::new(Box::new(src), "testkey1234".into(), HashSet::new()));
            let server = serve(0, shared).unwrap();
            let k = format!("http://127.0.0.1:{}/k/testkey1234", server.server_addr().to_ip().unwrap().port());
            let up = |p: &str| format!("{k}/api/upload?p={}", urlencoding::encode(p));

            // the same picture that's there: skipped, the file stays as it was
            let before = std::fs::read(&orig).unwrap();
            let (code, body) = put(&up("Ahri/Patreon/2026/03/Set/a.png"), &png, None);
            assert_eq!((code, body["result"].as_str()), (200, Some("same")));
            assert_eq!(std::fs::read(&orig).unwrap(), before);

            // other content, same name: a new name, the old file untouched
            let (code, body) = put(&up("Ahri/Patreon/2026/03/Set/a.png"), b"other bytes", None);
            assert_eq!((code, body["result"].as_str(), body["path"].as_str()), (201, Some("renamed"), Some("Ahri/Patreon/2026/03/Set/a (2).png")));
            assert_eq!(std::fs::read(&orig).unwrap(), before);
            // and again: that one is the same now
            let (code, body) = put(&up("Ahri/Patreon/2026/03/Set/a.png"), b"other bytes", None);
            assert_eq!((code, body["path"].as_str()), (200, Some("Ahri/Patreon/2026/03/Set/a (2).png")));
            // differs only in upper/lower case: still the same file on Windows
            let (code, _) = put(&up("Ahri/Patreon/2026/03/Set/A.PNG"), &png, None);
            assert_eq!(code, 200);

            // a new reward folder for a new creator
            let (code, body) = put(&up("Neu/Patreon/2026/04/R/b.jpg"), b"jpeg bytes", Some(&sha_hex(b"jpeg bytes")));
            assert_eq!((code, body["result"].as_str()), (201, Some("saved")));
            let saved = root.join("Neu").join("Patreon").join("2026").join("04").join("R").join("b.jpg");
            assert_eq!(crypto::file_is_encrypted(&saved), encrypted);
            assert_eq!(content_hash(&saved, Some(dek.raw())), Some(sha_hex(b"jpeg bytes")));

            // refused: wrong checksum, bad paths, not media, not PUT
            assert_eq!(put(&up("Neu/Patreon/2026/04/R/c.jpg"), b"x", Some("00")).0, 422);
            assert!(!root.join("Neu").join("Patreon").join("2026").join("04").join("R").join("c.jpg").exists());
            assert_eq!(put(&up("../evil.jpg"), b"x", None).0, 400);
            assert_eq!(put(&up("Ahri/x.jpg"), b"x", None).0, 400);
            assert_eq!(put(&up("Ahri/Patreon/notes.txt"), b"x", None).0, 400);
            assert_eq!(put(&up(&format!("{}/Old/P/x.jpg", indexer::GRAVEYARD_DIR)), b"x", None).0, 400);
            assert_eq!(get(&up("Ahri/Patreon/2026/03/Set/z.png"), None).0, 405);
            // no temp files left behind
            let parts = walkdir::WalkDir::new(&root).into_iter().flatten().filter(|e| e.file_name().to_string_lossy().ends_with(".part")).count();
            assert_eq!(parts, 0);

            // versions: only added, never the active one, the same one twice is "same"
            let ver = format!("{k}/api/version?p={}&label=phone", urlencoding::encode("Ahri/Patreon/2026/03/Set/a.png"));
            let mut edited = Vec::new();
            image::RgbImage::from_pixel(8, 8, image::Rgb([9, 9, 9]))
                .write_to(&mut std::io::Cursor::new(&mut edited), image::ImageFormat::Jpeg)
                .unwrap();
            let (code, body) = put(&ver, &edited, None);
            assert_eq!((code, body["result"].as_str()), (201, Some("added")));
            let id = body["id"].as_i64().unwrap();
            let (code, body) = put(&ver, &edited, None);
            assert_eq!((code, body["result"].as_str(), body["id"].as_i64()), (200, Some("same"), Some(id)));
            assert_eq!(put(&ver, &png, None).1["result"], "same");
            assert_eq!(put(&ver, b"not a picture", None).0, 415);

            // the way back: counted in the gallery, listed with the checksum of exactly
            // what version-file sends, and that's the bytes the phone sent
            let gal = get(&format!("{k}/api/gallery"), None).1;
            let g: serde_json::Value = serde_json::from_slice(&gal).unwrap();
            let imgs = g.as_array().unwrap().iter().find(|a| a["name"] == "Ahri").unwrap()["platforms"][0]["months"][0]["rewards"][0]["images"].clone();
            let a = imgs.as_array().unwrap().iter().find(|i| i["name"] == "a.png").unwrap();
            assert_eq!(a["versions"].as_u64(), Some(1));
            assert!(imgs.as_array().unwrap().iter().filter(|i| i["name"] != "a.png").all(|i| i.get("versions").is_none()));
            let vl = format!("{k}/api/versions?p={}", urlencoding::encode("Ahri/Patreon/2026/03/Set/a.png"));
            let (code, body) = get(&vl, None);
            assert_eq!(code, 200);
            let list: serde_json::Value = serde_json::from_slice(&body).unwrap();
            assert_eq!(list["list"][0]["id"].as_i64(), Some(id));
            assert_eq!(list["list"][0]["sha256"].as_str(), Some(sha_hex(&edited).as_str()));
            assert_eq!(list["list"][0]["size"].as_u64(), Some(edited.len() as u64));
            assert_eq!(list["list"][0]["label"].as_str(), Some("phone"));
            // the original stays the active one
            assert!(list["active"].is_null());
            assert_eq!(get(&format!("{k}/api/version-file?id={id}"), None), (200, edited.clone()));
            assert_eq!(get(&format!("{k}/api/version-file?id=999"), None).0, 404);
            assert_eq!(get(&format!("{k}/api/versions?p={}", urlencoding::encode("Ahri/none.png")), None).0, 404);
            drop(server);

            // MiColl re-read both creators once, after the phone stopped
            std::thread::sleep(SETTLE * 3);
            let got = arrivals.lock().unwrap().clone();
            let files: usize = got.iter().map(|a| a.1).sum();
            let versions: usize = got.iter().map(|a| a.2).sum();
            assert_eq!((files, versions), (2, 1));
            assert!(got.iter().any(|a| a.0 == vec!["Ahri".to_string(), "Neu".to_string()]));

            let vfile = std::fs::read_dir(base.join("versions")).unwrap().flatten().map(|e| e.path()).collect::<Vec<_>>();
            assert_eq!(vfile.len(), 1);
            assert_eq!(vfile[0].file_name().unwrap().to_string_lossy(), format!("{id}.jpg"));
            assert_eq!(crypto::file_is_encrypted(&vfile[0]), encrypted);
            let _ = std::fs::remove_dir_all(&base);
        }
    }

    /// What MiColl does when the phone stopped sending: the creator (new or known)
    /// is read in like F5, against the real database.
    #[test]
    fn arrivals_show_up_in_micoll() {
        let base = std::env::temp_dir().join(format!("micoll_bridge_idx_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let root = base.join("MiColl");
        let reward = root.join("Neu").join("Patreon").join("2026").join("04").join("Set");
        std::fs::create_dir_all(&reward).unwrap();
        image::RgbImage::from_pixel(8, 8, image::Rgb([1, 2, 3])).save(reward.join("a.png")).unwrap();
        let conn = db::open(&base.join("micoll.db")).unwrap();

        reindex_creator(&conn, &root, "Neu").unwrap();
        let n: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM images i JOIN rewards r ON r.id = i.reward_id JOIN periods p ON p.id = r.period_id
                 JOIN artists a ON a.id = p.artist_id WHERE a.name = 'Neu'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(n, 1);

        // a second picture later: the same creator, now two
        image::RgbImage::from_pixel(8, 8, image::Rgb([4, 5, 6])).save(reward.join("b.png")).unwrap();
        reindex_creator(&conn, &root, "Neu").unwrap();
        let artists: i64 = conn.query_row("SELECT COUNT(*) FROM artists WHERE name = 'Neu'", [], |r| r.get(0)).unwrap();
        let images: i64 = conn.query_row("SELECT COUNT(*) FROM images", [], |r| r.get(0)).unwrap();
        assert_eq!((artists, images), (1, 2));

        // where they landed: one reward, two files and a version of the first one
        let a = reward.join("a.png");
        let places = arrived_places(&conn, &[a.clone(), reward.join("b.png"), root.join("gone.png")], &[a]);
        assert_eq!(places.len(), 1);
        let p = &places[0];
        assert_eq!((p.creator.as_str(), p.reward.as_str(), p.files, p.versions), ("Neu", "Set", 2, 1));
        let period: i64 = conn.query_row("SELECT period_id FROM rewards WHERE id = ?1", [p.reward_id], |r| r.get(0)).unwrap();
        assert_eq!(period, p.period_id);

        // in the history, and undone from there: a creator the phone made goes again,
        // the files to the "Recycle Bin" (a folder here, not the real one)
        let bin = base.join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        let recycle = |p: &Path| std::fs::rename(p, bin.join(p.file_name().unwrap())).map_err(|e| e.to_string());
        log_arrivals(&conn, &root, &[(reward.join("a.png"), Some(root.join("Neu"))), (reward.join("b.png"), Some(root.join("Neu")))], &[]);
        let row = history::latest_open(&conn).unwrap().unwrap();
        assert_eq!((row.action.as_str(), row.kind.as_str(), row.count), ("phone", "image", 2));
        assert_eq!(row.artist.as_deref(), Some("Neu"));
        assert!(history::undoable(&row));
        assert_eq!(row.items[0].back, Some(p.reward_id));
        undo_phone(&conn, &row, &recycle).unwrap();
        assert!(!root.join("Neu").exists());
        assert!(bin.join("a.png").is_file() && bin.join("b.png").is_file());
        let artists: i64 = conn.query_row("SELECT COUNT(*) FROM artists WHERE name = 'Neu'", [], |r| r.get(0)).unwrap();
        assert_eq!(artists, 0);

        // into a reward that was there before: it stays, only what came is taken back
        let old = root.join("Alt").join("Patreon").join("2026").join("05").join("Set");
        std::fs::create_dir_all(&old).unwrap();
        image::RgbImage::from_pixel(8, 8, image::Rgb([7, 7, 7])).save(old.join("mine.png")).unwrap();
        reindex_creator(&conn, &root, "Alt").unwrap();
        image::RgbImage::from_pixel(8, 8, image::Rgb([8, 8, 8])).save(old.join("phone.png")).unwrap();
        reindex_creator(&conn, &root, "Alt").unwrap();
        log_arrivals(&conn, &root, &[(old.join("phone.png"), None)], &[]);
        let row = history::latest_open(&conn).unwrap().unwrap();
        // something changed in between: nothing is touched
        std::fs::rename(old.join("phone.png"), old.join("moved.png")).unwrap();
        assert!(undo_phone(&conn, &row, &recycle).unwrap_err().starts_with("undo:changed:"));
        assert!(old.join("mine.png").is_file() && old.join("moved.png").is_file());
        std::fs::rename(old.join("moved.png"), old.join("phone.png")).unwrap();
        undo_phone(&conn, &row, &recycle).unwrap();
        assert!(old.join("mine.png").is_file() && !old.join("phone.png").exists());
        let left: i64 = conn
            .query_row("SELECT COUNT(*) FROM images WHERE file_path LIKE '%Alt%'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(left, 1);

        // a version from the phone: removed again, its file to the bin
        let vfile = base.join("v1.png");
        std::fs::write(&vfile, b"v").unwrap();
        let mine = old.join("mine.png");
        let vid = db::add_image_version(&conn, &mine.to_string_lossy(), &vfile.to_string_lossy(), Some("Phone")).unwrap();
        log_arrivals(&conn, &root, &[], &[(mine.clone(), vid)]);
        let row = history::latest_open(&conn).unwrap().unwrap();
        assert_eq!((row.action.as_str(), row.kind.as_str()), ("phone", "version"));
        assert!(history::undoable(&row));
        undo_phone(&conn, &row, &recycle).unwrap();
        assert!(bin.join("v1.png").is_file());
        assert!(db::list_image_versions(&conn, &mine.to_string_lossy()).unwrap().0.is_empty());
        drop(conn);
        let _ = std::fs::remove_dir_all(&base);
    }

    fn post(url: &str, body: &serde_json::Value) -> (u16, serde_json::Value) {
        match ureq::post(url).set("Content-Type", "application/json").send_string(&body.to_string()) {
            Ok(resp) => (resp.status(), serde_json::from_str(&resp.into_string().unwrap_or_default()).unwrap_or_default()),
            Err(ureq::Error::Status(code, resp)) => (code, serde_json::json!(resp.into_string().unwrap_or_default())),
            Err(e) => panic!("{e}"),
        }
    }

    /// The check answers what an upload would do, without anything sent or written.
    #[test]
    fn check_says_what_is_there() {
        for encrypted in [false, true] {
            let base = std::env::temp_dir().join(format!("micoll_bridge_chk_{}_{encrypted}", std::process::id()));
            let _ = std::fs::remove_dir_all(&base);
            let root = base.join("MiColl");
            let reward = root.join("Ahri").join("Patreon").join("2026").join("03").join("Set");
            std::fs::create_dir_all(&reward).unwrap();
            let dek = crypto::generate_dek();
            let mut png = Vec::new();
            image::RgbImage::from_pixel(8, 8, image::Rgb([1, 2, 3]))
                .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
                .unwrap();
            let orig = reward.join("a.png");
            let store = |p: &Path, b: &[u8]| std::fs::write(p, if encrypted { dek.encrypt_bytes(b) } else { b.to_vec() }).unwrap();
            store(&orig, &png);
            store(&reward.join("b (2).jpg"), b"second b");
            store(&reward.join("b.jpg"), b"first b");

            let db = test_db(&base, encrypted);
            db.lock().unwrap().execute("INSERT INTO images VALUES (?1)", [orig.to_string_lossy()]).unwrap();
            let src = TestSource { db, cache: base.join("cache"), versions: base.join("versions"), key: Some(dek.raw()), arrivals: Arc::default() };
            let server = serve(0, Arc::new(Shared::new(Box::new(src), "testkey1234".into(), HashSet::new()))).unwrap();
            let k = format!("http://127.0.0.1:{}/k/testkey1234", server.server_addr().to_ip().unwrap().port());

            let before: Vec<_> = walkdir::WalkDir::new(&base).into_iter().flatten().map(|e| e.path().to_path_buf()).collect();
            let ask = serde_json::json!({
                "files": [
                    { "p": "Ahri/Patreon/2026/03/Set/a.png", "sha256": sha_hex(&png), "size": png.len() },
                    // the same name, different content (no size given)
                    { "p": "Ahri/Patreon/2026/03/Set/A.PNG", "sha256": sha_hex(b"other") },
                    // already there under its numbered name
                    { "p": "Ahri/Patreon/2026/03/Set/b.jpg", "sha256": sha_hex(b"second b"), "size": 8 },
                    { "p": "Neu/Patreon/2026/04/R/c.jpg", "sha256": sha_hex(b"c") },
                    { "p": "../x.jpg", "sha256": sha_hex(b"c") },
                    { "p": "Ahri/Patreon/notes.txt", "sha256": sha_hex(b"c") },
                    { "p": "Ahri/Patreon/2026/03/Set/d.jpg", "sha256": "nothex" }
                ],
                "versions": [
                    { "p": "Ahri/Patreon/2026/03/Set/a.png", "sha256": sha_hex(&png) },
                    { "p": "Ahri/Patreon/2026/03/Set/a.png", "sha256": sha_hex(b"edit") },
                    { "p": "Ahri/Patreon/2026/03/Set/b.jpg", "sha256": sha_hex(b"edit") },
                    { "p": "Ahri/none.png", "sha256": sha_hex(b"edit") }
                ]
            });
            let (code, got) = post(&format!("{k}/api/check"), &ask);
            assert_eq!(code, 200);
            let res = |list: &str, i: usize, field: &str| got[list][i][field].as_str().map(str::to_string);
            assert_eq!(res("files", 0, "result").as_deref(), Some("same"));
            assert_eq!(res("files", 0, "path").as_deref(), Some("Ahri/Patreon/2026/03/Set/a.png"));
            assert_eq!(res("files", 1, "result").as_deref(), Some("new"));
            assert_eq!(res("files", 1, "path").as_deref(), Some("Ahri/Patreon/2026/03/Set/A (2).PNG"));
            assert_eq!(res("files", 2, "result").as_deref(), Some("same"));
            assert_eq!(res("files", 2, "path").as_deref(), Some("Ahri/Patreon/2026/03/Set/b (2).jpg"));
            assert_eq!(res("files", 3, "result").as_deref(), Some("new"));
            assert_eq!(res("files", 3, "path").as_deref(), Some("Neu/Patreon/2026/04/R/c.jpg"));
            for i in 4..7 {
                assert_eq!(res("files", i, "result").as_deref(), Some("bad"), "file {i}");
            }
            assert_eq!(res("versions", 0, "result").as_deref(), Some("same"));
            assert!(got["versions"][0]["id"].is_null());
            assert_eq!(res("versions", 1, "result").as_deref(), Some("new"));
            assert_eq!(res("versions", 2, "result").as_deref(), Some("unknown"));
            assert_eq!(res("versions", 3, "result").as_deref(), Some("bad"));

            // a version that was added is "same" with its id afterwards
            let ver = format!("{k}/api/version?p={}", urlencoding::encode("Ahri/Patreon/2026/03/Set/a.png"));
            let mut edited = Vec::new();
            image::RgbImage::from_pixel(8, 8, image::Rgb([9, 9, 9]))
                .write_to(&mut std::io::Cursor::new(&mut edited), image::ImageFormat::Png)
                .unwrap();
            let id = put(&ver, &edited, None).1["id"].as_i64().unwrap();
            let again = serde_json::json!({ "versions": [{ "p": "Ahri/Patreon/2026/03/Set/a.png", "sha256": sha_hex(&edited) }] });
            let (_, got2) = post(&format!("{k}/api/check"), &again);
            assert_eq!((got2["versions"][0]["result"].as_str(), got2["versions"][0]["id"].as_i64()), (Some("same"), Some(id)));

            // nothing written by the check itself (only the version file above)
            let after: Vec<_> = walkdir::WalkDir::new(&root).into_iter().flatten().map(|e| e.path().to_path_buf()).collect();
            assert_eq!(after, before.into_iter().filter(|p| p.starts_with(&root)).collect::<Vec<_>>());
            assert_eq!(get(&format!("{k}/api/check"), None).0, 405);
            assert_eq!(post(&format!("{k}/api/check"), &serde_json::json!("nonsense")).0, 400);
            drop(server);
            let _ = std::fs::remove_dir_all(&base);
        }
    }

    #[test]
    fn keys_can_be_typed() {
        let k = new_key();
        assert_eq!(k.len(), 12);
        assert!(k.chars().all(|c| "abcdefghijkmnpqrstuvwxyz23456789".contains(c)));
        assert!(same_key("abc", "abc") && !same_key("abc", "abd") && !same_key("abc", "abcd"));
    }

    /// Many different wrong keys shut the device out (even with the right key then),
    /// an old key repeated doesn't, and a new key lets everybody try again.
    #[test]
    fn key_guessers_get_shut_out() {
        let base = std::env::temp_dir().join(format!("micoll_bridge_guess_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(base.join("MiColl").join("Ahri")).unwrap();
        let src = TestSource {
            db: test_db(&base, false),
            cache: base.join("cache"),
            versions: base.join("versions"),
            key: None,
            arrivals: Arc::default(),
        };
        let shared = Arc::new(Shared::new(Box::new(src), "testkey1234".into(), HashSet::new()));

        let phone: IpAddr = "192.168.1.20".parse().unwrap();
        for _ in 0..50 {
            assert!(!shared.wrong_key(phone, "oldkey123456"));
        }
        assert!(!shared.shut_out(phone));

        let server = serve(0, shared.clone()).unwrap();
        let url = format!("http://127.0.0.1:{}", server.server_addr().to_ip().unwrap().port());
        assert_eq!(get(&format!("{url}/k/testkey1234/api/ping"), None).0, 200);
        for i in 0..MISS_LIMIT {
            assert_eq!(get(&format!("{url}/k/guess{i:07}/api/ping"), None).0, 401);
        }
        assert_eq!(get(&format!("{url}/k/testkey1234/api/ping"), None).0, 429);
        assert!(!shared.shut_out(phone), "only the guesser is out");

        shared.misses.lock().unwrap().clear();
        assert_eq!(get(&format!("{url}/k/testkey1234/api/ping"), None).0, 200);
        for _ in 0..WORKERS {
            server.unblock();
        }
        let _ = std::fs::remove_dir_all(&base);
    }

    /// Public networks are closed unless allowed, VPNs never count as public.
    #[test]
    fn public_networks_stay_closed() {
        let addr = |ip: &str, adapter: &str, public: bool, id: &str| NetAddr {
            ip: ip.parse().unwrap(),
            prefix: 24,
            adapter: adapter.into(),
            public,
            network: Some((id.into(), "Network".into())),
        };
        let addrs = vec![
            addr("192.168.1.5", "Wi-Fi", true, "CAFE"),
            addr("10.0.0.5", "Ethernet", false, "HOME"),
            addr("10.8.0.2", "WireGuard VPN", true, "VPN"),
        ];
        let none = HashSet::new();
        let shut: Vec<_> = closed(&addrs, &none).map(|a| a.ip.to_string()).collect();
        assert_eq!(shut, ["192.168.1.5"]);
        let allowed: HashSet<String> = ["CAFE".to_string()].into();
        assert_eq!(closed(&addrs, &allowed).count(), 0);

        let ip = |s: &str| s.parse::<Ipv4Addr>().unwrap();
        assert!(same_subnet(ip("192.168.1.5"), ip("192.168.1.77"), 24));
        assert!(!same_subnet(ip("192.168.1.5"), ip("192.168.2.77"), 24));
        assert!(same_subnet(ip("10.0.0.5"), ip("10.200.3.4"), 8));
        // a broken prefix doesn't close the whole world
        assert!(!same_subnet(ip("192.168.1.5"), ip("8.8.8.8"), 0));
    }

    #[cfg(windows)]
    #[test]
    fn knows_the_free_space() {
        assert!(free_space(&std::env::temp_dir()).is_some_and(|f| f > 0));
        // the real adapters: at least loopback-free addresses, without panicking
        let _ = read_net_addrs();
    }
}
