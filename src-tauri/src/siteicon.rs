//! Icons for creator links to sites MiColl ships no logo for (src/lib/linkIcons.ts has
//! the known platforms). Fetched once from the site itself, never through a third party,
//! so nobody else learns which sites the links go to. Kept in the database (table
//! site_icons), so they show offline too.

use std::io::Read;
use std::time::Duration;

use base64::{engine::general_purpose::STANDARD, Engine as _};
use rusqlite::{params, Connection, OptionalExtension};

/// Bigger isn't a favicon.
const MAX_ICON: u64 = 256 * 1024;
/// Enough for the <head> of any page.
const MAX_PAGE: u64 = 512 * 1024;
/// A site without an icon is asked again after two weeks.
const RETRY_SECS: i64 = 14 * 86_400;
const TIMEOUT: Duration = Duration::from_secs(8);

/// A plain domain name ("example.com", "art.example.co.uk"): no IP, port, path or localhost.
pub fn valid_host(host: &str) -> bool {
    let labels: Vec<&str> = host.split('.').collect();
    host.len() <= 253
        && labels.len() >= 2
        && labels.iter().all(|l| {
            !l.is_empty()
                && l.len() <= 63
                && !l.starts_with('-')
                && !l.ends_with('-')
                && l.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        })
        // the last label of a domain is never all digits (that's an IP)
        && !labels.last().is_some_and(|l| l.bytes().all(|b| b.is_ascii_digit()))
        && !host.ends_with(".localhost")
}

fn data_url(mime: &str, bytes: &[u8]) -> String {
    format!("data:{mime};base64,{}", STANDARD.encode(bytes))
}

/// What's saved for `host`: Some(Some(icon)), Some(None) = has none (asked lately),
/// None = never asked or time to ask again.
pub fn cached(conn: &Connection, host: &str, now: i64) -> Option<Option<String>> {
    let row: Option<(Option<String>, Option<Vec<u8>>, i64)> = conn
        .query_row(
            "SELECT mime, data, fetched_at FROM site_icons WHERE host = ?1",
            [host],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()
        .ok()
        .flatten();
    match row? {
        (Some(mime), Some(data), _) => Some(Some(data_url(&mime, &data))),
        (_, _, at) if now - at < RETRY_SECS => Some(None),
        _ => None,
    }
}

/// Save what the site gave (None = it has no icon).
pub fn store(conn: &Connection, host: &str, icon: Option<&(String, Vec<u8>)>, now: i64) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO site_icons (host, mime, data, fetched_at) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(host) DO UPDATE SET mime = excluded.mime, data = excluded.data, fetched_at = excluded.fetched_at",
        params![host, icon.map(|i| i.0.as_str()), icon.map(|i| i.1.as_slice()), now],
    )?;
    Ok(())
}

/// The icon's type from its first bytes (not from what the server says).
fn sniff(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if bytes.starts_with(&[0, 0, 1, 0]) {
        Some("image/x-icon")
    } else if bytes.starts_with(b"GIF8") {
        Some("image/gif")
    } else if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        Some("image/jpeg")
    } else if bytes.len() > 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some("image/webp")
    } else {
        // shown in an <img>, where an SVG's scripts never run
        let head = String::from_utf8_lossy(&bytes[..bytes.len().min(1024)]).to_lowercase();
        head.contains("<svg").then_some("image/svg+xml")
    }
}

/// The value of attribute `name` in one tag's text (lowercase names, any quotes).
fn attr(tag: &str, name: &str) -> Option<String> {
    // ASCII only, so the byte positions stay the same as in `tag`
    let lower = tag.to_ascii_lowercase();
    let mut from = 0;
    while let Some(i) = lower[from..].find(name) {
        let at = from + i;
        from = at + name.len();
        // a whole attribute name ("rel", not "data-rel")
        let before = lower[..at].chars().next_back();
        if !before.is_some_and(char::is_whitespace) {
            continue;
        }
        let rest = lower[from..].trim_start();
        let Some(rest) = rest.strip_prefix('=') else { continue };
        let rest = rest.trim_start();
        let start = tag.len() - rest.len();
        let value = match rest.chars().next() {
            Some(q @ ('"' | '\'')) => {
                let end = rest[1..].find(q).map(|e| e + 1)?;
                &tag[start + 1..start + end]
            }
            _ => {
                let end = rest.find(|c: char| c.is_whitespace() || c == '>').unwrap_or(rest.len());
                &tag[start..start + end]
            }
        };
        return Some(value.replace("&amp;", "&"));
    }
    None
}

