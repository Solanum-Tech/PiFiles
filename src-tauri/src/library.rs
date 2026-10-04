//! Media library: every photo and video on the machine, for the Gallery and Devices views.
//!
//! A background walk (low priority, skipping system and app folders) finds media files; a second
//! pass reads when each was taken and which device took it - EXIF Make/Model for photos
//! (JPEG, HEIC, TIFF and TIFF-based RAW), QuickTime/MP4 metadata for videos (Apple
//! `com.apple.quicktime.make/model`, Android `com.android.manufacturer/model`, `©mak/©mod`).
//! Results are cached on disk and reused while a file's size and date are unchanged.

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{OnceLock, RwLock};
use std::time::UNIX_EPOCH;
use tauri::Emitter;
use walkdir::WalkDir;

const IMAGE_EXTS: &[&str] = &[
    "jpg", "jpeg", "png", "heic", "heif", "webp", "gif", "bmp", "tif", "tiff", "avif", "cr2", "cr3", "nef", "arw", "dng",
    "raf", "orf", "rw2", "pef", "srw",
];
const VIDEO_EXTS: &[&str] = &["mp4", "mov", "m4v", "mkv", "avi", "wmv", "webm", "3gp", "mts", "m2ts", "mpg", "mpeg"];
const MIN_IMAGE_BYTES: u64 = 8 * 1024; // skip icons and web thumbnails

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Item {
    pub path: String,
    pub kind: String, // "image" | "video"
    pub size: u64,
    pub mtime: u64,
    /// When the photo/video was taken (s since epoch); falls back to mtime.
    pub taken: u64,
    pub device: Option<String>,
    #[serde(default)]
    pub meta_read: bool,
}

#[derive(Serialize, Clone, Debug)]
pub struct Page {
    pub items: Vec<Item>,
    pub total: usize,
    pub scanning: bool,
}

#[derive(Serialize, Clone, Debug)]
pub struct Device {
    pub name: String,
    pub count: usize,
    pub images: usize,
    pub videos: usize,
    /// Most recent photo/video from this device.
    pub cover: String,
    pub last_taken: u64,
}

fn items() -> &'static RwLock<Vec<Item>> {
    static I: OnceLock<RwLock<Vec<Item>>> = OnceLock::new();
    I.get_or_init(|| RwLock::new(load_cache()))
}

static SCANNING: AtomicBool = AtomicBool::new(false);
static PHASE: RwLock<&'static str> = RwLock::new("idle");

fn cache_path() -> PathBuf {
    crate::app_data_dir().join("library_v2.json")
}

fn load_cache() -> Vec<Item> {
    crate::vault::read(&cache_path()).and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}

fn save_cache(v: &[Item]) {
    if let Ok(json) = serde_json::to_vec(v) {
        let _ = crate::vault::write(&cache_path(), &json);
    }
}

fn kind_of(ext: &str) -> Option<&'static str> {
    if IMAGE_EXTS.contains(&ext) {
        Some("image")
    } else if VIDEO_EXTS.contains(&ext) {
        Some("video")
    } else {
        None
    }
}

fn roots() -> Vec<String> {
    let mut r: Vec<String> = Vec::new();
    let kf = crate::fs::known_folders();
    for k in ["pictures", "videos", "desktop", "downloads", "documents"] {
        if let Some(p) = kf.get(k) {
            r.push(p.clone());
        }
    }
    r.extend(crate::faces::full_machine_roots());
    r
}

// ---------- device + date metadata ----------

fn nice_make(make: &str) -> String {
    let m = make.trim();
    if m.chars().all(|c| !c.is_uppercase()) {
        let mut c = m.chars();
        return c.next().map(|f| f.to_uppercase().collect::<String>() + c.as_str()).unwrap_or_default();
    }
    m.to_string()
}

