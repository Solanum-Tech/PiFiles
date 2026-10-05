//! Archive browsing: ZIP (incl. AES / ZipCrypto), 7-Zip (incl. AES-256), RAR (UnRAR), TAR and
//! gzip / bzip2 / xz (single files or compressed tarballs).
//!
//! Password handling: listing or extraction that needs a password fails with
//! `PASSWORD_REQUIRED` (none given) or `WRONG_PASSWORD` (the given one was rejected), so the UI
//! can ask the user and retry.

use serde::Serialize;
use std::fs::File;
use std::io::{BufReader, Read, Write};
use std::path::{Component, Path, PathBuf};

pub const PASSWORD_REQUIRED: &str = "PASSWORD_REQUIRED";
pub const WRONG_PASSWORD: &str = "WRONG_PASSWORD";
const MAX_ENTRIES: usize = 50_000;

#[derive(Serialize, Clone, Debug)]
pub struct Entry {
    pub name: String,
    pub size: u64,
    pub is_dir: bool,
    pub encrypted: bool,
}

#[derive(Serialize, Debug)]
pub struct Listing {
    pub format: String,
    pub entries: Vec<Entry>,
    pub encrypted: bool,
    pub truncated: bool,
}

#[derive(Clone, Copy, PartialEq, Debug)]
enum Kind {
    Zip,
    SevenZ,
    Rar,
    Tar,
    TarGz,
    TarBz2,
    TarXz,
    Gz,
    Bz2,
    Xz,
}

fn kind_of(path: &Path) -> Option<Kind> {
    let name = path.file_name()?.to_string_lossy().to_lowercase();
    let by_name = if name.ends_with(".tar.gz") || name.ends_with(".tgz") {
        Some(Kind::TarGz)
    } else if name.ends_with(".tar.bz2") || name.ends_with(".tbz2") || name.ends_with(".tbz") {
        Some(Kind::TarBz2)
    } else if name.ends_with(".tar.xz") || name.ends_with(".txz") {
        Some(Kind::TarXz)
    } else {
        match name.rsplit('.').next()? {
            "zip" | "jar" | "apk" | "xpi" | "epub" | "cbz" | "war" | "ear" | "appx" | "nupkg" | "vsix" => Some(Kind::Zip),
            "7z" | "cb7" => Some(Kind::SevenZ),
            "rar" | "cbr" => Some(Kind::Rar),
            "tar" | "cbt" => Some(Kind::Tar),
            "gz" => Some(Kind::Gz),
            "bz2" => Some(Kind::Bz2),
            "xz" => Some(Kind::Xz),
            _ => None,
        }
    };
    // Trust the file's magic bytes over its extension.
    let mut magic = [0u8; 8];
    let n = File::open(path).and_then(|mut f| f.read(&mut magic)).unwrap_or(0);
    let m = &magic[..n];
    let by_magic = if m.starts_with(b"PK\x03\x04") || m.starts_with(b"PK\x05\x06") {
        Some(Kind::Zip)
    } else if m.starts_with(&[0x37, 0x7A, 0xBC, 0xAF, 0x27, 0x1C]) {
        Some(Kind::SevenZ)
    } else if m.starts_with(b"Rar!\x1A\x07") {
        Some(Kind::Rar)
    } else {
        None
    };
    by_magic.or(by_name)
}

fn format_name(k: Kind) -> &'static str {
    match k {
        Kind::Zip => "ZIP",
        Kind::SevenZ => "7-Zip",
        Kind::Rar => "RAR",
        Kind::Tar => "TAR",
        Kind::TarGz => "TAR.GZ",
        Kind::TarBz2 => "TAR.BZ2",
        Kind::TarXz => "TAR.XZ",
        Kind::Gz => "GZip",
        Kind::Bz2 => "BZip2",
        Kind::Xz => "XZ",
    }
}

/// Only plain relative components survive, so entries can never escape the destination ("zip slip").
fn safe_relative(name: &str) -> Option<PathBuf> {
    let mut out = PathBuf::new();
    for c in Path::new(&name.replace('\\', "/")).components() {
        match c {
            Component::Normal(p) => out.push(p),
            Component::CurDir => {}
            _ => return None,
        }
    }
    if out.as_os_str().is_empty() { None } else { Some(out) }
}

fn inner_name(path: &Path) -> String {
    path.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| "file".into())
}

