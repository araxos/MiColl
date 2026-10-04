//! Stable Diffusion 1.5 inpainting on the graphics card (DirectML) for the Expand tool's
//! "AI fill HQ": LaMa lays out the new border first (ai::outpaint_lama), then SD redraws
//! it with real detail (img2img on the border, strength 0.6 next to the picture, 0.85 far
//! out).
//!
//! Why the two: SD alone invents unrelated things (figures, rocks) on a big empty border,
//! LaMa alone stays smeared. LaMa's layout + SD's detail beat both (compared on test
//! images cut out of real wallpapers).
//!
//! The model is SD 1.5 inpainting exported to ONNX fp16 (unet, vae encoder, vae decoder).
//! The prompt is fixed, so its text embeddings ship as a file: no tokenizer and no text
//! encoder. DirectML ships with Windows; without a usable GPU ONNX Runtime falls back to
//! the CPU (works, but takes minutes).
//!
//! The VAE sessions only live for their one call: kept open next to the unet they hold on
//! to so much video memory that the unet steps spilled into system RAM and got 5-10x
//! slower (measured on an 8 GB card).

use half::f16;
use image::imageops::FilterType;
use image::RgbaImage;
use ort::session::builder::GraphOptimizationLevel;
use ort::session::Session;
use ort::value::Tensor;
use rand::{Rng, SeedableRng};
use std::path::Path;

/// Pixels SD works on (about 768 x 512); the result is scaled up to the canvas.
const WORK_AREA: f32 = 768.0 * 512.0;
/// DDIM steps for the full schedule; img2img at strength 0.6 runs the last 60% of them.
const STEPS: usize = 30;
/// Strength next to the picture: SD stays close to LaMa's layout there, it has to join up.
const STRENGTH_NEAR: f32 = 0.6;
/// Strength far out: LaMa's long smears turned into flat walls and vertical edges at 0.6,
/// SD redraws them as real scenery at 0.85 (compared on the test wallpapers; 0.9 started
/// inventing shapes).
const STRENGTH_FAR: f32 = 0.85;
/// Classifier-free guidance: low, the prompt only nudges towards "sharp, detailed".
const GUIDANCE: f32 = 3.0;
const VAE_SCALE: f32 = 0.18215;
/// SD 1.5's training schedule (scaled linear betas).
const BETA_START: f64 = 0.00085;
const BETA_END: f64 = 0.012;
const TRAIN_STEPS: usize = 1000;

fn session(path: &Path) -> Result<Session, String> {
    Session::builder()
        .map_err(|e| format!("onnx init: {e}"))?
        // falls back to the CPU when there's no DirectML device
        .with_execution_providers([ort::ep::DirectML::default().build()])
        .map_err(|e| format!("onnx gpu: {e}"))?
        // DirectML wants these two off
        .with_memory_pattern(false)
        .map_err(|e| format!("onnx opt: {e}"))?
        .with_parallel_execution(false)
        .map_err(|e| format!("onnx opt: {e}"))?
        .with_optimization_level(GraphOptimizationLevel::Level3)
        .map_err(|e| format!("onnx opt: {e}"))?
        .commit_from_file(path)
        .map_err(|e| format!("load model: {e}"))
}

/// Round to a multiple of 64 (the unet halves three times, then the latent has to divide).
fn round64(v: f32) -> u32 {
    (((v / 64.0).round() as u32).max(4)) * 64
}

/// The keep weight for canvas pixel (x, y): 1 deep inside the picture, ramping to 0 over
/// `band` px towards a side that borders new canvas, 0 outside the picture.
fn keep_weight(x: u32, y: u32, keep: (u32, u32, u32, u32), canvas: (u32, u32), band: u32) -> f32 {
    let (kx, ky, kw, kh) = keep;
    if x < kx || y < ky || x >= kx + kw || y >= ky + kh {
        return 0.0;
    }
    let band = band.max(1) as f32;
    let mut t = 1.0f32;
    // only sides with new canvas behind them get the ramp
    if kx > 0 {
        t = t.min((x - kx) as f32 / band);
    }
    if kx + kw < canvas.0 {
        t = t.min((kx + kw - 1 - x) as f32 / band);
    }
    if ky > 0 {
        t = t.min((y - ky) as f32 / band);
    }
    if ky + kh < canvas.1 {
        t = t.min((ky + kh - 1 - y) as f32 / band);
    }
    t.clamp(0.0, 1.0)
}

/// One side of the picture for reseed_dark_edges: border width, picture depth, edge length
/// and the canvas pixel at (position along the edge, depth: >= 0 inside, < 0 outside).
type Side = (u32, u32, u32, Box<dyn Fn(u32, i64) -> (u32, u32)>);

