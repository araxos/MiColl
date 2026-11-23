//! Watermark remover (WatermarkDialog.tsx, the wm_* commands in lib.rs): finds a line of
//! text (usually a link in grey) in a corner of every picture of a reward, compares the
//! finds across the reward, and builds the masks LaMa fills.
//!
//! Mode A: thin strokes in the corner are picked out (a top-hat filter; Detect took too
//! much of a grainy corner), and a find only counts when it looks like a line of text:
//! several letters, wide, low, lots of edges along it. So a face or a hand in the corner
//! isn't taken. Fainter parts of the same strokes are added if they hang on sure ones.

use image::{GrayImage, Luma, RgbaImage};

/// Where to look.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Corner {
    TopLeft,
    TopRight,
    BottomLeft,
    BottomRight,
    BottomCenter,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Rect {
    pub x: u32,
    pub y: u32,
    pub w: u32,
    pub h: u32,
}

impl Corner {
    pub fn from_id(s: &str) -> Option<Corner> {
        Some(match s {
            "tl" => Corner::TopLeft,
            "tr" => Corner::TopRight,
            "bl" => Corner::BottomLeft,
            "br" => Corner::BottomRight,
            "bc" => Corner::BottomCenter,
            _ => return None,
        })
    }

    /// The search area: about 30 % x 15 % of the picture (the bottom middle a bit wider).
    pub fn region(self, w: u32, h: u32) -> Rect {
        let share = if self == Corner::BottomCenter { 0.4 } else { 0.3 };
        let rw = ((w as f32 * share).round() as u32).clamp(1, w);
        let rh = ((h as f32 * 0.15).round() as u32).clamp(1, h);
        let x = match self {
            Corner::TopLeft | Corner::BottomLeft => 0,
            Corner::TopRight | Corner::BottomRight => w - rw,
            Corner::BottomCenter => (w - rw) / 2,
        };
        let y = match self {
            Corner::TopLeft | Corner::TopRight => 0,
            _ => h - rh,
        };
        Rect { x, y, w: rw, h: rh }
    }

    /// The point the finds are measured from (their place "relative to the corner").
    pub fn anchor(self, w: u32, h: u32) -> (f32, f32) {
        match self {
            Corner::TopLeft => (0.0, 0.0),
            Corner::TopRight => (w as f32, 0.0),
            Corner::BottomLeft => (0.0, h as f32),
            Corner::BottomRight => (w as f32, h as f32),
            Corner::BottomCenter => (w as f32 / 2.0, h as f32),
        }
    }
}

/// A line of text found in one picture.
#[derive(Clone)]
pub struct Hit {
    /// The search area it was found in.
    pub region: Rect,
    /// What to remove, the size of the region.
    pub mask: GrayImage,
    /// Its box in the picture (x0, y0, x1, y1, inclusive).
    pub bbox: (u32, u32, u32, u32),
    /// How clearly the letters stand out from what's around them (the template is taken
    /// from the clearest picture).
    pub contrast: f32,
}

/// The long side of the copy the search runs on (bigger pictures are scaled down).
const WORK_EDGE: f32 = 1600.0;

/// How strongly each pixel is part of a thin light (light = true) or dark stroke: the
/// top-hat filter (the picture minus its opening, or its closing minus the picture) on
/// red, green and blue and a few stroke widths, the strongest answer. Every channel
/// because a grey watermark over orange wood has the wood's brightness, only not its
/// colour. Light and dark stay apart: the dark one would fill the gaps inside light
/// letters and make blocks of them.
fn stroke_map(img: &RgbaImage, light: bool) -> Vec<i32> {
    let (w, h) = (img.width() as usize, img.height() as usize);
    let mut best = vec![0i32; w * h];
    for c in 0..3 {
        let ch: Vec<i32> = img.pixels().map(|p| p[c] as i32).collect();
        for rad in [2usize, 3, 5] {
            for (b, v) in best.iter_mut().zip(tophat(&ch, w, h, rad, light)) {
                *b = (*b).max(v);
            }
        }
    }
    best
}

/// Above what a stroke counts: well over what the area does in general.
fn stroke_threshold(map: &[i32], k: f32) -> f32 {
    let n = map.len().max(1) as f64;
    let mean = map.iter().map(|v| *v as f64).sum::<f64>() / n;
    let var = map.iter().map(|v| (*v as f64 - mean).powi(2)).sum::<f64>() / n;
    ((mean + 2.5 * var.sqrt()) as f32).max(18.0 * k)
}

