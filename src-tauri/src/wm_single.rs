//! The editor's watermark tool: one picture, the same two ways as for a whole reward
//! (watermark.rs: a line of text in a corner, wm_motif.rs: a framed mark). The other
//! pictures of its reward help where they can (the whole line of text, a soft shadow);
//! they're only looked at.

use image::{GrayImage, Luma, RgbaImage};

use crate::watermark::{self, Corner, Hit, Rect, Template, Tried};
use crate::wm_motif;

/// Opens one of the reward's other pictures.
pub type Load<'a> = &'a (dyn Fn(&str) -> Option<RgbaImage> + Sync);

/// The same for each, a few side by side, the results in order.
fn each<T: Sync, R: Send>(list: &[T], run: impl Fn(&T) -> R + Sync) -> Vec<R> {
    use std::sync::atomic::{AtomicUsize, Ordering};
    let threads = std::thread::available_parallelism().map(|n| n.get() / 2).unwrap_or(1).clamp(1, 3);
    let next = AtomicUsize::new(0);
    let out: std::sync::Mutex<Vec<(usize, R)>> = std::sync::Mutex::new(Vec::new());
    std::thread::scope(|sc| {
        for _ in 0..threads.min(list.len()) {
            sc.spawn(|| loop {
                let i = next.fetch_add(1, Ordering::Relaxed);
                let Some(x) = list.get(i) else { break };
                let r = run(x);
                out.lock().unwrap_or_else(|e| e.into_inner()).push((i, r));
            });
        }
    });
    let mut out = out.into_inner().unwrap_or_else(|e| e.into_inner());
    out.sort_by_key(|x| x.0);
    out.into_iter().map(|x| x.1).collect()
}

/// `n` of the list from all over it (neighbours often have the same background), in an
/// order in which the first few are spread out too.
pub fn spread(list: Vec<String>, n: usize) -> Vec<String> {
    let k = n.min(list.len());
    let mut at: Vec<usize> = (0..k).collect();
    let bits = usize::BITS - k.next_power_of_two().leading_zeros();
    at.sort_by_key(|j| j.reverse_bits() >> (usize::BITS - bits.max(1)));
    at.into_iter().map(|j| list[j * list.len() / k].clone()).collect()
}

/// No further picture is opened after this long (huge ones take over a second each).
const LOOK_FOR: std::time::Duration = std::time::Duration::from_secs(8);

/// A line of text in the given corners of a picture, full size. Like the search over a
/// whole reward: the line as the other pictures show it, where it fits here, else the
/// picture's own find. strength (0..1) is for its own, higher finds fainter text.
pub fn text_mask(img: &RgbaImage, others: &[String], load: Load, corners: &[Corner], strength: f32) -> Option<GrayImage> {
    let own: Vec<Option<Hit>> = corners.iter().map(|c| watermark::find_text(img, *c, strength)).collect();
    // the others' finds (only the ones that can be opened)
    let start = std::time::Instant::now();
    let seen: Vec<(String, (u32, u32), Vec<Option<Hit>>)> = each(others, |p| {
        if start.elapsed() > LOOK_FOR {
            return None;
        }
        let o = load(p)?;
        Some((p.clone(), o.dimensions(), corners.iter().map(|c| watermark::find_text(&o, *c, 0.6)).collect()))
    })
    .into_iter()
    .flatten()
    .collect();
    let sizes: Vec<(u32, u32)> = std::iter::once(img.dimensions()).chain(seen.iter().map(|s| s.1)).collect();

    let mut out = GrayImage::new(img.width(), img.height());
    let mut any = false;
    for (ci, corner) in corners.iter().enumerate() {
        let finds: Vec<Option<&Hit>> =
            std::iter::once(own[ci].as_ref()).chain(seen.iter().map(|s| s.2[ci].as_ref())).collect();
        let list: Vec<((u32, u32), Option<&Hit>)> = sizes.iter().copied().zip(finds.iter().copied()).collect();
        let templates: Vec<Template> = watermark::template_sources(&list)
            .into_iter()
            .filter_map(|k| {
                let loaded;
                let pic = if k == 0 {
                    img
                } else {
                    loaded = load(&seen[k - 1].0)?;
                    &loaded
                };
                let mut t = Template::from_hit(finds[k]?, pic, *corner);
                let rest: Vec<&Hit> =
                    (0..finds.len()).filter(|j| *j != k && sizes[*j] == sizes[k]).filter_map(|j| finds[j]).collect();
                t.fill_in(pic, &rest);
                Some(t)
            })
            .collect();
        let mine = watermark::try_templates(img, &templates);
        // only fits by what the others say: then they're asked
        let ask = mine.fit.is_none() && mine.reserve.is_some();
        let mut tried = vec![mine];
        tried.extend(if ask {
            each(&seen, |s| match load(&s.0) {
                Some(o) => watermark::try_templates(&o, &templates),
                None => Tried { fit: None, reserve: None },
            })
        } else {
            seen.iter().map(|_| Tried { fit: None, reserve: None }).collect()
        });
        if let Some((hit, _)) = watermark::choose(&sizes, &finds, tried).into_iter().next().flatten() {
            any = true;
            lay(&mut out, &hit);
        }
    }
    (any && out.pixels().any(|p| p[0] > 0)).then_some(out)
}