/// The icons a page names in its <link> tags, best first: SVG and big PNGs, then the
/// apple-touch-icon, then the rest.
fn page_icons(html: &str) -> Vec<String> {
    let lower = html.to_ascii_lowercase();
    let mut found: Vec<(u32, String)> = Vec::new();
    let mut from = 0;
    while let Some(i) = lower[from..].find("<link") {
        let start = from + i;
        let end = lower[start..].find('>').map_or(lower.len(), |e| start + e);
        from = end;
        let tag = &html[start..end];
        let rel = attr(tag, "rel").unwrap_or_default().to_ascii_lowercase();
        let rels: Vec<&str> = rel.split_whitespace().collect();
        if !rels.iter().any(|r| *r == "icon" || *r == "apple-touch-icon") {
            continue;
        }
        let Some(href) = attr(tag, "href").filter(|h| !h.trim().is_empty()) else { continue };
        let kind = attr(tag, "type").unwrap_or_default().to_lowercase();
        let sizes = attr(tag, "sizes").unwrap_or_default();
        let size: u32 = sizes.split(['x', 'X']).next().and_then(|n| n.trim().parse().ok()).unwrap_or(0);
        let rank = if kind.contains("svg") || href.to_lowercase().ends_with(".svg") {
            0
        } else if size >= 32 && rels.contains(&"icon") {
            1
        } else if rels.contains(&"apple-touch-icon") {
            2
        } else {
            3
        };
        found.push((rank, href.trim().to_string()));
    }
    found.sort_by_key(|f| f.0);
    found.into_iter().map(|f| f.1).collect()
}

/// `href` as a full URL, read against the page it's on.
fn resolve(base: &str, href: &str) -> Option<String> {
    if href.starts_with("https://") || href.starts_with("http://") {
        return Some(href.to_string());
    }
    if let Some(rest) = href.strip_prefix("//") {
        return Some(format!("https://{rest}"));
    }
    let scheme_end = base.find("://")? + 3;
    let origin_end = base[scheme_end..].find('/').map_or(base.len(), |i| scheme_end + i);
    let origin = &base[..origin_end];
    if href.starts_with('/') {
        return Some(format!("{origin}{href}"));
    }
    // relative to the page's folder (without its query)
    let path = base[origin_end..].split(['?', '#']).next().unwrap_or("");
    let dir = path.rfind('/').map_or("/", |i| &path[..=i]);
    Some(format!("{origin}{dir}{href}"))
}

fn read_capped(resp: ureq::Response, cap: u64) -> Option<Vec<u8>> {
    let mut bytes = Vec::new();
    resp.into_reader().take(cap + 1).read_to_end(&mut bytes).ok()?;
    (bytes.len() as u64 <= cap).then_some(bytes)
}

/// One icon from a URL (or a data: URL in the page), if it really is an image.
fn icon_at(agent: &ureq::Agent, url: &str) -> Option<(String, Vec<u8>)> {
    let bytes = if let Some(data) = url.strip_prefix("data:") {
        let (_, b64) = data.split_once(";base64,")?;
        STANDARD.decode(b64.trim()).ok().filter(|b| b.len() as u64 <= MAX_ICON)?
    } else {
        read_capped(agent.get(url).call().ok()?, MAX_ICON)?
    };
    let mime = sniff(&bytes)?;
    Some((mime.to_string(), bytes))
}

