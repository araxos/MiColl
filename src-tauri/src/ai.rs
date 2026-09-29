//! Local AI image models with ONNX Runtime (nothing leaves the PC).
//! Each model is downloaded once into <app_data>/models/:
//!
//! * LaMa (~200 MB) - object remover, works on a 512x512 window.
//! * Real-ESRGAN general x4v3 (~5 MB) - 4x upscaling for the resize tool.
//!   Runs in tiles so any image size fits in memory.
//! * IS-Net general-use (~178 MB) - cutout tool, one 1024x1024 pass gives the alpha mask.

use image::imageops::FilterType;
use image::{GrayImage, RgbaImage};
use ort::session::builder::GraphOptimizationLevel;
use ort::session::Session;
use ort::value::Tensor;
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

/// LaMa input size (fixed by the export).
const LAMA_NET: u32 = 512;
/// IS-Net input size (the export uses [1,3,1024,1024]).
const ISNET_NET: u32 = 1024;

/* ---- model registry --------------------------------------------------- */

#[derive(Clone, Copy, PartialEq, Eq, Hash)]
pub enum Model {
    Lama,
    Esrgan,
    Isnet,
}

impl Model {
    pub fn from_id(id: &str) -> Result<Model, String> {
        match id {
            "lama" => Ok(Model::Lama),
            "esrgan" => Ok(Model::Esrgan),
            "isnet" => Ok(Model::Isnet),
            other => Err(format!("unknown AI model '{other}'")),
        }
    }
    pub fn file(self) -> &'static str {
        match self {
            // LaMa fp32 ONNX (512x512) from Hugging Face.
            Model::Lama => "lama_fp32.onnx",
            // realesr-general-x4v3: small official Real-ESRGAN model, fast on CPU, good for
            // art.
            Model::Esrgan => "realesr-general-x4v3.onnx",
            // IS-Net general-use, best cutout model in rembg. Apache-2.0 (RMBG-1.4 is
            // non-commercial).
            Model::Isnet => "isnet-general-use.onnx",
        }
    }
    pub fn url(self) -> &'static str {
        match self {
            // all links are pinned (commit or release tag) so the file behind them can't change
            Model::Lama => "https://huggingface.co/Carve/LaMa-ONNX/resolve/c3c0c9e468934d62e79c329e35d82dd09ff8c444/lama_fp32.onnx",
            Model::Esrgan => "https://huggingface.co/OwlMaster/AllFilesRope/resolve/d783e61585b3d83a85c91ca8a3b299e8ade94d72/realesr-general-x4v3.onnx",
            // rembg's own release asset
            Model::Isnet => "https://github.com/danielgatis/rembg/releases/download/v0.0.0/isnet-general-use.onnx",
        }
    }
    /// SHA-256 of the real file. A download that doesn't match gets thrown away.
    /// LaMa + ESRGAN: from Hugging Face, IS-Net: md5 checked against rembg's own value.
    fn sha256(self) -> &'static str {
        match self {
            Model::Lama => "1faef5301d78db7dda502fe59966957ec4b79dd64e16f03ed96913c7a4eb68d6",
            Model::Esrgan => "09b757accd747d7e423c1d352b3e8f23e77cc5742d04bae958d4eb8082b76fa4",
            Model::Isnet => "60920e99c45464f2ba57bee2ad08c919a52bbf852739e96947fbb4358c0d964a",
        }
    }
    /// anything smaller is a broken download
    fn min_bytes(self) -> u64 {
        match self {
            Model::Lama => 50_000_000,
            Model::Esrgan => 2_000_000,
            Model::Isnet => 150_000_000,
        }
    }
    fn id(self) -> &'static str {
        match self {
            Model::Lama => "lama",
            Model::Esrgan => "esrgan",
            Model::Isnet => "isnet",
        }
    }
}

/// Model path: <app_data>/models/<file>.
pub fn model_path(app_data: &Path, model: Model) -> PathBuf {
    app_data.join("models").join(model.file())
}

