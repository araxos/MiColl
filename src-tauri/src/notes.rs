//! The user's own notes (the Notes page). Nothing of them is a file the Explorer shows:
//! they're rows in MiColl's database, every one sealed (XChaCha20-Poly1305).
//!
//! - A normal note is sealed with the notes key. That key is kept by Windows for this
//!   user (DPAPI), and also sealed with MiColl's data key (while encryption is on) and with
//!   the vault key (once there is a password): a backup moved to another PC opens with
//!   one of those.
//! - A note behind the notes password is sealed with the vault key, which only exists
//!   sealed with a key made from the password (Argon2id, 64 MB, 3 passes) and, if the
//!   user wants one, from a recovery code. The password is never stored. While the vault
//!   is locked MiColl doesn't know these notes' titles either; they aren't listed at all.
//! - The vault key is in memory only while it's unlocked, and wiped when it locks (after
//!   some minutes without use, when MiColl locks or ends).
//! - A deleted note waits in the trash for 30 days.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use zeroize::{Zeroize, Zeroizing};

use crate::{crypto, db};

type Key = Zeroizing<[u8; 32]>;

const KEY_DPAPI: &str = "notes_key_dpapi";
const KEY_DEK: &str = "notes_key_dek";
const KEY_VAULT: &str = "notes_key_vault";
const VAULT: &str = "notes_vault";
const AUTOLOCK: &str = "notes_autolock_min";
const AUTOLOCK_DEFAULT: u64 = 10;
/// A deleted note is gone for good after this long.
const TRASH_DAYS: i64 = 30;
/// Biggest note (bytes of title + text).
const MAX_NOTE: usize = 2 * 1024 * 1024;
/// The shortest notes password (the user's choice: a short PIN is fine, the stretching
/// makes every try slow).
const MIN_PASSWORD: usize = 4;
/// Wrong passwords in a row before it waits.
const TRIES: u32 = 5;
const WAIT: Duration = Duration::from_secs(30);

/// The table as db.rs makes it (for the tests).
#[cfg(test)]
pub fn ensure_table(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS notes (
            id         INTEGER PRIMARY KEY,
            -- 1 = behind the notes password
            locked     INTEGER NOT NULL DEFAULT 0,
            -- sealed JSON: title, text, times, pinned
            data       BLOB NOT NULL,
            -- unix seconds, in the trash since then
            deleted_at INTEGER
        );",
    )
}

fn now() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs() as i64)
}

fn rand_key() -> Key {
    let mut k = Zeroizing::new([0u8; 32]);
    rand::RngCore::fill_bytes(&mut rand::rngs::OsRng, &mut *k);
    k
}

fn seal(key: &Key, data: &[u8]) -> Vec<u8> {
    crypto::Dek::from_bytes(**key).encrypt_bytes(data)
}

fn open(key: &Key, blob: &[u8]) -> Result<Zeroizing<Vec<u8>>, String> {
    crypto::Dek::from_bytes(**key).decrypt_bytes(blob).map(Zeroizing::new)
}

fn open_key(key: &Key, blob: &[u8]) -> Option<Key> {
    let raw = open(key, blob).ok()?;
    let mut k = Zeroizing::new([0u8; 32]);
    (raw.len() == 32).then(|| k.copy_from_slice(&raw))?;
    Some(k)
}

fn setting(conn: &Connection, key: &str) -> Option<String> {
    db::get_setting(conn, key).ok().flatten().filter(|s| !s.is_empty())
}

fn setting_blob(conn: &Connection, key: &str) -> Option<Vec<u8>> {
    B64.decode(setting(conn, key)?).ok()
}

fn set_blob(conn: &Connection, key: &str, blob: &[u8]) -> Result<(), String> {
    db::set_setting(conn, key, &B64.encode(blob)).map_err(|e| e.to_string())
}

/* ---- Windows keeps the notes key (DPAPI) --------------------------------- */

/// Seals with a key of the Windows user, and opens again (on the same account only).
pub struct Keeper {
    pub keep: fn(&[u8]) -> Option<Vec<u8>>,
    pub give: fn(&[u8]) -> Option<Vec<u8>>,
}

#[cfg(windows)]
mod dpapi {
    use windows::Win32::Foundation::{LocalFree, HLOCAL};
    use windows::Win32::Security::Cryptography::{
        CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };

    /// Only MiColl's notes key opens with it (another program of the user can't just ask).
    const ENTROPY: &[u8] = b"MiColl notes key v1";

    fn blob(b: &[u8]) -> CRYPT_INTEGER_BLOB {
        CRYPT_INTEGER_BLOB { cbData: b.len() as u32, pbData: b.as_ptr() as *mut u8 }
    }

    fn take(out: CRYPT_INTEGER_BLOB) -> Vec<u8> {
        // SAFETY: Windows allocated cbData bytes at pbData, freed right after the copy
        unsafe {
            let v = std::slice::from_raw_parts(out.pbData, out.cbData as usize).to_vec();
            let _ = LocalFree(Some(HLOCAL(out.pbData as _)));
            v
        }
    }

    pub fn keep(data: &[u8]) -> Option<Vec<u8>> {
        let mut out = CRYPT_INTEGER_BLOB::default();
        let extra = blob(ENTROPY);
        // SAFETY: the blobs point at live slices for the call
        unsafe {
            CryptProtectData(&blob(data), None, Some(&extra), None, None, CRYPTPROTECT_UI_FORBIDDEN, &mut out).ok()?;
        }
        Some(take(out))
    }

    pub fn give(data: &[u8]) -> Option<Vec<u8>> {
        let mut out = CRYPT_INTEGER_BLOB::default();
        let extra = blob(ENTROPY);
        // SAFETY: as above
        unsafe {
            CryptUnprotectData(&blob(data), None, Some(&extra), None, None, CRYPTPROTECT_UI_FORBIDDEN, &mut out).ok()?;
        }
        Some(take(out))
    }
}

#[cfg(windows)]
pub const WINDOWS: Keeper = Keeper { keep: dpapi::keep, give: dpapi::give };
#[cfg(not(windows))]
pub const WINDOWS: Keeper = Keeper { keep: |_| None, give: |_| None };

/* ---- the vault ------------------------------------------------------------ */

/// Argon2id's cost, stored with the vault (a later MiColl may make it dearer).
#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Debug)]
pub struct Cost {
    /// KiB
    pub m: u32,
    pub t: u32,
    pub p: u32,
}

/// What it costs to try one password: about half a second and 64 MB.
pub const STRONG: Cost = Cost { m: 64 * 1024, t: 3, p: 4 };

#[derive(Serialize, Deserialize, Clone)]
struct Vault {
    v: u32,
    cost: Cost,
    salt: String,
    /// the vault key sealed with the password's key
    key: String,
    /// the same with the recovery code's
    #[serde(default)]
    rsalt: Option<String>,
    #[serde(default)]
    rkey: Option<String>,
}

fn stretch(secret: &str, salt: &[u8], cost: Cost) -> Result<Key, String> {
    use argon2::{Algorithm, Argon2, Params, Version};
    let params = Params::new(cost.m, cost.t, cost.p, Some(32)).map_err(|e| e.to_string())?;
    let mut out = Zeroizing::new([0u8; 32]);
    Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
        .hash_password_into(secret.as_bytes(), salt, &mut *out)
        .map_err(|e| e.to_string())?;
    Ok(out)
}

