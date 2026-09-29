//! Ed25519 signing for paid content — the trust anchor behind the verified
//! checkmark and the premium-theme unlock.
//!
//! Only the owner holds the private key (a 32-byte seed, base64, in a file that
//! is never shipped or committed); the matching public key is baked into every
//! build below. Two things get signed:
//!   * **Templates** — wrapped in a `SignedEnvelope`; `template::parse` honors
//!     `verified` flags only when the envelope's signature checks out, so a
//!     checkmark can never be forged by editing JSON or the DB.
//!   * **Theme licenses** — a small token (`MICOLL-THEMES.<payload>.<sig>`) the
//!     buyer pastes into Settings to permanently unlock the premium accents.
//!
//! Signatures make paid content un-*forgeable*, not un-*copyable* — that's the
//! deliberate trade-off (no DRM, no server, no phoning home).

use base64::{engine::general_purpose::STANDARD, Engine as _};
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// Official signing keys, by `keyId` (kept as a list so a future key rotation
/// can add key 2 while old files signed with key 1 stay valid).
pub const OFFICIAL_KEYS: &[(u32, [u8; 32])] = &[(
    1,
    [
        0x8b, 0xa7, 0xa1, 0xb4, 0x1c, 0xa2, 0xcd, 0x9a, 0x6c, 0x0f, 0x84, 0x38, 0x7c, 0xaa,
        0x0a, 0x90, 0xf3, 0x66, 0xe4, 0xc8, 0x6d, 0x4c, 0x38, 0xd5, 0xfb, 0xef, 0xd0, 0xb1,
        0x7d, 0x4a, 0xaf, 0xc6,
    ],
)];

/// Theme keys that this build refuses, by fingerprint (see `key_fingerprint`).
///
/// The realistic leak isn't a forged key — signatures make that impossible — it
/// is one real key pasted somewhere public. When that happens the key is visible
/// (that's what "public" means), so its fingerprint goes in here and the next
/// release stops honouring it. Costs one line and one build per incident.
///
/// What it is not: a fence. It only reaches people who update, and an old binary
/// keeps accepting the key forever. It's damage control, and it is deliberately
/// the cheapest thing that works against the one case that actually happens.
///
/// Every honest buyer has their own signature, so nobody else is touched by an
/// entry here. Add one as:
///     "a1b2c3d4e5f60718", // 2026-08-15 — posted on Reddit
pub const REVOKED_SIGS: &[&str] = &[];

/// A theme key's fingerprint: SHA-256 over its raw signature bytes, first 16 hex
/// characters. Derived from the signature rather than the payload, so two keys
/// issued to the same name are still told apart, and it reveals nothing about
/// the key itself — it can be shown in the UI and quoted in a support mail.
pub fn key_fingerprint(sig_bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(sig_bytes);
    digest.iter().take(8).map(|b| format!("{b:02x}")).collect()
}

/// The fingerprint of a pasted key, for the owner to copy into `REVOKED_SIGS`.
/// Deliberately does *not* verify the signature: a key being revoked is exactly
/// the case where the owner still needs to read its fingerprint.
pub fn theme_key_fingerprint(token: &str) -> Result<String, String> {
    let bad = || "This doesn't look like a MiColl theme key.".to_string();
    let rest = token.trim().strip_prefix(THEME_KEY_PREFIX).ok_or_else(bad)?;
    let (_, s64) = rest.split_once('.').ok_or_else(bad)?;
    let sig_bytes = STANDARD.decode(s64.trim()).map_err(|_| bad())?;
    Ok(key_fingerprint(&sig_bytes))
}

/* ---- signed template envelope ----------------------------------------- */

/// The on-disk wrapper around a signed template. Signing the raw payload bytes
/// (rather than re-serialized JSON) sidesteps canonicalization entirely: the
/// exact bytes that were signed are the exact bytes that get verified.
#[derive(Serialize, Deserialize, Clone)]
pub struct SignedEnvelope {
    #[serde(rename = "micollSigned")]
    pub version: u32,
    #[serde(rename = "keyId")]
    pub key_id: u32,
    /// base64 of the inner template JSON (UTF-8 bytes).
    pub payload: String,
    /// base64 Ed25519 signature over the decoded payload bytes.
    pub sig: String,
}

