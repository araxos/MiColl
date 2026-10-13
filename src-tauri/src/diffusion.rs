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
/// keep_original: the most a colour channel is corrected at the picture's edge.
const SEAM_CAP: f32 = 16.0;
/// People mode's strength next to the picture: it carries on the layout instead of
/// inventing things. 1.0 drew new objects (a hand holding a phone) next to it, 0.75 still
/// a wire or two, 0.65 the fewest (compared on a photo with a hand at the edge).
const PEOPLE_STRENGTH: f32 = 0.65;
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

/// Encode (image, width, height) tensors on one session.
fn run_vae_encoder(path: &Path, images: &[(Vec<f16>, u32, u32)]) -> Result<Vec<Vec<f32>>, String> {
    let mut s = session(path)?;
    let mut out = Vec::new();
    for (img, gw, gh) in images {
        let t = Tensor::from_array(([1usize, 3, *gh as usize, *gw as usize], img.clone()))
            .map_err(|e| format!("vae tensor: {e}"))?;
        let res = s.run(ort::inputs!["image" => t]).map_err(|e| format!("vae encode: {e}"))?;
        let (_, data) = res[0].try_extract_tensor::<f16>().map_err(|e| format!("vae out: {e}"))?;
        out.push(data.iter().map(|v| v.to_f32() * VAE_SCALE).collect());
    }
    Ok(out)
}

/// How SD redraws the border.
pub struct Tuning<'a> {
    /// Strength next to the picture and far out (see STRENGTH_NEAR / STRENGTH_FAR).
    pub near: f32,
    pub far: f32,
    pub guidance: f32,
    /// The picture stays exactly as it was: SD only draws outside it (no blend band inside).
    pub keep_original: bool,
    /// Mirror a lit edge into a dark border first (reseed_dark_edges).
    pub reseed: bool,
    /// [2, 77, 768] fp16 prompt embeddings, None = the model's prompt_embeds.bin.
    pub embeds: Option<&'a [u8]>,
    /// Pixels SD works on (WORK_AREA, or less for a small window).
    pub work: f32,
}

impl Tuning<'_> {
    /// The Expand tool's HQ fill as it always was (scenery, wallpapers).
    pub const SCENERY: Tuning<'static> = Tuning {
        near: STRENGTH_NEAR,
        far: STRENGTH_FAR,
        guidance: GUIDANCE,
        keep_original: false,
        reseed: true,
        embeds: None,
        work: WORK_AREA,
    };
}

/// The people mode's prompt as SD 1.5 inpainting's text encoder sees it: [2, 77, 768]
/// fp16, the negative row first. Made from
///   prompt:   "high quality, sharp, detailed, natural anatomy, seamless continuation of the
///              same photo"
///   negative: "extra hands, extra fingers, extra limbs, extra arms, extra person, holding
///              object, phone, deformed, mutated, fused fingers, bad anatomy, text,
///              watermark, frame, border, letterbox, blurry, lowres, seam, split screen,
///              collage, duplicate"
/// Hands stay out of the prompt on purpose: "natural hands with five fingers" made SD
/// draw new hands next to the picture (one held a phone).
static PEOPLE_EMBEDS: &[u8] = include_bytes!("../assets/people_prompt_embeds.bin");

/// Windows along the picture's edges for people mode's detail passes: squares of 30% of
/// the canvas' short side (384..768 px), 45% of each on the picture, overlapping a
/// quarter. Only where the picture is (the corners beyond it are plain background).
fn edge_windows(canvas: (u32, u32), keep: (u32, u32, u32, u32)) -> Vec<(u32, u32, u32, u32)> {
    let (cw, ch) = canvas;
    let (kx, ky, kw, kh) = keep;
    let s = ((cw.min(ch) as f32 * 0.3) as u32).clamp(384, 768).min(cw).min(ch);
    let on_picture = (s as f32 * 0.45) as u32;
    // starts of the windows that cover [from, from + len) of a side that is `total` long
    let along = |from: u32, len: u32, total: u32| -> Vec<u32> {
        let (lo, hi) = (from, (from + len).min(total));
        if hi - lo <= s {
            return vec![((lo + hi) / 2).saturating_sub(s / 2).min(total - s)];
        }
        let n = ((hi - lo - s) as f32 / (s as f32 * 0.75)).ceil() as u32 + 1;
        (0..n).map(|i| lo + (hi - lo - s) * i / (n - 1)).collect()
    };
    let mut out = Vec::new();
    if kx + kw < cw {
        let x = (kx + kw).saturating_sub(on_picture).min(cw - s);
        out.extend(along(ky, kh, ch).into_iter().map(|y| (x, y, s, s)));
    }
    if kx > 0 {
        let x = kx.saturating_sub(s - on_picture);
        out.extend(along(ky, kh, ch).into_iter().map(|y| (x, y, s, s)));
    }
    if ky + kh < ch {
        let y = (ky + kh).saturating_sub(on_picture).min(ch - s);
        out.extend(along(kx, kw, cw).into_iter().map(|x| (x, y, s, s)));
    }
    if ky > 0 {
        let y = ky.saturating_sub(s - on_picture);
        out.extend(along(kx, kw, cw).into_iter().map(|x| (x, y, s, s)));
    }
    out
}