/// Look for a line of text in one corner. strength 0..1: higher finds fainter text.
///
/// It runs on a copy at most WORK_EDGE px long: strokes are picked out with stroke_map
/// (the grain and the edges of a busy picture stay quiet), a find has to look like one
/// line of text (text_line), then the line is followed along its row over the whole
/// width (a long name reaches out of the corner) and fainter letters of it are taken in.
/// The mask grows with the letter height, so the soft edge and shadow go too.
pub fn find_text(img: &RgbaImage, corner: Corner, strength: f32) -> Option<Hit> {
    let (w, h) = img.dimensions();
    if w < 48 || h < 48 {
        return None;
    }
    let f = (WORK_EDGE / w.max(h) as f32).min(1.0);
    let (sw, sh) = (((w as f32 * f).round() as u32).max(1), ((h as f32 * f).round() as u32).max(1));
    let small = if f < 1.0 {
        image::imageops::resize(img, sw, sh, image::imageops::FilterType::Triangle)
    } else {
        img.clone()
    };
    let k = (1.3 - strength.clamp(0.0, 1.0)).clamp(0.35, 1.3);
    // 1. the corner: is there a line of text?
    let r = corner.region(sw, sh);
    let reg = image::imageops::crop_imm(&small, r.x, r.y, r.w, r.h).to_image();
    // light text and dark text, the one with the bigger line wins
    let mut best: Option<(GrayImage, u64, bool)> = None;
    let mut thrs = [0f32; 2];
    for light in [true, false] {
        let map = stroke_map(&reg, light);
        let thr = stroke_threshold(&map, k);
        thrs[light as usize] = thr;
        let mut strong = GrayImage::new(r.w, r.h);
        let mut on = 0u64;
        for (i, v) in map.iter().enumerate() {
            if *v as f32 > thr {
                strong.put_pixel(i as u32 % r.w, i as u32 / r.w, Luma([255]));
                on += 1;
            }
        }
        // nothing, or half the corner: not one line of text
        if on < 12 || on * 2 > map.len() as u64 {
            continue;
        }
        if let Some(line) = text_line(&strong) {
            let size = line.pixels().filter(|p| p[0] > 0).count() as u64;
            if best.as_ref().map_or(true, |b| size > b.1) {
                best = Some((line, size, light));
            }
        }
    }
    let (line, _, light) = best?;
    let (lx0, ly0, lx1, ly1) = crate::edit::mask_bbox(&line)?;
    let (lx0, ly0, lx1, ly1) = (lx0 + r.x, ly0 + r.y, lx1 + r.x, ly1 + r.y);
    let lh = ly1 - ly0 + 1;
    // 2. follow it along its row over the whole width, fainter letters included
    let by0 = ly0.saturating_sub(lh / 2);
    // a bit more below than above: the tails of j, g, y
    let by1 = (ly1 + lh * 3 / 4).min(sh - 1);
    let band = image::imageops::crop_imm(&small, 0, by0, sw, by1 - by0 + 1).to_image();
    let (bw, bh) = band.dimensions();
    // light and dark pieces both: along one line the text can be lighter than one
    // background and darker than the next (grey over dark wood, then over a white wall)
    let mut pieces: Vec<(Vec<u32>, Vec<Comp>)> = Vec::new();
    // how much each pixel still looks like a stroke (both kinds, scaled to their own
    // thresholds): the soft edge around the letters is grown into with it below
    let mut halo = vec![0f32; (bw * bh) as usize];
    for pol in [light, !light] {
        let bmap = stroke_map(&band, pol);
        let weak_thr = thrs[pol as usize] * 0.5;
        for (hv, v) in halo.iter_mut().zip(&bmap) {
            *hv = hv.max(*v as f32 / thrs[pol as usize].max(1.0));
        }
        let mut weak = GrayImage::new(bw, bh);
        for (i, v) in bmap.iter().enumerate() {
            if *v as f32 > weak_thr {
                weak.put_pixel(i as u32 % bw, i as u32 / bw, Luma([255]));
            }
        }
        pieces.push(components(&weak));
    }
    // where the line already is (band coordinates)
    let core_y0 = (ly0 - by0) as f32 - lh as f32 * 0.3;
    let core_y1 = (ly1 - by0) as f32 + lh as f32 * 0.3;
    let fits = |c: &Comp| {
        let mid = (c.y0 + c.y1) as f32 / 2.0;
        mid >= core_y0 && mid <= core_y1 && (c.y1 - c.y0 + 1) as f32 <= lh as f32 * 1.6 && (c.x1 - c.x0 + 1) <= lh * 4
    };
    let mut take: Vec<Vec<bool>> = pieces.iter().map(|(_, c)| vec![false; c.len()]).collect();
    let (mut ex0, mut ex1) = (lx0, lx1);
    // the found line's own pieces (its own kind of stroke)
    for (i, c) in pieces[0].1.iter().enumerate() {
        if fits(c) && c.x1 >= lx0 && c.x0 <= lx1 {
            take[0][i] = true;
            ex0 = ex0.min(c.x0);
            ex1 = ex1.max(c.x1);
        }
    }
    // letters right next to it, outwards, as long as they keep coming
    let gap = ((lh as f32) * 1.2).max(6.0) as u32;
    let min_piece = (lh * lh / 50).max(6);
    loop {
        let mut grew = false;
        for (k, (_, comps)) in pieces.iter().enumerate() {
            for (i, c) in comps.iter().enumerate() {
                // a letter's size, not a speck of grain (they'd chain along a busy row)
                if take[k][i] || !fits(c) || c.area < min_piece {
                    continue;
                }
                if c.x1 + gap >= ex0 && c.x0 <= ex1 + gap {
                    take[k][i] = true;
                    ex0 = ex0.min(c.x0);
                    ex1 = ex1.max(c.x1);
                    grew = true;
                }
            }
        }
        if !grew {
            break;
        }
    }
    // the line's box reaches a bit lower than its core: the tails of j, g, y
    let desc_y1 = (ly1 - by0) as f32 + lh as f32 * 0.65;
    // 3. only the letters (like a careful brush): the background between them stays as
    // it is, only the text is made new
    let _ = desc_y1;
    let mut sm = vec![0i32; (bw * bh) as usize];
    let mut ring: Vec<(u32, u32, u32)> = Vec::new();
    for (at, v) in sm.iter_mut().enumerate() {
        let on = pieces.iter().enumerate().any(|(k, (labels, _))| {
            let l = labels[at];
            l > 0 && take[k][(l - 1) as usize]
        });
        if on {
            *v = 255;
            ring.push((at as u32 % bw, at as u32 / bw, 0));
        }
    }
    // how clearly the letters stand out: their stroke strength against the rest of the row
    let contrast = {
        let near = {
            let m = GrayImage::from_fn(bw, bh, |x, y| Luma([if sm[(y * bw + x) as usize] > 0 { 255 } else { 0 }]));
            crate::edit::dilate_mask(&m, ((lh as f32) * 0.25).round().max(2.0) as i32)
        };
        let (mut sig, mut ns, mut bg, mut nb) = (0f32, 0u32, 0f32, 0u32);
        for (at, v) in sm.iter().enumerate() {
            if *v > 0 {
                sig += halo[at];
                ns += 1;
            } else if near.get_pixel(at as u32 % bw, at as u32 / bw)[0] == 0 {
                bg += halo[at];
                nb += 1;
            }
        }
        (sig / ns.max(1) as f32) / (bg / nb.max(1) as f32 + 0.05)
    };
    // the soft edge: from the letters outwards into pixels that still show some of the
    // stroke, at most ~12 % of the letter height away. Where the edge is sharp the mask
    // stays tight, where it's soft (or a letter has a faint gap) it goes with it
    let reach = ((lh as f32) * 0.12).round().max(1.0) as u32;
    while let Some((x, y, d)) = ring.pop() {
        if d >= reach {
            continue;
        }
        for (dx, dy) in [(-1i32, 0i32), (1, 0), (0, -1), (0, 1), (-1, -1), (1, -1), (-1, 1), (1, 1)] {
            let (nx, ny) = (x as i32 + dx, y as i32 + dy);
            if nx < 0 || ny < 0 || nx >= bw as i32 || ny >= bh as i32 {
                continue;
            }
            let at = (ny as u32 * bw + nx as u32) as usize;
            if sm[at] == 0 && halo[at] > 0.25 {
                sm[at] = 255;
                ring.insert(0, (nx as u32, ny as u32, d + 1));
            }
        }
    }
    // back to full size, grown with the letter height (soft edge, shadow)
    let inv = 1.0 / f;
    let fy0 = ((by0 as f32) * inv).floor() as u32;
    let fy1 = (((by1 + 1) as f32 * inv).ceil() as u32).min(h);
    let fx0 = ((ex0 as f32) * inv).floor().max(0.0) as u32;
    let fx1 = (((ex1 + 1) as f32 * inv).ceil() as u32).min(w);
    // a couple of px around the strokes, so the soft edge goes too
    let grow = (((lh as f32) * inv * 0.06).round() as i32).clamp(2, 4);
    let pad = grow as u32 + 2;
    let rx0 = fx0.saturating_sub(pad);
    let ry0 = fy0.saturating_sub(pad);
    let rx1 = (fx1 + pad).min(w);
    let ry1 = (fy1 + pad).min(h);
    let (rw, rh) = (rx1 - rx0, ry1 - ry0);
    let mut mask = GrayImage::new(rw, rh);
    for y in 0..rh {
        for x in 0..rw {
            let bx = (((rx0 + x) as f32 + 0.5) * f) as u32;
            let byy = (((ry0 + y) as f32 + 0.5) * f) as i64 - by0 as i64;
            if bx >= bw || byy < 0 || byy >= bh as i64 {
                continue;
            }
            if sm[(byy as u32 * bw + bx) as usize] > 0 {
                mask.put_pixel(x, y, Luma([255]));
            }
        }
    }
    let mask = crate::edit::dilate_mask(&mask, grow);
    let (mx0, my0, mx1, my1) = crate::edit::mask_bbox(&mask)?;
    Some(Hit {
        region: Rect { x: rx0, y: ry0, w: rw, h: rh },
        mask,
        bbox: (rx0 + mx0, ry0 + my0, rx0 + mx1, ry0 + my1),
        contrast,
    })
}

/// 8-connected pieces of a mask: a label per pixel (0 = off, else index + 1) and the pieces.
fn components(mask: &GrayImage) -> (Vec<u32>, Vec<Comp>) {
    let (w, h) = mask.dimensions();
    let mut labels = vec![0u32; (w * h) as usize];
    let mut comps: Vec<Comp> = Vec::new();
    let mut stack: Vec<(u32, u32)> = Vec::new();
    for sy in 0..h {
        for sx in 0..w {
            if mask.get_pixel(sx, sy)[0] == 0 || labels[(sy * w + sx) as usize] != 0 {
                continue;
            }
            let id = comps.len() as u32 + 1;
            let mut c = Comp { x0: sx, y0: sy, x1: sx, y1: sy, area: 0 };
            labels[(sy * w + sx) as usize] = id;
            stack.push((sx, sy));
            while let Some((x, y)) = stack.pop() {
                c.area += 1;
                c.x0 = c.x0.min(x);
                c.x1 = c.x1.max(x);
                c.y0 = c.y0.min(y);
                c.y1 = c.y1.max(y);
                for dy in -1i32..=1 {
                    for dx in -1i32..=1 {
                        let nx = x as i32 + dx;
                        let ny = y as i32 + dy;
                        if nx < 0 || ny < 0 || nx >= w as i32 || ny >= h as i32 {
                            continue;
                        }
                        let i = (ny as u32 * w + nx as u32) as usize;
                        if labels[i] == 0 && mask.get_pixel(nx as u32, ny as u32)[0] > 0 {
                            labels[i] = id;
                            stack.push((nx as u32, ny as u32));
                        }
                    }
                }
            }
            comps.push(c);
        }
    }
    (labels, comps)
}

/// Min or max over a (2*rad+1) square, done as a row pass and a column pass.
fn min_max(src: &[i32], w: usize, h: usize, rad: usize, take_min: bool) -> Vec<i32> {
    min_max_rect(src, w, h, rad, rad, take_min)
}

