//! Updates for portable copies.
//! The normal update runs the installer, which puts a second, normal MiColl into
//! %LOCALAPPDATA% and starts that one (with the library from AppData). A portable
//! copy has to update itself instead: download the portable zip of the new release,
//! check its signature with the updater key, swap MiColl.exe in its own folder.

use std::io::{Cursor, Read};
use std::path::Path;

use base64::{engine::general_purpose::STANDARD, Engine as _};

const RELEASES: &str = "https://github.com/araxos/MiColl/releases/download";

fn map_err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

fn fetch(url: &str) -> Result<Vec<u8>, String> {
    let resp = ureq::get(url)
        .timeout(std::time::Duration::from_secs(10 * 60))
        .call()
        .map_err(|e| format!("download failed: {e}"))?;
    let mut buf = Vec::new();
    resp.into_reader()
        .read_to_end(&mut buf)
        .map_err(|e| format!("download failed: {e}"))?;
    Ok(buf)
}

/// Check the file against the updater's public key (the same key the installer update
/// uses, from tauri.conf.json). Both the key and the .sig file are base64 of minisign text.
fn verify(data: &[u8], sig_b64: &str) -> Result<(), String> {
    let conf: serde_json::Value =
        serde_json::from_str(include_str!("../tauri.conf.json")).map_err(map_err)?;
    let key_b64 = conf["plugins"]["updater"]["pubkey"]
        .as_str()
        .ok_or("no updater key in tauri.conf.json")?;
    let decode = |b64: &str| -> Result<String, String> {
        let bytes = STANDARD.decode(b64.trim()).map_err(map_err)?;
        String::from_utf8(bytes).map_err(map_err)
    };
    let key = minisign_verify::PublicKey::decode(&decode(key_b64)?).map_err(map_err)?;
    let sig = minisign_verify::Signature::decode(&decode(sig_b64)?).map_err(map_err)?;
    key.verify(data, &sig, false)
        .map_err(|_| "The download's signature doesn't match, so it wasn't used.".to_string())
}

/// Download + check the new version and put its MiColl.exe in place of this one.
/// The running exe can't be overwritten on Windows, but it can be renamed:
/// MiColl.exe -> MiColl.exe.old, new file -> MiColl.exe. The .old goes on the next start.
pub fn swap_in(exe: &Path, version: &str) -> Result<(), String> {
    let name = format!("MiColl_{version}_x64-portable.zip");
    let zip = fetch(&format!("{RELEASES}/v{version}/{name}"))?;
    let sig = String::from_utf8(fetch(&format!("{RELEASES}/v{version}/{name}.sig"))?)
        .map_err(map_err)?;
    verify(&zip, &sig)?;
    install_zip(exe, zip)
}

/// Take MiColl.exe out of the (already checked) zip and swap it in.
fn install_zip(exe: &Path, zip: Vec<u8>) -> Result<(), String> {
    let mut archive = zip::ZipArchive::new(Cursor::new(zip)).map_err(map_err)?;
    let mut new_exe = Vec::new();
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(map_err)?;
        let entry_name = entry.name().replace('\\', "/").to_ascii_lowercase();
        if entry_name.ends_with("/micoll.exe") || entry_name == "micoll.exe" {
            entry.read_to_end(&mut new_exe).map_err(map_err)?;
            break;
        }
    }
    if new_exe.is_empty() {
        return Err("The download has no MiColl.exe.".into());
    }

    let fresh = exe.with_extension("exe.new");
    let old = exe.with_extension("exe.old");
    std::fs::write(&fresh, &new_exe).map_err(|e| format!("couldn't write the new version: {e}"))?;
    let _ = std::fs::remove_file(&old);
    std::fs::rename(exe, &old).map_err(|e| format!("couldn't move the old version aside: {e}"))?;
    if let Err(e) = std::fs::rename(&fresh, exe) {
        // put the old one back so the copy still starts
        let _ = std::fs::rename(&old, exe);
        return Err(format!("couldn't put the new version in place: {e}"));
    }
    Ok(())
}

/// Remove the MiColl.exe.old a portable update left behind.
pub fn clean_up_old(exe: &Path) {
    let _ = std::fs::remove_file(exe.with_extension("exe.old"));
    let _ = std::fs::remove_file(exe.with_extension("exe.new"));
}


#[cfg(test)]
mod tests {
    use super::install_zip;
    use std::io::Write;

    fn zip_with(name: &str, data: &[u8]) -> Vec<u8> {
        let mut buf = std::io::Cursor::new(Vec::new());
        let mut w = zip::ZipWriter::new(&mut buf);
        w.start_file(name, zip::write::SimpleFileOptions::default()).unwrap();
        w.write_all(data).unwrap();
        w.finish().unwrap();
        buf.into_inner()
    }

    #[test]
    fn the_new_exe_replaces_the_old_one() {
        let dir = std::env::temp_dir().join(format!("micoll_portable_upd_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let exe = dir.join("MiColl.exe");
        std::fs::write(&exe, b"old version").unwrap();

        install_zip(&exe, zip_with("MiColl/MiColl.exe", b"new version")).unwrap();

        assert_eq!(std::fs::read(&exe).unwrap(), b"new version");
        assert_eq!(std::fs::read(exe.with_extension("exe.old")).unwrap(), b"old version");
        super::clean_up_old(&exe);
        assert!(!exe.with_extension("exe.old").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_zip_without_the_exe_changes_nothing() {
        let dir = std::env::temp_dir().join(format!("micoll_portable_upd2_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let exe = dir.join("MiColl.exe");
        std::fs::write(&exe, b"old version").unwrap();

        assert!(install_zip(&exe, zip_with("readme.txt", b"hi")).is_err());
        assert_eq!(std::fs::read(&exe).unwrap(), b"old version");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
