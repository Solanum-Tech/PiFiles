//! Anti-tamper self check.
//!
//! The front end (HTML/JS/CSS) is compiled *into* pifiles.exe (Tauri embeds and compresses the
//! assets at build time), so there are no loose script files to edit; the bundled FFmpeg files
//! are pinned by hash (media_player.rs). This module covers the executable itself: a release
//! built with `PIFILES_REQUIRE_SIGNATURE=1` (set by the release workflow once code signing is
//! configured) verifies its own Authenticode signature at start-up with WinVerifyTrust and
//! refuses to run if the file was modified - any patched byte breaks the signature.

/// Ok(()) when the running executable carries a valid, trusted signature.
#[cfg(windows)]
pub fn verify_self() -> Result<(), String> {
    use windows::core::{GUID, HSTRING, PCWSTR};
    use windows::Win32::Foundation::HWND;
    use windows::Win32::Security::WinTrust::{
        WinVerifyTrust, WINTRUST_ACTION_GENERIC_VERIFY_V2, WINTRUST_DATA, WINTRUST_DATA_0, WINTRUST_FILE_INFO, WTD_CHOICE_FILE,
        WTD_REVOKE_NONE, WTD_STATEACTION_CLOSE, WTD_STATEACTION_VERIFY, WTD_UI_NONE,
    };
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let path = HSTRING::from(exe.as_os_str());
    unsafe {
        let mut file = WINTRUST_FILE_INFO {
            cbStruct: std::mem::size_of::<WINTRUST_FILE_INFO>() as u32,
            pcwszFilePath: PCWSTR(path.as_ptr()),
            ..Default::default()
        };
        let mut data = WINTRUST_DATA {
            cbStruct: std::mem::size_of::<WINTRUST_DATA>() as u32,
            dwUIChoice: WTD_UI_NONE,
            fdwRevocationChecks: WTD_REVOKE_NONE,
            dwUnionChoice: WTD_CHOICE_FILE,
            Anonymous: WINTRUST_DATA_0 { pFile: &mut file },
            dwStateAction: WTD_STATEACTION_VERIFY,
            ..Default::default()
        };
        let mut action: GUID = WINTRUST_ACTION_GENERIC_VERIFY_V2;
        let status = WinVerifyTrust(HWND(-1isize as _), &mut action, &mut data as *mut _ as *mut _);
        data.dwStateAction = WTD_STATEACTION_CLOSE;
        let _ = WinVerifyTrust(HWND(-1isize as _), &mut action, &mut data as *mut _ as *mut _);
        if status == 0 { Ok(()) } else { Err(format!("signature check failed (0x{:08X})", status as u32)) }
    }
}

#[cfg(not(windows))]
pub fn verify_self() -> Result<(), String> {
    // macOS enforces the code signature (Gatekeeper / hardened runtime) itself.
    Ok(())
}

/// Called first thing at start-up. Only enforced in builds that are meant to be signed.
pub fn enforce() {
    if option_env!("PIFILES_REQUIRE_SIGNATURE") != Some("1") {
        return;
    }
    if let Err(e) = verify_self() {
        #[cfg(windows)]
        unsafe {
            use windows::core::w;
            use windows::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONERROR, MB_OK};
            MessageBoxW(None, &windows::core::HSTRING::from(format!(
                "PiFiles can't start because its program file has been modified or damaged ({e}).\n\nPlease reinstall PiFiles from the official download.")), w!("PiFiles"), MB_OK | MB_ICONERROR);
        }
        eprintln!("[integrity] {e}");
        std::process::exit(3);
    }
}

#[cfg(test)]
mod tests {
    /// Unsigned dev/test binaries must fail verification (proves the check actually runs).
    #[test]
    #[cfg(windows)]
    fn unsigned_test_binary_is_rejected() {
        assert!(super::verify_self().is_err());
    }
}