/// LaMa sometimes ends a lit edge in near black (a bar's wall and table next to a dark
/// room: the strip beside the picture came out half as bright as the picture's edge).
/// On such a side the picture's own edge, mirrored, is faded into a band of 10% of the
/// picture's width before SD redraws it: SD then carries the wall and the table on
/// instead of a hard cut. 15% mirrored a watermark near the edge along with it. Only on
/// such sides: on the test wallpapers (ratio 0.83 and up) the mirror left mirrored
/// shapes, so a side only gets it below 0.8, fully below 0.6.
fn reseed_dark_edges(canvas: &RgbaImage, keep: (u32, u32, u32, u32)) -> RgbaImage {
    let (cw, ch) = canvas.dimensions();
    let (kx, ky, kw, kh) = keep;
    let mut out = canvas.clone();
    let lum = |p: &image::Rgba<u8>| 0.299 * p[0] as f32 + 0.587 * p[1] as f32 + 0.114 * p[2] as f32;
    let sides: [Side; 4] = [
        (kx, kw, kh, Box::new(move |a, d| ((kx as i64 + d) as u32, ky + a))),
        (cw - kx - kw, kw, kh, Box::new(move |a, d| ((kx as i64 + kw as i64 - 1 - d) as u32, ky + a))),
        (ky, kh, kw, Box::new(move |a, d| (kx + a, (ky as i64 + d) as u32))),
        (ch - ky - kh, kh, kw, Box::new(move |a, d| (kx + a, (ky as i64 + kh as i64 - 1 - d) as u32))),
    ];
    for (border, depth, len, at) in sides.iter() {
        let reach = ((*depth as f32 * 0.1) as u32).min(*border);
        let strip = 24.min(depth / 4).min(*border);
        if reach < 4 || strip == 0 {
            continue;
        }
        let (mut inside, mut outside) = (0f32, 0f32);
        for a in 0..*len {
            for d in 0..strip as i64 {
                let (x, y) = at(a, d);
                inside += lum(canvas.get_pixel(x, y));
                let (x, y) = at(a, -1 - d);
                outside += lum(canvas.get_pixel(x, y));
            }
        }
        let n = (*len * strip) as f32;
        let ratio = (outside / n + 4.0) / (inside / n + 4.0);
        let w = ((0.8 - ratio) / 0.2).clamp(0.0, 1.0);
        if w <= 0.0 {
            continue;
        }
        for d in 0..reach {
            let t = 1.0 - d as f32 / reach as f32;
            let t = t * t * (3.0 - 2.0 * t) * w;
            for a in 0..*len {
                let (sx, sy) = at(a, d as i64);
                let (ox, oy) = at(a, -1 - d as i64);
                let src = *canvas.get_pixel(sx, sy);
                let dst = out.get_pixel_mut(ox, oy);
                for c in 0..3 {
                    dst[c] = (src[c] as f32 * t + dst[c] as f32 * (1.0 - t)).round() as u8;
                }
            }
        }
    }
    out
}

/// Image -> [1, 3, h, w] in -1..1, f16.
fn to_tensor(img: &RgbaImage) -> Vec<f16> {
    let (w, h) = img.dimensions();
    let plane = (w * h) as usize;
    let mut v = vec![f16::ZERO; 3 * plane];
    for (x, y, p) in img.enumerate_pixels() {
        let i = (y * w + x) as usize;
        for c in 0..3 {
            v[c * plane + i] = f16::from_f32(p[c] as f32 / 127.5 - 1.0);
        }
    }
    v
}

fn run_vae_encoder(path: &Path, images: &[Vec<f16>], gw: u32, gh: u32) -> Result<Vec<Vec<f32>>, String> {
    let mut s = session(path)?;
    let mut out = Vec::new();
    for img in images {
        let t = Tensor::from_array(([1usize, 3, gh as usize, gw as usize], img.clone()))
            .map_err(|e| format!("vae tensor: {e}"))?;
        let res = s.run(ort::inputs!["image" => t]).map_err(|e| format!("vae encode: {e}"))?;
        let (_, data) = res[0].try_extract_tensor::<f16>().map_err(|e| format!("vae out: {e}"))?;
        out.push(data.iter().map(|v| v.to_f32() * VAE_SCALE).collect());
    }
    Ok(out)
}

