//! SQLite database for MiColl.
//! The folders on disk are the truth for files, the database stores how MiColl
//! reads them (artist/period/reward, status, previews, settings). Files are never moved
//! here.

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::path::Path;

pub type Db = std::sync::Mutex<Connection>;

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Root {
    pub id: i64,
    pub path: String,
    pub label: Option<String>,
    pub default_platform: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ImageItem {
    pub id: i64,
    /// Path of the ORIGINAL file (key for versions/favourites and all file actions).
    pub file_path: String,
    /// The path that's shown: the active version if one is selected, else the original.
    pub display_path: String,
    /// Number of edit versions (0 = only the original).
    pub version_count: i64,
    /// True when the original is shown.
    pub on_original: bool,
    pub rel_name: String,
    /// Marked as favourite wallpaper (saved by path in wallpaper_favs, survives
    /// re-indexing).
    pub fav_wallpaper: bool,
    /// In the "Favourites" collection (images and videos, saved by path in favorites).
    pub favorite: bool,
    /// Ids of the user collections this file is in. Empty in the light get_library load.
    pub collections: Vec<i64>,
}

/// One user collection (the "+" tabs on a creator page). Global.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CollectionRow {
    pub id: i64,
    pub name: String,
}

/// Another creator credited on a reward (collab).
#[derive(Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CollabRef {
    pub artist_id: i64,
    pub artist_name: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Reward {
    pub id: i64,
    pub title: String,
    pub category: Option<String>,
    pub folder_path: String,
    pub cover_image: Option<String>,
    /// True if the user picked the cover (the indexer sets cover_image by itself).
    /// Needed for "Reset cover".
    pub cover_custom: bool,
    pub status: String,
    /// True if the files are directly in the month folder (a "root" reward).
    pub is_root: bool,
    /// An extra (sketches, PSDs, wallpapers) next to the real rewards.
    /// Still in the month, but not used for the card mosaic.
    pub is_extra: bool,
    /// Number of media files (from a column, so the dashboard doesn't need image rows).
    pub image_count: i64,
    /// MiSD: queued for the next move.
    pub sd_marked: bool,
    /// MiSD: disk label if the reward is on the external disk.
    pub sd_volume: Option<String>,
    /// MiSD: queued for the next backup.
    pub sd_backup_marked: bool,
    /// MiSD: disk label if a backup copy exists (the local files stay).
    /// Unlike sd_volume this doesn't restrict anything.
    pub sd_backup: Option<String>,
    /// MiSD: date of the backup (YYYY-MM-DD) for the tooltip.
    pub sd_backup_at: Option<String>,
    /// Added but never opened -> "new" badge. Set on insert, cleared when the viewer
    /// opens it, a rescan never sets it again.
    pub fresh: bool,
    /// Is it on the wishlist and who owns the row:
    ///
    /// | value | meaning |
    /// |---|---|
    /// | 0 | not wished |
    /// | 1 | wished, the row only exists because of the wish |
    /// | 2 | wished, but the row was already there (a template lists it) |
    ///
    /// Template placeholders aren't wishes. A row we created can be deleted,
    /// a template's row can only lose the flag.
    pub wished: i64,
    /// Only on a BORROWED copy in a collaborator's tree: the real owner.
    /// None on the real row. Borrowed = view only, never counted, edited or deleted.
    pub collab_from: Option<CollabRef>,
    /// All creators this reward is credited to (on the real row and the borrowed copy).
    pub collab_with: Vec<CollabRef>,
    /// All images. Empty in the light get_library load, loaded per artist with
    /// artist_images.
    pub images: Vec<ImageItem>,
}

/// Images of one reward (from artist_images).
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RewardImages {
    pub reward_id: i64,
    pub images: Vec<ImageItem>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Period {
    pub id: i64,
    pub platform: Option<String>,
    pub year: Option<i64>,
    pub month: Option<i64>,
    /// Drop number for numbered periods ("#51"). None otherwise.
    pub number: Option<i64>,
    /// How many months this period covers (1 = normal). March+April = month=3, span=2.
    pub span: i64,
    pub label: String,
    pub folder_path: String,
    pub needs_review: bool,
    /// The artist took a break this month (shown as "Break", not counted).
    /// A _SKIPPED.txt marker on disk.
    pub skipped: bool,
    /// Verified by an applied template that contains this period.
    pub verified: bool,
    /// Preview picked for this month (None -> first reward cover).
    pub preview_image: Option<String>,
    /// Official count from a template (None = not tracked, the frontend uses the indexed
    /// count).
    pub official_total: Option<i64>,
    /// Always open the reward overview on click (set at import, "Open as folder cards").
    pub open_as_cards: bool,
    /// A fake period that only holds borrowed collab rewards (negative id, no DB row).
    /// Never pass it to a command that takes a period_id.
    pub collab_only: bool,
    pub rewards: Vec<Reward>,
}

/// Release style of one platform (see Artist::platform_styles).
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PlatformStyle {
    pub platform: String,
    pub style: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Artist {
    pub id: i64,
    pub name: String,
    pub preview_image: Option<String>,
    pub no_dates: bool,
    /// Platforms of this artist without dates (override or the artist default).
    pub no_dates_platforms: Vec<String>,
    /// How the creator releases: "monthly" | "numbered" | "none" (no_dates = "none").
    pub release_style: String,
    /// Release style per platform (override or the artist default).
    pub platform_styles: Vec<PlatformStyle>,
    /// Class: "heart" | "star" | "diamond" | "eye" | "new" | None.
    pub tag: Option<String>,
    /// JSON array of tags.
    pub tags: Option<String>,
    /// JSON array of other names (search finds them too).
    pub aliases: Option<String>,
    /// JSON array of {label, url} links.
    pub links: Option<String>,
    /// User notes.
    pub notes: Option<String>,
    /// Creator type, comma separated (options in src/lib/creatorTypes.tsx, not checked
    /// here).
    pub kind: Option<String>,
    /// When the content was last changed (ISO string, sorted as text).
    pub updated_at: Option<String>,
    /// Name of the applied template, if any.
    pub template_source: Option<String>,
    /// True only for official templates -> "Verified" badge.
    pub template_verified: bool,
    /// "Wallpaper favourites" is on for this artist.
    pub wallpaper_fav: bool,
    /// Hidden from the dashboard. Nothing is deleted, search and "show hidden" still find
    /// it.
    pub hidden: bool,
    /// In the graveyard: off the dashboard, only shown by the graveyard button. Nothing is
    /// deleted.
    pub graveyard: bool,
    pub periods: Vec<Period>,
}

pub fn open(path: &Path) -> rusqlite::Result<Connection> {
    let conn = Connection::open(path)?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    // never wait forever on a lock, an error is better than a frozen window
    let _ = conn.busy_timeout(std::time::Duration::from_secs(15));
    // fold the WAL into the db file on open. Before this the WAL was never checkpointed
    // and a crash lost all artist data on 2026-07-02.
    let _ = conn.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(()));
    // auto checkpoint when the WAL gets bigger than this (~2 MB). Big changes also
    // call checkpoint() right away.
    let _ = conn.pragma_update(None, "wal_autocheckpoint", 512);
    conn.pragma_update(None, "foreign_keys", "ON")?;
    migrate(&conn)?;
    Ok(conn)
}

/// Fold the WAL into the db file and truncate it. Call after big changes so they're
/// safe on disk right away. Best effort, a busy checkpoint is skipped.
pub fn checkpoint(conn: &Connection) {
    let _ = conn.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(()));
}

/// Copy the database (db + WAL, BEFORE it's opened) into <data>/backups/, once
/// per day, keeping the newest BACKUP_KEEP. Never blocks startup.
///
/// How many daily backups are kept (7 = one week).
pub const BACKUP_KEEP: usize = 7;

pub fn backup_rotate(data_dir: &Path) -> std::io::Result<()> {
    let db = data_dir.join("micoll.db");
    if !db.is_file() {
        return Ok(()); // first launch — nothing to back up yet
    }
    let dir = data_dir.join("backups");
    std::fs::create_dir_all(&dir)?;

    // one backup per day (the name sorts by date)
    let today = {
        let secs = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let days = secs / 86_400;
        // date from days since epoch (Howard Hinnant's algorithm)
        let z = days as i64 + 719_468;
        let era = z.div_euclid(146_097);
        let doe = z.rem_euclid(146_097);
        let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
        let y = yoe + era * 400;
        let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
        let mp = (5 * doy + 2) / 153;
        let d = doy - (153 * mp + 2) / 5 + 1;
        let m = if mp < 10 { mp + 3 } else { mp - 9 };
        let y = if m <= 2 { y + 1 } else { y };
        format!("{y:04}{m:02}{d:02}")
    };
    let dest = dir.join(format!("micoll-{today}.db"));
    if !dest.exists() {
        std::fs::copy(&db, &dest)?;
        let wal = data_dir.join("micoll.db-wal");
        let dest_wal = dir.join(format!("micoll-{today}.db-wal"));
        if wal.is_file() && std::fs::metadata(&wal).map(|m| m.len() > 0).unwrap_or(false) {
            let _ = std::fs::copy(&wal, &dest_wal);
        } else {
            let _ = std::fs::remove_file(&dest_wal); // stale sidecar from an older same-day copy
        }
    }

    // keep only the newest BACKUP_KEEP backups (with their WAL files)
    let mut snaps: Vec<String> = std::fs::read_dir(&dir)?
        .flatten()
        .filter_map(|e| e.file_name().into_string().ok())
        .filter(|n| n.starts_with("micoll-") && n.ends_with(".db"))
        .collect();
    snaps.sort();
    for old in snaps.iter().rev().skip(BACKUP_KEEP) {
        let _ = std::fs::remove_file(dir.join(old));
        let _ = std::fs::remove_file(dir.join(format!("{old}-wal")));
    }
    Ok(())
}

fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS settings (
            key   TEXT PRIMARY KEY,
            value TEXT
        );

        CREATE TABLE IF NOT EXISTS roots (
            id               INTEGER PRIMARY KEY,
            path             TEXT NOT NULL UNIQUE,
            label            TEXT,
            default_platform TEXT
        );

        CREATE TABLE IF NOT EXISTS artists (
            id              INTEGER PRIMARY KEY,
            name            TEXT NOT NULL UNIQUE,
            preview_image   TEXT,
            manual          INTEGER NOT NULL DEFAULT 0,
            no_dates        INTEGER NOT NULL DEFAULT 0,
            release_style   TEXT,
            tag             TEXT,
            links           TEXT,
            kind            TEXT,
            template_source TEXT,
            template_meta   TEXT,
            template_verified INTEGER NOT NULL DEFAULT 0,
            created_at      TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS periods (
            id           INTEGER PRIMARY KEY,
            artist_id    INTEGER NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
            platform     TEXT,
            year         INTEGER,
            month        INTEGER,
            number       INTEGER,
            span         INTEGER NOT NULL DEFAULT 1,
            label        TEXT NOT NULL,
            folder_path  TEXT NOT NULL UNIQUE,
            needs_review INTEGER NOT NULL DEFAULT 0,
            preview_image TEXT,
            official_total INTEGER,
            skipped  INTEGER NOT NULL DEFAULT 0,
            verified INTEGER NOT NULL DEFAULT 0,
            open_as_cards INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS rewards (
            id          INTEGER PRIMARY KEY,
            period_id   INTEGER NOT NULL REFERENCES periods(id) ON DELETE CASCADE,
            title       TEXT NOT NULL,
            category    TEXT,
            folder_path TEXT NOT NULL UNIQUE,
            cover_image TEXT,
            status      TEXT NOT NULL DEFAULT 'owned',
            image_count INTEGER NOT NULL DEFAULT 0,
            is_root     INTEGER NOT NULL DEFAULT 0,
            is_extra    INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS images (
            id        INTEGER PRIMARY KEY,
            reward_id INTEGER NOT NULL REFERENCES rewards(id) ON DELETE CASCADE,
            file_path TEXT NOT NULL,
            rel_name  TEXT,
            sort      INTEGER NOT NULL DEFAULT 0
        );

        -- Images the user marked as an artist's "favourite wallpaper". Keyed by
        -- absolute file path (not image id) so a mark survives re-indexing, which
        -- recreates image rows. The virtual "Fav. Wallpaper" folder is built from
        -- these without ever moving the files.
        CREATE TABLE IF NOT EXISTS wallpaper_favs (
            file_path TEXT PRIMARY KEY
        );

        -- The general "Favourites" collection (always on; any media incl. videos).
        -- Keyed by absolute path, same as wallpaper_favs, so it survives re-indexing.
        CREATE TABLE IF NOT EXISTS favorites (
            file_path TEXT PRIMARY KEY
        );

        -- User-made collections — the "+" tab next to Favourites and Fav. Wallpaper.
        -- Deliberately NOT scoped to an artist: membership is a global path mark, the
        -- same shape as favorites/wallpaper_favs, and each creator's page shows the
        -- slice of a collection that belongs to that creator. So one "Cosplay" group
        -- can span creators while still reading per-creator on their pages.
        CREATE TABLE IF NOT EXISTS collections (
            id         INTEGER PRIMARY KEY,
            name       TEXT NOT NULL,
            sort       INTEGER NOT NULL DEFAULT 0,
            created_at TEXT DEFAULT (datetime('now'))
        );
        -- Membership, keyed by absolute path so it survives re-indexing like the two
        -- built-in collections above.
        CREATE TABLE IF NOT EXISTS collection_items (
            collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
            file_path     TEXT NOT NULL,
            PRIMARY KEY (collection_id, file_path)
        );
        CREATE INDEX IF NOT EXISTS idx_collection_items_path ON collection_items(file_path);

        -- Non-destructive edit "versions" of an image. The ORIGINAL file is never
        -- modified; each edit is a separate file in app-data. Keyed by the original
        -- image's absolute path (NOT images.id, which a rescan deletes+recreates) so
        -- versions survive re-indexing — same rationale as favorites/wallpaper_favs.
        CREATE TABLE IF NOT EXISTS image_versions (
            id         INTEGER PRIMARY KEY,
            orig_path  TEXT NOT NULL,
            file_path  TEXT NOT NULL,
            label      TEXT,
            created_at TEXT DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_versions_orig ON image_versions(orig_path);

        -- Which version is currently displayed for an image. No row = the ORIGINAL is
        -- active. Keyed by original path so the choice also survives re-indexing.
        CREATE TABLE IF NOT EXISTS image_active_version (
            orig_path  TEXT PRIMARY KEY,
            version_id INTEGER NOT NULL REFERENCES image_versions(id) ON DELETE CASCADE
        );

        -- Templates applied to an artist. An artist can carry several (e.g. one
        -- per platform / per year). Each records the period scope it "owns" so
        -- overlapping templates can be detected and rejected at apply time.
        CREATE TABLE IF NOT EXISTS applied_templates (
            id         INTEGER PRIMARY KEY,
            artist_id  INTEGER NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
            name       TEXT NOT NULL,
            verified   INTEGER NOT NULL DEFAULT 0,
            coverage   TEXT NOT NULL,
            raw        TEXT,
            applied_at TEXT DEFAULT (datetime('now')),
            UNIQUE(artist_id, name)
        );

        -- Per-platform "posts without dates" overrides. When a row is present it
        -- wins over the artist-level `no_dates` default for that one platform, so an
        -- artist can keep dated months on (say) Patreon while a gallery platform
        -- skips the year/month level entirely. Keyed by the platform's display name
        -- ("Unsorted" for a null platform, matching the organize/UI sentinel).
        CREATE TABLE IF NOT EXISTS platform_no_dates (
            artist_id INTEGER NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
            platform  TEXT NOT NULL,
            no_dates  INTEGER NOT NULL DEFAULT 0,
            release_style TEXT,
            PRIMARY KEY(artist_id, platform)
        );

        -- A reward two creators made together. The files and the `rewards` row stay
        -- exactly where they are (in the owning creator's period); this table only
        -- says "also credit it to artist X". `get_library` uses it to project a
        -- read-only borrowed copy into the partner's tree — nothing is ever
        -- duplicated on disk or in `rewards`, so counts and templates stay honest.
        --
        -- Keyed on rewards.id, which `upsert_reward` preserves across rescans
        -- (ON CONFLICT(folder_path) DO UPDATE), so links survive re-indexing, renames
        -- inside MiColl and moves inside MiColl. A folder renamed OUTSIDE MiColl gets
        -- a new row, and the link is left pointing at the old one — reported as a
        -- broken link by `library_health` rather than silently dropped.
        CREATE TABLE IF NOT EXISTS reward_collabs (
            reward_id  INTEGER NOT NULL REFERENCES rewards(id) ON DELETE CASCADE,
            artist_id  INTEGER NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
            created_at TEXT DEFAULT (datetime('now')),
            PRIMARY KEY (reward_id, artist_id)
        );

        -- A standing MiSD order for one year of one platform: whatever is filed
        -- into it from here on joins the same queue, without the user having to
        -- remember. `mode` mirrors rewards.sd_marked (1 move, 2 backup).
        --
        -- platform/year are NULL-able because periods' are ("Misc", and a platform
        -- still awaiting review), and SQLite counts two NULLs as different values
        -- in a UNIQUE constraint — hence the expression index below rather than a
        -- table-level UNIQUE, so "Misc" can only ever hold one rule.
        CREATE TABLE IF NOT EXISTS sd_year_rules (
            id         INTEGER PRIMARY KEY,
            artist_id  INTEGER NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
            platform   TEXT,
            year       INTEGER,
            mode       INTEGER NOT NULL,
            created_at TEXT DEFAULT (datetime('now'))
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_sd_year_rule
            ON sd_year_rules(artist_id, IFNULL(platform, ''), IFNULL(year, -1));

        CREATE INDEX IF NOT EXISTS idx_periods_artist ON periods(artist_id);
        CREATE INDEX IF NOT EXISTS idx_rewards_period ON rewards(period_id);
        CREATE INDEX IF NOT EXISTS idx_images_reward  ON images(reward_id);
        CREATE INDEX IF NOT EXISTS idx_applied_artist ON applied_templates(artist_id);
        CREATE INDEX IF NOT EXISTS idx_collab_artist  ON reward_collabs(artist_id);
        "#,
    )?;
    // add columns for old databases (ignore "duplicate column" errors)
    let _ = conn.execute("ALTER TABLE artists ADD COLUMN manual INTEGER NOT NULL DEFAULT 0", []);
    let _ = conn.execute("ALTER TABLE artists ADD COLUMN no_dates INTEGER NOT NULL DEFAULT 0", []);
    let _ = conn.execute("ALTER TABLE artists ADD COLUMN tag TEXT", []);
    let _ = conn.execute("ALTER TABLE artists ADD COLUMN tags TEXT", []);
    let _ = conn.execute("ALTER TABLE artists ADD COLUMN aliases TEXT", []);
    let _ = conn.execute("ALTER TABLE artists ADD COLUMN links TEXT", []);
    let _ = conn.execute("ALTER TABLE artists ADD COLUMN notes TEXT", []);
    let _ = conn.execute("ALTER TABLE artists ADD COLUMN kind TEXT", []);
    let _ = conn.execute("ALTER TABLE artists ADD COLUMN template_source TEXT", []);
    let _ = conn.execute("ALTER TABLE artists ADD COLUMN template_meta TEXT", []);
    let _ = conn.execute(
        "ALTER TABLE artists ADD COLUMN template_verified INTEGER NOT NULL DEFAULT 0",
        [],
    );
    let _ = conn.execute("ALTER TABLE periods ADD COLUMN preview_image TEXT", []);
    let _ = conn.execute("ALTER TABLE periods ADD COLUMN official_total INTEGER", []);
    let _ = conn.execute("ALTER TABLE periods ADD COLUMN skipped INTEGER NOT NULL DEFAULT 0", []);
    let _ = conn.execute("ALTER TABLE periods ADD COLUMN verified INTEGER NOT NULL DEFAULT 0", []);
    let _ = conn.execute("ALTER TABLE periods ADD COLUMN open_as_cards INTEGER NOT NULL DEFAULT 0", []);
    let _ = conn.execute("ALTER TABLE artists ADD COLUMN updated_at TEXT", []);
    let _ = conn.execute("ALTER TABLE images ADD COLUMN phash INTEGER", []);
    let _ = conn.execute("ALTER TABLE rewards ADD COLUMN is_root INTEGER NOT NULL DEFAULT 0", []);
    let _ = conn.execute("ALTER TABLE rewards ADD COLUMN is_extra INTEGER NOT NULL DEFAULT 0", []);
    let _ = conn.execute(
        "ALTER TABLE artists ADD COLUMN wallpaper_fav INTEGER NOT NULL DEFAULT 0",
        [],
    );
    // MiSD: sd_volume = disk label, sd_origin = the old folder for "bring back".
    // sd_marked is the queue: 0 = none, 1 = move, 2 = backup.
    // Old queries use sd_marked = 1, so they ignore 2 (safe for older builds).
    let _ = conn.execute("ALTER TABLE rewards ADD COLUMN sd_marked INTEGER NOT NULL DEFAULT 0", []);
    let _ = conn.execute("ALTER TABLE rewards ADD COLUMN sd_volume TEXT", []);
    let _ = conn.execute("ALTER TABLE rewards ADD COLUMN sd_origin TEXT", []);
    // MiSD backup: sd_backup = disk label, sd_backup_path = where the copy is
    // (saved, because the local folder can move later), sd_backup_at = date.
    let _ = conn.execute("ALTER TABLE rewards ADD COLUMN sd_backup TEXT", []);
    let _ = conn.execute("ALTER TABLE rewards ADD COLUMN sd_backup_path TEXT", []);
    let _ = conn.execute("ALTER TABLE rewards ADD COLUMN sd_backup_at TEXT", []);
    // "new" badge, default 0 so an existing library doesn't light up everything
    let _ = conn.execute("ALTER TABLE rewards ADD COLUMN fresh INTEGER NOT NULL DEFAULT 0", []);
    let _ = conn.execute("ALTER TABLE rewards ADD COLUMN wished INTEGER NOT NULL DEFAULT 0", []);
    let _ = conn.execute("ALTER TABLE artists ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0", []);
    let _ = conn.execute("ALTER TABLE artists ADD COLUMN graveyard INTEGER NOT NULL DEFAULT 0", []);
    // bundled = the reward keeps its gallery subfolders folded in (rescans must not split
    // it)
    let _ = conn.execute("ALTER TABLE rewards ADD COLUMN bundled INTEGER NOT NULL DEFAULT 0", []);
    // the indexer sets cover_image by itself, this flag marks a real "set as cover"
    let _ = conn.execute(
        "ALTER TABLE rewards ADD COLUMN cover_custom INTEGER NOT NULL DEFAULT 0",
        [],
    );
    // release styles replace the old no_dates flags: monthly, numbered, none.
    // no_dates is kept in sync (= style "none") for older code and rollbacks
    let _ = conn.execute("ALTER TABLE artists ADD COLUMN release_style TEXT", []);
    let _ = conn.execute("ALTER TABLE platform_no_dates ADD COLUMN release_style TEXT", []);
    let _ = conn.execute("ALTER TABLE periods ADD COLUMN number INTEGER", []);
    conn.execute(
        "UPDATE artists SET release_style = CASE WHEN no_dates = 1 THEN 'none' ELSE 'monthly' END
         WHERE release_style IS NULL",
        [],
    )?;
    conn.execute(
        "UPDATE platform_no_dates SET release_style = CASE WHEN no_dates = 1 THEN 'none' ELSE 'monthly' END
         WHERE release_style IS NULL",
        [],
    )?;
    Ok(())
}

/// Update an artist's "last edited" time.
#[allow(dead_code)]
pub fn touch_artist(conn: &Connection, id: i64) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE artists SET updated_at = datetime('now') WHERE id = ?1",
        params![id],
    )?;
    Ok(())
}

/// Same, by name.
pub fn touch_artist_by_name(conn: &Connection, name: &str) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE artists SET updated_at = datetime('now') WHERE name = ?1",
        params![name],
    )?;
    Ok(())
}

/// Marker file in a skipped month folder.
pub const SKIP_MARKER: &str = "_SKIPPED.txt";

/* ---- settings -------------------------------------------------------- */

pub fn get_setting(conn: &Connection, key: &str) -> rusqlite::Result<Option<String>> {
    conn.query_row("SELECT value FROM settings WHERE key = ?1", params![key], |r| {
        r.get::<_, String>(0)
    })
    .optional()
}

pub fn set_setting(conn: &Connection, key: &str, value: &str) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO settings(key, value) VALUES(?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )?;
    Ok(())
}

/* ---- roots ----------------------------------------------------------- */

pub fn list_roots(conn: &Connection) -> rusqlite::Result<Vec<Root>> {
    let mut stmt =
        conn.prepare("SELECT id, path, label, default_platform FROM roots ORDER BY id")?;
    let rows = stmt
        .query_map([], |r| {
            Ok(Root {
                id: r.get(0)?,
                path: r.get(1)?,
                label: r.get(2)?,
                default_platform: r.get(3)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

pub fn add_root(
    conn: &Connection,
    path: &str,
    label: Option<&str>,
    default_platform: Option<&str>,
) -> rusqlite::Result<i64> {
    conn.execute(
        "INSERT INTO roots(path, label, default_platform) VALUES(?1, ?2, ?3)
         ON CONFLICT(path) DO UPDATE SET label = excluded.label,
                                         default_platform = excluded.default_platform",
        params![path, label, default_platform],
    )?;
    let id = conn.query_row("SELECT id FROM roots WHERE path = ?1", params![path], |r| {
        r.get(0)
    })?;
    Ok(id)
}

/// Is there an indexed reward in dir or below it?
/// Checked before deleting an import staging folder (unmanaged imports can
/// leave their rewards inside it).
pub fn any_reward_under(conn: &Connection, dir: &str) -> rusqlite::Result<bool> {
    let mut stmt = conn
        .prepare("SELECT folder_path FROM rewards WHERE substr(folder_path, 1, length(?1)) = ?1")?;
    let rows = stmt.query_map(params![dir], |r| r.get::<_, String>(0))?;
    for f in rows {
        // checks the separator ("...-1" doesn't match "...-12")
        match f?.strip_prefix(dir) {
            Some("") => return Ok(true),
            Some(rest) if rest.starts_with('\\') || rest.starts_with('/') => return Ok(true),
            _ => {}
        }
    }
    Ok(false)
}

pub fn remove_root(conn: &Connection, id: i64) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM roots WHERE id = ?1", params![id])?;
    Ok(())
}

/// Remove all source roots (managed mode, content is in the collection now).
pub fn clear_roots(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM roots", [])?;
    Ok(())
}

/* ---- reward status --------------------------------------------------- */

pub fn set_reward_status(conn: &Connection, reward_id: i64, status: &str) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE rewards SET status = ?2 WHERE id = ?1",
        params![reward_id, status],
    )?;
    Ok(())
}

pub fn set_period_platform(conn: &Connection, period_id: i64, platform: &str) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE periods SET platform = ?2, needs_review = 0 WHERE id = ?1",
        params![period_id, platform],
    )?;
    Ok(())
}

pub fn set_artist_preview(conn: &Connection, artist_id: i64, image: &str) -> rusqlite::Result<()> {
    // "" clears the override (back to the first reward cover)
    let val: Option<&str> = if image.is_empty() { None } else { Some(image) };
    conn.execute(
        "UPDATE artists SET preview_image = ?2 WHERE id = ?1",
        params![artist_id, val],
    )?;
    Ok(())
}

/// Set (or clear with "") a reward's cover.
pub fn set_reward_cover(conn: &Connection, reward_id: i64, image: &str) -> rusqlite::Result<()> {
    let val: Option<&str> = if image.is_empty() { None } else { Some(image) };
    // remember it was chosen, so "Reset cover" only shows when there's something to reset
    conn.execute(
        "UPDATE rewards SET cover_image = ?2, cover_custom = ?3 WHERE id = ?1",
        params![reward_id, val, val.is_some() as i64],
    )?;
    Ok(())
}

/// Set (or clear with "") a month preview.
pub fn set_period_preview(conn: &Connection, period_id: i64, image: &str) -> rusqlite::Result<()> {
    let val: Option<&str> = if image.is_empty() { None } else { Some(image) };
    conn.execute(
        "UPDATE periods SET preview_image = ?2 WHERE id = ?1",
        params![period_id, val],
    )?;
    Ok(())
}

/// The release styles a creator/platform can use.
pub const RELEASE_STYLES: [&str; 3] = ["monthly", "numbered", "none"];

fn valid_style(style: &str) -> rusqlite::Result<()> {
    if RELEASE_STYLES.contains(&style) {
        Ok(())
    } else {
        Err(rusqlite::Error::InvalidParameterName(format!(
            "unknown release style '{style}'"
        )))
    }
}

/// Set an artist's release style (by name), keeps no_dates in sync.
pub fn set_artist_release_style(
    conn: &Connection,
    name: &str,
    style: &str,
) -> rusqlite::Result<()> {
    valid_style(style)?;
    conn.execute(
        "UPDATE artists SET release_style = ?2, no_dates = (?2 = 'none') WHERE name = ?1",
        params![name, style],
    )?;
    Ok(())
}

/// Same by id.
pub fn set_artist_release_style_by_id(
    conn: &Connection,
    id: i64,
    style: &str,
) -> rusqlite::Result<()> {
    valid_style(style)?;
    conn.execute(
        "UPDATE artists SET release_style = ?2, no_dates = (?2 = 'none') WHERE id = ?1",
        params![id, style],
    )?;
    Ok(())
}

/// Set a release style override for one platform (keeps no_dates in sync).
pub fn set_platform_release_style(
    conn: &Connection,
    artist_id: i64,
    platform: &str,
    style: &str,
) -> rusqlite::Result<()> {
    valid_style(style)?;
    conn.execute(
        "INSERT INTO platform_no_dates(artist_id, platform, no_dates, release_style)
         VALUES(?1, ?2, (?3 = 'none'), ?3)
         ON CONFLICT(artist_id, platform)
         DO UPDATE SET no_dates = excluded.no_dates, release_style = excluded.release_style",
        params![artist_id, platform, style],
    )?;
    Ok(())
}

/// Old API: set "no dates" for an artist (by name), uses the style setter.
#[allow(dead_code)]
pub fn set_artist_no_dates(conn: &Connection, name: &str, no_dates: bool) -> rusqlite::Result<()> {
    set_artist_release_style(conn, name, if no_dates { "none" } else { "monthly" })
}

/// Old API: same by id.
pub fn set_artist_no_dates_by_id(conn: &Connection, id: i64, no_dates: bool) -> rusqlite::Result<()> {
    set_artist_release_style_by_id(conn, id, if no_dates { "none" } else { "monthly" })
}

/// Old API: "no dates" override for one platform.
pub fn set_platform_no_dates(
    conn: &Connection,
    artist_id: i64,
    platform: &str,
    no_dates: bool,
) -> rusqlite::Result<()> {
    set_platform_release_style(conn, artist_id, platform, if no_dates { "none" } else { "monthly" })
}

/// Set or clear an artist's class.
pub fn set_artist_tag(conn: &Connection, id: i64, tag: Option<&str>) -> rusqlite::Result<()> {
    conn.execute("UPDATE artists SET tag = ?2 WHERE id = ?1", params![id, tag])?;
    Ok(())
}

/// Set an artist's tags (JSON array).
pub fn set_artist_tags(conn: &Connection, id: i64, tags: &str) -> rusqlite::Result<()> {
    conn.execute("UPDATE artists SET tags = ?2 WHERE id = ?1", params![id, tags])?;
    Ok(())
}

/// Set an artist's aliases (JSON array), search finds them too.
pub fn set_artist_aliases(conn: &Connection, id: i64, aliases: &str) -> rusqlite::Result<()> {
    conn.execute("UPDATE artists SET aliases = ?2 WHERE id = ?1", params![id, aliases])?;
    Ok(())
}

/// Rename an artist. name is UNIQUE, the caller checks artist_name_taken first.
pub fn rename_artist(conn: &Connection, id: i64, new_name: &str) -> rusqlite::Result<()> {
    conn.execute("UPDATE artists SET name = ?2 WHERE id = ?1", params![id, new_name])?;
    Ok(())
}

/// Is name already used by another artist? (case-insensitive)
pub fn artist_name_taken(conn: &Connection, name: &str, except_id: i64) -> rusqlite::Result<bool> {
    conn.query_row(
        "SELECT COUNT(*) FROM artists WHERE id <> ?1 AND lower(name) = lower(?2)",
        params![except_id, name],
        |r| r.get::<_, i64>(0),
    )
    .map(|n| n > 0)
}

/// Set an artist's notes (None clears).
pub fn set_artist_notes(conn: &Connection, id: i64, notes: Option<&str>) -> rusqlite::Result<()> {
    conn.execute("UPDATE artists SET notes = ?2 WHERE id = ?1", params![id, notes])?;
    Ok(())
}

