//! Artist templates ("verified collection log").
//! A template is a JSON file describing what an artist released
//! (Artist -> Platform -> Year -> Month -> rewards) plus their links. Applying it:
//!   * adds the artist and saves the template (-> "Verified" badge)
//!   * merges the links into the artist's links
//!   * sets the official reward count per period and adds every listed reward
//!     as a "missing" placeholder (skips ones that already exist)
//!   * optionally creates the empty Platform/Year/MM/<reward> folders
//!
//! When real files get indexed into such a folder, the indexer flips it to "owned".

use crate::db;
use crate::indexer;
use base64::{engine::general_purpose::STANDARD, Engine as _};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::{Path, PathBuf};

/* ---- on-disk format (v1) --------------------------------------------- */

#[derive(Deserialize, Clone)]
pub struct TemplateFile {
    #[serde(rename = "micollTemplate")]
    pub version: u32,
    pub artist: TemplateArtist,
    /// Tells apart several templates for the SAME artist (e.g. "Patreon 2025").
    /// Empty -> the artist name. Used as key and file name.
    #[serde(default)]
    pub label: String,
    /// Main verified flag -> every period in the template is verified.
    #[serde(default)]
    pub verified: bool,
    #[serde(default)]
    pub platforms: Vec<TemplatePlatform>,
    #[serde(default)]
    pub meta: Option<TemplateMeta>,
}

#[derive(Deserialize, Clone)]
pub struct TemplateArtist {
    pub name: String,
    /// Creator type, comma separated (options are in src/lib/creatorTypes.tsx).
    #[serde(default, rename = "type")]
    pub kind: Option<String>,
    /// For matching an existing artist by alias later.
    #[serde(default)]
    #[allow(dead_code)]
    pub aliases: Vec<String>,
    #[serde(default)]
    pub links: Vec<TemplateLink>,
}

#[derive(Deserialize, Serialize, Clone)]
pub struct TemplateLink {
    #[serde(default)]
    pub label: String,
    pub url: String,
}

#[derive(Deserialize, Clone)]
pub struct TemplatePlatform {
    pub name: String,
    #[serde(default)]
    pub url: Option<String>,
    /// Verify every period of this platform.
    #[serde(default)]
    pub verified: bool,
    #[serde(default)]
    pub periods: Vec<TemplatePeriod>,
}

#[derive(Deserialize, Clone)]
pub struct TemplatePeriod {
    #[serde(default)]
    pub year: Option<i64>,
    #[serde(default)]
    pub month: Option<i64>,
    /// The custom style's names ("Summer", "Part 1"), they replace year and month. A
    /// period with a yearName makes its platform a custom one.
    #[serde(default, rename = "yearName")]
    pub year_name: Option<String>,
    #[serde(default, rename = "monthName")]
    pub month_name: Option<String>,
    /// How many months this release covers (1 = one month). A March release that also
    /// counts for April = month=3, span=2.
    #[serde(default)]
    pub span: Option<i64>,
    /// The artist took a break this month (no rewards, shown as "Break").
    #[serde(default)]
    pub skipped: bool,
    /// Verify only this period.
    #[serde(default)]
    pub verified: bool,
    /// Optional month cover as inline data URL. Written into the month folder on apply.
    #[serde(default)]
    pub cover: Option<String>,
    /// Only a count of rewards (when they aren't named). Ignored if rewards is set.
    #[serde(default)]
    pub count: Option<i64>,
    #[serde(default)]
    pub rewards: Vec<TemplateReward>,
}

impl TemplatePeriod {
    /// Official count: named rewards, else the count. A break releases nothing.
    pub fn total(&self) -> i64 {
        if self.skipped {
            0
        } else if !self.rewards.is_empty() {
            self.rewards.len() as i64
        } else {
            self.count.unwrap_or(0).max(0)
        }
    }

    /// Months this period covers (>= 1).
    pub fn span_months(&self) -> i64 {
        self.span.unwrap_or(1).max(1)
    }

    /// The custom names as their folders are called. None = a dated period.
    pub fn names(&self) -> Option<(String, Option<String>)> {
        let year = indexer::custom_word(self.year_name.as_deref())?;
        Some((year, indexer::custom_word(self.month_name.as_deref())))
    }

