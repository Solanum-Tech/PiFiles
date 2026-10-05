//! The operating system's own context-menu entries (Open in Terminal, 7-Zip, Git, "Open with",
//! Share, Send to…), so the right-click menu offers what Explorer / Finder / the desktop does.
//!
//! * Windows: the real Explorer menu. Shell extensions implement `IContextMenu`; we ask the shell
//!   for the menu of the selected items (or of the folder background), let every handler populate
//!   a hidden popup menu, read the items back and invoke the chosen command on the same object.
//!   This runs on a dedicated single-threaded-apartment thread with a message pump, as handlers
//!   require.
//! * Linux: applications registered for the file's MIME type (freedesktop .desktop files) plus
//!   "Open in Terminal".
//! * macOS: Finder-equivalent actions (Open With applications from Launch Services via `open`,
//!   Quick Look, Reveal in Finder, Open in Terminal).

use serde::Serialize;

#[derive(Serialize, Clone, Debug, Default)]
pub struct MenuItem {
    pub id: u32,
    pub label: String,
    /// Canonical verb when the handler exposes one ("open", "runas", "Windows.ModernShare"…).
    pub verb: String,
    /// PNG data URL of the item's icon, when it has one.
    pub icon: Option<String>,
    pub disabled: bool,
    pub separator: bool,
    pub children: Vec<MenuItem>,
}

#[derive(Serialize, Clone, Debug)]
pub struct Menu {
    pub token: u64,
    pub items: Vec<MenuItem>,
}

#[derive(Serialize, Clone, Debug, Default)]
pub struct DefaultApp {
    pub name: String,
    pub path: String,
}

#[cfg(windows)]
pub use win::{default_app, invoke, invoke_verb, open_with_dialog, query};

#[cfg(windows)]
mod win {
    use super::{DefaultApp, Menu, MenuItem};
    use std::sync::mpsc::{channel, Sender};
    use std::sync::{Mutex, OnceLock};
    use std::time::Duration;
    use windows::core::{Interface, HSTRING, PCSTR, PCWSTR, PSTR, PWSTR};
    use windows::Win32::Foundation::{HWND, LPARAM, WPARAM};
    use windows::Win32::System::Com::{CoInitializeEx, CoTaskMemFree, COINIT_APARTMENTTHREADED};
    use windows::Win32::UI::Shell::Common::ITEMIDLIST;
    use windows::Win32::UI::Shell::{
        AssocQueryStringW, IContextMenu, IContextMenu2, IContextMenu3, IShellFolder, ILFindLastID, SHBindToParent,
        SHGetDesktopFolder, SHOpenWithDialog, SHParseDisplayName, ASSOCF_INIT_IGNOREUNKNOWN, ASSOCSTR,
        ASSOCSTR_EXECUTABLE, ASSOCSTR_FRIENDLYAPPNAME, CMINVOKECOMMANDINFO, CMINVOKECOMMANDINFOEX, OAIF_ALLOW_REGISTRATION,
        OAIF_EXEC, OPENASINFO,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        CreatePopupMenu, DestroyMenu, DispatchMessageW, GetMenuItemCount, GetMenuItemInfoW, PeekMessageW, TranslateMessage,
        HMENU, MENUITEMINFOW, MFS_DISABLED, MFT_SEPARATOR, MIIM_BITMAP, MIIM_FTYPE, MIIM_ID, MIIM_STATE, MIIM_STRING,
        MIIM_SUBMENU, MSG, PM_REMOVE, SW_SHOWNORMAL, WM_INITMENUPOPUP,
    };

    const CMF_NORMAL: u32 = 0x0;
    const CMF_EXPLORE: u32 = 0x4;
    const CMF_EXTENDEDVERBS: u32 = 0x100;
    const CMIC_MASK_UNICODE: u32 = 0x4000;
    const CMIC_MASK_ASYNCOK: u32 = 0x100000;
    const GCS_VERBW: u32 = 0x4;
    const FIRST_ID: u32 = 1;

    type Job = Box<dyn FnOnce(&mut State) + Send>;

    struct State {
        current: Option<(u64, IContextMenu, HMENU)>,
        next: u64,
    }

