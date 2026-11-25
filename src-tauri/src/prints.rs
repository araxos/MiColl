//! What the duplicate finder's similar mode worked out per picture (dup::Fingerprint and
//! the pixel size), kept so the next scan only looks at new and changed pictures.
//!
//! Its own small database in the cache folder (about 1 KB a picture), not the library's:
//! it's worth nothing, so it isn't in the daily backups, and a broken or missing one is
//! just made again. An entry counts while the file's size and time are the same. A file
//! that moved is recognized by its size, its time and its first and last bytes.

use crate::{crypto, dup};
use rusqlite::{params, Connection, OptionalExtension};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

const FILE: &str = "prints.db";
/// The layout and the way a fingerprint is made: another number starts over.
const VERSION: i64 = 1;
/// New entries written at once (a stopped scan keeps the ones before).
const BATCH: usize = 200;
/// How much of both ends identifies a file that moved.
const END: usize = 16 * 1024;
/// A copy to another file system keeps the time only roughly (FAT: 2 seconds).
const ABOUT: i64 = 2_000_000_000;

/// What's known about a picture. print None = it can't be decoded, that's known too.
pub struct Seen {
    pub print: Option<dup::Fingerprint>,
    pub width: u32,
    pub height: u32,
}

/// A file as it is now.
pub struct File {
    path: String,
    size: i64,
    time: i64,
}

impl File {
    pub fn new(path: &str, md: &std::fs::Metadata) -> File {
        let time = md
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_nanos() as i64)
            .unwrap_or(0);
        File { path: path.to_string(), size: md.len() as i64, time }
    }

    /// Both ends of the file. None when it can't be read.
    fn ends(&self) -> Option<Vec<u8>> {
        use std::io::{Read, Seek, SeekFrom};
        let mut f = std::fs::File::open(&self.path).ok()?;
        let mut buf = Vec::with_capacity(2 * END);
        (&mut f).take(END as u64).read_to_end(&mut buf).ok()?;
        if self.size as usize > 2 * END {
            f.seek(SeekFrom::End(-(END as i64))).ok()?;
        }
        f.take(END as u64).read_to_end(&mut buf).ok()?;
        Some(Sha256::digest(&buf)[..16].to_vec())
    }
}

struct Entry {
    file: File,
    ends: Option<Vec<u8>>,
    width: u32,
    height: u32,
    data: Vec<u8>,
}

pub struct Store {
    conn: Connection,
    key: Option<[u8; 32]>,
    new: Vec<Entry>,
}

fn path_in(cache: &Path) -> PathBuf {
    cache.join(FILE)
}

/// Remove everything kept (encryption was turned on: a small grey copy of each picture
/// mustn't stay behind in plain).
pub fn forget(cache: &Path) {
    for end in ["", "-wal", "-shm", "-journal"] {
        let _ = std::fs::remove_file(cache.join(format!("{FILE}{end}")));
    }
}

impl Store {
    /// key: with encryption on the entries are encrypted like the thumbnails. None when
    /// there's no way to keep anything (then the scan just does it all).
    pub fn open(cache: &Path, key: Option<[u8; 32]>) -> Option<Store> {
        std::fs::create_dir_all(cache).ok()?;
        let conn = Self::connect(cache).or_else(|_| {
            // broken: a new one
            forget(cache);
            Self::connect(cache)
        });
        Some(Store { conn: conn.ok()?, key, new: Vec::new() })
    }