/// "Canon" + "Canon EOS R5" -> "Canon EOS R5"; "samsung" + "SM-S918B" -> "Samsung SM-S918B".
pub fn device_name(make: Option<String>, model: Option<String>) -> Option<String> {
    let clean = |s: String| s.trim_matches(|c: char| c == '"' || c.is_whitespace() || c == '\0').to_string();
    let make = make.map(clean).filter(|s| !s.is_empty());
    let model = model.map(clean).filter(|s| !s.is_empty());
    match (make, model) {
        (Some(mk), Some(md)) => {
            let first = mk.split_whitespace().next().unwrap_or("").to_lowercase();
            if md.to_lowercase().starts_with(&first) {
                Some(md)
            } else {
                Some(format!("{} {}", nice_make(&mk), md))
            }
        }
        (None, Some(md)) => Some(md),
        (Some(mk), None) => Some(nice_make(&mk)),
        _ => None,
    }
}

pub(crate) fn exif_meta(path: &Path) -> (Option<String>, Option<u64>) {
    let Ok(f) = std::fs::File::open(path) else { return (None, None) };
    let Ok(ex) = exif::Reader::new().read_from_container(&mut std::io::BufReader::new(f)) else { return (None, None) };
    // First non-empty string of an ASCII field (some phones write several, padded with empties).
    let text = |t| {
        ex.get_field(t, exif::In::PRIMARY).and_then(|f| match &f.value {
            exif::Value::Ascii(v) => v.iter().map(|b| String::from_utf8_lossy(b).trim_matches(|c: char| c == '\0' || c.is_whitespace()).to_string()).find(|s| !s.is_empty()),
            _ => Some(f.display_value().to_string()),
        })
    };
    let device = device_name(text(exif::Tag::Make), text(exif::Tag::Model));
    let taken = ex
        .get_field(exif::Tag::DateTimeOriginal, exif::In::PRIMARY)
        .or_else(|| ex.get_field(exif::Tag::DateTime, exif::In::PRIMARY))
        .and_then(|f| match &f.value {
            exif::Value::Ascii(v) => v.first().and_then(|b| parse_exif_date(&String::from_utf8_lossy(b))),
            _ => None,
        });
    (device, taken)
}

fn parse_exif_date(s: &str) -> Option<u64> {
    // "YYYY:MM:DD HH:MM:SS"
    let d = chrono::NaiveDateTime::parse_from_str(s.trim(), "%Y:%m:%d %H:%M:%S").ok()?;
    let t = d.and_utc().timestamp();
    (t > 0).then_some(t as u64)
}

fn read_box_header(r: &mut (impl Read + Seek)) -> Option<(u64, [u8; 4], u64)> {
    let mut h = [0u8; 8];
    r.read_exact(&mut h).ok()?;
    let mut size = u32::from_be_bytes([h[0], h[1], h[2], h[3]]) as u64;
    let kind = [h[4], h[5], h[6], h[7]];
    let mut header = 8;
    if size == 1 {
        let mut b = [0u8; 8];
        r.read_exact(&mut b).ok()?;
        size = u64::from_be_bytes(b);
        header = 16;
    } else if size == 0 {
        let pos = r.stream_position().ok()?;
        let end = r.seek(SeekFrom::End(0)).ok()?;
        r.seek(SeekFrom::Start(pos)).ok()?;
        size = end - pos + 8;
    }
    Some((size, kind, header))
}

/// Children of an MP4 container box held in memory: (type, payload).
fn children(data: &[u8]) -> Vec<([u8; 4], &[u8])> {
    let mut out = Vec::new();
    let mut p = 0;
    while p + 8 <= data.len() {
        let size = u32::from_be_bytes([data[p], data[p + 1], data[p + 2], data[p + 3]]) as usize;
        let kind = [data[p + 4], data[p + 5], data[p + 6], data[p + 7]];
        let (hdr, size) = if size == 1 && p + 16 <= data.len() {
            (16, u64::from_be_bytes(data[p + 8..p + 16].try_into().unwrap()) as usize)
        } else {
            (8, if size == 0 { data.len() - p } else { size })
        };
        if size < hdr || p + size > data.len() {
            break;
        }
        out.push((kind, &data[p + hdr..p + size]));
        p += size;
    }
    out
}