/// 25 letters and digits (125 bits) in groups of five, nothing that looks alike.
fn new_recovery_code() -> String {
    const ABC: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let mut raw = Zeroizing::new([0u8; 25]);
    rand::RngCore::fill_bytes(&mut rand::rngs::OsRng, &mut *raw);
    let chars: Vec<char> = raw.iter().map(|b| ABC[(*b & 31) as usize] as char).collect();
    chars.chunks(5).map(|c| c.iter().collect::<String>()).collect::<Vec<_>>().join("-")
}

/// As typed: any case, spaces and dashes don't matter, 0/1 read as O/I.
fn clean_code(code: &str) -> Zeroizing<String> {
    Zeroizing::new(
        code.chars()
            .filter(|c| c.is_ascii_alphanumeric())
            .map(|c| match c.to_ascii_uppercase() {
                '0' => 'O',
                '1' => 'I',
                c => c,
            })
            .collect(),
    )
}

fn load_vault(conn: &Connection) -> Option<Vault> {
    serde_json::from_str(&setting(conn, VAULT)?).ok()
}

fn save_vault(conn: &Connection, v: &Vault) -> Result<(), String> {
    db::set_setting(conn, VAULT, &serde_json::to_string(v).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
}

fn unseal_vault(v: &Vault, secret: &str, recovery: bool) -> Option<Key> {
    let (salt, key) = if recovery { (v.rsalt.as_ref()?, v.rkey.as_ref()?) } else { (&v.salt, &v.key) };
    let kek = stretch(secret, &B64.decode(salt).ok()?, v.cost).ok()?;
    open_key(&kek, &B64.decode(key).ok()?)
}

/// The vault key sealed with a new secret: (salt, sealed key).
fn seal_vault_key(vk: &Key, secret: &str, cost: Cost) -> Result<(String, String), String> {
    let salt = crypto::gen_salt();
    let kek = stretch(secret, &salt, cost)?;
    Ok((B64.encode(&salt), B64.encode(seal(&kek, &**vk))))
}

/* ---- what's in memory ------------------------------------------------------ */

#[derive(Default)]
struct Open {
    /// the notes key (normal notes)
    nk: Option<Key>,
    /// the vault key, while unlocked
    vk: Option<Key>,
    /// last used, for locking after a while
    used: Option<Instant>,
    /// unlocked with the recovery code: a new password may be set without the old one
    by_recovery: bool,
    /// wrong passwords in a row, and since when it waits
    misses: u32,
    wait_from: Option<Instant>,
}

#[derive(Default)]
pub struct NotesState(Mutex<Open>);

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    /// a notes password is set
    pub vault: bool,
    pub unlocked: bool,
    pub recovery: bool,
    /// normal notes can't be opened on this PC right now (moved here: unlock MiColl or the
    /// notes first)
    pub normal_closed: bool,
    pub autolock_min: u64,
    /// unlocked with the recovery code: a new password should be set now
    pub by_recovery: bool,
}

#[derive(Serialize, Deserialize, Default, Clone)]
struct Body {
    #[serde(rename = "t")]
    title: String,
    #[serde(rename = "b")]
    text: String,
    #[serde(rename = "c")]
    created: i64,
    #[serde(rename = "u")]
    updated: i64,
    #[serde(rename = "p", default)]
    pinned: bool,
    /// the text with its formatting (the editor's document, JSON); `text` is its plain
    /// words, for the search. None: a note from before, plain text.
    #[serde(rename = "r", default, skip_serializing_if = "Option::is_none")]
    rich: Option<String>,
    /// read-only: its title and text can't be changed until it's turned off
    #[serde(rename = "w", default)]
    readonly: bool,
}

impl Drop for Body {
    fn drop(&mut self) {
        self.title.zeroize();
        self.text.zeroize();
        if let Some(r) = &mut self.rich {
            r.zeroize();
        }
    }
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct NoteItem {
    pub id: i64,
    pub title: String,
    /// the text around what was searched for, else its start
    pub snippet: String,
    pub locked: bool,
    pub pinned: bool,
    pub readonly: bool,
    pub created: i64,
    pub updated: i64,
    /// in the trash since then
    pub deleted: Option<i64>,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Note {
    pub id: i64,
    pub title: String,
    pub text: String,
    /// with its formatting (JSON), None for plain text
    pub rich: Option<String>,
    pub locked: bool,
    pub pinned: bool,
    pub readonly: bool,
    pub created: i64,
    pub updated: i64,
}

/// The notes with one connection: everything the commands do, testable without the app.
pub struct Notes<'a> {
    pub conn: &'a Connection,
    pub state: &'a NotesState,
    /// MiColl's data key, while encryption is on and unlocked
    pub dek: Option<[u8; 32]>,
    pub keeper: &'a Keeper,
}

impl Notes<'_> {
    fn open_state(&self) -> std::sync::MutexGuard<'_, Open> {
        self.state.0.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn autolock(&self) -> Duration {
        let min = setting(self.conn, AUTOLOCK).and_then(|s| s.parse().ok()).unwrap_or(AUTOLOCK_DEFAULT);
        Duration::from_secs(min * 60)
    }

    /// The vault locks when it wasn't used for a while (0 = only with MiColl).
    fn expire(&self, o: &mut Open) {
        let after = self.autolock();
        if o.vk.is_some() && !after.is_zero() && o.used.is_some_and(|u| u.elapsed() >= after) {
            o.vk = None;
            o.by_recovery = false;
        }
    }

    /// Used now: the vault stays open.
    fn touch(&self, o: &mut Open) {
        self.expire(o);
        if o.vk.is_some() {
            o.used = Some(Instant::now());
        }
    }

    /// The notes key: kept, or got back from MiColl's key or the vault's, or new when
    /// there's nothing yet. The other copies are written while it's at hand.
    fn notes_key(&self, o: &mut Open) -> Result<Key, String> {
        if o.nk.is_none() {
            let kept = setting_blob(self.conn, KEY_DPAPI).and_then(|b| (self.keeper.give)(&b)).and_then(|raw| {
                let raw = Zeroizing::new(raw);
                let mut k = Zeroizing::new([0u8; 32]);
                (raw.len() == 32).then(|| k.copy_from_slice(&raw))?;
                Some(k)
            });
            let dek = self.dek.map(Zeroizing::new);
            let found = kept
                .or_else(|| Some(open_key(dek.as_ref()?, &setting_blob(self.conn, KEY_DEK)?)).flatten())
                .or_else(|| Some(open_key(o.vk.as_ref()?, &setting_blob(self.conn, KEY_VAULT)?)).flatten());
            let nk = match found {
                Some(k) => {
                    // kept by this Windows user again (moved to another PC)
                    if let Some(b) = (self.keeper.keep)(&*k) {
                        set_blob(self.conn, KEY_DPAPI, &b)?;
                    }
                    k
                }
                None if self.any_normal()? || setting(self.conn, KEY_DPAPI).is_some() => {
                    return Err("closed".into());
                }
                None => {
                    let k = rand_key();
                    let b = (self.keeper.keep)(&*k).ok_or("Windows couldn't keep the notes key")?;
                    set_blob(self.conn, KEY_DPAPI, &b)?;
                    k
                }
            };
            o.nk = Some(nk);
        }
        let nk = o.nk.clone().ok_or("closed")?;
        if let Some(d) = self.dek.map(Zeroizing::new) {
            if setting_blob(self.conn, KEY_DEK).and_then(|b| open_key(&d, &b)).is_none() {
                set_blob(self.conn, KEY_DEK, &seal(&d, &*nk))?;
            }
        }
        if let Some(vk) = &o.vk {
            if setting_blob(self.conn, KEY_VAULT).and_then(|b| open_key(vk, &b)).is_none() {
                set_blob(self.conn, KEY_VAULT, &seal(vk, &*nk))?;
            }
        }
        Ok(nk)
    }

