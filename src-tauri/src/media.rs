use crate::faces;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;
use walkdir::WalkDir;

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct MediaGroup {
    pub key: String,
    pub label: String,
    pub count: usize,
    pub total_size: u64,
    pub preview: Vec<String>, // for People: face crop data URLs (data:image/jpeg;base64,...); for other groups: file paths
    #[serde(skip_serializing_if = "Option::is_none")]
    pub face_count: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub paths: Option<Vec<String>>, // file paths for person cluster (used to open folder / show photos)
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct PeopleGroups {
    pub groups: Vec<MediaGroup>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct DeviceGroups {
    pub by_drive: Vec<MediaGroup>,
    pub by_type: Vec<MediaGroup>,
    #[serde(default)]
    pub by_device: Vec<MediaGroup>,
}

// Lightweight media classification for low-end
// Avoids heavy ML; uses filename, folder, extension, drive, and optional EXIF placeholder
fn is_media_ext(ext: &str) -> bool {
    matches!(
        ext,
        "jpg" | "jpeg" | "png" | "heic" | "webp" | "bmp" | "gif" | "mp4" | "mov" | "avi" | "mkv" | "webm" | "mp3" | "wav" | "flac" | "m4a"
    )
}

fn default_pictures_target() -> String {
    #[cfg(windows)]
    {
        let pics = "C:\\Users\\Siril\\Pictures".to_string();
        if std::path::Path::new(&pics).exists() {
            return pics;
        }
        if let Ok(home) = std::env::var("USERPROFILE") {
            let p = format!("{}\\Pictures", home);
            if std::path::Path::new(&p).exists() {
                return p;
            }
        }
        "C:\\Users".to_string()
    }
    #[cfg(not(windows))]
    {
        "/".to_string()
    }
}

fn get_folder_groups(target: &str) -> PeopleGroups {
    let mut map: HashMap<String, (usize, u64, Vec<String>)> = HashMap::new();

    let walker = WalkDir::new(target)
        .max_depth(4)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| !e.file_type().is_dir());

    for entry in walker {
        let path = entry.path();
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_lowercase();
        if !is_media_ext(&ext) {
            continue;
        }
        // Group key: first folder under target, or "Unknown"
        let rel = path.strip_prefix(target).unwrap_or(path);
        let key = rel
            .components()
            .next()
            .map(|c| c.as_os_str().to_string_lossy().to_string())
            .unwrap_or_else(|| "Unknown".to_string());
        let key = if key.is_empty() { "Root".to_string() } else { key };

        let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
        let entry_path = path.to_string_lossy().to_string();
        let e = map.entry(key).or_insert((0, 0, Vec::new()));
        e.0 += 1;
        e.1 += size;
        if e.2.len() < 4 {
            e.2.push(entry_path);
        }
        if map.len() > 100 {
            break; // cap for low-end
        }
    }

    let labels = crate::people::load_labels();
    let mut groups: Vec<MediaGroup> = map
        .into_iter()
        .map(|(k, (count, total_size, preview))| {
            let label = labels.get(&k).cloned().unwrap_or_else(|| k.clone());
            MediaGroup {
                label,
                key: k,
                count,
                total_size,
                preview,
                face_count: None,
                paths: None,
            }
        })
        .collect();

    groups.sort_by(|a, b| b.count.cmp(&a.count));
    groups.truncate(50); // cap for low-end

    PeopleGroups { groups }
}

/// People tab: ONLY real face clusters - never folder fallback.
/// Returns cached face groups if available; otherwise spawns background scan and returns empty.
/// Frontend shows empty state `No faces detected - add photos with faces` when no faces.
/// Folder grouping is kept for a separate Albums tab, not People.
#[allow(dead_code)]
pub fn get_folder_groups_public(target: &str) -> PeopleGroups {
    get_folder_groups(target)
}

/// Non-blocking: returns cached face groups immediately if available,
/// otherwise spawns background scan and returns empty (no folder fallback for People).
/// Never blocks Tauri main thread with image::open / rustface detection.
/// When root="" on launch, returns cached full-machine groups if available.
/// People tab always prefers full-machine cache - even when caller passes a per-folder root,
/// we return machine-wide groups if present, avoiding the "2 candidates → empty People" bug.
pub fn get_media_groups(root: &str) -> PeopleGroups {
    let _target = if root.is_empty() {
        default_pictures_target()
    } else {
        root.to_string()
    };

    // 1. If cache has data, return immediately (fast path) - full-machine cache takes priority
    // This ensures browsing C:\Users\Siril\Pictures doesn't show empty People when machine has 12 groups
    if let Some(cached) = faces::get_cached_people_groups() {
        if !cached.is_empty() {
            return PeopleGroups { groups: cached };
        }
    }

    // 2. If scanning, return cached (if any) or empty - don't fallback to folders for People
    if faces::is_scanning() {
        if let Some(cached) = faces::get_cached_people_groups() {
            if !cached.is_empty() {
                return PeopleGroups { groups: cached };
            }
        }
        return PeopleGroups { groups: Vec::new() };
    }

    // 3. Not scanning and cache empty - spawn background scan and return empty immediately
    // For People: always prefer full-machine scan (covers C,D,E + Pictures) over per-folder scan.
    // Per-folder scan for C:\Users\Siril\Pictures previously found 2 candidates/1 face → <3 → empty,
    // which hid the 12 machine-wide groups. Now we trigger full-machine scan even for per-folder callers.
    if root.is_empty() {
        faces::spawn_full_machine_scan(false);
    } else {
        // Try cached again (race with background thread) before falling back
        // Spawn full-machine scan for People so UI eventually gets 12 groups, not empty per-folder result
        faces::spawn_full_machine_scan(false);
        // Also spawn per-folder scan as secondary (won't overwrite cache if it returns None)
        // faces::spawn_face_scan(target.clone());
    }
    PeopleGroups { groups: Vec::new() }
}

/// Async wrapper for Tauri async commands - same non-blocking semantics
#[allow(dead_code)]
pub fn get_media_groups_async(root: &str) -> PeopleGroups {
    get_media_groups(root)
}

// --- EXIF device helpers (kamadak-exif, pure Rust, lightweight) ---
fn clean_exif_field(s: String) -> String {
    // kamadak-exif display_value() wraps Ascii in quotes: "\"Canon\"" -> Canon
    let t = s.trim();
    let t = t.trim_matches('"').trim();
    // also strip surrounding single quotes / nulls
    t.trim_matches(char::from(0)).trim().to_string()
}

fn read_exif_make_model(path: &Path) -> Option<String> {
    // Only call for JPEG/TIFF where EXIF exists - caller enforces ext check + cap
    let file = std::fs::File::open(path).ok()?;
    let mut reader = std::io::BufReader::new(&file);
    let exif = exif::Reader::new().read_from_container(&mut reader).ok()?;
    let make = exif
        .get_field(exif::Tag::Make, exif::In::PRIMARY)
        .map(|f| clean_exif_field(f.display_value().to_string()))
        .filter(|s| !s.is_empty());
    let model = exif
        .get_field(exif::Tag::Model, exif::In::PRIMARY)
        .map(|f| clean_exif_field(f.display_value().to_string()))
        .filter(|s| !s.is_empty());
    match (make, model) {
        (Some(mk), Some(md)) => {
            // dedup "Canon Canon EOS R5" -> "Canon EOS R5"
            if md.to_lowercase().starts_with(&mk.to_lowercase()) {
                Some(md)
            } else if mk.to_lowercase().contains(&md.to_lowercase()) {
                Some(mk)
            } else {
                Some(format!("{} {}", mk, md))
            }
        }
        (Some(mk), None) => Some(mk),
        (None, Some(md)) => Some(md),
        (None, None) => None,
    }
}

fn extension_proxy_key(ext: &str) -> String {
    match ext {
        "jpg" | "jpeg" => "JPEG (Camera)".to_string(),
        "heic" | "heif" => "HEIC (iPhone)".to_string(),
        "png" => "PNG".to_string(),
        "webp" => "WebP".to_string(),
        "tiff" | "tif" => "TIFF (Camera)".to_string(),
        "mp4" | "mov" => "Video (Phone/Camera)".to_string(),
        "avi" | "mkv" | "webm" => "Video".to_string(),
        "mp3" | "wav" | "flac" | "m4a" | "ogg" => "Audio".to_string(),
        _ => ext.to_uppercase(),
    }
}

fn is_exif_capable_ext(ext: &str) -> bool {
    matches!(ext, "jpg" | "jpeg" | "tiff" | "tif")
}

pub fn get_device_groups() -> DeviceGroups {
    // by_drive: group media files by drive/volume (unchanged)
    // by_device/by_type: EXIF Make/Model device groups (Canon EOS R5, iPhone 15)
    //  - reads EXIF for jpg/jpeg/tiff only, capped at 1000 EXIF reads/drive for low-end
    //  - fallback to extension proxy when no EXIF or not EXIF-capable
    #[cfg(windows)]
    let roots: Vec<String> = {
        let mut r = vec![];
        for letter in b'C'..=b'Z' {
            let p = format!("{}:\\", letter as char);
            if Path::new(&p).exists() {
                r.push(p);
                if r.len() >= 4 {
                    break;
                }
            }
        }
        if r.is_empty() {
            r.push("C:\\".to_string());
        }
        r
    };
    #[cfg(not(windows))]
    let roots: Vec<String> = vec!["/".to_string()];

    let mut drive_map: HashMap<String, (usize, u64, Vec<String>)> = HashMap::new();
    let mut device_map: HashMap<String, (usize, u64, Vec<String>)> = HashMap::new();

    for root in roots {
        let walker = WalkDir::new(&root)
            .max_depth(3) // shallow for device grouping (fast, low-end)
            .into_iter()
            .filter_map(|e| e.ok())
            .filter(|e| !e.file_type().is_dir());

        let mut exif_reads: usize = 0;
        const EXIF_CAP_PER_DRIVE: usize = 1000;

        for entry in walker.take(5000) {
            // cap per drive for low-end
            let path = entry.path();
            let ext = path
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("")
                .to_lowercase();
            if !is_media_ext(&ext) {
                continue;
            }
            let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
            let pstr = path.to_string_lossy().to_string();

            // by_drive
            let drive_key = root.trim_end_matches('\\').to_string();
            let e = drive_map.entry(drive_key).or_insert((0, 0, Vec::new()));
            e.0 += 1;
            e.1 += size;
            if e.2.len() < 4 {
                e.2.push(pstr.clone());
            }

            // by_device: EXIF Make/Model, fallback to extension proxy
            let device_key = if is_exif_capable_ext(&ext) && exif_reads < EXIF_CAP_PER_DRIVE {
                exif_reads += 1;
                if let Some(dev) = read_exif_make_model(path) {
                    let d = dev.trim().to_string();
                    if d.is_empty() {
                        extension_proxy_key(&ext)
                    } else {
                        d
                    }
                } else {
                    extension_proxy_key(&ext)
                }
            } else {
                extension_proxy_key(&ext)
            };
            let e2 = device_map.entry(device_key).or_insert((0, 0, Vec::new()));
            e2.0 += 1;
            e2.1 += size;
            if e2.2.len() < 4 {
                e2.2.push(pstr);
            }
        }
    }

    let mut by_drive: Vec<MediaGroup> = drive_map
        .into_iter()
        .map(|(k, (count, total_size, preview))| MediaGroup {
            key: k.clone(),
            label: format!("Drive {}", k),
            count,
            total_size,
            preview,
            face_count: None,
            paths: None,
        })
        .collect();
    by_drive.sort_by(|a, b| b.count.cmp(&a.count));

    let mut by_device: Vec<MediaGroup> = device_map
        .into_iter()
        .map(|(k, (count, total_size, preview))| MediaGroup {
            key: k.clone(),
            label: k,
            count,
            total_size,
            preview,
            face_count: None,
            paths: None,
        })
        .collect();
    by_device.sort_by(|a, b| b.count.cmp(&a.count));

    // keep by_type for frontend compat - same as by_device (EXIF Make/Model, fallback proxy)
    let by_type = by_device.clone();

    DeviceGroups {
        by_drive,
        by_type,
        by_device,
    }
}