    fn worker() -> &'static Mutex<Sender<Job>> {
        static W: OnceLock<Mutex<Sender<Job>>> = OnceLock::new();
        W.get_or_init(|| {
            let (tx, rx) = channel::<Job>();
            std::thread::spawn(move || unsafe {
                let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
                let mut st = State { current: None, next: 1 };
                loop {
                    // Shell handlers post messages to this thread; keep them flowing.
                    let mut msg = MSG::default();
                    while PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE).as_bool() {
                        let _ = TranslateMessage(&msg);
                        DispatchMessageW(&msg);
                    }
                    match rx.recv_timeout(Duration::from_millis(15)) {
                        Ok(job) => job(&mut st),
                        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
                        Err(_) => break,
                    }
                }
            });
            Mutex::new(tx)
        })
    }

    fn run<T: Send + 'static>(f: impl FnOnce(&mut State) -> T + Send + 'static) -> Result<T, String> {
        let (tx, rx) = channel();
        worker().lock().unwrap().send(Box::new(move |st: &mut State| {
            let _ = tx.send(f(st));
        })).map_err(|e| e.to_string())?;
        rx.recv_timeout(Duration::from_secs(20)).map_err(|_| "The system menu didn't respond".to_string())
    }

    struct Pidls(Vec<*mut ITEMIDLIST>);
    impl Drop for Pidls {
        fn drop(&mut self) {
            for p in &self.0 {
                unsafe { CoTaskMemFree(Some(*p as *const _)) };
            }
        }
    }

    unsafe fn parse(path: &str) -> windows::core::Result<*mut ITEMIDLIST> {
        let mut pidl = std::ptr::null_mut();
        SHParseDisplayName(&HSTRING::from(path), None, &mut pidl, 0, None)?;
        Ok(pidl)
    }

    /// Context menu for items (all in one folder) or for a folder's background.
    unsafe fn context_menu(hwnd: HWND, paths: &[String], background: Option<&str>) -> windows::core::Result<IContextMenu> {
        if let Some(folder) = background {
            let pidl = Pidls(vec![parse(folder)?]);
            let desktop: IShellFolder = SHGetDesktopFolder()?;
            let sf: IShellFolder = if (*pidl.0[0]).mkid.cb == 0 { desktop } else { desktop.BindToObject(pidl.0[0], None)? };
            return sf.CreateViewObject(hwnd);
        }
        let mut abs = Pidls(Vec::new());
        for p in paths {
            abs.0.push(parse(p)?);
        }
        let parent: IShellFolder = SHBindToParent(abs.0[0], None)?;
        let children: Vec<*const ITEMIDLIST> = abs.0.iter().map(|p| ILFindLastID(*p) as *const _).collect();
        parent.GetUIObjectOf(hwnd, &children, None)
    }

    fn clean_label(s: &str) -> String {
        let s = s.split('\t').next().unwrap_or("");
        let mut out = String::new();
        let mut chars = s.chars().peekable();
        while let Some(c) = chars.next() {
            if c == '&' {
                if chars.peek() == Some(&'&') {
                    out.push('&');
                    chars.next();
                }
                continue;
            }
            out.push(c);
        }
        out.trim().to_string()
    }

    unsafe fn verb_of(cm: &IContextMenu, id: u32) -> String {
        let mut buf = [0u16; 260];
        if cm.GetCommandString((id - FIRST_ID) as usize, GCS_VERBW, None, PSTR(buf.as_mut_ptr() as *mut u8), buf.len() as u32).is_ok() {
            let n = buf.iter().position(|&c| c == 0).unwrap_or(0);
            return String::from_utf16_lossy(&buf[..n]);
        }
        String::new()
    }

    unsafe fn bitmap_icon(hbmp: windows::Win32::Graphics::Gdi::HBITMAP) -> Option<String> {
        // Special HBMMENU_* values (1..=11) and null are not real bitmaps.
        if (hbmp.0 as isize) <= 11 {
            return None;
        }
        crate::thumbnail::hbitmap_to_png_data_url(hbmp, false)
    }

    unsafe fn read_menu(cm: &IContextMenu, menu: HMENU, depth: usize) -> Vec<MenuItem> {
        let mut out = Vec::new();
        let count = GetMenuItemCount(Some(menu));
        for i in 0..count.max(0) as u32 {
            let mut mii = MENUITEMINFOW {
                cbSize: std::mem::size_of::<MENUITEMINFOW>() as u32,
                fMask: MIIM_FTYPE | MIIM_ID | MIIM_STATE | MIIM_SUBMENU | MIIM_STRING | MIIM_BITMAP,
                ..Default::default()
            };
            if GetMenuItemInfoW(menu, i, true, &mut mii).is_err() {
                continue;
            }
            if mii.fType.0 & MFT_SEPARATOR.0 != 0 {
                if out.last().map(|m: &MenuItem| !m.separator).unwrap_or(false) {
                    out.push(MenuItem { separator: true, ..Default::default() });
                }
                continue;
            }
            let mut text = vec![0u16; mii.cch as usize + 1];
            mii.dwTypeData = PWSTR(text.as_mut_ptr());
            mii.cch += 1;
            let _ = GetMenuItemInfoW(menu, i, true, &mut mii);
            let n = text.iter().position(|&c| c == 0).unwrap_or(0);
            let label = clean_label(&String::from_utf16_lossy(&text[..n]));
            if label.is_empty() {
                continue;
            }
            let mut item = MenuItem {
                id: mii.wID,
                label,
                disabled: mii.fState.0 & MFS_DISABLED.0 != 0,
                icon: bitmap_icon(mii.hbmpItem),
                ..Default::default()
            };
            if !mii.hSubMenu.is_invalid() && depth < 3 {
                // Lazy submenus ("Open with", "Send to") fill themselves on WM_INITMENUPOPUP.
                let w = WPARAM(mii.hSubMenu.0 as usize);
                let l = LPARAM(i as isize);
                if let Ok(c3) = cm.cast::<IContextMenu3>() {
                    let _ = c3.HandleMenuMsg2(WM_INITMENUPOPUP, w, l, None);
                } else if let Ok(c2) = cm.cast::<IContextMenu2>() {
                    let _ = c2.HandleMenuMsg(WM_INITMENUPOPUP, w, l);
                }
                item.children = read_menu(cm, mii.hSubMenu, depth + 1);
                item.id = 0;
            } else if mii.wID >= FIRST_ID && mii.wID < 0x7FFF {
                item.verb = verb_of(cm, mii.wID);
            }
            out.push(item);
        }
        while out.last().map(|m| m.separator).unwrap_or(false) {
            out.pop();
        }
        out
    }

    pub fn query(hwnd: isize, paths: Vec<String>, background: Option<String>, extended: bool) -> Result<Menu, String> {
        run(move |st| unsafe {
            if let Some((_, _, m)) = st.current.take() {
                let _ = DestroyMenu(m);
            }
            let hwnd = HWND(hwnd as *mut _);
            let cm = context_menu(hwnd, &paths, background.as_deref()).map_err(|e| e.message().to_string())?;
            let menu = CreatePopupMenu().map_err(|e| e.to_string())?;
            let flags = CMF_NORMAL | CMF_EXPLORE | if extended { CMF_EXTENDEDVERBS } else { 0 };
            let hr = cm.QueryContextMenu(menu, 0, FIRST_ID, 0x7FFF, flags);
            if hr.is_err() {
                let _ = DestroyMenu(menu);
                return Err(hr.message().to_string());
            }
            let items = read_menu(&cm, menu, 0);
            let token = st.next;
            st.next += 1;
            st.current = Some((token, cm, menu));
            Ok(Menu { token, items })
        })?
    }

    fn invoke_info(hwnd: isize, verb_a: PCSTR, verb_w: PCWSTR) -> CMINVOKECOMMANDINFOEX {
        CMINVOKECOMMANDINFOEX {
            cbSize: std::mem::size_of::<CMINVOKECOMMANDINFOEX>() as u32,
            fMask: CMIC_MASK_UNICODE | CMIC_MASK_ASYNCOK,
            hwnd: HWND(hwnd as *mut _),
            lpVerb: verb_a,
            lpVerbW: verb_w,
            nShow: SW_SHOWNORMAL.0,
            ..Default::default()
        }
    }

    /// Runs command `id` from the menu returned with `token`.
    pub fn invoke(hwnd: isize, token: u64, id: u32) -> Result<(), String> {
        run(move |st| unsafe {
            let Some((t, cm, _)) = st.current.as_ref() else { return Err("That menu has closed".to_string()) };
            if *t != token {
                return Err("That menu has closed".to_string());
            }
            let offset = (id - FIRST_ID) as usize;
            let info = invoke_info(hwnd, PCSTR(offset as *const u8), PCWSTR(offset as *const u16));
            cm.InvokeCommand(&info as *const _ as *const CMINVOKECOMMANDINFO).map_err(|e| e.message().to_string())
        })?
    }

    /// Runs a canonical verb ("Windows.ModernShare", "properties", "openas"…) on items.
    pub fn invoke_verb(hwnd: isize, paths: Vec<String>, verb: String) -> Result<(), String> {
        run(move |_st| unsafe {
            let h = HWND(hwnd as *mut _);
            let cm = context_menu(h, &paths, None).map_err(|e| e.message().to_string())?;
            let menu = CreatePopupMenu().map_err(|e| e.to_string())?;
            let _ = cm.QueryContextMenu(menu, 0, FIRST_ID, 0x7FFF, CMF_NORMAL | CMF_EXPLORE);
            let a = std::ffi::CString::new(verb.clone()).unwrap_or_default();
            let w = HSTRING::from(verb.as_str());
            let info = invoke_info(hwnd, PCSTR(a.as_ptr() as *const u8), PCWSTR(w.as_ptr()));
            let r = cm.InvokeCommand(&info as *const _ as *const CMINVOKECOMMANDINFO).map_err(|e| e.message().to_string());
            let _ = DestroyMenu(menu);
            r
        })?
    }

    /// The system "How do you want to open this file?" picker.
    pub fn open_with_dialog(hwnd: isize, path: String) -> Result<(), String> {
        run(move |_st| unsafe {
            let p = HSTRING::from(path.as_str());
            let info = OPENASINFO { pcszFile: PCWSTR(p.as_ptr()), pcszClass: PCWSTR::null(), oaifInFlags: OAIF_ALLOW_REGISTRATION | OAIF_EXEC };
            SHOpenWithDialog(Some(HWND(hwnd as *mut _)), &info).map_err(|e| e.message().to_string())
        })?
    }

    fn assoc(ext: &str, what: ASSOCSTR) -> String {
        unsafe {
            let key = HSTRING::from(if ext.starts_with('.') { ext.to_string() } else { format!(".{ext}") });
            let mut len: u32 = 0;
            let _ = AssocQueryStringW(ASSOCF_INIT_IGNOREUNKNOWN, what, &key, PCWSTR::null(), None, &mut len);
            if len == 0 {
                return String::new();
            }
            let mut buf = vec![0u16; len as usize];
            if AssocQueryStringW(ASSOCF_INIT_IGNOREUNKNOWN, what, &key, PCWSTR::null(), Some(PWSTR(buf.as_mut_ptr())), &mut len).is_err() {
                return String::new();
            }
            let n = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
            String::from_utf16_lossy(&buf[..n])
        }
    }

    /// The app Windows opens this extension with.
    pub fn default_app(ext: &str) -> DefaultApp {
        DefaultApp { name: assoc(ext, ASSOCSTR_FRIENDLYAPPNAME), path: assoc(ext, ASSOCSTR_EXECUTABLE) }
    }
}