fn compressed_reader(k: Kind, file: File) -> Box<dyn Read> {
    let r = BufReader::new(file);
    match k {
        Kind::TarGz | Kind::Gz => Box::new(flate2::read::MultiGzDecoder::new(r)),
        Kind::TarBz2 | Kind::Bz2 => Box::new(bzip2::read::MultiBzDecoder::new(r)),
        Kind::TarXz | Kind::Xz => Box::new(xz2::read::XzDecoder::new_multi_decoder(r)),
        _ => Box::new(r),
    }
}

fn sevenz_err(e: sevenz_rust2::Error, had_password: bool) -> String {
    match e {
        sevenz_rust2::Error::PasswordRequired => if had_password { WRONG_PASSWORD.into() } else { PASSWORD_REQUIRED.into() },
        sevenz_rust2::Error::MaybeBadPassword(_) => if had_password { WRONG_PASSWORD.into() } else { PASSWORD_REQUIRED.into() },
        other => other.to_string(),
    }
}

fn rar_err(e: unrar::error::UnrarError) -> String {
    use unrar::error::Code;
    match e.code {
        Code::MissingPassword => PASSWORD_REQUIRED.into(),
        Code::BadPassword => WRONG_PASSWORD.into(),
        _ => e.to_string(),
    }
}

// ---------- listing ----------

pub fn list(path: &Path, password: Option<&str>) -> Result<Listing, String> {
    let k = kind_of(path).ok_or("Not a supported archive")?;
    let mut entries = Vec::new();
    match k {
        Kind::Zip => {
            let mut z = zip::ZipArchive::new(BufReader::new(File::open(path).map_err(|e| e.to_string())?))
                .map_err(|e| e.to_string())?;
            let mut first_encrypted = None;
            for i in 0..z.len().min(MAX_ENTRIES) {
                let f = z.by_index_raw(i).map_err(|e| e.to_string())?;
                if f.encrypted() && first_encrypted.is_none() {
                    first_encrypted = Some(i);
                }
                entries.push(Entry { name: f.name().to_string(), size: f.size(), is_dir: f.is_dir(), encrypted: f.encrypted() });
            }
            // Names are readable without a password; if one was given, check it now.
            if let (Some(i), Some(pw)) = (first_encrypted, password) {
                match z.by_index_decrypt(i, pw.as_bytes()) {
                    Err(zip::result::ZipError::InvalidPassword) => return Err(WRONG_PASSWORD.into()),
                    Err(e) => return Err(e.to_string()),
                    Ok(mut f) => {
                        let mut probe = [0u8; 1];
                        f.read(&mut probe).map_err(|_| WRONG_PASSWORD.to_string())?;
                    }
                }
            }
        }
        Kind::SevenZ => {
            let pw = password.map(sevenz_rust2::Password::from).unwrap_or_else(sevenz_rust2::Password::empty);
            let r = sevenz_rust2::ArchiveReader::open(path, pw).map_err(|e| sevenz_err(e, password.is_some()))?;
            for f in r.archive().files.iter().take(MAX_ENTRIES) {
                entries.push(Entry { name: f.name().to_string(), size: f.size(), is_dir: f.is_directory(), encrypted: false });
            }
        }
        Kind::Rar => {
            let archive = match password {
                Some(pw) => unrar::Archive::with_password(path, pw),
                None => unrar::Archive::new(path),
            };
            for h in archive.open_for_listing().map_err(rar_err)? {
                let h = h.map_err(rar_err)?;
                entries.push(Entry {
                    name: h.filename.to_string_lossy().replace('\\', "/"),
                    size: h.unpacked_size,
                    is_dir: h.is_directory(),
                    encrypted: h.is_encrypted(),
                });
                if entries.len() >= MAX_ENTRIES {
                    break;
                }
            }
        }
        Kind::Tar | Kind::TarGz | Kind::TarBz2 | Kind::TarXz => {
            let mut t = tar::Archive::new(compressed_reader(k, File::open(path).map_err(|e| e.to_string())?));
            for e in t.entries().map_err(|e| e.to_string())? {
                let e = e.map_err(|e| e.to_string())?;
                let name = e.path().map_err(|e| e.to_string())?.to_string_lossy().to_string();
                entries.push(Entry { name, size: e.header().size().unwrap_or(0), is_dir: e.header().entry_type().is_dir(), encrypted: false });
                if entries.len() >= MAX_ENTRIES {
                    break;
                }
            }
        }
        Kind::Gz | Kind::Bz2 | Kind::Xz => {
            entries.push(Entry { name: inner_name(path), size: 0, is_dir: false, encrypted: false });
        }
    }
    let encrypted = entries.iter().any(|e| e.encrypted);
    let truncated = entries.len() >= MAX_ENTRIES;
    Ok(Listing { format: format_name(k).into(), entries, encrypted, truncated })
}

