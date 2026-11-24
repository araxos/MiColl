//! "Same mark anywhere": a watermark framed once on one picture (a logo, a signature)
//! is looked for on every other picture, anywhere and at any size from half to double,
//! also turned a little. The mark can be dark on one picture and light on the next: it's
//! compared by its strokes (how much each pixel stands out from what's around it, either
//! way), a bold mark by its outline, not by its colour.
//!
//! The search runs coarse first (a small copy, every place and size), then the best few
//! places are looked at again on a bigger copy and at full size.

use image::imageops::{self, FilterType};
use image::{GrayImage, Luma, RgbaImage};

use crate::watermark::{components, min_max, stroke_threshold, tophat, Hit, Rect};

/// The mark as framed on its picture.
#[derive(Clone)]
pub struct Motif {
    /// Its pixels, the size of its box (on its own picture, full size).
    pub mask: GrayImage,
    /// The width of its strokes, px.
    pub stroke: f32,
    /// How wide its bold parts are, px (BOLD or more: found by its outline).
    pub wide: f32,
    /// The size of the picture it was taken from.
    pub ref_w: u32,
    pub ref_h: u32,
}

/// From this width on a mark is looked for by its outline.
const BOLD: f32 = 10.0;

/// Where the mark is on a picture.
pub struct MotifHit {
    /// How well it fits (normalised correlation, 1 = the same).
    pub score: f32,
    /// Where it sits.
    pub spot: Spot,
    /// What to remove.
    pub hit: Hit,
}

/// Below this it isn't the mark (measured on real pictures: the mark scores well above,
/// the same pictures without it stay far below).
pub const MOTIF_MIN: f32 = 0.6;

/// From here up to MOTIF_MIN it may be the mark: shown as unsure, left out unless ticked.
pub const MOTIF_UNSURE: f32 = 0.5;

/// The width of a mask's strokes: a stroke of width s and length L has the area s*L and
/// the edge 2*L.
pub fn stroke_width(mask: &GrayImage) -> f32 {
    let (w, h) = mask.dimensions();
    let (mut area, mut edge) = (0u32, 0u32);
    for (x, y, p) in mask.enumerate_pixels() {
        if p[0] == 0 {
            continue;
        }
        area += 1;
        let out = |dx: i32, dy: i32| {
            let (nx, ny) = (x as i32 + dx, y as i32 + dy);
            nx < 0 || ny < 0 || nx >= w as i32 || ny >= h as i32 || mask.get_pixel(nx as u32, ny as u32)[0] == 0
        };
        if out(-1, 0) || out(1, 0) || out(0, -1) || out(0, 1) {
            edge += 1;
        }
    }
    (2.0 * area as f32 / edge.max(1) as f32).max(1.0)
}

/// How wide its bold parts are: the size of brush that still paints a third of it.
fn bold_width(mask: &GrayImage) -> f32 {
    let (w, h) = (mask.width() as usize, mask.height() as usize);
    let src: Vec<i32> = mask.pixels().map(|p| (p[0] > 0) as i32).collect();
    let all: i32 = src.iter().sum();
    let mut best = 1;
    for r in 1..60usize {
        let open = min_max(&min_max(&src, w, h, r, true), w, h, r, false);
        if open.iter().sum::<i32>() * 3 < all {
            break;
        }
        best = 2 * r + 1;
    }
    best as f32
}

/// How much wider than its strokes the mark is taken off (its soft edge).
fn grow_of(stroke: f32) -> i32 {
    ((stroke * 0.5).round() as i32).clamp(2, 6)
}

/// A mask laid onto a picture of w x h with its top left at (px, py), grown.
fn laid(mask: &GrayImage, px: i64, py: i64, grow: i32, w: u32, h: u32) -> Option<Hit> {
    let g = grow.max(0) as u32;
    let mut big = GrayImage::new(mask.width() + 2 * g, mask.height() + 2 * g);
    imageops::replace(&mut big, mask, g as i64, g as i64);
    let big = crate::edit::dilate_mask(&big, grow);
    let (ox, oy) = (px - g as i64, py - g as i64);
    // the part inside the picture
    let (mut x0, mut y0, mut x1, mut y1) = (i64::MAX, i64::MAX, i64::MIN, i64::MIN);
    for (x, y, p) in big.enumerate_pixels() {
        let (gx, gy) = (ox + x as i64, oy + y as i64);
        if p[0] > 0 && gx >= 0 && gy >= 0 && gx < w as i64 && gy < h as i64 {
            x0 = x0.min(gx);
            y0 = y0.min(gy);
            x1 = x1.max(gx);
            y1 = y1.max(gy);
        }
    }
    if x1 < x0 || y1 < y0 {
        return None;
    }
    let (bw, bh) = ((x1 - x0 + 1) as u32, (y1 - y0 + 1) as u32);
    let cut = imageops::crop_imm(&big, (x0 - ox) as u32, (y0 - oy) as u32, bw, bh).to_image();
    Some(Hit {
        region: Rect { x: x0 as u32, y: y0 as u32, w: bw, h: bh },
        mask: cut,
        bbox: (x0 as u32, y0 as u32, x1 as u32, y1 as u32),
        contrast: 1.0,
    })
}

/// What to remove on the picture the mark was framed on: the mask as it is, at the frame.
pub fn own_hit(mask: &GrayImage, fx: u32, fy: u32, stroke: f32, w: u32, h: u32) -> Option<Hit> {
    laid(mask, fx as i64, fy as i64, grow_of(stroke), w, h)
}

/// A smaller copy (the plain average of each block when it's much smaller, fast).
fn shrink(img: &RgbaImage, w: u32, h: u32) -> RgbaImage {
    if (w, h) == img.dimensions() {
        img.clone()
    } else if w * 2 <= img.width() && h * 2 <= img.height() {
        imageops::thumbnail(img, w, h)
    } else {
        imageops::resize(img, w, h, FilterType::Triangle)
    }
}

/// Strokes either way (light or dark) on red, green and blue, rad = the top-hat's radius
/// (more than half the stroke width).
fn strokes_any(img: &RgbaImage, rad: usize) -> Vec<f32> {
    let (w, h) = (img.width() as usize, img.height() as usize);
    let mut out = vec![0f32; w * h];
    if w == 0 || h == 0 {
        return out;
    }
    for c in 0..3 {
        let ch: Vec<i32> = img.pixels().map(|p| p[c] as i32).collect();
        for light in [true, false] {
            for (o, v) in out.iter_mut().zip(tophat(&ch, w, h, rad, light)) {
                *o = o.max(v as f32);
            }
        }
    }
    out
}

/// Outlines: the steepest step to the neighbours over the channels, cut off at 100 (a
/// hard edge counts the same whether it's white on grey or on black).
fn outlines(w: usize, h: usize, at: impl Fn(usize, usize, usize) -> i32, channels: usize) -> Vec<f32> {
    let mut out = vec![0f32; w * h];
    if w < 3 || h < 3 {
        return out;
    }
    for y in 1..h - 1 {
        for x in 1..w - 1 {
            let mut m = 0;
            for c in 0..channels {
                m = m.max((at(x + 1, y, c) - at(x - 1, y, c)).abs() + (at(x, y + 1, c) - at(x, y - 1, c)).abs());
            }
            out[y * w + x] = m.min(100) as f32;
        }
    }
    out
}

/// A 3x3 box blur: thin strokes on a small copy line up a px apart.
fn soften(v: &[f32], w: usize, h: usize) -> Vec<f32> {
    let mut out = vec![0f32; v.len()];
    for y in 0..h {
        for x in 0..w {
            let (mut s, mut n) = (0f32, 0f32);
            for yy in y.saturating_sub(1)..=(y + 1).min(h - 1) {
                for xx in x.saturating_sub(1)..=(x + 1).min(w - 1) {
                    s += v[yy * w + xx];
                    n += 1.0;
                }
            }
            out[y * w + x] = s / n;
        }
    }
    out
}

/// A mark from its pixels (the box's size, maybe touched up by hand), cut to them.
/// stroke = its strokes' width (from mark_in_box), ref = its picture's size.
pub fn motif_from_mask(mask: &GrayImage, stroke: f32, ref_w: u32, ref_h: u32) -> Option<Motif> {
    let (x0, y0, x1, y1) = crate::edit::mask_bbox(mask)?;
    if (x1 - x0 + 1) < 6 || (y1 - y0 + 1) < 6 {
        return None;
    }
    let mask = imageops::crop_imm(mask, x0, y0, x1 - x0 + 1, y1 - y0 + 1).to_image();
    let wide = bold_width(&mask);
    Some(Motif { mask, stroke: stroke.max(1.0), wide, ref_w, ref_h })
}

