//! Platform services: network locations, folder sharing, and locking the web view down so the
//! app behaves like a native program (no DevTools, browser menus or reload keys).

use serde::Serialize;
use std::path::Path;
use std::process::Command;

#[derive(Serialize, Clone, Debug)]
pub struct NetLocation {
    pub name: String,
    pub path: String,
    /// "drive" (mapped), "shortcut" (Network Shortcuts / bookmarks), "computer", "share", "mount"
    pub kind: String,
}

#[derive(Serialize, Clone, Debug)]
pub struct Share {
    pub name: String,
    pub path: String,
}

fn hidden_command(program: &str) -> Command {
    #[allow(unused_mut)]
    let mut c = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    c
}

// ---------- network locations ----------

#[cfg(windows)]
fn resolve_lnk(lnk: &Path) -> Option<String> {
    use windows::core::{Interface, HSTRING};
    use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, IPersistFile, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED, STGM_READ};
    use windows::Win32::UI::Shell::{IShellLinkW, ShellLink};
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER).ok()?;
        link.cast::<IPersistFile>().ok()?.Load(&HSTRING::from(lnk.as_os_str()), STGM_READ).ok()?;
        let mut buf = [0u16; 1024];
        link.GetPath(&mut buf, std::ptr::null_mut(), 0).ok()?;
        let n = buf.iter().position(|&c| c == 0).unwrap_or(0);
        let s = String::from_utf16_lossy(&buf[..n]);
        if !s.is_empty() {
            return Some(s);
        }
        // Network places often store only an ID list; ask for the display name.
        let mut pidl = std::ptr::null_mut();
        if link.GetIDList().map(|p| pidl = p).is_ok() && !pidl.is_null() {
            let name = windows::Win32::UI::Shell::SHGetNameFromIDList(pidl, windows::Win32::UI::Shell::SIGDN_DESKTOPABSOLUTEPARSING).ok();
            windows::Win32::System::Com::CoTaskMemFree(Some(pidl as *const _));
            if let Some(n) = name {
                let s = n.to_string().ok();
                windows::Win32::System::Com::CoTaskMemFree(Some(n.0 as *const _));
                return s;
            }
        }
        None
    }
}

/// Computers visible in the workgroup/domain (legacy network browsing; may be empty on
/// networks that only use discovery protocols).
#[cfg(windows)]
fn network_computers() -> Vec<NetLocation> {
    use windows::Win32::NetworkManagement::WNet::{
        WNetCloseEnum, WNetEnumResourceW, WNetOpenEnumW, NETRESOURCEW, RESOURCETYPE_DISK, RESOURCEUSAGE_CONTAINER,
        RESOURCE_CONTEXT,
    };
    use windows::Win32::Foundation::HANDLE;
    let mut out = Vec::new();
    unsafe {
        let mut h = HANDLE::default();
        if WNetOpenEnumW(RESOURCE_CONTEXT, RESOURCETYPE_DISK, RESOURCEUSAGE_CONTAINER, None, &mut h).is_err() {
            return out;
        }
        let mut buf = vec![0u8; 64 * 1024];
        loop {
            let mut count: u32 = u32::MAX;
            let mut size = buf.len() as u32;
            if WNetEnumResourceW(h, &mut count, buf.as_mut_ptr() as *mut _, &mut size).is_err() || count == 0 {
                break;
            }
            let items = std::slice::from_raw_parts(buf.as_ptr() as *const NETRESOURCEW, count as usize);
            for r in items {
                // Containers (workgroup/domain entries) can have no remote name.
                if r.lpRemoteName.is_null() {
                    continue;
                }
                if let Ok(name) = r.lpRemoteName.to_string() {
                    if name.starts_with(r"\\") {
                        out.push(NetLocation { name: name.trim_start_matches('\\').to_string(), path: name, kind: "computer".into() });
                    }
                }
            }
        }
        let _ = WNetCloseEnum(h);
    }
    out
}

