//! File encryption for MiColl.
//!
//! One random 32-byte data key (DEK) encrypts all media files. The DEK itself is
//! encrypted with a key from the user's password (and separately from a recovery code),
//! so changing the password only re-wraps the DEK, not the files.
//!
//! Cipher: XChaCha20-Poly1305 (random 24-byte nonce). KDF: Argon2id.
//! Encrypted files start with "MICOLLE1" so we can tell if a file is encrypted.

use argon2::Argon2;
use chacha20poly1305::aead::{Aead, KeyInit};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use rand::RngCore;
use std::io::Write;
use std::path::Path;
use zeroize::Zeroize;

/// Header of encrypted files (format v1).
pub const MAGIC: &[u8; 8] = b"MICOLLE1";
const NONCE_LEN: usize = 24;
const TAG_LEN: usize = 16;
/// Known text sealed with the DEK, used to detect a wrong key on unlock.
const VERIFY_PLAINTEXT: &[u8] = b"micoll-encryption-ok";

fn rand_fill(buf: &mut [u8]) {
    rand::rngs::OsRng.fill_bytes(buf);
}

/// 32-byte data key, wiped from memory on drop.
pub struct Dek([u8; 32]);

impl Drop for Dek {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}

impl Dek {
    pub fn from_bytes(b: [u8; 32]) -> Self {
        Dek(b)
    }
    /// Copy of the raw key bytes.
    pub fn raw(&self) -> [u8; 32] {
        self.0
    }
    pub fn encrypt_bytes(&self, data: &[u8]) -> Vec<u8> {
        seal(&self.0, data)
    }
    pub fn decrypt_bytes(&self, blob: &[u8]) -> Result<Vec<u8>, String> {
        open(&self.0, blob)
    }
}

/// True if the bytes start with our header.
pub fn is_encrypted(b: &[u8]) -> bool {
    b.len() >= MAGIC.len() && &b[..MAGIC.len()] == MAGIC
}

/// Check if a file is encrypted by only reading its first bytes.
pub fn file_is_encrypted(path: &Path) -> bool {
    use std::io::Read;
    let mut buf = [0u8; 8];
    std::fs::File::open(path)
        .and_then(|mut f| f.read_exact(&mut buf).map(|_| buf))
        .map(|b| &b == MAGIC)
        .unwrap_or(false)
}

/// Encrypt data with key -> MAGIC | nonce | ciphertext+tag.
fn seal(key: &[u8; 32], data: &[u8]) -> Vec<u8> {
    let cipher = XChaCha20Poly1305::new_from_slice(key).expect("32-byte key");
    let mut nonce = [0u8; NONCE_LEN];
    rand_fill(&mut nonce);
    let ct = cipher
        .encrypt(XNonce::from_slice(&nonce), data)
        .expect("aead encrypt");
    let mut out = Vec::with_capacity(MAGIC.len() + NONCE_LEN + ct.len());
    out.extend_from_slice(MAGIC);
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&ct);
    out
}

/// Opposite of seal.
fn open(key: &[u8; 32], blob: &[u8]) -> Result<Vec<u8>, String> {
    if !is_encrypted(blob) {
        return Err("not MiColl-encrypted".into());
    }
    if blob.len() < MAGIC.len() + NONCE_LEN + TAG_LEN {
        return Err("encrypted file is truncated".into());
    }
    let nonce = &blob[MAGIC.len()..MAGIC.len() + NONCE_LEN];
    let ct = &blob[MAGIC.len() + NONCE_LEN..];
    let cipher = XChaCha20Poly1305::new_from_slice(key).expect("32-byte key");
    cipher
        .decrypt(XNonce::from_slice(nonce), ct)
        .map_err(|_| "decryption failed (wrong key or corrupted file)".into())
}

/* ---- key derivation + DEK wrapping ----------------------------------- */

/// Make a 32-byte key from a secret (password / recovery code).
pub fn derive_kek(secret: &str, salt: &[u8]) -> [u8; 32] {
    let mut out = [0u8; 32];
    Argon2::default()
        .hash_password_into(secret.as_bytes(), salt, &mut out)
        .expect("argon2 derive");
    out
}

/// New random salt for Argon2 (16 bytes).
pub fn gen_salt() -> Vec<u8> {
    let mut s = vec![0u8; 16];
    rand_fill(&mut s);
    s
}

/// New random data key.
pub fn generate_dek() -> Dek {
    let mut b = [0u8; 32];
    rand_fill(&mut b);
    Dek(b)
}

/// Encrypt the DEK with a KEK -> blob to save in settings.
pub fn wrap_dek(kek: &[u8; 32], dek: &Dek) -> Vec<u8> {
    seal(kek, &dek.0)
}

/// Decrypt the DEK from its blob (fails with a wrong secret).
pub fn unwrap_dek(kek: &[u8; 32], blob: &[u8]) -> Result<Dek, String> {
    let bytes = open(kek, blob)?;
    if bytes.len() != 32 {
        return Err("unwrapped key has wrong length".into());
    }
    let mut k = [0u8; 32];
    k.copy_from_slice(&bytes);
    Ok(Dek(k))
}

/// Verifier blob to save next to the wrapped DEK.
pub fn make_verifier(dek: &Dek) -> Vec<u8> {
    dek.encrypt_bytes(VERIFY_PLAINTEXT)
}

/// Check a DEK against the saved verifier.
pub fn check_verifier(dek: &Dek, verifier: &[u8]) -> bool {
    dek.decrypt_bytes(verifier).map(|p| p == VERIFY_PLAINTEXT).unwrap_or(false)
}

