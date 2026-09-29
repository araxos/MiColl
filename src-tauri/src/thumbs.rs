//! Thumbnail cache.
//! Grids show small covers, so we make a small JPEG once and cache it, keyed by
//! path + mtime + size (edits make a new one). The viewer still loads originals.

use crate::crypto;
use base64::{engine::general_purpose::STANDARD, Engine as _};
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::io::Cursor;
use std::path::Path;
use std::sync::{Condvar, Mutex, OnceLock};
use std::time::UNIX_EPOCH;

/* ---- generation gate --------------------------------------------------- */
// A fast scroll can ask for many thumbnails at once, each decodes a big image.
// So only a few are made at the same time (cached ones aren't limited).
// The newest request goes first, that's what's on screen now.

struct Gate {
    state: Mutex<GateState>,
    cv: Condvar,
    max: usize,
}

struct GateState {
    running: usize,
    /// tickets of the waiting threads, higher = asked later
    waiting: Vec<u64>,
    next: u64,
}

impl Gate {
    fn new(max: usize) -> Gate {
        Gate {
            state: Mutex::new(GateState { running: 0, waiting: Vec::new(), next: 0 }),
            cv: Condvar::new(),
            max,
        }
    }

    fn acquire(&self) -> GatePass<'_> {
        let mut s = self.state.lock().expect("thumb gate");
        let ticket = s.next;
        s.next += 1;
        s.waiting.push(ticket);
        while s.running >= self.max || s.waiting.iter().max() != Some(&ticket) {
            s = self.cv.wait(s).expect("thumb gate");
        }
        s.waiting.retain(|&t| t != ticket);
        s.running += 1;
        // a slot may still be free for the next one
        self.cv.notify_all();
        GatePass(self)
    }
}

fn gate() -> &'static Gate {
    static G: OnceLock<Gate> = OnceLock::new();
    G.get_or_init(|| Gate::new(max_concurrent()))
}

fn max_concurrent() -> usize {
    std::thread::available_parallelism()
        .map(|n| (n.get() / 2).clamp(2, 6))
        .unwrap_or(3)
}

struct GatePass<'a>(&'a Gate);
impl Drop for GatePass<'_> {
    fn drop(&mut self) {
        self.0.state.lock().expect("thumb gate").running -= 1;
        self.0.cv.notify_all();
    }
}

fn cache_key(src: &str, mtime: u64, size: u32) -> String {
    let mut h = DefaultHasher::new();
    src.hash(&mut h);
    mtime.hash(&mut h);
    size.hash(&mut h);
    format!("{:016x}.jpg", h.finish())
}

/// Read a file, decrypting it if needed. key = session key (None if off/locked).
fn read_source(src: &str, key: Option<[u8; 32]>) -> Result<Vec<u8>, String> {
    let bytes = std::fs::read(src).map_err(|e| format!("read {src}: {e}"))?;
    if crypto::is_encrypted(&bytes) {
        let k = key.ok_or("locked: cannot decrypt this file")?;
        crypto::Dek::from_bytes(k).decrypt_bytes(&bytes)
    } else {
        Ok(bytes)
    }
}

/// Make (or reuse) a thumbnail, returns the JPEG bytes.
/// The disk cache is encrypted when encryption is on.
pub fn thumb_jpeg(cache_dir: &Path, src: &str, size: u32, key: Option<[u8; 32]>) -> Result<Vec<u8>, String> {
    let meta = match std::fs::metadata(src) {
        Ok(m) => m,
        Err(e) => {
            // source not reachable (e.g. on an unplugged MiSD disk): use the saved MiSD
            // preview,
            // otherwise the tile shows its gradient
            return sd_preview_jpeg(cache_dir, src, key).ok_or_else(|| format!("stat {src}: {e}"));
        }
    };
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);

    std::fs::create_dir_all(cache_dir).map_err(|e| e.to_string())?;
    let out = cache_dir.join(cache_key(src, mtime, size));
    let read_cache = || -> Option<Vec<u8>> {
        let cached = std::fs::read(&out).ok()?;
        if crypto::is_encrypted(&cached) {
            // encrypted cache but no key -> make it again
            crypto::Dek::from_bytes(key?).decrypt_bytes(&cached).ok()
        } else {
            Some(cached)
        }
    };
    if let Some(cached) = read_cache() {
        return Ok(cached);
    }

    // not cached -> decode. Wait for a slot, then check the cache again
    // (someone may have made it while we waited)
    let _pass = gate().acquire();
    if let Some(cached) = read_cache() {
        return Ok(cached);
    }

    let src_bytes = read_source(src, key)?;
    let img = image::load_from_memory(&src_bytes).map_err(|e| format!("decode {src}: {e}"))?;
    // thumbnail keeps the ratio, JPEG has no alpha
    let thumb = img.thumbnail(size, size).to_rgb8();
    let mut jpeg = Vec::new();
    image::DynamicImage::ImageRgb8(thumb)
        .write_to(&mut Cursor::new(&mut jpeg), image::ImageFormat::Jpeg)
        .map_err(|e| format!("encode thumb: {e}"))?;

    // write the cache (encrypted with a key)
    let to_cache = match key {
        Some(k) => crypto::Dek::from_bytes(k).encrypt_bytes(&jpeg),
        None => jpeg.clone(),
    };
    let _ = std::fs::write(&out, &to_cache);
    Ok(jpeg)
}