/// Set an artist's links (JSON array).
pub fn set_artist_links(conn: &Connection, id: i64, links: &str) -> rusqlite::Result<()> {
    conn.execute("UPDATE artists SET links = ?2 WHERE id = ?1", params![id, links])?;
    Ok(())
}

/// Set or clear an artist's creator type.
pub fn set_artist_kind(conn: &Connection, id: i64, kind: Option<&str>) -> rusqlite::Result<()> {
    conn.execute("UPDATE artists SET kind = ?2 WHERE id = ?1", params![id, kind])?;
    Ok(())
}

/// Turn "Wallpaper favourites" on/off for an artist.
pub fn set_artist_wallpaper_fav(conn: &Connection, id: i64, on: bool) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE artists SET wallpaper_fav = ?2 WHERE id = ?1",
        params![id, on as i64],
    )?;
    Ok(())
}

/// Mark/unmark one image (by path) as favourite wallpaper.
pub fn set_image_wallpaper_fav(conn: &Connection, path: &str, on: bool) -> rusqlite::Result<()> {
    if on {
        conn.execute(
            "INSERT INTO wallpaper_favs(file_path) VALUES(?1) ON CONFLICT(file_path) DO NOTHING",
            params![path],
        )?;
    } else {
        conn.execute("DELETE FROM wallpaper_favs WHERE file_path = ?1", params![path])?;
    }
    Ok(())
}

/* ---- User-made collections ------------------------------------------------ */

/// All collections in the user's order (then by name).
pub fn list_collections(conn: &Connection) -> rusqlite::Result<Vec<CollectionRow>> {
    let mut stmt =
        conn.prepare("SELECT id, name FROM collections ORDER BY sort, name COLLATE NOCASE")?;
    let rows = stmt.query_map([], |r| {
        Ok(CollectionRow { id: r.get(0)?, name: r.get(1)? })
    })?;
    rows.collect()
}

/// Create a collection and return its id (added at the end).
pub fn create_collection(conn: &Connection, name: &str) -> rusqlite::Result<i64> {
    let next: i64 = conn
        .query_row("SELECT COALESCE(MAX(sort), -1) + 1 FROM collections", [], |r| r.get(0))
        .unwrap_or(0);
    conn.execute(
        "INSERT INTO collections(name, sort) VALUES(?1, ?2)",
        params![name, next],
    )?;
    Ok(conn.last_insert_rowid())
}

pub fn rename_collection(conn: &Connection, id: i64, name: &str) -> rusqlite::Result<()> {
    conn.execute("UPDATE collections SET name = ?2 WHERE id = ?1", params![id, name])?;
    Ok(())
}

/// Delete a collection. Only the grouping, no file is touched.
pub fn delete_collection(conn: &Connection, id: i64) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM collection_items WHERE collection_id = ?1", params![id])?;
    conn.execute("DELETE FROM collections WHERE id = ?1", params![id])?;
    Ok(())
}

/// Add/remove one file (by path) to/from a collection.
pub fn set_image_collection(
    conn: &Connection,
    collection_id: i64,
    path: &str,
    on: bool,
) -> rusqlite::Result<()> {
    if on {
        conn.execute(
            "INSERT INTO collection_items(collection_id, file_path) VALUES(?1, ?2) \
             ON CONFLICT(collection_id, file_path) DO NOTHING",
            params![collection_id, path],
        )?;
    } else {
        conn.execute(
            "DELETE FROM collection_items WHERE collection_id = ?1 AND file_path = ?2",
            params![collection_id, path],
        )?;
    }
    Ok(())
}

/// Add/remove one file (by path) to/from Favourites.
pub fn set_image_favorite(conn: &Connection, path: &str, on: bool) -> rusqlite::Result<()> {
    if on {
        conn.execute(
            "INSERT INTO favorites(file_path) VALUES(?1) ON CONFLICT(file_path) DO NOTHING",
            params![path],
        )?;
    } else {
        conn.execute("DELETE FROM favorites WHERE file_path = ?1", params![path])?;
    }
    Ok(())
}

/// Mark an artist as manual (kept even without rewards).
pub fn set_artist_manual(conn: &Connection, id: i64, manual: bool) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE artists SET manual = ?2 WHERE id = ?1",
        params![id, manual as i64],
    )?;
    Ok(())
}

/// Hide or unhide a creator. Nothing else changes.
/// Saved on the artist row, not as a preference.
pub fn set_artist_hidden(conn: &Connection, id: i64, hidden: bool) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE artists SET hidden = ?2 WHERE id = ?1",
        params![id, hidden as i64],
    )?;
    Ok(())
}

/// Move a creator into the graveyard or back. Only a flag.
pub fn set_artist_graveyard(conn: &Connection, id: i64, on: bool) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE artists SET graveyard = ?2 WHERE id = ?1",
        params![id, on as i64],
    )?;
    Ok(())
}

/// Get an artist's name + no_dates.
pub fn artist_info(conn: &Connection, id: i64) -> rusqlite::Result<Option<(String, bool)>> {
    conn.query_row(
        "SELECT name, no_dates FROM artists WHERE id = ?1",
        params![id],
        |r| Ok((r.get(0)?, r.get::<_, i64>(1)? != 0)),
    )
    .optional()
}

/// All reward folders of an artist (for trashing on delete).
pub fn artist_reward_folders(conn: &Connection, id: i64) -> rusqlite::Result<Vec<String>> {
    let mut stmt = conn.prepare(
        "SELECT r.folder_path FROM rewards r
         JOIN periods p ON r.period_id = p.id
         WHERE p.artist_id = ?1",
    )?;
    let rows = stmt
        .query_map(params![id], |r| r.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

/// Delete an artist (cascades periods -> rewards -> images).
pub fn delete_artist(conn: &Connection, id: i64) -> rusqlite::Result<()> {
    let paths = image_paths_for_artist(conn, id)?;
    delete_versions_for_orig_paths(conn, &paths)?;
    conn.execute("DELETE FROM artists WHERE id = ?1", params![id])?;
    Ok(())
}

/// Delete one platform of an artist. "Unsorted" = the NULL platform.
pub fn delete_artist_platform(conn: &Connection, artist_id: i64, platform: &str) -> rusqlite::Result<()> {
    conn.execute(
        "DELETE FROM periods
         WHERE artist_id = ?1 AND (platform = ?2 OR (?2 = 'Unsorted' AND platform IS NULL))",
        params![artist_id, platform],
    )?;
    Ok(())
}

/// Save (or clear) the applied template on an artist.
pub fn set_artist_template(
    conn: &Connection,
    id: i64,
    source: Option<&str>,
    meta: Option<&str>,
    verified: bool,
) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE artists SET template_source = ?2, template_meta = ?3, template_verified = ?4 WHERE id = ?1",
        params![id, source, meta, verified as i64],
    )?;
    Ok(())
}

/// Get an artist's links JSON.
pub fn artist_links(conn: &Connection, id: i64) -> rusqlite::Result<Option<String>> {
    conn.query_row("SELECT links FROM artists WHERE id = ?1", params![id], |r| {
        r.get::<_, Option<String>>(0)
    })
    .optional()
    .map(Option::flatten)
}

/// Set the official reward count of a period (from a template).
pub fn set_period_official_total(
    conn: &Connection,
    period_id: i64,
    total: i64,
) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE periods SET official_total = ?2 WHERE id = ?1",
        params![period_id, total],
    )?;
    Ok(())
}

/// Clear a period's template count.
pub fn clear_period_official_total(conn: &Connection, period_id: i64) -> rusqlite::Result<()> {
    conn.execute("UPDATE periods SET official_total = NULL WHERE id = ?1", params![period_id])?;
    Ok(())
}

/// Period id by its key (folder_path), None if it doesn't exist.
pub fn period_id_by_key(conn: &Connection, key: &str) -> rusqlite::Result<Option<i64>> {
    conn.query_row("SELECT id FROM periods WHERE folder_path = ?1", params![key], |r| r.get(0))
        .optional()
}

/// Delete the template "missing" placeholders in a period (owned rewards stay).
pub fn delete_missing_rewards(conn: &Connection, period_id: i64) -> rusqlite::Result<u32> {
    let n = conn.execute(
        "DELETE FROM rewards WHERE period_id = ?1 AND status = 'missing'",
        params![period_id],
    )?;
    Ok(n as u32)
}

/// Artist id by exact name.
pub fn artist_id_by_name(conn: &Connection, name: &str) -> rusqlite::Result<Option<i64>> {
    conn.query_row("SELECT id FROM artists WHERE name = ?1", params![name], |r| r.get(0))
        .optional()
}

/// Set how many months a period covers.
pub fn set_period_span(conn: &Connection, period_id: i64, span: i64) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE periods SET span = ?2 WHERE id = ?1",
        params![period_id, span.max(1)],
    )?;
    Ok(())
}

/// Mark/unmark a period as a break.
pub fn set_period_skipped(conn: &Connection, period_id: i64, skipped: bool) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE periods SET skipped = ?2 WHERE id = ?1",
        params![period_id, skipped as i64],
    )?;
    Ok(())
}

/// Set if clicking the month opens the reward overview (set at import).
pub fn set_period_open_as_cards(
    conn: &Connection,
    period_id: i64,
    open_as_cards: bool,
) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE periods SET open_as_cards = ?2 WHERE id = ?1",
        params![period_id, open_as_cards as i64],
    )?;
    Ok(())
}

/// (artist, platform, year, month, number) of a period, to rebuild its folder.
pub fn period_scope(
    conn: &Connection,
    period_id: i64,
) -> rusqlite::Result<Option<(String, Option<String>, Option<i64>, Option<i64>, Option<i64>)>> {
    conn.query_row(
        "SELECT a.name, p.platform, p.year, p.month, p.number
         FROM periods p JOIN artists a ON a.id = p.artist_id
         WHERE p.id = ?1",
        params![period_id],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
    )
    .optional()
}