    fn any_normal(&self) -> Result<bool, String> {
        self.conn
            .query_row("SELECT EXISTS(SELECT 1 FROM notes WHERE locked = 0)", [], |r| r.get(0))
            .map_err(|e| e.to_string())
    }

    pub fn status(&self) -> Status {
        let mut o = self.open_state();
        self.expire(&mut o);
        let vault = load_vault(self.conn);
        let normal_closed = self.notes_key(&mut o).is_err();
        Status {
            vault: vault.is_some(),
            unlocked: o.vk.is_some(),
            recovery: vault.as_ref().is_some_and(|v| v.rkey.is_some()),
            normal_closed,
            autolock_min: self.autolock().as_secs() / 60,
            by_recovery: o.by_recovery,
        }
    }

    /// The key for a note: the notes key, or the vault key (Err while locked).
    fn key_for(&self, o: &mut Open, locked: bool) -> Result<Key, String> {
        if locked {
            o.vk.clone().ok_or_else(|| "The notes are locked.".to_string())
        } else {
            self.notes_key(o).map_err(|_| "These notes can't be opened on this PC yet. Unlock MiColl or your locked notes first.".to_string())
        }
    }

    fn purge_old(&self) -> Result<(), String> {
        self.conn
            .execute("DELETE FROM notes WHERE deleted_at IS NOT NULL AND deleted_at < ?1", [now() - TRASH_DAYS * 86400])
            .map(|_| ())
            .map_err(|e| e.to_string())
    }

    /// The notes that can be read now (locked ones only while unlocked), the ones in the
    /// trash or the rest. query: only those with it in their title or text.
    pub fn list(&self, query: &str, trash: bool) -> Result<Vec<NoteItem>, String> {
        self.purge_old()?;
        let mut o = self.open_state();
        self.touch(&mut o);
        let nk = self.notes_key(&mut o).ok();
        let vk = o.vk.clone();
        drop(o);
        let mut stmt = self
            .conn
            .prepare("SELECT id, locked, data, deleted_at FROM notes WHERE (deleted_at IS NOT NULL) = ?1")
            .map_err(|e| e.to_string())?;
        let rows: Vec<(i64, bool, Vec<u8>, Option<i64>)> = stmt
            .query_map([trash], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
            .map_err(|e| e.to_string())?
            .flatten()
            .collect();
        let want = query.trim().to_lowercase();
        let mut out = Vec::new();
        for (id, locked, data, deleted) in rows {
            let key = if locked { vk.as_ref() } else { nk.as_ref() };
            let Some(body) = key.and_then(|k| open(k, &data).ok()).and_then(|raw| serde_json::from_slice::<Body>(&raw).ok())
            else {
                continue;
            };
            let snippet = if want.is_empty() {
                snippet_at(&body.text, 0)
            } else if let Some(at) = find(&body.text, &want) {
                snippet_at(&body.text, at)
            } else if find(&body.title, &want).is_some() {
                snippet_at(&body.text, 0)
            } else {
                continue;
            };
            out.push(NoteItem {
                id,
                title: body.title.clone(),
                snippet,
                locked,
                pinned: body.pinned,
                readonly: body.readonly,
                created: body.created,
                updated: body.updated,
                deleted,
            });
        }
        out.sort_by(|a, b| b.pinned.cmp(&a.pinned).then(b.updated.cmp(&a.updated)).then(b.id.cmp(&a.id)));
        Ok(out)
    }

    fn row(&self, id: i64) -> Result<(bool, Vec<u8>), String> {
        self.conn
            .query_row("SELECT locked, data FROM notes WHERE id = ?1", [id], |r| Ok((r.get(0)?, r.get(1)?)))
            .optional()
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "This note is gone.".to_string())
    }

    fn body(&self, o: &mut Open, id: i64) -> Result<(bool, Body), String> {
        let (locked, data) = self.row(id)?;
        let key = self.key_for(o, locked)?;
        let raw = open(&key, &data)?;
        Ok((locked, serde_json::from_slice(&raw).map_err(|e| e.to_string())?))
    }

    pub fn get(&self, id: i64) -> Result<Note, String> {
        let mut o = self.open_state();
        self.touch(&mut o);
        let (locked, b) = self.body(&mut o, id)?;
        Ok(Note {
            id,
            title: b.title.clone(),
            text: b.text.clone(),
            rich: b.rich.clone(),
            locked,
            pinned: b.pinned,
            readonly: b.readonly,
            created: b.created,
            updated: b.updated,
        })
    }

    /// Writes a note (a new one without id). locked: behind the notes password (needs it
    /// unlocked). Returns its id.
    #[cfg(test)]
    pub fn save(&self, id: Option<i64>, title: &str, text: &str, locked: bool, pinned: bool) -> Result<i64, String> {
        self.save_rich(id, title, text, None, locked, pinned)
    }

    /// save with the formatting too (text = its plain words).
    #[cfg(test)]
    pub fn save_rich(
        &self,
        id: Option<i64>,
        title: &str,
        text: &str,
        rich: Option<&str>,
        locked: bool,
        pinned: bool,
    ) -> Result<i64, String> {
        self.save_full(id, title, text, rich, locked, pinned, false)
    }

    /// Everything of a note. readonly: its title and text stay as they are; while it is,
    /// a save that changes them is refused (pinning, moving it behind the password and
    /// turning it off still work).
    #[allow(clippy::too_many_arguments)]
    pub fn save_full(
        &self,
        id: Option<i64>,
        title: &str,
        text: &str,
        rich: Option<&str>,
        locked: bool,
        pinned: bool,
        readonly: bool,
    ) -> Result<i64, String> {
        if title.len() + text.len() + rich.map_or(0, str::len) > MAX_NOTE {
            return Err("This note is too long.".into());
        }
        let mut o = self.open_state();
        self.touch(&mut o);
        let created = match id {
            Some(id) => {
                let (_, old) = self.body(&mut o, id)?;
                let same = old.title == title && old.text == text && old.rich.as_deref() == rich;
                if old.readonly && readonly && !same {
                    return Err("This note is read-only.".into());
                }
                old.created
            }
            None => now(),
        };
        let body = Body {
            title: title.to_string(),
            text: text.to_string(),
            created,
            updated: now(),
            pinned,
            rich: rich.map(str::to_string),
            readonly,
        };
        let raw = Zeroizing::new(serde_json::to_vec(&body).map_err(|e| e.to_string())?);
        let data = seal(&self.key_for(&mut o, locked)?, &raw);
        match id {
            Some(id) => {
                self.conn
                    .execute("UPDATE notes SET locked = ?2, data = ?3 WHERE id = ?1", params![id, locked, data])
                    .map_err(|e| e.to_string())?;
                Ok(id)
            }
            None => {
                self.conn
                    .execute("INSERT INTO notes (locked, data) VALUES (?1, ?2)", params![locked, data])
                    .map_err(|e| e.to_string())?;
                Ok(self.conn.last_insert_rowid())
            }
        }
    }