/* ---- animated covers ---------------------------------------------------- */
// The webview decodes a GIF at full size on every frame, even in a small tile.
// So we also cache a small re-encoded version of the animation.

/// Max size of an animated cover (covers are 150-400px wide).
const GIF_MAX_EDGE: u32 = 512;

/// Max frames (the encoder writes full frames, long GIFs would get huge).
const GIF_MAX_FRAMES: usize = 150;

/// Re-encode src as a GIF that fits size x size, cached like a thumbnail.
/// Ok(None) = not worth it (already small or no frames), then the original is used.
pub fn gif_thumb(
    cache_dir: &Path,
    src: &str,
    size: u32,
    key: Option<[u8; 32]>,
) -> Result<Option<Vec<u8>>, String> {
    let size = size.clamp(64, GIF_MAX_EDGE);
    let meta = std::fs::metadata(src).map_err(|e| format!("stat {src}: {e}"))?;
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);

    std::fs::create_dir_all(cache_dir).map_err(|e| e.to_string())?;
    let out_path = cache_dir.join(gif_cache_key(src, mtime, size));
    let read_cache = || -> Option<Vec<u8>> {
        let cached = std::fs::read(&out_path).ok()?;
        if crypto::is_encrypted(&cached) {
            crypto::Dek::from_bytes(key?).decrypt_bytes(&cached).ok()
        } else {
            Some(cached)
        }
    };
    if let Some(cached) = read_cache() {
        return Ok(Some(cached));
    }

    // cheap check from the header first
    if let Some((w, h)) = dimensions(src, key) {
        // already close to the target size, re-encoding would only lose quality
        if w * 4 <= size * 5 && h * 4 <= size * 5 {
            return Ok(None);
        }
    }

    // the heaviest thing here, so it uses the same gate (and checks the cache again)
    let _pass = gate().acquire();
    if let Some(cached) = read_cache() {
        return Ok(Some(cached));
    }

    let src_bytes = read_source(src, key)?;
    let decoder = image::codecs::gif::GifDecoder::new(Cursor::new(src_bytes))
        .map_err(|e| format!("decode {src}: {e}"))?;

    let mut out: Vec<u8> = Vec::new();
    let mut frames = 0usize;
    {
        // speed 10 of 30, the best quality is wasted at this size
        let mut enc = image::codecs::gif::GifEncoder::new_with_speed(&mut out, 10);
        enc.set_repeat(image::codecs::gif::Repeat::Infinite)
            .map_err(|e| format!("encode gif: {e}"))?;
        // frame by frame, holding all frames would use a lot of memory
        for frame in image::AnimationDecoder::into_frames(decoder) {
            let frame = frame.map_err(|e| format!("decode {src}: {e}"))?;
            let delay = frame.delay();
            let buf = frame.into_buffer();
            let (w, h) = fit_within(buf.width(), buf.height(), size);
            let small = image::imageops::thumbnail(&buf, w, h);
            enc.encode_frame(image::Frame::from_parts(small, 0, 0, delay))
                .map_err(|e| format!("encode gif: {e}"))?;
            frames += 1;
            if frames >= GIF_MAX_FRAMES {
                break;
            }
        }
    }
    if frames == 0 {
        return Ok(None);
    }

    let to_cache = match key {
        Some(k) => crypto::Dek::from_bytes(k).encrypt_bytes(&out),
        None => out.clone(),
    };
    let _ = std::fs::write(&out_path, &to_cache);
    Ok(Some(out))
}