/// Distinguish a signed envelope from a plain template. `Ok(None)` = not an
/// envelope (let the plain parser deal with it, including its own errors);
/// `Err` = it claims to be signed but the wrapper itself is malformed.
pub fn detect_envelope(json: &str) -> Result<Option<SignedEnvelope>, String> {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(json) else {
        return Ok(None);
    };
    if v.get("micollSigned").is_none() {
        return Ok(None);
    }
    let env: SignedEnvelope = serde_json::from_value(v)
        .map_err(|e| format!("This signed template file is broken: {e}"))?;
    if env.version != 1 {
        return Err(format!(
            "Unsupported signed-template version {} (this build understands version 1).",
            env.version
        ));
    }
    Ok(Some(env))
}

impl SignedEnvelope {
    /// Verify against `keys` and return the inner template JSON on success.
    pub fn verify_with(&self, keys: &[(u32, [u8; 32])]) -> Result<String, String> {
        let pk = keys
            .iter()
            .find(|(id, _)| *id == self.key_id)
            .map(|(_, pk)| pk)
            .ok_or_else(|| {
                "This template was signed with a key this build doesn't know — \
                 update MiColl and try again."
                    .to_string()
            })?;
        let payload = STANDARD
            .decode(self.payload.trim())
            .map_err(|_| "This signed template file is broken (bad payload encoding).")?;
        let sig_bytes = STANDARD
            .decode(self.sig.trim())
            .map_err(|_| "This signed template file is broken (bad signature encoding).")?;
        let vk = VerifyingKey::from_bytes(pk).map_err(|_| "Bad public key in this build.")?;
        let sig = Signature::from_slice(&sig_bytes)
            .map_err(|_| "This signed template file is broken (bad signature length).")?;
        vk.verify_strict(&payload, &sig).map_err(|_| {
            "Signature check failed — this template file was modified or corrupted. \
             Re-download the original file."
                .to_string()
        })?;
        String::from_utf8(payload)
            .map_err(|_| "This signed template file is broken (payload isn't UTF-8).".into())
    }

    pub fn verify(&self) -> Result<String, String> {
        self.verify_with(OFFICIAL_KEYS)
    }
}

/* ---- owner-side signing ------------------------------------------------ */

/// Where the owner's private key lives. `MICOLL_SIGNING_KEY` (a file path)
/// overrides the default `%USERPROFILE%\.micoll\micoll-signing.key`. Shipped
/// installs simply have no file there, which keeps every signing command inert.
pub fn signing_key_path() -> PathBuf {
    if let Ok(p) = std::env::var("MICOLL_SIGNING_KEY") {
        if !p.trim().is_empty() {
            return PathBuf::from(p);
        }
    }
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_default();
    PathBuf::from(home).join(".micoll").join("micoll-signing.key")
}

fn load_signing_key() -> Result<SigningKey, String> {
    let raw = std::fs::read_to_string(signing_key_path())
        .map_err(|_| "No signing key installed on this machine.".to_string())?;
    let bytes = STANDARD
        .decode(raw.trim())
        .map_err(|_| "The signing key file isn't valid base64.")?;
    let seed: [u8; 32] = bytes
        .try_into()
        .map_err(|_| "The signing key must be exactly 32 bytes.")?;
    Ok(SigningKey::from_bytes(&seed))
}

/// The keyId this machine's private key corresponds to — `Err` when there is no
/// key, or it doesn't match any key baked into this build (signing with it
/// would produce files nobody can verify).
fn own_key_id() -> Result<(SigningKey, u32), String> {
    let sk = load_signing_key()?;
    let vk = sk.verifying_key();
    let id = OFFICIAL_KEYS
        .iter()
        .find(|(_, pk)| pk == vk.as_bytes())
        .map(|(id, _)| *id)
        .ok_or_else(|| {
            "The installed signing key doesn't match any key baked into this build."
                .to_string()
        })?;
    Ok((sk, id))
}

/// Can this machine produce official signatures? (Gates the editor's verified mode.)
pub fn can_sign() -> bool {
    own_key_id().is_ok()
}

/// Wrap a template JSON in a signed envelope (pretty-printed, same
/// `.micoll.json` convention as plain templates).
pub fn sign_template(inner_json: &str) -> Result<String, String> {
    let (sk, key_id) = own_key_id()?;
    let sig = sk.sign(inner_json.as_bytes());
    let env = SignedEnvelope {
        version: 1,
        key_id,
        payload: STANDARD.encode(inner_json.as_bytes()),
        sig: STANDARD.encode(sig.to_bytes()),
    };
    serde_json::to_string_pretty(&env).map_err(|e| e.to_string())
}

