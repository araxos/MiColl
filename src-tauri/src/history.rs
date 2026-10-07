//! Activity history: what was deleted, moved, renamed or sent to the Recycle Bin, and
//! when. Answers "where did my files go?" without digging through the Recycle Bin.
//! (Stage 1 of history + undo: only the log.)
//!
//! One row per action: action + kind, the creator, a short place ("Patreon › 2025-08"),
//! what happened to the files, and the items with their old and new paths. Logging never
//! fails an action: errors are only printed. The newest MAX_ROWS rows are kept.

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

/// Rows kept, older ones are dropped when a new one comes in.
pub const MAX_ROWS: i64 = 5000;
/// Items stored per row (a whole creator can be thousands); `count` has the real number.
const MAX_ITEMS: usize = 300;

/// One thing an action touched.
#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    /// Its name now (after a rename: the new one).
    pub name: String,
    /// The name before a rename.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub was: Option<String>,
    /// Where it was.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from: Option<String>,
    /// Where it is now (moves and renames).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub to: Option<String>,
    /// For undo: the reward / image / creator / collection id.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<i64>,
    /// For undo: where it came from (a reward move: the old period; an image move: the
    /// old reward).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub back: Option<i64>,
    /// For undo: where it went (an image move: the new reward).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub into: Option<i64>,
}

impl Item {
    pub fn named(name: impl Into<String>) -> Self {
        Item { name: name.into(), ..Default::default() }
    }
    pub fn at(name: impl Into<String>, from: impl Into<String>) -> Self {
        Item { name: name.into(), from: Some(from.into()), ..Default::default() }
    }
    pub fn moved(name: impl Into<String>, from: impl Into<String>, to: impl Into<String>) -> Self {
        Item { name: name.into(), from: Some(from.into()), to: Some(to.into()), ..Default::default() }
    }
}

/// What happened to the files of a delete.
pub enum Files {
    /// They went to the Recycle Bin.
    Trash,
    /// Only removed from MiColl, the files are where they were.
    Kept,
    /// Not a delete (move, rename).
    None,
}

/// A new history row.
pub struct Entry {
    /// "delete" | "move" | "rename" | "merge" | "trash"
    pub action: &'static str,
    /// "reward" | "image" | "artist" | "period" | "platform" | "version" | "collection" |
    /// "library" | "source"
    pub kind: &'static str,
    pub artist: Option<String>,
    pub place: Option<String>,
    pub files: Files,
    pub items: Vec<Item>,
}

pub fn ensure_table(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS history (
            id      INTEGER PRIMARY KEY,
            at      TEXT NOT NULL DEFAULT (datetime('now')),
            action  TEXT NOT NULL,
            kind    TEXT NOT NULL,
            artist  TEXT,
            place   TEXT,
            files   TEXT,
            count   INTEGER NOT NULL,
            items   TEXT NOT NULL
        );",
    )?;
    // undone = Ctrl+Z (or the button) took it back
    let _ = conn.execute("ALTER TABLE history ADD COLUMN undone INTEGER NOT NULL DEFAULT 0", []);
    // a delete's rows and recycled paths (JSON Snapshot), what undoing it needs
    let _ = conn.execute("ALTER TABLE history ADD COLUMN snapshot TEXT", []);
    Ok(())
}

/// Deletes that keep their snapshot (older ones drop it and can't be undone anymore).
pub const MAX_SNAPSHOTS: i64 = 50;

/// Write a row (nothing when there are no items). Never fails the caller.
pub fn log(conn: &Connection, e: Entry) {
    log_with_snapshot(conn, e, None);
}