pub fn network_locations() -> Vec<NetLocation> {
    let mut out: Vec<NetLocation> = Vec::new();
    #[cfg(windows)]
    {
        // Mapped network drives.
        for d in crate::fs::list_drives() {
            if d.drive_type == "Remote" {
                out.push(NetLocation { name: d.name.clone(), path: d.path.clone(), kind: "drive".into() });
            }
        }
        // "Add a network location" shortcuts (This PC → Network locations).
        if let Ok(appdata) = std::env::var("APPDATA") {
            let dir = Path::new(&appdata).join(r"Microsoft\Windows\Network Shortcuts");
            if let Ok(rd) = std::fs::read_dir(dir) {
                for e in rd.flatten() {
                    let p = e.path();
                    let name = p.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
                    let target = if p.is_dir() { resolve_lnk(&p.join("target.lnk")) } else if p.extension().map(|x| x == "lnk").unwrap_or(false) { resolve_lnk(&p) } else { None };
                    if let Some(t) = target {
                        out.push(NetLocation { name, path: t, kind: "shortcut".into() });
                    }
                }
            }
        }
        // Workgroup computers, with a timeout: browsing can stall on some networks.
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let _ = tx.send(network_computers());
        });
        if let Ok(v) = rx.recv_timeout(std::time::Duration::from_secs(4)) {
            out.extend(v);
        }
    }
    #[cfg(target_os = "linux")]
    {
        // GVFS (smb://, sftp:// mounted from the desktop) and kernel network mounts.
        if let Ok(uid) = Command::new("id").arg("-u").output().map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string()) {
            let gvfs = format!("/run/user/{uid}/gvfs");
            if let Ok(rd) = std::fs::read_dir(&gvfs) {
                for e in rd.flatten() {
                    out.push(NetLocation { name: e.file_name().to_string_lossy().to_string(), path: e.path().to_string_lossy().to_string(), kind: "mount".into() });
                }
            }
        }
        if let Ok(m) = std::fs::read_to_string("/proc/mounts") {
            for line in m.lines() {
                let f: Vec<&str> = line.split_whitespace().collect();
                if f.len() > 2 && matches!(f[2], "cifs" | "smbfs" | "nfs" | "nfs4" | "fuse.sshfs" | "davfs") {
                    out.push(NetLocation { name: f[0].to_string(), path: f[1].replace("\\040", " "), kind: "mount".into() });
                }
            }
        }
    }
    #[cfg(target_os = "macos")]
    {
        if let Ok(o) = Command::new("mount").output() {
            for line in String::from_utf8_lossy(&o.stdout).lines() {
                // "//user@server/share on /Volumes/share (smbfs, …)"
                if ["smbfs", "afpfs", "nfs", "webdav"].iter().any(|t| line.contains(&format!("({t}"))) {
                    if let Some((src, rest)) = line.split_once(" on ") {
                        if let Some((mp, _)) = rest.split_once(" (") {
                            out.push(NetLocation { name: src.to_string(), path: mp.to_string(), kind: "mount".into() });
                        }
                    }
                }
            }
        }
    }
    out
}

/// Shared folders of a computer (`\\server`), so the server can be browsed like a folder.
#[cfg(windows)]
pub fn server_shares(server: &str) -> Result<Vec<crate::fs::FileEntry>, String> {
    use windows::core::HSTRING;
    use windows::Win32::NetworkManagement::NetManagement::{NetApiBufferFree, MAX_PREFERRED_LENGTH};
    use windows::Win32::Storage::FileSystem::{NetShareEnum, SHARE_INFO_1, STYPE_DISKTREE};
    let host = server.trim_end_matches('\\');
    let mut out = Vec::new();
    unsafe {
        let mut buf: *mut u8 = std::ptr::null_mut();
        let (mut read, mut total) = (0u32, 0u32);
        let rc = NetShareEnum(&HSTRING::from(host), 1, &mut buf, MAX_PREFERRED_LENGTH, &mut read, &mut total, None);
        if rc != 0 {
            return Err(format!("Couldn't list the shared folders on {host} (error {rc})"));
        }
        let items = std::slice::from_raw_parts(buf as *const SHARE_INFO_1, read as usize);
        for s in items {
            if s.shi1_netname.is_null() {
                continue;
            }
            let name = s.shi1_netname.to_string().unwrap_or_default();
            if s.shi1_type.0 & 0xFF != STYPE_DISKTREE.0 || name.ends_with('$') {
                continue; // printers, IPC$, administrative shares
            }
            out.push(crate::fs::FileEntry {
                name: name.clone(),
                path: format!(r"{host}\{name}"),
                is_dir: true,
                size: 0,
                modified: None,
                extension: "folder".into(),
                item_count: None,
            });
        }
        let _ = NetApiBufferFree(Some(buf as *const _));
    }
    Ok(out)
}

// ---------- sharing folders on the network ----------

fn ps_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