/* ---- premium-theme licenses -------------------------------------------- */

const THEME_KEY_PREFIX: &str = "MICOLL-THEMES.";

/// What a bought key unlocks.
pub const THEME_PRODUCT: &str = "themes";

/// What a test key unlocks. A separate product on purpose: a build made before
/// trials existed ignores JSON fields it doesn't know, so a trial marked only by
/// an extra `expires` would be honoured *forever* by every older MiColl. Under its
/// own product name those builds refuse it outright ("This key unlocks a different
/// product"), which is the right answer from something that cannot enforce the
/// limit.
pub const THEME_TRIAL_PRODUCT: &str = "themes-trial";

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ThemeLicense {
    pub product: String,
    /// Buyer name / Patreon handle — printed on the key to discourage sharing.
    pub buyer: String,
    pub issued: String,
    /// Trial keys only: the last day this key works, YYYY-MM-DD. Checked here,
    /// because the key carries its own end and needs nothing remembered.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires: Option<String>,
    /// Trial keys only: how many days it runs from the day it is first pasted.
    /// NOT checked here — "first pasted" is something only the library that took
    /// the key can know. See `verify_theme_license` in lib.rs, which stamps the
    /// day and does the arithmetic.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub days: Option<u32>,
}

/// How a test key stops working. Exactly one of the two, never both: a key with a
/// date and a duration would have two answers to the same question.
pub enum TrialTerms {
    /// Dead after this day (YYYY-MM-DD), whenever it was pasted.
    Until(String),
    /// Dead this many days after the day it was first pasted.
    Days(u32),
}

/// `true` for a plausible YYYY-MM-DD. Not a calendar check — a date that doesn't
/// exist still sorts correctly against today, which is all the comparison needs.
fn looks_like_a_date(v: &str) -> bool {
    let b = v.as_bytes();
    b.len() == 10
        && b[4] == b'-'
        && b[7] == b'-'
        && b.iter().enumerate().all(|(i, c)| i == 4 || i == 7 || c.is_ascii_digit())
}

/// Issue a premium-theme unlock key for a buyer (owner-only). `trial` makes it a
/// key that runs out; without it the key is permanent, and its payload is byte for
/// byte what this function has always produced (the two new fields are skipped
/// when empty, so every key already in someone's hands keeps verifying).
pub fn issue_theme_key(buyer: &str, trial: Option<TrialTerms>) -> Result<String, String> {
    let buyer = buyer.trim();
    if buyer.is_empty() {
        return Err("Enter the buyer's name / Patreon handle.".into());
    }
    let (expires, days) = match &trial {
        None => (None, None),
        Some(TrialTerms::Until(date)) => {
            if !looks_like_a_date(date) {
                return Err("The end date has to read YYYY-MM-DD.".into());
            }
            // A date in the past is allowed on purpose: the only way to see what a
            // buyer sees when their key runs out is to hold one that already has.
            // The owner is the only person who can reach this, the dialog says so
            // when the date is past, and a dead key announces itself the moment it
            // is pasted — so refusing here would only block the test.
            (Some(date.clone()), None)
        }
        Some(TrialTerms::Days(n)) => {
            if *n == 0 {
                return Err("A test key has to run for at least a day.".into());
            }
            (None, Some(*n))
        }
    };
    let (sk, _) = own_key_id()?;
    let lic = ThemeLicense {
        product: if trial.is_some() { THEME_TRIAL_PRODUCT } else { THEME_PRODUCT }.into(),
        buyer: buyer.to_string(),
        issued: chrono_date(),
        expires,
        days,
    };
    let payload = serde_json::to_vec(&lic).map_err(|e| e.to_string())?;
    let sig = sk.sign(&payload);
    Ok(format!(
        "{THEME_KEY_PREFIX}{}.{}",
        STANDARD.encode(&payload),
        STANDARD.encode(sig.to_bytes())
    ))
}

/// Days since 1970-01-01. The unit trial arithmetic is done in — adding days to a
/// YYYY-MM-DD string is the part that would need a date crate; adding them to a
/// number is not.
pub fn epoch_day() -> i64 {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    (secs / 86_400) as i64
}

/// Today's date as YYYY-MM-DD without pulling in a date crate.
pub(crate) fn chrono_date() -> String {
    civil_from_days(epoch_day())
}