/// log, plus what undoing a delete needs.
pub fn log_with_snapshot(conn: &Connection, e: Entry, snap: Option<Snapshot>) {
    if e.items.is_empty() {
        return;
    }
    let snap_json = snap.and_then(|s| serde_json::to_string(&s).ok());
    let count = e.items.len() as i64;
    let mut items = e.items;
    items.truncate(MAX_ITEMS);
    let files = match e.files {
        Files::Trash => Some("trash"),
        Files::Kept => Some("kept"),
        Files::None => None,
    };
    let json = serde_json::to_string(&items).unwrap_or_else(|_| "[]".into());
    let res = conn
        .execute(
            "INSERT INTO history (action, kind, artist, place, files, count, items, snapshot)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![e.action, e.kind, e.artist, e.place, files, count, json, snap_json],
        )
        .and_then(|_| {
            conn.execute(
                "DELETE FROM history WHERE id <= (SELECT MAX(id) FROM history) - ?1",
                params![MAX_ROWS],
            )
        })
        .and_then(|_| {
            conn.execute(
                "UPDATE history SET snapshot = NULL WHERE snapshot IS NOT NULL AND id NOT IN
                   (SELECT id FROM history WHERE snapshot IS NOT NULL ORDER BY id DESC LIMIT ?1)",
                params![MAX_SNAPSHOTS],
            )
        });
    if let Err(err) = res {
        eprintln!("micoll: history not written: {err}");
    }
}

/// A row for the History view.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Row {
    pub id: i64,
    /// UTC, "YYYY-MM-DD HH:MM:SS"
    pub at: String,
    pub action: String,
    pub kind: String,
    pub artist: Option<String>,
    pub place: Option<String>,
    pub files: Option<String>,
    pub count: i64,
    pub items: Vec<Item>,
    /// Already taken back.
    pub undone: bool,
    /// Can be taken back (a rename or a move logged with the ids it needs, a delete
    /// with its snapshot).
    pub undoable: bool,
    /// A delete that kept what undoing it needs.
    #[serde(skip)]
    pub has_snapshot: bool,
}

/// Newest first, `limit` rows older than `before` (an id), or the newest ones.
pub fn list(conn: &Connection, before: Option<i64>, limit: i64) -> rusqlite::Result<Vec<Row>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {COLS} FROM history WHERE ?1 IS NULL OR id < ?1 ORDER BY id DESC LIMIT ?2"
    ))?;
    let rows = stmt.query_map(params![before, limit], read_row)?;
    rows.collect()
}

const COLS: &str =
    "id, at, action, kind, artist, place, files, count, items, undone, snapshot IS NOT NULL";

fn read_row(r: &rusqlite::Row) -> rusqlite::Result<Row> {
    let items: String = r.get(8)?;
    let mut row = Row {
        id: r.get(0)?,
        at: r.get(1)?,
        action: r.get(2)?,
        kind: r.get(3)?,
        artist: r.get(4)?,
        place: r.get(5)?,
        files: r.get(6)?,
        count: r.get(7)?,
        items: serde_json::from_str(&items).unwrap_or_default(),
        undone: r.get::<_, i64>(9)? != 0,
        undoable: false,
        has_snapshot: r.get::<_, i64>(10)? != 0,
    };
    row.undoable = !row.undone && undoable(&row);
    Ok(row)
}

/// A rename or a move that was logged with what undo needs, and has all its items
/// (a capped row can't be taken back as a whole).
pub fn undoable(r: &Row) -> bool {
    if r.action == "delete" {
        return r.has_snapshot;
    }
    if r.items.is_empty() || r.items.len() as i64 != r.count {
        return false;
    }
    let all = |f: &dyn Fn(&Item) -> bool| r.items.iter().all(f);
    match (r.action.as_str(), r.kind.as_str()) {
        ("rename", "reward" | "image" | "artist" | "collection") => all(&|i| i.id.is_some() && i.was.is_some()),
        ("move", "reward") => all(&|i| i.id.is_some() && i.back.is_some() && i.from.is_some() && i.to.is_some()),
        ("move", "image") => all(&|i| i.back.is_some() && i.into.is_some() && i.from.is_some() && i.to.is_some()),
        _ => false,
    }
}

pub fn get(conn: &Connection, id: i64) -> rusqlite::Result<Option<Row>> {
    use rusqlite::OptionalExtension;
    conn.query_row(&format!("SELECT {COLS} FROM history WHERE id = ?1"), params![id], read_row)
        .optional()
}

/// The newest row not taken back yet (Ctrl+Z works on that one only).
pub fn latest_open(conn: &Connection) -> rusqlite::Result<Option<Row>> {
    use rusqlite::OptionalExtension;
    conn.query_row(
        &format!("SELECT {COLS} FROM history WHERE undone = 0 ORDER BY id DESC LIMIT 1"),
        [],
        read_row,
    )
    .optional()
}

