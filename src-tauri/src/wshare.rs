//! Windows share targets: the clipboard and the system Share sheet.
//! Both pass file paths to another app, so encrypted files need a decrypted copy first (see
//! stage).
//! The clipboard matters most: the Share sheet only lists registered apps, but Discord,
//! Telegram, browsers and Explorer all accept pasted files (CF_HDROP).

use std::path::{Path, PathBuf};

use crate::crypto;

/// How long decrypted copies are kept. The other app may read the path minutes later,
/// so we can't delete them right away. Each run removes older ones.
const STAGE_TTL_SECS: u64 = 60 * 60;

fn map_err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

/// Delete old decrypted copies. Files still open elsewhere just stay until next time.
fn prune_stage(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    let now = std::time::SystemTime::now();
    for e in entries.flatten() {
        let stale = e
            .metadata()
            .and_then(|m| m.modified())
            .and_then(|t| now.duration_since(t).map_err(std::io::Error::other))
            .map(|age| age.as_secs() > STAGE_TTL_SECS)
            .unwrap_or(false);
        if stale {
            let _ = std::fs::remove_file(e.path());
        }
    }
}

/// Turn srcs into paths other apps can open.
/// Normal files keep their real path, only encrypted files get a decrypted copy in dir.
/// Same order as srcs.
pub fn stage(dir: &Path, srcs: &[String], key: Option<[u8; 32]>) -> Result<Vec<PathBuf>, String> {
    let mut out: Vec<PathBuf> = Vec::with_capacity(srcs.len());
    let mut used: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut prepared = false;
    for s in srcs {
        let p = PathBuf::from(s);
        if !p.is_file() {
            return Err(format!("File not found: {s}"));
        }
        if !crypto::file_is_encrypted(&p) {
            out.push(p);
            continue;
        }
        if !prepared {
            std::fs::create_dir_all(dir).map_err(map_err)?;
            prune_stage(dir);
            prepared = true;
        }
        let key = key.ok_or("MiColl is locked — unlock to share.")?;
        let bytes = std::fs::read(&p).map_err(map_err)?;
        let data = crypto::Dek::from_bytes(key)
            .decrypt_bytes(&bytes)
            .map_err(|_| "Couldn't decrypt the file.".to_string())?;
        // avoid name clashes inside one bundle
        let base = p.file_name().and_then(|n| n.to_str()).unwrap_or("file").to_string();
        let mut name = base.clone();
        let mut i = 2;
        while !used.insert(name.clone()) {
            name = match base.rsplit_once('.') {
                Some((stem, ext)) => format!("{stem} ({i}).{ext}"),
                None => format!("{base} ({i})"),
            };
            i += 1;
        }
        let dest = dir.join(&name);
        std::fs::write(&dest, data).map_err(map_err)?;
        out.push(dest);
    }
    Ok(out)
}

/* ---- clipboard ------------------------------------------------------- */