/// A day count since the epoch as YYYY-MM-DD (Howard Hinnant's algorithm).
pub fn civil_from_days(days: i64) -> String {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}-{d:02}")
}

/// Validate a pasted theme key against the official keys and the revocation list.
pub fn verify_theme_key(token: &str) -> Result<ThemeLicense, String> {
    verify_theme_key_with(token, OFFICIAL_KEYS, REVOKED_SIGS)
}

fn verify_theme_key_with(
    token: &str,
    keys: &[(u32, [u8; 32])],
    revoked: &[&str],
) -> Result<ThemeLicense, String> {
    let bad = || "This doesn't look like a MiColl theme key.".to_string();
    let rest = token.trim().strip_prefix(THEME_KEY_PREFIX).ok_or_else(bad)?;
    let (p64, s64) = rest.split_once('.').ok_or_else(bad)?;
    let payload = STANDARD.decode(p64.trim()).map_err(|_| bad())?;
    let sig_bytes = STANDARD.decode(s64.trim()).map_err(|_| bad())?;
    let sig = Signature::from_slice(&sig_bytes).map_err(|_| bad())?;
    let verified = keys.iter().any(|(_, pk)| {
        VerifyingKey::from_bytes(pk)
            .map(|vk| vk.verify_strict(&payload, &sig).is_ok())
            .unwrap_or(false)
    });
    if !verified {
        return Err("This theme key is not valid. Check for copy/paste typos.".into());
    }
    // Revocation is checked after the signature, never before: only a real key
    // can be revoked, and a forged one should read as forged rather than as
    // somebody's cancelled licence.
    let fp = key_fingerprint(&sig_bytes);
    if revoked.iter().any(|r| r.trim().eq_ignore_ascii_case(&fp)) {
        return Err(format!(
            "This theme key has been revoked (key {fp}). If you bought it,              get in touch and you'll get a new one."
        ));
    }
    let lic: ThemeLicense = serde_json::from_slice(&payload).map_err(|_| bad())?;
    let trial = match lic.product.as_str() {
        THEME_PRODUCT => false,
        THEME_TRIAL_PRODUCT => true,
        _ => return Err("This key unlocks a different product.".into()),
    };
    // A signature covers what the payload says, not whether it makes sense. A
    // bought key carrying trial terms, or a test key carrying none (or both), is
    // a key I mis-issued — refuse it rather than guess which half to believe.
    let terms = usize::from(lic.expires.is_some()) + usize::from(lic.days.is_some());
    if trial != (terms == 1) {
        return Err(bad());
    }
    if let Some(until) = &lic.expires {
        if !looks_like_a_date(until) {
            return Err(bad());
        }
        // Both sides are YYYY-MM-DD, which sorts the way dates do.
        if chrono_date().as_str() > until.as_str() {
            return Err(format!("This test key stopped working on {until}."));
        }
    }
    Ok(lic)
}

/// One-time owner setup: create a keypair, write the private seed (base64) to
/// the signing-key path, and return the public key as hex — to be baked into
/// `OFFICIAL_KEYS` in a rebuilt binary. Refuses to overwrite an existing key.
pub fn generate_keypair() -> Result<String, String> {
    let path = signing_key_path();
    if path.exists() {
        return Err(format!(
            "A signing key already exists at {} — refusing to overwrite it.",
            path.display()
        ));
    }
    use rand::RngCore;
    let mut seed = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut seed);
    let sk = SigningKey::from_bytes(&seed);
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    std::fs::write(&path, STANDARD.encode(seed)).map_err(|e| e.to_string())?;
    let hex: String = sk
        .verifying_key()
        .as_bytes()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    Ok(hex)
}

/* ---- tests -------------------------------------------------------------- */

#[cfg(test)]
mod tests {
    use super::*;

    fn test_keys() -> (SigningKey, Vec<(u32, [u8; 32])>) {
        let sk = SigningKey::from_bytes(&[7u8; 32]);
        let keys = vec![(1u32, sk.verifying_key().to_bytes())];
        (sk, keys)
    }

    fn envelope(sk: &SigningKey, key_id: u32, inner: &str) -> SignedEnvelope {
        SignedEnvelope {
            version: 1,
            key_id,
            payload: STANDARD.encode(inner.as_bytes()),
            sig: STANDARD.encode(sk.sign(inner.as_bytes()).to_bytes()),
        }
    }