/// The site's icon: from its home page's <link> tags, else /favicon.ico.
/// Err = the site couldn't be reached (offline?): not saved, asked again next time.
/// Ok(None) = the site is there but has no icon.
pub fn fetch(host: &str) -> Result<Option<(String, Vec<u8>)>, ()> {
    let agent = ureq::AgentBuilder::new()
        .timeout(TIMEOUT)
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) MiColl")
        .build();
    let home = format!("https://{host}/");
    let (base, html) = match agent.get(&home).call() {
        Ok(resp) => {
            let base = resp.get_url().to_string();
            let html = read_capped(resp, MAX_PAGE).map(|b| String::from_utf8_lossy(&b).into_owned());
            (base, html.unwrap_or_default())
        }
        // busy or down (429, 5xx): ask again next time
        Err(ureq::Error::Status(code, _)) if code == 429 || code >= 500 => return Err(()),
        // the site answered, just not with a page (404, 403 …)
        Err(ureq::Error::Status(..)) => (home.clone(), String::new()),
        Err(ureq::Error::Transport(_)) => return Err(()),
    };
    let mut tried = Vec::new();
    for href in page_icons(&html).into_iter().chain(["/favicon.ico".to_string()]) {
        let Some(url) = (if href.starts_with("data:") { Some(href) } else { resolve(&base, &href) }) else { continue };
        if tried.contains(&url) {
            continue;
        }
        if let Some(icon) = icon_at(&agent, &url) {
            return Ok(Some(icon));
        }
        tried.push(url);
        if tried.len() >= 4 {
            break;
        }
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_plain_domains_are_asked() {
        assert!(valid_host("example.com"));
        assert!(valid_host("art.example-shop.co.uk"));
        assert!(valid_host("xn--bcher-kva.de"));
        assert!(!valid_host("localhost"));
        assert!(!valid_host("app.localhost"));
        assert!(!valid_host("192.168.1.10"));
        assert!(!valid_host("example.com:8080"));
        assert!(!valid_host("example.com/x"));
        assert!(!valid_host("-bad.com"));
        assert!(!valid_host("Example.com"));
    }

    #[test]
    fn icons_are_found_in_the_page() {
        let html = r#"<html><head>
            <link rel="stylesheet" href="/a.css">
            <link data-rel="icon" href="/nope.png">
            <LINK REL="shortcut icon" HREF="/favicon-16.png" sizes="16x16">
            <link rel=apple-touch-icon href=/apple.png>
            <link rel="icon" type="image/png" sizes="32x32" href="/fav-32.png?v=2&amp;x=1">
            <link rel='icon' href='https://cdn.example.com/logo.svg'>
        </head></html>"#;
        assert_eq!(
            page_icons(html),
            ["https://cdn.example.com/logo.svg", "/fav-32.png?v=2&x=1", "/apple.png", "/favicon-16.png"]
        );
    }

    #[test]
    fn links_are_read_against_the_page() {
        let base = "https://www.example.com/shop/index.html?a=1";
        assert_eq!(resolve(base, "/f.ico").unwrap(), "https://www.example.com/f.ico");
        assert_eq!(resolve(base, "img/f.png").unwrap(), "https://www.example.com/shop/img/f.png");
        assert_eq!(resolve(base, "//cdn.x.com/f.png").unwrap(), "https://cdn.x.com/f.png");
        assert_eq!(resolve("https://example.com", "f.png").unwrap(), "https://example.com/f.png");
    }

    #[test]
    fn only_real_images_count() {
        assert_eq!(sniff(b"\x89PNG\r\n\x1a\nrest"), Some("image/png"));
        assert_eq!(sniff(&[0, 0, 1, 0, 1, 0]), Some("image/x-icon"));
        assert_eq!(sniff(b"<?xml version=\"1.0\"?><svg xmlns=\"x\"></svg>"), Some("image/svg+xml"));
        assert_eq!(sniff(b"<!doctype html><html>not found</html>"), None);
    }

    #[test]
    fn icons_are_kept_and_missing_ones_asked_again_later() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE site_icons (host TEXT PRIMARY KEY, mime TEXT, data BLOB, fetched_at INTEGER NOT NULL)",
        )
        .unwrap();
        assert_eq!(cached(&conn, "a.com", 1000), None);
        store(&conn, "a.com", Some(&("image/png".into(), vec![1, 2, 3])), 1000).unwrap();
        assert_eq!(cached(&conn, "a.com", 1000 + RETRY_SECS * 10), Some(Some("data:image/png;base64,AQID".into())));
        store(&conn, "b.com", None, 1000).unwrap();
        assert_eq!(cached(&conn, "b.com", 2000), Some(None));
        assert_eq!(cached(&conn, "b.com", 1000 + RETRY_SECS), None);
    }
}