    /// Into the trash, or back out of it.
    pub fn trash(&self, id: i64, into: bool) -> Result<(), String> {
        let mut o = self.open_state();
        self.touch(&mut o);
        // only what can be read now (a locked note only while unlocked)
        self.body(&mut o, id)?;
        self.conn
            .execute("UPDATE notes SET deleted_at = ?2 WHERE id = ?1", params![id, into.then(now)])
            .map(|_| ())
            .map_err(|e| e.to_string())
    }

    /// Out of the trash for good.
    pub fn purge(&self, id: i64) -> Result<(), String> {
        let mut o = self.open_state();
        self.touch(&mut o);
        self.body(&mut o, id)?;
        self.conn
            .execute("DELETE FROM notes WHERE id = ?1 AND deleted_at IS NOT NULL", [id])
            .map(|_| ())
            .map_err(|e| e.to_string())
    }

    /// Sets the notes password. Returns the recovery code (shown once) when one is wanted.
    pub fn create_vault(&self, password: &str, recovery: bool, cost: Cost) -> Result<Option<String>, String> {
        if load_vault(self.conn).is_some() {
            return Err("There is a notes password already.".into());
        }
        check_password(password)?;
        let mut o = self.open_state();
        let vk = rand_key();
        let (salt, key) = seal_vault_key(&vk, password, cost)?;
        let code = recovery.then(new_recovery_code);
        let (rsalt, rkey) = match &code {
            Some(c) => {
                let (s, k) = seal_vault_key(&vk, &clean_code(c), cost)?;
                (Some(s), Some(k))
            }
            None => (None, None),
        };
        save_vault(self.conn, &Vault { v: 1, cost, salt, key, rsalt, rkey })?;
        o.vk = Some(vk);
        o.used = Some(Instant::now());
        o.by_recovery = false;
        // the notes key with the vault's too
        let _ = self.notes_key(&mut o);
        Ok(code)
    }

    /// Opens the vault with the password, or with the recovery code (then a new password
    /// is due).
    pub fn unlock(&self, secret: &str, recovery: bool) -> Result<(), String> {
        let vault = load_vault(self.conn).ok_or("There is no notes password yet.")?;
        {
            let mut o = self.open_state();
            if let Some(t) = o.wait_from {
                if t.elapsed() < WAIT {
                    return Err(format!("Too many wrong tries. Wait {} seconds.", (WAIT - t.elapsed()).as_secs() + 1));
                }
                o.wait_from = None;
            }
        }
        let secret = if recovery { clean_code(secret) } else { Zeroizing::new(secret.to_string()) };
        // (the slow part, off the lock)
        let vk = unseal_vault(&vault, &secret, recovery);
        let mut o = self.open_state();
        let Some(vk) = vk else {
            o.misses += 1;
            if o.misses >= TRIES {
                o.misses = 0;
                o.wait_from = Some(Instant::now());
            }
            return Err(if recovery { "That recovery code is wrong." } else { "Wrong password." }.into());
        };
        o.misses = 0;
        o.vk = Some(vk);
        o.used = Some(Instant::now());
        o.by_recovery = recovery;
        let _ = self.notes_key(&mut o);
        Ok(())
    }

    pub fn lock(&self) {
        let mut o = self.open_state();
        o.vk = None;
        o.by_recovery = false;
    }

    /// A new password: the current one, or none right after the recovery code.
    pub fn change_password(&self, current: Option<&str>, new: &str) -> Result<(), String> {
        check_password(new)?;
        let mut vault = load_vault(self.conn).ok_or("There is no notes password yet.")?;
        let mut o = self.open_state();
        self.expire(&mut o);
        let vk = o.vk.clone().ok_or("The notes are locked.")?;
        if !o.by_recovery {
            let ok = current.and_then(|c| unseal_vault(&vault, c, false)).is_some_and(|k| *k == *vk);
            if !ok {
                return Err("The current password is wrong.".into());
            }
        }
        let (salt, key) = seal_vault_key(&vk, new, vault.cost)?;
        (vault.salt, vault.key) = (salt, key);
        save_vault(self.conn, &vault)?;
        o.by_recovery = false;
        o.used = Some(Instant::now());
        Ok(())
    }

    /// A new recovery code (the old one stops working), or none at all.
    pub fn set_recovery(&self, on: bool) -> Result<Option<String>, String> {
        let mut vault = load_vault(self.conn).ok_or("There is no notes password yet.")?;
        let mut o = self.open_state();
        self.touch(&mut o);
        let vk = o.vk.clone().ok_or("The notes are locked.")?;
        let code = on.then(new_recovery_code);
        (vault.rsalt, vault.rkey) = match &code {
            Some(c) => {
                let (s, k) = seal_vault_key(&vk, &clean_code(c), vault.cost)?;
                (Some(s), Some(k))
            }
            None => (None, None),
        };
        save_vault(self.conn, &vault)?;
        Ok(code)
    }

    /// No notes password any more: its notes become normal notes (the password asked once
    /// more).
    pub fn remove_vault(&self, password: &str) -> Result<(), String> {
        let vault = load_vault(self.conn).ok_or("There is no notes password.")?;
        let vk = unseal_vault(&vault, password, false).ok_or("Wrong password.")?;
        let mut o = self.open_state();
        let nk = self.notes_key(&mut o)?;
        let rows: Vec<(i64, Vec<u8>)> = {
            let mut stmt = self.conn.prepare("SELECT id, data FROM notes WHERE locked = 1").map_err(|e| e.to_string())?;
            let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?))).map_err(|e| e.to_string())?;
            rows.flatten().collect()
        };
        let tx = self.conn.unchecked_transaction().map_err(|e| e.to_string())?;
        for (id, data) in rows {
            let raw = open(&vk, &data)?;
            tx.execute("UPDATE notes SET locked = 0, data = ?2 WHERE id = ?1", params![id, seal(&nk, &raw)])
                .map_err(|e| e.to_string())?;
        }
        for k in [VAULT, KEY_VAULT] {
            tx.execute("DELETE FROM settings WHERE key = ?1", [k]).map_err(|e| e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())?;
        o.vk = None;
        o.by_recovery = false;
        Ok(())
    }

    pub fn set_autolock(&self, minutes: u64) -> Result<(), String> {
        db::set_setting(self.conn, AUTOLOCK, &minutes.min(24 * 60).to_string()).map_err(|e| e.to_string())
    }

    /// Locked because nobody used it for a while (the ticker asks).
    pub fn expired(&self) -> bool {
        let mut o = self.open_state();
        let was = o.vk.is_some();
        self.expire(&mut o);
        was && o.vk.is_none()
    }
}

