//! Image editing: object remover without AI (content-aware fill) + helpers.
//!
//! Two fill methods, remove_region picks one:
//! * Telea (2003) Fast Marching - fills from the edge inward with a weighted
//!   average of known neighbours. Good and fast for thin things (text, watermarks),
//!   but smears bigger holes.
//! * PatchMatch content-aware fill (like Photoshop's) - rebuilds the hole from real
//!   7x7 patches around it, coarse to fine, so texture survives. For bigger areas.

use base64::{engine::general_purpose::STANDARD, Engine as _};
use image::{DynamicImage, GrayImage, ImageFormat, RgbaImage};
use rand::rngs::StdRng;
use rand::{Rng, SeedableRng};
use std::cmp::Ordering;
use std::collections::BinaryHeap;
use std::io::Cursor;

const KNOWN: u8 = 0; // pixel value is final
const BAND: u8 = 1; // on the marching front
const INSIDE: u8 = 2; // unknown (to be filled)
const INF: f32 = 1.0e6;
const EPS: f32 = 1.0e-6;

/* ---- base64 / decode / encode helpers -------------------------------- */

/// Remove an optional "data:<mime>;base64," prefix and decode.
fn decode_data_url(s: &str) -> Result<Vec<u8>, String> {
    let payload = match s.find(";base64,") {
        Some(i) => &s[i + 8..],
        None => s,
    };
    STANDARD
        .decode(payload.trim())
        .map_err(|e| format!("base64 decode failed: {e}"))
}

/// Decode a base64 image into RGBA.
pub fn decode_rgba(image_b64: &str) -> Result<RgbaImage, String> {
    let bytes = decode_data_url(image_b64)?;
    let img = image::load_from_memory(&bytes).map_err(|e| format!("decode image: {e}"))?;
    Ok(img.to_rgba8())
}

/// Make a remove mask (255 = remove) from a painted PNG: opaque enough = masked.
/// Fully opaque masks use brightness instead.
pub fn decode_mask(mask_b64: &str, w: u32, h: u32) -> Result<GrayImage, String> {
    let bytes = decode_data_url(mask_b64)?;
    let img = image::load_from_memory(&bytes)
        .map_err(|e| format!("decode mask: {e}"))?
        .to_rgba8();
    if img.width() != w || img.height() != h {
        return Err(format!(
            "mask size {}x{} does not match image {}x{}",
            img.width(),
            img.height(),
            w,
            h
        ));
    }
    let mut out = GrayImage::new(w, h);
    // all opaque -> brightness mask (white = remove), else use alpha
    let any_transparent = img.pixels().any(|p| p[3] < 250);
    for (x, y, p) in img.enumerate_pixels() {
        let on = if any_transparent {
            p[3] > 16
        } else {
            // brightness
            (0.299 * p[0] as f32 + 0.587 * p[1] as f32 + 0.114 * p[2] as f32) > 32.0
        };
        out.put_pixel(x, y, image::Luma([if on { 255 } else { 0 }]));
    }
    Ok(out)
}

/// RGBA -> PNG data URL.
pub fn encode_png_data_url(img: &RgbaImage) -> Result<String, String> {
    let mut buf = Vec::new();
    DynamicImage::ImageRgba8(img.clone())
        .write_to(&mut Cursor::new(&mut buf), ImageFormat::Png)
        .map_err(|e| format!("encode png: {e}"))?;
    Ok(format!("data:image/png;base64,{}", STANDARD.encode(buf)))
}

/* ---- Telea fast-marching inpainting ---------------------------------- */

/// Heap item sorted by T (smallest first).
#[derive(Copy, Clone)]
struct Node {
    t: f32,
    x: i32,
    y: i32,
}
impl PartialEq for Node {
    fn eq(&self, o: &Self) -> bool {
        self.t == o.t
    }
}
impl Eq for Node {}
impl PartialOrd for Node {
    fn partial_cmp(&self, o: &Self) -> Option<Ordering> {
        Some(self.cmp(o))
    }
}
impl Ord for Node {
    fn cmp(&self, o: &Self) -> Ordering {
        // reversed so the max-heap gives the smallest T first
        o.t.partial_cmp(&self.t).unwrap_or(Ordering::Equal)
    }
}

struct Grid {
    w: i32,
    h: i32,
    flag: Vec<u8>,
    t: Vec<f32>,
}
impl Grid {
    #[inline]
    fn idx(&self, x: i32, y: i32) -> usize {
        (y * self.w + x) as usize
    }
    #[inline]
    fn inside(&self, x: i32, y: i32) -> bool {
        x >= 0 && y >= 0 && x < self.w && y < self.h
    }
    #[inline]
    fn flag(&self, x: i32, y: i32) -> u8 {
        if self.inside(x, y) {
            self.flag[self.idx(x, y)]
        } else {
            KNOWN // treat out-of-bounds as known so the front never leaks outward
        }
    }
    #[inline]
    fn tval(&self, x: i32, y: i32) -> f32 {
        if self.inside(x, y) {
            self.t[self.idx(x, y)]
        } else {
            INF
        }
    }
}

/// Eikonal update: estimate T from two neighbours.
fn solve(g: &Grid, x1: i32, y1: i32, x2: i32, y2: i32) -> f32 {
    let f1 = g.flag(x1, y1);
    let f2 = g.flag(x2, y2);
    if f1 != INSIDE {
        let t1 = g.tval(x1, y1);
        if f2 != INSIDE {
            let t2 = g.tval(x2, y2);
            let d = 2.0 - (t1 - t2) * (t1 - t2);
            if d > 0.0 {
                let r = d.sqrt();
                let mut s = (t1 + t2 - r) * 0.5;
                if s >= t1 && s >= t2 {
                    return s;
                }
                s = (t1 + t2 + r) * 0.5;
                if s >= t1 && s >= t2 {
                    return s;
                }
            }
            return 1.0 + t1.min(t2);
        }
        return 1.0 + t1;
    } else if f2 != INSIDE {
        return 1.0 + g.tval(x2, y2);
    }
    INF
}

