mod archive;
mod curtain;
mod props;
mod docs;
mod integrity;
mod vault;
mod imgedit;
mod security;
#[cfg(test)]
mod robustness;
mod perf;
mod updates;
mod fileops;
mod library;
mod raw;
mod shellmenu;
mod system;
mod versions;
mod face_ai;
mod face_cluster;
mod face_model;
mod faces;
mod fs;
mod media;
mod media_player;
mod ops;
mod people;
mod search;
mod spreadsheet;
mod tags;
mod thumbnail;
mod viewer;

use fs::{DriveInfo, FileEntry};
use media::{DeviceGroups, PeopleGroups};
use search::SearchResponse;

// PiFiles - Lightweight File Explorer (Tauri, paginated, low-memory)

// All FS-heavy commands are async via spawn_blocking so UI never hangs

#[tauri::command]
async fn list_drives() -> Vec<DriveInfo> {
    tauri::async_runtime::spawn_blocking(|| fs::list_drives())
        .await
        .unwrap_or_default()
}

#[tauri::command]
async fn list_dir(path: String) -> Result<Vec<FileEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        // "\\server" is a computer, not a folder: list its shared folders.
        #[cfg(windows)]
        {
            let t = path.trim_end_matches('\\');
            if t.starts_with(r"\\") && t.len() > 2 && !t[2..].contains('\\') {
                return system::server_shares(t);
            }
        }
        fs::list_dir(&path)
    })
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn get_files_info(paths: Vec<String>) -> Vec<FileEntry> {
    tauri::async_runtime::spawn_blocking(move || fs::get_files_info(&paths))
        .await
        .unwrap_or_default()
}

#[tauri::command]
async fn get_folder_size(app: tauri::AppHandle, path: String) -> Result<u64, String> {
    // CACHE: check Rust cache first - stays put, only recomputes when folder changes.
    // If hit and fresh (mtime unchanged, <5min), return instantly WITHOUT walk and WITHOUT op://progress spam.
    // This fixes "calculates very often on every hover/selection" - now cached once per launch or until ops invalidation.
    if let Some(cached) = fs::get_cached_folder_size(&path) {
        return Ok(cached);
    }
    // Full recursive walk (no 2000 / depth-4 cap) - accurate like Explorer (~10GB for Program Files)
    // Runs off the async runtime via blocking pool so UI never hangs (100k files ok)
    // Emits incremental op://progress ONLY when actually calculating (not cached) so frontend can show "Calculating... 1,234 files • 2.1 GB"
    let app2 = app.clone();
    let p = path.clone();
    tauri::async_runtime::spawn_blocking(move || {
        // double-check inside blocking pool (race: another thread may have cached while we queued)
        if let Some(cached) = fs::get_cached_folder_size(&p) {
            return Ok(cached);
        }
        use tauri::Emitter;
        let start = std::time::Instant::now();
        let mut last_emit = std::time::Instant::now();
        let mut on_progress = |files: usize, bytes: u64, skipped: usize| {
            // Throttle emits to ~5Hz to avoid flooding the frontend on fast SSDs
            if last_emit.elapsed().as_millis() < 180 && files % 2048 != 0 {
                return;
            }
            last_emit = std::time::Instant::now();
            let elapsed = start.elapsed().as_secs_f64().max(0.001);
            let speed_bps = (bytes as f64 / elapsed) as u64;
            // Reuse existing op://progress channel; frontend filters op=="size" to update folder-size UI
            // Payload keeps backward-compat fields (id, op, current, bytes_copied, total_bytes) plus path/bytes
            let payload = serde_json::json!({
                "id": format!("size:{}", p),
                "op": "size",
                "path": p,
                "current": files,
                "total": 0,
                "file": p,
                "bytes": bytes,
                "bytes_copied": bytes,
                "total_bytes": bytes,
                "percent": 0.0,
                "speed_bps": speed_bps,
                "skipped": skipped,
                "done": false,
                "error": null
            });
            let _ = app2.emit("op://progress", payload);
        };
        let cb: &mut dyn FnMut(usize, u64, usize) = &mut on_progress;
        let res = fs::get_folder_size_inner(&p, Some(cb));
        // Final emit with done=true and accurate speed for "Calculating... X files • Y GB (done)"
        if let Ok(total) = &res {
            let elapsed = start.elapsed().as_secs_f64().max(0.001);
            let speed_bps = (*total as f64 / elapsed) as u64;
            let payload = serde_json::json!({
                "id": format!("size:{}", p),
                "op": "size",
                "path": p,
                "current": 0, // frontend will use bytes; current files already emitted in last tick
                "total": 0,
                "file": p,
                "bytes": total,
                "bytes_copied": total,
                "total_bytes": total,
                "percent": 100.0,
                "speed_bps": speed_bps,
                "skipped": 0,
                "done": true,
                "error": null
            });
            let _ = app2.emit("op://progress", payload);
        } else if let Err(e) = &res {
            let payload = serde_json::json!({
                "id": format!("size:{}", p),
                "op": "size",
                "path": p,
                "current": 0,
                "total": 0,
                "file": p,
                "bytes": 0,
                "bytes_copied": 0,
                "total_bytes": 0,
                "percent": 0.0,
                "speed_bps": 0,
                "skipped": 0,
                "done": true,
                "error": e
            });
            let _ = app2.emit("op://progress", payload);
        }
        // Cache the successful result so next hover/selection stays put (<5min + mtime check)
        if let Ok(total) = &res {
            fs::put_folder_size_cache(&p, *total);
        }
        res
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn search_files(query: String, offset: Option<usize>, limit: Option<usize>) -> SearchResponse {
    let q = query.clone();
    let o = offset.unwrap_or(0);
    let l = limit.unwrap_or(100);
    tauri::async_runtime::spawn_blocking(move || search::search_files(&q, o, l))
        .await
        .unwrap_or(SearchResponse { results: vec![], total: 0, query: query.clone(), has_more: false, took_ms: 0, indexed: false })
}

#[tauri::command]
fn get_index_status() -> serde_json::Value {
    search::get_index_status()
}

#[tauri::command(async)]
fn rebuild_index() -> serde_json::Value {
    // Force rebuild in background, return immediate status
    search::rebuild();
    serde_json::json!({"rebuilding": true})
}

#[tauri::command]
async fn get_media_groups(root: Option<String>) -> PeopleGroups {
    let r = root.unwrap_or_default();
    // Non-blocking: cache/fallback is instant, heavy work is in background thread
    // Use spawn_blocking to ensure even lightweight WalkDir (folder fallback) never blocks async runtime
    tauri::async_runtime::spawn_blocking(move || media::get_media_groups(&r))
        .await
        .unwrap_or(PeopleGroups { groups: vec![] })
}

#[tauri::command(async)]
fn start_face_scan(root: Option<String>, force: Option<bool>) -> serde_json::Value {
    let _r = root.unwrap_or_default();
    let force = force.unwrap_or(false);
    if crate::faces::is_scanning() {
        return serde_json::json!({"started": false, "reason": "already_scanning", "status": crate::faces::get_scan_status()});
    }
    // Always do full machine scan for People tab - per-folder scans are too limited
    // If force=true (Redetect button), bypass cache and force fresh scan
    crate::faces::spawn_full_machine_scan(force);
    serde_json::json!({"started": true, "status": crate::faces::get_scan_status()})
}

#[tauri::command]
fn get_face_scan_status() -> serde_json::Value {
    crate::faces::get_scan_status()
}

#[tauri::command]
fn get_all_drives_scan_status() -> serde_json::Value {
    // alias for full-machine scan - reuse get_face_scan_status to report scanning 45/240 images across C,D,F...
    crate::faces::get_scan_status()
}

#[tauri::command]
async fn get_device_groups() -> DeviceGroups {
    tauri::async_runtime::spawn_blocking(|| media::get_device_groups())
        .await
        .unwrap_or(DeviceGroups { by_drive: vec![], by_type: vec![], by_device: vec![] })
}

#[tauri::command]
async fn get_thumbnail(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || thumbnail::get_thumbnail(path))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn get_file_preview(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || thumbnail::get_file_preview(path))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn get_original_data_url(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || thumbnail::get_original_data_url(path))
        .await
        .map_err(|e| e.to_string())?
}

// --- Viewer (built-in lightweight) ---
#[tauri::command]
async fn read_text_file(path: String, limit: Option<usize>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || viewer::read_text_file(path, limit))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn read_file_base64(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || viewer::read_file_base64(path))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn get_hex_preview(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || viewer::get_hex_preview(path))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn list_archive(path: String) -> Result<Vec<viewer::ArchiveEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || viewer::list_archive(path))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn open_file(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || viewer::open_file(path))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn list_images(root: Option<String>, offset: Option<usize>, limit: Option<usize>) -> SearchResponse {
    let r = root.clone();
    let o = offset.unwrap_or(0);
    let l = limit.unwrap_or(100);
    tauri::async_runtime::spawn_blocking(move || tags::list_images(r, o, l))
        .await
        .unwrap_or(SearchResponse { results: vec![], total: 0, query: "images".to_string(), has_more: false, took_ms: 0, indexed: false })
}

#[tauri::command]
async fn list_videos(root: Option<String>, offset: Option<usize>, limit: Option<usize>) -> SearchResponse {
    let r = root.clone();
    let o = offset.unwrap_or(0);
    let l = limit.unwrap_or(100);
    tauri::async_runtime::spawn_blocking(move || tags::list_videos(r, o, l))
        .await
        .unwrap_or(SearchResponse { results: vec![], total: 0, query: "videos".to_string(), has_more: false, took_ms: 0, indexed: false })
}

#[tauri::command]
async fn list_documents(root: Option<String>, offset: Option<usize>, limit: Option<usize>) -> SearchResponse {
    let r = root.clone();
    let o = offset.unwrap_or(0);
    let l = limit.unwrap_or(100);
    tauri::async_runtime::spawn_blocking(move || tags::list_documents(r, o, l))
        .await
        .unwrap_or(SearchResponse { results: vec![], total: 0, query: "documents".to_string(), has_more: false, took_ms: 0, indexed: false })
}

#[tauri::command]
async fn list_archives(root: Option<String>, offset: Option<usize>, limit: Option<usize>) -> SearchResponse {
    let r = root.clone();
    let o = offset.unwrap_or(0);
    let l = limit.unwrap_or(100);
    tauri::async_runtime::spawn_blocking(move || tags::list_archives(r, o, l))
        .await
        .unwrap_or(SearchResponse { results: vec![], total: 0, query: "archives".to_string(), has_more: false, took_ms: 0, indexed: false })
}

#[tauri::command(async)]
fn get_person_labels() -> std::collections::HashMap<String, String> {
    people::get_person_labels()
}

#[allow(non_snake_case)]
#[tauri::command(async)]
fn rename_person(personKey: String, label: String) -> Result<String, String> {
    people::rename_person(personKey, label)
}

#[allow(non_snake_case)]
#[tauri::command(async)]
fn delete_person(personKey: String) -> Result<String, String> {
    people::delete_person(personKey)
}

#[allow(non_snake_case)]
#[tauri::command(async)]
fn merge_persons(personKeys: Vec<String>, label: Option<String>) -> Result<media::MediaGroup, String> {
    people::merge_persons(personKeys, label)
}

// --- Ops (fast copy/paste/move/delete with progress, rivals native) ---



#[tauri::command]
async fn create_folder(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || ops::create_folder_blocking(path))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn create_file(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || ops::create_file_blocking(path))
        .await
        .map_err(|e| e.to_string())?
}

