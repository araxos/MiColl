//! Duplicate finder, two modes.
//!
//! Exact (default): only files with identical bytes. We SHA-256 only files that
//! have the same size (cheap filter), so most images are never read.
//!
//! Similar (opt-in): compares how the images look, to find resized or re-saved
//! copies (they share no bytes). Needs a decode per image and can be wrong,
//! so it's a separate mode.

use sha2::{Digest, Sha256};
use std::path::Path;

const IMAGE_EXTS: &[&str] = &[
    "jpg", "jpeg", "jfif", "png", "gif", "webp", "bmp", "avif", "tif", "tiff",
];

/// Only still images (no videos).
pub fn is_image(path: &str) -> bool {
    Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| IMAGE_EXTS.contains(&e.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

/// SHA-256 of a file as hex, None if it can't be read.
#[allow(dead_code)] // exercised by unit tests
pub fn content_hash(path: &Path) -> Option<String> {
    let bytes = std::fs::read(path).ok()?;
    let mut h = Sha256::new();
    h.update(&bytes);
    Some(format!("{:x}", h.finalize()))
}

/// SHA-256 of the decrypted content + pixel size, so two encrypted copies still match
/// (their ciphertext differs because of the random nonce).
pub fn content_hash_keyed(path: &Path, key: Option<[u8; 32]>) -> Option<(String, (u32, u32))> {
    let raw = std::fs::read(path).ok()?;
    let plain = if crate::crypto::is_encrypted(&raw) {
        crate::crypto::Dek::from_bytes(key?).decrypt_bytes(&raw).ok()?
    } else {
        raw
    };
    let mut h = Sha256::new();
    h.update(&plain);
    let hash = format!("{:x}", h.finalize());
    let dims = image::ImageReader::new(std::io::Cursor::new(&plain))
        .with_guessed_format()
        .ok()
        .and_then(|r| r.into_dimensions().ok())
        .unwrap_or((0, 0));
    Some((hash, dims))
}

/* ---- Perceptual hashing (the "similar" mode) --------------------------- */

/* Two steps:
   The 64-bit hash only suggests pairs ("same composition"). It can't tell a raised
   hand apart from a resize. So same_picture then compares the images on a 32x32 grid
   and checks the average difference AND the worst region: a resize is a bit off
   everywhere, a moved hand is very off in one spot. */

/// max hash distance to even check the pixels (loose on purpose)
pub const SIMILAR_MAX_DISTANCE: u32 = 12;

/// grid size, the fingerprint has SIG * SIG cells
const SIG: usize = 32;
/// region size in cells (4 -> 8x8 regions of 16 cells)
const BLOCK: usize = 4;
/// max average difference per cell (0-255) over the whole image.
/// resize + re-compress is about 2-6
const MEAN_MAX: u32 = 10;
/// max average difference in the worst region (catches the raised hand)
const BLOCK_MAX: u32 = 26;

/// what we keep per image: the hash for pairing and a 32x32 grey grid for deciding
#[derive(Clone)]
pub struct Fingerprint {
    pub hash: u64,
    cells: [u8; SIG * SIG],
}

/// how many bits two hashes differ in
pub fn hamming(a: u64, b: u64) -> u32 {
    (a ^ b).count_ones()
}

/// an almost empty image (blank page, flat color) matches every other empty one,
/// so they're skipped in the similar scan (the exact scan still finds copies)
pub fn is_featureless(hash: u64) -> bool {
    let ones = hash.count_ones();
    ones < 6 || ones > 58
}

/// hash + grid from one decode
pub fn fingerprint(bytes: &[u8]) -> Option<Fingerprint> {
    let img = image::load_from_memory(bytes).ok()?;
    let grey = img.to_luma8();

    // the hash: image shrunk to 9x8 grey, each cell compared with its right neighbour,
    // one bit each. Works across sizes because the grid is fixed and only relative
    // brightness is kept.
    let tiny = image::imageops::resize(&grey, 9, 8, image::imageops::FilterType::Triangle);
    let mut hash = 0u64;
    let mut bit = 0u32;
    for y in 0..8u32 {
        for x in 0..8u32 {
            if tiny.get_pixel(x, y)[0] > tiny.get_pixel(x + 1, y)[0] {
                hash |= 1u64 << bit;
            }
            bit += 1;
        }
    }

    // the grid stretched to a fixed square and normalized in brightness/contrast,
    // so a slightly brighter copy still matches
    let square = image::imageops::resize(
        &grey,
        SIG as u32,
        SIG as u32,
        image::imageops::FilterType::Triangle,
    );
    let mut v: Vec<f32> = square.pixels().map(|p| p[0] as f32).collect();
    let mean = v.iter().sum::<f32>() / v.len() as f32;
    let sd = (v.iter().map(|x| (x - mean) * (x - mean)).sum::<f32>() / v.len() as f32)
        .sqrt()
        .max(1.0);
    let mut cells = [0u8; SIG * SIG];
    for (c, x) in cells.iter_mut().zip(v.drain(..)) {
        *c = (128.0 + (x - mean) * (48.0 / sd)).clamp(0.0, 255.0) as u8;
    }

    Some(Fingerprint { hash, cells })
}

/// Are two fingerprints the same picture?
/// Average difference must be small AND no region may be far off.
pub fn same_picture(a: &Fingerprint, b: &Fingerprint) -> bool {
    if hamming(a.hash, b.hash) > SIMILAR_MAX_DISTANCE {
        return false;
    }
    let (mean, worst) = scores(a, b);
    mean <= MEAN_MAX && worst <= BLOCK_MAX
}

/// (average per cell, average in the worst region), both 0-255. Separate so the
/// tests can check the thresholds against real numbers.
pub fn scores(a: &Fingerprint, b: &Fingerprint) -> (u32, u32) {
    let per_block = (BLOCK * BLOCK) as u32;
    let mut total = 0u32;
    let mut worst = 0u32;
    for by in 0..SIG / BLOCK {
        for bx in 0..SIG / BLOCK {
            let mut sum = 0u32;
            for y in 0..BLOCK {
                for x in 0..BLOCK {
                    let i = (by * BLOCK + y) * SIG + bx * BLOCK + x;
                    sum += (a.cells[i] as i32 - b.cells[i] as i32).unsigned_abs();
                }
            }
            worst = worst.max(sum / per_block);
            total += sum;
        }
    }
    (total / (SIG * SIG) as u32, worst)
}

/// Read (decrypting if needed) + fingerprint.
pub fn fingerprint_keyed(path: &Path, key: Option<[u8; 32]>) -> Option<Fingerprint> {
    let raw = std::fs::read(path).ok()?;
    let plain = if crate::crypto::is_encrypted(&raw) {
        crate::crypto::Dek::from_bytes(key?).decrypt_bytes(&raw).ok()?
    } else {
        raw
    };
    fingerprint(&plain)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// fake drawing: background, a figure and a hand that's raised or lowered.
    /// mirror = a different picture, brighten = a copy saved lighter
    struct Scene {
        w: u32,
        h: u32,
        hand_up: bool,
        mirror: bool,
        brighten: i32,
        /// JPEG to simulate a real re-save
        jpeg: Option<u8>,
    }

    impl Default for Scene {
        fn default() -> Self {
            Scene { w: 1200, h: 560, hand_up: true, mirror: false, brighten: 0, jpeg: None }
        }
    }

    fn render(s: Scene) -> Vec<u8> {
        let (w, h) = (s.w, s.h);
        let mut img = image::RgbImage::new(w, h);
        let lift = |c: i32| c.clamp(0, 255) as u8;
        for (x, y, px) in img.enumerate_pixels_mut() {
            let sx = if s.mirror { w - 1 - x } else { x };
            let v = ((sx * 255 / w) as i32 + (y * 90 / h) as i32) % 256;
            *px = image::Rgb([
                lift(v + s.brighten),
                lift(v / 2 + s.brighten),
                lift(255 - v + s.brighten),
            ]);
        }
        // the figure
        for y in h / 3..h * 2 / 3 {
            for x in w * 2 / 5..w * 3 / 5 {
                img.put_pixel(x, y, image::Rgb([lift(240 + s.brighten); 3]));
            }
        }
        // fine texture on one side (resizing hurts detail the most)
        for y in 0..h {
            for x in w * 3 / 4..w {
                if (x / 3 + y / 3) % 2 == 0 {
                    let px = *img.get_pixel(x, y);
                    img.put_pixel(
                        x,
                        y,
                        image::Rgb([
                            lift(px[0] as i32 - 70),
                            lift(px[1] as i32 - 70),
                            lift(px[2] as i32 - 70),
                        ]),
                    );
                }
            }
        }
        // the hand, raised or lowered
        let (hx, hy) = if s.hand_up { (w * 3 / 5, h / 6) } else { (w * 3 / 5, h * 2 / 3) };
        for y in hy..(hy + h / 7).min(h) {
            for x in hx..(hx + w / 7).min(w) {
                img.put_pixel(x, y, image::Rgb([lift(18 + s.brighten); 3]));
            }
        }
        let mut out = Vec::new();
        match s.jpeg {
            Some(q) => image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, q)
                .encode_image(&image::DynamicImage::ImageRgb8(img))
                .unwrap(),
            None => image::DynamicImage::ImageRgb8(img)
                .write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Png)
                .unwrap(),
        }
        out
    }

    fn fp(s: Scene) -> Fingerprint {
        fingerprint(&render(s)).unwrap()
    }

    #[test]
    fn a_resized_copy_is_the_same_picture() {
        // the reported case: 2018x934 and 1280x592, the small one saved as JPEG
        let a = fp(Scene { w: 2018, h: 934, ..Default::default() });
        let b = fp(Scene { w: 1280, h: 592, jpeg: Some(72), ..Default::default() });
        assert!(same_picture(&a, &b), "a resized copy must still be recognised");
    }

    #[test]
    fn a_brighter_re_save_is_still_the_same_picture() {
        let a = fp(Scene::default());
        let b = fp(Scene { brighten: 22, jpeg: Some(80), ..Default::default() });
        assert!(same_picture(&a, &b), "a lighter re-save is the same picture");
    }

    #[test]
    fn the_same_pose_with_the_hand_moved_is_not_the_same_picture() {
        // what the hash alone got wrong: same picture, one limb moved
        let up = fp(Scene { hand_up: true, ..Default::default() });
        let down = fp(Scene { hand_up: false, ..Default::default() });
        assert!(
            !same_picture(&up, &down),
            "hand up and hand down are two pictures, not one"
        );
    }

    #[test]
    fn a_different_picture_is_not_the_same() {
        let a = fp(Scene::default());
        let b = fp(Scene { mirror: true, ..Default::default() });
        assert!(!same_picture(&a, &b), "different pictures must not group");
    }

    /// prints the measured numbers (--nocapture) and fails if the margins get thin
    /// (then MEAN_MAX / BLOCK_MAX need a look)
    #[test]
    fn the_thresholds_have_room_on_both_sides() {
        let a = fp(Scene { w: 2018, h: 934, ..Default::default() });
        let copy = fp(Scene { w: 1280, h: 592, jpeg: Some(72), ..Default::default() });
        let moved = fp(Scene { hand_up: false, ..Default::default() });
        let (cm, cw) = scores(&a, &copy);
        let (mm, mw) = scores(&a, &moved);
        println!("resized copy: mean {cm}, worst region {cw}");
        println!("hand moved:   mean {mm}, worst region {mw}");
        assert!(cw * 2 <= BLOCK_MAX, "a real copy sits too close to the limit ({cw})");
        assert!(mw >= BLOCK_MAX * 2, "a moved limb sits too close to the limit ({mw})");
    }

    #[test]
    fn a_blank_image_is_rejected_as_featureless() {
        let img = image::RgbImage::from_pixel(600, 400, image::Rgb([30, 30, 30]));
        let mut bytes = Vec::new();
        image::DynamicImage::ImageRgb8(img)
            .write_to(&mut std::io::Cursor::new(&mut bytes), image::ImageFormat::Png)
            .unwrap();
        assert!(is_featureless(fingerprint(&bytes).unwrap().hash));
    }

    #[test]
    fn identical_bytes_match_different_differ() {
        let dir = std::env::temp_dir();
        let a = dir.join("micoll_ch_a.bin");
        let b = dir.join("micoll_ch_b.bin");
        let c = dir.join("micoll_ch_c.bin");
        std::fs::write(&a, b"hello world").unwrap();
        std::fs::write(&b, b"hello world").unwrap();
        std::fs::write(&c, b"hello WORLD").unwrap();
        assert_eq!(content_hash(&a), content_hash(&b));
        assert_ne!(content_hash(&a), content_hash(&c));
        for p in [&a, &b, &c] {
            let _ = std::fs::remove_file(p);
        }
    }
}
