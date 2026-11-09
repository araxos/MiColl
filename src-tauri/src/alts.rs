//! A reward's alternatives ("Alts"): other versions of the same release, kept as zips in
//! the reward's `_Alts` folder. They travel with the folder (moves, MiSD, delete) and
//! never count as the reward's files: the indexer and the phone bridge skip the folder.

use std::io::Write;
use std::path::{Path, PathBuf};

use crate::crypto;
pub use crate::indexer::ALTS_DIR;

#[derive(serde::Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Alt {
    pub name: String,
    pub path: String,
    pub size: u64,
}

pub fn dir_of(reward_dir: &Path) -> PathBuf {
    reward_dir.join(ALTS_DIR)
}

pub fn is_zip(p: &Path) -> bool {
    p.extension().map(|e| e.eq_ignore_ascii_case("zip")).unwrap_or(false)
}

/// The zips in a reward's `_Alts`, by name.
pub fn list(reward_dir: &Path) -> Vec<Alt> {
    let Ok(rd) = std::fs::read_dir(dir_of(reward_dir)) else { return Vec::new() };
    let mut out: Vec<Alt> = rd
        .flatten()
        .filter_map(|e| {
            let p = e.path();
            let meta = e.metadata().ok()?;
            (meta.is_file() && is_zip(&p)).then(|| Alt {
                name: e.file_name().to_string_lossy().into_owned(),
                path: p.to_string_lossy().into_owned(),
                size: meta.len(),
            })
        })
        .collect();
    out.sort_by_key(|a| a.name.to_lowercase());
    out
}

/// A free `<stem>.zip` in dir: " (2)", " (3)"... when taken.
pub fn free_name(dir: &Path, stem: &str) -> PathBuf {
    let stem = if stem.trim().is_empty() { "Alt" } else { stem.trim() };
    let mut n = 1;
    loop {
        let name = if n == 1 { format!("{stem}.zip") } else { format!("{stem} ({n}).zip") };
        let p = dir.join(name);
        // a half-written zip of the same name counts as taken too
        if !p.exists() && !part_of(&p).exists() {
            return p;
        }
        n += 1;
    }
}

/// Where a zip is written before it gets its name: a crash leaves no half zip behind
/// under a real name.
fn part_of(dest: &Path) -> PathBuf {
    let mut s = dest.as_os_str().to_owned();
    s.push(".part");
    PathBuf::from(s)
}

/// Pack a folder into the zip `dest` (stored: pictures and videos are compressed already).
/// Encrypted files go in decrypted, so the zip opens anywhere. progress(done, total).
pub fn zip_folder(
    src: &Path,
    dest: &Path,
    key: Option<[u8; 32]>,
    progress: &mut dyn FnMut(u64, u64),
) -> Result<(), String> {
    let mut files = Vec::new();
    let mut dirs = Vec::new();
    for e in walkdir::WalkDir::new(src).follow_links(false).sort_by_file_name() {
        let e = e.map_err(|e| e.to_string())?;
        let rel = e.path().strip_prefix(src).map_err(|e| e.to_string())?;
        if rel.as_os_str().is_empty() {
            continue;
        }
        let name = rel.to_string_lossy().replace('\\', "/");
        if e.file_type().is_dir() {
            dirs.push(name);
        } else if e.file_type().is_file() {
            files.push((e.into_path(), name));
        }
    }
    let total = files.len() as u64;
    let temp = part_of(dest);
    let mut write = || -> Result<(), String> {
        let out = std::fs::File::create(&temp).map_err(|e| format!("{}: {e}", temp.display()))?;
        let mut zip = zip::ZipWriter::new(std::io::BufWriter::new(out));
        let base = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Stored);
        for d in &dirs {
            zip.add_directory(d.as_str(), base).map_err(|e| e.to_string())?;
        }
        for (i, (p, name)) in files.iter().enumerate() {
            let len = std::fs::metadata(p).map(|m| m.len()).unwrap_or(0);
            zip.start_file(name.as_str(), base.large_file(len >= 0xFFFF_0000))
                .map_err(|e| e.to_string())?;
            if crypto::file_is_encrypted(p) {
                let k = key.ok_or_else(|| format!("{} is encrypted, unlock MiColl first", p.display()))?;
                let data = crypto::read_plaintext(&crypto::Dek::from_bytes(k), p)?;
                zip.write_all(&data).map_err(|e| e.to_string())?;
            } else {
                let mut f = std::fs::File::open(p).map_err(|e| format!("{}: {e}", p.display()))?;
                std::io::copy(&mut f, &mut zip).map_err(|e| format!("{}: {e}", p.display()))?;
            }
            progress(i as u64 + 1, total);
        }
        let mut w = zip.finish().map_err(|e| e.to_string())?;
        w.flush().map_err(|e| e.to_string())?;
        drop(w);
        std::fs::rename(&temp, dest).map_err(|e| e.to_string())
    };
    write().inspect_err(|_| {
        let _ = std::fs::remove_file(&temp);
    })
}

