use base64::Engine;
use serde::{Deserialize, Serialize};
use std::fs::File;
use std::io::{Read, BufReader};
use std::path::Path;

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ArchiveEntry {
    pub name: String,
    pub size: u64,
    pub is_dir: bool,
    pub compressed_size: u64,
}

const TEXT_LIMIT: usize = 200 * 1024; // 200KB for low-end
const HEX_LIMIT: usize = 512;
const PDF_B64_LIMIT: u64 = 5 * 1024 * 1024; // 5MB
const ARCHIVE_MAX_ENTRIES: usize = 100;

/// Lightweight text file reader - caps at limit bytes, handles non-utf8 gracefully
/// For txt, md, csv, json, html, svg, xml, log, etc.
pub fn read_text_file(path: String, limit: Option<usize>) -> Result<String, String> {
    let lim = limit.unwrap_or(TEXT_LIMIT).min(1024 * 1024); // hard cap 1MB
    let p = Path::new(&path);
    if !p.exists() {
        return Err(format!("not found: {}", path));
    }
    if !p.is_file() {
        return Err("not a file".to_string());
    }
    let meta = std::fs::metadata(p).map_err(|e| e.to_string())?;
    if meta.len() == 0 {
        return Ok(String::new());
    }
    // For low-end avoid reading huge files into memory
    if meta.len() > (lim as u64 + 1024) {
        // read only first `lim` bytes
        let f = File::open(p).map_err(|e| e.to_string())?;
        let mut reader = BufReader::new(f);
        let mut buf = vec![0u8; lim];
        let n = reader.read(&mut buf).map_err(|e| e.to_string())?;
        buf.truncate(n);
        // lossy convert, truncate on invalid utf8 boundaries
        let mut s = String::from_utf8_lossy(&buf).to_string();
        // Ensure we don't cut in middle of char - from_utf8_lossy already handles
        s.push_str("\n\n… truncated (showing first 200KB) …");
        return Ok(s);
    }
    // small file - read all
    let bytes = std::fs::read(p).map_err(|e| e.to_string())?;
    if bytes.len() > lim {
        let truncated = bytes[..lim].to_vec();
        let mut s = String::from_utf8_lossy(&truncated).to_string();
        s.push_str("\n\n… truncated (showing first 200KB) …");
        return Ok(s);
    }
    // Try utf8, fallback to lossy
    let s = String::from_utf8_lossy(&bytes).to_string();
    // Heuristic: if binary (contains many null bytes), return hex preview instead
    let nulls = bytes.iter().filter(|&&b| b == 0).count();
    if nulls > 10 && nulls > bytes.len() / 100 {
        return Err("binary file - use hex preview".to_string());
    }
    Ok(s)
}

/// Read file as base64 (for pdf small, or image fallback) - capped at 5MB
pub fn read_file_base64(path: String) -> Result<String, String> {
    let p = Path::new(&path);
    if !p.exists() {
        return Err(format!("not found: {}", path));
    }
    if !p.is_file() {
        return Err("not a file".to_string());
    }
    let meta = std::fs::metadata(p).map_err(|e| e.to_string())?;
    if meta.len() > PDF_B64_LIMIT {
        return Err(format!("file too large ({} > 5MB)", meta.len()));
    }
    if meta.len() == 0 {
        return Err("empty file".to_string());
    }
    let bytes = std::fs::read(p).map_err(|e| e.to_string())?;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(b64)
}

