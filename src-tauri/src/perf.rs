//! Device-aware performance: a hardware tier (low / mid / high) that sizes thread pools and
//! background work, plus helpers that keep an idle app small (hand freed memory back to the
//! OS, lower WebView2's memory target while minimised, run scans at background priority).

use serde::Serialize;
use std::sync::OnceLock;

#[derive(Serialize, Clone)]
pub struct Profile {
    pub cores: usize,
    pub ram_gb: f64,
    /// "low", "mid" or "high"
    pub tier: &'static str,
    pub battery: bool,
}

pub fn profile() -> &'static Profile {
    static P: OnceLock<Profile> = OnceLock::new();
    P.get_or_init(|| {
        let cores = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4);
        let ram_gb = {
            let mut s = sysinfo::System::new();
            s.refresh_memory();
            s.total_memory() as f64 / 1024.0 / 1024.0 / 1024.0
        };
        let tier = if cores <= 4 || ram_gb < 7.5 {
            "low"
        } else if cores >= 8 && ram_gb >= 15.0 {
            "high"
        } else {
            "mid"
        };
        Profile { cores, ram_gb: (ram_gb * 10.0).round() / 10.0, tier, battery: on_battery() }
    })
}

#[cfg(windows)]
fn on_battery() -> bool {
    use windows::Win32::System::Power::{GetSystemPowerStatus, SYSTEM_POWER_STATUS};
    let mut s = SYSTEM_POWER_STATUS::default();
    unsafe { GetSystemPowerStatus(&mut s).is_ok() && s.ACLineStatus == 0 }
}
#[cfg(not(windows))]
fn on_battery() -> bool {
    false
}

/// Sizes the shared rayon pool for the machine: leave a core free for the UI on small CPUs.
pub fn configure_threads() {
    let p = profile();
    let n = match p.tier {
        "low" => p.cores.saturating_sub(1).max(2),
        "mid" => p.cores.saturating_sub(1).max(2),
        _ => p.cores,
    };
    let _ = rayon::ThreadPoolBuilder::new().num_threads(n).thread_name(|i| format!("pf-worker-{i}")).build_global();
}

/// Background (low CPU + I/O + memory priority) for the calling thread - for indexing/scans.
pub fn background_priority() {
    #[cfg(windows)]
    unsafe {
        use windows::Win32::System::Threading::{GetCurrentThread, SetThreadPriority, THREAD_MODE_BACKGROUND_BEGIN};
        let _ = SetThreadPriority(GetCurrentThread(), THREAD_MODE_BACKGROUND_BEGIN);
    }
}

/// Returns freed heap pages and the idle working set to Windows, so Task Manager shows what
/// the app actually needs. Pages come back on demand (soft faults), so it's cheap when idle.
pub fn trim_memory() {
    #[cfg(windows)]
    unsafe {
        use windows::Win32::System::Memory::{GetProcessHeap, HeapCompact, HEAP_FLAGS};
        use windows::Win32::System::Threading::{GetCurrentProcess, SetProcessWorkingSetSize};
        if let Ok(h) = GetProcessHeap() {
            let _ = HeapCompact(h, HEAP_FLAGS(0));
        }
        let _ = SetProcessWorkingSetSize(GetCurrentProcess(), usize::MAX, usize::MAX);
    }
}

/// Minimised/hidden → WebView2 low memory target + trim; visible again → normal.
pub fn set_background(win: &tauri::WebviewWindow, background: bool) {
    #[cfg(windows)]
    {
        let _ = win.with_webview(move |wv| unsafe {
            use webview2_com::Microsoft::Web::WebView2::Win32::{
                ICoreWebView2_19, COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW, COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL,
            };
            use windows_core::Interface;
            // Hidden controller = page visibility "hidden": timers/animations throttle and the
            // memory target below is honoured. Restored when the window comes back.
            let _ = wv.controller().SetIsVisible(!background);
            if let Ok(core) = wv.controller().CoreWebView2() {
                if let Ok(c19) = core.cast::<ICoreWebView2_19>() {
                    let _ = c19.SetMemoryUsageTargetLevel(if background { COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW } else { COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL });
                }
            }
        });
    }
    #[cfg(not(windows))]
    let _ = win;
    if background {
        trim_memory();
    }
}

/// Window backdrop material: "mica", "acrylic", "glass" (acrylic + the page's liquid-glass
/// panels) or "none". Returns whether an OS effect is now active (false = solid window).
pub fn set_window_effect(win: &tauri::WebviewWindow, effect: &str) -> bool {
    use tauri::window::{Effect, EffectState, EffectsBuilder};
    #[cfg(windows)]
    let fx = match effect {
        "mica" => Some(Effect::Mica),
        "acrylic" | "glass" => Some(Effect::Acrylic),
        _ => None,
    };
    #[cfg(target_os = "macos")]
    let fx = match effect {
        "mica" => Some(Effect::UnderWindowBackground),
        "acrylic" => Some(Effect::Sidebar),
        "glass" => Some(Effect::HudWindow),
        _ => None,
    };
    #[cfg(not(any(windows, target_os = "macos")))]
    let fx: Option<Effect> = {
        let _ = effect;
        None
    };
    match fx {
        Some(e) => win.set_effects(EffectsBuilder::new().effect(e).state(EffectState::FollowsWindowActiveState).build()).is_ok(),
        None => {
            let _ = win.set_effects(None);
            false
        }
    }
}

/// Follows the main window: minimised → background mode after a short delay, restored → normal.
pub fn watch_window(win: &tauri::WebviewWindow) {
    use std::sync::atomic::{AtomicBool, Ordering};
    static BG: AtomicBool = AtomicBool::new(false);
    let w = win.clone();
    win.on_window_event(move |e| {
        if matches!(e, tauri::WindowEvent::Resized(_) | tauri::WindowEvent::Focused(_)) {
            let min = w.is_minimized().unwrap_or(false);
            if min != BG.swap(min, Ordering::SeqCst) {
                set_background(&w, min);
            }
        }
    });
}
