//! What a mark does to the pixels around it, learned from all pictures it was found on:
//! how opaque it is at every place and in which colour. That covers drop shadows, glows,
//! soft edges and letters the framing missed, without knowing any of them beforehand.
//!
//! The pictures' parts with the mark are laid on top of each other (a canvas). At a place
//! the mark doesn't touch, a picture shows its own background; under an opaque letter all
//! of them show the same colour; under a shadow in between. The background itself is
//! taken from around the mark, smooth. From "shown = (1 - a) * background + a * colour"
//! over all pictures come a and the colour (solve). On pictures with a busy background
//! that's noisy for faint layers: a few blurred, shifted copies of the mark's colours are
//! fitted over all places at once (fit), and each place is trusted as far as its own
//! pictures go.
//!
//! Faint parts are taken off by calculation (the picture under them stays), the rest is
//! filled.

use image::imageops;
use image::{GrayImage, Luma, RgbaImage};

use crate::watermark::{components, Hit, Rect};
use crate::wm_motif::{at_spot, blur, find_motif, grow_of, morph, Motif, Spot, MOTIF_MIN, MOTIF_UNSURE};

/// Too few pictures say nothing.
const MIN_PICTURES: usize = 4;
/// From here on a place is filled instead of calculated (the picture under it is too
/// faint, its edges would show).
const FILL: f32 = 0.4;
/// How much a picture's part has to look like the mark on it (Layer::agrees): surely, maybe.
const SAME: f32 = 0.3;
const MAYBE: f32 = 0.18;
/// The widest canvas, px.
const CANVAS: f32 = 900.0;

/// The mark with room around it, the same for every picture.
pub struct Canvas {
    /// Canvas px per px of the framed mark.
    f: f32,
    w: usize,
    h: usize,
    mw: f32,
    mh: f32,
    /// How far a layer can reach from the mark, canvas px.
    reach: usize,
}

impl Canvas {
    pub fn of(m: &Motif) -> Canvas {
        let (mw, mh) = (m.mask.width() as f32, m.mask.height() as f32);
        let side = mw.max(mh);
        let room = 0.19 * side;
        let f = (CANVAS / (side + 2.0 * room)).min(1.0);
        Canvas {
            f,
            w: ((mw + 2.0 * room) * f).round().max(16.0) as usize,
            h: ((mh + 2.0 * room) * f).round().max(16.0) as usize,
            mw,
            mh,
            reach: ((side * 0.055 * f) as usize).max(3),
        }
    }

    fn len(&self) -> usize {
        self.w * self.h
    }

    /// A mask of the mark's size on the canvas, 0..1.
    fn lay(&self, mask: &GrayImage) -> Vec<f32> {
        let (tw, th) = (
            ((mask.width() as f32 * self.f).round() as u32).max(1),
            ((mask.height() as f32 * self.f).round() as u32).max(1),
        );
        let small = imageops::resize(mask, tw, th, imageops::FilterType::Triangle);
        let (ox, oy) = ((self.w - (tw as usize).min(self.w)) / 2, (self.h - (th as usize).min(self.h)) / 2);
        let mut out = vec![0f32; self.len()];
        for (x, y, p) in small.enumerate_pixels() {
            let (cx, cy) = (ox + x as usize, oy + y as usize);
            if cx < self.w && cy < self.h {
                out[cy * self.w + cx] = p[0] as f32 / 255.0;
            }
        }
        out
    }

    /// The mark's whole box and as far as a layer reaches.
    fn box_zone(&self) -> Vec<bool> {
        let (bw, bh) = (self.mw * self.f / 2.0, self.mh * self.f / 2.0);
        let r = self.reach as f32;
        (0..self.len())
            .map(|i| {
                let dx = (i % self.w) as f32 + 0.5 - self.w as f32 / 2.0;
                let dy = (i / self.w) as f32 + 0.5 - self.h as f32 / 2.0;
                dx.abs() <= bw + r && dy.abs() <= bh + r
            })
            .collect()
    }

    /// A picture's part under the canvas, its mark turned straight. None when hardly any
    /// of it is on the picture.
    pub fn crop(&self, img: &RgbaImage, at: &Spot) -> Option<Crop> {
        let k = at.scale / self.f;
        let (sin, cos) = at.angle.to_radians().sin_cos();
        let (cw, ch) = (self.w as f32 * k / 2.0, self.h as f32 * k / 2.0);
        let (hw, hh) = (cw * cos.abs() + ch * sin.abs(), cw * sin.abs() + ch * cos.abs());
        let x0 = (at.cx - hw).max(0.0).floor() as u32;
        let y0 = (at.cy - hh).max(0.0).floor() as u32;
        let x1 = ((at.cx + hw).ceil().max(0.0) as u32).min(img.width());
        let y1 = ((at.cy + hh).ceil().max(0.0) as u32).min(img.height());
        if x1 <= x0 + 8 || y1 <= y0 + 8 {
            return None;
        }
        let part = imageops::crop_imm(img, x0, y0, x1 - x0, y1 - y0).to_image();
        // (a much bigger one first averaged down)
        let shrink = k.round().max(1.0) as u32;
        let part = if shrink > 1 {
            imageops::thumbnail(&part, (part.width() / shrink).max(1), (part.height() / shrink).max(1))
        } else {
            part
        };
        let (sx, sy) = (part.width() as f32 / (x1 - x0) as f32, part.height() as f32 / (y1 - y0) as f32);
        let mut rgb = vec![0u8; self.len() * 3];
        let mut there = vec![false; self.len()];
        let (pw, ph) = (part.width() as i32, part.height() as i32);
        for y in 0..self.h {
            for x in 0..self.w {
                let (ux, uy) = ((x as f32 + 0.5 - self.w as f32 / 2.0) * k, (y as f32 + 0.5 - self.h as f32 / 2.0) * k);
                let gx = (at.cx + ux * cos - uy * sin - x0 as f32) * sx - 0.5;
                let gy = (at.cy + ux * sin + uy * cos - y0 as f32) * sy - 0.5;
                if gx < -0.5 || gy < -0.5 || gx > pw as f32 - 0.5 || gy > ph as f32 - 0.5 {
                    continue;
                }
                let (ix, iy) = (gx.floor(), gy.floor());
                let (ax, ay) = (gx - ix, gy - iy);
                let get = |dx: i32, dy: i32, c: usize| {
                    part.get_pixel((ix as i32 + dx).clamp(0, pw - 1) as u32, (iy as i32 + dy).clamp(0, ph - 1) as u32)[c] as f32
                };
                let i = y * self.w + x;
                for c in 0..3 {
                    let v = (get(0, 0, c) * (1.0 - ax) + get(1, 0, c) * ax) * (1.0 - ay)
                        + (get(0, 1, c) * (1.0 - ax) + get(1, 1, c) * ax) * ay;
                    rgb[i * 3 + c] = v.round().clamp(0.0, 255.0) as u8;
                }
                there[i] = true;
            }
        }
        Some(Crop { rgb, there })
    }
}

/// One picture's part with the mark, on the canvas.
pub struct Crop {
    rgb: Vec<u8>,
    there: Vec<bool>,
}

/// What each place says by itself.
struct Solved {
    /// Opacity, how sure (its standard error), colour times opacity.
    a: Vec<f32>,
    err: Vec<f32>,
    ac: Vec<[f32; 3]>,
    /// Sums over the pictures, for the fit: weight, and per channel w*B, w*B*B, w*(I-B),
    /// w*B*(I-B).
    s0: Vec<f64>,
    s1: Vec<[f64; 3]>,
    s2: Vec<[f64; 3]>,
    y0: Vec<[f64; 3]>,
    y1: Vec<[f64; 3]>,
}

