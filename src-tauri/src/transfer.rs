//! Copies that never lose a file. Every copy is checked against its source (same size
//! on disk) before anything is deleted, nothing that's already there is overwritten, and
//! a source is only removed when every file in it arrived.

use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

/// Source file -> its size, for every file that was copied and checked at the
/// destination.
pub type Arrived = HashMap<PathBuf, u64>;

fn file_len(p: &Path) -> Option<u64> {
    std::fs::metadata(p).ok().filter(|m| m.is_file()).map(|m| m.len())
}

fn read_full(f: &mut std::fs::File, buf: &mut [u8]) -> std::io::Result<usize> {
    let mut n = 0;
    while n < buf.len() {
        let k = f.read(&mut buf[n..])?;
        if k == 0 {
            break;
        }
        n += k;
    }
    Ok(n)
}

/// Byte for byte the same (for a file that's already at the destination).
pub fn same_bytes(a: &Path, b: &Path) -> bool {
    let Some(n) = file_len(a) else { return false };
    if file_len(b) != Some(n) {
        return false;
    }
    let (Ok(mut fa), Ok(mut fb)) = (std::fs::File::open(a), std::fs::File::open(b)) else {
        return false;
    };
    let mut ba = vec![0u8; 1 << 20];
    let mut bb = vec![0u8; 1 << 20];
    loop {
        let (Ok(na), Ok(nb)) = (read_full(&mut fa, &mut ba), read_full(&mut fb, &mut bb)) else {
            return false;
        };
        if na != nb || ba[..na] != bb[..nb] {
            return false;
        }
        if na == 0 {
            return true;
        }
    }
}

/// Copy a file to dest (which must not exist yet) and check it arrived whole. A failed or
/// short copy is removed again. Returns the size.
pub fn copy_file_checked(src: &Path, dest: &Path) -> Result<u64, String> {
    copy_file_checked_with(src, dest, &mut |_| true)
}

/// copy_file_checked, and `tick` hears how many bytes of the file are through while it
/// copies (a big video takes a while). false from it stops the copy: Err(CANCELLED),
/// nothing of it is left.
pub fn copy_file_checked_with(src: &Path, dest: &Path, tick: &mut dyn FnMut(u64) -> bool) -> Result<u64, String> {
    let want = file_len(src).ok_or_else(|| format!("{}: can't be read", src.display()))?;
    if dest.exists() {
        return Err(format!("{}: already exists", dest.display()));
    }
    match copy_ticking(src, dest, tick) {
        Ok(false) if file_len(dest) == Some(want) => Ok(want),
        Ok(stopped) => {
            let _ = std::fs::remove_file(dest);
            Err(if stopped { CANCELLED.to_string() } else { format!("{}: the copy came out incomplete", src.display()) })
        }
        Err(e) => {
            let _ = std::fs::remove_file(dest);
            Err(format!("{}: {e}", src.display()))
        }
    }
}

