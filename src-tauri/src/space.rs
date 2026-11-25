//! Room on a drive, asked before something big is copied there: a drive that's too full
//! says so at the start instead of in the middle.
//!
//! Where Windows doesn't say how much is free the copy just starts (every copy is checked
//! and taken back by itself anyway).

use std::path::{Path, PathBuf};
use walkdir::WalkDir;

const MB: u64 = 1024 * 1024;
/// Room a drive of the PC keeps (the database, thumbnails and Windows itself need some).
pub const KEEP_FREE: u64 = 256 * MB;
/// Room the MiSD disk keeps, and what's left after a single copy.
pub const KEEP_LITTLE: u64 = 16 * MB;

/// The nearest folder of `dir` that's there.
fn existing(dir: &Path) -> Option<&Path> {
    dir.ancestors().find(|d| !d.as_os_str().is_empty() && d.exists())
}

#[cfg(test)]
thread_local! {
    /// A folder that acts as a drive of its own with that many free bytes (tests).
    pub static FAKE: std::cell::RefCell<Option<(PathBuf, u64)>> = const { std::cell::RefCell::new(None) };
}

#[cfg(test)]
fn fake(dir: &Path) -> Option<u64> {
    FAKE.with(|f| f.borrow().as_ref().filter(|(d, _)| dir.starts_with(d)).map(|(_, n)| *n))
}

/// Free bytes on the drive of `dir` (which needn't exist yet). None when Windows doesn't say.
pub fn free_space(dir: &Path) -> Option<u64> {
    #[cfg(test)]
    if let Some(n) = fake(dir) {
        return Some(n);
    }
    free_on(existing(dir)?)
}

#[cfg(windows)]
fn free_on(dir: &Path) -> Option<u64> {
    use windows::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
    let mut free = 0u64;
    unsafe { GetDiskFreeSpaceExW(&windows::core::HSTRING::from(dir.as_os_str()), Some(&mut free), None, None) }.ok()?;
    Some(free)
}
#[cfg(not(windows))]
fn free_on(_dir: &Path) -> Option<u64> {
    None
}

/// The drive a folder is on.
#[derive(Clone)]
struct Disk {
    /// The same for two folders on one drive (also through subst or a mount folder).
    id: String,
    /// A file takes whole blocks of this size (a big external disk: 128 KB and more).
    block: u64,
}

impl Disk {
    /// The drive of `dir`, None when Windows doesn't say.
    fn of(dir: &Path) -> Option<Disk> {
        #[cfg(test)]
        if fake(dir).is_some() {
            return Some(Disk { id: "fake".into(), block: 1 });
        }
        let dir = existing(dir)?;
        // through links, subst and mapped letters to the real place
        let real = std::fs::canonicalize(dir).unwrap_or_else(|_| dir.to_path_buf());
        disk_at(&real)
    }

    fn blocks(&self, n: u64) -> u64 {
        n.div_ceil(self.block) * self.block
    }
}

#[cfg(windows)]
fn disk_at(dir: &Path) -> Option<Disk> {
    use windows::core::{HSTRING, PCWSTR};
    use windows::Win32::Storage::FileSystem::{GetDiskFreeSpaceW, GetVolumeInformationW, GetVolumePathNameW};
    let mut buf = [0u16; 512];
    unsafe { GetVolumePathNameW(&HSTRING::from(dir.as_os_str()), &mut buf) }.ok()?;
    let len = buf.iter().position(|c| *c == 0)?;
    let root = PCWSTR(buf.as_ptr());
    let name = String::from_utf16_lossy(&buf[..len]).to_lowercase();
    let mut serial = 0u32;
    let known = unsafe { GetVolumeInformationW(root, None, Some(&mut serial), None, None, None) }.is_ok();
    let (mut sectors, mut bytes, mut total) = (0u32, 0u32, 0u32);
    let sized =
        unsafe { GetDiskFreeSpaceW(root, Some(&mut sectors), Some(&mut bytes), None, Some(&mut total)) }.is_ok();
    let block = if sized { (sectors as u64 * bytes as u64).clamp(1, 32 * MB) } else { 4096 };
    // (a cloned disk can carry the serial of the other one, their sizes rarely match too)
    let id = if known && serial != 0 { format!("{serial:08x}-{total}") } else { name };
    Some(Disk { id, block })
}
#[cfg(not(windows))]
fn disk_at(_dir: &Path) -> Option<Disk> {
    None
}