/// The smooth background of one picture from outside the zone, and how busy it is there.
/// (Worked out on a third of the size, it's smooth.)
fn background(c: &Crop, zone: &[bool], w: usize, h: usize) -> Option<(Vec<[f32; 3]>, f32)> {
    const D: usize = 3;
    let (sw, sh) = (w.div_ceil(D), h.div_ceil(D));
    let sn = sw * sh;
    let mut far = vec![0f32; sn];
    let mut chan = vec![vec![0f32; sn]; 3];
    for y in 0..h {
        for x in 0..w {
            let i = y * w + x;
            if c.there[i] && !zone[i] {
                let q = (y / D) * sw + x / D;
                far[q] += 1.0;
                for k in 0..3 {
                    chan[k][q] += c.rgb[i * 3 + k] as f32;
                }
            }
        }
    }
    if far.iter().sum::<f32>() < 200.0 {
        return None;
    }
    let mut b = vec![[0f32; 3]; sn];
    let mut done = vec![0f32; sn];
    // close to the edge from close by, further in from further out
    for s in [0.012f32, 0.025, 0.05, 0.1, 0.2, 0.4] {
        let sigma = (sw as f32 * s).max(1.0);
        let den = blur(&far, sw, sh, sigma);
        let num: Vec<Vec<f32>> = chan.iter().map(|v| blur(v, sw, sh, sigma)).collect();
        for q in 0..sn {
            let take = (den[q] / (0.04 * (D * D) as f32)).min(1.0) * (1.0 - done[q]);
            if take > 0.0 && den[q] > 1e-4 {
                for k in 0..3 {
                    b[q][k] += take * num[k][q] / den[q];
                }
                done[q] += take;
            }
        }
    }
    for q in 0..sn {
        if done[q] > 0.0 {
            for k in 0..3 {
                b[q][k] /= done[q];
            }
        }
    }
    let mut out = vec![[0f32; 3]; w * h];
    let (mut sq, mut cnt) = (0f64, 0f64);
    for y in 0..h {
        let gy = ((y as f32 + 0.5) / D as f32 - 0.5).clamp(0.0, sh as f32 - 1.0);
        let (y0, ay) = (gy as usize, gy.fract());
        let y1 = (y0 + 1).min(sh - 1);
        for x in 0..w {
            let gx = ((x as f32 + 0.5) / D as f32 - 0.5).clamp(0.0, sw as f32 - 1.0);
            let (x0, ax) = (gx as usize, gx.fract());
            let x1 = (x0 + 1).min(sw - 1);
            let i = y * w + x;
            for k in 0..3 {
                out[i][k] = (b[y0 * sw + x0][k] * (1.0 - ax) + b[y0 * sw + x1][k] * ax) * (1.0 - ay)
                    + (b[y1 * sw + x0][k] * (1.0 - ax) + b[y1 * sw + x1][k] * ax) * ay;
            }
            if c.there[i] && !zone[i] {
                let d: f32 = (0..3).map(|k| (c.rgb[i * 3 + k] as f32 - out[i][k]).abs()).sum::<f32>() / 3.0;
                sq += (d * d) as f64;
                cnt += 1.0;
            }
        }
    }
    Some((out, (sq / cnt.max(1.0)) as f32))
}

/// a and the colour at every place, from all pictures.
fn solve(crops: &[&Crop], zone: &[bool], w: usize, h: usize) -> Solved {
    use std::sync::atomic::{AtomicUsize, Ordering};
    let n = w * h;
    #[derive(Clone, Copy, Default)]
    struct Sum {
        s0: f64,
        b: [f64; 3],
        i: [f64; 3],
        bb: [f64; 3],
        bi: [f64; 3],
        ii: [f64; 3],
        n: u32,
    }
    let sums = std::sync::Mutex::new(vec![Sum::default(); n]);
    let next = AtomicUsize::new(0);
    let threads = std::thread::available_parallelism().map(|n| n.get() / 2).unwrap_or(1).clamp(1, 6);
    std::thread::scope(|sc| {
        for _ in 0..threads.min(crops.len()) {
            sc.spawn(|| loop {
                let k = next.fetch_add(1, Ordering::Relaxed);
                let Some(c) = crops.get(k) else { break };
                let Some((b, busy)) = background(c, zone, w, h) else { continue };
                let wt = 1.0 / (busy as f64 + 25.0);
                let mut sums = sums.lock().unwrap_or_else(|e| e.into_inner());
                for p in 0..n {
                    if !c.there[p] {
                        continue;
                    }
                    let s = &mut sums[p];
                    s.s0 += wt;
                    s.n += 1;
                    for ch in 0..3 {
                        let (bv, iv) = (b[p][ch] as f64, c.rgb[p * 3 + ch] as f64);
                        s.b[ch] += wt * bv;
                        s.i[ch] += wt * iv;
                        s.bb[ch] += wt * bv * bv;
                        s.bi[ch] += wt * bv * iv;
                        s.ii[ch] += wt * iv * iv;
                    }
                }
            });
        }
    });
    let sums = sums.into_inner().unwrap_or_else(|e| e.into_inner());
    let mut out = Solved {
        a: vec![0.0; n],
        err: vec![1.0; n],
        ac: vec![[0.0; 3]; n],
        s0: vec![0.0; n],
        s1: vec![[0.0; 3]; n],
        s2: vec![[0.0; 3]; n],
        y0: vec![[0.0; 3]; n],
        y1: vec![[0.0; 3]; n],
    };
    for (p, s) in sums.iter().enumerate() {
        if s.s0 <= 0.0 || s.n < MIN_PICTURES as u32 {
            continue;
        }
        out.s0[p] = s.s0;
        let (mut vbb, mut vbi, mut vii) = (0f64, 0f64, 0f64);
        for ch in 0..3 {
            vbb += s.bb[ch] - s.b[ch] * s.b[ch] / s.s0;
            vbi += s.bi[ch] - s.b[ch] * s.i[ch] / s.s0;
            vii += s.ii[ch] - s.i[ch] * s.i[ch] / s.s0;
            out.s1[p][ch] = s.b[ch];
            out.s2[p][ch] = s.bb[ch];
            out.y0[p][ch] = s.i[ch] - s.b[ch];
            out.y1[p][ch] = s.bi[ch] - s.bb[ch];
        }
        // (backgrounds that are all the same say nothing about a)
        if vbb / s.s0 < 60.0 {
            continue;
        }
        let slope = vbi / vbb;
        let rest = (vii - slope * vbi).max(0.0);
        let a = (1.0 - slope).clamp(0.0, 1.0);
        out.a[p] = a as f32;
        // each picture's three channels go together: not three times as sure
        out.err[p] = (rest / vbb / (s.n as f64 - 1.5).max(1.0)).sqrt().min(1.0) as f32;
        for ch in 0..3 {
            let (bm, im) = (s.b[ch] / s.s0, s.i[ch] / s.s0);
            out.ac[p][ch] = (im - (1.0 - a) * bm) as f32;
        }
    }
    out
}

/// Faint layers as blurred, shifted copies of the mark's parts, fitted over all places at
/// once, one after the other while each explains a good bit of what's there.
/// (opacity, colour times opacity)
fn fit(s: &Solved, parts: &[Vec<f32>], zone: &[bool], close: &[bool], w: usize, h: usize, reach: usize) -> (Vec<f32>, Vec<[f32; 3]>) {
    let n = w * h;
    let mut a = vec![0f32; n];
    let mut ac = vec![[0f32; 3]; n];
    let pts: Vec<usize> = (0..n).filter(|p| zone[*p] && !close[*p] && s.s0[*p] > 0.0).step_by(3).collect();
    if pts.len() < 200 {
        return (a, ac);
    }
    let mut y0 = s.y0.clone();
    let mut y1 = s.y1.clone();
    let total: f64 = pts.iter().map(|p| (0..3).map(|c| y0[*p][c] * y0[*p][c]).sum::<f64>() / s.s0[*p]).sum();
    if total <= 0.0 {
        return (a, ac);
    }
    let unit = w as f32 / 900.0;
    let far = (reach as f32 * 0.55).round().max(2.0) as i32;
    let step = (far / 5).max(1);
    let soft: Vec<Vec<Vec<f32>>> = parts
        .iter()
        .map(|on| [1.5f32, 3.0, 5.0, 8.0, 12.0, 16.0, 21.0].iter().map(|g| blur(on, w, h, (g * unit).max(0.8))).collect())
        .collect();
    let at = |v: &[f32], p: usize, dx: i32, dy: i32| -> f64 {
        let (x, y) = ((p % w) as i32 - dx, (p / w) as i32 - dy);
        if x < 0 || y < 0 || x >= w as i32 || y >= h as i32 {
            0.0
        } else {
            v[y as usize * w + x as usize] as f64
        }
    };
    for layer in 0..4 {
        // (gain, part, blur, shift, opacity, colour times opacity)
        type Best = (f64, usize, usize, i32, i32, f64, [f64; 3]);
        let mut best: Option<Best> = None;
        let try_one = |pi: usize, gi: usize, dx: i32, dy: i32, skip: usize, y0: &[[f64; 3]], y1: &[[f64; 3]]| -> Option<Best> {
            let v = &soft[pi][gi];
            let (mut a0, mut a2, mut e1) = (0f64, 0f64, 0f64);
            let (mut a1, mut e0) = ([0f64; 3], [0f64; 3]);
            for p in pts.iter().step_by(skip) {
                let g = at(v, *p, dx, dy);
                if g < 0.003 {
                    continue;
                }
                let gg = g * g;
                a0 += gg * s.s0[*p];
                for c in 0..3 {
                    a1[c] += gg * s.s1[*p][c];
                    a2 += gg * s.s2[*p][c];
                    e0[c] += g * y0[*p][c];
                    e1 += g * y1[*p][c];
                }
            }
            if a0 <= 0.0 {
                return None;
            }
            let det = a2 - (0..3).map(|c| a1[c] * a1[c]).sum::<f64>() / a0;
            // (too little difference between the pictures: black or white, whatever fits)
            let solve_c = |al: f64| -> [f64; 3] { [0, 1, 2].map(|c| (e0[c] + a1[c] * al) / a0) };
            let gain_of = |al: f64, pc: [f64; 3]| -> f64 {
                // how much smaller the squared rest gets
                let lin: f64 = (0..3).map(|c| pc[c] * e0[c]).sum::<f64>() - al * e1;
                let quad: f64 = (0..3).map(|c| pc[c] * pc[c] * a0 - 2.0 * al * pc[c] * a1[c]).sum::<f64>() + al * al * a2;
                2.0 * lin - quad
            };
            let ok = |al: f64, pc: [f64; 3]| al > 0.02 && al <= 1.0 && pc.iter().all(|v| *v >= -8.0 && *v <= al * 255.0 + 8.0);
            let mut got: Option<(f64, f64, [f64; 3])> = None;
            let mut take = |al: f64, pc: [f64; 3]| {
                let g = gain_of(al, pc);
                if ok(al, pc) && g > got.map_or(0.0, |x| x.0) {
                    got = Some((g, al, pc));
                }
            };
            if det > 1e-6 * a2 {
                let al = ((0..3).map(|c| a1[c] * e0[c]).sum::<f64>() / a0 - e1) / det;
                take(al, solve_c(al));
            }
            for level in [0f64, 255.0] {
                // one colour given: only its opacity is free
                let num: f64 = (0..3).map(|c| level * e0[c]).sum::<f64>() - e1;
                let den: f64 = (0..3).map(|c| level * level * a0 - 2.0 * level * a1[c]).sum::<f64>() + a2;
                if den > 0.0 {
                    let al = num / den;
                    take(al, [level * al; 3]);
                }
            }
            got.map(|(g, al, pc)| (g, pi, gi, dx, dy, al, pc))
        };
        let better = |b: &mut Option<Best>, c: Option<Best>| {
            if let Some(c) = c {
                if b.as_ref().map_or(true, |x| c.0 > x.0) {
                    *b = Some(c);
                }
            }
        };
        for pi in 0..soft.len() {
            for gi in 0..soft[pi].len() {
                for dy in (-far..=far).step_by(step as usize) {
                    for dx in (-far..=far).step_by(step as usize) {
                        better(&mut best, try_one(pi, gi, dx, dy, 3, &y0, &y1));
                    }
                }
            }
        }
        let Some((_, pi, gi, mx, my, _, _)) = best else { break };
        // around the best, with all points
        best = None;
        for g in gi.saturating_sub(1)..=(gi + 1).min(soft[pi].len() - 1) {
            for dy in my - step..=my + step {
                for dx in mx - step..=mx + step {
                    better(&mut best, try_one(pi, g, dx, dy, 1, &y0, &y1));
                }
            }
        }
        let Some((gain, pi, gi, dx, dy, al, pc)) = best else { break };
        let v = &soft[pi][gi];
        let top = v.iter().fold(0f32, |m, x| m.max(*x)) as f64 * al;
        if gain / total < if layer == 0 { 0.2 } else { 0.06 } || top < 0.05 {
            break;
        }
        for p in 0..n {
            let g = at(v, p, dx, dy);
            if g < 0.001 {
                continue;
            }
            a[p] += (al * g) as f32;
            for c in 0..3 {
                ac[p][c] += (pc[c] * g) as f32;
                y0[p][c] -= g * (pc[c] * s.s0[p] - al * s.s1[p][c]);
                y1[p][c] -= g * (pc[c] * s.s1[p][c] - al * s.s2[p][c]);
            }
        }
    }
    (a, ac)
}