/// Fill one masked pixel with a weighted average of known neighbours within radius.
fn inpaint_point(img: &mut RgbaImage, g: &Grid, x: i32, y: i32, radius: i32) {
    // gradient of T -> marching direction
    let gtx = {
        let a = if g.flag(x + 1, y) != INSIDE { g.tval(x + 1, y) } else { g.tval(x, y) };
        let b = if g.flag(x - 1, y) != INSIDE { g.tval(x - 1, y) } else { g.tval(x, y) };
        (a - b) * 0.5
    };
    let gty = {
        let a = if g.flag(x, y + 1) != INSIDE { g.tval(x, y + 1) } else { g.tval(x, y) };
        let b = if g.flag(x, y - 1) != INSIDE { g.tval(x, y - 1) } else { g.tval(x, y) };
        (a - b) * 0.5
    };

    let mut acc = [0.0f32; 3];
    let mut wsum = 0.0f32;
    let r2 = (radius * radius) as f32;
    for dy in -radius..=radius {
        for dx in -radius..=radius {
            if dx == 0 && dy == 0 {
                continue;
            }
            let nx = x + dx;
            let ny = y + dy;
            if !g.inside(nx, ny) || g.flag(nx, ny) != KNOWN {
                continue;
            }
            let fdx = dx as f32;
            let fdy = dy as f32;
            let dist2 = fdx * fdx + fdy * fdy;
            if dist2 > r2 {
                continue;
            }
            // prefer neighbours along the normal
            let mut dir = fdx * gtx + fdy * gty;
            if dir.abs() <= EPS {
                dir = EPS;
            }
            let geom = 1.0 / dist2; // closer pixels weigh more
            let lev = 1.0 / (1.0 + (g.tval(nx, ny) - g.tval(x, y)).abs());
            let w = (dir / dist2.sqrt()).abs() * geom * lev;

            // weighted average of real colors, so it can't go outside the colors around it
            let px = *img.get_pixel(nx as u32, ny as u32);
            for c in 0..3 {
                acc[c] += w * px[c] as f32;
            }
            wsum += w;
        }
    }

    let out = if wsum > EPS {
        [
            (acc[0] / wsum).round().clamp(0.0, 255.0) as u8,
            (acc[1] / wsum).round().clamp(0.0, 255.0) as u8,
            (acc[2] / wsum).round().clamp(0.0, 255.0) as u8,
        ]
    } else {
        // no known neighbour, leave it (the next ring fills it)
        let p = img.get_pixel(x as u32, y as u32);
        [p[0], p[1], p[2]]
    };
    let a = img.get_pixel(x as u32, y as u32)[3];
    img.put_pixel(x as u32, y as u32, image::Rgba([out[0], out[1], out[2], a]));
}

/// Remove the masked area of img with Telea inpainting.
/// mask = 255 where to fill, radius = how far to look for known pixels.
pub fn inpaint_telea(img: &mut RgbaImage, mask: &GrayImage, radius: i32) {
    let w = img.width() as i32;
    let h = img.height() as i32;
    let n = (w * h) as usize;

    let mut g = Grid {
        w,
        h,
        flag: vec![KNOWN; n],
        t: vec![0.0; n],
    };
    for (x, y, p) in mask.enumerate_pixels() {
        if p[0] > 0 {
            let i = g.idx(x as i32, y as i32);
            g.flag[i] = INSIDE;
            g.t[i] = INF;
        }
    }

    // start with masked pixels next to known ones (T = 0), then march inward
    let mut heap: BinaryHeap<Node> = BinaryHeap::new();
    const NB: [(i32, i32); 4] = [(-1, 0), (1, 0), (0, -1), (0, 1)];
    for y in 0..h {
        for x in 0..w {
            if g.flag(x, y) != INSIDE {
                continue;
            }
            let touches_known = NB.iter().any(|(dx, dy)| g.flag(x + dx, y + dy) == KNOWN);
            if touches_known {
                let i = g.idx(x, y);
                g.flag[i] = BAND;
                g.t[i] = 0.0;
                heap.push(Node { t: 0.0, x, y });
            }
        }
    }
    let radius = radius.max(2);

    while let Some(Node { x, y, .. }) = heap.pop() {
        let i = g.idx(x, y);
        if g.flag[i] == KNOWN {
            continue; // stale duplicate
        }
        // this pixel is done: fill it and mark it known
        inpaint_point(img, &g, x, y, radius);
        g.flag[i] = KNOWN;

        for (dx, dy) in NB {
            let nx = x + dx;
            let ny = y + dy;
            if !g.inside(nx, ny) {
                continue;
            }
            let ni = g.idx(nx, ny);
            if g.flag[ni] == INSIDE {
                let t = solve(&g, nx - 1, ny, nx, ny - 1)
                    .min(solve(&g, nx + 1, ny, nx, ny - 1))
                    .min(solve(&g, nx - 1, ny, nx, ny + 1))
                    .min(solve(&g, nx + 1, ny, nx, ny + 1));
                g.t[ni] = t;
                g.flag[ni] = BAND;
                heap.push(Node { t, x: nx, y: ny });
            }
        }
    }
}

/// Public version for other modules (the AI remover grows its mask the same way).
pub fn dilate_mask(mask: &GrayImage, r: i32) -> GrayImage {
    dilate(mask, r)
}

/// Soften a mask's edges with a box blur of radius r (hard mask -> smooth alpha).
/// The window is divided by its real length at the border, so edges don't fade.
pub fn feather_mask(mask: &GrayImage, r: i32) -> GrayImage {
    if r <= 0 {
        return mask.clone();
    }
    let (w, h, r) = (mask.width() as i64, mask.height() as i64, r as i64);
    if w == 0 || h == 0 {
        return mask.clone();
    }

    // horizontal pass with prefix sums (cost doesn't depend on r)
    let mut tmp = vec![0u8; (w * h) as usize];
    let mut pre = vec![0u32; (w + 1) as usize];
    for y in 0..h {
        for x in 0..w {
            pre[(x + 1) as usize] = pre[x as usize] + mask.get_pixel(x as u32, y as u32)[0] as u32;
        }
        for x in 0..w {
            let lo = (x - r).max(0);
            let hi = (x + r + 1).min(w);
            let sum = pre[hi as usize] - pre[lo as usize];
            tmp[(y * w + x) as usize] = (sum / (hi - lo) as u32) as u8;
        }
    }

    // vertical pass
    let mut out = GrayImage::new(mask.width(), mask.height());
    let mut col = vec![0u32; (h + 1) as usize];
    for x in 0..w {
        for y in 0..h {
            col[(y + 1) as usize] = col[y as usize] + tmp[(y * w + x) as usize] as u32;
        }
        for y in 0..h {
            let lo = (y - r).max(0);
            let hi = (y + r + 1).min(h);
            let sum = col[hi as usize] - col[lo as usize];
            out.put_pixel(x as u32, y as u32, image::Luma([(sum / (hi - lo) as u32) as u8]));
        }
    }
    out
}