pub fn mark_undone(conn: &Connection, id: i64) {
    let _ = conn.execute("UPDATE history SET undone = 1 WHERE id = ?1", params![id]);
}

pub fn clear(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM history", []).map(|_| ())
}

/* ---- snapshots: what a delete removed, so it can come back ---------------- */

/// The rows of one table, each as column -> value.
#[derive(Serialize, Deserialize, Default, Clone)]
pub struct TableRows {
    pub table: String,
    pub rows: Vec<serde_json::Map<String, serde_json::Value>>,
}

/// Everything a delete removed: the rows (read before) and the paths that went to the
/// Recycle Bin, in the order they went.
#[derive(Serialize, Deserialize, Default, Clone)]
pub struct Snapshot {
    pub tables: Vec<TableRows>,
    pub trashed: Vec<String>,
}

impl Snapshot {
    /// Add the rows of `table` matching `where_sql` (read now, before the delete).
    pub fn add(&mut self, conn: &Connection, table: &str, where_sql: &str, args: &[&dyn rusqlite::ToSql]) {
        match dump(conn, table, where_sql, args) {
            Ok(t) if !t.rows.is_empty() => self.tables.push(t),
            Ok(_) => {}
            Err(e) => eprintln!("micoll: snapshot of {table} failed: {e}"),
        }
    }
    fn rows_of<'a>(&'a self, table: &'a str) -> impl Iterator<Item = &'a serde_json::Map<String, serde_json::Value>> {
        self.tables.iter().filter(move |t| t.table == table).flat_map(|t| t.rows.iter())
    }
}

fn dump(conn: &Connection, table: &str, where_sql: &str, args: &[&dyn rusqlite::ToSql]) -> rusqlite::Result<TableRows> {
    let mut stmt = conn.prepare(&format!("SELECT * FROM {table} WHERE {where_sql}"))?;
    let names: Vec<String> = stmt.column_names().iter().map(|c| c.to_string()).collect();
    let mut rows = Vec::new();
    let mut q = stmt.query(args)?;
    while let Some(r) = q.next()? {
        let mut m = serde_json::Map::new();
        for (i, n) in names.iter().enumerate() {
            use rusqlite::types::ValueRef;
            let v = match r.get_ref(i)? {
                ValueRef::Null | ValueRef::Blob(_) => serde_json::Value::Null,
                ValueRef::Integer(x) => serde_json::Value::from(x),
                ValueRef::Real(x) => serde_json::Value::from(x),
                ValueRef::Text(t) => serde_json::Value::from(String::from_utf8_lossy(t).to_string()),
            };
            m.insert(n.clone(), v);
        }
        rows.push(m);
    }
    Ok(TableRows { table: table.to_string(), rows })
}

pub fn get_snapshot(conn: &Connection, id: i64) -> rusqlite::Result<Option<Snapshot>> {
    let s: Option<String> = conn.query_row("SELECT snapshot FROM history WHERE id = ?1", params![id], |r| r.get(0))?;
    Ok(s.and_then(|s| serde_json::from_str(&s).ok()))
}

/// Seconds since 1970 of a row's time (to find its items in the Recycle Bin).
pub fn at_epoch(conn: &Connection, id: i64) -> i64 {
    conn.query_row("SELECT CAST(strftime('%s', at) AS INTEGER) FROM history WHERE id = ?1", params![id], |r| r.get(0))
        .unwrap_or(0)
}

fn to_sql(v: &serde_json::Value) -> rusqlite::types::Value {
    use rusqlite::types::Value;
    match v {
        serde_json::Value::Null => Value::Null,
        serde_json::Value::Bool(b) => Value::Integer(*b as i64),
        serde_json::Value::Number(n) => match n.as_i64() {
            Some(i) => Value::Integer(i),
            None => Value::Real(n.as_f64().unwrap_or(0.0)),
        },
        serde_json::Value::String(s) => Value::Text(s.clone()),
        other => Value::Text(other.to_string()),
    }
}

fn columns_of(conn: &Connection, table: &str) -> rusqlite::Result<Vec<String>> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let cols = stmt.query_map([], |r| r.get::<_, String>(1))?.collect();
    cols
}

fn exists(conn: &Connection, sql: &str, args: &[&dyn rusqlite::ToSql]) -> rusqlite::Result<bool> {
    use rusqlite::OptionalExtension;
    Ok(conn.query_row(sql, args, |_| Ok(())).optional()?.is_some())
}

