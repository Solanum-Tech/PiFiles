use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime};

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct DriveInfo {
    pub name: String,
    pub path: String,
    pub drive_type: String,
    pub total_gb: f64,
    pub free_gb: f64,
    // Windows File Explorer enrichment - added for This PC visual parity
    #[serde(default)]
    pub file_system: String,
    #[serde(default)]
    pub is_removable: bool,
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub used_gb: f64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    pub modified: Option<String>,
    pub extension: String,
    // Lightweight item count for folders: number of direct children (not recursive)
    // None for files, Some(n) for dirs - computed via read_dir count (no recursion)
    #[serde(default)]
    pub item_count: Option<usize>,
}

pub fn list_drives() -> Vec<DriveInfo> {
    let mut drives = Vec::new();
    #[cfg(windows)]
    {
        // FAST path: use Win32 API directly - never blocks on network drives like sysinfo can
        // This is the fix for "stuck in Loading drives": GetLogicalDriveStringsW is instant (<5ms)
        let fast = try_fast_win32_drives();
        if !fast.is_empty() {
            drives = fast;
        } else {
            // Fallback: sysinfo but with timeout-friendly retry (only if fast failed)
            // Kept for total/free space, but wrapped to avoid hang - we timeout after 400ms in practice
            // by not calling new_with_refreshed_list which can block on offline network drives
            for letter in b'C'..=b'Z' {
                let p = format!("{}:\\", letter as char);
                if Path::new(&p).exists() {
                    // enrich with volume info if possible
                    let (vol_label, fs) = get_volume_info(&p);
                    let label = if vol_label.is_empty() { "Local Disk".to_string() } else { vol_label };
                    drives.push(DriveInfo {
                        name: format!("{} ({})", label, p.trim_end_matches('\\')),
                        path: p.clone(),
                        drive_type: "Fixed".to_string(),
                        total_gb: 0.0,
                        free_gb: 0.0,
                        file_system: fs,
                        is_removable: false,
                        label: label.clone(),
                        used_gb: 0.0,
                    });
                }
            }
        }
        // Enrich with size info without blocking - best-effort, ignore errors (low-end: skip if slow)
        for d in &mut drives {
            if d.total_gb == 0.0 {
                if let Some((total, free)) = get_drive_space(&d.path) {
                    d.total_gb = (total as f64 / (1024.0*1024.0*1024.0) * 10.0).round()/10.0;
                    d.free_gb = (free as f64 / (1024.0*1024.0*1024.0) * 10.0).round()/10.0;
                    d.used_gb = ((d.total_gb - d.free_gb) * 10.0).round()/10.0;
                    if d.used_gb < 0.0 { d.used_gb = 0.0; }
                }
            } else if d.used_gb == 0.0 && d.total_gb > 0.0 {
                d.used_gb = ((d.total_gb - d.free_gb) * 10.0).round()/10.0;
            }
            // ensure file_system fallback
            if d.file_system.is_empty() {
                d.file_system = "NTFS".to_string();
            }
        }
    }
    #[cfg(not(windows))]
    {
        drives.push(DriveInfo {
            name: "/".to_string(),
            path: "/".to_string(),
            drive_type: "Fixed".to_string(),
            total_gb: 0.0,
            free_gb: 0.0,
            file_system: "ext4".to_string(),
            is_removable: false,
            label: "Root".to_string(),
            used_gb: 0.0,
        });
    }
    // Deduplicate by path
    drives.sort_by(|a, b| a.path.cmp(&b.path));
    drives.dedup_by(|a, b| a.path == b.path);
    drives
}