/// Masks of the mark's colours (and the whole of it) on the canvas, and of their pieces
/// that are apart (a line of text may glow and a board's rim in the same black not).
fn colour_masks(on: &[bool], s: &Solved, w: usize, h: usize) -> Vec<Vec<f32>> {
    let dist = |a: &[f32; 3], b: &[f32; 3]| ((a[0] - b[0]).powi(2) + (a[1] - b[1]).powi(2) + (a[2] - b[2]).powi(2)).sqrt();
    let col = |p: usize| s.ac[p].map(|v| (v / s.a[p].max(0.2)).clamp(0.0, 255.0));
    let whole: Vec<f32> = on.iter().map(|v| *v as i32 as f32).collect();
    let mut bins: std::collections::HashMap<[u8; 3], ([f64; 3], f64)> = std::collections::HashMap::new();
    let mut total = 0f64;
    for p in (0..on.len()).filter(|p| on[*p] && s.a[*p] > 0.6) {
        let c = col(p);
        let e = bins.entry(c.map(|v| v as u8 / 32)).or_insert(([0.0; 3], 0.0));
        for k in 0..3 {
            e.0[k] += c[k] as f64;
        }
        e.1 += 1.0;
        total += 1.0;
    }
    let mut list: Vec<([f32; 3], f64)> =
        bins.into_values().filter(|(_, n)| *n >= 0.03 * total).map(|(s, n)| (s.map(|v| (v / n) as f32), n)).collect();
    list.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    let mut cols: Vec<[f32; 3]> = Vec::new();
    for (c, _) in list {
        if cols.iter().all(|k| dist(k, &c) > 80.0) && cols.len() < 4 {
            cols.push(c);
        }
    }
    let mut out = vec![whole];
    let near = |p: usize| {
        let c = col(p);
        (0..cols.len()).min_by(|a, b| dist(&cols[*a], &c).total_cmp(&dist(&cols[*b], &c)))
    };
    let gap = (w / 60).max(3);
    for k in 0..cols.len().max(1) {
        let mine: Vec<bool> =
            if cols.len() < 2 { on.to_vec() } else { (0..on.len()).map(|p| on[p] && near(p) == Some(k)).collect() };
        if cols.len() >= 2 {
            out.push(mine.iter().map(|v| *v as i32 as f32).collect());
        }
        // pieces apart
        let wide = morph(&mine, w, h, gap, false);
        let img = GrayImage::from_fn(w as u32, h as u32, |x, y| Luma([wide[y as usize * w + x as usize] as u8 * 255]));
        let (labels, comps) = components(&img);
        let mut size = vec![0usize; comps.len()];
        for p in (0..mine.len()).filter(|p| mine[*p]) {
            size[labels[p] as usize - 1] += 1;
        }
        let all: usize = size.iter().sum();
        let mut big: Vec<usize> = (0..size.len()).filter(|c| size[*c] * 12 > all).collect();
        big.sort_by_key(|c| std::cmp::Reverse(size[*c]));
        if big.len() > 1 {
            for c in big.into_iter().take(3) {
                out.push((0..mine.len()).map(|p| (mine[p] && labels[p] as usize == c + 1) as i32 as f32).collect());
            }
        }
    }
    out
}

/// The mark as learned.
pub struct Layer {
    canvas: Canvas,
    /// Opacity and colour times opacity of the faint parts (0 where it's filled).
    a: Vec<f32>,
    ac: Vec<[f32; 3]>,
    /// What's filled, 0..1.
    fill: Vec<f32>,
    /// All of it, faint and opaque: opacity and colour times opacity, and where.
    all_a: Vec<f32>,
    all_ac: Vec<[f32; 3]>,
    zone: Vec<bool>,
    /// How many of its own pixels are surely opaque.
    sure: usize,
    /// Some of them well inside its flat parts, to look for it by colour: where (px of the
    /// framed mark from its middle), colour, which of its colours. And how deep inside.
    dots: Vec<([f32; 2], [f32; 3], usize)>,
    depth: f32,
    /// The mark on the canvas as far as the pictures say.
    mark: Vec<bool>,
}

/// Specks out.
fn clean(m: &[bool], w: usize, h: usize, least: u32) -> Vec<bool> {
    let img = GrayImage::from_fn(w as u32, h as u32, |x, y| Luma([m[y as usize * w + x as usize] as u8 * 255]));
    let (labels, comps) = components(&img);
    labels.iter().map(|l| *l > 0 && comps[*l as usize - 1].area >= least).collect()
}

/// Points well inside the mark's flat colours, the same number for each colour, and how
/// deep inside they are (px of the framed mark). Empty when it has only thin strokes.
fn dots_of(cv: &Canvas, sure: &[(usize, [f32; 3])]) -> (Vec<([f32; 2], [f32; 3], usize)>, f32) {
    let dist = |a: &[f32; 3], b: &[f32; 3]| (0..3).map(|c| (a[c] - b[c]).powi(2)).sum::<f32>().sqrt();
    let mut cols: Vec<[f32; 3]> = Vec::new();
    for (_, c) in sure.iter().step_by(7) {
        if cols.iter().all(|k| dist(k, c) > 90.0) && cols.len() < 5 {
            cols.push(*c);
        }
    }
    let class = |c: &[f32; 3]| (0..cols.len()).min_by(|a, b| dist(&cols[*a], c).total_cmp(&dist(&cols[*b], c))).unwrap_or(0);
    let mut out = Vec::new();
    let mut depth = f32::MAX;
    for k in 0..cols.len() {
        let mut on = vec![false; cv.len()];
        let mut col = vec![[0f32; 3]; cv.len()];
        for (p, c) in sure.iter().filter(|(_, c)| class(c) == k) {
            on[*p] = true;
            col[*p] = *c;
        }
        // as deep as there are enough left
        let mut best: Option<(usize, Vec<usize>)> = None;
        for r in [2usize, 3, 4, 6, 8] {
            let left: Vec<usize> = morph(&on, cv.w, cv.h, r, true).iter().enumerate().filter(|(_, v)| **v).map(|(p, _)| p).collect();
            if left.len() < 60 {
                break;
            }
            best = Some((r, left));
        }
        let Some((r, left)) = best else { continue };
        if r < 3 && k > 0 && !out.is_empty() {
            continue;
        }
        depth = depth.min(r as f32 / cv.f);
        let n = left.len().min(120);
        for j in 0..n {
            let p = left[(j * 7919) % left.len()];
            let (x, y) = ((p % cv.w) as f32 + 0.5, (p / cv.w) as f32 + 0.5);
            out.push(([(x - cv.w as f32 / 2.0) / cv.f, (y - cv.h as f32 / 2.0) / cv.f], col[p], k));
        }
    }
    if out.is_empty() {
        return (out, 0.0);
    }
    // one of each colour in turn: a wrong place is told after a few
    let mut by: Vec<Vec<([f32; 2], [f32; 3], usize)>> = vec![Vec::new(); cols.len()];
    for d in out {
        by[d.2].push(d);
    }
    let most = by.iter().map(|v| v.len()).max().unwrap_or(0);
    let mixed = (0..most).flat_map(|j| by.iter().filter(move |v| !v.is_empty()).map(move |v| v[j % v.len()]).collect::<Vec<_>>()).collect();
    (mixed, depth)
}