// ---------- extraction ----------

/// Extracts every entry (or only `only`) under `dest`. Returns the number of files written.
/// Which entries to extract (empty = all), and the archive folder they are extracted relative to.
struct Filter<'a> {
    only: &'a [String],
    base: &'a str,
}

impl Filter<'_> {
    fn wants(&self, name: &str) -> bool {
        let n = name.trim_end_matches('/');
        self.only.is_empty()
            || self.only.iter().any(|o| {
                let o = o.trim_end_matches('/');
                n == o || n.starts_with(&format!("{o}/"))
            })
    }
    /// A single file: stop reading the archive once it's out.
    fn single_file(&self) -> bool {
        self.only.len() == 1 && !self.only[0].ends_with('/')
    }
    fn relative<'n>(&self, name: &'n str) -> &'n str {
        let b = self.base.trim_matches('/');
        if b.is_empty() {
            return name;
        }
        name.strip_prefix(b).and_then(|r| r.strip_prefix('/')).unwrap_or(name)
    }
}

fn extract_into(path: &Path, dest: &Path, password: Option<&str>, filter: &Filter) -> Result<usize, String> {
    let k = kind_of(path).ok_or("Not a supported archive")?;
    let wanted = |name: &str| filter.wants(name);
    let mut written = 0usize;
    let mut write_entry = |name: &str, is_dir: bool, reader: &mut dyn Read| -> Result<(), String> {
        let Some(rel) = safe_relative(filter.relative(name)) else { return Ok(()) };
        if rel.as_os_str().is_empty() {
            return Ok(());
        }
        let target = dest.join(rel);
        if is_dir {
            std::fs::create_dir_all(&target).map_err(|e| e.to_string())?;
            return Ok(());
        }
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let mut out = File::create(&target).map_err(|e| e.to_string())?;
        std::io::copy(reader, &mut out).map_err(|e| {
            if password.is_some() { WRONG_PASSWORD.to_string() } else { e.to_string() }
        })?;
        out.flush().ok();
        written += 1;
        Ok(())
    };

    match k {
        Kind::Zip => {
            let mut z = zip::ZipArchive::new(BufReader::new(File::open(path).map_err(|e| e.to_string())?))
                .map_err(|e| e.to_string())?;
            for i in 0..z.len() {
                let (name, encrypted) = {
                    let f = z.by_index_raw(i).map_err(|e| e.to_string())?;
                    (f.name().to_string(), f.encrypted())
                };
                if !wanted(&name) {
                    continue;
                }
                let mut f = if encrypted {
                    let pw = password.ok_or(PASSWORD_REQUIRED)?;
                    z.by_index_decrypt(i, pw.as_bytes()).map_err(|e| match e {
                        zip::result::ZipError::InvalidPassword => WRONG_PASSWORD.to_string(),
                        e => e.to_string(),
                    })?
                } else {
                    z.by_index(i).map_err(|e| e.to_string())?
                };
                let is_dir = f.is_dir();
                write_entry(&name, is_dir, &mut f)?;
            }
        }
        Kind::SevenZ => {
            let pw = password.map(sevenz_rust2::Password::from).unwrap_or_else(sevenz_rust2::Password::empty);
            let mut r = sevenz_rust2::ArchiveReader::open(path, pw).map_err(|e| sevenz_err(e, password.is_some()))?;
            let mut err: Option<String> = None;
            r.for_each_entries(|entry, reader| {
                if !wanted(entry.name()) {
                    std::io::copy(reader, &mut std::io::sink())?; // solid blocks must be read through
                    return Ok(true);
                }
                if let Err(e) = write_entry(entry.name(), entry.is_directory(), reader) {
                    err = Some(e);
                    return Ok(false);
                }
                Ok(!filter.single_file())
            })
            .map_err(|e| sevenz_err(e, password.is_some()))?;
            if let Some(e) = err {
                return Err(e);
            }
        }
        Kind::Rar => {
            let archive = match password {
                Some(pw) => unrar::Archive::with_password(path, pw),
                None => unrar::Archive::new(path),
            };
            let mut cursor = archive.open_for_processing().map_err(rar_err)?;
            while let Some(header) = cursor.read_header().map_err(rar_err)? {
                let name = header.entry().filename.to_string_lossy().replace('\\', "/");
                let is_dir = header.entry().is_directory();
                cursor = if wanted(&name) {
                    if is_dir {
                        write_entry(&name, true, &mut std::io::empty())?;
                        header.skip().map_err(rar_err)?
                    } else {
                        let (data, next) = header.read().map_err(rar_err)?;
                        write_entry(&name, false, &mut data.as_slice())?;
                        next
                    }
                } else {
                    header.skip().map_err(rar_err)?
                };
            }
        }
        Kind::Tar | Kind::TarGz | Kind::TarBz2 | Kind::TarXz => {
            let mut t = tar::Archive::new(compressed_reader(k, File::open(path).map_err(|e| e.to_string())?));
            for e in t.entries().map_err(|e| e.to_string())? {
                let mut e = e.map_err(|e| e.to_string())?;
                let name = e.path().map_err(|e| e.to_string())?.to_string_lossy().to_string();
                if !wanted(&name) {
                    continue;
                }
                let is_dir = e.header().entry_type().is_dir();
                write_entry(&name, is_dir, &mut e)?;
            }
        }
        Kind::Gz | Kind::Bz2 | Kind::Xz => {
            let name = inner_name(path);
            if wanted(&name) {
                let mut r = compressed_reader(k, File::open(path).map_err(|e| e.to_string())?);
                write_entry(&name, false, &mut r)?;
            }
        }
    }
    Ok(written)
}