    fn connect(cache: &Path) -> rusqlite::Result<Connection> {
        let conn = Connection::open(path_in(cache))?;
        conn.busy_timeout(std::time::Duration::from_secs(2))?;
        // losing the last entries in a crash costs nothing
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "OFF")?;
        let v: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
        if v != VERSION {
            conn.execute_batch("DROP TABLE IF EXISTS prints;")?;
        }
        conn.execute_batch(&format!(
            "CREATE TABLE IF NOT EXISTS prints (
                 path TEXT PRIMARY KEY,
                 size INTEGER NOT NULL,
                 time INTEGER NOT NULL,
                 ends BLOB,
                 w INTEGER NOT NULL,
                 h INTEGER NOT NULL,
                 data BLOB NOT NULL
             );
             CREATE INDEX IF NOT EXISTS prints_size ON prints(size);
             PRAGMA user_version = {VERSION};"
        ))?;
        Ok(conn)
    }

    fn unpack(&self, w: u32, h: u32, data: Vec<u8>) -> Option<Seen> {
        let plain = if crypto::is_encrypted(&data) {
            crypto::Dek::from_bytes(self.key?).decrypt_bytes(&data).ok()?
        } else {
            data
        };
        let print = if plain.is_empty() { None } else { Some(dup::Fingerprint::from_bytes(&plain)?) };
        Some(Seen { print, width: w, height: h })
    }

    /// What's known about this file, None when it's new or changed.
    pub fn known(&mut self, file: &File) -> Option<Seen> {
        let row = self
            .conn
            .prepare_cached("SELECT size, time, w, h, data FROM prints WHERE path = ?1")
            .ok()?
            .query_row([&file.path], |r| {
                Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?, r.get(2)?, r.get(3)?, r.get::<_, Vec<u8>>(4)?))
            })
            .optional()
            .ok()?;
        if let Some((size, time, w, h, data)) = row {
            if size == file.size && time == file.time {
                if let Some(seen) = self.unpack(w, h, data) {
                    return Some(seen);
                }
            }
        }
        self.moved(file)
    }

    /// The same file under another path.
    fn moved(&mut self, file: &File) -> Option<Seen> {
        let found = {
            let mut stmt = self
                .conn
                .prepare_cached("SELECT ends, w, h, data FROM prints WHERE size = ?1 AND abs(time - ?2) <= ?3")
                .ok()?;
            let rows = stmt
                .query_map(params![file.size, file.time, ABOUT], |r| {
                    Ok((r.get::<_, Option<Vec<u8>>>(0)?, r.get::<_, u32>(1)?, r.get::<_, u32>(2)?, r.get::<_, Vec<u8>>(3)?))
                })
                .ok()?;
            rows.flatten().collect::<Vec<_>>()
        };
        if found.is_empty() {
            return None;
        }
        let ends = file.ends()?;
        let (_, w, h, data) = found.into_iter().find(|f| f.0.as_ref() == Some(&ends))?;
        let seen = self.unpack(w, h, data.clone())?;
        self.push(Entry {
            file: File { path: file.path.clone(), ..*file },
            ends: Some(ends),
            width: w,
            height: h,
            data,
        });
        Some(seen)
    }

    /// Keep what was worked out.
    pub fn keep(&mut self, file: File, seen: &Seen) {
        let plain = seen.print.as_ref().map(|p| p.to_bytes()).unwrap_or_default();
        let data = match self.key {
            Some(k) => crypto::Dek::from_bytes(k).encrypt_bytes(&plain),
            None => plain,
        };
        let ends = file.ends();
        self.push(Entry { file, ends, width: seen.width, height: seen.height, data });
    }

    fn push(&mut self, e: Entry) {
        self.new.push(e);
        if self.new.len() >= BATCH {
            self.write();
        }
    }

    fn write(&mut self) {
        let new = std::mem::take(&mut self.new);
        if new.is_empty() {
            return;
        }
        let Ok(tx) = self.conn.transaction() else { return };
        for e in &new {
            let _ = tx
                .prepare_cached("INSERT OR REPLACE INTO prints(path, size, time, ends, w, h, data) VALUES(?1,?2,?3,?4,?5,?6,?7)")
                .and_then(|mut s| {
                    s.execute(params![e.file.path, e.file.size, e.file.time, e.ends, e.width, e.height, e.data])
                });
        }
        let _ = tx.commit();
    }

    /// Entries of pictures that aren't in the library anymore go. `library` = all of them.
    pub fn prune(&mut self, library: &std::collections::HashSet<String>) {
        self.write();
        let gone: Vec<String> = {
            let Ok(mut stmt) = self.conn.prepare("SELECT path FROM prints") else { return };
            let Ok(rows) = stmt.query_map([], |r| r.get::<_, String>(0)) else { return };
            rows.flatten().filter(|p| !library.contains(p)).collect()
        };
        if gone.is_empty() {
            return;
        }
        let Ok(tx) = self.conn.transaction() else { return };
        for p in &gone {
            let _ = tx.execute("DELETE FROM prints WHERE path = ?1", [p]);
        }
        let _ = tx.commit();
    }
}