/// Learn the mark from the pictures' parts. m = as it was framed, faint = its shadows and
/// glows too (takes longer).
pub fn learn(m: &Motif, crops: &[&Crop], faint: bool) -> Option<Layer> {
    let canvas = Canvas::of(m);
    if crops.len() < MIN_PICTURES {
        return None;
    }
    let (w, h, n) = (canvas.w, canvas.h, canvas.len());
    let framed: Vec<bool> = canvas.lay(&m.mask).iter().map(|v| *v > 0.3).collect();
    let boxed = canvas.box_zone();
    let least = ((w as f32 / 900.0 * 4.0).powi(2) as u32).max(3);
    // 1. what's opaque, wherever it is in the box (parts the framing missed)
    let first = solve(crops, &boxed, w, h);
    let opaque = |s: &Solved| -> Vec<bool> {
        let v: Vec<bool> = (0..n).map(|p| boxed[p] && s.a[p] - 2.0 * s.err[p] > 0.45).collect();
        clean(&v, w, h, least)
    };
    let solid = opaque(&first);
    // where the pictures are sure there's nothing, the framing had some background in it
    let drop: Vec<bool> = (0..n).map(|p| first.a[p] + 3.0 * first.err[p] < 0.2).collect();
    let known = solid.iter().filter(|v| **v).count() * 3 > framed.iter().filter(|v| **v).count();
    let mark: Vec<bool> = (0..n).map(|p| solid[p] || (framed[p] && !(known && drop[p]))).collect();
    if mark.iter().filter(|v| **v).count() < 20 {
        return None;
    }
    // 2. again, with the background from right around it
    let zone: Vec<bool> = morph(&mark, w, h, canvas.reach, false);
    let s = solve(crops, &zone, w, h);
    let close = morph(&mark, w, h, ((w as f32 / 900.0 * 2.0).round() as usize).max(1), false);
    let parts = colour_masks(&mark, &s, w, h);
    let (fa, fac) = if faint {
        fit(&s, &parts, &zone, &close, w, h, canvas.reach)
    } else {
        (vec![0.0; n], vec![[0.0; 3]; n])
    };
    // 3. both together: a place's own value as far as it's sure (its difference to the fit
    // is real), faded out towards the zone's edge
    let edge = blur(&zone.iter().map(|v| *v as i32 as f32).collect::<Vec<_>>(), w, h, canvas.reach as f32 * 0.25);
    let mut a = vec![0f32; n];
    let mut ac = vec![[0f32; 3]; n];
    for p in (0..n).filter(|p| zone[*p]) {
        let fade = ((edge[p] - 0.5) * 2.0).clamp(0.0, 1.0);
        // how far the fit may be off there
        let tau = 0.035 + 0.5 * fa[p];
        let trust = if s.err[p] < 0.2 { tau * tau / (tau * tau + s.err[p] * s.err[p]) } else { 0.0 };
        a[p] = (fa[p] + trust * (s.a[p] - fa[p])) * fade;
        for c in 0..3 {
            ac[p][c] = (fac[p][c] + trust * (s.ac[p][c] - fac[p][c])) * fade;
        }
    }
    // a little smoothing of the faint part, and nothing where there's hardly anything
    let sm = (w as f32 / 900.0 * 1.2).max(0.6);
    let faint: Vec<f32> = (0..n).map(|p| (zone[p] && !mark[p] && a[p] < FILL) as i32 as f32).collect();
    let den = blur(&faint, w, h, sm);
    let soft = |v: &dyn Fn(usize) -> f32| -> Vec<f32> {
        let num = blur(&(0..n).map(|p| v(p) * faint[p]).collect::<Vec<_>>(), w, h, sm);
        (0..n).map(|p| if den[p] > 0.05 { num[p] / den[p] } else { 0.0 }).collect()
    };
    let sa = soft(&|p| a[p]);
    let sc: Vec<Vec<f32>> = (0..3).map(|c| soft(&|p| ac[p][c])).collect();
    // solid: the mark and everything as good as opaque right at it
    let heavy: Vec<bool> = (0..n).map(|p| mark[p] || (zone[p] && a[p] >= FILL)).collect();
    let heavy = {
        let c = clean(&heavy, w, h, least);
        (0..n).map(|p| c[p] || mark[p]).collect::<Vec<bool>>()
    };
    let mut out_a = vec![0f32; n];
    let mut out_ac = vec![[0f32; 3]; n];
    for p in (0..n).filter(|p| zone[*p] && !heavy[*p]) {
        let v = sa[p].clamp(0.0, 0.6);
        // (the background is a guess: the last few percent aren't real)
        let keep = ((v - 0.025) / 0.03).clamp(0.0, 1.0);
        if keep <= 0.0 {
            continue;
        }
        out_a[p] = v * keep;
        for c in 0..3 {
            out_ac[p][c] = sc[c][p].clamp(-2.0, v * 255.0 + 2.0) * keep;
        }
    }
    let inner = morph(&mark, w, h, 1, true);
    let sure: Vec<(usize, [f32; 3])> = (0..n)
        .filter(|p| inner[*p] && s.a[*p] > 0.85 && s.err[*p] < 0.06)
        .map(|p| (p, s.ac[p].map(|v| (v / s.a[p]).clamp(0.0, 255.0))))
        .collect();
    let (dots, depth) = dots_of(&canvas, &sure);
    Some(Layer {
        dots,
        depth,
        all_a: (0..n).map(|p| if !zone[p] { 0.0 } else if s.err[p] < 0.15 { s.a[p] } else { a[p].clamp(0.0, 1.0) }).collect(),
        all_ac: (0..n)
            .map(|p| if !zone[p] { [0.0; 3] } else if s.err[p] < 0.15 { s.ac[p] } else { ac[p] })
            .collect(),
        zone: zone.clone(),
        canvas,
        a: out_a,
        ac: out_ac,
        fill: heavy.iter().map(|v| *v as i32 as f32).collect(),
        sure: sure.len(),
        mark: (0..n).map(|p| if s.err[p] < 0.12 { s.a[p] > 0.5 && zone[p] } else { mark[p] }).collect(),
    })
}

impl Layer {
    /// How much a picture's part looks like its background with the mark on it (the
    /// correlation of what differs from the background with what the mark would change,
    /// fine detail only; 1 = the same). None when too little is known of the mark.
    pub fn agrees(&self, c: &Crop) -> Option<f32> {
        if self.sure < 200 {
            return None;
        }
        let (w, h) = (self.canvas.w, self.canvas.h);
        let (b, _) = background(c, &self.zone, w, h)?;
        let inside: Vec<f32> = (0..w * h).map(|p| (self.zone[p] && c.there[p]) as i32 as f32).collect();
        // (half of it off the picture says little)
        if inside.iter().sum::<f32>() < 0.4 * self.zone.iter().filter(|v| **v).count() as f32 {
            return None;
        }
        let sigma = (w as f32 * 0.02).max(2.0);
        let den = blur(&inside, w, h, sigma);
        let (mut so, mut sp, mut sop) = (0f64, 0f64, 0f64);
        for k in 0..3 {
            let fine = |v: Vec<f32>| -> Vec<f32> {
                let low = blur(&v, w, h, sigma);
                (0..w * h).map(|p| if inside[p] > 0.0 { v[p] - low[p] / den[p].max(1e-3) } else { 0.0 }).collect()
            };
            let obs = fine((0..w * h).map(|p| inside[p] * (c.rgb[p * 3 + k] as f32 - b[p][k])).collect());
            let pred = fine((0..w * h).map(|p| inside[p] * (self.all_ac[p][k] - self.all_a[p] * b[p][k])).collect());
            for p in 0..w * h {
                so += (obs[p] * obs[p]) as f64;
                sp += (pred[p] * pred[p]) as f64;
                sop += (obs[p] * pred[p]) as f64;
            }
        }
        (sp > 0.0 && so > 0.0).then(|| (sop / (so * sp).sqrt()) as f32)
    }

