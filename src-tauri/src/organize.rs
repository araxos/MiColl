//! Optional "managed library" mode (off by default).
//! When on, "Organize now" MOVES each reward folder into a clean structure:
//!     <collection>/<Artist>/<Platform>/<Period>/[<Category>/]<Reward>/<files>
//! Works across disks. The DB is updated in place so ids and status stay.
//! Empty old folders are left behind. This is the only feature that writes into content
//! folders.

use crate::indexer;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct OrganizeSummary {
    pub moved: i64,
    pub skipped: i64,
    pub failed: i64,
    pub errors: Vec<String>,
}

/// How a move ended (when it worked well enough).
#[derive(PartialEq, Debug)]
enum Moved {
    /// The folder is at the destination and nowhere else.
    Clean,
    /// All files arrived, but the source folder couldn't be removed (a file was open).
    /// Nothing is missing, there's just a duplicate to clean up.
    LeftBehind,
}

/// Replace characters that aren't allowed in Windows paths.
fn sanitize(s: &str) -> String {
    let cleaned: String = s
        .chars()
        .map(|c| {
            if "<>:\"/\\|?*".contains(c) || (c as u32) < 32 {
                '_'
            } else {
                c
            }
        })
        .collect();
    let trimmed = cleaned.trim_matches(|c| c == ' ' || c == '.').to_string();
    if trimmed.is_empty() {
        "_".to_string()
    } else {
        trimmed
    }
}

/// Lowercase, normalized key for a path. Windows is case-insensitive ("misc" and
/// "Misc" are the same folder), but Path == is not. Without this copy_dir could copy
/// into the folder it creates (the misc/misc/misc... bug that froze imports).
fn ci_key(p: &Path) -> String {
    p.to_string_lossy().replace('/', "\\").trim_end_matches('\\').to_lowercase()
}

/// True if inner is base or inside it (case-insensitive, see ci_key).
fn is_same_or_under(inner: &Path, base: &Path) -> bool {
    let a = ci_key(inner);
    let b = ci_key(base);
    a == b || a.starts_with(&format!("{b}\\"))
}

/// Copy a folder tree (when rename can't cross disks).
/// Skips dst if it's inside src, otherwise it would copy forever.
fn copy_dir(src: &Path, dst: &Path) -> std::io::Result<()> {
    for entry in WalkDir::new(src)
        .into_iter()
        .filter_entry(|e| !is_same_or_under(e.path(), dst))
    {
        let entry = entry.map_err(std::io::Error::other)?;
        let rel = entry
            .path()
            .strip_prefix(src)
            .map_err(std::io::Error::other)?;
        let target = dst.join(rel);
        if entry.file_type().is_dir() {
            std::fs::create_dir_all(&target)?;
        } else {
            if let Some(parent) = target.parent() {
                std::fs::create_dir_all(parent)?;
            }
            std::fs::copy(entry.path(), &target)?;
        }
    }
    Ok(())
}

/// Move a folder, copy + delete across disks.
/// If the copy worked but the source can't be deleted, it's still a successful move
/// (returns Moved), otherwise the DB would keep pointing at the old copy.
fn move_dir(src: &Path, dst: &Path) -> std::io::Result<Moved> {
    // destination = source (maybe only different case), nothing to move
    // (it would copy onto itself forever)
    if ci_key(src) == ci_key(dst) {
        return Ok(Moved::Clean);
    }
    // never move a folder into itself
    if is_same_or_under(dst, src) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "destination is nested inside the source folder",
        ));
    }
    if let Some(parent) = dst.parent() {
        std::fs::create_dir_all(parent)?;
    }
    if std::fs::rename(src, dst).is_ok() {
        return Ok(Moved::Clean);
    }
    // rename failed (other disk, or a file is open). copy_dir fails on any error,
    // so after this line all files are at the destination
    copy_dir(src, dst)?;
    let _ = std::fs::remove_dir_all(src);
    // ask the filesystem if anything is still there (a delete can stop half way)
    Ok(if src.exists() { Moved::LeftBehind } else { Moved::Clean })
}