/// Is the model file there?
pub fn model_ready(app_data: &Path, model: Model) -> bool {
    std::fs::metadata(model_path(app_data, model))
        .map(|m| m.is_file() && m.len() >= model.min_bytes())
        .unwrap_or(false)
}

fn downloading() -> &'static Mutex<HashSet<&'static str>> {
    static D: OnceLock<Mutex<HashSet<&'static str>>> = OnceLock::new();
    D.get_or_init(|| Mutex::new(HashSet::new()))
}

/// Download a model (streamed to a .part file, then renamed) with progress(done, total).
/// Does nothing if it already exists. Only one download per model at a time.
pub fn download_model(
    app_data: &Path,
    model: Model,
    mut progress: impl FnMut(u64, u64),
) -> Result<(), String> {
    if model_ready(app_data, model) {
        return Ok(());
    }
    if !downloading().lock().map_err(|e| e.to_string())?.insert(model.id()) {
        return Err("This model is already being downloaded.".into());
    }
    let result = (|| -> Result<(), String> {
        let dest = model_path(app_data, model);
        let dir = dest.parent().ok_or("bad model path")?;
        std::fs::create_dir_all(dir).map_err(|e| format!("create models dir: {e}"))?;
        let part = dest.with_extension("onnx.part");

        let resp = ureq::get(model.url())
            .timeout(std::time::Duration::from_secs(30 * 60))
            .call()
            .map_err(|e| format!("download failed: {e}"))?;
        let total: u64 = resp
            .header("Content-Length")
            .and_then(|v| v.parse().ok())
            .unwrap_or(0);

        let mut reader = resp.into_reader();
        let mut file =
            std::fs::File::create(&part).map_err(|e| format!("create temp file: {e}"))?;
        let mut buf = vec![0u8; 1 << 20]; // 1 MB chunks
        let mut done: u64 = 0;
        // hash while downloading, so there's no second pass over 200 MB
        let mut hash = Sha256::new();
        loop {
            let n = reader.read(&mut buf).map_err(|e| format!("download read: {e}"))?;
            if n == 0 {
                break;
            }
            file.write_all(&buf[..n]).map_err(|e| format!("write model: {e}"))?;
            hash.update(&buf[..n]);
            done += n as u64;
            progress(done, total);
        }
        file.sync_all().ok();
        drop(file);
        if done < model.min_bytes() {
            let _ = std::fs::remove_file(&part);
            return Err("Download ended too early — please try again.".into());
        }
        if format!("{:x}", hash.finalize()) != model.sha256() {
            let _ = std::fs::remove_file(&part);
            return Err(
                "The downloaded model isn't the expected file (checksum mismatch), so it wasn't used. Please try again later."
                    .into(),
            );
        }
        std::fs::rename(&part, &dest).map_err(|e| format!("finish download: {e}"))?;
        Ok(())
    })();
    downloading().lock().map_err(|e| e.to_string())?.remove(model.id());
    result
}

/* ---- cached ONNX sessions --------------------------------------------- */

fn sessions() -> &'static Mutex<HashMap<&'static str, Session>> {
    static S: OnceLock<Mutex<HashMap<&'static str, Session>>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(HashMap::new()))
}

fn load_session(path: &Path) -> Result<Session, String> {
    Session::builder()
        .map_err(|e| format!("onnx init: {e}"))?
        .with_optimization_level(GraphOptimizationLevel::Level3)
        .map_err(|e| format!("onnx opt: {e}"))?
        .with_intra_threads(num_threads())
        .map_err(|e| format!("onnx threads: {e}"))?
        .commit_from_file(path)
        .map_err(|e| format!("load model: {e}"))
}

/// Run f with the cached session for model (loads it the first time).
fn with_session<R>(
    app_data: &Path,
    model: Model,
    f: impl FnOnce(&mut Session) -> Result<R, String>,
) -> Result<R, String> {
    if !model_ready(app_data, model) {
        return Err("The AI model isn't downloaded yet.".into());
    }
    let mut guard = sessions().lock().map_err(|e| e.to_string())?;
    if !guard.contains_key(model.id()) {
        let s = load_session(&model_path(app_data, model))?;
        guard.insert(model.id(), s);
    }
    f(guard.get_mut(model.id()).expect("session just inserted"))
}