#[cfg(windows)]
mod win {
    use super::*;
    use windows::Win32::Foundation::{GlobalFree, HANDLE, HGLOBAL, POINT};
    use windows::Win32::System::DataExchange::{
        CloseClipboard, EmptyClipboard, OpenClipboard, RegisterClipboardFormatW, SetClipboardData,
    };
    use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};
    use windows::Win32::System::Ole::{CF_DIB, CF_HDROP};
    use windows::Win32::UI::Shell::DROPFILES;
    use windows::core::w;

    /// Keeps the clipboard open for one batch and always closes it (even on error).
    struct Clip;

    impl Clip {
        /// another app may hold the clipboard for a moment, so retry a few times
        fn open() -> Result<Self, String> {
            let mut last = String::new();
            for attempt in 0..5 {
                match unsafe { OpenClipboard(None) } {
                    Ok(()) => return Ok(Clip),
                    Err(e) => {
                        last = e.to_string();
                        if attempt < 4 {
                            std::thread::sleep(std::time::Duration::from_millis(25));
                        }
                    }
                }
            }
            Err(format!("Another app is using the clipboard ({last})."))
        }
    }

    impl Drop for Clip {
        fn drop(&mut self) {
            unsafe {
                let _ = CloseClipboard();
            }
        }
    }

    /// Copy bytes into a movable global block for the clipboard.
    /// The caller owns it until SetClipboardData works, after that don't free it.
    unsafe fn global_block(bytes: &[u8]) -> Result<HGLOBAL, String> {
        let h = GlobalAlloc(GMEM_MOVEABLE, bytes.len()).map_err(map_err)?;
        let base = GlobalLock(h);
        if base.is_null() {
            let _ = GlobalFree(Some(h));
            return Err("Couldn't allocate clipboard memory.".into());
        }
        std::ptr::copy_nonoverlapping(bytes.as_ptr(), base as *mut u8, bytes.len());
        let _ = GlobalUnlock(h);
        Ok(h)
    }

    /// Set one format, the clipboard owns h after success.
    unsafe fn put(format: u32, h: HGLOBAL) -> Result<(), String> {
        if SetClipboardData(format, Some(HANDLE(h.0))).is_err() {
            let _ = GlobalFree(Some(h));
            return Err("Windows refused the clipboard data.".into());
        }
        Ok(())
    }

    /// CF_HDROP data: DROPFILES header + wide file names, each NUL terminated,
    /// plus one extra NUL at the end.
    pub(super) fn hdrop_bytes(paths: &[PathBuf]) -> Vec<u8> {
        use std::os::windows::ffi::OsStrExt;
        let mut names: Vec<u16> = Vec::new();
        for p in paths {
            names.extend(p.as_os_str().encode_wide());
            names.push(0);
        }
        names.push(0);

        let header = std::mem::size_of::<DROPFILES>();
        let mut buf = vec![0u8; header + names.len() * 2];
        let df = DROPFILES {
            pFiles: header as u32,
            pt: POINT { x: 0, y: 0 },
            fNC: false.into(),
            // wide names so non-ASCII folders work
            fWide: true.into(),
        };
        unsafe {
            std::ptr::write_unaligned(buf.as_mut_ptr() as *mut DROPFILES, df);
            std::ptr::copy_nonoverlapping(
                names.as_ptr() as *const u8,
                buf.as_mut_ptr().add(header),
                names.len() * 2,
            );
        }
        buf
    }

    /// Put files on the clipboard like Explorer, so Ctrl+V works everywhere.
    pub fn copy_files(paths: &[PathBuf]) -> Result<(), String> {
        if paths.is_empty() {
            return Err("Nothing to copy.".into());
        }
        let payload = hdrop_bytes(paths);
        unsafe {
            // allocate before opening, so a failure doesn't wipe the user's clipboard
            let h = global_block(&payload)?;
            let _clip = Clip::open().inspect_err(|_| {
                let _ = GlobalFree(Some(h));
            })?;
            EmptyClipboard().map_err(map_err)?;
            put(CF_HDROP.0 as u32, h)
        }
    }

    /// DIB header, defined here instead of pulling in all of Win32_Graphics_Gdi.
    #[repr(C)]
    struct BitmapInfoHeader {
        size: u32,
        width: i32,
        /// positive = bottom-up rows
        height: i32,
        planes: u16,
        bit_count: u16,
        compression: u32,
        size_image: u32,
        x_ppm: i32,
        y_ppm: i32,
        clr_used: u32,
        clr_important: u32,
    }

    /// Pack an image as CF_DIB: 24-bit BGR, bottom-up, rows padded to 4 bytes.
    /// Transparency becomes white (apps that know alpha read the PNG format).
    pub(super) fn dib_bytes(img: &image::RgbaImage) -> Vec<u8> {
        let (w, h) = (img.width() as usize, img.height() as usize);
        let stride = (w * 3 + 3) & !3;
        let mut px = vec![0u8; stride * h];
        for y in 0..h {
            // bottom-up: the last row comes first
            let row = &mut px[(h - 1 - y) * stride..][..stride];
            for x in 0..w {
                let p = img.get_pixel(x as u32, y as u32).0;
                let a = p[3] as u32;
                let over = |c: u8| ((c as u32 * a + 255 * (255 - a)) / 255) as u8;
                row[x * 3] = over(p[2]);
                row[x * 3 + 1] = over(p[1]);
                row[x * 3 + 2] = over(p[0]);
            }
        }
        let head = BitmapInfoHeader {
            size: std::mem::size_of::<BitmapInfoHeader>() as u32,
            width: w as i32,
            height: h as i32,
            planes: 1,
            bit_count: 24,
            compression: 0, // BI_RGB
            size_image: px.len() as u32,
            x_ppm: 0,
            y_ppm: 0,
            clr_used: 0,
            clr_important: 0,
        };
        let mut buf = vec![0u8; std::mem::size_of::<BitmapInfoHeader>()];
        unsafe {
            std::ptr::write_unaligned(buf.as_mut_ptr() as *mut BitmapInfoHeader, head);
        }
        buf.extend_from_slice(&px);
        buf
    }

    /// Put an image on the clipboard as PNG (keeps transparency) and CF_DIB (older apps),
    /// like Explorer's Copy does.
    pub fn copy_image(png: &[u8], img: &image::RgbaImage) -> Result<(), String> {
        let dib = dib_bytes(img);
        unsafe {
            let png_fmt = RegisterClipboardFormatW(w!("PNG"));
            if png_fmt == 0 {
                return Err("Couldn't register the PNG clipboard format.".into());
            }
            let h_png = global_block(png)?;
            let h_dib = global_block(&dib).inspect_err(|_| {
                let _ = GlobalFree(Some(h_png));
            })?;
            let _clip = Clip::open().inspect_err(|_| {
                let _ = GlobalFree(Some(h_png));
                let _ = GlobalFree(Some(h_dib));
            })?;
            EmptyClipboard().map_err(map_err)?;
            put(png_fmt, h_png)?;
            put(CF_DIB.0 as u32, h_dib)
        }
    }
}

