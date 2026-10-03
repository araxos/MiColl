//! Folder indexer.
//! Creator downloads don't have a fixed layout, so the indexer guesses: artist and
//! period from folder names, each subfolder is a reward (a gallery), and anything
//! unclear (like an unknown platform) is flagged needs_review. It never moves or
//! changes files.

use crate::db;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

const IMAGE_EXTS: &[&str] = &[
    "jpg", "jpeg", "jfif", "png", "gif", "webp", "bmp", "avif", "tif", "tiff",
];
const VIDEO_EXTS: &[&str] = &["mp4", "webm", "mov", "m4v", "mkv", "avi", "wmv", "flv"];
/// archives inside a content folder show as their own tiles (zip icon) so they can
/// be found and extracted later (a dropped archive is still extracted on import)
const ARCHIVE_EXTS: &[&str] = &["zip", "rar", "7z", "cbz", "cbr", "tar", "gz"];

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ScanSummary {
    pub artists: i64,
    pub periods: i64,
    pub rewards: i64,
    pub images: i64,
    pub needs_review: i64,
}

/* ---- pure parsing helpers (unit-tested) ------------------------------ */

const SEPARATORS: &str = "-_./ ";

pub fn fmt_label(y: i64, m: Option<i64>) -> String {
    match m {
        Some(m) => format!("{:04}-{:02}", y, m),
        None => format!("{}", y),
    }
}

/// Label of a numbered drop ("#51"), also the folder name organize writes.
pub fn fmt_number_label(n: i64) -> String {
    format!("#{n}")
}

/// Folder name "#51" (or "# 51"). The managed collection uses it, so it's always a drop.
fn numbered_token(name: &str) -> Option<i64> {
    let rest = name.trim().strip_prefix('#')?.trim_start();
    if rest.is_empty() || rest.len() > 6 || !rest.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    rest.parse().ok()
}

/// A folder name that's just a number (a possible drop like "51" in 51..55).
/// Year-like values are excluded. Months 1-12 are allowed here, the context decides.
fn plain_number(name: &str) -> Option<i64> {
    let t = name.trim();
    if t.is_empty() || t.len() > 4 || !t.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let n: i64 = t.parse().ok()?;
    if (1900..=2999).contains(&n) {
        return None;
    }
    Some(n)
}

/// Do these sibling names form a numbered run (e.g. "51".."55")?
/// Needs >= 2 numbers making up >= 60% of the siblings, within 400 of each other,
/// and either one > 12 or at least 4 of them (4+ bare 1-12 folders without a year
/// above are more likely drops, the import lets the user change it).
fn is_numbered_run(names: &[String]) -> bool {
    let nums: Vec<i64> = names.iter().filter_map(|n| plain_number(n)).collect();
    if nums.len() < 2 || nums.len() * 10 < names.len() * 6 {
        return false;
    }
    let max = *nums.iter().max().unwrap();
    let min = *nums.iter().min().unwrap();
    (nums.iter().any(|&n| n > 12) || nums.len() >= 4) && max - min <= 400
}

/// Drop number of a folder name: "#51" always counts, a bare "51" only inside a run.
fn drop_number(name: &str, run_active: bool) -> Option<i64> {
    numbered_token(name).or_else(|| if run_active { plain_number(name) } else { None })
}

/// Token -> month number if it's a month name.
fn month_word(token: &str) -> Option<i64> {
    Some(match token {
        "jan" | "january" => 1,
        "feb" | "february" => 2,
        "mar" | "march" => 3,
        "apr" | "april" => 4,
        "may" => 5,
        "jun" | "june" => 6,
        "jul" | "july" => 7,
        "aug" | "august" => 8,
        "sep" | "sept" | "september" => 9,
        "oct" | "october" => 10,
        "nov" | "november" => 11,
        "dec" | "december" => 12,
        _ => return None,
    })
}

/// Find a month name anywhere in a lowercase string -> 1-12.
fn month_from_name(lower: &str) -> Option<i64> {
    lower
        .split(|c: char| !c.is_ascii_alphabetic())
        .find_map(month_word)
}

/// Like parse_date_token, but only if the name is basically just a date
/// ("2026-02", "Feb 2026"), not a name with a date in it ("Pixelfox240_2026-02").
fn date_level(name: &str) -> Option<(i64, Option<i64>)> {
    let (y, m, _) = parse_date_token(name)?;
    let lower = name.to_ascii_lowercase();
    let alpha_tokens: Vec<&str> = lower
        .split(|c: char| !c.is_ascii_alphabetic())
        .filter(|t| !t.is_empty())
        .collect();
    // only digits/separators, or every word is a month
    if alpha_tokens.is_empty() || alpha_tokens.iter().all(|t| month_word(t).is_some()) {
        Some((y, m))
    } else {
        None
    }
}

/// Platform names this library already uses (on top of the built-ins).
/// A global because "is this a platform?" is asked from many places without a DB handle.
/// Refreshed once per scan by refresh_known_platforms.
static KNOWN_PLATFORMS: std::sync::RwLock<Vec<String>> = std::sync::RwLock::new(Vec::new());

/// Load the library's platform names before a scan.
/// Without this a rescan only knows the built-ins, so a custom platform (Weibo etc.)
/// would end up as "Unsorted".
pub fn refresh_known_platforms(conn: &Connection) -> rusqlite::Result<()> {
    let names: Vec<String> =
        db::known_platforms(conn)?.into_iter().filter(|n| is_usable_platform(n)).collect();
    if let Ok(mut w) = KNOWN_PLATFORMS.write() {
        *w = names;
    }
    Ok(())
}

/// Don't learn our own structural words. The scanner writes the periods it learns
/// from, so a mistake would repeat forever. "Misc" (no date) and "Unsorted" (no
/// platform) are never platforms, and nothing that looks like a date.
/// "Unknown" IS allowed, the app offers it as a platform.
fn is_usable_platform(name: &str) -> bool {
    let t = name.trim();
    if t.is_empty() {
        return false;
    }
    if matches!(t.to_ascii_lowercase().as_str(), "misc" | "unsorted") {
        return false;
    }
    // a date or a number is a period, not a platform
    date_level(t).is_none() && parse_date_token(t).is_none() && numbered_token(t).is_none()
}

fn normalize_platform(name: &str) -> String {
    name.to_ascii_lowercase().chars().filter(|c| c.is_ascii_alphanumeric()).collect()
}

/// The platform name if a folder name is a known platform.
fn platform_from_name(name: &str) -> Option<String> {
    let normalized = normalize_platform(name);
    const KNOWN: &[(&str, &str)] = &[
        ("patreon", "Patreon"),
        ("kofi", "Ko-Fi"),
        ("fansly", "Fansly"),
        ("onlyfans", "OnlyFans"),
        ("gumroad", "Gumroad"),
        ("fanbox", "Fanbox"),
        ("pixivfanbox", "Fanbox"),
        ("subscribestar", "SubscribeStar"),
        ("boosty", "Boosty"),
        ("fantia", "Fantia"),
    ];
    for (key, canon) in KNOWN {
        if normalized.contains(key) {
            return Some((*canon).to_string());
        }
    }
    // "Unknown" as a whole name is a platform (the app offers it).
    // Not as part of a name ("Unknown_Artist_2024" is a reward).
    if normalized == "unknown" {
        return Some("Unknown".to_string());
    }
    // then the library's own names, whole names only (a platform "Art" must not match
    // "Artbook")
    if !normalized.is_empty() {
        if let Ok(known) = KNOWN_PLATFORMS.read() {
            if let Some(hit) = known.iter().find(|k| normalize_platform(k) == normalized) {
                return Some(hit.clone());
            }
        }
    }
    None
}

/// A month folder under a known year, e.g. "02", "2" or "February".
fn bare_month(name: &str) -> Option<i64> {
    let t = name.trim();
    if let Ok(n) = t.parse::<i64>() {
        if (1..=12).contains(&n) && t.len() <= 2 {
            return Some(n);
        }
    }
    let lower = t.to_ascii_lowercase();
    let tokens: Vec<&str> = lower
        .split(|c: char| !c.is_ascii_alphabetic())
        .filter(|s| !s.is_empty())
        .collect();
    if tokens.len() == 1 {
        return month_word(tokens[0]);
    }
    None
}

/// Parse a folder name that is a date/period. Understands:
/// 2026-02, 2026.02, 2026_2, 2026 02, 202602, 2026-02-15, Feb 2026,
/// February 2026, 02.26, 01.25 and a bare 2026.
/// Returns (year, Some(month) | None, label "YYYY-MM"/"YYYY").
pub fn parse_date_token(s: &str) -> Option<(i64, Option<i64>, String)> {
    let t = s.trim();
    if t.is_empty() {
        return None;
    }
    let lower = t.to_ascii_lowercase();

    // digit runs with their positions
    let mut runs: Vec<(usize, usize, &str)> = Vec::new();
    let mut start: Option<usize> = None;
    for (i, c) in t.char_indices() {
        if c.is_ascii_digit() {
            start.get_or_insert(i);
        } else if let Some(s0) = start.take() {
            runs.push((s0, i, &t[s0..i]));
        }
    }
    if let Some(s0) = start.take() {
        runs.push((s0, t.len(), &t[s0..]));
    }

    let is_year = |d: &str| d.len() == 4 && d.parse::<i64>().map(|y| (1900..=2999).contains(&y)).unwrap_or(false);

    // A: a month name + a 4-digit year (any order)
    if let Some(m) = month_from_name(&lower) {
        if let Some((_, _, d)) = runs.iter().find(|(_, _, d)| is_year(d)) {
            let y: i64 = d.parse().unwrap();
            return Some((y, Some(m), fmt_label(y, Some(m))));
        }
    }

    // B: 6 digits YYYYMM
    for (_, _, d) in &runs {
        if d.len() == 6 {
            let y: i64 = d[0..4].parse().ok()?;
            let m: i64 = d[4..6].parse().ok()?;
            if (1900..=2999).contains(&y) && (1..=12).contains(&m) {
                return Some((y, Some(m), fmt_label(y, Some(m))));
            }
        }
    }

    // is the string only digits and separators?
    let pure = t.chars().all(|c| c.is_ascii_digit() || SEPARATORS.contains(c));

    // C: a 4-digit year + a 1-2 digit month right next to it
    // (so "2026 Collection 5" isn't read as May)
    if let Some(yi) = runs.iter().position(|(_, _, d)| is_year(d)) {
        let (ys, ye, yd) = runs[yi];
        let y: i64 = yd.parse().unwrap();
        let mut month: Option<i64> = None;
        for cand in [yi + 1, yi.wrapping_sub(1)] {
            if cand >= runs.len() || cand == yi {
                continue;
            }
            let (cs, ce, cd) = runs[cand];
            if cd.len() > 2 {
                continue;
            }
            let Ok(mv) = cd.parse::<i64>() else { continue };
            if !(1..=12).contains(&mv) {
                continue;
            }
            let between = if cand > yi { &t[ye..cs] } else { &t[ce..ys] };
            if between.chars().all(|c| SEPARATORS.contains(c)) {
                month = Some(mv);
                break;
            }
        }
        if let Some(m) = month {
            return Some((y, Some(m), fmt_label(y, Some(m))));
        }
        // bare year only if the whole name is the year
        if pure {
            return Some((y, None, fmt_label(y, None)));
        }
        return None;
    }

    // D: two numbers only, "MM.YY" or "YY.MM"
    if pure && runs.len() == 2 {
        let a: i64 = runs[0].2.parse().ok()?;
        let b = runs[1].2;
        let bn: i64 = b.parse().ok()?;
        // MM.YY, e.g. "02.26" -> 2026-02
        if (1..=12).contains(&a) && b.len() == 2 {
            let y = 2000 + bn;
            return Some((y, Some(a), fmt_label(y, Some(a))));
        }
        // YY.MM, e.g. "26.01" -> 2026-01. Only when the first can't be a month (>12)
        // and the second can, so "01.05" stays MM.YY
        if runs[0].2.len() == 2 && !(1..=12).contains(&a) && (1..=12).contains(&bn) {
            let y = 2000 + a;
            return Some((y, Some(bn), fmt_label(y, Some(bn))));
        }
    }

    None
}