/// The Expand tool's "people" mode for pictures with someone at the edge (a hand, a knee
/// cut off by the frame). The default HQ fill redraws a strip inside the picture and
/// works at about 768 x 512 for the whole canvas, so a hand at the edge is a few pixels
/// and came out as a blob. Here:
///   - the picture stays exactly as it was (keep_original, colours matched outside it),
///   - a first pass lays out the whole border (like the default, with the people prompt),
///   - then windows along the picture's edges are redrawn at SD's own 512 x 512, so SD
///     sees the hand and carries it on (see PEOPLE_STRENGTH).
///
/// The windows all start from the first pass and run as one batch: the 1.7 GB unet loads
/// once for all of them (it took 5 s per load, longer than a window's denoising).
/// canvas must have the picture at `keep` unchanged (LaMa's layout blends into it).
pub fn refine_people(
    model_dir: &Path,
    canvas: &RgbaImage,
    keep: (u32, u32, u32, u32),
    band: u32,
    seed: u64,
    progress: &dyn Fn(u32, u32),
) -> Result<RgbaImage, String> {
    let layout = Tuning {
        near: PEOPLE_STRENGTH,
        far: STRENGTH_FAR,
        guidance: GUIDANCE,
        keep_original: true,
        reseed: false,
        embeds: Some(PEOPLE_EMBEDS),
        work: WORK_AREA,
    };
    // the windows' outer part already has the layout's background, it only joins up. At
    // 512 x 512, SD 1.5's own size (640 x 640 took a third longer and drew no better)
    let detail = Tuning {
        near: PEOPLE_STRENGTH,
        far: 0.5,
        guidance: GUIDANCE,
        keep_original: true,
        reseed: false,
        embeds: Some(PEOPLE_EMBEDS),
        work: 512.0 * 512.0,
    };
    let (cw, ch) = canvas.dimensions();
    let (kx, ky, kw, kh) = keep;
    // the windows and the picture's part of each
    let wins: Vec<((u32, u32, u32, u32), (u32, u32, u32, u32))> = edge_windows((cw, ch), keep)
        .into_iter()
        .filter_map(|(wx, wy, w, h)| {
            let (x0, y0) = (kx.max(wx), ky.max(wy));
            let (x1, y1) = ((kx + kw).min(wx + w), (ky + kh).min(wy + h));
            (x1 > x0 && y1 > y0).then_some(((wx, wy, w, h), (x0 - wx, y0 - wy, x1 - x0, y1 - y0)))
        })
        .collect();
    let first_steps = steps_of(&layout);
    let total = first_steps + steps_of(&detail) * wins.len() as u32;

    let mut out = run_jobs(model_dir, vec![Job::new(canvas, keep, band, seed, &layout)], &|d, _| {
        progress(d, total)
    })?
    .remove(0);

    let jobs: Vec<Job> = wins
        .iter()
        .enumerate()
        .map(|(i, &((wx, wy, w, h), sub_keep))| {
            let sub = image::imageops::crop_imm(&out, wx, wy, w, h).to_image();
            let sub_band = ((w.min(h) as f32 * 0.02).round() as u32).clamp(8, 48);
            Job::new(&sub, sub_keep, sub_band, seed.wrapping_add(i as u64 + 1), &detail)
        })
        .collect();
    let drawn = run_jobs(model_dir, jobs, &|d, _| progress(first_steps + d, total))?;

    for (&((wx, wy, w, h), _), drawn) in wins.iter().zip(&drawn) {
        // back into the canvas, fading in from the window's sides that cut through new
        // canvas (inside the picture both are the untouched picture anyway)
        let fade = (w.min(h) as f32 * 0.15).max(8.0);
        for y in 0..h {
            for x in 0..w {
                let mut d = f32::MAX;
                if wx > 0 {
                    d = d.min(x as f32);
                }
                if wy > 0 {
                    d = d.min(y as f32);
                }
                if wx + w < cw {
                    d = d.min((w - 1 - x) as f32);
                }
                if wy + h < ch {
                    d = d.min((h - 1 - y) as f32);
                }
                let t = (d / fade).clamp(0.0, 1.0);
                let t = t * t * (3.0 - 2.0 * t);
                if t <= 0.0 {
                    continue;
                }
                let q = drawn.get_pixel(x, y);
                let p = out.get_pixel_mut(wx + x, wy + y);
                for c in 0..3 {
                    p[c] = (p[c] as f32 * (1.0 - t) + q[c] as f32 * t).round() as u8;
                }
            }
        }
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
    refine_with(model_dir, canvas, keep, band, seed, &Tuning::SCENERY, progress)
}

/// refine with its knobs set (see Tuning).
pub fn refine_with(
    model_dir: &Path,
    canvas: &RgbaImage,
    keep: (u32, u32, u32, u32),
    band: u32,
    seed: u64,
    tune: &Tuning,
    progress: &dyn Fn(u32, u32),
) -> Result<RgbaImage, String> {
    Ok(run_jobs(model_dir, vec![Job::new(canvas, keep, band, seed, tune)], progress)?.remove(0))
}

/// How many denoising steps a refine with these knobs runs (for a progress total).
fn steps_of(tune: &Tuning) -> u32 {
    (STEPS as f32 * tune.near.max(tune.far)).min(STEPS as f32) as u32
}

/// The DDIM schedule: cumulative alphas and the timesteps of a full run ("leading"
/// spacing, steps offset 1, like SD 1.5's default).
fn schedule() -> (Vec<f64>, Vec<usize>) {
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
    (acp, all)
}

/// One canvas for SD to redraw, carried through the stages of run_jobs.
struct Job<'a> {
    canvas: RgbaImage,
    keep: (u32, u32, u32, u32),
    /// how far inside the picture SD blends in (0 = keep_original)
    band: u32,
    /// keep_original: how far out the colour match fades
    outer: f32,
    seed: u64,
    tune: &'a Tuning<'a>,
    gw: u32,
    gh: u32,
    image_t: Vec<f16>,
    masked_t: Vec<f16>,
    lmask: Vec<f32>,
    /// per latent pixel: the step it joins the denoising (soft img2img)
    start: Vec<usize>,
    /// steps of the full schedule that are skipped
    skip: usize,
}