/// Runs PowerShell elevated (UAC prompt) and waits for it. Returns the exit code.
#[cfg(windows)]
fn run_elevated_powershell(script: &str) -> Result<u32, String> {
    use windows::core::{HSTRING, PCWSTR};
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{GetExitCodeProcess, WaitForSingleObject, INFINITE};
    use windows::Win32::UI::Shell::{ShellExecuteExW, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW};
    use base64::Engine;
    // -EncodedCommand avoids every quoting problem: UTF-16LE, base64.
    let utf16: Vec<u8> = script.encode_utf16().flat_map(|c| c.to_le_bytes()).collect();
    let args = format!("-NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand {}", base64::engine::general_purpose::STANDARD.encode(utf16));
    let (verb, file, params) = (HSTRING::from("runas"), HSTRING::from("powershell.exe"), HSTRING::from(args));
    let mut info = SHELLEXECUTEINFOW {
        cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
        fMask: SEE_MASK_NOCLOSEPROCESS,
        lpVerb: PCWSTR(verb.as_ptr()),
        lpFile: PCWSTR(file.as_ptr()),
        lpParameters: PCWSTR(params.as_ptr()),
        nShow: 0,
        ..Default::default()
    };
    unsafe {
        ShellExecuteExW(&mut info).map_err(|_| "Sharing needs administrator permission, which wasn't granted.".to_string())?;
        WaitForSingleObject(info.hProcess, INFINITE);
        let mut code = 1u32;
        let _ = GetExitCodeProcess(info.hProcess, &mut code);
        let _ = CloseHandle(info.hProcess);
        Ok(code)
    }
}

pub fn list_shares() -> Vec<Share> {
    #[cfg(windows)]
    {
        let out = hidden_command("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-Command", "Get-SmbShare | Where-Object { -not $_.Special } | Select-Object Name,Path | ConvertTo-Json -Compress"])
            .output();
        if let Ok(o) = out {
            let text = String::from_utf8_lossy(&o.stdout).trim().to_string();
            let v: serde_json::Value = serde_json::from_str(&text).unwrap_or(serde_json::Value::Null);
            let arr = match v {
                serde_json::Value::Array(a) => a,
                serde_json::Value::Object(_) => vec![v],
                _ => vec![],
            };
            return arr
                .iter()
                .filter_map(|s| Some(Share { name: s.get("Name")?.as_str()?.to_string(), path: s.get("Path")?.as_str()?.to_string() }))
                .collect();
        }
        vec![]
    }
    #[cfg(target_os = "linux")]
    {
        let out = Command::new("net").args(["usershare", "info"]).output();
        let mut v = Vec::new();
        if let Ok(o) = out {
            let mut name = String::new();
            for line in String::from_utf8_lossy(&o.stdout).lines() {
                if line.starts_with('[') {
                    name = line.trim_matches(|c| c == '[' || c == ']').to_string();
                } else if let Some(p) = line.strip_prefix("path=") {
                    v.push(Share { name: name.clone(), path: p.to_string() });
                }
            }
        }
        v
    }
    #[cfg(target_os = "macos")]
    {
        let out = Command::new("sharing").arg("-l").output();
        let mut v = Vec::new();
        if let Ok(o) = out {
            let (mut name, mut path) = (String::new(), String::new());
            for line in String::from_utf8_lossy(&o.stdout).lines() {
                let l = line.trim();
                if let Some(n) = l.strip_prefix("name:") { name = n.trim().to_string(); }
                if let Some(p) = l.strip_prefix("path:") { path = p.trim().to_string(); }
                if !name.is_empty() && !path.is_empty() {
                    v.push(Share { name: std::mem::take(&mut name), path: std::mem::take(&mut path) });
                }
            }
        }
        v
    }
}