/// From a name like "Pixelfox240_2026-02" get the artist name and the date.
pub fn parse_artist_period(name: &str) -> (String, Option<(i64, Option<i64>, String)>) {
    let trimmed = name.trim();
    // try to cut off a date at the end
    for sep in ['_', '-', ' ', '.'] {
        if let Some(idx) = trimmed.rfind(sep) {
            let (head, tail) = trimmed.split_at(idx);
            let tail = &tail[1..];
            // the tail could be the "02" of "2026-02", also try the head
            if let Some(date) = parse_date_token(tail) {
                let artist = head.trim_end_matches(['_', '-', ' ', '.']).trim();
                if !artist.is_empty() {
                    return (artist.to_string(), Some(date));
                }
            }
        }
    }
    // try a longer end part (the date can include a separator)
    if let Some(pos) = find_trailing_date_start(trimmed) {
        let (head, tail) = trimmed.split_at(pos);
        if let Some(date) = parse_date_token(tail) {
            let artist = head.trim_end_matches(['_', '-', ' ', '.']).trim();
            if !artist.is_empty() {
                return (artist.to_string(), Some(date));
            }
        }
    }
    (trimmed.to_string(), None)
}

/// Byte index where a date at the end (YYYY[-_.]MM) starts.
fn find_trailing_date_start(s: &str) -> Option<usize> {
    // only walk char boundaries (slicing multi-byte chars like "–" would panic),
    // a year can only start with a digit
    for (i, c) in s.char_indices() {
        if !c.is_ascii_digit() {
            continue;
        }
        let candidate = &s[i..];
        if let Some((_, Some(_), _)) = parse_date_token(candidate) {
            // use the leftmost start that still parses (full "YYYY-MM")
            let groups: Vec<&str> = candidate
                .split(|c: char| !c.is_ascii_digit())
                .filter(|p| !p.is_empty())
                .collect();
            if groups.first().map(|g| g.len()) == Some(4) {
                return Some(i);
            }
        }
    }
    None
}

fn ext_in(path: &Path, exts: &[&str]) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| exts.contains(&e.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

fn is_image(path: &Path) -> bool {
    ext_in(path, IMAGE_EXTS)
}

fn is_video(path: &Path) -> bool {
    ext_in(path, VIDEO_EXTS)
}

fn is_archive(path: &Path) -> bool {
    ext_in(path, ARCHIVE_EXTS)
}

/// MiColl's own files in a month folder that aren't content: the skip marker,
/// a template _cover.* and _cover_<ts>.png crops.
fn is_reserved(path: &Path) -> bool {
    path.file_name()
        .and_then(|s| s.to_str())
        .map(|n| {
            let lower = n.to_ascii_lowercase();
            n.eq_ignore_ascii_case(crate::db::SKIP_MARKER)
                || lower.starts_with("_cover.")
                || lower.starts_with("_cover_")
        })
        .unwrap_or(false)
}

/// Reward content: images, GIFs or videos (not our marker/cover files).
fn is_media(path: &Path) -> bool {
    !is_reserved(path) && (is_image(path) || is_video(path) || is_archive(path))
}

/// OS/app junk that never counts. .micoll-sd.json is the MiSD marker (see sd.rs).
const JUNK_FILES: &[&str] = &["thumbs.db", "desktop.ini", ".ds_store", crate::sd::MARKER];

fn is_junk(path: &Path) -> bool {
    path.file_name()
        .and_then(|s| s.to_str())
        .map(|n| JUNK_FILES.contains(&n.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

/// Every file to index inside a reward folder: ALL files (PSD, PDF...), not just media.
/// Files we can't show get a tile that opens Explorer.
/// Detection (is_media) stays stricter, a folder with only a readme isn't a gallery.
fn is_indexable(path: &Path) -> bool {
    !is_reserved(path) && !is_junk(path)
}

/// True if a folder directly has a media file (image or video), so it's a reward.
/// Media only on purpose: a root with a stray file must not become one giant reward.
fn dir_has_direct_media(dir: &Path) -> bool {
    std::fs::read_dir(dir)
        .map(|rd| rd.flatten().any(|e| e.path().is_file() && is_media(&e.path())))
        .unwrap_or(false)
}

/// True if a folder directly has ANY file worth indexing.
/// Used inside an artist's folder: a part with only PSDs used to be skipped
/// silently (lost files). Now any folder with real files is a reward.
fn dir_has_any_content(dir: &Path) -> bool {
    std::fs::read_dir(dir)
        .map(|rd| rd.flatten().any(|e| e.path().is_file() && is_indexable(&e.path())))
        .unwrap_or(false)
}

/// True if a folder has media anywhere below it. Depth limit against junction loops.
fn subtree_has_media(dir: &Path, depth: u32) -> bool {
    if dir_has_direct_media(dir) {
        return true;
    }
    depth < MAX_SCAN_DEPTH && child_dirs(dir).iter().any(|c| subtree_has_media(c, depth + 1))
}

/// Does folder have gallery subfolders that were folded into it
/// (= the import's "bundle into ONE reward")?
fn has_folded_children(folder: &str, others: &[&str]) -> bool {
    let base = Path::new(folder);
    child_dirs(base).iter().any(|c| {
        subtree_has_media(c, 0) && !others.iter().any(|o| Path::new(o).starts_with(c))
    })
}

fn child_dirs(dir: &Path) -> Vec<PathBuf> {
    let mut v: Vec<PathBuf> = std::fs::read_dir(dir)
        .map(|rd| {
            rd.flatten()
                .map(|e| e.path())
                .filter(|p| p.is_dir())
                .collect()
        })
        .unwrap_or_default();
    v.sort();
    v
}

/// Natural sort like Explorer: case-insensitive, numbers by value (pic2 before pic10).
fn natural_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    use std::cmp::Ordering;
    let (a, b) = (a.to_lowercase(), b.to_lowercase());
    let (mut ai, mut bi) = (a.chars().peekable(), b.chars().peekable());
    let rank = |c: char| {
        if c.is_alphabetic() {
            2
        } else if c.is_ascii_digit() {
            1
        } else {
            0
        }
    };
    loop {
        match (ai.peek().copied(), bi.peek().copied()) {
            (None, None) => return Ordering::Equal,
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (Some(x), Some(y)) if x.is_ascii_digit() && y.is_ascii_digit() => {
                let run = |it: &mut std::iter::Peekable<std::str::Chars<'_>>| {
                    let mut d = String::new();
                    while let Some(c) = it.peek().copied().filter(|c| c.is_ascii_digit()) {
                        d.push(c);
                        it.next();
                    }
                    d
                };
                let (da, db) = (run(&mut ai), run(&mut bi));
                let (ta, tb) = (da.trim_start_matches('0'), db.trim_start_matches('0'));
                let ord = ta.len().cmp(&tb.len()).then_with(|| ta.cmp(tb));
                if ord != Ordering::Equal {
                    return ord;
                }
            }
            (Some(x), Some(y)) => {
                let ord = rank(x).cmp(&rank(y)).then(x.cmp(&y));
                if ord != Ordering::Equal {
                    return ord;
                }
                ai.next();
                bi.next();
            }
        }
    }
}

/// Same file order as the viewer (buildFolderOrder in rewardOrder.ts): folder files
/// first, then each subfolder, natural order. So the cover is the first picture you see.
fn viewer_order(a: &str, b: &str) -> std::cmp::Ordering {
    use std::cmp::Ordering;
    let split = |rel: &str| -> (String, String) {
        let name = rel.rsplit('/').next().unwrap_or(rel).to_string();
        match rel.split_once('/') {
            Some((group, _)) => (group.to_string(), name),
            None => (String::new(), name),
        }
    };
    let ((ga, na), (gb, nb)) = (split(a), split(b));
    match (ga.is_empty(), gb.is_empty()) {
        (true, false) => return Ordering::Less,
        (false, true) => return Ordering::Greater,
        _ => {}
    }
    natural_cmp(&ga, &gb)
        .then_with(|| natural_cmp(&na, &nb))
        .then_with(|| a.cmp(b))
}

/// The OLD automatic cover (byte order). Only used to recognize an old automatic cover
/// so a rescan can fix it (old covers have no cover_custom flag).
fn legacy_cover_pick(images: &[(String, String)]) -> Option<String> {
    let mut v: Vec<&(String, String)> = images.iter().collect();
    v.sort_by(|a, b| a.1.split('/').cmp(b.1.split('/')));
    let direct = |r: &(String, String)| !r.1.contains('/');
    let image = |r: &(String, String)| is_image(Path::new(&r.0));
    let video = |r: &(String, String)| is_video(Path::new(&r.0));
    v.iter()
        .copied()
        .find(|r| image(r) && direct(r))
        .or_else(|| v.iter().copied().find(|r| image(r)))
        .or_else(|| v.iter().copied().find(|r| video(r) && direct(r)))
        .or_else(|| v.iter().copied().find(|r| video(r)))
        .map(|r| r.0.clone())
}

/// Collect EVERY file in a reward folder (recursive) in viewer order.
/// Returns (files: Vec<(abs_path, rel_name)>, cover).
pub fn collect_reward_images(reward_dir: &Path) -> (Vec<(String, String)>, Option<String>) {
    let mut imgs: Vec<(PathBuf, String)> = Vec::new();
    for entry in WalkDir::new(reward_dir).sort_by_file_name() {
        let Ok(entry) = entry else { continue };
        let p = entry.path();
        if p.is_file() && is_indexable(p) {
            let rel = p
                .strip_prefix(reward_dir)
                .unwrap_or(p)
                .to_string_lossy()
                .replace('\\', "/");
            imgs.push((p.to_path_buf(), rel));
        }
    }
    // the walk gives byte order (pic10 before pic2), so sort naturally
    imgs.sort_by(|a, b| viewer_order(&a.1, &b.1));
    // cover: an image directly in the folder, else the first image anywhere,
    // else a video. Archives never. None = gradient.
    let cover = imgs
        .iter()
        .filter(|(p, _)| is_image(p))
        .find(|(p, _)| p.parent() == Some(reward_dir))
        .or_else(|| imgs.iter().find(|(p, _)| is_image(p)))
        .or_else(|| {
            imgs.iter()
                .filter(|(p, _)| is_video(p))
                .find(|(p, _)| p.parent() == Some(reward_dir))
        })
        .or_else(|| imgs.iter().find(|(p, _)| is_video(p)))
        .map(|(p, _)| p.to_string_lossy().to_string());

    let images = imgs
        .into_iter()
        .map(|(p, rel)| (p.to_string_lossy().to_string(), rel))
        .collect();
    (images, cover)
}

/* ---- DB upserts ------------------------------------------------------ */

pub fn upsert_artist(conn: &Connection, name: &str) -> rusqlite::Result<i64> {
    conn.execute(
        "INSERT INTO artists(name) VALUES(?1) ON CONFLICT(name) DO NOTHING",
        params![name],
    )?;
    conn.query_row("SELECT id FROM artists WHERE name = ?1", params![name], |r| {
        r.get(0)
    })
}

#[allow(clippy::too_many_arguments)]
pub fn upsert_period(
    conn: &Connection,
    artist_id: i64,
    platform: Option<&str>,
    year: Option<i64>,
    month: Option<i64>,
    number: Option<i64>,
    label: &str,
    folder_path: &str,
    needs_review: bool,
) -> rusqlite::Result<i64> {
    // on rescan keep a platform the user confirmed.
    // COALESCE: a saved name wins, but a NULL takes the folder's platform
    // (that fixes libraries damaged by the old platform bug). Only fills blanks.
    conn.execute(
        "INSERT INTO periods(artist_id, platform, year, month, number, span, label, folder_path, needs_review)
         VALUES(?1, ?2, ?3, ?4, ?5, 1, ?6, ?7, ?8)
         ON CONFLICT(folder_path) DO UPDATE SET
            artist_id = excluded.artist_id,
            platform  = COALESCE(periods.platform, excluded.platform),
            year      = excluded.year,
            month     = excluded.month,
            number    = excluded.number,
            label     = excluded.label",
        params![
            artist_id,
            platform,
            year,
            month,
            number,
            label,
            folder_path,
            needs_review as i64
        ],
    )?;
    conn.query_row(
        "SELECT id FROM periods WHERE folder_path = ?1",
        params![folder_path],
        |r| r.get(0),
    )
}

#[allow(clippy::too_many_arguments)]
fn upsert_reward(
    conn: &Connection,
    period_id: i64,
    title: &str,
    category: Option<&str>,
    folder_path: &str,
    cover: Option<&str>,
    image_count: i64,
    is_root: bool,
    bundled: bool,
    legacy_cover: Option<&str>,
) -> rusqlite::Result<i64> {
    // keep the user's status on rescan, EXCEPT a template "missing" that now has images ->
    // owned
    conn.execute(
        // fresh = 1 on insert and when a placeholder becomes owned, but not on a normal
        // rescan.
        // sd_marked works the same: a year rule is only for new rewards (see
        // sd::rule_mode_sql)
        &format!(
        "INSERT INTO rewards(period_id, title, category, folder_path, cover_image, image_count, is_root, bundled, fresh, is_extra, sd_marked)
         VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 1, ?9, {})
         ON CONFLICT(folder_path) DO UPDATE SET
            period_id   = excluded.period_id,
            title       = excluded.title,
            category    = excluded.category,
            -- An automatic cover follows the order the viewer shows. A stored one
            -- is replaced only when it is provably automatic: unset, or exactly what
            -- the indexer picked before covers followed that order (?10). Anything
            -- else is a choice -- flagged, or made before the flag existed -- and stays.
            cover_image = CASE
                WHEN rewards.cover_custom = 1 THEN rewards.cover_image
                WHEN rewards.cover_image IS NULL OR rewards.cover_image = ?10
                    THEN COALESCE(excluded.cover_image, rewards.cover_image)
                ELSE rewards.cover_image
            END,
            image_count = excluded.image_count,
            is_root     = excluded.is_root,
            bundled     = excluded.bundled,
            status      = CASE
                WHEN rewards.status = 'missing' AND excluded.image_count > 0 THEN 'owned'
                ELSE rewards.status
            END,
            -- A template placeholder that just got its files is new to *you*, even
            -- though the row has been sitting there since the template was applied.
            -- Same condition as the status flip above, deliberately: whatever counts
            -- as the reward having arrived has to count for the badge too.
            fresh       = CASE
                WHEN rewards.status = 'missing' AND excluded.image_count > 0 THEN 1
                ELSE rewards.fresh
            END",
            crate::sd::rule_mode_sql("?1")
        ),
        params![
            period_id,
            title,
            category,
            folder_path,
            cover,
            image_count,
            is_root as i64,
            bundled as i64,
            // a folder called "Extra" starts as an extra. Only on insert, a rescan never
            // changes it.
            category
                .map(|c| {
                    let c = c.trim().to_ascii_lowercase();
                    c == "extra" || c == "extras" || c == "bonus"
                })
                .unwrap_or(false) as i64,
            legacy_cover
        ],
    )?;
    conn.query_row(
        "SELECT id FROM rewards WHERE folder_path = ?1",
        params![folder_path],
        |r| r.get(0),
    )
}

fn replace_images(
    conn: &Connection,
    reward_id: i64,
    images: &[(String, String)],
) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM images WHERE reward_id = ?1", params![reward_id])?;
    let mut stmt = conn.prepare(
        "INSERT INTO images(reward_id, file_path, rel_name, sort) VALUES(?1, ?2, ?3, ?4)",
    )?;
    for (i, (abs, rel)) in images.iter().enumerate() {
        stmt.execute(params![reward_id, abs, rel, i as i64])?;
    }
    Ok(())
}