/// The mark inside a box the user drew on its picture: its strokes, thin ones
/// (fine_mark) and bold ones (bold_mark). The mask is the box's size (so it can be
/// touched up within the box), and the strokes' width.
pub fn mark_in_box(img: &RgbaImage, bx: u32, by: u32, bw: u32, bh: u32) -> Option<(GrayImage, f32)> {
    let (w, h) = img.dimensions();
    let (bx, by) = (bx.min(w.saturating_sub(1)), by.min(h.saturating_sub(1)));
    let (bw, bh) = (bw.min(w - bx), bh.min(h - by));
    if bw < 8 || bh < 8 {
        return None;
    }
    let crop = imageops::crop_imm(img, bx, by, bw, bh).to_image();
    // (the thin ones with and without their soft edge)
    let (mut mask, mut core) = fine_mark(&crop);
    let bold = bold_mark(&crop);
    for ((m, c), b) in mask.pixels_mut().zip(core.pixels_mut()).zip(bold.pixels()) {
        m[0] = m[0].max(b[0]);
        c[0] = c[0].max(b[0]);
    }
    if mask.pixels().filter(|p| p[0] > 0).count() < 20 {
        return None;
    }
    let stroke = stroke_width(&core);
    Some((mask, stroke))
}

/// Thin strokes (up to ~11 px): the small top-hats, dark or light (whichever stands out),
/// specks dropped. With one px of soft edge taken in, and without.
fn fine_mark(crop: &RgbaImage) -> (GrayImage, GrayImage) {
    let (bw, bh) = crop.dimensions();
    let (cw, ch) = (bw as usize, bh as usize);
    let mut best: Option<(Vec<i32>, f32, f64)> = None;
    for light in [true, false] {
        let mut map = vec![0i32; cw * ch];
        for c in 0..3 {
            let chn: Vec<i32> = crop.pixels().map(|p| p[c] as i32).collect();
            for rad in [2usize, 3, 5] {
                for (m, v) in map.iter_mut().zip(tophat(&chn, cw, ch, rad, light)) {
                    *m = (*m).max(v);
                }
            }
        }
        let thr = stroke_threshold(&map, 1.0);
        let mass: f64 = map.iter().filter(|v| **v as f32 > thr).map(|v| *v as f64).sum();
        if best.as_ref().map_or(true, |b| mass > b.2) {
            best = Some((map, thr, mass));
        }
    }
    let mut mask = GrayImage::new(bw, bh);
    let mut core = GrayImage::new(bw, bh);
    let Some((map, thr, _)) = best else { return (mask, core) };
    for (i, v) in map.iter().enumerate() {
        if *v as f32 > thr {
            core.put_pixel((i % cw) as u32, (i / cw) as u32, Luma([255]));
        }
    }
    let (labels, comps) = components(&core);
    for (i, l) in labels.iter().enumerate() {
        let (x, y) = (i % cw, i / cw);
        if *l == 0 || comps[(*l - 1) as usize].area < 12 {
            core.put_pixel(x as u32, y as u32, Luma([0]));
            continue;
        }
        mask.put_pixel(x as u32, y as u32, Luma([255]));
        for (dx, dy) in [(-1i32, 0i32), (1, 0), (0, -1), (0, 1)] {
            let (nx, ny) = (x as i32 + dx, y as i32 + dy);
            if nx >= 0 && ny >= 0 && nx < cw as i32 && ny < ch as i32 && map[ny as usize * cw + nx as usize] as f32 > thr * 0.4 {
                mask.put_pixel(nx as u32, ny as u32, Luma([255]));
            }
        }
    }
    (mask, core)
}

/// Otsu's threshold: splits the values (0..255) into two groups as far apart as possible.
fn otsu(v: &[i32]) -> i32 {
    let mut hist = [0f64; 256];
    for x in v {
        hist[(*x).clamp(0, 255) as usize] += 1.0;
    }
    let n = v.len().max(1) as f64;
    let total: f64 = hist.iter().enumerate().map(|(i, c)| i as f64 * c).sum::<f64>() / n;
    let (mut w, mut mu, mut best, mut at) = (0f64, 0f64, -1f64, 0);
    for (i, c) in hist.iter().enumerate() {
        w += c / n;
        mu += i as f64 * c / n;
        if w > 0.0 && w < 1.0 {
            let s = (total * w - mu).powi(2) / (w * (1.0 - w)).max(1e-9);
            if s > best {
                best = s;
                at = i as i32;
            }
        }
    }
    at
}

fn percentile(mut v: Vec<f32>, p: f32) -> f32 {
    if v.is_empty() {
        return 0.0;
    }
    v.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    v[((v.len() - 1) as f32 * p).round() as usize]
}

/// How far each pixel's colour is from the average of the unmasked pixels around it
/// (a box of 2*r+1): the background it sits on.
fn off_background(px: &[[f32; 3]], mask: &[bool], w: usize, h: usize, r: usize) -> Vec<f32> {
    // running sums over the free pixels: count, r, g, b
    let sw = w + 1;
    let mut sum = vec![[0f64; 4]; sw * (h + 1)];
    for y in 0..h {
        let mut row = [0f64; 4];
        for x in 0..w {
            let i = y * w + x;
            if !mask[i] {
                row[0] += 1.0;
                for c in 0..3 {
                    row[c + 1] += px[i][c] as f64;
                }
            }
            for k in 0..4 {
                sum[(y + 1) * sw + x + 1][k] = sum[y * sw + x + 1][k] + row[k];
            }
        }
    }
    let mut out = vec![0f32; w * h];
    for y in 0..h {
        let (y0, y1) = (y.saturating_sub(r), (y + r + 1).min(h));
        for x in 0..w {
            let (x0, x1) = (x.saturating_sub(r), (x + r + 1).min(w));
            let mut b = [0f64; 4];
            for (k, v) in b.iter_mut().enumerate() {
                *v = sum[y1 * sw + x1][k] - sum[y0 * sw + x1][k] - sum[y1 * sw + x0][k] + sum[y0 * sw + x0][k];
            }
            let n = b[0].max(1.0);
            let i = y * w + x;
            let d: f64 = (0..3).map(|c| (px[i][c] as f64 - b[c + 1] / n).powi(2)).sum();
            out[i] = d.sqrt() as f32;
        }
    }
    out
}

/// Grown (or shrunk) by r px, square.
fn morph(m: &[bool], w: usize, h: usize, r: usize, shrink: bool) -> Vec<bool> {
    let src: Vec<i32> = m.iter().map(|v| *v as i32).collect();
    min_max(&src, w, h, r, shrink).into_iter().map(|v| v > 0).collect()
}