fn check_password(p: &str) -> Result<(), String> {
    if p.chars().count() < MIN_PASSWORD {
        return Err("The password needs at least 4 characters.".into());
    }
    Ok(())
}

/// Where `want` (lower case) is in the text, by byte.
fn find(text: &str, want: &str) -> Option<usize> {
    // a letter's lower case can be longer ("İ"): each lower one knows its letter
    let mut low = String::new();
    let mut from = Vec::new();
    for (i, c) in text.char_indices() {
        for l in c.to_lowercase() {
            low.push(l);
            from.push(i);
        }
    }
    let at = low.find(want)?;
    from.get(low[..at].chars().count()).copied()
}

/// ~120 characters around a place, on one line.
fn snippet_at(text: &str, at: usize) -> String {
    let start = text[..at].char_indices().rev().nth(40).map_or(0, |(i, _)| i);
    let mut s: String = text[start..].chars().take(120).map(|c| if c.is_whitespace() { ' ' } else { c }).collect();
    s = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if start > 0 {
        s.insert(0, '…');
    }
    s
}

/* ---- the phone (bridge.rs, GET /api/notes) ------------------------------------ */

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PhoneNotes {
    /// the normal notes, readable (like the pictures the phone gets)
    pub notes: Vec<Note>,
    /// the ones behind the notes password, as they're stored here: sealed with the vault
    /// key. The phone opens them itself with the password, which never leaves it.
    pub locked: Vec<SealedNote>,
    /// what the phone needs for that: Argon2id's cost and salt, and the vault key sealed
    /// with the password's key (and the recovery code's). None without a notes password.
    pub vault: Option<serde_json::Value>,
    /// the normal notes can't be opened on this PC right now (left out)
    pub normal_closed: bool,
}

#[derive(Serialize)]
pub struct SealedNote {
    pub id: i64,
    /// base64 of "MICOLLE1" + 24-byte nonce + XChaCha20-Poly1305 ciphertext and tag
    pub data: String,
}

impl Notes<'_> {
    /// Every note that's not in the trash, for the phone. Nothing here counts as used
    /// (the vault doesn't stay open longer because of it).
    pub fn for_phone(&self) -> Result<PhoneNotes, String> {
        let mut o = self.open_state();
        let nk = self.notes_key(&mut o).ok();
        drop(o);
        let mut stmt = self
            .conn
            .prepare("SELECT id, locked, data FROM notes WHERE deleted_at IS NULL ORDER BY id")
            .map_err(|e| e.to_string())?;
        let rows: Vec<(i64, bool, Vec<u8>)> = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .map_err(|e| e.to_string())?
            .flatten()
            .collect();
        let mut out = PhoneNotes {
            notes: Vec::new(),
            locked: Vec::new(),
            vault: load_vault(self.conn).map(|v| serde_json::to_value(v).unwrap_or_default()),
            normal_closed: false,
        };
        for (id, locked, data) in rows {
            if locked {
                out.locked.push(SealedNote { id, data: B64.encode(&data) });
                continue;
            }
            let Some(nk) = &nk else {
                out.normal_closed = true;
                continue;
            };
            let Some(b) = open(nk, &data).ok().and_then(|raw| serde_json::from_slice::<Body>(&raw).ok()) else { continue };
            out.notes.push(Note {
                id,
                title: b.title.clone(),
                text: b.text.clone(),
                rich: b.rich.clone(),
                locked: false,
                pinned: b.pinned,
                readonly: b.readonly,
                created: b.created,
                updated: b.updated,
            });
        }
        Ok(out)
    }
}

/// The phone's notes from MiColl's own state (bridge.rs).
pub fn phone_notes(db: &crate::Db, state: &NotesState, dek: Option<[u8; 32]>, keeper: &Keeper) -> Result<PhoneNotes, String> {
    use crate::db::DbLock;
    let conn = db.conn();
    Notes { conn: &conn, state, dek, keeper }.for_phone()
}

/// Windows' keeping as a stand-in for the tests: "kept" by xor.
#[cfg(test)]
pub const TEST_KEEPER: Keeper = Keeper { keep: |b| Some(b.iter().map(|x| x ^ 0x5a).collect()), give: |b| Some(b.iter().map(|x| x ^ 0x5a).collect()) };

/* ---- commands ---------------------------------------------------------------- */

use crate::{db::DbLock, map_err, session_key, Db, DekState};
use tauri::{AppHandle, Emitter, Manager, State};

fn with<T>(db: &Db, state: &NotesState, dek: &DekState, f: impl FnOnce(&Notes) -> T) -> T {
    let conn = db.conn();
    f(&Notes { conn: &conn, state, dek: session_key(dek), keeper: &WINDOWS })
}

#[tauri::command]
pub fn notes_status(db: State<Db>, notes: State<NotesState>, dek: State<DekState>) -> Status {
    with(&db, &notes, &dek, |n| n.status())
}

#[tauri::command]
pub fn notes_list(db: State<Db>, notes: State<NotesState>, dek: State<DekState>, query: Option<String>, trash: Option<bool>) -> Result<Vec<NoteItem>, String> {
    with(&db, &notes, &dek, |n| n.list(query.as_deref().unwrap_or(""), trash.unwrap_or(false)))
}

#[tauri::command]
pub fn notes_get(db: State<Db>, notes: State<NotesState>, dek: State<DekState>, id: i64) -> Result<Note, String> {
    with(&db, &notes, &dek, |n| n.get(id))
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn notes_save(
    db: State<Db>,
    notes: State<NotesState>,
    dek: State<DekState>,
    id: Option<i64>,
    title: String,
    text: String,
    locked: bool,
    pinned: Option<bool>,
    rich: Option<String>,
    readonly: Option<bool>,
) -> Result<i64, String> {
    let rich = rich.map(Zeroizing::new);
    with(&db, &notes, &dek, |n| {
        n.save_full(id, &title, &text, rich.as_deref().map(|s| s.as_str()), locked, pinned.unwrap_or(false), readonly.unwrap_or(false))
    })
}

#[tauri::command]
pub fn notes_trash(db: State<Db>, notes: State<NotesState>, dek: State<DekState>, id: i64, into: bool) -> Result<(), String> {
    with(&db, &notes, &dek, |n| n.trash(id, into))
}

#[tauri::command]
pub fn notes_purge(db: State<Db>, notes: State<NotesState>, dek: State<DekState>, id: i64) -> Result<(), String> {
    with(&db, &notes, &dek, |n| n.purge(id))
}

/// Argon2 takes its time: these run off the main thread.
#[tauri::command]
pub async fn notes_vault_create(app: AppHandle, password: String, recovery: bool) -> Result<Option<String>, String> {
    let password = Zeroizing::new(password);
    let out = run(&app, move |n| n.create_vault(&password, recovery, STRONG)).await;
    watch(&app);
    out
}

#[tauri::command]
pub async fn notes_unlock(app: AppHandle, secret: String, recovery: Option<bool>) -> Result<(), String> {
    let secret = Zeroizing::new(secret);
    let out = run(&app, move |n| n.unlock(&secret, recovery.unwrap_or(false))).await;
    watch(&app);
    out
}

#[tauri::command]
pub async fn notes_change_password(app: AppHandle, current: Option<String>, password: String) -> Result<(), String> {
    let (current, password) = (current.map(Zeroizing::new), Zeroizing::new(password));
    run(&app, move |n| n.change_password(current.as_deref().map(|s| s.as_str()), &password)).await
}

#[tauri::command]
pub async fn notes_set_recovery(app: AppHandle, on: bool) -> Result<Option<String>, String> {
    run(&app, move |n| n.set_recovery(on)).await
}

#[tauri::command]
pub async fn notes_remove_vault(app: AppHandle, password: String) -> Result<(), String> {
    let password = Zeroizing::new(password);
    run(&app, move |n| n.remove_vault(&password)).await
}

#[tauri::command]
pub fn notes_lock(db: State<Db>, notes: State<NotesState>, dek: State<DekState>) {
    with(&db, &notes, &dek, |n| n.lock())
}

#[tauri::command]
pub fn notes_set_autolock(db: State<Db>, notes: State<NotesState>, dek: State<DekState>, minutes: u64) -> Result<(), String> {
    with(&db, &notes, &dek, |n| n.set_autolock(minutes))
}

async fn run<T: Send + 'static>(app: &AppHandle, f: impl FnOnce(&Notes) -> Result<T, String> + Send + 'static) -> Result<T, String> {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let (db, notes, dek) = (app.state::<Db>(), app.state::<NotesState>(), app.state::<DekState>());
        with(&db, &notes, &dek, f)
    })
    .await
    .map_err(map_err)?
}