fn text_payload(data: &[u8]) -> Option<String> {
    // iTunes-style 'data' child box, or QuickTime ©xyz: u16 length, u16 language, text.
    if let Some((_, d)) = children(data).into_iter().find(|(k, _)| k == b"data") {
        return d.get(8..).map(|t| String::from_utf8_lossy(t).trim_matches('\0').trim().to_string());
    }
    if data.len() > 4 {
        let n = u16::from_be_bytes([data[0], data[1]]) as usize;
        return data.get(4..4 + n).map(|t| String::from_utf8_lossy(t).trim().to_string());
    }
    None
}

pub(crate) fn video_meta(path: &Path) -> (Option<String>, Option<u64>) {
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    if !matches!(ext.as_str(), "mp4" | "mov" | "m4v" | "3gp") {
        return (None, None);
    }
    let Ok(mut f) = std::fs::File::open(path) else { return (None, None) };
    // Find moov at the top level (it may sit after a huge mdat).
    let mut moov = None;
    let mut pos = 0u64;
    for _ in 0..64 {
        if f.seek(SeekFrom::Start(pos)).is_err() {
            break;
        }
        let Some((size, kind, hdr)) = read_box_header(&mut f) else { break };
        if &kind == b"moov" {
            if size > 64 * 1024 * 1024 {
                break;
            }
            let mut buf = vec![0u8; (size - hdr) as usize];
            if f.read_exact(&mut buf).is_ok() {
                moov = Some(buf);
            }
            break;
        }
        if size < hdr {
            break;
        }
        pos += size;
    }
    let Some(moov) = moov else { return (None, None) };
    let (mut make, mut model, mut taken) = (None, None, None);
    for (kind, body) in children(&moov) {
        match &kind {
            b"mvhd" if body.len() > 12 => {
                let secs = if body[0] == 1 { u64::from_be_bytes(body[4..12].try_into().unwrap()) } else { u32::from_be_bytes(body[4..8].try_into().unwrap()) as u64 };
                // Seconds since 1904; zero/garbage means "not set".
                if secs > 2_082_844_800 + 315_532_800 {
                    taken = Some(secs - 2_082_844_800);
                }
            }
            b"udta" => {
                for (k, b) in children(body) {
                    match &k {
                        [0xA9, b'm', b'a', b'k'] => make = make.or(text_payload(b)),
                        [0xA9, b'm', b'o', b'd'] => model = model.or(text_payload(b)),
                        b"meta" => scan_meta(b, &mut make, &mut model),
                        _ => {}
                    }
                }
            }
            b"meta" => scan_meta(body, &mut make, &mut model),
            _ => {}
        }
    }
    (device_name(make, model), taken)
}

/// QuickTime 'meta': 'keys' names + 'ilst' values (index = 1-based key number).
fn scan_meta(body: &[u8], make: &mut Option<String>, model: &mut Option<String>) {
    // ISO 'meta' is a full box (4 bytes version/flags); QuickTime's isn't.
    let body = if body.len() > 8 && &body[4..8] != b"hdlr" && &body[4..8] != b"keys" { &body[4..] } else { body };
    let kids = children(body);
    let mut keys: Vec<String> = Vec::new();
    if let Some((_, k)) = kids.iter().find(|(t, _)| t == b"keys") {
        let mut p = 8;
        while p + 8 <= k.len() {
            let n = u32::from_be_bytes(k[p..p + 4].try_into().unwrap()) as usize;
            if n < 8 || p + n > k.len() {
                break;
            }
            keys.push(String::from_utf8_lossy(&k[p + 8..p + n]).to_string());
            p += n;
        }
    }
    if let Some((_, ilst)) = kids.iter().find(|(t, _)| t == b"ilst") {
        for (t, v) in children(ilst) {
            let idx = u32::from_be_bytes(t) as usize;
            let Some(name) = idx.checked_sub(1).and_then(|i| keys.get(i)) else { continue };
            let val = text_payload(v);
            match name.as_str() {
                "com.apple.quicktime.make" | "com.android.manufacturer" => *make = make.take().or(val),
                "com.apple.quicktime.model" | "com.android.model" => *model = model.take().or(val),
                _ => {}
            }
        }
    }
}