// ---------- viewer: movies, archives, spreadsheets ----------

#[tauri::command]
async fn media_probe(path: String) -> Result<media_player::MediaInfo, String> {
    tauri::async_runtime::spawn_blocking(move || media_player::probe(std::path::Path::new(&path)))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn media_subtitle(path: String, stream: Option<usize>, external: Option<String>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        media_player::subtitle_vtt(std::path::Path::new(&path), stream, external.as_deref().map(std::path::Path::new))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn media_open(path: String, audio: Option<usize>, start: Option<f64>, mode: String, hevc: Option<bool>, subs: Option<Vec<usize>>) -> Result<media_player::StreamInfo, String> {
    tauri::async_runtime::spawn_blocking(move || {
        media_player::open(std::path::Path::new(&path), audio, start.unwrap_or(0.0), &mode, hevc.unwrap_or(false), &subs.unwrap_or_default())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Next chunk of a playback stream as raw bytes (an empty buffer = end of stream).
#[tauri::command]
async fn media_read(id: u64) -> Result<tauri::ipc::Response, String> {
    let chunk = tauri::async_runtime::spawn_blocking(move || media_player::read(id)).await.map_err(|e| e.to_string())??;
    Ok(tauri::ipc::Response::new(chunk))
}

/// Subtitle cues produced so far by a playback session (no extra pass over the file).
#[tauri::command]
fn media_subs(id: u64, stream: usize, from: u64) -> Result<media_player::SubsChunk, String> {
    media_player::subs_read(id, stream, from)
}

#[tauri::command]
fn media_close(id: u64) {
    media_player::close(id)
}

#[tauri::command]
fn media_available() -> bool {
    media_player::available()
}

#[tauri::command]
async fn archive_list(path: String, password: Option<String>) -> Result<archive::Listing, String> {
    tauri::async_runtime::spawn_blocking(move || archive::list(std::path::Path::new(&path), password.as_deref()))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn archive_extract_entry(path: String, entry: String, password: Option<String>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        archive::extract_entry(std::path::Path::new(&path), &entry, password.as_deref()).map(|p| p.to_string_lossy().to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn archive_extract_all(path: String, password: Option<String>) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        archive::extract_all(std::path::Path::new(&path), password.as_deref())
            .map(|(dest, count)| serde_json::json!({ "dest": dest.to_string_lossy(), "count": count }))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn sheet_read(path: String, sheet: Option<String>) -> Result<spreadsheet::Sheet, String> {
    tauri::async_runtime::spawn_blocking(move || spreadsheet::read(std::path::Path::new(&path), sheet.as_deref()))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command(async)]
fn get_known_folders() -> std::collections::HashMap<String, String> {
    fs::known_folders()
}

#[tauri::command]
async fn rename_item(old: String, new: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || ops::rename_item_blocking(old, new))
        .await
        .map_err(|e| e.to_string())?
}




// Window control commands for custom borderless titlebar
#[tauri::command]
fn minimize_window(window: tauri::Window) {
    let _ = window.minimize();
}

#[tauri::command]
fn toggle_maximize_window(window: tauri::Window) -> bool {
    if window.is_maximized().unwrap_or(false) {
        let _ = window.unmaximize();
        false
    } else {
        let _ = window.maximize();
        true
    }
}

#[tauri::command]
fn is_window_maximized(window: tauri::Window) -> bool {
    window.is_maximized().unwrap_or(false)
}

#[tauri::command]
fn close_window(window: tauri::Window) {
    let _ = window.close();
}

#[cfg(windows)]
fn set_transitions(hwnd: windows::Win32::Foundation::HWND, enabled: bool) {
    use windows::Win32::Graphics::Dwm::{DwmSetWindowAttribute, DWMWA_TRANSITIONS_FORCEDISABLED};
    let off: i32 = if enabled { 0 } else { 1 }; // Win32 BOOL
    unsafe {
        let _ = DwmSetWindowAttribute(hwnd, DWMWA_TRANSITIONS_FORCEDISABLED, &off as *const _ as *const _, std::mem::size_of_val(&off) as u32);
    }
}

/// Tells the taskbar that the window is full screen so it steps aside. Windows guesses this on
/// its own only for opaque windows; PiFiles' window is see-through (Mica/glass), so it must ask.
#[cfg(windows)]
fn mark_taskbar_fullscreen(hwnd: windows::Win32::Foundation::HWND, on: bool) {
    use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_INPROC_SERVER};
    use windows::Win32::UI::Shell::{ITaskbarList2, TaskbarList};
    unsafe {
        if let Ok(tb) = CoCreateInstance::<_, ITaskbarList2>(&TaskbarList, None, CLSCTX_INPROC_SERVER) {
            if tb.HrInit().is_ok() {
                let _ = tb.MarkFullscreenWindow(hwnd, on);
            }
        }
    }
}

/// Covers the monitor with a snapshot of the screen (returns once it is shown), hiding the window
/// and page changes of a full-screen switch. Windows only; elsewhere it does nothing.
#[tauri::command]
async fn fs_cover(window: tauri::Window, ms: Option<u32>) {
    #[cfg(windows)]
    let h = window.hwnd().map(|h| h.0 as isize).unwrap_or(0);
    #[cfg(not(windows))]
    let h = {
        let _ = window;
        0
    };
    let ms = ms.unwrap_or(110).min(400);
    let _ = tauri::async_runtime::spawn_blocking(move || curtain::cover(h, ms)).await;
}

/// Fades the cover out again.
#[tauri::command]
fn fs_reveal(ms: Option<u32>) {
    curtain::reveal(ms.unwrap_or(180).min(600));
}

/// Solid black behind the page while the movie player is full screen (the window is normally
/// see-through for Mica/glass, which let the desktop show while the window resized).
#[tauri::command]
fn player_backdrop(window: tauri::WebviewWindow, opaque: bool) {
    let c = if opaque { tauri::window::Color(0, 0, 0, 255) } else { tauri::window::Color(0, 0, 0, 0) };
    let _ = window.set_background_color(Some(c));
}

/// Saved window placement while PiFiles covers the monitor (None = not full screen).
#[cfg(windows)]
static FULLSCREEN_PLACEMENT: std::sync::Mutex<Option<windows::Win32::UI::WindowsAndMessaging::WINDOWPLACEMENT>> = std::sync::Mutex::new(None);

#[tauri::command]
fn toggle_fullscreen(window: tauri::Window, on: Option<bool>) -> bool {
    // Full screen on Windows: a maximized borderless window is limited to the work area (the
    // taskbar stays visible), and leaving "maximized" the normal way briefly shows the restored
    // size. So the window's placement is saved and swapped in one step for a normal window
    // exactly the size of the monitor; leaving full screen puts the saved placement back
    // (still maximized, same size), so only the player changes size.
    #[cfg(windows)]
    {
        use windows::Win32::Foundation::HWND;
        use windows::Win32::Graphics::Gdi::{GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST};
        use windows::Win32::UI::WindowsAndMessaging::{
            GetWindowPlacement, SetWindowPlacement, SetWindowPos, HWND_TOP, SWP_FRAMECHANGED, SWP_NOOWNERZORDER, SW_SHOWNORMAL, WINDOWPLACEMENT,
        };
        let Ok(h) = window.hwnd() else { return false };
        let hwnd = HWND(h.0 as _);
        let mut saved = FULLSCREEN_PLACEMENT.lock().unwrap();
        let is_fs = saved.is_some();
        let want = on.unwrap_or(!is_fs);
        if want == is_fs {
            return is_fs;
        }
        // No minimize/maximize animation for this switch (it showed the desktop through the
        // window while resizing); normal animations come back a moment later.
        set_transitions(hwnd, false);
        let raw = hwnd.0 as isize;
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(600));
            set_transitions(HWND(raw as _), true);
        });
        unsafe {
            if want {
                let mut wp = WINDOWPLACEMENT { length: std::mem::size_of::<WINDOWPLACEMENT>() as u32, ..Default::default() };
                if GetWindowPlacement(hwnd, &mut wp).is_err() {
                    return false;
                }
                let mon = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
                let mut mi = MONITORINFO { cbSize: std::mem::size_of::<MONITORINFO>() as u32, ..Default::default() };
                if !GetMonitorInfoW(mon, &mut mi).as_bool() {
                    return false;
                }
                let m = mi.rcMonitor;
                *saved = Some(wp);
                // Normal (not maximized) placement covering the monitor, applied in one step.
                // rcNormalPosition is in work-area coordinates, so SetWindowPos then pins the
                // exact screen rectangle whatever side the taskbar is on.
                let mut fs = wp;
                fs.showCmd = SW_SHOWNORMAL.0 as u32;
                fs.rcNormalPosition = windows::Win32::Foundation::RECT {
                    left: m.left - mi.rcWork.left + m.left,
                    top: m.top - mi.rcWork.top + m.top,
                    right: m.right - mi.rcWork.left + m.left,
                    bottom: m.bottom - mi.rcWork.top + m.top,
                };
                let _ = window.set_shadow(false); // the shadow frame showed as grey edges
                let _ = SetWindowPlacement(hwnd, &fs);
                let _ = SetWindowPos(hwnd, Some(HWND_TOP), m.left, m.top, m.right - m.left, m.bottom - m.top, SWP_NOOWNERZORDER | SWP_FRAMECHANGED);
                mark_taskbar_fullscreen(hwnd, true);
            } else if let Some(wp) = saved.take() {
                mark_taskbar_fullscreen(hwnd, false);
                let _ = SetWindowPlacement(hwnd, &wp);
                let _ = window.set_shadow(true);
                let _ = SetWindowPos(hwnd, None, 0, 0, 0, 0, SWP_NOOWNERZORDER | SWP_FRAMECHANGED | windows::Win32::UI::WindowsAndMessaging::SWP_NOMOVE | windows::Win32::UI::WindowsAndMessaging::SWP_NOSIZE | windows::Win32::UI::WindowsAndMessaging::SWP_NOZORDER);
            }
        }
        want
    }
    #[cfg(not(windows))]
    {
        let is_fs = window.is_fullscreen().unwrap_or(false);
        let want = on.unwrap_or(!is_fs);
        if want != is_fs {
            let _ = window.set_fullscreen(want);
        }
        want
    }
}

#[tauri::command]
fn is_fullscreen(window: tauri::Window) -> bool {
    #[cfg(windows)]
    {
        let _ = window;
        FULLSCREEN_PLACEMENT.lock().unwrap().is_some()
    }
    #[cfg(not(windows))]
    {
        window.is_fullscreen().unwrap_or(false)
    }
}

// Machine Learning & Active Learning Face Suggestions
#[tauri::command(async)]
fn get_face_learning_suggestions() -> Vec<face_model::FaceSuggestion> {
    faces::get_face_learning_suggestions()
}

#[tauri::command(async)]
fn submit_face_feedback(payload: face_model::FaceFeedbackPayload) -> Result<face_model::ModelStats, String> {
    faces::submit_face_feedback(payload)
}

#[tauri::command(async)]
fn get_face_model_stats() -> face_model::ModelStats {
    faces::get_face_model_stats()
}

#[tauri::command(async)]
fn reset_face_model() -> face_model::ModelStats {
    faces::reset_face_model()
}

#[tauri::command(async)]
fn move_person_photos(
    source_key: String,
    photo_paths: Vec<String>,
    target_key: Option<String>,
    target_label: Option<String>,
) -> Result<media::PeopleGroups, String> {
    people::move_person_photos(&source_key, photo_paths, target_key, target_label)
}

#[tauri::command]
fn set_fast_scan_mode(fast: bool) -> serde_json::Value {
    faces::set_fast_scan_mode(fast);
    serde_json::json!({"fast_mode": fast})
}

#[tauri::command]
fn is_fast_scan_mode() -> bool {
    faces::is_fast_scan_mode()
}

// ---------- app data ----------

/// Per-user application data folder (settings, caches, packs, version store index).
pub fn app_data_dir() -> std::path::PathBuf {
    #[cfg(windows)]
    let base = std::env::var_os("APPDATA").map(std::path::PathBuf::from);
    #[cfg(target_os = "macos")]
    let base = std::env::var_os("HOME").map(|h| std::path::PathBuf::from(h).join("Library/Application Support"));
    #[cfg(all(unix, not(target_os = "macos")))]
    let base = std::env::var_os("XDG_DATA_HOME")
        .map(std::path::PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| std::path::PathBuf::from(h).join(".local/share")));
    let dir = base.unwrap_or_else(std::env::temp_dir).join("com.pifiles.app");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

fn hwnd_of(window: &tauri::WebviewWindow) -> isize {
    #[cfg(windows)]
    {
        window.hwnd().map(|h| h.0 as isize).unwrap_or(0)
    }
    #[cfg(not(windows))]
    {
        let _ = window;
        0
    }
}

// ---------- file operations (background jobs with live progress) ----------

#[tauri::command]
async fn fileop_start(app: tauri::AppHandle, window: tauri::WebviewWindow, kind: String, sources: Vec<String>, dest: Option<String>, conflict: Option<String>) -> Result<String, String> {
    // Deleting without the Recycle Bin can't be undone: confirmed natively, never by the page.
    if kind == "delete" && !security::confirm_permanent_delete(&window, &sources) {
        return Err("Cancelled".into());
    }
    fileops::start(app, kind, sources, dest, fileops::Conflict::parse(conflict.as_deref()))
}

#[tauri::command]
async fn fileop_conflicts(sources: Vec<String>, dest: String) -> Vec<String> {
    tauri::async_runtime::spawn_blocking(move || fileops::conflicts(&sources, &dest)).await.unwrap_or_default()
}

#[tauri::command]
fn fileop_pause(id: String, paused: bool) -> bool {
    fileops::pause(&id, paused)
}

#[tauri::command]
fn fileop_cancel(id: String) -> bool {
    fileops::cancel(&id)
}

#[tauri::command]
fn fileop_list() -> Vec<fileops::JobStatus> {
    fileops::list()
}

#[tauri::command]
fn fileop_dismiss(id: Option<String>) {
    fileops::dismiss(id)
}

// ---------- system context menu, associations, custom actions ----------

#[tauri::command]
async fn shell_menu(window: tauri::WebviewWindow, paths: Vec<String>, background: Option<String>, extended: Option<bool>) -> Result<shellmenu::Menu, String> {
    let h = hwnd_of(&window);
    tauri::async_runtime::spawn_blocking(move || shellmenu::query(h, paths, background, extended.unwrap_or(false)))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn shell_menu_invoke(window: tauri::WebviewWindow, token: u64, id: u32) -> Result<(), String> {
    let h = hwnd_of(&window);
    tauri::async_runtime::spawn_blocking(move || shellmenu::invoke(h, token, id)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn shell_verb(window: tauri::WebviewWindow, paths: Vec<String>, verb: String) -> Result<(), String> {
    let h = hwnd_of(&window);
    tauri::async_runtime::spawn_blocking(move || shellmenu::invoke_verb(h, paths, verb)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn open_with_dialog(window: tauri::WebviewWindow, path: String) -> Result<(), String> {
    let h = hwnd_of(&window);
    tauri::async_runtime::spawn_blocking(move || shellmenu::open_with_dialog(h, path)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn default_apps(exts: Vec<String>) -> std::collections::HashMap<String, shellmenu::DefaultApp> {
    tauri::async_runtime::spawn_blocking(move || exts.into_iter().map(|e| { let a = shellmenu::default_app(&e); (e, a) }).collect())
        .await
        .unwrap_or_default()
}

/// The system share sheet for files (Windows); elsewhere the frontend falls back.
#[tauri::command]
async fn share_files(app: tauri::AppHandle, window: tauri::WebviewWindow, paths: Vec<String>) -> Result<(), String> {
    let h = hwnd_of(&window);
    #[cfg(windows)]
    {
        tauri::async_runtime::spawn_blocking(move || system::share_files(&app, h, paths)).await.map_err(|e| e.to_string())?
    }
    #[cfg(not(windows))]
    {
        let _ = (app, h, paths);
        Err("Sharing isn't available on this system".into())
    }
}

#[tauri::command(async)]
fn run_custom_action(window: tauri::WebviewWindow, program: String, template: String, paths: Vec<String>, dir: Option<String>) -> Result<(), String> {
    security::run_custom_action(&window, security::ActionRequest { program, template, paths, dir: dir.unwrap_or_default() })
}

/// The operating system's "default apps" settings page.
#[tauri::command]
fn open_default_apps_settings() -> Result<(), String> {
    let uri = if cfg!(windows) {
        "ms-settings:defaultapps"
    } else if cfg!(target_os = "macos") {
        "x-apple.systempreferences:com.apple.preference.general"
    } else {
        return std::process::Command::new("gnome-control-center").arg("default-apps").spawn().map(|_| ()).map_err(|e| e.to_string());
    };
    tauri_plugin_opener::open_url(uri, None::<&str>).map_err(|e| e.to_string())
}

#[tauri::command]
fn platform_name() -> &'static str {
    if cfg!(windows) { "windows" } else if cfg!(target_os = "macos") { "macos" } else { "linux" }
}

// ---------- icons, media library ----------

#[tauri::command]
async fn get_file_icon(path: String, size: Option<u32>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || thumbnail::get_file_icon(path, size.unwrap_or(64))).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn library_query(kind: String, device: Option<String>, offset: Option<usize>, limit: Option<usize>) -> library::Page {
    tauri::async_runtime::spawn_blocking(move || library::query(&kind, device.as_deref(), offset.unwrap_or(0), limit.unwrap_or(500)))
        .await
        .unwrap_or(library::Page { items: vec![], total: 0, scanning: false })
}

#[tauri::command]
async fn library_devices() -> Vec<library::Device> {
    tauri::async_runtime::spawn_blocking(library::devices).await.unwrap_or_default()
}

#[tauri::command(async)]
fn library_status() -> serde_json::Value {
    library::status()
}

#[tauri::command]
fn library_rescan(app: tauri::AppHandle) {
    library::spawn_scan(Some(app));
}

// ---------- home / network / sharing ----------

#[tauri::command]
async fn network_locations() -> Vec<system::NetLocation> {
    tauri::async_runtime::spawn_blocking(system::network_locations).await.unwrap_or_default()
}

#[tauri::command]
async fn list_shares() -> Vec<system::Share> {
    tauri::async_runtime::spawn_blocking(system::list_shares).await.unwrap_or_default()
}

#[tauri::command]
async fn create_share(path: String, name: String, read_only: bool) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || system::create_share(&path, &name, read_only)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn rename_volume(root: String, label: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || system::rename_volume(&root, &label)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn remove_share(name: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || system::remove_share(&name)).await.map_err(|e| e.to_string())?
}

// ---------- archives: selective extraction ----------

#[tauri::command]
async fn archive_extract_selected(path: String, entries: Vec<String>, base: Option<String>, dest: String, password: Option<String>) -> Result<usize, String> {
    tauri::async_runtime::spawn_blocking(move || {
        archive::extract_selected(std::path::Path::new(&path), &entries, base.as_deref().unwrap_or(""), std::path::Path::new(&dest), password.as_deref())
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---------- dialogs ----------

#[tauri::command]
async fn pick_folder(app: tauri::AppHandle, title: Option<String>, start: Option<String>) -> Option<String> {
    use tauri_plugin_dialog::DialogExt;
    tauri::async_runtime::spawn_blocking(move || {
        let mut d = app.dialog().file().set_title(title.unwrap_or_else(|| "Choose a folder".into()));
        if let Some(s) = start.filter(|s| std::path::Path::new(s).is_dir()) {
            d = d.set_directory(s);
        }
        d.blocking_pick_folder().and_then(|p| p.into_path().ok()).map(|p| p.to_string_lossy().to_string())
    })
    .await
    .ok()
    .flatten()
}

// ---------- editors ----------

#[tauri::command]
async fn text_open(path: String) -> Result<viewer::TextDoc, String> {
    tauri::async_runtime::spawn_blocking(move || viewer::text_open(&path)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn text_save(path: String, text: String, encoding: String, bom: bool, crlf: bool) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || viewer::text_save(&path, &text, &encoding, bom, crlf)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn sheet_save(path: String, sheet: Option<String>, edits: Vec<spreadsheet::CellEdit>) -> Result<spreadsheet::Saved, String> {
    tauri::async_runtime::spawn_blocking(move || spreadsheet::save(std::path::Path::new(&path), sheet.as_deref(), &edits))
        .await
        .map_err(|e| e.to_string())?
}

// ---------- previous versions ----------

#[tauri::command(async)]
fn versions_config() -> versions::Config {
    versions::get_config()
}

#[tauri::command]
async fn versions_set_config(config: versions::Config) -> Result<versions::Config, String> {
    tauri::async_runtime::spawn_blocking(move || versions::set_config(config)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn versions_list(path: String) -> Vec<versions::VersionInfo> {
    tauri::async_runtime::spawn_blocking(move || versions::list(std::path::Path::new(&path))).await.unwrap_or_default()
}

#[tauri::command]
async fn versions_restore(path: String, id: u64, target: Option<String>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        versions::restore(std::path::Path::new(&path), id, target.as_deref().map(std::path::Path::new)).map(|p| p.to_string_lossy().to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Writes a version to a private temp file (for opening it without touching the original).
#[tauri::command]
async fn versions_restore_temp(path: String, id: u64) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let name = std::path::Path::new(&path).file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| "file".into());
        let target = std::env::temp_dir().join("pifiles-versions").join(format!("{id}-{name}"));
        versions::restore(std::path::Path::new(&path), id, Some(&target)).map(|p| p.to_string_lossy().to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command(async)]
fn computer_name() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_else(|_| {
            std::process::Command::new("hostname").output().map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string()).unwrap_or_default()
        })
}

#[tauri::command]
async fn versions_snapshot(path: String) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || versions::snapshot(std::path::Path::new(&path))).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn versions_deleted(folder: String) -> Vec<serde_json::Value> {
    tauri::async_runtime::spawn_blocking(move || {
        versions::deleted_in(std::path::Path::new(&folder))
            .into_iter()
            .map(|(path, v)| serde_json::json!({ "path": path, "version": v }))
            .collect()
    })
    .await
    .unwrap_or_default()
}

#[tauri::command]
async fn versions_stats() -> versions::Stats {
    tauri::async_runtime::spawn_blocking(versions::stats).await.unwrap_or_default()
}

#[tauri::command]
async fn versions_cleanup() -> u64 {
    tauri::async_runtime::spawn_blocking(versions::cleanup).await.unwrap_or(0)
}

// ---------- theme & icon packs ----------

fn packs_dir(kind: &str) -> std::path::PathBuf {
    let d = app_data_dir().join("packs").join(if kind == "icons" { "icons" } else { "themes" });
    let _ = std::fs::create_dir_all(&d);
    d
}

/// Validates a pack file: a JSON document with `format` "pifiles-theme" or "pifiles-iconpack".
fn read_pack(path: &std::path::Path) -> Result<(String, serde_json::Value), String> {
    let meta = std::fs::metadata(path).map_err(|e| e.to_string())?;
    if meta.len() > 8 * 1024 * 1024 {
        return Err("That file is too large to be a theme or icon pack".into());
    }
    let v: serde_json::Value = serde_json::from_slice(&std::fs::read(path).map_err(|e| e.to_string())?)
        .map_err(|e| format!("Not a valid pack (JSON error: {e})"))?;
    let kind = match v.get("format").and_then(|f| f.as_str()) {
        Some("pifiles-theme") => "theme",
        Some("pifiles-iconpack") => "icons",
        _ => return Err("Not a PiFiles theme or icon pack (missing \"format\")".into()),
    };
    let id = v.get("id").and_then(|i| i.as_str()).unwrap_or("");
    if id.is_empty() || id.len() > 100 || !id.chars().all(|c| c.is_ascii_alphanumeric() || "._-".contains(c)) {
        return Err("The pack's \"id\" must use letters, digits, dots, dashes or underscores".into());
    }
    if v.get("name").and_then(|n| n.as_str()).unwrap_or("").is_empty() {
        return Err("The pack has no \"name\"".into());
    }
    Ok((kind.to_string(), v))
}

#[tauri::command(async)]
fn packs_list(kind: String) -> Vec<serde_json::Value> {
    let mut out = Vec::new();
    if let Ok(rd) = std::fs::read_dir(packs_dir(&kind)) {
        for e in rd.flatten() {
            if let Ok((_, v)) = read_pack(&e.path()) {
                out.push(v);
            }
        }
    }
    out
}

/// Imports a pack (asks for the file when `path` is omitted). Returns the pack.
#[tauri::command]
async fn packs_import(app: tauri::AppHandle, path: Option<String>) -> Result<Option<serde_json::Value>, String> {
    use tauri_plugin_dialog::DialogExt;
    tauri::async_runtime::spawn_blocking(move || {
        let path = match path {
            Some(p) => std::path::PathBuf::from(p),
            None => match app
                .dialog()
                .file()
                .set_title("Import a theme or icon pack")
                .add_filter("PiFiles theme or icon pack", &["pftheme", "pficons", "json"])
                .blocking_pick_file()
                .and_then(|p| p.into_path().ok())
            {
                Some(p) => p,
                None => return Ok(None),
            },
        };
        let (kind, v) = read_pack(&path)?;
        let id = v["id"].as_str().unwrap_or_default().to_string();
        let ext = if kind == "icons" { "pficons" } else { "pftheme" };
        std::fs::write(packs_dir(&kind).join(format!("{id}.{ext}")), serde_json::to_vec_pretty(&v).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
        Ok(Some(v))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Saves a pack (JSON text) where the user chooses. Returns the saved path.
#[tauri::command]
async fn packs_export(app: tauri::AppHandle, content: String, file_name: String) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    tauri::async_runtime::spawn_blocking(move || {
        let ext = if file_name.ends_with(".pficons") { "pficons" } else { "pftheme" };
        let Some(p) = app
            .dialog()
            .file()
            .set_title("Export")
            .set_file_name(&file_name)
            .add_filter("PiFiles pack", &[ext])
            .blocking_save_file()
            .and_then(|p| p.into_path().ok())
        else {
            return Ok(None);
        };
        std::fs::write(&p, content).map_err(|e| e.to_string())?;
        Ok(Some(p.to_string_lossy().to_string()))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command(async)]
fn packs_delete(kind: String, id: String) -> Result<(), String> {
    if !id.chars().all(|c| c.is_ascii_alphanumeric() || "._-".contains(c)) {
        return Err("bad id".into());
    }
    let dir = packs_dir(&kind);
    for ext in ["pftheme", "pficons", "json"] {
        let _ = std::fs::remove_file(dir.join(format!("{id}.{ext}")));
    }
    Ok(())
}

// ---------- user tags ----------

fn tags_file() -> std::path::PathBuf {
    app_data_dir().join("user_tags.json")
}

/// The whole tag document: { tags: [{id, name, color}], files: { path: [tagId…] } }.
#[tauri::command(async)]
fn user_tags_get() -> serde_json::Value {
    vault::read(&tags_file())
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_else(|| serde_json::json!({ "tags": [], "files": {} }))
}

#[tauri::command(async)]
fn user_tags_set(doc: serde_json::Value) -> Result<(), String> {
    vault::write(&tags_file(), &serde_json::to_vec(&doc).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
}

// ---------- properties ----------

#[tauri::command]
async fn file_properties(path: String) -> Result<props::Props, String> {
    tauri::async_runtime::spawn_blocking(move || props::properties(&path)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn folder_stats(path: String) -> props::FolderStats {
    tauri::async_runtime::spawn_blocking(move || props::folder_stats(&path)).await.unwrap_or_default()
}

#[tauri::command]
async fn file_sha256(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || props::sha256(&path)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn set_file_attributes(path: String, readonly: Option<bool>, hidden: Option<bool>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || props::set_attributes(&path, readonly, hidden)).await.map_err(|e| e.to_string())?
}

fn props_windows() -> &'static std::sync::Mutex<std::collections::HashMap<String, Vec<String>>> {
    static M: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<String, Vec<String>>>> = std::sync::OnceLock::new();
    M.get_or_init(Default::default)
}

/// Opens a separate Properties window for `paths` (like Explorer's Alt+Enter dialog).
#[tauri::command]
async fn open_properties_window(app: tauri::AppHandle, paths: Vec<String>) -> Result<(), String> {
    use std::sync::atomic::{AtomicU32, Ordering};
    static N: AtomicU32 = AtomicU32::new(1);
    if paths.is_empty() {
        return Err("Nothing selected".into());
    }
    let label = format!("props-{}", N.fetch_add(1, Ordering::Relaxed));
    let title = if paths.len() == 1 {
        let p = std::path::Path::new(&paths[0]);
        let name = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| paths[0].trim_end_matches('\\').to_string());
        format!("{name} Properties")
    } else {
        format!("{} items Properties", paths.len())
    };
    props_windows().lock().unwrap().insert(label.clone(), paths);
    let w = tauri::WebviewWindowBuilder::new(&app, &label, tauri::WebviewUrl::App("properties.html".into()))
        .title(title)
        .inner_size(460.0, 640.0)
        .min_inner_size(380.0, 420.0)
        .decorations(false)
        .center()
        .build()
        .map_err(|e| e.to_string())?;
    system::harden_webview(&w);
    let l = label.clone();
    w.on_window_event(move |e| {
        if let tauri::WindowEvent::Destroyed = e {
            props_windows().lock().unwrap().remove(&l);
        }
    });
    Ok(())
}

#[tauri::command]
fn properties_window_paths(window: tauri::WebviewWindow) -> Vec<String> {
    props_windows().lock().unwrap().get(window.label()).cloned().unwrap_or_default()
}

#[tauri::command]
fn system_profile() -> perf::Profile {
    perf::profile().clone()
}

/// Called by the page when the window is minimised/hidden (and when idle for a while).
#[tauri::command]
async fn set_background_mode(window: tauri::WebviewWindow, background: bool) {
    perf::set_background(&window, background);
}

#[tauri::command]
async fn set_window_effect(window: tauri::WebviewWindow, effect: String) -> bool {
    perf::set_window_effect(&window, &effect)
}

// ---------- updates ----------

#[tauri::command]
async fn update_check(app: tauri::AppHandle, channel: Option<String>) -> Result<updates::CheckResult, String> {
    updates::check(&app, channel.as_deref().unwrap_or("stable")).await
}

#[tauri::command]
async fn update_install(app: tauri::AppHandle) -> Result<(), String> {
    updates::install(&app).await
}

#[tauri::command]
fn app_restart(app: tauri::AppHandle) {
    app.restart();
}

#[tauri::command]
fn app_info(app: tauri::AppHandle) -> serde_json::Value {
    serde_json::json!({
        "version": app.package_info().version.to_string(),
        "distribution": updates::distribution(),
        "platform": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
    })
}

#[tauri::command]
async fn clear_thumbnail_cache() -> u64 {
    tauri::async_runtime::spawn_blocking(thumbnail::clear_disk_cache).await.unwrap_or(0)
}

#[tauri::command]
async fn doc_render(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || docs::render(&path)).await.map_err(|e| e.to_string())?
}

// ---------- image editor ----------

/// Raw bytes of an image for the editor, as a binary IPC response (no base64/JSON), so the page
/// can make a same-origin blob and edit it on a canvas. Images only, size-capped.
#[tauri::command]
async fn read_image_bytes(path: String) -> Result<tauri::ipc::Response, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let ext = std::path::Path::new(&path).extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
        if !matches!(ext.as_str(), "jpg" | "jpeg" | "jfif" | "png" | "webp" | "gif" | "bmp" | "avif" | "ico") {
            return Err("Not an image".to_string());
        }
        let len = std::fs::metadata(&path).map_err(|e| e.to_string())?.len();
        if len > 300 * 1024 * 1024 {
            return Err("Image too large to edit".to_string());
        }
        std::fs::read(&path).map(tauri::ipc::Response::new).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}


#[tauri::command]
async fn image_detect_faces(path: String) -> Result<imgedit::Faces, String> {
    tauri::async_runtime::spawn_blocking(move || imgedit::detect_faces(&path)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn image_save_edit(path: String, data: String, width: u32, height: u32, as_copy: bool) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || imgedit::save_edit(&path, &data, width, height, as_copy)).await.map_err(|e| e.to_string())?
}

/// Request validation in front of every backend command (cheap: a single pass over the JSON).
/// Rejects malformed input before any command code runs:
///  * strings containing NUL characters (path truncation / confusion tricks);
///  * absurdly large or deeply nested payloads (memory exhaustion);
///  * prototype-pollution style keys.
/// Unknown command names and windows without permission are already refused by Tauri itself
/// (capabilities), and the Content-Security-Policy keeps foreign script out of the page.
fn guarded<R: tauri::Runtime>(inner: impl Fn(tauri::ipc::Invoke<R>) -> bool + Send + Sync + 'static) -> impl Fn(tauri::ipc::Invoke<R>) -> bool + Send + Sync + 'static {
    fn check(v: &serde_json::Value, depth: usize, budget: &mut usize) -> Result<(), &'static str> {
        if depth > 32 {
            return Err("request too deeply nested");
        }
        *budget = budget.checked_sub(1).ok_or("request too large")?;
        match v {
            serde_json::Value::String(s) => {
                if s.len() > 160 * 1024 * 1024 {
                    return Err("request too large");
                }
                if s.contains('\0') {
                    return Err("invalid character in request");
                }
            }
            serde_json::Value::Array(a) => {
                for x in a {
                    check(x, depth + 1, budget)?;
                }
            }
            serde_json::Value::Object(m) => {
                for (k, x) in m {
                    if k == "__proto__" || k == "constructor" || k == "prototype" || k.contains('\0') {
                        return Err("invalid request");
                    }
                    check(x, depth + 1, budget)?;
                }
            }
            _ => {}
        }
        Ok(())
    }
    move |invoke| {
        if let tauri::ipc::InvokeBody::Json(v) = invoke.message.payload() {
            let mut budget = 2_000_000usize;
            if let Err(why) = check(v, 0, &mut budget) {
                eprintln!("[ipc] rejected {}: {why}", invoke.message.command());
                invoke.resolver.reject(format!("PiFiles blocked this request: {why}"));
                return true;
            }
        }
        inner(invoke)
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    integrity::enforce();
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(updates::Pending::default())
        .setup(|app| {
            use tauri::Manager;
            perf::configure_threads();
            if let Some(w) = app.get_webview_window("main") {
                system::harden_webview(&w);
                perf::watch_window(&w);
            }
            media_player::init(app.path().resource_dir().ok());
            versions::init();
            // Background work starts after the window is up, staggered so the first paint and
            // first folder load get the CPU and disk. Low-end machines wait longer between jobs.
            fs::load_folder_size_cache();
            let handle = app.handle().clone();
            std::thread::Builder::new()
                .name("startup-jobs".into())
                .spawn(move || {
                    let low = perf::profile().tier == "low";
                    let wait = |s: u64| std::thread::sleep(std::time::Duration::from_secs(s));
                    wait(if low { 6 } else { 2 });
                    library::spawn_scan(Some(handle));
                    wait(if low { 30 } else { 8 });
                    search::spawn_background_index();
                    // Face scan is the heaviest job: fully local, low priority, models freed afterwards.
                    wait(if low { 180 } else { 30 });
                    crate::faces::spawn_full_machine_scan(false);
                })
                .ok();
            Ok(())
        })
        .invoke_handler(guarded(tauri::generate_handler![
            list_drives,
            list_dir,
            get_files_info,
            get_folder_size,
            search_files,
            get_index_status,
            rebuild_index,
            get_media_groups,
            start_face_scan,
            get_face_scan_status,
            get_all_drives_scan_status,
            get_device_groups,
            get_thumbnail,
            get_file_preview,
            get_original_data_url,
            read_text_file,
            read_file_base64,
            get_hex_preview,
            list_archive,
            open_file,
            get_person_labels,
            rename_person,
            delete_person,
            merge_persons,
            move_person_photos,
            set_fast_scan_mode,
            is_fast_scan_mode,
            list_images,
            list_videos,
            list_documents,
            list_archives,
            create_folder,
            create_file,
            get_known_folders,
            media_probe,
            media_subtitle,
            media_open,
            media_read,
            media_subs,
            media_close,
            media_available,
            archive_list,
            archive_extract_entry,
            archive_extract_all,
            sheet_read,
            rename_item,
            minimize_window,
            toggle_maximize_window,
            is_window_maximized,
            close_window,
            toggle_fullscreen,
            is_fullscreen,
            player_backdrop,
            fs_cover,
            fs_reveal,
            get_face_learning_suggestions,
            submit_face_feedback,
            get_face_model_stats,
            fileop_start,
            fileop_conflicts,
            fileop_pause,
            fileop_cancel,
            fileop_list,
            fileop_dismiss,
            shell_menu,
            shell_menu_invoke,
            shell_verb,
            open_with_dialog,
            default_apps,
            run_custom_action,
            share_files,
            platform_name,
            open_default_apps_settings,
            get_file_icon,
            library_query,
            library_devices,
            library_status,
            library_rescan,
            network_locations,
            list_shares,
            create_share,
            remove_share,
            rename_volume,
            file_properties,
            folder_stats,
            file_sha256,
            set_file_attributes,
            open_properties_window,
            properties_window_paths,
            system_profile,
            set_background_mode,
            set_window_effect,
            update_check,
            update_install,
            app_restart,
            app_info,
            clear_thumbnail_cache,
            image_detect_faces,
            image_save_edit,
            read_image_bytes,
            doc_render,
            archive_extract_selected,
            pick_folder,
            text_open,
            text_save,
            sheet_save,
            versions_config,
            versions_set_config,
            versions_list,
            versions_restore,
            versions_restore_temp,
            computer_name,
            versions_snapshot,
            versions_deleted,
            versions_stats,
            versions_cleanup,
            packs_list,
            packs_import,
            packs_export,
            packs_delete,
            user_tags_get,
            user_tags_set,
            reset_face_model
        ]))
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod viewer_real_files {
    /// Exercises the viewer back ends on real files from this machine (read/list only).
    /// Run: cargo test --lib viewer_real_files -- --ignored --nocapture
    #[test]
    #[ignore]
    fn viewer_real_files() {
        use std::path::Path;
        let home = std::env::var("USERPROFILE").unwrap_or_default();
        let hevc = format!(r"{home}\Downloads\www.1TamilMV.meme - Vishwanath and Sons (2026) Tamil HQ HDRip - 1080p - HEVC - x265 - (DD+5.1 - 192Kbps & AAC 2.0) - 1.7GB - ESub.mkv");
        for p in [hevc.as_str(), r"F:\Jilebi (2015) Malayalam DVDRip x264 AAC 5.1 E-Subs-MBRHDRG.mkv"] {
            let t = std::time::Instant::now();
            match crate::media_player::probe(Path::new(p)) {
                Ok(i) => {
                    let v = i.video.as_ref().map(|v| format!("{} {}x{} {}", v.codec, v.width, v.height, v.pix_fmt)).unwrap_or_default();
                    let a: Vec<String> = i.audio.iter().map(|a| format!("#{} {} {}ch {}", a.index, a.codec, a.channels, a.language)).collect();
                    let s: Vec<String> = i.subtitles.iter().map(|s| format!("{} {} {} text={}", s.id, s.codec, s.language, s.text)).collect();
                    println!("{:?} {:.0}s direct={} | {v} | audio {a:?} | subs {s:?} ({:?})",
                             Path::new(p).file_name().unwrap(), i.duration, i.direct_play, t.elapsed());
                    if let Some(sub) = i.subtitles.iter().find(|s| s.text) {
                        let t = std::time::Instant::now();
                        let vtt = crate::media_player::subtitle_vtt(Path::new(p), sub.index, sub.external.as_deref().map(Path::new));
                        println!("   subtitle {}: {} cues in {:?}", sub.id, vtt.map(|v| v.matches("-->").count()).unwrap_or(0), t.elapsed());
                    }
                    let copy_ok = i.video.as_ref().map_or(false, |v| v.codec == "h264");
                    let mode = if copy_ok { "copy" } else { "encode" };
                    let t = std::time::Instant::now();
                    let st = crate::media_player::open(Path::new(p), i.audio.last().map(|a| a.index), 600.0, mode, false, &[]).unwrap();
                    crate::media_player::close(st.id);
                    println!("   stream {mode} from 600s -> starts at {:.2}s (lookup {:?})", st.offset, t.elapsed());
                }
                Err(e) => println!("{p}: {e}"),
            }
        }
        for p in [r"D:\EFI.rar", r"E:\AppNee.com.WinRAR.Registration.keyfile.Generator.v5.01.7z"] {
            match crate::archive::list(Path::new(p), None) {
                Ok(l) => println!("{:?}: {} {} entries, encrypted={} first={:?}", Path::new(p).file_name().unwrap(), l.format, l.entries.len(), l.encrypted, l.entries.first().map(|e| &e.name)),
                Err(e) => println!("{p}: {e}"),
            }
        }
        for p in [r"E:\Codes\Python\EDAS\Exam Details.xlsx", r"E:\Codes\Python\EDAS\Generated_Duty_Schedule.xlsx"] {
            match crate::spreadsheet::read(Path::new(p), None) {
                Ok(s) => println!("{:?}: sheets {:?}, {}x{}, first row {:?}", Path::new(p).file_name().unwrap(), s.sheets, s.total_rows, s.total_cols, s.rows.first().map(|r| r.len())),
                Err(e) => println!("{p}: {e}"),
            }
        }
    }
}

#[cfg(test)]
mod system_integration {
    /// Real-system checks (context menu, icons, associations, network, copy speed). Read-only
    /// except for files it creates in the temp folder.
    /// Run: cargo test --lib system_integration -- --ignored --nocapture --test-threads=1
    #[test]
    #[ignore]
    fn system_integration_real() {
        let here = std::env::current_dir().unwrap();
        let file = here.join("Cargo.toml").to_string_lossy().to_string();
        let t = std::time::Instant::now();
        let m = crate::shellmenu::query(0, vec![file.clone()], None, false).expect("shell menu");
        fn show(items: &[crate::shellmenu::MenuItem], depth: usize) {
            for i in items {
                if i.separator { println!("{}----", "  ".repeat(depth)); continue; }
                println!("{}{} [{}]{}{}", "  ".repeat(depth), i.label, i.verb, if i.icon.is_some() { " (icon)" } else { "" }, if i.disabled { " (disabled)" } else { "" });
                if depth < 1 { show(&i.children, depth + 1); }
            }
        }
        println!("== file menu ({} items, {:?})", m.items.len(), t.elapsed());
        show(&m.items, 0);
        let bg = crate::shellmenu::query(0, vec![], Some(here.to_string_lossy().to_string()), false).expect("background menu");
        println!("== background menu: {}", bg.items.iter().filter(|i| !i.separator).map(|i| i.label.as_str()).collect::<Vec<_>>().join(" | "));
        for exe in [r"C:\Windows\notepad.exe", r"C:\Windows\explorer.exe"] {
            let r = crate::thumbnail::get_file_icon(exe.into(), 64);
            println!("icon {exe}: {}", r.map(|u| format!("{} KB png", u.len() / 1024)).unwrap_or_else(|e| e));
        }
        for ext in ["txt", "jpg", "pdf", "mp4", "xlsx", "zip"] {
            let a = crate::shellmenu::default_app(ext);
            println!("default .{ext}: {} ({})", a.name, a.path);
        }
        let t = std::time::Instant::now();
        let net = crate::system::network_locations();
        println!("network ({:?}): {:?}", t.elapsed(), net.iter().map(|n| format!("{} [{}] {}", n.name, n.kind, n.path)).collect::<Vec<_>>());
        println!("shares: {:?}", crate::system::list_shares().iter().map(|s| format!("{} -> {}", s.name, s.path)).collect::<Vec<_>>());

        // Copy speed: 1,500 small files + one 600 MB file, our engine vs a plain sequential std::fs::copy.
        let root = std::env::temp_dir().join("pifiles-speed");
        let _ = std::fs::remove_dir_all(&root);
        let src = root.join("src");
        std::fs::create_dir_all(src.join("small")).unwrap();
        for i in 0..1500 { std::fs::write(src.join("small").join(format!("f{i}.bin")), vec![i as u8; 12_000]).unwrap(); }
        let big: Vec<u8> = (0..600 * 1024 * 1024u32).map(|i| (i.wrapping_mul(2654435761) >> 13) as u8).collect();
        std::fs::write(src.join("big.bin"), &big).unwrap();
        drop(big);
        let seq = root.join("seq");
        std::fs::create_dir_all(seq.join("small")).unwrap();
        let t = std::time::Instant::now();
        for e in std::fs::read_dir(src.join("small")).unwrap() { let e = e.unwrap(); std::fs::copy(e.path(), seq.join("small").join(e.file_name())).unwrap(); }
        let seq_small = t.elapsed();
        let t = std::time::Instant::now();
        std::fs::copy(src.join("big.bin"), seq.join("big.bin")).unwrap();
        let seq_big = t.elapsed();
        let ours = root.join("ours");
        std::fs::create_dir_all(&ours).unwrap();
        let t = std::time::Instant::now();
        crate::fileops::bench_copy(&[src.join("small").to_string_lossy().to_string()], &ours.to_string_lossy());
        let our_small = t.elapsed();
        let t = std::time::Instant::now();
        crate::fileops::bench_copy(&[src.join("big.bin").to_string_lossy().to_string()], &ours.to_string_lossy());
        let our_big = t.elapsed();
        println!("1,500 small files: sequential {seq_small:?} vs PiFiles {our_small:?}");
        println!("600 MB file:       std::fs::copy {seq_big:?} vs PiFiles {our_big:?} ({:.0} MB/s)", 600.0 / our_big.as_secs_f64());
        let _ = std::fs::remove_dir_all(&root);
    }
}

#[cfg(test)]
mod library_real {
    /// Scans this machine's media (counts and device names only).
    /// Run: cargo test --lib library_real -- --ignored --nocapture
    #[test]
    #[ignore]
    fn library_scan_real() {
        let t = std::time::Instant::now();
        crate::library::spawn_scan(None);
        std::thread::sleep(std::time::Duration::from_millis(300));
        loop {
            let s = crate::library::status();
            if !s["scanning"].as_bool().unwrap_or(false) { println!("done in {:?}: {s}", t.elapsed()); break; }
            std::thread::sleep(std::time::Duration::from_secs(2));
            if t.elapsed().as_secs() > 1500 { println!("still running: {s}"); break; }
        }
        for d in crate::library::devices().iter().take(15) {
            println!("{:<32} {:>6} photos {:>5} videos", d.name, d.images, d.videos);
        }
        let without = crate::library::query("all", None, 0, 1).total - crate::library::devices().iter().map(|d| d.count).sum::<usize>();
        println!("items without camera/phone metadata: {without}");
    }
}