/// Windows' own copy (what std::fs::copy does too: dates and attributes come along), with
/// its progress. Ok(true) = tick stopped it.
#[cfg(windows)]
fn copy_ticking(src: &Path, dest: &Path, tick: &mut dyn FnMut(u64) -> bool) -> std::io::Result<bool> {
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::Storage::FileSystem::{
        CopyFileExW, COPYFILE_FLAGS, COPYPROGRESSROUTINE_PROGRESS, LPPROGRESS_ROUTINE_CALLBACK_REASON, PROGRESS_CANCEL,
        PROGRESS_CONTINUE,
    };
    struct Ctx<'a> {
        tick: &'a mut dyn FnMut(u64) -> bool,
        stopped: bool,
    }
    unsafe extern "system" fn on_part(
        _total: i64,
        done: i64,
        _stream: i64,
        _stream_done: i64,
        _n: u32,
        _why: LPPROGRESS_ROUTINE_CALLBACK_REASON,
        _from: HANDLE,
        _to: HANDLE,
        data: *const core::ffi::c_void,
    ) -> COPYPROGRESSROUTINE_PROGRESS {
        // SAFETY: data is the Ctx below, alive for the whole CopyFileExW call
        let ctx = unsafe { &mut *(data as *mut Ctx) };
        // nothing may unwind into Windows
        let go = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| (ctx.tick)(done.max(0) as u64))).unwrap_or(false);
        if go {
            PROGRESS_CONTINUE
        } else {
            ctx.stopped = true;
            PROGRESS_CANCEL
        }
    }
    // long paths need the \\?\ form
    let wide = |p: &Path| {
        let s = p.as_os_str().to_string_lossy();
        if s.len() >= 240 && p.is_absolute() && !s.starts_with(r"\\") {
            windows::core::HSTRING::from(format!(r"\\?\{}", s.replace('/', r"\")))
        } else {
            windows::core::HSTRING::from(p.as_os_str())
        }
    };
    let mut ctx = Ctx { tick, stopped: false };
    let done = unsafe {
        CopyFileExW(
            &wide(src),
            &wide(dest),
            Some(on_part),
            Some(&mut ctx as *mut Ctx as *const core::ffi::c_void),
            None,
            COPYFILE_FLAGS(0),
        )
    };
    if ctx.stopped {
        return Ok(true);
    }
    done.map_err(|e| std::io::Error::other(e.message()))?;
    Ok(false)
}

#[cfg(not(windows))]
fn copy_ticking(src: &Path, dest: &Path, tick: &mut dyn FnMut(u64) -> bool) -> std::io::Result<bool> {
    let n = std::fs::copy(src, dest)?;
    Ok(!tick(n))
}

/// Replace dest with src: the copy goes to a temp name next to it first and only takes
/// dest's place once it's complete, so a failed copy leaves the old file alone.
pub fn replace_file_checked(src: &Path, dest: &Path) -> Result<u64, String> {
    replace_file_checked_with(src, dest, &mut |_| true)
}

/// replace_file_checked with copy_file_checked_with's tick.
pub fn replace_file_checked_with(src: &Path, dest: &Path, tick: &mut dyn FnMut(u64) -> bool) -> Result<u64, String> {
    let dir = dest.parent().ok_or_else(|| format!("{}: no folder", dest.display()))?;
    let name = dest.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let tmp = dir.join(format!(".{name}.micoll-part"));
    let _ = std::fs::remove_file(&tmp); // a leftover of ours from a crash
    let n = copy_file_checked_with(src, &tmp, tick)?;
    std::fs::rename(&tmp, dest).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("{}: {e}", dest.display())
    })?;
    Ok(n)
}

/// copy_tree_with's error when it was stopped (nothing went wrong).
pub const CANCELLED: &str = "cancelled";

/// What copy_tree_checked made, so a move that can't finish takes it back.
pub struct Copied {
    pub arrived: Arrived,
    files: Vec<PathBuf>,
    dirs: Vec<PathBuf>,
}

impl Copied {
    /// Remove the files and folders this copy created (never anything that was there).
    pub fn undo(&self) {
        for f in self.files.iter().rev() {
            let _ = std::fs::remove_file(f);
        }
        for d in self.dirs.iter().rev() {
            let _ = std::fs::remove_dir(d);
        }
    }
}

/// Copy the src tree into dst. Never overwrites: a file that's already at the destination
/// only counts when it's byte for byte the same. On any problem (unreadable folder, failed
/// or short copy, a different file in the way) what this call made is removed again and
/// the error says why. skip leaves paths out (and everything under them). A drive that's
/// too full is refused before the first file.
pub fn copy_tree_checked(src: &Path, dst: &Path, skip: &dyn Fn(&Path) -> bool) -> Result<Copied, String> {
    copy_tree_with(src, dst, skip, &mut |_| true)
}

/// copy_tree_checked that reports each copied file's size to `tick`. When `tick` says
/// false the copy stops and takes back what it made (the error is CANCELLED).
pub fn copy_tree_with(
    src: &Path,
    dst: &Path,
    skip: &dyn Fn(&Path) -> bool,
    tick: &mut dyn FnMut(u64) -> bool,
) -> Result<Copied, String> {
    crate::space::room(src, dst, skip, crate::space::KEEP_LITTLE)?;
    let mut out = Copied { arrived: Arrived::new(), files: Vec::new(), dirs: Vec::new() };
    let res = (|| -> Result<(), String> {
        for entry in WalkDir::new(src).into_iter().filter_entry(|e| !skip(e.path())) {
            let entry = entry.map_err(|e| format!("couldn't read {}: {e}", src.display()))?;
            let rel = entry.path().strip_prefix(src).map_err(|e| e.to_string())?;
            let target = dst.join(rel);
            if entry.file_type().is_dir() {
                if !target.exists() {
                    std::fs::create_dir_all(&target)
                        .map_err(|e| format!("{}: {e}", target.display()))?;
                    out.dirs.push(target);
                }
                continue;
            }
            if target.exists() {
                if same_bytes(entry.path(), &target) {
                    let n = file_len(&target).unwrap_or(0);
                    out.arrived.insert(entry.path().to_path_buf(), n);
                    if !tick(n) {
                        return Err(CANCELLED.into());
                    }
                    continue;
                }
                return Err(format!(
                    "{}: a different file with that name is already at the destination",
                    target.display()
                ));
            }
            let size = copy_file_checked(entry.path(), &target)?;
            out.files.push(target);
            out.arrived.insert(entry.path().to_path_buf(), size);
            if !tick(size) {
                return Err(CANCELLED.into());
            }
        }
        Ok(())
    })();
    match res {
        Ok(()) => Ok(out),
        Err(e) => {
            out.undo();
            Err(e)
        }
    }
}