/// Extracts one entry to a private temp folder (for previewing) and returns its path.
pub fn extract_entry(path: &Path, entry: &str, password: Option<&str>) -> Result<PathBuf, String> {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    path.hash(&mut h);
    let dest = std::env::temp_dir().join("pifiles-archive-preview").join(format!("{:016x}", h.finish()));
    std::fs::create_dir_all(&dest).map_err(|e| e.to_string())?;
    let only = [entry.to_string()];
    let n = extract_into(path, &dest, password, &Filter { only: &only, base: "" })?;
    let rel = safe_relative(entry).ok_or("Invalid entry name")?;
    let out = dest.join(rel);
    if n == 0 || !out.exists() {
        return Err("Entry not found in archive".into());
    }
    Ok(out)
}

/// "Extract all": into a new folder next to the archive named after it (never overwrites a folder).
pub fn extract_all(path: &Path, password: Option<&str>) -> Result<(PathBuf, usize), String> {
    let parent = path.parent().ok_or("Archive has no parent folder")?;
    let mut stem = inner_name(path);
    if stem.to_lowercase().ends_with(".tar") {
        stem.truncate(stem.len() - 4);
    }
    let mut dest = parent.join(&stem);
    let mut i = 2;
    while dest.exists() {
        dest = parent.join(format!("{stem} ({i})"));
        i += 1;
    }
    std::fs::create_dir_all(&dest).map_err(|e| e.to_string())?;
    match extract_into(path, &dest, password, &Filter { only: &[], base: "" }) {
        Ok(n) => Ok((dest, n)),
        Err(e) => {
            let _ = std::fs::remove_dir_all(&dest);
            Err(e)
        }
    }
}

