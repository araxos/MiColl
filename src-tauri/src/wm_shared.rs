//! A line of text at the very same place on all pictures of one size, taken out of all of
//! them at once: what they have in common there is the text, however faint it is and
//! however busy each picture is (skin, lace, grass).
//!
//! Only the fine detail is looked at (the picture minus its blurred self). Where a text of
//! opacity a and one colour lies, that's a * (colour - background) on every picture, and
//! nothing in particular where there's none. So a comes out of all pictures at each place.

use image::{imageops, GrayImage, Luma, RgbaImage};

use crate::watermark::{self, components, Corner, Hit, Rect, Template, Tried};
use crate::wm_motif::blur;

/// From this many pictures of one size on.
const MIN_PICTURES: usize = 4;
/// The long side of the copy the bands are cut from.
const EDGE: f32 = 1600.0;
/// A band's height (share of the long side).
const BAND: f32 = 0.085;
/// A picture has the text when its detail goes with it at least this much (agrees).
pub const THERE: f32 = 0.22;

/// The top or bottom edge of a picture, scaled down: its fine detail and what's behind it.
pub struct Band {
    size: (u32, u32),
    top: bool,
    w: usize,
    h: usize,
    /// Detail and background, per channel.
    fine: Vec<[f32; 3]>,
    back: Vec<[f32; 3]>,
    /// How much each place counts (less on busy parts).
    weight: Vec<f32>,
}

impl Band {
    pub fn is_top(&self) -> bool {
        self.top
    }
}

pub fn is_top(corner: Corner) -> bool {
    matches!(corner, Corner::TopLeft | Corner::TopRight)
}

/// None when the picture is too small to have one.
pub fn band(img: &RgbaImage, top: bool) -> Option<Band> {
    let (iw, ih) = img.dimensions();
    if iw < 160 || ih < 160 {
        return None;
    }
    let long = iw.max(ih) as f32;
    let f = (EDGE / long).min(1.0);
    let bh = ((long * BAND) as u32).min(ih / 2);
    let cut = imageops::crop_imm(img, 0, if top { 0 } else { ih - bh }, iw, bh).to_image();
    let (w, h) = (((iw as f32 * f).round() as u32).max(1), ((bh as f32 * f).round() as u32).max(1));
    let small = if f < 1.0 { imageops::resize(&cut, w, h, imageops::FilterType::Triangle) } else { cut };
    let (w, h) = (small.width() as usize, small.height() as usize);
    let n = w * h;
    let sigma = (long * f * 0.006).max(2.0);
    // (no darker at the rim: divided by what's there)
    let ones = blur(&vec![1.0; n], w, h, sigma);
    let mut fine = vec![[0f32; 3]; n];
    let mut back = vec![[0f32; 3]; n];
    let mut power = vec![0f32; n];
    for c in 0..3 {
        let v: Vec<f32> = small.pixels().map(|p| p[c] as f32).collect();
        let b = blur(&v, w, h, sigma);
        for i in 0..n {
            back[i][c] = b[i] / ones[i].max(1e-3);
            fine[i][c] = (v[i] - back[i][c]).clamp(-60.0, 60.0);
            power[i] += fine[i][c] * fine[i][c] / 3.0;
        }
    }
    let busy = blur(&power, w, h, sigma * 1.5);
    let weight = (0..n).map(|i| 1.0 / (busy[i] / ones[i].max(1e-3) + 16.0)).collect();
    Some(Band { size: (iw, ih), top, w, h, fine, back, weight })
}

/// The text all pictures of one size share.
pub struct Shared {
    pub size: (u32, u32),
    /// Its letters, to lay onto pictures of other sizes too.
    pub template: Template,
    corner: Corner,
    /// On the band: its box, its opacity, its colour.
    area: (usize, usize, usize, usize),
    a: Vec<f32>,
    w: usize,
    colour: [f32; 3],
}

/// The texts in a corner, one per picture size that has enough pictures.
pub fn shared(bands: &[&Band], corner: Corner) -> Vec<Shared> {
    let mut sizes: Vec<((u32, u32), usize)> = Vec::new();
    for b in bands.iter().filter(|b| b.top == is_top(corner)) {
        match sizes.iter_mut().find(|s| s.0 == b.size) {
            Some(s) => s.1 += 1,
            None => sizes.push((b.size, 1)),
        }
    }
    sizes.sort_by(|a, b| b.1.cmp(&a.1));
    sizes
        .into_iter()
        .filter(|s| s.1 >= MIN_PICTURES)
        .filter_map(|(size, _)| {
            let group: Vec<&Band> =
                bands.iter().copied().filter(|b| b.size == size && b.top == is_top(corner)).take(60).collect();
            one_size(&group, corner)
        })
        .collect()
}