/// A scan that was stopped keeps what it has.
impl Drop for Store {
    fn drop(&mut self) {
        self.write();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base(name: &str) -> PathBuf {
        let b = std::env::temp_dir().join(format!("micoll_prints_{name}_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&b);
        std::fs::create_dir_all(&b).unwrap();
        b
    }

    fn picture(at: &Path, seed: u32) {
        let img = image::RgbImage::from_fn(160, 120, |x, y| {
            image::Rgb([(x * seed % 251) as u8, (y * 3 + seed) as u8, ((x * y) / (seed + 1) % 256) as u8])
        });
        img.save(at).unwrap();
    }

    fn file(at: &Path) -> File {
        File::new(&at.to_string_lossy(), &std::fs::metadata(at).unwrap())
    }

    fn seen(at: &Path) -> Seen {
        Seen { print: dup::fingerprint(&std::fs::read(at).unwrap()), width: 160, height: 120 }
    }

    fn bytes(s: &Seen) -> Vec<u8> {
        s.print.as_ref().unwrap().to_bytes()
    }

    #[test]
    fn a_picture_is_known_until_it_changes() {
        let b = base("known");
        let at = b.join("a.png");
        picture(&at, 7);
        let mut s = Store::open(&b, None).unwrap();
        assert!(s.known(&file(&at)).is_none());
        let want = seen(&at);
        s.keep(file(&at), &want);
        drop(s); // written when the scan ends (or is stopped)

        let mut s = Store::open(&b, None).unwrap();
        let got = s.known(&file(&at)).unwrap();
        assert_eq!(bytes(&got), bytes(&want));
        assert_eq!((got.width, got.height), (160, 120));
        // another picture at the same place
        picture(&at, 9);
        assert!(s.known(&file(&at)).is_none());
        // the same size with another time counts as changed too
        let mut f = file(&at);
        s.keep(file(&at), &seen(&at));
        s.write();
        f.time += ABOUT + 1;
        assert!(s.known(&f).is_none());
        let _ = std::fs::remove_dir_all(&b);
    }

    #[test]
    fn a_moved_picture_is_recognized_and_a_lookalike_is_not() {
        let b = base("moved");
        let (at, to) = (b.join("a.png"), b.join("sub").join("b.png"));
        picture(&at, 7);
        let want = seen(&at);
        let mut s = Store::open(&b, None).unwrap();
        s.keep(file(&at), &want);
        s.write();
        std::fs::create_dir_all(to.parent().unwrap()).unwrap();
        std::fs::rename(&at, &to).unwrap();
        assert_eq!(bytes(&s.known(&file(&to)).unwrap()), bytes(&want));
        // now it's known at the new place, the old one goes with the next full scan
        s.prune(&std::collections::HashSet::from([to.to_string_lossy().to_string()]));
        let paths: Vec<String> = s
            .conn
            .prepare("SELECT path FROM prints")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .flatten()
            .collect();
        assert_eq!(paths, [to.to_string_lossy().to_string()]);

        // the same size and time, other bytes
        let mut raw = std::fs::read(&to).unwrap();
        let n = raw.len();
        raw[n - 20] ^= 1;
        let other = b.join("c.png");
        std::fs::write(&other, &raw).unwrap();
        let time = std::fs::metadata(&to).unwrap().modified().unwrap();
        std::fs::File::options().write(true).open(&other).unwrap().set_modified(time).unwrap();
        assert!(s.known(&file(&other)).is_none());
        let _ = std::fs::remove_dir_all(&b);
    }

    #[test]
    fn with_encryption_nothing_readable_is_kept() {
        let b = base("enc");
        let at = b.join("a.png");
        picture(&at, 7);
        let want = seen(&at);
        let key = Some([3u8; 32]);
        let mut s = Store::open(&b, key).unwrap();
        s.keep(file(&at), &want);
        s.write();
        assert_eq!(bytes(&s.known(&file(&at)).unwrap()), bytes(&want));
        let data: Vec<u8> = s.conn.query_row("SELECT data FROM prints", [], |r| r.get(0)).unwrap();
        assert!(crypto::is_encrypted(&data));
        drop(s);
        // without the key, or with another one, it's as if it wasn't there
        assert!(Store::open(&b, None).unwrap().known(&file(&at)).is_none());
        assert!(Store::open(&b, Some([4u8; 32])).unwrap().known(&file(&at)).is_none());
        // turned on later: all of it goes
        forget(&b);
        assert!(!path_in(&b).exists());
        let _ = std::fs::remove_dir_all(&b);
    }

    #[test]
    fn a_picture_that_cannot_be_decoded_is_remembered_and_a_broken_store_is_replaced() {
        let b = base("broken");
        let at = b.join("a.avif");
        std::fs::write(&at, b"not a picture").unwrap();
        let mut s = Store::open(&b, None).unwrap();
        s.keep(file(&at), &Seen { print: None, width: 0, height: 0 });
        s.write();
        assert!(s.known(&file(&at)).is_some_and(|x| x.print.is_none()));
        drop(s);
        forget(&b);
        std::fs::write(path_in(&b), vec![b'x'; 5000]).unwrap();
        let mut s = Store::open(&b, None).unwrap();
        assert!(s.known(&file(&at)).is_none());
        s.keep(file(&at), &Seen { print: None, width: 0, height: 0 });
        s.write();
        assert!(s.known(&file(&at)).is_some());
        let _ = std::fs::remove_dir_all(&b);
    }
}