#[cfg(windows)]
pub use win::{copy_files, copy_image};

/* ---- the Windows Share sheet ----------------------------------------- */

/// Show the Share sheet for paths.
/// Must run on the thread that owns hwnd (the main thread), the WinRT object is tied
/// to that window. hwnd is an isize because Tauri uses an older windows crate.
#[cfg(windows)]
pub fn show_share_sheet(hwnd: isize, paths: Vec<String>, title: String) -> Result<(), String> {
    use std::cell::Cell;
    use windows::ApplicationModel::DataTransfer::{DataRequestedEventArgs, DataTransferManager};
    use windows::Foundation::TypedEventHandler;
    use windows::Storage::{IStorageItem, StorageFile};
    use windows::Win32::Foundation::HWND;
    use windows::Win32::System::Com::{CoInitializeEx, COINIT_APARTMENTTHREADED};
    // the Win32 -> WinRT bridge is in the shell (made for unpackaged desktop apps)
    use windows::Win32::UI::Shell::IDataTransferManagerInterop;
    use windows::core::{Interface, HSTRING};
    use windows_collections::IIterable;

    thread_local! {
        /// GetForWindow always returns the same manager, so replace the old handler
        /// instead of adding a new one each time
        static DATA_REQUESTED: Cell<i64> = const { Cell::new(0) };
    }

    if paths.is_empty() {
        return Err("Nothing to share.".into());
    }
    let hwnd = HWND(hwnd as *mut core::ffi::c_void);
    unsafe {
        // the main thread is already an STA, S_FALSE / RPC_E_CHANGED_MODE are fine
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
    }

    let interop: IDataTransferManagerInterop =
        windows::core::factory::<DataTransferManager, IDataTransferManagerInterop>()
            .map_err(|e| format!("The Windows share sheet isn't available ({e})."))?;
    let dtm: DataTransferManager = unsafe { interop.GetForWindow(hwnd) }.map_err(map_err)?;

    let handler = TypedEventHandler::<DataTransferManager, DataRequestedEventArgs>::new(
        move |_, args: windows::core::Ref<'_, DataRequestedEventArgs>| {
            let req = args.ok()?.Request()?;
            let data = req.Data()?;
            // Windows rejects a share without a title
            data.Properties()?.SetTitle(&HSTRING::from(title.as_str()))?;
            let mut items: Vec<Option<IStorageItem>> = Vec::with_capacity(paths.len());
            for p in &paths {
                // resolved here on the UI thread, StorageFile isn't Send/Sync
                match StorageFile::GetFileFromPathAsync(&HSTRING::from(p.as_str())).and_then(|op| op.get()) {
                    Ok(f) => items.push(Some(f.cast::<IStorageItem>()?)),
                    Err(e) => {
                        // show the error in the sheet (otherwise Windows shows a generic
                        // error)
                        req.FailWithDisplayText(&HSTRING::from(
                            format!("MiColl couldn’t open the files to share ({e}).").as_str(),
                        ))?;
                        return Ok(());
                    }
                }
            }
            // read-only, the target may copy but never change the originals
            data.SetStorageItemsReadOnly(&IIterable::<IStorageItem>::from(items))?;
            Ok(())
        },
    );

    DATA_REQUESTED.with(|t| {
        let prev = t.get();
        if prev != 0 {
            let _ = dtm.RemoveDataRequested(prev);
        }
        match dtm.DataRequested(&handler) {
            Ok(tok) => {
                t.set(tok);
                Ok(())
            }
            Err(e) => Err(map_err(e)),
        }
    })?;

    unsafe { interop.ShowShareUIForWindow(hwnd) }
        .map_err(|e| format!("Couldn’t open the Windows share sheet ({e})."))
}