/// Normalize a title for matching (lowercase, letters/numbers only).
/// "Aria - Beach" matches "aria_beach".
pub fn norm_title(s: &str) -> String {
    s.to_ascii_lowercase()
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .collect()
}

/// Remove template "missing" placeholders that have a real twin in the same period
/// (files in a differently named folder, or indexed before the template). The real one
/// wins.
pub fn dedupe_template_placeholders(conn: &Connection, period_id: i64) -> rusqlite::Result<()> {
    let rows = db::period_rewards(conn, period_id)?; // (id, title, status, image_count)
    // titles that really exist (have images)
    let present: HashSet<String> = rows
        .iter()
        .filter(|(_, _, _, n)| *n > 0)
        .map(|(_, t, _, _)| norm_title(t))
        .collect();
    for (id, title, status, count) in &rows {
        if status == "missing" && *count == 0 && present.contains(&norm_title(title)) {
            conn.execute("DELETE FROM rewards WHERE id = ?1", params![id])?;
        }
    }
    Ok(())
}

/* ---- smart import: analyze + commit ---------------------------------- */

/// A reward found by the analyzer, with whatever levels could be guessed.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DetectedReward {
    pub key: String,
    pub artist: String,
    pub platform: Option<String>,
    pub year: Option<i64>,
    pub month: Option<i64>,
    /// Drop number if it's in a numbered level ("#51" / a run like 51..55). Not together
    /// with year/month.
    pub number: Option<i64>,
    pub category: Option<String>,
    pub title: String,
    pub folder: String,
    pub cover: Option<String>,
    pub image_count: i64,
    /// The files are directly in the period folder (no reward subfolder).
    #[serde(default)]
    pub root: bool,
}

/// Release style suggestion per artist (the review pre-selects it).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtistProposal {
    pub name: String,
    /// "numbered" | "monthly" | "none"
    pub proposed_style: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportPlan {
    pub multi_artist: bool,
    pub rewards: Vec<DetectedReward>,
    pub artists: Vec<ArtistProposal>,
}

/// A reward with all levels filled in (after the user fixed unknowns).
#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedReward {
    pub artist: String,
    pub platform: Option<String>,
    pub year: Option<i64>,
    pub month: Option<i64>,
    /// Drop number for numbered creators ("#51"), None otherwise.
    #[serde(default)]
    pub number: Option<i64>,
    pub category: Option<String>,
    pub title: String,
    pub folder: String,
    /// No reward subfolder, files go straight into the month folder
    /// ("Reward is root" checkbox, or detected on rescan).
    #[serde(default)]
    pub root: bool,
    /// Marked as an extra in the import review (doesn't stand in for its month).
    #[serde(default)]
    pub extra: bool,
}

#[derive(Clone, Default)]
struct Ctx {
    platform: Option<String>,
    year: Option<i64>,
    month: Option<i64>,
    number: Option<i64>,
    category: Option<String>,
    /// The platform level is behind us (also through "Unsorted", which has none).
    past_platform: bool,
}

impl Ctx {
    /// Right under the creator, where organize puts the platform folders.
    fn at_platform_level(&self) -> bool {
        self.platform.is_none()
            && !self.past_platform
            && self.year.is_none()
            && self.number.is_none()
            && self.category.is_none()
    }
    /// Right under a platform, where organize puts "Misc" for rewards without a date.
    fn at_period_level(&self) -> bool {
        (self.platform.is_some() || self.past_platform)
            && self.year.is_none()
            && self.number.is_none()
            && self.category.is_none()
    }
}

/// The two folder names organize writes itself. Under the creator, "Misc" is the Misc
/// platform (don't know it, won't look it up) and "Unsorted" is no platform yet.
/// Under a platform, "Misc" is the folder for rewards without a date.
const MISC_DIR: &str = "Misc";
const UNSORTED_DIR: &str = "Unsorted";
fn is_dir_word(name: &str, word: &str) -> bool {
    name.trim().eq_ignore_ascii_case(word)
}

/// Does this folder (or its children) show a known structure?
fn has_structure(dir: &Path) -> bool {
    if dir_has_direct_media(dir) {
        return true;
    }
    let children = child_dirs(dir);
    let names: Vec<String> = children
        .iter()
        .map(|c| c.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default())
        .collect();
    // a numbered run counts as structure too
    if is_numbered_run(&names) || names.iter().any(|n| numbered_token(n).is_some()) {
        return true;
    }
    children.iter().zip(&names).any(|(c, n)| {
        dir_has_direct_media(c)
            || platform_from_name(n).is_some()
            || date_level(n).is_some()
            || is_organized_dir(n)
    })
}

/// A folder organize writes under a creator (Misc platform / Unsorted).
fn is_organized_dir(name: &str) -> bool {
    is_dir_word(name, MISC_DIR) || is_dir_word(name, UNSORTED_DIR)
}

/// Clean up a folder name for display: remove a date at the end and a platform at
/// the start or end ("Pixelfox240_Patreon_2026-02" -> "Pixelfox240"). Keeps the rest.
fn clean_reward_title(name: &str) -> String {
    const SEPS: [char; 4] = ['_', '-', ' ', '.'];
    let (head, _) = parse_artist_period(name);
    let mut s = head.trim().to_string();

    loop {
        let mut changed = false;
        // remove a platform at the end
        if let Some(idx) = s.rfind(SEPS) {
            let tail = &s[idx + 1..];
            if !tail.is_empty() && platform_from_name(tail).is_some() {
                s = s[..idx].trim_end_matches(SEPS).to_string();
                changed = true;
            }
        }
        // remove a platform at the start
        if let Some(idx) = s.find(SEPS) {
            let lead = &s[..idx];
            if !lead.is_empty() && platform_from_name(lead).is_some() {
                s = s[idx + 1..].trim_start_matches(SEPS).to_string();
                changed = true;
            }
        }
        if !changed {
            break;
        }
    }

    let s = s.trim();
    if s.is_empty() {
        head.trim().to_string()
    } else {
        s.to_string()
    }
}

/// Walk an artist's folders, classify each as platform / date / month / category,
/// and emit a DetectedReward for every folder with images.
fn collect_rewards(dir: &Path, artist: &str, ctx: &Ctx, out: &mut Vec<DetectedReward>) {
    collect_rewards_at(dir, artist, ctx, out, 0);
}