    /// This period's year and month numbers. A custom name gets its number with create,
    /// without it None = that name doesn't exist (anymore).
    pub fn numbers(
        &self,
        conn: &Connection,
        artist_id: i64,
        platform: Option<&str>,
        create: bool,
    ) -> rusqlite::Result<Option<(Option<i64>, Option<i64>)>> {
        let Some((year, month)) = self.names() else {
            return Ok(Some((self.year, self.month)));
        };
        if create {
            let y = db::custom_year(conn, artist_id, platform, &year)?;
            let m = month.map(|n| db::custom_month(conn, artist_id, platform, y, &n)).transpose()?;
            return Ok(Some((Some(y), m)));
        }
        let Some(y) = db::custom_year_known(conn, artist_id, platform, &year)? else {
            return Ok(None);
        };
        match month {
            None => Ok(Some((Some(y), None))),
            Some(n) => Ok(db::custom_month_known(conn, artist_id, platform, y, &n)?.map(|m| (Some(y), Some(m)))),
        }
    }
}

#[derive(Deserialize, Clone)]
pub struct TemplateReward {
    pub title: String,
    #[serde(default)]
    pub category: Option<String>,
}

#[derive(Deserialize, Clone)]
#[allow(dead_code)]
pub struct TemplateMeta {
    #[serde(default)]
    pub version: Option<String>,
    #[serde(default)]
    pub author: Option<String>,
    #[serde(default)]
    pub updated: Option<String>,
}

/// Summary for the UI (import result / template list).
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TemplatePreview {
    pub file_name: String,
    pub artist: String,
    /// Optional label (e.g. "Patreon 2025").
    pub label: Option<String>,
    pub kind: Option<String>,
    pub verified: bool,
    pub platforms: i64,
    pub periods: i64,
    pub rewards: i64,
    pub links: i64,
    pub version: Option<String>,
    /// "Last updated" date from meta.updated (free text).
    pub updated: Option<String>,
    /// Is this template applied right now? (set by list_templates, false from preview())
    #[serde(default)]
    pub applied: bool,
    /// File size (almost all of it is the inline covers).
    #[serde(default)]
    pub bytes: u64,
    /// A .orig backup exists (covers were shrunk, the original can be restored).
    #[serde(default)]
    pub has_original: bool,
}

/* ---- parse / validate / summarize ------------------------------------ */

/// Parse a template (plain JSON or signed, see signing.rs).
/// verified flags only count with a valid signature. A plain file imports as
/// unverified. A file that claims to be signed but fails the check is rejected.
pub fn parse(json: &str) -> Result<TemplateFile, String> {
    parse_with_keys(json, crate::signing::OFFICIAL_KEYS)
}

fn parse_with_keys(json: &str, keys: &[(u32, [u8; 32])]) -> Result<TemplateFile, String> {
    match crate::signing::detect_envelope(json)? {
        Some(env) => {
            let inner = env.verify_with(keys)?;
            parse_inner(&inner)
        }
        None => {
            let mut t = parse_inner(json)?;
            strip_verified(&mut t);
            Ok(t)
        }
    }
}

fn parse_inner(json: &str) -> Result<TemplateFile, String> {
    let t: TemplateFile =
        serde_json::from_str(json).map_err(|e| format!("Invalid template JSON: {e}"))?;
    if t.version != 1 {
        return Err(format!(
            "Unsupported template version {} (this build understands version 1).",
            t.version
        ));
    }
    if t.artist.name.trim().is_empty() {
        return Err("Template is missing an artist name.".into());
    }
    Ok(t)
}

/// Remove every verified flag.
fn strip_verified(t: &mut TemplateFile) {
    t.verified = false;
    for p in &mut t.platforms {
        p.verified = false;
        for per in &mut p.periods {
            per.verified = false;
        }
    }
}

/// Reject a template that has the same period twice on one platform
/// (would count rewards double).
pub fn check_no_duplicate_periods(t: &TemplateFile) -> Result<(), String> {
    use std::collections::HashSet;
    // key by (platform, year, month) over all platform blocks (also catches a platform
    // split in two)
    let mut seen: HashSet<(String, Option<String>, Option<String>)> = HashSet::new();
    for plat in &t.platforms {
        let pkey = plat.name.trim().to_lowercase();
        let plabel = if plat.name.trim().is_empty() {
            "this platform".to_string()
        } else {
            plat.name.trim().to_string()
        };
        for per in &plat.periods {
            let names = per.names();
            let (year, month) = match &names {
                Some((y, m)) => (Some(y.to_lowercase()), m.as_ref().map(|m| m.to_lowercase())),
                None => (per.year.map(|y| y.to_string()), per.month.map(|m| m.to_string())),
            };
            if !seen.insert((pkey.clone(), year, month)) {
                let when = match (&names, per.year, per.month) {
                    (Some((y, Some(m))), ..) => format!("{y} › {m}"),
                    (Some((y, None)), ..) => y.clone(),
                    (None, Some(y), Some(m)) => format!("{y}-{m:02}"),
                    (None, Some(y), None) => format!("{y} (whole year)"),
                    (None, None, Some(m)) => format!("month {m}"),
                    (None, None, None) => "an undated period".to_string(),
                };
                return Err(format!(
                    "This template lists {when} more than once on {plabel}. A month may \
                     appear only once per platform — remove the duplicate period and try \
                     again. The template was not applied."
                ));
            }
        }
    }
    Ok(())
}