/// Move a zip to dest (copy + check + delete across disks). Ok(Some(note)) when the copy
/// arrived but the original couldn't be removed.
pub fn move_zip(src: &Path, dest: &Path) -> Result<Option<String>, String> {
    if std::fs::rename(src, dest).is_ok() {
        return Ok(None);
    }
    let temp = part_of(dest);
    let len = std::fs::metadata(src).map_err(|e| format!("{}: {e}", src.display()))?.len();
    let copied = std::fs::copy(src, &temp).map_err(|e| format!("{}: {e}", src.display()));
    match copied {
        Ok(n) if n == len => {}
        Ok(_) => {
            let _ = std::fs::remove_file(&temp);
            return Err(format!("{}: the copy came out short", src.display()));
        }
        Err(e) => {
            let _ = std::fs::remove_file(&temp);
            return Err(e);
        }
    }
    if let Err(e) = std::fs::rename(&temp, dest) {
        let _ = std::fs::remove_file(&temp);
        return Err(e.to_string());
    }
    Ok(std::fs::remove_file(src)
        .err()
        .map(|e| format!("{} was copied, but the original couldn't be removed: {e}", src.display())))
}

/// A merge: the alts of `from` join the ones of `to` (names kept, numbered when taken).
pub fn carry_over(from: &Path, to: &Path) {
    let alts = list(from);
    if alts.is_empty() {
        return;
    }
    let dest_dir = dir_of(to);
    if std::fs::create_dir_all(&dest_dir).is_err() {
        return;
    }
    for a in alts {
        let src = PathBuf::from(&a.path);
        let stem = src.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
        let _ = move_zip(&src, &free_name(&dest_dir, &stem));
    }
    let _ = std::fs::remove_dir(dir_of(from));
}

/// The same path, or one inside the other (case-insensitive, either slash).
pub fn overlaps(a: &str, b: &str) -> bool {
    let norm = |s: &str| s.replace('/', "\\").trim_end_matches('\\').to_lowercase();
    let (a, b) = (norm(a), norm(b));
    !a.is_empty()
        && !b.is_empty()
        && (a == b || a.starts_with(&format!("{b}\\")) || b.starts_with(&format!("{a}\\")))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("micoll-alts-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn a_folder_becomes_a_zip_that_holds_all_of_it() {
        let b = tmp("zip");
        let src = b.join("Second version");
        std::fs::create_dir_all(src.join("step")).unwrap();
        std::fs::write(src.join("a.png"), b"one").unwrap();
        std::fs::write(src.join("step").join("b.psd"), b"two").unwrap();
        let reward = b.join("Reward");
        std::fs::create_dir_all(dir_of(&reward)).unwrap();
        let dest = free_name(&dir_of(&reward), "Second version");
        let mut seen = Vec::new();
        zip_folder(&src, &dest, None, &mut |d, t| seen.push((d, t))).unwrap();
        assert_eq!(seen.last(), Some(&(2, 2)));
        assert!(!part_of(&dest).exists());
        let mut z = zip::ZipArchive::new(std::fs::File::open(&dest).unwrap()).unwrap();
        let mut names: Vec<String> = (0..z.len()).map(|i| z.by_index(i).unwrap().name().to_string()).collect();
        names.sort();
        assert_eq!(names, vec!["a.png", "step/", "step/b.psd"]);
        let listed = list(&reward);
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].name, "Second version.zip");
        let _ = std::fs::remove_dir_all(&b);
    }

    #[test]
    fn names_are_numbered_and_zips_move() {
        let b = tmp("move");
        let dir = b.join(ALTS_DIR);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("Pack.zip"), b"x").unwrap();
        assert_eq!(free_name(&dir, "Pack"), dir.join("Pack (2).zip"));
        let src = b.join("Pack.zip");
        std::fs::write(&src, b"zipdata").unwrap();
        let dest = free_name(&dir, "Pack");
        assert_eq!(move_zip(&src, &dest).unwrap(), None);
        assert!(!src.exists());
        assert_eq!(std::fs::read(&dest).unwrap(), b"zipdata");
        let _ = std::fs::remove_dir_all(&b);
    }

    #[test]
    fn a_merge_takes_the_alts_along() {
        let b = tmp("merge");
        let (from, to) = (b.join("A"), b.join("B"));
        std::fs::create_dir_all(dir_of(&from)).unwrap();
        std::fs::create_dir_all(dir_of(&to)).unwrap();
        std::fs::write(dir_of(&from).join("X.zip"), b"1").unwrap();
        std::fs::write(dir_of(&to).join("X.zip"), b"2").unwrap();
        carry_over(&from, &to);
        let names: Vec<String> = list(&to).into_iter().map(|a| a.name).collect();
        assert_eq!(names, vec!["X (2).zip", "X.zip"]);
        assert!(!dir_of(&from).exists());
        let _ = std::fs::remove_dir_all(&b);
    }

    #[test]
    fn overlap_is_case_and_slash_blind() {
        assert!(overlaps(r"C:\Lib\Ann\05.25", r"c:/lib/ann/05.25/"));
        assert!(overlaps(r"C:\Lib\Ann", r"C:\Lib\Ann\05.25\Set"));
        assert!(overlaps(r"C:\Lib\Ann\05.25\Set", r"C:\Lib\Ann"));
        assert!(!overlaps(r"C:\Lib\Ann 2", r"C:\Lib\Ann"));
        assert!(!overlaps("", r"C:\Lib"));
    }
}