/// Shares `path` on the network as `name` (read-only or full access for everyone on the network).
pub fn create_share(path: &str, name: &str, read_only: bool) -> Result<String, String> {
    if !Path::new(path).is_dir() {
        return Err("Only folders can be shared".into());
    }
    let name = name.trim();
    if name.is_empty() || name.len() > 80 || name.contains(['\\', '/', '[', ']', ':', '|', '<', '>', '+', '=', ';', ',', '?', '*', '"']) {
        return Err("Choose a share name without special characters".into());
    }
    #[cfg(windows)]
    {
        let access = if read_only { "-ReadAccess" } else { "-ChangeAccess" };
        // Everyone by SID (S-1-1-0) so it works on non-English Windows.
        let script = format!(
            "$ErrorActionPreference='Stop'; $e=(New-Object System.Security.Principal.SecurityIdentifier('S-1-1-0')).Translate([System.Security.Principal.NTAccount]).Value; New-SmbShare -Name {} -Path {} {} $e | Out-Null; exit 0",
            ps_quote(name), ps_quote(path), access
        );
        let code = run_elevated_powershell(&script)?;
        if code != 0 {
            return Err("Windows couldn't create the share (is the name already used?)".into());
        }
        let host = std::env::var("COMPUTERNAME").unwrap_or_else(|_| "this-pc".into());
        return Ok(format!(r"\\{host}\{name}"));
    }
    #[cfg(target_os = "linux")]
    {
        let acl = if read_only { "Everyone:R" } else { "Everyone:F" };
        let o = Command::new("net").args(["usershare", "add", name, path, "Shared from PiFiles", acl, "guest_ok=n"]).output().map_err(|e| e.to_string())?;
        if !o.status.success() {
            return Err(format!("Samba user shares aren't available: {}", String::from_utf8_lossy(&o.stderr).trim()));
        }
        let host = Command::new("hostname").output().map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string()).unwrap_or_default();
        return Ok(format!("smb://{host}/{name}"));
    }
    #[cfg(target_os = "macos")]
    {
        let flags = if read_only { "-g 001" } else { "-g 000" };
        let script = format!("do shell script \"/usr/sbin/sharing -a \" & quoted form of {:?} & \" -S \" & quoted form of {:?} & \" -s 001 {flags}\" with administrator privileges", path, name);
        let o = Command::new("osascript").args(["-e", &script]).output().map_err(|e| e.to_string())?;
        if !o.status.success() {
            return Err("macOS couldn't share the folder (File Sharing must be allowed in System Settings › General › Sharing)".into());
        }
        let host = Command::new("scutil").args(["--get", "LocalHostName"]).output().map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string()).unwrap_or_default();
        return Ok(format!("smb://{host}.local/{name}"));
    }
    #[allow(unreachable_code)]
    Err("Sharing isn't supported on this system".into())
}

pub fn remove_share(name: &str) -> Result<(), String> {
    #[cfg(windows)]
    {
        let code = run_elevated_powershell(&format!("Remove-SmbShare -Name {} -Force; exit $LASTEXITCODE", ps_quote(name)))?;
        return if code == 0 { Ok(()) } else { Err("Windows couldn't stop sharing that folder".into()) };
    }
    #[cfg(target_os = "linux")]
    {
        let o = Command::new("net").args(["usershare", "delete", name]).output().map_err(|e| e.to_string())?;
        return if o.status.success() { Ok(()) } else { Err(String::from_utf8_lossy(&o.stderr).trim().to_string()) };
    }
    #[cfg(target_os = "macos")]
    {
        let script = format!("do shell script \"/usr/sbin/sharing -r \" & quoted form of {:?} with administrator privileges", name);
        let o = Command::new("osascript").args(["-e", &script]).output().map_err(|e| e.to_string())?;
        return if o.status.success() { Ok(()) } else { Err("macOS couldn't stop sharing that folder".into()) };
    }
    #[allow(unreachable_code)]
    Err("Sharing isn't supported on this system".into())
}

// ---------- native-app behaviour ----------