/* ---- file helpers ---------------------------------------------------- */

/// Read a file and decrypt it if it has the header.
#[allow(dead_code)] // used by the video streaming protocol (M6)
pub fn read_plaintext(dek: &Dek, path: &Path) -> Result<Vec<u8>, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("read {}: {e}", path.display()))?;
    if is_encrypted(&bytes) {
        dek.decrypt_bytes(&bytes)
    } else {
        Ok(bytes)
    }
}

/// Write safely: temp file in the same folder -> fsync -> rename.
pub fn atomic_write(path: &Path, data: &[u8]) -> Result<(), String> {
    let dir = path.parent().ok_or("path has no parent")?;
    let mut nonce = [0u8; 8];
    rand_fill(&mut nonce);
    let tmp = dir.join(format!(".micoll-tmp-{}", u64::from_le_bytes(nonce)));
    {
        let mut f = std::fs::File::create(&tmp).map_err(|e| format!("create temp: {e}"))?;
        f.write_all(data).map_err(|e| format!("write temp: {e}"))?;
        f.sync_all().map_err(|e| format!("fsync temp: {e}"))?;
    }
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("rename temp: {e}")
    })?;
    Ok(())
}

/// Encrypt a file in place. false = already encrypted.
pub fn encrypt_file_in_place(dek: &Dek, path: &Path) -> Result<bool, String> {
    if file_is_encrypted(path) {
        return Ok(false);
    }
    let bytes = std::fs::read(path).map_err(|e| format!("read {}: {e}", path.display()))?;
    atomic_write(path, &dek.encrypt_bytes(&bytes))?;
    Ok(true)
}

/// Decrypt a file in place. false = wasn't encrypted.
pub fn decrypt_file_in_place(dek: &Dek, path: &Path) -> Result<bool, String> {
    if !file_is_encrypted(path) {
        return Ok(false);
    }
    let bytes = std::fs::read(path).map_err(|e| format!("read {}: {e}", path.display()))?;
    let plain = dek.decrypt_bytes(&bytes)?;
    atomic_write(path, &plain)?;
    Ok(true)
}

/// Readable recovery code like A1B2-C3D4-... (128 bits).
pub fn gen_recovery_code() -> String {
    let mut b = [0u8; 16];
    rand_fill(&mut b);
    let hex: String = b.iter().map(|x| format!("{x:02X}")).collect();
    hex.as_bytes()
        .chunks(4)
        .map(|c| std::str::from_utf8(c).unwrap())
        .collect::<Vec<_>>()
        .join("-")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bytes_round_trip() {
        let dek = generate_dek();
        let data = b"hello \x00\x01\x02 world";
        let blob = dek.encrypt_bytes(data);
        assert!(is_encrypted(&blob));
        assert_ne!(&blob[..], &data[..]);
        assert_eq!(dek.decrypt_bytes(&blob).unwrap(), data);
    }

    #[test]
    fn wrong_key_fails() {
        let a = generate_dek();
        let b = generate_dek();
        let blob = a.encrypt_bytes(b"secret");
        assert!(b.decrypt_bytes(&blob).is_err());
    }

    #[test]
    fn wrap_unwrap_with_password_and_recovery() {
        let dek = generate_dek();
        let pw_salt = gen_salt();
        let rec_salt = gen_salt();
        let kek_pw = derive_kek("hunter2", &pw_salt);
        let kek_rec = derive_kek("A1B2-C3D4-E5F6-7890", &rec_salt);
        let wrapped_pw = wrap_dek(&kek_pw, &dek);
        let wrapped_rec = wrap_dek(&kek_rec, &dek);
        let verifier = make_verifier(&dek);

        let from_pw = unwrap_dek(&kek_pw, &wrapped_pw).unwrap();
        let from_rec = unwrap_dek(&kek_rec, &wrapped_rec).unwrap();
        assert_eq!(from_pw.raw(), dek.raw());
        assert_eq!(from_rec.raw(), dek.raw());
        assert!(check_verifier(&from_pw, &verifier));
        // wrong password -> unwrap fails
        let bad = derive_kek("nope", &pw_salt);
        assert!(unwrap_dek(&bad, &wrapped_pw).is_err());
    }

    #[test]
    fn derive_is_deterministic_and_salted() {
        let salt = gen_salt();
        assert_eq!(derive_kek("pw", &salt), derive_kek("pw", &salt));
        assert_ne!(derive_kek("pw", &salt), derive_kek("pw", &gen_salt()));
    }

    #[test]
    fn file_in_place_round_trip_and_skip() {
        let dir = std::env::temp_dir().join(format!("micoll_enc_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("pic.jpg");
        std::fs::write(&path, b"\xff\xd8\xff original bytes").unwrap();
        let dek = generate_dek();

        assert!(encrypt_file_in_place(&dek, &path).unwrap()); // encrypted
        assert!(is_encrypted(&std::fs::read(&path).unwrap()));
        assert!(!encrypt_file_in_place(&dek, &path).unwrap()); // already → skip
        assert_eq!(read_plaintext(&dek, &path).unwrap(), b"\xff\xd8\xff original bytes");

        assert!(decrypt_file_in_place(&dek, &path).unwrap()); // decrypted
        assert_eq!(std::fs::read(&path).unwrap(), b"\xff\xd8\xff original bytes");
        assert!(!decrypt_file_in_place(&dek, &path).unwrap()); // already plain → skip
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn recovery_code_shape() {
        let c = gen_recovery_code();
        assert_eq!(c.len(), 32 + 7); // 32 hex chars + 7 dashes
        assert_eq!(c.matches('-').count(), 7);
    }
}