/// Bold strokes and filled letters, several colours too (white letters with a red name
/// over them):
/// 1. everything that stands out from a wide surrounding, dark or light - the kind (or
///    both) whose colours aren't those of the frame's rim (the gaps between letters stand
///    out too, but look like the rim);
/// 2. out goes what looks like the background right around it;
/// 3. the mark's few flat colours decide: what has none of them goes, and pieces of the
///    other kind that have one come in (red letters on a bright wall);
/// 4. out go blobs with a soft edge (bokeh) and pieces with a blurry outline.
/// The mask is the crop's size.
fn bold_mark(crop: &RgbaImage) -> GrayImage {
    let (fw, fh) = crop.dimensions();
    let f = (900.0 / fw.max(fh) as f32).min(1.0);
    let (sw, sh) = (((fw as f32 * f).round() as u32).max(1), ((fh as f32 * f).round() as u32).max(1));
    let small = if f < 1.0 { imageops::resize(crop, sw, sh, FilterType::Triangle) } else { crop.clone() };
    let (w, h) = (sw as usize, sh as usize);
    let none = GrayImage::new(fw, fh);
    if w < 12 || h < 12 {
        return none;
    }
    let r = (w.min(h) / 10).max(6);
    let px: Vec<[f32; 3]> = small.pixels().map(|p| [p[0] as f32, p[1] as f32, p[2] as f32]).collect();
    let dist = |a: &[f32; 3], b: &[f32; 3]| ((a[0] - b[0]).powi(2) + (a[1] - b[1]).powi(2) + (a[2] - b[2]).powi(2)).sqrt();
    let around = |x: usize, y: usize, d: usize| {
        (y.saturating_sub(d)..=(y + d).min(h - 1)).flat_map(move |yy| (x.saturating_sub(d)..=(x + d).min(w - 1)).map(move |xx| yy * w + xx))
    };
    // how steep the colour steps are (Sobel, the steepest channel)
    let mut grad = vec![0f32; w * h];
    for y in 0..h {
        let (yu, yd) = (y.saturating_sub(1), (y + 1).min(h - 1));
        for x in 0..w {
            let (xl, xr) = (x.saturating_sub(1), (x + 1).min(w - 1));
            for c in 0..3 {
                let v = |xx: usize, yy: usize| px[yy * w + xx][c];
                let gx = (v(xr, yu) + 2.0 * v(xr, y) + v(xr, yd) - v(xl, yu) - 2.0 * v(xl, y) - v(xl, yd)) * 0.25;
                let gy = (v(xl, yd) + 2.0 * v(x, yd) + v(xr, yd) - v(xl, yu) - 2.0 * v(x, yu) - v(xr, yu)) * 0.25;
                grad[y * w + x] = grad[y * w + x].max((gx * gx + gy * gy).sqrt());
            }
        }
    }
    // 1. both kinds, the one least like the rim is the mark's
    let b = ((w.min(h) as f32 * 0.04) as usize).max(3);
    let mut rim: std::collections::HashSet<[u8; 3]> = std::collections::HashSet::new();
    for y in 0..h {
        for x in 0..w {
            if x < b || y < b || x + b >= w || y + b >= h {
                let p = small.get_pixel(x as u32, y as u32);
                rim.insert([p[0] / 24, p[1] / 24, p[2] / 24]);
            }
        }
    }
    let rim: Vec<[f32; 3]> = rim.into_iter().map(|q| q.map(|v| v as f32 * 24.0 + 12.0)).collect();
    let mut kinds: Vec<(f32, Vec<bool>)> = Vec::new();
    for light in [true, false] {
        let mut map = vec![0i32; w * h];
        for c in 0..3 {
            let ch: Vec<i32> = px.iter().map(|p| p[c] as i32).collect();
            for (m, v) in map.iter_mut().zip(tophat(&ch, w, h, r, light)) {
                *m = (*m).max(v);
            }
        }
        let thr = otsu(&map).max(18);
        let mask: Vec<bool> = map.iter().map(|v| *v >= thr).collect();
        let on: Vec<usize> = (0..w * h).filter(|i| mask[*i]).collect();
        let (mut sum, mut n) = (0f32, 0f32);
        for i in on.iter().step_by((on.len() / 3000).max(1)) {
            sum += rim.iter().map(|q| dist(&px[*i], q)).fold(f32::MAX, f32::min);
            n += 1.0;
        }
        kinds.push((if n > 0.0 { sum / n } else { 0.0 }, mask));
    }
    if kinds[1].0 > kinds[0].0 {
        kinds.swap(0, 1);
    }
    let (d2, other) = kinds.pop().unwrap_or_default();
    let (d1, mut mask) = kinds.pop().unwrap_or_default();
    // both unlike the rim (white letters and a dark red name on a grey wall): both are it
    if d2 >= 0.6 * d1 {
        for (m, o) in mask.iter_mut().zip(&other) {
            *m |= *o;
        }
    }
    // 2. what looks like the background around it
    let mut thr = 22f32;
    for _ in 0..3 {
        let d = off_background(&px, &mask, w, h, 2 * r);
        thr = (0.35 * percentile((0..w * h).filter(|i| mask[*i]).map(|i| d[i]).collect(), 0.8)).max(22.0);
        let next: Vec<bool> = (0..w * h).map(|i| mask[i] && d[i] >= thr).collect();
        let changed = next.iter().zip(&mask).filter(|(a, b)| a != b).count();
        mask = next;
        if changed < 20 {
            break;
        }
    }
    // 3. its flat colours
    let core = morph(&mask, w, h, 1, true);
    let from = if core.iter().filter(|v| **v).count() > 50 { &core } else { &mask };
    let mut bins: std::collections::HashMap<[u8; 3], ([f64; 3], usize)> = std::collections::HashMap::new();
    let mut total = 0usize;
    for i in (0..w * h).filter(|i| from[*i]) {
        let p = px[i];
        let e = bins.entry(p.map(|v| v as u8 / 32)).or_insert(([0.0; 3], 0));
        for c in 0..3 {
            e.0[c] += p[c] as f64;
        }
        e.1 += 1;
        total += 1;
    }
    let cols: Vec<[f32; 3]> = bins
        .values()
        .filter(|(_, n)| *n as f32 >= 0.06 * total as f32)
        .map(|(s, n)| s.map(|v| (v / *n as f64) as f32))
        .collect();
    if !cols.is_empty() {
        let near: Vec<f32> = px.iter().map(|p| cols.iter().map(|c| dist(p, c)).fold(f32::MAX, f32::min)).collect();
        let d = off_background(&px, &mask, w, h, 2 * r);
        for i in 0..w * h {
            if other[i] && near[i] < 40.0 && d[i] >= thr {
                mask[i] = true;
            }
        }
        let has: Vec<bool> = (0..w * h).map(|i| mask[i] && near[i] < 60.0).collect();
        let (n, all) = (has.iter().filter(|v| **v).count(), mask.iter().filter(|v| **v).count());
        if n as f32 >= 0.6 * all as f32 {
            let close = morph(&has, w, h, 2, false);
            for i in 0..w * h {
                mask[i] = mask[i] && close[i];
            }
        }
    }
    // 4. soft edges: what's nearest to a soft part of the rim goes
    for _ in 0..2 {
        let inner = morph(&mask, w, h, 1, true);
        let edge: Vec<usize> = (0..w * h).filter(|i| mask[*i] && !inner[*i]).collect();
        if edge.len() < 10 {
            break;
        }
        let steep: Vec<f32> = edge.iter().map(|i| around(i % w, i / w, 1).map(|j| grad[j]).fold(0f32, f32::max)).collect();
        let reference = percentile(steep.clone(), 0.7);
        // each pixel takes over whether its nearest rim pixel is soft (2) or not (1)
        let mut soft = vec![0u8; w * h];
        let mut queue: std::collections::VecDeque<usize> = std::collections::VecDeque::new();
        for (i, s) in edge.iter().zip(&steep) {
            soft[*i] = if *s < 0.3 * reference { 2 } else { 1 };
            queue.push_back(*i);
        }
        while let Some(i) = queue.pop_front() {
            for j in around(i % w, i / w, 1) {
                if soft[j] == 0 && mask[j] {
                    soft[j] = soft[i];
                    queue.push_back(j);
                }
            }
        }
        // the majority around each pixel
        mask = (0..w * h)
            .map(|i| {
                mask[i] && {
                    let (mut s, mut n) = (0, 0);
                    for j in around(i % w, i / w, 3).filter(|j| mask[*j]) {
                        n += 1;
                        s += (soft[j] == 2) as i32;
                    }
                    s * 2 < n
                }
            })
            .collect();
    }
    // and pieces with a blurry outline, specks
    let mut g = GrayImage::new(sw, sh);
    for (i, p) in g.pixels_mut().enumerate() {
        p[0] = if mask[i] { 255 } else { 0 };
    }
    let (labels, comps) = components(&g);
    if comps.is_empty() {
        return none;
    }
    let grown = morph(&mask, w, h, 1, false);
    let inner = morph(&mask, w, h, 1, true);
    let mut sums = vec![(0f32, 0f32); comps.len()];
    for i in (0..w * h).filter(|i| grown[*i] && !inner[*i]) {
        let l = around(i % w, i / w, 1).map(|j| labels[j]).max().unwrap_or(0);
        if l > 0 {
            let e = &mut sums[(l - 1) as usize];
            e.0 += grad[i];
            e.1 += 1.0;
        }
    }
    let steep: Vec<f32> = sums.iter().map(|(s, n)| s / n.max(1.0)).collect();
    let mut order: Vec<usize> = (0..comps.len()).collect();
    order.sort_by(|a, b| steep[*a].partial_cmp(&steep[*b]).unwrap_or(std::cmp::Ordering::Equal));
    let half = comps.iter().map(|c| c.area as u64).sum::<u64>() / 2;
    let (mut acc, mut reference) = (0u64, 0f32);
    for i in order {
        acc += comps[i].area as u64;
        if acc >= half {
            reference = steep[i];
            break;
        }
    }
    for (i, p) in g.pixels_mut().enumerate() {
        let l = labels[i];
        let keep = l > 0 && comps[(l - 1) as usize].area >= 8 && steep[(l - 1) as usize] >= 0.5 * reference;
        p[0] = if keep { 255 } else { 0 };
    }
    let mut full = if f < 1.0 { imageops::resize(&g, fw, fh, FilterType::Triangle) } else { g };
    for p in full.pixels_mut() {
        p[0] = if p[0] > 127 { 255 } else { 0 };
    }
    full
}

/// The template at one size on the search copy: sample points (x, y, centred value)
/// and their norm, and its size.
struct Sampled {
    pts: Vec<(u32, u32, f32)>,
    norm: f32,
    w: usize,
    h: usize,
}

fn sample(m: &Motif, s: f32, cap: usize, blur: bool) -> Option<Sampled> {
    let (tw, th) = ((m.mask.width() as f32 * s).round() as u32, (m.mask.height() as f32 * s).round() as u32);
    if tw < 6 || th < 6 {
        return None;
    }
    let small = imageops::resize(&m.mask, tw, th, FilterType::Triangle);
    let (w, h) = (tw as usize, th as usize);
    let vals: Vec<f32> = if m.wide >= BOLD {
        outlines(w, h, |x, y, _| small.get_pixel(x as u32, y as u32)[0] as i32, 1)
    } else {
        small.pixels().map(|p| p[0] as f32).collect()
    };
    let vals = if blur { soften(&vals, w, h) } else { vals };
    let step = (((tw * th) as f32 / cap as f32).sqrt().ceil() as u32).max(1);
    let mut pts = Vec::new();
    // a grid with an offset per row, so thin lines aren't missed in whole columns
    for (row, y) in (0..th).step_by(step as usize).enumerate() {
        let off = (row as u32 * (step / 2).max(1)) % step;
        for x in (off..tw).step_by(step as usize) {
            pts.push((x, y, vals[(y * tw + x) as usize]));
        }
    }
    let n = pts.len().max(1) as f32;
    let mean = pts.iter().map(|p| p.2).sum::<f32>() / n;
    for p in pts.iter_mut() {
        p.2 -= mean;
    }
    let norm = pts.iter().map(|p| p.2 * p.2).sum::<f32>().sqrt();
    (norm > 0.0).then_some(Sampled { pts, norm, w, h })
}