/// Min or max over a (2*rx+1) x (2*ry+1) box.
fn min_max_rect(src: &[i32], w: usize, h: usize, rx: usize, ry: usize, take_min: bool) -> Vec<i32> {
    let pick = |a: i32, b: i32| if take_min { a.min(b) } else { a.max(b) };
    let mut tmp = vec![0i32; src.len()];
    for y in 0..h {
        for x in 0..w {
            let (x0, x1) = (x.saturating_sub(rx), (x + rx).min(w - 1));
            let mut v = src[y * w + x0];
            for xx in x0 + 1..=x1 {
                v = pick(v, src[y * w + xx]);
            }
            tmp[y * w + x] = v;
        }
    }
    let mut out = vec![0i32; src.len()];
    for y in 0..h {
        let (y0, y1) = (y.saturating_sub(ry), (y + ry).min(h - 1));
        for x in 0..w {
            let mut v = tmp[y0 * w + x];
            for yy in y0 + 1..=y1 {
                v = pick(v, tmp[yy * w + x]);
            }
            out[y * w + x] = v;
        }
    }
    out
}

/// How much thin light (light = true) or dark strokes stand out, per pixel.
fn tophat(lum: &[i32], w: usize, h: usize, rad: usize, light: bool) -> Vec<i32> {
    if light {
        // opening = max(min(.)): what's left without the thin light strokes
        let open = min_max(&min_max(lum, w, h, rad, true), w, h, rad, false);
        lum.iter().zip(&open).map(|(a, b)| (a - b).max(0)).collect()
    } else {
        let close = min_max(&min_max(lum, w, h, rad, false), w, h, rad, true);
        lum.iter().zip(&close).map(|(a, b)| (b - a).max(0)).collect()
    }
}

#[derive(Clone, Copy)]
struct Comp {
    x0: u32,
    y0: u32,
    x1: u32,
    y1: u32,
    area: u32,
}

/// The pixels of the one line of text in mask (region size), or None if what's there
/// isn't one.
fn text_line(mask: &GrayImage) -> Option<GrayImage> {
    let (w, h) = mask.dimensions();
    let (labels, comps) = components(mask);
    // specks out, and anything nearly as tall as the area (a hand, the edge of a face)
    let ok: Vec<(u32, Comp)> = comps
        .iter()
        .enumerate()
        .map(|(i, c)| (i as u32 + 1, *c))
        .filter(|(_, c)| c.area >= 3 && (c.y1 - c.y0 + 1) * 10 <= h * 7)
        .collect();
    if ok.is_empty() {
        return None;
    }
    let mut heights: Vec<u32> = ok.iter().map(|(_, c)| c.y1 - c.y0 + 1).collect();
    heights.sort_unstable();
    let hm = heights[heights.len() / 2].max(3) as f32;
    let cy = |c: &Comp| (c.y0 + c.y1) as f32 / 2.0;
    // the band of rows that holds the most of it: the line
    let band = ok
        .iter()
        .map(|(_, c)| {
            let mid = cy(c);
            let total: u32 = ok.iter().filter(|(_, o)| (cy(o) - mid).abs() <= hm).map(|(_, o)| o.area).sum();
            (mid, total)
        })
        .max_by_key(|(_, t)| *t)?
        .0;
    let mut line: Vec<(u32, Comp)> = ok
        .into_iter()
        .filter(|(_, c)| (cy(c) - band).abs() <= hm && (c.y1 - c.y0 + 1) as f32 <= hm * 3.0)
        .collect();
    line.sort_by_key(|(_, c)| c.x0);
    // words next to each other belong together, a big gap starts something else
    let gap = (hm * 3.0).max(12.0) as u32;
    let mut runs: Vec<Vec<(u32, Comp)>> = Vec::new();
    for item in line {
        match runs.last_mut() {
            Some(run) if item.1.x0 <= run.iter().map(|(_, c)| c.x1).max().unwrap_or(0) + gap => run.push(item),
            _ => runs.push(vec![item]),
        }
    }
    let run = runs.into_iter().max_by_key(|r| r.iter().map(|(_, c)| c.area).sum::<u32>())?;
    let x0 = run.iter().map(|(_, c)| c.x0).min()?;
    let x1 = run.iter().map(|(_, c)| c.x1).max()?;
    let y0 = run.iter().map(|(_, c)| c.y0).min()?;
    let y1 = run.iter().map(|(_, c)| c.y1).max()?;
    let bw = x1 - x0 + 1;
    let bh = y1 - y0 + 1;
    let area: u32 = run.iter().map(|(_, c)| c.area).sum();
    // several letters, wide and low
    if run.len() < 3 || (bw as f32) < bh as f32 * 2.5 || bh * 10 > h * 6 {
        return None;
    }
    // neither a hair line nor a solid block
    let fill = area as f32 / (bw * bh) as f32;
    if !(0.06..=0.8).contains(&fill) {
        return None;
    }
    // text has strokes all along it: count the on/off steps across the middle rows of the
    // pieces themselves, per letter height of width (a blob has two, at its ends)
    let keep: std::collections::HashSet<u32> = run.iter().map(|(id, _)| *id).collect();
    let r0 = y0 + bh / 5;
    let r1 = (y1 - bh / 5).max(r0);
    let mut steps = 0u32;
    for y in r0..=r1 {
        let mut was = false;
        for x in x0..=x1 {
            let on = keep.contains(&labels[(y * w + x) as usize]);
            if on && !was {
                steps += 1;
            }
            was = on;
        }
    }
    let per_row = steps as f32 / (r1 - r0 + 1) as f32;
    let density = per_row / (bw as f32 / bh as f32);
    if density < 0.8 {
        return None;
    }
    let mut out = GrayImage::new(w, h);
    for y in y0..=y1 {
        for x in x0..=x1 {
            if keep.contains(&labels[(y * w + x) as usize]) {
                out.put_pixel(x, y, Luma([255]));
            }
        }
    }
    Some(out)
}

/* ---- the template: the watermark from the clearest picture, laid onto the rest ---- */

/// The watermark as taken from the picture where it shows best: its letters (with their
/// soft edge) and where they sat, to lay onto the other pictures of the reward.
#[derive(Clone)]
pub struct Template {
    pub corner: Corner,
    /// The size of the picture it was taken from.
    pub w: u32,
    pub h: u32,
    /// Where its box sat in that picture.
    pub x0: u32,
    pub y0: u32,
    /// The letters, its box's size.
    pub mask: GrayImage,
    /// The picture under the box (where the text shows best): its edges are what's
    /// looked for on the other pictures.
    pub look: RgbaImage,
}

impl Template {
    pub fn from_hit(hit: &Hit, img: &RgbaImage, corner: Corner) -> Template {
        let (x0, y0, x1, y1) = hit.bbox;
        let (bw, bh) = (x1 - x0 + 1, y1 - y0 + 1);
        let mask = image::imageops::crop_imm(&hit.mask, x0 - hit.region.x, y0 - hit.region.y, bw, bh).to_image();
        let look = image::imageops::crop_imm(img, x0, y0, bw, bh).to_image();
        Template { corner, w: img.width(), h: img.height(), x0, y0, mask, look }
    }
}

/// Which find to make the template from (finds on pictures of one size): of those whose
/// box agrees with most of the others (a find that ran out along the picture, or got
/// only part of the line, doesn't), the clearest.
pub fn best_find(finds: &[&Hit]) -> Option<usize> {
    let median = |mut v: Vec<f32>| {
        v.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        v.get(v.len() / 2).copied().unwrap_or(0.0)
    };
    let side = |k: usize| median(finds.iter().map(|h| [h.bbox.0, h.bbox.1, h.bbox.2, h.bbox.3][k] as f32).collect());
    let (mx0, my0, mx1, my1) = (side(0), side(1), side(2), side(3));
    let (tx, ty) = (((mx1 - mx0) * 0.08).max(4.0), ((my1 - my0) * 0.3).max(3.0));
    let agrees = |h: &Hit| {
        let (x0, y0, x1, y1) = h.bbox;
        (x0 as f32 - mx0).abs() <= tx
            && (x1 as f32 - mx1).abs() <= tx
            && (y0 as f32 - my0).abs() <= ty
            && (y1 as f32 - my1).abs() <= ty
    };
    let by_contrast = |a: &(usize, &&Hit), b: &(usize, &&Hit)| {
        a.1.contrast.partial_cmp(&b.1.contrast).unwrap_or(std::cmp::Ordering::Equal)
    };
    finds
        .iter()
        .enumerate()
        .filter(|(_, h)| agrees(h))
        .max_by(by_contrast)
        .or_else(|| finds.iter().enumerate().max_by(by_contrast))
        .map(|(i, _)| i)
}