/// The real collect_rewards with a depth counter. is_dir follows junctions, a loop
/// would recurse forever. Real layouts are ~6 levels deep, so the cap only stops loops.
const MAX_SCAN_DEPTH: u32 = 24;
fn collect_rewards_at(dir: &Path, artist: &str, ctx: &Ctx, out: &mut Vec<DetectedReward>, depth: u32) {
    if depth > MAX_SCAN_DEPTH {
        return;
    }
    // a folder with loose files IS a reward (the normal drag-and-drop case)
    if dir_has_any_content(dir) {
        let name = dir
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();
        let (images, cover) = collect_reward_images(dir);
        let platform = ctx.platform.clone().or_else(|| platform_from_name(&name));
        let mut year = ctx.year;
        let mut month = ctx.month;
        let mut number = ctx.number;
        // loose files directly in a dated/drop folder = that folder is the reward
        let mut root = ctx.year.is_some() || ctx.number.is_some();
        if year.is_none() && number.is_none() {
            // a folder named like a date ("2025-08") or drop ("#51") gives the period
            // directly,
            // otherwise cut a date off the end of the name
            if let Some((y, m)) = date_level(&name) {
                year = Some(y);
                month = m;
                root = true;
            } else if let Some(n) = numbered_token(&name) {
                number = Some(n);
                root = true;
            } else if let (_, Some((y, m, _))) = parse_artist_period(&name) {
                year = Some(y);
                month = m;
            }
        }
        // a month folder under a known year ("02 - february") -> that month
        if month.is_none() && year.is_some() {
            if let Some(bm) = bare_month(&name) {
                month = Some(bm);
            }
        }
        out.push(DetectedReward {
            key: dir.to_string_lossy().to_string(),
            artist: artist.to_string(),
            platform,
            year,
            month,
            number,
            category: ctx.category.clone(),
            title: clean_reward_title(&name),
            folder: dir.to_string_lossy().to_string(),
            cover,
            image_count: images.len() as i64,
            root,
        });
    }

    let children = child_dirs(dir);
    // check the siblings once: a numbered run outside a year is a drop level
    let numbered_run = ctx.year.is_none()
        && ctx.number.is_none()
        && is_numbered_run(
            &children
                .iter()
                .map(|c| c.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default())
                .collect::<Vec<_>>(),
        );

    for child in children {
        let name = child
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();

        if dir_has_any_content(&child) {
            let (images, cover) = collect_reward_images(&child);
            // get platform/date from the reward folder's own name if the parents didn't
            // have it
            // (e.g. "Pixelfox240_Patreon_2026-02" or a "Patreon" folder with images)
            let platform = ctx.platform.clone().or_else(|| platform_from_name(&name));
            let mut year = ctx.year;
            let mut month = ctx.month;
            let mut number = ctx.number;
            let mut root = false;
            if year.is_none() && number.is_none() {
                // a date or drop folder with loose files is that period's root gallery,
                // otherwise cut a date off the name
                if let Some((y, m)) = date_level(&name) {
                    year = Some(y);
                    month = m;
                    root = true;
                } else if let Some(n) = drop_number(&name, numbered_run) {
                    number = Some(n);
                    root = true;
                } else if let (_, Some((y, m, _))) = parse_artist_period(&name) {
                    year = Some(y);
                    month = m;
                }
            }
            // a month folder under a known year with media IS that month (its files = root
            // reward)
            if month.is_none() && year.is_some() {
                if let Some(bm) = bare_month(&name) {
                    month = Some(bm);
                    root = true;
                }
            }
            out.push(DetectedReward {
                key: child.to_string_lossy().to_string(),
                artist: artist.to_string(),
                platform,
                year,
                month,
                number,
                category: ctx.category.clone(),
                title: clean_reward_title(&name),
                folder: child.to_string_lossy().to_string(),
                cover,
                image_count: images.len() as i64,
                root,
            });
        } else if ctx.at_platform_level() && is_dir_word(&name, MISC_DIR) {
            // the Misc platform
            let mut c = ctx.clone();
            c.platform = Some(MISC_DIR.to_string());
            c.past_platform = true;
            collect_rewards_at(&child, artist, &c, out, depth + 1);
        } else if ctx.at_platform_level() && is_dir_word(&name, UNSORTED_DIR) {
            // no platform yet: stays unset, the review banner asks for it
            let mut c = ctx.clone();
            c.past_platform = true;
            collect_rewards_at(&child, artist, &c, out, depth + 1);
        } else if ctx.at_period_level() && is_dir_word(&name, MISC_DIR) {
            // "no date" folder: not a category, the rewards inside have no period
            collect_rewards_at(&child, artist, ctx, out, depth + 1);
        } else if let Some(p) = platform_from_name(&name) {
            let mut c = ctx.clone();
            c.platform = Some(p);
            c.past_platform = true;
            collect_rewards_at(&child, artist, &c, out, depth + 1);
        } else if let Some((y, m)) = date_level(&name) {
            let mut c = ctx.clone();
            c.year = Some(y);
            if m.is_some() {
                c.month = m;
            }
            collect_rewards_at(&child, artist, &c, out, depth + 1);
        } else if ctx.year.is_some() && ctx.month.is_none() && bare_month(&name).is_some() {
            let mut c = ctx.clone();
            c.month = bare_month(&name);
            collect_rewards_at(&child, artist, &c, out, depth + 1);
        } else if ctx.year.is_none() && ctx.number.is_none() && drop_number(&name, numbered_run).is_some() {
            // drop level: "#51" always, a bare "51" only in a run. Its subfolders are the
            // rewards.
            let mut c = ctx.clone();
            c.number = drop_number(&name, numbered_run);
            collect_rewards_at(&child, artist, &c, out, depth + 1);
        } else {
            // unknown folder without loose files but with gallery subfolders: probably ONE
            // reward
            // with its images in subfolders. Emit it as a reward (the review can split it).
            // The children are emitted too, commit() handles both cases.
            if child_dirs(&child).iter().any(|g| dir_has_direct_media(g)) {
                let (images, cover) = collect_reward_images(&child);
                out.push(DetectedReward {
                    key: child.to_string_lossy().to_string(),
                    artist: artist.to_string(),
                    platform: ctx.platform.clone().or_else(|| platform_from_name(&name)),
                    year: ctx.year,
                    month: ctx.month,
                    number: ctx.number,
                    category: ctx.category.clone(),
                    title: clean_reward_title(&name),
                    folder: child.to_string_lossy().to_string(),
                    cover,
                    image_count: images.len() as i64,
                    root: false,
                });
            }
            // unknown folder -> a category, its children are rewards
            let mut c = ctx.clone();
            if c.category.is_none() {
                c.category = Some(name);
            }
            collect_rewards_at(&child, artist, &c, out, depth + 1);
        }
    }
}

fn seed_ctx_from_name(name: &str) -> (String, Ctx) {
    let mut ctx = Ctx::default();
    // a dropped folder named like a date ("2026-05") gives the period for everything inside
    // (the artist comes from the drop target or the user)
    if let Some((y, m)) = date_level(name) {
        ctx.year = Some(y);
        ctx.month = m;
        return (name.to_string(), ctx);
    }
    let (artist, date) = parse_artist_period(name);
    if let Some((y, m, _)) = date {
        ctx.year = Some(y);
        if m.is_some() {
            ctx.month = m;
        }
    }
    (artist, ctx)
}

/// Build the plan: one style suggestion per artist (mostly numbered -> "numbered",
/// any date -> "monthly", neither -> "none").
fn make_plan(multi_artist: bool, rewards: Vec<DetectedReward>) -> ImportPlan {
    let mut by_artist: std::collections::BTreeMap<String, (usize, usize, usize)> =
        std::collections::BTreeMap::new();
    for r in &rewards {
        let e = by_artist.entry(r.artist.clone()).or_default();
        e.0 += 1; // total
        if r.number.is_some() {
            e.1 += 1; // numbered
        }
        if r.year.is_some() {
            e.2 += 1; // dated
        }
    }
    let artists = by_artist
        .into_iter()
        .map(|(name, (total, numbered, dated))| {
            let proposed_style = if numbered * 2 > total {
                "numbered"
            } else if dated > 0 {
                "monthly"
            } else {
                "none"
            };
            ArtistProposal { name, proposed_style: proposed_style.to_string() }
        })
        .collect();
    ImportPlan { multi_artist, rewards, artists }
}

/// Analyze a folder WITHOUT writing anything. Detects one artist or a library of
/// many and guesses platform/year/month/category (unknowns stay None).
///
/// The graveyard folder in <collection>\MiColl. It holds creators, not platforms,
/// so walks of the managed root go through it. The emoji sorts it to the bottom in
/// Explorer.
pub const GRAVEYARD_DIR: &str = "\u{1FAA6} Graveyard";

/// True for the graveyard folder (case-insensitive).
pub fn is_graveyard_dir(p: &Path) -> bool {
    p.file_name()
        .map(|n| n.to_string_lossy().to_lowercase() == GRAVEYARD_DIR.to_lowercase())
        .unwrap_or(false)
}

pub fn analyze(path: &str) -> ImportPlan {
    let root = Path::new(path);
    let root_name = root
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    // the graveyard's children are the creators
    let children: Vec<std::path::PathBuf> = child_dirs(root)
        .into_iter()
        .flat_map(|c| if is_graveyard_dir(&c) { child_dirs(&c) } else { vec![c] })
        .collect();
    let mut rewards = Vec::new();

    // if the root has structure it IS the artist (a numbered run is one creator's drops)
    let child_names: Vec<String> = children
        .iter()
        .map(|c| c.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default())
        .collect();
    let root_structured = children.iter().zip(&child_names).any(|(c, n)| {
        dir_has_direct_media(c)
            || platform_from_name(n).is_some()
            || date_level(n).is_some()
            || numbered_token(n).is_some()
            || is_organized_dir(n)
    }) || dir_has_direct_media(root)
        || is_numbered_run(&child_names);

    if root_structured || children.is_empty() {
        let (artist, ctx) = seed_ctx_from_name(&root_name);
        collect_rewards(root, &artist, &ctx, &mut rewards);
        return make_plan(false, rewards);
    }

    // otherwise each child with structure is its own artist
    let mut artists = 0;
    for child in &children {
        if has_structure(child) {
            let cname = child
                .file_name()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_default();
            let (artist, ctx) = seed_ctx_from_name(&cname);
            collect_rewards(child, &artist, &ctx, &mut rewards);
            artists += 1;
        }
    }
    if artists > 0 {
        return make_plan(artists > 1, rewards);
    }

    // fallback: the root is one artist
    let (artist, ctx) = seed_ctx_from_name(&root_name);
    collect_rewards(root, &artist, &ctx, &mut rewards);
    make_plan(false, rewards)
}

/// Path-independent key for a period so it's never duplicated.
/// The drop number is an extra 5th part, only for numbered periods, so old keys stay the
/// same.
pub fn period_key(
    artist: &str,
    platform: Option<&str>,
    year: Option<i64>,
    month: Option<i64>,
    number: Option<i64>,
) -> String {
    let mut key = format!(
        "{}\u{1}{}\u{1}{}\u{1}{}",
        artist,
        platform.unwrap_or("?"),
        year.map(|y| y.to_string()).unwrap_or_default(),
        month.map(|m| m.to_string()).unwrap_or_default(),
    );
    if let Some(n) = number {
        key.push('\u{1}');
        key.push_str(&format!("n{n}"));
    }
    key
}

/// Progress (done, total, current). total 0 = still discovering.
pub type Progress<'a> = &'a dyn Fn(u32, u32, &str);

/// No progress output (imports, tests).
fn no_progress(_done: u32, _total: u32, _item: &str) {}

/// Write the rewards into the DB (idempotent). Images are collected from each folder.
/// open_as_cards: Some(true|false) saves the "open as cards" choice per period,
/// None keeps what's saved (so a rescan doesn't change it).
pub fn commit(
    conn: &Connection,
    rewards: &[ResolvedReward],
    open_as_cards: Option<bool>,
) -> rusqlite::Result<ScanSummary> {
    commit_with_progress(conn, rewards, open_as_cards, &no_progress)
}

/// commit with progress (done, total, title).
pub fn commit_with_progress(
    conn: &Connection,
    rewards: &[ResolvedReward],
    open_as_cards: Option<bool>,
    progress: Progress<'_>,
) -> rusqlite::Result<ScanSummary> {
    let total = rewards.len() as u32;
    let mut sum = ScanSummary::default();
    let mut seen_artists: HashSet<String> = HashSet::new();
    let mut seen_periods: HashSet<String> = HashSet::new();
    let mut touched_periods: HashSet<i64> = HashSet::new();

    for (i, r) in rewards.iter().enumerate() {
        progress(i as u32, total, &r.title);
        let artist_id = upsert_artist(conn, &r.artist)?;
        if seen_artists.insert(r.artist.clone()) {
            sum.artists += 1;
        }
        let label = match (r.number, r.year, r.month) {
            (Some(n), _, _) => fmt_number_label(n),
            (None, Some(y), m) => fmt_label(y, m),
            (None, None, _) => "Misc".to_string(),
        };
        let needs_review = r.platform.is_none();
        let key = period_key(&r.artist, r.platform.as_deref(), r.year, r.month, r.number);
        let period_id = upsert_period(
            conn,
            artist_id,
            r.platform.as_deref(),
            r.year,
            r.month,
            r.number,
            &label,
            &key,
            needs_review,
        )?;
        if seen_periods.insert(key) {
            sum.periods += 1;
            if needs_review {
                sum.needs_review += 1;
            }
        }
        // if another reward of this import is in a subfolder, those files belong to it only
        // (otherwise both indexed the same files)
        let nested: Vec<&str> = rewards
            .iter()
            .map(|o| o.folder.as_str())
            .filter(|f| *f != r.folder && Path::new(f).starts_with(&r.folder))
            .collect();
        let (mut images, mut cover) = collect_reward_images(Path::new(&r.folder));
        if !nested.is_empty() {
            images.retain(|(abs, _)| !nested.iter().any(|n| Path::new(abs).starts_with(n)));
            // the cover may point into a nested reward, pick again
            if cover.as_deref().map(|c| images.iter().any(|(abs, _)| abs == c)) != Some(true) {
                cover = images
                    .iter()
                    .find(|(abs, _)| is_image(Path::new(abs)))
                    .or_else(|| images.first())
                    .map(|(abs, _)| abs.clone());
            }
        }
        // a container with no own files whose children are imported separately is skipped
        // (it would be an empty card)
        if images.is_empty() && !nested.is_empty() {
            continue;
        }
        // remember that this card has its subfolders folded in, so rescans keep it that way
        let bundled = has_folded_children(&r.folder, &nested);
        let reward_id = upsert_reward(
            conn,
            period_id,
            &r.title,
            r.category.as_deref(),
            &r.folder,
            cover.as_deref(),
            images.len() as i64,
            r.root,
            bundled,
            legacy_cover_pick(&images).as_deref(),
        )?;
        replace_images(conn, reward_id, &images)?;
        touched_periods.insert(period_id);
        sum.rewards += 1;
        sum.images += images.len() as i64;
    }
    progress(total, total, "");
    // match template placeholders and apply "open as cards" to the touched periods
    for pid in touched_periods {
        dedupe_template_placeholders(conn, pid)?;
        if let Some(v) = open_as_cards {
            db::set_period_open_as_cards(conn, pid, v)?;
        }
    }
    Ok(sum)
}

