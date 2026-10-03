mod ai;
mod audio;
mod crypto;
mod db;
mod dup;
mod edit;
mod indexer;
mod organize;
mod portable_update;
mod props;
mod diffusion;
mod sd;
mod signing;
mod single_instance;
mod template;
mod thumbs;
mod wshare;

use db::{Artist, Db, Root};
use indexer::{ImportPlan, ResolvedReward, ScanSummary};
use organize::OrganizeSummary;
use template::TemplatePreview;
use tauri::{AppHandle, Emitter, Manager, State};

/// In-memory data key, only while unlocked. Wiped on lock.
pub type DekState = std::sync::Mutex<Option<crypto::Dek>>;

/// State of the "Share to phone" LAN server: the port (started when needed) and the
/// share tokens (token -> file + expiry). The token map is an Arc so the server
/// thread can read it.
#[derive(Default)]
pub struct ShareInner {
    pub port: Option<u16>,
    pub tokens: std::sync::Arc<std::sync::Mutex<std::collections::HashMap<String, ShareEntry>>>,
}
pub struct ShareEntry {
    pub path: std::path::PathBuf,
    pub expires: std::time::Instant,
    /// True if path is a temp file (e.g. a zipped reward), deleted when the token is
    /// removed.
    pub cleanup: bool,
}
pub type ShareState = std::sync::Mutex<ShareInner>;

fn map_err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

/* ---- where MiColl keeps its own files ----
   Normally in %APPDATA%\<identifier> and %LOCALAPPDATA%.
   With a micoll-portable.txt next to micoll.exe everything goes into data\ and cache\
   next to the exe, so the whole app can be copied as one folder.
   It's an explicit marker on purpose (a dev build runs from target\release and
   would otherwise move the real library into the source folder).
   Only MiColl's own files move, the reward files stay where they are and their
   paths are absolute. */

/// Marker file for portable mode.
const PORTABLE_MARKER: &str = "micoll-portable.txt";

/// The folder next to the exe in portable mode (if writable), None for a normal install.
/// Decided once per process: checking on every call raced between threads
/// and sometimes fell back to the installed data folder.
fn portable_root() -> Option<std::path::PathBuf> {
    static ROOT: std::sync::OnceLock<Option<std::path::PathBuf>> = std::sync::OnceLock::new();
    ROOT.get_or_init(detect_portable_root).clone()
}

fn detect_portable_root() -> Option<std::path::PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?.to_path_buf();
    if !dir.join(PORTABLE_MARKER).is_file() {
        return None;
    }
    // a stick can be write-protected, falling back beats failing to start
    let probe = dir.join(".micoll-write-test");
    match std::fs::write(&probe, b"") {
        Ok(()) => {
            let _ = std::fs::remove_file(&probe);
            Some(dir)
        }
        Err(e) => {
            eprintln!("micoll: portable marker found but {} is not writable: {e}", dir.display());
            None
        }
    }
}

/// Where the database, templates and image versions are.
fn app_data<R: tauri::Runtime, M: Manager<R>>(app: &M) -> Result<std::path::PathBuf, String> {
    match portable_root() {
        Some(root) => Ok(root.join("data")),
        None => app.path().app_data_dir().map_err(map_err),
    }
}

/// Where the thumbnail cache and other rebuildable files are.
fn app_cache<R: tauri::Runtime, M: Manager<R>>(app: &M) -> Result<std::path::PathBuf, String> {
    match portable_root() {
        Some(root) => Ok(root.join("cache")),
        None => app.path().app_cache_dir().map_err(map_err),
    }
}

/// Everything in a data folder EXCEPT the database (templates, versions, models).
/// Used when a portable copy takes over the installed library. backups stays behind.
fn copy_data_extras(from: &std::path::Path, to: &std::path::Path) {
    let entries = match std::fs::read_dir(from) {
        Ok(e) => e,
        Err(e) => {
            eprintln!("micoll: could not read {}: {e}", from.display());
            return;
        }
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let n = name.to_string_lossy();
        if n.starts_with("micoll.db") || n == "backups" {
            continue;
        }
        let dest = to.join(&name);
        let res = match entry.file_type() {
            Ok(t) if t.is_dir() => copy_tree(&entry.path(), &dest),
            Ok(_) => std::fs::copy(entry.path(), &dest).map(|_| ()),
            Err(e) => Err(e),
        };
        // one unreadable extra isn't worth failing for, the library is already in place
        if let Err(e) = res {
            eprintln!("micoll: could not copy {}: {e}", entry.path().display());
        }
    }
}

/// Copy a folder recursively.
fn copy_tree(from: &std::path::Path, to: &std::path::Path) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let src = entry.path();
        let dest = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_tree(&src, &dest)?;
        } else {
            std::fs::copy(&src, &dest)?;
        }
    }
    Ok(())
}

/* ---- portable first run ------------------------------------------------- */

/// What a portable copy found next door on its first start.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct PortableOffer {
    /// The installed library's data folder (shown to the user).
    path: String,
    artists: i64,
    rewards: i64,
}

/// Should this start ask "take it over or start fresh?" and what is there to take.
/// Only when: portable, an installed library exists, our library is still empty
/// and no answer was saved. A crash before answering just asks again.
#[tauri::command]
fn portable_first_run(app: AppHandle, db: State<Db>) -> Result<Option<PortableOffer>, String> {
    if portable_root().is_none() {
        return Ok(None);
    }
    {
        let conn = db.lock().map_err(map_err)?;
        if db::get_setting(&conn, "portable_choice").map_err(map_err)?.is_some() {
            return Ok(None);
        }
        let mine: i64 = conn
            .query_row("SELECT count(*) FROM artists", [], |r| r.get(0))
            .map_err(map_err)?;
        if mine > 0 {
            return Ok(None);
        }
    }
    let installed = app.path().app_data_dir().map_err(map_err)?;
    let src = installed.join("micoll.db");
    if !src.is_file() {
        return Ok(None);
    }
    // read-only so we never disturb a library open in another copy
    let probe = rusqlite::Connection::open_with_flags(
        &src,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_URI,
    )
    .map_err(map_err)?;
    let artists: i64 = probe.query_row("SELECT count(*) FROM artists", [], |r| r.get(0)).unwrap_or(0);
    let rewards: i64 = probe.query_row("SELECT count(*) FROM rewards", [], |r| r.get(0)).unwrap_or(0);
    Ok(Some(PortableOffer {
        path: installed.to_string_lossy().into_owned(),
        artists,
        rewards,
    }))
}

/// Take over the installed library into this portable copy.
/// The DB is swapped like a backup restore (close, drop WAL files, reopen),
/// templates/versions/models come along, backups stay behind.
#[tauri::command]
fn portable_adopt(app: AppHandle, db: State<Db>, dek_state: State<DekState>) -> Result<(), String> {
    let root = portable_root().ok_or("This copy isn't running portable.")?;
    let data = root.join("data");
    let installed = app.path().app_data_dir().map_err(map_err)?;
    let src_db = installed.join("micoll.db");
    if !src_db.is_file() {
        return Err("There is no installed library to take over.".into());
    }

    let path = data.join("micoll.db");
    {
        let mut guard = db.lock().map_err(map_err)?;
        let placeholder = rusqlite::Connection::open_in_memory().map_err(map_err)?;
        drop(std::mem::replace(&mut *guard, placeholder));
        let wal = std::path::PathBuf::from(format!("{}-wal", path.to_string_lossy()));
        let shm = std::path::PathBuf::from(format!("{}-shm", path.to_string_lossy()));
        let _ = std::fs::remove_file(&wal);
        let _ = std::fs::remove_file(&shm);
        std::fs::copy(&src_db, &path).map_err(map_err)?;
        *guard = db::open(&path).map_err(map_err)?;
        db::set_setting(&guard, "portable_choice", "adopted").map_err(map_err)?;
    }

    copy_data_extras(&installed, &data);

    // the adopted library may have a password or encryption we don't know yet
    if let Ok(mut d) = dek_state.lock() {
        *d = None;
    }
    Ok(())
}

/// Has this library never been set up? (nothing indexed, no folders, questions never
/// answered)
/// The empty check keeps the questions away from older libraries.
#[tauri::command]
fn first_run_pending(db: State<Db>) -> Result<bool, String> {
    let conn = db.lock().map_err(map_err)?;
    if db::get_setting(&conn, "first_run_done").map_err(map_err)?.is_some() {
        return Ok(false);
    }
    let artists: i64 = conn
        .query_row("SELECT count(*) FROM artists", [], |r| r.get(0))
        .map_err(map_err)?;
    let roots: i64 = conn
        .query_row("SELECT count(*) FROM roots", [], |r| r.get(0))
        .map_err(map_err)?;
    Ok(artists == 0 && roots == 0)
}

/// Keep this copy's own empty library under the user's name.
#[tauri::command]
fn portable_start_fresh(db: State<Db>, name: String) -> Result<(), String> {
    let conn = db.lock().map_err(map_err)?;
    let label = name.trim();
    if !label.is_empty() {
        db::set_setting(&conn, "library_name", label).map_err(map_err)?;
    }
    db::set_setting(&conn, "portable_choice", "fresh").map_err(map_err)?;
    Ok(())
}

/// Where this install keeps its files (Settings -> Version).
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct DataLocations {
    portable: bool,
    data: String,
    cache: String,
}

#[tauri::command]
fn data_locations(app: AppHandle) -> Result<DataLocations, String> {
    Ok(DataLocations {
        portable: portable_root().is_some(),
        data: app_data(&app)?.to_string_lossy().into_owned(),
        cache: app_cache(&app)?.to_string_lossy().into_owned(),
    })
}

/// Let the asset protocol serve files under a folder (for convertFileSrc).
///
/// Run one startup step and log it if it was slow.
/// These run before the window shows, so they're timed. Measured they're cheap
/// (a few ms), so they stay here but get logged once a library makes them slow.
fn startup_step(name: &str, run: impl FnOnce()) {
    let t = std::time::Instant::now();
    run();
    let ms = t.elapsed().as_millis();
    if ms >= 25 {
        eprintln!("micoll: startup {name} took {ms} ms");
    }
}

/// Is this EXACTLY a name save_cover_crop used to write into reward folders:
/// _cover_<digits>.png or _cover_<digits>_<digits>.png?
/// As narrow as possible, because everything that matches gets moved out of a folder.
fn is_legacy_cover_crop(name: &str) -> bool {
    let Some(rest) = name.strip_prefix("_cover_") else { return false };
    let Some(stem) = rest
        .strip_suffix(".png")
        .or_else(|| rest.strip_suffix(".PNG"))
    else {
        return false;
    };
    let digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    match stem.split_once('_') {
        Some((ts, n)) => digits(ts) && digits(n),
        None => digits(stem),
    }
}

fn norm_str(p: &str) -> String {
    p.replace('/', "\\").to_lowercase()
}

#[derive(serde::Serialize, Default, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CoverMigration {
    /// in use: re-encoded into the covers folder, pointed there, original binned
    pub moved: u32,
    /// crops nothing uses: binned
    pub binned: u32,
    /// left for later: encrypted while locked, or on an unplugged disk
    pub deferred: u32,
    pub errors: Vec<String>,
}

/// The migration itself (without Tauri, so a test can run it).
/// A file must have a crop name AND be in a content folder (collection, root, MiSD).
/// A used crop is re-encoded into covers, all references are updated, then the
/// old file goes. Unused ones go right away. "Goes" = recycle bin.
/// The DB lock is taken per step, the walk can take a while.
fn migrate_cover_crops_in(
    db: &Db,
    bases: &[std::path::PathBuf],
    covers: &std::path::Path,
    key: Option<[u8; 32]>,
    encrypted_library: bool,
    remove: &dyn Fn(&std::path::Path) -> Result<(), String>,
) -> Result<CoverMigration, String> {
    let mut out = CoverMigration::default();

    // all cover references that name a crop: (table, id, path)
    let refs: Vec<(&'static str, i64, String)> = {
        let conn = db.lock().map_err(map_err)?;
        let mut v = Vec::new();
        for (table, col) in [
            ("rewards", "cover_image"),
            ("periods", "preview_image"),
            ("artists", "preview_image"),
        ] {
            let sql = format!("SELECT id, {col} FROM {table} WHERE {col} IS NOT NULL");
            let mut stmt = conn.prepare(&sql).map_err(map_err)?;
            let rows = stmt
                .query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))
                .map_err(map_err)?;
            for (id, p) in rows.flatten() {
                let name = std::path::Path::new(&p)
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("");
                if is_legacy_cover_crop(name) {
                    v.push((table, id, p));
                }
            }
        }
        v
    };
    let referenced: std::collections::HashSet<String> =
        refs.iter().map(|(_, _, p)| norm_str(p)).collect();

    // all crops on disk in content folders
    let mut found: Vec<std::path::PathBuf> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for base in bases.iter().filter(|b| b.is_dir()) {
        for entry in walkdir::WalkDir::new(base).follow_links(false).into_iter().flatten() {
            let p = entry.path();
            let crop = entry.file_type().is_file()
                && p.file_name().and_then(|n| n.to_str()).is_some_and(is_legacy_cover_crop);
            if crop && seen.insert(norm_str(&p.to_string_lossy())) {
                found.push(p.to_path_buf());
            }
        }
    }
    // a used crop that can't be found is on an unplugged disk, wait for the next run
    let reachable: std::collections::HashSet<String> =
        found.iter().map(|p| norm_str(&p.to_string_lossy())).collect();
    out.deferred += referenced.iter().filter(|r| !reachable.contains(*r)).count() as u32;

    for path in found {
        let key_s = norm_str(&path.to_string_lossy());
        if !referenced.contains(&key_s) {
            match remove(&path) {
                Ok(()) => out.binned += 1,
                Err(e) => out.errors.push(format!("{}: {e}", path.display())),
            }
            continue;
        }
        let raw = match std::fs::read(&path) {
            Ok(b) => b,
            Err(e) => {
                out.errors.push(format!("{}: {e}", path.display()));
                continue;
            }
        };
        let plain = if crypto::is_encrypted(&raw) {
            match key {
                Some(k) => match crypto::Dek::from_bytes(k).decrypt_bytes(&raw) {
                    Ok(b) => b,
                    Err(e) => {
                        out.errors.push(format!("{}: {e}", path.display()));
                        continue;
                    }
                },
                None => {
                    out.deferred += 1;
                    continue;
                }
            }
        } else {
            raw
        };
        let img = match image::load_from_memory(&plain) {
            Ok(i) => i.to_rgba8(),
            Err(e) => {
                out.errors.push(format!("{}: {e}", path.display()));
                continue;
            }
        };
        let (bytes, ext) = encode_cover(img)?;
        std::fs::create_dir_all(covers).map_err(map_err)?;
        let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("_cover_0");
        let mut dest = covers.join(format!("cover{}.{ext}", &stem["_cover".len()..]));
        let mut n = 2;
        while dest.exists() {
            dest = covers.join(format!("cover{}_{n}.{ext}", &stem["_cover".len()..]));
            n += 1;
        }
        // encrypted stays encrypted
        let to_write = match key {
            Some(k) if encrypted_library => crypto::Dek::from_bytes(k).encrypt_bytes(&bytes),
            _ => bytes,
        };
        crypto::atomic_write(&dest, &to_write)?;
        let new_s = dest.to_string_lossy().to_string();
        {
            let conn = db.lock().map_err(map_err)?;
            for (table, id, stored) in refs.iter().filter(|(_, _, p)| norm_str(p) == key_s) {
                let col = if *table == "rewards" { "cover_image" } else { "preview_image" };
                conn.execute(
                    &format!("UPDATE {table} SET {col} = ?1 WHERE id = ?2 AND {col} = ?3"),
                    rusqlite::params![new_s, id, stored],
                )
                .map_err(map_err)?;
            }
        }
        // only now, with all references on the new file, delete the old one
        match remove(&path) {
            Ok(()) => out.moved += 1,
            Err(e) => {
                out.moved += 1;
                out.errors.push(format!(
                    "{}: moved, but the old file could not be binned ({e})",
                    path.display()
                ));
            }
        }
    }
    Ok(out)
}

/// Setting that says the one-time crop migration is done.
const COVER_MIGRATION_KEY: &str = "cover_crops_migrated";

/// Move old cover crops from reward folders into the covers folder, once.
/// Runs after unlock (so encrypted libraries have the key). Anything it can't reach
/// yet is left for the next start, the done flag is only set when nothing is left.
#[tauri::command]
async fn migrate_cover_crops(app: AppHandle) -> Result<CoverMigration, String> {
    let covers = covers_dir(&app)?;
    let key = session_key(&app.state::<DekState>());
    let (bases, encrypted) = {
        let db = app.state::<Db>();
        let conn = db.lock().map_err(map_err)?;
        if db::get_setting(&conn, COVER_MIGRATION_KEY).ok().flatten().as_deref() == Some("1") {
            return Ok(CoverMigration::default());
        }
        let encrypted = enc_enabled(&conn);
        if encrypted && key.is_none() {
            return Ok(CoverMigration::default());
        }
        let mut bases: Vec<std::path::PathBuf> = Vec::new();
        if let Some(root) = db::get_setting(&conn, "collection_root")
            .ok()
            .flatten()
            .filter(|s| !s.trim().is_empty())
        {
            bases.push(std::path::Path::new(&root).join("MiColl"));
        }
        if let Ok(roots) = db::list_roots(&conn) {
            bases.extend(roots.into_iter().map(|r| std::path::PathBuf::from(r.path)));
        }
        if let Ok(dirs) = sd::encrypted_sd_dirs(&conn) {
            bases.extend(dirs.into_iter().map(std::path::PathBuf::from));
        }
        (bases, encrypted)
    };
    let app2 = app.clone();
    let out = tauri::async_runtime::spawn_blocking(move || {
        let db = app2.state::<Db>();
        migrate_cover_crops_in(&db, &bases, &covers, key, encrypted, &|p| {
            trash::delete(p).map_err(|e| e.to_string())
        })
    })
    .await
    .map_err(map_err)??;
    if out.deferred == 0 && out.errors.is_empty() {
        let db = app.state::<Db>();
        let conn = db.lock().map_err(map_err)?;
        db::set_setting(&conn, COVER_MIGRATION_KEY, "1").map_err(map_err)?;
        db::checkpoint(&conn);
    }
    Ok(out)
}

/// Columns that can hold a cover crop path.
const COVER_COLUMNS: &[(&str, &str)] = &[
    ("rewards", "cover_image"),
    ("periods", "preview_image"),
    ("artists", "preview_image"),
];

/// Point stored paths back into this app data folder.
/// Versions and cover crops are saved with absolute paths. After the app folder moved
/// (old identifier, portable copy with its own data folder) they still point at the old
/// place. A path outside `dir` is rewritten when it was in a folder of the same name
/// (versions, covers) and `dir` has a file with the same name. The folder check keeps
/// a missing reward image like "25.png" from being taken for a version.
/// Returns how many were fixed. Errors skip the column, it runs again next start.
fn heal_moved_paths(
    conn: &rusqlite::Connection,
    dir: &std::path::Path,
    columns: &[(&str, &str)],
) -> usize {
    let norm = |p: &str| p.replace('/', "\\").to_lowercase();
    let dir_key = format!("{}\\", norm(&dir.to_string_lossy()).trim_end_matches('\\'));
    let Some(dir_name) = dir.file_name().map(|n| n.to_string_lossy().to_lowercase()) else {
        return 0;
    };
    let mut fixed = 0;
    for (table, col) in columns {
        let Ok(mut stmt) = conn.prepare(&format!(
            "SELECT DISTINCT {col} FROM {table} WHERE {col} IS NOT NULL AND {col} <> ''"
        )) else {
            continue;
        };
        let Ok(rows) = stmt.query_map([], |r| r.get::<_, String>(0)) else { continue };
        let paths: Vec<String> = rows.flatten().collect();
        for old in paths {
            if norm(&old).starts_with(&dir_key) {
                continue;
            }
            let old_path = old.replace('/', "\\");
            let old_path = std::path::Path::new(&old_path);
            let Some(name) = old_path.file_name() else { continue };
            let same_folder = old_path
                .parent()
                .and_then(|p| p.file_name())
                .is_some_and(|p| p.to_string_lossy().to_lowercase() == dir_name);
            if !same_folder {
                continue;
            }
            let new = dir.join(name);
            if !new.is_file() {
                continue;
            }
            if let Ok(n) = conn.execute(
                &format!("UPDATE {table} SET {col} = ?2 WHERE {col} = ?1"),
                rusqlite::params![old, new.to_string_lossy()],
            ) {
                fixed += n;
            }
        }
    }
    fixed
}

/// Is the file really gone? False when its drive isn't there (unplugged MiSD disk,
/// network path): the cover is only offline then and must stay.
fn cover_file_gone(path: &str) -> bool {
    let p = std::path::Path::new(path);
    if p.exists() {
        return false;
    }
    let b = path.as_bytes();
    let drive_letter = b.len() >= 3 && b[0].is_ascii_alphabetic() && b[1] == b':';
    drive_letter && std::path::Path::new(&path[..3]).exists()
}

/// Covers (creator, month, reward) whose file is gone go back to the automatic image,
/// like "Reset cover" on each one. Returns how many were reset.
fn clear_missing_covers(conn: &rusqlite::Connection) -> usize {
    let mut reset = 0;
    for (table, col) in COVER_COLUMNS {
        let Ok(mut stmt) = conn.prepare(&format!(
            "SELECT DISTINCT {col} FROM {table} WHERE {col} IS NOT NULL AND {col} <> ''"
        )) else {
            continue;
        };
        let Ok(rows) = stmt.query_map([], |r| r.get::<_, String>(0)) else { continue };
        let gone: Vec<String> = rows.flatten().filter(|p| cover_file_gone(p)).collect();
        // a reward also drops its "chosen by hand" mark, like setting ""
        let extra = if *table == "rewards" { ", cover_custom = 0" } else { "" };
        for p in gone {
            if let Ok(n) = conn.execute(
                &format!("UPDATE {table} SET {col} = NULL{extra} WHERE {col} = ?1"),
                [&p],
            ) {
                reset += n;
            }
        }
    }
    reset
}

/// Remove cover crops nothing uses anymore (replaced, reset or deleted).
/// Only cover_* files directly in the covers folder. If a query fails nothing is removed.
fn sweep_orphan_covers(conn: &rusqlite::Connection, dir: &std::path::Path) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    let mut used = std::collections::HashSet::new();
    for (table, col) in COVER_COLUMNS {
        let sql = format!("SELECT {col} FROM {table} WHERE {col} IS NOT NULL");
        let Ok(mut stmt) = conn.prepare(&sql) else { return };
        let Ok(rows) = stmt.query_map([], |r| r.get::<_, String>(0)) else { return };
        for p in rows.flatten() {
            used.insert(p.replace('/', "\\").to_lowercase());
        }
    }
    for e in entries.flatten() {
        let path = e.path();
        let is_ours = path.is_file()
            && e.file_name().to_str().is_some_and(|n| n.starts_with("cover_"));
        if is_ours && !used.contains(&path.to_string_lossy().replace('/', "\\").to_lowercase()) {
            let _ = std::fs::remove_file(&path);
        }
    }
}

/// Prefix of the temp folders stage_files_for_import makes.
const STAGING_PREFIX: &str = "micoll-import-";

/// How old a leftover staging folder must be before a later start deletes it
/// (so a review left open overnight isn't pulled away).
const STAGING_MAX_AGE: std::time::Duration = std::time::Duration::from_secs(24 * 60 * 60);

/// The staging folder path belongs to, None unless it's really ours.
/// Guard in front of a recursive delete: must be named micoll-import-... AND sit
/// directly in the system temp folder. Never returns a parent of it.
fn staging_dir_of(path: &str) -> Option<std::path::PathBuf> {
    let temp = std::env::temp_dir();
    let key = |p: &std::path::Path| p.to_string_lossy().trim_end_matches(['\\', '/']).to_lowercase();
    let temp_key = key(&temp);
    for dir in std::path::Path::new(path).ancestors() {
        let Some(name) = dir.file_name().and_then(|n| n.to_str()) else { continue };
        if !name.starts_with(STAGING_PREFIX) {
            continue;
        }
        let Some(parent) = dir.parent() else { continue };
        if key(parent) == temp_key {
            return Some(dir.to_path_buf());
        }
    }
    None
}

/// Delete leftover staging folders from earlier sessions and their roots rows.
/// A crash between staging and committing used to leave them forever.
/// All errors are ignored, it runs again next time.
fn sweep_import_staging(conn: &rusqlite::Connection) {
    sweep_staging_folders(conn, &std::env::temp_dir(), STAGING_MAX_AGE);
    // old roots pointing at a folder that's gone
    if let Ok(roots) = db::list_roots(conn) {
        for r in roots {
            if staging_dir_of(&r.path).is_some() && !std::path::Path::new(&r.path).exists() {
                let _ = db::remove_root(conn, r.id);
            }
        }
    }
}

/// The folder part of the sweep, with the folder and age passed in (so tests can use a
/// fixture).
fn sweep_staging_folders(
    conn: &rusqlite::Connection,
    root: &std::path::Path,
    max_age: std::time::Duration,
) {
    let now = std::time::SystemTime::now();
    if let Ok(entries) = std::fs::read_dir(root) {
        for e in entries.flatten() {
            let Some(name) = e.file_name().to_str().map(str::to_owned) else { continue };
            if !name.starts_with(STAGING_PREFIX) {
                continue;
            }
            let path = e.path();
            if !path.is_dir() {
                continue;
            }
            let stale = e
                .metadata()
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| now.duration_since(t).ok())
                .is_some_and(|age| age >= max_age);
            if !stale {
                continue;
            }
            // an unmanaged import may have left its rewards in there, if unsure the folder
            // stays
            if db::any_reward_under(conn, &path.to_string_lossy()).unwrap_or(true) {
                continue;
            }
            let _ = std::fs::remove_dir_all(&path);
        }
    }
}

/// Undo an import's staging (after the files were moved out, or when the review was
/// cancelled).
/// Two kinds qualify: ours in %TEMP% (deleted), or one this session made in the user's
/// library (put back: files go back to the folder above, an unpacked archive folder is
/// removed).
/// The DB is the last check: a finished unmanaged import is refused.
/// Returns true if something was undone.
#[tauri::command]
fn discard_staging(db: State<Db>, path: String) -> Result<bool, String> {
    let temp = staging_dir_of(&path);
    let here = staged_here(std::path::Path::new(&path));
    let Some(dir) = temp.clone().or_else(|| here.clone().map(|(d, _)| d)) else {
        return Ok(false);
    };
    {
        let conn = db.lock().map_err(map_err)?;
        if db::any_reward_under(&conn, &dir.to_string_lossy()).map_err(map_err)? {
            return Ok(false);
        }
    }
    match here {
        Some((d, kind)) if temp.is_none() => {
            undo_staged(&d, kind);
            forget_staged(&d);
        }
        _ => {
            let _ = std::fs::remove_dir_all(&dir);
        }
    }
    Ok(true)
}

fn allow_asset_dir(app: &AppHandle, path: &str) {
    let _ = app
        .asset_protocol_scope()
        .allow_directory(path, true);
}

/* ---- commands -------------------------------------------------------- */

#[tauri::command]
fn list_roots(db: State<Db>) -> Result<Vec<Root>, String> {
    let conn = db.lock().map_err(map_err)?;
    db::list_roots(&conn).map_err(map_err)
}

#[tauri::command]
fn add_root(
    app: AppHandle,
    db: State<Db>,
    path: String,
    label: Option<String>,
    platform: Option<String>,
) -> Result<ScanSummary, String> {
    let conn = db.lock().map_err(map_err)?;
    let id = db::add_root(&conn, &path, label.as_deref(), platform.as_deref()).map_err(map_err)?;
    allow_asset_dir(&app, &path);
    let root = Root {
        id,
        path: path.clone(),
        label,
        default_platform: platform,
    };
    indexer::scan_root(&conn, &root).map_err(map_err)
}

#[tauri::command]
fn remove_root(db: State<Db>, id: i64) -> Result<(), String> {
    let conn = db.lock().map_err(map_err)?;
    db::remove_root(&conn, id).map_err(map_err)
}

#[tauri::command]
fn clear_library(db: State<Db>) -> Result<(), String> {
    let conn = db.lock().map_err(map_err)?;
    db::clear_library(&conn).map_err(map_err)
}

#[tauri::command]
fn clear_roots(db: State<Db>) -> Result<(), String> {
    let conn = db.lock().map_err(map_err)?;
    db::clear_roots(&conn).map_err(map_err)
}

/// Emits scan-progress for the rescan overlay. Max one event per 60 ms
/// (first and last always go through).
fn scan_progress(app: &AppHandle) -> impl Fn(u32, u32, &str) + '_ {
    let last = std::cell::Cell::new(None::<std::time::Instant>);
    move |done, total, item| {
        let now = std::time::Instant::now();
        let edge = done == 0 || done == total;
        if !edge {
            if let Some(prev) = last.get() {
                if now.duration_since(prev).as_millis() < 60 {
                    return;
                }
            }
        }
        last.set(Some(now));
        let _ = app.emit(
            "scan-progress",
            serde_json::json!({ "done": done, "total": total, "item": item }),
        );
    }
}

/// async so the scan runs on a worker thread (sync commands run on the main thread
/// and froze the window)
#[tauri::command]
async fn rescan(app: AppHandle, db: State<'_, Db>) -> Result<ScanSummary, String> {
    let conn = db.lock().map_err(map_err)?;
    let roots = db::list_roots(&conn).map_err(map_err)?;
    let progress = scan_progress(&app);
    // discover all roots first so the bar has the real total
    progress(0, 0, "");
    let mut plans = Vec::with_capacity(roots.len());
    for root in &roots {
        allow_asset_dir(&app, &root.path);
        plans.push(indexer::plan_root(&conn, root).map_err(map_err)?);
    }
    let planned: u32 = plans.iter().map(|p| p.len() as u32).sum();

    let mut total = ScanSummary::default();
    let mut done = 0u32;
    for plan in &plans {
        let base = done;
        let s = indexer::commit_with_progress(&conn, plan, None, &|d, _t, item| {
            progress(base + d, planned, item)
        })
        .map_err(map_err)?;
        done += plan.len() as u32;
        total.artists += s.artists;
        total.periods += s.periods;
        total.rewards += s.rewards;
        total.images += s.images;
        total.needs_review += s.needs_review;
    }
    progress(planned, planned, "");
    // fix user thumbnails whose file was moved/renamed
    let _ = db::repair_missing_previews(&conn);
    Ok(total)
}

/// Managed mode: re-index every artist in <collection_root>\MiColl.
/// Useful after changing folders on disk. Keeps ownership/covers/templates.
#[tauri::command]
async fn rescan_collection(app: AppHandle, db: State<'_, Db>) -> Result<ScanSummary, String> {
    let conn = db.lock().map_err(map_err)?;
    let root = db::get_setting(&conn, "collection_root")
        .map_err(map_err)?
        .filter(|s| !s.trim().is_empty())
        .ok_or("No managed collection folder is set.")?;
    let base = std::path::Path::new(&root).join("MiColl");
    if !base.exists() {
        return Err(format!("Collection folder not found: {}", base.display()));
    }
    let base_s = base.to_string_lossy().to_string();
    // remove old per-artist roots, the collection is the only source
    db::clear_roots(&conn).map_err(map_err)?;
    allow_asset_dir(&app, &base_s);
    // scan the whole collection without saving a root
    let root_obj = Root {
        id: 0,
        path: base_s,
        label: Some("MiColl Collection".into()),
        default_platform: None,
    };
    let progress = scan_progress(&app);
    progress(0, 0, "");
    let plan = indexer::plan_root(&conn, &root_obj).map_err(map_err)?;
    let summary =
        indexer::commit_with_progress(&conn, &plan, None, &progress).map_err(map_err)?;
    // fix user thumbnails whose file was moved/renamed
    let _ = db::repair_missing_previews(&conn);
    // a creator dragged into/out of the graveyard folder in Explorer: follow the disk
    let _ = sync_graveyard_from_disk(&conn, &base);
    Ok(summary)
}

/// Set each creator's graveyard flag from where their files are in the collection.
/// Creators without files in MiColl are left alone.
fn sync_graveyard_from_disk(
    conn: &rusqlite::Connection,
    shelf: &std::path::Path,
) -> rusqlite::Result<()> {
    let shelf_n = format!("{}\\", norm_path(shelf));
    let grave_n = format!("{}\\", norm_path(&shelf.join(indexer::GRAVEYARD_DIR)));
    let mut stmt = conn.prepare(
        "SELECT p.artist_id, r.folder_path FROM rewards r JOIN periods p ON p.id = r.period_id",
    )?;
    let rows = stmt
        .query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    // artist -> in the graveyard? (the first of their folders decides)
    let mut seen: std::collections::HashMap<i64, bool> = std::collections::HashMap::new();
    for (aid, folder) in rows {
        let n = format!("{}\\", norm_path(std::path::Path::new(&folder)));
        if n.starts_with(&shelf_n) {
            seen.entry(aid).or_insert_with(|| n.starts_with(&grave_n));
        }
    }
    for (aid, grave) in seen {
        db::set_artist_graveyard(conn, aid, grave)?;
    }
    Ok(())
}

/// Re-index ONE creator (what F5 does on a creator page). Their own folder if we
/// can find it, otherwise the root that holds them.
#[tauri::command]
async fn rescan_artist(
    app: AppHandle,
    db: State<'_, Db>,
    artist_id: i64,
) -> Result<ScanSummary, String> {
    let conn = db.lock().map_err(map_err)?;
    let name: String = conn
        .query_row("SELECT name FROM artists WHERE id = ?1", [artist_id], |r| r.get(0))
        .map_err(map_err)?;
    let found = indexer::artist_scan_dir(&conn, artist_id).map_err(map_err)?;
    let Some((dir, platform, own_folder)) = found else {
        return Err(format!(
            "Could not locate {name}'s folder on disk — use a full rescan instead."
        ));
    };
    allow_asset_dir(&app, &dir);
    let progress = scan_progress(&app);
    progress(0, 0, "");
    let plan = if own_folder {
        indexer::plan_artist_dir(&conn, &dir, platform.as_deref(), &name).map_err(map_err)?
    } else {
        // a shared root: plan it normally so the other creators keep their names
        let root_obj = Root { id: 0, path: dir, label: None, default_platform: platform };
        indexer::plan_root(&conn, &root_obj).map_err(map_err)?
    };
    let summary =
        indexer::commit_with_progress(&conn, &plan, None, &progress).map_err(map_err)?;
    let _ = db::repair_missing_previews(&conn);
    Ok(summary)
}

#[tauri::command]
fn get_library(app: AppHandle, db: State<Db>) -> Result<Vec<Artist>, String> {
    let conn = db.lock().map_err(map_err)?;
    // make every root's files servable
    if let Ok(roots) = db::list_roots(&conn) {
        for r in roots {
            allow_asset_dir(&app, &r.path);
        }
    }
    db::get_library(&conn).map_err(map_err)
}

/// Images of one artist per reward (the light get_library has no image rows).
#[tauri::command]
fn artist_images(app: AppHandle, db: State<Db>, artist_id: i64) -> Result<Vec<db::RewardImages>, String> {
    let conn = db.lock().map_err(map_err)?;
    // make the roots servable so the URLs load
    if let Ok(roots) = db::list_roots(&conn) {
        for r in roots {
            allow_asset_dir(&app, &r.path);
        }
    }
    db::artist_images(&conn, artist_id).map_err(map_err)
}

#[tauri::command]
fn set_reward_status(db: State<Db>, reward_id: i64, status: String) -> Result<(), String> {
    let conn = db.lock().map_err(map_err)?;
    db::set_reward_status(&conn, reward_id, &status).map_err(map_err)
}

/// Credit a reward to collab creators (replaces the list, empty clears it).
/// Nothing moves, partners show a read-only copy.
#[tauri::command]
fn set_reward_collabs(db: State<Db>, reward_id: i64, artist_ids: Vec<i64>) -> Result<(), String> {
    let conn = db.lock().map_err(map_err)?;
    if let Some(owner) = db::reward_owner(&conn, reward_id).map_err(map_err)? {
        if artist_ids.contains(&owner) {
            return Err("A reward can't be a collab with its own creator.".into());
        }
    }
    db::set_reward_collabs(&conn, reward_id, &artist_ids).map_err(map_err)
}

/// Remove collab links whose folder is gone (only the links).
#[tauri::command]
fn clear_broken_collabs(db: State<Db>) -> Result<u32, String> {
    let conn = db.lock().map_err(map_err)?;
    db::clear_broken_collabs(&conn).map_err(map_err)
}

#[tauri::command]
fn set_period_platform(db: State<Db>, period_id: i64, platform: String) -> Result<(), String> {
    let conn = db.lock().map_err(map_err)?;
    db::set_period_platform(&conn, period_id, &platform).map_err(map_err)
}

/// Settings -> "Reset missing covers". Returns how many were reset.
#[tauri::command]
fn reset_missing_covers(db: State<Db>) -> Result<usize, String> {
    let conn = db.lock().map_err(map_err)?;
    Ok(clear_missing_covers(&conn))
}

#[tauri::command]
fn set_artist_preview(db: State<Db>, artist_id: i64, image: String) -> Result<(), String> {
    let conn = db.lock().map_err(map_err)?;
    db::set_artist_preview(&conn, artist_id, &image).map_err(map_err)
}

#[tauri::command]
fn set_reward_cover(
    app: AppHandle,
    db: State<Db>,
    dek: State<DekState>,
    reward_id: i64,
    image: String,
) -> Result<(), String> {
    let conn = db.lock().map_err(map_err)?;
    db::set_reward_cover(&conn, reward_id, &image).map_err(map_err)?;
    // a reward on the MiSD disk: save the new cover's offline preview now (disk is
    // connected)
    let offloaded = conn
        .query_row("SELECT sd_volume IS NOT NULL FROM rewards WHERE id = ?1", [reward_id], |r| {
            r.get::<_, bool>(0)
        })
        .unwrap_or(false);
    if offloaded {
        fill_sd_previews(&app, &conn, session_key(&dek), Some(reward_id));
    }
    Ok(())
}

/// Save missing MiSD previews (see sd::fill_previews). Skipped while locked with
/// encryption on (it would have to be written unencrypted).
fn fill_sd_previews(
    app: &AppHandle,
    conn: &rusqlite::Connection,
    key: Option<[u8; 32]>,
    only: Option<i64>,
) {
    if key.is_none() && enc_enabled(conn) {
        return;
    }
    let Ok(cache) = app_cache(app) else { return };
    match sd::fill_previews(conn, &cache.join("thumbs"), key, only) {
        Ok(n) if n > 0 => eprintln!("micoll: stored {n} missing MiSD preview(s)"),
        Err(e) => eprintln!("micoll: MiSD preview fill skipped: {e}"),
        _ => {}
    }
}

#[tauri::command]
fn set_period_preview(db: State<Db>, period_id: i64, image: String) -> Result<(), String> {
    let conn = db.lock().map_err(map_err)?;
    db::set_period_preview(&conn, period_id, &image).map_err(map_err)
}

/// Set how many months a period covers.
#[tauri::command]
fn set_period_span(db: State<Db>, period_id: i64, span: i64) -> Result<(), String> {
    let conn = db.lock().map_err(map_err)?;
    db::set_period_span(&conn, period_id, span).map_err(map_err)
}

/// Rebuild a month's folder path in the managed collection.
fn managed_month_dir(
    conn: &rusqlite::Connection,
    artist: &str,
    platform: Option<&str>,
    year: Option<i64>,
    month: Option<i64>,
    number: Option<i64>,
) -> Option<std::path::PathBuf> {
    let base = db::get_setting(conn, "collection_root")
        .ok()
        .flatten()
        .filter(|s| !s.trim().is_empty())?;
    let mut p = managed_artist_dir(conn, &base, artist);
    if let Some(pl) = platform {
        p = p.join(sanitize_name(pl));
    }
    if let Some(n) = number {
        // numbered drop: "#51" (same as organize writes)
        p = p.join(indexer::fmt_number_label(n));
    } else if let Some(y) = year {
        p = p.join(y.to_string());
        if let Some(m) = month {
            p = p.join(format!("{:02}", m));
        }
    }
    Some(p)
}

/// The real month folder: a reward's parent if there is one, else rebuilt.
fn period_month_dir(conn: &rusqlite::Connection, period_id: i64) -> Option<std::path::PathBuf> {
    if let Ok(folders) = db::period_reward_folders(conn, period_id) {
        for f in folders {
            if f.contains('\u{1}') {
                continue; // synthetic (template placeholder) key — not a real path
            }
            if let Some(parent) = std::path::Path::new(&f).parent() {
                if parent.exists() {
                    return Some(parent.to_path_buf());
                }
            }
        }
    }
    let (artist, platform, year, month, number) = db::period_scope(conn, period_id).ok().flatten()?;
    managed_month_dir(conn, &artist, platform.as_deref(), year, month, number)
}

const SKIP_NOTE: &str = "This month was skipped by the artist (a break — no release).\n";

/// Mark/unmark a month as a break (writes/removes the marker file).
#[tauri::command]
fn set_period_skipped(
    app: AppHandle,
    db: State<Db>,
    period_id: i64,
    skipped: bool,
) -> Result<(), String> {
    let conn = db.lock().map_err(map_err)?;
    db::set_period_skipped(&conn, period_id, skipped).map_err(map_err)?;
    if let Some(dir) = period_month_dir(&conn, period_id) {
        if skipped {
            let _ = std::fs::create_dir_all(&dir);
            let _ = std::fs::write(dir.join(db::SKIP_MARKER), SKIP_NOTE);
            allow_asset_dir(&app, &dir.to_string_lossy());
        } else {
            let _ = std::fs::remove_file(dir.join(db::SKIP_MARKER));
        }
    }
    Ok(())
}

/// Create a new break month (folder + marker + DB period).
#[tauri::command]
fn add_skipped_period(
    app: AppHandle,
    db: State<Db>,
    artist_id: i64,
    platform: Option<String>,
    year: Option<i64>,
    month: Option<i64>,
) -> Result<(), String> {
    let conn = db.lock().map_err(map_err)?;
    let (artist_name, _) = db::artist_info(&conn, artist_id)
        .map_err(map_err)?
        .ok_or_else(|| "Artist not found".to_string())?;
    let label = match (year, month) {
        (Some(y), m) => indexer::fmt_label(y, m),
        _ => "Misc".to_string(),
    };
    let key = indexer::period_key(&artist_name, platform.as_deref(), year, month, None);
    db::upsert_skipped_period(&conn, artist_id, platform.as_deref(), year, month, &label, &key)
        .map_err(map_err)?;
    if let Some(dir) = managed_month_dir(&conn, &artist_name, platform.as_deref(), year, month, None) {
        let _ = std::fs::create_dir_all(&dir);
        let _ = std::fs::write(dir.join(db::SKIP_MARKER), SKIP_NOTE);
        allow_asset_dir(&app, &dir.to_string_lossy());
    }
    Ok(())
}

/// Copy a folder's contents into dst recursively. Counts copied and failed files
/// instead of stopping at the first error (one locked file doesn't sink the drop).
fn copy_tree_counting(
    src: &std::path::Path,
    dst: &std::path::Path,
    added: &mut u32,
    failed: &mut u32,
) {
    let entries = match std::fs::read_dir(src) {
        Ok(e) => e,
        Err(_) => {
            *failed += 1;
            return;
        }
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let dest = dst.join(entry.file_name());
        if path.is_dir() {
            let _ = std::fs::create_dir_all(&dest);
            copy_tree_counting(&path, &dest, added, failed);
        } else if path.is_file() {
            match std::fs::copy(&path, &dest) {
                Ok(_) => *added += 1,
                Err(_) => *failed += 1,
            }
        }
    }
}

/// A free file path in dir for name (no overwriting).
fn unique_dest(dir: &std::path::Path, name: &std::ffi::OsStr) -> std::path::PathBuf {
    let first = dir.join(name);
    if !first.exists() {
        return first;
    }
    let p = std::path::Path::new(name);
    let stem = p.file_stem().and_then(|s| s.to_str()).unwrap_or("file");
    let ext = p.extension().and_then(|s| s.to_str());
    let mut i = 2;
    loop {
        let fname = match ext {
            Some(e) => format!("{stem} ({i}).{e}"),
            None => format!("{stem} ({i})"),
        };
        let cand = dir.join(fname);
        if !cand.exists() {
            return cand;
        }
        i += 1;
    }
}

/// A free folder path in dir for name (adds " (2)" etc).
fn unique_dir(dir: &std::path::Path, name: &str) -> std::path::PathBuf {
    let first = dir.join(name);
    if !first.exists() {
        return first;
    }
    let mut i = 2;
    loop {
        let cand = dir.join(format!("{name} ({i})"));
        if !cand.exists() {
            return cand;
        }
        i += 1;
    }
}

/// What's needed to undo a folder this session made in the user's library.
#[derive(Clone, Copy, PartialEq, Debug)]
enum Staged {
    /// files moved from the folder above, they go back and then the folder goes
    MovedFiles,
    /// an archive unpacked into a new folder, the folder just goes
    Unpacked,
}

/// Only these folders may ever be undone.
/// By path alone a folder we just made looks like one the user dropped, and "put
/// the files back" on the user's folder would empty it. So we only undo folders
/// we have on record.
static STAGED_HERE: std::sync::Mutex<Vec<(std::path::PathBuf, Staged)>> =
    std::sync::Mutex::new(Vec::new());

fn remember_staged(dir: &std::path::Path, kind: Staged) {
    if let Ok(mut v) = STAGED_HERE.lock() {
        v.push((dir.to_path_buf(), kind));
    }
}

/// The registered folder path is or is inside (an archive can be one level below).
fn staged_here(path: &std::path::Path) -> Option<(std::path::PathBuf, Staged)> {
    let v = STAGED_HERE.lock().ok()?;
    path.ancestors()
        .find_map(|a| v.iter().find(|(d, _)| d == a).cloned())
}

/// Remove the record once the folder is committed or undone.
fn forget_staged(path: &std::path::Path) {
    if let Ok(mut v) = STAGED_HERE.lock() {
        v.retain(|(d, _)| !path.starts_with(d) && !d.starts_with(path));
    }
}

/// Put one back.
fn undo_staged(dir: &std::path::Path, kind: Staged) {
    if kind == Staged::Unpacked {
        // the folder didn't exist before, the archive next to it was never touched
        let _ = std::fs::remove_dir_all(dir);
        return;
    }
    let Some(parent) = dir.parent() else { return };
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for e in entries.flatten() {
        let p = e.path();
        // only files were moved in, anything else isn't ours
        if !p.is_file() {
            continue;
        }
        let Some(name) = p.file_name() else { continue };
        let _ = std::fs::rename(&p, unique_dest(parent, name));
    }
    // remove_dir so a folder that still has something stays
    let _ = std::fs::remove_dir(dir);
}

/// Is the managed collection in use? (the switch can be on without a folder)
///
/// Is the creator with this name in the graveyard?
fn artist_in_graveyard(conn: &rusqlite::Connection, name: &str) -> bool {
    conn.query_row(
        "SELECT graveyard FROM artists WHERE name = ?1",
        rusqlite::params![name],
        |r| r.get::<_, i64>(0),
    )
    .map(|v| v != 0)
    .unwrap_or(false)
}

/// A creator's folder in the collection: <root>\MiColl\<name>, or
/// <root>\MiColl\🪦 Graveyard\<name> in the graveyard.
fn managed_artist_dir(
    conn: &rusqlite::Connection,
    collection_root: &str,
    name: &str,
) -> std::path::PathBuf {
    let mut dir = std::path::Path::new(collection_root).join("MiColl");
    if artist_in_graveyard(conn, name) {
        dir = dir.join(indexer::GRAVEYARD_DIR);
    }
    dir.join(sanitize_name(name))
}

/// Update all saved paths under old to new after a move.
/// old gets a trailing separator so "Aurora" doesn't also match "Aurora Vale".
/// Both separators. sd_origin and the root rows aren't covered by relink_prefix, so they're
/// here.
fn relink_dir(conn: &rusqlite::Connection, old: &str, new: &str) -> rusqlite::Result<()> {
    for sep in ["\\", "/"] {
        let (o, n) = (format!("{old}{sep}"), format!("{new}{sep}"));
        db::relink_prefix(conn, &o, &n)?;
        conn.execute(
            "UPDATE rewards SET sd_origin = ?2 || substr(sd_origin, length(?1)+1) \
             WHERE substr(sd_origin,1,length(?1)) = ?1",
            rusqlite::params![o, n],
        )?;
        conn.execute(
            "UPDATE OR IGNORE roots SET path = ?2 || substr(path, length(?1)+1) \
             WHERE substr(path,1,length(?1)) = ?1",
            rusqlite::params![o, n],
        )?;
    }
    // the folder itself where it's saved as its own path
    conn.execute("UPDATE OR IGNORE roots SET path = ?2 WHERE path = ?1", rusqlite::params![old, new])?;
    conn.execute("UPDATE rewards SET folder_path = ?2 WHERE folder_path = ?1", rusqlite::params![old, new])?;
    Ok(())
}

fn managed_collection(conn: &rusqlite::Connection) -> bool {
    db::get_setting(conn, "managed_enabled").ok().flatten().as_deref() == Some("true")
        && db::get_setting(conn, "collection_root")
            .ok()
            .flatten()
            .is_some_and(|r| !r.trim().is_empty())
}

/// The one folder all dropped files came from, None if several.
fn common_parent(files: &[std::path::PathBuf]) -> Option<std::path::PathBuf> {
    let mut it = files.iter().map(|f| f.parent());
    let first = it.next().flatten()?;
    it.all(|p| p == Some(first)).then(|| first.to_path_buf())
}

/// Put the dropped files into a new reward folder in the folder they came from.
/// All or nothing: if a file won't move, the moved ones go back and the folder is
/// removed (then the caller uses temp staging). None = didn't work, never half.
fn stage_beside_source(
    parent: &std::path::Path,
    reward: &str,
    files: &[std::path::PathBuf],
) -> Option<std::path::PathBuf> {
    let dir = unique_dir(parent, reward);
    std::fs::create_dir(&dir).ok()?;
    let mut moved: Vec<(std::path::PathBuf, std::path::PathBuf)> = Vec::new();
    for f in files {
        let Some(name) = f.file_name() else { continue };
        let dest = unique_dest(&dir, name);
        if std::fs::rename(f, &dest).is_err() {
            for (from, to) in moved.iter().rev() {
                let _ = std::fs::rename(to, from);
            }
            let _ = std::fs::remove_dir_all(&dir);
            return None;
        }
        moved.push((f.clone(), dest));
    }
    remember_staged(&dir, Staged::MovedFiles);
    Some(dir)
}

/// Move a folder, copy + delete across disks.
fn move_tree(src: &std::path::Path, dst: &std::path::Path) -> std::io::Result<()> {
    // never move a folder into itself (the copy would recurse forever)
    if dst.starts_with(src) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "destination is the source folder or nested inside it",
        ));
    }
    if let Some(parent) = dst.parent() {
        std::fs::create_dir_all(parent)?;
    }
    match std::fs::rename(src, dst) {
        Ok(()) => Ok(()),
        Err(_) => {
            std::fs::create_dir_all(dst)?;
            let (mut added, mut failed) = (0u32, 0u32);
            copy_tree_counting(src, dst, &mut added, &mut failed);
            std::fs::remove_dir_all(src)
        }
    }
}

/// File size (bytes) + last modified (ms) for the viewer sort.
#[derive(serde::Serialize)]
struct MediaStat {
    path: String,
    size: u64,
    modified: i64,
}

/// Stat files for the viewer's size/date sort. Missing files give zeros.
/// Only metadata, no decrypting (encrypted size keeps the order).
#[tauri::command]
fn media_stats(paths: Vec<String>) -> Vec<MediaStat> {
    paths
        .into_iter()
        .map(|p| {
            let md = std::fs::metadata(&p).ok();
            let size = md.as_ref().map(|m| m.len()).unwrap_or(0);
            let modified = md
                .as_ref()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0);
            MediaStat { path: p, size, modified }
        })
        .collect()
}

/// One creator's size and last change. Done in the backend because a creator can
/// have thousands of files. Missing files (deleted or MiSD unplugged) are counted
/// as absent, not an error.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ArtistSize {
    bytes: u64,
    /// Files that were measured.
    files: u64,
    /// Files in the DB that couldn't be read right now.
    missing: u64,
    /// Newest modified time (epoch ms, 0 = nothing readable).
    modified: i64,
}

#[tauri::command]
async fn artist_size(db: State<'_, Db>, artist_id: i64) -> Result<ArtistSize, String> {
    let paths: Vec<String> = {
        let conn = db.lock().map_err(map_err)?;
        // only the creator's own rewards (see db::artist_own_image_paths)
        db::artist_own_image_paths(&conn, artist_id).map_err(map_err)?
    };
    // off the UI thread, one stat per file
    tauri::async_runtime::spawn_blocking(move || {
        let mut out = ArtistSize { bytes: 0, files: 0, missing: 0, modified: 0 };
        for p in paths {
            match std::fs::metadata(&p) {
                Ok(md) => {
                    out.bytes += md.len();
                    out.files += 1;
                    if let Some(t) = md
                        .modified()
                        .ok()
                        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                        .map(|d| d.as_millis() as i64)
                    {
                        out.modified = out.modified.max(t);
                    }
                }
                Err(_) => out.missing += 1,
            }
        }
        out
    })
    .await
    .map_err(|e| e.to_string())
}

/// Every creator's size in one sweep (the "Size" sort). Same source as artist_size
/// so the sort and the details window agree. One stat per file, so only while
/// that sort is on.
///
/// One creator's size in the sweep.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ArtistBytes {
    artist_id: i64,
    bytes: u64,
    files: u64,
}

#[tauri::command]
async fn library_sizes(db: State<'_, Db>) -> Result<Vec<ArtistBytes>, String> {
    let paths: Vec<(i64, String)> = {
        let conn = db.lock().map_err(map_err)?;
        db::all_own_image_paths(&conn).map_err(map_err)?
    };
    tauri::async_runtime::spawn_blocking(move || {
        let mut by_artist: std::collections::HashMap<i64, ArtistBytes> =
            std::collections::HashMap::new();
        for (artist_id, p) in paths {
            let e = by_artist.entry(artist_id).or_insert(ArtistBytes {
                artist_id,
                bytes: 0,
                files: 0,
            });
            match std::fs::metadata(&p) {
                // unreadable files count as 0 (the creator stays in the sort)
                Ok(md) => {
                    e.bytes += md.len();
                    e.files += 1;
                }
                Err(_) => {}
            }
        }
        by_artist.into_values().collect()
    })
    .await
    .map_err(|e| e.to_string())
}

/// Read the Windows file properties. Encrypted files have none.
#[tauri::command]
async fn read_file_props(path: String) -> Result<props::FileProps, String> {
    if crypto::file_is_encrypted(std::path::Path::new(&path)) {
        return Err("This file is encrypted — turn off encryption to view or edit its properties.".into());
    }
    tauri::async_runtime::spawn_blocking(move || props::read(&path))
        .await
        .map_err(|e| e.to_string())?
}

/// Write the Windows file properties into the file. Not for encrypted files.
#[tauri::command]
async fn write_file_props(path: String, data: props::FileProps) -> Result<(), String> {
    if crypto::file_is_encrypted(std::path::Path::new(&path)) {
        return Err("This file is encrypted — turn off encryption to edit its properties.".into());
    }
    tauri::async_runtime::spawn_blocking(move || props::write(&path, &data))
        .await
        .map_err(|e| e.to_string())?
}

/// One field across the selected files: how many have it and a sample value
/// (or "(multiple values)").
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct FieldSummary {
    key: String,
    present: u32,
    sample: String,
}
/// Per file: which fields it has, unusual = notable metadata (camera/location/author).
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct FileMeta {
    path: String,
    name: String,
    unusual: bool,
    present: Vec<String>,
}
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct MetaSummary {
    total: u32,
    encrypted: u32,
    fields: Vec<FieldSummary>,
    files: Vec<FileMeta>,
}

/// Read the metadata of many files for the "delete metadata" preview.
/// Files with notable metadata first.
#[tauri::command]
async fn summarize_file_props(paths: Vec<String>) -> Result<MetaSummary, String> {
    use std::collections::BTreeSet;
    tauri::async_runtime::spawn_blocking(move || {
        // fixed field order, the bool = notable
        let order: [(&str, bool); 10] = [
            ("title", false), ("subject", false), ("rating", false), ("tags", false),
            ("comments", false), ("authors", true), ("copyright", true), ("camera", true),
            ("dateTaken", true), ("gps", true),
        ];
        let mut counts = [0u32; 10];
        let mut value_sets: Vec<BTreeSet<String>> = (0..10).map(|_| BTreeSet::new()).collect();
        let mut files: Vec<FileMeta> = Vec::new();
        let mut encrypted = 0u32;
        let total = paths.len() as u32;
        for p in &paths {
            let path = std::path::Path::new(p);
            let name = path.file_name().and_then(|s| s.to_str()).unwrap_or("").to_string();
            if crypto::file_is_encrypted(path) {
                encrypted += 1;
                continue;
            }
            let Ok(m) = props::read_all(p) else { continue };
            let camera = format!("{} {}", m.camera_maker, m.camera_model).trim().to_string();
            let vals: [String; 10] = [
                m.title,
                m.subject,
                if m.rating > 0 { format!("{}\u{2605}", m.rating) } else { String::new() },
                m.tags.join(", "),
                m.comments,
                m.authors,
                m.copyright,
                camera,
                m.date_taken,
                m.gps,
            ];
            let mut present: Vec<String> = Vec::new();
            let mut unusual = false;
            for i in 0..10 {
                if !vals[i].is_empty() {
                    counts[i] += 1;
                    value_sets[i].insert(vals[i].clone());
                    present.push(order[i].0.to_string());
                    if order[i].1 {
                        unusual = true;
                    }
                }
            }
            files.push(FileMeta { path: p.clone(), name, unusual, present });
        }
        let fields: Vec<FieldSummary> = (0..10)
            .map(|i| FieldSummary {
                key: order[i].0.to_string(),
                present: counts[i],
                sample: match value_sets[i].len() {
                    0 => String::new(),
                    1 => value_sets[i].iter().next().cloned().unwrap_or_default(),
                    _ => "(multiple values)".to_string(),
                },
            })
            .collect();
        // notable first, then most fields, then name
        files.sort_by(|a, b| {
            b.unusual
                .cmp(&a.unusual)
                .then(b.present.len().cmp(&a.present.len()))
                .then(a.name.cmp(&b.name))
        });
        MetaSummary { total, encrypted, fields, files }
    })
    .await
    .map_err(|e| e.to_string())
}

/// Delete the chosen metadata fields from many files. Encrypted files are skipped.
/// Returns how many were cleared.
#[tauri::command]
async fn clear_file_props(paths: Vec<String>, fields: props::PropFields) -> Result<u32, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut cleared = 0u32;
        for p in &paths {
            if crypto::file_is_encrypted(std::path::Path::new(p)) {
                continue;
            }
            if props::clear(p, &fields).is_ok() {
                cleared += 1;
            }
        }
        cleared
    })
    .await
    .map_err(|e| e.to_string())
}

/// ---- library health / re-linking ----

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct HealthArtist {
    id: String,
    name: String,
    missing: u32,
}
/// A folder that's gone (the top missing folder of broken paths). count = files under it.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct BrokenRoot {
    path: String,
    count: u32,
}
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct HealthReport {
    checked: u32,
    missing: u32,
    /// Files of MiSD rewards that can't be reached (disk unplugged, not lost).
    sd_offline: u32,
    artists: Vec<HealthArtist>,
    broken_roots: Vec<BrokenRoot>,
    /// Collab links whose folder is gone (renamed outside MiColl).
    broken_collabs: Vec<db::BrokenCollab>,
    /// MiSD backup folders nothing points to anymore. Only listed, never removed.
    orphan_backups: Vec<String>,
}

/// The top missing FOLDER of path (the folder or drive that's gone).
/// None if all folders exist and only the file is gone (that's for Prune).
fn broken_root(path: &str) -> Option<std::path::PathBuf> {
    // parent folders without the file, from the root down
    let mut anc: Vec<&std::path::Path> = std::path::Path::new(path).ancestors().skip(1).collect();
    anc.reverse();
    anc.into_iter().find(|a| !a.exists()).map(|a| a.to_path_buf())
}

/// Check every image for a missing file: totals, per artist, and the broken root folders.
#[tauri::command]
async fn library_health(db: State<'_, Db>) -> Result<HealthReport, String> {
    let (rows, sd_paths, broken_collabs, orphan_backups) = {
        let conn = db.lock().map_err(map_err)?;
        (
            db::images_with_artist(&conn).map_err(map_err)?,
            sd::sd_image_paths(&conn).map_err(map_err)?,
            db::broken_collabs(&conn).map_err(map_err)?,
            sd::orphan_backups(&conn).unwrap_or_default(),
        )
    };
    tauri::async_runtime::spawn_blocking(move || {
        use std::collections::HashMap;
        let checked = rows.len() as u32;
        let mut missing = 0u32;
        let mut sd_offline = 0u32;
        let mut per_artist: HashMap<i64, (String, u32)> = HashMap::new();
        let mut roots: HashMap<String, u32> = HashMap::new();
        for (aid, name, path) in &rows {
            if std::path::Path::new(path).exists() {
                continue;
            }
            // an unreachable MiSD file = unplugged, not damage
            if sd_paths.contains(path) {
                sd_offline += 1;
                continue;
            }
            missing += 1;
            let e = per_artist.entry(*aid).or_insert((name.clone(), 0));
            e.1 += 1;
            if let Some(root) = broken_root(path) {
                *roots.entry(root.to_string_lossy().into_owned()).or_insert(0) += 1;
            }
        }
        let mut artists: Vec<HealthArtist> = per_artist
            .into_iter()
            .map(|(id, (name, missing))| HealthArtist { id: id.to_string(), name, missing })
            .collect();
        artists.sort_by(|a, b| b.missing.cmp(&a.missing).then(a.name.cmp(&b.name)));
        let mut broken_roots: Vec<BrokenRoot> =
            roots.into_iter().map(|(path, count)| BrokenRoot { path, count }).collect();
        broken_roots.sort_by(|a, b| b.count.cmp(&a.count).then(a.path.cmp(&b.path)));
        HealthReport {
            checked,
            missing,
            sd_offline,
            artists,
            broken_roots,
            broken_collabs,
            orphan_backups,
        }
    })
    .await
    .map_err(|e| e.to_string())
}

/// Re-link a moved folder: replace oldPrefix with newPrefix in all paths and allow
/// the new location. Returns how many images changed.
#[tauri::command]
fn relink_library(
    app: AppHandle,
    db: State<Db>,
    old_prefix: String,
    new_prefix: String,
) -> Result<u32, String> {
    let conn = db.lock().map_err(map_err)?;
    let n = db::relink_prefix(&conn, &old_prefix, &new_prefix).map_err(map_err)?;
    let _ = db::add_root(&conn, &new_prefix, None, None);
    allow_asset_dir(&app, &new_prefix);
    Ok(n)
}

/// Remove image rows whose file is really gone (after the user confirmed).
/// Rewards and artists stay. MiSD rewards are always excluded.
#[tauri::command]
async fn prune_missing(db: State<'_, Db>) -> Result<u32, String> {
    let rows = {
        let conn = db.lock().map_err(map_err)?;
        sd::image_id_paths_excluding_sd(&conn).map_err(map_err)?
    };
    let missing_ids: Vec<i64> = tauri::async_runtime::spawn_blocking(move || {
        rows.into_iter()
            .filter(|(_, p)| !std::path::Path::new(p).exists())
            .map(|(id, _)| id)
            .collect()
    })
    .await
    .map_err(|e| e.to_string())?;
    let conn = db.lock().map_err(map_err)?;
    db::delete_images_by_ids(&conn, &missing_ids).map_err(map_err)
}

/// Result of a fill: copied, skipped (user chose skip) and failed files.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct FillReport {
    added: u32,
    skipped: u32,
    failed: u32,
    /// Only for move_sources: source folders the recycle bin refused. The copy worked,
    /// it's a leftover, but the user should know.
    kept_sources: Vec<String>,
}

/// An incoming file that would overwrite an existing one. rel = path inside the
/// reward folder (forward slashes, the key for the answer), name = file name.
#[derive(serde::Serialize)]
struct FillConflict {
    rel: String,
    name: String,
}

/// Dry run result: which files clash. Empty = no prompt needed.
#[derive(serde::Serialize)]
struct FillPlan {
    conflicts: Vec<FillConflict>,
}

/// Turn the picked sources into (source file, destination path in the reward) pairs.
/// Files -> their name, folders keep their sub-paths. Same layout as fill_reward writes.
fn collect_fill_items(paths: &[String]) -> Vec<(std::path::PathBuf, std::path::PathBuf)> {
    let mut out = Vec::new();
    for p in paths {
        let src = std::path::Path::new(p);
        if src.is_file() {
            if let Some(name) = src.file_name() {
                out.push((src.to_path_buf(), std::path::PathBuf::from(name)));
            }
        } else if src.is_dir() {
            for entry in walkdir::WalkDir::new(src).into_iter().flatten() {
                if entry.file_type().is_file() {
                    if let Ok(rel) = entry.path().strip_prefix(src) {
                        out.push((entry.path().to_path_buf(), rel.to_path_buf()));
                    }
                }
            }
        }
    }
    out
}

/// Stable key for a relative path (forward slashes).
fn rel_key(rel: &std::path::Path) -> String {
    rel.components()
        .map(|c| c.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/")
}

/// The real folder a fill writes into (existing, or the managed month/title path).
/// Doesn't create anything.
fn fill_target(conn: &rusqlite::Connection, reward_id: i64) -> Result<std::path::PathBuf, String> {
    let (title, folder_path, period_id) = db::reward_scope(conn, reward_id)
        .map_err(map_err)?
        .ok_or_else(|| "Reward not found".to_string())?;
    let existing = std::path::Path::new(&folder_path);
    if !folder_path.contains('\u{1}') && existing.is_dir() {
        return Ok(existing.to_path_buf());
    }
    let (artist, platform, year, month, number) = db::period_scope(conn, period_id)
        .map_err(map_err)?
        .ok_or_else(|| "Period not found".to_string())?;
    let month_dir = managed_month_dir(conn, &artist, platform.as_deref(), year, month, number)
        .ok_or_else(|| {
            "No managed collection is set — choose one in Settings to add content.".to_string()
        })?;
    Ok(month_dir.join(sanitize_name(&title)))
}

/// Dry run: which files would overwrite existing ones, so the UI can ask.
#[tauri::command]
fn fill_reward_plan(db: State<Db>, reward_id: i64, paths: Vec<String>) -> Result<FillPlan, String> {
    let target = {
        let conn = db.lock().map_err(map_err)?;
        fill_target(&conn, reward_id)?
    };
    let mut conflicts = Vec::new();
    for (_src, rel) in collect_fill_items(&paths) {
        if target.join(&rel).exists() {
            conflicts.push(FillConflict {
                rel: rel_key(&rel),
                name: rel
                    .file_name()
                    .map(|s| s.to_string_lossy().into_owned())
                    .unwrap_or_else(|| rel_key(&rel)),
            });
        }
    }
    Ok(FillPlan { conflicts })
}

/// Fill a (missing) reward: copy the files into its month folder, index them -> owned.
#[tauri::command]
async fn fill_reward(
    app: AppHandle,
    db: State<'_, Db>,
    dek: State<'_, DekState>,
    reward_id: i64,
    paths: Vec<String>,
    // choice per clash by rel: "replace", "rename" or "skip". Not listed = copied,
    // an unknown clash defaults to "rename"
    resolutions: Option<std::collections::HashMap<String, String>>,
    // move the sources to the recycle bin after everything arrived (import merge answer)
    move_sources: Option<bool>,
) -> Result<FillReport, String> {
    let key = session_key(&dek);
    // the real target folder
    let target: std::path::PathBuf = {
        let conn = db.lock().map_err(map_err)?;
        fill_target(&conn, reward_id)?
    };

    // copy off the main thread, count ok/failed
    let target2 = target.clone();
    let resolutions = resolutions.unwrap_or_default();
    let consume = move_sources == Some(true);
    let sources = paths.clone();
    let (added, skipped, failed) = tauri::async_runtime::spawn_blocking(
        move || -> Result<(u32, u32, u32), String> {
            std::fs::create_dir_all(&target2).map_err(map_err)?;
            let mut added = 0u32;
            let mut skipped = 0u32;
            let mut failed = 0u32;
            for (src, rel) in collect_fill_items(&paths) {
                let dest = target2.join(&rel);
                if let Some(parent) = dest.parent() {
                    let _ = std::fs::create_dir_all(parent);
                }
                if dest.exists() {
                    match resolutions.get(&rel_key(&rel)).map(String::as_str) {
                        Some("skip") => {
                            skipped += 1;
                            continue;
                        }
                        Some("replace") => match std::fs::copy(&src, &dest) {
                            Ok(_) => added += 1,
                            Err(_) => failed += 1,
                        },
                        // "rename" (or unknown): never overwrite
                        _ => {
                            let parent = dest.parent().unwrap_or(&target2);
                            let name = dest.file_name().unwrap_or(rel.as_os_str());
                            let uniq = unique_dest(parent, name);
                            match std::fs::copy(&src, &uniq) {
                                Ok(_) => added += 1,
                                Err(_) => failed += 1,
                            }
                        }
                    }
                } else {
                    match std::fs::copy(&src, &dest) {
                        Ok(_) => added += 1,
                        Err(_) => failed += 1,
                    }
                }
            }
            // encrypt the new files if encryption is on and unlocked
            if let Some(k) = key {
                let dek = crypto::Dek::from_bytes(k);
                for entry in walkdir::WalkDir::new(&target2).into_iter().flatten() {
                    let p = entry.path();
                    if p.is_file() {
                        let _ = crypto::encrypt_file_in_place(&dek, p);
                    }
                }
            }
            Ok((added, skipped, failed))
        },
    )
    .await
    .map_err(|e| e.to_string())??;

    // index the folder and attach it to the reward
    let (images, cover) = indexer::collect_reward_images(&target);
    if images.is_empty() {
        return Err("No images or videos were found in the chosen files.".to_string());
    }
    let conn = db.lock().map_err(map_err)?;
    db::set_reward_content(&conn, reward_id, &target.to_string_lossy(), cover.as_deref(), &images)
        .map_err(map_err)?;
    if let Ok(Some((_, _, period_id))) = db::reward_scope(&conn, reward_id) {
        if let Ok(Some((artist, _, _, _, _))) = db::period_scope(&conn, period_id) {
            let _ = db::touch_artist_by_name(&conn, &artist);
        }
    }
    drop(conn);

    // delete the sources last, only if every file is indexed. A skip or a failure
    // means the source still has something, so it stays
    let mut kept_sources = Vec::new();
    if consume && skipped == 0 && failed == 0 {
        for p in &sources {
            let src = std::path::Path::new(p);
            if src.exists() {
                if let Some(msg) = trash_dir(src) {
                    kept_sources.push(msg);
                }
            }
        }
    }

    allow_asset_dir(&app, &target.to_string_lossy());
    Ok(FillReport { added, skipped, failed, kept_sources })
}

/// Create an empty reward folder in a period ("New folder"). Returns the reward id.
#[tauri::command]
fn create_reward(app: AppHandle, db: State<Db>, period_id: i64, name: String) -> Result<i64, String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("Please enter a folder name.".to_string());
    }
    let conn = db.lock().map_err(map_err)?;
    let dir = period_month_dir(&conn, period_id).ok_or_else(|| {
        "Couldn't locate this month's folder — set a managed collection in Settings.".to_string()
    })?;
    let folder = unique_dir(&dir, &sanitize_name(&name));
    std::fs::create_dir_all(&folder).map_err(map_err)?;
    let id = db::insert_empty_reward(&conn, period_id, &name, &folder.to_string_lossy())
        .map_err(map_err)?;
    drop(conn);
    allow_asset_dir(&app, &folder.to_string_lossy());
    Ok(id)
}

/// Add a "missing" placeholder card (no folder on disk, a fake key like templates use).
/// It becomes a real folder when files are added. Returns the reward id.
#[tauri::command]
fn create_missing_reward(db: State<Db>, period_id: i64, name: String) -> Result<i64, String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("Please enter a name.".to_string());
    }
    let conn = db.lock().map_err(map_err)?;
    let (artist, platform, year, month, number) = db::period_scope(&conn, period_id)
        .map_err(map_err)?
        .ok_or_else(|| "Period not found".to_string())?;
    let key = indexer::period_key(&artist, platform.as_deref(), year, month, number);
    let folder_path = format!("{key}\u{1}{}", indexer::norm_title(&name));
    db::insert_missing_reward(&conn, period_id, &name, None, &folder_path).map_err(map_err)?;
    let id: i64 = conn
        .query_row(
            "SELECT id FROM rewards WHERE folder_path = ?1",
            rusqlite::params![folder_path],
            |r| r.get(0),
        )
        .map_err(map_err)?;
    Ok(id)
}

/// Find or create the period for platform/year/month (or drop) and return its id.
/// Lets "Move to..." target a period that doesn't exist yet. The folder is made by the
/// move.
#[tauri::command]
fn ensure_period(
    db: State<Db>,
    artist_id: i64,
    platform: Option<String>,
    year: Option<i64>,
    month: Option<i64>,
    number: Option<i64>,
) -> Result<i64, String> {
    let conn = db.lock().map_err(map_err)?;
    let (artist, _no_dates) = db::artist_info(&conn, artist_id)
        .map_err(map_err)?
        .ok_or_else(|| "Artist not found.".to_string())?;
    let key = indexer::period_key(&artist, platform.as_deref(), year, month, number);
    if let Some(id) = db::period_id_by_key(&conn, &key).map_err(map_err)? {
        return Ok(id); // already exists — reuse it
    }
    // drop number -> "#N", no year -> "Misc"
    let label = match (number, year) {
        (Some(n), _) => indexer::fmt_number_label(n),
        (None, Some(y)) => indexer::fmt_label(y, month),
        (None, None) => "Misc".to_string(),
    };
    indexer::upsert_period(
        &conn,
        artist_id,
        platform.as_deref(),
        year,
        month,
        number,
        &label,
        &key,
        platform.is_none(),
    )
    .map_err(map_err)
}

/// Add a wish: a "missing" reward for something the user wants.
/// One command because it may have to create the creator first.
/// Nothing on disk. It gets a template-like key, so it fills itself:
///   · files dropped on the card -> db::add_image flips it to owned
///   · files in their own folder -> indexed as a real reward, and
///     dedupe_template_placeholders removes the empty placeholder
/// Either way it leaves the wishlist when the files arrive.
#[tauri::command]
fn add_wish(
    db: State<Db>,
    creator: String,
    title: String,
    platform: Option<String>,
    year: Option<i64>,
    month: Option<i64>,
) -> Result<i64, String> {
    let creator = creator.trim().to_string();
    let title = title.trim().to_string();
    if creator.is_empty() {
        return Err("Please name the creator.".to_string());
    }
    if title.is_empty() {
        return Err("Please name the reward you're after.".to_string());
    }
    let platform = platform.map(|p| p.trim().to_string()).filter(|p| !p.is_empty());
    let conn = db.lock().map_err(map_err)?;

    // look up the creator first, create_artist would also change no_dates
    let artist_id = match db::artist_id_by_name(&conn, &creator).map_err(map_err)? {
        Some(id) => id,
        None => db::create_artist(&conn, &creator, None, false).map_err(map_err)?,
    };

    // find or create the period (like ensure_period)
    let key = indexer::period_key(&creator, platform.as_deref(), year, month, None);
    let period_id = match db::period_id_by_key(&conn, &key).map_err(map_err)? {
        Some(id) => id,
        None => {
            let label = match year {
                Some(y) => indexer::fmt_label(y, month),
                None => "Misc".to_string(),
            };
            indexer::upsert_period(
                &conn,
                artist_id,
                platform.as_deref(),
                year,
                month,
                None,
                &label,
                &key,
                platform.is_none(),
            )
            .map_err(map_err)?
        }
    };

    let folder_path = format!("{key}\u{1}{}", indexer::norm_title(&title));
    // if the row already existed (a template lists it) it's a wish but not ours to delete
    let existing: Option<i64> = conn
        .query_row(
            "SELECT id FROM rewards WHERE folder_path = ?1",
            rusqlite::params![folder_path],
            |r| r.get(0),
        )
        .ok();
    let id = match existing {
        Some(id) => {
            db::set_reward_wished(&conn, id, 2).map_err(map_err)?;
            id
        }
        None => {
            db::insert_missing_reward(&conn, period_id, &title, None, &folder_path)
                .map_err(map_err)?;
            let id: i64 = conn
                .query_row(
                    "SELECT id FROM rewards WHERE folder_path = ?1",
                    rusqlite::params![folder_path],
                    |r| r.get(0),
                )
                .map_err(map_err)?;
            db::set_reward_wished(&conn, id, 1).map_err(map_err)?;
            id
        }
    };
    Ok(id)
}

/// Take a reward off the wishlist without deleting it.
#[tauri::command]
fn set_wished(db: State<Db>, reward_id: i64, wished: i64) -> Result<(), String> {
    let conn = db.lock().map_err(map_err)?;
    db::set_reward_wished(&conn, reward_id, wished).map_err(map_err)
}

/// Move reward folders into another period. Returns how many moved.
/// Template placeholders (no folder) are skipped.
#[tauri::command]
async fn move_rewards(
    app: AppHandle,
    db: State<'_, Db>,
    reward_ids: Vec<i64>,
    dest_period_id: i64,
) -> Result<u32, String> {
    let dest_dir = {
        let conn = db.lock().map_err(map_err)?;
        period_month_dir(&conn, dest_period_id)
            .ok_or_else(|| "Couldn't locate the destination folder.".to_string())?
    };
    // (id, title, old_folder) of every movable reward
    let sources: Vec<(i64, String, String)> = {
        let conn = db.lock().map_err(map_err)?;
        let mut out = Vec::new();
        for id in &reward_ids {
            if let Some((title, folder, _)) = db::reward_scope(&conn, *id).map_err(map_err)? {
                if !folder.contains('\u{1}') {
                    out.push((*id, title, folder));
                }
            }
        }
        out
    };

    let dest_dir2 = dest_dir.clone();
    let moved: Vec<(i64, String, String)> =
        tauri::async_runtime::spawn_blocking(move || -> Vec<(i64, String, String)> {
            let _ = std::fs::create_dir_all(&dest_dir2);
            let mut moved = Vec::new();
            for (id, title, old) in sources {
                let old_path = std::path::Path::new(&old);
                if !old_path.is_dir() || old_path.parent() == Some(dest_dir2.as_path()) {
                    continue; // missing, or already living in the destination
                }
                let target = unique_dir(&dest_dir2, &sanitize_name(&title));
                if move_tree(old_path, &target).is_ok() {
                    moved.push((id, old, target.to_string_lossy().to_string()));
                }
            }
            moved
        })
        .await
        .map_err(|e| e.to_string())?;

    let count = moved.len() as u32;
    {
        let conn = db.lock().map_err(map_err)?;
        for (id, old, new) in &moved {
            db::move_reward(&conn, *id, dest_period_id, old, new).map_err(map_err)?;
        }
    }
    allow_asset_dir(&app, &dest_dir.to_string_lossy());
    Ok(count)
}

/// Move media files into another reward's folder and re-index the affected rewards.
/// Returns how many moved.
#[tauri::command]
async fn move_images(
    app: AppHandle,
    db: State<'_, Db>,
    image_ids: Vec<i64>,
    dest_reward_id: i64,
) -> Result<u32, String> {
    // the target reward's real folder
    let dest_dir = {
        let conn = db.lock().map_err(map_err)?;
        let (title, folder, period_id) = db::reward_scope(&conn, dest_reward_id)
            .map_err(map_err)?
            .ok_or_else(|| "Destination reward not found".to_string())?;
        if !folder.contains('\u{1}') {
            std::path::PathBuf::from(folder)
        } else {
            period_month_dir(&conn, period_id)
                .map(|d| d.join(sanitize_name(&title)))
                .ok_or_else(|| "Couldn't locate the destination folder.".to_string())?
        }
    };
    // (path, source reward id) per image
    let srcs: Vec<(String, i64)> = {
        let conn = db.lock().map_err(map_err)?;
        let mut out = Vec::new();
        for id in &image_ids {
            if let Some((path, _rel, rid)) = db::image_row(&conn, *id).map_err(map_err)? {
                out.push((path, rid));
            }
        }
        out
    };

    let dest_dir2 = dest_dir.clone();
    let paths: Vec<String> = srcs.iter().map(|(p, _)| p.clone()).collect();
    // moved files as (old, new) to update previews
    let moved: Vec<(String, String)> =
        tauri::async_runtime::spawn_blocking(move || -> Vec<(String, String)> {
            let _ = std::fs::create_dir_all(&dest_dir2);
            let mut moved = Vec::new();
            for p in &paths {
                let src = std::path::Path::new(p);
                if src.parent() == Some(dest_dir2.as_path()) {
                    continue; // already there
                }
                if let Some(name) = src.file_name() {
                    let dest = unique_dest(&dest_dir2, name);
                    let ok = std::fs::rename(src, &dest).is_ok()
                        || (std::fs::copy(src, &dest).is_ok() && std::fs::remove_file(src).is_ok());
                    if ok {
                        moved.push((p.clone(), dest.to_string_lossy().to_string()));
                    }
                }
            }
            moved
        })
        .await
        .map_err(|e| e.to_string())?;
    let count = moved.len() as u32;

    // re-index every changed reward and update previews/covers of moved files
    {
        let conn = db.lock().map_err(map_err)?;
        let mut affected: Vec<i64> = srcs.iter().map(|(_, rid)| *rid).collect();
        affected.push(dest_reward_id);
        affected.sort_unstable();
        affected.dedup();
        for rid in affected {
            if let Some((title, folder, period_id)) = db::reward_scope(&conn, rid).map_err(map_err)? {
                let dir = if folder.contains('\u{1}') {
                    period_month_dir(&conn, period_id).map(|d| d.join(sanitize_name(&title)))
                } else {
                    Some(std::path::PathBuf::from(&folder))
                };
                if let Some(dir) = dir {
                    let (images, cover) = indexer::collect_reward_images(&dir);
                    db::set_reward_content(&conn, rid, &dir.to_string_lossy(), cover.as_deref(), &images)
                        .map_err(map_err)?;
                }
            }
        }
        for (old, new) in &moved {
            db::remap_preview_exact(&conn, old, new).map_err(map_err)?;
        }
    }
    allow_asset_dir(&app, &dest_dir.to_string_lossy());
    Ok(count)
}

/// Merge reward folders INTO another reward, re-index it and delete the old rewards.
/// Returns how many files moved.
/// keep_folder = true moves each whole folder as a subfolder, false merges the files.
#[tauri::command]
async fn merge_rewards(
    app: AppHandle,
    db: State<'_, Db>,
    reward_ids: Vec<i64>,
    dest_reward_id: i64,
    keep_folder: Option<bool>,
) -> Result<u32, String> {
    let keep_folder = keep_folder.unwrap_or(false);
    // the target reward's real folder
    let dest_dir = {
        let conn = db.lock().map_err(map_err)?;
        let (title, folder, period_id) = db::reward_scope(&conn, dest_reward_id)
            .map_err(map_err)?
            .ok_or_else(|| "Destination reward not found".to_string())?;
        if !folder.contains('\u{1}') {
            std::path::PathBuf::from(folder)
        } else {
            period_month_dir(&conn, period_id)
                .map(|d| d.join(sanitize_name(&title)))
                .ok_or_else(|| "Couldn't locate the destination folder.".to_string())?
        }
    };
    // source rewards (not the target, no placeholders) and their files
    let sources: Vec<(i64, String)> = {
        let conn = db.lock().map_err(map_err)?;
        let mut out = Vec::new();
        for id in &reward_ids {
            if *id == dest_reward_id {
                continue;
            }
            if let Some((_t, folder, _p)) = db::reward_scope(&conn, *id).map_err(map_err)? {
                if !folder.contains('\u{1}') {
                    out.push((*id, folder));
                }
            }
        }
        out
    };

    // "keep folder": move each source folder in as a subfolder
    if keep_folder {
        let dest_dir2 = dest_dir.clone();
        let src_folders = sources.clone();
        let (moved_dirs, count): (Vec<(String, String)>, u32) =
            tauri::async_runtime::spawn_blocking(move || -> (Vec<(String, String)>, u32) {
                let _ = std::fs::create_dir_all(&dest_dir2);
                let mut moved = Vec::new();
                let mut count = 0u32;
                for (_, folder) in &src_folders {
                    let dir = std::path::Path::new(folder);
                    if !dir.is_dir() || dir == dest_dir2 {
                        continue;
                    }
                    let name = dir
                        .file_name()
                        .map(|n| n.to_string_lossy().to_string())
                        .unwrap_or_else(|| "folder".into());
                    let target = unique_dir(&dest_dir2, &sanitize_name(&name));
                    if move_tree(dir, &target).is_ok() {
                        for e in walkdir::WalkDir::new(&target).into_iter().flatten() {
                            if e.path().is_file() {
                                count += 1;
                            }
                        }
                        moved.push((folder.clone(), target.to_string_lossy().to_string()));
                    }
                }
                (moved, count)
            })
            .await
            .map_err(|e| e.to_string())?;

        {
            let conn = db.lock().map_err(map_err)?;
            // update favourites + previews under each moved folder
            for (old_prefix, new_prefix) in &moved_dirs {
                conn.execute(
                    "UPDATE OR REPLACE wallpaper_favs SET file_path = ?2 || substr(file_path, length(?1)+1) WHERE substr(file_path,1,length(?1)) = ?1",
                    rusqlite::params![old_prefix, new_prefix],
                )
                .map_err(map_err)?;
                conn.execute(
                    "UPDATE OR REPLACE favorites SET file_path = ?2 || substr(file_path, length(?1)+1) WHERE substr(file_path,1,length(?1)) = ?1",
                    rusqlite::params![old_prefix, new_prefix],
                )
                .map_err(map_err)?;
                conn.execute(
                    "UPDATE OR REPLACE collection_items SET file_path = ?2 || substr(file_path, length(?1)+1) WHERE substr(file_path,1,length(?1)) = ?1",
                    rusqlite::params![old_prefix, new_prefix],
                )
                .map_err(map_err)?;
                db::remap_preview_prefix(&conn, old_prefix, new_prefix).map_err(map_err)?;
            }
            // delete the merged rewards
            let src_ids: Vec<i64> = sources.iter().map(|(id, _)| *id).collect();
            db::delete_rewards(&conn, &src_ids).map_err(map_err)?;
            // re-index the target so the subfolder's media is attached
            let (images, cover) = indexer::collect_reward_images(&dest_dir);
            db::set_reward_content(&conn, dest_reward_id, &dest_dir.to_string_lossy(), cover.as_deref(), &images)
                .map_err(map_err)?;
        }
        allow_asset_dir(&app, &dest_dir.to_string_lossy());
        return Ok(count);
    }

    let files: Vec<String> = {
        let conn = db.lock().map_err(map_err)?;
        let mut out = Vec::new();
        for (id, _) in &sources {
            let mut stmt = conn
                .prepare("SELECT file_path FROM images WHERE reward_id = ?1")
                .map_err(map_err)?;
            let rows = stmt
                .query_map(rusqlite::params![id], |r| r.get::<_, String>(0))
                .map_err(map_err)?;
            for r in rows {
                out.push(r.map_err(map_err)?);
            }
        }
        out
    };

    let dest_dir2 = dest_dir.clone();
    // move every file into the target, collect (old, new)
    let moved: Vec<(String, String)> =
        tauri::async_runtime::spawn_blocking(move || -> Vec<(String, String)> {
            let _ = std::fs::create_dir_all(&dest_dir2);
            let mut moved = Vec::new();
            for p in &files {
                let src = std::path::Path::new(p);
                if src.parent() == Some(dest_dir2.as_path()) {
                    continue; // already in the destination
                }
                if let Some(name) = src.file_name() {
                    let dest = unique_dest(&dest_dir2, name);
                    let ok = std::fs::rename(src, &dest).is_ok()
                        || (std::fs::copy(src, &dest).is_ok() && std::fs::remove_file(src).is_ok());
                    if ok {
                        moved.push((p.clone(), dest.to_string_lossy().to_string()));
                    }
                }
            }
            moved
        })
        .await
        .map_err(|e| e.to_string())?;
    let count = moved.len() as u32;

    {
        let conn = db.lock().map_err(map_err)?;
        // update favourites + previews of moved files
        for (old, new) in &moved {
            conn.execute(
                "UPDATE OR REPLACE wallpaper_favs SET file_path = ?2 WHERE file_path = ?1",
                rusqlite::params![old, new],
            )
            .map_err(map_err)?;
            conn.execute(
                "UPDATE OR REPLACE favorites SET file_path = ?2 WHERE file_path = ?1",
                rusqlite::params![old, new],
            )
            .map_err(map_err)?;
            conn.execute(
                "UPDATE OR REPLACE collection_items SET file_path = ?2 WHERE file_path = ?1",
                rusqlite::params![old, new],
            )
            .map_err(map_err)?;
            db::remap_preview_exact(&conn, old, new).map_err(map_err)?;
        }
        // delete the now empty rewards
        let src_ids: Vec<i64> = sources.iter().map(|(id, _)| *id).collect();
        db::delete_rewards(&conn, &src_ids).map_err(map_err)?;
        // re-index the target (images, cover, count)
        let (images, cover) = indexer::collect_reward_images(&dest_dir);
        db::set_reward_content(&conn, dest_reward_id, &dest_dir.to_string_lossy(), cover.as_deref(), &images)
            .map_err(map_err)?;
    }

    // trash the source folders that are empty now. Only the indexed files moved, a
    // folder that still has something (a text file, a subfolder) stays
    {
        let conn = db.lock().map_err(map_err)?;
        let boundaries = delete_boundaries(&conn);
        drop(conn);
        for (_, folder) in &sources {
            let dir = std::path::PathBuf::from(folder);
            if dir != dest_dir {
                let _ = trash_if_empty(&dir, &boundaries);
            }
        }
    }

    allow_asset_dir(&app, &dest_dir.to_string_lossy());
    Ok(count)
}

/// Open a month's folder in Explorer (also works for a break without rewards).
#[tauri::command]
fn reveal_period(db: State<Db>, period_id: i64) -> Result<(), String> {
    let conn = db.lock().map_err(map_err)?;
    let dir = period_month_dir(&conn, period_id)
        .ok_or_else(|| "Couldn't locate this month's folder.".to_string())?;
    drop(conn);
    open_dir(&dir)
}

/// The folder that is this period's own: a month, a year or a drop. A period without a
/// date has none, its rebuilt path is the platform's folder (or for no platform the
/// creator's), which holds everything else too.
fn period_own_dir(conn: &rusqlite::Connection, period_id: i64) -> Option<std::path::PathBuf> {
    let (_, _, year, _, number) = db::period_scope(conn, period_id).ok().flatten()?;
    if year.is_none() && number.is_none() {
        return None;
    }
    period_month_dir(conn, period_id)
}

/// Delete a period (a break or empty month), optionally trashing its folder.
#[tauri::command]
async fn delete_period(db: State<'_, Db>, period_id: i64, also_files: bool) -> Result<(), String> {
    let conn = db.lock().map_err(map_err)?;
    // disk first, the rows only go once the files are really gone
    if also_files {
        let boundaries = delete_boundaries(&conn);
        // before the rewards go, the folder is found through them
        let own_dir = period_own_dir(&conn, period_id);
        let marker_dir = period_month_dir(&conn, period_id);
        let ids = db::period_reward_ids(&conn, period_id).map_err(map_err)?;
        let plan = plan_reward_trash(&conn, &ids).map_err(map_err)?;
        let (done, failed) = trash_rewards(&plan, &boundaries);
        if !failed.is_empty() {
            db::delete_rewards(&conn, &done).map_err(map_err)?;
            return Err(trash_failure_message(&failed));
        }
        // a break's note is ours
        if let Some(dir) = marker_dir {
            let _ = std::fs::remove_file(dir.join(db::SKIP_MARKER));
        }
        // the month folder itself only when nothing is left in it
        if let Some(why) = own_dir.and_then(|d| trash_if_empty(&d, &boundaries)) {
            return Err(trash_failure_message(&[why]));
        }
    }
    db::delete_period(&conn, period_id).map_err(map_err)
}

/// Total disk size of all images (off the main thread).
#[tauri::command]
async fn library_size(db: State<'_, Db>) -> Result<u64, String> {
    let paths = {
        let conn = db.lock().map_err(map_err)?;
        db::all_image_paths(&conn).map_err(map_err)?
    };
    Ok(tauri::async_runtime::spawn_blocking(move || {
        paths
            .iter()
            .filter_map(|p| std::fs::metadata(p).ok())
            .map(|m| m.len())
            .sum::<u64>()
    })
    .await
    .map_err(|e| e.to_string())?)
}

#[tauri::command]
fn set_artist_no_dates(db: State<Db>, artist_id: i64, no_dates: bool) -> Result<(), String> {
    let conn = db.lock().map_err(map_err)?;
    db::set_artist_no_dates_by_id(&conn, artist_id, no_dates).map_err(map_err)
}

/// Set how a creator releases: "monthly" | "numbered" | "none" (keeps no_dates in sync).
#[tauri::command]
fn set_artist_release_style(db: State<Db>, artist_id: i64, style: String) -> Result<(), String> {
    let conn = db.lock().map_err(map_err)?;
    db::set_artist_release_style_by_id(&conn, artist_id, &style).map_err(map_err)
}

/// Release style override for one platform ("Unsorted" = none).
#[tauri::command]
fn set_platform_release_style(
    db: State<Db>,
    artist_id: i64,
    platform: String,
    style: String,
) -> Result<(), String> {
    let conn = db.lock().map_err(map_err)?;
    db::set_platform_release_style(&conn, artist_id, &platform, &style).map_err(map_err)
}

/// "Posts without dates" override for one platform ("Unsorted" = none).
#[tauri::command]
fn set_platform_no_dates(
    db: State<Db>,
    artist_id: i64,
    platform: String,
    no_dates: bool,
) -> Result<(), String> {
    let conn = db.lock().map_err(map_err)?;
    db::set_platform_no_dates(&conn, artist_id, &platform, no_dates).map_err(map_err)
}

#[tauri::command]
fn set_artist_tag(db: State<Db>, artist_id: i64, tag: Option<String>) -> Result<(), String> {
    let conn = db.lock().map_err(map_err)?;
    db::set_artist_tag(&conn, artist_id, tag.as_deref()).map_err(map_err)
}

#[tauri::command]
fn set_artist_links(db: State<Db>, artist_id: i64, links: String) -> Result<(), String> {
    let conn = db.lock().map_err(map_err)?;
    db::set_artist_links(&conn, artist_id, &links).map_err(map_err)
}

#[tauri::command]
fn set_artist_notes(db: State<Db>, artist_id: i64, notes: Option<String>) -> Result<(), String> {
    let conn = db.lock().map_err(map_err)?;
    // empty = no notes
    let trimmed = notes.as_deref().map(str::trim).filter(|s| !s.is_empty());
    db::set_artist_notes(&conn, artist_id, trimmed).map_err(map_err)
}

#[tauri::command]
fn set_artist_tags(db: State<Db>, artist_id: i64, tags: String) -> Result<(), String> {
    let conn = db.lock().map_err(map_err)?;
    db::set_artist_tags(&conn, artist_id, &tags).map_err(map_err)
}

/// Clear a reward's "new" badge (first time its viewer opens).
#[tauri::command]
fn mark_reward_seen(db: State<Db>, reward_id: i64) -> Result<(), String> {
    let conn = db.lock().map_err(map_err)?;
    db::mark_reward_seen(&conn, reward_id).map_err(map_err)
}

/// Clear every "new" badge. Returns how many.
#[tauri::command]
fn mark_all_rewards_seen(db: State<Db>) -> Result<usize, String> {
    let conn = db.lock().map_err(map_err)?;
    db::mark_all_rewards_seen(&conn).map_err(map_err)
}

#[tauri::command]
fn set_artist_aliases(db: State<Db>, artist_id: i64, aliases: String) -> Result<(), String> {
    let conn = db.lock().map_err(map_err)?;
    db::set_artist_aliases(&conn, artist_id, &aliases).map_err(map_err)
}

#[tauri::command]
fn set_artist_kind(db: State<Db>, artist_id: i64, kind: Option<String>) -> Result<(), String> {
    let conn = db.lock().map_err(map_err)?;
    db::set_artist_kind(&conn, artist_id, kind.as_deref()).map_err(map_err)
}

/// Turn "Wallpaper favourites" on/off for an artist.
#[tauri::command]
fn set_artist_wallpaper_fav(db: State<Db>, artist_id: i64, on: bool) -> Result<(), String> {
    let conn = db.lock().map_err(map_err)?;
    db::set_artist_wallpaper_fav(&conn, artist_id, on).map_err(map_err)
}

/// Hide or unhide a creator (see db::set_artist_hidden).
#[tauri::command]
fn set_artist_hidden(db: State<Db>, artist_id: i64, hidden: bool) -> Result<(), String> {
    let conn = db.lock().map_err(map_err)?;
    db::set_artist_hidden(&conn, artist_id, hidden).map_err(map_err)
}

/// Move a creator into the graveyard or back.
/// In a managed collection the folder moves too (MiColl\<name> <-> MiColl\🪦
/// Graveyard\<name>),
/// then all paths are updated. Outside the collection only the flag changes.
#[tauri::command]
fn set_artist_graveyard(
    app: AppHandle,
    db: State<Db>,
    artist_id: i64,
    on: bool,
) -> Result<(), String> {
    let conn = db.lock().map_err(map_err)?;
    if let Some(dir) = graveyard_move(&conn, artist_id, on)? {
        allow_asset_dir(&app, &dir);
    }
    db::checkpoint(&conn);
    Ok(())
}

/// The work of set_artist_graveyard without the app handle (for tests).
/// Returns the new folder if one was moved.
fn graveyard_move(
    conn: &rusqlite::Connection,
    artist_id: i64,
    on: bool,
) -> Result<Option<String>, String> {
    let mut moved = None;
    let (name, _) = db::artist_info(conn, artist_id)
        .map_err(map_err)?
        .ok_or("Creator not found.")?;
    let coll = db::get_setting(conn, "collection_root")
        .map_err(map_err)?
        .filter(|s| !s.trim().is_empty());
    if let (true, Some(coll)) = (managed_collection(conn), coll) {
        let shelf = std::path::Path::new(&coll).join("MiColl");
        let grave = shelf.join(indexer::GRAVEYARD_DIR);
        let (from, to) = if on { (&shelf, &grave) } else { (&grave, &shelf) };
        let expected = from.join(sanitize_name(&name));
        // use the stored spelling so the path update matches exactly (SQL is
        // case-sensitive)
        let want = format!("{}\\", norm_path(&expected));
        let stored = db::artist_reward_folders(conn, artist_id)
            .unwrap_or_default()
            .into_iter()
            .find_map(|f| {
                let n = format!("{}\\", norm_path(std::path::Path::new(&f)));
                n.starts_with(&want)
                    .then(|| f.chars().take(want.chars().count() - 1).collect::<String>())
            });
        let src = stored.map(std::path::PathBuf::from).unwrap_or(expected);
        if src.is_dir() {
            let fname = src.file_name().ok_or("Couldn't resolve the creator's folder.")?;
            let dst = to.join(fname);
            if dst.exists() {
                return Err(format!(
                    "A folder already exists at {}. Rename or remove it first.",
                    dst.display()
                ));
            }
            move_tree(&src, &dst).map_err(map_err)?;
            let (old_s, new_s) =
                (src.to_string_lossy().to_string(), dst.to_string_lossy().to_string());
            if let Err(e) = relink_dir(conn, &old_s, &new_s) {
                // move the folder back rather than leave paths pointing nowhere
                let _ = move_tree(&dst, &src);
                return Err(map_err(e));
            }
            // the last one out removes the empty graveyard folder
            if !on {
                let _ = std::fs::remove_dir(&grave);
            }
            moved = Some(new_s);
        }
        // MiSD rewards remember where "bring back" returns them. The update above only
        // reaches them if the creator's folder existed, so update them here too
        let dir_name = src
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| sanitize_name(&name));
        repoint_sd_origins(conn, artist_id, &from.join(&dir_name), &to.join(&dir_name))
            .map_err(map_err)?;
    }
    db::set_artist_graveyard(conn, artist_id, on).map_err(map_err)?;
    Ok(moved)
}

/// Update the MiSD return path (sd_origin) of this creator's moved rewards from old
/// to new. Case-insensitive, only this creator's rewards ("Aurora Vale" stays).
fn repoint_sd_origins(
    conn: &rusqlite::Connection,
    artist_id: i64,
    old: &std::path::Path,
    new: &std::path::Path,
) -> rusqlite::Result<()> {
    let old_n = norm_path(old);
    let new_s = new.to_string_lossy().trim_end_matches(['\\', '/']).to_string();
    let rows: Vec<(i64, String)> = {
        let mut stmt = conn.prepare(
            "SELECT r.id, r.sd_origin FROM rewards r JOIN periods p ON p.id = r.period_id \
             WHERE p.artist_id = ?1 AND r.sd_origin IS NOT NULL",
        )?;
        let it = stmt.query_map([artist_id], |r| Ok((r.get(0)?, r.get(1)?)))?;
        it.collect::<rusqlite::Result<_>>()?
    };
    for (id, origin) in rows {
        let n = norm_path(std::path::Path::new(&origin));
        let Some(rest) = n.strip_prefix(&old_n) else { continue };
        if !rest.is_empty() && !rest.starts_with('\\') {
            continue; // "Aurora Vale" is not inside "Aurora"
        }
        // keep the original spelling of the rest of the path
        let tail: String = origin.chars().skip(origin.chars().count() - rest.chars().count()).collect();
        conn.execute(
            "UPDATE rewards SET sd_origin = ?2 WHERE id = ?1",
            rusqlite::params![id, format!("{new_s}{tail}")],
        )?;
    }
    Ok(())
}

/// Mark/unmark one image as favourite wallpaper.
#[tauri::command]
fn set_image_wallpaper_fav(db: State<Db>, path: String, fav: bool) -> Result<(), String> {
    let conn = db.lock().map_err(map_err)?;
    db::set_image_wallpaper_fav(&conn, &path, fav).map_err(map_err)
}

/// Add/remove one file to/from Favourites.
#[tauri::command]
fn set_image_favorite(db: State<Db>, path: String, fav: bool) -> Result<(), String> {
    let conn = db.lock().map_err(map_err)?;
    db::set_image_favorite(&conn, &path, fav).map_err(map_err)
}

/* ---- User-made collections (the "+" tabs on a creator's page) ------------- */

#[tauri::command]
fn list_collections(db: State<Db>) -> Result<Vec<db::CollectionRow>, String> {
    let conn = db.lock().map_err(map_err)?;
    db::list_collections(&conn).map_err(map_err)
}

/// Create a collection, returns its id. Empty names are refused.
#[tauri::command]
fn create_collection(db: State<Db>, name: String) -> Result<i64, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("A collection needs a name.".into());
    }
    let conn = db.lock().map_err(map_err)?;
    db::create_collection(&conn, name).map_err(map_err)
}

#[tauri::command]
fn rename_collection(db: State<Db>, id: i64, name: String) -> Result<(), String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("A collection needs a name.".into());
    }
    let conn = db.lock().map_err(map_err)?;
    db::rename_collection(&conn, id, name).map_err(map_err)
}

/// Delete a collection (only the grouping, no files).
#[tauri::command]
fn delete_collection(db: State<Db>, id: i64) -> Result<(), String> {
    let conn = db.lock().map_err(map_err)?;
    db::delete_collection(&conn, id).map_err(map_err)
}

/// Add/remove one file to/from a collection.
#[tauri::command]
fn set_image_collection(
    db: State<Db>,
    collection_id: i64,
    path: String,
    on: bool,
) -> Result<(), String> {
    let conn = db.lock().map_err(map_err)?;
    db::set_image_collection(&conn, collection_id, &path, on).map_err(map_err)
}

/// Open a URL in the default browser.
/// Uses ShellExecuteW instead of "cmd /c start" (cmd broke URLs with & % ^ @).
/// A URL without scheme gets https:// so it doesn't open as a file.
#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    let url = url.trim();
    if url.is_empty() {
        return Err("empty URL".into());
    }
    let normalized = if url.contains("://") {
        url.to_string()
    } else {
        format!("https://{url}")
    };
    #[cfg(target_os = "windows")]
    {
        use std::ffi::OsStr;
        use std::os::windows::ffi::OsStrExt;
        #[link(name = "shell32")]
        extern "system" {
            fn ShellExecuteW(
                hwnd: *mut core::ffi::c_void,
                lpoperation: *const u16,
                lpfile: *const u16,
                lpparameters: *const u16,
                lpdirectory: *const u16,
                nshowcmd: i32,
            ) -> isize;
        }
        let wide = |s: &str| -> Vec<u16> { OsStr::new(s).encode_wide().chain(Some(0)).collect() };
        let op = wide("open");
        let file = wide(&normalized);
        const SW_SHOWNORMAL: i32 = 1;
        // ShellExecuteW returns > 32 on success
        let ret = unsafe {
            ShellExecuteW(
                std::ptr::null_mut(),
                op.as_ptr(),
                file.as_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                SW_SHOWNORMAL,
            )
        };
        if ret <= 32 {
            return Err(format!("couldn't open the link (ShellExecute error {ret})"));
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = normalized;
    }
    Ok(())
}

/// Set an image as the Windows desktop wallpaper.
#[tauri::command]
fn set_wallpaper(path: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use std::ffi::OsStr;
        use std::os::windows::ffi::OsStrExt;
        const SPI_SETDESKWALLPAPER: u32 = 0x0014;
        const SPIF_UPDATEINIFILE: u32 = 0x01;
        const SPIF_SENDCHANGE: u32 = 0x02;
        #[link(name = "user32")]
        extern "system" {
            fn SystemParametersInfoW(
                action: u32,
                param: u32,
                pv: *mut core::ffi::c_void,
                win_ini: u32,
            ) -> i32;
        }
        if !std::path::Path::new(&path).exists() {
            return Err("Image file not found.".into());
        }
        let wide: Vec<u16> = OsStr::new(&path).encode_wide().chain(std::iter::once(0)).collect();
        let ok = unsafe {
            SystemParametersInfoW(
                SPI_SETDESKWALLPAPER,
                0,
                wide.as_ptr() as *mut core::ffi::c_void,
                SPIF_UPDATEINIFILE | SPIF_SENDCHANGE,
            )
        };
        if ok == 0 {
            return Err("Windows rejected the wallpaper (try a JPG/PNG/BMP).".into());
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = path;
    }
    Ok(())
}

/// Set a desktop wallpaper slideshow from image files (they stay where they are).
/// Uses the user's slideshow settings (interval, fill/fit/stretch, shuffle).
/// Missing values: every 10 minutes, fill, shuffled.
#[tauri::command]
fn set_wallpaper_slideshow(
    paths: Vec<String>,
    interval_minutes: Option<u32>,
    position: Option<String>,
    shuffle: Option<bool>,
) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        // only existing files, zero images would error
        let files: Vec<String> = paths
            .into_iter()
            .filter(|p| std::path::Path::new(p).exists())
            .collect();
        if files.is_empty() {
            return Err("No image files to use as wallpaper.".into());
        }
        // max one day (the tick is ms in a u32)
        let minutes = interval_minutes.unwrap_or(10).clamp(1, 24 * 60);
        let opts = SlideshowOpts {
            tick_ms: minutes * 60 * 1000,
            position: position.unwrap_or_default(),
            shuffle: shuffle.unwrap_or(true),
        };
        // shell + COM on its own STA thread (like props.rs)
        std::thread::scope(|s| {
            s.spawn(|| set_slideshow_sta(&files, &opts)).join().unwrap()
        })?;
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (paths, interval_minutes, position, shuffle);
    }
    Ok(())
}

#[cfg(target_os = "windows")]
struct SlideshowOpts {
    tick_ms: u32,
    /// "fill" (default), "fit" or "stretch"
    position: String,
    shuffle: bool,
}

/// Build an IShellItemArray from the paths and give it to IDesktopWallpaper's slideshow.
/// Runs on its own STA thread.
#[cfg(target_os = "windows")]
fn set_slideshow_sta(files: &[String], opts: &SlideshowOpts) -> Result<(), String> {
    use std::ffi::c_void;
    use windows::core::HSTRING;
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, CLSCTX_ALL,
        COINIT_APARTMENTTHREADED,
    };
    use windows::Win32::UI::Shell::Common::ITEMIDLIST;
    use windows::Win32::UI::Shell::{
        DesktopWallpaper, IDesktopWallpaper, SHCreateShellItemArrayFromIDLists, SHParseDisplayName,
        DESKTOP_SLIDESHOW_OPTIONS, DSO_SHUFFLEIMAGES, DWPOS_FILL, DWPOS_FIT, DWPOS_STRETCH,
    };

    unsafe {
        let hr = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        let run = || -> windows::core::Result<()> {
            // each path -> absolute PIDL
            let mut pidls: Vec<*const ITEMIDLIST> = Vec::with_capacity(files.len());
            for f in files {
                let mut pidl: *mut ITEMIDLIST = std::ptr::null_mut();
                SHParseDisplayName(&HSTRING::from(f.as_str()), None, &mut pidl, 0, None)?;
                if !pidl.is_null() {
                    pidls.push(pidl as *const ITEMIDLIST);
                }
            }
            if pidls.is_empty() {
                return Err(windows::core::Error::from_win32());
            }
            let array = SHCreateShellItemArrayFromIDLists(&pidls);
            // the array copies the PIDLs, so free ours
            for p in &pidls {
                CoTaskMemFree(Some(*p as *const c_void));
            }
            let array = array?;

            let wp: IDesktopWallpaper = CoCreateInstance(&DesktopWallpaper, None, CLSCTX_ALL)?;
            // SetSlideshow sets the images and starts it
            wp.SetSlideshow(&array)?;
            let order = if opts.shuffle {
                DSO_SHUFFLEIMAGES
            } else {
                DESKTOP_SLIDESHOW_OPTIONS(0)
            };
            let _ = wp.SetSlideshowOptions(order, opts.tick_ms);
            let _ = wp.SetPosition(match opts.position.as_str() {
                "fit" => DWPOS_FIT,
                "stretch" => DWPOS_STRETCH,
                _ => DWPOS_FILL,
            });
            Ok(())
        };
        let out = run().map_err(|e| e.message());
        if hr.is_ok() {
            CoUninitialize();
        }
        out
    }
}

/// Normalize a path for comparing (backslashes, no trailing slash, lowercase).
fn norm_path(p: &std::path::Path) -> String {
    p.to_string_lossy()
        .replace('/', "\\")
        .trim_end_matches('\\')
        .to_lowercase()
}

/// Folders cleanup must never delete or go above: every root, the collection root
/// and its MiColl folder.
fn delete_boundaries(conn: &rusqlite::Connection) -> std::collections::HashSet<String> {
    let mut set = std::collections::HashSet::new();
    if let Ok(roots) = db::list_roots(conn) {
        for r in roots {
            set.insert(norm_path(std::path::Path::new(&r.path)));
        }
    }
    if let Ok(Some(root)) = db::get_setting(conn, "collection_root") {
        if !root.trim().is_empty() {
            let base = std::path::Path::new(&root);
            set.insert(norm_path(base));
            set.insert(norm_path(&base.join("MiColl")));
        }
    }
    // the MiSD disk too, otherwise the sweep would eat its folders and marker
    if let Ok(Some(root)) = db::get_setting(conn, "sd_root") {
        if !root.trim().is_empty() {
            let base = std::path::Path::new(&root);
            set.insert(norm_path(base));
            set.insert(norm_path(&base.join(sd::BACKUP_DIR)));
        }
    }
    set
}

/// Send one folder to the recycle bin and report if it worked.
/// It used to ignore errors and remove the rows anyway, so the reward disappeared
/// from MiColl while its files were still on disk. Windows refuses e.g. when the
/// item is bigger than the recycle bin quota.
/// Returns None on success, or Some(message) with the folder and the reason.
fn trash_dir(path: &std::path::Path) -> Option<String> {
    if !path.exists() {
        return None;
    }
    match trash::delete(path) {
        Ok(()) => None,
        Err(e) => Some(format!("{} — {}", path.display(), e)),
    }
}

/// Turn the failures into one message (what stayed and the usual reason).
fn trash_failure_message(failed: &[String]) -> String {
    format!(
        "Couldn't move {} to the Recycle Bin, so {} still in MiColl:\n{}\n\nWindows refuses this \
         when an item is larger than the Recycle Bin's quota for that drive. Empty the Recycle \
         Bin or raise its size (right-click it → Properties), then try again — or delete the \
         folder in Explorer and use \"Remove from MiColl only\".",
        if failed.len() == 1 { "this folder" } else { "these folders" },
        if failed.len() == 1 { "it is" } else { "they are" },
        failed.join("\n"),
    )
}

/// Go up from dir and delete empty folders until a boundary or a non-empty one.
fn prune_empty_dirs(mut dir: std::path::PathBuf, boundaries: &std::collections::HashSet<String>) {
    for _ in 0..16 {
        if boundaries.contains(&norm_path(&dir)) {
            break;
        }
        match std::fs::read_dir(&dir) {
            Ok(mut entries) => {
                if entries.next().is_some() {
                    break; // not empty — keep it (and everything above)
                }
                if trash::delete(&dir).is_err() {
                    break;
                }
                match dir.parent() {
                    Some(p) => dir = p.to_path_buf(),
                    None => break,
                }
            }
            Err(_) => break,
        }
    }
}

/// inner is dir or somewhere below it (both as norm_path keys).
fn is_at_or_below(inner: &str, dir: &str) -> bool {
    inner == dir || inner.starts_with(&format!("{dir}\\"))
}

/// What deleting a reward's files sends to the recycle bin.
#[derive(Debug, PartialEq)]
enum RewardTrash {
    /// the reward's own folder
    Folder(std::path::PathBuf),
    /// only its files: another reward lives in or below its folder (a root reward's
    /// files sit loose in the month folder, next to the other rewards' folders)
    Files(Vec<std::path::PathBuf>),
}

/// Plan the recycle bin step for deleting these rewards' files. Picked by the rewards
/// themselves, never by folder names (deleting "Unsorted" matched every folder called
/// Unsorted, also "Twitter\Unsorted\Gifs"). A folder only goes whole when no reward
/// that stays lives inside it. Template placeholders have no folder.
fn plan_reward_trash(
    conn: &rusqlite::Connection,
    ids: &[i64],
) -> rusqlite::Result<Vec<(i64, RewardTrash)>> {
    let going: std::collections::HashSet<i64> = ids.iter().copied().collect();
    let mut staying: Vec<String> = Vec::new();
    {
        let mut stmt = conn.prepare("SELECT id, folder_path FROM rewards")?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))?;
        for row in rows {
            let (id, folder) = row?;
            if !going.contains(&id) && !folder.contains('\u{1}') {
                staying.push(norm_path(std::path::Path::new(&folder)));
            }
        }
    }
    let mut plan = Vec::new();
    for &id in ids {
        let Some(folder) = db::reward_folder(conn, id)? else { continue };
        if folder.contains('\u{1}') {
            continue;
        }
        let key = norm_path(std::path::Path::new(&folder));
        if staying.iter().any(|s| is_at_or_below(s, &key)) {
            let files = db::image_paths_for_rewards(conn, &[id])?
                .into_iter()
                .map(std::path::PathBuf::from)
                .collect();
            plan.push((id, RewardTrash::Files(files)));
        } else {
            plan.push((id, RewardTrash::Folder(std::path::PathBuf::from(folder))));
        }
    }
    Ok(plan)
}

/// Carry out one planned step. None = done, Some(message) = something stayed on disk.
fn trash_reward(
    item: &RewardTrash,
    boundaries: &std::collections::HashSet<String>,
) -> Option<String> {
    match item {
        RewardTrash::Folder(dir) => {
            if let Some(why) = trash_dir(dir) {
                return Some(why);
            }
            if let Some(parent) = dir.parent() {
                prune_empty_dirs(parent.to_path_buf(), boundaries);
            }
            None
        }
        RewardTrash::Files(files) => {
            let mut failed = Vec::new();
            for f in files.iter().filter(|f| f.exists()) {
                if let Err(e) = trash::delete(f) {
                    failed.push(format!("{} — {}", f.display(), e));
                }
            }
            (!failed.is_empty()).then(|| failed.join("\n"))
        }
    }
}

/// Run a plan, returns (the rewards whose files are gone, messages for the rest).
fn trash_rewards(
    plan: &[(i64, RewardTrash)],
    boundaries: &std::collections::HashSet<String>,
) -> (Vec<i64>, Vec<String>) {
    let (mut done, mut failed) = (Vec::new(), Vec::new());
    for (id, item) in plan {
        match trash_reward(item, boundaries) {
            Some(why) => failed.push(why),
            None => done.push(*id),
        }
    }
    (done, failed)
}

/// A folder that may go to the recycle bin as a whole: no file anywhere inside and not
/// a boundary. A folder with files keeps them whatever its name, they belong to
/// something else (another reward, or something MiColl never indexed).
fn is_empty_tree(dir: &std::path::Path, boundaries: &std::collections::HashSet<String>) -> bool {
    dir.is_dir() && !boundaries.contains(&norm_path(dir)) && !dir_has_files(dir)
}

/// Recycle a folder only when it has no files left, then empty folders above it.
/// Some(message) only when Windows refused.
fn trash_if_empty(
    dir: &std::path::Path,
    boundaries: &std::collections::HashSet<String>,
) -> Option<String> {
    if !is_empty_tree(dir, boundaries) {
        return None;
    }
    if let Some(why) = trash_dir(dir) {
        return Some(why);
    }
    if let Some(parent) = dir.parent() {
        prune_empty_dirs(parent.to_path_buf(), boundaries);
    }
    None
}

/// A rename request from the UI: which item and the new name.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct RenameItem {
    id: i64,
    name: String,
}

/// A free path in parent for stem (+ extension), adds " (2)", " (3)"...
fn unique_path(parent: &std::path::Path, stem: &str, ext: Option<&str>) -> std::path::PathBuf {
    let build = |n: u32| {
        let base = if n == 0 { stem.to_string() } else { format!("{stem} ({n})") };
        match ext {
            Some(e) if !e.is_empty() => parent.join(format!("{base}.{e}")),
            _ => parent.join(base),
        }
    };
    let mut n = 0;
    loop {
        let p = build(n);
        if !p.exists() || n > 9999 {
            return p;
        }
        n += 1;
    }
}

/// Replace the last part of a relative name.
fn replace_last_segment(rel: &str, new_seg: &str) -> String {
    match rel.rfind(['/', '\\']) {
        Some(i) => format!("{}{}", &rel[..=i], new_seg),
        None => new_seg.to_string(),
    }
}

/// Rename reward folders and update the DB. Two phases (all to temp names, then to
/// the final names) so a batch can reuse names other items currently have.
#[tauri::command]
fn rename_rewards(db: State<Db>, items: Vec<RenameItem>) -> Result<(), String> {
    let conn = db.lock().map_err(map_err)?;
    // resolve everything first
    struct Job {
        id: i64,
        old_folder: String,
        parent: std::path::PathBuf,
        cur_title: String,
        final_stem: String,
        final_title: String,
    }
    let mut jobs: Vec<Job> = Vec::new();
    for it in &items {
        let (cur_title, folder) = db::reward_title_folder(&conn, it.id)
            .map_err(map_err)?
            .ok_or("Reward not found.")?;
        let title = it.name.trim().to_string();
        let stem = sanitize_name(&title);
        if stem.is_empty() {
            return Err("Name can’t be empty.".into());
        }
        let parent = std::path::Path::new(&folder)
            .parent()
            .ok_or("Bad reward path.")?
            .to_path_buf();
        jobs.push(Job { id: it.id, old_folder: folder, parent, cur_title, final_stem: stem, final_title: title });
    }
    // phase 1: each folder to a unique temp name
    let mut temps: Vec<(usize, String)> = Vec::new();
    for (i, j) in jobs.iter().enumerate() {
        let temp = j.parent.join(format!("__micoll_tmp_{}", j.id));
        if std::path::Path::new(&j.old_folder).exists() {
            std::fs::rename(&j.old_folder, &temp).map_err(map_err)?;
        }
        db::apply_reward_rename(&conn, j.id, &j.cur_title, &j.old_folder, &temp.to_string_lossy())
            .map_err(map_err)?;
        temps.push((i, temp.to_string_lossy().to_string()));
    }
    // phase 2: each temp to its final name
    let mut finals: Vec<(usize, String)> = Vec::new();
    for (i, temp) in temps {
        let j = &jobs[i];
        let target = unique_path(&j.parent, &j.final_stem, None);
        if std::path::Path::new(&temp).exists() {
            std::fs::rename(&temp, &target).map_err(map_err)?;
        }
        let target_s = target.to_string_lossy().to_string();
        db::apply_reward_rename(&conn, j.id, &j.final_title, &temp, &target_s)
            .map_err(map_err)?;
        finals.push((i, target_s));
    }
    // fix the cover if it points at a missing file now (rebuild it from the renamed
    // folder).
    // a valid custom cover stays
    for (i, target) in &finals {
        let id = jobs[*i].id;
        let cover: Option<String> = conn
            .query_row("SELECT cover_image FROM rewards WHERE id = ?1", rusqlite::params![id], |r| {
                r.get::<_, Option<String>>(0)
            })
            .ok()
            .flatten();
        let stale = cover
            .as_deref()
            .map(|c| !std::path::Path::new(c).exists())
            .unwrap_or(true);
        if stale {
            let (_imgs, derived) = indexer::collect_reward_images(std::path::Path::new(target));
            if let Some(c) = derived {
                db::set_reward_cover(&conn, id, &c).map_err(map_err)?;
            }
        }
    }
    Ok(())
}

/// Rename image files (keeps the extension) and update the DB. Two phases like
/// rename_rewards.
#[tauri::command]
fn rename_images(db: State<Db>, items: Vec<RenameItem>) -> Result<(), String> {
    let conn = db.lock().map_err(map_err)?;
    struct Job {
        id: i64,
        old_path: String,
        old_rel: String,
        parent: std::path::PathBuf,
        ext: Option<String>,
        final_stem: String,
    }
    let mut jobs: Vec<Job> = Vec::new();
    for it in &items {
        let (path, rel, _rid) = db::image_row(&conn, it.id).map_err(map_err)?.ok_or("Image not found.")?;
        let stem = sanitize_name(it.name.trim());
        if stem.is_empty() {
            return Err("Name can’t be empty.".into());
        }
        let p = std::path::Path::new(&path);
        let parent = p.parent().ok_or("Bad image path.")?.to_path_buf();
        let ext = p.extension().map(|e| e.to_string_lossy().to_string());
        jobs.push(Job {
            id: it.id,
            old_path: path.clone(),
            old_rel: rel.unwrap_or_default(),
            parent,
            ext,
            final_stem: stem,
        });
    }
    // phase 1 -> temp
    let mut temps: Vec<(usize, String)> = Vec::new();
    for (i, j) in jobs.iter().enumerate() {
        let temp = j.parent.join(format!("__micoll_tmp_{}", j.id));
        if std::path::Path::new(&j.old_path).exists() {
            std::fs::rename(&j.old_path, &temp).map_err(map_err)?;
        }
        let temp_s = temp.to_string_lossy().to_string();
        let temp_rel = replace_last_segment(&j.old_rel, "__micoll_tmp");
        db::apply_image_rename(&conn, j.id, &j.old_path, &temp_s, &temp_rel).map_err(map_err)?;
        temps.push((i, temp_s));
    }
    // phase 2 -> final
    for (i, temp) in temps {
        let j = &jobs[i];
        let target = unique_path(&j.parent, &j.final_stem, j.ext.as_deref());
        if std::path::Path::new(&temp).exists() {
            std::fs::rename(&temp, &target).map_err(map_err)?;
        }
        let target_s = target.to_string_lossy().to_string();
        let new_rel = replace_last_segment(
            &j.old_rel,
            target.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default().as_str(),
        );
        db::apply_image_rename(&conn, j.id, &temp, &target_s, &new_rel).map_err(map_err)?;
    }
    Ok(())
}

/// Replace characters not allowed in Windows paths.
fn sanitize_name(s: &str) -> String {
    s.chars()
        .map(|c| if "\\/:*?\"<>|".contains(c) { '_' } else { c })
        .collect::<String>()
        .trim()
        .to_string()
}

/// Create a user-made artist: optionally empty folders (Platform[/Year/01..12]),
/// a preview image and the release style.
/// Only "monthly" gets year/month folders, numbered and none stop at the platform.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
fn create_artist(
    app: AppHandle,
    db: State<Db>,
    name: String,
    preview: Option<String>,
    base_dir: Option<String>,
    platforms: Vec<String>,
    years: Vec<i64>,
    months: bool,
    release_style: Option<String>,
    kind: Option<String>,
) -> Result<(), String> {
    let conn = db.lock().map_err(map_err)?;
    let clean = sanitize_name(&name);
    if clean.is_empty() {
        return Err("Artist name is required.".into());
    }
    let style = release_style.as_deref().unwrap_or("monthly");
    if !db::RELEASE_STYLES.contains(&style) {
        return Err(format!("Unknown release style '{style}'."));
    }
    let dated = style == "monthly";
    let no_dates = style == "none";

    // where to create folders (if at all)
    let managed = db::get_setting(&conn, "managed_enabled")
        .map_err(map_err)?
        .as_deref()
        == Some("true");
    let collection = db::get_setting(&conn, "collection_root")
        .map_err(map_err)?
        .filter(|s| !s.trim().is_empty());

    let base: Option<std::path::PathBuf> = if let Some(b) =
        base_dir.as_ref().filter(|s| !s.trim().is_empty())
    {
        Some(std::path::Path::new(b).join(&clean))
    } else if managed {
        collection
            .as_ref()
            .map(|c| std::path::Path::new(c).join("MiColl").join(&clean))
    } else {
        None
    };

    if let Some(base) = base.as_ref() {
        if platforms.is_empty() {
            let _ = std::fs::create_dir_all(base);
        }
        for p in &platforms {
            let pdir = base.join(sanitize_name(p));
            if !dated || years.is_empty() {
                let _ = std::fs::create_dir_all(&pdir);
            } else {
                for y in &years {
                    let ydir = pdir.join(y.to_string());
                    if months {
                        for m in 1..=12 {
                            let _ = std::fs::create_dir_all(ydir.join(format!("{:02}", m)));
                        }
                    } else {
                        let _ = std::fs::create_dir_all(&ydir);
                    }
                }
            }
        }
        // register the folder so later content gets indexed
        let _ = db::add_root(&conn, &base.to_string_lossy(), Some(&clean), None);
        allow_asset_dir(&app, &base.to_string_lossy());
    }

    let artist_id =
        db::create_artist(&conn, &clean, preview.as_deref(), no_dates).map_err(map_err)?;
    // create_artist only knows the old flag, set the style too ("numbered" needs it)
    db::set_artist_release_style_by_id(&conn, artist_id, style).map_err(map_err)?;

    // optional creator types (comma separated kind)
    if let Some(k) = kind.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        let _ = db::set_artist_kind(&conn, artist_id, Some(k));
    }

    // a platform only exists through its periods, so create the periods for the
    // folders: the chosen years/months for monthly, one "Misc" otherwise.
    // Same keys as the indexer, so content dropped in later merges in.
    let seed = |plat: &str, year: Option<i64>, month: Option<i64>| {
        let key = indexer::period_key(&clean, Some(plat), year, month, None);
        let label = match year {
            Some(y) => indexer::fmt_label(y, month),
            None => "Misc".to_string(),
        };
        indexer::upsert_period(&conn, artist_id, Some(plat), year, month, None, &label, &key, false)
            .map(|_| ())
    };
    for p in &platforms {
        let p = p.as_str();
        if dated && !years.is_empty() {
            for &y in &years {
                if months {
                    for m in 1..=12 {
                        seed(p, Some(y), Some(m)).map_err(map_err)?;
                    }
                } else {
                    seed(p, Some(y), None).map_err(map_err)?;
                }
            }
        } else {
            seed(p, None, None).map_err(map_err)?;
        }
    }
    Ok(())
}

/// Put loose dropped files (single image/video) into a temp reward folder for the import.
/// Returns the folder, or None if nothing needed that (folder/archive dropped).
#[tauri::command]
async fn stage_files_for_import(
    db: State<'_, Db>,
    paths: Vec<String>,
) -> Result<Option<String>, String> {
    // read the managed setting here, the frontend doesn't know it yet at this point
    let managed = {
        let conn = db.lock().map_err(map_err)?;
        managed_collection(&conn)
    };
    tauri::async_runtime::spawn_blocking(move || -> Result<Option<String>, String> {
        let is_archive = |p: &std::path::Path| {
            matches!(
                p.extension().and_then(|e| e.to_str()).map(|e| e.to_lowercase()).as_deref(),
                Some("zip") | Some("rar") | Some("7z")
            )
        };
        // only loose files, folders/archives go the normal way
        let files: Vec<std::path::PathBuf> = paths
            .iter()
            .map(std::path::PathBuf::from)
            .filter(|p| p.is_file() && !is_archive(p))
            .collect();
        if files.is_empty() {
            return Ok(None);
        }
        // folder name: the file's name, else a generic one (can be renamed in the review)
        let reward = if files.len() == 1 {
            files[0]
                .file_stem()
                .map(|s| sanitize_name(&s.to_string_lossy()))
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| "New reward".to_string())
        } else {
            "New reward".to_string()
        };
        // unmanaged: put the new reward folder next to the dropped files (not %TEMP%,
        // Windows empties that). The files are MOVED, so there's one copy.
        // Managed mode (and when there's no single source folder) still uses %TEMP%.
        if !managed {
            if let Some(parent) = common_parent(&files) {
                if let Some(dir) = stage_beside_source(&parent, &reward, &files) {
                    return Ok(Some(dir.to_string_lossy().to_string()));
                }
            }
        }
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir()
            .join(format!("micoll-import-{stamp}"))
            .join(&reward);
        std::fs::create_dir_all(&dir).map_err(map_err)?;
        for f in &files {
            if let Some(fname) = f.file_name() {
                let dest = unique_dest(&dir, fname);
                std::fs::copy(f, &dest).map_err(map_err)?;
            }
        }
        Ok(Some(dir.to_string_lossy().to_string()))
    })
    .await
    .map_err(map_err)?
}

/// Read-only: look at a folder and suggest a structure (no DB writes).
#[tauri::command]
async fn analyze_import(db: State<'_, Db>, path: String) -> Result<ImportPlan, String> {
    // load the library's platform names first (see indexer::refresh_known_platforms)
    {
        let conn = db.lock().map_err(map_err)?;
        indexer::refresh_known_platforms(&conn).map_err(map_err)?;
    }
    tauri::async_runtime::spawn_blocking(move || indexer::analyze(&path))
        .await
        .map_err(|e| e.to_string())
}

/// An incoming reward whose name already exists in that period.
/// Without asking, organize would merge the folders and fail the UNIQUE index,
/// leaving the new card pointing at a deleted folder.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ImportClash {
    /// Source folder of the incoming row.
    folder: String,
    /// The name both have.
    title: String,
    /// The existing reward (merge target).
    reward_id: i64,
    /// Where its files are now.
    existing_folder: String,
    /// Shelf like "Nora · Patreon · 2026-03".
    location: String,
}

/// Name for the clash check (case-insensitive, trimmed).
fn clash_key(s: &str) -> String {
    s.trim().to_lowercase()
}

/// Check an import BEFORE writing: which rows would land on an existing reward name.
#[tauri::command]
fn import_clashes(
    db: State<Db>,
    rewards: Vec<indexer::ResolvedReward>,
) -> Result<Vec<ImportClash>, String> {
    let conn = db.lock().map_err(map_err)?;
    let mut out = Vec::new();
    for r in &rewards {
        // root rows have no own folder, so no name to clash
        if r.root {
            continue;
        }
        let key = indexer::period_key(&r.artist, r.platform.as_deref(), r.year, r.month, r.number);
        let Some(period_id) = db::period_id_by_key(&conn, &key).map_err(map_err)? else {
            continue; // brand-new period: nothing can be in it yet
        };
        let want = clash_key(&r.title);
        let want_cat = r.category.as_deref().map(clash_key);
        let mut stmt = conn
            .prepare(
                "SELECT r.id, r.title, r.folder_path, r.category, p.label
                   FROM rewards r
                   JOIN periods p ON p.id = r.period_id
                  WHERE r.period_id = ?1 AND r.status <> 'missing'",
            )
            .map_err(map_err)?;
        let rows = stmt
            .query_map(rusqlite::params![period_id], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, String>(4)?,
                ))
            })
            .map_err(map_err)?;
        for row in rows {
            let (id, title, folder_path, category, label) = row.map_err(map_err)?;
            // re-importing the same folder is an update, not a clash
            if clash_key(&folder_path) == clash_key(&r.folder) {
                continue;
            }
            // different categories get different folders, no clash
            if category.as_deref().map(clash_key) != want_cat {
                continue;
            }
            // the title or the folder name being taken counts (they can differ after a
            // rename)
            let taken = clash_key(&title) == want
                || std::path::Path::new(&folder_path)
                    .file_name()
                    .map(|n| clash_key(&n.to_string_lossy()) == want)
                    .unwrap_or(false);
            if !taken {
                continue;
            }
            out.push(ImportClash {
                folder: r.folder.clone(),
                title: r.title.clone(),
                reward_id: id,
                existing_folder: folder_path,
                location: format!(
                    "{} · {} · {}",
                    r.artist,
                    r.platform.as_deref().unwrap_or("Unsorted"),
                    label
                ),
            });
            break; // one warning per incoming row
        }
    }
    Ok(out)
}

/// A release style choice from the import review (artist, or one platform if set).
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct StyleChoice {
    artist: String,
    /// "monthly" | "numbered" | "none"
    style: String,
    platform: Option<String>,
}

/// Commit an import: write the rewards and remember the source.
#[tauri::command]
fn commit_import(
    app: AppHandle,
    db: State<Db>,
    rewards: Vec<ResolvedReward>,
    source: String,
    styles: Option<Vec<StyleChoice>>,
    open_as_cards: Option<bool>,
) -> Result<ScanSummary, String> {
    let conn = db.lock().map_err(map_err)?;
    let summary = indexer::commit(&conn, &rewards, open_as_cards).map_err(map_err)?;
    // an import is on purpose, so everything gets the "new" badge (also known folders)
    let folders: Vec<String> = rewards.iter().map(|r| r.folder.clone()).collect();
    db::mark_rewards_fresh(&conn, &folders).map_err(map_err)?;
    // the review's "Extra" toggle
    let extras: Vec<String> =
        rewards.iter().filter(|r| r.extra).map(|r| r.folder.clone()).collect();
    db::mark_rewards_extra(&conn, &extras).map_err(map_err)?;
    // update "last edited" of every touched artist
    {
        let mut seen = std::collections::HashSet::new();
        for r in &rewards {
            if seen.insert(r.artist.as_str()) {
                let _ = db::touch_artist_by_name(&conn, &r.artist);
            }
        }
    }
    // save each creator's release style (after commit, so new artists exist)
    for choice in styles.unwrap_or_default() {
        match &choice.platform {
            Some(p) => {
                if let Ok(Some(artist_id)) = db::artist_id_by_name(&conn, &choice.artist) {
                    let _ = db::set_platform_release_style(&conn, artist_id, p, &choice.style);
                }
            }
            None => {
                let _ = db::set_artist_release_style(&conn, &choice.artist, &choice.style);
            }
        }
    }
    // remember the source folder, but never a staging folder (it gets deleted and
    // would show as missing in health). Asset access is granted either way.
    if staging_dir_of(&source).is_none() {
        let _ = db::add_root(&conn, &source, None, None);
    }
    // committed: this folder is library content now
    forget_staged(std::path::Path::new(&source));
    // flush to disk right away
    db::checkpoint(&conn);
    allow_asset_dir(&app, &source);
    Ok(summary)
}

#[tauri::command]
fn organize_collection(app: AppHandle, db: State<Db>) -> Result<OrganizeSummary, String> {
    let conn = db.lock().map_err(map_err)?;
    let enabled = db::get_setting(&conn, "managed_enabled")
        .map_err(map_err)?
        .as_deref()
        == Some("true");
    if !enabled {
        return Err("Managed library is turned off.".into());
    }
    let root = db::get_setting(&conn, "collection_root")
        .map_err(map_err)?
        .filter(|s| !s.trim().is_empty())
        .ok_or("No collection folder is set.")?;
    let summary = organize::organize_collection(&conn, &root)?;
    // organize changes a lot, flush it
    db::checkpoint(&conn);
    allow_asset_dir(&app, &root);
    Ok(summary)
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct MoveCollectionSummary {
    /// Was an existing MiColl folder moved?
    moved: bool,
    /// How many image paths were updated.
    images: u32,
    /// The new collection root.
    new_root: String,
}

/// Move the WHOLE managed collection to a new root (<old>/MiColl -> <new>/MiColl),
/// update all paths and save collection_root. Without an existing folder it just
/// saves the setting. Different from organize_collection.
#[tauri::command]
fn move_collection(app: AppHandle, db: State<Db>, new_root: String) -> Result<MoveCollectionSummary, String> {
    let new_root = new_root.trim().to_string();
    if new_root.is_empty() {
        return Err("Pick a destination folder.".into());
    }
    let conn = db.lock().map_err(map_err)?;
    let old_root = db::get_setting(&conn, "collection_root")
        .map_err(map_err)?
        .filter(|s| !s.trim().is_empty());

    let new_managed = std::path::Path::new(&new_root).join("MiColl");

    // no old collection -> just save the new root
    let old_managed = match &old_root {
        Some(r) => std::path::Path::new(r).join("MiColl"),
        None => {
            db::set_setting(&conn, "collection_root", &new_root).map_err(map_err)?;
            return Ok(MoveCollectionSummary { moved: false, images: 0, new_root });
        }
    };

    // same place or nothing to move -> just update the setting
    if old_managed == new_managed || !old_managed.is_dir() {
        db::set_setting(&conn, "collection_root", &new_root).map_err(map_err)?;
        return Ok(MoveCollectionSummary { moved: false, images: 0, new_root });
    }

    // don't overwrite an existing collection at the target
    if new_managed.exists() {
        return Err(format!(
            "A MiColl folder already exists at {}. Pick an empty location (or merge the two folders yourself first).",
            new_managed.display()
        ));
    }

    // move the whole folder at once
    if let Some(parent) = new_managed.parent() {
        std::fs::create_dir_all(parent).map_err(map_err)?;
    }
    move_tree(&old_managed, &new_managed).map_err(map_err)?;

    // update all paths under the old root
    let old_prefix = old_managed.to_string_lossy().to_string();
    let new_prefix = new_managed.to_string_lossy().to_string();
    let images = db::relink_prefix(&conn, &old_prefix, &new_prefix).map_err(map_err)?;

    // sd_origin is a local folder too, so update it here
    // (relink_prefix doesn't touch it, it also runs during transports)
    conn.execute(
        "UPDATE rewards SET sd_origin = ?2 || substr(sd_origin, length(?1)+1) \
         WHERE substr(sd_origin,1,length(?1)) = ?1",
        rusqlite::params![&old_prefix, &new_prefix],
    )
    .map_err(map_err)?;

    db::set_setting(&conn, "collection_root", &new_root).map_err(map_err)?;
    allow_asset_dir(&app, &new_managed.to_string_lossy());
    Ok(MoveCollectionSummary { moved: true, images, new_root })
}

/// Cached thumbnail as base64 data URL.
#[tauri::command]
async fn get_thumbnail(
    app: AppHandle,
    dek: State<'_, DekState>,
    src: String,
    size: Option<u32>,
) -> Result<String, String> {
    let cache = app_cache(&app)?.join("thumbs");
    let size = size.unwrap_or(512);
    let key = session_key(&dek);
    // decoding is CPU heavy, run it on the blocking pool
    tauri::async_runtime::spawn_blocking(move || thumbs::thumb_data_url(&cache, &src, size, key))
        .await
        .map_err(|e| e.to_string())?
}

/// Open a folder in Explorer (showing its contents).
fn open_dir(path: &std::path::Path) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(path)
            .spawn()
            .map_err(map_err)?;
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = path;
    }
    Ok(())
}

/// Open Explorer with the file/folder selected.
#[tauri::command]
fn show_in_explorer(path: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        std::process::Command::new("explorer")
            .raw_arg(format!("/select,\"{}\"", path.replace('/', "\\")))
            .spawn()
            .map_err(map_err)?;
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = path; // reveal not implemented for this OS
    }
    Ok(())
}

/// Open a file with its default app (Photoshop for PSD, PDF reader for PDF...).
/// For the files MiColl can't show itself.
#[tauri::command]
fn open_with_default(app: AppHandle, path: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    if !std::path::Path::new(&path).is_file() {
        return Err(format!("{path} is not there any more."));
    }
    app.opener().open_path(path, None::<&str>).map_err(map_err)
}

/// Open an artist's own folder (e.g. ...\MiColl\Nora). Taken from a reward path
/// (cut at the artist name), else the managed collection path.
#[tauri::command]
fn reveal_artist(db: State<Db>, artist_id: i64) -> Result<(), String> {
    let conn = db.lock().map_err(map_err)?;
    let (name, _) = db::artist_info(&conn, artist_id)
        .map_err(map_err)?
        .ok_or("Artist not found.")?;
    let target = sanitize_name(&name).to_lowercase();

    // cut any reward path at the artist name segment
    let mut dir: Option<std::path::PathBuf> = None;
    for f in db::artist_reward_folders(&conn, artist_id).map_err(map_err)? {
        let parts: Vec<&str> = f.split(['\\', '/']).filter(|s| !s.is_empty()).collect();
        if let Some(idx) = parts.iter().rposition(|s| s.to_lowercase() == target) {
            dir = Some(std::path::PathBuf::from(parts[..=idx].join("\\")));
            break;
        }
    }
    // empty artists: the managed collection location
    if dir.is_none() {
        let managed = db::get_setting(&conn, "managed_enabled")
            .map_err(map_err)?
            .as_deref()
            == Some("true");
        if managed {
            dir = db::get_setting(&conn, "collection_root")
                .map_err(map_err)?
                .filter(|s| !s.trim().is_empty())
                .map(|c| managed_artist_dir(&conn, &c, &name));
        }
    }

    match dir {
        Some(d) if d.exists() => open_dir(&d),
        _ => Err("Couldn't find this artist's folder on disk.".into()),
    }
}

/// The creator's folder, from a reward path (same casing as the stored paths)
/// or the managed layout. Like reveal_artist.
fn artist_dir_on_disk(
    conn: &rusqlite::Connection,
    artist_id: i64,
    name: &str,
) -> Option<std::path::PathBuf> {
    let target = sanitize_name(name).to_lowercase();
    for f in db::artist_reward_folders(conn, artist_id).ok()? {
        let parts: Vec<&str> = f.split(['\\', '/']).filter(|s| !s.is_empty()).collect();
        if let Some(idx) = parts.iter().rposition(|s| s.to_lowercase() == target) {
            return Some(std::path::PathBuf::from(parts[..=idx].join("\\")));
        }
    }
    // creators without files on disk yet: the managed location
    let managed =
        db::get_setting(conn, "managed_enabled").ok().flatten().as_deref() == Some("true");
    if managed {
        return db::get_setting(conn, "collection_root")
            .ok()
            .flatten()
            .filter(|s| !s.trim().is_empty())
            .map(|c| managed_artist_dir(&conn, &c, name));
    }
    None
}

/// Rename a creator. In managed mode the folder is renamed too and all paths updated.
/// Refuses a name another creator uses.
#[tauri::command]
fn rename_artist(
    app: AppHandle,
    db: State<Db>,
    artist_id: i64,
    new_name: String,
) -> Result<(), String> {
    let new_name = new_name.trim().to_string();
    if new_name.is_empty() {
        return Err("Enter a name.".into());
    }
    let conn = db.lock().map_err(map_err)?;
    let (old_name, _) = db::artist_info(&conn, artist_id)
        .map_err(map_err)?
        .ok_or("Creator not found.")?;
    if old_name == new_name {
        return Ok(()); // nothing changed
    }
    // only block if a DIFFERENT creator has the name (case changes are fine)
    if db::artist_name_taken(&conn, &new_name, artist_id).map_err(map_err)? {
        return Err(format!("A creator named “{new_name}” already exists."));
    }

    // rename the folder and update paths if we can find it
    if let Some(old_dir) = artist_dir_on_disk(&conn, artist_id, &old_name) {
        if old_dir.is_dir() {
            let new_dir = old_dir
                .parent()
                .map(|p| p.join(sanitize_name(&new_name)))
                .ok_or("Couldn't resolve the new folder path.")?;
            let old_s = old_dir.to_string_lossy().to_string();
            let new_s = new_dir.to_string_lossy().to_string();
            // case-only rename is the same folder on Windows, that's fine
            let case_only =
                old_s.to_lowercase().replace('/', "\\") == new_s.to_lowercase().replace('/', "\\");
            if !case_only && new_dir.exists() {
                return Err(format!(
                    "A folder already exists at {}. Rename or remove it first.",
                    new_dir.display()
                ));
            }
            if old_s != new_s {
                move_tree(&old_dir, &new_dir).map_err(map_err)?;
                db::relink_prefix(&conn, &old_s, &new_s).map_err(map_err)?;
                allow_asset_dir(&app, &new_s);
            }
        }
    }

    db::rename_artist(&conn, artist_id, &new_name).map_err(map_err)?;
    db::checkpoint(&conn);
    Ok(())
}

/// Delete one platform of an artist, optionally trashing its folder.
#[tauri::command]
async fn delete_platform(
    db: State<'_, Db>,
    artist_id: i64,
    platform: String,
    also_files: bool,
) -> Result<(), String> {
    let conn = db.lock().map_err(map_err)?;
    let name = db::artist_info(&conn, artist_id).map_err(map_err)?.map(|(n, _)| n);

    let mut failed: Vec<String> = Vec::new();
    if also_files {
        let boundaries = delete_boundaries(&conn);
        // this platform's rewards as the library files them
        let ids = db::platform_reward_ids(&conn, artist_id, platform.trim()).map_err(map_err)?;
        let plan = plan_reward_trash(&conn, &ids).map_err(map_err)?;
        let (done, trash_failed) = trash_rewards(&plan, &boundaries);
        if !trash_failed.is_empty() {
            db::delete_rewards(&conn, &done).map_err(map_err)?;
            return Err(trash_failure_message(&trash_failed));
        }
        // the platform folder itself only when nothing is left in it
        if let Some(name) = &name {
            let managed = db::get_setting(&conn, "managed_enabled")
                .map_err(map_err)?
                .as_deref()
                == Some("true");
            let base: Option<std::path::PathBuf> = if managed {
                db::get_setting(&conn, "collection_root")
                    .map_err(map_err)?
                    .filter(|s| !s.trim().is_empty())
                    .map(|c| managed_artist_dir(&conn, &c, name))
            } else {
                db::list_roots(&conn)
                    .ok()
                    .and_then(|rs| rs.into_iter().find(|r| r.label.as_deref() == Some(name.as_str())))
                    .map(|r| std::path::PathBuf::from(r.path))
            };
            if let Some(base) = base {
                let pdir = base.join(sanitize_name(&platform));
                if let Some(why) = trash_if_empty(&pdir, &boundaries) {
                    failed.push(why);
                }
            }
        }
    }

    if !failed.is_empty() {
        return Err(trash_failure_message(&failed));
    }
    db::delete_artist_platform(&conn, artist_id, platform.trim()).map_err(map_err)
}

/// Delete rewards (one, a month or an artist), optionally to the recycle bin.
/// async so it doesn't freeze the main thread.
#[tauri::command]
async fn delete_rewards(
    db: State<'_, Db>,
    reward_ids: Vec<i64>,
    also_files: bool,
) -> Result<(), String> {
    let conn = db.lock().map_err(map_err)?;
    // trash the edit versions of these images first
    let orig_paths = db::image_paths_for_rewards(&conn, &reward_ids).map_err(map_err)?;
    for f in db::version_files_for_orig_paths(&conn, &orig_paths).map_err(map_err)? {
        let vp = std::path::PathBuf::from(&f);
        if vp.exists() {
            let _ = trash::delete(&vp);
        }
    }
    // only rewards whose files really left the disk leave the library
    let mut removable = reward_ids.clone();
    let mut failed: Vec<String> = Vec::new();
    if also_files {
        let boundaries = delete_boundaries(&conn);
        let plan = plan_reward_trash(&conn, &reward_ids).map_err(map_err)?;
        for (id, item) in &plan {
            if let Some(why) = trash_reward(item, &boundaries) {
                failed.push(why);
                removable.retain(|r| r != id);
            }
        }
    }
    if !removable.is_empty() {
        db::delete_rewards(&conn, &removable).map_err(map_err)?;
    }
    if failed.is_empty() {
        Ok(())
    } else {
        Err(trash_failure_message(&failed))
    }
}

/// Delete an artist, optionally trashing its folders. Also for empty artists.
#[tauri::command]
async fn delete_artist(
    app: AppHandle,
    db: State<'_, Db>,
    artist_id: i64,
    also_files: bool,
) -> Result<(), String> {
    let conn = db.lock().map_err(map_err)?;
    let name = db::artist_info(&conn, artist_id).map_err(map_err)?.map(|(n, _)| n);

    // trash the artist's edit versions first
    let orig_paths = db::image_paths_for_artist(&conn, artist_id).map_err(map_err)?;
    for f in db::version_files_for_orig_paths(&conn, &orig_paths).map_err(map_err)? {
        let vp = std::path::PathBuf::from(&f);
        if vp.exists() {
            let _ = trash::delete(&vp);
        }
    }

    // the artist's roots aren't boundaries for its own folders, but the rows
    // only go once the files are really gone
    let own_roots: Vec<i64> = match (&name, db::list_roots(&conn)) {
        (Some(name), Ok(roots)) => roots
            .iter()
            .filter(|r| r.label.as_deref() == Some(name.as_str()))
            .map(|r| r.id)
            .collect(),
        _ => Vec::new(),
    };
    let own_root_paths: Vec<String> = match (&name, db::list_roots(&conn)) {
        (Some(name), Ok(roots)) => roots
            .iter()
            .filter(|r| r.label.as_deref() == Some(name.as_str()))
            .map(|r| norm_path(std::path::Path::new(&r.path)))
            .collect(),
        _ => Vec::new(),
    };

    let mut failed: Vec<String> = Vec::new();
    if also_files {
        let mut boundaries = delete_boundaries(&conn);
        for p in &own_root_paths {
            boundaries.remove(p);
        }
        // another creator's reward inside one of these folders keeps its files
        let ids = db::artist_reward_ids(&conn, artist_id).map_err(map_err)?;
        let plan = plan_reward_trash(&conn, &ids).map_err(map_err)?;
        failed.extend(trash_rewards(&plan, &boundaries).1);
        // also trash the artist's base folder
        if let Some(name) = &name {
            let managed = db::get_setting(&conn, "managed_enabled")
                .map_err(map_err)?
                .as_deref()
                == Some("true");
            let base: Option<std::path::PathBuf> = if managed {
                db::get_setting(&conn, "collection_root")
                    .map_err(map_err)?
                    .filter(|s| !s.trim().is_empty())
                    .map(|c| managed_artist_dir(&conn, &c, name))
            } else {
                None
            };
            if let Some(base) = base {
                if !boundaries.contains(&norm_path(&base)) {
                    if let Some(why) = trash_dir(&base) {
                        failed.push(why);
                    }
                }
                if let Some(parent) = base.parent() {
                    prune_empty_dirs(parent.to_path_buf(), &boundaries);
                }
            }
        }
    }

    // anything still on disk keeps the creator in MiColl
    if !failed.is_empty() {
        return Err(trash_failure_message(&failed));
    }
    for id in own_roots {
        let _ = db::remove_root(&conn, id);
    }
    db::delete_artist(&conn, artist_id).map_err(map_err)
}

/// Add a platform to an artist: create its folder and an empty period so it shows
/// as a tab right away. Marks the artist manual.
#[tauri::command]
fn add_artist_platform(
    app: AppHandle,
    db: State<Db>,
    artist_id: i64,
    platform: String,
) -> Result<(), String> {
    let conn = db.lock().map_err(map_err)?;
    let (name, _no_dates) = db::artist_info(&conn, artist_id)
        .map_err(map_err)?
        .ok_or("Artist not found.")?;
    let platform = platform.trim();
    if platform.is_empty() {
        return Err("Platform name is required.".into());
    }

    // the artist's base folder (collection or an existing root)
    let managed = db::get_setting(&conn, "managed_enabled")
        .map_err(map_err)?
        .as_deref()
        == Some("true");
    let base: Option<std::path::PathBuf> = if managed {
        db::get_setting(&conn, "collection_root")
            .map_err(map_err)?
            .filter(|s| !s.trim().is_empty())
            .map(|c| managed_artist_dir(&conn, &c, &name))
    } else {
        db::list_roots(&conn)
            .ok()
            .and_then(|rs| rs.into_iter().find(|r| r.label.as_deref() == Some(name.as_str())))
            .map(|r| std::path::PathBuf::from(r.path))
    };

    if let Some(base) = base.as_ref() {
        let _ = std::fs::create_dir_all(base.join(sanitize_name(platform)));
        let _ = db::add_root(&conn, &base.to_string_lossy(), Some(&name), None);
        allow_asset_dir(&app, &base.to_string_lossy());
    }

    // empty period so the tab shows, same key as the indexer
    db::set_artist_manual(&conn, artist_id, true).map_err(map_err)?;
    let key = indexer::period_key(&name, Some(platform), None, None, None);
    indexer::upsert_period(&conn, artist_id, Some(platform), None, None, None, "Misc", &key, false)
        .map_err(map_err)?;
    Ok(())
}

/// Delete one image, optionally trashing the file.
#[tauri::command]
fn delete_image(db: State<Db>, image_id: i64, also_files: bool) -> Result<(), String> {
    let conn = db.lock().map_err(map_err)?;
    if let Some(p) = db::image_path(&conn, image_id).map_err(map_err)? {
        if also_files && std::path::Path::new(&p).exists() {
            let _ = trash::delete(&p);
        }
        // always trash its edit versions
        for f in db::version_files_for_orig_paths(&conn, &[p]).map_err(map_err)? {
            let vp = std::path::PathBuf::from(&f);
            if vp.exists() {
                let _ = trash::delete(&vp);
            }
        }
    }
    db::delete_image(&conn, image_id).map_err(map_err)
}

/// Delete several images at once (viewer selection), under one DB lock.
#[tauri::command]
fn delete_images(db: State<Db>, image_ids: Vec<i64>, also_files: bool) -> Result<(), String> {
    let conn = db.lock().map_err(map_err)?;
    for image_id in image_ids {
        if let Some(p) = db::image_path(&conn, image_id).map_err(map_err)? {
            if also_files && std::path::Path::new(&p).exists() {
                let _ = trash::delete(&p);
            }
            for f in db::version_files_for_orig_paths(&conn, &[p]).map_err(map_err)? {
                let vp = std::path::PathBuf::from(&f);
                if vp.exists() {
                    let _ = trash::delete(&vp);
                }
            }
        }
        db::delete_image(&conn, image_id).map_err(map_err)?;
    }
    Ok(())
}

/// Full size original image as base64 data URL.
#[tauri::command]
async fn read_image(dek: State<'_, DekState>, src: String) -> Result<String, String> {
    let key = session_key(&dek);
    tauri::async_runtime::spawn_blocking(move || thumbs::image_data_url(&src, key))
        .await
        .map_err(|e| e.to_string())?
}

/* ---- archive extraction (zip / rar) ---------------------------------- */

/// Extract a dropped .zip/.rar/.7z and return a folder to import.
/// If everything is in one top folder, that folder is returned.
/// permanent = the folder becomes library content (then in an unmanaged library it's
/// extracted next to the archive instead of into the app cache).
#[tauri::command]
async fn extract_archive(
    app: AppHandle,
    db: State<'_, Db>,
    path: String,
    permanent: Option<bool>,
) -> Result<String, String> {
    let managed = {
        let conn = db.lock().map_err(map_err)?;
        managed_collection(&conn)
    };
    let cache = app_cache(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let beside = (permanent == Some(true) && !managed)
            .then(|| std::path::Path::new(&path).parent().map(|p| p.to_path_buf()))
            .flatten();
        extract_archive_blocking(&cache, &path, beside.as_deref())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Send a file or folder to the recycle bin.
#[tauri::command]
fn trash_path(path: String) -> Result<(), String> {
    if std::path::Path::new(&path).exists() {
        trash::delete(&path).map_err(map_err)?;
    }
    Ok(())
}

/// beside = Some(dir) extracts into dir, None into the app cache.
/// if beside fails, fall back to the cache
fn extract_archive_blocking(
    cache: &std::path::Path,
    path: &str,
    beside: Option<&std::path::Path>,
) -> Result<String, String> {
    let p = std::path::Path::new(path);
    let stem = p.file_stem().and_then(|s| s.to_str()).unwrap_or("archive");
    let dest = match beside {
        // the archive name is fine, just avoid a clash with a neighbour
        Some(parent) => unique_dir(parent, &sanitize_name(stem)),
        // a unique parent with a child named like the archive, so the reward name is clean
        None => {
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0);
            cache.join("extracted").join(nanos.to_string()).join(sanitize_name(stem))
        }
    };
    if let Err(e) = std::fs::create_dir_all(&dest) {
        if beside.is_some() {
            return extract_archive_blocking(cache, path, None);
        }
        return Err(map_err(e));
    }

    let lower = path.to_lowercase();
    let extracted = if lower.ends_with(".zip") {
        extract_zip(p, &dest)
    } else if lower.ends_with(".rar") {
        extract_rar(p, &dest)
    } else if lower.ends_with(".7z") {
        sevenz_rust::decompress_file(p, &dest).map_err(|e| format!("7z extract: {e}"))
    } else {
        return Err("Unsupported archive — only .zip, .rar and .7z are supported.".into());
    };
    if let Err(e) = extracted {
        // don't leave a half extracted folder behind
        if beside.is_some() {
            let _ = std::fs::remove_dir_all(&dest);
        }
        return Err(e);
    }
    if beside.is_some() {
        remember_staged(&dest, Staged::Unpacked);
    }
    Ok(descend_single(&dest).to_string_lossy().to_string())
}

fn extract_zip(path: &std::path::Path, dest: &std::path::Path) -> Result<(), String> {
    let file = std::fs::File::open(path).map_err(|e| format!("open {}: {e}", path.display()))?;
    let mut zip = zip::ZipArchive::new(file).map_err(|e| format!("read zip: {e}"))?;
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i).map_err(|e| format!("zip entry {i}: {e}"))?;
        // enclosed_name strips .. and absolute parts (zip-slip safe)
        let rel = match entry.enclosed_name() {
            Some(p) => p.to_path_buf(),
            None => continue,
        };
        let out = dest.join(rel);
        if entry.is_dir() {
            std::fs::create_dir_all(&out).map_err(map_err)?;
        } else {
            if let Some(parent) = out.parent() {
                std::fs::create_dir_all(parent).map_err(map_err)?;
            }
            let mut w = std::fs::File::create(&out).map_err(map_err)?;
            std::io::copy(&mut entry, &mut w).map_err(map_err)?;
        }
    }
    Ok(())
}

fn extract_rar(path: &std::path::Path, dest: &std::path::Path) -> Result<(), String> {
    let mut archive = unrar::Archive::new(path)
        .open_for_processing()
        .map_err(|e| format!("open rar: {e}"))?;
    while let Some(header) = archive.read_header().map_err(|e| format!("rar header: {e}"))? {
        archive = if header.entry().is_file() {
            header
                .extract_with_base(dest)
                .map_err(|e| format!("rar extract: {e}"))?
        } else {
            header.skip().map_err(|e| format!("rar skip: {e}"))?
        };
    }
    Ok(())
}

/// If dir has exactly one entry and it's a folder, return it.
fn descend_single(dir: &std::path::Path) -> std::path::PathBuf {
    if let Ok(rd) = std::fs::read_dir(dir) {
        let entries: Vec<_> = rd.filter_map(|e| e.ok()).collect();
        if entries.len() == 1 {
            let only = entries[0].path();
            if only.is_dir() {
                return only;
            }
        }
    }
    dir.to_path_buf()
}

/* ---- image editing (object remover + crop) --------------------------- */

/// Erase the masked area with the classic fill (no AI).
/// image_b64 = current image, mask_b64 = PNG with the painted area.
/// Returns a PNG data URL. Runs on the blocking pool.
#[tauri::command]
async fn edit_inpaint(image_b64: String, mask_b64: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut img = edit::decode_rgba(&image_b64)?;
        let mask = edit::decode_mask(&mask_b64, img.width(), img.height())?;
        edit::remove_region(&mut img, &mask);
        edit::encode_png_data_url(&img)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Same with the AI engine (local LaMa), needs the model.
#[tauri::command]
async fn edit_inpaint_ai(
    app: AppHandle,
    image_b64: String,
    mask_b64: String,
) -> Result<String, String> {
    let data = app_data(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut img = edit::decode_rgba(&image_b64)?;
        let mask = edit::decode_mask(&mask_b64, img.width(), img.height())?;
        ai::inpaint_lama(&data, &mut img, &mask)?;
        edit::encode_png_data_url(&img)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Expand tool: put the image on a width x height canvas at (x, y) and fill the new
/// border, mode "ai" (LaMa, grows in strips) or "blur" (blurred copy behind it).
#[tauri::command]
async fn edit_expand(
    app: AppHandle,
    image_b64: String,
    width: u32,
    height: u32,
    x: u32,
    y: u32,
    mode: String,
) -> Result<String, String> {
    if width == 0 || height == 0 || width > 16_000 || height > 16_000 {
        return Err("That size is out of range.".into());
    }
    let data = app_data(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let img = edit::decode_rgba(&image_b64)?;
        if x + img.width() > width || y + img.height() > height {
            return Err("The image doesn't fit on that canvas.".into());
        }
        let out = match mode.as_str() {
            "ai" => {
                // "3 / 8" in the editor's busy note, a big picture takes a while
                let report = |done: u32, total: u32| {
                    use tauri::Emitter;
                    let _ = app.emit("expand-progress", serde_json::json!({ "done": done, "total": total }));
                };
                ai::outpaint_lama(&data, &img, width, height, x, y, &report)?
            }
            // LaMa lays out the border, Stable Diffusion redraws it (see diffusion.rs)
            "hq" => {
                if !ai::model_ready(&data, ai::Model::Sd15) {
                    return Err("The HQ model isn't downloaded yet.".into());
                }
                let report = |phase: &str, done: u32, total: u32| {
                    use tauri::Emitter;
                    let _ = app.emit(
                        "expand-progress",
                        serde_json::json!({ "phase": phase, "done": done, "total": total }),
                    );
                };
                let laid = ai::outpaint_lama(&data, &img, width, height, x, y, &|d, t| report("layout", d, t))?;
                // SD may blend a bit further into the picture than LaMa (it's drawn at a
                // lower resolution, a wider fade hides that)
                let band = ((width.min(height) as f32 * 0.02).round() as u32).clamp(8, 48);
                diffusion::refine(
                    &ai::model_path(&data, ai::Model::Sd15),
                    &laid,
                    (x, y, img.width(), img.height()),
                    band,
                    &|d, t| report("detail", d, t),
                )?
            }
            "blur" => edit::expand_blur(&img, width, height, x, y),
            other => return Err(format!("unknown expand mode '{other}'")),
        };
        edit::encode_png_data_url(&out)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Resize to width x height with Lanczos.
#[tauri::command]
async fn edit_resize(image_b64: String, width: u32, height: u32) -> Result<String, String> {
    if width == 0 || height == 0 || width > 16_000 || height > 16_000 {
        return Err("That size is out of range.".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let img = edit::decode_rgba(&image_b64)?;
        let resized =
            image::imageops::resize(&img, width, height, image::imageops::FilterType::Lanczos3);
        edit::encode_png_data_url(&resized)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Upscale to width x height with Real-ESRGAN 4x (tiled), then to the exact size.
#[tauri::command]
async fn edit_upscale(
    app: AppHandle,
    image_b64: String,
    width: u32,
    height: u32,
) -> Result<String, String> {
    if width == 0 || height == 0 || width > 16_000 || height > 16_000 {
        return Err("That size is out of range.".into());
    }
    let data = app_data(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let img = edit::decode_rgba(&image_b64)?;
        let up = ai::upscale(&data, &img, width, height)?;
        edit::encode_png_data_url(&up)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Cut out the subject with IS-Net (background transparent). feather softens the edge.
/// Returns a PNG data URL.
#[tauri::command]
async fn edit_cutout(
    app: AppHandle,
    image_b64: String,
    feather: Option<u32>,
) -> Result<String, String> {
    let data = app_data(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let img = edit::decode_rgba(&image_b64)?;
        let cut = ai::cutout(&data, &img, feather.unwrap_or(0))?;
        edit::encode_png_data_url(&cut)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Is an AI model downloaded ("lama" = remover, "esrgan" = upscaler, "isnet" = cutout) +
/// size.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct AiModelStatus {
    ready: bool,
    size_mb: Option<u64>,
    /// the download URL (the dialog shows exactly this)
    url: &'static str,
    /// the model folder
    folder: String,
}

#[tauri::command]
fn ai_model_status(app: AppHandle, model: Option<String>) -> Result<AiModelStatus, String> {
    let m = ai::Model::from_id(model.as_deref().unwrap_or("lama"))?;
    let data = app_data(&app)?;
    let ready = ai::model_ready(&data, m);
    let size_mb = if ready {
        ai::model_bytes(&data, m).map(|b| b / (1024 * 1024))
    } else {
        None
    };
    let folder = ai::model_path(&data, m)
        .parent()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();
    Ok(AiModelStatus { ready, size_mb, url: m.url(), folder })
}

/// Download an AI model once, emits ai-model-progress { model, done, total }.
#[tauri::command]
async fn ai_model_download(app: AppHandle, model: Option<String>) -> Result<(), String> {
    let id = model.unwrap_or_else(|| "lama".to_string());
    let m = ai::Model::from_id(&id)?;
    let data = app_data(&app)?;
    let app2 = app.clone();
    let id2 = id.clone();
    tauri::async_runtime::spawn_blocking(move || {
        ai::download_model(&data, m, |done, total| {
            let _ = app2.emit(
                "ai-model-progress",
                serde_json::json!({ "model": id2, "done": done, "total": total }),
            );
        })
    })
    .await
    .map_err(|e| e.to_string())??;
    let _ = app.emit(
        "ai-model-progress",
        serde_json::json!({ "model": id, "done": 1u64, "total": 1u64, "ready": true }),
    );
    Ok(())
}

/// Shrink a rough brushed area to the object inside (no AI).
/// Returns the selection as a rose PNG data URL.
#[tauri::command]
async fn edit_detect(
    image_b64: String,
    mask_b64: String,
    strength: Option<f32>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let img = edit::decode_rgba(&image_b64)?;
        let mask = edit::decode_mask(&mask_b64, img.width(), img.height())?;
        let refined = edit::detect_object(&img, &mask, strength.unwrap_or(0.5));
        edit::encode_mask_rose(&refined)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Save an edited image. "copy" = <stem>_edited.png next to it, "overwrite" = replace
/// the original (in its own format). Returns the path.
#[tauri::command]
async fn edit_save(
    dek: State<'_, DekState>,
    image_b64: String,
    src_path: String,
    mode: String,
) -> Result<String, String> {
    let key = session_key(&dek);
    tauri::async_runtime::spawn_blocking(move || {
        let img = edit::decode_rgba(&image_b64)?;
        let src = std::path::Path::new(&src_path);
        let (dest, bytes) = if mode == "overwrite" {
            // keep the path/format, RGB for formats without alpha
            let fmt = image::ImageFormat::from_path(src).unwrap_or(image::ImageFormat::Png);
            let dynimg = image::DynamicImage::ImageRgba8(img);
            let out = match fmt {
                image::ImageFormat::Jpeg | image::ImageFormat::Bmp => {
                    image::DynamicImage::ImageRgb8(dynimg.to_rgb8())
                }
                _ => dynimg,
            };
            let mut buf = Vec::new();
            out.write_to(&mut std::io::Cursor::new(&mut buf), fmt)
                .map_err(|e| format!("encode {src_path}: {e}"))?;
            (src.to_path_buf(), buf)
        } else {
            // copy: "<stem>_edited.png", "_edited2"... if it exists
            let dir = src.parent().unwrap_or_else(|| std::path::Path::new("."));
            let stem = src.file_stem().and_then(|s| s.to_str()).unwrap_or("image");
            let mut dest = dir.join(format!("{stem}_edited.png"));
            let mut n = 2;
            while dest.exists() {
                dest = dir.join(format!("{stem}_edited{n}.png"));
                n += 1;
            }
            let mut buf = Vec::new();
            image::DynamicImage::ImageRgba8(img)
                .write_to(&mut std::io::Cursor::new(&mut buf), image::ImageFormat::Png)
                .map_err(|e| format!("encode copy: {e}"))?;
            (dest, buf)
        };
        // encrypt the output if encryption is on and unlocked
        let to_write = match key {
            Some(k) => crypto::Dek::from_bytes(k).encrypt_bytes(&bytes),
            None => bytes,
        };
        crypto::atomic_write(&dest, &to_write)?;
        Ok(dest.to_string_lossy().to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Max long edge of a saved cover crop (covers are shown small).
const COVER_MAX_EDGE: u32 = 2048;

/// Where cover crops are saved: the app data folder, next to the versions.
fn covers_dir<R: tauri::Runtime, M: Manager<R>>(app: &M) -> Result<std::path::PathBuf, String> {
    Ok(app_data(app)?.join("covers"))
}

/// Turn a crop into a cover: max COVER_MAX_EDGE, JPEG unless it really uses
/// transparency. Returns bytes + extension. (Full size PNG crops were ~50 MB.)
fn encode_cover(img: image::RgbaImage) -> Result<(Vec<u8>, &'static str), String> {
    let (w, h) = img.dimensions();
    let dynimg = image::DynamicImage::ImageRgba8(img);
    // only shrink, never enlarge
    let dynimg = if w.max(h) > COVER_MAX_EDGE {
        dynimg.resize(COVER_MAX_EDGE, COVER_MAX_EDGE, image::imageops::FilterType::Lanczos3)
    } else {
        dynimg
    };
    let transparent = dynimg.as_rgba8().is_some_and(|i| i.pixels().any(|p| p[3] < 255));
    let mut bytes = Vec::new();
    if transparent {
        dynimg
            .write_to(&mut std::io::Cursor::new(&mut bytes), image::ImageFormat::Png)
            .map_err(|e| format!("encode cover: {e}"))?;
        Ok((bytes, "png"))
    } else {
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut bytes, 90)
            .encode_image(&dynimg.to_rgb8())
            .map_err(|e| format!("encode cover: {e}"))?;
        Ok((bytes, "jpg"))
    }
}

/// Save a cropped cover and return its path. Encrypted when unlocked.
/// Saved in <app data>/covers, not in the collection (a reward folder is the
/// creator's content, not ours). Travels with a portable copy and survives
/// moves/renames/MiSD.
#[tauri::command]
async fn save_cover_crop(
    app: AppHandle,
    dek: State<'_, DekState>,
    image_b64: String,
) -> Result<String, String> {
    let key = session_key(&dek);
    let dir = covers_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let img = edit::decode_rgba(&image_b64)?;
        let (bytes, ext) = encode_cover(img)?;
        std::fs::create_dir_all(&dir).map_err(map_err)?;
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let mut dest = dir.join(format!("cover_{ts}.{ext}"));
        let mut n = 2;
        while dest.exists() {
            dest = dir.join(format!("cover_{ts}_{n}.{ext}"));
            n += 1;
        }
        let to_write = match key {
            Some(k) => crypto::Dek::from_bytes(k).encrypt_bytes(&bytes),
            None => bytes,
        };
        crypto::atomic_write(&dest, &to_write)?;
        Ok(dest.to_string_lossy().to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Attach a saved copy to the same reward as the original (no full rescan).
#[tauri::command]
fn index_added_image(db: State<Db>, reference_path: String, new_path: String) -> Result<bool, String> {
    let conn = db.lock().map_err(map_err)?;
    db::add_image_beside(&conn, &reference_path, &new_path).map_err(map_err)
}

/* ---- Image versions (non-destructive edit history) -------------------- */

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct VersionList {
    versions: Vec<db::ImageVersion>,
    active_id: Option<i64>,
}

/// Save the edit as a new VERSION of orig_path (the original isn't touched).
/// Saved in <app_data>/versions/<id>.png (encrypted when unlocked). Becomes active.
#[tauri::command]
fn save_image_version(
    app: AppHandle,
    db: State<Db>,
    dek: State<DekState>,
    orig_path: String,
    image_b64: String,
    label: Option<String>,
) -> Result<db::ImageVersion, String> {
    let key = session_key(&dek);
    // edited RGBA -> PNG bytes
    let img = edit::decode_rgba(&image_b64)?;
    let mut bytes = Vec::new();
    image::DynamicImage::ImageRgba8(img)
        .write_to(&mut std::io::Cursor::new(&mut bytes), image::ImageFormat::Png)
        .map_err(|e| format!("encode version: {e}"))?;

    let dir = app_data(&app)?.join("versions");
    std::fs::create_dir_all(&dir).map_err(map_err)?;

    let conn = db.lock().map_err(map_err)?;
    // insert first to get an id, then name the file after it
    let id = db::add_image_version(&conn, &orig_path, "", label.as_deref()).map_err(map_err)?;
    let dest = dir.join(format!("{id}.png"));
    let to_write = match key {
        Some(k) => crypto::Dek::from_bytes(k).encrypt_bytes(&bytes),
        None => bytes,
    };
    crypto::atomic_write(&dest, &to_write)?;
    let file_path = dest.to_string_lossy().to_string();
    conn.execute(
        "UPDATE image_versions SET file_path = ?2 WHERE id = ?1",
        rusqlite::params![id, file_path],
    )
    .map_err(map_err)?;
    db::set_active_version(&conn, &orig_path, Some(id)).map_err(map_err)?;
    Ok(db::ImageVersion { id, orig_path, file_path, label, created_at: None })
}

/// Versions of an image + the active one (None = original).
#[tauri::command]
fn list_image_versions(db: State<Db>, orig_path: String) -> Result<VersionList, String> {
    let conn = db.lock().map_err(map_err)?;
    let (versions, active_id) = db::list_image_versions(&conn, &orig_path).map_err(map_err)?;
    Ok(VersionList { versions, active_id })
}

/// Versions of many images at once (only the ones that have any), for the MEGA upload.
/// One call instead of one per file.
#[tauri::command]
fn image_versions_for(
    db: State<Db>,
    orig_paths: Vec<String>,
) -> Result<std::collections::HashMap<String, VersionList>, String> {
    let conn = db.lock().map_err(map_err)?;
    let mut out = std::collections::HashMap::new();
    for p in orig_paths {
        let (versions, active_id) = db::list_image_versions(&conn, &p).map_err(map_err)?;
        if !versions.is_empty() {
            out.insert(p, VersionList { versions, active_id });
        }
    }
    Ok(out)
}

/// Switch the shown version, null = original.
#[tauri::command]
fn set_active_version(db: State<Db>, orig_path: String, version_id: Option<i64>) -> Result<(), String> {
    let conn = db.lock().map_err(map_err)?;
    db::set_active_version(&conn, &orig_path, version_id).map_err(map_err)
}

/// Delete one version (row + file to the recycle bin).
#[tauri::command]
fn delete_image_version(db: State<Db>, version_id: i64) -> Result<(), String> {
    let file = {
        let conn = db.lock().map_err(map_err)?;
        db::delete_image_version(&conn, version_id).map_err(map_err)?
    };
    if let Some(fp) = file {
        let p = std::path::PathBuf::from(&fp);
        if p.exists() {
            let _ = trash::delete(&p);
        }
    }
    Ok(())
}

/* ---- "keep running in the tray" ------------------------------------- */
/* With this on, closing the window hides it and the app keeps running in the tray.
   Off by default, the tray icon only exists while it's on.
   The flag is also in an AtomicBool so the close handler doesn't need the DB lock. */
const CLOSE_TO_TRAY_KEY: &str = "close_to_tray";
const TRAY_ID: &str = "micoll-tray";

struct CloseToTray(std::sync::atomic::AtomicBool);

/// A normal app window: the first one ("main") or one from the taskbar's "New window"
/// (not a pop-out viewer).
fn is_app_window(label: &str) -> bool {
    label == "main" || label.starts_with("window-")
}

/// Bring MiColl to the front: the main window, or another app window if main was closed,
/// or a new one if none is left (only pop-outs, or all closed while in the tray).
/// Returns the window it showed (None when a new one is still being built).
fn restore_window(app: &AppHandle) -> Option<tauri::WebviewWindow> {
    let w = app.get_webview_window("main").or_else(|| {
        app.webview_windows()
            .into_iter()
            .filter(|(label, _)| is_app_window(label))
            .map(|(_, w)| w)
            .next()
    });
    match w {
        Some(w) => {
            let _ = w.show();
            let _ = w.unminimize();
            let _ = w.set_focus();
            Some(w)
        }
        None => {
            open_new_window(app);
            None
        }
    }
}

/* ---- taskbar tasks -------------------------------------------------- */
/* "Add rewards" from the taskbar's jump list (or a start with --add-rewards): Rust keeps
   it here until the frontend takes it (components/LaunchActions.tsx), so it also works
   while MiColl is still starting or locked. */
static LAUNCH_ACTION: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);
const ADD_REWARDS_ARG: &str = "--add-rewards";

fn set_launch_action(action: &str) {
    if let Ok(mut slot) = LAUNCH_ACTION.lock() {
        *slot = Some(action.to_string());
    }
}

/// The waiting taskbar action ("add-rewards"), once.
#[tauri::command]
fn take_launch_action() -> Option<String> {
    LAUNCH_ACTION.lock().ok()?.take()
}

/// Another app window (taskbar right-click -> "New window"). Same setup as the first
/// window from tauri.conf.json, own label. Same process, so same library and DB.
fn open_new_window(app: &AppHandle) {
    static NEXT: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(2);
    let Some(mut config) = app.config().app.windows.first().cloned() else { return };
    config.label = format!("window-{}", NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed));
    let app = app.clone();
    // off the calling thread: building a window from a blocked thread can deadlock
    std::thread::spawn(move || {
        match tauri::WebviewWindowBuilder::from_config(&app, &config).and_then(|b| b.build()) {
            Ok(w) => {
                let _ = w.set_focus();
            }
            Err(e) => eprintln!("micoll: new window failed: {e}"),
        }
    });
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItem};
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

    if app.tray_by_id(TRAY_ID).is_some() {
        return Ok(()); // already there — turning the option on twice is a no-op
    }
    let show = MenuItem::with_id(app, "show", "Open MiColl", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit MiColl", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;
    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip("MiColl")
        .menu(&menu)
        // left click opens the window, right click the menu
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => {
                restore_window(app);
            }
            // the normal way to quit now, so fold the WAL first (app.exit skips the
            // teardown,
            // an unflushed WAL once lost a month of data, see db::open). Off the
            // window's thread: a running command (an import) is waited for first.
            "quit" => {
                let app = app.clone();
                std::thread::spawn(move || {
                    drop(wait_for_command());
                    if let Some(db) = app.try_state::<Db>() {
                        if let Ok(conn) = db.lock() {
                            db::checkpoint(&conn);
                        }
                    }
                    app.exit(0);
                });
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                restore_window(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon().cloned() {
        builder = builder.icon(icon);
    }
    builder.build(app)?;
    Ok(())
}

#[tauri::command]
fn set_close_to_tray(app: AppHandle, db: State<Db>, on: bool) -> Result<(), String> {
    {
        let conn = db.lock().map_err(map_err)?;
        db::set_setting(&conn, CLOSE_TO_TRAY_KEY, if on { "true" } else { "false" })
            .map_err(map_err)?;
    }
    if let Some(flag) = app.try_state::<CloseToTray>() {
        flag.0.store(on, std::sync::atomic::Ordering::Relaxed);
    }
    if on {
        build_tray(&app).map_err(map_err)?;
    } else {
        app.remove_tray_by_id(TRAY_ID);
        // turning it off while hidden would leave no way back, so show the window
        restore_window(&app);
    }
    Ok(())
}

#[tauri::command]
fn get_setting(db: State<Db>, key: String) -> Result<Option<String>, String> {
    let conn = db.lock().map_err(map_err)?;
    db::get_setting(&conn, &key).map_err(map_err)
}

#[tauri::command]
fn set_setting(db: State<Db>, key: String, value: String) -> Result<(), String> {
    let conn = db.lock().map_err(map_err)?;
    db::set_setting(&conn, &key, &value).map_err(map_err)
}

/* ---- lock-screen password (salted SHA-256, stored in settings) ------- */

fn sha256_hex(parts: &[&[u8]]) -> String {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    for p in parts {
        h.update(p);
    }
    h.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

/// A salt from the current time (good enough for a local single-user app).
fn gen_salt() -> String {
    let n = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    sha256_hex(&[&n.to_le_bytes(), b"micoll-salt"])
}

/// Set or clear (empty) the lock password. With encryption on, a new password
/// re-wraps the data key and clearing is blocked (it would lose the key).
#[tauri::command]
fn set_password(db: State<Db>, dek_state: State<DekState>, password: String) -> Result<(), String> {
    let conn = db.lock().map_err(map_err)?;
    if password.is_empty() {
        if enc_enabled(&conn) {
            return Err("Can't remove the password while encryption is on — disable encryption first.".into());
        }
        db::set_setting(&conn, "lock_pw_hash", "").map_err(map_err)?;
        db::set_setting(&conn, "lock_pw_salt", "").map_err(map_err)?;
        return Ok(());
    }
    // re-wrap the DEK with the new password (must be unlocked)
    if enc_enabled(&conn) {
        let guard = dek_state.lock().map_err(map_err)?;
        let dek = guard.as_ref().ok_or("Unlock MiColl before changing the password.")?;
        let pw_salt = crypto::gen_salt();
        let kek = crypto::derive_kek(&password, &pw_salt);
        db::set_setting(&conn, "enc_kdf_salt", &b64e(&pw_salt)).map_err(map_err)?;
        db::set_setting(&conn, "enc_dek_pw", &b64e(&crypto::wrap_dek(&kek, dek))).map_err(map_err)?;
    }
    let salt = gen_salt();
    let hash = sha256_hex(&[salt.as_bytes(), password.as_bytes()]);
    db::set_setting(&conn, "lock_pw_salt", &salt).map_err(map_err)?;
    db::set_setting(&conn, "lock_pw_hash", &hash).map_err(map_err)?;
    Ok(())
}

/// Is a lock password set?
#[tauri::command]
fn has_password(db: State<Db>) -> Result<bool, String> {
    let conn = db.lock().map_err(map_err)?;
    Ok(db::get_setting(&conn, "lock_pw_hash")
        .map_err(map_err)?
        .filter(|s| !s.is_empty())
        .is_some())
}

/// Check a password. Always true without a password.
#[tauri::command]
fn verify_password(db: State<Db>, password: String) -> Result<bool, String> {
    let conn = db.lock().map_err(map_err)?;
    match db::get_setting(&conn, "lock_pw_hash")
        .map_err(map_err)?
        .filter(|s| !s.is_empty())
    {
        None => Ok(true),
        Some(stored) => {
            let salt = db::get_setting(&conn, "lock_pw_salt")
                .map_err(map_err)?
                .unwrap_or_default();
            Ok(sha256_hex(&[salt.as_bytes(), password.as_bytes()]) == stored)
        }
    }
}

/* ---- decoy ("safe mode") password ------------------------------------ */

/// Check a password against the decoy hash (false when none is set).
fn decoy_ok(conn: &rusqlite::Connection, password: &str) -> bool {
    match db::get_setting(conn, "lock_pw2_hash").ok().flatten().filter(|s| !s.is_empty()) {
        None => false,
        Some(stored) => {
            let salt = db::get_setting(conn, "lock_pw2_salt").ok().flatten().unwrap_or_default();
            sha256_hex(&[salt.as_bytes(), password.as_bytes()]) == stored
        }
    }
}

/// Set or clear the decoy password. It opens safe mode (SFW only, no settings).
/// Nothing on screen shows which password was used.
/// With encryption on, the data key is also wrapped with it, so the app must be unlocked.
#[tauri::command]
fn set_decoy_password(
    db: State<Db>,
    dek_state: State<DekState>,
    password: String,
) -> Result<(), String> {
    let conn = db.lock().map_err(map_err)?;
    if password.is_empty() {
        for k in ["lock_pw2_hash", "lock_pw2_salt", "enc_kdf_salt2", "enc_dek_pw2"] {
            db::set_setting(&conn, k, "").map_err(map_err)?;
        }
        return Ok(());
    }
    let has_real = db::get_setting(&conn, "lock_pw_hash")
        .map_err(map_err)?
        .filter(|s| !s.is_empty())
        .is_some();
    if !has_real {
        return Err("Set a password for MiColl first — a decoy needs a real one to hide behind.".into());
    }
    if password_ok(&conn, &password) {
        return Err("The decoy has to be different from your real password.".into());
    }
    if enc_enabled(&conn) {
        let guard = dek_state.lock().map_err(map_err)?;
        let dek = guard
            .as_ref()
            .ok_or("Unlock MiColl before setting a decoy password.")?;
        let salt = crypto::gen_salt();
        let kek = crypto::derive_kek(&password, &salt);
        db::set_setting(&conn, "enc_kdf_salt2", &b64e(&salt)).map_err(map_err)?;
        db::set_setting(&conn, "enc_dek_pw2", &b64e(&crypto::wrap_dek(&kek, dek))).map_err(map_err)?;
    }
    let salt = gen_salt();
    let hash = sha256_hex(&[salt.as_bytes(), password.as_bytes()]);
    db::set_setting(&conn, "lock_pw2_salt", &salt).map_err(map_err)?;
    db::set_setting(&conn, "lock_pw2_hash", &hash).map_err(map_err)?;
    Ok(())
}

/// Is a decoy password set?
#[tauri::command]
fn has_decoy_password(db: State<Db>) -> Result<bool, String> {
    let conn = db.lock().map_err(map_err)?;
    Ok(db::get_setting(&conn, "lock_pw2_hash")
        .map_err(map_err)?
        .filter(|s| !s.is_empty())
        .is_some())
}

/* ---- at-rest encryption ---------------------------------------------- */

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};

fn b64e(b: &[u8]) -> String {
    B64.encode(b)
}
fn b64d(s: &str) -> Result<Vec<u8>, String> {
    B64.decode(s).map_err(map_err)
}

/// Is encryption on?
fn enc_enabled(conn: &rusqlite::Connection) -> bool {
    db::get_setting(conn, "enc_enabled").ok().flatten().as_deref() == Some("true")
}

/// Copy of the data key for background work, or None if locked.
fn session_key(dek: &DekState) -> Option<[u8; 32]> {
    dek.lock().ok().and_then(|g| g.as_ref().map(|d| d.raw()))
}

/// Check a password against the lock hash (false when none is set).
fn password_ok(conn: &rusqlite::Connection, password: &str) -> bool {
    match db::get_setting(conn, "lock_pw_hash").ok().flatten().filter(|s| !s.is_empty()) {
        None => false,
        Some(stored) => {
            let salt = db::get_setting(conn, "lock_pw_salt").ok().flatten().unwrap_or_default();
            sha256_hex(&[salt.as_bytes(), password.as_bytes()]) == stored
        }
    }
}

/// Media files to (de)encrypt: collection, roots, the MiSD disk, and our own
/// cover crops and edit versions.
fn collect_media_files(
    conn: &rusqlite::Connection,
    data_dir: Option<&std::path::Path>,
) -> Vec<std::path::PathBuf> {
    use std::collections::HashSet;
    const EXTS: &[&str] = &[
        "jpg", "jpeg", "jfif", "png", "gif", "webp", "bmp", "avif", "tif", "tiff", "mp4", "webm",
        "mov", "m4v", "mkv", "avi", "wmv", "flv",
    ];
    let is_media = |p: &std::path::Path| {
        p.extension()
            .and_then(|e| e.to_str())
            .map(|e| EXTS.contains(&e.to_ascii_lowercase().as_str()))
            .unwrap_or(false)
    };
    let mut bases: Vec<std::path::PathBuf> = Vec::new();
    if let Some(root) = db::get_setting(conn, "collection_root")
        .ok()
        .flatten()
        .filter(|s| !s.trim().is_empty())
    {
        bases.push(std::path::Path::new(&root).join("MiColl"));
    }
    if let Ok(roots) = db::list_roots(conn) {
        for r in roots {
            bases.push(std::path::PathBuf::from(r.path));
        }
    }
    // the MiSD disk isn't a root, without this turning encryption off would leave
    // its files encrypted forever
    if let Ok(dirs) = sd::encrypted_sd_dirs(conn) {
        for d in dirs {
            bases.push(std::path::PathBuf::from(d));
        }
    }
    // covers and versions are written encrypted, so they must be in the sweep too
    if let Some(data) = data_dir {
        bases.push(data.join("covers"));
        bases.push(data.join("versions"));
    }
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for base in bases {
        for entry in walkdir::WalkDir::new(&base).into_iter().flatten() {
            let p = entry.path();
            if p.is_file() && is_media(p) && seen.insert(p.to_string_lossy().to_string()) {
                out.push(p.to_path_buf());
            }
        }
    }
    out
}

/// Encrypt or decrypt files off the main thread, emits encrypt-progress.
async fn run_sweep(
    app: &AppHandle,
    dek_raw: [u8; 32],
    files: Vec<std::path::PathBuf>,
    encrypt: bool,
) -> Result<usize, String> {
    let app2 = app.clone();
    let total = files.len();
    let errors = tauri::async_runtime::spawn_blocking(move || {
        let dek = crypto::Dek::from_bytes(dek_raw);
        let mut done = 0usize;
        let mut errors = 0usize;
        for f in &files {
            let r = if encrypt {
                crypto::encrypt_file_in_place(&dek, f)
            } else {
                crypto::decrypt_file_in_place(&dek, f)
            };
            if r.is_err() {
                errors += 1;
            }
            done += 1;
            if done % 8 == 0 || done == total {
                let _ = app2.emit(
                    "encrypt-progress",
                    serde_json::json!({ "done": done, "total": total, "errors": errors, "encrypt": encrypt }),
                );
            }
        }
        errors
    })
    .await
    .map_err(|e| e.to_string())?;
    Ok(errors)
}

/// Encryption on and unlocked (DEK loaded)?
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct EncState {
    enabled: bool,
    unlocked: bool,
}

#[tauri::command]
fn encryption_state(db: State<Db>, dek: State<DekState>) -> Result<EncState, String> {
    let enabled = {
        let conn = db.lock().map_err(map_err)?;
        enc_enabled(&conn)
    };
    let unlocked = dek.lock().map_err(map_err)?.is_some();
    Ok(EncState { enabled, unlocked })
}

/// Turn on encryption: create keys, enable, load the DEK, encrypt everything.
/// Returns a one-time recovery code.
#[tauri::command]
async fn enable_encryption(
    app: AppHandle,
    db: State<'_, Db>,
    dek_state: State<'_, DekState>,
    password: String,
) -> Result<String, String> {
    let (dek_raw, files, recovery) = {
        let conn = db.lock().map_err(map_err)?;
        if !password_ok(&conn, &password) {
            return Err("Wrong password.".into());
        }
        if enc_enabled(&conn) {
            return Err("Encryption is already enabled.".into());
        }
        // files on an unplugged MiSD disk just stay plain for now (warn, don't refuse)
        if sd::has_sd_content(&conn) && !sd::available(&conn) {
            return Err(
                "Your MiSD disk isn't connected. Plug it in first so the rewards stored \
                 on it are encrypted too — otherwise they'd stay unprotected on a disk \
                 you carry around."
                    .into(),
            );
        }
        let dek = crypto::generate_dek();
        let pw_salt = crypto::gen_salt();
        let rec_salt = crypto::gen_salt();
        let recovery = crypto::gen_recovery_code();
        let kek_pw = crypto::derive_kek(&password, &pw_salt);
        let kek_rec = crypto::derive_kek(&recovery, &rec_salt);
        db::set_setting(&conn, "enc_kdf_salt", &b64e(&pw_salt)).map_err(map_err)?;
        db::set_setting(&conn, "enc_dek_pw", &b64e(&crypto::wrap_dek(&kek_pw, &dek))).map_err(map_err)?;
        db::set_setting(&conn, "enc_rec_salt", &b64e(&rec_salt)).map_err(map_err)?;
        db::set_setting(&conn, "enc_dek_rec", &b64e(&crypto::wrap_dek(&kek_rec, &dek))).map_err(map_err)?;
        db::set_setting(&conn, "enc_verifier", &b64e(&crypto::make_verifier(&dek))).map_err(map_err)?;
        db::set_setting(&conn, "enc_enabled", "true").map_err(map_err)?;
        // a decoy password can't wrap the new key (only its hash is saved), so remove it
        for k in ["lock_pw2_hash", "lock_pw2_salt", "enc_kdf_salt2", "enc_dek_pw2"] {
            db::set_setting(&conn, k, "").map_err(map_err)?;
        }
        let files = collect_media_files(&conn, app_data(&app).ok().as_deref());
        (dek.raw(), files, recovery)
    };
    // load the DEK so reads decrypt during the sweep
    *dek_state.lock().map_err(map_err)? = Some(crypto::Dek::from_bytes(dek_raw));
    run_sweep(&app, dek_raw, files, true).await?;
    Ok(recovery)
}

/// Turn off encryption: decrypt everything, then remove the keys.
#[tauri::command]
async fn disable_encryption(
    app: AppHandle,
    db: State<'_, Db>,
    dek_state: State<'_, DekState>,
    password: String,
) -> Result<(), String> {
    let (dek_raw, files) = {
        let conn = db.lock().map_err(map_err)?;
        if !enc_enabled(&conn) {
            return Ok(());
        }
        if !password_ok(&conn, &password) {
            return Err("Wrong password.".into());
        }
        let dek_raw = match dek_state.lock().map_err(map_err)?.as_ref() {
            Some(d) => d.raw(),
            None => return Err("Unlock MiColl first.".into()),
        };
        // hard stop if the MiSD disk is unplugged: its files would stay encrypted forever
        if sd::has_sd_content(&conn) && !sd::available(&conn) {
            return Err(
                "Connect your MiSD disk first. Turning encryption off deletes the key, \
                 and the rewards stored on that disk have to be decrypted before it goes \
                 — otherwise they could never be opened again."
                    .into(),
            );
        }
        (dek_raw, collect_media_files(&conn, app_data(&app).ok().as_deref()))
    };
    run_sweep(&app, dek_raw, files, false).await?;
    let conn = db.lock().map_err(map_err)?;
    for k in ["enc_enabled", "enc_kdf_salt", "enc_dek_pw", "enc_rec_salt", "enc_dek_rec", "enc_verifier"] {
        db::set_setting(&conn, k, "").map_err(map_err)?;
    }
    *dek_state.lock().map_err(map_err)? = None;
    Ok(())
}

/// Encrypt any new plain files (idempotent, used after imports). Does nothing when off.
#[tauri::command]
async fn encrypt_collection(
    app: AppHandle,
    db: State<'_, Db>,
    dek_state: State<'_, DekState>,
) -> Result<(), String> {
    let (dek_raw, files) = {
        let conn = db.lock().map_err(map_err)?;
        if !enc_enabled(&conn) {
            return Ok(());
        }
        let dek_raw = match dek_state.lock().map_err(map_err)?.as_ref() {
            Some(d) => d.raw(),
            None => return Err("Unlock MiColl first.".into()),
        };
        (dek_raw, collect_media_files(&conn, app_data(&app).ok().as_deref()))
    };
    run_sweep(&app, dek_raw, files, true).await?;
    Ok(())
}

/// Unlock result: did it work, and was it the decoy password?
#[derive(serde::Serialize)]
pub struct UnlockResult {
    ok: bool,
    decoy: bool,
}

/// Unlock. With encryption the DEK is loaded from the password, otherwise like
/// verify_password. The decoy is tried second, so the real password wins.
#[tauri::command]
fn unlock(
    db: State<Db>,
    dek_state: State<DekState>,
    password: String,
) -> Result<UnlockResult, String> {
    let conn = db.lock().map_err(map_err)?;
    let no = UnlockResult { ok: false, decoy: false };
    if !enc_enabled(&conn) {
        // no encryption, only the password check
        let has = db::get_setting(&conn, "lock_pw_hash").map_err(map_err)?.filter(|s| !s.is_empty()).is_some();
        if !has || password_ok(&conn, &password) {
            return Ok(UnlockResult { ok: true, decoy: false });
        }
        return Ok(UnlockResult { ok: decoy_ok(&conn, &password), decoy: true });
    }
    let verifier = b64d(&db::get_setting(&conn, "enc_verifier").map_err(map_err)?.unwrap_or_default())?;
    // both passwords unwrap the same key, the decoy only changes what's shown
    for (salt_key, wrap_key, decoy) in [
        ("enc_kdf_salt", "enc_dek_pw", false),
        ("enc_kdf_salt2", "enc_dek_pw2", true),
    ] {
        let salt = b64d(&db::get_setting(&conn, salt_key).map_err(map_err)?.unwrap_or_default())?;
        let wrapped = b64d(&db::get_setting(&conn, wrap_key).map_err(map_err)?.unwrap_or_default())?;
        if salt.is_empty() || wrapped.is_empty() {
            continue;
        }
        let kek = crypto::derive_kek(&password, &salt);
        if let Ok(dek) = crypto::unwrap_dek(&kek, &wrapped) {
            if crypto::check_verifier(&dek, &verifier) {
                *dek_state.lock().map_err(map_err)? = Some(dek);
                return Ok(UnlockResult { ok: true, decoy });
            }
        }
    }
    Ok(no)
}

/// Unlock with the recovery code.
#[tauri::command]
fn unlock_recovery(db: State<Db>, dek_state: State<DekState>, code: String) -> Result<bool, String> {
    let conn = db.lock().map_err(map_err)?;
    if !enc_enabled(&conn) {
        return Ok(false);
    }
    let salt = b64d(&db::get_setting(&conn, "enc_rec_salt").map_err(map_err)?.unwrap_or_default())?;
    let wrapped = b64d(&db::get_setting(&conn, "enc_dek_rec").map_err(map_err)?.unwrap_or_default())?;
    let verifier = b64d(&db::get_setting(&conn, "enc_verifier").map_err(map_err)?.unwrap_or_default())?;
    let kek = crypto::derive_kek(code.trim(), &salt);
    match crypto::unwrap_dek(&kek, &wrapped) {
        Ok(dek) if crypto::check_verifier(&dek, &verifier) => {
            *dek_state.lock().map_err(map_err)? = Some(dek);
            Ok(true)
        }
        _ => Ok(false),
    }
}

/// Wipe the DEK from memory (on lock).
#[tauri::command]
fn lock(dek_state: State<DekState>) -> Result<(), String> {
    *dek_state.lock().map_err(map_err)? = None;
    Ok(())
}

/* ---- database backup / restore --------------------------------------- */

fn db_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(app_data(app)?.join("micoll.db"))
}

/// Write a clean snapshot of the database to dest (artists, tags, notes, templates,
/// covers, settings, encryption), not the media files.
/* ---- automatic daily snapshots --------------------------------------- */

/// Does the daily backup run at startup? Missing = on.
const AUTO_BACKUP_KEY: &str = "auto_backup";

/// One daily backup for the Settings list.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct BackupInfo {
    /// File name micoll-YYYYMMDD.db.
    name: String,
    /// Date from the name (2026-08-18), or the raw name if it doesn't parse.
    day: String,
    bytes: u64,
    /// Has a WAL file, restoring must take it too.
    has_wal: bool,
}

fn backups_dir(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(app_data(app)?.join("backups"))
}

/// Copy a picture for a wish and return its path.
/// A wish has no folder (missing reward), and a picture in the collection would
/// make the indexer mark it owned, so it goes into its own app data folder.
#[tauri::command]
fn import_wish_cover(app: AppHandle, src: String) -> Result<String, String> {
    let src = std::path::PathBuf::from(&src);
    let ext = src
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .filter(|e| matches!(e.as_str(), "jpg" | "jpeg" | "png" | "webp" | "gif" | "bmp"))
        .ok_or_else(|| "Pick an image file (jpg, png, webp, gif or bmp).".to_string())?;
    let dir = app_data(&app)?.join("wish-covers");
    std::fs::create_dir_all(&dir).map_err(map_err)?;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let dest = dir.join(format!("wish-{stamp}.{ext}"));
    std::fs::copy(&src, &dest).map_err(map_err)?;
    let out = dest.to_string_lossy().into_owned();
    allow_asset_dir(&app, &dir.to_string_lossy());
    Ok(out)
}

/// Read the auto-backup flag WITHOUT opening the DB read-write.
/// The backup runs before db::open (which folds the WAL), so a read-only connection
/// is used. Any problem = on.
fn auto_backup_enabled(db_file: &std::path::Path) -> bool {
    let Ok(conn) = rusqlite::Connection::open_with_flags(
        db_file,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_URI,
    ) else {
        return true;
    };
    conn.query_row(
        "SELECT value FROM settings WHERE key = ?1",
        rusqlite::params![AUTO_BACKUP_KEY],
        |r| r.get::<_, String>(0),
    )
    .map(|v| v != "false")
    .unwrap_or(true)
}

/// The daily backups, newest first.
#[tauri::command]
fn list_backups(app: AppHandle) -> Result<Vec<BackupInfo>, String> {
    let dir = backups_dir(&app)?;
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Ok(Vec::new()); // never run yet
    };
    let mut out: Vec<BackupInfo> = entries
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().into_string().ok()?;
            if !name.starts_with("micoll-") || !name.ends_with(".db") {
                return None;
            }
            let stem = name.trim_start_matches("micoll-").trim_end_matches(".db").to_string();
            let day = if stem.len() == 8 && stem.chars().all(|c| c.is_ascii_digit()) {
                format!("{}-{}-{}", &stem[0..4], &stem[4..6], &stem[6..8])
            } else {
                stem
            };
            Some(BackupInfo {
                has_wal: dir.join(format!("{name}-wal")).is_file(),
                bytes: e.metadata().map(|m| m.len()).unwrap_or(0),
                name,
                day,
            })
        })
        .collect();
    // names are micoll-YYYYMMDD.db, so sorting sorts by date
    out.sort_by(|a, b| b.name.cmp(&a.name));
    Ok(out)
}

/// Restore one of the daily backups.
#[tauri::command]
fn restore_backup(
    app: AppHandle,
    db: State<Db>,
    dek_state: State<DekState>,
    name: String,
) -> Result<(), String> {
    let dir = backups_dir(&app)?;
    let src = dir.join(&name);
    // resolve inside the folder, refuse anything outside
    if src.parent() != Some(dir.as_path()) || !src.is_file() {
        return Err("That snapshot isn't in the backups folder any more.".into());
    }
    let wal = dir.join(format!("{name}-wal"));
    swap_in_database(&app, &db, &dek_state, &src, Some(&wal))
}

/// Open the backups folder in Explorer.
#[tauri::command]
fn reveal_backups(app: AppHandle) -> Result<(), String> {
    let dir = backups_dir(&app)?;
    std::fs::create_dir_all(&dir).map_err(map_err)?;
    open_dir(&dir)
}

#[tauri::command]
fn backup_database(db: State<Db>, dest: String) -> Result<(), String> {
    let conn = db.lock().map_err(map_err)?;
    // VACUUM INTO needs the target not to exist
    let _ = std::fs::remove_file(&dest);
    conn.execute("VACUUM INTO ?1", rusqlite::params![dest])
        .map_err(map_err)?;
    Ok(())
}

/// Replace the live DB with a backup and reopen it. Locks the session
/// (the backup may have another password/encryption).
#[tauri::command]
fn restore_database(
    app: AppHandle,
    db: State<Db>,
    dek_state: State<DekState>,
    src: String,
) -> Result<(), String> {
    let src_path = std::path::PathBuf::from(&src);
    if !src_path.is_file() {
        return Err("Backup file not found.".into());
    }
    // check it's really a MiColl database first
    {
        let probe = rusqlite::Connection::open(&src_path).map_err(map_err)?;
        let has_artists: i64 = probe
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='artists'",
                [],
                |r| r.get(0),
            )
            .map_err(|_| "That file isn't a MiColl backup.".to_string())?;
        if has_artists == 0 {
            return Err("That file isn't a MiColl backup.".into());
        }
    }

    swap_in_database(&app, &db, &dek_state, &src_path, None)
}

/// Put src_db in place as the live DB and reopen it.
/// src_wal: daily backups are raw copies and keep their WAL, restoring without
/// it would lose that session's last changes. A manual backup has none.
fn swap_in_database(
    app: &AppHandle,
    db: &State<Db>,
    dek_state: &State<DekState>,
    src_db: &std::path::Path,
    src_wal: Option<&std::path::Path>,
) -> Result<(), String> {
    let path = db_path(app)?;
    let mut guard = db.lock().map_err(map_err)?;
    // swap in a dummy connection to release the file locks (needed on Windows)
    let placeholder = rusqlite::Connection::open_in_memory().map_err(map_err)?;
    let old = std::mem::replace(&mut *guard, placeholder);
    drop(old);
    let wal = std::path::PathBuf::from(format!("{}-wal", path.to_string_lossy()));
    let shm = std::path::PathBuf::from(format!("{}-shm", path.to_string_lossy()));
    let _ = std::fs::remove_file(&wal);
    let _ = std::fs::remove_file(&shm);
    std::fs::copy(src_db, &path).map_err(map_err)?;
    // the WAL must be in place before reopening so db::open folds it in
    if let Some(w) = src_wal.filter(|w| w.is_file()) {
        std::fs::copy(w, &wal).map_err(map_err)?;
    }
    // reopen (runs migrations) and use it
    *guard = db::open(&path).map_err(map_err)?;
    drop(guard);
    // lock the session
    if let Ok(mut d) = dek_state.lock() {
        *d = None;
    }
    Ok(())
}

/* ---- video streaming (decrypting custom protocol) -------------------- */

fn video_mime(path: &str) -> &'static str {
    match path.rsplit('.').next().map(|e| e.to_ascii_lowercase()).as_deref() {
        Some("webm") => "video/webm",
        Some("mov") => "video/quicktime",
        Some("m4v") => "video/x-m4v",
        Some("mkv") => "video/x-matroska",
        Some("avi") => "video/x-msvideo",
        Some("wmv") => "video/x-ms-wmv",
        Some("flv") => "video/x-flv",
        _ => "video/mp4",
    }
}

/// MIME type of a media file (for the LAN share).
fn media_mime(path: &str) -> &'static str {
    match path.rsplit('.').next().map(|e| e.to_ascii_lowercase()).as_deref() {
        Some("jpg") | Some("jpeg") | Some("jfif") => "image/jpeg",
        Some("png") => "image/png",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("bmp") => "image/bmp",
        Some("avif") => "image/avif",
        Some("tif") | Some("tiff") => "image/tiff",
        Some("zip") => "application/zip",
        Some("webm") | Some("mov") | Some("m4v") | Some("mkv") | Some("avi") | Some("wmv")
        | Some("flv") | Some("mp4") => video_mime(path),
        _ => "application/octet-stream",
    }
}

/// Parse a "Range: bytes=start-end" header into (start, end).
fn parse_range(header: &str, total: usize) -> Option<(usize, usize)> {
    let spec = header.trim().strip_prefix("bytes=")?;
    let mut it = spec.splitn(2, '-');
    let s = it.next()?.trim();
    let e = it.next().unwrap_or("").trim();
    if total == 0 {
        return None;
    }
    if s.is_empty() {
        // "bytes=-N" = the last N bytes
        let n: usize = e.parse().ok()?;
        if n == 0 {
            return None;
        }
        return Some((total.saturating_sub(n), total - 1));
    }
    let start: usize = s.parse().ok()?;
    let end: usize = if e.is_empty() { total - 1 } else { e.parse().ok()? };
    if start > end || start >= total {
        return None;
    }
    Some((start, end.min(total - 1)))
}

/// Read len bytes from start without loading the whole file.
fn read_window(p: &std::path::Path, start: usize, len: usize) -> std::io::Result<Vec<u8>> {
    use std::io::{Read, Seek, SeekFrom};
    let mut f = std::fs::File::open(p)?;
    f.seek(SeekFrom::Start(start as u64))?;
    let mut buf = vec![0u8; len];
    f.read_exact(&mut buf)?;
    Ok(buf)
}

/// Max size of one Range response. Videos ask for "bytes=0-" (everything),
/// answering fully used hundreds of MB per request and crashed WebView2.
/// A shorter answer is valid HTTP, the client asks for the rest.
const RANGE_CHUNK: usize = 8 * 1024 * 1024;

/// Serve media over micollmedia:// (full files with Range for seeking, and
/// cached thumbnails with ?thumb=N). Encrypted files are decrypted. ETag from
/// (path, mtime, size) so edits show up right away (no-cache -> cheap 304).
fn serve_media(app: &AppHandle, request: &tauri::http::Request<Vec<u8>>) -> tauri::http::Response<Vec<u8>> {
    let bail = |code: u16| {
        tauri::http::Response::builder()
            .status(code)
            .header("Access-Control-Allow-Origin", "*")
            .body(Vec::new())
            .unwrap()
    };
    // the path is the URL path (percent-encoded by convertFileSrc)
    let raw = request.uri().path().trim_start_matches('/');
    let path = match urlencoding::decode(raw) {
        Ok(p) => p.into_owned(),
        Err(_) => return bail(400),
    };
    let pth = std::path::Path::new(&path);
    let Ok(meta) = std::fs::metadata(pth) else {
        // file not reachable + thumbnail request -> the saved MiSD preview. Full files
        // still 404.
        let wants_thumb = request
            .uri()
            .query()
            .unwrap_or("")
            .split('&')
            .any(|kv| kv.starts_with("thumb="));
        if wants_thumb {
            if let Ok(cache) = app_cache(app) {
                let key = session_key(&app.state::<DekState>());
                if let Some(jpeg) = thumbs::sd_preview_jpeg(&cache.join("thumbs"), &path, key) {
                    return tauri::http::Response::builder()
                        .status(200)
                        .header("Content-Type", "image/jpeg")
                        .header("Content-Length", jpeg.len().to_string())
                        .header("Cache-Control", "no-cache")
                        .header("Access-Control-Allow-Origin", "*")
                        .body(jpeg)
                        .unwrap();
                }
            }
        }
        return bail(404);
    };
    if !meta.is_file() {
        return bail(404);
    }

    let key = session_key(&app.state::<DekState>());
    // locked + encrypted -> refuse before any cache shortcut
    if crypto::file_is_encrypted(pth) && key.is_none() {
        return bail(403);
    }

    // ?thumb=N -> the cached thumbnail
    let thumb_size: Option<u32> = request
        .uri()
        .query()
        .unwrap_or("")
        .split('&')
        .find_map(|kv| kv.strip_prefix("thumb="))
        .and_then(|v| v.parse().ok());

    // ?gif=N -> a GIF cover re-encoded to fit N x N (see thumbs::gif_thumb)
    let gif_size: Option<u32> = request
        .uri()
        .query()
        .unwrap_or("")
        .split('&')
        .find_map(|kv| kv.strip_prefix("gif="))
        .and_then(|v| v.parse().ok());

    // ?preview=N -> for VERY large images a cached smaller JPEG (fit N x N).
    // Smaller images are served normally. Used by "Optimize large images".
    let preview_size: Option<u32> = request
        .uri()
        .query()
        .unwrap_or("")
        .split('&')
        .find_map(|kv| kv.strip_prefix("preview="))
        .and_then(|v| v.parse().ok());

    // cheap ETag: path + mtime + size (+ thumb size)
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let etag = {
        use std::hash::{Hash, Hasher};
        let mut h = std::collections::hash_map::DefaultHasher::new();
        path.hash(&mut h);
        mtime.hash(&mut h);
        meta.len().hash(&mut h);
        thumb_size.unwrap_or(0).hash(&mut h);
        gif_size.unwrap_or(0).hash(&mut h);
        preview_size.unwrap_or(0).hash(&mut h);
        format!("\"{:016x}\"", h.finish())
    };
    if request
        .headers()
        .get("if-none-match")
        .and_then(|v| v.to_str().ok())
        == Some(etag.as_str())
    {
        return tauri::http::Response::builder()
            .status(304)
            .header("ETag", etag)
            .header("Cache-Control", "no-cache")
            .header("Access-Control-Allow-Origin", "*")
            .body(Vec::new())
            .unwrap();
    }

    if let Some(size) = thumb_size {
        let Ok(cache) = app_cache(app) else {
            return bail(500);
        };
        return match thumbs::thumb_jpeg(&cache.join("thumbs"), &path, size.clamp(64, 1024), key) {
            Ok(jpeg) => tauri::http::Response::builder()
                .status(200)
                .header("Content-Type", "image/jpeg")
                .header("Content-Length", jpeg.len().to_string())
                .header("ETag", etag)
                .header("Cache-Control", "no-cache")
                .header("Access-Control-Allow-Origin", "*")
                .body(jpeg)
                .unwrap(),
            Err(_) => bail(415), // not decodable (e.g. a video) — no thumbnail
        };
    }

    // ?gif=N: if it's not worth it (already small, can't decode) serve the original
    if let Some(edge) = gif_size {
        if path.to_ascii_lowercase().ends_with(".gif") {
            if let Ok(cache) = app_cache(app) {
                if let Ok(Some(bytes)) = thumbs::gif_thumb(&cache.join("thumbs"), &path, edge, key) {
                    return tauri::http::Response::builder()
                        .status(200)
                        .header("Content-Type", "image/gif")
                        .header("Content-Length", bytes.len().to_string())
                        .header("ETag", etag)
                        .header("Cache-Control", "no-cache")
                        .header("Access-Control-Allow-Origin", "*")
                        .body(bytes)
                        .unwrap();
                }
            }
        }
    }

    // ?preview=N: only for images over 3000 px on both sides, cached. Anything else
    // (or any failure) serves the original.
    if let Some(edge) = preview_size {
        let huge = thumbs::dimensions(&path, key)
            .map(|(w, h)| w > 3000 && h > 3000)
            .unwrap_or(false);
        if huge {
            if let Ok(cache) = app_cache(app) {
                if let Ok(jpeg) =
                    thumbs::thumb_jpeg(&cache.join("previews"), &path, edge.clamp(1024, 4096), key)
                {
                    return tauri::http::Response::builder()
                        .status(200)
                        .header("Content-Type", "image/jpeg")
                        .header("Content-Length", jpeg.len().to_string())
                        .header("ETag", etag)
                        .header("Cache-Control", "no-cache")
                        .header("Access-Control-Allow-Origin", "*")
                        .body(jpeg)
                        .unwrap();
                }
            }
        }
        // not huge (or failed) -> serve normally
    }

    let ctype = media_mime(&path);
    let range_hdr = request.headers().get("range").and_then(|v| v.to_str().ok());
    // Access-Control-Allow-Origin on every response so canvas reads (video thumbs, glow)
    // work
    let part = |start: usize, end: usize, total: usize, body: Vec<u8>| {
        tauri::http::Response::builder()
            .status(206)
            .header("Content-Type", ctype)
            .header("Accept-Ranges", "bytes")
            .header("Access-Control-Allow-Origin", "*")
            .header("Content-Range", format!("bytes {start}-{end}/{total}"))
            .header("Content-Length", body.len().to_string())
            .body(body)
            .unwrap()
    };

    // plain files: seek + read only the requested window (capped)
    if !crypto::file_is_encrypted(pth) {
        let total = meta.len() as usize;
        if let Some((start, end)) = range_hdr.and_then(|r| parse_range(r, total)) {
            let end = end.min(start.saturating_add(RANGE_CHUNK - 1));
            return match read_window(pth, start, end - start + 1) {
                Ok(body) => part(start, end, total, body),
                Err(_) => bail(404),
            };
        }
        let data = match std::fs::read(pth) {
            Ok(b) => b,
            Err(_) => return bail(404),
        };
        return tauri::http::Response::builder()
            .status(200)
            .header("Content-Type", ctype)
            .header("Accept-Ranges", "bytes")
            .header("Access-Control-Allow-Origin", "*")
            .header("ETag", etag)
            .header("Cache-Control", "no-cache")
            .header("Content-Length", data.len().to_string())
            .body(data)
            .unwrap();
    }

    // encrypted files: must be decrypted fully (no random access), the body is still capped
    let bytes = match std::fs::read(pth) {
        Ok(b) => b,
        Err(_) => return bail(404),
    };
    let data = match key {
        Some(k) => match crypto::Dek::from_bytes(k).decrypt_bytes(&bytes) {
            Ok(d) => d,
            Err(_) => return bail(403),
        },
        None => return bail(403), // locked
    };
    let total = data.len();
    if let Some((start, end)) = range_hdr.and_then(|r| parse_range(r, total)) {
        let end = end.min(start.saturating_add(RANGE_CHUNK - 1));
        return part(start, end, total, data[start..=end].to_vec());
    }
    tauri::http::Response::builder()
        .status(200)
        .header("Content-Type", ctype)
        .header("Accept-Ranges", "bytes")
        .header("Access-Control-Allow-Origin", "*")
        .header("ETag", etag)
        .header("Cache-Control", "no-cache")
        .header("Content-Length", total.to_string())
        .body(data)
        .unwrap()
}

/* ---- share to phone (LAN QR) ----------------------------------------- */

/// The PC's LAN IP (asks which interface routes outward, no packets are sent).
fn lan_ip() -> Option<std::net::IpAddr> {
    let sock = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    sock.connect("8.8.8.8:80").ok()?;
    sock.local_addr().ok().map(|a| a.ip())
}

/// Handle one request: /s/<token> -> the (decrypted) file with Range support.
/// Unknown/expired tokens -> 404.
fn handle_share(
    app: &AppHandle,
    tokens: &std::sync::Arc<std::sync::Mutex<std::collections::HashMap<String, ShareEntry>>>,
    req: tiny_http::Request,
) {
    let hdr = |k: &str, v: &str| tiny_http::Header::from_bytes(k.as_bytes(), v.as_bytes()).unwrap();
    let fail = |req: tiny_http::Request, code: u16| {
        let _ = req.respond(tiny_http::Response::from_string("").with_status_code(code));
    };

    let url = req.url().to_string();
    let token = url
        .trim_start_matches('/')
        .strip_prefix("s/")
        .map(|s| s.split('?').next().unwrap_or(s).to_string());
    let path = token.and_then(|t| {
        let mut map = tokens.lock().ok()?;
        let now = std::time::Instant::now();
        // remove expired links and their temp zips
        let dead: Vec<String> = map.iter().filter(|(_, e)| e.expires <= now).map(|(k, _)| k.clone()).collect();
        for k in dead {
            if let Some(e) = map.remove(&k) {
                if e.cleanup {
                    let _ = std::fs::remove_file(&e.path);
                }
            }
        }
        map.get(&t).map(|e| e.path.clone())
    });
    let path = match path {
        Some(p) if p.is_file() => p,
        _ => return fail(req, 404),
    };

    let path_str = path.to_string_lossy().into_owned();
    let ctype = media_mime(&path_str);
    let fname = path.file_name().and_then(|n| n.to_str()).unwrap_or("file");
    let disp = format!("inline; filename=\"{fname}\"");

    let range = req
        .headers()
        .iter()
        .find(|h| h.field.equiv("Range"))
        .map(|h| h.value.as_str().to_string());

    // plain files: answer Range with a seek + capped window (phones seek a lot in videos)
    if !crypto::file_is_encrypted(&path) {
        if let Some(r) = &range {
            let total = match std::fs::metadata(&path) {
                Ok(m) => m.len() as usize,
                Err(_) => return fail(req, 404),
            };
            if let Some((start, end)) = parse_range(r, total) {
                let end = end.min(start.saturating_add(RANGE_CHUNK - 1));
                let Ok(body) = read_window(&path, start, end - start + 1) else {
                    return fail(req, 404);
                };
                let resp = tiny_http::Response::from_data(body)
                    .with_status_code(206)
                    .with_header(hdr("Content-Type", ctype))
                    .with_header(hdr("Accept-Ranges", "bytes"))
                    .with_header(hdr("Content-Range", &format!("bytes {start}-{end}/{total}")))
                    .with_header(hdr("Content-Disposition", &disp));
                let _ = req.respond(resp);
                return;
            }
        }
    }

    let bytes = match std::fs::read(&path) {
        Ok(b) => b,
        Err(_) => return fail(req, 404),
    };
    let data = if crypto::is_encrypted(&bytes) {
        match session_key(&app.state::<DekState>()) {
            Some(k) => match crypto::Dek::from_bytes(k).decrypt_bytes(&bytes) {
                Ok(d) => d,
                Err(_) => return fail(req, 403),
            },
            None => return fail(req, 503), // MiColl is locked
        }
    } else {
        bytes
    };
    let total = data.len();

    if let Some(r) = range {
        if let Some((start, end)) = parse_range(&r, total) {
            let end = end.min(start.saturating_add(RANGE_CHUNK - 1));
            let resp = tiny_http::Response::from_data(data[start..=end].to_vec())
                .with_status_code(206)
                .with_header(hdr("Content-Type", ctype))
                .with_header(hdr("Accept-Ranges", "bytes"))
                .with_header(hdr("Content-Range", &format!("bytes {start}-{end}/{total}")))
                .with_header(hdr("Content-Disposition", &disp));
            let _ = req.respond(resp);
            return;
        }
    }
    let resp = tiny_http::Response::from_data(data)
        .with_status_code(200)
        .with_header(hdr("Content-Type", ctype))
        .with_header(hdr("Accept-Ranges", "bytes"))
        .with_header(hdr("Content-Disposition", &disp));
    let _ = req.respond(resp);
}

/// Start the LAN share server once and return its port.
fn ensure_share_server(app: &AppHandle, share: &State<ShareState>) -> Result<u16, String> {
    let mut inner = share.lock().map_err(map_err)?;
    if let Some(p) = inner.port {
        return Ok(p);
    }
    let server = tiny_http::Server::http("0.0.0.0:0").map_err(|e| e.to_string())?;
    let port = server
        .server_addr()
        .to_ip()
        .map(|a| a.port())
        .ok_or_else(|| "Couldn't bind a local port.".to_string())?;
    inner.port = Some(port);
    let tokens = inner.tokens.clone();
    let app2 = app.clone();
    std::thread::spawn(move || {
        for req in server.incoming_requests() {
            handle_share(&app2, &tokens, req);
        }
    });
    Ok(port)
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ShareInfo {
    url: String,
    qr_svg: String,
    expires_secs: u64,
}

/// Register a file under a random time-limited token, return URL + QR.
/// cleanup = it's a temp zip to delete when the link ends.
fn publish_share(
    app: &AppHandle,
    share: &State<ShareState>,
    path: std::path::PathBuf,
    cleanup: bool,
) -> Result<ShareInfo, String> {
    if !path.is_file() {
        return Err("File not found.".into());
    }
    let port = ensure_share_server(app, share)?;
    let ip = lan_ip()
        .ok_or("Couldn't find your local network address — are you on Wi-Fi/LAN?".to_string())?;

    let mut raw = [0u8; 16];
    rand::RngCore::fill_bytes(&mut rand::thread_rng(), &mut raw);
    let token: String = raw.iter().map(|b| format!("{b:02x}")).collect();

    const TTL: u64 = 600; // 10 minutes
    let tokens = { share.lock().map_err(map_err)?.tokens.clone() };
    tokens.lock().map_err(map_err)?.insert(
        token.clone(),
        ShareEntry {
            path,
            expires: std::time::Instant::now() + std::time::Duration::from_secs(TTL),
            cleanup,
        },
    );

    let url = format!("http://{ip}:{port}/s/{token}");
    let code = qrcode::QrCode::new(url.as_bytes()).map_err(map_err)?;
    let qr_svg = code
        .render::<qrcode::render::svg::Color>()
        .min_dimensions(240, 240)
        .quiet_zone(true)
        .build();
    Ok(ShareInfo { url, qr_svg, expires_secs: TTL })
}

/// Share one file on the LAN (scan the QR on the phone).
#[tauri::command]
fn share_to_phone(app: AppHandle, share: State<ShareState>, path: String) -> Result<ShareInfo, String> {
    publish_share(&app, &share, std::path::PathBuf::from(&path), false)
}

/// Zip a reward's (decrypted) files and share that.
#[tauri::command]
async fn share_folder_to_phone(
    app: AppHandle,
    share: State<'_, ShareState>,
    dek: State<'_, DekState>,
    srcs: Vec<String>,
    name: String,
) -> Result<ShareInfo, String> {
    let key = session_key(&dek);
    let cache = app_cache(&app)?;
    let app2 = app.clone();
    let zip_path = tauri::async_runtime::spawn_blocking(move || build_reward_zip(&app2, srcs, key, &cache, &name))
        .await
        .map_err(|e| e.to_string())??;
    publish_share(&app, &share, zip_path, true)
}

/// Stop all share links (when the dialog closes) and delete temp zips.
#[tauri::command]
fn stop_sharing(share: State<ShareState>) -> Result<(), String> {
    let inner = share.lock().map_err(map_err)?;
    let mut map = inner.tokens.lock().map_err(map_err)?;
    for e in map.values() {
        if e.cleanup {
            let _ = std::fs::remove_file(&e.path);
        }
    }
    map.clear();
    Ok(())
}

/// Read a file, decrypting it if needed.
fn read_decrypted(path: &std::path::Path, key: Option<[u8; 32]>) -> Result<Vec<u8>, String> {
    let bytes = std::fs::read(path).map_err(map_err)?;
    if crypto::is_encrypted(&bytes) {
        match key {
            Some(k) => crypto::Dek::from_bytes(k)
                .decrypt_bytes(&bytes)
                .map_err(|_| "Couldn't decrypt — is MiColl unlocked?".to_string()),
            None => Err("MiColl is locked — unlock first.".into()),
        }
    } else {
        Ok(bytes)
    }
}

/// Make a temp .zip of a reward's decrypted files (stored, media is already compressed).
/// Returns the path. app is unused for now.
fn build_reward_zip(
    _app: &AppHandle,
    srcs: Vec<String>,
    key: Option<[u8; 32]>,
    cache: &std::path::Path,
    name: &str,
) -> Result<std::path::PathBuf, String> {
    use std::io::Write;
    let dir = cache.join("share-tmp");
    std::fs::create_dir_all(&dir).map_err(map_err)?;
    let zip_path = dir.join(format!("{}.zip", sanitize_name(name)));
    let file = std::fs::File::create(&zip_path).map_err(map_err)?;
    let mut zip = zip::ZipWriter::new(file);
    let opts: zip::write::SimpleFileOptions =
        zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
    let mut used = std::collections::HashSet::new();
    for s in &srcs {
        let p = std::path::Path::new(s);
        let data = read_decrypted(p, key)?;
        let base = p.file_name().and_then(|n| n.to_str()).unwrap_or("file").to_string();
        // avoid duplicate names across subfolders
        let mut entry = base.clone();
        let mut i = 2;
        while !used.insert(entry.clone()) {
            entry = match base.rsplit_once('.') {
                Some((stem, ext)) => format!("{stem} ({i}).{ext}"),
                None => format!("{base} ({i})"),
            };
            i += 1;
        }
        zip.start_file(entry, opts).map_err(map_err)?;
        zip.write_all(&data).map_err(map_err)?;
    }
    zip.finish().map_err(map_err)?;
    Ok(zip_path)
}

/// Save a decrypted copy of a media file to dest ("Save a copy...").
#[tauri::command]
fn export_file(dek: State<DekState>, src: String, dest: String) -> Result<(), String> {
    let bytes = std::fs::read(&src).map_err(map_err)?;
    let data = if crypto::is_encrypted(&bytes) {
        match session_key(&dek) {
            Some(k) => crypto::Dek::from_bytes(k)
                .decrypt_bytes(&bytes)
                .map_err(|_| "Couldn't decrypt the file.".to_string())?,
            None => return Err("MiColl is locked — unlock to export.".into()),
        }
    } else {
        bytes
    };
    std::fs::write(&dest, data).map_err(map_err)?;
    Ok(())
}

/// Save a reward's decrypted files into dest_dir/<name>/. Returns the count.
#[tauri::command]
async fn export_files(
    dek: State<'_, DekState>,
    srcs: Vec<String>,
    dest_dir: String,
    name: String,
) -> Result<u32, String> {
    let key = session_key(&dek);
    tauri::async_runtime::spawn_blocking(move || -> Result<u32, String> {
        let target = std::path::Path::new(&dest_dir).join(sanitize_name(&name));
        std::fs::create_dir_all(&target).map_err(map_err)?;
        let mut n = 0u32;
        for s in &srcs {
            let p = std::path::Path::new(s);
            let data = read_decrypted(p, key)?;
            if let Some(fname) = p.file_name() {
                let dest = unique_dest(&target, fname);
                std::fs::write(&dest, data).map_err(map_err)?;
                n += 1;
            }
        }
        Ok(n)
    })
    .await
    .map_err(|e| e.to_string())?
}

/* ---- native share destinations (clipboard + Windows share sheet) ----- */

/// Where decrypted copies for the clipboard/share sheet go. Not share-tmp (that one
/// is wiped when the dialog closes, clipboard paths must live longer).
fn share_stage_dir(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(app_cache(app)?.join("share-stage"))
}

/// Put files on the clipboard like Explorer (Ctrl+V into Discord, Telegram...).
/// Returns the count.
#[tauri::command]
async fn copy_files_to_clipboard(
    app: AppHandle,
    dek: State<'_, DekState>,
    srcs: Vec<String>,
) -> Result<u32, String> {
    let key = session_key(&dek);
    let dir = share_stage_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || -> Result<u32, String> {
        let paths = wshare::stage(&dir, &srcs, key)?;
        wshare::copy_files(&paths)?;
        Ok(paths.len() as u32)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Put a single image on the clipboard as a picture.
#[tauri::command]
async fn copy_image_to_clipboard(dek: State<'_, DekState>, src: String) -> Result<(), String> {
    let key = session_key(&dek);
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let data = read_decrypted(std::path::Path::new(&src), key)?;
        let img = image::load_from_memory(&data)
            .map_err(|e| format!("MiColl couldn’t read that as an image ({e})."))?;
        // re-encode, the PNG clipboard format must really be PNG (the source is often
        // JPEG/WebP)
        let mut png = std::io::Cursor::new(Vec::new());
        img.write_to(&mut png, image::ImageFormat::Png).map_err(map_err)?;
        wshare::copy_image(&png.into_inner(), &img.to_rgba8())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Open the Windows share sheet for files (only registered apps, the clipboard covers the
/// rest).
#[cfg(windows)]
#[tauri::command]
async fn windows_share(
    app: AppHandle,
    window: tauri::WebviewWindow,
    dek: State<'_, DekState>,
    srcs: Vec<String>,
    name: String,
) -> Result<(), String> {
    let key = session_key(&dek);
    let dir = share_stage_dir(&app)?;
    // stage off the UI thread (decrypting a whole reward would freeze it)
    let paths = tauri::async_runtime::spawn_blocking(move || wshare::stage(&dir, &srcs, key))
        .await
        .map_err(|e| e.to_string())??;
    let paths: Vec<String> = paths.iter().map(|p| p.to_string_lossy().into_owned()).collect();

    // the sheet must be made on the window's thread (see wshare::show_share_sheet),
    // and the result is sent back so errors show as a toast
    let (tx, rx) = std::sync::mpsc::channel();
    let win = window.clone();
    window
        .run_on_main_thread(move || {
            let res = match win.hwnd() {
                Ok(h) => wshare::show_share_sheet(h.0 as isize, paths, name),
                Err(e) => Err(map_err(e)),
            };
            let _ = tx.send(res);
        })
        .map_err(map_err)?;
    rx.recv_timeout(std::time::Duration::from_secs(15))
        .map_err(|_| "The Windows share sheet didn’t respond.".to_string())?
}

#[cfg(not(windows))]
#[tauri::command]
async fn windows_share(_srcs: Vec<String>, _name: String) -> Result<(), String> {
    Err("The system share sheet is only available on Windows.".into())
}

/* ---- Volume mixer name ---------------------------------------------- */

/// Rename our audio sessions to "MiColl" in the volume mixer (see audio.rs).
/// Called when a video starts, the session only exists while playing.
#[cfg(windows)]
#[tauri::command]
async fn claim_audio_name() -> Result<u32, String> {
    tauri::async_runtime::spawn_blocking(|| audio::claim("MiColl"))
        .await
        .map_err(map_err)
}

#[cfg(not(windows))]
#[tauri::command]
async fn claim_audio_name() -> Result<u32, String> {
    Ok(0)
}

/* ---- MEGA upload (via the official MEGAcmd CLI) ---------------------- */

/// Build a Command for a MEGAcmd command (e.g. "mega-put"). On Windows MEGAcmd has
/// .bat wrappers, run via cmd /C without a console. None if MEGAcmd isn't found.
#[cfg(windows)]
fn megacmd_dirs() -> Vec<std::path::PathBuf> {
    let mut dirs: Vec<std::path::PathBuf> = Vec::new();
    for var in ["LOCALAPPDATA", "ProgramFiles", "ProgramFiles(x86)"] {
        if let Ok(p) = std::env::var(var) {
            dirs.push(std::path::PathBuf::from(p).join("MEGAcmd"));
        }
    }
    dirs
}

#[cfg(windows)]
fn mega_command(name: &str) -> Option<std::process::Command> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    for d in megacmd_dirs() {
        let bat = d.join(format!("{name}.bat"));
        if bat.is_file() {
            let mut c = std::process::Command::new("cmd");
            c.arg("/C").arg(bat).creation_flags(CREATE_NO_WINDOW);
            return Some(c);
        }
    }
    None
}

#[cfg(not(windows))]
fn mega_command(name: &str) -> Option<std::process::Command> {
    Some(std::process::Command::new(name))
}

/// Open the MEGAcmd app so the user can log in.
#[cfg(windows)]
#[tauri::command]
fn open_megacmd() -> Result<(), String> {
    for d in megacmd_dirs() {
        for exe in ["MEGAcmd.exe", "MEGAcmdShell.exe"] {
            let p = d.join(exe);
            if p.is_file() {
                std::process::Command::new(&p).spawn().map_err(map_err)?;
                return Ok(());
            }
        }
    }
    Err("Couldn't find the MEGAcmd app — open it from the Start menu and run `login`.".into())
}

#[cfg(not(windows))]
#[tauri::command]
fn open_megacmd() -> Result<(), String> {
    std::process::Command::new("mega-cmd")
        .spawn()
        .map_err(|_| "Couldn't open MEGAcmd.".to_string())?;
    Ok(())
}

/// Decode MEGAcmd output: UTF-16 with BOM on Windows, else UTF-8.
fn decode_cli(bytes: &[u8]) -> String {
    if bytes.len() >= 2 && bytes[0] == 0xFF && bytes[1] == 0xFE {
        let u16s: Vec<u16> = bytes[2..]
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        String::from_utf16_lossy(&u16s)
    } else if bytes.len() >= 2 && bytes[0] == 0xFE && bytes[1] == 0xFF {
        let u16s: Vec<u16> = bytes[2..]
            .chunks_exact(2)
            .map(|c| u16::from_be_bytes([c[0], c[1]]))
            .collect();
        String::from_utf16_lossy(&u16s)
    } else {
        String::from_utf8_lossy(bytes).into_owned()
    }
}

/// Run a MEGAcmd command with a timeout, reading stdout/stderr on threads so it
/// can't hang. Returns (exit code, stdout, stderr). Blocks, so never on the UI thread.
fn run_mega_timed(
    name: &str,
    args: &[&str],
    timeout: std::time::Duration,
) -> Result<(i32, String, String), String> {
    use std::io::Read;
    let mut cmd = mega_command(name)
        .ok_or_else(|| "MEGAcmd isn't installed (or wasn't found).".to_string())?;
    cmd.args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            "MEGAcmd isn't installed (or wasn't found).".to_string()
        } else {
            e.to_string()
        }
    })?;

    // read both pipes at the same time so a full buffer can't stall it
    let mut so = child.stdout.take();
    let mut se = child.stderr.take();
    let t_out = std::thread::spawn(move || {
        let mut b = Vec::new();
        if let Some(s) = so.as_mut() {
            let _ = s.read_to_end(&mut b);
        }
        b
    });
    let t_err = std::thread::spawn(move || {
        let mut b = Vec::new();
        if let Some(s) = se.as_mut() {
            let _ = s.read_to_end(&mut b);
        }
        b
    });

    let start = std::time::Instant::now();
    let status = loop {
        match child.try_wait().map_err(map_err)? {
            Some(st) => break st,
            None => {
                if start.elapsed() > timeout {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(
                        "MEGAcmd didn't respond in time — is the MEGAcmd server running, and are you logged in (mega-login)?"
                            .to_string(),
                    );
                }
                std::thread::sleep(std::time::Duration::from_millis(120));
            }
        }
    };
    let out = t_out.join().unwrap_or_default();
    let err = t_err.join().unwrap_or_default();
    Ok((status.code().unwrap_or(-1), decode_cli(&out), decode_cli(&err)))
}

/// Path of a MEGAcmd command (for diagnostics).
#[cfg(windows)]
fn mega_resolved_path(name: &str) -> Option<String> {
    for d in megacmd_dirs() {
        let b = d.join(format!("{name}.bat"));
        if b.is_file() {
            return Some(b.to_string_lossy().into_owned());
        }
    }
    None
}
#[cfg(not(windows))]
fn mega_resolved_path(name: &str) -> Option<String> {
    Some(name.to_string())
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct MegaStatus {
    installed: bool,
    logged_in: bool,
    account: Option<String>,
    /// Raw mega-whoami details for the diagnostics box.
    raw: Option<String>,
}

/// Clean MEGAcmd output: keep only printable ASCII + whitespace (UTF-16 leaves NUL bytes).
fn clean_cli_text(text: &str) -> String {
    text.chars()
        .filter(|&c| c == '\n' || c == '\t' || c == ' ' || c.is_ascii_graphic())
        .collect()
}

/// Find an email in the whoami output.
fn parse_mega_email(text: &str) -> Option<String> {
    clean_cli_text(text).split_whitespace().find_map(|w| {
        w.split_once('@')
            .filter(|(user, dom)| !user.is_empty() && dom.contains('.') && dom.len() >= 3)
            .map(|_| w.to_string())
    })
}

/// Is MEGAcmd installed and logged in? Async so a slow first call doesn't freeze the UI.
#[tauri::command]
async fn mega_status() -> MegaStatus {
    tauri::async_runtime::spawn_blocking(|| {
        if mega_command("mega-whoami").is_none() {
            return MegaStatus { installed: false, logged_in: false, account: None, raw: None };
        }
        let cmd_path = mega_resolved_path("mega-whoami").unwrap_or_else(|| "mega-whoami".into());
        match run_mega_timed("mega-whoami", &[], std::time::Duration::from_secs(40)) {
            Ok((code, out, err)) => {
                let email = parse_mega_email(&out).or_else(|| parse_mega_email(&err));
                let raw = Some(format!(
                    "cmd: {cmd_path}\nexit: {code}\n--- stdout ---\n{}\n--- stderr ---\n{}",
                    clean_cli_text(&out).trim(),
                    clean_cli_text(&err).trim()
                ));
                match email {
                    Some(account) => MegaStatus { installed: true, logged_in: true, account: Some(account), raw },
                    None => MegaStatus { installed: true, logged_in: false, account: None, raw },
                }
            }
            Err(e) => MegaStatus {
                installed: true,
                logged_in: false,
                account: None,
                raw: Some(format!("cmd: {cmd_path}\nerror: {e}")),
            },
        }
    })
    .await
    .unwrap_or(MegaStatus { installed: false, logged_in: false, account: None, raw: None })
}

/// Upload a (decrypted) copy of a file to MEGA into folder (created if missing).
/// Encrypted files are decrypted to a temp file that's deleted after. Async.
#[tauri::command]
async fn mega_upload(
    app: AppHandle,
    dek: State<'_, DekState>,
    src: String,
    folder: String,
) -> Result<(), String> {
    let key = session_key(&dek);
    let cache = app_cache(&app)?;
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let srcp = std::path::Path::new(&src);
        if !srcp.is_file() {
            return Err("File not found.".into());
        }
        if mega_command("mega-put").is_none() {
            return Err("MEGAcmd isn't installed. Install it and run `mega-login` once.".into());
        }

        let bytes = std::fs::read(srcp).map_err(map_err)?;
        let data = if crypto::is_encrypted(&bytes) {
            match key {
                Some(k) => crypto::Dek::from_bytes(k)
                    .decrypt_bytes(&bytes)
                    .map_err(|_| "Couldn't decrypt the file.".to_string())?,
                None => return Err("MiColl is locked — unlock to upload.".into()),
            }
        } else {
            bytes
        };

        let fname = srcp.file_name().and_then(|n| n.to_str()).unwrap_or("file");
        let tmpdir = cache.join("mega-tmp");
        std::fs::create_dir_all(&tmpdir).map_err(map_err)?;
        let tmp = tmpdir.join(fname);
        std::fs::write(&tmp, &data).map_err(map_err)?;

        let folder = {
            let f = folder.trim();
            if f.is_empty() { "/".to_string() } else { f.to_string() }
        };
        let _ = run_mega_timed("mega-mkdir", &["-p", &folder], std::time::Duration::from_secs(60));
        let dest = if folder.ends_with('/') { folder.clone() } else { format!("{folder}/") };

        let result = run_mega_timed(
            "mega-put",
            &[&tmp.to_string_lossy(), &dest],
            std::time::Duration::from_secs(1800),
        );
        let _ = std::fs::remove_file(&tmp); // delete the plaintext immediately
        let (code, out, err) = result?;
        if code != 0 {
            let err = clean_cli_text(&err);
            let out = clean_cli_text(&out);
            let msg = if !err.trim().is_empty() {
                err.trim().to_string()
            } else {
                out.trim().to_string()
            };
            return Err(if msg.is_empty() {
                "MEGA upload failed. Is MEGAcmd logged in (run `mega-login`)?".to_string()
            } else {
                format!("MEGA upload failed: {msg}")
            });
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Upload a reward's (decrypted) files to MEGA under folder/<name>/.
/// Decrypted into a temp folder, uploaded, then removed.
#[tauri::command]
async fn mega_upload_files(
    app: AppHandle,
    dek: State<'_, DekState>,
    srcs: Vec<String>,
    folder: String,
    name: String,
) -> Result<(), String> {
    let key = session_key(&dek);
    let cache = app_cache(&app)?;
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        if mega_command("mega-put").is_none() {
            return Err("MEGAcmd isn't installed. Install it and run `mega-login` once.".into());
        }
        // decrypt into cache/mega-tmp/<name>/
        let tmpdir = cache.join("mega-tmp").join(sanitize_name(&name));
        let _ = std::fs::remove_dir_all(&tmpdir);
        std::fs::create_dir_all(&tmpdir).map_err(map_err)?;
        for s in &srcs {
            let p = std::path::Path::new(s);
            let data = read_decrypted(p, key)?;
            if let Some(fname) = p.file_name() {
                let dest = unique_dest(&tmpdir, fname);
                std::fs::write(&dest, data).map_err(map_err)?;
            }
        }

        let folder = {
            let f = folder.trim();
            if f.is_empty() { "/".to_string() } else { f.to_string() }
        };
        let _ = run_mega_timed("mega-mkdir", &["-p", &folder], std::time::Duration::from_secs(60));
        let dest = if folder.ends_with('/') { folder.clone() } else { format!("{folder}/") };
        // -c creates the remote path, the folder lands as <folder>/<name>/
        let result = run_mega_timed(
            "mega-put",
            &["-c", &tmpdir.to_string_lossy(), &dest],
            std::time::Duration::from_secs(1800),
        );
        let _ = std::fs::remove_dir_all(&tmpdir); // delete plaintext immediately
        let (code, out, err) = result?;
        if code != 0 {
            let err = clean_cli_text(&err);
            let out = clean_cli_text(&out);
            let msg = if !err.trim().is_empty() { err.trim().to_string() } else { out.trim().to_string() };
            return Err(if msg.is_empty() {
                "MEGA upload failed. Is MEGAcmd logged in (run `mega-login`)?".to_string()
            } else {
                format!("MEGA upload failed: {msg}")
            });
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/* ---- MEGA upload with optional downscale ------------------------------ */

/// How to shrink images before upload. One field is used, never bigger, keeps the ratio.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResizeSpec {
    /// Scale to this percent (1-100).
    pct: Option<f32>,
    /// Max width in px (height follows).
    width: Option<u32>,
    /// Max height in px (width follows).
    height: Option<u32>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct MegaUploadSummary {
    uploaded: usize,
    resized: usize,
}

/// Target size for a w x h image, or None to keep it.
fn shrink_target(w: u32, h: u32, spec: &ResizeSpec) -> Option<(u32, u32)> {
    if w == 0 || h == 0 {
        return None;
    }
    let (tw, th) = if let Some(p) = spec.pct {
        let f = (p as f64 / 100.0).clamp(0.01, 1.0);
        if f >= 1.0 {
            return None;
        }
        (
            ((w as f64) * f).round() as u32,
            ((h as f64) * f).round() as u32,
        )
    } else if let Some(wt) = spec.width {
        if wt >= w {
            return None;
        }
        (wt, (((h as f64) * (wt as f64)) / (w as f64)).round() as u32)
    } else if let Some(ht) = spec.height {
        if ht >= h {
            return None;
        }
        ((((w as f64) * (ht as f64)) / (h as f64)).round() as u32, ht)
    } else {
        return None;
    };
    let t = (tw.clamp(1, w), th.clamp(1, h));
    if t == (w, h) {
        None
    } else {
        Some(t)
    }
}

/// Formats we can shrink (GIFs are passed through so animations survive).
const RESIZABLE_EXTS: &[&str] = &["jpg", "jpeg", "jfif", "png", "webp", "bmp"];

fn is_resizable_image(p: &std::path::Path) -> bool {
    p.extension()
        .and_then(|e| e.to_str())
        .map(|e| RESIZABLE_EXTS.contains(&e.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

/// Size of each file ((0,0) for videos/unreadable), for the "very large" warning.
#[tauri::command]
async fn media_dimensions(
    dek: State<'_, DekState>,
    paths: Vec<String>,
) -> Result<Vec<(u32, u32)>, String> {
    let key = session_key(&dek);
    Ok(tauri::async_runtime::spawn_blocking(move || {
        paths
            .iter()
            .map(|s| {
                let p = std::path::Path::new(s);
                let imagey = is_resizable_image(p)
                    || p.extension()
                        .and_then(|e| e.to_str())
                        .map(|e| e.eq_ignore_ascii_case("gif"))
                        .unwrap_or(false);
                if !imagey || !p.is_file() {
                    return (0, 0);
                }
                if crypto::file_is_encrypted(p) {
                    let Some(k) = key else { return (0, 0) };
                    std::fs::read(p)
                        .ok()
                        .and_then(|b| crypto::Dek::from_bytes(k).decrypt_bytes(&b).ok())
                        .and_then(|d| {
                            image::ImageReader::new(std::io::Cursor::new(d))
                                .with_guessed_format()
                                .ok()
                        })
                        .and_then(|r| r.into_dimensions().ok())
                        .unwrap_or((0, 0))
                } else {
                    image::image_dimensions(p).unwrap_or((0, 0))
                }
            })
            .collect()
    })
    .await
    .map_err(|e| e.to_string())?)
}

/// Upload to MEGA with optional shrinking and progress. Files are staged (decrypted
/// + shrunk) into a temp folder and uploaded one by one, then the temp is deleted.
/// name = subfolder. Emits mega-progress { phase, done, total }, "resize" then "upload".
#[tauri::command]
async fn mega_upload_media(
    app: AppHandle,
    dek: State<'_, DekState>,
    srcs: Vec<String>,
    folder: String,
    name: Option<String>,
    resize: Option<ResizeSpec>,
    // Optional new names (with extension), same order as srcs.
    // Only the uploaded copies are renamed.
    names: Option<Vec<String>>,
) -> Result<MegaUploadSummary, String> {
    let key = session_key(&dek);
    let cache = app_cache(&app)?;
    let app2 = app.clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<MegaUploadSummary, String> {
        if srcs.is_empty() {
            return Err("Nothing to upload.".into());
        }
        if mega_command("mega-put").is_none() {
            return Err("MEGAcmd isn't installed. Install it and run `mega-login` once.".into());
        }
        let total = srcs.len();
        let emit = |phase: &str, done: usize| {
            let _ = app2.emit(
                "mega-progress",
                serde_json::json!({ "phase": phase, "done": done, "total": total }),
            );
        };

        // stage: decrypt (+ shrink) into a temp folder
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let tmpdir = cache.join("mega-tmp").join(nanos.to_string());
        std::fs::create_dir_all(&tmpdir).map_err(map_err)?;
        let mut resized = 0usize;
        let mut staged: Vec<std::path::PathBuf> = Vec::new();
        emit("resize", 0);
        let stage = (|| -> Result<(), String> {
            for (i, s) in srcs.iter().enumerate() {
                let p = std::path::Path::new(s);
                let data = read_decrypted(p, key)?;
                let fname = p.file_name().ok_or("bad file name")?;
                // a rename wins over the original name, empty keeps it
                let renamed = names
                    .as_ref()
                    .and_then(|ns| ns.get(i))
                    .map(|s| sanitize_name(s))
                    .filter(|s| !s.is_empty());
                let dest = match renamed {
                    Some(nm) => unique_dest(&tmpdir, std::ffi::OsStr::new(&nm)),
                    None => unique_dest(&tmpdir, fname),
                };
                let mut wrote = false;
                if let Some(spec) = resize.as_ref() {
                    if is_resizable_image(p) {
                        if let Ok(img) = image::load_from_memory(&data) {
                            if let Some((tw, th)) = shrink_target(img.width(), img.height(), spec) {
                                let small = image::imageops::resize(
                                    &img.to_rgba8(),
                                    tw,
                                    th,
                                    image::imageops::FilterType::Lanczos3,
                                );
                                let fmt = image::ImageFormat::from_path(p)
                                    .unwrap_or(image::ImageFormat::Png);
                                let mut buf = Vec::new();
                                let ok = match fmt {
                                    image::ImageFormat::Jpeg => {
                                        let rgb =
                                            image::DynamicImage::ImageRgba8(small.clone()).to_rgb8();
                                        image::codecs::jpeg::JpegEncoder::new_with_quality(
                                            &mut std::io::Cursor::new(&mut buf),
                                            88,
                                        )
                                        .encode_image(&rgb)
                                        .is_ok()
                                    }
                                    _ => image::DynamicImage::ImageRgba8(small)
                                        .write_to(&mut std::io::Cursor::new(&mut buf), fmt)
                                        .is_ok(),
                                };
                                if ok {
                                    std::fs::write(&dest, &buf).map_err(map_err)?;
                                    wrote = true;
                                    resized += 1;
                                }
                            }
                        }
                    }
                }
                if !wrote {
                    std::fs::write(&dest, &data).map_err(map_err)?;
                }
                staged.push(dest);
                emit("resize", i + 1);
            }
            Ok(())
        })();
        if let Err(e) = stage {
            let _ = std::fs::remove_dir_all(&tmpdir);
            return Err(e);
        }

        // remote folder (created if missing)
        let folder = {
            let f = folder.trim();
            if f.is_empty() { "/".to_string() } else { f.to_string() }
        };
        let remote = match name.as_deref().map(str::trim).filter(|n| !n.is_empty()) {
            Some(n) => format!("{}/{}", folder.trim_end_matches('/'), sanitize_name(n)),
            None => folder,
        };
        let _ = run_mega_timed("mega-mkdir", &["-p", &remote], std::time::Duration::from_secs(60));
        let dest = if remote.ends_with('/') { remote.clone() } else { format!("{remote}/") };

        // one by one so the count is real
        let mut uploaded = 0usize;
        let mut first_err: Option<String> = None;
        emit("upload", 0);
        for (i, f) in staged.iter().enumerate() {
            match run_mega_timed(
                "mega-put",
                &[&f.to_string_lossy(), &dest],
                std::time::Duration::from_secs(1800),
            ) {
                Ok((0, _, _)) => uploaded += 1,
                Ok((_, out, err)) => {
                    if first_err.is_none() {
                        let err = clean_cli_text(&err);
                        let out = clean_cli_text(&out);
                        let msg =
                            if !err.trim().is_empty() { err.trim().to_string() } else { out.trim().to_string() };
                        first_err = Some(if msg.is_empty() {
                            "MEGA upload failed. Is MEGAcmd logged in (run `mega-login`)?".into()
                        } else {
                            format!("MEGA upload failed: {msg}")
                        });
                    }
                }
                Err(e) => {
                    if first_err.is_none() {
                        first_err = Some(e);
                    }
                }
            }
            emit("upload", i + 1);
        }
        let _ = std::fs::remove_dir_all(&tmpdir); // delete plaintext immediately
        if uploaded == 0 {
            return Err(first_err.unwrap_or_else(|| "MEGA upload failed.".into()));
        }
        Ok(MegaUploadSummary { uploaded, resized })
    })
    .await
    .map_err(|e| e.to_string())?
}

/* ---- artist templates ------------------------------------------------ */

/// Where imported templates are saved.
fn templates_dir(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app_data(app)?.join("templates");
    std::fs::create_dir_all(&dir).map_err(map_err)?;
    Ok(dir)
}

/// Check a template, save it and return a summary. replace_file = the old file name
/// when editing, if the name changed the old file is removed (no duplicate).
#[tauri::command]
fn import_template(app: AppHandle, json: String, replace_file: Option<String>) -> Result<TemplatePreview, String> {
    let t = template::parse(&json)?;
    // don't save a template that has a month twice
    template::check_no_duplicate_periods(&t)?;
    let dir = templates_dir(&app)?;
    // include the label so several templates per artist don't overwrite each other
    let stem = if t.label.trim().is_empty() {
        sanitize_name(&t.artist.name)
    } else {
        format!("{}__{}", sanitize_name(&t.artist.name), sanitize_name(t.label.trim()))
    };
    let file_name = format!("{stem}.micoll.json");
    std::fs::write(dir.join(&file_name), &json).map_err(map_err)?;
    // the edit renamed it, remove the old file
    if let Some(old) = replace_file {
        let old = old.trim();
        if !old.is_empty() && old != file_name {
            // only delete inside the templates folder
            let candidate = dir.join(old);
            if candidate.parent() == Some(dir.as_path()) && candidate.is_file() {
                let _ = std::fs::remove_file(candidate);
            }
        }
    }
    Ok(template::preview(&t, &file_name))
}

/// Import a template from a file.
#[tauri::command]
fn import_template_file(app: AppHandle, path: String) -> Result<TemplatePreview, String> {
    let json = std::fs::read_to_string(&path).map_err(|e| format!("Couldn't read {path}: {e}"))?;
    import_template(app, json, None)
}

/// Write a template's JSON to a chosen path ("Download").
#[tauri::command]
fn export_template(path: String, raw: String) -> Result<(), String> {
    std::fs::write(&path, raw).map_err(|e| format!("Couldn't write {path}: {e}"))
}

/// List all templates. applied is per template (by label).
///
/// The JSON of one template, loaded when needed (templates can be huge).
///
/// What a cover shrink did (numbers for the UI).
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ShrinkResult {
    covers: u32,
    before: u64,
    after: u64,
}

/// Shrink a template's inline covers (they used to be full size, 78 MB for one template).
/// The original is kept as <name>.orig so it can be undone (restore_template_covers).
/// Signed templates: shrinking breaks the signature, your own ones are re-signed,
/// someone else's are refused.
#[tauri::command]
fn shrink_template_covers(app: AppHandle, file_name: String, max_px: u32) -> Result<ShrinkResult, String> {
    let path = template_file_path(&app, &file_name)?;
    let raw = std::fs::read_to_string(&path).map_err(|e| format!("Couldn't read {file_name}: {e}"))?;
    let before = raw.len() as u64;

    let envelope = signing::detect_envelope(&raw)?;
    let inner = match &envelope {
        Some(env) => {
            if !signing::can_sign() {
                return Err("This template is signed by someone else. Shrinking its covers                             would break the signature, and only whoever signed it can put                             that right."
                    .into());
            }
            String::from_utf8(
                base64::engine::general_purpose::STANDARD
                    .decode(env.payload.trim())
                    .map_err(|_| "This signed template file is broken (bad payload encoding).")?,
            )
            .map_err(|_| "This signed template file is broken (payload isn't UTF-8).")?
        }
        None => raw.clone(),
    };

    let mut v: serde_json::Value =
        serde_json::from_str(&inner).map_err(|e| format!("This template isn't valid JSON: {e}"))?;
    let mut covers = 0u32;
    if let Some(platforms) = v.get_mut("platforms").and_then(|p| p.as_array_mut()) {
        for platform in platforms.iter_mut() {
            let Some(periods) = platform.get_mut("periods").and_then(|p| p.as_array_mut()) else {
                continue;
            };
            for period in periods.iter_mut() {
                let Some(cover) = period.get("cover").and_then(|c| c.as_str()) else { continue };
                if let Some(small) = thumbs::shrink_data_url(cover, max_px) {
                    period["cover"] = serde_json::Value::String(small);
                    covers += 1;
                }
            }
        }
    }
    if covers == 0 {
        return Ok(ShrinkResult { covers: 0, before, after: before });
    }

    let shrunk = serde_json::to_string_pretty(&v).map_err(map_err)?;
    let out = match envelope {
        Some(_) => signing::sign_template(&shrunk)?,
        None => shrunk,
    };

    // back up first, but never over an existing backup (that's the real original)
    let backup = path.with_file_name(format!("{file_name}.orig"));
    if !backup.exists() {
        std::fs::copy(&path, &backup).map_err(|e| format!("Couldn't save a backup: {e}"))?;
    }
    std::fs::write(&path, &out).map_err(|e| format!("Couldn't write {file_name}: {e}"))?;
    Ok(ShrinkResult { covers, before, after: out.len() as u64 })
}

/// Restore the file shrink_template_covers saved and delete the backup.
#[tauri::command]
fn restore_template_covers(app: AppHandle, file_name: String) -> Result<(), String> {
    let path = template_file_path(&app, &file_name)?;
    let backup = path.with_file_name(format!("{file_name}.orig"));
    if !backup.is_file() {
        return Err("There's no original to go back to for this template.".into());
    }
    std::fs::copy(&backup, &path).map_err(|e| format!("Couldn't restore {file_name}: {e}"))?;
    std::fs::remove_file(&backup).map_err(|e| format!("Restored, but couldn't remove the backup: {e}"))?;
    Ok(())
}

#[tauri::command]
fn read_template(app: AppHandle, file_name: String) -> Result<String, String> {
    let p = template_file_path(&app, &file_name)?;
    std::fs::read_to_string(&p).map_err(|e| format!("Couldn't read {file_name}: {e}"))
}

/// Parsed templates cached by path (parsing an 82 MB template on every Settings visit was
/// slow).
/// Reused while mtime and size match. applied isn't cached (it's a DB fact).
type TemplateRow = (std::time::SystemTime, u64, String, TemplatePreview);
static TEMPLATE_CACHE: std::sync::OnceLock<
    std::sync::Mutex<std::collections::HashMap<std::path::PathBuf, TemplateRow>>,
> =
    std::sync::OnceLock::new();

#[tauri::command]
fn list_templates(app: AppHandle, db: State<Db>) -> Result<Vec<TemplatePreview>, String> {
    let dir = templates_dir(&app)?;
    let cache = TEMPLATE_CACHE.get_or_init(Default::default);
    let mut cache = cache.lock().map_err(map_err)?;

    // phase 1: file work without the DB lock
    let mut rows: Vec<(String, TemplatePreview)> = Vec::new();
    let mut seen: Vec<std::path::PathBuf> = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for e in entries.flatten() {
            let path = e.path();
            if path.extension().and_then(|x| x.to_str()) != Some("json") {
                continue;
            }
            let stamp = e
                .metadata()
                .ok()
                .and_then(|m| m.modified().ok().map(|t| (t, m.len())));
            seen.push(path.clone());
            if let (Some((mtime, len)), Some(hit)) = (stamp, cache.get(&path)) {
                if hit.0 == mtime && hit.1 == len {
                    rows.push((hit.2.clone(), hit.3.clone()));
                    continue;
                }
            }
            let Ok(raw) = std::fs::read_to_string(&path) else { continue };
            let Ok(t) = template::parse(&raw) else { continue };
            let fname = path.file_name().and_then(|n| n.to_str()).unwrap_or("").to_string();
            let mut p = template::preview(&t, &fname);
            p.bytes = stamp.map(|(_, len)| len).unwrap_or(0);
            let artist = t.artist.name.trim().to_string();
            if let Some((mtime, len)) = stamp {
                cache.insert(path.clone(), (mtime, len, artist.clone(), p.clone()));
            }
            rows.push((artist, p));
        }
    }
    cache.retain(|k, _| seen.contains(k)); // deleted templates shouldn't linger
    drop(cache);

    // phase 2: is each template applied (from the DB)
    let conn = db.lock().map_err(map_err)?;
    let mut out: Vec<TemplatePreview> = Vec::new();
    for (artist, mut p) in rows {
        // not cached, a backup can appear/disappear on its own
        p.has_original = dir.join(format!("{}.orig", p.file_name)).is_file();
        if let Ok(Some(aid)) = db::artist_id_by_name(&conn, &artist) {
            let label = template::preview_label(&p);
            if let Ok(applied) = db::applied_templates(&conn, aid) {
                p.applied = applied.iter().any(|x| x.name == label);
            }
        }
        out.push(p);
    }
    out.sort_by(|a, b| a.artist.to_lowercase().cmp(&b.artist.to_lowercase()));
    Ok(out)
}

/// Template file name -> path inside the templates folder (refuses anything outside).
fn template_file_path(app: &AppHandle, file_name: &str) -> Result<std::path::PathBuf, String> {
    let dir = templates_dir(app)?;
    let p = dir.join(file_name);
    if p.parent() != Some(dir.as_path()) {
        return Err("Invalid template file.".into());
    }
    Ok(p)
}

/// Show a template file in Explorer (Shift+right-click).
#[tauri::command]
fn reveal_template(app: AppHandle, file_name: String) -> Result<(), String> {
    let p = template_file_path(&app, &file_name)?;
    if !p.is_file() {
        return Err("Template file not found.".into());
    }
    show_in_explorer(p.to_string_lossy().to_string())
}

/// Delete a template file (library data stays, deactivate handles that).
#[tauri::command]
fn delete_template(app: AppHandle, file_name: String) -> Result<(), String> {
    let p = template_file_path(&app, &file_name)?;
    if p.is_file() {
        std::fs::remove_file(&p).map_err(map_err)?;
    }
    Ok(())
}

/// Deactivate a template: clear its period totals, remove its "missing" placeholders,
/// remove its record and un-verify the artist if none are left.
/// Files on disk and the template file stay.
#[tauri::command]
fn deactivate_template(db: State<Db>, json: String) -> Result<(), String> {
    let conn = db.lock().map_err(map_err)?;
    let t = template::parse(&json)?;
    let name = t.artist.name.trim();
    let artist_id = match db::artist_id_by_name(&conn, name).map_err(map_err)? {
        Some(id) => id,
        None => return Ok(()), // never applied — nothing to undo
    };
    // reset every covered period to "untracked"
    for ck in template::coverage(&t) {
        let key = indexer::period_key(name, Some(&ck.platform), ck.year, ck.month, None);
        if let Some(pid) = db::period_id_by_key(&conn, &key).map_err(map_err)? {
            db::clear_period_official_total(&conn, pid).map_err(map_err)?;
            db::clear_period_verified(&conn, pid).map_err(map_err)?;
            db::delete_missing_rewards(&conn, pid).map_err(map_err)?;
        }
    }
    db::remove_applied_template(&conn, artist_id, &template::template_label(&t)).map_err(map_err)?;
    // no templates left -> remove the verified / personal log flag
    if db::applied_templates(&conn, artist_id).map_err(map_err)?.is_empty() {
        db::set_artist_template(&conn, artist_id, None, None, false).map_err(map_err)?;
    }
    let _ = db::touch_artist_by_name(&conn, name);
    Ok(())
}

/* ---- signing & licensing (see signing.rs) ----------------------------- */

/// Can this PC sign templates? Only on the owner's PC (key installed + matching).
#[tauri::command]
fn can_sign() -> bool {
    signing::can_sign()
}

/// Sign a template's JSON (owner only). Only signed files show the check.
#[tauri::command]
fn sign_template(json: String) -> Result<String, String> {
    if signing::detect_envelope(&json)?.is_some() {
        return Err("This template is already signed.".into());
    }
    // must be a valid template first
    template::parse(&json)?;
    signing::sign_template(&json)
}

/// Make a premium theme key for a buyer (owner only). expires (YYYY-MM-DD) or days
/// for a test key, neither = permanent.
#[tauri::command]
fn issue_theme_key(
    buyer: String,
    expires: Option<String>,
    days: Option<u32>,
) -> Result<String, String> {
    let trial = match (expires, days) {
        (None, None) => None,
        (Some(date), None) => Some(signing::TrialTerms::Until(date)),
        (None, Some(n)) => Some(signing::TrialTerms::Days(n)),
        (Some(_), Some(_)) => {
            return Err("A test key ends on a date or after a run of days, not both.".into())
        }
    };
    signing::issue_theme_key(&buyer, trial)
}

/// What a pasted key is.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ThemeLicenseInfo {
    /// The buyer name, shown in Settings.
    buyer: String,
    /// True for a test key.
    trial: bool,
    /// Last day of a test key, None for a bought one.
    until: Option<String>,
}

/// Last day of a days-long run starting at started, and if today is past it.
/// In days since epoch. The paste day is day zero, 30 days = 30 more days.
/// Separate so it can be tested.
fn trial_window(started: i64, days: u32, today: i64) -> (i64, bool) {
    let last = started + i64::from(days);
    (last, today > last)
}

/// Check a pasted key. Err with a message if it fails (also revoked keys and expired test
/// keys).
/// A "N days from redemption" test key is finished here: the first paste day is saved
/// in this library under the key's fingerprint. The clock starts on the first check.
#[tauri::command]
fn verify_theme_license(db: State<Db>, token: String) -> Result<ThemeLicenseInfo, String> {
    let lic = signing::verify_theme_key(&token)?;
    let trial = lic.product == signing::THEME_TRIAL_PRODUCT;
    let mut until = lic.expires.clone();
    if let Some(days) = lic.days {
        let fp = signing::theme_key_fingerprint(&token)?;
        let row = format!("trial_started_{fp}");
        let conn = db.lock().map_err(map_err)?;
        let started = match db::get_setting(&conn, &row).map_err(map_err)? {
            Some(v) => v.trim().parse::<i64>().unwrap_or_else(|_| signing::epoch_day()),
            None => {
                let today = signing::epoch_day();
                db::set_setting(&conn, &row, &today.to_string()).map_err(map_err)?;
                today
            }
        };
        let (last, over) = trial_window(started, days, signing::epoch_day());
        let last_date = signing::civil_from_days(last);
        if over {
            return Err(format!("This test key stopped working on {last_date}."));
        }
        until = Some(last_date);
    }
    Ok(ThemeLicenseInfo {
        buyer: lic.buyer,
        trial,
        until,
    })
}

/// Short fingerprint of a key (shown next to the buyer, used in REVOKED_SIGS).
/// Works for invalid keys too.
#[tauri::command]
fn theme_key_fingerprint(token: String) -> Result<String, String> {
    signing::theme_key_fingerprint(&token)
}

/// One-time owner setup: create the signing key pair and return the public key hex
/// for signing::OFFICIAL_KEYS.
#[tauri::command]
fn generate_signing_keypair() -> Result<String, String> {
    signing::generate_keypair()
}

/* ---- MiSD — external-disk offload (see sd.rs) ------------------------- */

/// Called right before installing an update. The installer ends the app without
/// the normal teardown, so fold the WAL first (like the tray Quit does).
#[tauri::command]
fn prepare_for_update(db: State<Db>) -> Result<(), String> {
    let conn = db.lock().map_err(map_err)?;
    db::checkpoint(&conn);
    Ok(())
}

/// True for a portable copy (it has to update itself, see portable_update.rs).
#[tauri::command]
fn is_portable() -> bool {
    portable_root().is_some()
}

/// Update a portable copy: swap in the new MiColl.exe, start it, quit this one.
#[tauri::command]
async fn portable_update(app: AppHandle, db: State<'_, Db>, version: String) -> Result<(), String> {
    if portable_root().is_none() {
        return Err("This isn't a portable copy.".into());
    }
    let exe = std::env::current_exe().map_err(map_err)?;
    let target = exe.clone();
    tauri::async_runtime::spawn_blocking(move || portable_update::swap_in(&target, &version))
        .await
        .map_err(map_err)??;
    // save the database before the new version opens it
    if let Ok(conn) = db.lock() {
        db::checkpoint(&conn);
    }
    std::process::Command::new(&exe)
        .spawn()
        .map_err(|e| format!("the update is in place, but MiColl couldn't restart: {e}"))?;
    app.exit(0);
    Ok(())
}

/// Set up (or rename) the MiSD folder.
#[tauri::command]
fn sd_setup(db: State<Db>, path: String, label: String) -> Result<sd::SdStatus, String> {
    let conn = db.lock().map_err(map_err)?;
    sd::setup(&conn, &path, &label)
}

/// Current MiSD state (also fixes a changed drive letter).
#[tauri::command]
fn sd_status(app: AppHandle, db: State<Db>, dek: State<DekState>) -> Result<sd::SdStatus, String> {
    // probe the drive letter before taking the lock (see sd::preheal), Settings calls this
    // a lot
    sd::preheal(db.inner())?;
    let conn = db.lock().map_err(map_err)?;
    let st = sd::status(&conn)?;
    // disk is here: fill missing offline previews (only this call has the key when
    // encrypted)
    if st.available {
        fill_sd_previews(&app, &conn, session_key(&dek), None);
    }
    Ok(st)
}

/// Quick check before opening an SD reward.
#[tauri::command]
fn sd_available(db: State<Db>) -> Result<bool, String> {
    sd::preheal(db.inner())?; // runs on every click into an offloaded reward
    let conn = db.lock().map_err(map_err)?;
    Ok(sd::available(&conn))
}

/// Queue/unqueue rewards for MiSD (single, per period or per artist).
/// mode "move" (default) or "backup". Returns how many changed.
#[tauri::command]
fn sd_mark(
    db: State<Db>,
    reward_ids: Option<Vec<i64>>,
    period_id: Option<i64>,
    artist_id: Option<i64>,
    marked: bool,
    mode: Option<String>,
) -> Result<u32, String> {
    let conn = db.lock().map_err(map_err)?;
    let mode = sd::SdMode::parse(mode.as_deref().unwrap_or("move"));
    let mut n = 0;
    if let Some(ids) = reward_ids {
        n += sd::mark_rewards(&conn, &ids, mode, marked)?;
    }
    if let Some(pid) = period_id {
        n += sd::mark_period(&conn, pid, mode, marked)?;
    }
    if let Some(aid) = artist_id {
        n += sd::mark_artist(&conn, aid, mode, marked)?;
    }
    Ok(n)
}

/// Queue/unqueue a whole year of a platform and set the rule for it.
/// With rule, rewards added to that year later get queued too (see sd::rule_mode_sql).
#[tauri::command]
fn sd_mark_year(
    db: State<Db>,
    artist_id: i64,
    platform: Option<String>,
    year: Option<i64>,
    marked: bool,
    mode: Option<String>,
    rule: bool,
) -> Result<u32, String> {
    let conn = db.lock().map_err(map_err)?;
    let mode = sd::SdMode::parse(mode.as_deref().unwrap_or("move"));
    let n = sd::mark_year(&conn, artist_id, platform.as_deref(), year, mode, marked)?;
    if rule {
        sd::set_year_rule(
            &conn,
            artist_id,
            platform.as_deref(),
            year,
            if marked { Some(mode) } else { None },
        )?;
    }
    Ok(n)
}

/// Turn a year rule on/off on its own, queued stuff stays.
#[tauri::command]
fn sd_year_rule(
    db: State<Db>,
    artist_id: i64,
    platform: Option<String>,
    year: Option<i64>,
    mode: Option<String>,
) -> Result<(), String> {
    let conn = db.lock().map_err(map_err)?;
    sd::set_year_rule(
        &conn,
        artist_id,
        platform.as_deref(),
        year,
        mode.as_deref().map(sd::SdMode::parse),
    )
}

/// All year rules of a creator (for the year headers).
#[tauri::command]
fn sd_year_rules(db: State<Db>, artist_id: i64) -> Result<Vec<sd::YearRule>, String> {
    let conn = db.lock().map_err(map_err)?;
    sd::year_rules(&conn, artist_id)
}

/// Creators the next job would touch (for the confirmation).
#[tauri::command]
fn sd_queued_creators(db: State<Db>) -> Result<Vec<sd::QueuedCreator>, String> {
    let conn = db.lock().map_err(map_err)?;
    sd::queued_creators(&conn)
}

/// sd-progress { phase, done, total, item } for the progress bar.
fn sd_progress<'a>(app: &'a AppHandle, phase: &'static str) -> impl Fn(u32, u32, &str) + 'a {
    move |done, total, item| {
        let _ = app.emit(
            "sd-progress",
            serde_json::json!({ "phase": phase, "done": done, "total": total, "item": item }),
        );
    }
}

/// Move every marked reward to the MiSD disk: previews first, then a SHA-256
/// checked copy, the source is deleted only after everything checked out.
/// Async so the progress events reach the window.
#[tauri::command]
async fn sd_transport(
    app: AppHandle,
    db: State<'_, Db>,
    dek: State<'_, DekState>,
) -> Result<sd::SdSummary, String> {
    let thumbs_dir = app_cache(&app)?.join("thumbs");
    let key = session_key(&dek);
    let conn = db.lock().map_err(map_err)?;
    sd::transport(&conn, &thumbs_dir, key, &sd_progress(&app, "transport"))
}

/// Bring rewards back from the disk (same check). reward_ids None = all.
#[tauri::command]
async fn sd_return(
    app: AppHandle,
    db: State<'_, Db>,
    reward_ids: Option<Vec<i64>>,
) -> Result<sd::SdSummary, String> {
    let conn = db.lock().map_err(map_err)?;
    sd::bring_back(&conn, reward_ids.as_deref(), &sd_progress(&app, "return"))
}

/// Copy every reward queued for backup to the disk (same check), nothing deleted locally.
#[tauri::command]
async fn sd_backup_now(app: AppHandle, db: State<'_, Db>) -> Result<sd::SdSummary, String> {
    let conn = db.lock().map_err(map_err)?;
    sd::backup(&conn, &sd_progress(&app, "backup"))
}

/// Mark rewards as extras or not.
/// Extras stay in the month but aren't used for the month mosaic.
#[tauri::command]
fn set_rewards_extra(db: State<Db>, reward_ids: Vec<i64>, extra: bool) -> Result<u32, String> {
    let conn = db.lock().map_err(map_err)?;
    let n = db::set_rewards_extra(&conn, &reward_ids, extra).map_err(map_err)?;
    db::checkpoint(&conn);
    Ok(n)
}

/// Stop the running MiSD job (the current reward finishes, the rest stays queued).
/// No State<Db> on purpose: the job holds the lock, so we couldn't get it until it's done.
#[tauri::command]
fn sd_cancel() {
    sd::request_cancel();
}

/// Remove MiSD backups (local files stay). reward_ids None = all.
#[tauri::command]
fn sd_backup_drop(db: State<Db>, reward_ids: Option<Vec<i64>>) -> Result<sd::SdSummary, String> {
    let conn = db.lock().map_err(map_err)?;
    sd::drop_backup(&conn, reward_ids.as_deref())
}

/// period_key -> {normalized titles} of a template, to diff template versions.
fn template_expected(
    t: &template::TemplateFile,
    artist: &str,
) -> std::collections::HashMap<String, std::collections::HashSet<String>> {
    let mut map: std::collections::HashMap<String, std::collections::HashSet<String>> =
        std::collections::HashMap::new();
    for plat in &t.platforms {
        let platform = plat.name.trim();
        for per in &plat.periods {
            let key = indexer::period_key(artist, Some(platform), per.year, per.month, None);
            let set = map.entry(key).or_default();
            for rw in &per.rewards {
                let title = rw.title.trim();
                if !title.is_empty() {
                    set.insert(indexer::norm_title(title));
                }
            }
        }
    }
    map
}

/// True if a folder has at least one file (anywhere below).
fn dir_has_files(p: &std::path::Path) -> bool {
    walkdir::WalkDir::new(p)
        .into_iter()
        .flatten()
        .any(|e| e.path().is_file())
}

/// After a template (re-)apply, remove rewards it doesn't expect in a period anymore
/// (unless another applied template still does). Empty ones are deleted, folders with
/// files are moved into that year's "Misc".
fn reconcile_dropped_rewards(
    app: &AppHandle,
    conn: &rusqlite::Connection,
    artist: &str,
    artist_id: i64,
    old_expected: &std::collections::HashMap<String, std::collections::HashSet<String>>,
) -> Result<(), String> {
    // titles still expected by any applied template (so we never remove those)
    let mut keep: std::collections::HashMap<String, std::collections::HashSet<String>> =
        std::collections::HashMap::new();
    for at in db::applied_templates(conn, artist_id).map_err(map_err)? {
        if let Some(raw) = at.raw.as_deref() {
            if let Ok(tt) = template::parse(raw) {
                for (k, set) in template_expected(&tt, artist) {
                    keep.entry(k).or_default().extend(set);
                }
            }
        }
    }

    for (key, old_titles) in old_expected {
        let kept = keep.get(key);
        let stale: std::collections::HashSet<&String> = old_titles
            .iter()
            .filter(|t| kept.map_or(true, |ks| !ks.contains(*t)))
            .collect();
        if stale.is_empty() {
            continue;
        }
        let Some(pid) = db::period_id_by_key(conn, key).map_err(map_err)? else {
            continue;
        };
        let (p_artist, p_platform, p_year, _p_month, _p_number) =
            match db::period_scope(conn, pid).map_err(map_err)? {
                Some(x) => x,
                None => continue,
            };
        for (rid, title, status, _count) in db::period_rewards(conn, pid).map_err(map_err)? {
            if !stale.contains(&indexer::norm_title(&title)) {
                continue;
            }
            let folder = db::reward_scope(conn, rid)
                .map_err(map_err)?
                .map(|(_, f, _)| f)
                .unwrap_or_default();
            let synthetic = folder.contains('\u{1}');
            let path = std::path::Path::new(&folder);
            let has_files = !synthetic && path.is_dir() && dir_has_files(path);

            if status == "missing" || !has_files {
                // a placeholder or empty folder -> remove it
                if !synthetic && path.is_dir() {
                    let _ = std::fs::remove_dir_all(path);
                }
                db::delete_rewards(conn, &[rid]).map_err(map_err)?;
            } else {
                // owned content that doesn't belong here -> move it into the year's "Misc"
                let misc_key = indexer::period_key(&p_artist, p_platform.as_deref(), p_year, None, None);
                let misc_pid = match db::period_id_by_key(conn, &misc_key).map_err(map_err)? {
                    Some(id) => id,
                    None => {
                        let label = match p_year {
                            Some(y) => indexer::fmt_label(y, None),
                            None => "Misc".to_string(),
                        };
                        indexer::upsert_period(
                            conn,
                            artist_id,
                            p_platform.as_deref(),
                            p_year,
                            None,
                            None,
                            &label,
                            &misc_key,
                            false,
                        )
                        .map_err(map_err)?
                    }
                };
                if let Some(dest_dir) = period_month_dir(conn, misc_pid) {
                    let _ = std::fs::create_dir_all(&dest_dir);
                    let target = unique_dir(&dest_dir, &sanitize_name(&title));
                    if move_tree(path, &target).is_ok() {
                        db::move_reward(conn, rid, misc_pid, &folder, &target.to_string_lossy())
                            .map_err(map_err)?;
                        allow_asset_dir(app, &dest_dir.to_string_lossy());
                    }
                }
            }
        }
    }
    Ok(())
}

/// Apply a template: artist + verified, "missing" rewards, period totals,
/// optionally folders, then rescan so existing files match up.
#[tauri::command]
fn apply_template(
    app: AppHandle,
    db: State<Db>,
    json: String,
    create_folders: bool,
    base_dir: Option<String>,
) -> Result<ScanSummary, String> {
    let conn = db.lock().map_err(map_err)?;
    let t = template::parse(&json)?;
    // refuse before changing anything if a month is listed twice
    template::check_no_duplicate_periods(&t)?;
    let artist_name = t.artist.name.trim().to_string();

    // remember what THIS template expected before, to clean up later
    let old_expected = {
        let label = template::template_label(&t);
        db::artist_id_by_name(&conn, &artist_name)
            .map_err(map_err)?
            .and_then(|aid| db::applied_templates(&conn, aid).ok())
            .and_then(|ats| ats.into_iter().find(|a| a.name == label))
            .and_then(|a| a.raw)
            .and_then(|raw| template::parse(&raw).ok())
            .map(|old| template_expected(&old, &artist_name))
            .unwrap_or_default()
    };

    // where to create folders (like create_artist)
    let managed = db::get_setting(&conn, "managed_enabled")
        .map_err(map_err)?
        .as_deref()
        == Some("true");
    let collection = db::get_setting(&conn, "collection_root")
        .map_err(map_err)?
        .filter(|s| !s.trim().is_empty());
    let base: Option<std::path::PathBuf> =
        if let Some(b) = base_dir.as_ref().filter(|s| !s.trim().is_empty()) {
            Some(std::path::PathBuf::from(b))
        } else if managed {
            collection
                .as_ref()
                // the graveyard if the creator is already there
                .map(|c| {
                    let shelf = std::path::Path::new(c).join("MiColl");
                    if artist_in_graveyard(&conn, &artist_name) {
                        shelf.join(indexer::GRAVEYARD_DIR)
                    } else {
                        shelf
                    }
                })
        } else {
            None
        };

    let scaffold = template::apply_template(
        &conn,
        &t,
        &json,
        create_folders && base.is_some(),
        base.as_deref(),
    )?;
    let _ = db::touch_artist_by_name(&conn, t.artist.name.trim());

    if let Some(abase) = scaffold {
        let s = abase.to_string_lossy().to_string();
        let _ = db::add_root(&conn, &s, Some(t.artist.name.trim()), None);
        allow_asset_dir(&app, &s);
    }

    // rescan all roots so existing files become owned
    let roots = db::list_roots(&conn).map_err(map_err)?;
    let mut total = ScanSummary::default();
    for root in &roots {
        allow_asset_dir(&app, &root.path);
        let scan = indexer::scan_root(&conn, root).map_err(map_err)?;
        total.artists += scan.artists;
        total.periods += scan.periods;
        total.rewards += scan.rewards;
        total.images += scan.images;
        total.needs_review += scan.needs_review;
    }

    // clean up rewards the template doesn't expect anymore (after the rescan)
    if !old_expected.is_empty() {
        if let Some(aid) = db::artist_id_by_name(&conn, &artist_name).map_err(map_err)? {
            reconcile_dropped_rewards(&app, &conn, &artist_name, aid, &old_expected)?;
            let _ = db::touch_artist_by_name(&conn, &artist_name);
        }
    }
    Ok(total)
}

/* ---- duplicate finder + storage breakdown ---------------------------- */

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct DupImage {
    id: String,
    path: String,
    name: String,
    reward: String,
    artist: String,
    bytes: u64,
    width: u32,
    height: u32,
}

/// Find groups of duplicate images, optionally for one artist / platform / period.
/// Biggest groups first.
/// Without similar: identical bytes (only same-size files are hashed, fast).
/// With similar: by appearance (finds resized copies, slower, can be wrong).
#[tauri::command]
async fn find_duplicates(
    app: tauri::AppHandle,
    db: State<'_, Db>,
    dek: State<'_, DekState>,
    artist_id: Option<i64>,
    platform: Option<String>,
    period_id: Option<i64>,
    reward_id: Option<i64>,
    similar: Option<bool>,
) -> Result<Vec<Vec<DupImage>>, String> {
    use std::collections::HashMap;
    let key = session_key(&dek);
    let rows = {
        let conn = db.lock().map_err(map_err)?;
        db::images_for_dup(&conn).map_err(map_err)?
    };
    // images in the scope (by id)
    let candidates: Vec<db::DupRow> = rows
        .into_iter()
        .filter(|r| {
            if !dup::is_image(&r.file_path) {
                return false;
            }
            if let Some(rid) = reward_id {
                return r.reward_id == rid;
            }
            if let Some(pid) = period_id {
                return r.period_id == pid;
            }
            if let Some(aid) = artist_id {
                if r.artist_id != aid {
                    return false;
                }
                if let Some(plat) = platform.as_deref() {
                    return match (plat, &r.platform) {
                        ("Unsorted", None) => true,
                        (p, Some(rp)) => rp.eq_ignore_ascii_case(p),
                        _ => false,
                    };
                }
                return true;
            }
            true
        })
        .collect();

    // ---- similar mode: grouped by how they look ----
    if similar.unwrap_or(false) {
        let thumb_dir = app_cache(&app)?.join("thumbs");
        let work: Vec<(i64, String)> =
            candidates.iter().map(|r| (r.id, r.file_path.clone())).collect();
        type SimMeta = (dup::Fingerprint, u64, u32, u32); // fingerprint, bytes, w, h
        let measured: Vec<(i64, SimMeta)> = tauri::async_runtime::spawn_blocking(move || {
            let mut out: Vec<(i64, SimMeta)> = Vec::new();
            for (id, p) in work {
                // unreadable files are skipped (an unplugged MiSD file would be hashed from
                // its small preview and marked for deletion)
                let Ok(md) = std::fs::metadata(&p) else { continue };
                // hash the cached thumbnail instead of the original (same result, much
                // faster)
                let thumb = thumbs::thumb_jpeg(&thumb_dir, &p, 256, key).ok();
                let print = match thumb {
                    Some(t) => dup::fingerprint(&t),
                    None => dup::fingerprint_keyed(std::path::Path::new(&p), key),
                };
                let Some(print) = print else { continue };
                if dup::is_featureless(print.hash) {
                    continue;
                }
                let (w, h) = thumbs::dimensions(&p, key).unwrap_or((0, 0));
                out.push((id, (print, md.len(), w, h)));
            }
            out
        })
        .await
        .map_err(|e| e.to_string())?;

        // union-find so a chain of near copies (A=B, B=C) becomes one group
        fn root(parent: &mut [usize], mut x: usize) -> usize {
            while parent[x] != x {
                parent[x] = parent[parent[x]];
                x = parent[x];
            }
            x
        }
        let n = measured.len();
        let mut parent: Vec<usize> = (0..n).collect();
        for i in 0..n {
            for j in (i + 1)..n {
                if dup::same_picture(&measured[i].1 .0, &measured[j].1 .0) {
                    let (a, b) = (root(&mut parent, i), root(&mut parent, j));
                    if a != b {
                        parent[a] = b;
                    }
                }
            }
        }

        let by_id: HashMap<i64, &db::DupRow> = candidates.iter().map(|r| (r.id, r)).collect();
        let mut clusters: HashMap<usize, Vec<DupImage>> = HashMap::new();
        for i in 0..n {
            let (id, (_, bytes, w, h)) = measured[i];
            let Some(r) = by_id.get(&id) else { continue };
            let name = std::path::Path::new(&r.file_path)
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or("")
                .to_string();
            let key_of = root(&mut parent, i);
            clusters.entry(key_of).or_default().push(DupImage {
                id: r.id.to_string(),
                path: r.file_path.clone(),
                name,
                reward: r.reward.clone(),
                artist: r.artist.clone(),
                bytes,
                width: w,
                height: h,
            });
        }
        let mut out: Vec<Vec<DupImage>> = clusters.into_values().filter(|g| g.len() > 1).collect();
        // biggest image first in a group (the one to keep)
        for g in out.iter_mut() {
            g.sort_by(|a, b| {
                (b.width as u64 * b.height as u64)
                    .cmp(&(a.width as u64 * a.height as u64))
                    .then(b.bytes.cmp(&a.bytes))
            });
        }
        out.sort_by(|a, b| b.len().cmp(&a.len()));
        return Ok(out);
    }

    // off the main thread: group by size, then hash only the collisions
    let work: Vec<(i64, String)> = candidates.iter().map(|r| (r.id, r.file_path.clone())).collect();
    type Meta = (String, u64, u32, u32); // hash, bytes, w, h
    let measured: Vec<(i64, Meta)> = tauri::async_runtime::spawn_blocking(move || {
        let mut by_size: HashMap<u64, Vec<(i64, String)>> = HashMap::new();
        for (id, p) in work {
            if let Ok(md) = std::fs::metadata(&p) {
                by_size.entry(md.len()).or_default().push((id, p));
            }
        }
        let mut out: Vec<(i64, Meta)> = Vec::new();
        for (size, items) in by_size {
            if items.len() < 2 {
                continue; // unique size → cannot be a duplicate, skip
            }
            for (id, p) in items {
                if let Some((h, (w, h2))) = dup::content_hash_keyed(std::path::Path::new(&p), key) {
                    out.push((id, (h, size, w, h2)));
                }
            }
        }
        out
    })
    .await
    .map_err(|e| e.to_string())?;

    let meta: HashMap<i64, Meta> = measured.into_iter().collect();
    let mut groups: HashMap<String, Vec<DupImage>> = HashMap::new();
    for r in &candidates {
        if let Some((h, bytes, w, ht)) = meta.get(&r.id) {
            let name = std::path::Path::new(&r.file_path)
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or("")
                .to_string();
            groups.entry(h.clone()).or_default().push(DupImage {
                id: r.id.to_string(),
                path: r.file_path.clone(),
                name,
                reward: r.reward.clone(),
                artist: r.artist.clone(),
                bytes: *bytes,
                width: *w,
                height: *ht,
            });
        }
    }
    let mut out: Vec<Vec<DupImage>> = groups.into_values().filter(|g| g.len() > 1).collect();
    out.sort_by(|a, b| b.len().cmp(&a.len()));
    Ok(out)
}

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ArtistStorage {
    id: String,
    name: String,
    bytes: u64,
    files: u64,
}

/// Disk size per artist (bytes + count), largest first.
#[tauri::command]
async fn storage_breakdown(db: State<'_, Db>) -> Result<Vec<ArtistStorage>, String> {
    use std::collections::HashMap;
    let rows = {
        let conn = db.lock().map_err(map_err)?;
        db::images_with_artist(&conn).map_err(map_err)?
    };
    let result = tauri::async_runtime::spawn_blocking(move || {
        let mut map: HashMap<i64, (String, u64, u64)> = HashMap::new();
        for (id, name, path) in rows {
            if let Ok(md) = std::fs::metadata(&path) {
                let e = map.entry(id).or_insert((name, 0, 0));
                e.1 += md.len();
                e.2 += 1;
            }
        }
        let mut v: Vec<ArtistStorage> = map
            .into_iter()
            .map(|(id, (name, bytes, files))| ArtistStorage {
                id: id.to_string(),
                name,
                bytes,
                files,
            })
            .collect();
        v.sort_by(|a, b| b.bytes.cmp(&a.bytes));
        v
    })
    .await
    .map_err(|e| e.to_string())?;
    Ok(result)
}

/* ---- commands off the window's thread -------------------------------- */
/* Tauri runs every command that isn't async on the window's thread. An import (commit +
   organize) held it for seconds, Windows then showed the window as "Not Responding" and
   the taskbar kept the default icon and that title even after it came back. So all
   commands go to one thread of their own: one, so they still run one at a time and in
   the order they came in, like before. */

/// Held while the command thread runs a command, so ending the app can wait for it.
static COMMAND_RUNNING: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Wait until no command is running (and keep the next one from starting while held).
fn wait_for_command() -> std::sync::MutexGuard<'static, ()> {
    COMMAND_RUNNING.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// Wrap generate_handler! so its commands run on the command thread.
fn command_thread(
    handler: impl Fn(tauri::ipc::Invoke) -> bool + Send + 'static,
) -> impl Fn(tauri::ipc::Invoke) -> bool + Send + Sync + 'static {
    let (tx, rx) = std::sync::mpsc::channel::<tauri::ipc::Invoke>();
    std::thread::Builder::new()
        .name("micoll-commands".into())
        .spawn(move || {
            for invoke in rx {
                let resolver = invoke.resolver.clone();
                let command = invoke.message.command().to_string();
                let _running = wait_for_command();
                // a panic fails that one call instead of ending the thread (and with it
                // every later command)
                match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| handler(invoke))) {
                    Ok(true) => {}
                    Ok(false) => resolver.reject(format!("Command {command} not found")),
                    Err(_) => {
                        // reject panics itself if the call was already answered
                        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                            resolver.reject(format!("{command} failed with an internal error."))
                        }));
                    }
                }
            }
        })
        .expect("couldn't start the command thread");
    move |invoke| tx.send(invoke).is_ok()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // one MiColl per library: a second start hands over to the running one and ends here
    // (see single_instance.rs)
    #[cfg(windows)]
    {
        let scope = portable_root()
            .map(|root| root.to_string_lossy().into_owned())
            .unwrap_or_else(|| "appdata".into());
        if !single_instance::acquire(&scope) {
            return;
        }
    }
    // started from the taskbar's "Add rewards" while MiColl wasn't running
    if std::env::args().skip(1).any(|a| a == ADD_REWARDS_ARG) {
        set_launch_action("add-rewards");
    }
    tauri::Builder::default()
        // with "keep running in the tray" the close button hides the window (AtomicBool, no
        // DB lock)
        // Only the window that stands for the app hides: "main", or the last app window
        // if main was closed. Extra windows and pop-outs really close.
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let app = window.app_handle();
                let tray = app
                    .try_state::<CloseToTray>()
                    .map(|f| f.0.load(std::sync::atomic::Ordering::Relaxed))
                    .unwrap_or(false);
                let label = window.label();
                let stands_for_app = label == "main"
                    || (is_app_window(label)
                        && app.get_webview_window("main").is_none()
                        && !app.webview_windows().iter().any(|(other, w)| {
                            other != label
                                && is_app_window(other)
                                && w.is_visible().unwrap_or(false)
                        }));
                if tray && stands_for_app {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        // in-app updates (check/download/install from lib/updater.ts) + process for the
        // relaunch
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .register_asynchronous_uri_scheme_protocol("micollmedia", |ctx, request, responder| {
            let app = ctx.app_handle().clone();
            std::thread::spawn(move || {
                let resp = serve_media(&app, &request);
                responder.respond(resp);
            });
        })
        .setup(|app| {
            // a portable update leaves the old exe behind, remove it
            if portable_root().is_some() {
                if let Ok(exe) = std::env::current_exe() {
                    portable_update::clean_up_old(&exe);
                }
            }
            // open (or create) the database in the app data folder (next to the exe when
            // portable)
            let dir = app_data(app)?;
            std::fs::create_dir_all(&dir)?;
            // a portable copy doesn't take the installed library by itself anymore, it asks
            // (see portable_first_run).
            // daily backup of the db as it was BEFORE this session (open() folds the WAL
            // after).
            // Can be turned off in Settings, the flag is read read-only.
            if auto_backup_enabled(&dir.join("micoll.db")) {
                if let Err(e) = db::backup_rotate(&dir) {
                    eprintln!("micoll: db backup skipped: {e}");
                }
            }
            let conn = db::open(&dir.join("micoll.db"))?;
            // load the tray option before the window can close (icon only when on)
            let tray_on =
                db::get_setting(&conn, CLOSE_TO_TRAY_KEY).ok().flatten().as_deref() == Some("true");
            app.manage(CloseToTray(std::sync::atomic::AtomicBool::new(tray_on)));
            if tray_on {
                if let Err(e) = build_tray(app.handle()) {
                    eprintln!("micoll: tray icon unavailable: {e}");
                }
            }
            // a second start (pinned icon while in the tray, Start menu) shows this one,
            // the taskbar's "New window" task opens another window, "Add rewards" shows
            // this one and starts the import there
            #[cfg(windows)]
            {
                let handle = app.handle().clone();
                single_instance::listen(move |args| {
                    let has = |arg: &str| args.iter().skip(1).any(|a| a == arg);
                    if has("--new-window") {
                        open_new_window(&handle);
                        return;
                    }
                    let shown = restore_window(&handle);
                    if has(ADD_REWARDS_ARG) {
                        set_launch_action("add-rewards");
                        // a new window takes it when it starts, a shown one gets told
                        if let Some(w) = shown {
                            use tauri::Emitter;
                            let _ = handle.emit_to(w.label(), "micoll://launch-action", ());
                        }
                    }
                });
                single_instance::register_jump_list(&[
                    ("Add rewards", ADD_REWARDS_ARG),
                    ("New window", "--new-window"),
                ]);
            }
            // allow the thumbnail cache folder for the asset protocol
            let thumbs = app_cache(app).ok().map(|cache| cache.join("thumbs"));
            if let Some(thumbs) = &thumbs {
                let _ = std::fs::create_dir_all(thumbs);
                let _ = app.asset_protocol_scope().allow_directory(thumbs, true);
            }
            // allow existing roots
            if let Ok(roots) = db::list_roots(&conn) {
                for r in roots {
                    let _ = app.asset_protocol_scope().allow_directory(&r.path, true);
                }
            }
            // allow the managed collection folder
            if let Ok(Some(root)) = db::get_setting(&conn, "collection_root") {
                if !root.trim().is_empty() {
                    let _ = app.asset_protocol_scope().allow_directory(&root, true);
                }
            }
            app.manage(std::sync::Mutex::new(conn));
            app.manage(std::sync::Mutex::new(None::<crypto::Dek>));
            app.manage(ShareState::default());
            // the upkeep runs on its own thread, setup blocks the main thread and the page
            // (even the splash) can't load until it returns. The thread takes the DB lock
            // first, so the first library read still sees the result.
            let handle = app.handle().clone();
            let covers = covers_dir(app).ok();
            let versions = dir.join("versions");
            std::thread::spawn(move || {
                let db = handle.state::<Db>();
                let Ok(conn) = db.lock() else { return };
                // remove verified marks whose template doesn't verify anymore
                startup_step("template re-verification", || {
                    if let Err(e) = template::reverify_applied(&conn) {
                        eprintln!("micoll: template re-verification skipped: {e}");
                    }
                });
                // fix previews of rewards moved by older builds
                if let Some(thumbs) = &thumbs {
                    startup_step("MiSD preview repair", || {
                        match sd::repair_previews(&conn, thumbs) {
                            Ok(n) if n > 0 => eprintln!("micoll: re-keyed {n} MiSD preview(s)"),
                            Err(e) => eprintln!("micoll: MiSD preview repair skipped: {e}"),
                            _ => {}
                        }
                    });
                    // with the disk connected, save the previews the transport missed
                    startup_step("MiSD preview fill", || {
                        fill_sd_previews(&handle, &conn, None, None)
                    });
                }
                // versions and cover crops saved under an older app folder. Has to run
                // before the orphan cover sweep, which would take them for unused.
                startup_step("moved path repair", || {
                    let mut n = heal_moved_paths(&conn, &versions, &[("image_versions", "file_path")]);
                    // a cover can also be an edited version of an image
                    n += heal_moved_paths(&conn, &versions, COVER_COLUMNS);
                    if let Some(dir) = &covers {
                        n += heal_moved_paths(&conn, dir, COVER_COLUMNS);
                    }
                    if n > 0 {
                        eprintln!("micoll: pointed {n} moved path(s) at this app folder");
                    }
                });
                // remove staging folders from earlier sessions
                startup_step("import staging sweep", || sweep_import_staging(&conn));
                if let Some(dir) = &covers {
                    startup_step("orphan cover sweep", || sweep_orphan_covers(&conn, dir));
                }
            });
            Ok(())
        })
        .invoke_handler(command_thread(tauri::generate_handler![
            list_roots,
            add_root,
            remove_root,
            clear_library,
            clear_roots,
            rescan,
            rescan_collection,
            rescan_artist,
            get_library,
            artist_images,
            set_reward_status,
            set_reward_collabs,
            clear_broken_collabs,
            set_period_platform,
            set_period_span,
            set_period_skipped,
            add_skipped_period,
            reveal_period,
            delete_period,
            fill_reward,
            fill_reward_plan,
            create_reward,
            create_missing_reward,
            ensure_period,
            move_rewards,
            move_images,
            merge_rewards,
            media_stats,
            read_file_props,
            write_file_props,
            summarize_file_props,
            clear_file_props,
            library_health,
            data_locations,
            portable_first_run,
            portable_adopt,
            portable_start_fresh,
            first_run_pending,
            relink_library,
            prune_missing,
            find_duplicates,
            storage_breakdown,
            set_artist_preview,
            reset_missing_covers,
            set_reward_cover,
            set_period_preview,
            rename_rewards,
            rename_images,
            library_size,
            set_artist_no_dates,
            set_platform_no_dates,
            set_artist_release_style,
            set_platform_release_style,
            set_artist_tag,
            set_artist_tags,
            set_artist_aliases,
            mark_reward_seen,
            mark_all_rewards_seen,
            set_artist_links,
            set_artist_notes,
            set_artist_kind,
            open_url,
            set_wallpaper,
            set_wallpaper_slideshow,
            set_artist_wallpaper_fav,
            set_artist_hidden,
            set_artist_graveyard,
            artist_size,
            library_sizes,
            set_image_wallpaper_fav,
            set_image_favorite,
            list_collections,
            create_collection,
            rename_collection,
            delete_collection,
            set_image_collection,
            create_artist,
            stage_files_for_import,
            analyze_import,
            import_clashes,
            commit_import,
            organize_collection,
            move_collection,
            show_in_explorer,
            reveal_artist,
            rename_artist,
            delete_rewards,
            import_wish_cover,
            add_wish,
            set_wished,
            delete_artist,
            add_artist_platform,
            delete_platform,
            delete_image,
            delete_images,
            get_thumbnail,
            read_image,
            get_setting,
            set_setting,
            import_template,
            import_template_file,
            export_template,
            apply_template,
            list_templates,
            read_template,
            shrink_template_covers,
            restore_template_covers,
            reveal_template,
            delete_template,
            deactivate_template,
            can_sign,
            sign_template,
            issue_theme_key,
            verify_theme_license,
            theme_key_fingerprint,
            generate_signing_keypair,
            sd_setup,
            sd_status,
            sd_available,
            sd_mark,
            sd_queued_creators,
            sd_mark_year,
            sd_year_rule,
            sd_year_rules,
            sd_transport,
            sd_return,
            sd_backup_now,
            sd_backup_drop,
            sd_cancel,
            prepare_for_update,
            set_rewards_extra,
            migrate_cover_crops,
            discard_staging,
            open_with_default,
            edit_inpaint,
            edit_inpaint_ai,
            edit_resize,
            edit_expand,
            edit_upscale,
            edit_cutout,
            ai_model_status,
            ai_model_download,
            edit_detect,
            edit_save,
            save_cover_crop,
            index_added_image,
            save_image_version,
            list_image_versions,
            image_versions_for,
            set_active_version,
            delete_image_version,
            set_password,
            has_password,
            verify_password,
            encryption_state,
            enable_encryption,
            disable_encryption,
            encrypt_collection,
            unlock,
            unlock_recovery,
            lock,
            set_decoy_password,
            has_decoy_password,
            backup_database,
            list_backups,
            restore_backup,
            reveal_backups,
            restore_database,
            share_to_phone,
            share_folder_to_phone,
            stop_sharing,
            copy_files_to_clipboard,
            copy_image_to_clipboard,
            windows_share,
            claim_audio_name,
            export_file,
            export_files,
            mega_status,
            mega_upload,
            mega_upload_files,
            media_dimensions,
            mega_upload_media,
            open_megacmd,
            extract_archive,
            trash_path,
            set_close_to_tray,
            take_launch_action,
            is_portable,
            portable_update,
        ]))
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // never end in the middle of a command (closing the window during an import):
            // wait for it off the window's thread, then end the way it was asked to
            if let tauri::RunEvent::ExitRequested { api, code, .. } = event {
                match COMMAND_RUNNING.try_lock() {
                    // nothing running: keep it locked so no command starts while ending
                    Ok(idle) => std::mem::forget(idle),
                    Err(std::sync::TryLockError::Poisoned(idle)) => std::mem::forget(idle),
                    Err(std::sync::TryLockError::WouldBlock) => {
                        api.prevent_exit();
                        let app = app.clone();
                        std::thread::spawn(move || {
                            drop(wait_for_command());
                            app.exit(code.unwrap_or(0));
                        });
                    }
                }
            }
        });
}

/* ---- integration test against the real sample data ------------------- */

#[cfg(test)]
mod tests {
    use super::{
        clear_missing_covers, common_parent, encode_cover, forget_staged, heal_moved_paths,
        is_legacy_cover_crop,
        migrate_cover_crops_in, remember_staged, staged_here,
        staging_dir_of, stage_beside_source, sweep_orphan_covers, sweep_staging_folders,
        undo_staged, Staged, COVER_MAX_EDGE, STAGING_PREFIX,
    };
    use super::{is_empty_tree, period_month_dir, period_own_dir, plan_reward_trash, RewardTrash};
    use std::path::PathBuf;

    /// the tables the delete plans read
    fn delete_db() -> rusqlite::Connection {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE settings (key TEXT, value TEXT);
             CREATE TABLE artists (id INTEGER, name TEXT, graveyard INTEGER DEFAULT 0);
             CREATE TABLE periods (id INTEGER, artist_id INTEGER, platform TEXT, year INTEGER,
                                   month INTEGER, number INTEGER);
             CREATE TABLE rewards (id INTEGER, period_id INTEGER, folder_path TEXT);
             CREATE TABLE images (reward_id INTEGER, file_path TEXT);
             INSERT INTO settings VALUES ('collection_root', 'C:\\coll');
             INSERT INTO artists (id, name) VALUES (1, 'A');",
        )
        .unwrap();
        conn
    }

    /// deleting the empty "Unsorted" tab took Twitter\Unsorted\Gifs with it, the
    /// folders were picked by name
    #[test]
    fn deleting_a_platform_never_picks_folders_by_name() {
        let conn = delete_db();
        conn.execute_batch(
            "INSERT INTO periods VALUES (1, 1, 'Twitter', NULL, NULL, NULL), (2, 1, NULL, NULL, NULL, NULL);
             INSERT INTO rewards VALUES (10, 1, 'C:\\coll\\MiColl\\A\\Twitter\\Unsorted\\Gifs');",
        )
        .unwrap();
        let unsorted = crate::db::platform_reward_ids(&conn, 1, "Unsorted").unwrap();
        assert!(unsorted.is_empty());
        assert!(plan_reward_trash(&conn, &unsorted).unwrap().is_empty());

        let twitter = crate::db::platform_reward_ids(&conn, 1, "Twitter").unwrap();
        assert_eq!(
            plan_reward_trash(&conn, &twitter).unwrap(),
            vec![(10, RewardTrash::Folder(PathBuf::from(r"C:\coll\MiColl\A\Twitter\Unsorted\Gifs")))]
        );
    }

    /// a root reward's folder is the month folder, the other rewards live in it
    #[test]
    fn a_root_reward_only_takes_its_own_files() {
        let conn = delete_db();
        conn.execute_batch(
            "INSERT INTO periods VALUES (1, 1, 'Patreon', 2026, 3, NULL);
             INSERT INTO rewards VALUES
                (20, 1, 'C:\\coll\\MiColl\\A\\Patreon\\2026\\03'),
                (21, 1, 'C:\\Coll\\MiColl\\a\\Patreon\\2026\\03\\Sub'),
                (22, 1, 'A' || char(1) || 'Patreon' || char(1) || '2026' || char(1) || 'placeholder');
             INSERT INTO images VALUES (20, 'C:\\coll\\MiColl\\A\\Patreon\\2026\\03\\a.jpg');",
        )
        .unwrap();
        // another reward stays inside (case doesn't matter on Windows): only its file
        assert_eq!(
            plan_reward_trash(&conn, &[20]).unwrap(),
            vec![(20, RewardTrash::Files(vec![PathBuf::from(r"C:\coll\MiColl\A\Patreon\2026\03\a.jpg")]))]
        );
        // both go: the folder can go whole. The placeholder has no folder
        let plan = plan_reward_trash(&conn, &[20, 21, 22]).unwrap();
        assert_eq!(plan.len(), 2);
        assert!(plan.iter().all(|(_, t)| matches!(t, RewardTrash::Folder(_))));
    }

    /// a period without a date rebuilt its folder as the platform's, or the whole creator's
    #[test]
    fn a_period_without_a_date_has_no_own_folder() {
        let conn = delete_db();
        conn.execute_batch(
            "INSERT INTO periods VALUES
                (1, 1, NULL, NULL, NULL, NULL),
                (2, 1, 'Twitter', NULL, NULL, NULL),
                (3, 1, 'Patreon', 2026, 3, NULL);",
        )
        .unwrap();
        // what delete_period used to send to the recycle bin
        assert_eq!(period_month_dir(&conn, 1), Some(PathBuf::from(r"C:\coll\MiColl\A")));
        assert_eq!(period_own_dir(&conn, 1), None);
        assert_eq!(period_own_dir(&conn, 2), None);
        assert_eq!(
            period_own_dir(&conn, 3),
            Some(PathBuf::from(r"C:\coll\MiColl\A\Patreon\2026\03"))
        );
    }

    /// a folder only goes whole when no file is left anywhere inside
    #[test]
    fn folders_with_files_never_go_whole() {
        let base = std::env::temp_dir().join(format!("micoll_emptytree_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(base.join("Unsorted").join("Unsorted")).unwrap();
        let none = std::collections::HashSet::new();
        assert!(is_empty_tree(&base.join("Unsorted"), &none));
        std::fs::create_dir_all(base.join("Unsorted").join("2026").join("Gifs")).unwrap();
        std::fs::write(base.join("Unsorted").join("2026").join("Gifs").join("a.gif"), b"x").unwrap();
        assert!(!is_empty_tree(&base.join("Unsorted"), &none));
        // a boundary never goes, even empty
        let bound: std::collections::HashSet<String> =
            [super::norm_path(&base.join("Unsorted").join("Unsorted"))].into_iter().collect();
        assert!(!is_empty_tree(&base.join("Unsorted").join("Unsorted"), &bound));
        assert!(!is_empty_tree(&base.join("missing"), &none));
        let _ = std::fs::remove_dir_all(&base);
    }

    /// only covers whose file is really gone are reset, not ones on a missing drive
    #[test]
    fn only_really_missing_covers_are_reset() {
        let dir = std::env::temp_dir().join(format!("micoll_missing_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let there = dir.join("there.jpg");
        std::fs::write(&there, b"x").unwrap();
        let there = there.to_string_lossy().to_string();
        let gone = dir.join("gone.jpg").to_string_lossy().to_string();
        // a drive letter that isn't mounted, like an unplugged disk
        let offline_drive = ('D'..='Z')
            .rev()
            .find(|c| !std::path::Path::new(&format!("{c}:\\")).exists())
            .expect("a free drive letter");
        let offline = format!("{offline_drive}:\\Creator\\cover.jpg");

        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE artists (id INTEGER, preview_image TEXT);
             CREATE TABLE periods (id INTEGER, preview_image TEXT);
             CREATE TABLE rewards (id INTEGER, cover_image TEXT, cover_custom INTEGER);",
        )
        .unwrap();
        conn.execute(
            "INSERT INTO artists VALUES (1, ?1), (2, ?2), (3, ?3), (4, NULL)",
            [&there, &gone, &offline],
        )
        .unwrap();
        conn.execute("INSERT INTO rewards VALUES (1, ?1, 1)", [&gone]).unwrap();

        assert_eq!(clear_missing_covers(&conn), 2);
        let artist = |id: i64| -> Option<String> {
            conn.query_row("SELECT preview_image FROM artists WHERE id = ?1", [id], |r| r.get(0))
                .unwrap()
        };
        assert_eq!(artist(1), Some(there));
        assert_eq!(artist(2), None);
        assert_eq!(artist(3), Some(offline));
        let (cover, custom): (Option<String>, i64) = conn
            .query_row("SELECT cover_image, cover_custom FROM rewards", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        assert_eq!((cover, custom), (None, 0));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// paths from an old app folder move to the new one, but only when the file is there
    #[test]
    fn moved_paths_point_at_the_current_folder() {
        let root = std::env::temp_dir().join(format!("micoll_heal_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let dir = root.join("versions");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("3.png"), b"v").unwrap();
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE image_versions (id INTEGER, file_path TEXT);").unwrap();
        let here = dir.join("3.png").to_string_lossy().to_string();
        conn.execute(
            r"INSERT INTO image_versions VALUES (1, 'C:\old\app\versions\3.png'),
                                               (2, 'C:\old\app\versions\4.png'),
                                               (3, ?1),
                                               (4, 'F:\Creator\2024\3.png')",
            [&here],
        )
        .unwrap();

        let n = heal_moved_paths(&conn, &dir, &[("image_versions", "file_path")]);

        assert_eq!(n, 1);
        let get = |id: i64| -> String {
            conn.query_row("SELECT file_path FROM image_versions WHERE id = ?1", [id], |r| r.get(0))
                .unwrap()
        };
        assert_eq!(get(1), here);
        assert_eq!(get(2), r"C:\old\app\versions\4.png"); // no file here, left alone
        assert_eq!(get(3), here);
        // same file name, but not from a versions folder (a reward image on a disk)
        assert_eq!(get(4), r"F:\Creator\2024\3.png");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// the path check before a recursive delete, only the last case may be deleted
    #[test]
    fn only_our_own_folder_in_temp_counts_as_staging() {
        let temp = std::env::temp_dir();
        let ours = temp.join(format!("{STAGING_PREFIX}12345"));

        // the folder and anything inside resolve to the folder
        assert_eq!(staging_dir_of(&ours.to_string_lossy()).as_deref(), Some(ours.as_path()));
        assert_eq!(
            staging_dir_of(&ours.join("New reward").join("a.jpg").to_string_lossy()).as_deref(),
            Some(ours.as_path()),
            "a path inside it still resolves to the folder, never deeper"
        );

        // not the temp folder itself
        assert_eq!(staging_dir_of(&temp.to_string_lossy()), None);
        // not an unrelated folder in it
        assert_eq!(staging_dir_of(&temp.join("something-else").to_string_lossy()), None);
        // not the same NAME somewhere else (that would have deleted a real collection)
        assert_eq!(
            staging_dir_of(&format!(r"D:\Collection\{STAGING_PREFIX}12345\Nora")),
            None,
            "the name alone is not enough; it has to sit in temp"
        );
        // not one nested deeper
        assert_eq!(
            staging_dir_of(&temp.join("sub").join(format!("{STAGING_PREFIX}9")).to_string_lossy()),
            None,
        );
    }

    /// second check: an unmanaged import's rewards may be inside the staging folder
    #[test]
    fn a_folder_that_still_holds_an_indexed_reward_is_not_disposable() {
        let base = std::env::temp_dir().join(format!("micoll_stage_test_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        let conn = db::open(&base.join("t.db")).unwrap();
        conn.execute("INSERT INTO artists(name) VALUES('Nora')", []).unwrap();
        let aid: i64 = conn.query_row("SELECT id FROM artists", [], |r| r.get(0)).unwrap();
        conn.execute(
            "INSERT INTO periods(artist_id, label, folder_path) VALUES(?1, 'Misc', 'k1')",
            rusqlite::params![aid],
        )
        .unwrap();
        let pid: i64 = conn.query_row("SELECT id FROM periods", [], |r| r.get(0)).unwrap();

        let staged = r"C:\Temp\micoll-import-1";
        assert!(!db::any_reward_under(&conn, staged).unwrap(), "empty to begin with");

        conn.execute(
            "INSERT INTO rewards(period_id, title, folder_path) VALUES(?1, 'Pack', ?2)",
            rusqlite::params![pid, format!(r"{staged}\New reward")],
        )
        .unwrap();
        assert!(db::any_reward_under(&conn, staged).unwrap(), "a reward lives in there now");

        // a sibling with a similar name doesn't count
        assert!(
            !db::any_reward_under(&conn, r"C:\Temp\micoll-import-12").unwrap(),
            "prefix match must respect the separator"
        );
        let _ = std::fs::remove_dir_all(&base);
    }

    /// "where it came from" only works with one source folder
    #[test]
    fn a_drop_from_two_folders_has_no_source_folder() {
        use std::path::PathBuf;
        let a = PathBuf::from(r"D:\Downloads\a.jpg");
        let b = PathBuf::from(r"D:\Downloads\b.jpg");
        let elsewhere = PathBuf::from(r"E:\Pics\c.jpg");
        assert_eq!(
            common_parent(&[a.clone(), b]),
            Some(PathBuf::from(r"D:\Downloads")),
        );
        assert_eq!(common_parent(&[a, elsewhere]), None, "two folders, no answer");
        assert_eq!(common_parent(&[]), None);
    }

    /// staging next to the source MOVES the files, and if one fails nothing changes
    #[test]
    fn staging_beside_the_source_moves_everything_or_puts_it_all_back() {
        let base = std::env::temp_dir().join(format!("micoll_beside_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let src = base.join("Downloads");
        std::fs::create_dir_all(&src).unwrap();
        let (a, b) = (src.join("a.jpg"), src.join("b.jpg"));
        std::fs::write(&a, b"a").unwrap();
        std::fs::write(&b, b"b").unwrap();

        let dir = stage_beside_source(&src, "New reward", &[a.clone(), b.clone()]).unwrap();
        assert_eq!(dir, src.join("New reward"));
        assert_eq!(std::fs::read(dir.join("a.jpg")).unwrap(), b"a");
        assert_eq!(std::fs::read(dir.join("b.jpg")).unwrap(), b"b");
        assert!(!a.exists() && !b.exists(), "moved, not copied — exactly one copy exists");

        // one file is gone: the other goes back
        let c = src.join("c.jpg");
        std::fs::write(&c, b"c").unwrap();
        let ghost = src.join("never-existed.jpg");
        assert!(stage_beside_source(&src, "Another", &[c.clone(), ghost]).is_none());
        assert_eq!(std::fs::read(&c).unwrap(), b"c", "the moved file was put back");
        assert!(!src.join("Another").exists(), "and the half-made folder is gone");

        let _ = std::fs::remove_dir_all(&base);
    }

    /// the 50 MB cover case: now it comes out small as JPEG
    #[test]
    fn a_cover_crop_is_cover_sized() {
        // noise, flat color would compress to nothing
        let mut seed = 7u32;
        let big = image::RgbaImage::from_fn(4000, 6000, |_, _| {
            seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            let b = seed.to_le_bytes();
            image::Rgba([b[0], b[1], b[2], 255])
        });
        let (bytes, ext) = encode_cover(big).unwrap();
        assert_eq!(ext, "jpg", "an opaque crop is a JPEG");
        let back = image::load_from_memory(&bytes).unwrap();
        assert_eq!(back.height(), COVER_MAX_EDGE, "long edge capped");
        assert_eq!(back.width(), COVER_MAX_EDGE * 4 / 6, "aspect kept");

        // small crops aren't enlarged
        let small = image::RgbaImage::from_pixel(300, 200, image::Rgba([9, 9, 9, 255]));
        let back = image::load_from_memory(&encode_cover(small).unwrap().0).unwrap();
        assert_eq!((back.width(), back.height()), (300, 200));

        // a transparent crop stays transparent
        let clear = image::RgbaImage::from_pixel(64, 64, image::Rgba([0, 0, 0, 0]));
        assert_eq!(encode_cover(clear).unwrap().1, "png");
    }

    /// only the exact crop tool names count
    #[test]
    fn only_the_crop_tools_own_names_are_crops() {
        for yes in ["_cover_1727000000000.png", "_cover_1727000000000_2.png", "_cover_5.PNG"] {
            assert!(is_legacy_cover_crop(yes), "{yes}");
        }
        for no in [
            "_cover.jpg",            // a template's cover, not a crop
            "_cover.png",
            "my_cover_1.png",        // a creator's own file
            "_cover_final.png",
            "_cover_123.jpg",        // the crop tool never wrote JPEG
            "_cover_123_.png",
            "_cover__1.png",
            "_cover_.png",
            "cover_123.png",
            "01.png",
        ] {
            assert!(!is_legacy_cover_crop(no), "{no}");
        }
    }

    /// the migration only takes crops, and used ones are re-pointed first
    #[test]
    fn the_migration_moves_crops_and_only_crops() {
        let base = std::env::temp_dir().join(format!("micoll_cmig_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let pack = base.join("coll").join("Nora").join("Pack");
        std::fs::create_dir_all(&pack).unwrap();
        let used = pack.join("_cover_123.png");
        image::RgbaImage::from_pixel(3000, 1000, image::Rgba([200, 40, 40, 255]))
            .save(&used)
            .unwrap();
        let stale = pack.join("_cover_456_2.png");
        let keep = ["01.jpg", "_cover.jpg", "my_cover_1.png", "_cover_final.png"];
        std::fs::write(&stale, b"old crop").unwrap();
        for k in keep {
            std::fs::write(pack.join(k), b"not ours").unwrap();
        }

        let db: db::Db = std::sync::Mutex::new(db::open(&base.join("t.db")).unwrap());
        let gone = pack.join("_cover_999.png"); // on a disk that isn't here
        {
            let conn = db.lock().unwrap();
            conn.execute(
                "INSERT INTO artists(name, preview_image) VALUES('Nora', ?1)",
                rusqlite::params![gone.to_string_lossy()],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO periods(artist_id, label, folder_path, preview_image) VALUES(1, 'Misc', 'k', ?1)",
                rusqlite::params![used.to_string_lossy()],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO rewards(period_id, title, folder_path, cover_image, cover_custom) VALUES(1, 'Pack', ?1, ?2, 1)",
                rusqlite::params![pack.to_string_lossy(), used.to_string_lossy()],
            )
            .unwrap();
        }

        let covers = base.join("covers");
        let out = migrate_cover_crops_in(
            &db,
            &[base.join("coll")],
            &covers,
            None,
            false,
            &|p| std::fs::remove_file(p).map_err(|e| e.to_string()),
        )
        .unwrap();
        assert_eq!((out.moved, out.binned, out.deferred), (1, 1, 1), "{:?}", out.errors);

        assert!(!used.exists() && !stale.exists(), "both crops are out of the folder");
        for k in keep {
            assert!(pack.join(k).is_file(), "{k} is not a crop and stays");
        }

        let conn = db.lock().unwrap();
        let cover: String = conn.query_row("SELECT cover_image FROM rewards", [], |r| r.get(0)).unwrap();
        let month: String = conn.query_row("SELECT preview_image FROM periods", [], |r| r.get(0)).unwrap();
        let artist: String = conn.query_row("SELECT preview_image FROM artists", [], |r| r.get(0)).unwrap();
        assert_eq!(cover, month, "both uses of the crop follow it");
        assert!(cover.starts_with(&*covers.to_string_lossy()), "{cover}");
        let img = image::open(&cover).unwrap();
        assert_eq!((img.width(), img.height()), (2048, 683), "and it is cover-sized now");
        assert_eq!(artist, gone.to_string_lossy(), "an unreachable one waits, untouched");
        drop(conn);
        let _ = std::fs::remove_dir_all(&base);
    }

    /// unused crops go, used ones and non-crops stay
    #[test]
    fn only_unreferenced_crops_are_swept() {
        let base = std::env::temp_dir().join(format!("micoll_covers_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let dir = base.join("covers");
        std::fs::create_dir_all(&dir).unwrap();
        let conn = db::open(&base.join("t.db")).unwrap();

        let used = dir.join("cover_1.jpg");
        let orphan = dir.join("cover_2.jpg");
        let foreign = dir.join("keep-me.txt");
        for f in [&used, &orphan, &foreign] {
            std::fs::write(f, b"x").unwrap();
        }
        conn.execute("INSERT INTO artists(name, preview_image) VALUES('Nora', ?1)",
                     rusqlite::params![used.to_string_lossy()])
            .unwrap();

        sweep_orphan_covers(&conn, &dir);
        assert!(used.is_file(), "a creator still shows it");
        assert!(!orphan.exists(), "nothing shows this one");
        assert!(foreign.is_file(), "not a crop, not ours");
        let _ = std::fs::remove_dir_all(&base);
    }

    /// the registry tells our folders apart from the user's
    #[test]
    fn only_a_folder_we_made_can_be_taken_back() {
        let base = std::env::temp_dir().join(format!("micoll_reg_{}", std::process::id()));
        let mine = base.join("New reward");
        let theirs = base.join("A folder they dropped");
        remember_staged(&mine, Staged::MovedFiles);

        assert_eq!(staged_here(&mine).map(|(_, k)| k), Some(Staged::MovedFiles));
        assert_eq!(
            staged_here(&mine.join("inner")).map(|(d, _)| d),
            Some(mine.clone()),
            "a path inside it resolves to the folder we made — an archive's import \
             path can sit a level down"
        );
        assert!(staged_here(&theirs).is_none(), "a folder they dropped is never ours");
        assert!(staged_here(&base).is_none(), "and neither is the folder above ours");

        forget_staged(&mine);
        assert!(staged_here(&mine).is_none(), "committed or undone, the door closes");
    }

    /// cancelling puts the user's folder back like before
    #[test]
    fn cancelling_puts_the_files_back_where_they_came_from() {
        let base = std::env::temp_dir().join(format!("micoll_undo_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let src = base.join("Downloads");
        std::fs::create_dir_all(&src).unwrap();
        let (a, b) = (src.join("a.jpg"), src.join("b.jpg"));
        std::fs::write(&a, b"a").unwrap();
        std::fs::write(&b, b"b").unwrap();

        let dir = stage_beside_source(&src, "New reward", &[a.clone(), b.clone()]).unwrap();
        assert!(!a.exists(), "staged: the files moved into the reward folder");

        undo_staged(&dir, Staged::MovedFiles);
        assert_eq!(std::fs::read(&a).unwrap(), b"a", "back where it came from");
        assert_eq!(std::fs::read(&b).unwrap(), b"b");
        assert!(!dir.exists(), "and the folder we made is gone again");

        // anything not from us keeps the folder
        let dir = stage_beside_source(&src, "Another", &[a.clone()]).unwrap();
        std::fs::create_dir(dir.join("they put this here")).unwrap();
        undo_staged(&dir, Staged::MovedFiles);
        assert_eq!(std::fs::read(&a).unwrap(), b"a", "our file still went back");
        assert!(dir.is_dir(), "but the folder stays — it still holds something");

        // an unpacked archive folder just goes, the archive stays
        let zip = src.join("pack.zip");
        std::fs::write(&zip, b"PK").unwrap();
        let unpacked = src.join("pack");
        std::fs::create_dir(&unpacked).unwrap();
        std::fs::write(unpacked.join("01.jpg"), b"x").unwrap();
        undo_staged(&unpacked, Staged::Unpacked);
        assert!(!unpacked.exists(), "the extracted folder is gone");
        assert!(zip.is_file(), "the archive is exactly where it was");

        let _ = std::fs::remove_dir_all(&base);
    }

    /// the sweep deletes, respects the age, and never takes a folder with an indexed reward
    #[test]
    fn the_startup_sweep_takes_old_staging_folders_and_nothing_else() {
        use std::time::Duration;
        let base = std::env::temp_dir().join(format!("micoll_sweep_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let fake_temp = base.join("temp");
        std::fs::create_dir_all(&fake_temp).unwrap();
        let conn = db::open(&base.join("t.db")).unwrap();

        let stale = fake_temp.join(format!("{STAGING_PREFIX}1"));
        let occupied = fake_temp.join(format!("{STAGING_PREFIX}2"));
        let foreign = fake_temp.join("something-else");
        for d in [&stale, &occupied, &foreign] {
            std::fs::create_dir_all(d.join("New reward")).unwrap();
            std::fs::write(d.join("New reward").join("a.jpg"), b"x").unwrap();
        }

        // occupied = an unmanaged import, its reward is indexed there
        conn.execute("INSERT INTO artists(name) VALUES('Nora')", []).unwrap();
        let aid: i64 = conn.query_row("SELECT id FROM artists", [], |r| r.get(0)).unwrap();
        conn.execute(
            "INSERT INTO periods(artist_id, label, folder_path) VALUES(?1, 'Misc', 'k1')",
            rusqlite::params![aid],
        )
        .unwrap();
        let pid: i64 = conn.query_row("SELECT id FROM periods", [], |r| r.get(0)).unwrap();
        conn.execute(
            "INSERT INTO rewards(period_id, title, folder_path) VALUES(?1, 'Pack', ?2)",
            rusqlite::params![pid, occupied.join("New reward").to_string_lossy()],
        )
        .unwrap();

        // all just made, a one-day threshold takes nothing
        sweep_staging_folders(&conn, &fake_temp, Duration::from_secs(24 * 60 * 60));
        assert!(stale.is_dir(), "a fresh staging folder is left alone");

        // threshold 0: only the other two checks protect them now
        sweep_staging_folders(&conn, &fake_temp, Duration::ZERO);
        assert!(!stale.exists(), "the leftover folder is gone");
        assert!(occupied.is_dir(), "not one that still holds an indexed reward");
        assert!(foreign.is_dir(), "and never a folder that isn't ours");

        let _ = std::fs::remove_dir_all(&base);
    }

    /// paste day = day zero, a 30-day key works through day 30
    #[test]
    fn a_trial_runs_through_its_last_day() {
        let start = 20_000; // any day
        let (last, over) = trial_window(start, 30, start);
        assert_eq!(last, 20_030);
        assert!(!over, "the day it is pasted is inside the window");
        assert!(!trial_window(start, 30, 20_030).1, "the last day still counts");
        assert!(trial_window(start, 30, 20_031).1, "the day after does not");
        // a key pasted and opened months later
        assert!(trial_window(start, 30, start + 400).1);
        // the clock going backwards can't make it expire
        assert!(!trial_window(start, 30, start - 5).1);
    }

    use super::*;

    /// the auto-backup flag is read read-only before the DB opens:
    /// on when not set, off only for "false", on without a database
    #[test]
    fn auto_backup_flag_is_read_without_disturbing_the_database() {
        let base = std::env::temp_dir().join(format!("micoll-autobk-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        let file = base.join("micoll.db");

        assert!(auto_backup_enabled(&file), "no database yet → the snapshot still runs");

        {
            let conn = db::open(&file).unwrap();
            assert!(auto_backup_enabled(&file), "unset → on");
            db::set_setting(&conn, AUTO_BACKUP_KEY, "false").unwrap();
            db::checkpoint(&conn);
        }
        assert!(!auto_backup_enabled(&file), "explicitly off");

        {
            let conn = db::open(&file).unwrap();
            db::set_setting(&conn, AUTO_BACKUP_KEY, "true").unwrap();
            db::checkpoint(&conn);
        }
        assert!(auto_backup_enabled(&file), "back on");

        let _ = std::fs::remove_dir_all(&base);
    }

    /// taking over the installed library copies the extras (with subfolders), not the
    /// database files and not the other copy's backups
    #[test]
    fn adopting_copies_the_extras_but_not_the_database_or_backups() {
        let base = std::env::temp_dir().join(format!("micoll-portable-{}", std::process::id()));
        let installed = base.join("appdata");
        let portable = base.join("beside-exe").join("data");
        std::fs::create_dir_all(installed.join("templates")).unwrap();
        std::fs::create_dir_all(installed.join("versions").join("nested")).unwrap();
        std::fs::create_dir_all(installed.join("backups")).unwrap();
        std::fs::create_dir_all(&portable).unwrap();
        std::fs::write(installed.join("micoll.db"), b"library").unwrap();
        std::fs::write(installed.join("micoll.db-wal"), b"wal").unwrap();
        std::fs::write(installed.join("templates").join("a.micoll.json"), b"{}").unwrap();
        std::fs::write(installed.join("versions").join("nested").join("v1.png"), b"px").unwrap();
        std::fs::write(installed.join("backups").join("old.db"), b"old").unwrap();
        // the portable copy already has its own empty database
        std::fs::write(portable.join("micoll.db"), b"mine").unwrap();

        copy_data_extras(&installed, &portable);

        assert!(portable.join("templates").join("a.micoll.json").is_file());
        assert!(portable.join("versions").join("nested").join("v1.png").is_file());
        // the database is swapped elsewhere, the other copy's WAL must not land here
        assert_eq!(std::fs::read(portable.join("micoll.db")).unwrap(), b"mine");
        assert!(!portable.join("micoll.db-wal").exists());
        // the other copy's backups stay theirs
        assert!(!portable.join("backups").exists());
        // the source isn't changed
        assert!(installed.join("micoll.db").is_file());
        assert!(installed.join("templates").join("a.micoll.json").is_file());
        let _ = std::fs::remove_dir_all(&base);
    }

    /// Range parsing: open, bounded, suffix and invalid
    #[test]
    fn ranges_parse_and_reject_correctly() {
        // bytes=0- = the whole file (capped later)
        assert_eq!(parse_range("bytes=0-", 100), Some((0, 99)));
        assert_eq!(parse_range("bytes=10-19", 100), Some((10, 19)));
        // end is clamped to the file
        assert_eq!(parse_range("bytes=90-1000", 100), Some((90, 99)));
        // suffix = the LAST n bytes
        assert_eq!(parse_range("bytes=-10", 100), Some((90, 99)));
        assert_eq!(parse_range("bytes=-1000", 100), Some((0, 99)));
        // invalid
        assert_eq!(parse_range("bytes=100-", 100), None);
        assert_eq!(parse_range("bytes=5-2", 100), None);
        assert_eq!(parse_range("bytes=0-", 0), None);
        assert_eq!(parse_range("bytes=-0", 100), None);
        assert_eq!(parse_range("items=0-5", 100), None);
    }

    /// a Range response reads only its window
    #[test]
    fn range_windows_read_exact_slices() {
        let p = std::env::temp_dir().join(format!("micoll_rw_{}.bin", std::process::id()));
        let all: Vec<u8> = (0..=255u8).collect();
        std::fs::write(&p, &all).unwrap();

        assert_eq!(read_window(&p, 0, 16).unwrap(), &all[0..16]);
        assert_eq!(read_window(&p, 250, 6).unwrap(), &all[250..256]);
        assert!(read_window(&p, 250, 10).is_err()); // past EOF

        // bytes=0- on a big file stays capped
        let (start, end) = parse_range("bytes=0-", 500 * 1024 * 1024).unwrap();
        let end = end.min(start.saturating_add(RANGE_CHUNK - 1));
        assert_eq!((start, end), (0, RANGE_CHUNK - 1));

        let _ = std::fs::remove_file(&p);
    }

    /// shrink targets: keeps the ratio, never bigger, one rule at a time
    #[test]
    fn shrink_targets_keep_ratio_and_never_enlarge() {
        let none = ResizeSpec { pct: None, width: None, height: None };
        assert_eq!(shrink_target(380, 720, &none), None);

        // percent
        let half = ResizeSpec { pct: Some(50.0), width: None, height: None };
        assert_eq!(shrink_target(380, 720, &half), Some((190, 360)));
        let over = ResizeSpec { pct: Some(150.0), width: None, height: None };
        assert_eq!(shrink_target(380, 720, &over), None); // never enlarge

        // max width -> height follows
        let w300 = ResizeSpec { pct: None, width: Some(300), height: None };
        assert_eq!(shrink_target(380, 720, &w300), Some((300, 568)));
        assert_eq!(shrink_target(200, 100, &w300), None); // already smaller

        // max height -> width follows
        let h360 = ResizeSpec { pct: None, width: None, height: Some(360) };
        assert_eq!(shrink_target(380, 720, &h360), Some((190, 360)));
        assert_eq!(shrink_target(4000, 6000, &h360), Some((240, 360)));
    }

    /// MEGAcmd prints UTF-16LE with BOM on Windows, decode it and find the email
    #[test]
    fn mega_whoami_utf16_is_parsed() {
        // same byte layout as mega-whoami.bat prints
        let bytes: &[u8] = &[
            0xFF, 0xFE, 0x41, 0x00, 0x63, 0x00, 0x63, 0x00, 0x6F, 0x00, 0x75, 0x00, 0x6E, 0x00,
            0x74, 0x00, 0x20, 0x00, 0x65, 0x00, 0x2D, 0x00, 0x6D, 0x00, 0x61, 0x00, 0x69, 0x00,
            0x6C, 0x00, 0x3A, 0x00, 0x20, 0x00, 0x73, 0x00, 0x6F, 0x00, 0x6D, 0x00, 0x65, 0x00,
            0x6F, 0x00, 0x6E, 0x00, 0x65, 0x00, 0x40, 0x00, 0x65, 0x00, 0x78, 0x00, 0x61, 0x00,
            0x6D, 0x00, 0x70, 0x00, 0x6C, 0x00, 0x65, 0x00, 0x2E, 0x00, 0x63, 0x00, 0x6F, 0x00,
            0x6D, 0x00, 0x0D, 0x00, 0x0A, 0x00,
        ];
        let text = decode_cli(bytes);
        assert!(text.contains("Account e-mail:"), "decoded: {text:?}");
        assert_eq!(parse_mega_email(&text).as_deref(), Some("someone@example.com"));
    }

    /// Temp folder like a real download pack, so the test doesn't depend on live data.
    #[test]
    fn indexes_download_pack_shape() {
        let base = std::env::temp_dir().join(format!("micoll_idx_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let touch = |p: std::path::PathBuf| {
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, b"x").unwrap();
        };
        // Pixelfox240_2026-02 / 2026-02 / <galleries> + Extra/<galleries>
        let month = base.join("Pixelfox240_2026-02").join("2026-02");
        touch(month.join("Juno - Starfall").join("01a.jpg"));
        touch(month.join("Juno - Starfall").join("00Step_by_Step").join("01.jpg"));
        touch(month.join("Aria - Skyline").join("01a.jpg"));
        touch(month.join("Extra").join("Lumi - Starfall").join("01a.jpg"));

        let conn = db::open(&base.join("t.db")).unwrap();
        let root = Root {
            id: 1,
            path: base.to_string_lossy().to_string(),
            label: Some("Test".into()),
            default_platform: Some("Patreon".into()),
        };
        indexer::scan_root(&conn, &root).unwrap();

        let lib = db::get_library(&conn).unwrap();
        let artist = lib.iter().find(|a| a.name == "Pixelfox240").expect("artist");
        let period = &artist.periods[0];
        assert_eq!(period.label, "2026-02");
        let titles: Vec<&str> = period.rewards.iter().map(|r| r.title.as_str()).collect();
        assert!(titles.contains(&"Aria - Skyline"), "got {:?}", titles);
        assert!(titles.contains(&"Juno - Starfall"));
        assert!(!titles.contains(&"Extra")); // "Extra" is a category, not a reward
        let extras: Vec<&str> = period
            .rewards
            .iter()
            .filter(|r| r.category.as_deref() == Some("Extra"))
            .map(|r| r.title.as_str())
            .collect();
        assert!(extras.contains(&"Lumi - Starfall"), "got {:?}", extras);

        let _ = std::fs::remove_dir_all(&base);
    }
}

#[cfg(test)]
mod graveyard_tests {
    use super::{db, graveyard_move, indexer, relink_dir, sync_graveyard_from_disk};
    use std::path::Path;

    fn touch(p: &Path) {
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, b"x").unwrap();
    }

    fn image_paths(conn: &rusqlite::Connection, artist: i64) -> Vec<String> {
        db::artist_own_image_paths(conn, artist).unwrap()
    }

    /// graveyard round trip on a real folder tree: in, rescan, out
    #[test]
    fn a_creator_moves_into_the_graveyard_folder_and_back() {
        // scanning changes the global platform list, take turns with the indexer tests
        let _list = indexer::tests::PLATFORM_LIST.lock().unwrap_or_else(|e| e.into_inner());
        let base = std::env::temp_dir().join(format!("micoll_grave_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let coll = base.join("coll");
        let shelf = coll.join("MiColl");
        // "Aurora" and "Aurora Vale": without a separator the path update would move both
        touch(&shelf.join("Aurora").join("Patreon").join("2026").join("02").join("Set").join("a.jpg"));
        touch(&shelf.join("Aurora Vale").join("Patreon").join("2026").join("03").join("Set").join("b.jpg"));

        let conn = db::open(&base.join("t.db")).unwrap();
        db::set_setting(&conn, "managed_enabled", "true").unwrap();
        db::set_setting(&conn, "collection_root", &coll.to_string_lossy()).unwrap();
        let root = db::Root {
            id: 0,
            path: shelf.to_string_lossy().into_owned(),
            label: None,
            default_platform: None,
        };
        let scan = |conn: &rusqlite::Connection| {
            let plan = indexer::plan_root(conn, &root).unwrap();
            indexer::commit(conn, &plan, None).unwrap();
        };
        scan(&conn);
        let aurora = db::artist_id_by_name(&conn, "Aurora").unwrap().unwrap();
        let vale = db::artist_id_by_name(&conn, "Aurora Vale").unwrap().unwrap();
        let vale_before = image_paths(&conn, vale);

        // in: folder moves, paths follow, the neighbour stays
        let moved = graveyard_move(&conn, aurora, true).unwrap();
        let grave = shelf.join(indexer::GRAVEYARD_DIR);
        assert_eq!(moved.as_deref(), Some(grave.join("Aurora").to_string_lossy().as_ref()));
        assert!(!shelf.join("Aurora").exists());
        let paths = image_paths(&conn, aurora);
        assert_eq!(paths.len(), 1);
        assert!(paths[0].contains(indexer::GRAVEYARD_DIR), "{paths:?}");
        assert!(Path::new(&paths[0]).is_file(), "the stored path must point at the moved file");
        assert_eq!(image_paths(&conn, vale), vale_before, "Aurora Vale must not be re-pointed");

        // a rescan reads the graveyard as a shelf of creators and finds new files
        touch(&grave.join("Aurora").join("Patreon").join("2026").join("04").join("New").join("c.jpg"));
        scan(&conn);
        let names: Vec<String> = {
            let mut st = conn.prepare("SELECT name FROM artists ORDER BY name").unwrap();
            st.query_map([], |r| r.get(0)).unwrap().collect::<Result<_, _>>().unwrap()
        };
        let reward_owner: Vec<(String, String)> = {
            let mut st = conn
                .prepare(
                    "SELECT a.name, r.folder_path FROM rewards r JOIN periods p ON p.id = r.period_id
                       JOIN artists a ON a.id = p.artist_id ORDER BY r.folder_path",
                )
                .unwrap();
            st.query_map([], |r| Ok((r.get(0)?, r.get(1)?))).unwrap().collect::<Result<_, _>>().unwrap()
        };
        assert_eq!(names, vec!["Aurora".to_string(), "Aurora Vale".to_string()], "{reward_owner:?}");
        assert!(
            reward_owner.iter().all(|(a, f)| f.contains(&format!("\\{a}\\"))),
            "every reward must stay with the creator whose folder holds it: {reward_owner:?}"
        );
        assert!(
            db::artist_id_by_name(&conn, indexer::GRAVEYARD_DIR).unwrap().is_none(),
            "the graveyard folder must not become a creator"
        );
        assert_eq!(db::artist_id_by_name(&conn, "Aurora").unwrap(), Some(aurora));
        assert_eq!(
            image_paths(&conn, aurora).len(),
            2,
            "the new file is found, and the old one isn't doubled"
        );
        sync_graveyard_from_disk(&conn, &shelf).unwrap();
        let flag = |id: i64| -> i64 {
            conn.query_row("SELECT graveyard FROM artists WHERE id=?1", [id], |r| r.get(0)).unwrap()
        };
        assert_eq!((flag(aurora), flag(vale)), (1, 0));

        // out again, the empty graveyard folder is gone
        graveyard_move(&conn, aurora, false).unwrap();
        assert!(shelf.join("Aurora").is_dir());
        assert!(!grave.exists());
        let paths = image_paths(&conn, aurora);
        assert!(paths.iter().all(|p| Path::new(p).is_file() && !p.contains(indexer::GRAVEYARD_DIR)));
        assert_eq!(flag(aurora), 0);

        drop(conn);
        let _ = std::fs::remove_dir_all(&base);
    }

    /// everything on the unplugged MiSD disk and the creator folder gone: "bring back"
    /// must still follow the creator into the graveyard and out
    #[test]
    fn offloaded_rewards_come_back_to_where_the_creator_lies() {
        let _list = indexer::tests::PLATFORM_LIST.lock().unwrap_or_else(|e| e.into_inner());
        let base = std::env::temp_dir().join(format!("micoll_grave_sd_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let coll = base.join("coll");
        let shelf = coll.join("MiColl");
        let sd = base.join("sd");
        touch(&shelf.join("Aurora").join("Patreon").join("2026").join("02").join("Set").join("a.jpg"));
        touch(&shelf.join("Aurora Vale").join("Patreon").join("2026").join("03").join("Set").join("b.jpg"));

        let conn = db::open(&base.join("t.db")).unwrap();
        db::set_setting(&conn, "managed_enabled", "true").unwrap();
        db::set_setting(&conn, "collection_root", &coll.to_string_lossy()).unwrap();
        let root = db::Root {
            id: 0,
            path: shelf.to_string_lossy().into_owned(),
            label: None,
            default_platform: None,
        };
        let plan = indexer::plan_root(&conn, &root).unwrap();
        indexer::commit(&conn, &plan, None).unwrap();
        let aurora = db::artist_id_by_name(&conn, "Aurora").unwrap().unwrap();
        let vale = db::artist_id_by_name(&conn, "Aurora Vale").unwrap().unwrap();

        // offload both creators like MiSD does: files on the disk, old folder remembered
        std::fs::create_dir_all(&sd).unwrap();
        for name in ["Aurora", "Aurora Vale"] {
            let (from, to) = (shelf.join(name), sd.join(name));
            std::fs::rename(&from, &to).unwrap();
            let (from, to) = (from.to_string_lossy().into_owned(), to.to_string_lossy().into_owned());
            relink_dir(&conn, &from, &to).unwrap();
            conn.execute(
                "UPDATE rewards SET sd_volume = 'MiSD', \
                 sd_origin = ?1 || substr(folder_path, length(?2)+1) \
                 WHERE substr(folder_path,1,length(?2)+1) = ?2 || '\\'",
                rusqlite::params![from, to],
            )
            .unwrap();
        }
        let origins = |id: i64| -> Vec<String> {
            let mut st = conn
                .prepare(
                    "SELECT r.sd_origin FROM rewards r JOIN periods p ON p.id = r.period_id \
                     WHERE p.artist_id = ?1",
                )
                .unwrap();
            st.query_map([id], |r| r.get(0)).unwrap().collect::<Result<_, _>>().unwrap()
        };
        let vale_before = origins(vale);
        let grave = shelf.join(indexer::GRAVEYARD_DIR);
        let under = |dir: &Path, o: &str| o.starts_with(&format!("{}\\", dir.to_string_lossy()));

        assert_eq!(graveyard_move(&conn, aurora, true).unwrap(), None, "nothing to move");
        let o = origins(aurora);
        assert!(!o.is_empty() && o.iter().all(|o| under(&grave.join("Aurora"), o)), "{o:?}");
        assert!(o.iter().all(|o| o.ends_with("\\Patreon\\2026\\02\\Set")), "{o:?}");
        assert_eq!(origins(vale), vale_before, "Aurora Vale must not be re-pointed");

        graveyard_move(&conn, aurora, false).unwrap();
        let o = origins(aurora);
        assert!(o.iter().all(|o| under(&shelf.join("Aurora"), o)), "{o:?}");

        drop(conn);
        let _ = std::fs::remove_dir_all(&base);
    }
}
