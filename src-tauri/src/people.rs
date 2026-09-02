use std::collections::HashMap;
use std::path::PathBuf;
use std::fs;

// Persistent label store for People (Immich/Google Photos-like)
// Stored as JSON HashMap<cluster_key, label> in %APPDATA%\com.fileexplorer.app\people_labels.json
// Fallback: %TEMP%\file_explorer_people_labels.json
// Keys are stable deterministic centroid hashes like person_0123abcd... or legacy person_1

fn labels_path() -> PathBuf {
    // Prefer APPDATA (Roaming) on Windows
    if let Ok(appdata) = std::env::var("APPDATA") {
        let dir = PathBuf::from(appdata).join("com.fileexplorer.app");
        let _ = fs::create_dir_all(&dir);
        return dir.join("people_labels.json");
    }
    if let Ok(userprofile) = std::env::var("USERPROFILE") {
        let dir = PathBuf::from(userprofile)
            .join("AppData")
            .join("Roaming")
            .join("com.fileexplorer.app");
        let _ = fs::create_dir_all(&dir);
        return dir.join("people_labels.json");
    }
    // Fallback to temp dir (always writable)
    std::env::temp_dir().join("file_explorer_people_labels.json")
}

pub fn load_labels() -> HashMap<String, String> {
    let path = labels_path();
    if !path.exists() {
        return HashMap::new();
    }
    match fs::read_to_string(&path) {
        Ok(s) => serde_json::from_str(&s).unwrap_or_default(),
        Err(_) => HashMap::new(),
    }
}

pub fn save_labels(map: &HashMap<String, String>) -> Result<(), String> {
    let path = labels_path();
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let json = serde_json::to_string_pretty(map).map_err(|e| e.to_string())?;
    // atomic via tmp file
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, json).map_err(|e| e.to_string())?;
    // rename, with fallback to copy if cross-device
    if fs::rename(&tmp, &path).is_err() {
        let _ = fs::copy(&tmp, &path);
        let _ = fs::remove_file(&tmp);
    }
    Ok(())
}

pub fn get_person_labels() -> HashMap<String, String> {
    load_labels()
}

pub fn rename_person(person_key: String, label: String) -> Result<String, String> {
    let mut map = load_labels();
    let trimmed = label.trim().to_string();
    if trimmed.is_empty() {
        // Empty label => remove (revert to default Person N)
        map.remove(&person_key);
        save_labels(&map)?;
        return Ok(String::new());
    }
    if trimmed.len() > 48 {
        return Err("label too long (max 48 chars)".into());
    }
    // Basic sanitization: disallow path separators
    if trimmed.contains('/') || trimmed.contains('\\') {
        return Err("label cannot contain / or \\".into());
    }
    map.insert(person_key.clone(), trimmed.clone());
    save_labels(&map)?;
    Ok(trimmed)
}

pub fn delete_person(person_key: String) -> Result<String, String> {
    let mut map = load_labels();
    map.remove(&person_key);
    save_labels(&map)?;
    Ok(person_key)
}

pub fn get_labels_path_debug() -> String {
    labels_path().to_string_lossy().to_string()
}