    /// Look for the mark by its flat colours (it's told on any background that way), in
    /// the sizes given. Where, and how much of it is there (0..1).
    pub fn find(&self, img: &RgbaImage, scales: &[f32], stop: &dyn Fn() -> bool) -> Vec<Spot> {
        if self.dots.len() < 80 || scales.is_empty() {
            return Vec::new();
        }
        let (w, h) = img.dimensions();
        let cv = &self.canvas;
        // how well a place fits on a copy: 1 = all dots there, gives up early when it can't
        // get to `least` any more
        let fits = |pic: &RgbaImage, q: f32, cx: f32, cy: f32, s: f32, n: usize, least: f32| -> f32 {
            let (pw, ph) = (pic.width() as f32, pic.height() as f32);
            let mut sum = 0f32;
            for (j, (u, c, _)) in self.dots.iter().take(n).enumerate() {
                let (x, y) = ((cx + u[0] * s) * q, (cy + u[1] * s) * q);
                if x >= 0.0 && y >= 0.0 && x < pw && y < ph {
                    let p = pic.get_pixel(x as u32, y as u32);
                    let d = (0..3).map(|k| (p[k] as f32 - c[k]).abs()).sum::<f32>() / 3.0;
                    sum += (1.0 - d / 45.0).max(0.0);
                }
                if j % 12 == 11 && sum < (least - 0.25) * (j + 1) as f32 {
                    return 0.0;
                }
            }
            sum / n as f32
        };
        let smallest = scales.iter().copied().fold(f32::MAX, f32::min);
        let side = cv.mw.max(cv.mh);
        // a copy on which a dot's surroundings are still a px and a half of its colour
        let target = (1.6 * side / self.depth).clamp(90.0, 230.0);
        let q_of = |s: f32| (target / (side * s)).min(1.0);
        let q0 = q_of(smallest);
        let mut small: (f32, RgbaImage) = (0.0, RgbaImage::new(1, 1));
        let mut top: Vec<(f32, f32, f32, f32)> = Vec::new();
        let mut scales = scales.to_vec();
        scales.sort_by(|a, b| a.total_cmp(b));
        for s in &scales {
            // (the sizes close to each other share a copy)
            if small.0 == 0.0 || small.0 * side * s > target * 1.3 {
                let q = q_of(*s);
                small = (q, imageops::thumbnail(img, ((w as f32 * q) as u32).max(1), ((h as f32 * q) as u32).max(1)));
            }
            let (q, small) = (small.0, &small.1);
            if stop() {
                return Vec::new();
            }
            let (hw, hh) = (cv.mw * s * 0.5, cv.mh * s * 0.5);
            let step = 1.0 / q;
            let (mut y, y1) = (hh * 0.6, h as f32 - hh * 0.6);
            while y < y1 {
                let (mut x, x1) = (hw * 0.6, w as f32 - hw * 0.6);
                while x < x1 {
                    let f = fits(small, q, x, y, *s, self.dots.len().min(96), 0.5);
                    if f > 0.5 {
                        match top.iter_mut().find(|t| (t.1 - x).abs() < hw * 0.3 && (t.2 - y).abs() < hh * 0.3) {
                            Some(t) if f > t.0 => *t = (f, x, y, *s),
                            Some(_) => {}
                            None => top.push((f, x, y, *s)),
                        }
                    }
                    x += step;
                }
                y += step;
            }
        }
        top.sort_by(|a, b| b.0.total_cmp(&a.0));
        // the best few exactly, on bigger and bigger copies
        top.truncate(10);
        let mut best: Vec<(f32, f32, f32, f32)> = top;
        let mut q = q_of(scales.iter().copied().fold(0f32, f32::max)).min(q0);
        loop {
            let pic = if q >= 1.0 {
                img.clone()
            } else {
                imageops::thumbnail(img, ((w as f32 * q) as u32).max(1), ((h as f32 * q) as u32).max(1))
            };
            for b in best.iter_mut() {
                let (_, x, y, s) = *b;
                if q < q_of(s) * 0.9 {
                    continue;
                }
                let mut at = (0f32, x, y, s);
                for ds in [0.97f32, 0.985, 1.0, 1.015, 1.03] {
                    // (finer and finer)
                    let ds = 1.0 + (ds - 1.0) * (q_of(s) / q.max(q_of(s))).sqrt();
                    for dy in -2i32..=2 {
                        for dx in -2i32..=2 {
                            let (nx, ny, ns) = (x + dx as f32 / q, y + dy as f32 / q, s * ds);
                            let f = fits(&pic, q, nx, ny, ns, self.dots.len(), at.0.max(0.4));
                            if f > at.0 {
                                at = (f, nx, ny, ns);
                            }
                        }
                    }
                }
                *b = at;
            }
            best.retain(|b| b.0 >= 0.4);
            best.sort_by(|a, b| b.0.total_cmp(&a.0));
            best.truncate(3);
            if best.is_empty() || q >= 1.0 || q * cv.mw.max(cv.mh) * smallest > 800.0 {
                break;
            }
            q = (q * 2.0).min(1.0);
        }
        best.into_iter().map(|(_, cx, cy, scale)| Spot { cx, cy, scale, angle: 0.0 }).collect()
    }

    /// The mark as the pictures show it (to look for it again), and where its box's
    /// middle is against the framed one's, px of the framed mark. stroke, ref = as framed.
    pub fn motif(&self, m: &Motif) -> Option<(Motif, (f32, f32))> {
        let cv = &self.canvas;
        let k = 1.0 / cv.f;
        let (fw, fh) = ((cv.w as f32 * k).round() as u32, (cv.h as f32 * k).round() as u32);
        let small = GrayImage::from_fn(cv.w as u32, cv.h as u32, |x, y| {
            Luma([self.mark[y as usize * cv.w + x as usize] as u8 * 255])
        });
        let mut full = imageops::resize(&small, fw, fh, imageops::FilterType::Triangle);
        for p in full.pixels_mut() {
            p[0] = if p[0] > 127 { 255 } else { 0 };
        }
        let (x0, y0, x1, y1) = crate::edit::mask_bbox(&full)?;
        let new = crate::wm_motif::motif_from_mask(&full, m.stroke, m.ref_w, m.ref_h)?;
        let off = (
            (x0 + x1 + 1) as f32 / 2.0 - fw as f32 / 2.0,
            (y0 + y1 + 1) as f32 / 2.0 - fh as f32 / 2.0,
        );
        Some((new, off))
    }

    /// Canvas place of a picture's pixel.
    fn place(&self, at: &Spot, x: u32, y: u32) -> (f32, f32) {
        let k = at.scale / self.canvas.f;
        let (sin, cos) = at.angle.to_radians().sin_cos();
        let (dx, dy) = ((x as f32 + 0.5 - at.cx) / k, (y as f32 + 0.5 - at.cy) / k);
        (
            dx * cos + dy * sin + self.canvas.w as f32 / 2.0 - 0.5,
            -dx * sin + dy * cos + self.canvas.h as f32 / 2.0 - 0.5,
        )
    }

    /// The part of a picture the canvas covers (x0, y0, x1, y1).
    fn area(&self, at: &Spot, w: u32, h: u32) -> (u32, u32, u32, u32) {
        let k = at.scale / self.canvas.f;
        let (sin, cos) = at.angle.to_radians().sin_cos();
        let (cw, ch) = (self.canvas.w as f32 * k / 2.0, self.canvas.h as f32 * k / 2.0);
        let (hw, hh) = (cw * cos.abs() + ch * sin.abs(), cw * sin.abs() + ch * cos.abs());
        (
            (at.cx - hw).max(0.0) as u32,
            (at.cy - hh).max(0.0) as u32,
            ((at.cx + hw).max(0.0) as u32 + 1).min(w),
            ((at.cy + hh).max(0.0) as u32 + 1).min(h),
        )
    }

    fn sample(&self, v: &dyn Fn(usize) -> f32, sx: f32, sy: f32) -> f32 {
        let (fx, fy) = (sx.floor(), sy.floor());
        let (ax, ay) = (sx - fx, sy - fy);
        let get = |x: i32, y: i32| -> f32 {
            if x < 0 || y < 0 || x >= self.canvas.w as i32 || y >= self.canvas.h as i32 {
                0.0
            } else {
                v(y as usize * self.canvas.w + x as usize)
            }
        };
        let (ix, iy) = (fx as i32, fy as i32);
        (get(ix, iy) * (1.0 - ax) + get(ix + 1, iy) * ax) * (1.0 - ay)
            + (get(ix, iy + 1) * (1.0 - ax) + get(ix + 1, iy + 1) * ax) * ay
    }

    /// Take the faint parts off a picture: what's under them comes back.
    pub fn lift(&self, img: &mut RgbaImage, at: &Spot) {
        let (x0, y0, x1, y1) = self.area(at, img.width(), img.height());
        for y in y0..y1 {
            for x in x0..x1 {
                let (sx, sy) = self.place(at, x, y);
                let a = self.sample(&|p| self.a[p], sx, sy);
                if a < 0.004 {
                    continue;
                }
                let p = img.get_pixel_mut(x, y);
                for c in 0..3 {
                    let ac = self.sample(&|q| self.ac[q][c], sx, sy);
                    p[c] = ((p[c] as f32 - ac) / (1.0 - a)).round().clamp(0.0, 255.0) as u8;
                }
            }
        }
    }