/// Every file at or under src is one that arrived, still with the size it had then
/// (nothing was added or changed while copying). Only then may src be removed.
pub fn all_arrived(src: &Path, arrived: &Arrived, skip: &dyn Fn(&Path) -> bool) -> Result<(), String> {
    for entry in WalkDir::new(src).into_iter().filter_entry(|e| !skip(e.path())) {
        let entry = entry.map_err(|e| format!("couldn't read {}: {e}", src.display()))?;
        if entry.file_type().is_dir() {
            continue;
        }
        let p = entry.path();
        match arrived.get(p) {
            Some(&n) if file_len(p) == Some(n) => {}
            Some(_) => return Err(format!("{} changed while it was copied", p.display())),
            None => return Err(format!("{} wasn't copied", p.display())),
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A big file says how far it is while it copies, and stops in the middle.
    #[test]
    fn a_big_copy_ticks_and_can_be_stopped() {
        let b = std::env::temp_dir().join(format!("micoll_tickcopy_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&b);
        std::fs::create_dir_all(&b).unwrap();
        let src = b.join("big.mp4");
        let data: Vec<u8> = (0..48u32 << 20).map(|i| (i.wrapping_mul(2_654_435_761) >> 13) as u8).collect();
        std::fs::write(&src, &data).unwrap();
        let mut seen = Vec::new();
        let n = copy_file_checked_with(&src, &b.join("a.mp4"), &mut |n| {
            seen.push(n);
            true
        })
        .unwrap();
        assert_eq!(n, data.len() as u64);
        assert!(seen.len() > 3 && seen.windows(2).all(|w| w[0] <= w[1]), "{seen:?}");
        assert_eq!(seen.last(), Some(&n));
        assert!(same_bytes(&src, &b.join("a.mp4")));
        // stopped after the first part: nothing of it is left
        let mut calls = 0;
        let got = copy_file_checked_with(&src, &b.join("b.mp4"), &mut |n| {
            calls += 1;
            n == 0
        });
        assert_eq!(got, Err(CANCELLED.to_string()));
        assert!(!b.join("b.mp4").exists() && calls >= 2);
        // the same when it replaces a file: the old one stays
        std::fs::write(b.join("c.mp4"), b"old").unwrap();
        assert!(replace_file_checked_with(&src, &b.join("c.mp4"), &mut |n| n == 0).is_err());
        assert_eq!(std::fs::read(b.join("c.mp4")).unwrap(), b"old");
        assert_eq!(std::fs::read_dir(&b).unwrap().count(), 3);
        let _ = std::fs::remove_dir_all(&b);
    }

    #[test]
    fn a_stopped_copy_takes_back_what_it_made() {
        let b = std::env::temp_dir().join(format!("micoll_stopcopy_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&b);
        for f in ["a.png", "b.png", "sub/c.png"] {
            put(&b.join("src").join(f), b"12345");
        }
        let mut n = 0;
        let err = copy_tree_with(&b.join("src"), &b.join("dst"), &|_| false, &mut |_| {
            n += 1;
            n < 2
        });
        assert_eq!(err.err().as_deref(), Some(CANCELLED));
        // nothing of the copy is left, the source is whole
        assert!(!b.join("dst").exists() || std::fs::read_dir(b.join("dst")).unwrap().next().is_none());
        assert!(b.join("src").join("sub").join("c.png").exists());
        let _ = std::fs::remove_dir_all(&b);
    }

    fn put(p: &Path, data: &[u8]) {
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, data).unwrap();
    }

    fn base(name: &str) -> PathBuf {
        let b = std::env::temp_dir().join(format!("micoll_xfer_{name}_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&b);
        b
    }

    #[test]
    fn copies_the_tree_and_checks_every_file() {
        let b = base("tree");
        put(&b.join("src/a.png"), b"aaaa");
        put(&b.join("src/sub/b.png"), b"bb");
        let c = copy_tree_checked(&b.join("src"), &b.join("dst"), &|_| false).unwrap();
        assert_eq!(std::fs::read(b.join("dst/sub/b.png")).unwrap(), b"bb");
        assert_eq!(c.arrived.len(), 2);
        assert!(all_arrived(&b.join("src"), &c.arrived, &|_| false).is_ok());
        let _ = std::fs::remove_dir_all(&b);
    }

    #[test]
    fn a_different_file_in_the_way_stops_and_takes_the_copy_back() {
        let b = base("clash");
        put(&b.join("src/a.png"), b"new");
        put(&b.join("src/z.png"), b"zzz");
        put(&b.join("dst/z.png"), b"old one");
        let err = copy_tree_checked(&b.join("src"), &b.join("dst"), &|_| false);
        assert!(err.is_err());
        // the existing file is untouched and a.png (made by the copy) is gone again
        assert_eq!(std::fs::read(b.join("dst/z.png")).unwrap(), b"old one");
        assert!(!b.join("dst/a.png").exists());
        let _ = std::fs::remove_dir_all(&b);
    }

    #[test]
    fn a_full_drive_is_refused_before_anything_is_written() {
        let b = base("full");
        put(&b.join("src/a.png"), &[1; 2000]);
        std::fs::create_dir_all(b.join("disk")).unwrap();
        let free = |n: u64| crate::space::FAKE.with(|f| *f.borrow_mut() = Some((b.join("disk"), n)));
        free(crate::space::KEEP_LITTLE + 1999);
        let err = copy_tree_checked(&b.join("src"), &b.join("disk/dst"), &|_| false).err().unwrap();
        assert!(err.starts_with("Not enough space on "), "{err}");
        assert!(!b.join("disk/dst").exists());
        free(crate::space::KEEP_LITTLE + 2000);
        assert!(copy_tree_checked(&b.join("src"), &b.join("disk/dst"), &|_| false).is_ok());
        let _ = std::fs::remove_dir_all(&b);
    }

    #[test]
    fn an_identical_file_already_there_counts_as_arrived() {
        let b = base("same");
        put(&b.join("src/a.png"), b"same");
        put(&b.join("dst/a.png"), b"same");
        let c = copy_tree_checked(&b.join("src"), &b.join("dst"), &|_| false).unwrap();
        assert!(all_arrived(&b.join("src"), &c.arrived, &|_| false).is_ok());
        let _ = std::fs::remove_dir_all(&b);
    }

    #[test]
    fn a_file_added_or_changed_after_the_copy_blocks_the_delete() {
        let b = base("late");
        put(&b.join("src/a.png"), b"aaaa");
        let c = copy_tree_checked(&b.join("src"), &b.join("dst"), &|_| false).unwrap();
        put(&b.join("src/late.png"), b"l");
        assert!(all_arrived(&b.join("src"), &c.arrived, &|_| false).is_err());
        std::fs::remove_file(b.join("src/late.png")).unwrap();
        put(&b.join("src/a.png"), b"aaaaaa");
        assert!(all_arrived(&b.join("src"), &c.arrived, &|_| false).is_err());
        let _ = std::fs::remove_dir_all(&b);
    }

    #[test]
    fn replace_keeps_the_old_file_when_the_source_is_gone() {
        let b = base("repl");
        put(&b.join("dst/a.png"), b"old");
        assert!(replace_file_checked(&b.join("missing.png"), &b.join("dst/a.png")).is_err());
        assert_eq!(std::fs::read(b.join("dst/a.png")).unwrap(), b"old");
        put(&b.join("new.png"), b"new!");
        assert_eq!(replace_file_checked(&b.join("new.png"), &b.join("dst/a.png")).unwrap(), 4);
        assert_eq!(std::fs::read(b.join("dst/a.png")).unwrap(), b"new!");
        let _ = std::fs::remove_dir_all(&b);
    }
}