/// A part of the picture as the search sees it, at factor f.
struct View {
    map: Vec<f32>,
    w: usize,
    h: usize,
}

/// Normalised correlation of the template with the view at (ox, oy).
fn ncc(s: &Sampled, v: &View, ox: usize, oy: usize) -> f32 {
    let (mut sum, mut sq, mut cov) = (0f32, 0f32, 0f32);
    for (x, y, t) in &s.pts {
        let g = v.map[(oy + *y as usize) * v.w + ox + *x as usize];
        sum += g;
        sq += g * g;
        cov += t * g;
    }
    let n = s.pts.len() as f32;
    let var = sq - sum * sum / n;
    if var <= 1e-6 {
        return 0.0;
    }
    cov / (s.norm * var.sqrt())
}

/// A part of the picture (full-size px) as the search sees it at factor f: the outlines
/// for a bold mark, else the strokes.
///
/// The strokes are picked out where they are ~2 px wide (not on the small copy itself):
/// there the top-hat is just wider than them, so spots of light, grain and edges that
/// are wider (bokeh behind a white logo) stay quiet. Then it's scaled to f.
fn view(img: &RgbaImage, (cx, cy, cw, ch): (u32, u32, u32, u32), f: f32, m: &Motif, blur: bool) -> View {
    let cut;
    let part = if (cx, cy) == (0, 0) && (cw, ch) == img.dimensions() {
        img
    } else {
        cut = imageops::crop_imm(img, cx, cy, cw, ch).to_image();
        &cut
    };
    let (sw, sh) = (((cw as f32 * f).round() as u32).max(1), ((ch as f32 * f).round() as u32).max(1));
    let (w, h) = (sw as usize, sh as usize);
    let map = if m.wide >= BOLD {
        let small = shrink(part, sw, sh);
        outlines(w, h, |x, y, c| small.get_pixel(x as u32, y as u32)[c] as i32, 3)
    } else {
        let fs = (2.0 / m.stroke.max(0.5)).clamp(f, 1.0);
        let (pw, ph) = (((cw as f32 * fs).round() as u32).max(1), ((ch as f32 * fs).round() as u32).max(1));
        let pick = shrink(part, pw, ph);
        let rad = ((m.stroke * fs * 0.5).ceil() as usize + 1).max(1);
        let map = strokes_any(&pick, rad);
        if (sw, sh) == (pw, ph) {
            map
        } else {
            // averaged down: a thin stroke stays as a fainter line, not lost between px
            let g = GrayImage::from_fn(pw, ph, |x, y| Luma([map[(y * pw + x) as usize].min(255.0) as u8]));
            imageops::resize(&g, sw, sh, FilterType::Triangle).pixels().map(|p| p[0] as f32).collect()
        }
    };
    let map = if blur { soften(&map, w, h) } else { map };
    View { map, w, h }
}

/// A place the mark may be: how well it fits, its size, the top left of its box.
#[derive(Clone, Copy)]
struct Place {
    score: f32,
    scale: f32,
    x: f32,
    y: f32,
}

/// The best few places on the coarse copy, apart from each other.
fn coarse(v: &View, f: f32, m: &Motif, scales: &[f32], count: usize, stop: &dyn Fn() -> bool) -> Vec<Place> {
    let mut cands: Vec<Place> = Vec::new();
    for s in scales {
        if stop() {
            return Vec::new();
        }
        let Some(t) = sample(m, s * f, 500, true) else { continue };
        if t.w >= v.w || t.h >= v.h {
            continue;
        }
        for oy in (0..=v.h - t.h).step_by(2) {
            for ox in (0..=v.w - t.w).step_by(2) {
                let score = ncc(&t, v, ox, oy);
                if score > 0.15 {
                    cands.push(Place { score, scale: *s, x: ox as f32 / f, y: oy as f32 / f });
                }
            }
        }
    }
    cands.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
    let mut top: Vec<Place> = Vec::new();
    for c in cands {
        let near = top.iter().any(|t| {
            let r = m.mask.width().max(m.mask.height()) as f32 * t.scale * 0.5;
            (t.x - c.x).abs() < r && (t.y - c.y).abs() < r
        });
        if !near {
            top.push(c);
            if top.len() == count {
                break;
            }
        }
    }
    top
}

/// Look at one place again at factor f: `slack` full-size px around it, its size times
/// `sizes`.
fn refine(img: &RgbaImage, m: &Motif, f: f32, p: &Place, slack: f32, sizes: &[f32], blur: bool) -> Option<Place> {
    let (w, h) = img.dimensions();
    let big = p.scale * sizes.iter().fold(0f32, |a, b| a.max(*b));
    let (bw, bh) = (m.mask.width() as f32 * big, m.mask.height() as f32 * big);
    let cx = (p.x - slack).max(0.0) as u32;
    let cy = (p.y - slack).max(0.0) as u32;
    let cw = ((p.x + bw + slack).min(w as f32).max(0.0) as u32).saturating_sub(cx);
    let ch = ((p.y + bh + slack).min(h as f32).max(0.0) as u32).saturating_sub(cy);
    if cw < 8 || ch < 8 {
        return None;
    }
    let v = view(img, (cx, cy, cw, ch), f, m, blur);
    let mut best: Option<Place> = None;
    for k in sizes {
        let s = p.scale * k;
        let Some(t) = sample(m, s * f, 2500, blur) else { continue };
        if t.w > v.w || t.h > v.h {
            continue;
        }
        for oy in 0..=(v.h - t.h) {
            for ox in 0..=(v.w - t.w) {
                let score = ncc(&t, &v, ox, oy);
                if best.map_or(true, |b| score > b.score) {
                    best = Some(Place { score, scale: s, x: cx as f32 + ox as f32 / f, y: cy as f32 + oy as f32 / f });
                }
            }
        }
    }
    best
}

/// The mark turned by deg (the box grows with it).
fn turned(m: &Motif, deg: f32) -> Motif {
    if deg == 0.0 {
        return m.clone();
    }
    let (w, h) = (m.mask.width() as f32, m.mask.height() as f32);
    let (sin, cos) = deg.to_radians().sin_cos();
    let nw = (w * cos.abs() + h * sin.abs()).ceil().max(1.0);
    let nh = (w * sin.abs() + h * cos.abs()).ceil().max(1.0);
    let mask = GrayImage::from_fn(nw as u32, nh as u32, |x, y| {
        let (dx, dy) = (x as f32 + 0.5 - nw / 2.0, y as f32 + 0.5 - nh / 2.0);
        let sx = dx * cos + dy * sin + w / 2.0 - 0.5;
        let sy = -dx * sin + dy * cos + h / 2.0 - 0.5;
        let (x0, y0) = (sx.floor(), sy.floor());
        let (ax, ay) = (sx - x0, sy - y0);
        let at = |xx: f32, yy: f32| {
            if xx < 0.0 || yy < 0.0 || xx >= w || yy >= h {
                0.0
            } else {
                m.mask.get_pixel(xx as u32, yy as u32)[0] as f32
            }
        };
        let v = (at(x0, y0) * (1.0 - ax) + at(x0 + 1.0, y0) * ax) * (1.0 - ay)
            + (at(x0, y0 + 1.0) * (1.0 - ax) + at(x0 + 1.0, y0 + 1.0) * ax) * ay;
        Luma([v.round() as u8])
    });
    Motif { mask, ..m.clone() }
}