/// Insert a row with the columns this table has now. drop_id = let SQLite pick the id
/// (the old one is taken). Returns the row's id.
fn insert(conn: &Connection, table: &str, row: &serde_json::Map<String, serde_json::Value>, drop_id: bool, ignore: bool) -> rusqlite::Result<i64> {
    let have = columns_of(conn, table)?;
    let cols: Vec<&String> = row
        .keys()
        .filter(|k| have.contains(k) && !(drop_id && k.as_str() == "id"))
        .collect();
    let marks = (1..=cols.len()).map(|i| format!("?{i}")).collect::<Vec<_>>().join(", ");
    let names = cols.iter().map(|c| format!("\"{c}\"")).collect::<Vec<_>>().join(", ");
    let verb = if ignore { "INSERT OR IGNORE" } else { "INSERT" };
    let values: Vec<rusqlite::types::Value> = cols.iter().map(|c| to_sql(&row[c.as_str()])).collect();
    conn.execute(
        &format!("{verb} INTO {table} ({names}) VALUES ({marks})"),
        rusqlite::params_from_iter(values.iter()),
    )?;
    Ok(conn.last_insert_rowid())
}

fn int(row: &serde_json::Map<String, serde_json::Value>, k: &str) -> Option<i64> {
    row.get(k).and_then(|v| v.as_i64())
}
fn text<'a>(row: &'a serde_json::Map<String, serde_json::Value>, k: &str) -> Option<&'a str> {
    row.get(k).and_then(|v| v.as_str())
}