/// At most this many templates per corner (one per picture size, the most common sizes).
const MAX_TEMPLATES: usize = 4;

/// The pictures to take the templates from: one per picture size (pictures of one size
/// carry the watermark at the same size and place), the most common sizes first.
/// finds: (picture size, its find).
pub fn template_sources(finds: &[((u32, u32), Option<&Hit>)]) -> Vec<usize> {
    let mut groups: Vec<((u32, u32), Vec<usize>)> = Vec::new();
    for (i, (size, hit)) in finds.iter().enumerate() {
        if hit.is_none() {
            continue;
        }
        match groups.iter_mut().find(|g| g.0 == *size) {
            Some(g) => g.1.push(i),
            None => groups.push((*size, vec![i])),
        }
    }
    groups.sort_by(|a, b| b.1.len().cmp(&a.1.len()));
    groups
        .iter()
        .filter_map(|(_, members)| {
            let list: Vec<&Hit> = members.iter().filter_map(|i| finds[*i].1).collect();
            best_find(&list).map(|k| members[k])
        })
        .take(MAX_TEMPLATES)
        .collect()
}

/// The best fitting template on a picture: the one made from a picture of the same size
/// first (same size = same watermark size and place), the others only when that one
/// doesn't fit. (Placed, which template).
pub fn place_best(img: &RgbaImage, templates: &[Template]) -> Option<(Placed, usize)> {
    let (w, h) = img.dimensions();
    let mut order: Vec<usize> = (0..templates.len()).collect();
    order.sort_by_key(|i| !(templates[*i].w == w && templates[*i].h == h));
    let mut best: Option<(Placed, usize)> = None;
    for (n, i) in order.into_iter().enumerate() {
        if n > 0 && best.as_ref().is_some_and(|b| b.0.score >= PLACE_MIN && (templates[b.1].w, templates[b.1].h) == (w, h)) {
            break;
        }
        if let Some(p) = place(img, &templates[i], &NEAR) {
            if best.as_ref().map_or(true, |b| p.score > b.0.score) {
                best = Some((p, i));
            }
        }
    }
    best
}

/// How far around the expected place (share of the picture) and which sizes are tried.
pub struct Search {
    pub margin_x: f32,
    pub margin_y: f32,
    pub scales: &'static [f32],
    /// Step of the first, coarse pass (px of the work copy).
    pub coarse: i32,
    /// At most this many points of the letters (and of their ring) are compared.
    pub cap: usize,
}

/// Near where it should be: the same place from the corner (same pixels, or grown with
/// the width), a bit of slack, sizes ±6 %.
pub const NEAR: Search = Search {
    margin_x: 0.06,
    margin_y: 0.05,
    scales: &[0.94, 0.96, 0.98, 1.0, 1.02, 1.04, 1.06],
    coarse: 2,
    cap: 2500,
};

/// A template laid onto a picture: the mask (picture size) and how well it fits.
pub struct Placed {
    pub mask: GrayImage,
    pub score: f32,
}

/// Below this the template doesn't fit the picture (no watermark there, or another one).
pub const PLACE_MIN: f32 = 0.25;

/// How strong the edges are at each pixel: the biggest step to the neighbours over red,
/// green and blue (a grey watermark over orange wood shows in the colour, not the
/// brightness).
fn edges(img: &RgbaImage) -> Vec<f32> {
    let (w, h) = img.dimensions();
    let mut out = vec![0f32; (w * h) as usize];
    if w < 3 || h < 3 {
        return out;
    }
    for y in 1..h - 1 {
        for x in 1..w - 1 {
            let (l, r, u, d) = (img.get_pixel(x - 1, y), img.get_pixel(x + 1, y), img.get_pixel(x, y - 1), img.get_pixel(x, y + 1));
            let mut m = 0i32;
            for c in 0..3 {
                let g = (r[c] as i32 - l[c] as i32).abs() + (d[c] as i32 - u[c] as i32).abs();
                m = m.max(g);
            }
            out[(y * w + x) as usize] = m as f32;
        }
    }
    out
}

/// Lay the template onto a picture where it fits best: near where it sat in its own
/// picture (the same pixels from the corner, or grown with the width, the height, the
/// short or the long side or the area), sizes from `search`. Compared over the edges (normalised cross-correlation): the same letters
/// match whether they are light on dark or dark on light, faint or strong.
/// score = the correlation, 1 = the same edges.
pub fn place(img: &RgbaImage, t: &Template, search: &Search) -> Option<Placed> {
    let (w, h) = img.dimensions();
    if w < 48 || h < 48 {
        return None;
    }
    let f = (WORK_EDGE / w.max(h) as f32).min(1.0);
    let (sw, sh) = (((w as f32 * f).round() as u32).max(1), ((h as f32 * f).round() as u32).max(1));
    let small = if f < 1.0 {
        image::imageops::resize(img, sw, sh, image::imageops::FilterType::Triangle)
    } else {
        img.clone()
    };
    // where it should be: (target px per template px, its top left in the picture)
    let (ax_t, ay_t) = t.corner.anchor(t.w, t.h);
    let (ax, ay) = t.corner.anchor(w, h);
    let mut cands: Vec<(f32, f32, f32)> = Vec::new();
    let (rw, rh) = (w as f32 / t.w.max(1) as f32, h as f32 / t.h.max(1) as f32);
    let short = w.min(h) as f32 / t.w.min(t.h).max(1) as f32;
    let long = w.max(h) as f32 / t.w.max(t.h).max(1) as f32;
    for sc in [1.0f32, rw, rh, short, long, (rw * rh).sqrt()] {
        if cands.iter().any(|c| (c.0 - sc).abs() < 0.01) {
            continue;
        }
        cands.push((sc, ax + (t.x0 as f32 - ax_t) * sc, ay + (t.y0 as f32 - ay_t) * sc));
    }
    // the window to look in (work copy px)
    let (tw, th) = t.mask.dimensions();
    let big = search.scales.iter().fold(0f32, |a, b| a.max(*b));
    let (mx, my) = (search.margin_x * sw as f32, search.margin_y * sh as f32);
    let (mut wx0, mut wy0, mut wx1, mut wy1) = (f32::MAX, f32::MAX, f32::MIN, f32::MIN);
    for (sc, px, py) in &cands {
        wx0 = wx0.min(px * f - mx - 2.0);
        wy0 = wy0.min(py * f - my - 2.0);
        wx1 = wx1.max(px * f + tw as f32 * sc * big * f + mx + 2.0);
        wy1 = wy1.max(py * f + th as f32 * sc * big * f + my + 2.0);
    }
    let wx0 = wx0.max(0.0) as u32;
    let wy0 = wy0.max(0.0) as u32;
    let wx1 = (wx1.max(0.0) as u32).min(sw);
    let wy1 = (wy1.max(0.0) as u32).min(sh);
    if wx1 <= wx0 + 8 || wy1 <= wy0 + 4 {
        return None;
    }
    let (ww, wh) = (wx1 - wx0, wy1 - wy0);
    let win = image::imageops::crop_imm(&small, wx0, wy0, ww, wh).to_image();
    let g = edges(&win);
    // (score, candidate, size, x, y) - x, y = the template's top left in the window
    let mut best: (f32, usize, f32, i32, i32) = (f32::MIN, 0, 1.0, 0, 0);
    // the template's edges at one size, as sample points with their (centred) values
    let points = |ss: f32| -> Option<(Vec<(i32, i32, f32)>, f32, u32, u32)> {
        let (stw, sth) = ((tw as f32 * ss).round() as u32, (th as f32 * ss).round() as u32);
        if stw < 8 || sth < 4 {
            return None;
        }
        let look = image::imageops::resize(&t.look, stw, sth, image::imageops::FilterType::Triangle);
        let e = edges(&look);
        let step = (((stw * sth) as f32 / search.cap as f32).sqrt().ceil() as u32).max(1);
        let mut pts = Vec::new();
        for y in (1..sth.saturating_sub(1)).step_by(step as usize) {
            for x in (1..stw.saturating_sub(1)).step_by(step as usize) {
                pts.push((x as i32, y as i32, e[(y * stw + x) as usize]));
            }
        }
        let n = pts.len().max(1) as f32;
        let mean = pts.iter().map(|p| p.2).sum::<f32>() / n;
        for p in pts.iter_mut() {
            p.2 -= mean;
        }
        let norm = pts.iter().map(|p| p.2 * p.2).sum::<f32>().sqrt();
        (norm > 0.0).then_some((pts, norm, stw, sth))
    };
    let ncc = |pts: &[(i32, i32, f32)], norm: f32, stw: u32, sth: u32, ox: i32, oy: i32| -> f32 {
        if ox < 0 || oy < 0 || ox as u32 + stw > ww || oy as u32 + sth > wh {
            return f32::MIN;
        }
        let (mut sum, mut sq, mut cov) = (0f32, 0f32, 0f32);
        // edge strength where the template has its edges and where it hasn't
        let (mut hi, mut nhi, mut lo, mut nlo) = (0f32, 0u32, 0f32, 0u32);
        for (x, y, v) in pts {
            let gv = g[((oy + y) as u32 * ww + (ox + x) as u32) as usize];
            sum += gv;
            sq += gv * gv;
            cov += v * gv;
            if *v > 0.0 {
                hi += gv;
                nhi += 1;
            } else {
                lo += gv;
                nlo += 1;
            }
        }
        let n = pts.len() as f32;
        let var = sq - sum * sum / n;
        if var <= 0.0 {
            return f32::MIN;
        }
        // the pattern alone isn't enough: on a near-flat area faint steps can line up by
        // chance, so the letters' edges have to really be there (a step of ~12 = full)
        let strength = (hi / nhi.max(1) as f32 - lo / nlo.max(1) as f32) / 12.0;
        cov / (norm * var.sqrt()) * strength.clamp(0.0, 1.0)
    };
    for (ci, (sc, px, py)) in cands.iter().enumerate() {
        for k in search.scales {
            let Some((pts, norm, stw, sth)) = points(sc * k * f) else { continue };
            let bx = (px * f - wx0 as f32).round() as i32;
            let by = (py * f - wy0 as f32).round() as i32;
            let (rx, ry) = (mx.ceil() as i32, my.ceil() as i32);
            let mut oy = -ry;
            while oy <= ry {
                let mut ox = -rx;
                while ox <= rx {
                    let v = ncc(&pts, norm, stw, sth, bx + ox, by + oy);
                    if v > best.0 {
                        best = (v, ci, *k, bx + ox, by + oy);
                    }
                    ox += search.coarse;
                }
                oy += search.coarse;
            }
        }
    }
    if best.0 == f32::MIN {
        return None;
    }
    // finer around the best one
    let (_, ci, k, bx, by) = best;
    let (sc, _, _) = cands[ci];
    let (pts, norm, stw, sth) = points(sc * k * f)?;
    for oy in -search.coarse..=search.coarse {
        for ox in -search.coarse..=search.coarse {
            let v = ncc(&pts, norm, stw, sth, bx + ox, by + oy);
            if v > best.0 {
                best = (v, ci, k, bx + ox, by + oy);
            }
        }
    }
    let (score, _, _, bx, by) = best;
    // the template's letters onto the picture at full size
    let scale = sc * k;
    let tx0 = (wx0 as f32 + bx as f32) / f;
    let ty0 = (wy0 as f32 + by as f32) / f;
    let mut mask = GrayImage::new(w, h);
    let x_end = ((tx0 + tw as f32 * scale).ceil().max(0.0) as u32).min(w);
    let y_end = ((ty0 + th as f32 * scale).ceil().max(0.0) as u32).min(h);
    for y in (ty0.max(0.0) as u32)..y_end {
        for x in (tx0.max(0.0) as u32)..x_end {
            let sx = ((x as f32 + 0.5 - tx0) / scale).floor();
            let sy = ((y as f32 + 0.5 - ty0) / scale).floor();
            if sx < 0.0 || sy < 0.0 || sx >= tw as f32 || sy >= th as f32 {
                continue;
            }
            if t.mask.get_pixel(sx as u32, sy as u32)[0] > 0 {
                mask.put_pixel(x, y, Luma([255]));
            }
        }
    }
    let mask = snap(img, &mask, f);
    Some(Placed { mask, score })
}

