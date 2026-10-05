//! Check for updates against GitHub Releases (signed `latest.json` produced by the release
//! workflow), download + install with progress, then restart.
//!
//! Channels: "stable" reads the newest non-prerelease (`releases/latest`); "beta" reads the
//! rolling `beta` prerelease. Builds distributed through a store/package manager set
//! `PIFILES_DISTRIBUTION` (e.g. `msstore`, `winget`) at compile time; those leave updating to
//! the store and only report the newest version.

use serde::Serialize;
use std::sync::Mutex;
use tauri::{Emitter, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

const REPO: &str = "Solanum-Tech/PiFiles";

pub fn distribution() -> &'static str {
    option_env!("PIFILES_DISTRIBUTION").unwrap_or("github")
}

fn self_updating() -> bool {
    matches!(distribution(), "github" | "portable")
}

#[derive(Default)]
pub struct Pending(pub Mutex<Option<Update>>);

#[derive(Serialize)]
pub struct CheckResult {
    pub current: String,
    pub available: bool,
    pub version: Option<String>,
    pub date: Option<String>,
    pub notes: Option<String>,
    /// false when a store/package manager installs updates instead of the app
    pub can_install: bool,
    pub distribution: &'static str,
}

fn endpoint(channel: &str) -> String {
    if channel == "beta" {
        format!("https://github.com/{REPO}/releases/download/beta/latest.json")
    } else {
        format!("https://github.com/{REPO}/releases/latest/download/latest.json")
    }
}

pub async fn check(app: &tauri::AppHandle, channel: &str) -> Result<CheckResult, String> {
    let current = app.package_info().version.to_string();
    let url = tauri::Url::parse(&endpoint(channel)).map_err(|e| e.to_string())?;
    let updater = app
        .updater_builder()
        .endpoints(vec![url])
        .map_err(|e| e.to_string())?
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())?;
    let found = updater.check().await.map_err(|e| format!("Couldn't check for updates: {e}"))?;
    let res = CheckResult {
        current,
        available: found.is_some(),
        version: found.as_ref().map(|u| u.version.clone()),
        date: found.as_ref().and_then(|u| u.date.map(|d| d.to_string())),
        notes: found.as_ref().and_then(|u| u.body.clone()),
        can_install: self_updating(),
        distribution: distribution(),
    };
    *app.state::<Pending>().0.lock().unwrap() = found;
    Ok(res)
}

#[derive(Serialize, Clone)]
struct Progress {
    downloaded: u64,
    total: Option<u64>,
    done: bool,
}

/// Downloads and installs the update found by the last `check`. On Windows the installer
/// takes over and the app exits; elsewhere the caller restarts with `restart`.
pub async fn install(app: &tauri::AppHandle) -> Result<(), String> {
    if !self_updating() {
        return Err("This copy of PiFiles is updated by the store it was installed from".into());
    }
    let update = app.state::<Pending>().0.lock().unwrap().take().ok_or("Check for updates first")?;
    let mut downloaded = 0u64;
    let a = app.clone();
    let b = app.clone();
    update
        .download_and_install(
            move |chunk, total| {
                downloaded += chunk as u64;
                let _ = a.emit("update://progress", Progress { downloaded, total, done: false });
            },
            move || {
                let _ = b.emit("update://progress", Progress { downloaded: 0, total: None, done: true });
            },
        )
        .await
        .map_err(|e| format!("Update failed: {e}"))
}