fn num_threads() -> usize {
    std::thread::available_parallelism().map(|n| n.get().min(8)).unwrap_or(4)
}

/* ---- LaMa object remover ---------------------------------------------- */

/// Run LaMa on the masked area of img (255 in mask = remove), writes the result into img.
pub fn inpaint_lama(app_data: &Path, img: &mut RgbaImage, mask: &GrayImage) -> Result<(), String> {
    // square window around the mask with some margin (LaMa works better with more context)
    let (bx0, by0, bx1, by1) =
        crate::edit::mask_bbox(mask).ok_or("The selection is empty.")?;
    let (iw, ih) = (img.width(), img.height());
    let hole_dim = (bx1 - bx0 + 1).max(by1 - by0 + 1);
    let want = (hole_dim * 3).clamp(LAMA_NET, 2048).min(iw.max(ih));
    let (cx0, cy0, cw, ch) = square_window(bx0, by0, bx1, by1, want, iw, ih);

    // crop -> resize to 512
    let net = LAMA_NET;
    let crop = image::imageops::crop_imm(img, cx0, cy0, cw, ch).to_image();
    let small = image::imageops::resize(&crop, net, net, FilterType::CatmullRom);
    let mask_crop = image::imageops::crop_imm(mask, cx0, cy0, cw, ch).to_image();
    let mask_small = image::imageops::resize(&mask_crop, net, net, FilterType::Triangle);

    // CHW float tensors. Everything the mask touches counts as hole, grown a bit.
    let mut image_in = vec![0f32; (3 * net * net) as usize];
    for (x, y, p) in small.enumerate_pixels() {
        let i = (y * net + x) as usize;
        image_in[i] = p[0] as f32 / 255.0;
        image_in[(net * net) as usize + i] = p[1] as f32 / 255.0;
        image_in[(2 * net * net) as usize + i] = p[2] as f32 / 255.0;
    }
    let mut hole = GrayImage::new(net, net);
    for (x, y, p) in mask_small.enumerate_pixels() {
        if p[0] > 8 {
            hole.put_pixel(x, y, image::Luma([255]));
        }
    }
    let hole = crate::edit::dilate_mask(&hole, 3);
    let mask_in: Vec<f32> =
        hole.pixels().map(|p| if p[0] > 0 { 1.0f32 } else { 0.0 }).collect();

    // run the model (cached session)
    let out_chw: Vec<f32> = with_session(app_data, Model::Lama, |session| {
        let image_t = Tensor::from_array(([1usize, 3, net as usize, net as usize], image_in))
            .map_err(|e| format!("image tensor: {e}"))?;
        let mask_t = Tensor::from_array(([1usize, 1, net as usize, net as usize], mask_in))
            .map_err(|e| format!("mask tensor: {e}"))?;
        let outputs = session
            .run(ort::inputs!["image" => image_t, "mask" => mask_t])
            .map_err(|e| format!("inference: {e}"))?;
        let (_, data) = outputs[0]
            .try_extract_tensor::<f32>()
            .map_err(|e| format!("read output: {e}"))?;
        Ok(data.to_vec())
    })?;

    // some exports output 0..255, older ones 0..1
    let scale = if out_chw.iter().take(4096).fold(0f32, |m, v| m.max(*v)) <= 1.5 {
        255.0
    } else {
        1.0
    };
    let mut out_img = RgbaImage::new(net, net);
    for y in 0..net {
        for x in 0..net {
            let i = (y * net + x) as usize;
            let r = (out_chw[i] * scale).round().clamp(0.0, 255.0) as u8;
            let g = (out_chw[(net * net) as usize + i] * scale).round().clamp(0.0, 255.0) as u8;
            let b = (out_chw[(2 * net * net) as usize + i] * scale).round().clamp(0.0, 255.0) as u8;
            out_img.put_pixel(x, y, image::Rgba([r, g, b, 255]));
        }
    }

    // resize back and only paste the masked pixels (1px soft edge)
    let restored = image::imageops::resize(&out_img, cw, ch, FilterType::CatmullRom);
    let rim = crate::edit::dilate_mask(mask, 1);
    for y in 0..ch {
        for x in 0..cw {
            let gx = cx0 + x;
            let gy = cy0 + y;
            let m = mask.get_pixel(gx, gy)[0];
            let r = rim.get_pixel(gx, gy)[0];
            if m == 0 && r == 0 {
                continue;
            }
            let src = restored.get_pixel(x, y);
            let dst = *img.get_pixel(gx, gy);
            let blend = if m > 0 { 1.0f32 } else { 0.5 }; // soft 1px transition
            let mix = |a: u8, b: u8| -> u8 {
                (a as f32 * blend + b as f32 * (1.0 - blend)).round() as u8
            };
            img.put_pixel(
                gx,
                gy,
                image::Rgba([mix(src[0], dst[0]), mix(src[1], dst[1]), mix(src[2], dst[2]), dst[3]]),
            );
        }
    }
    Ok(())
}