/// What a copy of `src` (a file or a folder) to `dst` takes there. A file that's replaced
/// gives its old room back.
fn size_of_copy(src: &Path, dst: &Path, disk: &Disk, skip: &dyn Fn(&Path) -> bool, biggest: &mut u64) -> u64 {
    let merges = dst.exists();
    let mut sum = 0u64;
    for e in WalkDir::new(src).into_iter().filter_entry(|e| !skip(e.path())).flatten() {
        if !e.file_type().is_file() {
            continue;
        }
        let len = disk.blocks(e.metadata().map(|m| m.len()).unwrap_or(0));
        let old = match e.path().strip_prefix(src) {
            Ok(rel) if merges => {
                let at = if rel.as_os_str().is_empty() { dst.to_path_buf() } else { dst.join(rel) };
                std::fs::metadata(at).map(|m| disk.blocks(m.len())).unwrap_or(0)
            }
            _ => 0,
        };
        *biggest = (*biggest).max(len);
        sum += len.saturating_sub(old);
    }
    sum
}

/// What one drive gets.
struct Load {
    disk: Disk,
    /// A place on it (to ask how much is free, and for the message).
    at: PathBuf,
    /// What stays there.
    bytes: u64,
    /// The biggest thing that is there twice for a while (copied, then its source goes).
    twice: u64,
    /// The biggest single file.
    biggest: u64,
}

/// What a job is going to write, added up per drive. Folders have to come with the outer
/// ones first: one inside an already added one is part of it.
#[derive(Default)]
pub struct Plan {
    loads: Vec<Load>,
    added: Vec<PathBuf>,
}

impl Plan {
    fn load(&mut self, disk: Disk, at: &Path) -> &mut Load {
        let i = self.loads.iter().position(|l| l.disk.id == disk.id).unwrap_or_else(|| {
            self.loads.push(Load { disk, at: at.to_path_buf(), bytes: 0, twice: 0, biggest: 0 });
            self.loads.len() - 1
        });
        &mut self.loads[i]
    }

    /// The first time for this folder (and not inside one that's already in).
    fn first(&mut self, src: &Path) -> bool {
        if self.added.iter().any(|a| src.starts_with(a)) {
            return false;
        }
        self.added.push(src.to_path_buf());
        true
    }

    fn same_disk(src: &Path, disk: &Disk) -> bool {
        Disk::of(src).is_some_and(|d| d.id == disk.id)
    }

    /// src is copied to dst and stays.
    pub fn copy(&mut self, src: &Path, dst: &Path) {
        let Some(disk) = Disk::of(dst) else { return };
        if !self.first(src) {
            return;
        }
        let mut biggest = 0;
        let n = size_of_copy(src, dst, &disk, &|_| false, &mut biggest);
        let l = self.load(disk, dst);
        l.bytes += n;
        l.biggest = l.biggest.max(biggest);
    }

    /// src is copied to dst, then it goes: on one drive its room comes back each time.
    pub fn copy_then_remove(&mut self, src: &Path, dst: &Path) {
        let Some(disk) = Disk::of(dst) else { return };
        if !Self::same_disk(src, &disk) {
            return self.copy(src, dst);
        }
        if !self.first(src) {
            return;
        }
        let n = size_of_copy(src, dst, &disk, &|_| false, &mut 0);
        let l = self.load(disk, dst);
        l.twice = l.twice.max(n);
    }