/// Hex preview - first 512 bytes as hex + ascii
pub fn get_hex_preview(path: String) -> Result<String, String> {
    let p = Path::new(&path);
    if !p.exists() {
        return Err(format!("not found: {}", path));
    }
    if !p.is_file() {
        return Err("not a file".to_string());
    }
    let mut f = File::open(p).map_err(|e| e.to_string())?;
    let mut buf = vec![0u8; HEX_LIMIT];
    let n = f.read(&mut buf).map_err(|e| e.to_string())?;
    buf.truncate(n);
    if buf.is_empty() {
        return Ok("Empty file".to_string());
    }
    let mut out = String::new();
    for (i, chunk) in buf.chunks(16).enumerate() {
        out.push_str(&format!("{:08x}  ", i * 16));
        for b in chunk {
            out.push_str(&format!("{:02x} ", b));
        }
        // pad if <16
        if chunk.len() < 16 {
            for _ in 0..(16 - chunk.len()) {
                out.push_str("   ");
            }
        }
        out.push_str(" |");
        for b in chunk {
            let c = if *b >= 32 && *b <= 126 { *b as char } else { '.' };
            out.push(c);
        }
        out.push_str("|\n");
    }
    Ok(out)
}

/// List archive entries - lightweight, no extraction, capped to 100 entries
/// Supports zip via `zip` crate. For rar/7z/tar/gz returns informative error to let frontend show open-externally.
pub fn list_archive(path: String) -> Result<Vec<ArchiveEntry>, String> {
    let p = Path::new(&path);
    if !p.exists() {
        return Err(format!("not found: {}", path));
    }
    if !p.is_file() {
        return Err("not a file".to_string());
    }
    let ext = p
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    // zip
    if ext == "zip" {
        return list_zip(path);
    }
    // tar variants - try zip fallback first, else unsupported
    if ext == "tar" || ext == "gz" || ext == "tgz" || ext == "tar.gz" {
        // Attempt zip listing for tar.gz? Instead try tar reading with manual header scan (lightweight)
        // For MVP: return error suggesting open externally, but we try simple tar list if tar crate not available - just unsupported
        return Err(format!("Archive format .{} listing requires extraction - use Open externally", ext));
    }
    if ext == "rar" || ext == "7z" {
        return Err(format!("Archive format .{} listing not supported inline - use Open externally", ext));
    }
    // generic fallback: try zip regardless (some .zip-like)
    if ext == "zip" || ext == "jar" || ext == "apk" {
        return list_zip(path);
    }
    Err(format!("Unsupported archive type .{}", ext))
}

fn list_zip(path: String) -> Result<Vec<ArchiveEntry>, String> {
    let file = File::open(&path).map_err(|e| e.to_string())?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("zip open failed: {}", e))?;
    let len = archive.len().min(ARCHIVE_MAX_ENTRIES);
    let mut out = Vec::with_capacity(len);
    for i in 0..len {
        let entry = archive.by_index(i).map_err(|e| e.to_string())?;
        let name = entry.name().to_string();
        // skip empty or overly nested? keep all but cap
        // zip crate 2.x: size via entry.size(), compressed_size
        let size = entry.size();
        let compressed = entry.compressed_size();
        let is_dir = entry.is_dir() || name.ends_with('/');
        // lightweight filter: skip huge names
        if name.len() > 512 {
            continue;
        }
        out.push(ArchiveEntry {
            name,
            size,
            is_dir,
            compressed_size: compressed,
        });
        if out.len() >= ARCHIVE_MAX_ENTRIES {
            break;
        }
    }
    if out.is_empty() {
        return Err("empty or unreadable archive".to_string());
    }
    Ok(out)
}

/// Open file with default OS handler via tauri_plugin_opener
pub fn open_file(path: String) -> Result<String, String> {
    let p = Path::new(&path);
    if !p.exists() {
        return Err(format!("not found: {}", path));
    }
    tauri_plugin_opener::open_path(path.clone(), None::<String>).map_err(|e| e.to_string())?;
    Ok(format!("opened: {}", path))
}

/// A text file opened for editing: decoded text plus what is needed to save it back unchanged
/// (encoding, byte-order mark, line endings).
#[derive(Serialize)]
pub struct TextDoc {
    pub text: String,
    pub encoding: String,
    pub bom: bool,
    pub crlf: bool,
    pub size: u64,
    pub editable: bool,
}

const EDIT_LIMIT: u64 = 8 * 1024 * 1024;