pub fn artist_reward_ids(conn: &Connection, artist_id: i64) -> rusqlite::Result<Vec<i64>> {
    let mut stmt = conn.prepare(
        "SELECT r.id FROM rewards r JOIN periods p ON p.id = r.period_id WHERE p.artist_id = ?1",
    )?;
    let rows = stmt
        .query_map(params![artist_id], |r| r.get::<_, i64>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

pub fn period_reward_ids(conn: &Connection, period_id: i64) -> rusqlite::Result<Vec<i64>> {
    let mut stmt = conn.prepare("SELECT id FROM rewards WHERE period_id = ?1")?;
    let rows = stmt
        .query_map(params![period_id], |r| r.get::<_, i64>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

/// The rewards of one platform of a creator, the same rows delete_artist_platform
/// removes ("Unsorted" = no platform).
pub fn platform_reward_ids(conn: &Connection, artist_id: i64, platform: &str) -> rusqlite::Result<Vec<i64>> {
    let mut stmt = conn.prepare(
        "SELECT r.id FROM rewards r JOIN periods p ON p.id = r.period_id
         WHERE p.artist_id = ?1 AND (p.platform = ?2 OR (?2 = 'Unsorted' AND p.platform IS NULL))",
    )?;
    let rows = stmt
        .query_map(params![artist_id, platform], |r| r.get::<_, i64>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

/// Reward folders of a period (to find its real month folder).
pub fn period_reward_folders(conn: &Connection, period_id: i64) -> rusqlite::Result<Vec<String>> {
    let mut stmt = conn.prepare("SELECT folder_path FROM rewards WHERE period_id = ?1")?;
    let rows = stmt
        .query_map(params![period_id], |r| r.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

/// Reward folders that keep their subfolders folded in.
pub fn bundled_reward_folders(conn: &Connection) -> rusqlite::Result<Vec<String>> {
    let mut stmt = conn.prepare("SELECT folder_path FROM rewards WHERE bundled = 1")?;
    let rows = stmt
        .query_map([], |r| r.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

/// All reward folder paths.
pub fn all_reward_folders(conn: &Connection) -> rusqlite::Result<Vec<String>> {
    let mut stmt = conn.prepare("SELECT folder_path FROM rewards")?;
    let rows = stmt
        .query_map([], |r| r.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

/// A reward's saved title by folder (a rescan keeps the user's name).
pub fn reward_title(conn: &Connection, folder: &str) -> rusqlite::Result<Option<String>> {
    conn.query_row(
        "SELECT title FROM rewards WHERE folder_path = ?1",
        params![folder],
        |r| r.get::<_, String>(0),
    )
    .optional()
}

/// Mark a reward as bundled.
pub fn set_reward_bundled(conn: &Connection, folder: &str, on: bool) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE rewards SET bundled = ?2 WHERE folder_path = ?1",
        params![folder, on as i64],
    )?;
    Ok(())
}

/// Find or create a break period (same key as the indexer).
pub fn upsert_skipped_period(
    conn: &Connection,
    artist_id: i64,
    platform: Option<&str>,
    year: Option<i64>,
    month: Option<i64>,
    label: &str,
    folder_key: &str,
) -> rusqlite::Result<i64> {
    conn.execute(
        "INSERT INTO periods(artist_id, platform, year, month, span, label, folder_path, needs_review, skipped, official_total)
         VALUES(?1, ?2, ?3, ?4, 1, ?5, ?6, 0, 1, 0)
         ON CONFLICT(folder_path) DO UPDATE SET skipped = 1, official_total = 0",
        params![artist_id, platform, year, month, label, folder_key],
    )?;
    conn.query_row(
        "SELECT id FROM periods WHERE folder_path = ?1",
        params![folder_key],
        |r| r.get(0),
    )
}

/* ---- per-period verification (driven by applied templates) ----------- */

/// Clear verified on one period.
pub fn clear_period_verified(conn: &Connection, period_id: i64) -> rusqlite::Result<()> {
    conn.execute("UPDATE periods SET verified = 0 WHERE id = ?1", params![period_id])?;
    Ok(())
}

/// Clear verified on all periods of an artist (before recomputing).
pub fn clear_artist_verified(conn: &Connection, artist_id: i64) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE periods SET verified = 0 WHERE artist_id = ?1",
        params![artist_id],
    )?;
    Ok(())
}

/// Mark the matching period verified. platform NULL = no platform, month NULL = whole year.
pub fn set_period_verified_scope(
    conn: &Connection,
    artist_id: i64,
    platform: Option<&str>,
    year: Option<i64>,
    month: Option<i64>,
) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE periods SET verified = 1
         WHERE artist_id = ?1
           AND (platform = ?2 OR (?2 IS NULL AND platform IS NULL))
           AND (year  = ?3 OR (?3 IS NULL AND year  IS NULL))
           AND (month = ?4 OR (?4 IS NULL AND month IS NULL))",
        params![artist_id, platform, year, month],
    )?;
    Ok(())
}

/* ---- applied templates (multi-template per artist + overlap) ---------- */

/// One applied template (name, verified, coverage JSON).
#[allow(dead_code)]
pub struct AppliedTemplate {
    pub name: String,
    pub verified: bool,
    pub coverage: String,
    pub raw: Option<String>,
}

/// All templates applied to an artist.
pub fn applied_templates(conn: &Connection, artist_id: i64) -> rusqlite::Result<Vec<AppliedTemplate>> {
    let mut stmt = conn.prepare(
        "SELECT name, verified, coverage, raw FROM applied_templates WHERE artist_id = ?1 ORDER BY applied_at",
    )?;
    let rows = stmt
        .query_map(params![artist_id], |r| {
            Ok(AppliedTemplate {
                name: r.get(0)?,
                verified: r.get::<_, i64>(1)? != 0,
                coverage: r.get(2)?,
                raw: r.get(3)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

/// Save (or replace by name) an applied template.
pub fn upsert_applied_template(
    conn: &Connection,
    artist_id: i64,
    name: &str,
    verified: bool,
    coverage: &str,
    raw: Option<&str>,
) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO applied_templates(artist_id, name, verified, coverage, raw)
         VALUES(?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(artist_id, name) DO UPDATE SET
            verified = excluded.verified,
            coverage = excluded.coverage,
            raw      = excluded.raw,
            applied_at = datetime('now')",
        params![artist_id, name, verified as i64, coverage, raw],
    )?;
    Ok(())
}

/// Remove one applied template.
#[allow(dead_code)]
pub fn remove_applied_template(conn: &Connection, artist_id: i64, name: &str) -> rusqlite::Result<()> {
    conn.execute(
        "DELETE FROM applied_templates WHERE artist_id = ?1 AND name = ?2",
        params![artist_id, name],
    )?;
    Ok(())
}

/// Rewards of a period as (id, title, status, image_count), to match template rewards.
pub fn period_rewards(
    conn: &Connection,
    period_id: i64,
) -> rusqlite::Result<Vec<(i64, String, String, i64)>> {
    let mut stmt = conn.prepare(
        "SELECT id, title, status, image_count FROM rewards WHERE period_id = ?1",
    )?;
    let rows = stmt
        .query_map(params![period_id], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

/// Insert a "missing" placeholder from a template.
pub fn insert_missing_reward(
    conn: &Connection,
    period_id: i64,
    title: &str,
    category: Option<&str>,
    folder_path: &str,
) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO rewards(period_id, title, category, folder_path, status, image_count)
         VALUES(?1, ?2, ?3, ?4, 'missing', 0)
         ON CONFLICT(folder_path) DO NOTHING",
        params![period_id, title, category, folder_path],
    )?;
    Ok(())
}

/// All platform names the library uses (the scanner learns them).
pub fn known_platforms(conn: &Connection) -> rusqlite::Result<Vec<String>> {
    let mut stmt = conn.prepare(
        "SELECT DISTINCT platform FROM periods
          WHERE platform IS NOT NULL AND trim(platform) <> ''",
    )?;
    let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
    rows.collect()
}

/// Mark these folders as new, even if the rows already existed
/// (a drag and drop import is "new" even for known folders).
pub fn mark_rewards_fresh(conn: &Connection, folder_paths: &[String]) -> rusqlite::Result<usize> {
    let mut n = 0;
    for path in folder_paths {
        n += conn.execute(
            "UPDATE rewards SET fresh = 1 WHERE folder_path = ?1",
            params![path],
        )?;
    }
    Ok(n)
}

/// Remove the "new" badge (when the viewer opens it).
pub fn mark_reward_seen(conn: &Connection, reward_id: i64) -> rusqlite::Result<()> {
    conn.execute("UPDATE rewards SET fresh = 0 WHERE id = ?1", params![reward_id])?;
    Ok(())
}

/// Put a reward on the wishlist (1 = the wish made this row, 2 = it already existed)
/// or take it off (0).
///
/// Mark rewards as extras (or not). Returns how many changed.
pub fn set_rewards_extra(conn: &Connection, ids: &[i64], extra: bool) -> rusqlite::Result<u32> {
    let mut n = 0u32;
    for id in ids {
        n += conn.execute(
            "UPDATE rewards SET is_extra = ?2 WHERE id = ?1",
            params![id, if extra { 1 } else { 0 }],
        )? as u32;
    }
    Ok(n)
}

pub fn set_reward_wished(conn: &Connection, reward_id: i64, wished: i64) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE rewards SET wished = ?2 WHERE id = ?1",
        params![reward_id, wished],
    )?;
    Ok(())
}

/// Clear it on all rewards at once.
pub fn mark_all_rewards_seen(conn: &Connection) -> rusqlite::Result<usize> {
    conn.execute("UPDATE rewards SET fresh = 0 WHERE fresh <> 0", [])
}

/// Create or update a user-made artist (manual = 1 keeps it without rewards).
pub fn create_artist(
    conn: &Connection,
    name: &str,
    preview: Option<&str>,
    no_dates: bool,
) -> rusqlite::Result<i64> {
    conn.execute(
        "INSERT INTO artists(name, preview_image, manual, no_dates) VALUES(?1, ?2, 1, ?3)
         ON CONFLICT(name) DO UPDATE SET
            manual        = 1,
            no_dates      = excluded.no_dates,
            preview_image = COALESCE(excluded.preview_image, artists.preview_image)",
        params![name, preview, no_dates as i64],
    )?;
    conn.query_row("SELECT id FROM artists WHERE name = ?1", params![name], |r| r.get(0))
}

/// Get a reward's (title, folder_path, period_id).
pub fn reward_scope(conn: &Connection, id: i64) -> rusqlite::Result<Option<(String, String, i64)>> {
    conn.query_row(
        "SELECT title, folder_path, period_id FROM rewards WHERE id = ?1",
        params![id],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    )
    .optional()
}

/// Attach imported files to a reward: set its folder, mark it owned and replace
/// its images. Frees the folder_path from other rows first (UNIQUE).
pub fn set_reward_content(
    conn: &Connection,
    reward_id: i64,
    folder_path: &str,
    cover: Option<&str>,
    images: &[(String, String)],
) -> rusqlite::Result<()> {
    conn.execute(
        "DELETE FROM rewards WHERE folder_path = ?1 AND id <> ?2",
        params![folder_path, reward_id],
    )?;
    conn.execute(
        "UPDATE rewards
            SET folder_path = ?2,
                status      = 'owned',
                image_count = ?3,
                cover_image = COALESCE(cover_image, ?4)
          WHERE id = ?1",
        params![reward_id, folder_path, images.len() as i64, cover],
    )?;
    conn.execute("DELETE FROM images WHERE reward_id = ?1", params![reward_id])?;
    let mut stmt = conn.prepare(
        "INSERT INTO images(reward_id, file_path, rel_name, sort) VALUES(?1, ?2, ?3, ?4)",
    )?;
    for (i, (abs, rel)) in images.iter().enumerate() {
        stmt.execute(params![reward_id, abs, rel, i as i64])?;
    }
    Ok(())
}

/// Create an empty reward row for a new folder ("New folder"). Idempotent.
pub fn insert_empty_reward(
    conn: &Connection,
    period_id: i64,
    title: &str,
    folder: &str,
) -> rusqlite::Result<i64> {
    conn.execute(
        // sd_marked only on INSERT, a year rule is only for new rewards (see
        // sd::rule_mode_sql)
        &format!(
            "INSERT INTO rewards(period_id, title, category, folder_path, cover_image, image_count, status, sd_marked)
             VALUES(?1, ?2, NULL, ?3, NULL, 0, 'owned', {})
             ON CONFLICT(folder_path) DO UPDATE SET period_id = excluded.period_id, title = excluded.title",
            crate::sd::rule_mode_sql("?1")
        ),
        params![period_id, title, folder],
    )?;
    conn.query_row(
        "SELECT id FROM rewards WHERE folder_path = ?1",
        params![folder],
        |r| r.get(0),
    )
}

/// Move a reward to another period + folder and update its image paths and cover.
/// The folder was already moved on disk.
pub fn move_reward(
    conn: &Connection,
    id: i64,
    dest_period_id: i64,
    old_folder: &str,
    new_folder: &str,
) -> rusqlite::Result<()> {
    // free the target path from an old row (UNIQUE)
    conn.execute(
        "DELETE FROM rewards WHERE folder_path = ?1 AND id <> ?2",
        params![new_folder, id],
    )?;
    let mut rows: Vec<(i64, String)> = Vec::new();
    {
        let mut stmt = conn.prepare("SELECT id, file_path FROM images WHERE reward_id = ?1")?;
        let it = stmt.query_map(params![id], |r| Ok((r.get(0)?, r.get(1)?)))?;
        for x in it {
            rows.push(x?);
        }
    }
    for (img_id, fp) in rows {
        if let Some(rest) = fp.strip_prefix(old_folder) {
            let new_fp = format!("{}{}", new_folder, rest);
            conn.execute("UPDATE images SET file_path = ?2 WHERE id = ?1", params![img_id, new_fp])?;
        }
    }
    let cover: Option<String> = conn
        .query_row("SELECT cover_image FROM rewards WHERE id = ?1", params![id], |r| {
            r.get::<_, Option<String>>(0)
        })
        .optional()?
        .flatten();
    let new_cover = cover.map(|c| match c.strip_prefix(old_folder) {
        Some(rest) => format!("{}{}", new_folder, rest),
        None => c,
    });
    conn.execute(
        "UPDATE rewards SET period_id = ?2, folder_path = ?3, cover_image = ?4 WHERE id = ?1",
        params![id, dest_period_id, new_folder, new_cover],
    )?;
    // update previews/covers that pointed into the old folder
    remap_preview_prefix(conn, old_folder, new_folder)?;
    // keep favourites (by path) pointing at the moved files
    conn.execute(
        "UPDATE OR REPLACE wallpaper_favs SET file_path = ?2 || substr(file_path, length(?1)+1) WHERE substr(file_path,1,length(?1)) = ?1",
        params![old_folder, new_folder],
    )?;
    conn.execute(
        "UPDATE OR REPLACE favorites SET file_path = ?2 || substr(file_path, length(?1)+1) WHERE substr(file_path,1,length(?1)) = ?1",
        params![old_folder, new_folder],
    )?;
    conn.execute(
        "UPDATE OR REPLACE collection_items SET file_path = ?2 || substr(file_path, length(?1)+1) WHERE substr(file_path,1,length(?1)) = ?1",
        params![old_folder, new_folder],
    )?;
    // keep edit versions attached
    remap_versions_prefix(conn, old_folder, new_folder)?;
    Ok(())
}

/// After a folder move: update previews/covers under old_folder to new_folder.
pub fn remap_preview_prefix(conn: &Connection, old_folder: &str, new_folder: &str) -> rusqlite::Result<()> {
    for sql in [
        "UPDATE artists SET preview_image = ?2 || substr(preview_image, length(?1)+1) WHERE substr(preview_image,1,length(?1)) = ?1",
        "UPDATE periods SET preview_image = ?2 || substr(preview_image, length(?1)+1) WHERE substr(preview_image,1,length(?1)) = ?1",
        "UPDATE rewards SET cover_image = ?2 || substr(cover_image, length(?1)+1) WHERE substr(cover_image,1,length(?1)) = ?1",
    ] {
        conn.execute(sql, params![old_folder, new_folder])?;
    }
    Ok(())
}

/// Same for one moved file.
pub fn remap_preview_exact(conn: &Connection, old_path: &str, new_path: &str) -> rusqlite::Result<()> {
    for sql in [
        "UPDATE artists SET preview_image = ?2 WHERE preview_image = ?1",
        "UPDATE periods SET preview_image = ?2 WHERE preview_image = ?1",
        "UPDATE rewards SET cover_image = ?2 WHERE cover_image = ?1",
    ] {
        conn.execute(sql, params![old_path, new_path])?;
    }
    Ok(())
}

/// Re-link a moved folder: replace old_prefix with new_prefix in all saved paths
/// (images, reward folders, covers, previews). Period folder_path is a key, not a path.
/// Returns how many image rows changed.
pub fn relink_prefix(conn: &Connection, old_prefix: &str, new_prefix: &str) -> rusqlite::Result<u32> {
    let images = conn.execute(
        "UPDATE images SET file_path = ?2 || substr(file_path, length(?1)+1) \
         WHERE substr(file_path,1,length(?1)) = ?1",
        params![old_prefix, new_prefix],
    )?;
    for sql in [
        "UPDATE rewards SET folder_path = ?2 || substr(folder_path, length(?1)+1) WHERE substr(folder_path,1,length(?1)) = ?1",
        "UPDATE rewards SET cover_image = ?2 || substr(cover_image, length(?1)+1) WHERE substr(cover_image,1,length(?1)) = ?1",
        // backup paths on the disk need the new drive letter too
        "UPDATE rewards SET sd_backup_path = ?2 || substr(sd_backup_path, length(?1)+1) WHERE substr(sd_backup_path,1,length(?1)) = ?1",
        "UPDATE periods SET preview_image = ?2 || substr(preview_image, length(?1)+1) WHERE substr(preview_image,1,length(?1)) = ?1",
        "UPDATE artists SET preview_image = ?2 || substr(preview_image, length(?1)+1) WHERE substr(preview_image,1,length(?1)) = ?1",
        "UPDATE OR REPLACE wallpaper_favs SET file_path = ?2 || substr(file_path, length(?1)+1) WHERE substr(file_path,1,length(?1)) = ?1",
        "UPDATE OR REPLACE favorites SET file_path = ?2 || substr(file_path, length(?1)+1) WHERE substr(file_path,1,length(?1)) = ?1",
        "UPDATE OR REPLACE collection_items SET file_path = ?2 || substr(file_path, length(?1)+1) WHERE substr(file_path,1,length(?1)) = ?1",
    ] {
        conn.execute(sql, params![old_prefix, new_prefix])?;
    }
    // edit versions are keyed by path too
    remap_versions_prefix(conn, old_prefix, new_prefix)?;
    Ok(images as u32)
}

/// All images (id, file_path), for the health scan / prune.
pub fn all_image_id_paths(conn: &Connection) -> rusqlite::Result<Vec<(i64, String)>> {
    let mut stmt = conn.prepare("SELECT id, file_path FROM images")?;
    let rows = stmt.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))?;
    rows.collect()
}

/// All media files of one creator's OWN rewards (no borrowed collabs, their files
/// belong to the owner, otherwise the size would count twice).
pub fn artist_own_image_paths(conn: &Connection, artist_id: i64) -> rusqlite::Result<Vec<String>> {
    let mut stmt = conn.prepare(
        "SELECT i.file_path FROM images i
           JOIN rewards r ON r.id = i.reward_id
           JOIN periods p ON p.id = r.period_id
          WHERE p.artist_id = ?1",
    )?;
    let rows = stmt.query_map(params![artist_id], |r| r.get::<_, String>(0))?;
    rows.collect()
}

/// Same for the whole library as (artist_id, path), one query instead of one per creator.
pub fn all_own_image_paths(conn: &Connection) -> rusqlite::Result<Vec<(i64, String)>> {
    let mut stmt = conn.prepare(
        "SELECT p.artist_id, i.file_path FROM images i
           JOIN rewards r ON r.id = i.reward_id
           JOIN periods p ON p.id = r.period_id",
    )?;
    let rows = stmt.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))?;
    rows.collect()
}

/// Delete image rows by id (health "prune missing").
pub fn delete_images_by_ids(conn: &Connection, ids: &[i64]) -> rusqlite::Result<u32> {
    let mut n = 0u32;
    for id in ids {
        // remove favourites and versions of these paths first
        let orig: Option<String> = conn
            .query_row("SELECT file_path FROM images WHERE id = ?1", params![id], |r| r.get(0))
            .optional()?;
        conn.execute(
            "DELETE FROM wallpaper_favs WHERE file_path IN (SELECT file_path FROM images WHERE id = ?1)",
            params![id],
        )?;
        conn.execute(
            "DELETE FROM favorites WHERE file_path IN (SELECT file_path FROM images WHERE id = ?1)",
            params![id],
        )?;
        conn.execute(
            "DELETE FROM collection_items WHERE file_path IN (SELECT file_path FROM images WHERE id = ?1)",
            params![id],
        )?;
        if let Some(p) = orig {
            delete_versions_for_orig_paths(conn, &[p])?;
        }
        n += conn.execute("DELETE FROM images WHERE id = ?1", params![id])? as u32;
    }
    Ok(n)
}

/// Fix previews/covers whose file is gone (e.g. moved). Finds the file again by
/// its "<reward-folder>\<file-name>" tail. Returns how many were fixed.
pub fn repair_missing_previews(conn: &Connection) -> rusqlite::Result<u32> {
    // all image paths, normalized
    let images: Vec<String> = {
        let mut stmt = conn.prepare("SELECT file_path FROM images")?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    };
    let norm = |s: &str| s.replace('/', "\\").to_lowercase();
    let normalized: Vec<(String, String)> = images.iter().map(|p| (p.clone(), norm(p))).collect();

    // the "<parent>\<file>" tail
    let tail_of = |p: &str| -> Option<String> {
        let path = std::path::Path::new(p);
        let file = path.file_name()?.to_string_lossy().to_string();
        match path.parent().and_then(|x| x.file_name()) {
            Some(par) => Some(format!("{}\\{}", par.to_string_lossy(), file)),
            None => Some(file),
        }
    };
    // inside(path, folder), both normalized
    let inside = |p: &str, dir: &str| p.starts_with(&format!("{}\\", dir.trim_end_matches('\\')));

    // files on the MiSD disk aren't gone, just unplugged (relocating them once
    // pointed a cover at another creator's file)
    let mut offline: Vec<String> = {
        let mut stmt = conn.prepare("SELECT folder_path FROM rewards WHERE sd_volume IS NOT NULL")?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    };
    offline.extend(get_setting(conn, "sd_root")?.filter(|r| !r.trim().is_empty()));
    let offline: Vec<String> = offline.iter().map(|f| norm(f)).collect();

    // an automatic cover is always inside its own reward folder. If not, the old
    // relocation moved it, so reset it to the reward's first file
    let foreign: Vec<(i64, String, String)> = {
        let mut stmt = conn.prepare(
            "SELECT id, folder_path, cover_image FROM rewards \
             WHERE cover_custom = 0 AND cover_image IS NOT NULL AND cover_image <> ''",
        )?;
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    };
    let mut fixed = 0u32;
    for (id, folder, cover) in foreign {
        if inside(&norm(&cover), &norm(&folder)) {
            continue;
        }
        let first: Option<String> = conn.query_row(
            "SELECT MIN(file_path) FROM images WHERE reward_id = ?1",
            params![id],
            |r| r.get(0),
        )?;
        if let Some(first) = first {
            conn.execute("UPDATE rewards SET cover_image = ?2 WHERE id = ?1", params![id, first])?;
            fixed += 1;
        }
    }

    // within = the folder a replacement must come from (the reward's own)
    let relocate = |old: &str, within: Option<&str>| -> Option<String> {
        let old_n = norm(old);
        if offline.iter().any(|d| inside(&old_n, d)) {
            return None; // on the unplugged MiSD disk, not gone
        }
        if std::path::Path::new(old).exists() {
            return None; // not stale
        }
        let within = within.map(norm);
        let tail = norm(&tail_of(old)?);
        let mut fallback: Option<String> = None;
        for (orig, low) in &normalized {
            if low.ends_with(&tail) && within.as_deref().map_or(true, |w| inside(low, w)) {
                if std::path::Path::new(orig).exists() {
                    return Some(orig.clone());
                }
                fallback.get_or_insert_with(|| orig.clone());
            }
        }
        fallback
    };

    for (table, col, scope) in [
        ("artists", "preview_image", "NULL"),
        ("periods", "preview_image", "NULL"),
        ("rewards", "cover_image", "folder_path"),
    ] {
        let rows: Vec<(i64, String, Option<String>)> = {
            let mut stmt = conn.prepare(&format!(
                "SELECT id, {col}, {scope} FROM {table} WHERE {col} IS NOT NULL AND {col} <> ''"
            ))?;
            let it = stmt.query_map([], |r| Ok((r.get(0)?, r.get::<_, String>(1)?, r.get(2)?)))?;
            it.collect::<rusqlite::Result<Vec<_>>>()?
        };
        for (id, path, within) in rows {
            if let Some(np) = relocate(&path, within.as_deref()) {
                if np != path {
                    conn.execute(
                        &format!("UPDATE {table} SET {col} = ?2 WHERE id = ?1"),
                        params![id, np],
                    )?;
                    fixed += 1;
                }
            }
        }
    }
    Ok(fixed)
}

/// Get a reward's title and folder.
pub fn reward_title_folder(conn: &Connection, id: i64) -> rusqlite::Result<Option<(String, String)>> {
    conn.query_row(
        "SELECT title, folder_path FROM rewards WHERE id = ?1",
        params![id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )
    .optional()
}

/// Save a reward rename: title + folder and update the image paths and cover.
/// The folder was already renamed on disk.
pub fn apply_reward_rename(
    conn: &Connection,
    id: i64,
    new_title: &str,
    old_folder: &str,
    new_folder: &str,
) -> rusqlite::Result<()> {
    let mut rows: Vec<(i64, String)> = Vec::new();
    {
        let mut stmt = conn.prepare("SELECT id, file_path FROM images WHERE reward_id = ?1")?;
        let it = stmt.query_map(params![id], |r| Ok((r.get(0)?, r.get(1)?)))?;
        for x in it {
            rows.push(x?);
        }
    }
    for (img_id, fp) in rows {
        if let Some(rest) = fp.strip_prefix(old_folder) {
            let new_fp = format!("{}{}", new_folder, rest);
            conn.execute("UPDATE images SET file_path = ?2 WHERE id = ?1", params![img_id, new_fp])?;
        }
    }
    let cover: Option<String> = conn
        .query_row("SELECT cover_image FROM rewards WHERE id = ?1", params![id], |r| {
            r.get::<_, Option<String>>(0)
        })
        .optional()?
        .flatten();
    let new_cover = cover.map(|c| match c.strip_prefix(old_folder) {
        Some(rest) => format!("{}{}", new_folder, rest),
        None => c,
    });
    conn.execute(
        "UPDATE rewards SET title = ?2, folder_path = ?3, cover_image = ?4 WHERE id = ?1",
        params![id, new_title, new_folder, new_cover],
    )?;
    Ok(())
}

/// Get an image's path, name and reward.
pub fn image_row(conn: &Connection, id: i64) -> rusqlite::Result<Option<(String, Option<String>, i64)>> {
    conn.query_row(
        "SELECT file_path, rel_name, reward_id FROM images WHERE id = ?1",
        params![id],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    )
    .optional()
}

/// Save an image rename (file already renamed), update the cover if it pointed at it.
pub fn apply_image_rename(
    conn: &Connection,
    id: i64,
    old_path: &str,
    new_path: &str,
    new_rel: &str,
) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE images SET file_path = ?2, rel_name = ?3 WHERE id = ?1",
        params![id, new_path, new_rel],
    )?;
    conn.execute(
        "UPDATE rewards SET cover_image = ?2 WHERE cover_image = ?1",
        params![old_path, new_path],
    )?;
    // keep favourites pointing at the renamed file
    conn.execute(
        "UPDATE OR REPLACE wallpaper_favs SET file_path = ?2 WHERE file_path = ?1",
        params![old_path, new_path],
    )?;
    conn.execute(
        "UPDATE OR REPLACE favorites SET file_path = ?2 WHERE file_path = ?1",
        params![old_path, new_path],
    )?;
    conn.execute(
        "UPDATE OR REPLACE collection_items SET file_path = ?2 WHERE file_path = ?1",
        params![old_path, new_path],
    )?;
    Ok(())
}

/// An image with its reward + artist (for the duplicate finder).
pub struct DupRow {
    pub id: i64,
    pub file_path: String,
    pub reward: String,
    pub artist: String,
    pub artist_id: i64,
    pub period_id: i64,
    pub reward_id: i64,
    pub platform: Option<String>,
}

/// All images with reward + artist.
pub fn images_for_dup(conn: &Connection) -> rusqlite::Result<Vec<DupRow>> {
    let mut stmt = conn.prepare(
        "SELECT i.id, i.file_path, r.title, a.name, a.id, p.id, r.id, p.platform
         FROM images i
         JOIN rewards r ON i.reward_id = r.id
         JOIN periods p ON r.period_id = p.id
         JOIN artists a ON p.artist_id = a.id",
    )?;
    let rows = stmt
        .query_map([], |r| {
            Ok(DupRow {
                id: r.get(0)?,
                file_path: r.get(1)?,
                reward: r.get(2)?,
                artist: r.get(3)?,
                artist_id: r.get(4)?,
                period_id: r.get(5)?,
                reward_id: r.get(6)?,
                platform: r.get(7)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

/// All images as (artist_id, artist_name, file_path) for the storage stats.
pub fn images_with_artist(conn: &Connection) -> rusqlite::Result<Vec<(i64, String, String)>> {
    let mut stmt = conn.prepare(
        "SELECT a.id, a.name, i.file_path
         FROM images i
         JOIN rewards r ON i.reward_id = r.id
         JOIN periods p ON r.period_id = p.id
         JOIN artists a ON p.artist_id = a.id",
    )?;
    let rows = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

/// All image paths (for the disk size).
pub fn all_image_paths(conn: &Connection) -> rusqlite::Result<Vec<String>> {
    let mut stmt = conn.prepare("SELECT file_path FROM images")?;
    let rows = stmt
        .query_map([], |r| r.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

pub fn reward_folder(conn: &Connection, reward_id: i64) -> rusqlite::Result<Option<String>> {
    conn.query_row(
        "SELECT folder_path FROM rewards WHERE id = ?1",
        params![reward_id],
        |r| r.get::<_, String>(0),
    )
    .optional()
}

/// Remove empty periods. Empty periods of manual artists stay (platform tabs).
/// The creator card itself is NEVER removed here: that used to throw away
/// aliases, links, notes, tags etc. An empty card is fine, deleting a creator
/// is done on purpose from the card.
fn prune(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute(
        "DELETE FROM periods
         WHERE id NOT IN (SELECT DISTINCT period_id FROM rewards)
           AND skipped = 0
           AND artist_id NOT IN (SELECT id FROM artists WHERE manual = 1)",
        [],
    )?;
    Ok(())
}

/// Delete a period (and its rewards/images), then clean up.
pub fn delete_period(conn: &Connection, period_id: i64) -> rusqlite::Result<()> {
    let paths: Vec<String> = {
        let mut stmt = conn.prepare(
            "SELECT i.file_path FROM images i JOIN rewards r ON r.id = i.reward_id WHERE r.period_id = ?1",
        )?;
        let rows = stmt.query_map(params![period_id], |r| r.get::<_, String>(0))?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    };
    delete_versions_for_orig_paths(conn, &paths)?;
    conn.execute("DELETE FROM periods WHERE id = ?1", params![period_id])?;
    prune(conn)
}

/// Delete rewards (and their images), then clean up.
pub fn delete_rewards(conn: &Connection, ids: &[i64]) -> rusqlite::Result<()> {
    let paths = image_paths_for_rewards(conn, ids)?;
    delete_versions_for_orig_paths(conn, &paths)?;
    for id in ids {
        conn.execute("DELETE FROM rewards WHERE id = ?1", params![id])?;
    }
    prune(conn)
}

pub fn image_path(conn: &Connection, image_id: i64) -> rusqlite::Result<Option<String>> {
    conn.query_row(
        "SELECT file_path FROM images WHERE id = ?1",
        params![image_id],
        |r| r.get::<_, String>(0),
    )
    .optional()
}

/// Add a new file (e.g. an edited copy) to the same reward as an existing image.
/// false if the reference isn't indexed. Idempotent.
pub fn add_image_beside(
    conn: &Connection,
    reference_path: &str,
    new_path: &str,
) -> rusqlite::Result<bool> {
    let reward_id: Option<i64> = conn
        .query_row(
            "SELECT reward_id FROM images WHERE file_path = ?1",
            params![reference_path],
            |r| r.get(0),
        )
        .optional()?;
    let Some(reward_id) = reward_id else {
        return Ok(false);
    };
    let already: Option<i64> = conn
        .query_row(
            "SELECT id FROM images WHERE file_path = ?1",
            params![new_path],
            |r| r.get(0),
        )
        .optional()?;
    if already.is_some() {
        return Ok(true);
    }
    let next_sort: i64 = conn.query_row(
        "SELECT COALESCE(MAX(sort) + 1, 0) FROM images WHERE reward_id = ?1",
        params![reward_id],
        |r| r.get(0),
    )?;
    let rel = std::path::Path::new(new_path)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or(new_path);
    conn.execute(
        "INSERT INTO images(reward_id, file_path, rel_name, sort) VALUES(?1, ?2, ?3, ?4)",
        params![reward_id, new_path, rel, next_sort],
    )?;
    conn.execute(
        "UPDATE rewards
            SET image_count = image_count + 1,
                status = CASE WHEN status = 'missing' THEN 'owned' ELSE status END
          WHERE id = ?1",
        params![reward_id],
    )?;
    Ok(true)
}

/// Delete one image. If it was the last one, delete the reward too,
/// otherwise update the cover and count.
pub fn delete_image(conn: &Connection, image_id: i64) -> rusqlite::Result<()> {
    let reward_id: Option<i64> = conn
        .query_row(
            "SELECT reward_id FROM images WHERE id = ?1",
            params![image_id],
            |r| r.get(0),
        )
        .optional()?;
    // remove favourites of this file
    conn.execute(
        "DELETE FROM wallpaper_favs WHERE file_path IN (SELECT file_path FROM images WHERE id = ?1)",
        params![image_id],
    )?;
    conn.execute(
        "DELETE FROM favorites WHERE file_path IN (SELECT file_path FROM images WHERE id = ?1)",
        params![image_id],
    )?;
    conn.execute(
        "DELETE FROM collection_items WHERE file_path IN (SELECT file_path FROM images WHERE id = ?1)",
        params![image_id],
    )?;
    // remove edit versions of this file
    if let Some(p) = image_path(conn, image_id)? {
        delete_versions_for_orig_paths(conn, &[p])?;
    }
    conn.execute("DELETE FROM images WHERE id = ?1", params![image_id])?;
    if let Some(rid) = reward_id {
        let remaining: i64 =
            conn.query_row("SELECT COUNT(*) FROM images WHERE reward_id = ?1", params![rid], |r| {
                r.get(0)
            })?;
        if remaining == 0 {
            conn.execute("DELETE FROM rewards WHERE id = ?1", params![rid])?;
            prune(conn)?;
        } else {
            let cover: Option<String> = conn
                .query_row(
                    "SELECT file_path FROM images WHERE reward_id = ?1 ORDER BY sort, rel_name LIMIT 1",
                    params![rid],
                    |r| r.get(0),
                )
                .optional()?;
            conn.execute(
                "UPDATE rewards SET image_count = ?1, cover_image = ?2 WHERE id = ?3",
                params![remaining, cover, rid],
            )?;
        }
    }
    Ok(())
}

/// Delete all indexed content and roots. Settings stay.
pub fn clear_library(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "DELETE FROM images;
         DELETE FROM rewards;
         DELETE FROM periods;
         DELETE FROM artists;
         DELETE FROM roots;
         DELETE FROM wallpaper_favs;
         DELETE FROM favorites;
         -- Memberships go with the files; the collections themselves (the user's own
         -- groupings) survive a library wipe, like their settings do.
         DELETE FROM collection_items;
         DELETE FROM image_active_version;
         DELETE FROM image_versions;",
    )
}

/* ---- full library load ----------------------------------------------- */

/// "Unsorted" = NULL platform, and platforms can have different case, so compare with this
fn norm_platform(p: Option<&str>) -> String {
    p.map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("Unsorted")
        .to_lowercase()
}

/// Id for a period that only exists in a collaborator's view. Negative and unique,
/// stable across refreshes (React keys, routes). A command with this id finds nothing.
fn virtual_period_id(partner_artist_id: i64, owner_period_id: i64) -> i64 {
    -(((partner_artist_id & 0x7FFF_FFFF) << 32) | (owner_period_id & 0xFFFF_FFFF))
}

/// One borrowed reward (owned by one creator, credited to another).
struct Borrowed {
    reward: Reward,
    owner_period_id: i64,
    platform: Option<String>,
    year: Option<i64>,
    month: Option<i64>,
    number: Option<i64>,
    span: i64,
    label: String,
    folder_path: String,
}

pub fn get_library(conn: &Connection) -> rusqlite::Result<Vec<Artist>> {
    use std::collections::HashMap;

    // collab links loaded ONCE for the whole library (empty if nobody uses collabs)
    let mut borrowed_by_partner: HashMap<i64, Vec<Borrowed>> = HashMap::new();
    let mut chips: HashMap<i64, Vec<CollabRef>> = HashMap::new();
    {
        // skip self-links (two tiles with the same key)
        let mut stmt = conn.prepare(
            "SELECT c.artist_id,
                    r.id, r.title, r.category, r.folder_path, r.cover_image, r.status,
                    r.is_root, r.image_count, r.sd_marked, r.sd_volume,
                    p.id, p.platform, p.year, p.month, p.number, p.span, p.label, p.folder_path,
                    oa.id, oa.name, r.cover_custom, r.sd_backup, r.sd_backup_at, r.fresh, r.wished,
                    r.is_extra
             FROM reward_collabs c
             JOIN rewards r  ON r.id = c.reward_id
             JOIN periods p  ON p.id = r.period_id
             JOIN artists oa ON oa.id = p.artist_id
             WHERE c.artist_id <> p.artist_id
             ORDER BY p.id, r.category IS NULL DESC, r.title COLLATE NOCASE",
        )?;
        let rows = stmt.query_map([], |r| {
            let owner = CollabRef {
                artist_id: r.get(19)?,
                artist_name: r.get(20)?,
            };
            Ok((
                r.get::<_, i64>(0)?,
                Borrowed {
                    reward: Reward {
                        id: r.get(1)?,
                        title: r.get(2)?,
                        category: r.get(3)?,
                        folder_path: r.get(4)?,
                        cover_image: r.get(5)?,
                        cover_custom: r.get::<_, i64>(21)? != 0,
                        status: r.get(6)?,
                        is_root: r.get::<_, i64>(7)? != 0,
                        is_extra: r.get::<_, i64>(26)? != 0,
                        image_count: r.get(8)?,
                        sd_marked: r.get::<_, i64>(9)? == 1,
                        sd_volume: r.get(10)?,
                        sd_backup_marked: r.get::<_, i64>(9)? == 2,
                        sd_backup: r.get(22)?,
                        sd_backup_at: r.get(23)?,
                        fresh: r.get::<_, i64>(24)? != 0,
                        wished: r.get(25)?,
                        collab_from: Some(owner),
                        collab_with: Vec::new(),
                        images: Vec::new(),
                    },
                    owner_period_id: r.get(11)?,
                    platform: r.get(12)?,
                    year: r.get(13)?,
                    month: r.get(14)?,
                    number: r.get(15)?,
                    span: r.get(16)?,
                    label: r.get(17)?,
                    folder_path: r.get(18)?,
                },
            ))
        })?;
        for row in rows {
            let (partner, b) = row?;
            borrowed_by_partner.entry(partner).or_default().push(b);
        }

        let mut stmt = conn.prepare(
            "SELECT c.reward_id, a.id, a.name
             FROM reward_collabs c JOIN artists a ON a.id = c.artist_id
             ORDER BY a.name COLLATE NOCASE",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                CollabRef {
                    artist_id: r.get(1)?,
                    artist_name: r.get(2)?,
                },
            ))
        })?;
        for row in rows {
            let (rid, cr) = row?;
            chips.entry(rid).or_default().push(cr);
        }
    }

    // platform style overrides for all artists at once (was one query per artist)
    let mut style_overrides: HashMap<(i64, String), String> = HashMap::new();
    {
        let mut stmt = conn.prepare(
            "SELECT artist_id, platform,
                    COALESCE(release_style, CASE WHEN no_dates = 1 THEN 'none' ELSE 'monthly' END)
             FROM platform_no_dates",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok((
                (r.get::<_, i64>(0)?, r.get::<_, String>(1)?),
                r.get::<_, String>(2)?,
            ))
        })?;
        for row in rows {
            let (k, v) = row?;
            style_overrides.insert(k, v);
        }
    }

    let mut artists: Vec<Artist> = Vec::new();
    {
        let mut stmt = conn.prepare(
            "SELECT id, name, preview_image, no_dates, tag, links, kind, template_source, template_verified, tags,
                    COALESCE(updated_at, created_at), notes, wallpaper_fav, aliases,
                    COALESCE(release_style, CASE WHEN no_dates = 1 THEN 'none' ELSE 'monthly' END),
                    hidden, graveyard
             FROM artists ORDER BY name COLLATE NOCASE",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(Artist {
                id: r.get(0)?,
                name: r.get(1)?,
                preview_image: r.get(2)?,
                no_dates: r.get::<_, i64>(3)? != 0,
                no_dates_platforms: Vec::new(),
                release_style: r.get(14)?,
                platform_styles: Vec::new(),
                tag: r.get(4)?,
                links: r.get(5)?,
                kind: r.get(6)?,
                template_source: r.get(7)?,
                template_verified: r.get::<_, i64>(8)? != 0,
                tags: r.get(9)?,
                updated_at: r.get(10)?,
                notes: r.get(11)?,
                wallpaper_fav: r.get::<_, i64>(12)? != 0,
                aliases: r.get(13)?,
                hidden: r.get::<_, i64>(15)? != 0,
                graveyard: r.get::<_, i64>(16)? != 0,
                periods: Vec::new(),
            })
        })?;
        for a in rows {
            artists.push(a?);
        }
    }

    for artist in artists.iter_mut() {
        let mut periods: Vec<Period> = Vec::new();
        {
            let mut stmt = conn.prepare(
                "SELECT id, platform, year, month, span, label, folder_path, needs_review, preview_image, official_total, skipped, verified, open_as_cards, number
                 FROM periods WHERE artist_id = ?1
                 ORDER BY year DESC, month DESC, number DESC, label DESC",
            )?;
            let rows = stmt.query_map(params![artist.id], |r| {
                Ok(Period {
                    id: r.get(0)?,
                    platform: r.get(1)?,
                    year: r.get(2)?,
                    month: r.get(3)?,
                    number: r.get(13)?,
                    span: r.get(4)?,
                    label: r.get(5)?,
                    folder_path: r.get(6)?,
                    needs_review: r.get::<_, i64>(7)? != 0,
                    preview_image: r.get(8)?,
                    official_total: r.get(9)?,
                    skipped: r.get::<_, i64>(10)? != 0,
                    verified: r.get::<_, i64>(11)? != 0,
                    open_as_cards: r.get::<_, i64>(12)? != 0,
                    collab_only: false,
                    rewards: Vec::new(),
                })
            })?;
            for p in rows {
                periods.push(p?);
            }
        }

        for period in periods.iter_mut() {
            let mut rewards: Vec<Reward> = Vec::new();
            {
                // light load: only the count, images are loaded per artist with
                // artist_images
                let mut stmt = conn.prepare(
                    "SELECT id, title, category, folder_path, cover_image, status, is_root, image_count,
                            sd_marked, sd_volume, cover_custom, sd_backup, sd_backup_at, fresh, wished,
                            is_extra
                     FROM rewards WHERE period_id = ?1
                     ORDER BY category IS NULL DESC, title COLLATE NOCASE",
                )?;
                let rows = stmt.query_map(params![period.id], |r| {
                    Ok(Reward {
                        id: r.get(0)?,
                        title: r.get(1)?,
                        category: r.get(2)?,
                        folder_path: r.get(3)?,
                        cover_image: r.get(4)?,
                        cover_custom: r.get::<_, i64>(10)? != 0,
                        status: r.get(5)?,
                        is_root: r.get::<_, i64>(6)? != 0,
                        is_extra: r.get::<_, i64>(15)? != 0,
                        image_count: r.get(7)?,
                        sd_marked: r.get::<_, i64>(8)? == 1,
                        sd_volume: r.get(9)?,
                        sd_backup_marked: r.get::<_, i64>(8)? == 2,
                        sd_backup: r.get(11)?,
                        sd_backup_at: r.get(12)?,
                        fresh: r.get::<_, i64>(13)? != 0,
                        wished: r.get(14)?,
                        collab_from: None,
                        collab_with: Vec::new(),
                        images: Vec::new(),
                    })
                })?;
                for rw in rows {
                    rewards.push(rw?);
                }
            }
            for rw in rewards.iter_mut() {
                rw.collab_with = chips.get(&rw.id).cloned().unwrap_or_default();
            }
            period.rewards = rewards;
        }
        artist.periods = periods;

        // add this creator's borrowed rewards to the tree. BEFORE the styles below,
        // because a borrowed reward can add a platform the creator has no periods on
        if let Some(items) = borrowed_by_partner.remove(&artist.id) {
            for b in items {
                let want = norm_platform(b.platform.as_deref());
                let display = b
                    .platform
                    .clone()
                    .unwrap_or_else(|| "Unsorted".to_string());
                let style = style_overrides
                    .get(&(artist.id, display.clone()))
                    .cloned()
                    .unwrap_or_else(|| artist.release_style.clone());
                // only monthly creators have year/month, the others get the unscheduled
                // bucket
                let (want_year, want_month, want_number) = if style == "monthly" {
                    (b.year, b.month, b.number)
                } else {
                    (None, None, None)
                };
                let mut reward = b.reward;
                reward.collab_with = chips.get(&reward.id).cloned().unwrap_or_default();

                // reuse a matching period (also a ghost made earlier in this loop)
                let existing = artist.periods.iter().position(|p| {
                    norm_platform(p.platform.as_deref()) == want
                        && p.year == want_year
                        && p.month == want_month
                        && p.number == want_number
                });
                match existing {
                    Some(i) => artist.periods[i].rewards.push(reward),
                    None => artist.periods.push(Period {
                        id: virtual_period_id(artist.id, b.owner_period_id),
                        platform: b.platform.clone(),
                        year: want_year,
                        month: want_month,
                        number: want_number,
                        span: b.span,
                        label: b.label.clone(),
                        folder_path: b.folder_path.clone(),
                        needs_review: false,
                        skipped: false,
                        verified: false,
                        preview_image: None,
                        // no template ratio on a month that only shows someone else's work
                        official_total: None,
                        // never jump straight into the viewer from a ghost month
                        open_as_cards: true,
                        collab_only: true,
                        rewards: vec![reward],
                    }),
                }
            }
            // keep the period order (DESC, NULLs last), otherwise ghosts end up at the end
            artist.periods.sort_by(|a, b| {
                b.year
                    .cmp(&a.year)
                    .then(b.month.cmp(&a.month))
                    .then(b.number.cmp(&a.number))
                    .then(b.label.cmp(&a.label))
            });
        }

        // release style per platform: override or the artist default
        // (no_dates_platforms kept for older frontend code)
        {
            let mut seen = std::collections::HashSet::new();
            let mut styles = Vec::new();
            let mut dateless = Vec::new();
            for p in &artist.periods {
                let name = p.platform.clone().unwrap_or_else(|| "Unsorted".to_string());
                if !seen.insert(name.clone()) {
                    continue;
                }
                let style = style_overrides
                    .get(&(artist.id, name.clone()))
                    .cloned()
                    .unwrap_or_else(|| artist.release_style.clone());
                if style == "none" {
                    dateless.push(name.clone());
                }
                styles.push(PlatformStyle { platform: name, style });
            }
            artist.no_dates_platforms = dateless;
            artist.platform_styles = styles;
        }
    }

    Ok(artists)
}