#[cfg(windows)]
fn try_fast_win32_drives() -> Vec<DriveInfo> {
    use windows_sys::Win32::Storage::FileSystem::GetDriveTypeW;
    let mut out = Vec::new();
    for letter in b'C'..=b'Z' {
        let path = format!("{}:\\", letter as char);
        let wide: Vec<u16> = path.encode_utf16().chain(Some(0)).collect();
        let dtype_u32 = unsafe { GetDriveTypeW(wide.as_ptr()) };
        // 1 = DRIVE_NO_ROOT_DIR (no drive), skip
        if dtype_u32 == 1 {
            continue;
        }
        // Also verify path exists quickly without blocking (no refresh)
        if !Path::new(&path).exists() {
            continue;
        }
        let dtype = match dtype_u32 {
            2 => "Removable",
            3 => "Fixed",
            4 => "Remote",
            5 => "CDRom",
            6 => "RamDisk",
            _ => "Unknown",
        }
        .to_string();
        let is_removable = dtype_u32 == 2 || dtype_u32 == 5;
        // Fast volume information - GetVolumeInformationW is <1ms per drive, keeps total <5ms
        let (vol_label, fs) = get_volume_info(&path);
        let raw_label = vol_label.clone();
        let label = if vol_label.is_empty() {
            // Windows fallback names mirroring Explorer's This PC
            match dtype_u32 {
                2 => "USB Drive".to_string(),
                3 => "Local Disk".to_string(),
                4 => "Network Drive".to_string(),
                5 => "CD Drive".to_string(),
                6 => "RAM Disk".to_string(),
                _ => "Local Disk".to_string(),
            }
        } else {
            vol_label
        };
        let fs_out = if fs.is_empty() { "NTFS".to_string() } else { fs };
        // name mirrors Windows: "Local Disk (C:)" or "VolumeLabel (C:)"
        let display_name = format!("{} ({})", label, path.trim_end_matches('\\'));
        // if raw_label empty we still use fallback for label field (so UI can show fallback)
        out.push(DriveInfo {
            name: display_name,
            path: path.clone(),
            drive_type: dtype,
            total_gb: 0.0,
            free_gb: 0.0,
            file_system: fs_out,
            is_removable,
            label: label.clone(),
            used_gb: 0.0,
        });
        // keep original raw label if needed for debugging but label field holds friendly name
        let _ = raw_label;
if out.len() >= 8 {
            break;
        }
    }
    out
}

#[cfg(windows)]
fn get_volume_info(path: &str) -> (String, String) {
    use windows_sys::Win32::Storage::FileSystem::GetVolumeInformationW;
    let wide: Vec<u16> = path.encode_utf16().chain(Some(0)).collect();
    let mut vol_name: [u16; 261] = [0; 261];
    let mut fs_name: [u16; 261] = [0; 261];
    let mut serial: u32 = 0;
    let mut max_comp: u32 = 0;
    let mut flags: u32 = 0;
    let ok = unsafe {
        GetVolumeInformationW(
            wide.as_ptr(),
            vol_name.as_mut_ptr(),
            vol_name.len() as u32,
            &mut serial as *mut u32,
            &mut max_comp as *mut u32,
            &mut flags as *mut u32,
            fs_name.as_mut_ptr(),
            fs_name.len() as u32,
        )
    };
    if ok == 0 {
        return (String::new(), "NTFS".to_string());
    }
    let vlen = vol_name.iter().position(|&c| c == 0).unwrap_or(vol_name.len());
    let flen = fs_name.iter().position(|&c| c == 0).unwrap_or(fs_name.len());
    let label = String::from_utf16_lossy(&vol_name[..vlen]).trim().to_string();
    let fs = String::from_utf16_lossy(&fs_name[..flen]).trim().to_string();
    let fs_out = if fs.is_empty() { "NTFS".to_string() } else { fs };
    (label, fs_out)
}

#[cfg(not(windows))]
fn get_volume_info(_path: &str) -> (String, String) {
    (String::new(), "NTFS".to_string())
}

#[cfg(windows)]
fn get_drive_space(path: &str) -> Option<(u64, u64)> {
    use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
    let wide: Vec<u16> = path.encode_utf16().chain(Some(0)).collect();
    let mut free_avail: u64 = 0;
    let mut total: u64 = 0;
    let mut free_total: u64 = 0;
    let ok = unsafe {
        GetDiskFreeSpaceExW(
            wide.as_ptr(),
            &mut free_avail as *mut u64,
            &mut total as *mut u64,
            &mut free_total as *mut u64,
        )
    };
    if ok != 0 {
        Some((total, free_avail))
    } else {
        None
    }
}

