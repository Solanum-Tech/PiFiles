//! PiFiles' encrypted data files ("PFV1" vault format).
//!
//! Personal data PiFiles keeps (face embeddings and thumbnails, people's names, the learned
//! face model, tags, the photo library index, approved custom actions) is stored encrypted:
//!
//!   "PFV1" magic (4 bytes) + Windows DPAPI blob
//!
//! DPAPI encrypts with a key derived from the user's Windows login (AES-256 + HMAC), so:
//!   * the files are unreadable to other users and on other PCs (a copied file is useless);
//!   * any modification is detected - a tampered file fails to decrypt and is treated as
//!     missing (the data is rebuilt) instead of being trusted;
//!   * an app-specific entropy value means other programs can't decrypt them by accident.
//! Older plaintext files are read once and re-written encrypted (transparent migration).
//! On macOS/Linux files are written with owner-only permissions (0600) until a Keychain /
//! Secret Service backend is added.

use std::path::Path;

const MAGIC: &[u8; 4] = b"PFV1";
const ENTROPY: &[u8] = b"PiFiles vault v1 - com.pifiles.app";

#[cfg(windows)]
fn protect(plain: &[u8]) -> Option<Vec<u8>> {
    use windows::Win32::Foundation::{LocalFree, HLOCAL};
    use windows::Win32::Security::Cryptography::{CryptProtectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB};
    unsafe {
        let input = CRYPT_INTEGER_BLOB { cbData: plain.len() as u32, pbData: plain.as_ptr() as *mut u8 };
        let entropy = CRYPT_INTEGER_BLOB { cbData: ENTROPY.len() as u32, pbData: ENTROPY.as_ptr() as *mut u8 };
        let mut out = CRYPT_INTEGER_BLOB::default();
        CryptProtectData(&input, windows::core::w!("PiFiles"), Some(&entropy), None, None, CRYPTPROTECT_UI_FORBIDDEN, &mut out).ok()?;
        let v = std::slice::from_raw_parts(out.pbData, out.cbData as usize).to_vec();
        let _ = LocalFree(Some(HLOCAL(out.pbData as _)));
        Some(v)
    }
}

#[cfg(windows)]
fn unprotect(blob: &[u8]) -> Option<Vec<u8>> {
    use windows::Win32::Foundation::{LocalFree, HLOCAL};
    use windows::Win32::Security::Cryptography::{CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB};
    unsafe {
        let input = CRYPT_INTEGER_BLOB { cbData: blob.len() as u32, pbData: blob.as_ptr() as *mut u8 };
        let entropy = CRYPT_INTEGER_BLOB { cbData: ENTROPY.len() as u32, pbData: ENTROPY.as_ptr() as *mut u8 };
        let mut out = CRYPT_INTEGER_BLOB::default();
        CryptUnprotectData(&input, None, Some(&entropy), None, None, CRYPTPROTECT_UI_FORBIDDEN, &mut out).ok()?;
        let v = std::slice::from_raw_parts(out.pbData, out.cbData as usize).to_vec();
        let _ = LocalFree(Some(HLOCAL(out.pbData as _)));
        Some(v)
    }
}

#[cfg(not(windows))]
fn protect(plain: &[u8]) -> Option<Vec<u8>> {
    Some(plain.to_vec())
}
#[cfg(not(windows))]
fn unprotect(blob: &[u8]) -> Option<Vec<u8>> {
    Some(blob.to_vec())
}

/// Encrypts `plain` into the vault format.
pub fn seal(plain: &[u8]) -> Option<Vec<u8>> {
    let mut out = MAGIC.to_vec();
    out.extend(protect(plain)?);
    Some(out)
}

/// Decrypts vault data. Legacy plaintext (no magic) is returned as-is so it can be migrated;
/// tampered or foreign vault data returns None.
pub fn open(data: &[u8]) -> Option<Vec<u8>> {
    match data.strip_prefix(MAGIC.as_slice()) {
        Some(blob) => unprotect(blob),
        None => Some(data.to_vec()),
    }
}

/// Reads and decrypts a vault file. A plaintext file from an older version is re-written
/// encrypted on the spot.
pub fn read(path: &Path) -> Option<Vec<u8>> {
    let data = std::fs::read(path).ok()?;
    let plain = open(&data);
    if plain.is_none() {
        eprintln!("[vault] {} failed integrity check - ignoring it", path.display());
    }
    if plain.is_some() && !data.starts_with(MAGIC) {
        let _ = write(path, plain.as_deref().unwrap_or_default());
    }
    plain
}

/// Encrypts and writes atomically (temp file + rename).
pub fn write(path: &Path, plain: &[u8]) -> std::io::Result<()> {
    let sealed = seal(plain).ok_or_else(|| std::io::Error::other("encryption failed"))?;
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let tmp = path.with_extension("vtmp");
    std::fs::write(&tmp, &sealed)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600));
    }
    if std::fs::rename(&tmp, path).is_err() {
        std::fs::copy(&tmp, path)?;
        let _ = std::fs::remove_file(&tmp);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn roundtrip_tamper_and_migration() {
        let sealed = super::seal(b"{\"name\":\"Anna\"}").unwrap();
        assert!(sealed.starts_with(b"PFV1"));
        assert!(!sealed.windows(4).any(|w| w == b"Anna"), "plaintext must not be visible");
        assert_eq!(super::open(&sealed).unwrap(), b"{\"name\":\"Anna\"}");
        #[cfg(windows)]
        {
            let mut bad = sealed.clone();
            let n = bad.len();
            bad[n - 5] ^= 0x55;
            assert!(super::open(&bad).is_none(), "tampering must be detected");
        }
        assert_eq!(super::open(b"{\"legacy\":1}").unwrap(), b"{\"legacy\":1}");
    }
}