/// longest edge = edge, keeps the ratio, never bigger
fn fit_within(w: u32, h: u32, edge: u32) -> (u32, u32) {
    let long = w.max(h).max(1);
    if long <= edge {
        return (w.max(1), h.max(1));
    }
    let scale = edge as f64 / long as f64;
    (
        ((w as f64 * scale).round() as u32).max(1),
        ((h as f64 * scale).round() as u32).max(1),
    )
}

fn gif_cache_key(src: &str, mtime: u64, size: u32) -> String {
    let mut h = DefaultHasher::new();
    src.hash(&mut h);
    mtime.hash(&mut h);
    size.hash(&mut h);
    // different key than the still cache
    "animated".hash(&mut h);
    format!("{:016x}.gif", h.finish())
}

/* ---- MiSD persistent previews ------------------------------------------ */
// Rewards on the MiSD disk still need a cover while it's unplugged. The normal
// cache needs the mtime, so the transport saves one extra thumbnail per path
// (keyed by path only) under <cache>/sd/.

fn sd_preview_path(cache_dir: &Path, src: &str) -> std::path::PathBuf {
    let mut h = DefaultHasher::new();
    src.hash(&mut h);
    cache_dir.join("sd").join(format!("{:016x}.jpg", h.finish()))
}

/// Save the MiSD preview for src (call while the file is still local). Encrypted with a
/// key.
pub fn persist_sd_preview(cache_dir: &Path, src: &str, key: Option<[u8; 32]>) -> Result<(), String> {
    let out = sd_preview_path(cache_dir, src);
    if out.exists() {
        return Ok(());
    }
    let jpeg = thumb_jpeg(cache_dir, src, 512, key)?;
    if let Some(dir) = out.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let to_store = match key {
        Some(k) => crypto::Dek::from_bytes(k).encrypt_bytes(&jpeg),
        None => jpeg,
    };
    std::fs::write(&out, to_store).map_err(|e| e.to_string())
}

/// Make the preview for from also work for to. The transport changes the paths
/// right after, and the lookup uses the new path. Copies the bytes as they are
/// (so it works while locked).
pub fn alias_sd_preview(cache_dir: &Path, from: &str, to: &str) -> Result<(), String> {
    let src = sd_preview_path(cache_dir, from);
    let dst = sd_preview_path(cache_dir, to);
    if src == dst || dst.exists() {
        return Ok(());
    }
    if !src.exists() {
        return Err(format!("no stored preview for {from}"));
    }
    if let Some(dir) = dst.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    std::fs::copy(&src, &dst).map(|_| ()).map_err(|e| e.to_string())
}

/// Is there a MiSD preview for src?
pub fn has_sd_preview(cache_dir: &Path, src: &str) -> bool {
    sd_preview_path(cache_dir, src).exists()
}

/// The MiSD preview for src, decrypted.
pub fn sd_preview_jpeg(cache_dir: &Path, src: &str, key: Option<[u8; 32]>) -> Option<Vec<u8>> {
    let bytes = std::fs::read(sd_preview_path(cache_dir, src)).ok()?;
    if crypto::is_encrypted(&bytes) {
        crypto::Dek::from_bytes(key?).decrypt_bytes(&bytes).ok()
    } else {
        Some(bytes)
    }
}

/// Thumbnail as a base64 data URL.
pub fn thumb_data_url(cache_dir: &Path, src: &str, size: u32, key: Option<[u8; 32]>) -> Result<String, String> {
    let jpeg = thumb_jpeg(cache_dir, src, size, key)?;
    Ok(format!("data:image/jpeg;base64,{}", STANDARD.encode(jpeg)))
}

/// Image size, decrypting if needed. For normal files only the header is read.
/// Used to decide if an image needs a smaller preview. None if unreadable.
pub fn dimensions(src: &str, key: Option<[u8; 32]>) -> Option<(u32, u32)> {
    if crypto::file_is_encrypted(Path::new(src)) {
        let bytes = read_source(src, key).ok()?;
        let img = image::load_from_memory(&bytes).ok()?;
        Some((img.width(), img.height()))
    } else {
        image::image_dimensions(src).ok()
    }
}

pub fn mime_for(path: &str) -> &'static str {
    match path.rsplit('.').next().map(|e| e.to_ascii_lowercase()).as_deref() {
        Some("png") => "image/png",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("bmp") => "image/bmp",
        Some("avif") => "image/avif",
        _ => "image/jpeg",
    }
}