/// What a copy field put on the clipboard (its number there), until it's cleared.
static COPIED: Mutex<Option<u32>> = Mutex::new(None);
/// A copy field's text stays on the clipboard this long.
const COPY_FOR: Duration = Duration::from_secs(60);

/// A copy field's text onto the clipboard: out of Windows' clipboard history, and taken
/// off again after a minute (unless something else was copied meanwhile). Nothing for an
/// empty one.
#[tauri::command]
pub fn notes_copy(text: String) -> Result<(), String> {
    let text = Zeroizing::new(text);
    if text.is_empty() {
        return Ok(());
    }
    let seq = crate::wshare::copy_secret(&text)?;
    *COPIED.lock().unwrap_or_else(|e| e.into_inner()) = Some(seq);
    std::thread::spawn(move || {
        std::thread::sleep(COPY_FOR);
        let mut c = COPIED.lock().unwrap_or_else(|e| e.into_inner());
        if *c == Some(seq) {
            *c = None;
            crate::wshare::clear_secret(seq);
        }
    });
    Ok(())
}

/// The copied text goes now (MiColl locks or ends).
pub fn clear_copied() {
    if let Some(seq) = COPIED.lock().unwrap_or_else(|e| e.into_inner()).take() {
        crate::wshare::clear_secret(seq);
    }
}

/// MiColl locks or ends: the vault locks too.
pub fn lock_now(app: &AppHandle) {
    clear_copied();
    if let Some(s) = app.try_state::<NotesState>() {
        let mut o = s.0.lock().unwrap_or_else(|e| e.into_inner());
        let was = o.vk.take().is_some();
        o.by_recovery = false;
        drop(o);
        if was {
            let _ = app.emit("notes-locked", ());
        }
    }
}