/// Without user input: unknown platform gets the root default (else needs review).
fn auto_resolve(plan: ImportPlan, default_platform: Option<&str>) -> Vec<ResolvedReward> {
    plan.rewards
        .into_iter()
        .map(|d| ResolvedReward {
            artist: d.artist,
            platform: d.platform.or_else(|| default_platform.map(String::from)),
            year: d.year,
            month: d.month,
            number: d.number,
            category: d.category,
            title: d.title,
            folder: d.folder,
            root: d.root,
            extra: false,
        })
        .collect()
}

/* ---- scan ------------------------------------------------------------ */

/// Scan a library root (add_root/rescan), idempotent.
pub fn scan_root(conn: &Connection, root: &db::Root) -> rusqlite::Result<ScanSummary> {
    let resolved = plan_root(conn, root)?;
    // a rescan must not change the "open as cards" choice
    commit(conn, &resolved, None)
}

/// The discovery part of scan_root (no writing), so we can count several roots first
/// and show a real progress total.
pub fn plan_root(conn: &Connection, root: &db::Root) -> rusqlite::Result<Vec<ResolvedReward>> {
    refresh_known_platforms(conn)?;
    let mut plan = analyze(&root.path);
    apply_bundles(conn, &mut plan)?;
    Ok(auto_resolve(plan, root.default_platform.as_deref()))
}

/// Scan ONE creator's folder. Everything found goes to artist, so dir must be their own
/// folder.
pub fn plan_artist_dir(
    conn: &Connection,
    dir: &str,
    default_platform: Option<&str>,
    artist: &str,
) -> rusqlite::Result<Vec<ResolvedReward>> {
    refresh_known_platforms(conn)?;
    let mut plan = analyze(dir);
    for r in &mut plan.rewards {
        r.artist = artist.to_string();
    }
    plan.multi_artist = false;
    apply_bundles(conn, &mut plan)?;
    Ok(auto_resolve(plan, default_platform))
}

/// Where one creator's files are. Returns the folder, the platform default, and if it's
/// the creator's OWN folder or a shared root (then nothing may be re-assigned).
pub fn artist_scan_dir(
    conn: &Connection,
    artist_id: i64,
) -> rusqlite::Result<Option<(String, Option<String>, bool)>> {
    let name: Option<String> = conn
        .query_row("SELECT name FROM artists WHERE id = ?1", params![artist_id], |r| r.get(0))
        .optional()?;
    let Some(name) = name else { return Ok(None) };
    let folders = db::artist_reward_folders(conn, artist_id)?;

    // managed mode: everything is in <collection_root>\MiColl
    let managed = db::get_setting(conn, "managed_enabled")?.as_deref() == Some("true");
    let roots: Vec<(String, Option<String>)> = if managed {
        db::get_setting(conn, "collection_root")?
            .filter(|s| !s.trim().is_empty())
            .map(|r| {
                vec![(Path::new(&r).join("MiColl").to_string_lossy().into_owned(), None)]
            })
            .unwrap_or_default()
    } else {
        db::list_roots(conn)?
            .into_iter()
            .map(|r| (r.path, r.default_platform))
            .collect()
    };

    let want = norm_title(&name);
    for (root, platform) in roots {
        let rp = Path::new(&root);
        // one of the creator's rewards tells us which branch to walk
        let Some(sample) = folders.iter().find(|f| Path::new(f).starts_with(rp)) else {
            continue;
        };
        // the first folder under the root on the way. If it has the creator's name it's
        // their folder (graveyard creators are one level deeper)
        let child = Path::new(sample).strip_prefix(rp).ok().and_then(|rest| {
            let mut comps = rest.components();
            let first = rp.join(comps.next()?.as_os_str());
            if is_graveyard_dir(&first) {
                Some(first.join(comps.next()?.as_os_str()))
            } else {
                Some(first)
            }
        });
        if let Some(dir) = child {
            let base =
                dir.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
            if norm_title(&parse_artist_period(&base).0) == want && dir.is_dir() {
                return Ok(Some((dir.to_string_lossy().into_owned(), platform, true)));
            }
        }
        // otherwise the root is the smallest safe scope
        return Ok(Some((root, platform, false)));
    }
    Ok(None)
}

/// Before commit: keep bundled rewards folded.
fn apply_bundles(conn: &Connection, plan: &mut ImportPlan) -> rusqlite::Result<()> {
    // the analyzer offers a container AND its subfolders. A rescan has no review,
    // so without this one card became many on every scan
    mark_bundled_rewards(conn)?;
    let bundles = db::bundled_reward_folders(conn)?;
    let (dropped, kept): (Vec<_>, Vec<_>) = std::mem::take(&mut plan.rewards)
        .into_iter()
        .partition(|r| {
            let rp = Path::new(&r.folder);
            bundles.iter().any(|b| {
                let bp = Path::new(b);
                rp != bp && rp.starts_with(bp)
            })
        });
    plan.rewards = kept;
    // add the bundle back when only its subfolders were found, so new files go into
    // the one card. The title comes from the DB (the user may have renamed it)
    for b in &bundles {
        let bp = Path::new(b);
        if plan.rewards.iter().any(|r| Path::new(&r.folder) == bp) {
            continue;
        }
        let Some(src) = dropped.iter().find(|r| Path::new(&r.folder).starts_with(bp)) else {
            continue;
        };
        let (images, cover) = collect_reward_images(bp);
        if images.is_empty() {
            continue;
        }
        let name = bp.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
        plan.rewards.push(DetectedReward {
            key: b.clone(),
            artist: src.artist.clone(),
            platform: src.platform.clone(),
            year: src.year,
            month: src.month,
            number: src.number,
            category: src.category.clone(),
            title: db::reward_title(conn, b)?.unwrap_or_else(|| clean_reward_title(&name)),
            folder: b.clone(),
            cover,
            image_count: images.len() as i64,
            root: false,
        });
    }
    Ok(())
}

/// Set the bundled flag for old rewards (media subfolders and no other reward inside).
/// Idempotent.
fn mark_bundled_rewards(conn: &Connection) -> rusqlite::Result<()> {
    let all = db::all_reward_folders(conn)?;
    for folder in &all {
        let base = Path::new(folder);
        // no subfolders -> nothing folded
        if child_dirs(base).is_empty() {
            continue;
        }
        let inside: Vec<&str> = all
            .iter()
            .map(|f| f.as_str())
            .filter(|f| *f != folder.as_str() && Path::new(f).starts_with(base))
            .collect();
        if has_folded_children(folder, &inside) {
            db::set_reward_bundled(conn, folder, true)?;
        }
    }
    Ok(())
}