/// Redraw the new border of canvas (LaMa's layout) with SD. keep = where the real picture
/// sits (x, y, w, h); band = how far inside its edge SD may blend in. seed = the noise.
/// progress(done, total) after every denoising step.
pub fn refine(
    model_dir: &Path,
    canvas: &RgbaImage,
    keep: (u32, u32, u32, u32),
    band: u32,
    seed: u64,
    progress: &dyn Fn(u32, u32),
) -> Result<RgbaImage, String> {
    let (cw, ch) = canvas.dimensions();
    let reseeded = reseed_dark_edges(canvas, keep);
    let canvas = &reseeded;
    let s = (WORK_AREA / (cw as f32 * ch as f32)).sqrt();
    let gw = round64(cw as f32 * s);
    let gh = round64(ch as f32 * s);
    let (lw, lh) = ((gw / 8) as usize, (gh / 8) as usize);

    // the picture and the "redraw this" mask at working size
    let small = image::imageops::resize(canvas, gw, gh, FilterType::CatmullRom);
    let sx = cw as f32 / gw as f32;
    let sy = ch as f32 / gh as f32;
    let mut repaint = vec![0f32; (gw * gh) as usize];
    for y in 0..gh {
        for x in 0..gw {
            let cx = ((x as f32 + 0.5) * sx) as u32;
            let cy = ((y as f32 + 0.5) * sy) as u32;
            // everything not fully kept gets redrawn, the blend happens at full size
            if keep_weight(cx.min(cw - 1), cy.min(ch - 1), keep, (cw, ch), band) < 1.0 {
                repaint[(y * gw + x) as usize] = 1.0;
            }
        }
    }
    let image_t = to_tensor(&small);
    let plane = (gw * gh) as usize;
    let mut masked_t = image_t.clone();
    for c in 0..3 {
        for i in 0..plane {
            if repaint[i] > 0.5 {
                masked_t[c * plane + i] = f16::ZERO;
            }
        }
    }
    // latent mask: the centre pixel of each 8x8 block
    let mut lmask = vec![0f32; lw * lh];
    for y in 0..lh {
        for x in 0..lw {
            lmask[y * lw + x] = repaint[(y * 8 + 4) * gw as usize + x * 8 + 4];
        }
    }

    let lat = run_vae_encoder(&model_dir.join("vae_encoder.onnx"), &[image_t, masked_t], gw, gh)?;
    let (lat0, mlat) = (&lat[0], &lat[1]);
    let lsize = 4 * lw * lh;

    // DDIM schedule ("leading" spacing, steps offset 1, like SD 1.5's default)
    let betas: Vec<f64> = (0..TRAIN_STEPS)
        .map(|i| {
            let b = BETA_START.sqrt()
                + (BETA_END.sqrt() - BETA_START.sqrt()) * i as f64 / (TRAIN_STEPS - 1) as f64;
            b * b
        })
        .collect();
    let mut acp = Vec::with_capacity(TRAIN_STEPS);
    let mut a = 1.0f64;
    for b in &betas {
        a *= 1.0 - b;
        acp.push(a);
    }
    let ratio = TRAIN_STEPS / STEPS;
    let all: Vec<usize> = (0..STEPS).rev().map(|i| i * ratio + 1).collect();
    // strength per latent pixel, ramping from STRENGTH_NEAR at the picture to STRENGTH_FAR
    // at 60% of the widest border: a pixel joins the denoising at its own step and follows
    // the noised layout until then (soft img2img)
    let (kx, ky, kw, kh) = keep;
    let border = kx.max(cw - kx - kw).max(ky).max(ch - ky - kh).max(1) as f32;
    let first = |st: f32| STEPS - (STEPS as f32 * st) as usize;
    let skip = first(STRENGTH_FAR);
    let start: Vec<usize> = (0..lw * lh)
        .map(|i| {
            let cx = ((i % lw) as f32 * 8.0 + 4.0) * sx;
            let cy = ((i / lw) as f32 * 8.0 + 4.0) * sy;
            let dx = (kx as f32 - cx).max(cx - (kx + kw) as f32).max(0.0);
            let dy = (ky as f32 - cy).max(cy - (ky + kh) as f32).max(0.0);
            let d = (dx.max(dy) / (border * 0.6)).min(1.0);
            first(STRENGTH_NEAR + (STRENGTH_FAR - STRENGTH_NEAR) * d) - skip
        })
        .collect();
    let timesteps = &all[skip..];

    // start from the layout's latent, noised to the first timestep (the seed comes from the
    // editor, a new one each time: Expand again draws something different)
    let mut rng = rand::rngs::StdRng::seed_from_u64(seed);
    let mut gauss = || {
        // Box-Muller
        let u1: f32 = rng.gen_range(f32::EPSILON..1.0);
        let u2: f32 = rng.gen();
        (-2.0 * u1.ln()).sqrt() * (2.0 * std::f32::consts::PI * u2).cos()
    };
    let noise: Vec<f32> = (0..lat0.len()).map(|_| gauss()).collect();
    let noised = |i: usize, a: f32| a.sqrt() * lat0[i] + (1.0 - a).sqrt() * noise[i];
    let a0 = acp[timesteps[0]] as f32;
    let mut x: Vec<f32> = (0..lat0.len()).map(|i| noised(i, a0)).collect();

    let embeds = {
        let raw = std::fs::read(model_dir.join("prompt_embeds.bin"))
            .map_err(|e| format!("read prompt: {e}"))?;
        if raw.len() != 2 * 77 * 768 * 2 {
            return Err("The HQ model files are damaged (prompt).".into());
        }
        raw.chunks_exact(2).map(|b| f16::from_le_bytes([b[0], b[1]])).collect::<Vec<f16>>()
    };

    let mut unet = session(&model_dir.join("unet.onnx"))?;
    let total = timesteps.len() as u32;
    for (step, &ts) in timesteps.iter().enumerate() {
        // pixels that start later still follow the layout, noised to this step
        let a_now = acp[ts] as f32;
        for i in 0..lsize {
            if step < start[i % (lw * lh)] {
                x[i] = noised(i, a_now);
            }
        }
        // [x | mask | masked latent], twice (negative + prompt)
        let mut sample = Vec::with_capacity(2 * 9 * lw * lh);
        for _ in 0..2 {
            sample.extend(x.iter().map(|v| f16::from_f32(*v)));
            sample.extend(lmask.iter().map(|v| f16::from_f32(*v)));
            sample.extend(mlat.iter().map(|v| f16::from_f32(*v)));
        }
        let sample_t = Tensor::from_array(([2usize, 9, lh, lw], sample))
            .map_err(|e| format!("unet tensor: {e}"))?;
        let ts_t = Tensor::from_array(([0usize; 0], vec![ts as i64]))
            .map_err(|e| format!("unet timestep: {e}"))?;
        let emb_t = Tensor::from_array(([2usize, 77, 768], embeds.clone()))
            .map_err(|e| format!("unet prompt: {e}"))?;
        let res = unet
            .run(ort::inputs!["sample" => sample_t, "timestep" => ts_t, "encoder_hidden_states" => emb_t])
            .map_err(|e| format!("unet: {e}"))?;
        let (_, eps) = res[0].try_extract_tensor::<f16>().map_err(|e| format!("unet out: {e}"))?;
        let a_t = acp[ts] as f32;
        let prev = ts as i64 - ratio as i64;
        let a_p = if prev >= 0 { acp[prev as usize] } else { acp[0] } as f32;
        for i in 0..lsize {
            let un = eps[i].to_f32();
            let co = eps[lsize + i].to_f32();
            let e = un + GUIDANCE * (co - un);
            let x0 = (x[i] - (1.0 - a_t).sqrt() * e) / a_t.sqrt();
            x[i] = a_p.sqrt() * x0 + (1.0 - a_p).sqrt() * e;
        }
        progress(step as u32 + 1, total);
    }
    drop(unet);

    // decode, scale up, blend into the canvas
    let decoded: Vec<f32> = {
        let mut dec = session(&model_dir.join("vae_decoder.onnx"))?;
        let lat_in: Vec<f16> = x.iter().map(|v| f16::from_f32(v / VAE_SCALE)).collect();
        let t = Tensor::from_array(([1usize, 4, lh, lw], lat_in))
            .map_err(|e| format!("vae tensor: {e}"))?;
        let res = dec.run(ort::inputs!["latent" => t]).map_err(|e| format!("vae decode: {e}"))?;
        let (_, data) = res[0].try_extract_tensor::<f16>().map_err(|e| format!("vae out: {e}"))?;
        data.iter().map(|v| v.to_f32()).collect()
    };
    let mut drawn = RgbaImage::new(gw, gh);
    for (x, y, p) in drawn.enumerate_pixels_mut() {
        let i = (y * gw + x) as usize;
        let ch = |c: usize| ((decoded[c * plane + i] + 1.0) * 127.5).round().clamp(0.0, 255.0) as u8;
        *p = image::Rgba([ch(0), ch(1), ch(2), 255]);
    }
    let big = image::imageops::resize(&drawn, cw, ch, FilterType::CatmullRom);
    let mut out = canvas.clone();
    for (x, y, p) in out.pixels_mut().enumerate().map(|(i, p)| ((i as u32) % cw, (i as u32) / cw, p)) {
        let t = keep_weight(x, y, keep, (cw, ch), band);
        if t >= 1.0 {
            continue;
        }
        let q = big.get_pixel(x, y);
        for c in 0..3 {
            p[c] = (p[c] as f32 * t + q[c] as f32 * (1.0 - t)).round() as u8;
        }
        p[3] = 255;
    }
    Ok(out)
}