/// A template list row: names and counts only, no JSON.
/// The JSON used to be included and made Settings load 84 MB. Callers that need
/// it (apply, deactivate, export, edit) use read_template.
pub fn preview(t: &TemplateFile, file_name: &str) -> TemplatePreview {
    let periods: i64 = t.platforms.iter().map(|p| p.periods.len() as i64).sum();
    let rewards: i64 = t
        .platforms
        .iter()
        .flat_map(|p| &p.periods)
        .map(|pr| pr.total())
        .sum();
    let links = t.artist.links.len() as i64
        + t.platforms.iter().filter(|p| has_url(&p.url)).count() as i64;
    TemplatePreview {
        file_name: file_name.to_string(),
        artist: t.artist.name.trim().to_string(),
        label: Some(t.label.trim())
            .filter(|s| !s.is_empty())
            .map(str::to_string),
        verified: t.verified,
        kind: t
            .artist
            .kind
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string),
        platforms: t.platforms.len() as i64,
        periods,
        rewards,
        links,
        version: t.meta.as_ref().and_then(|m| m.version.clone()),
        updated: t.meta.as_ref().and_then(|m| m.updated.clone()),
        applied: false,
        // file info, filled in by list_templates
        bytes: 0,
        has_original: false,
    }
}

fn has_url(u: &Option<String>) -> bool {
    u.as_deref().map(|s| !s.trim().is_empty()).unwrap_or(false)
}

/* ---- coverage & overlap --------------------------------------------- */

/// One (platform, year, month) cell a template covers. month None = the whole year.
#[derive(Serialize, Deserialize, Clone)]
pub struct CoverKey {
    pub platform: String,
    pub year: Option<i64>,
    pub month: Option<i64>,
    /// Custom names, lowercase. They stand in for year and month.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub year_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub month_name: Option<String>,
}

impl CoverKey {
    fn same_platform(&self, o: &CoverKey) -> bool {
        self.platform.trim().eq_ignore_ascii_case(o.platform.trim())
    }
    /// A dated cell has no names, so these compare both kinds.
    fn year_id(&self) -> Option<String> {
        self.year_name.clone().or_else(|| self.year.map(|y| y.to_string()))
    }
    fn month_id(&self) -> Option<String> {
        self.month_name.clone().or_else(|| self.month.map(|m| m.to_string()))
    }
    fn conflicts(&self, o: &CoverKey) -> bool {
        if !self.same_platform(o) || self.year_id() != o.year_id() {
            return false;
        }
        // a whole year collides with any month of that year
        let (a, b) = (self.month_id(), o.month_id());
        a == b || a.is_none() || b.is_none()
    }
    fn describe(&self) -> String {
        if let Some(y) = &self.year_name {
            return match &self.month_name {
                Some(m) => format!("{} {} › {}", self.platform, y, m),
                None => format!("{} {}", self.platform, y),
            };
        }
        match (self.year, self.month) {
            (Some(y), Some(m)) => format!("{} {}-{:02}", self.platform, y, m),
            (Some(y), None) => format!("{} {}", self.platform, y),
            _ => format!("{} (undated)", self.platform),
        }
    }

    /// This cell's year and month numbers for a creator. None = its name doesn't exist.
    pub fn numbers(
        &self,
        conn: &Connection,
        artist_id: i64,
    ) -> rusqlite::Result<Option<(Option<i64>, Option<i64>)>> {
        let Some(name) = &self.year_name else {
            return Ok(Some((self.year, self.month)));
        };
        let platform = Some(self.platform.as_str());
        let Some(y) = db::custom_year_known(conn, artist_id, platform, name)? else {
            return Ok(None);
        };
        match &self.month_name {
            None => Ok(Some((Some(y), self.month))),
            Some(n) => Ok(db::custom_month_known(conn, artist_id, platform, y, n)?.map(|m| (Some(y), Some(m)))),
        }
    }
}

