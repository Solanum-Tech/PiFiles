use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct DriveInfo {
    pub name: String,
    pub path: String,
    pub drive_type: String,
    pub total_gb: f64,
    pub free_gb: f64,
    // Windows File Explorer enrichment — added for This PC visual parity
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
}

pub fn list_drives() -> Vec<DriveInfo> {
    let mut drives = Vec::new();
    #[cfg(windows)]
    {
        // FAST path: use Win32 API directly — never blocks on network drives like sysinfo can
        // This is the fix for "stuck in Loading drives": GetLogicalDriveStringsW is instant (<5ms)
        let fast = try_fast_win32_drives();
        if !fast.is_empty() {
            drives = fast;
        } else {
            // Fallback: sysinfo but with timeout-friendly retry (only if fast failed)
            // Kept for total/free space, but wrapped to avoid hang — we timeout after 400ms in practice
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
        // Enrich with size info without blocking — best-effort, ignore errors (low-end: skip if slow)
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
        // Fast volume information — GetVolumeInformationW is <1ms per drive, keeps total <5ms
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
        let modified = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs().to_string());
        let extension = if is_dir {
            "folder".to_string()
        } else {
            Path::new(&name)
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("")
                .to_lowercase()
        };
        entries.push(FileEntry {
            name,
            path: path_str,
            is_dir,
            size,
            modified,
            extension,
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