/// All images of one artist, grouped per reward (one query).
pub fn artist_images(conn: &Connection, artist_id: i64) -> rusqlite::Result<Vec<RewardImages>> {
    let mut stmt = conn.prepare(
        "SELECT i.reward_id, i.id, i.file_path, i.rel_name,
                (wf.file_path IS NOT NULL) AS fav_wp,
                (fv.file_path IS NOT NULL) AS fav,
                COALESCE(v.file_path, i.file_path) AS display_path,
                (SELECT COUNT(*) FROM image_versions ivc WHERE ivc.orig_path = i.file_path) AS version_count,
                (av.version_id IS NULL) AS on_original,
                (SELECT GROUP_CONCAT(ci.collection_id)
                   FROM collection_items ci WHERE ci.file_path = i.file_path) AS colls
         FROM images i
         JOIN rewards r ON r.id = i.reward_id
         JOIN periods p ON p.id = r.period_id
         LEFT JOIN wallpaper_favs wf ON wf.file_path = i.file_path
         LEFT JOIN favorites      fv ON fv.file_path = i.file_path
         LEFT JOIN image_active_version av ON av.orig_path = i.file_path
         LEFT JOIN image_versions       v  ON v.id = av.version_id
         WHERE p.artist_id = ?1
            OR EXISTS (SELECT 1 FROM reward_collabs c
                        WHERE c.reward_id = r.id AND c.artist_id = ?1)
         ORDER BY i.reward_id, i.sort, i.rel_name",
    )?;
    let rows = stmt.query_map(params![artist_id], |r| {
        let file_path: String = r.get(2)?;
        let display_path: String = r.get(6)?;
        Ok((
            r.get::<_, i64>(0)?,
            ImageItem {
                id: r.get(1)?,
                file_path,
                display_path,
                version_count: r.get::<_, i64>(7)?,
                on_original: r.get::<_, i64>(8)? != 0,
                rel_name: r.get::<_, Option<String>>(3)?.unwrap_or_default(),
                fav_wallpaper: r.get::<_, i64>(4)? != 0,
                favorite: r.get::<_, i64>(5)? != 0,
                // GROUP_CONCAT gives NULL for none, "3,7" otherwise
                collections: r
                    .get::<_, Option<String>>(9)?
                    .map(|s| s.split(',').filter_map(|p| p.trim().parse::<i64>().ok()).collect())
                    .unwrap_or_default(),
            },
        ))
    })?;
    // rows are sorted by reward_id, so append to the last group
    let mut out: Vec<RewardImages> = Vec::new();
    for row in rows {
        let (rid, im) = row?;
        match out.last_mut() {
            Some(last) if last.reward_id == rid => last.images.push(im),
            _ => out.push(RewardImages { reward_id: rid, images: vec![im] }),
        }
    }
    Ok(out)
}