/// The laid-on template made to fit this picture's letters: from it, the mask grows into
/// pixels right next to it that are clearly stroke here (light or dark), up to ~8 % of the
/// letter height. A template a pixel or two off still takes the whole letters; on a busy
/// background it doesn't spread into it. f = the work copy's scale.
fn snap(img: &RgbaImage, mask: &GrayImage, f: f32) -> GrayImage {
    let Some((x0, y0, x1, y1)) = crate::edit::mask_bbox(mask) else { return mask.clone() };
    let (w, h) = img.dimensions();
    let lh = (y1 - y0 + 1) as f32;
    let m = (lh * 0.35).ceil() as u32 + 2;
    let (cx0, cy0) = (x0.saturating_sub(m), y0.saturating_sub(m));
    let (cx1, cy1) = ((x1 + m + 1).min(w), (y1 + m + 1).min(h));
    let (cw, ch) = (cx1 - cx0, cy1 - cy0);
    let (sw, sh) = (((cw as f32 * f).round() as u32).max(2), ((ch as f32 * f).round() as u32).max(2));
    let crop = image::imageops::crop_imm(img, cx0, cy0, cw, ch).to_image();
    let small = image::imageops::resize(&crop, sw, sh, image::imageops::FilterType::Triangle);
    let seed = image::imageops::resize(
        &image::imageops::crop_imm(mask, cx0, cy0, cw, ch).to_image(),
        sw,
        sh,
        image::imageops::FilterType::Nearest,
    );
    // stroke strength here, light and dark, each against its own level
    let mut halo = vec![0f32; (sw * sh) as usize];
    for light in [true, false] {
        let map = stroke_map(&small, light);
        let thr = stroke_threshold(&map, 1.0).max(1.0);
        for (hv, v) in halo.iter_mut().zip(&map) {
            *hv = hv.max(*v as f32 / thr);
        }
    }
    let mut on = vec![false; (sw * sh) as usize];
    let mut queue: std::collections::VecDeque<(u32, u32, u32)> = std::collections::VecDeque::new();
    for (x, y, p) in seed.enumerate_pixels() {
        if p[0] > 0 {
            on[(y * sw + x) as usize] = true;
            queue.push_back((x, y, 0));
        }
    }
    let reach = ((lh * f * 0.08).round() as u32).max(1);
    while let Some((x, y, d)) = queue.pop_front() {
        if d >= reach {
            continue;
        }
        for (dx, dy) in [(-1i32, 0i32), (1, 0), (0, -1), (0, 1), (-1, -1), (1, -1), (-1, 1), (1, 1)] {
            let (nx, ny) = (x as i32 + dx, y as i32 + dy);
            if nx < 0 || ny < 0 || nx >= sw as i32 || ny >= sh as i32 {
                continue;
            }
            let at = (ny as u32 * sw + nx as u32) as usize;
            if !on[at] && halo[at] > 0.6 {
                on[at] = true;
                queue.push_back((nx as u32, ny as u32, d + 1));
            }
        }
    }
    let mut out = mask.clone();
    for y in 0..ch {
        for x in 0..cw {
            let sx = (((x as f32 + 0.5) * f) as u32).min(sw - 1);
            let sy = (((y as f32 + 0.5) * f) as u32).min(sh - 1);
            if on[(sy * sw + sx) as usize] {
                out.put_pixel(cx0 + x, cy0 + y, Luma([255]));
            }
        }
    }
    crate::edit::dilate_mask(&out, 1)
}

/// A full-size mask as a find (its box and the mask cut to it).
pub fn hit_from_mask(full: &GrayImage) -> Option<Hit> {
    let (x0, y0, x1, y1) = crate::edit::mask_bbox(full)?;
    let mask = image::imageops::crop_imm(full, x0, y0, x1 - x0 + 1, y1 - y0 + 1).to_image();
    Some(Hit {
        region: Rect { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 },
        mask,
        bbox: (x0, y0, x1, y1),
        contrast: 0.0,
    })
}

