//! MiSD: move rewards to ONE external disk while MiColl still shows them.
//!
//! Rewards (or whole months/creators) get sd_marked. Transport then moves each
//! marked folder to the disk with a checked copy: every file is copied, compared
//! by SHA-256 and only then deleted at the source (a failed check keeps both).
//! The DB paths are updated (db::relink_prefix), sd_volume = the disk label,
//! sd_origin = the old folder so "Bring back" can restore it.
//!
//! While the disk is unplugged the rows stay (prune_missing skips SD rewards) and
//! covers come from previews saved at transport time. A marker file on the disk
//! identifies it and fixes a changed drive letter.
//!
//! Second mode: BACKUP copies the same way but keeps the local files
//! (sd_backup = disk label, sd_backup_path = where the copy is).
//! Only sd_volume restricts anything! A backed-up reward works like any local one,
//! every guard checks sd_volume only.
//! Backups live in their own <root>\_backup\ folder, otherwise a backed-up parent
//! could overwrite a moved child's only copy.

use crate::db;
use crate::thumbs;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

/// Marker file at the MiSD root (disk identity + connected check).
/// The indexer skips it.
pub const MARKER: &str = ".micoll-sd.json";

/// Subfolder for BACKUP copies, separate from moved rewards.
/// The indexer skips it (a backup must never become a duplicate reward).
pub const BACKUP_DIR: &str = "_backup";

/// Which queue a reward is in (the value in rewards.sd_marked).
/// One column instead of two booleans, a reward can only be in one queue.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum SdMode {
    /// Move to the disk and free the space.
    Move,
    /// Copy to the disk and keep the local files.
    Backup,
}

impl SdMode {
    pub fn value(self) -> i64 {
        match self {
            SdMode::Move => 1,
            SdMode::Backup => 2,
        }
    }
    /// Parse the frontend string, anything unknown = move (old behavior).
    pub fn parse(s: &str) -> Self {
        if s.eq_ignore_ascii_case("backup") {
            SdMode::Backup
        } else {
            SdMode::Move
        }
    }
}

/// The _backup folder of a MiSD root.
fn backup_root(sd_root: &str) -> PathBuf {
    Path::new(sd_root).join(BACKUP_DIR)
}

#[derive(Serialize, Deserialize, Clone)]
struct Marker {
    id: String,
    label: String,
    created: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SdStatus {
    pub configured: bool,
    pub root: Option<String>,
    pub label: Option<String>,
    /// Marker with the right id found, the disk is connected.
    pub available: bool,
    /// Rewards queued for the next move.
    pub marked: u32,
    /// Rewards currently on the disk.
    pub transported: u32,
    /// Rewards queued for the next backup.
    pub backup_marked: u32,
    /// Rewards with a checked copy on the disk that are still local.
    pub backups: u32,
    /// Offline previews are kept for moved rewards (see keep_previews).
    pub previews: bool,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SdSummary {
    /// Rewards done (moved or copied).
    pub moved: u32,
    pub failed: u32,
    pub errors: Vec<String>,
    /// The user stopped the job. Everything in moved is done, the rest is still queued.
    pub cancelled: bool,
}

/* ---- stopping a job ------------------------------------------------------ */

/// Set by sd_cancel while a job runs. One flag for all jobs, only one can run
/// at a time (each holds the DB lock).
static CANCEL: AtomicBool = AtomicBool::new(false);

/// Ask the running job to stop. The current reward is finished first.
pub fn request_cancel() {
    CANCEL.store(true, Ordering::Relaxed);
}

/// Clear an old stop request when a job starts.
fn begin_job() {
    CANCEL.store(false, Ordering::Relaxed);
}

/// Only checked BETWEEN rewards. A reward is copied, checked and then deleted,
/// stopping in the middle could leave a broken half. Between rewards everything
/// is either done or untouched.
fn stop_requested() -> bool {
    CANCEL.load(Ordering::Relaxed)
}

/* ---- settings / marker ------------------------------------------------- */

fn setting(conn: &Connection, key: &str) -> Option<String> {
    db::get_setting(conn, key)
        .ok()
        .flatten()
        .filter(|s| !s.trim().is_empty())
}

/// Setting: keep an offline preview for moved rewards.
pub const PREVIEWS_SETTING: &str = "sd_previews";

/// Keep those previews? On by default, otherwise moved tiles only show a gradient
/// while the disk is unplugged. Off saves cache space.
pub fn keep_previews(conn: &Connection) -> bool {
    setting(conn, PREVIEWS_SETTING).map_or(true, |v| v != "0")
}

fn read_marker(root: &Path) -> Option<Marker> {
    let raw = std::fs::read_to_string(root.join(MARKER)).ok()?;
    serde_json::from_str(&raw).ok()
}

/// Rewards that can't be moved: template placeholders (fake \u{1} keys) and missing rows.
const TRANSPORTABLE: &str = "status != 'missing' AND instr(folder_path, char(1)) = 0";
/// Same filter when rewards is aliased as r.
const TRANSPORTABLE_R: &str = "r.status != 'missing' AND instr(r.folder_path, char(1)) = 0";

/// Set up (or rename) the MiSD disk. Writes the marker. Refuses a folder that
/// belongs to ANOTHER library's MiSD (different id), unless we have no id yet.
pub fn setup(conn: &Connection, path: &str, label: &str) -> Result<SdStatus, String> {
    let root = Path::new(path.trim());
    if path.trim().is_empty() {
        return Err("Choose a folder on the external disk first.".into());
    }
    // the disk must be OUTSIDE every scanned folder, otherwise the indexer would pick up
    // the moved rewards and backups as duplicates
    let root_s = root.to_string_lossy().into_owned();
    let mut scanned: Vec<String> = db::list_roots(conn)
        .map_err(|e| e.to_string())?
        .into_iter()
        .map(|r| r.path)
        .collect();
    if let Some(c) = setting(conn, "collection_root") {
        scanned.push(c);
    }
    for s in scanned {
        if under_or_equal(&root_s, &s) || under_or_equal(&s, &root_s) {
            return Err(format!(
                "That folder overlaps your library folder “{s}”. Choose a folder on the \
                 external disk, outside anything MiColl scans."
            ));
        }
    }

    std::fs::create_dir_all(root).map_err(|e| format!("create {}: {e}", root.display()))?;
    let label = {
        let l = label.trim();
        if l.is_empty() { "MiSD" } else { l }
    };

    let our_id = setting(conn, "sd_id");
    let id = match read_marker(root) {
        Some(m) => match &our_id {
            Some(sid) if *sid != m.id => {
                return Err(
                    "This folder already belongs to a different MiSD disk — choose an empty \
                     folder, or your original MiSD folder."
                        .into(),
                );
            }
            _ => m.id, // same disk (re-label) or adopting after a fresh install
        },
        None => match &our_id {
            // settings know a disk but its marker isn't here -> NEW location.
            // keep the id only if nothing was ever put on the old disk
            Some(sid) if count_transported(conn)? > 0 || count_backups(conn)? > 0 => {
                return Err(format!(
                    "Your MiSD disk (id …{}) already holds transported rewards or backups. \
                     Connect that disk (or bring everything back) before switching to a new folder.",
                    &sid[sid.len().saturating_sub(6)..]
                ));
            }
            _ => new_id(),
        },
    };

    let marker = Marker {
        id: id.clone(),
        label: label.to_string(),
        created: crate::signing::chrono_date(),
    };
    let json = serde_json::to_string_pretty(&marker).map_err(|e| e.to_string())?;
    std::fs::write(root.join(MARKER), json).map_err(|e| format!("write marker: {e}"))?;

    let set = |k: &str, v: &str| db::set_setting(conn, k, v).map_err(|e| e.to_string());
    set("sd_root", &root.to_string_lossy())?;
    set("sd_label", label)?;
    set("sd_id", &id)?;
    status(conn)
}

fn new_id() -> String {
    use rand::RngCore;
    let mut b = [0u8; 16];
    rand::rngs::OsRng.fill_bytes(&mut b);
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn count_transported(conn: &Connection) -> Result<u32, String> {
    conn.query_row("SELECT COUNT(*) FROM rewards WHERE sd_volume IS NOT NULL", [], |r| r.get(0))
        .map_err(|e| e.to_string())
}

fn count_backups(conn: &Connection) -> Result<u32, String> {
    conn.query_row("SELECT COUNT(*) FROM rewards WHERE sd_backup IS NOT NULL", [], |r| r.get(0))
        .map_err(|e| e.to_string())
}

/// A creator with rewards in a MiSD queue, for the confirmation (counts per queue).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueuedCreator {
    pub name: String,
    pub moves: u32,
    pub backups: u32,
}

/// Who the next transport will touch (names only, so you can check the list quickly).
pub fn queued_creators(conn: &Connection) -> Result<Vec<QueuedCreator>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT a.name,
                    SUM(CASE WHEN r.sd_marked = 1 THEN 1 ELSE 0 END) AS moves,
                    SUM(CASE WHEN r.sd_marked = 2 THEN 1 ELSE 0 END) AS backups
               FROM rewards r
               JOIN periods p ON p.id = r.period_id
               JOIN artists a ON a.id = p.artist_id
              WHERE r.sd_marked <> 0
              GROUP BY a.id
              ORDER BY a.name COLLATE NOCASE",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok(QueuedCreator { name: r.get(0)?, moves: r.get(1)?, backups: r.get(2)? })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>().map_err(|e| e.to_string())
}

/// Current MiSD state. If the disk isn't at its saved path, other drive letters
/// are checked for the marker and all paths are fixed.
pub fn status(conn: &Connection) -> Result<SdStatus, String> {
    let mut root = setting(conn, "sd_root");
    let label = setting(conn, "sd_label");
    let id = setting(conn, "sd_id");
    let configured = root.is_some() && id.is_some();

    let mut available = false;
    if let (Some(r), Some(want)) = (&root, &id) {
        available = read_marker(Path::new(r)).map(|m| m.id == *want).unwrap_or(false);
        if !available {
            if let Some(new_root) = heal_drive_letter(conn, r, want)? {
                root = Some(new_root);
                available = true;
            }
        }
    }

    let queued = |mode: SdMode| -> Result<u32, String> {
        conn.query_row(
            &format!(
                "SELECT COUNT(*) FROM rewards WHERE sd_marked = ?1 \
                 AND sd_volume IS NULL AND {TRANSPORTABLE}"
            ),
            params![mode.value()],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())
    };
    let marked = queued(SdMode::Move)?;
    let backup_marked = queued(SdMode::Backup)?;
    let transported = count_transported(conn)?;
    let backups = count_backups(conn)?;

    Ok(SdStatus {
        configured,
        root,
        label,
        available,
        marked,
        transported,
        backup_marked,
        backups,
        previews: keep_previews(conn),
    })
}

/// The disk was at e.g. E:\MiSD but isn't there: look for the same path with the
/// same marker on other drive letters. If found, update all paths and the setting.
fn heal_drive_letter(conn: &Connection, old_root: &str, id: &str) -> Result<Option<String>, String> {
    let Some(candidate) = probe_drive_letter(old_root, id) else {
        return Ok(None);
    };
    db::relink_prefix(conn, old_root, &candidate).map_err(|e| e.to_string())?;
    db::set_setting(conn, "sd_root", &candidate).map_err(|e| e.to_string())?;
    Ok(Some(candidate))
}

/// Only the filesystem part (which letter is it on now?), so preheal can run it
/// without holding the lock.
fn probe_drive_letter(old_root: &str, id: &str) -> Option<String> {
    let bytes = old_root.as_bytes();
    if bytes.len() < 2 || !bytes[0].is_ascii_alphabetic() || bytes[1] != b':' {
        return None; // UNC / relative — nothing letter-shaped to probe
    }
    for letter in mounted_letters() {
        if letter == bytes[0].to_ascii_uppercase() {
            continue;
        }
        let candidate = format!("{}{}", letter as char, &old_root[1..]);
        if read_marker(Path::new(&candidate)).map(|m| m.id == id).unwrap_or(false) {
            return Some(candidate);
        }
    }
    None
}

/// Which drive letters to check.
/// Trying A: to Z: blind was slow (a dead network drive blocks for seconds).
/// GetLogicalDrives gives the mounted letters without I/O and GetDriveTypeW the type.
/// A MiSD disk is always removable or fixed, never network or CD.
#[cfg(windows)]
fn mounted_letters() -> Vec<u8> {
    use windows::core::PCWSTR;
    use windows::Win32::Storage::FileSystem::{GetDriveTypeW, GetLogicalDrives};
    /// USB stick, SD card, removable external drive.
    const DRIVE_REMOVABLE: u32 = 2;
    /// Internal disk, also what most USB hard drives report.
    const DRIVE_FIXED: u32 = 3;

    let mask = unsafe { GetLogicalDrives() };
    (0u32..26)
        .filter(|i| mask & (1 << i) != 0)
        .map(|i| b'A' + i as u8)
        .filter(|letter| {
            let root = [u16::from(*letter), u16::from(b':'), u16::from(b'\\'), 0];
            let kind = unsafe { GetDriveTypeW(PCWSTR(root.as_ptr())) };
            kind == DRIVE_REMOVABLE || kind == DRIVE_FIXED
        })
        .collect()
}

/// not on Windows: no drive letters, never reached in practice
#[cfg(not(windows))]
fn mounted_letters() -> Vec<u8> {
    (b'A'..=b'Z').collect()
}

/// Fix a changed drive letter WITHOUT holding the DB lock during the probe.
/// status does it inline, but a slow drive letter would block every command.
/// This takes the lock twice briefly (read the id, write the new root) and probes
/// in between without it. Callers that already hold the lock use status.
pub fn preheal(db: &db::Db) -> Result<(), String> {
    let (root, id) = {
        let conn = db.lock().map_err(|e| e.to_string())?;
        match (setting(&conn, "sd_root"), setting(&conn, "sd_id")) {
            (Some(r), Some(i)) => (r, i),
            _ => return Ok(()), // never set up — nothing to probe
        }
    };
    // still where it was, the normal case
    if read_marker(Path::new(&root)).map(|m| m.id == id).unwrap_or(false) {
        return Ok(());
    }
    let Some(healed) = probe_drive_letter(&root, &id) else {
        return Ok(());
    };
    let conn = db.lock().map_err(|e| e.to_string())?;
    db::relink_prefix(&conn, &root, &healed).map_err(|e| e.to_string())?;
    db::set_setting(&conn, "sd_root", &healed).map_err(|e| e.to_string())?;
    Ok(())
}

/// Quick check: is the disk connected right now?
pub fn available(conn: &Connection) -> bool {
    status(conn).map(|s| s.available).unwrap_or(false)
}

/* ---- marking ------------------------------------------------------------ */

/// The filter every mark statement uses (?1 = mode).
/// Queuing skips rewards already on the disk and non-movable ones.
/// Clearing only clears THAT queue (sd_marked = ?1), otherwise "Unmark" would
/// also clear the backup queue.
fn mark_clause(marked: bool) -> String {
    if marked {
        format!("sd_volume IS NULL AND {TRANSPORTABLE}")
    } else {
        "sd_marked = ?1".to_string()
    }
}

/// The value to write: the mode when queuing, 0 when clearing.
fn mark_value(mode: SdMode, marked: bool) -> i64 {
    if marked { mode.value() } else { 0 }
}

pub fn mark_rewards(
    conn: &Connection,
    ids: &[i64],
    mode: SdMode,
    marked: bool,
) -> Result<u32, String> {
    let sql = format!(
        "UPDATE rewards SET sd_marked = ?3 WHERE id = ?2 AND {}",
        mark_clause(marked)
    );
    let mut n = 0u32;
    for id in ids {
        n += conn
            .execute(&sql, params![mode.value(), id, mark_value(mode, marked)])
            .map_err(|e| e.to_string())? as u32;
    }
    Ok(n)
}

pub fn mark_artist(
    conn: &Connection,
    artist_id: i64,
    mode: SdMode,
    marked: bool,
) -> Result<u32, String> {
    conn.execute(
        &format!(
            "UPDATE rewards SET sd_marked = ?3 \
             WHERE period_id IN (SELECT id FROM periods WHERE artist_id = ?2) AND {}",
            mark_clause(marked)
        ),
        params![mode.value(), artist_id, mark_value(mode, marked)],
    )
    .map(|n| n as u32)
    .map_err(|e| e.to_string())
}

pub fn mark_period(
    conn: &Connection,
    period_id: i64,
    mode: SdMode,
    marked: bool,
) -> Result<u32, String> {
    conn.execute(
        &format!(
            "UPDATE rewards SET sd_marked = ?3 WHERE period_id = ?2 AND {}",
            mark_clause(marked)
        ),
        params![mode.value(), period_id, mark_value(mode, marked)],
    )
    .map(|n| n as u32)
    .map_err(|e| e.to_string())
}

/// All periods of one year of one platform for this artist (a year section on the page).
/// IFNULL so "Misc" (null year) and an unconfirmed platform (null) match a rule
/// that names them. The sentinels ('' and -1) can't be real values.
const YEAR_PERIODS: &str = "SELECT id FROM periods \
     WHERE artist_id = ?2 AND IFNULL(platform, '') = IFNULL(?4, '') \
       AND IFNULL(year, -1) = IFNULL(?5, -1)";

/// Mark (or unmark) every reward in one year of one platform.
pub fn mark_year(
    conn: &Connection,
    artist_id: i64,
    platform: Option<&str>,
    year: Option<i64>,
    mode: SdMode,
    marked: bool,
) -> Result<u32, String> {
    conn.execute(
        &format!(
            "UPDATE rewards SET sd_marked = ?3 WHERE period_id IN ({YEAR_PERIODS}) AND {}",
            mark_clause(marked)
        ),
        params![mode.value(), artist_id, mark_value(mode, marked), platform, year],
    )
    .map(|n| n as u32)
    .map_err(|e| e.to_string())
}

/// SQL that reads the year rule for a period and gives the sd_marked value a new
/// reward there should get (0 = no rule).
/// Returned as SQL because it's needed inside the INSERT ... ON CONFLICT, the only
/// place that knows if the folder is new.
pub fn rule_mode_sql(period_param: &str) -> String {
    format!(
        "COALESCE((SELECT r.mode FROM sd_year_rules r \
                    JOIN periods p ON p.id = {period_param} \
                   WHERE r.artist_id = p.artist_id \
                     AND IFNULL(r.platform, '') = IFNULL(p.platform, '') \
                     AND IFNULL(r.year, -1) = IFNULL(p.year, -1)), 0)"
    )
}

/// A year rule as the frontend sees it.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct YearRule {
    pub platform: Option<String>,
    pub year: Option<i64>,
    /// "move" or "backup".
    pub mode: String,
}

