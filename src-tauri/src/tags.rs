use crate::search::{SearchResponse, SearchResult};
use rayon::prelude::*;
use std::collections::HashSet;
use std::path::Path;
use std::time::SystemTime;
use walkdir::WalkDir;

// Extension sets per spec
const IMAGE_EXTS: &[&str] = &["jpg", "jpeg", "png", "heic", "webp", "bmp", "gif", "svg"];
const VIDEO_EXTS: &[&str] = &["mp4", "mov", "avi", "mkv", "webm", "m4a"];
const DOCUMENT_EXTS: &[&str] = &[
    "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "txt", "md", "csv", "json", "html", "xml",
];
const ARCHIVE_EXTS: &[&str] = &["zip", "rar", "7z", "tar", "gz", "tgz", "jar", "apk"];

// Low-end caps
const MAX_DEPTH: usize = 6;
const PER_DRIVE_MATCH_CAP: usize = 5000;
const PER_DRIVE_SCAN_CAP: usize = 15000;
const TOTAL_CAP: usize = 10000;

fn get_roots(root: Option<String>) -> Vec<String> {
    if let Some(r) = root {
        let t = r.trim().to_string();
        if !t.is_empty() && Path::new(&t).exists() {
            return vec![t];
        }
        // empty or not exists -> fall through to all drives
        if !t.is_empty() {
            // still try single root (will be empty result if not exists)
            return vec![t];
        }
    }
    #[cfg(windows)]
    {
        let mut r = Vec::new();
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
    }
    #[cfg(not(windows))]
    {
        vec!["/".to_string()]
    }
}

fn normalize_exts(exts: &[&str]) -> HashSet<String> {
    exts.iter().map(|s| s.to_lowercase()).collect()
}

fn is_archive_match(name_lower: &str, ext: &str, set: &HashSet<String>) -> bool {
    if set.contains(ext) {
        return true;
    }
    // handle .tar.gz double extension
    if name_lower.ends_with(".tar.gz") && (set.contains("tar.gz") || set.contains("gz")) {
        return true;
    }
    if name_lower.ends_with(".tgz") && set.contains("tgz") {
        return true;
    }
    false
}

fn list_by_exts(
    root: Option<String>,
    offset: usize,
    limit: usize,
    exts: &[&str],
    label: &str,
) -> SearchResponse {
    let start = SystemTime::now();
    let limit = limit.clamp(1, 200);
    let roots = get_roots(root);
    let ext_set = normalize_exts(exts);
    let is_archive = label == "archives";

    // Parallel per-drive scan
    let mut all: Vec<SearchResult> = roots
        .par_iter()
        .flat_map(|root_path| {
            let mut local = Vec::new();
            let walker = WalkDir::new(root_path)
                .max_depth(MAX_DEPTH)
                .follow_links(false)
                .into_iter()
                .filter_map(|e| e.ok());

            let mut scanned: usize = 0;
            for entry in walker {
                if scanned >= PER_DRIVE_SCAN_CAP {
                    break;
                }
                if local.len() >= PER_DRIVE_MATCH_CAP {
                    break;
                }
                scanned += 1;
                let ft = entry.file_type();
                if ft.is_dir() {
                    // skip hidden system dirs to reduce scan but still allow depth
                    if let Some(name) = entry.file_name().to_str() {
                        if name.starts_with('$') && entry.depth() <= 2 {
                            // e.g. $Recycle.Bin, $WinREAgent - skip walking inside if possible
                            // walkdir still iterates; we just skip but continue
                        }
                    }
                    continue;
                }
                let path = entry.path();
                let name = entry.file_name().to_string_lossy().to_string();
                let name_lower = name.to_lowercase();
                let ext = path
                    .extension()
                    .and_then(|e| e.to_str())
                    .unwrap_or("")
                    .to_lowercase();

                let matched = if is_archive {
                    is_archive_match(&name_lower, &ext, &ext_set)
                } else {
                    ext_set.contains(&ext)
                };
                if !matched {
                    continue;
                }
                let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
                let path_str = path.to_string_lossy().to_string();
                local.push(SearchResult {
                    path: path_str,
                    name,
                    is_dir: false,
                    size,
                    matched: ext,
                });
                if local.len() >= PER_DRIVE_MATCH_CAP {
                    break;
                }
            }
            local
        })
        .collect();

    // Cap total for low-end
    if all.len() > TOTAL_CAP {
        all.truncate(TOTAL_CAP);
    }

    // Sort: alphabetical case-insensitive, then by path length (stable)
    all.sort_by(|a, b| {
        a.name
            .to_lowercase()
            .cmp(&b.name.to_lowercase())
            .then_with(|| a.path.len().cmp(&b.path.len()))
    });

    let total = all.len();
    let paginated: Vec<SearchResult> = all.into_iter().skip(offset).take(limit).collect();
    let has_more = total > offset + paginated.len();
    let took_ms = SystemTime::now()
        .duration_since(start)
        .unwrap_or_default()
        .as_millis();

    SearchResponse {
        results: paginated,
        total,
        query: label.to_string(),
        has_more,
        took_ms,
        indexed: false,
    }
}

pub fn list_images(root: Option<String>, offset: usize, limit: usize) -> SearchResponse {
    list_by_exts(root, offset, limit, IMAGE_EXTS, "images")
}

pub fn list_videos(root: Option<String>, offset: usize, limit: usize) -> SearchResponse {
    list_by_exts(root, offset, limit, VIDEO_EXTS, "videos")
}

pub fn list_documents(root: Option<String>, offset: usize, limit: usize) -> SearchResponse {
    list_by_exts(root, offset, limit, DOCUMENT_EXTS, "documents")
}

pub fn list_archives(root: Option<String>, offset: usize, limit: usize) -> SearchResponse {
    list_by_exts(root, offset, limit, ARCHIVE_EXTS, "archives")
}
