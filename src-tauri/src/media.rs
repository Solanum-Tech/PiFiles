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
    pub preview: Vec<String>, // up to 4 preview paths
    #[serde(skip_serializing_if = "Option::is_none")]
    pub face_count: Option<usize>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct PeopleGroups {
    pub groups: Vec<MediaGroup>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct DeviceGroups {
    pub by_drive: Vec<MediaGroup>,
    pub by_type: Vec<MediaGroup>,
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

pub fn get_media_groups(root: &str) -> PeopleGroups {
    let target = if root.is_empty() {
        default_pictures_target()
    } else {
        root.to_string()
    };

    // Try real facial recognition first (functional, not placeholder) — on low-end this is limited to 120 images, 60 faces
    // If faces found and clustered, return person groups; otherwise fallback to folder grouping
    if let Some(face_groups) = faces::group_by_faces(&target) {
        if !face_groups.is_empty() {
            return PeopleGroups { groups: face_groups };
        }
    }

    // Fallback: Group by parent folder (lightweight, always works)
    // Future: integrate face detection (e.g., `face-detection` crate) and cluster by embedding
    // For now, group by top-level folder under target, which often corresponds to person/album
    let mut map: HashMap<String, (usize, u64, Vec<String>)> = HashMap::new();

    let walker = WalkDir::new(&target)
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
        let rel = path.strip_prefix(&target).unwrap_or(path);
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
            }
        })
        .collect();

    groups.sort_by(|a, b| b.count.cmp(&a.count));
    groups.truncate(50); // cap for low-end

    PeopleGroups { groups }
}

pub fn get_device_groups() -> DeviceGroups {
    // by_drive: group media files by drive/volume
    // by_type: group by file type / device-like (extension and mime)
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
    let mut type_map: HashMap<String, (usize, u64, Vec<String>)> = HashMap::new();

    for root in roots {
        let walker = WalkDir::new(&root)
            .max_depth(3) // shallow for device grouping (fast, low-end)
            .into_iter()
            .filter_map(|e| e.ok())
            .filter(|e| !e.file_type().is_dir());

        for entry in walker.take(5000) { // cap per drive for low-end
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

            // by_type (device-like: use extension as proxy for device/camera)
            // Future: read EXIF Model tag via `kamadak-exif` to group by actual device
            let type_key = match ext.as_str() {
                "jpg" | "jpeg" => "JPEG (Camera)".to_string(),
                "heic" => "HEIC (iPhone)".to_string(),
                "png" => "PNG".to_string(),
                "mp4" | "mov" => "Video (Phone/Camera)".to_string(),
                "mp3" | "wav" | "flac" => "Audio".to_string(),
                _ => ext.to_uppercase(),
            };
            let e2 = type_map.entry(type_key).or_insert((0, 0, Vec::new()));
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
        })
        .collect();
    by_drive.sort_by(|a, b| b.count.cmp(&a.count));

    let mut by_type: Vec<MediaGroup> = type_map
        .into_iter()
        .map(|(k, (count, total_size, preview))| MediaGroup {
            key: k.clone(),
            label: k,
            count,
            total_size,
            preview,
            face_count: None,
        })
        .collect();
    by_type.sort_by(|a, b| b.count.cmp(&a.count));

    DeviceGroups { by_drive, by_type }
}