/// Set (or with mode None remove) the rule for one year of one platform.
/// Replaces an old one, so a year can't be queued for both at once.
pub fn set_year_rule(
    conn: &Connection,
    artist_id: i64,
    platform: Option<&str>,
    year: Option<i64>,
    mode: Option<SdMode>,
) -> Result<(), String> {
    conn.execute(
        "DELETE FROM sd_year_rules \
          WHERE artist_id = ?1 AND IFNULL(platform, '') = IFNULL(?2, '') \
            AND IFNULL(year, -1) = IFNULL(?3, -1)",
        params![artist_id, platform, year],
    )
    .map_err(|e| e.to_string())?;
    if let Some(m) = mode {
        conn.execute(
            "INSERT INTO sd_year_rules(artist_id, platform, year, mode) VALUES(?1, ?2, ?3, ?4)",
            params![artist_id, platform, year, m.value()],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// All rules of this creator (for the year headers).
pub fn year_rules(conn: &Connection, artist_id: i64) -> Result<Vec<YearRule>, String> {
    let mut stmt = conn
        .prepare("SELECT platform, year, mode FROM sd_year_rules WHERE artist_id = ?1")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![artist_id], |r| {
            Ok(YearRule {
                platform: r.get(0)?,
                year: r.get(1)?,
                mode: if r.get::<_, i64>(2)? == SdMode::Backup.value() {
                    "backup".into()
                } else {
                    "move".into()
                },
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>().map_err(|e| e.to_string())
}

/* ---- transport ----------------------------------------------------------- */

struct PendingRow {
    id: i64,
    folder: String,
    artist: String,
}

/// child is parent or inside it (checks the separator, so "Foo" doesn't match "Foobar").
fn under_or_equal(child: &str, parent: &str) -> bool {
    match child.strip_prefix(parent) {
        Some("") => true,
        Some(rest) => rest.starts_with('\\') || rest.starts_with('/'),
        None => false,
    }
}

/// Remove the empty folders a returned reward leaves on the MiSD disk
/// (e.g. an empty <root>\Creator\Patreon\2026\03).
/// remove_dir, never remove_dir_all: the filesystem refuses non-empty folders.
/// Stops at the first one it can't remove, and one level below the root (marker file).
fn prune_empty_parents(folder: &Path, root: &str) {
    let stop = root.trim_end_matches(['\\', '/']);
    let mut dir = folder.parent();
    while let Some(d) = dir {
        let Some(here) = d.to_str() else { return };
        let here = here.trim_end_matches(['\\', '/']);
        // the root or outside it: not ours
        if here == stop || !under_or_equal(here, stop) {
            return;
        }
        if std::fs::remove_dir(d).is_err() {
            return;
        }
        dir = d.parent();
    }
}

/// Where a reward lands on the disk: the managed layout 1:1, otherwise
/// <root>\<Artist>\<name>.
fn dest_for(row: &PendingRow, sd_root: &str, managed_base: Option<&str>) -> PathBuf {
    if let Some(mb) = managed_base {
        if let Some(rest) = row.folder.strip_prefix(mb) {
            if rest.starts_with('\\') || rest.starts_with('/') {
                return PathBuf::from(format!("{sd_root}{rest}"));
            }
        }
    }
    let base = Path::new(&row.folder)
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "Reward".into());
    Path::new(sd_root).join(crate::sanitize_name(&row.artist)).join(base)
}

/// Where a BACKUP lands: same layout inside _backup (separate on purpose).
fn backup_dest_for(row: &PendingRow, sd_root: &str, managed_base: Option<&str>) -> PathBuf {
    dest_for(row, &backup_root(sd_root).to_string_lossy(), managed_base)
}

/// Progress (done, total, current) for the progress bar. () ignores it.
pub type Progress<'a> = &'a dyn Fn(u32, u32, &str);

/// The reward folder name (shown as "current").
fn leaf(folder: &str) -> String {
    Path::new(folder)
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| folder.to_string())
}

/// Move every marked reward to the disk (checked), update the DB and flags.
/// Rewards inside a moved folder come along. One failure doesn't stop the rest.
pub fn transport(
    conn: &Connection,
    thumbs_dir: &Path,
    key: Option<[u8; 32]>,
    progress: Progress<'_>,
) -> Result<SdSummary, String> {
    begin_job();
    let st = status(conn)?;
    let root = st.root.ok_or("MiSD is not set up yet — choose a folder in Settings first.")?;
    if !st.available {
        return Err(format!(
            "The MiSD disk “{}” is not connected — plug it in and try again.",
            st.label.as_deref().unwrap_or("MiSD")
        ));
    }
    let label = st.label.unwrap_or_else(|| "MiSD".into());
    let managed_base: Option<String> = setting(conn, "collection_root")
        .map(|r| Path::new(&r).join("MiColl").to_string_lossy().into_owned());
    // read once so it can't change during the job
    let previews = st.previews;

    // backups that the move makes useless, read before flagging so they can be removed
    // after
    let stale_backups: Vec<(String, String)> = {
        let mut stmt = conn
            .prepare(&format!(
                "SELECT r.folder_path, r.sd_backup_path FROM rewards r \
                 WHERE r.sd_marked = 1 AND r.sd_volume IS NULL \
                 AND r.sd_backup_path IS NOT NULL AND {TRANSPORTABLE_R}"
            ))
            .map_err(|e| e.to_string())?;
        let it = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .map_err(|e| e.to_string())?;
        it.collect::<rusqlite::Result<Vec<_>>>().map_err(|e| e.to_string())?
    };

    let mut rows: Vec<PendingRow> = {
        let mut stmt = conn
            .prepare(&format!(
                "SELECT r.id, r.folder_path, a.name FROM rewards r \
                 JOIN periods p ON r.period_id = p.id \
                 JOIN artists a ON p.artist_id = a.id \
                 WHERE r.sd_marked = 1 AND r.sd_volume IS NULL AND {TRANSPORTABLE_R}"
            ))
            .map_err(|e| e.to_string())?;
        let it = stmt
            .query_map([], |r| {
                Ok(PendingRow { id: r.get(0)?, folder: r.get(1)?, artist: r.get(2)? })
            })
            .map_err(|e| e.to_string())?;
        it.collect::<rusqlite::Result<Vec<_>>>().map_err(|e| e.to_string())?
    };
    // outer folders first, so nested rewards move with their parent
    rows.sort_by_key(|r| r.folder.len());

    let total = rows.len() as u32;
    let mut done = 0u32;
    progress(0, total, "");

    let mut sum = SdSummary::default();
    let mut moved: Vec<String> = Vec::new();
    for row in rows {
        if stop_requested() {
            sum.cancelled = true;
            break;
        }
        progress(done, total, &leaf(&row.folder));
        done += 1;
        if moved.iter().any(|p| under_or_equal(&row.folder, p)) {
            sum.moved += 1; // physically moved with its parent; flags were set there
            continue;
        }
        let src = Path::new(&row.folder);
        if !src.is_dir() {
            sum.failed += 1;
            sum.errors.push(format!("{}: folder not found on disk", row.folder));
            continue;
        }
        let dest = dest_for(&row, &root, managed_base.as_deref());
        let dest_s = dest.to_string_lossy().into_owned();
        if under_or_equal(&dest_s, &row.folder) || under_or_equal(&row.folder, &dest_s) {
            sum.failed += 1;
            sum.errors.push(format!("{}: destination would nest with the source", row.folder));
            continue;
        }

        // save the previews FIRST while the files are still local, also for nested rewards
        if previews {
            for (id, folder) in rewards_within(conn, &row.folder) {
                let to = remap(&folder, &row.folder, &dest_s).unwrap_or_else(|| dest_s.clone());
                persist_previews(conn, thumbs_dir, key, id, &folder, Some(&to));
            }
        }

        match verified_move_dir(src, &dest) {
            Ok(warnings) => {
                sum.errors.extend(warnings);
                if let Err(e) = apply_move_db(conn, &row.folder, &dest_s, Some(&label)) {
                    // files moved and checked but the DB update failed, report it (a
                    // re-link fixes it)
                    sum.failed += 1;
                    sum.errors.push(format!("{}: moved, but updating the library failed: {e}", row.folder));
                    continue;
                }
                moved.push(row.folder.clone());
                sum.moved += 1;
            }
            Err(e) => {
                sum.failed += 1;
                sum.errors.push(format!("{}: {e}", row.folder));
            }
        }
    }

    // a backed-up reward that got moved doesn't need the backup anymore
    // (apply_move_db cleared the columns, this deletes the folder)
    for (folder, backup_path) in stale_backups {
        if !moved.iter().any(|p| under_or_equal(&folder, p)) {
            continue; // its move failed — leave the backup exactly where it is
        }
        if under_or_equal(&backup_path, &backup_root(&root).to_string_lossy()) {
            if let Err(e) = std::fs::remove_dir_all(&backup_path) {
                if Path::new(&backup_path).exists() {
                    sum.errors.push(format!(
                        "{folder}: moved to the disk, but its now-redundant backup at \
                         {backup_path} could not be removed ({e})."
                    ));
                }
            }
        }
    }

    progress(total, total, "");
    Ok(sum)
}

/// Copy every reward queued for BACKUP to the disk, local files stay.
/// Nested rewards come along with their parent. One failure doesn't stop the rest.
pub fn backup(conn: &Connection, progress: Progress<'_>) -> Result<SdSummary, String> {
    begin_job();
    let st = status(conn)?;
    let root = st.root.ok_or("MiSD is not set up yet — choose a folder in Settings first.")?;
    if !st.available {
        return Err(format!(
            "The MiSD disk “{}” is not connected — plug it in and try again.",
            st.label.as_deref().unwrap_or("MiSD")
        ));
    }
    let label = st.label.unwrap_or_else(|| "MiSD".into());
    let managed_base: Option<String> = setting(conn, "collection_root")
        .map(|r| Path::new(&r).join("MiColl").to_string_lossy().into_owned());

    // (row, old backup path - stale if the local folder was renamed)
    let mut rows: Vec<(PendingRow, Option<String>)> = {
        let mut stmt = conn
            .prepare(&format!(
                "SELECT r.id, r.folder_path, a.name, r.sd_backup_path FROM rewards r \
                 JOIN periods p ON r.period_id = p.id \
                 JOIN artists a ON p.artist_id = a.id \
                 WHERE r.sd_marked = 2 AND r.sd_volume IS NULL AND {TRANSPORTABLE_R}"
            ))
            .map_err(|e| e.to_string())?;
        let it = stmt
            .query_map([], |r| {
                Ok((
                    PendingRow { id: r.get(0)?, folder: r.get(1)?, artist: r.get(2)? },
                    r.get::<_, Option<String>>(3)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        it.collect::<rusqlite::Result<Vec<_>>>().map_err(|e| e.to_string())?
    };
    // outer first so nested rewards use their parent's copy
    rows.sort_by_key(|(r, _)| r.folder.len());

    let total = rows.len() as u32;
    let mut done = 0u32;
    progress(0, total, "");

    let mut sum = SdSummary::default();
    let mut copied: Vec<(String, String)> = Vec::new(); // (source folder, its copy)
    for (row, prev) in rows {
        if stop_requested() {
            sum.cancelled = true;
            break;
        }
        progress(done, total, &leaf(&row.folder));
        done += 1;

        // came along with the parent, point it at the subfolder
        if let Some((src, dst)) = copied
            .iter()
            .find(|(p, _)| under_or_equal(&row.folder, p))
            .cloned()
        {
            let dest_s = remap(&row.folder, &src, &dst).unwrap_or(dst);
            match apply_backup_db(conn, row.id, &label, &dest_s) {
                Ok(()) => sum.moved += 1,
                Err(e) => {
                    sum.failed += 1;
                    sum.errors.push(format!("{}: copied, but updating the library failed: {e}", row.folder));
                }
            }
            continue;
        }

        let src = Path::new(&row.folder);
        if !src.is_dir() {
            sum.failed += 1;
            sum.errors.push(format!("{}: folder not found on disk", row.folder));
            continue;
        }
        let dest = backup_dest_for(&row, &root, managed_base.as_deref());
        let dest_s = dest.to_string_lossy().into_owned();
        if under_or_equal(&dest_s, &row.folder) || under_or_equal(&row.folder, &dest_s) {
            sum.failed += 1;
            sum.errors.push(format!("{}: destination would nest with the source", row.folder));
            continue;
        }

        match verified_copy_dir(src, &dest, true) {
            Ok(_) => {
                if let Err(e) = apply_backup_db(conn, row.id, &label, &dest_s) {
                    sum.failed += 1;
                    sum.errors.push(format!("{}: copied, but updating the library failed: {e}", row.folder));
                    continue;
                }
                // the local folder was renamed since the last backup, the old copy is
                // garbage
                if let Some(old) = prev.filter(|p| *p != dest_s) {
                    if under_or_equal(&old, &backup_root(&root).to_string_lossy()) {
                        let _ = std::fs::remove_dir_all(&old);
                    }
                }
                copied.push((row.folder.clone(), dest_s));
                sum.moved += 1;
            }
            Err(e) => {
                sum.failed += 1;
                sum.errors.push(format!("{}: {e}", row.folder));
            }
        }
    }
    progress(total, total, "");
    Ok(sum)
}

fn apply_backup_db(conn: &Connection, id: i64, label: &str, dest: &str) -> Result<(), String> {
    conn.execute(
        "UPDATE rewards SET sd_backup = ?2, sd_backup_path = ?3, sd_backup_at = ?4, sd_marked = 0 \
         WHERE id = ?1",
        params![id, label, dest, crate::signing::chrono_date()],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Remove backup copies of ids (or all with None), local files stay.
/// Needs the disk, otherwise the folder would be lost.
pub fn drop_backup(conn: &Connection, ids: Option<&[i64]>) -> Result<SdSummary, String> {
    let st = status(conn)?;
    let root = st.root.ok_or("MiSD is not set up yet.")?;
    if !st.available {
        return Err(format!(
            "The MiSD disk “{}” is not connected — plug it in first, or the copy would \
             be left behind with nothing pointing at it.",
            st.label.as_deref().unwrap_or("MiSD")
        ));
    }
    let broot = backup_root(&root).to_string_lossy().into_owned();

    let mut rows: Vec<(i64, String)> = {
        let mut stmt = conn
            .prepare("SELECT id, sd_backup_path FROM rewards WHERE sd_backup_path IS NOT NULL")
            .map_err(|e| e.to_string())?;
        let it = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .map_err(|e| e.to_string())?;
        it.collect::<rusqlite::Result<Vec<_>>>().map_err(|e| e.to_string())?
    };
    if let Some(want) = ids {
        rows.retain(|(id, _)| want.contains(id));
    }
    // deepest first, removing a parent also removes its children
    rows.sort_by_key(|(_, p)| std::cmp::Reverse(p.len()));

    let mut sum = SdSummary::default();
    for (id, path) in rows {
        // checked against the _backup folder, it's a recursive delete from a DB path
        if !under_or_equal(&path, &broot) {
            sum.failed += 1;
            sum.errors.push(format!(
                "{path}: refusing to delete — that isn't inside the MiSD backup folder."
            ));
            continue;
        }
        if Path::new(&path).exists() {
            if let Err(e) = std::fs::remove_dir_all(&path) {
                sum.failed += 1;
                sum.errors.push(format!("{path}: {e}"));
                continue;
            }
        }
        conn.execute(
            "UPDATE rewards SET sd_backup = NULL, sd_backup_path = NULL, sd_backup_at = NULL \
             WHERE id = ?1",
            params![id],
        )
        .map_err(|e| e.to_string())?;
        sum.moved += 1;
    }
    Ok(sum)
}

/// Bring rewards back from the disk to where they were. ids None = all.
pub fn bring_back(
    conn: &Connection,
    ids: Option<&[i64]>,
    progress: Progress<'_>,
) -> Result<SdSummary, String> {
    begin_job();
    let st = status(conn)?;
    if !st.available {
        return Err(format!(
            "The MiSD disk “{}” is not connected — plug it in first.",
            st.label.as_deref().unwrap_or("MiSD")
        ));
    }

    let sd_root = st.root.clone();

    let mut rows: Vec<(i64, String, String)> = {
        let mut stmt = conn
            .prepare(
                "SELECT id, folder_path, sd_origin FROM rewards \
                 WHERE sd_volume IS NOT NULL AND sd_origin IS NOT NULL",
            )
            .map_err(|e| e.to_string())?;
        let it = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .map_err(|e| e.to_string())?;
        it.collect::<rusqlite::Result<Vec<_>>>().map_err(|e| e.to_string())?
    };
    if let Some(want) = ids {
        rows.retain(|(id, _, _)| want.contains(id));
    }
    rows.sort_by_key(|(_, folder, _)| folder.len());

    let total = rows.len() as u32;
    let mut done = 0u32;
    progress(0, total, "");

    let mut sum = SdSummary::default();
    let mut moved: Vec<String> = Vec::new();
    for (_id, folder, origin) in rows {
        if stop_requested() {
            sum.cancelled = true;
            break;
        }
        progress(done, total, &leaf(&folder));
        done += 1;
        if moved.iter().any(|p| under_or_equal(&folder, p)) {
            sum.moved += 1;
            continue;
        }
        let src = Path::new(&folder);
        if !src.is_dir() {
            sum.failed += 1;
            sum.errors.push(format!("{folder}: folder not found on the SD disk"));
            continue;
        }
        match verified_move_dir(src, Path::new(&origin)) {
            Ok(warnings) => {
                sum.errors.extend(warnings);
                if let Err(e) = apply_move_db(conn, &folder, &origin, None) {
                    sum.failed += 1;
                    sum.errors.push(format!("{folder}: moved back, but updating the library failed: {e}"));
                    continue;
                }
                moved.push(folder.clone());
                sum.moved += 1;
                if let Some(root) = sd_root.as_deref() {
                    prune_empty_parents(src, root);
                }
            }
            Err(e) => {
                sum.failed += 1;
                sum.errors.push(format!("{folder}: {e}"));
            }
        }
    }
    progress(total, total, "");
    Ok(sum)
}

/// Update all paths under the moved folder and set/clear the SD flags on that
/// reward AND every reward inside it. label Some = moved, None = brought back.
fn apply_move_db(
    conn: &Connection,
    old_folder: &str,
    new_folder: &str,
    label: Option<&str>,
) -> Result<(), String> {
    // affected rewards with their old folders
    let affected: Vec<(i64, String)> = {
        let mut stmt = conn
            .prepare(
                "SELECT id, folder_path FROM rewards WHERE substr(folder_path, 1, length(?1)) = ?1",
            )
            .map_err(|e| e.to_string())?;
        let it = stmt
            .query_map(params![old_folder], |r| {
                Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))
            })
            .map_err(|e| e.to_string())?;
        let rows: Vec<(i64, String)> = it
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|e| e.to_string())?;
        rows.into_iter()
            .filter(|(_, f)| under_or_equal(f, old_folder))
            .collect()
    };

    db::relink_prefix(conn, old_folder, new_folder).map_err(|e| e.to_string())?;

    for (id, pre_move_folder) in affected {
        match label {
            // moved: the backup isn't needed anymore, clear its columns (transport deletes
            // it)
            Some(l) => conn.execute(
                "UPDATE rewards SET sd_volume = ?2, sd_origin = ?3, sd_marked = 0, \
                 sd_backup = NULL, sd_backup_path = NULL, sd_backup_at = NULL WHERE id = ?1",
                params![id, l, pre_move_folder],
            ),
            None => conn.execute(
                "UPDATE rewards SET sd_volume = NULL, sd_origin = NULL, sd_marked = 0 WHERE id = ?1",
                params![id],
            ),
        }
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// All paths whose thumbnail must survive the move: cover, first image,
/// and artist/period previews in the folder.
fn preview_paths(conn: &Connection, reward_id: i64, folder: &str) -> Vec<String> {
    let mut paths: Vec<String> = Vec::new();
    if let Ok(Some(Some(c))) = conn
        .query_row("SELECT cover_image FROM rewards WHERE id = ?1", params![reward_id], |r| {
            r.get::<_, Option<String>>(0)
        })
        .optional()
    {
        paths.push(c);
    }
    if let Ok(Some(Some(first))) = conn
        .query_row(
            "SELECT MIN(file_path) FROM images WHERE reward_id = ?1",
            params![reward_id],
            |r| r.get::<_, Option<String>>(0),
        )
        .optional()
    {
        paths.push(first);
    }
    for table in ["artists", "periods"] {
        let sql = format!(
            "SELECT preview_image FROM {table} WHERE preview_image IS NOT NULL \
             AND substr(preview_image, 1, length(?1)) = ?1"
        );
        if let Ok(mut stmt) = conn.prepare(&sql) {
            if let Ok(rows) = stmt.query_map(params![folder], |r| r.get::<_, String>(0)) {
                for p in rows.flatten() {
                    paths.push(p);
                }
            }
        }
    }
    paths.sort();
    paths.dedup();
    paths
}

/// Replace the folder prefix of a path with to. None if it's not inside.
fn remap(path: &str, folder: &str, to: &str) -> Option<String> {
    let rest = path.strip_prefix(folder)?;
    (rest.starts_with('\\') || rest.starts_with('/')).then(|| format!("{to}{rest}"))
}

/// Save offline previews before a reward leaves (videos etc. are skipped).
/// Also saved under the new paths, because the DB changes right after.
fn persist_previews(
    conn: &Connection,
    thumbs_dir: &Path,
    key: Option<[u8; 32]>,
    reward_id: i64,
    folder: &str,
    dest: Option<&str>,
) {
    for p in preview_paths(conn, reward_id, folder) {
        let _ = thumbs::persist_sd_preview(thumbs_dir, &p, key);
        if let Some(after) = dest.and_then(|d| remap(&p, folder, d)) {
            let _ = thumbs::alias_sd_preview(thumbs_dir, &p, &after);
        }
    }
}

/// The reward at folder and every reward inside it.
fn rewards_within(conn: &Connection, folder: &str) -> Vec<(i64, String)> {
    let Ok(mut stmt) =
        conn.prepare("SELECT id, folder_path FROM rewards WHERE substr(folder_path, 1, length(?1)) = ?1")
    else {
        return Vec::new();
    };
    let Ok(rows) = stmt.query_map(params![folder], |r| Ok((r.get(0)?, r.get(1)?))) else {
        return Vec::new();
    };
    rows.flatten().filter(|(_, f): &(i64, String)| under_or_equal(f, folder)).collect()
}

/// Save the previews a moved reward is still missing, read from the disk (must be
/// connected).
/// For covers picked after the move or rewards moved before this existed.
/// only = just one reward. Returns how many were saved.
pub fn fill_previews(
    conn: &Connection,
    thumbs_dir: &Path,
    key: Option<[u8; 32]>,
    only: Option<i64>,
) -> Result<u32, String> {
    if !keep_previews(conn) || !available(conn) {
        return Ok(0);
    }
    let rows: Vec<(i64, String)> = {
        let mut stmt = conn
            .prepare(
                "SELECT id, folder_path FROM rewards \
                 WHERE sd_volume IS NOT NULL AND (?1 IS NULL OR id = ?1)",
            )
            .map_err(|e| e.to_string())?;
        let it = stmt
            .query_map(params![only], |r| Ok((r.get(0)?, r.get(1)?)))
            .map_err(|e| e.to_string())?;
        it.collect::<rusqlite::Result<Vec<_>>>().map_err(|e| e.to_string())?
    };
    let mut stored = 0u32;
    for (id, folder) in rows {
        for p in preview_paths(conn, id, &folder) {
            // images only (a video would be read from disk again every time)
            if thumbs::has_sd_preview(thumbs_dir, &p) || !crate::dup::is_image(&p) {
                continue;
            }
            if Path::new(&p).is_file() && thumbs::persist_sd_preview(thumbs_dir, &p, key).is_ok() {
                stored += 1;
            }
        }
    }
    Ok(stored)
}

/// Fix previews of rewards moved before the aliasing existed: copy them from the
/// old path key to the current one. Returns the count.
pub fn repair_previews(conn: &Connection, thumbs_dir: &Path) -> Result<u32, String> {
    // nothing to do when previews are turned off
    if !keep_previews(conn) {
        return Ok(0);
    }
    let rows: Vec<(i64, String, String)> = {
        let mut stmt = conn
            .prepare(
                "SELECT id, folder_path, sd_origin FROM rewards \
                 WHERE sd_volume IS NOT NULL AND sd_origin IS NOT NULL",
            )
            .map_err(|e| e.to_string())?;
        let it = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .map_err(|e| e.to_string())?;
        it.collect::<rusqlite::Result<Vec<_>>>().map_err(|e| e.to_string())?
    };

    let mut fixed = 0u32;
    for (id, folder, origin) in rows {
        for now in preview_paths(conn, id, &folder) {
            if thumbs::has_sd_preview(thumbs_dir, &now) {
                continue;
            }
            // the old path = the key it was saved under
            if let Some(before) = remap(&now, &folder, &origin) {
                if thumbs::alias_sd_preview(thumbs_dir, &before, &now).is_ok() {
                    fixed += 1;
                }
            }
        }
    }
    Ok(fixed)
}

/* ---- the verified mover --------------------------------------------------- */

fn sha256_file(p: &Path) -> Result<[u8; 32], String> {
    let mut f = std::fs::File::open(p).map_err(|e| format!("open {}: {e}", p.display()))?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = f.read(&mut buf).map_err(|e| format!("read {}: {e}", p.display()))?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    Ok(h.finalize().into())
}

/// Copy a folder with a SHA-256 check per file. The source is NEVER touched
/// (verified_move_dir adds the delete, backup uses only this).
/// Any failure returns Err. prune_extras also removes files at the destination that
/// the source doesn't have anymore (so a backup stays in sync).
/// Returns (files, dirs) relative to src.
fn verified_copy_dir(
    src: &Path,
    dest: &Path,
    prune_extras: bool,
) -> Result<(Vec<PathBuf>, Vec<PathBuf>), String> {
    // pass 0: list files and folders (so empty folders survive)
    let mut files: Vec<PathBuf> = Vec::new();
    let mut dirs: Vec<PathBuf> = Vec::new();
    for entry in walkdir::WalkDir::new(src).follow_links(false) {
        let entry = entry.map_err(|e| format!("walk {}: {e}", src.display()))?;
        let rel = entry
            .path()
            .strip_prefix(src)
            .map_err(|e| e.to_string())?
            .to_path_buf();
        if entry.file_type().is_dir() {
            dirs.push(rel);
        } else if entry.file_type().is_file() {
            files.push(rel);
        }
    }

    // pass 1: create the folders
    for d in &dirs {
        std::fs::create_dir_all(dest.join(d)).map_err(|e| format!("create dir: {e}"))?;
    }

    // pass 2: copy + flush + check each file, nothing deleted yet
    for rel in &files {
        let s = src.join(rel);
        let d = dest.join(rel);
        std::fs::copy(&s, &d).map_err(|e| format!("copy {}: {e}", rel.display()))?;
        // flush to disk first (the hash check is what really counts)
        if let Ok(f) = std::fs::OpenOptions::new().write(true).open(&d) {
            let _ = f.sync_all();
        }
        let (hs, hd) = (sha256_file(&s)?, sha256_file(&d)?);
        if hs != hd {
            return Err(format!(
                "verification FAILED for {} — the copy doesn't match the original. \
                 Nothing was deleted; check the destination disk and try again.",
                rel.display()
            ));
        }
    }

    // pass 2b (backups): remove destination files the source doesn't have anymore
    if prune_extras {
        let keep: std::collections::HashSet<PathBuf> = files.iter().cloned().collect();
        for entry in walkdir::WalkDir::new(dest).follow_links(false) {
            let Ok(entry) = entry else { continue };
            if !entry.file_type().is_file() {
                continue;
            }
            let Ok(rel) = entry.path().strip_prefix(dest) else { continue };
            if !keep.contains(rel) {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }

    Ok((files, dirs))
}

/// Move a folder with a SHA-256 check per file: (1) copy and check EVERY file,
/// (2) only then delete the sources, (3) remove empty folders.
/// Returns warnings (e.g. a source file that couldn't be deleted).
fn verified_move_dir(src: &Path, dest: &Path) -> Result<Vec<String>, String> {
    let (files, dirs) = verified_copy_dir(src, dest, false)?;

    // pass 3: everything is checked, delete the sources
    let mut warnings = Vec::new();
    for rel in &files {
        if let Err(e) = std::fs::remove_file(src.join(rel)) {
            warnings.push(format!(
                "{}: copied + verified, but the original could not be deleted ({e}) — \
                 a duplicate remains at the source.",
                rel.display()
            ));
        }
    }

    // pass 4: remove empty source folders, deepest first
    let mut deep_first = dirs.clone();
    deep_first.sort_by_key(|d| std::cmp::Reverse(d.components().count()));
    for d in deep_first {
        let _ = std::fs::remove_dir(src.join(d));
    }
    Ok(warnings)
}

/* ---- guards for prune / health ------------------------------------------- */

/// Image rows WITHOUT SD rewards, for prune_missing (an unplugged disk isn't deleted
/// files).
pub fn image_id_paths_excluding_sd(conn: &Connection) -> rusqlite::Result<Vec<(i64, String)>> {
    let mut stmt = conn.prepare(
        "SELECT i.id, i.file_path FROM images i \
         JOIN rewards r ON i.reward_id = r.id WHERE r.sd_volume IS NULL",
    )?;
    let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
    rows.collect()
}

/// All image paths of SD rewards, health shows them as "on MiSD (offline)".
/// Backed-up rewards aren't in here, their paths are local.
pub fn sd_image_paths(conn: &Connection) -> rusqlite::Result<std::collections::HashSet<String>> {
    let mut stmt = conn.prepare(
        "SELECT i.file_path FROM images i \
         JOIN rewards r ON i.reward_id = r.id WHERE r.sd_volume IS NOT NULL",
    )?;
    let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
    rows.collect()
}

/// Folders on the disk with our files (moved rewards + backups). The encryption
/// sweep needs them, otherwise turning encryption off would leave them encrypted forever.
pub fn encrypted_sd_dirs(conn: &Connection) -> rusqlite::Result<Vec<String>> {
    let mut stmt = conn.prepare(
        "SELECT folder_path FROM rewards WHERE sd_volume IS NOT NULL \
         UNION SELECT sd_backup_path FROM rewards WHERE sd_backup_path IS NOT NULL",
    )?;
    let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
    rows.collect()
}

/// True if anything of ours is on the disk (blocks turning encryption off while unplugged).
pub fn has_sd_content(conn: &Connection) -> bool {
    count_transported(conn).unwrap_or(0) > 0 || count_backups(conn).unwrap_or(0) > 0
}

/// Backup folders no reward points to anymore (a backed-up reward was deleted).
/// Only reported in health, never removed.
pub fn orphan_backups(conn: &Connection) -> Result<Vec<String>, String> {
    let st = status(conn)?;
    let Some(root) = st.root.filter(|_| st.available) else {
        return Ok(Vec::new()); // disk unplugged — nothing to say about it
    };
    let known: std::collections::HashSet<String> = {
        let mut stmt = conn
            .prepare("SELECT sd_backup_path FROM rewards WHERE sd_backup_path IS NOT NULL")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        rows.collect::<rusqlite::Result<_>>().map_err(|e| e.to_string())?
    };

    // Walk _backup and report the top folders with files that no row claims.
    let broot = backup_root(&root);
    let mut orphans: Vec<String> = Vec::new();
    for entry in walkdir::WalkDir::new(&broot).follow_links(false) {
        let Ok(entry) = entry else { continue };
        if !entry.file_type().is_file() {
            continue;
        }
        let Some(dir) = entry.path().parent().map(|p| p.to_string_lossy().into_owned()) else {
            continue;
        };
        if known.iter().any(|k| under_or_equal(&dir, k)) {
            continue;
        }
        if !orphans.iter().any(|o| under_or_equal(&dir, o)) {
            orphans.retain(|o| !under_or_equal(o, &dir));
            orphans.push(dir);
        }
    }
    orphans.sort();
    Ok(orphans)
}

/* ---- tests ----------------------------------------------------------------- */

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("micoll_sd_{name}_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    fn touch(p: &Path, content: &[u8]) {
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, content).unwrap();
    }

    /// the cancel flag is global, so tests that run a job take turns
    static SD_JOB: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn job_lock() -> std::sync::MutexGuard<'static, ()> {
        SD_JOB.lock().unwrap_or_else(|e| e.into_inner())
    }

    #[test]
    fn verified_move_roundtrips_and_cleans_up() {
        let base = tmp("move");
        let src = base.join("src");
        touch(&src.join("a.jpg"), b"AAA");
        touch(&src.join("sub").join("b.png"), b"BBBB");
        std::fs::create_dir_all(src.join("empty")).unwrap();

        let dest = base.join("dest");
        let warnings = verified_move_dir(&src, &dest).unwrap();
        assert!(warnings.is_empty(), "{warnings:?}");
        assert_eq!(std::fs::read(dest.join("a.jpg")).unwrap(), b"AAA");
        assert_eq!(std::fs::read(dest.join("sub/b.png")).unwrap(), b"BBBB");
        assert!(dest.join("empty").is_dir(), "empty dirs survive the move");
        assert!(!src.exists(), "source tree is gone after a fully verified move");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn failed_copy_keeps_the_source() {
        let base = tmp("keep");
        let src = base.join("src");
        touch(&src.join("a.jpg"), b"precious");
        // make the destination file read-only so the copy fails
        let dest = base.join("dest");
        touch(&dest.join("a.jpg"), b"old");
        let mut perms = std::fs::metadata(dest.join("a.jpg")).unwrap().permissions();
        perms.set_readonly(true);
        std::fs::set_permissions(dest.join("a.jpg"), perms).unwrap();

        let res = verified_move_dir(&src, &dest);
        assert!(res.is_err());
        assert_eq!(std::fs::read(src.join("a.jpg")).unwrap(), b"precious", "source untouched");

        let mut perms = std::fs::metadata(dest.join("a.jpg")).unwrap().permissions();
        perms.set_readonly(false);
        std::fs::set_permissions(dest.join("a.jpg"), perms).unwrap();
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn dest_mirrors_managed_layout_or_falls_back() {
        let row = |folder: &str| PendingRow { id: 1, folder: folder.into(), artist: "Nora".into() };
        // inside the managed collection -> 1:1 mirror
        let d = dest_for(
            &row(r"D:\Coll\MiColl\Nora\Patreon\2026\02\Pack"),
            r"E:\MiSD",
            Some(r"D:\Coll\MiColl"),
        );
        assert_eq!(d, Path::new(r"E:\MiSD\Nora\Patreon\2026\02\Pack"));
        // outside -> Artist\name
        let d = dest_for(&row(r"C:\Downloads\NoraPack"), r"E:\MiSD", Some(r"D:\Coll\MiColl"));
        assert_eq!(d, Path::new(r"E:\MiSD\Nora\NoraPack"));
        // a prefix that isn't a folder boundary doesn't count as managed
        let d = dest_for(&row(r"D:\Coll\MiCollX\Pack"), r"E:\MiSD", Some(r"D:\Coll\MiColl"));
        assert_eq!(d, Path::new(r"E:\MiSD\Nora\Pack"));
    }

    #[test]
    fn under_or_equal_respects_boundaries() {
        assert!(under_or_equal(r"C:\a\b", r"C:\a\b"));
        assert!(under_or_equal(r"C:\a\b\c.jpg", r"C:\a\b"));
        assert!(!under_or_equal(r"C:\a\bc", r"C:\a\b"));
    }

    /// A creator with two platforms and two years, one reward each.
    /// Returns the connection, artist id and reward id per (platform, year).
    fn year_fixture(name: &str) -> (Connection, i64, Vec<(&'static str, i64, i64)>) {
        let base = tmp(name);
        let conn = db::open(&base.join("t.db")).unwrap();
        conn.execute("INSERT INTO artists(name) VALUES('Nora')", []).unwrap();
        let aid: i64 = conn.query_row("SELECT id FROM artists", [], |r| r.get(0)).unwrap();
        let mut out = Vec::new();
        for (plat, year) in [("Patreon", 2025i64), ("Patreon", 2026), ("Ko-Fi", 2026)] {
            conn.execute(
                "INSERT INTO periods(artist_id, platform, year, month, label, folder_path) \
                 VALUES(?1, ?2, ?3, 1, '01', ?4)",
                params![aid, plat, year, format!("{plat}/{year}")],
            )
            .unwrap();
            let pid = conn.last_insert_rowid();
            conn.execute(
                "INSERT INTO rewards(period_id, title, folder_path, image_count) \
                 VALUES(?1, 'Pack', ?2, 1)",
                params![pid, format!("{plat}/{year}/Pack")],
            )
            .unwrap();
            out.push((plat, year, conn.last_insert_rowid()));
        }
        (conn, aid, out)
    }

    fn marked(conn: &Connection, rid: i64) -> i64 {
        conn.query_row("SELECT sd_marked FROM rewards WHERE id = ?1", params![rid], |r| r.get(0))
            .unwrap()
    }

    #[test]
    fn mark_year_takes_that_year_of_that_platform_and_nothing_else() {
        let (conn, aid, rows) = year_fixture("year_mark");
        let n = mark_year(&conn, aid, Some("Patreon"), Some(2026), SdMode::Move, true).unwrap();
        assert_eq!(n, 1);
        for (plat, year, rid) in &rows {
            let want = i64::from(*plat == "Patreon" && *year == 2026);
            assert_eq!(marked(&conn, *rid), want, "{plat} {year}");
        }
    }

    #[test]
    fn a_year_rule_queues_what_arrives_afterwards() {
        let (conn, aid, rows) = year_fixture("year_rule");
        set_year_rule(&conn, aid, Some("Patreon"), Some(2026), Some(SdMode::Backup)).unwrap();

        // one reward in the ruled year, one in the year next to it
        for (plat, year) in [("Patreon", 2026i64), ("Patreon", 2025)] {
            let pid: i64 = conn
                .query_row(
                    "SELECT id FROM periods WHERE platform = ?1 AND year = ?2",
                    params![plat, year],
                    |r| r.get(0),
                )
                .unwrap();
            conn.execute(
                &format!(
                    "INSERT INTO rewards(period_id, title, folder_path, image_count, sd_marked) \
                     VALUES(?1, 'Later', ?2, 1, {})",
                    rule_mode_sql("?1")
                ),
                params![pid, format!("{plat}/{year}/Later")],
            )
            .unwrap();
        }
        let later = |folder: &str| -> i64 {
            conn.query_row(
                "SELECT sd_marked FROM rewards WHERE folder_path = ?1",
                params![folder],
                |r| r.get(0),
            )
            .unwrap()
        };
        assert_eq!(later("Patreon/2026/Later"), SdMode::Backup.value(), "the rule queued it");
        assert_eq!(later("Patreon/2025/Later"), 0, "the year next door is untouched");
        // existing rewards aren't changed by the rule alone
        for (_, _, rid) in &rows {
            assert_eq!(marked(&conn, *rid), 0);
        }
    }

    #[test]
    fn a_rule_does_not_requeue_a_reward_the_user_unmarked() {
        let (conn, aid, _) = year_fixture("year_unmark");
        set_year_rule(&conn, aid, Some("Patreon"), Some(2026), Some(SdMode::Move)).unwrap();
        let pid: i64 = conn
            .query_row(
                "SELECT id FROM periods WHERE platform = 'Patreon' AND year = 2026",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let sql = format!(
            "INSERT INTO rewards(period_id, title, folder_path, image_count, sd_marked) \
             VALUES(?1, 'Later', ?2, 1, {}) \
             ON CONFLICT(folder_path) DO UPDATE SET title = excluded.title",
            rule_mode_sql("?1")
        );
        conn.execute(&sql, params![pid, "Patreon/2026/Later"]).unwrap();
        let rid: i64 = conn
            .query_row(
                "SELECT id FROM rewards WHERE folder_path = 'Patreon/2026/Later'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(marked(&conn, rid), SdMode::Move.value());

        mark_rewards(&conn, &[rid], SdMode::Move, false).unwrap();
        assert_eq!(marked(&conn, rid), 0);
        // a rescan sees the folder again, sd_marked must stay
        conn.execute(&sql, params![pid, "Patreon/2026/Later"]).unwrap();
        assert_eq!(marked(&conn, rid), 0, "the user's no outlives a rescan");
    }

    #[test]
    fn a_rule_can_be_withdrawn_without_unqueueing_the_year() {
        let (conn, aid, _) = year_fixture("year_withdraw");
        mark_year(&conn, aid, Some("Patreon"), Some(2026), SdMode::Move, true).unwrap();
        set_year_rule(&conn, aid, Some("Patreon"), Some(2026), Some(SdMode::Move)).unwrap();
        assert_eq!(year_rules(&conn, aid).unwrap().len(), 1);

        set_year_rule(&conn, aid, Some("Patreon"), Some(2026), None).unwrap();
        assert!(year_rules(&conn, aid).unwrap().is_empty());
        let still: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM rewards WHERE sd_marked = 1",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(still, 1, "what was already queued stays queued");
    }

    #[test]
    fn misc_is_a_year_a_rule_can_name() {
        let (conn, aid, _) = year_fixture("year_misc");
        conn.execute(
            "INSERT INTO periods(artist_id, platform, year, label, folder_path) \
             VALUES(?1, NULL, NULL, 'Misc', 'misc')",
            params![aid],
        )
        .unwrap();
        let pid = conn.last_insert_rowid();
        set_year_rule(&conn, aid, None, None, Some(SdMode::Move)).unwrap();
        conn.execute(
            &format!(
                "INSERT INTO rewards(period_id, title, folder_path, image_count, sd_marked) \
                 VALUES(?1, 'Loose', 'misc/Loose', 1, {})",
                rule_mode_sql("?1")
            ),
            params![pid],
        )
        .unwrap();
        let m: i64 = conn
            .query_row(
                "SELECT sd_marked FROM rewards WHERE folder_path = 'misc/Loose'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(m, SdMode::Move.value());
        // a second rule for "Misc" replaces the first
        set_year_rule(&conn, aid, None, None, Some(SdMode::Backup)).unwrap();
        assert_eq!(year_rules(&conn, aid).unwrap().len(), 1);
    }

    #[test]
    fn transport_and_bring_back_roundtrip() {
        let _job = job_lock();
        let base = tmp("e2e");
        let conn = db::open(&base.join("t.db")).unwrap();

        // a reward with two real files on the "local" disk
        let local = base.join("local").join("Nora").join("Pack");
        touch(&local.join("01.jpg"), b"one");
        touch(&local.join("02.jpg"), b"two");
        conn.execute("INSERT INTO artists(name) VALUES('Nora')", []).unwrap();
        let aid: i64 = conn.query_row("SELECT id FROM artists", [], |r| r.get(0)).unwrap();
        conn.execute(
            "INSERT INTO periods(artist_id, label, folder_path) VALUES(?1, 'Misc', 'k1')",
            params![aid],
        )
        .unwrap();
        let pid: i64 = conn.query_row("SELECT id FROM periods", [], |r| r.get(0)).unwrap();
        let folder = local.to_string_lossy().into_owned();
        conn.execute(
            "INSERT INTO rewards(period_id, title, folder_path, cover_image, image_count) VALUES(?1, 'Pack', ?2, ?3, 2)",
            params![pid, folder, local.join("01.jpg").to_string_lossy()],
        )
        .unwrap();
        let rid: i64 = conn.query_row("SELECT id FROM rewards", [], |r| r.get(0)).unwrap();
        for f in ["01.jpg", "02.jpg"] {
            conn.execute(
                "INSERT INTO images(reward_id, file_path, rel_name) VALUES(?1, ?2, ?3)",
                params![rid, local.join(f).to_string_lossy(), f],
            )
            .unwrap();
        }

        // set up the "SD disk" (a folder), mark + move
        let sd_root = base.join("sd");
        setup(&conn, &sd_root.to_string_lossy(), "TestDisk").unwrap();
        assert_eq!(mark_rewards(&conn, &[rid], SdMode::Move, true).unwrap(), 1);
        let thumbs = base.join("thumbs");
        let sum = transport(&conn, &thumbs, None, &|_, _, _| {}).unwrap();
        assert_eq!((sum.moved, sum.failed), (1, 0), "{:?}", sum.errors);

        let sd_folder: String = conn
            .query_row("SELECT folder_path FROM rewards WHERE id=?1", params![rid], |r| r.get(0))
            .unwrap();
        assert!(under_or_equal(&sd_folder, &sd_root.to_string_lossy()), "folder now under SD root: {sd_folder}");
        assert_eq!(std::fs::read(Path::new(&sd_folder).join("01.jpg")).unwrap(), b"one");
        assert!(!local.exists(), "local copy is gone");
        let (vol, origin): (Option<String>, Option<String>) = conn
            .query_row("SELECT sd_volume, sd_origin FROM rewards WHERE id=?1", params![rid], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        assert_eq!(vol.as_deref(), Some("TestDisk"));
        assert_eq!(origin.as_deref(), Some(folder.as_str()));
        let img: String = conn
            .query_row("SELECT file_path FROM images WHERE rel_name='02.jpg'", [], |r| r.get(0))
            .unwrap();
        assert!(under_or_equal(&img, &sd_folder), "image paths re-linked: {img}");
        // prune skips the SD reward's images
        assert!(image_id_paths_excluding_sd(&conn).unwrap().is_empty());
        assert_eq!(sd_image_paths(&conn).unwrap().len(), 2);

        // bring it back
        let sum = bring_back(&conn, None, &|_, _, _| {}).unwrap();
        assert_eq!((sum.moved, sum.failed), (1, 0), "{:?}", sum.errors);
        assert_eq!(std::fs::read(local.join("01.jpg")).unwrap(), b"one");
        assert_eq!(std::fs::read(local.join("02.jpg")).unwrap(), b"two");
        let (vol, marked, bk, bkp): (Option<String>, i64, Option<String>, Option<String>) = conn
            .query_row(
                "SELECT sd_volume, sd_marked, sd_backup, sd_backup_path FROM rewards WHERE id=?1",
                params![rid],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .unwrap();
        assert_eq!((vol, marked, bk, bkp), (None, 0, None, None));
        let img: String = conn
            .query_row("SELECT file_path FROM images WHERE rel_name='01.jpg'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(img, local.join("01.jpg").to_string_lossy());
        // the reward and its empty folder left the disk
        assert!(!sd_root.join("Nora").exists(), "the empty shelf was swept");
        assert!(sd_root.join(MARKER).is_file(), "the root and its marker survive");
        let _ = std::fs::remove_dir_all(&base);
    }

    /// the sweep goes up until something stops it
    #[test]
    fn the_sweep_stops_at_the_first_folder_that_still_holds_something() {
        let _job = job_lock();
        let base = tmp("prune");
        let root = base.join("sd");
        touch(&root.join(MARKER), b"{}");

        // the reward folder is gone, its parent isn't
        let shelf = root.join("Nora").join("Patreon").join("2026").join("03");
        std::fs::create_dir_all(&shelf).unwrap();
        prune_empty_parents(&shelf.join("Pack"), &root.to_string_lossy());
        assert!(!root.join("Nora").exists(), "an empty chain goes entirely");
        assert!(root.join(MARKER).is_file(), "but never the root itself");

        // same, with a stray file two levels up
        let shelf = root.join("Mia").join("Patreon").join("2026").join("03");
        std::fs::create_dir_all(&shelf).unwrap();
        let stray = root.join("Mia").join("Patreon").join("note.txt");
        touch(&stray, b"hi");
        prune_empty_parents(&shelf.join("Pack"), &root.to_string_lossy());
        assert!(!shelf.exists(), "the empty months below it still go");
        assert!(stray.is_file(), "the stray file is untouched");
        assert!(stray.parent().unwrap().exists(), "and so is the folder holding it");

        // a second reward on the disk also stops it
        let year = root.join("Ivy").join("Patreon").join("2026");
        std::fs::create_dir_all(year.join("03")).unwrap();
        touch(&year.join("04").join("Other").join("a.jpg"), b"x");
        prune_empty_parents(&year.join("03").join("Pack"), &root.to_string_lossy());
        assert!(!year.join("03").exists(), "the emptied month goes");
        assert!(year.join("04").join("Other").join("a.jpg").is_file(), "its neighbour stays");

        let _ = std::fs::remove_dir_all(&base);
    }

    /// the tile must still work unplugged: the preview must be found under the NEW path
    #[test]
    fn offline_preview_follows_the_moved_path() {
        let _job = job_lock();
        let base = tmp("preview");
        let conn = db::open(&base.join("t.db")).unwrap();

        let local = base.join("local").join("Nora").join("Pack");
        std::fs::create_dir_all(&local).unwrap();
        let img = local.join("01.png");
        image::RgbImage::from_pixel(48, 48, image::Rgb([10, 180, 220])).save(&img).unwrap();

        conn.execute("INSERT INTO artists(name) VALUES('Nora')", []).unwrap();
        let aid: i64 = conn.query_row("SELECT id FROM artists", [], |r| r.get(0)).unwrap();
        conn.execute(
            "INSERT INTO periods(artist_id, label, folder_path) VALUES(?1, 'Misc', 'k1')",
            params![aid],
        )
        .unwrap();
        let pid: i64 = conn.query_row("SELECT id FROM periods", [], |r| r.get(0)).unwrap();
        conn.execute(
            "INSERT INTO rewards(period_id, title, folder_path, cover_image, image_count) VALUES(?1,'Pack',?2,?3,1)",
            params![pid, local.to_string_lossy(), img.to_string_lossy()],
        )
        .unwrap();
        let rid: i64 = conn.query_row("SELECT id FROM rewards", [], |r| r.get(0)).unwrap();
        conn.execute(
            "INSERT INTO images(reward_id, file_path, rel_name) VALUES(?1, ?2, '01.png')",
            params![rid, img.to_string_lossy()],
        )
        .unwrap();

        let thumbs = base.join("thumbs");
        setup(&conn, &base.join("sd").to_string_lossy(), "TestDisk").unwrap();
        mark_rewards(&conn, &[rid], SdMode::Move, true).unwrap();
        let sum = transport(&conn, &thumbs, None, &|_, _, _| {}).unwrap();
        assert_eq!((sum.moved, sum.failed), (1, 0), "{:?}", sum.errors);

        let cover: String = conn
            .query_row("SELECT cover_image FROM rewards WHERE id=?1", params![rid], |r| r.get(0))
            .unwrap();
        // "unplug": the file is gone, the preview must still work
        std::fs::remove_file(&cover).unwrap();
        let jpeg = thumbs::thumb_jpeg(&thumbs, &cover, 256, None)
            .expect("offline preview serves the post-move path");
        assert!(image::load_from_memory(&jpeg).is_ok());
        let _ = std::fs::remove_dir_all(&base);
    }

    /// two cases that used to stay blank: a reward nested in the moved one, and a
    /// cover picked after the move. Unplugged, neither may be "repaired" onto
    /// another creator's file with the same name.
    #[test]
    fn nested_rewards_and_later_covers_keep_an_offline_preview() {
        let _job = job_lock();
        let base = tmp("nested");
        let conn = db::open(&base.join("t.db")).unwrap();
        let png = |p: &Path| {
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            image::RgbImage::from_pixel(32, 32, image::Rgb([200, 40, 90])).save(p).unwrap();
        };

        let pack = base.join("local").join("Nora").join("Pack");
        let hd = pack.join("HD");
        let (a, b, h) = (pack.join("01.png"), pack.join("02.png"), hd.join("h1.png"));
        // another creator's reward with the same "<folder>\<file>" name
        let other = base.join("local").join("Mira").join("HD").join("h1.png");
        for p in [&a, &b, &h, &other] {
            png(p);
        }

        conn.execute("INSERT INTO artists(name) VALUES('Nora')", []).unwrap();
        let aid: i64 = conn.query_row("SELECT id FROM artists", [], |r| r.get(0)).unwrap();
        conn.execute(
            "INSERT INTO periods(artist_id, label, folder_path) VALUES(?1, 'Misc', 'k1')",
            params![aid],
        )
        .unwrap();
        let pid: i64 = conn.query_row("SELECT id FROM periods", [], |r| r.get(0)).unwrap();
        let reward = |folder: &Path, files: &[&Path]| -> i64 {
            conn.execute(
                "INSERT INTO rewards(period_id, title, folder_path, cover_image, image_count) VALUES(?1,'r',?2,?3,?4)",
                params![pid, folder.to_string_lossy(), files[0].to_string_lossy(), files.len() as i64],
            )
            .unwrap();
            let rid = conn.last_insert_rowid();
            for f in files {
                conn.execute(
                    "INSERT INTO images(reward_id, file_path, rel_name) VALUES(?1, ?2, 'x')",
                    params![rid, f.to_string_lossy()],
                )
                .unwrap();
            }
            rid
        };
        let pack_id = reward(&pack, &[&a, &b]);
        let hd_id = reward(&hd, &[&h]);
        reward(other.parent().unwrap(), &[&other]);

        let thumbs = base.join("thumbs");
        setup(&conn, &base.join("sd").to_string_lossy(), "TestDisk").unwrap();
        mark_rewards(&conn, &[pack_id], SdMode::Move, true).unwrap();
        let sum = transport(&conn, &thumbs, None, &|_, _, _| {}).unwrap();
        assert_eq!(sum.failed, 0, "{:?}", sum.errors);
        let cover = |id: i64| -> String {
            conn.query_row("SELECT cover_image FROM rewards WHERE id=?1", params![id], |r| r.get(0))
                .unwrap()
        };
        assert!(thumbs::has_sd_preview(&thumbs, &cover(hd_id)), "the nested reward left without a preview");

        // a new cover while the disk is connected
        let later = cover(pack_id).replace("01.png", "02.png");
        db::set_reward_cover(&conn, pack_id, &later).unwrap();
        assert!(!thumbs::has_sd_preview(&thumbs, &later));
        assert_eq!(fill_previews(&conn, &thumbs, None, Some(pack_id)).unwrap(), 1);
        assert!(thumbs::has_sd_preview(&thumbs, &later));
        assert_eq!(fill_previews(&conn, &thumbs, None, None).unwrap(), 0, "nothing left to store");

        // unplugged: the covers are just unreachable
        let hd_cover = cover(hd_id);
        std::fs::rename(base.join("sd"), base.join("sd-away")).unwrap();
        db::repair_missing_previews(&conn).unwrap();
        assert_eq!(cover(hd_id), hd_cover, "must not jump to Mira's HD\\h1.png");
        assert_eq!(cover(pack_id), later);
        assert!(thumbs::thumb_jpeg(&thumbs, &later, 256, None).is_ok());
        assert!(thumbs::thumb_jpeg(&thumbs, &hd_cover, 256, None).is_ok());

        // a cover an older build moved to the wrong file comes back
        conn.execute(
            "UPDATE rewards SET cover_image = ?2 WHERE id = ?1",
            params![hd_id, other.to_string_lossy()],
        )
        .unwrap();
        db::repair_missing_previews(&conn).unwrap();
        assert_eq!(cover(hd_id), hd_cover);
        let _ = std::fs::remove_dir_all(&base);
    }

    /// with previews off nothing is written to the cache
    #[test]
    fn transport_skips_previews_when_the_setting_is_off() {
        let _job = job_lock();
        let base = tmp("nopreview");
        let conn = db::open(&base.join("t.db")).unwrap();

        let local = base.join("local").join("Nora").join("Pack");
        std::fs::create_dir_all(&local).unwrap();
        let img = local.join("01.png");
        image::RgbImage::from_pixel(48, 48, image::Rgb([10, 180, 220])).save(&img).unwrap();

        conn.execute("INSERT INTO artists(name) VALUES('Nora')", []).unwrap();
        let aid: i64 = conn.query_row("SELECT id FROM artists", [], |r| r.get(0)).unwrap();
        conn.execute(
            "INSERT INTO periods(artist_id, label, folder_path) VALUES(?1, 'Misc', 'k1')",
            params![aid],
        )
        .unwrap();
        let pid: i64 = conn.query_row("SELECT id FROM periods", [], |r| r.get(0)).unwrap();
        conn.execute(
            "INSERT INTO rewards(period_id, title, folder_path, cover_image, image_count) VALUES(?1,'Pack',?2,?3,1)",
            params![pid, local.to_string_lossy(), img.to_string_lossy()],
        )
        .unwrap();
        let rid: i64 = conn.query_row("SELECT id FROM rewards", [], |r| r.get(0)).unwrap();
        conn.execute(
            "INSERT INTO images(reward_id, file_path, rel_name) VALUES(?1, ?2, '01.png')",
            params![rid, img.to_string_lossy()],
        )
        .unwrap();

        let thumbs = base.join("thumbs");
        setup(&conn, &base.join("sd").to_string_lossy(), "TestDisk").unwrap();
        db::set_setting(&conn, PREVIEWS_SETTING, "0").unwrap();
        assert!(!keep_previews(&conn));
        mark_rewards(&conn, &[rid], SdMode::Move, true).unwrap();
        let sum = transport(&conn, &thumbs, None, &|_, _, _| {}).unwrap();
        assert_eq!((sum.moved, sum.failed), (1, 0), "{:?}", sum.errors);

        let cover: String = conn
            .query_row("SELECT cover_image FROM rewards WHERE id=?1", params![rid], |r| r.get(0))
            .unwrap();
        assert!(!thumbs::has_sd_preview(&thumbs, &cover), "no preview may be stored");
        // the repair pass must not add one back either
        assert_eq!(repair_previews(&conn, &thumbs).unwrap(), 0);
        let _ = std::fs::remove_dir_all(&base);
    }

    /// old moved rewards have the preview under the old path, repair moves it to the new
    /// key
    #[test]
    fn repair_rekeys_a_legacy_preview() {
        let base = tmp("repair");
        let conn = db::open(&base.join("t.db")).unwrap();
        let thumbs = base.join("thumbs");

        let origin = base.join("local").join("Pack");
        let now = base.join("sd").join("Pack");
        std::fs::create_dir_all(&origin).unwrap();
        let src = origin.join("01.png");
        image::RgbImage::from_pixel(24, 24, image::Rgb([9, 9, 9])).save(&src).unwrap();
        // a preview saved under the OLD path (like old builds did)
        thumbs::persist_sd_preview(&thumbs, &src.to_string_lossy(), None).unwrap();

        conn.execute("INSERT INTO artists(name) VALUES('Nora')", []).unwrap();
        conn.execute(
            "INSERT INTO periods(artist_id, label, folder_path) VALUES(1, 'Misc', 'k1')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO rewards(period_id, title, folder_path, cover_image, sd_volume, sd_origin) \
             VALUES(1, 'Pack', ?1, ?2, 'TestDisk', ?3)",
            params![
                now.to_string_lossy(),
                now.join("01.png").to_string_lossy(),
                origin.to_string_lossy()
            ],
        )
        .unwrap();

        let current = now.join("01.png").to_string_lossy().into_owned();
        assert!(!thumbs::has_sd_preview(&thumbs, &current));
        assert_eq!(repair_previews(&conn, &thumbs).unwrap(), 1);
        assert!(thumbs::has_sd_preview(&thumbs, &current), "preview re-keyed onto the SD path");
        // a second pass finds nothing to do
        assert_eq!(repair_previews(&conn, &thumbs).unwrap(), 0);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn setup_refuses_a_foreign_disk() {
        let base = tmp("foreign");
        let conn = db::open(&base.join("t.db")).unwrap();
        let ours = base.join("ours");
        setup(&conn, &ours.to_string_lossy(), "Mine").unwrap();

        let theirs = base.join("theirs");
        std::fs::create_dir_all(&theirs).unwrap();
        std::fs::write(
            theirs.join(MARKER),
            r#"{"id":"deadbeef","label":"NotMine","created":"2026-01-01"}"#,
        )
        .unwrap();
        assert!(setup(&conn, &theirs.to_string_lossy(), "Mine").is_err());
        let _ = std::fs::remove_dir_all(&base);
    }

    /* ---- backup mode ---------------------------------------------------- */

    /// One artist + one period, returns the period id.
    fn seed_period(conn: &Connection) -> i64 {
        conn.execute("INSERT INTO artists(name) VALUES('Nora')", []).unwrap();
        let aid: i64 = conn.query_row("SELECT id FROM artists", [], |r| r.get(0)).unwrap();
        conn.execute(
            "INSERT INTO periods(artist_id, label, folder_path) VALUES(?1, 'Misc', 'k1')",
            params![aid],
        )
        .unwrap();
        conn.query_row("SELECT id FROM periods", [], |r| r.get(0)).unwrap()
    }

    /// A reward with real files, indexed. Returns its id.
    fn seed_reward(conn: &Connection, pid: i64, folder: &Path, files: &[(&str, &[u8])]) -> i64 {
        for (name, body) in files {
            touch(&folder.join(name), body);
        }
        conn.execute(
            "INSERT INTO rewards(period_id, title, folder_path, cover_image, image_count) \
             VALUES(?1, ?2, ?3, ?4, ?5)",
            params![
                pid,
                folder.file_name().unwrap().to_string_lossy(),
                folder.to_string_lossy(),
                folder.join(files[0].0).to_string_lossy(),
                files.len() as i64
            ],
        )
        .unwrap();
        let rid = conn.last_insert_rowid();
        for (name, _) in files {
            conn.execute(
                "INSERT INTO images(reward_id, file_path, rel_name) VALUES(?1, ?2, ?3)",
                params![rid, folder.join(name).to_string_lossy(), name],
            )
            .unwrap();
        }
        rid
    }

    fn cols(conn: &Connection, rid: i64) -> (Option<String>, i64, Option<String>, Option<String>) {
        conn.query_row(
            "SELECT sd_volume, sd_marked, sd_backup, sd_backup_path FROM rewards WHERE id=?1",
            params![rid],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .unwrap()
    }

    /// the copy must never delete, and with prune_extras it mirrors the source
    #[test]
    fn verified_copy_leaves_the_source() {
        let base = tmp("copy");
        let src = base.join("src");
        touch(&src.join("a.jpg"), b"AAA");
        touch(&src.join("sub").join("b.png"), b"BBBB");
        let dest = base.join("dest");
        // a leftover from an older bigger version
        touch(&dest.join("gone.jpg"), b"stale");

        verified_copy_dir(&src, &dest, false).unwrap();
        assert_eq!(std::fs::read(src.join("a.jpg")).unwrap(), b"AAA", "source untouched");
        assert_eq!(std::fs::read(dest.join("sub/b.png")).unwrap(), b"BBBB");
        assert!(dest.join("gone.jpg").exists(), "without prune_extras nothing is removed");

        verified_copy_dir(&src, &dest, true).unwrap();
        assert!(src.join("a.jpg").exists(), "still a copy, not a move");
        assert!(!dest.join("gone.jpg").exists(), "prune_extras mirrors the source");
        let _ = std::fs::remove_dir_all(&base);
    }

    /// backups have their own folder, so a backed-up parent can't overwrite a moved child
    #[test]
    fn backup_dest_never_shares_the_transport_tree() {
        let row = PendingRow {
            id: 1,
            folder: r"D:\Coll\MiColl\Nora\Patreon\2026\02\Pack".into(),
            artist: "Nora".into(),
        };
        let moved = dest_for(&row, r"E:\MiSD", Some(r"D:\Coll\MiColl"));
        let backed = backup_dest_for(&row, r"E:\MiSD", Some(r"D:\Coll\MiColl"));
        assert_eq!(backed, Path::new(r"E:\MiSD\_backup\Nora\Patreon\2026\02\Pack"));
        let (m, b) = (moved.to_string_lossy(), backed.to_string_lossy());
        assert!(!under_or_equal(&m, &b) && !under_or_equal(&b, &m), "{m} vs {b}");
    }

    /// a copy on the disk and NOTHING removed locally
    #[test]
    fn backup_keeps_local_and_copies_to_sd() {
        let _job = job_lock();
        let base = tmp("backup");
        let conn = db::open(&base.join("t.db")).unwrap();
        let pid = seed_period(&conn);
        let local = base.join("local").join("Nora").join("Pack");
        let rid = seed_reward(&conn, pid, &local, &[("01.jpg", b"one"), ("02.jpg", b"two")]);

        let sd_root = base.join("sd");
        setup(&conn, &sd_root.to_string_lossy(), "TestDisk").unwrap();
        assert_eq!(mark_rewards(&conn, &[rid], SdMode::Backup, true).unwrap(), 1);
        let sum = backup(&conn, &|_, _, _| {}).unwrap();
        assert_eq!((sum.moved, sum.failed), (1, 0), "{:?}", sum.errors);

        let (vol, marked, bk, bkp) = cols(&conn, rid);
        assert_eq!(vol, None, "a backup never sets sd_volume");
        assert_eq!(marked, 0, "the queue is consumed");
        assert_eq!(bk.as_deref(), Some("TestDisk"));
        let bkp = bkp.expect("backup path recorded");
        assert!(
            under_or_equal(&bkp, &backup_root(&sd_root.to_string_lossy()).to_string_lossy()),
            "copy lands in the _backup subtree: {bkp}"
        );
        assert_eq!(std::fs::read(Path::new(&bkp).join("02.jpg")).unwrap(), b"two");
        assert_eq!(std::fs::read(local.join("01.jpg")).unwrap(), b"one", "local files stay");
        // the reward's paths didn't change
        let folder: String = conn
            .query_row("SELECT folder_path FROM rewards WHERE id=?1", params![rid], |r| r.get(0))
            .unwrap();
        assert_eq!(folder, local.to_string_lossy());
        let _ = std::fs::remove_dir_all(&base);
    }

    /// stopping only happens BETWEEN rewards: the current one finishes, the rest stays
    /// queued
    #[test]
    fn a_stopped_backup_finishes_the_one_it_was_on_and_queues_the_rest() {
        let _job = job_lock();
        let base = tmp("cancel");
        let conn = db::open(&base.join("t.db")).unwrap();
        let pid = seed_period(&conn);
        let local = base.join("local").join("Nora");
        let a = seed_reward(&conn, pid, &local.join("A"), &[("01.jpg", b"a")]);
        let b = seed_reward(&conn, pid, &local.join("B"), &[("01.jpg", b"b")]);

        let sd_root = base.join("sd");
        setup(&conn, &sd_root.to_string_lossy(), "TestDisk").unwrap();
        assert_eq!(mark_rewards(&conn, &[a, b], SdMode::Backup, true).unwrap(), 2);

        // press stop when the first reward is announced
        let sum = backup(&conn, &|_, _, item| {
            if !item.is_empty() {
                request_cancel();
            }
        })
        .unwrap();

        assert!(sum.cancelled, "the summary reports the stop");
        assert_eq!((sum.moved, sum.failed), (1, 0), "{:?}", sum.errors);

        // exactly one finished, properly
        let done: Vec<(i64, String)> = {
            let mut st = conn
                .prepare("SELECT id, sd_backup_path FROM rewards WHERE sd_backup_path IS NOT NULL")
                .unwrap();
            let it = st.query_map([], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
            it.collect::<rusqlite::Result<Vec<_>>>().unwrap()
        };
        assert_eq!(done.len(), 1, "only the reward it was on");
        assert!(Path::new(&done[0].1).join("01.jpg").is_file(), "and it is a real copy");
        assert_eq!(cols(&conn, done[0].0).1, 0, "its queue entry is consumed");

        // the other one never started, still queued
        let other = if done[0].0 == a { b } else { a };
        let (vol, marked, bk, bkp) = cols(&conn, other);
        assert_eq!((vol, marked, bk, bkp), (None, SdMode::Backup.value(), None, None));
        let _ = std::fs::remove_dir_all(&base);
    }

    /// only sd_volume restricts things, a backup must look normal to prune/health/library
    #[test]
    fn backed_up_reward_is_still_a_normal_local_reward() {
        let _job = job_lock();
        let base = tmp("normal");
        let conn = db::open(&base.join("t.db")).unwrap();
        let pid = seed_period(&conn);
        let local = base.join("local").join("Nora").join("Pack");
        let rid = seed_reward(&conn, pid, &local, &[("01.jpg", b"one")]);

        setup(&conn, &base.join("sd").to_string_lossy(), "TestDisk").unwrap();
        mark_rewards(&conn, &[rid], SdMode::Backup, true).unwrap();
        backup(&conn, &|_, _, _| {}).unwrap();

        // prune still sees its files, the offline set doesn't
        assert_eq!(image_id_paths_excluding_sd(&conn).unwrap().len(), 1);
        assert!(sd_image_paths(&conn).unwrap().is_empty());

        // the library reports neither queued nor on disk (sd_marked != 0 vs == 1
        // regression)
        let lib = db::get_library(&conn).unwrap();
        let r = &lib[0].periods[0].rewards[0];
        assert!(!r.sd_marked && !r.sd_backup_marked);
        assert_eq!(r.sd_volume, None);
        assert_eq!(r.sd_backup.as_deref(), Some("TestDisk"));
        let _ = std::fs::remove_dir_all(&base);
    }

    /// backup then move: only one copy on the disk after
    #[test]
    fn transport_of_a_backed_up_reward_absorbs_the_backup() {
        let _job = job_lock();
        let base = tmp("promote");
        let conn = db::open(&base.join("t.db")).unwrap();
        let pid = seed_period(&conn);
        let local = base.join("local").join("Nora").join("Pack");
        let rid = seed_reward(&conn, pid, &local, &[("01.jpg", b"one")]);

        let sd_root = base.join("sd");
        setup(&conn, &sd_root.to_string_lossy(), "TestDisk").unwrap();
        mark_rewards(&conn, &[rid], SdMode::Backup, true).unwrap();
        backup(&conn, &|_, _, _| {}).unwrap();
        let (_, _, _, bkp) = cols(&conn, rid);
        let bkp = bkp.unwrap();
        assert!(Path::new(&bkp).exists());

        mark_rewards(&conn, &[rid], SdMode::Move, true).unwrap();
        let sum = transport(&conn, &base.join("thumbs"), None, &|_, _, _| {}).unwrap();
        assert_eq!((sum.moved, sum.failed), (1, 0), "{:?}", sum.errors);

        let (vol, marked, bk, bkp2) = cols(&conn, rid);
        assert_eq!(vol.as_deref(), Some("TestDisk"));
        assert_eq!((marked, bk, bkp2), (0, None, None), "the move absorbed the backup");
        assert!(!Path::new(&bkp).exists(), "the redundant _backup folder is swept");
        assert!(!local.exists(), "local copy is gone");
        let sd_folder: String = conn
            .query_row("SELECT folder_path FROM rewards WHERE id=?1", params![rid], |r| r.get(0))
            .unwrap();
        assert_eq!(std::fs::read(Path::new(&sd_folder).join("01.jpg")).unwrap(), b"one");
        let _ = std::fs::remove_dir_all(&base);
    }

    /// a backed-up PARENT must not overwrite a moved CHILD, and dropping the parent's
    /// backup must leave the child alone
    #[test]
    fn nested_backup_and_move_never_share_a_folder() {
        let _job = job_lock();
        let base = tmp("nested");
        let conn = db::open(&base.join("t.db")).unwrap();
        let pid = seed_period(&conn);
        let parent = base.join("local").join("Nora").join("Pack");
        let child = parent.join("Bonus");
        let pr = seed_reward(&conn, pid, &parent, &[("01.jpg", b"parent")]);
        let cr = seed_reward(&conn, pid, &child, &[("02.jpg", b"child")]);

        let sd_root = base.join("sd");
        setup(&conn, &sd_root.to_string_lossy(), "TestDisk").unwrap();

        // child moves to the disk, then the parent gets backed up
        mark_rewards(&conn, &[cr], SdMode::Move, true).unwrap();
        transport(&conn, &base.join("thumbs"), None, &|_, _, _| {}).unwrap();
        let child_sd: String = conn
            .query_row("SELECT folder_path FROM rewards WHERE id=?1", params![cr], |r| r.get(0))
            .unwrap();

        mark_rewards(&conn, &[pr], SdMode::Backup, true).unwrap();
        let sum = backup(&conn, &|_, _, _| {}).unwrap();
        assert_eq!((sum.moved, sum.failed), (1, 0), "{:?}", sum.errors);
        let (_, _, _, pbkp) = cols(&conn, pr);
        let pbkp = pbkp.unwrap();
        assert!(
            !under_or_equal(&child_sd, &pbkp) && !under_or_equal(&pbkp, &child_sd),
            "the backup and the transported child are in disjoint trees: {pbkp} vs {child_sd}"
        );

        // dropping the parent's backup doesn't touch the child
        drop_backup(&conn, Some(&[pr])).unwrap();
        assert!(!Path::new(&pbkp).exists());
        assert_eq!(
            std::fs::read(Path::new(&child_sd).join("02.jpg")).unwrap(),
            b"child",
            "the transported child survives"
        );
        let _ = std::fs::remove_dir_all(&base);
    }

    /// the two queues are separate
    #[test]
    fn unmark_move_leaves_the_backup_queue_alone() {
        let base = tmp("queues");
        let conn = db::open(&base.join("t.db")).unwrap();
        let pid = seed_period(&conn);
        let a = seed_reward(&conn, pid, &base.join("local").join("A"), &[("1.jpg", b"a")]);
        let b = seed_reward(&conn, pid, &base.join("local").join("B"), &[("1.jpg", b"b")]);
        setup(&conn, &base.join("sd").to_string_lossy(), "TestDisk").unwrap();

        mark_rewards(&conn, &[a], SdMode::Move, true).unwrap();
        mark_rewards(&conn, &[b], SdMode::Backup, true).unwrap();
        assert_eq!(mark_period(&conn, pid, SdMode::Move, false).unwrap(), 1, "only A was cleared");
        assert_eq!(cols(&conn, a).1, 0);
        assert_eq!(cols(&conn, b).1, SdMode::Backup.value(), "B is still queued to back up");
        let _ = std::fs::remove_dir_all(&base);
    }

    /// preheal must return right away without writing if the disk is where it was
    /// (the real probe needs a second drive letter, can't test that here)
    #[test]
    fn preheal_does_nothing_while_the_disk_is_where_it_was() {
        let base = tmp("preheal");
        let conn = db::open(&base.join("t.db")).unwrap();
        let root = base.join("sd");
        setup(&conn, &root.to_string_lossy(), "TestDisk").unwrap();
        let db_lock: db::Db = std::sync::Mutex::new(conn);

        preheal(&db_lock).unwrap();

        let conn = db_lock.lock().unwrap();
        assert_eq!(
            setting(&conn, "sd_root").as_deref(),
            Some(root.to_string_lossy().as_ref()),
            "a reachable disk must not be relinked"
        );
        assert!(status(&conn).unwrap().available);
        drop(conn);
        let _ = std::fs::remove_dir_all(&base);
    }

    /// the system drive must pass the filter, the empty letters must not
    #[cfg(windows)]
    #[test]
    fn mounted_letters_names_real_drives_only() {
        let letters = mounted_letters();
        let shown: String = letters.iter().map(|b| *b as char).collect();
        assert!(letters.contains(&b'C'), "the system drive must be probed, got {shown}");
        assert!(letters.len() < 26, "unmounted letters must be dropped, got {shown}");
    }

    /// a root without a drive letter (UNC) is skipped
    #[test]
    fn probe_declines_a_root_with_no_drive_letter() {
        assert_eq!(probe_drive_letter(r"\nas\share\MiSD", "some-id"), None);
    }

    /// drop_backup must refuse anything outside _backup
    #[test]
    fn drop_backup_refuses_a_path_outside_the_backup_root() {
        let base = tmp("dropguard");
        let conn = db::open(&base.join("t.db")).unwrap();
        let pid = seed_period(&conn);
        let precious = base.join("precious");
        let rid = seed_reward(&conn, pid, &precious, &[("1.jpg", b"keep me")]);
        setup(&conn, &base.join("sd").to_string_lossy(), "TestDisk").unwrap();

        conn.execute(
            "UPDATE rewards SET sd_backup='TestDisk', sd_backup_path=?2 WHERE id=?1",
            params![rid, precious.to_string_lossy()],
        )
        .unwrap();
        let sum = drop_backup(&conn, Some(&[rid])).unwrap();
        assert_eq!((sum.moved, sum.failed), (0, 1));
        assert_eq!(std::fs::read(precious.join("1.jpg")).unwrap(), b"keep me");
        assert!(cols(&conn, rid).2.is_some(), "columns untouched when the delete is refused");
        let _ = std::fs::remove_dir_all(&base);
    }

    /// the two counts must not mix
    #[test]
    fn sd_status_counts_backups_separately() {
        let _job = job_lock();
        let base = tmp("counts");
        let conn = db::open(&base.join("t.db")).unwrap();
        let pid = seed_period(&conn);
        let a = seed_reward(&conn, pid, &base.join("local").join("A"), &[("1.jpg", b"a")]);
        let b = seed_reward(&conn, pid, &base.join("local").join("B"), &[("1.jpg", b"b")]);
        setup(&conn, &base.join("sd").to_string_lossy(), "TestDisk").unwrap();

        mark_rewards(&conn, &[a], SdMode::Move, true).unwrap();
        mark_rewards(&conn, &[b], SdMode::Backup, true).unwrap();
        let st = status(&conn).unwrap();
        assert_eq!((st.marked, st.backup_marked, st.backups), (1, 1, 0));

        backup(&conn, &|_, _, _| {}).unwrap();
        let st = status(&conn).unwrap();
        assert_eq!((st.marked, st.backup_marked, st.backups), (1, 0, 1));
        let _ = std::fs::remove_dir_all(&base);
    }

    /// drive letter healing must also update backup paths
    #[test]
    fn relink_rewrites_sd_backup_path() {
        let base = tmp("relink");
        let conn = db::open(&base.join("t.db")).unwrap();
        let pid = seed_period(&conn);
        let rid = seed_reward(&conn, pid, &base.join("local").join("A"), &[("1.jpg", b"a")]);
        conn.execute(
            "UPDATE rewards SET sd_backup_path=?2, sd_origin=?3 WHERE id=?1",
            params![rid, r"E:\MiSD\_backup\Nora\Pack", r"D:\Coll\MiColl\Nora\Pack"],
        )
        .unwrap();

        db::relink_prefix(&conn, r"E:\MiSD", r"F:\MiSD").unwrap();
        let (bkp, origin): (String, String) = conn
            .query_row("SELECT sd_backup_path, sd_origin FROM rewards WHERE id=?1", params![rid], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        assert_eq!(bkp, r"F:\MiSD\_backup\Nora\Pack");
        assert_eq!(origin, r"D:\Coll\MiColl\Nora\Pack", "the local origin is not an SD path");
        let _ = std::fs::remove_dir_all(&base);
    }

    /// an SD root inside a scanned folder is refused
    #[test]
    fn setup_refuses_a_root_inside_the_library() {
        let base = tmp("overlap");
        let conn = db::open(&base.join("t.db")).unwrap();
        let coll = base.join("coll");
        db::set_setting(&conn, "collection_root", &coll.to_string_lossy()).unwrap();

        assert!(setup(&conn, &coll.join("MiSD").to_string_lossy(), "Mine").is_err());
        // a scan root counts too, both ways
        let root = base.join("scanned");
        db::add_root(&conn, &root.to_string_lossy(), None, None).unwrap();
        assert!(setup(&conn, &root.join("sd").to_string_lossy(), "Mine").is_err());
        assert!(setup(&conn, &base.join("elsewhere").to_string_lossy(), "Mine").is_ok());
        let _ = std::fs::remove_dir_all(&base);
    }

    /// running a backup again keeps it in sync
    #[test]
    fn re_backup_prunes_files_the_reward_no_longer_has() {
        let _job = job_lock();
        let base = tmp("refresh");
        let conn = db::open(&base.join("t.db")).unwrap();
        let pid = seed_period(&conn);
        let local = base.join("local").join("Pack");
        let rid = seed_reward(&conn, pid, &local, &[("01.jpg", b"one"), ("02.jpg", b"two")]);
        setup(&conn, &base.join("sd").to_string_lossy(), "TestDisk").unwrap();

        mark_rewards(&conn, &[rid], SdMode::Backup, true).unwrap();
        backup(&conn, &|_, _, _| {}).unwrap();
        let bkp = cols(&conn, rid).3.unwrap();
        assert!(Path::new(&bkp).join("02.jpg").exists());

        // the reward changed: one file removed, one edited
        std::fs::remove_file(local.join("02.jpg")).unwrap();
        std::fs::write(local.join("01.jpg"), b"edited").unwrap();
        mark_rewards(&conn, &[rid], SdMode::Backup, true).unwrap();
        backup(&conn, &|_, _, _| {}).unwrap();

        assert_eq!(std::fs::read(Path::new(&bkp).join("01.jpg")).unwrap(), b"edited");
        assert!(!Path::new(&bkp).join("02.jpg").exists(), "stale file pruned from the copy");
        let _ = std::fs::remove_dir_all(&base);
    }
}