/// Turns off DevTools, the browser's own context menu, browser shortcuts (reload, print, find,
/// zoom, F12…), the status bar, autofill and swipe navigation. Developers can opt back in with
/// the PIFILES_DEVTOOLS environment variable.
/// Security: the page may read the clipboard (Paste in text fields) but gets no other browser
/// permission (camera, mic, location, notifications…), can't open pop-up windows, and can't
/// navigate away from the app's own pages - so injected content can't load a remote page that
/// would then have access to the app's commands.
#[cfg(windows)]
unsafe fn lock_down_events(core: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2) {
    use webview2_com::Microsoft::Web::WebView2::Win32::*;
    use webview2_com::{NavigationStartingEventHandler, NewWindowRequestedEventHandler, PermissionRequestedEventHandler};
    let mut token = Default::default();
    let perm = PermissionRequestedEventHandler::create(Box::new(|_, args| {
        if let Some(args) = args {
            let mut kind = COREWEBVIEW2_PERMISSION_KIND::default();
            args.PermissionKind(&mut kind)?;
            let state = if kind == COREWEBVIEW2_PERMISSION_KIND_CLIPBOARD_READ { COREWEBVIEW2_PERMISSION_STATE_ALLOW } else { COREWEBVIEW2_PERMISSION_STATE_DENY };
            args.SetState(state)?;
        }
        Ok(())
    }));
    let _ = core.add_PermissionRequested(&perm, &mut token);
    let popup = NewWindowRequestedEventHandler::create(Box::new(|_, args| {
        if let Some(args) = args {
            args.SetHandled(true)?;
        }
        Ok(())
    }));
    let _ = core.add_NewWindowRequested(&popup, &mut token);
    let nav = NavigationStartingEventHandler::create(Box::new(|_, args| {
        if let Some(args) = args {
            let mut uri = windows_core::PWSTR::null();
            args.Uri(&mut uri)?;
            let u = webview2_com::take_pwstr(uri).to_ascii_lowercase();
            // `cargo tauri dev` serves the UI from the CLI's own dev server on 127.0.0.1/localhost;
            // release builds only ever load tauri.localhost.
            let dev = cfg!(debug_assertions) && (u.starts_with("http://127.0.0.1") || u.starts_with("http://localhost"));
            let ours = u.starts_with("http://tauri.localhost") || u.starts_with("https://tauri.localhost") || u.starts_with("tauri://") || u.starts_with("about:blank") || dev;
            if !ours {
                args.SetCancel(true)?;
            }
        }
        Ok(())
    }));
    let _ = core.add_NavigationStarting(&nav, &mut token);
}

pub fn harden_webview(win: &tauri::WebviewWindow) {
    if std::env::var_os("PIFILES_DEVTOOLS").is_some() {
        return;
    }
    #[cfg(windows)]
    {
        let _ = win.with_webview(|wv| unsafe {
            use webview2_com::Microsoft::Web::WebView2::Win32::{
                ICoreWebView2Settings3, ICoreWebView2Settings4, ICoreWebView2Settings5, ICoreWebView2Settings6,
            };
            use windows_core::Interface;
            let Ok(core) = wv.controller().CoreWebView2() else { return };
            let Ok(s) = core.Settings() else { return };
            let _ = s.SetAreDevToolsEnabled(false);
            let _ = s.SetAreDefaultContextMenusEnabled(false);
            let _ = s.SetIsStatusBarEnabled(false);
            let _ = s.SetIsZoomControlEnabled(false);
            if let Ok(s3) = s.cast::<ICoreWebView2Settings3>() {
                let _ = s3.SetAreBrowserAcceleratorKeysEnabled(false);
            }
            if let Ok(s4) = s.cast::<ICoreWebView2Settings4>() {
                let _ = s4.SetIsPasswordAutosaveEnabled(false);
                let _ = s4.SetIsGeneralAutofillEnabled(false);
            }
            if let Ok(s5) = s.cast::<ICoreWebView2Settings5>() {
                let _ = s5.SetIsPinchZoomEnabled(false);
            }
            if let Ok(s6) = s.cast::<ICoreWebView2Settings6>() {
                let _ = s6.SetIsSwipeNavigationEnabled(false);
            }
            lock_down_events(&core);
        });
    }
    #[cfg(not(windows))]
    {
        // WebKitGTK/WKWebView only expose the inspector in debug builds; the frontend blocks the
        // context menu and browser shortcuts.
        let _ = win;
    }
}

// ---------- Share sheet ----------

