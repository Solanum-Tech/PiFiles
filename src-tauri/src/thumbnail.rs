use base64::Engine;
use std::collections::HashMap;
use std::io::Cursor;
use std::path::Path;
use std::sync::{Mutex, OnceLock};

/// In-memory LRU-ish cache for thumbnails: path -> data URL
/// Low-end: capped at 300 entries, clear half when full. No temp-file cache to avoid disk churn.
static THUMB_CACHE: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
static PREVIEW_CACHE: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();

fn thumb_cache() -> &'static Mutex<HashMap<String, String>> {
    THUMB_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}
fn preview_cache() -> &'static Mutex<HashMap<String, String>> {
    PREVIEW_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn cache_get(cache: &Mutex<HashMap<String, String>>, key: &str) -> Option<String> {
    cache.lock().ok()?.get(key).cloned()
}
fn cache_insert(cache: &Mutex<HashMap<String, String>>, key: String, val: String) {
    if let Ok(mut m) = cache.lock() {
        // Simple LRU eviction: if over 300, drain half
        if m.len() >= 300 {
            let to_remove = m.len() / 2;
            let keys: Vec<String> = m.keys().take(to_remove).cloned().collect();
            for k in keys {
                m.remove(&k);
            }
        }
        m.insert(key, val);
    }
}

const MAX_FILE_SIZE: u64 = 5 * 1024 * 1024; // 5MB per spec
const THUMB_MAX: u32 = 256;
const PREVIEW_MAX: u32 = 512;

fn is_image_ext(ext: &str) -> bool {
    matches!(
        ext,
        "jpg" | "jpeg" | "png" | "webp" | "bmp" | "gif" | "heic" | "heif"
    )
}

fn is_supported_image(path: &str) -> bool {
    Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| is_image_ext(&e.to_lowercase()))
        .unwrap_or(false)
}

/// Core: open, resize to max dimension, encode JPEG base64 data URL.
/// `max_dim` = 256 for grid/thumb, 512 for preview.
fn generate_data_url(path: &str, max_dim: u32) -> Result<String, String> {
    let p = Path::new(path);

    // Existence + file check
    if !p.exists() {
        return Err(format!("not found: {}", path));
    }
    if !p.is_file() {
        return Err("not a file".to_string());
    }

    // Extension guard: skip non-images early (fast)
    if !is_supported_image(path) {
        return Err("not an image".to_string());
    }

    // Size guard: limit to 5MB (spec) - also skip tiny corrupted
    if let Ok(meta) = std::fs::metadata(p) {
        let sz = meta.len();
        if sz > MAX_FILE_SIZE {
            return Err(format!("file too large ({} > 5MB)", sz));
        }
        if sz == 0 {
            return Err("empty file".to_string());
        }
    }

    // Open via image crate - handles jpeg/png/webp/bmp/gif
    let img = image::open(p).map_err(|e| format!("open failed: {}", e))?;

    // Resize to max_dim preserving aspect ratio; use Triangle for speed (low-end)
    // Do not enlarge small images
    let (w, h) = (img.width(), img.height());
    let resized = if w > max_dim || h > max_dim {
        let scale = (max_dim as f32 / w.max(h) as f32).min(1.0);
        let nw = ((w as f32 * scale) as u32).max(1);
        let nh = ((h as f32 * scale) as u32).max(1);
        img.resize(nw, nh, image::imageops::FilterType::Triangle)
    } else {
        img
    };

    // Encode to JPEG (universal browser support) with quality 75 (balance size/speed)
    let mut buf: Vec<u8> = Vec::new();
    {
        let mut cursor = Cursor::new(&mut buf);
        let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut cursor, 75);
        encoder
            .encode_image(&resized)
            .map_err(|e| format!("encode failed: {}", e))?;
    }

    let b64 = base64::engine::general_purpose::STANDARD.encode(&buf);
    Ok(format!("data:image/jpeg;base64,{}", b64))
}

pub fn get_thumbnail(path: String) -> Result<String, String> {
    // Cache hit
    if let Some(cached) = cache_get(thumb_cache(), &path) {
        return Ok(cached);
    }
    // Generate 256 variant (grid uses 128 but we serve 256 and let CSS downscale; caller can request smaller via preview)
    // For true 128 we could add param, but 256 is fine for low-end with JPEG q75 (~8-15KB)
    let url = generate_data_url(&path, THUMB_MAX)?;
    cache_insert(thumb_cache(), path, url.clone());
    Ok(url)
}

pub fn get_file_preview(path: String) -> Result<String, String> {
    if let Some(cached) = cache_get(preview_cache(), &path) {
        return Ok(cached);
    }
    let url = generate_data_url(&path, PREVIEW_MAX)?;
    cache_insert(preview_cache(), path, url.clone());
    Ok(url)
}