fn lay(out: &mut GrayImage, hit: &Hit) {
    for (x, y, p) in hit.mask.enumerate_pixels() {
        let (gx, gy) = (hit.region.x + x, hit.region.y + y);
        if p[0] > 0 && gx < out.width() && gy < out.height() {
            out.put_pixel(gx, gy, Luma([255]));
        }
    }
}

/// The selection's parts that are apart (a text in two corners, two logos): their boxes,
/// what's closer than `gap` px counts as one.
fn parts(mask: &GrayImage, gap: u32) -> Vec<Rect> {
    const CELL: u32 = 8;
    let (w, h) = mask.dimensions();
    let mut small = GrayImage::new(w.div_ceil(CELL).max(1), h.div_ceil(CELL).max(1));
    for (x, y, p) in mask.enumerate_pixels() {
        if p[0] > 0 {
            small.put_pixel(x / CELL, y / CELL, Luma([255]));
        }
    }
    let mut boxes: Vec<(u32, u32, u32, u32)> = watermark::components(&small)
        .1
        .iter()
        .map(|c| (c.x0 * CELL, c.y0 * CELL, (c.x1 + 1) * CELL, (c.y1 + 1) * CELL))
        .collect();
    // until nothing is close to anything else
    'again: loop {
        for i in 0..boxes.len() {
            for j in i + 1..boxes.len() {
                let (a, b) = (boxes[i], boxes[j]);
                if a.0 < b.2 + gap && b.0 < a.2 + gap && a.1 < b.3 + gap && b.1 < a.3 + gap {
                    boxes[i] = (a.0.min(b.0), a.1.min(b.1), a.2.max(b.2), a.3.max(b.3));
                    boxes.swap_remove(j);
                    continue 'again;
                }
            }
        }
        break;
    }
    boxes.sort();
    boxes.into_iter().map(|b| Rect { x: b.0, y: b.1, w: b.2.min(w) - b.0, h: b.3.min(h) - b.1 }).collect()
}

/// Only what's in the box.
fn only(mask: &GrayImage, r: &Rect) -> GrayImage {
    let mut out = GrayImage::new(mask.width(), mask.height());
    let cut = image::imageops::crop_imm(mask, r.x, r.y, r.w, r.h).to_image();
    image::imageops::replace(&mut out, &cut, r.x as i64, r.y as i64);
    out
}

/// Take a line of text off (LaMa along the line).
pub fn remove_text(data: &std::path::Path, img: &mut RgbaImage, mask: &GrayImage) -> Result<(), String> {
    for r in parts(mask, 64) {
        watermark::remove_in_pieces(data, img, &only(mask, &r), &|| false)?;
    }
    Ok(())
}