/// Grow a mask by r pixels, so the object's soft edge/shadow is removed too.
fn dilate(mask: &GrayImage, r: i32) -> GrayImage {
    if r <= 0 {
        return mask.clone();
    }
    let w = mask.width() as i32;
    let h = mask.height() as i32;
    let mut tmp = GrayImage::new(mask.width(), mask.height());
    // horizontal pass
    for y in 0..h {
        for x in 0..w {
            let mut on = false;
            for dx in -r..=r {
                let nx = x + dx;
                if nx >= 0 && nx < w && mask.get_pixel(nx as u32, y as u32)[0] > 0 {
                    on = true;
                    break;
                }
            }
            tmp.put_pixel(x as u32, y as u32, image::Luma([if on { 255 } else { 0 }]));
        }
    }
    // vertical pass
    let mut out = GrayImage::new(mask.width(), mask.height());
    for y in 0..h {
        for x in 0..w {
            let mut on = false;
            for dy in -r..=r {
                let ny = y + dy;
                if ny >= 0 && ny < h && tmp.get_pixel(x as u32, ny as u32)[0] > 0 {
                    on = true;
                    break;
                }
            }
            out.put_pixel(x as u32, y as u32, image::Luma([if on { 255 } else { 0 }]));
        }
    }
    out
}

/// Remove the selected area: grow it a bit, then fill with Telea for thin strokes
/// (text/watermarks) or PatchMatch for bigger areas (keeps texture).
pub fn remove_region(img: &mut RgbaImage, mask: &GrayImage) {
    let span = img.width().max(img.height());
    let grow = if span > 1600 { 3 } else { 2 };
    let grown = dilate(mask, grow);

    let area = grown.pixels().filter(|p| p[0] > 0).count();
    // "thin" = nothing is left after a 4px erosion (max ~9px thick)
    let thin = area > 0 && erode(&grown, 4).pixels().all(|p| p[0] == 0);
    if area < 600 || thin {
        let radius = if span > 1600 { 7 } else { 5 };
        inpaint_telea(img, &grown, radius);
    } else {
        inpaint_patchmatch(img, &grown);
    }
}

/* ---- PatchMatch content-aware fill ------------------------------------ */

const PATCH_R: i32 = 3; // 7×7 patches
const PATCH_W: i32 = 2 * PATCH_R + 1;

/// One pyramid level of the fill.
struct Pm {
    w: i32,
    h: i32,
    /// Current color guess. Known pixels always keep their real color.
    rgb: Vec<[f32; 3]>,
    /// True where the pixel must be filled.
    hole: Vec<bool>,
    /// True where a patch here is fully inside the image and has no hole pixel
    /// (a valid source patch).
    src_ok: Vec<bool>,
    /// Indices of all src_ok pixels (for random picks).
    valid_src: Vec<i32>,
}

impl Pm {
    #[inline]
    fn idx(&self, x: i32, y: i32) -> usize {
        (y * self.w + x) as usize
    }

    /// Recompute src_ok/valid_src with an integral image (O(1) hole checks).
    fn build_sources(&mut self) {
        let w = self.w;
        let h = self.h;
        let cols = (w + 1) as usize;
        let mut integ = vec![0i32; cols * (h as usize + 1)];
        for y in 0..h as usize {
            let mut rs = 0i32;
            for x in 0..w as usize {
                rs += self.hole[y * w as usize + x] as i32;
                integ[(y + 1) * cols + (x + 1)] = integ[y * cols + (x + 1)] + rs;
            }
        }
        let holes_in = |x0: i32, y0: i32, x1: i32, y1: i32| -> i32 {
            integ[(y1 + 1) as usize * cols + (x1 + 1) as usize]
                - integ[y0 as usize * cols + (x1 + 1) as usize]
                - integ[(y1 + 1) as usize * cols + x0 as usize]
                + integ[y0 as usize * cols + x0 as usize]
        };
        self.src_ok = vec![false; (w * h) as usize];
        self.valid_src.clear();
        for y in PATCH_R..h - PATCH_R {
            for x in PATCH_R..w - PATCH_R {
                if holes_in(x - PATCH_R, y - PATCH_R, x + PATCH_R, y + PATCH_R) == 0 {
                    self.src_ok[(y * w + x) as usize] = true;
                    self.valid_src.push(y * w + x);
                }
            }
        }
    }

    /// All pixels whose patch touches the hole (the targets).
    fn targets(&self) -> Vec<i32> {
        let grown = {
            // Grow the hole by PATCH_R with row/column passes.
            let w = self.w;
            let h = self.h;
            let mut tmp = vec![false; (w * h) as usize];
            for y in 0..h {
                for x in 0..w {
                    if self.hole[(y * w + x) as usize] {
                        let x0 = (x - PATCH_R).max(0);
                        let x1 = (x + PATCH_R).min(w - 1);
                        for nx in x0..=x1 {
                            tmp[(y * w + nx) as usize] = true;
                        }
                    }
                }
            }
            let mut out = vec![false; (w * h) as usize];
            for y in 0..h {
                for x in 0..w {
                    if tmp[(y * w + x) as usize] {
                        let y0 = (y - PATCH_R).max(0);
                        let y1 = (y + PATCH_R).min(h - 1);
                        for ny in y0..=y1 {
                            out[(ny * w + x) as usize] = true;
                        }
                    }
                }
            }
            out
        };
        (0..self.w * self.h).filter(|&i| grown[i as usize]).collect()
    }
}

/// SSD between the target patch and the source patch. Stops early above bail.
fn patch_cost(pm: &Pm, tx: i32, ty: i32, sx: i32, sy: i32, bail: f32) -> f32 {
    let mut sum = 0.0f32;
    for dy in -PATCH_R..=PATCH_R {
        let tyy = (ty + dy).clamp(0, pm.h - 1);
        let srow = ((sy + dy) * pm.w + sx) as usize;
        for dx in -PATCH_R..=PATCH_R {
            let txx = (tx + dx).clamp(0, pm.w - 1);
            let a = pm.rgb[(tyy * pm.w + txx) as usize];
            let b = pm.rgb[(srow as i32 + dx) as usize];
            let dr = a[0] - b[0];
            let dg = a[1] - b[1];
            let db = a[2] - b[2];
            sum += dr * dr + dg * dg + db * db;
        }
        if sum >= bail {
            return sum;
        }
    }
    sum
}