impl<'a> Job<'a> {
    fn new(canvas: &RgbaImage, keep: (u32, u32, u32, u32), band: u32, seed: u64, tune: &'a Tuning<'a>) -> Self {
        let (cw, ch) = canvas.dimensions();
        let canvas = if tune.reseed { reseed_dark_edges(canvas, keep) } else { canvas.clone() };
        // keep_original: the picture stays as is (no blend band inside it), SD's colours
        // are matched to it outside instead (see finish)
        let outer = band.max(1) as f32 * 2.0;
        let band = if tune.keep_original { 0 } else { band };
        let s = (tune.work / (cw as f32 * ch as f32)).sqrt();
        let gw = round64(cw as f32 * s);
        let gh = round64(ch as f32 * s);
        let (lw, lh) = ((gw / 8) as usize, (gh / 8) as usize);
        let mut job = Job {
            canvas,
            keep,
            band,
            outer,
            seed,
            tune,
            gw,
            gh,
            image_t: Vec::new(),
            masked_t: Vec::new(),
            lmask: Vec::new(),
            start: Vec::new(),
            skip: 0,
        };

        // the picture and the "redraw this" mask at working size
        let small = image::imageops::resize(&job.canvas, gw, gh, FilterType::CatmullRom);
        let sx = cw as f32 / gw as f32;
        let sy = ch as f32 / gh as f32;
        let mut repaint = vec![0f32; (gw * gh) as usize];
        for y in 0..gh {
            for x in 0..gw {
                let cx = ((x as f32 + 0.5) * sx) as u32;
                let cy = ((y as f32 + 0.5) * sy) as u32;
                // everything not fully kept gets redrawn, the blend happens at full size
                if job.weight(cx.min(cw - 1), cy.min(ch - 1)) < 1.0 {
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

        // strength per latent pixel, ramping from tune.near at the picture to tune.far
        // at 60% of the widest border: a pixel joins the denoising at its own step and
        // follows the noised layout until then (soft img2img)
        let (kx, ky, kw, kh) = keep;
        let border = kx.max(cw - kx - kw).max(ky).max(ch - ky - kh).max(1) as f32;
        let first = |st: f32| STEPS - (STEPS as f32 * st).min(STEPS as f32) as usize;
        let skip = first(tune.near.max(tune.far));
        let start: Vec<usize> = (0..lw * lh)
            .map(|i| {
                let cx = ((i % lw) as f32 * 8.0 + 4.0) * sx;
                let cy = ((i / lw) as f32 * 8.0 + 4.0) * sy;
                let dx = (kx as f32 - cx).max(cx - (kx + kw) as f32).max(0.0);
                let dy = (ky as f32 - cy).max(cy - (ky + kh) as f32).max(0.0);
                let d = (dx.max(dy) / (border * 0.6)).min(1.0);
                first(tune.near + (tune.far - tune.near) * d) - skip
            })
            .collect();
        job.image_t = image_t;
        job.masked_t = masked_t;
        job.lmask = lmask;
        job.start = start;
        job.skip = skip;
        job
    }

    fn inside(&self, x: u32, y: u32) -> bool {
        let (kx, ky, kw, kh) = self.keep;
        x >= kx && y >= ky && x < kx + kw && y < ky + kh
    }

    /// How much of the original canvas pixel stays (1 = all of it).
    fn weight(&self, x: u32, y: u32) -> f32 {
        if self.band > 0 {
            keep_weight(x, y, self.keep, self.canvas.dimensions(), self.band)
        } else if self.inside(x, y) {
            1.0
        } else {
            0.0
        }
    }

    /// SD's drawing (working size) into the canvas.
    fn finish(&self, drawn: &RgbaImage) -> RgbaImage {
        let canvas = &self.canvas;
        let (cw, ch) = canvas.dimensions();
        let big = image::imageops::resize(drawn, cw, ch, FilterType::CatmullRom);
        let mut out = canvas.clone();
        if self.tune.keep_original {
            let (kx, ky, kw, kh) = self.keep;
            // SD redraws the picture's edge a little off in colour (it works at a lower
            // resolution). How far off, averaged over 9 x 9 px at the edge, is added to the
            // new pixels and fades out over `outer` px: no seam, and no blend into the
            // picture. Capped: where SD drew something else next to the edge (wall next to
            // skin) the difference isn't a colour cast, carrying it out drew streaks
            let off = |x: u32, y: u32| -> [f32; 3] {
                let mut sum = [0f32; 3];
                let mut n = 0f32;
                for j in y.saturating_sub(4)..=(y + 4).min(ky + kh - 1) {
                    for i in x.saturating_sub(4)..=(x + 4).min(kx + kw - 1) {
                        if !self.inside(i, j) {
                            continue;
                        }
                        let (a, b) = (canvas.get_pixel(i, j), big.get_pixel(i, j));
                        for c in 0..3 {
                            sum[c] += a[c] as f32 - b[c] as f32;
                        }
                        n += 1.0;
                    }
                }
                sum.map(|v| (v / n.max(1.0)).clamp(-SEAM_CAP, SEAM_CAP))
            };
            for y in 0..ch {
                for x in 0..cw {
                    if self.inside(x, y) {
                        continue;
                    }
                    // the nearest pixel of the picture and how far away it is
                    let nx = x.clamp(kx, kx + kw - 1);
                    let ny = y.clamp(ky, ky + kh - 1);
                    let d = (x.abs_diff(nx)).max(y.abs_diff(ny)) as f32;
                    let t = (1.0 - d / self.outer).clamp(0.0, 1.0);
                    let f = t * t * (3.0 - 2.0 * t);
                    let o = if f > 0.0 { off(nx, ny) } else { [0.0; 3] };
                    let q = big.get_pixel(x, y);
                    let p = out.get_pixel_mut(x, y);
                    for c in 0..3 {
                        p[c] = (q[c] as f32 + o[c] * f).round().clamp(0.0, 255.0) as u8;
                    }
                    p[3] = 255;
                }
            }
            return out;
        }
        for (x, y, p) in out.pixels_mut().enumerate().map(|(i, p)| ((i as u32) % cw, (i as u32) / cw, p)) {
            let t = self.weight(x, y);
            if t >= 1.0 {
                continue;
            }
            let q = big.get_pixel(x, y);
            for c in 0..3 {
                p[c] = (p[c] as f32 * t + q[c] as f32 * (1.0 - t)).round() as u8;
            }
            p[3] = 255;
        }
        out
    }
}

/// Redraw the jobs' canvases: encode all, denoise all on one unet session, free the unet,
/// decode all (the VAE sessions only live for their stage, see the module notes). The
/// progress counts the steps of all jobs.
fn run_jobs(model_dir: &Path, jobs: Vec<Job>, progress: &dyn Fn(u32, u32)) -> Result<Vec<RgbaImage>, String> {
    let (acp, all) = schedule();
    let ratio = TRAIN_STEPS / STEPS;

    // encode: the picture and the masked picture of every job
    let mut inputs = Vec::with_capacity(2 * jobs.len());
    for j in &jobs {
        inputs.push((j.image_t.clone(), j.gw, j.gh));
        inputs.push((j.masked_t.clone(), j.gw, j.gh));
    }
    let lat = run_vae_encoder(&model_dir.join("vae_encoder.onnx"), &inputs)?;

    // denoise every job on one unet session
    let total: u32 = jobs.iter().map(|j| (all.len() - j.skip) as u32).sum();
    let mut done = 0u32;
    let mut results: Vec<Vec<f32>> = Vec::with_capacity(jobs.len());
    {
        let mut unet = session(&model_dir.join("unet.onnx"))?;
        for (n, j) in jobs.iter().enumerate() {
            let (lat0, mlat) = (&lat[2 * n], &lat[2 * n + 1]);
            let (lw, lh) = ((j.gw / 8) as usize, (j.gh / 8) as usize);
            let lsize = 4 * lw * lh;
            let timesteps = &all[j.skip..];

            // start from the layout's latent, noised to the first timestep (the seed comes
            // from the editor, a new one each time: Expand again draws something different)
            let mut rng = rand::rngs::StdRng::seed_from_u64(j.seed);
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
                let raw = match j.tune.embeds {
                    Some(b) => b.to_vec(),
                    None => std::fs::read(model_dir.join("prompt_embeds.bin"))
                        .map_err(|e| format!("read prompt: {e}"))?,
                };
                if raw.len() != 2 * 77 * 768 * 2 {
                    return Err("The HQ model files are damaged (prompt).".into());
                }
                raw.chunks_exact(2).map(|b| f16::from_le_bytes([b[0], b[1]])).collect::<Vec<f16>>()
            };

            for (step, &ts) in timesteps.iter().enumerate() {
                // pixels that start later still follow the layout, noised to this step
                let a_now = acp[ts] as f32;
                for i in 0..lsize {
                    if step < j.start[i % (lw * lh)] {
                        x[i] = noised(i, a_now);
                    }
                }
                // [x | mask | masked latent], twice (negative + prompt)
                let mut sample = Vec::with_capacity(2 * 9 * lw * lh);
                for _ in 0..2 {
                    sample.extend(x.iter().map(|v| f16::from_f32(*v)));
                    sample.extend(j.lmask.iter().map(|v| f16::from_f32(*v)));
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
                    let e = un + j.tune.guidance * (co - un);
                    let x0 = (x[i] - (1.0 - a_t).sqrt() * e) / a_t.sqrt();
                    x[i] = a_p.sqrt() * x0 + (1.0 - a_p).sqrt() * e;
                }
                done += 1;
                progress(done, total);
            }
            results.push(x);
        }
        // the unet is freed here, before the VAE decoder loads
    }

    // decode, scale up, blend into each canvas
    let mut dec = session(&model_dir.join("vae_decoder.onnx"))?;
    let mut out = Vec::with_capacity(jobs.len());
    for (j, x) in jobs.iter().zip(results) {
        let (gw, gh) = (j.gw, j.gh);
        let (lw, lh) = ((gw / 8) as usize, (gh / 8) as usize);
        let plane = (gw * gh) as usize;
        let lat_in: Vec<f16> = x.iter().map(|v| f16::from_f32(v / VAE_SCALE)).collect();
        let t = Tensor::from_array(([1usize, 4, lh, lw], lat_in)).map_err(|e| format!("vae tensor: {e}"))?;
        let res = dec.run(ort::inputs!["latent" => t]).map_err(|e| format!("vae decode: {e}"))?;
        let (_, data) = res[0].try_extract_tensor::<f16>().map_err(|e| format!("vae out: {e}"))?;
        let decoded: Vec<f32> = data.iter().map(|v| v.to_f32()).collect();
        let mut drawn = RgbaImage::new(gw, gh);
        for (x, y, p) in drawn.enumerate_pixels_mut() {
            let i = (y * gw + x) as usize;
            let ch = |c: usize| ((decoded[c * plane + i] + 1.0) * 127.5).round().clamp(0.0, 255.0) as u8;
            *p = image::Rgba([ch(0), ch(1), ch(2), 255]);
        }
        out.push(j.finish(&drawn));
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// people mode's windows sit on the picture's edge and cover all of it
    #[test]
    fn edge_windows_follow_the_edge() {
        // picture on the left, new canvas on the right
        let wins = edge_windows((1600, 1500), (0, 0, 1000, 1500));
        assert!(wins.len() >= 4, "{wins:?}");
        for &(x, _, w, h) in &wins {
            assert_eq!((w, h), (450, 450));
            assert!(x < 1000 && x + w > 1000, "straddles the edge: {wins:?}");
        }
        assert_eq!(wins.first().unwrap().1, 0);
        let last = wins.last().unwrap();
        assert_eq!(last.1 + last.3, 1500);
        // centred picture: windows on both sides, none on top or bottom
        let both = edge_windows((2000, 1000), (500, 0, 1000, 1000));
        assert!(both.iter().any(|w| w.0 < 500) && both.iter().any(|w| w.0 + w.2 > 1500));
        assert!(both.iter().all(|w| w.3 == 384 || w.3 == both[0].3));
    }

    /// keep_original never changes a pixel of the picture, the default blends into it
    #[test]
    fn people_mode_leaves_the_picture_alone() {
        let mut canvas = RgbaImage::new(96, 64);
        for (x, y, p) in canvas.enumerate_pixels_mut() {
            *p = image::Rgba([(x * 2) as u8, (y * 3) as u8, ((x + y) % 251) as u8, 255]);
        }
        let keep = (0, 0, 60, 64);
        let people = Tuning {
            near: PEOPLE_STRENGTH,
            far: STRENGTH_FAR,
            guidance: GUIDANCE,
            keep_original: true,
            reseed: false,
            embeds: Some(PEOPLE_EMBEDS),
            work: WORK_AREA,
        };
        let job = Job::new(&canvas, keep, 8, 1, &people);
        // SD "drew" a flat grey everywhere
        let drawn = RgbaImage::from_pixel(job.gw, job.gh, image::Rgba([90, 90, 90, 255]));
        let out = job.finish(&drawn);
        for y in 0..64 {
            for x in 0..60 {
                assert_eq!(out.get_pixel(x, y), canvas.get_pixel(x, y), "picture changed at {x},{y}");
            }
        }
        // ...and outside it's SD's drawing, matched to the edge only near it
        assert_ne!(out.get_pixel(61, 10), canvas.get_pixel(61, 10));
        assert_eq!(out.get_pixel(95, 10).0[..3], [90, 90, 90]);

        let job = Job::new(&canvas, keep, 8, 1, &Tuning::SCENERY);
        let drawn = RgbaImage::from_pixel(job.gw, job.gh, image::Rgba([90, 90, 90, 255]));
        let out = job.finish(&drawn);
        assert_ne!(out.get_pixel(58, 10), canvas.get_pixel(58, 10), "the default blends into the picture");
        assert_eq!(out.get_pixel(10, 10), canvas.get_pixel(10, 10));
    }
}