/// Take a mark off: its soft shadow first when the other pictures show one, then the mark
/// (LaMa in tiles). stroke = its strokes' width, 0 = measured.
pub fn remove_mark(
    data: &std::path::Path,
    img: &mut RgbaImage,
    mask: &GrayImage,
    stroke: f32,
    others: &[String],
    load: Load,
) -> Result<(), String> {
    let (w, h) = img.dimensions();
    let parts = parts(mask, 320);
    let one = parts.len() == 1;
    for r in parts {
        let cut = image::imageops::crop_imm(mask, r.x, r.y, r.w, r.h).to_image();
        let Some((x0, y0, x1, y1)) = crate::edit::mask_bbox(&cut) else { continue };
        let (bx, by) = (r.x + x0, r.y + y0);
        let cut = image::imageops::crop_imm(&cut, x0, y0, x1 - x0 + 1, y1 - y0 + 1).to_image();
        let stroke = if stroke > 0.0 { stroke } else { wm_motif::stroke_width(&cut) };
        // (a shadow takes at least four pictures to tell)
        if one && others.len() >= 3 {
            if let Some((shadow, spot)) = shadow_of(img, &cut, bx, by, stroke, others, load) {
                shadow.lift(img, &spot);
            }
        }
        let Some(hit) = wm_motif::own_hit(&cut, bx, by, stroke, w, h) else { continue };
        let mut full = GrayImage::new(w, h);
        lay(&mut full, &hit);
        wm_motif::remove_motif(data, img, &full, stroke, &|| false)?;
    }
    Ok(())
}

