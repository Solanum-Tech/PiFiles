mod faces;
mod fs;
mod media;
mod people;
mod search;
mod thumbnail;

use fs::{DriveInfo, FileEntry};
use media::{DeviceGroups, PeopleGroups};
use search::SearchResponse;

// PiFiles - Lightweight File Explorer (Tauri, paginated, low-memory)

#[tauri::command]
fn list_drives() -> Vec<DriveInfo> {
    fs::list_drives()
}

#[tauri::command]
fn list_dir(path: String) -> Result<Vec<FileEntry>, String> {
    fs::list_dir(&path)
}

#[tauri::command]
fn search_files(query: String, offset: Option<usize>, limit: Option<usize>) -> SearchResponse {
    let o = offset.unwrap_or(0);
    let l = limit.unwrap_or(100);
    search::search_files(&query, o, l)
}

#[tauri::command]
fn get_index_status() -> serde_json::Value {
    search::get_index_status()
}

#[tauri::command]
fn rebuild_index() -> serde_json::Value {
    // Force rebuild in background, return immediate status
    std::thread::spawn(|| {
        // Clear and rebuild
        // Note: we expose via separate thread to not block UI
        search::spawn_background_index();
    });
    serde_json::json!({"rebuilding": true})
}

#[tauri::command]
fn get_media_groups(root: Option<String>) -> PeopleGroups {
    let r = root.unwrap_or_default();
    media::get_media_groups(&r)
}

#[tauri::command]
fn get_device_groups() -> DeviceGroups {
    media::get_device_groups()
}

#[tauri::command]
fn get_thumbnail(path: String) -> Result<String, String> {
    thumbnail::get_thumbnail(path)
}

#[tauri::command]
fn get_file_preview(path: String) -> Result<String, String> {
    thumbnail::get_file_preview(path)
}

#[tauri::command]
fn greet(name: String) -> String {
    format!("Hello, {}! PiFiles ready.", name)
}

#[tauri::command]
fn get_person_labels() -> std::collections::HashMap<String, String> {
    people::get_person_labels()
}

#[allow(non_snake_case)]
#[tauri::command]
fn rename_person(personKey: String, label: String) -> Result<String, String> {
    people::rename_person(personKey, label)
}

#[allow(non_snake_case)]
#[tauri::command]
fn delete_person(personKey: String) -> Result<String, String> {
    people::delete_person(personKey)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|_app| {
            // Build search index in background on startup — makes subsequent searches instant (NTFS MFT + cache)
            search::spawn_background_index();
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            greet,
            list_drives,
            list_dir,
            search_files,
            get_index_status,
            rebuild_index,
            get_media_groups,
            get_device_groups,
            get_thumbnail,
            get_file_preview,
            get_person_labels,
            rename_person,
            delete_person
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