/// One PatchMatch pass (propagation + random search).
fn pm_iterate(
    pm: &Pm,
    targets: &[i32],
    nnf: &mut [i32],
    cost: &mut [f32],
    rng: &mut StdRng,
    reverse: bool,
) {
    let w = pm.w;
    let try_candidate = |pm: &Pm, t: i32, s: i32, nnf: &mut [i32], cost: &mut [f32]| {
        let (sx, sy) = (s % w, s / w);
        if !pm.src_ok[s as usize] {
            return;
        }
        let (tx, ty) = (t % w, t / w);
        let c = patch_cost(pm, tx, ty, sx, sy, cost[t as usize]);
        if c < cost[t as usize] {
            cost[t as usize] = c;
            nnf[t as usize] = s;
        }
    };

    let order: Box<dyn Iterator<Item = &i32>> = if reverse {
        Box::new(targets.iter().rev())
    } else {
        Box::new(targets.iter())
    };
    let dirs: [(i32, i32); 2] = if reverse { [(1, 0), (0, 1)] } else { [(-1, 0), (0, -1)] };

    for &t in order {
        let (tx, ty) = (t % w, t / w);
        // propagation: take a neighbour's (shifted) match if it's better
        for (dx, dy) in dirs {
            let nx = tx + dx;
            let ny = ty + dy;
            if nx < 0 || ny < 0 || nx >= w || ny >= pm.h {
                continue;
            }
            let ns = nnf[(ny * w + nx) as usize];
            if ns < 0 {
                continue;
            }
            let cand = ns - (dy * w + dx); // neighbour's source, shifted back to us
            let (cx, cy) = (cand % w, cand / w);
            if cx < PATCH_R || cy < PATCH_R || cx >= w - PATCH_R || cy >= pm.h - PATCH_R {
                continue;
            }
            try_candidate(pm, t, cand, nnf, cost);
        }
        // random search in a shrinking window around the best
        let best = nnf[t as usize];
        if best >= 0 {
            let (bx, by) = (best % w, best / w);
            let mut radius = (w.max(pm.h) / 2) as f32;
            while radius >= 1.0 {
                let r = radius as i32;
                let sx = (bx + rng.gen_range(-r..=r)).clamp(PATCH_R, w - 1 - PATCH_R);
                let sy = (by + rng.gen_range(-r..=r)).clamp(PATCH_R, pm.h - 1 - PATCH_R);
                try_candidate(pm, t, sy * w + sx, nnf, cost);
                radius *= 0.5;
            }
        }
    }
}

/// Recompute every hole pixel as the weighted average of all source pixels the
/// covering patches point to (voting).
fn pm_vote(pm: &mut Pm, targets: &[i32], nnf: &[i32], cost: &[f32]) {
    let w = pm.w;
    let h = pm.h;
    let npx = (PATCH_W * PATCH_W * 3) as f32;
    let mut acc = vec![[0.0f32; 4]; (w * h) as usize];
    for &t in targets {
        let s = nnf[t as usize];
        if s < 0 {
            continue;
        }
        let (tx, ty) = (t % w, t / w);
        let (sx, sy) = (s % w, s / w);
        // better matches get more weight
        let weight = 1.0 / (1.0 + cost[t as usize] / (npx * 200.0));
        for dy in -PATCH_R..=PATCH_R {
            let hy = ty + dy;
            if hy < 0 || hy >= h {
                continue;
            }
            for dx in -PATCH_R..=PATCH_R {
                let hx = tx + dx;
                if hx < 0 || hx >= w {
                    continue;
                }
                let hi = (hy * w + hx) as usize;
                if !pm.hole[hi] {
                    continue;
                }
                let sc = pm.rgb[((sy + dy) * w + sx + dx) as usize];
                let a = &mut acc[hi];
                a[0] += weight * sc[0];
                a[1] += weight * sc[1];
                a[2] += weight * sc[2];
                a[3] += weight;
            }
        }
    }
    for i in 0..acc.len() {
        if pm.hole[i] && acc[i][3] > 0.0 {
            pm.rgb[i] = [acc[i][0] / acc[i][3], acc[i][1] / acc[i][3], acc[i][2] / acc[i][3]];
        }
    }
}

/// Run search <-> vote rounds on one level.
fn pm_solve_level(pm: &mut Pm, em_rounds: usize, rng: &mut StdRng) {
    pm.build_sources();
    if pm.valid_src.is_empty() {
        return; // hole covers (almost) the whole crop — keep the diffused estimate
    }
    let targets = pm.targets();
    let n = (pm.w * pm.h) as usize;
    let mut nnf = vec![-1i32; n];
    let mut cost = vec![f32::INFINITY; n];
    for round in 0..em_rounds {
        if round == 0 {
            // random start
            for &t in &targets {
                let s = pm.valid_src[rng.gen_range(0..pm.valid_src.len())];
                let (tx, ty) = (t % pm.w, t / pm.w);
                nnf[t as usize] = s;
                cost[t as usize] = patch_cost(pm, tx, ty, s % pm.w, s / pm.w, f32::INFINITY);
            }
        } else {
            // the estimate changed after voting, update the costs
            for &t in &targets {
                let s = nnf[t as usize];
                if s >= 0 {
                    let (tx, ty) = (t % pm.w, t / pm.w);
                    cost[t as usize] = patch_cost(pm, tx, ty, s % pm.w, s / pm.w, f32::INFINITY);
                }
            }
        }
        pm_iterate(pm, &targets, &mut nnf, &mut cost, rng, false);
        pm_iterate(pm, &targets, &mut nnf, &mut cost, rng, true);
        pm_vote(pm, &targets, &nnf, &cost);
    }
}