/// Look for the mark on a picture: anywhere, from half to double its size (against the
/// picture's size), and when it isn't there straight, turned up to ~14 degrees. The best
/// place, or None when nothing is close.
pub fn find_motif(img: &RgbaImage, m: &Motif, stop: &dyn Fn() -> bool) -> Option<MotifHit> {
    let (w, h) = img.dimensions();
    let side = m.mask.width().max(m.mask.height()) as f32;
    // the same mark on a bigger picture is likely bigger too
    let k0 = ((w as f32 * h as f32) / (m.ref_w as f32 * m.ref_h as f32)).sqrt();
    let scales: Vec<f32> =
        std::iter::successors(Some(0.5f32), |s| Some(s * 1.07)).take_while(|s| *s <= 2.001).map(|s| s * k0).collect();
    // 1. coarse: the mark ~22 px across at its smallest (an outline needs more)
    let f0 = (if m.wide >= BOLD { 36.0 } else { 22.0 } / (side * scales[0])).min(1.0);
    let far = view(img, (0, 0, w, h), f0, m, true);
    // 2. the best few again on a bigger copy
    let f1 = (f0 * 4.0).min(1.0);
    let mid: Vec<f32> = (-3..=3).map(|i| 1.0 + i as f32 * 0.02).collect();
    let look = |m: &Motif, scales: &[f32], count: usize| -> Option<Place> {
        let mut best: Option<Place> = None;
        for p in coarse(&far, f0, m, scales, count, stop) {
            if stop() {
                return None;
            }
            if let Some(r) = refine(img, m, f1, &p, 3.0 / f0, &mid, true) {
                if best.map_or(true, |b| r.score > b.score) {
                    best = Some(r);
                }
            }
        }
        best
    };
    let mut best = look(m, &scales, 16);
    let mut angle = 0f32;
    let mut mark = m.clone();
    if stop() {
        return None;
    }
    if best.map_or(true, |b| b.score < MOTIF_MIN) {
        // turned? the usual sizes only
        let usual: Vec<f32> = scales.iter().copied().filter(|s| (0.75..=1.34).contains(&(s / k0))).collect();
        for deg in [-4f32, 4.0, -8.0, 8.0, -12.0, 12.0] {
            let t = turned(m, deg);
            if let Some(p) = look(&t, &usual, 6) {
                if best.map_or(true, |b| p.score > b.score) {
                    best = Some(p);
                    angle = deg;
                    mark = t;
                }
            }
            if stop() {
                return None;
            }
        }
        // the exact angle, about the same centre
        if angle != 0.0 {
            for step in [2f32, 1.0, 0.5, 0.25] {
                let base = angle;
                for deg in [base - step, base + step] {
                    let Some(b) = best else { break };
                    let t = turned(m, deg);
                    let p = Place {
                        x: b.x + (mark.mask.width() as f32 - t.mask.width() as f32) * 0.5 * b.scale,
                        y: b.y + (mark.mask.height() as f32 - t.mask.height() as f32) * 0.5 * b.scale,
                        ..b
                    };
                    if let Some(r) = refine(img, &t, f1, &p, 4.0 / f1, &[0.99, 1.0, 1.01], true) {
                        if r.score > b.score {
                            best = Some(r);
                            angle = deg;
                            mark = t;
                        }
                    }
                }
            }
        }
    }
    let best = best?;
    // 3. full size: a few px around, a touch of size
    let fine = refine(img, &mark, 1.0, &best, (2.0 / f1).max(3.0), &[0.99, 1.0, 1.01], false).unwrap_or(best);
    let (tw, th) = (
        ((mark.mask.width() as f32 * fine.scale).round() as u32).max(1),
        ((mark.mask.height() as f32 * fine.scale).round() as u32).max(1),
    );
    let mut placed = imageops::resize(&mark.mask, tw, th, FilterType::Triangle);
    for p in placed.pixels_mut() {
        p[0] = if p[0] > 60 { 255 } else { 0 };
    }
    let hit = laid(&placed, fine.x.round() as i64, fine.y.round() as i64, grow_of(m.stroke * fine.scale), w, h)?;
    let spot = Spot { cx: fine.x + tw as f32 / 2.0, cy: fine.y + th as f32 / 2.0, scale: fine.scale, angle };
    Some(MotifHit { score: best.score, spot, hit })
}

/// Fill the mark's pixels with LaMa, in tiles (a big logo in one go would be filled at a
/// third of its size). Small gaps between its strokes are closed first; the space inside
/// a loop of it stays as it is.
pub fn remove_motif(
    app_data: &std::path::Path,
    img: &mut RgbaImage,
    mask: &GrayImage,
    stroke: f32,
    stop: &dyn Fn() -> bool,
) -> Result<(), String> {
    let Some((x0, y0, x1, y1)) = crate::edit::mask_bbox(mask) else { return Ok(()) };
    // only the part around it (a 40 MP picture would be gone through for every tile)
    const ROOM: u32 = 640;
    let (ox, oy) = (x0.saturating_sub(ROOM), y0.saturating_sub(ROOM));
    let (ow, oh) = ((x1 + ROOM + 1).min(mask.width()) - ox, (y1 + ROOM + 1).min(mask.height()) - oy);
    let mut part_img = imageops::crop_imm(img, ox, oy, ow, oh).to_image();
    let mut full = imageops::crop_imm(mask, ox, oy, ow, oh).to_image();
    let (x0, y0, x1, y1) = (x0 - ox, y0 - oy, x1 - ox, y1 - oy);
    // closing with ~a stroke's width
    let r = ((stroke * 0.75).round() as usize).clamp(1, 4);
    let (w, h) = (ow as usize, oh as usize);
    let src: Vec<i32> = full.pixels().map(|p| (p[0] > 0) as i32).collect();
    let closed = min_max(&min_max(&src, w, h, r, false), w, h, r, true);
    for (p, v) in full.pixels_mut().zip(&closed) {
        if *v > 0 {
            p[0] = 255;
        }
    }
    // (bigger tiles on a very big picture: 256 px of 40 MP are a speck, and take ages)
    let mp = img.width() as f32 * img.height() as f32 / 1e6;
    let tile = ((256.0 * (mp / 8.0).sqrt()) as u32).clamp(256, 384);
    let mut ty = y0;
    while ty <= y1 {
        let mut tx = x0;
        while tx <= x1 {
            if stop() {
                return Err(crate::ai::STOPPED.into());
            }
            let mut part = GrayImage::new(ow, oh);
            let mut any = false;
            for y in ty..(ty + tile).min(y1 + 1) {
                for x in tx..(tx + tile).min(x1 + 1) {
                    if full.get_pixel(x, y)[0] > 0 {
                        part.put_pixel(x, y, Luma([255]));
                        any = true;
                    }
                }
            }
            if any {
                // the whole mark stays hole in the window, only this tile is written
                crate::ai::inpaint_lama_part(app_data, &mut part_img, &full, &part)?;
            }
            tx += tile;
        }
        ty += tile;
    }
    imageops::replace(img, &part_img, ox as i64, oy as i64);
    Ok(())
}

/* ---- a soft shadow (or glow) around the mark ---------------------------------- */

/// Where the mark sits on a picture: its box's middle, its size against the framed one,
/// how far it's turned (degrees).
#[derive(Clone, Copy)]
pub struct Spot {
    pub cx: f32,
    pub cy: f32,
    pub scale: f32,
    pub angle: f32,
}

/// The mark and some room around it on a small canvas, the same for every picture: there
/// the pictures are laid on top of each other to see what they all have around the mark.
struct Canvas {
    /// Canvas px per px of the framed mark.
    f: f32,
    w: usize,
    h: usize,
}

impl Canvas {
    fn of(m: &Motif) -> Canvas {
        let (mw, mh) = (m.mask.width() as f32, m.mask.height() as f32);
        let room = 0.135 * mw.max(mh);
        let f = (750.0 / (mw.max(mh) + 2.0 * room)).min(1.0);
        Canvas { f, w: ((mw + 2.0 * room) * f).round().max(8.0) as usize, h: ((mh + 2.0 * room) * f).round().max(8.0) as usize }
    }

    /// A mask of the mark's size on the canvas, 0..1.
    fn lay(&self, mask: &GrayImage) -> Vec<f32> {
        let (tw, th) = (
            ((mask.width() as f32 * self.f).round() as u32).max(1),
            ((mask.height() as f32 * self.f).round() as u32).max(1),
        );
        let small = imageops::resize(mask, tw, th, FilterType::Triangle);
        let (ox, oy) = ((self.w - (tw as usize).min(self.w)) / 2, (self.h - (th as usize).min(self.h)) / 2);
        let mut out = vec![0f32; self.w * self.h];
        for (x, y, p) in small.enumerate_pixels() {
            let (cx, cy) = (ox + x as usize, oy + y as usize);
            if cx < self.w && cy < self.h {
                out[cy * self.w + cx] = p[0] as f32 / 255.0;
            }
        }
        out
    }
}

/// A blur with about this sigma (three box blurs, nothing outside).
fn blur(v: &[f32], w: usize, h: usize, sigma: f32) -> Vec<f32> {
    let r = (((4.0 * sigma * sigma + 1.0).sqrt() - 1.0) / 2.0).round().max(1.0) as usize;
    let n = (2 * r + 1) as f32;
    let mut a = v.to_vec();
    let mut line = Vec::new();
    for _ in 0..3 {
        for (len, lines, step, jump) in [(w, h, 1usize, w), (h, w, w, 1usize)] {
            for l in 0..lines {
                line.clear();
                line.push(0f32);
                for i in 0..len {
                    line.push(line[i] + a[l * jump + i * step]);
                }
                for i in 0..len {
                    a[l * jump + i * step] = (line[(i + r + 1).min(len)] - line[i.saturating_sub(r)]) / n;
                }
            }
        }
    }
    a
}

/// What the pictures have in common around the mark, summed up.
pub struct Around {
    canvas: Canvas,
    /// The mark on the canvas, and grown: too close to say anything, and the area a
    /// shadow can be in.
    close: Vec<bool>,
    zone: Vec<bool>,
    sum: Vec<f32>,
    weight: Vec<f32>,
    pictures: usize,
}

impl Around {
    pub fn new(m: &Motif) -> Around {
        let canvas = Canvas::of(m);
        let on: Vec<bool> = canvas.lay(&m.mask).iter().map(|v| *v > 0.01).collect();
        let (w, h) = (canvas.w, canvas.h);
        let close = morph(&on, w, h, 2, false);
        let zone = morph(&on, w, h, (w / 25).max(4), false);
        Around { canvas, close, zone, sum: vec![0.0; w * h], weight: vec![0.0; w * h], pictures: 0 }
    }

