//! Is a picture landscape? Only its header is read (a JPEG's few KB, not the whole file),
//! for the picture picker's filter over a creator's whole collection.

use crate::{crypto, thumbs};
use std::io::{BufReader, Cursor, Read, Seek};
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};

/// Width and height as it's seen (a picture turned by its EXIF counts turned).
fn size_of(mut r: impl Read + Seek + std::io::BufRead) -> Option<(u32, u32)> {
    let mut start = [0u8; 3];
    r.read_exact(&mut start).ok()?;
    r.rewind().ok()?;
    let (w, h, turn) = if start == [0xFF, 0xD8, 0xFF] {
        let mut dec = jpeg_decoder::Decoder::new(r);
        dec.read_info().ok()?;
        let info = dec.info()?;
        let turn = dec.exif_data().and_then(image::metadata::Orientation::from_exif_chunk);
        (u32::from(info.width), u32::from(info.height), turn)
    } else {
        use image::ImageDecoder;
        let mut dec = image::ImageReader::new(r).with_guessed_format().ok()?.into_decoder().ok()?;
        let (w, h) = dec.dimensions();
        (w, h, dec.orientation().ok())
    };
    use image::metadata::Orientation::{Rotate270, Rotate270FlipH, Rotate90, Rotate90FlipH};
    Some(match turn {
        Some(Rotate90 | Rotate270 | Rotate90FlipH | Rotate270FlipH) => (h, w),
        _ => (w, h),
    })
}

/// None when it can't be told. An encrypted one, or one on an unplugged MiSD disk, is told
/// by its thumbnail.
fn landscape(path: &str, thumb_dir: &Path, key: Option<[u8; 32]>) -> Option<bool> {
    let p = Path::new(path);
    let own = if crypto::file_is_encrypted(p) {
        None
    } else {
        std::fs::File::open(p).ok().and_then(|f| size_of(BufReader::new(f)))
    };
    let (w, h) = match own {
        Some(s) => s,
        None => size_of(Cursor::new(thumbs::thumb_jpeg(thumb_dir, path, 256, key).ok()?))?,
    };
    Some(w > h)
}

/// For each path, in the same order.
pub fn landscapes(paths: &[String], thumb_dir: &Path, key: Option<[u8; 32]>) -> Vec<Option<bool>> {
    let next = AtomicUsize::new(0);
    let threads = std::thread::available_parallelism().map_or(4, |n| n.get()).min(8).min(paths.len().max(1));
    let parts: Vec<Vec<(usize, Option<bool>)>> = std::thread::scope(|s| {
        let workers: Vec<_> = (0..threads)
            .map(|_| {
                s.spawn(|| {
                    let mut out = Vec::new();
                    loop {
                        let i = next.fetch_add(1, Ordering::Relaxed);
                        let Some(p) = paths.get(i) else { break out };
                        out.push((i, landscape(p, thumb_dir, key)));
                    }
                })
            })
            .collect();
        workers.into_iter().filter_map(|w| w.join().ok()).collect()
    });
    let mut out = vec![None; paths.len()];
    for (i, v) in parts.into_iter().flatten() {
        out[i] = v;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn jpeg(w: u32, h: u32) -> Vec<u8> {
        let mut b = Vec::new();
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut b, 80)
            .encode_image(&image::RgbImage::from_pixel(w, h, image::Rgb([90, 120, 60])))
            .unwrap();
        b
    }

    /// With an EXIF orientation put in right after the start of the file.
    fn turned(w: u32, h: u32, orientation: u8) -> Vec<u8> {
        let b = jpeg(w, h);
        let mut exif = b"Exif\0\0".to_vec();
        // TIFF, little endian, one entry: 0x0112 = orientation
        exif.extend_from_slice(&[b'I', b'I', 42, 0, 8, 0, 0, 0, 1, 0, 0x12, 1, 3, 0, 1, 0, 0, 0, orientation, 0, 0, 0, 0, 0, 0, 0]);
        let len = (exif.len() + 2) as u16;
        let mut out = b[..2].to_vec();
        out.extend_from_slice(&[0xFF, 0xE1, (len >> 8) as u8, len as u8]);
        out.extend_from_slice(&exif);
        out.extend_from_slice(&b[2..]);
        out
    }

    #[test]
    fn tells_landscape_in_every_format_and_turned() {
        let dir = std::env::temp_dir().join(format!("micoll_shape_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let thumbs = dir.join("thumbs");
        let put = |name: &str, data: Vec<u8>| {
            let p = dir.join(name);
            std::fs::write(&p, data).unwrap();
            p.to_string_lossy().to_string()
        };
        let save = |name: &str, w: u32, h: u32| {
            let p = dir.join(name);
            image::RgbImage::from_pixel(w, h, image::Rgb([9, 9, 9])).save(&p).unwrap();
            p.to_string_lossy().to_string()
        };
        let mut paths = vec![
            put("wide.jpg", jpeg(300, 200)),
            put("tall.jpg", jpeg(200, 300)),
            put("square.jpg", jpeg(200, 200)),
            // lies on its side in the file, is shown upright
            put("turned.jpg", turned(300, 200, 6)),
            put("half.jpg", turned(300, 200, 3)),
            save("wide.png", 40, 30),
            save("tall.png", 30, 40),
            save("wide.bmp", 40, 30),
            save("wide.webp", 40, 30),
            // a png that's called jpg
            put("other.jpg", std::fs::read(dir.join("tall.png")).unwrap()),
            put("broken.jpg", b"no picture".to_vec()),
            dir.join("gone.jpg").to_string_lossy().to_string(),
        ];
        let want = [
            Some(true), Some(false), Some(false), Some(false), Some(true), Some(true), Some(false), Some(true),
            Some(true), Some(false), None, None,
        ];
        assert_eq!(landscapes(&paths, &thumbs, None), want);
        // only the header: the rest of a JPEG needn't even be there
        let whole = jpeg(900, 600);
        paths = vec![put("cut.jpg", whole[..700].to_vec())];
        assert_eq!(landscapes(&paths, &thumbs, None), [Some(true)]);
        // an encrypted one by its thumbnail, with the key
        let key = [7u8; 32];
        let enc = put("enc.jpg", crypto::Dek::from_bytes(key).encrypt_bytes(&jpeg(300, 200)));
        assert_eq!(landscapes(&[enc.clone()], &thumbs, Some(key)), [Some(true)]);
        assert_eq!(landscapes(&[enc], &dir.join("t2"), None), [None]);
        assert!(landscapes(&[], &thumbs, None).is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