/* ---- tests ----------------------------------------------------------- */

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    #[test]
    fn parses_date_tokens() {
        // all of these are February 2026
        for s in ["2026-02", "2026.02", "2026_02", "2026 02", "2026-2", "202602", "2026-02-15"] {
            assert_eq!(
                parse_date_token(s),
                Some((2026, Some(2), "2026-02".into())),
                "failed on {s}"
            );
        }
        // month names
        assert_eq!(parse_date_token("Feb 2026"), Some((2026, Some(2), "2026-02".into())));
        assert_eq!(parse_date_token("2026 February"), Some((2026, Some(2), "2026-02".into())));
        assert_eq!(parse_date_token("May 2025"), Some((2025, Some(5), "2025-05".into())));
        // two-digit year (MM.YY)
        assert_eq!(parse_date_token("01.25"), Some((2025, Some(1), "2025-01".into())));
        // bare year
        assert_eq!(parse_date_token("2024"), Some((2024, None, "2024".into())));
        // not dates
        assert_eq!(parse_date_token("Extra"), None);
        assert_eq!(parse_date_token("Chapter 2026"), None); // not a pure date, no month
        assert_eq!(parse_date_token("Collection 5"), None);
    }

    /// the "new" badge through the importer. A rescan must not bring it back after opening.
    #[test]
    fn new_badge_marks_arrivals_but_survives_a_rescan() {
        let base = tmpdir("freshbadge");
        let pack = base.join("XCharacter").join("Patreon").join("2026-05").join("Set A");
        std::fs::create_dir_all(&pack).unwrap();
        touch(pack.join("01.jpg"));
        let folder = pack.to_string_lossy().into_owned();
        let conn = db::open(&base.join("t.db")).unwrap();
        let one = vec![ResolvedReward {
            artist: "XCharacter".into(),
            platform: Some("Patreon".into()),
            year: Some(2026),
            month: Some(5),
            number: None,
            category: None,
            title: "Set A".into(),
            folder: folder.clone(),
            root: false,
            extra: false,
        }];
        let fresh_of = |f: &str| -> i64 {
            conn.query_row("SELECT fresh FROM rewards WHERE folder_path = ?1", params![f], |r| {
                r.get(0)
            })
            .unwrap()
        };

        // 1. a new reward gets the badge
        commit(&conn, &one, None).unwrap();
        assert_eq!(fresh_of(&folder), 1, "a freshly imported reward is new");

        // 2. opening clears it, a rescan must not bring it back
        crate::db::mark_reward_seen(&conn, conn
            .query_row("SELECT id FROM rewards WHERE folder_path = ?1", params![&folder], |r| r.get::<_, i64>(0))
            .unwrap())
            .unwrap();
        commit(&conn, &one, None).unwrap();
        assert_eq!(fresh_of(&folder), 0, "a rescan must not re-mark an opened reward");

        // 3. re-importing a known folder badges it again (commit_import does this)
        crate::db::mark_reward_seen(&conn, conn
            .query_row("SELECT id FROM rewards WHERE folder_path = ?1", params![&folder], |r| r.get::<_, i64>(0))
            .unwrap())
            .unwrap();
        crate::db::mark_rewards_fresh(&conn, &[folder.clone()]).unwrap();
        assert_eq!(fresh_of(&folder), 1, "a deliberate re-import is new again");

        // 4. a template placeholder is only new once its files arrive
        conn.execute(
            "UPDATE rewards SET status = 'missing', image_count = 0, fresh = 0 WHERE folder_path = ?1",
            params![&folder],
        )
        .unwrap();
        commit(&conn, &one, None).unwrap();
        assert_eq!(fresh_of(&folder), 1, "a placeholder that gained files is new to the user");

        let _ = std::fs::remove_dir_all(&base);
    }

    /// a custom platform must be recognized once the library uses it
    #[test]
    fn a_platform_this_library_uses_is_recognised() {
        let _list = PLATFORM_LIST.lock().unwrap_or_else(|e| e.into_inner());
        let base = tmpdir("knownplat");
        std::fs::create_dir_all(&base).unwrap(); // tmpdir only clears, it doesn't create
        let conn = db::open(&base.join("t.db")).unwrap();

        // nothing known yet: only the built-ins
        refresh_known_platforms(&conn).unwrap();
        assert_eq!(platform_from_name("Patreon").as_deref(), Some("Patreon"));
        assert_eq!(platform_from_name("Weibo"), None, "unknown before the library uses it");

        // add a Weibo period like the import review does
        let artist = upsert_artist(&conn, "XCharacter").unwrap();
        upsert_period(&conn, artist, Some("Weibo"), None, None, None, "Misc", "k", false).unwrap();
        refresh_known_platforms(&conn).unwrap();

        assert_eq!(platform_from_name("Weibo").as_deref(), Some("Weibo"));
        assert_eq!(platform_from_name("weibo").as_deref(), Some("Weibo"), "case-insensitive");
        // whole names only
        assert_eq!(platform_from_name("Weibo Extra"), None);
        assert_eq!(platform_from_name("Weiboartbook"), None);

        // our own words must never come back as platforms
        upsert_period(&conn, artist, Some("Misc"), None, None, None, "Misc", "k2", false).unwrap();
        upsert_period(&conn, artist, Some("2026"), None, None, None, "2026", "k3", false).unwrap();
        refresh_known_platforms(&conn).unwrap();
        assert_eq!(platform_from_name("Misc"), None, "Misc is a period level, not a platform");
        assert_eq!(platform_from_name("Unsorted"), None);
        assert_eq!(platform_from_name("2026"), None, "a year is not a platform");
        assert_eq!(platform_from_name("Weibo").as_deref(), Some("Weibo"), "still recognised");

        let _ = std::fs::remove_dir_all(&base);
    }

    /// "Unknown" is a normal platform (the app offers it).
    /// Used to be refused, so its rewards ended up "Unsorted".
    #[test]
    fn unknown_is_a_platform_because_the_app_offers_it() {
        let _list = PLATFORM_LIST.lock().unwrap_or_else(|e| e.into_inner());
        let base = tmpdir("unknownplat");
        std::fs::create_dir_all(&base).unwrap();
        let conn = db::open(&base.join("t.db")).unwrap();
        refresh_known_platforms(&conn).unwrap();

        // recognized even with an empty database
        assert_eq!(platform_from_name("Unknown").as_deref(), Some("Unknown"));
        assert_eq!(platform_from_name("unknown").as_deref(), Some("Unknown"));
        // whole name only
        assert_eq!(platform_from_name("Unknown_Artist_2024"), None);
        assert_eq!(platform_from_name("Unknown Extra"), None);

        // and it survives the learning filter
        let artist = upsert_artist(&conn, "Nora").unwrap();
        upsert_period(&conn, artist, Some("Unknown"), None, None, None, "Misc", "k", false)
            .unwrap();
        upsert_period(&conn, artist, Some("Other"), None, None, None, "Misc", "k2", false).unwrap();
        refresh_known_platforms(&conn).unwrap();
        assert_eq!(platform_from_name("Unknown").as_deref(), Some("Unknown"));
        assert_eq!(
            platform_from_name("Other").as_deref(),
            Some("Other"),
            "a folder called Other is a name the user chose, not one MiColl writes"
        );
        // the two words MiColl writes are still refused
        assert_eq!(platform_from_name("Misc"), None);
        assert_eq!(platform_from_name("Unsorted"), None);

        let _ = std::fs::remove_dir_all(&base);
    }

    /// files in Creator/Unknown/2026/03 come back as "Unknown"
    #[test]
    fn a_scan_files_unknown_where_the_disk_put_it() {
        let _list = PLATFORM_LIST.lock().unwrap_or_else(|e| e.into_inner());
        let base = tmpdir("unknownscan");
        let root = base.join("lib");
        let month = root.join("Nora").join("Unknown").join("2026").join("03").join("Pack");
        std::fs::create_dir_all(&month).unwrap();
        std::fs::write(month.join("01.jpg"), b"x").unwrap();
        let conn = db::open(&base.join("t.db")).unwrap();
        // no default platform on the root, the folder name must give it
        let r = db::Root {
            id: 1,
            path: root.to_string_lossy().into_owned(),
            label: None,
            default_platform: None,
        };
        scan_root(&conn, &r).unwrap();

        let platform: Option<String> = conn
            .query_row("SELECT platform FROM periods LIMIT 1", [], |r| r.get(0))
            .unwrap();
        assert_eq!(platform.as_deref(), Some("Unknown"));

        let _ = std::fs::remove_dir_all(&base);
    }

    /// a period without platform takes the folder's, one with a platform keeps it
    /// (fixes libraries damaged by the "Unknown" bug)
    #[test]
    fn a_rescan_fills_a_blank_platform_but_never_overwrites_one() {
        let base = tmpdir("platheal");
        std::fs::create_dir_all(&base).unwrap();
        let conn = db::open(&base.join("t.db")).unwrap();
        let artist = upsert_artist(&conn, "Nora").unwrap();

        // damaged: no platform even though the path has one
        upsert_period(&conn, artist, None, Some(2026), Some(3), None, "03.26", "k1", false)
            .unwrap();
        upsert_period(&conn, artist, Some("Unknown"), Some(2026), Some(3), None, "03.26", "k1", false)
            .unwrap();
        let healed: Option<String> = conn
            .query_row("SELECT platform FROM periods WHERE folder_path = 'k1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(healed.as_deref(), Some("Unknown"), "a blank takes what the path says");

        // confirmed: the saved name wins
        upsert_period(&conn, artist, Some("Ko-Fi"), None, None, None, "Misc", "k2", false).unwrap();
        upsert_period(&conn, artist, Some("Patreon"), None, None, None, "Misc", "k2", false)
            .unwrap();
        let kept: Option<String> = conn
            .query_row("SELECT platform FROM periods WHERE folder_path = 'k2'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(kept.as_deref(), Some("Ko-Fi"), "a confirmed platform is never overwritten");

        let _ = std::fs::remove_dir_all(&base);
    }

    /// same for a custom platform: files dropped into its folder must come back under it
    #[test]
    fn a_platform_the_user_invented_survives_a_rescan() {
        let _list = PLATFORM_LIST.lock().unwrap_or_else(|e| e.into_inner());
        let base = tmpdir("customplat");
        let root = base.join("lib");
        let pack = root.join("Nora").join("MyShop").join("2026").join("03").join("Pack");
        std::fs::create_dir_all(&pack).unwrap();
        std::fs::write(pack.join("01.jpg"), b"x").unwrap();
        let conn = db::open(&base.join("t.db")).unwrap();

        // what add_artist_platform leaves: an empty tab
        let artist = upsert_artist(&conn, "Nora").unwrap();
        let key = period_key("Nora", Some("MyShop"), None, None, None);
        upsert_period(&conn, artist, Some("MyShop"), None, None, None, "Misc", &key, false)
            .unwrap();

        let r = db::Root {
            id: 1,
            path: root.to_string_lossy().into_owned(),
            label: None,
            default_platform: None,
        };
        scan_root(&conn, &r).unwrap();

        let platform: Option<String> = conn
            .query_row(
                "SELECT p.platform FROM periods p JOIN rewards rw ON rw.period_id = p.id LIMIT 1",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(platform.as_deref(), Some("MyShop"));

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn parses_artist_and_period() {
        let (a, d) = parse_artist_period("Pixelfox240_2026-02");
        assert_eq!(a, "Pixelfox240");
        assert_eq!(d, Some((2026, Some(2), "2026-02".into())));

        let (a2, d2) = parse_artist_period("Just An Artist");
        assert_eq!(a2, "Just An Artist");
        assert_eq!(d2, None);
    }

    #[test]
    fn handles_multibyte_chars_in_names() {
        // non-ASCII folder names (en-dash, umlauts, CJK) used to panic, must parse
        let (a, d) = parse_artist_period("Yor – Spy x Family");
        assert_eq!(a, "Yor – Spy x Family");
        assert_eq!(d, None);

        let (a, d) = parse_artist_period("Müller–Art 2026-03");
        assert_eq!(a, "Müller–Art");
        assert_eq!(d, Some((2026, Some(3), "2026-03".into())));

        let (a, d) = parse_artist_period("アーティスト 2025-12");
        assert_eq!(a, "アーティスト");
        assert_eq!(d, Some((2025, Some(12), "2025-12".into())));

        // multi-byte char right before the date
        let (_, d) = parse_artist_period("Art–2026-05");
        assert_eq!(d.map(|x| x.2), Some("2026-05".into()));
    }

    fn touch(p: PathBuf) {
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, b"x").unwrap();
    }

    /// the platform list is global, tests that depend on it take turns
    /// (poison is ignored so one failing test doesn't break the rest).
    /// Also used by lib.rs's graveyard test.
    pub(crate) static PLATFORM_LIST: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn tmpdir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("micoll_an_{}_{}", tag, std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        d
    }

    #[test]
    fn analyze_managed_layout() {
        // Artist / Platform / Year / MM / Reward
        let base = tmpdir("managed");
        let artist = base.join("Pixelfox240");
        touch(artist.join("Patreon").join("2026").join("02").join("RewardA").join("01.jpg"));

        let plan = analyze(&artist.to_string_lossy());
        assert!(!plan.multi_artist);
        assert_eq!(plan.rewards.len(), 1);
        let r = &plan.rewards[0];
        assert_eq!(r.artist, "Pixelfox240");
        assert_eq!(r.platform.as_deref(), Some("Patreon"));
        assert_eq!(r.year, Some(2026));
        assert_eq!(r.month, Some(2));
        assert_eq!(r.title, "RewardA");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn organized_misc_and_unsorted_read_back() {
        // what organize writes: Artist / Misc|Unsorted|Platform / Misc (no date) / Reward
        let base = tmpdir("miscplat");
        let artist = base.join("Bonnie");
        touch(artist.join("Misc").join("Misc").join("RewardM").join("01.jpg"));
        touch(artist.join("Unsorted").join("Misc").join("RewardU").join("01.jpg"));
        touch(artist.join("Patreon").join("Misc").join("RewardP").join("01.jpg"));

        let plan = analyze(&artist.to_string_lossy());
        let by = |t: &str| plan.rewards.iter().find(|r| r.title == t).expect(t);

        let m = by("RewardM");
        assert_eq!(m.platform.as_deref(), Some("Misc"), "Misc under the creator is a platform");
        assert_eq!((m.year, m.category.as_deref()), (None, None), "inner Misc = no date");

        let u = by("RewardU");
        assert_eq!(u.platform, None, "Unsorted stays without a platform");
        assert_eq!(u.category, None);

        let p = by("RewardP");
        assert_eq!(p.platform.as_deref(), Some("Patreon"));
        assert_eq!(p.category, None, "the no-date folder isn't a category");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn analyze_flat_unknowns() {
        // only reward folders, no platform/date -> all unknown
        let base = tmpdir("flat");
        let artist = base.join("Mystery Batch");
        touch(artist.join("Reward One").join("01.jpg"));
        touch(artist.join("Reward Two").join("01.jpg"));

        let plan = analyze(&artist.to_string_lossy());
        assert!(!plan.multi_artist);
        assert_eq!(plan.rewards.len(), 2);
        assert!(plan.rewards.iter().all(|r| r.artist == "Mystery Batch"));
        assert!(plan.rewards.iter().all(|r| r.platform.is_none() && r.year.is_none()));
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn analyze_loose_image_folder() {
        // a single folder of images is one reward
        let base = tmpdir("loose");
        let folder = base.join("Kiko_2026-03");
        touch(folder.join("01.jpg"));
        touch(folder.join("02.png"));

        let plan = analyze(&folder.to_string_lossy());
        assert!(!plan.multi_artist);
        assert_eq!(plan.rewards.len(), 1, "expected the folder itself as one reward");
        let r = &plan.rewards[0];
        assert_eq!(r.artist, "Kiko");
        assert_eq!((r.year, r.month), (Some(2026), Some(3)));
        assert_eq!(r.image_count, 2);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn bundled_reward_stays_one_card_across_rescans() {
        // "XCharacter" with two gallery subfolders imported as one reward.
        // Rescans used to turn one card into three.
        let base = tmpdir("bundle");
        let pack = base.join("XCharacter");
        touch(pack.join("HDphotos").join("01.jpg"));
        touch(pack.join("HDphotos").join("02.jpg"));
        touch(pack.join("Selfies").join("03.jpg"));
        touch(pack.join("Selfies").join("04.jpg"));
        let folder = pack.to_string_lossy().into_owned();

        // what the review sends when folded: only the container
        let conn = db::open(&base.join("t.db")).unwrap();
        let bundled_import = vec![ResolvedReward {
            artist: "XCharacter".into(),
            platform: Some("Patreon".into()),
            year: Some(2026),
            month: Some(5),
            number: None,
            category: None,
            title: "testReward".into(),
            folder: folder.clone(),
            root: false,
            extra: false,
        }];
        commit(&conn, &bundled_import, None).unwrap();

        let count = |c: &Connection| -> i64 {
            c.query_row("SELECT COUNT(*) FROM rewards", [], |r| r.get(0)).unwrap()
        };
        assert_eq!(count(&conn), 1, "import makes exactly one card");
        assert_eq!(
            conn.query_row::<i64, _, _>("SELECT COUNT(*) FROM images", [], |r| r.get(0)).unwrap(),
            4,
            "the one card holds every file from both subfolders"
        );

        // rescan (the regression)
        let root = db::Root {
            id: 1,
            path: folder.clone(),
            label: None,
            default_platform: Some("Patreon".into()),
        };
        scan_root(&conn, &root).unwrap();
        assert_eq!(count(&conn), 1, "rescan must NOT split the bundle into extra cards");

        // twice, the flag must survive its own scan
        scan_root(&conn, &root).unwrap();
        assert_eq!(count(&conn), 1, "still one card after a second rescan");

        // the user's title stays, new files go into the bundle
        let title: String = conn
            .query_row("SELECT title FROM rewards", [], |r| r.get(0))
            .unwrap();
        assert_eq!(title, "testReward", "a rescan must not rename the card");

        touch(pack.join("Selfies").join("05.jpg"));
        scan_root(&conn, &root).unwrap();
        assert_eq!(count(&conn), 1);
        assert_eq!(
            conn.query_row::<i64, _, _>("SELECT COUNT(*) FROM images", [], |r| r.get(0)).unwrap(),
            5,
            "files added inside a bundle are indexed into that same card"
        );
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn auto_cover_is_not_a_custom_cover() {
        // the indexer sets cover_image itself, only set_reward_cover counts as a choice
        let base = tmpdir("cover");
        let pack = base.join("WCharacter");
        touch(pack.join("01.jpg"));

        let conn = db::open(&base.join("t.db")).unwrap();
        let plan = analyze(&pack.to_string_lossy());
        let resolved = auto_resolve(plan, Some("Patreon"));
        commit(&conn, &resolved, None).unwrap();

        let read = |c: &Connection| -> (Option<String>, i64) {
            c.query_row("SELECT cover_image, cover_custom FROM rewards", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap()
        };
        let (cover, custom) = read(&conn);
        assert!(cover.is_some(), "the indexer picks a cover on its own");
        assert_eq!(custom, 0, "but that is not the user's choice");

        let id: i64 = conn.query_row("SELECT id FROM rewards", [], |r| r.get(0)).unwrap();
        db::set_reward_cover(&conn, id, "/w/01.jpg").unwrap();
        assert_eq!(read(&conn).1, 1, "an explicit choice is remembered");

        db::set_reward_cover(&conn, id, "").unwrap();
        let (cover, custom) = read(&conn);
        assert!(cover.is_none());
        assert_eq!(custom, 0, "resetting clears the flag too");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn collab_link_survives_a_rescan() {
        // a rescan must not change reward ids (collab links use them)
        let base = tmpdir("collab");
        let pack = base.join("ZCharacter");
        touch(pack.join("01.jpg"));
        let folder = pack.to_string_lossy().into_owned();

        let conn = db::open(&base.join("t.db")).unwrap();
        let plan = analyze(&folder);
        let resolved = auto_resolve(plan, Some("Patreon"));
        commit(&conn, &resolved, None).unwrap();

        let reward: i64 = conn.query_row("SELECT id FROM rewards", [], |r| r.get(0)).unwrap();
        conn.execute("INSERT INTO artists(name) VALUES('Partner')", []).unwrap();
        let partner: i64 = conn
            .query_row("SELECT id FROM artists WHERE name='Partner'", [], |r| r.get(0))
            .unwrap();
        db::set_reward_collabs(&conn, reward, &[partner]).unwrap();

        let root = db::Root {
            id: 1,
            path: folder.clone(),
            label: None,
            default_platform: Some("Patreon".into()),
        };
        scan_root(&conn, &root).unwrap();
        scan_root(&conn, &root).unwrap();

        let after: i64 = conn.query_row("SELECT id FROM rewards", [], |r| r.get(0)).unwrap();
        assert_eq!(after, reward, "a rescan must not churn the reward id");
        let (links, linked): (i64, i64) = conn
            .query_row(
                "SELECT COUNT(*), COALESCE(MAX(reward_id), -1) FROM reward_collabs",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!((links, linked), (1, reward), "the collab link survives rescans");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn split_subfolders_stay_split_across_rescans() {
        // the same layout imported as SEPARATE rewards must stay separate
        let base = tmpdir("split");
        let pack = base.join("YCharacter");
        touch(pack.join("HDphotos").join("01.jpg"));
        touch(pack.join("Selfies").join("02.jpg"));

        let conn = db::open(&base.join("t.db")).unwrap();
        let plan = analyze(&pack.to_string_lossy());
        assert_eq!(plan.rewards.len(), 2, "both galleries are detected");
        let resolved = auto_resolve(plan, Some("Patreon"));
        commit(&conn, &resolved, None).unwrap();

        let count = |c: &Connection| -> i64 {
            c.query_row("SELECT COUNT(*) FROM rewards", [], |r| r.get(0)).unwrap()
        };
        assert_eq!(count(&conn), 2);

        let root = db::Root {
            id: 1,
            path: pack.to_string_lossy().into_owned(),
            label: None,
            default_platform: Some("Patreon".into()),
        };
        scan_root(&conn, &root).unwrap();
        assert_eq!(count(&conn), 2, "split rewards stay split");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn analyze_bare_date_month_folders() {
        // reward folders named as dates with loose files: each gets its own month and is
        // root
        let base = tmpdir("baredate");
        let artist = base.join("SomeArtist");
        touch(artist.join("2025-08").join("01.jpg"));
        touch(artist.join("2025-09").join("01.jpg"));
        touch(artist.join("2025-10").join("01.jpg"));

        let plan = analyze(&artist.to_string_lossy());
        assert!(!plan.multi_artist);
        assert_eq!(plan.rewards.len(), 3);
        for (folder, month) in [("2025-08", 8), ("2025-09", 9), ("2025-10", 10)] {
            let r = plan
                .rewards
                .iter()
                .find(|r| r.folder.ends_with(folder))
                .unwrap_or_else(|| panic!("missing {folder}"));
            assert_eq!((r.year, r.month), (Some(2025), Some(month)), "wrong date for {folder}");
            assert!(r.root, "{folder} should be a month-root gallery");
        }
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn analyze_many_artists() {
        let base = tmpdir("many");
        touch(base.join("ArtistA").join("Patreon").join("2026-02").join("R1").join("01.jpg"));
        touch(base.join("ArtistB").join("2025").join("R2").join("01.jpg"));

        let plan = analyze(&base.to_string_lossy());
        assert!(plan.multi_artist, "expected multiple artists");
        let a = plan.rewards.iter().find(|r| r.artist == "ArtistA").unwrap();
        assert_eq!(a.platform.as_deref(), Some("Patreon"));
        assert_eq!((a.year, a.month), (Some(2026), Some(2)));
        let b = plan.rewards.iter().find(|r| r.artist == "ArtistB").unwrap();
        assert_eq!(b.platform, None);
        assert_eq!((b.year, b.month), (Some(2025), None));
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn numbered_run_detected_as_drops() {
        // a creator with reward folders "51".."55": each is a drop, not a category or
        // creator
        let base = tmpdir("numrun");
        let artist = base.join("DropArtist");
        for n in 51..=55 {
            touch(artist.join(n.to_string()).join("Pack").join("01.jpg"));
        }

        let plan = analyze(&artist.to_string_lossy());
        assert!(!plan.multi_artist);
        assert_eq!(plan.rewards.len(), 5);
        for n in 51..=55i64 {
            let r = plan
                .rewards
                .iter()
                .find(|r| r.number == Some(n))
                .unwrap_or_else(|| panic!("missing drop #{n}"));
            assert_eq!(r.artist, "DropArtist");
            assert_eq!(r.title, "Pack");
            assert_eq!((r.year, r.month), (None, None));
            assert!(r.category.is_none(), "number must not become a category");
        }
        // and the plan suggests numbered
        let prop = plan.artists.iter().find(|a| a.name == "DropArtist").unwrap();
        assert_eq!(prop.proposed_style, "numbered");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn numbered_run_with_loose_media_is_root() {
        // drop folders with files directly: each is the drop's root reward
        let base = tmpdir("numroot");
        let artist = base.join("DropArtist");
        for n in [86, 87, 88] {
            touch(artist.join(n.to_string()).join("01.jpg"));
        }

        let plan = analyze(&artist.to_string_lossy());
        assert_eq!(plan.rewards.len(), 3);
        for r in &plan.rewards {
            assert!(r.number.is_some(), "expected a drop number on {}", r.folder);
            assert!(r.root, "loose files in a drop folder are its root reward");
        }
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn year_folders_are_not_a_numbered_run() {
        // 4-digit year folders stay years
        let base = tmpdir("years");
        let artist = base.join("Dated");
        touch(artist.join("2023").join("R1").join("01.jpg"));
        touch(artist.join("2024").join("R2").join("01.jpg"));
        touch(artist.join("2025").join("R3").join("01.jpg"));
        touch(artist.join("2026").join("R4").join("01.jpg"));

        let plan = analyze(&artist.to_string_lossy());
        assert_eq!(plan.rewards.len(), 4);
        assert!(plan.rewards.iter().all(|r| r.number.is_none()));
        assert!(plan.rewards.iter().all(|r| r.year.is_some()));
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn months_under_a_year_stay_months() {
        // 1-12 folders under a year stay months
        let base = tmpdir("monthprio");
        let artist = base.join("Monthly");
        for m in ["01", "02", "03", "04"] {
            touch(artist.join("2025").join(m).join("R").join("01.jpg"));
        }

        let plan = analyze(&artist.to_string_lossy());
        assert_eq!(plan.rewards.len(), 4);
        for r in &plan.rewards {
            assert_eq!(r.year, Some(2025));
            assert!(r.month.is_some(), "expected a month for {}", r.folder);
            assert!(r.number.is_none(), "no drop numbers inside a year context");
        }
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn analyze_managed_numbered_layout() {
        // "#51" folders written by organize map back to drop 51
        let base = tmpdir("managednum");
        let artist = base.join("Nora");
        touch(artist.join("Patreon").join("#51").join("HD Pack").join("01.jpg"));
        touch(artist.join("Patreon").join("#52").join("01.jpg")); // root drop

        let plan = analyze(&artist.to_string_lossy());
        assert_eq!(plan.rewards.len(), 2);
        let a = plan.rewards.iter().find(|r| r.number == Some(51)).expect("#51");
        assert_eq!(a.platform.as_deref(), Some("Patreon"));
        assert_eq!(a.title, "HD Pack");
        assert!(!a.root);
        let b = plan.rewards.iter().find(|r| r.number == Some(52)).expect("#52");
        assert!(b.root, "loose files in #52 are its root reward");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn period_keys_stay_stable_and_numbered_keys_are_distinct() {
        // monthly/Misc keys must stay exactly the same, otherwise rescans duplicate periods
        assert_eq!(
            period_key("A", Some("Patreon"), Some(2026), Some(2), None),
            "A\u{1}Patreon\u{1}2026\u{1}2",
        );
        assert_eq!(period_key("A", None, None, None, None), "A\u{1}?\u{1}\u{1}");
        // numbered keys have a 5th part
        let numbered = period_key("A", Some("Patreon"), None, None, Some(51));
        assert_eq!(numbered, "A\u{1}Patreon\u{1}\u{1}\u{1}n51");
        assert_ne!(numbered, period_key("A", Some("Patreon"), None, None, None));
        assert_ne!(numbered, period_key("A", Some("Patreon"), None, None, Some(52)));
    }

    #[test]
    fn style_proposals_cover_all_three() {
        // monthly: any date, none: no dates and no numbers
        let base = tmpdir("proposals");
        touch(base.join("Dated").join("2026-02").join("01.jpg"));
        touch(base.join("Loose").join("Some Pack").join("01.jpg"));

        let plan = analyze(&base.to_string_lossy());
        let style = |n: &str| {
            plan.artists
                .iter()
                .find(|a| a.name == n)
                .unwrap_or_else(|| panic!("no proposal for {n}"))
                .proposed_style
                .clone()
        };
        assert_eq!(style("Dated"), "monthly");
        assert_eq!(style("Loose"), "none");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn nested_reward_files_are_not_duplicated_into_the_parent() {
        // "rewardx" with loose files AND a "rewardy" subfolder: rewardx only indexes its
        // own files
        let base = tmpdir("nestdup");
        let folder = base.join("rewardx");
        touch(folder.join("01.jpg"));
        touch(folder.join("02.jpg"));
        touch(folder.join("rewardy").join("01.jpg"));

        let plan = analyze(&folder.to_string_lossy());
        assert_eq!(plan.rewards.len(), 2, "expected rewardx + rewardy");

        let conn = crate::db::open(&base.join("t.db")).unwrap();
        let resolved = auto_resolve(plan, Some("Patreon"));
        commit(&conn, &resolved, None).unwrap();

        let count = |title: &str| -> i64 {
            conn.query_row(
                "SELECT COUNT(*) FROM images i JOIN rewards r ON r.id = i.reward_id
                 WHERE r.title = ?1",
                params![title],
                |r| r.get(0),
            )
            .unwrap()
        };
        assert_eq!(count("rewardx"), 2, "parent must not swallow the nested reward's files");
        assert_eq!(count("rewardy"), 1);
        // the parent's cover is one of its own files
        let cover: String = conn
            .query_row(
                "SELECT cover_image FROM rewards WHERE title = 'rewardx'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(!cover.contains("rewardy"), "cover leaked into the nested reward: {cover}");

        let _ = std::fs::remove_dir_all(&base);
    }

    /// the tile showed a different picture than the reward opens on (byte order vs natural)
    #[test]
    fn the_cover_is_the_first_picture_the_viewer_shows() {
        let base = tmpdir("natcover");
        let r = base.join("Pack");
        for f in ["pic10.jpg", "pic2.jpg", "Pic3.jpg"] {
            touch(r.join(f));
        }
        let (images, cover) = collect_reward_images(&r);
        assert!(cover.unwrap().ends_with("pic2.jpg"));
        let order: Vec<&str> = images.iter().map(|(_, rel)| rel.as_str()).collect();
        assert_eq!(order, ["pic2.jpg", "Pic3.jpg", "pic10.jpg"]);
        // ...and the old pick really was wrong
        assert!(legacy_cover_pick(&images).unwrap().ends_with("Pic3.jpg"));
    }

    /// a rescan fixes an old automatic cover but leaves chosen ones alone
    #[test]
    fn a_rescan_corrects_old_automatic_covers_and_nothing_else() {
        let _job = PLATFORM_LIST.lock().unwrap_or_else(|e| e.into_inner());
        let base = tmpdir("coverfix");
        let pack = base.join("Nora").join("Patreon").join("2026-03").join("Pack");
        for f in ["pic10.jpg", "pic2.jpg", "Pic3.jpg"] {
            touch(pack.join(f));
        }
        let conn = db::open(&base.join("t.db")).unwrap();
        let root = db::Root {
            id: 1,
            path: base.to_string_lossy().to_string(),
            label: None,
            default_platform: None,
        };
        scan_root(&conn, &root).unwrap();
        let cover = || -> String {
            conn.query_row("SELECT cover_image FROM rewards WHERE title = 'Pack'", [], |r| r.get(0))
                .unwrap()
        };
        let set = |file: &str, custom: i64| {
            conn.execute(
                "UPDATE rewards SET cover_image = ?1, cover_custom = ?2 WHERE title = 'Pack'",
                params![pack.join(file).to_string_lossy(), custom],
            )
            .unwrap();
        };
        assert!(cover().ends_with("pic2.jpg"), "a fresh import picks right");

        // old library: the old automatic pick, no flag
        set("Pic3.jpg", 0);
        scan_root(&conn, &root).unwrap();
        assert!(cover().ends_with("pic2.jpg"), "an old automatic pick is corrected");

        // a cover picked by hand before cover_custom existed (not an automatic pick)
        set("pic10.jpg", 0);
        scan_root(&conn, &root).unwrap();
        assert!(cover().ends_with("pic10.jpg"), "a pre-flag choice stays");

        // a flagged choice, even if it's the old automatic pick
        set("Pic3.jpg", 1);
        scan_root(&conn, &root).unwrap();
        assert!(cover().ends_with("Pic3.jpg"), "a flagged choice stays");

        let _ = std::fs::remove_dir_all(&base);
    }

    /// an "Extra" folder starts as extra, a rescan doesn't change it
    #[test]
    fn an_extra_folder_arrives_marked_and_stays_how_the_user_left_it() {
        let _job = PLATFORM_LIST.lock().unwrap_or_else(|e| e.into_inner());
        let base = tmpdir("extras");
        let month = base.join("Nora").join("Patreon").join("2026-03");
        touch(month.join("Pack A").join("01.jpg"));
        touch(month.join("Extra").join("Sketches").join("01.jpg"));

        let conn = db::open(&base.join("t.db")).unwrap();
        let root = db::Root {
            id: 1,
            path: base.to_string_lossy().to_string(),
            label: None,
            default_platform: None,
        };
        scan_root(&conn, &root).unwrap();

        let extra_of = |title: &str| -> i64 {
            conn.query_row(
                "SELECT is_extra FROM rewards WHERE title = ?1",
                params![title],
                |r| r.get(0),
            )
            .unwrap()
        };
        assert_eq!(extra_of("Sketches"), 1, "the Extra folder's reward is marked");
        assert_eq!(extra_of("Pack A"), 0, "its neighbour is not");

        // the user changed it, a rescan must respect that
        let id: i64 = conn
            .query_row("SELECT id FROM rewards WHERE title = 'Sketches'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(db::set_rewards_extra(&conn, &[id], false).unwrap(), 1);
        scan_root(&conn, &root).unwrap();
        assert_eq!(extra_of("Sketches"), 0, "a rescan does not re-decide it");

        let _ = std::fs::remove_dir_all(&base);
    }

    /// a two-part pack where part 2 has only files we can't show (used to be lost)
    #[test]
    fn a_part_with_no_showable_file_is_imported_too() {
        let base = tmpdir("psdpart");
        let reward = base.join("Big Pack");
        touch(reward.join("part 1").join("01.jpg"));
        touch(reward.join("part 1").join("02.jpg"));
        touch(reward.join("part 2").join("artwork.psd"));
        touch(reward.join("part 2").join("layers.clip"));

        let plan = analyze(&reward.to_string_lossy());
        let part2 = plan
            .rewards
            .iter()
            .find(|r| r.folder.ends_with("part 2"))
            .expect("a folder of PSDs is content, not nothing");
        assert_eq!(part2.image_count, 2, "and every file in it comes along");
        assert!(plan.rewards.iter().any(|r| r.folder.ends_with("part 1")));
    }

    /// a stray file at a structure level doesn't swallow the level, and isn't lost:
    /// it becomes its own reward
    #[test]
    fn a_stray_file_at_a_level_is_kept_without_swallowing_the_level() {
        let base = tmpdir("stray");
        let plat = base.join("Patreon");
        touch(plat.join("links.txt"));
        touch(plat.join("2026-05").join("Pack").join("01.jpg"));

        let plan = analyze(&plat.to_string_lossy());
        let pack = plan
            .rewards
            .iter()
            .find(|r| r.folder.ends_with("Pack"))
            .expect("the real reward is still found");
        assert_eq!((pack.year, pack.month), (Some(2026), Some(5)), "and still dated");
        assert!(
            plan.rewards.iter().any(|r| r.folder.ends_with("Patreon")),
            "and the loose file came along instead of vanishing"
        );
    }

    #[test]
    fn subfolder_only_character_is_one_reward() {
        // a dated drop with character folders, one of them (CharY) has subfolders.
        // CharY must be its own reward with the subfolders folded in.
        let base = tmpdir("charsub");
        let month = base.join("2026-05");
        touch(month.join("CharX").join("01.jpg"));
        touch(month.join("CharX").join("02.jpg"));
        touch(month.join("CharX").join("03.jpg"));
        touch(month.join("CharY").join("setA").join("01.jpg"));
        touch(month.join("CharY").join("setB").join("01.jpg"));
        touch(month.join("CharY").join("setC").join("01.jpg"));
        touch(month.join("CharZ").join("01.jpg"));

        let plan = analyze(&month.to_string_lossy());
        // CharX, CharZ (direct), CharY (container) + CharY/setA,setB,setC
        let chary = plan
            .rewards
            .iter()
            .find(|r| r.folder.ends_with("CharY"))
            .expect("CharY must be emitted as its own reward");
        assert_eq!(chary.title, "CharY");
        let charx = plan.rewards.iter().find(|r| r.title == "CharX").expect("CharX");
        // the date-named root gives the period for everything inside
        assert_eq!((charx.year, charx.month), (Some(2026), Some(5)));
        assert_eq!((chary.year, chary.month), (charx.year, charx.month));
        assert!(plan.rewards.iter().any(|r| r.title == "CharZ"));
        assert!(plan.rewards.iter().any(|r| r.folder.ends_with("setA")));

        let count = |conn: &Connection, title: &str| -> i64 {
            conn.query_row(
                "SELECT COUNT(*) FROM images i JOIN rewards r ON r.id = i.reward_id WHERE r.title = ?1",
                params![title],
                |r| r.get(0),
            )
            .unwrap()
        };
        let has_reward = |conn: &Connection, title: &str| -> bool {
            conn.query_row(
                "SELECT COUNT(*) FROM rewards WHERE title = ?1",
                params![title],
                |r| r.get::<_, i64>(0),
            )
            .unwrap()
                > 0
        };

        // FOLDED (default): only the 3 characters, CharY has all its subfolders' images
        let folded_base = base.join("folded");
        std::fs::create_dir_all(&folded_base).unwrap();
        let conn = crate::db::open(&folded_base.join("t.db")).unwrap();
        let folded: Vec<ResolvedReward> = ["CharX", "CharY", "CharZ"]
            .iter()
            .map(|c| ResolvedReward {
                artist: "Batch".into(),
                platform: Some("Patreon".into()),
                year: Some(2026),
                month: Some(5),
                number: None,
                category: None,
                title: (*c).into(),
                folder: month.join(c).to_string_lossy().to_string(),
                root: false,
                extra: false,
            })
            .collect();
        commit(&conn, &folded, None).unwrap();
        assert_eq!(count(&conn, "CharY"), 3, "folded CharY gathers all subfolder images");
        assert!(!has_reward(&conn, "setA"), "subfolders must not be separate rewards when folded");

        // SPLIT: the subfolders are rewards, the empty CharY container is dropped
        let split_base = base.join("split");
        std::fs::create_dir_all(&split_base).unwrap();
        let conn2 = crate::db::open(&split_base.join("t.db")).unwrap();
        let mk = |folder: PathBuf, title: &str| ResolvedReward {
            artist: "Batch".into(),
            platform: Some("Patreon".into()),
            year: Some(2026),
            month: Some(5),
            number: None,
            category: None,
            title: title.into(),
            folder: folder.to_string_lossy().to_string(),
            root: false,
            extra: false,
        };
        let split = vec![
            mk(month.join("CharY"), "CharY"),
            mk(month.join("CharY").join("setA"), "setA"),
            mk(month.join("CharY").join("setB"), "setB"),
            mk(month.join("CharY").join("setC"), "setC"),
        ];
        commit(&conn2, &split, None).unwrap();
        assert!(!has_reward(&conn2, "CharY"), "empty container dropped when children split out");
        assert_eq!(count(&conn2, "setA"), 1);
        assert_eq!(count(&conn2, "setB"), 1);

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn analyze_platform_in_reward_name() {
        // platform and date in the reward folder's own name with images inside
        let base = tmpdir("platinname");
        let artist = base.join("Pixelfox240");
        touch(artist.join("Patreon_2026-02").join("01.jpg"));
        touch(artist.join("Fansly_2026-03").join("01.jpg"));

        let plan = analyze(&artist.to_string_lossy());
        assert_eq!(plan.rewards.len(), 2);
        let p = plan
            .rewards
            .iter()
            .find(|r| r.platform.as_deref() == Some("Patreon"))
            .expect("Patreon detected");
        assert_eq!((p.year, p.month), (Some(2026), Some(2)));
        let f = plan
            .rewards
            .iter()
            .find(|r| r.platform.as_deref() == Some("Fansly"))
            .expect("Fansly detected");
        assert_eq!((f.year, f.month), (Some(2026), Some(3)));
        let _ = std::fs::remove_dir_all(&base);
    }
}