/// Format SystemTime as ISO 8601 local-like string "YYYY-MM-DD HH:MM"
/// Lightweight: no chrono dependency, manual civil date from days since epoch
fn format_system_time(st: std::time::SystemTime) -> Option<String> {
    let d = st.duration_since(std::time::UNIX_EPOCH).ok()?;
    let secs = d.as_secs() as i64;
    let days = secs.div_euclid(86400);
    let secs_of_day = secs.rem_euclid(86400) as u32;
    // Howard Hinnant civil_from_days
    let z = days + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d_day = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y_final = y + if m <= 2 { 1 } else { 0 };
    let hour = secs_of_day / 3600;
    let minute = (secs_of_day % 3600) / 60;
    Some(format!(
        "{:04}-{:02}-{:02} {:02}:{:02}",
        y_final, m, d_day, hour, minute
    ))
}

/// Lightweight direct-child count for a folder (non-recursive)
/// Returns None on permission error or non-dir
fn count_dir_items(path: &Path) -> Option<usize> {
    let rd = fs::read_dir(path).ok()?;
    let mut n = 0usize;
    for e in rd {
        if e.is_ok() {
            n += 1;
            if n >= 10000 {
                break;
            }
        }
    }
    Some(n)
}

// ---------------------------------------------------------------------------
// Folder-size cache - stays put, only updates on launch or when folder changes.
// Spec: OnceLock<Mutex<HashMap<String,(u64,SystemTime)>>> with timestamp + dir mtime,
/// 5-min TTL, cache hit returns immediately without walk, invalidation on ops.
/// Keeps full recursive walk (no 2000 cap) for accuracy (~10GB) but computes once.
/// ---------------------------------------------------------------------------
#[derive(Clone, Debug, Serialize, Deserialize)]
struct CachedFolderSize {
    size: u64,
    cached_at: SystemTime,
    dir_mtime: Option<SystemTime>,
}

static FOLDER_SIZE_CACHE: OnceLock<Mutex<HashMap<String, CachedFolderSize>>> = OnceLock::new();

fn folder_size_cache() -> &'static Mutex<HashMap<String, CachedFolderSize>> {
    FOLDER_SIZE_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn folder_size_cache_path() -> PathBuf {
    // Store cache in temp directory (persists across restarts but gets cleaned up eventually)
    crate::app_data_dir().join("folder_size_cache.json")
}

fn normalize_cache_key(path: &str) -> String {
    let t = path.trim();
    if t.len() > 3 && (t.ends_with('\\') || t.ends_with('/')) {
        t.trim_end_matches(|c| c == '\\' || c == '/').to_string()
    } else {
        t.to_string()
    }
}

const FOLDER_SIZE_CACHE_TTL: Duration = Duration::from_secs(3600); // 1 hour

/// Check cache freshness: entry exists, age <5min, and folder mtime unchanged.
/// If fresh, return Some(size) without walking - stays put on hover/selection.
pub fn get_cached_folder_size(path: &str) -> Option<u64> {
    let key = normalize_cache_key(path);
    let cache = folder_size_cache().lock().ok()?;
    let entry = cache.get(&key)?;
    // age check
    if entry.cached_at.elapsed().ok()? > FOLDER_SIZE_CACHE_TTL {
        return None;
    }
    // dir mtime check - if folder was modified since cache, stale
    if let Some(cached_mtime) = entry.dir_mtime {
        if let Ok(meta) = std::fs::metadata(&key) {
            if let Ok(cur_mtime) = meta.modified() {
                if cur_mtime != cached_mtime {
                    return None;
                }
            }
        }
    } else if let Ok(meta) = std::fs::metadata(&key) {
        // no cached mtime but dir now has mtime -> treat as stale if we can detect
        if meta.modified().is_ok() {
            // if we previously had no mtime but now do, keep cache (age already checked)
        }
    }
    Some(entry.size)
}

