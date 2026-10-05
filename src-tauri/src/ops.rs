//! Small synchronous file operations: create and rename. Copy, move and delete run as
//! background jobs with live progress in `fileops`.

use std::path::Path;

pub fn create_folder_blocking(path: String) -> Result<String, String> {
    let p = Path::new(&path);
    if p.exists() { return Err(format!("Already exists: {}", path)); }
    std::fs::create_dir_all(p).map_err(|e| e.to_string())?;
    // invalidate parent so parent folder size recomputes on next request
    if let Some(parent) = Path::new(&path).parent().map(|pp| pp.to_string_lossy().to_string()) {
        crate::fs::invalidate_folder_cache(&parent);
    }
    crate::fs::invalidate_folder_cache(&path);
    Ok(path)
}

/// Creates a new empty file; never overwrites an existing one.
pub fn create_file_blocking(path: String) -> Result<String, String> {
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .map_err(|e| if e.kind() == std::io::ErrorKind::AlreadyExists { format!("Already exists: {path}") } else { e.to_string() })?;
    if let Some(parent) = Path::new(&path).parent().map(|pp| pp.to_string_lossy().to_string()) {
        crate::fs::invalidate_folder_cache(&parent);
    }
    Ok(path)
}

pub fn rename_item_blocking(old: String, new: String) -> Result<String, String> {
    let o = Path::new(&old);
    let n = Path::new(&new);
    if !o.exists() { return Err(format!("Source not found: {}", old)); }
    if n.exists() { return Err(format!("Destination already exists: {}", new)); }
    if let Some(parent) = n.parent() { let _ = std::fs::create_dir_all(parent); }
    std::fs::rename(o, n).map_err(|e| e.to_string())?;
    // both old and new parents change size
    crate::fs::invalidate_folder_cache(&old);
    crate::fs::invalidate_folder_cache(&new);
    if let Some(parent) = Path::new(&old).parent().map(|pp| pp.to_string_lossy().to_string()) {
        crate::fs::invalidate_folder_cache(&parent);
    }
    if let Some(parent) = Path::new(&new).parent().map(|pp| pp.to_string_lossy().to_string()) {
        crate::fs::invalidate_folder_cache(&parent);
    }
    Ok(new)
}