/// The mask made whole before it's filled: gaps between the letters, the notches in its
/// ragged top and bottom edge and holes inside are closed (along the line further than
/// across it, like a brush drawn along the word), and where it nearly reaches the
/// picture's edge it's taken to the edge. Left open they keep bits of the old picture
/// that don't fit the new fill around them (specks).
fn tidy(mask: &GrayImage) -> GrayImage {
    let Some((x0, y0, x1, y1)) = crate::edit::mask_bbox(mask) else { return mask.clone() };
    let (w, h) = mask.dimensions();
    let lh = (y1 - y0 + 1) as f32;
    let r = ((lh * 0.08).round() as u32).clamp(2, 6);
    let rx = ((lh * 0.25).round() as u32).clamp(r, 24);
    let pad = rx + 2;
    let (cx0, cy0) = (x0.saturating_sub(pad), y0.saturating_sub(pad));
    let (cx1, cy1) = ((x1 + pad + 1).min(w), (y1 + pad + 1).min(h));
    let (cw, ch) = ((cx1 - cx0) as usize, (cy1 - cy0) as usize);
    let mut src = vec![0i32; cw * ch];
    for y in 0..ch {
        for x in 0..cw {
            src[y * cw + x] = (mask.get_pixel(cx0 + x as u32, cy0 + y as u32)[0] > 0) as i32;
        }
    }
    // closing: the gaps narrower than ~2rx along the line, ~2r across
    let (rx, ry) = (rx as usize, r as usize);
    let closed = min_max_rect(&min_max_rect(&src, cw, ch, rx, ry, false), cw, ch, rx, ry, true);
    // holes: what can't be reached from the crop's rim without crossing the mask
    let mut outside = vec![false; cw * ch];
    let mut stack: Vec<(usize, usize)> = Vec::new();
    for y in 0..ch {
        for x in 0..cw {
            if (x == 0 || y == 0 || x == cw - 1 || y == ch - 1) && closed[y * cw + x] == 0 {
                outside[y * cw + x] = true;
                stack.push((x, y));
            }
        }
    }
    while let Some((x, y)) = stack.pop() {
        for (dx, dy) in [(-1i32, 0i32), (1, 0), (0, -1), (0, 1)] {
            let (nx, ny) = (x as i32 + dx, y as i32 + dy);
            if nx < 0 || ny < 0 || nx >= cw as i32 || ny >= ch as i32 {
                continue;
            }
            let at = ny as usize * cw + nx as usize;
            if !outside[at] && closed[at] == 0 {
                outside[at] = true;
                stack.push((nx as usize, ny as usize));
            }
        }
    }
    let mut out = mask.clone();
    for y in 0..ch {
        for x in 0..cw {
            if closed[y * cw + x] > 0 || !outside[y * cw + x] {
                out.put_pixel(cx0 + x as u32, cy0 + y as u32, Luma([255]));
            }
        }
    }
    // up to the picture's edge where it's this close
    let near = r + 2;
    for y in cy0..cy1 {
        if let Some(x) = (w.saturating_sub(near)..w).find(|x| out.get_pixel(*x, y)[0] > 0) {
            (x..w).for_each(|x| out.put_pixel(x, y, Luma([255])));
        }
        if let Some(x) = (0..near.min(w)).rev().find(|x| out.get_pixel(*x, y)[0] > 0) {
            (0..=x).for_each(|x| out.put_pixel(x, y, Luma([255])));
        }
    }
    for x in cx0..cx1 {
        if let Some(y) = (h.saturating_sub(near)..h).find(|y| out.get_pixel(x, *y)[0] > 0) {
            (y..h).for_each(|y| out.put_pixel(x, y, Luma([255])));
        }
        if let Some(y) = (0..near.min(h)).rev().find(|y| out.get_pixel(x, *y)[0] > 0) {
            (0..=y).for_each(|y| out.put_pixel(x, y, Luma([255])));
        }
    }
    out
}