/* ---- Real-ESRGAN upscaler --------------------------------------------- */

/// AI upscale img to exactly target_w x target_h: 4x model in overlapping tiles,
/// then Lanczos to the exact size. Alpha is resized normally.
pub fn upscale(
    app_data: &Path,
    img: &RgbaImage,
    target_w: u32,
    target_h: u32,
) -> Result<RgbaImage, String> {
    let up = with_session(app_data, Model::Esrgan, |session| {
        // read the model's input name, layout and tile size
        let input = session.inputs().first().ok_or("upscaler model has no inputs")?;
        let input_name = input.name().to_string();
        let dims: Vec<i64> = input
            .dtype()
            .tensor_shape()
            .map(|s| s.iter().copied().collect())
            .unwrap_or_default();
        // NCHW if channels are at index 1, NHWC if at index 3
        let nhwc = dims.len() == 4 && dims[3] == 3 && dims[1] != 3;
        let static_side = if dims.len() == 4 {
            let (h, w) = if nhwc { (dims[1], dims[2]) } else { (dims[2], dims[3]) };
            if h > 0 && h == w { Some(h as u32) } else { None }
        } else {
            None
        };
        let tile = static_side.unwrap_or(192).max(32);
        let pad = (tile / 16).clamp(4, 16);

        upscale_tiled(img, tile, pad, |tin| run_esrgan_tile(session, &input_name, nhwc, tin))
    })?;

    // exact size, then put the alpha back
    let mut fin = image::imageops::resize(&up, target_w, target_h, FilterType::Lanczos3);
    let alpha = image::imageops::resize(img, target_w, target_h, FilterType::Triangle);
    for (p, q) in fin.pixels_mut().zip(alpha.pixels()) {
        p[3] = q[3];
    }
    Ok(fin)
}