/// All cells a template covers (multi-month spans split into months, with year roll-over).
pub fn coverage(t: &TemplateFile) -> Vec<CoverKey> {
    let mut out = Vec::new();
    for plat in &t.platforms {
        let platform = plat.name.trim().to_string();
        for per in &plat.periods {
            let names = per.names();
            // real dates stay dates, so they still collide with a dated template
            let (year, month) = match &names {
                Some((y, m)) => (
                    db::real_year(y),
                    m.as_deref().and_then(db::real_month),
                ),
                None => (per.year, per.month),
            };
            let word = names.as_ref().is_some_and(|(y, m)| {
                db::real_year(y).is_none() || m.as_deref().is_some_and(|m| db::real_month(m).is_none())
            });
            if let (true, Some((y, m))) = (word, &names) {
                out.push(CoverKey {
                    platform: platform.clone(),
                    year: None,
                    month: None,
                    year_name: Some(y.to_lowercase()),
                    month_name: m.as_ref().map(|m| m.to_lowercase()),
                });
                continue;
            }
            match (year, month) {
                (Some(y), Some(m0)) => {
                    let (mut y, mut m) = (y, m0);
                    for _ in 0..per.span_months() {
                        out.push(CoverKey {
                            platform: platform.clone(),
                            year: Some(y),
                            month: Some(m),
                            year_name: None,
                            month_name: None,
                        });
                        m += 1;
                        if m > 12 {
                            m = 1;
                            y += 1;
                        }
                    }
                }
                (y, _) => out.push(CoverKey {
                    platform: platform.clone(),
                    year: y,
                    month: None,
                    year_name: None,
                    month_name: None,
                }),
            }
        }
    }
    out
}

/// First cell in new that collides with existing (-> overlap error).
fn first_conflict(new: &[CoverKey], existing: &[CoverKey]) -> Option<String> {
    for a in new {
        for b in existing {
            if a.conflicts(b) {
                return Some(a.describe());
            }
        }
    }
    None
}

/// Decode an inline data URL cover into (bytes, extension).
fn decode_cover(data_url: &str) -> Option<(Vec<u8>, &'static str)> {
    let head = &data_url[..data_url.len().min(32)];
    let ext = if head.starts_with("data:image/png") {
        "png"
    } else if head.starts_with("data:image/jpeg") || head.starts_with("data:image/jpg") {
        "jpg"
    } else if head.starts_with("data:image/webp") {
        "webp"
    } else if head.starts_with("data:image/gif") {
        "gif"
    } else {
        "png"
    };
    let payload = data_url.split(";base64,").nth(1).unwrap_or(data_url);
    STANDARD.decode(payload.trim()).ok().map(|b| (b, ext))
}

/// Template key: the label, else the artist name.
/// Same rule as preview builds it, so we don't have to read the file again.
pub fn preview_label(p: &TemplatePreview) -> String {
    p.label.clone().unwrap_or_else(|| p.artist.clone())
}

pub fn template_label(t: &TemplateFile) -> String {
    let l = t.label.trim();
    if l.is_empty() {
        t.artist.name.trim().to_string()
    } else {
        l.to_string()
    }
}

/// Does this template verify anything?
fn grants_verified(t: &TemplateFile) -> bool {
    t.verified
        || t.platforms
            .iter()
            .any(|p| p.verified || p.periods.iter().any(|pr| pr.verified))
}

/// Set verified on every period the template marks verified.
fn apply_verified(conn: &Connection, artist_id: i64, t: &TemplateFile) -> rusqlite::Result<()> {
    for plat in &t.platforms {
        let platform = plat.name.trim();
        for per in &plat.periods {
            if t.verified || plat.verified || per.verified {
                if let Some((year, month)) = per.numbers(conn, artist_id, Some(platform), false)? {
                    db::set_period_verified_scope(conn, artist_id, Some(platform), year, month)?;
                }
            }
        }
    }
    Ok(())
}

/// Startup check: a checkmark must always have a valid signature.
/// Templates saved as verified without one lose it and the artists' flags are
/// recalculated. Runs on every start (cheap).
pub fn reverify_applied(conn: &Connection) -> rusqlite::Result<()> {
    let rows: Vec<(i64, i64, Option<String>)> = conn
        .prepare("SELECT id, artist_id, raw FROM applied_templates WHERE verified = 1")?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
        .collect::<rusqlite::Result<_>>()?;

    let mut dirty: HashSet<i64> = HashSet::new();
    for (id, artist_id, raw) in rows {
        // parse() removes verified from unsigned files, so "still verified" = validly
        // signed
        let ok = raw
            .as_deref()
            .and_then(|r| parse(r).ok())
            .map(|t| grants_verified(&t))
            .unwrap_or(false);
        if !ok {
            conn.execute(
                "UPDATE applied_templates SET verified = 0 WHERE id = ?1",
                params![id],
            )?;
            dirty.insert(artist_id);
        }
    }

    for artist_id in dirty {
        db::clear_artist_verified(conn, artist_id)?;
        let mut any = false;
        for at in db::applied_templates(conn, artist_id)? {
            if let Some(raw) = &at.raw {
                if let Ok(t) = parse(raw) {
                    if grants_verified(&t) {
                        any = true;
                        apply_verified(conn, artist_id, &t)?;
                    }
                }
            }
        }
        if !any {
            conn.execute(
                "UPDATE artists SET template_verified = 0 WHERE id = ?1",
                params![artist_id],
            )?;
        }
    }
    Ok(())
}