    /// How much brighter or darker (log) a picture is around its mark than further out,
    /// and how much each pixel counts (a busy picture less).
    pub fn look(&self, img: &RgbaImage, at: &Spot) -> Vec<(f32, f32)> {
        let (w, h) = (self.canvas.w, self.canvas.h);
        // the picture's part under the canvas, scaled to it
        let k = at.scale / self.canvas.f;
        let (px, py) = (at.cx - w as f32 * k / 2.0, at.cy - h as f32 * k / 2.0);
        let x0 = px.max(0.0).floor() as u32;
        let y0 = py.max(0.0).floor() as u32;
        let x1 = ((px + w as f32 * k).ceil().max(0.0) as u32).min(img.width());
        let y1 = ((py + h as f32 * k).ceil().max(0.0) as u32).min(img.height());
        let none = vec![(0.0, 0.0); w * h];
        if x1 <= x0 + 8 || y1 <= y0 + 8 {
            return none;
        }
        let cut = imageops::crop_imm(img, x0, y0, x1 - x0, y1 - y0).to_image();
        let (sw, sh) = ((((x1 - x0) as f32 / k).round() as u32).max(1), (((y1 - y0) as f32 / k).round() as u32).max(1));
        let small = shrink(&cut, sw, sh);
        let (ox, oy) = (((x0 as f32 - px) / k).round() as i64, ((y0 as f32 - py) / k).round() as i64);
        let mut lum = vec![0f32; w * h];
        let mut there = vec![false; w * h];
        for (x, y, p) in small.enumerate_pixels() {
            let (cx, cy) = (ox + x as i64, oy + y as i64);
            if cx >= 0 && cy >= 0 && (cx as usize) < w && (cy as usize) < h {
                let i = cy as usize * w + cx as usize;
                lum[i] = (p[0] as f32 * 0.299 + p[1] as f32 * 0.587 + p[2] as f32 * 0.114 + 6.0).ln();
                there[i] = true;
            }
        }
        // the background from further out, smooth
        let sigma = w as f32 * 0.06;
        let far: Vec<f32> = (0..w * h).map(|i| (there[i] && !self.zone[i]) as i32 as f32).collect();
        let num = blur(&lum.iter().zip(&far).map(|(l, f)| l * f).collect::<Vec<_>>(), w, h, sigma);
        let den = blur(&far, w, h, sigma);
        let (mut sq, mut n) = (0f32, 0f32);
        for i in (0..w * h).filter(|i| far[*i] > 0.0 && den[*i] > 0.02) {
            sq += (lum[i] - num[i] / den[i]).powi(2);
            n += 1.0;
        }
        if n < 50.0 {
            return none;
        }
        let weight = 1.0 / (sq / n + 0.003);
        (0..w * h)
            .map(|i| {
                if there[i] && !self.close[i] && den[i] > 0.02 {
                    (lum[i] - num[i] / den[i], weight)
                } else {
                    (0.0, 0.0)
                }
            })
            .collect()
    }

    pub fn add(&mut self, seen: &[(f32, f32)]) {
        for (i, (d, w)) in seen.iter().enumerate() {
            self.sum[i] += d * w;
            self.weight[i] += w;
        }
        self.pictures += 1;
    }

    /// The shadow (or glow) they all have: one of the mark's parts, blurred and shifted,
    /// as strong as fits best. None when there isn't clearly one. parts: masks of the
    /// mark's size (its colours; often only one of them throws a shadow).
    pub fn shadow(&self, parts: &[GrayImage]) -> Option<Shadow> {
        if self.pictures < 4 {
            return None;
        }
        let (w, h) = (self.canvas.w, self.canvas.h);
        let unit = w as f32 / 755.0;
        let reach = (12.0 * unit).round().max(1.0) as i32;
        let step = (2.0 * unit).round().max(1.0) as usize;
        let pts: Vec<(usize, usize, f32, f32)> = (0..w * h)
            .filter(|i| self.zone[*i] && self.weight[*i] > 0.0)
            .step_by(3)
            .map(|i| (i % w, i / w, self.sum[i] / self.weight[i], self.weight[i]))
            .collect();
        let sw: f64 = pts.iter().map(|p| p.3 as f64).sum();
        if pts.len() < 200 || sw <= 0.0 {
            return None;
        }
        let mr = pts.iter().map(|p| (p.2 * p.3) as f64).sum::<f64>() / sw;
        let vr = pts.iter().map(|p| p.3 as f64 * (p.2 as f64 - mr).powi(2)).sum::<f64>();
        // (how well it fits, strength, blurred part, shift)
        let mut best: Option<(f64, f64, Vec<f32>, i32, i32)> = None;
        for part in parts {
            let on = self.canvas.lay(part);
            for sigma in [3f32, 4.0, 6.0, 8.0, 11.0, 13.0, 15.0, 17.0, 20.0] {
                let soft = blur(&on, w, h, (sigma * unit).max(1.0));
                let mut here: Option<(f64, f64, i32, i32)> = None;
                for dy in (-reach..=reach).step_by(step) {
                    for dx in (-reach..=reach).step_by(step) {
                        let (mut sf, mut sff, mut sfr) = (0f64, 0f64, 0f64);
                        for (x, y, r, wt) in &pts {
                            let (sx, sy) = (*x as i32 - dx, *y as i32 - dy);
                            if sx >= 0 && sy >= 0 && (sx as usize) < w && (sy as usize) < h {
                                let v = soft[sy as usize * w + sx as usize] as f64;
                                let wv = v * *wt as f64;
                                sf += wv;
                                sff += wv * v;
                                sfr += wv * *r as f64;
                            }
                        }
                        let cov = sfr - sf * mr;
                        let var = sff - sf * sf / sw;
                        if var <= 1e-9 || vr <= 1e-9 {
                            continue;
                        }
                        let corr = cov / (var * vr).sqrt();
                        if here.map_or(true, |b| corr.abs() > b.0.abs()) {
                            here = Some((corr, cov / var, dx, dy));
                        }
                    }
                }
                if let Some((corr, amp, dx, dy)) = here {
                    if best.as_ref().map_or(true, |b| corr.abs() > b.0.abs()) {
                        best = Some((corr, amp, soft, dx, dy));
                    }
                }
            }
        }
        let (corr, amp, soft, dx, dy) = best?;
        let field: Vec<f32> = (0..w * h)
            .map(|i| {
                let (sx, sy) = ((i % w) as i32 - dx, (i / w) as i32 - dy);
                if sx >= 0 && sy >= 0 && (sx as usize) < w && (sy as usize) < h {
                    (amp * soft[sy as usize * w + sx as usize] as f64) as f32
                } else {
                    0.0
                }
            })
            .collect();
        let strongest = field.iter().fold(0f32, |a, b| a.max(b.abs()));
        (corr.abs() >= 0.5 && strongest >= 0.06).then_some(Shadow { f: self.canvas.f, w, h, field })
    }
}

/// A soft shadow (or glow) around the mark: how much it darkens (log, negative) on the
/// canvas around it.
pub struct Shadow {
    f: f32,
    w: usize,
    h: usize,
    field: Vec<f32>,
}

impl Shadow {
    /// Take it off a picture: what's under it is kept, only made as bright as it was.
    pub fn lift(&self, img: &mut RgbaImage, at: &Spot) {
        let k = at.scale / self.f;
        let (sin, cos) = at.angle.to_radians().sin_cos();
        // the canvas's box on the picture (turned: its circle)
        let half = ((self.w * self.w + self.h * self.h) as f32).sqrt() * k / 2.0;
        let x0 = (at.cx - half).max(0.0) as u32;
        let y0 = (at.cy - half).max(0.0) as u32;
        let x1 = ((at.cx + half).max(0.0) as u32 + 1).min(img.width());
        let y1 = ((at.cy + half).max(0.0) as u32 + 1).min(img.height());
        let at_field = |x: i32, y: i32| -> f32 {
            if x < 0 || y < 0 || x >= self.w as i32 || y >= self.h as i32 {
                0.0
            } else {
                self.field[y as usize * self.w + x as usize]
            }
        };
        for y in y0..y1 {
            for x in x0..x1 {
                let (dx, dy) = ((x as f32 + 0.5 - at.cx) / k, (y as f32 + 0.5 - at.cy) / k);
                let sx = dx * cos + dy * sin + self.w as f32 / 2.0 - 0.5;
                let sy = -dx * sin + dy * cos + self.h as f32 / 2.0 - 0.5;
                let (fx, fy) = (sx.floor(), sy.floor());
                let (ax, ay) = (sx - fx, sy - fy);
                let (ix, iy) = (fx as i32, fy as i32);
                let v = (at_field(ix, iy) * (1.0 - ax) + at_field(ix + 1, iy) * ax) * (1.0 - ay)
                    + (at_field(ix, iy + 1) * (1.0 - ax) + at_field(ix + 1, iy + 1) * ax) * ay;
                if v.abs() < 0.004 {
                    continue;
                }
                let gain = (-v).exp();
                let p = img.get_pixel_mut(x, y);
                for c in 0..3 {
                    p[c] = (p[c] as f32 * gain).round().clamp(0.0, 255.0) as u8;
                }
            }
        }
    }
}