/// Run one square tile through the model (0..1 floats, 0..255 output is detected).
fn run_esrgan_tile(
    session: &mut Session,
    input_name: &str,
    nhwc: bool,
    tin: &RgbaImage,
) -> Result<RgbaImage, String> {
    let t = tin.width() as usize; // square
    let mut data = vec![0f32; 3 * t * t];
    if nhwc {
        for (x, y, p) in tin.enumerate_pixels() {
            let i = (y as usize * t + x as usize) * 3;
            data[i] = p[0] as f32 / 255.0;
            data[i + 1] = p[1] as f32 / 255.0;
            data[i + 2] = p[2] as f32 / 255.0;
        }
    } else {
        for (x, y, p) in tin.enumerate_pixels() {
            let i = y as usize * t + x as usize;
            data[i] = p[0] as f32 / 255.0;
            data[t * t + i] = p[1] as f32 / 255.0;
            data[2 * t * t + i] = p[2] as f32 / 255.0;
        }
    }
    let shape: Vec<usize> = if nhwc { vec![1, t, t, 3] } else { vec![1, 3, t, t] };
    let tensor = Tensor::from_array((shape, data)).map_err(|e| format!("tile tensor: {e}"))?;
    let outputs = session
        .run(ort::inputs![input_name => tensor])
        .map_err(|e| format!("upscale inference: {e}"))?;
    let (oshape, out) = outputs[0]
        .try_extract_tensor::<f32>()
        .map_err(|e| format!("read upscale output: {e}"))?;
    if oshape.len() != 4 {
        return Err(format!("unexpected upscaler output rank: {oshape:?}"));
    }
    let out_nhwc = oshape[3] == 3 && oshape[1] != 3;
    let (oh, ow) = if out_nhwc {
        (oshape[1] as usize, oshape[2] as usize)
    } else {
        (oshape[2] as usize, oshape[3] as usize)
    };
    // 0..255 output -> 0..1
    let norm = if out.iter().take(4096).fold(0f32, |m, v| m.max(*v)) > 1.5 {
        1.0 / 255.0
    } else {
        1.0
    };
    let mut img = RgbaImage::new(ow as u32, oh as u32);
    for y in 0..oh {
        for x in 0..ow {
            let (r, g, b) = if out_nhwc {
                let i = (y * ow + x) * 3;
                (out[i], out[i + 1], out[i + 2])
            } else {
                let i = y * ow + x;
                (out[i], out[oh * ow + i], out[2 * oh * ow + i])
            };
            let to8 = |v: f32| (v * norm * 255.0).round().clamp(0.0, 255.0) as u8;
            img.put_pixel(x as u32, y as u32, image::Rgba([to8(r), to8(g), to8(b), 255]));
        }
    }
    Ok(img)
}

/// Tiler: feed tile x tile windows (edges repeated) through run, keep only the
/// middle of each tile and stitch them. The scale comes from the first output.
fn upscale_tiled(
    src: &RgbaImage,
    tile: u32,
    pad: u32,
    mut run: impl FnMut(&RgbaImage) -> Result<RgbaImage, String>,
) -> Result<RgbaImage, String> {
    let w = src.width();
    let h = src.height();
    if w == 0 || h == 0 || tile <= pad * 2 {
        return Err("image too small to upscale".into());
    }
    let core = tile - 2 * pad;
    let mut out: Option<RgbaImage> = None;
    let mut scale = 0u32;

    let mut ty = 0u32;
    while ty < h {
        let th = core.min(h - ty);
        let mut tx = 0u32;
        while tx < w {
            let tw = core.min(w - tx);
            // build the padded input window (edges repeated)
            let mut tin = RgbaImage::new(tile, tile);
            for yy in 0..tile {
                let sy = (ty as i64 + yy as i64 - pad as i64).clamp(0, h as i64 - 1) as u32;
                for xx in 0..tile {
                    let sx = (tx as i64 + xx as i64 - pad as i64).clamp(0, w as i64 - 1) as u32;
                    tin.put_pixel(xx, yy, *src.get_pixel(sx, sy));
                }
            }
            let tout = run(&tin)?;
            if out.is_none() {
                if tout.width() < tile || tout.width() % tile != 0 || tout.width() != tout.height() {
                    return Err(format!(
                        "unexpected upscaler output: {}×{} for a {tile}px tile",
                        tout.width(),
                        tout.height()
                    ));
                }
                scale = tout.width() / tile;
                out = Some(RgbaImage::new(w * scale, h * scale));
            }
            let o = out.as_mut().expect("allocated above");
            for yy in 0..th * scale {
                for xx in 0..tw * scale {
                    let px = tout.get_pixel(pad * scale + xx, pad * scale + yy);
                    o.put_pixel(tx * scale + xx, ty * scale + yy, *px);
                }
            }
            tx += core;
        }
        ty += core;
    }
    out.ok_or_else(|| "empty image".into())
}

/* ---- IS-Net background removal ---------------------------------------- */