/* ---- Collabs ---------------------------------------------------------- */

/// A collab link whose folder is gone (shown in library health).
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BrokenCollab {
    pub reward_id: i64,
    pub title: String,
    pub owner_name: String,
    pub partner_name: String,
    pub folder_path: String,
}

/// Credit a reward to collab creators (replaces the whole list, empty clears it).
/// The reward doesn't move, partners only show a read-only copy.
pub fn set_reward_collabs(
    conn: &Connection,
    reward_id: i64,
    artist_ids: &[i64],
) -> rusqlite::Result<()> {
    let owner: i64 = conn.query_row(
        "SELECT p.artist_id FROM rewards r JOIN periods p ON p.id = r.period_id
          WHERE r.id = ?1",
        params![reward_id],
        |r| r.get(0),
    )?;
    conn.execute(
        "DELETE FROM reward_collabs WHERE reward_id = ?1",
        params![reward_id],
    )?;
    let mut stmt = conn
        .prepare("INSERT OR IGNORE INTO reward_collabs(reward_id, artist_id) VALUES(?1, ?2)")?;
    for id in artist_ids {
        // never a collab with its own creator
        if *id == owner {
            continue;
        }
        stmt.execute(params![reward_id, id])?;
        // a credited creator must survive prune (it would delete the link)
        conn.execute(
            "UPDATE artists SET manual = 1 WHERE id = ?1",
            params![id],
        )?;
    }
    Ok(())
}

/// The creator who owns a reward.
pub fn reward_owner(conn: &Connection, reward_id: i64) -> rusqlite::Result<Option<i64>> {
    conn.query_row(
        "SELECT p.artist_id FROM rewards r JOIN periods p ON p.id = r.period_id
          WHERE r.id = ?1",
        params![reward_id],
        |r| r.get(0),
    )
    .optional()
}

/// Collab links whose folder is gone (renamed outside MiColl).
pub fn broken_collabs(conn: &Connection) -> rusqlite::Result<Vec<BrokenCollab>> {
    let mut stmt = conn.prepare(
        "SELECT r.id, r.title, r.folder_path, oa.name, pa.name
         FROM reward_collabs c
         JOIN rewards r  ON r.id = c.reward_id
         JOIN periods p  ON p.id = r.period_id
         JOIN artists oa ON oa.id = p.artist_id
         JOIN artists pa ON pa.id = c.artist_id
         ORDER BY oa.name COLLATE NOCASE, r.title COLLATE NOCASE",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(BrokenCollab {
            reward_id: r.get(0)?,
            title: r.get(1)?,
            folder_path: r.get(2)?,
            owner_name: r.get(3)?,
            partner_name: r.get(4)?,
        })
    })?;
    let mut out = Vec::new();
    for row in rows {
        let b = row?;
        if !Path::new(&b.folder_path).exists() {
            out.push(b);
        }
    }
    Ok(out)
}

/// Remove only those links, never the reward rows (that's "Prune missing").
pub fn clear_broken_collabs(conn: &Connection) -> rusqlite::Result<u32> {
    let broken = broken_collabs(conn)?;
    let mut n = 0u32;
    for b in &broken {
        n += conn.execute(
            "DELETE FROM reward_collabs WHERE reward_id = ?1",
            params![b.reward_id],
        )? as u32;
    }
    Ok(n)
}

/* ---- Image versions (non-destructive edit history) -------------------- */

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ImageVersion {
    pub id: i64,
    pub orig_path: String,
    pub file_path: String,
    pub label: Option<String>,
    pub created_at: Option<String>,
}

/// Save a new version for orig_path (the file is already written). Returns its id.
pub fn add_image_version(
    conn: &Connection,
    orig_path: &str,
    file_path: &str,
    label: Option<&str>,
) -> rusqlite::Result<i64> {
    conn.execute(
        "INSERT INTO image_versions(orig_path, file_path, label) VALUES(?1, ?2, ?3)",
        params![orig_path, file_path, label],
    )?;
    Ok(conn.last_insert_rowid())
}

