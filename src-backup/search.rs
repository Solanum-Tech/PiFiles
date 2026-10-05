// Placeholder for fast NTFS search
// Will implement USN journal reading or MFT parsing for realtime results

use walkdir::WalkDir;

/// Scan a directory recursively (placeholder)
pub fn scan_directory(path: &str) -> Vec<String> {
    let mut results = Vec::new();
    for entry in WalkDir::new(path).into_iter().filter_map(|e| e.ok()) {
        if entry.file_type().is_file() {
            results.push(entry.path().display().to_string());
        }
    }
    results
}