    /// What to fill on a picture, `grow` px wider.
    pub fn hit(&self, at: &Spot, grow: i32, w: u32, h: u32) -> Option<Hit> {
        let (x0, y0, x1, y1) = self.area(at, w, h);
        if x1 <= x0 || y1 <= y0 {
            return None;
        }
        let mut full = GrayImage::new(x1 - x0, y1 - y0);
        for (x, y, p) in full.enumerate_pixels_mut() {
            let (sx, sy) = self.place(at, x0 + x, y0 + y);
            p[0] = if self.sample(&|q| self.fill[q], sx, sy) > 0.4 { 255 } else { 0 };
        }
        let full = crate::edit::dilate_mask(&full, grow);
        let (bx0, by0, bx1, by1) = crate::edit::mask_bbox(&full)?;
        let mask = imageops::crop_imm(&full, bx0, by0, bx1 - bx0 + 1, by1 - by0 + 1).to_image();
        let r = Rect { x: x0 + bx0, y: y0 + by0, w: bx1 - bx0 + 1, h: by1 - by0 + 1 };
        Some(Hit { mask, bbox: (r.x, r.y, r.x + r.w - 1, r.y + r.h - 1), region: r, contrast: 1.0 })
    }
}

/* ---- over a whole reward ------------------------------------------------------ */

/// Where the mark is on a picture and what's filled there.
pub struct Found {
    pub spot: Spot,
    pub hit: Hit,
    /// It may be the mark.
    pub unsure: bool,
}

/// Opens one of the pictures.
pub type Load<'a> = &'a (dyn Fn(usize) -> Option<RgbaImage> + Sync);

struct Seen {
    spot: Spot,
    score: f32,
    hit: Hit,
    crop: Option<Crop>,
    size: (u32, u32),
}

/// Look for the mark on all pictures and learn it from them, then again with what was
/// learned where it wasn't found for sure. own = the picture it was framed on, where, and
/// exactly what was framed. again = do the second round (it takes a few seconds a picture).
/// tick(round, done, of).
pub fn hunt(
    count: usize,
    load: Load,
    m: &Motif,
    own: Option<(usize, Spot, Hit)>,
    again: bool,
    stop: &(dyn Fn() -> bool + Sync),
    tick: &(dyn Fn(usize, usize, usize) + Sync),
) -> (Vec<Option<Found>>, Option<Layer>) {
    let canvas = Canvas::of(m);
    let threads = std::thread::available_parallelism().map(|n| n.get() / 2).unwrap_or(1).clamp(1, 4);
    let each = |round: usize, list: &[usize], run: &(dyn Fn(usize) -> Option<Seen> + Sync)| -> Vec<(usize, Option<Seen>)> {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let (next, done) = (AtomicUsize::new(0), AtomicUsize::new(0));
        let out = std::sync::Mutex::new(Vec::new());
        std::thread::scope(|sc| {
            for _ in 0..threads.min(list.len()) {
                sc.spawn(|| loop {
                    let k = next.fetch_add(1, Ordering::Relaxed);
                    let Some(i) = list.get(k) else { break };
                    if stop() {
                        break;
                    }
                    let r = run(*i);
                    out.lock().unwrap_or_else(|e| e.into_inner()).push((*i, r));
                    tick(round, done.fetch_add(1, Ordering::Relaxed) + 1, list.len());
                });
            }
        });
        out.into_inner().unwrap_or_else(|e| e.into_inner())
    };
    let nothing = || ((0..count).map(|_| None).collect(), None);
    // 1. as framed
    let all: Vec<usize> = (0..count).collect();
    let mut seen: Vec<Option<Seen>> = (0..count).map(|_| None).collect();
    for (i, s) in each(1, &all, &|i| {
        let img = load(i)?;
        let size = img.dimensions();
        if let Some((k, spot, hit)) = &own {
            if *k == i {
                return Some(Seen { spot: *spot, score: 1.0, hit: hit.clone(), crop: canvas.crop(&img, spot), size });
            }
        }
        let f = find_motif(&img, m, false, stop).filter(|f| f.score >= MOTIF_UNSURE)?;
        Some(Seen { crop: canvas.crop(&img, &f.spot), spot: f.spot, score: f.score, hit: f.hit, size })
    }) {
        seen[i] = s;
    }
    if stop() {
        return nothing();
    }
    let is_own = |i: usize| own.as_ref().is_some_and(|o| o.0 == i);
    // learned from the ones that surely show it. A wrong one doesn't look like the mark on
    // it (agrees): out it goes, round by round (at first little is known of the mark, so
    // against the best ones)
    let pick = |seen: &[Option<Seen>], layer: Option<&Layer>, all: bool, faint: bool| -> Option<Layer> {
        let got: Vec<(usize, &Crop, Option<f32>, f32)> = seen
            .iter()
            .enumerate()
            .filter_map(|(i, s)| {
                let s = s.as_ref()?;
                Some((i, s.crop.as_ref()?, None, s.score))
            })
            .collect();
        let got = agreed(got, layer);
        let top = got.iter().filter_map(|g| g.2).fold(0f32, f32::max);
        let least = if all { SAME } else { (top * 0.5).clamp(0.12, SAME) };
        let crops: Vec<&Crop> = got
            .iter()
            .filter(|(i, _, v, score)| match v {
                Some(v) => *v >= least || is_own(*i),
                None => *score >= MOTIF_MIN,
            })
            .map(|g| g.1)
            .collect();
        // (a hundred pictures don't say more than sixty)
        let k = crops.len().min(60);
        let crops: Vec<&Crop> = (0..k).map(|j| crops[j * crops.len() / k.max(1)]).collect();
        learn(m, &crops, faint)
    };
    let mut layer = pick(&seen, None, false, false);
    for _ in 0..3 {
        let Some(l) = &layer else { break };
        layer = pick(&seen, Some(l), false, false).or(layer);
    }
    // 2. the ones it wasn't found on for sure, with the mark as learned
    if let Some((l, (m2, off))) = layer.as_ref().filter(|_| again).and_then(|l| Some((l, l.motif(m)?))) {
        let agree = |s: &Seen| s.crop.as_ref().and_then(|c| l.agrees(c));
        // what's usual: one far below it is turned, or not it
        let values: Vec<Option<f32>> = {
            let list = seen
                .iter()
                .enumerate()
                .filter_map(|(i, s)| s.as_ref().and_then(|s| Some((i, s.crop.as_ref()?, None, s.score))))
                .collect();
            let mut v = vec![None; count];
            for (i, _, a, _) in agreed(list, Some(l)) {
                v[i] = a;
            }
            v
        };
        let usually = {
            let mut v: Vec<f32> = values.iter().flatten().copied().filter(|v| *v >= SAME).collect();
            v.sort_by(|a, b| a.total_cmp(b));
            v.get(v.len() / 2).copied().unwrap_or(SAME)
        };
        let good = SAME.max(usually * 0.65);
        let rest: Vec<usize> = (0..count)
            .filter(|i| {
                !is_own(*i)
                    && seen[*i].as_ref().map_or(true, |s| match values[*i] {
                        Some(v) => v < good,
                        None => s.score < MOTIF_MIN,
                    })
            })
            .collect();
        // the sizes it has (against the picture's) where it was found
        let k_of = |size: (u32, u32)| ((size.0 as f32 * size.1 as f32) / (m.ref_w as f32 * m.ref_h as f32)).sqrt();
        let mut usual: Vec<f32> = Vec::new();
        for (_, s) in values.iter().zip(&seen).filter(|(v, _)| v.is_some_and(|v| v >= good)) {
            let Some(s) = s else { continue };
            let r = s.spot.scale / k_of(s.size);
            if usual.len() < 6 && usual.iter().all(|u| (u / r - 1.0).abs() > 0.04) {
                usual.push(r);
            }
        }
        let found = each(2, &rest, &|i| {
            let img = load(i)?;
            let size = img.dimensions();
            let scales: Vec<f32> = usual.iter().flat_map(|u| [0.96f32, 1.0, 1.04].map(|d| u * d * k_of(size))).collect();
            let best = l
                .find(&img, &scales, stop)
                .into_iter()
                .filter_map(|spot| {
                    // (its flat parts say about where, its outlines exactly)
                    let spot = center_back(&at_spot(&img, &m2, &center_there(&spot, off))?, off);
                    let c = canvas.crop(&img, &spot)?;
                    let v = l.agrees(&c)?;
                    Some((v, spot, c))
                })
                .max_by(|a, b| a.0.total_cmp(&b.0));
            let straight = best.and_then(|(v, spot, crop)| {
                let hit = l.hit(&spot, grow_of(m.stroke * spot.scale), size.0, size.1)?;
                Some((v, Seen { spot, score: v, hit, crop: Some(crop), size }))
            });
            if straight.as_ref().is_some_and(|x| x.0 >= good) {
                return straight.map(|x| x.1);
            }
            // turned, or only thin lines
            let turned = find_motif(&img, &m2, true, stop).filter(|f| f.score >= MOTIF_UNSURE - 0.1).map(|f| {
                let spot = center_back(&f.spot, off);
                let s = Seen { crop: canvas.crop(&img, &spot), spot, score: f.score, hit: f.hit, size };
                (agree(&s).unwrap_or(if f.score >= MOTIF_MIN { SAME } else { 0.0 }), s)
            });
            match (straight, turned) {
                (Some(a), Some(b)) => Some(if a.0 >= b.0 { a.1 } else { b.1 }),
                (a, b) => a.or(b).map(|x| x.1),
            }
        });
        for (i, s) in found {
            let Some(s) = s else { continue };
            // the better of both
            let old = seen[i].as_ref().map(|o| (agree(o).unwrap_or(0.0), o.score));
            let new = (agree(&s).unwrap_or(0.0), s.score);
            if old.map_or(true, |o| new.0 > o.0 + 0.05 || ((new.0 - o.0).abs() <= 0.05 && new.1 > o.1)) {
                seen[i] = Some(s);
            }
        }
        if stop() {
            return nothing();
        }
        layer = pick(&seen, layer.as_ref(), true, false).or(layer);
    }
    if stop() {
        return nothing();
    }
    // and once more with all of them, the faint parts too
    layer = pick(&seen, layer.as_ref(), true, true).or(layer);
    let out = seen
        .into_iter()
        .enumerate()
        .map(|(i, s)| {
            let s = s?;
            let mine = is_own(i);
            let (there, unsure) = match s.crop.as_ref().and_then(|c| layer.as_ref()?.agrees(c)) {
                _ if mine => (true, false),
                Some(v) => (v >= MAYBE, v < SAME),
                None => (s.score >= MOTIF_UNSURE, s.score < MOTIF_MIN),
            };
            if !there {
                return None;
            }
            let grow = grow_of(m.stroke * s.spot.scale);
            let hit = match layer.as_ref().and_then(|l| l.hit(&s.spot, grow, s.size.0, s.size.1)) {
                Some(h) if mine => join(&h, &s.hit),
                Some(h) => h,
                None => s.hit,
            };
            Some(Found { spot: s.spot, hit, unsure })
        })
        .collect();
    (out, layer)
}