/* ---- apply ----------------------------------------------------------- */

/// Apply a template. Several templates can target the same artist, but if this one
/// overlaps another applied one it's rejected and nothing changes.
/// With create_folders the empty folders are created under base/<artist>.
pub fn apply_template(
    conn: &Connection,
    t: &TemplateFile,
    raw: &str,
    create_folders: bool,
    base: Option<&Path>,
) -> Result<Option<PathBuf>, String> {
    let dberr = |e: rusqlite::Error| e.to_string();
    let name = t.artist.name.trim();
    let label = template_label(t);
    let artist_id = indexer::upsert_artist(conn, name).map_err(dberr)?;

    // ---- overlap check against the artist's other templates
    let new_cov = coverage(t);
    let existing = db::applied_templates(conn, artist_id).map_err(dberr)?;
    for ex in &existing {
        if ex.name == label {
            continue; // re-applying the same template replaces it (not a clash).
        }
        let ex_cov: Vec<CoverKey> = serde_json::from_str(&ex.coverage).unwrap_or_default();
        if let Some(scope) = first_conflict(&new_cov, &ex_cov) {
            return Err(format!(
                "Couldn’t apply “{label}”: it overlaps the template “{}” on {scope}. \
                 Remove or narrow one of them so they don’t cover the same period.",
                ex.name
            ));
        }
    }

    apply_inner(conn, t, raw, &label, &new_cov, create_folders, base, artist_id).map_err(dberr)
}