/// The mark's parts by colour (each a mask of the mark's size): a shadow often belongs to
/// one colour only. Always has the whole mark too. img = its own picture, (x, y) the top
/// left of the mark's box there.
pub fn colour_parts(img: &RgbaImage, m: &Motif, x: u32, y: u32) -> Vec<GrayImage> {
    let (w, h) = m.mask.dimensions();
    let mut parts = vec![m.mask.clone()];
    if x + w > img.width() || y + h > img.height() {
        return parts;
    }
    let on: Vec<bool> = m.mask.pixels().map(|p| p[0] > 127).collect();
    let core = morph(&on, w as usize, h as usize, 1, true);
    let col = |i: usize| -> [f32; 3] {
        let p = img.get_pixel(x + i as u32 % w, y + i as u32 / w);
        [p[0] as f32, p[1] as f32, p[2] as f32]
    };
    let dist = |a: &[f32; 3], b: &[f32; 3]| ((a[0] - b[0]).powi(2) + (a[1] - b[1]).powi(2) + (a[2] - b[2]).powi(2)).sqrt();
    let mut bins: std::collections::HashMap<[u8; 3], ([f64; 3], f64)> = std::collections::HashMap::new();
    let mut total = 0f64;
    for i in (0..on.len()).filter(|i| core[*i]) {
        let c = col(i);
        let e = bins.entry(c.map(|v| v as u8 / 32)).or_insert(([0.0; 3], 0.0));
        for k in 0..3 {
            e.0[k] += c[k] as f64;
        }
        e.1 += 1.0;
        total += 1.0;
    }
    // the biggest first, near ones are the same colour
    let mut list: Vec<([f32; 3], f64)> =
        bins.into_values().filter(|(_, n)| *n >= 0.03 * total).map(|(s, n)| (s.map(|v| (v / n) as f32), n)).collect();
    list.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    let mut cols: Vec<[f32; 3]> = Vec::new();
    for (c, _) in list {
        if cols.iter().all(|k| dist(k, &c) > 80.0) {
            cols.push(c);
        }
    }
    if cols.len() < 2 {
        return parts;
    }
    for (k, _) in cols.iter().enumerate().take(4) {
        parts.push(GrayImage::from_fn(w, h, |px, py| {
            let i = (py * w + px) as usize;
            if !on[i] {
                return Luma([0]);
            }
            let c = col(i);
            let near = (0..cols.len()).min_by(|a, b| dist(&cols[*a], &c).partial_cmp(&dist(&cols[*b], &c)).unwrap_or(std::cmp::Ordering::Equal));
            Luma([if near == Some(k) { 255 } else { 0 }])
        }));
    }
    parts
}

#[cfg(test)]
mod tests {
    use super::*;

    fn motif_from_box(img: &RgbaImage, x: u32, y: u32, w: u32, h: u32) -> Option<Motif> {
        let (mask, stroke) = mark_in_box(img, x, y, w, h)?;
        motif_from_mask(&mask, stroke, img.width(), img.height())
    }

    /// A busy, mid-grey backdrop.
    fn busy(w: u32, h: u32, seed: u32) -> RgbaImage {
        RgbaImage::from_fn(w, h, |x, y| {
            let n = (x.wrapping_mul(73_856_093) ^ y.wrapping_mul(19_349_663) ^ seed).wrapping_mul(2_654_435_761) >> 24;
            let v = (110 + (x * 40 / w) as i32 + (n as i32 % 40) - 20).clamp(0, 255) as u8;
            image::Rgba([v, v.saturating_sub(8), v.saturating_add(6), 255])
        })
    }

    /// A made-up mark: a ring, a cross line and a short bar, `stroke` px wide.
    fn draw_mark(img: &mut RgbaImage, cx: f32, cy: f32, size: f32, stroke: f32, col: u8) {
        let (w, h) = img.dimensions();
        for y in 0..h {
            for x in 0..w {
                let (dx, dy) = ((x as f32 - cx) / size, (y as f32 - cy) / size);
                let r = (dx * dx + dy * dy).sqrt();
                let ring = (r - 0.4).abs() * size < stroke * 0.5;
                let cross = (dy - dx * 0.6).abs() * size < stroke * 0.5 && dx.abs() < 0.55;
                let bar = (dy - 0.6).abs() * size < stroke * 0.5 && dx.abs() < 0.3;
                if ring || cross || bar {
                    img.put_pixel(x, y, image::Rgba([col, col, col, 255]));
                }
            }
        }
    }

    #[test]
    fn a_hand_painted_mask_has_its_stroke_width_and_place() {
        let mut m = GrayImage::new(60, 40);
        for y in 18..22 {
            for x in 5..55 {
                m.put_pixel(x, y, Luma([255]));
            }
        }
        assert!((stroke_width(&m) - 4.0).abs() < 0.5, "{}", stroke_width(&m));
        let hit = own_hit(&m, 100, 200, 4.0, 400, 300).unwrap();
        // 2 px wider all around
        assert_eq!(hit.bbox, (103, 216, 156, 223));
        // at the picture's edge it's cut off, not a panic
        assert!(own_hit(&m, 410, 290, 4.0, 400, 300).is_none());
        assert_eq!(own_hit(&m, 380, 270, 4.0, 400, 300).unwrap().bbox.2, 399);
    }

    /// Bold white letters with a thin red line over them, on a soft background: all of it
    /// is the mark, the gaps and the background aren't.
    #[test]
    fn bold_letters_in_two_colours_are_taken_whole() {
        fn bold(x: u32, y: u32) -> bool {
            (70..250).contains(&y) && [80u32, 180, 300, 420, 560].iter().any(|b| (*b..*b + 34).contains(&x))
                || (215..250).contains(&y) && (300..454).contains(&x)
        }
        fn red(x: u32, y: u32) -> bool {
            let d = y as f32 - (40.0 + x as f32 * 0.2);
            (60..640).contains(&x) && d.abs() < 7.0
        }
        let (w, h) = (700u32, 300u32);
        for bg in [40f32, 150.0] {
            let img = RgbaImage::from_fn(w, h, |x, y| {
                // blurry lights
                let l = ((x as f32 / 90.0).sin() * (y as f32 / 70.0).cos() * 25.0) + bg;
                let mut p = [l, l * 0.9, l * 0.9];
                if bold(x, y) {
                    p = [250.0, 228.0, 224.0];
                }
                if red(x, y) {
                    p = [214.0, 18.0, 28.0];
                }
                image::Rgba([p[0] as u8, p[1] as u8, p[2] as u8, 255])
            });
            let (mask, _) = mark_in_box(&img, 0, 0, w, h).expect("mark");
            let (mut hit, mut all, mut wrong, mut on) = (0u32, 0u32, 0u32, 0u32);
            for (x, y, p) in mask.enumerate_pixels() {
                let is = bold(x, y) || red(x, y);
                let near = (-4i32..=4).any(|d| {
                    let (a, b) = ((x as i32 + d).max(0) as u32, (y as i32 + d).max(0) as u32);
                    bold(a, y) || bold(x, b) || red(x, b) || red(a, y)
                });
                all += is as u32;
                hit += (is && p[0] > 0) as u32;
                on += (p[0] > 0) as u32;
                wrong += (p[0] > 0 && !near) as u32;
            }
            assert!(hit as f32 > 0.95 * all as f32, "bg {bg}: only {hit} of {all}");
            assert!((wrong as f32) < 0.03 * on as f32, "bg {bg}: {wrong} of {on} isn't the mark");
        }
    }

    #[test]
    fn a_bold_mark_is_found_turned_a_little() {
        let mut a = busy(700, 500, 1);
        draw_mark(&mut a, 200.0, 220.0, 200.0, 22.0, 245);
        let m = motif_from_box(&a, 60, 90, 280, 290).expect("mark taken");
        assert!(m.wide >= BOLD, "wide {}", m.wide);
        // the same, turned and dark, on another picture
        let t = turned(&m, 11.0);
        let mut b = busy(700, 500, 2);
        for (x, y, p) in t.mask.enumerate_pixels() {
            if p[0] > 127 {
                b.put_pixel(330 + x, 140 + y, image::Rgba([20, 20, 20, 255]));
            }
        }
        let hit = find_motif(&b, &m, &|| false).expect("found");
        assert!(hit.score >= MOTIF_MIN, "score {} angle {}", hit.score, hit.spot.angle);
        let (x0, y0, _, _) = hit.hit.bbox;
        let (tx, ty, _, _) = crate::edit::mask_bbox(&t.mask).unwrap();
        assert!(x0.abs_diff(330 + tx) < 14 && y0.abs_diff(140 + ty) < 14, "at {x0},{y0} angle {}", hit.spot.angle);
    }

    #[test]
    fn the_framed_mark_is_found_elsewhere_bigger_and_in_the_other_colour() {
        let mut a = busy(500, 700, 1);
        draw_mark(&mut a, 120.0, 520.0, 100.0, 4.0, 20);
        let m = motif_from_box(&a, 55, 455, 130, 130).expect("mark taken");
        // on another picture: elsewhere, 1.3x, white
        let mut b = busy(500, 700, 2);
        draw_mark(&mut b, 330.0, 300.0, 130.0, 5.0, 240);
        let hit = find_motif(&b, &m, &|| false).expect("found");
        assert!(hit.score >= MOTIF_MIN, "score {}", hit.score);
        assert!((hit.spot.scale - 1.3).abs() < 0.08, "scale {}", hit.spot.scale);
        let (x0, y0, x1, y1) = hit.hit.bbox;
        let (cx, cy) = ((x0 + x1) as f32 / 2.0, (y0 + y1) as f32 / 2.0);
        assert!((cx - 330.0).abs() < 8.0 && (cy - 306.0).abs() < 12.0, "centre {cx},{cy}");
        // a picture without it
        let c = busy(500, 700, 3);
        assert!(find_motif(&c, &m, &|| false).map_or(true, |h| h.score < MOTIF_MIN));
    }