/// While the vault is open: locks it once nobody used it for a while, and tells the
/// window ("notes-locked").
fn watch(app: &AppHandle) {
    static WATCHING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    if WATCHING.swap(true, std::sync::atomic::Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    let _ = std::thread::Builder::new().name("micoll-notes-lock".into()).spawn(move || {
        loop {
            std::thread::sleep(Duration::from_secs(10));
            let (db, notes, dek) = (app.state::<Db>(), app.state::<NotesState>(), app.state::<DekState>());
            let (locked_now, open) = with(&db, &notes, &dek, |n| (n.expired(), n.open_state().vk.is_some()));
            if locked_now {
                let _ = app.emit("notes-locked", ());
            }
            if !open {
                break;
            }
        }
        WATCHING.store(false, std::sync::atomic::Ordering::SeqCst);
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    const CHEAP: Cost = Cost { m: 256, t: 1, p: 1 };

    fn db() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);").unwrap();
        ensure_table(&c).unwrap();
        c
    }

    // a stand-in for Windows: "kept" by xor; another PC can't give it back
    fn keep(b: &[u8]) -> Option<Vec<u8>> {
        Some(b.iter().map(|x| x ^ 0x5a).collect())
    }
    fn give(b: &[u8]) -> Option<Vec<u8>> {
        keep(b)
    }
    const HERE: Keeper = Keeper { keep, give };
    const ELSEWHERE: Keeper = Keeper { keep: |_| None, give: |_| None };

    fn notes<'a>(conn: &'a Connection, state: &'a NotesState, dek: Option<[u8; 32]>, keeper: &'a Keeper) -> Notes<'a> {
        Notes { conn, state, dek, keeper }
    }

    fn all_bytes(conn: &Connection) -> Vec<u8> {
        let mut out = Vec::new();
        let mut s = conn.prepare("SELECT data FROM notes").unwrap();
        for b in s.query_map([], |r| r.get::<_, Vec<u8>>(0)).unwrap().flatten() {
            out.extend(b);
        }
        let mut s = conn.prepare("SELECT value FROM settings").unwrap();
        for v in s.query_map([], |r| r.get::<_, String>(0)).unwrap().flatten() {
            out.extend(v.into_bytes());
        }
        out
    }

    fn has(hay: &[u8], needle: &str) -> bool {
        hay.windows(needle.len()).any(|w| w == needle.as_bytes())
    }

    #[test]
    fn normal_notes_are_sealed_and_found() {
        let c = db();
        let st = NotesState::default();
        let n = notes(&c, &st, None, &HERE);
        let a = n.save(None, "Shopping", "milk, bread and Äpfel for the cake", false, false).unwrap();
        let b = n.save(None, "Ideas", "a slideshow for rainy days", false, true).unwrap();
        // nothing readable in the database
        let raw = all_bytes(&c);
        assert!(!has(&raw, "Shopping") && !has(&raw, "milk") && !has(&raw, "slideshow"));
        // pinned first, then the newest
        let l = n.list("", false).unwrap();
        assert_eq!(l.iter().map(|x| x.id).collect::<Vec<_>>(), [b, a]);
        assert_eq!(l[1].snippet, "milk, bread and Äpfel for the cake");
        // the search: title or text, any case, the text around it
        assert_eq!(n.list("äPFEL", false).unwrap().iter().map(|x| x.id).collect::<Vec<_>>(), [a]);
        assert_eq!(n.list("ideas", false).unwrap()[0].id, b);
        assert!(n.list("nothing like it", false).unwrap().is_empty());
        // edited: same id, still created then
        let before = n.get(a).unwrap();
        n.save(Some(a), "Shopping", "only milk", false, false).unwrap();
        let after = n.get(a).unwrap();
        assert_eq!((after.text.as_str(), after.created), ("only milk", before.created));
        // the trash, and back
        n.trash(a, true).unwrap();
        assert_eq!(n.list("", false).unwrap().len(), 1);
        assert_eq!(n.list("", true).unwrap()[0].id, a);
        n.trash(a, false).unwrap();
        assert_eq!(n.list("", false).unwrap().len(), 2);
        // gone for good only from the trash, and after 30 days by itself
        assert!(n.purge(a).is_ok());
        assert_eq!(n.list("", false).unwrap().len(), 2, "not in the trash: stays");
        n.trash(a, true).unwrap();
        n.purge(a).unwrap();
        assert!(n.get(a).is_err());
        n.trash(b, true).unwrap();
        c.execute("UPDATE notes SET deleted_at = ?1", [now() - 31 * 86400]).unwrap();
        assert!(n.list("", true).unwrap().is_empty());
        assert_eq!(c.query_row("SELECT COUNT(*) FROM notes", [], |r| r.get::<_, i64>(0)).unwrap(), 0);
        assert!(n.save(None, "big", &"x".repeat(MAX_NOTE + 1), false, false).is_err());
        // with formatting: kept as it was given, sealed like the rest; plain without it
        let doc = r#"{"type":"doc","content":[{"type":"heading","content":[{"type":"text","text":"FORMATIERT"}]}]}"#;
        let f = n.save_rich(None, "Rich", "FORMATIERT", Some(doc), false, false).unwrap();
        assert_eq!(n.get(f).unwrap().rich.as_deref(), Some(doc));
        assert!(!has(&all_bytes(&c), "FORMATIERT"));
        assert_eq!(n.list("formatiert", false).unwrap()[0].id, f);
        let p = n.save(None, "Plain", "x", false, false).unwrap();
        assert_eq!(n.get(p).unwrap().rich, None);
        assert!(n.save_rich(None, "big", "x", Some(&"x".repeat(MAX_NOTE)), false, false).is_err());
        // read-only: the words stay, the rest can change, and it can be turned off
        n.save_full(Some(f), "Rich", "FORMATIERT", Some(doc), false, false, true).unwrap();
        assert!(n.get(f).unwrap().readonly && n.list("formatiert", false).unwrap()[0].readonly);
        assert_eq!(n.save_full(Some(f), "Rich", "changed", Some(doc), false, false, true), Err("This note is read-only.".into()));
        assert!(n.save_full(Some(f), "Other title", "FORMATIERT", Some(doc), false, false, true).is_err());
        n.save_full(Some(f), "Rich", "FORMATIERT", Some(doc), false, true, true).unwrap();
        assert!(n.get(f).unwrap().pinned);
        n.save_full(Some(f), "Rich", "FORMATIERT", Some(doc), false, true, false).unwrap();
        n.save_full(Some(f), "Rich", "changed", Some(doc), false, true, false).unwrap();
        assert_eq!(n.get(f).unwrap().text, "changed");
    }

    #[test]
    fn locked_notes_need_the_password_and_stay_hidden() {
        let c = db();
        let st = NotesState::default();
        let n = notes(&c, &st, None, &HERE);
        n.save(None, "Normal", "seen", false, false).unwrap();
        assert!(n.save(None, "Secret", "x", true, false).is_err(), "no password yet");
        assert!(n.create_vault("abc", false, CHEAP).is_err());
        assert_eq!(n.create_vault("correct horse", false, CHEAP).unwrap(), None);
        assert!(n.create_vault("again and again", false, CHEAP).is_err());
        let s = n.save(None, "Bank", "PIN 4711", true, false).unwrap();
        assert_eq!(n.list("", false).unwrap().len(), 2);
        assert!(!has(&all_bytes(&c), "4711") && !has(&all_bytes(&c), "correct horse"));
        n.lock();
        // locked: not listed, not found, not opened, not changed
        let l = n.list("", false).unwrap();
        assert_eq!(l.iter().map(|x| x.title.as_str()).collect::<Vec<_>>(), ["Normal"]);
        assert!(n.list("bank", false).unwrap().is_empty());
        assert!(n.get(s).is_err() && n.save(Some(s), "x", "y", true, false).is_err() && n.trash(s, true).is_err());
        let st2 = n.status();
        assert!(st2.vault && !st2.unlocked && !st2.recovery && !st2.normal_closed);
        assert_eq!(n.unlock("wrong one!", false), Err("Wrong password.".into()));
        n.unlock("correct horse", false).unwrap();
        assert_eq!(n.get(s).unwrap().text, "PIN 4711");
        // moved behind the password and back
        let id = n.list("seen", false).unwrap()[0].id;
        n.save(Some(id), "Normal", "seen", true, false).unwrap();
        n.lock();
        assert!(n.list("", false).unwrap().is_empty());
        n.unlock("correct horse", false).unwrap();
        n.save(Some(id), "Normal", "seen", false, false).unwrap();
        n.lock();
        assert_eq!(n.list("", false).unwrap().len(), 1);
    }

    #[test]
    fn wrong_tries_wait_and_the_vault_locks_by_itself() {
        let c = db();
        let st = NotesState::default();
        let n = notes(&c, &st, None, &HERE);
        n.create_vault("correct horse", false, CHEAP).unwrap();
        n.lock();
        for _ in 0..TRIES {
            assert!(n.unlock("nope nope", false).is_err());
        }
        let e = n.unlock("correct horse", false).unwrap_err();
        assert!(e.starts_with("Too many wrong tries"), "{e}");
        st.0.lock().unwrap().wait_from = Some(Instant::now() - WAIT);
        n.unlock("correct horse", false).unwrap();
        // not used for longer than the minutes set
        n.set_autolock(1).unwrap();
        st.0.lock().unwrap().used = Some(Instant::now() - Duration::from_secs(61));
        assert!(n.expired() && !n.status().unlocked);
        assert!(!n.expired(), "said once");
        // 0 = only with MiColl
        n.set_autolock(0).unwrap();
        n.unlock("correct horse", false).unwrap();
        st.0.lock().unwrap().used = Some(Instant::now() - Duration::from_secs(99_999));
        assert!(!n.expired() && n.status().unlocked);
        assert_eq!(n.status().autolock_min, 0);
    }

    #[test]
    fn the_recovery_code_opens_it_and_a_new_password_follows() {
        let c = db();
        let st = NotesState::default();
        let n = notes(&c, &st, None, &HERE);
        let code = n.create_vault("first password", true, CHEAP).unwrap().unwrap();
        assert_eq!(code.len(), 29);
        assert!(code.split('-').all(|g| g.len() == 5));
        let s = n.save(None, "Mail", "hunter2", true, false).unwrap();
        n.lock();
        assert!(n.status().recovery);
        assert!(n.unlock("AAAAA-AAAAA-AAAAA-AAAAA-AAAAA", true).is_err());
        // typed sloppily
        let typed = code.to_lowercase().replace('-', " ").replace('O', "0");
        n.unlock(&typed, true).unwrap();
        assert!(n.status().by_recovery);
        assert_eq!(n.get(s).unwrap().text, "hunter2");
        // the new password without the old one
        n.change_password(None, "second password").unwrap();
        assert!(!n.status().by_recovery);
        n.lock();
        assert!(n.unlock("first password", false).is_err());
        n.unlock("second password", false).unwrap();
        // from now on the current one is asked
        assert!(n.change_password(None, "third password").is_err());
        assert!(n.change_password(Some("first password"), "third password").is_err());
        n.change_password(Some("second password"), "third password").unwrap();
        // a new code: the old one doesn't open it any more; none at all
        let code2 = n.set_recovery(true).unwrap().unwrap();
        n.lock();
        assert!(n.unlock(&code, true).is_err());
        n.unlock(&code2, true).unwrap();
        n.set_recovery(false).unwrap();
        n.lock();
        assert!(n.unlock(&code2, true).is_err() && !n.status().recovery);
        n.unlock("third password", false).unwrap();
        assert_eq!(n.get(s).unwrap().text, "hunter2");
    }

    #[test]
    fn without_the_password_its_notes_become_normal_ones() {
        let c = db();
        let st = NotesState::default();
        let n = notes(&c, &st, None, &HERE);
        n.create_vault("correct horse", true, CHEAP).unwrap();
        let s = n.save(None, "Kept", "still here", true, false).unwrap();
        assert!(n.remove_vault("wrong wrong").is_err());
        n.remove_vault("correct horse").unwrap();
        let st2 = n.status();
        assert!(!st2.vault && !st2.unlocked && !st2.recovery);
        let note = n.get(s).unwrap();
        assert!(!note.locked && note.text == "still here");
        assert!(setting(&c, VAULT).is_none() && setting(&c, KEY_VAULT).is_none());
    }

    #[test]
    fn on_another_pc_normal_notes_open_with_micolls_key_or_the_notes_password() {
        let c = db();
        let dek = [7u8; 32];
        let st = NotesState::default();
        let n = notes(&c, &st, Some(dek), &HERE);
        let a = n.save(None, "Plan", "move to the new PC", false, false).unwrap();
        n.create_vault("correct horse", false, CHEAP).unwrap();
        // another PC: Windows doesn't know the key; MiColl still locked
        let st = NotesState::default();
        let there = notes(&c, &st, None, &ELSEWHERE);
        assert!(there.status().normal_closed);
        assert!(there.list("", false).unwrap().is_empty());
        assert!(there.get(a).is_err() && there.save(None, "x", "y", false, false).is_err());
        // with MiColl unlocked
        let st = NotesState::default();
        let there = notes(&c, &st, Some(dek), &ELSEWHERE);
        assert_eq!(there.get(a).unwrap().text, "move to the new PC");
        // or with the notes password, MiColl without encryption
        let st = NotesState::default();
        let there = notes(&c, &st, None, &ELSEWHERE);
        there.unlock("correct horse", false).unwrap();
        assert_eq!(there.get(a).unwrap().text, "move to the new PC");
        // the first time: a new key, kept
        let c2 = db();
        let st = NotesState::default();
        let fresh = notes(&c2, &st, None, &HERE);
        assert!(!fresh.status().normal_closed);
        assert!(setting(&c2, KEY_DPAPI).is_some());
    }

    /// What the phone gets, and how it opens a locked note: only with what's in the answer
    /// and the password, like the phone does it.
    #[test]
    fn the_phone_gets_normal_notes_readable_and_locked_ones_sealed() {
        let c = db();
        let st = NotesState::default();
        let n = notes(&c, &st, None, &HERE);
        let a = n.save_full(None, "Plain", "readable", Some(r#"{"type":"doc"}"#), false, true, true).unwrap();
        let none = n.for_phone().unwrap();
        assert!(none.vault.is_none() && none.locked.is_empty() && none.notes.len() == 1);
        n.create_vault("pin1", true, CHEAP).unwrap();
        let s = n.save(None, "Secret", "PIN 4711", true, false).unwrap();
        let gone = n.save(None, "Old", "x", false, false).unwrap();
        n.trash(gone, true).unwrap();
        n.lock();
        let got = n.for_phone().unwrap();
        // locked or not on the PC: the same answer, nothing readable of the locked one
        assert_eq!(got.notes.len(), 1);
        let p = &got.notes[0];
        assert_eq!((p.id, p.title.as_str(), p.text.as_str(), p.pinned, p.readonly), (a, "Plain", "readable", true, true));
        assert_eq!(p.rich.as_deref(), Some(r#"{"type":"doc"}"#));
        assert_eq!(got.locked.len(), 1);
        assert_eq!(got.locked[0].id, s);
        let json = serde_json::to_string(&got).unwrap();
        assert!(!json.contains("4711") && !json.contains("Secret") && !json.contains("pin1"));
        // the phone's side, from the answer alone
        let v = got.vault.unwrap();
        let b64 = |k: &str| B64.decode(v[k].as_str().unwrap()).unwrap();
        let cost: Cost = serde_json::from_value(v["cost"].clone()).unwrap();
        let unseal = |secret: &str, salt: &str, key: &str| -> Option<Key> {
            let kek = stretch(secret, &b64(salt), cost).ok()?;
            open_key(&kek, &b64(key))
        };
        assert!(unseal("wrong", "salt", "key").is_none());
        let vk = unseal("pin1", "salt", "key").unwrap();
        let body: serde_json::Value = serde_json::from_slice(&open(&vk, &B64.decode(&got.locked[0].data).unwrap()).unwrap()).unwrap();
        assert_eq!((body["t"].as_str(), body["b"].as_str()), (Some("Secret"), Some("PIN 4711")));
        assert!(v["rkey"].is_string() && v["rsalt"].is_string());
    }

    #[test]
    fn snippets_and_search_over_any_text() {
        let long = format!("{}needle{}", "a b ".repeat(50), " z".repeat(80));
        let at = find(&long, "needle").unwrap();
        let s = snippet_at(&long, at);
        assert!(s.starts_with('…') && s.contains("needle") && s.chars().count() <= 121);
        // letters whose lower case is longer
        let t = "İstanbul notes: Straße";
        assert_eq!(&t[find(t, "straße").unwrap()..], "Straße");
        assert_eq!(snippet_at("line one\n\n  line two", 0), "line one line two");
    }

    #[cfg(windows)]
    #[test]
    fn windows_keeps_it_for_this_user() {
        let k = (WINDOWS.keep)(b"0123456789abcdef0123456789abcdef").unwrap();
        assert!(!has(&k, "0123456789"));
        assert_eq!((WINDOWS.give)(&k).unwrap(), b"0123456789abcdef0123456789abcdef");
        let mut bad = k.clone();
        let last = bad.len() - 1;
        bad[last] ^= 1;
        assert!((WINDOWS.give)(&bad).is_none());
    }

    #[test]
    fn the_strong_cost_is_strong() {
        assert!(STRONG.m >= 64 * 1024 && STRONG.t >= 3);
        let t = Instant::now();
        let a = stretch("correct horse", b"0123456789abcdef", STRONG).unwrap();
        let took = t.elapsed();
        assert_eq!(*a, *stretch("correct horse", b"0123456789abcdef", STRONG).unwrap());
        assert_ne!(*a, *stretch("correct horsf", b"0123456789abcdef", STRONG).unwrap());
        eprintln!("one try: {took:?}");
    }
}
