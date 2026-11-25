//! Wallpaper Hub: desktop slideshows made of pictures from any creator. A slideshow
//! only keeps the files' paths (like favourites and collections), so a picture stays
//! where it is; moves and renames in MiColl carry the paths along (db.rs relink).
//! Windows runs one slideshow at a time, the one MiColl started last is kept in the
//! setting ACTIVE_KEY.

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

pub const ACTIVE_KEY: &str = "wallset_active";

/// The places a slideshow can be for.
pub const PLACES: [&str; 3] = ["desktop", "lock", "saver"];

/// What Windows can show as a wallpaper (the rest is left out when a slideshow starts).
const WALL_EXTS: &[&str] = &["jpg", "jpeg", "jfif", "png", "bmp", "gif", "tif", "tiff", "webp"];

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WallSet {
    pub id: i64,
    pub name: String,
    /// minutes between pictures
    pub minutes: i64,
    /// "fill", "fit" or "stretch"
    pub fit: String,
    pub shuffle: bool,
    pub count: i64,
    /// up to four pictures for the card
    pub preview: Vec<String>,
    /// running on the desktop right now (set by the command)
    pub active: bool,
    /// running on the lock screen (lockscreen.rs, set by the command)
    pub lock: bool,
    /// the screen saver (screensaver.rs, set by the command)
    pub saver: bool,
    /// when it last got pictures (None = never), for the menu's recent ones
    pub last_added: Option<String>,
    /// the places (PLACES) the hub doesn't show it for
    pub hidden_in: Vec<String>,
}