/// All versions of an image + the active one (None = original).
pub fn list_image_versions(
    conn: &Connection,
    orig_path: &str,
) -> rusqlite::Result<(Vec<ImageVersion>, Option<i64>)> {
    let mut stmt = conn.prepare(
        "SELECT id, orig_path, file_path, label, created_at
         FROM image_versions WHERE orig_path = ?1 ORDER BY id",
    )?;
    let versions = stmt
        .query_map(params![orig_path], |r| {
            Ok(ImageVersion {
                id: r.get(0)?,
                orig_path: r.get(1)?,
                file_path: r.get(2)?,
                label: r.get(3)?,
                created_at: r.get(4)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let active: Option<i64> = conn
        .query_row(
            "SELECT version_id FROM image_active_version WHERE orig_path = ?1",
            params![orig_path],
            |r| r.get(0),
        )
        .optional()?;
    Ok((versions, active))
}

/// Pick which version is shown, None = original.
pub fn set_active_version(
    conn: &Connection,
    orig_path: &str,
    version_id: Option<i64>,
) -> rusqlite::Result<()> {
    match version_id {
        Some(v) => {
            conn.execute(
                "INSERT INTO image_active_version(orig_path, version_id) VALUES(?1, ?2)
                 ON CONFLICT(orig_path) DO UPDATE SET version_id = ?2",
                params![orig_path, v],
            )?;
        }
        None => {
            conn.execute(
                "DELETE FROM image_active_version WHERE orig_path = ?1",
                params![orig_path],
            )?;
        }
    }
    Ok(())
}

/// Delete one version, returns its file path so it can be trashed.
/// The active row cascades away.
pub fn delete_image_version(conn: &Connection, version_id: i64) -> rusqlite::Result<Option<String>> {
    let fp: Option<String> = conn
        .query_row(
            "SELECT file_path FROM image_versions WHERE id = ?1",
            params![version_id],
            |r| r.get(0),
        )
        .optional()?;
    conn.execute("DELETE FROM image_versions WHERE id = ?1", params![version_id])?;
    Ok(fp)
}

/// Original paths of some rewards (to clean up versions on delete).
pub fn image_paths_for_rewards(conn: &Connection, reward_ids: &[i64]) -> rusqlite::Result<Vec<String>> {
    let mut out = Vec::new();
    let mut stmt = conn.prepare("SELECT file_path FROM images WHERE reward_id = ?1")?;
    for id in reward_ids {
        let rows = stmt.query_map(params![id], |r| r.get::<_, String>(0))?;
        for p in rows {
            out.push(p?);
        }
    }
    Ok(out)
}

/// Original paths of a whole artist (versions cleanup).
pub fn image_paths_for_artist(conn: &Connection, artist_id: i64) -> rusqlite::Result<Vec<String>> {
    let mut stmt = conn.prepare(
        "SELECT i.file_path FROM images i
         JOIN rewards r ON r.id = i.reward_id
         JOIN periods p ON p.id = r.period_id
         WHERE p.artist_id = ?1",
    )?;
    let rows = stmt.query_map(params![artist_id], |r| r.get::<_, String>(0))?;
    rows.collect()
}

/// All version file paths of these originals (for trashing).
pub fn version_files_for_orig_paths(
    conn: &Connection,
    orig_paths: &[String],
) -> rusqlite::Result<Vec<String>> {
    let mut out = Vec::new();
    let mut stmt = conn.prepare("SELECT file_path FROM image_versions WHERE orig_path = ?1")?;
    for p in orig_paths {
        let rows = stmt.query_map(params![p], |r| r.get::<_, String>(0))?;
        for fp in rows {
            out.push(fp?);
        }
    }
    Ok(out)
}

/// Delete all version rows of these originals.
pub fn delete_versions_for_orig_paths(conn: &Connection, orig_paths: &[String]) -> rusqlite::Result<()> {
    for p in orig_paths {
        // also delete the active rows explicitly
        conn.execute("DELETE FROM image_active_version WHERE orig_path = ?1", params![p])?;
        conn.execute("DELETE FROM image_versions WHERE orig_path = ?1", params![p])?;
    }
    Ok(())
}

/// Update version keys after a folder move (like the favourites).
pub fn remap_versions_prefix(conn: &Connection, old_prefix: &str, new_prefix: &str) -> rusqlite::Result<()> {
    for sql in [
        "UPDATE image_versions SET orig_path = ?2 || substr(orig_path, length(?1)+1) WHERE substr(orig_path,1,length(?1)) = ?1",
        "UPDATE OR REPLACE image_active_version SET orig_path = ?2 || substr(orig_path, length(?1)+1) WHERE substr(orig_path,1,length(?1)) = ?1",
    ] {
        conn.execute(sql, params![old_prefix, new_prefix])?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Emptying a creator must not delete the creator (aliases, links, notes... must stay).
    ///
    /// A template's placeholders must never show up on the wishlist
    /// (only the wished flag tells them apart).
    ///
    /// Hiding takes the card off the dashboard and nothing else, and it's a column
    /// so it survives a restart.
    ///
    /// A creator's size only counts their own files (borrowed collabs belong to the owner).
    #[test]
    fn a_borrowed_collab_weighs_nothing_for_the_borrower() {
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        conn.execute("INSERT INTO artists(name) VALUES('Owner'), ('Guest')", []).unwrap();
        let owner: i64 =
            conn.query_row("SELECT id FROM artists WHERE name='Owner'", [], |r| r.get(0)).unwrap();
        let guest: i64 =
            conn.query_row("SELECT id FROM artists WHERE name='Guest'", [], |r| r.get(0)).unwrap();
        conn.execute(
            "INSERT INTO periods(artist_id, label, folder_path) VALUES(?1, 'Misc', 'p1')",
            params![owner],
        )
        .unwrap();
        let pid = conn.last_insert_rowid();
        conn.execute(
            "INSERT INTO rewards(period_id, title, folder_path, image_count) VALUES(?1, 'Pack', 'p1/Pack', 2)",
            params![pid],
        )
        .unwrap();
        let rid = conn.last_insert_rowid();
        for f in ["01.jpg", "02.jpg"] {
            conn.execute(
                "INSERT INTO images(reward_id, file_path, rel_name) VALUES(?1, ?2, ?3)",
                params![rid, format!("p1/Pack/{f}"), f],
            )
            .unwrap();
        }
        conn.execute(
            "INSERT INTO reward_collabs(reward_id, artist_id) VALUES(?1, ?2)",
            params![rid, guest],
        )
        .unwrap();

        assert_eq!(artist_own_image_paths(&conn, owner).unwrap().len(), 2);
        assert!(
            artist_own_image_paths(&conn, guest).unwrap().is_empty(),
            "the guest borrows the reward but holds none of its files"
        );
        // the borrowed reward is still in the guest's gallery
        assert_eq!(artist_images(&conn, guest).unwrap().len(), 1);

        let all = all_own_image_paths(&conn).unwrap();
        assert_eq!(all.len(), 2);
        assert!(all.iter().all(|(a, _)| *a == owner), "every file bills to the owner");
    }

    #[test]
    fn hiding_a_creator_keeps_everything_but_the_card() {
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        conn.execute("INSERT INTO artists(name, manual) VALUES('Shy', 0)", []).unwrap();
        let artist: i64 =
            conn.query_row("SELECT id FROM artists WHERE name='Shy'", [], |r| r.get(0)).unwrap();
        set_artist_aliases(&conn, artist, r#"["other handle"]"#).unwrap();
        conn.execute(
            "INSERT INTO periods(artist_id, platform, year, month, label, folder_path)
             VALUES(?1, 'Patreon', 2026, 3, '2026-03', '/a/Patreon/2026/03')",
            params![artist],
        )
        .unwrap();
        let period: i64 = conn
            .query_row("SELECT id FROM periods WHERE artist_id=?1", params![artist], |r| r.get(0))
            .unwrap();
        conn.execute(
            "INSERT INTO rewards(period_id, title, folder_path, image_count)
             VALUES(?1, 'March set', '/a/Patreon/2026/03/March set', 4)",
            params![period],
        )
        .unwrap();

        let hidden_of = || -> i64 {
            conn.query_row("SELECT hidden FROM artists WHERE id=?1", params![artist], |r| r.get(0))
                .unwrap()
        };
        assert_eq!(hidden_of(), 0, "creators start visible");

        set_artist_hidden(&conn, artist, true).unwrap();
        assert_eq!(hidden_of(), 1);

        // everything the card had is still there
        let rewards: i64 = conn
            .query_row(
                "SELECT count(*) FROM rewards r JOIN periods p ON p.id = r.period_id
                  WHERE p.artist_id = ?1",
                params![artist],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(rewards, 1, "hiding must not touch the content");
        let aliases: Option<String> = conn
            .query_row("SELECT aliases FROM artists WHERE id=?1", params![artist], |r| r.get(0))
            .unwrap();
        assert!(aliases.unwrap().contains("other handle"));

        set_artist_hidden(&conn, artist, false).unwrap();
        assert_eq!(hidden_of(), 0);

        // the graveyard is a separate flag from hidden
        let grave_of = || -> i64 {
            conn.query_row("SELECT graveyard FROM artists WHERE id=?1", params![artist], |r| r.get(0))
                .unwrap()
        };
        assert_eq!(grave_of(), 0, "creators start outside the graveyard");
        set_artist_graveyard(&conn, artist, true).unwrap();
        assert_eq!(grave_of(), 1);
        assert_eq!(hidden_of(), 0, "the graveyard is not hiding");
        let lib = get_library(&conn).unwrap();
        assert!(lib.iter().any(|a| a.id == artist && a.graveyard));
        set_artist_graveyard(&conn, artist, false).unwrap();
        assert_eq!(grave_of(), 0);
    }

    #[test]
    fn a_template_gap_is_not_a_wish() {
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        conn.execute("INSERT INTO artists(name, manual) VALUES('Tmpl', 0)", []).unwrap();
        let artist: i64 =
            conn.query_row("SELECT id FROM artists WHERE name='Tmpl'", [], |r| r.get(0)).unwrap();
        conn.execute(
            "INSERT INTO periods(artist_id, platform, year, month, label, folder_path)
             VALUES(?1, 'Patreon', 2026, 3, '2026-03', '/a/Patreon/2026/03')",
            params![artist],
        )
        .unwrap();
        let period: i64 = conn
            .query_row("SELECT id FROM periods WHERE artist_id=?1", params![artist], |r| r.get(0))
            .unwrap();
        let wished_of = |id: i64| -> i64 {
            conn.query_row("SELECT wished FROM rewards WHERE id=?1", params![id], |r| r.get(0))
                .unwrap()
        };

        // what applying a template does
        insert_missing_reward(&conn, period, "Released in March", None, "tmpl-key-march").unwrap();
        let gap: i64 = conn
            .query_row("SELECT id FROM rewards WHERE title='Released in March'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(wished_of(gap), 0, "a template placeholder is not a wish");

        // wishing for that reward puts it on the list, but the row stays the template's (2)
        set_reward_wished(&conn, gap, 2).unwrap();
        assert_eq!(wished_of(gap), 2);

        // an own wish gets its own row, that one can be deleted
        insert_missing_reward(&conn, period, "Something I want", None, "wish-key-want").unwrap();
        let mine: i64 = conn
            .query_row("SELECT id FROM rewards WHERE title='Something I want'", [], |r| r.get(0))
            .unwrap();
        set_reward_wished(&conn, mine, 1).unwrap();
        assert_eq!(wished_of(mine), 1);
    }

    #[test]
    fn emptying_a_creator_keeps_the_card() {
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        // manual = 0: a creator from a scan (used to be pruned)
        conn.execute("INSERT INTO artists(name, manual) VALUES('Scanned', 0)", []).unwrap();
        let artist: i64 =
            conn.query_row("SELECT id FROM artists WHERE name='Scanned'", [], |r| r.get(0)).unwrap();
        set_artist_aliases(&conn, artist, r#"["alt name"]"#).unwrap();
        conn.execute(
            "INSERT INTO periods(artist_id, platform, year, month, label, folder_path)
             VALUES(?1, 'Patreon', 2026, 3, '2026-03', '/a/Patreon/2026/03')",
            params![artist],
        )
        .unwrap();
        let period: i64 = conn
            .query_row("SELECT id FROM periods WHERE artist_id=?1", params![artist], |r| r.get(0))
            .unwrap();
        conn.execute(
            "INSERT INTO rewards(period_id, title, folder_path, image_count)
             VALUES(?1, 'Only set', '/a/Patreon/2026/03/Only set', 3)",
            params![period],
        )
        .unwrap();
        let reward: i64 = conn
            .query_row("SELECT id FROM rewards WHERE period_id=?1", params![period], |r| r.get(0))
            .unwrap();

        delete_rewards(&conn, &[reward]).unwrap();

        let artists: i64 =
            conn.query_row("SELECT count(*) FROM artists WHERE id=?1", params![artist], |r| r.get(0))
                .unwrap();
        assert_eq!(artists, 1, "the card survives losing its last reward");
        let aliases: Option<String> = conn
            .query_row("SELECT aliases FROM artists WHERE id=?1", params![artist], |r| r.get(0))
            .unwrap();
        assert_eq!(aliases.as_deref(), Some(r#"["alt name"]"#), "and so does its curation");
        // the empty period still goes
        let periods: i64 =
            conn.query_row("SELECT count(*) FROM periods WHERE id=?1", params![period], |r| r.get(0))
                .unwrap();
        assert_eq!(periods, 0, "an empty period is still tidied away");
    }

    /// release style migration: old no_dates flags fill the new column,
    /// the setters keep both in sync
    #[test]
    fn release_style_backfills_and_stays_in_sync() {
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();

        // fake an old database: only no_dates set
        conn.execute("INSERT INTO artists(name, no_dates) VALUES('Old Dateless', 1)", []).unwrap();
        conn.execute("INSERT INTO artists(name, no_dates) VALUES('Old Monthly', 0)", []).unwrap();
        let dateless_id: i64 = conn
            .query_row("SELECT id FROM artists WHERE name='Old Dateless'", [], |r| r.get(0))
            .unwrap();
        conn.execute(
            "INSERT INTO platform_no_dates(artist_id, platform, no_dates) VALUES(?1, 'Patreon', 1)",
            params![dateless_id],
        )
        .unwrap();
        conn.execute(
            "UPDATE artists SET release_style = NULL; ",
            [],
        )
        .unwrap();
        conn.execute("UPDATE platform_no_dates SET release_style = NULL", []).unwrap();

        // migrate() runs on every open and fills the styles
        migrate(&conn).unwrap();
        let style = |name: &str| -> String {
            conn.query_row("SELECT release_style FROM artists WHERE name=?1", params![name], |r| {
                r.get(0)
            })
            .unwrap()
        };
        assert_eq!(style("Old Dateless"), "none");
        assert_eq!(style("Old Monthly"), "monthly");
        let pstyle: String = conn
            .query_row(
                "SELECT release_style FROM platform_no_dates WHERE artist_id=?1",
                params![dateless_id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(pstyle, "none");

        // setters keep both columns in sync
        set_artist_release_style(&conn, "Old Dateless", "numbered").unwrap();
        let (s, nd): (String, i64) = conn
            .query_row(
                "SELECT release_style, no_dates FROM artists WHERE name='Old Dateless'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!((s.as_str(), nd), ("numbered", 0));
        set_artist_no_dates(&conn, "Old Dateless", true).unwrap(); // legacy API
        let (s, nd): (String, i64) = conn
            .query_row(
                "SELECT release_style, no_dates FROM artists WHERE name='Old Dateless'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!((s.as_str(), nd), ("none", 1));
        set_platform_release_style(&conn, dateless_id, "Patreon", "numbered").unwrap();
        let (s, nd): (String, i64) = conn
            .query_row(
                "SELECT release_style, no_dates FROM platform_no_dates WHERE artist_id=?1",
                params![dateless_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!((s.as_str(), nd), ("numbered", 0));

        // invalid styles are rejected
        assert!(set_artist_release_style(&conn, "Old Dateless", "weekly").is_err());
    }

    /// versions are keyed by path, so they survive a re-index. set/list/revert/delete.
    #[test]
    fn image_versions_survive_reindex_and_roundtrip() {
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        let orig = "C:/lib/Artist/Patreon/2025/01/Reward/01.jpg";

        // no versions at first
        let (v, active) = list_image_versions(&conn, orig).unwrap();
        assert!(v.is_empty() && active.is_none());

        // add two versions, the second is active
        let id1 = add_image_version(&conn, orig, "C:/appdata/versions/1.png", Some("Edited")).unwrap();
        let id2 = add_image_version(&conn, orig, "C:/appdata/versions/2.png", None).unwrap();
        set_active_version(&conn, orig, Some(id2)).unwrap();
        let (v, active) = list_image_versions(&conn, orig).unwrap();
        assert_eq!(v.len(), 2);
        assert_eq!(active, Some(id2));

        // fake a re-index: image rows deleted and recreated, versions must stay
        let (v, active) = list_image_versions(&conn, orig).unwrap();
        assert_eq!(v.len(), 2);
        assert_eq!(active, Some(id2));

        // back to the original
        set_active_version(&conn, orig, None).unwrap();
        assert_eq!(list_image_versions(&conn, orig).unwrap().1, None);

        // deleting a version returns its file, the active row is gone
        set_active_version(&conn, orig, Some(id1)).unwrap();
        let fp = delete_image_version(&conn, id1).unwrap();
        assert_eq!(fp.as_deref(), Some("C:/appdata/versions/1.png"));
        let (v, active) = list_image_versions(&conn, orig).unwrap();
        assert_eq!(v.len(), 1);
        assert!(active.is_none(), "deleting the active version reverts to original");

        // prefix remap keeps versions after a move
        remap_versions_prefix(&conn, "C:/lib/Artist", "D:/moved/Artist").unwrap();
        let moved = "D:/moved/Artist/Patreon/2025/01/Reward/01.jpg";
        assert_eq!(list_image_versions(&conn, moved).unwrap().0.len(), 1);

        // full cleanup removes the rows
        delete_versions_for_orig_paths(&conn, &[moved.to_string()]).unwrap();
        assert!(list_image_versions(&conn, moved).unwrap().0.is_empty());
    }

    /// daily backup goes into backups/, same day doesn't duplicate, only BACKUP_KEEP are
    /// kept
    #[test]
    fn backup_snapshots_daily_and_rotates() {
        let data = std::env::temp_dir().join(format!("micoll_bak_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&data);
        std::fs::create_dir_all(&data).unwrap();

        // no db yet -> nothing happens
        backup_rotate(&data).unwrap();

        std::fs::write(data.join("micoll.db"), b"main").unwrap();
        std::fs::write(data.join("micoll.db-wal"), b"journal").unwrap();
        backup_rotate(&data).unwrap();

        let dir = data.join("backups");
        let snaps: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .filter_map(|e| e.file_name().into_string().ok())
            .collect();
        assert_eq!(snaps.iter().filter(|n| n.ends_with(".db")).count(), 1);
        assert_eq!(snaps.iter().filter(|n| n.ends_with(".db-wal")).count(), 1);

        // same day again -> still one backup
        backup_rotate(&data).unwrap();
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 2);

        // 20 old fake backups -> trimmed to BACKUP_KEEP
        for i in 0..20 {
            std::fs::write(dir.join(format!("micoll-2025{:04}.db", i)), b"old").unwrap();
            std::fs::write(dir.join(format!("micoll-2025{:04}.db-wal", i)), b"old").unwrap();
        }
        backup_rotate(&data).unwrap();
        let dbs: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .filter_map(|e| e.file_name().into_string().ok())
            .filter(|n| n.ends_with(".db"))
            .collect();
        assert_eq!(dbs.len(), BACKUP_KEEP, "kept: {dbs:?}");
        // today's backup must survive
        assert!(dbs.iter().any(|n| !n.starts_with("micoll-2025")));

        let _ = std::fs::remove_dir_all(&data);
    }

    /// opening a db folds the WAL into the main file
    #[test]
    fn open_checkpoints_and_truncates_wal() {
        let data = std::env::temp_dir().join(format!("micoll_ckpt_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&data);
        std::fs::create_dir_all(&data).unwrap();
        let db = data.join("micoll.db");

        // session 1: write something and drop it (the WAL may keep frames)
        {
            let conn = open(&db).unwrap();
            conn.execute("INSERT INTO settings(key, value) VALUES('k','v')", []).unwrap();
        }
        // session 2: open() must checkpoint, the data is in the main file after
        {
            let conn = open(&db).unwrap();
            let v: String = conn
                .query_row("SELECT value FROM settings WHERE key='k'", [], |r| r.get(0))
                .unwrap();
            assert_eq!(v, "v");
            let wal_len = std::fs::metadata(data.join("micoll.db-wal")).map(|m| m.len()).unwrap_or(0);
            assert!(wal_len <= 32, "wal not truncated: {wal_len} bytes");
        }

        let _ = std::fs::remove_dir_all(&data);
    }

    /* ---- collabs ------------------------------------------------------ */

    /// Two creators: Owner with a Patreon 2026-03 reward, Partner (with a Ko-Fi period
    /// unless partner_bare). Returns (owner, partner, reward).
    fn two_creators(conn: &Connection, partner_bare: bool) -> (i64, i64, i64) {
        conn.execute("INSERT INTO artists(name, release_style) VALUES('Owner','monthly')", [])
            .unwrap();
        conn.execute("INSERT INTO artists(name, release_style) VALUES('Partner','monthly')", [])
            .unwrap();
        let owner: i64 = conn
            .query_row("SELECT id FROM artists WHERE name='Owner'", [], |r| r.get(0))
            .unwrap();
        let partner: i64 = conn
            .query_row("SELECT id FROM artists WHERE name='Partner'", [], |r| r.get(0))
            .unwrap();
        conn.execute(
            "INSERT INTO periods(artist_id, platform, year, month, label, folder_path)
             VALUES(?1, 'Patreon', 2026, 3, '2026-03', '/o/Patreon/2026/03')",
            params![owner],
        )
        .unwrap();
        let period: i64 = conn
            .query_row("SELECT id FROM periods WHERE artist_id=?1", params![owner], |r| r.get(0))
            .unwrap();
        conn.execute(
            "INSERT INTO rewards(period_id, title, folder_path, image_count)
             VALUES(?1, 'Beach set', '/o/Patreon/2026/03/Beach set', 4)",
            params![period],
        )
        .unwrap();
        let reward: i64 = conn
            .query_row("SELECT id FROM rewards WHERE period_id=?1", params![period], |r| r.get(0))
            .unwrap();
        if !partner_bare {
            conn.execute(
                "INSERT INTO periods(artist_id, platform, year, month, label, folder_path)
                 VALUES(?1, 'Ko-Fi', 2026, 5, '2026-05', '/p/Ko-Fi/2026/05')",
                params![partner],
            )
            .unwrap();
        }
        (owner, partner, reward)
    }

    fn find<'a>(lib: &'a [Artist], name: &str) -> &'a Artist {
        lib.iter().find(|a| a.name == name).unwrap()
    }

    /// the partner shows the reward, but nothing counts it twice
    #[test]
    fn collab_reward_shows_in_partner_and_is_counted_by_nobody_else() {
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        let (_, partner, reward) = two_creators(&conn, true);

        set_reward_collabs(&conn, reward, &[partner]).unwrap();
        let lib = get_library(&conn).unwrap();

        let p = find(&lib, "Partner");
        assert_eq!(p.periods.len(), 1, "partner gets exactly one (ghost) period");
        assert!(p.periods[0].collab_only);
        assert_eq!(p.periods[0].rewards.len(), 1);
        let ghost = &p.periods[0].rewards[0];
        assert_eq!(ghost.id, reward, "the ghost carries the owner's real reward id");
        assert_eq!(ghost.collab_from.as_ref().unwrap().artist_name, "Owner");

        // the owner's tile only gets the chip
        let o = find(&lib, "Owner");
        let real = &o.periods[0].rewards[0];
        assert!(real.collab_from.is_none());
        assert_eq!(real.collab_with.len(), 1);
        assert_eq!(real.collab_with[0].artist_name, "Partner");

        // nothing duplicated in the DB
        let rewards: i64 = conn.query_row("SELECT COUNT(*) FROM rewards", [], |r| r.get(0)).unwrap();
        let periods: i64 = conn.query_row("SELECT COUNT(*) FROM periods", [], |r| r.get(0)).unwrap();
        assert_eq!((rewards, periods), (1, 1));
    }

    /// if the partner has the same month, the borrowed reward goes into it
    #[test]
    fn collab_lands_in_the_partners_matching_period() {
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        let (_, partner, reward) = two_creators(&conn, true);
        conn.execute(
            "INSERT INTO periods(artist_id, platform, year, month, label, folder_path)
             VALUES(?1, 'Patreon', 2026, 3, '2026-03', '/p/Patreon/2026/03')",
            params![partner],
        )
        .unwrap();
        let pp: i64 = conn
            .query_row(
                "SELECT id FROM periods WHERE artist_id=?1 AND platform='Patreon'",
                params![partner],
                |r| r.get(0),
            )
            .unwrap();
        conn.execute(
            "INSERT INTO rewards(period_id, title, folder_path, image_count)
             VALUES(?1, 'Own set', '/p/Patreon/2026/03/Own set', 2)",
            params![pp],
        )
        .unwrap();

        set_reward_collabs(&conn, reward, &[partner]).unwrap();
        let lib = get_library(&conn).unwrap();
        let p = find(&lib, "Partner");
        assert_eq!(p.periods.len(), 1, "no extra month card");
        assert!(!p.periods[0].collab_only, "it is the partner's own period");
        assert!(p.periods[0].id > 0);
        assert_eq!(p.periods[0].rewards.len(), 2);
        assert_eq!(p.periods[0].rewards.iter().filter(|r| r.collab_from.is_some()).count(), 1);
    }

    /// a fake period id must never hit a real row
    #[test]
    fn collab_period_id_is_negative_and_matches_no_row() {
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        let (_, partner, reward) = two_creators(&conn, true);
        set_reward_collabs(&conn, reward, &[partner]).unwrap();

        let lib = get_library(&conn).unwrap();
        assert!(find(&lib, "Partner").periods[0].id < 0);
        let n: i64 = conn
            .query_row("SELECT COUNT(*) FROM periods WHERE id < 0", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 0, "and no such row exists");
    }

    /// two collabs from one owner month share one ghost month
    #[test]
    fn collabs_from_one_owner_period_share_one_ghost_period() {
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        let (_, partner, reward) = two_creators(&conn, true);
        let period: i64 = conn
            .query_row("SELECT period_id FROM rewards WHERE id=?1", params![reward], |r| r.get(0))
            .unwrap();
        conn.execute(
            "INSERT INTO rewards(period_id, title, folder_path, image_count)
             VALUES(?1, 'Second set', '/o/Patreon/2026/03/Second set', 3)",
            params![period],
        )
        .unwrap();
        let second: i64 = conn
            .query_row(
                "SELECT id FROM rewards WHERE folder_path='/o/Patreon/2026/03/Second set'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        set_reward_collabs(&conn, reward, &[partner]).unwrap();
        set_reward_collabs(&conn, second, &[partner]).unwrap();

        let lib = get_library(&conn).unwrap();
        let p = find(&lib, "Partner");
        assert_eq!(p.periods.len(), 1);
        assert_eq!(p.periods[0].rewards.len(), 2);
    }

    /// a borrowed platform must show up as a tab
    #[test]
    fn collab_creates_the_platform_tab_for_the_partner() {
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        let (_, partner, reward) = two_creators(&conn, false); // partner has only Ko-Fi
        set_reward_collabs(&conn, reward, &[partner]).unwrap();

        let lib = get_library(&conn).unwrap();
        let p = find(&lib, "Partner");
        let names: Vec<&str> = p.platform_styles.iter().map(|s| s.platform.as_str()).collect();
        assert!(names.contains(&"Patreon"), "got {names:?}");
        assert!(names.contains(&"Ko-Fi"), "got {names:?}");
    }

    /// a creator without months gets it in the unscheduled bucket
    #[test]
    fn dateless_partner_gets_the_collab_in_their_unscheduled_bucket() {
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        let (_, partner, reward) = two_creators(&conn, true);
        conn.execute(
            "UPDATE artists SET release_style='none', no_dates=1 WHERE id=?1",
            params![partner],
        )
        .unwrap();
        set_reward_collabs(&conn, reward, &[partner]).unwrap();

        let lib = get_library(&conn).unwrap();
        let ghost = &find(&lib, "Partner").periods[0];
        assert_eq!((ghost.year, ghost.month, ghost.number), (None, None, None));
    }

    /// never a collab with its own creator
    #[test]
    fn self_collab_is_rejected() {
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        let (owner, _, reward) = two_creators(&conn, true);
        set_reward_collabs(&conn, reward, &[owner]).unwrap();

        let n: i64 = conn
            .query_row("SELECT COUNT(*) FROM reward_collabs", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 0);
        let lib = get_library(&conn).unwrap();
        assert_eq!(
            find(&lib, "Owner").periods.iter().map(|p| p.rewards.len()).sum::<usize>(),
            1
        );
    }

    /// deleting the reward removes the link (proves foreign keys are on)
    #[test]
    fn deleting_the_owner_reward_drops_the_link() {
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        let (_, partner, reward) = two_creators(&conn, true);
        set_reward_collabs(&conn, reward, &[partner]).unwrap();

        delete_rewards(&conn, &[reward]).unwrap();
        let n: i64 = conn
            .query_row("SELECT COUNT(*) FROM reward_collabs", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 0);
    }

    /// deleting the partner removes the link, the owner's reward stays
    #[test]
    fn deleting_the_partner_artist_drops_the_link_only() {
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        let (_, partner, reward) = two_creators(&conn, true);
        set_reward_collabs(&conn, reward, &[partner]).unwrap();

        conn.execute("DELETE FROM artists WHERE id=?1", params![partner]).unwrap();
        let links: i64 = conn
            .query_row("SELECT COUNT(*) FROM reward_collabs", [], |r| r.get(0))
            .unwrap();
        let still: i64 = conn
            .query_row("SELECT COUNT(*) FROM rewards WHERE id=?1", params![reward], |r| r.get(0))
            .unwrap();
        assert_eq!((links, still), (0, 1));
    }

    /// the partner's gallery must load too
    #[test]
    fn artist_images_includes_borrowed_rewards() {
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        let (_, partner, reward) = two_creators(&conn, true);
        conn.execute(
            "INSERT INTO images(reward_id, file_path, rel_name, sort)
             VALUES(?1, '/o/Patreon/2026/03/Beach set/1.jpg', '1.jpg', 0)",
            params![reward],
        )
        .unwrap();
        set_reward_collabs(&conn, reward, &[partner]).unwrap();

        let imgs = artist_images(&conn, partner).unwrap();
        assert_eq!(imgs.len(), 1);
        assert_eq!(imgs[0].reward_id, reward);
        assert_eq!(imgs[0].images.len(), 1);
    }

    /// a collection is a path mark like a favourite: follows renames/moves,
    /// shows in the creator page, deleting the group removes nothing else
    #[test]
    fn collection_membership_follows_the_file_and_deletes_cleanly() {
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        let (owner, _, reward) = two_creators(&conn, true);
        let path = "/o/Patreon/2026/03/Beach set/1.jpg";
        conn.execute(
            "INSERT INTO images(reward_id, file_path, rel_name, sort) VALUES(?1, ?2, '1.jpg', 0)",
            params![reward, path],
        )
        .unwrap();
        let image: i64 = conn
            .query_row("SELECT id FROM images WHERE file_path = ?1", params![path], |r| r.get(0))
            .unwrap();

        let cid = create_collection(&conn, "Cosplay").unwrap();
        assert_eq!(list_collections(&conn).unwrap().len(), 1);
        set_image_collection(&conn, cid, path, true).unwrap();

        // on the image row the creator page uses
        let member = |artist: i64| -> Vec<i64> {
            artist_images(&conn, artist).unwrap()[0].images[0].collections.clone()
        };
        assert_eq!(member(owner), vec![cid]);

        // a rename updates the mark
        let renamed = "/o/Patreon/2026/03/Beach set/cover.jpg";
        apply_image_rename(&conn, image, path, renamed, "cover.jpg").unwrap();
        assert_eq!(member(owner), vec![cid]);

        // same for a folder move
        relink_prefix(&conn, "/o/Patreon/2026/03/Beach set", "/o/Patreon/2026/04/Beach set").unwrap();
        assert_eq!(member(owner), vec![cid]);
        let moved: String = conn
            .query_row("SELECT file_path FROM collection_items WHERE collection_id = ?1", params![cid], |r| r.get(0))
            .unwrap();
        assert_eq!(moved, "/o/Patreon/2026/04/Beach set/cover.jpg");

        // deleting the group keeps the image row
        delete_collection(&conn, cid).unwrap();
        assert!(list_collections(&conn).unwrap().is_empty());
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM collection_items", [], |r| r.get::<_, i64>(0)).unwrap(),
            0
        );
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM images", [], |r| r.get::<_, i64>(0)).unwrap(),
            1
        );
        assert!(member(owner).is_empty());
    }

    /// a folder renamed outside MiColl: the link is reported, clearing removes ONLY the
    /// link
    #[test]
    fn broken_collab_is_reported_and_clearable() {
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        let (_, partner, reward) = two_creators(&conn, true);
        set_reward_collabs(&conn, reward, &[partner]).unwrap();

        // the folder from two_creators() doesn't exist on disk
        let broken = broken_collabs(&conn).unwrap();
        assert_eq!(broken.len(), 1);
        assert_eq!(broken[0].title, "Beach set");
        assert_eq!(broken[0].owner_name, "Owner");
        assert_eq!(broken[0].partner_name, "Partner");

        assert_eq!(clear_broken_collabs(&conn).unwrap(), 1);
        let links: i64 = conn
            .query_row("SELECT COUNT(*) FROM reward_collabs", [], |r| r.get(0))
            .unwrap();
        let rewards: i64 = conn.query_row("SELECT COUNT(*) FROM rewards", [], |r| r.get(0)).unwrap();
        assert_eq!((links, rewards), (0, 1), "the reward itself must survive");
    }
}