fn read_meta(item: &mut Item) {
    let p = Path::new(&item.path);
    let (device, taken) = if item.kind == "video" { video_meta(p) } else { exif_meta(p) };
    item.device = device;
    if let Some(t) = taken {
        item.taken = t;
    }
    item.meta_read = true;
}

// ---------- scanning ----------

fn set_phase(p: &'static str) {
    *PHASE.write().unwrap() = p;
}

pub fn spawn_scan(app: Option<tauri::AppHandle>) {
    if SCANNING.swap(true, Ordering::SeqCst) {
        return;
    }
    std::thread::spawn(move || {
        crate::faces::lower_thread_priority();
        set_phase("walking");
        let previous: HashMap<String, Item> = items().read().unwrap().iter().map(|i| (i.path.to_lowercase(), i.clone())).collect();
        let mut found: Vec<Item> = Vec::new();
        let mut seen = HashSet::new();
        for root in roots() {
            for e in WalkDir::new(&root)
                .max_depth(16)
                .follow_links(false)
                .into_iter()
                .filter_entry(|e| !(e.file_type().is_dir() && e.depth() > 0 && crate::faces::should_skip_dir(&e.file_name().to_string_lossy())))
                .filter_map(|e| e.ok())
            {
                if !e.file_type().is_file() {
                    continue;
                }
                let ext = e.path().extension().and_then(|x| x.to_str()).unwrap_or("").to_ascii_lowercase();
                let Some(kind) = kind_of(&ext) else { continue };
                let path = e.path().to_string_lossy().to_string();
                if !seen.insert(path.to_lowercase()) {
                    continue;
                }
                let Ok(md) = e.metadata() else { continue };
                if kind == "image" && md.len() < MIN_IMAGE_BYTES {
                    continue;
                }
                let mtime = md.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_secs()).unwrap_or(0);
                match previous.get(&path.to_lowercase()) {
                    Some(old) if old.size == md.len() && old.mtime == mtime => found.push(old.clone()),
                    _ => found.push(Item { path, kind: kind.into(), size: md.len(), mtime, taken: mtime, device: None, meta_read: false }),
                }
            }
        }
        found.sort_by(|a, b| b.taken.cmp(&a.taken));
        *items().write().unwrap() = found;
        if let Some(a) = &app {
            let _ = a.emit("library://changed", "walked");
        }

        // Metadata for new/changed files, in batches so results appear progressively.
        set_phase("reading");
        loop {
            let todo: Vec<Item> = items().read().unwrap().iter().filter(|i| !i.meta_read).take(400).cloned().collect();
            if todo.is_empty() {
                break;
            }
            let done: Vec<Item> = {
                use rayon::prelude::*;
                todo.into_par_iter().map(|mut i| { read_meta(&mut i); i }).collect()
            };
            let by_path: HashMap<String, Item> = done.into_iter().map(|i| (i.path.clone(), i)).collect();
            {
                let mut w = items().write().unwrap();
                for it in w.iter_mut() {
                    if let Some(n) = by_path.get(&it.path) {
                        *it = n.clone();
                    }
                }
                w.sort_by(|a, b| b.taken.cmp(&a.taken));
            }
            if let Some(a) = &app {
                let _ = a.emit("library://changed", "metadata");
            }
        }
        save_cache(&items().read().unwrap());
        set_phase("idle");
        SCANNING.store(false, Ordering::SeqCst);
        if let Some(a) = &app {
            let _ = a.emit("library://changed", "done");
        }
    });
}

pub fn query(kind: &str, device: Option<&str>, offset: usize, limit: usize) -> Page {
    let all = items().read().unwrap();
    let matched: Vec<&Item> = all
        .iter()
        .filter(|i| kind == "all" || i.kind == kind)
        .filter(|i| device.map(|d| i.device.as_deref() == Some(d)).unwrap_or(true))
        .collect();
    Page {
        total: matched.len(),
        items: matched.into_iter().skip(offset).take(limit.clamp(1, 5000)).cloned().collect(),
        scanning: SCANNING.load(Ordering::Relaxed),
    }
}