/// The framed mark's middle from the learned one's (off = between them) and back.
fn center_back(s: &Spot, off: (f32, f32)) -> Spot {
    let (sin, cos) = s.angle.to_radians().sin_cos();
    let (ox, oy) = (off.0 * s.scale, off.1 * s.scale);
    Spot { cx: s.cx - (ox * cos - oy * sin), cy: s.cy - (ox * sin + oy * cos), ..*s }
}

fn center_there(s: &Spot, off: (f32, f32)) -> Spot {
    center_back(s, (-off.0, -off.1))
}

/// How much each crop looks like the mark, worked out side by side.
fn agreed<'a>(
    list: Vec<(usize, &'a Crop, Option<f32>, f32)>,
    layer: Option<&Layer>,
) -> Vec<(usize, &'a Crop, Option<f32>, f32)> {
    let Some(l) = layer else { return list };
    let threads = std::thread::available_parallelism().map(|n| n.get() / 2).unwrap_or(1).clamp(1, 6);
    let next = std::sync::atomic::AtomicUsize::new(0);
    let out = std::sync::Mutex::new(vec![None; list.len()]);
    std::thread::scope(|sc| {
        for _ in 0..threads.min(list.len()) {
            sc.spawn(|| loop {
                let k = next.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                let Some(x) = list.get(k) else { break };
                let v = l.agrees(x.1);
                out.lock().unwrap_or_else(|e| e.into_inner())[k] = v;
            });
        }
    });
    let out = out.into_inner().unwrap_or_else(|e| e.into_inner());
    list.into_iter().zip(out).map(|((i, c, _, s), v)| (i, c, v, s)).collect()
}