#[allow(clippy::too_many_arguments)]
fn apply_inner(
    conn: &Connection,
    t: &TemplateFile,
    raw: &str,
    label: &str,
    new_cov: &[CoverKey],
    create_folders: bool,
    base: Option<&Path>,
    artist_id: i64,
) -> rusqlite::Result<Option<PathBuf>> {
    let name = t.artist.name.trim();
    let source = t
        .meta
        .as_ref()
        .and_then(|m| m.version.clone())
        .map(|v| format!("v{v}"))
        .unwrap_or_else(|| "template".into());
    db::set_artist_template(conn, artist_id, Some(&source), Some(raw), grants_verified(t))?;

    if let Some(kind) = t.artist.kind.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        db::set_artist_kind(conn, artist_id, Some(kind))?;
    }

    merge_links(conn, artist_id, t)?;

    let artist_base = base.map(|b| b.join(crate::sanitize_name(name)));

    for plat in &t.platforms {
        let platform = plat.name.trim();
        // named periods need the platform's style, or a rescan would drop the names
        let custom = plat.periods.iter().any(|p| p.names().is_some());
        if custom {
            db::set_platform_release_style(conn, artist_id, platform, "custom")?;
        }
        for per in &plat.periods {
            let (year, month) = per
                .numbers(conn, artist_id, Some(platform), true)?
                .unwrap_or((per.year, per.month));
            let label_str = match (year, month) {
                (Some(y), m) => db::custom_label(conn, artist_id, Some(platform), y, m)?
                    .unwrap_or_else(|| indexer::fmt_label(y, m)),
                (None, _) => "Misc".to_string(),
            };
            // no drop numbers in templates
            let key = indexer::period_key(name, Some(platform), year, month, None);
            let period_id = indexer::upsert_period(
                conn,
                artist_id,
                Some(platform),
                year,
                month,
                None,
                &label_str,
                &key,
                false,
            )?;
            db::set_period_official_total(conn, period_id, per.total())?;
            if per.span_months() > 1 {
                db::set_period_span(conn, period_id, per.span_months())?;
            }

            // this period's folder on disk (if creating folders)
            let period_dir = artist_base.as_ref().map(|ab| {
                let mut p = ab.join(crate::sanitize_name(platform));
                if let Some(y) = year {
                    let named = |m: i64| {
                        let name = db::custom_name(conn, artist_id, Some(platform), y, m).ok().flatten();
                        name.filter(|_| custom).map(|n| crate::organize::sanitize(&n))
                    };
                    p = p.join(named(0).unwrap_or_else(|| y.to_string()));
                    if let Some(m) = month {
                        p = p.join(named(m).unwrap_or_else(|| format!("{:02}", m)));
                    }
                }
                p
            });

            // inline month cover -> write it into the folder and set it as preview
            if let Some(cover) = per.cover.as_deref() {
                if let (Some(pd), Some((bytes, ext))) = (&period_dir, decode_cover(cover)) {
                    let _ = std::fs::create_dir_all(pd);
                    let file = pd.join(format!("_cover.{ext}"));
                    if std::fs::write(&file, &bytes).is_ok() {
                        db::set_period_preview(conn, period_id, &file.to_string_lossy())?;
                    }
                }
            }

            // a break: flag it, write a marker file, no rewards
            if per.skipped {
                db::set_period_skipped(conn, period_id, true)?;
                if create_folders {
                    if let Some(pd) = &period_dir {
                        let _ = std::fs::create_dir_all(pd);
                        let _ = std::fs::write(
                            pd.join(db::SKIP_MARKER),
                            "This month was skipped by the artist (a break — no release).\n",
                        );
                    }
                }
                continue;
            }

            // skip rewards that already exist
            let existing: HashSet<String> = db::period_rewards(conn, period_id)?
                .iter()
                .map(|(_, title, _, _)| indexer::norm_title(title))
                .collect();

            for rw in &per.rewards {
                let title = rw.title.trim();
                if title.is_empty() || existing.contains(&indexer::norm_title(title)) {
                    continue;
                }
                let folder_path = match (create_folders, &period_dir) {
                    (true, Some(pd)) => {
                        let dir = pd.join(crate::sanitize_name(title));
                        let _ = std::fs::create_dir_all(&dir);
                        dir.to_string_lossy().to_string()
                    }
                    // no real folder, a fake key that can't clash with real paths
                    _ => format!("{key}\u{1}{}", indexer::norm_title(title)),
                };
                db::insert_missing_reward(conn, period_id, title, rw.category.as_deref(), &folder_path)?;
            }
        }
    }

    // save the template, then recompute the artist's verified flags from all its templates
    let cov_json = serde_json::to_string(new_cov).unwrap_or_else(|_| "[]".into());
    db::upsert_applied_template(conn, artist_id, label, grants_verified(t), &cov_json, Some(raw))?;

    db::clear_artist_verified(conn, artist_id)?;
    for at in db::applied_templates(conn, artist_id)? {
        if let Some(raw) = &at.raw {
            if let Ok(tt) = parse(raw) {
                apply_verified(conn, artist_id, &tt)?;
            }
        }
    }

    if create_folders {
        if let Some(ab) = &artist_base {
            let _ = std::fs::create_dir_all(ab);
        }
        Ok(artist_base)
    } else {
        Ok(None)
    }
}

/// merge the template links into the artist's links (no duplicate URLs, existing ones win)
fn merge_links(conn: &Connection, artist_id: i64, t: &TemplateFile) -> rusqlite::Result<()> {
    let mut links: Vec<TemplateLink> = db::artist_links(conn, artist_id)?
        .and_then(|s| serde_json::from_str::<Vec<TemplateLink>>(&s).ok())
        .unwrap_or_default();

    let mut seen: HashSet<String> = links.iter().map(|l| norm_url(&l.url)).collect();

    let mut add = |label: &str, url: &str| {
        let u = url.trim();
        if u.is_empty() {
            return;
        }
        let key = norm_url(u);
        if seen.insert(key) {
            links.push(TemplateLink {
                label: label.trim().to_string(),
                url: u.to_string(),
            });
        }
    };

    for l in &t.artist.links {
        add(&l.label, &l.url);
    }
    for p in &t.platforms {
        if let Some(u) = &p.url {
            add(&p.name, u);
        }
    }

    if let Ok(json) = serde_json::to_string(&links) {
        db::set_artist_links(conn, artist_id, &json)?;
    }
    Ok(())
}

fn norm_url(u: &str) -> String {
    u.trim().trim_end_matches('/').to_ascii_lowercase()
}

/* ---- tests ----------------------------------------------------------- */

#[cfg(test)]
mod tests {
    use super::*;

    fn tf(json: &str) -> TemplateFile {
        parse(json).unwrap()
    }