    /// src is moved to dst: nothing on the same drive, a copy to another one.
    pub fn rename(&mut self, src: &Path, dst: &Path) {
        let Some(disk) = Disk::of(dst) else { return };
        if !Self::same_disk(src, &disk) {
            self.copy(src, dst);
        }
    }

    /// Something written to dir that isn't one folder's copy (unpacking): the files' sizes.
    pub fn write(&mut self, dir: &Path, sizes: impl Iterator<Item = u64>) {
        let Some(disk) = Disk::of(dir) else { return };
        for n in sizes {
            let n = disk.blocks(n);
            let l = self.load(disk.clone(), dir);
            l.bytes += n;
            l.biggest = l.biggest.max(n);
        }
    }

    /// The files are encrypted one after the other once they're there: each is there twice
    /// while that runs.
    pub fn encrypted(&mut self) {
        for l in &mut self.loads {
            l.twice = l.twice.max(l.biggest);
        }
    }

    /// Err says which drive is too full and by how much. `keep` is left over on each.
    pub fn fits(&self, keep: u64) -> Result<(), String> {
        for l in &self.loads {
            let need = l.bytes + l.twice;
            // (nothing to write goes onto a full drive too)
            if need == 0 {
                continue;
            }
            let need = need + keep;
            if let Some(free) = free_space(&l.at).filter(|f| *f < need) {
                return Err(too_full(&l.at, need, free));
            }
        }
        Ok(())
    }
}

/// A single copy of src to dst, see Plan::fits.
pub fn room(src: &Path, dst: &Path, skip: &dyn Fn(&Path) -> bool, keep: u64) -> Result<(), String> {
    let Some(disk) = Disk::of(dst) else { return Ok(()) };
    let n = size_of_copy(src, dst, &disk, skip, &mut 0);
    if n == 0 {
        return Ok(());
    }
    match free_space(dst).filter(|f| *f < n + keep) {
        Some(free) => Err(too_full(dst, n + keep, free)),
        None => Ok(()),
    }
}

/// The interface finds this sentence and shows it in its language (see lib/space.ts).
fn too_full(at: &Path, need: u64, free: u64) -> String {
    format!("Not enough space on {} ({} needed, {} free)", drive_name(at), size(need, true), size(free, false))
}

/// "E:" or "\\server\share".
fn drive_name(at: &Path) -> String {
    use std::path::{Component, Prefix};
    match at.components().next() {
        Some(Component::Prefix(p)) => match p.kind() {
            Prefix::Disk(d) | Prefix::VerbatimDisk(d) => format!("{}:", (d as char).to_ascii_uppercase()),
            Prefix::UNC(s, n) | Prefix::VerbatimUNC(s, n) => {
                format!("\\\\{}\\{}", s.to_string_lossy(), n.to_string_lossy())
            }
            _ => p.as_os_str().to_string_lossy().into_owned(),
        },
        _ => at.to_string_lossy().into_owned(),
    }
}