/// Two finds on one picture as one.
fn join(a: &Hit, b: &Hit) -> Hit {
    let (x0, y0) = (a.region.x.min(b.region.x), a.region.y.min(b.region.y));
    let x1 = (a.region.x + a.region.w).max(b.region.x + b.region.w);
    let y1 = (a.region.y + a.region.h).max(b.region.y + b.region.h);
    let mut mask = GrayImage::new(x1 - x0, y1 - y0);
    for h in [a, b] {
        for (x, y, p) in h.mask.enumerate_pixels() {
            if p[0] > 0 {
                mask.put_pixel(h.region.x - x0 + x, h.region.y - y0 + y, Luma([255]));
            }
        }
    }
    Hit {
        mask,
        bbox: (x0, y0, x1 - 1, y1 - 1),
        region: Rect { x: x0, y: y0, w: x1 - x0, h: y1 - y0 },
        contrast: a.contrast,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A picture's own background: a colour, a gradient, a little grain.
    fn backdrop(seed: u32) -> RgbaImage {
        let base = [[200u32, 180, 150], [90, 120, 200], [60, 70, 60], [230, 225, 220], [150, 90, 80], [30, 40, 90], [120, 160, 110], [180, 200, 230]]
            [seed as usize % 8];
        RgbaImage::from_fn(760, 420, |x, y| {
            let n = (x.wrapping_mul(73_856_093) ^ y.wrapping_mul(19_349_663) ^ (seed * 977)).wrapping_mul(2_654_435_761) >> 29;
            let v = |c: u32| (c + x * 20 / 760 + y * 15 / 420 + n).min(250) as u8;
            image::Rgba([v(base[0]), v(base[1]), v(base[2]), 255])
        })
    }

    /// Which of the mark's colours is at a place (px from its box): 1 = white letters,
    /// 2 = a yellow disc, 3 = a dark bar.
    fn part(x: i32, y: i32) -> u8 {
        if (x - 330).pow(2) + (y - 60).pow(2) < 48i32.pow(2) {
            return 2;
        }
        if (20..90).contains(&y) && (0..270).contains(&x) && x % 60 < 26 || (74..90).contains(&y) && (0..270).contains(&x) {
            return 1;
        }
        if (118..128).contains(&y) && (10..260).contains(&x) && x % 24 < 14 {
            return 3;
        }
        0
    }

    /// The mark on a picture: a dark shadow of the letters, a pale glow of the bar, the
    /// mark itself. Its box starts at (ox, oy).
    fn put(img: &mut RgbaImage, ox: i32, oy: i32) {
        let mut white = vec![0f32; 520 * 260];
        let mut dark = vec![0f32; 520 * 260];
        for y in 0..260i32 {
            for x in 0..520i32 {
                // (60 px of room; the shadow falls 7 px down and left)
                white[(y * 520 + x) as usize] = (part(x - 60 + 7, y - 60 - 7) == 1) as i32 as f32;
                dark[(y * 520 + x) as usize] = (part(x - 60, y - 60) == 3) as i32 as f32;
            }
        }
        let shadow = blur(&white, 520, 260, 2.5);
        let glow = blur(&dark, 520, 260, 8.0);
        for y in 0..260i32 {
            for x in 0..520i32 {
                let (gx, gy) = (ox - 60 + x, oy - 60 + y);
                if gx < 0 || gy < 0 || gx >= img.width() as i32 || gy >= img.height() as i32 {
                    continue;
                }
                let i = (y * 520 + x) as usize;
                let p = img.get_pixel_mut(gx as u32, gy as u32);
                for c in 0..3 {
                    let mut v = p[c] as f32;
                    let s = shadow[i] * 0.35;
                    v = v * (1.0 - s) + 20.0 * s;
                    let g = (glow[i] * 0.9).min(0.35);
                    v = v * (1.0 - g) + 255.0 * g;
                    v = match part(x - 60, y - 60) {
                        1 => 255.0,
                        2 => [245.0, 198.0, 92.0][c],
                        3 => 5.0,
                        _ => v,
                    };
                    p[c] = v.round() as u8;
                }
            }
        }
    }

    #[test]
    fn shadow_glow_and_a_forgotten_part_are_learned_and_come_off() {
        // framed: only the letters and the bar, the disc was forgotten (its box is there)
        let mask = GrayImage::from_fn(380, 130, |x, y| {
            let p = part(x as i32, y as i32);
            Luma([if p == 1 || p == 3 || (x > 372 && y < 3) { 255 } else { 0 }])
        });
        let m = crate::wm_motif::motif_from_mask(&mask, 14.0, 760, 420).unwrap();
        let (x0, y0, x1, y1) = crate::edit::mask_bbox(&mask).unwrap();
        let canvas = Canvas::of(&m);
        let at = |ox: i32, oy: i32| Spot {
            cx: ox as f32 + (x0 + x1 + 1) as f32 / 2.0,
            cy: oy as f32 + (y0 + y1 + 1) as f32 / 2.0,
            scale: 1.0,
            angle: 0.0,
        };
        let spots: Vec<(i32, i32)> = (0..8).map(|k| (120 + k * 17, 110 + k * 11)).collect();
        let pics: Vec<RgbaImage> = (0..8)
            .map(|k| {
                let mut i = backdrop(k as u32);
                put(&mut i, spots[k].0, spots[k].1);
                i
            })
            .collect();
        let crops: Vec<Crop> = pics.iter().zip(&spots).map(|(i, s)| canvas.crop(i, &at(s.0, s.1)).unwrap()).collect();
        assert!(learn(&m, &crops.iter().take(3).collect::<Vec<_>>(), true).is_none(), "three pictures say nothing");
        let l = learn(&m, &crops.iter().collect::<Vec<_>>(), true).expect("learned");
        // told from a picture without it
        for c in &crops {
            assert!(l.agrees(c).unwrap() > SAME, "{:?}", l.agrees(c));
        }
        let blank = canvas.crop(&backdrop(3), &at(200, 150)).unwrap();
        assert!(l.agrees(&blank).unwrap() < MAYBE, "{:?}", l.agrees(&blank));

        for k in [0usize, 2, 5] {
            let (ox, oy) = spots[k];
            let truth = backdrop(k as u32);
            let mut img = pics[k].clone();
            l.lift(&mut img, &at(ox, oy));
            let hit = l.hit(&at(ox, oy), 2, 760, 420).unwrap();
            let filled = |x: u32, y: u32| {
                let r = &hit.region;
                x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h && hit.mask.get_pixel(x - r.x, y - r.y)[0] > 0
            };
            // every px of the mark is filled, the disc too
            let (mut all, mut got) = (0u32, 0u32);
            let (mut before, mut after, mut n) = (0f32, 0f32, 0f32);
            let mut far = 0u32;
            for y in 0..420u32 {
                for x in 0..760u32 {
                    let p = part(x as i32 - ox, y as i32 - oy);
                    if p > 0 {
                        all += 1;
                        got += filled(x, y) as u32;
                    } else if !filled(x, y) {
                        let d = |i: &RgbaImage| (0..3).map(|c| (i.get_pixel(x, y)[c] as f32 - truth.get_pixel(x, y)[c] as f32).abs()).sum::<f32>() / 3.0;
                        let b = d(&pics[k]);
                        if b > 8.0 {
                            before += b;
                            after += d(&img);
                            n += 1.0;
                        }
                    } else {
                        far += 1;
                    }
                }
            }
            assert!(got as f32 > 0.985 * all as f32, "picture {k}: {got} of {all}");
            // not much more than it: the shadow's and glow's faint parts are calculated
            assert!(far < all * 2, "picture {k}: {far} extra against {all}");
            assert!(n == 0.0 || after / n < 0.3 * before / n, "picture {k}: {:.1} -> {:.1} over {n}", before / n, after / n);
        }
    }

    #[test]
    fn the_learned_mark_keeps_its_place() {
        let s = Spot { cx: 300.0, cy: 200.0, scale: 1.5, angle: 10.0 };
        let back = center_back(&center_there(&s, (12.0, -7.0)), (12.0, -7.0));
        assert!((back.cx - s.cx).abs() < 1e-3 && (back.cy - s.cy).abs() < 1e-3);
    }

    fn save_maps(l: &Layer, out: &std::path::Path) {
        let (cw, ch) = (l.canvas.w as u32, l.canvas.h as u32);
        GrayImage::from_fn(cw, ch, |x, y| Luma([(l.a[(y * cw + x) as usize] * 255.0) as u8])).save(out.join("l_a.png")).unwrap();
        GrayImage::from_fn(cw, ch, |x, y| Luma([(l.fill[(y * cw + x) as usize] * 255.0) as u8])).save(out.join("l_fill.png")).unwrap();
        GrayImage::from_fn(cw, ch, |x, y| Luma([l.mark[(y * cw + x) as usize] as u8 * 255])).save(out.join("l_mark.png")).unwrap();
        RgbaImage::from_fn(cw, ch, |x, y| {
            let p = (y * cw + x) as usize;
            let c = l.ac[p].map(|v| if l.a[p] > 0.01 { (v / l.a[p]).clamp(0.0, 255.0) as u8 } else { 128 });
            image::Rgba([c[0], c[1], c[2], 255])
        })
        .save(out.join("l_c.png"))
        .unwrap();
    }

    /// Before, with the faint parts off, filled: one above the other.
    fn show(img: &RgbaImage, l: &Layer, spot: &Spot, hit: &Hit, m: &Motif, to: &std::path::Path) {
        let (w, h) = img.dimensions();
        let mut o = img.clone();
        l.lift(&mut o, spot);
        let lifted = o.clone();
        let mut full = GrayImage::new(w, h);
        for (x, y, q) in hit.mask.enumerate_pixels() {
            if q[0] > 0 {
                full.put_pixel(hit.region.x + x, hit.region.y + y, Luma([255]));
            }
        }
        if let Ok(ad) = std::env::var("WM_APPDATA") {
            crate::wm_motif::remove_motif(std::path::Path::new(&ad), &mut o, &full, m.stroke * spot.scale, &|| false).unwrap();
        }
        let (x0, y0, x1, y1) = hit.bbox;
        let pad = (x1 - x0) / 6;
        let (cx, cy) = (x0.saturating_sub(pad), y0.saturating_sub(pad));
        let (cw, ch) = ((x1 + pad).min(w - 1) - cx, (y1 + pad).min(h - 1) - cy);
        let (tw, th) = (700u32, (700.0 * ch as f32 / cw as f32) as u32);
        let cut = |i: &RgbaImage| {
            imageops::resize(&imageops::crop_imm(i, cx, cy, cw, ch).to_image(), tw, th, imageops::FilterType::Triangle)
        };
        let mut v = RgbaImage::new(tw, th * 3);
        for (k, i) in [img, &lifted, &o].iter().enumerate() {
            imageops::replace(&mut v, &cut(i), 0, (th * k as u32) as i64);
        }
        v.save(to).unwrap();
    }

    /// Real pictures: WM_MOTIF (orig/, box.txt), WM_ONLY names to remove it from,
    /// WM_APPDATA for LaMa. Not part of the normal run.
    #[test]
    #[ignore]
    fn layer_real() {
        let Ok(dir) = std::env::var("WM_MOTIF") else { return };
        let dir = std::path::PathBuf::from(dir);
        let b = std::fs::read_to_string(dir.join(std::env::var("WM_BOX").unwrap_or("box.txt".into()))).unwrap();
        let p: Vec<&str> = b.split_whitespace().collect();
        let v = |i: usize| p[i].parse::<u32>().unwrap();
        let load_name = |f: &str| image::open(dir.join("orig").join(f)).ok().map(|i| i.to_rgba8());
        let mut names: Vec<String> =
            std::fs::read_dir(dir.join("orig")).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
        names.sort();
        let r = load_name(p[0]).unwrap();
        let (mask, stroke) = crate::wm_motif::mark_in_box(&r, v(1), v(2), v(3), v(4)).expect("mark");
        let m = crate::wm_motif::motif_from_mask(&mask, stroke, r.width(), r.height()).unwrap();
        let (bx, by, _, _) = crate::edit::mask_bbox(&mask).unwrap();
        let spot = Spot {
            cx: (v(1) + bx) as f32 + m.mask.width() as f32 / 2.0,
            cy: (v(2) + by) as f32 + m.mask.height() as f32 / 2.0,
            scale: 1.0,
            angle: 0.0,
        };
        let own_hit = crate::wm_motif::own_hit(&mask, v(1), v(2), stroke, r.width(), r.height()).unwrap();
        let k = names.iter().position(|n| n == p[0]).unwrap();
        let out = dir.join("out");
        std::fs::create_dir_all(&out).unwrap();
        m.mask.save(out.join("framed.png")).unwrap();
        let t = std::time::Instant::now();
        let (found, layer) = hunt(names.len(), &|i| load_name(&names[i]), &m, Some((k, spot, own_hit)), true, &|| false, &|_, _, _| ());
        eprintln!("hunt {:?}", t.elapsed());
        for (n, f) in names.iter().zip(&found) {
            match f {
                Some(f) => eprintln!(
                    "{n}: {} at {:.0},{:.0} x{:.3} {:.2}",
                    if f.unsure { "UNSURE" } else { "found" },
                    f.spot.cx,
                    f.spot.cy,
                    f.spot.scale,
                    f.spot.angle
                ),
                None => eprintln!("{n}: none"),
            }
        }
        let Some(l) = &layer else {
            eprintln!("no layer");
            return;
        };
        save_maps(l, &out);
        eprintln!("layer sure {} dots {}", l.sure, l.dots.len());
        let Ok(only) = std::env::var("WM_ONLY") else { return };
        for (n, f) in names.iter().zip(&found).filter(|(n, _)| only.split(',').any(|o| n.starts_with(o))) {
            let (Some(img), Some(f)) = (load_name(n), f) else { continue };
            let t = std::time::Instant::now();
            show(&img, l, &f.spot, &f.hit, &m, &out.join(format!("r_{n}.png")));
            eprintln!("{n} removed {:?}", t.elapsed());
        }
    }
}