/// Shrink an inline data URL image to fit size x size as JPEG.
/// Template covers used to be full size (58 MB of images in one template).
/// None = leave it (can't decode, or already small enough).
pub fn shrink_data_url(data_url: &str, size: u32) -> Option<String> {
    let payload = data_url.split(";base64,").nth(1)?;
    let bytes = STANDARD.decode(payload.trim()).ok()?;
    let img = image::load_from_memory(&bytes).ok()?;
    if img.width() <= size && img.height() <= size {
        return None;
    }
    let small = img.thumbnail(size, size).to_rgb8();
    let mut jpeg = Vec::new();
    image::DynamicImage::ImageRgb8(small)
        .write_to(&mut Cursor::new(&mut jpeg), image::ImageFormat::Jpeg)
        .ok()?;
    Some(format!("data:image/jpeg;base64,{}", STANDARD.encode(jpeg)))
}

/// Read an original image (decrypting if needed) -> data URL for the viewer.
pub fn image_data_url(src: &str, key: Option<[u8; 32]>) -> Result<String, String> {
    let bytes = read_source(src, key)?;
    Ok(format!("data:{};base64,{}", mime_for(src), STANDARD.encode(bytes)))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// must shrink big ones and leave small ones alone
    #[test]
    fn shrink_data_url_resizes_only_what_is_too_big() {
        let png = |w: u32, h: u32| {
            let img = image::DynamicImage::ImageRgb8(image::RgbImage::from_fn(w, h, |x, y| {
                image::Rgb([(x % 256) as u8, (y % 256) as u8, 128])
            }));
            let mut buf = Vec::new();
            img.write_to(&mut Cursor::new(&mut buf), image::ImageFormat::Png).unwrap();
            format!("data:image/png;base64,{}", STANDARD.encode(buf))
        };

        let big = png(1056, 1056);
        let out = shrink_data_url(&big, 512).expect("an oversized cover must be re-encoded");
        assert!(out.starts_with("data:image/jpeg;base64,"), "re-encoded as JPEG");
        // check the size, not the bytes (a smooth gradient compresses better as PNG)
        let bytes = STANDARD.decode(out.split(";base64,").nth(1).unwrap()).unwrap();
        let img = image::load_from_memory(&bytes).unwrap();
        assert_eq!((img.width(), img.height()), (512, 512));

        assert!(shrink_data_url(&png(400, 400), 512).is_none(), "already within budget");
        assert!(shrink_data_url("data:image/png;base64,not-an-image", 512).is_none());
    }

    #[test]
    fn sd_preview_survives_a_missing_source() {
        let base = std::env::temp_dir().join(format!("micoll_sdthumb_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        let src = base.join("img.png");
        image::RgbImage::from_pixel(32, 32, image::Rgb([200, 80, 40]))
            .save(&src)
            .unwrap();
        let src_s = src.to_string_lossy().into_owned();
        let cache = base.join("thumbs");

        // a missing source is an error before saving
        assert!(thumb_jpeg(&cache, &format!("{src_s}.gone"), 256, None).is_err());

        persist_sd_preview(&cache, &src_s, None).unwrap();
        std::fs::remove_file(&src).unwrap(); // "unplug the disk"

        let jpeg = thumb_jpeg(&cache, &src_s, 256, None).expect("persisted preview serves offline");
        assert!(image::load_from_memory(&jpeg).is_ok());
        let _ = std::fs::remove_dir_all(&base);
    }

    /// the animated cover must keep every frame and timing, and small GIFs stay as they are
    #[test]
    fn animated_cover_shrinks_the_frames_and_keeps_them() {
        let base = std::env::temp_dir().join(format!("micoll_gif_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();

        let write_gif = |name: &str, w: u32, h: u32, n: u32| -> String {
            let path = base.join(name);
            let file = std::fs::File::create(&path).unwrap();
            let mut enc = image::codecs::gif::GifEncoder::new_with_speed(file, 30);
            enc.set_repeat(image::codecs::gif::Repeat::Infinite).unwrap();
            for i in 0..n {
                let img = image::RgbaImage::from_fn(w, h, |x, y| {
                    image::Rgba([((x + i * 40) % 256) as u8, (y % 256) as u8, 90, 255])
                });
                enc.encode_frame(image::Frame::from_parts(
                    img,
                    0,
                    0,
                    image::Delay::from_numer_denom_ms(80, 1),
                ))
                .unwrap();
            }
            drop(enc);
            path.to_string_lossy().into_owned()
        };

        let cache = base.join("thumbs");
        let big = write_gif("big.gif", 900, 1200, 4);

        let out = gif_thumb(&cache, &big, 256, None)
            .unwrap()
            .expect("an oversized cover is re-encoded");
        let frames = image::AnimationDecoder::into_frames(
            image::codecs::gif::GifDecoder::new(Cursor::new(out.clone())).unwrap(),
        )
        .collect_frames()
        .unwrap();
        assert_eq!(frames.len(), 4, "every frame survives");
        let buf = frames[0].buffer();
        assert!(
            buf.width() <= 256 && buf.height() <= 256,
            "got {}x{}",
            buf.width(),
            buf.height()
        );
        assert_eq!(
            frames[0].delay().numer_denom_ms(),
            (80, 1),
            "the timing stays the file's own"
        );

        // second call comes from the cache
        assert_eq!(gif_thumb(&cache, &big, 256, None).unwrap().unwrap(), out);

        // already small, the original is used
        let small = write_gif("small.gif", 240, 240, 2);
        assert!(gif_thumb(&cache, &small, 256, None).unwrap().is_none());

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn generates_and_caches_thumbnail() {
        // make a test image in temp, bigger than the thumb size
        let base = std::env::temp_dir().join(format!("micoll_thumbs_src_{}", std::process::id()));
        std::fs::create_dir_all(&base).unwrap();
        let path = base.join("01a.jpg");
        image::RgbImage::from_fn(800, 600, |x, y| image::Rgb([(x % 256) as u8, (y % 256) as u8, 128]))
            .save(&path)
            .unwrap();
        let src = path.to_str().unwrap();
        let cache = std::env::temp_dir().join("micoll_thumbs_test");
        let _ = std::fs::remove_dir_all(&cache);

        let jpeg = thumb_jpeg(&cache, src, 256, None).unwrap();
        assert!(!jpeg.is_empty());
        let img = image::load_from_memory(&jpeg).unwrap();
        assert!(img.width() <= 256 && img.height() <= 256, "got {}x{}", img.width(), img.height());

        // second call hits the cache
        let jpeg2 = thumb_jpeg(&cache, src, 256, None).unwrap();
        assert_eq!(jpeg, jpeg2);
        let _ = std::fs::remove_dir_all(&base);
    }
}

#[cfg(test)]
mod gate_tests {
    use super::Gate;
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    /// with the gate full the last request goes first
    #[test]
    fn the_newest_request_goes_first() {
        let gate = Arc::new(Gate::new(1));
        let order = Arc::new(Mutex::new(Vec::new()));
        let held = gate.acquire();
        let mut threads = Vec::new();
        for i in 0..4 {
            let (gate, order) = (gate.clone(), order.clone());
            threads.push(std::thread::spawn(move || {
                let _pass = gate.acquire();
                order.lock().unwrap().push(i);
                std::thread::sleep(Duration::from_millis(20));
            }));
            // let each one reach the queue first
            std::thread::sleep(Duration::from_millis(60));
        }
        drop(held);
        for t in threads {
            t.join().unwrap();
        }
        assert_eq!(*order.lock().unwrap(), vec![3, 2, 1, 0]);
    }

    /// all free slots get used
    #[test]
    fn free_slots_are_not_left_idle() {
        let gate = Arc::new(Gate::new(2));
        let a = gate.acquire();
        let b = gate.acquire();
        let running = Arc::new(Mutex::new(0usize));
        let peak = Arc::new(Mutex::new(0usize));
        let mut threads = Vec::new();
        for _ in 0..2 {
            let (gate, running, peak) = (gate.clone(), running.clone(), peak.clone());
            threads.push(std::thread::spawn(move || {
                let _pass = gate.acquire();
                let now = {
                    let mut r = running.lock().unwrap();
                    *r += 1;
                    *r
                };
                let mut p = peak.lock().unwrap();
                *p = (*p).max(now);
                drop(p);
                std::thread::sleep(Duration::from_millis(150));
                *running.lock().unwrap() -= 1;
            }));
            std::thread::sleep(Duration::from_millis(40));
        }
        drop(a);
        drop(b);
        for t in threads {
            t.join().unwrap();
        }
        assert_eq!(*peak.lock().unwrap(), 2);
    }
}