/// Extracts the chosen entries (files and/or folders) into `dest`. Paths are kept relative to
/// `base`, the archive folder being browsed, so extracting "photos/2024" from inside "photos"
/// creates "dest/2024". Existing files are kept: incoming ones get a free name.
pub fn extract_selected(path: &Path, entries: &[String], base: &str, dest: &Path, password: Option<&str>) -> Result<usize, String> {
    std::fs::create_dir_all(dest).map_err(|e| e.to_string())?;
    // Extract to a staging folder first so nothing is overwritten, then move into place.
    let stage = dest.join(format!(".pifiles-extract-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&stage);
    std::fs::create_dir_all(&stage).map_err(|e| e.to_string())?;
    let result = extract_into(path, &stage, password, &Filter { only: entries, base });
    if let Err(e) = result {
        let _ = std::fs::remove_dir_all(&stage);
        return Err(e);
    }
    let rd = std::fs::read_dir(&stage).map_err(|e| e.to_string())?;
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        let mut target = dest.join(&name);
        let mut i = 2;
        while target.exists() {
            let (stem, ext) = match name.rfind('.') {
                Some(d) if d > 0 && e.path().is_file() => (&name[..d], &name[d..]),
                _ => (name.as_str(), ""),
            };
            target = dest.join(format!("{stem} ({i}){ext}"));
            i += 1;
        }
        std::fs::rename(e.path(), &target).map_err(|e| e.to_string())?;
    }
    let _ = std::fs::remove_dir_all(&stage);
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join("pifiles-archive-test");
        std::fs::create_dir_all(&d).unwrap();
        d.join(name)
    }

    #[test]
    fn extract_selected_relative_to_browsed_folder() {
        use zip::write::SimpleFileOptions;
        let p = tmp("sel.zip");
        {
            let mut w = zip::ZipWriter::new(File::create(&p).unwrap());
            for (name, body) in [("photos/2024/a.jpg", "A"), ("photos/2024/b.jpg", "B"), ("photos/c.png", "C"), ("readme.txt", "R")] {
                w.start_file(name, SimpleFileOptions::default()).unwrap();
                w.write_all(body.as_bytes()).unwrap();
            }
            w.finish().unwrap();
        }
        let dest = tmp("sel-out");
        let _ = std::fs::remove_dir_all(&dest);
        std::fs::create_dir_all(&dest).unwrap();
        std::fs::write(dest.join("c.png"), "existing").unwrap();
        let n = extract_selected(&p, &["photos/2024/".to_string(), "photos/c.png".to_string()], "photos", &dest, None).unwrap();
        assert_eq!(n, 3);
        assert_eq!(std::fs::read_to_string(dest.join("2024").join("a.jpg")).unwrap(), "A");
        assert_eq!(std::fs::read_to_string(dest.join("2024").join("b.jpg")).unwrap(), "B");
        // an existing file is kept; the incoming one gets a free name
        assert_eq!(std::fs::read_to_string(dest.join("c.png")).unwrap(), "existing");
        assert_eq!(std::fs::read_to_string(dest.join("c (2).png")).unwrap(), "C");
        assert!(!dest.join("readme.txt").exists());
        assert!(std::fs::read_dir(&dest).unwrap().all(|e| !e.unwrap().file_name().to_string_lossy().starts_with(".pifiles-extract")));
        let _ = std::fs::remove_dir_all(&dest);
    }

    #[test]
    fn zip_with_aes_password_roundtrip() {
        use zip::write::SimpleFileOptions;
        let p = tmp("secret.zip");
        {
            let mut w = zip::ZipWriter::new(File::create(&p).unwrap());
            let opts = SimpleFileOptions::default().with_aes_encryption(zip::AesMode::Aes256, "hunter2");
            w.start_file("docs/readme.txt", opts).unwrap();
            w.write_all(b"hello from inside").unwrap();
            w.finish().unwrap();
        }
        let l = list(&p, None).unwrap();
        assert!(l.encrypted);
        assert_eq!(l.entries[0].name, "docs/readme.txt");
        assert_eq!(extract_entry(&p, "docs/readme.txt", None).unwrap_err(), PASSWORD_REQUIRED);
        assert_eq!(list(&p, Some("wrong")).unwrap_err(), WRONG_PASSWORD);
        let out = extract_entry(&p, "docs/readme.txt", Some("hunter2")).unwrap();
        assert_eq!(std::fs::read_to_string(out).unwrap(), "hello from inside");
    }

    #[test]
    fn tar_gz_and_zip_slip_protection() {
        let p = tmp("bundle.tar.gz");
        {
            let gz = flate2::write::GzEncoder::new(File::create(&p).unwrap(), flate2::Compression::fast());
            let mut b = tar::Builder::new(gz);
            let data = b"tar content";
            let mut h = tar::Header::new_gnu();
            h.set_size(data.len() as u64);
            h.set_cksum();
            b.append_data(&mut h, "a/b.txt", &data[..]).unwrap();
            b.into_inner().unwrap().finish().unwrap();
        }
        let l = list(&p, None).unwrap();
        assert_eq!(l.format, "TAR.GZ");
        assert_eq!(l.entries[0].name, "a/b.txt");
        let out = extract_entry(&p, "a/b.txt", None).unwrap();
        assert_eq!(std::fs::read(out).unwrap(), b"tar content");

        assert!(safe_relative("../../evil.dll").is_none());
        assert!(safe_relative("C:\\Windows\\evil.dll").is_none());
        assert_eq!(safe_relative("ok/./file.txt").unwrap(), PathBuf::from("ok").join("file.txt"));
    }
}
