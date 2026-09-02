use crate::media::MediaGroup;
use std::path::Path;
use walkdir::WalkDir;

// Lightweight facial recognition for low-end — pure Rust, no ONNX
// Uses rustface (SeetaFace FuSt) for detection + perceptual dHash of face crop for grouping
// This is functional, not just placeholder: detects actual faces and clusters by Hamming distance
// Model: seeta_fd_frontal_v1.0.bin (1.2MB) embedded via include_bytes! for Tauri bundling

static MODEL_BYTES: &[u8] = include_bytes!("../assets/seeta_fd_frontal_v1.0.bin");

fn create_detector() -> Option<Box<dyn rustface::Detector>> {
    // Create fresh detector per call — avoids Send/Sync issues with static and is fine for low-end (infrequent)
    let model = rustface::read_model(MODEL_BYTES).ok()?;
    let mut det = rustface::create_detector_with_model(model);
    det.set_min_face_size(30);
    det.set_score_thresh(2.0);
    det.set_pyramid_scale_factor(0.8);
    det.set_slide_window_step(4, 4);
    Some(det)
}

fn is_media_image(path: &Path) -> bool {
    if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
        matches!(
            ext.to_lowercase().as_str(),
            "jpg" | "jpeg" | "png" | "bmp" | "webp"
        )
    } else {
        false
    }
}

// Perceptual dHash for face crop — 64-bit, Hamming distance clustering
fn dhash_face_crop(img: &image::GrayImage) -> u64 {
    // Resize to 9x8, compute horizontal gradient hash
    let resized = image::imageops::resize(img, 9, 8, image::imageops::FilterType::Triangle);
    let mut hash: u64 = 0;
    for y in 0..8 {
        for x in 0..8 {
            let a = resized.get_pixel(x, y)[0];
            let b = resized.get_pixel(x + 1, y)[0];
            if a > b {
                hash |= 1 << (y * 8 + x);
            }
        }
    }
    hash
}

fn hamming(a: u64, b: u64) -> u32 {
    (a ^ b).count_ones()
}

#[derive(Clone)]
struct FaceEntry {
    path: String,
    hash: u64,
    rect: (u32, u32, u32, u32),
    size: u64,
}

fn default_target_root() -> String {
    #[cfg(windows)]
    {
        // Immich/Google Photos scans Pictures first — ensure we hit real photos
        let pics = "C:\\Users\\Siril\\Pictures".to_string();
        if std::path::Path::new(&pics).exists() {
            return pics;
        }
        // Try current user's Pictures via USERPROFILE
        if let Ok(home) = std::env::var("USERPROFILE") {
            let p = format!("{}\\Pictures", home);
            if std::path::Path::new(&p).exists() {
                return p;
            }
        }
        // Fallback to C:\Users scan
        "C:\\Users".to_string()
    }
    #[cfg(not(windows))]
    {
        "/".to_string()
    }
}