/// Cut out the subject: IS-Net on a 1024x1024 copy, scale the mask back up and use
/// it as alpha. feather softens the edge in px (0 = raw).
/// Only alpha changes, the colors stay.
pub fn cutout(app_data: &Path, img: &RgbaImage, feather: u32) -> Result<RgbaImage, String> {
    let (w, h) = (img.width(), img.height());
    if w == 0 || h == 0 {
        return Err("empty image".into());
    }
    let matte = with_session(app_data, Model::Isnet, |session| {
        // read name and shape from the model instead of trusting it
        let input = session.inputs().first().ok_or("cutout model has no inputs")?;
        let input_name = input.name().to_string();
        let dims: Vec<i64> = input
            .dtype()
            .tensor_shape()
            .map(|s| s.iter().copied().collect())
            .unwrap_or_default();
        let nhwc = dims.len() == 4 && dims[3] == 3 && dims[1] != 3;
        let net = if dims.len() == 4 {
            let (dh, dw) = if nhwc { (dims[1], dims[2]) } else { (dims[2], dims[3]) };
            if dh > 0 && dh == dw { dh as u32 } else { ISNET_NET }
        } else {
            ISNET_NET
        };

        let small = image::imageops::resize(img, net, net, FilterType::Lanczos3);
        let n = (net * net) as usize;
        let mut data = vec![0f32; 3 * n];
        // rembg preprocessing: 0..1, then mean 0.5 / std 1.0
        let norm = |v: u8| v as f32 / 255.0 - 0.5;
        if nhwc {
            for (x, y, p) in small.enumerate_pixels() {
                let i = (y as usize * net as usize + x as usize) * 3;
                data[i] = norm(p[0]);
                data[i + 1] = norm(p[1]);
                data[i + 2] = norm(p[2]);
            }
        } else {
            for (x, y, p) in small.enumerate_pixels() {
                let i = y as usize * net as usize + x as usize;
                data[i] = norm(p[0]);
                data[n + i] = norm(p[1]);
                data[2 * n + i] = norm(p[2]);
            }
        }
        let shape: Vec<usize> = if nhwc {
            vec![1, net as usize, net as usize, 3]
        } else {
            vec![1, 3, net as usize, net as usize]
        };
        let tensor = Tensor::from_array((shape, data)).map_err(|e| format!("cutout tensor: {e}"))?;
        let outputs = session
            .run(ort::inputs![input_name => tensor])
            .map_err(|e| format!("cutout inference: {e}"))?;
        // output 0 is the full size mask
        let (oshape, out) = outputs[0]
            .try_extract_tensor::<f32>()
            .map_err(|e| format!("read cutout output: {e}"))?;
        let count: usize = oshape.iter().map(|d| *d as usize).product();
        if count < n {
            return Err(format!("unexpected cutout output shape: {oshape:?}"));
        }
        // logits, rembg normalizes min-max over the whole image
        let (mut lo, mut hi) = (f32::MAX, f32::MIN);
        for v in out.iter().take(n) {
            lo = lo.min(*v);
            hi = hi.max(*v);
        }
        let span = if hi - lo > 1e-6 { hi - lo } else { 1.0 };
        let mut m = GrayImage::new(net, net);
        for y in 0..net {
            for x in 0..net {
                let v = (out[(y * net + x) as usize] - lo) / span;
                m.put_pixel(x, y, image::Luma([(v * 255.0).round().clamp(0.0, 255.0) as u8]));
            }
        }
        Ok(m)
    })?;

    let mut alpha = image::imageops::resize(&matte, w, h, FilterType::CatmullRom);
    if feather > 0 {
        alpha = crate::edit::feather_mask(&alpha, feather.min(64) as i32);
    }
    // multiply with the old alpha so it can only remove more, never bring pixels back
    let mut out = img.clone();
    for (x, y, p) in out.enumerate_pixels_mut() {
        let a = alpha.get_pixel(x, y)[0] as u32 * p[3] as u32;
        p[3] = (a / 255) as u8;
    }
    Ok(out)
}

/* ---- shared helpers ---------------------------------------------------- */