fn one_size(group: &[&Band], corner: Corner) -> Option<Shared> {
    let (w, h) = (group[0].w, group[0].h);
    let n = w * h;
    // per place over all pictures: the detail against the background (its slope is -a)
    let mut s0 = vec![0f32; n];
    let mut sb = vec![[0f32; 3]; n];
    let mut sf = vec![[0f32; 3]; n];
    let mut sbb = vec![[0f32; 3]; n];
    let mut sbf = vec![[0f32; 3]; n];
    for g in group {
        for i in 0..n {
            let k = g.weight[i];
            s0[i] += k;
            for c in 0..3 {
                let (b, f) = (g.back[i][c], g.fine[i][c]);
                sb[i][c] += k * b;
                sf[i][c] += k * f;
                sbb[i][c] += k * b * b;
                sbf[i][c] += k * b * f;
            }
        }
    }
    // a at each place for a text of one colour
    let with = |colour: [f32; 3]| -> (Vec<f32>, f64) {
        let mut a = vec![0f32; n];
        let mut power: Vec<f32> = vec![0.0; n];
        for i in 0..n {
            let (mut xf, mut xx) = (0f32, 0f32);
            for c in 0..3 {
                let k = colour[c];
                xf += k * sf[i][c] - sbf[i][c];
                xx += k * k * s0[i] - 2.0 * k * sb[i][c] + sbb[i][c];
            }
            // (no say where the background has the text's colour on all of them)
            a[i] = xf / (xx + 60.0 * s0[i]);
            if a[i] > 0.0 {
                power[i] = xf * a[i];
            }
        }
        let mut p = power;
        let k = n - (n / 60).max(1);
        p.select_nth_unstable_by(k, |a, b| a.total_cmp(b));
        (a, p[k..].iter().map(|v| *v as f64).sum())
    };
    // its colour: from the places that go against the background most
    let slope: Vec<f32> = (0..n)
        .map(|i| {
            let (mut cov, mut var) = (0f32, 0f32);
            for c in 0..3 {
                cov += sbf[i][c] - sb[i][c] * sf[i][c] / s0[i].max(1e-9);
                var += sbb[i][c] - sb[i][c] * sb[i][c] / s0[i].max(1e-9);
            }
            -cov / (var + 60.0 * s0[i] + 1e-9)
        })
        .collect();
    let mut order: Vec<usize> = (0..n).collect();
    let top = (n / 80).max(20);
    order.select_nth_unstable_by(n - top, |a, b| slope[*a].total_cmp(&slope[*b]));
    let best = &order[n - top..];
    let middle = |c: usize| -> f32 {
        let mut v: Vec<f32> =
            best.iter().map(|i| (sf[*i][c] / s0[*i].max(1e-9) + slope[*i] * sb[*i][c] / s0[*i].max(1e-9)) / slope[*i].max(0.03)).collect();
        v.sort_by(|a, b| a.total_cmp(b));
        v[v.len() / 2].clamp(0.0, 255.0)
    };
    let own = [middle(0), middle(1), middle(2)];
    let (colour, a) = [own, [0.0; 3], [128.0; 3], [255.0; 3]]
        .into_iter()
        .map(|c| (c, with(c)))
        .max_by(|x, y| x.1 .1.total_cmp(&y.1 .1))
        .map(|(c, (a, _))| (c, a))?;

    // the line of text in the corner
    let mut sorted = a.clone();
    let k = n - (n / 150).max(1);
    sorted.select_nth_unstable_by(k, |x, y| x.total_cmp(y));
    let peak = sorted[k];
    let mut low: Vec<f32> = a.iter().map(|v| v.abs()).collect();
    low.select_nth_unstable_by(n / 2, |x, y| x.total_cmp(y));
    let noise = low[n / 2] * 1.48;
    if peak < 0.05 || peak < 4.0 * noise {
        return None;
    }
    let on = GrayImage::from_fn(w as u32, h as u32, |x, y| Luma([if a[y as usize * w + x as usize] > 0.4 * peak { 255 } else { 0 }]));
    let (labels, comps) = components(&on);
    let all: Vec<usize> = (0..comps.len()).filter(|c| comps[*c].area >= 6).collect();
    let (rx0, rx1) = match corner {
        Corner::TopLeft | Corner::BottomLeft => (0, w * 3 / 10),
        Corner::TopRight | Corner::BottomRight => (w * 7 / 10, w),
        Corner::BottomCenter => (w * 3 / 10, w * 7 / 10),
    };
    let inside: Vec<usize> =
        all.iter().copied().filter(|c| (comps[*c].x0 as usize) < rx1 && comps[*c].x1 as usize >= rx0).collect();
    // the row most of it is in, and the letters' height there
    let total: u64 = inside.iter().map(|c| comps[*c].area as u64).sum();
    if total == 0 {
        return None;
    }
    let mut mids: Vec<(f32, u64)> = inside
        .iter()
        .map(|c| ((comps[*c].y0 + comps[*c].y1) as f32 / 2.0, comps[*c].area as u64))
        .collect();
    mids.sort_by(|a, b| a.0.total_cmp(&b.0));
    let mut sum = 0u64;
    let row = mids.iter().find(|(_, s)| {
        sum += s;
        sum * 2 >= total
    })?.0;
    let mut tall: Vec<u32> = inside
        .iter()
        .filter(|c| {
            let c = &comps[**c];
            (c.y0 as f32) <= row && (c.y1 as f32) >= row
        })
        .map(|c| comps[*c].y1 - comps[*c].y0 + 1)
        .collect();
    tall.sort();
    let lh = *tall.get(tall.len() * 4 / 5)? as f32;
    if lh < 5.0 || lh > h as f32 * 0.7 {
        return None;
    }
    let in_row = |c: usize| {
        let q = &comps[c];
        let mid = (q.y0 + q.y1) as f32 / 2.0;
        (mid - row).abs() < lh * 0.75 && ((q.y1 - q.y0 + 1) as f32) < lh * 1.7
    };
    let mut line: Vec<usize> = inside.iter().copied().filter(|c| in_row(*c)).collect();
    if line.is_empty() {
        return None;
    }
    // from there along the row, over gaps between words
    loop {
        let x0 = line.iter().map(|c| comps[*c].x0).min()? as f32;
        let x1 = line.iter().map(|c| comps[*c].x1).max()? as f32;
        let more: Vec<usize> = all
            .iter()
            .copied()
            .filter(|c| {
                !line.contains(c)
                    && in_row(*c)
                    && (comps[*c].x0 as f32) < x1 + lh * 1.4
                    && (comps[*c].x1 as f32) > x0 - lh * 1.4
            })
            .collect();
        if more.is_empty() {
            break;
        }
        line.extend(more);
    }
    let x0 = line.iter().map(|c| comps[*c].x0).min()? as usize;
    let x1 = line.iter().map(|c| comps[*c].x1).max()? as usize;
    let y0 = line.iter().map(|c| comps[*c].y0).min()? as usize;
    let y1 = line.iter().map(|c| comps[*c].y1).max()? as usize;
    // it has to look like a word: several letters, wider than high
    if line.len() < 4 || ((x1 - x0) as f32) < lh * 2.5 {
        return None;
    }
    // its letters with their soft edge
    let mut take = vec![false; n];
    for i in 0..n {
        take[i] = labels[i] > 0 && line.contains(&(labels[i] as usize - 1));
    }
    let grown = crate::wm_motif::morph(&take, w, h, 2, false);
    let letters: Vec<bool> = (0..n).map(|i| take[i] || (grown[i] && a[i] > 0.15 * peak)).collect();
    let pad = (lh * 0.35) as usize + 2;
    let area = (x0.saturating_sub(pad), y0.saturating_sub(pad), (x1 + pad).min(w - 1), (y1 + pad).min(h - 1));

    // as a template, full size
    let (iw, ih) = group[0].size;
    let f = w as f32 / iw as f32;
    let (bw, bh) = (area.2 - area.0 + 1, area.3 - area.1 + 1);
    let (fw, fh) = (((bw as f32 / f).round() as u32).max(1), ((bh as f32 / f).round() as u32).max(1));
    let cut = GrayImage::from_fn(bw as u32, bh as u32, |x, y| {
        let i = (area.1 + y as usize) * w + area.0 + x as usize;
        Luma([if letters[i] { 255 } else { 0 }])
    });
    let mut mask = imageops::resize(&cut, fw, fh, imageops::FilterType::Triangle);
    for p in mask.pixels_mut() {
        p[0] = if p[0] > 100 { 255 } else { 0 };
    }
    let mask = crate::edit::dilate_mask(&mask, ((lh / f * 0.05).round() as i32).clamp(1, 5));
    let soft = GrayImage::from_fn(bw as u32, bh as u32, |x, y| {
        let i = (area.1 + y as usize) * w + area.0 + x as usize;
        Luma([if grown[i] { (a[i] / peak * 200.0).clamp(0.0, 200.0) as u8 } else { 0 }])
    });
    let look = image::DynamicImage::ImageLuma8(imageops::resize(&soft, fw, fh, imageops::FilterType::Triangle)).to_rgba8();
    let band_y = if is_top(corner) { 0.0 } else { ih as f32 - h as f32 / f };
    let x0f = ((area.0 as f32 / f).round() as u32).min(iw.saturating_sub(1));
    let y0f = ((band_y + area.1 as f32 / f).round().max(0.0) as u32).min(ih.saturating_sub(1));
    let a: Vec<f32> = (0..n).map(|i| if grown[i] { a[i].max(0.0) } else { 0.0 }).collect();
    Some(Shared {
        size: (iw, ih),
        template: Template { corner, w: iw, h: ih, x0: x0f, y0: y0f, mask, look },
        corner,
        area,
        a,
        w,
        colour,
    })
}