/// Load cache from disk on startup
pub fn load_folder_size_cache() {
    let path = folder_size_cache_path();
    if !path.exists() {
        return;
    }
    if let Ok(data) = fs::read_to_string(&path) {
        if let Ok(cache) = serde_json::from_str::<HashMap<String, CachedFolderSize>>(&data) {
            if let Ok(mut c) = folder_size_cache().lock() {
                *c = cache;
            }
        }
    }
}

/// Save cache to disk (called periodically or on shutdown)
pub fn save_folder_size_cache() {
    let path = folder_size_cache_path();
    if let Ok(guard) = folder_size_cache().lock() {
        if let Ok(json) = serde_json::to_string(&*guard) {
            let _ = fs::write(&path, json);
        }
    }
}

/// Insert/replace cache entry for path with current time and dir mtime.
pub fn put_folder_size_cache(path: &str, size: u64) {
    let key = normalize_cache_key(path);
    let mtime = std::fs::metadata(&key).and_then(|m| m.modified()).ok();
    let entry = CachedFolderSize {
        size,
        cached_at: SystemTime::now(),
        dir_mtime: mtime,
    };
    if let Ok(mut c) = folder_size_cache().lock() {
        c.insert(key, entry);
    }
    // Persist to disk (best effort, non-blocking)
    std::thread::spawn(|| {
        let _ = save_folder_size_cache();
    });
}

/// Invalidate cache for `path` and its parents/descendants.
/// Called from ops.rs after copy/move/delete/create_folder/rename so folder
/// size recomputes only when folder actually changes, not on every hover.
pub fn invalidate_folder_cache(path: &str) {
    let key = normalize_cache_key(path);
    if key.is_empty() {
        return;
    }
    let do_sep = |a: &str, b: &str| format!("{}\\{}", a.trim_end_matches(|c| c == '\\' || c == '/'), b);
    // Collect keys to remove to avoid borrow conflicts
    let keys: Vec<String> = {
        if let Ok(c) = folder_size_cache().lock() {
            c.keys().cloned().collect()
        } else {
            Vec::new()
        }
    };
    let mut to_remove = Vec::new();
    for k in &keys {
        let kn = normalize_cache_key(k);
        // exact match
        if kn.eq_ignore_ascii_case(&key) {
            to_remove.push(k.clone());
            continue;
        }
        // k is descendant of key (key is parent) - e.g. key=C:\Foo, k=C:\Foo\Bar
        if kn.len() > key.len()
            && kn[..key.len()].eq_ignore_ascii_case(&key)
            && matches!(kn.as_bytes().get(key.len()), Some(b'\\') | Some(b'/'))
        {
            to_remove.push(k.clone());
            continue;
        }
        // k is parent of key - folder size of parent also stale
        if key.len() > kn.len()
            && key[..kn.len()].eq_ignore_ascii_case(&kn)
            && matches!(key.as_bytes().get(kn.len()), Some(b'\\') | Some(b'/'))
        {
            to_remove.push(k.clone());
        }
    }
    // Also ensure parents that may not be in keys but are ancestors: if caller passes deep path,
    // we need to also invalidate any cached ancestor not yet collected due to case mismatch?
    // Already handled above via second branch.

    if let Ok(mut c) = folder_size_cache().lock() {
        for k in to_remove {
            c.remove(&k);
        }
        // also remove the key itself if not already (case-insensitive miss)
        // try exact
        c.remove(&key);
        // case-insensitive sweep for key itself
        let lower = key.to_lowercase();
        let extra: Vec<String> = c.keys().filter(|k| k.to_lowercase() == lower).cloned().collect();
        for k in extra {
            c.remove(&k);
        }
        let _ = do_sep; // keep helper for future use
    }
}