pub fn devices() -> Vec<Device> {
    let all = items().read().unwrap();
    let mut map: HashMap<String, Device> = HashMap::new();
    for i in all.iter() {
        let Some(name) = &i.device else { continue };
        let d = map.entry(name.clone()).or_insert_with(|| Device { name: name.clone(), count: 0, images: 0, videos: 0, cover: i.path.clone(), last_taken: i.taken });
        d.count += 1;
        if i.kind == "video" { d.videos += 1 } else { d.images += 1 }
        if i.taken > d.last_taken && i.kind == "image" {
            d.last_taken = i.taken;
            d.cover = i.path.clone();
        }
    }
    let mut v: Vec<Device> = map.into_values().collect();
    v.sort_by(|a, b| b.count.cmp(&a.count));
    v
}

pub fn status() -> serde_json::Value {
    let all = items().read().unwrap();
    serde_json::json!({
        "scanning": SCANNING.load(Ordering::Relaxed),
        "phase": *PHASE.read().unwrap(),
        "items": all.len(),
        "images": all.iter().filter(|i| i.kind == "image").count(),
        "videos": all.iter().filter(|i| i.kind == "video").count(),
        "pending_metadata": all.iter().filter(|i| !i.meta_read).count(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn device_names() {
        assert_eq!(device_name(Some("Canon".into()), Some("Canon EOS R5".into())).as_deref(), Some("Canon EOS R5"));
        assert_eq!(device_name(Some("samsung".into()), Some("SM-S918B".into())).as_deref(), Some("Samsung SM-S918B"));
        assert_eq!(device_name(Some("Apple".into()), Some("iPhone 15 Pro".into())).as_deref(), Some("Apple iPhone 15 Pro"));
        assert_eq!(device_name(Some("  ".into()), None), None);
    }

    #[test]
    fn reads_quicktime_make_and_model() {
        // moov { mvhd, meta { hdlr, keys{make, model}, ilst{1: data "Apple", 2: data "iPhone 13"} } }
        fn bx(kind: &[u8], body: &[u8]) -> Vec<u8> {
            let mut v = ((body.len() + 8) as u32).to_be_bytes().to_vec();
            v.extend(kind);
            v.extend(body);
            v
        }
        let key = |name: &str| { let mut v = ((name.len() + 8) as u32).to_be_bytes().to_vec(); v.extend(b"mdta"); v.extend(name.as_bytes()); v };
        let mut keys = vec![0, 0, 0, 0, 0, 0, 0, 2];
        keys.extend(key("com.apple.quicktime.make"));
        keys.extend(key("com.apple.quicktime.model"));
        let data = |s: &str| { let mut b = vec![0, 0, 0, 1, 0, 0, 0, 0]; b.extend(s.as_bytes()); bx(b"data", &b) };
        let mut ilst = bx(&1u32.to_be_bytes(), &data("Apple"));
        ilst.extend(bx(&2u32.to_be_bytes(), &data("iPhone 13")));
        let mut meta = bx(b"hdlr", &[0u8; 24]);
        meta.extend(bx(b"keys", &keys));
        meta.extend(bx(b"ilst", &ilst));
        let mut mvhd = vec![0u8; 100];
        mvhd[4..8].copy_from_slice(&((1_700_000_000u64 + 2_082_844_800) as u32).to_be_bytes());
        let mut moov = bx(b"mvhd", &mvhd);
        moov.extend(bx(b"meta", &meta));
        let mut file = bx(b"ftyp", b"qt  \0\0\0\0qt  ");
        file.extend(bx(b"mdat", &[0u8; 1000]));
        file.extend(bx(b"moov", &moov));
        let p = std::env::temp_dir().join("pifiles-lib-test.mov");
        std::fs::write(&p, file).unwrap();
        let (dev, taken) = video_meta(&p);
        assert_eq!(dev.as_deref(), Some("Apple iPhone 13"));
        assert_eq!(taken, Some(1_700_000_000));
        let _ = std::fs::remove_file(p);
    }
}