/// Halve a level: colors average only the known children, a coarse pixel is a hole
/// if any child is.
fn pm_downsample(p: &Pm) -> Pm {
    let w2 = (p.w + 1) / 2;
    let h2 = (p.h + 1) / 2;
    let mut rgb = vec![[0.0f32; 3]; (w2 * h2) as usize];
    let mut hole = vec![false; (w2 * h2) as usize];
    for y2 in 0..h2 {
        for x2 in 0..w2 {
            let mut sum = [0.0f32; 3];
            let mut known = 0u32;
            let mut any_hole = false;
            for dy in 0..2 {
                for dx in 0..2 {
                    let x = (x2 * 2 + dx).min(p.w - 1);
                    let y = (y2 * 2 + dy).min(p.h - 1);
                    let i = p.idx(x, y);
                    if p.hole[i] {
                        any_hole = true;
                    } else {
                        let c = p.rgb[i];
                        sum[0] += c[0];
                        sum[1] += c[1];
                        sum[2] += c[2];
                        known += 1;
                    }
                }
            }
            let o = (y2 * w2 + x2) as usize;
            hole[o] = any_hole;
            if known > 0 {
                rgb[o] = [sum[0] / known as f32, sum[1] / known as f32, sum[2] / known as f32];
            }
        }
    }
    Pm { w: w2, h: h2, rgb, hole, src_ok: Vec::new(), valid_src: Vec::new() }
}

/// Fill fine's hole pixels from the solved coarse level (bilinear), known pixels stay.
fn pm_upsample_into(fine: &mut Pm, coarse: &Pm) {
    for y in 0..fine.h {
        for x in 0..fine.w {
            let i = fine.idx(x, y);
            if !fine.hole[i] {
                continue;
            }
            let fx = ((x as f32 + 0.5) / 2.0 - 0.5).clamp(0.0, (coarse.w - 1) as f32);
            let fy = ((y as f32 + 0.5) / 2.0 - 0.5).clamp(0.0, (coarse.h - 1) as f32);
            let x0 = fx.floor() as i32;
            let y0 = fy.floor() as i32;
            let x1 = (x0 + 1).min(coarse.w - 1);
            let y1 = (y0 + 1).min(coarse.h - 1);
            let ax = fx - x0 as f32;
            let ay = fy - y0 as f32;
            let mut out = [0.0f32; 3];
            for c in 0..3 {
                let top = coarse.rgb[coarse.idx(x0, y0)][c] * (1.0 - ax)
                    + coarse.rgb[coarse.idx(x1, y0)][c] * ax;
                let bot = coarse.rgb[coarse.idx(x0, y1)][c] * (1.0 - ax)
                    + coarse.rgb[coarse.idx(x1, y1)][c] * ax;
                out[c] = top * (1.0 - ay) + bot * ay;
            }
            fine.rgb[i] = out;
        }
    }
}

/// Bounding box of the mask, or None if empty.
pub fn mask_bbox(mask: &GrayImage) -> Option<(u32, u32, u32, u32)> {
    let (mut x0, mut y0, mut x1, mut y1) = (u32::MAX, u32::MAX, 0u32, 0u32);
    for (x, y, p) in mask.enumerate_pixels() {
        if p[0] > 0 {
            x0 = x0.min(x);
            y0 = y0.min(y);
            x1 = x1.max(x);
            y1 = y1.max(y);
        }
    }
    if x0 == u32::MAX {
        None
    } else {
        Some((x0, y0, x1, y1))
    }
}

/// Content-aware fill: crop around the hole (with margin), solve coarse to fine with
/// PatchMatch + voting, then paste the result back.
pub fn inpaint_patchmatch(img: &mut RgbaImage, mask: &GrayImage) {
    let Some((bx0, by0, bx1, by1)) = mask_bbox(mask) else {
        return;
    };
    let hole_dim = (bx1 - bx0 + 1).max(by1 - by0 + 1);
    let margin = hole_dim.clamp(96, 400);
    let cx0 = bx0.saturating_sub(margin);
    let cy0 = by0.saturating_sub(margin);
    let cx1 = (bx1 + margin).min(img.width() - 1);
    let cy1 = (by1 + margin).min(img.height() - 1);
    let cw = (cx1 - cx0 + 1) as i32;
    let ch = (cy1 - cy0 + 1) as i32;
    if cw < PATCH_W * 3 || ch < PATCH_W * 3 {
        // too small for patches, diffusion is fine
        inpaint_telea(img, mask, 5);
        return;
    }

    // level 0 (full size crop)
    let mut base = Pm {
        w: cw,
        h: ch,
        rgb: Vec::with_capacity((cw * ch) as usize),
        hole: Vec::with_capacity((cw * ch) as usize),
        src_ok: Vec::new(),
        valid_src: Vec::new(),
    };
    for y in cy0..=cy1 {
        for x in cx0..=cx1 {
            let p = img.get_pixel(x, y);
            base.rgb.push([p[0] as f32, p[1] as f32, p[2] as f32]);
            base.hole.push(mask.get_pixel(x, y)[0] > 0);
        }
    }

    // pyramid: halve until the hole is small
    let mut levels = vec![base];
    loop {
        let top = levels.last().unwrap();
        let hole_max = {
            let (mut x0, mut y0, mut x1, mut y1) = (i32::MAX, i32::MAX, -1, -1);
            for y in 0..top.h {
                for x in 0..top.w {
                    if top.hole[top.idx(x, y)] {
                        x0 = x0.min(x);
                        y0 = y0.min(y);
                        x1 = x1.max(x);
                        y1 = y1.max(y);
                    }
                }
            }
            if x1 < 0 { 0 } else { (x1 - x0 + 1).max(y1 - y0 + 1) }
        };
        if hole_max <= 64 || levels.len() >= 5 || top.w.min(top.h) <= 48 {
            break;
        }
        let next = pm_downsample(top);
        levels.push(next);
    }

    // start the coarsest level with a Telea fill
    {
        let top = levels.last_mut().unwrap();
        let mut seed_img = RgbaImage::new(top.w as u32, top.h as u32);
        let mut seed_mask = GrayImage::new(top.w as u32, top.h as u32);
        for y in 0..top.h {
            for x in 0..top.w {
                let i = top.idx(x, y);
                let c = top.rgb[i];
                seed_img.put_pixel(
                    x as u32,
                    y as u32,
                    image::Rgba([c[0] as u8, c[1] as u8, c[2] as u8, 255]),
                );
                if top.hole[i] {
                    seed_mask.put_pixel(x as u32, y as u32, image::Luma([255]));
                }
            }
        }
        inpaint_telea(&mut seed_img, &seed_mask, 5);
        for y in 0..top.h {
            for x in 0..top.w {
                let i = top.idx(x, y);
                if top.hole[i] {
                    let p = seed_img.get_pixel(x as u32, y as u32);
                    top.rgb[i] = [p[0] as f32, p[1] as f32, p[2] as f32];
                }
            }
        }
    }

    // solve coarse -> fine (fixed seed so results are the same every time)
    let mut rng = StdRng::seed_from_u64(0x5eed_u64 ^ ((cw as u64) << 20) ^ ch as u64);
    let n_levels = levels.len();
    for lev in (0..n_levels).rev() {
        if lev + 1 < n_levels {
            let (fine_part, coarse_part) = levels.split_at_mut(lev + 1);
            pm_upsample_into(&mut fine_part[lev], &coarse_part[0]);
        }
        let em = if lev == 0 { 2 } else { 3 };
        pm_solve_level(&mut levels[lev], em, &mut rng);
    }

    // paste the filled pixels back
    let solved = &levels[0];
    for y in 0..solved.h {
        for x in 0..solved.w {
            let i = solved.idx(x, y);
            if !solved.hole[i] {
                continue;
            }
            let gx = cx0 + x as u32;
            let gy = cy0 + y as u32;
            let a = img.get_pixel(gx, gy)[3];
            let c = solved.rgb[i];
            img.put_pixel(
                gx,
                gy,
                image::Rgba([
                    c[0].round().clamp(0.0, 255.0) as u8,
                    c[1].round().clamp(0.0, 255.0) as u8,
                    c[2].round().clamp(0.0, 255.0) as u8,
                    a,
                ]),
            );
        }
    }
}