pub fn text_open(path: &str) -> Result<TextDoc, String> {
    let meta = std::fs::metadata(path).map_err(|e| e.to_string())?;
    if meta.len() > EDIT_LIMIT {
        let text = read_text_file(path.to_string(), Some(1024 * 1024))?;
        return Ok(TextDoc { text, encoding: "utf-8".into(), bom: false, crlf: false, size: meta.len(), editable: false });
    }
    let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
    let (text, encoding, bom) = if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        (String::from_utf8_lossy(&bytes[3..]).to_string(), "utf-8", true)
    } else if bytes.starts_with(&[0xFF, 0xFE]) || bytes.starts_with(&[0xFE, 0xFF]) {
        let le = bytes[0] == 0xFF;
        let units: Vec<u16> = bytes[2..]
            .chunks_exact(2)
            .map(|c| if le { u16::from_le_bytes([c[0], c[1]]) } else { u16::from_be_bytes([c[0], c[1]]) })
            .collect();
        (String::from_utf16_lossy(&units), if le { "utf-16le" } else { "utf-16be" }, true)
    } else if let Ok(s) = std::str::from_utf8(&bytes) {
        (s.to_string(), "utf-8", false)
    } else {
        let nulls = bytes.iter().filter(|&&b| b == 0).count();
        if nulls > 10 && nulls > bytes.len() / 100 {
            return Err("This is a binary file".into());
        }
        // Legacy Windows text: CP-1252 (Latin-1 superset).
        (bytes.iter().map(|&b| cp1252(b)).collect(), "windows-1252", false)
    };
    let crlf = text.contains("\r\n");
    Ok(TextDoc { text: text.replace("\r\n", "\n"), encoding: encoding.into(), bom, crlf, size: meta.len(), editable: true })
}

fn cp1252(b: u8) -> char {
    const HIGH: [char; 32] = [
        '€', '\u{81}', '‚', 'ƒ', '„', '…', '†', '‡', 'ˆ', '‰', 'Š', '‹', 'Œ', '\u{8d}', 'Ž', '\u{8f}', '\u{90}', '‘', '’', '“',
        '”', '•', '\u{2013}', '\u{2014}', '˜', '™', 'š', '›', 'œ', '\u{9d}', 'ž', 'Ÿ',
    ];
    if (0x80..0xA0).contains(&b) {
        HIGH[(b - 0x80) as usize]
    } else {
        b as char
    }
}

pub fn text_save(path: &str, text: &str, encoding: &str, bom: bool, crlf: bool) -> Result<(), String> {
    let body = if crlf { text.replace("\r\n", "\n").replace('\n', "\r\n") } else { text.to_string() };
    let mut out: Vec<u8> = Vec::with_capacity(body.len() + 4);
    match encoding {
        "utf-16le" | "utf-16be" => {
            let le = encoding == "utf-16le";
            out.extend(if le { [0xFF, 0xFE] } else { [0xFE, 0xFF] });
            for u in body.encode_utf16() {
                out.extend(if le { u.to_le_bytes() } else { u.to_be_bytes() });
            }
        }
        "windows-1252" => {
            for ch in body.chars() {
                let byte = (0x80u8..0xA0).find(|&b| cp1252(b) == ch).or_else(|| {
                    let c = ch as u32;
                    (c < 0x100 && !(0x80..0xA0).contains(&c)).then_some(c as u8)
                });
                match byte {
                    Some(b) => out.push(b),
                    None => return Err(format!("“{ch}” can't be saved in this file's Windows-1252 encoding")),
                }
            }
        }
        _ => {
            if bom {
                out.extend([0xEF, 0xBB, 0xBF]);
            }
            out.extend(body.as_bytes());
        }
    }
    let p = Path::new(path);
    crate::versions::before_edit(p);
    let tmp = p.with_extension("pifiles-tmp");
    std::fs::write(&tmp, &out).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, p).map_err(|e| format!("Couldn't save (is the file open in another program?): {e}"))
}