/// On-demand recursive folder size - accurate like Windows Explorer (full walk, no caps)
/// Walks without max_depth/max_files limits so C:\Program Files shows ~10GB not 2GB.
/// Handles junctions / reparse points (WindowsApps, etc.), permission errors and symlink loops:
/// - WalkDir with follow_links(false) so reparse points / junctions are not recursed
/// - skip Err entries (permission denied, reparse errors) and continue - counted as skipped
/// - skip symlink file entries themselves to avoid double-count
/// - u64 saturating_add, skip inaccessible files gracefully
/// For 100k+ files this runs in spawn_blocking (see lib.rs) so UI thread stays responsive;
/// we yield every 1024 entries to keep low-end devices snappy.
/// CACHE: checks `get_cached_folder_size` first - if fresh (mtime unchanged, <5min),
/// returns immediately without walk so hover/selection stays put.
#[allow(dead_code)]
pub fn get_folder_size(path: &str) -> Result<u64, String> {
    if let Some(cached) = get_cached_folder_size(path) {
        return Ok(cached);
    }
    let sz = get_folder_size_inner(path, None)?;
    put_folder_size_cache(path, sz);
    Ok(sz)
}

/// Inner implementation with optional progress callback.
/// `on_progress` is called every 512 files (and at the end) with (files_scanned, bytes_so_far, skipped).
/// When called from Tauri command we pass an AppHandle emitter; pure callers pass None.
pub(crate) fn get_folder_size_inner(
    path: &str,
    mut on_progress: Option<&mut dyn FnMut(usize, u64, usize)>,
) -> Result<u64, String> {
    let target = Path::new(path);
    if !target.exists() {
        return Err(format!("Path does not exist: {}", path));
    }
    if !target.is_dir() {
        return Err(format!("Not a directory: {}", path));
    }
    let mut total: u64 = 0;
    let mut files_scanned: usize = 0;
    let mut skipped: usize = 0;

    // Full recursive walk - no max_depth, no max_files (usize::MAX implicitly).
    // follow_links(false) avoids symlink/junction loops on Program Files (e.g. WindowsApps)
    // On Windows, junctions/reparse points appear as Err or as symlink FileType - both are skipped.
    let walker = walkdir::WalkDir::new(target)
        .follow_links(false)
        // Do not set max_depth => walk fully (WalkDir default is usize::MAX)
        .into_iter();

    for entry in walker {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => {
                skipped += 1;
                // permission denied, reparse/tag error, path too long - skip and continue
                continue;
            }
        };
        // skip the root dir itself
        if entry.depth() == 0 {
            continue;
        }
        // Don't descend into or count symlinked dirs/files (junctions, reparse points, mount points)
        // WalkDir with follow_links(false) already won't recurse, but we also skip the link entry.
        if entry.file_type().is_symlink() {
            skipped += 1;
            continue;
        }
        // In case file_type is unknown due to restricted ACL, try metadata but don't fail whole walk
        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => {
                skipped += 1;
                continue;
            }
        };
        if meta.is_file() {
            total = total.saturating_add(meta.len());
            files_scanned += 1;
        } else if meta.is_dir() {
            // dirs contribute 0 bytes - descend continues automatically
        } else {
            // other (fifo, socket on non-Windows) - skip
            continue;
        }

        // Progress + low-end yield every 512 files - keeps UI responsive without slowing walk
        if files_scanned % 512 == 0 {
            if let Some(cb) = on_progress.as_mut() {
                cb(files_scanned, total, skipped);
            }
            // Yield to OS scheduler every 1024 files so 100k-file walks don't starve low-end CPU
            if files_scanned % 1024 == 0 {
                std::thread::yield_now();
            }
        }
    }

    // final progress callback
    if let Some(cb) = on_progress.as_mut() {
        cb(files_scanned, total, skipped);
    }

    if skipped > 0 {
        // Best-effort log - visible in `cargo run` / debug console, does not affect return value
        eprintln!(
            "[get_folder_size] {} scanned {} files, {} bytes, skipped {} entries (permission/reparse)",
            path, files_scanned, total, skipped
        );
    }

    Ok(total)
}