/* ---- smart object detection inside a rough brush --------------------- */

/// Shrink a mask by r pixels (opposite of dilate).
fn erode(mask: &GrayImage, r: i32) -> GrayImage {
    if r <= 0 {
        return mask.clone();
    }
    let w = mask.width() as i32;
    let h = mask.height() as i32;
    let mut tmp = GrayImage::new(mask.width(), mask.height());
    for y in 0..h {
        for x in 0..w {
            let mut on = true;
            for dx in -r..=r {
                let nx = x + dx;
                if nx < 0 || nx >= w || mask.get_pixel(nx as u32, y as u32)[0] == 0 {
                    on = false;
                    break;
                }
            }
            tmp.put_pixel(x as u32, y as u32, image::Luma([if on { 255 } else { 0 }]));
        }
    }
    let mut out = GrayImage::new(mask.width(), mask.height());
    for y in 0..h {
        for x in 0..w {
            let mut on = true;
            for dy in -r..=r {
                let ny = y + dy;
                if ny < 0 || ny >= h || tmp.get_pixel(x as u32, ny as u32)[0] == 0 {
                    on = false;
                    break;
                }
            }
            out.put_pixel(x as u32, y as u32, image::Luma([if on { 255 } else { 0 }]));
        }
    }
    out
}

#[inline]
fn color_dist2(a: [f32; 3], b: [f32; 3]) -> f32 {
    let dr = a[0] - b[0];
    let dg = a[1] - b[1];
    let db = a[2] - b[2];
    dr * dr + dg * dg + db * db
}

/// Shrink a rough brushed area to just the object inside (also watermarks/text).
/// Two checks inside the brush:
///   1. color outlier - far from every background color (solid objects)
///   2. local contrast - stands out from its blurred surroundings (thin text)
/// Either one counts. A small close connects strokes. If the result is unclear
/// (almost nothing / almost everything) the brush is kept.
/// strength (0..1, ~0.5) = more sensitive when higher.
pub fn detect_object(img: &RgbaImage, rough: &GrayImage, strength: f32) -> GrayImage {
    // higher strength -> lower thresholds
    let k = (1.3 - strength.clamp(0.0, 1.0)).clamp(0.35, 1.3);
    let w = img.width();
    let h = img.height();
    let wi = w as i64;
    let hi = h as i64;
    let at = |x: u32, y: u32| -> [f32; 3] {
        let p = img.get_pixel(x, y);
        [p[0] as f32, p[1] as f32, p[2] as f32]
    };

    // --- brightness + integral image for fast local means ---
    let mut lum = vec![0i64; (w * h) as usize];
    for y in 0..h {
        for x in 0..w {
            let p = img.get_pixel(x, y);
            lum[(y * w + x) as usize] =
                (299 * p[0] as i64 + 587 * p[1] as i64 + 114 * p[2] as i64) / 1000;
        }
    }
    let cols = (w + 1) as usize;
    let mut integ = vec![0i64; cols * (h as usize + 1)];
    for y in 0..h as usize {
        let mut rs = 0i64;
        for x in 0..w as usize {
            rs += lum[y * w as usize + x];
            integ[(y + 1) * cols + (x + 1)] = integ[y * cols + (x + 1)] + rs;
        }
    }
    let rect = |x0: i64, y0: i64, x1: i64, y1: i64| -> i64 {
        let xi = |v: i64| v as usize;
        integ[xi(y1 + 1) * cols + xi(x1 + 1)] - integ[xi(y0) * cols + xi(x1 + 1)]
            - integ[xi(y1 + 1) * cols + xi(x0)]
            + integ[xi(y0) * cols + xi(x0)]
    };
    let rl = ((w.max(h) / 30) as i64).clamp(10, 48); // local window radius
    let local_mean = |cx: i64, cy: i64| -> f32 {
        let x0 = (cx - rl).max(0);
        let y0 = (cy - rl).max(0);
        let x1 = (cx + rl).min(wi - 1);
        let y1 = (cy + rl).min(hi - 1);
        let area = ((x1 - x0 + 1) * (y1 - y0 + 1)) as f32;
        rect(x0, y0, x1, y1) as f32 / area
    };
    let contrast = |x: u32, y: u32| -> f32 {
        (lum[(y * w + x) as usize] as f32 - local_mean(x as i64, y as i64)).abs()
    };

    // --- background ring just outside the brush ---
    let outer = dilate(rough, 9);
    let mut bg: Vec<[f32; 3]> = Vec::new();
    let mut bg_contrast_sum = 0f32;
    let mut bg_contrast_n = 0u64;
    let mut rough_count: u64 = 0;
    for y in 0..h {
        for x in 0..w {
            if rough.get_pixel(x, y)[0] > 0 {
                rough_count += 1;
            } else if outer.get_pixel(x, y)[0] > 0 {
                bg.push(at(x, y));
                bg_contrast_sum += contrast(x, y);
                bg_contrast_n += 1;
            }
        }
    }
    if bg.is_empty() || rough_count == 0 {
        return rough.clone();
    }
    const MAX_BG: usize = 700;
    if bg.len() > MAX_BG {
        let stride = bg.len() / MAX_BG;
        bg = bg.iter().step_by(stride.max(1)).copied().collect();
    }

    // color threshold from the background spread
    let mut mean = [0f32; 3];
    for s in &bg {
        for c in 0..3 {
            mean[c] += s[c];
        }
    }
    for c in 0..3 {
        mean[c] /= bg.len() as f32;
    }
    let mut mad = 0f32;
    for s in &bg {
        mad += ((s[0] - mean[0]).abs() + (s[1] - mean[1]).abs() + (s[2] - mean[2]).abs()) / 3.0;
    }
    mad /= bg.len() as f32;
    let thr2 = {
        let t = (mad * 2.0 + 24.0).clamp(28.0, 110.0) * k;
        t * t
    };
    // contrast threshold from the background's own contrast
    let bg_contrast = if bg_contrast_n > 0 {
        bg_contrast_sum / bg_contrast_n as f32
    } else {
        0.0
    };
    let contrast_thr = (bg_contrast * 2.2 + 12.0).clamp(14.0, 70.0) * k;

    // --- check each brushed pixel ---
    let mut raw = GrayImage::new(w, h);
    let mut obj_count: u64 = 0;
    for y in 0..h {
        for x in 0..w {
            if rough.get_pixel(x, y)[0] == 0 {
                continue;
            }
            let mut hit = contrast(x, y) > contrast_thr;
            if !hit {
                let c = at(x, y);
                let mut nearest = f32::MAX;
                for s in &bg {
                    let d = color_dist2(c, *s);
                    if d < nearest {
                        nearest = d;
                        if nearest <= thr2 {
                            break;
                        }
                    }
                }
                hit = nearest > thr2;
            }
            if hit {
                raw.put_pixel(x, y, image::Luma([255]));
                obj_count += 1;
            }
        }
    }

    // unclear -> keep the user's brush
    let frac = obj_count as f64 / rough_count as f64;
    if frac < 0.008 || frac > 0.985 {
        return rough.clone();
    }

    // close (dilate -> erode) without an extra erode that would delete thin text,
    // stay inside the brush (+3px)
    let closed = erode(&dilate(&raw, 2), 2);
    let bound = dilate(rough, 3);
    let mut out = GrayImage::new(w, h);
    for y in 0..h {
        for x in 0..w {
            if closed.get_pixel(x, y)[0] > 0 && bound.get_pixel(x, y)[0] > 0 {
                out.put_pixel(x, y, image::Luma([255]));
            }
        }
    }
    out
}