    #[test]
    fn envelope_roundtrip() {
        let (sk, keys) = test_keys();
        let inner = r#"{"micollTemplate":1,"artist":{"name":"A"},"verified":true}"#;
        let env = envelope(&sk, 1, inner);
        assert_eq!(env.verify_with(&keys).unwrap(), inner);
        // And it survives JSON serialization (the on-disk trip).
        let disk = serde_json::to_string(&env).unwrap();
        let back = detect_envelope(&disk).unwrap().unwrap();
        assert_eq!(back.verify_with(&keys).unwrap(), inner);
    }

    #[test]
    fn tampered_payload_rejected() {
        let (sk, keys) = test_keys();
        let mut env = envelope(&sk, 1, r#"{"micollTemplate":1,"verified":true}"#);
        env.payload = STANDARD.encode(br#"{"micollTemplate":1,"verified":true }"#);
        assert!(env.verify_with(&keys).is_err());
    }

    #[test]
    fn wrong_key_rejected() {
        let (sk, _) = test_keys();
        let other = SigningKey::from_bytes(&[9u8; 32]);
        let keys = vec![(1u32, other.verifying_key().to_bytes())];
        let env = envelope(&sk, 1, "x");
        assert!(env.verify_with(&keys).is_err());
        // Unknown keyId is rejected too (not treated as "any key").
        let env2 = envelope(&sk, 42, "x");
        assert!(env2.verify_with(&keys).is_err());
    }

    #[test]
    fn plain_template_is_not_an_envelope() {
        assert!(detect_envelope(r#"{"micollTemplate":1,"artist":{"name":"A"}}"#)
            .unwrap()
            .is_none());
        // Claims to be signed but is malformed → hard error, not silent fallback.
        assert!(detect_envelope(r#"{"micollSigned":1}"#).is_err());
    }

    #[test]
    fn theme_key_roundtrip_and_tamper() {
        let (sk, keys) = test_keys();
        let lic = ThemeLicense {
            product: THEME_PRODUCT.into(),
            buyer: "Alice".into(),
            issued: "2026-07-15".into(),
            expires: None,
            days: None,
        };
        let payload = serde_json::to_vec(&lic).unwrap();
        let sig = sk.sign(&payload);
        let token = format!(
            "{THEME_KEY_PREFIX}{}.{}",
            STANDARD.encode(&payload),
            STANDARD.encode(sig.to_bytes())
        );
        let got = verify_theme_key_with(&token, &keys, &[]).unwrap();
        assert_eq!(got.buyer, "Alice");
        // Whitespace from sloppy copy/paste is tolerated.
        assert!(verify_theme_key_with(&format!("  {token}\n"), &keys, &[]).is_ok());
        // Forged payload with the real signature fails.
        let forged = format!(
            "{THEME_KEY_PREFIX}{}.{}",
            STANDARD.encode(br#"{"product":"themes","buyer":"Eve","issued":"2026-01-01"}"#),
            STANDARD.encode(sig.to_bytes())
        );
        assert!(verify_theme_key_with(&forged, &keys, &[]).is_err());
        assert!(verify_theme_key_with("MICOLL-THEMES.garbage", &keys, &[]).is_err());
    }

    /// A key that verifies perfectly is still refused once its fingerprint is on
    /// the list — and the neighbouring key issued to someone else is not, which
    /// is the property that makes revocation safe to ship.
    /// A test key's date is the whole point of it, so the three ways it can be
    /// wrong are worth stating: past, future, and terms that contradict the
    /// product it claims to be.
    #[test]
    fn a_trial_key_expires_and_a_contradictory_one_is_refused() {
        let (sk, keys) = test_keys();
        let sign = |lic: &ThemeLicense| {
            let payload = serde_json::to_vec(lic).unwrap();
            let sig = sk.sign(&payload);
            format!(
                "{THEME_KEY_PREFIX}{}.{}",
                STANDARD.encode(&payload),
                STANDARD.encode(sig.to_bytes())
            )
        };
        let trial = |expires: Option<&str>, days: Option<u32>| ThemeLicense {
            product: THEME_TRIAL_PRODUCT.into(),
            buyer: "Tester".into(),
            issued: "2026-01-01".into(),
            expires: expires.map(str::to_string),
            days,
        };

        // Still inside its window.
        let live = sign(&trial(Some("2999-12-31"), None));
        let got = verify_theme_key_with(&live, &keys, &[]).unwrap();
        assert_eq!(got.product, THEME_TRIAL_PRODUCT);
        assert_eq!(got.expires.as_deref(), Some("2999-12-31"));

        // Past its date — and the message says which day it was.
        let dead = sign(&trial(Some("2020-01-01"), None));
        let err = verify_theme_key_with(&dead, &keys, &[]).unwrap_err();
        assert!(err.contains("2020-01-01"), "got {err}");

        // A run of days passes verification here: only the library that took the
        // key knows when that was (see verify_theme_license).
        let by_days = sign(&trial(None, Some(30)));
        assert_eq!(verify_theme_key_with(&by_days, &keys, &[]).unwrap().days, Some(30));

        // Terms that contradict the product, both ways round.
        let neither = sign(&trial(None, None));
        assert!(verify_theme_key_with(&neither, &keys, &[]).is_err());
        let both = sign(&trial(Some("2999-12-31"), Some(30)));
        assert!(verify_theme_key_with(&both, &keys, &[]).is_err());
        let bought_with_an_end = sign(&ThemeLicense {
            product: THEME_PRODUCT.into(),
            buyer: "Alice".into(),
            issued: "2026-01-01".into(),
            expires: Some("2999-12-31".into()),
            days: None,
        });
        assert!(verify_theme_key_with(&bought_with_an_end, &keys, &[]).is_err());
    }

    #[test]
    fn a_revoked_key_is_refused_and_others_are_not() {
        let (sk, keys) = test_keys();
        let key_for = |buyer: &str| {
            let lic = ThemeLicense {
                product: THEME_PRODUCT.into(),
                buyer: buyer.into(),
                issued: "2026-08-15".into(),
                expires: None,
                days: None,
            };
            let payload = serde_json::to_vec(&lic).unwrap();
            let sig = sk.sign(&payload);
            (
                format!(
                    "{THEME_KEY_PREFIX}{}.{}",
                    STANDARD.encode(&payload),
                    STANDARD.encode(sig.to_bytes())
                ),
                key_fingerprint(&sig.to_bytes()),
            )
        };
        let (leaked, leaked_fp) = key_for("Eve");
        let (honest, honest_fp) = key_for("Alice");
        assert_ne!(leaked_fp, honest_fp);
        assert_eq!(theme_key_fingerprint(&leaked).unwrap(), leaked_fp);

        // Before revocation both work.
        assert!(verify_theme_key_with(&leaked, &keys, &[]).is_ok());
        // After, only the leaked one is refused — and it says so.
        let revoked = [leaked_fp.as_str()];
        let err = match verify_theme_key_with(&leaked, &keys, &revoked) {
            Ok(_) => panic!("a revoked key must not verify"),
            Err(e) => e,
        };
        assert!(err.contains("revoked"), "{err}");
        assert!(err.contains(&leaked_fp), "the message must name the key: {err}");
        assert!(verify_theme_key_with(&honest, &keys, &revoked).is_ok());

        // The list tolerates the hand-typed forms it will actually contain.
        let sloppy = [format!("  {}  ", leaked_fp.to_uppercase())];
        let sloppy: Vec<&str> = sloppy.iter().map(|s| s.as_str()).collect();
        assert!(verify_theme_key_with(&leaked, &keys, &sloppy).is_err());
    }

    /// The shipped list must never contain a stray entry — one wrong line here
    /// locks a paying customer out of the build.
    #[test]
    fn the_shipped_revocation_list_is_well_formed() {
        for fp in REVOKED_SIGS {
            let f = fp.trim();
            assert_eq!(f.len(), 16, "fingerprint must be 16 hex chars: {fp:?}");
            assert!(
                f.chars().all(|c| c.is_ascii_hexdigit()),
                "not hex: {fp:?}"
            );
        }
    }

    #[test]
    fn date_helper_is_sane() {
        let d = chrono_date();
        assert_eq!(d.len(), 10);
        assert!(d.starts_with("20"));
    }

    /// Dev-machine diagnostic: when the owner's key file is present, it must
    /// derive exactly the public key baked into this build (catches an openssl
    /// seed-extraction mishap immediately). Skips silently elsewhere.
    #[test]
    fn owner_key_matches_build_if_present() {
        if !signing_key_path().exists() {
            return;
        }
        let (_, id) = own_key_id().expect("installed signing key must match OFFICIAL_KEYS");
        assert_eq!(id, 1);
    }
}