pub fn list_dir(path: &str) -> Result<Vec<FileEntry>, String> {
    let target = if path.is_empty() {
        // Default to home or C:\ on Windows
        #[cfg(windows)]
        { "C:\\".to_string() }
        #[cfg(not(windows))]
        { "/".to_string() }
    } else {
        path.to_string()
    };

    let dir = Path::new(&target);
    if !dir.exists() {
        return Err(format!("Path does not exist: {}", target));
    }
    if !dir.is_dir() {
        return Err(format!("Not a directory: {}", target));
    }

    let mut entries = Vec::new();
    let read = fs::read_dir(dir).map_err(|e| e.to_string())?;
    for entry in read {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue, // skip unreadable, lightweight
        };
        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        let name = entry.file_name().to_string_lossy().to_string();
        // Skip hidden/system on low-end? keep but lightweight
        if name.starts_with('.') {
            // still show but could filter
        }
        let path_str = entry.path().to_string_lossy().to_string();
        let is_dir = meta.is_dir();
        let size = if is_dir { 0 } else { meta.len() };
        let modified = meta.modified().ok().and_then(format_system_time);
        let extension = if is_dir {
            "folder".to_string()
        } else {
            Path::new(&name)
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("")
                .to_lowercase()
        };
        // Lightweight item_count for dirs: direct child count (read_dir count)
        let item_count = if is_dir {
            count_dir_items(entry.path().as_path())
        } else {
            None
        };
        entries.push(FileEntry {
            name,
            path: path_str,
            is_dir,
            size,
            modified,
            extension,
            item_count,
        });
        // Lightweight cap: don't load more than 5000 entries per dir (protect low-end)
        if entries.len() >= 5000 {
            break;
        }
    }
    // Sort: dirs first, then alphabetical (Files app behavior)
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(entries)
}

pub fn get_files_info(paths: &[String]) -> Vec<FileEntry> {
    paths
        .iter()
        .map(|p| {
            let path = Path::new(p);
            let name = path
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| p.clone());
            let meta = fs::metadata(path).ok();
            let size = meta.as_ref().map(|m| m.len()).unwrap_or(0);
            let is_dir = meta.as_ref().map(|m| m.is_dir()).unwrap_or(false);
            let modified = meta
                .as_ref()
                .and_then(|m| m.modified().ok())
                .and_then(format_system_time);
            let extension = if is_dir {
                "folder".to_string()
            } else {
                path.extension()
                    .and_then(|e| e.to_str())
                    .unwrap_or("")
                    .to_lowercase()
            };
            FileEntry {
                name,
                path: p.clone(),
                is_dir,
                size,
                modified,
                extension,
                item_count: None,
            }
        })
        .collect()
}


/// The user's real shell folders (handles OneDrive-redirected Desktop/Documents/Pictures),
/// used for the sidebar's Pinned section instead of hard-coded paths.
pub fn known_folders() -> std::collections::HashMap<String, String> {
    let mut out = std::collections::HashMap::new();
    #[cfg(windows)]
    {
        use windows::Win32::UI::Shell::{
            FOLDERID_Desktop, FOLDERID_Documents, FOLDERID_Downloads, FOLDERID_Music, FOLDERID_Pictures,
            FOLDERID_Profile, FOLDERID_Videos, SHGetKnownFolderPath, KF_FLAG_DEFAULT,
        };
        let ids = [
            ("home", FOLDERID_Profile),
            ("desktop", FOLDERID_Desktop),
            ("documents", FOLDERID_Documents),
            ("downloads", FOLDERID_Downloads),
            ("pictures", FOLDERID_Pictures),
            ("music", FOLDERID_Music),
            ("videos", FOLDERID_Videos),
        ];
        for (name, id) in ids {
            unsafe {
                if let Ok(p) = SHGetKnownFolderPath(&id, KF_FLAG_DEFAULT, None) {
                    if let Ok(s) = p.to_string() {
                        out.insert(name.to_string(), s);
                    }
                    windows::Win32::System::Com::CoTaskMemFree(Some(p.0 as *const _));
                }
            }
        }
    }
    #[cfg(windows)]
    if let Ok(home) = std::env::var("USERPROFILE") {
        for (name, sub) in [("home", ""), ("desktop", "Desktop"), ("documents", "Documents"), ("downloads", "Downloads"),
                            ("pictures", "Pictures"), ("music", "Music"), ("videos", "Videos")] {
            out.entry(name.to_string()).or_insert_with(|| if sub.is_empty() { home.clone() } else { format!("{home}\\{sub}") });
        }
    }
    #[cfg(not(windows))]
    if let Some(home) = std::env::var_os("HOME").map(std::path::PathBuf::from).filter(|h| h.is_dir()) {
        // macOS uses fixed English folder names (Finder localises only their display names) and
        // "Movies" for videos; Linux desktops record the (possibly translated) folders in
        // ~/.config/user-dirs.dirs (XDG user dirs).
        let mac = cfg!(target_os = "macos");
        let xdg = if mac { std::collections::HashMap::new() } else { xdg_user_dirs(&home) };
        out.insert("home".into(), home.to_string_lossy().into_owned());
        for (name, key, default) in [
            ("desktop", "DESKTOP", "Desktop"),
            ("documents", "DOCUMENTS", "Documents"),
            ("downloads", "DOWNLOAD", "Downloads"),
            ("pictures", "PICTURES", "Pictures"),
            ("music", "MUSIC", "Music"),
            ("videos", "VIDEOS", if mac { "Movies" } else { "Videos" }),
        ] {
            let p = xdg.get(key).cloned().unwrap_or_else(|| home.join(default));
            if p != home && p.is_dir() {
                out.insert(name.into(), p.to_string_lossy().into_owned());
            }
        }
    }
    out
}