/// The soft shadow the mark has on all pictures it's found on, and where it is here.
fn shadow_of(
    img: &RgbaImage,
    cut: &GrayImage,
    bx: u32,
    by: u32,
    stroke: f32,
    others: &[String],
    load: Load,
) -> Option<(wm_motif::Shadow, wm_motif::Spot)> {
    let motif = wm_motif::motif_from_mask(cut, stroke, img.width(), img.height())?;
    let spot = wm_motif::Spot {
        cx: bx as f32 + motif.mask.width() as f32 / 2.0,
        cy: by as f32 + motif.mask.height() as f32 / 2.0,
        scale: 1.0,
        angle: 0.0,
    };
    let parts = wm_motif::colour_parts(img, &motif, bx, by);
    let mut around = wm_motif::Around::new(&motif);
    around.add(&around.look(img, &spot));
    let seen = each(others, |p| {
        let o = load(p)?;
        let hit = wm_motif::find_motif(&o, &motif, &|| false)?;
        (hit.score >= wm_motif::MOTIF_MIN && hit.spot.angle.abs() < 0.5).then(|| around.look(&o, &hit.spot))
    });
    for s in seen.into_iter().flatten() {
        around.add(&s);
    }
    Some((around.shadow(&parts)?, spot))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_keeps_the_order() {
        let list: Vec<u32> = (0..20).collect();
        assert_eq!(each(&list, |x| x * 2), list.iter().map(|x| x * 2).collect::<Vec<_>>());
        assert!(each(&Vec::<u32>::new(), |x| *x).is_empty());
    }

    #[test]
    fn the_others_come_from_all_over_the_reward() {
        let list: Vec<String> = (0..40).map(|i| i.to_string()).collect();
        let all = spread(list.clone(), 100);
        assert_eq!(all.iter().collect::<std::collections::HashSet<_>>().len(), 40);
        for n in [1usize, 3, 8, 24] {
            let got = spread(list.clone(), n);
            assert_eq!(got.iter().collect::<std::collections::HashSet<_>>().len(), n);
        }
        // the first four of 24 already reach over most of it
        let first: Vec<u32> = spread(list, 24).iter().take(4).map(|x| x.parse().unwrap()).collect();
        assert!(first.iter().max().unwrap() - first.iter().min().unwrap() >= 24, "{first:?}");
        assert!(spread(Vec::new(), 8).is_empty());
    }

    #[test]
    fn parts_far_apart_are_filled_on_their_own() {
        let mut m = GrayImage::new(1000, 700);
        let mut dot = |x: u32, y: u32, w: u32, h: u32| {
            for yy in y..y + h {
                for xx in x..x + w {
                    m.put_pixel(xx, yy, Luma([255]));
                }
            }
        };
        // a line of letters bottom right (up to the edge), one top left
        for k in 0..8 {
            dot(700 + k * 38, 660, 20, 40);
        }
        dot(10, 12, 60, 16);
        dot(100, 12, 30, 16);
        let got = parts(&m, 64);
        assert_eq!(got.len(), 2, "{got:?}", got = got.iter().map(|r| (r.x, r.y, r.w, r.h)).collect::<Vec<_>>());
        assert!(got[0].x <= 10 && got[0].x + got[0].w >= 130 && got[0].y + got[0].h < 60);
        assert!(got[1].x <= 700 && got[1].x + got[1].w >= 986 && got[1].y + got[1].h == 700);
        assert_eq!(only(&m, &got[0]).pixels().filter(|p| p[0] > 0).count(), 60 * 16 + 30 * 16);
        assert!(parts(&GrayImage::new(50, 50), 64).is_empty());
    }

    /// "handle" in light strokes at the bottom right of a soft background.
    fn picture(seed: u32, busy_left: bool) -> RgbaImage {
        let (w, h) = (1200u32, 900u32);
        let mut img = RgbaImage::from_fn(w, h, |x, y| {
            let v = 70 + ((x + seed * 37) * 60 / w) as u8 + (y * 40 / h) as u8;
            image::Rgba([v, v.saturating_sub(10), v.saturating_add(5), 255])
        });
        let ch = 26u32;
        // (no two letters alike, or the line fits a letter further along too)
        const AT: [u32; 9] = [0, 21, 39, 62, 79, 103, 120, 138, 162];
        for i in 0..9u32 {
            let lx = 980 + AT[i as usize];
            // on one picture the first letters drown in a bright patch
            if busy_left && i < 3 {
                for yy in 840..884 {
                    for xx in lx - 4..lx + 18 {
                        img.put_pixel(xx, yy, image::Rgba([214, 214, 214, 255]));
                    }
                }
            }
            for yy in 850..850 + ch {
                for dx in 0..2 {
                    img.put_pixel(lx + dx, yy, image::Rgba([215, 215, 215, 255]));
                    img.put_pixel(lx + 12 + dx, yy, image::Rgba([215, 215, 215, 255]));
                }
            }
            for xx in lx..lx + 14 {
                for dy in 0..2 {
                    img.put_pixel(xx, 850 + (i * 7 % 5) * 6 + dy, image::Rgba([215, 215, 215, 255]));
                }
            }
        }
        img
    }

    #[test]
    fn the_other_pictures_complete_the_line() {
        let load = |p: &str| p.parse::<u32>().ok().map(|n| picture(n, false));
        let img = picture(0, true);
        let left_of = |m: &GrayImage| crate::edit::mask_bbox(m).unwrap().0;
        let alone = text_mask(&img, &[], &load, &[Corner::BottomRight], 0.6).expect("found alone");
        let others: Vec<String> = (1..6).map(|n| n.to_string()).chain(["not a picture".to_string()]).collect();
        let with = text_mask(&img, &others, &load, &[Corner::BottomRight], 0.6).expect("found");
        assert!(left_of(&alone) > 1000, "alone it starts at {}", left_of(&alone));
        assert!(left_of(&with) < 985, "with the others it starts at {}", left_of(&with));
        assert_eq!(with.dimensions(), img.dimensions());
        // nothing in a corner without text
        assert!(text_mask(&img, &others, &load, &[Corner::TopLeft], 0.6).is_none());
    }
}