/// Mask as a rose PNG data URL so the frontend can paint it onto its canvas.
pub fn encode_mask_rose(mask: &GrayImage) -> Result<String, String> {
    let mut rgba = RgbaImage::new(mask.width(), mask.height());
    for (x, y, p) in mask.enumerate_pixels() {
        rgba.put_pixel(
            x,
            y,
            if p[0] > 0 {
                image::Rgba([244, 63, 94, 255])
            } else {
                image::Rgba([0, 0, 0, 0])
            },
        );
    }
    encode_png_data_url(&rgba)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn feather_turns_a_hard_edge_into_a_ramp() {
        // left half on, right half off: the sides stay, the seam becomes a ramp
        let (w, h) = (40u32, 8u32);
        let mut m = GrayImage::new(w, h);
        for y in 0..h {
            for x in 0..w {
                m.put_pixel(x, y, image::Luma([if x < 20 { 255 } else { 0 }]));
            }
        }
        let f = feather_mask(&m, 4);
        assert_eq!(f.get_pixel(0, 4)[0], 255, "deep inside stays fully opaque");
        assert_eq!(f.get_pixel(39, 4)[0], 0, "far outside stays fully clear");
        let ramp: Vec<u8> = (14..26).map(|x| f.get_pixel(x, 4)[0]).collect();
        assert!(ramp.windows(2).all(|p| p[0] >= p[1]), "not monotonic: {ramp:?}");
        assert!(ramp.iter().any(|v| *v > 0 && *v < 255), "no partial values: {ramp:?}");
    }

    #[test]
    fn feather_keeps_a_full_frame_subject_solid() {
        // an all-on mask must stay unchanged (no fading at the border)
        let mut m = GrayImage::new(16, 16);
        for p in m.pixels_mut() {
            *p = image::Luma([255]);
        }
        let f = feather_mask(&m, 5);
        assert!(f.pixels().all(|p| p[0] == 255), "edges dimmed");
    }

    #[test]
    fn feather_with_no_radius_is_a_passthrough() {
        let mut m = GrayImage::new(8, 8);
        m.put_pixel(3, 3, image::Luma([200]));
        assert_eq!(feather_mask(&m, 0), m);
    }

    #[test]
    fn detect_snaps_rough_brush_to_object() {
        // grey background with a red square, the brush is bigger. Should keep red, drop
        // grey.
        let w = 60u32;
        let h = 60u32;
        let mut img = RgbaImage::new(w, h);
        for y in 0..h {
            for x in 0..w {
                img.put_pixel(x, y, image::Rgba([128, 128, 128, 255]));
            }
        }
        for y in 22..38 {
            for x in 22..38 {
                img.put_pixel(x, y, image::Rgba([220, 20, 20, 255]));
            }
        }
        let mut rough = GrayImage::new(w, h);
        for y in 12..48 {
            for x in 12..48 {
                rough.put_pixel(x, y, image::Luma([255]));
            }
        }

        let out = detect_object(&img, &rough, 0.5);
        // the red center is selected, the grey margin isn't
        assert_eq!(out.get_pixel(30, 30)[0], 255, "object centre should be selected");
        assert_eq!(out.get_pixel(15, 15)[0], 0, "background margin should be dropped");
    }

    #[test]
    fn detect_catches_thin_text_stroke() {
        // grey background with a 1px dark line (like text). Must not be erased,
        // the background around it stays unselected.
        let w = 60u32;
        let h = 60u32;
        let mut img = RgbaImage::new(w, h);
        for y in 0..h {
            for x in 0..w {
                img.put_pixel(x, y, image::Rgba([150, 150, 150, 255]));
            }
        }
        for y in 20..40 {
            img.put_pixel(30, y, image::Rgba([55, 55, 55, 255])); // 1px stroke
        }
        let mut rough = GrayImage::new(w, h);
        for y in 14..46 {
            for x in 22..38 {
                rough.put_pixel(x, y, image::Luma([255]));
            }
        }

        let out = detect_object(&img, &rough, 0.5);
        assert_eq!(out.get_pixel(30, 30)[0], 255, "thin stroke should survive detection");
        assert_eq!(out.get_pixel(26, 30)[0], 0, "flat background should stay unselected");
    }

    #[test]
    fn fills_block_over_gradient() {
        // gradient with a magenta block in the middle
        let w = 40u32;
        let h = 20u32;
        let mut img = RgbaImage::new(w, h);
        for y in 0..h {
            for x in 0..w {
                let v = (x * 255 / (w - 1)) as u8;
                img.put_pixel(x, y, image::Rgba([v, v, v, 255]));
            }
        }
        let mut mask = GrayImage::new(w, h);
        for y in 6..14 {
            for x in 14..26 {
                img.put_pixel(x, y, image::Rgba([255, 0, 255, 255])); // garbage to erase
                mask.put_pixel(x, y, image::Luma([255]));
            }
        }

        inpaint_telea(&mut img, &mask, 6);

        // the filled center should look like the gradient (grey), not magenta
        let p = img.get_pixel(20, 10);
        assert!(p[1] > 20, "green channel should be filled, got {:?}", p);
        let rg = (p[0] as i32 - p[1] as i32).abs();
        let gb = (p[1] as i32 - p[2] as i32).abs();
        assert!(
            rg < 40 && gb < 40,
            "filled pixel should be near-grey (interpolated), got {:?}",
            p
        );
    }

    #[test]
    fn patchmatch_rebuilds_striped_texture() {
        // stripes with a block on top, the fill must bring back the stripes
        let w = 120u32;
        let h = 120u32;
        let stripe = |x: u32| -> u8 { if (x / 6) % 2 == 0 { 210 } else { 60 } };
        let mut img = RgbaImage::new(w, h);
        for y in 0..h {
            for x in 0..w {
                let v = stripe(x);
                img.put_pixel(x, y, image::Rgba([v, v, v, 255]));
            }
        }
        let mut mask = GrayImage::new(w, h);
        for y in 45..75 {
            for x in 45..75 {
                img.put_pixel(x, y, image::Rgba([255, 0, 0, 255])); // the "object"
                mask.put_pixel(x, y, image::Luma([255]));
            }
        }

        // big solid blob -> PatchMatch
        remove_region(&mut img, &mask);

        // compare the fill with the real pattern (PatchMatch should be near exact)
        let mut err_sum = 0f64;
        let mut n = 0f64;
        for y in 45..75u32 {
            for x in 45..75u32 {
                let p = img.get_pixel(x, y);
                err_sum += (p[0] as f64 - stripe(x) as f64).abs();
                n += 1.0;
            }
        }
        let mae = err_sum / n;
        assert!(mae < 25.0, "stripes should be reconstructed, MAE = {mae:.1}");
    }

    #[test]
    fn thin_strokes_still_use_fast_path() {
        // a 3px line -> Telea, just check it fills okay
        let w = 80u32;
        let h = 80u32;
        let mut img = RgbaImage::new(w, h);
        for y in 0..h {
            for x in 0..w {
                img.put_pixel(x, y, image::Rgba([140, 140, 140, 255]));
            }
        }
        let mut mask = GrayImage::new(w, h);
        for y in 10..70 {
            for x in 38..41 {
                img.put_pixel(x, y, image::Rgba([0, 0, 0, 255]));
                mask.put_pixel(x, y, image::Luma([255]));
            }
        }
        remove_region(&mut img, &mask);
        let p = img.get_pixel(39, 40);
        assert!(p[0] > 110, "thin stroke should be filled with background, got {:?}", p);
    }

    #[test]
    fn mask_from_alpha_strokes() {
        // 2x1 mask: one opaque, one transparent pixel -> only the opaque one is removed
        let mut m = RgbaImage::new(2, 1);
        m.put_pixel(0, 0, image::Rgba([255, 255, 255, 255]));
        m.put_pixel(1, 0, image::Rgba([0, 0, 0, 0]));
        let mut buf = Vec::new();
        DynamicImage::ImageRgba8(m)
            .write_to(&mut Cursor::new(&mut buf), ImageFormat::Png)
            .unwrap();
        let url = format!("data:image/png;base64,{}", STANDARD.encode(&buf));
        let gray = decode_mask(&url, 2, 1).unwrap();
        assert_eq!(gray.get_pixel(0, 0)[0], 255);
        assert_eq!(gray.get_pixel(1, 0)[0], 0);
    }
}