    #[test]
    fn a_shadow_all_pictures_have_is_measured_and_lifted() {
        // a mark in two colours, only the second throws a soft shadow
        let (w, h) = (420u32, 300u32);
        let bar = |x: u32, y: u32| (110..310).contains(&x) && (150..180).contains(&y);
        let dot = |x: u32, y: u32| (x as f32 - 210.0).powi(2) + (y as f32 - 115.0).powi(2) < 400.0;
        let shade = |x: u32, y: u32| {
            let r = ((x as f32 - 210.0).powi(2) + (y as f32 - 115.0).powi(2)).sqrt();
            0.4 * (1.0 - ((r - 14.0) / 16.0).clamp(0.0, 1.0))
        };
        let plain = |seed: u32| {
            RgbaImage::from_fn(w, h, |x, y| {
                let v = 120.0 + 40.0 * ((x + seed * 37) as f32 / 120.0).sin() + 25.0 * ((y + seed * 91) as f32 / 90.0).cos();
                image::Rgba([v as u8, (v * 0.9) as u8, (v * 0.8) as u8, 255])
            })
        };
        let marked = |seed: u32, shadow: bool| {
            let mut img = plain(seed);
            for (x, y, p) in img.enumerate_pixels_mut() {
                if shadow {
                    for c in 0..3 {
                        p[c] = (p[c] as f32 * (1.0 - shade(x, y))) as u8;
                    }
                }
                if bar(x, y) {
                    *p = image::Rgba([250, 250, 250, 255]);
                }
                if dot(x, y) {
                    *p = image::Rgba([220, 20, 30, 255]);
                }
            }
            img
        };
        let mask = GrayImage::from_fn(w, h, |x, y| Luma([if bar(x, y) || dot(x, y) { 255 } else { 0 }]));
        let (x0, y0, x1, y1) = crate::edit::mask_bbox(&mask).unwrap();
        let m = motif_from_mask(&mask, 20.0, w, h).unwrap();
        let spot = Spot { cx: (x0 + x1 + 1) as f32 / 2.0, cy: (y0 + y1 + 1) as f32 / 2.0, scale: 1.0, angle: 0.0 };
        let parts = colour_parts(&marked(0, true), &m, x0, y0);
        assert_eq!(parts.len(), 3, "the whole and its two colours");
        for shadow in [true, false] {
            let mut around = Around::new(&m);
            for seed in 0..6 {
                let seen = around.look(&marked(seed, shadow), &spot);
                around.add(&seen);
            }
            let found = around.shadow(&parts);
            assert_eq!(found.is_some(), shadow);
            let Some(s) = found else { continue };
            let (mut img, want) = (marked(3, true), plain(3));
            let off = |img: &RgbaImage| {
                let (mut e, mut n) = (0f32, 0f32);
                for (x, y, p) in img.enumerate_pixels() {
                    let r = ((x as f32 - 210.0).powi(2) + (y as f32 - 115.0).powi(2)).sqrt();
                    if (23.0..32.0).contains(&r) && !bar(x, y) {
                        e += (p[0] as f32 - want.get_pixel(x, y)[0] as f32).abs();
                        n += 1.0;
                    }
                }
                e / n
            };
            let before = off(&img);
            s.lift(&mut img, &spot);
            let after = off(&img);
            assert!(after < before * 0.5, "{before} -> {after}");
            // far off nothing changes
            assert_eq!(img.get_pixel(20, 280), marked(3, true).get_pixel(20, 280));
        }
    }

    /// Real pictures: WM_MOTIF = a folder with the pictures in orig/ and box.txt
    /// ("file x y w h", the mark framed on that picture). Prints where it's found on
    /// each and how well, overlays to out/, with WM_APPDATA also LaMa.
    #[test]
    #[ignore]
    fn motif_real() {
        let Ok(dir) = std::env::var("WM_MOTIF") else { return };
        let dir = std::path::PathBuf::from(dir);
        let b = std::fs::read_to_string(dir.join("box.txt")).unwrap();
        let p: Vec<&str> = b.split_whitespace().collect();
        let n = |i: usize| p[i].parse::<u32>().unwrap();
        let load = |f: &str| image::open(dir.join("orig").join(f)).unwrap().to_rgba8();
        let r = load(p[0]);
        let m = motif_from_box(&r, n(1), n(2), n(3), n(4)).expect("mark");
        eprintln!("mark {:?} stroke {:.1} wide {:.0}", m.mask.dimensions(), m.stroke, m.wide);
        std::fs::create_dir_all(dir.join("out")).unwrap();
        m.mask.save(dir.join("out").join("mark.png")).unwrap();
        let (fx0, fy0) = {
            let (mask, _) = mark_in_box(&r, n(1), n(2), n(3), n(4)).unwrap();
            let (x, y, _, _) = crate::edit::mask_bbox(&mask).unwrap();
            (n(1) + x, n(2) + y)
        };
        let parts = colour_parts(&r, &m, fx0, fy0);
        let shadow = std::env::var("WM_SHADOW").is_ok().then(|| {
            let mut around = Around::new(&m);
            let mut all: Vec<_> = std::fs::read_dir(dir.join("orig")).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
            all.sort();
            for f in all {
                let img = load(&f);
                if let Some(h) = find_motif(&img, &m, &|| false).filter(|h| h.score >= MOTIF_MIN && h.spot.angle.abs() < 0.5) {
                    let seen = around.look(&img, &h.spot);
                    around.add(&seen);
                }
            }
            let t = std::time::Instant::now();
            let s = around.shadow(&parts);
            eprintln!(
                "shadow from {} pictures, {} parts: {} strongest {:.2} in {:?}",
                around.pictures,
                parts.len(),
                s.is_some(),
                s.as_ref().map_or(0.0, |s| s.field.iter().fold(0f32, |a, b| a.max(b.abs()))),
                t.elapsed()
            );
            s
        });
        let mut names: Vec<String> =
            std::fs::read_dir(dir.join("orig")).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
        names.sort();
        if let Ok(only) = std::env::var("WM_ONLY") {
            names.retain(|n| only.split(',').any(|o| n.starts_with(o)));
        }
        for name in &names {
            let img = load(name);
            let t = std::time::Instant::now();
            let hit = find_motif(&img, &m, &|| false);
            let took = t.elapsed().as_secs_f32();
            let flipped = image::imageops::flip_horizontal(&image::imageops::flip_vertical(&img));
            // the same picture turned over: the mark isn't there in that shape any more
            let blank = if std::env::var("WM_FAST").is_ok() {
                -1.0
            } else {
                find_motif(&flipped, &m, &|| false).map(|h| h.score).unwrap_or(0.0)
            };
            let Some(hit) = hit else {
                eprintln!("{name}: none (turned {blank:.2})");
                continue;
            };
            let (x0, y0, x1, y1) = hit.hit.bbox;
            eprintln!("{name}: score {:.2} scale {:.2} angle {:.2} at {x0},{y0} in {took:.1}s (turned {blank:.2})", hit.score, hit.spot.scale, hit.spot.angle);
            let (pad, (w, h)) = (60u32, img.dimensions());
            let (cx, cy) = (x0.saturating_sub(pad), y0.saturating_sub(pad));
            let (cw, ch) = ((x1 + pad).min(w - 1) - cx, (y1 + pad).min(h - 1) - cy);
            let mut view = img.clone();
            let mut full = GrayImage::new(w, h);
            for (x, y, q) in hit.hit.mask.enumerate_pixels() {
                if q[0] > 0 {
                    let (gx, gy) = (hit.hit.region.x + x, hit.hit.region.y + y);
                    full.put_pixel(gx, gy, Luma([255]));
                    let v = view.get_pixel_mut(gx, gy);
                    v[0] = ((v[0] as u32 + 255) / 2) as u8;
                    v[1] /= 2;
                    v[2] /= 2;
                }
            }
            image::imageops::crop_imm(&view, cx, cy, cw, ch).to_image().save(dir.join("out").join(format!("{name}.png"))).unwrap();
            if let Ok(ad) = std::env::var("WM_APPDATA") {
                let mut out = img.clone();
                if let Some(Some(s)) = &shadow {
                    s.lift(&mut out, &hit.spot);
                }
                let t = std::time::Instant::now();
                if remove_motif(std::path::Path::new(&ad), &mut out, &full, m.stroke * hit.spot.scale, &|| false).is_ok() {
                    image::imageops::crop_imm(&out, cx, cy, cw, ch).to_image().save(dir.join("out").join(format!("after_{name}.png"))).unwrap();
                    eprintln!("{name}: removed in {:.1}s", t.elapsed().as_secs_f32());
                }
            }
        }
    }
}