/// Put a snapshot's rows back. Rows that are still there are kept, an old id that's
/// taken now gets a new one (the children follow). Refuses with "undo:taken:<what>"
/// when something else took its place (a creator with that name, a reward in that
/// folder). Run it inside a transaction: an error leaves half of it.
pub fn restore_rows(conn: &Connection, snap: &Snapshot) -> Result<(), String> {
    use std::collections::HashMap;
    let e = |x: rusqlite::Error| x.to_string();
    let mut artists: HashMap<i64, i64> = HashMap::new();
    let mut periods: HashMap<i64, i64> = HashMap::new();
    let mut rewards: HashMap<i64, i64> = HashMap::new();
    let mut versions: HashMap<i64, i64> = HashMap::new();
    let map = |m: &HashMap<i64, i64>, v: i64| *m.get(&v).unwrap_or(&v);

    for row in snap.rows_of("artists") {
        let (id, name) = (int(row, "id").unwrap_or_default(), text(row, "name").unwrap_or_default());
        let same: Option<i64> = {
            use rusqlite::OptionalExtension;
            conn.query_row("SELECT id FROM artists WHERE name = ?1", params![name], |r| r.get(0))
                .optional()
                .map_err(e)?
        };
        match same {
            Some(cur) if cur == id => {}
            Some(_) => return Err(format!("undo:taken:{name}")),
            None => {
                let taken = exists(conn, "SELECT 1 FROM artists WHERE id = ?1", &[&id]).map_err(e)?;
                let new = insert(conn, "artists", row, taken, false).map_err(e)?;
                artists.insert(id, new);
            }
        }
    }
    for row in snap.rows_of("periods") {
        let id = int(row, "id").unwrap_or_default();
        let key = text(row, "folder_path").unwrap_or_default();
        let same: Option<i64> = {
            use rusqlite::OptionalExtension;
            conn.query_row("SELECT id FROM periods WHERE folder_path = ?1", params![key], |r| r.get(0))
                .optional()
                .map_err(e)?
        };
        if let Some(cur) = same {
            periods.insert(id, cur);
            continue;
        }
        let mut r = row.clone();
        r.insert("artist_id".into(), map(&artists, int(row, "artist_id").unwrap_or_default()).into());
        let taken = exists(conn, "SELECT 1 FROM periods WHERE id = ?1", &[&id]).map_err(e)?;
        periods.insert(id, insert(conn, "periods", &r, taken, false).map_err(e)?);
    }
    for row in snap.rows_of("rewards") {
        let id = int(row, "id").unwrap_or_default();
        let folder = text(row, "folder_path").unwrap_or_default();
        let same: Option<i64> = {
            use rusqlite::OptionalExtension;
            conn.query_row("SELECT id FROM rewards WHERE folder_path = ?1", params![folder], |r| r.get(0))
                .optional()
                .map_err(e)?
        };
        match same {
            Some(cur) if cur == id => {
                rewards.insert(id, id);
                continue;
            }
            Some(_) => return Err(format!("undo:taken:{folder}")),
            None => {}
        }
        let mut r = row.clone();
        r.insert("period_id".into(), map(&periods, int(row, "period_id").unwrap_or_default()).into());
        let taken = exists(conn, "SELECT 1 FROM rewards WHERE id = ?1", &[&id]).map_err(e)?;
        rewards.insert(id, insert(conn, "rewards", &r, taken, false).map_err(e)?);
    }
    for row in snap.rows_of("images") {
        let id = int(row, "id").unwrap_or_default();
        let path = text(row, "file_path").unwrap_or_default();
        if exists(conn, "SELECT 1 FROM images WHERE file_path = ?1", &[&path]).map_err(e)? {
            continue;
        }
        let mut r = row.clone();
        r.insert("reward_id".into(), map(&rewards, int(row, "reward_id").unwrap_or_default()).into());
        let taken = exists(conn, "SELECT 1 FROM images WHERE id = ?1", &[&id]).map_err(e)?;
        insert(conn, "images", &r, taken, false).map_err(e)?;
    }
    for row in snap.rows_of("image_versions") {
        let id = int(row, "id").unwrap_or_default();
        let path = text(row, "file_path").unwrap_or_default();
        let same: Option<i64> = {
            use rusqlite::OptionalExtension;
            conn.query_row("SELECT id FROM image_versions WHERE file_path = ?1", params![path], |r| r.get(0))
                .optional()
                .map_err(e)?
        };
        if let Some(cur) = same {
            versions.insert(id, cur);
            continue;
        }
        let taken = exists(conn, "SELECT 1 FROM image_versions WHERE id = ?1", &[&id]).map_err(e)?;
        versions.insert(id, insert(conn, "image_versions", row, taken, false).map_err(e)?);
    }
    // the rest is keyed by natural keys: put back what isn't there
    for row in snap.rows_of("image_active_version") {
        let mut r = row.clone();
        r.insert("version_id".into(), map(&versions, int(row, "version_id").unwrap_or_default()).into());
        insert(conn, "image_active_version", &r, false, true).map_err(e)?;
    }
    for row in snap.rows_of("reward_collabs") {
        let mut r = row.clone();
        r.insert("reward_id".into(), map(&rewards, int(row, "reward_id").unwrap_or_default()).into());
        r.insert("artist_id".into(), map(&artists, int(row, "artist_id").unwrap_or_default()).into());
        insert(conn, "reward_collabs", &r, false, true).map_err(e)?;
    }
    for table in ["platform_no_dates", "applied_templates", "sd_year_rules"] {
        for row in snap.rows_of(table) {
            let mut r = row.clone();
            r.insert("artist_id".into(), map(&artists, int(row, "artist_id").unwrap_or_default()).into());
            let id = int(row, "id");
            let taken = match id {
                Some(id) => exists(conn, &format!("SELECT 1 FROM {table} WHERE id = ?1"), &[&id]).map_err(e)?,
                None => false,
            };
            insert(conn, table, &r, taken, true).map_err(e)?;
        }
    }
    for row in snap.rows_of("collections") {
        let id = int(row, "id").unwrap_or_default();
        if !exists(conn, "SELECT 1 FROM collections WHERE id = ?1", &[&id]).map_err(e)? {
            insert(conn, "collections", row, false, true).map_err(e)?;
        }
    }
    for table in ["roots", "favorites", "wallpaper_favs", "collection_items"] {
        for row in snap.rows_of(table) {
            let id = int(row, "id");
            let taken = match id {
                Some(id) => exists(conn, &format!("SELECT 1 FROM {table} WHERE id = ?1"), &[&id]).map_err(e)?,
                None => false,
            };
            insert(conn, table, row, taken, true).map_err(e)?;
        }
    }
    // a reward that stayed (one image deleted) gets its count and cover back
    for row in snap.rows_of("rewards") {
        let id = map(&rewards, int(row, "id").unwrap_or_default());
        conn.execute(
            "UPDATE rewards SET image_count = (SELECT COUNT(*) FROM images WHERE reward_id = ?1) WHERE id = ?1",
            params![id],
        )
        .map_err(e)?;
        if let Some(cover) = text(row, "cover_image") {
            if std::path::Path::new(cover).exists() {
                conn.execute("UPDATE rewards SET cover_image = ?2 WHERE id = ?1", params![id, cover]).map_err(e)?;
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn conn() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        ensure_table(&c).unwrap();
        c
    }

    #[test]
    fn logs_lists_newest_first_and_skips_empty() {
        let c = conn();
        log(&c, Entry { action: "delete", kind: "reward", artist: None, place: None, files: Files::Kept, items: vec![] });
        assert!(list(&c, None, 10).unwrap().is_empty(), "nothing touched, nothing logged");
        log(
            &c,
            Entry {
                action: "delete",
                kind: "reward",
                artist: Some("Mira".into()),
                place: Some("Patreon › 2025-08".into()),
                files: Files::Trash,
                items: vec![Item::at("Set", "C:\\a\\Set")],
            },
        );
        log(
            &c,
            Entry {
                action: "rename",
                kind: "image",
                artist: None,
                place: None,
                files: Files::None,
                items: vec![Item { name: "b.png".into(), was: Some("a.png".into()), ..Default::default() }],
            },
        );
        let rows = list(&c, None, 10).unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].action, "rename");
        assert_eq!(rows[0].items[0].was.as_deref(), Some("a.png"));
        assert_eq!(rows[1].files.as_deref(), Some("trash"));
        assert_eq!(rows[1].items[0].from.as_deref(), Some("C:\\a\\Set"));
        // paging: older than the newest
        assert_eq!(list(&c, Some(rows[0].id), 10).unwrap().len(), 1);
    }

    #[test]
    fn only_renames_and_moves_with_their_ids_can_be_undone() {
        let c = conn();
        let renamed = Item { name: "B".into(), was: Some("A".into()), id: Some(7), ..Default::default() };
        log(&c, Entry { action: "rename", kind: "reward", artist: None, place: None, files: Files::None, items: vec![renamed] });
        // an old-style row without ids
        log(&c, Entry { action: "rename", kind: "reward", artist: None, place: None, files: Files::None, items: vec![Item { name: "C".into(), was: Some("D".into()), ..Default::default() }] });
        log(&c, Entry { action: "delete", kind: "reward", artist: None, place: None, files: Files::Trash, items: vec![Item::named("X")] });
        let rows = list(&c, None, 10).unwrap();
        assert!(!rows[0].undoable, "a delete: not in this stage");
        assert!(!rows[1].undoable, "no ids logged");
        assert!(rows[2].undoable);
        assert_eq!(latest_open(&c).unwrap().unwrap().id, rows[0].id);
        mark_undone(&c, rows[0].id);
        assert_eq!(latest_open(&c).unwrap().unwrap().id, rows[1].id);
        assert!(get(&c, rows[0].id).unwrap().unwrap().undone);
    }

    /// a real library schema, a creator with a reward, two images, a favourite and a
    /// version: delete the reward, restore it from the snapshot
    #[test]
    fn a_deleted_reward_comes_back_with_its_images_and_extras() {
        let dir = std::env::temp_dir().join(format!("micoll_hist_snap_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let c = crate::db::open(&dir.join("t.db")).unwrap();
        c.execute("INSERT INTO artists(name) VALUES('Mira')", []).unwrap();
        c.execute("INSERT INTO periods(artist_id, label, folder_path) VALUES(1, 'Misc', 'k1')", []).unwrap();
        c.execute("INSERT INTO rewards(id, period_id, title, folder_path, image_count) VALUES(5, 1, 'Set', 'C:\\x\\Set', 2)", []).unwrap();
        c.execute("INSERT INTO images(reward_id, file_path, rel_name) VALUES(5, 'C:\\x\\Set\\a.png', 'a.png')", []).unwrap();
        c.execute("INSERT INTO images(reward_id, file_path, rel_name) VALUES(5, 'C:\\x\\Set\\b.png', 'b.png')", []).unwrap();
        c.execute("INSERT INTO favorites(file_path) VALUES('C:\\x\\Set\\a.png')", []).unwrap();
        c.execute("INSERT INTO image_versions(id, orig_path, file_path) VALUES(9, 'C:\\x\\Set\\a.png', 'v9.png')", []).unwrap();
        c.execute("INSERT INTO image_active_version(orig_path, version_id) VALUES('C:\\x\\Set\\a.png', 9)", []).unwrap();

        let mut snap = Snapshot::default();
        snap.add(&c, "periods", "id IN (SELECT period_id FROM rewards WHERE id IN (5))", &[]);
        snap.add(&c, "rewards", "id IN (5)", &[]);
        snap.add(&c, "images", "reward_id IN (5)", &[]);
        let paths = "file_path IN (SELECT file_path FROM images WHERE reward_id IN (5))";
        snap.add(&c, "favorites", paths, &[]);
        snap.add(&c, "image_versions", "orig_path IN (SELECT file_path FROM images WHERE reward_id IN (5))", &[]);
        snap.add(&c, "image_active_version", "orig_path IN (SELECT file_path FROM images WHERE reward_id IN (5))", &[]);
        crate::db::delete_rewards(&c, &[5]).unwrap();
        // the period went with it (prune), and a new reward took id 5 meanwhile
        c.execute("INSERT INTO periods(artist_id, label, folder_path) VALUES(1, 'Misc', 'k2')", []).unwrap();
        let p2: i64 = c.query_row("SELECT id FROM periods WHERE folder_path = 'k2'", [], |r| r.get(0)).unwrap();
        c.execute("INSERT INTO rewards(id, period_id, title, folder_path) VALUES(5, ?1, 'Other', 'C:\\y')", [p2]).unwrap();

        let tx = c.unchecked_transaction().unwrap();
        restore_rows(&tx, &snap).unwrap();
        tx.commit().unwrap();
        let (rid, count): (i64, i64) = c
            .query_row("SELECT id, image_count FROM rewards WHERE title = 'Set'", [], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap();
        assert_ne!(rid, 5, "the taken id got a new one");
        assert_eq!(count, 2);
        let imgs: i64 = c.query_row("SELECT COUNT(*) FROM images WHERE reward_id = ?1", [rid], |r| r.get(0)).unwrap();
        assert_eq!(imgs, 2, "the images follow the new id");
        let fav: i64 = c.query_row("SELECT COUNT(*) FROM favorites", [], |r| r.get(0)).unwrap();
        assert_eq!(fav, 1);
        let active: i64 = c.query_row("SELECT version_id FROM image_active_version", [], |r| r.get(0)).unwrap();
        assert_eq!(active, 9, "the active version is back");
        // the other reward with id 5 is untouched
        let other: String = c.query_row("SELECT title FROM rewards WHERE id = 5", [], |r| r.get(0)).unwrap();
        assert_eq!(other, "Other");

        // a reward in that folder now: refused, nothing written
        let tx = c.unchecked_transaction().unwrap();
        c.execute("DELETE FROM rewards WHERE title = 'Set'", []).unwrap();
        c.execute("INSERT INTO rewards(period_id, title, folder_path) VALUES(?1, 'Squatter', 'C:\\x\\Set')", [p2]).unwrap();
        assert!(restore_rows(&tx, &snap).unwrap_err().starts_with("undo:taken:"));
        drop(tx);
        drop(c);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn keeps_only_the_newest_rows_and_caps_items() {
        let c = conn();
        for i in 0..(MAX_ROWS + 5) {
            log(
                &c,
                Entry {
                    action: "move",
                    kind: "image",
                    artist: None,
                    place: None,
                    files: Files::None,
                    items: vec![Item::named(format!("{i}"))],
                },
            );
        }
        let n: i64 = c.query_row("SELECT COUNT(*) FROM history", [], |r| r.get(0)).unwrap();
        assert_eq!(n, MAX_ROWS);
        let many: Vec<Item> = (0..1000).map(|i| Item::named(format!("{i}"))).collect();
        log(&c, Entry { action: "delete", kind: "image", artist: None, place: None, files: Files::Kept, items: many });
        let top = &list(&c, None, 1).unwrap()[0];
        assert_eq!(top.count, 1000, "the real number");
        assert_eq!(top.items.len(), MAX_ITEMS, "but only so many stored");
    }
}