impl Shared {
    /// How much a picture's detail goes with the text (correlation, 1 = the same). None
    /// when the background there has its colour: then it can't be seen, nor told.
    pub fn agrees(&self, b: &Band) -> Option<f32> {
        if b.size != self.size || b.top != is_top(self.corner) || b.w != self.w {
            return None;
        }
        let (x0, y0, x1, y1) = self.area;
        let (mut so, mut sp, mut sop, mut n) = (0f64, 0f64, 0f64, 0f64);
        for y in y0..=y1 {
            for x in x0..=x1 {
                let i = y * b.w + x;
                let k = b.weight[i] as f64;
                for c in 0..3 {
                    let o = b.fine[i][c] as f64;
                    let p = (self.a[i] * (self.colour[c] - b.back[i][c])) as f64;
                    so += k * o * o;
                    sp += k * p * p;
                    sop += k * o * p;
                    n += p.abs();
                }
            }
        }
        let many = ((x1 - x0 + 1) * (y1 - y0 + 1) * 3) as f64;
        if n / many < 0.35 || sp <= 0.0 || so <= 0.0 {
            return None;
        }
        Some((sop / (so * sp).sqrt()) as f32)
    }

    /// Its letters on a picture of this size.
    pub fn hit(&self) -> Option<Hit> {
        let t = &self.template;
        let (w, h) = (t.mask.width().min(t.w - t.x0), t.mask.height().min(t.h - t.y0));
        if w == 0 || h == 0 {
            return None;
        }
        let mask = imageops::crop_imm(&t.mask, 0, 0, w, h).to_image();
        let (bx0, by0, bx1, by1) = crate::edit::mask_bbox(&mask)?;
        Some(Hit {
            mask,
            region: Rect { x: t.x0, y: t.y0, w, h },
            bbox: (t.x0 + bx0, t.y0 + by0, t.x0 + bx1, t.y0 + by1),
            contrast: 0.0,
        })
    }
}