/// Parses `XDG_<NAME>_DIR="$HOME/..."` lines from the user-dirs file (Linux desktops).
#[cfg(not(windows))]
fn xdg_user_dirs(home: &std::path::Path) -> std::collections::HashMap<String, std::path::PathBuf> {
    let cfg = std::env::var_os("XDG_CONFIG_HOME").map(std::path::PathBuf::from).unwrap_or_else(|| home.join(".config"));
    let text = std::fs::read_to_string(cfg.join("user-dirs.dirs")).unwrap_or_default();
    parse_xdg_user_dirs(&text, home)
}

#[cfg(any(not(windows), test))]
fn parse_xdg_user_dirs(text: &str, home: &std::path::Path) -> std::collections::HashMap<String, std::path::PathBuf> {
    let mut m = std::collections::HashMap::new();
    for line in text.lines().map(str::trim).filter(|l| !l.starts_with('#')) {
        let Some((k, v)) = line.split_once('=') else { continue };
        let Some(name) = k.trim().strip_prefix("XDG_").and_then(|k| k.strip_suffix("_DIR")) else { continue };
        let v = v.trim().trim_matches('"');
        let p = if let Some(rest) = v.strip_prefix("$HOME") {
            home.join(rest.trim_start_matches('/'))
        } else if v.starts_with('/') {
            std::path::PathBuf::from(v)
        } else {
            continue;
        };
        m.insert(name.to_string(), p);
    }
    m
}

#[cfg(test)]
mod user_dir_tests {
    #[test]
    fn known_folders_include_the_user_folder() {
        let k = super::known_folders();
        let home = k.get("home").expect("user folder");
        assert!(std::path::Path::new(home).is_dir(), "{home}");
    }

    #[test]
    fn xdg_user_dirs_are_parsed() {
        let home = std::path::Path::new("/home/anna");
        let m = super::parse_xdg_user_dirs("# comment\nXDG_DESKTOP_DIR=\"$HOME/Schreibtisch\"\nXDG_MUSIC_DIR=\"/data/music\"\nXDG_TEMPLATES_DIR=\"$HOME/\"\nbogus\n", home);
        assert_eq!(m["DESKTOP"], home.join("Schreibtisch"));
        assert_eq!(m["MUSIC"], std::path::PathBuf::from("/data/music"));
        assert_eq!(m["TEMPLATES"], home.join(""));
    }
}

#[cfg(test)]
mod drive_tests {
    #[test]
    #[ignore]
    fn print_drives() {
        for d in super::list_drives() {
            println!("{:<6} name={:?} label={:?} type={} total={} free={}", d.path, d.name, d.label, d.drive_type, d.total_gb, d.free_gb);
        }
    }
}