/* ---- Expand tool: blur fill ------------------------------------------------ */

/// Put img on a width x height canvas at (ox, oy) with a blurred, darker copy of itself
/// behind it, scaled to cover the canvas: the classic wallpaper look, no AI.
pub fn expand_blur(img: &RgbaImage, width: u32, height: u32, ox: u32, oy: u32) -> RgbaImage {
    use image::imageops::FilterType;
    let (iw, ih) = img.dimensions();
    // blur at 1/8 size: fast, and the upscale smooths it further
    let sw = (width / 8).max(16);
    let sh = (height / 8).max(16);
    let k = (sw as f32 / iw as f32).max(sh as f32 / ih as f32);
    let cw = ((iw as f32 * k).ceil() as u32).max(sw);
    let ch = ((ih as f32 * k).ceil() as u32).max(sh);
    let cover = image::imageops::resize(img, cw, ch, FilterType::Triangle);
    // keep the cover centred where the picture sits
    let fx = (ox as f32 + iw as f32 / 2.0) / width as f32;
    let fy = (oy as f32 + ih as f32 / 2.0) / height as f32;
    let cx = ((cw - sw) as f32 * fx).round() as u32;
    let cy = ((ch - sh) as f32 * fy).round() as u32;
    let small = image::imageops::crop_imm(&cover, cx.min(cw - sw), cy.min(ch - sh), sw, sh).to_image();
    let sigma = (sw.min(sh) as f32 * 0.04).max(2.0);
    let mut back = image::imageops::blur(&small, sigma);
    for p in back.pixels_mut() {
        // a bit darker so the picture stands out, fully opaque
        p[0] = (p[0] as f32 * 0.72) as u8;
        p[1] = (p[1] as f32 * 0.72) as u8;
        p[2] = (p[2] as f32 * 0.72) as u8;
        p[3] = 255;
    }
    let mut canvas = image::imageops::resize(&back, width, height, FilterType::Triangle);
    image::imageops::overlay(&mut canvas, img, i64::from(ox), i64::from(oy));
    canvas
}