/// One corner: the text all pictures of a size share, where there is one.
pub struct Corners {
    pub shared: Vec<Shared>,
    templates: Vec<Template>,
}

impl Corners {
    /// None when no size has enough pictures, or they share no text.
    pub fn of(bands: &[&Band], corner: Corner) -> Option<Corners> {
        let shared = shared(bands, corner);
        let templates = shared.iter().map(|s| s.template.clone()).collect();
        (!shared.is_empty()).then_some(Corners { shared, templates })
    }

    /// What comes off a picture: right there on its own size, else where its letters fit.
    pub fn try_on(&self, img: &RgbaImage, b: Option<&Band>) -> Tried {
        match self.shared.iter().find(|s| s.size == img.dimensions()) {
            Some(s) => {
                let there = b.and_then(|b| s.agrees(b)).is_some_and(|v| v >= THERE);
                if there {
                    Tried { fit: s.hit(), reserve: None }
                } else {
                    Tried { fit: None, reserve: s.hit() }
                }
            }
            None => watermark::try_templates(img, &self.templates),
        }
    }

    /// Is there a text all pictures of this size share?
    pub fn knows(&self, size: (u32, u32)) -> bool {
        self.shared.iter().any(|s| s.size == size)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A grey, see-through line of "letters" near the bottom right.
    fn letter(x: i32, y: i32) -> bool {
        // 14 letters, no two alike, 22 px high, strokes of 5 px
        let (gx, k) = ((x - 700).rem_euclid(34), (x - 700).div_euclid(34));
        if !(0..14).contains(&k) || !(0..22).contains(&y) || gx >= 22 {
            return false;
        }
        match k % 5 {
            0 => gx < 5 || (gx >= 17) || y < 5,
            1 => gx < 5 || y >= 17,
            2 => (gx - 11).abs() < 3 || y < 5,
            3 => gx < 5 || y < 5 || y >= 17 || (8..13).contains(&y),
            _ => gx >= 17 || (gx - y).abs() < 4,
        }
    }

    fn picture(seed: u32, text: bool) -> RgbaImage {
        let base = [[190i32, 120, 110], [60, 70, 90], [220, 210, 200], [120, 125, 130], [30, 25, 40], [160, 150, 60], [90, 140, 100], [200, 80, 90]]
            [seed as usize % 8];
        RgbaImage::from_fn(1200, 800, |x, y| {
            let n = (x.wrapping_mul(73_856_093) ^ y.wrapping_mul(19_349_663) ^ (seed * 7717)).wrapping_mul(2_654_435_761) >> 26;
            // lace: a pattern of its own on every picture
            let lace = if ((x + seed * 13) / (7 + seed % 4) + (y + seed * 5) / 6) % 3 == 0 { 20 } else { 0 };
            let mut p = [0f32; 3];
            for c in 0..3 {
                p[c] = (base[c] + lace + n as i32 / 2 + x as i32 * 20 / 1200) as f32;
            }
            if text && letter(x as i32, y as i32 - 748) {
                for v in p.iter_mut() {
                    *v = *v * 0.55 + 128.0 * 0.45;
                }
            }
            image::Rgba([p[0].clamp(0.0, 255.0) as u8, p[1].clamp(0.0, 255.0) as u8, p[2].clamp(0.0, 255.0) as u8, 255])
        })
    }

    #[test]
    fn a_faint_text_on_busy_pictures_comes_out_of_all_of_them() {
        let bands: Vec<Band> = (0..8).map(|k| band(&picture(k, true), false).unwrap()).collect();
        let list: Vec<&Band> = bands.iter().collect();
        assert!(shared(&list[..3], Corner::BottomRight).is_empty(), "three pictures say nothing");
        let got = shared(&list, Corner::BottomRight);
        assert_eq!(got.len(), 1);
        let hit = got[0].hit().unwrap();
        let (mut all, mut on, mut wrong, mut size) = (0u32, 0u32, 0u32, 0u32);
        for y in 700..800u32 {
            for x in 0..1200u32 {
                let is = letter(x as i32, y as i32 - 748);
                let r = &hit.region;
                let m = x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h && hit.mask.get_pixel(x - r.x, y - r.y)[0] > 0;
                all += is as u32;
                on += (is && m) as u32;
                size += m as u32;
                let near = (-5..=5).any(|dy| (-5..=5).any(|dx| letter(x as i32 + dx, y as i32 - 748 + dy)));
                wrong += (m && !near) as u32;
            }
        }
        assert!(on as f32 > 0.97 * all as f32, "{on} of {all}");
        assert!((wrong as f32) < 0.03 * size as f32, "{wrong} of {size} isn't text");
        // told from a picture without it
        for b in &bands {
            if let Some(v) = got[0].agrees(b) {
                assert!(v > THERE, "{v}");
            }
        }
        for k in [1u32, 4, 9] {
            let v = got[0].agrees(&band(&picture(k, false), false).unwrap()).unwrap_or(0.0);
            assert!(v < THERE, "without: {v}");
        }
        // not in the other corner, and nothing where there's no text at all
        assert!(shared(&list, Corner::BottomLeft).is_empty());
        let plain: Vec<Band> = (0..8).map(|k| band(&picture(k, false), false).unwrap()).collect();
        assert!(shared(&plain.iter().collect::<Vec<_>>(), Corner::BottomRight).is_empty());
    }
}