/// LaMa on a long thin mask in pieces along it: each piece gets a window LaMa sees at
/// (almost) full resolution, so the patch doesn't come out blurry. Each piece sees what
/// the last one filled. stop() is asked between pieces.
pub fn remove_in_pieces(
    app_data: &std::path::Path,
    img: &mut RgbaImage,
    mask: &GrayImage,
    stop: &dyn Fn() -> bool,
) -> Result<(), String> {
    let mask = &tidy(mask);
    let Some((x0, y0, x1, y1)) = crate::edit::mask_bbox(mask) else { return Ok(()) };
    let bh = y1 - y0 + 1;
    let piece = (bh * 4).max(170);
    let (w, h) = mask.dimensions();
    let mut px = x0;
    while px <= x1 {
        if stop() {
            return Err(crate::ai::STOPPED.into());
        }
        let end = (px + piece).min(x1 + 1);
        let mut part = GrayImage::new(w, h);
        let mut any = false;
        for y in y0..=y1.min(h - 1) {
            for x in px..end {
                if mask.get_pixel(x, y)[0] > 0 {
                    part.put_pixel(x, y, Luma([255]));
                    any = true;
                }
            }
        }
        if any {
            // the whole line stays hole in the window, only this piece is written
            crate::ai::inpaint_lama_part(app_data, img, mask, &part)?;
        }
        px = end;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A soft gradient with a few gentle shapes (no text).
    fn backdrop(w: u32, h: u32) -> RgbaImage {
        RgbaImage::from_fn(w, h, |x, y| {
            let v = 90 + (x * 60 / w) as u8 + (y * 40 / h) as u8;
            image::Rgba([v, v.saturating_sub(10), v.saturating_add(5), 255])
        })
    }

    /// Grey "letters" (2 px strokes, gaps between) in a row at (x, y), cap height ch.
    fn write_text(img: &mut RgbaImage, x: u32, y: u32, letters: u32, ch: u32) {
        for i in 0..letters {
            let lx = x + i * (ch * 7 / 10);
            // a letter: two upright strokes and a bar, like an "n" or "h"
            for yy in y..y + ch {
                for dx in 0..2 {
                    img.put_pixel(lx + dx, yy, image::Rgba([210, 210, 210, 255]));
                    img.put_pixel(lx + ch / 2 + dx, yy, image::Rgba([210, 210, 210, 255]));
                }
            }
            for xx in lx..lx + ch / 2 + 2 {
                for dy in 0..2 {
                    img.put_pixel(xx, y + dy, image::Rgba([210, 210, 210, 255]));
                }
            }
        }
    }

    /// Real watermark crops (WM_SAMPLES dir with samples.txt: "file x y w h" per line),
    /// each blown up 3x and set into the bottom right of a bigger picture; writes the
    /// corner with the mask in red to out/. Not part of the normal run.
    #[test]
    #[ignore]
    fn samples() {
        let Ok(dir) = std::env::var("WM_SAMPLES") else { return };
        let dir = std::path::PathBuf::from(dir);
        let list = std::fs::read_to_string(dir.join("samples.txt")).unwrap();
        for line in list.lines().filter(|l| !l.trim().is_empty()) {
            let p: Vec<&str> = line.split_whitespace().collect();
            let n = |i: usize| p[i].parse::<u32>().unwrap();
            let src = image::open(dir.join(p[0])).unwrap().to_rgba8();
            let strip = image::imageops::crop_imm(&src, n(1), n(2), n(3), n(4)).to_image();
            let (sw, sh) = (n(3) * 3, n(4) * 3);
            let big = image::imageops::resize(&strip, sw, sh, image::imageops::FilterType::CatmullRom);
            let cw = (sw as f32 / 0.42) as u32;
            let ch = cw * 2 / 3;
            let top = image::imageops::crop_imm(&strip, 0, 0, n(3), (n(4) / 4).max(2)).to_image();
            let small = image::imageops::resize(&top, (cw / 10).max(4), (ch / 10).max(4), image::imageops::FilterType::Triangle);
            let mut canvas = image::imageops::resize(&image::imageops::blur(&small, 1.5), cw, ch, image::imageops::FilterType::Triangle);
            let (px, py) = (cw - sw - cw / 50, ch - sh - ch / 40);
            image::imageops::overlay(&mut canvas, &big, px as i64, py as i64);
            let t0 = std::time::Instant::now();
            let hit = find_text(&canvas, Corner::BottomRight, 0.6);
            let dt = t0.elapsed();
            let mut view = canvas.clone();
            match &hit {
                Some(h) => {
                    let r = h.region;
                    for (x, y, m) in h.mask.enumerate_pixels() {
                        if m[0] > 0 {
                            let v = view.get_pixel_mut(r.x + x, r.y + y);
                            v[0] = ((v[0] as u32 + 255) / 2) as u8;
                            v[1] /= 2;
                            v[2] /= 2;
                        }
                    }
                    let on = h.mask.pixels().filter(|q| q[0] > 0).count();
                    eprintln!("{}: FOUND bbox {:?} mask {} px in {:?} (canvas {}x{})", p[0], h.bbox, on, dt, cw, ch);
                }
                None => eprintln!("{}: none in {:?} (canvas {}x{})", p[0], dt, cw, ch),
            }
            // the bottom part of the picture, where the text is
            let top = ch * 6 / 10;
            let view = image::imageops::crop_imm(&view, 0, top, cw, ch - top).to_image();
            // with WM_APPDATA (a folder with models/lama_fp32.onnx): the result too
            if let (Ok(ad), Some(hh)) = (std::env::var("WM_APPDATA"), &hit) {
                let mut full = GrayImage::new(cw, ch);
                for (x, y, m) in hh.mask.enumerate_pixels() {
                    if m[0] > 0 {
                        full.put_pixel(hh.region.x + x, hh.region.y + y, Luma([255]));
                    }
                }
                let mut out = canvas.clone();
                let t1 = std::time::Instant::now();
                match remove_in_pieces(std::path::Path::new(&ad), &mut out, &full, &|| false) {
                    Ok(()) => {
                        eprintln!("{}: LaMa {:?}", p[0], t1.elapsed());
                        let after = image::imageops::crop_imm(&out, 0, top, cw, ch - top).to_image();
                        after.save(dir.join("out").join(format!("after_{}", p[0]))).unwrap();
                    }
                    Err(e) => eprintln!("{}: LaMa failed: {e}", p[0]),
                }
            }
            view.save(dir.join("out").join(p[0])).unwrap();
        }
    }

    /// Template run over the samples (WM_SAMPLES as above, WM_TEMPLATE = the sample to take
    /// it from). The samples are laid out like one reward: 2400x1600, the name 900 px wide,
    /// its end 60 px from the right and 50 from the bottom; then searched like the app
    /// (NEAR). Scores printed, overlays to out/tpl_*, with WM_APPDATA also LaMa.
    #[test]
    #[ignore]
    fn samples_template() {
        let (Ok(dir), Ok(src)) = (std::env::var("WM_SAMPLES"), std::env::var("WM_TEMPLATE")) else { return };
        let dir = std::path::PathBuf::from(dir);
        let list = std::fs::read_to_string(dir.join("samples.txt")).unwrap();
        let all: Vec<(String, RgbaImage)> = list
            .lines()
            .filter(|l| !l.trim().is_empty())
            .filter_map(|line| {
                let p: Vec<&str> = line.split_whitespace().collect();
                let n = |i: usize| p[i].parse::<u32>().unwrap();
                let img = image::open(dir.join(p[0])).unwrap().to_rgba8();
                let strip = image::imageops::crop_imm(&img, n(1), n(2), n(3), n(4)).to_image();
                // find the name on a rough canvas first (3x, bottom right)
                let (sw, sh) = (n(3) * 3, n(4) * 3);
                let big = image::imageops::resize(&strip, sw, sh, image::imageops::FilterType::CatmullRom);
                let cw = (sw as f32 / 0.42) as u32;
                let ch = cw * 2 / 3;
                let top = image::imageops::crop_imm(&strip, 0, 0, n(3), (n(4) / 4).max(2)).to_image();
                let tiny = image::imageops::resize(&top, (cw / 10).max(4), (ch / 10).max(4), image::imageops::FilterType::Triangle);
                let mut rough = image::imageops::resize(&image::imageops::blur(&tiny, 1.5), cw, ch, image::imageops::FilterType::Triangle);
                let (ox, oy) = (cw - sw - cw / 50, ch - sh - ch / 40);
                image::imageops::overlay(&mut rough, &big, ox as i64, oy as i64);
                let hit = find_text(&rough, Corner::BottomRight, 0.6)?;
                let (x0, _, x1, y1) = hit.bbox;
                let (tx0, tx1, ty1) = ((x0 as f32 - ox as f32) / 3.0, (x1 as f32 - ox as f32) / 3.0, (y1 as f32 - oy as f32) / 3.0);
                // now like one reward
                let k = 900.0 / (tx1 - tx0).max(1.0);
                let (bw, bh) = ((n(3) as f32 * k) as u32, (n(4) as f32 * k) as u32);
                let big = image::imageops::resize(&strip, bw, bh, image::imageops::FilterType::CatmullRom);
                let tiny = image::imageops::resize(&top, 240, 160, image::imageops::FilterType::Triangle);
                let mut canvas = image::imageops::resize(&image::imageops::blur(&tiny, 1.5), 2400, 1600, image::imageops::FilterType::Triangle);
                let px = 2400.0 - 60.0 - tx1 * k;
                let py = 1600.0 - 50.0 - ty1 * k;
                image::imageops::overlay(&mut canvas, &big, px as i64, py as i64);
                Some((p[0].to_string(), canvas))
            })
            .collect();
        let (_, tsrc) = all.iter().find(|(n, _)| *n == src).expect("template sample");
        let hit = find_text(tsrc, Corner::BottomRight, 0.6).expect("template found");
        let t = Template::from_hit(&hit, tsrc, Corner::BottomRight);
        eprintln!("template from {:?} size {:?}", hit.bbox, t.mask.dimensions());
        for (name, canvas) in &all {
            let t0 = std::time::Instant::now();
            let Some(pl) = place(canvas, &t, &NEAR) else {
                eprintln!("{name}: not placed");
                continue;
            };
            eprintln!("{name}: score {:.2} bbox {:?} in {:?}", pl.score, crate::edit::mask_bbox(&pl.mask), t0.elapsed());
            let (cw, ch) = canvas.dimensions();
            let top = ch * 6 / 10;
            let mut view = canvas.clone();
            for (x, y, m) in pl.mask.enumerate_pixels() {
                if m[0] > 0 {
                    let v = view.get_pixel_mut(x, y);
                    v[0] = ((v[0] as u32 + 255) / 2) as u8;
                    v[1] /= 2;
                    v[2] /= 2;
                }
            }
            image::imageops::crop_imm(&view, 0, top, cw, ch - top).to_image().save(dir.join("out").join(format!("tpl_{name}"))).unwrap();
            if let Ok(ad) = std::env::var("WM_APPDATA") {
                let mut out = canvas.clone();
                if remove_in_pieces(std::path::Path::new(&ad), &mut out, &pl.mask, &|| false).is_ok() {
                    image::imageops::crop_imm(&out, 0, top, cw, ch - top)
                        .to_image()
                        .save(dir.join("out").join(format!("tpl_after_{name}")))
                        .unwrap();
                }
            }
        }
        // a picture without the watermark (the top of one, no text there)
        let (_, c) = &all[0];
        let blank = image::imageops::resize(&image::imageops::crop_imm(c, 0, 0, c.width(), c.height() / 3).to_image(), c.width(), c.height(), image::imageops::FilterType::Triangle);
        eprintln!("blank: score {:?}", place(&blank, &t, &NEAR).map(|p| p.score));
    }

    /// A whole reward like the app does it: WM_REAL = a folder with the pictures in
    /// `orig/`; prints per picture which template fits how well, overlays (bottom right)
    /// to `out/`, with WM_APPDATA also LaMa.
    #[test]
    #[ignore]
    fn real_reward() {
        let Ok(dir) = std::env::var("WM_REAL") else { return };
        let dir = std::path::PathBuf::from(dir);
        let mut names: Vec<String> = std::fs::read_dir(dir.join("orig"))
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        if let Ok(only) = std::env::var("WM_ONLY") {
            names.retain(|n| only.split(',').any(|o| n.starts_with(o)));
        }
        let load = |n: &str| image::open(dir.join("orig").join(n)).unwrap().to_rgba8();
        let t0 = std::time::Instant::now();
        let finds: Vec<((u32, u32), Option<Hit>)> = names
            .iter()
            .map(|n| {
                let img = load(n);
                (img.dimensions(), find_text(&img, Corner::BottomRight, 0.6))
            })
            .collect();
        eprintln!("scan {:?}", t0.elapsed());
        for (n, (_, f)) in names.iter().zip(&finds) {
            if let Some(f) = f {
                eprintln!("  find {n}: box {:?} contrast {:.2}", f.bbox, f.contrast);
            }
        }
        let refs: Vec<((u32, u32), Option<&Hit>)> = finds.iter().map(|(s, h)| (*s, h.as_ref())).collect();
        let sources = template_sources(&refs);
        let templates: Vec<Template> = sources
            .iter()
            .map(|i| Template::from_hit(finds[*i].1.as_ref().unwrap(), &load(&names[*i]), Corner::BottomRight))
            .collect();
        for (i, t) in sources.iter().zip(&templates) {
            eprintln!("template from {} ({}x{}) box {:?}", names[*i], t.w, t.h, t.mask.dimensions());
        }
        std::fs::create_dir_all(dir.join("out")).unwrap();
        for (k, n) in names.iter().enumerate() {
            let img = load(n);
            let t1 = std::time::Instant::now();
            let best = place_best(&img, &templates);
            let took = t1.elapsed();
            let own = finds[k].1.is_some();
            let Some((pl, ti)) = best else {
                eprintln!("{n}: nothing (own {own})");
                continue;
            };
            eprintln!("{n}: template {ti} score {:.2} own {own} box {:?} {:?}", pl.score, crate::edit::mask_bbox(&pl.mask), took);
            let (w, h) = img.dimensions();
            let (cx, cy) = (w.saturating_sub(1000), h.saturating_sub(260));
            let mut view = img.clone();
            for (x, y, m) in pl.mask.enumerate_pixels() {
                if m[0] > 0 {
                    let v = view.get_pixel_mut(x, y);
                    v[0] = ((v[0] as u32 + 255) / 2) as u8;
                    v[1] /= 2;
                    v[2] /= 2;
                }
            }
            image::imageops::crop_imm(&view, cx, cy, w - cx, h - cy).to_image().save(dir.join("out").join(format!("{n}.png"))).unwrap();
            if let Ok(ad) = std::env::var("WM_APPDATA") {
                if pl.score >= PLACE_MIN {
                    let mut out = img.clone();
                    if remove_in_pieces(std::path::Path::new(&ad), &mut out, &pl.mask, &|| false).is_ok() {
                        image::imageops::crop_imm(&out, cx, cy, w - cx, h - cy)
                            .to_image()
                            .save(dir.join("out").join(format!("after_{n}.png")))
                            .unwrap();
                    }
                }
            }
        }
    }

    #[test]
    fn a_line_of_text_in_the_corner_is_found() {
        let mut img = backdrop(1200, 800);
        write_text(&mut img, 940, 750, 14, 16);
        let hit = find_text(&img, Corner::BottomRight, 0.6).expect("text found");
        let (x0, y0, x1, y1) = hit.bbox;
        assert!(x0 >= 930 && x0 <= 945, "x0 {x0}");
        assert!(y0 >= 744 && y0 <= 752, "y0 {y0}");
        assert!(x1 >= 1090 && y1 <= 770, "x1 {x1} y1 {y1}");
        // close to the letters, not the whole corner (14 letters of ~3 strokes)
        let on = hit.mask.pixels().filter(|p| p[0] > 0).count();
        assert!(on < 14 * 3 * 16 * 2 * 4, "mask too big: {on}");
    }

    /// Busy, grainy background (like a photo) with half see-through grey text over it.
    #[test]
    fn faint_text_on_a_busy_background_is_found_fast() {
        let (w, h) = (4000u32, 3000u32);
        let mut seed = 7u32;
        let mut rnd = move || {
            seed ^= seed << 13;
            seed ^= seed >> 17;
            seed ^= seed << 5;
            seed
        };
        let mut img = RgbaImage::from_fn(w, h, |x, y| {
            let base = 60 + ((x / 40 + y / 55) % 5) as u8 * 18;
            image::Rgba([base, base / 2 + 30, base / 3 + 40, 255])
        });
        for p in img.pixels_mut() {
            let n = (rnd() % 21) as i32 - 10;
            for c in 0..3 {
                p[c] = (p[c] as i32 + n).clamp(0, 255) as u8;
            }
        }
        // the text, 50 % grey over it
        let mut text = RgbaImage::new(w, h);
        write_text(&mut text, 3300, 2880, 20, 42);
        for (x, y, t) in text.enumerate_pixels() {
            if t[3] > 0 {
                let p = img.get_pixel_mut(x, y);
                for c in 0..3 {
                    p[c] = ((p[c] as u32 + 200) / 2) as u8;
                }
            }
        }
        let t0 = std::time::Instant::now();
        let hit = find_text(&img, Corner::BottomRight, 0.6).expect("faint text found");
        eprintln!("find_text 4000x3000: {:?}", t0.elapsed());
        // every stroke is covered ...
        let full = crate::edit::dilate_mask(
            &GrayImage::from_fn(w, h, |x, y| Luma([if text.get_pixel(x, y)[3] > 0 { 255 } else { 0 }])),
            1,
        );
        let r = hit.region;
        let covered = |x: u32, y: u32| {
            x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h && hit.mask.get_pixel(x - r.x, y - r.y)[0] > 0
        };
        let missed = full.enumerate_pixels().filter(|(x, y, p)| p[0] > 0 && !covered(*x, *y)).count();
        assert_eq!(missed, 0, "strokes left over");
        // ... and the mask stays in the line (the grain inside the line's box may go
        // with it, nothing outside it)
        let (tx0, ty0, tx1, ty1) = (3300i64, 2880i64, 3873i64, 2921i64);
        // the line box: a bit above and below the letters (tails, soft edge, closed over)
        let m = 64i64;
        let outside = hit
            .mask
            .enumerate_pixels()
            .filter(|(x, y, p)| {
                let (gx, gy) = (r.x as i64 + *x as i64, r.y as i64 + *y as i64);
                p[0] > 0 && (gx < tx0 - m || gx > tx1 + m || gy < ty0 - m || gy > ty1 + m)
            })
            .count();
        assert_eq!(outside, 0, "mask outside the line, bbox {:?}", hit.bbox);
    }


    /// The watermark found on one picture is laid onto another of a different size (it
    /// grows with the width) at the right place; on a picture without it, it doesn't fit.
    #[test]
    fn the_template_fits_the_same_watermark_on_another_picture_only() {
        let mut a = backdrop(1200, 800);
        write_text(&mut a, 940, 750, 14, 16);
        let hit = find_text(&a, Corner::BottomRight, 0.6).expect("found");
        let t = Template::from_hit(&hit, &a, Corner::BottomRight);
        // the same, 1.5x bigger, a little off (exports aren't pixel exact)
        let mut b = backdrop(1800, 1200);
        write_text(&mut b, 1414, 1127, 14, 24);
        let p = place(&b, &t, &NEAR).expect("placed");
        let (x0, y0, x1, y1) = crate::edit::mask_bbox(&p.mask).unwrap();
        assert!(p.score >= PLACE_MIN, "score {}", p.score);
        assert!((1395..=1435).contains(&x0) && (1110..=1135).contains(&y0), "{:?}", (x0, y0, x1, y1));
        assert!(x1 >= 1630, "{:?}", (x0, y0, x1, y1));
        // a picture without it
        let c = backdrop(1800, 1200);
        let q = place(&c, &t, &NEAR).map(|q| q.score).unwrap_or(0.0);
        assert!(q < PLACE_MIN, "fits where there's nothing: {q}");
    }

    #[test]
    fn tidy_closes_gaps_and_holes_and_reaches_the_edge() {
        let mut m = GrayImage::new(200, 100);
        // two strokes 4 px apart, a ring with a hole, the last one 3 px off the right edge
        // (line height 30: closes up to ~15 px along the line)
        for y in 60..90 {
            for x in 100..110 {
                m.put_pixel(x, y, Luma([255]));
            }
            for x in 114..124 {
                m.put_pixel(x, y, Luma([255]));
            }
            for x in 150..197 {
                if !(y > 66 && y < 84 && x > 160 && x < 186) {
                    m.put_pixel(x, y, Luma([255]));
                }
            }
        }
        let t = tidy(&m);
        assert!(t.get_pixel(112, 75)[0] > 0, "gap closed");
        assert!(t.get_pixel(170, 75)[0] > 0, "hole filled");
        assert!(t.get_pixel(199, 75)[0] > 0, "to the edge");
        assert_eq!(t.get_pixel(60, 75)[0], 0, "nothing far off");
        assert_eq!(t.get_pixel(137, 75)[0], 0, "a wide gap stays");
        assert_eq!(t.get_pixel(150, 40)[0], 0, "nothing above");
    }

    #[test]
    fn a_solid_blob_in_the_corner_is_not_text() {
        let mut img = backdrop(1200, 800);
        // a hand-like blob: round, solid, no edges inside
        for y in 700..790 {
            for x in 980..1120 {
                let dx = x as f32 - 1050.0;
                let dy = y as f32 - 745.0;
                if dx * dx / 4900.0 + dy * dy / 2025.0 <= 1.0 {
                    img.put_pixel(x, y, image::Rgba([220, 170, 150, 255]));
                }
            }
        }
        assert!(find_text(&img, Corner::BottomRight, 0.6).is_none());
    }

}