/// Square window of about want size around the bbox, inside the image. Returns (x, y, w,
/// h).
fn square_window(
    bx0: u32,
    by0: u32,
    bx1: u32,
    by1: u32,
    want: u32,
    iw: u32,
    ih: u32,
) -> (u32, u32, u32, u32) {
    let side_w = want.min(iw);
    let side_h = want.min(ih);
    let centre = |lo: u32, hi: u32, side: u32, max: u32| -> u32 {
        let c = (lo + hi) / 2;
        let half = side / 2;
        c.saturating_sub(half).min(max - side)
    };
    let x = centre(bx0, bx1, side_w, iw);
    let y = centre(by0, by1, side_h, ih);
    // make sure the bbox is inside
    let x = x.min(bx0);
    let y = y.min(by0);
    let w = side_w.max(bx1.saturating_sub(x) + 1).min(iw - x);
    let h = side_h.max(by1.saturating_sub(y) + 1).min(ih - y);
    (x, y, w, h)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn window_is_square_inside_image_and_contains_bbox() {
        let (x, y, w, h) = square_window(100, 120, 160, 180, 512, 2000, 1500);
        assert_eq!((w, h), (512, 512));
        assert!(x <= 100 && y <= 120);
        assert!(x + w >= 161 && y + h >= 181);
        assert!(x + w <= 2000 && y + h <= 1500);
    }

    #[test]
    fn window_clamps_to_small_images() {
        let (x, y, w, h) = square_window(10, 10, 50, 50, 512, 300, 200);
        assert_eq!((x, y), (0, 0));
        assert_eq!((w, h), (300, 200));
    }

    #[test]
    fn window_handles_bbox_near_edges() {
        let (x, y, w, h) = square_window(1900, 10, 1990, 80, 512, 2000, 1000);
        assert!(x + w <= 2000 && y + h <= 1000);
        assert!(x <= 1900 && y <= 10);
        assert!(x + w >= 1991 && y + h >= 81);
    }

    #[test]
    fn model_ids_round_trip() {
        assert!(matches!(Model::from_id("lama"), Ok(Model::Lama)));
        assert!(matches!(Model::from_id("esrgan"), Ok(Model::Esrgan)));
        assert!(matches!(Model::from_id("isnet"), Ok(Model::Isnet)));
        assert!(Model::from_id("nope").is_err());
    }

    #[test]
    fn every_model_has_its_own_file_url_and_id() {
        // a copy-paste mistake in file() would make two models overwrite each other
        let all = [Model::Lama, Model::Esrgan, Model::Isnet];
        for (i, a) in all.iter().enumerate() {
            for b in all.iter().skip(i + 1) {
                assert_ne!(a.file(), b.file());
                assert_ne!(a.url(), b.url());
                assert_ne!(a.id(), b.id());
            }
            assert!(matches!(Model::from_id(a.id()), Ok(m) if m == *a));
        }
    }

    #[test]
    fn tiler_stitches_exactly_like_a_whole_image_pass() {
        // fake x4 model (nearest neighbour) to test the tiling: must match a single full
        // pass
        let w = 50u32;
        let h = 37u32;
        let mut src = RgbaImage::new(w, h);
        for y in 0..h {
            for x in 0..w {
                src.put_pixel(
                    x,
                    y,
                    image::Rgba([(x * 5 % 256) as u8, (y * 7 % 256) as u8, ((x + y) % 256) as u8, 255]),
                );
            }
        }
        let fake = |tin: &RgbaImage| -> Result<RgbaImage, String> {
            let mut out = RgbaImage::new(tin.width() * 4, tin.height() * 4);
            for (x, y, p) in out.enumerate_pixels_mut() {
                *p = *tin.get_pixel(x / 4, y / 4);
            }
            Ok(out)
        };
        let up = upscale_tiled(&src, 16, 4, fake).unwrap();
        assert_eq!((up.width(), up.height()), (w * 4, h * 4));
        for y in 0..h * 4 {
            for x in 0..w * 4 {
                assert_eq!(
                    up.get_pixel(x, y),
                    src.get_pixel(x / 4, y / 4),
                    "mismatch at {x},{y}"
                );
            }
        }
    }
}