    #[test]
    fn span_expands_into_each_month() {
        let t = tf(r#"{"micollTemplate":1,"artist":{"name":"A"},
            "platforms":[{"name":"Patreon","periods":[{"year":2025,"month":11,"span":3,"count":1}]}]}"#);
        let cov = coverage(&t);
        // Nov 2025, Dec 2025, Jan 2026 (year roll-over)
        assert_eq!(cov.len(), 3);
        assert!(cov.iter().any(|c| c.year == Some(2025) && c.month == Some(11)));
        assert!(cov.iter().any(|c| c.year == Some(2025) && c.month == Some(12)));
        assert!(cov.iter().any(|c| c.year == Some(2026) && c.month == Some(1)));
    }

    #[test]
    fn overlap_rules() {
        let mar = coverage(&tf(r#"{"micollTemplate":1,"artist":{"name":"A"},
            "platforms":[{"name":"Patreon","periods":[{"year":2025,"month":3,"count":1}]}]}"#));
        // same platform + month -> conflict
        assert!(first_conflict(&mar, &mar).is_some());
        // other platform -> no conflict
        let fansly = coverage(&tf(r#"{"micollTemplate":1,"artist":{"name":"A"},
            "platforms":[{"name":"Fansly","periods":[{"year":2025,"month":3,"count":1}]}]}"#));
        assert!(first_conflict(&mar, &fansly).is_none());
        // other year -> no conflict
        let prev = coverage(&tf(r#"{"micollTemplate":1,"artist":{"name":"A"},
            "platforms":[{"name":"Patreon","periods":[{"year":2024,"month":3,"count":1}]}]}"#));
        assert!(first_conflict(&mar, &prev).is_none());
        // whole year collides with any month of that year
        let year = coverage(&tf(r#"{"micollTemplate":1,"artist":{"name":"A"},
            "platforms":[{"name":"Patreon","periods":[{"year":2025,"count":5}]}]}"#));
        assert!(first_conflict(&mar, &year).is_some());
    }

    #[test]
    fn unsigned_verified_is_stripped() {
        // a plain file can claim verified, but without a signature it's dropped
        let t = tf(r#"{"micollTemplate":1,"artist":{"name":"A"},"verified":true,
            "platforms":[{"name":"Patreon","verified":true,
                "periods":[{"year":2025,"month":3,"verified":true,"count":1}]}]}"#);
        assert!(!t.verified);
        assert!(!t.platforms[0].verified);
        assert!(!t.platforms[0].periods[0].verified);
    }

    #[test]
    fn signed_envelope_grants_verified() {
        use ed25519_dalek::{Signer, SigningKey};
        let sk = SigningKey::from_bytes(&[3u8; 32]);
        let keys = [(1u32, sk.verifying_key().to_bytes())];
        let inner = r#"{"micollTemplate":1,"artist":{"name":"A"},"verified":true}"#;
        let env = serde_json::json!({
            "micollSigned": 1,
            "keyId": 1,
            "payload": STANDARD.encode(inner.as_bytes()),
            "sig": STANDARD.encode(sk.sign(inner.as_bytes()).to_bytes()),
        })
        .to_string();
        let t = parse_with_keys(&env, &keys).unwrap();
        assert!(t.verified);
        // same file with another build's key -> error (not a silent downgrade)
        let other = SigningKey::from_bytes(&[4u8; 32]);
        let wrong = [(1u32, other.verifying_key().to_bytes())];
        assert!(parse_with_keys(&env, &wrong).is_err());
    }

    #[test]
    fn reverify_downgrades_unsigned_legacy_rows() {
        let base = std::env::temp_dir().join(format!("micoll_reverify_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        let conn = db::open(&base.join("t.db")).unwrap();

        conn.execute("INSERT INTO artists(name, template_verified) VALUES('A', 1)", [])
            .unwrap();
        let aid: i64 = conn
            .query_row("SELECT id FROM artists WHERE name='A'", [], |r| r.get(0))
            .unwrap();
        conn.execute(
            "INSERT INTO periods(artist_id, platform, year, month, label, folder_path, verified)
             VALUES(?1, 'Patreon', 2025, 3, '2025-03', 'x', 1)",
            params![aid],
        )
        .unwrap();
        // an old "verified" template without signature
        let raw = r#"{"micollTemplate":1,"artist":{"name":"A"},"verified":true,
            "platforms":[{"name":"Patreon","periods":[{"year":2025,"month":3,"count":1}]}]}"#;
        conn.execute(
            "INSERT INTO applied_templates(artist_id, name, verified, coverage, raw)
             VALUES(?1, 'A', 1, '[]', ?2)",
            params![aid, raw],
        )
        .unwrap();

        reverify_applied(&conn).unwrap();

        let at_v: i64 = conn
            .query_row("SELECT verified FROM applied_templates WHERE artist_id=?1", params![aid], |r| r.get(0))
            .unwrap();
        let tv: i64 = conn
            .query_row("SELECT template_verified FROM artists WHERE id=?1", params![aid], |r| r.get(0))
            .unwrap();
        let pv: i64 = conn
            .query_row("SELECT verified FROM periods WHERE artist_id=?1", params![aid], |r| r.get(0))
            .unwrap();
        assert_eq!((at_v, tv, pv), (0, 0, 0), "unsigned legacy checkmarks must drop");

        // running again changes nothing
        reverify_applied(&conn).unwrap();
        let _ = std::fs::remove_dir_all(&base);
    }

    /// a template with custom names makes the same periods and folders as a custom import
    #[test]
    fn custom_template_applies_its_names() {
        let base = std::env::temp_dir().join(format!("micoll_tpl_custom_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        let conn = db::open(&base.join("t.db")).unwrap();
        let t = tf(r#"{"micollTemplate":1,"artist":{"name":"Nora"},"platforms":[{"name":"Patreon","periods":[
            {"yearName":"Sommer","monthName":"Teil 1","rewards":[{"title":"Set"}]},
            {"yearName":"Sommer","monthName":"Pause","skipped":true},
            {"yearName":"Winter","count":2}
        ]}]}"#);
        check_no_duplicate_periods(&t).unwrap();
        let id = indexer::upsert_artist(&conn, "Nora").unwrap();
        let cov = coverage(&t);
        apply_inner(&conn, &t, "{}", "Nora", &cov, true, Some(&base), id).unwrap();

        assert_eq!(db::custom_artist(&conn, "Nora", Some("Patreon")).unwrap(), Some(id));
        let y = db::custom_year_known(&conn, id, Some("Patreon"), "sommer").unwrap().unwrap();
        let m = db::custom_month_known(&conn, id, Some("Patreon"), y, "TEIL 1").unwrap().unwrap();
        assert!(y < 1000 && m > 12);
        let label: String = conn
            .query_row("SELECT label FROM periods WHERE year = ?1 AND month = ?2", [y, m], |r| r.get(0))
            .unwrap();
        assert_eq!(label, "Teil 1");
        let dir = base.join("Nora/Patreon/Sommer");
        assert!(dir.join("Teil 1/Set").is_dir());
        assert!(dir.join("Pause").join(db::SKIP_MARKER).is_file());

        // the same names collide, other ones don't, and the cells find their numbers again
        let again = tf(r#"{"micollTemplate":1,"artist":{"name":"Nora"},"platforms":[{"name":"Patreon",
            "periods":[{"yearName":"SOMMER","monthName":"teil 1"}]}]}"#);
        let other = tf(r#"{"micollTemplate":1,"artist":{"name":"Nora"},"platforms":[{"name":"Patreon",
            "periods":[{"yearName":"Sommer","monthName":"Teil 2"}]}]}"#);
        let whole = tf(r#"{"micollTemplate":1,"artist":{"name":"Nora"},"platforms":[{"name":"Patreon",
            "periods":[{"yearName":"Sommer"}]}]}"#);
        assert!(first_conflict(&coverage(&again), &cov).is_some());
        assert!(first_conflict(&coverage(&other), &cov).is_none());
        assert!(first_conflict(&coverage(&whole), &cov).is_some());
        assert_eq!(cov[0].numbers(&conn, id).unwrap(), Some((Some(y), Some(m))));
        assert_eq!(coverage(&other)[0].numbers(&conn, id).unwrap(), None);

        // a real date in the name fields stays a date, with its span
        let dated = tf(r#"{"micollTemplate":1,"artist":{"name":"Nora"},"platforms":[{"name":"Patreon",
            "periods":[{"yearName":"2025","monthName":"03","span":2}]}]}"#);
        let cells = coverage(&dated);
        assert_eq!(cells.len(), 2);
        assert_eq!((cells[1].year, cells[1].month), (Some(2025), Some(4)));

        // a double in names is caught like a double month
        let dup = tf(r#"{"micollTemplate":1,"artist":{"name":"Nora"},"platforms":[{"name":"Patreon","periods":[
            {"yearName":"A","monthName":"B"},{"yearName":"a","monthName":"b"}]}]}"#);
        assert!(check_no_duplicate_periods(&dup).is_err());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn skipped_period_has_zero_total() {
        let t = tf(r#"{"micollTemplate":1,"artist":{"name":"A"},
            "platforms":[{"name":"Patreon","periods":[{"year":2025,"month":7,"skipped":true,"count":4}]}]}"#);
        assert_eq!(t.platforms[0].periods[0].total(), 0);
    }
}