struct Row {
    reward_id: i64,
    folder: String,
    title: String,
    category: Option<String>,
    cover: Option<String>,
    year: Option<i64>,
    month: Option<i64>,
    number: Option<i64>,
    platform: Option<String>,
    artist: String,
    /// Release style of this reward's platform: "monthly" | "numbered" | "none".
    style: String,
    is_root: bool,
    /// The creator is in the graveyard -> filed under MiColl\🪦 Graveyard.
    graveyard: bool,
}

/// Remove empty folders going up from start, stops at stop (never removed).
/// remove_dir only removes empty folders, errors just stop the walk.
fn prune_empty_up(start: &Path, stop: &Path) {
    let mut cur = start.to_path_buf();
    while cur.starts_with(stop) && cur != stop {
        if std::fs::remove_dir(&cur).is_err() {
            break;
        }
        match cur.parent() {
            Some(p) => cur = p.to_path_buf(),
            None => break,
        }
    }
}

/// Move every reward (with files on disk) into the managed collection and update the DB.
pub fn organize_collection(
    conn: &Connection,
    collection_root: &str,
) -> Result<OrganizeSummary, String> {
    let root = Path::new(collection_root);
    std::fs::create_dir_all(root).map_err(|e| format!("create collection root: {e}"))?;

    // read the rows first (so the statement is done before we change things)
    let rows: Vec<Row> = {
        let mut stmt = conn
            .prepare(
                "SELECT r.id, r.folder_path, r.title, r.category, r.cover_image,
                        p.year, p.month, p.number, p.platform, a.name,
                        COALESCE(
                            pnd.release_style,
                            CASE WHEN pnd.no_dates = 1 THEN 'none' END,
                            a.release_style,
                            CASE WHEN a.no_dates = 1 THEN 'none' ELSE 'monthly' END
                        ) AS style,
                        r.is_root, a.graveyard
                 FROM rewards r
                 JOIN periods p ON r.period_id = p.id
                 JOIN artists a ON p.artist_id = a.id
                 LEFT JOIN platform_no_dates pnd
                        ON pnd.artist_id = a.id
                       AND pnd.platform = COALESCE(p.platform, 'Unsorted')
                 WHERE r.image_count > 0 AND r.sd_volume IS NULL",
            )
            .map_err(|e| e.to_string())?;
        let mapped = stmt
            .query_map([], |r| {
                Ok(Row {
                    reward_id: r.get(0)?,
                    folder: r.get(1)?,
                    title: r.get(2)?,
                    category: r.get(3)?,
                    cover: r.get(4)?,
                    year: r.get(5)?,
                    month: r.get(6)?,
                    number: r.get(7)?,
                    platform: r.get(8)?,
                    artist: r.get(9)?,
                    style: r.get(10)?,
                    is_root: r.get::<_, i64>(11)? != 0,
                    graveyard: r.get::<_, i64>(12)? != 0,
                })
            })
            .map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        for row in mapped {
            out.push(row.map_err(|e| e.to_string())?);
        }
        out
    };

    let mut sum = OrganizeSummary::default();

    let managed_root = root.join("MiColl");

    for row in rows {
        let old = PathBuf::from(&row.folder);
        if !old.is_dir() {
            sum.skipped += 1;
            continue;
        }

        // <collectionRoot>/MiColl/Artist/Platform/[Year/MM/ | Misc/ |
        // #NN/][Category/]Reward
        // style "none" = no period folder, numbered = "#51" folder (rewards without
        // a number go directly under the platform)
        let platform = row.platform.as_deref().unwrap_or("Unsorted");
        // graveyard creators stay in the graveyard
        let shelf = if row.graveyard {
            managed_root.join(indexer::GRAVEYARD_DIR)
        } else {
            managed_root.clone()
        };
        let mut period_dir = shelf.join(sanitize(&row.artist)).join(sanitize(platform));
        if let Some(n) = row.number {
            period_dir = period_dir.join(indexer::fmt_number_label(n));
        } else if row.style == "monthly" {
            period_dir = match row.year {
                Some(y) => period_dir.join(y.to_string()),
                None => period_dir.join("Misc"),
            };
            if let Some(m) = row.month {
                period_dir = period_dir.join(format!("{:02}", m));
            }
        }
        // a root reward has no subfolder, its files are in the month folder
        let mut reward_dir = period_dir.clone();
        if !row.is_root {
            if let Some(cat) = &row.category {
                reward_dir = reward_dir.join(sanitize(cat));
            }
            reward_dir = reward_dir.join(sanitize(&row.title));
        }

        // already in the right place -> skip (case-insensitive)
        if ci_key(&old) == ci_key(&reward_dir) {
            sum.skipped += 1;
            continue;
        }
        // target is inside the current folder -> skip (would copy forever)
        if is_same_or_under(&reward_dir, &old) {
            sum.skipped += 1;
            continue;
        }
        // another reward already has that folder (same name in the same month).
        // moving would merge the files and then fail the UNIQUE index, so skip it
        let taken: Option<i64> = conn
            .query_row(
                "SELECT id FROM rewards WHERE folder_path = ?1 COLLATE NOCASE AND id <> ?2",
                params![reward_dir.to_string_lossy(), row.reward_id],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        if taken.is_some() {
            sum.skipped += 1;
            if sum.errors.len() < 10 {
                sum.errors.push(format!(
                    "{}: another reward already uses that folder — renamed one of them and \
                     re-run Organize",
                    row.title
                ));
            }
            continue;
        }

        // remember the old parent to clean up empty folders later
        let vacated_parent = if old.starts_with(&managed_root) {
            old.parent().map(|p| p.to_path_buf())
        } else {
            None
        };

        let outcome = match move_dir(&old, &reward_dir) {
            Ok(m) => m,
            Err(e) => {
                sum.failed += 1;
                if sum.errors.len() < 10 {
                    sum.errors.push(format!("{}: {}", row.title, e));
                }
                continue;
            }
        };
        // files left behind isn't a failure, the DB points at the new files.
        // the user gets the folder name to delete it themselves
        if outcome == Moved::LeftBehind && sum.errors.len() < 10 {
            sum.errors.push(format!(
                "{}: filed into the collection, but the original folder at {} could not be \
                 removed — something still had a file in it open. Delete it yourself once \
                 nothing is using it.",
                row.title,
                old.display()
            ));
        }

        // reward folder + cover
        let new_cover = row.cover.as_ref().and_then(|c| {
            Path::new(c)
                .strip_prefix(&old)
                .ok()
                .map(|rel| reward_dir.join(rel).to_string_lossy().to_string())
        });
        conn.execute(
            "UPDATE rewards SET folder_path = ?1, cover_image = ?2 WHERE id = ?3",
            params![reward_dir.to_string_lossy(), new_cover, row.reward_id],
        )
        .map_err(|e| e.to_string())?;

        // images: rebuild each path under the new folder
        let imgs: Vec<(i64, String)> = {
            let mut stmt = conn
                .prepare("SELECT id, rel_name FROM images WHERE reward_id = ?1")
                .map_err(|e| e.to_string())?;
            let mapped = stmt
                .query_map(params![row.reward_id], |r| {
                    Ok((r.get::<_, i64>(0)?, r.get::<_, Option<String>>(1)?.unwrap_or_default()))
                })
                .map_err(|e| e.to_string())?;
            let mut out = Vec::new();
            for m in mapped {
                out.push(m.map_err(|e| e.to_string())?);
            }
            out
        };
        for (img_id, rel) in imgs {
            let np = reward_dir.join(&rel);
            conn.execute(
                "UPDATE images SET file_path = ?1 WHERE id = ?2",
                params![np.to_string_lossy(), img_id],
            )
            .map_err(|e| e.to_string())?;
        }

        // clean up empty old folders inside the collection
        if let Some(parent) = vacated_parent {
            prune_empty_up(&parent, &managed_root);
        }

        sum.moved += 1;
    }

    Ok(sum)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{db, indexer};

    fn touch(p: &Path) {
        if let Some(parent) = p.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(p, b"not-a-real-image").unwrap();
    }

    #[test]
    fn case_only_difference_is_treated_as_same_folder() {
        // ".../misc" and ".../Misc" are the same folder on Windows, the guards must see
        // that
        let a = Path::new(r"E:\Coll\MiColl\somecreator\OnlyFans\misc");
        let b = Path::new(r"E:\Coll\MiColl\somecreator\OnlyFans\Misc");
        assert_eq!(ci_key(a), ci_key(b));
        assert!(is_same_or_under(b, a)); // "same" counts as same-or-under
        // case-only difference = no-op, not a self copy
        assert!(move_dir(a, b).is_ok());
        // a real child is still detected as nested
        let child = Path::new(r"E:\Coll\MiColl\somecreator\OnlyFans\misc\sub");
        assert!(is_same_or_under(child, a));
        // a sibling is neither
        let sib = Path::new(r"E:\Coll\MiColl\somecreator\OnlyFans\other");
        assert!(!is_same_or_under(sib, a));
    }

    #[test]
    fn organizes_into_managed_hierarchy() {
        let base = std::env::temp_dir().join(format!("micoll_org_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let src = base.join("src");
        let coll = base.join("collection");

        // ArtistX_2025-01 / 2025-01 / RewardA(2 imgs), Extra/RewardB(1 img)
        let month = src.join("ArtistX_2025-01").join("2025-01");
        touch(&month.join("RewardA").join("01.jpg"));
        touch(&month.join("RewardA").join("02.jpg"));
        touch(&month.join("Extra").join("RewardB").join("01.jpg"));

        let dbfile = base.join("t.db");
        let conn = db::open(&dbfile).unwrap();
        let root = db::Root {
            id: 1,
            path: src.to_string_lossy().to_string(),
            label: None,
            default_platform: Some("Patreon".into()),
        };
        indexer::scan_root(&conn, &root).unwrap();

        let summary = organize_collection(&conn, &coll.to_string_lossy()).unwrap();
        assert_eq!(summary.moved, 2, "errors: {:?}", summary.errors);

        // files are now under MiColl/Artist/Platform/Year/MM/[Category]/Reward ...
        assert!(coll
            .join("MiColl/ArtistX/Patreon/2025/01/RewardA/01.jpg")
            .exists());
        assert!(coll
            .join("MiColl/ArtistX/Patreon/2025/01/Extra/RewardB/01.jpg")
            .exists());
        // ...and the originals are gone
        assert!(!month.join("RewardA").exists());

        // DB points at the new places
        let lib = db::get_library(&conn).unwrap();
        let a = lib.iter().find(|a| a.name == "ArtistX").unwrap();
        let rew = &a.periods[0].rewards;
        assert!(rew.iter().all(|r| r.folder_path.contains("collection")));
        assert!(rew
            .iter()
            .flat_map(|r| &r.images)
            .all(|im| im.file_path.contains("collection")));

        let _ = std::fs::remove_dir_all(&base);
    }

    /// a copy that fully arrived used to count as a failed move, so the DB kept the old
    /// path.
    /// Windows only: a file is held open without DELETE sharing (like Explorer's preview
    /// does)
    #[cfg(windows)]
    #[test]
    fn a_source_that_wont_delete_is_still_a_move() {
        use std::os::windows::fs::OpenOptionsExt;
        const FILE_SHARE_READ: u32 = 0x0000_0001;

        let base = std::env::temp_dir().join(format!("micoll_left_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);

        // a normal move first
        let src = base.join("clean");
        touch(&src.join("01.jpg"));
        assert_eq!(move_dir(&src, &base.join("filed")).unwrap(), Moved::Clean);
        assert!(!src.exists(), "the source is gone");

        // now one that can't be deleted, into an existing non-empty folder (forces the copy
        // path)
        let src = base.join("stuck");
        let dst = base.join("filed2");
        touch(&src.join("01.jpg"));
        touch(&dst.join("something else.txt"));
        let held = std::fs::OpenOptions::new()
            .read(true)
            .share_mode(FILE_SHARE_READ)
            .open(src.join("01.jpg"))
            .unwrap();

        let outcome = move_dir(&src, &dst).unwrap();
        assert_eq!(outcome, Moved::LeftBehind, "reported, not swallowed");
        assert!(dst.join("01.jpg").is_file(), "but the file DID arrive");
        assert!(src.join("01.jpg").is_file(), "and the original is still there");

        drop(held);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn move_dir_refuses_nested_destination() {
        // moving a folder into itself must fail fast, not copy forever. Files stay.
        let base = std::env::temp_dir().join(format!("micoll_nest_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let src = base.join("Misc");
        touch(&src.join("01.jpg"));
        touch(&src.join("02.jpg"));

        let dst = src.join("Misc"); // destination nested inside the source
        let err = move_dir(&src, &dst);
        assert!(err.is_err(), "expected nested-destination move to be refused");
        // no runaway: the source still has its two files
        assert!(src.join("01.jpg").exists());
        assert!(!dst.exists());

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn a_taken_destination_folder_is_skipped_not_merged() {
        // a reward with a name that already exists in the month used to stop the whole
        // organize.
        // Now it's skipped with a reason and both folders stay untouched.
        let base = std::env::temp_dir().join(format!("micoll_taken_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let src = base.join("src");
        let coll = base.join("collection");

        // one creator, one month, two rewards + a second "Wallpaper" from somewhere else
        let month = src.join("ArtistX").join("Patreon").join("2026-03");
        touch(&month.join("Wallpaper").join("01.jpg"));
        touch(&month.join("Sketches").join("01.jpg"));

        let conn = db::open(&base.join("t.db")).unwrap();
        let root = db::Root {
            id: 1,
            path: src.to_string_lossy().to_string(),
            label: None,
            default_platform: Some("Patreon".into()),
        };
        indexer::scan_root(&conn, &root).unwrap();
        organize_collection(&conn, &coll.to_string_lossy()).unwrap();
        let settled = coll.join("MiColl/ArtistX/Patreon/2026/03/Wallpaper");
        assert!(settled.join("01.jpg").exists());

        // the second "Wallpaper" wants the same place
        let incoming = base.join("incoming").join("Wallpaper");
        touch(&incoming.join("99.jpg"));
        let period_id = conn
            .query_row("SELECT id FROM periods LIMIT 1", [], |r| r.get::<_, i64>(0))
            .unwrap();
        conn.execute(
            "INSERT INTO rewards(period_id, title, folder_path, image_count)
             VALUES(?1, 'Wallpaper', ?2, 1)",
            params![period_id, incoming.to_string_lossy()],
        )
        .unwrap();

        let s = organize_collection(&conn, &coll.to_string_lossy()).unwrap();
        // the run finished, the clash was skipped
        assert_eq!(s.failed, 0, "errors: {:?}", s.errors);
        assert!(
            s.errors.iter().any(|e| e.contains("another reward already uses that folder")),
            "the skip must say why: {:?}",
            s.errors
        );
        // neither side was touched
        assert!(!settled.join("99.jpg").exists());
        assert!(incoming.join("99.jpg").exists());

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn no_dates_artist_skips_misc() {
        let base = std::env::temp_dir().join(format!("micoll_nodates_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let src = base.join("src");
        let coll = base.join("collection");

        // Nora posts without dates: rewards directly under the platform
        touch(&src.join("Nora").join("Patreon").join("HD Pack 12").join("01.jpg"));

        let conn = db::open(&base.join("t.db")).unwrap();
        let root = db::Root {
            id: 1,
            path: src.to_string_lossy().to_string(),
            label: None,
            default_platform: Some("Patreon".into()),
        };
        indexer::scan_root(&conn, &root).unwrap();
        db::set_artist_no_dates(&conn, "Nora", true).unwrap();

        let s = organize_collection(&conn, &coll.to_string_lossy()).unwrap();
        assert_eq!(s.moved, 1, "errors: {:?}", s.errors);
        // directly under the platform, no "Misc"
        assert!(coll.join("MiColl/Nora/Patreon/HD Pack 12/01.jpg").exists());
        assert!(!coll.join("MiColl/Nora/Patreon/Misc").exists());

        // organizing again does nothing
        let s2 = organize_collection(&conn, &coll.to_string_lossy()).unwrap();
        assert_eq!(s2.moved, 0);
        assert_eq!(s2.skipped, 1);

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn numbered_artist_gets_drop_folders_and_rescan_roundtrips() {
        let base = std::env::temp_dir().join(format!("micoll_numbered_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let src = base.join("src");
        let coll = base.join("collection");

        // Nora releases numbered drops: 86 has a named reward, 87 is loose files
        touch(&src.join("Nora").join("Patreon").join("86").join("HD Pack").join("01.jpg"));
        touch(&src.join("Nora").join("Patreon").join("87").join("01.jpg"));

        let conn = db::open(&base.join("t.db")).unwrap();
        let root = db::Root {
            id: 1,
            path: src.to_string_lossy().to_string(),
            label: None,
            default_platform: Some("Patreon".into()),
        };
        indexer::scan_root(&conn, &root).unwrap();
        db::set_artist_release_style(&conn, "Nora", "numbered").unwrap();

        // both drops are periods "#86"/"#87"
        let periods_of = |conn: &Connection| {
            let lib = db::get_library(conn).unwrap();
            let a = lib.into_iter().find(|a| a.name == "Nora").unwrap();
            let mut ps: Vec<(String, Option<i64>, String)> = a
                .periods
                .iter()
                .map(|p| (p.label.clone(), p.number, p.folder_path.clone()))
                .collect();
            ps.sort();
            ps
        };
        let before = periods_of(&conn);
        assert_eq!(before.len(), 2, "periods: {before:?}");
        assert!(before.iter().any(|(l, n, _)| l == "#86" && *n == Some(86)));
        assert!(before.iter().any(|(l, n, _)| l == "#87" && *n == Some(87)));

        // organize writes the "#NN" folders
        let s = organize_collection(&conn, &coll.to_string_lossy()).unwrap();
        assert_eq!(s.moved, 2, "errors: {:?}", s.errors);
        assert!(coll.join("MiColl/Nora/Patreon/#86/HD Pack/01.jpg").exists());
        assert!(coll.join("MiColl/Nora/Patreon/#87/01.jpg").exists());
        assert!(!coll.join("MiColl/Nora/Patreon/Misc").exists());

        // organizing again does nothing
        let s2 = organize_collection(&conn, &coll.to_string_lossy()).unwrap();
        assert_eq!(s2.moved, 0);

        // rescanning the managed tree (F5) must give the exact same periods, no duplicates
        let managed_root = db::Root {
            id: 2,
            path: coll.join("MiColl").to_string_lossy().to_string(),
            label: None,
            default_platform: None,
        };
        indexer::scan_root(&conn, &managed_root).unwrap();
        let after = periods_of(&conn);
        assert_eq!(before, after, "rescan must not duplicate or relabel drop periods");

        let _ = std::fs::remove_dir_all(&base);
    }
}