/// Shows the Windows share sheet (Nearby sharing, Mail, Teams, WhatsApp…) for files/folders.
/// The sheet belongs to the window's UI thread, so the request is registered and shown there;
/// the storage items are resolved first on this (background) thread.
#[cfg(windows)]
pub fn share_files(app: &tauri::AppHandle, hwnd: isize, paths: Vec<String>) -> Result<(), String> {
    use std::sync::{Mutex, OnceLock};
    use windows::core::{AgileReference, Interface, HSTRING};
    use windows::ApplicationModel::DataTransfer::{DataRequestedEventArgs, DataTransferManager};
    use windows_collections::IIterable;
    use windows::Foundation::TypedEventHandler;
    use windows::Storage::{IStorageItem, StorageFile, StorageFolder};
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::Shell::IDataTransferManagerInterop;

    if paths.is_empty() {
        return Err("Nothing to share".into());
    }
    let mut items: Vec<AgileReference<IStorageItem>> = Vec::new();
    for p in &paths {
        let h = HSTRING::from(p.as_str());
        let item: windows::core::Result<IStorageItem> = if Path::new(p).is_dir() {
            StorageFolder::GetFolderFromPathAsync(&h).and_then(|op| op.get()).and_then(|f| f.cast())
        } else {
            StorageFile::GetFileFromPathAsync(&h).and_then(|op| op.get()).and_then(|f| f.cast())
        };
        let item = item.map_err(|e| format!("Can't share {p}: {}", e.message()))?;
        items.push(AgileReference::new(&item).map_err(|e| e.message().to_string())?);
    }
    let title = if paths.len() == 1 {
        Path::new(&paths[0]).file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default()
    } else {
        format!("{} items", paths.len())
    };
    static TOKEN: OnceLock<Mutex<Option<i64>>> = OnceLock::new();
    let (tx, rx) = std::sync::mpsc::channel();
    app.run_on_main_thread(move || {
        let r = (|| -> windows::core::Result<()> {
            let interop: IDataTransferManagerInterop = windows::core::factory::<DataTransferManager, IDataTransferManagerInterop>()?;
            let hwnd = HWND(hwnd as *mut _);
            let dtm: DataTransferManager = unsafe { interop.GetForWindow(hwnd)? };
            let slot = TOKEN.get_or_init(|| Mutex::new(None));
            if let Some(t) = slot.lock().unwrap().take() {
                let _ = dtm.RemoveDataRequested(t);
            }
            let token = dtm.DataRequested(&TypedEventHandler::new(move |_, args: windows::core::Ref<DataRequestedEventArgs>| {
                let req = args.ok()?.Request()?;
                let data = req.Data()?;
                data.Properties()?.SetTitle(&HSTRING::from(title.as_str()))?;
                let list: Vec<Option<IStorageItem>> = items.iter().filter_map(|a| a.resolve().ok()).map(Some).collect();
                data.SetStorageItemsReadOnly(&IIterable::<IStorageItem>::from(list))?;
                Ok(())
            }))?;
            *slot.lock().unwrap() = Some(token);
            unsafe { interop.ShowShareUIForWindow(hwnd) }
        })();
        let _ = tx.send(r.map_err(|e| e.message().to_string()));
    })
    .map_err(|e| e.to_string())?;
    rx.recv_timeout(std::time::Duration::from_secs(10)).map_err(|_| "The share sheet didn't open".to_string())?
}

/// Changes a drive's volume label (the name shown next to the letter, e.g. "Games" in "Games (D:)").
/// Tries directly first; the system drive and some others need administrator rights, in which
/// case Windows asks via UAC and the change is made by an elevated PowerShell `Set-Volume`.
pub fn rename_volume(root: &str, label: &str) -> Result<(), String> {
    let label = label.trim();
    let letter = root.chars().next().filter(|c| c.is_ascii_alphabetic()).ok_or("Not a drive")?.to_ascii_uppercase();
    if root.trim_end_matches(['\\', '/']).len() != 2 || !root.ends_with([':', '\\', '/']) {
        return Err("Not a drive".into());
    }
    if label.chars().count() > 32 || label.contains(['*', '?', '/', '\\', '|', '.', ',', ';', ':', '+', '=', '[', ']', '<', '>', '"']) {
        return Err("A drive name can be up to 32 characters and can't contain * ? / \\ | . , ; : + = [ ] < > \"".into());
    }
    #[cfg(windows)]
    {
        use windows::core::HSTRING;
        use windows::Win32::Storage::FileSystem::SetVolumeLabelW;
        let r = unsafe { SetVolumeLabelW(&HSTRING::from(format!("{letter}:\\")), &HSTRING::from(label)) };
        match r {
            Ok(()) => Ok(()),
            Err(e) if e.code() == windows::Win32::Foundation::E_ACCESSDENIED => {
                let script = format!("$ErrorActionPreference='Stop'; Set-Volume -DriveLetter {letter} -NewFileSystemLabel {}; exit 0", ps_quote(label));
                match run_elevated_powershell(&script) {
                    Ok(0) => Ok(()),
                    Ok(_) => Err("Windows couldn't rename the drive".into()),
                    Err(_) => Err("Renaming this drive needs administrator permission, which wasn't granted.".into()),
                }
            }
            Err(e) => Err(format!("Couldn't rename the drive: {}", e.message())),
        }
    }
    #[cfg(not(windows))]
    {
        let _ = (letter, label);
        Err("Renaming drives isn't supported on this platform yet".into())
    }
}