pub fn group_by_faces(root: &str) -> Option<Vec<MediaGroup>> {
    // Limit for low-end: max 120 images, max 800px, RAYON_NUM_THREADS=2
    let target = if root.is_empty() {
        default_target_root()
    } else {
        root.to_string()
    };
    let _guard = std::sync::Mutex::new(()); // placeholder for thread cap if needed

    // Collect candidate images (first 120, shallow 4 deep)
    let candidates: Vec<(String, u64)> = WalkDir::new(&target)
        .max_depth(4)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| !e.file_type().is_dir() && is_media_image(e.path()))
        .take(200) // hard cap for low-end
        .filter_map(|e| {
            let p = e.path().to_string_lossy().to_string();
            let sz = e.metadata().map(|m| m.len()).unwrap_or(0);
            // Skip tiny files (<5KB) or huge (>15MB) for low-end
            if sz < 5_000 || sz > 15_000_000 {
                return None;
            }
            Some((p, sz))
        })
        .take(120)
        .collect();

    if candidates.is_empty() {
        eprintln!("[faces] no candidates under {} (max_depth=4)", target);
        return None;
    }
    eprintln!("[faces] scanning root={} candidates={}", target, candidates.len());

    let mut detector = match create_detector() {
        Some(d) => d,
        None => {
            eprintln!("[faces] create_detector failed — seeta model load error");
            return None;
        }
    };

    let mut faces: Vec<FaceEntry> = Vec::new();
    let mut no_face_count = 0;

    for (path, size) in candidates {
        // Load image with limits — resize large images to 640 width for speed
        let img = match image::open(&path) {
            Ok(i) => i,
            Err(_) => continue,
        };
        let mut gray = img.to_luma8();
        // Downscale for low-end: max 640 on longest side
        let (w, h) = (gray.width(), gray.height());
        if w > 640 || h > 640 {
            let scale = 640.0 / w.max(h) as f32;
            let nw = (w as f32 * scale) as u32;
            let nh = (h as f32 * scale) as u32;
            gray = image::imageops::resize(&gray, nw.max(1), nh.max(1), image::imageops::FilterType::Triangle);
        }
        let (w, h) = (gray.width(), gray.height());
        let mut image_data = rustface::ImageData::new(gray.as_raw(), w, h);
        let detected = detector.detect(&mut image_data);
        if detected.is_empty() {
            no_face_count += 1;
            continue;
        }
        // For each face, crop and hash
        for face in detected {
            let rect = face.bbox();
            let x = rect.x().max(0) as u32;
            let y = rect.y().max(0) as u32;
            let w = rect.width().max(0) as u32;
            let h = rect.height().max(0) as u32;
            if w < 20 || h < 20 {
                continue;
            }
            // Expand rect slightly (10%) to include context
            let pad_x = w / 10;
            let pad_y = h / 10;
            let x0 = x.saturating_sub(pad_x);
            let y0 = y.saturating_sub(pad_y);
            let x1 = (x + w + pad_x).min(gray.width());
            let y1 = (y + h + pad_y).min(gray.height());
            if x1 <= x0 || y1 <= y0 {
                continue;
            }
            let cropped = image::imageops::crop_imm(&gray, x0, y0, x1 - x0, y1 - y0).to_image();
            let hash = dhash_face_crop(&cropped);
            faces.push(FaceEntry {
                path: path.clone(),
                hash,
                rect: (x0, y0, x1 - x0, y1 - y0),
                size,
            });
            // Only first face per image for low-end (avoid duplicate person per photo)
            break;
        }
        // Low-end cap: stop after 60 faces found
        if faces.len() >= 60 {
            break;
        }
    }

    eprintln!("[faces] detected faces={} no_face_images={}", faces.len(), no_face_count);
    // If fewer than 3 faces detected, not enough to cluster — fallback to folder grouping
    if faces.len() < 3 {
        eprintln!("[faces] <3 faces — falling back to folder grouping");
        return None;
    }

    // Cluster by Hamming distance < 12 (tuned for dHash)
    let mut clusters: Vec<Vec<FaceEntry>> = Vec::new();
    for face in faces {
        let mut placed = false;
        for cluster in &mut clusters {
            if let Some(first) = cluster.first() {
                if hamming(first.hash, face.hash) < 12 {
                    cluster.push(face.clone());
                    placed = true;
                    break;
                }
            }
        }
        if !placed {
            clusters.push(vec![face]);
        }
        if clusters.len() >= 20 {
            break;
        }
    }

    // Filter small clusters (<2 faces) unless we have many
    let mut filtered: Vec<Vec<FaceEntry>> = clusters.into_iter().filter(|c| c.len() >= 2).collect();
    // If all clusters are singletons, keep the 3 largest anyway for demo
    if filtered.is_empty() {
        // Re-cluster with higher threshold
        eprintln!("[faces] all singleton clusters — fallback");
        return None; // fallback
    }

    // Sort deterministically: size desc, then centroid hash asc (stable keys)
    filtered.sort_by(|a, b| {
        b.len()
            .cmp(&a.len())
            .then_with(|| a[0].hash.cmp(&b[0].hash))
    });
    filtered.truncate(12); // max 12 people

    // Load persistent labels for Immich-like rename
    let labels = crate::people::load_labels();

    let mut groups: Vec<MediaGroup> = Vec::new();
    for (idx, cluster) in filtered.into_iter().enumerate() {
        let count = cluster.len();
        let total_size: u64 = cluster.iter().map(|f| f.size).sum();
        let preview: Vec<String> = cluster.iter().take(4).map(|f| f.path.clone()).collect();
        // Stable key based on centroid hash (deterministic across rebuilds)
        let centroid_hash = cluster.first().map(|f| f.hash).unwrap_or(0);
        let stable_key = format!("person_{:016x}", centroid_hash);
        let legacy_key = format!("person_{}", idx + 1);
        let default_label = format!("Person {}", idx + 1);
        // Prefer stable key label, fallback to legacy idx label for migration
        let label = labels
            .get(&stable_key)
            .cloned()
            .or_else(|| labels.get(&legacy_key).cloned())
            .unwrap_or(default_label);
        let key = stable_key;
        groups.push(MediaGroup {
            key,
            label,
            count,
            total_size,
            preview,
            face_count: Some(count),
        });
    }

    // Also add "No face" group if significant
    if no_face_count > 5 {
        // Could add as extra group, but for now just return face groups
    }

    if groups.is_empty() { None } else { Some(groups) }
}