/* ---- non-Windows stubs ----------------------------------------------- */

#[cfg(not(windows))]
pub fn copy_files(_paths: &[PathBuf]) -> Result<(), String> {
    Err("Copying files to the clipboard is only implemented on Windows.".into())
}

#[cfg(not(windows))]
pub fn copy_image(_png: &[u8], _img: &image::RgbaImage) -> Result<(), String> {
    Err("Copying an image to the clipboard is only implemented on Windows.".into())
}

#[cfg(not(windows))]
pub fn show_share_sheet(_hwnd: isize, _paths: Vec<String>, _title: String) -> Result<(), String> {
    Err("The system share sheet is only available on Windows.".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("micoll-wshare-{name}"));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn plain_files_are_shared_by_their_real_path() {
        let d = tmp("plain");
        let f = d.join("01.jpg");
        std::fs::write(&f, b"not encrypted").unwrap();
        let stage_dir = d.join("stage");
        let out = stage(&stage_dir, &[f.to_string_lossy().into_owned()], None).unwrap();
        // no copy, the clipboard should point at the library file
        assert_eq!(out, vec![f]);
        assert!(!stage_dir.exists());
    }

    #[test]
    fn encrypted_files_are_staged_as_plaintext_copies() {
        let d = tmp("enc");
        let dek = crypto::Dek::from_bytes([7u8; 32]);
        let f = d.join("02.png");
        std::fs::write(&f, dek.encrypt_bytes(b"secret pixels")).unwrap();
        let stage_dir = d.join("stage");
        let out = stage(&stage_dir, &[f.to_string_lossy().into_owned()], Some([7u8; 32])).unwrap();
        assert_eq!(out.len(), 1);
        assert_ne!(out[0], f, "an encrypted file must not be handed over as-is");
        assert!(out[0].starts_with(&stage_dir));
        assert_eq!(std::fs::read(&out[0]).unwrap(), b"secret pixels");
    }

    #[test]
    fn staging_an_encrypted_file_while_locked_is_refused() {
        let d = tmp("locked");
        let dek = crypto::Dek::from_bytes([9u8; 32]);
        let f = d.join("03.png");
        std::fs::write(&f, dek.encrypt_bytes(b"secret")).unwrap();
        let err = stage(&d.join("stage"), &[f.to_string_lossy().into_owned()], None).unwrap_err();
        assert!(err.contains("locked"), "got: {err}");
    }

    #[test]
    fn same_name_in_one_bundle_does_not_overwrite_itself() {
        let d = tmp("dupe");
        let dek = crypto::Dek::from_bytes([3u8; 32]);
        let (a, b) = (d.join("a"), d.join("b"));
        std::fs::create_dir_all(&a).unwrap();
        std::fs::create_dir_all(&b).unwrap();
        std::fs::write(a.join("01.jpg"), dek.encrypt_bytes(b"first")).unwrap();
        std::fs::write(b.join("01.jpg"), dek.encrypt_bytes(b"second")).unwrap();
        let stage_dir = d.join("stage");
        let out = stage(
            &stage_dir,
            &[
                a.join("01.jpg").to_string_lossy().into_owned(),
                b.join("01.jpg").to_string_lossy().into_owned(),
            ],
            Some([3u8; 32]),
        )
        .unwrap();
        assert_eq!(out.len(), 2);
        assert_ne!(out[0], out[1]);
        assert_eq!(std::fs::read(&out[0]).unwrap(), b"first");
        assert_eq!(std::fs::read(&out[1]).unwrap(), b"second");
    }

    #[test]
    fn a_missing_file_is_reported_not_skipped() {
        let d = tmp("missing");
        let err = stage(
            &d.join("stage"),
            &[d.join("nope.jpg").to_string_lossy().into_owned()],
            None,
        )
        .unwrap_err();
        assert!(err.contains("not found"), "got: {err}");
    }

    #[test]
    fn stale_staged_copies_are_pruned_and_fresh_ones_kept() {
        let d = tmp("prune");
        std::fs::create_dir_all(&d).unwrap();
        let old = d.join("old.jpg");
        let fresh = d.join("fresh.jpg");
        std::fs::write(&old, b"old").unwrap();
        std::fs::write(&fresh, b"fresh").unwrap();
        let long_ago =
            std::time::SystemTime::now() - std::time::Duration::from_secs(STAGE_TTL_SECS + 60);
        std::fs::File::options()
            .write(true)
            .open(&old)
            .unwrap()
            .set_modified(long_ago)
            .unwrap();
        prune_stage(&d);
        assert!(!old.exists(), "a copy older than the TTL should be gone");
        assert!(fresh.exists(), "a copy from this session must survive");
    }

    /// check the clipboard bytes: header offset, wide flag and the double-NUL name list
    #[cfg(windows)]
    #[test]
    fn hdrop_payload_has_the_layout_explorer_expects() {
        use windows::Win32::UI::Shell::DROPFILES;
        let paths = vec![PathBuf::from(r"C:\a\01.jpg"), PathBuf::from(r"C:\a\02.jpg")];
        let buf = super::win::hdrop_bytes(&paths);
        let header = std::mem::size_of::<DROPFILES>();
        let df: DROPFILES = unsafe { std::ptr::read_unaligned(buf.as_ptr() as *const DROPFILES) };
        assert_eq!(df.pFiles as usize, header, "names must start right after the header");
        assert!(df.fWide.as_bool(), "wide names, or non-ASCII paths break");
        let names: Vec<u16> = buf[header..]
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        let joined: Vec<String> = names
            .split(|&c| c == 0)
            .filter(|s| !s.is_empty())
            .map(|s| String::from_utf16_lossy(s))
            .collect();
        assert_eq!(joined, vec![r"C:\a\01.jpg".to_string(), r"C:\a\02.jpg".to_string()]);
        assert_eq!(&names[names.len() - 2..], &[0, 0], "list must end with a double NUL");
    }

    /// real clipboard round trip (put two files on it and read them back).
    /// Wipes the user's clipboard, so it's opt-in:
    /// cargo test --lib -- --ignored clipboard_round_trip
    #[cfg(windows)]
    #[test]
    #[ignore = "overwrites the real clipboard"]
    fn clipboard_round_trip_gives_back_the_same_paths() {
        use windows::Win32::System::DataExchange::{
            CloseClipboard, GetClipboardData, OpenClipboard,
        };
        use windows::Win32::System::Ole::CF_HDROP;
        use windows::Win32::UI::Shell::{DragQueryFileW, HDROP};

        let d = tmp("clipboard");
        let (a, b) = (d.join("01.jpg"), d.join("ü mlaut.png"));
        std::fs::write(&a, b"a").unwrap();
        std::fs::write(&b, b"b").unwrap();
        copy_files(&[a.clone(), b.clone()]).unwrap();

        let mut got: Vec<PathBuf> = Vec::new();
        unsafe {
            OpenClipboard(None).unwrap();
            let h = GetClipboardData(CF_HDROP.0 as u32).unwrap();
            let hdrop = HDROP(h.0);
            let count = DragQueryFileW(hdrop, u32::MAX, None);
            for i in 0..count {
                let mut buf = [0u16; 512];
                let n = DragQueryFileW(hdrop, i, Some(&mut buf)) as usize;
                got.push(PathBuf::from(String::from_utf16_lossy(&buf[..n])));
            }
            let _ = CloseClipboard();
        }
        assert_eq!(got, vec![a, b], "Explorer would paste exactly these");
    }

    /// DIB = header + rows, bottom-up, 4-byte stride (a mistake shows as garbage in Paint)
    #[cfg(windows)]
    #[test]
    fn dib_payload_is_bottom_up_24bit_with_padded_rows() {
        // 3x2 so the row needs padding (9 -> 12)
        let mut img = image::RgbaImage::new(3, 2);
        img.put_pixel(0, 0, image::Rgba([255, 0, 0, 255])); // top-left red
        img.put_pixel(0, 1, image::Rgba([0, 0, 255, 255])); // bottom-left blue
        let buf = super::win::dib_bytes(&img);
        let head = 40usize;
        assert_eq!(u32::from_le_bytes(buf[0..4].try_into().unwrap()), 40);
        assert_eq!(i32::from_le_bytes(buf[4..8].try_into().unwrap()), 3);
        assert_eq!(i32::from_le_bytes(buf[8..12].try_into().unwrap()), 2, "positive = bottom-up");
        assert_eq!(u16::from_le_bytes(buf[14..16].try_into().unwrap()), 24);
        assert_eq!(u32::from_le_bytes(buf[16..20].try_into().unwrap()), 0, "BI_RGB");
        let stride = 12;
        assert_eq!(buf.len(), head + stride * 2);
        // first row in the buffer = the image's last row: blue as BGR
        assert_eq!(&buf[head..head + 3], &[255, 0, 0]);
        // second row = the first image row: red as BGR
        assert_eq!(&buf[head + stride..head + stride + 3], &[0, 0, 255]);
    }
}