// ---------- Linux / macOS ----------

#[cfg(not(windows))]
mod unix {
    use super::{DefaultApp, Menu, MenuItem};
    use std::path::Path;
    use std::process::Command;
    use std::sync::{Mutex, OnceLock};

    fn commands() -> &'static Mutex<Vec<(u32, Vec<String>)>> {
        static C: OnceLock<Mutex<Vec<(u32, Vec<String>)>>> = OnceLock::new();
        C.get_or_init(|| Mutex::new(Vec::new()))
    }

    fn item(id: u32, label: &str, verb: &str) -> MenuItem {
        MenuItem { id, label: label.to_string(), verb: verb.to_string(), ..Default::default() }
    }

    #[cfg(target_os = "linux")]
    fn desktop_dirs() -> Vec<std::path::PathBuf> {
        let mut v = Vec::new();
        if let Ok(home) = std::env::var("HOME") {
            v.push(Path::new(&home).join(".local/share/applications"));
        }
        let data = std::env::var("XDG_DATA_DIRS").unwrap_or_else(|_| "/usr/local/share:/usr/share".into());
        for d in data.split(':') {
            v.push(Path::new(d).join("applications"));
        }
        v.push("/var/lib/flatpak/exports/share/applications".into());
        v
    }

    #[cfg(target_os = "linux")]
    fn mime_of(p: &Path) -> String {
        Command::new("xdg-mime").args(["query", "filetype"]).arg(p).output().ok()
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string()).unwrap_or_default()
    }

    /// (name, Exec) of every application that declares the MIME type.
    #[cfg(target_os = "linux")]
    fn apps_for(mime: &str) -> Vec<(String, String)> {
        let mut out: Vec<(String, String)> = Vec::new();
        for dir in desktop_dirs() {
            let Ok(rd) = std::fs::read_dir(&dir) else { continue };
            for e in rd.flatten() {
                let Ok(text) = std::fs::read_to_string(e.path()) else { continue };
                let mut name = String::new();
                let mut exec = String::new();
                let mut mimes = String::new();
                let mut in_entry = false;
                let mut hidden = false;
                for line in text.lines() {
                    if line.starts_with('[') {
                        in_entry = line == "[Desktop Entry]";
                        continue;
                    }
                    if !in_entry {
                        continue;
                    }
                    if let Some(v) = line.strip_prefix("Name=") { if name.is_empty() { name = v.to_string(); } }
                    if let Some(v) = line.strip_prefix("Exec=") { exec = v.to_string(); }
                    if let Some(v) = line.strip_prefix("MimeType=") { mimes = v.to_string(); }
                    if line == "NoDisplay=true" || line == "Hidden=true" { hidden = true; }
                }
                if !hidden && !exec.is_empty() && mimes.split(';').any(|m| m == mime) && !out.iter().any(|(n, _)| n == &name) {
                    out.push((name, exec));
                }
            }
        }
        out.sort();
        out
    }

    fn terminal_command(dir: &str) -> Vec<String> {
        if cfg!(target_os = "macos") {
            return vec!["open".into(), "-a".into(), "Terminal".into(), dir.into()];
        }
        for t in ["x-terminal-emulator", "gnome-terminal", "konsole", "xfce4-terminal", "kitty", "alacritty", "xterm"] {
            if Command::new("which").arg(t).output().map(|o| o.status.success()).unwrap_or(false) {
                return match t {
                    "gnome-terminal" | "xfce4-terminal" => vec![t.into(), format!("--working-directory={dir}")],
                    "konsole" => vec![t.into(), "--workdir".into(), dir.into()],
                    _ => vec!["sh".into(), "-c".into(), format!("cd \"$1\" && exec {t}"), "sh".into(), dir.into()],
                };
            }
        }
        vec![]
    }

    pub fn query(_hwnd: isize, paths: Vec<String>, background: Option<String>, _extended: bool) -> Result<Menu, String> {
        let mut items = Vec::new();
        let mut cmds = Vec::new();
        let mut id = 1u32;
        let dir = background.clone().unwrap_or_else(|| {
            let p = Path::new(paths.first().map(String::as_str).unwrap_or("/"));
            if p.is_dir() { p.to_string_lossy().to_string() } else { p.parent().map(|x| x.to_string_lossy().to_string()).unwrap_or_default() }
        });
        let term = terminal_command(&dir);
        if !term.is_empty() {
            items.push(item(id, "Open in Terminal", "terminal"));
            cmds.push((id, term));
            id += 1;
        }
        if let (None, Some(first)) = (&background, paths.first()) {
            #[cfg(target_os = "linux")]
            {
                let mime = mime_of(Path::new(first));
                let mut sub = Vec::new();
                for (name, exec) in apps_for(&mime) {
                    let mut argv: Vec<String> = exec.split_whitespace().filter(|a| !a.starts_with('%') || matches!(*a, "%f" | "%F" | "%u" | "%U")).map(String::from).collect();
                    let mut replaced = false;
                    for a in argv.iter_mut() {
                        if matches!(a.as_str(), "%f" | "%F" | "%u" | "%U") {
                            *a = first.clone();
                            replaced = true;
                        }
                    }
                    if !replaced {
                        argv.push(first.clone());
                    }
                    sub.push(item(id, &name, "openwith"));
                    cmds.push((id, argv));
                    id += 1;
                }
                if !sub.is_empty() {
                    items.push(MenuItem { label: "Open with".into(), children: sub, ..Default::default() });
                }
            }
            #[cfg(target_os = "macos")]
            {
                items.push(item(id, "Quick Look", "quicklook"));
                cmds.push((id, vec!["qlmanage".into(), "-p".into(), first.clone()]));
                id += 1;
                items.push(item(id, "Reveal in Finder", "reveal"));
                cmds.push((id, vec!["open".into(), "-R".into(), first.clone()]));
            }
        }
        *commands().lock().unwrap() = cmds;
        Ok(Menu { token: 1, items })
    }

    pub fn invoke(_hwnd: isize, _token: u64, id: u32) -> Result<(), String> {
        let cmds = commands().lock().unwrap();
        let (_, argv) = cmds.iter().find(|(i, _)| *i == id).ok_or("That menu has closed")?;
        Command::new(&argv[0]).args(&argv[1..]).spawn().map(|_| ()).map_err(|e| e.to_string())
    }

    pub fn invoke_verb(_hwnd: isize, paths: Vec<String>, verb: String) -> Result<(), String> {
        let first = paths.first().cloned().unwrap_or_default();
        match verb.as_str() {
            "properties" | "reveal" if cfg!(target_os = "macos") => Command::new("open").args(["-R", &first]).spawn().map(|_| ()).map_err(|e| e.to_string()),
            _ => Err("Not available on this system".into()),
        }
    }

    pub fn open_with_dialog(_hwnd: isize, path: String) -> Result<(), String> {
        if cfg!(target_os = "macos") {
            // Finder's "Open With > Other…" equivalent: let the user choose an application.
            let script = format!("set f to POSIX file {:?}\nset a to choose application\ntell application \"Finder\" to open f using (path to a)", path);
            return Command::new("osascript").args(["-e", &script]).spawn().map(|_| ()).map_err(|e| e.to_string());
        }
        Err("Pick an application from “Open with” in the menu".into())
    }

    pub fn default_app(ext: &str) -> DefaultApp {
        #[cfg(target_os = "linux")]
        {
            let probe = std::env::temp_dir().join(format!("pifiles-probe.{ext}"));
            let _ = std::fs::write(&probe, b"");
            let mime = mime_of(&probe);
            let _ = std::fs::remove_file(&probe);
            let desktop = Command::new("xdg-mime").args(["query", "default", &mime]).output().ok()
                .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string()).unwrap_or_default();
            return DefaultApp { name: desktop.trim_end_matches(".desktop").to_string(), path: desktop };
        }
        #[allow(unreachable_code)]
        {
            let _ = ext;
            DefaultApp::default()
        }
    }
}

#[cfg(not(windows))]
pub use unix::{default_app, invoke, invoke_verb, open_with_dialog, query};

/// Starts a user-defined action ("Open in VS Code", …) - program plus arguments, no shell.
pub fn run_custom(program: &str, args: &[String], cwd: Option<&str>, env: &std::collections::HashMap<String, String>) -> Result<(), String> {
    let mut cmd = std::process::Command::new(program);
    cmd.args(args);
    // Only the documented PF_* variables, so a page can't inject PATH/COMSPEC etc.
    for (k, v) in env.iter().filter(|(k, _)| matches!(k.as_str(), "PF_PATH" | "PF_DIR" | "PF_NAME" | "PF_PATHS")) {
        cmd.env(k, v);
    }
    if let Some(d) = cwd.filter(|d| !d.is_empty()) {
        cmd.current_dir(d);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0000_0010); // CREATE_NEW_CONSOLE: console tools get their own window
    }
    cmd.spawn().map(|_| ()).map_err(|e| format!("Couldn't start {program}: {e}"))
}