/// "1.4 GB" / "37 MB". What's needed is rounded up and what's free down, so a drive that's
/// just too small never reads like it fits.
fn size(n: u64, up: bool) -> String {
    let (unit, name, tenths) = if n >= 1024 * MB { (1024 * MB, "GB", 10) } else { (MB, "MB", 1) };
    let n = n as u128 * tenths;
    let v = if up { n.div_ceil(unit as u128) } else { n / unit as u128 };
    if tenths == 10 {
        format!("{}.{} {name}", v / 10, v % 10)
    } else {
        format!("{v} {name}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base(name: &str) -> PathBuf {
        let b = std::env::temp_dir().join(format!("micoll_space_{name}_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&b);
        std::fs::create_dir_all(&b).unwrap();
        b
    }

    fn put(p: &Path, n: usize) {
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, vec![7u8; n]).unwrap();
    }

    fn disk(dir: &Path, free: u64) {
        FAKE.with(|f| *f.borrow_mut() = Some((dir.to_path_buf(), free)));
    }

    #[cfg(windows)]
    #[test]
    fn knows_the_free_space_and_the_drive() {
        let t = std::env::temp_dir();
        assert!(free_space(&t).is_some_and(|f| f > 0));
        // a place that isn't there yet is on the drive of the folder above
        let later = t.join("micoll_not_there").join("deeper");
        assert!(free_space(&later).is_some_and(|f| f > 0));
        let (a, b) = (Disk::of(&t).unwrap(), Disk::of(&later).unwrap());
        assert_eq!(a.id, b.id);
        assert!(a.block >= 512 && a.block.is_power_of_two(), "{}", a.block);
        assert_eq!(a.blocks(1), a.block);
        assert_eq!(a.blocks(0), 0);
    }

    #[test]
    fn a_copy_that_does_not_fit_is_refused() {
        let b = base("copy");
        put(&b.join("src/a.bin"), 600);
        put(&b.join("src/sub/b.bin"), 400);
        let out = b.join("disk");
        std::fs::create_dir_all(&out).unwrap();
        let fits = |free: u64| {
            disk(&out, free);
            let mut p = Plan::default();
            p.copy(&b.join("src"), &out.join("x"));
            // inside an added folder: part of it
            p.copy(&b.join("src/sub"), &out.join("y"));
            let single = room(&b.join("src"), &out.join("x"), &|_| false, 10).is_ok();
            assert_eq!(single, p.fits(10).is_ok());
            p.fits(10)
        };
        assert!(fits(1010).is_ok());
        assert!(fits(1009).unwrap_err().starts_with("Not enough space on "));
        // what's already there is replaced, only the difference is needed
        put(&out.join("x/a.bin"), 600);
        assert!(fits(410).is_ok() && fits(409).is_err());
        // and nothing at all goes onto a full drive too
        put(&out.join("x/sub/b.bin"), 400);
        assert!(fits(0).is_ok());
        let _ = std::fs::remove_dir_all(&b);
    }

    #[test]
    fn moving_on_one_drive_needs_little() {
        let b = base("move");
        put(&b.join("far/a/1.bin"), 500);
        put(&b.join("near/b/1.bin"), 300);
        put(&b.join("near/c/1.bin"), 200);
        let near = b.join("near");
        let need = |f: &dyn Fn(&mut Plan)| {
            disk(&near, u64::MAX / 2);
            let mut p = Plan::default();
            f(&mut p);
            p.loads.iter().map(|l| l.bytes + l.twice).sum::<u64>()
        };
        // a rename takes nothing, from another drive it's a copy
        assert_eq!(need(&|p| p.rename(&near.join("b"), &near.join("x/b"))), 0);
        assert_eq!(need(&|p| p.rename(&b.join("far/a"), &near.join("x/a"))), 500);
        // copied and removed one after the other: only the biggest is there twice
        assert_eq!(
            need(&|p| {
                p.copy_then_remove(&near.join("b"), &near.join("x/b"));
                p.copy_then_remove(&near.join("c"), &near.join("x/c"));
            }),
            300
        );
        assert_eq!(need(&|p| p.copy_then_remove(&b.join("far/a"), &near.join("x/a"))), 500);
        // encrypting needs the biggest file once more
        assert_eq!(
            need(&|p| {
                p.write(&near, [100, 250].into_iter());
                p.encrypted();
            }),
            600
        );
        let _ = std::fs::remove_dir_all(&b);
    }

    #[test]
    fn the_message_never_reads_like_it_fits() {
        assert_eq!(size(1024 * MB + 1, true), "1.1 GB");
        assert_eq!(size(2048 * MB - 1, false), "1.9 GB");
        assert_eq!(size(5 * MB + 1, true), "6 MB");
        assert_eq!(size(5 * MB - 1, false), "4 MB");
        assert_eq!(
            too_full(Path::new(r"e:\Some\Folder"), 3 * 1024 * MB, 700 * MB),
            "Not enough space on E: (3.0 GB needed, 700 MB free)"
        );
        assert_eq!(drive_name(Path::new(r"\\nas\pics\x")), r"\\nas\pics");
    }
}