pub fn list(conn: &Connection) -> rusqlite::Result<Vec<WallSet>> {
    let mut stmt = conn.prepare(
        "SELECT s.id, s.name, s.minutes, s.fit, s.shuffle,
                (SELECT COUNT(*) FROM wall_set_items i WHERE i.set_id = s.id), s.last_added, s.hidden_in
         FROM wall_sets s ORDER BY s.sort, s.id",
    )?;
    let mut sets = stmt
        .query_map([], |r| {
            Ok(WallSet {
                id: r.get(0)?,
                name: r.get(1)?,
                minutes: r.get(2)?,
                fit: r.get(3)?,
                shuffle: r.get::<_, i64>(4)? != 0,
                count: r.get(5)?,
                preview: Vec::new(),
                active: false,
                lock: false,
                saver: false,
                last_added: r.get(6)?,
                hidden_in: places(&r.get::<_, String>(7)?),
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut pv = conn.prepare(
        "SELECT file_path FROM wall_set_items WHERE set_id = ?1 ORDER BY sort, rowid LIMIT 4",
    )?;
    for s in &mut sets {
        s.preview = pv
            .query_map(params![s.id], |r| r.get(0))?
            .collect::<rusqlite::Result<Vec<String>>>()?;
    }
    Ok(sets)
}

pub fn create(conn: &Connection, name: &str) -> rusqlite::Result<i64> {
    let sort: i64 = conn.query_row("SELECT COALESCE(MAX(sort), 0) + 1 FROM wall_sets", [], |r| r.get(0))?;
    conn.execute("INSERT INTO wall_sets(name, sort) VALUES(?1, ?2)", params![name.trim(), sort])?;
    Ok(conn.last_insert_rowid())
}

/// Change what's given, leave the rest.
pub fn update(
    conn: &Connection,
    id: i64,
    name: Option<&str>,
    minutes: Option<i64>,
    fit: Option<&str>,
    shuffle: Option<bool>,
) -> rusqlite::Result<()> {
    if let Some(n) = name.map(str::trim).filter(|n| !n.is_empty()) {
        conn.execute("UPDATE wall_sets SET name = ?2 WHERE id = ?1", params![id, n])?;
    }
    if let Some(m) = minutes {
        conn.execute("UPDATE wall_sets SET minutes = ?2 WHERE id = ?1", params![id, m.clamp(1, 1440)])?;
    }
    if let Some(f) = fit.filter(|f| ["fill", "fit", "stretch"].contains(f)) {
        conn.execute("UPDATE wall_sets SET fit = ?2 WHERE id = ?1", params![id, f])?;
    }
    if let Some(s) = shuffle {
        conn.execute("UPDATE wall_sets SET shuffle = ?2 WHERE id = ?1", params![id, s as i64])?;
    }
    Ok(())
}

/// The places in a saved list.
fn places(list: &str) -> Vec<String> {
    PLACES.iter().filter(|p| list.split(',').any(|x| x == **p)).map(|p| p.to_string()).collect()
}

/// Where the hub shows a slideshow. how: "show" or "hide" it for this place, "only" for
/// this one, "all" for every one. It can't be hidden everywhere.
pub fn show_in(conn: &Connection, id: i64, place: &str, how: &str) -> Result<(), String> {
    let err = |e: rusqlite::Error| e.to_string();
    if !PLACES.contains(&place) {
        return Err("unknown place".into());
    }
    let mut hidden: Vec<String> =
        places(&conn.query_row("SELECT hidden_in FROM wall_sets WHERE id = ?1", [id], |r| r.get::<_, String>(0)).map_err(err)?);
    match how {
        "show" => hidden.retain(|p| p != place),
        "hide" if !hidden.iter().any(|p| p == place) => hidden.push(place.to_string()),
        "hide" => {}
        "only" => hidden = PLACES.iter().filter(|p| **p != place).map(|p| p.to_string()).collect(),
        "all" => hidden.clear(),
        _ => return Err("unknown".into()),
    }
    if hidden.len() == PLACES.len() {
        return Err("It has to be shown somewhere.".into());
    }
    conn.execute("UPDATE wall_sets SET hidden_in = ?2 WHERE id = ?1", params![id, hidden.join(",")]).map_err(err)?;
    Ok(())
}

/// The slideshow and its list, never a file.
pub fn delete(conn: &Connection, id: i64) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM wall_set_items WHERE set_id = ?1", params![id])?;
    conn.execute("DELETE FROM wall_sets WHERE id = ?1", params![id])?;
    Ok(())
}

/// The pictures (original paths) in the order they were added.
pub fn items(conn: &Connection, id: i64) -> rusqlite::Result<Vec<String>> {
    let mut stmt = conn.prepare("SELECT file_path FROM wall_set_items WHERE set_id = ?1 ORDER BY sort, rowid")?;
    let out = stmt.query_map(params![id], |r| r.get(0))?.collect();
    out
}

/// The slideshow's pictures as library images (for the viewer), in the slideshow's
/// order. A picture MiColl doesn't know (anymore) is left out, one in two rewards
/// shows once.
pub fn images(conn: &Connection, id: i64) -> rusqlite::Result<Vec<crate::db::FavoriteImage>> {
    let mut stmt = conn.prepare(
        "SELECT p.artist_id, i.reward_id, i.id, i.file_path, i.rel_name,
                (wf.file_path IS NOT NULL) AS fav_wp,
                COALESCE(v.file_path, i.file_path) AS display_path,
                (SELECT COUNT(*) FROM image_versions ivc WHERE ivc.orig_path = i.file_path) AS version_count,
                (av.version_id IS NULL) AS on_original,
                (SELECT GROUP_CONCAT(ci.collection_id)
                   FROM collection_items ci WHERE ci.file_path = i.file_path) AS colls,
                (f.file_path IS NOT NULL) AS fav
         FROM wall_set_items w
         JOIN images  i ON i.file_path = w.file_path
         JOIN rewards r ON r.id = i.reward_id
         JOIN periods p ON p.id = r.period_id
         LEFT JOIN favorites f ON f.file_path = i.file_path
         LEFT JOIN wallpaper_favs wf ON wf.file_path = i.file_path
         LEFT JOIN image_active_version av ON av.orig_path = i.file_path
         LEFT JOIN image_versions       v  ON v.id = av.version_id
         WHERE w.set_id = ?1
         ORDER BY w.sort, w.rowid",
    )?;
    let rows = stmt.query_map(params![id], |r| {
        Ok(crate::db::FavoriteImage {
            artist_id: r.get(0)?,
            reward_id: r.get(1)?,
            image: crate::db::ImageItem {
                id: r.get(2)?,
                file_path: r.get(3)?,
                display_path: r.get(6)?,
                version_count: r.get::<_, i64>(7)?,
                on_original: r.get::<_, i64>(8)? != 0,
                rel_name: r.get::<_, Option<String>>(4)?.unwrap_or_default(),
                fav_wallpaper: r.get::<_, i64>(5)? != 0,
                favorite: r.get::<_, i64>(10)? != 0,
                collections: r
                    .get::<_, Option<String>>(9)?
                    .map(|s| s.split(',').filter_map(|p| p.trim().parse::<i64>().ok()).collect())
                    .unwrap_or_default(),
            },
        })
    })?;
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for row in rows {
        let f = row?;
        if seen.insert(f.image.file_path.clone()) {
            out.push(f);
        }
    }
    Ok(out)
}

/// Add pictures (a picture already in it stays where it is). Returns how many are new.
pub fn add(conn: &Connection, id: i64, paths: &[String]) -> rusqlite::Result<usize> {
    let mut sort: i64 =
        conn.query_row("SELECT COALESCE(MAX(sort), 0) FROM wall_set_items WHERE set_id = ?1", params![id], |r| r.get(0))?;
    let mut added = 0;
    for p in paths {
        sort += 1;
        added += conn.execute(
            "INSERT OR IGNORE INTO wall_set_items(set_id, file_path, sort) VALUES(?1, ?2, ?3)",
            params![id, p, sort],
        )?;
    }
    // even with nothing new: it's the slideshow the user just picked
    conn.execute(
        "UPDATE wall_sets SET last_added = strftime('%Y-%m-%d %H:%M:%f', 'now') WHERE id = ?1",
        params![id],
    )?;
    Ok(added)
}

pub fn remove(conn: &Connection, id: i64, paths: &[String]) -> rusqlite::Result<usize> {
    let mut n = 0;
    for p in paths {
        n += conn.execute("DELETE FROM wall_set_items WHERE set_id = ?1 AND file_path = ?2", params![id, p])?;
    }
    Ok(n)
}

pub fn get(conn: &Connection, id: i64) -> rusqlite::Result<Option<(i64, String, bool)>> {
    conn.query_row("SELECT minutes, fit, shuffle FROM wall_sets WHERE id = ?1", params![id], |r| {
        Ok((r.get(0)?, r.get(1)?, r.get::<_, i64>(2)? != 0))
    })
    .optional()
}

/// The files Windows gets: each picture as it's shown in MiColl (its active edit
/// version, else the original), only ones that exist and Windows can show.
pub fn shown_files(conn: &Connection, id: i64) -> rusqlite::Result<Vec<String>> {
    showable(conn, id, false)
}

/// The same, with `no_nsfw` without the pictures of creators tagged nsfw (the screen saver
/// in SFW mode: it comes by itself).
pub fn showable(conn: &Connection, id: i64, no_nsfw: bool) -> rusqlite::Result<Vec<String>> {
    let mut stmt = conn.prepare(
        "SELECT COALESCE(v.file_path, i.file_path)
         FROM wall_set_items i
         LEFT JOIN image_active_version a ON a.orig_path = i.file_path
         LEFT JOIN image_versions v ON v.id = a.version_id
         WHERE i.set_id = ?1
           AND (?2 = 0 OR NOT EXISTS (
                SELECT 1 FROM images im
                JOIN rewards r ON r.id = im.reward_id
                JOIN periods p ON p.id = r.period_id
                JOIN artists a ON a.id = p.artist_id
                WHERE im.file_path = i.file_path AND LOWER(COALESCE(a.tags, '')) LIKE '%nsfw%'))
         ORDER BY i.sort, i.rowid",
    )?;
    let all = stmt.query_map(params![id, no_nsfw], |r| r.get::<_, String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(all
        .into_iter()
        .filter(|p| {
            let path = std::path::Path::new(p);
            let ext_ok = path
                .extension()
                .and_then(|e| e.to_str())
                .map(|e| WALL_EXTS.contains(&e.to_ascii_lowercase().as_str()))
                .unwrap_or(false);
            ext_ok && path.is_file() && !crate::crypto::file_is_encrypted(path)
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn conn() -> (Connection, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("micoll-wallsets-{}-{:?}", std::process::id(), std::thread::current().id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        (crate::db::open(&dir.join("t.db")).unwrap(), dir)
    }

    #[test]
    fn a_slideshow_keeps_its_pictures_and_settings() {
        let (c, dir) = conn();
        let id = create(&c, "  Cosplay mix ").unwrap();
        assert_eq!(add(&c, id, &["C:\\A\\1.jpg".into(), "D:\\B\\2.png".into()]).unwrap(), 2);
        assert_eq!(add(&c, id, &["C:\\A\\1.jpg".into()]).unwrap(), 0, "no doubles");
        update(&c, id, None, Some(5000), Some("fit"), Some(false)).unwrap();
        update(&c, id, Some("  "), None, Some("tile"), None).unwrap();
        let s = &list(&c).unwrap()[0];
        assert_eq!((s.name.as_str(), s.minutes, s.fit.as_str(), s.shuffle, s.count), ("Cosplay mix", 1440, "fit", false, 2));
        assert_eq!(s.preview, vec!["C:\\A\\1.jpg", "D:\\B\\2.png"]);
        assert!(s.last_added.is_some(), "adding marks it as recently used");
        assert_eq!(remove(&c, id, &["C:\\A\\1.jpg".into()]).unwrap(), 1);
        assert_eq!(items(&c, id).unwrap(), vec!["D:\\B\\2.png"]);
        delete(&c, id).unwrap();
        assert!(list(&c).unwrap().is_empty());
        assert_eq!(c.query_row("SELECT COUNT(*) FROM wall_set_items", [], |r| r.get::<_, i64>(0)).unwrap(), 0);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_slideshow_is_hidden_per_place_but_never_everywhere() {
        let (c, dir) = conn();
        let id = create(&c, "Mix").unwrap();
        let hidden = || list(&c).unwrap()[0].hidden_in.join(",");
        assert_eq!(hidden(), "", "a new one is for every place");
        show_in(&c, id, "lock", "hide").unwrap();
        show_in(&c, id, "lock", "hide").unwrap();
        show_in(&c, id, "desktop", "hide").unwrap();
        assert_eq!(hidden(), "desktop,lock");
        assert!(show_in(&c, id, "saver", "hide").is_err());
        assert_eq!(hidden(), "desktop,lock", "it stays somewhere");
        show_in(&c, id, "desktop", "show").unwrap();
        assert_eq!(hidden(), "lock");
        show_in(&c, id, "lock", "only").unwrap();
        assert_eq!(hidden(), "desktop,saver");
        show_in(&c, id, "lock", "all").unwrap();
        assert_eq!(hidden(), "");
        assert!(show_in(&c, id, "kitchen", "hide").is_err() && show_in(&c, id, "lock", "eat").is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_move_in_micoll_carries_the_paths_along() {
        let (c, dir) = conn();
        let id = create(&c, "Mix").unwrap();
        add(&c, id, &["C:\\Lib\\Ann\\Set\\1.jpg".into()]).unwrap();
        crate::db::relink_prefix(&c, "C:\\Lib\\Ann\\", "C:\\Lib\\Anna\\").unwrap();
        assert_eq!(items(&c, id).unwrap(), vec!["C:\\Lib\\Anna\\Set\\1.jpg"]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn only_existing_showable_files_go_to_windows() {
        let (c, dir) = conn();
        let pic = dir.join("a.jpg");
        let clip = dir.join("b.mp4");
        std::fs::write(&pic, b"x").unwrap();
        std::fs::write(&clip, b"x").unwrap();
        let id = create(&c, "Mix").unwrap();
        let p = |x: &std::path::Path| x.to_string_lossy().into_owned();
        add(&c, id, &[p(&pic), p(&clip), p(&dir.join("gone.png"))]).unwrap();
        assert_eq!(shown_files(&c, id).unwrap(), vec![p(&pic)]);
        // SFW: not the ones of a creator tagged nsfw
        c.execute_batch("INSERT INTO artists(id, name, tags) VALUES(1, 'A', '[\"NSFW \",\"x\"]');
             INSERT INTO periods(id, artist_id, label, folder_path) VALUES(1, 1, 'M', 'k');
             INSERT INTO rewards(id, period_id, title, folder_path, image_count) VALUES(1, 1, 'R', 'f', 1);")
            .unwrap();
        c.execute("INSERT INTO images(reward_id, file_path) VALUES(1, ?1)", params![p(&pic)]).unwrap();
        assert!(showable(&c, id, true).unwrap().is_empty());
        assert_eq!(showable(&c, id, false).unwrap(), vec![p(&pic)]);
        c.execute("UPDATE artists SET tags = '[\"sfw\"]'", []).unwrap();
        assert_eq!(showable(&c, id, true).unwrap(), vec![p(&pic)]);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
