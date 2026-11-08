//! # Dedicated Native Media Player
//! High-performance native media player window using mpv with Direct3D11 / NVDEC
//! hardware decoding. Completely bypasses browser sandbox, HTML5 video, and MSE chunk streaming.

use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::sync::{Mutex, OnceLock};

static MPV_PATH: OnceLock<Option<PathBuf>> = OnceLock::new();
static RUNNING_PLAYER: Mutex<Option<Child>> = Mutex::new(None);

pub fn init(resource_dir: Option<PathBuf>) {
    MPV_PATH.get_or_init(|| {
        let mut candidates = Vec::new();
        if let Some(r) = resource_dir {
            candidates.push(r.join("mpv").join("mpv.exe"));
            candidates.push(r.join("mpv.exe"));
        }
        if let Some(d) = std::env::current_exe().ok().and_then(|e| e.parent().map(Path::to_path_buf)) {
            candidates.push(d.join("mpv").join("mpv.exe"));
            candidates.push(d.join("mpv.exe"));
        }
        // Dev build directory:
        candidates.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("mpv").join("mpv.exe"));
        candidates.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("bin").join("mpv.exe"));

        candidates.into_iter().find(|p| p.is_file())
    });
}

pub fn available() -> bool {
    MPV_PATH.get().and_then(|p| p.as_ref()).is_some()
}

pub fn launch(path: &Path, start_seconds: Option<f64>, audio_track: Option<usize>) -> Result<(), String> {
    if !path.is_file() {
        return Err(format!("File not found: {}", path.display()));
    }
    let mpv_exe = MPV_PATH
        .get()
        .and_then(|p| p.as_ref())
        .ok_or_else(|| "Native media player (mpv) is not installed. Run scripts/fetch-mpv.ps1".to_string())?;

    let file_name = path
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "Media".to_string());

    // Terminate any previous player instance to keep only one active player window
    {
        let mut running = RUNNING_PLAYER.lock().unwrap();
        if let Some(mut old) = running.take() {
            let _ = old.kill();
            let _ = old.wait();
        }
    }

    let mut cmd = Command::new(mpv_exe);

    // Set configuration directory to portable_config if present
    if let Some(parent) = mpv_exe.parent() {
        let port_cfg = parent.join("portable_config");
        if port_cfg.is_dir() {
            cmd.arg(format!("--config-dir={}", port_cfg.display()));
        }
    }
    
    // Performance & Hardware Decoding:
    // Direct3D11 / NVDEC hardware decoding with direct GPU swapchain blitting
    cmd.args([
        "--hwdec=auto-safe",
        "--vo=gpu",
        "--gpu-api=d3d11",
        "--keep-open=yes",
        "--force-window=immediate",
        "--autofit=75%x75%",
        "--cursor-autohide=1000",
        "--sub-auto=fuzzy",
        "--slang=en,eng",
    ]);

    // Titlebar
    cmd.arg(format!("--title=PiFiles - {}", file_name));

    // Fast initial seek if requested (e.g. continuing from in-app preview)
    if let Some(start) = start_seconds {
        if start > 0.05 {
            cmd.arg(format!("--start={:.3}", start));
        }
    }

    // Audio track selection
    if let Some(aid) = audio_track {
        // mpv audio tracks are 1-based
        cmd.arg(format!("--aid={}", aid + 1));
    }

    cmd.arg(path);

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW for any child wrappers, but allow the mpv GUI window to display
        cmd.creation_flags(0x0000_0000);
    }

    let child = cmd.spawn().map_err(|e| format!("Failed to launch native player: {e}"))?;

    {
        let mut running = RUNNING_PLAYER.lock().unwrap();
        *running = Some(child);
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_native_player_available() {
        init(None);
        let is_avail = available();
        let exe_exists = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("mpv")
            .join("mpv.exe")
            .is_file();
        assert_eq!(
            is_avail, exe_exists,
            "available() must match physical presence of mpv.exe"
        );
    }
}
